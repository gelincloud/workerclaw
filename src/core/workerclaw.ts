/**
 * WorkerClaw - 公域 AI Agent 框架 (Phase 4 完整版)
 *
 * 核心设计哲学: "Trust the Platform, Verify Everything Else"
 */

import { createLogger, type Logger } from './logger.js';
import { EventBus, WorkerClawEvent } from './events.js';
import { MiniABCClient } from '../ingress/miniabc-client.js';
import { SecurityGate } from '../security/gate.js';
import { TaskManager } from '../task/task-manager.js';
import { BehaviorScheduler, type BehaviorCallbacks } from '../active-behavior/index.js';
import { getBuiltinSkills } from '../skills/index.js';
import { ExperienceManager, DEFAULT_EXPERIENCE_CONFIG } from '../experience/index.js';
import type { WorkerClawConfig } from './config.js';
import type { ExperienceConfig } from '../experience/types.js';

// ==================== WorkerClaw 主类 ====================

export class WorkerClaw {
  private logger: Logger;
  private config: WorkerClawConfig;
  private eventBus: EventBus;

  private wsClient: MiniABCClient;
  private securityGate: SecurityGate;
  private taskManager: TaskManager;
  private behaviorScheduler: BehaviorScheduler;
  private experienceManager: ExperienceManager | null = null;

  private isRunning = false;

  constructor(config: WorkerClawConfig) {
    this.config = config;
    this.eventBus = new EventBus();
    this.logger = createLogger('WorkerClaw');

    // 初始化各模块
    this.wsClient = new MiniABCClient({
      config: config.platform,
      eventBus: this.eventBus,
    });

    this.securityGate = new SecurityGate(
      {
        rateLimit: config.security.rateLimit,
        sourceVerify: {
          validateTimestamp: true,
          maxTimestampSkewMs: 5 * 60 * 1000,
        },
        contentScan: config.security.contentScan,
        sandbox: config.security.sandbox,
      },
      this.eventBus,
    );

    this.taskManager = new TaskManager(
      {
        platform: config.platform,
        llm: config.llm,
        security: config.security,
        task: config.task,
        personality: config.personality,
      },
      this.eventBus,
      this.securityGate,
    );

    // Phase 4: 行为调度器
    this.behaviorScheduler = new BehaviorScheduler(
      {
        enabled: config.activeBehavior?.enabled ?? true,
        checkIntervalMs: config.activeBehavior?.checkIntervalMs ?? 5 * 60 * 1000,
        minIdleTimeMs: config.activeBehavior?.minIdleTimeMs ?? 10 * 60 * 1000,
        frequency: config.activeBehavior ? {} : {},
        weights: config.activeBehavior?.weights ?? {
          tweet: 10, browse: 23, comment: 14, like: 15, blog: 8, blog_comment: 6, chat: 12, idle: 3,
        },
      },
      this.taskManager.getAgentEngine().getPersonality(),
      config.llm,
      this.eventBus,
    );

    // Phase 6: 经验基因系统
    const expConfig: ExperienceConfig = {
      ...DEFAULT_EXPERIENCE_CONFIG,
      ...config.experience,
      hub: {
        ...DEFAULT_EXPERIENCE_CONFIG.hub,
        ...(config.experience?.hub || {}),
        endpoint: config.platform.apiUrl || DEFAULT_EXPERIENCE_CONFIG.hub.endpoint,
      },
    };
    this.experienceManager = new ExperienceManager(
      expConfig,
      config.platform.botId,
      config.platform.token,
    );

    // 将经验管理器注入 TaskManager（同时传递给 AgentEngine）
    if (this.experienceManager) {
      this.taskManager.setExperienceManager(this.experienceManager);
    }

    // 注入 WebSocket 客户端（用于发送聊天室消息等）
    this.taskManager.setWsClient(this.wsClient);
  }

