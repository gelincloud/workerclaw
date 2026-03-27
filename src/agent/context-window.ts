/**
 * 上下文窗口管理
 *
 * 管理对话历史，控制 token 数量
 * 当超过窗口限制时自动截断旧消息
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { LLMMessage } from '../types/agent.js';

// ==================== 配置 ====================

export interface ContextWindowConfig {
  /** 上下文窗口最大 token 数 */
  maxTokens: number;
  /** 保留的系统提示 token 数（始终保留系统消息） */
  systemReserveTokens: number;
  /** 保留最近 N 条消息（即使超出窗口） */
  keepRecentMessages: number;
  /** token 估算因子（中文约 1.5 token/字，英文约 0.75 token/词） */
  tokenEstimateFactor: number;
  /** 截断策略 */
  truncationStrategy: 'oldest' | 'middle' | 'summarize';
}

export const DEFAULT_CONTEXT_WINDOW_CONFIG: ContextWindowConfig = {
  maxTokens: 8000,
  systemReserveTokens: 1000,
  keepRecentMessages: 4,
  tokenEstimateFactor: 1.5,
  truncationStrategy: 'oldest',
};

// ==================== 上下文窗口 ====================

export interface ContextWindowStats {
  totalTokens: number;
  systemTokens: number;
  conversationTokens: number;
  messageCount: number;
  isTruncated: boolean;
}

export class ContextWindow {
  private logger: Logger;
  private config: ContextWindowConfig;

  constructor(config?: Partial<ContextWindowConfig>) {
    this.config = { ...DEFAULT_CONTEXT_WINDOW_CONFIG, ...config };
    this.logger = createLogger('ContextWindow');
  }

  /**
   * 估算消息的 token 数
   */
  estimateTokens(message: LLMMessage): number {
    let text = '';

    if (typeof message.content === 'string') {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      // 多模态内容
      for (const part of message.content as any[]) {
        if (typeof part === 'string') {
          text += part;
        } else if (part && typeof part === 'object' && 'text' in part) {
          text += part.text;
        } else if (part && typeof part === 'object' && 'image_url' in part) {
          // 图片按固定 token 数估算
          text += ' [IMAGE]';
        }
      }
    }

    // 添加角色和工具调用等结构开销
    const overhead = message.tool_calls?.length
      ? message.tool_calls.length * 50
      : message.tool_call_id
        ? 20
        : 10;

    return Math.ceil(text.length * this.config.tokenEstimateFactor) + overhead;
  }

  /**
   * 计算消息列表的总 token 数
   */
  estimateTotalTokens(messages: LLMMessage[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateTokens(msg), 0);
  }

  /**
   * 裁剪消息列表以适应上下文窗口
   * 始终保留系统消息和最近 N 条消息
   */
  fitToWindow(messages: LLMMessage[]): {
    messages: LLMMessage[];
    stats: ContextWindowStats;
  } {
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    const systemTokens = this.estimateTotalTokens(systemMessages);
    const availableTokens = this.config.maxTokens - this.config.systemReserveTokens;

    // 如果系统提示本身就超出限制
    if (systemTokens > this.config.systemReserveTokens) {
      this.logger.warn('系统提示过长，可能影响上下文窗口', {
        systemTokens,
        reserveTokens: this.config.systemReserveTokens,
      });
    }

    let resultMessages = conversationMessages;
    let isTruncated = false;

    // 计算最近 N 条必须保留的消息
    const recentMessages = conversationMessages.slice(-this.config.keepRecentMessages);
    const recentTokens = this.estimateTotalTokens(recentMessages);

    // 可用于历史消息的 token 预算
    const historyBudget = Math.max(0, availableTokens - recentTokens);

    if (recentTokens > availableTokens) {
      // 即使只保留最近消息也超出限制，只能截断最近消息
      this.logger.warn('最近消息也超出窗口限制，进行截断');
      resultMessages = this.truncateMessages(recentMessages, availableTokens);
      isTruncated = true;
    } else {
      // 检查总历史 token 数
      const historyMessages = conversationMessages.slice(0, -this.config.keepRecentMessages);
      const historyTokens = this.estimateTotalTokens(historyMessages);

      if (historyTokens > historyBudget) {
        // 需要裁剪历史消息
        isTruncated = true;
        const fitted = this.truncateMessages(historyMessages, historyBudget);
        resultMessages = [...fitted, ...recentMessages];
      }
    }

    const finalMessages = [...systemMessages, ...resultMessages];
    const conversationTokens = this.estimateTotalTokens(resultMessages);

    if (isTruncated) {
      this.logger.debug('上下文窗口已裁剪', {
        originalCount: conversationMessages.length,
        fittedCount: resultMessages.length,
        conversationTokens,
      });
    }

    return {
      messages: finalMessages,
      stats: {
        totalTokens: systemTokens + conversationTokens,
        systemTokens,
        conversationTokens,
        messageCount: finalMessages.length,
        isTruncated,
      },
    };
  }

