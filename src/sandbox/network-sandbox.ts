/**
 * 网络访问沙箱
 * 
 * URL 验证 + 域名白名单 + SSRF 防护
 * 参考 OpenClaw 的安全增强设计
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { PermissionLevel } from '../security/permission-level.js';

// ==================== 配置 ====================

export interface NetworkSandboxConfig {
  allowLocalhost: boolean;
  allowedDomains: string[];
  deniedDomains: string[];
  blockUnknownDomains: boolean;
}

// ==================== URL 验证结果 ====================

export interface UrlValidation {
  allowed: boolean;
  reason?: string;
  protocol?: string;
  hostname?: string;
}

// ==================== 本地地址模式 ====================

const LOCAL_HOSTNAMES = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
  'metadata.google.internal', '169.254.169.254',
];

const LOCAL_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
];

// ==================== 网络沙箱 ====================

export class NetworkSandbox {
  private logger: Logger;
  private config: NetworkSandboxConfig;

  constructor(config: NetworkSandboxConfig) {
    this.config = config;
    this.logger = createLogger('NetworkSandbox');
  }

  /**
   * 验证 URL 是否允许访问
   */
  validateUrl(url: string, permissionLevel?: PermissionLevel): UrlValidation {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: `无效的 URL: ${url.slice(0, 100)}` };
    }

    const { protocol, hostname } = parsed;

    // 1. 阻止 file:// 协议（参考 OpenClaw Windows 安全增强）
    if (protocol === 'file:') {
      return { allowed: false, reason: 'file:// 协议已被阻止', protocol, hostname };
    }

    // 2. 阻止 data://, javascript: 等危险协议
    if (['data:', 'javascript:', 'vbscript:', 'blob:'].includes(protocol)) {
      return { allowed: false, reason: `${protocol} 协议已被阻止`, protocol, hostname };
    }

    // 3. 只允许 http/https/wss 协议
    if (!['http:', 'https:', 'wss:'].includes(protocol)) {
      return { allowed: false, reason: `不支持的协议: ${protocol}`, protocol, hostname };
    }

    // 4. 阻止 localhost 和内网地址
    if (!this.config.allowLocalhost) {
      if (this.isLocalAddress(hostname)) {
        return { allowed: false, reason: `本地网络访问已被阻止: ${hostname}`, protocol, hostname };
      }
    }

    // 5. 检查域名黑名单
    for (const denied of this.config.deniedDomains) {
      if (this.matchDomain(hostname, denied)) {
        return { allowed: false, reason: `域名在黑名单中: ${hostname}（匹配 ${denied}）`, protocol, hostname };
      }
    }

    // 6. 如果启用了未知域名阻止，检查白名单
    if (this.config.blockUnknownDomains && this.config.allowedDomains.length > 0) {
      const isAllowed = this.config.allowedDomains.some(allowed =>
        this.matchDomain(hostname, allowed)
      );
      if (!isAllowed) {
        return { allowed: false, reason: `域名不在白名单中: ${hostname}`, protocol, hostname };
      }
    }

    return { allowed: true, protocol, hostname };
  }

  /**
   * 检查是否是本地/内网地址
   */
  isLocalAddress(hostname: string): boolean {
    // 去掉 IPv6 括号
    const cleanHost = hostname.replace(/^\[|\]$/g, '').toLowerCase();

    // 精确匹配
    if (LOCAL_HOSTNAMES.includes(cleanHost)) return true;

    // 正则匹配
    for (const range of LOCAL_RANGES) {
      if (range.test(cleanHost)) return true;
    }

    return false;
  }

  /**
   * 域名匹配（支持通配符 *）
   */
  private matchDomain(hostname: string, pattern: string): boolean {
    const h = hostname.toLowerCase();
    const p = pattern.toLowerCase();

    if (p.startsWith('*.')) {
      // *.example.com 匹配 sub.example.com 和 example.com
      const suffix = p.slice(2);
      return h === suffix || h.endsWith('.' + suffix);
    }

    return h === p;
  }

  /**
   * 验证并返回安全的 URL（用于 fetch 包装）
   */
  safeFetchUrl(url: string, permissionLevel?: PermissionLevel): string {
    const result = this.validateUrl(url, permissionLevel);
    if (!result.allowed) {
      throw new Error(`网络沙箱阻止访问: ${result.reason}`);
    }
    return url;
  }
}
