/**
 * 告警服务（P5）。
 *
 * 状态机只有三个状态，但每条转移都有明确触发条件，写在这里免得以后靠猜：
 *
 *   （无） --新建--> open --ack--> acked --resolve--> resolved
 *     ^                 |                              |
 *     |                 +-- 同指纹再次命中：只累加，状态不变（不吵第二遍）
 *     |                 +-- 级别升级：退回 open、清掉确认人，并再投递一次
 *     +------------------------------------------------+  resolved 后同指纹再命中 = 新告警
 *
 * 为什么去重键里带 connection 而不带 session：与 error_fingerprints 一致 —— 触发它的
 * 终端断开不代表问题结束；同一句报错在 3 台机器上就是 3 条告警，这是有意的。
 *
 * 为什么静默只挡投递、不挡写入：静默是「先别吵我」，不是「当没发生」。恢复后
 * 列表里能看到这段时间累计了多少次，这比什么都重要。
 */
import { fingerprintLine } from '../utils/fingerprint';
import {
  ackAlert,
  assignAlert,
  claimAlert,
  countAlerts,
  deleteMute,
  deleteOnCall,
  findOpenAlert,
  getAlertById,
  insertAlert,
  listActiveMutes,
  listAlerts,
  listOnCall,
  pruneExpiredMutes,
  pruneResolvedAlerts,
  resolveAlert,
  touchAlert,
  upsertMute,
  upsertOnCall,
} from '../db/repositories/alert.repo';
import type { AlertLevel, AlertListFilter, AlertMuteRow, AlertOnCallRow, AlertRow } from '../db/repositories/alert.repo';
import {
  INCIDENT_MIN_ALERTS,
  INCIDENT_WINDOW_MS,
  attachAlertById,
  attachRecentAlerts,
  countRecentOpenAlerts,
  countUnresolvedAlerts,
  findOpenIncident,
  getIncidentById,
  insertIncident,
  listIncidents,
  pruneResolvedIncidents,
  refreshIncidentStats,
  resolveIncident,
} from '../db/repositories/incident.repo';
import type { IncidentRow, IncidentStatus } from '../db/repositories/incident.repo';
import { listActiveMembers } from '../db/repositories/user.repo';
import type { MemberBrief } from '../db/repositories/user.repo';
import type { AlertDeliveryKind, AlertDispatcher } from './alert-dispatcher';

/** 日志监控命中一行的入参（monitor.service 的 sink 形状） */
export interface MonitorAlertInput {
  ownerId?: string;
  connectionId?: string;
  monitorId?: string;
  /** 规则标识 = 日志监控的匹配正则，静默按它生效 */
  rule?: string;
  level?: string;
  /** 命中的那一行原文 */
  line?: string;
  /** 命中时间（毫秒）；缺省 now */
  at?: number;
}

export interface AlertIngestResult {
  action: 'created' | 'escalated' | 'updated' | 'skipped';
  alert?: AlertRow;
  /** 本次是否被归并进某个 incident（新建或并入） */
  incidentId?: number | null;
}

export interface AttachIncidentResult {
  incidentId: number;
  /** true = 这条告警让事件被新建出来 */
  created: boolean;
}

const LEVEL_RANK: Record<AlertLevel, number> = { warning: 1, error: 2, critical: 3 };

/** 与 error_fingerprints 的列宽一致 */
const MAX_RULE_CHARS = 128;
const MAX_MESSAGE_CHARS = 512;

function normalizeLevel(value: string | undefined): AlertLevel {
  const level = String(value || '').toLowerCase();
  if (level === 'critical' || level === 'warning') return level;
  return 'error';
}

/**
 * 本地终端的连接 ID 有 `''` / `local` / `__local__` 三种写法（前端、监控、SSH 服务
 * 各自的历史包袱）。落库前统一成 `__local__`，否则同一台本机会散成三行。
 */
export function normalizeConnectionId(value: string | undefined): string {
  const id = String(value || '').trim();
  if (!id || id === 'local' || id === '__local__') return '__local__';
  return id;
}

function clamp(text: string | undefined, max: number): string {
  return String(text || '').slice(0, max);
}

