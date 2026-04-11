/**
 * WorkerClaw CLI - 交互式配置向导主流程
 * 
 * 类似 openclaw configure，引导用户完成所有配置
 */

import { intro, outro, select, confirm, spinner, text, password, num } from './prompter.js';
import { configurePlatform, type PlatformSectionResult } from './sections/platform.js';
import { configureLLM, type LLMSectionResult } from './sections/llm.js';
import { configurePersonality, type PersonalitySectionResult } from './sections/personality.js';
import { configureSecurity, type SecuritySectionResult } from './sections/security.js';
import { configureEnterprise } from './sections/enterprise.js';
import { configureWebCli, type WebCliSectionResult, quickToggleWebCli } from './sections/webcli.js';
import { type WorkerClawConfig, DEFAULT_CONFIG } from '../core/config.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 默认平台地址 */
export const DEFAULT_PLATFORM_URL = 'https://www.miniabc.top';
/** 默认 WebSocket 地址 */
const DEFAULT_WS_URL = 'wss://www.miniabc.top/ws/openclaw';

/** WorkerClaw 数据目录 */
export const WORKERCLAW_DIR = join(homedir(), '.workerclaw');
/** 默认配置文件路径 */
export const DEFAULT_CONFIG_PATH = join(WORKERCLAW_DIR, 'config.json');

/** 配置区域 */
type ConfigSection = 'platform' | 'llm' | 'personality' | 'security' | 'skills' | 'enterprise' | 'webcli';

/**
 * 交互式配置向导
 */
export async function configureWizard(
  section?: string,
  configPath?: string,
): Promise<void> {
  const cfgPath = configPath || DEFAULT_CONFIG_PATH;
  const existingConfig = loadExistingConfig(cfgPath);

  // 如果指定了 section，直接进入对应区域（跳过快捷菜单）
  if (section) {
    intro('🦞 WorkerClaw 配置向导');
    console.log('  让我们快速配置你的打工虾！\n');
    await runSections([section as ConfigSection], existingConfig, cfgPath);
    return;
  }

  // 已有配置时，显示快捷菜单
  if (existingConfig?.platform?.botId) {
    intro('🦞 WorkerClaw 配置管理');

    const botName = existingConfig.personality?.name || existingConfig.platform.agentName || '未设置';
    const botId = existingConfig.platform.botId;
    const llmModel = existingConfig.llm?.model || '未知';
    const apiUrl = existingConfig.platform.apiUrl || '未知';

    console.log('');
    console.log(`  📄 配置文件: ${cfgPath}`);
    console.log(`  👤 Bot 名称:  ${botName}`);
    console.log(`  🤖 Bot ID:    ${botId}`);
    console.log(`  🧠 模型:      ${llmModel}`);
    console.log(`  🌐 平台:      ${apiUrl}`);
    console.log('');

    const choice = await select('选择操作', [
      { value: 'name', label: '修改 Bot 名称', hint: `当前: ${botName}` },
      { value: 'llm', label: '修改大模型配置', hint: `当前: ${llmModel}` },
      { value: 'api_key', label: '修改 API Key', hint: 'LLM / 平台 Token' },
      { value: 'platform', label: '修改平台地址', hint: `当前: ${apiUrl}` },
      { value: 'webcli', label: '🌐 Web CLI 模式', hint: `当前: ${existingConfig.webCli?.mode === 'local' ? '本地桥接' : '平台代理'}` },
      { value: 'active', label: '智能活跃设置', hint: '发推文/浏览/评论等自动行为' },
      { value: 'enterprise', label: '🏢 企业版配置', hint: `模式: ${existingConfig.mode === 'private' ? '🔒 私有虾' : '🌐 公有'}` },
      { value: 'full', label: '完全重新配置', hint: '包括重新注册 Bot' },
    ], 'name');

    if (!choice) {
      outro('配置未修改');
      return;
    }

    switch (choice) {
      case 'name':
        await quickChangeName(existingConfig, cfgPath);
        break;
      case 'llm':
        await runSections(['llm'], existingConfig, cfgPath);
        break;
      case 'api_key':
        await quickChangeApiKey(existingConfig, cfgPath);
        break;
      case 'platform':
        await quickChangePlatform(existingConfig, cfgPath);
        break;
      case 'webcli':
        await quickChangeWebCli(existingConfig, cfgPath);
        break;
      case 'active':
        await quickToggleActive(existingConfig, cfgPath);
        break;
      case 'enterprise':
        await handleEnterprise(existingConfig, cfgPath);
        break;
      case 'full':
        intro('🦞 WorkerClaw 配置向导');
        console.log('  让我们快速配置你的打工虾！\n');
        await runSections(['platform', 'llm', 'personality'], null, cfgPath);
        break;
    }
    return;
  }

  // 首次配置，走完整流程
  intro('🦞 WorkerClaw 配置向导');
  console.log('  让我们快速配置你的打工虾！\n');
  const sections = resolveSections(undefined, existingConfig ?? undefined);
  await runSections(sections, existingConfig, cfgPath);
}

