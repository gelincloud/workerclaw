/**
 * 知乎运营指挥官 - 工具函数
 *
 * 提供给 LLM 调用的工具接口
 */

import type { ToolDefinition, ToolExecutorFn, ToolResult } from '../types/agent.js';
import type { ZhihuCommander } from './zhihu-commander.js';

/**
 * 获取指挥官工具列表
 */
export function getZhihuCommanderTools(): ToolDefinition[] {
  return [
    {
      name: 'zhihu_commander_status',
      description: '获取知乎运营指挥官的状态报告，包括任务执行情况、今日数据等',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'zhihu_commander_collect',
      description: '手动触发数据采集，获取最新的账号数据、热榜',
      parameters: {
        type: 'object',
        properties: {
          includeHot: {
            type: 'boolean',
            description: '是否采集热榜',
          },
        },
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'zhihu_commander_analyze',
      description: '手动触发策略分析，获取运营建议（内容方向、发布时机等）',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'zhihu_commander_get_hot',
      description: '获取最新的知乎热榜',
      parameters: {
        type: 'object',
        properties: {
          topN: {
            type: 'number',
            description: '返回前 N 条热榜，默认 10',
          },
        },
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'zhihu_commander_get_trend',
      description: '获取账号数据趋势（粉丝增长、发博数等）',
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description: '查询最近多少天的数据，默认 7',
          },
        },
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'zhihu_commander_add_task',
      description: '添加自定义定时任务到调度器',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: '任务 ID',
          },
          taskType: {
            type: 'string',
            description: '任务类型: post_article, post_answer, reply_comments, browse_hot 等',
          },
          prompt: {
            type: 'string',
            description: '任务执行提示词（给 LLM 的指令）',
          },
          schedule: {
            type: 'string',
            description: 'Cron 表达式（分钟 小时），如 "0 20" 表示每天 20:00',
          },
          maxPerDay: {
            type: 'number',
            description: '每日最大执行次数，默认 1',
          },
        },
        required: ['taskId', 'taskType', 'prompt', 'schedule'],
      },
      requiredLevel: 'standard',
    },
    {
      name: 'zhihu_commander_list_templates',
      description: '列出可用的运营模板',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'zhihu_commander_switch_template',
      description: '切换运营模板',
      parameters: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '模板 ID: standard, aggressive, minimal, api_test',
          },
        },
        required: ['templateId'],
      },
      requiredLevel: 'standard',
    },
    {
      name: 'zhihu_commander_daily_report',
      description: '生成今日运营日报',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'zhihu_post_article',
      description: '发布知乎专栏文章',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '文章标题',
          },
          content: {
            type: 'string',
            description: '文章正文（支持 HTML 格式，纯文本会自动转 HTML）',
          },
          draft: {
            type: 'boolean',
            description: '是否保存为草稿（默认 false，直接发布）',
          },
        },
        required: ['title', 'content'],
      },
      requiredLevel: 'standard',
    },
    {
      name: 'zhihu_post_answer',
      description: '回答知乎问题',
      parameters: {
        type: 'object',
        properties: {
          questionId: {
            type: 'string',
            description: '问题 ID（数字）',
          },
          content: {
            type: 'string',
            description: '回答内容（支持 HTML 格式，纯文本会自动转 HTML）',
          },
          draft: {
            type: 'boolean',
            description: '是否保存为草稿（默认 false，直接发布）',
          },
        },
        required: ['questionId', 'content'],
      },
      requiredLevel: 'standard',
    },
    {
      name: 'zhihu_post_comment',
      description: '评论知乎问题/回答/文章',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '评论内容',
          },
          resourceType: {
            type: 'string',
            description: '评论对象类型：answer(回答), article(文章), question(问题)',
          },
          resourceId: {
            type: 'string',
            description: '评论对象的 ID',
          },
          replyToId: {
            type: 'string',
            description: '回复某条评论的 ID（可选）',
          },
        },
        required: ['content', 'resourceType', 'resourceId'],
      },
      requiredLevel: 'standard',
    },
  ];
}

/**
 * 创建指挥官工具执行器
 */
