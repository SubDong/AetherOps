/**
 * 告警投递器（P5）：把「新建」与「级别升级」推到配置里的 webhook。
 *
 * 三条硬约束（都是「告警系统常见的坑」，不是风格问题）：
 * 1. **不阻塞主流程**：投递由 ingest 之后 fire-and-forget 触发，接收端挂了也不会让
 *    日志监控卡住、更不会让一条告警写不进去；
 * 2. **去抖**：同一指纹 5 分钟内只推一次。日志刷屏时每次都推，等于把接收端打挂，
 *    而人真正需要的是「又出现了，一共 87 次」而不是 87 条消息；
 * 3. **签名 + 时间戳**：`sha256=<hmac(secret, "<ts>.<body>")>`。只签 body 的话，
 *    抓到一条旧请求可以无限重放；把时间戳签进去，接收端即可拒绝过期请求。
 *
 * 重试口径：30 s / 2 m / 10 m，共 3 次（加上首次一共 4 次尝试）。不做无限重试，
 * 也不把失败的投递落库排重试队列 —— P5 的验收是「不阻塞 + 次数与退避符合预期」，
 * 引入队列就要处理幂等与积压，属于下一阶段的事。
 */
import * as crypto from 'crypto';
import type { AlertsConfig } from '../utils/config';
import type { AlertRow } from '../db/repositories/alert.repo';

export type AlertDeliveryKind = 'created' | 'escalated';

export interface AlertWebhookPayload {
  event: 'alert.created' | 'alert.escalated';
  deliveredAt: string;
  ownerId: string;
  alert: {
    id: number;
    connectionId: string;
    fingerprint: string;
    source: string;
    rule: string;
    level: string;
    message: string;
    sampleText: string;
    occurrences: number;
    status: string;
    firstSeen: string;
    lastSeen: string;
  };
}

export interface DispatchResult {
  /** 接收端返回 2xx */
  delivered: boolean;
  /** 没配置 webhook / 被去抖窗口拦下 */
  skipped: boolean;
  /** 实际发出的请求次数 */
  attempts: number;
  error?: string;
}

export interface AlertDispatcherOptions {
  getConfig: () => AlertsConfig;
  /** 便于验证脚本注入；默认全局 fetch */
  fetchImpl?: typeof fetch;
  debounceMs?: number;
  /** 首次失败后的重试间隔；长度 = 重试次数 */
  retryDelaysMs?: number[];
  now?: () => number;
  log?: (message: string) => void;
}

/** 与 roadmap 一致：30 s / 2 m / 10 m */
export const DEFAULT_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

/** 同一指纹的投递去抖窗口 */
export const DEFAULT_DEBOUNCE_MS = 5 * 60_000;

export function buildPayload(kind: AlertDeliveryKind, alert: AlertRow, now = new Date()): AlertWebhookPayload {
  return {
    event: kind === 'escalated' ? 'alert.escalated' : 'alert.created',
    deliveredAt: now.toISOString(),
    ownerId: alert.ownerId,
    alert: {
      id: alert.id,
      connectionId: alert.connectionId,
      fingerprint: alert.fingerprint,
      source: alert.source,
      rule: alert.rule,
      level: alert.level,
      message: alert.message,
      sampleText: alert.sampleText,
      occurrences: alert.occurrences,
      status: alert.status,
      firstSeen: alert.firstSeen.toISOString(),
      lastSeen: alert.lastSeen.toISOString(),
    },
  };
}

export class AlertDispatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly debounceMs: number;
  private readonly retryDelaysMs: number[];
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** dedup key → 上次投递时间 */
  private readonly sentAt = new Map<string, number>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly options: AlertDispatcherOptions) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** 投递入口：调用方不需要 await，也不需要处理异常 */
  enqueue(kind: AlertDeliveryKind, alert: AlertRow): void {
    void this.dispatch(kind, alert).catch((error: any) => {
      this.log(`[AlertDispatcher] 投递异常（已忽略）: ${error?.message || error}`);
    });
  }

  /**
   * 真正发一次（含重试）。返回结果供验证脚本断言；
   * 生产路径只走 enqueue，不关心返回值。
   */
  async dispatch(kind: AlertDeliveryKind, alert: AlertRow): Promise<DispatchResult> {
    const config = this.options.getConfig();
    const url = (config.webhookUrl || '').trim();
    if (!url) return { delivered: false, skipped: true, attempts: 0 };

    const key = `${alert.ownerId}|${alert.connectionId}|${alert.fingerprint}`;
    const stamp = this.now();
    const last = this.sentAt.get(key);
    if (last !== undefined && stamp - last < this.debounceMs) {
      return { delivered: false, skipped: true, attempts: 0 };
    }
    this.sentAt.set(key, stamp);
    this.pruneSent(stamp);

    const body = JSON.stringify(buildPayload(kind, alert, new Date(stamp)));
    const headers = this.buildHeaders(kind, body, Math.floor(stamp / 1000), (config.webhookSecret || '').trim());

    let attempts = 0;
    let lastError = '';
    for (let i = 0; i <= this.retryDelaysMs.length; i++) {
      if (i > 0) await this.sleep(this.retryDelaysMs[i - 1]);
      attempts += 1;
      try {
        const response = await this.post(url, body, headers, Math.max(1000, config.webhookTimeoutMs || 5000));
        if (response.ok) return { delivered: true, skipped: false, attempts };
        lastError = `HTTP ${response.status}`;
      } catch (error: any) {
        lastError = error?.name === 'AbortError' ? '请求超时' : (error?.message || String(error));
      }
    }
    this.log(`[AlertDispatcher] webhook 投递失败（尝试 ${attempts} 次）: ${lastError}`);
    return { delivered: false, skipped: false, attempts, error: lastError };
  }

  /** 停掉仍在等待的重试（宿主退出 / 测试收尾用） */
  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private buildHeaders(kind: AlertDeliveryKind, body: string, timestamp: number, secret: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'AetherOps-AlertDispatcher/1.0',
      'x-aetherops-event': kind === 'escalated' ? 'alert.escalated' : 'alert.created',
      'x-aetherops-timestamp': String(timestamp),
    };
    if (secret) {
      headers['x-aetherops-signature'] = `sha256=${crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${body}`, 'utf8')
        .digest('hex')}`;
    }
    return headers;
  }

  private async post(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    this.timers.add(timer);
    timer.unref?.();
    try {
      return await this.fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
      // 不让 10 分钟的重试把宿主进程钉住（Electron / VSCode 退出要能干净）
      timer.unref?.();
    });
  }

  /** 去抖表只保留窗口内的 key，避免长期运行时无限增长 */
  private pruneSent(stamp: number): void {
    if (this.sentAt.size < 500) return;
    for (const [key, at] of this.sentAt) {
      if (stamp - at >= this.debounceMs) this.sentAt.delete(key);
    }
  }
}