  /**
   * 按策略截断消息列表
   */
  private truncateMessages(messages: LLMMessage[], budget: number): LLMMessage[] {
    if (messages.length === 0) return [];

    switch (this.config.truncationStrategy) {
      case 'oldest':
        return this.truncateOldest(messages, budget);
      case 'middle':
        return this.truncateMiddle(messages, budget);
      case 'summarize':
        // 简化版 summarize: 保留首尾，中间放占位
        return this.truncateWithSummary(messages, budget);
      default:
        return this.truncateOldest(messages, budget);
    }
  }

  /**
   * 从最旧的消息开始删除
   */
  private truncateOldest(messages: LLMMessage[], budget: number): LLMMessage[] {
    const result: LLMMessage[] = [];
    let usedTokens = 0;

    // 从最新开始保留
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = this.estimateTokens(messages[i]);
      if (usedTokens + tokens > budget) break;
      result.unshift(messages[i]);
      usedTokens += tokens;
    }

    return result;
  }

  /**
   * 从中间删除，保留首尾
   */
  private truncateMiddle(messages: LLMMessage[], budget: number): LLMMessage[] {
    if (messages.length <= 2) {
      return this.truncateOldest(messages, budget);
    }

    const head = messages[0];
    const tail = messages[messages.length - 1];
    const headTokens = this.estimateTokens(head);
    const tailTokens = this.estimateTokens(tail);
    const middleBudget = budget - headTokens - tailTokens;

    if (middleBudget <= 0) {
      return this.truncateOldest(messages, budget);
    }

    const middle = messages.slice(1, -1);
    const fittedMiddle = this.truncateOldest(middle, middleBudget);

    return [head, ...fittedMiddle, tail];
  }

  /**
   * 保留首尾，中间替换为摘要占位
   */
  private truncateWithSummary(messages: LLMMessage[], budget: number): LLMMessage[] {
    if (messages.length <= 2) {
      return this.truncateOldest(messages, budget);
    }

    const head = messages.slice(0, 2);
    const tail = messages.slice(-2);
    const headTokens = this.estimateTotalTokens(head);
    const tailTokens = this.estimateTotalTokens(tail);
    const summaryTokenCost = 100; // 摘要占位 token 成本
    const remainingBudget = budget - headTokens - tailTokens - summaryTokenCost;

    if (remainingBudget < 0) {
      return this.truncateOldest(messages, budget);
    }

    const omittedCount = messages.length - 4;
    const summaryMessage: LLMMessage = {
      role: 'system',
      content: `[已省略 ${omittedCount} 条历史消息以节省上下文空间]`,
    };

    return [...head, summaryMessage, ...tail];
  }

  /**
   * 获取统计信息
   */
  getStats(messages: LLMMessage[]): ContextWindowStats {
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    return {
      totalTokens: this.estimateTotalTokens(messages),
      systemTokens: this.estimateTotalTokens(systemMessages),
      conversationTokens: this.estimateTotalTokens(conversationMessages),
      messageCount: messages.length,
      isTruncated: false,
    };
  }
}
