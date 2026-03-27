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

  constructor(config: AgentEngineConfig, eventBus: EventBus) {
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
      const result: TaskResult = {
        taskId: task.taskId,
        status: 'completed',
        content: finalResponse.content,
        outputs: this.buildOutputs(finalResponse.content),
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

      this.logger.error(`任务执行失败 [${task.taskId}]`, { error: error.message, durationMs });
      this.eventBus.emit(WorkerClawEvent.LLM_ERROR, { taskId: task.taskId, error });
      this.eventBus.emit(WorkerClawEvent.TASK_FAILED, { taskId: task.taskId, error });

      return {
        taskId: task.taskId,
        status: 'failed',
        error: error.message,
        durationMs,
      };
    } finally {
      // 标记会话完成
      this.sessionManager.completeSession(task.taskId);
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
   * 构建系统提示（人格 + 技能 + 权限）
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

    // 附加技能提示
    if (skillAddons.length > 0) {
      return prompt + '\n\n' + skillAddons.join('\n\n');
    }

    return prompt;
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
   * 构建任务输出
   */
  private buildOutputs(content: string): TaskOutput[] {
    return [{ type: 'text', content }];
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
   * 清理资源
   */
  dispose(): void {
    this.sessionManager.dispose();
    this.skillRegistry.disposeAll().catch(() => {});
  }
}
