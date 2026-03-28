/**
 * WorkerClaw CLI - 大模型配置 section
 * 
 * 交互式配置 LLM 提供商、模型和 API Key
 */

import { select, password, num, text } from '../prompter.js';
import type { LLMConfig } from '../../core/config.js';

export interface LLMSectionResult {
  llm: Partial<LLMConfig>;
}

/** LLM 提供商预设 */
const LLM_PROVIDERS: Record<string, {
  name: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  hint: string;
}> = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    hint: 'GPT-4o / GPT-4 系列模型',
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hint: 'DeepSeek V3 / R1 系列',
  },
  qwen: {
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
    hint: '阿里云通义千问系列',
  },
  kimi: {
    name: 'Kimi (月之暗面)',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    hint: 'Moonshot Kimi 系列',
  },
  zhipu: {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4',
    models: ['glm-4-flash', 'glm-4', 'glm-4-plus'],
    hint: '智谱 GLM-4 系列',
  },
  ollama: {
    name: 'Ollama (本地)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5:7b',
    models: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3:8b', 'mistral:7b'],
    hint: '本地模型，无需 API Key',
  },
  custom: {
    name: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    defaultModel: '',
    models: [],
    hint: '兼容 OpenAI API 格式的自定义服务',
  },
};

/**
 * 大模型配置
 */
export async function configureLLM(existing?: Partial<LLMConfig>): Promise<LLMSectionResult | null> {
  // 选择提供商
  const providerKey = await select(
    '选择大模型提供商',
    Object.entries(LLM_PROVIDERS).map(([key, p]) => ({
      value: key,
      label: p.name,
      hint: p.hint,
    })),
    existing?.provider && LLM_PROVIDERS[existing.provider] ? existing.provider : undefined,
  );

  if (!providerKey) return null;

  const provider = LLM_PROVIDERS[providerKey];
  const isLocal = providerKey === 'ollama';

  let baseUrl = provider.baseUrl;
  let model = provider.defaultModel;

  // 自定义提供商需要输入 baseUrl
  if (providerKey === 'custom') {
    const customUrl = await select(
      '选择 API 格式',
      [
        { value: 'openai', label: 'OpenAI 兼容格式', hint: '/v1/chat/completions' },
      ],
    );
    if (!customUrl) return null;

    const customBaseUrl = await text('API Base URL');
    if (customBaseUrl === null) return null;
    baseUrl = customBaseUrl.replace(/\/$/, '');

    const customModel = await text('模型名称');
    if (!customModel) return null;
    model = customModel;
  } else {
    // 允许修改 baseUrl（回显已有值）
    const customUrl = await text(`API Base URL (${provider.name})`, undefined, existing?.baseUrl || provider.baseUrl);
    if (customUrl === null) return null;
    if (customUrl) baseUrl = customUrl.replace(/\/$/, '');
  }

  // 选择模型
  if (provider.models.length > 0 && providerKey !== 'custom') {
    const selectedModel = await select(
      '选择模型',
      [
        { value: model, label: `${model} (默认)`, hint: '推荐' },
        ...provider.models
          .filter(m => m !== model)
          .map(m => ({ value: m, label: m })),
        { value: '__custom__', label: '自定义模型名...' },
      ],
      model,
    );

    if (!selectedModel) return null;
    if (selectedModel === '__custom__') {
      const customModel = await text('输入模型名称', undefined, existing?.model);
      if (!customModel) return null;
      model = customModel;
    } else {
      model = selectedModel;
    }
  }

  // API Key（Ollama 本地模型不需要）
  let apiKey = '';
  if (!isLocal) {
    apiKey = existing?.apiKey || '';
    const keyHint = apiKey ? 'API Key（直接回车保持不变）' : 'API Key';
    const inputKey = await password(keyHint);
    if (inputKey === null) return null;
    if (inputKey) apiKey = inputKey;
  }

  // 高级参数（使用默认值）
  const maxTokens = await num('最大输出 Token 数', 4096, 256, 32768);
  if (maxTokens === null) return null;

  const temperature = await num('Temperature (创造性，0-2)', 0.7, 0, 2);
  if (temperature === null) return null;

  return {
    llm: {
      provider: providerKey,
      model,
      apiKey,
      baseUrl,
      safety: {
        maxTokens: maxTokens || 4096,
        temperature: temperature ?? 0.7,
        topP: 0.9,
      },
      retry: {
        maxRetries: 3,
        backoffMs: 2000,
      },
    },
  };
}
