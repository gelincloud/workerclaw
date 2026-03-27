/**
 * 平台 API 客户端
 * 
 * 负责与智工坊平台 HTTP API 通信
 * - 任务结果上报
 * - 任务状态更新
 * - 心跳续约
 */

import { createLogger, type Logger } from '../core/logger.js';
import { EventBus, WorkerClawEvent } from '../core/events.js';
import type { PlatformConfig } from '../core/config.js';
import type { TaskResult } from '../types/task.js';

export interface PlatformApiClientConfig {
  platform: PlatformConfig;
}

export class PlatformApiClient {
  private logger = createLogger('PlatformAPI');
  private eventBus: EventBus;
  private config: PlatformConfig;

  constructor(config: PlatformApiClientConfig, eventBus: EventBus) {
    this.config = config.platform;
    this.eventBus = eventBus;
  }

  /**
   * 上报任务结果
   */
  async reportResult(taskId: string, result: TaskResult): Promise<boolean> {
    const endpoint = `${this.config.apiUrl}/tasks/${taskId}/result`;

    try {
      this.eventBus.emit(WorkerClawEvent.API_REPORT as any, {
        taskId,
        endpoint,
      });

      const response = await this.request(endpoint, 'POST', {
        taskId,
        status: result.status,
        content: result.content,
        outputs: result.outputs,
        tokensUsed: result.tokensUsed,
        durationMs: result.durationMs,
        error: result.error,
        reportedAt: new Date().toISOString(),
      });

      if (response.ok) {
        this.logger.info(`任务结果上报成功 [${taskId}]`, { status: result.status });
        return true;
      } else {
        this.logger.error(`任务结果上报失败 [${taskId}]`, {
          status: response.status,
          body: await response.text().catch(() => 'unknown'),
        });
        this.eventBus.emit(WorkerClawEvent.API_ERROR as any, {
          taskId,
          endpoint,
          error: new Error(`HTTP ${response.status}`),
        });
        return false;
      }
    } catch (err) {
      const error = err as Error;
      this.logger.error(`任务结果上报异常 [${taskId}]`, { error: error.message });
      this.eventBus.emit(WorkerClawEvent.API_ERROR as any, {
        taskId,
        endpoint,
        error,
      });
      return false;
    }
  }

  /**
   * 更新任务状态
   */
  async updateStatus(taskId: string, status: string, reason?: string): Promise<boolean> {
    const endpoint = `${this.config.apiUrl}/tasks/${taskId}/status`;

    try {
      const response = await this.request(endpoint, 'PUT', {
        taskId,
        status,
        reason,
        updatedAt: new Date().toISOString(),
      });

      if (response.ok) {
        this.logger.debug(`任务状态更新成功 [${taskId}] → ${status}`);
        return true;
      } else {
        this.logger.warn(`任务状态更新失败 [${taskId}]`, { httpStatus: response.status });
        return false;
      }
    } catch (err) {
      this.logger.warn(`任务状态更新异常 [${taskId}]`, { error: (err as Error).message });
      return false;
    }
  }

  /**
   * 发送心跳续约
   */
  async heartbeat(): Promise<boolean> {
    const endpoint = `${this.config.apiUrl}/heartbeat`;

    try {
      const response = await this.request(endpoint, 'POST', {
        botId: this.config.botId,
        timestamp: new Date().toISOString(),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 通用 HTTP 请求方法
   */
  private async request(
    url: string,
    method: string,
    body: any,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.token}`,
    };

    return fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000), // 10s 请求超时
    });
  }
}
