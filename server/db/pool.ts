import * as fs from 'fs';
import type { Pool, PoolOptions } from 'mysql2/promise';
import * as mysql from 'mysql2/promise';
import { loadConfig } from '../utils/config';
import type { DatabaseConfig } from '../utils/config';

/**
 * MySQL 连接池。
 *
 * 设计约束（来自这次对目标实例的实测，换实例时要重新确认）：
 * - 服务端 time_zone=SYSTEM 且 system_time_zone=CST，而驱动 timezone 固定按 '+00:00'
 *   解释 DATETIME：应用侧统一给 JS Date、按 UTC 读写，跨时区部署不会因为服务器
 *   本地时区不同而漂移。
 * - 跨公网连接会被中间设备静默掐断空闲连接，所以开 enableKeepAlive；
 *   否则表现是「放着半小时不用，下一次请求随机报 PROTOCOL_CONNECTION_LOST」。
 * - 目标实例 max_connections=50 且与别的业务共用，连接池上限要走配置而不是硬编码。
 */

let pool: Pool | null = null;
let poolSignature = '';

/** 把配置里的 database 段翻译成 mysql2 的连接参数 */
export function buildPoolOptions(db: DatabaseConfig, overrides: Partial<PoolOptions> = {}): PoolOptions {
  const options: PoolOptions = {
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    charset: db.charset,
    timezone: db.timezone,
    waitForConnections: true,
    connectionLimit: db.connectionLimit,
    // 队列不设上限：宁可请求排队，也不要直接抛「connection pool is exhausted」把错误抛给用户
    queueLimit: 0,
    connectTimeout: db.connectTimeoutMs,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    // 驱动层不做 date 解析成字符串，读回 DATETIME 直接给 JS Date，避免二次时区换算
    dateStrings: false,
    namedPlaceholders: false,
    multipleStatements: false,
  };

  if (db.ssl) {
    const ssl: { rejectUnauthorized: boolean; ca?: string } = {
      rejectUnauthorized: db.sslRejectUnauthorized,
    };
    if (db.sslCaPath) {
      if (!fs.existsSync(db.sslCaPath)) {
        throw new Error(`database.sslCaPath 指向的文件不存在: ${db.sslCaPath}`);
      }
      ssl.ca = fs.readFileSync(db.sslCaPath, 'utf8');
    }
    options.ssl = ssl;
  }

  return { ...options, ...overrides };
}

/** 连接参数指纹：配置变了（换了库、改了池上限）就要重建连接池 */
function signatureOf(db: DatabaseConfig): string {
  return [db.host, db.port, db.user, db.database, db.connectionLimit, db.ssl ? 'tls' : 'plain', db.timezone].join('|');
}

export function getPool(): Pool {
  const db = loadConfig().database;
  const sig = signatureOf(db);
  if (pool && poolSignature === sig) return pool;
  if (pool) {
    // 配置在运行期变了（热重载 / 测试切库）：先丢弃旧池，避免连接数翻倍
    const stale = pool;
    pool = null;
    stale.end().catch(() => undefined);
  }
  pool = mysql.createPool(buildPoolOptions(db));
  poolSignature = sig;
  return pool;
}

/**
 * 把 mysql 驱动的错误码翻译成人话。
 * 这一步值钱的在于：桌面宿主（Electron / VSCode 扩展）的启动失败没有终端日志可翻，
 * 错误必须自己说明白是「网络不通」还是「密码错了」还是「库不存在」。
 */
