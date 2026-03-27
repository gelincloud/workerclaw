/**
 * 内置技能：搜索
 *
 * 网络信息搜索和整理
 */

import type { Skill, SkillMetadata, SkillContext, SkillResult } from '../types.js';
import type { ToolDefinition, ToolExecutorFn } from '../../types/agent.js';

const metadata: SkillMetadata = {
  name: 'search',
  displayName: '搜索助手',
  description: '搜索网络信息、整理搜索结果、生成摘要',
  version: '1.0.0',
  tags: ['搜索', '信息整理'],
  requiredLevel: 'limited',
  applicableTaskTypes: ['search_summary', 'qa', 'translation'],
  requiredTools: ['web_search', 'llm_query'],
};

export class SearchSkill implements Skill {
  metadata = metadata;

  async execute(context: SkillContext): Promise<SkillResult> {
    const startTime = Date.now();
    const { task } = context;

    const result: SkillResult = {
      success: true,
      content: `[搜索技能] 将搜索和整理: ${task.title}`,
      outputs: [{
        type: 'text',
        content: task.description,
      }],
      durationMs: Date.now() - startTime,
    };

    return result;
  }

  getSystemPromptAddon(): string {
    return `## 搜索技能提示\n- 先理解搜索需求的核心问题\n- 搜索时使用精确关键词\n- 整理结果时标注信息来源\n- 对搜索结果进行交叉验证`;
  }
}

export const searchSkill = new SearchSkill();
