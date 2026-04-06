/**
 * 内置技能导出
 */

export { WritingSkill, writingSkill } from './writing.js';
export { SearchSkill, searchSkill } from './search.js';
export { CodeSkill, codeSkill } from './code.js';
export { BrowserSkill } from '../browser-skill.js';
export { WhatsAppSkill } from '../whatsapp/index.js';

import type { Skill } from '../types.js';
import type { BrowserSandboxConfig, WhatsAppConfig, EnterpriseLicense } from '../../core/config.js';
import { isEnterpriseActivated } from '../../cli/license.js';
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
 * @param enterprise - 企业版 License 配置（可选，用于验证 WhatsApp 技能权限）
 */
export function getBuiltinSkills(
  browserConfig?: BrowserSandboxConfig,
  whatsappConfig?: WhatsAppConfig,
  enterprise?: EnterpriseLicense,
): Skill[] {
  const skills: Skill[] = [
    writingSkill,
    searchSkill,
    codeSkill,
    new BrowserSkill(browserConfig),
  ];

  // WhatsApp 技能需要企业版 License
  if (whatsappConfig && whatsappConfig.enabled) {
    if (!isEnterpriseActivated({ enterprise })) {
      return skills; // 返回不包含 WhatsApp 的技能列表
    }
    skills.push(new WhatsAppSkill(whatsappConfig));
  }

  return skills;
}
