/**
 * 工具注册表
 * 
 * 管理所有可用工具，按权限级别过滤
 * 
 * 内置工具:
 *   read_only:  llm_query
 *   limited:    web_search, read_file
 *   standard:   write_file, image_generate, data_analyze
 *   elevated:   run_code, system_command
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { ToolDefinition, PermissionLevel, ToolExecutorFn, ToolResult } from '../types/agent.js';
import { getOpenCliToolDefinitions, getWebCliToolDefinition, getWebCliDescribeToolDefinition } from './opencli-tools.js';
import * as fs from 'fs';
import * as path from 'path';

/** 权限级别排序（从低到高） */
const LEVEL_ORDER: PermissionLevel[] = ['read_only', 'limited', 'standard', 'elevated'];

function levelIndex(level: PermissionLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

export class ToolRegistry {
  private logger = createLogger('ToolRegistry');
  private tools = new Map<string, ToolDefinition>();

  /**
   * 注册工具
   */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`工具 "${tool.name}" 已存在，将被覆盖`);
    }
    this.tools.set(tool.name, tool);
    this.logger.debug(`注册工具: ${tool.name} (权限: ${tool.requiredLevel})`);
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 获取指定权限级别允许的工具列表
   */
  getTools(level: PermissionLevel): ToolDefinition[] {
    const threshold = levelIndex(level);
    return [...this.tools.values()].filter(
      tool => levelIndex(tool.requiredLevel) <= threshold,
    );
  }

  /**
   * 转换为 OpenAI function calling 格式
   */
  getToolsForLLM(level: PermissionLevel): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }> {
    return this.getTools(level).map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * 检查工具是否允许在指定权限级别下使用
   */
  isToolAllowed(toolName: string, level: PermissionLevel): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;
    return levelIndex(tool.requiredLevel) <= levelIndex(level);
  }

  /**
   * 获取工具的执行器
   */
  getExecutor(toolName: string): ToolExecutorFn | undefined {
    return this.tools.get(toolName)?.executor;
  }

  /**
   * 获取工具定义
   */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册的工具名
   */
  getToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * 获取统计信息
   */
  getStats(): { total: number; byLevel: Record<PermissionLevel, number> } {
    const byLevel: Record<PermissionLevel, number> = {
      read_only: 0,
      limited: 0,
      standard: 0,
      elevated: 0,
    };
    for (const tool of this.tools.values()) {
      byLevel[tool.requiredLevel]++;
    }
    return { total: this.tools.size, byLevel };
  }
}

// ==================== 内置工具执行器 ====================

const logger = createLogger('BuiltinTools');

/**
 * web_search 执行器 — DuckDuckGo Lite 主引擎 + Bing 备用引擎
 */
async function executeWebSearch(params: any, context: any): Promise<ToolResult> {
  const { query, maxResults = 5 } = params;
  const toolCallId = context?.toolCallId || 'builtin';

  if (!query || typeof query !== 'string') {
    return { toolCallId, success: false, content: '缺少搜索关键词 (query)', error: 'missing_query' };
  }

  const timeoutMs = Math.min(context?.remainingMs || 30000, 30000);

  // 引擎列表：主引擎 + 备用引擎
  const engines = [
    { name: 'DuckDuckGo', fn: () => searchDuckDuckGo(query, maxResults, timeoutMs) },
    { name: 'Bing', fn: () => searchBing(query, maxResults, timeoutMs) },
  ];

  for (const engine of engines) {
    try {
      logger.debug(`尝试 ${engine.name} 搜索`, { query });
      const results = await engine.fn();
      if (results.length > 0) {
        const formatted = results.map((r, i) =>
          `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet ? `摘要: ${r.snippet}\n` : ''}`
        ).join('\n');

        return {
          toolCallId,
          success: true,
          content: `搜索 "${query}" 的结果（${engine.name}，共 ${results.length} 条）：\n\n${formatted}`,
        };
      }
      logger.debug(`${engine.name} 无结果，尝试下一个引擎`);
    } catch (err) {
      logger.debug(`${engine.name} 搜索失败`, { error: (err as Error).message });
    }
  }

  return {
    toolCallId,
    success: false,
    content: `所有搜索引擎均不可用，请稍后重试或使用 browser_extract 工具直接访问搜索引擎。`,
    error: 'all_engines_failed',
  };
}

