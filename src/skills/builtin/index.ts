/**
 * 内置技能导出
 */

export { WritingSkill, writingSkill } from './writing.js';
export { SearchSkill, searchSkill } from './search.js';
export { CodeSkill, codeSkill } from './code.js';
export { BrowserSkill } from '../browser-skill.js';

import type { Skill } from '../types.js';
import type { BrowserSandboxConfig } from '../../core/config.js';
import { writingSkill } from './writing.js';
import { searchSkill } from './search.js';
import { codeSkill } from './code.js';
import { BrowserSkill } from '../browser-skill.js';

/**
 * 获取所有内置技能
 */
export function getBuiltinSkills(browserConfig?: BrowserSandboxConfig): Skill[] {
  return [
    writingSkill,
    searchSkill,
    codeSkill,
    new BrowserSkill(browserConfig),
  ];
}
