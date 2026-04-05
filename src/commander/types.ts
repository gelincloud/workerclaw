/**
 * 微博运营指挥官 - 类型定义
 *
 * 指挥官系统负责：
 * 1. 数据监控 - 采集账号数据、热门话题、互动指标
 * 2. 策略分析 - 分析数据，给出运营建议
 * 3. 任务生成 - 自动创建定时任务
 */

// ==================== 数据采集相关 ====================

/** 账号数据快照 */
export interface WeiboAccountSnapshot {
  /** 采集时间戳 */
  timestamp: number;
  /** 日期字符串 (YYYY-MM-DD) */
  date: string;
  /** 粉丝数 */
  followers: number;
  /** 关注数 */
  following: number;
  /** 微博数 */
  statuses: number;
  /** 今日新增粉丝 */
  newFollowersToday: number;
  /** 今日发博数 */
  postsToday: number;
  /** 今日互动数（评论+点赞+转发） */
  interactionsToday: number;
}

/** 单条微博数据 */
export interface WeiboPostData {
  id: string;
  createdAt: string;
  text: string;
  repostsCount: number;
  commentsCount: number;
  attitudesCount: number;
  isLongText: boolean;
  pics?: string[];
}

/** 热门话题 */
export interface TrendingTopic {
  rank: number;
  topic: string;
  hotValue: number;
  category?: string;
}

/** 热搜数据 */
export interface WeiboHotSearch {
  timestamp: number;
  topics: TrendingTopic[];
}

/** 互动数据 */
export interface InteractionData {
  /** 评论列表 */
  comments: Array<{
    id: string;
    postId: string;
    userId: string;
    userName: string;
    content: string;
    createdAt: string;
  }>;
  /** @我的微博 */
  mentions: Array<{
    id: string;
    userId: string;
    userName: string;
    text: string;
    createdAt: string;
  }>;
  /** 新粉丝 */
  newFollowers: Array<{
    uid: string;
    name: string;
    description?: string;
    followersCount: number;
  }>;
  /** 私信 */
  messages: Array<{
    id: string;
    fromUid: string;
    fromName: string;
    content: string;
    createdAt: string;
  }>;
}

// ==================== 策略分析相关 ====================

/** 内容类型 */
export type ContentType = 
  | 'hot_comment'      // 热点评论
  | 'daily_share'      // 日常分享
  | 'knowledge'        // 知识科普
  | 'interaction'      // 互动问答
  | 'retweet'          // 转发
  | 'original'         // 原创
  | 'activity'         // 活动
  | 'promotion';       // 推广

/** 发布时机建议 */
export interface PostingTimeSuggestion {
  /** 推荐时间 (HH:mm) */
  time: string;
  /** 理由 */
  reason: string;
  /** 预期效果评分 (1-10) */
  expectedScore: number;
  /** 适合的内容类型 */
  suitableContentTypes: ContentType[];
}

/** 内容建议 */
export interface ContentSuggestion {
  /** 内容类型 */
  type: ContentType;
  /** 建议主题/话题 */
  topic: string;
  /** 内容方向描述 */
  direction: string;
  /** 参考热门话题 */
  relatedTrends?: string[];
  /** 优先级 (1-10) */
  priority: number;
  /** 理由 */
  reason: string;
}

/** 运营策略建议 */
export interface OperationStrategy {
  /** 生成时间 */
  generatedAt: number;
  /** 当前时段建议 */
  currentPhase: 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';
  /** 发布时机建议 */
  postingTimes: PostingTimeSuggestion[];
  /** 内容建议列表 */
  contentSuggestions: ContentSuggestion[];
  /** 互动建议 */
  interactionSuggestions: string[];
  /** 今日待办 */
  todoList: string[];
  /** 紧急事项 */
  urgentItems: string[];
}

// ==================== 任务生成相关 ====================

