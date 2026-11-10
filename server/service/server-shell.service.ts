/**
 * 「默认服务器 Shell」口令。
 *
 * 这个终端开在运行 server.js 的那台机器上，入口是整台主机的命令行，
 * 所以它不能像 SSH 连接那样「谁登录谁就能用」——默认所有人打开前都必须先过口令。
 *
 * 口令本身不分账号（sys_config 表），只有 role=admin 能改；
 * 存储走 scrypt 哈希（复用 auth.service 的实现），不落明文。
 *
 * 「没设置口令」不等于「不设防」：未设置时一律拒绝打开，
 * 提示管理员去设置。否则一个没配过的空库就等于把主机交出去。
 */
import { hashPassword, validatePassword, verifyPassword } from './auth.service';
import { deleteConfigValue, getConfigRow, saveConfigValue } from '../db/repositories/system-config.repo';

/** sys_config 里的键名 */
export const SERVER_SHELL_PASSWORD_KEY = 'server_shell_password';

/** 前端据此决定「弹口令框」还是「提示去找管理员」 */
export const SERVER_SHELL_ERROR = {
  /** 口令缺失或不正确：两者都用它，避免给出口令对错的枚举信道 */
  REQUIRED: 'server_shell_password_required',
  /** 管理员还没设置口令 */
  NOT_SET: 'server_shell_password_not_set',
} as const;

export type ServerShellPasswordVerdict = 'ok' | 'required' | 'not_set';

export interface ServerShellPasswordState {
  /** 是否已设置口令；false 时任何账号都打不开这个终端 */
  required: boolean;
  /** 最后修改时间；未设置时为 null */
  updatedAt: Date | null;
}

/** 管理页展示用：只说「有没有口令」，不返回哈希串本身 */
export async function getServerShellPasswordState(): Promise<ServerShellPasswordState> {
  const row = await getConfigRow(SERVER_SHELL_PASSWORD_KEY);
  return {
    required: !!row && row.value !== '',
    updatedAt: row?.updatedAt ?? null,
  };
}

/** 设置/更新口令（仅管理员，调用方负责校验角色） */
export async function setServerShellPassword(password: string): Promise<void> {
  // 与账号口令同一套强度要求：这条口令放行的是主机命令行
  validatePassword(password);
  await saveConfigValue(SERVER_SHELL_PASSWORD_KEY, await hashPassword(password));
}

/**
 * 清除口令。清除之后不是「免密」，而是「谁都打不开」，需要管理员重新设置。
 * 返回是否真的删掉了记录。
 */
export async function clearServerShellPassword(): Promise<boolean> {
  const removed = await deleteConfigValue(SERVER_SHELL_PASSWORD_KEY);
  return removed > 0;
}

/**
 * 校验口令。
 * - not_set：库里没有口令，调用方应拒绝并提示管理员设置；
 * - required：没带口令或口令不对（不给前端区分「空」和「错」）；
 * - ok：放行。
 */
export async function verifyServerShellPassword(input: string): Promise<ServerShellPasswordVerdict> {
  const row = await getConfigRow(SERVER_SHELL_PASSWORD_KEY);
  if (!row || row.value === '') return 'not_set';
  if (!input) return 'required';
  return (await verifyPassword(input, row.value)) ? 'ok' : 'required';
}
