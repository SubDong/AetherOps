/**
 * SQLite 驱动（lite 模式）。
 *
 * 用 Node 内置的 `node:sqlite`，不引 better-sqlite3：
 * 桌面宿主（Electron / VSCode 扩展）要打预编译原生模块，跨 Node ABI 的 rebuild
 * 是这里最容易坏的一环；内置模块零依赖、零编译。
 *
 * 几个刻意的选择：
 * - 单连接 + 同步 API：SQLite 的写并发本来就是串行的（WAL 也只允许一个写者），
 *   再包一层连接池只是把等待挪进池里。同步调用在单进程 Node 里天然串行，
 *   仓储层的 async 签名保持不变即可（返回已决议的 Promise）。
 * - `journal_mode=WAL` + `busy_timeout`：服务端与 `scripts/migrate.mjs`
 *   可能同时打开同一个文件，WAL 让读不被写阻塞，busy_timeout 让写等锁而不是立刻报
 *   SQLITE_BUSY。
 * - 状态挂在 globalThis：与 MySQL 池同一个理由 —— dev 模式改配置会重新求值模块图，
 *   模块级单例会出现两份连接，旧的一份永远不会关。
 * - 预编译语句按 SQL 文本缓存，但设上限：审计查询的 WHERE 是动态拼的，
 *   无上限缓存等于给每个筛选组合留一条语句。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { getSqlitePath, loadConfig } from '../utils/config';
import {
  mysqlDateFormat,
  normalizeSqliteRow,
  toSqliteValue,
  translateSqlForSqlite,
} from './dialect';

const STATE_KEY = Symbol.for('aetherops.db.sqliteState');
const MAX_CACHED_STATEMENTS = 200;

interface SqliteState {
  db: DatabaseSync | null;
  file: string;
  statements: Map<string, StatementSync>;
  primaryKeys: Map<string, string[]>;
}

function sqliteState(): SqliteState {
  const holder = globalThis as unknown as Record<symbol, SqliteState | undefined>;
  if (!holder[STATE_KEY]) {
    holder[STATE_KEY] = { db: null, file: '', statements: new Map(), primaryKeys: new Map() };
  }
  return holder[STATE_KEY] as SqliteState;
}

function busyTimeoutMs(): number {
  const configured = Number(loadConfig().storage?.busyTimeoutMs);
  if (!Number.isFinite(configured) || configured < 0) return 5000;
  return Math.min(Math.floor(configured), 60000);
}

/** 打开（或复用）SQLite 连接。首次调用时建目录、设 PRAGMA、注册自定义函数 */
export function getSqlite(): DatabaseSync {
  const file = getSqlitePath();
  const state = sqliteState();
  if (state.db && state.file === file) return state.db;

  if (state.db) {
    try { state.db.close(); } catch { /* 已关闭 */ }
    state.db = null;
    state.statements.clear();
    state.primaryKeys.clear();
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // 顺序无所谓，但必须在开写之前
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs()}`);
  // NORMAL：WAL 下崩溃最多丢最后一个检查点，不会损坏库；FULL 会把每次提交都 fsync
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = OFF');
  // DATE_FORMAT 在 SQLite 里不存在，但审计仓储（以及潜在的其他查询）依赖它
  db.function('DATE_FORMAT', { deterministic: true }, (value: any, format: any) => mysqlDateFormat(value, format));

  state.db = db;
  state.file = file;
  console.log(`[sqlite] opened ${file}`);
  return db;
}

/**
 * 主键列（按 PRIMARY KEY 里的顺序）。
 * `ON CONFLICT (<cols>)` 必须与某个唯一索引完全对上，这里给表的主键；
 * 仓储里所有 upsert 的冲突键都等于主键（已逐一核对）。
 */
export function resolveSqlitePrimaryKey(table: string): string[] {
  const state = sqliteState();
  const key = table.replace(/`/g, '').toLowerCase();
  const cached = state.primaryKeys.get(key);
  if (cached) return cached;

  const safe = key.replace(/[^a-z0-9_]/g, '');
  const rows = getSqlite().prepare(`PRAGMA table_info("${safe}")`).all() as any[];
  const pk = rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => String(r.name));
  state.primaryKeys.set(key, pk);
  return pk;
}

