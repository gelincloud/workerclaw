/**
 * WorkerClaw 配置定义
 */

// ==================== 平台配置 ====================

export interface PlatformConfig {
  /** 平台 HTTP API 地址 */
  apiUrl: string;
  /** 平台 WebSocket 地址 */
  wsUrl: string;
  /** Bot ID（认证后由平台分配） */
  botId: string;
  /** 认证 Token */
  token: string;
  /** Agent 名称（注册时使用） */
  agentName?: string;
  /** 重连配置 */
  reconnect: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

// ==================== LLM 配置 ====================

export interface LLMConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  safety: {
    maxTokens: number;
    temperature: number;
    topP: number;
  };
  retry: {
    maxRetries: number;
    backoffMs: number;
  };
}

// ==================== 安全配置 ====================

export interface RateLimitConfig {
  maxMessagesPerMinute: number;
  maxConcurrentTasks: number;
}

export interface PromptInjectionConfig {
  enabled: boolean;
  patterns?: string[];
}

export interface MaliciousCommandsConfig {
  enabled: boolean;
  blockPatterns?: string[];
}

export interface PIIProtectionConfig {
  enabled: boolean;
  detectTypes?: ('email' | 'phone' | 'id_card' | 'api_key' | 'password')[];
  action?: 'mask' | 'block' | 'warn';
}

export interface ResourceExhaustionConfig {
  maxOutputTokens: number;
  maxToolCallsPerTask: number;
  maxTotalDurationMs: number;
}

export interface DataExfiltrationConfig {
  enabled: boolean;
  blockedDomains?: string[];
  allowedDomains?: string[];
  blockUnknownDomains?: boolean;
}

export interface SecurityConfig {
  rateLimit: RateLimitConfig;
  contentScan: {
    promptInjection: PromptInjectionConfig;
    maliciousCommands: MaliciousCommandsConfig;
    piiProtection?: PIIProtectionConfig;
    resourceExhaustion?: ResourceExhaustionConfig;
    dataExfiltration?: DataExfiltrationConfig;
  };
  sandbox: {
    workDir: string;
    commandTimeoutMs: number;
    taskTimeoutMs: number;
    maxMemoryMB?: number;
    maxOutputKB?: number;
    allowedPaths?: string[];
    deniedPaths?: string[];
    allowLocalhost?: boolean;
    allowedDomains?: string[];
    deniedDomains?: string[];
    /** 浏览器沙箱配置 */
    browser?: BrowserSandboxConfig;
  };
}

/** 浏览器沙箱配置 */
export interface BrowserSandboxConfig {
  /** 页面加载超时 (ms)，默认 30000 */
  pageTimeoutMs?: number;
  /** 页面最大大小 (KB)，默认 2048 (2MB) */
  maxPageSizeKB?: number;
  /** 截图最大宽度 (px)，默认 1280 */
  screenshotMaxWidth?: number;
  /** 截图 JPEG 质量 (0-1)，默认 0.7 */
  screenshotQuality?: number;
  /** 截图最大大小 (KB)，默认 512 */
  screenshotMaxSizeKB?: number;
  /** 是否启用 JavaScript（默认 true） */
  enableJavaScript?: boolean;
  /** 是否拦截弹窗（默认 true） */
  blockPopups?: boolean;
  /** User-Agent 覆盖 */
  userAgent?: string;
  /** 代理服务器 URL */
  proxyUrl?: string;
}

// ==================== 任务配置 ====================

export interface TaskConfig {
  autoAccept: {
    enabled: boolean;
    threshold: number;
    maxConcurrent: number;
  };
  /** 并发控制 */
  concurrency: {
    maxConcurrent: number;
    maxPerType: Partial<Record<string, number>>;
    queueSize: number;
    priority: {
      highValueFirst: boolean;
      urgentFirst: boolean;
    };
  };
  /** 任务评估 */
  evaluation: {
    acceptThreshold: number;
    deferThreshold: number;
    weights: {
      capability: number;
      capacity: number;
      risk: number;
    };
    capabilityScores: Partial<Record<string, number>>;
  };
  /** 超时与重试 */
  timeout: {
    taskTimeoutMs: number;
    llmTimeoutMs: number;
    queueTimeoutMs: number;
    retryOnTimeout: boolean;
    maxRetries: number;
    retryDelayMs: number;
  };
}

// ==================== 完整配置 ====================

