/**
 * 来源验证器
 * 
 * 验证消息是否来自智工坊平台
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { PlatformMessage } from '../types/message.js';
import { WSMessageType, ServerMessageType } from '../types/message.js';

export interface SourceVerifyResult {
  valid: boolean;
  reason?: string;
}

export interface SourceVerifierConfig {
  /** 是否验证消息时间戳 */
  validateTimestamp: boolean;
  /** 最大时间偏移（毫秒） */
  maxTimestampSkewMs: number;
  /** 任务消息是否必须有 taskId */
  requireTaskId: boolean;
  /** 消息是否必须有发送者 */
  requireSenderId: boolean;
}

const DEFAULT_SOURCE_CONFIG: SourceVerifierConfig = {
  validateTimestamp: true,
  maxTimestampSkewMs: 5 * 60 * 1000, // 5 分钟
  requireTaskId: true,
  requireSenderId: false, // 服务端很多消息没有 from 字段（如 user_status、online_count）
};

/** 不需要 from 字段的消息类型（系统广播类） */
const NO_FROM_TYPES = new Set([
  'user_status', 'online_count', 'system', 'error',
  ServerMessageType.AUTH_SUCCESS, ServerMessageType.PONG,
]);

export class SourceVerifier {
  private logger: Logger;
  private config: SourceVerifierConfig;

  constructor(config: Partial<SourceVerifierConfig> = {}) {
    this.config = { ...DEFAULT_SOURCE_CONFIG, ...config };
    this.logger = createLogger('SourceVerifier');
  }

  /**
   * 验证消息来源
   */
  verify(message: PlatformMessage): SourceVerifyResult {
    // 1. 验证消息类型
    const typeResult = this.validateType(message);
    if (!typeResult.valid) return typeResult;

    // 2. 验证消息结构
    const structureResult = this.validateStructure(message);
    if (!structureResult.valid) return structureResult;

    // 3. 验证时间戳
    if (this.config.validateTimestamp) {
      const tsResult = this.validateTimestamp(message);
      if (!tsResult.valid) return tsResult;
    }

    return { valid: true };
  }

  // ==================== 私有方法 ====================

  private validateType(message: PlatformMessage): SourceVerifyResult {
    if (!message.type) {
      return { valid: false, reason: '消息缺少 type 字段' };
    }

    // 检查是否是已知的消息类型（WSMessageType 枚举 + ServerMessageType 实际类型）
    const knownTypes = new Set([
      ...Object.values(WSMessageType),
      ...Object.values(ServerMessageType),
    ]);
    if (!knownTypes.has(message.type as any)) {
      this.logger.debug('未知消息类型（不拒绝，仅记录）', { type: message.type });
    }

    return { valid: true };
  }

  private validateStructure(message: PlatformMessage): SourceVerifyResult {
    // 任务消息必须有 msgId
    if (!message.msgId) {
      return { valid: false, reason: '消息缺少 msgId 字段' };
    }

    // 任务推送必须完整（兼容 new_task 和 task_push）
    const msgType = message.type;
    if (msgType === 'new_task' || msgType === 'new_private_task' || msgType === WSMessageType.TASK_PUSH) {
      const data = message.data || message.payload;
      if (!data) {
        return { valid: false, reason: '任务推送消息缺少 data/payload 字段' };
      }
      // 服务端任务在 data.task 或 payload.task 中
      const taskData = data.task;
      if (this.config.requireTaskId && !taskData?.id && !taskData?.taskId) {
        return { valid: false, reason: '任务推送消息缺少 taskId' };
      }
      if (!taskData?.content && !taskData?.description) {
        return { valid: false, reason: '任务推送消息缺少 content/description' };
      }
    }

    // 系统广播消息不需要 from 字段
    if (NO_FROM_TYPES.has(msgType)) {
      return { valid: true };
    }

    // 非系统消息检查 from 字段
    if (
      this.config.requireSenderId &&
      message.type !== WSMessageType.PING &&
      message.type !== WSMessageType.PONG &&
      message.type !== WSMessageType.CONNECT_ACK &&
      !message.from
    ) {
      this.logger.debug('消息缺少 from 字段', { type: message.type });
      // 仅记录 debug，不拒绝（服务端很多消息不携带 from）
    }

    return { valid: true };
  }

  private validateTimestamp(message: PlatformMessage): SourceVerifyResult {
    if (!message.timestamp) {
      return { valid: false, reason: '消息缺少 timestamp 字段' };
    }

    try {
      const msgTime = new Date(message.timestamp).getTime();
      const now = Date.now();
      const skew = Math.abs(now - msgTime);

      if (skew > this.config.maxTimestampSkewMs) {
        const skewMin = Math.round(skew / 60_000);
        return {
          valid: false,
          reason: `消息时间偏移过大 (${skewMin} 分钟)，可能为过期消息`,
        };
      }

      return { valid: true };
    } catch {
      return { valid: false, reason: '消息 timestamp 格式无效' };
    }
  }
}
