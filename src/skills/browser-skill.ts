/**
 * 浏览器技能 (Browser Skill)
 *
 * 基于 Playwright 的网页浏览技能，为 Agent 提供安全上网能力。
 *
 * 提供 6 个工具：
 *   1. browser_navigate - 导航到 URL 并提取页面文本内容
 *   2. browser_extract - 提取页面结构化数据（链接/图片/元数据）
 *   3. browser_screenshot - 截取页面截图
 *   4. browser_click - 点击页面元素
 *   5. browser_fill - 在输入框中填写内容
 *   6. browser_wait - 等待页面元素出现
 *
 * 会话隔离：
 *   - 同一 taskId 的多次操作共享 BrowserContext（保持 Cookie/登录态）
 *   - 不同 taskId 之间 Context 完全隔离
 *
 * 安全策略：
 *   - 权限级别：elevated（需要较高权限才能使用浏览器）
 *   - URL 验证：阻止内网/localhost/file:// 等危险地址
 *   - 页面大小限制：防止超大页面消耗资源
 *   - 截图大小限制：防止截图过大
 *   - 弹窗拦截：阻止恶意弹窗
 *   - 超时控制：防止页面加载卡死
 */

import { createLogger, type Logger } from '../core/logger.js';
import { BrowserSandbox } from '../sandbox/browser-sandbox.js';
import { BrowserSessionManager } from '../sandbox/browser-session.js';
import type { ToolDefinition, ToolExecutorFn, PermissionLevel } from '../types/agent.js';
import type { Skill, SkillContext, SkillResult } from './types.js';
import type { BrowserSandboxConfig } from '../core/config.js';

// ==================== 工具定义 ====================

const BROWSER_TOOLS: ToolDefinition[] = [
  {
    name: 'browser_navigate',
    description: '导航到指定 URL 并提取页面文本内容。同一任务内的多次导航会保持 Cookie 和登录状态。',
    requiredLevel: 'elevated' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要访问的网页 URL（必须是 http:// 或 https://）',
        },
        waitFor: {
          type: 'string',
          description: '可选的 CSS 选择器，等待该元素出现后再提取内容',
        },
        screenshot: {
          type: 'boolean',
          description: '是否同时截图（默认 false）',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_extract',
    description: '提取页面的结构化数据，包括标题、正文、链接列表、图片列表和 meta 元信息。',
    requiredLevel: 'elevated' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要提取数据的网页 URL',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: '截取指定网页的截图并保存为 JPEG 文件。',
    requiredLevel: 'elevated' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要截图的网页 URL',
        },
        fullPage: {
          type: 'boolean',
          description: '是否截取完整页面（默认 false，只截取可视区域）',
        },
        selector: {
          type: 'string',
          description: '可选的 CSS 选择器，只截取该元素区域的截图',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description: '点击页面上的元素。用于点击按钮、链接等交互操作。需要在 navigate 之后的同一任务内使用。',
    requiredLevel: 'elevated' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器，指定要点击的元素（如 "#submit-btn"、".login-button"）',
        },
        waitForNavigation: {
          type: 'boolean',
          description: '点击后是否等待页面跳转完成（默认 true）',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_fill',
    description: '在页面的输入框中填写内容。用于填写表单、搜索框等。需要在 navigate 之后的同一任务内使用。',
    requiredLevel: 'elevated' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器，指定要填写的输入框（如 "#username"、"input[name=email]"）',
        },
        value: {
          type: 'string',
          description: '要填写的内容',
        },
        submit: {
          type: 'boolean',
          description: '填写后是否按回车提交（默认 false）',
        },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browser_wait',
    description: '等待页面上的元素出现。用于等待动态加载的内容或操作结果。',
    requiredLevel: 'elevated' as PermissionLevel,
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS 选择器，等待该元素出现',
        },
        timeout: {
          type: 'number',
          description: '最大等待时间（毫秒，默认 5000）',
        },
      },
      required: ['selector'],
    },
  },
];

// ==================== 浏览器技能 ====================

export class BrowserSkill implements Skill {
  private logger: Logger;
  private sandbox: BrowserSandbox;
  private sessionManager: BrowserSessionManager;

  /** 每个任务的活跃 page（用于交互式操作） */
  private activePages = new Map<string, any>();

