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
 * web_search 执行器 — 使用 DuckDuckGo Lite 搜索
 */
async function executeWebSearch(params: any, context: any): Promise<ToolResult> {
  const { query, maxResults = 5 } = params;
  const toolCallId = context?.toolCallId || 'builtin';

  if (!query || typeof query !== 'string') {
    return { toolCallId, success: false, content: '缺少搜索关键词 (query)', error: 'missing_query' };
  }

  try {
    // 使用 DuckDuckGo Lite HTML 版本（免费，无需 API key）
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WorkerClaw/0.12)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(Math.min(context?.remainingMs || 30000, 30000)),
    });

    if (!response.ok) {
      return { toolCallId, success: false, content: `搜索请求失败: HTTP ${response.status}`, error: 'http_error' };
    }

    const html = await response.text();

    // 解析 DuckDuckGo Lite HTML 结果
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const trRegex = /<tr[^>]*class="result-link"[^>]*>[\s\S]*?<\/tr>/gi;
    let match: RegExpExecArray | null;

    while ((match = trRegex.exec(html)) !== null && results.length < maxResults) {
      const tr = match[0];

      // 提取链接
      const hrefMatch = tr.match(/href="([^"]+)"/);
      // 提取标题
      const titleMatch = tr.match(/class="result-link"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
      // 提取摘要
      const snippetMatch = tr.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i);

      if (hrefMatch && titleMatch) {
        // DuckDuckGo Lite 的链接是跳转链接，提取实际 URL
        const actualUrl = hrefMatch[1].replace(/^\/l\//, '').replace(/uddg=/, '');
        results.push({
          title: titleMatch[1].replace(/<[^>]*>/g, '').trim(),
          url: decodeURIComponent(actualUrl.split('&').find(p => p.startsWith('uddg='))?.slice(5) || hrefMatch[1]),
          snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '',
        });
      }
    }

    if (results.length === 0) {
      // 备用解析：尝试更宽松的正则
      const linkRegex = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch: RegExpExecArray | null;
      while ((linkMatch = linkRegex.exec(html)) !== null && results.length < maxResults) {
        const linkHref = linkMatch[1];
        const linkText = linkMatch[2].replace(/<[^>]*>/g, '').trim();
        if (linkText && linkHref) {
          results.push({
            title: linkText,
            url: linkHref.startsWith('http') ? linkHref : `https://duckduckgo.com${linkHref}`,
            snippet: '',
          });
        }
      }
    }

    if (results.length === 0) {
      return {
        toolCallId,
        success: true,
        content: `搜索 "${query}" 未找到直接结果。搜索服务可能暂时不可用，请尝试使用浏览器工具直接访问搜索引擎。`,
      };
    }

    const formatted = results.map((r, i) =>
      `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet ? `摘要: ${r.snippet}\n` : ''}`
    ).join('\n');

    return {
      toolCallId,
      success: true,
      content: `搜索 "${query}" 的结果（共 ${results.length} 条）：\n\n${formatted}`,
    };
  } catch (err) {
    const error = err as Error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return { toolCallId, success: false, content: `搜索超时: ${query}`, error: 'timeout' };
    }
    return { toolCallId, success: false, content: `搜索出错: ${error.message}`, error: error.message };
  }
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

  return registry;
}
