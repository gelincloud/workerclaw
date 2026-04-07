/**
 * 抖音运营指挥官 - 任务生成器
 *
 * 根据策略分析自动生成定时任务
 */

import { createLogger, type Logger } from '../core/logger.js';
import type {
  DouyinAutoTaskDef,
  DouyinOperationStrategy,
  DouyinOperationTemplate,
  DouyinContentSuggestion,
  DouyinAutoTaskType,
} from './douyin-types.js';

/** 任务生成器配置 */
export interface DouyinTaskGeneratorConfig {
  /** 每日最大发布数 */
  maxPostsPerDay: number;
  /** 每日最大回复数 */
  maxRepliesPerDay: number;
  /** 是否需要在执行前确认 */
  requireConfirmation: boolean;
}

/** 预设运营模板 */
export const DOUYIN_PRESET_TEMPLATES: DouyinOperationTemplate[] = [
  {
    id: 'standard',
    name: '标准运营模板',
    description: '适合日常运营，均衡发布和互动',
    scenario: '日常账号运营',
    tasks: [
      {
        id: 'morning-browse',
        type: 'browse_hot',
        prompt: '【浏览热点】查看当前抖音热点词，记录有价值的话题，为今日内容做准备。调用 douyin hashtag hot 获取热点，关注娱乐、生活、科技类热点。',
        schedule: '0 8',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'noon-check-stats',
        type: 'check_stats',
        prompt: '【数据检查】查看最近发布视频的数据表现。步骤：1. 调用 douyin videos 获取作品列表；2. 选择最近3条视频，调用 douyin stats 分析数据。记录播放量、点赞数变化。',
        schedule: '0 12',
        enabled: true,
        source: 'template',
        priority: 6,
        maxPerDay: 1,
      },
      {
        id: 'evening-interaction',
        type: 'reply_comments',
        prompt: '【晚间互动】回复视频评论，增加粉丝粘性。步骤：1. 调用 douyin videos 获取自己作品；2. 查看评论数据（如可获取）；3. 积极回复粉丝互动。',
        schedule: '0 20',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 10,
      },
      {
        id: 'night-summary',
        type: 'analyze_data',
        prompt: '【日报总结】整理今日运营数据。调用 douyin profile 获取账号数据，对比昨日数据变化，记录粉丝增长、作品表现。',
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
    description: '高频互动，快速获取曝光',
    scenario: '新账号冷启动或活动推广期',
    tasks: [
      {
        id: 'morning-browse',
        type: 'browse_hot',
        prompt: '【早间热点】查看抖音热点词，寻找可蹭热点的话题。调用 douyin hashtag hot 获取热点，记录热门话题和创意方向。',
        schedule: '0 8',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 1,
      },
      {
        id: 'noon-interaction',
        type: 'reply_comments',
        prompt: '【午间互动】积极回复评论，增加账号活跃度。步骤：1. 获取自己的作品列表；2. 查看并回复评论。',
        schedule: '0 12',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 15,
      },
      {
        id: 'afternoon-check',
        type: 'check_stats',
        prompt: '【数据检查】下午检查今日数据表现。步骤：1. 获取账号信息 douyin profile；2. 获取作品列表 douyin videos；3. 分析表现最好的视频特征。',
        schedule: '0 15',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 1,
      },
      {
        id: 'evening-interaction',
        type: 'reply_comments',
        prompt: '【晚间互动高峰】黄金时段积极互动。步骤：1. 获取作品列表；2. 回复评论；3. 记录粉丝反馈。',
        schedule: '0 20',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 20,
      },
      {
        id: 'night-analysis',
        type: 'analyze_data',
        prompt: '【夜间分析】深度分析今日数据，规划明日策略。调用 douyin profile 和 douyin videos，总结今日增长情况。',
        schedule: '0 23',
        enabled: true,
        source: 'template',
        priority: 6,
        maxPerDay: 1,
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
        id: 'daily-check',
        type: 'check_stats',
        prompt: '【每日检查】检查账号数据。调用 douyin profile 获取粉丝数、作品数，记录变化趋势。',
        schedule: '0 20',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 1,
      },
      {
        id: 'daily-interaction',
        type: 'reply_comments',
        prompt: '【每日互动】回复重要的评论。步骤：1. 获取作品列表；2. 回复粉丝评论。',
        schedule: '0 21',
        enabled: true,
        source: 'template',
        priority: 6,
        maxPerDay: 5,
      },
    ],
  },
  {
    id: 'api_test',
    name: 'API 全量测试模板',
    description: '测试所有抖音 API 功能，每2分钟执行一次',
    scenario: 'API 功能全量测试',
    tasks: [
      // ===== 只读 API =====
      {
        id: 'api-test-profile',
        type: 'analyze_data',
        prompt: '【API测试】测试 douyin profile。调用平台 CLI: douyin profile，获取当前用户信息。返回: 用户ID+昵称+粉丝数+作品数。验证登录态有效。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-videos',
        type: 'analyze_data',
        prompt: '【API测试】测试 douyin videos。调用平台 CLI: douyin videos --limit 5，获取作品列表。返回: 视频ID+标题+播放量+点赞数。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-drafts',
        type: 'analyze_data',
        prompt: '【API测试】测试 douyin drafts。调用平台 CLI: douyin drafts，获取草稿列表。返回草稿数量。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-activities',
        type: 'analyze_data',
        prompt: '【API测试】测试 douyin activities。调用平台 CLI: douyin activities，获取官方活动列表。返回: 活动ID+标题+结束时间。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-collections',
        type: 'analyze_data',
        prompt: '【API测试】测试 douyin collections。调用平台 CLI: douyin collections，获取合集列表。返回: 合集ID+名称+视频数。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-hashtag-search',
        type: 'analyze_data',
        prompt: '【API测试】测试 douyin hashtag search。调用平台 CLI: douyin hashtag search 春游 --limit 5，搜索话题。返回: 话题名+ID+浏览量。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-hashtag-hot',
        type: 'analyze_data',
        prompt: '【API测试】测试 douyin hashtag hot。调用平台 CLI: douyin hashtag hot --limit 10，获取热点词。返回: 热点词+热度值。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-location',
        type: 'analyze_data',
        prompt: '【API测试】测试 douyin location。调用平台 CLI: douyin location 北京，搜索地理位置。返回: POI ID+名称。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-stats',
        type: 'analyze_data',
        prompt: '【API测试】测试 douyin stats。步骤：1. 先调用 douyin videos 获取一个视频ID；2. 再调用 douyin stats <视频ID> 获取数据分析。返回: 播放量+点赞+评论+分享趋势。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
    ],
  },
];

export class DouyinTaskGenerator {
  private logger: Logger;
  private config: DouyinTaskGeneratorConfig;

  constructor(config: DouyinTaskGeneratorConfig) {
    this.config = config;
    this.logger = createLogger('DouyinTaskGenerator');
  }

  /**
   * 从模板生成任务
   */
  fromTemplate(templateId: string): DouyinAutoTaskDef[] {
    const template = DOUYIN_PRESET_TEMPLATES.find((t) => t.id === templateId);
    if (!template) {
      this.logger.warn(`模板 ${templateId} 不存在，使用标准模板`);
      return DOUYIN_PRESET_TEMPLATES[0].tasks;
    }

    this.logger.info(`使用模板: ${template.name}`);
    return [...template.tasks];
  }

  /**
   * 根据策略动态生成任务
   */
  fromStrategy(strategy: DouyinOperationStrategy): DouyinAutoTaskDef[] {
    const tasks: DouyinAutoTaskDef[] = [];
    const now = new Date();
    const hour = now.getHours();

    // 根据内容建议生成发布任务
    for (const suggestion of strategy.contentSuggestions.slice(0, 3)) {
      const task = this.createPublishTask(suggestion);
      if (task) {
        tasks.push(task);
      }
    }

    // 根据互动建议生成互动任务
    if (strategy.interactionSuggestions.length > 0) {
      tasks.push({
        id: `interaction-${Date.now()}`,
        type: 'reply_comments',
        prompt: '【互动回复任务】步骤：1. 调用 douyin videos 获取自己的作品列表；2. 查看各视频的评论数据；3. 回复粉丝的问题和互动。要求：友好、专业的回复风格，优先回复粉丝提问。',
        schedule: `${Math.floor(Math.random() * 60)} ${hour + 1}`,
        enabled: true,
        source: 'auto',
        priority: 7,
        maxPerDay: this.config.maxRepliesPerDay,
      });
    }

    // 检查紧急事项
    for (const urgent of strategy.urgentItems) {
      if (urgent.includes('黄金时段')) {
        tasks.push({
          id: `urgent-check-${Date.now()}`,
          type: 'check_stats',
          prompt: '紧急检查：确认今日视频是否已发布，检查账号数据。调用 douyin profile 和 douyin videos。',
          schedule: `${now.getMinutes()} ${hour}`,
          enabled: true,
          source: 'auto',
          priority: 10,
          maxPerDay: 1,
        });
      }
    }

    this.logger.info(`动态生成 ${tasks.length} 个任务`);
    return tasks;
  }

  /**
   * 根据内容建议创建发布任务
   */
  private createPublishTask(suggestion: DouyinContentSuggestion): DouyinAutoTaskDef | null {
    const now = new Date();
    const hour = now.getHours();
    const minute = Math.floor(Math.random() * 30);

    // 确定发布时间
    let scheduleHour = hour + 1;
    if (hour >= 21) {
      scheduleHour = 20; // 太晚了就安排明天的黄金时段
    }

    // 根据内容类型构建 prompt
    let prompt = '';
    switch (suggestion.type) {
      case 'vlog':
        prompt = `Vlog 内容任务：${suggestion.topic}。方向：${suggestion.direction}。要求：真实记录，有故事性，适合短视频节奏。`;
        break;
      case 'knowledge':
        prompt = `知识科普任务：${suggestion.topic}。方向：${suggestion.direction}。要求：干货内容，通俗易懂，有教育价值。`;
        break;
      case 'entertainment':
        prompt = `娱乐内容任务：${suggestion.topic}。方向：${suggestion.direction}。要求：有趣有梗，引发共鸣，适合传播。`;
        break;
      case 'food':
        prompt = `美食内容任务：${suggestion.topic}。方向：${suggestion.direction}。要求：视觉诱人，有实用价值，引发食欲。`;
        break;
      case 'lifestyle':
        prompt = `生活分享任务：${suggestion.topic}。方向：${suggestion.direction}。要求：真实自然，引发共鸣，展示生活态度。`;
        break;
      default:
        prompt = `内容任务：${suggestion.topic}。${suggestion.direction}`;
    }

    return {
      id: `auto-${suggestion.type}-${Date.now()}`,
      type: 'publish_video',
      prompt,
      schedule: `${minute} ${scheduleHour}`,
      enabled: true,
      source: 'auto',
      priority: suggestion.priority,
      maxPerDay: 1,
    };
  }

  /**
   * 合并模板任务和动态任务
   */
  mergeTasks(templateTasks: DouyinAutoTaskDef[], dynamicTasks: DouyinAutoTaskDef[]): DouyinAutoTaskDef[] {
    // 去重策略：同类型同时段只保留一个
    const taskMap = new Map<string, DouyinAutoTaskDef>();

    // 先添加模板任务
    for (const task of templateTasks) {
      taskMap.set(task.id, task);
    }

    // 再添加/覆盖动态任务（动态优先）
    for (const task of dynamicTasks) {
      const key = `${task.type}-${task.schedule}`;
      const existing = Array.from(taskMap.values()).find(
        (t) => t.type === task.type && t.schedule === task.schedule
      );
      if (!existing || task.priority > existing.priority) {
        taskMap.set(task.id, task);
      }
    }

    // 检查每日上限
    const result = Array.from(taskMap.values());
    const postTasks = result.filter((t) => t.type === 'publish_video');

    // 如果发布任务超过每日上限，禁用低优先级的
    if (postTasks.length > this.config.maxPostsPerDay) {
      const sorted = [...postTasks].sort((a, b) => b.priority - a.priority);
      for (let i = this.config.maxPostsPerDay; i < sorted.length; i++) {
        const task = result.find((t) => t.id === sorted[i].id);
        if (task) {
          task.enabled = false;
          this.logger.debug(`禁用超出上限的任务: ${task.id}`);
        }
      }
    }

    return result;
  }

  /**
   * 获取所有预设模板
   */
  getAvailableTemplates(): DouyinOperationTemplate[] {
    return DOUYIN_PRESET_TEMPLATES;
  }

  /**
   * 根据场景推荐模板
   */
  recommendTemplate(scenario: string): DouyinOperationTemplate {
    switch (scenario) {
      case 'startup':
      case 'promotion':
        return DOUYIN_PRESET_TEMPLATES.find((t) => t.id === 'aggressive')!;
      case 'personal':
      case 'minimal':
        return DOUYIN_PRESET_TEMPLATES.find((t) => t.id === 'minimal')!;
      default:
        return DOUYIN_PRESET_TEMPLATES.find((t) => t.id === 'standard')!;
    }
  }
}
