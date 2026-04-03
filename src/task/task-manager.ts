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
import { createDefaultToolRegistry } from '../agent/tool-registry.js';
import { ToolExecutor } from '../agent/tool-executor.js';
import { TaskStateMachine } from './task-state-machine.js';
import { TaskEvaluator } from './task-evaluator.js';
import { ConcurrencyController } from './concurrency.js';
import type {
  Task, TaskResult, TaskExecutionContext, TaskEvaluation, EvaluationContext,
} from '../types/task.js';
import type { PlatformConfig, LLMConfig, SecurityConfig, TaskConfig } from '../core/config.js';
import type { PriceRange } from '../core/config.js';
import type { PermissionLevel } from '../types/agent.js';
import type { ExperienceManager } from '../experience/index.js';
import type { RecurringTaskScheduler } from '../scheduler/recurring-task-scheduler.js';

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
  /** 运行模式: 'public' | 'private' */
  mode?: 'public' | 'private';
  /** 私有虾主人的 botId（从 config 或服务器获取） */
  ownerId?: string;
}

/** 租赁状态 */
export interface RentalState {
  active: boolean;
  rentalId?: string;
  renterId?: string;
  expiresAt?: Date;
  durationHours?: number;
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

  /** 定时任务调度器（由外部注入，私有虾模式） */
  private recurringTaskScheduler: RecurringTaskScheduler | null = null;

  // 消息去重（type + senderId + contentHash → 时间戳）
  private recentMessageKeys = new Map<string, number>();
  private dedupTTL = 60_000; // 60秒内相同消息视为重复
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // 超时管理
  private taskTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // 拒收重试计数器（taskId → 重试次数）
  private rejectionRetryCount = new Map<string, number>();
  private static readonly MAX_REJECTION_RETRIES = 2; // 最多自动重新执行 2 次

  // 仲裁处理去重（避免重复处理同一个仲裁通知）
  private handledArbitrations = new Set<string>();
  private arbitrationCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** 租赁状态 */
  private rentalState: RentalState = { active: false };

  /** 聊天室消息历史（用于冷场检测） */
  private chatHistory: Array<{ botId: string; nickname?: string; content: string; timestamp: number }> = [];
  private chatHistoryMaxSize = 20; // 最多保留20条历史
  private chatSilenceThresholdMs = 10 * 60 * 1000; // 10分钟无消息视为冷场

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

    // Phase 3: 评估器（传入价格配置）
    this.evaluator = new TaskEvaluator(config.task.evaluation, config.task.pricing);

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
    const registry = createDefaultToolRegistry();
    this.toolExecutor = new ToolExecutor(
      registry,
      { security: config.security },
      eventBus,
    );

    this.logger = createLogger('TaskManager');

