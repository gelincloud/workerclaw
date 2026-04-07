/**
 * Web CLI 工具 - 双模式版本
 * 
 * 支持：
 * 1. platform 模式 - 调用智工坊平台 API（云端 Agent）
 * 2. local 模式 - 通过本地 Browser Bridge 操作本机 Chrome
 * 
 * 配置方式：
 * ```typescript
 * config.webCli = {
 *   mode: 'local',  // 或 'platform'
 *   local: { port: 19825 }
 * }
 * ```
 */

import { createLogger } from '../core/logger.js';
import type { ToolDefinition, ToolExecutorFn, ToolResult, PermissionLevel } from '../types/agent.js';
import { BrowserBridgeClient } from '../browser/bridge.js';
import type { WebCliConfig } from '../core/config.js';

const logger = createLogger('WebCli');

// ==================== 工具定义 ====================

/**
 * 获取 web_cli 工具定义（支持双模式）
 */
export function getWebCliToolDefinition(config?: WebCliConfig): ToolDefinition {
  const mode = config?.mode || 'platform';
  const platformUrl = config?.platformUrl || 'https://www.miniabc.top';

  const executor: ToolExecutorFn = async (params, context) => {
    const toolCallId = (context as any)?.toolCallId || 'web_cli';

    if (mode === 'local') {
      return await executeLocalMode(params, config?.local, toolCallId, context);
    } else {
      return await executePlatformMode(params, platformUrl, toolCallId, context);
    }
  };

  return {
    name: 'web_cli',
    description: `通过 Web CLI 获取互联网数据或执行浏览器操作。
当前模式: ${mode === 'local' ? '本地 Browser Bridge（直接操作本机 Chrome）' : '平台代理（调用智工坊 API）'}

${mode === 'local' ? `
**本地模式特性**：
- 直接使用本机 Chrome 浏览器的登录态，无需同步到平台
- 实时获取，登录态变化立即可见
- 适合敏感操作、本地开发、无外网环境
- 需要先启动本地 Daemon: workerclaw daemon
` : `
**平台模式特性**：
- 通过平台代理调用，支持云端 Agent
- 需要预先通过 Chrome 扩展同步登录态
- 支持三种策略：fetch（公开API）、browser（网页渲染）、auth（带登录态）
`}

可用命令格式: site/command，如 hackernews/top, weibo/hot_search, weibo/search, browser/fetch 等。
使用 web_cli_describe 工具查看完整命令列表。

参数: site (必填), command (必填), query (搜索关键词), limit (返回条数)`,
    requiredLevel: 'limited',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: '网站/引擎名称' },
        command: { type: 'string', description: '命令名称' },
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '返回条数' },
      },
      required: ['site', 'command'],
    },
    executor,
  };
}

/**
 * 本地模式执行
 */
async function executeLocalMode(
  params: Record<string, any>,
  localConfig: WebCliConfig['local'],
  toolCallId: string,
  context: any
): Promise<ToolResult> {
  const { site, command, query, limit, ...extra } = params;

  if (!site || !command) {
    return { 
      toolCallId, 
      success: false, 
      content: '缺少参数: site 和 command 是必填项', 
      error: 'missing_params' 
    };
  }

  const client = new BrowserBridgeClient(localConfig);

  try {
    // 检查 Daemon 是否运行
    if (!await client.isDaemonRunning()) {
      return {
        toolCallId,
        success: false,
        content: '本地 Daemon 未运行。请先执行: workerclaw daemon',
        error: 'daemon_not_running',
      };
    }

    // 检查扩展是否连接
    if (!await client.isExtensionConnected()) {
      return {
        toolCallId,
        success: false,
        content: 'Chrome 扩展未连接。请确保已安装并启用智工坊扩展。',
        error: 'extension_not_connected',
      };
    }

    // 根据命令类型分发
    const workspace = `wc_${Date.now()}`;

    if (site === 'browser') {
      // 浏览器操作
      return await handleBrowserCommand(client, command, params, workspace, toolCallId);
    } else if (site === 'cookies') {
      // Cookie 操作
      return await handleCookiesCommand(client, command, params, toolCallId);
    } else {
      // 其他站点：尝试获取 Cookie 或执行公开 API
      return {
        toolCallId,
        success: false,
        content: `本地模式暂不支持 ${site}/${command}。请使用平台模式或 browser 命令。`,
        error: 'unsupported_command',
      };
    }

  } catch (err) {
    logger.error(`本地模式执行失败: ${site}/${command}`, { error: (err as Error).message });
    return {
      toolCallId,
      success: false,
      content: `本地模式执行失败: ${(err as Error).message}`,
      error: (err as Error).message,
    };
  }
}

