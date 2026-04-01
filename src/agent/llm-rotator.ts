/**
 * LLM API Key 轮换器
 * 
 * 支持多个 API Key 轮换使用，避免单一 Key 的调用频率限制
 * 支持多个不同 Provider 的混合使用
 */

import type { Logger } from '../core/logger.js';

// ============================================================================
// 类型定义
// ============================================================================

/** 单个 LLM Provider 配置 */
export interface LLMProviderEndpoint {
  /** Provider 名称（用于日志） */
  name?: string;
  /** API Key */
  apiKey: string;
  /** API Base URL（可选，使用默认值） */
  baseUrl?: string;
  /** 模型名称（可选，使用默认值） */
  model?: string;
  /** 权重（用于加权轮换，默认 1） */
  weight?: number;
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** 最大 QPS（可选，超过则跳过） */
  maxQps?: number;
}

/** 轮换统计 */
export interface RotationStats {
  /** Provider 名称 */
  name: string;
  /** 总调用次数 */
  totalCalls: number;
  /** 成功次数 */
  successCalls: number;
  /** 失败次数 */
  failedCalls: number;
  /** 最后调用时间 */
  lastCallTime: number;
  /** 最后错误 */
  lastError?: string;
  /** 当前 QPS（最近 1 分钟） */
  currentQps: number;
}

/** 端点状态 */
interface EndpointState {
  config: LLMProviderEndpoint;
  stats: RotationStats;
  recentCalls: number[]; // 最近调用时间戳（用于计算 QPS）
}

// ============================================================================
// LLM Key 轮换器
// ============================================================================

export class LLMKeyRotator {
  private endpoints: EndpointState[] = [];
  private currentIndex = 0;
  private logger?: Logger;

  constructor(endpoints: LLMProviderEndpoint[], logger?: Logger) {
    if (!endpoints || endpoints.length === 0) {
      throw new Error('至少需要提供一个 LLM endpoint');
    }

    this.logger = logger;
    
    // 初始化端点状态
    this.endpoints = endpoints
      .filter(ep => ep.enabled !== false)
      .map(ep => ({
        config: ep,
        stats: {
          name: ep.name || ep.model || 'unknown',
          totalCalls: 0,
          successCalls: 0,
          failedCalls: 0,
          lastCallTime: 0,
          currentQps: 0,
        },
        recentCalls: [],
      }));

    if (this.endpoints.length === 0) {
      throw new Error('没有可用的 LLM endpoint（所有都被禁用）');
    }

    this.logger?.info(`LLM Key 轮换器已初始化，共 ${this.endpoints.length} 个端点`);
  }

  /**
   * 获取下一个可用的端点
   * 使用加权轮换算法
   */
  getNextEndpoint(): LLMProviderEndpoint {
    const now = Date.now();
    
    // 清理过期的调用记录（1 分钟前的）
    this.endpoints.forEach(ep => {
      ep.recentCalls = ep.recentCalls.filter(t => now - t < 60000);
      ep.stats.currentQps = ep.recentCalls.length / 60;
    });

    // 过滤可用的端点
    const available = this.endpoints.filter(ep => {
      // 检查是否超过 QPS 限制
      if (ep.config.maxQps && ep.stats.currentQps >= ep.config.maxQps) {
        return false;
      }
      return true;
    });

    if (available.length === 0) {
      this.logger?.warn('所有 LLM 端点都达到 QPS 限制，使用第一个端点');
      return this.endpoints[0].config;
    }

    // 加权轮换
    const totalWeight = available.reduce((sum, ep) => sum + (ep.config.weight || 1), 0);
    let random = Math.random() * totalWeight;
    
    for (const ep of available) {
      random -= ep.config.weight || 1;
      if (random <= 0) {
        // 记录调用
        ep.recentCalls.push(now);
        ep.stats.totalCalls++;
        ep.stats.lastCallTime = now;
        return ep.config;
      }
    }

    // 兜底：返回第一个可用端点
    available[0].recentCalls.push(now);
    available[0].stats.totalCalls++;
    available[0].stats.lastCallTime = now;
    return available[0].config;
  }

  /**
   * 记录成功调用
   */
  recordSuccess(apiKey: string): void {
    const ep = this.endpoints.find(e => e.config.apiKey === apiKey);
    if (ep) {
      ep.stats.successCalls++;
    }
  }

  /**
   * 记录失败调用
   */
  recordFailure(apiKey: string, error: string): void {
    const ep = this.endpoints.find(e => e.config.apiKey === apiKey);
    if (ep) {
      ep.stats.failedCalls++;
      ep.stats.lastError = error;
      this.logger?.warn(`LLM 端点 ${ep.stats.name} 调用失败: ${error}`);
    }
  }

  /**
   * 获取所有端点的统计信息
   */
  getStats(): RotationStats[] {
    return this.endpoints.map(ep => ({ ...ep.stats }));
  }

  /**
   * 禁用某个端点
   */
  disableEndpoint(apiKey: string): void {
    const ep = this.endpoints.find(e => e.config.apiKey === apiKey);
    if (ep) {
      ep.config.enabled = false;
      this.logger?.info(`LLM 端点 ${ep.stats.name} 已禁用`);
    }
  }

  /**
   * 启用某个端点
   */
  enableEndpoint(apiKey: string): void {
    const ep = this.endpoints.find(e => e.config.apiKey === apiKey);
    if (ep) {
      ep.config.enabled = true;
      this.logger?.info(`LLM 端点 ${ep.stats.name} 已启用`);
    }
  }
}

// ============================================================================
// 单例管理
// ============================================================================

let globalRotator: LLMKeyRotator | null = null;

/**
 * 初始化全局轮换器
 */
export function initGlobalRotator(endpoints: LLMProviderEndpoint[], logger?: Logger): LLMKeyRotator {
  globalRotator = new LLMKeyRotator(endpoints, logger);
  return globalRotator;
}

/**
 * 获取全局轮换器
 */
export function getGlobalRotator(): LLMKeyRotator | null {
  return globalRotator;
}
