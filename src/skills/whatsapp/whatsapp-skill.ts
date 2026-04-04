/**
 * WhatsApp 技能 (WhatsApp Skill)
 *
 * 基于 Baileys 的 WhatsApp 消息处理技能，为 Agent 提供 WhatsApp 收发消息能力。
 *
 * 提供的工具：
 *   1. whatsapp_send_message - 发送文本消息
 *   2. whatsapp_get_chats - 获取最近聊天列表
 *   3. whatsapp_get_messages - 获取聊天历史消息
 *
 * 自动回复模式：
 *   当 autoReply.enabled=true 时，新消息会自动转发给 LLM 生成回复。
 *   使用独立的 LLM 调用（不经过 AgentEngine 的工具循环），确保实时响应。
 */

import { createLogger, type Logger } from '../../core/logger.js';
import { BaileysClient, type WhatsAppMessage, type WhatsAppMedia } from './baileys-client.js';
import type { Skill, SkillContext, SkillResult } from '../types.js';
import type { ToolDefinition, ToolExecutorFn, PermissionLevel } from '../../types/agent.js';
import type { WhatsAppConfig } from '../../core/config.js';

// ==================== 工具定义 ====================

const WHATSAPP_TOOLS: ToolDefinition[] = [
  {
    name: 'whatsapp_send_message',
    description: '通过 WhatsApp 发送文本消息给指定联系人或群组。号码需含国家代码（如 8613800138000），群组 ID 格式为 xxxxx@g.us。',
    requiredLevel: 'limited' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: '接收方号码（含国际区号，如 8613800138000）或群组 ID（如 120363xxx@g.us）',
        },
        message: {
          type: 'string',
          description: '要发送的消息内容',
        },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'whatsapp_get_chats',
    description: '获取最近的 WhatsApp 聊天列表，包含联系人名称和最后消息时间。',
    requiredLevel: 'limited' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '最多返回多少个聊天（默认 20）',
        },
      },
    },
  },
  {
    name: 'whatsapp_get_messages',
    description: '获取指定 WhatsApp 聊天的历史消息记录。',
    requiredLevel: 'limited' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        chatId: {
          type: 'string',
          description: '聊天 ID（联系人号码或群组 ID）',
        },
        limit: {
          type: 'number',
          description: '最多返回多少条消息（默认 20）',
        },
      },
      required: ['chatId'],
    },
  },
  {
    name: 'whatsapp_send_image',
    description: '通过 WhatsApp 发送图片消息给指定联系人或群组。支持 JPG、PNG 等常见图片格式。',
    requiredLevel: 'limited' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: '接收方号码（含国际区号，如 8613800138000）或群组 ID（如 120363xxx@g.us）',
        },
        imagePath: {
          type: 'string',
          description: '图片文件路径（本地路径或 URL）',
        },
        caption: {
          type: 'string',
          description: '图片说明文字（可选）',
        },
      },
      required: ['to', 'imagePath'],
    },
  },
  {
    name: 'whatsapp_send_document',
    description: '通过 WhatsApp 发送文件（PDF、视频、文档等）给指定联系人或群组。',
    requiredLevel: 'limited' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: '接收方号码（含国际区号，如 8613800138000）或群组 ID（如 120363xxx@g.us）',
        },
        filePath: {
          type: 'string',
          description: '文件路径（本地路径）',
        },
        fileName: {
          type: 'string',
          description: '文件名（可选，默认取文件路径的文件名）',
        },
        caption: {
          type: 'string',
          description: '文件说明文字（可选）',
        },
      },
      required: ['to', 'filePath'],
    },
  },
];

// ==================== 默认自动回复系统提示 ====================

const DEFAULT_AUTO_REPLY_PROMPT = `你是一个专业的外贸客服助手，通过 WhatsApp 回答客户关于产品的问题。

回复规则：
1. 用友好的语气回复，可以适当使用 emoji
2. 回复要简洁明了，适合手机阅读
3. 如果不确定产品信息，诚实地告诉客户你会确认后回复
4. 不要编造产品参数或价格
5. 每条回复控制在 200 字以内
6. 如果客户发送了图片，仔细看图理解内容再回复（可能是产品照片、问题截图等）
7. 如果客户发送了视频/文件，回复说已收到并会尽快处理
8. 使用客户使用的语言回复（英语/中文/其他）`;

// ==================== WhatsApp 技能 ====================

export class WhatsAppSkill implements Skill {
  private logger: Logger;
  private client: BaileysClient;
  private config: WhatsAppConfig;

