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
 * 不提供「不带 owner 的全局查询」——管理员也没有看别人数据的口子。
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
      limit: query.limit || 100,
      offset: query.offset || 0,
    });
    return { entries, total };
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
