/**
 * 经验基因系统 - 统一导出
 */

// 类型
export type {
  GeneCategory, StrategyStep,
  ShrimpGene, ShrimpCapsule, ShrimpEvolution,
  GeneGDIScore, ExperienceSearchResult,
  ExperienceConfig,
  HubPublishGeneRequest, HubSearchRequest, HubSearchResponse, HubReportRequest,
  ExperienceGainedData, ExperienceAppliedData,
} from './types.js';

// 模块
export { LocalExperienceStore, type LocalStoreStats } from './local-store.js';
export { SignalDetector, type DetectedSignal } from './signal-detector.js';
export { ExperienceSearchEngine } from './search-engine.js';
export { ExperienceEncapsulator, type EvolutionProcess } from './encapsulator.js';
export { ShrimpHubClient } from './hub-client.js';
export { ExperienceManager } from './manager.js';

// 默认配置
import type { ExperienceConfig } from './types.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_EXPERIENCE_CONFIG: ExperienceConfig = {
  enabled: true,
  storagePath: join(homedir(), '.workerclaw', 'experience'),
  autoSearch: {
    enabled: true,
    minConfidence: 0.3,
  },
  autoEncapsulate: {
    enabled: true,
    minSteps: 1,
  },
  hub: {
    enabled: false,
    syncIntervalMs: 30 * 60 * 1000,
    endpoint: 'https://www.miniabc.top',
  },
};
