import { request } from '@/service/base';

/**
 * 解包 API 响应
 */
function unwrap<T = any>(res: any): T {
  if (res && typeof res === 'object' && 'ret' in res) {
    if (res.ret !== 0) throw new Error(res.msg || '请求失败');
    return res.data as T;
  }
  return res as T;
}

export interface ServerShellPasswordState {
  /** 是否已设置口令；false 时任何人都打不开「默认服务器 Shell」 */
  required: boolean;
  /** 最后修改时间（ISO 字符串），未设置时为 null */
  updatedAt: string | null;
}

/** 口令状态：仅管理员可读，管理页据此显示「已设置 / 未设置」 */
export function getServerShellState() {
  return request<ServerShellPasswordState>('/api/system/getServerShell', {}).then(unwrap);
}

/** 设置/更新口令（至少 8 位，由服务端校验） */
export function setServerShellPassword(password: string) {
  return request<boolean>('/api/system/setServerShellPassword', { password }).then(unwrap);
}

/** 清除口令：清除后该终端谁都打不开，需要重新设置 */
export function clearServerShellPassword() {
  return request<boolean>('/api/system/clearServerShellPassword', {}).then(unwrap);
}