  readonly metadata = {
    name: 'browser',
    displayName: '🌐 网页浏览器',
    description: '基于 Playwright 的网页浏览能力，支持导航、提取、截图、点击、填写表单等交互操作',
    version: '2.0.0',
    author: 'WorkerClaw',
    tags: ['browser', 'web', 'scraping', 'playwright', 'form', 'interaction'],
    requiredLevel: 'elevated' as PermissionLevel,
    applicableTaskTypes: [],  // 空数组 = 适用所有任务类型
    requiredTools: [],
  };

  constructor(browserConfig?: BrowserSandboxConfig) {
    this.sandbox = new BrowserSandbox(browserConfig);
    this.sessionManager = this.sandbox.getSessionManager();
    this.logger = createLogger('BrowserSkill');
  }

  readonly tools = BROWSER_TOOLS;

  readonly toolExecutors: Record<string, ToolExecutorFn> = {
    browser_navigate: async (params: any, context: any): Promise<any> => {
      return this.executeNavigate(params, context);
    },
    browser_extract: async (params: any, context: any): Promise<any> => {
      return this.executeExtract(params, context);
    },
    browser_screenshot: async (params: any, context: any): Promise<any> => {
      return this.executeScreenshot(params, context);
    },
    browser_click: async (params: any, context: any): Promise<any> => {
      return this.executeClick(params, context);
    },
    browser_fill: async (params: any, context: any): Promise<any> => {
      return this.executeFill(params, context);
    },
    browser_wait: async (params: any, context: any): Promise<any> => {
      return this.executeWait(params, context);
    },
  };

  async execute(context: SkillContext): Promise<SkillResult> {
    return {
      success: true,
      content: '浏览器技能已就绪。请使用 browser_navigate / browser_extract / browser_screenshot / browser_click / browser_fill / browser_wait 工具访问网页和进行交互。',
      outputs: [],
      durationMs: 0,
    };
  }

  getSystemPromptAddon(): string {
    return [
      '## 🌐 浏览器工具',
      '你可以使用以下浏览器工具安全地访问网页并进行交互操作：',
      '',
      '**基础浏览：**',
      '- `browser_navigate(url, waitFor?, screenshot?)` - 访问网页并提取文本内容',
      '- `browser_extract(url)` - 提取页面结构化数据（链接/图片/meta）',
      '- `browser_screenshot(url, fullPage?, selector?)` - 截取页面截图',
      '',
      '**交互操作（需先 navigate）：**',
      '- `browser_click(selector, waitForNavigation?)` - 点击页面元素（按钮/链接）',
      '- `browser_fill(selector, value, submit?)` - 在输入框中填写内容',
      '- `browser_wait(selector, timeout?)` - 等待元素出现',
      '',
      '**会话特性：**',
      '- 同一任务的多次浏览器操作会保持 Cookie 和登录状态',
      '- 可以先 navigate 登录页 → browser_fill 填写账号 → browser_click 提交 → browser_navigate 访问需要登录的页面',
      '- 不同客户之间的浏览器会话完全隔离',
      '',
      '**使用提示：**',
      '- 页面文本内容会自动去除导航栏/广告等干扰元素',
      '- 截图保存为 JPEG 格式，会作为文件附件提交',
      '- 内网地址和危险协议会被安全沙箱阻止',
    ].join('\n');
  }

  async init(): Promise<void> {
    this.logger.info('浏览器技能初始化 (v2.0.0 - 会话隔离模式)');
  }

  async dispose(): Promise<void> {
    // 清理所有活跃 page
    for (const [taskId, page] of this.activePages) {
      try { await page.close().catch(() => {}); } catch {}
    }
    this.activePages.clear();

    // 关闭会话管理器
    await this.sandbox.close();
    this.logger.info('浏览器技能清理');
  }

  /**
   * 销毁指定任务的会话（由 AgentEngine 在任务结束时调用）
   */
  async destroyTaskSession(taskId: string): Promise<void> {
    // 关闭该任务的活跃 page
    const page = this.activePages.get(taskId);
    if (page) {
      try { await page.close().catch(() => {}); } catch {}
      this.activePages.delete(taskId);
    }

    // 销毁该任务的浏览器会话（context）
    await this.sessionManager.destroy(taskId);
    this.logger.debug(`已销毁任务浏览器会话 [${taskId}]`);
  }

  /**
   * 获取或创建任务的活跃 page
   * 用于交互式操作（click/fill/wait），需要先 navigate 才能使用
   */
  private async getActivePage(taskId: string): Promise<any> {
    let page = this.activePages.get(taskId);
    if (page) {
      try {
        // 检查 page 是否仍然有效
        if (!page.isClosed()) {
          return page;
        }
      } catch {
        // page 已失效
      }
    }
    throw new Error('没有活跃页面。请先使用 browser_navigate 访问一个网页。');
  }

