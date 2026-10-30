import * as crypto from 'crypto';
import { promisify } from 'util';
import { getRedis, redisGet, redisKey } from '../db/redis';
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

/** 令牌有效期（秒） */
export const TOKEN_TTL_SECONDS = 7200;
/** 剩余有效期低于这个值才续期；太频繁续期会让 redis 写入变成每个请求一次 */
export const TOKEN_RENEW_THRESHOLD_SECONDS = 1000;

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

/** Redis 里存的东西；刻意不含令牌明文，只有哈希能对上 */
export interface TokenPayload {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  permissions: UserPermissions;
  issuedAt: number;
  loginIp: string;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function tokenKey(tokenHash: string): string {
  return redisKey(`token:${tokenHash}`);
}

function userTokenKey(userId: string): string {
  return redisKey(`user:${userId}:token`);
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
  };
  const client = await getRedis();
  // KEYS[1] 是账号索引（userId -> 令牌哈希），KEYS[2] 是本次令牌的 payload key：
  // 「删旧 + 写新索引 + 写新 payload」必须在同一段脚本里，否则并发登录会各自以为自己是唯一会话。
  // ARGV[1] 是 token key 前缀，Lua 里用来拼旧 key。
  await client.eval(ISSUE_SCRIPT, {
    keys: [userTokenKey(user.id), tokenKey(tokenHash)],
    arguments: [redisKey('token:'), tokenHash, JSON.stringify(payload), String(TOKEN_TTL_SECONDS)],
  });
  return token;
}

/**
 * 校验令牌并滑动续期。
 * 返回 null 表示令牌无效；调用方据此回 401。
 */
export async function authenticate(token: string): Promise<TokenPayload | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const key = tokenKey(tokenHash);
  const client = await getRedis();
  const raw = await redisGet(key);
  if (!raw) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    await client.del(key);
    return null;
  }

  // TTL 低于阈值则续到满；这里不 await 结果之外的错误处理，失败就让上层 500——
  // 续期都失败的 Redis 不该被当成「鉴权通过」继续放行。
  await client.eval(RENEW_SCRIPT, {
    keys: [key, userTokenKey(payload.userId)],
    arguments: [String(TOKEN_RENEW_THRESHOLD_SECONDS), String(TOKEN_TTL_SECONDS)],
  });

  return payload;
}

/** 只读当前剩余有效期，供调试/前端展示用 */
export async function tokenTtl(token: string): Promise<number> {
  const client = await getRedis();
  return client.ttl(tokenKey(hashToken(token)));
}

export async function revokeToken(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  const client = await getRedis();
  const payloadRaw = await redisGet(tokenKey(tokenHash));
  let userId = '';
  if (payloadRaw) {
    try { userId = JSON.parse(payloadRaw).userId || ''; } catch { /* ignore */ }
  }
  await client.del(tokenKey(tokenHash));
  if (userId) {
    const indexKey = userTokenKey(userId);
    const current = await redisGet(indexKey);
    // 只有当索引还指向这个令牌时才删，避免把「重新登录后的新令牌」索引清掉
    if (current === tokenHash) await client.del(indexKey);
  }
}

/** 强制下线：禁用账号、改权限、重置密码、删号时调用 */
export async function kickUser(userId: string): Promise<void> {
  const client = await getRedis();
  const indexKey = userTokenKey(userId);
  const tokenHash = await redisGet(indexKey);
  if (tokenHash) await client.del(tokenKey(tokenHash));
  await client.del(indexKey);
}

/* ------------------------------------------------------------------ */
/* 注册 / 登录 / 改密                                                      */
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
    expiresIn: TOKEN_TTL_SECONDS,
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
