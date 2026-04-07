/**
 * 知乎运营指挥官 - 任务生成器
 *
 * 根据策略分析自动生成定时任务
 */

import { createLogger, type Logger } from '../core/logger.js';
import type {
  ZhihuAutoTaskDef,
  ZhihuOperationStrategy,
  ZhihuOperationTemplate,
  ZhihuContentType,
} from './zhihu-types.js';

/** 任务生成器配置 */
export interface ZhihuTaskGeneratorConfig {
  /** 每日最大发布文章数 */
  maxArticlesPerDay: number;
  /** 每日最大回答数 */
  maxAnswersPerDay: number;
  /** 每日最大回复数 */
  maxRepliesPerDay: number;
  /** 是否需要在执行前确认 */
  requireConfirmation: boolean;
}

/** 预设运营模板 */
export const ZHIHU_PRESET_TEMPLATES: ZhihuOperationTemplate[] = [
  {
    id: 'standard',
    name: '标准运营模板',
    description: '适合日常运营，均衡回答和文章',
    scenario: '日常账号运营',
    tasks: [
      {
        id: 'morning-browse',
        type: 'browse_hot',
        prompt: '【浏览热榜】查看知乎热榜，记录有价值的问题和话题。调用 zhihu hot 获取热榜，关注知识、职场、生活类问题。',
        schedule: '0 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'noon-answer',
        type: 'post_answer',
        prompt: '【午间回答】从热榜中选择一个适合的问题进行回答。步骤：1. 调用 zhihu hot 获取热榜；2. 选择一个匹配领域的问题；3. 调用 zhihu answer 发布回答。要求：回答专业、有深度，500-1000字。',
        schedule: '0 12',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 1,
      },
      {
        id: 'afternoon-interaction',
        type: 'reply_comments',
        prompt: '【下午互动】查看并回复评论。步骤：1. 检查近期回答的评论；2. 回复粉丝的问题和互动。要求：专业、友好，建立专业形象。',
        schedule: '0 16',
        enabled: true,
        source: 'template',
        priority: 6,
        maxPerDay: 10,
      },
      {
        id: 'evening-article',
        type: 'post_article',
        prompt: '【晚间文章】发布一篇专业文章。步骤：1. 根据今日热榜或领域热点确定主题；2. 撰写深度文章；3. 调用 zhihu article 发布。要求：标题吸引人，内容有深度，1500-3000字。',
        schedule: '0 20',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 1,
      },
      {
        id: 'night-summary',
        type: 'analyze_data',
        prompt: '【日报总结】整理今日运营数据。调用 zhihu profile 获取账号数据，对比昨日数据变化，记录粉丝增长、回答表现。',
        schedule: '30 22',
        enabled: true,
        source: 'template',
        priority: 4,
        maxPerDay: 1,
      },
    ],
  },
  {
    id: 'aggressive',
    name: '激进增长模板',
    description: '高频回答，快速获取曝光',
    scenario: '新账号冷启动或活动推广期',
    tasks: [
      {
        id: 'morning-answer-1',
        type: 'post_answer',
        prompt: '【早间回答1】从热榜中选择问题回答。要求：回答快速、有观点，500-800字。',
        schedule: '0 8',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 1,
      },
      {
        id: 'morning-answer-2',
        type: 'post_answer',
        prompt: '【早间回答2】搜索领域相关问题回答。步骤：1. 调用 zhihu search 搜索关键词；2. 选择合适问题；3. 发布回答。',
        schedule: '0 10',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 1,
      },
      {
        id: 'noon-interaction',
        type: 'reply_comments',
        prompt: '【午间互动】积极回复评论，增加账号活跃度。要求：快速回复，建立专业形象。',
        schedule: '0 12',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 15,
      },
      {
        id: 'afternoon-answer',
        type: 'post_answer',
        prompt: '【下午回答】选择专业领域问题深度回答。要求：专业、详细，800-1500字。',
        schedule: '0 15',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 1,
      },
      {
        id: 'evening-article',
        type: 'post_article',
        prompt: '【晚间文章】发布深度专业文章。要求：标题有吸引力，内容专业深度，2000-4000字。',
        schedule: '0 20',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 1,
      },
      {
        id: 'night-interaction',
        type: 'reply_comments',
        prompt: '【晚间互动高峰】黄金时段积极互动。要求：快速回复，增加账号权重。',
        schedule: '0 21',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 20,
      },
    ],
  },
  {
    id: 'minimal',
    name: '轻量维护模板',
    description: '最低频率维护账号活跃',
    scenario: '个人账号或精力有限时',
    tasks: [
      {
        id: 'daily-answer',
        type: 'post_answer',
        prompt: '【每日回答】回答一个热榜问题或领域问题。要求：简洁、专业，300-500字。',
        schedule: '0 20',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 1,
      },
      {
        id: 'daily-interaction',
        type: 'reply_comments',
        prompt: '【每日互动】回复重要的评论。要求：优先回复提问类评论。',
        schedule: '0 21',
        enabled: true,
        source: 'template',
        priority: 6,
        maxPerDay: 5,
      },
    ],
  },
  // API 测试模板
  {
    id: 'api_test',
    name: 'API 测试模板',
    description: '测试知乎 CLI API 的完整功能',
    scenario: '开发测试',
    tasks: [
      {
        id: 'test-profile',
        type: 'analyze_data',
        prompt: '[API测试] 获取知乎账号信息，返回用户ID、昵称、粉丝数、回答数、文章数、获赞数。',
        schedule: '0 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'test-hot',
        type: 'browse_hot',
        prompt: '[API测试] 获取知乎热榜，返回前 10 条热榜问题。',
        schedule: '5 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'test-search',
        type: 'search_questions',
        prompt: '[API测试] 搜索关键词"AI"，返回前 5 条搜索结果。',
        schedule: '10 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'test-question',
        type: 'analyze_data',
        prompt: '[API测试] 获取问题详情：先从热榜获取一个问题ID，再调用 zhihu question 获取问题详情和高赞回答。',
        schedule: '15 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'test-article-draft',
        type: 'post_article',
        prompt: '[API测试] 发布一篇测试文章草稿。标题"API测试文章-' + new Date().toISOString() + '"，正文"这是一篇测试文章，用于验证知乎文章发布功能。"，draft=true。',
        schedule: '30 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
    ],
  },
];

export class ZhihuTaskGenerator {
  private logger: Logger;
  private config: ZhihuTaskGeneratorConfig;

  constructor(config: ZhihuTaskGeneratorConfig) {
    this.config = config;
    this.logger = createLogger('ZhihuTaskGenerator');
  }

  /**
   * 获取预设模板列表
   */
  getAvailableTemplates(): ZhihuOperationTemplate[] {
    return ZHIHU_PRESET_TEMPLATES;
  }

  /**
   * 根据模板 ID 获取模板
   */
  getTemplate(templateId: string): ZhihuOperationTemplate | null {
    return ZHIHU_PRESET_TEMPLATES.find(t => t.id === templateId) || null;
  }

  /**
   * 根据策略生成动态任务
   */
  generateDynamicTasks(strategy: ZhihuOperationStrategy): ZhihuAutoTaskDef[] {
    const tasks: ZhihuAutoTaskDef[] = [];

    // 根据内容建议生成发布任务
    for (const suggestion of strategy.contentSuggestions.slice(0, 3)) {
      const task = this.createPublishTask(suggestion, strategy);
      if (task) {
        tasks.push(task);
      }
    }

    // 根据互动建议生成互动任务
    for (const interaction of strategy.interactionSuggestions.slice(0, 2)) {
      const task: ZhihuAutoTaskDef = {
        id: `dynamic-interaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'reply_comments',
        prompt: interaction,
        schedule: this.getSuitableTime(strategy.currentPhase, true),
        enabled: true,
        source: 'auto',
        priority: 6,
        maxPerDay: this.config.maxRepliesPerDay,
      };
      tasks.push(task);
    }

    this.logger.info(`生成 ${tasks.length} 个动态任务`);
    return tasks;
  }

  /**
   * 根据内容建议创建发布任务
   */
  private createPublishTask(suggestion: { type: ZhihuContentType; topic: string; direction: string; priority: number }, strategy: ZhihuOperationStrategy): ZhihuAutoTaskDef | null {
    const now = new Date();
    const hour = now.getHours();
    const minute = Math.floor(Math.random() * 30);

    // 根据内容类型决定是文章还是回答
    const isArticle = ['tutorial', 'knowledge', 'career'].includes(suggestion.type);

    // 构建任务
    let prompt = '';
    let type: 'post_article' | 'post_answer';

    if (isArticle) {
      type = 'post_article';
      prompt = `文章任务：${suggestion.topic}。方向：${suggestion.direction}。要求：标题有吸引力，内容专业深度，1500-3000字。`;
    } else {
      type = 'post_answer';
      prompt = `回答任务：${suggestion.topic}。方向：${suggestion.direction}。要求：从热榜中选择相关问题回答，回答专业有深度，500-1000字。`;
    }

    return {
      id: `dynamic-${type}-${Date.now()}`,
      type,
      prompt,
      schedule: this.getSuitableTime(strategy.currentPhase, false),
      enabled: true,
      source: 'auto',
      priority: suggestion.priority,
      maxPerDay: 1,
    };
  }

  /**
   * 获取适合的执行时间
   */
  private getSuitableTime(phase: string, isInteraction: boolean = false): string {
    const interactionTimes: Record<string, string> = {
      morning: '30 9',
      noon: '0 13',
      afternoon: '0 16',
      evening: '30 20',
      night: '0 22',
    };

    const postTimes: Record<string, string> = {
      morning: '0 10',
      noon: '0 14',
      afternoon: '0 17',
      evening: '0 20',
      night: '0 21',
    };

    return isInteraction ? interactionTimes[phase] || '0 12' : postTimes[phase] || '0 20';
  }

  /**
   * 合并模板任务和动态任务
   */
  mergeTasks(
    templateTasks: ZhihuAutoTaskDef[],
    dynamicTasks: ZhihuAutoTaskDef[],
    customTasks: ZhihuAutoTaskDef[] = []
  ): ZhihuAutoTaskDef[] {
    // 去重：动态任务不覆盖模板任务
    const templateIds = new Set(templateTasks.map(t => t.id));
    const filteredDynamic = dynamicTasks.filter(t => !templateIds.has(t.id));

    return [...templateTasks, ...filteredDynamic, ...customTasks];
  }
}
