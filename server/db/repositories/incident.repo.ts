/**
 * incident 仓储（incidents）。
 *
 * 规则版归并：同一 connection 30 分钟内出现 ≥3 条**未解决**告警 → 算一件事。
 * 刻意不做根因推断、不做跨主机合并：
 * - 跨主机合并需要「它们真的是同一个原因」的证据，现在只有时间相关性；
 * - 根因推断在没有真实数据时做出来的都是演示效果（与 roadmap 的口径一致）。
 *
 * 为什么归并结果写回 `alerts.incident_id` 而不是建关联表：
 * 一条告警只属于一件事，多对多关系表在这里只是多一次 JOIN 和一份可能不一致的副本。
 *
 * 为什么事件状态只有 open / resolved：
 * 「已确认」属于告警层（acked），事件层关心的是「这一波结束了没有」。
 * 当归入的告警全部 resolved 时，事件由服务层置为 resolved（见 alert.service）。
 */
import { execute, query, queryOne } from '../pool';

export type IncidentStatus = 'open' | 'resolved';

/** 归并窗口：30 分钟。改成配置项等于允许把它调成 5 秒，那样每条告警都会自成一件事 */
export const INCIDENT_WINDOW_MS = 30 * 60_000;

/** 触发条数：同一主机 30 分钟内 ≥3 条未解决告警 */
export const INCIDENT_MIN_ALERTS = 3;

export interface IncidentRow {
  id: number;
  ownerId: string;
  connectionId: string;
  title: string;
  status: IncidentStatus;
  alertCount: number;
  startedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
}

const COLUMNS = 'id, owner_id, connection_id, title, status, alert_count, started_at, last_seen_at, resolved_at';

function toDate(value: any): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: any): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapRow(r: any): IncidentRow {
  return {
    id: Number(r.id),
    ownerId: String(r.owner_id),
    connectionId: String(r.connection_id),
    title: String(r.title || ''),
    status: String(r.status) as IncidentStatus,
    alertCount: Number(r.alert_count) || 0,
    startedAt: toDate(r.started_at),
    lastSeenAt: toDate(r.last_seen_at),
    resolvedAt: toDateOrNull(r.resolved_at),
  };
}

/** 窗口内还没解决的告警条数：这是「够不够算一件事」的唯一判据 */
export async function countRecentOpenAlerts(ownerId: string, connectionId: string, since: Date): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM alerts
      WHERE owner_id = ? AND connection_id = ? AND status <> 'resolved' AND last_seen >= ?`,
    [ownerId, connectionId, since],
  );
  return Number(row?.n) || 0;
}

/** 窗口内仍活跃的 open 事件：有就并进去，没有才新建（避免 15 分钟后又来一条就开第二件事） */
export async function findOpenIncident(
  ownerId: string,
  connectionId: string,
  since: Date,
): Promise<IncidentRow | undefined> {
  const rows = await query<any>(
    `SELECT ${COLUMNS} FROM incidents
      WHERE owner_id = ? AND connection_id = ? AND status = 'open' AND last_seen_at >= ?
      ORDER BY id DESC LIMIT 1`,
    [ownerId, connectionId, since],
  );
  return rows[0] ? mapRow(rows[0]) : undefined;
}

export async function insertIncident(
  ownerId: string,
  connectionId: string,
  title: string,
  at: Date,
): Promise<number> {
  const { insertId } = await execute(
    `INSERT INTO incidents (owner_id, connection_id, title, status, alert_count, started_at, last_seen_at)
     VALUES (?, ?, ?, 'open', 0, ?, ?)`,
    [ownerId, connectionId, title.slice(0, 255), at, at],
  );
  return Number(insertId);
}

/**
 * 把窗口内「还没归并」的未解决告警挂到事件上。
 * 只动 incident_id IS NULL 的行：已经属于另一件事的告警不能因为这次命中被改嫁。
 */
export async function attachRecentAlerts(
  ownerId: string,
  connectionId: string,
  incidentId: number,
  since: Date,
): Promise<number> {
  const { affectedRows } = await execute(
    `UPDATE alerts SET incident_id = ?
      WHERE owner_id = ? AND connection_id = ? AND incident_id IS NULL AND status <> 'resolved' AND last_seen >= ?`,
    [incidentId, ownerId, connectionId, since],
  );
  return affectedRows;
}

/** 人工关联：单条挂到指定事件上（仍要求同一账号、未解决） */
export async function attachAlertById(ownerId: string, alertId: number, incidentId: number): Promise<boolean> {
  const { affectedRows } = await execute(
    `UPDATE alerts SET incident_id = ?
      WHERE owner_id = ? AND id = ? AND status <> 'resolved'`,
    [incidentId, ownerId, alertId],
  );
  return affectedRows > 0;
}

/** 重算条数并前移 last_seen_at：条数不靠应用层记账，永远以 alerts 表为准 */
export async function refreshIncidentStats(incidentId: number, at: Date): Promise<void> {
  await execute(
    `UPDATE incidents
        SET alert_count = (SELECT COUNT(*) FROM alerts WHERE incident_id = ?),
            last_seen_at = GREATEST(last_seen_at, ?)
      WHERE id = ?`,
    [incidentId, at, incidentId],
  );
}

export async function getIncidentById(ownerId: string, id: number): Promise<IncidentRow | undefined> {
  const rows = await query<any>(
    `SELECT ${COLUMNS} FROM incidents WHERE owner_id = ? AND id = ? LIMIT 1`,
    [ownerId, id],
  );
  return rows[0] ? mapRow(rows[0]) : undefined;
}

export async function listIncidents(
  ownerId: string,
  filter: { status?: IncidentStatus | ''; limit?: number } = {},
): Promise<IncidentRow[]> {
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
  const where: string[] = ['owner_id = ?'];
  const params: any[] = [ownerId];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  const rows = await query<any>(
    `SELECT ${COLUMNS} FROM incidents
      WHERE ${where.join(' AND ')}
      ORDER BY last_seen_at DESC, id DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map(mapRow);
}

/** 关联告警里还有没解决的条数：0 才允许把事件置为 resolved */
export async function countUnresolvedAlerts(ownerId: string, incidentId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM alerts
      WHERE owner_id = ? AND incident_id = ? AND status <> 'resolved'`,
    [ownerId, incidentId],
  );
  return Number(row?.n) || 0;
}

export async function resolveIncident(ownerId: string, incidentId: number, at: Date): Promise<boolean> {
  const { affectedRows } = await execute(
    `UPDATE incidents SET status = 'resolved', resolved_at = ?
      WHERE owner_id = ? AND id = ? AND status = 'open'`,
    [at, ownerId, incidentId],
  );
  return affectedRows > 0;
}

/** 清理：已解决且超过保留期的事件。未解决的一律留着（和告警同一条原则） */
export async function pruneResolvedIncidents(before: Date): Promise<number> {
  const { affectedRows } = await execute(
    `DELETE FROM incidents WHERE status = 'resolved' AND resolved_at < ?`,
    [before],
  );
  return affectedRows;
}
