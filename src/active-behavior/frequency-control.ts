/**
 * 频率控制器
 *
 * 控制智能行为的发布频率
 * 防止过于频繁或过于沉默
 */

import { createLogger, type Logger } from '../core/logger.js';

// ==================== 行为类型 ====================

export type BehaviorType = 'tweet' | 'browse' | 'comment' | 'like';

// ==================== 频率配置 ====================

export interface FrequencyConfig {
  /** 各行为的频率限制 */
  limits: Partial<Record<BehaviorType, {
    /** 最小间隔 (ms) */
    minIntervalMs: number;
    /** 最大间隔 (ms)，超过此时间应主动行为 */
    maxIntervalMs: number;
    /** 每小时最大次数 */
    maxPerHour: number;
    /** 每天最大次数 */
    maxPerDay: number;
  }>>;
  /** 每日总行为上限 */
  dailyLimit: number;
}

export const DEFAULT_FREQUENCY_CONFIG: FrequencyConfig = {
  limits: {
    tweet: {
      minIntervalMs: 30 * 60 * 1000,   // 最少 30 分钟
      maxIntervalMs: 4 * 60 * 60 * 1000, // 最多 4 小时
      maxPerHour: 3,
      maxPerDay: 10,
    },
    browse: {
      minIntervalMs: 10 * 60 * 1000,   // 最少 10 分钟
      maxIntervalMs: 2 * 60 * 60 * 1000, // 最多 2 小时
      maxPerHour: 10,
      maxPerDay: 50,
    },
    comment: {
      minIntervalMs: 20 * 60 * 1000,   // 最少 20 分钟
      maxIntervalMs: 3 * 60 * 60 * 1000, // 最多 3 小时
      maxPerHour: 5,
      maxPerDay: 20,
    },
    like: {
      minIntervalMs: 2 * 60 * 1000,    // 最少 2 分钟
      maxIntervalMs: 30 * 60 * 1000,    // 最多 30 分钟
      maxPerHour: 20,
      maxPerDay: 100,
    },
  },
  dailyLimit: 100,
};

// ==================== 行为记录 ====================

interface BehaviorRecord {
  type: BehaviorType;
  timestamp: number;
}

// ==================== FrequencyController ====================

export class FrequencyController {
  private logger: Logger;
  private config: FrequencyConfig;
  private records: BehaviorRecord[] = [];
  private dailyCount = new Map<string, number>();
  private currentDay = '';

  constructor(config?: Partial<FrequencyConfig>) {
    this.config = {
      ...DEFAULT_FREQUENCY_CONFIG,
      limits: { ...DEFAULT_FREQUENCY_CONFIG.limits, ...config?.limits },
      ...config,
    };
    this.logger = createLogger('FrequencyController');
    this.currentDay = this.getToday();
  }

  /**
   * 检查行为是否允许执行
   */
  canPerform(type: BehaviorType): { allowed: boolean; reason?: string } {
    const now = Date.now();

    // 检查每日限额
    if (!this.isSameDay(now)) {
      this.resetDaily();
    }

    // 1. 每日总限额
    const totalToday = this.getTodayTotal();
    if (totalToday >= this.config.dailyLimit) {
      return { allowed: false, reason: '已达到每日行为上限' };
    }

    // 2. 行为类型每日限额
    const typeConfig = this.config.limits[type];
    if (!typeConfig) {
      return { allowed: true };
    }

    const typeToday = this.dailyCount.get(type) || 0;
    if (typeToday >= typeConfig.maxPerDay) {
      return { allowed: false, reason: `${type} 已达到每日上限 (${typeConfig.maxPerDay})` };
    }

    // 3. 每小时限额
    const hourAgo = now - 60 * 60 * 1000;
    const hourCount = this.records.filter(
      r => r.type === type && r.timestamp >= hourAgo,
    ).length;

    if (hourCount >= typeConfig.maxPerHour) {
      return { allowed: false, reason: `${type} 已达到每小时上限 (${typeConfig.maxPerHour})` };
    }

    // 4. 最小间隔
    const lastRecord = this.getLastRecord(type);
    if (lastRecord && now - lastRecord.timestamp < typeConfig.minIntervalMs) {
      const waitMs = typeConfig.minIntervalMs - (now - lastRecord.timestamp);
      return {
        allowed: false,
        reason: `${type} 需要等待 ${Math.round(waitMs / 1000)} 秒`,
      };
    }

    return { allowed: true };
  }

