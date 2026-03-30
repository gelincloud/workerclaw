/**
 * 浏览器沙箱
 *
 * 封装 Playwright 无头浏览器，提供安全的网页访问能力：
 * - 页面加载超时控制
 * - 响应大小限制
 * - 弹窗拦截
 * - Cookie 隔离（同一 taskId 内共享 session，跨任务隔离）
 * - 资源限制（截图质量/大小）
 * - URL 安全验证（阻止内网/危险协议）
 *
 * 架构：
 * - BrowserSessionManager 管理共享 Browser 进程 + 按任务隔离的 Context
 * - 同一任务的多次操作复用同一 Context（保持登录态/Cookie）
 * - 不同任务之间 Context 完全隔离
 */

import { createLogger, type Logger } from '../core/logger.js';
import { BrowserSessionManager, type BrowserSessionConfig } from './browser-session.js';
import type { BrowserSandboxConfig } from '../core/config.js';

// ==================== 默认配置 ====================

const DEFAULT_CONFIG = {
  pageTimeoutMs: 30000,
  maxPageSizeKB: 2048,
  screenshotMaxWidth: 1280,
  screenshotQuality: 0.7,
  screenshotMaxSizeKB: 512,
  enableJavaScript: true,
  blockPopups: true,
};

// ==================== 内网地址检测 ====================

const LOCAL_HOSTNAMES = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
  'metadata.google.internal', '169.254.169.254',
];

const LOCAL_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
];

function isLocalAddress(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOCAL_HOSTNAMES.includes(clean)) return true;
  for (const range of LOCAL_RANGES) {
    if (range.test(clean)) return true;
  }
  return false;
}

// ==================== 浏览器结果 ====================

export interface NavigateResult {
  success: boolean;
  title: string;
  url: string;
  content: string;
  screenshotPath?: string;
  error?: string;
}

export interface ExtractResult {
  success: boolean;
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  images: Array<{ alt: string; src: string }>;
  meta: Record<string, string>;
  error?: string;
}

export interface ScreenshotResult {
  success: boolean;
  path: string;
  width: number;
  height: number;
  sizeKB: number;
  error?: string;
}

// ==================== 浏览器沙箱 ====================

export class BrowserSandbox {
  private logger: Logger;
  private config: typeof DEFAULT_CONFIG & BrowserSandboxConfig;
  private sessionManager: BrowserSessionManager;

