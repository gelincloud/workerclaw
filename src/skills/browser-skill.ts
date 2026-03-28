/**
 * 浏览器技能 (Browser Skill)
 *
 * 基于 Playwright 的网页浏览技能，为 Agent 提供安全上网能力。
 *
 * 提供 3 个工具：
 *   1. browser_navigate - 导航到 URL 并提取页面文本内容
 *   2. browser_extract - 提取页面结构化数据（链接/图片/元数据）
 *   3. browser_screenshot - 截取页面截图
 *
 * 安全策略：
 *   - 权限级别：elevated（需要较高权限才能使用浏览器）
 *   - URL 验证：阻止内网/localhost/file:// 等危险地址
 *   - 页面大小限制：防止超大页面消耗资源
 *   - 截图大小限制：防止截图过大
 *   - Cookie 隔离：每次操作独立浏览器上下文
 *   - 弹窗拦截：阻止恶意弹窗
 *   - 超时控制：防止页面加载卡死
 */

import { createLogger, type Logger } from '../core/logger.js';
import { BrowserSandbox } from '../sandbox/browser-sandbox.js';
import type { ToolDefinition, ToolExecutorFn, PermissionLevel } from '../types/agent.js';
import type { Skill, SkillContext, SkillResult } from './types.js';
import type { BrowserSandboxConfig } from '../core/config.js';

// ==================== 工具定义 ====================

const BROWSER_TOOLS: ToolDefinition[] = [
  {
    name: 'browser_navigate',
    description: '导航到指定 URL 并提取页面文本内容。用于阅读网页文章、查看页面信息等。',
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
];

// ==================== 浏览器技能 ====================

export class BrowserSkill implements Skill {
  private logger: Logger;
  private sandbox: BrowserSandbox;

  readonly metadata = {
    name: 'browser',
    displayName: '🌐 网页浏览器',
    description: '基于 Playwright 的网页浏览能力，可以安全地访问网页、提取内容和截图',
    version: '1.0.0',
    author: 'WorkerClaw',
    tags: ['browser', 'web', 'scraping', 'playwright'],
    requiredLevel: 'elevated' as PermissionLevel,
    applicableTaskTypes: [],  // 空数组 = 适用所有任务类型
    requiredTools: [],
  };

  constructor(browserConfig?: BrowserSandboxConfig) {
    this.sandbox = new BrowserSandbox(browserConfig);
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
  };

  async execute(context: SkillContext): Promise<SkillResult> {
    // 技能级别的 execute 通常不会直接调用
    // 浏览器能力通过工具注册表暴露给 LLM，由 LLM 自主调用工具
    return {
      success: true,
      content: '浏览器技能已就绪。请使用 browser_navigate / browser_extract / browser_screenshot 工具访问网页。',
      outputs: [],
      durationMs: 0,
    };
  }

  getSystemPromptAddon(): string {
    return [
      '## 🌐 浏览器工具',
      '你可以使用以下浏览器工具安全地访问网页：',
      '',
      '- `browser_navigate(url, waitFor?, screenshot?)` - 访问网页并提取文本内容',
      '- `browser_extract(url)` - 提取页面结构化数据（链接/图片/meta）',
      '- `browser_screenshot(url, fullPage?, selector?)` - 截取页面截图',
      '',
      '使用提示：',
      '- 每次浏览器操作是独立的（无 Cookie 持久化）',
      '- 页面文本内容会自动去除导航栏/广告等干扰元素',
      '- 大页面会被自动截断',
      '- 截图保存为 JPEG 格式，会作为文件附件提交',
      '- 内网地址和危险协议会被安全沙箱阻止',
    ].join('\n');
  }

  async init(): Promise<void> {
    this.logger.info('浏览器技能初始化');
  }

  async dispose(): Promise<void> {
    this.logger.info('浏览器技能清理');
  }

  // ==================== 工具执行器 ====================

  private async executeNavigate(params: any, context: any): Promise<any> {
    const { url, waitFor, screenshot } = params;
    const toolCallId = context.toolCallId || 'unknown';

    if (!url) {
      return { toolCallId, success: false, content: '缺少必要参数: url', error: 'missing_param' };
    }

    this.logger.info(`browser_navigate: ${url}`);

    const result = await this.sandbox.navigate(url, {
      waitFor,
      extractText: true,
      screenshot: screenshot || false,
      workDir: context.workDir,
    });

    if (!result.success) {
      return {
        toolCallId,
        success: false,
        content: `导航失败: ${result.error}`,
        error: result.error,
      };
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

    if (!url) {
      return { toolCallId, success: false, content: '缺少必要参数: url', error: 'missing_param' };
    }

    this.logger.info(`browser_extract: ${url}`);

    const result = await this.sandbox.extractStructured(url);

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

    if (!url) {
      return { toolCallId, success: false, content: '缺少必要参数: url', error: 'missing_param' };
    }

    this.logger.info(`browser_screenshot: ${url}`);

    const result = await this.sandbox.takeScreenshot(url, context.workDir, {
      fullPage: fullPage || false,
      selector,
    });

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
}
