/**
 * AI 模型上下文仓储：messages/<sessionId>.json 的替代品。
 *
 * 整包覆盖写：agent 每轮结束把 engine 的 history snapshot 整体存一次，
 * 只保留最近 MAX_MESSAGES 条（裁剪在 AIService 做，这里不做业务判断）。
 * session_id 直接用原始值——旧实现把它塞进文件名，才需要把非法字符替换掉。
 */
import { execute, queryOne } from '../pool';

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

export async function saveChatMessages(ownerId: string, sessionId: string, messages: any[]): Promise<void> {
  const now = new Date();
  await execute(
    `INSERT INTO ai_messages (owner_id, session_id, messages, message_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       messages = VALUES(messages),
       message_count = VALUES(message_count),
       updated_at = VALUES(updated_at)`,
    [ownerId, sessionId, JSON.stringify(messages || []), (messages || []).length, now, now],
  );
}

export async function loadChatMessages(ownerId: string, sessionId: string): Promise<any[] | null> {
  const row = await queryOne<any>('SELECT messages FROM ai_messages WHERE owner_id = ? AND session_id = ?', [ownerId, sessionId]);
  if (!row) return null;
  return parseMessages(row.messages);
}

export async function deleteChatMessages(ownerId: string, sessionId: string): Promise<number> {
  const r = await execute('DELETE FROM ai_messages WHERE owner_id = ? AND session_id = ?', [ownerId, sessionId]);
  return r.affectedRows;
}
