import * as fs from 'fs';
import * as path from 'path';
import { listUserSkills, findUserSkill, upsertUserSkill, deleteUserSkillRow } from '../db/repositories/skill.repo';

/**
 * Skill 定义接口
 */
export interface Skill {
  id: string;           // 文件名（不含扩展名），唯一标识
  name: string;         // 显示名称
  description: string;  // 简短描述
  tags: string[];       // 标签（用于搜索/匹配）
  content: string;      // 完整指令内容（front matter 之后的 markdown）
  source: 'system' | 'user'; // 来源
}

/**
 * Skill 服务 - 管理和加载 Skills
 *
 * 存储位置：
 * - 系统内置：<project>/data/skills/*.md
 *   随代码发布的资产，仍从文件读（跟 git 走、可 review），不进库。
 * - 用户自定义：MySQL 的 skills 表（source='user'）。原先是 ~/.aetherops/skills/*.md。
 *
 * 多账号后不能再用「全局合并后的 Map」做缓存：用户技能是账号私有的，
 * 一个进程里同时有多个登录人，缓存合并结果等于把 A 的技能给 B 看。
 * 所以内存里只留内置技能（全局共享且只读），用户技能每次按 ownerId 查库——
 * 技能数量很小，省略缓存换掉一类越权风险是划算的。
 */
export class SkillService {
  private systemSkills: Map<string, Skill> = new Map();
  private systemSkillsDir: string;

  constructor(systemSkillsDir?: string) {
    // 系统 Skills 目录：项目根目录下的 data/skills
    this.systemSkillsDir = systemSkillsDir || path.join(process.cwd(), 'data', 'skills');
  }

  /**
   * 载入内置技能（文件）。用户技能不再在启动时载入。
   * 必须在数据库就绪后调用，由 initServices() 负责时机。
   */
  async init(): Promise<void> {
    const loaded = this.loadSystemSkills();
    console.log(`[SkillService] Loaded ${loaded} system skills (user skills are per-account, queried on demand)`);
  }

  /**
   * 加载内置 Skills（data/skills/*.md）
   */
  private loadSystemSkills(): number {
    this.systemSkills.clear();
    return this.loadFromDir(this.systemSkillsDir);
  }

  /**
   * 从目录加载 md 技能文件
   */
  private loadFromDir(dir: string): number {
    let count = 0;
    try {
      if (!fs.existsSync(dir)) return 0;

      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(dir, file);
        const id = path.basename(file, '.md');

        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const skill = this.parseSkillFile(id, raw, 'system');
          if (skill) {
            this.systemSkills.set(id, skill);
            count++;
          }
        } catch (err) {
          console.error(`[SkillService] Failed to parse skill: ${file}`, err);
        }
      }
    } catch (err) {
      console.error(`[SkillService] Failed to load skills from ${dir}:`, err);
    }
    return count;
  }

  /**
   * 解析 Skill 文件（YAML front matter + Markdown 内容）
   * 
   * 格式：
   * ---
   * name: Skill Name
   * description: 描述
   * tags: [tag1, tag2]
   * ---
   * 
   * ## 指令内容...
   */
  private parseSkillFile(id: string, raw: string, source: 'system' | 'user'): Skill | null {
    // 提取 front matter
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!fmMatch) {
      // 没有 front matter，整个文件作为内容
      return {
        id,
        name: id,
        description: '',
        tags: [],
        content: raw.trim(),
        source,
      };
    }

    const frontMatter = fmMatch[1];
    const content = fmMatch[2].trim();

    // 简单解析 YAML front matter
    const name = this.extractField(frontMatter, 'name') || id;
    const description = this.extractField(frontMatter, 'description') || '';
    const tagsStr = this.extractField(frontMatter, 'tags') || '';
    
    // 解析 tags: [tag1, tag2] 或 tags: tag1, tag2
    let tags: string[] = [];
    if (tagsStr) {
      const cleaned = tagsStr.replace(/[\[\]"]/g, '');
      tags = cleaned.split(',').map(t => t.trim()).filter(Boolean);
    }

    return { id, name, description, tags, content, source };
  }

  /**
   * 从 front matter 提取字段值
   */
  private extractField(fm: string, key: string): string {
    const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const match = fm.match(regex);
    return match ? match[1].trim() : '';
  }

  /**
   * 获取该账号可见的所有 Skills：内置 + 自己的用户技能（同名时用户版覆盖内置）。
   */
  async getSkills(ownerId: string): Promise<Skill[]> {
    const merged = new Map<string, Skill>(this.systemSkills);
    const userSkills = await listUserSkills(ownerId);
    for (const skill of userSkills) merged.set(skill.id, skill);
    return Array.from(merged.values());
  }

  /**
   * 获取指定 Skill：先查该账号的用户技能，再回落内置。
   * 异步是故意的——不想为了同步签名在内存里缓存「某人的技能」。
   */
  async getSkill(ownerId: string, id: string): Promise<Skill | undefined> {
    const userSkill = await findUserSkill(ownerId, id);
    if (userSkill) return userSkill;
    return this.systemSkills.get(id);
  }

  /**
   * 保存用户 Skill（创建或更新）
   */
  async saveUserSkill(ownerId: string, skill: Omit<Skill, 'source'>): Promise<Skill> {
    const fullSkill: Skill = { ...skill, source: 'user' };
    await upsertUserSkill(ownerId, fullSkill);
    return fullSkill;
  }

  /**
   * 删除用户 Skill。
   * 不需要回填缓存：删掉后名字回落内置版本是查询时自然发生的。
   */
  async deleteUserSkill(ownerId: string, id: string): Promise<boolean> {
    const affected = await deleteUserSkillRow(ownerId, id);
    return affected > 0;
  }

  /**
   * 重新加载内置 Skills（文件可能在运行期被改动）
   */
  async reload(): Promise<void> {
    await this.init();
  }
}
