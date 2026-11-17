import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * 传输链路里「口令类字段」的对称加密（浏览器 / WebView 一侧）。
 *
 * 与服务端 server/utils/transport-crypto.ts 必须成对修改：密钥、报文格式、
 * 时间戳字段名任一变化都会让两者互相解不开。
 *
 * 为什么自己实现而不直接用 WebCrypto：crypto.subtle 只在安全上下文里存在，
 * 而这套系统的主力部署形态就是 http://<内网 IP>:9802 —— 那种页面上
 * window.crypto.subtle 是 undefined。@noble/ciphers 是纯 JS 实现，不受
 * 安全上下文限制，且 crypto.getRandomValues 在非安全上下文里仍然可用。
 *
 * 算法与报文格式见服务端文件头部注释（AES-256-GCM，ao1.<iv>.<ct||tag>）。
 */

const TRANSPORT_KEY = 'aetherOps_ms';
const SEALED_PREFIX = 'ao1.';
const IV_BYTES = 12;

let cachedKey: Uint8Array | null = null;

function keyBytes(): Uint8Array {
  if (!cachedKey) cachedKey = sha256(new TextEncoder().encode(TRANSPORT_KEY));
  return cachedKey;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + (b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomIv(): Uint8Array {
  // getRandomValues 在 http:// 页面里同样可用（只有 subtle 要求安全上下文）
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  return iv;
}

/** 加密一个口令字段；返回 ao1.x.y 形式的字符串，直接放进请求体即可 */
export function sealSecret(plain: string): string {
  const iv = randomIv();
  const payload = new TextEncoder().encode(JSON.stringify({ t: Date.now(), d: String(plain) }));
  const body = gcm(keyBytes(), iv).encrypt(payload);
  return `${SEALED_PREFIX}${toBase64Url(iv)}.${toBase64Url(body)}`;
}

/** 是否是服务端回包的密文；出参只有口令类字段会是这种形状 */
export function isSealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

/** 解开服务端回包里的密文口令（建号 / 重置口令时由服务端生成） */
export function openSecret(sealed: string): string {
  if (!isSealed(sealed)) {
    // 不是密文就原样返回：字段为空、或服务端未来把这一层去掉时不至于把界面弄崩
    return sealed || '';
  }
  const parts = sealed.slice(SEALED_PREFIX.length).split('.');
  if (parts.length !== 2) throw new Error('服务端返回的密文格式不正确');
  const iv = fromBase64Url(parts[0]);
  const body = fromBase64Url(parts[1]);
  const plain = gcm(keyBytes(), iv).decrypt(body);
  const envelope = JSON.parse(new TextDecoder().decode(plain));
  return typeof envelope?.d === 'string' ? envelope.d : '';
}

/**
 * 口令字段的统一处理：调用点只关心「要不要带这个字段」。
 * 空串返回空串（服务端按「没填」处理，例如建号时随机生成口令）。
 */
export function sealOptional(plain?: string | null): string {
  return plain ? sealSecret(plain) : '';
}
