/**
 * WorkerClaw CLI - 企业版配置部分
 * 
 * 包含：
 * 1. 运行模式切换（公有打工虾 ↔ 私有虾）
 * 2. License Key 激活
 * 3. 专属知识配置（注入 system prompt）
 * 4. 本地媒体资料库目录配置
 */

import { intro, outro, select, confirm, text, password, spinner } from '../prompter.js';
import { verifyLicense, isEnterpriseActivated, type LicenseVerifyResult } from '../license.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PLATFORM_URL, DEFAULT_CONFIG_PATH, WORKERCLAW_DIR } from '../configure.js';

/**
 * 企业版配置菜单
 */
export async function configureEnterprise(existing: any, cfgPath: string): Promise<any> {
  intro('🏢 企业版配置');

  const currentMode = existing?.mode || 'public';
  const enterpriseActive = isEnterpriseActivated(existing);

  console.log('');
  console.log(`  当前模式: ${currentMode === 'private' ? '🔒 私有虾' : '🌐 公有打工虾'}`);
  console.log(`  企业版: ${enterpriseActive ? '✅ 已激活' : '❌ 未激活'}`);
  if (existing?.enterprise?.expiresAt) {
    console.log(`  到期时间: ${existing.enterprise.expiresAt}`);
  }
  console.log('');

  const choice = await select('选择操作', [
    { value: 'mode', label: '切换运行模式', hint: `当前: ${currentMode === 'private' ? '私有虾' : '公有打工虾'}` },
    { value: 'license', label: '激活企业版 License', hint: enterpriseActive ? '已激活' : '解锁专属知识和媒体库' },
    { value: 'knowledge', label: '配置专属知识', hint: existing?.personality?.customSystemPrompt ? '已设置' : '注入到系统提示中' },
    { value: 'media', label: '配置媒体资料库', hint: existing?.mediaDir ? existing.mediaDir : '设置本地媒体目录' },
  ], 'mode');

  if (!choice) {
    outro('未修改');
    return {};
  }

  switch (choice) {
    case 'mode':
      return await switchMode(existing, cfgPath);
    case 'license':
      return await activateLicense(existing, cfgPath);
    case 'knowledge':
      return await configureKnowledge(existing, cfgPath);
    case 'media':
      return await configureMediaDir(existing, cfgPath);
  }

  return {};
}

/**
 * 切换运行模式
 */
async function switchMode(existing: any, cfgPath: string): Promise<any> {
  const currentMode = existing?.mode || 'public';

  console.log('');
  console.log('  🌐 公有打工虾：接平台任务，智能活跃，公域社交');
  console.log('  🔒 私有虾：专属知识库、媒体资料库，服务特定企业/个人');
  console.log('');

  const newMode = await select('选择模式', [
    { value: 'public', label: '🌐 公有打工虾', hint: '接平台任务，智能活跃' },
    { value: 'private', label: '🔒 私有虾', hint: '专属知识、媒体库' },
  ], currentMode);

  if (!newMode || newMode === currentMode) {
    outro('模式未修改');
    return {};
  }

  // 如果切换到私有模式，检查企业版 License
  if (newMode === 'private' && !isEnterpriseActivated(existing)) {
    console.log('');
    console.log('  ⚠️  私有虾模式需要企业版 License 支持');
    console.log('  专属知识、媒体资料库等功能均需企业版激活');
    console.log('');
    console.log('  📋 购买企业版 License: https://www.miniabc.top/enterprise.html');
    console.log('');

    const activateNow = await confirm('现在输入 License Key 激活企业版？', false);
    if (activateNow) {
      const licenseResult = await activateLicense(existing, cfgPath);
      if (!licenseResult.enterprise) return {};
    } else {
      // 允许切换但不激活企业功能（只有基本私有虾功能）
      console.log('');
      console.log('  ℹ️  未激活企业版，专属知识和媒体库功能不可用');
      console.log('');
    }
  }

  return { mode: newMode };
}

/**
 * 激活企业版 License
 */