export function createZhihuCommanderToolExecutors(commander: ZhihuCommander): Record<string, ToolExecutorFn> {
  return {
    /**
     * 获取状态
     */
    async zhihu_commander_status(params: any, ctx: any): Promise<ToolResult> {
      const status = commander.getStatus();
      return {
        toolCallId: ctx?.toolCallId || '',
        success: true,
        content: JSON.stringify(status, null, 2),
      };
    },

    /**
     * 手动采集数据
     */
    async zhihu_commander_collect(params: any, ctx: any): Promise<ToolResult> {
      const { snapshot, hotData } = await commander.manualCollect();

      const result: Record<string, any> = {};
      if (snapshot) {
        result.snapshot = {
          uid: snapshot.uid,
          nickname: snapshot.nickname,
          followers: snapshot.followers,
          answerCount: snapshot.answerCount,
          articleCount: snapshot.articleCount,
          voteupCount: snapshot.voteupCount,
          newFollowersToday: snapshot.newFollowersToday,
        };
      }
      if (hotData && params.includeHot !== false) {
        result.hotList = hotData.items.slice(0, 10);
      }

      return {
        toolCallId: ctx?.toolCallId || '',
        success: true,
        content: JSON.stringify(result, null, 2),
      };
    },

    /**
     * 策略分析
     */
    async zhihu_commander_analyze(params: any, ctx: any): Promise<ToolResult> {
      const strategy = await commander.manualAnalyze();
      if (!strategy) {
        return {
          toolCallId: ctx?.toolCallId || '',
          success: false,
          content: '',
          error: '策略分析失败',
        };
      }

      const result = {
        currentPhase: strategy.currentPhase,
        postingTimes: strategy.postingTimes.slice(0, 5),
        contentSuggestions: strategy.contentSuggestions.slice(0, 5),
        interactionSuggestions: strategy.interactionSuggestions.slice(0, 3),
        todoList: strategy.todoList,
        urgentItems: strategy.urgentItems,
      };

      return {
        toolCallId: ctx?.toolCallId || '',
        success: true,
        content: JSON.stringify(result, null, 2),
      };
    },

    /**
     * 获取热榜
     */
    async zhihu_commander_get_hot(params: any, ctx: any): Promise<ToolResult> {
      const topN = params.topN || 10;
      const hotData = commander.getLatestHotList();

      if (!hotData) {
        return {
          toolCallId: ctx?.toolCallId || '',
          success: false,
          content: '',
          error: '暂无热榜数据，请先执行数据采集',
        };
      }

      return {
        toolCallId: ctx?.toolCallId || '',
        success: true,
        content: JSON.stringify(hotData.items.slice(0, topN), null, 2),
      };
    },

    /**
     * 获取趋势数据
     */
    async zhihu_commander_get_trend(params: any, ctx: any): Promise<ToolResult> {
      const days = params.days || 7;
      const history = commander.getAccountTrend(days);

      const result = history.map(h => ({
        date: h.date,
        followers: h.followers,
        newFollowersToday: h.newFollowersToday,
        answerCount: h.answerCount,
        articleCount: h.articleCount,
      }));

      return {
        toolCallId: ctx?.toolCallId || '',
        success: true,
        content: JSON.stringify(result, null, 2),
      };
    },

    /**
     * 添加自定义任务
     */
    async zhihu_commander_add_task(params: any, ctx: any): Promise<ToolResult> {
      const result = commander.addCustomTask({
        id: params.taskId,
        type: params.taskType,
        prompt: params.prompt,
        schedule: params.schedule,
        enabled: true,
        source: 'dynamic',
        priority: 5,
        maxPerDay: params.maxPerDay || 1,
      });

      return {
        toolCallId: ctx?.toolCallId || '',
        success: result.success,
        content: result.success ? `任务 ${params.taskId} 已添加` : result.error || '添加失败',
        error: result.success ? undefined : result.error,
      };
    },

    /**
     * 列出模板
     */
    async zhihu_commander_list_templates(params: any, ctx: any): Promise<ToolResult> {
      const templates = commander.getAvailableTemplates();
      return {
        toolCallId: ctx?.toolCallId || '',
        success: true,
        content: JSON.stringify(templates, null, 2),
      };
    },

    /**
     * 切换模板
     */
    async zhihu_commander_switch_template(params: any, ctx: any): Promise<ToolResult> {
      const result = commander.switchTemplate(params.templateId);

      return {
        toolCallId: ctx?.toolCallId || '',
        success: result.success,
        content: result.success
          ? `已切换到模板 ${params.templateId}，重启指挥官后生效`
          : result.error || '切换失败',
        error: result.success ? undefined : result.error,
      };
    },

    /**
     * 日报
     */
    async zhihu_commander_daily_report(params: any, ctx: any): Promise<ToolResult> {
      const report = commander.generateDailyReport();

      return {
        toolCallId: ctx?.toolCallId || '',
        success: true,
        content: JSON.stringify(report, null, 2),
      };
    },

    /**
     * 发布文章
     */
    async zhihu_post_article(params: any, ctx: any): Promise<ToolResult> {
      const { title, content, draft = false } = params;

      if (!title || !content) {
        return {
          toolCallId: ctx?.toolCallId || '',
          success: false,
          content: '',
          error: '标题和内容不能为空',
        };
      }

      const result = await commander.postArticle(title, content, draft);

      return {
        toolCallId: ctx?.toolCallId || '',
        success: result.success,
        content: result.success
          ? `文章发布成功: ${result.url}`
          : '',
        error: result.success ? undefined : result.error,
      };
    },

    /**
     * 回答问题
     */
    async zhihu_post_answer(params: any, ctx: any): Promise<ToolResult> {
      const { questionId, content, draft = false } = params;

      if (!questionId || !content) {
        return {
          toolCallId: ctx?.toolCallId || '',
          success: false,
          content: '',
          error: '问题ID和内容不能为空',
        };
      }

      const result = await commander.postAnswer(questionId, content, draft);

      return {
        toolCallId: ctx?.toolCallId || '',
        success: result.success,
        content: result.success
          ? `回答发布成功: ${result.url}`
          : '',
        error: result.success ? undefined : result.error,
      };
    },

    /**
     * 发布评论
     */
    async zhihu_post_comment(params: any, ctx: any): Promise<ToolResult> {
      const { content, resourceType, resourceId, replyToId } = params;

      if (!content || !resourceType || !resourceId) {
        return {
          toolCallId: ctx?.toolCallId || '',
          success: false,
          content: '',
          error: '评论内容、资源类型和资源ID不能为空',
        };
      }

      const result = await commander.postComment(content, resourceType, resourceId, replyToId);

      return {
        toolCallId: ctx?.toolCallId || '',
        success: result.success,
        content: result.success
          ? '评论发布成功'
          : '',
        error: result.success ? undefined : result.error,
      };
    },
  };
}
