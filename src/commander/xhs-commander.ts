/**
 * 小红书运营指挥官 - 主控制器
 *
 * 整合数据采集、策略分析、任务生成，提供统一的运营接口
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { LLMConfig, PlatformConfig } from '../core/config.js';
import type { AgentEngine } from '../agent/agent-engine.js';
import { XhsDataCollector } from './xhs-data-collector.js';
import { XhsStrategyEngine } from './xhs-strategy-engine.js';
import { XhsTaskGenerator, XHS_PRESET_TEMPLATES } from './xhs-task-generator.js';
import type {
  XhsCommanderConfig,
  XhsOperationStrategy,
  XhsAutoTaskDef,
  XhsDailyReport,
  XhsAccountSnapshot,
  XhsHotFeed,
} from './xhs-types.js';
import type { RecurringTaskScheduler } from '../scheduler/recurring-task-scheduler.js';
import * as path from 'path';
import * as fs from 'fs';

/** 指挥官状态 */
interface XhsCommanderState {
  /** 是否已启动 */
  isRunning: boolean;
  /** 上次数据采集时间 */
  lastCollection: number;
  /** 上次策略分析时间 */
  lastAnalysis: number;
  /** 当前活跃任务数 */
  activeTaskCount: number;
  /** 今日已发布数 */
  todayPostCount: number;
  /** 今日已回复数 */
  todayReplyCount: number;
}

export class XhsCommander {
  private logger: Logger;
  private config: XhsCommanderConfig;
  private platformConfig: PlatformConfig;
  private llmConfig: LLMConfig;
  private dataCollector: XhsDataCollector;
  private strategyEngine: XhsStrategyEngine;
  private taskGenerator: XhsTaskGenerator;
  private scheduler: RecurringTaskScheduler | null = null;
  private agentEngine: AgentEngine | null = null;
  private state: XhsCommanderState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentStrategy: XhsOperationStrategy | null = null;

  constructor(
    config: XhsCommanderConfig,
    platformConfig: PlatformConfig,
    llmConfig: LLMConfig,
  ) {
    this.config = config;
    this.platformConfig = platformConfig;
    this.llmConfig = llmConfig;
    this.logger = createLogger('XhsCommander');

    // 初始化数据目录
    const dataDir = config.dataDir || path.join(process.cwd(), 'data', 'xhs-commander');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 初始化子模块
    this.dataCollector = new XhsDataCollector(
      platformConfig.apiUrl || 'https://www.miniabc.top',
      config.ownerId,
      dataDir
    );

    this.strategyEngine = new XhsStrategyEngine(
      { llmConfig },
      this.dataCollector
    );

    this.taskGenerator = new XhsTaskGenerator({
      maxPostsPerDay: config.automation.maxPostsPerDay,
      maxRepliesPerDay: config.automation.maxRepliesPerDay,
      requireConfirmation: config.automation.requireConfirmation,
    });

    // 初始化状态
    this.state = {
      isRunning: false,
      lastCollection: 0,
      lastAnalysis: 0,
      activeTaskCount: 0,
      todayPostCount: 0,
      todayReplyCount: 0,
    };

    this.logger.info('小红书运营指挥官已初始化');
  }

  /**
   * 设置 AgentEngine（用于执行任务）
   */
  setAgentEngine(engine: AgentEngine): void {
    this.agentEngine = engine;
  }

  /**
   * 设置任务调度器
   */
  setRecurringTaskScheduler(scheduler: RecurringTaskScheduler): void {
    this.scheduler = scheduler;
  }

  /**
   * 绑定调度器和 Agent 引擎
   */
  attachSchedulerAndEngine(scheduler: RecurringTaskScheduler, agentEngine: AgentEngine): void {
    this.scheduler = scheduler;
    this.agentEngine = agentEngine;
    this.logger.info('已绑定调度器和 Agent 引擎');
  }

  /**
   * 启动指挥官
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      this.logger.warn('指挥官已在运行中');
      return;
    }

    this.state.isRunning = true;
    this.logger.info('小红书运营指挥官启动中...');

    // 注册模板任务
    if (this.scheduler) {
      await this.registerTemplateTasks();
    }

    // 启动定时采集
    const collectionInterval = this.config.collection.intervalMs || 30 * 60 * 1000;
    this.timer = setInterval(async () => {
      await this.runCollection();
    }, collectionInterval);

    // 立即执行一次采集
    await this.runCollection();

    this.logger.info('小红书运营指挥官已启动');
  }

  /**
   * 停止指挥官
   */
  async stop(): Promise<void> {
    if (!this.state.isRunning) {
      return;
    }

    this.state.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.logger.info('小红书运营指挥官已停止');
  }

  /**
   * 手动触发数据采集
   */
  async manualCollect(): Promise<{
    snapshot: XhsAccountSnapshot | null;
    hotFeed: XhsHotFeed | null;
  }> {
    this.logger.info('手动触发数据采集...');

    const snapshot = await this.dataCollector.collectAccountSnapshot();
    const hotFeed = await this.dataCollector.collectHotFeed(20);

    this.state.lastCollection = Date.now();

    return { snapshot, hotFeed };
  }

