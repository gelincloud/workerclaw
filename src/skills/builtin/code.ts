/**
 * 内置技能：代码执行
 * 
 * 代码生成、执行和分析
 * 集成命令沙箱进行安全的代码执行
 */

import type { Skill, SkillMetadata, SkillContext, SkillResult } from '../types.js';
import type { ToolDefinition, ToolExecutorFn } from '../../types/agent.js';

const metadata: SkillMetadata = {
  name: 'code',
  displayName: '代码助手',
  description: '代码生成、执行和调试，支持 JavaScript 和 Python',
  version: '2.0.0',
  author: 'WorkerClaw',
  tags: ['代码', '编程', '执行'],
  requiredLevel: 'elevated',
  applicableTaskTypes: ['code_dev', 'data_analysis'],
  requiredTools: ['run_code', 'llm_query'],
};

/** run_code 工具定义 */
const runCodeTool: ToolDefinition = {
  name: 'run_code',
  description: '在安全沙箱中执行代码。支持 JavaScript 和 Python。',
  requiredLevel: 'elevated',
  parameters: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        enum: ['javascript', 'python'],
        description: '编程语言',
      },
      code: {
        type: 'string',
        description: '要执行的代码',
      },
      timeout: {
        type: 'number',
        description: '超时时间（秒），默认 30',
      },
    },
    required: ['language', 'code'],
  },
};

export class CodeSkill implements Skill {
  metadata = metadata;

  /** 提供的工具列表 */
  tools: ToolDefinition[] = [runCodeTool];

  /** 工具执行器（占位） */
  toolExecutors: Record<string, ToolExecutorFn> = {};

  async execute(context: SkillContext): Promise<SkillResult> {
    const startTime = Date.now();
    const { task } = context;

    try {
      // 分析代码任务
      const analysis = this.analyzeTask(task);
      const plan = this.buildExecutionPlan(task);

      return {
        success: true,
        content: `[代码技能] 执行计划已生成:\n\n${analysis}\n计划: ${plan}`,
        outputs: [{
          type: 'text',
          content: `代码任务: ${task.title}\n\n分析: ${analysis}\n执行计划: ${plan}\n\n将通过 run_code 工具在沙箱中执行代码。`,
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
   * 分析代码任务
   */
  private analyzeTask(task: any): string {
    const desc = task.description || '';
    const title = task.title || '';

    // 检测编程语言
    const langHints: Record<string, string[]> = {
      javascript: ['js', 'javascript', 'node', 'npm', 'typescript', 'ts'],
      python: ['python', 'py', 'pip', 'pandas', 'numpy', 'django', 'flask'],
      shell: ['shell', 'bash', 'sh', '脚本'],
    };

    let detectedLang = 'javascript';
    for (const [lang, hints] of Object.entries(langHints)) {
      if (hints.some(h => desc.toLowerCase().includes(h) || title.toLowerCase().includes(h))) {
        detectedLang = lang;
        break;
      }
    }

    // 检测任务类型
    const isDataAnalysis = task.taskType === 'data_analysis' || 
      /分析|统计|图表|数据|dataset/i.test(desc);
    const isDebug = /debug|调试|fix|修复|error/i.test(desc);
    const isGenerate = /生成|create|write|写|实现/i.test(desc);

    let taskType = '代码生成';
    if (isDataAnalysis) taskType = '数据分析';
    if (isDebug) taskType = '代码调试';
    if (isGenerate) taskType = '代码生成';

    return `类型: ${taskType} | 语言: ${detectedLang}`;
  }

  /**
   * 构建执行计划
   */
  private buildExecutionPlan(task: any): string {
    const isDataAnalysis = task.taskType === 'data_analysis';
    if (isDataAnalysis) {
      return '读取数据 → 数据清洗 → 分析处理 → 生成结果';
    }
    return '理解需求 → 编写代码 → 安全检查 → 执行验证 → 输出结果';
  }

  getSystemPromptAddon(): string {
    return `## 代码技能提示
- 先理解需求再写代码
- 代码要有清晰的注释
- 注意边界条件和错误处理
- 执行前检查代码安全性（禁止危险操作）
- 解释代码执行结果
- 数据分析任务要注意数据格式和统计方法
- 优先使用 JavaScript/Node.js，需要时使用 Python
- 代码要简洁高效，避免冗余`;
  }
}

export const codeSkill = new CodeSkill();
