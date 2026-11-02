import { request } from '@/service/base';

function unwrap<T = any>(res: any): T {
  if (res && typeof res === 'object' && 'ret' in res) {
    if (res.ret !== 0) throw new Error(res.msg || '请求失败');
    return res.data as T;
  }
  return res as T;
}

/** 与 server/service/system-status.service.ts 的快照结构保持一致 */
export interface ServerStatusSnapshot {
  at: number;
  hostname: string;
  os: string;
  cpuModel: string;
  cpuCores: number;
  cpuPercent: number;
  loadAvg: number[];
  uptimeSec: number;
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  diskTotal: number;
  diskUsed: number;
  diskMount: string;
  netIface: string;
  netRxBps: number;
  netTxBps: number;
  swapSupported: boolean;
  netSupported: boolean;
}

export function getServerStatus(sessionId: string) {
  return request('/api/terminal/getServerStatus', { sessionId }).then(unwrap<ServerStatusSnapshot>);
}
