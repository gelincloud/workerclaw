/**
 * 定时任务调度器 (RecurringTaskScheduler)
 *
 * 为私有虾提供 cron 式的定时任务调度能力。
 * 支持主人通过私信配置、查看、暂停、恢复定时任务。
 *
 * 核心设计：
 * - 简单的 cron 子集解析（分钟/小时/天级精度）
 * - 持久化发布历史到 JSON 文件（避免重复）
 * - 与 AgentEngine 集成，复用现有工具调用能力
 * - 频率限制：每小时最多 N 次，每天最多 M 次
 */

import { createLogger, type Logger } from '../core/logger.js';
import { LLMClient } from '../agent/llm-client.js';
import type { LLMConfig } from '../core/config.js';
import type { AgentEngine } from '../agent/agent-engine.js';
import type { Task, TaskExecutionContext, TaskResult, TaskType } from '../types/task.js';
import * as fs from 'fs';
import * as path from 'path';

// ==================== 类型定义 ====================

/** 定时任务定义 */
export interface RecurringTaskDef {
  /** 唯一标识 */
  id: string;
  /** 任务类型（用于日志和频率控制） */
  type: string;
  /** 执行提示词（LLM 理解的任务描述） */
  prompt: string;
  /** Cron 表达式（简化版：分钟 小时 * * *） */
  schedule: string;
  /** 是否启用 */
  enabled: boolean;
  /** 每小时最大执行次数（默认 2） */
  maxPerHour?: number;
  /** 每天最大执行次数（默认 6） */
  maxPerDay?: number;
  /** 执行超时（ms，默认 5 分钟） */
  timeoutMs?: number;
  /** 备注说明 */
  description?: string;
}

/** 定时任务执行记录 */
export interface RecurringTaskExecution {
  taskId: string;
  taskDefId: string;
  timestamp: number;
  success: boolean;
  durationMs: number;
  summary?: string;
  error?: string;
}

/** 调度器配置 */
export interface RecurringTaskSchedulerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 检查间隔（ms，默认 60 秒） */
  checkIntervalMs?: number;
  /** 历史记录存储路径 */
  historyDir?: string;
  /** 定时任务列表 */
  tasks: RecurringTaskDef[];
}

export const DEFAULT_SCHEDULER_CONFIG: Omit<RecurringTaskSchedulerConfig, 'tasks'> = {
  enabled: false,
  checkIntervalMs: 60 * 1000,
  historyDir: './data/scheduler',
};

// ==================== Cron 解析器 ====================

/**
 * 简化的 cron 表达式解析
 * 支持: 分钟 小时 三个字段
 * 分钟: 0-59, 通配符表示每分钟
 * 小时: 0-23, 通配符表示每小时
 * 
 * 例如:
 * - 每天 9/12/18/21 点整: 0 9,12,18,21
 * - 每 30 分钟: 用 step 30
 * - 工作日 9 点: 0 9
 */
export class CronParser {
  private minuteExpr: string;
  private hourExpr: string;
  private dayOfWeekExpr: string;

  constructor(cronExpr: string) {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 2) {
      throw new Error(`无效的 cron 表达式: "${cronExpr}"，至少需要 "分钟 小时"`);
    }
    this.minuteExpr = parts[0];
    this.hourExpr = parts[1];
    this.dayOfWeekExpr = parts.length > 4 ? parts[4] : '*';
  }

  /**
   * 检查给定时间是否匹配 cron 表达式
   */
  matches(date: Date): boolean {
    return this.matchesMinute(date) && this.matchesHour(date) && this.matchesDayOfWeek(date);
  }

  private matchesMinute(date: Date): boolean {
    return this.matchesField(date.getMinutes(), this.minuteExpr, 0, 59);
  }

  private matchesHour(date: Date): boolean {
    return this.matchesField(date.getHours(), this.hourExpr, 0, 23);
  }

  private matchesDayOfWeek(date: Date): boolean {
    if (this.dayOfWeekExpr === '*') return true;
    // JS getDay(): 0=Sunday, cron: 0=Sunday
    return this.matchesField(date.getDay(), this.dayOfWeekExpr, 0, 6);
  }

  private matchesField(value: number, expr: string, min: number, max: number): boolean {
    // 通配符
    if (expr === '*') return true;

    // 处理逗号分隔的值和范围
    const parts = expr.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (this.matchesSingleField(value, trimmed, min, max)) return true;
    }
    return false;
  }

  private matchesSingleField(value: number, expr: string, min: number, max: number): boolean {
    // */N 格式（每 N 单位）
    const stepMatch = expr.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      return value % step === 0;
    }

    // N-M/S 格式（范围 + 步长）
    const rangeStepMatch = expr.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (rangeStepMatch) {
      const start = parseInt(rangeStepMatch[1], 10);
      const end = parseInt(rangeStepMatch[2], 10);
      const step = parseInt(rangeStepMatch[3], 10);
      if (value < start || value > end) return false;
      return (value - start) % step === 0;
    }

    // N-M 格式（范围）
    const rangeMatch = expr.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      return value >= start && value <= end;
    }

    // 精确值
    const num = parseInt(expr, 10);
    if (!isNaN(num)) {
      return value === num;
    }

    return false;
  }

  /**
   * 获取下一次触发时间（用于日志展示）
   */
  getNextTrigger(from?: Date): Date {
    const now = from || new Date();
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);

    // 最多搜索 24 小时
    const maxSearch = 24 * 60;
    for (let i = 0; i < maxSearch; i++) {
      if (this.matches(next)) return next;
      next.setMinutes(next.getMinutes() + 1);
    }

    return new Date(now.getTime() + 24 * 60 * 60 * 1000); // fallback
  }
}

