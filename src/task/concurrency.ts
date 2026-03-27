/**
 * 并发控制器
 * 
 * 管理任务并发执行，包括：
 * - 最大并发数限制
 * - 按任务类型的并发限制
 * - 等待队列 + 优先级调度
 * - 任务完成后自动从队列取下一个
 */

import { createLogger, type Logger } from '../core/logger.js';
import { EventBus, WorkerClawEvent } from '../core/events.js';
import type { Task, ConcurrencyConfig, TaskType } from '../types/task.js';

/** 队列中的任务项 */
interface QueuedTask {
  task: Task;
  enqueuedAt: number;
  /** 队列等待超时定时器 */
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

export class ConcurrencyController {
  private logger: Logger;
  private eventBus: EventBus;
  private config: ConcurrencyConfig;

  /** 运行中的任务 */
  private running = new Map<string, Task>();

  /** 按类型统计运行中任务数 */
  private runningByType = new Map<TaskType, number>();

  /** 等待队列（按优先级排序） */
  private queue: QueuedTask[] = [];

  /** 队列超时回调 */
  private onQueueTimeout?: (task: Task) => void;

  /** 处理队列回调 */
  private onProcessQueue?: () => void;

  constructor(config: ConcurrencyConfig, eventBus: EventBus) {
    this.config = config;
    this.eventBus = eventBus;
    this.logger = createLogger('Concurrency');
  }

  /**
   * 设置队列超时回调
   */
  setQueueTimeoutHandler(handler: (task: Task) => void): void {
    this.onQueueTimeout = handler;
  }

  /**
   * 设置处理队列回调（当有空位时触发）
   */
  setProcessQueueHandler(handler: () => void): void {
    this.onProcessQueue = handler;
  }

  /**
   * 尝试启动任务（有容量立即启动，否则入队列）
   * @returns 'started' | 'queued' | 'rejected'
   */
  tryStart(task: Task): 'started' | 'queued' | 'rejected' {
    // 检查全局并发
    if (this.running.size >= this.config.maxConcurrent) {
      return this.enqueue(task);
    }

    // 检查按类型并发
    const typeLimit = this.config.maxPerType[task.taskType];
    if (typeLimit !== undefined) {
      const typeCount = this.runningByType.get(task.taskType) || 0;
      if (typeCount >= typeLimit) {
        return this.enqueue(task);
      }
    }

    // 启动
    this.running.set(task.taskId, task);
    this.runningByType.set(task.taskType, (this.runningByType.get(task.taskType) || 0) + 1);

    this.logger.info(`任务开始执行 [${task.taskId}]`, {
      type: task.taskType,
      running: this.running.size,
      max: this.config.maxConcurrent,
    });

    return 'started';
  }

  /**
   * 任务入队
   * @returns 'queued' | 'rejected'
   */
  private enqueue(task: Task): 'queued' | 'rejected' {
    if (this.queue.length >= this.config.queueSize) {
      this.eventBus.emit(WorkerClawEvent.QUEUE_FULL, {
        queueSize: this.queue.length,
        maxQueueSize: this.config.queueSize,
      });
      return 'rejected';
    }

    const item: QueuedTask = {
      task,
      enqueuedAt: Date.now(),
    };

    this.queue.push(item);
    this.sortQueue();

    const position = this.queue.findIndex(i => i.task.taskId === task.taskId) + 1;
    this.logger.info(`任务入队 [${task.taskId}]`, { position, queueSize: this.queue.length });
    this.eventBus.emit(WorkerClawEvent.TASK_QUEUED, { taskId: task.taskId, queuePosition: position });

    return 'queued';
  }

  /**
   * 排序队列（优先级调度）
   */
  private sortQueue(): void {
    this.queue.sort((a, b) => {
      let scoreA = 0;
      let scoreB = 0;

      // 高金额优先
      if (this.config.priority.highValueFirst) {
        scoreA += (a.task.reward || 0) * 10;
        scoreB += (b.task.reward || 0) * 10;
      }

      // 紧急任务优先（截止时间近的优先）
      if (this.config.priority.urgentFirst) {
        if (a.task.deadline) {
          const remaining = new Date(a.task.deadline).getTime() - Date.now();
          if (remaining > 0 && remaining < 60 * 60 * 1000) scoreA += 50; // 1小时内
        }
        if (b.task.deadline) {
          const remaining = new Date(b.task.deadline).getTime() - Date.now();
          if (remaining > 0 && remaining < 60 * 60 * 1000) scoreB += 50;
        }
      }

      // 先入先出（同等优先级）
      if (scoreA === scoreB) return a.enqueuedAt - b.enqueuedAt;
      return scoreB - scoreA;
    });
  }

