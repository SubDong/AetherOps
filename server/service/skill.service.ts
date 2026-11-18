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
 * 技能目录条目：注入 prompt 只带这一份，正文不进目录。
 * 有了它，技能数量增长只会把 prompt 撑长一行一条，而不是整篇。
 */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  /** 一句话用途；技能自己没写 description 时用正文首行标题推导 */
  description: string;
  tags: string[];
}

/** 目录里的描述有长度上限：一句话用途写成一段，目录就失去了意义 */
const CATALOG_DESCRIPTION_MAX = 200;

/**
 * 用户技能的 id 规则：它同时是斜杠命令（`/docker-manage`）和目录里的主键。
 * 只允许小写字母、数字、点、下划线、连字符 —— 空格与大写会让「按名字加载」变成一场猜谜。
 */
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 与 ai.service 的注入上限一致：写得更长，加载时也会被截断 */
const MAX_CONTENT_CHARS = 20000;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 32;

export interface SkillSaveInput {
  id?: string;
  name?: string;
  description?: string;
  tags?: unknown;
  content?: string;
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * 目录里那句「什么时候用」。
 *
 * description 优先（skill 文件里本来就有这个字段，老版本用户技能可能没填）；
 * 缺失时用正文首个标题行推导 —— 为了这点距离不值得加一次数据库迁移。
 */
function catalogDescriptionOf(skill: Skill): string {
  const explicit = String(skill.description || '').replace(/\s+/g, ' ').trim();
  if (explicit) return clipText(explicit, CATALOG_DESCRIPTION_MAX);
  const firstLine = String(skill.content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('```')) || '';
  const title = firstLine.replace(/^#+\s*/, '').trim();
  return title ? clipText(title, CATALOG_DESCRIPTION_MAX) : '(no description)';
}

/** 技能实体 → 目录条目。导出是为了让验证脚本能单独盯住「描述缺失时怎么推导」 */
export function toCatalogEntry(skill: Skill): SkillCatalogEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: catalogDescriptionOf(skill),
    tags: skill.tags,
  };
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
   * 技能目录：只有 id / 名字 / 一句话用途，不含正文。
   *
   * 按 id 排序是为了让每次注入的 prompt 完全一致（缓存与 diff 都靠这个稳定）。
   */
  async listSkills(ownerId: string): Promise<SkillCatalogEntry[]> {
    const skills = await this.getSkills(ownerId);
    return skills.map(toCatalogEntry).sort((a, b) => a.id.localeCompare(b.id));
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
   * 保存用户 Skill（创建或更新）。
   *
   * 校验放在服务层而不是路由：验证脚本与将来的 CLI 都走同一个入口，
   * 少一处重复校验就少一处能被绕开的写入口。
   */
  async saveUserSkill(ownerId: string, input: SkillSaveInput): Promise<Skill> {
    const id = String(input?.id || '').trim().toLowerCase();
    if (!SKILL_ID_PATTERN.test(id)) {
      throw new Error('技能 id 只能用小写字母、数字、点、下划线、连字符（1-64 位，且不能以符号开头）');
    }
    // 内置技能随代码发布、可 review；允许同名用户技能覆盖它，等于让人在界面上永久盖掉一个随代码升级的 runbook
    if (this.systemSkills.has(id)) {
      throw new Error(`内置技能 id「${id}」不能覆盖，请换一个 id`);
    }

    const content = String(input?.content || '').trim();
    if (!content) throw new Error('技能正文不能为空');
    if (content.length > MAX_CONTENT_CHARS) {
      throw new Error(`技能正文最多 ${MAX_CONTENT_CHARS} 字符（超出部分在加载时也会被截断）`);
    }

    const name = String(input?.name || '').trim().slice(0, 120) || id;
    const description = String(input?.description || '').trim().slice(0, CATALOG_DESCRIPTION_MAX);
    const tags = this.normalizeTags(input?.tags);

    const fullSkill: Skill = { id, name, description, tags, content, source: 'user' };
    await upsertUserSkill(ownerId, fullSkill);
    return fullSkill;
  }

  /** 字符串数组 / 逗号分隔字符串都接受，去重去空 */
  private normalizeTags(value: unknown): string[] {
    const raw = Array.isArray(value)
      ? value.map((t) => String(t))
      : String(value || '').split(',');
    const seen = new Set<string>();
    for (const item of raw) {
      const tag = item.trim().slice(0, MAX_TAG_CHARS);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      if (seen.size >= MAX_TAGS) break;
    }
    return [...seen];
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
