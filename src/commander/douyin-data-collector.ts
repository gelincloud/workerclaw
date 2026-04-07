/**
 * 抖音运营指挥官 - 数据采集器
 *
 * 负责从 MiniABC 平台调用抖音 Web CLI 获取数据
 */

import { createLogger, type Logger } from '../core/logger.js';
import type {
  DouyinAccountSnapshot,
  DouyinHotData,
  DouyinVideoData,
  DouyinHashtag,
  DouyinActivity,
  DouyinCollection,
  DouyinVideoStats,
} from './douyin-types.js';
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

export class DouyinDataCollector {
  private logger: Logger;
  private apiUrl: string;
  private ownerId: string;
  private dataDir: string;
  private accountHistory: DouyinAccountSnapshot[] = [];
  private hotHistory: DouyinHotData[] = [];

  constructor(apiUrl: string, ownerId: string, dataDir: string) {
    this.apiUrl = apiUrl;
    this.ownerId = ownerId;
    this.dataDir = dataDir;
    this.logger = createLogger('DouyinDataCollector');

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
          'X-Bot-Id': `douyin-commander-${this.ownerId}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`CLI 调用失败 [${req.site}.${req.command}] HTTP ${response.status}:`, errorText);
        return null;
      }

      const result = (await response.json()) as PlatformResponse<T>;

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
  async collectAccountSnapshot(): Promise<DouyinAccountSnapshot | null> {
    this.logger.info('开始采集抖音账号数据...');

    // 获取账号信息
    const profileData = await this.callCli<{
      uid?: string;
      nickname?: string;
      follower_count?: number;
      following_count?: number;
      aweme_count?: number;
    }>({
      site: 'douyin',
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
          ? (profileData.follower_count || 0) - lastSnapshot.followerCount
          : 0;

    const snapshot: DouyinAccountSnapshot = {
      timestamp: now,
      date: today,
      uid: profileData.uid || '',
      nickname: profileData.nickname || '',
      followerCount: profileData.follower_count || 0,
      followingCount: profileData.following_count || 0,
      awemeCount: profileData.aweme_count || 0,
      newFollowersToday,
      postsToday: 0,
      interactionsToday: 0,
    };

    // 获取作品列表补充互动数据
    const videosData = await this.callCli<
      Array<{
        aweme_id?: string;
        statistics?: { play_count?: number; digg_count?: number };
      }>
    >({
      site: 'douyin',
      command: 'videos',
      args: { limit: 10 },
    });

    if (videosData && Array.isArray(videosData)) {
      // 计算今日发布数和总互动数
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayTimestamp = todayStart.getTime() / 1000;

      let totalInteractions = 0;
      for (const video of videosData) {
        totalInteractions += (video.statistics?.play_count || 0) + (video.statistics?.digg_count || 0);
      }
      snapshot.interactionsToday = totalInteractions;
    }

    // 保存快照
    this.accountHistory.push(snapshot);
    this.saveHistory();

    this.logger.info('账号数据采集完成:', snapshot);
    return snapshot;
  }

  /**
   * 采集作品列表
   */
  async collectVideos(limit: number = 20, status?: string): Promise<DouyinVideoData[]> {
    this.logger.info('开始采集抖音作品列表...');

    const data = await this.callCli<
      Array<{
        aweme_id?: string;
        desc?: string;
        status?: string | number;
        public_time?: number;
        create_time?: number;
        statistics?: {
          play_count?: number;
          digg_count?: number;
          comment_count?: number;
          share_count?: number;
        };
        video?: {
          duration?: number;
          cover?: string;
        };
      }>
    >({
      site: 'douyin',
      command: 'videos',
      args: { limit, status: status || 'all' },
    });

    if (!data) {
      this.logger.error('获取作品列表失败');
      return [];
    }

    const videos: DouyinVideoData[] = data.map((item) => ({
      awemeId: item.aweme_id || '',
      desc: item.desc || '',
      status: typeof item.status === 'string' ? item.status : 'published',
      publicTime: item.public_time,
      createTime: item.create_time,
      statistics: {
        playCount: item.statistics?.play_count || 0,
        diggCount: item.statistics?.digg_count || 0,
        commentCount: item.statistics?.comment_count || 0,
        shareCount: item.statistics?.share_count || 0,
      },
      video: item.video ? {
        duration: item.video.duration || 0,
        cover: item.video.cover,
      } : undefined,
    }));

    this.logger.info(`作品列表采集完成: ${videos.length} 条`);
    return videos;
  }

  /**
   * 采集热点词
   */
  async collectHotspots(limit: number = 20, keyword?: string): Promise<DouyinHotData | null> {
    this.logger.info('开始采集抖音热点词...');

    const data = await this.callCli<
      Array<{
        name?: string;
        id?: string;
        view_count?: number;
      }>
    >({
      site: 'douyin',
      command: 'hashtag',
      args: { action: 'hot', keyword: keyword || '', limit },
    });

    if (!data) {
      this.logger.error('获取热点词失败');
      return null;
    }

    const hotData: DouyinHotData = {
      timestamp: Date.now(),
      hotspots: data.map((item) => ({
        sentence: item.name || '',
        hotValue: item.view_count || 0,
        sentenceId: item.id,
      })),
    };

    // 保存历史
    this.hotHistory.push(hotData);
    this.saveHistory();

    this.logger.info(`热点词采集完成: ${hotData.hotspots.length} 条`);
    return hotData;
  }

  /**
   * 搜索话题
   */
  async searchHashtags(keyword: string, limit: number = 10): Promise<DouyinHashtag[]> {
    this.logger.info(`搜索抖音话题: ${keyword}`);

    const data = await this.callCli<
      Array<{
        name?: string;
        id?: string;
        view_count?: number;
      }>
    >({
      site: 'douyin',
      command: 'hashtag',
      args: { action: 'search', keyword, limit },
    });

    if (!data) {
      this.logger.error('搜索话题失败');
      return [];
    }

    return data.map((item) => ({
      name: item.name || '',
      id: item.id || '',
      viewCount: item.view_count || 0,
    }));
  }

  /**
   * 获取活动列表
   */
  async collectActivities(): Promise<DouyinActivity[]> {
    this.logger.info('开始采集抖音活动列表...');

    const data = await this.callCli<
      Array<{
        activity_id?: string;
        title?: string;
        activity_name?: string;
        end_time?: string;
      }>
    >({
      site: 'douyin',
      command: 'activities',
    });

    if (!data) {
      this.logger.error('获取活动列表失败');
      return [];
    }

    return data.map((item) => ({
      activityId: item.activity_id || '',
      title: item.title || item.activity_name || '',
      endTime: item.end_time || '',
    }));
  }

  /**
   * 获取合集列表
   */
  async collectCollections(): Promise<DouyinCollection[]> {
    this.logger.info('开始采集抖音合集列表...');

    const data = await this.callCli<
      Array<{
        mix_id?: string;
        mix_name?: string;
        video_count?: number;
      }>
    >({
      site: 'douyin',
      command: 'collections',
    });

    if (!data) {
      this.logger.error('获取合集列表失败');
      return [];
    }

    return data.map((item) => ({
      mixId: item.mix_id || '',
      mixName: item.mix_name || '',
      videoCount: item.video_count || 0,
    }));
  }

  /**
   * 获取作品数据分析
   */
  async collectVideoStats(awemeId: string): Promise<DouyinVideoStats | null> {
    this.logger.info(`开始采集作品数据分析: ${awemeId}`);

    const data = await this.callCli<
      Array<{
        metric?: string;
        value?: number;
      }>
    >({
      site: 'douyin',
      command: 'stats',
      args: { aweme_id: awemeId },
    });

    if (!data) {
      this.logger.error('获取作品数据分析失败');
      return null;
    }

    const stats: DouyinVideoStats = {
      awemeId,
      playCount: 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
    };

    for (const item of data) {
      switch (item.metric) {
        case 'play_count':
          stats.playCount = item.value || 0;
          break;
        case 'like_count':
          stats.likeCount = item.value || 0;
          break;
        case 'comment_count':
          stats.commentCount = item.value || 0;
          break;
        case 'share_count':
          stats.shareCount = item.value || 0;
          break;
      }
    }

    this.logger.info('作品数据分析采集完成');
    return stats;
  }

  /**
   * 获取草稿列表
   */
  async collectDrafts(): Promise<DouyinVideoData[]> {
    this.logger.info('开始采集抖音草稿列表...');

    const data = await this.callCli<
      Array<{
        aweme_id?: string;
        desc?: string;
        create_time?: number;
      }>
    >({
      site: 'douyin',
      command: 'drafts',
    });

    if (!data) {
      this.logger.error('获取草稿列表失败');
      return [];
    }

    return data.map((item) => ({
      awemeId: item.aweme_id || '',
      desc: item.desc || '',
      status: 'draft',
      createTime: item.create_time,
      statistics: { playCount: 0, diggCount: 0, commentCount: 0, shareCount: 0 },
    }));
  }

  /**
   * 搜索地理位置
   */
  async searchLocation(keyword: string): Promise<Array<{ poiId: string; poiName: string }>> {
    this.logger.info(`搜索地理位置: ${keyword}`);

    const data = await this.callCli<
      Array<{
        poi_id?: string;
        poi_name?: string;
      }>
    >({
      site: 'douyin',
      command: 'location',
      args: { keyword },
    });

    if (!data) {
      this.logger.error('搜索地理位置失败');
      return [];
    }

    return data.map((item) => ({
      poiId: item.poi_id || '',
      poiName: item.poi_name || '',
    }));
  }

  /**
   * 获取账号历史数据
   */
  getAccountHistory(days: number = 7): DouyinAccountSnapshot[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.accountHistory.filter((s) => s.timestamp >= cutoff);
  }

  /**
   * 获取最新热点数据
   */
  getLatestHotspots(): DouyinHotData | null {
    return this.hotHistory[this.hotHistory.length - 1] || null;
  }

  /**
   * 加载历史数据
   */
  private loadHistory(): void {
    const accountFile = path.join(this.dataDir, 'douyin-account-history.json');
    const hotFile = path.join(this.dataDir, 'douyin-hot-history.json');

    try {
      if (fs.existsSync(accountFile)) {
        this.accountHistory = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
        this.logger.info(`加载账号历史数据: ${this.accountHistory.length} 条`);
      }

      if (fs.existsSync(hotFile)) {
        this.hotHistory = JSON.parse(fs.readFileSync(hotFile, 'utf-8'));
        this.logger.info(`加载热点历史数据: ${this.hotHistory.length} 条`);
      }
    } catch (err) {
      this.logger.error('加载历史数据失败', (err as Error).message);
    }
  }

  /**
   * 保存历史数据
   */
  private saveHistory(): void {
    const accountFile = path.join(this.dataDir, 'douyin-account-history.json');
    const hotFile = path.join(this.dataDir, 'douyin-hot-history.json');

    try {
      // 只保留最近 30 天的数据
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      this.accountHistory = this.accountHistory.filter((s) => s.timestamp >= cutoff);
      this.hotHistory = this.hotHistory.filter((h) => h.timestamp >= cutoff);

      fs.writeFileSync(accountFile, JSON.stringify(this.accountHistory, null, 2));
      fs.writeFileSync(hotFile, JSON.stringify(this.hotHistory, null, 2));
    } catch (err) {
      this.logger.error('保存历史数据失败', (err as Error).message);
    }
  }
}
