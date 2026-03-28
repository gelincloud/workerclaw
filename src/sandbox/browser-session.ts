/**
 * 浏览器会话管理器
 *
 * 管理 Playwright Browser 实例和 BrowserContext 池，实现：
 * - 全局共享 Browser 进程（节省 ~400MB 内存）
 * - 按 taskId 隔离 BrowserContext（Cookie/Storage/Session 独立）
 * - 同一任务的多次浏览器操作复用同一 Context（保持登录态）
 * - 任务结束后自动销毁 Context 释放资源
 * - 超时自动清理防泄漏
 */

import { createLogger, type Logger } from '../core/logger.js';

// ==================== 类型定义 ====================

interface BrowserSession {
  browser: any;          // Playwright Browser 实例（全局共享）
  context: any;          // Playwright BrowserContext（按任务隔离）
  createdAt: number;
  lastUsedAt: number;
  pageCount: number;     // 当前打开的 page 数量（调试用）
}

export interface BrowserSessionConfig {
  /** 会话最大空闲时间（ms），超时自动销毁，默认 10 分钟 */
  maxIdleMs?: number;
  /** 最大并发 session 数，默认 5 */
  maxSessions?: number;
  /** 启动浏览器时的额外参数 */
  launchArgs?: string[];
  /** User-Agent */
  userAgent?: string;
  /** 代理 URL */
  proxyUrl?: string;
}

interface ResolvedSessionConfig {
  maxIdleMs: number;
  maxSessions: number;
  launchArgs: string[];
  userAgent?: string;
  proxyUrl?: string;
}

// ==================== 会话管理器 ====================

export class BrowserSessionManager {
  private logger: Logger;
  private config: ResolvedSessionConfig;

  /** 共享 Browser 实例（懒初始化） */
  private sharedBrowser: any = null;
  private browserInitializing: Promise<any> | null = null;

  /** 会话池：taskId → BrowserSession */
  private sessions = new Map<string, BrowserSession>();

  /** 超时清理定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: BrowserSessionConfig) {
    this.config = {
      maxIdleMs: config?.maxIdleMs ?? 10 * 60 * 1000,  // 10 分钟
      maxSessions: config?.maxSessions ?? 5,
      launchArgs: config?.launchArgs ?? [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
      ],
      userAgent: config?.userAgent || undefined,
      proxyUrl: config?.proxyUrl || undefined,
    };
    this.logger = createLogger('BrowserSession');

    // 每 5 分钟清理一次超时会话
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 5 * 60 * 1000);
    this.cleanupTimer.unref();  // 不阻止进程退出
  }

  /**
   * 获取或创建指定任务的浏览器会话
   *
   * - 如果 taskId 已有会话且未过期，直接返回（复用 Context，保持登录态）
   * - 否则创建新 Context（全新隔离环境）
   */
  async getOrCreate(taskId: string): Promise<BrowserSession> {
    // 检查已有会话
    const existing = this.sessions.get(taskId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      this.logger.debug(`复用已有会话 [${taskId}]`, {
        ageMs: Date.now() - existing.createdAt,
        idleMs: Date.now() - existing.lastUsedAt,
      });
      return existing;
    }

    // 检查并发上限
    if (this.sessions.size >= this.config.maxSessions) {
      // 尝试清理最老的空闲会话
      const evicted = await this.evictOldestIdle();
      if (!evicted) {
        throw new Error(
          `浏览器会话已满 (${this.config.maxSessions})，请等待其他任务完成后再试`,
        );
      }
    }

    // 获取/创建共享 Browser
    const browser = await this.getSharedBrowser();

    // 创建新 Context（按任务隔离）
    const contextConfig: any = {
      userAgent: this.config.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
    };

    if (this.config.proxyUrl) {
      contextConfig.proxy = { server: this.config.proxyUrl };
    }

    const context = await browser.newContext(contextConfig);

    const session: BrowserSession = {
      browser,
      context,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      pageCount: 0,
    };

    this.sessions.set(taskId, session);

    this.logger.info(`创建新浏览器会话 [${taskId}]`, {
      totalSessions: this.sessions.size,
    });

    return session;
  }

  /**
   * 销毁指定任务的会话
   */
  async destroy(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) return;

