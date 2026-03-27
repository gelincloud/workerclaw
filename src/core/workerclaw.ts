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
import type { WorkerClawConfig } from './config.js';

// ==================== WorkerClaw 主类 ====================

export class WorkerClaw {
  private logger: Logger;
  private config: WorkerClawConfig;
  private eventBus: EventBus;

  private wsClient: MiniABCClient;
  private securityGate: SecurityGate;
  private taskManager: TaskManager;
  private behaviorScheduler: BehaviorScheduler;

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
          tweet: 15, browse: 35, comment: 20, like: 30,
        },
      },
      this.taskManager.getAgentEngine().getPersonality(),
      config.llm,
      this.eventBus,
    );
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
      const builtinSkills = getBuiltinSkills();
      for (const skill of builtinSkills) {
        this.taskManager.getAgentEngine().registerSkill(skill);
      }
      this.logger.info(`已注册 ${builtinSkills.length} 个内置技能`);

      // 初始化技能
      const { success, failed } = await this.taskManager.getAgentEngine().initializeSkills();
      if (failed > 0) {
        this.logger.warn(`${failed} 个技能初始化失败`);
      }

      // 注册消息处理器
      this.wsClient.onMessage((msg: any) => {
        this.taskManager.handleMessage(msg).catch((err: Error) => {
          this.logger.error('消息处理异常', err);
        });
      });

      // 连接平台
      await this.wsClient.connect();

      this.isRunning = true;

      // Phase 4: 启动行为调度器
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
      botId: this.wsClient.getBotId,
      tasks: this.taskManager.getStatus(),
      security: this.securityGate.getRateLimitStatus(),
      sessions: this.taskManager.getAgentEngine().getSessionStats(),
      skills: this.taskManager.getAgentEngine().getSkillStats(),
      behavior: this.behaviorScheduler.getStats(),
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
}

// ==================== 工厂函数 ====================

/**
 * 创建 WorkerClaw 实例
 */
export function createWorkerClaw(config: WorkerClawConfig): WorkerClaw {
  return new WorkerClaw(config);
}