// ==================== RecurringTaskScheduler ====================

export class RecurringTaskScheduler {
  private logger: Logger;
  private config: RecurringTaskSchedulerConfig;
  private agentEngine: AgentEngine | null = null;
  private llm: LLMClient;
  private cronParsers = new Map<string, CronParser>();
  private executionHistory: RecurringTaskExecution[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isExecuting = false;
  private lastTriggerMinute = new Set<string>(); // 避免同一分钟重复触发

  // 动态管理的任务（主人通过私信添加/修改）
  private dynamicTasks: Map<string, RecurringTaskDef> = new Map();

  constructor(config: RecurringTaskSchedulerConfig, llmConfig: LLMConfig) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.llm = new LLMClient(llmConfig);
    this.logger = createLogger('RecurringScheduler');

    // 初始化 cron 解析器
    for (const task of config.tasks) {
      if (task.enabled) {
        try {
          this.cronParsers.set(task.id, new CronParser(task.schedule));
        } catch (err) {
          this.logger.error(`cron 解析失败 [${task.id}]: ${(err as Error).message}`);
        }
      }
    }

    // 加载历史记录
    this.loadHistory();
  }

  /**
   * 设置 AgentEngine（用于执行工具调用）
   */
  setAgentEngine(engine: AgentEngine): void {
    this.agentEngine = engine;
  }

  /**
   * 启动调度器
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info('定时任务调度器未启用');
      return;
    }

    if (this.isRunning) return;

    const allTasks = this.getAllTasks();
    if (allTasks.length === 0) {
      this.logger.info('没有配置定时任务，调度器不启动');
      return;
    }

    this.isRunning = true;

    this.timer = setInterval(() => {
      this.tick().catch(err => {
        this.logger.error('调度 tick 异常', (err as Error).message);
      });
    }, this.config.checkIntervalMs || 60 * 1000);

    const taskList = allTasks.filter(t => t.enabled).map(t => t.id).join(', ');
    this.logger.info(`定时任务调度器已启动 (间隔: ${this.config.checkIntervalMs! / 1000}s, 任务: ${taskList})`);

    // 立即执行一次检查
    this.tick().catch(() => {});
  }

  /**
   * 停止调度器
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.logger.info('定时任务调度器已停止');
  }

  /**
   * 调度 tick
   */
  private async tick(): Promise<void> {
    if (this.isExecuting || !this.isRunning) return;

    const now = new Date();
    const currentMinuteKey = `${now.getHours()}:${now.getMinutes()}`;

    const allTasks = this.getAllTasks().filter(t => t.enabled);
    for (const task of allTasks) {
      const parser = this.cronParsers.get(task.id);
      if (!parser) continue;

      // 频率限制检查
      if (!this.checkFrequency(task)) continue;

      // 同一分钟内不重复触发
      const triggerKey = `${task.id}:${currentMinuteKey}`;
      if (this.lastTriggerMinute.has(triggerKey)) continue;

      // Cron 匹配检查
      if (!parser.matches(now)) continue;

      // 标记已触发
      this.lastTriggerMinute.add(triggerKey);
      // 清理旧的触发记录（保留最近 3 分钟）
      for (const key of this.lastTriggerMinute) {
        const parts = key.split(':');
        const taskPart = parts.slice(0, -1).join(':');
        if (taskPart === task.id) {
          // 检查是否过期（超过 3 分钟）
          continue;
        }
      }

      // 执行任务
      this.isExecuting = true;
      try {
        await this.executeRecurringTask(task);
      } finally {
        this.isExecuting = false;
      }
    }
  }

