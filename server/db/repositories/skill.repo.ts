/**
 * 技能仓储：~/.aetherops/skills/*.md（用户技能）的替代品。
 *
 * 内置技能仍是项目里的 data/skills/*.md：那是随代码一起发布的资产，
 * 跟着 git 走、要能 review，放进库反而变成「每台机器一份副本」。
 * 所以本表实际只存 source='user' 的技能；source 列保留 'system' 取值，
 * 以后要做「在库里覆盖内置技能」不用再改表。
 *
 * 用户技能是账号私有的：所有函数第一个参数都是 ownerId。
 */
import { execute, query } from '../pool';

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  tags: string[];
  content: string;
  source: 'system' | 'user';
}

function parseTags(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function listUserSkills(ownerId: string): Promise<SkillRow[]> {
  const rows = await query<any>(
    `SELECT id, name, description, tags, content, source
     FROM skills WHERE owner_id = ? AND source = 'user' ORDER BY updated_at DESC, id ASC`,
    [ownerId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name || r.id,
    description: r.description || '',
    tags: parseTags(r.tags),
    content: r.content || '',
    source: 'user' as const,
  }));
}

export async function findUserSkill(ownerId: string, id: string): Promise<SkillRow | null> {
  const rows = await query<any>(
    `SELECT id, name, description, tags, content, source
     FROM skills WHERE owner_id = ? AND id = ? AND source = 'user'`,
    [ownerId, id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name || r.id,
    description: r.description || '',
    tags: parseTags(r.tags),
    content: r.content || '',
    source: 'user' as const,
  };
}

export async function upsertUserSkill(ownerId: string, skill: SkillRow): Promise<void> {
  const now = new Date();
  await execute(
    `INSERT INTO skills (owner_id, id, name, description, tags, content, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       description = VALUES(description),
       tags = VALUES(tags),
       content = VALUES(content),
       source = 'user',
       updated_at = VALUES(updated_at)`,
    [
      ownerId,
      skill.id,
      skill.name || skill.id,
      skill.description || '',
      JSON.stringify(skill.tags || []),
      skill.content || '',
      now,
      now,
    ],
  );
}

export async function deleteUserSkillRow(ownerId: string, id: string): Promise<number> {
  const r = await execute("DELETE FROM skills WHERE owner_id = ? AND id = ? AND source = 'user'", [ownerId, id]);
  return r.affectedRows;
}
