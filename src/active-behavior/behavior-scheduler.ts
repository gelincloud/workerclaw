/**
 * 行为调度器
 *
 * 任务间隙的自主行为调度
 * 当没有外部任务时，Agent 自主发推文、浏览等
 */

import { createLogger, type Logger } from '../core/logger.js';
import { EventBus } from '../core/events.js';
import { FrequencyController, type BehaviorType, type FrequencyConfig } from './frequency-control.js';
import type { Personality } from '../agent/personality.js';
import type { LLMConfig } from '../core/config.js';
import { LLMClient } from '../agent/llm-client.js';

// ==================== 配置 ====================

export interface BehaviorSchedulerConfig {
  /** 是否启用智能活跃行为 */
  enabled: boolean;
  /** 调度间隔 (ms) */
  checkIntervalMs: number;
  /** 行为执行的最小空闲时间 (ms)，空闲超过此时间才执行 */
  minIdleTimeMs: number;
  /** 频率控制 */
  frequency: Partial<FrequencyConfig>;
  /** 行为概率权重 */
  weights: {
    tweet: number;
    browse: number;
    comment: number;
    like: number;
  };
}

export const DEFAULT_BEHAVIOR_CONFIG: BehaviorSchedulerConfig = {
  enabled: true,
  checkIntervalMs: 5 * 60 * 1000, // 每 5 分钟检查一次
  minIdleTimeMs: 10 * 60 * 1000,   // 空闲 10 分钟后开始
  frequency: {},
  weights: {
    tweet: 15,
    browse: 35,
    comment: 20,
    like: 30,
  },
};

// ==================== 行为结果 ====================

export interface BehaviorResult {
  type: BehaviorType;
  success: boolean;
  content?: string;
  error?: string;
  durationMs: number;
}

// ==================== 行为回调 ====================

export interface BehaviorCallbacks {
  /** 发布推文 */
  publishTweet?: (content: string) => Promise<boolean>;
  /** 浏览内容 */
  browseContent?: () => Promise<boolean>;
  /** 发布评论 */
  postComment?: (content: string, targetId?: string) => Promise<boolean>;
  /** 点赞 */
  likeContent?: (targetId?: string) => Promise<boolean>;
}

// ==================== BehaviorScheduler ====================

export class BehaviorScheduler {
  private logger: Logger;
  private config: BehaviorSchedulerConfig;
  private eventBus: EventBus;
  private personality: Personality;
  private llm: LLMClient;
  private frequencyController: FrequencyController;
  private callbacks: BehaviorCallbacks;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTaskTime = 0;
  private isRunning = false;
  private isExecuting = false;

  constructor(
    config: BehaviorSchedulerConfig,
    personality: Personality,
    llmConfig: LLMConfig,
    eventBus: EventBus,
    callbacks?: BehaviorCallbacks,
  ) {
    this.config = config;
    this.eventBus = eventBus;
    this.personality = personality;
    this.llm = new LLMClient(llmConfig);
    this.frequencyController = new FrequencyController(config.frequency);
    this.callbacks = callbacks || {};
    this.logger = createLogger('BehaviorScheduler');
  }

