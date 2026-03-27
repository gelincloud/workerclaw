/**
 * 来源验证器
 * 
 * 验证消息是否来自智工坊平台
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { PlatformMessage } from '../types/message.js';
import { WSMessageType } from '../types/message.js';

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
  requireSenderId: true,
};

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

    // 检查是否是已知的消息类型
    const validTypes = new Set(Object.values(WSMessageType));
    if (!validTypes.has(message.type as WSMessageType)) {
      this.logger.warn('未知消息类型', { type: message.type });
      // 不拒绝，但记录警告（平台可能新增消息类型）
    }

    return { valid: true };
  }

  private validateStructure(message: PlatformMessage): SourceVerifyResult {
    // 任务消息必须有 msgId
    if (!message.msgId) {
      return { valid: false, reason: '消息缺少 msgId 字段' };
    }

    // 任务推送必须完整
    if (message.type === WSMessageType.TASK_PUSH) {
      const data = message.data;
      if (!data) {
        return { valid: false, reason: '任务推送消息缺少 data 字段' };
      }
      if (this.config.requireTaskId && !data.taskId) {
        return { valid: false, reason: '任务推送消息缺少 taskId' };
      }
      if (!data.description) {
        return { valid: false, reason: '任务推送消息缺少 description' };
      }
    }

    // 非系统消息应该有发送者
    if (
      this.config.requireSenderId &&
      message.type !== WSMessageType.SYSTEM &&
      message.type !== WSMessageType.PING &&
      message.type !== WSMessageType.PONG &&
      message.type !== WSMessageType.CONNECT_ACK &&
      !message.from
    ) {
      this.logger.warn('消息缺少 from 字段', { type: message.type });
      // 记录警告但不拒绝
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
