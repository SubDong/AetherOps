/**
 * 只读监控令牌（watch token）与大屏只读视图。
 *
 * 这个文件里有两套完全不同的调用方式，别混着用：
 *
 *  1. 签发 / 列出 / 吊销 —— 在**已登录**的界面里操作，走 `request`，
 *     与其他 service 一样带 Authorization、401 时按登录态处理。
 *  2. 大屏拉数据 —— 大屏**没有登录态**，手里只有一串 aow_ 令牌。这里不走
 *     `request`：那条链路遇到 401 会把页面跳去登录页，而大屏需要的是
 *     「令牌失效」这行字停在原地等人来换令牌。
 */
import config from '@/base/config';
import { getRequestUrl, request } from '@/service/base';

/* ------------------------------------------------------------------ */
/* 账号侧：管理自己签出的令牌                                            */
/* ------------------------------------------------------------------ */

export type WatchTokenState = 'active' | 'revoked' | 'expired';

export interface WatchTokenBrief {
  id: number;
  label: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** 服务端算好的状态，前端不再自己比时间 */
  state: WatchTokenState;
}

export interface IssuedWatchToken {
  /** 明文只在这一次响应里出现，之后库里只有哈希 */
  token: string;
  brief: WatchTokenBrief;
}

function unwrap<T = any>(res: any): T {
  if (res && typeof res === 'object' && 'ret' in res) {
    if (res.ret !== 0) throw new Error(res.msg || '请求失败');
    return res.data as T;
  }
  return res as T;
}

/** 只能看到自己签出的；吊销的记录也留在列表里，方便回答「这枚是不是我撤掉的」 */
export function listWatchTokens(): Promise<WatchTokenBrief[]> {
  return request('/api/auth/listWatchTokens', {}).then(unwrap<WatchTokenBrief[]>);
}

export function createWatchToken(label: string): Promise<IssuedWatchToken> {
  return request('/api/auth/createWatchToken', { label }).then(unwrap<IssuedWatchToken>);
}

export function revokeWatchToken(id: number): Promise<boolean> {
  return request('/api/auth/revokeWatchToken', { id }).then(unwrap<boolean>);
}

/** 大屏地址：令牌放进 URL 片段，首次打开后会被存进本地并清掉 */
export function watchScreenPath(token?: string): string {
  const base = `${config.prefix || ''}/watch`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/* ------------------------------------------------------------------ */
/* 大屏侧：令牌自身的存取                                                */
/* ------------------------------------------------------------------ */

/**
 * 与登录态分开存。
 *
 * 同一台机器可能是「值班员自己登录着 + 浏览器另开一个窗口当大屏」，
 * 共用 aetherops.auth.v1 会互相覆盖登录态。
 */
const WATCH_STORAGE_KEY = 'aetherops.watch.v1';

export function getWatchToken(): string {
  try {
    return window.localStorage.getItem(WATCH_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setWatchToken(token: string): void {
  try {
    window.localStorage.setItem(WATCH_STORAGE_KEY, token);
  } catch {
    /* 隐私模式：本次打开还能用，刷新后要重新贴令牌 */
  }
}

export function clearWatchToken(): void {
  try {
    window.localStorage.removeItem(WATCH_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 大屏侧：只读数据                                                      */
/* ------------------------------------------------------------------ */

export interface WatchAlert {
  id: number;
  connectionId: string;
  status: 'open' | 'acked' | 'resolved';
  source: 'log' | 'command';
  rule: string;
  level: 'warning' | 'error' | 'critical';
  message: string;
  occurrences: number;
  lastSeen: string;
  assigneeName?: string | null;
}

export interface WatchIncident {
  id: number;
  connectionId: string;
  title: string;
  status: 'open' | 'resolved';
  alertCount: number;
  startedAt: string;
  lastSeenAt: string;
}

export interface WatchMetricPoint {
  at: number;
  cpuAvg: number | null;
  memAvg: number | null;
  diskAvg: number | null;
  load1: number | null;
  samples: number;
}

export interface WatchHost {
  connectionId: string;
  hostname: string;
  lastAt: number;
  samples: number;
  latest: WatchMetricPoint | null;
}

export interface WatchConnection {
  id: string;
  name: string;
  type: 'ssh' | 'local';
  host: string;
  port: number;
  username: string;
  enabled: boolean;
  sampling: string;
}

export interface WatchOverview {
  generatedAt: number;
  viewer: { userId: string; username: string };
  alerts: { counts: { open: number; acked: number; resolved: number }; items: WatchAlert[] };
  incidents: WatchIncident[];
  hosts: WatchHost[];
  /**
   * 采集口径。
   *
   * `offlineSampling` 为 false 时只有开着终端会话的主机才被采样，
   * 其余主机在大屏上必然是灰的、读数全是 `-`——大屏要靠它把这件事说出来，
   * 而不是让人对着一片灰卡片猜是采集挂了还是自己配错了。
   *
   * 可选：老服务端（本字段上线前的构建）不会返回它，按 `undefined` 处理。
   */
  sampling?: { offlineSampling: boolean };
  connections: WatchConnection[];
}

/** 大屏自己的错误：区分「令牌不行」与「服务端出错」，前者要提示换令牌 */
export class WatchTokenError extends Error {}

export async function fetchWatchOverview(token: string, limit = 50): Promise<WatchOverview> {
  const resp = await fetch(getRequestUrl('/api/watch/overview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ limit }),
  });

  let payload: any = null;
  try {
    payload = await resp.json();
  } catch {
    payload = null;
  }

  if (resp.status === 401) throw new WatchTokenError('unauthorized');
  if (resp.status === 403) throw new WatchTokenError('forbidden');
  if (resp.status !== 200) {
    throw new Error(payload?.msg || `HTTP ${resp.status}`);
  }
  return unwrap<WatchOverview>(payload);
}
