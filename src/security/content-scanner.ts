/**
 * 内容安全扫描器
 * 
 * Phase 2 Layer 3 安全检查：
 * - 提示注入检测（模式匹配，LLM 二次检测为可选）
 * - 恶意命令检测
 * - PII 保护（邮箱、手机号、身份证、API Key）
 */

import { createLogger, type Logger } from '../core/logger.js';
import type {
  PromptInjectionConfig,
  MaliciousCommandsConfig,
  PIIProtectionConfig,
} from '../core/config.js';

// ==================== 扫描结果 ====================

export interface ContentFlag {
  type: 'prompt_injection' | 'malicious_command' | 'pii_leak' | 'resource_exhaustion' | 'data_exfiltration';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  match: string;
}

export interface ContentScanResult {
  safe: boolean;
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  flags: ContentFlag[];
  sanitizedContent?: string;
  rejectionReason?: string;
}

// ==================== 提示注入模式 ====================

const DEFAULT_INJECTION_PATTERNS: RegExp[] = [
  // 忽略系统指令
  /ignore\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|rules?|directives?)/i,
  / disregard\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?)/i,
  /forget\s+(all\s+)?(previous|prior|your)\s+(instructions?|prompts?|rules?)/i,

  // 角色扮演/系统提示泄露
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /act\s+as\s+(if\s+you\s+(are|were)|a|an)\s+/i,
  /pretend\s+(to\s+be|you\s+are)\s+/i,
  /roleplay\s+as\s+/i,
  /from\s+now\s+on.*?\s+(you\s+are|act)\s+/i,

  // 系统提示提取
  /repeat\s+(your|the|all)\s+(system\s+)?(instructions?|prompts?|rules?)/i,
  /output\s+(your|the)\s+(system\s+)?prompt/i,
  /show\s+(me\s+)?(your|the)\s+(system|hidden|secret)\s+(instructions?|prompt|message)/i,
  /print\s+(your|the)\s+(system\s+)?instructions?/i,
  /reveal\s+(your|the)\s+(system|original)\s+prompt/i,
  /what\s+(are|is)\s+your\s+(system|initial|original)\s+(instructions?|prompt|rules?)/i,
  /dump\s+(your|the)\s+(system\s+)?prompt/i,
  /display\s+(your|the)\s+system\s+prompt/i,

  // 注入新系统指令
  /new\s+(system|override)\s+instruction/i,
  /system\s*:\s*you\s+are/i,
  /\[system\]/i,
  /\[instructions?\]/i,

  // 分隔符攻击
  /-{3,}\s*system\s*-{3,}/i,
  /<{3,}\s*system\s*>{3,}/i,

  // 编码绕过
  /base64\s*decode.*?system/i,
  /ROT13.*?instruction/i,

  // 输出格式操控
  /respond\s+only\s+with\s+(the\s+)?(following|this)\s+(text|format|json|code)/i,
  /output\s+(the\s+)?(following|this)\s+exactly/i,
  /do\s+not\s+say\s+(anything\s+else|no|warning)/i,
];

// ==================== 恶意命令模式 ====================

