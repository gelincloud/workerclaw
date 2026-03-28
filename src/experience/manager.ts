/**
 * 经验管理器
 * 
 * 统一管理经验基因系统的所有模块
 * 对外提供简洁 API，集成到 WorkerClaw 主流程
 */

import { createLogger, type Logger } from '../core/logger.js';
import { LocalExperienceStore } from './local-store.js';
import { SignalDetector } from './signal-detector.js';
import { ExperienceSearchEngine } from './search-engine.js';
import { ExperienceEncapsulator, type EvolutionProcess } from './encapsulator.js';
import { ShrimpHubClient } from './hub-client.js';
import type {
  ExperienceConfig, ExperienceSearchResult,
  ShrimpGene, ShrimpCapsule, ShrimpEvolution,
  StrategyStep,
} from './types.js';

// ==================== 经验管理器 ====================

export class ExperienceManager {
  private logger: Logger;
  private config: ExperienceConfig;
  private store: LocalExperienceStore;
  private signalDetector: SignalDetector;
  private searchEngine: ExperienceSearchEngine;
  private encapsulator: ExperienceEncapsulator;
  private hubClient: ShrimpHubClient | null = null;
  private initialized = false;

  // 进化追踪（当前任务）
  private currentEvolution: {
    taskId?: string;
    taskType?: string;
    startTime: number;
    mutations: EvolutionProcess['mutations'];
    initialApproach?: string;
  } | null = null;

  constructor(config: ExperienceConfig, botId: string, token: string) {
    this.logger = createLogger('Experience');
    this.config = config;

    // 初始化子模块
    this.store = new LocalExperienceStore(config.storagePath);
    this.signalDetector = new SignalDetector();
    this.searchEngine = new ExperienceSearchEngine(this.store, config);
    this.encapsulator = new ExperienceEncapsulator(this.store, botId);

    // Hub 客户端
    if (config.hub.enabled) {
      this.hubClient = new ShrimpHubClient(config.hub.endpoint, botId, token);
      // 将 Hub 客户端传递给搜索引擎
      this.searchEngine.setHubClient(this.hubClient);
    }
  }

  // ==================== 生命周期 ====================

  /**
   * 初始化经验系统
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await this.store.init();
    this.initialized = true;

    const stats = this.store.getStats();
    this.logger.info(`🧬 经验系统已初始化`, {
      genes: stats.genes,
      capsules: stats.capsules,
      events: stats.events,
      hubEnabled: this.config.hub.enabled,
    });
  }

  // ==================== 搜索 API ====================

  /**
   * 错误发生时自动搜索经验
   */
  async searchOnError(errorMessage: string): Promise<ExperienceSearchResult | null> {
    if (!this.initialized) return null;
    return this.searchEngine.searchByError(errorMessage);
  }

  /**
   * 手动搜索经验
   */
  async search(keywords: string[]): Promise<ExperienceSearchResult[]> {
    if (!this.initialized) return [];
    return this.searchEngine.searchBySignals(keywords);
  }

  /**
   * 从错误消息检测信号
   */
  detectSignals(errorMessage: string) {
    return this.signalDetector.detect(errorMessage);
  }

  // ==================== 进化追踪 ====================

  /**
   * 开始追踪任务进化过程
   */
  startEvolution(taskId?: string, taskType?: string): void {
    this.currentEvolution = {
      taskId,
      taskType,
      startTime: Date.now(),
      mutations: [],
    };
  }

  /**
   * 记录一次尝试（方案 + 结果）
   */
  recordMutation(approach: string, result: 'success' | 'failed', error?: string): void {
    if (!this.currentEvolution) return;

    this.currentEvolution.mutations.push({
      approach,
      result,
      error,
      duration_ms: Date.now() - this.currentEvolution.startTime,
    });
  }

  /**
   * 完成进化追踪并封装经验
   */
  async completeEvolution(
    status: 'success' | 'failed',
    fixSummary: string,
    fixSteps: StrategyStep[],
    errorMessage: string,
    options?: {
      diff?: string;
      filesAffected?: number;
      linesChanged?: number;
      components?: string[];
    },
  ): Promise<{
    gene: ShrimpGene;
    capsule: ShrimpCapsule;
    event: ShrimpEvolution;
  } | null> {
    if (!this.config.autoEncapsulate.enabled || !this.currentEvolution) {
      this.currentEvolution = null;
      return null;
    }

    // 检测信号
    const detected = this.signalDetector.detect(errorMessage);
    if (!detected.shouldSearch) {
      this.currentEvolution = null;
      return null;
    }

    const process: EvolutionProcess = {
      signalDetected: detected.signals[0] || detected.patternName,
      errorMessage,
      taskId: this.currentEvolution.taskId,
      taskType: this.currentEvolution.taskType,
      initialApproach: this.currentEvolution.initialApproach || fixSummary,
      mutations: this.currentEvolution.mutations,
      finalStatus: status,
      totalDurationMs: Date.now() - this.currentEvolution.startTime,
      fixSummary,
      fixSteps,
      diff: options?.diff,
      filesAffected: options?.filesAffected,
      linesChanged: options?.linesChanged,
      components: options?.components,
    };

    this.currentEvolution = null;

    // 封装并保存
    const result = await this.encapsulator.encapsulate(process);
    if (!result) return null;

    // 如果 Hub 启用，自动发布
    if (this.hubClient && this.config.hub.enabled) {
      this.hubClient.publishGene(result.gene, result.capsule).catch(() => {});
    }

    return result;
  }

  // ==================== Hub 操作 ====================

  /**
   * 同步 Hub（发布本地新基因 + 上报验证报告）
   */
  async syncHub(): Promise<{ published: number; reported: number }> {
    if (!this.hubClient) return { published: 0, reported: 0 };

    let published = 0;
    let reported = 0;

    // 上报验证报告
    const pendingReports = this.store.getPendingReports();
    for (const report of pendingReports) {
      const ok = await this.hubClient.submitReport(report);
      if (ok) reported++;
    }
    if (reported > 0) await this.store.clearReports();

    this.logger.info(`Hub 同步完成`, { published, reported });
    return { published, reported };
  }

  // ==================== 统计 ====================

  getStats() {
    return this.store.getStats();
  }

  getAllGenes(): ShrimpGene[] {
    return this.store.getAllGenes();
  }

  getRecentEvents(limit = 10): ShrimpEvolution[] {
    return this.store.getRecentEvents(limit);
  }

  /**
   * 清理资源
   */
  dispose(): void {
    // JSON 存储，无需特殊清理
  }
}
