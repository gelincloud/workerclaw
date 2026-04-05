/**
 * 微博运营指挥官 - 主控制器
 *
 * 整合数据采集、策略分析、任务生成，提供统一的运营接口
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { LLMConfig } from '../core/config.js';
import { DataCollector } from './data-collector.js';
import { StrategyEngine } from './strategy-engine.js';
import { TaskGenerator, PRESET_TEMPLATES } from './task-generator.js';
import type { 
  WeiboCommanderConfig,
  OperationStrategy,
  AutoTaskDef,
  DailyReport,
  WeiboAccountSnapshot,
  InteractionData,
  WeiboHotSearch,
} from './types.js';
import type { RecurringTaskScheduler } from '../scheduler/recurring-task-scheduler.js';
import * as path from 'path';
import * as fs from 'fs';

/** 指挥官状态 */
interface CommanderState {
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

export class WeiboCommander {
  private logger: Logger;
  private config: WeiboCommanderConfig;
  private dataCollector: DataCollector;
  private strategyEngine: StrategyEngine;
  private taskGenerator: TaskGenerator;
  private scheduler: RecurringTaskScheduler | null = null;
  private state: CommanderState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentStrategy: OperationStrategy | null = null;

  constructor(
    config: WeiboCommanderConfig,
    llmConfig: LLMConfig,
    scheduler?: RecurringTaskScheduler
  ) {
    this.config = config;
    this.logger = createLogger('WeiboCommander');

    // 初始化数据目录
    const dataDir = config.dataDir || path.join(process.cwd(), 'data', 'weibo-commander');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 初始化子模块
    this.dataCollector = new DataCollector(
      config.platformApiUrl,
      config.ownerId,
      dataDir
    );

    this.strategyEngine = new StrategyEngine(
      { llmConfig },
      this.dataCollector
    );

    this.taskGenerator = new TaskGenerator({
      maxPostsPerDay: config.automation.maxPostsPerDay,
      maxRepliesPerDay: config.automation.maxRepliesPerDay,
      requireConfirmation: config.automation.requireConfirmation,
    });

    if (scheduler) {
      this.scheduler = scheduler;
    }

    // 初始化状态
    this.state = {
      isRunning: false,
      lastCollection: 0,
      lastAnalysis: 0,
      activeTaskCount: 0,
      todayPostCount: 0,
      todayReplyCount: 0,
    };

    this.logger.info('微博运营指挥官已初始化');
  }

  /**
   * 设置任务调度器
   */
  setScheduler(scheduler: RecurringTaskScheduler): void {
    this.scheduler = scheduler;
  }

  /**
   * 启动指挥官
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      this.logger.warn('指挥官已在运行');
      return;
    }

    if (!this.config.enabled) {
      this.logger.warn('指挥官未启用');
      return;
    }

    this.state.isRunning = true;

    // 初始化定时任务
    await this.initializeTasks();

    // 启动监控循环
    const checkInterval = this.config.collection.intervalMs || 30 * 60 * 1000;
    this.timer = setInterval(() => {
      this.tick().catch(err => {
        this.logger.error('指挥官 tick 异常', (err as Error).message);
      });
    }, checkInterval);

    // 立即执行一次
    await this.tick();

    this.logger.info('微博运营指挥官已启动');
  }

  /**
   * 停止指挥官
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state.isRunning = false;
    this.logger.info('微博运营指挥官已停止');
  }

  /**
   * 监控循环
   */
  private async tick(): Promise<void> {
    const now = Date.now();

    // 数据采集
    if (now - this.state.lastCollection >= (this.config.collection.intervalMs || 30 * 60 * 1000)) {
      await this.collectData();
      this.state.lastCollection = now;
    }

    // 策略分析
    if (now - this.state.lastAnalysis >= 60 * 60 * 1000) { // 每小时分析一次
      await this.analyzeAndSchedule();
      this.state.lastAnalysis = now;
    }
  }

  /**
   * 初始化定时任务
   */
  private async initializeTasks(): Promise<void> {
    if (!this.scheduler) {
      this.logger.warn('未设置调度器，无法初始化任务');
      return;
    }

    // 使用指定模板或默认模板
    const templateId = this.config.templateId || 'standard';
    const templateTasks = this.taskGenerator.fromTemplate(templateId);

    // 添加自定义任务
    const customTasks = this.config.customTasks || [];

    // 合并任务
    const allTasks = this.taskGenerator.mergeTasks(templateTasks, customTasks);

    // 注册到调度器
    for (const task of allTasks) {
      if (task.enabled) {
        const result = this.scheduler.addTask({
          id: task.id,
          type: task.type,
          prompt: task.prompt,
          schedule: task.schedule,
          enabled: task.enabled,
          maxPerHour: 1,
          maxPerDay: task.maxPerDay,
          description: `微博运营 - ${task.type}`,
        });

        if (result.success) {
          this.logger.info(`任务已注册: ${task.id} [${task.schedule}]`);
        } else {
          this.logger.warn(`任务注册失败: ${task.id} - ${result.error}`);
        }
      }
    }

    this.state.activeTaskCount = allTasks.filter(t => t.enabled).length;
  }

