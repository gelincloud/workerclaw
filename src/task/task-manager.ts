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
import type { PriceRange } from '../core/config.js';
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
    const registry = createBuiltinToolRegistry();
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

      // 0. 意图检测前置：操作关键词正则预过滤
      const actionKeywordRegex = /撤销|取消|放弃|退单|不要了|不做了|进度|进展|怎么样了|做完了吗|查.*进度/;
      const taskRequestRegex = /帮我|能帮我|帮忙|请帮我|能不能|会不会|可不可以|做.*视频|写.*文章|搜.*图|找.*图|画.*图|生成.*图|做个|写个|翻译|分析|处理|下载|查一下|搜一下/;
      const priceKeywordRegex = /多少钱|什么价|费用|价格|报价|收费|报酬|成本|贵不贵|便宜|砍价|能便宜吗|优惠|我出.*元|我出.*块|给.*钱/;
      const hasActionKeyword = actionKeywordRegex.test(content);
      const hasTaskRequestKeyword = taskRequestRegex.test(content);
      const hasPriceKeyword = priceKeywordRegex.test(content);

      // 1. 操作意图检测（撤销任务、查询进度、价格咨询）
      // 价格关键词也触发意图检测，降低触发阈值（5字符）
      const intentMinLength = hasPriceKeyword ? 3 : 10;
      if (content.length > intentMinLength || (content.length > 3 && hasActionKeyword) || hasPriceKeyword) {
        const intentResult = await Promise.race([
          this.detectIntent(content, privateMsg.sender_id),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 10000)),
        ]);

        if (intentResult) {
          this.logger.info(`🎯 意图已执行: ${intentResult.action}`);
          const sendResult = await this.platformApi.sendPrivateMessage(
            this.config.platform.botId,
            privateMsg.sender_id,
            intentResult.message,
          );
          if (sendResult.success) {
            this.logger.info(`💌 意图回复已发送 → ${senderName}: ${intentResult.message.substring(0, 50)}`);
          }
          return; // 意图已处理，不走普通回复
        }
      }

      // 2. 构建 LLM prompt（含任务引导规则）
      const botName = personality.name || '打工虾';
      const basePrompt = personality.customSystemPrompt ||
        `你是${botName}，智工坊平台上的一名打工虾，语气${personality.tone || '友好热情'}。` +
        (personality.bio ? `\n简介：${personality.bio}` : '');

      const taskGuidance = `
【重要行为规则】
- 你的能力只有在接到任务后才能使用，聊天时你无法直接执行任务。
- 对方提出具体任务需求时（如"帮我做视频"、"帮我写个XX"、"帮我搜索XX"、"帮我找个太空图片"等），你要热情回应，说明自己能做，并引导对方给你发任务。
  例如："这个我会做！你可以在聊天窗口点'新建任务'发给我，我接了就能开始干活了～"
- 对方只是闲聊、问候、聊天，正常回应即可，不需要每次都提发任务。
- 对方问"你能做什么"，简要介绍自己的能力，并说"发个任务给我试试就知道了"。
- 绝对不要在聊天中直接帮对方完成任务，也不要说"我做不了"，而是说"给我发个任务吧"。
- 如果对方问到价格/费用，简单说"价格看你具体需求，你先说说想做什么，我给你估个价～"即可。
  不要给出具体数字，因为详细估价已经由意图检测系统处理。
- 注意：如果这条消息是关于价格/费用的问题，它应该已经被前置的意图检测系统拦截处理了。
  如果你看到这条消息，说明它不是价格咨询，请正常回复。

回复要求：自然、友好、简洁（1-3句话），符合你的人格设定。不要重复对方说过的话。只输出回复内容，不要加引号或前缀。`;

      const systemPrompt = basePrompt + taskGuidance;

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
   * 处理公共聊天室消息回复
   * 使用 LLM 生成自然回复，支持 @提及和闲聊
   */
  private async handleChatMessageReply(chatMsg: any): Promise<void> {
    try {
      const personality = this.config.personality;
      const senderName = chatMsg.author?.nickname || `用户${(chatMsg.botId || '').substring(0, 6)}`;
      const content = chatMsg.content || '';
      const botId = this.config.platform.botId;

      // 检查是否 @ 了自己（内容包含 botId 或 bot 名称）
      const botName = personality.name || '打工虾';
      const isMentioned = content.includes(botId) ||
        content.includes(`@${botName}`) ||
        content.includes(botName);

      // 只回复被 @ 的消息或包含自己名字的消息
      // 纯闲聊消息不回复，避免刷屏
      if (!isMentioned) {
        this.logger.debug('聊天消息未 @ 自己，跳过回复');
        return;
      }

      // 构建 LLM prompt
      const systemPrompt = personality.customSystemPrompt ||
        `你是${botName}，智工坊平台上的一名打工虾，语气${personality.tone || '友好热情'}。` +
        (personality.bio ? `\n简介：${personality.bio}` : '') +
        `\n\n【聊天室回复规则】
- 你在公共聊天室中，所有人都能看到你的回复，所以保持简洁有趣。
- 回复自然、友好，1-3句话即可。
- 如果有人问你能做什么，简要介绍能力，建议对方发任务给你。
- 如果有人直接给你任务（不是在聊天室里问），引导对方通过私信或发单给你。
- 只输出回复内容，不要加引号或前缀。`;

      const result = await this.agentEngine.generateReply(
        systemPrompt,
        `聊天室里 ${senderName} 说：${content}`,
      );

      if (result) {
        const sendResult = await this.platformApi.sendChatMessage(result);
        if (sendResult.success) {
          this.logger.info(`💬 已回复聊天室 → ${senderName}: ${result.substring(0, 50)}`);
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
   * 检测私信中的操作意图（撤销任务、查询进度、价格咨询）
   * 参照 OpenClaw 插件的 detectAndExecuteIntent 设计
   *
   * 返回: { action, message } 或 null
   */
  private async detectIntent(
    content: string,
    senderId: string,
  ): Promise<{ action: string; message: string } | null> {
    try {
      const systemPrompt = `你是一个意图检测助手。分析用户的消息，判断是否包含以下意图之一：

1. cancel_task - 撤销/放弃/取消已接取的任务
   关键词：撤销、取消、放弃、不要了、不做了、退单

2. check_progress - 查询任务进度
   关键词：进度、进展、怎么样了、做了吗、完成了吗、查一下进度、任务状态、什么时候能好

3. price_inquiry - 价格/费用/报酬咨询
   关键词：多少钱、费用、价格、报价、什么价、收费、报酬、成本、贵不贵、便宜、砍价、讨价还价、能便宜吗、优惠
   也包括用户给出一个价格说"X元做XX"这种还价场景

如果没有检测到明确意图，返回 null。

返回格式（严格JSON，不要输出其他内容）：
{"intent": "cancel_task" 或 "check_progress" 或 "price_inquiry" 或 null, "confidence": 0到1}`;

      const result = await this.agentEngine.generateReply(
        systemPrompt,
        `用户消息: "${content}"\n\n请检测意图：`,
      );

      if (!result) return null;

      const jsonMatch = result.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.intent || (typeof parsed.confidence === 'number' && parsed.confidence < 0.7)) {
        return null;
      }

      // 执行意图
      if (parsed.intent === 'cancel_task') {
        // 查找进行中的任务
        const status = this.getStatus();
        if (status.runningTasks > 0) {
          // 取最近一个任务尝试取消（简化版）
          const taskIds = this.stateMachine.getActiveTaskIds();
          if (taskIds.length > 0) {
            const taskId = taskIds[0];
            const cancelResult = await this.platformApi.cancelTake(taskId);
            if (cancelResult.success) {
              return { action: 'cancel_task', message: '好的，我已经撤销了这个任务。' };
            }
            return { action: 'cancel_task', message: `撤销失败: ${cancelResult.error || '未知错误'}` };
          }
        }
        return { action: 'cancel_task', message: '我目前没有进行中的任务可以撤销。' };
      }

      if (parsed.intent === 'check_progress') {
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

      if (parsed.intent === 'price_inquiry') {
        // 价格咨询 → 转到专门的估价处理
        const priceReply = await this.handlePriceInquiry(content);
        return { action: 'price_inquiry', message: priceReply };
      }

      return null;
    } catch (err) {
      this.logger.error('意图检测异常', { error: (err as Error).message });
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

  /** 注入 WebSocket 客户端（用于发送聊天室消息等） */
  setWsClient(wsClient: any): void {
    this.platformApi.setWsClient(wsClient);
  }

  /** 获取平台 API 客户端（供智能活跃行为使用） */
  getPlatformApi(): PlatformApiClient {
    return this.platformApi;
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
