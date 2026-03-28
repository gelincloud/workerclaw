/**
 * WorkerClaw 技能包注册表
 * 
 * 管理已安装的外部技能包清单
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InstalledSkillPack, SkillsManifest } from './pack-types.js';

export class SkillPackRegistry {
  private filePath: string;
  private manifest: SkillsManifest;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.manifest = this.load();
  }

  /**
   * 加载清单文件
   */
  private load(): SkillsManifest {
    try {
      if (existsSync(this.filePath)) {
        const content = readFileSync(this.filePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      // 清单文件损坏，重建
    }
    return { installed: [] };
  }

  /**
   * 保存清单文件
   */
  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(this.manifest, null, 2), 'utf-8');
  }

  /**
   * 添加已安装的技能包
   */
  add(pack: InstalledSkillPack): void {
    // 移除已有的同名包
    this.manifest.installed = this.manifest.installed.filter(
      item => item.source !== pack.source,
    );
    this.manifest.installed.push(pack);
    this.save();
  }

  /**
   * 移除技能包
   */
  remove(source: string): boolean {
    const before = this.manifest.installed.length;
    this.manifest.installed = this.manifest.installed.filter(
      item => item.source !== source,
    );
    if (this.manifest.installed.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  /**
   * 列出所有已安装的技能包
   */
  list(): InstalledSkillPack[] {
    return [...this.manifest.installed];
  }

  /**
   * 查找技能包
   */
  find(source: string): InstalledSkillPack | undefined {
    return this.manifest.installed.find(item => item.source === source);
  }

  /**
   * 检查是否已安装
   */
  has(source: string): boolean {
    return this.manifest.installed.some(item => item.source === source);
  }
}