    // 启动去重缓存定期清理
    this.dedupCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of this.recentMessageKeys) {
        if (now - ts > this.dedupTTL) {
          this.recentMessageKeys.delete(key);
        }
      }
    }, 30_000); // 每30秒清理一次

    // 仲裁处理记录定期清理（24小时后清除）
    this.arbitrationCleanupTimer = setInterval(() => {
      this.handledArbitrations.clear();
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * 处理平台消息
   */
  async handleMessage(message: any): Promise<void> {
    // 0. 消息去重
    const dedupKey = this.buildDedupKey(message);
    if (dedupKey) {
      const now = Date.now();
      const lastSeen = this.recentMessageKeys.get(dedupKey);
      if (lastSeen && now - lastSeen < this.dedupTTL) {
        this.logger.debug('重复消息已忽略', { type: message.type, key: dedupKey.slice(0, 50) });
        return;
      }
      this.recentMessageKeys.set(dedupKey, now);
    }

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

      case 'blog_comment': {
        // 有人评论了自己发的博客
        const blogCommentMsg = message.payload || message.data;
        if (!blogCommentMsg) return;

        this.logger.info(`📝 收到博客评论`, {
          blogId: blogCommentMsg.blogId,
          commenter: blogCommentMsg.commenter?.nickname || blogCommentMsg.commenterId,
          content: blogCommentMsg.content?.substring(0, 50),
        });

        // 异步处理博客评论回复
        this.handleBlogCommentReply(blogCommentMsg).catch(err => {
          this.logger.error('博客评论回复异常', err);
        });
        break;
      }

      case 'blog_reply': {
        // 有人回复了自己在博客下的评论
        const blogReplyMsg = message.payload || message.data;
        if (!blogReplyMsg) return;

        this.logger.info(`📝 收到博客评论回复`, {
          blogId: blogReplyMsg.blogId,
          replier: blogReplyMsg.replier?.nickname || blogReplyMsg.replierId,
          content: blogReplyMsg.content?.substring(0, 50),
        });

        // 回复的回复通常不需要再回，除非有明确问题
        this.handleBlogReplyNotification(blogReplyMsg).catch(err => {
          this.logger.error('博客回复处理异常', err);
        });
        break;
      }

      case 'chat_message': {
        const chatMsg = message.payload;
        if (!chatMsg) {
          this.logger.debug('聊天消息缺少 payload 数据', { type: msgType });
          return;
        }

        // 不回复自己的消息
        if (chatMsg.botId === this.config.platform.botId) {
          return;
        }

        this.logger.info(`💬 收到聊天室消息: ${chatMsg.author?.nickname || chatMsg.botId}: ${chatMsg.content?.substring(0, 50)}`);

        // 异步处理聊天回复（不阻塞消息循环）
        this.handleChatMessageReply(chatMsg).catch(err => {
          this.logger.error('聊天回复异常', err);
        });
        break;
      }

      default:
        this.logger.debug('未处理的交互消息', { type: msgType });
        break;
    }
  }

  /**
   * 处理系统消息（任务拒收、关闭、仲裁等）
   */
  private handleSystemMessage(message: any): void {
    switch (message.type) {
      case 'task_rejected': {
        const payload = message.payload || message.data;
        const taskId = payload?.taskId;
        const reason = payload?.reason || '未提供拒收原因';
        const remainingRevisions = payload?.remainingRevisions ?? 0;

        this.logger.warn(`⚠️ 工作成果被拒收`, {
          taskId,
          reason,
          remainingRevisions,
        });

        // 异步处理拒收（不阻塞消息循环）
        if (taskId) {
          this.handleRejection(taskId, reason, remainingRevisions).catch(err => {
            this.logger.error('拒收处理异常', { taskId, error: (err as Error).message });
          });
        }
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
          this.rejectionRetryCount.delete(taskId);
        }
        break;
      }
      case 'task_arbitration_resolved': {
        const payload = message.payload || message.data;
        this.logger.info(`⚖️ 仲裁结果`, {
          taskId: payload?.taskId,
          result: payload?.result,
        });
        const taskId = payload?.taskId;
        if (taskId) {
          this.stateMachine.cleanup(taskId);
          this.rejectionRetryCount.delete(taskId);
        }
        break;
      }

      case 'task_arbitration_applied': {
        const payload = message.payload || message.data;
        const taskId = payload?.taskId;
        if (taskId && !this.handledArbitrations.has(taskId)) {
          this.handledArbitrations.add(taskId);
          this.logger.info(`⚖️ 收到仲裁通知`, { taskId, message: payload?.message });
          // 异步处理仲裁评审（不阻塞消息循环）
          this.handleArbitrationNotification(taskId).catch(err => {
            this.logger.error('仲裁评审异常', { taskId, error: (err as Error).message });
          });
        }
        break;
      }

      case 'rental_started': {
        const payload = message.payload || message.data;
        const { rentalId, renterId, expiresAt, durationHours } = payload || {};
        this.logger.info(`🔒 租赁模式已激活`, { rentalId, renterId, durationHours, expiresAt });
        this.rentalState = {
          active: true,
          rentalId,
          renterId,
          expiresAt: new Date(expiresAt),
          durationHours,
        };
        this.eventBus.emit(WorkerClawEvent.RENTAL_STARTED as any, {
          rentalId, renterId, expiresAt, durationHours,
        });
        break;
      }

      case 'rental_expired': {
        const payload = message.payload || message.data;
        const { rentalId, reason } = payload || {};
        this.logger.info(`🔓 租赁模式已结束`, { rentalId, reason });
        this.rentalState = { active: false };
        this.eventBus.emit(WorkerClawEvent.RENTAL_EXPIRED as any, {
          rentalId, reason,
          refundAmount: payload?.refundAmount,
          actualCost: payload?.actualCost,
          actualUsedHours: payload?.actualUsedHours,
        });
        break;
      }
      default:
        break;
    }
  }

  /**
   * 处理工作成果被拒收
   *
   * 策略（由 LLM 决策）：
   * 1. remainingRevisions > 0 且重试次数未用完 → 重新执行任务并提交
   * 2. remainingRevisions = 0 或无法修复 → 私信告知发单人，可选择撤销
   * 3. 发单人无理拒收 → 申请仲裁
   */
  private async handleRejection(
    taskId: string,
    reason: string,
    remainingRevisions: number,
  ): Promise<void> {
    const retryCount = this.rejectionRetryCount.get(taskId) || 0;

    this.logger.info(`🔄 处理拒收 [${taskId}]`, {
      reason,
      remainingRevisions,
      retryCount,
    });

    // 先尝试私信发单人表达歉意和沟通意愿
    try {
      const taskDetail = await this.platformApi.getTaskDetail(taskId);
      const posterId = taskDetail?.publisher_id || taskDetail?.posterId;
      const taskTitle = taskDetail?.content || taskDetail?.title || taskId;

      if (posterId) {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          posterId,
          `抱歉，我的工作成果没能满足您的要求 😔\n\n` +
          `拒收原因：${reason}\n` +
          `剩余修改次数：${remainingRevisions}\n\n` +
          `我会认真分析您的要求，争取这次做好！`,
        );
      }
    } catch (err) {
      this.logger.debug('发送歉意私信失败（不影响后续流程）', { error: (err as Error).message });
    }

    // 用 LLM 决定后续行动
    const action = await this.decideRejectionAction(taskId, reason, remainingRevisions, retryCount);

    this.logger.info(`🧠 LLM 决策 [${taskId}]: ${action.action}`, {
      confidence: action.confidence,
      reasoning: action.reasoning,
    });

    switch (action.action) {
      case 'resubmit': {
        // 重新执行任务并提交
        if (retryCount >= TaskManager.MAX_REJECTION_RETRIES) {
          this.logger.warn(`已达最大重试次数 [${taskId}]，放弃重新执行`);
          await this.notifyCannotFix(taskId, reason, remainingRevisions);
          return;
        }

        this.rejectionRetryCount.set(taskId, retryCount + 1);
        this.logger.info(`🔄 重新执行任务 [${taskId}] (第 ${retryCount + 1}/${TaskManager.MAX_REJECTION_RETRIES} 次)`);

        // 重新获取任务详情
        const taskDetail = await this.platformApi.getTaskDetail(taskId);
        if (!taskDetail) {
          this.logger.error(`无法获取任务详情 [${taskId}]，跳过重试`);
          return;
        }

        // 重建 Task 对象
        const task: Task = {
          taskId: taskDetail.id || taskId,
          taskType: 'other',
          title: taskDetail.title || taskDetail.content?.substring(0, 50) || '重新执行',
          description: `【修改要求】${reason}\n\n【原始任务】${taskDetail.content || ''}`,
          posterId: taskDetail.publisher_id || taskDetail.posterId || 'unknown',
          posterName: taskDetail.publisher_name || taskDetail.publisherName,
          reward: taskDetail.reward,
          deadline: taskDetail.deadline,
          images: taskDetail.images || [],
          createdAt: taskDetail.created_at || taskDetail.createdAt || new Date().toISOString(),
          raw: taskDetail,
        };

        // 重新执行
        const permLevel = this.determinePermissionLevel(task);
        this.stateMachine.tryTransition(taskId, 'running', '拒收后重新执行');
        this.concurrency.tryStart(task);

        try {
          const context: TaskExecutionContext = {
            task,
            permissionLevel: permLevel,
            maxOutputTokens: this.config.llm.safety.maxTokens,
            timeoutMs: this.config.task.timeout.taskTimeoutMs,
            receivedAt: Date.now(),
          };

          const result = await this.agentEngine.executeTask(task, context);
          await this.reportResult(task, result);
          this.logger.info(`✅ 重新执行完成 [${taskId}]`, { status: result.status });
        } catch (err) {
          this.logger.error(`重新执行失败 [${taskId}]`, { error: (err as Error).message });
        } finally {
          this.concurrency.taskFinished(taskId);
        }
        break;
      }

      case 'apologize_and_wait':
        // 已经通知过发单人了，等发单人进一步指示
        this.logger.info(`📝 等待发单人进一步指示 [${taskId}]`);
        break;

      case 'arbitrate': {
        // 申请仲裁
        this.logger.info(`⚖️ 申请仲裁 [${taskId}]`);
        const arbResult = await this.platformApi.applyArbitration(taskId);
        if (arbResult.success) {
          this.logger.info(`✅ 仲裁申请成功 [${taskId}]`);
        } else {
          this.logger.warn(`仲裁申请失败 [${taskId}]`, { error: arbResult.error });
        }
        break;
      }

      case 'cancel': {
        // 撤销任务
        this.logger.info(`🗑️ 撤销任务 [${taskId}]`);
        const cancelResult = await this.platformApi.cancelTake(taskId);
        if (cancelResult.success) {
          this.logger.info(`✅ 已撤销任务 [${taskId}]`);
          this.stateMachine.tryTransition(taskId, 'cancelled', '拒收后协商撤销');
        } else {
          this.logger.warn(`撤销任务失败 [${taskId}]`, { error: cancelResult.error });
        }
        break;
      }

      default:
        this.logger.warn(`未知的拒收处理动作 [${taskId}]: ${action.action}`);
        break;
    }
  }

  /**
   * LLM 决定拒收后的行动
   */
  private async decideRejectionAction(
    taskId: string,
    reason: string,
    remainingRevisions: number,
    retryCount: number,
  ): Promise<{ action: string; confidence: number; reasoning: string }> {
    try {
      const systemPrompt = `你是一个 AI Agent，你的工作成果刚刚被任务发单人拒收了。
你需要分析拒收原因，决定下一步行动。

可选行动（只选一个）：
1. resubmit - 重新执行任务并提交（仅在拒收原因明确、可以改进时选择）
2. apologize_and_wait - 道歉并等待发单人进一步指示（拒收原因不明确或无法自动修复时）
3. arbitrate - 申请平台仲裁（认为发单人无理拒收、拒收理由不合理时）
4. cancel - 撤销任务放弃执行（拒收原因超出了你的能力范围时）

判断原则：
- 如果发单人给出了明确的修改意见，且你有能力改进，选择 resubmit
- 如果拒收理由模糊（如"不满意""质量不好"但没说具体哪里不好），选择 apologize_and_wait
- 如果你的工作成果明显符合要求，但发单人无理拒收，选择 arbitrate
- 如果任务要求超出你的能力（如需要特定软件、特殊权限等），选择 cancel
- 已经重试过 ${retryCount} 次了，如果多次被拒，倾向于放弃

请严格按以下 JSON 格式输出，不要输出其他内容：
{"action": "resubmit|apologize_and_wait|arbitrate|cancel", "confidence": 0.0到1.0, "reasoning": "简要决策理由（30字以内）"}`;

      const result = await this.agentEngine.generateReply(
        systemPrompt,
        `任务ID: ${taskId}\n拒收原因: ${reason}\n剩余修改次数: ${remainingRevisions}\n已重试次数: ${retryCount}`,
      );

      if (result) {
        const jsonMatch = result.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const validActions = ['resubmit', 'apologize_and_wait', 'arbitrate', 'cancel'];
          if (parsed.action && validActions.includes(parsed.action)) {
            return {
              action: parsed.action,
              confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
              reasoning: parsed.reasoning || 'LLM 决策',
            };
          }
        }
      }
    } catch (err) {
      this.logger.error('LLM 拒收决策失败', { error: (err as Error).message });
    }

    // 降级策略：remainingRevisions > 0 → resubmit，否则 → apologize_and_wait
    const fallbackAction = remainingRevisions > 0 && retryCount < TaskManager.MAX_REJECTION_RETRIES
      ? 'resubmit'
      : 'apologize_and_wait';
    return { action: fallbackAction, confidence: 0.3, reasoning: 'LLM 决策失败，使用降级策略' };
  }

  /**
   * 通知发单人无法修复（已用完重试次数或确实做不到）
   */
  private async notifyCannotFix(taskId: string, reason: string, remainingRevisions: number): Promise<void> {
    try {
      const taskDetail = await this.platformApi.getTaskDetail(taskId);
      const posterId = taskDetail?.publisher_id || taskDetail?.posterId;

      if (posterId) {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          posterId,
          `非常抱歉，经过多次尝试，我仍然无法满足您的要求 😔\n\n` +
          `拒收原因：${reason}\n` +
          `剩余修改次数：${remainingRevisions}\n\n` +
          `如果您觉得我的能力确实无法完成这个任务，建议您可以：\n` +
          `1. 取消任务重新发布给其他打工虾\n` +
          `2. 给我更具体的修改建议，我可以再试一次\n\n` +
          `给您带来不便，深表歉意！`,
        );
      }
    } catch (err) {
      this.logger.debug('发送无法修复通知失败', { error: (err as Error).message });
    }
  }
  private async handlePrivateMessageReply(privateMsg: any, rawMessage: any): Promise<void> {
    try {
      const personality = this.config.personality;
      const senderName = privateMsg.sender?.nickname || '用户';
      const content = privateMsg.content || '';

      // === 私有虾模式：分流处理 ===
      if (this.isPrivateMode()) {
        // 不处理自己的消息（已在上面检查过，这里双重保险）
        if (privateMsg.sender_id === this.config.platform.botId) {
          return;
        }

        if (this.isOwner(privateMsg.sender_id)) {
          // 主人：直接执行指令
          await this.handleOwnerDirectMessage(privateMsg.sender_id, content);
        } else {
          // 外部人员：礼貌拒绝
          await this.handlePrivateExternalMessage(privateMsg);
        }
        return; // 私有虾处理完毕，不走下面的打工虾逻辑
      }

      // === 以下是打工虾（公域模式）的正常逻辑 ===

      // 0. 任务选择操作检测（如"取消1"、"取消全部"）
      const selectMatch = content.match(/^取消\s*(\d+|全部|所有)/);
      if (selectMatch) {
        const selection = selectMatch[1];
        const cancelResult = await this.handleCancelSelection(selection, privateMsg.sender_id);
        if (cancelResult) {
          await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            privateMsg.sender_id,
            cancelResult,
          );
          return;
        }
      }

      // 1. 单次 LLM 调用：意图检测 + 回复生成
      const botName = personality.name || '打工虾';
      const basePrompt = personality.customSystemPrompt ||
        `你是${botName}，智工坊平台上的一名打工虾，语气${personality.tone || '友好热情'}。` +
        (personality.bio ? `\n简介：${personality.bio}` : '');

      const intentSystemPrompt = basePrompt + `

【私信处理规则】
你需要分析用户消息，判断意图并给出回复。

可能的意图：
- cancel_task: 用户想取消/撤销/放弃任务
- check_progress: 用户想查任务进度/状态
- price_inquiry: 用户询问价格/费用/报酬
- null: 普通闲聊或任务需求咨询

返回严格的 JSON 格式（不要输出其他内容）：
{
  "intent": "cancel_task" 或 "check_progress" 或 "price_inquiry" 或 null,
  "reply": "给用户的回复文本（1-3句话，自然友好）"
}

【重要规则】
- 如果检测到 cancel_task/check_progress/price_inquiry，reply 可以为空，系统会自动处理意图。
- 如果 intent 为 null，reply 必须有内容，用于回复用户。
- 对方提出任务需求时（如"帮我做XX"），引导对方发任务："这个我会做！你可以发个任务给我，我接了就开始干活～"
- 对方只是闲聊问候，正常友好回复即可。
- 只输出 JSON，不要加 markdown 代码块标记。`;

      // 调用 LLM 获取意图和回复
      const llmResult = await this.agentEngine.generateReply(
        intentSystemPrompt,
        `用户私信: "${content}"`,
      );

      if (!llmResult) {
        this.logger.warn('LLM 返回空结果');
        return;
      }

      // 解析 JSON 响应
      let parsed: { intent: string | null; reply: string } = { intent: null, reply: '' };
      try {
        // 尝试提取 JSON（可能被 markdown 包裹）
        const jsonMatch = llmResult.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        }
      } catch (parseErr) {
        this.logger.warn('解析 LLM 响应失败，作为普通回复处理', { raw: llmResult.substring(0, 100) });
        parsed = { intent: null, reply: llmResult };
      }

      this.logger.info(`🔍 意图检测结果: ${parsed.intent || 'null'}`);

      // 2. 处理意图
      if (parsed.intent) {
        const intentResult = await this.executeIntent(parsed.intent, content, privateMsg.sender_id);
        if (intentResult) {
          // 意图已执行，发送系统生成的回复
          const sendResult = await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            privateMsg.sender_id,
            intentResult.message,
          );
          if (sendResult.success) {
            this.logger.info(`💌 意图回复已发送 → ${senderName}: ${intentResult.message.substring(0, 50)}`);
          }
          return;
        }
      }

      // 3. 没有意图或意图执行失败，使用 LLM 生成的回复
      if (parsed.reply) {
        const sendResult = await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          privateMsg.sender_id,
          parsed.reply,
        );
        if (sendResult.success) {
          this.logger.info(`💌 已回复私信 → ${senderName}: ${parsed.reply.substring(0, 50)}`);
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
   * 处理公共聊天室消息回复
   * 使用 LLM 生成自然回复，支持 @提及和闲聊
   * 
   * 改进：
   * 1. 被 @ 时直接回复
   * 2. 未被 @ 时，如果群聊冷场（10分钟无消息/无互动），一定概率参与
   */
  private async handleChatMessageReply(chatMsg: any): Promise<void> {
    try {
      // 私有虾不参与公共聊天室
      if (this.isPrivateMode()) {
        return;
      }

      const personality = this.config.personality;
      const senderName = chatMsg.author?.nickname || `用户${(chatMsg.botId || '').substring(0, 6)}`;
      const content = chatMsg.content || '';
      const botId = this.config.platform.botId;

      // 记录聊天历史（用于冷场检测）
      this.recordChatHistory(chatMsg);

      // 检查是否 @ 了自己（内容包含 botId 或 bot 名称）
      const botName = personality.name || '打工虾';
      const isMentioned = content.includes(botId) ||
        content.includes(`@${botName}`) ||
        content.includes(botName);

      // 判断是否应该回复
      let shouldReply = false;
      let replyReason = '';

      if (isMentioned) {
        // 被 @ 时直接回复
        shouldReply = true;
        replyReason = '被@提及';
      } else {
        // 未被 @ 时，检测冷场
        const silenceCheck = this.checkChatSilence();
        if (silenceCheck.isSilent) {
          // 冷场时有 30% 概率参与
          const randomChance = Math.random();
          if (randomChance < 0.3) {
            shouldReply = true;
            replyReason = `冷场参与（已${silenceCheck.silentMinutes}分钟无互动）`;
          } else {
            this.logger.debug(`聊天室冷场但本次不参与（概率未命中）`, {
              silentMinutes: silenceCheck.silentMinutes,
            });
          }
        }
      }

      if (!shouldReply) {
        this.logger.debug('聊天消息未 @ 自己且非冷场，跳过回复');
        return;
      }

      this.logger.info(`💬 准备回复聊天室 [${replyReason}]`, { sender: senderName });

      // 构建最近聊天上下文（让回复更自然，能接话而非自顾自说）
      const recentContext = this.chatHistory
        .slice(-6) // 最近6条（含当前消息）
        .map(m => `${m.nickname || '某人'}: ${m.content}`)
        .join('\n');

      // 构建 LLM prompt
      const systemPrompt = personality.customSystemPrompt ||
        `你是${botName}，智工坊平台上的一名打工虾，语气${personality.tone || '友好热情'}。` +
        (personality.bio ? `\n简介：${personality.bio}` : '') +
        `\n\n【聊天室回复规则】
- 你在公共聊天室中，所有人都能看到你的回复，所以保持简洁有趣。
- 回复自然、友好，1-3句话即可。
- 如果有人问你能做什么，简要介绍能力，建议对方发任务给你。
- 如果有人直接给你任务（不是在聊天室里问），引导对方通过私信或发单给你。
- 一定要针对最近聊天上下文接话回应，不要自顾自起新话题！
- 只输出回复内容，不要加引号或前缀。`;

      const result = await this.agentEngine.generateReply(
        systemPrompt,
        `聊天室最近对话：\n${recentContext}\n\n${isMentioned ? '你被@了，请回复。' : '你是主动参与话题，请针对以上对话自然接话。'}\n注意：不要在回复中加@或提及对方名字（会自动添加）。`,
      );

      if (result) {
        // 冷场参与接话时，自动 @ 消息发送者
        const finalContent = (!isMentioned && senderName) ? `@${senderName} ${result}` : result;
        const sendResult = await this.platformApi.sendChatMessage(finalContent);
        if (sendResult.success) {
          this.logger.info(`💬 已回复聊天室 → ${senderName}: ${finalContent.substring(0, 50)}`);
        } else {
          this.logger.warn(`💬 聊天室回复失败`, { error: sendResult.error });
        }
      } else {
        this.logger.debug('聊天室回复为空，跳过回复');
      }
    } catch (err) {
      this.logger.error('聊天室回复处理异常', err);
    }
  }

  /**
   * 记录聊天历史
   */
  private recordChatHistory(chatMsg: any): void {
    this.chatHistory.push({
      botId: chatMsg.botId,
      nickname: chatMsg.author?.nickname,
      content: chatMsg.content || '',
      timestamp: Date.now(),
    });

    // 限制历史长度
    if (this.chatHistory.length > this.chatHistoryMaxSize) {
      this.chatHistory.shift();
    }
  }

  /**
   * 检测聊天室冷场
   * 冷场条件：
   * 1. 最近10分钟内没有消息（包括自己的）
   * 2. 或者最近10分钟内的消息都是单方面的（没有相互@或互动）
   */
  private checkChatSilence(): { isSilent: boolean; silentMinutes: number } {
    const now = Date.now();
    const threshold = now - this.chatSilenceThresholdMs;

    // 获取最近10分钟内的消息
    const recentMessages = this.chatHistory.filter(m => m.timestamp >= threshold);

    if (recentMessages.length === 0) {
      // 没有最近消息，根据上一条消息时间判断
      if (this.chatHistory.length === 0) {
        return { isSilent: false, silentMinutes: 0 }; // 没有历史，无法判断
      }
      const lastMsg = this.chatHistory[this.chatHistory.length - 1];
      const silentMinutes = Math.floor((now - lastMsg.timestamp) / 60000);
      return { isSilent: silentMinutes >= 10, silentMinutes };
    }

    // 检查是否有互动（消息之间有@或回复）
    let hasInteraction = false;
    for (let i = 1; i < recentMessages.length; i++) {
      const prev = recentMessages[i - 1];
      const curr = recentMessages[i];
      // 不同人发言 且 内容包含对方名字或@ = 有互动
      if (prev.botId !== curr.botId) {
        if (curr.content.includes(prev.nickname || '') ||
            curr.content.includes(`@${prev.nickname || ''}`) ||
            curr.content.includes(prev.botId)) {
          hasInteraction = true;
          break;
        }
      }
    }

    if (!hasInteraction && recentMessages.length < 3) {
      // 消息少且无互动，视为冷场
      return { isSilent: true, silentMinutes: 10 };
    }

    return { isSilent: false, silentMinutes: 0 };
  }

  /**
   * 获取聊天室最近历史（供行为调度器使用，实现接话而非自顾自发）
   * @param maxAgeMs 只返回最近 N 毫秒内的消息
   */
  getChatHistory(maxAgeMs = 5 * 60 * 1000): Array<{ botId: string; nickname?: string; content: string; timestamp: number }> {
    const now = Date.now();
    const threshold = now - maxAgeMs;
    return this.chatHistory.filter(m => m.timestamp >= threshold);
  }

  /**
   * 处理博客评论回复
   * 
   * 当有人评论自己发的博客时，决定是否回复：
   * 1. 如果评论包含问题 → 应该回复
   * 2. 如果评论是认同/夸奖 → 可以简单感谢
   * 3. 如果评论是反驳/批评 → 看情况回复
   */
  private async handleBlogCommentReply(commentMsg: any): Promise<void> {
    try {
      const personality = this.config.personality;
      const blogId = commentMsg.blogId;
      const commentId = commentMsg.commentId || commentMsg.id;
      const commenterName = commentMsg.commenter?.nickname || '用户';
      const commentContent = commentMsg.content || '';
      const botName = personality.name || '打工虾';

      // 使用 LLM 判断是否需要回复
      const systemPrompt = personality.customSystemPrompt ||
        `你是${botName}，智工坊平台上的一名打工虾，语气${personality.tone || '友好热情'}。` +
        (personality.bio ? `\n简介：${personality.bio}` : '') +
        `\n\n【博客评论回复规则】
- 有人评论了你的博客，你需要决定是否回复。
- 如果评论包含问题、质疑或需要澄清的内容，应该回复。
- 如果评论是认同、夸奖或简单的表情，可以回复感谢或跳过。
- 回复要自然、友好，1-2句话即可。
- 只输出 JSON 格式：{"shouldReply": true/false, "reply": "回复内容（如果shouldReply为true）"}
- 不需要回复时，shouldReply 设为 false，reply 可为空。`;

      const llmResult = await this.agentEngine.generateReply(
        systemPrompt,
        `你的博客收到一条评论：\n评论者：${commenterName}\n内容：${commentContent}\n\n请判断是否需要回复。`,
      );

      if (!llmResult) {
        this.logger.debug('博客评论回复 LLM 返回空，跳过');
        return;
      }

      // 解析 JSON
      const jsonMatch = llmResult.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        this.logger.debug('博客评论回复 LLM 返回格式错误', { result: llmResult.substring(0, 100) });
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.shouldReply || !parsed.reply) {
        this.logger.debug('博客评论不需要回复或回复为空');
        return;
      }

      // 发送回复
      const replyResult = await this.platformApi.postBlogComment(blogId, parsed.reply, commentId);
      if (replyResult.success) {
        this.logger.info(`📝 已回复博客评论 → ${commenterName}: ${parsed.reply.substring(0, 50)}`);
      } else {
        this.logger.warn('博客评论回复发送失败', { error: replyResult.error });
      }
    } catch (err) {
      this.logger.error('博客评论回复处理异常', err);
    }
  }

  /**
   * 处理博客回复的通知（有人回复了自己在博客下的评论）
   * 
   * 回复的回复通常不需要再回，除非有明确问题
   */
  private async handleBlogReplyNotification(replyMsg: any): Promise<void> {
    try {
      const replyContent = replyMsg.content || '';
      const replierName = replyMsg.replier?.nickname || '用户';
      const blogId = replyMsg.blogId;
      const parentCommentId = replyMsg.parentId || replyMsg.commentId;

      // 简单检查是否包含问题
      const hasQuestion = replyContent.includes('?') ||
                          replyContent.includes('？') ||
                          replyContent.includes('吗') ||
                          replyContent.includes('怎么') ||
                          replyContent.includes('如何') ||
                          replyContent.includes('为什么');

      if (!hasQuestion) {
        this.logger.debug('博客回复不包含问题，不需要再回复');
        return;
      }

      // 包含问题，需要回复
      const personality = this.config.personality;
      const botName = personality.name || '打工虾';

      const systemPrompt = personality.customSystemPrompt ||
        `你是${botName}，智工坊平台上的一名打工虾，语气${personality.tone || '友好热情'}。` +
        (personality.bio ? `\n简介：${personality.bio}` : '') +
        `\n\n【博客回复规则】
- 有人回复了你的评论，并且提出了问题，你需要回复。
- 回复要简洁、直接回答问题，1-2句话即可。
- 只输出回复内容，不要加引号或前缀。`;

      const replyContent_generated = await this.agentEngine.generateReply(
        systemPrompt,
        `${replierName} 回复你的评论说：${replyContent}`,
      );

      if (!replyContent_generated) {
        this.logger.debug('博客回复生成失败');
        return;
      }

      // 发送回复
      const sendResult = await this.platformApi.postBlogComment(blogId, replyContent_generated, parentCommentId);
      if (sendResult.success) {
        this.logger.info(`📝 已回复博客回复 → ${replierName}: ${replyContent_generated.substring(0, 50)}`);
      } else {
        this.logger.warn('博客回复发送失败', { error: sendResult.error });
      }
    } catch (err) {
      this.logger.error('博客回复通知处理异常', err);
    }
  }

  /**
   * 处理任务取消选择（"取消1"、"取消全部"）
   * @returns 回复消息，null 表示无效选择
   */
  private async handleCancelSelection(selection: string, senderId: string): Promise<string | null> {
    const taskIds = this.stateMachine.getActiveTaskIds();
    const cancellableTasks: Array<{ id: string; status: string; data?: any }> = [];

    for (const taskId of taskIds) {
      const status = this.stateMachine.getStatus(taskId);
      if (status === 'accepted' || status === 'evaluating') {
        const metadata = this.stateMachine.getMetadata(taskId);
        cancellableTasks.push({
          id: taskId,
          status: status || 'unknown',
          data: metadata?.originalData,
        });
      }
    }

    if (cancellableTasks.length === 0) {
      return '没有可取消的任务了。';
    }

    // 取消全部
    if (selection === '全部' || selection === '所有') {
      let cancelled = 0;
      let failed = 0;
      for (const task of cancellableTasks) {
        const result = await this.platformApi.cancelTake(task.id);
        if (result.success) {
          this.stateMachine.tryTransition(task.id, 'cancelled', '用户通过私信批量取消');
          cancelled++;
        } else {
          failed++;
        }
      }
      if (failed === 0) {
        return `✅ 已取消全部 ${cancelled} 个任务。`;
      }
      return `已取消 ${cancelled} 个任务，${failed} 个取消失败。`;
    }

    // 按序号取消
    const index = parseInt(selection, 10) - 1;
    if (isNaN(index) || index < 0 || index >= cancellableTasks.length) {
      return `无效的序号，请输入 1-${cancellableTasks.length} 或"取消全部"。`;
    }

    const task = cancellableTasks[index];
    const cancelResult = await this.platformApi.cancelTake(task.id);
    if (cancelResult.success) {
      this.stateMachine.tryTransition(task.id, 'cancelled', '用户通过私信选择取消');
      const taskDesc = task.data?.content?.substring(0, 30) || '任务';
      return `✅ 已取消任务：${taskDesc}...`;
    }
    return `取消失败: ${cancelResult.error || '未知错误'}`;
  }

  /**
   * 执行已识别的意图（由 LLM 返回的意图）
   *
   * 返回: { action, message } 或 null
   */
  private async executeIntent(
    intent: string,
    content: string,
    senderId: string,
  ): Promise<{ action: string; message: string } | null> {
    try {
      // 执行意图
      if (intent === 'cancel_task') {
        // 查找已接单但未完成的任务（accepted 或 evaluating 状态）
        const taskIds = this.stateMachine.getActiveTaskIds();
        const cancellableTasks: Array<{ id: string; status: string; data?: any }> = [];

        for (const taskId of taskIds) {
          const status = this.stateMachine.getStatus(taskId);
          // 只取消 accepted 或 evaluating 状态的任务（未开始执行）
          if (status === 'accepted' || status === 'evaluating') {
            const metadata = this.stateMachine.getMetadata(taskId);
            cancellableTasks.push({
              id: taskId,
              status: status || 'unknown',
              data: metadata?.originalData,
            });
          }
        }

        if (cancellableTasks.length === 0) {
          // 检查是否有正在执行的任务
          const runningCount = taskIds.filter(id => {
            const s = this.stateMachine.getStatus(id);
            return s === 'running';
          }).length;

          if (runningCount > 0) {
            return {
              action: 'cancel_task',
              message: `我目前有 ${runningCount} 个任务正在执行中，无法中途取消。\n\n如需取消，请联系平台客服或在任务完成后拒收。`,
            };
          }
          return { action: 'cancel_task', message: '我目前没有已接单但未执行的任务可以撤销。' };
        }

        // 如果只有一个可取消的任务，直接取消
        if (cancellableTasks.length === 1) {
          const task = cancellableTasks[0];
          const cancelResult = await this.platformApi.cancelTake(task.id);
          if (cancelResult.success) {
            this.stateMachine.tryTransition(task.id, 'cancelled', '用户通过私信取消');
            const taskDesc = task.data?.content?.substring(0, 30) || '任务';
            return {
              action: 'cancel_task',
              message: `✅ 已取消任务：${taskDesc}...\n\n如果您有其他需求，随时可以发新任务给我！`,
            };
          }
          return { action: 'cancel_task', message: `取消失败: ${cancelResult.error || '未知错误'}` };
        }

        // 多个任务：列出供用户选择
        const taskList = cancellableTasks
          .map((t, i) => `${i + 1}. ${t.data?.content?.substring(0, 30) || t.id}...`)
          .join('\n');

        return {
          action: 'cancel_task',
          message: `📋 您有 ${cancellableTasks.length} 个已接单但未执行的任务：\n\n${taskList}\n\n请回复序号（如"取消1"）或"取消全部"来取消对应任务。`,
        };
      }

      if (intent === 'check_progress') {
        const status = this.getStatus();
        if (status.runningTasks > 0) {
          return {
            action: 'check_progress',
            message: `📋 任务进度查询\n\n目前有 ${status.runningTasks} 个任务正在执行中，请稍等，完成后会自动通知你～`,
          };
        }
        if (status.queuedTasks > 0) {
          return {
            action: 'check_progress',
            message: `📋 任务进度查询\n\n有 ${status.queuedTasks} 个任务在排队等待执行，马上就轮到了～`,
          };
        }
        return { action: 'check_progress', message: '目前没有正在执行中的任务哦，您可以随时发任务给我！' };
      }

      if (intent === 'price_inquiry') {
        // 价格咨询 → 转到专门的估价处理
        const priceReply = await this.handlePriceInquiry(content);
        return { action: 'price_inquiry', message: priceReply };
      }

      return null;
    } catch (err) {
      this.logger.error('意图执行异常', { error: (err as Error).message });
      return null;
    }
  }

  /**
   * 处理价格咨询/讨价还价
   *
   * 策略：
   * - 用户描述了需求 → 基于任务类型估价，给出价格区间
   * - 用户只问价没说需求 → 反问需求再估价
   * - 用户给了一个价格还价 → 评估是否合理
   */
  private async handlePriceInquiry(content: string): Promise<string> {
    try {
      const botName = this.config.personality.name || '打工虾';

      // 先用 LLM 分析用户的意图和具体需求
      const analysisPrompt = `你是${botName}，一个 AI Agent 助手。用户在询问任务价格。
请分析用户的消息，提取以下信息：

1. 用户是否提到了具体的任务需求（如"做个PPT"、"找个图片"、"翻译一段话"）
2. 用户是否给出了自己的出价（如"5块行不行"、"我出10元"）
3. 任务的复杂度描述（如"简单的"、"详细的"、"专业的"）

返回严格JSON格式，不要输出其他内容：
{"hasSpecificTask": true或false, "taskDescription": "提取的任务描述或null", "userOffer": 用户出价的分（整数）或null, "complexityHint": "simple"或"normal"或"complex"或null}`;

      const analysis = await this.agentEngine.generateReply(
        analysisPrompt,
        `用户消息: "${content}"`,
      );

      let parsed: { hasSpecificTask?: boolean; taskDescription?: string | null; userOffer?: number | null; complexityHint?: string | null } = {};
      if (analysis) {
        const jsonMatch = analysis.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        }
      }

      // 情况 A: 用户有具体任务需求
      if (parsed.hasSpecificTask && parsed.taskDescription) {
        // 从描述推断任务类型
        const inferredType = this.inferTaskTypeForPricing(parsed.taskDescription);
        const estimate = this.evaluator.estimatePrice(inferredType, parsed.taskDescription);

        // 转换为元显示
        const minYuan = (estimate.min / 100).toFixed(2);
        const maxYuan = (estimate.max / 100).toFixed(2);
        const suggestedYuan = (estimate.suggested / 100).toFixed(2);

        // 如果用户出了价，评估是否合理
        if (parsed.userOffer && parsed.userOffer > 0) {
          return this.evaluateUserOffer(parsed.userOffer, estimate, parsed.taskDescription);
        }

        // 没有出价，给出估价
        const replyPrompt = `你是${botName}，语气${this.config.personality.tone || '友好热情'}。
用户想了解某个任务的价格，你刚做了一个估价。

估价结果：
- 任务类型: ${estimate.type}
- 价格区间: ¥${minYuan} - ¥${maxYuan}
- 建议价: ¥${suggestedYuan}
- 估价理由: ${estimate.reasoning}

请用自然、友好的方式告诉用户这个估价，并引导用户发任务。
要求：
1. 不要显得像机器人报数字，要自然地说出来
2. 提到价格只是一个参考，具体看需求
3. 引导用户通过"新建任务"发给你
4. 回复1-3句话，简洁自然
5. 只输出回复内容，不要加引号`;

        const reply = await this.agentEngine.generateReply(replyPrompt, '');
        return reply || `这个任务大概 ¥${minYuan} 到 ¥${maxYuan} 左右～你可以在聊天窗口点"新建任务"发给我，我接了就能开始！`;
      }

      // 情况 B: 用户只问了价格，没说具体需求
      const genericReplyPrompt = `你是${botName}，语气${this.config.personality.tone || '友好热情'}。
用户在问"要多少钱"/"什么价格"，但没有说明具体要做什么任务。

请自然地反问用户想做什么，表示价格取决于具体需求。
例如可以问：你想做什么呀？是找图片、写文章、翻译还是别的？你说说需求，我给你估个价～

要求：
1. 不要列清单式地列举所有可能，太长了
2. 自然友好，1-2句话
3. 只输出回复内容，不要加引号`;

      const reply = await this.agentEngine.generateReply(genericReplyPrompt, '');
      return reply || '这得看你具体要做什么呀～你描述一下需求，我给你估个价！';
    } catch (err) {
      this.logger.error('价格咨询处理异常', { error: (err as Error).message });
      return '价格要看具体需求哦～你先说说想做什么，我给你估个价！';
    }
  }

  /**
   * 评估用户出价是否合理，生成讨价还价回复
   */
  private async evaluateUserOffer(
    userOfferCents: number,
    estimate: ReturnType<TaskEvaluator['estimatePrice']>,
    taskDescription: string,
  ): Promise<string> {
    const botName = this.config.personality.name || '打工虾';
    const offerYuan = (userOfferCents / 100).toFixed(2);
    const minYuan = (estimate.min / 100).toFixed(2);
    const maxYuan = (estimate.max / 100).toFixed(2);
    const suggestedYuan = (estimate.suggested / 100).toFixed(2);

    let judgment: string;
    if (userOfferCents >= estimate.min) {
      judgment = 'reasonable'; // 合理或偏高
    } else if (userOfferCents >= estimate.min * 0.5) {
      judgment = 'negotiable'; // 偏低但可以商量
    } else {
      judgment = 'too_low'; // 太低了
    }

    const replyPrompt = `你是${botName}，语气${this.config.personality.tone || '友好热情'}。
用户想用 ¥${offerYuan} 做 "${taskDescription}" 这个任务。

你的估价：
- 价格区间: ¥${minYuan} - ¥${maxYuan}
- 建议价: ¥${suggestedYuan}

判断：${judgment === 'reasonable' ? '用户的出价合理甚至偏高' : judgment === 'negotiable' ? '用户的出价偏低，但可以商量' : '用户的出价远低于合理价格'}

回复策略：
${judgment === 'reasonable' ? '- 直接答应，表示没问题，引导发任务' : ''}
${judgment === 'negotiable' ? '- 委婉说明这个价格可能不太够，但如果任务比较简单可以试试，引导发任务' : ''}
${judgment === 'too_low' ? '- 礼貌说明价格太低做不了，给出合理价格范围，但语气要友好不伤和气' : ''}

要求：
1. 自然友好，不要像机器报价
2. 1-3句话
3. ${judgment === 'too_low' ? '可以适当解释为什么这个价格做不了' : ''}
4. ${judgment !== 'too_low' ? '引导用户发任务' : ''}
5. 只输出回复内容，不要加引号`;

    const reply = await this.agentEngine.generateReply(replyPrompt, '');
    return reply || '这个价格可能不太合适哦，要不你发个任务过来，具体聊聊？';
  }

  /**
   * 从描述推断任务类型（用于估价）
   */
  private inferTaskTypeForPricing(description: string): string {
    const desc = description.toLowerCase();

    if (/图|画|壁纸|头像|背景|截图|照片|logo|海报/.test(desc)) return 'image_gen';
    if (/写.*文章|写.*文案|写.*脚本|写.*帖子|写作|文案|小说|故事|报告/.test(desc)) return 'writing';
    if (/翻译|英文|中文|日文|韩文|translate/.test(desc)) return 'translation';
    if (/搜索|查找|调研|搜集|资料|搜.*信息|找.*信息|查一下/.test(desc)) return 'search_summary';
    if (/分析|统计|数据|图表|报表|计算/.test(desc)) return 'data_analysis';
    if (/代码|编程|开发|程序|网站|网页|app|接口|api/.test(desc)) return 'code_dev';
    if (/回答|问题|解释|说明|聊天|对话/.test(desc)) return 'qa';
    if (/回复|回信|消息|评论/.test(desc)) return 'text_reply';

    return 'other';
  }

  /**
   * 仲裁评审核心方法
   * 收到仲裁通知后：获取详情 → LLM 分析 → 投票或弃权
   */
  private async handleArbitrationNotification(taskId: string): Promise<void> {
    try {
      // 等待一小段时间避免和服务端写入冲突
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 1. 获取仲裁详情
      const detail = await this.platformApi.getArbitrationDetail(taskId);
      if (!detail || !detail.success) {
        this.logger.debug('获取仲裁详情失败或无数据', { taskId });
        return;
      }

      // 2. 检查是否已经投过票
      if (detail.myVote) {
        this.logger.debug('已投过票，跳过', { taskId, myVote: detail.myVote });
        return;
      }

      // 3. 检查仲裁状态
      if (detail.dispute?.arbitration_status !== 'voting') {
        this.logger.debug('仲裁不在投票阶段', { taskId, status: detail.dispute?.arbitration_status });
        return;
      }

      // 4. 检查票数是否已满
      if (detail.votes && detail.votes.length >= 3) {
        this.logger.debug('仲裁票数已满', { taskId, voteCount: detail.votes.length });
        return;
      }

      // 5. 构建仲裁信息摘要
      const summary = this.buildArbitrationSummary(detail);
      this.logger.info(`⚖️ 开始仲裁评审`, {
        taskId,
        taskPreview: summary.taskPreview,
        publisherVotes: detail.votes?.filter((v: any) => v.vote === 'publisher').length || 0,
        takerVotes: detail.votes?.filter((v: any) => v.vote === 'taker').length || 0,
      });

      // 6. LLM 分析并决定投票
      const decision = await this.decideArbitrationVote(summary);

      if (!decision) {
        this.logger.info(`⚖️ 放弃仲裁投票 [${taskId}]（无法做出判断）`);
        return;
      }

      // 7. 执行投票
      const voteResult = await this.platformApi.voteArbitration(taskId, decision.vote, decision.comment);
      if (voteResult.success) {
        this.logger.info(
          `⚖️ 仲裁投票完成 [${taskId}]: ${decision.vote === 'publisher' ? '支持发单人' : '支持接单人'}` +
          (voteResult.voteCount ? ` (当前 ${voteResult.voteCount}/${voteResult.totalNeeded} 票)` : ''),
          { reasoning: decision.reasoning },
        );
      } else {
        this.logger.warn(`⚖️ 仲裁投票失败 [${taskId}]`, { error: voteResult.error });
      }
    } catch (err) {
      this.logger.error('仲裁评审处理异常', { taskId, error: (err as Error).message });
    }
  }

  /**
   * 构建仲裁信息摘要供 LLM 分析
   */
  private buildArbitrationSummary(detail: any): {
    taskId: string;
    taskPreview: string;
    taskContent: string;
    taskReward: number;
    disputeReason: string;
    publisherName: string;
    takerName: string;
    submissionContent: string;
    chatHistory: Array<{ sender: string; content: string }>;
    existingVotes: Array<{ vote: string; comment: string; nickname: string }>;
  } {
    const task = detail.task || {};
    const dispute = detail.dispute || {};
    const submission = detail.submission || {};
    const publisher = detail.publisher || {};
    const taker = detail.taker || {};

    // 构建沟通记录
    const chatHistory = (detail.chatHistory || []).map((msg: any) => ({
      sender: msg.sender_id === publisher.id ? publisher.nickname : taker.nickname,
      content: msg.content,
    }));

    // 已有投票
    const existingVotes = (detail.votes || []).map((v: any) => ({
      vote: v.vote,
      comment: v.comment || '',
      nickname: v.arbitrator?.nickname || '匿名',
    }));

    return {
      taskId: detail.dispute?.task_id || '',
      taskPreview: (task.content || '').substring(0, 100),
      taskContent: task.content || '',
      taskReward: task.reward || 0,
      disputeReason: dispute.reason || '未提供拒收原因',
      publisherName: publisher.nickname || '发单人',
      takerName: taker.nickname || '接单人',
      submissionContent: submission.content || '',
      chatHistory,
      existingVotes,
    };
  }

  /**
   * LLM 分析仲裁信息并决定投票
   *
   * 返回: { vote: 'publisher'|'taker', comment: string, reasoning: string } 或 null（弃权）
   */
  private async decideArbitrationVote(
    summary: ReturnType<typeof this.buildArbitrationSummary>,
  ): Promise<{ vote: 'publisher' | 'taker'; comment: string; reasoning: string } | null> {
    try {
      const systemPrompt = `你是一名公正的仲裁员。你需要根据任务要求、工作成果和双方沟通记录，判断谁更有理。

判断原则：
1. 首先看工作成果是否满足任务要求。如果成果明显符合要求但发单人拒收，支持接单人。
2. 如果工作成果确实不符合要求或质量太差，支持发单人。
3. 如果双方都有一定道理但无法判断，可以弃权。
4. 报酬金额应作为参考但不作为主要判断依据（高额任务更应谨慎）。
5. 沟通记录中如果有一方态度恶劣或无理取闹，可以适当考虑。

注意：你已经可以看到其他仲裁员的投票。请独立思考，不要盲从。

返回严格JSON格式（不要输出其他内容）：
{"vote": "publisher" 或 "taker" 或 null, "comment": "50字以内的投票理由（中文，面向争议双方可见）", "reasoning": "内部决策理由（仅日志，不公开）"}`;

      const rewardYuan = (summary.taskReward / 100).toFixed(2);
      const existingVotesText = summary.existingVotes.length > 0
        ? summary.existingVotes.map(v => `${v.nickname}: ${v.vote === 'publisher' ? '支持发单人' : '支持接单人'} (${v.comment})`).join('\n')
        : '暂无投票';

      const userMessage = `【任务信息】
任务内容: ${summary.taskContent}
报酬: ¥${rewardYuan}

【拒收原因】
${summary.disputeReason}

【工作成果】
${summary.submissionContent || '未提交工作成果'}

【沟通记录】
${summary.chatHistory.length > 0 ? summary.chatHistory.map(c => `${c.sender}: ${c.content}`).join('\n') : '暂无沟通记录'}

【已有投票】
${existingVotesText}

请做出你的判断：`;

      const result = await this.agentEngine.generateReply(systemPrompt, userMessage);

      if (!result) return null;

      const jsonMatch = result.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);

      if (!parsed.vote || (parsed.vote !== 'publisher' && parsed.vote !== 'taker')) {
        // LLM 选择弃权
        this.logger.info('LLM 选择弃权', { reasoning: parsed.reasoning });
        return null;
      }

      return {
        vote: parsed.vote,
        comment: (parsed.comment || '').substring(0, 200),
        reasoning: parsed.reasoning || 'LLM 决策',
      };
    } catch (err) {
      this.logger.error('LLM 仲裁决策失败', { error: (err as Error).message });
      return null;
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

    // 私有模式：拒绝公域任务推送
    if (this.isPrivateMode()) {
      this.logger.info('🔒 私有模式，跳过公域任务推送');
      this.stateMachine.transition(task.taskId, 'rejected', '私有模式不接受公域任务');
      this.eventBus.emit(WorkerClawEvent.TASK_REJECTED, {
        taskId: task.taskId,
        reason: '私有模式',
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
        // v2: 延迟时发私信告知发单人
        this.notifyTaskDefer(task, evaluation).catch(err => {
          this.logger.debug('发送延迟通知私信失败', { error: (err as Error).message });
        });
        break;
      case 'reject':
        this.stateMachine.transition(task.taskId, 'rejected', evaluation.reason);
        this.eventBus.emit(WorkerClawEvent.TASK_REJECTED, {
          taskId: task.taskId,
          reason: evaluation.reason || '评估未通过',
        });
        // v2: 拒绝时发私信告知发单人原因
        this.notifyTaskReject(task, evaluation).catch(err => {
          this.logger.debug('发送拒绝通知私信失败', { error: (err as Error).message });
        });
        break;
    }
  }

  /**
   * 评估任务
   */
  private evaluateTask(task: Task): TaskEvaluation {
    const concurrencyStats = this.concurrency.getStats();

    // v2: 传入已注册技能列表，让评估器感知已注册技能
    const agentEngine = this.getAgentEngine();
    const registeredSkills = agentEngine.getSkillRegistry().getSkillNames();

    const context: EvaluationContext = {
      runningCount: concurrencyStats.running,
      maxConcurrent: this.config.task.concurrency.maxConcurrent,
      skills: this.toolExecutor.getRegistry().getToolNames(),
      registeredSkills, // v2: 新增
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
        const permLevel = this.determinePermissionLevel(task);
        this.stateMachine.transition(task.taskId, 'accepted', evaluation.reason);
        this.stateMachine.transition(task.taskId, 'running');
        this.stateMachine.setPermissionLevel(task.taskId, permLevel);

        this.eventBus.emit(WorkerClawEvent.TASK_ACCEPTED, { taskId: task.taskId });

        // 接单：await 服务端确认，失败则回滚
        const taken = await this.platformApi.takeTask(task.taskId);
        if (!taken) {
          this.logger.warn(`接单失败，放弃任务 [${task.taskId}]`);
          this.stateMachine.transition(task.taskId, 'rejected', '接单失败（任务已被接取或已结束）');
          this.eventBus.emit(WorkerClawEvent.TASK_REJECTED, { taskId: task.taskId, reason: '接单失败' });
          this.concurrency.taskFinished(task.taskId);
          this.stateMachine.cleanup(task.taskId);
          break;
        }

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

      // 接单：await 确认
      const taken = await this.platformApi.takeTask(task.taskId);
      if (!taken) {
        this.logger.warn(`接单失败，放弃延迟任务 [${task.taskId}]`);
        this.stateMachine.transition(task.taskId, 'rejected', '接单失败');
        this.concurrency.taskFinished(task.taskId);
        this.stateMachine.cleanup(task.taskId);
        return;
      }

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

    // 更新状态机（使用 tryTransition 避免超时后状态转换异常）
    const currentStatus = this.stateMachine.getStatus(taskId);
    if (result.status === 'completed') {
      const transitioned = this.stateMachine.tryTransition(taskId, 'completed');
      if (!transitioned && currentStatus === 'timeout') {
        this.logger.info(`任务超时后实际完成 [${taskId}]`);
      }
    } else {
      const transitioned = this.stateMachine.tryTransition(taskId, 'failed', result.error);
      if (!transitioned && currentStatus === 'timeout') {
        this.logger.info(`任务超时后实际失败 [${taskId}]`, { error: result.error });
      }
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

      // 释放服务端接单状态（cancelTake）
      try {
        const cancelResult = await this.platformApi.cancelTake(taskId);
        if (cancelResult.success) {
          this.logger.info(`✅ 已释放接单状态 [${taskId}]`);
        } else {
          this.logger.warn(`释放接单状态失败 [${taskId}]`, { error: cancelResult.error });
        }
      } catch (err) {
        this.logger.debug(`释放接单状态异常 [${taskId}]`, { error: (err as Error).message });
      }

      // v2: 成果质量失败时通知发单人
      if (result.qualityIssue) {
        this.notifyQualityFailure(task, result).catch(err => {
          this.logger.debug('发送质量失败通知私信失败', { error: (err as Error).message });
        });
      }
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
   * v2: 拒绝任务时发私信告知发单人原因
   * 
   * 不再静默丢弃任务，而是给发单人一个解释，提高沟通体验
   */
  private async notifyTaskReject(task: Task, evaluation: TaskEvaluation): Promise<void> {
    try {
      const posterId = task.posterId || task.raw?.publisher_id;
      if (!posterId) {
        this.logger.debug('无法发送拒绝通知：缺少发单人 ID');
        return;
      }

      const botName = this.config.personality.name || '打工虾';
      const explanation = this.evaluator.getEvaluationExplanation(task, evaluation);

      const message = `抱歉，您的任务暂时无法接取 😔\n\n` +
        `📋 任务：${task.title}\n` +
        `💰 报酬：${((task.reward || 0) / 100).toFixed(2)} 元\n\n` +
        `📊 评估详情：\n${explanation}\n\n` +
        `您可以修改任务描述后重新发布，或稍后再试。\n` +
        `如有疑问，随时私信我～`;

      await this.platformApi.sendPrivateMessage(
        this.config.platform.botId,
        posterId,
        message,
      );

      this.logger.info(`📩 已发送拒绝通知私信给发单人 [${task.taskId}]`);
    } catch (err) {
      this.logger.debug('发送拒绝通知私信失败', { error: (err as Error).message });
    }
  }

  /**
   * v2: 延迟任务时发私信告知发单人正在排队
   */
  private async notifyTaskDefer(task: Task, evaluation: TaskEvaluation): Promise<void> {
    try {
      const posterId = task.posterId || task.raw?.publisher_id;
      if (!posterId) return;

      const botName = this.config.personality.name || '打工虾';
      const concurrencyStats = this.concurrency.getStats();

      const message = `您的任务已加入排队队列 ⏳\n\n` +
        `📋 任务：${task.title}\n` +
        `💰 报酬：${((task.reward || 0) / 100).toFixed(2)} 元\n` +
        `📊 评分：${evaluation.score}/100\n\n` +
        `当前状态：正在处理 ${concurrencyStats.running} 个任务，有空位后会自动开始执行您的任务。\n` +
        `预计不需要太久，请耐心等待～\n\n` +
        `如需查看进度，随时私信我"进展怎么样了"。`;

      await this.platformApi.sendPrivateMessage(
        this.config.platform.botId,
        posterId,
        message,
      );

      this.logger.info(`📩 已发送排队通知私信给发单人 [${task.taskId}]`);
    } catch (err) {
      this.logger.debug('发送排队通知私信失败', { error: (err as Error).message });
    }
  }

  /**
   * v2: 成果质量审核失败时通知发单人
   * 
   * 不同于普通失败（Agent 报错），质量失败表示 Agent 执行了但成果不合格
   */
  private async notifyQualityFailure(task: Task, result: TaskResult): Promise<void> {
    try {
      const posterId = task.posterId || task.raw?.publisher_id;
      if (!posterId) return;

      const botName = this.config.personality.name || '打工虾';
      const issue = result.qualityIssue || '成果不符合任务要求';

      const message = `您的任务执行遇到了技术问题 😅\n\n` +
        `📋 任务：${task.title}\n` +
        `💰 报酬：${((task.reward || 0) / 100).toFixed(2)} 元\n` +
        `❌ 问题：${issue}\n\n` +
        `这通常是因为我暂时无法正确执行某些操作（如下载文件）。\n` +
        `您可以稍后重新发布该任务，或者修改任务描述试试。\n` +
        `抱歉给您带来不便！🙏`;

      await this.platformApi.sendPrivateMessage(
        this.config.platform.botId,
        posterId,
        message,
      );

      this.logger.info(`📩 已发送质量失败通知私信给发单人 [${task.taskId}]`);
    } catch (err) {
      this.logger.debug('发送质量失败通知私信失败', { error: (err as Error).message });
    }
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
   * 构建去重 key（type + 核心标识）
   */
  private buildDedupKey(message: any): string | null {
    const type = message.type;
    // 心跳和系统消息不去重
    if (type === 'heartbeat' || type === 'pong' || type === 'auth_success') {
      return null;
    }

    // 任务消息：用 taskId
    const taskData = message.payload?.task || message.data?.task;
    if (taskData?.id || taskData?.taskId) {
      return `task:${taskData.id || taskData.taskId}`;
    }

    // 私信消息：用 senderId + content（前50字符）
    const privateMsg = message.payload?.message || message.data?.message;
    if (privateMsg?.sender_id && privateMsg?.content) {
      return `pm:${privateMsg.sender_id}:${(privateMsg.content || '').slice(0, 50)}`;
    }

    // 评论消息：用 tweetId + commenterId
    const commentMsg = message.payload || message.data;
    if (commentMsg?.tweetId && commentMsg?.commenterId) {
      return `comment:${commentMsg.tweetId}:${commentMsg.commenterId}`;
    }

    // 其他：用 type + from + 部分内容
    const from = message.from || '';
    const content = JSON.stringify(message.payload || message.data || '').slice(0, 80);
    return `${type}:${from}:${content}`;
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
   * 设置定时任务调度器（私有虾模式）
   */
  setRecurringTaskScheduler(scheduler: RecurringTaskScheduler): void {
    this.recurringTaskScheduler = scheduler;
  }

  /** 注入 WebSocket 客户端（用于发送聊天室消息等） */
  setWsClient(wsClient: any): void {
    this.platformApi.setWsClient(wsClient);
  }

  /** 获取平台 API 客户端（供智能活跃行为使用） */
  getPlatformApi(): PlatformApiClient {
    return this.platformApi;
  }

  /**
   * 恢复任务状态（启动时从平台同步）
   * 用于处理 WorkerClaw 重启后，平台上仍处于"已接单"状态的任务
   */
  recoverTask(taskId: string, taskData: {
    id: string;
    content: string;
    reward: number;
    status: string;
    deadline: string;
    task_type: string;
    publisher_id: string;
    taken_at: string;
  }): void {
    // 如果状态机中已存在该任务，跳过
    if (this.stateMachine.getStatus(taskId)) {
      this.logger.debug(`任务 [${taskId}] 已在状态机中，跳过恢复`);
      return;
    }

    // 根据平台状态恢复
    if (taskData.status === 'taken') {
      // 已接单但未执行的任务，标记为 accepted 状态（等待执行）
      this.stateMachine.initFromPlatform(taskId, 'accepted', {
        permissionLevel: 'standard',
        metadata: {
          recovered: true,
          recoveredAt: new Date().toISOString(),
          originalData: taskData,
        },
      });
      this.logger.info(`📋 任务已恢复 [${taskId}] - 状态: accepted (原: taken)`);
    }
  }

  /**
   * 获取已接单但未完成的任务列表（从状态机）
   */
  getRecoveredTasks(): string[] {
    return this.stateMachine.getActiveTaskIds();
  }

  /**
   * 取消已接单的任务（用于清理卡住的任务）
   */
  async cancelStuckTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    const status = this.stateMachine.getStatus(taskId);
    if (!status) {
      return { success: false, error: '任务不在状态机中' };
    }

    // 只能取消 accepted 状态的任务
    if (status !== 'accepted' && status !== 'evaluating') {
      return { success: false, error: `任务状态为 ${status}，无法取消` };
    }

    // 调用平台 API 取消接单
    const result = await this.platformApi.cancelTake(taskId);
    if (result.success) {
      this.stateMachine.tryTransition(taskId, 'cancelled', '用户手动取消');
      this.logger.info(`✅ 已取消卡住的任务 [${taskId}]`);
    }
    return result;
  }

  /**
   * 判断是否为私有模式
   * 满足以下任一条件即为私有模式：
   *   1. config.mode === 'private'（创建时就是私有虾）
   *   2. rentalState.active === true（被塘主租用中，自动切换为私有虾行为）
   */
  private isPrivateMode(): boolean {
    return this.config.mode === 'private' || this.rentalState.active === true;
  }

  /**
   * 判断发送者是否是私有虾的主人
   * 主人身份有两个来源：
   *   1. rentalState.renterId（租赁场景，从服务器获取）
   *   2. config.ownerId（私有虾直接购买场景，从控制台写入 config）
   */
  private isOwner(senderId: string): boolean {
    if (!this.isPrivateMode()) return false;
    // 租赁场景：renterId 从服务器同步
    if (this.rentalState.renterId && senderId === this.rentalState.renterId) {
      return true;
    }
        // 私有虾直接购买场景：ownerId 从 config 获取
        const configOwnerId = this.config.ownerId;
    if (configOwnerId && senderId === configOwnerId) {
      return true;
    }
    return false;
  }

  /**
   * 私有虾直接执行主人的指令（不走任务流）
   * 将主人消息作为任务，通过 AgentEngine.executeTask 真正执行（支持工具调用）
   */
  private async handleOwnerDirectMessage(senderId: string, content: string): Promise<void> {
    this.logger.info(`🔒 私有虾收到主人指令: "${content.substring(0, 50)}"`);

    const botName = this.config.personality.name || '内勤虾';

    // 先快速判断是否为闲聊（不需要工具的简单对话）
    const chatKeywords = /^(你好|hi|hello|嗨|早上好|晚上好|下午好|在吗|在不在|你是谁|自我介绍|谢|感谢|辛苦|辛苦了|拜拜|再见|晚安|早安|你好呀|哈喽)/i;
    if (chatKeywords.test(content.trim())) {
      // 闲聊走轻量回复
      const systemPrompt =
        `你是${botName}，一只主人专属的私有内勤虾。语气${this.config.personality.tone || '专业、友好、高效'}。` +
        (this.config.personality.bio ? `\n简介：${this.config.personality.bio}` : '') +
        `\n\n简短回复主人的问候，1-2句话，自然友好。`;
      const reply = await this.agentEngine.generateReply(systemPrompt, `主人说: "${content}"`);
      if (reply) {
        await this.platformApi.sendPrivateMessage(this.config.platform.botId, senderId, reply);
      }
      return;
    }

    // 定时任务指令检测
    const schedulerCmd = this.parseSchedulerCommand(content);
    if (schedulerCmd) {
      await this.handleSchedulerCommand(senderId, schedulerCmd);
      return;
    }

    // 非闲聊：构建虚拟任务执行（走完整的 Agent 工具调用循环）
    const taskId = `owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: import('../types/task.js').Task = {
      taskId,
      taskType: 'other',
      title: content.substring(0, 50),
      description: content,
      posterId: senderId,
      posterName: '主人',
      createdAt: new Date().toISOString(),
    };

    const context: import('../types/task.js').TaskExecutionContext = {
      task,
      permissionLevel: 'elevated', // 主人指令给最高权限
      maxOutputTokens: 4096,
      timeoutMs: 300000, // 5 分钟超时
      receivedAt: Date.now(),
    };

    // 先回复主人"收到，正在执行"
    await this.platformApi.sendPrivateMessage(
      this.config.platform.botId,
      senderId,
      `收到，正在执行～`,
    );

    try {
      const result = await this.agentEngine.executeTask(task, context);

      // 提取执行结果回复主人
      let replyText = '';
      if (result.status === 'completed') {
        // 优先使用 content（LLM 最终回复文本）
        if (result.content) {
          replyText = result.content;
        } else if (result.outputs && result.outputs.length > 0) {
          // 提取文本输出
          const textOutputs = result.outputs.filter(o => o.type === 'text');
          if (textOutputs.length > 0) {
            replyText = textOutputs.map(o => o.content).join('\n');
          } else {
            replyText = `已完成，生成了 ${result.outputs.length} 个文件。`;
          }
        }
      }

      if (!replyText) {
        replyText = result.status === 'completed' ? '已执行完毕。' : `执行遇到问题：${result.error || '未知错误'}`;
      }

      // 限制回复长度
      if (replyText.length > 2000) {
        replyText = replyText.substring(0, 2000) + '...';
      }

      await this.platformApi.sendPrivateMessage(this.config.platform.botId, senderId, replyText);
      this.logger.info(`🔒 主人指令执行完成: ${replyText.substring(0, 50)}`);
    } catch (err) {
      this.logger.error('🔒 执行主人指令异常', err);
      await this.platformApi.sendPrivateMessage(
        this.config.platform.botId,
        senderId,
        `执行时出错了：${(err as Error).message || '未知错误'}，请稍后再试。`,
      );
    }
  }

  /**
   * 解析定时任务指令
   * 支持的指令格式：
   * - "定时任务" / "定时列表" / "查看定时" — 查看所有定时任务
   * - "添加定时: 每天9点发微博推广workerclaw" — 添加定时任务（自然语言）
   * - "添加定时任务: weibo_pr; 0 9 * * *; 每天发一条微博推广workerclaw" — 精确格式
   * - "删除定时: weibo_pr" — 删除定时任务
   * - "暂停定时: weibo_pr" / "停止定时: weibo_pr" — 暂停任务
   * - "恢复定时: weibo_pr" / "启动定时: weibo_pr" — 恢复任务
   * - "定时历史" / "查看定时历史" — 查看执行历史
   */
  private parseSchedulerCommand(content: string): { action: string; param?: string } | null {
    const trimmed = content.trim();

    // 查看定时任务列表
    if (/^(定时任务|定时列表|查看定时|查看定时任务)$/i.test(trimmed)) {
      return { action: 'list' };
    }

    // 查看执行历史
    if (/^(定时历史|查看定时历史|定时执行记录)$/i.test(trimmed)) {
      return { action: 'history' };
    }

    // 添加定时任务
    const addMatch = trimmed.match(/^(?:添加|新增|创建|设置)(?:定时任务|定时)?[:：]\s*(.+)$/i);
    if (addMatch) {
      return { action: 'add', param: addMatch[1].trim() };
    }

    // 删除定时任务
    const removeMatch = trimmed.match(/^(?:删除|移除|取消)(?:定时任务|定时)?[:：]\s*(.+)$/i);
    if (removeMatch) {
      return { action: 'remove', param: removeMatch[1].trim() };
    }

    // 暂停定时任务
    const pauseMatch = trimmed.match(/^(?:暂停|停止|禁用)(?:定时任务|定时)?[:：]\s*(.+)$/i);
    if (pauseMatch) {
      return { action: 'pause', param: pauseMatch[1].trim() };
    }

    // 恢复定时任务
    const resumeMatch = trimmed.match(/^(?:恢复|启用|启动)(?:定时任务|定时)?[:：]\s*(.+)$/i);
    if (resumeMatch) {
      return { action: 'resume', param: resumeMatch[1].trim() };
    }

    return null;
  }

  /**
   * 处理定时任务命令
   */
  private async handleSchedulerCommand(senderId: string, cmd: { action: string; param?: string }): Promise<void> {
    if (!this.recurringTaskScheduler) {
      await this.platformApi.sendPrivateMessage(
        this.config.platform.botId,
        senderId,
        '⚠️ 定时任务调度器未启用。请在 config.json 中配置 recurringTasks。',
      );
      return;
    }

    switch (cmd.action) {
      case 'list': {
        const status = this.recurringTaskScheduler.getStatus();
        if (status.tasks.length === 0) {
          await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            senderId,
            '📋 当前没有定时任务。\n\n添加示例：\n"添加定时: 每天9点和18点发一条微博推广workerclaw"\n\n精确格式：\n"添加定时: weibo_pr; 0 9,18 * * *; 发一条微博推广workerclaw"',
          );
          return;
        }

        const lines = status.tasks.map((t, i) => {
          const statusIcon = t.enabled ? '✅' : '⏸️';
          const sourceTag = t.source === 'config' ? '[配置]' : '[动态]';
          const lastInfo = t.lastExecution
            ? ` | 上次: ${t.lastExecution.success ? '✅' : '❌'} ${t.lastExecution.durationMs / 1000}s`
            : ' | 未执行';
          const todayInfo = ` | 今日: ${t.todayCount}次`;
          const nextInfo = t.nextTrigger ? ` | 下次: ${t.nextTrigger}` : '';
          const desc = t.description ? `\n   说明: ${t.description}` : '';
          return `${statusIcon} [${i + 1}] ${sourceTag} ${t.id}\n   类型: ${t.type} | 调度: ${t.schedule}${lastInfo}${todayInfo}${nextInfo}${desc}`;
        });

        const header = `📋 定时任务列表 (${status.tasks.length}个, 状态: ${status.isRunning ? '运行中' : '已停止'}):\n\n`;
        const footer = '\n\n操作: "添加定时: ..." / "暂停定时: ID" / "恢复定时: ID" / "删除定时: ID"';

        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          header + lines.join('\n\n') + footer,
        );
        break;
      }

      case 'history': {
        const history = this.recurringTaskScheduler.getHistory(undefined, 10);
        if (history.length === 0) {
          await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            senderId,
            '📋 暂无执行历史记录。',
          );
          return;
        }

        const lines = history.map((h, i) => {
          const time = new Date(h.timestamp).toLocaleString('zh-CN');
          const icon = h.success ? '✅' : '❌';
          const duration = (h.durationMs / 1000).toFixed(1);
          return `${icon} [${i + 1}] ${time} | ${h.taskDefId} | ${duration}s${h.summary ? `\n   ${h.summary.substring(0, 80)}` : ''}`;
        });

        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          `📋 最近执行历史 (最近 ${history.length} 条):\n\n${lines.join('\n\n')}`,
        );
        break;
      }

      case 'add': {
        await this.handleAddRecurringTask(senderId, cmd.param!);
        break;
      }

      case 'remove': {
        const taskId = cmd.param!;
        const result = this.recurringTaskScheduler.removeTask(taskId);
        if (result.success) {
          await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            senderId,
            `🗑️ 已删除定时任务: ${taskId}`,
          );
        } else {
          await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            senderId,
            `⚠️ ${result.error}`,
          );
        }
        break;
      }

      case 'pause': {
        const taskId = cmd.param!;
        const result = this.recurringTaskScheduler.toggleTask(taskId, false);
        if (result.success) {
          await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            senderId,
            `⏸️ 已暂停定时任务: ${taskId}`,
          );
        } else {
          await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            senderId,
            `⚠️ ${result.error}`,
          );
        }
        break;
      }

      case 'resume': {
        const taskId = cmd.param!;
        const result = this.recurringTaskScheduler.toggleTask(taskId, true);
        if (result.success) {
          await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            senderId,
            `▶️ 已恢复定时任务: ${taskId}`,
          );
        } else {
          await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            senderId,
            `⚠️ ${result.error}`,
          );
        }
        break;
      }
    }
  }

  /**
   * 处理添加定时任务（支持自然语言和精确格式）
   * 
   * 精确格式: "id; cron表达式; 描述; 类型; 每小时限制; 每天限制"
   * 自然语言: LLM 解析后生成精确格式
   */
  private async handleAddRecurringTask(senderId: string, param: string): Promise<void> {
    const scheduler = this.recurringTaskScheduler;
    if (!scheduler) {
      await this.platformApi.sendPrivateMessage(
        this.config.platform.botId,
        senderId,
        '⚠️ 定时任务调度器未启用。',
      );
      return;
    }
    // 先尝试解析精确格式（分号分隔）
    const parts = param.split(/[;；]/).map(p => p.trim());

    if (parts.length >= 3) {
      // 精确格式: id; cron; prompt; type?
      const id = parts[0].replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, '').substring(0, 30) || `task_${Date.now()}`;
      const schedule = parts[1];
      const prompt = parts[2];
      const type = parts[3] || 'other';
      const description = parts[4] || '';

      // 验证 cron 表达式
      try {
        const { CronParser } = await import('../scheduler/recurring-task-scheduler.js');
        new CronParser(schedule);
      } catch (err) {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          `⚠️ cron 表达式无效: "${schedule}"\n\n支持格式示例:\n- "0 9 * * *" — 每天9点\n- "0 9,12,18 * * *" — 每天9/12/18点\n- "*/30 * * * *" — 每30分钟`,
        );
        return;
      }

      const result = scheduler.addTask({
        id,
        type,
        prompt,
        schedule,
        enabled: true,
        description: description || undefined,
      });

      if (result.success) {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          `✅ 定时任务已添加:\n` +
          `   ID: ${id}\n` +
          `   调度: ${schedule}\n` +
          `   任务: ${prompt.substring(0, 60)}${prompt.length > 60 ? '...' : ''}\n` +
          `   类型: ${type}`,
        );
      } else {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          `⚠️ ${result.error}`,
        );
      }
      return;
    }

    // 自然语言格式：使用 LLM 解析
    this.logger.info(`通过 LLM 解析定时任务指令: "${param}"`);

    const systemPrompt = `你是一个任务解析助手。主人用自然语言描述了一个定时任务，你需要将其解析为结构化格式。

输出严格的 JSON 格式（不要输出其他内容）：
{
  "id": "英文ID（简短，用下划线连接，如 weibo_pr）",
  "schedule": "cron表达式（分钟 小时 * * *）",
  "prompt": "任务描述（给 AI Agent 执行的完整指令）",
  "type": "任务类型（weibo_post/tweet/general/other）",
  "description": "简短中文说明（给主人看的）"
}

cron 表达式规则：
- 格式: "分钟 小时 * * *"
- 分钟: 0-59 或 */N
- 小时: 0-23 或逗号分隔 或 */N
- 示例: "0 9,12,18,21 * * *" = 每天 9/12/18/21 点整
- 示例: "*/30 * * * *" = 每 30 分钟
- 示例: "0 9 * * 1-5" = 工作日 9 点

规则：
- ID 使用英文，简短有意义
- prompt 是给 AI 执行的完整指令，要具体明确
- 如果用户说"每天X条"，在 prompt 中说明即可，不要在 cron 中处理
- 默认每小时最多 2 次，每天最多 6 次（不需要在 JSON 中说明）`;

    try {
      const result = await this.agentEngine.generateReply(systemPrompt, `定时任务描述: "${param}"`);

      if (!result) {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          '❌ 无法解析定时任务指令，请使用精确格式或更详细的描述。',
        );
        return;
      }

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          `❌ 解析结果格式异常，请使用精确格式: "id; cron表达式; 任务描述"\n\n例如:\n"添加定时: weibo_pr; 0 9,18 * * *; 每天发一条微博推广workerclaw"`,
        );
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // 验证必要字段
      if (!parsed.id || !parsed.schedule || !parsed.prompt) {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          '❌ 解析结果缺少必要字段（id/schedule/prompt），请重试。',
        );
        return;
      }

      // 验证 cron
      try {
        const { CronParser } = await import('../scheduler/recurring-task-scheduler.js');
        new CronParser(parsed.schedule);
      } catch (err) {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          `❌ 生成的 cron 表达式无效: "${parsed.schedule}"\n\n请使用精确格式重新添加。`,
        );
        return;
      }

      const addResult = scheduler.addTask({
        id: parsed.id,
        type: parsed.type || 'other',
        prompt: parsed.prompt,
        schedule: parsed.schedule,
        enabled: true,
        description: parsed.description || undefined,
      });

      if (addResult.success) {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          `✅ 定时任务已添加:\n` +
          `   ID: ${parsed.id}\n` +
          `   调度: ${parsed.schedule}\n` +
          `   任务: ${parsed.prompt.substring(0, 60)}${parsed.prompt.length > 60 ? '...' : ''}\n` +
          `   说明: ${parsed.description || parsed.prompt.substring(0, 40)}\n\n` +
          `用"定时任务"查看列表，"暂停定时: ${parsed.id}"可暂停`,
        );
      } else {
        await this.platformApi.sendPrivateMessage(
          this.config.platform.botId,
          senderId,
          `⚠️ ${addResult.error}`,
        );
      }
    } catch (err) {
      this.logger.error('LLM 解析定时任务失败', err);
      await this.platformApi.sendPrivateMessage(
        this.config.platform.botId,
        senderId,
        '❌ 解析定时任务时出错，请使用精确格式:\n"添加定时: id; cron表达式; 任务描述"\n\n例如:\n"添加定时: weibo_pr; 0 9,18 * * *; 发一条微博推广workerclaw"',
      );
    }
  }

  /**
   * 私有虾拒绝外部人员的消息
   */
  private async handlePrivateExternalMessage(privateMsg: any): Promise<void> {
    const senderName = privateMsg.sender?.nickname || '用户';
    this.logger.info(`🔒 私有虾拒绝外部私信: ${senderName}`);

    const reply = '抱歉，我是一只主人专属的内勤虾，不接受外部任务，也不闲聊。如有需要，请联系我的主人。';

    const sendResult = await this.platformApi.sendPrivateMessage(
      this.config.platform.botId,
      privateMsg.sender_id,
      reply,
    );
    if (sendResult.success) {
      this.logger.info(`🔒 已回复外部人员 ${senderName}: 拒绝`);
    } else {
      this.logger.warn(`🔒 回复外部人员失败`, { error: sendResult.error });
    }
  }

  /** 获取当前租赁状态 */
  getRentalState(): RentalState {
    return { ...this.rentalState };
  }

  /** 设置租赁状态（启动时从平台同步） */
  setRentalState(state: Partial<RentalState>): void {
    this.rentalState = { ...this.rentalState, ...state };
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
    }
    if (this.arbitrationCleanupTimer) {
      clearInterval(this.arbitrationCleanupTimer);
    }
    this.recentMessageKeys.clear();
    this.handledArbitrations.clear();
    for (const timer of this.taskTimeouts.values()) {
      clearTimeout(timer);
    }
    this.taskTimeouts.clear();
    this.concurrency.dispose();
    this.agentEngine.dispose();
  }
}
