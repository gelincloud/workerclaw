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
  async submitWork(taskId: string, content: string, attachments: string[] = []): Promise<boolean> {
    const endpoint = `${this.config.apiUrl}/api/task/${taskId}/submit`;

    try {
      this.eventBus.emit(WorkerClawEvent.API_REPORT as any, {
        taskId,
        endpoint,
      });

      const response = await this.request(endpoint, 'POST', {
        submitterId: this.config.botId,
        content,
        attachments,
      });

      if (response.ok) {
        this.logger.info(`任务成果提交成功 [${taskId}]`, {
          attachmentsCount: attachments.length,
        });
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
   * 上传文件到平台 COS
   * POST /api/cos/upload
   * body: { filedata: base64, filename, filetype }
   * 返回: { success, url, key }
   */
  async uploadFile(fileData: string, filename: string, filetype: string): Promise<{ success: boolean; url: string; key: string } | null> {
    const endpoint = `${this.config.apiUrl}/api/cos/upload`;

    try {
      const response = await this.request(endpoint, 'POST', {
        filedata: fileData,
        filename,
        filetype,
      });

      if (response.ok) {
        const data = await response.json() as any;
        if (data.success && data.url) {
          this.logger.info(`文件上传成功: ${filename} → ${data.url.slice(0, 80)}...`);
          return { success: true, url: data.url, key: data.key || '' };
        }
      }

      const errorText = await response.text().catch(() => 'unknown');
      this.logger.warn(`文件上传失败: ${filename}`, { error: errorText.slice(0, 200) });
      return null;
    } catch (err) {
      this.logger.error(`文件上传异常: ${filename}`, { error: (err as Error).message });
      return null;
    }
  }

  /**
   * 提交带文件附件的任务成果（先上传文件，再提交）
   */
  async submitWorkWithFiles(
    taskId: string,
    content: string,
    files: Array<{ data: string; name: string; type: string }>,
  ): Promise<boolean> {
    if (files.length === 0) {
      return this.submitWork(taskId, content);
    }

    // 并行上传所有文件
    const uploadResults = await Promise.all(
      files.map(f => this.uploadFile(f.data, f.name, f.type)),
    );

    // 收集成功的 URL
    const urls = uploadResults
      .filter((r): r is { success: true; url: string; key: string } => r !== null && r.success)
      .map(r => r.url);

    this.logger.info(`文件上传完成 [${taskId}]`, {
      total: files.length,
      success: urls.length,
    });

    return this.submitWork(taskId, content, urls);
  }

  /**
   * 上报任务结果（内部调用 submitWork，支持文件附件）
   */
  async reportResult(taskId: string, result: TaskResult): Promise<boolean> {
    if (result.status === 'completed' && result.content) {
      // 如果有文件产出，先上传再提交
      const fileOutputs = (result.outputs || []).filter(o => o.type === 'image' || o.type === 'file');
      if (fileOutputs.length > 0) {
        this.logger.info(`任务 [${taskId}] 包含 ${fileOutputs.length} 个文件附件，开始上传...`);
        const fs = await import('fs');
        const path = await import('path');

        const uploadFiles: Array<{ data: string; name: string; type: string }> = [];
        for (const output of fileOutputs) {
          try {
            const filePath = output.content;
            if (!fs.existsSync(filePath)) {
              this.logger.warn(`文件不存在，跳过: ${filePath}`);
              continue;
            }
            const fileBuffer = fs.readFileSync(filePath);
            const base64 = fileBuffer.toString('base64');
            const ext = path.extname(filePath).slice(1).toLowerCase();
            const mimeMap: Record<string, string> = {
              jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
              gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
              pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
              json: 'application/json', html: 'text/html', md: 'text/markdown',
              mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
              doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            };
            const mime = output.mimeType || mimeMap[ext] || 'application/octet-stream';
            const name = output.name || path.basename(filePath);
            uploadFiles.push({ data: base64, name, type: mime });
          } catch (err) {
            this.logger.warn(`文件读取失败: ${output.content}`, { error: (err as Error).message });
          }
        }

        if (uploadFiles.length > 0) {
          return this.submitWorkWithFiles(taskId, result.content, uploadFiles);
        }
      }

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
   * 发送心跳续约（WebSocket）
   *
   * 注意：服务端没有 HTTP heartbeat 端点，心跳通过 WebSocket 层完成。
   * 此方法保留为兼容接口，实际不做任何 HTTP 请求。
   * WS 心跳由 MiniAbcClient.startHeartbeat() 管理。
   */
  async heartbeat(): Promise<boolean> {
    // WebSocket 心跳已在 MiniAbcClient 中处理（发送 { type: 'heartbeat' }）
    // 无需 HTTP 心跳请求
    this.logger.debug('heartbeat() 调用（心跳已通过 WebSocket 处理）');
    return true;
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
   * 使用 GET /api/bot/:id 检查 botId 是否存在，验证连接和认证
   */
  async testConnection(): Promise<{ success: boolean; botId?: string }> {
    try {
      const endpoint = `${this.config.apiUrl}/api/bot/${this.config.botId}`;
      const response = await this.request(endpoint, 'GET', undefined);

      if (response.ok) {
        return { success: true, botId: this.config.botId };
      }

      this.logger.warn(`连接测试失败`, { httpStatus: response.status });
      return { success: false };
    } catch (err) {
      this.logger.warn(`连接测试异常`, { error: (err as Error).message });
      return { success: false };
    }
  }

  /**
   * 发送公共聊天室消息
   * POST /api/chat/messages
   */
  async sendChatMessage(
    content: string,
  ): Promise<{ success: boolean; error?: string }> {
    const endpoint = `${this.config.apiUrl}/api/chat/messages`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ botId: this.config.botId, content }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json() as any;
      if (response.ok && data.success) {
        this.logger.info(`聊天消息已发送`);
        return { success: true };
      } else {
        this.logger.warn(`聊天消息发送失败`, { error: data.error || data.message });
        return { success: false, error: data.error || data.message };
      }
    } catch (err) {
      this.logger.error('聊天消息发送异常', { error: (err as Error).message });
      return { success: false, error: (err as Error).message };
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
   * 取消接单/放弃任务
   * POST /api/task/:taskId/cancel-take
   * body: { takerId }
   */
  async cancelTake(taskId: string): Promise<{ success: boolean; error?: string }> {
    const endpoint = `${this.config.apiUrl}/api/task/${taskId}/cancel-take`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ takerId: this.config.botId }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await response.json() as any;
      if (response.ok && (data.success || data.ok)) {
        this.logger.info(`已取消接单 [${taskId}]`);
        return { success: true };
      } else {
        this.logger.warn(`取消接单失败 [${taskId}]`, { error: data.error || data.message });
        return { success: false, error: data.error || data.message };
      }
    } catch (err) {
      this.logger.error('取消接单异常', { error: (err as Error).message });
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * 申请仲裁
   * POST /api/task/:taskId/apply-arbitration
   * body: { botId }
   */
  async applyArbitration(taskId: string): Promise<{ success: boolean; error?: string }> {
    const endpoint = `${this.config.apiUrl}/api/task/${taskId}/apply-arbitration`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ botId: this.config.botId }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await response.json() as any;
      if (response.ok && (data.success || data.ok)) {
        this.logger.info(`已申请仲裁 [${taskId}]`);
        return { success: true };
      } else {
        this.logger.warn(`申请仲裁失败 [${taskId}]`, { error: data.error || data.message });
        return { success: false, error: data.error || data.message };
      }
    } catch (err) {
      this.logger.error('申请仲裁异常', { error: (err as Error).message });
      return { success: false, error: (err as Error).message };
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
