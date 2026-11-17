import { request } from '@/service/base';

function unwrap<T = any>(res: any): T {
  if (res && typeof res === 'object' && 'ret' in res) {
    if (res.ret !== 0) throw new Error(res.msg || '请求失败');
    return res.data as T;
  }
  return res as T;
}

// ========== 告警（P5：离开页面的告警） ==========

export type AlertStatus = 'open' | 'acked' | 'resolved';
export type AlertLevel = 'warning' | 'error' | 'critical';

export interface AlertItem {
  id: number;
  ownerId: string;
  connectionId: string;
  fingerprint: string;
  status: AlertStatus;
  source: string;
  /** 规则标识：日志监控的匹配正则，静默按它生效 */
  rule: string;
  level: AlertLevel;
  message: string;
  sampleText: string;
  occurrences: number;
  /** 服务端 Date 经 JSON 变成 ISO 字符串 */
  firstSeen: string | number;
  lastSeen: string | number;
  ackedBy: string | null;
  ackedAt: string | number | null;
  resolvedAt: string | number | null;
}

export interface AlertCounts {
  open: number;
  acked: number;
  resolved: number;
}

export interface AlertListResult {
  items: AlertItem[];
  counts: AlertCounts;
}

export interface AlertMute {
  rule: string;
  until: string | number;
  createdAt: string | number;
}

export function listAlerts(params: {
  status?: AlertStatus | '';
  connectionId?: string;
  limit?: number;
  offset?: number;
} = {}) {
  return request('/api/alerts/list', params).then(unwrap<AlertListResult>);
}

export function ackAlert(id: number) {
  return request('/api/alerts/ack', { id }).then(unwrap<AlertItem>);
}

export function resolveAlert(id: number) {
  return request('/api/alerts/resolve', { id }).then(unwrap<AlertItem>);
}

export function listAlertMutes() {
  return request('/api/alerts/mutes', {}).then(unwrap<AlertMute[]>);
}

export function muteAlertRule(rule: string, minutes: number) {
  return request('/api/alerts/mute', { rule, minutes }).then(unwrap<AlertMute[]>);
}

export function unmuteAlertRule(rule: string) {
  return request('/api/alerts/unmute', { rule }).then(unwrap<AlertMute[]>);
}
