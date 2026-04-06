/**
 * 微博运营指挥官 - 任务生成器
 *
 * 根据策略分析自动生成定时任务
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { 
  AutoTaskDef, 
  OperationStrategy, 
  OperationTemplate,
  ContentSuggestion,
  AutoTaskType 
} from './types.js';

/** 任务生成器配置 */
export interface TaskGeneratorConfig {
  /** 每日最大发布数 */
  maxPostsPerDay: number;
  /** 每日最大回复数 */
  maxRepliesPerDay: number;
  /** 是否需要在执行前确认 */
  requireConfirmation: boolean;
}

/** 预设运营模板 */
export const PRESET_TEMPLATES: OperationTemplate[] = [
  {
    id: 'standard',
    name: '标准运营模板',
    description: '适合日常运营，均衡发布和互动',
    scenario: '日常账号运营',
    tasks: [
      {
        id: 'morning-post',
        type: 'post_content',
        prompt: '现在是早间时段，查看当前热搜，选择一个相关话题发布评论性微博。要求：结合热搜话题，发表有观点的内容，字数 100-200 字。',
        schedule: '0 8',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 1,
      },
      {
        id: 'noon-reply',
        type: 'reply_comments',
        prompt: '检查最近的微博评论，回复粉丝的问题和互动。要求：友好、专业的回复风格，每条回复 20-50 字，最多回复 5 条。',
        schedule: '0 12',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 5,
      },
      {
        id: 'afternoon-browse',
        type: 'browse_trends',
        prompt: '浏览当前热搜榜，记录有价值的热点话题，为后续内容做准备。要求：关注娱乐、科技、社会类热点，记录话题和角度。',
        schedule: '30 14',
        enabled: true,
        source: 'template',
        priority: 5,
        maxPerDay: 1,
      },
      {
        id: 'evening-post',
        type: 'post_content',
        prompt: '现在是晚间黄金时段，发布一条原创内容。要求：可以是行业见解、生活感悟或热点评论，字数 150-300 字，配上表情增加亲和力。',
        schedule: '0 20',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 1,
      },
      {
        id: 'night-interaction',
        type: 'reply_comments',
        prompt: '晚间互动时段，回复今天的评论和私信。要求：及时回复粉丝互动，增加用户粘性，最多处理 10 条。',
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
        type: 'post_content',
        prompt: '早间第一条：结合热搜发布热点评论。要求：紧跟热点，观点鲜明，引发讨论。',
        schedule: '0 8',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 1,
      },
      {
        id: 'morning-post-2',
        type: 'post_content',
        prompt: '早间第二条：分享行业知识或经验。要求：干货内容，建立专业形象。',
        schedule: '0 10',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 1,
      },
      {
        id: 'noon-interaction',
        type: 'reply_comments',
        prompt: '午间互动：回复所有评论和私信，主动互动。要求：积极回复，建立粉丝关系。',
        schedule: '0 12',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 15,
      },
      {
        id: 'afternoon-post',
        type: 'post_content',
        prompt: '下午内容：转发优质内容并加评论。要求：转发领域内优质内容，添加有价值点评。',
        schedule: '0 15',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 1,
      },
      {
        id: 'evening-post-1',
        type: 'post_content',
        prompt: '晚间第一条：发布原创深度内容。要求：有观点、有价值的内容，增加转发。',
        schedule: '0 18',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 1,
      },
      {
        id: 'evening-post-2',
        type: 'post_content',
        prompt: '晚间第二条：参与热点讨论。要求：结合当晚热点，发表评论或观点。',
        schedule: '0 21',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 1,
      },
      {
        id: 'night-follow',
        type: 'follow_back',
        prompt: '回关活跃粉丝。要求：查看今天的新粉丝，回关有质量的账号，最多 10 个。',
        schedule: '30 22',
        enabled: true,
        source: 'template',
        priority: 6,
        maxPerDay: 10,
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
        id: 'daily-post',
        type: 'post_content',
        prompt: '每日一条：发布一条有价值的内容。要求：可以是热点评论或日常分享，保持账号活跃。',
        schedule: '0 20',
        enabled: true,
        source: 'template',
        priority: 7,
        maxPerDay: 1,
      },
      {
        id: 'daily-reply',
        type: 'reply_comments',
        prompt: '每日互动：回复重要的评论和私信。要求：优先回复粉丝提问，最多 5 条。',
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
    description: '测试所有微博 API 功能，每2分钟执行一次，符合调度器频率限制',
    scenario: 'API 功能全量测试',
    tasks: [
      // ===== 只读 API (FETCH) - 每2分钟 =====
      {
        id: 'api-test-hot-search',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo hot_search。调用平台 CLI: weibo hot_search，获取热搜前10。返回: 话题名+热度值。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-search',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo search。调用平台 CLI: weibo search，关键词"科技"，获取5条结果。返回: 微博ID+摘要。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },

      // ===== 只读 API (AUTH) - 每2分钟 =====
      {
        id: 'api-test-me',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo me。调用平台 CLI: weibo me，获取当前用户信息。返回: 用户ID+昵称+粉丝数+微博数。验证登录态有效。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-feed',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo feed。调用平台 CLI: weibo feed，获取首页时间线5条。返回: 微博ID+作者+内容摘要。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-get',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo get。先执行 weibo feed 获取一条微博ID，再调用 weibo get 获取详情。返回: 完整内容+转发/评论/点赞数。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-comments',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo comments。先获取一条微博ID(从feed)，再调用 weibo comments 获取评论列表。返回: 评论者+内容+时间。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-mentions',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo mentions。调用平台 CLI: weibo mentions，获取@我的微博。返回: 微博ID+提及者+内容。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-messages',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo messages。调用平台 CLI: weibo messages，获取私信列表。返回: 发送者+内容+时间。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-followers',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo followers。调用平台 CLI: weibo followers，获取粉丝列表10条。返回: 粉丝ID+昵称。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-following',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo following。调用平台 CLI: weibo following，获取关注列表10条。返回: 关注者ID+昵称。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },
      {
        id: 'api-test-profile',
        type: 'analyze_data',
        prompt: '【API测试】测试 weibo profile。调用平台 CLI: weibo profile，获取用户详细资料。返回: 完整用户信息。成功则标记✅',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 10,
        maxPerDay: 30,
      },

      // ===== 写操作 API - 每2分钟，限制频率 =====
      {
        id: 'api-test-post',
        type: 'post_content',
        prompt: '【API测试】测试 weibo post。调用平台 CLI: weibo post，发布测试微博。内容格式: "[API测试] 发布功能测试 - 时间戳:当前时间"。成功返回微博ID并标记✅，失败记录错误❌。注意：真实发布！',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 30,
      },
      {
        id: 'api-test-comment',
        type: 'reply_comments',
        prompt: '【API测试】测试 weibo comment。先通过 weibo feed 获取自己最新微博ID，再调用 weibo comment 评论。内容: "[API测试] 评论测试 - 时间戳:当前时间"。成功返回评论ID✅，失败记录错误❌。',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 30,
      },
      {
        id: 'api-test-like',
        type: 'like_posts',
        prompt: '【API测试】测试 weibo like。先通过 weibo feed 获取一条微博ID(非自己的)，调用 weibo like 点赞。成功标记✅，失败记录错误❌。注意：真实点赞！',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 30,
      },
      {
        id: 'api-test-retweet',
        type: 'post_content',
        prompt: '【API测试】测试 weibo retweet。先通过 weibo feed 获取一条微博ID，调用 weibo retweet 转发。评论内容: "[API测试] 转发测试"。成功返回转发ID✅，失败记录错误❌。注意：真实转发！',
        schedule: '*/2 *',
        enabled: true,
        source: 'template',
        priority: 9,
        maxPerDay: 30,
      },
      {
        id: 'api-test-follow',
        type: 'follow_back',
        prompt: '【API测试】测试 weibo follow。先通过 weibo followers 获取一个粉丝ID，调用 weibo follow 关注(如已关注则跳过)。成功标记✅，失败记录错误❌。注意：真实关注！',
        schedule: '*/3 *',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 20,
      },
      {
        id: 'api-test-send-message',
        type: 'reply_comments',
        prompt: '【API测试】测试 weibo send_message。先通过 weibo followers 获取一个粉丝ID，调用 weibo send_message 发送私信。内容: "[API测试] 私信功能测试"。成功标记✅，失败记录错误❌。注意：真实私信！',
        schedule: '*/3 *',
        enabled: true,
        source: 'template',
        priority: 8,
        maxPerDay: 20,
      },
    ],
  },
];

export class TaskGenerator {
  private logger: Logger;
  private config: TaskGeneratorConfig;

  constructor(config: TaskGeneratorConfig) {
    this.config = config;
    this.logger = createLogger('TaskGenerator');
  }

  /**
   * 从模板生成任务
   */
  fromTemplate(templateId: string): AutoTaskDef[] {
    const template = PRESET_TEMPLATES.find(t => t.id === templateId);
    if (!template) {
      this.logger.warn(`模板 ${templateId} 不存在，使用标准模板`);
      return PRESET_TEMPLATES[0].tasks;
    }

    this.logger.info(`使用模板: ${template.name}`);
    return [...template.tasks];
  }

  /**
   * 根据策略动态生成任务
   */
  fromStrategy(strategy: OperationStrategy): AutoTaskDef[] {
    const tasks: AutoTaskDef[] = [];
    const now = new Date();
    const hour = now.getHours();

    // 根据内容建议生成发布任务
    for (const suggestion of strategy.contentSuggestions.slice(0, 3)) {
      const task = this.createPostTask(suggestion);
      if (task) {
        tasks.push(task);
      }
    }

    // 根据互动建议生成互动任务
    if (strategy.interactionSuggestions.length > 0) {
      tasks.push({
        id: `interaction-${Date.now()}`,
        type: 'reply_comments',
        prompt: '检查并回复最近的评论和私信。要求：友好专业的回复风格，优先回复粉丝提问。',
        schedule: `${Math.floor(Math.random() * 60)} ${hour + 1}`, // 下一个小时
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
          id: `urgent-post-${Date.now()}`,
          type: 'post_content',
          prompt: '紧急发布：立即发布一条内容抓住当前时段。要求：可以是热点评论或简短分享，尽快发布。',
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
  private createPostTask(suggestion: ContentSuggestion): AutoTaskDef | null {
    const now = new Date();
    const hour = now.getHours();
    const minute = Math.floor(Math.random() * 30); // 随机分钟，避免整点

    // 确定发布时间
    let scheduleHour = hour + 1; // 默认下一小时
    if (hour >= 21) {
      scheduleHour = 20; // 太晚了就安排明天的黄金时段
    }

    // 根据内容类型构建 prompt
    let prompt = '';
    switch (suggestion.type) {
      case 'hot_comment':
        prompt = `热点评论任务：围绕"${suggestion.topic}"发表观点。方向：${suggestion.direction}。要求：观点鲜明，引发讨论，100-200字。`;
        break;
      case 'original':
        prompt = `原创内容任务：${suggestion.topic}。方向：${suggestion.direction}。要求：有独特观点或价值，150-300字。`;
        break;
      case 'knowledge':
        prompt = `知识分享任务：${suggestion.topic}。方向：${suggestion.direction}。要求：专业干货，可适当长文，配图更好。`;
        break;
      case 'interaction':
        prompt = `互动内容任务：${suggestion.topic}。方向：${suggestion.direction}。要求：引发用户参与，可以是投票、提问或话题讨论。`;
        break;
      case 'daily_share':
        prompt = `日常分享任务：${suggestion.topic}。方向：${suggestion.direction}。要求：轻松真实，增加人设亲和力。`;
        break;
      case 'retweet':
        prompt = `转发评论任务：寻找"${suggestion.topic}"相关的优质微博转发并添加评论。要求：评论有观点，增加价值。`;
        break;
      default:
        prompt = `内容发布任务：${suggestion.topic}。${suggestion.direction}`;
    }

    return {
      id: `auto-${suggestion.type}-${Date.now()}`,
      type: 'post_content',
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
  mergeTasks(
    templateTasks: AutoTaskDef[], 
    dynamicTasks: AutoTaskDef[]
  ): AutoTaskDef[] {
    // 去重策略：同类型同时段只保留一个
    const taskMap = new Map<string, AutoTaskDef>();

    // 先添加模板任务
    for (const task of templateTasks) {
      taskMap.set(task.id, task);
    }

    // 再添加/覆盖动态任务（动态优先）
    for (const task of dynamicTasks) {
      const key = `${task.type}-${task.schedule}`;
      // 如果已有同类同时段任务，保留优先级高的
      const existing = Array.from(taskMap.values()).find(
        t => t.type === task.type && t.schedule === task.schedule
      );
      if (!existing || task.priority > existing.priority) {
        taskMap.set(task.id, task);
      }
    }

    // 检查每日上限
    const result = Array.from(taskMap.values());
    const postTasks = result.filter(t => t.type === 'post_content');
    
    // 如果发布任务超过每日上限，禁用低优先级的
    if (postTasks.length > this.config.maxPostsPerDay) {
      const sorted = [...postTasks].sort((a, b) => b.priority - a.priority);
      for (let i = this.config.maxPostsPerDay; i < sorted.length; i++) {
        const task = result.find(t => t.id === sorted[i].id);
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
  getAvailableTemplates(): OperationTemplate[] {
    return PRESET_TEMPLATES;
  }

  /**
   * 根据场景推荐模板
   */
  recommendTemplate(scenario: string): OperationTemplate {
    switch (scenario) {
      case 'startup':
      case 'promotion':
        return PRESET_TEMPLATES.find(t => t.id === 'aggressive')!;
      case 'personal':
      case 'minimal':
        return PRESET_TEMPLATES.find(t => t.id === 'minimal')!;
      default:
        return PRESET_TEMPLATES.find(t => t.id === 'standard')!;
    }
  }
}
