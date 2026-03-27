/**
 * 智工坊平台 WebSocket 客户端
 * 
 * 负责与智工坊平台的 WebSocket 连接，包含：
 * - 自动连接与断线重连
 * - 心跳保活
 * - 消息收发
 * - 消息解析与分发
 */

import WebSocket from 'ws';
import { createLogger, type Logger } from '../core/logger.js';
import { EventBus, WorkerClawEvent } from '../core/events.js';
import type { PlatformConfig } from '../core/config.js';
import type { PlatformMessage, ConnectAckMessage, HeartbeatMessage } from '../types/message.js';
import { WSMessageType } from '../types/message.js';

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
  private heartbeatIntervalMs = 30000; // 默认 30 秒，服务端可通过 ACK 调整
  private isConnected = false;
  private botId: string | null = null;

  // 消息缓冲（断线期间的消息）
  private messageBuffer: PlatformMessage[] = [];
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

      // 构建连接 URL（附带 botId 和 token 参数）
      const url = new URL(this.config.wsUrl);
      if (this.config.botId) url.searchParams.set('botId', this.config.botId);
      url.searchParams.set('token', this.config.token);
      const wsUrl = url.toString();

      this.logger.info(`正在连接平台 WebSocket (attempt ${this.reconnectAttempt}): ${wsUrl.replace(/token=[^&]+/, 'token=***')}`);

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.logger.info('WebSocket 连接已建立');
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

      // 等待连接确认或超时
      const timeout = setTimeout(() => {
        reject(new Error(`连接超时 (${this.config.reconnect.maxRetries}s)`));
      }, 15000);

      this.onceConnected(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * 处理原始消息
   */
  private handleRawMessage(data: WebSocket.Data): void {
    try {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      const message = JSON.parse(text) as PlatformMessage;
      this.handleMessage(message);
    } catch (err) {
      this.logger.warn('消息解析失败', { data: String(data).slice(0, 200) });
    }
  }

  /**
   * 处理平台消息
   */
  private handleMessage(message: PlatformMessage): void {
    this.logger.debug('收到消息', { type: message.type, msgId: message.msgId });

    switch (message.type) {
      case WSMessageType.CONNECT_ACK:
        this.handleConnectAck(message as unknown as ConnectAckMessage);
        break;

      case WSMessageType.PING:
        this.sendPong();
        break;

      case WSMessageType.PONG:
        // 心跳响应，不需要特殊处理
        this.logger.debug('收到 PONG');
        break;

      case WSMessageType.SYSTEM:
        this.logger.info('系统消息', message.data);
        break;

      case WSMessageType.ERROR:
        this.logger.error('平台错误消息', message.data);
        break;

      case WSMessageType.TASK_PUSH:
      case WSMessageType.TASK_CANCEL:
      case WSMessageType.TASK_UPDATE:
      case WSMessageType.MESSAGE:
      case WSMessageType.COMMENT:
      case WSMessageType.MENTION:
      case WSMessageType.FEED_UPDATE:
        // 分发给监听器
        this.dispatchMessage(message);
        break;

      default:
        this.logger.debug('未知消息类型', { type: message.type });
    }
  }

  /**
   * 处理连接确认
   */
  private handleConnectAck(message: ConnectAckMessage): void {
    if (message.data.success) {
      this.isConnected = true;
      this.reconnectAttempt = 0;

      if (message.data.botId) {
        this.botId = message.data.botId;
        this.logger.info(`已连接，分配 botId: ${this.botId}`);
      }

      if (message.data.heartbeatInterval) {
        this.heartbeatIntervalMs = message.data.heartbeatInterval * 1000;
        this.logger.info(`心跳间隔调整为 ${message.data.heartbeatInterval}s`);
      }

      this.eventBus.emit(WorkerClawEvent.WS_CONNECTED, undefined as any);
      this.startHeartbeat();

      // 发送缓冲的消息（如有）
      this.flushMessageBuffer();
    } else {
      this.logger.error('连接被拒绝', message.data.error);
      this.ws?.close();
    }
  }

  /**
   * 发送 PONG 响应
   */
  private sendPong(): void {
    const pong: HeartbeatMessage = {
      type: WSMessageType.PONG,
      msgId: this.generateMsgId(),
      timestamp: new Date().toISOString(),
      data: {},
    };
    this.send(pong);
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected) {
        const ping: HeartbeatMessage = {
          type: WSMessageType.PING,
          msgId: this.generateMsgId(),
          timestamp: new Date().toISOString(),
          data: {},
        };
        this.send(ping);
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

      this.logger.info(`将在 ${delayMs}ms 后重连 (attempt ${this.reconnectAttempt + 1}/${this.config.reconnect.maxRetries})`);
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
   * 发送消息
   */
  send(message: PlatformMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 缓冲消息（非心跳消息）
      if (message.type !== WSMessageType.PING && message.type !== WSMessageType.PONG) {
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
   * 生成消息 ID
   */
  private generateMsgId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 获取连接状态
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * 获取 Bot ID
   */
  get getBotId(): string | null {
    return this.botId;
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