/**
 * 快捷修改 Bot 名称
 */
async function quickChangeName(existing: Partial<WorkerClawConfig> | null, cfgPath: string): Promise<void> {
  const currentName = existing?.personality?.name || existing?.platform?.agentName || '';
  const newName = await text('新的 Bot 名称', undefined, currentName);
  if (!newName || newName === currentName) {
    outro('名称未修改');
    return;
  }

  const finalConfig = buildFinalConfig(existing, {
    personality: { name: newName, tone: existing?.personality?.tone ?? '', bio: existing?.personality?.bio ?? '' },
    platform: { agentName: newName } as any,
  });
  saveConfig(cfgPath, finalConfig);

  console.log('');
  console.log(`✅ Bot 名称已更新: ${currentName} → ${newName}`);

  // 尝试同步到平台
  if (existing?.platform?.botId && existing?.platform?.token) {
    const spin = spinner();
    spin.start('正在同步名称到平台...');
    try {
      const resp = await fetch(
        `${finalConfig.platform.apiUrl}/api/bot/${existing.platform.botId}/profile`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Bot-Token': existing.platform.token },
          body: JSON.stringify({ nickname: newName }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (resp.ok) {
        spin.stop('名称已同步到智工坊平台');
      } else {
        spin.stop(`平台同步失败 (HTTP ${resp.status})，名称仅本地生效`);
      }
    } catch {
      spin.stop('平台同步失败，名称仅本地生效');
    }
  }

  outro('配置已保存');
}

/**
 * 快捷修改 API Key
 */
async function quickChangeApiKey(existing: Partial<WorkerClawConfig> | null, cfgPath: string): Promise<void> {
  const choice = await select('选择要修改的 Key', [
    { value: 'llm', label: 'LLM API Key', hint: `当前: ${(existing?.llm?.apiKey || '').slice(0, 12)}...` },
    { value: 'token', label: '平台 Token', hint: `当前: ${(existing?.platform?.token || '').slice(0, 12)}...` },
  ], 'llm');

  if (!choice) {
    outro('未修改');
    return;
  }

  if (choice === 'llm') {
    const newKey = await password('新的 LLM API Key');
    if (!newKey) { outro('未修改'); return; }

    const finalConfig = buildFinalConfig(existing, { llm: { apiKey: newKey } } as any);
    saveConfig(cfgPath, finalConfig);
    console.log(`\n✅ LLM API Key 已更新`);
  } else {
    const newToken = await password('新的平台 Token');
    if (!newToken) { outro('未修改'); return; }

    const finalConfig = buildFinalConfig(existing, { platform: { token: newToken } } as any);
    saveConfig(cfgPath, finalConfig);
    console.log(`\n✅ 平台 Token 已更新`);
  }

  outro('配置已保存');
}

/**
 * 快捷修改平台地址
 */
async function quickChangePlatform(existing: Partial<WorkerClawConfig> | null, cfgPath: string): Promise<void> {
  const currentApiUrl = existing?.platform?.apiUrl || DEFAULT_PLATFORM_URL;
  const currentWsUrl = existing?.platform?.wsUrl || DEFAULT_WS_URL;

  const newApiUrl = await text('平台 API 地址', undefined, currentApiUrl);
  if (!newApiUrl) { outro('未修改'); return; }

  const newWsUrl = await text('平台 WebSocket 地址', undefined, currentWsUrl);
  if (!newWsUrl) { outro('未修改'); return; }

  const finalConfig = buildFinalConfig(existing, {
    platform: { apiUrl: newApiUrl.replace(/\/$/, ''), wsUrl: newWsUrl.replace(/\/$/, '') } as any,
  });
  saveConfig(cfgPath, finalConfig);
  console.log(`\n✅ 平台地址已更新`);
  console.log(`   API: ${currentApiUrl} → ${newApiUrl.replace(/\/$/, '')}`);
  console.log(`   WS:  ${currentWsUrl} → ${newWsUrl.replace(/\/$/, '')}`);

  outro('配置已保存');
}

/**
 * 快捷切换 Web CLI 模式
 */
async function quickChangeWebCli(existing: Partial<WorkerClawConfig> | null, cfgPath: string): Promise<void> {
  const result = await quickToggleWebCli(existing?.webCli);
  if (!result) {
    outro('未修改');
    return;
  }

  const finalConfig = buildFinalConfig(existing, { webCli: result } as any);
  saveConfig(cfgPath, finalConfig);
  outro('配置已保存');
}

/**
 * 快捷切换智能活跃
 */
async function quickToggleActive(existing: Partial<WorkerClawConfig> | null, cfgPath: string): Promise<void> {
  const enabled = existing?.activeBehavior?.enabled ?? true;
  const choice = await select('智能活跃设置', [
    { value: 'toggle', label: enabled ? '禁用智能活跃' : '启用智能活跃', hint: enabled ? '当前: 已启用' : '当前: 已禁用' },
    { value: 'interval', label: '修改检查间隔', hint: `当前: ${((existing?.activeBehavior?.checkIntervalMs ?? 300000) / 1000 / 60).toFixed(0)} 分钟` },
  ], 'toggle');

  if (!choice) { outro('未修改'); return; }

  const finalConfig = buildFinalConfig(existing, {});
  if (choice === 'toggle') {
    finalConfig.activeBehavior = {
      ...finalConfig.activeBehavior!,
      enabled: !enabled,
    };
    console.log(`\n✅ 智能活跃已${!enabled ? '启用' : '禁用'}`);
  } else {
    const minutes = await num('检查间隔（分钟）', (existing?.activeBehavior?.checkIntervalMs ?? 300000) / 1000 / 60, 1, 60);
    if (!minutes) { outro('未修改'); return; }
    finalConfig.activeBehavior = {
      ...finalConfig.activeBehavior!,
      checkIntervalMs: minutes * 60 * 1000,
    };
    console.log(`\n✅ 检查间隔已更新为 ${minutes} 分钟`);
  }

  saveConfig(cfgPath, finalConfig);
  outro('配置已保存');
}

/**
 * 企业版配置处理
 */
async function handleEnterprise(existing: Partial<WorkerClawConfig> | null, cfgPath: string): Promise<void> {
  const results = await configureEnterprise(existing, cfgPath);
  if (results && Object.keys(results).length > 0) {
    const finalConfig = buildFinalConfig(existing, results);
    saveConfig(cfgPath, finalConfig);

    if (results.mode) {
      console.log(`\n✅ 运行模式已切换为: ${results.mode === 'private' ? '🔒 私有虾' : '🌐 公有打工虾'}`);
    }
    if (results.enterprise) {
      console.log(`\n✅ 企业版已激活`);
    }
    if (results.personality?.customSystemPrompt) {
      console.log(`\n✅ 专属知识已设置 (${results.personality.customSystemPrompt.length} 字符)`);
    }
    if (results.mediaDir) {
      console.log(`\n✅ 媒体资料库目录: ${results.mediaDir}`);
    }

    outro('配置已保存');
  }
}

/**
 * 按区域执行配置流程
 */
async function runSections(
  sections: ConfigSection[],
  existingConfig: Partial<WorkerClawConfig> | null,
  cfgPath: string,
): Promise<void> {
  const results: Partial<WorkerClawConfig> = {};

  for (const sec of sections) {
    const spin = spinner();
    switch (sec) {
      case 'platform': {
        spin.start('配置智工坊平台...');
        spin.stop('');
        const result = await configurePlatform(existingConfig?.platform);
        if (!result) {
          outro('配置已取消');
          process.exit(0);
        }
        Object.assign(results, result);
        break;
      }
      case 'llm': {
        const result = await configureLLM(existingConfig?.llm);
        if (!result) {
          outro('配置已取消');
          process.exit(0);
        }
        Object.assign(results, result);
        break;
      }
      case 'personality': {
        const platformAgentName = results.platform?.agentName;
        const result = await configurePersonality(
          existingConfig?.personality,
          platformAgentName || undefined,
        );
        if (!result) {
          outro('配置已取消');
          process.exit(0);
        }
        Object.assign(results, result);
        break;
      }
      case 'security': {
        const result = await configureSecurity(existingConfig?.security);
        if (!result) {
          outro('配置已取消');
          process.exit(0);
        }
        Object.assign(results, result);
        break;
      }
    }
  }

  // 合并配置
  const finalConfig = buildFinalConfig(existingConfig, results);

  // 智能活跃行为确认（只在已有配置时询问，首次配置默认启用）
  if (existingConfig?.platform?.botId) {
    const enableActive = await confirm(
      '是否启用智能活跃？（发推文/浏览/评论/点赞等自动行为）',
      finalConfig.activeBehavior?.enabled ?? true,
    );
    finalConfig.activeBehavior = {
      enabled: enableActive,
      checkIntervalMs: finalConfig.activeBehavior?.checkIntervalMs ?? DEFAULT_CONFIG.activeBehavior!.checkIntervalMs,
      minIdleTimeMs: finalConfig.activeBehavior?.minIdleTimeMs ?? DEFAULT_CONFIG.activeBehavior!.minIdleTimeMs,
      weights: finalConfig.activeBehavior?.weights ?? DEFAULT_CONFIG.activeBehavior!.weights,
    };
  }

  // 确认保存
  const shouldSave = await confirm('保存配置？', true);
  if (!shouldSave) {
    outro('配置未保存');
    process.exit(0);
  }

  // 保存配置文件
  saveConfig(cfgPath, finalConfig);

  // 打印配置摘要
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 配置已保存，请妥善保管以下信息：');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  📁 配置文件: ${cfgPath}`);
  console.log(`  🤖 Bot ID:   ${finalConfig.platform.botId}`);
  console.log(`  🔑 Token:    ${finalConfig.platform.token}`);
  console.log(`  👤 Agent:    ${finalConfig.personality?.name || finalConfig.platform.agentName || '未设置'}`);
  console.log(`  🧠 LLM:      ${finalConfig.llm.provider} / ${finalConfig.llm.model}`);
  console.log(`  🤖 智能活跃: ${finalConfig.activeBehavior?.enabled ? '已启用' : '已禁用'}`);
  console.log(`  🌐 WebSocket: ${finalConfig.platform.wsUrl}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  运行 workerclaw start 启动打工虾！');
  console.log('');

  outro('配置完成！');
}

/**
 * 选择配置区域
 */
async function chooseSections(existing?: Partial<WorkerClawConfig>): Promise<ConfigSection[]> {
  const sections: Array<{ value: ConfigSection; label: string; hint: string }> = [
    { value: 'platform', label: '智工坊平台', hint: '注册/配置平台连接' },
    { value: 'llm', label: '大模型配置', hint: '选择 LLM 提供商和模型' },
    { value: 'personality', label: '人格配置', hint: '名称、语气、简介' },
    { value: 'security', label: '安全配置', hint: '权限级别、内容扫描' },
  ];

  // 如果没有现有配置，默认全选
  if (!existing?.platform?.botId && !existing?.llm?.apiKey) {
    return ['platform', 'llm', 'personality'];
  }

  const selected = await select(
    '选择要配置的区域（空格多选）',
    sections,
    'platform',
  );

  return selected ? [selected as ConfigSection] : ['platform', 'llm', 'personality'];
}

/**
 * 解析要配置的区域
 */
function resolveSections(
  section?: string,
  existing?: Partial<WorkerClawConfig>,
): ConfigSection[] {
  if (section) {
    return [section as ConfigSection];
  }

  // 没有指定 section，根据现有配置判断需要配置什么
  const needs: ConfigSection[] = [];

  if (!existing?.platform?.botId || !existing?.platform?.token) {
    needs.push('platform');
  }
  if (!existing?.llm?.apiKey || !existing?.llm?.baseUrl) {
    needs.push('llm');
  }
  if (!existing?.personality?.name) {
    needs.push('personality');
  }

  // 如果都有配置，让用户选择
  if (needs.length === 0) {
    return ['platform', 'llm', 'personality'];
  }

  return needs;
}

/**
 * 加载现有配置
 */
function loadExistingConfig(configPath: string): Partial<WorkerClawConfig> | null {
  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // 配置文件损坏，忽略
  }
  return null;
}

/**
 * 构建最终配置
 */
function buildFinalConfig(
  existing: Partial<WorkerClawConfig> | null,
  newValues: Partial<WorkerClawConfig>,
): WorkerClawConfig {
  return {
    id: existing?.id || 'worker-' + Math.random().toString(36).slice(2, 8),
    name: existing?.name || 'WorkerClaw',
    mode: newValues.mode || existing?.mode || 'public',
    enterprise: (newValues as any).enterprise || existing?.enterprise,
    mediaDir: (newValues as any).mediaDir || existing?.mediaDir,
    whatsapp: (newValues as any).whatsapp || existing?.whatsapp,
    platform: {
      apiUrl: newValues.platform?.apiUrl || existing?.platform?.apiUrl || DEFAULT_PLATFORM_URL,
      wsUrl: newValues.platform?.wsUrl || existing?.platform?.wsUrl || DEFAULT_WS_URL,
      botId: newValues.platform?.botId || existing?.platform?.botId || '',
      token: newValues.platform?.token || existing?.platform?.token || '',
      agentName: newValues.platform?.agentName || existing?.platform?.agentName,
      reconnect: newValues.platform?.reconnect || existing?.platform?.reconnect || {
        maxRetries: 5,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      },
    },
    llm: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/v1',
      safety: { maxTokens: 4096, temperature: 0.7, topP: 0.9 },
      retry: { maxRetries: 3, backoffMs: 2000 },
      ...existing?.llm,
      ...newValues.llm,
    } as any,
    security: {
      ...DEFAULT_CONFIG.security,
      ...existing?.security,
      ...newValues.security,
    } as any,
    task: {
      ...DEFAULT_CONFIG.task,
      ...existing?.task,
      ...newValues.task,
    } as any,
    personality: {
      ...DEFAULT_CONFIG.personality,
      ...existing?.personality,
      ...newValues.personality,
    } as any,
    activeBehavior: {
      ...DEFAULT_CONFIG.activeBehavior,
      ...existing?.activeBehavior,
    },
    // 运营指挥官配置
    weiboCommander: (newValues as any).weiboCommander || existing?.weiboCommander,
    xhsCommander: (newValues as any).xhsCommander || existing?.xhsCommander,
    douyinCommander: (newValues as any).douyinCommander || existing?.douyinCommander,
    zhihuCommander: (newValues as any).zhihuCommander || existing?.zhihuCommander,
    // Web CLI 配置
    webCli: (newValues as any).webCli || existing?.webCli,
  } as WorkerClawConfig;
}

/**
 * 保存配置文件
 */
function saveConfig(configPath: string, config: WorkerClawConfig): void {
  const dir = join(configPath, '..');

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // 保存完整配置
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
