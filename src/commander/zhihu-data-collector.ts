/**
 * 知乎运营指挥官 - 数据采集器
 *
 * 负责从 MiniABC 平台调用知乎 Web CLI 获取数据
 */

import { createLogger, type Logger } from '../core/logger.js';
import type {
  ZhihuAccountSnapshot,
  ZhihuHotData,
  ZhihuHotItem,
  ZhihuSearchResult,
  ZhihuAnswerData,
} from './zhihu-types.js';
import * as fs from 'fs';
import * as path from 'path';

/** 平台 API 响应 */
interface PlatformResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** CLI 命令请求 */
interface CliRequest {
  site: string;
  command: string;
  args?: Record<string, unknown>;
}

export class ZhihuDataCollector {
  private logger: Logger;
  private apiUrl: string;
  private ownerId: string;
  private dataDir: string;
  private accountHistory: ZhihuAccountSnapshot[] = [];
  private hotHistory: ZhihuHotData[] = [];

  constructor(apiUrl: string, ownerId: string, dataDir: string) {
    this.apiUrl = apiUrl;
    this.ownerId = ownerId;
    this.dataDir = dataDir;
    this.logger = createLogger('ZhihuDataCollector');

    // 确保数据目录存在
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 加载历史数据
    this.loadHistory();
  }

