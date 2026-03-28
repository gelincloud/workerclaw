/**
 * 错误信号检测器
 * 
 * 自动检测错误信息中的可搜索信号
 * 在 AgentEngine 遇到错误时触发经验搜索
 */

import { createLogger, type Logger } from '../core/logger.js';

// ==================== 自动搜索触发模式 ====================

interface SignalPattern {
  /** 模式名称 */
  name: string;
  /** 匹配正则 */
  pattern: RegExp;
  /** 提取信号的函数 */
  extractSignals: (match: RegExpMatchArray) => string[];
}

const SIGNAL_PATTERNS: SignalPattern[] = [
  // === 任务执行错误 ===
  {
    name: 'module_not_found',
    pattern: /Cannot find module ['"]([^'"]+)['"]/i,
    extractSignals: (m) => ['Cannot find module', m[1], 'MODULE_NOT_FOUND'],
  },
  {
    name: 'socket_hang_up',
    pattern: /socket hang up/i,
    extractSignals: () => ['socket hang up', 'ECONNRESET', 'WebSocket'],
  },
  {
    name: 'econnrefused',
    pattern: /ECONNREFUSED/i,
    extractSignals: () => ['ECONNREFUSED', 'connection refused'],
  },
  {
    name: 'etimedout',
    pattern: /ETIMEDOUT/i,
    extractSignals: () => ['ETIMEDOUT', 'connection timeout'],
  },
  {
    name: 'enotfound',
    pattern: /ENOTFOUND/i,
    extractSignals: (m) => ['ENOTFOUND', 'getaddrinfo'],
  },
  {
    name: 'permission_denied',
    pattern: /permission denied|EACCES/i,
    extractSignals: () => ['permission denied', 'EACCES'],
  },

  // === LLM 错误 ===
  {
    name: 'llm_400',
    pattern: /LLM API 错误 \(400\)[:\s]*(.*)/i,
    extractSignals: (m) => ['LLM 400', 'Bad Request', ...(m[1] ? [m[1].slice(0, 100)] : [])],
  },
  {
    name: 'llm_429',
    pattern: /429.*Too Many|rate.?limit/i,
    extractSignals: () => ['429', 'rate limit', 'Too Many Requests'],
  },
  {
    name: 'context_length',
    pattern: /context length|token limit|max.?tokens/i,
    extractSignals: () => ['context length', 'token limit'],
  },
  {
    name: 'model_not_found',
    pattern: /model not found|does not exist/i,
    extractSignals: () => ['model not found'],
  },

  // === 平台 API 错误 ===
  {
    name: 'http_status',
    pattern: /HTTP (?:状态|status) ?(\d{3})|status: (\d{3})|HTTP\/\d\.\d (\d{3})/i,
    extractSignals: (m) => {
      const code = m[1] || m[2] || m[3];
      return [`HTTP ${code}`, `status ${code}`];
    },
  },
  {
    name: 'api_error',
    pattern: /API.?错误|API.?ERROR|接口.*失败|请求失败/i,
    extractSignals: () => ['API error'],
  },

  // === 构建错误 ===
  {
    name: 'tsc_error',
    pattern: /tsc error|typescript error|compilation error/i,
    extractSignals: () => ['tsc error', 'TypeScript compilation'],
  },
  {
    name: 'build_failed',
    pattern: /build failed|npm ERR!/i,
    extractSignals: () => ['build failed'],
  },

  // === vLLM 特定 ===
  {
    name: 'vllm_validation',
    pattern: /validation error|Field required/i,
    extractSignals: () => ['validation error', 'Field required'],
  },

  // === 通用错误 ===
  {
    name: 'timeout',
    pattern: /timeout|超时/i,
    extractSignals: () => ['timeout'],
  },
  {
    name: 'memory',
    pattern: /heap out of memory|OMEM|allocation failure/i,
    extractSignals: () => ['out of memory', 'heap OOM'],
  },
];

// ==================== 信号检测器 ====================

export interface DetectedSignal {
  /** 检测到的信号模式名称 */
  patternName: string;
  /** 提取的信号关键词列表 */
  signals: string[];
  /** 原始错误信息 */
  originalError: string;
  /** 是否应该触发经验搜索 */
  shouldSearch: boolean;
}

export class SignalDetector {
  private logger: Logger;

  constructor() {
    this.logger = createLogger('SignalDetector');
  }

  /**
   * 从错误信息中检测信号
   */
  detect(errorMessage: string): DetectedSignal {
    if (!errorMessage || typeof errorMessage !== 'string') {
      return {
        patternName: 'none',
        signals: [],
        originalError: errorMessage || '',
        shouldSearch: false,
      };
    }

    const allSignals: string[] = [];
    let matchedPattern: SignalPattern | null = null;

    for (const sp of SIGNAL_PATTERNS) {
      const match = errorMessage.match(sp.pattern);
      if (match) {
        matchedPattern = sp;
        const extracted = sp.extractSignals(match);
        allSignals.push(...extracted);
        break; // 取第一个匹配的模式
      }
    }

    // 如果没有精确匹配，提取有意义的短语作为通用信号
    if (!matchedPattern) {
      const genericSignals = this.extractGenericSignals(errorMessage);
      allSignals.push(...genericSignals);
    }

    // 去重
    const uniqueSignals = [...new Set(allSignals.map(s => s.trim()).filter(s => s.length > 0))];

    const result: DetectedSignal = {
      patternName: matchedPattern?.name || 'generic',
      signals: uniqueSignals,
      originalError: errorMessage,
      shouldSearch: uniqueSignals.length >= 1,
    };

    if (result.shouldSearch) {
      this.logger.debug(`检测到信号 [${result.patternName}]`, {
        signals: uniqueSignals.slice(0, 5),
      });
    }

    return result;
  }

  /**
   * 提取通用信号（无精确匹配时的兜底）
   */
  private extractGenericSignals(errorMessage: string): string[] {
    const signals: string[] = [];

    // 提取常见错误代码
    const errorCodeMatch = errorMessage.match(/\b(ERR[A-Z_]+|E[A-Z]+)\b/);
    if (errorCodeMatch) {
      signals.push(errorCodeMatch[1]);
    }

    // 提取 HTTP 状态码
    const httpMatch = errorMessage.match(/\b([45]\d{2})\b/);
    if (httpMatch) {
      signals.push(`HTTP ${httpMatch[1]}`);
    }

    // 提取引号中的错误消息
    const quotedMatch = errorMessage.match(/['"]([^'"]{5,60})['"]/);
    if (quotedMatch) {
      signals.push(quotedMatch[1]);
    }

    // 限制信号数量
    return signals.slice(0, 5);
  }

  /**
   * 获取所有已注册的信号模式名称
   */
  getRegisteredPatterns(): string[] {
    return SIGNAL_PATTERNS.map(sp => sp.name);
  }
}
