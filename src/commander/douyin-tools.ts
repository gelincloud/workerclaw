/**
 * 抖音运营指挥官 - 工具函数
 *
 * 提供给 LLM 调用的工具接口
 */

import type { ToolDefinition, ToolExecutorFn, ToolResult } from '../types/agent.js';
import type { DouyinCommander } from './douyin-commander.js';

/**
 * 获取指挥官工具列表
 */
export function getDouyinCommanderTools(): ToolDefinition[] {
  return [
    {
      name: 'douyin_commander_status',
      description: '获取抖音运营指挥官的状态报告，包括任务执行情况、今日数据等',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'douyin_commander_collect',
      description: '手动触发数据采集，获取最新的账号数据、热点词',
      parameters: {
        type: 'object',
        properties: {
          includeHotspots: {
            type: 'boolean',
            description: '是否采集热点词',
          },
        },
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'douyin_commander_analyze',
      description: '手动触发策略分析，获取运营建议（内容方向、发布时机等）',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'douyin_commander_get_hot',
      description: '获取最新的抖音热点词',
      parameters: {
        type: 'object',
        properties: {
          topN: {
            type: 'number',
            description: '返回前 N 条热点词，默认 10',
          },
        },
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'douyin_commander_get_trend',
      description: '获取账号数据趋势（粉丝增长、发布数等）',
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
      name: 'douyin_commander_add_task',
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
            description: '任务类型: publish_video, reply_comments, browse_hot, check_stats 等',
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
      name: 'douyin_commander_list_templates',
      description: '列出可用的运营模板',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'douyin_commander_switch_template',
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
      name: 'douyin_commander_daily_report',
      description: '生成今日运营日报',
      parameters: {
        type: 'object',
        properties: {},
      },
      requiredLevel: 'read_only',
    },
    {
      name: 'douyin_update_video',
      description: '更新抖音作品信息（修改发布时间或正文）',
      parameters: {
        type: 'object',
        properties: {
          aweme_id: {
            type: 'string',
            description: '作品 ID',
          },
          reschedule: {
            type: 'string',
            description: '新的发布时间（ISO8601 或 Unix 秒，2h~14天后）',
          },
          caption: {
            type: 'string',
            description: '新的正文内容',
          },
        },
        required: ['aweme_id'],
      },
      requiredLevel: 'standard',
    },
    {
      name: 'douyin_delete_video',
      description: '删除抖音作品',
      parameters: {
        type: 'object',
        properties: {
          aweme_id: {
            type: 'string',
            description: '作品 ID',
          },
        },
        required: ['aweme_id'],
      },
      requiredLevel: 'elevated',
    },
    {
      name: 'douyin_publish_video',
      description: '定时发布视频到抖音（必须设置 2h ~ 14天后的发布时间）',
      parameters: {
        type: 'object',
        properties: {
          video: {
            type: 'string',
            description: '视频文件路径（服务器本地路径）',
          },
          title: {
            type: 'string',
            description: '视频标题（≤30字）',
          },
          schedule: {
            type: 'string',
            description: '定时发布时间（ISO8601 或 Unix 秒，2h ~ 14天后）',
          },
          caption: {
            type: 'string',
            description: '正文内容（≤1000字，支持 #话题）',
          },
          cover: {
            type: 'string',
            description: '封面图片路径',
          },
          visibility: {
            type: 'string',
            description: '可见性: public/friends/private',
          },
          allow_download: {
            type: 'boolean',
            description: '是否允许下载',
          },
        },
        required: ['video', 'title', 'schedule'],
      },
      requiredLevel: 'elevated',
    },
    {
      name: 'douyin_save_draft',
      description: '上传视频并保存为草稿',
      parameters: {
        type: 'object',
        properties: {
          video: {
            type: 'string',
            description: '视频文件路径（服务器本地路径）',
          },
          title: {
            type: 'string',
            description: '视频标题（≤30字）',
          },
          caption: {
            type: 'string',
            description: '正文内容（≤1000字）',
          },
          cover: {
            type: 'string',
            description: '封面图片路径',
          },
          visibility: {
            type: 'string',
            description: '可见性: public/friends/private',
          },
        },
        required: ['video', 'title'],
      },
      requiredLevel: 'standard',
    },
  ];
}

/**
 * 创建指挥官工具执行器
 */
export function createDouyinCommanderToolExecutors(commander: DouyinCommander): Record<string, ToolExecutorFn> {
  return {
    /**
     * 获取状态
     */
    async douyin_commander_status(params: unknown, ctx: unknown): Promise<ToolResult> {
      const status = commander.getStatus();
      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: true,
        content: JSON.stringify(status, null, 2),
      };
    },

    /**
     * 手动采集数据
     */
    async douyin_commander_collect(params: unknown, ctx: unknown): Promise<ToolResult> {
      const { snapshot, hotData } = await commander.manualCollect();
      const p = params as { includeHotspots?: boolean };

      const result: Record<string, unknown> = {};
      if (snapshot) {
        result.snapshot = {
          uid: snapshot.uid,
          nickname: snapshot.nickname,
          followerCount: snapshot.followerCount,
          followingCount: snapshot.followingCount,
          awemeCount: snapshot.awemeCount,
          newFollowersToday: snapshot.newFollowersToday,
          postsToday: snapshot.postsToday,
        };
      }
      if (hotData && p?.includeHotspots !== false) {
        result.hotspots = hotData.hotspots.slice(0, 10);
      }

      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: true,
        content: JSON.stringify(result, null, 2),
      };
    },

    /**
     * 策略分析
     */
    async douyin_commander_analyze(params: unknown, ctx: unknown): Promise<ToolResult> {
      const strategy = await commander.manualAnalyze();
      if (!strategy) {
        return {
          toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
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
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: true,
        content: JSON.stringify(result, null, 2),
      };
    },

    /**
     * 获取热点词
     */
    async douyin_commander_get_hot(params: unknown, ctx: unknown): Promise<ToolResult> {
      const p = params as { topN?: number };
      const topN = p?.topN || 10;
      const hotData = commander.getLatestHotspots();

      if (!hotData) {
        return {
          toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
          success: false,
          content: '',
          error: '暂无热点数据，请先执行数据采集',
        };
      }

      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: true,
        content: JSON.stringify(hotData.hotspots.slice(0, topN), null, 2),
      };
    },

    /**
     * 获取趋势数据
     */
    async douyin_commander_get_trend(params: unknown, ctx: unknown): Promise<ToolResult> {
      const p = params as { days?: number };
      const days = p?.days || 7;
      const history = commander.getAccountTrend(days);

      const result = history.map((h) => ({
        date: h.date,
        followerCount: h.followerCount,
        newFollowersToday: h.newFollowersToday,
        postsToday: h.postsToday,
      }));

      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: true,
        content: JSON.stringify(result, null, 2),
      };
    },

    /**
     * 添加自定义任务
     */
    async douyin_commander_add_task(params: unknown, ctx: unknown): Promise<ToolResult> {
      const p = params as {
        taskId: string;
        taskType: string;
        prompt: string;
        schedule: string;
        maxPerDay?: number;
      };

      const result = commander.addCustomTask({
        id: p.taskId,
        type: p.taskType as 'publish_video' | 'reply_comments' | 'browse_hot' | 'check_stats' | 'analyze_data',
        prompt: p.prompt,
        schedule: p.schedule,
        enabled: true,
        source: 'auto',
        priority: 5,
        maxPerDay: p.maxPerDay || 1,
      });

      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: result.success,
        content: result.success ? `任务 ${p.taskId} 已添加` : result.error || '添加失败',
        error: result.success ? undefined : result.error,
      };
    },

    /**
     * 列出模板
     */
    async douyin_commander_list_templates(params: unknown, ctx: unknown): Promise<ToolResult> {
      const templates = commander.getAvailableTemplates();
      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: true,
        content: JSON.stringify(templates, null, 2),
      };
    },

    /**
     * 切换模板
     */
    async douyin_commander_switch_template(params: unknown, ctx: unknown): Promise<ToolResult> {
      const p = params as { templateId: string };
      const result = commander.switchTemplate(p.templateId);

      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: result.success,
        content: result.success
          ? `已切换到模板 ${p.templateId}，重启指挥官后生效`
          : result.error || '切换失败',
        error: result.success ? undefined : result.error,
      };
    },

    /**
     * 日报
     */
    async douyin_commander_daily_report(params: unknown, ctx: unknown): Promise<ToolResult> {
      const report = commander.generateDailyReport();

      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: true,
        content: JSON.stringify(report, null, 2),
      };
    },

    /**
     * 更新视频
     */
    async douyin_update_video(params: unknown, ctx: unknown): Promise<ToolResult> {
      const p = params as { aweme_id: string; reschedule?: string; caption?: string };

      if (!p.reschedule && !p.caption) {
        return {
          toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
          success: false,
          content: '',
          error: '必须提供 reschedule 或 caption 参数',
        };
      }

      const result = await commander.callCli('update', {
        aweme_id: p.aweme_id,
        reschedule: p.reschedule,
        caption: p.caption,
      });

      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: result.success,
        content: result.success ? `作品 ${p.aweme_id} 更新成功` : '',
        error: result.success ? undefined : result.error,
      };
    },

    /**
     * 删除视频
     */
    async douyin_delete_video(params: unknown, ctx: unknown): Promise<ToolResult> {
      const p = params as { aweme_id: string };

      const result = await commander.callCli('delete', {
        aweme_id: p.aweme_id,
      });

      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: result.success,
        content: result.success ? `作品 ${p.aweme_id} 已删除` : '',
        error: result.success ? undefined : result.error,
      };
    },

    /**
     * 发布视频
     */
    async douyin_publish_video(params: unknown, ctx: unknown): Promise<ToolResult> {
      const p = params as {
        video: string;
        title: string;
        schedule: string;
        caption?: string;
        cover?: string;
        visibility?: string;
        allow_download?: boolean;
      };

      const result = await commander.callCli('publish', {
        video: p.video,
        title: p.title,
        schedule: p.schedule,
        caption: p.caption,
        cover: p.cover,
        visibility: p.visibility || 'public',
        allow_download: p.allow_download || false,
      });

      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: result.success,
        content: result.success ? `视频发布成功` : '',
        error: result.success ? undefined : result.error,
      };
    },

    /**
     * 保存草稿
     */
    async douyin_save_draft(params: unknown, ctx: unknown): Promise<ToolResult> {
      const p = params as {
        video: string;
        title: string;
        caption?: string;
        cover?: string;
        visibility?: string;
      };

      const result = await commander.callCli('draft', {
        video: p.video,
        title: p.title,
        caption: p.caption,
        cover: p.cover,
        visibility: p.visibility || 'public',
      });

      return {
        toolCallId: (ctx as { toolCallId?: string })?.toolCallId || '',
        success: result.success,
        content: result.success ? `草稿保存成功` : '',
        error: result.success ? undefined : result.error,
      };
    },
  };
}
