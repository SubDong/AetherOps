/**
 * 命令审计仓储：audit/YYYY-MM-DD.jsonl 的替代品。
 *
 * 两个容易踩的点：
 * 1. audit_date 是 DATE 列，读写都用字符串 'YYYY-MM-DD'：
 *    用 DATE_FORMAT 取出来，避免驱动把它当本地零点转成 Date 后日期漂移一天。
 *    日期口径按本地时区切分，和旧文件名一致（不是 UTC）。
 * 2. keyword 同时走 ngram 全文索引和 LIKE：
 *    全文索引对 1 个字的词无效（ngram_token_size=2），LIKE 负责兜住这种短词；
 *    BOOLEAN MODE 的操作符会污染用户输入，必须先剥掉再按词加引号。
 */
import { execute, query, queryOne } from '../pool';

/** 取值由表上的 ck_audit_status 约束，所以这里可以直接写死成联合类型 */
export type AuditStatus = 'success' | 'error' | 'blocked' | 'rewritten';

export interface AuditEventRow {
  id: string;
  /** 归属账号：审计是「自己的命令记录」，不跨账号可见 */
  ownerId: string;
  /** 毫秒时间戳，落库转成 occurred_at */
  timestamp: number;
  sessionId: string;
  sessionName?: string;
  connectionId?: string;
  userMessage: string;
  tool: string;
  command: string;
  result: string;
  duration: number;
  status: AuditStatus;
  rewrittenFrom?: string;
}

export interface AuditQueryRow {
  /** 必填：查询不带 owner 就等于越权看别人的命令 */
  ownerId: string;
  date?: string;
  sessionId?: string;
  keyword?: string;
  status?: string;
  /** 工具名精确过滤：管理员看「只含文件传输」的流水时用 */
  tool?: string;
  limit?: number;
  offset?: number;
}

const SELECT_COLUMNS = `
  id, owner_id, occurred_at,
  DATE_FORMAT(audit_date, '%Y-%m-%d') AS audit_date,
  session_id, session_name, connection_id,
  user_message, tool, command, result,
  duration_ms, status, rewritten_from`;

/** 本地日期 'YYYY-MM-DD'，与旧 audit/<date>.jsonl 文件的切分口径保持一致 */
export function toAuditDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toEntry(row: any): AuditEventRow {
  const occurred = row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at);
  return {
    id: row.id,
    ownerId: row.owner_id,
    timestamp: occurred.getTime(),
    sessionId: row.session_id,
    sessionName: row.session_name ?? undefined,
    connectionId: row.connection_id ?? undefined,
    userMessage: row.user_message || '',
    tool: row.tool || '',
    command: row.command || '',
    result: row.result || '',
    duration: Number(row.duration_ms) || 0,
    status: row.status,
    rewrittenFrom: row.rewritten_from ?? undefined,
  };
}

function toBooleanQuery(keyword: string): string {
  return keyword
    .split(/\s+/)
    .map((t) => t.replace(/[+\-<>()~*@"^]/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' ');
}

function buildWhere(q: AuditQueryRow): { sql: string; params: any[] } {
  // owner 永远是最外层的第一条：调用方即使漏传可选条件，也不会退化成全表扫描
  const clauses: string[] = ['owner_id = ?'];
  const params: any[] = [q.ownerId];

  if (q.date) {
    clauses.push('audit_date = ?');
    params.push(q.date);
  }
  if (q.sessionId) {
    clauses.push('session_id = ?');
    params.push(q.sessionId);
  }
  if (q.status) {
    clauses.push('status = ?');
    params.push(q.status);
  }
  if (q.tool) {
    clauses.push('tool = ?');
    params.push(q.tool);
  }
  if (q.keyword) {
    const like = `%${q.keyword}%`;
    const bool = toBooleanQuery(q.keyword);
    if (bool) {
      clauses.push('(MATCH(user_message, command, result) AGAINST(? IN BOOLEAN MODE)'
        + ' OR user_message LIKE ? OR command LIKE ? OR result LIKE ?)');
      params.push(bool, like, like, like);
    } else {
      clauses.push('(user_message LIKE ? OR command LIKE ? OR result LIKE ?)');
      params.push(like, like, like);
    }
  }

  return {
    sql: `WHERE ${clauses.join(' AND ')}`,
    params,
  };
}

export async function insertAuditEvent(e: AuditEventRow): Promise<void> {
  const occurred = new Date(e.timestamp || Date.now());
  await execute(
    `INSERT INTO audit_events (id, owner_id, occurred_at, audit_date, session_id, session_name, connection_id,
       user_message, tool, command, result, duration_ms, status, rewritten_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.id,
      e.ownerId,
      occurred,
      toAuditDate(occurred),
      e.sessionId,
      e.sessionName || null,
      e.connectionId || null,
      e.userMessage || '',
      e.tool || '',
      e.command || '',
      e.result || '',
      Math.max(0, Math.round(e.duration || 0)),
      e.status || 'success',
      e.rewrittenFrom || null,
    ],
  );
}

export async function queryAuditEvents(q: AuditQueryRow): Promise<{ entries: AuditEventRow[]; total: number }> {
  const where = buildWhere(q);

  const countRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events ${where.sql}`,
    where.params,
  );

  // LIMIT / OFFSET 走内联整数：预处理占位符在部分驱动/服务端组合下不接受
  const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || 100), 1), 100000);
  const offset = Math.max(Math.trunc(Number(q.offset) || 0), 0);

  const rows = await query<any>(
    `SELECT ${SELECT_COLUMNS} FROM audit_events ${where.sql}
     ORDER BY occurred_at DESC, id LIMIT ${limit} OFFSET ${offset}`,
    where.params,
  );

  return { entries: rows.map(toEntry), total: Number(countRow?.n) || 0 };
}

/** 导出用：某个账号在一段日期范围内的全部流水 */
export async function listAuditRange(ownerId: string, startDate: string, endDate: string): Promise<AuditEventRow[]> {
  const rows = await query<any>(
    `SELECT ${SELECT_COLUMNS} FROM audit_events
     WHERE owner_id = ? AND audit_date BETWEEN ? AND ?
     ORDER BY occurred_at DESC`,
    [ownerId, startDate, endDate],
  );
  return rows.map(toEntry);
}

export async function countAuditByStatus(ownerId: string, date: string): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM audit_events WHERE owner_id = ? AND audit_date = ? GROUP BY status',
    [ownerId, date],
  );
  const result: Record<string, number> = {};
  for (const r of rows) result[r.status] = Number(r.n) || 0;
  return result;
}

export async function listAuditDates(ownerId: string): Promise<string[]> {
  const rows = await query<{ d: string }>(
    "SELECT DISTINCT DATE_FORMAT(audit_date, '%Y-%m-%d') AS d FROM audit_events WHERE owner_id = ? ORDER BY d DESC",
    [ownerId],
  );
  return rows.map((r) => r.d);
}

/** 保留期清理是全局策略，不按账号拆：到期就删，与谁产生的无关 */
export async function deleteAuditBefore(date: string): Promise<number> {
  const r = await execute('DELETE FROM audit_events WHERE audit_date < ?', [date]);
  return r.affectedRows;
}
