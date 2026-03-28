/**
 * Phase 5 CLI + 技能包系统测试
 *
 * 覆盖：
 * - PlatformApiClient 注册/测试连接/获取Bot信息
 * - SkillPackRegistry 清单管理
 * - SkillPackLoader 加载与验证
 * - 内置技能完善（metadata + 基本结构）
 * - CLI 配置文件查找
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PlatformApiClient } from '../src/ingress/platform-api.js';
import { SkillPackRegistry } from '../src/skills/pack-registry.js';
import { SkillPackLoader } from '../src/skills/pack-loader.js';
import { getBuiltinSkills } from '../src/skills/builtin/index.js';
import { EventBus } from '../src/core/events.js';

// ==================== 工具函数 ====================

function createTempDir(prefix = 'workerclaw-test-'): string {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ==================== PlatformApiClient ====================

describe('PlatformApiClient', () => {
  let client: PlatformApiClient;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    client = new PlatformApiClient(
      {
        apiUrl: 'https://test.miniabc.top',
        wsUrl: 'wss://test.miniabc.top',
        botId: 'test-bot-001',
        token: 'test-token-abc123',
      },
      eventBus,
    );
  });

  describe('构造函数重载', () => {
    it('应支持 PlatformApiClientConfig 格式', () => {
      const c = new PlatformApiClient(
        {
          platform: {
            apiUrl: 'https://test.miniabc.top',
            wsUrl: 'wss://test.miniabc.top',
            botId: 'bot-1',
            token: 'token-1',
          },
        },
        eventBus,
      );
      expect(c).toBeInstanceOf(PlatformApiClient);
    });

    it('应支持直接传 PlatformConfig 格式', () => {
      const c = new PlatformApiClient({
        apiUrl: 'https://test.miniabc.top',
        wsUrl: 'wss://test.miniabc.top',
        botId: 'bot-1',
        token: 'token-1',
      });
      expect(c).toBeInstanceOf(PlatformApiClient);
    });
  });

  describe('registerAgent', () => {
    it('应成功注册 Agent', async () => {
      const mockResponse = {
        success: true,
        botId: 'bot-new-001',
        token: 'new-token-xyz',
        nickname: '新虾',
        email: 'bot-new@miniabc.top',
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.registerAgent({
        agentId: 'agent-test-001',
        agentName: '测试虾',
        capabilities: ['writing', 'search'],
        autoPostTweet: true,
      });

      expect(result.success).toBe(true);
      expect(result.botId).toBe('bot-new-001');
      expect(result.token).toBe('new-token-xyz');
      expect(result.nickname).toBe('新虾');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.miniabc.top/api/openclaw/register',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    it('应处理注册失败（服务端错误）', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Agent ID 已存在' }),
      });

      const result = await client.registerAgent({
        agentId: 'agent-dup-001',
        capabilities: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent ID 已存在');
    });

    it('应处理注册失败（嵌套 data 格式）', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: { botId: 'bot-nested', token: 'tok-nested' },
        }),
      });

      const result = await client.registerAgent({
        agentId: 'agent-nested',
        capabilities: [],
      });

      expect(result.success).toBe(true);
      expect(result.botId).toBe('bot-nested');
    });

    it('应处理网络错误', async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('网络不通'));

      const result = await client.registerAgent({
        agentId: 'agent-net-err',
        capabilities: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('网络不通');
    });
  });

  describe('testConnection', () => {
    it('应成功测试连接', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
      });

      const result = await client.testConnection();

      expect(result.success).toBe(true);
      expect(result.botId).toBe('test-bot-001');
    });

    it('应处理连接失败', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const result = await client.testConnection();

      expect(result.success).toBe(false);
    });

    it('应处理网络异常', async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await client.testConnection();

      expect(result.success).toBe(false);
    });
  });

  describe('getBotInfo', () => {
    it('应成功获取 Bot 信息', async () => {
      const botInfo = {
        botId: 'test-bot-001',
        nickname: '测试虾',
        email: 'test@miniabc.top',
        level: 5,
        activeDays: 30,
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(botInfo),
      });

      const result = await client.getBotInfo();

      expect(result).toEqual(botInfo);
    });

    it('应在请求失败时返回 null', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await client.getBotInfo();

      expect(result).toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('应成功发送心跳', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });

      const result = await client.heartbeat();
      expect(result).toBe(true);
    });

    it('应在失败时返回 false', async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('timeout'));

      const result = await client.heartbeat();
      expect(result).toBe(false);
    });
  });

  describe('reportResult', () => {
    it('应成功上报任务结果', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });

      const result = await client.reportResult('task-001', {
        status: 'completed',
        content: '任务完成',
        outputs: {},
        tokensUsed: 100,
        durationMs: 2000,
      });

      expect(result).toBe(true);
    });

    it('应处理上报失败', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await client.reportResult('task-002', {
        status: 'failed',
        error: '执行出错',
        outputs: {},
        tokensUsed: 50,
        durationMs: 1000,
      });

      expect(result).toBe(false);
    });
  });

  describe('updateStatus', () => {
    it('应成功更新任务状态', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });

      const result = await client.updateStatus('task-001', 'accepted');
      expect(result).toBe(true);
    });
  });
});

// ==================== SkillPackRegistry ====================

describe('SkillPackRegistry', () => {
  let tempDir: string;
  let manifestPath: string;
  let registry: SkillPackRegistry;

  beforeEach(() => {
    tempDir = createTempDir();
    manifestPath = join(tempDir, 'skills.json');
    registry = new SkillPackRegistry(manifestPath);
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('应创建空的清单文件', () => {
    expect(existsSync(manifestPath)).toBe(false);
    // registry 在构造时不会创建文件，只在操作时创建
    expect(registry.list()).toEqual([]);
  });

  it('应添加技能包并持久化', () => {
    registry.add({
      source: '@test/my-skill',
      name: 'my-skill',
      version: '1.0.0',
      installedAt: '2026-03-28T00:00:00Z',
    });

    expect(registry.list()).toHaveLength(1);
    expect(registry.has('@test/my-skill')).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    // 验证持久化内容
    const content = JSON.parse(
      require('node:fs').readFileSync(manifestPath, 'utf-8'),
    );
    expect(content.installed[0].source).toBe('@test/my-skill');
  });

  it('应防止重复添加同 source 的技能包', () => {
    registry.add({
      source: '@test/my-skill',
      version: '1.0.0',
      installedAt: '2026-03-28T00:00:00Z',
    });
    registry.add({
      source: '@test/my-skill',
      version: '1.1.0',
      installedAt: '2026-03-28T01:00:00Z',
    });

    expect(registry.list()).toHaveLength(1);
    expect(registry.find('@test/my-skill')!.version).toBe('1.1.0');
  });

  it('应移除技能包', () => {
    registry.add({
      source: '@test/skill-a',
      version: '1.0.0',
      installedAt: '2026-03-28T00:00:00Z',
    });
    registry.add({
      source: '@test/skill-b',
      version: '2.0.0',
      installedAt: '2026-03-28T00:00:00Z',
    });

    const removed = registry.remove('@test/skill-a');
    expect(removed).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(registry.has('@test/skill-a')).toBe(false);
  });

  it('应在移除不存在的包时返回 false', () => {
    const removed = registry.remove('@test/nonexistent');
    expect(removed).toBe(false);
  });

  it('应查找技能包', () => {
    registry.add({
      source: '@test/findable',
      name: 'findable-skill',
      description: '可以找到的技能包',
      version: '1.0.0',
      installedAt: '2026-03-28T00:00:00Z',
    });

    const found = registry.find('@test/findable');
    expect(found).toBeDefined();
    expect(found!.name).toBe('findable-skill');

    const notFound = registry.find('@test/missing');
    expect(notFound).toBeUndefined();
  });

  it('应处理损坏的清单文件', () => {
    writeFileSync(manifestPath, 'INVALID JSON{{{', 'utf-8');
    const reg = new SkillPackRegistry(manifestPath);
    expect(reg.list()).toEqual([]);
  });

  it('应从已有清单文件恢复', () => {
    const existing = {
      installed: [
        {
          source: '@test/persisted',
          version: '1.0.0',
          installedAt: '2026-03-28T00:00:00Z',
        },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(existing), 'utf-8');

    const reg = new SkillPackRegistry(manifestPath);
    expect(reg.list()).toHaveLength(1);
    expect(reg.has('@test/persisted')).toBe(true);
  });
});

// ==================== SkillPackLoader ====================

describe('SkillPackLoader', () => {
  let loader: SkillPackLoader;

  beforeEach(() => {
    loader = new SkillPackLoader();
  });

  describe('validateAndNormalize（通过 loadFromNpm）', () => {
    it('应拒绝无效的技能包', async () => {
      await expect(loader.load('@nonexistent/package-xyz')).rejects.toThrow();
    });

    it('应拒绝缺少 skills 的模块', async () => {
      // Mock dynamic import
      vi.mock('@test/empty-pack', () => ({
        default: { name: 'empty', version: '1.0.0' },
      }), { virtual: true });

      await expect(loader.load('@test/empty-pack')).rejects.toThrow('没有提供任何技能');
    });

    it('应拒绝技能缺少 metadata.name 的包', async () => {
      vi.mock('@test/bad-skill', () => ({
        default: {
          name: 'bad',
          skills: [{ execute: () => {} }],
        },
      }), { virtual: true });

      await expect(loader.load('@test/bad-skill')).rejects.toThrow('缺少 metadata.name');
    });
  });

  describe('loadFromPath', () => {
    it('应从本地目录加载技能包', async () => {
      const tempDir = createTempDir('skill-load-');
      const mainFile = join(tempDir, 'index.mjs');
      writeFileSync(mainFile, `
        export default {
          name: 'local-skill',
          version: '1.0.0',
          description: '本地技能包',
          skills: [{
            metadata: { name: 'local', displayName: '本地技能' },
            async execute() { return { success: true, content: 'ok' }; }
          }]
        };
      `, 'utf-8');

      try {
        const pack = await loader.load(tempDir);
        expect(pack.name).toBe('local-skill');
        expect(pack.skills).toHaveLength(1);
        expect(pack.skills[0].metadata.name).toBe('local');
      } finally {
        cleanupDir(tempDir);
      }
    });

    it('应从 skill.json 读取元数据', async () => {
      const tempDir = createTempDir('skill-json-');
      writeFileSync(join(tempDir, 'skill.json'), JSON.stringify({
        name: 'json-skill',
        version: '2.0.0',
        description: '通过 skill.json 定义',
      }), 'utf-8');
      writeFileSync(join(tempDir, 'index.mjs'), `
        export default {
          skills: [{
            metadata: { name: 'json-skill-main' },
            async execute() { return { success: true }; }
          }]
        };
      `, 'utf-8');

      try {
        const pack = await loader.load(tempDir);
        expect(pack.name).toBe('json-skill');
        expect(pack.version).toBe('2.0.0');
      } finally {
        cleanupDir(tempDir);
      }
    });

    it('应在目录无清单文件时报错', async () => {
      const tempDir = createTempDir('skill-empty-');

      try {
        await expect(loader.load(tempDir)).rejects.toThrow('未找到 skill.json 或 package.json');
      } finally {
        cleanupDir(tempDir);
      }
    });

    it('应支持 skills 为对象格式', async () => {
      const tempDir = createTempDir('skill-obj-');
      writeFileSync(join(tempDir, 'index.mjs'), `
        const skillA = {
          metadata: { name: 'skill-a' },
          async execute() { return { success: true }; }
        };
        const skillB = {
          metadata: { name: 'skill-b' },
          async execute() { return { success: true }; }
        };
        export default {
          name: 'multi-skill',
          skills: { a: skillA, b: skillB }
        };
      `, 'utf-8');

      try {
        const pack = await loader.load(tempDir);
        expect(pack.skills).toHaveLength(2);
      } finally {
        cleanupDir(tempDir);
      }
    });
  });

  describe('loadFromDirectory', () => {
    it('应扫描目录下所有含 skill.json 的子目录', async () => {
      const parentDir = createTempDir('skill-scan-');

      // 创建两个有效的技能包子目录
      for (const name of ['alpha', 'beta']) {
        const subDir = join(parentDir, name);
        mkdirSync(subDir, { recursive: true });
        writeFileSync(join(subDir, 'skill.json'), JSON.stringify({
          name: `skill-${name}`,
          version: '1.0.0',
        }), 'utf-8');
        writeFileSync(join(subDir, 'index.mjs'), `
          export default {
            skills: [{
              metadata: { name: '${name}' },
              async execute() { return { success: true }; }
            }]
          };
        `, 'utf-8');
      }

      // 创建一个不含 skill.json 的目录（应被跳过）
      mkdirSync(join(parentDir, 'empty'), { recursive: true });

      try {
        const packs = await loader.loadFromDirectory(parentDir);
        expect(packs).toHaveLength(2);
        expect(packs.map(p => p.name)).toContain('skill-alpha');
        expect(packs.map(p => p.name)).toContain('skill-beta');
      } finally {
        cleanupDir(parentDir);
      }
    });

    it('应跳过加载失败的子目录', async () => {
      const parentDir = createTempDir('skill-skip-');

      // 创建一个有损坏 index.mjs 的子目录
      const badDir = join(parentDir, 'bad');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, 'skill.json'), JSON.stringify({
        name: 'bad-skill',
        version: '1.0.0',
      }), 'utf-8');
      writeFileSync(join(badDir, 'index.mjs'), 'INVALID JS CONTENT {{{', 'utf-8');

      try {
        const packs = await loader.loadFromDirectory(parentDir);
        expect(packs).toHaveLength(0); // 加载失败被跳过
      } finally {
        cleanupDir(parentDir);
      }
    });

    it('应处理不存在的目录', async () => {
      const packs = await loader.loadFromDirectory('/nonexistent/path/xyz');
      expect(packs).toHaveLength(0);
    });
  });
});

// ==================== 内置技能 ====================

describe('内置技能', () => {
  let builtins: ReturnType<typeof getBuiltinSkills>;

  beforeEach(() => {
    builtins = getBuiltinSkills();
  });

  it('应有 3 个内置技能', () => {
    expect(builtins).toHaveLength(3);
  });

  it('每个技能应有完整的 metadata', () => {
    for (const skill of builtins) {
      expect(skill.metadata.name).toBeTruthy();
      expect(skill.metadata.displayName).toBeTruthy();
      expect(skill.metadata.version).toBeTruthy();
      expect(skill.metadata.description).toBeTruthy();
      expect(skill.metadata.requiredLevel).toBeTruthy();
      expect(Array.isArray(skill.metadata.applicableTaskTypes)).toBe(true);
      expect(skill.metadata.applicableTaskTypes!.length).toBeGreaterThan(0);
    }
  });

  it('每个技能应有 execute 方法', () => {
    for (const skill of builtins) {
      expect(typeof skill.execute).toBe('function');
    }
  });

  it('写作助手应处理文本创作任务', async () => {
    const writer = builtins.find(s => s.metadata.name === 'writing')!;
    expect(writer).toBeDefined();
    expect(writer.metadata.displayName).toContain('写作');
    expect(writer.metadata.requiredLevel).toBe('read_only');
  });

  it('搜索助手应处理搜索任务', async () => {
    const searcher = builtins.find(s => s.metadata.name === 'search')!;
    expect(searcher).toBeDefined();
    expect(searcher.metadata.displayName).toContain('搜索');
    expect(searcher.metadata.requiredLevel).toBe('limited');
  });

  it('代码助手应处理代码任务', async () => {
    const coder = builtins.find(s => s.metadata.name === 'code')!;
    expect(coder).toBeDefined();
    expect(coder.metadata.displayName).toContain('代码');
    expect(coder.metadata.requiredLevel).toBe('elevated');
  });

  it('技能名称应唯一', () => {
    const names = builtins.map(s => s.metadata.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ==================== 类型导出验证 ====================

describe('公共 API 导出', () => {
  it('应导出 SkillPackLoader', async () => {
    const mod = await import('../src/skills/pack-loader.js');
    expect(mod.SkillPackLoader).toBeDefined();
  });

  it('应导出 SkillPackRegistry', async () => {
    const mod = await import('../src/skills/pack-registry.js');
    expect(mod.SkillPackRegistry).toBeDefined();
  });

  it('应导出 PlatformApiClient', async () => {
    const mod = await import('../src/ingress/platform-api.js');
    expect(mod.PlatformApiClient).toBeDefined();
    expect(mod.RegisterAgentParams).toBeUndefined(); // interface 不作为值导出
    expect(mod.RegisterAgentResult).toBeUndefined();
  });

  it('应导出技能包类型', async () => {
    const mod = await import('../src/skills/pack-types.js');
    expect(mod.SkillPackMeta).toBeUndefined(); // interface
    expect(mod.InstalledSkillPack).toBeUndefined(); // interface
    // 类型接口在 TS 编译时存在，运行时不存在
  });
});

// ==================== 集成测试 ====================

describe('Registry + Loader 集成', () => {
  let tempDir: string;
  let manifestPath: string;

  beforeEach(() => {
    tempDir = createTempDir('integ-');
    manifestPath = join(tempDir, 'skills.json');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('应完成 安装→记录→列出→卸载 完整流程', async () => {
    const registry = new SkillPackRegistry(manifestPath);

    // 模拟安装
    registry.add({
      source: '@test/integration-skill',
      name: 'integration-skill',
      description: '集成测试技能包',
      version: '1.0.0',
      installedAt: '2026-03-28T00:00:00Z',
    });

    // 列出
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe('@test/integration-skill');

    // 查找
    const found = registry.find('@test/integration-skill');
    expect(found?.version).toBe('1.0.0');

    // 卸载
    const removed = registry.remove('@test/integration-skill');
    expect(removed).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it('应支持更新已安装的技能包', () => {
    const registry = new SkillPackRegistry(manifestPath);

    registry.add({
      source: '@test/updatable',
      version: '1.0.0',
      installedAt: '2026-03-28T00:00:00Z',
    });

    registry.add({
      source: '@test/updatable',
      version: '2.0.0',
      installedAt: '2026-03-28T01:00:00Z',
    });

    expect(registry.list()).toHaveLength(1);
    expect(registry.find('@test/updatable')!.version).toBe('2.0.0');
  });
});
