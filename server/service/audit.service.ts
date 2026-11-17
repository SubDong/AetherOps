import * as crypto from 'crypto';
import {
  insertAuditEvent,
  queryAuditEvents,
  listAuditRange,
  countAuditByStatus,
  listAuditDates,
  deleteAuditBefore,
  toAuditDate,
} from '../db/repositories/audit.repo';

/**
 * 审计日志条目
 */
export interface AuditEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  sessionName?: string;
  connectionId?: string;
  userMessage: string;
  tool: string;
  command: string;
  result: string;
  duration: number;
  status: 'success' | 'error' | 'blocked' | 'rewritten';
  rewrittenFrom?: string;
}

/**
 * 审计日志查询参数
 */
export interface AuditQuery {
  date?: string;       // YYYY-MM-DD
  sessionId?: string;
  keyword?: string;
  status?: string;
  /** 只看某一类工具（如 file-transfer）；管理员开成员传输记录时用 */
  tool?: string;
  /** 只看某一台主机的流水（connections.id） */
  connectionId?: string;
  limit?: number;
  offset?: number;
}

/**
 * 跨天时间窗的搜索参数（search_audit 工具用）。
 *
 * 与 AuditQuery 的区别：那个是「某一天的页面查询」，这个是「最近 N 小时」，
 * 不能互相代替 —— 排查「上周这个错怎么解的」时用户心里没有日期，只有「最近」
 * 和「那个错」。
 */
export interface AuditSearch {
  connectionId?: string;
  keyword?: string;
  status?: string;
  tool?: string;
  /** 回溯多少小时，默认 24，上限 30 天（与保留期对齐，再长必然查不到） */
  hours?: number;
  limit?: number;
  offset?: number;
}

/**
 * 审计统计
 */
export interface AuditStats {
  total: number;
  success: number;
  error: number;
  blocked: number;
  rewritten: number;
  today: number;
}

/**
 * 命令审计服务
 * 记录所有 AI Agent 执行的命令及结果，落 MySQL 的 audit_events 表。
 *
 * 改成落表后，查询不再受「一次只能读一天文件」的限制：
 * keyword / status / sessionId 现在可以做真正的跨日过滤与分页。
 *
 * 账号隔离：除 init() 的保留期清理（全局策略）外，所有方法第一个参数都是 ownerId，
 * 服务层自己不提供「不带 owner 的全局查询」。
 * 唯一的例外在路由层：管理员代管端点（/api/admin/*）先把 role 校成 admin，
 * 再把目标账号的 id 当 ownerId 传进来——换句话说「看谁的数」这个决定只能在入口做一次，
 * 不能下沉到服务层让它去猜调用方是谁。
 */
export class AuditService {
  private retentionDays: number = 30;

  /**
   * 过期清理必须等库就绪，所以从构造函数挪到这里，
   * 由 initServices() 在迁移跑完后调用。
   */
  async init(): Promise<void> {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.retentionDays);
      const removed = await deleteAuditBefore(toAuditDate(cutoff));
      if (removed > 0) {
        console.log(`[AuditService] 清理过期审计 ${removed} 条（保留 ${this.retentionDays} 天）`);
      }
    } catch (error: any) {
      console.error('[AuditService] 清理过期审计失败:', error.message);
    }
  }

  /**
   * 记录审计日志
   *
   * 调用方是 agent 的 after_tool 钩子：审计写失败不能影响命令执行结果，
   * 因此这里吞掉异常只打日志，但仍然把完整条目返回给调用方。
   */
  async log(ownerId: string, entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
    const fullEntry: AuditEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };

    try {
      await insertAuditEvent({ ...fullEntry, ownerId });
    } catch (e: any) {
      console.error('[AuditService] Failed to write audit event:', e.message);
    }

    return fullEntry;
  }

  /**
   * 查询审计日志（默认查当天）
   */
  async getLogs(ownerId: string, query: AuditQuery = {}): Promise<{ entries: AuditEntry[]; total: number }> {
    const { entries, total } = await queryAuditEvents({
      ownerId,
      date: query.date || toAuditDate(new Date()),
      sessionId: query.sessionId,
      keyword: query.keyword,
      status: query.status,
      tool: query.tool,
      connectionId: query.connectionId,
      limit: query.limit || 100,
      offset: query.offset || 0,
    });
    return { entries, total };
  }

  /**
   * 跨天时间窗搜索（AI 的 search_audit 工具走这条路）。
   *
   * toTs 多给 1 分钟：命令刚跑完就让它自己查自己，否则「刚刚那次失败」会卡在
   * 窗口边界外，模型拿到的永远是「没有记录」，很容易被解读成「没发生过」。
   */
  async search(ownerId: string, params: AuditSearch = {}): Promise<{
    entries: AuditEntry[];
    total: number;
    hours: number;
  }> {
    const hours = Math.min(Math.max(Math.round(Number(params.hours) || 24), 1), 24 * 30);
    const now = Date.now();
    const { entries, total } = await queryAuditEvents({
      ownerId,
      connectionId: params.connectionId || undefined,
      keyword: params.keyword || undefined,
      status: params.status || undefined,
      tool: params.tool || undefined,
      fromTs: now - hours * 3600_000,
      toTs: now + 60_000,
      limit: Math.min(Math.max(Math.trunc(Number(params.limit) || 10), 1), 100),
      offset: Math.max(Math.trunc(Number(params.offset) || 0), 0),
    });
    return { entries, total, hours };
  }

  /**
   * 获取多日审计日志（用于导出）
   */
  async getLogsRange(ownerId: string, startDate: string, endDate: string): Promise<AuditEntry[]> {
    return listAuditRange(ownerId, startDate, endDate);
  }

  /**
   * 导出审计日志
   */
  async exportLogs(ownerId: string, startDate: string, endDate: string, format: 'json' | 'csv' = 'json'): Promise<string> {
    const entries = await this.getLogsRange(ownerId, startDate, endDate);

    if (format === 'csv') {
      const header = 'id,timestamp,datetime,sessionId,sessionName,connectionId,userMessage,tool,command,status,duration,rewrittenFrom';
      const rows = entries.map(e => {
        const dt = new Date(e.timestamp).toISOString();
        const escape = (s: string) => `"${(s || '').replace(/"/g, '""')}"`;
        return [
          e.id, e.timestamp, dt,
          escape(e.sessionId), escape(e.sessionName || ''),
          escape(e.connectionId || ''), escape(e.userMessage),
          escape(e.tool), escape(e.command),
          e.status, e.duration, escape(e.rewrittenFrom || '')
        ].join(',');
      });
      return header + '\n' + rows.join('\n');
    }

    return JSON.stringify(entries, null, 2);
  }

  /**
   * 获取统计信息
   */
  async getStats(ownerId: string, date?: string): Promise<AuditStats> {
    const todayDate = toAuditDate(new Date());
    const targetDate = date || todayDate;
    const counts = await countAuditByStatus(ownerId, targetDate);

    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    // 「今天」和「目标日」不是同一天时才需要额外查一次
    const today = targetDate === todayDate
      ? total
      : Object.values(await countAuditByStatus(ownerId, todayDate)).reduce((sum, n) => sum + n, 0);

    return {
      total,
      success: counts.success || 0,
      error: counts.error || 0,
      blocked: counts.blocked || 0,
      rewritten: counts.rewritten || 0,
      today,
    };
  }

  /**
   * 获取可用日期列表
   */
  async getAvailableDates(ownerId: string): Promise<string[]> {
    return listAuditDates(ownerId);
  }
}