  /**
   * 调用平台 CLI 接口
   */
  private async callCli<T>(req: CliRequest): Promise<T | null> {
    try {
      const requestBody = {
        site: req.site,
        command: req.command,
        args: req.args || {},
        ownerId: this.ownerId,
      };

      this.logger.debug('CLI 请求:', JSON.stringify(requestBody));

      const response = await fetch(`${this.apiUrl}/api/cli/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': `zhihu-commander-${this.ownerId}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`CLI 调用失败 [${req.site}.${req.command}] HTTP ${response.status}:`, errorText);
        return null;
      }

      const result = await response.json() as PlatformResponse<T>;

      if (!result.success) {
        this.logger.error(`CLI 调用失败 [${req.site}.${req.command}]`, result.error || '');
        return null;
      }

      return result.data || null;
    } catch (err) {
      this.logger.error(`CLI 调用异常 [${req.site}.${req.command}]`, (err as Error).message);
      return null;
    }
  }

  /**
   * 采集账号数据快照
   */
  async collectAccountSnapshot(): Promise<ZhihuAccountSnapshot | null> {
    this.logger.info('开始采集知乎账号数据...');

    // 获取账号信息
    const profileData = await this.callCli<{
      id?: string | number;
      name?: string;
      uid?: string;
      url_token?: string;
      headline?: string;
      follower_count?: number;
      following_count?: number;
      answer_count?: number;
      articles_count?: number;
      voteup_count?: number;
    }>({
      site: 'zhihu',
      command: 'profile',
    });

    if (!profileData) {
      this.logger.error('获取账号资料失败');
      return null;
    }

    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    // 计算今日新增
    const lastSnapshot = this.accountHistory[this.accountHistory.length - 1];
    const lastDate = lastSnapshot?.date || '';
    const newFollowersToday =
      lastDate === today
        ? 0
        : lastSnapshot
          ? (profileData.follower_count || 0) - lastSnapshot.followers
          : 0;

    const snapshot: ZhihuAccountSnapshot = {
      timestamp: now,
      date: today,
      uid: String(profileData.id || profileData.uid || ''),
      nickname: profileData.name || '',
      followers: profileData.follower_count || 0,
      following: profileData.following_count || 0,
      answerCount: profileData.answer_count || 0,
      articleCount: profileData.articles_count || 0,
      voteupCount: profileData.voteup_count || 0,
      newFollowersToday,
      answersToday: 0,
      articlesToday: 0,
      interactionsToday: 0,
    };

    // 保存快照
    this.accountHistory.push(snapshot);
    this.saveHistory();

    this.logger.info('账号数据采集完成:', snapshot);
    return snapshot;
  }

  /**
   * 采集热榜数据
   */
  async collectHotList(limit: number = 20): Promise<ZhihuHotData | null> {
    this.logger.info('开始采集知乎热榜...');

    const data = await this.callCli<Array<{
      rank?: number;
      target?: {
        id?: string | number;
        title?: string;
        answer_count?: number;
        follower_count?: number;
      };
      detail_text?: string;
      url?: string;
    }>>({
      site: 'zhihu',
      command: 'hot',
      args: { limit },
    });

    if (!data) {
      this.logger.error('获取热榜数据失败');
      return null;
    }

    const hotData: ZhihuHotData = {
      timestamp: Date.now(),
      items: data.map((item, index): ZhihuHotItem => ({
        rank: item.rank || index + 1,
        questionId: String(item.target?.id || ''),
        title: item.target?.title || '',
        heat: item.detail_text || '',
        url: item.url || `https://www.zhihu.com/question/${item.target?.id || ''}`,
        answerCount: item.target?.answer_count || 0,
        followerCount: item.target?.follower_count || 0,
      })),
    };

    // 保存历史
    this.hotHistory.push(hotData);
    this.saveHistory();

    this.logger.info(`热榜采集完成: ${hotData.items.length} 条`);
    return hotData;
  }

  /**
   * 搜索知乎内容
   */
  async search(query: string, limit: number = 10): Promise<ZhihuSearchResult[]> {
    this.logger.info(`搜索知乎内容: ${query}`);

    const data = await this.callCli<Array<{
      type?: string;
      title?: string;
      highlight?: { title?: string; content?: string };
      url?: string;
      author?: { name?: string };
    }>>({
      site: 'zhihu',
      command: 'search',
      args: { q: query, limit },
    });

    if (!data) {
      this.logger.error('搜索失败');
      return [];
    }

    return data.map(item => ({
      type: item.type || 'unknown',
      title: item.highlight?.title?.replace(/<[^>]+>/g, '') || item.title || '',
      excerpt: item.highlight?.content?.replace(/<[^>]+>/g, '') || '',
      url: item.url || '',
      author: item.author?.name || '',
    }));
  }

  /**
   * 获取问题详情和高赞回答
   */
  async getQuestionAnswers(questionId: string, limit: number = 5): Promise<ZhihuAnswerData[]> {
    this.logger.info(`获取问题详情: ${questionId}`);

    const data = await this.callCli<{
      question_id?: string;
      answer_count?: number;
      answers?: Array<{
        id?: string | number;
        author?: { name?: string };
        content?: string;
        voteup_count?: number;
        comment_count?: number;
        created_time?: number;
        url?: string;
      }>;
    }>({
      site: 'zhihu',
      command: 'question',
      args: { id: questionId, limit },
    });

    if (!data || !data.answers) {
      this.logger.error('获取问题详情失败');
      return [];
    }

    return data.answers.map((answer, index): ZhihuAnswerData => ({
      answerId: String(answer.id || ''),
      questionId: questionId,
      questionTitle: '',
      author: answer.author?.name || '匿名',
      content: answer.content || '',
      voteupCount: answer.voteup_count || 0,
      commentCount: answer.comment_count || 0,
      createdAt: answer.created_time ? new Date(answer.created_time * 1000).toISOString() : '',
      url: answer.url || `https://www.zhihu.com/question/${questionId}/answer/${answer.id}`,
    }));
  }

  /**
   * 发布文章
   */
  async postArticle(title: string, content: string, draft: boolean = false): Promise<{ success: boolean; articleId?: string; url?: string; error?: string }> {
    this.logger.info(`发布知乎文章: ${title.substring(0, 30)}...`);

    const result = await this.callCli<{
      ok?: boolean;
      id?: string | number;
      url?: string;
      status?: string;
      message?: string;
    }>({
      site: 'zhihu',
      command: 'article',
      args: { title, content, draft },
    });

    if (!result) {
      return { success: false, error: '发布失败' };
    }

    return {
      success: result.ok !== false,
      articleId: result.id ? String(result.id) : undefined,
      url: result.url,
      error: result.ok === false ? result.message : undefined,
    };
  }

  /**
   * 回答问题
   */
  async postAnswer(questionId: string, content: string, draft: boolean = false): Promise<{ success: boolean; answerId?: string; url?: string; error?: string }> {
    this.logger.info(`回答知乎问题: ${questionId}`);

    const result = await this.callCli<{
      ok?: boolean;
      id?: string | number;
      url?: string;
      status?: string;
      message?: string;
    }>({
      site: 'zhihu',
      command: 'answer',
      args: { id: questionId, content, draft },
    });

    if (!result) {
      return { success: false, error: '回答失败' };
    }

    return {
      success: result.ok !== false,
      answerId: result.id ? String(result.id) : undefined,
      url: result.url,
      error: result.ok === false ? result.message : undefined,
    };
  }

  /**
   * 发布评论
   */
  async postComment(content: string, resourceType: 'answer' | 'article' | 'question', resourceId: string, replyToId?: string): Promise<{ success: boolean; commentId?: string; error?: string }> {
    this.logger.info(`发布评论: ${resourceType}/${resourceId}`);

    const result = await this.callCli<{
      ok?: boolean;
      id?: string | number;
      message?: string;
    }>({
      site: 'zhihu',
      command: 'comment',
      args: { content, resource_type: resourceType, resource_id: resourceId, reply_to_id: replyToId },
    });

    if (!result) {
      return { success: false, error: '评论失败' };
    }

    return {
      success: result.ok !== false,
      commentId: result.id ? String(result.id) : undefined,
      error: result.ok === false ? result.message : undefined,
    };
  }

  /**
   * 获取账号历史数据
   */
  getAccountHistory(days: number = 7): ZhihuAccountSnapshot[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.accountHistory.filter(s => s.timestamp >= cutoff);
  }

  /**
   * 获取最新热榜数据
   */
  getLatestHotList(): ZhihuHotData | null {
    return this.hotHistory[this.hotHistory.length - 1] || null;
  }

  /**
   * 加载历史数据
   */
  private loadHistory(): void {
    const accountFile = path.join(this.dataDir, 'zhihu-account-history.json');
    const hotFile = path.join(this.dataDir, 'zhihu-hot-history.json');

    try {
      if (fs.existsSync(accountFile)) {
        this.accountHistory = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
        this.logger.info(`加载账号历史数据: ${this.accountHistory.length} 条`);
      }

      if (fs.existsSync(hotFile)) {
        this.hotHistory = JSON.parse(fs.readFileSync(hotFile, 'utf-8'));
        this.logger.info(`加载热榜历史数据: ${this.hotHistory.length} 条`);
      }
    } catch (err) {
      this.logger.error('加载历史数据失败', (err as Error).message);
    }
  }

  /**
   * 保存历史数据
   */
  private saveHistory(): void {
    const accountFile = path.join(this.dataDir, 'zhihu-account-history.json');
    const hotFile = path.join(this.dataDir, 'zhihu-hot-history.json');

    try {
      // 只保留最近 30 天的数据
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      this.accountHistory = this.accountHistory.filter(s => s.timestamp >= cutoff);
      this.hotHistory = this.hotHistory.filter(h => h.timestamp >= cutoff);

      fs.writeFileSync(accountFile, JSON.stringify(this.accountHistory, null, 2));
      fs.writeFileSync(hotFile, JSON.stringify(this.hotHistory, null, 2));
    } catch (err) {
      this.logger.error('保存历史数据失败', (err as Error).message);
    }
  }
}
