/**
 * 方言转换层：把仓储里的 MySQL 写法翻译成 SQLite 能执行的形式。
 *
 * 为什么不在仓储里写两套 SQL：
 * 20 个 repo、上百条语句，双份维护必然漂移。这里只翻译「确实不同」的语法，
 * 其余（`?` 占位符、反引号标识符、`LIMIT ? OFFSET ?`、`COALESCE`、`CASE`、
 * 标量子查询）两种库写法一致，原样透传。
 *
 * 覆盖的差异点：
 * - `ON DUPLICATE KEY UPDATE` -> `ON CONFLICT (<主键>) DO UPDATE SET`，
 *   并把右值里的 `VALUES(col)` 换成 `excluded.col`
 *   （SQLite 的 conflict target 必须显式给出，所以主键从 PRAGMA 现取）。
 * - `GREATEST(a, b)` -> `MAX(a, b)`：SQLite 的多参 MAX 就是标量最大值函数，
 *   而 GREATEST 在 SQLite 里不存在。
 * - `INSERT IGNORE` -> `INSERT OR IGNORE`；`CAST(x AS UNSIGNED)` -> `CAST(x AS INTEGER)`。
 * - `DATE_FORMAT(x, fmt)`：SQLite 没有，注册成自定义函数（见 sqlite.ts），
 *   所以这里不需要改写。
 *
 * 时间：MySQL 侧驱动按 UTC 解释 DATETIME。SQLite 侧统一存
 * `YYYY-MM-DD HH:MM:SS.mmm`（UTC）的定宽字符串，读回时按严格正则还原成 Date，
 * 两侧对上层暴露的类型保持一致（都是 JS Date）。
 */

/** 驱动写库用的时间格式：固定宽度 + 空格分隔，字典序即时间序 */
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

export function formatDateTimeUtc(value: Date): string {
  const iso = value.toISOString(); // 2026-11-26T10:00:00.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`;
}

/**
 * 把库里的时间文本还原成 Date。
 * 只认「完整日期时间」；`audit_date` 这类纯日期列保持字符串 —— MySQL 侧它们
 * 本来也是按字符串用的（仓储里用 DATE_FORMAT 取，避免时区换算）。
 */
export function parseDateTimeText(text: string): Date | null {
  const m = DATETIME_RE.exec(text);
  if (!m) return null;
  const ms = Number((m[7] || '0').padEnd(3, '0').slice(0, 3));
  const date = new Date(Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), ms,
  ));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 参数值规范化：node:sqlite 只接受 null / number / bigint / string / Uint8Array。
 * - Date -> UTC 定宽字符串
 * - boolean -> 0/1（MySQL 侧也是 TINYINT）
 * - undefined -> null（`undefined` 直接绑定会抛 "Provided value cannot be bound"）
 * - 普通对象 -> JSON 字符串（仓储里本来就该自己 stringify，这里是兜底）
 */
