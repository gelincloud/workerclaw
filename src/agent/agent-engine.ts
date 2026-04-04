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
import { ToolRegistry, createDefaultToolRegistry } from './tool-registry.js';
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
import type { ToolDefinition } from '../types/agent.js';
import * as fs from 'fs';
import * as path from 'path';

export interface AgentEngineConfig {
  llm: LLMConfig;
  personality: PersonalityConfig;
  security: SecurityConfig;
  /** 平台配置（botId、ownerId 等） */
  platform?: {
    botId?: string;
    ownerId?: string;
    apiUrl?: string;
  };
  /** 会话管理配置 */
  session?: {
    maxActiveSessions?: number;
    sessionTTL?: number;
    maxTokens?: number;
  };
  /** 技能执行配置 */
  skillRunner?: Partial<SkillRunnerConfig>;
  /** 本地媒体资料库目录 */
  mediaDir?: string;
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
    const toolRegistry = createDefaultToolRegistry(config.platform?.apiUrl, config.mediaDir);
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
   * 注册额外工具（供插件使用）
   * 例如 MiniABC 插件注册 send_file 工具
   */
  registerTool(tool: ToolDefinition): void {
    this.toolExecutor.getRegistry().register(tool);
    this.logger.info(`外部工具已注册: ${tool.name}`);
  }

