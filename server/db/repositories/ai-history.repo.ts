/**
 * AI 对话显示历史仓储：ai-history/<sessionId>.json 的替代品。
 *
 * 存的是给前端渲染的 DisplayMessage[]（含 agentSteps），与喂给模型的
 * ai_messages 是两份数据，不要合并——渲染层字段会不断长，模型上下文必须保持干净。
 *
 * 消息体走 JSON 列，本模块不关心内部结构（类型由 AIService 保证），
 * 读出来时兼容驱动「已解析成对象」和「原样返回字符串」两种行为。
 */
import { execute, query, queryOne } from '../pool';

export interface HistoryMetaRow {
  sessionId: string;
  sessionName: string;
  savedAt: number;
  messageCount: number;
  preview: string;
}

export interface SaveHistoryInput {
  ownerId: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
  preview: string;
  messages: any[];
  savedAt: number;
}

function parseMessages(value: any): any[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function saveHistory(input: SaveHistoryInput): Promise<void> {
  const now = new Date();
  const savedAt = input.savedAt ? new Date(input.savedAt) : now;
  await execute(
    `INSERT INTO ai_history (owner_id, session_id, session_name, message_count, preview, messages, saved_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       session_name = VALUES(session_name),
       message_count = VALUES(message_count),
       preview = VALUES(preview),
       messages = VALUES(messages),
       saved_at = VALUES(saved_at),
       updated_at = VALUES(updated_at)`,
    [
      input.ownerId,
      input.sessionId,
      input.sessionName || null,
      input.messageCount,
      (input.preview || '').substring(0, 512),
      JSON.stringify(input.messages || []),
      savedAt,
      now,
    ],
  );
}

export async function loadHistoryMessages(ownerId: string, sessionId: string): Promise<any[] | null> {
  const row = await queryOne<any>('SELECT messages FROM ai_history WHERE owner_id = ? AND session_id = ?', [ownerId, sessionId]);
  if (!row) return null;
  return parseMessages(row.messages);
}

export async function listHistories(ownerId: string): Promise<HistoryMetaRow[]> {
  const rows = await query<any>(
    'SELECT session_id, session_name, saved_at, message_count, preview FROM ai_history WHERE owner_id = ? ORDER BY saved_at DESC',
    [ownerId],
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    sessionName: r.session_name || '',
    savedAt: r.saved_at instanceof Date ? r.saved_at.getTime() : new Date(r.saved_at).getTime(),
    messageCount: Number(r.message_count) || 0,
    preview: r.preview || '',
  }));
}

export async function deleteHistory(ownerId: string, sessionId: string): Promise<number> {
  const r = await execute('DELETE FROM ai_history WHERE owner_id = ? AND session_id = ?', [ownerId, sessionId]);
  return r.affectedRows;
}
