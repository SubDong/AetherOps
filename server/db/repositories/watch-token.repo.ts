/**
 * 只读监控令牌仓储（auth_watch_tokens）。
 *
 * 只做 SQL；「能不能签、签多长、谁在用」都在 auth.service。
 * 一个细节值得单独说明：列表查询**不返回 token_hash**。
 * 哈希本身不能当令牌用，但它能把「库里有什么」和「浏览器里存的那串」对上，
 * 界面既不需要它，泄露了也只是多一条可疑线索，所以干脆不选出来。
 */
import { execute, query, queryOne } from '../pool';

export interface WatchTokenRow {
  id: number;
  ownerId: string;
  label: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface InsertWatchTokenInput {
  ownerId: string;
  label: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

const PUBLIC_COLUMNS = 'id, owner_id, label, created_at, expires_at, revoked_at, last_used_at';

function toDate(value: any): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: any): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapRow(r: any): WatchTokenRow {
  return {
    id: Number(r.id),
    ownerId: String(r.owner_id),
    label: String(r.label || ''),
    createdAt: toDate(r.created_at),
    expiresAt: toDate(r.expires_at),
    revokedAt: toDateOrNull(r.revoked_at),
    lastUsedAt: toDateOrNull(r.last_used_at),
  };
}

export async function insertWatchToken(input: InsertWatchTokenInput): Promise<number> {
  const { insertId } = await execute(
    `INSERT INTO auth_watch_tokens (owner_id, label, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [input.ownerId, input.label, input.tokenHash, input.createdAt, input.expiresAt],
  );
  return Number(insertId);
}

/**
 * 按哈希查一行，**带出 owner_id 与有效期**给鉴权用。
 * 已吊销或已过期的行也返回：由服务层给出「已吊销 / 已过期」这层语义，
 * 而不是让「查不到」和「被吊销了」混成同一个 401。
 */
export async function findWatchTokenByHash(tokenHash: string): Promise<WatchTokenRow | undefined> {
  const row = await queryOne<any>(
    `SELECT ${PUBLIC_COLUMNS} FROM auth_watch_tokens WHERE token_hash = ? LIMIT 1`,
    [tokenHash],
  );
  return row ? mapRow(row) : undefined;
}

/** 某个账号签发的全部令牌，新的在前；吊销的记录也留着，方便回答「这个是不是我撤掉的」 */
export async function listWatchTokens(ownerId: string, limit = 50): Promise<WatchTokenRow[]> {
  const rows = await query<any>(
    `SELECT ${PUBLIC_COLUMNS} FROM auth_watch_tokens
      WHERE owner_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [ownerId, Math.min(Math.max(Number(limit) || 50, 1), 200)],
  );
  return rows.map(mapRow);
}

/** 吊销：只能撤自己签的（owner_id 一起进 WHERE，管理员代撤走的是同一个函数） */
export async function revokeWatchToken(ownerId: string, id: number, at: Date): Promise<boolean> {
  const { affectedRows } = await execute(
    `UPDATE auth_watch_tokens SET revoked_at = ?
      WHERE id = ? AND owner_id = ? AND revoked_at IS NULL`,
    [at, id, ownerId],
  );
  return affectedRows > 0;
}

/** 记一次使用；调用方负责节流，这个函数本身每次都会写一行 */
export async function touchWatchToken(id: number, at: Date): Promise<void> {
  await execute(`UPDATE auth_watch_tokens SET last_used_at = ? WHERE id = ?`, [at, id]);
}

/** 清理过期且已吊销/已过期的旧记录，避免这张表只增不减（保留 7 天供追溯） */
export async function pruneWatchTokens(now: Date, keepDays = 7): Promise<number> {
  const cutoff = new Date(now.getTime() - keepDays * 24 * 3600 * 1000);
  const { affectedRows } = await execute(
    `DELETE FROM auth_watch_tokens WHERE expires_at < ? AND (revoked_at IS NOT NULL OR expires_at < ?)`,
    [cutoff, cutoff],
  );
  return affectedRows;
}
