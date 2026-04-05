/**
 * 会话管理器
 *
 * 管理多轮会话的上下文累积
 * 每个任务有独立会话，支持会话复用
 */

import { createLogger, type Logger } from '../core/logger.js';
import { ContextWindow, type ContextWindowConfig, type ContextWindowStats } from './context-window.js';
import type { LLMMessage } from '../types/agent.js';

// ==================== 会话 ====================

export interface Session {
  /** 会话 ID（通常等于 taskId） */
  id: string;
  /** 消息历史 */
  messages: LLMMessage[];
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 总轮次 */
  turnCount: number;
  /** Token 使用统计 */
  totalTokensUsed: number;
  /** 是否已完成 */
  completed: boolean;
}

// ==================== 会话管理器配置 ====================

export interface SessionManagerConfig {
  /** 最大活跃会话数 */
  maxActiveSessions: number;
  /** 会话过期时间 (ms) */
  sessionTTL: number;
  /** 上下文窗口配置 */
  contextWindow: Partial<ContextWindowConfig>;
}

export const DEFAULT_SESSION_CONFIG: SessionManagerConfig = {
  maxActiveSessions: 50,
  sessionTTL: 30 * 60 * 1000, // 30 分钟
  contextWindow: {
    maxTokens: 8000,
    keepRecentMessages: 4,
  },
};

// ==================== SessionManager ====================

export class SessionManager {
  private logger: Logger;
  private config: SessionManagerConfig;
  private sessions = new Map<string, Session>();
  private contextWindow: ContextWindow;

  constructor(config?: Partial<SessionManagerConfig>) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
    this.contextWindow = new ContextWindow(this.config.contextWindow);
    this.logger = createLogger('SessionManager');
  }

  /**
   * 创建新会话（如果已存在则重置）
   */
  createSession(id: string, systemPrompt?: string): Session {
    if (this.sessions.has(id)) {
      this.logger.warn(`会话 ${id} 已存在，将被重置`);
    }

    // 检查会话数量限制
    if (this.sessions.size >= this.config.maxActiveSessions) {
      this.evictExpiredSessions();
    }

    const session: Session = {
      id,
      messages: systemPrompt ? [{ role: 'system', content: systemPrompt }] : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCount: 0,
      totalTokensUsed: 0,
      completed: false,
    };

    this.sessions.set(id, session);
    this.logger.debug(`创建会话 [${id}]`);

    return session;
  }

  /**
   * 复用或创建会话（用于主人连续指令的上下文记忆）
   * 如果会话已存在且未完成，直接追加消息而不重置历史
   * 如果不存在或已完成，创建新会话
   */
  resumeOrCreateSession(id: string, systemPrompt?: string): Session {
    const existing = this.sessions.get(id);
    if (existing && !existing.completed) {
      // 复用已有会话，更新 system prompt（保留历史消息）
      if (systemPrompt && existing.messages.length > 0 && existing.messages[0].role === 'system') {
        existing.messages[0].content = systemPrompt;
      }
      existing.updatedAt = Date.now();
      this.logger.debug(`复用会话 [${id}]，当前消息数: ${existing.messages.length}`);
      return existing;
    }
    // 不存在或已完成 → 创建新会话
    return this.createSession(id, systemPrompt);
  }

  /**
   * 获取会话
   */
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * 添加消息到会话
   */
  addMessage(sessionId: string, message: LLMMessage): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn(`会话 ${sessionId} 不存在`);
      return undefined;
    }

    session.messages.push(message);
    session.updatedAt = Date.now();
    session.totalTokensUsed += this.contextWindow.estimateTokens(message);

    // 计算轮次（user 消息计为 1 轮）
    if (message.role === 'user') {
      session.turnCount++;
    }

    return session;
  }

  /**
   * 获取会话的上下文窗口适配消息
   */
  getFittedMessages(sessionId: string): {
    messages: LLMMessage[];
    stats: ContextWindowStats;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        messages: [],
        stats: {
          totalTokens: 0,
          systemTokens: 0,
          conversationTokens: 0,
          messageCount: 0,
          isTruncated: false,
        },
      };
    }

    return this.contextWindow.fitToWindow(session.messages);
  }

  /**
   * 标记会话完成
   */
  completeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.completed = true;
      session.updatedAt = Date.now();
    }
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * 检查会话是否存在
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * 获取所有活跃会话 ID
   */
  getActiveSessionIds(): string[] {
    return [...this.sessions.keys()].filter(id => !this.sessions.get(id)!.completed);
  }

  /**
   * 获取会话统计
   */
  getSessionStats(sessionId: string): {
    messageCount: number;
    turnCount: number;
    totalTokensUsed: number;
    ageMs: number;
    contextStats: ContextWindowStats;
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const contextStats = this.contextWindow.getStats(session.messages);

    return {
      messageCount: session.messages.length,
      turnCount: session.turnCount,
      totalTokensUsed: session.totalTokensUsed,
      ageMs: Date.now() - session.createdAt,
      contextStats,
    };
  }

  /**
   * 获取全局统计
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    completedSessions: number;
    totalTokensUsed: number;
  } {
    let active = 0;
    let completed = 0;
    let totalTokens = 0;

    for (const session of this.sessions.values()) {
      if (session.completed) {
        completed++;
      } else {
        active++;
      }
      totalTokens += session.totalTokensUsed;
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions: active,
      completedSessions: completed,
      totalTokensUsed: totalTokens,
    };
  }

  /**
   * 清理过期会话
   */
  evictExpiredSessions(): number {
    const now = Date.now();
    let evicted = 0;

    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > this.config.sessionTTL) {
        this.sessions.delete(id);
        evicted++;
      }
    }

    if (evicted > 0) {
      this.logger.info(`清理了 ${evicted} 个过期会话`);
    }

    return evicted;
  }

  /**
   * 清理所有已完成会话
   */
  evictCompletedSessions(): number {
    let evicted = 0;

    for (const [id, session] of this.sessions) {
      if (session.completed) {
        this.sessions.delete(id);
        evicted++;
      }
    }

    return evicted;
  }

  /**
   * 获取上下文窗口实例（供外部使用）
   */
  getContextWindow(): ContextWindow {
    return this.contextWindow;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.sessions.clear();
  }
}
