/**
 * 知乎运营指挥官 - 类型定义
 *
 * 指挥官系统负责：
 * 1. 数据监控 - 采集账号数据、热榜数据、问题回答数据
 * 2. 策略分析 - 分析数据，给出运营建议
 * 3. 任务生成 - 自动创建定时任务
 */

// ==================== 数据采集相关 ====================

/** 账号数据快照 */
export interface ZhihuAccountSnapshot {
  /** 采集时间戳 */
  timestamp: number;
  /** 日期字符串 (YYYY-MM-DD) */
  date: string;
  /** 用户ID */
  uid: string;
  /** 昵称 */
  nickname: string;
  /** 粉丝数 */
  followers: number;
  /** 关注数 */
  following: number;
  /** 回答数 */
  answerCount: number;
  /** 文章数 */
  articleCount: number;
  /** 获赞数 */
  voteupCount: number;
  /** 今日新增粉丝 */
  newFollowersToday: number;
  /** 今日发布回答数 */
  answersToday: number;
  /** 今日发布文章数 */
  articlesToday: number;
  /** 今日互动数（点赞+评论+收藏） */
  interactionsToday: number;
}

/** 热榜数据项 */
export interface ZhihuHotItem {
  /** 排名 */
  rank: number;
  /** 问题ID */
  questionId: string;
  /** 标题 */
  title: string;
  /** 热度描述 */
  heat: string;
  /** URL */
  url: string;
  /** 回答数 */
  answerCount: number;
  /** 关注数 */
  followerCount: number;
}

/** 热榜数据 */
export interface ZhihuHotData {
  timestamp: number;
  items: ZhihuHotItem[];
}

/** 搜索结果项 */
export interface ZhihuSearchResult {
  type: string;
  title: string;
  excerpt: string;
  url: string;
  author: string;
}

/** 回答数据 */
export interface ZhihuAnswerData {
  answerId: string;
  questionId: string;
  questionTitle: string;
  author: string;
  content: string;
  voteupCount: number;
  commentCount: number;
  createdAt: string;
  url: string;
}

/** 文章数据 */
export interface ZhihuArticleData {
  articleId: string;
  title: string;
  content: string;
  voteupCount: number;
  commentCount: number;
  createdAt: string;
  url: string;
}

// ==================== 策略分析相关 ====================

/** 内容类型 */
export type ZhihuContentType =
  | 'knowledge'      // 知识科普
  | 'experience'     // 经验分享
  | 'opinion'        // 观点评论
  | 'tutorial'       // 教程攻略
  | 'story'          // 故事分享
  | 'news'           // 新闻资讯
  | 'review'         // 测评评测
  | 'career';        // 职场话题

/** 发布时机建议 */
export interface ZhihuPostingTimeSuggestion {
  /** 推荐时间 (HH:mm) */
  time: string;
  /** 理由 */
  reason: string;
  /** 预期效果评分 (1-10) */
  expectedScore: number;
  /** 适合的内容类型 */
  suitableContentTypes: ZhihuContentType[];
}

/** 内容建议 */
export interface ZhihuContentSuggestion {
  /** 内容类型 */
  type: ZhihuContentType;
  /** 建议主题/话题 */
  topic: string;
  /** 内容方向描述 */
  direction: string;
  /** 参考热榜话题 */
  relatedHotTopics?: string[];
  /** 优先级 (1-10) */
  priority: number;
  /** 理由 */
  reason: string;
}

/** 运营策略建议 */
export interface ZhihuOperationStrategy {
  /** 生成时间 */
  generatedAt: number;
  /** 当前时段建议 */
  currentPhase: 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';
  /** 发布时机建议 */
  postingTimes: ZhihuPostingTimeSuggestion[];
  /** 内容建议列表 */
  contentSuggestions: ZhihuContentSuggestion[];
  /** 互动建议 */
  interactionSuggestions: string[];
  /** 今日待办 */
  todoList: string[];
  /** 紧急事项 */
  urgentItems: string[];
}

// ==================== 任务生成相关 ====================