function prepare(sql: string): StatementSync {
  const state = sqliteState();
  const translated = translateSqlForSqlite(sql, resolveSqlitePrimaryKey);
  const cached = state.statements.get(translated);
  if (cached) return cached;

  const stmt = getSqlite().prepare(translated);
  if (state.statements.size >= MAX_CACHED_STATEMENTS) state.statements.clear();
  state.statements.set(translated, stmt);
  return stmt;
}

function bindable(params?: any[]): any[] {
  return (params || []).map(toSqliteValue);
}

/** 查询多行 */
export async function sqliteQuery<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const values = bindable(params);
  const rows = values.length ? prepare(sql).all(...values) : prepare(sql).all();
  return (rows as any[]).map((row) => normalizeSqliteRow<T>(row));
}

/** 执行写语句 */
export async function sqliteExecute(sql: string, params?: any[]): Promise<{ affectedRows: number; insertId: number }> {
  const values = bindable(params);
  const result: any = values.length ? prepare(sql).run(...values) : prepare(sql).run();
  return {
    affectedRows: Number(result?.changes ?? 0),
    insertId: Number(result?.lastInsertRowid ?? 0),
  };
}

/**
 * 执行多语句 DDL（迁移、基线建表用）。
 * `exec` 不返回行；用于不含占位符的脚本。
 */
export function sqliteExec(sql: string): void {
  getSqlite().exec(sql);
}

/** 同步取单行（迁移器内部用，避免类型包装） */
export function sqliteGet<T = any>(sql: string, params?: any[]): T | null {
  const values = bindable(params);
  const row: any = values.length ? getSqlite().prepare(sql).get(...values) : getSqlite().prepare(sql).get();
  return row ? normalizeSqliteRow<T>(row) : null;
}

/** 同步取多行（迁移器内部用） */
export function sqliteAll<T = any>(sql: string, params?: any[]): T[] {
  const values = bindable(params);
  const rows: any[] = values.length ? getSqlite().prepare(sql).all(...values) : getSqlite().prepare(sql).all();
  return rows.map((row) => normalizeSqliteRow<T>(row));
}

/**
 * 事务。
 *
 * 注意：SQLite 驱动是同步的，而回调是 async —— 回调里 `await` 期间若别的请求
 * 也执行语句，会一起落进这个事务。当前没有任何调用方，保留它只为兼容 pool 的签名；
 * 需要真正的事务语义时请用同步回调（不 await）。
 */
export async function sqliteTransaction<T>(fn: () => Promise<T> | T): Promise<T> {
  const db = getSqlite();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 事务可能已被 SQLite 自动回滚 */ }
    throw e;
  }
}

/** 事务（同步版）：给 lite 的令牌存储用，中间不 await，保证不被别的语句插队 */
export function sqliteTransactionSync<T>(fn: () => T): T {
  const db = getSqlite();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export interface SqliteProbeResult {
  version: string;
  journalMode: string;
  file: string;
  busyTimeoutMs: number;
}

/** 启动探活：打开文件、读版本与 journal_mode */
export async function probeSqlite(): Promise<SqliteProbeResult> {
  const db = getSqlite();
  const version = db.prepare('SELECT sqlite_version() AS v').get() as any;
  const journal = db.prepare('PRAGMA journal_mode').get() as any;
  return {
    version: String(version?.v || ''),
    journalMode: String(journal?.journal_mode || ''),
    file: sqliteState().file,
    busyTimeoutMs: busyTimeoutMs(),
  };
}

/** 连接状态，供 /health 与诊断用 */
export function getSqliteStatus(): { initialized: boolean; file: string } {
  const state = sqliteState();
  return { initialized: !!state.db, file: state.file };
}

/** 关闭连接（进程退出、迁移脚本结束时调用） */
export async function closeSqlite(): Promise<void> {
  const state = sqliteState();
  if (!state.db) return;
  const db = state.db;
  state.db = null;
  state.file = '';
  state.statements.clear();
  state.primaryKeys.clear();
  try {
    // 把 WAL 合并回主文件，避免留下一堆 *.db-wal 让备份漏数据
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch { /* 只读介质等场景忽略 */ }
  try { db.close(); } catch { /* ignore */ }
}
