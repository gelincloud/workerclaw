/**
 * WorkerClaw CLI - 运营指挥官配置
 * 
 * Agent PR = Agent Public Relations（Agent 公关/运营）
 * 包含：
 * 1. 微博运营指挥官配置
 * 2. 小红书运营指挥官配置
 * 3. 抖音运营指挥官配置
 * 
 * 注意：此功能需要企业版 License
 */

import { intro, outro, select, confirm, text, num, spinner } from '../prompter.js';
import { isEnterpriseActivated } from '../license.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_PLATFORM_URL } from '../configure.js';

/** 运营模板定义 */
const WEIBO_TEMPLATES = [
  { id: 'standard', name: '标准运营', desc: '早8/午12/晚20/22 - 适合大多数账号' },
  { id: 'aggressive', name: '激进增长', desc: '高频发布(6次/天) - 快速涨粉阶段' },
  { id: 'minimal', name: '轻量维护', desc: '每日1发+回复 - 维持活跃度' },
  { id: 'api_test', name: 'API测试', desc: '测试所有API端点 - 调试用' },
];

const XHS_TEMPLATES = [
  { id: 'standard', name: '标准运营', desc: '早8/午12/晚20/22 - 适合大多数账号' },
  { id: 'aggressive', name: '激进增长', desc: '高频发布(4-6次/天) - 快速涨粉阶段' },
  { id: 'minimal', name: '轻量维护', desc: '每日1发+回复 - 维持活跃度' },
  { id: 'api_test', name: 'API测试', desc: '测试所有API端点 - 调试用' },
];

const DOUYIN_TEMPLATES = [
  { id: 'standard', name: '标准运营', desc: '早8/午12/晚20/22 - 适合大多数账号' },
  { id: 'aggressive', name: '激进增长', desc: '高频互动 - 快速涨粉阶段' },
  { id: 'minimal', name: '轻量维护', desc: '每日检查+互动 - 维持活跃度' },
  { id: 'api_test', name: 'API测试', desc: '测试所有API端点 - 调试用' },
];

const WORKERCLAW_DIR = join(homedir(), '.workerclaw');

/**
 * 运营指挥官配置入口
 */
export async function configureAgentPR(existing: any, cfgPath: string): Promise<any> {
  intro('📢 运营指挥官配置');

  // 企业版检查
  if (!isEnterpriseActivated(existing)) {
    console.log('');
    console.log('  ⚠️  运营指挥官需要企业版 License');
    console.log('  Agent PR 功能仅限企业版用户使用');
    console.log('');
    console.log('  📋 购买企业版 License: https://www.miniabc.top/enterprise.html');
    console.log('');
    outro('请先激活企业版');
    return {};
  }

  const currentMode = existing?.mode || 'public';
  if (currentMode !== 'private') {
    console.log('');
    console.log('  ℹ️  运营指挥官主要服务于私有虾模式');
    console.log('  公有打工虾也可以启用，但功能受限');
    console.log('');
  }

  // 显示当前状态
  const weiboEnabled = existing?.weiboCommander?.enabled || false;
  const xhsEnabled = existing?.xhsCommander?.enabled || false;
  const douyinEnabled = existing?.douyinCommander?.enabled || false;

  console.log(`  微博指挥官: ${weiboEnabled ? '✅ 已启用' : '❌ 未启用'}`);
  console.log(`  小红书指挥官: ${xhsEnabled ? '✅ 已启用' : '❌ 未启用'}`);
  console.log(`  抖音指挥官: ${douyinEnabled ? '✅ 已启用' : '❌ 未启用'}`);
  console.log('');

  const choice = await select('选择操作', [
    { value: 'weibo', label: '📱 微博运营指挥官', hint: weiboEnabled ? '已启用' : '配置微博自动化运营' },
    { value: 'xhs', label: '📕 小红书运营指挥官', hint: xhsEnabled ? '已启用' : '配置小红书自动化运营' },
    { value: 'douyin', label: '🎵 抖音运营指挥官', hint: douyinEnabled ? '已启用' : '配置抖音自动化运营' },
    { value: 'disable_all', label: '🚫 禁用所有指挥官', hint: '停止所有自动化运营' },
  ], 'weibo');

  if (!choice) {
    outro('未修改');
    return {};
  }

  switch (choice) {
    case 'weibo':
      return await configureWeiboCommander(existing, cfgPath);
    case 'xhs':
      return await configureXhsCommander(existing, cfgPath);
    case 'douyin':
      return await configureDouyinCommander(existing, cfgPath);
    case 'disable_all':
      return await disableAllCommanders(existing);
  }

  return {};
}

/**
 * 微博运营指挥官配置
 */
