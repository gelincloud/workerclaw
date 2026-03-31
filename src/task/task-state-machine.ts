/**
 * 任务状态机
 * 
 * 管理任务的生命周期状态流转
 * 
 * 状态流转:
 *   created → evaluating → accepted → running → completed
 *                                  → rejected
 *                        → rejected
 *   running → failed
 *   running → timeout
 *   any → cancelled
 */

import { createLogger, type Logger } from '../core/logger.js';
import { EventBus, WorkerClawEvent } from '../core/events.js';
import type { Task, TaskStatus, TaskStateRecord } from '../types/task.js';

/** 合法的状态转换表 */
const VALID_TRANSITIONS: Partial<Record<TaskStatus, TaskStatus[]>> = {
  created: ['evaluating', 'rejected', 'cancelled'],
  evaluating: ['accepted', 'rejected', 'deferred', 'cancelled'],
  accepted: ['running', 'cancelled'],
  running: ['completed', 'failed', 'timeout', 'cancelled'],
  // timeout 后任务可能仍在执行，允许转为 completed/failed（实际结果）
  timeout: ['completed', 'failed'],
  failed: [],    // 终态
  completed: [], // 终态
  rejected: [],  // 终态
  cancelled: [], // 终态
};

export class TaskStateMachine {
  private logger = createLogger('TaskStateMachine');
  private eventBus: EventBus;
  private states = new Map<string, TaskStateRecord>();

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * 初始化任务状态
   */
  init(task: Task): TaskStateRecord {
    const now = Date.now();
    const record: TaskStateRecord = {
      status: 'created',
      history: [{ status: 'created', timestamp: now }],
      createdAt: now,
      updatedAt: now,
    };
    this.states.set(task.taskId, record);
    return record;
  }

  /**
   * 转换任务状态
   * @throws 如果转换不合法
   */
  transition(taskId: string, newStatus: TaskStatus, reason?: string): TaskStateRecord {
    const record = this.states.get(taskId);
    if (!record) {
      throw new Error(`任务状态记录不存在: ${taskId}`);
    }

    const currentStatus = record.status;
    const allowed = VALID_TRANSITIONS[currentStatus];

    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(
        `非法状态转换: ${taskId} 从 ${currentStatus} → ${newStatus}` +
        ` (允许: ${allowed?.join(', ') || '无'})`,
      );
    }

    const now = Date.now();
    record.status = newStatus;
    record.updatedAt = now;
    record.history.push({ status: newStatus, timestamp: now, reason });

    this.logger.debug(`任务状态变更 [${taskId}]: ${currentStatus} → ${newStatus}`, { reason });
    this.eventBus.emit(WorkerClawEvent.TASK_STATE_CHANGED, {
      taskId,
      from: currentStatus,
      to: newStatus,
      reason,
    });

    return record;
  }

  /**
   * 尝试转换（不抛异常）
   */
  tryTransition(taskId: string, newStatus: TaskStatus, reason?: string): boolean {
    try {
      this.transition(taskId, newStatus, reason);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取任务状态记录
   */
  getState(taskId: string): TaskStateRecord | undefined {
    return this.states.get(taskId);
  }

  /**
   * 获取任务当前状态
   */
  getStatus(taskId: string): TaskStatus | undefined {
    return this.states.get(taskId)?.status;
  }

  /**
   * 检查任务是否处于终态
   */
  isTerminal(taskId: string): boolean {
    const status = this.getStatus(taskId);
    if (!status) return true;
    // timeout 不是终态，因为任务可能仍在执行
    return ['completed', 'failed', 'rejected', 'cancelled'].includes(status);
  }

  /**
   * 更新权限级别
   */
  setPermissionLevel(taskId: string, level: TaskStateRecord['permissionLevel']): void {
    const record = this.states.get(taskId);
    if (record) {
      record.permissionLevel = level;
      record.updatedAt = Date.now();
    }
  }

  /**
   * 清理已完成任务的状态记录
   */
  cleanup(taskId: string): void {
    this.states.delete(taskId);
  }

  /**
   * 获取所有运行中的任务数
   */
  getRunningCount(): number {
    let count = 0;
    for (const record of this.states.values()) {
      if (['running', 'accepted'].includes(record.status)) {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取所有活跃状态的任务 ID 列表
   * 活跃状态：running, accepted, evaluating
   */
  getActiveTaskIds(): string[] {
    const ids: string[] = [];
    for (const [taskId, record] of this.states.entries()) {
      if (['running', 'accepted', 'evaluating'].includes(record.status)) {
        ids.push(taskId);
      }
    }
    return ids;
  }

  /**
   * 获取统计信息
   */
  getStats(): Record<TaskStatus, number> {
    const stats: Record<string, number> = {};
    for (const record of this.states.values()) {
      stats[record.status] = (stats[record.status] || 0) + 1;
    }
    return stats as Record<TaskStatus, number>;
  }
}
