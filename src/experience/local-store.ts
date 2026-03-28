/**
 * 本地经验池存储
 * 
 * 基于 JSON 文件的轻量存储方案
 * 存储 genes + capsules + events + reports
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, type Logger } from '../core/logger.js';
import type {
  ShrimpGene, ShrimpCapsule, ShrimpEvolution, GeneCategory,
  ExperienceSearchResult, HubReportRequest,
} from './types.js';

// ==================== 存储接口 ====================

export interface LocalStoreStats {
  genes: number;
  capsules: number;
  events: number;
  categories: Record<GeneCategory, number>;
}

// ==================== 本地经验池 ====================

export class LocalExperienceStore {
  private logger: Logger;
  private storePath: string;
  private genes: Map<string, ShrimpGene> = new Map();
  private capsules: Map<string, ShrimpCapsule> = new Map();
  private events: ShrimpEvolution[] = [];
  private reports: HubReportRequest[] = [];
  private initialized = false;

  constructor(storagePath: string) {
    this.logger = createLogger('ExperienceStore');
    this.storePath = storagePath;
  }

  // ==================== 初始化 ====================

  /**
   * 初始化存储（加载已有数据）
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // 确保目录存在
      if (!existsSync(this.storePath)) {
        mkdirSync(this.storePath, { recursive: true });
      }

      // 加载数据
      await this.loadGenes();
      await this.loadCapsules();
      await this.loadEvents();
      await this.loadReports();

      this.initialized = true;
      this.logger.info(`本地经验池已加载`, {
        genes: this.genes.size,
        capsules: this.capsules.size,
        events: this.events.length,
      });
    } catch (err) {
      this.logger.error('本地经验池初始化失败', { error: (err as Error).message });
      // 失败不阻塞启动，使用空经验池
      this.initialized = true;
    }
  }

  // ==================== 基因操作 ====================

  /**
   * 保存基因
   */
  async saveGene(gene: ShrimpGene): Promise<void> {
    this.genes.set(gene.gene_id, gene);
    await this.persistGenes();
    this.logger.debug(`基因已保存 [${gene.gene_id.slice(0, 12)}...]`, {
      category: gene.category,
      signals: gene.signals.length,
    });
  }

  /**
   * 获取基因
   */
  getGene(geneId: string): ShrimpGene | undefined {
    return this.genes.get(geneId);
  }

  /**
   * 获取所有基因
   */
  getAllGenes(): ShrimpGene[] {
    return Array.from(this.genes.values());
  }

  /**
   * 按分类获取基因
   */
  getGenesByCategory(category: GeneCategory): ShrimpGene[] {
    return Array.from(this.genes.values()).filter(g => g.category === category);
  }

  /**
   * 删除基因（同时删除关联的胶囊）
   */
  async deleteGene(geneId: string): Promise<boolean> {
    const gene = this.genes.get(geneId);
    if (!gene) return false;

    // 删除关联胶囊
    for (const [capId, cap] of this.capsules) {
      if (cap.gene_id === geneId) {
        this.capsules.delete(capId);
      }
    }

    this.genes.delete(geneId);
    await Promise.all([this.persistGenes(), this.persistCapsules()]);
    return true;
  }

  // ==================== 胶囊操作 ====================

  /**
   * 保存胶囊
   */
  async saveCapsule(capsule: ShrimpCapsule): Promise<void> {
    this.capsules.set(capsule.capsule_id, capsule);

    // 同时确保关联的基因存在
    if (!this.genes.has(capsule.gene_id) && capsule.context) {
      // 胶囊可以独立存在（基因可能来自 Hub）
    }

    await this.persistCapsules();
    this.logger.debug(`胶囊已保存 [${capsule.capsule_id.slice(0, 12)}...]`);
  }

  /**
   * 获取胶囊
   */
  getCapsule(capsuleId: string): ShrimpCapsule | undefined {
    return this.capsules.get(capsuleId);
  }

  /**
   * 获取基因关联的胶囊列表
   */
  getCapsulesByGene(geneId: string): ShrimpCapsule[] {
    return Array.from(this.capsules.values()).filter(c => c.gene_id === geneId);
  }

  /**
   * 获取最佳胶囊（按置信度排序）
   */
  getBestCapsule(geneId: string): ShrimpCapsule | undefined {
    const capsules = this.getCapsulesByGene(geneId);
    if (capsules.length === 0) return undefined;
    return capsules.sort((a, b) => b.confidence - a.confidence)[0];
  }

  // ==================== 事件操作 ====================

  /**
   * 记录进化事件
   */
  async recordEvent(event: ShrimpEvolution): Promise<void> {
    this.events.push(event);
    await this.persistEvents();
    this.logger.debug(`进化事件已记录`, {
      intent: event.intent,
      status: event.outcome.status,
    });
  }

  /**
   * 获取最近的进化事件
   */
  getRecentEvents(limit = 20): ShrimpEvolution[] {
    return this.events.slice(-limit).reverse();
  }

  // ==================== 报告操作 ====================

  /**
   * 记录验证报告（待同步到 Hub）
   */
  async addReport(report: HubReportRequest): Promise<void> {
    this.reports.push(report);
    await this.persistReports();
  }

  /**
   * 获取待同步的报告
   */
  getPendingReports(): HubReportRequest[] {
    return [...this.reports];
  }

  /**
   * 清除已同步的报告
   */
  async clearReports(): Promise<void> {
    this.reports = [];
    await this.persistReports();
  }

  // ==================== 搜索 ====================

  /**
   * 按信号搜索（关键词匹配）
   */
  searchBySignals(signals: string[]): ExperienceSearchResult[] {
    const results: ExperienceSearchResult[] = [];
    const normalizedSignals = signals.map(s => s.toLowerCase());

    for (const gene of this.genes.values()) {
      // 计算匹配度
      const matchScore = this.computeMatchScore(gene, normalizedSignals);
      if (matchScore < 0.2) continue; // 最低匹配阈值

      // 获取最佳胶囊
      const capsule = this.getBestCapsule(gene.gene_id);
      if (!capsule) continue;

      results.push({
        gene,
        capsule,
        matchScore,
        source: 'local',
      });
    }

    // 按匹配度排序
    return results.sort((a, b) => b.matchScore - a.matchScore);
  }

  /**
   * 计算基因与信号的匹配度
   */
  private computeMatchScore(gene: ShrimpGene, normalizedSignals: string[]): number {
    let matched = 0;
    let total = gene.signals.length;

    for (const geneSignal of gene.signals) {
      const normalizedGene = geneSignal.toLowerCase();
      for (const querySignal of normalizedSignals) {
        if (normalizedGene.includes(querySignal) || querySignal.includes(normalizedGene)) {
          matched++;
          break;
        }
      }
    }

    if (total === 0) return 0;
    return matched / total;
  }

  // ==================== 统计 ====================

  getStats(): LocalStoreStats {
    const categories: Record<GeneCategory, number> = {
      task_fix: 0, env_fix: 0, api_compat: 0, performance: 0, security: 0,
    };

    for (const gene of this.genes.values()) {
      categories[gene.category]++;
    }

    return {
      genes: this.genes.size,
      capsules: this.capsules.size,
      events: this.events.length,
      categories,
    };
  }

  // ==================== 持久化 ====================

  private get filePaths() {
    return {
      genes: join(this.storePath, 'genes.json'),
      capsules: join(this.storePath, 'capsules.json'),
      events: join(this.storePath, 'events.json'),
      reports: join(this.storePath, 'reports.json'),
    };
  }

  private async loadGenes(): Promise<void> {
    const { genes: filePath } = this.filePaths;
    if (!existsSync(filePath)) return;

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Array.isArray(data)) {
        for (const gene of data) {
          this.genes.set(gene.gene_id, gene);
        }
      }
    } catch (err) {
      this.logger.warn('基因数据加载失败，将使用空经验池', { error: (err as Error).message });
    }
  }

  private async loadCapsules(): Promise<void> {
    const { capsules: filePath } = this.filePaths;
    if (!existsSync(filePath)) return;

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Array.isArray(data)) {
        for (const cap of data) {
          this.capsules.set(cap.capsule_id, cap);
        }
      }
    } catch (err) {
      this.logger.warn('胶囊数据加载失败', { error: (err as Error).message });
    }
  }

  private async loadEvents(): Promise<void> {
    const { events: filePath } = this.filePaths;
    if (!existsSync(filePath)) return;

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Array.isArray(data)) {
        this.events = data;
      }
    } catch (err) {
      this.logger.warn('进化事件数据加载失败', { error: (err as Error).message });
    }
  }

  private async loadReports(): Promise<void> {
    const { reports: filePath } = this.filePaths;
    if (!existsSync(filePath)) return;

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Array.isArray(data)) {
        this.reports = data;
      }
    } catch (err) {
      this.logger.warn('报告数据加载失败', { error: (err as Error).message });
    }
  }

  private async persistGenes(): Promise<void> {
    const { genes: filePath } = this.filePaths;
    const data = Array.from(this.genes.values());
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private async persistCapsules(): Promise<void> {
    const { capsules: filePath } = this.filePaths;
    const data = Array.from(this.capsules.values());
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private async persistEvents(): Promise<void> {
    const { events: filePath } = this.filePaths;
    writeFileSync(filePath, JSON.stringify(this.events, null, 2), 'utf-8');
  }

  private async persistReports(): Promise<void> {
    const { reports: filePath } = this.filePaths;
    writeFileSync(filePath, JSON.stringify(this.reports, null, 2), 'utf-8');
  }
}
