#!/usr/bin/env node

/**
 * WorkerClaw CLI 入口
 * 
 * 用法: workerclaw [config-file]
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorkerClaw, type WorkerClawConfig } from './index.js';

// ==================== 环境变量替换 ====================

function resolveEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    // 替换 ${ENV_VAR} 格式的环境变量
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        console.error(`⚠️ 环境变量 ${varName} 未设置`);
        return '';
      }
      return value;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const key of Object.keys(obj)) {
      result[key] = resolveEnvVars(obj[key]);
    }
    return result;
  }
  return obj;
}

// ==================== 主函数 ====================

async function main() {
  // 读取配置文件
  let configPath = process.argv[2];

  if (!configPath) {
    // 默认配置路径
    const defaultPaths = [
      './workerclaw.config.json',
      './config/workerclaw.config.json',
      './config.json',
    ];

    for (const p of defaultPaths) {
      if (existsSync(p)) {
        configPath = p;
        break;
      }
    }
  }

  if (!configPath) {
    console.error('❌ 未找到配置文件。请指定配置文件路径：');
    console.error('   workerclaw ./workerclaw.config.json');
    console.error('');
    console.error('或创建 workerclaw.config.json 配置文件。');
    process.exit(1);
  }

  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    console.error(`❌ 配置文件不存在: ${absPath}`);
    process.exit(1);
  }

  console.log(`📄 加载配置: ${absPath}`);

  let rawConfig: any;
  try {
    rawConfig = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (err) {
    console.error(`❌ 配置文件解析失败: ${err}`);
    process.exit(1);
  }

  // 环境变量替换
  const config = resolveEnvVars(rawConfig) as WorkerClawConfig;

  // 验证必要配置
  if (!config.platform?.wsUrl || !config.platform?.token) {
    console.error('❌ 缺少必要配置: platform.wsUrl 和 platform.token');
    process.exit(1);
  }
  if (!config.llm?.apiKey || !config.llm?.baseUrl) {
    console.error('❌ 缺少必要配置: llm.apiKey 和 llm.baseUrl');
    process.exit(1);
  }

  // 创建并启动 WorkerClaw
  const workerclaw = createWorkerClaw(config);

  // 优雅关闭
  const shutdown = async (signal: string) => {
    console.log(`\n收到 ${signal} 信号，正在关闭...`);
    await workerclaw.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    console.error('未捕获的异常:', err);
    await workerclaw.stop();
    process.exit(1);
  });
  process.on('unhandledRejection', async (reason) => {
    console.error('未处理的 Promise 拒绝:', reason);
  });

  // 启动
  try {
    await workerclaw.start();
  } catch (err) {
    console.error('❌ WorkerClaw 启动失败:', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
