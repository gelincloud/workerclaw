/**
 * WorkerClaw CLI - 智工坊注册/配置 section
 * 
 * 支持自动注册和手动配置两种方式
 */

import { intro as clackIntro, outro, select, text, password, spinner, confirm } from '../prompter.js';
import type { PlatformConfig } from '../../core/config.js';

/** 默认平台地址 */
const DEFAULT_PLATFORM_URL = 'https://www.miniabc.top';

export interface PlatformSectionResult {
  platform: Partial<PlatformConfig>;
}

/**
 * 智工坊平台配置
 */
export async function configurePlatform(existing?: Partial<PlatformConfig>): Promise<PlatformSectionResult | null> {
  clackIntro('智工坊平台');

  // 选择配置方式
  const mode = await select(
    '选择配置方式',
    [
      { value: 'auto', label: '自动注册（推荐）', hint: '调用平台 API 自动创建 Agent 账户' },
      { value: 'manual', label: '手动配置', hint: '输入已有的 Bot ID 和 Token' },
    ],
    existing?.botId ? 'manual' : 'auto',
  );

  if (!mode) return null;

  if (mode === 'manual') {
    return configureManual(existing);
  } else {
    return configureAuto(existing);
  }
}

/**
 * 手动配置
 */
async function configureManual(existing?: Partial<PlatformConfig>): Promise<PlatformSectionResult | null> {
  // 输入 API 地址
  const apiUrl = await text(
    '平台 API 地址',
    existing?.apiUrl || DEFAULT_PLATFORM_URL,
  );
  if (!apiUrl) return null;

  // 输入 WebSocket 地址
  const wsUrl = await text(
    '平台 WebSocket 地址',
    existing?.wsUrl || DEFAULT_PLATFORM_URL.replace(/^http/, 'ws'),
  );
  if (!wsUrl) return null;

  // 输入 Bot ID
  const botId = await text(
    'Bot ID',
    existing?.botId,
  );
  if (!botId) return null;

  // 输入 Token
  const token = await password('认证 Token');
  if (!token) return null;

  // 测试连接
  const shouldTest = await confirm('测试连接？', true);
  if (shouldTest) {
    const spin = spinner();
    spin.start('正在测试连接...');

    try {
      const response = await fetch(`${apiUrl.replace(/\/$/, '')}/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          botId,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        spin.stop(`连接成功！Bot: ${botId}`);
      } else {
        const body = await response.text().catch(() => 'unknown');
        spin.stop(`连接失败 (HTTP ${response.status}): ${body}`);
        const retry = await confirm('是否继续保存配置？', false);
        if (!retry) return null;
      }
    } catch (err) {
      spin.stop(`连接失败: ${(err as Error).message}`);
      const retry = await confirm('是否继续保存配置？', false);
      if (!retry) return null;
    }
  }

  return {
    platform: {
      apiUrl: apiUrl.replace(/\/$/, ''),
      wsUrl: wsUrl.replace(/\/$/, ''),
      botId,
      token,
      reconnect: {
        maxRetries: 5,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      },
    },
  };
}

/**
 * 自动注册
 */
async function configureAuto(existing?: Partial<PlatformConfig>): Promise<PlatformSectionResult | null> {
  // 输入平台地址（默认）
  const apiUrl = await text(
    '平台 API 地址',
    existing?.apiUrl || DEFAULT_PLATFORM_URL,
  );
  if (!apiUrl) return null;

  const wsUrl = await text(
    '平台 WebSocket 地址',
    existing?.wsUrl || DEFAULT_PLATFORM_URL.replace(/^http/, 'ws'),
  );
  if (!wsUrl) return null;

  // 输入 Agent 名称（可选）
  const agentName = await text(
    'Agent 名称（可留空使用默认）',
    '小工虾',
  );
  if (agentName === null) return null;

  // 生成 agentId
  const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const spin = spinner();

  try {
    spin.start('正在向智工坊注册...');

    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/openclaw/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentId,
        agentName: agentName || undefined,
        capabilities: ['text_reply', 'qa', 'search_summary', 'writing', 'translation', 'code_dev'],
        autoPostTweet: true,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await response.json() as any;

    if (response.ok && data.success) {
      const botId = data.botId || data.data?.botId;
      const token = data.token || data.data?.token;
      const nickname = data.nickname || data.data?.nickname;

      spin.stop(`注册成功！Bot: ${nickname || botId}`);

      // 显示认证信息框
      clackIntro('');
      // 使用 outro 显示关键信息
      outro(`注册完成！
  Bot ID: ${botId}
  Token: ${token?.slice(0, 8)}...${token?.slice(-4)}
  昵称: ${nickname || '未设置'}

  配置已保存到 ~/.workerclaw/config.json`);

      return {
        platform: {
          apiUrl: apiUrl.replace(/\/$/, ''),
          wsUrl: wsUrl.replace(/\/$/, ''),
          botId,
          token,
          agentName: agentName || undefined,
          reconnect: {
            maxRetries: 5,
            baseDelayMs: 1000,
            maxDelayMs: 30000,
          },
        },
      };
    } else {
      spin.stop(`注册失败: ${data.error || data.message || `HTTP ${response.status}`}`);

      const fallback = await confirm('注册失败，是否改用手动配置？', true);
      if (fallback) {
        return configureManual({ apiUrl, wsUrl });
      }
      return null;
    }
  } catch (err) {
    spin.stop(`注册请求失败: ${(err as Error).message}`);

    const fallback = await confirm('无法连接平台，是否改用手动配置？', true);
    if (fallback) {
      return configureManual({ apiUrl, wsUrl });
    }
    return null;
  }
}
