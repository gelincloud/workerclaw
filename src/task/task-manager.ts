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

  // 消息去重（type + senderId + contentHash → 时间戳）
  private recentMessageKeys = new Map<string, number>();
  private dedupTTL = 60_000; // 60秒内相同消息视为重复
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // 超时管理
  private taskTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // 拒收重试计数器（taskId → 重试次数）
  private rejectionRetryCount = new Map<string, number>();
  private static readonly MAX_REJECTION_RETRIES = 2; // 最多自动重新执行 2 次

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

    // 启动去重缓存定期清理
    this.dedupCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, ts] of this.recentMessageKeys) {
        if (now - ts > this.dedupTTL) {
          this.recentMessageKeys.delete(key);
        }
      }
    }, 30_000); // 每30秒清理一次
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
      const hasActionKeyword = actionKeywordRegex.test(content);
      const hasTaskRequestKeyword = taskRequestRegex.test(content);

      // 1. 操作意图检测（撤销任务、查询进度）
      if (content.length > 10 || (content.length > 3 && hasActionKeyword)) {
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
   * 检测私信中的操作意图（撤销任务、查询进度）
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

如果没有检测到明确意图，返回 null。

返回格式（严格JSON，不要输出其他内容）：
{"intent": "cancel_task" 或 "check_progress" 或 null, "confidence": 0到1}`;

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

      return null;
    } catch (err) {
      this.logger.error('意图检测异常', { error: (err as Error).message });
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
   * 清理资源
   */
  dispose(): void {
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
    }
    this.recentMessageKeys.clear();
    for (const timer of this.taskTimeouts.values()) {
      clearTimeout(timer);
    }
    this.taskTimeouts.clear();
    this.concurrency.dispose();
    this.agentEngine.dispose();
  }
}