  /**
   * 数据采集
   */
  private async collectData(): Promise<void> {
    this.logger.info('开始数据采集...');

    try {
      // 采集账号数据
      const snapshot = await this.dataCollector.collectAccountSnapshot();
      if (snapshot) {
        this.logger.info(`粉丝: ${snapshot.followers}, 今日新增: ${snapshot.newFollowersToday}`);
      }

      // 采集热搜（如果启用）
      if (this.config.collection.collectTrending) {
        const trending = await this.dataCollector.collectTrending();
        if (trending) {
          this.logger.info(`热搜采集: ${trending.topics.length} 条`);
        }
      }
    } catch (err) {
      this.logger.error('数据采集异常', (err as Error).message);
    }
  }

  /**
   * 策略分析并调度
   */
  private async analyzeAndSchedule(): Promise<void> {
    this.logger.info('开始策略分析...');

    try {
      const strategy = await this.strategyEngine.analyze();
      this.currentStrategy = strategy;

      // 生成动态任务
      const dynamicTasks = this.taskGenerator.fromStrategy(strategy);

      // 添加到调度器
      if (this.scheduler) {
        for (const task of dynamicTasks.slice(0, 3)) { // 限制动态任务数量
          if (task.enabled) {
            this.scheduler.addTask({
              id: task.id,
              type: task.type,
              prompt: task.prompt,
              schedule: task.schedule,
              enabled: true,
              maxPerHour: 1,
              maxPerDay: task.maxPerDay,
              description: `动态任务 - ${task.type}`,
            });
          }
        }
      }

      this.logger.info(`策略分析完成: ${strategy.contentSuggestions.length} 条内容建议`);
    } catch (err) {
      this.logger.error('策略分析异常', (err as Error).message);
    }
  }

  // ==================== 手动操作接口 ====================

  /**
   * 手动触发数据采集
   */
  async manualCollect(): Promise<{
    snapshot: WeiboAccountSnapshot | null;
    trending: WeiboHotSearch | null;
    interactions: InteractionData | null;
  }> {
    const snapshot = await this.dataCollector.collectAccountSnapshot();
    const trending = this.config.collection.collectTrending 
      ? await this.dataCollector.collectTrending() 
      : null;
    const interactions = this.config.collection.collectInteractions
      ? await this.dataCollector.collectInteractions()
      : null;

    return { snapshot, trending, interactions };
  }

  /**
   * 手动触发策略分析
   */
  async manualAnalyze(): Promise<OperationStrategy | null> {
    return this.strategyEngine.analyze();
  }

  /**
   * 获取当前策略
   */
  getCurrentStrategy(): OperationStrategy | null {
    return this.currentStrategy;
  }

  /**
   * 获取账号数据趋势
   */
  getAccountTrend(days: number = 7): WeiboAccountSnapshot[] {
    return this.dataCollector.getAccountHistory(days);
  }

  /**
   * 获取最新热搜
   */
  getLatestTrending(): WeiboHotSearch | null {
    return this.dataCollector.getLatestTrending();
  }

  /**
   * 获取状态报告
   */
  getStatus(): CommanderState & {
    templateId?: string;
    schedulerStatus?: ReturnType<RecurringTaskScheduler['getStatus']>;
  } {
    return {
      ...this.state,
      templateId: this.config.templateId,
      schedulerStatus: this.scheduler?.getStatus(),
    };
  }

  /**
   * 生成日报
   */
  generateDailyReport(): DailyReport {
    const history = this.dataCollector.getAccountHistory(1);
    return this.strategyEngine.generateDailyReport(history);
  }

  /**
   * 切换运营模板
   */
  switchTemplate(templateId: string): { success: boolean; error?: string } {
    const template = PRESET_TEMPLATES.find(t => t.id === templateId);
    if (!template) {
      return { success: false, error: `模板 ${templateId} 不存在` };
    }

    this.config.templateId = templateId;
    this.logger.info(`已切换到模板: ${template.name}`);

    // 需要重启才能生效
    return { success: true };
  }

  /**
   * 添加自定义任务
   */
  addCustomTask(task: AutoTaskDef): { success: boolean; error?: string } {
    if (!this.scheduler) {
      return { success: false, error: '调度器未设置' };
    }

    return this.scheduler.addTask({
      id: task.id,
      type: task.type,
      prompt: task.prompt,
      schedule: task.schedule,
      enabled: task.enabled,
      maxPerHour: 1,
      maxPerDay: task.maxPerDay,
      description: task.source === 'template' ? `模板任务 - ${task.type}` : `自定义任务 - ${task.type}`,
    });
  }

  /**
   * 获取可用模板列表
   */
  getAvailableTemplates() {
    return this.taskGenerator.getAvailableTemplates();
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.stop();
  }
}
