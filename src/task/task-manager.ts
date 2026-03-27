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
import { WSMessageType } from '../types/message.js';

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
    if (parsed.category !== 'task') {
      if (parsed.category === 'interaction') {
        this.logger.debug('收到交互消息（暂不处理）', { type: message.type });
      }
      return;
    }

    if (!parsed.task) {
      this.logger.warn('任务消息解析失败，无有效任务数据');
      return;
    }

    // 3. 分发处理
    switch (message.type) {
      case WSMessageType.TASK_PUSH:
        await this.handleTaskPush(parsed.task);
        break;
      case WSMessageType.TASK_CANCEL:
        await this.handleTaskCancel(parsed.task);
        break;
      case WSMessageType.TASK_UPDATE:
        this.logger.debug('收到任务更新（暂不处理）', { taskId: parsed.task.taskId });
        break;
      default:
        this.logger.debug('未处理的任务消息类型', { type: message.type });
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

        // 上报接单状态到平台
        this.platformApi.updateStatus(task.taskId, 'accepted').catch(() => {});

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
      this.platformApi.updateStatus(task.taskId, 'accepted').catch(() => {});
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
      const context: TaskExecutionContext = {
        task,
        permissionLevel: permLevel,
        maxOutputTokens: this.config.llm.safety.maxTokens,
        timeoutMs: this.config.task.timeout.taskTimeoutMs,
        receivedAt: Date.now(),
      };

      const result = await this.agentEngine.executeTask(task, context);

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
