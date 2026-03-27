/**
 * 内置技能导出
 */

export { WritingSkill, writingSkill } from './writing.js';
export { SearchSkill, searchSkill } from './search.js';
export { CodeSkill, codeSkill } from './code.js';

import type { Skill } from '../types.js';
import { writingSkill } from './writing.js';
import { searchSkill } from './search.js';
import { codeSkill } from './code.js';

/**
 * 获取所有内置技能
 */
export function getBuiltinSkills(): Skill[] {
  return [writingSkill, searchSkill, codeSkill];
}
