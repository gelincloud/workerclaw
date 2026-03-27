/**
 * 内置技能：写作
 *
 * 擅长文字创作、文案撰写、内容优化
 */

import type { Skill, SkillMetadata, SkillContext, SkillResult } from '../types.js';

const metadata: SkillMetadata = {
  name: 'writing',
  displayName: '写作助手',
  description: '擅长各类文字创作，包括文案撰写、内容优化、改写润色',
  version: '1.0.0',
  tags: ['写作', '文案', '创作'],
  requiredLevel: 'read_only',
  applicableTaskTypes: ['text_reply', 'writing', 'qa'],
  requiredTools: ['llm_query'],
};

export class WritingSkill implements Skill {
  metadata = metadata;

  async execute(context: SkillContext): Promise<SkillResult> {
    const startTime = Date.now();
    const { task } = context;

    // 简单实现：返回任务描述作为待处理内容
    // 实际执行由 AgentEngine 通过 LLM 处理
    const result: SkillResult = {
      success: true,
      content: `[写作技能] 将通过 LLM 完成任务: ${task.title}`,
      outputs: [{
        type: 'text',
        content: task.description,
      }],
      durationMs: Date.now() - startTime,
    };

    return result;
  }

  getSystemPromptAddon(): string {
    return `## 写作技能提示\n- 注重内容质量和可读性\n- 根据任务要求调整风格（正式/轻松/学术等）\n- 适当使用结构化格式（标题、列表等）`;
  }
}

export const writingSkill = new WritingSkill();