async function activateLicense(existing: any, cfgPath: string): Promise<any> {
  console.log('');
  console.log('  📋 购买企业版 License: https://www.miniabc.top/enterprise.html');
  console.log('');

  const licenseKey = await text('输入 License Key');
  if (!licenseKey) {
    outro('未输入 License Key');
    return {};
  }

  const spin = spinner();
  spin.start('正在验证 License...');

  const apiUrl = existing?.platform?.apiUrl || DEFAULT_PLATFORM_URL;
  const result: LicenseVerifyResult = await verifyLicense(licenseKey, apiUrl);

  spin.stop('');

  if (!result.valid) {
    console.log('');
    console.log(`  ❌ License 验证失败: ${result.reason}`);
    console.log('');
    console.log('  💡 购买企业版 License: https://www.miniabc.top/enterprise.html');
    console.log('');

    const retry = await confirm('重新输入？', false);
    if (retry) {
      return await activateLicense(existing, cfgPath);
    }
    outro('激活失败');
    return {};
  }

  console.log('');
  console.log('  ✅ License 验证成功！');
  if (result.plan) console.log(`  📦 套餐: ${result.plan}`);
  if (result.expiresAt) console.log(`  📅 到期: ${result.expiresAt}`);
  console.log('');

  return {
    enterprise: {
      key: licenseKey.trim().toUpperCase(),
      activated: true,
      activatedAt: new Date().toISOString(),
      expiresAt: result.expiresAt,
    },
  };
}

/**
 * 配置专属知识（注入到 system prompt）
 */
async function configureKnowledge(existing: any, cfgPath: string): Promise<any> {
  const currentMode = existing?.mode || 'public';

  if (currentMode !== 'private') {
    console.log('');
    console.log('  ⚠️  专属知识仅私有虾模式可用');
    console.log('');

    const switchToPrivate = await confirm('切换到私有虾模式？', false);
    if (!switchToPrivate) {
      outro('未修改');
      return {};
    }

    // 先切换模式
    const modeResult = await switchMode(existing, cfgPath);
    if (!modeResult.mode || modeResult.mode !== 'private') {
      outro('未修改');
      return {};
    }
  }

  if (!isEnterpriseActivated(existing)) {
    console.log('');
    console.log('  ⚠️  专属知识需要企业版 License');
    console.log('');

    const activateNow = await confirm('现在激活企业版？', false);
    if (!activateNow) {
      outro('未修改');
      return {};
    }

    const licenseResult = await activateLicense(existing, cfgPath);
    if (!licenseResult.enterprise) {
      outro('未修改');
      return {};
    }
  }

  const currentKnowledge = existing?.personality?.customSystemPrompt || '';
  console.log('');
  console.log('  专属知识会被注入到系统提示中，作为 ## 附加指引');
  console.log('  适合填写：企业介绍、产品信息、客服话术、FAQ 等');
  console.log('');

  const knowledge = await text(
    '输入专属知识（支持多行，Ctrl+D 或空行结束）',
    undefined,
    currentKnowledge,
  );

  if (!knowledge || knowledge === currentKnowledge) {
    outro('专属知识未修改');
    return {};
  }

  return {
    personality: {
      customSystemPrompt: knowledge,
    },
  };
}

/**
 * 配置本地媒体资料库目录
 */
async function configureMediaDir(existing: any, cfgPath: string): Promise<any> {
  const currentMode = existing?.mode || 'public';

  if (currentMode !== 'private') {
    console.log('');
    console.log('  ⚠️  媒体资料库仅私有虾模式可用');
    console.log('');

    const switchToPrivate = await confirm('切换到私有虾模式？', false);
    if (!switchToPrivate) {
      outro('未修改');
      return {};
    }
  }

  if (!isEnterpriseActivated(existing)) {
    console.log('');
    console.log('  ⚠️  媒体资料库需要企业版 License');
    console.log('');

    const activateNow = await confirm('现在激活企业版？', false);
    if (!activateNow) {
      outro('未修改');
      return {};
    }

    const licenseResult = await activateLicense(existing, cfgPath);
    if (!licenseResult.enterprise) {
      outro('未修改');
      return {};
    }
  }

  const currentDir = existing?.mediaDir || '';
  console.log('');
  console.log('  媒体资料库用于存放虾可以发送给用户的图片、视频、文档等文件');
  console.log('  虾的 send_file 工具会从该目录读取文件');
  console.log('');

  const defaultDir = currentDir || join(WORKERCLAW_DIR, 'media');
  const mediaDir = await text(
    '媒体资料库目录路径',
    undefined,
    defaultDir,
  );

  if (!mediaDir) {
    outro('未修改');
    return {};
  }

  // 检查目录是否存在，不存在则创建
  if (!existsSync(mediaDir)) {
    const createDir = await confirm(`目录 ${mediaDir} 不存在，是否创建？`, true);
    if (createDir) {
      mkdirSync(mediaDir, { recursive: true });
      console.log(`  ✅ 已创建目录: ${mediaDir}`);
    } else {
      outro('未修改');
      return {};
    }
  }

  console.log(`  ✅ 媒体资料库目录: ${mediaDir}`);

  return { mediaDir };
}
