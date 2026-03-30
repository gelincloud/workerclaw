/**
 * 消息解析器
 * 
 * 将平台原始消息转换为 WorkerClaw 内部使用的类型
 * 
 * 服务端推送格式: { type: 'new_task'|..., payload: { task: {...} }, timestamp }
 * WorkerClaw 内部格式统一使用 message.data（由 miniabc-client.ts 从 payload 转换）
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { PlatformMessage } from '../types/message.js';
import type { Task, TaskType } from '../types/task.js';

export interface ParsedMessage {
  /** 原始消息 */
  raw: PlatformMessage;
  /** 消息类型（简化） */
  category: 'task' | 'interaction' | 'system' | 'heartbeat' | 'unknown';
  /** 解析后的任务（如果是任务消息） */
  task?: Task;
}

export class MessageParser {
  private logger = createLogger('MessageParser');

  /**
   * 解析平台消息
   */
  parse(message: PlatformMessage): ParsedMessage {
    const category = this.categorize(message.type);

    let task: Task | undefined;
    if (category === 'task') {
      task = this.parseTask(message);
    }

    return { raw: message, category, task };
  }

  /**
   * 消息分类
   * 
   * 同时支持 WSMessageType 枚举和服务端实际字符串类型
   */
  private categorize(type: string): ParsedMessage['category'] {
    switch (type) {
      // 任务相关（服务端实际类型）
      case 'new_task':
      case 'new_private_task':
      // 兼容枚举
      case 'task_push':
      case 'task_cancel':
      case 'task_update':
        return 'task';

      // 交互消息（服务端实际类型）
      case 'new_message':
      case 'new_private_message':
      case 'comment':
      case 'blog_comment':
      case 'blog_reply':
      case 'chat_message':
      case 'nickname_update':
      case 'gift_received':
      case 'ocean_new_message':
      // 兼容枚举
      case 'message':
      case 'mention':
      case 'feed_update':
        return 'interaction';

      // 系统消息
      case 'auth_success':
      case 'user_status':
      case 'online_count':
      case 'email_sent':
      case 'new_email':
      case 'task_rejected':
      case 'task_closed':
      case 'task_arbitration_applied':
      case 'task_arbitration_resolved':
      case 'bid_won':
      case 'rental_started':
      case 'rental_expired':
      case 'system':
      case 'error':
      case 'connect':
      case 'connect_ack':
      case 'disconnect':
        return 'system';

      // 心跳
      case 'ping':
      case 'pong':
      case 'heartbeat':
        return 'heartbeat';

      default:
        return 'unknown';
    }
  }

  /**
   * 解析任务消息
   * 
   * 服务端 new_task 格式: { type: 'new_task', payload: { task: { id, publisher_id, content, ... } } }
   * 经过 miniabc-client 转换后: { type: 'new_task', data: { task: { id, publisher_id, content, ... } } }
   */
  private parseTask(message: PlatformMessage): Task | undefined {
    try {
      // 服务端推送的任务在 data.task 中（data 由 miniabc-client 从 payload 转换）
      const taskData = message.data?.task || message.payload?.task;

      if (!taskData) {
        this.logger.warn('任务消息中没有 task 数据', { type: message.type });
        return undefined;
      }

      return {
        taskId: taskData.id || taskData.taskId,
        taskType: this.normalizeTaskType(taskData.task_type || taskData.taskType),
        title: taskData.title || taskData.content?.substring(0, 50) || '未命名任务',
        description: taskData.content || taskData.description || '',
        posterId: taskData.publisher_id || taskData.posterId || message.from || 'unknown',
        posterName: taskData.publisherName || taskData.poster_name,
        reward: taskData.reward,
        deadline: taskData.deadline,
        images: taskData.images || [],
        attachments: (taskData.attachments || []).map((a: any) => ({
          type: a.type || 'file',
          url: a.url,
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
        })),
        status: taskData.status || 'open',
        createdAt: taskData.created_at || taskData.createdAt || 
          (typeof message.timestamp === 'number' ? new Date(message.timestamp).toISOString() : message.timestamp),
        raw: message,
      };
    } catch (err) {
      this.logger.error('任务消息解析失败', err);
      return undefined;
    }
  }

  /**
   * 标准化任务类型
   */
  private normalizeTaskType(type: string): TaskType {
    const mapping: Record<string, TaskType> = {
      '文字回复': 'text_reply',
      '问答': 'qa',
      '搜索整理': 'search_summary',
      '翻译': 'translation',
      '写文章': 'writing',
      '生成图片': 'image_gen',
      '数据分析': 'data_analysis',
      '代码开发': 'code_dev',
      '系统操作': 'system_op',
      'text_reply': 'text_reply',
      'qa': 'qa',
      'search_summary': 'search_summary',
      'translation': 'translation',
      'writing': 'writing',
      'image_gen': 'image_gen',
      'data_analysis': 'data_analysis',
      'code_dev': 'code_dev',
      'system_op': 'system_op',
    };

    return mapping[type] || 'other';
  }
}

export const messageParser = new MessageParser();
