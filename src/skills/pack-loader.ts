/**
 * WorkerClaw 技能包加载器
 * 
 * 从 npm 包或本地路径动态加载技能包
 */

import { resolve, join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { SkillPack, SkillPackMeta } from './pack-types.js';
import type { Skill } from './types.js';

export class SkillPackLoader {
  /**
   * 从 npm 包或本地路径加载技能包
   * 
   * @param source - npm 包名 (如 @glin_1/workerclaw-skill-image) 或本地路径 (如 ./my-skills)
   */
  async load(source: string): Promise<SkillPack> {
    // 判断是本地路径还是 npm 包
    if (source.startsWith('./') || source.startsWith('../') || source.startsWith('/') || source.startsWith('~')) {
      return this.loadFromPath(resolve(source));
    }

    // npm 包 - 尝试动态 import
    return this.loadFromNpm(source);
  }

  /**
   * 从 npm 包加载
   */
  private async loadFromNpm(packageName: string): Promise<SkillPack> {
    try {
      const mod = await import(packageName);

      // 尝试获取默认导出或直接导出
      const pack = mod.default || mod;

      return this.validateAndNormalize(pack, packageName);
    } catch (err) {
      // 如果直接 import 失败，尝试 resolve 路径后 import
      try {
        const mod = await import(`${packageName}/dist/index.js`);
        const pack = mod.default || mod;
        return this.validateAndNormalize(pack, packageName);
      } catch {
        throw new Error(`无法加载技能包 "${packageName}": ${(err as Error).message}`);
      }
    }
  }

  /**
   * 从本地路径加载
   */
  private async loadFromPath(dirPath: string): Promise<SkillPack> {
    // 读取 skill.json 或 package.json
    let meta: SkillPackMeta | null = null;
    const skillJsonPath = join(dirPath, 'skill.json');
    const packageJsonPath = join(dirPath, 'package.json');

    if (existsSync(skillJsonPath)) {
      try {
        meta = JSON.parse(readFileSync(skillJsonPath, 'utf-8'));
      } catch {
        throw new Error(`skill.json 解析失败: ${skillJsonPath}`);
      }
    } else if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        meta = {
          name: pkg.name,
          version: pkg.version || '0.0.0',
          description: pkg.description,
          main: pkg.main || 'index.js',
          skills: pkg.skills,
        };
      } catch {
        throw new Error(`package.json 解析失败: ${packageJsonPath}`);
      }
    }

    if (!meta) {
      throw new Error(`未找到 skill.json 或 package.json: ${dirPath}`);
    }

    // 确定入口文件
    const mainFile = meta.main
      ? resolve(dirPath, meta.main)
      : resolve(dirPath, 'dist/index.js');

    if (!existsSync(mainFile)) {
      // 尝试直接 import 目录
      try {
        const mod = await import(dirPath);
        const pack = mod.default || mod;
        return this.validateAndNormalize(pack, meta.name);
      } catch {
        throw new Error(`入口文件不存在: ${mainFile}`);
      }
    }

    try {
      const mod = await import(mainFile);
      const pack = mod.default || mod;
      return this.validateAndNormalize(pack, meta.name);
    } catch (err) {
      throw new Error(`无法加载入口文件 ${mainFile}: ${(err as Error).message}`);
    }
  }

  /**
   * 验证并标准化技能包
   */
  private validateAndNormalize(raw: any, sourceName: string): SkillPack {
    // 基本验证
    if (!raw || typeof raw !== 'object') {
      throw new Error(`技能包格式无效: ${sourceName}`);
    }

    const name = raw.name || sourceName;
    const version = raw.version || '0.0.0';
    const description = raw.description || '';

    // 验证 skills
    let skills: Skill[] = [];
    if (Array.isArray(raw.skills)) {
      skills = raw.skills;
    } else if (raw.skills && typeof raw.skills === 'object') {
      // 可能是 { name: Skill } 格式
      skills = Object.values(raw.skills) as Skill[];
    }

    if (skills.length === 0) {
      throw new Error(`技能包 "${name}" 没有提供任何技能`);
    }

    // 验证每个技能有 metadata
    for (const skill of skills) {
      if (!skill.metadata?.name) {
        throw new Error(`技能包 "${name}" 中的技能缺少 metadata.name`);
      }
    }

    return {
      name,
      version,
      description,
      skills,
      init: typeof raw.init === 'function' ? raw.init : undefined,
      dispose: typeof raw.dispose === 'function' ? raw.dispose : undefined,
    };
  }

  /**
   * 从指定目录扫描所有 skill.json
   */
  async loadFromDirectory(dir: string): Promise<SkillPack[]> {
    const { readdirSync } = await import('node:fs');
    const packs: SkillPack[] = [];

    if (!existsSync(dir)) return packs;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const subDir = join(dir, entry.name);
      const skillJsonPath = join(subDir, 'skill.json');

      if (existsSync(skillJsonPath)) {
        try {
          const pack = await this.loadFromPath(subDir);
          packs.push(pack);
        } catch (err) {
          console.warn(`跳过加载 ${entry.name}: ${(err as Error).message}`);
        }
      }
    }

    return packs;
  }
}
