/**
 * 微博运营指挥官模块
 */

export { WeiboCommander } from './weibo-commander.js';
export { DataCollector } from './data-collector.js';
export { StrategyEngine } from './strategy-engine.js';
export { TaskGenerator, PRESET_TEMPLATES } from './task-generator.js';

// 导出类型
export type {
  WeiboCommanderConfig,
  WeiboAccountSnapshot,
  WeiboPostData,
  TrendingTopic,
  WeiboHotSearch,
  InteractionData,
  ContentType,
  PostingTimeSuggestion,
  ContentSuggestion,
  OperationStrategy,
  AutoTaskType,
  AutoTaskDef,
  OperationTemplate,
  DataCollectionConfig,
  AutomationConfig,
  DailyReport,
  WeeklyReport,
} from './types.js';
