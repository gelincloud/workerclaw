/**
 * WorkerClaw CLI - 安全配置 section
 * 
 * 交互式配置安全参数
 */

import { select, num, confirm, text } from '../prompter.js';
import type { SecurityConfig } from '../../core/config.js';

export interface SecuritySectionResult {
  security: Partial<SecurityConfig>;
}

/**
 * 安全配置
 */
export async function configureSecurity(
  existing?: Partial<SecurityConfig>,
): Promise<SecuritySectionResult | null> {
  // 权限级别
  const maxPermissionLevel = await select(
    '最大权限级别（限制 Agent 能力上限）',
    [
      {
        value: 'read_only',
        label: '只读',
        hint: '最安全，只能处理纯文本任务',
      },
      {
        value: 'limited',
        label: '受限',
        hint: '可执行搜索等低风险操作',
      },
      {
        value: 'standard',
        label: '标准（推荐）',
        hint: '可执行大多数任务',
      },
      {
        value: 'elevated',
        label: '提升',
        hint: '可执行代码、系统操作等高风险任务',
      },
    ],
    'standard',
  );

  if (!maxPermissionLevel) return null;

  // 速率限制
  const maxMessages = await num('每分钟最大消息数', 30, 5, 120);
  if (maxMessages === null) return null;

  const maxConcurrent = await num('最大并发任务数', 3, 1, 10);
  if (maxConcurrent === null) return null;

  // 内容扫描
  const enableContentScan = await confirm('启用内容安全扫描（提示注入/恶意命令检测）？', true);
  if (enableContentScan === null) return null;

  // PII 保护
  const enablePII = await confirm('启用个人隐私信息保护（邮箱/手机/身份证检测）？', false);
  if (enablePII === null) return null;

  let sandboxConfig: SecurityConfig['sandbox'] = existing?.sandbox || {
    workDir: './data/sandbox',
    commandTimeoutMs: 30000,
    taskTimeoutMs: 300000,
    maxMemoryMB: 512,
    maxOutputKB: 1024,
    deniedPaths: ['/etc', '/var', '/usr', '/System', '/Library', '/proc', '/sys'],
  };

  // 高级沙箱配置（可选）
  const configureSandbox = await confirm('自定义沙箱配置？', false);
  if (configureSandbox === null) return null;

  if (configureSandbox) {
    const workDir = await text('沙箱工作目录', existing?.sandbox?.workDir || './data/sandbox');
    if (workDir === null) return null;

    const commandTimeout = await num('命令超时 (秒)', 30, 5, 120);
    if (commandTimeout === null) return null;

    const taskTimeout = await num('任务超时 (秒)', 300, 30, 1800);
    if (taskTimeout === null) return null;

    sandboxConfig = {
      workDir: workDir || './data/sandbox',
      commandTimeoutMs: (commandTimeout || 30) * 1000,
      taskTimeoutMs: (taskTimeout || 300) * 1000,
      maxMemoryMB: 512,
      maxOutputKB: 1024,
      deniedPaths: ['/etc', '/var', '/usr', '/System', '/Library', '/proc', '/sys'],
    };
  }

  return {
    security: {
      rateLimit: {
        maxMessagesPerMinute: maxMessages || 30,
        maxConcurrentTasks: maxConcurrent || 3,
      },
      contentScan: {
        promptInjection: { enabled: enableContentScan },
        maliciousCommands: { enabled: enableContentScan },
        piiProtection: enablePII ? { enabled: true, action: 'warn' } : { enabled: false },
        resourceExhaustion: { maxOutputTokens: 8000, maxToolCallsPerTask: 20, maxTotalDurationMs: 300000 },
        dataExfiltration: { enabled: true, blockedDomains: [], allowedDomains: [], blockUnknownDomains: false },
      },
      sandbox: sandboxConfig || {
        workDir: './data/sandbox',
        commandTimeoutMs: 30000,
        taskTimeoutMs: 300000,
        maxMemoryMB: 512,
        maxOutputKB: 1024,
        deniedPaths: ['/etc', '/var', '/usr', '/System', '/Library', '/proc', '/sys'],
      },
    },
  };
}
