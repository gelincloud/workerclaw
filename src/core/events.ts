/**
 * WorkerClaw 事件总线
 * 
 * 模块间松耦合通信的核心机制
 */

import { createLogger, type Logger } from './logger.js';
import type { Task, TaskStatus } from '../types/task.js';

// ==================== 事件类型 ====================

export enum WorkerClawEvent {
  // 生命周期
  STARTING = 'workerclaw:starting',
  READY = 'workerclaw:ready',
  SHUTTING_DOWN = 'workerclaw:shutting_down',
  SHUTDOWN = 'workerclaw:shutdown',

  // 连接
  WS_CONNECTING = 'ws:connecting',
  WS_CONNECTED = 'ws:connected',
  WS_DISCONNECTED = 'ws:disconnected',
  WS_RECONNECTING = 'ws:reconnecting',
  WS_ERROR = 'ws:error',

  // 安全
  SECURITY_BLOCKED = 'security:blocked',
  SECURITY_WARNED = 'security:warned',

  // 任务
  TASK_RECEIVED = 'task:received',
  TASK_EVALUATED = 'task:evaluated',
  TASK_ACCEPTED = 'task:accepted',
  TASK_REJECTED = 'task:rejected',
  TASK_STARTED = 'task:started',
  TASK_PROGRESS = 'task:progress',
  TASK_COMPLETED = 'task:completed',
  TASK_FAILED = 'task:failed',
  TASK_TIMEOUT = 'task:timeout',
  TASK_CANCELLED = 'task:cancelled',
  TASK_DEFERRED = 'task:deferred',
  TASK_QUEUED = 'task:queued',
  TASK_DEQUEUED = 'task:dequeued',
  TASK_STATE_CHANGED = 'task:state_changed',

  // 工具
  TOOL_CALLED = 'tool:called',
  TOOL_COMPLETED = 'tool:completed',
  TOOL_BLOCKED = 'tool:blocked',

  // 并发
  CONCURRENCY_LIMIT = 'concurrency:limit',
  QUEUE_FULL = 'queue:full',

  // 平台 API
  API_REPORT = 'api:report',
  API_ERROR = 'api:error',

  // LLM
  LLM_REQUEST = 'llm:request',
  LLM_RESPONSE = 'llm:response',
  LLM_ERROR = 'llm:error',
}

// ==================== 事件数据 ====================

export interface EventMap {
  [WorkerClawEvent.STARTING]: void;
  [WorkerClawEvent.READY]: void;
  [WorkerClawEvent.SHUTTING_DOWN]: { reason?: string };
  [WorkerClawEvent.SHUTDOWN]: void;

  [WorkerClawEvent.WS_CONNECTING]: { attempt: number };
  [WorkerClawEvent.WS_CONNECTED]: void;
  [WorkerClawEvent.WS_DISCONNECTED]: { code: number; reason: string };
  [WorkerClawEvent.WS_RECONNECTING]: { attempt: number; delayMs: number };
  [WorkerClawEvent.WS_ERROR]: { error: Error };

  [WorkerClawEvent.SECURITY_BLOCKED]: { message: string; reason: string; data?: any };
  [WorkerClawEvent.SECURITY_WARNED]: { message: string; reason: string; data?: any };

  [WorkerClawEvent.TASK_RECEIVED]: { task: Task };
  [WorkerClawEvent.TASK_EVALUATED]: { taskId: string; evaluation: any };
  [WorkerClawEvent.TASK_ACCEPTED]: { taskId: string };
  [WorkerClawEvent.TASK_REJECTED]: { taskId: string; reason: string };
  [WorkerClawEvent.TASK_STARTED]: { taskId: string };
  [WorkerClawEvent.TASK_PROGRESS]: { taskId: string; progress: number; message?: string };
  [WorkerClawEvent.TASK_COMPLETED]: { taskId: string; result: any };
  [WorkerClawEvent.TASK_FAILED]: { taskId: string; error: Error };
  [WorkerClawEvent.TASK_TIMEOUT]: { taskId: string };
  [WorkerClawEvent.TASK_CANCELLED]: { taskId: string };
  [WorkerClawEvent.TASK_DEFERRED]: { taskId: string; score: number };
  [WorkerClawEvent.TASK_QUEUED]: { taskId: string; queuePosition: number };
  [WorkerClawEvent.TASK_DEQUEUED]: { taskId: string };
  [WorkerClawEvent.TASK_STATE_CHANGED]: { taskId: string; from: TaskStatus; to: TaskStatus; reason?: string };