  constructor(browserConfig?: BrowserSandboxConfig) {
    this.config = { ...DEFAULT_CONFIG, ...browserConfig };
    this.logger = createLogger('BrowserSandbox');

    // 初始化会话管理器
    const sessionConfig: BrowserSessionConfig = {
      launchArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
      ],
      userAgent: this.config.userAgent,
      proxyUrl: this.config.proxyUrl,
    };
    this.sessionManager = new BrowserSessionManager(sessionConfig);
  }

  /**
   * 获取会话管理器（供 AgentEngine 调用销毁会话）
   */
  getSessionManager(): BrowserSessionManager {
    return this.sessionManager;
  }

  /**
   * 验证 URL 安全性
   */
  validateUrl(url: string): { allowed: boolean; reason?: string } {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: `无效的 URL: ${url.slice(0, 100)}` };
    }

    const { protocol, hostname } = parsed;

    // 仅允许 http/https
    if (!['http:', 'https:'].includes(protocol)) {
      return { allowed: false, reason: `不支持的协议: ${protocol}` };
    }

    // 阻止内网地址
    if (isLocalAddress(hostname)) {
      return { allowed: false, reason: `内网地址访问被阻止: ${hostname}` };
    }

    return { allowed: true };
  }

  /**
   * 导航到指定 URL 并提取页面内容
   *
   * @param url 目标 URL
   * @param options 导航选项
   * @param taskId 任务 ID（用于会话隔离，同一 taskId 内保持登录态）
   */
  async navigate(url: string, options?: {
    waitFor?: string;
    extractText?: boolean;
    screenshot?: boolean;
    workDir?: string;
  }, taskId?: string): Promise<NavigateResult> {
    // URL 安全验证
    const urlCheck = this.validateUrl(url);
    if (!urlCheck.allowed) {
      return { success: false, title: '', url, content: '', error: urlCheck.reason };
    }

    // 无 taskId 时使用默认隔离 key（向后兼容）
    const sessionKey = taskId || '__no_session__';

    let page: any = null;
    let needsCleanup = false;

    try {
      const session = await this.sessionManager.getOrCreate(sessionKey);
      page = await session.context.newPage();
      needsCleanup = true;

      // 拦截弹窗
      if (this.config.blockPopups) {
        session.context.on('page', (p: any) => p.close().catch(() => {}));
      }

      // 导航
      const response = await page.goto(url, {
        timeout: this.config.pageTimeoutMs,
        waitUntil: 'domcontentloaded',
      });

      // 检查响应
      if (!response) {
        return { success: false, title: '', url, content: '', error: '页面无响应' };
      }

      const status = response.status();
      if (status >= 400) {
        return {
          success: false, title: '', url, content: '',
          error: `HTTP ${status}: ${response.statusText()}`,
        };
      }

      // 检查响应大小
      const contentLength = response.headers()['content-length'];
      if (contentLength && parseInt(contentLength) > this.config.maxPageSizeKB * 1024) {
        return {
          success: false, title: '', url, content: '',
          error: `页面过大 (${Math.round(parseInt(contentLength) / 1024)}KB)，超过限制 ${this.config.maxPageSizeKB}KB`,
        };
      }

      // 等待可选条件
      if (options?.waitFor) {
        try {
          await page.waitForSelector(options.waitFor, { timeout: 5000 });
        } catch {
          this.logger.debug(`等待选择器超时: ${options.waitFor}`);
        }
      }

      // 提取内容
      let content = '';
      let title = '';

      if (options?.extractText !== false) {
        title = await page.title();

        // 提取正文文本 — 用字符串形式的函数避免 TypeScript DOM 类型检查
        const extractFn = `() => {
          const removeSelectors = ['script', 'style', 'nav', 'header', 'footer',
            'iframe', 'noscript', '[role="navigation"]', '[role="banner"]',
            '[role="contentinfo"]', '.ad', '.advertisement', '.sidebar',
            '.cookie-banner', '.popup', '.modal'];
          for (const sel of removeSelectors) {
            for (const el of document.querySelectorAll(sel)) {
              el.remove();
            }
          }
          const main = document.querySelector('main') ||
            document.querySelector('article') ||
            document.querySelector('[role="main"]') ||
            document.body;
          if (!main) return '';
          const text = main.innerText || main.textContent || '';
          return text.replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]+/g, ' ').trim();
        }`;

        content = await page.evaluate(extractFn);

        // 截断过大内容
        const maxChars = this.config.maxPageSizeKB * 512;
        if (content.length > maxChars) {
          content = content.slice(0, maxChars) + '\n\n[... 内容过长，已截断]';
        }
      }

      // 截图
      let screenshotPath: string | undefined;
      if (options?.screenshot) {
        const shot = await this.internalScreenshot(page, options.workDir);
        if (shot.success) {
          screenshotPath = shot.path;
        }
      }

      return {
        success: true,
        title,
        url: page.url(), // 可能重定向后的最终 URL
        content,
        screenshotPath,
      };

    } catch (err) {
      const error = err as Error;
      this.logger.error('页面导航失败', { url, error: error.message });
      return {
        success: false, title: '', url, content: '',
        error: error.message.includes('Timeout')
          ? `页面加载超时 (${this.config.pageTimeoutMs}ms)`
          : error.message,
      };
    } finally {
      // 只关闭 page，不关闭 context 和 browser（保持会话）
      if (page && needsCleanup) {
        try { await page.close().catch(() => {}); } catch {}
      }
      // 无 taskId 的一次性会话，立即销毁
      if (!taskId) {
        try { await this.sessionManager.destroy(sessionKey); } catch {}
      }
    }
  }

  /**
   * 提取页面结构化数据（链接、图片、元数据）
   *
   * @param url 目标 URL
   * @param taskId 任务 ID（用于会话隔离）
   */
  async extractStructured(url: string, taskId?: string): Promise<ExtractResult> {
    const urlCheck = this.validateUrl(url);
    if (!urlCheck.allowed) {
      return { success: false, url, title: '', text: '', links: [], images: [], meta: {}, error: urlCheck.reason };
    }

    const sessionKey = taskId || '__no_session__';
    let page: any = null;
    let needsCleanup = false;

    try {
      const session = await this.sessionManager.getOrCreate(sessionKey);
      page = await session.context.newPage();
      needsCleanup = true;

      const response = await page.goto(url, {
        timeout: this.config.pageTimeoutMs,
        waitUntil: 'domcontentloaded',
      });

      if (!response || response.status() >= 400) {
        return {
          success: false, url, title: '', text: '', links: [], images: [], meta: {},
          error: `HTTP ${response?.status() || '无响应'}`,
        };
      }

      // 等待 JS 渲染完成（SPA 网站如 Unsplash/Pexels 需要时间加载内容）
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      } catch {}

      // 额外等待动态图片/内容加载
      try {
        await page.waitForTimeout(2000);
      } catch {}

      // 提取结构化数据 — 字符串形式避免 DOM 类型问题
      const extractFn = `() => {
        const title = document.title || '';
        const body = document.body ? document.body.innerText || '' : '';
        const anchors = [...document.querySelectorAll('a[href]')]
          .slice(0, 50)
          .map(a => ({ text: (a.textContent || '').trim().slice(0, 100), href: a.href }))
          .filter(l => l.text && l.href && !l.href.startsWith('javascript:'));
        const imgs = [...document.querySelectorAll('img')]
          .slice(0, 20)
          .map(img => ({ alt: (img.alt || '').slice(0, 100), src: img.src || '' }))
          .filter(i => i.src);
        const metas = {};
        for (const meta of document.querySelectorAll('meta[name], meta[property]')) {
          const n = meta.getAttribute('name') || meta.getAttribute('property') || '';
          const c = meta.getAttribute('content') || '';
          if (n && c) metas[n] = c.slice(0, 200);
        }
        return { title, text: body.slice(0, 50000), links: anchors, images: imgs, metas };
      }`;

      const data = await page.evaluate(extractFn);

      // 截断文本
      const maxChars = this.config.maxPageSizeKB * 512;
      const text = data.text.length > maxChars ? data.text.slice(0, maxChars) + '\n\n[...已截断]' : data.text;

      return {
        success: true,
        url: page.url(),
        title: data.title,
        text,
        links: data.links,
        images: data.images,
        meta: data.metas,
      };

    } catch (err) {
      const error = err as Error;
      this.logger.error('页面数据提取失败', { url, error: error.message });
      return {
        success: false, url, title: '', text: '', links: [], images: [], meta: {},
        error: error.message,
      };
    } finally {
      if (page && needsCleanup) {
        try { await page.close().catch(() => {}); } catch {}
      }
      if (!taskId) {
        try { await this.sessionManager.destroy(sessionKey); } catch {}
      }
    }
  }

  /**
   * 截取页面截图
   *
   * @param url 目标 URL
   * @param workDir 工作目录
   * @param options 截图选项
   * @param taskId 任务 ID（用于会话隔离）
   */
  async takeScreenshot(url: string, workDir?: string, options?: {
    fullPage?: boolean;
    selector?: string;
  }, taskId?: string): Promise<ScreenshotResult> {
    const urlCheck = this.validateUrl(url);
    if (!urlCheck.allowed) {
      return { success: false, path: '', width: 0, height: 0, sizeKB: 0, error: urlCheck.reason };
    }

    const sessionKey = taskId || '__no_session__';
    let page: any = null;
    let needsCleanup = false;

    try {
      const session = await this.sessionManager.getOrCreate(sessionKey);
      page = await session.context.newPage();
      needsCleanup = true;

      await page.goto(url, {
        timeout: this.config.pageTimeoutMs,
        waitUntil: 'domcontentloaded',
      });

      // 如果指定了选择器，等待该元素出现
      if (options?.selector) {
        try {
          await page.waitForSelector(options.selector, { timeout: 5000 });
        } catch {
          // 超时继续截图整个页面
        }
      }

      return await this.internalScreenshot(page, workDir, options?.fullPage);

    } catch (err) {
      const error = err as Error;
      this.logger.error('页面截图失败', { url, error: error.message });
      return { success: false, path: '', width: 0, height: 0, sizeKB: 0, error: error.message };
    } finally {
      if (page && needsCleanup) {
        try { await page.close().catch(() => {}); } catch {}
      }
      if (!taskId) {
        try { await this.sessionManager.destroy(sessionKey); } catch {}
      }
    }
  }

  /**
   * 关闭所有会话和浏览器（框架退出时调用）
   */
  async close(): Promise<void> {
    await this.sessionManager.destroyAll();
  }

  /**
   * 内部截图方法（复用已打开的 page 实例）
   */
  private async internalScreenshot(page: any, workDir?: string, fullPage?: boolean): Promise<ScreenshotResult> {
    try {
      const fs = await import('node:fs/promises');
      const nodePath = await import('node:path');
      const timestamp = Date.now();
      const dir = workDir || './data/sandbox';
      await fs.mkdir(dir, { recursive: true });
      const screenshotPath = nodePath.join(dir, `screenshot-${timestamp}.jpg`);

      const buffer = await page.screenshot({
        type: 'jpeg',
        quality: Math.round(this.config.screenshotQuality * 100),
        fullPage: fullPage || false,
      });

      const sizeKB = Math.round(buffer.length / 1024);

      // 检查大小限制
      if (sizeKB > this.config.screenshotMaxSizeKB) {
        // 压缩重试
        const compressedBuffer = await page.screenshot({
          type: 'jpeg',
          quality: Math.max(20, Math.round(this.config.screenshotQuality * 50)),
          fullPage: false,
        });
        const compressedSize = Math.round(compressedBuffer.length / 1024);
        if (compressedSize <= this.config.screenshotMaxSizeKB) {
          await fs.writeFile(screenshotPath, compressedBuffer);
          return { success: true, path: screenshotPath, width: this.config.screenshotMaxWidth, height: 720, sizeKB: compressedSize };
        }
        return { success: false, path: '', width: 0, height: 0, sizeKB, error: `截图过大 (${sizeKB}KB)` };
      }

      await fs.writeFile(screenshotPath, buffer);

      const viewport = page.viewportSize();

      return {
        success: true,
        path: screenshotPath,
        width: viewport?.width || this.config.screenshotMaxWidth,
        height: viewport?.height || 720,
        sizeKB,
      };
    } catch (err) {
      return { success: false, path: '', width: 0, height: 0, sizeKB: 0, error: (err as Error).message };
    }
  }
}
