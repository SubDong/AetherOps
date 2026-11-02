/**
 * 登录态：令牌 + 当前账号快照。
 *
 * 为什么存 localStorage 而不是 cookie：服务端只认 `Authorization: Bearer`（OAuth2 密码模式），
 * 没有 cookie 参与；而 Electron（IPC）与 VSCode WebView 也要复用同一份登录态，
 * cookie 在这两种宿主里根本发不出去。
 *
 * 为什么不缓存到内存就够：终端页每次刷新都会重建整个前端，内存里存不住。
 * 令牌本身的 7200s 滑动过期由服务端 Redis 控制，前端只是个保管箱。
 */
import config from '@/base/config';
import { isElectron } from '@/base/detect';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'pending' | 'active' | 'disabled';

/** 与 server/model/user.entity.ts 的 UserPermissions 一一对应 */
export type PermissionKey =
  | 'terminal' | 'batch' | 'ai' | 'connections' | 'aiConfig' | 'files'
  | 'monitor' | 'audit' | 'skills' | 'snippets';

export const PERMISSION_KEYS: PermissionKey[] = [
  'terminal', 'batch', 'ai', 'connections', 'aiConfig', 'files',
  'monitor', 'audit', 'skills', 'snippets',
];

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  permissions: Record<string, boolean>;
  createdAt?: string;
  lastLoginAt?: string | null;
  lastLoginIp?: string;
}

interface StoredAuth {
  token: string;
  user: AuthUser | null;
}

const STORAGE_KEY = 'aetherops.auth.v1';

/** 缓存一份，避免每个请求都 JSON.parse 一次 */
let cached: StoredAuth | null | undefined;

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // 隐私模式 / 沙箱里访问 localStorage 会抛异常，不能让它把整个页面带崩
    return null;
  }
}

function readStorage(): StoredAuth | null {
  if (cached !== undefined) return cached;
  const store = safeStorage();
  if (!store) {
    cached = null;
    return cached;
  }
  try {
    const raw = store.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    cached = parsed && typeof parsed.token === 'string' ? { token: parsed.token, user: parsed.user || null } : null;
  } catch {
    cached = null;
  }
  return cached;
}

function writeStorage(value: StoredAuth | null) {
  cached = value;
  const store = safeStorage();
  if (!store) return;
  try {
    if (value) store.setItem(STORAGE_KEY, JSON.stringify(value));
    else store.removeItem(STORAGE_KEY);
  } catch { /* 配额满 / 被禁用：内存里仍有登录态，只是刷新后要重登 */ }
}

export function getToken(): string {
  return readStorage()?.token || '';
}

export function getCurrentUser(): AuthUser | null {
  return readStorage()?.user || null;
}

/** 登录成功或 /api/auth/me 刷新后写入 */
export function setAuth(token: string, user: AuthUser | null) {
  writeStorage({ token, user });
}

export function updateCurrentUser(user: AuthUser | null) {
  const token = getToken();
  if (!token) return;
  writeStorage({ token, user });
}

export function clearAuth() {
  writeStorage(null);
}

export function hasPermission(key: PermissionKey): boolean {
  const user = getCurrentUser();
  return Boolean(user?.permissions?.[key]);
}

/** 「任一即可」：与后端 assertPermission 的语义保持一致 */
export function hasAnyPermission(keys: PermissionKey[]): boolean {
  return keys.some(hasPermission);
}

export function isAdmin(): boolean {
  return getCurrentUser()?.role === 'admin';
}

export function isPending(): boolean {
  return getCurrentUser()?.status === 'pending';
}

/* ------------------------------------------------------------------ */
/* 请求                                                                 */
/* ------------------------------------------------------------------ */

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function apiUrl(pathname: string): string {
  if (/^https?:\/\//.test(pathname)) return pathname;
  const origin = config.apiUrl || location.origin;
  return `${String(origin).replace(/\/$/, '')}${config.prefix}${pathname}`;
}

function isElectronIpc(): boolean {
  return Boolean(isElectron && window.electronAPI?.isPackaged);
}

/**
 * 账号相关接口。
 * 刻意不走 service/base 的请求层：登录失败会返回 401，而请求层遇到 401 会跳登录页，
 * 在登录页上「密码错了」就会变成「页面刷新了一下什么都没说」。
 */
async function callAccountApi(pathname: string, body: any): Promise<{ status: number; data: any }> {
  if (isElectronIpc()) {
    const res = await window.electronAPI!.api.request(pathname, body, getToken());
    return { status: res?.status ?? 500, data: res?.data };
  }
  const resp = await fetch(apiUrl(pathname), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body || {}),
  });
  let data: any = null;
  try { data = await resp.json(); } catch { data = null; }
  return { status: resp.status, data };
}

