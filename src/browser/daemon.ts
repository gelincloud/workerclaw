/**
 * 智工坊 Browser Bridge - 本地 Daemon
 * 
 * 本地 HTTP + WebSocket 守护进程，作为 WorkerClaw 和 Chrome 扩展之间的桥梁
 * 
 * 功能：
 * 1. HTTP /ping - 健康检查
 * 2. HTTP /command - 接收 CLI 命令
 * 3. WebSocket /ext - 与 Chrome 扩展通信
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import type { Command, Result, BridgeAction } from './protocol.js';

// ==================== 配置 ====================

interface DaemonConfig {
  port?: number;
  host?: string;
  idleTimeout?: number; // 空闲超时（毫秒），默认 4 小时
}

const DEFAULT_CONFIG: Required<DaemonConfig> = {
  port: 19825,
  host: 'localhost',
  idleTimeout: 4 * 60 * 60 * 1000, // 4 小时
};

// ==================== 类型定义 ====================

// 使用 protocol.ts 中的类型定义

// ==================== Daemon 类 ====================

export class BrowserBridgeDaemon {
  private config: Required<DaemonConfig>;
  private httpServer: http.Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private extensionSocket: WebSocket | null = null;
  private pendingCommands: Map<string, {
    resolve: (result: Result) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private idleTimer: NodeJS.Timeout | null = null;
  private lastActivity: number = Date.now();

  constructor(config: DaemonConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 启动 Daemon
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 创建 HTTP 服务器
      this.httpServer = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      // 创建 WebSocket 服务器
      this.wsServer = new WebSocketServer({ noServer: true });

      // 处理升级请求
      this.httpServer.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;

        if (pathname === '/ext') {
          this.wsServer!.handleUpgrade(request, socket, head, (ws) => {
            this.wsServer!.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
      });

      // WebSocket 连接处理
      this.wsServer.on('connection', (ws, request) => {
        this.handleWebSocketConnection(ws, request);
      });

      // 启动监听
      this.httpServer.listen(this.config.port, this.config.host, () => {
        console.log(`[Bridge Daemon] 已启动: http://${this.config.host}:${this.config.port}`);
        this.resetIdleTimer();
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  /**
   * 停止 Daemon
   */
  async stop(): Promise<void> {
    // 清理所有待处理的命令
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Daemon stopped'));
    }
    this.pendingCommands.clear();

    // 关闭 WebSocket
    if (this.extensionSocket) {
      this.extensionSocket.close();
      this.extensionSocket = null;
    }

    // 关闭服务器
    return new Promise((resolve) => {
      if (this.wsServer) {
        this.wsServer.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => {
              console.log('[Bridge Daemon] 已停止');
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else if (this.httpServer) {
        this.httpServer.close(() => {
          console.log('[Bridge Daemon] 已停止');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * 执行命令（供 CLI 调用）
   */
  async executeCommand(cmd: Omit<Command, 'id'> & { action: BridgeAction }): Promise<Result> {
    return new Promise((resolve, reject) => {
      if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
        reject(new Error('Extension not connected'));
        return;
      }

      const id = randomUUID();
      const fullCmd: Command = { id, ...cmd };

      // 设置超时
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error('Command timeout'));
      }, 30000); // 30 秒超时

      this.pendingCommands.set(id, { resolve, reject, timeout });

      // 发送命令
      this.extensionSocket.send(JSON.stringify(fullCmd));
      this.updateActivity();
    });
  }

  /**
   * 检查扩展是否已连接
   */
  isExtensionConnected(): boolean {
    return this.extensionSocket?.readyState === WebSocket.OPEN;
  }

  /**
   * 获取状态
   */
  getStatus(): {
    running: boolean;
    extensionConnected: boolean;
    pendingCommands: number;
    uptime: number;
  } {
    return {
      running: this.httpServer !== null,
      extensionConnected: this.isExtensionConnected(),
      pendingCommands: this.pendingCommands.size,
      uptime: Date.now() - this.lastActivity,
    };
  }

  // ==================== 私有方法 ====================

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // 安全检查：拒绝非扩展来源的请求
    const origin = req.headers.origin;
    if (origin && !origin.startsWith('chrome-extension://')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    if (req.method === 'GET' && pathname === '/ping') {
      // 健康检查
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        extensionConnected: this.isExtensionConnected(),
        version: '3.0.0',
      }));
      return;
    }

    if (req.method === 'POST' && pathname === '/command') {
      // 执行命令
      this.handleCommandRequest(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/status') {
      // 获取状态
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getStatus()));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async handleCommandRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
      // 限制请求体大小
      if (body.length > 1024 * 1024) { // 1 MB
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
        return;
      }
    });

    req.on('end', async () => {
      try {
        const cmd = JSON.parse(body) as Command;
        if (!cmd.action) {
          throw new Error('Missing action field');
        }
        const result = await this.executeCommand(cmd);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: '',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    });
  }

  private handleWebSocketConnection(ws: WebSocket, request: http.IncomingMessage): void {
    // 安全检查
    const origin = request.headers.origin;
    if (origin && !origin.startsWith('chrome-extension://')) {
      console.warn(`[Bridge Daemon] 拒绝非扩展来源: ${origin}`);
      ws.close();
      return;
    }

    // 如果已有连接，关闭旧连接
    if (this.extensionSocket) {
      this.extensionSocket.close();
    }

    this.extensionSocket = ws;
    console.log('[Bridge Daemon] Chrome 扩展已连接');

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleExtensionMessage(msg);
      } catch (err) {
        console.error('[Bridge Daemon] 消息解析错误:', err);
      }
    });

    ws.on('close', () => {
      console.log('[Bridge Daemon] Chrome 扩展已断开');
      this.extensionSocket = null;
    });

    ws.on('error', (err) => {
      console.error('[Bridge Daemon] WebSocket 错误:', err);
    });

    this.updateActivity();
  }

  private handleExtensionMessage(msg: any): void {
    // 处理扩展发来的消息
    if (msg.type === 'hello') {
      console.log(`[Bridge Daemon] 扩展版本: ${msg.version}`);
      return;
    }

    if (msg.type === 'log') {
      // 转发扩展日志
      const logFn = msg.level === 'error' ? console.error : 
                    msg.level === 'warn' ? console.warn : 
                    console.log;
      logFn(`[Extension] ${msg.msg}`);
      return;
    }

    // 处理命令结果
    if (msg.id) {
      const pending = this.pendingCommands.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingCommands.delete(msg.id);
        
        if (msg.ok) {
          pending.resolve(msg as Result);
        } else {
          pending.reject(new Error(msg.error || 'Unknown error'));
        }
      }
    }
  }

  private updateActivity(): void {
    this.lastActivity = Date.now();
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      const idleTime = Date.now() - this.lastActivity;
      if (idleTime >= this.config.idleTimeout) {
        console.log('[Bridge Daemon] 空闲超时，自动停止');
        this.stop();
      }
    }, this.config.idleTimeout);
  }
}

// ==================== CLI 入口 ====================

export async function runDaemon(config: DaemonConfig = {}): Promise<BrowserBridgeDaemon> {
  const daemon = new BrowserBridgeDaemon(config);
  await daemon.start();
  
  // 处理进程信号
  process.on('SIGINT', async () => {
    console.log('\n[Bridge Daemon] 收到 SIGINT，正在停止...');
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Bridge Daemon] 收到 SIGTERM，正在停止...');
    await daemon.stop();
    process.exit(0);
  });

  return daemon;
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
  runDaemon().catch(console.error);
}
