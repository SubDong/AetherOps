import * as path from 'path';
import { loadConfig } from './config';

/**
 * 从请求头取 Bearer 令牌。
 *
 * 账号体系下令牌只有一个来源：`Authorization: Bearer <token>`。
 * 旧年代的 cookie 与 X-AetherOps-Token 两种通道已移除——留着只会让人
 * 以为还有第二种鉴权入口。浏览器 WebSocket 带不了自定义头，它的令牌
 * 由调用方从 `?token=` 取，那是协议限制，不属于这里。
 */
export function extractBearerToken(headers: Record<string, any>): string {
  const auth = headers.authorization || headers.Authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

export function isLocalHost(host?: string | null): boolean {
  if (!host) return true;
  const name = host.split(':')[0].toLowerCase();
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(name);
}

export function isAllowedOrigin(origin?: string | string[], host?: string | string[]): boolean {
  if (!origin) return true;
  const value = Array.isArray(origin) ? origin[0] : origin;
  const hostValue = Array.isArray(host) ? host[0] : host;
  try {
    const originUrl = new URL(value);
    return originUrl.host === hostValue || isLocalHost(originUrl.host);
  } catch {
    return false;
  }
}

export function normalizeUploadName(name: string): string {
  const normalized = String(name || '').replace(/\\/g, '/').replace(/\0/g, '');
  const isAbsolute = normalized.startsWith('/');
  const parts = normalized.split('/').filter(part => part && part !== '.' && part !== '..');
  if (!parts.length) throw new Error('Invalid file name');
  return `${isAbsolute ? '/' : ''}${parts.join('/')}`;
}

export function maxUploadBytes(): number {
  // 上限已由 config 层统一解析（含类型纠正），这里只做字节换算与下限保护
  const mb = loadConfig().auth.maxUploadMb;
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : 100) * 1024 * 1024);
}

export function safeJoinInside(baseDir: string, ...segments: string[]): string {
  const target = path.resolve(baseDir, ...segments);
  const base = path.resolve(baseDir);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('Path escapes base directory');
  }
  return target;
}

/**
 * 读文件（SFTP）时拒掉的路径。
 *
 * 与 monitor.service 的 isSensitiveLogPath 刻意不同：那个拦的是「会被拼进 shell 命令的日志路径」，
 * 所以连整个 /etc 都禁掉；read_file 走 SFTP，不经过 shell，而 /etc/nginx/nginx.conf 这类配置
 * 恰恰是最常要看的东西。所以这里只拦「本身即凭据」的路径，不按目录一刀切。
 *
 * 这些规则只防「模型顺手把私钥读出来贴进对话」，不是权限边界 —— 能开终端的人本来就能 cat。
 */
const SENSITIVE_READ_PATTERNS = [
  '/proc/', '/sys/', '/dev/',
  '/etc/shadow', '/etc/gshadow', '/etc/sudoers', '/etc/ssl/private/',
  '/.ssh/', '/.gnupg/', '/.docker/config.json', '/.kube/config',
  '/.npmrc', '/.pgpass', '/.my.cnf', '/.netrc', '/.git-credentials',
  'authorized_keys', 'known_hosts',
  '.pem', '.p12', '.pfx', '.key', '.keystore', '.jks',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
];

export function isSensitiveReadPath(value: string): boolean {
  const normalized = String(value || '').replace(/\\/g, '/').toLowerCase();
  return SENSITIVE_READ_PATTERNS.some((entry) => normalized.includes(entry));
}

/**
 * 校验并归一化一个待读取的远端路径。
 *
 * 只接受绝对路径：相对路径会让「读哪个文件」取决于远端 shell 的 cwd，
 * 同一句话在不同会话里指向不同文件，事后连审计都复现不出来。
 */
export function assertReadablePath(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('path is required');
  if (raw.length > 1024) throw new Error('path is too long (max 1024 chars)');
  if (/[\0\r\n]/.test(raw)) throw new Error('path contains control characters');

  const windowsAbsolute = /^[a-zA-Z]:[\\/]/.test(raw);
  const uncAbsolute = raw.startsWith('\\\\');
  if (!windowsAbsolute && !uncAbsolute && !raw.startsWith('/')) {
    throw new Error('path must be absolute (start with "/" or a drive letter)');
  }
  if (!windowsAbsolute && !uncAbsolute && /[*?\[\]{}<>|;&`$()]/.test(raw)) {
    // SFTP 不经过 shell，这些字符本身不构成注入；拦下来是因为它们只可能来自「用户把 shell 通配符
    // 或命令片段写进了路径」，放过去只会换来一个看不懂的 stat 失败。
    throw new Error('path contains shell metacharacters; pass a literal file path');
  }

  const normalized = windowsAbsolute || uncAbsolute
    ? raw.replace(/[\\/]+/g, path.sep)
    : path.posix.normalize(raw);
  if (isSensitiveReadPath(raw) || isSensitiveReadPath(normalized)) {
    throw new Error('access to this path is not allowed (credentials / device files)');
  }
  return normalized;
}
