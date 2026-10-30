/**
 * 命令片段仓储：原先只存在浏览器 localStorage（aetherops-snippets-v1）。
 *
 * 排序按「新建的在前」——旧实现是数组 unshift，且没有拖拽重排，
 * 所以 created_at DESC 就等价于原来的顺序。sort_order 列保持 0 做预留：
 * 真要支持拖拽重排时，再让前端提交显式 order，不用改表。
 *
 * 片段是账号私有的：列表/读写/删除全部带 ownerId。
 */
import { execute, query, queryOne } from '../pool';

export interface SnippetRow {
  id: string;
  name: string;
  command: string;
}

export async function listSnippets(ownerId: string): Promise<SnippetRow[]> {
  const rows = await query<any>(
    'SELECT id, name, command FROM snippets WHERE owner_id = ? ORDER BY created_at DESC, id ASC',
    [ownerId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name || '', command: r.command || '' }));
}

export async function getSnippet(ownerId: string, id: string): Promise<SnippetRow | null> {
  const row = await queryOne<any>('SELECT id, name, command FROM snippets WHERE owner_id = ? AND id = ?', [ownerId, id]);
  return row ? { id: row.id, name: row.name || '', command: row.command || '' } : null;
}

export async function upsertSnippet(ownerId: string, s: SnippetRow): Promise<void> {
  const now = new Date();
  await execute(
    `INSERT INTO snippets (owner_id, id, name, command, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       command = VALUES(command),
       updated_at = VALUES(updated_at)`,
    [ownerId, s.id, s.name || '', s.command || '', now, now],
  );
}

export async function deleteSnippetRow(ownerId: string, id: string): Promise<number> {
  const r = await execute('DELETE FROM snippets WHERE owner_id = ? AND id = ?', [ownerId, id]);
  return r.affectedRows;
}
