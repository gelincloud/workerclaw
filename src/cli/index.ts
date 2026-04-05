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
 *   workerclaw token                  # 查看 Token（网页登录用）
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

// 从 package.json 读取版本号
const { version: CLI_VERSION } = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'),
);

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
    version: CLI_VERSION,
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
        const { mergeConfig } = await import('../core/config.js');
        // 用默认值合并用户配置，确保 task.concurrency 等字段存在
        const mergedConfig = mergeConfig({}, config);
        const workerclaw = createWorkerClaw(mergedConfig);

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

    // 停止命令
    stop: defineCommand({
      meta: {
        name: 'stop',
        description: '停止后台运行的 WorkerClaw 进程',
      },
      args: {
        force: {
          type: 'boolean',
          description: '强制终止（使用 SIGKILL）',
          alias: 'f',
          default: false,
        },
      },
      async run({ args }) {
        const { execSync } = await import('node:child_process');

        // 查找 workerclaw 进程
        let pids: string[] = [];
        try {
          const output = execSync('pgrep -f "node.*workerclaw"', { encoding: 'utf-8' }).trim();
          if (output) {
            pids = output.split('\n').filter(Boolean);
          }
        } catch {
          // pgrep 没找到进程会返回非零退出码
        }

        if (pids.length === 0) {
          console.log('✅ 没有找到运行中的 WorkerClaw 进程');
          return;
        }

        console.log(`🔍 找到 ${pids.length} 个 WorkerClaw 进程:`);

        // 显示进程详情
        for (const pid of pids) {
          try {
            const info = execSync(`ps -p ${pid} -o pid,ppid,args`, { encoding: 'utf-8' }).trim();
            console.log(`   ${info.split('\n')[1]?.trim() || `PID: ${pid}`}`);
          } catch {
            console.log(`   PID: ${pid}`);
          }
        }

        const signal = args.force ? 'SIGKILL' : 'SIGTERM';
        const signalName = args.force ? 'SIGKILL (强制)' : 'SIGTERM (优雅)';

        console.log(`\n🛑 正在发送 ${signalName} 信号...`);

        for (const pid of pids) {
          try {
            process.kill(Number(pid), signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
            console.log(`   ✅ 已向 PID ${pid} 发送信号`);
          } catch (err: any) {
            console.log(`   ❌ 无法终止 PID ${pid}: ${err.message}`);
          }
        }

        // 等待一下确认进程已终止
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 检查是否还有残留进程
        let remainingPids: string[] = [];
        try {
          const output = execSync('pgrep -f "node.*workerclaw"', { encoding: 'utf-8' }).trim();
          if (output) {
            remainingPids = output.split('\n').filter(Boolean);
          }
        } catch {}

        if (remainingPids.length === 0) {
          console.log('\n✅ 所有 WorkerClaw 进程已停止');
        } else {
          console.log(`\n⚠️  仍有 ${remainingPids.length} 个进程在运行，可能需要强制终止:`);
          console.log('   workerclaw stop --force');
        }
      },
    }),

    // 状态命令
    status: defineCommand({
      meta: {
        name: 'status',
        description: '查看 WorkerClaw 状态',
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
          console.log(`  智能活跃: ${(config.activeBehavior?.enabled ?? true) ? '已启用' : '未启用'}`);

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

    // Token 命令
    token: defineCommand({
      meta: {
        name: 'token',
        description: '查看当前 Agent 的 Token（用于网页登录）',
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
          console.error('❌ 未找到配置文件');
          console.error('   运行 workerclaw configure 进行配置');
          process.exit(1);
        }

        try {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'));
          const token = config.platform?.token;
          const botId = config.platform?.botId;

          if (!token) {
            console.error('❌ 配置文件中未找到 Token');
            console.error(`   配置文件: ${configPath}`);
            console.error('   运行 workerclaw configure 重新配置');
            process.exit(1);
          }

          if (botId) {
            console.log(`🦐 Agent ID: ${botId}`);
          }
          console.log(`🔑 Token: ${token}`);
          console.log('');
          console.log('💡 复制 Token 到智工坊登录页的「养虾人 Token 登录」即可查看收益。');
        } catch {
          console.error('❌ 配置文件解析失败');
          process.exit(1);
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
        'config-file': {
          type: 'string',
          description: '配置文件路径',
          alias: 'c',
        },
      },
      async run({ args }) {
        const { manageSkills } = await import('./sections/skills.js');
        await manageSkills(args.action as string);
      },
    }),

    // 经验基因系统命令
    experience: defineCommand({
      meta: {
        name: 'experience',
        description: '经验基因系统（虾片）',
      },
      args: {
        action: {
          type: 'positional',
          required: false,
          description: '操作 (list/search/stats/events)',
        },
        target: {
          type: 'positional',
          required: false,
          description: '搜索关键词（search 时使用）',
        },
        'config-file': {
          type: 'string',
          description: '配置文件路径',
          alias: 'c',
        },
      },
      async run({ args }) {
        await import('./sections/experience.js').then(m => m.manageExperience(args.action as string, args.target as string, args['config-file'] as string));
      },
    }),

    // 日志查看命令
    logs: defineCommand({
      meta: {
        name: 'logs',
        description: '查看 WorkerClaw 运行日志（Docker 容器内使用）',
      },
      args: {
        lines: {
          type: 'string',
          description: '显示行数',
          alias: 'n',
          default: '100',
        },
        follow: {
          type: 'boolean',
          description: '实时跟踪日志',
          alias: 'f',
          default: false,
        },
      },
      async run({ args }) {
        const { execSync, spawn } = await import('node:child_process');
        const lines = parseInt(args.lines as string) || 100;
        const follow = args.follow as boolean;

        // 检查是否在 Docker 容器内
        const isDocker = existsSync('/.dockerenv') || existsSync('/proc/1/cgroup');

        if (isDocker) {
          // 在容器内，直接查看 pm2 日志或 stdout
          const pm2LogPath = '/root/.pm2/logs/workerclaw-out.log';
          const pm2ErrPath = '/root/.pm2/logs/workerclaw-error.log';

          if (follow) {
            // 实时跟踪模式
            console.log('📋 实时日志（Ctrl+C 退出）:\n');
            try {
              // 使用 tail -f 跟踪日志
              const tail = spawn('tail', ['-f', '-n', String(lines), pm2LogPath, pm2ErrPath], {
                stdio: 'inherit',
              });
              tail.on('error', (err) => {
                console.error('❌ 无法读取日志:', err.message);
                console.log('提示: 如果使用 docker logs，请在宿主机运行:');
                console.log('  docker logs -f <container_name>');
              });
            } catch {
              console.log('提示: 在宿主机上运行 docker logs -f <container_name> 查看实时日志');
            }
          } else {
            // 显示最近日志
            console.log(`📋 最近 ${lines} 行日志:\n`);
            try {
              const stdout = execSync(`tail -n ${lines} ${pm2LogPath} 2>/dev/null || echo "(无 stdout 日志)"`, { encoding: 'utf-8' });
              const stderr = execSync(`tail -n ${Math.floor(lines / 2)} ${pm2ErrPath} 2>/dev/null || echo ""`, { encoding: 'utf-8' });

              if (stdout) {
                console.log('--- STDOUT ---');
                console.log(stdout);
              }
              if (stderr) {
                console.log('--- STDERR ---');
                console.log(stderr);
              }
            } catch {
              console.log('提示: 在宿主机上运行 docker logs <container_name> 查看日志');
            }
          }
        } else {
          // 不在容器内，提示用户使用 docker logs
          console.log('📋 WorkerClaw 日志查看\n');
          console.log('如果 WorkerClaw 运行在 Docker 容器中，请在宿主机运行:');
          console.log('');
          console.log('  # 查看最近 100 行日志');
          console.log('  docker logs <container_name>');
          console.log('');
          console.log('  # 实时跟踪日志');
          console.log('  docker logs -f <container_name>');
          console.log('');
          console.log('  # 查看更多行数');
          console.log('  docker logs --tail 500 <container_name>');
          console.log('');
          console.log('💡 提示: 查找容器名称: docker ps | grep workerclaw');
        }
      },
    }),

    // 任务管理命令
    tasks: defineCommand({
      meta: {
        name: 'tasks',
        description: '任务管理（查看已接单/清理卡住的任务）',
      },
      args: {
        action: {
          type: 'positional',
          required: false,
          description: '操作 (list/cancel)',
        },
        target: {
          type: 'positional',
          required: false,
          description: '任务 ID（cancel 时使用）',
        },
        'config-file': {
          type: 'string',
          description: '配置文件路径',
          alias: 'c',
        },
      },
      async run({ args }) {
        const configPath = findConfigPath(args['config-file'] as string);

        if (!configPath) {
          console.error('❌ 未找到配置文件');
          console.error('   运行 workerclaw configure 进行配置');
          process.exit(1);
        }

        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        const { PlatformApiClient } = await import('../ingress/platform-api.js');

        const platformApi = new PlatformApiClient(config.platform);

        const action = args.action as string || 'list';

        if (action === 'list') {
          console.log('📋 正在获取已接单任务...\n');

          try {
            const tasks = await platformApi.getTakenTasks();
            const stuckTasks = tasks.filter(t => t.status === 'taken');

            if (stuckTasks.length === 0) {
              console.log('✅ 没有卡住的任务');
              return;
            }

            console.log(`⚠️  发现 ${stuckTasks.length} 个已接单但未执行的任务:\n`);
            for (const task of stuckTasks) {
              console.log(`  📌 [${task.id}]`);
              console.log(`     内容: ${task.content?.substring(0, 60)}...`);
              console.log(`     报酬: ${task.reward} 虾晶`);
              console.log(`     接单时间: ${task.taken_at || '未知'}`);
              console.log('');
            }
            console.log('💡 如需取消某个任务，运行:');
            console.log('   workerclaw tasks cancel <任务ID>');
          } catch (err: any) {
            console.error(`❌ 获取任务失败: ${err.message}`);
          }
        } else if (action === 'cancel') {
          const taskId = args.target as string;
          if (!taskId) {
            console.error('❌ 请指定任务 ID');
            console.error('   workerclaw tasks cancel <任务ID>');
            process.exit(1);
          }

          console.log(`🗑️  正在取消任务 [${taskId}]...`);

          try {
            const result = await platformApi.cancelTake(taskId);
            if (result.success) {
              console.log(`✅ 已取消任务 [${taskId}]`);
            } else {
              console.error(`❌ 取消失败: ${result.error}`);
            }
          } catch (err: any) {
            console.error(`❌ 取消任务异常: ${err.message}`);
          }
        } else {
          console.log('用法:');
          console.log('  workerclaw tasks list         查看已接单任务');
          console.log('  workerclaw tasks cancel <ID>  取消指定任务');
        }
      },
    }),
  },

  // 默认行为：如果没有子命令，显示帮助
  async run({ rawArgs }) {
    // citty 会先执行子命令再执行主命令 run，需要检测是否已有子命令被处理
    const knownSubCommands = ['configure', 'start', 'stop', 'status', 'token', 'logs', 'skills', 'experience', 'tasks'];
    if (rawArgs.length > 0 && knownSubCommands.includes(rawArgs[0])) {
      return; // 子命令已处理，不再输出帮助
    }

    console.log(`🦞 WorkerClaw v${CLI_VERSION} - 公域 AI Agent 框架\n`);
    console.log('用法:');
    console.log('  workerclaw configure              交互式配置向导');
    console.log('  workerclaw start                  启动 WorkerClaw');
    console.log('  workerclaw stop [-f|--force]      停止后台进程');
    console.log('  workerclaw status                 查看状态');
    console.log('  workerclaw token                  查看 Token（网页登录用）');
    console.log('  workerclaw logs [-f] [-n N]       查看运行日志');
    console.log('  workerclaw tasks [list|cancel]    任务管理');
    console.log('  workerclaw skills [list|install|uninstall]  技能管理');
    console.log('  workerclaw experience [list|search|stats|events]  经验基因系统');
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
