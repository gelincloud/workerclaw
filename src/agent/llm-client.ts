/**
 * LLM 客户端
 * 
 * 支持多种 LLM 提供商的统一调用客户端
 * 通过提供商适配器自动处理不同 API 格式差异
 * 支持多 API Key 轮换，避免单一 Key 的调用频率限制
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
import { LLMKeyRotator, type LLMProviderEndpoint } from './llm-rotator.js';

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
  private rotator: LLMKeyRotator | null = null;

  constructor(config: LLMConfig) {
    this.config = config;
    this.logger = createLogger('LLMClient');
    
    // 自动检测并创建对应的提供商适配器
    this.adapter = createProviderAdapter(config.baseUrl, config.model);
    
    // 初始化轮换器（如果配置了多端点）
    if (config.endpoints && config.endpoints.length > 0) {
      const endpoints: LLMProviderEndpoint[] = config.endpoints.map(ep => ({
        name: ep.name,
        apiKey: ep.apiKey,
        baseUrl: ep.baseUrl || config.baseUrl,
        model: ep.model || config.model,
        weight: ep.weight || 1,
        enabled: ep.enabled !== false,
        maxQps: ep.maxQps,
      }));
      
      this.rotator = new LLMKeyRotator(endpoints, this.logger);
      this.logger.info('LLM 客户端初始化（多端点轮换）', {
        endpointsCount: endpoints.length,
        providerType: this.adapter.type,
      });
    } else {
      this.logger.info('LLM 客户端初始化', {
        model: config.model,
        baseUrl: config.baseUrl,
        providerType: this.adapter.type,
      });
    }
  }

  /**
   * 获取当前有效的配置（可能是轮换后的）
   */
  private getCurrentConfig(): LLMConfig {
    if (!this.rotator) {
      return this.config;
    }
    
    const endpoint = this.rotator.getNextEndpoint();
    
    // 返回合并后的配置
    return {
      ...this.config,
      apiKey: endpoint.apiKey,
      baseUrl: endpoint.baseUrl || this.config.baseUrl,
      model: endpoint.model || this.config.model,
    };
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

    // 获取当前配置（可能已轮换）
    const currentConfig = this.getCurrentConfig();
    const currentApiKey = currentConfig.apiKey;

    // 构建请求体（由适配器处理格式差异）
    const body = this.adapter.buildRequestBody(
      messages,
      tools,
      currentConfig,
      maxTokens,
      temperature
    );

    // 调试日志
    this.logger.debug('LLM 请求', {
      provider: this.adapter.type,
      model: currentConfig.model,
      messageCount: messages.length,
      toolCount: tools?.length || 0,
      hasTools: !!(body.tools || body.functionDeclarations),
      isRotated: this.rotator !== null,
    });

    // 带重试的请求
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.config.retry.maxRetries; attempt++) {
      try {
        const result = await this.adapter.sendRequest(body, currentConfig, this.logger);
        
        // 记录成功
        if (this.rotator) {
          this.rotator.recordSuccess(currentApiKey);
        }

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
        
        // 记录失败
        if (this.rotator) {
          this.rotator.recordFailure(currentApiKey, lastError.message);
        }
        
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

  /**
   * 获取轮换统计信息（如果有轮换器）
   */
  getRotationStats() {
    return this.rotator?.getStats() || null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 重新导出类型以保持兼容性
export type { ToolDef } from './llm-provider.js';
