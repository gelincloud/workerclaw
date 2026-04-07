/**
 * 小红书运营指挥官 - 工具函数
 *
 * 提供给 LLM 调用的工具接口
 */

import type { ToolDefinition, ToolExecutorFn, ToolResult } from '../types/agent.js';
import type { XhsCommander } from './xhs-commander.js';

/**
 * 获取指挥官工具列表
 */
export function getXhsCommanderTools(): ToolDefinition[] {
  return [
    {
      name: 'xhs_commander_status',
      description: '获取小红书运营指挥官的状态报告，包括任务执行情况、今日数据等',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'xhs_commander_collect',
      description: '手动触发数据采集，获取最新的账号数据、热门推荐',
      parameters: {
        type: 'object',
        properties: {
          includeHotFeed: {
            type: 'boolean',
            description: '是否采集热门推荐',
          },
        },
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'xhs_commander_analyze',
      description: '手动触发策略分析，获取运营建议（内容方向、发布时机等）',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'xhs_commander_get_hot',
      description: '获取最新的小红书热门推荐',
      parameters: {
        type: 'object',
        properties: {
          topN: {
            type: 'number',
            description: '返回前 N 条热门笔记，默认 10',
          },
        },
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'xhs_commander_get_trend',
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
      name: 'xhs_commander_add_task',
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
            description: '任务类型: post_note, reply_comments, browse_hot 等',
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
      name: 'xhs_commander_list_templates',
      description: '列出可用的运营模板',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'xhs_commander_switch_template',
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
      name: 'xhs_commander_daily_report',
      description: '生成今日运营日报',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
  ];
}

/**
 * 创建指挥官工具执行器
 */
export function createXhsCommanderToolExecutors(commander: XhsCommander): Record<string, ToolExecutorFn> {
  return {
    /**
     * 获取状态
     */
    async xhs_commander_status(params: any, ctx: any): Promise<ToolResult> {
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
    async xhs_commander_collect(params: any, ctx: any): Promise<ToolResult> {
      const { snapshot, hotFeed } = await commander.manualCollect();

      const result: Record<string, any> = {};
      if (snapshot) {
        result.snapshot = {
          followers: snapshot.followers,
          following: snapshot.following,
          likesAndCollects: snapshot.likesAndCollects,
          creatorLevel: snapshot.creatorLevel,
          newFollowersToday: snapshot.newFollowersToday,
          notesToday: snapshot.notesToday,
        };
      }
      if (hotFeed && params.includeHotFeed !== false) {
        result.hotFeed = hotFeed.notes.slice(0, 10);
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
    async xhs_commander_analyze(params: any, ctx: any): Promise<ToolResult> {
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
     * 获取热门推荐
     */
    async xhs_commander_get_hot(params: any, ctx: any): Promise<ToolResult> {
      const topN = params.topN || 10;
      const hotFeed = commander.getLatestHotFeed();

      if (!hotFeed) {
        return {
          toolCallId: ctx?.toolCallId || '',
          success: false,
          content: '',
          error: '暂无热门推荐数据，请先执行数据采集',
        };
      }

      return {
        toolCallId: ctx?.toolCallId || '',
        success: true,
        content: JSON.stringify(hotFeed.notes.slice(0, topN), null, 2),
      };
    },

    /**
     * 获取趋势数据
     */
    async xhs_commander_get_trend(params: any, ctx: any): Promise<ToolResult> {
      const days = params.days || 7;
      const history = commander.getAccountTrend(days);

      const result = history.map(h => ({
        date: h.date,
        followers: h.followers,
        newFollowers: h.newFollowersToday,
        notes: h.notesToday,
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
    async xhs_commander_add_task(params: any, ctx: any): Promise<ToolResult> {
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
    async xhs_commander_list_templates(params: any, ctx: any): Promise<ToolResult> {
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
    async xhs_commander_switch_template(params: any, ctx: any): Promise<ToolResult> {
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
    async xhs_commander_daily_report(params: any, ctx: any): Promise<ToolResult> {
      const report = commander.generateDailyReport();

      return {
        toolCallId: ctx?.toolCallId || '',
        success: true,
        content: JSON.stringify(report, null, 2),
      };
    },
  };
}
