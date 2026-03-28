/**
 * WorkerClaw CLI - 人格配置 section
 * 
 * 交互式配置 Agent 人格参数
 */

import { text, select, num } from '../prompter.js';
import type { WorkerClawConfig } from '../../core/config.js';

export interface PersonalitySectionResult {
  personality: WorkerClawConfig['personality'];
}

/** 预设语气 */
const TONE_PRESETS = [
  { value: '专业、友好、高效', label: '标准' },
  { value: '专业严谨', label: '专业' },
  { value: '轻松幽默', label: '轻松' },
  { value: '热情活泼', label: '热情' },
  { value: '简洁直接', label: '简洁' },
  { value: '__custom__', label: '自定义...' },
];

/**
 * 人格配置
 */
export async function configurePersonality(
  existing?: WorkerClawConfig['personality'],
  platformAgentName?: string,
): Promise<PersonalitySectionResult | null> {
  // Agent 名称：如果平台注册已设置，直接使用，不再重复询问
  let name: string;
  if (platformAgentName) {
    // 平台注册了名称，直接同步过来
    name = platformAgentName;
  } else {
    const inputName = await text(
      'Agent 名称',
      existing?.name || '小工虾',
    );
    if (inputName === null) return null;
    name = inputName;
  }

  // 语气
  const toneKey = await select(
    '选择语气风格',
    TONE_PRESETS,
    TONE_PRESETS.find(p => p.value === existing?.tone)?.value,
  );

  if (!toneKey) return null;

  let tone: string;
  if (toneKey === '__custom__') {
    const customTone = await text('自定义语气描述');
    if (!customTone) return null;
    tone = customTone;
  } else {
    tone = toneKey;
  }

  // 简介
  const bio = await text(
    'Agent 简介',
    existing?.bio || '智工坊平台的打工虾',
  );
  if (bio === null) return null;

  // 专业领域（可选）
  const expertiseInput = await text(
    '专业领域（用逗号分隔，可留空）',
    existing?.expertise?.join(', '),
  );
  if (expertiseInput === null) return null;

  const expertise = expertiseInput
    ? expertiseInput.split(/[,，]/).map(s => s.trim()).filter(Boolean)
    : undefined;

  // 语言
  const language = await select(
    '主要语言',
    [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'en-US', label: 'English' },
      { value: 'ja-JP', label: '日本語' },
      { value: 'auto', label: '自动检测' },
    ],
    existing?.language || 'zh-CN',
  );

  if (!language) return null;

  // 行为偏好（可选高级设置）
  const configureBehavior = await text(
    '是否自定义行为偏好？(y/N)',
    'N',
  );
  if (configureBehavior === null) return null;

  let behavior: WorkerClawConfig['personality']['behavior'];
  if (configureBehavior.toLowerCase() === 'y') {
    const proactivity = await num('主动性 (0-100)', 50, 0, 100);
    if (proactivity === null) return null;

    const humor = await num('幽默感 (0-100)', 30, 0, 100);
    if (humor === null) return null;

    const formality = await num('正式程度 (0-100)', 60, 0, 100);
    if (formality === null) return null;

    behavior = {
      proactivity: proactivity || 50,
      humor: humor || 30,
      formality: formality || 60,
    };
  }

  return {
    personality: {
      name: name || '小工虾',
      tone,
      bio: bio || '智工坊平台的打工虾',
      expertise,
      language,
      behavior,
    },
  };
}