  /**
   * 手动触发策略分析
   */
  async manualAnalyze(): Promise<XhsOperationStrategy | null> {
    this.logger.info('手动触发策略分析...');

    try {
      const strategy = await this.strategyEngine.analyze();
      this.currentStrategy = strategy;
      this.state.lastAnalysis = Date.now();

      // 生成动态任务
      if (this.scheduler) {
        const dynamicTasks = this.taskGenerator.generateDynamicTasks(strategy);
        for (const task of dynamicTasks) {
          this.scheduler.addTask({
            id: task.id,
            type: task.type,
            prompt: task.prompt,
            schedule: task.schedule,
            enabled: task.enabled,
            source: task.source,
            maxPerDay: task.maxPerDay,
            maxPerHour: task.maxPerHour,
          });
        }
        this.logger.info(`已添加 ${dynamicTasks.length} 个动态任务`);
      }

      return strategy;
    } catch (err) {
      this.logger.error('策略分析失败', (err as Error).message);
      return null;
    }
  }

  /**
   * 获取当前状态
   */
  getStatus(): XhsCommanderState & {
    config: XhsCommanderConfig;
    currentStrategy: XhsOperationStrategy | null;
  } {
    return {
      ...this.state,
      config: this.config,
      currentStrategy: this.currentStrategy,
    };
  }

  /**
   * 获取最新热门推荐
   */
  getLatestHotFeed(): XhsHotFeed | null {
    return this.dataCollector.getLatestHotFeed();
  }

  /**
   * 获取账号历史数据
   */
  getAccountTrend(days: number = 7): XhsAccountSnapshot[] {
    return this.dataCollector.getAccountHistory(days);
  }

  /**
   * 获取可用模板
   */
  getAvailableTemplates() {
    return XHS_PRESET_TEMPLATES.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      scenario: t.scenario,
      taskCount: t.tasks.length,
    }));
  }

  /**
   * 切换运营模板
   */
  switchTemplate(templateId: string): { success: boolean; error?: string } {
    const template = this.taskGenerator.getTemplate(templateId);
    if (!template) {
      return { success: false, error: `模板 ${templateId} 不存在` };
    }

    this.config.templateId = templateId;
    this.logger.info(`已切换到模板: ${template.name}`);

    // 需要重启指挥官才能生效
    return { success: true };
  }

  /**
   * 添加自定义任务
   */
  addCustomTask(task: XhsAutoTaskDef): { success: boolean; error?: string } {
    if (!this.scheduler) {
      return { success: false, error: '调度器未初始化' };
    }

    this.scheduler.addTask({
      id: task.id,
      type: task.type,
      prompt: task.prompt,
      schedule: task.schedule,
      enabled: task.enabled,
      source: 'dynamic', // 自定义任务标记为动态任务（会被持久化）
      maxPerDay: task.maxPerDay,
      maxPerHour: task.maxPerHour,
    });

    this.logger.info(`已添加自定义任务: ${task.id}`);
    return { success: true };
  }

  /**
   * 生成日报
   */
  generateDailyReport(): XhsDailyReport {
    const today = new Date().toISOString().slice(0, 10);
    const history = this.dataCollector.getAccountHistory(1);
    const latest = history[history.length - 1];

    return {
      date: today,
      followerChange: latest?.newFollowersToday || 0,
      notesCount: latest?.notesToday || 0,
      totalInteractions: latest?.interactionsToday || 0,
      interactionBreakdown: {
        views: 0,
        likes: latest?.interactionsToday || 0,
        collects: 0,
        comments: 0,
      },
      completedTasks: this.state.todayPostCount + this.state.todayReplyCount,
      topNotes: [],
    };
  }

  /**
   * 注册模板任务
   */
  private async registerTemplateTasks(): Promise<void> {
    if (!this.scheduler) {
      return;
    }

    const templateId = this.config.templateId || 'standard';
    const template = this.taskGenerator.getTemplate(templateId);

    if (!template) {
      this.logger.warn(`模板 ${templateId} 不存在，使用默认任务`);
      return;
    }

    this.logger.info(`注册模板任务: ${template.name}`);

    for (const task of template.tasks) {
      this.scheduler.addTask({
        id: task.id,
        type: task.type,
        prompt: task.prompt,
        schedule: task.schedule,
        enabled: task.enabled,
        source: 'template', // 模板任务不持久化
        maxPerDay: task.maxPerDay,
        maxPerHour: task.maxPerHour,
      });
    }

    this.state.activeTaskCount = template.tasks.length;
    this.logger.info(`已注册 ${template.tasks.length} 个模板任务`);
  }

  /**
   * 运行数据采集
   */
  private async runCollection(): Promise<void> {
    this.logger.info('执行定时数据采集...');

    try {
      // 采集账号数据
      await this.dataCollector.collectAccountSnapshot();

      // 采集热门推荐（如果配置了）
      if (this.config.collection.collectHotFeed) {
        await this.dataCollector.collectHotFeed(20);
      }

      this.state.lastCollection = Date.now();
      this.logger.info('数据采集完成');
    } catch (err) {
      this.logger.error('数据采集失败', (err as Error).message);
    }
  }
}
