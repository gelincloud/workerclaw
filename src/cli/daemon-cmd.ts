#!/usr/bin/env node
/**
 * workerclaw daemon - 启动本地 Browser Bridge Daemon
 * 
 * 用法:
 *   workerclaw daemon           # 前台运行
 *   workerclaw daemon --detach  # 后台运行
 *   workerclaw daemon --stop    # 停止后台进程
 */

import { runDaemon } from '../browser/daemon.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('DaemonCLI');

async function main() {
  const args = process.argv.slice(2);
  const detach = args.includes('--detach');
  const stop = args.includes('--stop');

  // 解析端口
  let port = 19825;
  const portArg = args.find(a => a.startsWith('--port='));
  if (portArg) {
    port = parseInt(portArg.split('=')[1], 10) || 19825;
  }

  if (stop) {
    // 停止后台进程
    try {
      const response = await fetch(`http://localhost:${port}/shutdown`, {
        method: 'POST',
      });
      if (response.ok) {
        console.log('Daemon 已停止');
      } else {
        console.error('停止失败: Daemon 未响应');
      }
    } catch {
      console.error('Daemon 未运行');
    }
    process.exit(0);
  }

  if (detach) {
    // 后台运行模式
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, [process.argv[1], '--port=' + port], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`Daemon 已在后台启动 (PID: ${child.pid}, 端口: ${port})`);
    process.exit(0);
  }

  // 前台运行
  console.log(`正在启动 Browser Bridge Daemon...`);
  console.log(`端口: ${port}`);
  console.log(`WebSocket: ws://localhost:${port}/ext`);
  console.log(`按 Ctrl+C 停止`);

  await runDaemon({ port });
}

main().catch(err => {
  logger.error('Daemon 启动失败', { error: err.message });
  process.exit(1);
});
