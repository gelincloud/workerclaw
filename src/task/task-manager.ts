/**
 * 任务管理器 (Phase 3 完整版)
 * 
 * 负责任务的完整生命周期：
 * 收到任务 → 安全检查 → 评估 → 状态机 → 并发控制 → 执行 → 结果上报
 */

import { createLogger, type Logger } from '../core/logger.js';
import { EventBus, WorkerClawEvent } from '../core/events.js';
import { SecurityGate } from '../security/gate.js';
import { AgentEngine } from '../agent/agent-engine.js';
import { messageParser } from '../ingress/message-parser.js';
import { PlatformApiClient } from '../ingress/platform-api.js';
import { createBuiltinToolRegistry } from '../agent/tool-registry.js';
import { ToolExecutor } from '../agent/tool-executor.js';
import { TaskStateMachine } from './task-state-machine.js';
import { TaskEvaluator } from './task-evaluator.js';
import { ConcurrencyController } from './concurrency.js';
import type {
  Task, TaskResult, TaskExecutionContext, TaskEvaluation, EvaluationContext,
} from '../types/task.js';
import type { PlatformConfig, LLMConfig, SecurityConfig, TaskConfig } from '../core/config.js';
import type { PermissionLevel } from '../types/agent.js';
import type { ExperienceManager } from '../experience/index.js';

export interface TaskManagerConfig {
  platform: PlatformConfig;
  llm: LLMConfig;
  security: SecurityConfig;
  task: TaskConfig;
  personality: {
    name: string;
    tone: string;
    bio: string;
    description?: string;
    expertise?: string[];
    language?: string;
    customSystemPrompt?: string;
    behavior?: {
      proactivity: number;
      humor: number;
      formality: number;
    };
  };
}

export class TaskManager {
  private logger: Logger;
  private config: TaskManagerConfig;
  private eventBus: EventBus;
  private securityGate: SecurityGate;
  private agentEngine: AgentEngine;

  // Phase 3 新增模块
  private stateMachine: TaskStateMachine;
  private evaluator: TaskEvaluator;
  private concurrency: ConcurrencyController;
  private platformApi: PlatformApiClient;
  private toolExecutor: ToolExecutor;

  /** 经验管理器（由外部注入） */
  private experienceManager: ExperienceManager | null = null;

