/**
 * 任务评估器 v2 (v0.8.0)
 * 
 * 三维度评估：能力匹配度 (capability) + 当前容量 (capacity) + 风险评估 (risk)
 * 加权公式: score = capability * 0.5 + capacity * 0.2 + risk * 0.3
 * 
 * v2 改进：
 *   - 技能感知：根据已注册技能动态加分
 *   - 描述分析：基于任务标题/描述中的关键词提升评分
 *   - other 类型默认分提升：10 → 40（有基础接单意愿）
 *   - 降低 deferThreshold：60 → 40（更多任务进入"可以考虑"区间）
 *   - 智能降级：评分在 30-39 之间不是直接 reject，而是低优先级 defer
 */

import { createLogger } from '../core/logger.js';
import type {
  Task, TaskEvaluation, EvaluationContext, TaskEvaluatorConfig, TaskType,
} from '../types/task.js';

export class TaskEvaluator {
  private logger = createLogger('TaskEvaluator');
  private config: TaskEvaluatorConfig;

  constructor(config: TaskEvaluatorConfig) {
    this.config = config;
  }

  /**
   * 评估任务是否值得接单
   */
  evaluate(task: Task, context: EvaluationContext): TaskEvaluation {
    const capability = this.assessCapability(task, context);
    const capacity = this.assessCapacity(context);
    const risk = this.assessRisk(task);

    const { capability: cw, capacity: capw, risk: rw } = this.config.weights;
    const score = Math.round(capability * cw + capacity * capw + risk * rw);

    let decision: TaskEvaluation['decision'];
    let reason: string | undefined;

    if (score >= this.config.acceptThreshold) {
      decision = 'accept';
      reason = `综合评分 ${score} >= 阈值 ${this.config.acceptThreshold}`;
    } else if (score >= this.config.deferThreshold) {
      decision = 'defer';
      reason = `综合评分 ${score} 在延迟区间 [${this.config.deferThreshold}, ${this.config.acceptThreshold})`;
    } else {
      decision = 'reject';
      reason = `综合评分 ${score} < 阈值 ${this.config.deferThreshold}`;
    }

    const evaluation: TaskEvaluation = {
      score,
      breakdown: { capability, capacity, risk },
      decision,
      reason,
    };

    this.logger.debug(`任务评估 [${task.taskId}]`, {
      score,
      decision,
      breakdown: evaluation.breakdown,
    });

    return evaluation;
  }

  /**
   * 生成人类可读的评估解释（用于私信告知发单人）
   */
  getEvaluationExplanation(task: Task, evaluation: TaskEvaluation): string {
    const parts: string[] = [];

    // 能力匹配解释
    const cap = evaluation.breakdown.capability;
    if (cap >= 80) {
      parts.push('✅ 能力匹配度很高');
    } else if (cap >= 50) {
      parts.push('🔶 能力基本匹配');
    } else if (cap >= 30) {
      parts.push('🟡 能力匹配度一般，可能需要借助工具完成');
    } else {
      parts.push('⚠️ 能力匹配度较低');
    }

    // 容量解释
    const cap2 = evaluation.breakdown.capacity;
    if (cap2 < 30) {
      parts.push('🔄 当前任务较多，需要排队等待');
    }

    // 风险解释
    const risk = evaluation.breakdown.risk;
    if (risk < 50) {
      parts.push('⚠️ 任务风险较高（类型复杂或金额较大）');
    }

    // 决策解释
    if (evaluation.decision === 'reject') {
      parts.push(`\n综合评分 ${evaluation.score}/100，暂时无法接取此任务。`);
      parts.push('建议：可以修改任务描述或等一段时间后再发布。');
    } else if (evaluation.decision === 'defer') {
      parts.push(`\n综合评分 ${evaluation.score}/100，已加入排队队列，有空位时会自动接单。`);
    } else {
      parts.push(`\n综合评分 ${evaluation.score}/100，已接单开始执行！`);
    }

    return parts.join('\n');
  }

