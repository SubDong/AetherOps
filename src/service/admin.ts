/**
 * 管理员代管接口。
 *
 * 与普通 service 的区别：这里的每个调用都必须显式带上目标账号 userId，
 * 服务端 /api/admin/* 会先校 role=admin 再把 userId 当 ownerId 用；
 * 少传一个 userId 服务端直接 400，不会退化成「看自己」。
 */
import { request } from '@/service/base';
import type { ConnectionEntity } from '@/typings/connection';
import type { AuditEntry } from '@/service/audit';

function unwrap<T = any>(res: any): T {
  if (res && typeof res === 'object' && 'ret' in res) {
    if (res.ret !== 0) throw new Error(res.msg || '请求失败');
    return res.data as T;
  }
  return res as T;
}

export interface MemberAuditQuery {
  userId: string;
  date?: string;
  sessionId?: string;
  keyword?: string;
  status?: string;
  /** 传输记录走 tool=file-transfer 过滤，普通审计不传 */
  tool?: string;
  limit?: number;
  offset?: number;
}

export interface MemberAuditResult {
  entries: AuditEntry[];
  total: number;
}

/** 代管视图里的连接：服务端已剥掉口令/私钥/passphrase，只留主机定位信息 */
export type MemberConnection = Partial<ConnectionEntity> & { id: string; name: string; hasSecret?: boolean };

export interface MemberSession {
  sessionId: string;
  connectionId: string;
  type: 'ssh' | 'local';
  name: string;
  createdAt: string | Date;
}

export interface MemberSessionsResult {
  sessions: MemberSession[];
  /** 该账号当前还挂着的终端 WebSocket 条数 */
  sockets: number;
}

export interface DisconnectResult {
  closedSessions: number;
  closedSockets: number;
}

export function getMemberAudit(query: MemberAuditQuery) {
  return request('/api/admin/memberAudit', query).then(unwrap<MemberAuditResult>);
}

export function getMemberAuditDates(userId: string) {
  return request('/api/admin/memberAuditDates', { userId }).then(unwrap<string[]>);
}

/** 只看文件传输记录（上传/下载的方向、路径、字节数、成败） */
export function getMemberTransfers(query: MemberAuditQuery) {
  return request('/api/admin/memberTransfers', query).then(unwrap<MemberAuditResult>);
}

export function getMemberConnections(userId: string) {
  return request('/api/admin/memberConnections', { userId }).then(unwrap<MemberConnection[]>);
}

export function deleteMemberConnection(userId: string, id: string) {
  return request('/api/admin/deleteMemberConnection', { userId, id }).then(unwrap<boolean>);
}

export function getMemberSessions(userId: string) {
  return request('/api/admin/memberSessions', { userId }).then(unwrap<MemberSessionsResult>);
}

/** 紧急断开：会话进程 + tab 记录 + WebSocket + 登录令牌一起收 */
export function disconnectUser(userId: string) {
  return request('/api/admin/disconnectUser', { userId }).then(unwrap<DisconnectResult>);
}
