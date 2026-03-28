/**
 * 任务评估器
 * 
 * 三维度评估：能力匹配度 (capability) + 当前容量 (capacity) + 风险评估 (risk)
 * 加权公式: score = capability * 0.5 + capacity * 0.2 + risk * 0.3
 * 
 * 决策规则:
 *   score >= acceptThreshold → accept
 *   score >= deferThreshold  → defer (放入等待队列)
 *   score < deferThreshold   → reject
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
    const capability = this.assessCapability(task);
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
   * 评估能力匹配度 (0-100)
   * 
   * 基于任务类型的基础能力分，结合技能列表匹配
   */
  private assessCapability(task: Task): number {
    // 基础分：按任务类型
    // 未知类型默认给很低的分（之前是50，导致什么都接）
    const baseScore = this.config.capabilityScores[task.taskType]
      ?? this.config.capabilityScores['other']
      ?? 10;

    // 技能增强：如果已注册相关技能，加分
    let bonus = 0;
    const taskSkills = this.getTaskRelatedSkills(task.taskType);
    const matchedSkills = taskSkills.filter(s => this.isSkillAvailable(s, []));
    bonus = matchedSkills.length * 5;

    return Math.min(100, baseScore + bonus);
  }

  /**
   * 评估当前容量 (0-100, 越高越有空)
   * 
   * 基于当前运行中任务数占最大并发数的比例
   */
  private assessCapacity(context: EvaluationContext): number {
    if (context.maxConcurrent <= 0) return 0;
    const used = context.runningCount / context.maxConcurrent;
    return Math.round((1 - used) * 100);
  }

  /**
   * 评估安全风险 (0-100, 越高越安全)
   * 
   * 基于：
   * - 任务类型固有风险（code_dev/system_op 更危险）
   * - 金额（高金额 → 更谨慎 → 降低安全分）
   * - 有无截止时间（紧迫任务风险稍高）
   */
  private assessRisk(task: Task): number {
    let riskScore = 70; // 基础安全分

    // 任务类型风险
    const typeRiskPenalty: Partial<Record<TaskType, number>> = {
      code_dev: -25,
      system_op: -30,
      data_analysis: -10,
      image_gen: -5,
    };
    riskScore += typeRiskPenalty[task.taskType] || 0;

    // 金额因素：金额越大越谨慎
    if (task.reward && task.reward > 100) {
      riskScore -= Math.min(20, Math.floor(task.reward / 50));
    }

    // 紧迫因素：有截止时间的任务风险稍高
    if (task.deadline) {
      const deadline = new Date(task.deadline).getTime();
      const now = Date.now();
      const remaining = deadline - now;
      if (remaining > 0 && remaining < 30 * 60 * 1000) { // 30 分钟内
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
    };
    return mapping[taskType] || [];
  }

  /**
   * 检查技能是否可用
   * availableSkills 为空时表示未注册任何技能，不算加分
   */
  private isSkillAvailable(skillName: string, availableSkills: string[]): boolean {
    if (availableSkills.length === 0) return false; // 无注册信息时不加分
    return availableSkills.includes(skillName);
  }
}
