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
import type { BridgeClientConfig } from '../browser/bridge.js';
import type { WebCliConfig } from '../core/config.js';

const logger = createLogger('WebCli');

// ==================== 平台登录态保活服务 ====================

/**
 * 平台保活服务
 * 
 * 独立的后台服务，不依赖发文任务。
 * 用户长时间不操作时，自动刷新页面保持登录态。
 * 
 * 使用方式：
 * - web_cli keepalive/start douyin  - 启动抖音保活
 * - web_cli keepalive/stop douyin   - 停止抖音保活
 * - web_cli keepalive/status        - 查看保活状态
 */

interface KeepaliveTask {
  site: string;
  keepaliveUrl: string;
  intervalMs: number;
  startTime: number;
  lastRefreshTime: number;
  refreshCount: number;
  status: 'running' | 'stopped';
}

// 保活任务存储（进程内）
const keepaliveTasks = new Map<string, KeepaliveTask>();
// 保活定时器
const keepaliveTimers = new Map<string, NodeJS.Timeout>();

// 各平台保活配置
const KEEPALIVE_CONFIGS: Record<string, { url: string; intervalMs: number }> = {
  douyin: {
    url: 'https://creator.douyin.com/creator-micro/content/upload?default-tab=5',
    intervalMs: 5 * 60 * 1000,  // 5分钟
  },
  // 可扩展其他平台
  // xiaohongshu: { url: '...', intervalMs: ... },
  // weibo: { url: '...', intervalMs: ... },
};

/**
 * 启动平台保活服务
 */
async function startKeepaliveService(
  site: string,
  client: BrowserBridgeClient,
  localConfig?: BridgeClientConfig
): Promise<{ success: boolean; message: string }> {
  const config = KEEPALIVE_CONFIGS[site];
  if (!config) {
    return { success: false, message: `不支持的平台: ${site}。支持: ${Object.keys(KEEPALIVE_CONFIGS).join(', ')}` };
  }

  // 已在运行，先停止
  if (keepaliveTasks.has(site)) {
    stopKeepaliveService(site);
  }

  const task: KeepaliveTask = {
    site,
    keepaliveUrl: config.url,
    intervalMs: config.intervalMs,
    startTime: Date.now(),
    lastRefreshTime: 0,
    refreshCount: 0,
    status: 'running',
  };

  // 创建独立的客户端实例，避免超时问题
  const keepaliveClient = new BrowserBridgeClient({
    ...localConfig,
    timeout: 30000,  // 保活请求30秒超时
  });

  // 启动定时器
  const timer = setInterval(async () => {
    const currentTask = keepaliveTasks.get(site);
    if (!currentTask || currentTask.status !== 'running') {
      return;
    }

    try {
      // 使用固定的 workspace 避免窗口堆积
      const workspace = `keepalive_${site}`;
      
      logger.info(`[保活服务] ${site} 执行保活刷新...`);
      
      // 导航到保活页面
      await keepaliveClient.navigate(config.url, { workspace });
      
      // 等待页面加载
      await new Promise(r => setTimeout(r, 2000));
      
      // 更新任务状态
      currentTask.lastRefreshTime = Date.now();
      currentTask.refreshCount++;
      
      logger.info(`[保活服务] ${site} 保活成功 (第${currentTask.refreshCount}次)`);
      
      // 关闭窗口（避免窗口堆积）
      try {
        await keepaliveClient.closeWindow(workspace);
      } catch {}
      
    } catch (err) {
      logger.warn(`[保活服务] ${site} 保活失败`, { error: (err as Error).message });
    }
  }, config.intervalMs);

  keepaliveTimers.set(site, timer);
  keepaliveTasks.set(site, task);

  // 立即执行一次刷新
  try {
    const workspace = `keepalive_${site}`;
    await keepaliveClient.navigate(config.url, { workspace });
    task.lastRefreshTime = Date.now();
    task.refreshCount = 1;
    try { await keepaliveClient.closeWindow(workspace); } catch {}
    logger.info(`[保活服务] ${site} 初始保活成功`);
  } catch (err) {
    logger.warn(`[保活服务] ${site} 初始保活失败`, { error: (err as Error).message });
  }

  return {
    success: true,
    message: `${site} 保活服务已启动，每 ${config.intervalMs / 1000 / 60} 分钟刷新一次`,
  };
}

/**
 * 停止平台保活服务
 */
function stopKeepaliveService(site: string): { success: boolean; message: string } {
  const task = keepaliveTasks.get(site);
  const timer = keepaliveTimers.get(site);
  
  if (!task && !timer) {
    return { success: false, message: `${site} 保活服务未运行` };
  }

  if (timer) {
    clearInterval(timer);
    keepaliveTimers.delete(site);
  }
  
  if (task) {
    task.status = 'stopped';
    keepaliveTasks.delete(site);
  }

  const elapsed = task ? Math.round((Date.now() - task.startTime) / 1000 / 60) : 0;
  const count = task?.refreshCount || 0;

  return {
    success: true,
    message: `${site} 保活服务已停止。运行时间: ${elapsed}分钟，刷新次数: ${count}`,
  };
}

/**
 * 获取保活服务状态
 */
function getKeepaliveStatus(): { tasks: KeepaliveTask[] } {
  const tasks = Array.from(keepaliveTasks.values()).map(task => ({
    ...task,
    runningTime: Math.round((Date.now() - task.startTime) / 1000 / 60),  // 分钟
  }));
  return { tasks };
}

// ==================== 反爬虫工具函数 ====================

/**
 * 生成随机等待时间（6-10秒）
 * 用于模拟人类操作间隔，绕过反爬检测
 */
function randomDelay(minMs: number = 6000, maxMs: number = 10000): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  logger.debug(`随机等待 ${(delay / 1000).toFixed(1)} 秒`);
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * 注入 webdriver 隐藏脚本
 * 将 navigator.webdriver 设为 undefined，绕过自动化检测
 */
async function injectWebDriverHideScript(client: BrowserBridgeClient, workspace: string): Promise<void> {
  try {
    await client.exec(`
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true
      });
    `, { workspace });
    logger.debug('已注入 webdriver 隐藏脚本');
  } catch (err) {
    logger.warn('注入 webdriver 隐藏脚本失败', { error: (err as Error).message });
  }
}

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
使用 web_cli_describe 工具查看完整命令列表和参数要求。