  /**
   * 频率限制检查
   */
  private checkFrequency(task: RecurringTaskDef): boolean {
    const maxPerHour = task.maxPerHour || 2;
    const maxPerDay = task.maxPerDay || 6;
    const now = Date.now();

    const recentExecutions = this.executionHistory.filter(e => e.taskDefId === task.id);

    // 每小时限制
    const lastHour = recentExecutions.filter(e => now - e.timestamp < 60 * 60 * 1000);
    if (lastHour.length >= maxPerHour) {
      this.logger.debug(`频率限制 [${task.id}]: 每小时 ${maxPerHour} 次已达上限`);
      return false;
    }

    // 每天限制
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayExecutions = recentExecutions.filter(e => e.timestamp >= todayStart.getTime());
    if (todayExecutions.length >= maxPerDay) {
      this.logger.debug(`频率限制 [${task.id}]: 每天 ${maxPerDay} 次已达上限`);
      return false;
    }

    return true;
  }

  /**
   * 执行定时任务
   */
  private async executeRecurringTask(task: RecurringTaskDef): Promise<void> {
    if (!this.agentEngine) {
      this.logger.warn(`AgentEngine 未设置，跳过定时任务 [${task.id}]`);
      return;
    }

    const startTime = Date.now();
    this.logger.info(`⏰ 执行定时任务 [${task.id}]: "${task.prompt.substring(0, 50)}..."`);

    // 构建虚拟任务
    const taskId = `recurring-${task.id}-${Date.now()}`;
    const taskObj: Task = {
      taskId,
      taskType: (task.type || 'other') as TaskType,
      title: `[定时] ${task.prompt.substring(0, 40)}`,
      description: task.prompt,
      posterId: 'scheduler',
      posterName: '定时调度',
      createdAt: new Date().toISOString(),
    };

    const context: TaskExecutionContext = {
      task: taskObj,
      permissionLevel: 'limited',
      maxOutputTokens: 2048,
      timeoutMs: task.timeoutMs || 5 * 60 * 1000,
      receivedAt: Date.now(),
    };

    let result: TaskResult;
    let success = false;
    let summary = '';

    try {
      result = await this.agentEngine.executeTask(taskObj, context);
      success = result.status === 'completed';
      summary = result.content?.substring(0, 100) || '';
    } catch (err) {
      success = false;
      summary = '';
      this.logger.error(`定时任务执行失败 [${task.id}]`, (err as Error).message);
    }

    const durationMs = Date.now() - startTime;

    // 记录执行历史
    const execution: RecurringTaskExecution = {
      taskId,
      taskDefId: task.id,
      timestamp: Date.now(),
      success,
      durationMs,
      summary,
      error: success ? undefined : '执行失败',
    };

    this.executionHistory.push(execution);
    this.saveHistory();

    // 清理超过 7 天的记录
    this.cleanOldHistory(7 * 24 * 60 * 60 * 1000);

    if (success) {
      this.logger.info(`✅ 定时任务完成 [${task.id}] (${durationMs}ms): ${summary.substring(0, 50)}`);
    } else {
      this.logger.warn(`❌ 定时任务失败 [${task.id}] (${durationMs}ms)`);
    }
  }

  // ==================== 任务管理（供主人指令调用） ====================

  /**
   * 获取所有任务（配置 + 动态）
   */
  getAllTasks(): RecurringTaskDef[] {
    return [...this.config.tasks, ...Array.from(this.dynamicTasks.values())];
  }

  /**
   * 添加/更新动态任务
   */
  addTask(task: RecurringTaskDef): { success: boolean; error?: string } {
    // 验证 cron 表达式
    try {
      new CronParser(task.schedule);
    } catch (err) {
      return { success: false, error: `cron 表达式无效: ${(err as Error).message}` };
    }

    if (task.maxPerHour && task.maxPerHour > 10) {
      return { success: false, error: '每小时最多执行 10 次' };
    }

    if (task.maxPerDay && task.maxPerDay > 30) {
      return { success: false, error: '每天最多执行 30 次' };
    }

    this.dynamicTasks.set(task.id, task);

    // 更新 cron 解析器
    if (task.enabled) {
      this.cronParsers.set(task.id, new CronParser(task.schedule));
    } else {
      this.cronParsers.delete(task.id);
    }

    this.logger.info(`定时任务已添加/更新 [${task.id}]`);
    return { success: true };
  }