  // 超时管理
  private taskTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: TaskManagerConfig, eventBus: EventBus, securityGate: SecurityGate) {
    this.config = config;
    this.eventBus = eventBus;
    this.securityGate = securityGate;

    // Agent 引擎
    this.agentEngine = new AgentEngine(
      { llm: config.llm, personality: config.personality, security: config.security },
      eventBus,
    );

    // Phase 3: 状态机
    this.stateMachine = new TaskStateMachine(eventBus);

    // Phase 3: 评估器
    this.evaluator = new TaskEvaluator(config.task.evaluation);

    // Phase 3: 并发控制器
    this.concurrency = new ConcurrencyController(config.task.concurrency, eventBus);
    this.concurrency.setQueueTimeoutHandler((task) => {
      this.logger.warn(`队列任务超时 [${task.taskId}]`);
      this.stateMachine.tryTransition(task.taskId, 'rejected', '队列等待超时');
      this.eventBus.emit(WorkerClawEvent.TASK_REJECTED, {
        taskId: task.taskId,
        reason: '队列等待超时',
      });
    });
    this.concurrency.setProcessQueueHandler(() => {
      this.processNextFromQueue();
    });

    // Phase 3: 平台 API
    this.platformApi = new PlatformApiClient(
      { platform: config.platform },
      eventBus,
    );

    // Phase 3: 工具系统
    const registry = createBuiltinToolRegistry();
    this.toolExecutor = new ToolExecutor(
      registry,
      { security: config.security },
      eventBus,
    );

    this.logger = createLogger('TaskManager');
  }

  /**
   * 处理平台消息
   */
  async handleMessage(message: any): Promise<void> {
    // 1. 安全检查
    const securityResult = await this.securityGate.check(message);
    if (!securityResult.passed) {
      this.logger.debug('消息未通过安全检查', { reason: securityResult.reason });
      return;
    }

    // 2. 解析消息
    const parsed = messageParser.parse(message);

    // 3. 分类处理
    switch (parsed.category) {
      case 'task':
        if (!parsed.task) {
          this.logger.warn('任务消息解析失败，无有效任务数据');
          return;
        }
        await this.handleTaskMessage(message.type, parsed.task!);
        break;

      case 'interaction':
        await this.handleInteractionMessage(message);
        break;

      case 'system':
        this.logger.debug('系统消息', { type: message.type });
        // 处理任务相关的系统消息
        this.handleSystemMessage(message);
        break;

      case 'heartbeat':
        // 心跳消息，忽略
        break;

      default:
        this.logger.debug('未处理的消息', { type: message.type, category: parsed.category });
        break;
    }
  }

  /**
   * 处理任务消息（分发到不同处理逻辑）
   */
  private async handleTaskMessage(msgType: string, task: Task): Promise<void> {
    if (msgType === 'new_task' || msgType === 'new_private_task' || msgType === 'task_push') {
      await this.handleTaskPush(task);
    } else if (msgType === 'task_cancel') {
      await this.handleTaskCancel(task);
    } else if (msgType === 'task_update') {
      this.logger.debug('收到任务更新（暂不处理）', { taskId: task.taskId });
    } else {
      this.logger.debug('未处理的任务消息类型', { type: msgType });
    }
  }

  /**
   * 处理交互消息（私信、评论等）
   * 参照 OpenClaw 插件的消息处理模式：LLM 评估 + 异步回复
   */
  private async handleInteractionMessage(message: any): Promise<void> {
    const msgType = message.type;

    switch (msgType) {
      case 'new_private_message': {
        const privateMsg = message.payload?.message || message.data?.message;
        if (!privateMsg) {
          this.logger.debug('私信消息缺少 message 数据', { type: msgType });
          return;
        }

        // 不回复自己的消息
        if (privateMsg.sender_id === this.config.platform.botId) {
          return;
        }

        // 任务类私信（带 related_task_id）暂不处理，等后续完善
        if (privateMsg.message_type === 'task' && privateMsg.related_task_id) {
          this.logger.info(`收到任务私信 [${privateMsg.related_task_id}]，暂走默认处理`);
        }

        this.logger.info(`💌 收到私信: ${privateMsg.sender?.nickname || privateMsg.sender_id}: ${privateMsg.content?.substring(0, 50)}`);

        // 异步处理私信回复（不阻塞消息循环）
        this.handlePrivateMessageReply(privateMsg, message).catch(err => {
          this.logger.error('私信回复异常', err);
        });
        break;
      }

      case 'new_message': {
        const innerMsg = message.payload?.message || message.data?.message;
        if (!innerMsg) return;

        // 评论通知
        if (innerMsg.type === 'comment') {
          this.logger.info(`📬 收到评论: ${innerMsg.commenterNickname} 评论了你的推文`);
          this.handleCommentReply(innerMsg, message).catch(err => {
            this.logger.error('评论回复异常', err);
          });
        }
        break;
      }

      case 'comment': {
        const commentMsg = message.payload || message.data;
        if (!commentMsg) return;
        this.logger.info(`💬 收到评论通知`, { type: msgType });
        break;
      }

      default:
        this.logger.debug('未处理的交互消息', { type: msgType });
        break;
    }
  }

  /**
   * 处理系统消息（任务拒绝、关闭等）
   */
  private handleSystemMessage(message: any): void {
    switch (message.type) {
      case 'task_rejected': {
        const payload = message.payload || message.data;
        this.logger.warn(`⚠️ 工作成果被拒收`, { taskId: payload?.taskId, reason: payload?.reason });
        break;
      }
      case 'task_closed': {
        const payload = message.payload || message.data;
        this.logger.info(`📋 任务已关闭`, { taskId: payload?.taskId });
        // 清理状态
        const taskId = payload?.taskId;
        if (taskId) {
          this.stateMachine.tryTransition(taskId, 'cancelled', '任务关闭');
          this.concurrency.cancelTask(taskId);
          this.clearTaskTimeout(taskId);
          this.stateMachine.cleanup(taskId);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * 私信回复处理：调用 LLM 生成回复并通过 API 发送
   */
  private async handlePrivateMessageReply(privateMsg: any, rawMessage: any): Promise<void> {
    try {
      const personality = this.config.personality;
      const senderName = privateMsg.sender?.nickname || '用户';
      const content = privateMsg.content || '';

      // 构建 LLM prompt
      const systemPrompt = personality.customSystemPrompt ||
        `你是${personality.name || '打工虾'}，语气${personality.tone || '友好热情'}。` +
        (personality.bio ? `简介：${personality.bio}` : '') +
        '\n\n你收到了一条站内私信，请生成简短的回复（1-3句话）。' +
        '\n回复要求：自然、友好、简洁，符合你的人格设定。' +
        '\n不要重复对方说过的话。如果对方在问问题，认真回答。' +
        '\n只输出回复内容，不要加引号或前缀。';

      const result = await this.agentEngine.generateReply(
        systemPrompt,
        `来自${senderName}的私信：\n${content}`,
      );

      if (result) {
        const sendResult = await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          privateMsg.sender_id,
          result,
        );
        if (sendResult.success) {
          this.logger.info(`💌 已回复私信 → ${senderName}: ${result.substring(0, 50)}`);
        } else {
          this.logger.warn(`💌 私信回复失败`, { error: sendResult.error });
        }
      } else {
        this.logger.debug('私信回复为空，跳过回复');
      }
    } catch (err) {
      this.logger.error('私信回复处理异常', err);
    }
  }

  /**
   * 评论回复处理：调用 LLM 评估是否需要回复
   */
  private async handleCommentReply(commentMsg: any, rawMessage: any): Promise<void> {
    try {
      const personality = this.config.personality;

      const systemPrompt = personality.customSystemPrompt ||
        `你是${personality.name || '打工虾'}，语气${personality.tone || '友好热情'}。` +
        '\n\n有人评论了你的推文，请决定是否回复。' +
        '\n如果评论是问题或有实质性内容，应该回复。' +
        '\n如果只是"好"、"赞"之类的简单表态，可以不回复。' +
        '\n回复要求：自然、简短（1-2句话）。' +
        '\n只输出回复内容，如果不需要回复则输出"__SKIP__"。';

      const commentContent = commentMsg.content || '';
      const commenterName = commentMsg.commenterNickname || '用户';

      const result = await this.agentEngine.generateReply(
        systemPrompt,
        `评论者: ${commenterName}\n评论内容: ${commentContent}`,
      );

      if (result && result !== '__SKIP__') {
        const sendResult = await this.platformApi.postComment(
          commentMsg.tweetId,
          result,
        );
        if (sendResult.success) {
          this.logger.info(`📬 已回复评论 → ${commenterName}: ${result.substring(0, 50)}`);
        } else {
          this.logger.warn(`📬 评论回复失败`, { error: sendResult.error });
        }
      }
    } catch (err) {
      this.logger.error('评论回复处理异常', err);
    }
  }

  /**
   * 处理新任务推送
   */
  private async handleTaskPush(task: Task): Promise<void> {
    this.logger.info(`收到新任务 [${task.taskId}]`, {
      type: task.taskType,
      title: task.title,
      reward: task.reward,
    });

    // 初始化状态
    this.stateMachine.init(task);
    this.eventBus.emit(WorkerClawEvent.TASK_RECEIVED, { task });

    // Phase 3: 评估任务
    if (!this.config.task.autoAccept.enabled) {
      this.logger.info('自动接单已关闭，跳过任务');
      this.stateMachine.transition(task.taskId, 'rejected', '自动接单已关闭');
      this.eventBus.emit(WorkerClawEvent.TASK_REJECTED, {
        taskId: task.taskId,
        reason: '自动接单已关闭',
      });
      return;
    }

    // 进入评估状态
    this.stateMachine.transition(task.taskId, 'evaluating');

    const evaluation = this.evaluateTask(task);
    this.eventBus.emit(WorkerClawEvent.TASK_EVALUATED, { taskId: task.taskId, evaluation });

    // 根据评估结果决策
    switch (evaluation.decision) {
      case 'accept':
        await this.acceptTask(task, evaluation);
        break;
      case 'defer':
        await this.deferTask(task, evaluation);
        break;
      case 'reject':
        this.stateMachine.transition(task.taskId, 'rejected', evaluation.reason);
        this.eventBus.emit(WorkerClawEvent.TASK_REJECTED, {
          taskId: task.taskId,
          reason: evaluation.reason || '评估未通过',
        });
        break;
    }
  }

  /**
   * 评估任务
   */
  private evaluateTask(task: Task): TaskEvaluation {
    const concurrencyStats = this.concurrency.getStats();

    const context: EvaluationContext = {
      runningCount: concurrencyStats.running,
      maxConcurrent: this.config.task.concurrency.maxConcurrent,
      skills: this.toolExecutor.getRegistry().getToolNames(),
      completedCountByType: {}, // Phase 4 追踪历史
      threshold: this.config.task.evaluation.acceptThreshold,
    };

    return this.evaluator.evaluate(task, context);
  }

  /**
   * 接受任务
   */
  private async acceptTask(task: Task, evaluation: TaskEvaluation): Promise<void> {
    const result = this.concurrency.tryStart(task);

    switch (result) {
      case 'started': {
        this.stateMachine.transition(task.taskId, 'accepted', evaluation.reason);
        this.stateMachine.transition(task.taskId, 'running');

        const permLevel = this.determinePermissionLevel(task);
        this.stateMachine.setPermissionLevel(task.taskId, permLevel);

        this.eventBus.emit(WorkerClawEvent.TASK_ACCEPTED, { taskId: task.taskId });

        // 接单：调用服务端 /api/task/:id/take
        this.platformApi.takeTask(task.taskId).catch(() => {});

        // 设置任务超时
        this.setTaskTimeout(task);

        // 执行任务
        this.executeTask(task, permLevel).catch(err => {
          this.logger.error(`任务执行异常 [${task.taskId}]`, err.message);
        });
        break;
      }
      case 'queued':
        this.stateMachine.transition(task.taskId, 'accepted', '进入等待队列');
        // 设置队列等待超时
        this.concurrency.setQueueTimeout(
          task.taskId,
          this.config.task.timeout.queueTimeoutMs,
        );
        break;
      case 'rejected':
        this.stateMachine.transition(task.taskId, 'rejected', '并发和队列均已满');
        this.eventBus.emit(WorkerClawEvent.TASK_REJECTED, {
          taskId: task.taskId,
          reason: '并发和队列均已满',
        });
        break;
    }
  }

  /**
   * 延迟任务（放入队列等待）
   */
  private async deferTask(task: Task, evaluation: TaskEvaluation): Promise<void> {
    this.logger.info(`任务延迟处理 [${task.taskId}]`, { score: evaluation.score });
    this.eventBus.emit(WorkerClawEvent.TASK_DEFERRED, {
      taskId: task.taskId,
      score: evaluation.score,
    });

    // 尝试放入队列
    const result = this.concurrency.tryStart(task);
    if (result === 'queued') {
      this.stateMachine.transition(task.taskId, 'accepted', '延迟接单，入队等待');
      this.concurrency.setQueueTimeout(
        task.taskId,
        this.config.task.timeout.queueTimeoutMs,
      );
    } else if (result === 'started') {
      // 有空位直接执行
      this.stateMachine.transition(task.taskId, 'accepted');
      this.stateMachine.transition(task.taskId, 'running');

      const permLevel = this.determinePermissionLevel(task);
      this.stateMachine.setPermissionLevel(task.taskId, permLevel);

      this.eventBus.emit(WorkerClawEvent.TASK_ACCEPTED, { taskId: task.taskId });
      this.platformApi.takeTask(task.taskId).catch(() => {});
      this.setTaskTimeout(task);

      this.executeTask(task, permLevel).catch(err => {
        this.logger.error(`任务执行异常 [${task.taskId}]`, err.message);
      });
    } else {
      this.stateMachine.transition(task.taskId, 'rejected', '队列已满');
      this.eventBus.emit(WorkerClawEvent.TASK_REJECTED, {
        taskId: task.taskId,
        reason: '队列已满',
      });
    }
  }

  /**
   * 执行任务
   */
  private async executeTask(task: Task, permLevel: PermissionLevel): Promise<void> {
    try {
      // 开始进化追踪
      this.experienceManager?.startEvolution(task.taskId, task.taskType);

      const context: TaskExecutionContext = {
        task,
        permissionLevel: permLevel,
        maxOutputTokens: this.config.llm.safety.maxTokens,
        timeoutMs: this.config.task.timeout.taskTimeoutMs,
        receivedAt: Date.now(),
      };

      let result = await this.agentEngine.executeTask(task, context);

      // 如果任务失败且有经验提示，用经验辅助重试一次
      if (result.status === 'failed' && result.experienceHint && this.experienceManager) {
        this.logger.info(`🧬 经验辅助重试 [${task.taskId}]`, {
          geneId: result.experienceHint.gene.gene_id.slice(0, 12),
          matchScore: result.experienceHint.matchScore,
        });

        // 记录第一次失败的尝试
        this.experienceManager.recordMutation(
          'default approach',
          'failed',
          result.error,
        );

        // 重新构建执行上下文（会自动通过 buildSystemPrompt 注入经验策略）
        // 需要先销毁上次会话
        this.agentEngine.getSessionManager().completeSession(task.taskId);

        result = await this.agentEngine.executeTask(task, context);

        if (result.status === 'completed') {
          this.experienceManager.recordMutation(
            'experience-guided retry',
            'success',
          );
          this.logger.info(`✅ 经验辅助重试成功 [${task.taskId}]`);
        } else {
          this.experienceManager.recordMutation(
            'experience-guided retry',
            'failed',
            result.error,
          );
        }
      }

      // 任务完成后尝试封装经验
      if (result.status === 'completed' && this.experienceManager) {
        this.experienceManager.completeEvolution(
          'success',
          `任务完成: ${task.title}`,
          [{ step: 1, action: '执行任务', explanation: task.description }],
          '', // 无错误信息
          { filesAffected: 0, linesChanged: 0 },
        ).then(evolutionResult => {
          if (evolutionResult) {
            this.eventBus.emit(WorkerClawEvent.EXPERIENCE_GAINED, {
              geneId: evolutionResult.gene.gene_id,
              category: evolutionResult.gene.category,
              summary: evolutionResult.gene.summary,
            });
            this.logger.info(`🧬 经验已封装 [${task.taskId}]`, {
              geneId: evolutionResult.gene.gene_id.slice(0, 12),
              category: evolutionResult.gene.category,
            });
          }
        }).catch(() => {});
      }

      // 上报结果到平台
      await this.reportResult(task, result);

    } finally {
      // 清理超时
      this.clearTaskTimeout(task.taskId);
      // 释放并发槽位
      this.concurrency.taskFinished(task.taskId);
    }
  }

  /**
   * 从队列取出下一个任务执行
   */
  private processNextFromQueue(): void {
    if (!this.concurrency.hasCapacity()) return;

    const stats = this.concurrency.getStats();
    if (stats.queue === 0) return;

    // ConcurrencyController 的 processQueue 已经取出任务
    // 这里由 setProcessQueueHandler 触发
    // 注意：processQueue 返回 true 表示成功取出
    // 我们需要获取被取出的任务
    this.logger.debug('有空位，尝试处理队列', {
      running: stats.running,
      queue: stats.queue,
    });
  }

  /**
   * 上报任务结果到平台
   */
  private async reportResult(task: Task, result: TaskResult): Promise<void> {
    const taskId = task.taskId;

    this.logger.info(`上报任务结果 [${taskId}]`, {
      status: result.status,
      durationMs: result.durationMs,
    });

    // 更新状态机
    if (result.status === 'completed') {
      this.stateMachine.transition(taskId, 'completed');
    } else {
      this.stateMachine.transition(taskId, 'failed', result.error);
    }

    // 上报到平台 API
    const reported = await this.platformApi.reportResult(taskId, result);

    if (result.status === 'completed') {
      this.logger.info(`✅ 任务完成 [${taskId}]`, {
        contentPreview: result.content?.slice(0, 200),
        reported,
      });
    } else {
      this.logger.error(`❌ 任务失败 [${taskId}]`, {
        error: result.error,
        reported,
      });
    }

    // 清理状态记录
    this.stateMachine.cleanup(taskId);
  }

  /**
   * 设置任务执行超时
   */
  private setTaskTimeout(task: Task): void {
    const timeoutMs = this.config.task.timeout.taskTimeoutMs;
    const timer = setTimeout(() => {
      this.logger.warn(`任务执行超时 [${task.taskId}]`, { timeoutMs });
      this.stateMachine.tryTransition(task.taskId, 'timeout', '执行超时');
      this.eventBus.emit(WorkerClawEvent.TASK_TIMEOUT, { taskId: task.taskId });

      // 释放资源
      this.concurrency.taskFinished(task.taskId);
      this.taskTimeouts.delete(task.taskId);

      // 上报超时到平台
      this.platformApi.updateStatus(task.taskId, 'timeout', `执行超时 ${timeoutMs}ms`).catch(() => {});
    }, timeoutMs);
    this.taskTimeouts.set(task.taskId, timer);
  }

  /**
   * 清除任务超时
   */
  private clearTaskTimeout(taskId: string): void {
    const timer = this.taskTimeouts.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.taskTimeouts.delete(taskId);
    }
  }

  /**
   * 确定任务权限级别
   */
  private determinePermissionLevel(task: Task): PermissionLevel {
    return this.securityGate.gradePermission(task);
  }

  /**
   * 处理任务取消
   */
  private async handleTaskCancel(task: Task): Promise<void> {
    const state = this.stateMachine.getState(task.taskId);

    if (state && !this.stateMachine.isTerminal(task.taskId)) {
      this.logger.info(`任务被取消 [${task.taskId}]`);
      this.stateMachine.transition(task.taskId, 'cancelled', '发单人取消');

      // 从并发/队列中移除
      this.concurrency.cancelTask(task.taskId);
      this.clearTaskTimeout(task.taskId);

      this.eventBus.emit(WorkerClawEvent.TASK_CANCELLED, { taskId: task.taskId });
      this.platformApi.updateStatus(task.taskId, 'cancelled').catch(() => {});

      this.stateMachine.cleanup(task.taskId);
    }
  }

  /**
   * 获取运行状态
   */
  getStatus(): {
    runningTasks: number;
    queuedTasks: number;
    taskIds: string[];
    stateStats: Record<string, number>;
    concurrencyStats: ReturnType<ConcurrencyController['getStats']>;
  } {
    const concurrencyStats = this.concurrency.getStats();
    return {
      runningTasks: concurrencyStats.running,
      queuedTasks: concurrencyStats.queue,
      taskIds: [], // Phase 4 可以从 stateMachine 获取
      stateStats: this.stateMachine.getStats(),
      concurrencyStats,
    };
  }

  /**
   * 获取 AgentEngine 实例（Phase 4）
   */
  getAgentEngine(): AgentEngine {
    return this.agentEngine;
  }

  /**
   * 设置经验管理器
   */
  setExperienceManager(em: ExperienceManager): void {
    this.experienceManager = em;
    // 同时传递给 AgentEngine
    this.agentEngine.setExperienceManager(em);
  }

  /**
   * 清理资源
   */
  dispose(): void {
    for (const timer of this.taskTimeouts.values()) {
      clearTimeout(timer);
    }
    this.taskTimeouts.clear();
    this.concurrency.dispose();
    this.agentEngine.dispose();
  }
}
