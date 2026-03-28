/**
 * Agent 引擎 (Phase 4 完整版)
 *
 * WorkerClaw 的核心执行引擎
 * 集成人格系统、会话管理、上下文窗口、技能系统和工具调用循环
 *
 * 执行流程:
 * 1. 构建系统提示（人格 + 技能提示 + 权限信息）
 * 2. 获取/创建会话
 * 3. 添加用户消息
 * 4. 上下文窗口适配
 * 5. 调用 LLM
 * 6. 处理工具调用（循环直到完成）
 * 7. 返回结果
 */

import { createLogger, type Logger } from '../core/logger.js';
import { EventBus, WorkerClawEvent } from '../core/events.js';
import { LLMClient } from './llm-client.js';
import { Personality } from './personality.js';
import { SessionManager } from './session-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolExecutor } from './tool-executor.js';
import { SkillRunner, type SkillRunnerConfig } from '../skills/skill-runner.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import type { LLMConfig, SecurityConfig } from '../core/config.js';
import type {
  Task, TaskResult, TaskExecutionContext, TaskOutput,
} from '../types/task.js';
import type {
  LLMMessage, LLMResponse, ToolCall, PermissionLevel,
} from '../types/agent.js';
import type { PersonalityConfig } from './personality.js';
import type { ExperienceManager } from '../experience/index.js';
import type { ExperienceSearchResult } from '../experience/types.js';
import * as fs from 'fs';
import * as path from 'path';

export interface AgentEngineConfig {
  llm: LLMConfig;
  personality: PersonalityConfig;
  security: SecurityConfig;
  /** 会话管理配置 */
  session?: {
    maxActiveSessions?: number;
    sessionTTL?: number;
    maxTokens?: number;
  };
  /** 技能执行配置 */
  skillRunner?: Partial<SkillRunnerConfig>;
}

export class AgentEngine {
  private logger: Logger;
  private config: AgentEngineConfig;
  private eventBus: EventBus;

  private llm: LLMClient;
  private personality: Personality;
  private sessionManager: SessionManager;
  private toolExecutor: ToolExecutor;
  private skillRunner: SkillRunner;
  private skillRegistry: SkillRegistry;

  /** 经验管理器（可选，由外部注入） */
  private experienceManager: ExperienceManager | null = null;

  /** 当前任务的经验搜索结果（executeTask 中预搜索） */
  private currentTaskExperience: ExperienceSearchResult | null = null;

  /** 当前正在执行的任务 ID（用于 buildOutputs 收集文件） */
  private currentExecutingTaskId: string | null = null;

  constructor(config: AgentEngineConfig, eventBus: EventBus, experienceManager?: ExperienceManager) {
    this.config = config;
    this.eventBus = eventBus;

    this.llm = new LLMClient(config.llm);
    this.personality = new Personality(config.personality);

    // 会话管理
    this.sessionManager = new SessionManager({
      maxActiveSessions: config.session?.maxActiveSessions || 50,
      sessionTTL: config.session?.sessionTTL || 30 * 60 * 1000,
      contextWindow: {
        maxTokens: config.session?.maxTokens || 8000,
      },
    });

    // 工具系统
    const toolRegistry = new ToolRegistry();
    this.toolExecutor = new ToolExecutor(
      toolRegistry,
      { security: config.security },
      eventBus,
    );

    // 技能系统
    this.skillRegistry = new SkillRegistry();
    this.skillRunner = new SkillRunner(
      this.skillRegistry,
      config.skillRunner,
      eventBus,
    );

    this.logger = createLogger('AgentEngine');

    // 经验系统
    if (experienceManager) {
      this.experienceManager = experienceManager;
    }
  }