/** 自动任务类型 */
export type ZhihuAutoTaskType =
  | 'post_article'     // 发布文章
  | 'post_answer'      // 回答问题
  | 'reply_comments'   // 回复评论
  | 'browse_hot'       // 浏览热榜
  | 'search_questions' // 搜索问题
  | 'analyze_data';    // 分析数据

/** 自动任务定义 */
export interface ZhihuAutoTaskDef {
  /** 任务ID */
  id: string;
  /** 任务类型 */
  type: ZhihuAutoTaskType;
  /** 任务描述（给LLM执行的prompt） */
  prompt: string;
  /** cron 表达式 (分钟 小时) */
  schedule: string;
  /** 是否启用 */
  enabled: boolean;
  /** 来源：template=模板, auto=自动生成, dynamic=动态任务（持久化） */
  source: 'template' | 'auto' | 'dynamic';
  /** 优先级 (1-10) */
  priority: number;
  /** 最大每日执行次数 */
  maxPerDay: number;
  /** 最大每小时执行次数（可选） */
  maxPerHour?: number;
}

/** 运营模板 */
export interface ZhihuOperationTemplate {
  /** 模板ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 适用场景 */
  scenario: string;
  /** 预设任务列表 */
  tasks: ZhihuAutoTaskDef[];
}

// ==================== 指挥官配置 ====================

/** 数据采集配置 */
export interface ZhihuDataCollectionConfig {
  /** 采集间隔 (ms)，默认 30分钟 */
  intervalMs: number;
  /** 热榜采集间隔 (ms)，默认 1小时 */
  hotIntervalMs: number;
  /** 历史数据保留天数，默认 30天 */
  historyRetentionDays: number;
  /** 是否采集热榜 */
  collectHot: boolean;
  /** 是否采集互动数据 */
  collectInteractions: boolean;
}

/** 自动化配置 */
export interface ZhihuAutomationConfig {
  /** 是否启用自动发布文章 */
  autoPostArticle: boolean;
  /** 是否启用自动回答问题 */
  autoPostAnswer: boolean;
  /** 是否启用自动回复评论 */
  autoReply: boolean;
  /** 每日最大发布文章数 */
  maxArticlesPerDay: number;
  /** 每日最大回答数 */
  maxAnswersPerDay: number;
  /** 每日最大回复数 */
  maxRepliesPerDay: number;
  /** 是否需要在执行前确认 */
  requireConfirmation: boolean;
}

/** 知乎指挥官配置 */
export interface ZhihuCommanderConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 塘主ID（可选，不填则通过 botId 自动获取） */
  ownerId?: string;
  /** 平台 API URL */
  platformApiUrl?: string;
  /** 数据采集配置 */
  collection: ZhihuDataCollectionConfig;
  /** 自动化配置 */
  automation: ZhihuAutomationConfig;
  /** 使用的运营模板ID */
  templateId?: string;
  /** 自定义定时任务 */
  customTasks?: ZhihuAutoTaskDef[];
  /** 数据存储目录 */
  dataDir?: string;
}

// ==================== 运营报告 ====================

/** 日报数据 */
export interface ZhihuDailyReport {
  date: string;
  /** 粉丝变化 */
  followerChange: number;
  /** 发布文章数 */
  articlesCount: number;
  /** 发布回答数 */
  answersCount: number;
  /** 总互动数 */
  totalInteractions: number;
  /** 互动明细 */
  interactionBreakdown: {
    voteups: number;
    comments: number;
    collects: number;
  };
  /** 完成的任务数 */
  completedTasks: number;
  /** 热门回答 Top 3 */
  topAnswers: ZhihuAnswerData[];
  /** 备注 */
  notes?: string;
}

/** 周报数据 */
export interface ZhihuWeeklyReport {
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
  topContentTypes: ZhihuContentType[];
  /** 日均数据 */
  dailyAvg: {
    articles: number;
    answers: number;
    interactions: number;
    newFollowers: number;
  };
  /** 建议 */
  suggestions: string[];
}