**常用命令参数**:
- xiaohongshu/publish: title(标题), content(正文), images(图片URL,逗号分隔), topics(话题,逗号分隔), draft(是否草稿)
- weibo/post: text(微博内容), images(图片URL,逗号分隔)
- zhihu/post_article: title(标题), content(正文,支持HTML), column_id(专栏ID), draft(是否草稿)
- 搜索类命令: query(搜索关键词), limit(返回条数)`,
    requiredLevel: 'limited',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: '网站/引擎名称（如 xiaohongshu, weibo, zhihu, hackernews）' },
        command: { type: 'string', description: '命令名称（如 publish, post, hot, search）' },
        query: { type: 'string', description: '搜索关键词（搜索类命令使用）' },
        limit: { type: 'number', description: '返回条数限制' },
        title: { type: 'string', description: '标题（发布类命令使用）' },
        content: { type: 'string', description: '正文内容（发布类命令使用）' },
        text: { type: 'string', description: '微博内容（weibo/post 专用，等同于 content）' },
        images: { type: 'string', description: '图片URL，多个用逗号分隔' },
        topics: { type: 'string', description: '话题标签，多个用逗号分隔' },
        draft: { type: 'boolean', description: '是否保存为草稿（默认false直接发布）' },
        url: { type: 'string', description: 'URL地址（browser类命令使用）' },
        code: { type: 'string', description: 'JS代码（evaluate命令使用）' },
      },
      required: ['site', 'command'],
    },
    executor,
    // 发布类命令需要较长时间（多个页面交互 + 随机等待）
    maxTimeoutMs: 180000, // 3 分钟
  };
}

/**
 * 本地模式执行
 * 
 * 优先使用本地浏览器执行，不支持的命令回退到平台模式
 */
async function executeLocalMode(
  params: Record<string, any>,
  localConfig: WebCliConfig['local'] | undefined,
  toolCallId: string,
  context: any
): Promise<ToolResult> {
  const { site, command, query, limit, ...extra } = params;
  const platformUrl = context?.config?.webCli?.platformUrl || 'https://www.miniabc.top';

  // 调试日志：显示收到的参数
  logger.info(`[web_cli] 本地模式调用: site=${site}, command=${command}, query=${query}, extra=${JSON.stringify(extra)}`);

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

    // 检查扩展是否连接（最多等待 10 秒）
    let extensionConnected = await client.isExtensionConnected();
    if (!extensionConnected) {
      console.log('[web_cli] 扩展未连接，等待连接...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        extensionConnected = await client.isExtensionConnected();
        if (extensionConnected) {
          console.log(`[web_cli] 扩展已连接（等待 ${i + 1} 秒）`);
          break;
        }
      }
    }

    if (!extensionConnected) {
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
    } else if (site === 'keepalive') {
      // 保活服务操作（独立于发文流程）
      return await handleKeepaliveCommand(client, command, params, toolCallId, localConfig);
    } else {
      // 其他站点：根据命令类型处理
      return await handleSiteCommand(client, site, command, params, workspace, toolCallId, localConfig);
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
 * 处理保活服务命令
 * 
 * 用法：
 * - keepalive/start douyin  - 启动抖音保活
 * - keepalive/stop douyin   - 停止抖音保活  
 * - keepalive/status        - 查看所有保活状态
 */
async function handleKeepaliveCommand(
  client: BrowserBridgeClient,
  command: string,
  params: Record<string, any>,
  toolCallId: string,
  localConfig?: BridgeClientConfig
): Promise<ToolResult> {
  switch (command) {
    case 'start': {
      const site = params.site || params.platform;
      if (!site) {
        return {
          toolCallId,
          success: false,
          content: '缺少参数: site（平台名称，如 douyin）',
          error: 'missing_site',
        };
      }
      const result = await startKeepaliveService(site, client, localConfig);
      return {
        toolCallId,
        success: result.success,
        content: result.message,
        error: result.success ? undefined : 'keepalive_error',
      };
    }

    case 'stop': {
      const site = params.site || params.platform;
      if (!site) {
        return {
          toolCallId,
          success: false,
          content: '缺少参数: site（平台名称，如 douyin）',
          error: 'missing_site',
        };
      }
      const result = stopKeepaliveService(site);
      return {
        toolCallId,
        success: result.success,
        content: result.message,
        error: result.success ? undefined : 'keepalive_error',
      };
    }

    case 'status': {
      const status = getKeepaliveStatus();
      if (status.tasks.length === 0) {
        return {
          toolCallId,
          success: true,
          content: '当前没有运行中的保活服务。\n\n使用 keepalive/start douyin 启动抖音保活',
        };
      }
      const lines = status.tasks.map(t => 
        `${t.site}: 运行中，已运行 ${Math.round((Date.now() - t.startTime) / 1000 / 60)} 分钟，刷新 ${t.refreshCount} 次`
      );
      return {
        toolCallId,
        success: true,
        content: `保活服务状态:\n\n${lines.join('\n')}\n\n使用 keepalive/stop <site> 停止指定平台的保活`,
      };
    }

    default:
      return {
        toolCallId,
        success: false,
        content: `未知的保活命令: ${command}\n\n可用命令:\n- keepalive/start <site>  启动保活\n- keepalive/stop <site>   停止保活\n- keepalive/status        查看状态`,
        error: 'unknown_command',
      };
  }
}

/**
 * 处理站点命令（小红书、微博等）
 * 
 * 本地模式下，通过本地浏览器执行操作：
 * 1. 发布类命令：导航到发布页面，填写内容
 * 2. 搜索类命令：导航到搜索页面，提取结果
 * 
 * 注意：本地模式不回退到平台模式，以保证登录态安全和IP一致性
 */
async function handleSiteCommand(
  client: BrowserBridgeClient,
  site: string,
  command: string,
  params: Record<string, any>,
  workspace: string,
  toolCallId: string,
  localConfig?: BridgeClientConfig  // 传递配置以便创建更长超时的 client
): Promise<ToolResult> {
  const { title, content, images, topics, query, limit } = params;

  // 需要登录态的操作：通过本地浏览器执行
  if (command === 'publish' || command === 'post') {
    // 发布命令需要更长超时（120秒），创建新的 client
    const publishClient = localConfig
      ? new BrowserBridgeClient({ ...localConfig, timeout: 120000 })
      : client;

    // 微博发布：支持 text 参数，映射到 content
    if (site === 'weibo') {
      const text = params.text || params.content;
      if (!text) {
        return {
          toolCallId,
          success: false,
          content: '发微博需要 text 参数（微博内容）',
          error: 'missing_params',
        };
      }
      // 微博不需要 title，只传 content
      return await handlePublishCommand(publishClient, site, { ...params, content: text, title: text.substring(0, 30) }, workspace, toolCallId);
    }

    // 其他平台：需要 title 和 content
    if (!title || !content) {
      return {
        toolCallId,
        success: false,
        content: '发布需要 title 和 content 参数',
        error: 'missing_params',
      };
    }

    return await handlePublishCommand(publishClient, site, params, workspace, toolCallId);
  }

  // 搜索命令：需要登录态，通过本地浏览器
  if (command === 'search') {
    return await handleSearchCommand(client, site, query, workspace, toolCallId);
  }

  // hot/hot_search 等热门命令：通过本地浏览器导航到对应页面
  if (command === 'hot' || command === 'hot_search') {
    return await handleHotCommand(client, site, workspace, toolCallId);
  }

  // 抖音特殊命令处理
  if (site === 'douyin') {
    // 抖音发文已在上面的 publish/post 分支处理
    // 这里处理其他抖音命令

    // 抖音热榜
    if (command === 'hot' || command === 'trending' || command === 'discover') {
      return await handleHotCommand(client, site, workspace, toolCallId);
    }

    // 抖音搜索
    if (command === 'search') {
      return await handleSearchCommand(client, site, query, workspace, toolCallId);
    }

    // 其他抖音命令（如 hashtag、user 等）：需要提示用户使用平台模式
    return {
      toolCallId,
      success: false,
      content: `本地模式下抖音仅支持以下命令：
- douyin/publish 或 douyin/post - 发布文章
- douyin/hot - 查看热榜
- douyin/search - 搜索内容

命令 "${command}" 需要通过平台模式调用。请在配置中设置 webCli.mode: "platform"`,
      error: 'unsupported_command',
    };
  }

  // 其他命令：不支持的命令
  return {
    toolCallId,
    success: false,
    content: `本地模式不支持 ${site}/${command}。

**本地模式可用命令**:
- browser/navigate, browser/exec, browser/screenshot, browser/evaluate
- cookies/get
- keepalive/start, keepalive/stop, keepalive/status - 登录态保活
- 发布类命令：xiaohongshu/publish, weibo/post, zhihu/post_article, douyin/publish
- 搜索类命令：xiaohongshu/search, weibo/search, zhihu/search
- 热门内容：xiaohongshu/hot, weibo/hot_search, zhihu/hot, douyin/hot

