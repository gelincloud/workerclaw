/**
 * 微博运营指挥官 - 策略分析引擎
 *
 * 分析采集的数据，生成运营策略建议
 */

import { createLogger, type Logger } from '../core/logger.js';
import { LLMClient } from '../agent/llm-client.js';
import type { LLMConfig } from '../core/config.js';
import type { DataCollector } from './data-collector.js';
import type {
  WeiboAccountSnapshot,
  WeiboHotSearch,
  InteractionData,
  OperationStrategy,
  ContentSuggestion,
  PostingTimeSuggestion,
  ContentType,
  DailyReport,
} from './types.js';

/** 策略分析器配置 */
export interface StrategyEngineConfig {
  /** 使用的 LLM 配置 */
  llmConfig: LLMConfig;
  /** 账号人设描述 */
  persona?: string;
  /** 运营目标 */
  goals?: string[];
  /** 内容偏好 */
  contentPreferences?: ContentType[];
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
  morning: '早间(6-10点) - 通勤时段，适合轻松内容',
  noon: '午间(10-14点) - 午休时段，适合热点追踪',
  afternoon: '下午(14-18点) - 工作时段，适合专业内容',
  evening: '晚间(18-22点) - 休闲时段，黄金发布期',
  night: '夜间(22-6点) - 深夜时段，适合深度内容',
};

export class StrategyEngine {
  private logger: Logger;
  private llm: LLMClient;
  private config: StrategyEngineConfig;
  private dataCollector: DataCollector;

  constructor(config: StrategyEngineConfig, dataCollector: DataCollector) {
    this.config = config;
    this.dataCollector = dataCollector;
    this.llm = new LLMClient(config.llmConfig);
    this.logger = createLogger('StrategyEngine');
  }

  /**
   * 分析并生成运营策略
   */
  async analyze(): Promise<OperationStrategy> {
    this.logger.info('开始策略分析...');

    const now = new Date();
    const hour = now.getHours();
    const currentPhase = getCurrentPhase(hour);

    // 获取数据
    const accountHistory = this.dataCollector.getAccountHistory(7);
    const latestTrending = this.dataCollector.getLatestTrending();
    const followerTrend = this.dataCollector.getFollowerTrend(7);

    // 生成发布时机建议
    const postingTimes = this.generatePostingTimes(hour, accountHistory);

    // 生成内容建议
    const contentSuggestions = await this.generateContentSuggestions(
      latestTrending,
      accountHistory,
      currentPhase
    );

    // 生成互动建议
    const interactionSuggestions = this.generateInteractionSuggestions(hour);

    // 生成今日待办
    const todoList = this.generateTodoList(hour, accountHistory);

    // 生成紧急事项
    const urgentItems = this.generateUrgentItems(hour);

    const strategy: OperationStrategy = {
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
    history: WeiboAccountSnapshot[]
  ): PostingTimeSuggestion[] {
    const suggestions: PostingTimeSuggestion[] = [];

    // 微博最佳发布时段（基于平台数据）
    const bestTimes = [
      { time: '08:00', reason: '早间通勤高峰，用户刷微博打发时间', score: 8, types: ['daily_share', 'knowledge'] as ContentType[] },
      { time: '12:00', reason: '午休时段，活跃度较高', score: 7, types: ['hot_comment', 'interaction'] as ContentType[] },
      { time: '18:00', reason: '下班高峰，黄金发布期', score: 9, types: ['original', 'hot_comment'] as ContentType[] },
      { time: '21:00', reason: '晚间休闲，用户活跃度最高', score: 10, types: ['original', 'interaction', 'activity'] as ContentType[] },
      { time: '23:00', reason: '深夜时段，适合深度内容', score: 6, types: ['knowledge', 'original'] as ContentType[] },
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
        reason: '明早通勤高峰（次日）',
        expectedScore: 8,
        suitableContentTypes: ['daily_share', 'knowledge'],
      });
    }