  /**
   * 执行任务（Phase 4 完整版）
   */
  async executeTask(task: Task, context: TaskExecutionContext): Promise<TaskResult> {
    const startTime = Date.now();
    this.logger.info(`开始执行任务 [${task.taskId}]`, {
      type: task.taskType,
      title: task.title,
    });

    this.eventBus.emit(WorkerClawEvent.TASK_STARTED, { taskId: task.taskId });

    // 记录当前执行的任务 ID
    this.currentExecutingTaskId = task.taskId;

    // 预搜索任务相关经验（在构建 prompt 前）
    await this.preSearchExperience(task);

    // 创建会话
    const systemPrompt = this.buildSystemPrompt(task, context);
    this.sessionManager.createSession(task.taskId, systemPrompt);

    try {
      // 添加用户消息
      const userMessage = this.buildUserMessage(task);
      this.sessionManager.addMessage(task.taskId, {
        role: 'user',
        content: userMessage,
      });

      // 报告进度
      this.eventBus.emit(WorkerClawEvent.TASK_PROGRESS, {
        taskId: task.taskId,
        progress: 20,
        message: '正在调用 LLM...',
      });

      // LLM 调用循环（支持工具调用）
      const finalResponse = await this.llmLoop(task, context);

      // 保存最终回复
      this.sessionManager.addMessage(task.taskId, {
        role: 'assistant',
        content: finalResponse.content,
      });

      // 构建结果
      const durationMs = Date.now() - startTime;
      const content = finalResponse.content;

      // 输出质量审核：检测"无法完成"类回复
      if (this.isRefusalResponse(content)) {
        this.logger.warn(`任务执行返回拒绝类回复 [${task.taskId}]`, {
          contentPreview: content.slice(0, 200),
        });
        this.eventBus.emit(WorkerClawEvent.TASK_FAILED, {
          taskId: task.taskId,
          error: new Error('Agent 无法完成任务: ' + content.slice(0, 100)),
        });

        return {
          taskId: task.taskId,
          status: 'failed',
          error: 'Agent 表示无法完成此任务',
          durationMs,
        };
      }

      const result: TaskResult = {
        taskId: task.taskId,
        status: 'completed',
        content,
        outputs: this.buildOutputs(content),
        tokensUsed: finalResponse.usage ? {
          prompt: finalResponse.usage.promptTokens,
          completion: finalResponse.usage.completionTokens,
        } : undefined,
        durationMs,
      };

      this.logger.info(`任务完成 [${task.taskId}]`, {
        durationMs,
        tokens: result.tokensUsed,
        toolCallRounds: finalResponse.toolCallRounds || 0,
        contentLength: finalResponse.content.length,
      });

      this.eventBus.emit(WorkerClawEvent.TASK_COMPLETED, { taskId: task.taskId, result });

      return result;

    } catch (err) {
      const durationMs = Date.now() - startTime;
      const error = err as Error;
      const errorMessage = error.message;

      this.logger.error(`任务执行失败 [${task.taskId}]`, { error: errorMessage, durationMs });
      this.eventBus.emit(WorkerClawEvent.LLM_ERROR, { taskId: task.taskId, error });
      this.eventBus.emit(WorkerClawEvent.TASK_FAILED, { taskId: task.taskId, error });

      // 经验搜索：错误时自动查找相关经验
      let experienceHint: ExperienceSearchResult | undefined;
      if (this.experienceManager) {
        try {
          const hint = await this.experienceManager.searchOnError(errorMessage);
          if (hint) {
            experienceHint = hint;
            this.eventBus.emit(WorkerClawEvent.EXPERIENCE_SEARCHED, {
              taskId: task.taskId,
              signals: experienceHint.gene.signals,
              found: true,
            });
            this.logger.info(`🧬 经验搜索命中 [${task.taskId}]`, {
              geneId: experienceHint.gene.gene_id.slice(0, 12),
              matchScore: experienceHint.matchScore,
              summary: experienceHint.gene.summary,
            });
          }
        } catch {
          // 搜索失败不影响主流程
        }
      }

      return {
        taskId: task.taskId,
        status: 'failed',
        error: errorMessage,
        durationMs,
        experienceHint, // 附带经验提示供上层使用
      };
    } finally {
      // 标记会话完成
      this.sessionManager.completeSession(task.taskId);
      this.currentExecutingTaskId = null;
    }
  }

