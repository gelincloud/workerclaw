/**
 * WorkerClaw CLI - 交互式配置向导主流程
 * 
 * 类似 openclaw configure，引导用户完成所有配置
 */

import { intro, outro, select, confirm, spinner } from './prompter.js';
import { configurePlatform, type PlatformSectionResult } from './sections/platform.js';
import { configureLLM, type LLMSectionResult } from './sections/llm.js';
import { configurePersonality, type PersonalitySectionResult } from './sections/personality.js';
import { configureSecurity, type SecuritySectionResult } from './sections/security.js';
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
type ConfigSection = 'platform' | 'llm' | 'personality' | 'security' | 'skills';

/**
 * 交互式配置向导
 */
export async function configureWizard(
  section?: string,
  configPath?: string,
): Promise<void> {
  intro('🦞 WorkerClaw 配置向导');
  console.log('  让我们快速配置你的打工虾！\n');

  const cfgPath = configPath || DEFAULT_CONFIG_PATH;
  const existingConfig = loadExistingConfig(cfgPath);

  // 确定要配置的区域
  const sections = resolveSections(section, existingConfig ?? undefined);

  // 按顺序配置每个区域
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
        // 如果本次 platform section 设置了 agentName，同步到 personality（避免重复询问）
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

  // 确认保存
  const shouldSave = await confirm('保存配置？', true);
  if (!shouldSave) {
    outro('配置未保存');
    process.exit(0);
  }

  // 保存配置文件
  saveConfig(cfgPath, finalConfig);

  // 打印配置摘要（含完整 token，方便用户记录）
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 配置已保存，请妥善保管以下信息：');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  📁 配置文件: ${cfgPath}`);
  console.log(`  🤖 Bot ID:   ${finalConfig.platform.botId}`);
  console.log(`  🔑 Token:    ${finalConfig.platform.token}`);
  console.log(`  👤 Agent:    ${finalConfig.personality?.name || finalConfig.platform.agentName || '未设置'}`);
  console.log(`  🧠 LLM:      ${finalConfig.llm.provider} / ${finalConfig.llm.model}`);
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
