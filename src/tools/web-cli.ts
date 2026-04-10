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
        command: { type: 'string', description: '命令名称（如 publish, hot, search）' },
        query: { type: 'string', description: '搜索关键词（搜索类命令使用）' },
        limit: { type: 'number', description: '返回条数限制' },
        title: { type: 'string', description: '标题（发布类命令使用）' },
        content: { type: 'string', description: '正文内容（发布类命令使用）' },
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

  // 其他命令：不支持的命令
  return {
    toolCallId,
    success: false,
    content: `本地模式不支持 ${site}/${command}。

**本地模式可用命令**:
- browser/navigate, browser/exec, browser/screenshot, browser/evaluate
- cookies/get
- 发布类命令：xiaohongshu/publish, weibo/post, zhihu/post_article
- 搜索类命令：xiaohongshu/search, weibo/search, zhihu/search
- 热门内容：xiaohongshu/hot, weibo/hot_search, zhihu/hot（通过本地浏览器）

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
          zhihu: '.HotList-item, .HotItem'
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

**结果**: 发布流程已完成。浏览器窗口已激活到前台，请确认发布状态。

截图已保存（base64，前100字符）: ${screenshot.substring(0, 100)}...`,
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

    const botId = context?.botId;
    if (botId) headers['X-Bot-Id'] = botId;

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
export function getWebCliDescribeToolDefinition(platformUrl?: string): ToolDefinition {
  const baseUrl = platformUrl || 'https://www.miniabc.top';

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

      // 格式化
      const lines = commands.map((c: any) => {
        const readOnly = c.isReadOnly ? '只读' : '写操作';
        return `  ${c.site}/${c.command}  [${c.strategy}]  ${readOnly}  — ${c.description}`;
      });

      const statsInfo = `总计: ${result.stats.total} 个命令 (fetch=${result.stats.fetch}, browser=${result.stats.browser}, auth=${result.stats.auth})`;

      const content = [
        `CLI 命令列表${filterStrategy ? ` [${filterStrategy}]` : ''}${filterSite ? ` [${filterSite}]` : ''}:`,
        statsInfo,
        '',
        ...lines,
        '',
        '使用 web_cli 工具调用: { site, command, query, limit }',
      ].join('\n');

      return { toolCallId, success: true, content };

    } catch (err) {
      logger.error('web_cli_describe 执行失败', { error: (err as Error).message });
      return { toolCallId, success: false, content: `命令发现失败: ${(err as Error).message}`, error: (err as Error).message };
    }
  };

  return {
    name: 'web_cli_describe',
    description: `查看平台当前可用的 CLI 命令列表。动态发现平台支持的所有命令，包括 fetch（公开API）、browser（网页渲染）、auth（带登录态）三种策略。
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
