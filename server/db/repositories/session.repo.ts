/**
 * 终端会话元数据仓储：sessions.json 的替代品。
 *
 * 只存「重启后要恢复 tab」所需的元数据，活的 PTY / SSH 句柄仍在 SSHService 内存里，
 * 所以这里没有并发写问题：每条 session 一次 upsert，不再整文件重写。
 *
 * created_at 在更新分支里刻意不动（不放进 UPDATE 列表），
 * 否则每次改名字 / 采到 MOTD 都会把 tab 的创建时间刷成「刚刚」。
 */
import { execute, query } from '../pool';

export interface SessionMetaRow {
  sessionId: string;
  /** 归属账号；重启恢复时按它过滤，不同账号的 tab 互不可见 */
  ownerId: string;
  connectionId: string;
  type: 'ssh' | 'local';
  name: string;
  /** AI 上下文用的系统信息；空字符串表示还没采集到 */
  systemContext: string;
  createdAt: Date;
}

const COLUMNS = 'session_id, owner_id, connection_id, type, name, system_context, created_at';

export async function listSessionMeta(ownerId?: string): Promise<SessionMetaRow[]> {
  const rows = ownerId
    ? await query<any>(`SELECT ${COLUMNS} FROM sessions WHERE owner_id = ? ORDER BY created_at ASC`, [ownerId])
    : await query<any>(`SELECT ${COLUMNS} FROM sessions ORDER BY created_at ASC`);
  return rows.map((r) => ({
    sessionId: r.session_id,
    ownerId: r.owner_id,
    connectionId: r.connection_id,
    type: r.type === 'local' ? 'local' : 'ssh',
    name: r.name || '',
    systemContext: r.system_context || '',
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  }));
}

export async function upsertSessionMeta(m: SessionMetaRow): Promise<void> {
  const now = new Date();
  await execute(
    `INSERT INTO sessions (session_id, owner_id, connection_id, type, name, system_context, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       connection_id = VALUES(connection_id),
       type = VALUES(type),
       name = VALUES(name),
       system_context = VALUES(system_context),
       updated_at = VALUES(updated_at)`,
    [
      m.sessionId,
      m.ownerId,
      m.connectionId || '',
      m.type === 'local' ? 'local' : 'ssh',
      m.name || '',
      m.systemContext || '',
      m.createdAt || now,
      now,
    ],
  );
}

/** 删除会话元数据；带上 ownerId 时只能删自己的 */
export async function deleteSessionMeta(sessionId: string, ownerId?: string): Promise<number> {
  const r = ownerId
    ? await execute('DELETE FROM sessions WHERE session_id = ? AND owner_id = ?', [sessionId, ownerId])
    : await execute('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
  return r.affectedRows;
}