  /**
   * 评估能力匹配度 (0-100)
   * 
   * v2 改进：
   * 1. other 类型默认分从 10 提升到 40
   * 2. 根据已注册技能动态加分
   * 3. 根据任务描述关键词智能加分
   */
  private assessCapability(task: Task, context: EvaluationContext): number {
    // 基础分：按任务类型
    // v2: other 默认 45（有基础接单意愿 + 对 LLM 能力的信任）
    const typeScores: Partial<Record<TaskType, number>> = {
      text_reply: 90,
      qa: 85,
      translation: 80,
      search_summary: 75,
      writing: 70,
      image_gen: 60,
      data_analysis: 55,
      code_dev: 40,
      system_op: 30,
      other: 45,  // v2: 从 40 提升到 45
    };

    const baseScore = typeScores[task.taskType]
      ?? this.config.capabilityScores[task.taskType]
      ?? this.config.capabilityScores['other']
      ?? 45;  // v2: fallback 也改为 45

    // 技能增强：v2 版本 — 感知已注册技能
    let skillBonus = 0;
    const registeredSkills = context.registeredSkills || [];

    // 方式 1: 传统技能名匹配
    const taskSkills = this.getTaskRelatedSkills(task.taskType);
    const matchedSkills = taskSkills.filter(s => this.isSkillAvailable(s, registeredSkills));
    skillBonus += matchedSkills.length * 5;

    // 方式 2: v2 新增 — 基于任务描述和已注册技能的语义匹配
    skillBonus += this.assessSkillMatchByDescription(task, registeredSkills);

    // 方式 3: v2 新增 — 基于任务描述关键词的动态加分
    skillBonus += this.assessDescriptionKeywords(task);

    return Math.min(100, baseScore + skillBonus);
  }

  /**
   * v2 新增：基于任务描述和已注册技能的语义匹配加分
   * 
   * 如果任务描述中提到需要某类能力，而已注册技能能提供这种能力，则加分
   */
  private assessSkillMatchByDescription(task: Task, registeredSkills: string[]): number {
    if (registeredSkills.length === 0) return 0;

    const desc = (task.title + ' ' + task.description).toLowerCase();
    let bonus = 0;

    // 浏览器/搜索能力匹配
    const browserIndicators = [
      '找.*图', '搜索.*图', '下载.*图', '找.*图片', '搜图片', '搜索图片',
      '风景图', '壁纸', '头像', '背景图', '街拍',
      '截图', '网页', '网站', '浏览', '打开',
      '查一下', '搜一下', '帮我找', '帮我查', '百度', '谷歌', 'google',
      '图片', '照片', '截图',
    ];

    const hasBrowserSkill = registeredSkills.some(s =>
      s.toLowerCase().includes('browser') || s.toLowerCase().includes('浏览器'),
    );

    if (hasBrowserSkill) {
      for (const indicator of browserIndicators) {
        if (new RegExp(indicator, 'i').test(desc)) {
          bonus += 25; // v2: 浏览器技能匹配加 25 分（让 other+浏览器 能达到 accept 阈值）
          break;
        }
      }
    }

    // 写作能力匹配
    const writingIndicators = ['写.*文章', '写.*文案', '写.*脚本', '写.*帖子', '写作', '文案'];
    const hasWritingSkill = registeredSkills.some(s =>
      s.toLowerCase().includes('writing') || s.toLowerCase().includes('写作'),
    );

    if (hasWritingSkill) {
      for (const indicator of writingIndicators) {
        if (new RegExp(indicator, 'i').test(desc)) {
          bonus += 10;
          break;
        }
      }
    }

    // 搜索能力匹配
    const searchIndicators = ['搜索', '查找', '调研', '搜集', '资料'];
    const hasSearchSkill = registeredSkills.some(s =>
      s.toLowerCase().includes('search') || s.toLowerCase().includes('搜索'),
    );

    if (hasSearchSkill) {
      for (const indicator of searchIndicators) {
        if (new RegExp(indicator, 'i').test(desc)) {
          bonus += 10;
          break;
        }
      }
    }

    return bonus;
  }