  /** LLM 调用函数（由外部注入，用于自动回复） */
  private llmChat: ((systemPrompt: string, userMessage: string | Array<{type: string; text?: string; image_url?: {url: string; detail?: string}}>) => Promise<string | null>) | null = null;

  /** 每个聊天的上下文消息缓存（用于自动回复的多轮对话） */
  private chatContexts = new Map<string, Array<{ role: string; content: string }>>();

  /** 聊天最后活跃时间（用于 idleTimeout 检测） */
  private chatLastActive = new Map<string, number>();

  /** 自动回复是否运行中 */
  private autoReplyRunning = false;

  readonly metadata = {
    name: 'whatsapp',
    displayName: '📱 WhatsApp 客服',
    description: '通过 Baileys 接入 WhatsApp Web，支持收发消息和 AI 自动回复',
    version: '1.0.0',
    author: 'WorkerClaw',
    tags: ['whatsapp', 'messaging', 'chat', 'customer-service'],
    requiredLevel: 'limited' as PermissionLevel,
    applicableTaskTypes: [],  // 适用所有任务类型
    requiredTools: [],
  };

  constructor(config: WhatsAppConfig) {
    this.config = config;
    this.client = new BaileysClient(config);
    this.logger = createLogger('WhatsAppSkill');
  }

  readonly tools = WHATSAPP_TOOLS;

  readonly toolExecutors: Record<string, ToolExecutorFn> = {
    whatsapp_send_message: async (params: any, context: any): Promise<any> => {
      return this.executeSendMessage(params, context);
    },
    whatsapp_get_chats: async (params: any, context: any): Promise<any> => {
      return this.executeGetChats(params, context);
    },
    whatsapp_get_messages: async (params: any, context: any): Promise<any> => {
      return this.executeGetMessages(params, context);
    },
    whatsapp_send_image: async (params: any, context: any): Promise<any> => {
      return this.executeSendImage(params, context);
    },
    whatsapp_send_document: async (params: any, context: any): Promise<any> => {
      return this.executeSendDocument(params, context);
    },
  };

  async execute(context: SkillContext): Promise<SkillResult> {
    const status = this.client.getStatus();
    return {
      success: true,
      content: `WhatsApp 技能已就绪 (状态: ${status.connected ? '已连接' : status.connecting ? '连接中' : '未连接'})。\n` +
        (status.connected
          ? `联系人: ${status.contactsCount} 个, 群组: ${status.groupsCount} 个。\n` +
            `请使用 whatsapp_send_message / whatsapp_get_chats / whatsapp_get_messages 工具。`
          : `等待 WhatsApp 连接...`),
      outputs: [],
      durationMs: 0,
    };
  }

  getSystemPromptAddon(): string {
    const status = this.client.getStatus();
    if (!status.connected) {
      return [
        '## 📱 WhatsApp 工具',
        'WhatsApp 技能已加载但尚未连接。连接后即可使用以下工具：',
        '- `whatsapp_send_message(to, message)` - 发送消息',
        '- `whatsapp_get_chats(limit?)` - 获取聊天列表',
        '- `whatsapp_get_messages(chatId, limit?)` - 获取历史消息',
      ].join('\n');
    }

    return [
      '## 📱 WhatsApp 工具',
      'WhatsApp 已连接，你可以使用以下工具与客户沟通：',
      '',
      '**消息操作：**',
      '- `whatsapp_send_message(to, message)` - 发送文本消息给联系人或群组',
      '- `whatsapp_send_image(to, imagePath, caption?)` - 发送图片（支持本地路径和 URL）',
      '- `whatsapp_send_document(to, filePath, fileName?, caption?)` - 发送文件（PDF、视频等）',
      '- `whatsapp_get_chats(limit?)` - 获取最近聊天列表',
      '- `whatsapp_get_messages(chatId, limit?)` - 获取指定聊天的历史消息',
      '',
      '**使用提示：**',
      '- 号码需含国家代码（如 8613800138000，不含 + 号）',
      '- 群组 ID 格式为 xxxxx@g.us',
      '- 发送图片时，imagePath 可以是本地路径或网络 URL',
      '- 自动回复已' + (this.config.autoReply?.enabled ? '开启（支持图片/视频理解）' : '关闭'),
    ].join('\n');
  }

  /**
   * 初始化：连接 WhatsApp + 启动自动回复监听
   */
  async init(): Promise<void> {
    this.logger.info('WhatsApp 技能初始化 (v1.0.0)');

    if (!this.config.enabled) {
      this.logger.info('WhatsApp 技能已禁用 (config.whatsapp.enabled = false)');
      return;
    }

    // 注册消息监听
    this.client.on('message:new', (msg: WhatsAppMessage) => {
      this.handleIncomingMessage(msg).catch(err => {
        this.logger.error('处理消息异常', (err as Error).message);
      });
    });

    // 开始连接（异步，不阻塞启动）
    this.client.connect().catch(err => {
      this.logger.error('WhatsApp 连接失败', (err as Error).message);
    });
  }