    return suggestions;
  }

  /**
   * 生成内容建议（使用 LLM 增强）
   */
  private async generateContentSuggestions(
    trending: WeiboHotSearch | null,
    history: WeiboAccountSnapshot[],
    phase: string
  ): Promise<ContentSuggestion[]> {
    const suggestions: ContentSuggestion[] = [];

    // 基于热搜生成建议
    if (trending?.topics?.length) {
      const topTrends = trending.topics.slice(0, 10);
      
      // 选择 2-3 个热门话题
      const selectedTrends = topTrends
        .filter(t => t.hotValue > 100000) // 过滤低热度
        .slice(0, 3);

      for (const trend of selectedTrends) {
        suggestions.push({
          type: 'hot_comment',
          topic: trend.topic,
          direction: `围绕"${trend.topic}"发表观点或评论，结合自身领域进行解读`,
          relatedTrends: [trend.topic],
          priority: 8,
          reason: `热搜排名 #${trend.rank}，热度 ${this.formatHotValue(trend.hotValue)}`,
        });
      }
    }

    // 根据时段添加常规内容建议
    const phaseContent = this.getPhaseContentSuggestions(phase);
    suggestions.push(...phaseContent);

    // 基于历史数据分析（如果数据不足）
    if (history.length < 3) {
      suggestions.push({
        type: 'original',
        topic: '领域干货分享',
        direction: '分享专业知识或经验，建立专业形象',
        priority: 7,
        reason: '数据积累不足，建议先发布原创内容建立基础',
      });
    }

    // 使用 LLM 进行智能分析（可选）
    if (this.config.llmConfig && trending?.topics?.length) {
      try {
        const llmSuggestions = await this.getLLMContentSuggestions(trending);
        if (llmSuggestions.length > 0) {
          suggestions.push(...llmSuggestions.slice(0, 2));
        }
      } catch (err) {
        this.logger.warn('LLM 内容建议生成失败', (err as Error).message);
      }
    }

    // 去重并排序
    return this.deduplicateAndSort(suggestions);
  }

  /**
   * 获取时段内容建议
   */
  private getPhaseContentSuggestions(phase: string): ContentSuggestion[] {
    const suggestions: ContentSuggestion[] = [];

    switch (phase) {
      case 'morning':
        suggestions.push({
          type: 'daily_share',
          topic: '早安打卡',
          direction: '分享今日计划或心情，与粉丝互动',
          priority: 6,
          reason: '早间适合轻松互动内容',
        });
        break;

      case 'noon':
        suggestions.push({
          type: 'interaction',
          topic: '午间话题',
          direction: '发起投票或问答，增加互动',
          priority: 7,
          reason: '午休时段用户有时间参与互动',
        });
        break;

      case 'afternoon':
        suggestions.push({
          type: 'knowledge',
          topic: '专业知识',
          direction: '分享行业见解或干货',
          priority: 7,
          reason: '下午适合深度内容',
        });
        break;

      case 'evening':
        suggestions.push({
          type: 'original',
          topic: '原创内容',
          direction: '发布有价值的原创内容',
          priority: 9,
          reason: '晚间是黄金发布时段',
        });
        break;

      case 'night':
        suggestions.push({
          type: 'retweet',
          topic: '精选转发',
          direction: '转发优质内容并加评',
          priority: 5,
          reason: '深夜可转发优质内容保持活跃',
        });
        break;
    }

    return suggestions;
  }

  /**
   * 使用 LLM 生成内容建议
   */
  private async getLLMContentSuggestions(trending: WeiboHotSearch): Promise<ContentSuggestion[]> {
    const topTrends = trending.topics.slice(0, 5).map(t => t.topic).join(', ');
    const persona = this.config.persona || '一个专业的内容创作者';

    const prompt = `你是一个微博运营助手。账号人设：${persona}

当前热搜话题：${topTrends}

请给出 2 条具体的内容发布建议，每条包含：
1. 内容类型（hot_comment/daily_share/knowledge/interaction/original 之一）
2. 建议话题
3. 内容方向描述
4. 优先级(1-10)

以 JSON 数组格式返回，格式：
[{"type":"xxx","topic":"xxx","direction":"xxx","priority":8}]`;

    try {
      const response = await this.llm.chat({
        messages: [
          { role: 'system', content: '你是一个专业的微博运营助手，擅长内容规划和话题分析。' },
          { role: 'user', content: prompt },
        ],
      });

      // 解析 JSON
      const content = response.content;
      if (typeof content === 'string') {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return parsed.map((p: any) => ({
            type: p.type || 'original',
            topic: p.topic || '',
            direction: p.direction || '',
            priority: p.priority || 5,
            reason: 'LLM 分析建议',
          }));
        }
      }
    } catch (err) {
      this.logger.debug('LLM 响应解析失败', (err as Error).message);
    }

    return [];
  }

  /**
   * 生成互动建议
   */
  private generateInteractionSuggestions(hour: number): string[] {
    const suggestions: string[] = [];

    // 回复评论
    suggestions.push('回复最近的评论，特别是粉丝的提问');

    // 根据时段
    if (hour >= 10 && hour < 12) {
      suggestions.push('检查昨晚的微博互动情况');
    }
    if (hour >= 14 && hour < 16) {
      suggestions.push('主动点赞和评论相关领域博主的内容');
    }
    if (hour >= 20) {
      suggestions.push('参与热门话题讨论，增加曝光');
    }

    // 粉丝维护
    suggestions.push('关注新粉丝中活跃度高的用户');
    suggestions.push('感谢粉丝的支持和互动');

    return suggestions;
  }

  /**
   * 生成今日待办
   */
  private generateTodoList(hour: number, history: WeiboAccountSnapshot[]): string[] {
    const todos: string[] = [];

    // 发布内容
    if (hour < 21) {
      todos.push('发布 1-2 条原创/评论内容');
    }

    // 互动维护
    todos.push('回复评论和私信');
    todos.push('查看热搜，寻找热点机会');

    // 数据检查
    if (hour >= 18) {
      todos.push('检查今日数据表现');
    }

    // 基于历史
    const todayHistory = history.filter(h => h.date === new Date().toISOString().split('T')[0]);
    if (todayHistory.length === 0 || todayHistory.every(h => h.postsToday === 0)) {
      todos.unshift('⚠️ 今日尚未发布内容');
    }

    return todos;
  }

  /**
   * 生成紧急事项
   */
  private generateUrgentItems(hour: number): string[] {
    const urgent: string[] = [];

    // 检查是否有未回复的重要互动
    // 这里可以接入更多检测逻辑

    if (hour >= 21 && hour < 23) {
      urgent.push('晚间黄金时段即将结束，尽快发布内容');
    }

    return urgent;
  }

  /**
   * 生成日报
   */
  generateDailyReport(history: WeiboAccountSnapshot[]): DailyReport {
    const today = new Date().toISOString().split('T')[0];
    const todayData = history.filter(h => h.date === today);
    
    if (todayData.length === 0) {
      return {
        date: today,
        followerChange: 0,
        postsCount: 0,
        totalInteractions: 0,
        interactionBreakdown: { likes: 0, comments: 0, reposts: 0 },
        completedTasks: 0,
        topPosts: [],
        notes: '今日暂无数据',
      };
    }

    const latest = todayData[todayData.length - 1];
    const earliest = todayData[0];

    return {
      date: today,
      followerChange: latest.newFollowersToday,
      postsCount: latest.postsToday,
      totalInteractions: latest.interactionsToday,
      interactionBreakdown: { likes: 0, comments: 0, reposts: 0 }, // 需要更详细数据
      completedTasks: 0, // 需要任务执行记录
      topPosts: [], // 需要微博详情数据
    };
  }

  // ==================== 工具方法 ====================

  private formatHotValue(value: number): string {
    if (value >= 10000000) return `${(value / 10000000).toFixed(1)}千万`;
    if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
    return value.toString();
  }

  private deduplicateAndSort(suggestions: ContentSuggestion[]): ContentSuggestion[] {
    // 按话题去重
    const seen = new Set<string>();
    const unique: ContentSuggestion[] = [];

    for (const s of suggestions) {
      const key = `${s.type}:${s.topic}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(s);
      }
    }

    // 按优先级排序
    return unique.sort((a, b) => b.priority - a.priority);
  }
}
