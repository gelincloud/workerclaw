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
    blog: number;
    blog_comment: number;
    chat: number;
    game: number;
    idle: number;
  };
}

export const DEFAULT_BEHAVIOR_CONFIG: BehaviorSchedulerConfig = {
  enabled: true,
  checkIntervalMs: 5 * 60 * 1000, // 每 5 分钟检查一次
  minIdleTimeMs: 10 * 60 * 1000,   // 空闲 10 分钟后开始
  frequency: {},
  weights: {
    tweet: 10,
    browse: 23,
    comment: 14,
    like: 15,
    blog: 8,
    blog_comment: 6,
    chat: 12,
    game: 5,
    idle: 3,
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
  /** 发布博客 */
  publishBlog?: (title: string, content: string, category: string) => Promise<boolean>;
  /** 评论博客 */
  commentBlog?: (blogId: string, content: string, parentId?: string) => Promise<boolean>;
  /** 聊天室发言 */
  sendChatMessage?: (content: string) => Promise<boolean>;
  /** 发布游戏 */
  publishGame?: (gameType: string, title: string, levelData: string, description: string) => Promise<boolean>;
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

    // idle 不执行
    if (type === 'idle') {
      this.logger.debug('选中空闲行为，跳过');
      return;
    }

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
        case 'blog':
          result = await this.executeBlog();
          break;
        case 'blog_comment':
          result = await this.executeBlogComment();
          break;
        case 'chat':
          result = await this.executeChat();
          break;
        case 'game':
          result = await this.executeGame();
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
   * 发布博客文章
   */
  private async executeBlog(): Promise<BehaviorResult> {
    const startTime = Date.now();

    const systemPrompt = this.personality.buildActiveBehaviorPrompt('blog');

    const content = await this.llm.simpleChat(
      systemPrompt,
      '请写一篇博客文章，要求有吸引人的标题和300字左右的深度内容。按JSON格式输出：{"title":"标题","content":"正文内容","category":"分类"}。分类可选：技术、思考、生活、职场。只输出JSON，不要其他内容。',
    );

    if (!content || content.length < 10) {
      return {
        type: 'blog',
        success: false,
        error: '生成博客内容过短',
        durationMs: Date.now() - startTime,
      };
    }

    // 尝试解析JSON
    try {
      // 提取 JSON 内容（支持 markdown 代码块格式）
      let jsonStr = content;
      
      // 尝试提取 markdown 代码块中的 JSON
      const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      } else {
        // 没有代码块，尝试直接匹配 JSON 对象
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
      }
      
      const parsed = JSON.parse(jsonStr);
      if (parsed.title && parsed.content) {
        const category = parsed.category || '思考';
        this.logger.debug('博客内容解析成功', { title: parsed.title, category });
        const published = this.callbacks.publishBlog
          ? await this.callbacks.publishBlog(parsed.title.trim(), parsed.content.trim(), category)
          : false;
        return {
          type: 'blog',
          success: published,
          content: published ? `博客「${parsed.title}」` : undefined,
          error: published ? undefined : '博客发布回调未配置',
          durationMs: Date.now() - startTime,
        };
      }
    } catch (parseErr) {
      this.logger.warn('博客 JSON 解析失败', { error: (parseErr as Error).message, content: content.substring(0, 200) });
    }

    return {
      type: 'blog',
      success: false,
      error: '博客内容解析失败',
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 评论博客
   */
  private async executeBlogComment(): Promise<BehaviorResult> {
    const startTime = Date.now();

    const systemPrompt = this.personality.buildActiveBehaviorPrompt('comment');

    const content = await this.llm.simpleChat(
      systemPrompt,
      '请生成一条博客评论，针对你最近看到的一篇有趣的博客。只输出评论内容，不超过100字。',
    );

    if (!content || content.length < 5) {
      return {
        type: 'blog_comment',
        success: false,
        error: '生成博客评论过短',
        durationMs: Date.now() - startTime,
      };
    }

    const commented = this.callbacks.commentBlog
      ? await this.callbacks.commentBlog('', content)
      : false;

    return {
      type: 'blog_comment',
      success: commented,
      content: commented ? content : undefined,
      error: commented ? undefined : '博客评论回调未配置',
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 聊天室发言
   */
  private async executeChat(): Promise<BehaviorResult> {
    const startTime = Date.now();

    const systemPrompt = this.personality.buildActiveBehaviorPrompt('chat');

    const content = await this.llm.simpleChat(
      systemPrompt,
      '请生成一条简短的聊天话题（不超过50字），能引发对话，不提及智工坊社区，自然真实，像朋友聊天。只输出内容，不要加引号。',
    );

    if (!content || content.length < 3) {
      return {
        type: 'chat',
        success: false,
        error: '生成聊天内容过短',
        durationMs: Date.now() - startTime,
      };
    }

    const sent = this.callbacks.sendChatMessage
      ? await this.callbacks.sendChatMessage(content)
      : false;

    return {
      type: 'chat',
      success: sent,
      content: sent ? content : undefined,
      error: sent ? undefined : '聊天发送回调未配置',
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 发布H5小游戏
   */
  private async executeGame(): Promise<BehaviorResult> {
    const startTime = Date.now();

    const systemPrompt = this.personality.buildActiveBehaviorPrompt('game');

    // 可用游戏类型：snake, 2048
    const gameTypes = ['snake', '2048'];
    const gameTypeInfo: Record<string, string> = {
      snake: '贪吃蛇游戏：经典控制蛇吃食物变长，撞墙或撞自己游戏结束。可配置：初始蛇长度、食物位置、障碍物、速度等级。',
      '2048': '2048数字游戏：滑动合并相同数字，达到2048获胜。可配置：初始布局、目标数字、格子大小(4x4/5x5)。',
    };

    const randomType = gameTypes[Math.floor(Math.random() * gameTypes.length)];

    const content = await this.llm.simpleChat(
      systemPrompt,
      `请为「${randomType}」游戏生成关卡配置。
游戏类型说明：${gameTypeInfo[randomType]}

按JSON格式输出：
{
  "title": "游戏标题（吸引人的名字）",
  "description": "游戏描述（30-100字，介绍玩法亮点）",
  "levelData": "关卡配置（JSON字符串，根据游戏类型配置）"
}

${randomType === 'snake' ? `levelData 示例（贪吃蛇）:
{"initialLength":3,"speed":150,"obstacles":[{"x":5,"y":5},{"x":6,"y":5}],"foodCount":3}` : ''}

${randomType === '2048' ? `levelData 示例（2048）:
{"gridSize":4,"targetTile":2048,"initialTiles":[{"x":0,"y":0,"value":2},{"x":1,"y":1,"value":4}]}` : ''}

只输出JSON，不要其他内容。`,
    );

    if (!content || content.length < 10) {
      return {
        type: 'game',
        success: false,
        error: '生成游戏内容过短',
        durationMs: Date.now() - startTime,
      };
    }

    // 尝试解析JSON
    try {
      // 提取 JSON 内容（支持 markdown 代码块格式）
      let jsonStr = content;

      // 尝试提取 markdown 代码块中的 JSON
      const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      } else {
        // 没有代码块，尝试直接匹配 JSON 对象
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
      }

      const parsed = JSON.parse(jsonStr);
      if (parsed.title && parsed.description && parsed.levelData) {
        this.logger.debug('游戏内容解析成功', { title: parsed.title, gameType: randomType });
        const published = this.callbacks.publishGame
          ? await this.callbacks.publishGame(randomType, parsed.title.trim(), JSON.stringify(parsed.levelData), parsed.description.trim())
          : false;
        return {
          type: 'game',
          success: published,
          content: published ? `游戏「${parsed.title}」(${randomType})` : undefined,
          error: published ? undefined : '游戏发布回调未配置',
          durationMs: Date.now() - startTime,
        };
      }
    } catch (parseErr) {
      this.logger.warn('游戏 JSON 解析失败', { error: (parseErr as Error).message, content: content.substring(0, 200) });
    }

    return {
      type: 'game',
      success: false,
      error: '游戏内容解析失败',
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 加权随机选择行为类型
   */
  private weightedRandomSelect(): BehaviorType {
    const weights = this.config.weights;
    const entries: [BehaviorType, number][] = [
      ['tweet', weights.tweet],
      ['browse', weights.browse],
      ['comment', weights.comment],
      ['like', weights.like],
      ['blog', weights.blog],
      ['blog_comment', weights.blog_comment || 6],
      ['chat', weights.chat],
      ['game', weights.game || 5],
      ['idle', weights.idle],
    ];

    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let rand = Math.random() * total;
    let cumulative = 0;

    for (const [type, weight] of entries) {
      cumulative += weight;
      if (rand < cumulative) return type;
    }

    return 'idle';
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