  /**
   * 设置 LLM 调用函数（用于自动回复）
   */
  setLLMChat(fn: (systemPrompt: string, userMessage: string | Array<{type: string; text?: string; image_url?: {url: string; detail?: string}}>) => Promise<string | null>): void {
    this.llmChat = fn;
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    this.autoReplyRunning = false;
    await this.client.disconnect();
    this.chatContexts.clear();
    this.chatLastActive.clear();
    this.logger.info('WhatsApp 技能清理');
  }

  /**
   * 获取 BaileysClient 实例（供外部访问）
   */
  getClient(): BaileysClient {
    return this.client;
  }

  // ==================== 工具执行器 ====================

  private async executeSendMessage(params: any, context: any): Promise<any> {
    const { to, message } = params;
    const toolCallId = context.toolCallId || 'unknown';

    if (!to || !message) {
      return { toolCallId, success: false, content: '缺少必要参数: to, message', error: 'missing_params' };
    }

    this.logger.info(`whatsapp_send_message → ${to}: "${message.slice(0, 50)}..."`);

    try {
      // 格式化接收方 ID
      const chatId = this.normalizeChatId(to);
      const result = await this.client.sendMessage(chatId, message);

      if (result.success) {
        return { toolCallId, success: true, content: `消息已发送给 ${to}` + (result.messageId ? ` (ID: ${result.messageId})` : '') };
      } else {
        return { toolCallId, success: false, content: `发送失败: ${result.error}`, error: result.error };
      }
    } catch (err) {
      return { toolCallId, success: false, content: `发送消息失败: ${(err as Error).message}`, error: (err as Error).message };
    }
  }

  private async executeGetChats(params: any, context: any): Promise<any> {
    const { limit = 20 } = params;
    const toolCallId = context.toolCallId || 'unknown';

    this.logger.info(`whatsapp_get_chats (limit: ${limit})`);

    try {
      const chats = await this.client.getChats(limit);
      if (chats.length === 0) {
        return { toolCallId, success: true, content: '没有聊天记录' };
      }

      const formatted = chats.map((chat, i) => {
        const time = chat.lastMessageTime > 0
          ? new Date(chat.lastMessageTime * 1000).toLocaleString()
          : '未知';
        return `${i + 1}. ${chat.name || chat.id}\n   ID: ${chat.id}\n   最后消息: ${time}\n   未读: ${chat.unreadCount}`;
      }).join('\n');

      return {
        toolCallId,
        success: true,
        content: `最近聊天 (共 ${chats.length} 个):\n\n${formatted}`,
      };
    } catch (err) {
      return { toolCallId, success: false, content: `获取聊天列表失败: ${(err as Error).message}`, error: (err as Error).message };
    }
  }

  private async executeGetMessages(params: any, context: any): Promise<any> {
    const { chatId, limit = 20 } = params;
    const toolCallId = context.toolCallId || 'unknown';

    if (!chatId) {
      return { toolCallId, success: false, content: '缺少必要参数: chatId', error: 'missing_params' };
    }

    this.logger.info(`whatsapp_get_messages → ${chatId} (limit: ${limit})`);

    try {
      const normalizedId = this.normalizeChatId(chatId);
      const messages = await this.client.getMessages(normalizedId, limit);
      if (messages.length === 0) {
        return { toolCallId, success: true, content: '没有历史消息' };
      }

      const formatted = messages.map((msg, i) => {
        const time = new Date(msg.timestamp).toLocaleString();
        const sender = msg.fromMe ? '我' : this.client.getContactName(msg.from);
        return `[${time}] ${sender}: ${msg.text}`;
      }).join('\n');

      return {
        toolCallId,
        success: true,
        content: `${this.client.getContactName(normalizedId)} 的历史消息 (最近 ${messages.length} 条):\n\n${formatted}`,
      };
    } catch (err) {
      return { toolCallId, success: false, content: `获取消息失败: ${(err as Error).message}`, error: (err as Error).message };
    }
  }

