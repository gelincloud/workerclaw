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

/** Agent 注册参数 */
export interface RegisterAgentParams {
  /** Agent ID */
  agentId: string;
  /** Agent 名称 */
  agentName?: string;
  /** 能力列表 */
  capabilities: string[];
  /** 是否自动发欢迎推文 */
  autoPostTweet?: boolean;
}

/** Agent 注册结果 */
export interface RegisterAgentResult {
  success: boolean;
  botId?: string;
  token?: string;
  nickname?: string;
  email?: string;
  error?: string;
}

/** Bot 信息 */
export interface BotInfo {
  botId: string;
  nickname: string;
  email?: string;
  level?: number;
  activeDays?: number;
}

export class PlatformApiClient {
  private logger = createLogger('PlatformAPI');
  private eventBus: EventBus;
  private config: PlatformConfig;

  constructor(config: PlatformApiClientConfig, eventBus: EventBus);
  constructor(platform: PlatformConfig, eventBus?: EventBus);
  constructor(config: PlatformApiClientConfig | PlatformConfig, eventBus?: EventBus) {
    if ('platform' in config) {
      this.config = config.platform;
      this.eventBus = eventBus!;
    } else {
      this.config = config;
      this.eventBus = eventBus || new EventBus();
    }
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
   * Agent 注册
   * 调用平台 API 自动创建 Agent 账户
   */
  async registerAgent(params: RegisterAgentParams): Promise<RegisterAgentResult> {
    const endpoint = `${this.config.apiUrl}/api/openclaw/register`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json() as any;

      if (response.ok && (data.success || data.data)) {
        return {
          success: true,
          botId: data.botId || data.data?.botId,
          token: data.token || data.data?.token,
          nickname: data.nickname || data.data?.nickname,
          email: data.email || data.data?.email,
        };
      } else {
        return {
          success: false,
          error: data.error || data.message || `HTTP ${response.status}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * 获取 Bot 信息
   */
  async getBotInfo(botId?: string): Promise<BotInfo | null> {
    const id = botId || this.config.botId;
    const endpoint = `${this.config.apiUrl}/bots/${id}`;

    try {
      const response = await this.request(endpoint, 'GET', undefined);
      if (!response.ok) return null;
      return await response.json() as BotInfo;
    } catch {
      return null;
    }
  }

  /**
   * 测试连接（验证 token 有效性）
   */
  async testConnection(): Promise<{ success: boolean; botId?: string }> {
    try {
      const response = await this.request(
        `${this.config.apiUrl}/heartbeat`,
        'POST',
        {
          botId: this.config.botId,
          timestamp: new Date().toISOString(),
        },
      );

      if (response.ok) {
        return { success: true, botId: this.config.botId };
      }

      return { success: false };
    } catch {
      return { success: false };
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
    };

    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }

    const options: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(10000),
    };

    if (body !== undefined && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    return fetch(url, options);
  }
}
