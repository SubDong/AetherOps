/**
 * 全局系统配置仓储：sys_config 表的读写。
 *
 * 与其它 repo 的区别是这里没有 ownerId——表里存的是整台服务端共享的配置，
 * 任何按账号过滤的写法在这里都是错的。
 *
 * 只做搬运，不懂业务含义；口令的哈希与校验在 server-shell.service 里。
 */
import { execute, queryOne } from '../pool';

export interface SystemConfigRow {
  key: string;
  value: string;
  updatedAt: Date;
}

/** 读取一行；不存在返回 null（与「存在但值为空」区分开） */
export async function getConfigRow(key: string): Promise<SystemConfigRow | null> {
  const row = await queryOne<any>('SELECT k, v, updated_at FROM sys_config WHERE k = ?', [key]);
  if (!row) return null;
  return {
    key: row.k,
    value: row.v === null || row.v === undefined ? '' : String(row.v),
    updatedAt: row.updated_at,
  };
}

/**
 * 写入配置（不存在则插入）。
 * 用 ON DUPLICATE KEY UPDATE 而不是先查后写：并发保存时两条请求都判定「不存在」
 * 会撞主键，且省一次网络往返。
 */
export async function saveConfigValue(key: string, value: string): Promise<void> {
  const now = new Date();
  await execute(
    `INSERT INTO sys_config (k, v, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)`,
    [key, value, now],
  );
}

export async function deleteConfigValue(key: string): Promise<number> {
  const r = await execute('DELETE FROM sys_config WHERE k = ?', [key]);
  return r.affectedRows;
}