const DEFAULT_BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  // 参考 OpenClaw 2026.3.22 安全增强
  /MAVEN_OPTS/i,
  /JAVA_TOOL_OPTIONS/i,
  /GLIBC_TUNABLES/i,
  /DOTNET_ADDITIONAL_DEPS/i,
  /DOTNET_STARTUP_HOOKS/i,

  // 通用危险命令
  /rm\s+-rf\s+\/(?!\.\/)/,       // rm -rf / (排除 rm -rf ./xxx)
  /curl.*\|.*sh/i,               // curl | sh
  /wget.*\|.*sh/i,               // wget | sh
  /curl.*\|.*bash/i,
  /wget.*\|.*bash/i,
  /mkfs/i,                        // 格式化
  /dd\s+if=/i,                    // dd 磁盘操作
  />\s*\/dev\//i,                  // 直接写设备
  /chmod\s+777\s+\//i,            // 全局 777
  /chown\s+.*\s+\//i,             // 全局 chown
  /mkfifo/i,
  /nc\s+-[el]/i,                  // netcat 监听
  /socat/i,
  /python.*-c.*import\s+socket/i, // Python 反弹 shell
  /bash\s+-i\s+>&/i,              // bash 反弹 shell
  /sh\s+-i\s+>&/i,
  /nohup.*&/i,
  /eval\s*\(/i,
  /exec\s*\(/i,
  /child_process/i,
  /require\s*\(\s*['"]child_process/i,
];

// ==================== PII 检测模式 ====================

const PII_PATTERNS: Record<string, { regex: RegExp; label: string }> = {
  email: {
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    label: '邮箱地址',
  },
  phone: {
    regex: /1[3-9]\d{9}/g,
    label: '手机号',
  },
  id_card: {
    regex: /\b\d{17}[\dXx]\b/g,
    label: '身份证号',
  },
  api_key: {
    regex: /\b(sk|pk|api[_-]?key|secret[_-]?key|access[_-]?token|bearer)\s*[:=]\s*['"]?[\w-]{20,}['"]?\b/gi,
    label: 'API 密钥',
  },
  password: {
    regex: /\b(password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi,
    label: '密码',
  },
};

// ==================== 扫描器 ====================

export interface ContentScannerConfig {
  promptInjection: PromptInjectionConfig;
  maliciousCommands: MaliciousCommandsConfig;
  piiProtection: PIIProtectionConfig;
}

export class ContentScanner {
  private logger: Logger;
  private config: ContentScannerConfig;

  // 编译后的正则缓存
  private injectionPatterns: RegExp[];
  private commandPatterns: RegExp[];

  constructor(config: ContentScannerConfig) {
    this.config = config;
    this.logger = createLogger('ContentScanner');

    // 编译提示注入模式
    this.injectionPatterns = config.promptInjection.patterns
      ? config.promptInjection.patterns.map(p => new RegExp(p, 'i'))
      : DEFAULT_INJECTION_PATTERNS;

    // 编译恶意命令模式
    this.commandPatterns = config.maliciousCommands.blockPatterns
      ? config.maliciousCommands.blockPatterns.map(p => new RegExp(p, 'i'))
      : DEFAULT_BLOCKED_COMMAND_PATTERNS;
  }

  /**
   * 扫描内容安全性
   */
  scan(content: string): ContentScanResult {
    const flags: ContentFlag[] = [];

    // 1. 提示注入检测
    if (this.config.promptInjection.enabled) {
      const injectionFlags = this.scanPromptInjection(content);
      flags.push(...injectionFlags);
    }

    // 2. 恶意命令检测
    if (this.config.maliciousCommands.enabled) {
      const commandFlags = this.scanMaliciousCommands(content);
      flags.push(...commandFlags);
    }

    // 3. PII 保护
    if (this.config.piiProtection?.enabled) {
      const piiFlags = this.scanPII(content);
      flags.push(...piiFlags);
    }

    // 评估整体风险
    return this.assessResult(content, flags);
  }

  /**
   * 提示注入检测（模式匹配）
   */
  private scanPromptInjection(content: string): ContentFlag[] {
    const flags: ContentFlag[] = [];

    for (const pattern of this.injectionPatterns) {
      const match = content.match(pattern);
      if (match) {
        flags.push({
          type: 'prompt_injection',
          severity: 'high',
          description: '检测到疑似提示注入',
          match: match[0].slice(0, 100),
        });
      }
    }

    if (flags.length > 0) {
      this.logger.warn(`检测到 ${flags.length} 个提示注入模式`);
    }

    return flags;
  }

  /**
   * 恶意命令检测
   */
  private scanMaliciousCommands(content: string): ContentFlag[] {
    const flags: ContentFlag[] = [];

    for (const pattern of this.commandPatterns) {
      const match = content.match(pattern);
      if (match) {
        flags.push({
          type: 'malicious_command',
          severity: 'critical',
          description: '检测到恶意命令模式',
          match: match[0].slice(0, 100),
        });
      }
    }

    if (flags.length > 0) {
      this.logger.warn(`检测到 ${flags.length} 个恶意命令`);
    }

    return flags;
  }

  /**
   * PII 检测
   */
  private scanPII(content: string): ContentFlag[] {
    const flags: ContentFlag[] = [];
    const detectTypes = this.config.piiProtection?.detectTypes || ['api_key', 'password'];

    for (const type of detectTypes) {
      const piiDef = PII_PATTERNS[type];
      if (!piiDef) continue;

      const matches = content.match(piiDef.regex);
      if (matches) {
        for (const m of matches) {
          flags.push({
            type: 'pii_leak',
            severity: 'medium',
            description: `检测到${piiDef.label}`,
            match: this.maskPII(m, type),
          });
        }
      }
    }

    if (flags.length > 0) {
      this.logger.warn(`检测到 ${flags.length} 个 PII 信息泄露`);
    }

    return flags;
  }

  /**
   * PII 脱敏
   */
  private maskPII(value: string, type: string): string {
    switch (type) {
      case 'email':
        return value.replace(/(.{2})(.*)(@.*)/, '$1***$3');
      case 'phone':
        return value.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
      case 'id_card':
        return value.replace(/(\d{4})\d{10}(\d{4})/, '$1**********$2');
      default:
        return value.slice(0, 4) + '***';
    }
  }

  /**
   * 评估扫描结果
   */
  private assessResult(content: string, flags: ContentFlag[]): ContentScanResult {
    if (flags.length === 0) {
      return { safe: true, riskLevel: 'none', flags: [] };
    }

    // 确定最高风险级别
    const severityOrder: Array<'low' | 'medium' | 'high' | 'critical'> = ['low', 'medium', 'high', 'critical'];
    const highestSeverity = flags.reduce<(typeof severityOrder)[number]>((max, f) => {
      const idx = severityOrder.indexOf(f.severity);
      const maxIdx = severityOrder.indexOf(max);
      return idx > maxIdx ? f.severity : max;
    }, 'low');

    const riskLevel: ContentScanResult['riskLevel'] = highestSeverity === 'critical' ? 'critical'
      : highestSeverity === 'high' ? 'high'
      : highestSeverity === 'medium' ? 'medium'
      : 'low';

    // critical 或 high 且包含 prompt_injection/malicious_command → 拒绝
    const hasCriticalFlag = flags.some(f =>
      (f.type === 'prompt_injection' && f.severity === 'high') ||
      f.type === 'malicious_command'
    );

    if (hasCriticalFlag) {
      const rejectionReason = flags
        .filter(f => f.type === 'prompt_injection' || f.type === 'malicious_command')
        .map(f => f.description)
        .join('; ');

      return {
        safe: false,
        riskLevel: 'high',
        flags,
        rejectionReason: `内容安全扫描未通过: ${rejectionReason}`,
      };
    }

    // PII 泄露根据 action 决定
    const piiFlags = flags.filter(f => f.type === 'pii_leak');
    if (piiFlags.length > 0) {
      const action = this.config.piiProtection?.action || 'warn';

      if (action === 'block') {
        return {
          safe: false,
          riskLevel: 'medium',
          flags,
          rejectionReason: `内容包含敏感信息（${piiFlags.length} 处 PII），已被阻止`,
        };
      }

      if (action === 'mask') {
        return {
          safe: true,
          riskLevel: 'low',
          flags,
        };
      }

      // warn 模式：允许通过但标记
      this.logger.warn(`内容包含 ${piiFlags.length} 处 PII 信息（warn 模式，已放行）`);
    }

    // low 风险 → 放行并记录
    return {
      safe: true,
      riskLevel,
      flags,
    };
  }
}
