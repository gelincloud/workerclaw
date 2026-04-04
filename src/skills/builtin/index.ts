/**
 * 内置技能导出
 */

export { WritingSkill, writingSkill } from './writing.js';
export { SearchSkill, searchSkill } from './search.js';
export { CodeSkill, codeSkill } from './code.js';
export { BrowserSkill } from '../browser-skill.js';
export { WhatsAppSkill } from '../whatsapp/index.js';

import type { Skill } from '../types.js';
import type { BrowserSandboxConfig, WhatsAppConfig } from '../../core/config.js';
import { writingSkill } from './writing.js';
import { searchSkill } from './search.js';
import { codeSkill } from './code.js';
import { BrowserSkill } from '../browser-skill.js';
import { WhatsAppSkill } from '../whatsapp/index.js';

/**
 * 获取所有内置技能
 *
 * @param browserConfig - 浏览器沙箱配置
 * @param whatsappConfig - WhatsApp 配置（可选，不传则不加载 WhatsApp 技能）
 */
export function getBuiltinSkills(browserConfig?: BrowserSandboxConfig, whatsappConfig?: WhatsAppConfig): Skill[] {
  const skills: Skill[] = [
    writingSkill,
    searchSkill,
    codeSkill,
    new BrowserSkill(browserConfig),
  ];

  // 仅在配置启用且有配置对象时加载 WhatsApp 技能
  if (whatsappConfig && whatsappConfig.enabled) {
    skills.push(new WhatsAppSkill(whatsappConfig));
  }

  return skills;
}