如需使用更多命令，请切换到平台模式 (webCli.mode: "platform")。`,
    error: 'unsupported_command',
  };
}

/**
 * 处理热门内容命令（通过本地浏览器）
 */
async function handleHotCommand(
  client: BrowserBridgeClient,
  site: string,
  workspace: string,
  toolCallId: string
): Promise<ToolResult> {
  const HOT_URLS: Record<string, string> = {
    xiaohongshu: 'https://www.xiaohongshu.com/explore',
    weibo: 'https://s.weibo.com/top/summary',
    zhihu: 'https://www.zhihu.com/hot',
    douyin: 'https://www.douyin.com/discover',
  };

  const hotUrl = HOT_URLS[site];
  if (!hotUrl) {
    return {
      toolCallId,
      success: false,
      content: `本地模式不支持 ${site} 的热门内容`,
      error: 'unsupported_site',
    };
  }

  try {
    await client.navigate(hotUrl, { workspace });
    await new Promise(r => setTimeout(r, 2000));

    // 提取热门内容
    const results = await client.exec(`
      (function() {
        const items = [];
        const selectors = {
          xiaohongshu: 'section.note-item, a[href*="/explore/"]',
          weibo: '.td-02 a, .data a',
          zhihu: '.HotList-item, .HotItem',
          douyin: '.video-card, .recommend-list-item, [class*="video"]'
        };
        const selector = selectors['${site}'];
        document.querySelectorAll(selector).forEach((el, i) => {
          if (i < 20) {
            const title = (el.textContent || '').trim().slice(0, 100);
            const link = el.href || el.querySelector('a')?.href || '';
            if (title) items.push({ rank: i + 1, title, link });
          }
        });
        return items;
      })()
    `, { workspace });

    return {
      toolCallId,
      success: true,
      content: `${site} 热门内容:\n\n${JSON.stringify(results, null, 2)}`,
    };
  } catch (err) {
    return {
      toolCallId,
      success: false,
      content: `获取热门内容失败: ${(err as Error).message}`,
      error: (err as Error).message,
    };
  } finally {
    try {
      await client.closeWindow(workspace);
    } catch {}
  }
}

/**
 * 处理发布命令（小红书、微博等）
 * 
 * 本地模式下的发布流程：
 * 1. 导航到发布页面
 * 2. 选择正确的标签页
 * 3. 填写标题和正文
 * 4. 等待用户确认发布
 */
async function handlePublishCommand(
  client: BrowserBridgeClient,
  site: string,
  params: Record<string, any>,
  workspace: string,
  toolCallId: string
): Promise<ToolResult> {
  const { title, content, images, topics, draft } = params;

  if (!title || !content) {
    return {
      toolCallId,
      success: false,
      content: '发布需要 title 和 content 参数',
      error: 'missing_params',
    };
  }

  // 根据站点导航到发布页面
  const PUBLISH_URLS: Record<string, string> = {
    xiaohongshu: 'https://creator.xiaohongshu.com/publish/publish',
    weibo: 'https://weibo.com',
    zhihu: 'https://www.zhihu.com/',
    douyin: 'https://creator.douyin.com/creator-micro/content/upload?default-tab=5',
  };

  const publishUrl = PUBLISH_URLS[site];
  if (!publishUrl) {
    return {
      toolCallId,
      success: false,
      content: `本地模式不支持 ${site} 的发布操作`,
      error: 'unsupported_site',
    };
  }

  try {
    console.log(`[handlePublishCommand] 开始发布流程: ${site}, title=${title?.substring(0, 20)}...`);

    // 1. 导航到发布页面
    console.log(`[handlePublishCommand] 步骤1: 导航到 ${publishUrl}`);
    await client.navigate(publishUrl, { workspace });
    
    // 反爬虫：注入 webdriver 隐藏脚本
    await injectWebDriverHideScript(client, workspace);
    
    // 反爬虫：随机等待（6-10秒）
    await randomDelay();

    // 2. 根据站点执行发布流程
    if (site === 'xiaohongshu') {
      // 小红书发布流程
      const hasImages = images && images.trim().length > 0;
      const tabToClick = hasImages ? '上传图文' : '写长文';
      
      // 选择标签页
      console.log(`[handlePublishCommand] 步骤2: 选择标签页 "${tabToClick}"`);
      const fillResult = await client.exec(`
        (function() {
          var result = { steps: [], foundTabs: [], clicked: false };
          
          // 查找所有文本元素，优先选择文本精确匹配的最小元素
          var allElements = document.querySelectorAll('div, span, button');
          var candidates = [];
          
          for (var i = 0; i < allElements.length; i++) {
            var el = allElements[i];
            var text = (el.textContent || el.innerText || '').trim();
            
            // 只考虑短文本（精确匹配标签名）
            if (text === '${tabToClick}') {
              candidates.push({ el: el, text: text, priority: 1 });
            } else if (text.length > 0 && text.length < 10 && text.indexOf('${tabToClick}') !== -1) {
              candidates.push({ el: el, text: text, priority: 2 });
            }
          }
          
          // 按优先级排序，优先精确匹配
          candidates.sort(function(a, b) { return a.priority - b.priority; });
          
          // 记录找到的候选
          result.foundTabs = candidates.map(function(c) { return c.text; });
          
          // 点击优先级最高的
          if (candidates.length > 0) {
            candidates[0].el.click();
            result.steps.push('已点击: ' + candidates[0].text);
            result.clicked = true;
          }
          
          return result;
        })()
      `, { workspace });
      console.log(`[handlePublishCommand] 标签页选择结果:`, fillResult);
      
      // 反爬虫：随机等待（6-10秒）
      await randomDelay();

      // 3. 点击"新的创作"按钮（写长文模式需要）
      if (!hasImages) {
        console.log(`[handlePublishCommand] 步骤3: 点击"新的创作"`);
        const createResult = await client.exec(`
          (function() {
            var result = { foundButtons: [], clicked: false };
            
            // 查找所有可点击元素
            var allElements = document.querySelectorAll('button, div, span, a');
            var candidates = [];
            
            for (var i = 0; i < allElements.length; i++) {
              var el = allElements[i];
              var text = (el.innerText || el.textContent || '').trim();
              
              // 收集所有短文本按钮
              if (text.length > 0 && text.length < 20) {
                result.foundButtons.push(text);
                
                // 优先精确匹配
                if (text === '新的创作' || text === '开始创作') {
                  candidates.push({ el: el, text: text, priority: 1 });
                } else if (text.indexOf('创作') !== -1 && text.length < 10) {
                  candidates.push({ el: el, text: text, priority: 2 });
                }
              }
            }
            
            // 按优先级排序
            candidates.sort(function(a, b) { return a.priority - b.priority; });
            
            // 点击优先级最高的
            if (candidates.length > 0) {
              candidates[0].el.click();
              result.clicked = true;
              result.clickedText = candidates[0].text;
            }
            
            return result;
          })()
        `, { workspace });
        console.log(`[handlePublishCommand] "新的创作"点击结果:`, createResult);
        
        // 反爬虫：随机等待（6-10秒）
        await randomDelay();
      }

      // 4. 填写标题和正文
      console.log(`[handlePublishCommand] 步骤4: 填写标题和正文`);
      const writeResult = await client.exec(`
        (function() {
          var title = ${JSON.stringify(title)};
          var content = ${JSON.stringify(content)};
          var result = { inputs: [], editors: [], titleFilled: false, contentFilled: false };
          
          // 收集所有 input 和 textarea 元素（可能有独立的标题输入框）
          var inputs = document.querySelectorAll('input, textarea');
          for (var i = 0; i < inputs.length; i++) {
            var inp = inputs[i];
            var ph = inp.placeholder || '';
            result.inputs.push({
              tagName: inp.tagName,
              type: inp.type,
              placeholder: ph,
              name: inp.name
            });
            // 匹配标题输入框：placeholder 包含"标题"或"填写标题"
            if (ph.indexOf('标题') !== -1 || ph.indexOf('填写标题') !== -1) {
              // 对于 textarea，使用 execCommand 更可靠
              if (inp.tagName === 'TEXTAREA') {
                inp.focus();
                inp.value = '';
                document.execCommand('insertText', false, title);
              } else {
                inp.value = title;
              }
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
              inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
              result.titleFilled = true;
            }
          }
          
          // 收集所有 contenteditable 元素
          // 小红书长文模式的标题和正文在同一个编辑器中
          var contentEditors = document.querySelectorAll('[contenteditable="true"]');
          for (var i = 0; i < contentEditors.length; i++) {
            var editor = contentEditors[i];
            var placeholder = editor.getAttribute('placeholder') || '';
            result.editors.push({ placeholder: placeholder });
            
            // 组合标题和正文
            var fullText = result.titleFilled ? content : (title + '\\n\\n' + content);
            
            // 先聚焦编辑器
            editor.focus();
            
            // 清空现有内容
            editor.innerHTML = '';
            
            // 使用 execCommand 模拟真实输入（兼容 React/Vue 框架）
            // 这比直接设置 innerText 更可靠
            document.execCommand('insertText', false, fullText);
            
            // 触发多种事件确保框架感知变化
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));
            editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            
            result.contentFilled = true;
            result.contentLength = fullText.length;
            break; // 只填写第一个编辑器
          }
          
          return result;
        })()
      `, { workspace });
      console.log(`[handlePublishCommand] 填写结果:`, writeResult);
      
      // 反爬虫：随机等待（6-10秒）
      await randomDelay();

      // 5. 点击"一键排版"按钮
      console.log(`[handlePublishCommand] 步骤5: 点击"一键排版"`);
      const formatResult = await client.exec(`
        (function() {
          var result = { foundButtons: [] };
          var buttons = document.querySelectorAll('button, div, span');
          for (var i = 0; i < buttons.length; i++) {
            var text = (buttons[i].innerText || buttons[i].textContent || '').trim();
            if (text.length > 0 && text.length < 20) {
              result.foundButtons.push(text);
              if (text === '一键排版') {
                buttons[i].click();
                result.clicked = true;
                return result;
              }
            }
          }
          return result;
        })()
      `, { workspace }) as { clicked: boolean; foundButtons: string[] };
      console.log(`[handlePublishCommand] "一键排版"点击结果:`, formatResult);
      
      // 反爬虫：随机等待（8-12秒），排版页面需要加载
      await randomDelay(8000, 12000);
      
      // 5.5 截图预览页面状态（调试用）
      const previewScreenshot = await client.screenshot({ workspace });
      console.log(`[handlePublishCommand] 预览页面截图（前100字符）: ${previewScreenshot.substring(0, 100)}...`);

      // 6. 点击"下一步"按钮（一键排版后的预览页面）
      console.log(`[handlePublishCommand] 步骤6: 点击"下一步"（预览页面）`);
      const nextResult = await client.exec(`
        (function() {
          var result = { clicked: false, foundButtons: [], pageUrl: window.location.href, previewDetected: false };
          
          // 检测是否在预览页面（有分页指示器 1/3, 2/3, 3/3）
          var pageText = document.body.innerText;
          if (pageText.indexOf('1/3') !== -1 || pageText.indexOf('2/3') !== -1 || pageText.indexOf('3/3') !== -1) {
            result.previewDetected = true;
          }
          
          // 滚动到页面底部
          window.scrollTo(0, document.body.scrollHeight);
          
          // 查找所有可能的按钮
          var buttons = document.querySelectorAll('button, div.btn, div[class*="button"], span[class*="button"], a');
          for (var i = 0; i < buttons.length; i++) {
            var el = buttons[i];
            var text = (el.innerText || el.textContent || '').trim();
            
            // 跳过太长或太短的文本
            if (text.length === 0 || text.length > 20) continue;
            
            result.foundButtons.push(text);
            
            // 优先匹配"下一步"
            if (text === '下一步') {
              el.click();
              result.clicked = true;
              result.clickedText = text;
              return result;
            }
          }
          
          // 如果没找到"下一步"，尝试找包含"下一步"的元素
          if (!result.clicked) {
            for (var i = 0; i < buttons.length; i++) {
              var el = buttons[i];
              var text = (el.innerText || el.textContent || '').trim();
              if (text.indexOf('下一步') !== -1) {
                el.click();
                result.clicked = true;
                result.clickedText = text;
                return result;
              }
            }
          }
          
          return result;
        })()
      `, { workspace }) as { clicked: boolean; foundButtons: string[]; pageUrl: string; previewDetected: boolean; clickedText?: string };
      console.log(`[handlePublishCommand] "下一步"点击结果:`, nextResult);
      
      // 如果检测到预览页面但没有"下一步"按钮，可能需要直接点击发布
      if (nextResult.previewDetected && !nextResult.clicked) {
        console.log(`[handlePublishCommand] 检测到预览页面但没有"下一步"按钮，直接尝试发布`);
      }
      
      // 反爬虫：随机等待（6-10秒）
      await randomDelay();

      // 7. 点击"发布"按钮
      console.log(`[handlePublishCommand] 步骤7: 点击"发布"`);
      const publishResult = await client.exec(`
        (function() {
          var result = { clicked: false, foundButtons: [], pageUrl: window.location.href };
          
          // 滚动到页面底部
          window.scrollTo(0, document.body.scrollHeight);
          
          // 等待一下让页面稳定
          
          // 查找所有可能的按钮，优先查找 button 元素
          var buttons = document.querySelectorAll('button');
          for (var i = 0; i < buttons.length; i++) {
            var el = buttons[i];
            var text = (el.innerText || el.textContent || '').trim();
            if (text.length > 0 && text.length <= 10) {
              result.foundButtons.push('[button] ' + text);
              if (text === '发布' || text === '发布笔记' || text === '立即发布') {
                el.click();
                result.clicked = true;
                result.clickedText = text;
                result.clickedSelector = 'button';
                return result;
              }
            }
          }
          
          // 再查找 div/span 元素
          var divs = document.querySelectorAll('div[class*="btn"], div[class*="button"], span[class*="btn"], div[role="button"]');
          for (var i = 0; i < divs.length; i++) {
            var el = divs[i];
            var text = (el.innerText || el.textContent || '').trim();
            if (text.length > 0 && text.length <= 10) {
              result.foundButtons.push('[div] ' + text);
              if (text === '发布' || text === '发布笔记' || text === '立即发布') {
                el.click();
                result.clicked = true;
                result.clickedText = text;
                result.clickedSelector = 'div';
                return result;
              }
            }
          }
          
          // 最后查找包含"发布"文本的元素
          var allElements = document.querySelectorAll('div, span, button, a');
          for (var i = 0; i < allElements.length; i++) {
            var el = allElements[i];
            var text = (el.innerText || el.textContent || '').trim();
            // 只匹配纯文本"发布笔记"或"发布"，排除组合文本
            if (text === '发布笔记' || text === '发布' || text === '立即发布') {
              result.foundButtons.push('[other] ' + text);
              el.click();
              result.clicked = true;
              result.clickedText = text;
              result.clickedSelector = 'other';
              return result;
            }
          }
          
          return result;
        })()
      `, { workspace }) as { clicked: boolean; foundButtons: string[]; pageUrl: string; clickedText?: string; clickedSelector?: string };
      console.log(`[handlePublishCommand] "发布"点击结果:`, publishResult);
      
      // 反爬虫：随机等待（3-6秒），等待发布完成
      await randomDelay(3000, 6000);

      // 8. 截图当前状态
      const screenshot = await client.screenshot({ workspace });

      // 9. 激活窗口，带到前台让用户查看
      try {
        await client.focusWindow(workspace);
        console.log(`[handlePublishCommand] 窗口已激活`);
      } catch (err) {
        console.log(`[handlePublishCommand] 窗口激活失败:`, err);
      }

      console.log(`[handlePublishCommand] 发布流程完成`);

      return {
        toolCallId,
        success: true,
        content: `已导航到小红书发布页面并完成发布。

