/**
 * 消息解析器
 * 
 * 将平台原始消息转换为 WorkerClaw 内部使用的类型
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { PlatformMessage } from '../types/message.js';
import { WSMessageType } from '../types/message.js';
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
   */
  private categorize(type: WSMessageType): ParsedMessage['category'] {
    switch (type) {
      case WSMessageType.TASK_PUSH:
      case WSMessageType.TASK_CANCEL:
      case WSMessageType.TASK_UPDATE:
        return 'task';

      case WSMessageType.MESSAGE:
      case WSMessageType.COMMENT:
      case WSMessageType.MENTION:
      case WSMessageType.FEED_UPDATE:
        return 'interaction';

      case WSMessageType.SYSTEM:
      case WSMessageType.ERROR:
      case WSMessageType.CONNECT:
      case WSMessageType.CONNECT_ACK:
      case WSMessageType.DISCONNECT:
        return 'system';

      case WSMessageType.PING:
      case WSMessageType.PONG:
        return 'heartbeat';

      default:
        return 'unknown';
    }
  }

  /**
   * 解析任务消息
   */
  private parseTask(message: PlatformMessage): Task | undefined {
    try {
      const data = message.data;

      return {
        taskId: data.taskId,
        taskType: this.normalizeTaskType(data.taskType),
        title: data.title || '未命名任务',
        description: data.description || '',
        posterId: data.posterId || message.from || 'unknown',
        posterName: data.posterName,
        reward: data.reward,
        deadline: data.deadline,
        attachments: data.attachments?.map((a: any) => ({
          type: a.type,
          url: a.url,
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
        })),
        createdAt: message.timestamp,
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
