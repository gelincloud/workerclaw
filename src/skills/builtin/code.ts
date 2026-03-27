/**
 * 内置技能：代码执行
 *
 * 代码生成、执行和分析
 */

import type { Skill, SkillMetadata, SkillContext, SkillResult } from '../types.js';

const metadata: SkillMetadata = {
  name: 'code',
  displayName: '代码助手',
  description: '代码生成、执行和调试，支持 JavaScript 和 Python',
  version: '1.0.0',
  tags: ['代码', '编程', '执行'],
  requiredLevel: 'elevated',
  applicableTaskTypes: ['code_dev', 'data_analysis'],
  requiredTools: ['run_code', 'llm_query'],
};

export class CodeSkill implements Skill {
  metadata = metadata;

  async execute(context: SkillContext): Promise<SkillResult> {
    const startTime = Date.now();
    const { task } = context;

    const result: SkillResult = {
      success: true,
      content: `[代码技能] 将执行代码任务: ${task.title}`,
      outputs: [{
        type: 'text',
        content: task.description,
      }],
      durationMs: Date.now() - startTime,
    };

    return result;
  }

  getSystemPromptAddon(): string {
    return `## 代码技能提示\n- 先理解需求再写代码\n- 代码要有清晰的注释\n- 注意边界条件和错误处理\n- 执行前检查代码安全性\n- 解释代码执行结果`;
  }
}

export const codeSkill = new CodeSkill();
