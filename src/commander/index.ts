/**
 * 运营指挥官模块
 */

// 微博指挥官
export { WeiboCommander } from './weibo-commander.js';
export { DataCollector } from './data-collector.js';
export { StrategyEngine } from './strategy-engine.js';
export { TaskGenerator, PRESET_TEMPLATES } from './task-generator.js';
export { getCommanderTools, createCommanderToolExecutors } from './tools.js';

// 小红书指挥官
export { XhsCommander } from './xhs-commander.js';
export { XhsDataCollector } from './xhs-data-collector.js';
export { XhsStrategyEngine } from './xhs-strategy-engine.js';
export { XhsTaskGenerator, XHS_PRESET_TEMPLATES } from './xhs-task-generator.js';
export { getXhsCommanderTools, createXhsCommanderToolExecutors } from './xhs-tools.js';

// 导出微博类型
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

// 导出小红书类型
export type {
  XhsCommanderConfig,
  XhsAccountSnapshot,
  XhsNoteData,
  XhsCreatorStats,
  XhsHotNote,
  XhsHotFeed,
  XhsInteractionData,
  XhsNoteType,
  XhsPostingTimeSuggestion,
  XhsContentSuggestion,
  XhsOperationStrategy,
  XhsAutoTaskType,
  XhsAutoTaskDef,
  XhsOperationTemplate,
  XhsDataCollectionConfig,
  XhsAutomationConfig,
  XhsDailyReport,
  XhsWeeklyReport,
} from './xhs-types.js';