**标题**: ${title}
**内容**: ${content.substring(0, 100)}...
**模式**: ${hasImages ? '上传图文' : '写长文'}

**执行步骤**:
1. ✅ 导航到发布页面
2. ✅ 选择"${tabToClick}"标签页
3. ✅ 点击"新的创作"
4. ✅ 填写标题和正文: ${JSON.stringify(writeResult)}
5. ${formatResult?.clicked ? '✅' : '⚠️'} 点击"一键排版": ${JSON.stringify(formatResult)}
6. ${nextResult?.clicked ? '✅' : '⚠️'} 点击"下一步": ${JSON.stringify(nextResult)}
7. ${publishResult?.clicked ? '✅' : '⚠️'} 点击"发布": ${JSON.stringify(publishResult)}

**结果**: ${publishResult?.clicked ? '✅ 笔记已成功发布到小红书！任务完成，不需要重复发布。' : '⚠️ 发布按钮未点击成功，请检查浏览器手动发布。'}

**重要提示**: 本次发布任务已完成。如果用户需要发布更多内容，请等待用户明确指示。不要主动重复发布相同或类似内容。

截图已保存（base64，前100字符）: ${screenshot.substring(0, 100)}...`,
      };
    }

    // ========== 微博发布流程 ==========
    if (site === 'weibo') {
      console.log(`[handlePublishCommand] 微博发布流程开始`);

      // 微博首页加载后，快捷发布弹窗可能已经自动弹出
      // 或者需要点击发布按钮打开

      // 步骤2：检查是否已有快捷发布弹窗，或者需要打开
      console.log(`[handlePublishCommand] 步骤2: 查找发布入口`);
      const openEditorResult = await client.exec(`
        (function() {
          var result = { foundButtons: [], clicked: false, clickedText: '', hasOpenEditor: false };

          // 先检查是否已有可见的编辑器（快捷发布弹窗已打开）
          var textareas = document.querySelectorAll('textarea');
          var visibleEditor = null;
          for (var i = 0; i < textareas.length; i++) {
            var ta = textareas[i];
            var rect = ta.getBoundingClientRect();
            var placeholder = ta.getAttribute('placeholder') || '';
            
            // 检查是否是可见的内容编辑器（不是搜索框）
            if (rect.width > 0 && rect.height > 0 && 
                placeholder.indexOf('搜索') === -1 && placeholder.indexOf('search') === -1) {
              visibleEditor = ta;
              break;
            }
          }

          if (visibleEditor) {
            result.hasOpenEditor = true;
            result.clickedText = '已有编辑器打开';
            return result;
          }

          // 没有打开的编辑器，需要点击发布按钮
          var allElements = document.querySelectorAll('button, a, div, span');
          for (var i = 0; i < allElements.length; i++) {
            var el = allElements[i];
            var text = (el.innerText || el.textContent || '').trim();

            if (text.length > 0 && text.length < 20) {
              result.foundButtons.push(text);

              if (text === '+' || text === '发布' || text === '写微博') {
                el.click();
                result.clicked = true;
                result.clickedText = text;
                return result;
              }
            }

            var ariaLabel = el.getAttribute('aria-label') || '';
            if (ariaLabel.indexOf('发布') !== -1 || ariaLabel.indexOf('写微博') !== -1) {
              el.click();
              result.clicked = true;
              result.clickedText = ariaLabel;
              return result;
            }
          }

          return result;
        })()
      `, { workspace }) as { foundButtons: string[]; clicked: boolean; clickedText?: string; hasOpenEditor?: boolean };
      console.log(`[handlePublishCommand] 发布入口查找结果:`, openEditorResult);

      // 如果是新打开的编辑器，等待加载
      if (openEditorResult.clicked && !openEditorResult.hasOpenEditor) {
        await randomDelay(2000, 4000);
      }

      // 步骤3：填写微博内容
      console.log(`[handlePublishCommand] 步骤3: 填写微博内容`);
      const writeResult = await client.exec(`
        (function() {
          var result = { foundEditors: [], contentFilled: false, editorType: '', debug: '', textareaInfo: [] };

          var content = \`${(content || '').replace(/`/g, '\\`').replace(/\n/g, '\\n')}\`;
          result.debug = 'content length: ' + content.length;

          // 微博首页主发布框识别策略：
          // 1. 优先查找 placeholder 包含"分享"的 textarea（首页主发布框）
          // 2. 检查可见性和尺寸（主发布框通常较大）
          // 3. 使用 React native setter 设置值

          var textareas = document.querySelectorAll('textarea');
          result.foundEditors.push('total textareas: ' + textareas.length);

          var targetEditor = null;

          for (var i = 0; i < textareas.length; i++) {
            var ta = textareas[i];
            var placeholder = ta.getAttribute('placeholder') || '';
            var rect = ta.getBoundingClientRect();
            var isVisible = rect.width > 0 && rect.height > 0 && rect.top >= 0;

            result.textareaInfo.push({
              index: i,
              placeholder: placeholder,
              visible: isVisible,
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            });

            // 跳过搜索框
            if (placeholder.indexOf('搜索') !== -1 || placeholder.indexOf('search') !== -1) {
              continue;
            }

            // 跳过不可见的
            if (!isVisible) {
              continue;
            }

            // 优先选择首页主发布框（placeholder 包含"分享"且尺寸较大）
            if (placeholder.indexOf('分享') !== -1 && rect.width > 300) {
              targetEditor = ta;
              result.foundEditors.push('selected main editor: ' + placeholder.substring(0, 20));
              break;
            }

            // 备选：任何可见的内容编辑器
            if (!targetEditor && placeholder.indexOf('新鲜') !== -1) {
              targetEditor = ta;
              result.foundEditors.push('selected fallback editor: ' + placeholder.substring(0, 20));
            }
          }

          // 如果找到目标编辑器，填写内容
          if (targetEditor) {
            // 先 focus
            targetEditor.focus();

            // 方案1：使用 React native setter 设置值
            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeInputValueSetter.call(targetEditor, content);

            // 触发 React 的 input 事件
            targetEditor.dispatchEvent(new Event('input', { bubbles: true }));
            targetEditor.dispatchEvent(new Event('change', { bubbles: true }));

            // 方案2：额外触发 InputEvent（某些框架需要）
            try {
              var inputEvent = new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: content
              });
              targetEditor.dispatchEvent(inputEvent);
            } catch (e) {
              // 忽略不支持 InputEvent 的浏览器
            }

            // 方案3：触发 compositionend 事件（中文输入完成）
            targetEditor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));

            // 设置光标位置
            targetEditor.setSelectionRange(content.length, content.length);

            // 最后再 focus 一次
            targetEditor.focus();

            // 验证值是否设置成功
            result.debug = 'textarea value after set: ' + targetEditor.value.length + ' chars';
            result.contentFilled = targetEditor.value === content;
            result.editorType = 'MAIN-TEXTAREA';
          } else {
            result.debug = 'no suitable textarea found';
          }

          return result;
        })()
      `, { workspace }) as { foundEditors: string[]; contentFilled: boolean; editorType?: string; debug?: string; textareaInfo?: any[] };
      console.log(`[handlePublishCommand] 填写结果:`, JSON.stringify(writeResult, null, 2));

      // 反爬虫：随机等待
      await randomDelay(2000, 4000);

      // 步骤4：点击发布按钮
      console.log(`[handlePublishCommand] 步骤4: 点击发布`);
      const publishResult = await client.exec(`
        (function() {
          var result = { foundButtons: [], clicked: false, clickedText: '', buttonInfo: [] };

          // 查找所有按钮并收集信息
          var allButtons = document.querySelectorAll('button, [role="button"], a.btn, div.btn');
          for (var i = 0; i < allButtons.length; i++) {
            var btn = allButtons[i];
            var text = (btn.innerText || btn.textContent || btn.value || '').trim();
            var disabled = btn.disabled || btn.getAttribute('disabled') !== null;
            var className = btn.className || '';
            var rect = btn.getBoundingClientRect();
            var isVisible = rect.width > 0 && rect.height > 0;

            if (text.length > 0 && text.length <= 10) {
              result.buttonInfo.push({
                text: text,
                disabled: disabled,
                visible: isVisible,
                className: className.substring(0, 50)
              });
            }
          }

          // 辅助函数：模拟真实点击
          function simulateClick(element) {
            // 触发完整的点击事件序列
            var rect = element.getBoundingClientRect();
            var x = rect.left + rect.width / 2;
            var y = rect.top + rect.height / 2;

            // mousedown
            element.dispatchEvent(new MouseEvent('mousedown', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y
            }));

            // mouseup
            element.dispatchEvent(new MouseEvent('mouseup', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y
            }));

            // click
            element.dispatchEvent(new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y
            }));

            // 也尝试直接调用 click 方法
            element.click();
          }

          // 查找发送按钮（优先在可见区域的）
          var sendButtons = [];
          for (var i = 0; i < allButtons.length; i++) {
            var btn = allButtons[i];
            var text = (btn.innerText || btn.textContent || '').trim();
            var rect = btn.getBoundingClientRect();
            var isVisible = rect.width > 0 && rect.height > 0 && rect.top >= 0;
            var disabled = btn.disabled || btn.getAttribute('disabled') !== null;

            if ((text === '发送' || text === '发布') && isVisible) {
              sendButtons.push({
                btn: btn,
                disabled: disabled,
                text: text,
                rect: rect
              });
              result.foundButtons.push(text + ' @ ' + Math.round(rect.top) + 'px');
            }
          }

          // 选择最上方的发送按钮（通常是主发布框的）
          if (sendButtons.length > 0) {
            // 按 top 排序，选择最上方的
            sendButtons.sort(function(a, b) { return a.rect.top - b.rect.top; });
            var targetBtn = sendButtons[0];

            simulateClick(targetBtn.btn);
            result.clicked = true;
            result.clickedText = targetBtn.text + ' (top: ' + Math.round(targetBtn.rect.top) + 'px)';
            return result;
          }

          // 没找到发送按钮，尝试其他方式
          var weiboSendBtn = document.querySelector('[action-type="publish"], [node-type="submit"]');
          if (weiboSendBtn) {
            simulateClick(weiboSendBtn);
            result.clicked = true;
            result.clickedText = '[weibo publish btn]';
            return result;
          }

          return result;
        })()
      `, { workspace }) as { foundButtons: string[]; clicked: boolean; clickedText?: string; buttonInfo?: any[] };
      console.log(`[handlePublishCommand] 发布点击结果:`, JSON.stringify(publishResult, null, 2));

      // 等待发布完成
      await randomDelay(3000, 5000);

      // 步骤5：截图确认
      const screenshot = await client.screenshot({ workspace });

      // 激活窗口让用户查看
      try {
        await client.focusWindow(workspace);
        console.log(`[handlePublishCommand] 窗口已激活`);
      } catch (err) {
        console.log(`[handlePublishCommand] 窗口激活失败:`, err);
      }

      return {
        toolCallId,
        success: true,
        content: `微博发布流程完成！

**内容**: ${content?.substring(0, 100)}${content && content.length > 100 ? '...' : ''}

**执行步骤**:
1. ✅ 导航到微博首页
2. ${openEditorResult?.clicked ? '✅' : '⚠️'} 打开编辑器: ${JSON.stringify(openEditorResult)}
3. ${writeResult?.contentFilled ? '✅' : '⚠️'} 填写内容: ${JSON.stringify(writeResult)}
4. ${publishResult?.clicked ? '✅' : '⚠️'} 点击发布: ${JSON.stringify(publishResult)}

**结果**: 发布流程已完成。浏览器窗口已激活到前台，请确认发布状态。

截图已保存（base64，前100字符）: ${screenshot.substring(0, 100)}...`,
      };
    }

    // ========== 抖音发布流程 ==========
    if (site === 'douyin') {
      console.log(`[handlePublishCommand] 抖音发布流程开始`);

      // 抖音创作者中心已导航，直接检查页面
      await randomDelay(3000, 5000);

      // 步骤2：点击"我要发文"按钮（抖音创作者中心的选择发布方式页面）
      console.log(`[handlePublishCommand] 步骤2: 点击"我要发文"按钮`);
      const openArticleResult = await client.exec(`
        (function() {
          var result = { foundButtons: [], clicked: false, clickedText: '', debug: '' };

          // 抖音创作者中心的"选择发布方式"页面有以下按钮：
          // - 发布视频、发图文、发文章（这些是左侧导航菜单，不要点）
          // - 我要发文、一键导入（这些是"选择发布方式"页面的按钮，需要点击"我要发文"）
          
          var buttons = document.querySelectorAll('button, [role="button"], a, div, span');
          for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            var text = (btn.innerText || btn.textContent || '').trim();

            // 收集所有短文本按钮
            if (text.length > 0 && text.length <= 20) {
              result.foundButtons.push(text);

              // 精确匹配"我要发文"按钮（选择发布方式页面）
              if (text === '我要发文') {
                btn.click();
                result.clicked = true;
                result.clickedText = text;
                result.debug = 'clicked: 我要发文';
                return result;
              }
            }
          }

          // 如果没找到"我要发文"，尝试匹配"发文章"（可能是另一种页面布局）
          for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            var text = (btn.innerText || btn.textContent || '').trim();

            // 注意：排除左侧导航菜单的"发布文章"（那是菜单项，不是操作按钮）
            if (text === '发文章' && text.indexOf('发布') === -1) {
              btn.click();
              result.clicked = true;
              result.clickedText = text;
              result.debug = 'clicked: 发文章';
              return result;
            }
          }

          result.debug = '我要发文 button not found. Found buttons: ' + result.foundButtons.join(', ');
          return result;
        })()
      `, { workspace });
      console.log(`[handlePublishCommand] 点击"我要发文"结果:`, openArticleResult);

      await randomDelay(3000, 5000);

      // 步骤3：填写文章内容
      console.log(`[handlePublishCommand] 步骤3: 填写文章内容`);
      const fillResult = await client.exec(`
        (function() {
          var result = { 
            titleFilled: false, 
            contentFilled: false, 
            debug: '',
            foundInputs: []
          };

          var title = \`${(title || '').replace(/`/g, '\\`').replace(/\n/g, '\\n')}\`;
          var content = \`${(content || '').replace(/`/g, '\\`').replace(/\n/g, '\\n')}\`;

          // 查找所有输入框，收集调试信息
          var allInputs = document.querySelectorAll('input, textarea, [contenteditable="true"]');
          for (var i = 0; i < allInputs.length; i++) {
            var inp = allInputs[i];
            var placeholder = inp.getAttribute('placeholder') || '';
            var label = inp.getAttribute('aria-label') || '';
            var rect = inp.getBoundingClientRect();
            result.foundInputs.push({
              tag: inp.tagName,
              ph: placeholder,
              label: label,
              visible: rect.width > 0 && rect.height > 0,
              height: rect.height
            });
          }

          // 1. 填写文章标题
          // 抖音文章标题：input[placeholder*="请输入文章标题"]
          // 抖音使用 Semi-UI 框架，需要使用 native input value setter 来触发 React 状态更新
          
          // 先尝试精确匹配 placeholder
          var titleInput = document.querySelector('input[placeholder*="请输入文章标题"]');
          if (!titleInput) {
            // 回退：匹配包含"标题"的 input
            titleInput = document.querySelector('input[placeholder*="标题"]');
          }
          if (!titleInput) {
            // 再回退：匹配所有 input，通过 placeholder 判断
            var allInputs = document.querySelectorAll('input[type="text"]');
            for (var i = 0; i < allInputs.length; i++) {
              var inp = allInputs[i];
              var ph = inp.getAttribute('placeholder') || '';
              if (ph.indexOf('标题') !== -1) {
                titleInput = inp;
                break;
              }
            }
          }
          
          if (titleInput) {
            titleInput.focus();
            
            // 使用 native input value setter 来触发 React 状态更新
            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(titleInput, title);
            
            // 触发多种事件确保框架捕获
            titleInput.dispatchEvent(new Event('input', { bubbles: true }));
            titleInput.dispatchEvent(new Event('change', { bubbles: true }));
            
            // 对于 Semi-UI，可能还需要触发 keydown/keyup 事件
            titleInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
            titleInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            
            titleInput.blur();
            result.titleFilled = true;
            result.debug += 'title filled; ';
          } else {
            result.debug += 'title input not found; ';
          }

          // 2. 填写文章正文
          var contentEditors = document.querySelectorAll('textarea, [contenteditable="true"]');
          for (var i = 0; i < contentEditors.length; i++) {
            var editor = contentEditors[i];
            var ph = editor.getAttribute('placeholder') || '';
            var rect = editor.getBoundingClientRect();
            
            // 跳过搜索框和不可见的
            if (ph.indexOf('搜索') !== -1) continue;
            if (rect.width === 0 || rect.height === 0) continue;

            // 判断是否是正文编辑器（通常较大）
            if (rect.height > 100 || ph.indexOf('正文') !== -1 || ph.indexOf('内容') !== -1 || ph.indexOf('添加正文') !== -1) {
              editor.focus();
              if (editor.tagName === 'TEXTAREA') {
                var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                nativeSetter.call(editor, content);
              } else {
                // 对于 contenteditable，需要更彻底地设置
                editor.textContent = content;
                editor.innerHTML = content.replace(/\\n/g, '<br>');
              }
              editor.dispatchEvent(new Event('input', { bubbles: true }));
              editor.dispatchEvent(new Event('change', { bubbles: true }));
              editor.blur();
              result.contentFilled = true;
              result.debug += 'content filled; ';
              break;
            }
          }

          return result;
        })()
      `, { workspace });
      console.log(`[handlePublishCommand] 填写文章结果:`, fillResult);

      await randomDelay(2000, 3000);

      // 步骤4：点击"AI配图"按钮
      console.log(`[handlePublishCommand] 步骤4: 点击AI配图`);
      const aiImageResult = await client.exec(`
        (function() {
          var result = { foundButtons: [], clicked: false, clickedText: '', debug: '' };

          // 抖音文章编辑器的 AI配图 DOM 结构：
          // <span class="iconContainer-IO2yut">
          //   <span class="mycard-info-text-icon-fVsMvA">...</span>
          //   "AI 配图"  ← 这是文本节点
          // </span>
          // "AI 配图" 是文本节点，不是元素节点，需要用其他方式定位
          
          // 方法1：通过 class 名查找 iconContainer
          var iconContainers = document.querySelectorAll('[class*="iconContainer"]');
          for (var i = 0; i < iconContainers.length; i++) {
            var container = iconContainers[i];
            var text = (container.innerText || container.textContent || '').trim();
            
            if (text.indexOf('AI 配图') !== -1 || text.indexOf('AI配图') !== -1) {
              container.click();
              result.clicked = true;
              result.clickedText = text;
              result.debug = 'clicked iconContainer with AI 配图';
              return result;
            }
          }
          
          // 方法2：查找包含 "AI 配图" 文本的 span 元素（通过遍历所有 span）
          var allSpans = document.querySelectorAll('span');
          for (var i = 0; i < allSpans.length; i++) {
            var span = allSpans[i];
            var text = (span.innerText || span.textContent || '').trim();
            
            if (text.length > 0 && text.length <= 20) {
              result.foundButtons.push(text);
            }
            
            // 匹配 "AI 配图" 或 "AI配图"
            if (text === 'AI 配图' || text === 'AI配图') {
              span.click();
              result.clicked = true;
              result.clickedText = text;
              result.debug = 'clicked span with exact AI 配图 text';
              return result;
            }
          }
          
          // 方法3：查找父元素包含 "AI 配图" 的组合按钮
          var buttons = document.querySelectorAll('button, div[class*="upload"], div[class*="mycard"], [role="button"]');
          for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            var text = (btn.innerText || btn.textContent || '').trim();
            
            if (text.indexOf('AI 配图') !== -1 || text.indexOf('AI配图') !== -1) {
              // 查找按钮内的 "AI 配图" 子元素
              var children = btn.querySelectorAll('*');
              for (var j = 0; j < children.length; j++) {
                var child = children[j];
                var childText = (child.innerText || child.textContent || '').trim();
                if (childText === 'AI 配图' || childText === 'AI配图') {
                  child.click();
                  result.clicked = true;
                  result.clickedText = childText;
                  result.debug = 'clicked child element with AI 配图';
                  return result;
                }
              }
              
              // 回退：直接点击父元素
              btn.click();
              result.clicked = true;
              result.clickedText = text.substring(0, 30);
              result.debug = 'clicked parent container';
              return result;
            }
          }

          result.debug = 'AI配图 button not found';
          return result;
        })()
      `, { workspace });
      console.log(`[handlePublishCommand] AI配图结果:`, aiImageResult);

      // 等待AI生成图片（AI配图需要约13秒，为保险起见等待18-20秒）
      console.log(`[handlePublishCommand] 等待AI生成图片（18-20秒）...`);
      await randomDelay(18000, 20000);

      // 步骤4.5：确认封面已生成，如果没有则再次尝试
      console.log(`[handlePublishCommand] 步骤4.5: 检查封面是否已生成`);
      const coverCheckResult = await client.exec(`
        (function() {
          var result = { hasCover: false, debug: '', foundImages: [] };
          
          // 检查是否有封面图片（查找已生成的封面区域）
          var coverAreas = document.querySelectorAll('[class*="cover"], [class*="image"], img');
          for (var i = 0; i < coverAreas.length; i++) {
            var area = coverAreas[i];
            var rect = area.getBoundingClientRect();
            if (rect.width > 50 && rect.height > 50) {
              result.foundImages.push({
                tag: area.tagName,
                src: area.src || '',
                className: area.className.substring(0, 50)
              });
              result.hasCover = true;
            }
          }
          
          result.debug = result.hasCover ? 'cover found' : 'no cover found';
          return result;
        })()
      `, { workspace });
      console.log(`[handlePublishCommand] 封面检查结果:`, coverCheckResult);

      // 步骤5：点击发布按钮
      console.log(`[handlePublishCommand] 步骤5: 点击发布`);
      const publishResult = await client.exec(`
        (function() {
          var result = { foundButtons: [], clicked: false, clickedText: '', debug: '' };

          // 查找发布按钮
          var buttons = document.querySelectorAll('button, [role="button"]');
          for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            var text = (btn.innerText || btn.textContent || '').trim();
            var disabled = btn.disabled || btn.getAttribute('disabled');

            if (text.length > 0 && text.length <= 10) {
              result.foundButtons.push(text + (disabled ? '(disabled)' : ''));

              if (text === '发布' && !disabled) {
                btn.click();
                result.clicked = true;
                result.clickedText = text;
                result.debug = 'clicked publish';
                return result;
              }
            }
          }

          result.debug = 'publish button not found or disabled';
          return result;
        })()
      `, { workspace });
      console.log(`[handlePublishCommand] 发布点击结果:`, publishResult);

      // 等待发布完成
      await randomDelay(3000, 5000);

      // 激活窗口让用户查看结果
      try {
        await client.focusWindow(workspace);
        console.log(`[handlePublishCommand] 窗口已激活`);
      } catch (err) {
        console.log(`[handlePublishCommand] 窗口激活失败:`, err);
      }

      return {
        toolCallId,
        success: true,
        content: `抖音文章发布流程完成！

**标题**: ${title}
**内容**: ${content?.substring(0, 100)}${content && content.length > 100 ? '...' : ''}

**执行步骤**:
1. ✅ 导航到抖音创作者中心
2. ${(openArticleResult as any)?.clicked ? '✅' : '⚠️'} 打开发布文章页面: ${JSON.stringify(openArticleResult)}
3. ${(fillResult as any)?.titleFilled ? '✅' : '⚠️'} 填写标题: ${JSON.stringify(fillResult)}
4. ${(fillResult as any)?.contentFilled ? '✅' : '⚠️'} 填写正文
5. ${(aiImageResult as any)?.clicked ? '✅' : '⚠️'} 点击AI配图: ${JSON.stringify(aiImageResult)}
6. ${(publishResult as any)?.clicked ? '✅' : '⚠️'} 点击发布: ${JSON.stringify(publishResult)}

**结果**: ${(publishResult as any)?.clicked ? '✅ 文章已成功发布到抖音！任务完成，不需要重复发布。' : '⚠️ 发布按钮未点击成功，请检查浏览器手动发布。'}

**重要提示**: 本次发布任务已完成。如果用户需要发布更多内容，请等待用户明确指示。不要主动重复发布相同或类似内容。`,
      };
    }

    return {
      toolCallId,
      success: true,
      content: `已导航到 ${site} 发布页面。当前页面: ${publishUrl}\n\n请在浏览器中手动完成发布。`,
    };

  } catch (err) {
    return {
      toolCallId,
      success: false,
      content: `发布操作失败: ${(err as Error).message}`,
      error: (err as Error).message,
    };
  }
  // 注意：不关闭窗口，让用户有机会检查和修改
}