/**
 * DuckDuckGo Lite 搜索
 */
async function searchDuckDuckGo(query: string, maxResults: number, timeoutMs: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo HTTP ${response.status}`);
  }

  const html = await response.text();
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // 主解析：result-link class
  const trRegex = /<tr[^>]*class="result-link"[^>]*>[\s\S]*?<\/tr>/gi;
  let match: RegExpExecArray | null;

  while ((match = trRegex.exec(html)) !== null && results.length < maxResults) {
    const tr = match[0];
    const hrefMatch = tr.match(/href="([^"]+)"/);
    const titleMatch = tr.match(/class="result-link"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = tr.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i);

    if (hrefMatch && titleMatch) {
      const actualUrl = decodeURIComponent(
        hrefMatch[1].split('&').find(p => p.startsWith('uddg='))?.slice(5) || hrefMatch[1]
      );
      results.push({
        title: titleMatch[1].replace(/<[^>]*>/g, '').trim(),
        url: actualUrl.startsWith('http') ? actualUrl : `https://duckduckgo.com${actualUrl}`,
        snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '',
      });
    }
  }

  // 备用解析：更宽松的正则
  if (results.length === 0) {
    const linkRegex = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(html)) !== null && results.length < maxResults) {
      const linkHref = linkMatch[1];
      const linkText = linkMatch[2].replace(/<[^>]*>/g, '').trim();
      if (linkText && linkHref) {
        const actualUrl = decodeURIComponent(
          linkHref.split('&').find(p => p.startsWith('uddg='))?.slice(5) || linkHref
        );
        results.push({
          title: linkText,
          url: actualUrl.startsWith('http') ? actualUrl : `https://duckduckgo.com${actualUrl}`,
          snippet: '',
        });
      }
    }
  }

  // 第三层备用：直接从 HTML 提取所有搜索结果链接
  if (results.length === 0) {
    const htmlRegex = /<a[^>]+href="(\/l\/\?uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let htmlMatch: RegExpExecArray | null;
    while ((htmlMatch = htmlRegex.exec(html)) !== null && results.length < maxResults) {
      const linkHref = htmlMatch[1];
      const linkText = htmlMatch[2].replace(/<[^>]*>/g, '').trim();
      if (linkText) {
        const actualUrl = decodeURIComponent(
          linkHref.split('&').find(p => p.startsWith('uddg='))?.slice(5) || ''
        );
        if (actualUrl) {
          results.push({ title: linkText, url: actualUrl, snippet: '' });
        }
      }
    }
  }

  return results;
}

/**
 * Bing 搜索（备用引擎）
 */