    try {
      // 关闭所有 page
      const pages = session.context.pages();
      for (const page of pages) {
        await page.close().catch(() => {});
      }
      // 关闭 context
      await session.context.close().catch(() => {});
    } catch (err) {
      this.logger.debug(`关闭会话 context 异常 [${taskId}]`, {
        error: (err as Error).message,
      });
    }

    this.sessions.delete(taskId);
    this.logger.debug(`销毁会话 [${taskId}]`, { remaining: this.sessions.size });
  }

  /**
   * 销毁所有会话（关闭共享浏览器）
   */
  async destroyAll(): Promise<void> {
    // 关闭所有 context
    for (const [taskId] of this.sessions) {
      await this.destroy(taskId);
    }

    // 关闭共享浏览器
    if (this.sharedBrowser) {
      try {
        await this.sharedBrowser.close().catch(() => {});
      } catch {}
      this.sharedBrowser = null;
    }

    // 清理定时器
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.logger.info('浏览器会话管理器已完全关闭');
  }

  /**
   * 获取当前会话统计
   */
  getStats() {
    return {
      totalSessions: this.sessions.size,
      maxSessions: this.config.maxSessions,
      sessions: Array.from(this.sessions.entries()).map(([id, s]) => ({
        taskId: id,
        ageMs: Date.now() - s.createdAt,
        idleMs: Date.now() - s.lastUsedAt,
        pageCount: s.context?.pages()?.length ?? 0,
      })),
    };
  }

  // ==================== 私有方法 ====================

  /**
   * 获取共享 Browser 实例（懒初始化，单例）
   */
  private async getSharedBrowser(): Promise<any> {
    // 已初始化
    if (this.sharedBrowser) {
      try {
        // 检查是否仍然连接
        if (this.sharedBrowser.isConnected()) {
          return this.sharedBrowser;
        }
      } catch {
        // 已断开，重新初始化
      }
    }

    // 防止并发初始化
    if (this.browserInitializing) {
      return this.browserInitializing;
    }

    this.browserInitializing = this.launchBrowser();

    try {
      this.sharedBrowser = await this.browserInitializing;
      return this.sharedBrowser;
    } finally {
      this.browserInitializing = null;
    }
  }

  /**
   * 启动 Chromium 浏览器
   */
  private async launchBrowser(): Promise<any> {
    let chromium: any;
    try {
      const pw = await import('playwright');
      chromium = pw.chromium;
    } catch {
      throw new Error(
        'playwright 未安装或 Chromium 不可用。请运行: npx playwright install chromium',
      );
    }

    const browser = await chromium.launch({
      headless: true,
      args: this.config.launchArgs,
    });

    this.logger.info('Chromium 浏览器已启动（共享实例）');

    // 监听断开事件
    browser.on('disconnected', () => {
      this.logger.warn('Chromium 浏览器已断开连接');
      this.sharedBrowser = null;
      // 清理所有会话引用
      this.sessions.clear();
    });

    return browser;
  }

  /**
   * 清理超时空闲会话
   */
  private async cleanupIdleSessions(): Promise<void> {
    const now = Date.now();
    const toDestroy: string[] = [];

    for (const [taskId, session] of this.sessions) {
      const idleMs = now - session.lastUsedAt;
      if (idleMs > this.config.maxIdleMs) {
        toDestroy.push(taskId);
      }
    }

    for (const taskId of toDestroy) {
      this.logger.info(`清理超时会话 [${taskId}]（空闲超过 ${this.config.maxIdleMs / 1000}s）`);
      await this.destroy(taskId);
    }
  }

  /**
   * 驱逐最老的空闲会话（用于并发上限控制）
   */
  private async evictOldestIdle(): Promise<boolean> {
    let oldestTaskId: string | null = null;
    let oldestLastUsed = Infinity;

    for (const [taskId, session] of this.sessions) {
      if (session.lastUsedAt < oldestLastUsed) {
        oldestLastUsed = session.lastUsedAt;
        oldestTaskId = taskId;
      }
    }

    if (oldestTaskId) {
      this.logger.info(`驱逐最老空闲会话 [${oldestTaskId}]`);
      await this.destroy(oldestTaskId);
      return true;
    }

    return false;
  }
}
