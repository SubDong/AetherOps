import * as crypto from 'crypto';
import { promisify } from 'util';
import { getTokenStore } from '../db/token-store';
import {
  findUserById,
  findUserByUsername,
  insertUser,
  listUsers,
  countUsers,
  countActiveAdmins,
  updateUser,
  deleteUserRow,
  purgeOwnerData,
  touchLogin,
  type UserUpdate,
} from '../db/repositories/user.repo';
import {
  findWatchTokenByHash,
  insertWatchToken,
  listWatchTokens,
  pruneWatchTokens,
  revokeWatchToken as revokeWatchTokenRow,
  touchWatchToken,
  type WatchTokenRow,
} from '../db/repositories/watch-token.repo';
import { loadConfig } from '../utils/config';
import {
  emptyPermissions,
  fullPermissions,
  toPublicUser,
  type PermissionKey,
  type PublicUser,
  type UserPermissions,
  type UserRecord,
  type UserRole,
  type UserStatus,
} from '../model/user.entity';

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

/**
 * 登录令牌有效期（秒）。默认 7200，部署方可通过 auth.tokenTtlSeconds 调整：
 * 2 小时对普通用户在够用与「公用电脑不该永久登录」之间取中，
 * 而长时间挂着的大屏应该用只读监控令牌，而不是把这个值调到一周。
 */
export function tokenTtlSeconds(): number {
  const configured = Number(loadConfig().auth?.tokenTtlSeconds);
  return Number.isFinite(configured) && configured >= 60 ? Math.floor(configured) : 7200;
}

/**
 * 续期阈值：剩余不足这么多秒才续到满。
 *
 * 取 TTL 的四分之一（下限 30 秒、上限 1000 秒）：TTL 很短的部署也能被轮询续上，
 * TTL 很长的部署不会变成「每个请求都写一次 Redis」。
 */