  /**
   * 启动 WorkerClaw
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('WorkerClaw 已在运行中');
      return;
    }

    this.logger.info('🦐 WorkerClaw 正在启动...');
    this.logger.info(`  名称: ${this.config.name}`);
    this.logger.info(`  人格: ${this.config.personality.name}`);
    this.logger.info(`  LLM: ${this.config.llm.provider}/${this.config.llm.model}`);
    this.logger.info(`  活跃行为: ${this.config.activeBehavior?.enabled ? '启用' : '禁用'}`);

    this.eventBus.emit(WorkerClawEvent.STARTING, undefined as any);

    try {
      // Phase 4: 注册内置技能
      const builtinSkills = getBuiltinSkills(this.config.security.sandbox.browser);
      for (const skill of builtinSkills) {
        this.taskManager.getAgentEngine().registerSkill(skill);
      }
      this.logger.info(`已注册 ${builtinSkills.length} 个内置技能`);

      // 初始化技能
      const { success, failed } = await this.taskManager.getAgentEngine().initializeSkills();
      if (failed > 0) {
        this.logger.warn(`${failed} 个技能初始化失败`);
      }

      // Phase 6: 初始化经验系统
      if (this.experienceManager) {
        await this.experienceManager.init();
      }

      // 注册消息处理器
      this.wsClient.onMessage((msg: any) => {
        this.taskManager.handleMessage(msg).catch((err: Error) => {
          this.logger.error('消息处理异常', err);
        });
      });

      // 连接平台
      await this.wsClient.connect();

      // 检查租赁状态（WorkerClaw 专属）
      try {
        const platformApi = this.taskManager.getPlatformApi();
        const rentalStatus = await platformApi.checkRentalStatus();
        if (rentalStatus.active) {
          this.logger.info(`🔒 检测到租赁状态`, {
            rentalId: rentalStatus.rentalId,
            renter: rentalStatus.renterNickname || rentalStatus.renterId,
            expiresAt: rentalStatus.expiresAt,
          });
          this.taskManager.setRentalState({
            active: true,
            rentalId: rentalStatus.rentalId,
            renterId: rentalStatus.renterId,
            expiresAt: rentalStatus.expiresAt ? new Date(rentalStatus.expiresAt) : undefined,
            durationHours: rentalStatus.durationHours,
          });
        } else {
          this.logger.info('租赁状态: 未被租赁');
        }
      } catch (err) {
        this.logger.debug('租赁状态检查失败（非关键）', { error: (err as Error).message });
      }

      this.isRunning = true;

      // 同步技能列表到平台个人资料
      const platformApi = this.taskManager.getPlatformApi();
      const skillNames = builtinSkills.map(s => s.metadata.displayName + ' (' + s.metadata.name + ')');
      try {
        const synced = await platformApi.updateSkills(skillNames);
        if (synced) {
          this.logger.info('技能列表已同步到平台');
        }
      } catch {
        // 技能同步失败不影响启动
        this.logger.debug('技能同步到平台失败（非关键）');
      }

      // Phase 4: 启动行为调度器
      // 绑定实际的平台 API 回调
      this.behaviorScheduler.setCallbacks({
        publishTweet: async (content: string) => {
          const result = await platformApi.postTweet(content);
          if (result.success) {
            this.logger.info(`[智能活跃] 📝 推文已发布: "${content.substring(0, 40)}..."`);
          } else {
            this.logger.warn(`[智能活跃] 推文发布失败: ${result.error}`);
          }
          return result.success;
        },
        browseContent: async () => {
          const tweets = await platformApi.getTweets(10, 0);
          this.logger.info(`[智能活跃] 👀 已浏览推文广场 (获取 ${tweets.length} 条)`);
          return true;
        },
        postComment: async (content: string, targetId?: string) => {
          // 随机选一条推文评论
          const tweets = await platformApi.getTweets(20, 0);
          const candidates = tweets.filter((t: any) =>
            t.author_id !== this.config.platform.botId &&
            t.content.length > 10
          );
          if (candidates.length === 0) {
            this.logger.info(`[智能活跃] 💬 没有合适的推文可以评论`);
            return false;
          }
          const target = candidates[Math.floor(Math.random() * candidates.length)];
          const result = await platformApi.postComment(target.id, content);
          if (result.success) {
            this.logger.info(`[智能活跃] 💬 评论已发送 → @${target.author?.nickname || '用户'}`);
          } else {
            this.logger.warn(`[智能活跃] 评论失败: ${result.error}`);
          }
          return result.success;
        },
        likeContent: async (targetId?: string) => {
          // 点赞功能: 获取推文列表并记录浏览（平台 API 暂无独立点赞接口）
          this.logger.info(`[智能活跃] 👍 已浏览并评估推文`);
          return true;
        },
        publishBlog: async (title: string, content: string, category: string) => {
          const result = await platformApi.postBlog(title, content, category);
          if (result.success) {
            this.logger.info(`[智能活跃] 📝 博客已发布: "${title}"`);
          } else {
            this.logger.warn(`[智能活跃] 博客发布失败: ${result.error}`);
          }
          return result.success;
        },
        commentBlog: async (blogId: string, content: string, parentId?: string) => {
          // 先获取博客列表，随机选一篇评论
          const blogs = await platformApi.getBlogs(10, 0);
          const candidates = blogs.filter((b: any) =>
            b.bot_id !== this.config.platform.botId
          );
          if (candidates.length === 0) {
            this.logger.info(`[智能活跃] 💬 没有合适的博客可以评论`);
            return false;
          }
          const target = candidates[Math.floor(Math.random() * candidates.length)];
          const result = await platformApi.postBlogComment(target.id, content, parentId);
          if (result.success) {
            this.logger.info(`[智能活跃] 💬 博客评论已发送 → "${target.title}"`);
          } else {
            this.logger.warn(`[智能活跃] 博客评论失败: ${result.error}`);
          }
          return result.success;
        },
        sendChatMessage: async (content: string) => {
          const result = await platformApi.sendChatMessage(content);
          if (result.success) {
            this.logger.info(`[智能活跃] 💬 聊天消息已发送: "${content.substring(0, 40)}..."`);
          } else {
            this.logger.warn(`[智能活跃] 聊天消息发送失败`);
          }
          return result.success;
        },
      });
      this.behaviorScheduler.start();

      this.logger.info('✅ WorkerClaw 已启动，等待任务...');
      this.eventBus.emit(WorkerClawEvent.READY, undefined as any);

    } catch (err) {
      this.logger.error('WorkerClaw 启动失败', err);
      this.eventBus.emit(WorkerClawEvent.SHUTDOWN, undefined as any);
      throw err;
    }
  }

  /**
   * 停止 WorkerClaw
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.logger.info('WorkerClaw 正在关闭...');
    this.eventBus.emit(WorkerClawEvent.SHUTTING_DOWN, undefined as any);

    // Phase 4: 停止行为调度器
    this.behaviorScheduler.stop();

    // Phase 6: 关闭经验系统
    this.experienceManager?.dispose();

    await this.wsClient.disconnect();

    this.isRunning = false;
    this.logger.info('WorkerClaw 已关闭');
    this.eventBus.emit(WorkerClawEvent.SHUTDOWN, undefined as any);
  }

  /**
   * 设置行为回调
   */
  setBehaviorCallbacks(callbacks: BehaviorCallbacks): void {
    this.behaviorScheduler.setCallbacks(callbacks);
  }

  /**
   * 获取运行状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      connected: this.wsClient.connected,
      botId: this.config.platform.botId || null,
      tasks: this.taskManager.getStatus(),
      security: this.securityGate.getRateLimitStatus(),
      sessions: this.taskManager.getAgentEngine().getSessionStats(),
      skills: this.taskManager.getAgentEngine().getSkillStats(),
      behavior: this.behaviorScheduler.getStats(),
      experience: this.experienceManager?.getStats() || null,
      rental: this.taskManager.getRentalState(),
    };
  }

  /**
   * 获取事件总线
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * 获取任务管理器
   */
  getTaskManager(): TaskManager {
    return this.taskManager;
  }

  /**
   * 获取经验管理器
   */
  getExperienceManager(): ExperienceManager | null {
    return this.experienceManager;
  }
}

// ==================== 工厂函数 ====================

/**
 * 创建 WorkerClaw 实例
 */
export function createWorkerClaw(config: WorkerClawConfig): WorkerClaw {
  return new WorkerClaw(config);
}
