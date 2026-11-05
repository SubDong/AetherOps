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
  /** 服务端自识别出的系统家族：windows | macos | linux | harmony | unix | unknown */
  osFamily: string;
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
  /** 下面五项为 false 时表示这项指标在该系统上采不到，界面要显示「不可用」而不是 0 */
  cpuSupported: boolean;
  memSupported: boolean;
  diskSupported: boolean;
  swapSupported: boolean;
  netSupported: boolean;
}

export function getServerStatus(sessionId: string) {
  return request('/api/terminal/getServerStatus', { sessionId }).then(unwrap<ServerStatusSnapshot>);
}