export function tokenRenewThresholdSeconds(): number {
  return Math.max(30, Math.min(1000, Math.floor(tokenTtlSeconds() / 4)));
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
/** 128*N*r ≈ 16.8MB，留足余量避免 node 默认 32MB maxmem 边界 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** OAuth2 风格错误：code 直接进响应体，status 决定 HTTP 码 */
export class AuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface IssuedToken {
  accessToken: string;
  expiresIn: number;
  user: PublicUser;
}

/** 令牌存储里的东西；刻意不含令牌明文，只有哈希能对上 */
export interface TokenPayload {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  permissions: UserPermissions;
  issuedAt: number;
  loginIp: string;
  /**
   * 令牌类型。缺省 = 会话令牌（旧格式的 payload 里没有这个字段，按会话处理）。
   * `watch` 是只读监控令牌：只能访问 /api/watch/*，且不占「单账号单会话」名额。
   */
  kind?: 'session' | 'watch';
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ------------------------------------------------------------------ */
/* 口令哈希：scrypt                                                        */
/* ------------------------------------------------------------------ */

/**
 * 格式：scrypt$N$r$p$salt(base64)$hash(base64)
 * 参数写进串里，将来调高强度时旧口令仍能验证（按串里的参数算）。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = (stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * 用户不存在时也跑一次同等强度的哈希，避免「响应快 = 用户不存在」的枚举信道。
 * 值是随机的，永远不会匹配。
 */
const DUMMY_HASH = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${crypto.randomBytes(16).toString('base64')}$${crypto.randomBytes(SCRYPT_KEYLEN).toString('base64')}`;

/* ------------------------------------------------------------------ */
/* 令牌：签发 / 校验 / 续期 / 踢下线                                        */
/* ------------------------------------------------------------------ */

// 签发/续期/吊销的具体存储动作都在 db/token-store.ts 里：
// enterprise 走 Redis 的 Lua（原子），lite 走 SQLite 事务 + 唯一索引。
// 这里只表达「单账号单会话 + 滑动续期」的业务语义，不关心落到哪个后端。

async function issueToken(user: UserRecord, loginIp: string): Promise<string> {
  const token = `ao_${crypto.randomBytes(32).toString('base64url')}`;
  const tokenHash = hashToken(token);
  const payload: TokenPayload = {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    permissions: user.permissions,
    issuedAt: Date.now(),
    loginIp,
    kind: 'session',
  };
  // 「删旧 + 写新」是一次原子操作：并发登录时后到的那次会把先到的踢掉，
  // 而不是两边都以为自己拿到了唯一会话。
  await getTokenStore().issue(user.id, tokenHash, JSON.stringify(payload), tokenTtlSeconds());
  return token;
}

/** 调用方需要显式声明「这个路径允许只读令牌」，默认不允许 —— 漏配的后果是 401，而不是放行 */
export interface AuthenticateOptions {
  /**
   * 允许 `aow_` 开头的只读监控令牌。
   * 只有 `/api/watch/*` 这类纯读路径应该传 true；WebSocket 永远不要传：
   * 大屏令牌能开终端，等于把「只读」两个字作废。
   */
  allowWatch?: boolean;
}

/**
 * 校验令牌并滑动续期。
 * 返回 null 表示令牌无效；调用方据此回 401。
 */
export async function authenticate(token: string, options: AuthenticateOptions = {}): Promise<TokenPayload | null> {
  if (!token) return null;
  // 前缀分流，不靠「令牌存储没找到就去查库」：只读令牌走库，会话令牌走令牌存储，
  // 两条路径互不干扰，也不会因为一个前缀猜错而多一次全表查询。
  if (token.startsWith(WATCH_TOKEN_PREFIX)) {
    if (!options.allowWatch) return null;
    return authenticateWatchToken(token);
  }
  const tokenHash = hashToken(token);
  const store = getTokenStore();
  const raw = await store.read(tokenHash);
  if (!raw) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // 存储里的东西解析不了，说明这行已经没用了，顺手清掉避免每次请求都白跑一次
    await store.remove(tokenHash, null);
    return null;
  }

  // TTL 低于阈值则续到满；不吞异常，失败就让上层 500——
  // 续期都失败的存储不该被当成「鉴权通过」继续放行。
  await store.renew(tokenHash, payload.userId, tokenRenewThresholdSeconds(), tokenTtlSeconds());

  return payload;
}

/** 只读当前剩余有效期，供调试/前端展示用 */
export async function tokenTtl(token: string): Promise<number> {
  return getTokenStore().ttl(hashToken(token));
}

/**
 * 吊销：删掉这枚令牌。
 *
 * 先读出 payload 取 userId —— 只有 Redis 实现需要它来清「账号当前令牌」那枚索引 key，
 * 且只在索引仍指向本令牌时才删，避免把「重新登录后的新令牌」索引清掉。
 */
export async function revokeToken(token: string): Promise<void> {
  if (!token) return;
  const store = getTokenStore();
  const tokenHash = hashToken(token);
  const payloadRaw = await store.read(tokenHash);
  let userId = '';
  if (payloadRaw) {
    try { userId = JSON.parse(payloadRaw).userId || ''; } catch { /* ignore */ }
  }
  await store.remove(tokenHash, userId || null);
}

/** 强制下线：禁用账号、改权限、重置密码、删号时调用 */
export async function kickUser(userId: string): Promise<void> {
  await getTokenStore().kick(userId);
}

/* ------------------------------------------------------------------ */
/* 只读监控令牌（watch token）                                              */
/* ------------------------------------------------------------------ */

/**
 * 只读令牌前缀。
 *
 * 有了它，鉴权一次 startsWith 就能分流，不必拿同一串去 Redis 和 MySQL 各查一遍；
 * 日志里看到 aow_ 也知道这是大屏令牌，而不是谁的登录会话。
 */
export const WATCH_TOKEN_PREFIX = 'aow_';