  /**
   * LLM 调用循环（支持工具调用）
   */
  private async llmLoop(
    task: Task,
    context: TaskExecutionContext,
    maxRounds = 10,
  ): Promise<LLMResponse & { toolCallRounds: number }> {
    let round = 0;

    while (round < maxRounds) {
      round++;

      // 获取适配后的消息
      const { messages, stats } = this.sessionManager.getFittedMessages(task.taskId);

      if (stats.isTruncated) {
        this.logger.debug('上下文窗口已裁剪', { stats });
      }

      // 获取工具
      const tools = this.getToolsForTask(task, context.permissionLevel);

      // 调用 LLM
      this.eventBus.emit(WorkerClawEvent.LLM_REQUEST, {
        taskId: task.taskId,
        model: this.config.llm.model,
      });

      const response = await this.llm.chat({
        messages,
        tools: tools.length > 0 ? tools : undefined,
        maxTokens: context.maxOutputTokens,
      });

      this.eventBus.emit(WorkerClawEvent.LLM_RESPONSE, {
        taskId: task.taskId,
        tokens: response.usage ? {
          prompt: response.usage.promptTokens,
          completion: response.usage.completionTokens,
        } : undefined,
      });

      // 如果没有工具调用，直接返回
      if (!response.hasToolCalls || !response.toolCalls || response.toolCalls.length === 0) {
        return { ...response, toolCallRounds: round - 1 };
      }

      // 处理工具调用
      this.eventBus.emit(WorkerClawEvent.TASK_PROGRESS, {
        taskId: task.taskId,
        progress: Math.min(20 + round * 10, 90),
        message: `处理工具调用 (轮次 ${round})...`,
      });

      // 保存 assistant 消息（包含 tool_calls）
      this.sessionManager.addMessage(task.taskId, {
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.toolCalls,
      });

      // 执行每个工具调用
      for (const toolCall of response.toolCalls) {
        const toolResult = await this.handleToolCall(
          toolCall,
          task,
          context,
        );

        // 保存工具结果
        this.sessionManager.addMessage(task.taskId, {
          role: 'tool',
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          tool_call_id: toolCall.id,
          name: toolCall.name,
        });
      }

      // 更新进度
      this.eventBus.emit(WorkerClawEvent.TASK_PROGRESS, {
        taskId: task.taskId,
        progress: Math.min(20 + round * 15, 90),
        message: `已完成 ${response.toolCalls.length} 个工具调用`,
      });
    }

    // 超过最大轮次
    this.logger.warn(`LLM 循环超过最大轮次 [${task.taskId}]`, { maxRounds });

    // 获取最终消息
    const { messages } = this.sessionManager.getFittedMessages(task.taskId);
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');

    return {
      content: lastAssistant?.content || '任务执行完成（达到最大工具调用轮次）',
      hasToolCalls: false,
      toolCalls: [],
      usage: undefined,
      model: this.config.llm.model,
      finishReason: 'max_rounds',
      allMessages: messages,
      toolCallRounds: maxRounds,
    };
  }

  /**
   * 处理单个工具调用
   */
  private async handleToolCall(
    toolCall: ToolCall,
    task: Task,
    context: TaskExecutionContext,
  ): Promise<{ content: string; success: boolean }> {
    const { id, name, arguments: argsStr } = toolCall;

    this.eventBus.emit(WorkerClawEvent.TOOL_CALLED, {
      taskId: task.taskId,
      toolName: name,
      toolCallId: id,
    });

    try {
      // 解析参数
      const params = JSON.parse(argsStr || '{}');

      // 执行工具
      const toolCallObj: ToolCall = {
        id,
        name,
        arguments: argsStr,
      };

      const result = await this.toolExecutor.execute(
        toolCallObj,
        {
          taskId: task.taskId,
          permissionLevel: context.permissionLevel,
          workDir: this.config.security.sandbox.workDir,
          remainingMs: context.timeoutMs - (Date.now() - context.receivedAt),
          toolCallCount: 0,
          maxToolCalls: 20,
        },
      );

      this.eventBus.emit(WorkerClawEvent.TOOL_COMPLETED, {
        taskId: task.taskId,
        toolName: name,
        toolCallId: id,
        success: result.success,
      });

      return {
        content: result.success ? result.content : `错误: ${result.error}`,
        success: result.success,
      };

    } catch (err) {
      const error = err as Error;

      this.eventBus.emit(WorkerClawEvent.TOOL_BLOCKED, {
        taskId: task.taskId,
        toolName: name,
        reason: error.message,
      });

      return {
        content: `工具调用失败: ${error.message}`,
        success: false,
      };
    }
  }