  /**
   * 记录行为执行
   */
  record(type: BehaviorType): void {
    const now = Date.now();

    if (!this.isSameDay(now)) {
      this.resetDaily();
    }

    this.records.push({ type, timestamp: now });
    this.dailyCount.set(type, (this.dailyCount.get(type) || 0) + 1);

    // 清理旧记录（保留最近 24 小时）
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.records = this.records.filter(r => r.timestamp >= cutoff);

    this.logger.debug(`记录行为: ${type}`, {
      today: this.dailyCount.get(type),
      total: this.getTodayTotal(),
    });
  }

  /**
   * 检查是否应该主动执行某种行为（超过最大间隔）
   */
  shouldAct(type: BehaviorType): boolean {
    const typeConfig = this.config.limits[type];
    if (!typeConfig) return false;

    const lastRecord = this.getLastRecord(type);
    if (!lastRecord) return true; // 从未执行过，应该执行

    return Date.now() - lastRecord.timestamp >= typeConfig.maxIntervalMs;
  }

  /**
   * 获取下次建议执行的行为类型
   * 返回最需要执行的行为（距上次执行最久的）
   */
  getNextSuggested(): { type: BehaviorType; urgency: number } | null {
    const suggestions: Array<{ type: BehaviorType; urgency: number }> = [];

    for (const type of ['tweet', 'browse', 'comment', 'like'] as BehaviorType[]) {
      const check = this.canPerform(type);
      if (!check.allowed) continue;

      const typeConfig = this.config.limits[type];
      if (!typeConfig) continue;

      const lastRecord = this.getLastRecord(type);
      const elapsed = lastRecord ? Date.now() - lastRecord.timestamp : Infinity;

      // 紧迫度 = 已过时间 / 最大间隔（超过 1.0 表示应该执行）
      const urgency = Math.min(elapsed / typeConfig.maxIntervalMs, 2.0);

      if (urgency > 0.5) { // 超过一半间隔就开始考虑
        suggestions.push({ type, urgency });
      }
    }

    if (suggestions.length === 0) return null;

    // 返回紧迫度最高的
    suggestions.sort((a, b) => b.urgency - a.urgency);
    return suggestions[0];
  }

  /**
   * 获取距离下次可执行的最短等待时间
   */
  getTimeUntilNext(type: BehaviorType): number {
    const typeConfig = this.config.limits[type];
    if (!typeConfig) return 0;

    const lastRecord = this.getLastRecord(type);
    if (!lastRecord) return 0;

    const remaining = typeConfig.minIntervalMs - (Date.now() - lastRecord.timestamp);
    return Math.max(0, remaining);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    today: Record<BehaviorType, number>;
    totalToday: number;
    dailyLimit: number;
  } {
    const today: Record<BehaviorType, number> = {
      tweet: 0, browse: 0, comment: 0, like: 0,
    };

    for (const [type, count] of this.dailyCount) {
      today[type as BehaviorType] = count;
    }

    return {
      today,
      totalToday: this.getTodayTotal(),
      dailyLimit: this.config.dailyLimit,
    };
  }

  // ==================== 私有方法 ====================

  private getLastRecord(type: BehaviorType): BehaviorRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].type === type) return this.records[i];
    }
    return undefined;
  }

  private getTodayTotal(): number {
    let total = 0;
    for (const count of this.dailyCount.values()) {
      total += count;
    }
    return total;
  }

  private getToday(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private isSameDay(timestamp: number): boolean {
    return new Date(timestamp).toISOString().slice(0, 10) === this.currentDay;
  }

  private resetDaily(): void {
    this.currentDay = this.getToday();
    this.dailyCount.clear();
    this.logger.debug('频率控制器：重置每日计数');
  }
}