  [WorkerClawEvent.TOOL_CALLED]: { taskId: string; toolName: string; toolCallId: string };
  [WorkerClawEvent.TOOL_COMPLETED]: { taskId: string; toolName: string; toolCallId: string; success: boolean };
  [WorkerClawEvent.TOOL_BLOCKED]: { taskId: string; toolName: string; reason: string };

  [WorkerClawEvent.CONCURRENCY_LIMIT]: { runningCount: number; maxConcurrent: number };
  [WorkerClawEvent.QUEUE_FULL]: { queueSize: number; maxQueueSize: number };

  [WorkerClawEvent.API_REPORT]: { taskId: string; endpoint: string };
  [WorkerClawEvent.API_ERROR]: { taskId: string; endpoint: string; error: Error };

  [WorkerClawEvent.LLM_REQUEST]: { taskId: string; model: string };
  [WorkerClawEvent.LLM_RESPONSE]: { taskId: string; tokens?: { prompt: number; completion: number } };
  [WorkerClawEvent.LLM_ERROR]: { taskId: string; error: Error };
}

// ==================== 事件处理器 ====================

export type EventHandler<T = any> = (data: T) => void | Promise<void>;

// ==================== 事件总线 ====================

export class EventBus {
  private logger = createLogger('EventBus');
  private handlers = new Map<string, Set<EventHandler>>();
  private onceHandlers = new Map<string, Set<EventHandler>>();
  private maxListeners = 50;

  /**
   * 注册事件监听器
   */
  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    if (!this.handlers.has(event as string)) {
      this.handlers.set(event as string, new Set());
    }
    const set = this.handlers.get(event as string)!;
    if (set.size >= this.maxListeners) {
      this.logger.warn(`Event "${String(event)}" 已达到最大监听器数量 ${this.maxListeners}`);
    }
    set.add(handler as EventHandler);
  }

  /**
   * 注册一次性事件监听器
   */
  once<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    if (!this.onceHandlers.has(event as string)) {
      this.onceHandlers.set(event as string, new Set());
    }
    this.onceHandlers.get(event as string)!.add(handler as EventHandler);
  }

  /**
   * 移除事件监听器
   */
  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    this.handlers.get(event as string)?.delete(handler as EventHandler);
    this.onceHandlers.get(event as string)?.delete(handler as EventHandler);
  }

  /**
   * 触发事件
   */
  async emit<K extends keyof EventMap>(event: K, data: EventMap[K]): Promise<void> {
    this.logger.debug(`Event: ${String(event)}`, data);

    // 常规处理器
    const handlers = this.handlers.get(event as string);
    if (handlers) {
      for (const handler of handlers) {
        try {
          await handler(data);
        } catch (err) {
          this.logger.error(`Event handler error for "${String(event)}"`, err);
        }
      }
    }

    // 一次性处理器
    const onceSet = this.onceHandlers.get(event as string);
    if (onceSet) {
      for (const handler of onceSet) {
        try {
          await handler(data);
        } catch (err) {
          this.logger.error(`Once handler error for "${String(event)}"`, err);
        }
      }
      onceSet.clear();
    }
  }

  /**
   * 等待事件触发（Promise 化）
   */
  waitFor<K extends keyof EventMap>(event: K, timeoutMs = 30000): Promise<EventMap[K]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timeout waiting for event "${String(event)}" after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (data: EventMap[K]) => {
        clearTimeout(timer);
        resolve(data);
      };

      this.once(event, handler);
    });
  }

  /**
   * 清除所有监听器
   */
  removeAllListeners(event?: string): void {
    if (event) {
      this.handlers.delete(event);
      this.onceHandlers.delete(event);
    } else {
      this.handlers.clear();
      this.onceHandlers.clear();
    }
  }
}

/** 全局事件总线单例 */
export const eventBus = new EventBus();
