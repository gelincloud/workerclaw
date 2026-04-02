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
    browse_blog: number;
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
    browse: 20,
    browse_blog: 10,
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
  publishTweet?: (content: string, category?: string) => Promise<boolean>;
  /** 浏览内容 */
  browseContent?: () => Promise<boolean>;
  /** 浏览博客 */
  browseBlogs?: () => Promise<boolean>;
  /** 发布评论 */
  postComment?: (content: string, targetId?: string) => Promise<boolean>;
  /** 点赞 */
  likeContent?: (targetId?: string) => Promise<boolean>;
  /** 发布博客 */
  publishBlog?: (title: string, content: string, category: string) => Promise<boolean>;
  /** 评论博客 - 返回博客信息供 LLM 生成针对性评论 */
  commentBlog?: (blogId: string, content: string, parentId?: string) => Promise<boolean>;
  /** 获取博客列表用于评论 */
  getBlogsForComment?: () => Promise<Array<{ id: string; title: string; content: string; author?: { nickname: string } }>>;
  /** 聊天室发言 */
  sendChatMessage?: (content: string) => Promise<boolean>;
  /** 获取聊天室最近历史（用于接话，包含 botId 以便 @对方） */
  getRecentChatHistory?: (maxAgeMs?: number) => Promise<Array<{ botId?: string; nickname?: string; content: string }>>;
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
        case 'browse_blog':
          result = await this.executeBrowseBlog();
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
   * LLM 同时选择分类（日常/想法/分享/其他）和生成内容
   */
  private async executeTweet(): Promise<BehaviorResult> {
    const startTime = Date.now();

    const systemPrompt = this.personality.buildActiveBehaviorPrompt('tweet');

    const content = await this.llm.simpleChat(
      systemPrompt,
      `请生成一条推文，分享你最近的思考或工作日常。

按JSON格式输出：
{"content": "推文内容", "category": "分类"}

分类可选：日常、想法、分享、其他
- 日常：生活点滴、今天做了什么、心情随笔
- 想法：对某件事的看法、思考感悟、脑洞
- 分享：有用的信息、学到的东西、推荐
- 其他：不适合以上分类的内容

只输出JSON，不要其他内容。`,
    );

    if (!content || content.length < 5) {
      return {
        type: 'tweet',
        success: false,
        error: '生成内容过短',
        durationMs: Date.now() - startTime,
      };
    }

    // 解析 JSON
    let tweetContent: string | undefined;
    let tweetCategory = '日常';
    try {
      let jsonStr = content;
      const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      } else {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
      }
      const parsed = JSON.parse(jsonStr);
      if (parsed.content) {
        tweetContent = parsed.content;
      }
      if (parsed.category && ['日常', '想法', '分享', '其他'].includes(parsed.category)) {
        tweetCategory = parsed.category;
      }
    } catch {
      // JSON 解析失败，把整个内容当推文
      tweetContent = content;
    }

    if (!tweetContent || tweetContent.length < 5) {
      return {
        type: 'tweet',
        success: false,
        error: '生成内容过短',
        durationMs: Date.now() - startTime,
      };
    }

    this.logger.debug(`推文分类: ${tweetCategory}`);

    // 调用回调发布（传分类）
    const published = this.callbacks.publishTweet
      ? await this.callbacks.publishTweet(tweetContent, tweetCategory)
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
   * 浏览博客内容
   * 
   * 改进：浏览完成后有 50% 概率顺带评论
   */
  private async executeBrowseBlog(): Promise<BehaviorResult> {
    const startTime = Date.now();

    // 先执行浏览
    const browsed = this.callbacks.browseBlogs
      ? await this.callbacks.browseBlogs()
      : false;

    if (!browsed) {
      return {
        type: 'browse_blog',
        success: false,
        error: '博客浏览回调未配置',
        durationMs: Date.now() - startTime,
      };
    }

    // 浏览成功后，50% 概率顺带评论
    const shouldComment = Math.random() < 0.5;
    if (!shouldComment) {
      this.logger.debug('浏览博客后本次不评论（概率未命中）');
      return {
        type: 'browse_blog',
        success: true,
        content: '浏览完成',
        durationMs: Date.now() - startTime,
      };
    }

    this.logger.info('浏览博客后顺带评论...');

    // 获取博客列表并选一篇评论
    if (!this.callbacks.getBlogsForComment) {
      return {
        type: 'browse_blog',
        success: true,
        content: '浏览完成（无评论回调）',
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const blogs = await this.callbacks.getBlogsForComment();
      if (blogs.length === 0) {
        return {
          type: 'browse_blog',
          success: true,
          content: '浏览完成（无博客可评论）',
          durationMs: Date.now() - startTime,
        };
      }

      // 随机选一篇博客
      const target = blogs[Math.floor(Math.random() * blogs.length)];
      this.logger.debug(`选择博客进行评论: "${target.title}"`);

      // 生成针对性评论
      const systemPrompt = this.personality.buildActiveBehaviorPrompt('comment');
      const blogPreview = target.content.substring(0, 500);
      const commentContent = await this.llm.simpleChat(
        systemPrompt,
        `你刚刚阅读了一篇博客，现在想发表一下看法。请针对以下博客文章生成一条评论（不超过100字）：

标题：${target.title}
作者：${target.author?.nickname || '匿名'}
内容摘要：${blogPreview}...

要求：
- 评论要针对博客内容，不要泛泛而谈
- 可以表达认同、提出问题或补充观点
- 语气自然友好
- 只输出评论内容，不要加引号`,
      );

      if (!commentContent || commentContent.length < 5) {
        return {
          type: 'browse_blog',
          success: true,
          content: '浏览完成（评论生成失败）',
          durationMs: Date.now() - startTime,
        };
      }

      // 发送评论
      const commented = this.callbacks.commentBlog
        ? await this.callbacks.commentBlog(target.id, commentContent)
        : false;

      return {
        type: 'browse_blog',
        success: true,
        content: commented ? `浏览并评论「${target.title}」` : '浏览完成（评论发送失败）',
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      this.logger.error('浏览后评论失败', (err as Error).message);
      return {
        type: 'browse_blog',
        success: true,
        content: '浏览完成（评论异常）',
        durationMs: Date.now() - startTime,
      };
    }
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
   * 评论博客 - 先获取博客内容，再生成针对性评论
   */
  private async executeBlogComment(): Promise<BehaviorResult> {
    const startTime = Date.now();

    // 先获取博客列表
    if (!this.callbacks.getBlogsForComment) {
      // 回退：没有获取博客的回调，使用通用评论
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

    // 获取博客列表
    const blogs = await this.callbacks.getBlogsForComment();
    if (blogs.length === 0) {
      return {
        type: 'blog_comment',
        success: false,
        error: '没有可评论的博客',
        durationMs: Date.now() - startTime,
      };
    }

    // 随机选一篇博客
    const target = blogs[Math.floor(Math.random() * blogs.length)];
    this.logger.debug(`选择博客进行评论: "${target.title}"`);

    // 生成针对性评论
    const systemPrompt = this.personality.buildActiveBehaviorPrompt('comment');
    const blogPreview = target.content.substring(0, 500);
    const commentContent = await this.llm.simpleChat(
      systemPrompt,
      `请针对以下博客文章生成一条评论（不超过100字）：

标题：${target.title}
作者：${target.author?.nickname || '匿名'}
内容摘要：${blogPreview}...

要求：
- 评论要针对博客内容，不要泛泛而谈
- 可以表达认同、提出问题或补充观点
- 语气自然友好
- 只输出评论内容，不要加引号`,
    );

    if (!commentContent || commentContent.length < 5) {
      return {
        type: 'blog_comment',
        success: false,
        error: '生成博客评论过短',
        durationMs: Date.now() - startTime,
      };
    }

    // 发送评论
    const commented = this.callbacks.commentBlog
      ? await this.callbacks.commentBlog(target.id, commentContent)
      : false;

    return {
      type: 'blog_comment',
      success: commented,
      content: commented ? `评论「${target.title}」: ${commentContent}` : undefined,
      error: commented ? undefined : '博客评论回调未配置',
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 聊天室发言
   * 
   * 改进：优先接话，不要自顾自起新话题
   * 1. 先获取最近聊天历史
   * 2. 如果最近5分钟有人正在聊天 → 接话（对最近的话题回应）
   * 3. 如果聊天室安静 → 才起新话题
   */
  private async executeChat(): Promise<BehaviorResult> {
    const startTime = Date.now();

    // 获取最近聊天历史
    const recentChat = this.callbacks.getRecentChatHistory
      ? await this.callbacks.getRecentChatHistory(5 * 60 * 1000) // 最近5分钟
      : [];

    // 判断是否有人正在聊天（最近5分钟内有别人发的消息）
    const hasActiveConversation = recentChat.length >= 1;
    const lastMessages = recentChat.slice(-5); // 最近5条

    let userPrompt: string;
    let chatMode: string;
    const systemPrompt = this.personality.buildActiveBehaviorPrompt('chat');

    if (hasActiveConversation && lastMessages.length > 0) {
      // 有人正在聊天 → 接话模式
      // 找到最近一条消息的发送者（用于 @）
      const lastSender = lastMessages[lastMessages.length - 1];
      const mentionTarget = lastSender.nickname || '某人';

      const chatContext = lastMessages
        .map(m => `${m.nickname || '某人'}: ${m.content}`)
        .join('\n');

      userPrompt = `聊天室最近对话：\n${chatContext}\n\n请针对以上对话自然地接话回应。` +
        `要求：\n- 不要重复别人说过的话\n- 可以顺着话题聊聊自己的看法或补充\n- 保持简洁，1-3句话\n- 语气自然，像朋友聊天\n- 只输出回复内容，不要加引号或前缀\n- 不要在回复中加@或提及对方名字（会自动添加）`;

      chatMode = '接话';
      this.logger.debug(`聊天室有活跃对话 (${recentChat.length}条最近消息)，选择接话 @${mentionTarget}`);

      // 先生成内容，再自动加上 @前缀
      const content = await this.llm.simpleChat(systemPrompt, userPrompt);

      if (!content || content.length < 3) {
        return {
          type: 'chat',
          success: false,
          error: '生成聊天内容过短',
          durationMs: Date.now() - startTime,
        };
      }

      const finalContent = `@${mentionTarget} ${content}`;
      const sent = this.callbacks.sendChatMessage
        ? await this.callbacks.sendChatMessage(finalContent)
        : false;

      return {
        type: 'chat',
        success: sent,
        content: sent ? finalContent : undefined,
        error: sent ? undefined : '聊天发送回调未配置',
        durationMs: Date.now() - startTime,
      };
    } else {
      // 聊天室安静 → 起新话题模式
      userPrompt = '请生成一条简短的聊天话题（不超过50字），能引发对话，不提及智工坊社区，自然真实，像朋友聊天。只输出内容，不要加引号。';
      chatMode = '新话题';
    }

    const content = await this.llm.simpleChat(
      systemPrompt,
      userPrompt,
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

    // 可用游戏类型（与服务端 /api/game-types 对齐）
    // 注：前端已实现 snake, 2048；breakout/tetris/memory/maze 前端尚未渲染但服务端已支持
    const gameTypes = ['snake', '2048', 'breakout', 'tetris', 'memory', 'maze'];
    const gameTypeInfo: Record<string, string> = {
      snake: '贪吃蛇游戏：经典控制蛇吃食物变长，撞墙或撞自己游戏结束。可配置：初始蛇长度、食物位置、障碍物、速度等级。',
      '2048': '2048数字游戏：滑动合并相同数字，达到2048获胜。可配置：初始布局、目标数字、格子大小(4x4/5x5)。',
      breakout: '打砖块游戏：控制挡板反弹小球击碎上方砖块。可配置：挡板宽度、球速、砖块布局、砖块耐久度。',
      tetris: '俄罗斯方块：经典下落方块消除游戏。可配置：初始高度、下落速度、方块类型权重、行消除目标。',
      memory: '记忆翻牌游戏：翻两张牌配对，全部配对成功获胜。可配置：网格大小(4x4/6x6)、牌面图案、最大翻牌次数。',
      maze: '迷宫游戏：从起点走到终点的迷宫探索。可配置：迷宫大小、难度等级、时间限制、是否允许回退。',
    };

    const randomType = gameTypes[Math.floor(Math.random() * gameTypes.length)];

    // 为每种游戏类型生成对应的 levelData 示例
    const levelDataHints: Record<string, string> = {
      snake: `levelData 示例（贪吃蛇）:
{"initialLength":3,"speed":150,"obstacles":[{"x":5,"y":5},{"x":6,"y":5}],"foodCount":3}`,
      '2048': `levelData 示例（2048）:
{"gridSize":4,"targetTile":2048,"initialTiles":[{"x":0,"y":0,"value":2},{"x":1,"y":1,"value":4}]}`,
      breakout: `levelData 示例（打砖块）:
{"paddleWidth":80,"ballSpeed":5,"rows":5,"cols":8,"brickDurability":[1,1,2,2,3]}`,
      tetris: `levelData 示例（俄罗斯方块）:
{"startSpeed":1000,"speedIncrease":50,"height":20,"width":10,"targetLines":20}`,
      memory: `levelData 示例（记忆翻牌）:
{"gridSize":4,"maxFlips":30,"symbols":["★","♦","♣","♥","♠","●","▲","■"]}`,
      maze: `levelData 示例（迷宫）:
{"size":15,"difficulty":3,"timeLimit":120,"allowBacktrack":true,"wallDensity":0.3}`,
    };

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

${levelDataHints[randomType]}

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
      ['browse_blog', weights.browse_blog || 10],
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
