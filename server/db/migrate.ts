import * as crypto from 'crypto';
import type { PoolConnection } from 'mysql2/promise';
import { getPool, closePool, probeDatabase } from './pool';
import type { DbProbeResult } from './pool';
import { MIGRATIONS } from './migrations';

/**
 * 迁移器：schema_version 表 + 按版本顺序执行未应用的迁移。
 *
 * 几个必须说清楚的取舍：
 *
 * 1) MySQL 的 DDL 会隐式提交，事务回滚对它无效。所以「迁移失败自动回滚」在 MySQL 上
 *    是假的。这里的做法是：整个迁移成功后才写 schema_version 行，失败就抛错中止，
 *    下一次启动会重跑同一个版本 —— 因此每个迁移都得写成可重入的（建表用
 *    IF NOT EXISTS，加列前想清楚重复执行会怎样）。
 *
 * 2) 校验和按「空白折叠 + 去注释」后再取 sha256。直接对原文取摘要会在不同机器上误报：
 *    Windows 检出是 CRLF、Linux 是 LF，同一份迁移算出两个摘要，CI 会莫名其妙拒绝启动。
 *    代价是只改注释不会被视为改动。
 *
 * 3) 用 GET_LOCK 串行化：Web/Docker 多副本同时启动时，两个实例并行跑同一批 DDL
 *    会撞出「table exists」之类的假错误。
 */

const SCHEMA_TABLE = 'schema_version';
const LOCK_NAME = 'aetherops_migrate';
const LOCK_TIMEOUT_SECONDS = 30;

export interface MigrationRecord {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
  execution_ms: number;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/** 归一化后再算摘要，屏蔽行尾/缩进/注释差异 */
export function checksumOf(sql: string): string {
  const normalized = sql
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t !== '' && !t.startsWith('--') && !t.startsWith('#');
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * 语句切分器。
 *
 * 不能直接 sql.split(';')：将来必然有迁移往文本列里写入含分号的内容（技能正文、
 * 用户脚本片段），朴素切分会把一条 INSERT 劈成两条语法错误的语句。
 * 这里按 MySQL 词法跳过字符串字面量（单引号、双引号、反引号标识符）、行注释与块注释。
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === '-' && next === '-' && (sql[i + 2] === ' ' || sql[i + 2] === '\t' || sql[i + 2] === '\n')) {
        inLineComment = true;
        i++;
        continue;
      }
      // '#' 行注释只能出现在行首或空白后，否则会把 'a#b' 这类内容切错
      if (ch === '#') {
        inLineComment = true;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    if (ch === "'" && !inDouble && !inBacktick) {
      // '' 是转义后的单引号，不结束字符串；\' 同理
      if (inSingle && (next === "'" || next === '\\')) {
        current += ch;
        continue;
      }
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && !inBacktick) {
      if (inDouble && (next === '"' || next === '\\')) {
        current += ch;
        continue;
      }
      inDouble = !inDouble;
    } else if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
    }

    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

async function ensureSchemaTable(conn: PoolConnection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS \`${SCHEMA_TABLE}\` (
      version      VARCHAR(64)  NOT NULL,
      name         VARCHAR(255) NOT NULL DEFAULT '',
      checksum     CHAR(64)     NOT NULL COMMENT '迁移正文 sha256（空白归一化后）',
      applied_at   DATETIME(3)  NOT NULL COMMENT '由应用层给 UTC 时间',
      execution_ms INT          NOT NULL DEFAULT 0,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
      COMMENT='已应用的数据库迁移'
  `);
}

async function loadApplied(conn: PoolConnection): Promise<Map<string, MigrationRecord>> {
  const [rows] = await conn.query(
    `SELECT version, name, checksum, execution_ms, DATE_FORMAT(applied_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS applied_at
       FROM \`${SCHEMA_TABLE}\` ORDER BY version`,
  );
  const map = new Map<string, MigrationRecord>();
  for (const r of rows as any[]) {
    map.set(r.version, {
      version: r.version,
      name: r.name,
      checksum: r.checksum,
      applied_at: r.applied_at,
      execution_ms: Number(r.execution_ms),
    });
  }
  return map;
}

