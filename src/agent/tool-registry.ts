/**
 * 工具注册表
 * 
 * 管理所有可用工具，按权限级别过滤
 * 
 * 内置工具:
 *   read_only:  llm_query
 *   limited:    web_search, read_file
 *   standard:   write_file, image_generate, data_analyze
 *   elevated:   run_code, system_command
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { ToolDefinition, PermissionLevel, ToolExecutorFn } from '../types/agent.js';

/** 权限级别排序（从低到高） */
const LEVEL_ORDER: PermissionLevel[] = ['read_only', 'limited', 'standard', 'elevated'];

function levelIndex(level: PermissionLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

export class ToolRegistry {
  private logger = createLogger('ToolRegistry');
  private tools = new Map<string, ToolDefinition>();

  /**
   * 注册工具
   */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`工具 "${tool.name}" 已存在，将被覆盖`);
    }
    this.tools.set(tool.name, tool);
    this.logger.debug(`注册工具: ${tool.name} (权限: ${tool.requiredLevel})`);
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 获取指定权限级别允许的工具列表
   */
  getTools(level: PermissionLevel): ToolDefinition[] {
    const threshold = levelIndex(level);
    return [...this.tools.values()].filter(
      tool => levelIndex(tool.requiredLevel) <= threshold,
    );
  }

  /**
   * 转换为 OpenAI function calling 格式
   */
  getToolsForLLM(level: PermissionLevel): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }> {
    return this.getTools(level).map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * 检查工具是否允许在指定权限级别下使用
   */
  isToolAllowed(toolName: string, level: PermissionLevel): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;
    return levelIndex(tool.requiredLevel) <= levelIndex(level);
  }

  /**
   * 获取工具的执行器
   */
  getExecutor(toolName: string): ToolExecutorFn | undefined {
    return this.tools.get(toolName)?.executor;
  }

  /**
   * 获取工具定义
   */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册的工具名
   */
  getToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * 获取统计信息
   */
  getStats(): { total: number; byLevel: Record<PermissionLevel, number> } {
    const byLevel: Record<PermissionLevel, number> = {
      read_only: 0,
      limited: 0,
      standard: 0,
      elevated: 0,
    };
    for (const tool of this.tools.values()) {
      byLevel[tool.requiredLevel]++;
    }
    return { total: this.tools.size, byLevel };
  }
}

/**
 * 创建内置工具注册表
 */
export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  const builtinTools: ToolDefinition[] = [
    // === read_only 级别 ===
    {
      name: 'llm_query',
      description: '调用 LLM 生成文本回复',
      requiredLevel: 'read_only',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '要发送给 LLM 的提示',
          },
        },
        required: ['prompt'],
      },
    },

    // === limited 级别 ===
    {
      name: 'web_search',
      description: '搜索网络信息并返回摘要',
      requiredLevel: 'limited',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词',
          },
          maxResults: {
            type: 'number',
            description: '最大返回结果数（默认 5）',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_file',
      description: '读取文件内容',
      requiredLevel: 'limited',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对于工作目录）',
          },
        },
        required: ['path'],
      },
    },

    // === standard 级别 ===
    {
      name: 'write_file',
      description: '写入文件内容',
      requiredLevel: 'standard',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对于工作目录）',
          },
          content: {
            type: 'string',
            description: '要写入的内容',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'image_generate',
      description: '使用 AI 生成图片',
      requiredLevel: 'standard',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '图片描述提示词',
          },
          size: {
            type: 'string',
            enum: ['256x256', '512x512', '1024x1024'],
            description: '图片尺寸',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'data_analyze',
      description: '分析数据并生成报告',
      requiredLevel: 'standard',
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'string',
            description: '数据内容（CSV、JSON 等）',
          },
          analysis_type: {
            type: 'string',
            enum: ['summary', 'trend', 'comparison'],
            description: '分析类型',
          },
        },
        required: ['data'],
      },
    },

    // === elevated 级别 ===
    {
      name: 'run_code',
      description: '执行代码（JavaScript/Python）',
      requiredLevel: 'elevated',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '要执行的代码',
          },
          language: {
            type: 'string',
            enum: ['javascript', 'python'],
            description: '编程语言',
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒）',
          },
        },
        required: ['code', 'language'],
      },
    },
    {
      name: 'system_command',
      description: '执行系统命令（受限沙箱）',
      requiredLevel: 'elevated',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的命令',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '命令参数',
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒）',
          },
        },
        required: ['command'],
      },
    },
  ];

  for (const tool of builtinTools) {
    registry.register(tool);
  }

  return registry;
}
