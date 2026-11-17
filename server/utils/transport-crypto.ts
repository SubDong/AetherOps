import * as crypto from 'crypto';

/**
 * 传输链路里「口令类字段」的对称加密（服务端一侧）。
 *
 * 为什么要在应用层做这件事：这套系统大多是个人 / 公司内网自用部署，
 * 前面常常没有反向代理，直接跑在 http:// 上。TLS 是更彻底的办法（也照样支持，
 * 两者不冲突），但既然部署形态不改，口令至少要保证在网络里是密文，
 * 而不是一眼就能读出来的 JSON。
 *
 * 算法：AES-256-GCM（密文带认证标签），密钥 = SHA-256(固定口令)。
 * 每次加密都用随机 12 字节 IV，所以同一个口令每次上传的密文都不同。
 * 明文里带时间戳，超过 SEAL_TTL_MS 的密文直接拒收 —— 抓到一个旧包也重放不了。
 *
 * 报文格式：ao1.<base64url(iv)>.<base64url(ciphertext || tag)>
 *
 * 密钥写在前端 bundle 里，能拿到前端代码的人就能读出来，因此这层的定位是
 * 「防网络侧明文泄露（抓包、代理访问日志、链路中间设备）」，不是防住能改客户端的人。
 * 要抗住后者只能靠 TLS。前端实现见 src/utils/transport-crypto.ts，两侧必须同步修改。
 */

/** 固定传输密钥；改这个值等于旧前端再也登不进来，必须与前端同步改 */
export const TRANSPORT_KEY = 'aetherOps_ms';

/** 报文前缀 + 版本号：以后换算法时靠它区分，不会把旧报文解成乱码 */
export const SEALED_PREFIX = 'ao1.';

/** 密文有效期：超过这个时间差（双向）视为重放 / 时钟异常 */
export const SEAL_TTL_MS = 10 * 60 * 1000;

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 报文本身不合法（格式、验签、过期、字段类型） */
export class SealedPayloadError extends Error {
  code: string;
  constructor(message: string, code = 'cipher_invalid') {
    super(message);
    this.name = 'SealedPayloadError';
    this.code = code;
  }
}

let cachedKey: Buffer | null = null;

function keyBytes(): Buffer {
  if (!cachedKey) cachedKey = crypto.createHash('sha256').update(TRANSPORT_KEY, 'utf8').digest();
  return cachedKey;
}

/** 判断一个值是否是本模块产生的密文（服务端出参也用它，前端据此决定要不要解密） */
export function isSealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

/**
 * 加密一个字符串。
 * 服务端主要在「生成口令回给管理员」这一侧用到（建号 / 重置口令）。
 */
export function sealString(plain: string, now: number = Date.now()): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const payload = Buffer.from(JSON.stringify({ t: now, d: String(plain) }), 'utf8');
  const body = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  return `${SEALED_PREFIX}${iv.toString('base64url')}.${body.toString('base64url')}`;
}

/** 解密一个密文；格式不对、验签失败、时间戳过期都抛 SealedPayloadError */
export function openString(sealed: string, now: number = Date.now()): string {
  if (!isSealed(sealed)) {
    throw new SealedPayloadError('缺少密文前缀（请求未按约定加密）', 'cipher_required');
  }
  const parts = sealed.slice(SEALED_PREFIX.length).split('.');
  if (parts.length !== 2) {
    throw new SealedPayloadError('密文格式不正确');
  }
  const iv = Buffer.from(parts[0], 'base64url');
  const body = Buffer.from(parts[1], 'base64url');
  if (iv.length !== IV_BYTES || body.length <= TAG_BYTES) {
    throw new SealedPayloadError('密文长度不正确');
  }

  const tag = body.subarray(body.length - TAG_BYTES);
  const data = body.subarray(0, body.length - TAG_BYTES);
  let plain: string;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // 这里也可能是「服务端与前端密钥不一致」，日志里不要回显任何密文片段
    throw new SealedPayloadError('密文无法解开（密钥不匹配或被篡改）');
  }

  let envelope: { t?: number; d?: unknown };
  try {
    envelope = JSON.parse(plain);
  } catch {
    throw new SealedPayloadError('密文内容不是合法信封');
  }
  if (!envelope || typeof envelope.d !== 'string' || typeof envelope.t !== 'number') {
    throw new SealedPayloadError('密文信封字段缺失');
  }
  if (Math.abs(now - envelope.t) > SEAL_TTL_MS) {
    throw new SealedPayloadError('密文已过期，请刷新页面后重试', 'cipher_expired');
  }
  return envelope.d;
}

/**
 * 读取请求体里的一个口令字段。
 *
 * - 空值 / 缺省：返回空串，交给业务层按「没填」处理（例如建号不填口令 = 服务端随机生成）
 * - 明文：直接拒绝。客户端和服务端是同一个包发出去的，不存在「老客户端」这种正当理由，
 *   留一条明文后门等于这层加密白做。
 */
export function openSecretInput(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new SealedPayloadError(`字段 ${field} 必须是密文字符串`);
  }
  if (!isSealed(value)) {
    throw new SealedPayloadError(`字段 ${field} 必须以密文传输`, 'cipher_required');
  }
  return openString(value);
}

/**
 * 出参脱敏：服务端生成的口令（建号 / 重置）同样不允许以明文回给浏览器。
 * 空值原样返回，免得前端拿到 "ao1." 这种半截密文。
 */
export function sealSecretOutput(plain: string): string {
  return plain ? sealString(plain) : plain;
}
