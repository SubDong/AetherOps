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
  countAlerts,
  deleteMute,
  findOpenAlert,
  getAlertById,
  insertAlert,
  listActiveMutes,
  listAlerts,
  pruneExpiredMutes,
  pruneResolvedAlerts,
  resolveAlert,
  touchAlert,
  upsertMute,
} from '../db/repositories/alert.repo';
import type { AlertLevel, AlertListFilter, AlertMuteRow, AlertRow } from '../db/repositories/alert.repo';
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
        return { action: 'created', alert: created };
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
    items: AlertRow[];
    counts: { open: number; acked: number; resolved: number };
  }> {
    const [items, counts] = await Promise.all([listAlerts(ownerId, filter), countAlerts(ownerId)]);
    return { items, counts };
  }

  /** 确认：只有 open 能确认；返回 null 表示状态已经变了（重复点按 / 已解决） */
  async ack(ownerId: string, id: number, userId: string): Promise<AlertRow | null> {
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid alert id');
    const ok = await ackAlert(ownerId, id, userId, new Date());
    if (!ok) return null;
    return (await getAlertById(ownerId, id)) || null;
  }

  async resolve(ownerId: string, id: number): Promise<AlertRow | null> {
    if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid alert id');
    const ok = await resolveAlert(ownerId, id, new Date());
    if (!ok) return null;
    return (await getAlertById(ownerId, id)) || null;
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
    return pruneResolvedAlerts(cutoff);
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

  /** 静默窗口内只记账不投递；投递本身 fire-and-forget */
  private async deliver(kind: AlertDeliveryKind, alert: AlertRow): Promise<void> {
    if (!this.dispatcher) return;
    const muted = (await listActiveMutes(alert.ownerId, new Date())).some((m) => m.rule === alert.rule);
    if (muted) return;
    this.dispatcher.enqueue(kind, alert);
  }
}
