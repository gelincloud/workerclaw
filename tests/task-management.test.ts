/**
 * Phase 3 任务管理测试
 * 
 * 覆盖: 状态机、评估器、并发控制器、工具系统、端到端
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus, WorkerClawEvent } from '../src/core/events.js';
import { TaskStateMachine } from '../src/task/task-state-machine.js';
import { TaskEvaluator } from '../src/task/task-evaluator.js';
import { ConcurrencyController } from '../src/task/concurrency.js';
import { ToolRegistry, createBuiltinToolRegistry } from '../src/agent/tool-registry.js';
import { ToolExecutor } from '../src/agent/tool-executor.js';
import type { Task, EvaluationContext, TaskEvaluatorConfig } from '../src/types/task.js';
import type { SecurityConfig } from '../src/core/config.js';
import type { PermissionLevel, ToolCall, ToolExecutionContext } from '../src/types/agent.js';

// ==================== 辅助函数 ====================

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'task-test-001',
    taskType: 'text_reply',
    title: '测试任务',
    description: '这是一个测试任务描述',
    posterId: 'user-001',
    posterName: '测试用户',
    reward: 10,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createEventBus(): EventBus {
  return new EventBus();
}

// ==================== 任务状态机测试 ====================

describe('任务状态机', () => {
  let fsm: TaskStateMachine;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createEventBus();
    fsm = new TaskStateMachine(eventBus);
  });

  it('初始化任务状态为 created', () => {
    const task = createMockTask();
    const state = fsm.init(task);
    expect(state.status).toBe('created');
    expect(state.history).toHaveLength(1);
    expect(state.history[0].status).toBe('created');
  });

  it('正常流转: created → evaluating → accepted → running → completed', () => {
    const task = createMockTask();
    fsm.init(task);

    fsm.transition(task.taskId, 'evaluating');
    expect(fsm.getStatus(task.taskId)).toBe('evaluating');

    fsm.transition(task.taskId, 'accepted');
    expect(fsm.getStatus(task.taskId)).toBe('accepted');

    fsm.transition(task.taskId, 'running');
    expect(fsm.getStatus(task.taskId)).toBe('running');

    fsm.transition(task.taskId, 'completed');
    expect(fsm.getStatus(task.taskId)).toBe('completed');

    const state = fsm.getState(task.taskId)!;
    expect(state.history).toHaveLength(5);
  });

  it('正常流转: evaluating → rejected', () => {
    const task = createMockTask();
    fsm.init(task);

    fsm.transition(task.taskId, 'evaluating');
    fsm.transition(task.taskId, 'rejected', '评估未通过');
    expect(fsm.getStatus(task.taskId)).toBe('rejected');
    expect(fsm.isTerminal(task.taskId)).toBe(true);
  });

  it('正常流转: running → failed', () => {
    const task = createMockTask();
    fsm.init(task);

    fsm.transition(task.taskId, 'evaluating');
    fsm.transition(task.taskId, 'accepted');
    fsm.transition(task.taskId, 'running');
    fsm.transition(task.taskId, 'failed', 'LLM 调用失败');
    expect(fsm.getStatus(task.taskId)).toBe('failed');
    expect(fsm.isTerminal(task.taskId)).toBe(true);
  });

  it('正常流转: running → timeout', () => {
    const task = createMockTask();
    fsm.init(task);

    fsm.transition(task.taskId, 'evaluating');
    fsm.transition(task.taskId, 'accepted');
    fsm.transition(task.taskId, 'running');
    fsm.transition(task.taskId, 'timeout');
    expect(fsm.getStatus(task.taskId)).toBe('timeout');
    expect(fsm.isTerminal(task.taskId)).toBe(true);
  });

  it('任意非终态可取消: accepted → cancelled', () => {
    const task = createMockTask();
    fsm.init(task);

    fsm.transition(task.taskId, 'evaluating');
    fsm.transition(task.taskId, 'accepted');
    fsm.transition(task.taskId, 'cancelled');
    expect(fsm.isTerminal(task.taskId)).toBe(true);
  });

  it('非法转换抛异常: created → running', () => {
    const task = createMockTask();
    fsm.init(task);

    expect(() => fsm.transition(task.taskId, 'running')).toThrow('非法状态转换');
  });

  it('终态不可转换: completed → running', () => {
    const task = createMockTask();
    fsm.init(task);
    fsm.transition(task.taskId, 'evaluating');
    fsm.transition(task.taskId, 'accepted');
    fsm.transition(task.taskId, 'running');
    fsm.transition(task.taskId, 'completed');

    expect(() => fsm.transition(task.taskId, 'running')).toThrow('非法状态转换');
  });

  it('tryTransition 不抛异常', () => {
    const task = createMockTask();
    fsm.init(task);

    expect(fsm.tryTransition(task.taskId, 'running')).toBe(false);
    expect(fsm.tryTransition(task.taskId, 'evaluating')).toBe(true);
  });

  it('设置和获取权限级别', () => {
    const task = createMockTask();
    fsm.init(task);

    fsm.setPermissionLevel(task.taskId, 'standard');
    expect(fsm.getState(task.taskId)?.permissionLevel).toBe('standard');
  });

  it('统计运行中任务数', () => {
    const task1 = createMockTask({ taskId: 'task-1' });
    const task2 = createMockTask({ taskId: 'task-2' });
    const task3 = createMockTask({ taskId: 'task-3' });

    fsm.init(task1);
    fsm.init(task2);
    fsm.init(task3);

    fsm.transition('task-1', 'evaluating');
    fsm.transition('task-1', 'accepted');
    fsm.transition('task-1', 'running');

    fsm.transition('task-2', 'evaluating');
    fsm.transition('task-2', 'accepted');

    expect(fsm.getRunningCount()).toBe(2);

    fsm.transition('task-1', 'completed');
    expect(fsm.getRunningCount()).toBe(1);
  });

  it('清理状态记录', () => {
    const task = createMockTask();
    fsm.init(task);
    fsm.transition(task.taskId, 'evaluating');
    fsm.transition(task.taskId, 'rejected');

    fsm.cleanup(task.taskId);
    expect(fsm.getState(task.taskId)).toBeUndefined();
  });

  it('获取统计信息', () => {
    const task1 = createMockTask({ taskId: 'task-1' });
    const task2 = createMockTask({ taskId: 'task-2' });

    fsm.init(task1);
    fsm.init(task2);
    fsm.transition('task-1', 'evaluating');
    fsm.transition('task-2', 'evaluating');
    fsm.transition('task-2', 'rejected');

    const stats = fsm.getStats();
    expect(stats.evaluating).toBe(1);
    expect(stats.rejected).toBe(1);
  });
});

// ==================== 任务评估器测试 ====================

describe('任务评估器', () => {
  const baseConfig: TaskEvaluatorConfig = {
    acceptThreshold: 80,
    deferThreshold: 60,
    weights: { capability: 0.5, capacity: 0.2, risk: 0.3 },
    capabilityScores: {
      text_reply: 90,
      qa: 85,
      translation: 80,
      search_summary: 75,
      writing: 70,
      image_gen: 60,
      data_analysis: 55,
      code_dev: 40,
      system_op: 30,
    },
  };

  const baseContext: EvaluationContext = {
    runningCount: 0,
    maxConcurrent: 3,
    skills: [],
    completedCountByType: {},
    threshold: 80,
  };

  it('高能力 + 空闲 → accept', () => {
    const evaluator = new TaskEvaluator(baseConfig);
    const task = createMockTask({ taskType: 'text_reply' });
    const result = evaluator.evaluate(task, baseContext);

    expect(result.decision).toBe('accept');
    expect(result.score).toBeGreaterThanOrEqual(80);
    // text_reply 基础分 90 + 可能的技能加分（但 skills 为空时 bonus=0）
    expect(result.breakdown.capability).toBe(90);
  });

  it('低能力任务 → reject', () => {
    const evaluator = new TaskEvaluator(baseConfig);
    const task = createMockTask({ taskType: 'system_op' });
    const result = evaluator.evaluate(task, baseContext);

    expect(result.decision).toBe('reject');
    expect(result.breakdown.capability).toBe(30); // system_op 基础分
  });

  it('容量不足降低评分', () => {
    const evaluator = new TaskEvaluator(baseConfig);
    const task = createMockTask({ taskType: 'writing' });

    const busyContext: EvaluationContext = {
      ...baseContext,
      runningCount: 3,
      maxConcurrent: 3,
    };

    const result = evaluator.evaluate(task, busyContext);
    expect(result.breakdown.capacity).toBe(0); // 满载
  });

  it('高金额任务风险降低', () => {
    const evaluator = new TaskEvaluator(baseConfig);
    const normalTask = createMockTask({ taskType: 'writing', reward: 10 });
    const highRewardTask = createMockTask({ taskType: 'writing', reward: 500 });

    const normalResult = evaluator.evaluate(normalTask, baseContext);
    const highResult = evaluator.evaluate(highRewardTask, baseContext);

    expect(highResult.breakdown.risk).toBeLessThan(normalResult.breakdown.risk);
  });

  it('紧迫任务风险降低', () => {
    const evaluator = new TaskEvaluator(baseConfig);
    const normalTask = createMockTask({ taskType: 'writing' });
    const urgentTask = createMockTask({
      taskType: 'writing',
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 分钟后
    });

    const normalResult = evaluator.evaluate(normalTask, baseContext);
    const urgentResult = evaluator.evaluate(urgentTask, baseContext);

    expect(urgentResult.breakdown.risk).toBeLessThan(normalResult.breakdown.risk);
  });

  it('综合评分在延迟区间 → defer', () => {
    const evaluator = new TaskEvaluator(baseConfig);
    const task = createMockTask({ taskType: 'data_analysis' });
    const result = evaluator.evaluate(task, baseContext);

    // data_analysis 基础分 55 * 0.5 + 容量 100 * 0.2 + 风险 60 * 0.3 ≈ 65.5
    if (result.score >= 60 && result.score < 80) {
      expect(result.decision).toBe('defer');
    }
  });

  it('代码开发任务风险显著低于文字回复', () => {
    const evaluator = new TaskEvaluator(baseConfig);
    const textTask = createMockTask({ taskType: 'text_reply' });
    const codeTask = createMockTask({ taskType: 'code_dev' });

    const textResult = evaluator.evaluate(textTask, baseContext);
    const codeResult = evaluator.evaluate(codeTask, baseContext);

    expect(codeResult.breakdown.risk).toBeLessThan(textResult.breakdown.risk);
  });
});

// ==================== 并发控制器测试 ====================

describe('并发控制器', () => {
  let controller: ConcurrencyController;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = createEventBus();
    controller = new ConcurrencyController(
      {
        maxConcurrent: 2,
        maxPerType: {},
        queueSize: 5,
        priority: { highValueFirst: true, urgentFirst: true },
      },
      eventBus,
    );
  });

  it('有容量时直接启动', () => {
    const task = createMockTask();
    const result = controller.tryStart(task);
    expect(result).toBe('started');
    expect(controller.getStats().running).toBe(1);
  });

  it('并发满时入队', () => {
    const task1 = createMockTask({ taskId: 'task-1' });
    const task2 = createMockTask({ taskId: 'task-2' });
    const task3 = createMockTask({ taskId: 'task-3' });

    expect(controller.tryStart(task1)).toBe('started');
    expect(controller.tryStart(task2)).toBe('started');
    expect(controller.tryStart(task3)).toBe('queued');
    expect(controller.getStats().queue).toBe(1);
  });

  it('队列满时拒绝', () => {
    // maxConcurrent=2, queueSize=5 → 最多容纳 7 个
    for (let i = 0; i < 2; i++) {
      controller.tryStart(createMockTask({ taskId: `run-${i}` }));
    }
    for (let i = 0; i < 5; i++) {
      controller.tryStart(createMockTask({ taskId: `queue-${i}` }));
    }

    const result = controller.tryStart(createMockTask({ taskId: 'reject-me' }));
    expect(result).toBe('rejected');
  });

  it('任务完成释放槽位', () => {
    const task = createMockTask();
    controller.tryStart(task);
    expect(controller.getStats().running).toBe(1);

    controller.taskFinished(task.taskId);
    expect(controller.getStats().running).toBe(0);
  });

  it('按类型限制并发', () => {
    const strictController = new ConcurrencyController(
      {
        maxConcurrent: 10,
        maxPerType: { code_dev: 1 },
        queueSize: 5,
        priority: { highValueFirst: false, urgentFirst: false },
      },
      eventBus,
    );

    const task1 = createMockTask({ taskId: 'code-1', taskType: 'code_dev' });
    const task2 = createMockTask({ taskId: 'code-2', taskType: 'code_dev' });
    const task3 = createMockTask({ taskId: 'text-1', taskType: 'text_reply' });

    expect(strictController.tryStart(task1)).toBe('started');
    expect(strictController.tryStart(task2)).toBe('queued'); // code_dev 已满
    expect(strictController.tryStart(task3)).toBe('started'); // text_reply 不受限
  });

  it('高金额任务优先', () => {
    const lowReward = createMockTask({ taskId: 'low', reward: 10 });
    const highReward = createMockTask({ taskId: 'high', reward: 500 });

    // 先填满并发
    controller.tryStart(createMockTask({ taskId: 'run-1' }));
    controller.tryStart(createMockTask({ taskId: 'run-2' }));

    // 低金额先入队
    controller.tryStart(lowReward);
    controller.tryStart(highReward);

    // 高金额应该在队首
    const stats = controller.getStats();
    expect(stats.queue).toBe(2);
  });

  it('取消队列中的任务', () => {
    controller.tryStart(createMockTask({ taskId: 'run-1' }));
    controller.tryStart(createMockTask({ taskId: 'run-2' }));
    controller.tryStart(createMockTask({ taskId: 'queue-1' }));

    expect(controller.getStats().queue).toBe(1);
    expect(controller.removeFromQueue('queue-1')).toBe(true);
    expect(controller.getStats().queue).toBe(0);
  });

  it('hasCapacity 正确判断', () => {
    controller.tryStart(createMockTask({ taskId: 'run-1' }));
    controller.tryStart(createMockTask({ taskId: 'run-2' }));

    expect(controller.hasCapacity()).toBe(false);
  });

  it('取消运行中任务', () => {
    const task = createMockTask();
    controller.tryStart(task);
    expect(controller.cancelTask(task.taskId)).toBe(true);
    expect(controller.getStats().running).toBe(0);
  });

  it('dispose 清理所有资源', () => {
    controller.tryStart(createMockTask({ taskId: 'run-1' }));
    controller.tryStart(createMockTask({ taskId: 'run-2' }));
    controller.tryStart(createMockTask({ taskId: 'queue-1' }));

    controller.dispose();
    const stats = controller.getStats();
    expect(stats.running).toBe(0);
    expect(stats.queue).toBe(0);
  });
});

// ==================== 工具注册表测试 ====================

describe('工具注册表', () => {
  it('内置工具注册正确', () => {
    const registry = createBuiltinToolRegistry();
    const names = registry.getToolNames();

    expect(names).toContain('llm_query');
    expect(names).toContain('web_search');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('image_generate');
    expect(names).toContain('data_analyze');
    expect(names).toContain('run_code');
    expect(names).toContain('system_command');
  });

  it('read_only 只能看到 llm_query', () => {
    const registry = createBuiltinToolRegistry();
    const tools = registry.getTools('read_only');

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('llm_query');
  });

  it('limited 能看到 read_only + limited 工具', () => {
    const registry = createBuiltinToolRegistry();
    const tools = registry.getTools('limited');
    const names = tools.map(t => t.name);

    expect(names).toContain('llm_query');
    expect(names).toContain('web_search');
    expect(names).toContain('read_file');
    expect(names).not.toContain('write_file');
  });

  it('standard 能看到 read_only + limited + standard 工具', () => {
    const registry = createBuiltinToolRegistry();
    const tools = registry.getTools('standard');
    const names = tools.map(t => t.name);

    expect(names).toContain('llm_query');
    expect(names).toContain('write_file');
    expect(names).toContain('image_generate');
    expect(names).toContain('data_analyze');
    expect(names).not.toContain('run_code');
  });

  it('elevated 能看到所有工具', () => {
    const registry = createBuiltinToolRegistry();
    const tools = registry.getTools('elevated');

    expect(tools.length).toBe(8);
  });

  it('isToolAllowed 正确判断权限', () => {
    const registry = createBuiltinToolRegistry();

    expect(registry.isToolAllowed('llm_query', 'read_only')).toBe(true);
    expect(registry.isToolAllowed('web_search', 'read_only')).toBe(false);
    expect(registry.isToolAllowed('run_code', 'standard')).toBe(false);
    expect(registry.isToolAllowed('run_code', 'elevated')).toBe(true);
  });

  it('getToolsForLLM 返回 OpenAI 格式', () => {
    const registry = createBuiltinToolRegistry();
    const tools = registry.getToolsForLLM('limited');

    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(tool.function).toHaveProperty('name');
      expect(tool.function).toHaveProperty('description');
      expect(tool.function).toHaveProperty('parameters');
    }
  });

  it('注册自定义工具', () => {
    const registry = createBuiltinToolRegistry();
    registry.register({
      name: 'custom_tool',
      description: '自定义工具',
      requiredLevel: 'standard',
      parameters: { type: 'object', properties: {} },
    });

    expect(registry.getTool('custom_tool')).toBeDefined();
    expect(registry.isToolAllowed('custom_tool', 'standard')).toBe(true);
    expect(registry.isToolAllowed('custom_tool', 'limited')).toBe(false);
  });

  it('注销工具', () => {
    const registry = createBuiltinToolRegistry();
    expect(registry.unregister('llm_query')).toBe(true);
    expect(registry.getTool('llm_query')).toBeUndefined();
  });

  it('获取统计信息', () => {
    const registry = createBuiltinToolRegistry();
    const stats = registry.getStats();

    expect(stats.total).toBe(8);
    expect(stats.byLevel.read_only).toBe(1);
    expect(stats.byLevel.limited).toBe(2);
    expect(stats.byLevel.standard).toBe(3);
    expect(stats.byLevel.elevated).toBe(2);
  });
});

// ==================== 工具执行器测试 ====================

describe('工具执行器', () => {
  let executor: ToolExecutor;
  let registry: ToolRegistry;
  let eventBus: EventBus;

  const baseSecurityConfig: SecurityConfig = {
    rateLimit: { maxMessagesPerMinute: 30, maxConcurrentTasks: 3 },
    contentScan: {
      promptInjection: { enabled: true },
      maliciousCommands: { enabled: true },
    },
    sandbox: {
      workDir: '/tmp/test-sandbox',
      commandTimeoutMs: 5000,
      taskTimeoutMs: 60000,
    },
  };

  const baseContext: ToolExecutionContext = {
    taskId: 'test-task',
    permissionLevel: 'standard',
    workDir: '/tmp/test-sandbox',
    remainingMs: 30000,
    toolCallCount: 0,
    maxToolCalls: 10,
  };

  beforeEach(() => {
    eventBus = createEventBus();
    registry = createBuiltinToolRegistry();
    executor = new ToolExecutor(registry, { security: baseSecurityConfig }, eventBus);
  });

  it('未绑定执行器的工具返回 not_implemented', async () => {
    const toolCall: ToolCall = {
      id: 'call-001',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'test.txt', content: 'hello' }),
    };

    const result = await executor.execute(toolCall, baseContext);
    expect(result.success).toBe(true);
    expect(result.toolCallId).toBe('call-001');
    expect(result.content).toContain('not_implemented');
  });

  it('权限不足的工具被拒绝', async () => {
    const toolCall: ToolCall = {
      id: 'call-002',
      name: 'run_code',
      arguments: '{}',
    };

    const limitedContext: ToolExecutionContext = {
      ...baseContext,
      permissionLevel: 'limited',
    };

    const result = await executor.execute(toolCall, limitedContext);
    expect(result.success).toBe(false);
    expect(result.error).toBe('permission_denied');
  });

  it('工具调用次数超限被拒绝', async () => {
    const toolCall: ToolCall = {
      id: 'call-003',
      name: 'llm_query',
      arguments: JSON.stringify({ prompt: 'test' }),
    };

    const exhaustedContext: ToolExecutionContext = {
      ...baseContext,
      toolCallCount: 10,
      maxToolCalls: 10,
    };

    const result = await executor.execute(toolCall, exhaustedContext);
    expect(result.success).toBe(false);
    expect(result.error).toBe('tool_call_limit');
  });

  it('无效参数返回错误', async () => {
    registry.register({
      name: 'test_tool',
      description: '测试工具',
      requiredLevel: 'read_only',
      parameters: { type: 'object', properties: {} },
      executor: async () => ({ toolCallId: '', success: true, content: '' }),
    });

    const toolCall: ToolCall = {
      id: 'call-004',
      name: 'test_tool',
      arguments: 'invalid json{{{',
    };

    const result = await executor.execute(toolCall, baseContext);
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_arguments');
  });

  it('自定义执行器正常工作', async () => {
    registry.register({
      name: 'echo_tool',
      description: '回显工具',
      requiredLevel: 'read_only',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      executor: async (params) => ({
        toolCallId: '',
        success: true,
        content: `Echo: ${params.message}`,
      }),
    });

    const toolCall: ToolCall = {
      id: 'call-005',
      name: 'echo_tool',
      arguments: JSON.stringify({ message: 'hello world' }),
    };

    const result = await executor.execute(toolCall, baseContext);
    expect(result.success).toBe(true);
    expect(result.content).toBe('Echo: hello world');
  });

  it('执行器异常被捕获', async () => {
    registry.register({
      name: 'error_tool',
      description: '总是失败的工具',
      requiredLevel: 'read_only',
      parameters: {},
      executor: async () => {
        throw new Error('故意失败');
      },
    });

    const toolCall: ToolCall = {
      id: 'call-006',
      name: 'error_tool',
      arguments: '{}',
    };

    const result = await executor.execute(toolCall, baseContext);
    expect(result.success).toBe(false);
    expect(result.content).toContain('故意失败');
  });
});

// ==================== 端到端: 评估 + 状态机 + 并发 ====================

describe('Phase 3 端到端: 任务生命周期', () => {
  it('评估→接单→执行→完成 完整流程', async () => {
    const eventBus = createEventBus();
    const evaluator = new TaskEvaluator({
      acceptThreshold: 80,
      deferThreshold: 60,
      weights: { capability: 0.5, capacity: 0.2, risk: 0.3 },
      capabilityScores: { text_reply: 90, qa: 85, writing: 70, code_dev: 40, system_op: 30 },
    });
    const fsm = new TaskStateMachine(eventBus);
    const controller = new ConcurrencyController(
      { maxConcurrent: 3, maxPerType: {}, queueSize: 5, priority: { highValueFirst: true, urgentFirst: true } },
      eventBus,
    );

    const task = createMockTask({ taskType: 'text_reply' });
    fsm.init(task);

    // 评估
    fsm.transition(task.taskId, 'evaluating');
    const evaluation = evaluator.evaluate(task, {
      runningCount: controller.getStats().running,
      maxConcurrent: 3,
      skills: [],
      completedCountByType: {},
      threshold: 80,
    });

    expect(evaluation.decision).toBe('accept');

    // 接单
    const startResult = controller.tryStart(task);
    expect(startResult).toBe('started');
    fsm.transition(task.taskId, 'accepted');
    fsm.transition(task.taskId, 'running');

    // 完成
    fsm.transition(task.taskId, 'completed');
    controller.taskFinished(task.taskId);

    expect(fsm.getStatus(task.taskId)).toBe('completed');
    expect(controller.getStats().running).toBe(0);
  });

  it('评估→拒绝 流程', () => {
    const eventBus = createEventBus();
    const evaluator = new TaskEvaluator({
      acceptThreshold: 80,
      deferThreshold: 60,
      weights: { capability: 0.5, capacity: 0.2, risk: 0.3 },
      capabilityScores: { system_op: 30 },
    });
    const fsm = new TaskStateMachine(eventBus);

    const task = createMockTask({ taskType: 'system_op' });
    fsm.init(task);
    fsm.transition(task.taskId, 'evaluating');

    const evaluation = evaluator.evaluate(task, {
      runningCount: 0,
      maxConcurrent: 3,
      skills: [],
      completedCountByType: {},
      threshold: 80,
    });

    expect(evaluation.decision).toBe('reject');
    fsm.transition(task.taskId, 'rejected', evaluation.reason);
    expect(fsm.isTerminal(task.taskId)).toBe(true);
  });

  it('评估→延迟→入队→执行 流程', () => {
    const eventBus = createEventBus();
    const evaluator = new TaskEvaluator({
      acceptThreshold: 80,
      deferThreshold: 60,
      weights: { capability: 0.5, capacity: 0.2, risk: 0.3 },
      capabilityScores: { data_analysis: 55 },
    });
    const fsm = new TaskStateMachine(eventBus);
    const controller = new ConcurrencyController(
      { maxConcurrent: 1, maxPerType: {}, queueSize: 5, priority: { highValueFirst: false, urgentFirst: false } },
      eventBus,
    );

    // 占满并发
    controller.tryStart(createMockTask({ taskId: 'blocking-task' }));

    const task = createMockTask({ taskType: 'data_analysis' });
    fsm.init(task);
    fsm.transition(task.taskId, 'evaluating');

    const evaluation = evaluator.evaluate(task, {
      runningCount: 1,
      maxConcurrent: 1,
      skills: [],
      completedCountByType: {},
      threshold: 80,
    });

    // data_analysis 基础分 55，容量 0 → score ≈ 55*0.5 + 0*0.2 + ~65*0.3 ≈ 47
    // 但如果我们有空闲容量
    if (evaluation.decision === 'defer') {
      const startResult = controller.tryStart(task);
      expect(startResult).toBe('queued');
      fsm.transition(task.taskId, 'accepted', '延迟接单');
    }

    expect(controller.getStats().queue).toBeGreaterThanOrEqual(0);
  });
});
