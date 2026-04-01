/**
 * WorkerClaw CLI - 大模型配置 section
 * 
 * 交互式配置 LLM 提供商、模型和 API Key
 * 支持多 Provider 端点轮换
 */

import { select, password, num, text, confirm } from '../prompter.js';
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
  nvidia: {
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'z-ai/glm5',
    models: ['z-ai/glm5', 'meta/llama-3.1-8b-instruct', 'meta/llama-3.1-70b-instruct', 'mistralai/mistral-large'],
    hint: 'NVIDIA NIM API（含免费 GLM5）',
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

/** 单个端点配置 */
interface EndpointConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  weight: number;
}

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

  // ========== 多端点配置 ==========
  const endpoints: EndpointConfig[] = [];
  
  // 询问是否配置多个端点（用于 API Key 轮换或多 Provider 混用）
  const hasMultipleEndpoints = existing?.endpoints && existing.endpoints.length > 0;
  const wantMultiple = await confirm(
    '是否配置多个 LLM 端点？（用于 API Key 轮换或多 Provider 混用）',
    hasMultipleEndpoints,
  );
  
  if (wantMultiple) {
    // 添加主端点
    endpoints.push({
      name: `${provider.name} 主端点`,
      apiKey,
      baseUrl,
      model,
      weight: 1,
    });
    
    // 循环添加更多端点
    let addMore = true;
    let endpointIndex = 1;
    
    while (addMore) {
      console.log(`\n── 配置第 ${endpointIndex + 1} 个端点 ──`);
      
      // 选择这个端点的提供商
      const epProviderKey = await select(
        '选择端点提供商',
        Object.entries(LLM_PROVIDERS)
          .filter(([key]) => !isLocal || key === 'ollama') // 本地模型只能用 ollama
          .map(([key, p]) => ({
            value: key,
            label: p.name,
            hint: p.hint,
          })),
        providerKey, // 默认选择相同的 provider
      );
      
      if (!epProviderKey) break;
      
      const epProvider = LLM_PROVIDERS[epProviderKey];
      let epBaseUrl = epProvider.baseUrl;
      let epModel = epProvider.defaultModel;
      
      // 自定义 baseUrl
      const customEpUrl = await text(`API Base URL (${epProvider.name})`, undefined, epProvider.baseUrl);
      if (customEpUrl === null) break;
      if (customEpUrl) epBaseUrl = customEpUrl.replace(/\/$/, '');
      
      // 选择模型
      if (epProvider.models.length > 0 && epProviderKey !== 'custom') {
        const selectedEpModel = await select(
          '选择模型',
          [
            { value: epModel, label: `${epModel} (默认)` },
            ...epProvider.models.filter(m => m !== epModel).map(m => ({ value: m, label: m })),
            { value: '__custom__', label: '自定义...' },
          ],
          epModel,
        );
        
        if (!selectedEpModel) break;
        if (selectedEpModel === '__custom__') {
          const customEpModel = await text('输入模型名称');
          if (!customEpModel) break;
          epModel = customEpModel;
        } else {
          epModel = selectedEpModel;
        }
      }
      
      // API Key
      let epApiKey = '';
      if (epProviderKey !== 'ollama') {
        const inputKey = await password(`API Key (${epProvider.name})`);
        if (inputKey === null) break;
        epApiKey = inputKey;
      }
      
      // 权重
      const epWeight = await num('权重（用于轮换概率）', 1, 1, 10);
      if (epWeight === null) break;
      
      // 添加端点
      endpoints.push({
        name: `${epProvider.name} 端点 ${endpointIndex}`,
        apiKey: epApiKey,
        baseUrl: epBaseUrl,
        model: epModel,
        weight: epWeight || 1,
      });
      
      endpointIndex++;
      
      // 询问是否继续添加
      addMore = await confirm('继续添加更多端点？', false);
      
      // 最多支持 10 个端点
      if (endpoints.length >= 10) {
        console.log('已达到最大端点数量（10个）');
        break;
      }
    }
  }

  const result: LLMSectionResult = {
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
  
  // 如果配置了多端点，添加到结果
  if (endpoints.length > 1) {
    result.llm.endpoints = endpoints.map(ep => ({
      name: ep.name,
      apiKey: ep.apiKey,
      baseUrl: ep.baseUrl,
      model: ep.model,
      weight: ep.weight,
      enabled: true,
    }));
  }
  
  return result;
}
