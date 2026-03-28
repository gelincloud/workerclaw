/**
 * 经验封装器
 * 
 * 从修复过程中自动提取 Gene + Capsule + Evolution
 * 使用 Node.js 内置 crypto 计算 hash（避免外部依赖）
 */

import { createHash, randomUUID } from 'node:crypto';
import { createLogger, type Logger } from '../core/logger.js';
import { LocalExperienceStore } from './local-store.js';
import type {
  ShrimpGene, ShrimpCapsule, ShrimpEvolution,
  GeneCategory, StrategyStep,
} from './types.js';

// ==================== 进化过程追踪 ====================

export interface EvolutionProcess {
  /** 检测到的错误信号 */
  signalDetected: string;
  /** 原始错误信息 */
  errorMessage: string;
  /** 任务 ID */
  taskId?: string;
  /** 任务类型 */
  taskType?: string;
  /** 初始方案 */
  initialApproach: string;
  /** 尝试的方案列表 */
  mutations: Array<{
    approach: string;
    result: 'success' | 'failed';
    error?: string;
    duration_ms: number;
  }>;
  /** 最终结果 */
  finalStatus: 'success' | 'failed';
  /** 总耗时 */
  totalDurationMs: number;
  /** 修复内容描述 */
  fixSummary: string;
  /** 修复步骤 */
  fixSteps: StrategyStep[];
  /** 代码变更 */
  diff?: string;
  /** 影响的文件数 */
  filesAffected?: number;
  /** 影响的行数 */
  linesChanged?: number;
  /** 影响的组件 */
  components?: string[];
}

// ==================== 经验封装器 ====================

export class ExperienceEncapsulator {
  private logger: Logger;
  private store: LocalExperienceStore;
  private authorNode: string;

  constructor(store: LocalExperienceStore, authorNode: string) {
    this.logger = createLogger('Encapsulator');
    this.store = store;
    this.authorNode = authorNode;
  }

  /**
   * 从修复过程中自动封装经验
   * 返回 { gene, capsule, event } 或 null（如果不值得封装）
   */
  async encapsulate(process: EvolutionProcess): Promise<{
    gene: ShrimpGene;
    capsule: ShrimpCapsule;
    event: ShrimpEvolution;
  } | null> {
    // 检查是否值得封装
    if (process.finalStatus !== 'success') {
      this.logger.debug('修复未成功，跳过封装');
      return null;
    }

    if (process.fixSteps.length < 1) {
      this.logger.debug('修复步骤为空，跳过封装');
      return null;
    }

    try {
      // 1. 生成基因
      const gene = this.buildGene(process);

      // 2. 生成胶囊
      const capsule = this.buildCapsule(process, gene.gene_id);

      // 3. 生成进化事件
      const event = this.buildEvolution(process, gene.gene_id, capsule.capsule_id);

      // 4. 保存到本地经验池
      await this.store.saveGene(gene);
      await this.store.saveCapsule(capsule);
      await this.store.recordEvent(event);

      this.logger.info(`经验已封装 [${gene.gene_id.slice(0, 12)}...]`, {
        category: gene.category,
        summary: gene.summary,
        steps: gene.strategy.length,
      });

      return { gene, capsule, event };
    } catch (err) {
      this.logger.error('经验封装失败', { error: (err as Error).message });
      return null;
    }
  }

  /**
   * 构建经验基因
   */
  private buildGene(process: EvolutionProcess): ShrimpGene {
    const now = new Date().toISOString();

    // 提取信号关键词
    const signals = this.extractSignals(process.errorMessage, process.signalDetected);

    // 推断分类
    const category = this.inferCategory(process);

    const gene: ShrimpGene = {
      type: 'Gene',
      schema_version: '1.0.0',
      gene_id: '', // 先空，后面计算 hash
      author_node: this.authorNode,
      category,
      signals,
      summary: process.fixSummary,
      applicable_scenarios: {
        task_types: process.taskType ? [process.taskType] : undefined,
        platforms: ['miniabc'],
      },
      strategy: process.fixSteps,
      validation: {
        expected_outcome: '错误不再出现，任务正常执行',
      },
      tags: [category, ...(process.components || [])],
      created_at: now,
      version: 1,
    };

    // 计算 gene_id (sha256 hash of canonical JSON, excluding gene_id)
    gene.gene_id = this.computeHash(JSON.stringify(this.canonicalize(gene)));

    return gene;
  }

