/**
 * 内置技能：写作
 * 
 * 通过 AgentEngine LLM 调用完成写作任务
 * 擅长文字创作、文案撰写、内容优化
 */

import type { Skill, SkillMetadata, SkillContext, SkillResult } from '../types.js';

const metadata: SkillMetadata = {
  name: 'writing',
  displayName: '写作助手',
  description: '擅长各类文字创作，包括文案撰写、内容优化、改写润色',
  version: '2.0.0',
  author: 'WorkerClaw',
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

    try {
      // 构建写作指令
      const instruction = this.buildInstruction(task);

      // 输出 LLM 指令（由 AgentEngine 实际调用 LLM）
      const content = this.generateResponse(instruction, task);

      return {
        success: true,
        content,
        outputs: [{
          type: 'text',
          content,
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
   * 根据任务类型构建写作指令
   */
  private buildInstruction(task: any): string {
    const taskType = task.taskType;

    switch (taskType) {
      case 'text_reply':
        return `请回复以下消息。要求自然流畅，有针对性：
\n发单人: ${task.posterName || '用户'}
\n内容: ${task.description}
\n${task.title ? `主题: ${task.title}` : ''}`;

      case 'writing':
        return `请完成以下写作任务：
\n标题: ${task.title}
\n要求: ${task.description}
\n${task.attachments?.length ? '参考资料已提供在附件中。' : ''}`;

      case 'qa':
        return `请回答以下问题：
\n${task.description}
\n${task.title ? `问题: ${task.title}` : ''}`;

      default:
        return `请处理以下写作任务：
\n标题: ${task.title}
\n描述: ${task.description}`;
    }
  }

  /**
   * 生成响应（占位 - 实际由 AgentEngine 的 LLM 循环处理）
   */
  private generateResponse(instruction: string, task: any): string {
    // 这个方法返回的是一个 LLM prompt 指令
    // 实际的 LLM 调用由 AgentEngine 通过工具执行器完成
    return `[写作技能] 已准备指令，将通过 LLM 处理:\n\n${instruction}`;
  }

  getSystemPromptAddon(): string {
    return `## 写作技能提示
- 注重内容质量和可读性
- 根据任务要求调整风格（正式/轻松/学术等）
- 适当使用结构化格式（标题、列表等）
- 回复要有针对性，避免空泛
- 长文写作注意逻辑连贯性和段落过渡
- 文案类任务注重吸引力和感染力`;
  }
}

export const writingSkill = new WritingSkill();
