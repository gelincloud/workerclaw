/**
 * 微博运营指挥官 - 数据采集器
 *
 * 负责从 MiniABC 平台调用微博 Web CLI 获取数据
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { 
  WeiboAccountSnapshot, 
  WeiboHotSearch, 
  InteractionData,
  WeiboPostData 
} from './types.js';
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
  args?: Record<string, any>;
}

export class DataCollector {
  private logger: Logger;
  private apiUrl: string;
  private ownerId: string;
  private dataDir: string;
  private accountHistory: WeiboAccountSnapshot[] = [];
  private trendingHistory: WeiboHotSearch[] = [];

  constructor(apiUrl: string, ownerId: string, dataDir: string) {
    this.apiUrl = apiUrl;
    this.ownerId = ownerId;
    this.dataDir = dataDir;
    this.logger = createLogger('WeiboDataCollector');

    // 确保数据目录存在
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 加载历史数据
    this.loadHistory();
  }

  /**
   * 调用平台 CLI 接口
   * 使用统一的 /api/cli/execute 端点
   */
  private async callCli<T>(req: CliRequest): Promise<T | null> {
    try {
      const requestBody = {
        site: req.site,
        command: req.command,
        args: req.args || {},
        ownerId: this.ownerId, // 私有虾传递塘主ID
      };
      
      this.logger.debug('CLI 请求体:', JSON.stringify(requestBody));
      
      const response = await fetch(`${this.apiUrl}/api/cli/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Id': `commander-${this.ownerId}`, // 添加 Bot ID 标识（平台中间件要求）
        },
        body: JSON.stringify(requestBody),
      });

      // 先检查 HTTP 状态码
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
  async collectAccountSnapshot(): Promise<WeiboAccountSnapshot | null> {
    this.logger.info('开始采集账号数据...');

    // 获取当前用户资料
    const profileData = await this.callCli<any>({
      site: 'weibo',
      command: 'me',
    });

    if (!profileData) {
      this.logger.error('获取用户资料失败');
      return null;
    }

    const now = Date.now();
    const today = new Date().toISOString().split('T')[0];

    // 计算今日数据
    const lastSnapshot = this.accountHistory[this.accountHistory.length - 1];
    const lastTodaySnapshot = this.accountHistory.find(
      s => s.date === today && s.timestamp < now
    );

    const snapshot: WeiboAccountSnapshot = {
      timestamp: now,
      date: today,
      followers: profileData.followers_count || 0,
      following: profileData.friends_count || 0,
      statuses: profileData.statuses_count || 0,
      newFollowersToday: lastTodaySnapshot 
        ? (profileData.followers_count || 0) - lastTodaySnapshot.followers
        : 0,
      postsToday: lastTodaySnapshot 
        ? (profileData.statuses_count || 0) - lastTodaySnapshot.statuses
        : 0,
      interactionsToday: 0, // 需要从微博详情累加
    };

    this.accountHistory.push(snapshot);
    this.saveHistory();

    this.logger.info(`账号数据采集完成: 粉丝 ${snapshot.followers}, 今日新增 ${snapshot.newFollowersToday}`);
    return snapshot;
  }

  /**
   * 采集热搜数据
   */
  async collectTrending(): Promise<WeiboHotSearch | null> {
    this.logger.info('开始采集热搜数据...');

    const hotData = await this.callCli<{ list: any[] }>({
      site: 'weibo',
      command: 'hot_search',
    });

    if (!hotData?.list) {
      this.logger.error('获取热搜失败');
      return null;
    }

    const trending: WeiboHotSearch = {
      timestamp: Date.now(),
      topics: hotData.list.slice(0, 50).map((item, idx) => ({
        rank: idx + 1,
        topic: item.note || item.word || '',
        hotValue: item.raw_hot || item.num || 0,
        category: item.category,
      })),
    };

    this.trendingHistory.push(trending);
    this.saveTrendingHistory();

    this.logger.info(`热搜采集完成: ${trending.topics.length} 条`);
    return trending;
  }

  /**
   * 采集互动数据
   */
  async collectInteractions(): Promise<InteractionData | null> {
    this.logger.info('开始采集互动数据...');

    const interactions: InteractionData = {
      comments: [],
      mentions: [],
      newFollowers: [],
      messages: [],
    };

    // 获取最新评论（需要遍历最近的微博）
    const feedData = await this.callCli<{ list: any[] }>({
      site: 'weibo',
      command: 'feed',
    });

    if (feedData?.list) {
      for (const post of feedData.list.slice(0, 5)) {
        const comments = await this.callCli<{ list: any[] }>({
          site: 'weibo',
          command: 'comments',
          args: { post_id: post.id || post.mblogid, count: 10 },
        });

        if (comments?.list) {
          interactions.comments.push(...comments.list.map((c: any) => ({
            id: c.id,
            postId: post.id || post.mblogid,
            userId: c.user?.id,
            userName: c.user?.screen_name,
            content: c.text?.replace(/<[^>]+>/g, '') || '',
            createdAt: c.created_at,
          })));
        }
      }
    }

    // 获取 @我的微博
    const mentionsData = await this.callCli<{ statuses: any[] }>({
      site: 'weibo',
      command: 'mentions',
    });

    if (mentionsData?.statuses) {
      interactions.mentions = mentionsData.statuses.map((m: any) => ({
        id: m.id,
        userId: m.user?.id,
        userName: m.user?.screen_name,
        text: m.text?.replace(/<[^>]+>/g, '') || '',
        createdAt: m.created_at,
      }));
    }

    // 获取私信列表
    const dmData = await this.callCli<{ messages: any[] }>({
      site: 'weibo',
      command: 'messages',
    });

    if (dmData?.messages) {
      interactions.messages = dmData.messages.map((m: any) => ({
        id: m.id,
        fromUid: m.sender_id,
        fromName: m.sender_screen_name,
        content: m.text || '',
        createdAt: m.created_at,
      }));
    }

    this.logger.info(`互动数据采集完成: 评论 ${interactions.comments.length}, @ ${interactions.mentions.length}, 私信 ${interactions.messages.length}`);
    return interactions;
  }

  /**
   * 获取单条微博详情
   */
  async getPostDetail(postId: string): Promise<WeiboPostData | null> {
    const data = await this.callCli<any>({
      site: 'weibo',
      command: 'get',
      args: { id: postId },
    });

    if (!data) return null;

    return {
      id: data.id,
      createdAt: data.created_at,
      text: data.text?.replace(/<[^>]+>/g, '') || '',
      repostsCount: data.reposts_count || 0,
      commentsCount: data.comments_count || 0,
      attitudesCount: data.attitudes_count || 0,
      isLongText: data.isLongText || false,
      pics: data.pic_ids,
    };
  }

  /**
   * 获取账号历史数据
   */
  getAccountHistory(days: number = 7): WeiboAccountSnapshot[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.accountHistory.filter(s => s.timestamp >= cutoff);
  }

  /**
   * 获取最新热搜
   */
  getLatestTrending(): WeiboHotSearch | null {
    return this.trendingHistory[this.trendingHistory.length - 1] || null;
  }

  /**
   * 获取粉丝增长趋势
   */
  getFollowerTrend(days: number = 7): { date: string; followers: number; change: number }[] {
    const history = this.getAccountHistory(days);
    const result: { date: string; followers: number; change: number }[] = [];

    for (let i = 0; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      result.push({
        date: curr.date,
        followers: curr.followers,
        change: prev ? curr.followers - prev.followers : 0,
      });
    }

    return result;
  }

  // ==================== 持久化 ====================

  private getHistoryFilePath(): string {
    return path.join(this.dataDir, 'account-history.json');
  }

  private getTrendingFilePath(): string {
    return path.join(this.dataDir, 'trending-history.json');
  }

  private loadHistory(): void {
    try {
      // 加载账号历史
      const accountPath = this.getHistoryFilePath();
      if (fs.existsSync(accountPath)) {
        const content = fs.readFileSync(accountPath, 'utf-8');
        this.accountHistory = JSON.parse(content);
        this.logger.debug(`已加载 ${this.accountHistory.length} 条账号历史记录`);
      }

      // 加载热搜历史
      const trendingPath = this.getTrendingFilePath();
      if (fs.existsSync(trendingPath)) {
        const content = fs.readFileSync(trendingPath, 'utf-8');
        this.trendingHistory = JSON.parse(content);
        this.logger.debug(`已加载 ${this.trendingHistory.length} 条热搜历史记录`);
      }
    } catch (err) {
      this.logger.warn('加载历史数据失败，使用空数据', (err as Error).message);
      this.accountHistory = [];
      this.trendingHistory = [];
    }
  }

  private saveHistory(): void {
    try {
      // 只保留最近 30 天的数据
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      this.accountHistory = this.accountHistory.filter(s => s.timestamp >= cutoff);

      const filePath = this.getHistoryFilePath();
      fs.writeFileSync(filePath, JSON.stringify(this.accountHistory, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error('保存账号历史失败', (err as Error).message);
    }
  }

  private saveTrendingHistory(): void {
    try {
      // 只保留最近 7 天的热搜
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      this.trendingHistory = this.trendingHistory.filter(t => t.timestamp >= cutoff);

      const filePath = this.getTrendingFilePath();
      fs.writeFileSync(filePath, JSON.stringify(this.trendingHistory, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error('保存热搜历史失败', (err as Error).message);
    }
  }
}
