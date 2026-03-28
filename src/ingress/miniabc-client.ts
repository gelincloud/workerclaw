/**
 * 智工坊平台 WebSocket 客户端
 * 
 * 负责与智工坊平台的 WebSocket 连接，包含：
 * - 自动连接与断线重连
 * - 心跳保活
 * - 消息收发
 * - 消息解析与分发
 * 
 * 协议对齐服务端 server.js 实际实现：
 * - 连接路径: /ws/openclaw
 * - 认证: 连接后发送 { type: 'auth', payload: { botId, token } }
 * - 认证响应: { type: 'auth_success', payload: { botId }, timestamp }
 * - 心跳: 发送 { type: 'heartbeat' }，响应 { type: 'pong', payload: { status: 'ok' } }
 * - 服务端推送: { type: 'new_task'|'new_message'|..., payload: {...}, timestamp }
 */

import WebSocket from 'ws';
import { createLogger, type Logger } from '../core/logger.js';
import { EventBus, WorkerClawEvent } from '../core/events.js';
import type { PlatformConfig } from '../core/config.js';
import type { PlatformMessage } from '../types/message.js';

export interface MiniABCClientOptions {
  config: PlatformConfig;
  eventBus: EventBus;
}

export class MiniABCClient {
  private logger: Logger;
  private config: PlatformConfig;
  private eventBus: EventBus;

  private ws: WebSocket | null = null;
  private isShuttingDown = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 30000; // 30 秒心跳
  private isConnected = false;

  // 消息缓冲（断线期间的消息）
  private messageBuffer: any[] = [];
  private messageListeners: Array<(msg: PlatformMessage) => void> = [];

  constructor(options: MiniABCClientOptions) {
    this.config = options.config;
    this.eventBus = options.eventBus;
    this.logger = createLogger('MiniABCClient');
  }

  /**
   * 启动连接
   */
  async connect(): Promise<void> {
    this.isShuttingDown = false;
    await this.doConnect();
  }

  /**
   * 执行连接
   */
  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.reconnectAttempt++;
      this.eventBus.emit(WorkerClawEvent.WS_CONNECTING, { attempt: this.reconnectAttempt });

      // 直接连接 wsUrl（不带 query 参数，认证通过消息完成）
      const wsUrl = this.config.wsUrl;

