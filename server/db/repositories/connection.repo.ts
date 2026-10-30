/**
 * 连接配置仓储：SSH / 本地终端连接在 MySQL 里的读写。
 *
 * 分工：本模块只负责「实体 <-> 列」的形状转换与 SQL，
 * 敏感字段的加解密留在 ConnectionService（它持有 connections.key）。
 * 也就是说传进来/读出去的 password / privateKey / passphrase 字段里放的是
 * 已加密的 enc:v1: 密文，本模块不关心明文。
 *
 * 默认值补全也在这里做：前端提交的是裸 JSON，缺字段时不该把 NULL 塞进
 * NOT NULL 列（STRICT 模式会直接报错），统一按实体默认值兜底。
 */
import { execute, query, queryOne } from '../pool';
import type { ConnectionEntity } from '../../model/connection.entity';

const COLUMNS = [
  'id', 'name', 'type', 'host', 'port', 'username', 'auth_type',
  'password_enc', 'private_key_enc', 'passphrase_enc',
  'shell', 'startup_script', 'forward_agent',
  'term_cols', 'term_rows', 'term_font_size', 'term_font_family', 'term_theme', 'term_cursor_style',
  'options', 'enabled', 'created_at', 'updated_at',
];

const SELECT_SQL = `SELECT ${COLUMNS.map((c) => '`' + c + '`').join(', ')} FROM connections`;

/** 数据库行 -> 实体。密文字段原样放进同名属性，由上层解密 */
function toEntity(row: any): ConnectionEntity {
  let options: Record<string, any> = {};
  if (row.options) {
    try {
      options = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
    } catch {
      console.warn(`[ConnectionRepo] options 不是合法 JSON，按空对象处理: id=${row.id}`);
      options = {};
    }
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    host: row.host,
    port: Number(row.port),
    username: row.username,
    authType: row.auth_type,
    password: row.password_enc ?? undefined,
    privateKey: row.private_key_enc ?? undefined,
    passphrase: row.passphrase_enc ?? undefined,
    shell: row.shell || undefined,
    startupScript: row.startup_script ?? undefined,
    forwardAgent: !!row.forward_agent,
    terminal: {
      cols: Number(row.term_cols),
      rows: Number(row.term_rows),
      fontSize: Number(row.term_font_size),
      fontFamily: row.term_font_family,
      theme: row.term_theme,
      cursorStyle: row.term_cursor_style,
    },
    options,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 实体 -> 列参数（顺序与 COLUMNS 一致，供 INSERT） */
function toRow(c: ConnectionEntity, isInsert: boolean): any[] {
  const term = c.terminal || ({} as any);
  const cursor = term.cursorStyle === 'underline' || term.cursorStyle === 'bar' ? term.cursorStyle : 'block';
  const now = new Date();
  return [
    c.id,
    c.name,
    c.type === 'local' ? 'local' : 'ssh',
    c.host || '',
    Number.isInteger(c.port) && c.port > 0 ? c.port : 22,
    c.username || '',
    c.authType === 'password' || c.authType === 'privateKey' ? c.authType : 'auto',
    c.password || null,
    c.privateKey || null,
    c.passphrase || null,
    c.shell || '',
    c.startupScript || null,
    c.forwardAgent ? 1 : 0,
    Number(term.cols) || 80,
    Number(term.rows) || 24,
    Number(term.fontSize) || 14,
    term.fontFamily || 'Menlo, Monaco, "Courier New", monospace',
    term.theme || 'dark',
    cursor,
    JSON.stringify(c.options || {}),
    c.enabled === false ? 0 : 1,
    isInsert ? (c.createdAt || now) : now,
    now,
  ];
}

export async function listConnections(ownerId: string): Promise<ConnectionEntity[]> {
  const rows = await query<any>(`${SELECT_SQL} WHERE owner_id = ? ORDER BY updated_at DESC, id ASC`, [ownerId]);
  return rows.map(toEntity);
}

export async function getConnectionById(ownerId: string, id: string): Promise<ConnectionEntity | null> {
  const row = await queryOne<any>(`${SELECT_SQL} WHERE owner_id = ? AND id = ?`, [ownerId, id]);
  return row ? toEntity(row) : null;
}

export async function insertConnection(ownerId: string, c: ConnectionEntity): Promise<void> {
  await execute(
    `INSERT INTO connections (owner_id, ${COLUMNS.map((col) => '`' + col + '`').join(', ')})
     VALUES (?, ${COLUMNS.map(() => '?').join(', ')})`,
    [ownerId, ...toRow(c, true)],
  );
}

/** 整行覆盖更新：调用方已经把「不覆盖空密码」等合并逻辑做完，这里不做局部 SET */
export async function replaceConnection(ownerId: string, c: ConnectionEntity): Promise<void> {
  const values = toRow(c, false);
  // 列与参数必须同源取一次：分别 filter 两次很容易把 created_at 的对齐搞错
  const settable = COLUMNS
    .map((col, i) => ({ col, value: values[i] }))
    .filter(({ col }) => col !== 'id' && col !== 'created_at');
  await execute(
    `UPDATE connections SET ${settable.map(({ col }) => '`' + col + '` = ?').join(', ')} WHERE owner_id = ? AND id = ?`,
    [...settable.map(({ value }) => value), ownerId, c.id],
  );
}

export async function deleteConnectionRow(ownerId: string, id: string): Promise<number> {
  const r = await execute('DELETE FROM connections WHERE owner_id = ? AND id = ?', [ownerId, id]);
  return r.affectedRows;
}

/**
 * 名称是否已被占用。
 * 原实现是「读整个文件后在内存里判重」，落表后直接用带条件的 COUNT。
 * 判重范围限本账号：不同账号可以有同名连接。
 */
export async function isConnectionNameTaken(ownerId: string, name: string, exceptId?: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    exceptId
      ? 'SELECT COUNT(*) AS n FROM connections WHERE owner_id = ? AND name = ? AND id <> ?'
      : 'SELECT COUNT(*) AS n FROM connections WHERE owner_id = ? AND name = ?',
    exceptId ? [ownerId, name, exceptId] : [ownerId, name],
  );
  return !!row && Number(row.n) > 0;
}
