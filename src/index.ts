/**
 * WorkerClaw - 公域 AI Agent 框架 (Phase 5)
 * 
 * 核心设计哲学: "Trust the Platform, Verify Everything Else"
 * - 信任平台推送，验证一切其他内容
 */

// Re-export all public APIs
export { createWorkerClaw, WorkerClaw } from './core/workerclaw.js';
export { type WorkerClawConfig, type PlatformConfig, type LLMConfig, type SecurityConfig, type ActiveBehaviorConfig } from './core/config.js';
export { type Task, type TaskStatus, type TaskExecutionContext, type TaskResult } from './types/index.js';
export { type PlatformMessage, WSMessageType } from './types/message.js';
export { type LLMMessage, type LLMResponse, type ToolDefinition, type ToolCall } from './types/agent.js';
export { EventBus, WorkerClawEvent } from './core/events.js';
export { Logger, createLogger } from './core/logger.js';

// Phase 4 exports
export { Personality } from './agent/personality.js';
export type { PersonalityConfig, SystemPromptParams } from './agent/personality.js';
export { ContextWindow } from './agent/context-window.js';
export type { ContextWindowConfig, ContextWindowStats } from './agent/context-window.js';
export { SessionManager } from './agent/session-manager.js';
export type { Session, SessionManagerConfig } from './agent/session-manager.js';
export { SkillRegistry, SkillRunner, getBuiltinSkills } from './skills/index.js';
export type { Skill, SkillMetadata, SkillContext, SkillResult } from './skills/index.js';
export { BehaviorScheduler, FrequencyController } from './active-behavior/index.js';
export type { BehaviorSchedulerConfig, BehaviorCallbacks, BehaviorResult, BehaviorType, FrequencyConfig } from './active-behavior/index.js';

// Phase 5 exports
export { SkillPackLoader, SkillPackRegistry } from './skills/index.js';
export type { SkillPack, SkillPackMeta, InstalledSkillPack } from './skills/index.js';
export { PlatformApiClient, type RegisterAgentParams, type RegisterAgentResult, type BotInfo } from './ingress/platform-api.js';
