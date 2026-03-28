/**
 * 经验搜索引擎 (v2 - 本地+Hub联合 + TF-IDF语义搜索)
 *
 * 搜索策略:
 * 1. 本地经验池：TF-IDF 关键词匹配
 * 2. Hub 远程：如果有本地结果不足，补充搜索 Hub
 * 3. 结果合并去重，按综合评分排序
 */

import { createLogger, type Logger } from '../core/logger.js';
import { LocalExperienceStore } from './local-store.js';
import { SignalDetector } from './signal-detector.js';
import { ShrimpHubClient } from './hub-client.js';
import type {
  ExperienceSearchResult, ShrimpGene, ShrimpCapsule,
  ExperienceConfig, HubSearchResponse, GeneGDIScore,
} from './types.js';

export class ExperienceSearchEngine {
  private logger: Logger;
  private store: LocalExperienceStore;
  private signalDetector: SignalDetector;
  private config: ExperienceConfig;
  private hubClient: ShrimpHubClient | null = null;

  constructor(store: LocalExperienceStore, config: ExperienceConfig, hubClient?: ShrimpHubClient) {
    this.logger = createLogger('ExperienceEngine');
    this.store = store;
    this.signalDetector = new SignalDetector();
    this.config = config;

    if (hubClient) {
      this.hubClient = hubClient;
    }
  }

  /**
   * 设置 Hub 客户端
   */
  setHubClient(client: ShrimpHubClient): void {
    this.hubClient = client;
  }

  /**
   * 错误发生时自动搜索匹配经验
   */
  async searchByError(errorMessage: string): Promise<ExperienceSearchResult | null> {
    if (!this.config.autoSearch.enabled) return null;

    // 1. 检测信号
    const detected = this.signalDetector.detect(errorMessage);
    if (!detected.shouldSearch) return null;

    // 2. 联合搜索（本地 + Hub）
    const allResults = await this.unifiedSearch(detected.signals, 3);

    if (allResults.length > 0) {
      const best = allResults[0];
      if (best.matchScore >= this.config.autoSearch.minConfidence) {
        this.logger.info(`经验命中 [${best.gene.gene_id.slice(0, 12)}...]`, {
          matchScore: best.matchScore,
          summary: best.gene.summary,
          source: best.source,
        });
        return best;
      }
    }

    this.logger.debug(`无匹配经验`, {
      signals: detected.signals.slice(0, 3),
      patternName: detected.patternName,
    });

    return null;
  }

  /**
   * 按信号手动搜索
   */
  async searchBySignals(signals: string[]): Promise<ExperienceSearchResult[]> {
    const results = await this.unifiedSearch(signals, 10);

    this.logger.info(`经验搜索完成`, {
      signals: signals.slice(0, 3),
      localHits: results.filter(r => r.source === 'local').length,
      hubHits: results.filter(r => r.source === 'hub').length,
    });

    return results;
  }

  /**
   * 语义搜索：基于 TF-IDF 的问题匹配
   * 输入自然语言问题，提取关键词后搜索
   */
  async semanticSearch(query: string, limit = 5): Promise<ExperienceSearchResult[]> {
    const keywords = this.extractKeywords(query);
    if (keywords.length === 0) return [];

    this.logger.debug(`语义搜索`, { query: query.slice(0, 50), keywords });
    return this.unifiedSearch(keywords, limit);
  }

  // ==================== 内部方法 ====================

  /**
   * 联合搜索：本地 + Hub
   */
  private async unifiedSearch(
    signals: string[],
    limit: number,
  ): Promise<ExperienceSearchResult[]> {
    // 1. 搜索本地经验池（TF-IDF）
    const localResults = this.searchLocal(signals);

    // 2. 如果本地结果不足且 Hub 启用，补充搜索 Hub
    let hubResults: ExperienceSearchResult[] = [];
    if (this.hubClient && this.config.hub.enabled && localResults.length < limit) {
      try {
        hubResults = await this.searchHub(signals, limit);
      } catch {
        // Hub 搜索失败不影响本地结果
      }
    }

    // 3. 合并去重（以 gene_id 去重，本地优先）
    const merged = this.mergeResults(localResults, hubResults);

    // 4. 按综合评分排序
    return merged.slice(0, limit);
  }

  /**
   * 本地搜索（增强版 TF-IDF 匹配）
   */
  private searchLocal(signals: string[]): ExperienceSearchResult[] {
    const rawResults = this.store.searchBySignals(signals);

    // 增强：对 summary 和 description 进行额外匹配
    for (const gene of this.store.getAllGenes()) {
      // 跳过已有的
      if (rawResults.some(r => r.gene.gene_id === gene.gene_id)) continue;

      const score = this.computeEnhancedScore(gene, signals);
      if (score >= 0.3) {
        const capsule = this.store.getBestCapsule(gene.gene_id);
        if (capsule) {
          rawResults.push({
            gene,
            capsule,
            matchScore: score,
            source: 'local',
          });
        }
      }
    }

    return rawResults.sort((a, b) => b.matchScore - a.matchScore);
  }

