/**
 * LLM 客户端
 * 
 * 支持 OpenAI 兼容 API 的 LLM 调用客户端
 * 支持：DeepSeek、OpenAI、GLM 等兼容 API
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { LLMConfig } from '../core/config.js';
import type { LLMMessage, LLMResponse, ToolCall, ToolDefinition } from '../types/agent.js';

export interface ChatRequest {
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export class LLMClient {
  private logger: Logger;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.logger = createLogger('LLMClient');
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

    // 构建请求体
    const body: any = {
      model: this.config.model,
      messages: messages.map(m => this.formatMessage(m)),
      max_tokens: maxTokens,
      temperature,
      top_p: this.config.safety.topP,
    };

    // 工具定义（过滤掉没有 name 的工具）
    if (tools && tools.length > 0) {
      const validTools = tools.filter(t => t.name && t.name.trim());
      if (validTools.length > 0) {
        body.tools = validTools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
      }
    }

    this.logger.debug('LLM 请求', {
      model: this.config.model,
      messageCount: messages.length,
      toolCount: tools?.length || 0,
    });

    // 带重试的请求
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.config.retry.maxRetries; attempt++) {
      try {
        const result = await this.doRequest(body);

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
   * 发送 HTTP 请求
   */
  private async doRequest(body: any): Promise<{
    content: string;
    toolCalls: ToolCall[];
    usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    model: string;
    finishReason: string;
  }> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), // 2 分钟超时
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API 错误 (${response.status}): ${errorText.slice(0, 500)}`);
    }

    const data = await response.json() as any;

    // 解析响应
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('LLM API 返回格式异常：缺少 choices');
    }

    const message = choice.message || {};

    // 解析工具调用
    const toolCalls: ToolCall[] = (message.tool_calls || []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name || tc.name,
      arguments: tc.function?.arguments || tc.arguments || '{}',
    }));

    return {
      content: message.content || '',
      toolCalls,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
      model: data.model || this.config.model,
      finishReason: choice.finish_reason || 'stop',
    };
  }

  /**
   * 格式化消息
   */
  private formatMessage(msg: LLMMessage): any {
    const formatted: any = {
      role: msg.role,
      content: msg.content,
    };

    if (msg.name) {
      formatted.name = msg.name;
    }

    if (msg.tool_calls) {
      formatted.tool_calls = msg.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
    }

    if (msg.tool_call_id) {
      formatted.tool_call_id = msg.tool_call_id;
    }

    return formatted;
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
