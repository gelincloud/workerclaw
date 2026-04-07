/**
 * 小红书运营指挥官 - 类型定义
 *
 * 指挥官系统负责：
 * 1. 数据监控 - 采集账号数据、热门笔记、互动指标
 * 2. 策略分析 - 分析数据，给出运营建议
 * 3. 任务生成 - 自动创建定时任务
 */

// ==================== 数据采集相关 ====================

/** 账号数据快照 */
export interface XhsAccountSnapshot {
  /** 采集时间戳 */
  timestamp: number;
  /** 日期字符串 (YYYY-MM-DD) */
  date: string;
  /** 粉丝数 */
  followers: number;
  /** 关注数 */
  following: number;
  /** 获赞与收藏数 */
  likesAndCollects: number;
  /** 创作者等级 */
  creatorLevel: number;
  /** 今日新增粉丝 */
  newFollowersToday: number;
  /** 今日发布笔记数 */
  notesToday: number;
  /** 今日互动数 */
  interactionsToday: number;
}

/** 单条笔记数据 */
export interface XhsNoteData {
  id: string;
  title: string;
  type: 'image' | 'video';
  date: string;
  views: number;
  likes: number;
  collects: number;
  comments: number;
  shares?: number;
  url: string;
}

/** 创作者统计数据 */
export interface XhsCreatorStats {
  /** 统计周期 */
  period: 'seven' | 'thirty';
  /** 观看数 */
  views: number;
  /** 观看趋势 */
  viewsTrend: string;
  /** 平均观看时长 */
  avgViewTime: number;
  /** 主页访问数 */
  homeViews: number;
  /** 点赞数 */
  likes: number;
  /** 点赞趋势 */
  likesTrend: string;
  /** 收藏数 */
  collects: number;
  /** 收藏趋势 */
  collectsTrend: string;
  /** 评论数 */
  comments: number;
  /** 评论趋势 */
  commentsTrend: string;
  /** 分享数 */
  shares: number;
  /** 分享趋势 */
  sharesTrend: string;
  /** 涨粉数 */
  newFollowers: number;
  /** 涨粉趋势 */
  newFollowersTrend: string;
}

/** 热门笔记（首页推荐） */
export interface XhsHotNote {
  rank: number;
  title: string;
  author: string;
  likes: string;
  noteId: string;
  url: string;
}

/** 热门推荐数据 */
export interface XhsHotFeed {
  timestamp: number;
  notes: XhsHotNote[];
}

/** 互动数据 */
export interface XhsInteractionData {
  /** 评论列表 */
  comments: Array<{
    id: string;
    noteId: string;
    userId: string;
    userName: string;
    content: string;
    createdAt: string;
  }>;
  /** @我的笔记 */
  mentions: Array<{
    id: string;
    userId: string;
    userName: string;
    noteTitle: string;
    content: string;
    createdAt: string;
  }>;
  /** 新粉丝 */
  newFollowers: Array<{
    uid: string;
    name: string;
    avatar?: string;
    description?: string;
  }>;
}

// ==================== 策略分析相关 ====================

/** 笔记内容类型 */
export type XhsNoteType = 
  | 'lifestyle'     // 生活方式
  | 'food'          // 美食
  | 'travel'        // 旅行
  | 'beauty'        // 美妆
  | 'fashion'       // 时尚
  | 'fitness'       // 健身
  | 'tech'          // 科技数码
  | 'knowledge'     // 知识科普
  | 'vlog'          // 日常vlog
  | 'tutorial'      // 教程攻略
  | 'review';       // 测评

/** 发布时机建议 */
export interface XhsPostingTimeSuggestion {
  /** 推荐时间 (HH:mm) */
  time: string;
  /** 理由 */
  reason: string;
  /** 预期效果评分 (1-10) */
  expectedScore: number;
  /** 适合的笔记类型 */
  suitableNoteTypes: XhsNoteType[];
}

