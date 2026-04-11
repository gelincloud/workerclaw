/**
 * 文档处理器
 * 
 * 功能：
 * - 文档下载（从 URL）
 * - 文档解析（PDF/TXT/MD/DOCX）- 纯 Node.js 方案
 * - 文档分段
 */

import { createLogger, type Logger } from '../core/logger.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import { exec as execCallback } from 'node:child_process';
import { createReadStream } from 'node:fs';

const exec = promisify(execCallback);

/** WorkerClaw 数据目录 */
const WORKERCLAW_DIR = join(homedir(), '.workerclaw');
/** 知识库目录 */
const KNOWLEDGE_DIR = join(WORKERCLAW_DIR, 'knowledge');
/** 文档目录 */
const DOCUMENTS_DIR = join(KNOWLEDGE_DIR, 'documents');

/** 文档分段 */
export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  tokenCount: number;
}

/** 文档处理结果 */
export interface ProcessResult {
  success: boolean;
  chunks: DocumentChunk[];
  error?: string;
}

export class DocumentProcessor {
  private logger: Logger;

  constructor() {
    this.logger = createLogger('DocumentProcessor');
    this.ensureDirectories();
  }

  /**
   * 确保目录存在
   */
  private ensureDirectories(): void {
    if (!existsSync(WORKERCLAW_DIR)) {
      mkdirSync(WORKERCLAW_DIR, { recursive: true });
    }
    if (!existsSync(KNOWLEDGE_DIR)) {
      mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    }
    if (!existsSync(DOCUMENTS_DIR)) {
      mkdirSync(DOCUMENTS_DIR, { recursive: true });
    }
  }

  /**
   * 下载文档
   */
  async downloadDocument(url: string, docId: string, filename: string): Promise<string> {
    const localPath = join(DOCUMENTS_DIR, `${docId}-${filename}`);
    
    try {
      // 使用 curl 下载文件
      const { stdout, stderr } = await exec(`curl -s -L -o "${localPath}" "${url}"`);
      
      if (!existsSync(localPath)) {
        throw new Error('文件下载失败');
      }

      this.logger.info(`文档已下载: ${localPath}`);
      return localPath;
    } catch (err: any) {
      this.logger.error('下载文档失败', err);
      throw new Error(`下载失败: ${err.message}`);
    }
  }

  /**
   * 解析文档
   */
  async parseDocument(filePath: string, fileType: string): Promise<string> {
    try {
      const ext = filePath.split('.').pop()?.toLowerCase();

      switch (ext) {
        case 'txt':
        case 'md':
          return this.parseTextFile(filePath);
        
        case 'pdf':
          return await this.parsePDF(filePath);
        
        case 'docx':
          return await this.parseDOCX(filePath);
        
        default:
          throw new Error(`不支持的文件类型: ${ext}`);
      }
    } catch (err: any) {
      this.logger.error('解析文档失败', err);
      throw new Error(`解析失败: ${err.message}`);
    }
  }

  /**
   * 解析文本文件（TXT/MD）
   */
  private parseTextFile(filePath: string): string {
    const content = readFileSync(filePath, 'utf-8');
    return content;
  }

  /**
   * 解析 PDF 文件 - 使用 pdf-parse (纯 Node.js)
   */
  private async parsePDF(filePath: string): Promise<string> {
    try {
      // 动态导入 pdf-parse
      const pdfParse = await import('pdf-parse');
      
      const dataBuffer = readFileSync(filePath);
      const data = await (pdfParse as any).default(dataBuffer);
      
      this.logger.info(`PDF 解析成功: ${filePath}, ${data.numpages} 页`);
      return data.text;
    } catch (err: any) {
      this.logger.error('PDF 解析失败', err);
      throw new Error(`PDF 解析失败: ${err.message}`);
    }
  }

  /**
   * 解析 DOCX 文件 - 使用 mammoth (纯 Node.js)
   */
  private async parseDOCX(filePath: string): Promise<string> {
    try {
      // 动态导入 mammoth
      const mammoth = await import('mammoth');
      
      const result = await mammoth.extractRawText({ path: filePath });
      
      this.logger.info(`DOCX 解析成功: ${filePath}`);
      return result.value;
    } catch (err: any) {
      this.logger.error('DOCX 解析失败', err);
      throw new Error(`DOCX 解析失败: ${err.message}`);
    }
  }

  /**
   * 分段文档
   * 策略：按段落分割，每个段落最多 500 字符
   */
  chunkDocument(content: string, documentId: string, maxChunkSize: number = 500): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    
    // 按段落分割
    const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    let chunkIndex = 0;
    
    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      
      // 如果段落太长，进一步分割
      if (trimmed.length > maxChunkSize) {
        const subChunks = this.splitLongText(trimmed, maxChunkSize);
        for (const subChunk of subChunks) {
          chunks.push({
            id: `${documentId}-chunk-${chunkIndex}`,
            documentId,
            content: subChunk,
            chunkIndex,
            tokenCount: this.estimateTokenCount(subChunk),
          });
          chunkIndex++;
        }
      } else {
        chunks.push({
          id: `${documentId}-chunk-${chunkIndex}`,
          documentId,
          content: trimmed,
          chunkIndex,
          tokenCount: this.estimateTokenCount(trimmed),
        });
        chunkIndex++;
      }
    }

    this.logger.info(`文档已分段: ${documentId}, ${chunks.length} 个分段`);
    return chunks;
  }

  /**
   * 分割长文本
   */
  private splitLongText(text: string, maxSize: number): string[] {
    const chunks: string[] = [];
    
    // 尝试按句子分割
    const sentences = text.split(/([。！？\n])/);
    let current = '';
    
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      
      if (current.length + sentence.length <= maxSize) {
        current += sentence;
      } else {
        if (current.length > 0) {
          chunks.push(current.trim());
          current = sentence;
        } else {
          // 单个句子就超长，强制分割
          chunks.push(sentence.substring(0, maxSize));
          current = sentence.substring(maxSize);
        }
      }
    }
    
    if (current.trim().length > 0) {
      chunks.push(current.trim());
    }

    return chunks;
  }

  /**
   * 估算 token 数量（简单估算：中文按字符，英文按单词）
   */
  private estimateTokenCount(text: string): number {
    // 中文字符数
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    // 英文单词数
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    // 数字
    const numbers = (text.match(/\d+/g) || []).length;
    
    return chineseChars + englishWords + numbers;
  }

  /**
   * 完整处理流程：下载 -> 解析 -> 分段
   */
  async processDocument(
    url: string,
    docId: string,
    filename: string,
    fileType: string
  ): Promise<ProcessResult> {
    try {
      // 1. 下载文档
      const localPath = await this.downloadDocument(url, docId, filename);
      
      // 2. 解析文档
      const content = await this.parseDocument(localPath, fileType);
      
      // 3. 分段
      const chunks = this.chunkDocument(content, docId);
      
      return {
        success: true,
        chunks,
      };
    } catch (err: any) {
      this.logger.error('文档处理失败', err);
      return {
        success: false,
        chunks: [],
        error: err.message,
      };
    }
  }
}
