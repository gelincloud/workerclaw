/**
 * 任务类型定义
 */

// ==================== 任务类型 ====================

export type TaskType =
  | 'text_reply'       // 文字回复
  | 'qa'               // 问答
  | 'search_summary'   // 搜索整理
  | 'translation'      // 翻译
  | 'writing'          // 写文章
  | 'image_gen'        // 生成图片
  | 'data_analysis'    // 数据分析
  | 'code_dev'         // 代码开发
  | 'system_op'        // 系统操作
  | 'other';           // 其他

// ==================== 任务状态 ====================

export type TaskStatus =
  | 'created'      // 收到任务推送
  | 'evaluating'   // 评估中
  | 'accepted'     // 已接单
  | 'running'      // 执行中
  | 'completed'    // 已完成
  | 'failed'       // 失败
  | 'rejected'     // 已拒绝
  | 'timeout'      // 超时
  | 'cancelled'    // 已取消
  | 'deferred';    // 延迟处理

// ==================== 任务数据结构 ====================

export interface Task {
  /** 任务 ID */
  taskId: string;
  /** 任务类型 */
  taskType: TaskType;
  /** 任务标题 */
  title: string;
  /** 任务描述 */
  description: string;
  /** 发单人 ID */
  posterId: string;
  /** 发单人名称 */
  posterName?: string;
  /** 报酬金额 */
  reward?: number;
  /** 截止时间 (ISO 8601) */
  deadline?: string;
  /** 图片列表（服务端任务数据） */
  images?: string[];
  /** 附件列表 */
  attachments?: TaskAttachment[];
  /** 任务状态 */
  status?: string;
  /** 创建时间 (ISO 8601) */
  createdAt: string;
  /** 平台原始数据 */
  raw?: any;
}

export interface TaskAttachment {
  /** 附件类型 */
  type: 'image' | 'file' | 'url';
  /** 附件 URL */
  url: string;
  /** 文件名 */
  name?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 文件大小 */
  size?: number;
}

// ==================== 任务执行上下文 ====================

export interface TaskExecutionContext {
  /** 当前任务 */
  task: Task;
  /** 权限级别 */
  permissionLevel: 'read_only' | 'limited' | 'standard' | 'elevated';
  /** 最大输出 token 数 */
  maxOutputTokens: number;
  /** 任务超时时间 (ms) */
  timeoutMs: number;
  /** 接收时间 */
  receivedAt: number;
}

// ==================== 任务结果 ====================

export interface TaskResult {
  /** 任务 ID */
  taskId: string;
  /** 最终状态 */
  status: 'completed' | 'failed';
  /** 结果内容 */
  content?: string;
  /** 生成附件 */
  outputs?: TaskOutput[];
  /** LLM 使用 token 数 */
  tokensUsed?: {
    prompt: number;
    completion: number;
  };
  /** 执行时长 (ms) */
  durationMs: number;
  /** 错误信息（失败时） */
  error?: string;
  /** 经验搜索结果（失败时，如果有匹配经验） */
  experienceHint?: import('../experience/types.js').ExperienceSearchResult;
}

export interface TaskOutput {
  /** 输出类型 */
  type: 'text' | 'image' | 'file';
  /** 内容或 URL */
  content: string;
  /** 文件名 */
  name?: string;
  /** MIME 类型 */
  mimeType?: string;
}

// ==================== 任务评估 ====================

export interface TaskEvaluation {
  /** 综合评分 (0-100) */
  score: number;
  /** 评估分项 */
  breakdown: {
    /** 能力匹配度 (0-100) */
    capability: number;
    /** 当前容量 (0-100, 越高越有空) */
    capacity: number;
    /** 风险评估 (0-100, 越高越安全) */
    risk: number;
  };
  /** 接单决策 */
  decision: 'accept' | 'reject' | 'defer';
  /** 决策原因 */
  reason?: string;
}

export interface EvaluationContext {
  /** 当前运行中任务数 */
  runningCount: number;
  /** 最大并发数 */
  maxConcurrent: number;
  /** 已支持的技能列表 */
  skills: string[];
  /** 已注册的技能名称（从 SkillRegistry 获取，用于技能感知评分） */
  registeredSkills?: string[];
  /** 已完成的同类型任务数（用于历史评估） */
  completedCountByType: Record<string, number>;
  /** 评估阈值 */
  threshold: number;
}

// ==================== 任务状态记录 ====================

export interface TaskStateRecord {
  /** 当前状态 */
  status: TaskStatus;
  /** 权限级别 */
  permissionLevel?: 'read_only' | 'limited' | 'standard' | 'elevated';
  /** 评估结果 */
  evaluation?: TaskEvaluation;
  /** 状态变更历史 */
  history: Array<{
    status: TaskStatus;
    timestamp: number;
    reason?: string;
  }>;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
}

// ==================== 任务配置扩展 ====================

export interface ConcurrencyConfig {
  /** 最大并发任务数 */
  maxConcurrent: number;
  /** 按任务类型限制并发数 */
  maxPerType: Partial<Record<TaskType, number>>;
  /** 等待队列大小 */
  queueSize: number;
  /** 优先级规则 */
  priority: {
    /** 高金额优先 */
    highValueFirst: boolean;
    /** 紧急任务优先 */
    urgentFirst: boolean;
  };
}

export interface TaskEvaluatorConfig {
  /** 接单阈值 (0-100, 大于等于此值自动接单) */
  acceptThreshold: number;
  /** 延迟阈值 (0-100, 大于等于此值放入等待队列) */
  deferThreshold: number;
  /** 评估权重 */
  weights: {
    /** 能力匹配度权重 */
    capability: number;
    /** 容量权重 */
    capacity: number;
    /** 风险权重 */
    risk: number;
  };
  /** 按任务类型的能力匹配基础分 */
  capabilityScores: Partial<Record<TaskType, number>>;
}

export interface TimeoutConfig {
  /** 单任务最大执行时间 (ms) */
  taskTimeoutMs: number;
  /** LLM 单次请求超时 (ms) */
  llmTimeoutMs: number;
  /** 队列等待超时 (ms), 超时后自动拒绝 */
  queueTimeoutMs: number;
  /** 超时后是否允许重试 */
  retryOnTimeout: boolean;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试间隔 (ms) */
  retryDelayMs: number;
}