/**
 * 处理浏览器命令
 */
async function handleBrowserCommand(
  client: BrowserBridgeClient,
  command: string,
  params: Record<string, any>,
  workspace: string,
  toolCallId: string
): Promise<ToolResult> {
  try {
    switch (command) {
      case 'fetch':
      case 'navigate': {
        const url = params.url || params.query;
        if (!url) {
          return { toolCallId, success: false, content: '缺少参数: url', error: 'missing_url' };
        }
        const result = await client.navigate(url, { workspace });
        return {
          toolCallId,
          success: true,
          content: `导航成功: ${result.title}\nURL: ${result.url}`,
        };
      }

      case 'exec':
      case 'evaluate': {
        const code = params.code || params.query;
        if (!code) {
          return { toolCallId, success: false, content: '缺少参数: code', error: 'missing_code' };
        }
        const result = await client.exec(code, { workspace });
        return {
          toolCallId,
          success: true,
          content: `执行结果: ${JSON.stringify(result, null, 2)}`,
        };
      }

      case 'screenshot': {
        const base64 = await client.screenshot({
          workspace,
          format: params.format,
          fullPage: params.fullPage,
        });
        return {
          toolCallId,
          success: true,
          content: `截图成功 (base64, ${base64.length} 字符)\n\n${base64}`,
        };
      }

      case 'tabs': {
        const tabs = await client.tabs('list', workspace);
        const formatted = tabs.map((t, i) =>
          `[${i + 1}] ${t.title}\n   URL: ${t.url}`
        ).join('\n');
        return {
          toolCallId,
          success: true,
          content: `标签页列表 (${tabs.length}个):\n${formatted}`,
        };
      }

      default:
        return {
          toolCallId,
          success: false,
          content: `未知的浏览器命令: ${command}`,
          error: 'unknown_command',
        };
    }
  } finally {
    // 清理：关闭自动化窗口
    try {
      await client.closeWindow(workspace);
    } catch {}
  }
}

/**
 * 处理 Cookie 命令
 */
async function handleCookiesCommand(
  client: BrowserBridgeClient,
  command: string,
  params: Record<string, any>,
  toolCallId: string
): Promise<ToolResult> {
  if (command === 'get') {
    const domain = params.domain;
    const url = params.url;

    if (!domain && !url) {
      return {
        toolCallId,
        success: false,
        content: '缺少参数: domain 或 url',
        error: 'missing_domain',
      };
    }

    const cookies = await client.getCookies({ domain, url });
    const formatted = cookies.map(c =>
      `${c.name}=${c.value.slice(0, 20)}... (domain: ${c.domain})`
    ).join('\n');

    return {
      toolCallId,
      success: true,
      content: `Cookie 列表 (${cookies.length}个):\n${formatted}\n\n完整数据: ${JSON.stringify(cookies, null, 2)}`,
    };
  }

  return {
    toolCallId,
    success: false,
    content: `未知的 Cookie 命令: ${command}`,
    error: 'unknown_command',
  };
}

/**
 * 平台模式执行
 */
