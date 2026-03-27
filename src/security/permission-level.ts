/**
 * 权限分级系统
 * 
 * 根据任务类型自动确定权限级别
 * 四级权限: read_only → limited → standard → elevated
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { Task, TaskType } from '../types/task.js';

// ==================== 权限类型 ====================

export type PermissionLevel = 'read_only' | 'limited' | 'standard' | 'elevated';

// ==================== 权限定义 ====================

export interface PermissionProfile {
  /** 允许的工具 */
  allowedTools: string[];
  /** 允许的命令（支持通配符 *，排除项以 - 开头） */
  allowedCommands: string[];
  /** 允许的网络协议和域名模式 */
  allowedNetwork: string[];
  /** 最大输出 token 数 */
  maxOutputTokens: number;
  /** 最大工具调用次数 */
  maxToolCallsPerTask: number;
  /** 允许的文件操作 */
  allowedFileOps: ('read' | 'write' | 'delete')[];
}

// ==================== 各级别默认权限 ====================

const PERMISSION_LEVELS: Record<PermissionLevel, PermissionProfile> = {
  read_only: {
    allowedTools: ['llm_query'],
    allowedCommands: [],
    allowedNetwork: [],
    maxOutputTokens: 2000,
    maxToolCallsPerTask: 3,
    allowedFileOps: ['read'],
  },
  limited: {
    allowedTools: ['llm_query', 'web_search'],
    allowedCommands: ['echo', 'cat', 'ls', 'head', 'tail', 'wc', 'grep', 'find'],
    allowedNetwork: ['https://api.miniabc.top/*'],
    maxOutputTokens: 4000,
    maxToolCallsPerTask: 10,
    allowedFileOps: ['read'],
  },
  standard: {
    allowedTools: ['llm_query', 'web_search', 'image_gen', 'file_read', 'file_write'],
    allowedCommands: ['*'],
    allowedNetwork: ['https://*'],
    maxOutputTokens: 8000,
    maxToolCallsPerTask: 20,
    allowedFileOps: ['read', 'write'],
  },
  elevated: {
    allowedTools: ['*'],
    allowedCommands: ['*'],
    allowedNetwork: ['https://*', 'wss://*'],
    maxOutputTokens: 16000,
    maxToolCallsPerTask: 50,
    allowedFileOps: ['read', 'write', 'delete'],
  },
};

// ==================== 任务类型→权限映射 ====================

const TASK_TYPE_MAPPING: Record<TaskType, PermissionLevel> = {
  text_reply: 'read_only',
  qa: 'read_only',
  translation: 'limited',
  search_summary: 'limited',
  writing: 'standard',
  image_gen: 'standard',
  data_analysis: 'standard',
  code_dev: 'elevated',
  system_op: 'elevated',
  other: 'standard',
};

// 中文任务类型映射
const CN_TASK_TYPE_MAPPING: Record<string, PermissionLevel> = {
  '文字回复': 'read_only',
  '问答': 'read_only',
  '搜索整理': 'limited',
  '翻译': 'limited',
  '写文章': 'standard',
  '生成图片': 'standard',
  '数据分析': 'standard',
  '代码开发': 'elevated',
  '系统操作': 'elevated',
};

// ==================== 自动分级配置 ====================

export interface PermissionAutoGradeConfig {
  /** 高信誉发单人可以升一级 */
  highReputationBoost?: boolean;
  /** 金额阈值（超过则降一级） */
  highValueThreshold?: number;
}

// ==================== 权限分级器 ====================

export class PermissionGrader {
  private logger: Logger;
  private config: PermissionAutoGradeConfig;

  constructor(config: PermissionAutoGradeConfig = {}) {
    this.config = config;
    this.logger = createLogger('PermissionGrader');
  }

  /**
   * 根据任务自动确定权限级别
   */
  grade(task: Task): PermissionLevel {
    // 1. 基础分级（根据任务类型）
    let level = this.gradeByTaskType(task.taskType, task.title);

    // 2. 金额调整（金额越大越谨慎）
    if (this.config.highValueThreshold && task.reward) {
      if (task.reward > this.config.highValueThreshold) {
        const demoted = this.demote(level);
        this.logger.info(`任务金额 ${task.reward} 超过阈值，权限从 ${level} 降为 ${demoted}`);
        level = demoted;
      }
    }

    // 3. 信誉调整（暂无信誉数据，预留接口）
    // TODO: 集成平台信誉系统后实现

    this.logger.debug(`任务 [${task.taskId}] 权限级别: ${level}`, {
      taskType: task.taskType,
      reward: task.reward,
    });

    return level;
  }

  /**
   * 按任务类型分级
   */
  private gradeByTaskType(taskType: TaskType, title?: string): PermissionLevel {
    // 先查英文映射
    if (TASK_TYPE_MAPPING[taskType]) {
      return TASK_TYPE_MAPPING[taskType];
    }

    // 查中文映射
    if (title && CN_TASK_TYPE_MAPPING[title]) {
      return CN_TASK_TYPE_MAPPING[title];
    }

    return 'standard';
  }

  /**
   * 降一级
   */
  private demote(level: PermissionLevel): PermissionLevel {
    const order: PermissionLevel[] = ['read_only', 'limited', 'standard', 'elevated'];
    const idx = order.indexOf(level);
    if (idx <= 0) return level;
    return order[idx - 1];
  }

  /**
   * 获取权限配置
   */
  getProfile(level: PermissionLevel): PermissionProfile {
    return PERMISSION_LEVELS[level];
  }

  /**
   * 检查工具是否允许
   */
  isToolAllowed(toolName: string, level: PermissionLevel): boolean {
    const profile = this.getProfile(level);
    if (profile.allowedTools.includes('*')) return true;
    return profile.allowedTools.includes(toolName);
  }

  /**
   * 检查命令是否允许
   */
  isCommandAllowed(command: string, level: PermissionLevel): boolean {
    const profile = this.getProfile(level);
    if (profile.allowedCommands.length === 0) return false;
    if (profile.allowedCommands.includes('*')) {
      // 检查排除项
      const cmdBase = command.trim().split(/\s+/)[0];
      for (const pattern of profile.allowedCommands) {
        if (pattern.startsWith('-') && command.match(new RegExp(pattern.slice(1).replace(/\*/g, '.*'), 'i'))) {
          return false;
        }
      }
      return true;
    }
    const cmdBase = command.trim().split(/\s+/)[0];
    return profile.allowedCommands.includes(cmdBase);
  }

  /**
   * 检查网络访问是否允许
   */
  isNetworkAllowed(url: string, level: PermissionLevel): boolean {
    const profile = this.getProfile(level);
    if (profile.allowedNetwork.length === 0) return false;
    if (profile.allowedNetwork.includes('*')) return true;

    try {
      const parsed = new URL(url);
      const urlOrigin = `${parsed.protocol}//${parsed.hostname}`;

      for (const pattern of profile.allowedNetwork) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        if (regex.test(urlOrigin) || regex.test(`${parsed.protocol}//${parsed.hostname}/*`)) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * 检查文件操作是否允许
   */
  isFileOpAllowed(op: 'read' | 'write' | 'delete', level: PermissionLevel): boolean {
    const profile = this.getProfile(level);
    return profile.allowedFileOps.includes(op);
  }
}

/** 全局权限分级器单例 */
export const permissionGrader = new PermissionGrader();