export interface ActiveBehaviorConfig {
  /** 是否启用智能活跃行为 */
  enabled: boolean;
  /** 调度间隔 (ms) */
  checkIntervalMs: number;
  /** 最小空闲时间 (ms) */
  minIdleTimeMs: number;
  /** 行为概率权重 */
  weights: {
    tweet: number;
    browse: number;
    comment: number;
    like: number;
  };
}

export interface WorkerClawConfig {
  /** WorkerClaw 实例 ID */
  id: string;
  /** 实例名称 */
  name: string;
  /** 平台配置 */
  platform: PlatformConfig;
  /** LLM 配置 */
  llm: LLMConfig;
  /** 安全配置 */
  security: SecurityConfig;
  /** 任务配置 */
  task: TaskConfig;
  /** 人格配置 */
  personality: {
    name: string;
    tone: string;
    bio: string;
    description?: string;
    expertise?: string[];
    language?: string;
    customSystemPrompt?: string;
    behavior?: {
      proactivity: number;
      humor: number;
      formality: number;
    };
  };
  /** 智能活跃行为配置 */
  activeBehavior?: ActiveBehaviorConfig;
  /** 经验基因系统配置 */
  experience?: import('../experience/types.js').ExperienceConfig;
}

// ==================== 默认配置 ====================

export const DEFAULT_CONFIG: Omit<WorkerClawConfig, 'platform' | 'llm'> = {
  id: 'worker-001',
  name: 'WorkerClaw',
  security: {
    rateLimit: {
      maxMessagesPerMinute: 30,
      maxConcurrentTasks: 3,
    },
    contentScan: {
      promptInjection: { enabled: true },
      maliciousCommands: { enabled: true },
      piiProtection: { enabled: false, action: 'warn' },
      resourceExhaustion: { maxOutputTokens: 8000, maxToolCallsPerTask: 20, maxTotalDurationMs: 300000 },
      dataExfiltration: { enabled: true, blockedDomains: [], allowedDomains: [], blockUnknownDomains: false },
    },
    sandbox: {
      workDir: './data/sandbox',
      commandTimeoutMs: 30000,
      taskTimeoutMs: 300000,
      maxMemoryMB: 512,
      maxOutputKB: 1024,
      allowedPaths: [],
      deniedPaths: ['/etc', '/var', '/usr', '/System', '/Library', '/proc', '/sys'],
      allowLocalhost: false,
      allowedDomains: [],
      deniedDomains: [],
    },
  },
  task: {
    autoAccept: {
      enabled: true,
      threshold: 75,
      maxConcurrent: 3,
    },
    concurrency: {
      maxConcurrent: 3,
      maxPerType: {},
      queueSize: 10,
      priority: {
        highValueFirst: true,
        urgentFirst: true,
      },
    },
    evaluation: {
      acceptThreshold: 80,
      deferThreshold: 60,
      weights: {
        capability: 0.5,
        capacity: 0.2,
        risk: 0.3,
      },
      capabilityScores: {
        text_reply: 90,
        qa: 85,
        translation: 80,
        search_summary: 75,
        writing: 70,
        image_gen: 60,
        data_analysis: 55,
        code_dev: 40,
        system_op: 30,
      },
    },
    timeout: {
      taskTimeoutMs: 300000,
      llmTimeoutMs: 60000,
      queueTimeoutMs: 60000,
      retryOnTimeout: false,
      maxRetries: 1,
      retryDelayMs: 5000,
    },
  },
  personality: {
    name: '小工虾',
    tone: '专业、友好、高效',
    bio: '智工坊平台的打工虾',
  },
  activeBehavior: {
    enabled: true,
    checkIntervalMs: 5 * 60 * 1000,
    minIdleTimeMs: 10 * 60 * 1000,
    weights: {
      tweet: 15,
      browse: 35,
      comment: 20,
      like: 30,
    },
  },
};

/**
 * 深度合并配置
 */
export function mergeConfig(
  base: Partial<WorkerClawConfig>,
  overrides: Partial<WorkerClawConfig>,
): WorkerClawConfig {
  return {
    ...DEFAULT_CONFIG,
    ...base,
    ...overrides,
    security: { ...DEFAULT_CONFIG.security, ...base.security, ...overrides.security },
    task: { ...DEFAULT_CONFIG.task, ...base.task, ...overrides.task },
    personality: { ...DEFAULT_CONFIG.personality, ...base.personality, ...overrides.personality },
    platform: { ...((base as any).platform || {}), ...((overrides as any).platform || {}) } as PlatformConfig,
    llm: { ...((base as any).llm || {}), ...((overrides as any).llm || {}) } as LLMConfig,
  } as WorkerClawConfig;
}
