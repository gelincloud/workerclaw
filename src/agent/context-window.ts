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
  maxTokens: 16000,
  systemReserveTokens: 1000,
  keepRecentMessages: 6,
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
   *
   * 重要：assistant(tool_calls) 与 tool 消息必须成对出现，
   * 否则 GLM 等模型会报 400 "messages 参数非法"。
   * 因此裁剪时必须保证消息对的完整性。
   */
  fitToWindow(messages: LLMMessage[]): {
    messages: LLMMessage[];
    stats: ContextWindowStats;
  } {
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    const systemTokens = this.estimateTotalTokens(systemMessages);
    // 可用空间 = 总窗口 - 实际系统提示tokens（至少预留少量余量）
    const availableTokens = Math.max(0, this.config.maxTokens - systemTokens - 500);

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
      this.logger.warn('最近消息也超出窗口限制，进行截断', {
        recentTokens,
        availableTokens,
        recentCount: recentMessages.length,
        perMsg: recentMessages.map((m, i) => ({
          idx: i,
          role: m.role,
          tokens: this.estimateTokens(m),
          hasToolCalls: !!m.tool_calls?.length,
          contentLen: typeof m.content === 'string' ? m.content.length : 'non-string',
        })),
      });
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

    // 关键：修复因裁剪导致的消息对断裂
    // 确保 assistant(tool_calls) 后面紧跟对应的 tool 消息，
    // 且 tool 消息前面有对应的 assistant 消息
    resultMessages = this.repairMessagePairs(resultMessages);

    // 安全保护：确保至少保留最后一条 user 消息及其后续的 assistant/tool 消息
    // 如果裁剪后没有任何 user 消息，GLM 等模型会报 "messages 参数非法" (1214)
    const lastUserIdx = (() => { for (let i = conversationMessages.length - 1; i >= 0; i--) { if (conversationMessages[i].role === 'user') return i; } return -1; })();
    if (lastUserIdx >= 0 && !resultMessages.some(m => m.role === 'user')) {
      this.logger.warn('裁剪后缺少 user 消息，强制保留最后一条 user 及其后续消息');
      const keepFromLastUser = conversationMessages.slice(lastUserIdx);
      resultMessages = this.repairMessagePairs(keepFromLastUser);
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
   * 修复消息对断裂问题
   *
   * OpenAI/GLM 等模型要求：
   * 1. tool 消息必须紧跟在 assistant(tool_calls) 之后
   * 2. 孤立的 tool 消息（前面没有 assistant）会导致 400 错误
   * 3. assistant(tool_calls) 后面缺少 tool 回复也可能导致问题
   *
   * 策略：
   * - 删除孤立的 tool 消息（前面没有对应 assistant 的）
   * - 删除尾部断裂的 assistant(tool_calls)（后面缺少 tool 回复的）
   * - 添加占位的 tool 回复给断裂的 assistant(tool_calls)
   */
  private repairMessagePairs(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length === 0) return messages;

    const repaired: LLMMessage[] = [];
    const pendingToolCalls = new Map<string, { index: number; callId: string; name: string }>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // 记录此 assistant 的 tool_calls
        repaired.push(msg);
        for (const tc of msg.tool_calls) {
          pendingToolCalls.set(tc.id, { index: repaired.length - 1, callId: tc.id, name: tc.name });
        }
      } else if (msg.role === 'tool') {
        const toolCallId = msg.tool_call_id;
        if (toolCallId && pendingToolCalls.has(toolCallId)) {
          // 有对应的 assistant，保留
          repaired.push(msg);
          pendingToolCalls.delete(toolCallId);
        } else {
          // 孤立的 tool 消息（前面没有对应的 assistant），丢弃
          this.logger.debug('丢弃孤立的 tool 消息', {
            toolCallId: toolCallId || 'unknown',
            toolName: msg.name,
          });
        }
      } else {
        // 普通消息
        // 如果有未回复的 tool_calls，先补占位回复
        if (pendingToolCalls.size > 0) {
          for (const [callId, info] of pendingToolCalls) {
            repaired.push({
              role: 'tool',
              content: '[上下文裁剪：此工具调用的结果已被省略]',
              tool_call_id: callId,
              name: info.name,
            });
          }
          pendingToolCalls.clear();
        }
        repaired.push(msg);
      }
    }

    // 尾部：如果有未回复的 tool_calls，补占位回复
    if (pendingToolCalls.size > 0) {
      for (const [callId, info] of pendingToolCalls) {
        repaired.push({
          role: 'tool',
          content: '[上下文裁剪：此工具调用的结果已被省略]',
          tool_call_id: callId,
          name: info.name,
        });
      }
      pendingToolCalls.clear();
    }

    // 清理尾部：移除连续的 tool 消息后面的 assistant 消息如果又跟了 tool 消息（冗余）
    // 这个场景很少见，但防止意外

    return repaired;
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
