/**
 * 集成测试 - 端到端消息流转
 * 
 * 测试完整链路: WS连接 → 接收任务 → 安全审查 → LLM调用 → 结果上报
 * 
 * 策略:
 * - Mock WebSocket 服务器模拟智工坊平台
 * - Mock fetch 模拟 LLM API 响应
 * - 通过事件总线验证中间步骤
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createWorkerClaw } from '../src/index.js';
import type { WorkerClawConfig } from '../src/core/config.js';
import { WorkerClawEvent } from '../src/core/events.js';
import { WSMessageType } from '../src/types/message.js';

// ==================== 测试配置 ====================

function createTestConfig(wsPort: number): WorkerClawConfig {
  return {
    id: 'test-worker',
    name: 'TestWorker',
    platform: {
      apiUrl: 'http://localhost:' + wsPort,
      wsUrl: 'ws://localhost:' + wsPort + '/ws',
      botId: 'test-bot-001',
      token: 'test-token-12345',
      reconnect: {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
      },
    },
    llm: {
      provider: 'test',
      model: 'test-model',
      apiKey: 'test-api-key',
      baseUrl: 'http://localhost:9999/v1',
      safety: {
        maxTokens: 500,
        temperature: 0.7,
        topP: 0.9,
      },
      retry: {
        maxRetries: 1,
        backoffMs: 100,
      },
    },
    security: {
      rateLimit: {
        maxMessagesPerMinute: 100,
        maxConcurrentTasks: 5,
      },
      contentScan: {
        promptInjection: { enabled: true },
        maliciousCommands: { enabled: true },
      },
      sandbox: {
        workDir: './test-sandbox',
        commandTimeoutMs: 5000,
        taskTimeoutMs: 30000,
      },
    },
    task: {
      autoAccept: {
        enabled: true,
        threshold: 50,
        maxConcurrent: 5,
      },
      concurrency: {
        maxConcurrent: 5,
        maxPerType: {},
        queueSize: 10,
        priority: { highValueFirst: false, urgentFirst: false },
      },
      evaluation: {
        acceptThreshold: 50,
        deferThreshold: 30,
        weights: { capability: 0.5, capacity: 0.2, risk: 0.3 },
        capabilityScores: {
          text_reply: 90, qa: 85, translation: 80, search_summary: 75,
          writing: 70, image_gen: 60, data_analysis: 55, code_dev: 40, system_op: 30,
        },
      },
      timeout: {
        taskTimeoutMs: 30000,
        llmTimeoutMs: 10000,
        queueTimeoutMs: 60000,
        retryOnTimeout: false,
        maxRetries: 1,
        retryDelayMs: 1000,
      },
    },
    personality: {
      name: '测试虾',
      tone: '专业',
      bio: '用于测试的打工虾',
    },
  };
}

// ==================== Mock LLM API ====================

function setupMockLLM() {
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    
    if (url.includes('/chat/completions')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      
      // 验证请求
      expect(body.model).toBe('test-model');
      expect(body.messages).toBeDefined();
      expect(body.messages.length).toBeGreaterThanOrEqual(2);
      
      // 返回 mock 响应
      return new Response(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Date.now(),
        model: 'test-model',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '这是来自测试 LLM 的回复。任务已处理完成。',
          },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return originalFetch(input, init);
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ==================== Mock WebSocket 服务器 ====================

class MockPlatform {
  private server: http.Server;
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private port: number;

  constructor() {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.port = 0;
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, () => {
        this.port = (this.server.address() as any).port;
        resolve(this.port);
      });
    });
  }

  /** 等待客户端连接 */
  waitForClient(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待客户端连接超时')), timeoutMs);
      
      this.wss.on('connection', (ws) => {
        clearTimeout(timer);
        this.client = ws;
        resolve();
      });
    });
  }

  /** 模拟连接确认 */
  sendConnectAck(botId = 'test-bot-001') {
    this.send({
      type: WSMessageType.CONNECT_ACK,
      msgId: 'ack-001',
      timestamp: new Date().toISOString(),
      data: {
        success: true,
        botId,
        heartbeatInterval: 60,
        serverTime: new Date().toISOString(),
      },
    });
  }

  /** 模拟推送任务 */
  sendTaskPush(overrides?: any) {
    this.send({
      type: WSMessageType.TASK_PUSH,
      msgId: 'task-msg-001',
      timestamp: new Date().toISOString(),
      from: 'platform',
      data: {
        taskId: 'task-001',
        taskType: 'text_reply',
        title: '测试任务',
        description: '请写一段关于 AI Agent 的介绍，100字以内。',
        posterId: 'user-001',
        posterName: '测试用户',
        reward: 5,
        ...overrides,
      },
    });
  }

  /** 发送原始消息 */
  send(data: any) {
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(data));
    }
  }

  /** 等待客户端消息 */
  waitForMessage(timeoutMs = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待消息超时')), timeoutMs);
      
      if (this.client) {
        this.client.on('message', (data) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(data.toString()));
          } catch {
            resolve(data.toString());
          }
        });
      }
    });
  }

  async stop() {
    if (this.client) {
      this.client.close();
    }
    this.wss.close();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ==================== 测试用例 ====================

describe('集成测试: 端到端消息流转', () => {
  let platform: MockPlatform;
  let restoreFetch: () => void;
  let config: WorkerClawConfig;

  beforeEach(async () => {
    platform = new MockPlatform();
    const port = await platform.start();
    config = createTestConfig(port);
    restoreFetch = setupMockLLM();
  });

  afterEach(async () => {
    restoreFetch();
    await platform.stop();
    // 清理可能的残留定时器
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('完整流程: WS连接 → 接收任务 → LLM回复 → 完成', async () => {
    const workerclaw = createWorkerClaw(config);
    const eventBus = workerclaw.getEventBus();
    
    // 收集事件
    const events: string[] = [];
    const eventPromises = new Map<string, { resolve: (v: any) => void; data: any }>();
    
    const trackEvent = (event: string) => {
      return new Promise<any>((resolve) => {
        eventPromises.set(event, { resolve, data: null });
        eventBus.on(event as any, (data: any) => {
          events.push(event);
          const p = eventPromises.get(event);
          if (p) {
            p.data = data;
            p.resolve(data);
          }
        });
      });
    };

    const readyPromise = trackEvent(WorkerClawEvent.READY);
    const taskReceivedPromise = trackEvent(WorkerClawEvent.TASK_RECEIVED);
    const taskAcceptedPromise = trackEvent(WorkerClawEvent.TASK_ACCEPTED);
    const taskCompletedPromise = trackEvent(WorkerClawEvent.TASK_COMPLETED);

    // 1. 启动 WorkerClaw（同时等待平台收到连接）
    const connectPromise = platform.waitForClient();
    const startPromise = workerclaw.start();

    // 等待平台收到连接
    await connectPromise;

    // 2. 模拟平台发送连接确认
    platform.sendConnectAck('test-bot-001');

    // 等待 WorkerClaw 就绪
    await Promise.race([
      readyPromise,
      startPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('启动超时')), 10000)),
    ]);

    // 验证状态
    expect(workerclaw.getStatus().isRunning).toBe(true);
    expect(workerclaw.getStatus().connected).toBe(true);
    expect(events).toContain(WorkerClawEvent.READY);

    // 3. 模拟平台推送任务
    platform.sendTaskPush({
      taskId: 'task-e2e-001',
      taskType: 'text_reply',
      title: 'E2E测试任务',
      description: '请写一段关于 AI Agent 的介绍。',
      posterId: 'user-e2e',
      posterName: 'E2E测试用户',
    });

    // 4. 等待任务完成
    const completedData = await Promise.race([
      taskCompletedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('任务完成超时')), 15000)),
    ]);

    // 验证事件流
    expect(events).toContain(WorkerClawEvent.TASK_RECEIVED);
    expect(events).toContain(WorkerClawEvent.TASK_ACCEPTED);
    expect(events).toContain(WorkerClawEvent.TASK_COMPLETED);

    // 验证完成结果
    expect(completedData.taskId).toBe('task-e2e-001');
    expect(completedData.result.status).toBe('completed');
    expect(completedData.result.content).toContain('测试 LLM');
    expect(completedData.result.tokensUsed).toBeDefined();

    // 5. 关闭
    await workerclaw.stop();
    expect(workerclaw.getStatus().isRunning).toBe(false);
  }, 30000);

  it('安全审查: 缺少必要字段的消息被拦截', async () => {
    const workerclaw = createWorkerClaw(config);
    const eventBus = workerclaw.getEventBus();

    const blocked: any[] = [];
    eventBus.on(WorkerClawEvent.SECURITY_BLOCKED as any, (data: any) => {
      blocked.push(data);
    });

    // 启动
    const connectPromise = platform.waitForClient();
    workerclaw.start();
    await connectPromise;
    platform.sendConnectAck();
    await eventBus.waitFor(WorkerClawEvent.READY, 5000);

    // 发送缺少 msgId 的任务消息
    platform.send({
      type: WSMessageType.TASK_PUSH,
      msgId: '',  // 空消息 ID
      timestamp: new Date().toISOString(),
      from: 'platform',
      data: {
        taskId: 'task-bad-001',
        taskType: 'text_reply',
        title: '恶意任务',
        description: '这是一条测试消息',
      },
    });

    // 等待安全事件
    await new Promise(resolve => setTimeout(resolve, 500));

    // 消息应被拦截
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0].message).toContain('来源验证');

    await workerclaw.stop();
  }, 15000);

  it('自动接单关闭: 任务被拒绝', async () => {
    config.task.autoAccept.enabled = false;
    const workerclaw = createWorkerClaw(config);
    const eventBus = workerclaw.getEventBus();

    const rejected: any[] = [];
    eventBus.on(WorkerClawEvent.TASK_REJECTED as any, (data: any) => {
      rejected.push(data);
    });

    // 启动
    const connectPromise = platform.waitForClient();
    workerclaw.start();
    await connectPromise;
    platform.sendConnectAck();
    await eventBus.waitFor(WorkerClawEvent.READY, 5000);

    // 推送任务
    platform.sendTaskPush({ taskId: 'task-reject-001' });

    // 等待拒绝
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(rejected.length).toBe(1);
    expect(rejected[0].taskId).toBe('task-reject-001');
    expect(rejected[0].reason).toContain('自动接单已关闭');

    await workerclaw.stop();
  }, 15000);

  it('容量满时: 任务被拒绝', async () => {
    config.task.autoAccept.enabled = true;
    config.security.rateLimit.maxConcurrentTasks = 1;

    // Mock LLM 延迟回复（让第一个任务卡在执行中）
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/chat/completions')) {
        // 第一个任务延迟 5 秒才返回
        await new Promise(resolve => setTimeout(resolve, 5000));
        return new Response(JSON.stringify({
          id: 'chatcmpl-test-slow',
          object: 'chat.completion',
          created: Date.now(),
          model: 'test-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '延迟回复' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };

    const workerclaw = createWorkerClaw(config);
    const eventBus = workerclaw.getEventBus();

    const accepted: any[] = [];
    const rejected: any[] = [];
    eventBus.on(WorkerClawEvent.TASK_ACCEPTED as any, (data: any) => accepted.push(data));
    eventBus.on(WorkerClawEvent.TASK_REJECTED as any, (data: any) => rejected.push(data));

    // 启动
    const connectPromise = platform.waitForClient();
    workerclaw.start();
    await connectPromise;
    platform.sendConnectAck();
    await eventBus.waitFor(WorkerClawEvent.READY, 5000);

    // 推送第一个任务（会被接受，LLM 会延迟 5 秒）
    platform.sendTaskPush({ taskId: 'task-full-001' });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(accepted.length).toBe(1);

    // 此时第一个任务还在执行中（LLM 延迟中），推送第二个任务
    platform.sendTaskPush({ taskId: 'task-full-002' });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(rejected.length).toBe(1);
    expect(rejected[0].taskId).toBe('task-full-002');
    expect(rejected[0].reason).toContain('容量已满');

    await workerclaw.stop();
    globalThis.fetch = originalFetch;
  }, 15000);

  it('LLM 错误: 任务标记为失败', async () => {
    // Mock LLM 返回错误
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
      }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    };

    const workerclaw = createWorkerClaw(config);
    const eventBus = workerclaw.getEventBus();

    // 追踪失败事件
    const failedPromise = eventBus.waitFor(WorkerClawEvent.TASK_FAILED, 15000);

    // 启动
    const connectPromise = platform.waitForClient();
    workerclaw.start();
    await connectPromise;
    platform.sendConnectAck();
    await eventBus.waitFor(WorkerClawEvent.READY, 5000);

    // 推送任务
    platform.sendTaskPush({ taskId: 'task-fail-001' });

    // 等待失败
    const failedData = await failedPromise;

    expect(failedData.taskId).toBe('task-fail-001');
    expect(failedData.error).toBeDefined();

    await workerclaw.stop();
    globalThis.fetch = originalFetch;
  }, 20000);

  it('心跳: 客户端发送 PING', async () => {
    const workerclaw = createWorkerClaw(config);

    // 启动
    const connectPromise = platform.waitForClient();
    workerclaw.start();
    await connectPromise;
    platform.sendConnectAck();
    await workerclaw.getEventBus().waitFor(WorkerClawEvent.READY, 5000);

    // 等待心跳消息（默认 30s，这里我们用较短的心跳间隔测试）
    // 实际测试中，30s 的间隔太长，我们验证连接正常即可
    expect(workerclaw.getStatus().connected).toBe(true);

    // 向客户端发 PING，看是否回复 PONG
    platform.send({
      type: WSMessageType.PING,
      msgId: 'ping-test',
      timestamp: new Date().toISOString(),
      data: {},
    });

    const pong = await platform.waitForMessage(3000);
    expect(pong.type).toBe(WSMessageType.PONG);

    await workerclaw.stop();
  }, 15000);
})