/**
 * LLM 客户端
 * 
 * 支持多种 LLM 提供商的统一调用客户端
 * 通过提供商适配器自动处理不同 API 格式差异
 * 
 * 支持的提供商：
 * - OpenAI 兼容（OpenAI、DeepSeek、GLM、NVIDIA NIM、通义千问、Moonshot 等）
 * - Anthropic Claude
 * - Google Gemini
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { LLMConfig } from '../core/config.js';
import type { LLMMessage, LLMResponse, ToolCall, ToolDefinition } from '../types/agent.js';
import {
  createProviderAdapter,
  type LLMProviderAdapter,
  type ToolDef,
} from './llm-provider.js';

export interface ChatRequest {
  messages: LLMMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
}

export class LLMClient {
  private logger: Logger;
  private config: LLMConfig;
  private adapter: LLMProviderAdapter;

  constructor(config: LLMConfig) {
    this.config = config;
    this.logger = createLogger('LLMClient');
    // 自动检测并创建对应的提供商适配器
    this.adapter = createProviderAdapter(config.baseUrl, config.model);
    
    this.logger.info('LLM 客户端初始化', {
      model: config.model,
      baseUrl: config.baseUrl,
      providerType: this.adapter.type,
    });
  }

  /**
   * 发送聊天请求
   */
  async chat(request: ChatRequest): Promise<LLMResponse> {
    const {
      messages,
      tools,
      maxTokens = this.config.safety.maxTokens,
      temperature = this.config.safety.temperature,
    } = request;

    // 构建请求体（由适配器处理格式差异）
    const body = this.adapter.buildRequestBody(
      messages,
      tools,
      this.config,
      maxTokens,
      temperature
    );

    // 调试日志
    this.logger.debug('LLM 请求', {
      provider: this.adapter.type,
      model: this.config.model,
      messageCount: messages.length,
      toolCount: tools?.length || 0,
      hasTools: !!(body.tools || body.functionDeclarations),
    });

    // 带重试的请求
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.config.retry.maxRetries; attempt++) {
      try {
        const result = await this.adapter.sendRequest(body, this.config, this.logger);

        return {
          content: result.content || '',
          hasToolCalls: result.toolCalls.length > 0,
          toolCalls: result.toolCalls,
          usage: result.usage,
          model: result.model,
          finishReason: result.finishReason,
          allMessages: messages,
        };
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(`LLM 请求失败 (attempt ${attempt}/${this.config.retry.maxRetries})`, lastError.message);

        if (attempt < this.config.retry.maxRetries) {
          const delay = this.config.retry.backoffMs * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    throw new Error(`LLM 请求失败（已重试 ${this.config.retry.maxRetries} 次）: ${lastError?.message}`);
  }

  /**
   * 简单文本聊天（无工具调用）
   */
  async simpleChat(systemPrompt: string, userMessage: string): Promise<string> {
    const response = await this.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });
    return response.content;
  }

  /**
   * 获取当前提供商类型
   */
  getProviderType(): string {
    return this.adapter.type;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 重新导出类型以保持兼容性
export type { ToolDef } from './llm-provider.js';
