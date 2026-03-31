/**
 * LLM 提供商适配器
 * 
 * 支持多种 LLM 提供商的工具调用格式：
 * 
 * ## OpenAI 兼容格式（已支持）
 * - **OpenAI**: GPT-4, GPT-4o, GPT-3.5-turbo
 * - **DeepSeek**: DeepSeek-V3, DeepSeek-R1
 * - **智谱 GLM**: GLM-4, GLM-5, GLM-4.7-Flash
 * - **通义千问 Qwen**: Qwen-Plus, Qwen-Turbo, Qwen-Max
 * - **Kimi/Moonshot**: Kimi-K2.5, Moonshot-V1
 * - **NVIDIA NIM**: 各种模型
 * - **豆包 Doubao**: Doubao-Pro, Doubao-Lite
 * - **百川 Baichuan**: Baichuan2-Turbo, Baichuan4
 * - **MiniMax**: MiniMax-M1, MiniMax-M2（支持 OpenAI 兼容模式）
 * - **xAI Grok**: Grok-2, Grok-3
 * - **SiliconFlow**: 各种开源模型
 * - **零一万物 Yi**: Yi-Large, Yi-Medium
 * - **书生浦语 InternLM**: InternLM2
 * 
 * ## Anthropic 格式（已支持）
 * - **Claude**: Claude-3.5-Sonnet, Claude-3-Opus, Claude-3-Haiku
 * 
 * ## Google 格式（已支持）
 * - **Gemini**: Gemini-2.0-Flash, Gemini-1.5-Pro, Gemini-1.5-Flash
 * 
 * ## 待支持（需要特殊处理）
 * - **讯飞星火 Spark**: 使用 WebSocket + 原生格式，需要独立适配器
 */

import type { Logger } from '../core/logger.js';
import type { LLMConfig } from '../core/config.js';
import type { LLMMessage, ToolCall, ToolDefinition } from '../types/agent.js';

// ============================================================================
// 类型定义
// ============================================================================