  /**
   * 启动行为调度器
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info('智能活跃行为已禁用');
      return;
    }

    if (this.isRunning) return;

    this.isRunning = true;
    this.lastTaskTime = Date.now();

    // 监听任务事件，更新空闲时间
    this.eventBus.on('task:received' as any, () => {
      this.lastTaskTime = Date.now();
    });
    this.eventBus.on('task:completed' as any, () => {
      this.lastTaskTime = Date.now();
    });

    // 定时检查
    this.timer = setInterval(() => {
      this.checkAndAct().catch(err => {
        this.logger.error('行为调度错误', (err as Error).message);
      });
    }, this.config.checkIntervalMs);

    this.logger.info(`行为调度器已启动 (检查间隔: ${this.config.checkIntervalMs / 1000}s)`);
  }

  /**
   * 停止行为调度器
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.logger.info('行为调度器已停止');
  }

  /**
   * 更新行为回调
   */
  setCallbacks(callbacks: BehaviorCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 检查并执行行为
   */
  async checkAndAct(): Promise<void> {
    if (this.isExecuting) return;

    // 检查空闲时间
    const idleMs = Date.now() - this.lastTaskTime;
    if (idleMs < this.config.minIdleTimeMs) {
      return;
    }

    // 获取建议行为
    const suggestion = this.frequencyController.getNextSuggested();
    if (!suggestion) {
      return;
    }

    // 按权重随机选择（加权随机）
    const type = this.weightedRandomSelect();

    // 检查是否允许执行
    const check = this.frequencyController.canPerform(type);
    if (!check.allowed) {
      return;
    }

    // 执行行为
    this.isExecuting = true;
    try {
      await this.executeBehavior(type);
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * 执行特定行为
   */
  async executeBehavior(type: BehaviorType): Promise<BehaviorResult> {
    const startTime = Date.now();

    this.logger.info(`执行活跃行为: ${type}`);

    // 检查频率
    const check = this.frequencyController.canPerform(type);
    if (!check.allowed) {
      return {
        type,
        success: false,
        error: check.reason,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      let result: BehaviorResult;

      switch (type) {
        case 'tweet':
          result = await this.executeTweet();
          break;
        case 'browse':
          result = await this.executeBrowse();
          break;
        case 'comment':
          result = await this.executeComment();
          break;
        case 'like':
          result = await this.executeLike();
          break;
        default:
          result = { type, success: false, error: '未知行为类型', durationMs: 0 };
      }

      if (result.success) {
        this.frequencyController.record(type);
      }

      this.eventBus.emit('behavior:executed' as any, {
        type,
        success: result.success,
        durationMs: result.durationMs,
      });

      return result;
    } catch (err) {
      const error = err as Error;
      this.logger.error(`行为执行失败: ${type}`, error.message);

      return {
        type,
        success: false,
        error: error.message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 生成推文内容并发布
   */
  private async executeTweet(): Promise<BehaviorResult> {
    const startTime = Date.now();

    const systemPrompt = this.personality.buildActiveBehaviorPrompt('tweet');

    const content = await this.llm.simpleChat(
      systemPrompt,
      '请生成一条推文，分享你最近的思考或工作日常。只输出推文内容，不要有其他说明。',
    );

    if (!content || content.length < 5) {
      return {
        type: 'tweet',
        success: false,
        error: '生成内容过短',
        durationMs: Date.now() - startTime,
      };
    }

    // 调用回调发布
    const published = this.callbacks.publishTweet
      ? await this.callbacks.publishTweet(content)
      : false;

    return {
      type: 'tweet',
      success: published,
      content: published ? content : undefined,
      error: published ? undefined : '发布回调未配置',
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 浏览内容
   */
  private async executeBrowse(): Promise<BehaviorResult> {
    const startTime = Date.now();

    const browsed = this.callbacks.browseContent
      ? await this.callbacks.browseContent()
      : false;

    return {
      type: 'browse',
      success: browsed,
      error: browsed ? undefined : '浏览回调未配置',
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 发布评论
   */
  private async executeComment(): Promise<BehaviorResult> {
    const startTime = Date.now();

    const systemPrompt = this.personality.buildActiveBehaviorPrompt('comment');

    const content = await this.llm.simpleChat(
      systemPrompt,
      '请生成一条评论，针对你最近看到的一条有趣的推文。只输出评论内容。',
    );

    if (!content || content.length < 3) {
      return {
        type: 'comment',
        success: false,
        error: '生成评论过短',
        durationMs: Date.now() - startTime,
      };
    }

    const posted = this.callbacks.postComment
      ? await this.callbacks.postComment(content)
      : false;

    return {
      type: 'comment',
      success: posted,
      content: posted ? content : undefined,
      error: posted ? undefined : '评论回调未配置',
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 点赞
   */
  private async executeLike(): Promise<BehaviorResult> {
    const startTime = Date.now();

    const liked = this.callbacks.likeContent
      ? await this.callbacks.likeContent()
      : false;

    return {
      type: 'like',
      success: liked,
      error: liked ? undefined : '点赞回调未配置',
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 加权随机选择行为类型
   */
  private weightedRandomSelect(): BehaviorType {
    const weights = this.config.weights;
    const total = weights.tweet + weights.browse + weights.comment + weights.like;
    let rand = Math.random() * total;

    if (rand < weights.tweet) return 'tweet';
    rand -= weights.tweet;
    if (rand < weights.browse) return 'browse';
    rand -= weights.browse;
    if (rand < weights.comment) return 'comment';
    return 'like';
  }

  /**
   * 获取频率控制器
   */
  getFrequencyController(): FrequencyController {
    return this.frequencyController;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      frequencyStats: this.frequencyController.getStats(),
    };
  }

  /**
   * 清理
   */
  dispose(): void {
    this.stop();
  }
}
