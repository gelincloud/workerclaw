/**
 * Phase 4 智能行为测试
 *
 * 覆盖：人格系统、上下文窗口、会话管理、技能系统、频率控制、行为调度器
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Personality } from '../src/agent/personality.js';
import { ContextWindow } from '../src/agent/context-window.js';
import { SessionManager } from '../src/agent/session-manager.js';
import { SkillRegistry } from '../src/skills/skill-registry.js';
import { SkillRunner } from '../src/skills/skill-runner.js';
import { FrequencyController } from '../src/active-behavior/frequency-control.js';
import { BehaviorScheduler } from '../src/active-behavior/behavior-scheduler.js';
import type { PersonalityConfig } from '../src/agent/personality.js';
import type { LLMMessage } from '../src/types/agent.js';
import type { Task } from '../src/types/task.js';

// ==================== Mock 数据 ====================

const basePersonality: PersonalityConfig = {
  name: '测试虾',
  bio: '一个测试用的打工虾',
  tone: '轻松、幽默',
  description: '这是测试用的 AI Agent 人格',
  expertise: ['写作', '翻译'],
  language: '中文',
  behavior: { proactivity: 0.7, humor: 0.6, formality: 0.3 },
};

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    taskId: 'test-task-001',
    taskType: 'text_reply',
    title: '测试任务',
    description: '这是一个测试任务描述',
    posterName: '测试用户',
    posterId: 'user-001',
    reward: 10,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ==================== 人格系统 ====================

describe('人格系统', () => {
  let personality: Personality;

  beforeEach(() => {
    personality = new Personality(basePersonality);
  });

  it('基本属性', () => {
    expect(personality.getName()).toBe('测试虾');
    expect(personality.getConfig().tone).toBe('轻松、幽默');
    expect(personality.getConfig().expertise).toEqual(['写作', '翻译']);
  });

  it('默认值填充', () => {
    const minimal = new Personality({ name: 'A', bio: 'B', tone: 'C' });
    expect(minimal.getConfig().behavior!.proactivity).toBe(0.5);
    expect(minimal.getConfig().language).toBe('中文');
    expect(minimal.getConfig().expertise).toEqual([]);
  });

  it('生成系统提示 - 包含人格信息', () => {
    const prompt = personality.buildSystemPrompt({
      permissionLevel: 'standard',
      maxOutputTokens: 4000,
      timeoutMs: 300000,
    });

    expect(prompt).toContain('测试虾');
    expect(prompt).toContain('轻松、幽默');
    expect(prompt).toContain('standard');
    expect(prompt).toContain('4000');
    expect(prompt).toContain('严禁');
  });

  it('系统提示 - 包含可用工具', () => {
    const prompt = personality.buildSystemPrompt({
      permissionLevel: 'read_only',
      maxOutputTokens: 2000,
      timeoutMs: 60000,
      availableTools: ['llm_query', 'web_search'],
    });

    expect(prompt).toContain('llm_query');
    expect(prompt).toContain('web_search');
  });

  it('系统提示 - 包含当前日期', () => {
    const date = '2026-03-28';
    const prompt = personality.buildSystemPrompt({
      permissionLevel: 'limited',
      maxOutputTokens: 4000,
      timeoutMs: 300000,
      currentDate: date,
    });

    expect(prompt).toContain(date);
  });

  it('系统提示 - 包含自定义附加内容', () => {
    const custom = new Personality({
      ...basePersonality,
      customSystemPrompt: '特别注意：回复中必须包含emoji',
    });

    const prompt = custom.buildSystemPrompt({
      permissionLevel: 'standard',
      maxOutputTokens: 4000,
      timeoutMs: 300000,
    });

    expect(prompt).toContain('emoji');
  });

  it('生成活跃行为提示 - 推文', () => {
    const prompt = personality.buildActiveBehaviorPrompt('tweet');
    expect(prompt).toContain('发布一条推文');
    expect(prompt).toContain('测试虾');
    expect(prompt).toContain('幽默');
  });

  it('生成活跃行为提示 - 浏览', () => {
    const prompt = personality.buildActiveBehaviorPrompt('browse');
    expect(prompt).toContain('浏览平台内容');
  });

  it('活跃度标签', () => {
    const low = new Personality({ ...basePersonality, behavior: { proactivity: 0.1, humor: 0, formality: 0.5 } });
    const mid = new Personality({ ...basePersonality, behavior: { proactivity: 0.5, humor: 0, formality: 0.5 } });
    const high = new Personality({ ...basePersonality, behavior: { proactivity: 0.9, humor: 0, formality: 0.5 } });

    expect(low.getProactivityLabel()).toBe('低调型');
    expect(mid.getProactivityLabel()).toBe('平衡型');
    expect(high.getProactivityLabel()).toBe('热情型');
  });
});

// ==================== 上下文窗口 ====================

describe('上下文窗口', () => {
  let ctx: ContextWindow;

  beforeEach(() => {
    ctx = new ContextWindow({
      maxTokens: 200,
      systemReserveTokens: 50,
      keepRecentMessages: 2,
      tokenEstimateFactor: 1.0,
      truncationStrategy: 'oldest',
    });
  });

  it('估算 token', () => {
    const msg: LLMMessage = { role: 'user', content: 'Hello world' };
    expect(ctx.estimateTokens(msg)).toBeGreaterThan(5);
  });

  it('不截断时正常返回', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ];

    const { messages: result, stats } = ctx.fitToWindow(messages);
    expect(result.length).toBe(3);
    expect(stats.isTruncated).toBe(false);
  });

  it('超出窗口时截断旧消息', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'A'.repeat(100) },
      { role: 'user', content: 'B'.repeat(80) },
      { role: 'assistant', content: 'C'.repeat(80) },
      { role: 'user', content: 'D'.repeat(80) },
      { role: 'assistant', content: 'E'.repeat(80) },
    ];

    const { messages: result, stats } = ctx.fitToWindow(messages);
    // 系统消息始终保留
    expect(result[0].role).toBe('system');
    // 最近 2 条用户/助手消息保留
    expect(stats.isTruncated).toBe(true);
  });

  it('获取统计信息', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' },
    ];

    const stats = ctx.getStats(messages);
    expect(stats.systemTokens).toBeGreaterThan(0);
    expect(stats.conversationTokens).toBeGreaterThan(0);
    expect(stats.messageCount).toBe(2);
  });

  it('middle 截断策略', () => {
    const midCtx = new ContextWindow({
      maxTokens: 100,
      keepRecentMessages: 1,
      tokenEstimateFactor: 1.0,
      truncationStrategy: 'middle',
    });

    const messages: LLMMessage[] = [
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Second' },
      { role: 'user', content: 'Third' },
      { role: 'assistant', content: 'Fourth' },
    ];

    const { stats } = midCtx.fitToWindow(messages);
    expect(stats.isTruncated).toBe(true);
  });
});

// ==================== 会话管理 ====================

describe('会话管理', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager({
      maxActiveSessions: 10,
      sessionTTL: 60000,
      contextWindow: { maxTokens: 1000 },
    });
  });

  it('创建和获取会话', () => {
    const session = sm.createSession('task-1', 'System prompt');
    expect(session.id).toBe('task-1');
    expect(session.messages.length).toBe(1); // 系统提示
    expect(session.messages[0].content).toBe('System prompt');

    const retrieved = sm.getSession('task-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('task-1');
  });

  it('添加消息', () => {
    sm.createSession('task-2', 'System prompt');
    sm.addMessage('task-2', { role: 'user', content: 'Hello' });

    const session = sm.getSession('task-2')!;
    expect(session.messages.length).toBe(2);
    expect(session.turnCount).toBe(1);
    expect(session.totalTokensUsed).toBeGreaterThan(0);
  });

  it('适配消息到上下文窗口', () => {
    sm.createSession('task-3', 'System');
    sm.addMessage('task-3', { role: 'user', content: 'A'.repeat(200) });
    sm.addMessage('task-3', { role: 'assistant', content: 'B'.repeat(200) });
    sm.addMessage('task-3', { role: 'user', content: 'C'.repeat(200) });

    const { messages, stats } = sm.getFittedMessages('task-3');
    expect(messages.length).toBeGreaterThan(0);
    expect(stats.messageCount).toBeGreaterThan(0);
  });

  it('标记完成和清理', () => {
    sm.createSession('task-4');
    sm.completeSession('task-4');

    const session = sm.getSession('task-4')!;
    expect(session.completed).toBe(true);

    expect(sm.deleteSession('task-4')).toBe(true);
    expect(sm.hasSession('task-4')).toBe(false);
  });

  it('获取统计', () => {
    sm.createSession('task-5', 'System');
    sm.addMessage('task-5', { role: 'user', content: 'Hello' });
    sm.completeSession('task-5');
    sm.createSession('task-6', 'System');

    const stats = sm.getStats();
    expect(stats.totalSessions).toBe(2);
    expect(stats.activeSessions).toBe(1);
    expect(stats.completedSessions).toBe(1);
  });

  it('活跃会话 ID 列表', () => {
    sm.createSession('task-7');
    sm.createSession('task-8');
    sm.completeSession('task-7');

    const ids = sm.getActiveSessionIds();
    expect(ids).toContain('task-8');
    expect(ids).not.toContain('task-7');
  });

  it('会话统计详情', () => {
    sm.createSession('task-9', 'System');
    sm.addMessage('task-9', { role: 'user', content: 'Test' });

    const stats = sm.getSessionStats('task-9');
    expect(stats).not.toBeNull();
    expect(stats!.messageCount).toBe(2);
    expect(stats!.turnCount).toBe(1);
  });
});

// ==================== 技能注册表 ====================

describe('技能注册表', () => {
  let registry: SkillRegistry;

  const mockSkill = {
    metadata: {
      name: 'test-skill',
      displayName: '测试技能',
      description: '测试用技能',
      version: '1.0.0',
      tags: ['test'],
      requiredLevel: 'read_only' as const,
      applicableTaskTypes: ['text_reply'],
      requiredTools: ['llm_query'],
    },
    async execute() {
      return {
        success: true,
        content: 'test',
        outputs: [],
        durationMs: 10,
      };
    },
  };

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it('注册和获取技能', () => {
    registry.register(mockSkill);
    expect(registry.hasSkill('test-skill')).toBe(true);
    expect(registry.getSkill('test-skill')).toBe(mockSkill);
  });

  it('注销技能', () => {
    registry.register(mockSkill);
    expect(registry.unregister('test-skill')).toBe(true);
    expect(registry.hasSkill('test-skill')).toBe(false);
  });

  it('按任务类型和权限匹配', async () => {
    registry.register(mockSkill);
    await registry.initializeAll();
    const task = createMockTask({ taskType: 'text_reply' });
    const skills = registry.getApplicableSkills(task, 'read_only');
    expect(skills.length).toBe(1);
  });

  it('权限不足时不可用', async () => {
    registry.register(mockSkill);
    await registry.initializeAll();
    // 但技能是 read_only，权限也是 read_only，应该可用
    const task = createMockTask({ taskType: 'text_reply' });
    const skills = registry.getApplicableSkills(task, 'read_only');
    expect(skills.length).toBe(1);
  });

  it('任务类型不匹配', async () => {
    registry.register(mockSkill);
    await registry.initializeAll();
    const task = createMockTask({ taskType: 'code_dev' });
    const skills = registry.getApplicableSkills(task, 'elevated');
    expect(skills.length).toBe(0);
  });

  it('适用所有类型（空数组）', async () => {
    const universalSkill = {
      ...mockSkill,
      metadata: {
        ...mockSkill.metadata,
        name: 'universal',
        applicableTaskTypes: [],
      },
    };
    registry.register(universalSkill);
    await registry.initializeAll();
    const task = createMockTask({ taskType: 'image_gen' });
    const skills = registry.getApplicableSkills(task, 'read_only');
    expect(skills.length).toBe(1);
  });

  it('获取元数据列表', () => {
    registry.register(mockSkill);
    const metas = registry.getAllMetadata();
    expect(metas.length).toBe(1);
    expect(metas[0].name).toBe('test-skill');
  });

  it('统计信息', () => {
    registry.register(mockSkill);
    const stats = registry.getStats();
    expect(stats.total).toBe(1);
    expect(stats.byLevel.read_only).toBe(1);
  });

  it('初始化所有技能', async () => {
    const initSkill = {
      ...mockSkill,
      metadata: { ...mockSkill.metadata, name: 'init-skill' },
      init: async () => {},
    };
    registry.register(initSkill);
    const result = await registry.initializeAll();
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
  });
});

// ==================== 技能执行器 ====================

describe('技能执行器', () => {
  it('查找匹配技能', async () => {
    const registry = new SkillRegistry();
    registry.register({
      metadata: {
        name: 'writer',
        displayName: '写作',
        description: '写作技能',
        version: '1.0.0',
        tags: [],
        requiredLevel: 'read_only',
        applicableTaskTypes: ['writing'],
        requiredTools: [],
      },
      async execute() {
        return { success: true, content: '', outputs: [], durationMs: 0 };
      },
    });
    await registry.initializeAll();

    const runner = new SkillRunner(registry);
    const task = createMockTask({ taskType: 'writing' });
    const skill = runner.findBestSkill(task, 'standard');
    expect(skill).not.toBeNull();
    expect(skill!.metadata.name).toBe('writer');
  });

  it('无匹配技能', () => {
    const runner = new SkillRunner(new SkillRegistry());
    const task = createMockTask({ taskType: 'code_dev' });
    const skill = runner.findBestSkill(task, 'elevated');
    expect(skill).toBeNull();
  });
});

// ==================== 频率控制器 ====================

describe('频率控制器', () => {
  let fc: FrequencyController;

  beforeEach(() => {
    fc = new FrequencyController({
      limits: {
        tweet: {
          minIntervalMs: 1000,
          maxIntervalMs: 10000,
          maxPerHour: 5,
          maxPerDay: 20,
        },
        like: {
          minIntervalMs: 100,
          maxIntervalMs: 5000,
          maxPerHour: 50,
          maxPerDay: 200,
        },
      },
      dailyLimit: 50,
    });
  });

  it('初始状态允许执行', () => {
    expect(fc.canPerform('tweet').allowed).toBe(true);
    expect(fc.canPerform('like').allowed).toBe(true);
  });

  it('记录后检查最小间隔', () => {
    fc.record('tweet');
    // tweet 最小间隔 1000ms
    const check = fc.canPerform('tweet');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('等待');
  });

  it('未配置的行为类型始终允许', () => {
    expect(fc.canPerform('browse').allowed).toBe(true);
    expect(fc.canPerform('comment').allowed).toBe(true);
  });

  it('shouldAct - 从未执行过', () => {
    expect(fc.shouldAct('tweet')).toBe(true);
  });

  it('shouldAct - 刚执行过', () => {
    fc.record('tweet');
    expect(fc.shouldAct('tweet')).toBe(false);
  });

  it('获取统计', () => {
    fc.record('tweet');
    fc.record('like');
    const stats = fc.getStats();
    expect(stats.today.tweet).toBe(1);
    expect(stats.today.like).toBe(1);
    expect(stats.totalToday).toBe(2);
  });

  it('getNextSuggested - 有建议', () => {
    const suggestion = fc.getNextSuggested();
    expect(suggestion).not.toBeNull();
    expect(['tweet', 'like', 'browse', 'comment']).toContain(suggestion!.type);
    expect(suggestion!.urgency).toBeGreaterThan(0);
  });

  it('getTimeUntilNext', () => {
    fc.record('tweet');
    const wait = fc.getTimeUntilNext('tweet');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1000);
  });
});

// ==================== 行为调度器 ====================

describe('行为调度器', () => {
  it('启用状态', async () => {
    const { EventBus } = await import('../src/core/events.js');
    const personality = new Personality(basePersonality);
    const scheduler = new BehaviorScheduler(
      {
        enabled: false,
        checkIntervalMs: 60000,
        minIdleTimeMs: 60000,
        frequency: {},
        weights: { tweet: 25, browse: 25, comment: 25, like: 25 },
      },
      personality,
      {
        provider: 'test',
        model: 'test',
        apiKey: 'test',
        baseUrl: 'http://localhost',
        safety: { maxTokens: 100, temperature: 0.7, topP: 0.9 },
        retry: { maxRetries: 1, backoffMs: 1000 },
      },
      new EventBus(),
    );
    // 禁用时 start 不应报错
    scheduler.start();
    scheduler.stop();
    scheduler.dispose();
  });
});

// ==================== 内置技能 ====================

describe('内置技能', () => {
  it('写作技能元数据', async () => {
    const { getBuiltinSkills } = await import('../src/skills/builtin/index.js');
    const skills = getBuiltinSkills();
    expect(skills.length).toBe(3);

    const writer = skills.find(s => s.metadata.name === 'writing');
    expect(writer).toBeDefined();
    expect(writer!.metadata.requiredLevel).toBe('read_only');
    expect(writer!.metadata.applicableTaskTypes).toContain('text_reply');
  });

  it('搜索技能元数据', async () => {
    const { getBuiltinSkills } = await import('../src/skills/builtin/index.js');
    const skills = getBuiltinSkills();

    const searcher = skills.find(s => s.metadata.name === 'search');
    expect(searcher).toBeDefined();
    expect(searcher!.metadata.requiredLevel).toBe('limited');
  });

  it('代码技能元数据', async () => {
    const { getBuiltinSkills } = await import('../src/skills/builtin/index.js');
    const skills = getBuiltinSkills();

    const coder = skills.find(s => s.metadata.name === 'code');
    expect(coder).toBeDefined();
    expect(coder!.metadata.requiredLevel).toBe('elevated');
  });

  it('技能系统提示', async () => {
    const { getBuiltinSkills } = await import('../src/skills/builtin/index.js');
    const skills = getBuiltinSkills();

    for (const skill of skills) {
      if (skill.getSystemPromptAddon) {
        const addon = skill.getSystemPromptAddon();
        expect(addon).toBeTruthy();
        expect(addon.length).toBeGreaterThan(0);
      }
    }
  });
});