  /**
   * 获取任务可用的工具
   */
  private getToolsForTask(task: Task, permLevel: PermissionLevel): any[] {
    // 合并内置工具和技能工具
    const builtinTools = this.toolExecutor.getRegistry();
    const builtinForLLM = builtinTools.getToolsForLLM(permLevel);

    const skillTools = this.skillRegistry.getToolsFromAllSkills(permLevel);
    const skillToolsForLLM = skillTools.map(st => ({
      type: 'function' as const,
      function: {
        name: st.tool.name,
        description: st.tool.description,
        parameters: st.tool.parameters,
      },
    }));

    return [...builtinForLLM, ...skillToolsForLLM];
  }

  /**
   * 构建系统提示（人格 + 技能 + 权限 + 经验策略 + 文件产出引导）
   */
  private buildSystemPrompt(task: Task, context: TaskExecutionContext): string {
    const availableTools = this.toolExecutor.getRegistry().getToolNames();
    const skillAddons = this.skillRegistry.getSystemPromptAddons(context.permissionLevel);

    const prompt = this.personality.buildSystemPrompt({
      permissionLevel: context.permissionLevel,
      maxOutputTokens: context.maxOutputTokens,
      timeoutMs: context.timeoutMs,
      availableTools,
      currentDate: new Date().toISOString().slice(0, 10),
    });

    let result = prompt;

    // 附加技能提示
    if (skillAddons.length > 0) {
      result += '\n\n' + skillAddons.join('\n\n');
    }

    // 附加经验策略（从本地+Hub搜索匹配经验）
    if (this.experienceManager) {
      const expAddon = this.buildExperienceAddon(task);
      if (expAddon) {
        result += '\n\n' + expAddon;
      }
    }

    // 附加文件产出引导（根据任务类型判断是否需要生成文件）
    const fileGuidance = this.buildFileGuidance(task);
    if (fileGuidance) {
      result += '\n\n' + fileGuidance;
    }

    return result;
  }

  /**
   * 根据任务信息搜索经验，构建经验策略提示
   * 使用 currentTaskExperience 缓存（由 executeTask 预搜索填充）
   */
  private buildExperienceAddon(task: Task): string | null {
    // 优先使用预搜索结果
    if (this.currentTaskExperience) {
      return this.formatExperienceHint(this.currentTaskExperience);
    }
    return null;
  }

