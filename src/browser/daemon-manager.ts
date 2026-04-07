/**
 * Daemon 管理器
 * 
 * 负责自动启动和停止 Browser Bridge Daemon
 * 作为 Agent 的附属进程，生命周期绑定到 Agent
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { createLogger } from '../core/logger.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger('DaemonManager');

export interface DaemonManagerOptions {
  /** Daemon 端口 */
  port: number;
  /** Daemon 主机 */
  host: string;
  /** 启动超时（毫秒） */
  startupTimeout?: number;
}

/**
 * Daemon 管理器
 */
export class DaemonManager {
  private options: DaemonManagerOptions;
  private daemonProcess: ChildProcess | null = null;
  private isStarted: boolean = false;

  constructor(options: DaemonManagerOptions) {
    this.options = {
      startupTimeout: 10000,
      ...options,
    };
  }

  /**
   * 检查 Daemon 是否已在运行
   */
  async isRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection(
        { port: this.options.port, host: this.options.host },
        () => {
          socket.end();
          resolve(true);
        },
      );
      
      socket.on('error', () => {
        resolve(false);
      });
      
      // 超时处理
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 1000);
    });
  }

  /**
   * 启动 Daemon
   */
  async start(): Promise<boolean> {
    // 先检查是否已经运行
    const running = await this.isRunning();
    if (running) {
      logger.info(`Daemon 已在运行 (端口 ${this.options.port})`);
      this.isStarted = true;
      return true;
    }

    logger.info('正在启动 Browser Bridge Daemon...');

    return new Promise((resolve, reject) => {
      try {
        // 使用 spawn 启动 daemon 子进程
        this.daemonProcess = spawn(
          process.execPath,
          [
            ...process.execArgv,
            join(__dirname, '..', 'bin', 'daemon.js'),
            '--port', String(this.options.port),
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false, // 不分离,随父进程退出
          },
        );

        // 捕获输出
        if (this.daemonProcess.stdout) {
          this.daemonProcess.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) logger.debug(`[daemon stdout] ${msg}`);
          });
        }

        if (this.daemonProcess.stderr) {
          this.daemonProcess.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) logger.debug(`[daemon stderr] ${msg}`);
          });
        }

        // 进程错误处理
        this.daemonProcess.on('error', (err) => {
          logger.error(`Daemon 进程错误: ${err.message}`);
          if (!this.isStarted) {
            reject(err);
          }
        });

        // 进程退出处理
        this.daemonProcess.on('exit', (code, signal) => {
          logger.debug(`Daemon 进程退出 (code=${code}, signal=${signal})`);
          this.daemonProcess = null;
          this.isStarted = false;
        });

        // 等待 Daemon 启动完成
        this.waitForReady()
          .then(() => {
            this.isStarted = true;
            logger.info(`✅ Browser Bridge Daemon 已启动 (端口 ${this.options.port})`);
            resolve(true);
          })
          .catch((err) => {
            logger.error(`Daemon 启动失败: ${err.message}`);
            reject(err);
          });

      } catch (err: any) {
        logger.error(`启动 Daemon 异常: ${err.message}`);
        reject(err);
      }
    });
  }

  /**
   * 等待 Daemon 就绪
   */
  private async waitForReady(): Promise<void> {
    const maxAttempts = Math.floor((this.options.startupTimeout || 10000) / 200);
    
    for (let i = 0; i < maxAttempts; i++) {
      const ready = await this.isRunning();
      if (ready) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    throw new Error(`Daemon 启动超时 (${this.options.startupTimeout}ms)`);
  }

  /**
   * 停止 Daemon
   */
  async stop(): Promise<void> {
    if (!this.daemonProcess) {
      return;
    }

    logger.info('正在停止 Browser Bridge Daemon...');

    return new Promise((resolve) => {
      if (!this.daemonProcess) {
        resolve();
        return;
      }

      // 设置超时，如果优雅关闭失败则强制杀死
      const timeout = setTimeout(() => {
        if (this.daemonProcess) {
          logger.warn('Daemon 未在超时时间内退出，强制终止');
          this.daemonProcess.kill('SIGKILL');
        }
      }, 3000);

      this.daemonProcess.on('exit', () => {
        clearTimeout(timeout);
        this.daemonProcess = null;
        this.isStarted = false;
        logger.info('✅ Browser Bridge Daemon 已停止');
        resolve();
      });

      // 发送 SIGTERM 信号优雅关闭
      this.daemonProcess.kill('SIGTERM');
    });
  }

  /**
   * 是否已启动
   */
  get started(): boolean {
    return this.isStarted;
  }
}
