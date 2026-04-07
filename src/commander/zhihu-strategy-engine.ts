/**
 * 知乎运营指挥官 - 策略分析引擎
 *
 * 分析采集的数据，生成运营策略建议
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { ZhihuDataCollector } from './zhihu-data-collector.js';
import type {
  ZhihuAccountSnapshot,
  ZhihuHotData,
  ZhihuOperationStrategy,
  ZhihuContentSuggestion,
  ZhihuPostingTimeSuggestion,
  ZhihuContentType,
  ZhihuDailyReport,
} from './zhihu-types.js';

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
  morning: '早间(6-10点) - 通勤时段，适合轻松知识类内容',
  noon: '午间(10-14点) - 午休时段，适合热点讨论、轻松内容',
  afternoon: '下午(14-18点) - 工作时段，适合深度专业内容',
  evening: '晚间(18-22点) - 休闲时段，黄金发布期',
  night: '夜间(22-6点) - 深夜时段，适合深度思考类内容',
};

export class ZhihuStrategyEngine {
  private logger: Logger;
  private dataCollector: ZhihuDataCollector;

  constructor(dataCollector: ZhihuDataCollector) {
    this.dataCollector = dataCollector;
    this.logger = createLogger('ZhihuStrategyEngine');
  }

  /**
   * 分析并生成运营策略
   */
  async analyze(): Promise<ZhihuOperationStrategy> {
    this.logger.info('开始知乎策略分析...');

    const now = new Date();
    const hour = now.getHours();
    const currentPhase = getCurrentPhase(hour);

    // 获取数据
    const accountHistory = this.dataCollector.getAccountHistory(7);
    const latestHotList = this.dataCollector.getLatestHotList();

    // 生成发布时机建议
    const postingTimes = this.generatePostingTimes(hour, accountHistory);

    // 生成内容建议
    const contentSuggestions = this.generateContentSuggestions(
      latestHotList,
      accountHistory,
      currentPhase
    );

    // 生成互动建议
    const interactionSuggestions = this.generateInteractionSuggestions(hour);

    // 生成今日待办
    const todoList = this.generateTodoList(hour, accountHistory);

    // 生成紧急事项
    const urgentItems = this.generateUrgentItems(hour);

    const strategy: ZhihuOperationStrategy = {
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
    history: ZhihuAccountSnapshot[]
  ): ZhihuPostingTimeSuggestion[] {
    const suggestions: ZhihuPostingTimeSuggestion[] = [];

    // 知乎最佳发布时段
    const bestTimes: Array<{
      time: string;
      reason: string;
      score: number;
      types: ZhihuContentType[];
    }> = [
      { time: '08:00', reason: '早间通勤，用户刷知乎获取资讯', score: 7, types: ['news', 'knowledge'] },
      { time: '12:00', reason: '午休时段，热点讨论高峰', score: 8, types: ['opinion', 'story'] },
      { time: '18:00', reason: '下班通勤时段，全品类高峰', score: 9, types: ['experience', 'tutorial'] },
      { time: '21:00', reason: '晚间黄金期，深度内容高峰', score: 10, types: ['knowledge', 'tutorial', 'career'] },
      { time: '23:00', reason: '睡前时段，思考类内容高峰', score: 8, types: ['opinion', 'story'] },
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
        suitableContentTypes: ['news', 'knowledge'],
      });
    }

    return suggestions;
  }

  /**
   * 生成内容建议
   */
  private generateContentSuggestions(
    hotData: ZhihuHotData | null,
    history: ZhihuAccountSnapshot[],
    phase: string
  ): ZhihuContentSuggestion[] {
    const suggestions: ZhihuContentSuggestion[] = [];

    // 基于热榜生成建议
    if (hotData && hotData.items.length > 0) {
      const topItems = hotData.items.slice(0, 5);
      suggestions.push({
        type: 'opinion',
        topic: '结合热榜话题',
        direction: `参考热榜话题：${topItems.map(h => h.title).slice(0, 3).join('、')}`,
        relatedHotTopics: topItems.map(h => h.title),
        priority: 8,
        reason: '热榜话题自带流量，容易获得曝光',
      });
    }

    // 基于时段生成建议
    const phaseSuggestions: Record<string, ZhihuContentSuggestion> = {
      morning: {
        type: 'knowledge',
        topic: '早间知识分享',
        direction: '分享专业知识、行业资讯、技能提升',
        priority: 7,
        reason: '早间用户关注知识类内容',
      },
      noon: {
        type: 'opinion',
        topic: '热点观点评论',
        direction: '对热点事件发表见解，引发讨论',
        priority: 8,
        reason: '午休时段用户喜欢讨论热点',
      },
      afternoon: {
        type: 'tutorial',
        topic: '专业教程攻略',
        direction: '分享详细的教程、方法论、实践经验',
        priority: 7,
        reason: '下午适合深度内容阅读',
      },
      evening: {
        type: 'experience',
        topic: '经验分享',
        direction: '分享个人经历、职场经验、成长故事',
        priority: 9,
        reason: '晚间是流量高峰，适合全品类内容',
      },
      night: {
        type: 'story',
        topic: '深度故事分享',
        direction: '分享有深度的故事、思考、感悟',
        priority: 8,
        reason: '睡前用户喜欢阅读深度内容',
      },
    };

    suggestions.push(phaseSuggestions[phase]);

    // 如果有历史数据，增加数据驱动的建议
    if (history.length > 3) {
      const latest = history[history.length - 1];
      const previous = history[history.length - 2];

      if (latest && previous && latest.followers > previous.followers) {
        suggestions.push({
          type: 'knowledge',
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
        type: 'experience',
        topic: '日常经验分享',
        direction: '真实分享个人经验，保持更新频率',
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
      suggestions.push('早间查看昨夜的评论和私信，及时回复');
    }
    if (currentHour >= 12 && currentHour < 14) {
      suggestions.push('午休时段，浏览热榜问题，寻找可回答的问题');
    }
    if (currentHour >= 18 && currentHour < 22) {
      suggestions.push('晚间互动高峰期，积极回复评论增加权重');
    }
    if (currentHour >= 22) {
      suggestions.push('睡前整理今日数据，规划明日内容');
    }

    // 通用建议
    suggestions.push('定期回复评论，建立专业形象');
    suggestions.push('关注同领域优秀答主，学习优秀回答');

    return suggestions;
  }

  /**
   * 生成今日待办
   */
  private generateTodoList(currentHour: number, history: ZhihuAccountSnapshot[]): string[] {
    const todos: string[] = [];

    // 基于时间的待办
    if (currentHour < 10) {
      todos.push('查看热榜，寻找可回答的问题');
    }
    if (currentHour < 14) {
      todos.push('回答一个热榜相关问题');
    }
    if (currentHour < 18) {
      todos.push('回复评论，维护粉丝互动');
    }
    if (currentHour < 22) {
      todos.push('发布晚间内容（回答或文章）');
    }

    // 数据相关的待办
    if (history.length > 0) {
      const latest = history[history.length - 1];
      if (latest.answersToday === 0 && latest.articlesToday === 0) {
        todos.push('今日尚未发布内容，请尽快完成发布');
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
      items.push('黄金发布时段，确保内容已发布');
    }

    return items;
  }

  /**
   * 生成日报
   */
  generateDailyReport(history: ZhihuAccountSnapshot[]): ZhihuDailyReport {
    const today = new Date().toISOString().slice(0, 10);
    const todaySnapshot = history.find(h => h.date === today);
    const yesterdaySnapshot = history[history.length - 2];

    return {
      date: today,
      followerChange: todaySnapshot && yesterdaySnapshot
        ? todaySnapshot.followers - yesterdaySnapshot.followers
        : 0,
      articlesCount: todaySnapshot?.articlesToday || 0,
      answersCount: todaySnapshot?.answersToday || 0,
      totalInteractions: todaySnapshot?.interactionsToday || 0,
      interactionBreakdown: {
        voteups: 0,
        comments: 0,
        collects: 0,
      },
      completedTasks: 0,
      topAnswers: [],
    };
  }
}
