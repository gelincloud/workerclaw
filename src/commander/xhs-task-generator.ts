/**
 * 小红书运营指挥官 - 任务生成器
 *
 * 根据策略分析自动生成定时任务
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { 
  XhsAutoTaskDef, 
  XhsOperationStrategy, 
  XhsOperationTemplate,
  XhsAutoTaskType 
} from './xhs-types.js';

/** 任务生成器配置 */
export interface XhsTaskGeneratorConfig {
  /** 每日最大发布数 */
  maxPostsPerDay: number;
  /** 每日最大回复数 */
  maxRepliesPerDay: number;
  /** 是否需要在执行前确认 */
  requireConfirmation: boolean;
}

/** 预设运营模板 */
export const XHS_PRESET_TEMPLATES: XhsOperationTemplate[] = [
  {
    id: 'standard',
    name: '标准运营模板',
    description: '适合日常运营，均衡发布和互动',
    scenario: '日常账号运营',
    tasks: [
      {
        id: 'morning-post',
        type: 'post_note',
        prompt: '现在是早间时段（8点），浏览小红书热门推荐，选择一个热门话题创作图文笔记。要求：结合热门话题，标题吸引人（不超过20字），正文150-300字，最后添加3-5个相关话题标签。',
        schedule: '0 8',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 1,
      },
      {
        id: 'noon-reply',
        type: 'reply_comments',
        prompt: '检查笔记评论，回复粉丝的提问和互动。要求：友好、专业的回复风格，每条回复 20-50 字，最多回复 5 条评论。',
        schedule: '0 12',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 5,
      },
      {
        id: 'afternoon-browse',
        type: 'browse_hot',
        prompt: '浏览小红书热门推荐页面，记录有价值的内容选题和创作灵感。要求：关注生活方式、知识科普、好物种草类内容，记录选题方向。',
        schedule: '30 14',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'evening-post',
        type: 'post_note',
        prompt: '现在是晚间黄金时段（20点），发布一条原创图文笔记。要求：可以是生活分享、好物推荐或干货知识，标题有吸引力，正文 200-400 字，配图建议（描述图片内容），添加相关话题标签。',
        schedule: '0 20',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 1,
      },
      {
        id: 'night-interaction',
        type: 'reply_comments',
        prompt: '晚间互动时段（22点），回复今天的评论。要求：积极回复粉丝互动，增加用户粘性，最多处理 10 条评论。',
        schedule: '0 22',
        enabled: true,
        source: 'template',
        priority: 6,
        maxPerDay: 10,
      },
    ],
  },
  {
    id: 'aggressive',
    name: '激进增长模板',
    description: '高频发布，快速获取曝光',
    scenario: '新账号冷启动或活动推广期',
    tasks: [
      {
        id: 'morning-post-1',
        type: 'post_note',
        prompt: '早间第一条（8点）：结合热门话题发布笔记。要求：紧跟热点，标题有爆点，内容有观点。',
        schedule: '0 8',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 1,
      },
      {
        id: 'morning-post-2',
        type: 'post_note',
        prompt: '早间第二条（10点）：分享干货知识或经验。要求：实用性强，建立专业形象。',
        schedule: '0 10',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 1,
      },
      {
        id: 'noon-interaction',
        type: 'reply_comments',
        prompt: '午间互动（12点）：回复所有评论，主动互动。要求：积极回复，建立粉丝关系。',
        schedule: '0 12',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 15,
      },
      {
        id: 'afternoon-post',
        type: 'post_note',
        prompt: '下午内容（15点）：发布好物推荐或种草笔记。要求：真实体验感，产品卖点清晰。',
        schedule: '0 15',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 1,
      },
      {
        id: 'evening-post-1',
        type: 'post_note',
        prompt: '晚间第一条（18点）：发布生活分享或 vlog 风格笔记。要求：轻松有趣，贴近生活。',
        schedule: '0 18',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 1,
      },
      {
        id: 'evening-post-2',
        type: 'post_note',
        prompt: '晚间第二条（21点）：发布深度内容或干货教程。要求：有价值、可收藏的内容。',
        schedule: '0 21',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 1,
      },
    ],
  },
  {
    id: 'minimal',
    name: '轻量维护模板',
    description: '适合忙碌时期，保持基本活跃',
    scenario: '时间有限，维持账号活跃度',
    tasks: [
      {
        id: 'daily-post',
        type: 'post_note',
        prompt: '每日一条笔记：发布日常分享或好物推荐。要求：简单直接，保持更新频率。',
        schedule: '0 20',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 1,
      },
      {
        id: 'daily-reply',
        type: 'reply_comments',
        prompt: '每日回复评论：处理重要评论和私信。要求：优先回复提问类评论。',
        schedule: '0 21',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 5,
      },
    ],
  },
  // API 测试模板
  {
    id: 'api_test',
    name: 'API 测试模板',
    description: '测试小红书 CLI API 的完整功能',
    scenario: '开发测试',
    tasks: [
      {
        id: 'test-profile',
        type: 'analyze_data',
        prompt: '[API测试] 获取创作者账号信息，返回粉丝数、关注数、获赞数等数据。',
        schedule: '0 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'test-stats',
        type: 'analyze_data',
        prompt: '[API测试] 获取创作者 7 天统计数据，包括观看、点赞、收藏、评论、分享、涨粉数据。',
        schedule: '5 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'test-notes',
        type: 'analyze_data',
        prompt: '[API测试] 获取创作者笔记列表，返回最近 5 条笔记的标题、日期、互动数据。',
        schedule: '10 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'test-hot',
        type: 'browse_hot',
        prompt: '[API测试] 获取小红书首页推荐 Feed，返回前 10 条笔记的标题、作者、点赞数。',
        schedule: '15 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'test-search',
        type: 'browse_hot',
        prompt: '[API测试] 搜索关键词"AI工具"，返回前 5 条笔记的标题、作者、点赞数。',
        schedule: '20 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'test-post',
        type: 'post_note',
        prompt: '[API测试] 发布一条测试笔记 - 时间戳:' + new Date().toISOString() + '。要求：标题"API测试笔记"，正文说明这是测试发布功能，添加话题标签#测试',
        schedule: '30 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
    ],
  },
];

export class XhsTaskGenerator {
  private logger: Logger;
  private config: XhsTaskGeneratorConfig;

  constructor(config: XhsTaskGeneratorConfig) {
    this.config = config;
    this.logger = createLogger('XhsTaskGenerator');
  }

  /**
   * 获取预设模板列表
   */
  getAvailableTemplates(): XhsOperationTemplate[] {
    return XHS_PRESET_TEMPLATES;
  }

  /**
   * 根据模板 ID 获取模板
   */
  getTemplate(templateId: string): XhsOperationTemplate | null {
    return XHS_PRESET_TEMPLATES.find(t => t.id === templateId) || null;
  }

  /**
   * 根据策略生成动态任务
   */
  generateDynamicTasks(strategy: XhsOperationStrategy): XhsAutoTaskDef[] {
    const tasks: XhsAutoTaskDef[] = [];

    // 根据内容建议生成发布任务
    for (const suggestion of strategy.contentSuggestions.slice(0, 3)) {
      const task: XhsAutoTaskDef = {
        id: `dynamic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'post_note',
        prompt: `根据策略建议创作笔记。类型：${suggestion.type}，主题：${suggestion.topic}。方向：${suggestion.direction}。优先级：${suggestion.priority}。理由：${suggestion.reason}`,
        schedule: this.getSuitableTime(strategy.currentPhase),
        enabled: true,
        source: 'auto',
        priority: suggestion.priority,
        maxPerDay: 1,
      };
      tasks.push(task);
    }

    // 根据互动建议生成互动任务
    for (const interaction of strategy.interactionSuggestions.slice(0, 2)) {
      const task: XhsAutoTaskDef = {
        id: `dynamic-interaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'reply_comments',
        prompt: interaction,
        schedule: this.getSuitableTime(strategy.currentPhase, true),
        enabled: true,
        source: 'auto',
        priority: 6,
        maxPerDay: 5,
      };
      tasks.push(task);
    }

    this.logger.info(`生成 ${tasks.length} 个动态任务`);
    return tasks;
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
    templateTasks: XhsAutoTaskDef[],
    dynamicTasks: XhsAutoTaskDef[],
    customTasks: XhsAutoTaskDef[] = []
  ): XhsAutoTaskDef[] {
    // 去重：动态任务不覆盖模板任务
    const templateIds = new Set(templateTasks.map(t => t.id));
    const filteredDynamic = dynamicTasks.filter(t => !templateIds.has(t.id));

    return [...templateTasks, ...filteredDynamic, ...customTasks];
  }
}