async function searchBing(query: string, maxResults: number, timeoutMs: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Bing HTTP ${response.status}`);
  }

  const html = await response.text();
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // Bing 搜索结果在 <li class="b_algo"> 中
  const algoRegex = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;

  while ((match = algoRegex.exec(html)) !== null && results.length < maxResults) {
    const block = match[1];

    // 提取链接 — 只取 href，不贪婪匹配链接文本
    const hrefMatch = block.match(/<a[^>]+href="([^"]+)"[^>]*>/i);
    // 提取标题 — 优先从 <h2><a>...</a></h2> 结构中提取，且只取最深层的文本节点
    // Bing 结构: <h2><a href="...">标题文本</a></h2>，可能还有 cite 显示域名
    let title = '';
    const h2Match = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match) {
      const h2Content = h2Match[1];
      // 提取 <a> 标签内的纯文本（排除 cite 等子元素）
      const aMatch = h2Content.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      if (aMatch) {
        title = aMatch[1]
          .replace(/<[^>]*>/g, '')  // 移除所有内部标签
          .replace(/\s+/g, ' ')      // 合并空白
          .trim();
      }
    }
    // 如果 h2 提取失败，回退到直接从 <a> 提取（只取第一行文本）
    if (!title && hrefMatch) {
      const aContent = block.match(/<a[^>]+href="[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      if (aContent) {
        title = aContent[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      }
    }

    // 提取摘要
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim().slice(0, 300) : '';

    const linkUrl = hrefMatch ? hrefMatch[1] : '';
    if (title && linkUrl && title.length < 200 && !linkUrl.startsWith('javascript:')) {
      results.push({ title, url: linkUrl, snippet });
    }
  }

  return results;
}

/**
 * read_file 执行器 — 读取本地文件
 */
async function executeReadFile(params: any, context: any): Promise<ToolResult> {
  const { path: filePath } = params;
  const toolCallId = context?.toolCallId || 'builtin';

  if (!filePath) {
    return { toolCallId, success: false, content: '缺少文件路径 (path)', error: 'missing_path' };
  }

  try {
    const workDir = context?.workDir || process.cwd();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(workDir, filePath);

    // 安全检查：不允许读取工作目录之外的文件
    if (workDir && !resolvedPath.startsWith(path.resolve(workDir))) {
      return { toolCallId, success: false, content: `文件路径超出工作目录范围: ${filePath}`, error: 'path_outside_workdir' };
    }

    if (!fs.existsSync(resolvedPath)) {
      return { toolCallId, success: false, content: `文件不存在: ${filePath}`, error: 'file_not_found' };
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return { toolCallId, success: false, content: `路径不是文件: ${filePath}`, error: 'not_a_file' };
    }

    // 限制文件大小 (1MB)
    if (stat.size > 1024 * 1024) {
      return { toolCallId, success: false, content: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 1MB`, error: 'file_too_large' };
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const preview = content.length > 8000 ? content.slice(0, 8000) + '\n\n[... 文件内容过长，已截断 ...]' : content;

    return {
      toolCallId,
      success: true,
      content: `文件内容 (${filePath}, ${(stat.size / 1024).toFixed(1)}KB):\n\n${preview}`,
    };
  } catch (err) {
    return { toolCallId, success: false, content: `读取文件失败: ${(err as Error).message}`, error: (err as Error).message };
  }
}

/**
 * write_file 执行器 — 写入本地文件
 */
