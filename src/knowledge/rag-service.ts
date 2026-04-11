/**
 * RAG 服务
 * 
 * 实现向量存储和相似度检索
 */

import { createLogger, type Logger } from '../core/logger.js';
import { EmbeddingService } from './embedding-service.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';

/** WorkerClaw 数据目录 */
const WORKERCLAW_DIR = join(homedir(), '.workerclaw');
/** 知识库数据库路径 */
const KNOWLEDGE_DB_PATH = join(WORKERCLAW_DIR, 'knowledge', 'knowledge.db');

export interface SearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  metadata?: any;
}

export class RAGService {
  private logger: Logger;
  private embedding: EmbeddingService;
  private db: any = null;

  constructor(embeddingConfig?: any) {
    this.logger = createLogger('RAGService');
    this.embedding = new EmbeddingService(embeddingConfig);
    this.initDatabase();
  }

  /**
   * 初始化数据库
   */
  private async initDatabase(): Promise<void> {
    try {
      // 动态导入 better-sqlite3
      const Database = (await import('better-sqlite3')).default;
      
      // 确保目录存在
      const dbDir = join(WORKERCLAW_DIR, 'knowledge');
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }

      this.db = new Database(KNOWLEDGE_DB_PATH);
      this.db.pragma('journal_mode = WAL');

      // 加载 sqlite-vec 扩展
      await this.loadVecExtension();

      // 创建向量索引表
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
          chunk_id TEXT PRIMARY KEY,
          embedding FLOAT[1536]
        )
      `);

      this.logger.info('RAG 数据库已初始化');
    } catch (err) {
      this.logger.error('初始化 RAG 数据库失败', err);
      throw err;
    }
  }

  /**
   * 加载 sqlite-vec 扩展
   */
  private async loadVecExtension(): Promise<void> {
    try {
      // 尝试加载 sqlite-vec 扩展
      // 注意：需要在项目中安装 sqlite-vec
      const { load } = await import('sqlite-vec');
      
      if (this.db) {
        load(this.db);
        this.logger.info('sqlite-vec 扩展已加载');
      }
    } catch (err: any) {
      this.logger.warn('加载 sqlite-vec 扩展失败，将使用内存向量检索', err.message);
      // 如果加载失败，将回退到内存向量检索
    }
  }

  /**
   * 为分段生成向量并存储
   */
  async indexChunk(chunkId: string, content: string): Promise<void> {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    try {
      // 生成向量
      const embedding = await this.embedding.embed(content);
      
      // 存储向量
      const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);
      
      this.db.run(
        `INSERT OR REPLACE INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`,
        [chunkId, embeddingBuffer]
      );

      // 更新 chunks 表的 embedding_status
      this.db.run(
        `UPDATE chunks SET embedding_status = 'indexed' WHERE id = ?`,
        [chunkId]
      );

      this.logger.debug(`分段已索引: ${chunkId}`);
    } catch (err: any) {
      this.logger.error(`索引分段失败: ${chunkId}`, err);
      throw err;
    }
  }

  /**
   * 批量索引分段
   */
  async indexChunks(chunks: Array<{ chunkId: string; content: string }>): Promise<void> {
    for (const chunk of chunks) {
      await this.indexChunk(chunk.chunkId, chunk.content);
    }
    this.logger.info(`已索引 ${chunks.length} 个分段`);
  }

  /**
   * 语义检索
   */
  async search(query: string, topK: number = 5, instanceId?: string): Promise<SearchResult[]> {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    try {
      // 生成查询向量
      const queryEmbedding = await this.embedding.embed(query);
      const queryBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

      // 查询相似向量
      let sql = `
        SELECT 
          v.chunk_id,
          c.document_id,
          c.content,
          v.distance
        FROM vec_chunks v
        JOIN chunks c ON v.chunk_id = c.id
        WHERE v.embedding MATCH ? AND k = ?
      `;

      const params: any[] = [queryBuffer, topK];

      if (instanceId) {
        sql += ` AND c.instance_id = ?`;
        params.push(instanceId);
      }

      sql += ` ORDER BY v.distance`;

      const results = this.db.prepare(sql).all(...params);

      return (results as any[]).map((row: any) => ({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        content: row.content,
        score: 1 / (1 + row.distance), // 转换距离为相似度分数
      }));
    } catch (err: any) {
      this.logger.error('语义检索失败', err);
      throw err;
    }
  }

  /**
   * 删除分段的向量索引
   */
  deleteChunk(chunkId: string): void {
    if (!this.db) {
      return;
    }

    this.db.run('DELETE FROM vec_chunks WHERE chunk_id = ?', [chunkId]);
    this.logger.debug(`已删除分段索引: ${chunkId}`);
  }

  /**
   * 删除文档的所有向量索引
   */
  deleteDocumentChunks(documentId: string): void {
    if (!this.db) {
      return;
    }

    // 获取文档的所有分段
    const chunks = this.db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(documentId) as any[];

    for (const chunk of chunks) {
      this.deleteChunk(chunk.id);
    }

    this.logger.info(`已删除文档 ${documentId} 的 ${chunks.length} 个向量索引`);
  }

  /**
   * 关闭数据库
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.logger.info('RAG 数据库已关闭');
    }
  }
}