/** OpenAI 格式的工具定义 */
export interface OpenAIToolFormat {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/** Claude 格式的工具定义 */
export interface ClaudeToolFormat {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/** Gemini 格式的工具定义 */
export interface GeminiToolFormat {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/** 工具定义（兼容多种格式） */
export type ToolDef = ToolDefinition | OpenAIToolFormat;

/** LLM 响应的统一格式 */
export interface UnifiedLLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  finishReason: string;
}

/** 工具调用请求 */
export interface ToolCallRequest {
  messages: LLMMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
}

/** LLM 提供商类型 */
export type LLMProviderType = 'openai-compatible' | 'claude' | 'gemini';

// ============================================================================
// 提供商检测
// ============================================================================

/**
 * 根据 baseUrl 或 model 名称检测提供商类型
 */
export function detectProviderType(baseUrl: string, model: string): LLMProviderType {
  const url = baseUrl.toLowerCase();
  const modelLower = model.toLowerCase();
  
  // Claude / Anthropic
  if (
    url.includes('anthropic.com') ||
    url.includes('claude.ai') ||
    modelLower.startsWith('claude') ||
    modelLower.includes('claude')
  ) {
    return 'claude';
  }
  
  // Gemini / Google
  if (
    url.includes('generativelanguage.googleapis.com') ||
    url.includes('gemini.googleapis.com') ||
    url.includes('aiplatform.googleapis.com') ||
    modelLower.startsWith('gemini')
  ) {
    return 'gemini';
  }
  
  // OpenAI 兼容格式的提供商（自动检测）
  // 以下提供商都使用 OpenAI 兼容的 tools/tool_choice 格式：
  
  // OpenAI 官方
  if (url.includes('api.openai.com') || modelLower.includes('gpt')) {
    return 'openai-compatible';
  }
  
  // DeepSeek
  if (url.includes('api.deepseek.com') || modelLower.includes('deepseek')) {
    return 'openai-compatible';
  }
  
  // 智谱 GLM
  if (url.includes('bigmodel.cn') || url.includes('open.bigmodel.cn') || 
      modelLower.includes('glm-') || modelLower.startsWith('glm')) {
    return 'openai-compatible';
  }
  
  // 通义千问 Qwen (阿里云百炼)
  if (url.includes('dashscope.aliyuncs.com') || 
      url.includes('bailian.aliyun.com') ||
      modelLower.includes('qwen')) {
    return 'openai-compatible';
  }
  
  // Kimi / Moonshot
  if (url.includes('api.moonshot.cn') || url.includes('moonshot') ||
      modelLower.includes('kimi') || modelLower.includes('moonshot')) {
    return 'openai-compatible';
  }
  
  // NVIDIA NIM
  if (url.includes('integrate.api.nvidia.com') || url.includes('build.nvidia.com') ||
      modelLower.includes('nim/')) {
    return 'openai-compatible';
  }
  
  // 豆包 Doubao (火山引擎)
  if (url.includes('ark.cn-beijing.volces.com') || 
      url.includes('volcengine.com') ||
      modelLower.includes('doubao') || modelLower.includes('ep-')) {
    return 'openai-compatible';
  }
  
  // 百川 Baichuan
  if (url.includes('api.baichuan-ai.com') || url.includes('baichuan') ||
      modelLower.includes('baichuan')) {
    return 'openai-compatible';
  }
  
  // MiniMax
  if (url.includes('api.minimax.chat') || url.includes('minimaxi.com') ||
      modelLower.includes('minimax') || modelLower.includes('abab')) {
    return 'openai-compatible';
  }
  
  // xAI Grok
  if (url.includes('api.x.ai') || url.includes('x.ai') ||
      modelLower.includes('grok')) {
    return 'openai-compatible';
  }
  
  // SiliconFlow
  if (url.includes('api.siliconflow.cn') || url.includes('siliconflow')) {
    return 'openai-compatible';
  }
  
  // 零一万物 Yi
  if (url.includes('api.lingyiwanwu.com') || modelLower.includes('yi-')) {
    return 'openai-compatible';
  }
  
  // 书生浦语 InternLM
  if (url.includes('internlm') || modelLower.includes('internlm')) {
    return 'openai-compatible';
  }
  
  // 讯飞星火（注意：星火使用 WebSocket + 原生格式，这里暂时标记为 openai-compatible
  // 如果用户通过 OpenAI 兼容的代理服务（如阿里云百炼）调用，则可以工作
  if (url.includes('xfyun.cn') || url.includes('spark') || modelLower.includes('spark')) {
    // 星火原生 API 使用 WebSocket，不支持 HTTP OpenAI 格式
    // 但阿里云百炼提供的星火服务支持 OpenAI 兼容
    return 'openai-compatible';
  }
  
  // 默认为 OpenAI 兼容格式（大多数新模型都兼容）
  return 'openai-compatible';
}

// ============================================================================
// 基础适配器接口
// ============================================================================

export interface LLMProviderAdapter {
  /** 提供商类型 */
  readonly type: LLMProviderType;
  
  /** 格式化工具定义 */
  formatTools(tools: ToolDef[]): any;
  
  /** 构建请求体 */
  buildRequestBody(
    messages: LLMMessage[],
    tools: ToolDef[] | undefined,
    config: LLMConfig,
    maxTokens: number,
    temperature: number
  ): any;
  
  /** 发送请求 */
  sendRequest(
    body: any,
    config: LLMConfig,
    logger: Logger
  ): Promise<UnifiedLLMResponse>;
  
  /** 格式化消息 */
  formatMessage(msg: LLMMessage): any;
}

// ============================================================================
// OpenAI 兼容适配器
// ============================================================================

export class OpenAICompatibleAdapter implements LLMProviderAdapter {
  readonly type: LLMProviderType = 'openai-compatible';
  
  formatTools(tools: ToolDef[]): OpenAIToolFormat[] {
    return tools
      .filter(t => {
        const name = (t as any).name || (t as any).function?.name;
        return name && name.trim();
      })
      .map(t => {
        const func = (t as any).function || t;
        return {
          type: 'function' as const,
          function: {
            name: func.name,
            description: func.description,
            parameters: func.parameters,
          },
        };
      });
  }
  