/** last_used_at 的内存节流：大屏 60 秒一轮询，不该变成 60 秒一次 UPDATE */
const watchTouchAt = new Map<number, number>();
const WATCH_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface WatchTokenBrief {
  id: number;
  label: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** 派生状态，省得每个调用方自己比时间 */
  state: 'active' | 'revoked' | 'expired';
}

function toWatchBrief(row: WatchTokenRow, now = Date.now()): WatchTokenBrief {
  const state: WatchTokenBrief['state'] = row.revokedAt
    ? 'revoked'
    : row.expiresAt.getTime() <= now
      ? 'expired'
      : 'active';
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    state,
  };
}

/**
 * 签发一枚只读令牌。
 *
 * 不碰 Redis 的「一账号一枚」索引 —— 那是登录会话的单点约束；
 * 大屏令牌可以有任意多枚，每枚独立吊销，所以两边完全分开。
 */
export async function issueWatchToken(
  ownerId: string,
  label: string,
  now = new Date(),
): Promise<{ token: string; brief: WatchTokenBrief }> {
  const configured = Number(loadConfig().auth?.watchTokenTtlSeconds);
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new AuthError('watch_token_disabled', '只读监控令牌已被禁用（auth.watchTokenTtlSeconds 为 0）', 403);
  }
  const cleanLabel = String(label || '').trim().slice(0, 64) || '大屏';
  const token = `${WATCH_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now.getTime() + Math.floor(configured) * 1000);
  const id = await insertWatchToken({
    ownerId,
    label: cleanLabel,
    tokenHash: hashToken(token),
    createdAt: now,
    expiresAt,
  });
  // 签发是唯一会让这张表变长的动作，也就顺理成章是清理的节流点：
  // 只删「过期已超 7 天」的行，最近吊销的记录留在界面上供人核对。
  pruneWatchTokens(now).catch(() => { /* 清理失败不影响签发 */ });
  return {
    token,
    brief: toWatchBrief({ id, ownerId, label: cleanLabel, createdAt: now, expiresAt, revokedAt: null, lastUsedAt: null }, now.getTime()),
  };
}

export async function listWatchTokenBriefs(ownerId: string): Promise<WatchTokenBrief[]> {
  const rows = await listWatchTokens(ownerId);
  return rows.map((row) => toWatchBrief(row));
}

export async function revokeWatchToken(ownerId: string, id: number): Promise<boolean> {
  return revokeWatchTokenRow(ownerId, id, new Date());
}

/**
 * 只读令牌的鉴权。
 *
 * 与登录会话三个不同：不写 Redis（没有需要按 TTL 对账的 payload）、**不续期**
 * （到期时间是签发时定死的绝对时刻，续期就等于永不失效）、每次去库里对一行 ——
 * 因为「能不能用」的真相在那一行上，吊销必须立刻生效，不能等某个缓存过期。
 */
export async function authenticateWatchToken(token: string): Promise<TokenPayload | null> {
  if (!token.startsWith(WATCH_TOKEN_PREFIX)) return null;
  const row = await findWatchTokenByHash(hashToken(token));
  if (!row) return null;

  const now = Date.now();
  if (row.revokedAt || row.expiresAt.getTime() <= now) return null;

  // 账号本身也得是活的：停用/删号之后，墙上那块大屏不该继续读数据
  const user = await findUserById(row.ownerId);
  if (!user || user.status !== 'active') return null;
  // 令牌本身只读，但仍要求账号有 monitor 位 —— 收回权限就等于收回大屏
  if (!user.permissions?.monitor) return null;

  const last = watchTouchAt.get(row.id) || 0;
  if (now - last >= WATCH_TOUCH_INTERVAL_MS) {
    watchTouchAt.set(row.id, now);
    // 只是审计字段，写失败不该影响鉴权
    touchWatchToken(row.id, new Date(now)).catch(() => { /* ignore */ });
  }

  const permissions = emptyPermissions();
  permissions.monitor = true;

  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    permissions,
    issuedAt: row.createdAt.getTime(),
    loginIp: '',
    kind: 'watch',
  };
}

/* ------------------------------------------------------------------ */
/* 注册 / 登录 / 改密                                                     */
/* ------------------------------------------------------------------ */

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

export function validateUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new AuthError('invalid_request', '用户名只能包含字母、数字、下划线、点、连字符，长度 3~32');
  }
}

export function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError('invalid_request', `密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  if (password.length > 128) {
    throw new AuthError('invalid_request', '密码过长');
  }
}

