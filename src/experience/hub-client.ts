/**
 * 虾片 Hub 客户端
 * 
 * 与智工坊服务端 /api/experience/* 交互
 */

import { createLogger, type Logger } from '../core/logger.js';
import type {
  ShrimpGene, ShrimpCapsule,
  HubPublishGeneRequest, HubSearchRequest, HubSearchResponse, HubReportRequest,
} from './types.js';

export class ShrimpHubClient {
  private logger: Logger;
  private endpoint: string;
  private botId: string;
  private token: string;

  constructor(endpoint: string, botId: string, token: string) {
    this.logger = createLogger('ShrimpHub');
    this.endpoint = endpoint.replace(/\/$/, '');
    this.botId = botId;
    this.token = token;
  }

  /**
   * 发布基因到 Hub
   */
  async publishGene(gene: ShrimpGene, capsule?: ShrimpCapsule): Promise<boolean> {
    const url = `${this.endpoint}/api/experience/genes`;

    try {
      const response = await this.request(url, 'POST', {
        gene,
        capsule,
      } as HubPublishGeneRequest);

      if (response.ok) {
        this.logger.info(`基因已发布到 Hub [${gene.gene_id.slice(0, 12)}...]`);
        return true;
      } else {
        this.logger.warn(`基因发布失败`, { httpStatus: response.status });
        return false;
      }
    } catch (err) {
      this.logger.warn(`基因发布异常`, { error: (err as Error).message });
      return false;
    }
  }

  /**
   * 按信号搜索 Hub 基因
   */
  async searchGenes(signals: string[], limit = 5): Promise<HubSearchResponse | null> {
    const url = `${this.endpoint}/api/experience/genes/search`;

    try {
      const params = new URLSearchParams({
        signals: signals.join(','),
        limit: String(limit),
      });

      const response = await fetch(`${url}?${params}`, {
        headers: this.getHeaders(),
      });

      if (response.ok) {
        const data = await response.json() as HubSearchResponse;
        this.logger.debug(`Hub 搜索返回 ${data.results.length} 条结果`);
        return data;
      } else {
        this.logger.warn(`Hub 搜索失败`, { httpStatus: response.status });
        return null;
      }
    } catch (err) {
      this.logger.warn(`Hub 搜索异常`, { error: (err as Error).message });
      return null;
    }
  }

  /**
   * 提交验证报告
   */
  async submitReport(report: HubReportRequest): Promise<boolean> {
    const url = `${this.endpoint}/api/experience/report`;

    try {
      const response = await this.request(url, 'POST', report);

      if (response.ok) {
        this.logger.debug(`验证报告已提交`);
        return true;
      } else {
        this.logger.warn(`验证报告提交失败`, { httpStatus: response.status });
        return false;
      }
    } catch (err) {
      this.logger.warn(`验证报告提交异常`, { error: (err as Error).message });
      return false;
    }
  }

  /**
   * 测试 Hub 连接
   */
  async testConnection(): Promise<boolean> {
    try {
      const url = `${this.endpoint}/api/experience/stats`;
      const response = await fetch(url, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ==================== 内部方法 ====================

  private async request(url: string, method: string, body: any): Promise<Response> {
    return fetch(url, {
      method,
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  }

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'X-Bot-Id': this.botId,
    };
  }
}
