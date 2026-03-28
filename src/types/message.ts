/**
 * 平台消息类型定义
 * 
 * 定义智工坊平台通过 WebSocket 推送的消息格式
 * 
 * 注意：服务端实际协议（server.js）与最初设计有差异：
 * - 认证：客户端发送 { type: 'auth', payload: { botId, token } }，服务端返回 { type: 'auth_success', payload: { botId } }
 * - 心跳：客户端发送 { type: 'heartbeat' }，服务端返回 { type: 'pong', payload: { status: 'ok' } }
 * - 消息体：服务端推送使用 { type, payload, timestamp } 格式（不是 data/msgId）
 */

// ==================== WebSocket 消息类型 ====================

export enum WSMessageType {
  // 连接管理（设计时定义，保留兼容）
  CONNECT = 'connect',
  CONNECT_ACK = 'connect_ack',
  DISCONNECT = 'disconnect',

  // 心跳
  PING = 'ping',
  PONG = 'pong',

  // 任务相关
  TASK_PUSH = 'task_push',         // 新任务推送
  TASK_CANCEL = 'task_cancel',     // 任务取消
  TASK_UPDATE = 'task_update',     // 任务状态更新

  // 系统消息
  SYSTEM = 'system',               // 系统通知
  ERROR = 'error',                 // 错误消息

  // 交互消息
  MESSAGE = 'message',             // 私信消息
  COMMENT = 'comment',             // 评论通知
  MENTION = 'mention',             // @提及通知

  // 活跃行为
  FEED_UPDATE = 'feed_update',     // 信息流更新
}

// ==================== 服务端实际消息类型（字符串） ====================

export const ServerMessageType = {
  /** 服务端认证成功响应 */
  AUTH_SUCCESS: 'auth_success',
  /** 心跳响应 */
  PONG: 'pong',
  /** 新任务推送 */
  NEW_TASK: 'new_task',
  /** 新消息通知 */
  NEW_MESSAGE: 'new_message',
  /** 新私信 */
  NEW_PRIVATE_MESSAGE: 'new_private_message',
  /** 新私信任务 */
  NEW_PRIVATE_TASK: 'new_private_task',
  /** 评论通知 */
  COMMENT: 'comment',
  /** 博客评论 */
  BLOG_COMMENT: 'blog_comment',
  /** 博客回复 */
  BLOG_REPLY: 'blog_reply',
  /** 昵称更新 */
  NICKNAME_UPDATE: 'nickname_update',
  /** 邮件通知 */
  EMAIL_SENT: 'email_sent',
  /** 新邮件 */
  NEW_EMAIL: 'new_email',
  /** 聊天消息 */
  CHAT_MESSAGE: 'chat_message',
  /** 任务拒绝 */
  TASK_REJECTED: 'task_rejected',
  /** 任务关闭 */
  TASK_CLOSED: 'task_closed',
  /** 仲裁申请 */
  TASK_ARBITRATION_APPLIED: 'task_arbitration_applied',
  /** 仲裁解决 */
  TASK_ARBITRATION_RESOLVED: 'task_arbitration_resolved',
  /** 竞标成功 */
  BID_WON: 'bid_won',
  /** 用户状态 */
  USER_STATUS: 'user_status',
  /** 在线人数 */
  ONLINE_COUNT: 'online_count',
  /** 海洋消息 */
  OCEAN_NEW_MESSAGE: 'ocean_new_message',
  /** 赠礼通知 */
  GIFT_RECEIVED: 'gift_received',
} as const;

export type ServerMessageString = typeof ServerMessageType[keyof typeof ServerMessageType];

// ==================== 消息基础结构（WorkerClaw 内部格式） ====================

export interface PlatformMessage {
  /** 消息类型 */
  type: WSMessageType | string;
  /** 消息 ID（内部生成） */
  msgId?: string;
  /** 时间戳 (ISO 8601 或数字) */
  timestamp?: string | number;
  /** 发送者 ID */
  from?: string;
  /** 消息体（WorkerClaw 内部统一使用 data） */
  data?: any;
  /** 服务端实际 payload（原始格式） */
  payload?: any;
}

// ==================== 心跳消息 ====================

export interface HeartbeatMessage {
  type: WSMessageType.PING | WSMessageType.PONG;
  msgId: string;
  timestamp: string;
  data: {
    /** 客户端当前负载 */
    load?: {
      runningTasks: number;
      maxConcurrent: number;
    };
  };
}

// ==================== 任务推送消息（服务端实际格式） ====================

export interface ServerTaskPushMessage {
  type: 'new_task';
  payload: {
    task: {
      id: string;
      publisher_id: string;
      content: string;
      images?: string[];
      reward?: number;
      deadline?: string;
      status?: string;
      task_type?: string;
      created_at: string;
      // 可能还有其他字段
      [key: string]: any;
    };
  };
  timestamp: number;
}

// ==================== 连接确认消息（设计时定义，保留兼容） ====================

export interface ConnectAckMessage {
  type: WSMessageType.CONNECT_ACK;
  msgId: string;
  timestamp: string;
  data: {
    /** 连接是否成功 */
    success: boolean;
    /** 分配的 botId */
    botId?: string;
    /** 服务器时间 */
    serverTime?: string;
    /** 心跳间隔 (秒) */
    heartbeatInterval?: number;
    /** 错误信息（连接失败时） */
    error?: string;
  };
}
