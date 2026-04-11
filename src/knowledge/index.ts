/**
 * 知识库模块
 * 
 * 提供文档处理、向量化和 RAG 检索功能
 */

export { DocumentProcessor, type DocumentChunk, type ProcessResult } from './document-processor.js';
export { EmbeddingService, type EmbeddingOptions } from './embedding-service.js';
export { RAGService, type SearchResult } from './rag-service.js';
export { KnowledgeManager, type KnowledgeDocument } from './knowledge-manager.js';
