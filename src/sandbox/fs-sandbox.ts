/**
 * 文件系统沙箱
 * 
 * 路径验证 + 工作目录隔离
 * - 阻止路径遍历
 * - 每个任务独立工作目录
 * - 白名单/黑名单路径控制
 */

import { resolve, dirname, isAbsolute, join } from 'node:path';
import { mkdir, rm, access, constants } from 'node:fs/promises';
import { createLogger, type Logger } from '../core/logger.js';

// ==================== 配置 ====================

export interface FsSandboxConfig {
  /** 沙箱根目录 */
  workDir: string;
  /** 允许访问的路径（绝对路径列表） */
  allowedPaths: string[];
  /** 禁止访问的路径 */
  deniedPaths: string[];
}

// ==================== 路径验证结果 ====================

export interface PathValidation {
  allowed: boolean;
  resolvedPath: string;
  reason?: string;
}

// ==================== 文件系统沙箱 ====================

export class FsSandbox {
  private logger: Logger;
  private config: FsSandboxConfig;
  private taskDirs = new Map<string, string>();

  constructor(config: FsSandboxConfig) {
    this.config = config;
    this.logger = createLogger('FsSandbox');
  }

  /**
   * 验证路径是否允许访问
   */
  validatePath(requestedPath: string): PathValidation {
    const resolved = this.resolveAndNormalize(requestedPath);

    // 1. 检查黑名单
    for (const denied of this.config.deniedPaths) {
      if (resolved.startsWith(denied) || resolved === denied) {
        return {
          allowed: false,
          resolvedPath: '',
          reason: `路径 "${requestedPath}" 在禁止访问列表中（匹配 ${denied}）`,
        };
      }
    }

    // 2. 检查白名单
    const isAllowed = this.config.allowedPaths.some(allowed =>
      resolved.startsWith(allowed)
    );

    // 3. 检查是否在任务工作目录内
    const isInTaskDir = [...this.taskDirs.values()].some(taskDir =>
      resolved.startsWith(taskDir)
    );

    // 4. 检查是否在沙箱根目录内
    const workDirResolved = resolve(this.config.workDir);
    const isInWorkDir = resolved.startsWith(workDirResolved);

    if (!isAllowed && !isInTaskDir && !isInWorkDir) {
      return {
        allowed: false,
        resolvedPath: '',
        reason: `路径 "${requestedPath}" 不在允许的访问范围内`,
      };
    }

    // 5. 检查路径遍历（已通过 resolve 处理，这里做二次校验）
    if (requestedPath.includes('..')) {
      const normalized = resolve(requestedPath);
      if (!normalized.startsWith(resolve(this.config.workDir))) {
        return {
          allowed: false,
          resolvedPath: '',
          reason: '路径遍历攻击已阻止',
        };
      }
    }

    return { allowed: true, resolvedPath: resolved };
  }

  /**
   * 为任务创建隔离工作目录
   */
  async createTaskWorkDir(taskId: string): Promise<string> {
    const dir = join(resolve(this.config.workDir), `task-${taskId}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    this.taskDirs.set(taskId, dir);
    this.logger.debug(`创建任务工作目录: ${dir}`);
    return dir;
  }

  /**
   * 获取任务工作目录
   */
  getTaskWorkDir(taskId: string): string | undefined {
    return this.taskDirs.get(taskId);
  }

  /**
   * 清理任务工作目录
   */
  async cleanupTaskWorkDir(taskId: string): Promise<void> {
    const dir = this.taskDirs.get(taskId);
    if (!dir) return;

    try {
      await rm(dir, { recursive: true, force: true });
      this.taskDirs.delete(taskId);
      this.logger.debug(`清理任务工作目录: ${dir}`);
    } catch (err) {
      this.logger.warn(`清理工作目录失败: ${dir}`, (err as Error).message);
    }
  }

  /**
   * 清理所有任务工作目录
   */
  async cleanupAll(): Promise<void> {
    for (const taskId of [...this.taskDirs.keys()]) {
      await this.cleanupTaskWorkDir(taskId);
    }
  }

  /**
   * 确保沙箱根目录存在
   */
  async ensureWorkDir(): Promise<void> {
    await mkdir(resolve(this.config.workDir), { recursive: true });
  }

  /**
   * 解析并标准化路径
   */
  private resolveAndNormalize(inputPath: string): string {
    if (!isAbsolute(inputPath)) {
      inputPath = resolve(inputPath);
    }
    return resolve(inputPath);
  }
}