async function executeWriteFile(params: any, context: any): Promise<ToolResult> {
  const { path: filePath, content } = params;
  const toolCallId = context?.toolCallId || 'builtin';

  if (!filePath || content === undefined) {
    return { toolCallId, success: false, content: '缺少文件路径 (path) 或内容 (content)', error: 'missing_params' };
  }

  try {
    const workDir = context?.workDir || process.cwd();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(workDir, filePath);

    // 安全检查：不允许写入工作目录之外的文件
    if (workDir && !resolvedPath.startsWith(path.resolve(workDir))) {
      return { toolCallId, success: false, content: `文件路径超出工作目录范围: ${filePath}`, error: 'path_outside_workdir' };
    }

    // 确保目录存在
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(resolvedPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf-8');
    const stat = fs.statSync(resolvedPath);

    logger.info(`文件已写入: ${resolvedPath} (${(stat.size / 1024).toFixed(1)}KB)`);

    return {
      toolCallId,
      success: true,
      content: `文件已保存: ${filePath} (${(stat.size / 1024).toFixed(1)}KB)`,
    };
  } catch (err) {
    return { toolCallId, success: false, content: `写入文件失败: ${(err as Error).message}`, error: (err as Error).message };
  }
}

/**
 * 创建内置工具注册表（带执行器）
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  const builtinTools: ToolDefinition[] = [
    // === read_only 级别 ===
    {
      name: 'llm_query',
      description: '调用 LLM 生成文本回复',
      requiredLevel: 'read_only',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '要发送给 LLM 的提示',
          },
        },
        required: ['prompt'],
      },
    },

    // === limited 级别 ===
    {
      name: 'web_search',
      description: '搜索网络信息并返回摘要。使用 DuckDuckGo 搜索引擎，输入关键词返回相关网页标题、链接和摘要。',
      requiredLevel: 'limited',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词',
          },
          maxResults: {
            type: 'number',
            description: '最大返回结果数（默认 5）',
          },
        },
        required: ['query'],
      },
      executor: executeWebSearch as ToolExecutorFn,
    },
    {
      name: 'read_file',
      description: '读取工作目录下的文件内容。支持文本文件，最大 1MB。',
      requiredLevel: 'limited',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对于工作目录）',
          },
        },
        required: ['path'],
      },
      executor: executeReadFile as ToolExecutorFn,
    },

    // === standard 级别 ===
    {
      name: 'write_file',
      description: '将内容写入文件。会自动创建必要的目录。文件保存在工作目录下。',
      requiredLevel: 'standard',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对于工作目录）',
          },
          content: {
            type: 'string',
            description: '要写入的内容',
          },
        },
        required: ['path', 'content'],
      },
      executor: executeWriteFile as ToolExecutorFn,
    },
    {
      name: 'image_generate',
      description: '使用 AI 生成图片',
      requiredLevel: 'standard',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '图片描述提示词',
          },
          size: {
            type: 'string',
            enum: ['256x256', '512x512', '1024x1024'],
            description: '图片尺寸',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'data_analyze',
      description: '分析数据并生成报告',
      requiredLevel: 'standard',
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'string',
            description: '数据内容（CSV、JSON 等）',
          },
          analysis_type: {
            type: 'string',
            enum: ['summary', 'trend', 'comparison'],
            description: '分析类型',
          },
        },
        required: ['data'],
      },
    },

    // === elevated 级别 ===
    {
      name: 'run_code',
      description: '执行代码（JavaScript/Python）',
      requiredLevel: 'elevated',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '要执行的代码',
          },
          language: {
            type: 'string',
            enum: ['javascript', 'python'],
            description: '编程语言',
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒）',
          },
        },
        required: ['code', 'language'],
      },
    },
    {
      name: 'system_command',
      description: '执行系统命令（受限沙箱）',
      requiredLevel: 'elevated',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的命令',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '命令参数',
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒）',
          },
        },
        required: ['command'],
      },
    },
  ];

  for (const tool of builtinTools) {
    registry.register(tool);
  }

  // 注册 OpenCLI 公共 API 工具（debug-only 模式）
  // 阶段三：平台中心化架构，直连工具仅作为调试备用
  // 正式使用应通过 web_cli 工具走平台代理
  const openCliDebugMode = process.env.WORKERCLAW_DEBUG_TOOLS === 'true'
    || process.env.OPENCLI_DIRECT === 'true';
  if (openCliDebugMode) {
    const openCliTools = getOpenCliToolDefinitions();
    for (const tool of openCliTools) {
      registry.register(tool);
    }
    logger.info(`已注册 ${openCliTools.length} 个 OpenCLI 直连工具 (debug-only, WORKERCLAW_DEBUG_TOOLS=true)`);
  } else {
    logger.info('OpenCLI 直连工具已跳过 (debug-only)。请使用 web_cli 工具通过平台代理调用。设置 WORKERCLAW_DEBUG_TOOLS=true 可启用直连模式。');
  }

  // 注册 web_cli 通用代理工具
  const webCliTool = getWebCliToolDefinition();
  registry.register(webCliTool);
  logger.info('已注册 web_cli 通用代理工具');

  // 注册 web_cli_describe 命令发现工具
  const webCliDescribeTool = getWebCliDescribeToolDefinition();
  registry.register(webCliDescribeTool);
  logger.info('已注册 web_cli_describe 命令发现工具');

  return registry;
}
