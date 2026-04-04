/**
 * WhatsApp Baileys 客户端封装
 *
 * 基于 @whiskeysockets/baileys 库，通过 WhatsApp Web WebSocket 协议通信。
 * 负责：连接管理、QR 码配对、会话持久化、消息收发。
 *
 * 核心特性：
 * - 多设备链接（Multi-device）方式配对
 * - 会话持久化（重启后自动恢复，无需重新扫码）
 * - 实时消息事件监听
 * - 速率限制保护
 */

import { createLogger, type Logger } from '../../core/logger.js';
import {
  default as makeWASocket,
  type WASocket,
  type WAMessage,
  type Contact,
  type GroupMetadata,
  type ConnectionState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { WhatsAppConfig } from '../../core/config.js';

/** 媒体附件信息 */
export interface WhatsAppMedia {
  /** 媒体类型 */
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  /** MIME 类型 */
  mimeType: string;
  /** 文件名（仅 document 类型） */
  fileName?: string;
  /** 文件大小（字节） */
  fileSize?: number;
  /** 图片/视频宽 */
  width?: number;
  /** 图片/视频高 */
  height?: number;
  /** 视频时长（秒） */
  seconds?: number;
  /** 媒体描述/说明文字 */
  caption?: string;
}

/** 消息回调类型 */
export interface WhatsAppMessage {
  /** 消息 ID */
  id: string;
  /** 发送方号码 */
  from: string;
  /** 发送方显示名（如果已知） */
  pushName?: string;
  /** 聊天 ID（私聊或群组） */
  chatId: string;
  /** 是否群组消息 */
  isGroup: boolean;
  /** 是否来自自己 */
  fromMe: boolean;
  /** 消息文本内容 */
  text: string;
  /** 媒体附件（如果消息包含图片/视频/文件等） */
  media?: WhatsAppMedia;
  /** 原始消息对象 */
  raw: WAMessage;
  /** 消息时间戳 */
  timestamp: number;
}

/** BaileysClient 事件 */
export interface WhatsAppClientEvents {
  /** 收到新消息 */
  'message:new': (msg: WhatsAppMessage) => void;
  /** 连接状态变化 */
  'connection:update': (state: {
    connected: boolean;
    qr?: string;
    reason?: string;
  }) => void;
  /** 消息已发送 */
  'message:sent': (chatId: string, messageId: string) => void;
  /** 发送失败 */
  'message:send_failed': (chatId: string, error: string) => void;
}

export class BaileysClient {
  private logger: Logger;
  private socket: WASocket | null = null;
  private authState: Awaited<ReturnType<typeof useMultiFileAuthState>> | null = null;
  private config: WhatsAppConfig;
  private sessionPath: string;
  private listeners = new Map<string, Set<Function>>();
  private isConnected = false;
  private isConnecting = false;
  private messageCounter = 0;
  private counterResetAt = 0;
  private maxMessagesPerMinute: number;

  /** 联系人缓存 */
  private contacts = new Map<string, Contact>();
  /** 群组缓存 */
  private groups = new Map<string, GroupMetadata>();

  constructor(config: WhatsAppConfig) {
    this.config = config;
    this.sessionPath = config.sessionPath || './data/whatsapp-session';
    this.maxMessagesPerMinute = config.autoReply?.maxMessagesPerMinute || 30;
    this.logger = createLogger('BaileysClient');
  }

  /**
   * 连接 WhatsApp
   * 首次连接需要扫码配对，后续自动恢复会话
   */
  async connect(): Promise<void> {
    if (this.isConnecting) {
      this.logger.warn('已有连接进行中，跳过');
      return;
    }
    if (this.isConnected && this.socket) {
      this.logger.warn('已连接，跳过');
      return;
    }

    this.isConnecting = true;

    try {
      // 确保会话目录存在
      if (!existsSync(this.sessionPath)) {
        mkdirSync(this.sessionPath, { recursive: true });
      }

      // 加载或创建认证状态
      this.authState = await useMultiFileAuthState(this.sessionPath);

      // 获取 Baileys 版本信息
      const { version } = await fetchLatestBaileysVersion();
      this.logger.info(`Baileys 版本: ${version.join('.')}`);

      // 创建 WebSocket 连接
      this.socket = makeWASocket({
        version,
        auth: {
          creds: this.authState.state.creds,
          keys: makeCacheableSignalKeyStore(this.authState.state.keys),
        },
        printQRInTerminal: true,
        logger: {
          level: 'silent',
          // 静默 Baileys 内部日志，只输出关键信息
          info: (...args: any[]) => this.logger.debug('[baileys]', ...args.map(String)),
          debug: () => {},
          warn: (...args: any[]) => this.logger.debug('[baileys:warn]', ...args.map(String)),
          error: (...args: any[]) => this.logger.error('[baileys:error]', ...args.map(String)),
          trace: () => {},
        } as any,
        browser: ['WorkerClaw', 'Chrome', '120.0.0'],
      });

      // 保存认证状态更新
      this.authState.saveCreds = async () => {
        if (this.authState) {
          // 同步保存凭证
          try {
            const credsPath = join(this.sessionPath, 'creds.json');
            writeFileSync(credsPath, JSON.stringify(this.authState.state.creds, null, 2));
          } catch (err) {
            this.logger.error('保存凭证失败', (err as Error).message);
          }
        }
      };

      // 监听连接事件
      this.socket.ev.on('connection.update', (update: Partial<ConnectionState>) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.logger.info('需要扫码配对 — 请打开 WhatsApp > 关联设备 > 关联设备');
          this.emit('connection:update', {
            connected: false,
            qr,
            reason: '需要扫码配对',
          });
        }

        if (connection === 'open') {
          this.isConnected = true;
          this.isConnecting = false;
          this.logger.info('✅ WhatsApp 已连接');
          this.emit('connection:update', { connected: true });

          // 获取联系人列表
          this.fetchContacts().catch(err => {
            this.logger.debug('获取联系人失败（非关键）', (err as Error).message);
          });

          // 获取群组列表
          this.fetchGroups().catch(err => {
            this.logger.debug('获取群组列表失败（非关键）', (err as Error).message);
          });
        }

        if (connection === 'close') {
          this.isConnected = false;
          this.isConnecting = false;
          const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const reasonMsg = this.getDisconnectReason(reason);

          this.logger.warn(`WhatsApp 连接断开: ${reasonMsg}`);

          this.emit('connection:update', {
            connected: false,
            reason: reasonMsg,
          });

          // 根据断开原因决定是否自动重连
          if (reason === DisconnectReason.loggedOut) {
            this.logger.error('已登出，需要重新扫码配对');
            // 清理旧的认证状态
            this.cleanupAuthState();
          } else if (this.shouldReconnect(reason)) {
            this.logger.info('将在 5 秒后自动重连...');
            setTimeout(() => this.connect(), 5000);
          }
        }
      });

      // 监听消息事件
      this.socket.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          this.handleMessage(msg);
        }
      });

      // 监听认证凭证更新
      this.socket.ev.on('creds.update', () => {
        if (this.authState?.saveCreds) {
          this.authState.saveCreds().catch(err => {
            this.logger.debug('保存凭证回调失败', (err as Error).message);
          });
        }
      });

      // 监听群组更新
      this.socket.ev.on('groups.update', (updates: Partial<GroupMetadata>[]) => {
        for (const update of updates) {
          const id = update.id!;
          const existing = this.groups.get(id);
          if (existing) {
            this.groups.set(id, { ...existing, ...update } as GroupMetadata);
          }
        }
      });

    } catch (err) {
      this.isConnecting = false;
      this.logger.error('连接 WhatsApp 失败', (err as Error).message);
      throw err;
    }
  }

  /**
   * 发送文本消息
   */
  async sendMessage(chatId: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    this.checkConnection();
    this.checkRateLimit();

    try {
      const result = await this.socket!.sendMessage(chatId, { text });
      const msgId = result?.key?.id || '';

      this.logger.info(`消息已发送 → ${chatId}`, { messageId: msgId });
      this.emit('message:sent', chatId, msgId);

      return { success: true, messageId: msgId || undefined };
    } catch (err) {
      const errorMsg = (err as Error).message;
      this.logger.error(`发送消息失败 → ${chatId}`, errorMsg);
      this.emit('message:send_failed', chatId, errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * 发送图片消息
   */
  async sendImage(chatId: string, imagePath: string, caption?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    this.checkConnection();

    try {
      const { readFileSync } = await import('node:fs');
      const imageBuffer = readFileSync(imagePath);

      const result = await this.socket!.sendMessage(chatId, {
        image: imageBuffer,
        caption: caption || undefined,
      });
      const msgId = result?.key?.id || '';

      this.logger.info(`图片已发送 → ${chatId}`, { messageId: msgId });
      this.emit('message:sent', chatId, msgId);

      return { success: true, messageId: msgId || undefined };
    } catch (err) {
      const errorMsg = (err as Error).message;
      this.logger.error(`发送图片失败 → ${chatId}`, errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * 发送文件消息（PDF、视频等）
   */
  async sendDocument(chatId: string, filePath: string, fileName?: string, caption?: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    this.checkConnection();
    this.checkRateLimit();

    try {
      const { readFileSync } = await import('node:fs');
      const buffer = readFileSync(filePath);
      const ext = (fileName || filePath).split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        mp4: 'video/mp4',
        mp3: 'audio/mpeg',
        zip: 'application/zip',
      };

      const result = await this.socket!.sendMessage(chatId, {
        document: buffer,
        fileName: fileName || filePath.split('/').pop() || 'file',
        caption: caption || undefined,
        mimetype: mimeMap[ext] || 'application/octet-stream',
      });
      const msgId = result?.key?.id || '';

      this.logger.info(`文件已发送 → ${chatId}`, { messageId: msgId, fileName });
      this.emit('message:sent', chatId, msgId);

      return { success: true, messageId: msgId || undefined };
    } catch (err) {
      const errorMsg = (err as Error).message;
      this.logger.error(`发送文件失败 → ${chatId}`, errorMsg);
      this.emit('message:send_failed', chatId, errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * 下载消息中的媒体内容（返回 Buffer）
   * 需要传入原始 WAMessage 对象
   */
  async downloadMediaBuffer(msg: WAMessage): Promise<Buffer | null> {
    if (!msg.message || !this.socket) return null;

    const m = msg.message as any;
    const mediaType = m.imageMessage || m.videoMessage || m.audioMessage
      || m.documentMessage || m.stickerMessage;

    if (!mediaType) return null;

    try {
      const stream = await (this.socket as any).downloadMediaMessage(msg, 'buffer', {});
      if (!stream) return null;

      // stream 可能是 Buffer 或 ReadableStream
      if (Buffer.isBuffer(stream)) return stream;
      // 如果是流，收集数据
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      this.logger.error('下载媒体失败', (err as Error).message);
      return null;
    }
  }

  /**
   * 获取最近的聊天列表
   */
  async getChats(limit = 20): Promise<Array<{ id: string; name: string; lastMessageTime: number; unreadCount: number }>> {
    this.checkConnection();

    try {
      // Baileys fetchChats 类型不完整，使用 any
      const chats: any[] = await (this.socket as any).fetchChats(limit) || [];
      return chats.map((chat: any) => {
        const contact = this.contacts.get(chat.id);
        const group = this.groups.get(chat.id);
        const name = group?.subject || contact?.notify || contact?.name || chat.id;

        return {
          id: chat.id,
          name,
          lastMessageTime: chat.t || 0,
          unreadCount: chat.unreadCount || 0,
        };
      });
    } catch (err) {
      this.logger.error('获取聊天列表失败', (err as Error).message);
      return [];
    }
  }

  /**
   * 获取指定聊天的历史消息
   */
  async getMessages(chatId: string, limit = 20): Promise<WhatsAppMessage[]> {
    this.checkConnection();

    try {
      // 标记已读
      await (this.socket as any).chatRead?.(chatId)?.catch?.(() => {});

      // 使用 store 加载消息
      const store = (this.socket as any).store;
      if (!store?.loadMessages) {
        this.logger.warn('消息 store 不可用，无法获取历史消息');
        return [];
      }

      const messages: WAMessage[] = await store.loadMessages(chatId, limit, undefined);
      return messages
        .filter((m: WAMessage) => !m.key.fromMe)
        .map((m: WAMessage) => this.formatMessage(m));
    } catch (err) {
      this.logger.error('获取历史消息失败', (err as Error).message);
      return [];
    }
  }

  /**
   * 获取联系人名称
   */
  getContactName(jid: string): string {
    const contact = this.contacts.get(jid);
    if (contact?.notify || contact?.name) {
      return contact.notify || contact.name!;
    }
    // 群组
    const group = this.groups.get(jid);
    if (group?.subject) {
      return group.subject;
    }
    // 从 JID 提取号码
    return jid.split('@')[0];
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.socket) {
      try {
        this.socket.ev.removeAllListeners('connection.update');
        this.socket.ev.removeAllListeners('messages.upsert');
        this.socket.ev.removeAllListeners('creds.update');
        this.socket.ev.removeAllListeners('groups.update');
        await this.socket.end(new Error('用户断开连接'));
        this.socket = null;
      } catch (err) {
        this.logger.debug('断开连接异常', (err as Error).message);
      }
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.logger.info('WhatsApp 已断开');
  }

  /**
   * 获取连接状态
   */
  getStatus(): { connected: boolean; connecting: boolean; contactsCount: number; groupsCount: number } {
    return {
      connected: this.isConnected,
      connecting: this.isConnecting,
      contactsCount: this.contacts.size,
      groupsCount: this.groups.size,
    };
  }

  // ==================== 事件系统 ====================

  on<K extends keyof WhatsAppClientEvents>(event: K, listener: WhatsAppClientEvents[K]): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as Function);
  }

  off<K extends keyof WhatsAppClientEvents>(event: K, listener: WhatsAppClientEvents[K]): void {
    this.listeners.get(event)?.delete(listener as Function);
  }

  private emit<K extends keyof WhatsAppClientEvents>(event: K, ...args: any[]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (err) {
          this.logger.error(`事件处理器异常 [${event}]`, (err as Error).message);
        }
      }
    }
  }

  // ==================== 内部方法 ====================

  private checkConnection(): void {
    if (!this.socket || !this.isConnected) {
      throw new Error('WhatsApp 未连接');
    }
  }

  private checkRateLimit(): void {
    const now = Date.now();
    // 每分钟重置计数器
    if (now - this.counterResetAt > 60000) {
      this.messageCounter = 0;
      this.counterResetAt = now;
    }
    this.messageCounter++;
    if (this.messageCounter > this.maxMessagesPerMinute) {
      throw new Error(`消息速率超限: ${this.messageCounter}/${this.maxMessagesPerMinute} (每分钟)`);
    }
  }

  private handleMessage(msg: WAMessage): void {
    // 跳过自己发的消息
    if (msg.key.fromMe) return;
    // 跳过状态广播
    if (msg.key.remoteJid === 'status@broadcast') return;

    const chatId = msg.key.remoteJid!;
    const isGroup = chatId?.endsWith('@g.us') || false;
    const from = msg.key.participant || msg.key.remoteJid || '';

    // 提取文本内容
    const text = this.extractText(msg);
    if (!text && !msg.message?.imageMessage && !msg.message?.documentMessage) {
      return; // 没有文本也没有附件，跳过
    }

    const formatted = this.formatMessage(msg);
    const mediaDesc = formatted.media ? ` [${formatted.media.type}: ${formatted.media.mimeType}]` : '';
    this.logger.info(`📩 新消息 ← ${formatted.from} (${isGroup ? '群组' : '私聊'}): "${text?.slice(0, 50) || '(媒体)'}..."${mediaDesc}`);

    this.emit('message:new', formatted);
  }

  private formatMessage(msg: WAMessage): WhatsAppMessage {
    const chatId = msg.key.remoteJid || '';
    const from = msg.key.participant || chatId;
    const isGroup = chatId.endsWith('@g.us');

    return {
      id: msg.key.id || '',
      from,
      pushName: msg.pushName || undefined,
      chatId,
      isGroup,
      fromMe: !!msg.key.fromMe,
      text: this.extractText(msg) || '',
      media: this.extractMedia(msg) || undefined,
      raw: msg,
      timestamp: (msg.messageTimestamp as number) * 1000 || Date.now(),
    };
  }

  /**
   * 提取媒体附件信息（不下载实际内容）
   */
  private extractMedia(msg: WAMessage): WhatsAppMedia | null {
    if (!msg.message) return null;
    const m = msg.message as any;

    const mediaMap: Array<{ msgType: string; mediaType: WhatsAppMedia['type'] }> = [
      { msgType: 'imageMessage', mediaType: 'image' },
      { msgType: 'videoMessage', mediaType: 'video' },
      { msgType: 'audioMessage', mediaType: 'audio' },
      { msgType: 'documentMessage', mediaType: 'document' },
      { msgType: 'stickerMessage', mediaType: 'sticker' },
    ];

    for (const { msgType, mediaType } of mediaMap) {
      const media = m[msgType];
      if (media) {
        return {
          type: mediaType,
          mimeType: media.mimetype || '',
          fileName: media.fileName || undefined,
          fileSize: media.fileLength || undefined,
          width: media.width || undefined,
          height: media.height || undefined,
          seconds: media.seconds || undefined,
          caption: media.caption || undefined,
        };
      }
    }

    return null;
  }

  private extractText(msg: WAMessage): string {
    if (!msg.message) return '';
    const m = msg.message as any;
    return m.conversation
      || m.extendedTextMessage?.text
      || m.imageMessage?.caption
      || m.videoMessage?.caption
      || m.documentMessage?.caption
      || (m.audioMessage?.caption || '')
      || '';
  }

  private getDisconnectReason(statusCode?: number): string {
    if (!statusCode) return '未知原因';
    switch (statusCode) {
      case DisconnectReason.loggedOut:
        return '已登出';
      case DisconnectReason.badSession:
        return '会话损坏';
      case DisconnectReason.connectionClosed:
        return '连接关闭';
      case DisconnectReason.connectionLost:
        return '连接丢失';
      case DisconnectReason.connectionReplaced:
        return '连接被替换（在另一设备上登录）';
      case DisconnectReason.restartRequired:
        return '需要重启';
      case DisconnectReason.timedOut:
        return '连接超时';
      default:
        return `未知 (${statusCode})`;
    }
  }

  private shouldReconnect(reason?: number): boolean {
    if (!reason) return true;
    // 不自动重连的情况
    return reason !== DisconnectReason.loggedOut
      && reason !== DisconnectReason.connectionReplaced;
  }

  private async fetchContacts(): Promise<void> {
    if (!this.socket) return;
    try {
      const contacts: any = (this.socket as any).store?.contacts;
      if (contacts) {
        for (const [jid, contact] of Object.entries(contacts)) {
          this.contacts.set(jid, contact as Contact);
        }
        this.logger.info(`已加载 ${this.contacts.size} 个联系人`);
      }
    } catch (err) {
      this.logger.debug('获取联系人失败', (err as Error).message);
    }
  }

  private async fetchGroups(): Promise<void> {
    if (!this.socket) return;
    try {
      const groups: any = await (this.socket as any).groupFetchAllParticipating?.() || [];
      for (const group of groups) {
        this.groups.set(group.id, group);
      }
      this.logger.info(`已加载 ${this.groups.size} 个群组`);
    } catch (err) {
      this.logger.debug('获取群组失败', (err as Error).message);
    }
  }

  private cleanupAuthState(): void {
    try {
      rmSync(this.sessionPath, { recursive: true, force: true });
      this.logger.info('已清理旧的认证状态');
    } catch {
      this.logger.warn('清理认证状态失败');
    }
  }
}