  /**
   * 获取工具注册表引用（供插件直接操作）
   */
  getToolRegistry(): ToolRegistry {
    return (this.toolExecutor as any).registry as ToolRegistry;
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
      // 主人直接指令（owner- 前缀）给更多轮次，因为可能涉及多步操作（热搜→分析→发帖→互动）
      const isOwnerDirect = task.taskId.startsWith('owner-');
      const maxRounds = isOwnerDirect ? 20 : 15;
      const finalResponse = await this.llmLoop(task, context, maxRounds);

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

      // v2: 成果质量审核 — 检查成果是否真的满足任务需求
      const qualityCheck = this.checkOutputQuality(task, content, finalResponse.toolCallRounds || 0);
      if (!qualityCheck.passed) {
        this.logger.warn(`任务成果质量审核未通过 [${task.taskId}]`, {
          reason: qualityCheck.reason,
          contentPreview: content.slice(0, 200),
        });

        // 尝试自动降级执行（LLM 没用工具，但任务需要工具）
        if (finalResponse.toolCallRounds === 0) {
          this.logger.info(`🔧 尝试自动降级执行 [${task.taskId}]（LLM 未使用工具，自动调用工具补救）`);
          const fallbackResult = await this.tryAutoRemediation(task, context, qualityCheck.reason || '');
          if (fallbackResult) {
            return fallbackResult;
          }
        }

        return {
          taskId: task.taskId,
          status: 'failed',
          error: `成果质量未通过: ${qualityCheck.reason}`,
          durationMs: Date.now() - startTime,
          qualityIssue: qualityCheck.reason,
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

      // 销毁浏览器会话（释放 BrowserContext 资源）
      const browserSkill = this.skillRegistry.getSkill('browser');
      if (browserSkill && typeof (browserSkill as any).destroyTaskSession === 'function') {
        try {
          await (browserSkill as any).destroyTaskSession(task.taskId);
        } catch (err) {
          this.logger.debug(`销毁浏览器会话失败 [${task.taskId}]`, {
            error: (err as Error).message,
          });
        }
      }
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

      // 调试日志：确认工具是否被获取
      this.logger.debug('获取工具列表', {
        taskId: task.taskId,
        toolCount: tools.length,
        toolNames: tools.map(t => t.function?.name || t.name).slice(0, 10),
        permissionLevel: context.permissionLevel,
      });

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
   *
   * 路由策略：
   * 1. 先查 SkillRegistry 是否提供了该工具的执行器（如 BrowserSkill）
   * 2. 再走内置 ToolExecutor（如 web_search, write_file）
   * 3. 都没有则返回工具不可用
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

      const toolContext = {
        taskId: task.taskId,
        permissionLevel: context.permissionLevel,
        workDir: this.config.security.sandbox.workDir,
        remainingMs: context.timeoutMs - (Date.now() - context.receivedAt),
        toolCallCount: 0,
        maxToolCalls: 20,
        botId: this.config.platform?.botId || '',
        ownerId: this.config.platform?.ownerId || null,
      };

      let result: { success: boolean; content: string; error?: string };

      // 路由 1: 查技能执行器
      const skillExecutor = this.skillRegistry.getToolExecutor(name);
      if (skillExecutor) {
        this.logger.debug(`工具路由到技能: ${name} (skill: ${skillExecutor.skillName})`);
        const toolResult = await skillExecutor.executor(params, { ...toolContext, toolCallId: id } as any);
        result = {
          success: toolResult.success,
          content: toolResult.content,
          error: toolResult.error,
        };
      } else {
        // 路由 2: 走内置 ToolExecutor
        const toolCallObj: ToolCall = { id, name, arguments: argsStr };
        result = await this.toolExecutor.execute(toolCallObj, toolContext);
      }

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

    const allTools = [...builtinForLLM, ...skillToolsForLLM];

    this.logger.debug('工具汇总', {
      builtinCount: builtinForLLM.length,
      skillCount: skillToolsForLLM.length,
      totalCount: allTools.length,
      permLevel,
    });

    return allTools;
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

    // 附加微博 PR 引导（当任务涉及微博推广时，建议结合热搜话题）
    const weiboPrGuidance = this.buildWeiboPrGuidance(task);
    if (weiboPrGuidance) {
      result += '\n\n' + weiboPrGuidance;
    }

    return result;
  }

  /**
   * 微博 PR 推广引导
   * 当任务涉及微博推广/发微博/营销时，自动建议结合热搜话题生成更自然的文案。
   * 通过 weibo_hot_search 工具或 web_cli 获取实时热搜数据。
   */
  private buildWeiboPrGuidance(task: Task): string | null {
    const desc = `${task.title || ''} ${task.description || ''}`;
    const prKeywords = [
      '微博.*推广', '微博.*营销', '微博.*宣传', '微博.*PR', '微博.*发',
      '发.*微博', '推广.*微博', '微博.*话题', '蹭.*热点', '蹭.*热搜',
      'weibo.*pr', 'weibo.*promo', 'social.*media.*marketing',
      '社媒.*推广', '社交媒体.*推广',
    ];

    if (!prKeywords.some(kw => new RegExp(kw, 'i').test(desc))) {
      return null;
    }

    return [
      '## 🔥 微博推广技巧 — 结合热搜话题',
      '此任务涉及微博推广，请参考以下策略生成更自然、更有传播力的文案：',
      '',
      '**操作步骤：**',
      '1. 先调用 `weibo_hot_search` 工具获取当前微博热搜榜（实时数据）',
      '2. 分析热搜话题，找到与推广内容自然结合的热点',
      '3. 将推广信息融入热门话题，使文案看起来更像自然分享而非硬广',
      '',
      '**文案技巧：**',
      '- 不要直接发广告，先聊聊热点话题，自然过渡到推广内容',
      '- 适当使用热门话题标签（#话题名#）增加曝光',
      '- 结合个人感受/观点，避免官方口吻',
      '- 控制推广内容占比在30%以内，保持内容价值感',
      '- 可适当 @ 相关账号增加互动感',
      '',
      '**互动增强：**',
      '- 发布后可使用 web_cli 工具调用 weibo/retweet 转发相关话题微博并评论',
      '- 使用 weibo/comment 在热门微博下评论（自然提及推广内容）',
      '- 使用 weibo/like 点赞相关微博增加曝光',
    ].join('\n');
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

    // === 找图/下载图片类任务 ===
    const imageSearchKeywords = [
      '找.*图', '搜索.*图', '下载.*图', '帮我.*图',
      '风景图', '太空图', '星空图', '壁纸', '头像', '背景图',
      '照片', '截图',
    ];
    if (imageSearchKeywords.some(kw => new RegExp(kw, 'i').test(desc))) {
      return [
        '## 📎 找图任务执行指南',
        '此任务需要你找到图片并提供给用户，**你必须立即调用工具搜索图片，不能只回复文字说明！**',
        '',
        '### 执行步骤（按顺序执行）：',
        '',
        '**步骤 1：立即调用 web_search 搜索图片**',
        '- 使用 `web_search` 工具搜索图片相关关键词',
        '- 例：`web_search({ query: "大海 高清图片 site:unsplash.com" })`',
        '- 或：`web_search({ query: "大海 免费 高清图片 下载" })`',
        '',
        '**步骤 2：整理搜索结果**',
        '- 从搜索结果中提取图片直接链接（.jpg/.png/.webp 结尾）',
        '- 如果搜索结果中有图片预览链接，直接使用',
        '',
        '**步骤 3：如果有 browser_navigate 工具可用**',
        '- 访问找到的图片 URL，设置 `screenshot: true` 保存图片',
        '',
        '### ⚠️ 关键要求：',
        '- **第一步必须调用 `web_search` 工具**，不要跳过！',
        '- **绝对不要**只回复文字说明而没有调用任何工具',
        '- 如果工具调用失败，再尝试一次或换关键词',
        '- 最终回复应包含：找到的图片描述 + 图片下载链接',
      ].join('\n');
    }

    // === 搜索/查找类任务（非图片） ===
    const searchKeywords = ['搜一下', '查一下', '帮我找', '帮我查', '百度', '谷歌', '搜索', '查找'];
    if (searchKeywords.some(kw => desc.includes(kw))) {
      return [
        '## 📎 搜索任务执行指南',
        '此任务需要你实际执行搜索操作，**不能仅凭自身知识回答**。',
        '',
        '正确执行步骤：',
        '1. 使用 `web_search` 或 `browser_navigate` 工具实际执行搜索',
        '2. 从搜索结果中提取有价值的信息',
        '3. 将整理后的信息作为成果提交',
        '',
        '⚠️ 如果你有 `browser_extract` 工具可用，优先使用它来访问网页获取详细内容。',
      ].join('\n');
    }

    // === 生成文件类任务（图片生成、文档等） ===
    const fileGenKeywords = [
      '生成.*图', '画.*图', 'AI.*画', 'AI.*图',
      '文档', '报告', '表格', '数据',
      'PPT', '幻灯片', '演示文稿',
      '音频', '视频',
    ];
    if (fileGenKeywords.some(kw => new RegExp(kw, 'i').test(desc))) {
      return [
        '## 📎 文件产出要求',
        '此任务需要生成具体文件作为成果，不能只回复文字说明。',
        '',
        '执行方式：',
        '1. 如果需要文档/报告：使用 write_file 工具将内容写入文件（.md, .txt, .csv, .html 等）',
        '2. 如果需要数据分析结果：使用 write_file 写入 CSV/JSON 格式的数据文件',
        '',
        '⚠️ 重要：',
        '- 最终回复中应该包含对生成文件的说明',
        '- 文件路径使用沙箱工作目录下的路径',
        '- 系统会自动将你生成的文件作为附件提交给发单人',
      ].join('\n');
    }

    return '';
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
        // 扫描 tool 角色的消息（write_file, browser_screenshot 等）
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

        // v2: 识别 browser_screenshot / browser_navigate 的截图产出
        if (msg.name === 'browser_screenshot' || msg.name === 'browser_navigate') {
          // browser_screenshot 返回格式: "截图已保存: /path/to/file.jpg"
          const screenshotMatch = msgContent.match(/(?:截图已保存|📸.*?保存)[：:]\s*(\S+\.(?:jpg|jpeg|png|gif|webp))/i);
          if (screenshotMatch) {
            const filePath = screenshotMatch[1];
            if (fs.existsSync(filePath) && !collectedFiles.has(filePath)) {
              collectedFiles.add(filePath);
              outputs.push({
                type: 'image',
                content: filePath,
                name: path.basename(filePath),
              });
            }
          }
        }

        // 识别包含文件路径的内容（通用模式）
        const genericFileMatch = msgContent.match(/(?:文件已保存|已写入|已保存到?|saved|written to|截图已保存)[^\n]*(\/?[^\s"']+\.(?:jpg|jpeg|png|gif|webp|pdf|txt|csv|json|html|md|mp3|mp4|wav))/i);
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

        // v2: 扫描工具结果中的图片 URL（从 browser_extract 结果中提取）
        // browser_extract 返回格式: "- 描述: https://example.com/image.jpg"
        if (msg.name === 'browser_extract' || msgContent.includes('### 图片')) {
          const imgUrlMatches = msgContent.matchAll(/https?:\/\/[\w\-._~:/?#\[\]@!$&'()*+,;=%]+\.(?:jpg|jpeg|png|gif|webp)/gi);
          for (const match of imgUrlMatches) {
            const imgUrl = match[0];
            // 不需要下载，只记录 URL — 让质量审核知道有图片 URL 可用
            if (!collectedFiles.has(imgUrl)) {
              collectedFiles.add(imgUrl);
            }
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
   * v2: 成果质量审核
   *
   * 检查 LLM 输出是否真正满足了任务需求，防止"说了但没做"的情况。
   * 例如：找图任务只返回了文字说明，没有实际下载图片。
   */
  private checkOutputQuality(
    task: Task,
    content: string,
    toolCallRounds: number,
  ): { passed: boolean; reason?: string } {
    const desc = (task.title + ' ' + task.description).toLowerCase();

    // === 图片类任务检查 ===
    const imageKeywords = [
      '找.*图', '搜索.*图', '下载.*图', '帮我.*图',
      '图片', '照片', '截图', '壁纸', '头像', '背景图',
      '风景图', '太空图', '星空图', '大海', '夕阳', 'sunset',
    ];
    const needsImage = imageKeywords.some(kw => new RegExp(kw, 'i').test(desc));

    if (needsImage) {
      // 图片任务必须满足以下条件之一：
      // 1. 有文件产出（outputs 中有 image 类型）
      // 2. 工具调用 >= 1 轮（至少尝试了搜索/下载）
      // 3. 内容中包含图片 URL（可能是直接返回了链接）
      const outputs = this.buildOutputs(content);
      const hasImageFile = outputs.some(o => o.type === 'image');
      const hasImageUrl = /https?:\/\/[^\s"')\]]+\.(?:jpg|jpeg|png|gif|webp|bmp|svg)/i.test(content);
      const attemptedTools = toolCallRounds >= 1;

      if (!hasImageFile && !attemptedTools && !hasImageUrl) {
        return {
          passed: false,
          reason: `任务需要图片文件作为成果，但 Agent 没有使用任何工具来搜索/下载图片（工具调用轮次: ${toolCallRounds}）。需要使用 browser_extract 或 web_search 工具查找图片，并下载保存为文件。`,
        };
      }

      // 如果有工具调用但没有图片文件，检查是否只是搜索了文字
      if (attemptedTools && !hasImageFile && !hasImageUrl) {
        // 允许通过，但记录警告（工具调用了但可能没有正确处理）
        this.logger.debug(`图片任务使用了工具但没有产出图片文件 [${task.taskId}]`, {
          toolCallRounds,
          contentLength: content.length,
        });
      }
    }

    // === 搜索/查找类任务检查 ===
    const searchKeywords = ['搜一下', '查一下', '帮我找', '帮我查', '搜索', '查找', '百度', '谷歌'];
    const needsSearch = searchKeywords.some(kw => desc.includes(kw));

    if (needsSearch && toolCallRounds === 0) {
      // 搜索任务至少应该尝试使用工具
      // 但不强制失败，只记录警告（LLM 可能用自身知识回答了）
      this.logger.debug(`搜索任务没有使用任何工具 [${task.taskId}]`);
    }

    // === "假工具调用"检测 ===
    // 如果内容中包含看起来像工具调用的文本但没有实际工具调用
    if (toolCallRounds === 0) {
      const fakeToolCallPatterns = [
        /[:<]?\s*web_search\s*[\(（]/,
        /[:<]?\s*browser_navigate\s*[\(（]/,
        /[:<]?\s*write_file\s*[\(（]/,
        /[:<]?\s*browser_extract\s*[\(（]/,
        /[:<]?\s*image_generate\s*[\(（]/,
      ];
      const hasFakeToolCall = fakeToolCallPatterns.some(p => p.test(content));

      if (hasFakeToolCall) {
        this.logger.warn(`检测到"假工具调用"文本 [${task.taskId}]`, {
          contentPreview: content.slice(0, 300),
        });
        // 对于需要实际操作的任务，假工具调用 = 失败
        if (needsImage || needsSearch) {
          return {
            passed: false,
            reason: 'Agent 将工具调用以纯文本形式输出，没有实际执行工具。这可能是因为当前 LLM 模型不支持 function calling，或工具定义未正确传递。',
          };
        }
      }
    }

    return { passed: true };
  }

  /**
   * 自动降级执行：当 LLM 没有使用工具但任务需要时，自动调用工具补救
   *
   * 场景：LLM 不支持 function calling 或忽视了工具引导，
   * 导致 toolCallRounds=0 但任务需要实际操作（如找图、搜索）。
   *
   * 策略：
   * - 找图任务 → browser_extract → 截图图库页面 → web_search → 搜索建议兜底
   * - 搜索任务 → 自动 web_search
   */
  private async tryAutoRemediation(
    task: Task,
    context: TaskExecutionContext,
    qualityReason: string,
  ): Promise<TaskResult | null> {
    const desc = (task.title + ' ' + task.description).toLowerCase();
    const startTime = Date.now();

    // 判断任务类型
    const imageKeywords = [
      '找.*图', '搜索.*图', '下载.*图', '帮我.*图',
      '图片', '照片', '壁纸', '头像', '背景图',
      '风景图', '太空图', '星空图', '大海', '夕阳', 'sunset',
    ];
    const searchKeywords = ['搜一下', '查一下', '帮我找', '帮我查', '搜索', '查找', '百度', '谷歌'];
    const needsImage = imageKeywords.some(kw => new RegExp(kw, 'i').test(desc));
    const needsSearch = searchKeywords.some(kw => desc.includes(kw));

    if (!needsImage && !needsSearch) {
      return null;
    }

    try {
      if (needsImage) {
        // 自动找图降级方案
        const result = await this.autoFindImage(task, context);
        if (result) {
          // 降级链审查：找图任务的结果必须包含图片文件（outputs 中有 image）
          // 纯文字结果（链接、搜索建议）不算真正完成找图任务
          if (result.outputs && result.outputs.some(o => o.type === 'image')) {
            return {
              ...result,
              durationMs: Date.now() - startTime,
            };
          }
          // 降级链只返回了文字，没有真正获取到图片文件 → 标记失败
          this.logger.warn(`降级链审查未通过：找图任务没有产出图片文件 [${task.taskId}]`, {
            hasOutputs: !!result.outputs,
            outputCount: result.outputs?.length || 0,
          });
          return {
            taskId: task.taskId,
            status: 'failed',
            error: `自动找图失败：尝试了多种方式但未能获取图片文件。${result.content?.slice(0, 100) || ''}`,
            durationMs: Date.now() - startTime,
            qualityIssue: 'fallback_no_image_file',
          };
        }
      }

      if (needsSearch) {
        // 自动搜索降级方案
        const result = await this.autoSearch(task, context);
        if (result) {
          return {
            ...result,
            durationMs: Date.now() - startTime,
          };
        }
      }
    } catch (err) {
      this.logger.warn(`自动降级执行失败 [${task.taskId}]`, { error: (err as Error).message });
    }

    return null;
  }

  /**
   * 自动找图：直接调用 browser_extract + 截图 找图
   *
   * 降级链：
   * 1. browser_extract 从图库提取图片 URL → 下载/截图
   * 2. 直接对图库搜索页截图（最可靠的降级方案）
   * 3. web_search 搜索图片信息
   * 4. 最终兜底：返回搜索建议文本（不再返回 null）
   */
  private async autoFindImage(
    task: Task,
    context: TaskExecutionContext,
  ): Promise<TaskResult | null> {
    const taskId = task.taskId;
    const desc = task.title + ' ' + task.description;

    // 1. 从任务描述中提取搜索关键词
    const searchQuery = this.extractSearchQuery(desc);
    if (!searchQuery) {
      this.logger.warn(`无法从任务描述中提取搜索关键词 [${taskId}]`);
      return null;
    }

    this.logger.info(`🔍 自动找图 [${taskId}] 关键词: "${searchQuery}"`);

    // 2. 尝试 browser_extract 从免费图库提取图片
    const imageUrl = await this.autoBrowserExtractImage(searchQuery, context);
    if (imageUrl) {
      // 3. 尝试对图片 URL 截图
      const screenshotPath = await this.autoBrowserScreenshotUrl(imageUrl, context);
      if (screenshotPath) {
        return {
          taskId,
          status: 'completed',
          content: `为您找到了"${searchQuery}"相关的图片！图片已截图保存。\n\n图片来源: ${imageUrl.slice(0, 100)}`,
          outputs: [{
            type: 'image',
            content: screenshotPath,
            name: `${searchQuery}.jpg`,
          }],
          durationMs: 0,
        };
      }

      // 降级：返回图片 URL
      return {
        taskId,
        status: 'completed',
        content: `为您找到了"${searchQuery}"相关的图片！\n\n图片链接: ${imageUrl}\n\n您可以点击链接查看或下载图片。`,
        outputs: [],
        durationMs: 0,
      };
    }

    // 4. browser_extract 未获取图片 URL，直接对图库搜索页截图（最可靠的降级方案）
    this.logger.info(`browser_extract 未获取图片 URL，尝试直接截图图库搜索页 [${taskId}]`);
    const screenshotPath = await this.autoBrowserScreenshot(searchQuery, context);
    if (screenshotPath) {
      return {
        taskId,
        status: 'completed',
        content: `为您找到了"${searchQuery}"相关的图片！已在图片搜索网站截图。\n\n请查看附件中的截图，图中包含多张相关图片，您可以从中选择喜欢的。`,
        outputs: [{
          type: 'image',
          content: screenshotPath,
          name: `${searchQuery}-search.jpg`,
        }],
        durationMs: 0,
      };
    }

    // 5. 截图也失败，使用 web_search 搜索图片信息
    this.logger.info(`截图不可用，使用 web_search 搜索图片信息 [${taskId}]`);
    const searchResult = await this.autoSearchForImageUrls(searchQuery, context);
    if (searchResult && searchResult.outputs && searchResult.outputs.some(o => o.type === 'image')) {
      return searchResult;
    }
    // web_search 返回的纯文字结果不算真正完成找图任务，继续往下走兜底

    // 6. 最终兜底：返回 null，让上层标记为 failed
    // 不再返回 completed + 纯文字，因为找图任务必须交付图片文件
    this.logger.warn(`自动找图完全失败，所有降级方式均未获取到图片文件 [${taskId}]`);
    return null;
  }

  /**
   * 自动搜索图片 URL（浏览器不可用时的降级方案）
   */
  private async autoSearchForImageUrls(
    query: string,
    context: TaskExecutionContext,
  ): Promise<TaskResult | null> {
    try {
      const toolCall: ToolCall = {
        id: `auto-imgsearch-${Date.now()}`,
        name: 'web_search',
        arguments: JSON.stringify({ query: `${query} 图片 高清` }),
      };

      // 给降级调用一个独立的超时窗口，不依赖原始任务的 remainingMs
      const fallbackContext: TaskExecutionContext = {
        ...context,
        receivedAt: Date.now(),  // 重置接收时间
      };

      const result = await this.handleToolCall(toolCall, {
        taskId: context.task.taskId,
        taskType: 'other',
        title: query,
        description: '',
      } as Task, fallbackContext);

      if (result.success && result.content && !result.content.includes('not_implemented')) {
        // 从搜索结果中提取图片 URL
        const imgUrls: string[] = [];
        const urlMatches = result.content.matchAll(/https?:\/\/[^\s"'<>)]+\.(?:jpg|jpeg|png|gif|webp)/gi);
        for (const m of urlMatches) {
          imgUrls.push(m[0]);
          if (imgUrls.length >= 3) break;
        }

        if (imgUrls.length > 0) {
          const urlList = imgUrls.map((u, i) => `${i + 1}. ${u}`).join('\n');
          return {
            taskId: context.task.taskId,
            status: 'completed',
            content: `为您搜索了"${query}"相关的图片，以下是一些搜索结果和图片链接：\n\n${result.content}\n\n---\n📎 找到的图片链接：\n${urlList}\n\n您可以点击以上链接查看或下载图片。`,
            outputs: [],
            durationMs: 0,
          };
        }

        // 没有直接图片 URL，但搜索结果本身有价值
          return {
            taskId: context.task.taskId,
            status: 'completed',
            content: `为您搜索了"${query}"相关的图片资源：\n\n${result.content}\n\n💡 提示：您可以访问以上搜索结果页面查找和下载所需图片。`,
          outputs: [],
          durationMs: 0,
        };
      }
    } catch (err) {
      this.logger.debug(`web_search 图片搜索失败`, { error: (err as Error).message });
    }
    return null;
  }

  /**
   * 自动搜索：直接调用 web_search 搜索信息
   */
  private async autoSearch(
    task: Task,
    context: TaskExecutionContext,
  ): Promise<TaskResult | null> {
    const taskId = task.taskId;
    const desc = task.title + ' ' + task.description;

    const searchQuery = this.extractSearchQuery(desc);
    if (!searchQuery) {
      return null;
    }

    this.logger.info(`🔍 自动搜索 [${taskId}] 关键词: "${searchQuery}"`);

    // 尝试调用 web_search 工具
    const toolCall: ToolCall = {
      id: `auto-${Date.now()}`,
      name: 'web_search',
      arguments: JSON.stringify({ query: searchQuery }),
    };

    try {
      // 给降级搜索一个独立的超时窗口
      const fallbackContext: TaskExecutionContext = {
        ...context,
        receivedAt: Date.now(),
      };
      const toolResult = await this.handleToolCall(toolCall, task, fallbackContext);
      if (toolResult.success && toolResult.content) {
        return {
          taskId,
          status: 'completed',
          content: toolResult.content,
          outputs: [],
          durationMs: 0,
        };
      }
    } catch (err) {
      this.logger.warn(`web_search 工具调用失败 [${taskId}]`, { error: (err as Error).message });
    }

    return null;
  }

  /**
   * 从任务描述中提取搜索关键词
   */
  private extractSearchQuery(desc: string): string {
    // 提取引号中的内容
    const quotedMatch = desc.match(/[""「]([^""」]+)[""」]/);
    if (quotedMatch) return quotedMatch[1];

    // 提取"帮我找/搜索"后面的内容
    const actionMatch = desc.match(/(?:帮我找|帮我搜|搜索|查找|找一?张?|下载)\s*(.+)/i);
    if (actionMatch) return actionMatch[1].replace(/[。，.！!？?]+$/, '').trim().slice(0, 30);

    // 使用任务标题作为关键词（去掉"帮我"等前缀）
    const cleanTitle = desc.replace(/^(帮我|请帮我|能不能|可以)/, '').trim().slice(0, 30);
    if (cleanTitle.length >= 2) return cleanTitle;

    return '';
  }

  /**
   * 自动调用 browser_extract 从图库提取图片 URL
   */
  private async autoBrowserExtractImage(
    query: string,
    context: TaskExecutionContext,
  ): Promise<string | null> {
    // 尝试几个免费图库
    const sources = [
      `https://unsplash.com/s/photos/${encodeURIComponent(query)}`,
      `https://www.pexels.com/search/${encodeURIComponent(query)}`,
    ];

    for (const url of sources) {
      try {
        const toolCall: ToolCall = {
          id: `auto-extract-${Date.now()}`,
          name: 'browser_extract',
          arguments: JSON.stringify({ url }),
        };

        // 给降级调用一个独立的超时窗口
        const fallbackContext: TaskExecutionContext = {
          ...context,
          receivedAt: Date.now(),
        };

        const result = await this.handleToolCall(toolCall, {
          taskId: context.task.taskId,
          taskType: 'other',
          title: query,
          description: '',
        } as Task, fallbackContext);

        if (result.success && result.content) {
          // 从提取结果中找图片 URL
          const imgUrlMatch = result.content.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|gif|webp)/i);
          if (imgUrlMatch) {
            this.logger.info(`找到图片 URL: ${imgUrlMatch[0].slice(0, 80)}...`);
            return imgUrlMatch[0];
          }
        }
      } catch (err) {
        this.logger.debug(`browser_extract 失败: ${url}`, { error: (err as Error).message });
      }
    }

    return null;
  }

  /**
   * 自动调用 browser_navigate 对图库搜索页截图
   * 尝试多个图库源，并重置超时确保降级流程有足够时间
   */
  private async autoBrowserScreenshot(
    query: string,
    context: TaskExecutionContext,
  ): Promise<string | null> {
    // 多个图库搜索页（Pixabay 最容易截图成功，不需要大量 JS 渲染）
    const sources = [
      `https://pixabay.com/images/search/${encodeURIComponent(query)}/`,
      `https://unsplash.com/s/photos/${encodeURIComponent(query)}`,
      `https://www.pexels.com/search/${encodeURIComponent(query)}/`,
    ];

    for (const url of sources) {
      try {
        this.logger.debug(`尝试截图图库: ${url}`);
        const toolCall: ToolCall = {
          id: `auto-screenshot-${Date.now()}`,
          name: 'browser_navigate',
          arguments: JSON.stringify({ url, screenshot: true, extractText: false }),
        };

        // 重置超时，给降级截图足够的执行时间
        const fallbackContext: TaskExecutionContext = {
          ...context,
          receivedAt: Date.now(),
        };

        const result = await this.handleToolCall(toolCall, {
          taskId: context.task.taskId,
          taskType: 'other',
          title: query,
          description: '',
        } as Task, fallbackContext);

        if (result.success && result.content) {
          // 从结果中提取截图文件路径 — 多种格式兼容
          const pathPatterns = [
            /(?:截图已保存|📸.*?保存)[：:]\s*(\S+\.(?:jpg|jpeg|png|gif|webp))/i,
            /(?:文件已保存|已写入|已保存到?|saved)[^\n]*(\/?[^\s"']+\.(?:jpg|jpeg|png|gif|webp))/i,
            /(\S+\/screenshot-\d+\.(?:jpg|jpeg|png|gif|webp))/i,
          ];
          for (const pattern of pathPatterns) {
            const pathMatch = result.content.match(pattern);
            if (pathMatch) {
              const filePath = pathMatch[1];
              if (fs.existsSync(filePath)) {
                this.logger.info(`截图成功: ${filePath}`);
                return filePath;
              }
            }
          }

          // 最后手段：检查默认截图目录下最新的截图文件
          const defaultDir = './data/sandbox';
          if (fs.existsSync(defaultDir)) {
            const files = fs.readdirSync(defaultDir)
              .filter(f => f.startsWith('screenshot-') && /\.(jpg|jpeg|png)$/i.test(f))
              .sort((a, b) => {
                const ta = parseInt(a.match(/\d+/)?.[0] || '0');
                const tb = parseInt(b.match(/\d+/)?.[0] || '0');
                return tb - ta; // 最新优先
              });
            // 只接受最近 10 秒内的截图文件（避免拿到旧截图）
            const now = Date.now();
            for (const f of files.slice(0, 3)) {
              const filePath = path.join(defaultDir, f);
              const stat = fs.statSync(filePath);
              if (now - stat.mtimeMs < 15000) {
                this.logger.info(`找到最近截图文件: ${filePath}`);
                return filePath;
              }
            }
          }
        }
      } catch (err) {
        this.logger.debug(`图库截图失败: ${url}`, { error: (err as Error).message });
      }
    }

    return null;
  }

  /**
   * 对图片 URL 截图
   */
  private async autoBrowserScreenshotUrl(
    imageUrl: string,
    context: TaskExecutionContext,
  ): Promise<string | null> {
    try {
      const toolCall: ToolCall = {
        id: `auto-img-screenshot-${Date.now()}`,
        name: 'browser_navigate',
        arguments: JSON.stringify({ url: imageUrl, screenshot: true, extractText: false }),
      };

      // 重置超时
      const fallbackContext: TaskExecutionContext = {
        ...context,
        receivedAt: Date.now(),
      };

      const result = await this.handleToolCall(toolCall, {
        taskId: context.task.taskId,
        taskType: 'other',
        title: '截图',
        description: '',
      } as Task, fallbackContext);

      if (result.success && result.content) {
        // 多种正则模式匹配截图路径
        const pathPatterns = [
          /(?:截图已保存|📸.*?保存)[：:]\s*(\S+\.(?:jpg|jpeg|png|gif|webp))/i,
          /(?:文件已保存|已写入|已保存到?|saved)[^\n]*(\/?[^\s"']+\.(?:jpg|jpeg|png|gif|webp))/i,
          /(\S+\/screenshot-\d+\.(?:jpg|jpeg|png|gif|webp))/i,
        ];
        for (const pattern of pathPatterns) {
          const pathMatch = result.content.match(pattern);
          if (pathMatch && fs.existsSync(pathMatch[1])) {
            return pathMatch[1];
          }
        }
      }
    } catch (err) {
      this.logger.debug(`图片截图失败`, { error: (err as Error).message });
    }

    return null;
  }
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
