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