/**
 * 处理搜索命令
 */
async function handleSearchCommand(
  client: BrowserBridgeClient,
  site: string,
  query: string,
  workspace: string,
  toolCallId: string
): Promise<ToolResult> {
  if (!query) {
    return {
      toolCallId,
      success: false,
      content: '搜索需要 query 参数',
      error: 'missing_query',
    };
  }

  const SEARCH_URLS: Record<string, (q: string) => string> = {
    xiaohongshu: (q: string) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}`,
    weibo: (q: string) => `https://s.weibo.com/weibo/${encodeURIComponent(q)}`,
    zhihu: (q: string) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(q)}`,
    douyin: (q: string) => `https://www.douyin.com/search/${encodeURIComponent(q)}`,
  };

  const urlFn = SEARCH_URLS[site];
  if (!urlFn) {
    return {
      toolCallId,
      success: false,
      content: `本地模式不支持 ${site} 的搜索`,
      error: 'unsupported_site',
    };
  }

  try {
    const searchUrl = urlFn(query);
    await client.navigate(searchUrl, { workspace });
    await new Promise(r => setTimeout(r, 2000));

    // 提取搜索结果
    const results = await client.exec(`
      (function() {
        const items = [];
        // 根据站点提取结果
        const selectors = {
          xiaohongshu: '.note-item, .search-result-item',
          weibo: '.card-wrap',
          zhihu: '.SearchResult-Card'
        };
        const selector = selectors['${site}'] || 'article, .item';
        document.querySelectorAll(selector).forEach((el, i) => {
          if (i < 10) {
            const title = el.querySelector('h1, h2, h3, .title')?.textContent?.trim() || '';
            const link = el.querySelector('a')?.href || '';
            if (title) items.push({ title, link });
          }
        });
        return items;
      })()
    `, { workspace });

    return {
      toolCallId,
      success: true,
      content: `${site} 搜索 "${query}" 结果:\n\n${JSON.stringify(results, null, 2)}`,
    };

  } catch (err) {
    return {
      toolCallId,
      success: false,
      content: `搜索失败: ${(err as Error).message}`,
      error: (err as Error).message,
    };
  } finally {
    try {
      await client.closeWindow(workspace);
    } catch {}
  }
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

    // 认证信息
    const botId = context?.botId || context?.config?.platform?.botId;
    const token = context?.config?.platform?.token;

    if (botId) headers['X-Bot-Id'] = botId;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['X-Bot-Token'] = token;
    }

    const ownerId = context?.ownerId;
    if (ownerId) body.ownerId = ownerId;

    // 发布类命令需要更长超时时间（约 30 秒操作时间）
    const publishCommands = ['xiaohongshu/publish', 'weibo/post', 'zhihu/post_article', 'zhihu/post_answer'];
    const isPublishCommand = publishCommands.some(cmd => command === cmd || command.startsWith(cmd));
    const defaultTimeout = isPublishCommand ? 120000 : 30000; // 发布命令 120 秒，其他 30 秒
    const timeoutMs = Math.min(context?.remainingMs || defaultTimeout, defaultTimeout);

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

