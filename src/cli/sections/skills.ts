/**
 * WorkerClaw CLI - 技能管理 section
 * 
 * 列出、安装、卸载技能包
 */

import { select, text, spinner, intro, outro } from '../prompter.js';
import { SkillPackLoader } from '../../skills/pack-loader.js';
import { SkillPackRegistry } from '../../skills/pack-registry.js';
import { getBuiltinSkills } from '../../skills/builtin/index.js';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = join(homedir(), '.workerclaw');
const SKILLS_FILE = join(DATA_DIR, 'skills.json');

/**
 * 技能管理命令
 */
export async function manageSkills(action?: string): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const registry = new SkillPackRegistry(SKILLS_FILE);

  switch (action) {
    case 'list':
      await listSkills(registry);
      break;
    case 'install':
      await installSkill(registry);
      break;
    case 'uninstall':
      await uninstallSkill(registry);
      break;
    default:
      await skillMenu(registry);
      break;
  }
}

/**
 * 技能菜单
 */
async function skillMenu(registry: SkillPackRegistry): Promise<void> {
  intro('技能管理');

  const action = await select(
    '选择操作',
    [
      { value: 'list', label: '列出已安装技能', hint: '查看所有可用技能' },
      { value: 'install', label: '安装技能包', hint: '从 npm 或本地路径安装' },
      { value: 'uninstall', label: '卸载技能', hint: '移除已安装的技能' },
    ],
  );

  if (!action) return;

  switch (action) {
    case 'list':
      await listSkills(registry);
      break;
    case 'install':
      await installSkill(registry);
      break;
    case 'uninstall':
      await uninstallSkill(registry);
      break;
  }
}

/**
 * 列出技能
 */
async function listSkills(registry: SkillPackRegistry): Promise<void> {
  intro('已安装技能');

  // 列出内置技能
  const builtins = getBuiltinSkills();
  console.log('\n📦 内置技能:');
  for (const skill of builtins) {
    const meta = skill.metadata;
    console.log(`  ● ${meta.displayName} (${meta.name}) v${meta.version}`);
    console.log(`    ${meta.description}`);
    console.log(`    权限: ${meta.requiredLevel} | 任务: ${meta.applicableTaskTypes.join(', ') || '所有'}`);
  }

  // WhatsApp 技能（需要额外配置）
  console.log('\n📱 可选技能（需配置启用）:');
  console.log(`  ○ WhatsApp 消息 (whatsapp)`);
  console.log(`    接收和发送 WhatsApp 消息，支持文本、图片、文档`);
  console.log(`    配置: config.json 中设置 whatsapp.enabled = true`);

  // 列出已安装的外部技能
  const installed = registry.list();
  if (installed.length > 0) {
    console.log('\n🔌 已安装技能包:');
    for (const item of installed) {
      console.log(`  ● ${item.source} v${item.version}`);
      console.log(`    安装于: ${new Date(item.installedAt).toLocaleString('zh-CN')}`);
    }
  } else {
    console.log('\n🔌 未安装外部技能包');
  }

  console.log(`\n共 ${builtins.length} 个内置技能 + 1 个可选技能 + ${installed.length} 个外部技能包`);
  outro('');
}

/**
 * 安装技能包
 */
async function installSkill(registry: SkillPackRegistry): Promise<void> {
  intro('安装技能包');

  const source = await text(
    '技能包来源（npm 包名或本地路径）',
  );

  if (!source) {
    outro('已取消');
    return;
  }

  const spin = spinner();
  spin.start(`正在安装: ${source}`);

  try {
    const loader = new SkillPackLoader();
    const pack = await loader.load(source);

    // 注册到技能包管理器
    registry.add({
      source,
      version: pack.version,
      installedAt: new Date().toISOString(),
      name: pack.name,
      description: pack.description,
    });

    spin.stop(`安装成功: ${pack.name} v${pack.version}`);
    outro(`已安装 ${pack.skills?.length || 0} 个技能`);
  } catch (err) {
    spin.stop(`安装失败: ${(err as Error).message}`);
    outro('安装失败，请检查包名或路径');
  }
}

/**
 * 卸载技能包
 */
async function uninstallSkill(registry: SkillPackRegistry): Promise<void> {
  const installed = registry.list();

  if (installed.length === 0) {
    outro('没有已安装的外部技能包');
    return;
  }

  intro('卸载技能包');

  const name = await select(
    '选择要卸载的技能包',
    installed.map(item => ({
      value: item.source,
      label: `${item.name || item.source} (${item.version})`,
      hint: `安装于 ${new Date(item.installedAt).toLocaleString('zh-CN')}`,
    })),
  );

  if (!name) {
    outro('已取消');
    return;
  }

  const confirm = await text(`确认卸载 ${name}？(y/N)`, 'N');
  if (!confirm || confirm.toLowerCase() !== 'y') {
    outro('已取消');
    return;
  }

  registry.remove(name);
  outro(`已卸载: ${name}`);
}