export function describeDbError(e: any): string {
  const code = e?.code || '';
  const d = loadConfig().database;
  const where = `${d.user}@${d.host}:${d.port}/${d.database}`;
  switch (code) {
    case 'ECONNREFUSED':
      return `数据库拒绝连接（${where}）：端口没开或 MySQL 没监听这个地址。`;
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return `数据库连接超时（${where}）：多半是云安全组/防火墙没放行，或地址不可达。`;
    case 'ENOTFOUND':
      return `数据库主机名解析失败（${where}）：检查 database.host。`;
    case 'ER_ACCESS_DENIED_ERROR':
      return `数据库账号或密码不对（${where}）：MySQL 拒绝了认证。`;
    case 'ER_BAD_DB_ERROR':
      return `目标库不存在（${where}）：先在 MySQL 里 CREATE DATABASE，或改 database.database。`;
    case 'ER_HOST_NOT_PRIVILEGED':
      return `账号没有从当前来源主机连接的授权（${where}）：需要 GRANT ... ON *.* TO 'user'@'你的客户端IP或%'`;
    case 'ER_NOT_SUPPORTED_AUTH_MODE':
      return `MySQL 服务端认证插件不被驱动支持（${where}）：8.x 默认可用 caching_sha2_password，若改过插件需确认。`;
    case 'ER_DBACCESS_DENIED_ERROR':
      return `账号对这个库没有权限（${where}）：授权范围里不含该库。`;
    case 'PROTOCOL_CONNECTION_LOST':
      return `数据库连接被中断（${where}）：服务端 wait_timeout 到了或网络被掐。重试通常即可恢复。`;
    case 'ER_POOL_GET_CONNECTION_TIMEOUT':
      return `等待连接池空闲超时（${where}）：并发或连接泄漏，考虑调大 database.connectionLimit。`;
    default:
      return `数据库连接失败（${where}）：${code ? code + ' ' : ''}${e?.message || String(e)}`;
  }
}

export interface DbProbeResult {
  version: string;
  serverTz: string;
  systemTz: string;
  maxConnections: number;
  database: string;
  collation: string;
}

/**
 * 启动探活：建一条真连接、读几个关键服务端参数，然后关掉。
 * 不做「失败就静默继续」——按既定策略，连不上库服务端就不该起来。
 */
export async function probeDatabase(): Promise<DbProbeResult> {
  const db = loadConfig().database;
  let conn;
  try {
    conn = await mysql.createConnection({
      ...buildPoolOptions(db),
      // 探活只要一条连接，别让池参数参与
      connectionLimit: undefined as any,
    });
  } catch (e: any) {
    throw new Error(describeDbError(e));
  }

  try {
    const [rows] = await conn.query(
      'SELECT VERSION() AS version, @@time_zone AS time_zone, @@system_time_zone AS system_time_zone,'
        + ' @@max_connections AS max_connections, @@collation_database AS collation, DATABASE() AS db',
    );
    const r = (rows as any[])[0] || {};
    return {
      version: String(r.version),
      serverTz: String(r.time_zone),
      systemTz: String(r.system_time_zone),
      maxConnections: Number(r.max_connections),
      database: String(r.db || db.database),
      collation: String(r.collation || ''),
    };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

/** 通用查询：只做参数化转发，不吞错误 */
export async function query<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const [rows] = await getPool().query(sql, params);
  return rows as T[];
}

export async function execute<T = any>(sql: string, params?: any[]): Promise<{ affectedRows: number; insertId: number }> {
  const [result] = await getPool().execute(sql, params);
  const r = result as any;
  return { affectedRows: r?.affectedRows ?? 0, insertId: r?.insertId ?? 0 };
}

/** 取单行；没有则返回 null */
export async function queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows.length ? rows[0] : null;
}

/**
 * 事务。回调里必须用传入的 conn，不要用 query()/execute() 帮助函数——
 * 它们从池里另拿连接，不在同一个事务里，且不报错，是最难查的一类 bug。
 */
export async function transaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback().catch(() => undefined);
    throw e;
  } finally {
    conn.release();
  }
}

/** 连接池实时状态，供 /health 与后续诊断接口使用 */
export function getPoolStatus(): { initialized: boolean; connectionLimit: number; target: string } {
  const db = loadConfig().database;
  return {
    initialized: !!pool,
    connectionLimit: db.connectionLimit,
    target: `${db.user}@${db.host}:${db.port}/${db.database}`,
  };
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const ending = pool;
  pool = null;
  poolSignature = '';
  await ending.end().catch(() => undefined);
}
