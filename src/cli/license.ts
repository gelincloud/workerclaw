/**
 * WorkerClaw 企业版 License 验证
 * 
 * License 验证逻辑：
 * 1. 验证 License Key 格式（WC-E-xxxx-xxxx-xxxx-xxxx）
 * 2. 调用平台 API 验证 License 有效性
 * 3. 检查过期时间
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** License Key 格式: WC-E-xxxx-xxxx-xxxx-xxxx */
const LICENSE_KEY_PATTERN = /^WC-E-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export interface LicenseVerifyResult {
  valid: boolean;
  activated: boolean;
  reason?: string;
  expiresAt?: string;
  plan?: string;
}

/**
 * 验证 License Key 格式
 */
export function isValidLicenseKeyFormat(key: string): boolean {
  return LICENSE_KEY_PATTERN.test(key.trim().toUpperCase());
}

/**
 * 验证 License Key（调用平台 API）
 */
export async function verifyLicense(
  key: string,
  apiUrl: string = 'https://www.miniabc.top',
): Promise<LicenseVerifyResult> {
  const trimmedKey = key.trim().toUpperCase();

  // 先检查格式
  if (!isValidLicenseKeyFormat(trimmedKey)) {
    return { valid: false, activated: false, reason: 'License Key 格式无效（应为 WC-E-xxxx-xxxx-xxxx-xxxx）' };
  }

  // 调用平台 API 验证
  try {
    const resp = await fetch(`${apiUrl}/api/license/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: trimmedKey }),
      signal: AbortSignal.timeout(15000),
    });

    const data: any = await resp.json();

    if (data.success && data.valid) {
      return {
        valid: true,
        activated: true,
        expiresAt: data.expiresAt,
        plan: data.plan,
      };
    } else {
      return {
        valid: false,
        activated: false,
        reason: data.error || 'License Key 无效或已过期',
      };
    }
  } catch (err: any) {
    // 网络错误时，尝试离线验证（检查本地已激活的 License）
    const localConfig = loadLocalConfig();
    if (localConfig?.enterprise?.activated && localConfig.enterprise.key === trimmedKey) {
      // 检查是否过期
      if (localConfig.enterprise.expiresAt && new Date(localConfig.enterprise.expiresAt) < new Date()) {
        return { valid: false, activated: true, reason: 'License 已过期' };
      }
      return { valid: true, activated: true, expiresAt: localConfig.enterprise.expiresAt };
    }

    return { valid: false, activated: false, reason: `验证失败: ${err.message}` };
  }
}

/**
 * 激活 License Key（调用平台 API，需要认证）
 */
export async function activateLicenseKey(
  key: string,
  botId: string,
  token: string,
  apiUrl: string = 'https://www.miniabc.top',
): Promise<LicenseVerifyResult> {
  const trimmedKey = key.trim().toUpperCase();

  // 先检查格式
  if (!isValidLicenseKeyFormat(trimmedKey)) {
    return { valid: false, activated: false, reason: 'License Key 格式无效（应为 WC-E-xxxx-xxxx-xxxx-xxxx）' };
  }

  // 调用平台 API 激活
  try {
    const resp = await fetch(`${apiUrl}/api/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: trimmedKey, botId, token }),
      signal: AbortSignal.timeout(15000),
    });

    const data: any = await resp.json();

    if (data.success && data.valid) {
      return {
        valid: true,
        activated: true,
        expiresAt: data.expiresAt,
        plan: data.plan,
        reason: data.message,
      };
    } else {
      return {
        valid: false,
        activated: false,
        reason: data.error || 'License 激活失败',
      };
    }
  } catch (err: any) {
    return { valid: false, activated: false, reason: `激活失败: ${err.message}` };
  }
}

/**
 * 检查本地配置是否已激活企业版
 */
export function isEnterpriseActivated(config?: { enterprise?: { activated: boolean; expiresAt?: string } }): boolean {
  if (!config?.enterprise?.activated) return false;

  // 检查过期
  if (config.enterprise.expiresAt) {
    return new Date(config.enterprise.expiresAt) > new Date();
  }

  return true;
}

/**
 * 加载本地配置（用于离线验证）
 */
function loadLocalConfig(): any {
  try {
    const configPath = join(homedir(), '.workerclaw', 'config.json');
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return null;
}