  /**
   * 构建经验胶囊
   */
  private buildCapsule(process: EvolutionProcess, geneId: string): ShrimpCapsule {
    const now = new Date().toISOString();

    const capsule: ShrimpCapsule = {
      type: 'Capsule',
      schema_version: '1.0.0',
      capsule_id: randomUUID(),
      gene_id: geneId,
      trigger: [process.signalDetected],
      context: {
        task_id: process.taskId,
        task_type: process.taskType,
        error_message: process.errorMessage.slice(0, 2000),
        environment: this.getEnvironment(),
      },
      strategy_applied: process.fixSteps,
      diff: process.diff,
      content: this.buildContent(process),
      outcome: {
        status: 'success',
        score: 1.0,
        verified_at: now,
        verification_count: 1,
      },
      blast_radius: {
        files: process.filesAffected || 0,
        lines: process.linesChanged || 0,
        components: process.components || [],
      },
      confidence: 0.8, // 初始置信度，随验证提升
      success_streak: 1,
      created_at: now,
      author_node: this.authorNode,
    };

    return capsule;
  }

  /**
   * 构建进化事件
   */
  private buildEvolution(
    process: EvolutionProcess,
    geneId: string,
    capsuleId: string,
  ): ShrimpEvolution {
    return {
      type: 'EvolutionEvent',
      intent: 'repair',
      capsule_id: capsuleId,
      gene_id: geneId,
      process: {
        signal_detected: process.signalDetected,
        initial_approach: process.initialApproach,
        mutations_tried: process.mutations.length,
        mutations: process.mutations,
      },
      outcome: {
        status: process.finalStatus,
        score: process.finalStatus === 'success' ? 1.0 : 0.0,
        total_duration_ms: process.totalDurationMs,
      },
      created_at: new Date().toISOString(),
      author_node: this.authorNode,
    };
  }

  /**
   * 从错误信息中提取信号
   */
  private extractSignals(errorMessage: string, primarySignal: string): string[] {
    const signals = new Set<string>();
    signals.add(primarySignal);

    // 从错误信息中提取关键短语
    const patterns = [
      /Cannot find module ['"]([^'"]+)['"]/i,
      /'([^']+)'.*Field required/i,
      /HTTP (\d{3})/i,
      /\b([A-Z]{3,}[A-Z_]+)\b/, // 错误码
    ];

    for (const p of patterns) {
      const m = errorMessage.match(p);
      if (m) signals.add(m[1] || m[0]);
    }

    // 截断过长的信号
    return [...signals].map(s => s.slice(0, 100)).slice(0, 10);
  }

  /**
   * 推断基因分类
   */
  private inferCategory(process: EvolutionProcess): GeneCategory {
    const msg = (process.errorMessage + ' ' + process.fixSummary).toLowerCase();

    if (/api|endpoint|route|http|websocket|status/i.test(msg)) return 'api_compat';
    if (/permission|security|auth|token|sandbox/i.test(msg)) return 'security';
    if (/speed|performance|timeout|slow|optimize/i.test(msg)) return 'performance';
    if (/env|config|path|install|setup|node_version/i.test(msg)) return 'env_fix';
    return 'task_fix';
  }

  /**
   * 获取当前环境信息
   */
  private getEnvironment() {
    return {
      os: process.platform,
      node_version: process.version,
    };
  }

  /**
   * 构建结构化内容描述
   */
  private buildContent(process: EvolutionProcess): string {
    return [
      `## 问题`,
      process.errorMessage.slice(0, 500),
      ``,
      `## 修复方案`,
      process.fixSteps.map(s => `${s.step}. ${s.action} — ${s.explanation}`).join('\n'),
      ``,
      `## 结果`,
      process.finalStatus === 'success' ? '修复成功' : '修复失败',
    ].join('\n');
  }

  /**
   * 规范化对象（排序键，去除空值，用于 hash 计算）
   */
  private canonicalize(obj: any): any {
    if (obj === null || obj === undefined) return undefined;
    if (Array.isArray(obj)) return obj.map(v => this.canonicalize(v)).filter(v => v !== undefined);
    if (typeof obj === 'object') {
      const sorted: Record<string, any> = {};
      for (const key of Object.keys(obj).sort()) {
        if (key === 'gene_id') continue; // 排除 gene_id 自身
        const val = this.canonicalize(obj[key]);
        if (val !== undefined) sorted[key] = val;
      }
      return sorted;
    }
    return obj;
  }

  /**
   * 计算 SHA256 hash
   */
  private computeHash(data: string): string {
    return createHash('sha256').update(data).digest('hex');
  }
}