  // ==================== 工具执行器 ====================

  private async executeNavigate(params: any, context: any): Promise<any> {
    const { url, waitFor, screenshot } = params;
    const toolCallId = context.toolCallId || 'unknown';
    const taskId = context.taskId || '';

    if (!url) {
      return { toolCallId, success: false, content: '缺少必要参数: url', error: 'missing_param' };
    }

    this.logger.info(`browser_navigate: ${url}`, { taskId });

    // 如果该任务已有活跃 page，先关闭
    const oldPage = this.activePages.get(taskId);
    if (oldPage) {
      try { await oldPage.close().catch(() => {}); } catch {}
      this.activePages.delete(taskId);
    }

    const result = await this.sandbox.navigate(url, {
      waitFor,
      extractText: true,
      screenshot: screenshot || false,
      workDir: context.workDir,
    }, taskId || undefined);

    if (!result.success) {
      return {
        toolCallId,
        success: false,
        content: `导航失败: ${result.error}`,
        error: result.error,
      };
    }

    // 保留该任务的活跃 page 用于后续交互
    // 通过 sessionManager 获取会话并创建 page
    if (taskId) {
      try {
        const session = await this.sessionManager.getOrCreate(taskId);
        const page = await session.context.newPage();
        const response = await page.goto(url, {
          timeout: this.sandbox['config']?.pageTimeoutMs || 30000,
          waitUntil: 'domcontentloaded',
        });
        if (response && response.status() < 400) {
          this.activePages.set(taskId, page);
        } else {
          try { await page.close().catch(() => {}); } catch {}
        }
      } catch (err) {
        this.logger.debug('创建活跃页面失败', { error: (err as Error).message });
      }
    }

    const output = [
      `标题: ${result.title}`,
      `URL: ${result.url}`,
      '',
      result.content,
    ].join('\n');

    if (result.screenshotPath) {
      return {
        toolCallId,
        success: true,
        content: output + `\n\n📸 截图已保存: ${result.screenshotPath}`,
      };
    }

    return { toolCallId, success: true, content: output };
  }

  private async executeExtract(params: any, context: any): Promise<any> {
    const { url } = params;
    const toolCallId = context.toolCallId || 'unknown';
    const taskId = context.taskId || '';

    if (!url) {
      return { toolCallId, success: false, content: '缺少必要参数: url', error: 'missing_param' };
    }

    this.logger.info(`browser_extract: ${url}`, { taskId });

    const result = await this.sandbox.extractStructured(url, taskId || undefined);

    if (!result.success) {
      return {
        toolCallId,
        success: false,
        content: `提取失败: ${result.error}`,
        error: result.error,
      };
    }

    // 格式化结构化数据
    const sections: string[] = [
      `标题: ${result.title}`,
      `URL: ${result.url}`,
    ];

    // Meta 信息
    if (Object.keys(result.meta).length > 0) {
      sections.push('', '### Meta 信息');
      for (const [key, value] of Object.entries(result.meta)) {
        sections.push(`- ${key}: ${value}`);
      }
    }

    // 链接
    if (result.links.length > 0) {
      sections.push('', `### 链接 (${result.links.length})`);
      for (const link of result.links.slice(0, 30)) {
        sections.push(`- [${link.text}](${link.href})`);
      }
      if (result.links.length > 30) {
        sections.push(`... 还有 ${result.links.length - 30} 个链接`);
      }
    }

    // 图片
    if (result.images.length > 0) {
      sections.push('', `### 图片 (${result.images.length})`);
      for (const img of result.images.slice(0, 10)) {
        sections.push(`- ${img.alt || '(无描述)'}: ${img.src}`);
      }
      if (result.images.length > 10) {
        sections.push(`... 还有 ${result.images.length - 10} 张图片`);
      }
    }

    // 正文（截取前 3000 字符作为摘要）
    if (result.text) {
      const preview = result.text.slice(0, 3000);
      sections.push('', '### 正文摘要');
      sections.push(preview);
      if (result.text.length > 3000) {
        sections.push(`\n... (共 ${result.text.length} 字符，已截取前 3000)`);
      }
    }

    return {
      toolCallId,
      success: true,
      content: sections.join('\n'),
    };
  }