function randomPassword(length = 16): string {
  // 去掉容易看错的 0/O/1/l/I
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 自助注册：落库即 pending + 权限全关，等管理员授权后才能用任何功能 */
export async function register(username: string, password: string, displayName?: string): Promise<PublicUser> {
  const name = String(username || '').trim();
  validateUsername(name);
  validatePassword(password);

  if (await findUserByUsername(name)) {
    throw new AuthError('username_taken', '用户名已被占用', 409);
  }

  const now = new Date();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username: name,
    displayName: (displayName || name).slice(0, 64),
    passwordHash: await hashPassword(password),
    role: 'user',
    status: 'pending',
    permissions: emptyPermissions(),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    lastLoginIp: '',
  };
  await insertUser(user);
  console.log(`[Auth] 新用户注册: ${user.username}（待管理员授权）`);
  return toPublicUser(user);
}

/**
 * 密码模式登录（OAuth2 grant_type=password）。
 * pending 账号允许登录——登录后才能看到「等待授权」的界面；
 * disabled 直接拒绝。
 */
export async function login(username: string, password: string, loginIp: string): Promise<IssuedToken> {
  const name = String(username || '').trim();
  const user = name ? await findUserByUsername(name) : null;

  if (!user) {
    await verifyPassword(password || '', DUMMY_HASH);
    throw new AuthError('invalid_grant', '用户名或密码错误', 401);
  }
  const ok = await verifyPassword(password || '', user.passwordHash);
  if (!ok) {
    throw new AuthError('invalid_grant', '用户名或密码错误', 401);
  }
  if (user.status === 'disabled') {
    throw new AuthError('invalid_grant', '账号已被禁用，请联系管理员', 403);
  }

  const accessToken = await issueToken(user, loginIp);
  await touchLogin(user.id, loginIp);

  return {
    accessToken,
    expiresIn: tokenTtlSeconds(),
    user: toPublicUser({ ...user, lastLoginAt: new Date(), lastLoginIp: loginIp }),
  };
}

/** 自己改密码；改完踢掉自己（强制重新登录） */
export async function changeOwnPassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw new AuthError('invalid_grant', '账号不存在', 404);
  if (!(await verifyPassword(oldPassword || '', user.passwordHash))) {
    throw new AuthError('invalid_grant', '原密码错误', 400);
  }
  validatePassword(newPassword);
  await updateUser(userId, { passwordHash: await hashPassword(newPassword) });
  await kickUser(userId);
}

/* ------------------------------------------------------------------ */
/* 账号管理（仅管理员，且只碰账号本身，不碰别人的业务数据）                    */
/* ------------------------------------------------------------------ */

export async function listAllUsers(): Promise<PublicUser[]> {
  return (await listUsers()).map(toPublicUser);
}

export async function getUser(id: string): Promise<PublicUser | null> {
  const user = await findUserById(id);
  return user ? toPublicUser(user) : null;
}

/** 管理员建号：直接 active，权限可一次性给全 */
export async function createUserByAdmin(input: {
  username: string;
  password: string;
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  permissions?: Partial<UserPermissions>;
}): Promise<{ user: PublicUser; password: string }> {
  const name = String(input.username || '').trim();
  validateUsername(name);
  if (await findUserByUsername(name)) {
    throw new AuthError('username_taken', '用户名已被占用', 409);
  }
  const password = input.password || randomPassword();
  validatePassword(password);

  const now = new Date();
  const record: UserRecord = {
    id: crypto.randomUUID(),
    username: name,
    displayName: (input.displayName || name).slice(0, 64),
    passwordHash: await hashPassword(password),
    role: input.role === 'admin' ? 'admin' : 'user',
    status: input.status || 'active',
    permissions: { ...emptyPermissions(), ...(input.permissions || {}) },
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    lastLoginIp: '',
  };
  await insertUser(record);
  return { user: toPublicUser(record), password };
}