      this.logger.info(`正在连接平台 WebSocket (attempt ${this.reconnectAttempt}): ${wsUrl}`);

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.logger.info('WebSocket 连接已建立，发送认证...');
        // 连接成功后立即发送 auth 消息（服务端协议要求）
        this.sendAuth();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleRawMessage(data);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.handleDisconnect(code, reason.toString());
      });

      this.ws.on('error', (err: Error) => {
        this.logger.error('WebSocket 错误', err.message);
        this.eventBus.emit(WorkerClawEvent.WS_ERROR, { error: err });
      });

      // 等待认证成功或超时
      const timeout = setTimeout(() => {
        reject(new Error(`连接超时 (15s)，未收到认证响应`));
      }, 15000);

      this.onceConnected(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * 发送认证消息（对齐服务端协议）
   */
  private sendAuth(): void {
    const authMessage = {
      type: 'auth',
      payload: {
        botId: this.config.botId,
        token: this.config.token,
      },
    };
    this.ws!.send(JSON.stringify(authMessage));
    this.logger.debug('已发送认证消息', { botId: this.config.botId });
  }

  /**
   * 处理原始消息
   */
  private handleRawMessage(data: WebSocket.Data): void {
    try {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      const message = JSON.parse(text);

      // 统一消息格式：服务端用 payload，内部用 data
      const platformMessage: PlatformMessage = {
        type: message.type,
        msgId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: message.timestamp || new Date().toISOString(),
        from: message.from,
        data: message.payload || message.data || {},
        payload: message.payload,
      };

      this.handleMessage(platformMessage);
    } catch (err) {
      this.logger.warn('消息解析失败', { data: String(data).slice(0, 200) });
    }
  }

  /**
   * 处理平台消息
   */
  private handleMessage(message: PlatformMessage): void {
    this.logger.debug('收到消息', { type: message.type });

    switch (message.type) {
      case 'auth_success':
        // 服务端认证成功响应
        this.handleAuthSuccess(message);
        break;

      case 'pong':
        // 心跳响应
        this.logger.debug('收到 PONG');
        break;

      case 'new_task':
      case 'new_private_task':
        // 任务推送
        this.dispatchMessage(message);
        break;

      case 'new_message':
      case 'new_private_message':
      case 'comment':
      case 'blog_comment':
      case 'blog_reply':
      case 'email_sent':
      case 'new_email':
      case 'chat_message':
      case 'nickname_update':
      case 'user_status':
      case 'online_count':
      case 'task_rejected':
      case 'task_closed':
      case 'task_arbitration_applied':
      case 'task_arbitration_resolved':
      case 'bid_won':
      case 'gift_received':
      case 'ocean_new_message':
        // 其他服务端消息，分发给监听器
        this.dispatchMessage(message);
        break;

      default:
        this.logger.debug('未处理的消息类型', { type: message.type });
    }
  }

  /**
   * 处理认证成功
   */
  private handleAuthSuccess(message: PlatformMessage): void {
    const botId = message.data?.botId || message.payload?.botId;
    this.isConnected = true;
    this.reconnectAttempt = 0;

    this.logger.info(`✅ 认证成功，botId: ${botId}`);

    this.eventBus.emit(WorkerClawEvent.WS_CONNECTED, undefined as any);
    this.startHeartbeat();

    // 发送缓冲的消息（如有）
    this.flushMessageBuffer();
  }

  /**
   * 启动心跳（对齐服务端协议：发送 heartbeat 类型）
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
        // 服务端期望 type: 'heartbeat'
        this.ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, this.heartbeatIntervalMs);

    this.logger.debug(`心跳已启动，间隔 ${this.heartbeatIntervalMs / 1000}s`);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 处理断线
   */
  private handleDisconnect(code: number, reason: string): void {
    this.isConnected = false;
    this.stopHeartbeat();

    this.eventBus.emit(WorkerClawEvent.WS_DISCONNECTED, { code, reason });

    if (this.isShuttingDown) {
      this.logger.info('WebSocket 已关闭（主动关闭）');
      return;
    }

    this.logger.warn(`WebSocket 断开 (code: ${code}, reason: ${reason || 'none'})`);

    // 自动重连
    if (this.reconnectAttempt < this.config.reconnect.maxRetries) {
      const delayMs = this.calculateReconnectDelay();
      this.eventBus.emit(WorkerClawEvent.WS_RECONNECTING, {
        attempt: this.reconnectAttempt + 1,
        delayMs,
      });

      this.logger.info(`将在 ${Math.round(delayMs)}ms 后重连 (attempt ${this.reconnectAttempt + 1}/${this.config.reconnect.maxRetries})`);
      this.reconnectTimer = setTimeout(() => {
        this.doConnect().catch(err => {
          this.logger.error('重连失败', err.message);
        });
      }, delayMs);
    } else {
      this.logger.error(`已达最大重连次数 (${this.config.reconnect.maxRetries})，停止重连`);
    }
  }

  /**
   * 计算重连延迟（指数退避）
   */
  private calculateReconnectDelay(): number {
    const base = this.config.reconnect.baseDelayMs;
    const max = this.config.reconnect.maxDelayMs;
    const delay = base * Math.pow(2, this.reconnectAttempt - 1);
    // 加入 ±20% 的随机抖动
    const jitter = delay * 0.2 * (Math.random() - 0.5);
    return Math.min(delay + jitter, max);
  }

  /**
   * 注册消息监听器
   */
  onMessage(listener: (msg: PlatformMessage) => void): () => void {
    this.messageListeners.push(listener);
    return () => {
      const index = this.messageListeners.indexOf(listener);
      if (index >= 0) this.messageListeners.splice(index, 1);
    };
  }

  /**
   * 分发消息给所有监听器
   */
  private dispatchMessage(message: PlatformMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(message);
      } catch (err) {
        this.logger.error('消息监听器执行异常', err);
      }
    }
  }

  /**
   * 发送消息到服务端
   * 
   * 注意：目前服务端只接受 auth 和 heartbeat 两种客户端消息，
   * 其他操作通过 HTTP API 完成。
   */
  send(message: any): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 缓冲消息（非心跳消息）
      if (message.type !== 'heartbeat') {
        this.messageBuffer.push(message);
        this.logger.debug('消息已缓冲（未连接）', { type: message.type });
      }
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      this.logger.error('消息发送失败', err);
      return false;
    }
  }

  /**
   * 刷新消息缓冲
   */
  private flushMessageBuffer(): void {
    if (this.messageBuffer.length === 0) return;

    this.logger.info(`刷新 ${this.messageBuffer.length} 条缓冲消息`);
    for (const msg of this.messageBuffer) {
      this.send(msg);
    }
    this.messageBuffer = [];
  }

  /**
   * 等待连接成功
   */
  private onceConnected(callback: () => void): void {
    if (this.isConnected) {
      callback();
      return;
    }
    const handler = () => {
      this.eventBus.off(WorkerClawEvent.WS_CONNECTED, handler as any);
      callback();
    };
    this.eventBus.on(WorkerClawEvent.WS_CONNECTED, handler);
  }

  /**
   * 获取连接状态
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * 关闭连接
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;

    // 停止重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.ws) {
      return new Promise<void>((resolve) => {
        this.ws!.on('close', () => {
          this.ws = null;
          this.isConnected = false;
          resolve();
        });
        this.ws!.close(1000, 'Client shutdown');
      });
    }
  }
}
