/**
 * 告警仓储（alerts / alert_mutes）。
 *
 * 只做 SQL，不懂「新建 / 升级 / 重复」的语义 —— 那是 alert.service 的事。
 * 这里唯一值得解释的是**去重靠数据库唯一键兜底**：`uk_alerts_open` 建在生成列
 * `open_key` 上（未解决 = fingerprint，已解决 = NULL），所以「未关闭的同一指纹
 * 只能有一行」不依赖应用层先查后写；并发两路同时命中，只有一路能 INSERT 成功，
 * 另一路会拿到重复键错误，由服务层回落到 touch。
 */
import { execute, query } from '../pool';

export type AlertStatus = 'open' | 'acked' | 'resolved';
export type AlertLevel = 'warning' | 'error' | 'critical';
export type AlertSource = 'log' | 'command';

export interface AlertRow {
  id: number;
  ownerId: string;
  connectionId: string;
  fingerprint: string;
  status: AlertStatus;
  source: AlertSource;
  rule: string;
  level: AlertLevel;
  message: string;
  sampleText: string;
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
  ackedBy: string | null;
  ackedAt: Date | null;
  /** 处理人（账号 ID）。与 ackedBy 分开：确认是「我看到了」，指派是「这件事归你」 */
  assigneeId: string | null;
  /** 归并到的事件；NULL = 尚未归并 */
  incidentId: number | null;
  resolvedAt: Date | null;
}

export interface AlertInsertInput {
  ownerId: string;
  connectionId: string;
  fingerprint: string;
  source: AlertSource;
  rule: string;
  level: AlertLevel;
  message: string;
  sampleText: string;
  seenAt: Date;
}

export interface AlertTouchInput {
  id: number;
  level: AlertLevel;
  message: string;
  sampleText: string;
  seenAt: Date;
  /** 级别升级：已确认的行要退回 open 并清掉确认人，让人重新看一眼 */
  reopen: boolean;
}

export interface AlertListFilter {
  status?: AlertStatus | '';
  connectionId?: string;
  limit?: number;
  offset?: number;
}

export interface AlertMuteRow {
  rule: string;
  until: Date;
  createdAt: Date;
}

const COLUMNS = `id, owner_id, connection_id, fingerprint, status, source, rule, level,
                 message, sample_text, occurrences, first_seen, last_seen,
                 acked_by, acked_at, assignee_id, incident_id, resolved_at`;

function toDate(value: any): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: any): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapRow(r: any): AlertRow {
  return {
    id: Number(r.id),
    ownerId: String(r.owner_id),
    connectionId: String(r.connection_id),
    fingerprint: String(r.fingerprint),
    status: String(r.status) as AlertStatus,
    source: String(r.source) as AlertSource,
    rule: String(r.rule || ''),
    level: String(r.level) as AlertLevel,
    message: String(r.message || ''),
    sampleText: String(r.sample_text || ''),
    occurrences: Number(r.occurrences) || 0,
    firstSeen: toDate(r.first_seen),
    lastSeen: toDate(r.last_seen),
    ackedBy: r.acked_by === null || r.acked_by === undefined ? null : String(r.acked_by),
    ackedAt: toDateOrNull(r.acked_at),
    assigneeId: r.assignee_id === null || r.assignee_id === undefined ? null : String(r.assignee_id),
    incidentId: r.incident_id === null || r.incident_id === undefined ? null : Number(r.incident_id),
    resolvedAt: toDateOrNull(r.resolved_at),
  };
}

/** 找「同一指纹、尚未关闭」的那一行；没有返回 undefined */
export async function findOpenAlert(
  ownerId: string,
  connectionId: string,
  fingerprint: string,
): Promise<AlertRow | undefined> {
  const rows = await query<any>(
    `SELECT ${COLUMNS} FROM alerts
      WHERE owner_id = ? AND connection_id = ? AND fingerprint = ? AND status <> 'resolved'
      ORDER BY id DESC LIMIT 1`,
    [ownerId, connectionId, fingerprint],
  );
  return rows[0] ? mapRow(rows[0]) : undefined;
}