function isDuplicateKey(error: any): boolean {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

/**
 * 一个每日时间窗是否覆盖某一分钟（本地时区）。
 * start < end 是普通区间；start > end 表示跨零点（20:00-08:00），
 * 此时 [start, 1440) ∪ [0, end) 都算在岗。
 */
export function inOnCallWindow(minute: number, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return false;
  if (startMinute < endMinute) return minute >= startMinute && minute < endMinute;
  return minute >= startMinute || minute < endMinute;
}

export class AlertService {
  /** 只清已解决的旧行；没处理完的告警不能因为保留期被藏起来 */
  private readonly retentionDays = 30;
  private readonly pruneIntervalMs = 6 * 3600_000;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dispatcher?: AlertDispatcher) {}

  /** 等库就绪后由 initServices() 调用：先清一次，再起定时器 */
  async init(): Promise<void> {
    await this.prune();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.prune(); }, this.pruneIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.dispatcher?.stop();
  }

  /**
   * 日志监控入口。
   * **永不抛错**：调用方是 tail -f 的数据回调，告警记账失败不能把监控打断。
   */
  async recordFromMonitor(input: MonitorAlertInput): Promise<AlertIngestResult> {
    try {
      return await this.ingest(input);
    } catch (error: any) {
      console.warn(`[AlertService] 告警记账失败（不影响监控）: ${error?.message || error}`);
      return { action: 'skipped' };
    }
  }

  /**
   * 记账：指纹去重 + 状态机 + 条件投递。
   * 单独暴露（而不是只给 recordFromMonitor）是为了让验证脚本能直接断言抛错行为。
   */
  async ingest(input: MonitorAlertInput): Promise<AlertIngestResult> {
    const ownerId = String(input.ownerId || '').trim();
    if (!ownerId) return { action: 'skipped' };
    const connectionId = normalizeConnectionId(input.connectionId);
    const found = fingerprintLine(input.line || '');
    if (!found) return { action: 'skipped' };

    const rule = clamp(input.rule, MAX_RULE_CHARS) || 'log-pattern';
    const level = normalizeLevel(input.level);
    const seenAt = input.at ? new Date(input.at) : new Date();
    const message = clamp((input.line || '').trim(), MAX_MESSAGE_CHARS);

    let existing = await findOpenAlert(ownerId, connectionId, found.fingerprint);
    if (!existing) {
      try {
        const id = await insertAlert({
          ownerId,
          connectionId,
          fingerprint: found.fingerprint,
          source: 'log',
          rule,
          level,
          message,
          sampleText: found.sampleText,
          seenAt,
        });
        const created = await getAlertById(ownerId, id);
        if (created) await this.deliver('created', created);
        // 归并在投递之后：投递只关心这一条，归并失败不能把告警本身搞成失败
        const incidentId = created
          ? await this.maybeGroupIncident(ownerId, connectionId, created.message, seenAt)
          : null;
        return { action: 'created', alert: created, incidentId };
      } catch (error) {
        // 并发下另一路已经插入：回落到「累计」分支，不把唯一键冲突抛给 tail 回调
        if (!isDuplicateKey(error)) throw error;
        existing = await findOpenAlert(ownerId, connectionId, found.fingerprint);
        if (!existing) throw error;
      }
    }

    const escalate = LEVEL_RANK[level] > LEVEL_RANK[existing.level];
    await touchAlert({
      id: existing.id,
      level: escalate ? level : existing.level,
      message,
      sampleText: found.sampleText,
      seenAt,
      reopen: escalate,
    });
    const updated = (await getAlertById(ownerId, existing.id)) || existing;
    if (escalate) {
      await this.deliver('escalated', updated);
      return { action: 'escalated', alert: updated };
    }
    return { action: 'updated', alert: updated };
  }

  async list(ownerId: string, filter: AlertListFilter = {}): Promise<{
    items: Array<AlertRow & { assigneeName: string | null; ackedByName: string | null }>;
    counts: { open: number; acked: number; resolved: number };
  }> {
    const [items, counts] = await Promise.all([listAlerts(ownerId, filter), countAlerts(ownerId)]);
    // 成员名单只用来把账号 ID 换成显示名；查失败就退化成显示 ID，不能让整个列表 500
    const names = await this.memberNames();
    return {
      items: items.map((item) => ({
        ...item,
        assigneeName: item.assigneeId ? names.get(item.assigneeId) || item.assigneeId : null,
        ackedByName: item.ackedBy ? names.get(item.ackedBy) || item.ackedBy : null,
      })),
      counts,
    };
  }

  /** 确认：只有 open 能确认；返回 null 表示状态已经变了（重复点按 / 已解决） */
  async ack(ownerId: string, id: number, userId: string): Promise<AlertRow | null> {
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid alert id');
    const ok = await ackAlert(ownerId, id, userId, new Date());
    if (!ok) return null;
    return (await getAlertById(ownerId, id)) || null;
  }

  /**
   * 认领 = 确认 + 指派给自己。
   * 与 ack 分开暴露：认领在告警已经被别人确认过时也要能成功（转派给自己接手），
   * 而 ack 的重入语义是「只在 open 时生效」。
   */
  async claim(ownerId: string, id: number, userId: string): Promise<AlertRow | null> {
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid alert id');
    const ok = await claimAlert(ownerId, id, userId, new Date());
    if (!ok) return null;
    return (await getAlertById(ownerId, id)) || null;
  }

  /** 转派 / 清空处理人：assigneeId 传空表示取消指派 */
  async assign(ownerId: string, id: number, assigneeId: string): Promise<AlertRow | null> {
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid alert id');
    const target = String(assigneeId || '').trim();
    if (target) {
      const members = await listActiveMembers();
      // 指派给不存在/已禁用的账号 = 把一个告警交给没人 —— 直接拒，不要静默落库
      if (!members.some((m) => m.id === target)) throw new Error('Unknown or inactive member');
    }
    const ok = await assignAlert(ownerId, id, target || null);
    if (!ok) return null;
    return (await getAlertById(ownerId, id)) || null;
  }

  /** 可指派成员（只含 active 账号的 id / username / displayName） */
  async members(): Promise<MemberBrief[]> {
    return listActiveMembers();
  }

  /** 当前值班表（全部时间窗，按开始时间排序） */
  async onCall(ownerId: string): Promise<AlertOnCallRow[]> {
    return listOnCall(ownerId);
  }

  /** 新增/修改一个值班时间窗（同人同开始时间 = 覆盖结束时间） */
  async setOnCall(ownerId: string, userId: string, startMinute: number, endMinute: number): Promise<AlertOnCallRow[]> {
    const target = String(userId || '').trim();
    if (!target) throw new Error('Missing parameter: userId');
    const members = await listActiveMembers();
    if (!members.some((m) => m.id === target)) throw new Error('Unknown or inactive member');

    const start = Math.round(Number(startMinute));
    const end = Math.round(Number(endMinute));
    if (!Number.isInteger(start) || start < 0 || start > 1439) throw new Error('startMinute 必须在 0-1439 之间');
    // end 允许 1440（当天 24:00），否则「到半夜为止」没法表达
    if (!Number.isInteger(end) || end < 1 || end > 1440) throw new Error('endMinute 必须在 1-1440 之间');
    if (start === end) throw new Error('时间窗长度为 0');

    await upsertOnCall(ownerId, target, start, end, new Date());
    return listOnCall(ownerId);
  }

  async clearOnCall(ownerId: string, userId: string, startMinute: number): Promise<AlertOnCallRow[]> {
    const target = String(userId || '').trim();
    if (!target) throw new Error('Missing parameter: userId');
    const start = Math.round(Number(startMinute));
    if (!Number.isInteger(start) || start < 0 || start > 1439) throw new Error('startMinute 必须在 0-1439 之间');
    await deleteOnCall(ownerId, target, start);
    return listOnCall(ownerId);
  }

  /**
   * 此刻谁在岗（本地时区）。
   * 同一时刻有多人值班时只取第一位（按开始时间排序）—— webhook 只 @ 一个主值班人，
   * 否则一次告警能把整个群都点到。
   */
  async onCallAt(ownerId: string, at: Date): Promise<AlertOnCallRow | null> {
    const minute = at.getHours() * 60 + at.getMinutes();
    const rows = await listOnCall(ownerId);
    return rows.find((row) => inOnCallWindow(minute, row.startMinute, row.endMinute)) || null;
  }

  /** 事件列表（规则版归并的结果） */
  async incidents(ownerId: string, filter: { status?: IncidentStatus | ''; limit?: number } = {}): Promise<IncidentRow[]> {
    return listIncidents(ownerId, filter);
  }

  /**
   * 人工关联：把一条告警并进「同主机仍然活跃的事件」，没有就新建一个。
   * 与自动归并共用窗口常量，所以手动和自动不会各算各的时间窗。
   */
  async attachIncident(ownerId: string, alertId: number): Promise<AttachIncidentResult | null> {
    if (!Number.isFinite(alertId) || alertId <= 0) throw new Error('Invalid alert id');
    const alert = await getAlertById(ownerId, alertId);
    if (!alert) return null;
    if (alert.incidentId) return { incidentId: alert.incidentId, created: false };

    const now = new Date();
    const since = new Date(now.getTime() - INCIDENT_WINDOW_MS);
    let incident = await findOpenIncident(ownerId, alert.connectionId, since);
    let created = false;
    if (!incident) {
      const id = await insertIncident(ownerId, alert.connectionId, alert.message, now);
      incident = await getIncidentById(ownerId, id);
      created = true;
    }
    if (!incident) return null;

    await attachAlertById(ownerId, alert.id, incident.id);
    // 人工关联的意图是「归成一件事」，所以同主机窗口内其他未归并告警也一并带进来
    await attachRecentAlerts(ownerId, alert.connectionId, incident.id, since);
    await refreshIncidentStats(incident.id, now);
    return { incidentId: incident.id, created };
  }

  async resolve(ownerId: string, id: number): Promise<AlertRow | null> {
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid alert id');
    const now = new Date();
    const ok = await resolveAlert(ownerId, id, now);
    if (!ok) return null;
    const updated = (await getAlertById(ownerId, id)) || null;
    // 事件是否结束只看「关联告警里还有没有没解决的」：最后一条解决才关事件
    if (updated?.incidentId) {
      try {
        const left = await countUnresolvedAlerts(ownerId, updated.incidentId);
        if (left === 0) await resolveIncident(ownerId, updated.incidentId, now);
      } catch (error: any) {
        console.warn(`[AlertService] 事件收尾失败（不影响告警）: ${error?.message || error}`);
      }
    }
    return updated;
  }

  /** 当前生效的静默窗口（顺手清掉已过期的行） */
  async mutes(ownerId: string): Promise<AlertMuteRow[]> {
    const now = new Date();
    await pruneExpiredMutes(now);
    return listActiveMutes(ownerId, now);
  }

  /** 静默某条规则 N 分钟；minutes 夹在 1 ~ 7 天 */
  async mute(ownerId: string, rule: string, minutes: number): Promise<AlertMuteRow[]> {
    const key = clamp(String(rule || '').trim(), MAX_RULE_CHARS);
    if (!key) throw new Error('Missing parameter: rule');
    const span = Math.min(Math.max(Math.round(Number(minutes) || 0), 1), 7 * 24 * 60);
    const now = new Date();
    await upsertMute(ownerId, key, new Date(now.getTime() + span * 60_000), now);
    return this.mutes(ownerId);
  }

  async unmute(ownerId: string, rule: string): Promise<AlertMuteRow[]> {
    const key = clamp(String(rule || '').trim(), MAX_RULE_CHARS);
    if (!key) throw new Error('Missing parameter: rule');
    await deleteMute(ownerId, key);
    return this.mutes(ownerId);
  }

  /** 跑一次清理并返回删除行数（验证脚本直接调它，不必等定时器） */
  async pruneNow(retentionDays = this.retentionDays): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000);
    const removed = await pruneResolvedAlerts(cutoff);
    // 事件跟着告警一起清：告警行都没了，事件就只剩一个空壳
    await pruneResolvedIncidents(cutoff);
    return removed;
  }

  private async prune(): Promise<void> {
    try {
      const removed = await this.pruneNow();
      if (removed > 0) {
        console.log(`[AlertService] 清理已解决的旧告警 ${removed} 条（保留 ${this.retentionDays} 天）`);
      }
    } catch (error: any) {
      console.error('[AlertService] 清理旧告警失败:', error?.message || error);
    }
  }

  /** 账号 ID → 显示名；查失败返回空表，调用方自行退化 */
  private async memberNames(): Promise<Map<string, string>> {
    try {
      const members = await listActiveMembers();
      return new Map(members.map((m) => [m.id, m.displayName]));
    } catch {
      return new Map();
    }
  }

  /**
   * 规则版归并：同主机 30 分钟内 ≥3 条未解决告警 → 新建或并入一个 incident。
   * **永不抛错**：它跑在 ingest 尾部，归并失败不能让一条告警写不进去。
   */
  private async maybeGroupIncident(
    ownerId: string,
    connectionId: string,
    title: string,
    at: Date,
  ): Promise<number | null> {
    try {
      const since = new Date(at.getTime() - INCIDENT_WINDOW_MS);
      const recent = await countRecentOpenAlerts(ownerId, connectionId, since);
      if (recent < INCIDENT_MIN_ALERTS) return null;

      let incident = await findOpenIncident(ownerId, connectionId, since);
      if (!incident) {
        const id = await insertIncident(ownerId, connectionId, title, at);
        incident = await getIncidentById(ownerId, id);
      }
      if (!incident) return null;

      await attachRecentAlerts(ownerId, connectionId, incident.id, since);
      await refreshIncidentStats(incident.id, at);
      return incident.id;
    } catch (error: any) {
      console.warn(`[AlertService] incident 归并失败（不影响告警）: ${error?.message || error}`);
      return null;
    }
  }

  /** 静默窗口内只记账不投递；投递本身 fire-and-forget */
  private async deliver(kind: AlertDeliveryKind, alert: AlertRow): Promise<void> {
    if (!this.dispatcher) return;
    const muted = (await listActiveMutes(alert.ownerId, new Date())).some((m) => m.rule === alert.rule);
    if (muted) return;
    // 值班人只影响 payload 里的 onCall（接收端据此 @人），不影响发不发
    let onCall: AlertOnCallRow | null = null;
    try {
      onCall = await this.onCallAt(alert.ownerId, new Date());
    } catch (error: any) {
      console.warn(`[AlertService] 读取值班表失败（投递照旧）: ${error?.message || error}`);
    }
    this.dispatcher.enqueue(kind, alert, onCall);
  }
}
