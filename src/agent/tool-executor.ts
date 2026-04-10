/**
 * 工具执行器
 * 
 * 在安全沙箱内执行工具调用
 * 每次执行前检查权限和资源限制
 */

import { createLogger, type Logger } from '../core/logger.js';
import { EventBus, WorkerClawEvent } from '../core/events.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolCall, ToolResult, ToolExecutionContext, PermissionLevel } from '../types/agent.js';
import type { SecurityConfig } from '../core/config.js';

export interface ToolExecutorConfig {
  /** 安全配置 */
  security: SecurityConfig;
}

export class ToolExecutor {
  private logger = createLogger('ToolExecutor');
  private eventBus: EventBus;
  private registry: ToolRegistry;
  private config: ToolExecutorConfig;

  constructor(registry: ToolRegistry, config: ToolExecutorConfig, eventBus: EventBus) {
    this.registry = registry;
    this.config = config;
    this.eventBus = eventBus;
  }

  /**
   * 执行工具调用
   */
  async execute(
    toolCall: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const { name, id: toolCallId, arguments: argsStr } = toolCall;

    // 1. 检查工具是否存在
    if (!this.registry.isToolAllowed(name, context.permissionLevel)) {
      this.eventBus.emit(WorkerClawEvent.TOOL_BLOCKED, {
        taskId: context.taskId,
        toolName: name,
        reason: `工具 "${name}" 在权限级别 "${context.permissionLevel}" 下不可用`,
      });
      return {
        toolCallId,
        success: false,
        content: `工具 "${name}" 在当前权限级别下不可用`,
        error: 'permission_denied',
      };
    }

    // 2. 检查工具调用次数限制
    if (context.toolCallCount >= context.maxToolCalls) {
      this.eventBus.emit(WorkerClawEvent.TOOL_BLOCKED, {
        taskId: context.taskId,
        toolName: name,
        reason: `已达到最大工具调用次数 ${context.maxToolCalls}`,
      });
      return {
        toolCallId,
        success: false,
        content: `已达到最大工具调用次数 (${context.maxToolCalls})`,
        error: 'tool_call_limit',
      };
    }

    // 3. 解析参数
    let params: any;
    try {
      params = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
    } catch (err) {
      return {
        toolCallId,
        success: false,
        content: `工具参数解析失败: ${argsStr}`,
        error: 'invalid_arguments',
      };
    }

    // 4. 获取执行器和工具定义
    const executor = this.registry.getExecutor(name);
    const tool = this.registry.getTool(name);

    this.eventBus.emit(WorkerClawEvent.TOOL_CALLED, {
      taskId: context.taskId,
      toolName: name,
      toolCallId,
    });

    // 5. 执行
    try {
      if (!executor) {
        // 无执行器：返回工具描述（说明可用但未实现）
        return {
          toolCallId,
          success: true,
          content: JSON.stringify({
            status: 'not_implemented',
            tool: name,
            description: tool?.description || '未知工具',
            hint: '该工具已注册但执行器未绑定。在 Phase 4 技能系统中将实现具体执行逻辑。',
          }),
        };
      }

      // 在超时限制内执行（工具可覆盖全局超时）
      const result = await this.executeWithTimeout(
        () => executor(params, context),
        context.remainingMs,
        tool?.maxTimeoutMs, // 工具定义中的最大超时时间
      );

      this.eventBus.emit(WorkerClawEvent.TOOL_COMPLETED, {
        taskId: context.taskId,
        toolName: name,
        toolCallId,
        success: result.success,
      });

      return result;

    } catch (err) {
      const error = err as Error;
      this.logger.error(`工具执行失败: ${name}`, { taskId: context.taskId, error: error.message });

      this.eventBus.emit(WorkerClawEvent.TOOL_COMPLETED, {
        taskId: context.taskId,
        toolName: name,
        toolCallId,
        success: false,
      });

      return {
        toolCallId,
        success: false,
        content: `工具执行异常: ${error.message}`,
        error: error.message,
      };
    }
  }

  /**
   * 带超时的执行
   * @param fn 要执行的函数
   * @param timeoutMs 任务剩余时间（毫秒）
   * @param maxTimeoutMs 工具定义的最大超时时间（可选，覆盖全局配置）
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    maxTimeoutMs?: number,
  ): Promise<T> {
    if (timeoutMs <= 0) {
      throw new Error('执行超时：无剩余时间');
    }

    // 如果工具定义了 maxTimeoutMs，使用它作为上限；否则使用全局配置
    const upperLimit = maxTimeoutMs ?? this.config.security.sandbox.commandTimeoutMs;
    const effectiveTimeout = Math.min(timeoutMs, upperLimit);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`工具执行超时 (${effectiveTimeout}ms)`));
      }, effectiveTimeout);

      fn()
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * 获取工具注册表（用于查询）
   */
  getRegistry(): ToolRegistry {
    return this.registry;
  }
}