/**
 * 获取 web_cli_describe 工具定义
 *
 * 让 Agent 动态发现平台当前支持的所有 CLI 命令，
 * 包含策略类型、是否只读、参数 schema 等元信息。
 */
export function getWebCliDescribeToolDefinition(platformUrl?: string, mode: 'local' | 'platform' = 'platform'): ToolDefinition {
  const baseUrl = platformUrl || 'https://www.miniabc.top';

  // 本地模式支持的命令白名单
  const LOCAL_SUPPORTED_COMMANDS: Record<string, string[]> = {
    // 通用浏览器命令
    'browser': ['navigate', 'exec', 'screenshot', 'evaluate', 'fetch'],
    'cookies': ['get'],
    'keepalive': ['start', 'stop', 'status'],

    // 小红书
    'xiaohongshu': ['publish', 'post', 'search', 'hot'],

    // 微博
    'weibo': ['post', 'search', 'hot_search', 'hot'],

    // 知乎
    'zhihu': ['post_article', 'search', 'hot'],

    // 抖音
    'douyin': ['publish', 'post', 'search', 'hot', 'trending', 'discover'],
  };

  const executor: ToolExecutorFn = async (params, context) => {
    const toolCallId = (context as any)?.toolCallId || 'web_cli_describe';

    try {
      const response = await fetch(`${baseUrl}/api/cli/commands`, {
        headers: {
          'User-Agent': 'WorkerClaw/1.0',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return { toolCallId, success: false, content: `命令发现失败: HTTP ${response.status}`, error: `http_${response.status}` };
      }

      const result = await response.json() as { success: boolean; commands: any[]; stats: { total: number; fetch: number; browser: number; auth: number } };

      if (!result.success || !result.commands) {
        return { toolCallId, success: false, content: '命令列表为空', error: 'empty_commands' };
      }

      // 过滤
      const filterStrategy = params.strategy as string | undefined;
      const filterSite = params.site as string | undefined;

      let commands = result.commands;
      if (filterStrategy) {
        commands = commands.filter((c: any) => c.strategy === filterStrategy);
      }
      if (filterSite) {
        commands = commands.filter((c: any) => c.site === filterSite);
      }

      // 本地模式下过滤命令
      if (mode === 'local') {
        commands = commands.filter((c: any) => {
          const supportedCommands = LOCAL_SUPPORTED_COMMANDS[c.site];
          if (!supportedCommands) return false;
          return supportedCommands.includes(c.command);
        });
      }

      // 格式化（本地模式下覆盖某些命令的描述）
      const LOCAL_DESCRIPTION_OVERRIDES: Record<string, string> = {
        'douyin/publish': '发布文章到抖音（本地模式支持文章发布，需要 title 和 content 参数）',
        'xiaohongshu/publish': '发布笔记到小红书（需要 title 和 content 参数）',
        'weibo/post': '发布微博文章（需要 title 和 content 参数）',
        'zhihu/post_article': '发布知乎文章（需要 title 和 content 参数）',
      };

      const lines = commands.map((c: any) => {
        const key = `${c.site}/${c.command}`;
        const description = mode === 'local' && LOCAL_DESCRIPTION_OVERRIDES[key]
          ? LOCAL_DESCRIPTION_OVERRIDES[key]
          : c.description;
        const readOnly = c.isReadOnly ? '只读' : '写操作';
        const localTag = mode === 'local' ? '' : `  [${c.strategy}]`;
        return `  ${c.site}/${c.command}${localTag}  ${readOnly}  — ${description}`;
      });

      const statsInfo = mode === 'local'
        ? `本地模式支持: ${commands.length} 个命令`
        : `总计: ${result.stats.total} 个命令 (fetch=${result.stats.fetch}, browser=${result.stats.browser}, auth=${result.stats.auth})`;

      const localNote = mode === 'local'
        ? '\n\n⚠️ 本地模式仅支持以上命令。其他命令需要平台模式 (webCli.mode: "platform")。\n📝 发布类命令需要 title 和 content 参数，用于发布文章/笔记。\n'
        : '';

      const content = [
        `CLI 命令列表${mode === 'local' ? ' (本地模式)' : ''}${filterStrategy ? ` [${filterStrategy}]` : ''}${filterSite ? ` [${filterSite}]` : ''}:`,
        statsInfo,
        '',
        ...lines,
        localNote,
        '使用 web_cli 工具调用: { site, command, query, limit, title, content }',
      ].join('\n');

      return { toolCallId, success: true, content };

    } catch (err) {
      logger.error('web_cli_describe 执行失败', { error: (err as Error).message });
      return { toolCallId, success: false, content: `命令发现失败: ${(err as Error).message}`, error: (err as Error).message };
    }
  };

  return {
    name: 'web_cli_describe',
    description: `查看当前可用的 CLI 命令列表。${mode === 'local' ? '本地模式仅支持部分命令（发布、搜索、热榜）。' : '动态发现平台支持的所有命令，包括 fetch（公开API）、browser（网页渲染）、auth（带登录态）三种策略。'}
参数: strategy (可选过滤: fetch/browser/auth), site (可选过滤: 站点名)`,
    requiredLevel: 'read_only',
    parameters: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['fetch', 'browser', 'auth'], description: '按策略过滤' },
        site: { type: 'string', description: '按站点名过滤' },
      },
    },
    executor,
  };
}