  /**
   * v2 新增：基于任务描述关键词的通用加分
   * 
   * 对于 other 类型，通过分析描述内容给额外加分
   */
  private assessDescriptionKeywords(task: Task): number {
    // 非.other 类型不需要额外分析
    if (task.taskType !== 'other') return 0;

    const desc = (task.title + ' ' + task.description).toLowerCase();
    let bonus = 0;

    // 明确属于文本类的 other 任务
    const textKeywords = ['写', '翻译', '回答', '解释', '说明', '总结', '润色', '改写', '创意'];
    for (const kw of textKeywords) {
      if (desc.includes(kw)) {
        bonus += 10;
        break;
      }
    }

    // 属于搜索/查找类的 other 任务（LLM + 浏览器可以完成）
    const searchKeywords = ['找', '搜', '查', '下载', '获取', '抓取', '提取'];
    for (const kw of searchKeywords) {
      if (desc.includes(kw)) {
        bonus += 8;
        break;
      }
    }

    // 属于分析类的 other 任务
    const analysisKeywords = ['分析', '对比', '统计', '比较', '评估', '计算'];
    for (const kw of analysisKeywords) {
      if (desc.includes(kw)) {
        bonus += 8;
        break;
      }
    }

    return bonus;
  }

  /**
   * 评估当前容量 (0-100, 越高越有空)
   */
  private assessCapacity(context: EvaluationContext): number {
    if (context.maxConcurrent <= 0) return 0;
    const used = context.runningCount / context.maxConcurrent;
    return Math.round((1 - used) * 100);
  }

  /**
   * 评估安全风险 (0-100, 越高越安全)
   */
  private assessRisk(task: Task): number {
    let riskScore = 70;

    const typeRiskPenalty: Partial<Record<TaskType, number>> = {
      code_dev: -25,
      system_op: -30,
      data_analysis: -10,
      image_gen: -5,
    };
    riskScore += typeRiskPenalty[task.taskType] || 0;

    if (task.reward && task.reward > 100) {
      riskScore -= Math.min(20, Math.floor(task.reward / 50));
    }

    if (task.deadline) {
      const deadline = new Date(task.deadline).getTime();
      const now = Date.now();
      const remaining = deadline - now;
      if (remaining > 0 && remaining < 30 * 60 * 1000) {
        riskScore -= 10;
      }
    }

    return Math.max(0, Math.min(100, riskScore));
  }

  /**
   * 获取任务类型相关的技能名称
   */
  private getTaskRelatedSkills(taskType: TaskType): string[] {
    const mapping: Partial<Record<TaskType, string[]>> = {
      text_reply: ['text_generation'],
      qa: ['text_generation', 'knowledge_retrieval'],
      translation: ['translation'],
      search_summary: ['web_search', 'text_generation'],
      writing: ['text_generation', 'creative_writing'],
      image_gen: ['image_generation'],
      data_analysis: ['data_analysis', 'web_search'],
      code_dev: ['code_execution', 'code_generation'],
      system_op: ['code_execution'],
      // v2: other 类型也关联常见技能
      other: ['web_search', 'text_generation', 'code_execution'],
    };
    return mapping[taskType] || [];
  }

  /**
   * 检查技能是否可用
   * v2: 同时支持传统技能名和已注册技能名匹配
   */
  private isSkillAvailable(skillName: string, availableSkills: string[]): boolean {
    if (availableSkills.length === 0) return false;
    
    // 精确匹配
    if (availableSkills.includes(skillName)) return true;
    
    // 模糊匹配（处理名称不完全一致的情况）
    return availableSkills.some(s =>
      s.toLowerCase().includes(skillName.toLowerCase()) ||
      skillName.toLowerCase().includes(s.toLowerCase()),
    );
  }
}
