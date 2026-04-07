/**
 * Web CLI 配置向导
 * 
 * 配置 Web CLI 模式（平台代理 or 本地 Browser Bridge）
 */

import { select, confirm, text, outro } from '../prompter.js';
import type { WebCliConfig } from '../../core/config.js';

export interface WebCliSectionResult {
  webCli: WebCliConfig;
}

/**
 * 配置 Web CLI
 */
export async function configureWebCli(
  existing?: WebCliConfig,
): Promise<WebCliSectionResult | null> {
  const currentMode = existing?.mode || 'platform';
  
  console.log('\n🌐 Web CLI 配置\n');
  console.log('  Web CLI 用于访问互联网数据（微博、知乎、抖音等）\n');
  
  console.log('  📌 两种模式：');
  console.log('     • 平台代理 - 通过智工坊平台调用远程浏览器');
  console.log('                 登录态需要通过 Chrome 扩展同步到平台');
  console.log('                 适合云端 Agent，无需本地浏览器\n');
  console.log('     • 本地桥接 - 直接操作本机 Chrome 浏览器');
  console.log('                 使用本机已登录的网站，无需同步登录态');
  console.log('                 适合本地开发、隐私优先、离线环境\n');
  
  const mode = await select(
    '选择 Web CLI 模式',
    [
      { 
        value: 'platform', 
        label: '平台代理（推荐）', 
        hint: '通过智工坊平台调用，适合云端 Agent' 
      },
      { 
        value: 'local', 
        label: '本地桥接', 
        hint: '直接操作本机 Chrome，无需同步登录态' 
      },
    ],
    currentMode,
  );
  
  if (!mode) {
    return null;
  }
  
  const config: WebCliConfig = { mode: mode as 'platform' | 'local' };
  
  if (mode === 'platform') {
    // 平台模式配置
    const defaultUrl = existing?.platformUrl || 'https://www.miniabc.top';
    const customUrl = await confirm('使用自定义平台地址？', false);
    
    if (customUrl) {
      const url = await text('平台 API 地址', undefined, defaultUrl);
      if (url) {
        config.platformUrl = url.replace(/\/$/, '');
      }
    }
    
    console.log('\n✅ 已选择平台代理模式');
    console.log('   提示: 如需操作需要登录的网站，请安装智工坊 Chrome 扩展并同步登录态\n');
    
  } else {
    // 本地模式配置
    const defaultPort = existing?.local?.port || 19825;
    const defaultHost = existing?.local?.host || 'localhost';
    const defaultTimeout = existing?.local?.timeout || 30000;
    
    config.local = {
      port: defaultPort,
      host: defaultHost,
      timeout: defaultTimeout,
    };
    
    const customPort = await confirm('使用自定义端口？', false);
    if (customPort) {
      const portStr = await text('Daemon 端口', undefined, String(defaultPort));
      if (portStr) {
        config.local.port = parseInt(portStr) || defaultPort;
      }
    }
    
    console.log('\n✅ 已选择本地桥接模式');
    console.log('   提示: 启动 Agent 时会自动启动本地 Daemon');
    console.log('   提示: 请确保安装了智工坊 Chrome 扩展并启用本地桥接\n');
  }
  
  return { webCli: config };
}

/**
 * 快捷切换 Web CLI 模式
 */
export async function quickToggleWebCli(
  existing: WebCliConfig | undefined,
): Promise<WebCliConfig | null> {
  const currentMode = existing?.mode || 'platform';
  const newMode = currentMode === 'platform' ? 'local' : 'platform';
  
  console.log(`\n当前模式: ${currentMode === 'platform' ? '平台代理' : '本地桥接'}`);
  
  const confirmSwitch = await confirm(
    `切换到 ${newMode === 'platform' ? '平台代理' : '本地桥接'} 模式？`,
    true,
  );
  
  if (!confirmSwitch) {
    return null;
  }
  
  const config: WebCliConfig = { mode: newMode };
  
  if (newMode === 'local') {
    config.local = existing?.local || {
      port: 19825,
      host: 'localhost',
      timeout: 30000,
    };
  } else {
    config.platformUrl = existing?.platformUrl || 'https://www.miniabc.top';
  }
  
  console.log(`\n✅ Web CLI 模式已切换为: ${newMode === 'platform' ? '平台代理' : '本地桥接'}`);
  
  return config;
}
