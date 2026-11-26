/**
 * 登录令牌存储：enterprise 走 Redis，lite 走 SQLite（auth_sessions 表）。
 *
 * 为什么抽这一层而不是在 auth.service 里写 if/else：
 * 令牌的语义不是「读一个值」—— 它是「签发时删掉该账号旧令牌 + 写入新令牌 + 双 key 同步」
 * 和「续期时按剩余 TTL 决定要不要重置」。这两件事在 Redis 里靠 Lua 保证原子性
 * （否则并发登录会各自以为自己是唯一会话），在 SQLite 里靠事务 + 唯一索引保证。
 * 把这段语义留在 auth.service 里分叉，等于让两套并发推理共用一段代码。
 *
 * key 的两层结构两种实现一致：
 *   token:<hash>     -> payload（会话身份快照）
 *   user:<id>:token  -> 该账号当前的令牌哈希（单账号单会话的落点）
 * SQLite 侧把两者并成一行：token_hash 主键 + user_id 唯一索引。
 */
import { getRedis, redisGet, redisKey } from './redis';
import { currentDialect } from './pool';
import { formatDateTimeUtc } from './dialect';
import { getSqlite, sqliteExecute, sqliteGet, sqliteTransactionSync } from './sqlite';

export interface TokenStore {
  /** 签发：删掉该账号的旧令牌并写入新令牌（原子） */
  issue(userId: string, tokenHash: string, payloadJson: string, ttlSeconds: number): Promise<void>;
  /** 按哈希读 payload；不存在 / 已过期返回 null */
  read(tokenHash: string): Promise<string | null>;
  /** 滑动续期：仅当剩余 TTL 低于 thresholdSeconds 时重置到 ttlSeconds；返回续期后的剩余秒数 */
  renew(tokenHash: string, userId: string, thresholdSeconds: number, ttlSeconds: number): Promise<number>;
  /** 剩余有效期（秒）；不存在返回 -2 */
  ttl(tokenHash: string): Promise<number>;
  /** 吊销：删掉该令牌；若 userIndexUserId 给出且索引仍指向它，则一并清索引 */
  remove(tokenHash: string, userId: string | null): Promise<void>;
  /** 踢下线：删掉该账号的全部令牌 */
  kick(userId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* enterprise：Redis                                                    */
/* ------------------------------------------------------------------ */

/**
 * 单点登录：写新令牌的同时删掉该账号的旧令牌。
 * 用 Lua 保证「读旧 → 删旧 → 写新」之间不会插进另一个登录请求，
 * 否则两端并发登录会各自以为自己是唯一会话。
 */
const ISSUE_SCRIPT = `
local old = redis.call('GET', KEYS[1])
if old then
  redis.call('DEL', ARGV[1] .. old)
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
return old or ''
`;

/**
 * 滑动续期：只在剩余 TTL 低于阈值时续，且与用户索引一起续。
 * 用 Lua 而不是 GET TTL + EXPIRE 两步，避免并发请求各自把 TTL 重置。
 */
const RENEW_SCRIPT = `
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  return ttl
end
if ttl < tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  if redis.call('EXISTS', KEYS[2]) == 1 then
    redis.call('EXPIRE', KEYS[2], ARGV[2])
  end
  return tonumber(ARGV[2])
end
return ttl
`;

function tokenKey(tokenHash: string): string {
  return redisKey(`token:${tokenHash}`);
}

function userTokenKey(userId: string): string {
  return redisKey(`user:${userId}:token`);
}

const redisTokenStore: TokenStore = {
  async issue(userId, tokenHash, payloadJson, ttlSeconds) {
    const client = await getRedis();
    await client.eval(ISSUE_SCRIPT, {
      keys: [userTokenKey(userId), tokenKey(tokenHash)],
      // ARGV[1] 是 token key 前缀，Lua 里用来拼旧 key
      arguments: [redisKey('token:'), tokenHash, payloadJson, String(ttlSeconds)],
    });
  },

  async read(tokenHash) {
    return redisGet(tokenKey(tokenHash));
  },

  async renew(tokenHash, userId, thresholdSeconds, ttlSeconds) {
    const client = await getRedis();
    const result = await client.eval(RENEW_SCRIPT, {
      keys: [tokenKey(tokenHash), userTokenKey(userId)],
      arguments: [String(thresholdSeconds), String(ttlSeconds)],
    });
    return Number(result);
  },

  async ttl(tokenHash) {
    const client = await getRedis();
    return client.ttl(tokenKey(tokenHash));
  },

  async remove(tokenHash, userId) {
    const client = await getRedis();
    await client.del(tokenKey(tokenHash));
    if (!userId) return;
    const indexKey = userTokenKey(userId);
    const current = await redisGet(indexKey);
    // 只有当索引还指向这个令牌时才删，避免把「重新登录后的新令牌」索引清掉
    if (current === tokenHash) await client.del(indexKey);
  },

  async kick(userId) {
    const client = await getRedis();
    const indexKey = userTokenKey(userId);
    const tokenHash = await redisGet(indexKey);
    if (tokenHash) await client.del(tokenKey(tokenHash));
    await client.del(indexKey);
  },
};

/* ------------------------------------------------------------------ */
/* lite：SQLite（auth_sessions）                                        */
/* ------------------------------------------------------------------ */

type Row = { payload?: string; expires_at?: Date | string };

function expiresAtMs(value: Date | string | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value.replace(' ', 'T') + 'Z');
  return NaN;
}

const sqliteTokenStore: TokenStore = {
  async issue(userId, tokenHash, payloadJson, ttlSeconds) {
    const now = Date.now();
    const issuedAt = formatDateTimeUtc(new Date(now));
    const expiresAt = formatDateTimeUtc(new Date(now + ttlSeconds * 1000));
    // 同步事务：「删旧 + 清过期 + 写新」之间不 await，别的请求插不进来。
    // 唯一索引 uk_auth_sessions_user 是最后一道保险 —— 真并发时后到的那条会报冲突，
    // 而不是让同一账号短暂持有两枚令牌。
    sqliteTransactionSync(() => {
      const db = getSqlite();
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ? OR expires_at <= ?').run(userId, issuedAt);
      db.prepare(
        'INSERT INTO auth_sessions (token_hash, user_id, payload, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).run(tokenHash, userId, payloadJson, issuedAt, expiresAt);
    });
  },

  async read(tokenHash) {
    const row = await sqliteGet<Row>('SELECT payload, expires_at FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
    if (!row || typeof row.payload !== 'string') return null;
    const expires = expiresAtMs(row.expires_at);
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      // 过期行顺手删掉：这张表不该靠定时任务才收敛
      await sqliteExecute('DELETE FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
      return null;
    }
    return row.payload;
  },

  async renew(tokenHash, _userId, thresholdSeconds, ttlSeconds) {
    const row = await sqliteGet<Row>('SELECT expires_at FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
    if (!row) return -2;
    const expires = expiresAtMs(row.expires_at);
    if (!Number.isFinite(expires)) return -2;
    const remaining = Math.max(0, Math.floor((expires - Date.now()) / 1000));
    if (remaining >= thresholdSeconds) return remaining;
    const now = Date.now();
    await sqliteExecute('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?', [
      formatDateTimeUtc(new Date(now + ttlSeconds * 1000)),
      tokenHash,
    ]);
    return ttlSeconds;
  },

  async ttl(tokenHash) {
    const row = await sqliteGet<Row>('SELECT expires_at FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
    if (!row) return -2;
    const expires = expiresAtMs(row.expires_at);
    if (!Number.isFinite(expires)) return -2;
    const remaining = Math.floor((expires - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  },

  async remove(tokenHash) {
    // 一行同时是 payload 与「该账号的当前令牌」索引，删掉即可
    await sqliteExecute('DELETE FROM auth_sessions WHERE token_hash = ?', [tokenHash]);
  },

  async kick(userId) {
    await sqliteExecute('DELETE FROM auth_sessions WHERE user_id = ?', [userId]);
  },
};

/** 按当前存储后端取实现；每次调用都重新判断，dev 改配置后无需重启进程 */
export function getTokenStore(): TokenStore {
  return currentDialect() === 'sqlite' ? sqliteTokenStore : redisTokenStore;
}
