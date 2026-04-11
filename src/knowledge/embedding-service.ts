/**
 * Embedding 服务
 * 
 * 提供文本向量化功能，支持多种 Embedding API
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { LLMConfig } from '../core/config.js';

export interface EmbeddingOptions {
  provider?: 'openai' | 'zhipu' | 'nvidia';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export class EmbeddingService {
  private logger: Logger;
  private config: EmbeddingOptions;

  constructor(config?: EmbeddingOptions) {
    this.logger = createLogger('EmbeddingService');
    this.config = config || {};
  }

  /**
   * 生成文本向量
   */
  async embed(text: string): Promise<number[]> {
    const provider = this.config.provider || 'openai';
    
    try {
      switch (provider) {
        case 'openai':
          return await this.embedWithOpenAI(text);
        
        case 'zhipu':
          return await this.embedWithZhipu(text);
        
        case 'nvidia':
          return await this.embedWithNVIDIA(text);
        
        default:
          throw new Error(`不支持的 Embedding 提供商: ${provider}`);
      }
    } catch (err: any) {
      this.logger.error('生成向量失败', err);
      throw new Error(`Embedding 失败: ${err.message}`);
    }
  }

  /**
   * 批量生成向量
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    
    // 分批处理（每次最多 100 个文本）
    const batchSize = 100;
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchEmbeddings = await Promise.all(
        batch.map(text => this.embed(text))
      );
      embeddings.push(...batchEmbeddings);
    }

    return embeddings;
  }

  /**
   * 使用 OpenAI Embedding API
   */
  private async embedWithOpenAI(text: string): Promise<number[]> {
    const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY;
    const baseUrl = this.config.baseUrl || 'https://api.openai.com/v1';
    const model = this.config.model || 'text-embedding-3-small';

    if (!apiKey) {
      throw new Error('缺少 OpenAI API Key');
    }

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API 错误: ${error}`);
    }

    const data = await response.json() as any;
    return data.data[0].embedding;
  }

  /**
   * 使用智谱 AI Embedding API
   */
  private async embedWithZhipu(text: string): Promise<number[]> {
    const apiKey = this.config.apiKey || process.env.ZHIPU_API_KEY;
    const baseUrl = this.config.baseUrl || 'https://open.bigmodel.cn/api/paas/v4';
    const model = this.config.model || 'embedding-2';

    if (!apiKey) {
      throw new Error('缺少智谱 AI API Key');
    }

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`智谱 AI API 错误: ${error}`);
    }

    const data = await response.json() as any;
    return data.data[0].embedding;
  }

  /**
   * 使用 NVIDIA NIM Embedding API
   */
  private async embedWithNVIDIA(text: string): Promise<number[]> {
    const apiKey = this.config.apiKey || process.env.NVIDIA_API_KEY;
    const baseUrl = this.config.baseUrl || 'https://integrate.api.nvidia.com/v1';
    const model = this.config.model || 'nvidia/embed-qa-4';

    if (!apiKey) {
      throw new Error('缺少 NVIDIA API Key');
    }

    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
        input_type: 'query',
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`NVIDIA API 错误: ${error}`);
    }

    const data = await response.json() as any;
    return data.data[0].embedding;
  }

  /**
   * 计算向量相似度（余弦相似度）
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('向量维度不匹配');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
