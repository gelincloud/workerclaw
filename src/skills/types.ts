/**
 * 技能类型定义
 *
 * 定义技能系统的接口和类型
 */

import type { ToolDefinition, PermissionLevel, ToolExecutorFn } from '../types/agent.js';
import type { Task } from '../types/task.js';

// ==================== 技能定义 ====================

/** 技能元数据 */
export interface SkillMetadata {
  /** 技能名称（唯一标识） */
  name: string;
  /** 技能显示名称 */
  displayName: string;
  /** 技能描述 */
  description: string;
  /** 技能版本 */
  version: string;
  /** 技能作者 */
  author?: string;
  /** 标签 */
  tags: string[];
  /** 最低权限级别 */
  requiredLevel: PermissionLevel;
  /** 适用任务类型（空数组表示适用所有类型） */
  applicableTaskTypes: string[];
  /** 所需工具名称列表 */
  requiredTools: string[];
}

/** 技能执行上下文 */
export interface SkillContext {
  /** 当前任务 */
  task: Task;
  /** 权限级别 */
  permissionLevel: PermissionLevel;
  /** 技能参数 */
  params: Record<string, any>;
  /** 工作目录 */
  workDir: string;
  /** 任务超时剩余 (ms) */
  remainingMs: number;
}

/** 技能执行结果 */
export interface SkillResult {
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  content: string;
  /** 输出类型 */
  outputs: Array<{
    type: 'text' | 'image' | 'file';
    content: string;
    name?: string;
  }>;
  /** 使用 token 数 */
  tokensUsed?: {
    prompt: number;
    completion: number;
  };
  /** 执行耗时 */
  durationMs: number;
  /** 错误信息 */
  error?: string;
}

/** 技能接口 */
export interface Skill {
  /** 技能元数据 */
  metadata: SkillMetadata;
  /** 提供的工具列表 */
  tools?: ToolDefinition[];
  /** 提供工具的执行器 */
  toolExecutors?: Record<string, ToolExecutorFn>;
  /** 执行技能 */
  execute(context: SkillContext): Promise<SkillResult>;
  /** 生成技能专属提示（附加到系统提示中） */
  getSystemPromptAddon?(): string;
  /** 初始化/预热 */
  init?(): Promise<void>;
  /** 清理 */
  dispose?(): Promise<void>;
}

/** 技能状态 */
export type SkillState = 'loaded' | 'initialized' | 'ready' | 'error';

/** 技能注册项 */
export interface SkillRegistration {
  /** 技能实例 */
  skill: Skill;
  /** 注册时间 */
  registeredAt: number;
  /** 状态 */
  state: SkillState;
  /** 初始化错误 */
  error?: string;
}
