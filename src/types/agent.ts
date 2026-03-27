/**
 * Agent 类型定义
 * 
 * 定义 LLM 相关的数据结构
 */

// ==================== LLM 消息 ====================

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// ==================== LLM 响应 ====================

export interface LLMResponse {
  /** 回复内容 */
  content: string;
  /** 是否有工具调用 */
  hasToolCalls: boolean;
  /** 工具调用列表 */
  toolCalls: ToolCall[];
  /** 使用的 token 数 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** 模型名称 */
  model: string;
  /** 停止原因 */
  finishReason: string;
  /** 所有消息记录（含工具调用链） */
  allMessages: LLMMessage[];
}

// ==================== 工具调用 ====================

export interface ToolCall {
  /** 调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 调用参数 (JSON) */
  arguments: string;
}

// ==================== 工具定义 ====================

export type PermissionLevel = 'read_only' | 'limited' | 'standard' | 'elevated';

export interface ToolDefinition {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 最低权限级别 */
  requiredLevel: PermissionLevel;
  /** JSON Schema 参数定义 */
  parameters: Record<string, any>;
  /** 工具执行器 (注册时绑定) */
  executor?: ToolExecutorFn;
}

export type ToolExecutorFn = (params: any, context: ToolExecutionContext) => Promise<ToolResult>;

export interface ToolExecutionContext {
  /** 任务 ID */
  taskId: string;
  /** 权限级别 */
  permissionLevel: PermissionLevel;
  /** 工作目录 */
  workDir: string;
  /** 任务超时剩余 (ms) */
  remainingMs: number;
  /** 已使用工具调用次数 */
  toolCallCount: number;
  /** 最大工具调用次数 */
  maxToolCalls: number;
}

// ==================== 工具结果 ====================

export interface ToolResult {
  /** 调用 ID */
  toolCallId: string;
  /** 是否成功 */
  success: boolean;
  /** 结果内容 */
  content: string;
  /** 错误信息 */
  error?: string;
}
