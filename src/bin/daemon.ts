#!/usr/bin/env node

/**
 * Browser Bridge Daemon 独立启动脚本
 * 
 * 用法:
 *   node dist/bin/daemon.js --port 19825
 */

import { parseArgs } from 'node:util';
import { startDaemon } from '../browser/daemon.js';

const { values } = parseArgs({
  options: {
    port: {
      type: 'string',
      short: 'p',
      default: '19825',
    },
    host: {
      type: 'string',
      short: 'h',
      default: 'localhost',
    },
  },
});

const port = parseInt(values.port || '19825');
const host = values.host || 'localhost';

console.log(`🌐 Browser Bridge Daemon`);
console.log(`   端口: ${port}`);
console.log(`   主机: ${host}`);
console.log('');

startDaemon(port, host).catch((err: Error) => {
  console.error('❌ Daemon 启动失败:', err);
  process.exit(1);
});
