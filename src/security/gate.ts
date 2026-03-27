/**
 * 安全门（Security Gate）
 * 
 * 安全审查的总调度器，串联四层安全检查：
 * Layer 1: 速率限制
 * Layer 2: 来源验证
 * Layer 3: 内容安全扫描
 * Layer 4: 权限分级
 */

import { createLogger, type Logger } from '../core/logger.js';
import { EventBus, WorkerClawEvent } from '../core/events.js';
import { RateLimiter } from './rate-limiter.js';
import { SourceVerifier } from './source-verifier.js';
import { ContentScanner } from './content-scanner.js';
import { PermissionGrader, type PermissionLevel } from './permission-level.js';
import type { PlatformMessage } from '../types/message.js';
import type { Task, TaskExecutionContext } from '../types/task.js';
import type { SecurityConfig } from '../core/config.js';

export interface SecurityCheckResult {
  passed: boolean;
  blockedBy?: string;
  reason?: string;
  permissionLevel?: PermissionLevel;
  contentFlags?: any[];
}

export interface SecurityGateConfig {
  rateLimit: SecurityConfig['rateLimit'];
  sourceVerify: {
    validateTimestamp: boolean;
    maxTimestampSkewMs: number;
  };
  contentScan: SecurityConfig['contentScan'];
  sandbox: SecurityConfig['sandbox'];
}

export class SecurityGate {
  private logger: Logger;
  private rateLimiter: RateLimiter;
  private sourceVerifier: SourceVerifier;
  private contentScanner: ContentScanner | null;
  private permissionGrader: PermissionGrader;
  private eventBus: EventBus;

  constructor(config: SecurityGateConfig, eventBus: EventBus) {
    this.rateLimiter = new RateLimiter(config.rateLimit);
    this.sourceVerifier = new SourceVerifier(config.sourceVerify);
    this.permissionGrader = new PermissionGrader({
      highValueThreshold: 100, // 超过 100 元降一级
    });
    this.eventBus = eventBus;
    this.logger = createLogger('SecurityGate');

    // Layer 3: 内容扫描器
    if (config.contentScan?.promptInjection?.enabled || config.contentScan?.maliciousCommands?.enabled) {
      this.contentScanner = new ContentScanner({
        promptInjection: config.contentScan.promptInjection,
        maliciousCommands: config.contentScan.maliciousCommands,
        piiProtection: config.contentScan.piiProtection || { enabled: false },
      });
    } else {
      this.contentScanner = null;
    }
  }

  /**
   * 对消息执行完整安全检查（Layer 1-2-3）
   */
  async check(message: PlatformMessage): Promise<SecurityCheckResult> {
    // Layer 1: 速率限制
    const senderId = message.from || 'unknown';
    const rateResult = this.rateLimiter.check(senderId);
    if (!rateResult.allowed) {
      this.eventBus.emit(WorkerClawEvent.SECURITY_BLOCKED, {
        message: `速率限制触发`,
        reason: rateResult.reason || 'rate limited',
        data: { senderId },
      });
      this.logger.warn('消息被速率限制拦截', { senderId, reason: rateResult.reason || 'rate limited' });
      return { passed: false, blockedBy: 'rate_limiter', reason: rateResult.reason || 'rate limited' };
    }

    // Layer 2: 来源验证
    const sourceResult = this.sourceVerifier.verify(message);
    if (!sourceResult.valid) {
      this.eventBus.emit(WorkerClawEvent.SECURITY_BLOCKED, {
        message: `来源验证失败`,
        reason: sourceResult.reason || 'source verification failed',
        data: { msgId: message.msgId },
      });
      this.logger.warn('消息来源验证失败', { reason: sourceResult.reason || 'unknown' });
      return { passed: false, blockedBy: 'source_verifier', reason: sourceResult.reason || 'unknown' };
    }

    // Layer 3: 内容安全扫描（仅对任务推送消息执行）
    if (this.contentScanner && message.data) {
      const contentToScan = typeof message.data === 'string'
        ? message.data
        : message.data.description || JSON.stringify(message.data);

      const scanResult = this.contentScanner.scan(contentToScan);

      if (!scanResult.safe) {
        this.eventBus.emit(WorkerClawEvent.SECURITY_BLOCKED, {
          message: `内容安全扫描未通过`,
          reason: scanResult.rejectionReason || 'content scan failed',
          data: { msgId: message.msgId, flags: scanResult.flags },
        });
        this.logger.warn('消息被内容扫描拦截', {
          reason: scanResult.rejectionReason || 'unknown',
          flagCount: scanResult.flags.length,
        });
        return {
          passed: false,
          blockedBy: 'content_scanner',
          reason: scanResult.rejectionReason || 'content scan failed',
          contentFlags: scanResult.flags,
        };
      }

      // 低风险：记录警告但不拦截
      if (scanResult.riskLevel !== 'none' && scanResult.flags.length > 0) {
        this.eventBus.emit(WorkerClawEvent.SECURITY_WARNED, {
          message: `内容扫描发现风险`,
          reason: `${scanResult.riskLevel} 风险，${scanResult.flags.length} 个标记`,
          data: { msgId: message.msgId, flags: scanResult.flags },
        });
      }
    }

    return { passed: true };
  }

  /**
   * Layer 4: 为任务确定权限级别
   */
  gradePermission(task: Task): PermissionLevel {
    return this.permissionGrader.grade(task);
  }

  /**
   * 获取权限分级器（供外部查询权限）
   */
  getPermissionGrader(): PermissionGrader {
    return this.permissionGrader;
  }

  /**
   * 扫描 Agent 输出内容的安全性
   */
  scanOutput(content: string): { safe: boolean; reason?: string } {
    if (!this.contentScanner) return { safe: true };
    const result = this.contentScanner.scan(content);
    return { safe: result.safe, reason: result.rejectionReason };
  }

  /**
   * 检查任务容量
   */
  checkTaskCapacity(): boolean {
    return this.rateLimiter.checkTaskCapacity().allowed;
  }

  /**
   * 通知任务开始
   */
  taskStarted(): void {
    this.rateLimiter.taskStarted();
  }

  /**
   * 通知任务结束
   */
  taskFinished(): void {
    this.rateLimiter.taskFinished();
  }

  /**
   * 获取速率限制器状态
   */
  getRateLimitStatus() {
    return this.rateLimiter.getStatus();
  }
}
