/**
 * AI 对话窗口仓储。
 *
 * 一条记录 = 一个对话窗口，而不是一次终端会话：
 * - connection_id 决定它出现在哪个连接的对话列表里；
 * - model_id 记住这个对话上次用的模型（'auto' 或 ai_config.id）；
 * - 消息体仍在 ai_history（展示用）与 ai_messages（喂模型用）里，
 *   这两张表的 session_id 现在存的是 chatId，不再是终端 sessionId。
 *
 * 顺带记 message_count / preview 是为了列表页一次查询就能渲染，
 * 不必为了显示摘要去把 JSON 消息体也读出来。
 */
import { execute, query, queryOne } from '../pool';

export interface AIChatRow {
  id: string;
  connectionId: string;
  title: string;
  modelId: string;
  messageCount: number;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

const COLUMNS = 'id, connection_id, title, model_id, message_count, preview, created_at, updated_at';

function toMillis(value: any): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function mapRow(row: any): AIChatRow {
  return {
    id: row.id,
    connectionId: row.connection_id || '',
    title: row.title || '',
    modelId: row.model_id || 'auto',
    messageCount: Number(row.message_count) || 0,
    preview: row.preview || '',
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export async function insertChatRow(
  ownerId: string,
  chat: { id: string; connectionId: string; title: string; modelId: string },
): Promise<void> {
  const now = new Date();
  await execute(
    `INSERT INTO ai_chats (id, owner_id, connection_id, title, model_id, message_count, preview, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, '', ?, ?)`,
    [chat.id, ownerId, chat.connectionId || '', chat.title || '', chat.modelId || 'auto', now, now],
  );
}

export async function listChatRows(ownerId: string, connectionId?: string): Promise<AIChatRow[]> {
  const rows = connectionId
    ? await query<any>(
      `SELECT ${COLUMNS} FROM ai_chats WHERE owner_id = ? AND connection_id = ? ORDER BY updated_at DESC`,
      [ownerId, connectionId],
    )
    : await query<any>(
      `SELECT ${COLUMNS} FROM ai_chats WHERE owner_id = ? ORDER BY updated_at DESC`,
      [ownerId],
    );
  return rows.map(mapRow);
}

export async function loadChatRow(ownerId: string, id: string): Promise<AIChatRow | null> {
  const row = await queryOne<any>(
    `SELECT ${COLUMNS} FROM ai_chats WHERE owner_id = ? AND id = ?`,
    [ownerId, id],
  );
  return row ? mapRow(row) : null;
}

/** 可更新字段白名单：拼接 SQL 的列名只能来自这里，不能来自请求体 */
const FIELD_COLUMNS: Record<string, string> = {
  title: 'title',
  modelId: 'model_id',
  messageCount: 'message_count',
  preview: 'preview',
  connectionId: 'connection_id',
};

export async function updateChatRow(
  ownerId: string,
  id: string,
  patch: Partial<Pick<AIChatRow, 'title' | 'modelId' | 'messageCount' | 'preview' | 'connectionId'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  for (const [key, column] of Object.entries(FIELD_COLUMNS)) {
    const value = (patch as any)[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(key === 'preview' ? String(value).substring(0, 512) : value);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  params.push(new Date(), ownerId, id);
  await execute(`UPDATE ai_chats SET ${sets.join(', ')} WHERE owner_id = ? AND id = ?`, params);
}

export async function deleteChatRow(ownerId: string, id: string): Promise<number> {
  const r = await execute('DELETE FROM ai_chats WHERE owner_id = ? AND id = ?', [ownerId, id]);
  return r.affectedRows;
}
