/**
 * WorkerClaw CLI - WhatsApp 配置部分
 * 
 * 配置 WhatsApp 技能：启用、自动回复设置、会话路径等
 */

import { intro, outro, select, confirm, text, num, spinner } from '../prompter.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WORKERCLAW_DIR } from '../configure.js';

const DEFAULT_SESSION_PATH = './data/whatsapp-session';
const DEFAULT_AUTO_REPLY_PROMPT = `你是一个专业的外贸客服助手，通过 WhatsApp 回答客户关于产品的问题。

回复规则：
1. 用友好的语气回复，可以适当使用 emoji
2. 回复要简洁明了，适合手机阅读
3. 如果不确定产品信息，诚实地告诉客户你会确认后回复
4. 不要编造产品参数或价格
5. 每条回复控制在 200 字以内
6. 如果客户发送了图片，仔细看图理解内容再回复（可能是产品照片、问题截图等）
7. 如果客户发送了视频/文件，回复说已收到并会尽快处理
8. 使用客户使用的语言回复（英语/中文/其他）`;

/**
 * WhatsApp 配置菜单
 */
export async function configureWhatsApp(existing: any, cfgPath: string): Promise<any> {
  intro('📱 WhatsApp 配置');

  const whatsappConfig = existing?.whatsapp || {};
  const isEnabled = whatsappConfig.enabled === true;
  const autoReplyEnabled = whatsappConfig.autoReply?.enabled !== false;

  console.log('');
  console.log(`  当前状态: ${isEnabled ? '✅ 已启用' : '❌ 未启用'}`);
  console.log(`  自动回复: ${autoReplyEnabled ? '✅ 已启用' : '❌ 未启用'}`);
  console.log('');

  const choice = await select('选择操作', [
    { value: 'toggle', label: isEnabled ? '禁用 WhatsApp' : '启用 WhatsApp', hint: isEnabled ? '关闭 WhatsApp 技能' : '开启 WhatsApp 技能' },
    { value: 'autoReply', label: '配置自动回复', hint: 'LLM 自动回复设置' },
    { value: 'session', label: '配置会话路径', hint: whatsappConfig.sessionPath || DEFAULT_SESSION_PATH },
    { value: 'advanced', label: '高级设置', hint: '频率限制、黑名单等' },
  ], 'toggle');

  if (!choice) {
    outro('未修改');
    return {};
  }

  switch (choice) {
    case 'toggle':
      return await toggleWhatsApp(existing, cfgPath);
    case 'autoReply':
      return await configureAutoReply(existing, cfgPath);
    case 'session':
      return await configureSessionPath(existing, cfgPath);
    case 'advanced':
      return await configureAdvanced(existing, cfgPath);
  }

  return {};
}

/**
 * 启用/禁用 WhatsApp
 */
async function toggleWhatsApp(existing: any, cfgPath: string): Promise<any> {
  const currentEnabled = existing?.whatsapp?.enabled === true;
  const newEnabled = !currentEnabled;

  console.log('');
  if (newEnabled) {
    // 检查企业版 License
    const { isEnterpriseActivated } = await import('../license.js');
    if (!isEnterpriseActivated(existing)) {
      console.log('  ❌ 无法启用 WhatsApp 技能');
      console.log('');
      console.log('  ⚠️  WhatsApp 技能需要企业版 License');
      console.log('  请先激活企业版：workerclaw configure > 企业版激活');
      console.log('');
      outro('未修改');
      return {};
    }

    console.log('  ✅ WhatsApp 技能将启用');
    console.log('');
    console.log('  📋 使用步骤：');
    console.log('     1. 启动 WorkerClaw: workerclaw start');
    console.log('     2. 查看终端日志，会显示 QR 码');
    console.log('     3. 打开手机 WhatsApp: 设置 > 关联设备 > 关联设备');
    console.log('     4. 扫描终端中的 QR 码');
    console.log('     5. 连接成功后，会话会自动保存');
    console.log('');
  } else {
    console.log('  ❌ WhatsApp 技能将禁用');
    console.log('');
  }

  const confirmChange = await confirm('确认修改？', true);
  if (!confirmChange) {
    outro('未修改');
    return {};
  }

  return {
    whatsapp: {
      ...existing?.whatsapp,
      enabled: newEnabled,
    },
  };
}

/**
 * 配置自动回复
 */
