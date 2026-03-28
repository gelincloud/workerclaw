#!/usr/bin/env node

/**
 * WorkerClaw CLI 入口
 * 
 * 基于 citty 的命令行框架
 * 
 * 用法:
 *   workerclaw configure              # 交互式配置向导
 *   workerclaw configure --section llm # 配置指定区域
 *   workerclaw start [config-file]    # 启动 WorkerClaw
 *   workerclaw status                 # 查看状态
 *   workerclaw skills list             # 列出技能
 *   workerclaw skills install <pkg>    # 安装技能包
 *   workerclaw skills uninstall <name> # 卸载技能包
 */

import { defineCommand, runMain } from 'citty';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== 环境变量替换 ====================

function resolveEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || '';
    });
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const key of Object.keys(obj)) {
      result[key] = resolveEnvVars(obj[key]);
    }
    return result;
  }
  return obj;
}

// ==================== 配置文件查找 ====================

function findConfigPath(explicitPath?: string): string | null {
  if (explicitPath) {
    const abs = resolve(explicitPath);
    return existsSync(abs) ? abs : null;
  }

  // 按优先级查找
  const searchPaths = [
    './workerclaw.config.json',
    './config/workerclaw.config.json',
    './config.json',
    `${homedir()}/.workerclaw/config.json`,
  ];

  for (const p of searchPaths) {
    if (existsSync(p)) return resolve(p);
  }

  return null;
}

// ==================== 主命令 ====================

const main = defineCommand({
  meta: {
    name: 'workerclaw',
    version: '0.2.0',
    description: 'WorkerClaw - 公域 AI Agent 框架，专为智工坊平台的「打工虾」设计',
  },
  subCommands: {
    // 配置命令
    configure: defineCommand({
      meta: {
        name: 'configure',
        description: '交互式配置向导',
      },
      args: {
        section: {
          type: 'string',
          description: '配置区域 (platform/llm/personality/security)',
          alias: 's',
        },
        'config-file': {
          type: 'string',
          description: '配置文件路径',
          alias: 'c',
        },
      },
      async run({ args }) {
        const { configureWizard, DEFAULT_CONFIG_PATH } = await import('./configure.js');
        const configPath = args['config-file'] as string || DEFAULT_CONFIG_PATH;
        await configureWizard(args.section as string, configPath);
      },
    }),

    // 启动命令
    start: defineCommand({
      meta: {
        name: 'start',
        description: '启动 WorkerClaw',
      },
      args: {
        'config-file': {
          type: 'string',
          description: '配置文件路径',
          alias: 'c',
        },
      },
      async run({ args }) {
        const configPath = findConfigPath(args['config-file'] as string);

        if (!configPath) {
          console.error('❌ 未找到配置文件。请先运行配置向导：');
          console.error('   workerclaw configure');
          process.exit(1);
        }

        console.log(`📄 加载配置: ${configPath}`);

        let rawConfig: any;
        try {
          rawConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        } catch (err) {
          console.error(`❌ 配置文件解析失败: ${err}`);
          process.exit(1);
        }

        const config = resolveEnvVars(rawConfig);

        // 验证必要配置
        if (!config.platform?.wsUrl || !config.platform?.token) {
          console.error('❌ 缺少必要配置: platform.wsUrl 和 platform.token');
          console.error('   运行 workerclaw configure 重新配置');
          process.exit(1);
        }
        if (!config.llm?.apiKey || !config.llm?.baseUrl) {
          console.error('❌ 缺少必要配置: llm.apiKey 和 llm.baseUrl');
          console.error('   运行 workerclaw configure 重新配置');
          process.exit(1);
        }

        // 动态导入核心模块
        const { createWorkerClaw } = await import('../index.js');
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
      },
    }),

    // 状态命令
    status: defineCommand({
      meta: {
        name: 'status',
        description: '查看 WorkerClaw 状态',
      },
      async run() {
        const configPath = findConfigPath();

        if (!configPath) {
          console.log('❌ 未找到配置文件');
          console.log('   运行 workerclaw configure 进行配置');
          return;
        }

        console.log(`📄 配置文件: ${configPath}`);

        try {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'));

          // 隐藏敏感信息
          if (config.platform?.token) {
            config.platform.token = config.platform.token.slice(0, 8) + '...';
          }
          if (config.llm?.apiKey) {
            config.llm.apiKey = config.llm.apiKey.slice(0, 8) + '...';
          }

          console.log('\n📋 配置概览:');
          console.log(`  实例名称: ${config.name || '未设置'}`);
          console.log(`  Agent 名称: ${config.personality?.name || '未设置'}`);
          console.log(`  平台: ${config.platform?.botId || '未配置'}`);
          console.log(`  LLM: ${config.llm?.provider || '未配置'} / ${config.llm?.model || '未知'}`);
          console.log(`  安全级别: ${config.security?.contentScan?.promptInjection?.enabled ? '已启用' : '未启用'} 内容扫描`);
          console.log(`  智能活跃: ${config.activeBehavior?.enabled ? '已启用' : '未启用'}`);

          // 技能状态
          const { getBuiltinSkills } = await import('../skills/builtin/index.js');
          const builtins = getBuiltinSkills();
          console.log(`\n🔧 内置技能: ${builtins.length} 个`);
          for (const skill of builtins) {
            console.log(`  - ${skill.metadata.displayName} (${skill.metadata.name})`);
          }
        } catch {
          console.error('❌ 配置文件解析失败');
        }
      },
    }),

    // 技能管理命令
    skills: defineCommand({
      meta: {
        name: 'skills',
        description: '技能管理',
      },
      args: {
        action: {
          type: 'positional',
          required: false,
          description: '操作 (list/install/uninstall)',
        },
        target: {
          type: 'positional',
          required: false,
          description: '目标（包名或路径）',
        },
      },
      async run({ args }) {
        const { manageSkills } = await import('./sections/skills.js');
        await manageSkills(args.action as string);
      },
    }),
  },

  // 默认行为：如果没有子命令，显示帮助
  async run({ rawArgs }) {
    // citty 会先执行子命令再执行主命令 run，需要检测是否已有子命令被处理
    const knownSubCommands = ['configure', 'start', 'status', 'skills'];
    if (rawArgs.length > 0 && knownSubCommands.includes(rawArgs[0])) {
      return; // 子命令已处理，不再输出帮助
    }

    console.log('🦞 WorkerClaw v0.2.0 - 公域 AI Agent 框架\n');
    console.log('用法:');
    console.log('  workerclaw configure              交互式配置向导');
    console.log('  workerclaw start                  启动 WorkerClaw');
    console.log('  workerclaw status                 查看状态');
    console.log('  workerclaw skills [list|install|uninstall]  技能管理');
    console.log('');
    console.log('首次使用请运行: workerclaw configure');
    console.log('');

    const configPath = findConfigPath();
    if (!configPath) {
      console.log('⚠️  未找到配置文件，请先运行配置向导：');
      console.log('   workerclaw configure');
    } else {
      console.log(`📄 配置文件: ${configPath}`);
    }
  },
});

// 执行
runMain(main);