  private async executeSendImage(params: any, context: any): Promise<any> {
    const { to, imagePath, caption } = params;
    const toolCallId = context.toolCallId || 'unknown';

    if (!to || !imagePath) {
      return { toolCallId, success: false, content: '缺少必要参数: to, imagePath', error: 'missing_params' };
    }

    this.logger.info(`whatsapp_send_image → ${to}: "${imagePath}"`);

    try {
      // 如果是 URL，先下载到临时文件
      let localPath = imagePath;
      if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        localPath = await this.downloadToFile(imagePath);
        if (!localPath) {
          return { toolCallId, success: false, content: `下载图片失败: ${imagePath}`, error: 'download_failed' };
        }
      }

      const chatId = this.normalizeChatId(to);
      const result = await this.client.sendImage(chatId, localPath, caption);

      // 清理临时文件
      if (localPath !== imagePath) {
        try { (await import('node:fs')).unlinkSync(localPath); } catch {}
      }

      if (result.success) {
        return { toolCallId, success: true, content: `图片已发送给 ${to}` + (result.messageId ? ` (ID: ${result.messageId})` : '') };
      } else {
        return { toolCallId, success: false, content: `发送图片失败: ${result.error}`, error: result.error };
      }
    } catch (err) {
      return { toolCallId, success: false, content: `发送图片失败: ${(err as Error).message}`, error: (err as Error).message };
    }
  }

  private async executeSendDocument(params: any, context: any): Promise<any> {
    const { to, filePath, fileName, caption } = params;
    const toolCallId = context.toolCallId || 'unknown';

    if (!to || !filePath) {
      return { toolCallId, success: false, content: '缺少必要参数: to, filePath', error: 'missing_params' };
    }

    this.logger.info(`whatsapp_send_document → ${to}: "${filePath}"`);

    try {
      const chatId = this.normalizeChatId(to);
      const result = await this.client.sendDocument(chatId, filePath, fileName, caption);

      if (result.success) {
        return { toolCallId, success: true, content: `文件已发送给 ${to}` + (result.messageId ? ` (ID: ${result.messageId})` : '') };
      } else {
        return { toolCallId, success: false, content: `发送文件失败: ${result.error}`, error: result.error };
      }
    } catch (err) {
      return { toolCallId, success: false, content: `发送文件失败: ${(err as Error).message}`, error: (err as Error).message };
    }
  }

  // ==================== 自动回复逻辑 ====================

  private async handleIncomingMessage(msg: WhatsAppMessage): Promise<void> {
    // 检查自动回复是否启用
    if (!this.config.autoReply?.enabled) return;

    // 黑名单检查
    const blacklist = this.config.autoReply.blacklist || ['status@broadcast'];
    if (blacklist.some(id => msg.chatId.includes(id) || msg.from.includes(id))) {
      return;
    }

    // 空闲超时检查
    const idleTimeout = this.config.autoReply.idleTimeoutMs;
    if (idleTimeout) {
      const lastActive = this.chatLastActive.get(msg.chatId) || 0;
      if (Date.now() - lastActive > idleTimeout) {
        this.logger.debug(`空闲超时，跳过自动回复: ${msg.chatId}`);
        return;
      }
    }

    // 无文本且无媒体，跳过
    if (!msg.text && !msg.media) return;

    // 检查是否有 LLM 调用函数
    if (!this.llmChat) {
      this.logger.debug('未设置 LLM 调用函数，跳过自动回复');
      return;
    }

    // 更新聊天活跃时间
    this.chatLastActive.set(msg.chatId, Date.now());

    // 构建上下文
    const maxContext = this.config.autoReply.maxContextMessages || 20;
    const context = this.getChatContext(msg.chatId, maxContext);

    // 添加当前消息到上下文
    const senderName = msg.pushName || this.client.getContactName(msg.from);

    // 处理媒体消息：下载图片/视频并发给 LLM 理解
    let userMessageContent: string | Array<{type: string; text?: string; image_url?: {url: string; detail?: string}}>;

    if (msg.media && (msg.media.type === 'image' || msg.media.type === 'video')) {
      this.logger.info(`📥 下载媒体 → ${msg.media.type}: ${msg.media.mimeType} (${msg.media.fileSize || '?'} bytes)`);
      const mediaBuffer = await this.client.downloadMediaBuffer(msg.raw);

      if (mediaBuffer) {
        const base64 = mediaBuffer.toString('base64');
        const mimePrefix = `data:${msg.media.mimeType};base64,`;

        // 构建多模态消息
        const parts: Array<{type: string; text?: string; image_url?: {url: string; detail?: string}}> = [];

        // 如果有文本 caption 或 context，先加文本
        const textParts: string[] = [];
        if (msg.text) textParts.push(msg.text);
        textParts.push(`[${senderName}] 发送了一张${msg.media.type === 'image' ? '图片' : '视频'}`);
        parts.push({ type: 'text', text: textParts.join('\n') });

        // 添加图片（视频暂不支持 vision，只发送第一帧截图或跳过）
        if (msg.media.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: { url: `${mimePrefix}${base64}`, detail: 'auto' },
          });
        }

        userMessageContent = parts;

        // 上下文记录（只用文本描述）
        const mediaDesc = `[${senderName}]: ${msg.text || '(发送了图片)'}`;
        context.push({ role: 'user', content: mediaDesc });
      } else {
        // 下载失败，当纯文本处理
        userMessageContent = `[${senderName}]: ${msg.text || '(发送了媒体文件，但下载失败)'}`;
        context.push({ role: 'user', content: userMessageContent });
      }
    } else if (msg.media && (msg.media.type === 'document' || msg.media.type === 'audio' || msg.media.type === 'sticker')) {
      // 文档/音频/贴纸：下载文件但不发给 LLM vision，只描述
      const desc = msg.media.fileName
        ? `[${senderName}]: ${msg.text || ''}\n(发送了文件: ${msg.media.fileName}, ${msg.media.mimeType})`
        : `[${senderName}]: ${msg.text || '(发送了文件)'}\n(文件类型: ${msg.media.mimeType})`;
      userMessageContent = desc;
      context.push({ role: 'user', content: desc });
    } else {
      // 纯文本消息
      userMessageContent = `[${senderName}]: ${msg.text}`;
      context.push({ role: 'user', content: userMessageContent });
    }

    // 调用 LLM 生成回复
    try {
      const systemPrompt = this.config.autoReply.systemPrompt || DEFAULT_AUTO_REPLY_PROMPT;

      // 构建最终消息：历史上下文（纯文本）+ 当前消息（可能含图片）
      let finalUserMessage: string | Array<{type: string; text?: string; image_url?: {url: string; detail?: string}}>;

      if (Array.isArray(userMessageContent)) {
        // 当前消息有多模态内容（图片），构建完整消息
        // 历史上下文作为文本前置
        const historyText = context.slice(0, -1).map(c => `${c.role}: ${c.content}`).join('\n');
        if (historyText) {
          userMessageContent[0].text = `历史对话:\n${historyText}\n\n当前消息:\n${userMessageContent[0].text || ''}`;
        }
        finalUserMessage = userMessageContent;
      } else {
        // 纯文本：拼接全部上下文
        finalUserMessage = context.map(c => `${c.role}: ${c.content}`).join('\n');
      }

      this.logger.info(`🤖 生成自动回复 → ${msg.chatId} (${senderName})`);

      const reply = await this.llmChat(systemPrompt, finalUserMessage);
      if (!reply) {
        this.logger.warn('LLM 未生成回复');
        return;
      }

      // 发送回复
      const result = await this.client.sendMessage(msg.chatId, reply);
      if (result.success) {
        // 将回复加入上下文
        context.push({ role: 'assistant', content: reply });
        this.trimContext(msg.chatId, maxContext);
        this.logger.info(`✅ 自动回复已发送 → ${msg.chatId}`);
      }
    } catch (err) {
      this.logger.error('自动回复失败', (err as Error).message);
    }
  }

  private getChatContext(chatId: string, maxContext: number): Array<{ role: string; content: string }> {
    if (!this.chatContexts.has(chatId)) {
      this.chatContexts.set(chatId, []);
    }
    return this.chatContexts.get(chatId)!;
  }

  private trimContext(chatId: string, maxContext: number): void {
    const context = this.chatContexts.get(chatId);
    if (context && context.length > maxContext * 2) {
      // 保留最近的消息
      this.chatContexts.set(chatId, context.slice(-maxContext));
    }
  }

  // ==================== 辅助方法 ====================

  /**
   * 规范化聊天 ID
   * - 纯数字 → 添加 @s.whatsapp.net
   * - 已包含 @ → 直接使用
   */
  private normalizeChatId(id: string): string {
    if (id.includes('@')) return id;
    // 纯数字，添加后缀
    return `${id}@s.whatsapp.net`;
  }

  /**
   * 从 URL 下载文件到临时目录，返回本地路径
   */
  private async downloadToFile(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return null;

      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const tmpDir = mkdtempSync(join(tmpdir(), 'wa-media-'));
      const ext = url.split('.').pop()?.split('?')[0]?.toLowerCase() || 'bin';
      const filePath = join(tmpDir, `download.${ext}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filePath, buffer);
      return filePath;
    } catch (err) {
      this.logger.error('下载 URL 文件失败', (err as Error).message);
      return null;
    }
  }
}