  /**
   * 格式化经验搜索结果为 LLM 提示文本
   */
  private formatExperienceHint(result: ExperienceSearchResult): string {
    const strategyText = result.gene.strategy
      .map((s: import('../experience/types.js').StrategyStep) =>
        `${s.step}. ${s.action}${s.explanation ? ` — ${s.explanation}` : ''}`
      )
      .join('\n');

    return [
      `## 🧬 相关经验参考 (匹配度: ${Math.round(result.matchScore * 100)}%)`,
      `> ${result.gene.summary}`,
      result.gene.description ? `> ${result.gene.description}` : '',
      '',
      '推荐策略:',
      strategyText,
      result.capsule?.outcome?.status === 'success'
        ? '\n✅ 此策略已验证有效，优先参考。'
        : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * 根据任务描述判断是否需要生成文件，并构建引导提示
   */
  private buildFileGuidance(task: Task): string {
    const desc = (task.title + ' ' + task.description).toLowerCase();

    // 判断是否是需要生成文件的任务
    const fileKeywords = [
      '图片', '照片', '截图', '壁纸', '头像', '背景图',
      '下载.*图', '找.*图', '搜索.*图', '百度.*图',
      '风景图', '大海', ' sunset', ' sunset',
      '生成.*图', '画.*图', 'AI.*画', 'AI.*图',
      '文档', '报告', '表格', '数据',
      'PPT', '幻灯片', '演示文稿',
      '音频', '视频',
    ];

    const needsFile = fileKeywords.some(kw => new RegExp(kw, 'i').test(desc));
    if (!needsFile) return '';

    return [
      '## 📎 文件产出要求',
      '此任务需要生成具体文件作为成果（图片、文档等），不能只回复文字说明。',
      '',
      '执行方式：',
      '1. 如果需要图片：使用 web_search 工具搜索相关图片 URL，然后用 download 或 write_file 工具将图片保存到本地',
      '2. 如果需要文档/报告：使用 write_file 工具将内容写入文件（.md, .txt, .csv, .html 等）',
      '3. 如果需要数据分析结果：使用 write_file 写入 CSV/JSON 格式的数据文件',
      '',
      '⚠️ 重要：',
      '- 最终回复中应该包含对生成文件的说明',
      '- 图片文件请保存为 .png 或 .jpg 格式',
      '- 文件路径使用沙箱工作目录下的路径',
      '- 系统会自动将你生成的文件作为附件提交给发单人',
    ].join('\n');
  }

  /**
   * 预搜索任务相关经验（异步，在 executeTask 中调用）
   */
  private async preSearchExperience(task: Task): Promise<void> {
    this.currentTaskExperience = null;

    if (!this.experienceManager) return;

    try {
      const keywords = [
        task.taskType,
        task.title,
        ...task.description.split(/[\s,，。.！!？?；;]+/).filter((w: string) => w.length > 2).slice(0, 5),
      ];

      const results = await this.experienceManager.search(keywords);
      if (results.length > 0 && results[0].matchScore >= 0.3) {
        this.currentTaskExperience = results[0];

        this.eventBus.emit(WorkerClawEvent.EXPERIENCE_APPLIED, {
          geneId: results[0].gene.gene_id,
          matchScore: results[0].matchScore,
          source: results[0].source,
        });

        this.logger.info(`🧬 预搜索经验命中 [${task.taskId}]`, {
          geneId: results[0].gene.gene_id.slice(0, 12),
          matchScore: results[0].matchScore,
          source: results[0].source,
        });
      }
    } catch {
      // 搜索失败不影响任务执行
    }
  }

  /**
   * 构建用户消息
   */
  private buildUserMessage(task: Task): string {
    const lines = [
      `## 任务信息`,
      `- 任务ID: ${task.taskId}`,
      `- 任务类型: ${task.taskType}`,
      `- 标题: ${task.title}`,
      ``,
      `## 任务描述`,
      task.description,
    ];

    if (task.attachments && task.attachments.length > 0) {
      lines.push('', '## 附件');
      for (const att of task.attachments) {
        lines.push(`- [${att.type}] ${att.name || att.url}`);
      }
    }

    if (task.posterName) {
      lines.push('', `---`, `发单人: ${task.posterName}`);
    }

    return lines.join('\n');
  }

  /**
   * 构建任务输出（从会话历史中收集文件产出）
   */
  private buildOutputs(content: string): TaskOutput[] {
    const outputs: TaskOutput[] = [{ type: 'text', content }];

    // 从会话历史中扫描文件产出
    try {
      const fitted = this.sessionManager.getFittedMessages(this.currentExecutingTaskId || '');
      const messages = fitted.messages || (Array.isArray(fitted) ? fitted : []);
      if (!messages || messages.length === 0) return outputs;

      const collectedFiles = new Set<string>();

      for (const msg of messages) {
        // 扫描 tool 角色的消息（write_file 等）
        if (msg.role !== 'tool') continue;

        const msgContent = msg.content || '';

        // 识别 write_file 工具产出的文件
        if (msg.name === 'write_file' || msgContent.includes('write_file')) {
          // 尝试从工具结果中提取文件路径
          const pathMatch = msgContent.match(/["']([^"']+\.(?:jpg|jpeg|png|gif|webp|svg|pdf|txt|csv|json|html|md|mp3|mp4|wav|docx?|xlsx?|pptx?))["']/i);
          if (pathMatch) {
            const filePath = pathMatch[1];
            if (fs.existsSync(filePath) && !collectedFiles.has(filePath)) {
              collectedFiles.add(filePath);
              const ext = path.extname(filePath).slice(1).toLowerCase();
              const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext);
              outputs.push({
                type: isImage ? 'image' : 'file',
                content: filePath,
                name: path.basename(filePath),
              });
            }
          }
        }

        // 识别包含文件路径的内容（通用模式）
        const genericFileMatch = msgContent.match(/(?:文件已保存|已写入|已保存到?|saved|written to)[^\n]*(\/?[^\s"']+\.(?:jpg|jpeg|png|gif|webp|pdf|txt|csv|json|html|md|mp3|mp4|wav))/i);
        if (genericFileMatch) {
          const filePath = genericFileMatch[1];
          if (fs.existsSync(filePath) && !collectedFiles.has(filePath)) {
            collectedFiles.add(filePath);
            const ext = path.extname(filePath).slice(1).toLowerCase();
            const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext);
            outputs.push({
              type: isImage ? 'image' : 'file',
              content: filePath,
              name: path.basename(filePath),
            });
          }
        }
      }

      if (outputs.length > 1) {
        this.logger.info(`收集到 ${outputs.length - 1} 个文件产出`);
      }
    } catch {
      // 收集失败不影响主流程
    }

    return outputs;
  }

  /**
   * 检测 LLM 回复是否为"无法完成"类拒绝
   */
  private isRefusalResponse(content: string): boolean {
    if (!content || content.length < 10) return false;
    const lower = content.toLowerCase();
    // 中英文拒绝模式
    const refusalPatterns = [
      /无法(完成|执行|处理|下载|访问|帮你)/,
      /做不到/,
      /无法满足/,
      /能力不足/,
      /没有.*权限/,
      /不具备.*能力/,
      /无法.*提供/,
      /超出.*能力/,
      /暂时无法/,
      /目前无法/,
      /我无法/,
      /i (can'?t|cannot|am unable to)/,
      /not (capable|able|possible)/,
      /beyond (my|the) (capability|scope|abilities)/,
      /don'?t have (access|permission|the ability)/,
      /unable to (complete|fulfill|perform|handle|process)/,
      /cannot (complete|fulfill|perform|handle|process)/,
    ];
    // 需要匹配至少 2 个模式才算拒绝（避免误判）
    let matchCount = 0;
    for (const pattern of refusalPatterns) {
      if (pattern.test(lower)) {
        matchCount++;
        if (matchCount >= 2) return true;
      }
    }
    // 或者内容很短且包含关键拒绝词
    if (content.length < 100) {
      const shortRefusal = [/无法/, /做不到/, /i can'?t/i, /unable to/i];
      for (const p of shortRefusal) {
        if (p.test(lower)) return true;
      }
    }
    return false;
  }

  /**
   * 获取人格实例
   */
  getPersonality(): Personality {
    return this.personality;
  }

  /**
   * 获取会话管理器
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * 获取技能注册表
   */
  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  /**
   * 注册技能
   */
  registerSkill(skill: import('../skills/types.js').Skill): void {
    this.skillRegistry.register(skill);
  }

  /**
   * 初始化所有技能
   */
  async initializeSkills(): Promise<{ success: number; failed: number }> {
    return this.skillRegistry.initializeAll();
  }

  /**
   * 获取会话统计
   */
  getSessionStats() {
    return this.sessionManager.getStats();
  }

  /**
   * 获取技能统计
   */
  getSkillStats() {
    return this.skillRegistry.getStats();
  }

  /**
   * 设置经验管理器
   */
  setExperienceManager(em: ExperienceManager): void {
    this.experienceManager = em;
  }

  /**
   * 获取经验管理器
   */
  getExperienceManager(): ExperienceManager | null {
    return this.experienceManager;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.sessionManager.dispose();
    this.skillRegistry.disposeAll().catch(() => {});
  }

  /**
   * 轻量回复生成（用于私信/评论回复等非任务场景）
   * 不创建会话、不走工具调用循环，直接调用 LLM 生成回复
   */
  async generateReply(systemPrompt: string, userMessage: string): Promise<string | null> {
    try {
      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];

      const response = await this.llm.chat({
        messages,
        maxTokens: 1024, // 私信/评论回复不需要太长
      });

      const content = response.content?.trim();
      if (!content) return null;

      // 清理可能的 markdown 包裹
      return content
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/^```[\w]*\n?|\n?```$/g, '')
        .trim();
    } catch (err) {
      this.logger.error('生成回复失败', { error: (err as Error).message });
      return null;
    }
  }
}
