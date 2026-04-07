/**
 * 抖音运营指挥官 - 策略分析引擎
 *
 * 分析采集的数据，生成运营策略建议
 */

import { createLogger, type Logger } from '../core/logger.js';
import { LLMClient } from '../agent/llm-client.js';
import type { LLMConfig } from '../core/config.js';
import type { DouyinDataCollector } from './douyin-data-collector.js';
import type {
  DouyinAccountSnapshot,
  DouyinHotData,
  DouyinOperationStrategy,
  DouyinContentSuggestion,
  DouyinPostingTimeSuggestion,
  DouyinContentType,
  DouyinDailyReport,
} from './douyin-types.js';

/** 策略分析器配置 */
export interface DouyinStrategyEngineConfig {
  /** 使用的 LLM 配置 */
  llmConfig: LLMConfig;
  /** 账号人设描述 */
  persona?: string;
  /** 运营目标 */
  goals?: string[];
  /** 内容偏好 */
  contentPreferences?: DouyinContentType[];
}

/** 时段分析 */
function getCurrentPhase(hour: number): 'morning' | 'noon' | 'afternoon' | 'evening' | 'night' {
  if (hour >= 6 && hour < 10) return 'morning';
  if (hour >= 10 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}

/** 时段描述 */
const PHASE_DESCRIPTIONS = {
  morning: '早间(6-10点) - 通勤时段，适合轻松娱乐、生活方式内容',
  noon: '午间(10-14点) - 午休时段，适合美食、知识科普内容',
  afternoon: '下午(14-18点) - 工作时段，适合深度教程、专业内容',
  evening: '晚间(18-22点) - 休闲时段，黄金发布期',
  night: '夜间(22-6点) - 深夜时段，适合情感、深度内容',
};

export class DouyinStrategyEngine {
  private logger: Logger;
  private llm: LLMClient;
  private config: DouyinStrategyEngineConfig;
  private dataCollector: DouyinDataCollector;

  constructor(config: DouyinStrategyEngineConfig, dataCollector: DouyinDataCollector) {
    this.config = config;
    this.dataCollector = dataCollector;
    this.llm = new LLMClient(config.llmConfig);
    this.logger = createLogger('DouyinStrategyEngine');
  }

  /**
   * 分析并生成运营策略
   */
  async analyze(): Promise<DouyinOperationStrategy> {
    this.logger.info('开始抖音策略分析...');

    const now = new Date();
    const hour = now.getHours();
    const currentPhase = getCurrentPhase(hour);

    // 获取数据
    const accountHistory = this.dataCollector.getAccountHistory(7);
    const latestHotspots = this.dataCollector.getLatestHotspots();

    // 生成发布时机建议
    const postingTimes = this.generatePostingTimes(hour, accountHistory);

    // 生成内容建议
    const contentSuggestions = await this.generateContentSuggestions(
      latestHotspots,
      accountHistory,
      currentPhase
    );

    // 生成互动建议
    const interactionSuggestions = this.generateInteractionSuggestions(hour);

    // 生成今日待办
    const todoList = this.generateTodoList(hour, accountHistory);

    // 生成紧急事项
    const urgentItems = this.generateUrgentItems(hour);

    const strategy: DouyinOperationStrategy = {
      generatedAt: Date.now(),
      currentPhase,
      postingTimes,
      contentSuggestions,
      interactionSuggestions,
      todoList,
      urgentItems,
    };

    this.logger.info(`策略分析完成: ${contentSuggestions.length} 条内容建议, ${postingTimes.length} 个发布时机`);
    return strategy;
  }

  /**
   * 生成发布时机建议
   */
  private generatePostingTimes(
    currentHour: number,
    history: DouyinAccountSnapshot[]
  ): DouyinPostingTimeSuggestion[] {
    const suggestions: DouyinPostingTimeSuggestion[] = [];

    // 抖音最佳发布时段
    const bestTimes: Array<{
      time: string;
      reason: string;
      score: number;
      types: DouyinContentType[];
    }> = [
      { time: '08:00', reason: '早间通勤，用户刷抖音消遣', score: 7, types: ['entertainment', 'lifestyle'] },
      { time: '12:00', reason: '午休时段，美食类、知识类高峰', score: 8, types: ['food', 'knowledge'] },
      { time: '18:00', reason: '下班通勤时段，全品类高峰', score: 9, types: ['vlog', 'entertainment', 'lifestyle'] },
      { time: '20:00', reason: '晚间黄金期，全品类高峰', score: 10, types: ['vlog', 'entertainment', 'music', 'game'] },
      { time: '22:00', reason: '睡前时段，情感、深度内容高峰', score: 8, types: ['lifestyle', 'knowledge', 'travel'] },
    ];

    // 根据当前时间筛选未来可发布的时段
    for (const bt of bestTimes) {
      const btHour = parseInt(bt.time.split(':')[0], 10);
      if (btHour > currentHour) {
        suggestions.push({
          time: bt.time,
          reason: bt.reason,
          expectedScore: bt.score,
          suitableContentTypes: bt.types,
        });
      }
    }

    // 如果今天没有剩余时段，返回明天的第一个
    if (suggestions.length === 0) {
      suggestions.push({
        time: '08:00',
        reason: '明早通勤时段（次日）',
        expectedScore: 7,
        suitableContentTypes: ['entertainment', 'lifestyle'],
      });
    }

    return suggestions;
  }

  /**
   * 生成内容建议
   */
  private async generateContentSuggestions(
    hotData: DouyinHotData | null,
    history: DouyinAccountSnapshot[],
    phase: string
  ): Promise<DouyinContentSuggestion[]> {
    const suggestions: DouyinContentSuggestion[] = [];

    // 基于热点词生成建议
    if (hotData && hotData.hotspots.length > 0) {
      const topHotspots = hotData.hotspots.slice(0, 5);
      suggestions.push({
        type: 'entertainment',
        topic: '结合热点趋势',
        direction: `参考热点方向：${topHotspots.map(h => h.sentence).slice(0, 3).join('、')}`,
        relatedHotspots: topHotspots.map(h => h.sentence),
        priority: 8,
        reason: '热点内容自带流量，更容易获得推荐',
      });
    }

    // 基于时段生成建议
    const phaseSuggestions: Record<string, DouyinContentSuggestion> = {
      morning: {
        type: 'lifestyle',
        topic: '晨间日常 vlog',
        direction: '分享早餐、晨间护肤、通勤日常等早间生活场景',
        priority: 7,
        reason: '早间用户关注轻松娱乐内容',
      },
      noon: {
        type: 'food',
        topic: '美食探店/食谱',
        direction: '分享午餐、探店体验、简单食谱',
        priority: 8,
        reason: '午休时段美食类内容受欢迎',
      },
      afternoon: {
        type: 'knowledge',
        topic: '干货知识科普',
        direction: '分享专业知识、技能教程、工具推荐',
        priority: 7,
        reason: '下午适合深度内容观看',
      },
      evening: {
        type: 'vlog',
        topic: '生活记录/好物分享',
        direction: '分享一天的生活、好物推荐、穿搭展示',
        priority: 9,
        reason: '晚间是流量高峰，适合全品类内容',
      },
      night: {
        type: 'lifestyle',
        topic: '深度内容分享',
        direction: '分享详细的教程、攻略、情感故事',
        priority: 8,
        reason: '睡前用户喜欢观看深度内容',
      },
    };

    suggestions.push(phaseSuggestions[phase]);

    // 如果有历史数据，增加数据驱动的建议
    if (history.length > 3) {
      const latest = history[history.length - 1];
      const previous = history[history.length - 2];

      if (latest && previous && latest.followerCount > previous.followerCount) {
        suggestions.push({
          type: 'vlog',
          topic: '粉丝增长复盘',
          direction: '分析近期增长原因，总结有效内容方向',
          priority: 6,
          reason: '粉丝增长期，巩固有效策略',
        });
      }
    }

    // 始终保持 3-5 条建议
    while (suggestions.length < 3) {
      suggestions.push({
        type: 'vlog',
        topic: '日常生活记录',
        direction: '真实记录日常生活，保持更新频率',
        priority: 5,
        reason: '保持账号活跃度',
      });
    }

    return suggestions.slice(0, 5);
  }

  /**
   * 生成互动建议
   */
  private generateInteractionSuggestions(currentHour: number): string[] {
    const suggestions: string[] = [];

    // 基于时段的互动建议
    if (currentHour >= 8 && currentHour < 10) {
      suggestions.push('早间查看昨夜的评论，及时回复');
    }
    if (currentHour >= 12 && currentHour < 14) {
      suggestions.push('午休时段，浏览同领域创作者内容，增加互动');
    }
    if (currentHour >= 18 && currentHour < 22) {
      suggestions.push('晚间互动高峰期，积极回复评论增加权重');
    }
    if (currentHour >= 22) {
      suggestions.push('睡前整理今日数据，规划明日内容');
    }

    // 通用建议
    suggestions.push('定期回复粉丝评论，建立粉丝关系');
    suggestions.push('关注同领域热门创作者，学习优秀内容');

    return suggestions;
  }

  /**
   * 生成今日待办
   */
  private generateTodoList(currentHour: number, history: DouyinAccountSnapshot[]): string[] {
    const todos: string[] = [];

    // 基于时间的待办
    if (currentHour < 10) {
      todos.push('查看热点词，寻找今日创作灵感');
    }
    if (currentHour < 14) {
      todos.push('准备午间内容（美食/知识科普类）');
    }
    if (currentHour < 18) {
      todos.push('回复评论，维护粉丝互动');
    }
    if (currentHour < 22) {
      todos.push('发布晚间黄金时段视频');
    }

    // 数据相关的待办
    if (history.length > 0) {
      const latest = history[history.length - 1];
      if (latest.postsToday === 0) {
        todos.push('今日尚未发布视频，请尽快完成发布');
      }
    }

    return todos;
  }

  /**
   * 生成紧急事项
   */
  private generateUrgentItems(currentHour: number): string[] {
    const items: string[] = [];

    // 检查是否有紧急事项
    if (currentHour >= 20 && currentHour < 22) {
      items.push('黄金发布时段，确保视频已发布');
    }

    return items;
  }

  /**
   * 生成日报
   */
  generateDailyReport(history: DouyinAccountSnapshot[]): DouyinDailyReport {
    const today = new Date().toISOString().slice(0, 10);
    const todaySnapshot = history.find(h => h.date === today);
    const yesterdaySnapshot = history[history.length - 2];

    return {
      date: today,
      followerChange: todaySnapshot && yesterdaySnapshot
        ? todaySnapshot.followerCount - yesterdaySnapshot.followerCount
        : 0,
      postsCount: todaySnapshot?.postsToday || 0,
      totalInteractions: todaySnapshot?.interactionsToday || 0,
      interactionBreakdown: {
        likes: 0,
        comments: 0,
        shares: 0,
      },
      completedTasks: 0,
      topVideos: [],
    };
  }
}