  buildRequestBody(
    messages: LLMMessage[],
    tools: ToolDef[] | undefined,
    config: LLMConfig,
    maxTokens: number,
    temperature: number
  ): any {
    const body: any = {
      model: config.model,
      messages: messages.map(m => this.formatMessage(m)),
      max_tokens: maxTokens,
      temperature,
      top_p: config.safety.topP,
    };
    
    if (tools && tools.length > 0) {
      const formattedTools = this.formatTools(tools);
      if (formattedTools.length > 0) {
        body.tools = formattedTools;
        // 关键：显式设置 tool_choice
        // NVIDIA NIM 默认值是 "none"，必须显式设置为 "auto"
        // 智谱 AI GLM 也需要显式设置
        body.tool_choice = 'auto';
      }
    }
    
    return body;
  }
  
  async sendRequest(
    body: any,
    config: LLMConfig,
    logger: Logger
  ): Promise<UnifiedLLMResponse> {
    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    
    // 使用配置中的超时时间，默认 180 秒
    const timeoutMs = config.timeout?.llmTimeoutMs || 180_000;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API 错误 (${response.status}): ${errorText.slice(0, 500)}`);
    }
    
    const data = await response.json() as any;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('LLM API 返回格式异常：缺少 choices');
    }
    
    const message = choice.message || {};
    const rawToolCalls = message.tool_calls || [];
    const toolCalls: ToolCall[] = rawToolCalls.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name || tc.name,
      arguments: tc.function?.arguments || tc.arguments || '{}',
    }));
    
    logger.debug('OpenAI 兼容响应解析', {
      hasToolCallsField: 'tool_calls' in message,
      rawToolCallsCount: rawToolCalls.length,
      parsedToolCallsCount: toolCalls.length,
      finishReason: choice.finish_reason,
    });
    
    return {
      content: message.content || '',
      toolCalls,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
      model: data.model || config.model,
      finishReason: choice.finish_reason || 'stop',
    };
  }
  
  formatMessage(msg: LLMMessage): any {
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
}

// ============================================================================
// Claude 适配器
// ============================================================================

export class ClaudeAdapter implements LLMProviderAdapter {
  readonly type: LLMProviderType = 'claude';
  
  formatTools(tools: ToolDef[]): ClaudeToolFormat[] {
    return tools
      .filter(t => {
        const name = (t as any).name || (t as any).function?.name;
        return name && name.trim();
      })
      .map(t => {
        const func = (t as any).function || t;
        return {
          name: func.name,
          description: func.description,
          input_schema: {
            type: 'object' as const,
            properties: func.parameters?.properties || func.parameters || {},
            required: func.parameters?.required || [],
          },
        };
      });
  }
  
  buildRequestBody(
    messages: LLMMessage[],
    tools: ToolDef[] | undefined,
    config: LLMConfig,
    maxTokens: number,
    temperature: number
  ): any {
    // Claude API 需要分离 system 消息
    let systemPrompt = '';
    const conversationMessages: any[] = [];
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
      } else {
        conversationMessages.push(this.formatMessage(msg));
      }
    }
    
    const body: any = {
      model: config.model,
      messages: conversationMessages,
      max_tokens: maxTokens,
      temperature,
      top_p: config.safety.topP,
    };
    
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    
    if (tools && tools.length > 0) {
      const formattedTools = this.formatTools(tools);
      if (formattedTools.length > 0) {
        body.tools = formattedTools;
      }
    }
    
    return body;
  }
  
  async sendRequest(
    body: any,
    config: LLMConfig,
    logger: Logger
  ): Promise<UnifiedLLMResponse> {
    // Claude API 端点
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages`;
    
    // 使用配置中的超时时间，默认 180 秒
    const timeoutMs = config.timeout?.llmTimeoutMs || 180_000;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API 错误 (${response.status}): ${errorText.slice(0, 500)}`);
    }
    
    const data = await response.json() as any;
    
    // 解析 Claude 响应格式
    // content 是一个数组，包含 text 和 tool_use 类型的内容块
    const content = data.content || [];
    let textContent = '';
    const toolCalls: ToolCall[] = [];
    
    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text || '';
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        });
      }
    }
    
    logger.debug('Claude 响应解析', {
      contentBlockCount: content.length,
      toolCallsCount: toolCalls.length,
      stopReason: data.stop_reason,
    });
    
    return {
      content: textContent,
      toolCalls,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      } : undefined,
      model: data.model || config.model,
      finishReason: data.stop_reason || 'end_turn',
    };
  }
  
  formatMessage(msg: LLMMessage): any {
    // Claude 消息格式
    const content: any[] = [];
    
    if (msg.content) {
      content.push({
        type: 'text',
        text: msg.content,
      });
    }
    
    // 工具调用结果
    if (msg.role === 'tool' && msg.tool_call_id) {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content,
        }],
      };
    }
    
    // 工具调用请求
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments || '{}'),
        });
      }
    }
    
    return {
      role: msg.role,
      content,
    };
  }
}

// ============================================================================
// Gemini 适配器
// ============================================================================

export class GeminiAdapter implements LLMProviderAdapter {
  readonly type: LLMProviderType = 'gemini';
  
  formatTools(tools: ToolDef[]): any {
    const functionDeclarations = tools
      .filter(t => {
        const name = (t as any).name || (t as any).function?.name;
        return name && name.trim();
      })
      .map(t => {
        const func = (t as any).function || t;
        return {
          name: func.name,
          description: func.description,
          parameters: func.parameters || {
            type: 'object',
            properties: {},
          },
        };
      });
    
    return functionDeclarations.length > 0 ? [{
      functionDeclarations,
    }] : [];
  }
  
  buildRequestBody(
    messages: LLMMessage[],
    tools: ToolDef[] | undefined,
    config: LLMConfig,
    maxTokens: number,
    temperature: number
  ): any {
    // Gemini 消息格式转换
    const contents: any[] = [];
    let systemInstruction = '';
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction += (systemInstruction ? '\n\n' : '') + msg.content;
      } else {
        contents.push(this.formatMessage(msg));
      }
    }
    
    const body: any = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
        topP: config.safety.topP,
      },
    };
    
    if (systemInstruction) {
      body.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }
    
    if (tools && tools.length > 0) {
      const formattedTools = this.formatTools(tools);
      if (formattedTools.length > 0) {
        body.tools = formattedTools;
      }
    }
    
    return body;
  }
  
  async sendRequest(
    body: any,
    config: LLMConfig,
    logger: Logger
  ): Promise<UnifiedLLMResponse> {
    // Gemini API 端点
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
    
    // 使用配置中的超时时间，默认 180 秒
    const timeoutMs = config.timeout?.llmTimeoutMs || 180_000;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API 错误 (${response.status}): ${errorText.slice(0, 500)}`);
    }
    
