/**
 * 速率限制器
 * 
 * 使用滑动窗口计数器实现，防止消息洪泛
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { RateLimitConfig } from '../core/config.js';

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

interface SlidingWindowCounter {
  timestamps: number[];
}

export class RateLimiter {
  private logger: Logger;
  private config: RateLimitConfig;

  // 每个发送者的计数器
  private senderCounters = new Map<string, SlidingWindowCounter>();
  // 全局计数器
  private globalCounter: SlidingWindowCounter = { timestamps: [] };
  // 当前运行中的任务数
  private runningTasks = 0;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.logger = createLogger('RateLimiter');
  }

  /**
   * 检查消息是否允许通过
   */
  check(senderId: string): RateLimitResult {
    const now = Date.now();

    // 1. 检查全局速率
    const globalResult = this.checkGlobal(now);
    if (!globalResult.allowed) return globalResult;

    // 2. 检查发送者速率
    const senderResult = this.checkSender(senderId, now);
    if (!senderResult.allowed) return senderResult;

    // 记录
    this.recordMessage(senderId, now);
    return { allowed: true };
  }

  /**
   * 检查是否可以接受新任务
   */
  checkTaskCapacity(): RateLimitResult {
    if (this.runningTasks >= this.config.maxConcurrentTasks) {
      this.logger.warn('达到最大并发任务数', {
        running: this.runningTasks,
        max: this.config.maxConcurrentTasks,
      });
      return {
        allowed: false,
        reason: `并发任务数已达上限 (${this.runningTasks}/${this.config.maxConcurrentTasks})`,
      };
    }
    return { allowed: true };
  }

  /**
   * 增加运行中任务数
   */
  taskStarted(): void {
    this.runningTasks++;
    this.logger.debug(`任务开始，当前并发: ${this.runningTasks}`);
  }

  /**
   * 减少运行中任务数
   */
  taskFinished(): void {
    this.runningTasks = Math.max(0, this.runningTasks - 1);
    this.logger.debug(`任务结束，当前并发: ${this.runningTasks}`);
  }

  /**
   * 获取当前状态
   */
  getStatus(): { runningTasks: number; maxConcurrent: number } {
    return {
      runningTasks: this.runningTasks,
      maxConcurrent: this.config.maxConcurrentTasks,
    };
  }

  /**
   * 重置所有计数器
   */
  reset(): void {
    this.senderCounters.clear();
    this.globalCounter = { timestamps: [] };
    this.runningTasks = 0;
  }

  // ==================== 私有方法 ====================

  private checkGlobal(now: number): RateLimitResult {
    this.cleanWindow(this.globalCounter, now, 60_000);

    if (this.globalCounter.timestamps.length >= this.config.maxMessagesPerMinute * 2) {
      return {
        allowed: false,
        reason: `全局消息速率超限`,
        retryAfterMs: this.getRetryAfter(this.globalCounter.timestamps, now, 60_000),
      };
    }

    return { allowed: true };
  }

  private checkSender(senderId: string, now: number): RateLimitResult {
    if (!this.senderCounters.has(senderId)) {
      this.senderCounters.set(senderId, { timestamps: [] });
    }
    const counter = this.senderCounters.get(senderId)!;

    this.cleanWindow(counter, now, 60_000);

    if (counter.timestamps.length >= this.config.maxMessagesPerMinute) {
      this.logger.warn(`发送者 ${senderId} 消息速率超限`);
      return {
        allowed: false,
        reason: `该发送者消息速率超限 (${counter.timestamps.length}/min)`,
        retryAfterMs: this.getRetryAfter(counter.timestamps, now, 60_000),
      };
    }

    return { allowed: true };
  }

  private recordMessage(senderId: string, now: number): void {
    // 全局记录
    this.globalCounter.timestamps.push(now);

    // 发送者记录
    if (!this.senderCounters.has(senderId)) {
      this.senderCounters.set(senderId, { timestamps: [] });
    }
    this.senderCounters.get(senderId)!.timestamps.push(now);
  }

  private cleanWindow(counter: SlidingWindowCounter, now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    counter.timestamps = counter.timestamps.filter(ts => ts > cutoff);
  }

  private getRetryAfter(timestamps: number[], now: number, windowMs: number): number {
    if (timestamps.length === 0) return 0;
    const oldest = timestamps[0];
    const remaining = windowMs - (now - oldest);
    return Math.max(0, remaining + 100); // 加 100ms 缓冲
  }
}