  /**
   * 增强 TF-IDF 匹配分数计算
   * 除了信号匹配外，还考虑 summary、description、tags 的关键词密度
   */
  private computeEnhancedScore(gene: ShrimpGene, querySignals: string[]): number {
    // 基础信号匹配分
    let baseScore = 0;
    const geneSignalsLower = gene.signals.map(s => s.toLowerCase());
    const queryLower = querySignals.map(s => s.toLowerCase());

    let matchedSignals = 0;
    for (const qs of queryLower) {
      for (const gs of geneSignalsLower) {
        if (gs.includes(qs) || qs.includes(gs)) {
          matchedSignals++;
          break;
        }
      }
    }
    if (geneSignalsLower.length > 0) {
      baseScore = matchedSignals / geneSignalsLower.length;
    }

    // TF（词频）: 关键词在 summary/description 中的密度
    const textBlob = [
      gene.summary,
      gene.description || '',
      ...gene.tags,
      ...gene.strategy.map(s => s.action),
    ].join(' ').toLowerCase();

    let tfHits = 0;
    for (const qs of queryLower) {
      if (textBlob.includes(qs)) tfHits++;
    }
    const tfScore = queryLower.length > 0 ? tfHits / queryLower.length : 0;

    // 综合分：信号 60% + 文本密度 40%
    return baseScore * 0.6 + tfScore * 0.4;
  }

  /**
   * Hub 搜索
   */
  private async searchHub(signals: string[], limit: number): Promise<ExperienceSearchResult[]> {
    if (!this.hubClient) return [];

    const response: HubSearchResponse | null = await this.hubClient.searchGenes(signals, limit);
    if (!response || !response.results) return [];

    return response.results.map(item => ({
      gene: item.gene,
      capsule: item.capsule,
      matchScore: this.hubMatchToScore(item.gdi, item.matchScore),
      source: 'hub' as const,
    }));
  }

  /**
   * 将 Hub 返回的 GDI + matchScore 转为统一评分
   */
  private hubMatchToScore(gdi: GeneGDIScore, matchScore?: number): number {
    // Hub 的 matchScore 如果有就用，否则基于 GDI 估算
    if (matchScore !== undefined) {
      return matchScore;
    }
    // GDI 综合分作为匹配度参考（打折，因为不是精确匹配）
    return (gdi?.overall || 0.5) * 0.8;
  }

  /**
   * 合并本地和 Hub 结果（去重，本地优先）
   */
  private mergeResults(
    local: ExperienceSearchResult[],
    hub: ExperienceSearchResult[],
  ): ExperienceSearchResult[] {
    const localGeneIds = new Set(local.map(r => r.gene.gene_id));

    const merged = [...local];

    for (const hubResult of hub) {
      // 去重：如果本地已有同 gene_id，跳过 Hub 版本
      if (localGeneIds.has(hubResult.gene.gene_id)) continue;

      // 同时保存 Hub 基因到本地缓存（供后续离线使用）
      this.cacheHubGene(hubResult).catch(() => {});

      merged.push(hubResult);
    }

    return merged.sort((a, b) => b.matchScore - a.matchScore);
  }

  /**
   * 缓存 Hub 基因到本地（异步，不阻塞）
   */
  private async cacheHubGene(result: ExperienceSearchResult): Promise<void> {
    try {
      // 检查本地是否已有
      if (this.store.getGene(result.gene.gene_id)) return;

      // 保存基因和胶囊到本地
      await this.store.saveGene(result.gene);
      if (result.capsule) {
        await this.store.saveCapsule(result.capsule);
      }

      this.logger.debug(`Hub 基因已缓存 [${result.gene.gene_id.slice(0, 12)}...]`);
    } catch {
      // 缓存失败不影响搜索结果
    }
  }

  /**
   * 从自然语言查询中提取关键词
   * 简单实现：分词 + 过滤停用词 + 取长度>=2的词
   */
  private extractKeywords(query: string): string[] {
    // 按常见分隔符分词
    const words = query
      .toLowerCase()
      .split(/[\s,，。.!！?？;；:：、\-\(\)（）\[\]【】\/\\|]+/)
      .filter(w => w.length >= 2)
      // 过滤常见停用词
      .filter(w => !['the', 'is', 'at', 'of', 'on', 'in', 'to', 'for', 'and', 'or', 'not', 'but', 'with', 'this', 'that', 'from', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'what', 'how', 'why', 'when', 'where', 'which', 'who', '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这'].includes(w));

    // 去重
    return [...new Set(words)].slice(0, 8);
  }

  /**
   * 获取信号检测器（供封装器使用）
   */
  getSignalDetector(): SignalDetector {
    return this.signalDetector;
  }

  /**
   * 获取存储实例
   */
  getStore(): LocalExperienceStore {
    return this.store;
  }
}
