/**
 * 技能执行器
 *
 * 负责匹配和执行技能
 * 将任务路由到合适的技能执行
 */

import { createLogger, type Logger } from '../core/logger.js';
import { EventBus, WorkerClawEvent } from '../core/events.js';
import { SkillRegistry } from './skill-registry.js';
import type { PermissionLevel } from '../types/agent.js';
import type { Task } from '../types/task.js';
import type { SkillContext, SkillResult, Skill } from './types.js';

export interface SkillRunnerConfig {
  /** 技能执行超时 (ms) */
  skillTimeoutMs: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试延迟 (ms) */
  retryDelayMs: number;
}

export const DEFAULT_SKILL_RUNNER_CONFIG: SkillRunnerConfig = {
  skillTimeoutMs: 60000,
  maxRetries: 1,
  retryDelayMs: 2000,
};

export class SkillRunner {
  private logger: Logger;
  private config: SkillRunnerConfig;
  private registry: SkillRegistry;
  private eventBus: EventBus;

  constructor(
    registry: SkillRegistry,
    config?: Partial<SkillRunnerConfig>,
    eventBus?: EventBus,
  ) {
    this.registry = registry;
    this.config = { ...DEFAULT_SKILL_RUNNER_CONFIG, ...config };
    this.eventBus = eventBus || new EventBus();
    this.logger = createLogger('SkillRunner');
  }

  /**
   * 为任务查找最匹配的技能
   * 返回第一个适用的技能（按注册顺序）
   */
  findBestSkill(task: Task, permissionLevel: PermissionLevel): Skill | null {
    const skills = this.registry.getApplicableSkills(task, permissionLevel);
    if (skills.length === 0) return null;

    // TODO: Phase 5 可以根据评分选最佳技能
    return skills[0];
  }

  /**
   * 执行技能
   */
  async execute(
    skill: Skill,
    context: SkillContext,
  ): Promise<SkillResult> {
    const startTime = Date.now();
    this.logger.info(`执行技能: ${skill.metadata.name}`, {
      taskType: context.task.taskType,
      taskId: context.task.taskId,
    });

    this.eventBus.emit('skill:started' as any, {
      skillName: skill.metadata.name,
      taskId: context.task.taskId,
    });

    try {
      // 带超时的执行
      const result = await this.executeWithTimeout(skill, context);

      const durationMs = Date.now() - startTime;
      this.logger.info(`技能完成: ${skill.metadata.name}`, {
        success: result.success,
        durationMs,
      });

      this.eventBus.emit('skill:completed' as any, {
        skillName: skill.metadata.name,
        taskId: context.task.taskId,
        success: result.success,
        durationMs,
      });

      return { ...result, durationMs };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const error = err as Error;

      this.logger.error(`技能执行失败: ${skill.metadata.name}`, error.message);

      this.eventBus.emit('skill:failed' as any, {
        skillName: skill.metadata.name,
        taskId: context.task.taskId,
        error: error.message,
        durationMs,
      });

      return {
        success: false,
        content: '',
        outputs: [],
        durationMs,
        error: error.message,
      };
    }
  }

  /**
   * 带超时和重试的技能执行
   */
  private async executeWithTimeout(
    skill: Skill,
    context: SkillContext,
    attempt = 1,
  ): Promise<SkillResult> {
    const timeout = Math.min(
      this.config.skillTimeoutMs,
      context.remainingMs - 5000, // 预留 5 秒缓冲
    );

    return new Promise<SkillResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`技能执行超时 (${timeout}ms)`));
      }, Math.max(timeout, 1000));

      skill.execute(context)
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timer);

          // 重试
          if (attempt < this.config.maxRetries) {
            this.logger.warn(`技能重试 (${attempt}/${this.config.maxRetries}): ${skill.metadata.name}`);
            setTimeout(() => {
              this.executeWithTimeout(skill, context, attempt + 1)
                .then(resolve)
                .catch(reject);
            }, this.config.retryDelayMs);
          } else {
            reject(err);
          }
        });
    });
  }

  /**
   * 检查任务是否需要技能
   */
  needsSkill(task: Task, permissionLevel: PermissionLevel): boolean {
    return this.registry.getApplicableSkills(task, permissionLevel).length > 0;
  }

  /**
   * 获取技能注册表引用
   */
  getRegistry(): SkillRegistry {
    return this.registry;
  }
}
