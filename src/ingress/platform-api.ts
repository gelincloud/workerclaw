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
   * 接单
   * POST /api/task/:id/take
   * 服务端实际接口: { takerId }
   */
  async takeTask(taskId: string): Promise<boolean> {
    const endpoint = `${this.config.apiUrl}/api/task/${taskId}/take`;

    try {
      this.eventBus.emit(WorkerClawEvent.API_REPORT as any, {
        taskId,
        endpoint,
      });

      const response = await this.request(endpoint, 'POST', {
        takerId: this.config.botId,
      });

      if (response.ok) {
        this.logger.info(`接单成功 [${taskId}]`);
        return true;
      } else {
        const errorText = await response.text().catch(() => 'unknown');
        this.logger.warn(`接单失败 [${taskId}]`, { httpStatus: response.status, error: errorText.slice(0, 200) });
        return false;
      }
    } catch (err) {
      this.logger.warn(`接单异常 [${taskId}]`, { error: (err as Error).message });
      return false;
    }
  }

  /**
   * 提交任务成果
   * POST /api/task/:id/submit
   * 服务端实际接口: { submitterId, content, attachments }
   */
  async submitWork(taskId: string, content: string): Promise<boolean> {
    const endpoint = `${this.config.apiUrl}/api/task/${taskId}/submit`;

    try {
      this.eventBus.emit(WorkerClawEvent.API_REPORT as any, {
        taskId,
        endpoint,
      });

      const response = await this.request(endpoint, 'POST', {
        submitterId: this.config.botId,
        content,
        attachments: [],
      });

      if (response.ok) {
        this.logger.info(`任务成果提交成功 [${taskId}]`);
        return true;
      } else {
        const errorText = await response.text().catch(() => 'unknown');
        this.logger.error(`任务成果提交失败 [${taskId}]`, {
          httpStatus: response.status,
          error: errorText.slice(0, 200),
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
      this.logger.error(`任务成果提交异常 [${taskId}]`, { error: error.message });
      this.eventBus.emit(WorkerClawEvent.API_ERROR as any, {
        taskId,
        endpoint,
        error,
      });
      return false;
    }
  }

  /**
   * 上报任务结果（兼容旧接口，内部调用 submitWork）
   */
  async reportResult(taskId: string, result: TaskResult): Promise<boolean> {
    if (result.status === 'completed' && result.content) {
      return this.submitWork(taskId, result.content);
    }

    // 失败状态暂不提交（服务端没有对应接口）
    this.logger.warn(`任务 [${taskId}] 状态 ${result.status} 无对应服务端接口，跳过上报`, {
      error: result.error,
    });
    return false;
  }

  /**
   * 更新任务状态（服务端无此接口，保留为 no-op 兼容）
   */
  async updateStatus(taskId: string, status: string, reason?: string): Promise<boolean> {
    // 服务端没有 /tasks/:id/status 端点
    // 接单状态已在 takeTask 中处理
    this.logger.debug(`任务状态更新 [${taskId}] → ${status}（服务端无此接口，跳过）`);
    return true;
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
   * 发送站内私信回复
   * POST /api/private-messages
   */
  async sendPrivateMessage(
    senderId: string,
    receiverId: string,
    content: string,
  ): Promise<{ success: boolean; error?: string }> {
    const endpoint = `${this.config.apiUrl}/api/private-messages`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ senderId, receiverId, content }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json() as any;
      if (response.ok && (data.success || data.id)) {
        this.logger.info(`私信回复已发送 → ${receiverId}`);
        return { success: true };
      } else {
        this.logger.warn(`私信回复失败`, { error: data.error || data.message });
        return { success: false, error: data.error || data.message };
      }
    } catch (err) {
      this.logger.error('私信回复异常', { error: (err as Error).message });
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * 发送评论回复
   * POST /api/tweet/:tweetId/comment
   */
  async postComment(
    tweetId: string,
    content: string,
  ): Promise<{ success: boolean; error?: string }> {
    const endpoint = `${this.config.apiUrl}/api/tweet/${tweetId}/comment`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ botId: this.config.botId, content }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json() as any;
      if (response.ok && (data.success || data.id)) {
        this.logger.info(`评论回复已发送 → tweetId=${tweetId}`);
        return { success: true };
      } else {
        this.logger.warn(`评论回复失败`, { error: data.error || data.message });
        return { success: false, error: data.error || data.message };
      }
    } catch (err) {
      this.logger.error('评论回复异常', { error: (err as Error).message });
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * 获取任务详情
   * GET /api/task/:taskId
   */
  async getTaskDetail(taskId: string): Promise<any | null> {
    const endpoint = `${this.config.apiUrl}/api/task/${taskId}`;

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return null;
      return await response.json() as any;
    } catch (err) {
      this.logger.error('获取任务详情异常', { error: (err as Error).message });
      return null;
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
