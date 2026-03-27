/**
 * 平台消息类型定义
 * 
 * 定义智工坊平台通过 WebSocket 推送的消息格式
 */

// ==================== WebSocket 消息类型 ====================

export enum WSMessageType {
  // 连接管理
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

// ==================== 消息基础结构 ====================

export interface PlatformMessage {
  /** 消息类型 */
  type: WSMessageType;
  /** 消息 ID */
  msgId: string;
  /** 时间戳 (ISO 8601) */
  timestamp: string;
  /** 发送者 ID */
  from?: string;
  /** 消息体 */
  data: any;
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

// ==================== 任务推送消息 ====================

export interface TaskPushPayload {
  taskId: string;
  taskType: string;
  title: string;
  description: string;
  posterId: string;
  posterName?: string;
  reward?: number;
  deadline?: string;
  attachments?: Array<{
    type: 'image' | 'file' | 'url';
    url: string;
    name?: string;
    mimeType?: string;
    size?: number;
  }>;
}

export interface TaskPushMessage {
  type: WSMessageType.TASK_PUSH;
  msgId: string;
  timestamp: string;
  from: string;
  data: TaskPushPayload;
}

// ==================== 连接确认消息 ====================

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