export interface AdminUpdateInput {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  permissions?: Partial<UserPermissions>;
}

/**
 * 管理员改账号。任何会改变「能不能用」的改动都顺手踢下线：
 * 令牌里带的是权限快照，不踢就会留一个还在用旧权限的会话。
 */
export async function updateUserByAdmin(targetId: string, patch: AdminUpdateInput): Promise<PublicUser> {
  const target = await findUserById(targetId);
  if (!target) throw new AuthError('not_found', '账号不存在', 404);

  const losingAdmin = target.role === 'admin'
    && target.status !== 'disabled'
    && ((patch.role !== undefined && patch.role !== 'admin') || patch.status === 'disabled');
  if (losingAdmin && (await countActiveAdmins(targetId)) === 0) {
    throw new AuthError('invalid_request', '这是最后一个可用的管理员，不能降级或禁用', 409);
  }

  const update: UserUpdate = {
    displayName: patch.displayName,
    role: patch.role,
    status: patch.status,
    permissions: patch.permissions,
  };
  await updateUser(targetId, update);

  const needKick = patch.role !== undefined || patch.status !== undefined || patch.permissions !== undefined;
  if (needKick) await kickUser(targetId);

  const fresh = await findUserById(targetId);
  if (!fresh) throw new AuthError('not_found', '账号不存在', 404);
  return toPublicUser(fresh);
}

/** 管理员重置密码：返回新密码明文，一次性展示 */
export async function resetUserPassword(targetId: string): Promise<string> {
  const target = await findUserById(targetId);
  if (!target) throw new AuthError('not_found', '账号不存在', 404);
  const password = randomPassword();
  await updateUser(targetId, { passwordHash: await hashPassword(password) });
  await kickUser(targetId);
  return password;
}

/**
 * 删除账号并清空其名下数据。
 * 不允许多个管理员互删到零个，避免把自己锁在门外。
 */
export async function deleteUserByAdmin(targetId: string): Promise<void> {
  const target = await findUserById(targetId);
  if (!target) throw new AuthError('not_found', '账号不存在', 404);
  if (target.role === 'admin' && target.status !== 'disabled' && (await countActiveAdmins(targetId)) === 0) {
    throw new AuthError('invalid_request', '这是最后一个可用的管理员，不能删除', 409);
  }
  await kickUser(targetId);
  await purgeOwnerData(targetId);
  await deleteUserRow(targetId);
}

/* ------------------------------------------------------------------ */
/* 引导：首次启动造管理员                                                  */
/* ------------------------------------------------------------------ */

/**
 * users 表为空时创建初始管理员。
 * 密码只打到启动日志（logs/ 与 pm2 输出），不在任何文件里长期留存；
 * 登录后可以在页面上改。
 */
export async function bootstrapAdmin(): Promise<{ created: boolean; password?: string }> {
  if ((await countUsers()) > 0) return { created: false };

  const password = randomPassword(16);
  const now = new Date();
  const admin: UserRecord = {
    id: crypto.randomUUID(),
    username: 'admin',
    displayName: '管理员',
    passwordHash: await hashPassword(password),
    role: 'admin',
    status: 'active',
    permissions: fullPermissions(),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    lastLoginIp: '',
  };
  await insertUser(admin);
  return { created: true, password };
}

/** 权限校验的单一入口，避免各路由各写一套判断 */
export function hasPermission(user: Pick<TokenPayload, 'permissions' | 'status'>, key: PermissionKey): boolean {
  if (user.status === 'disabled') return false;
  return !!user.permissions?.[key];
}
