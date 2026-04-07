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
import { RecurringTaskScheduler, DEFAULT_SCHEDULER_CONFIG } from '../scheduler/index.js';
import { WeiboCommander, XhsCommander } from '../commander/index.js';
import { DouyinCommander } from '../commander/douyin-commander.js';
import { ZhihuCommander } from '../commander/zhihu-commander.js';
import type { WorkerClawConfig } from './config.js';
import type { ExperienceConfig } from '../experience/types.js';
import type { RecurringTaskSchedulerConfig } from '../scheduler/recurring-task-scheduler.js';
import type { WeiboCommanderConfig } from '../commander/types.js';
import type { XhsCommanderConfig } from '../commander/xhs-types.js';
import type { DouyinCommanderConfig } from '../commander/douyin-types.js';
import type { ZhihuCommanderConfig, ZhihuAutoTaskDef } from '../commander/zhihu-types.js';

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
  private recurringTaskScheduler: RecurringTaskScheduler | null = null;
  private weiboCommander: WeiboCommander | null = null;
  private xhsCommander: XhsCommander | null = null;
  private douyinCommander: DouyinCommander | null = null;
  private zhihuCommander: ZhihuCommander | null = null;

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
        mode: config.mode,
        // ownerId 来源优先级：顶层 ownerId > weiboCommander.ownerId > platform.ownerId
        ownerId: (config as any).ownerId
          || (config as any).weiboCommander?.ownerId
          || (config.platform as any)?.ownerId,
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
          tweet: 10, browse: 20, browse_blog: 10, comment: 14, like: 15, blog: 8, blog_comment: 6, chat: 12, game: 5, idle: 3,
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

    // 定时任务调度器（私有虾专用）
    // 私有虾模式下自动创建调度器实例，允许主人通过私信动态添加定时任务
    // 公域模式下仅在显式配置 recurringTasks.enabled=true 时创建
    const recurringConfig = config.recurringTasks;
    const isPrivateShrimp = config.mode === 'private';
    const shouldCreateScheduler = isPrivateShrimp || (recurringConfig && recurringConfig.enabled);

    if (shouldCreateScheduler) {
      const schedulerConfig: RecurringTaskSchedulerConfig = {
        ...DEFAULT_SCHEDULER_CONFIG,
        enabled: true, // 私有虾默认启用；公域继承用户配置
        ...recurringConfig,
        tasks: recurringConfig?.tasks || [],
      };
      this.recurringTaskScheduler = new RecurringTaskScheduler(schedulerConfig, config.llm);
      this.recurringTaskScheduler.setAgentEngine(this.taskManager.getAgentEngine());
      // 注入到 TaskManager 供主人指令使用
      this.taskManager.setRecurringTaskScheduler(this.recurringTaskScheduler);
    }

    // 注入 WebSocket 客户端（用于发送聊天室消息等）
    this.taskManager.setWsClient(this.wsClient);
  }

  /**
   * 初始化微博运营指挥官（异步方法）
   * 需要在 start() 中调用
   */
  private async initializeWeiboCommander(): Promise<void> {
    const config = this.config;
    
    // 私有虾模式下，如果配置了 weiboCommander.enabled，则自动启动指挥官
    if (!config.weiboCommander?.enabled || config.mode !== 'private') {
      return;
    }

    // 自动获取 ownerId（优先级：配置 → 绑定关系查询）
    let ownerId = config.weiboCommander.ownerId || (config as any).ownerId || '';
    
    if (!ownerId && config.platform.botId) {
      // 配置中没有 ownerId，尝试通过 botId 查询绑定关系
      this.logger.info('配置中缺少 ownerId，尝试通过 botId 查询绑定关系...');
      const resolved = await import('../commander/data-collector.js').then(m => 
        m.DataCollector.resolveOwnerId(config.platform.apiUrl || 'https://www.miniabc.top', config.platform.botId)
      );
      if (resolved) {
        ownerId = resolved.ownerId;
        this.logger.info(`已通过 botId 获取 ownerId: ${ownerId}`);
      } else {
        this.logger.error('无法获取 ownerId，WeiboCommander 启动失败');
        return;
      }
    }

    const weiboConfig: WeiboCommanderConfig = {
      enabled: true,
      ownerId: ownerId,
      platformApiUrl: config.platform.apiUrl || 'https://www.miniabc.top',
      collection: {
        intervalMs: config.weiboCommander.collection?.intervalMs || 30 * 60 * 1000,
        trendingIntervalMs: 60 * 60 * 1000,
        historyRetentionDays: 30,
        collectTrending: true,
        collectInteractions: true,
      },
      automation: {
        autoPost: true,
        autoReply: true,
        autoFollow: false,
        maxPostsPerDay: config.weiboCommander.automation?.maxPostsPerDay || 4,
        maxRepliesPerDay: config.weiboCommander.automation?.maxRepliesPerDay || 20,
        minFollowerToReply: 100,
        requireConfirmation: config.weiboCommander.automation?.requireConfirmation ?? false,
      },
      templateId: config.weiboCommander.templateId || 'standard',
    };
    
    this.weiboCommander = new WeiboCommander(
      weiboConfig,
      config.platform,
      config.llm,
    );
    
    // 注入 AgentEngine 供指挥官调用
    this.weiboCommander.setAgentEngine(this.taskManager.getAgentEngine());

    // 将指挥官的定时任务注入调度器
    if (this.recurringTaskScheduler) {
      this.weiboCommander.setRecurringTaskScheduler(this.recurringTaskScheduler);
    }
  }

  /**
   * 初始化小红书运营指挥官（异步方法）
   * 需要在 start() 中调用
   */
  private async initializeXhsCommander(): Promise<void> {
    const config = this.config;

    // 私有虾模式下，如果配置了 xhsCommander.enabled，则自动启动指挥官
    if (!config.xhsCommander?.enabled || config.mode !== 'private') {
      return;
    }

    // 自动获取 ownerId（优先级：配置 → 绑定关系查询）
    let ownerId = config.xhsCommander.ownerId || (config as any).ownerId || '';

    if (!ownerId && config.platform.botId) {
      // 配置中没有 ownerId，尝试通过 botId 查询绑定关系
      this.logger.info('[XhsCommander] 配置中缺少 ownerId，尝试通过 botId 查询绑定关系...');
      const resolved = await import('../commander/data-collector.js').then(m =>
        m.DataCollector.resolveOwnerId(config.platform.apiUrl || 'https://www.miniabc.top', config.platform.botId)
      );
      if (resolved) {
        ownerId = resolved.ownerId;
        this.logger.info(`[XhsCommander] 已通过 botId 获取 ownerId: ${ownerId}`);
      } else {
        this.logger.error('[XhsCommander] 无法获取 ownerId，XhsCommander 启动失败');
        return;
      }
    }

    const xhsConfig: XhsCommanderConfig = {
      enabled: true,
      ownerId: ownerId,
      platformApiUrl: config.platform.apiUrl || 'https://www.miniabc.top',
      collection: {
        intervalMs: config.xhsCommander.collection?.intervalMs || 30 * 60 * 1000,
        hotFeedIntervalMs: 60 * 60 * 1000,
        historyRetentionDays: 30,
        collectHotFeed: config.xhsCommander.collection?.collectHotFeed ?? true,
        collectInteractions: config.xhsCommander.collection?.collectInteractions ?? true,
      },
      automation: {
        autoPost: config.xhsCommander.automation?.autoPost ?? true,
        autoReply: config.xhsCommander.automation?.autoReply ?? true,
        autoFollow: config.xhsCommander.automation?.autoFollow ?? false,
        maxPostsPerDay: config.xhsCommander.automation?.maxPostsPerDay || 4,
        maxRepliesPerDay: config.xhsCommander.automation?.maxRepliesPerDay || 20,
        requireConfirmation: config.xhsCommander.automation?.requireConfirmation ?? false,
      },
      templateId: config.xhsCommander.templateId || 'standard',
    };

    this.xhsCommander = new XhsCommander(
      xhsConfig,
      config.platform,
      config.llm,
    );

    // 注入 AgentEngine 供指挥官调用
    this.xhsCommander.setAgentEngine(this.taskManager.getAgentEngine());

    // 将指挥官的定时任务注入调度器
    if (this.recurringTaskScheduler) {
      this.xhsCommander.setRecurringTaskScheduler(this.recurringTaskScheduler);
    }
  }

  /**
   * 初始化抖音运营指挥官
   */
  private async initializeDouyinCommander(): Promise<void> {
    const config = this.config;

    // 私有虾模式下，如果配置了 douyinCommander.enabled，则自动启动指挥官
    if (!config.douyinCommander?.enabled || config.mode !== 'private') {
      return;
    }

    // 自动获取 ownerId（优先级：配置 → 绑定关系查询）
    let ownerId = config.douyinCommander.ownerId || (config as any).ownerId || '';

    if (!ownerId && config.platform.botId) {
      // 配置中没有 ownerId，尝试通过 botId 查询绑定关系
      this.logger.info('[DouyinCommander] 配置中缺少 ownerId，尝试通过 botId 查询绑定关系...');
      const resolved = await import('../commander/data-collector.js').then(m =>
        m.DataCollector.resolveOwnerId(config.platform.apiUrl || 'https://www.miniabc.top', config.platform.botId)
      );
      if (resolved) {
        ownerId = resolved.ownerId;
        this.logger.info(`[DouyinCommander] 已通过 botId 获取 ownerId: ${ownerId}`);
      } else {
        this.logger.error('[DouyinCommander] 无法获取 ownerId，DouyinCommander 启动失败');
        return;
      }
    }

    const douyinConfig: DouyinCommanderConfig = {
      enabled: true,
      ownerId: ownerId || undefined,
      platformApiUrl: config.platform.apiUrl || 'https://www.miniabc.top',
      collection: {
        intervalMs: config.douyinCommander?.collection?.intervalMs || 30 * 60 * 1000,
        collectTrending: config.douyinCommander?.collection?.collectTrending !== false,
        collectVideos: config.douyinCommander?.collection?.collectVideos !== false,
      },
      automation: {
        autoPost: config.douyinCommander?.automation?.autoPost !== false,
        autoReply: config.douyinCommander?.automation?.autoReply !== false,
        maxPostsPerDay: config.douyinCommander?.automation?.maxPostsPerDay || 3,
        maxRepliesPerDay: config.douyinCommander?.automation?.maxRepliesPerDay || 20,
        requireConfirmation: config.douyinCommander?.automation?.requireConfirmation !== false,
      },
      templateId: config.douyinCommander?.templateId || 'standard',
      dataDir: config.douyinCommander?.dataDir,
    };

    this.douyinCommander = new DouyinCommander(
      douyinConfig,
      config.platform,
      config.llm
    );

    this.logger.info('[DouyinCommander] 抖音运营指挥官已初始化');

    // 启动指挥官
    await this.douyinCommander.start();
    this.logger.info('[DouyinCommander] 抖音运营指挥官已启动');

    // 注入 AgentEngine 供指挥官调用
    this.douyinCommander.setAgentEngine(this.taskManager.getAgentEngine());

    // 将指挥官的定时任务注入调度器
    if (this.recurringTaskScheduler) {
      this.douyinCommander.setRecurringTaskScheduler(this.recurringTaskScheduler);
    }
  }

  /**
   * 初始化知乎运营指挥官
   */
  private async initializeZhihuCommander(): Promise<void> {
    const config = this.config;

    // 私有虾模式下，如果配置了 zhihuCommander.enabled，则自动启动指挥官
    if (!config.zhihuCommander?.enabled || config.mode !== 'private') {
      return;
    }

    // 自动获取 ownerId（优先级：配置 → 绑定关系查询）
    let ownerId = config.zhihuCommander.ownerId || (config as any).ownerId || '';

    if (!ownerId && config.platform.botId) {
      // 配置中没有 ownerId，尝试通过 botId 查询绑定关系
      this.logger.info('[ZhihuCommander] 配置中缺少 ownerId，尝试通过 botId 查询绑定关系...');
      const resolved = await import('../commander/data-collector.js').then(m =>
        m.DataCollector.resolveOwnerId(config.platform.apiUrl || 'https://www.miniabc.top', config.platform.botId)
      );
      if (resolved) {
        ownerId = resolved.ownerId;
        this.logger.info(`[ZhihuCommander] 已通过 botId 获取 ownerId: ${ownerId}`);
      } else {
        this.logger.error('[ZhihuCommander] 无法获取 ownerId，ZhihuCommander 启动失败');
        return;
      }
    }

    const zhihuConfig: ZhihuCommanderConfig = {
      enabled: true,
      ownerId: ownerId || undefined,
      platformApiUrl: config.platform.apiUrl || 'https://www.miniabc.top',
      collection: {
        intervalMs: config.zhihuCommander?.collection?.intervalMs || 30 * 60 * 1000,
        hotIntervalMs: config.zhihuCommander?.collection?.hotIntervalMs || 60 * 60 * 1000,
        historyRetentionDays: config.zhihuCommander?.collection?.historyRetentionDays || 30,
        collectHot: config.zhihuCommander?.collection?.collectHot !== false,
        collectInteractions: config.zhihuCommander?.collection?.collectInteractions !== false,
      },
      automation: {
        autoPostArticle: config.zhihuCommander?.automation?.autoPostArticle !== false,
        autoPostAnswer: config.zhihuCommander?.automation?.autoPostAnswer !== false,
        autoReply: config.zhihuCommander?.automation?.autoReply !== false,
        maxArticlesPerDay: config.zhihuCommander?.automation?.maxArticlesPerDay || 2,
        maxAnswersPerDay: config.zhihuCommander?.automation?.maxAnswersPerDay || 5,
        maxRepliesPerDay: config.zhihuCommander?.automation?.maxRepliesPerDay || 20,
        requireConfirmation: config.zhihuCommander?.automation?.requireConfirmation !== false,
      },
      templateId: config.zhihuCommander?.templateId || 'standard',
      customTasks: config.zhihuCommander?.customTasks as ZhihuAutoTaskDef[] | undefined,
      dataDir: config.zhihuCommander?.dataDir,
    };

    this.zhihuCommander = new ZhihuCommander(
      zhihuConfig,
      config.platform,
      config.llm
    );

    this.logger.info('[ZhihuCommander] 知乎运营指挥官已初始化');

    // 启动指挥官
    await this.zhihuCommander.start();
    this.logger.info('[ZhihuCommander] 知乎运营指挥官已启动');

    // 注入 AgentEngine 供指挥官调用
    this.zhihuCommander.setAgentEngine(this.taskManager.getAgentEngine());

    // 将指挥官的定时任务注入调度器
    if (this.recurringTaskScheduler) {
      this.zhihuCommander.setRecurringTaskScheduler(this.recurringTaskScheduler);
    }
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
    this.logger.info(`  模式: ${this.config.mode === 'private' ? '🔒 私有' : '🌐 公有'}`);
    this.logger.info(`  人格: ${this.config.personality.name}`);
    this.logger.info(`  LLM: ${this.config.llm.provider}/${this.config.llm.model}`);
    this.logger.info(`  活跃行为: ${this.config.activeBehavior?.enabled ? '启用' : '禁用'}`);

    this.eventBus.emit(WorkerClawEvent.STARTING, undefined as any);

    try {
      // Phase 4: 注册内置技能
      const builtinSkills = getBuiltinSkills(
        this.config.security.sandbox.browser,
        this.config.whatsapp,
        this.config.enterprise,
      );
      for (const skill of builtinSkills) {
        this.taskManager.getAgentEngine().registerSkill(skill);
      }
      this.logger.info(`已注册 ${builtinSkills.length} 个内置技能`);

      // 初始化技能
      const { success, failed } = await this.taskManager.getAgentEngine().initializeSkills();
      if (failed > 0) {
        this.logger.warn(`${failed} 个技能初始化失败`);
      }

      // WhatsApp 技能：注入 LLM 调用函数（用于自动回复）
      // 注意：技能加载时已经检查过企业版 License，这里再检查一次确保安全
      if (this.config.whatsapp?.enabled && this.config.enterprise?.activated) {
        const whatsappSkill = this.taskManager.getAgentEngine().getSkillRegistry().getSkill('whatsapp');
        if (whatsappSkill && typeof (whatsappSkill as any).setLLMChat === 'function') {
          (whatsappSkill as any).setLLMChat(
            (systemPrompt: string, userMessage: string) =>
              this.taskManager.getAgentEngine().generateReply(systemPrompt, userMessage),
          );
          this.logger.info('WhatsApp 自动回复已启用（LLM 已注入）');
        }
      }

      // Phase 6: 初始化经验系统
      if (this.experienceManager) {
        await this.experienceManager.init();
      }

      // 初始化微博运营指挥官
      await this.initializeWeiboCommander();

      // 初始化小红书运营指挥官
      await this.initializeXhsCommander();

      // 初始化抖音运营指挥官
      await this.initializeDouyinCommander();

      // 初始化知乎运营指挥官
      await this.initializeZhihuCommander();

      // 为 AgentEngine 设置 ownerId（用于 web_cli 工具）
      // 优先级：weiboCommander.ownerId > 通过 botId 查询
      let ownerId = this.config.weiboCommander?.ownerId || (this.config as any).ownerId || '';
      if (!ownerId && this.config.platform.botId) {
        const resolved = await import('../commander/data-collector.js').then(m =>
          m.DataCollector.resolveOwnerId(this.config.platform.apiUrl || 'https://www.miniabc.top', this.config.platform.botId)
        );
        if (resolved) {
          ownerId = resolved.ownerId;
          this.logger.info(`已通过 botId 获取 ownerId: ${ownerId}`);
        }
      }
      if (ownerId) {
        this.taskManager.getAgentEngine().setOwnerId(ownerId);
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
          // 被租用 = 私有虾行为，停止社交活跃
          if (this.behaviorScheduler) {
            this.behaviorScheduler.stop();
            this.logger.info('🔒 租赁模式：智能活跃行为已禁用');
          }
        } else {
          this.logger.info('租赁状态: 未被租赁');
        }
      } catch (err) {
        this.logger.debug('租赁状态检查失败（非关键）', { error: (err as Error).message });
      }

      // 同步已接单但未完成的任务（WorkerClaw 重启后状态恢复）
      try {
        const platformApi = this.taskManager.getPlatformApi();
        const takenTasks = await platformApi.getTakenTasks();
        const stuckTasks = takenTasks.filter(t => t.status === 'taken');

        if (stuckTasks.length > 0) {
          this.logger.info(`📋 发现 ${stuckTasks.length} 个已接单但未完成的任务`);
          for (const task of stuckTasks) {
            this.logger.info(`  - [${task.id}] ${task.content?.substring(0, 50)}... (status: ${task.status})`);
            // 恢复状态机中的任务状态
            this.taskManager.recoverTask(task.id, task);
          }
        }
      } catch (err) {
        this.logger.debug('同步已接单任务失败（非关键）', { error: (err as Error).message });
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
        publishTweet: async (content: string, category?: string) => {
          const result = await platformApi.postTweet(content, category || '日常');
          if (result.success) {
            this.logger.info(`[智能活跃] 📝 推文已发布 [${category || '日常'}]: "${content.substring(0, 40)}..."`);
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
        browseBlogs: async () => {
          const blogs = await platformApi.getBlogs(10, 0);
          // 过滤掉自己的博客，随机选一篇阅读并记录
          const candidates = blogs.filter((b: any) =>
            b.bot_id !== this.config.platform.botId
          );
          if (candidates.length > 0) {
            const target = candidates[Math.floor(Math.random() * candidates.length)];
            // 调用博客详情接口，服务端会在此时增加阅读数
            await platformApi.getBlog(target.id);
            this.logger.info(`[智能活跃] 📖 已阅读博客 → "${target.title}" (by ${target.author?.nickname || '匿名'})`);
          } else {
            this.logger.info(`[智能活跃] 📖 已浏览博客列表 (获取 ${blogs.length} 条)`);
          }
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
          // 如果指定了 blogId，直接评论该博客
          if (blogId) {
            const result = await platformApi.postBlogComment(blogId, content, parentId);
            if (result.success) {
              this.logger.info(`[智能活跃] 💬 博客评论已发送`);
            } else {
              this.logger.warn(`[智能活跃] 博客评论失败: ${result.error}`);
            }
            return result.success;
          }
          // 没有 blogId 时，随机选一篇评论
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
        getBlogsForComment: async () => {
          const blogs = await platformApi.getBlogs(10, 0);
          return blogs
            .filter((b: any) => b.bot_id !== this.config.platform.botId)
            .map((b: any) => ({
              id: b.id,
              title: b.title || '无标题',
              content: b.content || '',
              author: b.author || { nickname: '匿名' },
            }));
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
        getRecentChatHistory: async (maxAgeMs?: number) => {
          const history = this.taskManager.getChatHistory(maxAgeMs);
          return history.map(m => ({
            botId: m.botId,
            nickname: m.nickname,
            content: m.content,
          }));
        },
        publishGame: async (gameType: string, title: string, levelData: string, description: string) => {
          const result = await platformApi.postGame(gameType, title, levelData, description);
          if (result.success) {
            this.logger.info(`[智能活跃] 🎮 游戏已发布: "${title}" (${gameType})`);
          } else {
            this.logger.warn(`[智能活跃] 游戏发布失败: ${result.error}`);
          }
          return result.success;
        },
      });
      this.behaviorScheduler.start();

      // 私有模式（config.mode === 'private'）：跳过社交行为
      if (this.config.mode === 'private') {
        this.behaviorScheduler.stop();
        this.logger.info('🔒 私有模式：智能活跃行为已禁用');
      }

      // 私有虾模式：启动定时任务调度器（替代社交行为）
      if (this.config.mode === 'private' && this.recurringTaskScheduler) {
        this.recurringTaskScheduler.start();
        this.logger.info('⏰ 定时任务调度器已启动（私有虾模式）');
      }

      // 私有虾模式：启动微博运营指挥官
      if (this.weiboCommander) {
        await this.weiboCommander.start();
        this.logger.info('📱 微博运营指挥官已启动');
      }

      // 监听租用状态变化：租用到期后恢复社交行为（仅限原模式为 public 的虾）
      this.eventBus.on(WorkerClawEvent.RENTAL_EXPIRED, () => {
        if (this.config.mode !== 'private' && this.behaviorScheduler) {
          this.behaviorScheduler.start();
          this.logger.info('🔓 租赁结束：智能活跃行为已恢复');
        }
      });

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

    // 停止定时任务调度器
    this.recurringTaskScheduler?.stop();

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
      recurringTasks: this.recurringTaskScheduler?.getStatus() || null,
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

  /**
   * 获取定时任务调度器
   */
  getRecurringTaskScheduler(): RecurringTaskScheduler | null {
    return this.recurringTaskScheduler;
  }
}

// ==================== 工厂函数 ====================

/**
 * 创建 WorkerClaw 实例
 */
export function createWorkerClaw(config: WorkerClawConfig): WorkerClaw {
  return new WorkerClaw(config);
}
