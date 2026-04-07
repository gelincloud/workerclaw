/**
 * 智工坊 Browser Bridge - 协议类型定义
 */

// ==================== 命令类型 ====================

export type BridgeAction =
  | 'exec'
  | 'navigate'
  | 'tabs'
  | 'cookies'
  | 'screenshot'
  | 'close-window'
  | 'cdp'
  | 'sessions'
  | 'set-file-input'
  | 'insert-text'
  | 'bind-current'
  | 'network-capture-start'
  | 'network-capture-read';

// ==================== 命令结构 ====================

export interface Command {
  /** 唯一请求 ID */
  id: string;
  /** 操作类型 */
  action: BridgeAction;
  /** 目标标签页 ID */
  tabId?: number;
  /** 工作空间标识 */
  workspace?: string;
  
  // exec
  code?: string;
  
  // navigate
  url?: string;
  
  // tabs
  op?: 'list' | 'new' | 'close' | 'select';
  index?: number;
  
  // cookies
  domain?: string;
  
  // bind-current
  matchDomain?: string;
  matchPathPrefix?: string;
  
  // screenshot
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  
  // set-file-input
  files?: string[];
  selector?: string;
  
  // insert-text
  text?: string;
  
  // network-capture
  pattern?: string;
  
  // cdp
  cdpMethod?: string;
  cdpParams?: Record<string, unknown>;
}

// ==================== 结果结构 ====================

export interface Result {
  /** 匹配的请求 ID */
  id: string;
  /** 是否成功 */
  ok: boolean;
  /** 结果数据 */
  data?: unknown;
  /** 错误信息 */
  error?: string;
}

// ==================== Cookie 结构 ====================

export interface BridgeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
}

// ==================== 标签页信息 ====================

export interface BridgeTab {
  index: number;
  tabId: number;
  url: string;
  title: string;
  active: boolean;
}

// ==================== 会话信息 ====================

export interface BridgeSession {
  workspace: string;
  windowId: number;
  tabCount: number;
  idleMsRemaining: number;
}

// ==================== 配置 ====================

export const BRIDGE_DEFAULT_PORT = 19825;
export const BRIDGE_DEFAULT_HOST = 'localhost';