/** 新建一行；并发撞唯一键时抛错，由服务层回落 touch */
export async function insertAlert(input: AlertInsertInput): Promise<number> {
  const { insertId } = await execute(
    `INSERT INTO alerts (
       owner_id, connection_id, fingerprint, status, source, rule, level,
       message, sample_text, occurrences, first_seen, last_seen
     ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      input.ownerId,
      input.connectionId,
      input.fingerprint,
      input.source,
      input.rule,
      input.level,
      input.message,
      input.sampleText,
      input.seenAt,
      input.seenAt,
    ],
  );
  return Number(insertId);
}

/**
 * 重复命中：累加次数、刷新最近时间与文案。
 * 级别只升不降（`level` 由服务层算好传进来）；`reopen` 时才把 acked 退回 open。
 */
export async function touchAlert(input: AlertTouchInput): Promise<void> {
  if (input.reopen) {
    await execute(
      `UPDATE alerts
          SET occurrences = occurrences + 1, last_seen = ?, message = ?, sample_text = ?,
              level = ?, status = 'open', acked_by = NULL, acked_at = NULL
        WHERE id = ?`,
      [input.seenAt, input.message, input.sampleText, input.level, input.id],
    );
    return;
  }
  await execute(
    `UPDATE alerts
        SET occurrences = occurrences + 1, last_seen = ?, message = ?, sample_text = ?, level = ?
      WHERE id = ?`,
    [input.seenAt, input.message, input.sampleText, input.level, input.id],
  );
}

export async function getAlertById(ownerId: string, id: number): Promise<AlertRow | undefined> {
  const rows = await query<any>(
    `SELECT ${COLUMNS} FROM alerts WHERE owner_id = ? AND id = ? LIMIT 1`,
    [ownerId, id],
  );
  return rows[0] ? mapRow(rows[0]) : undefined;
}

/** 列表：按最近命中倒序；status 为空表示全部 */
export async function listAlerts(ownerId: string, filter: AlertListFilter = {}): Promise<AlertRow[]> {
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
  const offset = Math.max(Number(filter.offset) || 0, 0);
  const where: string[] = ['owner_id = ?'];
  const params: any[] = [ownerId];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.connectionId) {
    where.push('connection_id = ?');
    params.push(filter.connectionId);
  }
  const rows = await query<any>(
    `SELECT ${COLUMNS} FROM alerts
      WHERE ${where.join(' AND ')}
      ORDER BY last_seen DESC, id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return rows.map(mapRow);
}

/** 顶部计数（全部 / 未关闭），供列表头与前端徽标用 */
export async function countAlerts(ownerId: string): Promise<{ open: number; acked: number; resolved: number }> {
  const rows = await query<any>(
    `SELECT status, COUNT(*) AS n FROM alerts WHERE owner_id = ? GROUP BY status`,
    [ownerId],
  );
  const out = { open: 0, acked: 0, resolved: 0 };
  for (const r of rows) {
    const key = String(r.status) as keyof typeof out;
    if (key in out) out[key] = Number(r.n) || 0;
  }
  return out;
}

/** 确认：只有 open 能被确认（重复点按不会覆盖第一个确认人） */
export async function ackAlert(ownerId: string, id: number, userId: string, at: Date): Promise<boolean> {
  const { affectedRows } = await execute(
    `UPDATE alerts SET status = 'acked', acked_by = ?, acked_at = ?
      WHERE owner_id = ? AND id = ? AND status = 'open'`,
    [userId, at, ownerId, id],
  );
  return affectedRows > 0;
}

/** 标记已解决：open / acked 都能解决；已解决重复点按返回 false */
export async function resolveAlert(ownerId: string, id: number, at: Date): Promise<boolean> {
  const { affectedRows } = await execute(
    `UPDATE alerts SET status = 'resolved', resolved_at = ?
      WHERE owner_id = ? AND id = ? AND status <> 'resolved'`,
    [at, ownerId, id],
  );
  return affectedRows > 0;
}

/**
 * 只清「已解决」的旧行。
 * open / acked 不清是有意的：没处理完的告警被保留期悄悄删掉，等于把问题藏起来。
 */
export async function pruneResolvedAlerts(before: Date): Promise<number> {
  const { affectedRows } = await execute(
    `DELETE FROM alerts WHERE status = 'resolved' AND resolved_at < ?`,
    [before],
  );
  return affectedRows;
}

/**
 * 认领 = 确认 + 指派给自己。
 * 已确认过的行只改处理人，不覆盖第一个确认人（COALESCE 的方向很重要：
 * 「谁先看到」是事后追溯的依据，不能被后来点认领的人改写）。
 * 已解决的行不接受认领 —— 那是历史，不再属于任何人。
 */
export async function claimAlert(ownerId: string, id: number, userId: string, at: Date): Promise<boolean> {
  const { affectedRows } = await execute(
    `UPDATE alerts
        SET status = CASE WHEN status = 'open' THEN 'acked' ELSE status END,
            acked_by = COALESCE(acked_by, ?),
            acked_at = COALESCE(acked_at, ?),
            assignee_id = ?
      WHERE owner_id = ? AND id = ? AND status <> 'resolved'`,
    [userId, at, userId, ownerId, id],
  );
  return affectedRows > 0;
}

/** 转派 / 清空处理人；同样只对未解决的行生效 */
export async function assignAlert(ownerId: string, id: number, assigneeId: string | null): Promise<boolean> {
  const { affectedRows } = await execute(
    'UPDATE alerts SET assignee_id = ? WHERE owner_id = ? AND id = ? AND status <> \'resolved\'',
    [assigneeId, ownerId, id],
  );
  return affectedRows > 0;
}

// ========== 值班表 ==========

export interface AlertOnCallRow {
  userId: string;
  username: string;
  displayName: string;
  /** 每日开始（0-1439，本地时区） */
  startMinute: number;
  /** 每日结束（0-1440，左闭右开；小于 start 表示跨零点） */
  endMinute: number;
}

/** JOIN users 只为拿「@谁」的名字；账号被删后这一行自然不再出现 */
export async function listOnCall(ownerId: string): Promise<AlertOnCallRow[]> {
  const rows = await query<any>(
    `SELECT o.user_id, u.username, u.display_name, o.start_minute, o.end_minute
       FROM alert_oncall o
       JOIN users u ON u.id = o.user_id
      WHERE o.owner_id = ?
      ORDER BY o.start_minute ASC, u.username ASC`,
    [ownerId],
  );
  return rows.map((r) => ({
    userId: String(r.user_id),
    username: String(r.username),
    displayName: String(r.display_name || r.username),
    startMinute: Number(r.start_minute) || 0,
    endMinute: Number(r.end_minute) || 0,
  }));
}

/** 同一人同一开始时间就是同一个时间窗：改结束时间等于覆盖 */
export async function upsertOnCall(
  ownerId: string,
  userId: string,
  startMinute: number,
  endMinute: number,
  at: Date,
): Promise<void> {
  await execute(
    'INSERT INTO alert_oncall (owner_id, user_id, start_minute, end_minute, created_at) VALUES (?, ?, ?, ?, ?)\n'
      + 'ON DUPLICATE KEY UPDATE end_minute = VALUES(end_minute), created_at = VALUES(created_at)',
    [ownerId, userId, startMinute, endMinute, at],
  );
}

export async function deleteOnCall(ownerId: string, userId: string, startMinute: number): Promise<number> {
  const { affectedRows } = await execute(
    'DELETE FROM alert_oncall WHERE owner_id = ? AND user_id = ? AND start_minute = ?',
    [ownerId, userId, startMinute],
  );
  return affectedRows;
}

// ========== 规则级静默 ==========

export async function listActiveMutes(ownerId: string, at: Date): Promise<AlertMuteRow[]> {
  const rows = await query<any>(
    'SELECT rule, `until`, created_at FROM alert_mutes WHERE owner_id = ? AND `until` > ? ORDER BY `until` DESC',
    [ownerId, at],
  );
  return rows.map((r) => ({
    rule: String(r.rule),
    until: toDate(r.until),
    createdAt: toDate(r.created_at),
  }));
}

/** 设置/延长静默窗口（同一规则后设的覆盖先设的） */
export async function upsertMute(ownerId: string, rule: string, until: Date, at: Date): Promise<void> {
  await execute(
    'INSERT INTO alert_mutes (owner_id, rule, `until`, created_at) VALUES (?, ?, ?, ?)\n'
      + 'ON DUPLICATE KEY UPDATE `until` = VALUES(`until`), created_at = VALUES(created_at)',
    [ownerId, rule, until, at],
  );
}

export async function deleteMute(ownerId: string, rule: string): Promise<number> {
  const { affectedRows } = await execute(
    'DELETE FROM alert_mutes WHERE owner_id = ? AND rule = ?',
    [ownerId, rule],
  );
  return affectedRows;
}

/** 清掉已过期的静默行；每次查询/设置顺带清理，避免表无限长 */
export async function pruneExpiredMutes(at: Date): Promise<number> {
  const { affectedRows } = await execute('DELETE FROM alert_mutes WHERE `until` <= ?', [at]);
  return affectedRows;
}