async function executePlatformMode(
  params: Record<string, any>,
  platformUrl: string,
  toolCallId: string,
  context: any
): Promise<ToolResult> {
  const { site, command, query, limit, sort, taskId, dryRun, ...extra } = params;

  if (!site || !command) {
    return {
      toolCallId,
      success: false,
      content: '缺少参数: site 和 command 是必填项。先调用 web_cli_describe 查看可用命令。',
      error: 'missing_params',
    };
  }

  // 构建 args 对象
  const args: Record<string, any> = {};
  if (query) args.q = query;
  if (limit) args.limit = limit;
  if (sort) args.sort = sort;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) args[key] = value;
  }

  try {
    // 优先尝试 POST /api/cli/execute
    const executeUrl = `${platformUrl}/api/cli/execute`;
    const body: Record<string, any> = { site, command, args };
    if (taskId) body.taskId = taskId;
    if (dryRun) body.dryRun = true;

    const headers: Record<string, string> = {
      'User-Agent': 'WorkerClaw/1.0',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    const botId = context?.botId;
    if (botId) headers['X-Bot-Id'] = botId;

    const ownerId = context?.ownerId;
    if (ownerId) body.ownerId = ownerId;

    const timeoutMs = Math.min(context?.remainingMs || 30000, 30000);

    const response = await fetch(executeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok && response.status === 405) {
      return await fallbackGetRequest(platformUrl, site, command, args, toolCallId, timeoutMs, headers);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      try {
        const errorResult = JSON.parse(errorText) as { error?: string };
        if (errorResult.error) {
          return { toolCallId, success: false, content: errorResult.error, error: errorResult.error };
        }
      } catch {}
      return {
        toolCallId,
        success: false,
        content: `API 请求失败: HTTP ${response.status} ${errorText}`,
        error: `http_${response.status}`,
      };
    }

    const result = await response.json() as {
      success: boolean;
      data: any;
      error?: string;
      duration_ms?: number;
      strategy?: string;
      _fromCache?: boolean;
    };

    if (!result.success) {
      return {
        toolCallId,
        success: false,
        content: result.error || 'API 执行失败',
        error: result.error,
      };
    }

    return {
      toolCallId,
      success: true,
      content: formatCliResult(site, command, result.data, result.duration_ms, result.strategy, result._fromCache),
    };

  } catch (err) {
    logger.error(`平台模式执行失败: ${site}/${command}`, { error: (err as Error).message });
    return {
      toolCallId,
      success: false,
      content: `平台模式执行失败: ${(err as Error).message}`,
      error: (err as Error).message,
    };
  }
}

/**
 * GET 兼容回退
 */
async function fallbackGetRequest(
  baseUrl: string,
  site: string,
  command: string,
  args: Record<string, any>,
  toolCallId: string,
  timeoutMs: number,
  headers: Record<string, string>
): Promise<ToolResult> {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null) searchParams.set(key, String(value));
  }

  const apiUrl = `${baseUrl}/api/cli/${encodeURIComponent(site)}/${encodeURIComponent(command)}?${searchParams.toString()}`;
  const response = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return {
      toolCallId,
      success: false,
      content: `API 请求失败: HTTP ${response.status} ${errorText}`,
      error: `http_${response.status}`,
    };
  }

  const result = await response.json() as { success: boolean; data: any; error?: string; duration_ms?: number };

  if (!result.success) {
    return {
      toolCallId,
      success: false,
      content: result.error || 'API 返回空数据',
      error: result.error,
    };
  }

  return {
    toolCallId,
    success: true,
    content: formatCliResult(site, command, result.data, result.duration_ms),
  };
}

/**
 * 格式化 CLI 结果
 */
function formatCliResult(
  site: string,
  command: string,
  data: any,
  duration_ms?: number,
  strategy?: string,
  fromCache?: boolean
): string {
  const cacheTag = fromCache ? ' [缓存]' : '';
  const strategyTag = strategy ? ` [${strategy}]` : '';

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return `${site}/${command}: 暂无数据${strategyTag}${cacheTag}`;
    }
    const items = data.map((item, i) => {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(item)) {
        if (v === undefined || v === null || v === '') continue;
        if (k === 'url') continue;
        parts.push(`${k}: ${v}`);
      }
      const url = item.url ? `\n   链接: ${item.url}` : '';
      return `[${i + 1}] ${parts.join(' | ')}${url}`;
    });
    return `${site}/${command} (${data.length}条, ${duration_ms || 0}ms${strategyTag}${cacheTag}):\n\n${items.join('\n')}`;
  } else if (typeof data === 'object' && data !== null) {
    const lines = Object.entries(data)
      .filter(([k, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 500) : JSON.stringify(v)}`);
    return `${site}/${command}${strategyTag}${cacheTag}:\n\n${lines.join('\n')}`;
  } else {
    return `${site}/${command}: ${data}`;
  }
}