async function configureWeiboCommander(existing: any, cfgPath: string): Promise<any> {
  console.log('');
  console.log('  ━━━ 微博运营指挥官 ━━━');
  console.log('  自动采集账号数据、分析运营策略、生成定时任务');
  console.log('');

  const currentConfig = existing?.weiboCommander || {};
  const isEnabled = currentConfig.enabled || false;

  // 是否启用
  const enable = await confirm(
    `是否启用微博运营指挥官？`,
    isEnabled,
  );

  if (!enable) {
    console.log('');
    console.log('  ✅ 微博指挥官已禁用');
    return {
      weiboCommander: {
        ...currentConfig,
        enabled: false,
      },
    };
  }

  // 选择运营模板
  console.log('');
  const currentTemplate = currentConfig.templateId || 'standard';
  const templateChoice = await select(
    '选择运营模板',
    WEIBO_TEMPLATES.map(t => ({
      value: t.id,
      label: t.name,
      hint: t.desc,
    })),
    currentTemplate,
  );

  // 高级设置
  const advanced = await confirm('配置高级设置？', false);

  let collection = currentConfig.collection || {
    intervalMs: 30 * 60 * 1000, // 30分钟
    collectTrending: true,
    collectInteractions: true,
  };

  let automation = currentConfig.automation || {
    autoPost: true,
    autoReply: true,
    maxPostsPerDay: 5,
    maxRepliesPerDay: 50,
    requireConfirmation: false,
  };

  if (advanced) {
    console.log('');
    console.log('  ━━━ 高级设置 ━━━');
    console.log('');

    // 采集间隔
    const intervalMinutes = await num(
      '数据采集间隔（分钟）',
      (collection.intervalMs || 1800000) / 60000,
      5,
      120,
    );
    if (intervalMinutes) {
      collection.intervalMs = intervalMinutes * 60 * 1000;
    }

    // 每日上限
    const maxPosts = await num(
      '每日最大发布数',
      automation.maxPostsPerDay || 5,
      1,
      20,
    );
    if (maxPosts !== null) {
      automation.maxPostsPerDay = maxPosts;
    }

    const maxReplies = await num(
      '每日最大回复数',
      automation.maxRepliesPerDay || 50,
      1,
      200,
    );
    if (maxReplies !== null) {
      automation.maxRepliesPerDay = maxReplies;
    }

    // 执行确认
    automation.requireConfirmation = await confirm(
      '执行任务前需要确认？',
      automation.requireConfirmation || false,
    );
  }

  // 数据目录
  const dataDir = currentConfig.dataDir || join(WORKERCLAW_DIR, 'data', 'weibo-commander');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  console.log('');
  console.log('  ✅ 微博运营指挥官配置完成');
  console.log(`     模板: ${WEIBO_TEMPLATES.find(t => t.id === templateChoice)?.name}`);
  console.log(`     采集间隔: ${(collection.intervalMs / 60000).toFixed(0)} 分钟`);
  console.log(`     每日发布上限: ${automation.maxPostsPerDay}`);
  console.log('');

  return {
    weiboCommander: {
      enabled: true,
      templateId: templateChoice || currentTemplate,
      collection,
      automation,
      dataDir,
    },
  };
}

/**
 * 小红书运营指挥官配置
 */
async function configureXhsCommander(existing: any, cfgPath: string): Promise<any> {
  console.log('');
  console.log('  ━━━ 小红书运营指挥官 ━━━');
  console.log('  自动采集账号数据、分析运营策略、生成定时任务');
  console.log('');

  const currentConfig = existing?.xhsCommander || {};
  const isEnabled = currentConfig.enabled || false;

  // 是否启用
  const enable = await confirm(
    `是否启用小红书运营指挥官？`,
    isEnabled,
  );

  if (!enable) {
    console.log('');
    console.log('  ✅ 小红书指挥官已禁用');
    return {
      xhsCommander: {
        ...currentConfig,
        enabled: false,
      },
    };
  }

  // 选择运营模板
  console.log('');
  const currentTemplate = currentConfig.templateId || 'standard';
  const templateChoice = await select(
    '选择运营模板',
    XHS_TEMPLATES.map(t => ({
      value: t.id,
      label: t.name,
      hint: t.desc,
    })),
    currentTemplate,
  );

  // 高级设置
  const advanced = await confirm('配置高级设置？', false);

  let collection = currentConfig.collection || {
    intervalMs: 30 * 60 * 1000,
    collectHotFeed: true,
    collectInteractions: true,
  };

  let automation = currentConfig.automation || {
    autoPost: true,
    autoReply: true,
    autoFollow: false,
    maxPostsPerDay: 3,
    maxRepliesPerDay: 30,
    requireConfirmation: false,
  };

  if (advanced) {
    console.log('');
    console.log('  ━━━ 高级设置 ━━━');
    console.log('');

    // 采集间隔
    const intervalMinutes = await num(
      '数据采集间隔（分钟）',
      (collection.intervalMs || 1800000) / 60000,
      5,
      120,
    );
    if (intervalMinutes) {
      collection.intervalMs = intervalMinutes * 60 * 1000;
    }

    // 每日上限
    const maxPosts = await num(
      '每日最大发布数',
      automation.maxPostsPerDay || 3,
      1,
      15,
    );
    if (maxPosts !== null) {
      automation.maxPostsPerDay = maxPosts;
    }

    const maxReplies = await num(
      '每日最大回复数',
      automation.maxRepliesPerDay || 30,
      1,
      100,
    );
    if (maxReplies !== null) {
      automation.maxRepliesPerDay = maxReplies;
    }

    // 自动关注
    automation.autoFollow = await confirm(
      '启用自动关注？',
      automation.autoFollow || false,
    );

    // 执行确认
    automation.requireConfirmation = await confirm(
      '执行任务前需要确认？',
      automation.requireConfirmation || false,
    );
  }

  // 数据目录
  const dataDir = currentConfig.dataDir || join(WORKERCLAW_DIR, 'data', 'xhs-commander');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  console.log('');
  console.log('  ✅ 小红书运营指挥官配置完成');
  console.log(`     模板: ${XHS_TEMPLATES.find(t => t.id === templateChoice)?.name}`);
  console.log(`     采集间隔: ${(collection.intervalMs! / 60000).toFixed(0)} 分钟`);
  console.log(`     每日发布上限: ${automation.maxPostsPerDay}`);
  console.log('');

  return {
    xhsCommander: {
      enabled: true,
      templateId: templateChoice || currentTemplate,
      collection,
      automation,
      dataDir,
    },
  };
}