/** 自动任务类型 */
export type AutoTaskType = 
  | 'post_content'     // 发布内容
  | 'reply_comments'   // 回复评论
  | 'like_posts'       // 点赞互动
  | 'follow_back'      // 回关粉丝
  | 'check_mentions'   // 检查@
  | 'check_dm'         // 检查私信
  | 'browse_trends'    // 浏览热搜
  | 'analyze_data';    // 分析数据

/** 自动任务定义 */
export interface AutoTaskDef {
  /** 任务ID */
  id: string;
  /** 任务类型 */
  type: AutoTaskType;
  /** 任务描述（给LLM执行的prompt） */
  prompt: string;
  /** cron 表达式 */
  schedule: string;
  /** 是否启用 */
  enabled: boolean;
  /** 来源：template=模板, auto=自动生成 */
  source: 'template' | 'auto';
  /** 优先级 (1-10) */
  priority: number;
  /** 最大每日执行次数 */
  maxPerDay: number;
}

/** 运营模板 */
export interface OperationTemplate {
  /** 模板ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 适用场景 */
  scenario: string;
  /** 预设任务列表 */
  tasks: AutoTaskDef[];
}

// ==================== 指挥官配置 ====================

/** 数据采集配置 */
export interface DataCollectionConfig {
  /** 采集间隔 (ms)，默认 30分钟 */
  intervalMs: number;
  /** 热搜采集间隔 (ms)，默认 1小时 */
  trendingIntervalMs: number;
  /** 历史数据保留天数，默认 30天 */
  historyRetentionDays: number;
  /** 是否采集热搜 */
  collectTrending: boolean;
  /** 是否采集互动数据 */
  collectInteractions: boolean;
}

/** 自动化配置 */
export interface AutomationConfig {
  /** 是否启用自动发布 */
  autoPost: boolean;
  /** 是否启用自动回复 */
  autoReply: boolean;
  /** 是否启用自动关注 */
  autoFollow: boolean;
  /** 每日最大发布数 */
  maxPostsPerDay: number;
  /** 每日最大回复数 */
  maxRepliesPerDay: number;
  /** 回复评论的粉丝数阈值（粉丝太少的评论不自动回复） */
  minFollowerToReply: number;
  /** 是否需要在执行前确认 */
  requireConfirmation: boolean;
}

/** 指挥官配置 */
export interface WeiboCommanderConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 塘主ID（用于获取微博凭据） */
  ownerId: string;
  /** 数据采集配置 */
  collection: DataCollectionConfig;
  /** 自动化配置 */
  automation: AutomationConfig;
  /** 使用的运营模板ID */
  templateId?: string;
  /** 自定义定时任务 */
  customTasks?: AutoTaskDef[];
  /** 数据存储目录 */
  dataDir?: string;
  /** 平台 API 地址 */
  platformApiUrl: string;
}

// ==================== 运营报告 ====================

/** 日报数据 */
export interface DailyReport {
  date: string;
  /** 粉丝变化 */
  followerChange: number;
  /** 发布微博数 */
  postsCount: number;
  /** 总互动数 */
  totalInteractions: number;
  /** 互动明细 */
  interactionBreakdown: {
    likes: number;
    comments: number;
    reposts: number;
  };
  /** 完成的任务数 */
  completedTasks: number;
  /** 热门微博 Top 3 */
  topPosts: WeiboPostData[];
  /** 备注 */
  notes?: string;
}

/** 周报数据 */
export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  /** 粉丝净增 */
  netFollowers: number;
  /** 粉丝增长率 */
  followerGrowthRate: number;
  /** 总发布数 */
  totalPosts: number;
  /** 平均互动率 */
  avgInteractionRate: number;
  /** 最佳发布时段 */
  bestPostingTimes: string[];
  /** 热门内容类型 */
  topContentTypes: ContentType[];
  /** 日均数据 */
  dailyAvg: {
    posts: number;
    interactions: number;
    newFollowers: number;
  };
  /** 建议 */
  suggestions: string[];
}
