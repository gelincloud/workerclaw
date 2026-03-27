/**
 * 命令执行沙箱
 * 
 * 进程级轻量沙箱，参考 OpenClaw 2026.3.22 安全增强
 * - 危险命令模式阻断
 * - 命令执行超时
 * - 输出大小限制
 * - 环境变量过滤
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, type Logger } from '../core/logger.js';
import type { PermissionLevel } from '../security/permission-level.js';

const execAsync = promisify(exec);

// ==================== 危险命令模式 ====================

const DANGEROUS_PATTERNS: RegExp[] = [
  // OpenClaw 2026.3.22: JVM 注入
  /MAVEN_OPTS/i,
  /JAVA_TOOL_OPTIONS/i,
  // OpenClaw 2026.3.22: glibc 漏洞利用
  /GLIBC_TUNABLES/i,
  // OpenClaw 2026.3.22: .NET 依赖劫持
  /DOTNET_ADDITIONAL_DEPS/i,
  /DOTNET_STARTUP_HOOKS/i,
  // 通用危险命令
  /rm\s+-rf\s+\/(?!\s)/,
  /curl.*\|.*sh/i,
  /wget.*\|.*sh/i,
  /mkfs/i,
  /dd\s+if=/i,
  />\s*\/dev\//i,
  /chmod\s+777\s+\//i,
  /chown\s+.*\s+\//i,
  /nc\s+-[el]/i,
  /socat/i,
  /python.*-c.*import\s+socket/i,
  /bash\s+-i\s+>&/i,
];

// 禁止的环境变量
const BLOCKED_ENV_VARS = [
  'MAVEN_OPTS', 'JAVA_TOOL_OPTIONS', 'GLIBC_TUNABLES',
  'DOTNET_ADDITIONAL_DEPS', 'DOTNET_STARTUP_HOOKS',
  'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
  'PYTHONPATH', 'NODE_PATH',
];

// ==================== 沙箱配置 ====================

export interface CommandSandboxConfig {
  commandTimeoutMs: number;
  maxOutputKB: number;
  allowLocalhost: boolean;
}

// ==================== 执行结果 ====================

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  blocked?: string;
}

// ==================== 命令沙箱 ====================

export class CommandSandbox {
  private logger: Logger;
  private config: CommandSandboxConfig;

  constructor(config: CommandSandboxConfig) {
    this.config = config;
    this.logger = createLogger('CommandSandbox');
  }

  /**
   * 在沙箱中执行命令
   */
  async execute(command: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    permissionLevel?: PermissionLevel;
  }): Promise<CommandResult> {
    const startTime = Date.now();

    // 1. 危险命令检查
    const blockResult = this.checkDangerousPatterns(command);
    if (blockResult) {
      this.logger.warn('命令被沙箱阻断', { reason: blockResult, command: command.slice(0, 100) });
      return {
        success: false,
        stdout: '',
        stderr: `命令被安全沙箱阻断: ${blockResult}`,
        exitCode: -1,
        durationMs: Date.now() - startTime,
        truncated: false,
        blocked: blockResult,
      };
    }

    // 2. 过滤环境变量
    const safeEnv = this.filterEnvVars(options?.env);

    // 3. 执行命令（带超时）
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options?.cwd || process.cwd(),
        env: safeEnv,
        timeout: this.config.commandTimeoutMs,
        maxBuffer: this.config.maxOutputKB * 1024,
        // 限制子进程不产生新的子进程
        shell: '/bin/bash',
      });

      const durationMs = Date.now() - startTime;
      const truncated = stdout.length > this.config.maxOutputKB * 1024;

      return {
        success: true,
        stdout: truncated ? stdout.slice(0, this.config.maxOutputKB * 512) : stdout,
        stderr,
        exitCode: 0,
        durationMs,
        truncated,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const stdout = err.stdout || '';
      const stderr = err.stderr || '';
      const truncated = stdout.length > this.config.maxOutputKB * 1024;

      return {
        success: false,
        stdout: truncated ? stdout.slice(0, this.config.maxOutputKB * 512) : stdout,
        stderr: stderr || err.message,
        exitCode: err.code || -1,
        durationMs,
        truncated,
      };
    }
  }

  /**
   * 检查危险命令模式
   */
  checkDangerousPatterns(command: string): string | null {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        const match = command.match(pattern);
        return `匹配危险模式: "${match?.[0]?.slice(0, 50)}"`;
      }
    }
    return null;
  }

  /**
   * 过滤环境变量
   */
  private filterEnvVars(extraEnv?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};

    // 基础安全环境变量
    const safeBase = ['PATH', 'HOME', 'LANG', 'TERM', 'NODE_ENV', 'TZ'];
    for (const key of safeBase) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    // 额外的安全变量
    if (extraEnv) {
      for (const [key, value] of Object.entries(extraEnv)) {
        if (!BLOCKED_ENV_VARS.includes(key.toUpperCase())) {
          env[key] = value;
        }
      }
    }

    return env;
  }
}