async function configureAutoReply(existing: any, cfgPath: string): Promise<any> {
  const autoReply = existing?.whatsapp?.autoReply || {};
  const currentEnabled = autoReply.enabled !== false;

  console.log('');
  console.log('  🤖 自动回复功能：当收到新消息时，自动调用 LLM 生成回复');
  console.log('');

  const enableAutoReply = await confirm('启用自动回复？', currentEnabled);
  
  if (!enableAutoReply) {
    return {
      whatsapp: {
        ...existing?.whatsapp,
        autoReply: {
          ...autoReply,
          enabled: false,
        },
      },
    };
  }

  // 配置系统提示
  console.log('');
  console.log('  📝 系统提示词：定义客服人设和回复规则');
  console.log('');

  const editPrompt = await confirm('自定义系统提示词？', false);
  let systemPrompt = autoReply.systemPrompt || DEFAULT_AUTO_REPLY_PROMPT;

  if (editPrompt) {
    console.log('');
    console.log('  当前提示词（可修改）：');
    console.log('  ' + '-'.repeat(50));
    console.log('');
    console.log(systemPrompt.split('\n').map((line: string) => '  ' + line).join('\n'));
    console.log('');
    console.log('  ' + '-'.repeat(50));
    console.log('');

    const newPrompt = await text(
      '输入新的系统提示词（留空保持当前）',
      undefined,
      undefined,
    );
    if (newPrompt && newPrompt.trim()) {
      systemPrompt = newPrompt.trim();
    }
  }

  // 配置上下文消息数
  const contextMessages = await num(
    '上下文消息数量（历史消息用于 LLM 理解语境）',
    autoReply.maxContextMessages || 20,
    5,
    50,
  );

  // 配置频率限制
  const maxMessages = await num(
    '每分钟最大发送消息数（防止刷屏）',
    autoReply.maxMessagesPerMinute || 30,
    5,
    60,
  );

  console.log('');
  console.log('  ✅ 自动回复配置完成');
  console.log(`     - 上下文消息: ${contextMessages} 条`);
  console.log(`     - 频率限制: ${maxMessages} 条/分钟`);
  console.log('');

  return {
    whatsapp: {
      ...existing?.whatsapp,
      autoReply: {
        enabled: true,
        systemPrompt,
        maxContextMessages: contextMessages,
        maxMessagesPerMinute: maxMessages,
      },
    },
  };
}

/**
 * 配置会话路径
 */
async function configureSessionPath(existing: any, cfgPath: string): Promise<any> {
  const currentPath = existing?.whatsapp?.sessionPath || DEFAULT_SESSION_PATH;

  console.log('');
  console.log('  📁 会话路径：存储 WhatsApp 登录凭证');
  console.log('     首次扫码后会话会保存到此目录，重启无需重新扫码');
  console.log('');

  const newPath = await text(
    '会话存储路径',
    undefined,
    currentPath,
  );

  if (!newPath || newPath === currentPath) {
    outro('路径未修改');
    return {};
  }

  // 创建目录（如果需要）
  const absolutePath = newPath.startsWith('/') 
    ? newPath 
    : join(WORKERCLAW_DIR, newPath);

  if (!existsSync(absolutePath)) {
    const createDir = await confirm(`目录不存在，是否创建？`, true);
    if (createDir) {
      mkdirSync(absolutePath, { recursive: true });
      console.log(`  ✅ 已创建目录: ${absolutePath}`);
    }
  }

  return {
    whatsapp: {
      ...existing?.whatsapp,
      sessionPath: newPath,
    },
  };
}

/**
 * 高级设置
 */
async function configureAdvanced(existing: any, cfgPath: string): Promise<any> {
  const autoReply = existing?.whatsapp?.autoReply || {};

  console.log('');
  console.log('  ⚙️  高级设置');
  console.log('');

  // 黑名单配置
  console.log('  🚫 黑名单：不自动回复的号码');
  console.log('     默认包含: status@broadcast（WhatsApp 状态广播）');
  console.log('');

  const currentBlacklist = autoReply.blacklist || ['status@broadcast'];
  const editBlacklist = await confirm('配置黑名单？', false);

  let blacklist = currentBlacklist;
  if (editBlacklist) {
    console.log('');
    console.log('  当前黑名单: ' + currentBlacklist.join(', '));
    const input = await text('输入黑名单号码（逗号分隔，留空保持当前）');
    if (input && input.trim()) {
      blacklist = input.split(',').map(s => s.trim()).filter(Boolean);
      console.log(`  ✅ 黑名单已更新: ${blacklist.join(', ')}`);
    }
  }

  // 空闲超时
  console.log('');
  const currentIdleTimeout = autoReply.idleTimeoutMs || 0;
  const enableIdleTimeout = await confirm(
    `设置空闲超时？当前: ${currentIdleTimeout > 0 ? `${currentIdleTimeout / 60000} 分钟` : '无限制'}`,
    false,
  );

  let idleTimeoutMs = currentIdleTimeout;
  if (enableIdleTimeout) {
    const minutes = await num('空闲超时（分钟）', 60, 1, 1440);
    idleTimeoutMs = (minutes || 60) * 60000;
    console.log(`  ✅ 空闲超时已设置: ${minutes || 60} 分钟`);
  }

  console.log('');
  console.log('  ✅ 高级设置完成');
  console.log('');

  return {
    whatsapp: {
      ...existing?.whatsapp,
      autoReply: {
        ...autoReply,
        blacklist,
        idleTimeoutMs,
      },
    },
  };
}
