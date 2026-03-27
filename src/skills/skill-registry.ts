/**
 * 技能注册表
 *
 * 管理所有已注册的技能
 * 按任务类型和权限级别匹配技能
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { PermissionLevel } from '../types/agent.js';
import type { Task } from '../types/task.js';
import type {
  Skill, SkillRegistration, SkillMetadata, SkillState,
} from './types.js';

const LEVEL_ORDER: PermissionLevel[] = ['read_only', 'limited', 'standard', 'elevated'];

function levelIndex(level: PermissionLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

export class SkillRegistry {
  private logger = createLogger('SkillRegistry');
  private skills = new Map<string, SkillRegistration>();

  /**
   * 注册技能
   */
  register(skill: Skill): void {
    const name = skill.metadata.name;
    if (this.skills.has(name)) {
      this.logger.warn(`技能 "${name}" 已存在，将被覆盖`);
    }

    this.skills.set(name, {
      skill,
      registeredAt: Date.now(),
      state: 'loaded',
    });

    this.logger.debug(`注册技能: ${name} (权限: ${skill.metadata.requiredLevel})`);
  }

  /**
   * 注销技能
   */
  unregister(name: string): boolean {
    const reg = this.skills.get(name);
    if (reg) {
      // 调用清理
      reg.skill.dispose?.().catch(err => {
        this.logger.warn(`清理技能 "${name}" 失败`, err.message);
      });
    }
    return this.skills.delete(name);
  }

  /**
   * 初始化所有技能
   */
  async initializeAll(): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const [name, reg] of this.skills) {
      try {
        if (reg.skill.init) {
          await reg.skill.init();
          reg.state = 'initialized';
        }
        reg.state = 'ready';
        success++;
      } catch (err) {
        reg.state = 'error';
        reg.error = (err as Error).message;
        failed++;
        this.logger.error(`技能 "${name}" 初始化失败`, (err as Error).message);
      }
    }

    this.logger.info(`技能初始化完成: ${success} 成功, ${failed} 失败`);
    return { success, failed };
  }

  /**
   * 获取技能
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name)?.skill;
  }

  /**
   * 获取适用于指定任务和权限级别的技能列表
   */
  getApplicableSkills(task: Task, permissionLevel: PermissionLevel): Skill[] {
    const threshold = levelIndex(permissionLevel);

    return [...this.skills.values()]
      .filter(reg => {
        if (reg.state !== 'ready') return false;
        const meta = reg.skill.metadata;

        // 权限检查
        if (levelIndex(meta.requiredLevel) > threshold) return false;

        // 任务类型检查（空数组表示适用所有类型）
        if (meta.applicableTaskTypes.length > 0 &&
            !meta.applicableTaskTypes.includes(task.taskType)) {
          return false;
        }

        return true;
      })
      .map(reg => reg.skill);
  }

  /**
   * 获取技能的元数据列表
   */
  getAllMetadata(): SkillMetadata[] {
    return [...this.skills.values()].map(reg => reg.skill.metadata);
  }

  /**
   * 获取技能名称列表
   */
  getSkillNames(): string[] {
    return [...this.skills.keys()];
  }

  /**
   * 获取技能状态
   */
  getSkillState(name: string): SkillState | undefined {
    return this.skills.get(name)?.state;
  }

  /**
   * 检查技能是否存在
   */
  hasSkill(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * 获取所有技能提供的工具（合并到工具注册表）
   */
  getToolsFromAllSkills(permissionLevel: PermissionLevel): Array<{
    tool: import('../types/agent.js').ToolDefinition;
    skillName: string;
  }> {
    const threshold = levelIndex(permissionLevel);
    const result: Array<{ tool: import('../types/agent.js').ToolDefinition; skillName: string }> = [];

    for (const [name, reg] of this.skills) {
      if (reg.state !== 'ready') continue;
      if (levelIndex(reg.skill.metadata.requiredLevel) > threshold) continue;

      const tools = reg.skill.tools || [];
      for (const tool of tools) {
        if (levelIndex(tool.requiredLevel) <= threshold) {
          result.push({ tool, skillName: name });
        }
      }
    }

    return result;
  }

  /**
   * 获取技能提供的工具执行器
   */
  getToolExecutor(toolName: string): { executor: import('../types/agent.js').ToolExecutorFn; skillName: string } | undefined {
    for (const [name, reg] of this.skills) {
      if (reg.state !== 'ready') continue;
      const executors = reg.skill.toolExecutors || {};
      if (toolName in executors) {
        return { executor: executors[toolName], skillName: name };
      }
    }
    return undefined;
  }

  /**
   * 获取技能系统提示附加内容
   */
  getSystemPromptAddons(permissionLevel: PermissionLevel): string[] {
    const threshold = levelIndex(permissionLevel);
    const addons: string[] = [];

    for (const reg of this.skills.values()) {
      if (reg.state !== 'ready') continue;
      if (levelIndex(reg.skill.metadata.requiredLevel) > threshold) continue;
      if (reg.skill.getSystemPromptAddon) {
        const addon = reg.skill.getSystemPromptAddon();
        if (addon) addons.push(addon);
      }
    }

    return addons;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number;
    byState: Record<SkillState, number>;
    byLevel: Record<PermissionLevel, number>;
  } {
    const byState: Record<SkillState, number> = {
      loaded: 0, initialized: 0, ready: 0, error: 0,
    };
    const byLevel: Record<PermissionLevel, number> = {
      read_only: 0, limited: 0, standard: 0, elevated: 0,
    };

    for (const reg of this.skills.values()) {
      byState[reg.state]++;
      byLevel[reg.skill.metadata.requiredLevel]++;
    }

    return { total: this.skills.size, byState, byLevel };
  }

  /**
   * 清理所有技能
   */
  async disposeAll(): Promise<void> {
    for (const [name, reg] of this.skills) {
      try {
        if (reg.skill.dispose) {
          await reg.skill.dispose();
        }
      } catch (err) {
        this.logger.warn(`清理技能 "${name}" 失败`, (err as Error).message);
      }
    }
    this.skills.clear();
  }
}
