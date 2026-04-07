/**
 * 知乎运营指挥官 - 主控制器
 *
 * 整合数据采集、策略分析、任务生成，提供统一的运营接口
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { LLMConfig, PlatformConfig } from '../core/config.js';
import type { AgentEngine } from '../agent/agent-engine.js';
import { ZhihuDataCollector } from './zhihu-data-collector.js';
import { ZhihuStrategyEngine } from './zhihu-strategy-engine.js';
import { ZhihuTaskGenerator, ZHIHU_PRESET_TEMPLATES } from './zhihu-task-generator.js';
import type {
  ZhihuCommanderConfig,
  ZhihuOperationStrategy,
  ZhihuAutoTaskDef,
  ZhihuDailyReport,
  ZhihuAccountSnapshot,
  ZhihuHotData,
} from './zhihu-types.js';
import type { RecurringTaskScheduler } from '../scheduler/recurring-task-scheduler.js';
import * as path from 'path';
import * as fs from 'fs';

/** 指挥官状态 */
interface ZhihuCommanderState {
  /** 是否已启动 */
  isRunning: boolean;
  /** 上次数据采集时间 */
  lastCollection: number;
  /** 上次策略分析时间 */
  lastAnalysis: number;
  /** 当前活跃任务数 */
  activeTaskCount: number;
  /** 今日已发布文章数 */
  todayArticleCount: number;
  /** 今日已回答数 */
  todayAnswerCount: number;
  /** 今日已回复数 */
  todayReplyCount: number;
}

export class ZhihuCommander {
  private logger: Logger;
  private config: ZhihuCommanderConfig;
  private platformConfig: PlatformConfig;
  private llmConfig: LLMConfig;
  private dataCollector: ZhihuDataCollector;
  private strategyEngine: ZhihuStrategyEngine;
  private taskGenerator: ZhihuTaskGenerator;
  private scheduler: RecurringTaskScheduler | null = null;
  private agentEngine: AgentEngine | null = null;
  private state: ZhihuCommanderState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentStrategy: ZhihuOperationStrategy | null = null;

  constructor(
    config: ZhihuCommanderConfig,
    platformConfig: PlatformConfig,
    llmConfig: LLMConfig,
  ) {
    this.config = config;
    this.platformConfig = platformConfig;
    this.llmConfig = llmConfig;
    this.logger = createLogger('ZhihuCommander');

    // 初始化数据目录
    const dataDir = config.dataDir || path.join(process.cwd(), 'data', 'zhihu-commander');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 初始化子模块
    this.dataCollector = new ZhihuDataCollector(
      platformConfig.apiUrl || 'https://www.miniabc.top',
      config.ownerId || '',
      dataDir
    );

    this.strategyEngine = new ZhihuStrategyEngine(this.dataCollector);

    this.taskGenerator = new ZhihuTaskGenerator({
      maxArticlesPerDay: config.automation.maxArticlesPerDay,
      maxAnswersPerDay: config.automation.maxAnswersPerDay,
      maxRepliesPerDay: config.automation.maxRepliesPerDay,
      requireConfirmation: config.automation.requireConfirmation,
    });

    // 初始化状态
    this.state = {
      isRunning: false,
      lastCollection: 0,
      lastAnalysis: 0,
      activeTaskCount: 0,
      todayArticleCount: 0,
      todayAnswerCount: 0,
      todayReplyCount: 0,
    };

    this.logger.info('知乎运营指挥官已初始化');
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

    if (!this.config.enabled) {
      this.logger.warn('指挥官未启用');
      return;
    }

    this.state.isRunning = true;
    this.logger.info('知乎运营指挥官启动中...');

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

    this.logger.info('知乎运营指挥官已启动');
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

    this.logger.info('知乎运营指挥官已停止');
  }

  /**
   * 手动触发数据采集
   */
  async manualCollect(): Promise<{
    snapshot: ZhihuAccountSnapshot | null;
    hotData: ZhihuHotData | null;
  }> {
    this.logger.info('手动触发数据采集...');

    const snapshot = await this.dataCollector.collectAccountSnapshot();
    const hotData = this.config.collection.collectHot
      ? await this.dataCollector.collectHotList(20)
      : null;

    this.state.lastCollection = Date.now();

    return { snapshot, hotData };
  }

  /**
   * 手动触发策略分析
   */
  async manualAnalyze(): Promise<ZhihuOperationStrategy | null> {
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
  getStatus(): ZhihuCommanderState & {
    config: ZhihuCommanderConfig;
    currentStrategy: ZhihuOperationStrategy | null;
  } {
    return {
      ...this.state,
      config: this.config,
      currentStrategy: this.currentStrategy,
    };
  }

  /**
   * 获取最新热榜
   */
  getLatestHotList(): ZhihuHotData | null {
    return this.dataCollector.getLatestHotList();
  }

  /**
   * 获取账号历史数据
   */
  getAccountTrend(days: number = 7): ZhihuAccountSnapshot[] {
    return this.dataCollector.getAccountHistory(days);
  }

  /**
   * 获取可用模板
   */
  getAvailableTemplates() {
    return ZHIHU_PRESET_TEMPLATES.map(t => ({
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
  addCustomTask(task: ZhihuAutoTaskDef): { success: boolean; error?: string } {
    if (!this.scheduler) {
      return { success: false, error: '调度器未初始化' };
    }

    this.scheduler.addTask({
      id: task.id,
      type: task.type,
      prompt: task.prompt,
      schedule: task.schedule,
      enabled: task.enabled,
      source: 'dynamic',
      maxPerDay: task.maxPerDay,
      maxPerHour: task.maxPerHour,
    });

    this.logger.info(`已添加自定义任务: ${task.id}`);
    return { success: true };
  }

  /**
   * 生成日报
   */
  generateDailyReport(): ZhihuDailyReport {
    const history = this.dataCollector.getAccountHistory(1);
    return this.strategyEngine.generateDailyReport(history);
  }

  /**
   * 发布文章
   */
  async postArticle(title: string, content: string, draft: boolean = false): Promise<{ success: boolean; articleId?: string; url?: string; error?: string }> {
    return this.dataCollector.postArticle(title, content, draft);
  }

  /**
   * 回答问题
   */
  async postAnswer(questionId: string, content: string, draft: boolean = false): Promise<{ success: boolean; answerId?: string; url?: string; error?: string }> {
    return this.dataCollector.postAnswer(questionId, content, draft);
  }

  /**
   * 发布评论
   */
  async postComment(content: string, resourceType: 'answer' | 'article' | 'question', resourceId: string, replyToId?: string): Promise<{ success: boolean; commentId?: string; error?: string }> {
    return this.dataCollector.postComment(content, resourceType, resourceId, replyToId);
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
        source: 'template',
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

      // 采集热榜（如果配置了）
      if (this.config.collection.collectHot) {
        await this.dataCollector.collectHotList(20);
      }

      this.state.lastCollection = Date.now();
      this.logger.info('数据采集完成');
    } catch (err) {
      this.logger.error('数据采集失败', (err as Error).message);
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.stop();
  }
}