export function toSqliteValue(value: any): any {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return formatDateTimeUtc(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 行对象规范化：node:sqlite 返回的是 null-prototype 对象，
 * 既不能直接用 `hasOwnProperty`，也可能让某些库（如 JSON 序列化前的判空逻辑）行为不同。
 * 顺手把时间字符串还原成 Date，与 mysql2（dateStrings:false）的行为对齐。
 */
export function normalizeSqliteRow<T = any>(row: any): T {
  const out: Record<string, any> = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value === 'string') {
      const parsed = parseDateTimeText(value);
      out[key] = parsed || value;
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** MySQL 的 DATE_FORMAT，够用的子集：%Y %y %m %c %d %e %H %k %i %s %S %f %% */
export function mysqlDateFormat(value: unknown, format: unknown): string | null {
  if (value === null || value === undefined) return null;
  const fmt = String(format ?? '');
  if (!fmt) return null;

  let y: number; let mo: number; let d: number; let h: number; let mi: number; let s: number; let ms: number;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    y = value.getUTCFullYear(); mo = value.getUTCMonth() + 1; d = value.getUTCDate();
    h = value.getUTCHours(); mi = value.getUTCMinutes(); s = value.getUTCSeconds(); ms = value.getUTCMilliseconds();
  } else if (typeof value === 'string') {
    // 纯日期（audit_date）也支持：时分秒按 0 处理
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const m = dateOnly ? null : DATETIME_RE.exec(value);
    if (dateOnly) {
      y = Number(dateOnly[1]); mo = Number(dateOnly[2]); d = Number(dateOnly[3]); h = 0; mi = 0; s = 0; ms = 0;
    } else if (m) {
      y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
      h = Number(m[4]); mi = Number(m[5]); s = Number(m[6]);
      ms = Number((m[7] || '0').padEnd(3, '0').slice(0, 3));
    } else {
      return null;
    }
  } else {
    return null;
  }

  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return fmt.replace(/%([A-Za-z%])/g, (whole, token: string) => {
    switch (token) {
      case 'Y': return String(y);
      case 'y': return pad(y % 100);
      case 'm': return pad(mo);
      case 'c': return String(mo);
      case 'd': return pad(d);
      case 'e': return String(d);
      case 'H': return pad(h);
      case 'k': return String(h);
      case 'i': return pad(mi);
      case 's': case 'S': return pad(s);
      case 'f': return pad(ms * 1000, 6);
      case '%': return '%';
      default: return whole;
    }
  });
}

/* ------------------------------------------------------------------ */
/* DML 翻译                                                            */
/* ------------------------------------------------------------------ */

const INSERT_TABLE_RE = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+`?([A-Za-z0-9_]+)`?/gi;

function findInsertTable(sql: string, before: number): string | null {
  INSERT_TABLE_RE.lastIndex = 0;
  let table: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = INSERT_TABLE_RE.exec(sql))) {
    if (m.index >= before) break;
    table = m[1];
  }
  return table;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 把一条 MySQL DML 翻译成 SQLite。
 * @param resolvePrimaryKey 给表名返回主键列（按 PRIMARY KEY 里的顺序）
 */
export function translateSqlForSqlite(sql: string, resolvePrimaryKey: (table: string) => string[]): string {
  let out = sql;

  out = out.replace(/\bINSERT\s+IGNORE\s+INTO\b/gi, 'INSERT OR IGNORE INTO');
  // GREATEST 不存在；SQLite 的多参 MAX 就是标量最大
  out = out.replace(/\bGREATEST\s*\(/gi, 'MAX(');
  out = out.replace(/\bCAST\s*\(([^()]*?)\bAS\s+UNSIGNED\s*\)/gi, 'CAST($1 AS INTEGER)');

  const dup = /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.exec(out);
  if (!dup) return out;

  const table = findInsertTable(out, dup.index);
  const pk = table ? resolvePrimaryKey(table) : [];
  if (!pk.length) {
    throw new Error(
      `[sqlite] 无法翻译 ON DUPLICATE KEY UPDATE：解析不到表 ${table || '(未知)'} 的主键。`
      + '该语句需要改写或补充 schema。',
    );
  }

  const assignments = out.slice(dup.index + dup[0].length);
  // 右值里的 VALUES(col) 是 MySQL 的「新值」，SQLite 对应 excluded.col。
  // 左值保持裸列名（SQLite 的 SET 不允许限定名），仓储里的写法本来就是裸名。
  const translated = assignments.replace(/\bVALUES\s*\(\s*(`?[A-Za-z0-9_]+`?)\s*\)/gi, (_m, col: string) => `excluded.${col.replace(/`/g, '')}`);

  return `${out.slice(0, dup.index)}ON CONFLICT (${pk.map(quoteIdent).join(', ')}) DO UPDATE SET${translated}`;
}

/* ------------------------------------------------------------------ */
/* DDL 翻译（兜底）                                                     */
/* ------------------------------------------------------------------ */

const UNSUPPORTED_HINT = '该迁移使用了 SQLite 无法自动转换的 MySQL DDL（information_schema / PREPARE / 多列 ALTER / FULLTEXT 等），'
  + '请在这条迁移里提供 sqliteSql 字段（见 server/db/migrations/index.ts）。';

/** 按括号深度切分顶层逗号（列定义里 `DECIMAL(10,2)`、`CHECK (a IN ('x','y'))` 都含逗号） */
function splitTopLevel(input: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** 去掉字符串字面量之外的注释，保留内容原样（DDL 翻译前先瘦身） */
export function stripSqlComments(sql: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote) {
      out += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '-' && next === '-' && (sql[i + 2] === ' ' || sql[i + 2] === '\t' || sql[i + 2] === '\n' || sql[i + 2] === undefined)) {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

const TYPE_PATTERNS: Array<[RegExp, string]> = [
  // 自增整数单独处理（放在最前面，避免被下面的 INTEGER 规则吃掉 AUTO_INCREMENT）
  [/^(?:BIGINT|INT|INTEGER|MEDIUMINT|SMALLINT|TINYINT)\s*(?:\(\s*\d+\s*\))?\s*UNSIGNED\s+AUTO_INCREMENT$/i, 'INTEGER AUTOINCREMENT'],
  [/^(?:BIGINT|INT|INTEGER|MEDIUMINT|SMALLINT|TINYINT)\s*(?:\(\s*\d+\s*\))?\s*(?:UNSIGNED)?\s*(?:AUTO_INCREMENT)?$/i, 'INTEGER'],
  [/^(?:DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)\s*(?:\([^)]*\))?\s*(?:UNSIGNED)?$/i, 'REAL'],
  [/^(?:DATETIME|DATE|TIMESTAMP|TIME)\s*(?:\(\s*\d+\s*\))?$/i, 'TEXT'],
  [/^(?:LONGTEXT|MEDIUMTEXT|TINYTEXT|TEXT|JSON|ENUM|SET)(?:\s*\([^)]*\))?$/i, 'TEXT'],
  [/^(?:BIGINT|INT|INTEGER|MEDIUMINT|SMALLINT|TINYINT)\s*(?:\(\s*\d+\s*\))?\s*UNSIGNED$/i, 'INTEGER'],
  [/^(?:LONG)?(?:VAR)?CHAR(?:\s*\(\s*\d+\s*\))?$/i, 'TEXT'],
  [/^(?:BINARY|VARBINARY|BLOB|LONGBLOB|MEDIUMBLOB)$/i, 'BLOB'],
];

function mapType(rawType: string): string {
  const cleaned = rawType.trim().replace(/\s+/g, ' ');
  for (const [pattern, mapped] of TYPE_PATTERNS) {
    if (pattern.test(cleaned)) return mapped;
  }
  throw new Error(`[sqlite] 无法转换的列类型「${rawType.trim()}」。${UNSUPPORTED_HINT}`);
}

function stripMysqlNoise(def: string): string {
  return def
    .replace(/\s+COMMENT\s+(?:'[^']*'|"[^"]*")/gi, '')
    .replace(/\s+DEFAULT\s+CURRENT_TIMESTAMP(?:\(\s*\d*\s*\))?/gi, '')
    .replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(?:\(\s*\d*\s*\))?/gi, '')
    .replace(/\s+CHARACTER\s+SET\s+\w+/gi, '')
    .replace(/\s+COLLATE\s+(?!NOCASE\b)\w+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TranslatedTable {
  createSql: string;
  indexSql: string[];
}

function translateCreateTable(stmt: string): TranslatedTable {
  const open = stmt.indexOf('(');
  // 从右往左找最后一个 ')'：ENGINE=... COMMENT='...' 尾巴里可能有括号
  const close = stmt.lastIndexOf(')');
  if (open < 0 || close < open) throw new Error(`[sqlite] CREATE TABLE 结构无法解析。${UNSUPPORTED_HINT}`);

  const header = stmt.slice(0, open).replace(/\s+/g, ' ').trim();
  const body = stmt.slice(open + 1, close);
  const tableMatch = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?/i.exec(header);
  if (!tableMatch) throw new Error(`[sqlite] 解析不到表名。${UNSUPPORTED_HINT}`);
  const table = tableMatch[1];

  const columns: string[] = [];
  const tableConstraints: string[] = [];
  const indexes: string[] = [];
  let autoColumn: string | null = null;
  let primaryKey: string[] = [];

  for (const rawItem of splitTopLevel(body)) {
    const item = rawItem.trim();
    if (!item) continue;

    const pkMatch = /^(?:CONSTRAINT\s+`?\w+`?\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)$/i.exec(item);
    if (pkMatch) {
      primaryKey = pkMatch[1].split(',').map((c) => c.trim().replace(/`/g, ''));
      continue;
    }
    const uniqueKey = /^(?:CONSTRAINT\s+`?\w+`?\s+)?UNIQUE\s+(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)$/i.exec(item);
    if (uniqueKey) {
      indexes.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueKey[1]} ON ${table} (${uniqueKey[2]});`);
      continue;
    }
    const plainKey = /^(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)$/i.exec(item);
    if (plainKey) {
      indexes.push(`CREATE INDEX IF NOT EXISTS ${plainKey[1]} ON ${table} (${plainKey[2]});`);
      continue;
    }
    const check = /^CONSTRAINT\s+`?\w+`?\s+(CHECK\s*\(.*\))$/is.exec(item);
    if (check) {
      tableConstraints.push(check[1]);
      continue;
    }
    if (/^CONSTRAINT\s+\w+\s+FOREIGN\s+KEY/i.test(item) || /^FOREIGN\s+KEY/i.test(item)) {
      // 0001 的约定是「不建外键」，翻译时直接丢弃，不阻塞 lite 部署
      continue;
    }
    if (/^FULLTEXT\b/i.test(item)) throw new Error(`[sqlite] FULLTEXT 索引无法转换。${UNSUPPORTED_HINT}`);

    // 普通列定义：<name> <type> [constraints]
    const colMatch = /^`?([A-Za-z0-9_]+)`?\s+([A-Za-z]+(?:\s*\([^)]*\))?(?:\s+UNSIGNED)?)([\s\S]*)$/i.exec(item);
    if (!colMatch) throw new Error(`[sqlite] 无法解析列定义「${item.slice(0, 60)}」。${UNSUPPORTED_HINT}`);
    const [, name, typeRaw, restRaw] = colMatch;
    let rest = stripMysqlNoise(restRaw || '');
    const mapped = mapType(typeRaw);
    if (/AUTO_INCREMENT/i.test(stripMysqlNoise(typeRaw)) || /AUTO_INCREMENT/i.test(rest) || mapped === 'INTEGER AUTOINCREMENT') {
      autoColumn = name;
      rest = rest.replace(/AUTO_INCREMENT/gi, '').replace(/\s+/g, ' ').trim();
    }
    const restSql = rest ? ` ${rest}` : '';
    columns.push(`  ${name} ${mapped === 'INTEGER AUTOINCREMENT' ? 'INTEGER' : mapped}${restSql}`);
  }

  if (autoColumn && primaryKey.length === 1 && primaryKey[0] === autoColumn) {
    // SQLite 的自增只有一种写法：INTEGER PRIMARY KEY AUTOINCREMENT（必须内联）
    const idx = columns.findIndex((c) => c.trim().startsWith(`${autoColumn} `));
    columns[idx] = `  ${autoColumn} INTEGER PRIMARY KEY AUTOINCREMENT`;
  } else if (primaryKey.length) {
    columns.push(`  PRIMARY KEY (${primaryKey.join(', ')})`);
  }
  columns.push(...tableConstraints.map((c) => `  ${c}`));

  return {
    createSql: `CREATE TABLE IF NOT EXISTS ${table} (\n${columns.join(',\n')}\n);`,
    indexSql: indexes,
  };
}

/**
 * 迁移 DDL 的兜底翻译。只处理简单形态：
 * - `CREATE TABLE`（去 COMMENT/ENGINE/CHARSET，映射类型，内联 KEY 拆成独立 CREATE INDEX）
 * - `CREATE (UNIQUE) INDEX`
 * - 单列 `ALTER TABLE ... ADD COLUMN`
 * - 普通 DML（再走一遍 DML 翻译）
 * 其余一律抛错，提示作者改用迁移里的 `sqliteSql` 字段 —— 猜错了报「语法错误」比
 * 明确要求补一句 SQL 难查得多。
 */
export function translateDdlForSqlite(sql: string, resolvePrimaryKey: (table: string) => string[]): string {
  const cleaned = stripSqlComments(sql);
  const statements = cleaned
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];

  for (const stmt of statements) {
    if (/\binformation_schema\b|\bPREPARE\b|\bDEALLOCATE\b|\bPARTITION\s+BY\b/i.test(stmt)) {
      throw new Error(`[sqlite] ${UNSUPPORTED_HINT}`);
    }
    if (/^CREATE\s+TABLE/i.test(stmt)) {
      const translated = translateCreateTable(stmt);
      out.push(translated.createSql, ...translated.indexSql);
      continue;
    }
    if (/^CREATE\s+(UNIQUE\s+)?INDEX/i.test(stmt)) {
      out.push(stmt.replace(/\s+USING\s+\w+/i, ''));
      continue;
    }
    if (/^ALTER\s+TABLE/i.test(stmt)) {
      if (/\b(DROP|MODIFY|CHANGE|RENAME)\b|\bADD\s+(?:UNIQUE\s+)?(?:KEY|INDEX|CONSTRAINT|PRIMARY)\b|\bADD\s+COLUMN\s*\(/i.test(stmt)) {
        throw new Error(`[sqlite] 复杂 ALTER TABLE 无法转换。${UNSUPPORTED_HINT}`);
      }
      const parts = splitTopLevel(stmt, ',');
      if (parts.length > 1) throw new Error(`[sqlite] 一条 ALTER 里含多个动作，无法转换。${UNSUPPORTED_HINT}`);
      out.push(stmt.replace(/\s+AFTER\s+`?\w+`?/gi, '').replace(/\s+COMMENT\s+(?:'[^']*'|"[^"]*")/gi, ''));
      continue;
    }
    if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stmt)) {
      out.push(translateSqlForSqlite(stmt, resolvePrimaryKey));
      continue;
    }
    throw new Error(`[sqlite] 无法转换的语句：${stmt.slice(0, 80)}…。${UNSUPPORTED_HINT}`);
  }

  return out.join(';\n');
}
