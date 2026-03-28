/**
 * CLI - 经验基因系统命令
 * 
 * workerclaw experience list       列出本地经验池
 * workerclaw experience search <q> 搜索经验
 * workerclaw experience stats      统计信息
 * workerclaw experience events     最近进化事件
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { ExperienceManager, DEFAULT_EXPERIENCE_CONFIG } from '../../experience/index.js';

// ==================== 配置加载 ====================

function loadManager(): ExperienceManager | null {
  const configPath = `${homedir()}/.workerclaw/config.json`;
  if (!existsSync(configPath)) {
    console.log('❌ 未找到配置文件，请先运行: workerclaw configure');
    return null;
  }

  let config: any;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    console.log('❌ 配置文件解析失败');
    return null;
  }

  const botId = config.platform?.botId || 'unknown';
  const token = config.platform?.token || '';
  const expConfig = {
    ...DEFAULT_EXPERIENCE_CONFIG,
    ...config.experience,
    hub: {
      ...DEFAULT_EXPERIENCE_CONFIG.hub,
      ...(config.experience?.hub || {}),
      endpoint: config.platform?.apiUrl || DEFAULT_EXPERIENCE_CONFIG.hub.endpoint,
    },
  };

  return new ExperienceManager(expConfig, botId, token);
}

// ==================== 命令处理 ====================

export async function manageExperience(action?: string, target?: string): Promise<void> {
  if (!action || action === 'help') {
    console.log(`🧬 经验基因系统（虾片）\n`);
    console.log('用法:');
    console.log('  workerclaw experience list       列出本地经验池');
    console.log('  workerclaw experience search <q> 搜索经验');
    console.log('  workerclaw experience stats      统计信息');
    console.log('  workerclaw experience events     最近进化事件');
    return;
  }

  const manager = loadManager();
  if (!manager) return;

  await manager.init();

  switch (action) {
    case 'list': {
      const genes = manager.getAllGenes();
      if (genes.length === 0) {
        console.log('📭 本地经验池为空');
        console.log('   任务执行中遇到错误并修复后，经验会自动积累');
        return;
      }

      console.log(`🧬 本地经验池 (${genes.length} 条基因)\n`);

      // 按分类分组
      const grouped: Record<string, typeof genes> = {};
      for (const gene of genes) {
        if (!grouped[gene.category]) grouped[gene.category] = [];
        grouped[gene.category].push(gene);
      }

      const categoryLabels: Record<string, string> = {
        task_fix: '🔧 任务修复',
        env_fix: '🖥️  环境配置',
        api_compat: '🔗 API兼容',
        performance: '⚡ 性能优化',
        security: '🔒 安全加固',
      };

      for (const [cat, catGenes] of Object.entries(grouped)) {
        console.log(`${categoryLabels[cat] || cat} (${catGenes.length})`);
        for (const gene of catGenes) {
          console.log(`  • ${gene.summary}`);
          console.log(`    信号: ${gene.signals.slice(0, 3).join(', ')}`);
          console.log(`    步骤: ${gene.strategy.length}  |  版本: ${gene.version}  |  ${gene.created_at.slice(0, 10)}`);
        }
        console.log('');
      }
      break;
    }

    case 'search': {
      if (!target) {
        console.log('❌ 请提供搜索关键词');
        console.log('   workerclaw experience search "socket hang up"');
        return;
      }

      const keywords = target.split(/[\s,]+/).filter(s => s.length > 0);
      console.log(`🔍 搜索经验: "${keywords.join(', ')}"\n`);

      const results = await manager.search(keywords);
      if (results.length === 0) {
        console.log('📭 未找到匹配的经验');
        return;
      }

      console.log(`找到 ${results.length} 条匹配:\n`);
      for (const r of results) {
        console.log(`• [${(r.matchScore * 100).toFixed(0)}%] ${r.gene.summary}`);
        console.log(`  分类: ${r.gene.category}  |  来源: ${r.source}`);
        console.log(`  信号: ${r.gene.signals.slice(0, 3).join(', ')}`);
        if (r.capsule.outcome.score > 0) {
          console.log(`  置信度: ${(r.capsule.confidence * 100).toFixed(0)}%  |  验证: ${r.capsule.outcome.verification_count}次`);
        }
        console.log('');
      }
      break;
    }

    case 'stats': {
      const stats = manager.getStats();
      console.log(`📊 经验系统统计\n`);
      console.log(`  🧬 基因: ${stats.genes}`);
      console.log(`  💊 胶囊: ${stats.capsules}`);
      console.log(`  📝 事件: ${stats.events}`);
      console.log(`  \n  分类分布:`);
      for (const [cat, count] of Object.entries(stats.categories)) {
        if (count > 0) console.log(`    ${cat}: ${count}`);
      }
      break;
    }

    case 'events': {
      const events = manager.getRecentEvents(10);
      if (events.length === 0) {
        console.log('📭 暂无进化事件');
        return;
      }

      console.log(`📝 最近进化事件 (${events.length})\n`);
      for (const event of events) {
        const icon = event.outcome.status === 'success' ? '✅' : '❌';
        console.log(`  ${icon} ${event.process.signal_detected}`);
        console.log(`     意图: ${event.intent}  |  尝试: ${event.process.mutations_tried}  |  耗时: ${Math.round(event.outcome.total_duration_ms / 1000)}s`);
        console.log(`     ${event.created_at}`);
        console.log('');
      }
      break;
    }

    default:
      console.log(`❌ 未知操作: ${action}`);
      console.log('   可用操作: list, search, stats, events');
  }
}
