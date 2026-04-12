/**
 * 知识库管理器
 * 
 * 整合文档处理、向量化和 RAG 检索功能
 */

import { createLogger, type Logger } from '../core/logger.js';
import { DocumentProcessor, type DocumentChunk } from './document-processor.js';
import { RAGService } from './rag-service.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';

/** WorkerClaw 数据目录 */
const WORKERCLAW_DIR = join(homedir(), '.workerclaw');
/** 知识库数据库路径 */
const KNOWLEDGE_DB_PATH = join(WORKERCLAW_DIR, 'knowledge', 'knowledge.db');

export interface KnowledgeDocument {
  id: string;
  instanceId: string;
  filename: string;
  fileType: string;
  fileSize: number;
  storageType: string;
  storageKey: string;
  storageUrl: string;
  status: string;
}

export class KnowledgeManager {
  private logger: Logger;
  private processor: DocumentProcessor;
  private ragService: RAGService;
  private db: any = null;
  private initPromise: Promise<void>;

  constructor(embeddingConfig?: any) {
    this.logger = createLogger('KnowledgeManager');
    this.processor = new DocumentProcessor();
    this.ragService = new RAGService(embeddingConfig);
    this.initPromise = this.initDatabase();
  }

  /**
   * 等待初始化完成
   */
  async ready(): Promise<void> {
    await this.initPromise;
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

      // 创建表
      this.db.exec(`
        -- 文档表
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          file_type TEXT NOT NULL,
          file_size INTEGER DEFAULT 0,
          storage_type TEXT DEFAULT 'local',
          storage_key TEXT,
          storage_url TEXT,
          status TEXT DEFAULT 'uploaded',
          chunk_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 分段表
        CREATE TABLE IF NOT EXISTS chunks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          content TEXT NOT NULL,
          chunk_index INTEGER DEFAULT 0,
          token_count INTEGER DEFAULT 0,
          embedding_status TEXT DEFAULT 'pending',
          embedding BLOB,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (document_id) REFERENCES documents(id)
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_instance ON chunks(instance_id);
      `);

      this.logger.info('知识库数据库已初始化');
    } catch (err) {
      this.logger.error('初始化数据库失败', err);
      throw err;
    }
  }

  /**
   * 处理上传的文档
   */
  async processUploadedDocument(
    docId: string,
    filename: string,
    fileUrl: string,
    fileType: string,
    fileSize: number,
    instanceId: string
  ): Promise<{ success: boolean; error?: string }> {
    // 等待初始化完成
    await this.initPromise;

    try {
      this.logger.info(`开始处理文档: ${filename} (${docId})`);

      // 更新状态为处理中
      this.updateDocumentStatus(docId, 'processing');

      // 处理文档：下载 -> 解析 -> 分段
      const result = await this.processor.processDocument(fileUrl, docId, filename, fileType);

      if (!result.success) {
        this.updateDocumentStatus(docId, 'failed');
        return { success: false, error: result.error };
      }

      // 保存分段到数据库
      this.saveChunks(result.chunks, instanceId);

      // 更新文档状态和分段数量
      this.db?.run(
        `UPDATE documents SET status = 'processed', chunk_count = ?, updated_at = datetime('now') WHERE id = ?`,
        [result.chunks.length, docId]
      );

      // 异步索引分段（不阻塞主流程）
      this.indexChunksAsync(result.chunks).catch(err => {
        this.logger.error('索引分段失败', err);
      });

      this.logger.info(`文档处理完成: ${filename}, ${result.chunks.length} 个分段`);

      return { success: true };
    } catch (err: any) {
      this.logger.error('处理文档失败', err);
      this.updateDocumentStatus(docId, 'failed');
      return { success: false, error: err.message };
    }
  }

  /**
   * 异步索引分段
   */
  private async indexChunksAsync(chunks: DocumentChunk[]): Promise<void> {
    try {
      const chunkList = chunks.map(chunk => ({
        chunkId: chunk.id,
        content: chunk.content,
      }));

      await this.ragService.indexChunks(chunkList);
      this.logger.info(`已索引 ${chunks.length} 个分段`);
    } catch (err: any) {
      this.logger.error('批量索引分段失败', err);
      throw err;
    }
  }

  /**
   * 保存分段到数据库
   */
  private saveChunks(chunks: DocumentChunk[], instanceId: string): void {
    if (!this.db) {
      throw new Error('数据库未初始化');
    }

    const insert = this.db.prepare(`
      INSERT INTO chunks (id, document_id, instance_id, content, chunk_index, token_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const chunk of chunks) {
        insert.run(
          chunk.id,
          chunk.documentId,
          instanceId,
          chunk.content,
          chunk.chunkIndex,
          chunk.tokenCount
        );
      }
    });

    transaction();
    this.logger.info(`已保存 ${chunks.length} 个分段到数据库`);
  }

  /**
   * 更新文档状态
   */
  private updateDocumentStatus(docId: string, status: string): void {
    this.db?.run(
      `UPDATE documents SET status = ?, updated_at = datetime('now') WHERE id = ?`,
      [status, docId]
    );
  }

  /**
   * 获取文档列表
   */
  getDocuments(instanceId: string): KnowledgeDocument[] {
    if (!this.db) {
      return [];
    }

    const result = this.db.prepare(`
      SELECT id, instance_id, filename, file_type, file_size, storage_type, storage_key, storage_url, status
      FROM documents
      WHERE instance_id = ?
      ORDER BY created_at DESC
    `).all(instanceId);

    return result as KnowledgeDocument[];
  }

  /**
   * 获取文档分段
   */
  getChunks(documentId: string): DocumentChunk[] {
    if (!this.db) {
      return [];
    }

    const result = this.db.prepare(`
      SELECT id, document_id, content, chunk_index, token_count
      FROM chunks
      WHERE document_id = ?
      ORDER BY chunk_index
    `).all(documentId);

    return result as DocumentChunk[];
  }

  /**
   * 删除文档及其分段
   */
  deleteDocument(docId: string): void {
    if (!this.db) {
      return;
    }

    // 删除向量索引
    this.ragService.deleteDocumentChunks(docId);

    // 删除分段
    this.db.run('DELETE FROM chunks WHERE document_id = ?', [docId]);
    
    // 删除文档
    this.db.run('DELETE FROM documents WHERE id = ?', [docId]);

    this.logger.info(`已删除文档: ${docId}`);
  }

  /**
   * RAG 检索
   */
  async search(query: string, topK: number = 5, instanceId?: string) {
    return await this.ragService.search(query, topK, instanceId);
  }

  /**
   * 关闭数据库
   */
  close(): void {
    this.ragService.close();
    if (this.db) {
      this.db.close();
      this.logger.info('知识库数据库已关闭');
    }
  }
}