    const data = await response.json() as any;
    
    // 解析 Gemini 响应格式
    const candidates = data.candidates || [];
    const firstCandidate = candidates[0] || {};
    const content = firstCandidate.content || {};
    const parts = content.parts || [];
    
    let textContent = '';
    const toolCalls: ToolCall[] = [];
    
    for (const part of parts) {
      if (part.text) {
        textContent += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        });
      }
    }
    
    logger.debug('Gemini 响应解析', {
      partsCount: parts.length,
      toolCallsCount: toolCalls.length,
      finishReason: firstCandidate.finishReason,
    });
    
    return {
      content: textContent,
      toolCalls,
      usage: data.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount,
      } : undefined,
      model: config.model,
      finishReason: firstCandidate.finishReason || 'STOP',
    };
  }
  
  formatMessage(msg: LLMMessage): any {
    const parts: any[] = [];
    
    if (msg.content) {
      parts.push({ text: msg.content });
    }
    
    // 工具调用请求
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        parts.push({
          functionCall: {
            name: tc.name,
            args: JSON.parse(tc.arguments || '{}'),
          },
        });
      }
    }
    
    // 工具调用结果
    if (msg.role === 'tool' && msg.tool_call_id) {
      return {
        role: 'function',
        parts: [{
          functionResponse: {
            name: msg.name || 'unknown',
            response: {
              result: msg.content,
            },
          },
        }],
      };
    }
    
    return {
      role: msg.role === 'assistant' ? 'model' : msg.role,
      parts,
    };
  }
}

// ============================================================================
// 适配器工厂
// ============================================================================

export function createProviderAdapter(
  baseUrl: string,
  model: string
): LLMProviderAdapter {
  const providerType = detectProviderType(baseUrl, model);
  
  switch (providerType) {
    case 'claude':
      return new ClaudeAdapter();
    case 'gemini':
      return new GeminiAdapter();
    case 'openai-compatible':
    default:
      return new OpenAICompatibleAdapter();
  }
}
