/**
 * 经验基因系统 - 类型定义
 * 
 * 参照 evomap GEP 协议设计，适配 WorkerClaw 公域任务场景
 */

// ==================== 基因分类 ====================

export type GeneCategory =
  | 'task_fix'      // 任务执行中的修复
  | 'env_fix'       // 环境配置修复
  | 'api_compat'    // API兼容性适配
  | 'performance'   // 性能优化
  | 'security';     // 安全加固

// ==================== 策略步骤 ====================

export interface StrategyStep {
  /** 步骤序号 */
  step: number;
  /** 操作描述 */
  action: string;
  /** 执行命令（如有） */
  command?: string;
  /** 代码片段（如有） */
  code?: string;
  /** 目标文件（如有） */
  file?: string;
  /** 原理说明 */
  explanation: string;
}

// ==================== 经验基因 ====================

export interface ShrimpGene {
  type: 'Gene';
  schema_version: '1.0.0';

  // === 身份 ===
  gene_id: string;
  author_node: string;

  // === 分类 ===
  category: GeneCategory;

  // === 触发信号 ===
  signals: string[];

  // === 策略描述 ===
  summary: string;
  description?: string;

  // === 适用范围 ===
  applicable_scenarios: {
    task_types?: string[];
    platforms?: string[];
    runtime_versions?: string[];
    frameworks?: string[];
  };

  // === 策略内容 ===
  strategy: StrategyStep[];

  // === 验证 ===
  validation?: {
    commands?: string[];
    expected_outcome: string;
  };

  // === 元数据 ===
  tags: string[];
  created_at: string;
  updated_at?: string;
  version: number;
  parent_gene?: string;
}

// ==================== 经验胶囊 ====================

export interface ShrimpCapsule {
  type: 'Capsule';
  schema_version: '1.0.0';

  // === 身份 ===
  capsule_id: string;
  gene_id: string;

  // === 上下文 ===
  trigger: string[];
  context: {
    task_id?: string;
    task_type?: string;
    error_message?: string;
    environment: {
      os: string;
      node_version: string;
      platform_version?: string;
      llm_model?: string;
    };
  };

  // === 实际执行 ===
  strategy_applied: StrategyStep[];
  diff?: string;
  content: string;

  // === 验证结果 ===
  outcome: {
    status: 'success' | 'partial' | 'failed';
    score: number;
    verified_at: string;
    verification_count: number;
  };

  // === 影响范围 ===
  blast_radius: {
    files: number;
    lines: number;
    components: string[];
  };

  // === 评分 ===
  confidence: number;
  success_streak: number;

  // === 元数据 ===
  created_at: string;
  author_node: string;
}

// ==================== 进化事件 ====================

export interface ShrimpEvolution {
  type: 'EvolutionEvent';

  intent: 'repair' | 'optimize' | 'innovate';

  capsule_id?: string;
  gene_id?: string;

  process: {
    signal_detected: string;
    initial_approach: string;
    mutations_tried: number;
    mutations: Array<{
      approach: string;
      result: 'success' | 'failed';
      error?: string;
      duration_ms: number;
    }>;
  };

  outcome: {
    status: 'success' | 'failed';
    score: number;
    total_duration_ms: number;
  };

  created_at: string;
  author_node: string;
}

// ==================== GDI 评分 ====================

export interface GeneGDIScore {
  /** 综合评分 0-1 */
  overall: number;
  /** 质量分 0-1 */
  quality: number;
  /** 使用分 0-1 */
  usage: number;
  /** 新鲜分 0-1 */
  freshness: number;
}

// ==================== 搜索结果 ====================

export interface ExperienceSearchResult {
  gene: ShrimpGene;
  capsule: ShrimpCapsule;
  /** 匹配度 0-1 */
  matchScore: number;
  /** 来源 */
  source: 'local' | 'hub';
}

// ==================== 经验配置 ====================

export interface ExperienceConfig {
  /** 是否启用经验系统 */
  enabled: boolean;
  /** 本地经验池存储路径 */
  storagePath: string;
  /** 自动搜索触发（遇到错误时自动搜索经验） */
  autoSearch: {
    enabled: boolean;
    /** 最低触发置信度阈值 */
    minConfidence: number;
  };
  /** 自动封装（修复成功后自动生成经验） */
  autoEncapsulate: {
    enabled: boolean;
    /** 最小步骤数（少于N步不封装） */
    minSteps: number;
  };
  /** Hub 同步 */
  hub: {
    enabled: boolean;
    /** 同步间隔 (ms) */
    syncIntervalMs: number;
    /** API 端点 */
    endpoint: string;
  };
}

// ==================== Hub API 类型 ====================

export interface HubPublishGeneRequest {
  gene: ShrimpGene;
  capsule?: ShrimpCapsule;
}

export interface HubSearchRequest {
  signals: string[];
  category?: GeneCategory;
  limit?: number;
  offset?: number;
}

export interface HubSearchResponse {
  results: Array<{
    gene: ShrimpGene;
    capsule: ShrimpCapsule;
    gdi: GeneGDIScore;
    /** 服务端计算的匹配度 0-1 */
    matchScore?: number;
  }>;
  total: number;
}

export interface HubReportRequest {
  capsule_id: string;
  applied_successfully: boolean;
  score?: number;
  feedback?: string;
}

// ==================== 事件类型 ====================

export interface ExperienceGainedData {
  gene_id: string;
  capsule_id?: string;
  category: GeneCategory;
  summary: string;
}

export interface ExperienceAppliedData {
  gene_id: string;
  capsule_id: string;
  matchScore: number;
  source: 'local' | 'hub';
}