function errorMessage(data: any, fallback: string): string {
  return data?.error_description || data?.msg || data?.error || fallback;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const { status, data } = await callAccountApi('/oauth/token', {
    grant_type: 'password',
    username,
    password,
  });
  if (status !== 200 || !data?.access_token) {
    throw new Error(errorMessage(data, `登录失败（HTTP ${status}）`));
  }
  setAuth(data.access_token, data.user || null);
  return data.user as AuthUser;
}

/** 自助注册：落库即 pending，管理员授权前用不了任何功能 */
export async function register(username: string, password: string, displayName?: string): Promise<AuthUser> {
  const { status, data } = await callAccountApi('/api/auth/register', { username, password, displayName });
  if (status !== 200 || data?.ret !== 0) {
    throw new Error(errorMessage(data, `注册失败（HTTP ${status}）`));
  }
  return data.data?.user as AuthUser;
}

/** 拉一次最新账号状态（权限被管理员改过时，这里能拿到新值） */
export async function refreshMe(): Promise<AuthUser | null> {
  const { status, data } = await callAccountApi('/api/auth/me', {});
  if (status !== 200 || data?.ret !== 0) return null;
  const user = data.data as AuthUser;
  updateCurrentUser(user);
  return user;
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const { status, data } = await callAccountApi('/api/auth/changePassword', { oldPassword, newPassword });
  if (status !== 200 || data?.ret !== 0) {
    throw new Error(errorMessage(data, '修改密码失败'));
  }
}

/**
 * 退出：先让服务端吊销令牌（否则这个 token 还能用到自然过期），
 * 无论服务端是否成功都要清掉本地——用户点了退出就不该还停在登录态里。
 */
export async function logout(): Promise<void> {
  const token = getToken();
  try {
    if (token) await callAccountApi('/oauth/revoke', { token });
  } catch { /* 网络不通也要退出 */ }
  clearAuth();
  redirectToLogin();
}

export function loginPath(redirect?: string): string {
  const target = redirect ?? `${location.pathname}${location.search}`;
  const safe = target.startsWith('/login') ? '/' : target;
  return `${config.prefix}/login?redirect=${encodeURIComponent(safe)}`;
}

let redirecting = false;

/**
 * 跳登录页。
 * 用 location.replace 而不是 router.push：401 往往发生在请求层（拿不到 router 实例），
 * 而且要把当前地址记进 redirect，刷新页面最省事。
 */
export function redirectToLogin(): void {
  if (redirecting) return;
  if (location.pathname.endsWith('/login')) return;
  redirecting = true;
  clearAuth();
  location.replace(loginPath());
}

/* ------------------------------------------------------------------ */
/* 账号管理（仅管理员，服务端仍会再校验一次）                              */
/* ------------------------------------------------------------------ */

export interface UserListResult {
  status: number;
  data: any;
}

export async function adminListUsers(): Promise<AuthUser[]> {
  const { status, data } = await callAccountApi('/api/users/list', {});
  if (status !== 200 || data?.ret !== 0) throw new Error(errorMessage(data, '获取账号列表失败'));
  return (data.data || []) as AuthUser[];
}

export async function adminCreateUser(input: {
  username: string;
  password?: string;
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  permissions?: Record<string, boolean>;
}): Promise<{ user: AuthUser; password: string }> {
  const { status, data } = await callAccountApi('/api/users/create', input);
  if (status !== 200 || data?.ret !== 0) throw new Error(errorMessage(data, '创建账号失败'));
  return data.data;
}

export async function adminUpdateUser(input: {
  id: string;
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  permissions?: Record<string, boolean>;
}): Promise<AuthUser> {
  const { status, data } = await callAccountApi('/api/users/update', input);
  if (status !== 200 || data?.ret !== 0) throw new Error(errorMessage(data, '更新账号失败'));
  return data.data as AuthUser;
}

export async function adminResetPassword(id: string): Promise<string> {
  const { status, data } = await callAccountApi('/api/users/resetPassword', { id });
  if (status !== 200 || data?.ret !== 0) throw new Error(errorMessage(data, '重置密码失败'));
  return data.data?.password || '';
}

export async function adminDeleteUser(id: string): Promise<void> {
  const { status, data } = await callAccountApi('/api/users/delete', { id });
  if (status !== 200 || data?.ret !== 0) throw new Error(errorMessage(data, '删除账号失败'));
}
