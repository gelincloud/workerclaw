/**
 * WorkerClaw 技能包类型定义
 * 
 * 定义外部技能包的接口规范
 */

import type { Skill } from './types.js';
import type { Logger } from '../core/logger.js';

/** 技能包元数据 */
export interface SkillPackMeta {
  /** 技能包名称 */
  name: string;
  /** 技能包版本 */
  version: string;
  /** 技能包描述 */
  description?: string;
  /** 入口文件 */
  main?: string;
  /** 包含的技能清单 */
  skills?: Array<{
    name: string;
    displayName?: string;
    requiredLevel?: string;
    applicableTaskTypes?: string[];
    requiredTools?: string[];
  }>;
}

/** 技能包实例 */
export interface SkillPack {
  /** 技能包元数据 */
  name: string;
  /** 版本 */
  version: string;
  /** 描述 */
  description: string;
  /** 提供的技能列表 */
  skills: Skill[];
  /** 初始化 */
  init?(context: SkillPackContext): Promise<void>;
  /** 清理 */
  dispose?(): Promise<void>;
}

/** 技能包上下文（init 时传入） */
export interface SkillPackContext {
  config: any;
  logger: Logger;
}

/** 已安装技能包记录 */
export interface InstalledSkillPack {
  /** 来源（npm 包名或本地路径） */
  source: string;
  /** 名称 */
  name?: string;
  /** 描述 */
  description?: string;
  /** 版本 */
  version: string;
  /** 安装时间 */
  installedAt: string;
}

/** skills.json 结构 */
export interface SkillsManifest {
  installed: InstalledSkillPack[];
}
