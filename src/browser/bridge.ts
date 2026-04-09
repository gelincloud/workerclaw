/**
 * 智工坊 Browser Bridge - 客户端
 * 
 * WorkerClaw 通过此客户端与本地 Daemon 通信
 */

import type { Command, Result } from './protocol.js';

// ==================== 配置 ====================

export interface BridgeClientConfig {
  port?: number;
  host?: string;
  timeout?: number;
}

const DEFAULT_CONFIG: Required<BridgeClientConfig> = {
  port: 19825,
  host: 'localhost',
  timeout: 30000,
};

// ==================== 客户端类 ====================

export class BrowserBridgeClient {
  private config: Required<BridgeClientConfig>;
  private daemonUrl: string;

  constructor(config: BridgeClientConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.daemonUrl = `http://${this.config.host}:${this.config.port}`;
  }

  /**
   * 检查 Daemon 是否运行
   */
  async isDaemonRunning(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.daemonUrl}/ping`, {
        signal: AbortSignal.timeout(1000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * 检查扩展是否已连接
   */
  async isExtensionConnected(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.daemonUrl}/ping`, {
        signal: AbortSignal.timeout(1000),
      });
      const data = await resp.json() as { extensionConnected?: boolean };
      return data.extensionConnected === true;
    } catch {
      return false;
    }
  }

  /**
   * 执行命令
   */
  async execute(cmd: Omit<Command, 'id'>): Promise<Result> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const resp = await fetch(`${this.daemonUrl}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
        signal: controller.signal,
      });

      return await resp.json() as Result;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { id: '', ok: false, error: 'Request timeout' };
      }
      return { 
        id: '', 
        ok: false, 
        error: err instanceof Error ? err.message : String(err) 
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ==================== 便捷方法 ====================

  /**
   * 执行 JavaScript
   */
  async exec(code: string, options?: { tabId?: number; workspace?: string }): Promise<unknown> {
    const result = await this.execute({
      action: 'exec',
      code,
      tabId: options?.tabId,
      workspace: options?.workspace,
    });

    if (!result.ok) {
      throw new Error(result.error || 'exec failed');
    }

    return result.data;
  }

  /**
   * 导航到 URL
   */
  async navigate(url: string, options?: { tabId?: number; workspace?: string }): Promise<{
    title: string;
    url: string;
    tabId: number;
  }> {
    const result = await this.execute({
      action: 'navigate',
      url,
      tabId: options?.tabId,
      workspace: options?.workspace,
    });

    if (!result.ok) {
      throw new Error(result.error || 'navigate failed');
    }

    return result.data as { title: string; url: string; tabId: number };
  }

  /**
   * 获取 Cookie
   */
  async getCookies(options: { domain?: string; url?: string }): Promise<Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    expirationDate?: number;
  }>> {
    const result = await this.execute({
      action: 'cookies',
      domain: options.domain,
      url: options.url,
    });

    if (!result.ok) {
      throw new Error(result.error || 'getCookies failed');
    }

    return result.data as any[];
  }

  /**
   * 截图
   */
  async screenshot(options?: {
    tabId?: number;
    workspace?: string;
    format?: 'png' | 'jpeg';
    quality?: number;
    fullPage?: boolean;
  }): Promise<string> {
    const result = await this.execute({
      action: 'screenshot',
      tabId: options?.tabId,
      workspace: options?.workspace,
      format: options?.format,
      quality: options?.quality,
      fullPage: options?.fullPage,
    });

    if (!result.ok) {
      throw new Error(result.error || 'screenshot failed');
    }

    return result.data as string; // base64
  }

  /**
   * 标签页操作
   */
  async tabs(op: 'list', workspace?: string): Promise<Array<{
    index: number;
    tabId: number;
    url: string;
    title: string;
    active: boolean;
  }>>;
  async tabs(op: 'new', workspace?: string, url?: string): Promise<{ tabId: number; url: string }>;
  async tabs(op: 'close', workspace?: string, tabId?: number): Promise<{ closed: number }>;
  async tabs(op: 'list' | 'new' | 'close' | 'select', workspace?: string, param?: string | number): Promise<any> {
    const result = await this.execute({
      action: 'tabs',
      op,
      workspace,
      ...(typeof param === 'string' ? { url: param } : {}),
      ...(typeof param === 'number' ? { tabId: param } : {}),
    });

    if (!result.ok) {
      throw new Error(result.error || 'tabs failed');
    }

    return result.data;
  }

  /**
   * 关闭自动化窗口
   */
  async closeWindow(workspace?: string): Promise<void> {
    const result = await this.execute({
      action: 'close-window',
      workspace,
    });

    if (!result.ok) {
      throw new Error(result.error || 'closeWindow failed');
    }
  }

  /**
   * 激活自动化窗口（带到前台）
   */
  async focusWindow(workspace?: string): Promise<void> {
    const result = await this.execute({
      action: 'focus-window',
      workspace,
    });

    if (!result.ok) {
      throw new Error(result.error || 'focusWindow failed');
    }
  }

  /**
   * 绑定当前标签页
   */
  async bindCurrent(options?: {
    workspace?: string;
    matchDomain?: string;
    matchPathPrefix?: string;
  }): Promise<{
    tabId: number;
    windowId: number;
    url: string;
    title: string;
  }> {
    const result = await this.execute({
      action: 'bind-current',
      workspace: options?.workspace,
      matchDomain: options?.matchDomain,
      matchPathPrefix: options?.matchPathPrefix,
    });

    if (!result.ok) {
      throw new Error(result.error || 'bindCurrent failed');
    }

    return result.data as any;
  }

  /**
   * 获取会话列表
   */
  async getSessions(): Promise<Array<{
    workspace: string;
    windowId: number;
    tabCount: number;
    idleMsRemaining: number;
  }>> {
    const result = await this.execute({ action: 'sessions' });

    if (!result.ok) {
      throw new Error(result.error || 'getSessions failed');
    }

    return result.data as any[];
  }
}

// ==================== 工厂函数 ====================

let defaultClient: BrowserBridgeClient | null = null;

export function getBrowserBridgeClient(config?: BridgeClientConfig): BrowserBridgeClient {
  if (!defaultClient || config) {
    defaultClient = new BrowserBridgeClient(config);
  }
  return defaultClient;
}
