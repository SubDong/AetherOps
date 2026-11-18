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
  /** 处理人账号 ID（P6）；null = 未指派 */
  assigneeId?: string | null;
  /** 服务端把账号 ID 换成了显示名；查不到账号时退化成 ID */
  assigneeName?: string | null;
  ackedByName?: string | null;
  /** 归并到的 incident（P6）；null/缺省 = 尚未归并 */
  incidentId?: number | null;
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

// ========== 告警协同（P6：认领 / 指派 / 值班 / 事件） ==========

/** 可以被指派的成员：只含 active 账号 */
export interface AlertMember {
  id: string;
  username: string;
  displayName: string;
}

/** 值班时间窗：分钟数是「当天 0 点起」，start > end 表示跨零点 */
export interface AlertOnCallWindow {
  userId: string;
  username: string;
  displayName: string;
  startMinute: number;
  endMinute: number;
}

export type IncidentStatus = 'open' | 'resolved';

export interface AlertIncident {
  id: number;
  connectionId: string;
  title: string;
  status: IncidentStatus;
  alertCount: number;
  startedAt: string | number;
  lastSeenAt: string | number;
  resolvedAt: string | number | null;
}

/** 认领 = 确认 + 指派给自己；已解决的告警会报错（409），前端刷新即可 */
export function claimAlert(id: number) {
  return request('/api/alerts/claim', { id }).then(unwrap<AlertItem>);
}

/** assigneeId 传空字符串 = 取消指派 */
export function assignAlert(id: number, assigneeId: string) {
  return request('/api/alerts/assign', { id, assigneeId }).then(unwrap<AlertItem>);
}

export function listAlertMembers() {
  return request('/api/alerts/members', {}).then(unwrap<AlertMember[]>);
}

export function listAlertOnCall() {
  return request('/api/alerts/oncall', {}).then(unwrap<AlertOnCallWindow[]>);
}

export function setAlertOnCall(userId: string, startMinute: number, endMinute: number) {
  return request('/api/alerts/setOncall', { userId, startMinute, endMinute }).then(unwrap<AlertOnCallWindow[]>);
}

export function clearAlertOnCall(userId: string, startMinute: number) {
  return request('/api/alerts/clearOncall', { userId, startMinute }).then(unwrap<AlertOnCallWindow[]>);
}

export function listAlertIncidents(status: IncidentStatus | '' = '') {
  return request('/api/alerts/incidents', { status }).then(unwrap<AlertIncident[]>);
}

/** 人工归并：没有活跃事件就新建一个，窗口内其他未归并告警一并带入 */
export function attachAlertIncident(id: number) {
  return request('/api/alerts/attachIncident', { id }).then(unwrap<{ incidentId: number; created: boolean }>);
}