  private async executeScreenshot(params: any, context: any): Promise<any> {
    const { url, fullPage, selector } = params;
    const toolCallId = context.toolCallId || 'unknown';
    const taskId = context.taskId || '';

    if (!url) {
      return { toolCallId, success: false, content: '缺少必要参数: url', error: 'missing_param' };
    }

    this.logger.info(`browser_screenshot: ${url}`, { taskId });

    const result = await this.sandbox.takeScreenshot(url, context.workDir, {
      fullPage: fullPage || false,
      selector,
    }, taskId || undefined);

    if (!result.success) {
      return {
        toolCallId,
        success: false,
        content: `截图失败: ${result.error}`,
        error: result.error,
      };
    }

    return {
      toolCallId,
      success: true,
      content: `截图已保存: ${result.path}\n尺寸: ${result.width}x${result.height}px\n大小: ${result.sizeKB}KB`,
    };
  }

  private async executeClick(params: any, context: any): Promise<any> {
    const { selector, waitForNavigation = true } = params;
    const toolCallId = context.toolCallId || 'unknown';
    const taskId = context.taskId || '';

    if (!selector) {
      return { toolCallId, success: false, content: '缺少必要参数: selector', error: 'missing_param' };
    }

    if (!taskId) {
      return { toolCallId, success: false, content: '交互操作需要任务上下文（taskId）', error: 'no_task_context' };
    }

    this.logger.info(`browser_click: ${selector}`, { taskId });

    try {
      const page = await this.getActivePage(taskId);

      if (waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
          page.click(selector, { timeout: 5000 }),
        ]);
      } else {
        await page.click(selector, { timeout: 5000 });
      }

      // 提取点击后的页面内容
      const extractFn = `() => {
        const main = document.querySelector('main') || document.querySelector('article') || document.querySelector('[role="main"]') || document.body;
        if (!main) return '';
        return (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 3000);
      }`;
      const content = await page.evaluate(extractFn);

      return {
        toolCallId,
        success: true,
        content: content ? `点击成功，当前页面内容：\n\n${content}` : '点击成功。',
      };
    } catch (err) {
      return {
        toolCallId,
        success: false,
        content: `点击失败: ${(err as Error).message}`,
        error: (err as Error).message,
      };
    }
  }

  private async executeFill(params: any, context: any): Promise<any> {
    const { selector, value, submit = false } = params;
    const toolCallId = context.toolCallId || 'unknown';
    const taskId = context.taskId || '';

    if (!selector || value === undefined) {
      return { toolCallId, success: false, content: '缺少必要参数: selector, value', error: 'missing_param' };
    }

    if (!taskId) {
      return { toolCallId, success: false, content: '交互操作需要任务上下文（taskId）', error: 'no_task_context' };
    }

    this.logger.info(`browser_fill: ${selector} = ${value.slice(0, 20)}...`, { taskId });

    try {
      const page = await this.getActivePage(taskId);

      // 清空输入框并填写新内容
      await page.fill(selector, String(value), { timeout: 5000 });

      if (submit) {
        await page.press(selector, 'Enter');
        // 等待可能的页面跳转
        await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
      }

      return {
        toolCallId,
        success: true,
        content: `已在 "${selector}" 中填写内容${submit ? '并提交' : ''}。`,
      };
    } catch (err) {
      return {
        toolCallId,
        success: false,
        content: `填写失败: ${(err as Error).message}`,
        error: (err as Error).message,
      };
    }
  }

  private async executeWait(params: any, context: any): Promise<any> {
    const { selector, timeout = 5000 } = params;
    const toolCallId = context.toolCallId || 'unknown';
    const taskId = context.taskId || '';

    if (!selector) {
      return { toolCallId, success: false, content: '缺少必要参数: selector', error: 'missing_param' };
    }

    if (!taskId) {
      return { toolCallId, success: false, content: '交互操作需要任务上下文（taskId）', error: 'no_task_context' };
    }

    this.logger.info(`browser_wait: ${selector} (timeout: ${timeout}ms)`, { taskId });

    try {
      const page = await this.getActivePage(taskId);
      await page.waitForSelector(selector, { timeout });

      return {
        toolCallId,
        success: true,
        content: `元素 "${selector}" 已出现。`,
      };
    } catch (err) {
      return {
        toolCallId,
        success: false,
        content: `等待超时 (${timeout}ms): 元素 "${selector}" 未出现`,
        error: (err as Error).message,
      };
    }
  }
}