/** 只读：当前库上已应用的版本，供启动日志与后续诊断接口用 */
export async function getAppliedVersions(): Promise<MigrationRecord[]> {
  const conn = await getPool().getConnection();
  try {
    await ensureSchemaTable(conn);
    return Array.from((await loadApplied(conn)).values());
  } finally {
    conn.release();
  }
}

/**
 * 执行迁移。
 * @param force 已应用的迁移正文与库里记录的校验和不一致时，默认拒绝启动；
 *              force 只应在你确认「改动是安全的、且我需要它按新内容跑」时使用。
 */
export async function runMigrations(force = false): Promise<MigrateResult> {
  const conn = await getPool().getConnection();
  const result: MigrateResult = { applied: [], alreadyApplied: [] };

  try {
    // 拿不到锁就说明有别的实例正在迁移；等它做完比两个实例并行改表安全
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    if ((lockRows as any[])[0]?.got !== 1) {
      throw new Error(
        `拿不到迁移锁（${LOCK_NAME}，等待 ${LOCK_TIMEOUT_SECONDS}s）：另一个实例正在改表结构。`
        + '若确认没有实例在跑，可能是历史连接异常退出留下的锁，重启 MySQL 连接即可释放。',
      );
    }

    try {
      await ensureSchemaTable(conn);
      const applied = await loadApplied(conn);
      const ordered = [...MIGRATIONS].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));

      // 先整体校验一遍已应用的迁移，别等跑到一半才发现历史被改过
      for (const m of ordered) {
        const record = applied.get(m.version);
        if (record && record.checksum !== checksumOf(m.sql) && !force) {
          throw new Error(
            `迁移 ${m.version}（${m.name}）的内容与已应用的记录不一致：`
            + `库里记的是 ${record.checksum.slice(0, 12)}…，现在是 ${checksumOf(m.sql).slice(0, 12)}…。`
            + '已应用的迁移不要改，追加一个新版本；确实要按新内容跑就带 --force。',
          );
        }
      }

      for (const m of ordered) {
        if (applied.has(m.version)) {
          result.alreadyApplied.push(m.version);
          continue;
        }

        const statements = splitStatements(m.sql);
        const startedAt = Date.now();
        for (let idx = 0; idx < statements.length; idx++) {
          try {
            await conn.query(statements[idx]);
          } catch (e: any) {
            throw new Error(
              `迁移 ${m.version} 第 ${idx + 1}/${statements.length} 条语句失败：${e.code || e.sqlState || ''} ${e.message}`
              + `\n  语句起始内容: ${statements[idx].slice(0, 120).replace(/\s+/g, ' ')}`,
            );
          }
        }

        const elapsed = Date.now() - startedAt;
        // 整个迁移成功后才登记：中途失败时下一次会重跑这个版本（所以迁移必须可重入）
        await conn.query(
          `INSERT INTO \`${SCHEMA_TABLE}\` (version, name, checksum, applied_at, execution_ms)
             VALUES (?, ?, ?, ?, ?)`,
          [m.version, m.name, checksumOf(m.sql), new Date(), elapsed],
        );
        result.applied.push(m.version);
        console.log(`[migrate] applied ${m.version} (${m.name}) ${statements.length} 条语句, ${elapsed}ms`);
      }
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => undefined);
    }
  } finally {
    conn.release();
  }

  return result;
}

/**
 * 服务端启动前的数据库就绪检查：探活 -> 迁移。
 * 失败直接抛错，由调用方决定退出；按既定策略不回落文件存储。
 */
export async function ensureDatabaseReady(): Promise<{ probe: DbProbeResult; migrate: MigrateResult }> {
  const probe = await probeDatabase();
  console.log(
    `[db] MySQL ${probe.version} | 库 ${probe.database} | 服务端时区 ${probe.serverTz}`
    + `（system ${probe.systemTz}）| max_connections=${probe.maxConnections}`,
  );
  const migrate = await runMigrations();
  if (!migrate.applied.length) {
    console.log(`[db] schema 已是最新（${migrate.alreadyApplied.length} 个迁移均已应用）`);
  }
  return { probe, migrate };
}

export { closePool };
