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
  /** 超时配置（可选，从全局配置继承） */
  timeout?: {
    llmTimeoutMs: number;
  };
  /** 多端点配置（支持 API Key 轮换） */
  endpoints?: Array<{
    name?: string;
    apiKey: string;
    baseUrl?: string;
    model?: string;
    weight?: number;
    enabled?: boolean;
    maxQps?: number;
  }>;
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

/** WhatsApp 集成配置 */
export interface WhatsAppConfig {
  /** 是否启用 WhatsApp 技能 */
  enabled?: boolean;
  /** 会话存储路径（相对路径），默认 ./data/whatsapp-session */
  sessionPath?: string;
  /** 自动回复配置 */
  autoReply?: {
    /** 是否启用自动回复，默认 true */
    enabled?: boolean;
    /** LLM 系统提示（自定义客服人设） */
    systemPrompt?: string;
    /** 上下文消息数量（多少条历史消息作为 LLM 上下文），默认 20 */
    maxContextMessages?: number;
    /** 黑名单号码（不自动回复），默认包含 status@broadcast */
    blacklist?: string[];
    /** 每分钟最大发送消息数，默认 30 */
    maxMessagesPerMinute?: number;
    /** 空闲超时 (ms)，超过此时间的新消息不回复，默认无限制 */
    idleTimeoutMs?: number;
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

// ==================== 价格配置 ====================

/** 任务类型价格区间（单位：分） */
export interface PriceRange {
  /** 最低价（分） */
  min: number;
  /** 建议默认价（分） */
  default: number;
  /** 最高价（分） */
  max: number;
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
  /** 任务估价配置（单位：分） */
  pricing?: Partial<Record<string, PriceRange>>;
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

// ==================== 微博运营指挥官配置 ====================

export interface WeiboCommanderConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 塘主ID（用于获取微博凭据） */
  ownerId: string;
  /** 数据采集配置 */
  collection: {
    /** 采集间隔 (ms)，默认 30分钟 */
    intervalMs: number;
    /** 是否采集热搜 */
    collectTrending: boolean;
    /** 是否采集互动数据 */
    collectInteractions: boolean;
  };
  /** 自动化配置 */
  automation: {
    /** 是否启用自动发布 */
    autoPost: boolean;
    /** 是否启用自动回复 */
    autoReply: boolean;
    /** 每日最大发布数 */
    maxPostsPerDay: number;
    /** 每日最大回复数 */
    maxRepliesPerDay: number;
    /** 是否需要在执行前确认 */
    requireConfirmation: boolean;
  };
  /** 运营模板 ID */
  templateId?: string;
  /** 数据存储目录 */
  dataDir?: string;
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
    browse_blog: number;
    comment: number;
    like: number;
    blog: number;
    blog_comment: number;
    chat: number;
    game: number;
    idle: number;
  };
}

/** 企业版 License 配置 */
export interface EnterpriseLicense {
  /** License Key */
  key: string;
  /** 激活状态 */
  activated: boolean;
  /** 激活时间 */
  activatedAt?: string;
  /** 到期时间 */
  expiresAt?: string;
}

export interface WorkerClawConfig {
  /** WorkerClaw 实例 ID */
  id: string;
  /** 实例名称 */
  name: string;
  /** 运行模式: 'public' (公域打工虾) | 'private' (私有内勤虾) */
  mode?: 'public' | 'private';
  /** 企业版 License */
  enterprise?: EnterpriseLicense;
  /** 本地媒体资料库目录（私有虾专用） */
  mediaDir?: string;
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
  /** 定时任务调度配置（私有虾专用） */
  recurringTasks?: import('../scheduler/recurring-task-scheduler.js').RecurringTaskSchedulerConfig;
  /** 微博运营指挥官配置（私有虾专用） */
  weiboCommander?: WeiboCommanderConfig;
  /** WhatsApp 集成配置 */
  whatsapp?: WhatsAppConfig;
}

// ==================== 默认配置 ====================

export const DEFAULT_CONFIG: Omit<WorkerClawConfig, 'platform' | 'llm'> = {
  id: 'worker-001',
  name: 'WorkerClaw',
  mode: 'public',
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
      deferThreshold: 40, // v2: 从 60 降到 40，让更多任务进入"可以考虑"区间
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
    pricing: {
      text_reply:     { min: 5,    default: 10,   max: 50 },     // ¥0.05-0.50
      qa:             { min: 5,    default: 15,   max: 80 },     // ¥0.05-0.80
      translation:    { min: 20,   default: 50,   max: 200 },    // ¥0.20-2.00
      search_summary: { min: 10,   default: 30,   max: 150 },    // ¥0.10-1.50
      writing:        { min: 30,   default: 100,  max: 500 },    // ¥0.30-5.00
      image_gen:      { min: 20,   default: 80,   max: 300 },    // ¥0.20-3.00
      data_analysis:  { min: 50,   default: 200,  max: 1000 },   // ¥0.50-10.00
      code_dev:       { min: 100,  default: 500,  max: 3000 },   // ¥1.00-30.00
      system_op:      { min: 100,  default: 500,  max: 3000 },   // ¥1.00-30.00
      other:          { min: 5,    default: 20,   max: 200 },    // ¥0.05-2.00
    },
    timeout: {
      taskTimeoutMs: 300000,
      llmTimeoutMs: 180000,  // 3 分钟，GLM 等国产模型响应较慢
      queueTimeoutMs: 60000,
      retryOnTimeout: true,  // 超时自动重试
      maxRetries: 2,         // 重试 2 次
      retryDelayMs: 3000,
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
      tweet: 10,
      browse: 20,
      browse_blog: 10,
      comment: 14,
      like: 15,
      blog: 8,
      blog_comment: 6,
      chat: 12,
      game: 5,
      idle: 3,
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
    task: {
      ...DEFAULT_CONFIG.task,
      ...base.task,
      ...overrides.task,
      concurrency: {
        ...DEFAULT_CONFIG.task.concurrency,
        ...base.task?.concurrency,
        ...overrides.task?.concurrency,
        priority: {
          ...DEFAULT_CONFIG.task.concurrency.priority,
          ...base.task?.concurrency?.priority,
          ...overrides.task?.concurrency?.priority,
        },
      },
      evaluation: {
        ...DEFAULT_CONFIG.task.evaluation,
        ...base.task?.evaluation,
        ...overrides.task?.evaluation,
      },
      pricing: {
        ...DEFAULT_CONFIG.task.pricing,
        ...base.task?.pricing,
        ...overrides.task?.pricing,
      },
      timeout: {
        ...DEFAULT_CONFIG.task.timeout,
        ...base.task?.timeout,
        ...overrides.task?.timeout,
      },
    },
    personality: { ...DEFAULT_CONFIG.personality, ...base.personality, ...overrides.personality },
    platform: { ...((base as any).platform || {}), ...((overrides as any).platform || {}) } as PlatformConfig,
    llm: {
      ...((base as any).llm || {}),
      ...((overrides as any).llm || {}),
      // 合并 safety 配置
      safety: {
        maxTokens: 4000,
        temperature: 0.7,
        topP: 0.9,
        ...((base as any).llm?.safety || {}),
        ...((overrides as any).llm?.safety || {}),
      },
      // 合并 retry 配置
      retry: {
        maxRetries: 3,
        backoffMs: 1000,
        ...((base as any).llm?.retry || {}),
        ...((overrides as any).llm?.retry || {}),
      },
      // 传递 LLM 超时配置（从 task.timeout 继承）
      timeout: {
        llmTimeoutMs: DEFAULT_CONFIG.task.timeout.llmTimeoutMs,
        ...((base as any).task?.timeout?.llmTimeoutMs ? { llmTimeoutMs: (base as any).task.timeout.llmTimeoutMs } : {}),
        ...((overrides as any).task?.timeout?.llmTimeoutMs ? { llmTimeoutMs: (overrides as any).task.timeout.llmTimeoutMs } : {}),
      },
    } as LLMConfig,
  } as WorkerClawConfig;
}