/** 内容建议 */
export interface XhsContentSuggestion {
  /** 笔记类型 */
  type: XhsNoteType;
  /** 建议主题/话题 */
  topic: string;
  /** 内容方向描述 */
  direction: string;
  /** 参考热门话题/标签 */
  relatedTags?: string[];
  /** 优先级 (1-10) */
  priority: number;
  /** 理由 */
  reason: string;
}

/** 运营策略建议 */
export interface XhsOperationStrategy {
  /** 生成时间 */
  generatedAt: number;
  /** 当前时段建议 */
  currentPhase: 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';
  /** 发布时机建议 */
  postingTimes: XhsPostingTimeSuggestion[];
  /** 内容建议列表 */
  contentSuggestions: XhsContentSuggestion[];
  /** 互动建议 */
  interactionSuggestions: string[];
  /** 今日待办 */
  todoList: string[];
  /** 紧急事项 */
  urgentItems: string[];
}

// ==================== 任务生成相关 ====================

/** 自动任务类型 */
export type XhsAutoTaskType = 
  | 'post_note'       // 发布笔记
  | 'reply_comments'  // 回复评论
  | 'like_notes'      // 点赞互动
  | 'follow_back'     // 回关粉丝
  | 'check_mentions'  // 检查@
  | 'browse_hot'      // 浏览热门
  | 'analyze_data';   // 分析数据

/** 自动任务定义 */
export interface XhsAutoTaskDef {
  /** 任务ID */
  id: string;
  /** 任务类型 */
  type: XhsAutoTaskType;
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
export interface XhsOperationTemplate {
  /** 模板ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 适用场景 */
  scenario: string;
  /** 预设任务列表 */
  tasks: XhsAutoTaskDef[];
}

// ==================== 指挥官配置 ====================

/** 数据采集配置 */
export interface XhsDataCollectionConfig {
  /** 采集间隔 (ms)，默认 30分钟 */
  intervalMs: number;
  /** 热门推荐采集间隔 (ms)，默认 1小时 */
  hotFeedIntervalMs: number;
  /** 历史数据保留天数，默认 30天 */
  historyRetentionDays: number;
  /** 是否采集热门推荐 */
  collectHotFeed: boolean;
  /** 是否采集互动数据 */
  collectInteractions: boolean;
}

/** 自动化配置 */
export interface XhsAutomationConfig {
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
  /** 是否需要在执行前确认 */
  requireConfirmation: boolean;
}

/** 小红书指挥官配置 */
export interface XhsCommanderConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 塘主ID（用于获取小红书凭据） */
  ownerId: string;
  /** 数据采集配置 */
  collection: XhsDataCollectionConfig;
  /** 自动化配置 */
  automation: XhsAutomationConfig;
  /** 使用的运营模板ID */
  templateId?: string;
  /** 自定义定时任务 */
  customTasks?: XhsAutoTaskDef[];
  /** 数据存储目录 */
  dataDir?: string;
}

// ==================== 运营报告 ====================

/** 日报数据 */
export interface XhsDailyReport {
  date: string;
  /** 粉丝变化 */
  followerChange: number;
  /** 发布笔记数 */
  notesCount: number;
  /** 总互动数 */
  totalInteractions: number;
  /** 互动明细 */
  interactionBreakdown: {
    views: number;
    likes: number;
    collects: number;
    comments: number;
  };
  /** 完成的任务数 */
  completedTasks: number;
  /** 热门笔记 Top 3 */
  topNotes: XhsNoteData[];
  /** 备注 */
  notes?: string;
}

/** 周报数据 */
export interface XhsWeeklyReport {
  weekStart: string;
  weekEnd: string;
  /** 粉丝净增 */
  netFollowers: number;
  /** 粉丝增长率 */
  followerGrowthRate: number;
  /** 总发布数 */
  totalNotes: number;
  /** 平均互动率 */
  avgInteractionRate: number;
  /** 最佳发布时段 */
  bestPostingTimes: string[];
  /** 热门笔记类型 */
  topNoteTypes: XhsNoteType[];
  /** 日均数据 */
  dailyAvg: {
    notes: number;
    interactions: number;
    newFollowers: number;
  };
  /** 建议 */
  suggestions: string[];
}
