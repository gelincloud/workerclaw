/**
 * 内置技能：搜索
 * 
 * 集成 web_search 工具进行信息搜索和整理
 * 通过 LLM 整理搜索结果生成摘要
 */

import type { Skill, SkillMetadata, SkillContext, SkillResult } from '../types.js';
import type { ToolDefinition, ToolExecutorFn } from '../../types/agent.js';

const metadata: SkillMetadata = {
  name: 'search',
  displayName: '搜索助手',
  description: '搜索网络信息、整理搜索结果、生成摘要',
  version: '2.0.0',
  author: 'WorkerClaw',
  tags: ['搜索', '信息整理'],
  requiredLevel: 'limited',
  applicableTaskTypes: ['search_summary', 'qa', 'translation'],
  requiredTools: ['web_search', 'llm_query'],
};

/** web_search 工具定义 */
const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索网络信息。输入搜索关键词，返回相关结果。',
  requiredLevel: 'limited',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词',
      },
    },
    required: ['query'],
  },
};

export class SearchSkill implements Skill {
  metadata = metadata;

  /** 提供的工具列表 */
  tools: ToolDefinition[] = [webSearchTool];

  /** 工具执行器（占位 - 实际执行由 AgentEngine 调度） */
  toolExecutors: Record<string, ToolExecutorFn> = {};

  async execute(context: SkillContext): Promise<SkillResult> {
    const startTime = Date.now();
    const { task } = context;

    try {
      // 分析搜索需求
      const searchQuery = this.extractSearchQuery(task);
      const searchPlan = this.buildSearchPlan(task);

      return {
        success: true,
        content: `[搜索技能] 搜索计划已生成:\n\n查询: ${searchQuery}\n策略: ${searchPlan}`,
        outputs: [{
          type: 'text',
          content: `搜索任务: ${task.title}\n查询关键词: ${searchQuery}\n\n将通过 web_search 工具执行搜索，并通过 LLM 整理结果。`,
        }],
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        content: '',
        outputs: [],
        durationMs: Date.now() - startTime,
        error: (err as Error).message,
      };
    }
  }

  /**
   * 从任务中提取搜索关键词
   */
  private extractSearchQuery(task: any): string {
    // 如果标题本身就是问题
    if (task.title && (task.title.includes('?') || task.title.includes('？') || task.title.includes('怎么') || task.title.includes('如何'))) {
      return task.title;
    }

    // 否则结合标题和描述
    const parts = [task.title, task.description].filter(Boolean);
    return parts.join(' ').slice(0, 100);
  }

  /**
   * 构建搜索策略
   */
  private buildSearchPlan(task: any): string {
    switch (task.taskType) {
      case 'search_summary':
        return '广泛搜索 → 筛选关键信息 → 整理摘要';
      case 'qa':
        return '针对性搜索 → 提取答案 → 验证准确性';
      case 'translation':
        return '搜索原文背景 → 查找专业术语 → 确保翻译准确';
      default:
        return '标准搜索 → 信息整理';
    }
  }

  getSystemPromptAddon(): string {
    return `## 搜索技能提示
- 先理解搜索需求的核心问题
- 搜索时使用精确关键词，避免过于宽泛
- 整理结果时标注信息来源
- 对搜索结果进行交叉验证，避免传播错误信息
- 摘要要简洁明了，突出重点
- 引用数据时注明来源和时间`;
  }
}

export const searchSkill = new SearchSkill();