  /**
   * 删除动态任务（不能删除配置文件中的任务）
   */
  removeTask(taskId: string): { success: boolean; error?: string } {
    // 检查是否是配置文件中的任务
    if (this.config.tasks.some(t => t.id === taskId)) {
      return { success: false, error: '不能删除配置文件中的任务，只能禁用' };
    }

    if (!this.dynamicTasks.has(taskId)) {
      return { success: false, error: `任务 ${taskId} 不存在` };
    }

    this.dynamicTasks.delete(taskId);
    this.cronParsers.delete(taskId);
    this.logger.info(`定时任务已删除 [${taskId}]`);
    return { success: true };
  }

  /**
   * 启用/禁用任务
   */
  toggleTask(taskId: string, enabled: boolean): { success: boolean; error?: string } {
    const allTasks = this.getAllTasks();
    const task = allTasks.find(t => t.id === taskId);
    if (!task) {
      return { success: false, error: `任务 ${taskId} 不存在` };
    }

    task.enabled = enabled;

    if (enabled) {
      try {
        this.cronParsers.set(task.id, new CronParser(task.schedule));
      } catch (err) {
        return { success: false, error: `cron 解析失败: ${(err as Error).message}` };
      }
    } else {
      this.cronParsers.delete(task.id);
    }

    // 如果是动态任务，更新 Map
    if (this.dynamicTasks.has(taskId)) {
      this.dynamicTasks.set(taskId, task);
    }

    this.logger.info(`定时任务 ${enabled ? '启用' : '禁用'} [${taskId}]`);
    return { success: true };
  }

  /**
   * 获取任务状态摘要
   */
  getStatus(): {
    isRunning: boolean;
    tasks: Array<{
      id: string;
      type: string;
      schedule: string;
      enabled: boolean;
      source: 'config' | 'dynamic';
      lastExecution?: RecurringTaskExecution;
      todayCount: number;
      nextTrigger?: string;
      description?: string;
    }>;
  } {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const tasks = this.getAllTasks().map(task => {
      const executions = this.executionHistory.filter(e => e.taskDefId === task.id);
      const lastExec = executions[executions.length - 1];
      const todayCount = executions.filter(e => e.timestamp >= todayStart.getTime()).length;

      const parser = this.cronParsers.get(task.id);
      const nextTrigger = parser ? parser.getNextTrigger().toLocaleString('zh-CN') : undefined;

      return {
        id: task.id,
        type: task.type,
        schedule: task.schedule,
        enabled: task.enabled,
        source: this.config.tasks.some(t => t.id === task.id) ? 'config' as const : 'dynamic' as const,
        lastExecution: lastExec,
        todayCount,
        nextTrigger,
        description: task.description,
      };
    });

    return { isRunning: this.isRunning, tasks };
  }

  /**
   * 获取执行历史
   */
  getHistory(taskId?: string, limit = 20): RecurringTaskExecution[] {
    let history = this.executionHistory;
    if (taskId) {
      history = history.filter(e => e.taskDefId === taskId);
    }
    return history.slice(-limit).reverse();
  }

  // ==================== 持久化 ====================

  private getHistoryFilePath(): string {
    const dir = this.config.historyDir || DEFAULT_SCHEDULER_CONFIG.historyDir!;
    return path.join(dir, 'execution-history.json');
  }

  private loadHistory(): void {
    try {
      const filePath = this.getHistoryFilePath();
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        this.executionHistory = JSON.parse(content);
        this.logger.debug(`已加载 ${this.executionHistory.length} 条执行历史`);
      }
    } catch (err) {
      this.logger.debug('加载历史记录失败（忽略）', (err as Error).message);
      this.executionHistory = [];
    }
  }

  private saveHistory(): void {
    try {
      const filePath = this.getHistoryFilePath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // 只保留最近 500 条
      const toSave = this.executionHistory.slice(-500);
      fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error('保存历史记录失败', (err as Error).message);
    }
  }

  private cleanOldHistory(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.executionHistory.length;
    this.executionHistory = this.executionHistory.filter(e => e.timestamp >= cutoff);
    if (this.executionHistory.length < before) {
      this.logger.debug(`清理了 ${before - this.executionHistory.length} 条过期历史记录`);
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.stop();
    this.saveHistory();
  }
}
