/**
 * 抖音运营指挥官 - 类型定义
 *
 * 指挥官系统负责：
 * 1. 数据监控 - 采集账号数据、热门话题、作品数据
 * 2. 策略分析 - 分析数据，给出运营建议
 * 3. 任务生成 - 自动创建定时任务
 */

// ==================== 数据采集相关 ====================

/** 账号数据快照 */
export interface DouyinAccountSnapshot {
  /** 采集时间戳 */
  timestamp: number;
  /** 日期字符串 (YYYY-MM-DD) */
  date: string;
  /** 用户ID */
  uid: string;
  /** 昵称 */
  nickname: string;
  /** 粉丝数 */
  followerCount: number;
  /** 关注数 */
  followingCount: number;
  /** 作品数 */
  awemeCount: number;
  /** 今日新增粉丝 */
  newFollowersToday: number;
  /** 今日发布数 */
  postsToday: number;
  /** 今日互动数（点赞+评论+分享） */
  interactionsToday: number;
}

/** 单条视频数据 */
export interface DouyinVideoData {
  awemeId: string;
  desc: string;
  status: string;
  publicTime?: number;
  createTime?: number;
  statistics: {
    playCount: number;
    diggCount: number;
    commentCount: number;
    shareCount: number;
  };
  video?: {
    duration: number;
    cover?: string;
  };
}

/** 热点词 */
export interface DouyinHotspot {
  sentence: string;
  hotValue: number;
  sentenceId?: string;
}

/** 热点数据 */
export interface DouyinHotData {
  timestamp: number;
  hotspots: DouyinHotspot[];
}

/** 话题信息 */
export interface DouyinHashtag {
  name: string;
  id: string;
  viewCount: number;
}

/** 活动信息 */
export interface DouyinActivity {
  activityId: string;
  title: string;
  endTime: string;
}

/** 合集信息 */
export interface DouyinCollection {
  mixId: string;
  mixName: string;
  videoCount: number;
}

/** 作品分析数据 */
export interface DouyinVideoStats {
  awemeId: string;
  playCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  trend?: {
    date: string;
    value: number;
  }[];
}

// ==================== 策略分析相关 ====================

/** 内容类型 */
export type DouyinContentType =
  | 'vlog'           // 日常 vlog
  | 'knowledge'      // 知识科普
  | 'entertainment'  // 娱乐搞笑
  | 'lifestyle'      // 生活分享
  | 'music'          // 音乐舞蹈
  | 'food'           // 美食探店
  | 'travel'         // 旅游风景
  | 'tech'           // 科技数码
  | 'fashion'        // 时尚穿搭
  | 'game';          // 游戏电竞

/** 发布时机建议 */
export interface DouyinPostingTimeSuggestion {
  time: string;
  reason: string;
  expectedScore: number;
  suitableContentTypes: DouyinContentType[];
}

/** 内容建议 */
export interface DouyinContentSuggestion {
  type: DouyinContentType;
  topic: string;
  direction: string;
  relatedHotspots?: string[];
  priority: number;
  reason: string;
}

/** 运营策略建议 */
export interface DouyinOperationStrategy {
  generatedAt: number;
  currentPhase: 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';
  postingTimes: DouyinPostingTimeSuggestion[];
  contentSuggestions: DouyinContentSuggestion[];
  interactionSuggestions: string[];
  todoList: string[];
  urgentItems: string[];
}

// ==================== 任务生成相关 ====================

/** 自动任务类型 */
export type DouyinAutoTaskType =
  | 'publish_video'    // 发布视频
  | 'draft_video'      // 保存草稿
  | 'reply_comments'   // 回复评论
  | 'check_stats'      // 检查数据
  | 'browse_hot'       // 浏览热点
  | 'update_video'     // 更新作品
  | 'analyze_data';    // 分析数据

/** 自动任务定义 */
export interface DouyinAutoTaskDef {
  id: string;
  type: DouyinAutoTaskType;
  prompt: string;
  schedule: string;
  enabled: boolean;
  source: 'template' | 'auto';
  priority: number;
  maxPerDay: number;
  maxPerHour?: number;
}

/** 运营模板 */
export interface DouyinOperationTemplate {
  id: string;
  name: string;
  description: string;
  scenario: string;
  tasks: DouyinAutoTaskDef[];
}

// ==================== 指挥官配置 ====================

/** 数据采集配置 */
export interface DouyinDataCollectionConfig {
  /** 采集间隔 (ms)，默认 30分钟 */
  intervalMs?: number;
  /** 是否采集热点词 */
  collectTrending?: boolean;
  /** 是否采集作品数据 */
  collectVideos?: boolean;
}

/** 自动化配置 */
export interface DouyinAutomationConfig {
  /** 是否启用自动发布 */
  autoPost?: boolean;
  /** 是否启用自动回复 */
  autoReply?: boolean;
  /** 每日最大发布数 */
  maxPostsPerDay?: number;
  /** 每日最大回复数 */
  maxRepliesPerDay?: number;
  /** 是否需要在执行前确认 */
  requireConfirmation?: boolean;
}

/** 指挥官配置 */
export interface DouyinCommanderConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 塘主ID（可选，不填则通过 botId 自动获取） */
  ownerId?: string;
  /** 平台 API URL */
  platformApiUrl?: string;
  /** 数据采集配置 */
  collection: DouyinDataCollectionConfig;
  /** 自动化配置 */
  automation: DouyinAutomationConfig;
  /** 运营模板 ID */
  templateId?: string;
  /** 自定义任务 */
  customTasks?: DouyinAutoTaskDef[];
  /** 数据存储目录 */
  dataDir?: string;
}

// ==================== 运营报告 ====================

/** 日报数据 */
export interface DouyinDailyReport {
  date: string;
  followerChange: number;
  postsCount: number;
  totalInteractions: number;
  interactionBreakdown: {
    likes: number;
    comments: number;
    shares: number;
  };
  completedTasks: number;
  topVideos: DouyinVideoData[];
  notes?: string;
}

/** 周报数据 */
export interface DouyinWeeklyReport {
  weekStart: string;
  weekEnd: string;
  netFollowers: number;
  followerGrowthRate: number;
  totalPosts: number;
  avgInteractionRate: number;
  bestPostingTimes: string[];
  topContentTypes: DouyinContentType[];
  dailyAvg: {
    posts: number;
    interactions: number;
    newFollowers: number;
  };
  suggestions: string[];
}
