/**
 * 小红书运营指挥官 - 数据采集器
 *
 * 负责从 MiniABC 平台调用小红书 Web CLI 获取数据
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { 
  XhsAccountSnapshot, 
  XhsHotFeed,
  XhsCreatorStats,
  XhsNoteData,
  XhsInteractionData 
} from './xhs-types.js';
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

export class XhsDataCollector {
  private logger: Logger;
  private apiUrl: string;
  private ownerId: string;
  private dataDir: string;
  private accountHistory: XhsAccountSnapshot[] = [];
  private hotFeedHistory: XhsHotFeed[] = [];

  constructor(apiUrl: string, ownerId: string, dataDir: string) {
    this.apiUrl = apiUrl;
    this.ownerId = ownerId;
    this.dataDir = dataDir;
    this.logger = createLogger('XhsDataCollector');

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
          'X-Bot-Id': `xhs-commander-${this.ownerId}`,
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
  async collectAccountSnapshot(): Promise<XhsAccountSnapshot | null> {
    this.logger.info('开始采集小红书账号数据...');

    // 获取创作者信息
    const profileData = await this.callCli<any>({
      site: 'xiaohongshu',
      command: 'profile',
    });

    if (!profileData) {
      this.logger.error('获取创作者资料失败');
      return null;
    }

    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    // 计算今日新增
    const lastSnapshot = this.accountHistory[this.accountHistory.length - 1];
    const lastDate = lastSnapshot?.date || '';
    const newFollowersToday = lastDate === today ? 0 : (lastSnapshot ? profileData.followers - lastSnapshot.followers : 0);

    const snapshot: XhsAccountSnapshot = {
      timestamp: now,
      date: today,
      followers: profileData.followers || 0,
      following: profileData.following || 0,
      likesAndCollects: profileData.likes_and_collects || 0,
      creatorLevel: profileData.creator_level || 0,
      newFollowersToday,
      notesToday: 0, // 需要单独统计
      interactionsToday: 0,
    };

    // 获取创作者统计补充数据
    const statsData = await this.callCli<XhsCreatorStats>({
      site: 'xiaohongshu',
      command: 'creator_stats',
      args: { period: 'seven' },
    });

    if (statsData) {
      snapshot.interactionsToday = statsData.likes + statsData.collects + statsData.comments;
    }

    // 保存快照
    this.accountHistory.push(snapshot);
    this.saveHistory();

    this.logger.info('账号数据采集完成:', snapshot);
    return snapshot;
  }

  /**
   * 采集热门推荐
   */
  async collectHotFeed(limit: number = 20): Promise<XhsHotFeed | null> {
    this.logger.info('开始采集小红书热门推荐...');

    const data = await this.callCli<any[]>({
      site: 'xiaohongshu',
      command: 'hot',
      args: { limit },
    });

    if (!data) {
      this.logger.error('获取热门推荐失败');
      return null;
    }

    const hotFeed: XhsHotFeed = {
      timestamp: Date.now(),
      notes: data.map((item, index) => ({
        rank: index + 1,
        title: item.title || '',
        author: item.author || '',
        likes: item.likes || '0',
        noteId: item.note_id || '',
        url: item.url || '',
      })),
    };

    // 保存历史
    this.hotFeedHistory.push(hotFeed);
    this.saveHistory();

    this.logger.info(`热门推荐采集完成: ${hotFeed.notes.length} 条`);
    return hotFeed;
  }

  /**
   * 采集创作者笔记列表
   */
  async collectCreatorNotes(limit: number = 20): Promise<XhsNoteData[]> {
    this.logger.info('开始采集创作者笔记列表...');

    const data = await this.callCli<any[]>({
      site: 'xiaohongshu',
      command: 'creator_notes',
      args: { limit },
    });

    if (!data) {
      this.logger.error('获取创作者笔记列表失败');
      return [];
    }

    const notes: XhsNoteData[] = data.map(item => ({
      id: item.id || '',
      title: item.title || '',
      type: 'image', // 默认图文
      date: item.date || '',
      views: item.views || 0,
      likes: item.likes || 0,
      collects: item.collects || 0,
      comments: item.comments || 0,
      shares: 0,
      url: item.url || '',
    }));

    this.logger.info(`创作者笔记列表采集完成: ${notes.length} 条`);
    return notes;
  }

  /**
   * 采集创作者统计数据
   */
  async collectCreatorStats(period: 'seven' | 'thirty' = 'seven'): Promise<XhsCreatorStats | null> {
    this.logger.info(`开始采集创作者统计数据 (${period}天)...`);

    const data = await this.callCli<XhsCreatorStats>({
      site: 'xiaohongshu',
      command: 'creator_stats',
      args: { period },
    });

    if (!data) {
      this.logger.error('获取创作者统计数据失败');
      return null;
    }

    this.logger.info('创作者统计数据采集完成');
    return data;
  }

  /**
   * 采集笔记详细数据
   */
  async collectNoteDetail(noteId: string): Promise<any | null> {
    this.logger.info(`开始采集笔记详细数据: ${noteId}`);

    const data = await this.callCli<any>({
      site: 'xiaohongshu',
      command: 'note_detail',
      args: { note_id: noteId },
    });

    if (!data) {
      this.logger.error('获取笔记详细数据失败');
      return null;
    }

    this.logger.info('笔记详细数据采集完成');
    return data;
  }

  /**
   * 搜索笔记
   */
  async searchNotes(query: string, limit: number = 20): Promise<XhsNoteData[]> {
    this.logger.info(`搜索笔记: ${query}`);

    const data = await this.callCli<any[]>({
      site: 'xiaohongshu',
      command: 'search',
      args: { query, limit },
    });

    if (!data) {
      this.logger.error('搜索笔记失败');
      return [];
    }

    return data.map(item => ({
      id: item.url?.match(/\/explore\/([a-f0-9]+)/)?.[1] || '',
      title: item.title || '',
      type: 'image',
      date: item.published_at || '',
      views: 0,
      likes: parseInt(item.likes) || 0,
      collects: 0,
      comments: 0,
      url: item.url || '',
    }));
  }

  /**
   * 获取账号历史数据
   */
  getAccountHistory(days: number = 7): XhsAccountSnapshot[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.accountHistory.filter(s => s.timestamp >= cutoff);
  }

  /**
   * 获取最新热门推荐
   */
  getLatestHotFeed(): XhsHotFeed | null {
    return this.hotFeedHistory[this.hotFeedHistory.length - 1] || null;
  }

  /**
   * 加载历史数据
   */
  private loadHistory(): void {
    const accountFile = path.join(this.dataDir, 'xhs-account-history.json');
    const hotFeedFile = path.join(this.dataDir, 'xhs-hotfeed-history.json');

    try {
      if (fs.existsSync(accountFile)) {
        this.accountHistory = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
        this.logger.info(`加载账号历史数据: ${this.accountHistory.length} 条`);
      }

      if (fs.existsSync(hotFeedFile)) {
        this.hotFeedHistory = JSON.parse(fs.readFileSync(hotFeedFile, 'utf-8'));
        this.logger.info(`加载热门推荐历史数据: ${this.hotFeedHistory.length} 条`);
      }
    } catch (err) {
      this.logger.error('加载历史数据失败', (err as Error).message);
    }
  }

  /**
   * 保存历史数据
   */
  private saveHistory(): void {
    const accountFile = path.join(this.dataDir, 'xhs-account-history.json');
    const hotFeedFile = path.join(this.dataDir, 'xhs-hotfeed-history.json');

    try {
      // 只保留最近 30 天的数据
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      this.accountHistory = this.accountHistory.filter(s => s.timestamp >= cutoff);
      this.hotFeedHistory = this.hotFeedHistory.filter(h => h.timestamp >= cutoff);

      fs.writeFileSync(accountFile, JSON.stringify(this.accountHistory, null, 2));
      fs.writeFileSync(hotFeedFile, JSON.stringify(this.hotFeedHistory, null, 2));
    } catch (err) {
      this.logger.error('保存历史数据失败', (err as Error).message);
    }
  }
}
