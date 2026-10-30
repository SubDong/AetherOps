import { createClient, type RedisClientType } from 'redis';
import { loadConfig, type RedisConfig } from '../utils/config';

/**
 * node-redis v6 的 createClient 是多重重载，`ReturnType<typeof createClient>` 会取到
 * 「带模块扩展」那个默认泛型，和实际返回的无模块客户端不兼容，编译报一堆 scanIterator 类型不符。
 * 这里直接写死实际返回的形态。
 */
type RedisClient = RedisClientType<{}, {}, {}, 3, {}>;

let client: RedisClient | null = null;
/** 防止并发首次调用各自 connect 一遍（node-redis 重复 connect 会抛 Socket already opened） */
let connecting: Promise<RedisClient> | null = null;

/** 把配置拼成连接串；配了 redis.url 就直接用 */
export function buildRedisUrl(cfg: RedisConfig = loadConfig().redis): string {
  if (cfg.url) return cfg.url;
  const auth = cfg.username
    ? `${encodeURIComponent(cfg.username)}${cfg.password ? `:${encodeURIComponent(cfg.password)}` : ''}@`
    : cfg.password
      ? `:${encodeURIComponent(cfg.password)}@`
      : '';
  return `redis://${auth}${cfg.host}:${cfg.port}/${cfg.db}`;
}

/** 日志/报错用：去掉连接串里的密码 */
export function describeRedis(cfg: RedisConfig = loadConfig().redis): string {
  if (cfg.url) {
    try {
      const u = new URL(cfg.url);
      return `redis://${u.username ? `${u.username}@` : ''}${u.hostname}:${u.port || 6379}/${u.pathname.replace(/^\//, '') || 0}`;
    } catch {
      return '(redis.url 格式非法)';
    }
  }
  return `${cfg.host || '(未配置)'}:${cfg.port}/${cfg.db}`;
}

/**
 * 启动探活。用一次性连接探，连不通立即抛错（reconnectStrategy: false，
 * 否则 node-redis 会自己重连，connect() 的 promise 迟迟不 settle，启动卡死还不报错）。
 */
export async function probeRedis(cfg: RedisConfig = loadConfig().redis, timeoutMs = cfg.connectTimeoutMs): Promise<void> {
  const probe = createClient({
    url: buildRedisUrl(cfg),
    socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
  });
  // 探活期间必须挂 error 监听，否则连接被拒时会以 unhandled error 崩进程
  probe.on('error', () => { /* 由下面的 catch 统一处理 */ });
  try {
    await probe.connect();
    await probe.ping();
  } finally {
    try {
      if (probe.isOpen) await probe.quit();
      else probe.destroy();
    } catch { /* ignore */ }
  }
}

/** 长连接单例；首次调用时才建连 */
export async function getRedis(): Promise<RedisClient> {
  if (client?.isReady) return client;
  if (connecting) return connecting;

  const cfg = loadConfig().redis;
  connecting = (async () => {
    const c = createClient({
      url: buildRedisUrl(cfg),
      // 运行期允许重连：Redis 短暂重启不该让整个服务不可用
      socket: {
        connectTimeout: cfg.connectTimeoutMs,
        reconnectStrategy: (retries) => Math.min(200 * (retries + 1), 3000),
      },
    });
    c.on('error', (err) => console.error(`[redis] ${err.message}`));
    c.on('reconnecting', () => console.warn('[redis] reconnecting...'));
    // 重连策略开着时，首次 connect() 失败不会 reject 而是一直重试，
    // 首连接必须自己卡超时，否则第一个请求会无声地悬在那里。
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        c.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`连接 Redis 超时（${cfg.connectTimeoutMs}ms）: ${describeRedis(cfg)}`)),
            cfg.connectTimeoutMs,
          );
        }),
      ]);
    } catch (e) {
      try { c.destroy(); } catch { /* ignore */ }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    client = c;
    return c;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/**
 * 取字符串值。
 * client 的 TypeMapping 给的是空对象字面量，get 的返回被推成 `string | {}`，
 * 直接 JSON.parse 通不过类型检查；这里收敛一次，取不到或类型不对都返回 null。
 */
export async function redisGet(key: string): Promise<string | null> {
  const c = await getRedis();
  const value = await c.get(key);
  return typeof value === 'string' ? value : null;
}

/** 拼带前缀的 key；前缀由配置控制，便于和其他业务共用实例 */
export function redisKey(suffix: string): string {
  const prefix = loadConfig().redis.keyPrefix || 'aetherops:';
  return `${prefix}${suffix}`;
}

export async function closeRedis(): Promise<void> {
  const c = client;
  client = null;
  if (!c) return;
  try {
    if (c.isOpen) await c.quit();
  } catch { /* ignore */ }
}