  /**
   * 任务完成，释放槽位
   */
  taskFinished(taskId: string): void {
    const task = this.running.get(taskId);
    if (!task) return;

    this.running.delete(taskId);
    const typeCount = (this.runningByType.get(task.taskType) || 1) - 1;
    if (typeCount <= 0) {
      this.runningByType.delete(task.taskType);
    } else {
      this.runningByType.set(task.taskType, typeCount);
    }

    this.logger.debug(`任务完成释放槽位 [${taskId}]`, {
      running: this.running.size,
      max: this.config.maxConcurrent,
    });

    // 处理队列
    this.processQueue();
  }

  /**
   * 从队列取出下一个任务执行
   */
  processQueue(): boolean {
    if (this.queue.length === 0) return false;

    const next = this.queue[0];
    const typeLimit = this.config.maxPerType[next.task.taskType];

    // 检查容量
    if (this.running.size >= this.config.maxConcurrent) return false;
    if (typeLimit !== undefined) {
      const typeCount = this.runningByType.get(next.task.taskType) || 0;
      if (typeCount >= typeLimit) return false;
    }

    // 取出并启动
    this.queue.shift();
    if (next.timeoutTimer) {
      clearTimeout(next.timeoutTimer);
    }

    this.running.set(next.task.taskId, next.task);
    this.runningByType.set(
      next.task.taskType,
      (this.runningByType.get(next.task.taskType) || 0) + 1,
    );

    this.logger.info(`从队列取出任务 [${next.task.taskId}]`, {
      type: next.task.taskType,
      running: this.running.size,
    });
    this.eventBus.emit(WorkerClawEvent.TASK_DEQUEUED, { taskId: next.task.taskId });

    // 通知外部处理
    if (this.onProcessQueue) {
      this.onProcessQueue();
    }

    return true;
  }

  /**
   * 取消队列中的任务
   */
  removeFromQueue(taskId: string): boolean {
    const idx = this.queue.findIndex(i => i.task.taskId === taskId);
    if (idx === -1) return false;
    const item = this.queue.splice(idx, 1)[0];
    if (item.timeoutTimer) clearTimeout(item.timeoutTimer);
    return true;
  }

  /**
   * 检查是否有可用容量
   */
  hasCapacity(taskType?: TaskType): boolean {
    if (this.running.size >= this.config.maxConcurrent) return false;
    if (taskType) {
      const typeLimit = this.config.maxPerType[taskType];
      if (typeLimit !== undefined) {
        const typeCount = this.runningByType.get(taskType) || 0;
        if (typeCount >= typeLimit) return false;
      }
    }
    return true;
  }

  /**
   * 设置队列项超时
   */
  setQueueTimeout(taskId: string, timeoutMs: number): void {
    const item = this.queue.find(i => i.task.taskId === taskId);
    if (!item) return;

    item.timeoutTimer = setTimeout(() => {
      const idx = this.queue.findIndex(i => i.task.taskId === taskId);
      if (idx !== -1) {
        this.queue.splice(idx, 1);
        this.logger.warn(`队列任务超时 [${taskId}]`, { timeoutMs });
        if (this.onQueueTimeout) {
          this.onQueueTimeout(item.task);
        }
      }
    }, timeoutMs);
  }

  /**
   * 获取统计信息
   */
  getStats(): { running: number; queue: number; maxConcurrent: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    for (const [type, count] of this.runningByType) {
      byType[type] = count;
    }
    return {
      running: this.running.size,
      queue: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
      byType,
    };
  }

  /**
   * 取消指定任务
   */
  cancelTask(taskId: string): boolean {
    // 如果在运行中，从运行中移除
    if (this.running.delete(taskId)) {
      const taskType = this.queue.find(i => i.task.taskId === taskId)?.task.taskType;
      // 无法精确知道 taskType，但可以通过遍历
      this.logger.info(`取消运行中任务 [${taskId}]`);
      this.processQueue();
      return true;
    }
    // 如果在队列中
    return this.removeFromQueue(taskId);
  }

  /**
   * 清理所有资源
   */
  dispose(): void {
    for (const item of this.queue) {
      if (item.timeoutTimer) clearTimeout(item.timeoutTimer);
    }
    this.queue = [];
    this.running.clear();
    this.runningByType.clear();
  }
}