/**
 * 抖音运营指挥官配置
 */
async function configureDouyinCommander(existing: any, cfgPath: string): Promise<any> {
  console.log('');
  console.log('  ━━━ 抖音运营指挥官 ━━━');
  console.log('  自动采集账号数据、分析运营策略、生成定时任务');
  console.log('');

  const currentConfig = existing?.douyinCommander || {};
  const isEnabled = currentConfig.enabled || false;

  // 是否启用
  const enable = await confirm(
    `是否启用抖音运营指挥官？`,
    isEnabled,
  );

  if (!enable) {
    console.log('');
    console.log('  ✅ 抖音指挥官已禁用');
    return {
      douyinCommander: {
        ...currentConfig,
        enabled: false,
      },
    };
  }

  // 选择运营模板
  console.log('');
  const currentTemplate = currentConfig.templateId || 'standard';
  const templateChoice = await select(
    '选择运营模板',
    DOUYIN_TEMPLATES.map(t => ({
      value: t.id,
      label: t.name,
      hint: t.desc,
    })),
    currentTemplate,
  );

  // 高级设置
  const advanced = await confirm('配置高级设置？', false);

  let collection = currentConfig.collection || {
    intervalMs: 30 * 60 * 1000,
    collectTrending: true,
    collectVideos: true,
  };

  let automation = currentConfig.automation || {
    autoPost: true,
    autoReply: true,
    maxPostsPerDay: 3,
    maxRepliesPerDay: 20,
    requireConfirmation: false,
  };

  if (advanced) {
    console.log('');
    console.log('  ━━━ 高级设置 ━━━');
    console.log('');

    // 采集间隔
    const intervalMinutes = await num(
      '数据采集间隔（分钟）',
      (collection.intervalMs || 1800000) / 60000,
      5,
      120,
    );
    if (intervalMinutes) {
      collection.intervalMs = intervalMinutes * 60 * 1000;
    }

    // 每日上限
    const maxPosts = await num(
      '每日最大发布数',
      automation.maxPostsPerDay || 3,
      1,
      10,
    );
    if (maxPosts !== null) {
      automation.maxPostsPerDay = maxPosts;
    }

    const maxReplies = await num(
      '每日最大回复数',
      automation.maxRepliesPerDay || 20,
      1,
      100,
    );
    if (maxReplies !== null) {
      automation.maxRepliesPerDay = maxReplies;
    }

    // 执行确认
    automation.requireConfirmation = await confirm(
      '执行任务前需要确认？',
      automation.requireConfirmation || false,
    );
  }

  // 数据目录
  const dataDir = currentConfig.dataDir || join(WORKERCLAW_DIR, 'data', 'douyin-commander');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  console.log('');
  console.log('  ✅ 抖音运营指挥官配置完成');
  console.log(`     模板: ${DOUYIN_TEMPLATES.find(t => t.id === templateChoice)?.name}`);
  console.log(`     采集间隔: ${(collection.intervalMs! / 60000).toFixed(0)} 分钟`);
  console.log(`     每日发布上限: ${automation.maxPostsPerDay}`);
  console.log('');

  return {
    douyinCommander: {
      enabled: true,
      templateId: templateChoice || currentTemplate,
      collection,
      automation,
      dataDir,
    },
  };
}

/**
 * 禁用所有指挥官
 */
async function disableAllCommanders(existing: any): Promise<any> {
  console.log('');

  const confirmDisable = await confirm('确认禁用所有运营指挥官？', false);
  if (!confirmDisable) {
    outro('未修改');
    return {};
  }

  console.log('');
  console.log('  ✅ 已禁用所有运营指挥官');
  console.log('');

  return {
    weiboCommander: {
      ...existing?.weiboCommander,
      enabled: false,
    },
    xhsCommander: {
      ...existing?.xhsCommander,
      enabled: false,
    },
    douyinCommander: {
      ...existing?.douyinCommander,
      enabled: false,
    },
  };
}
