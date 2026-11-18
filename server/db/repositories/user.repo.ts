import { getPool } from '../pool';
import {
  PERMISSION_COLUMNS,
  PERMISSION_KEYS,
  type PermissionKey,
  type UserPermissions,
  type UserRecord,
  type UserRole,
  type UserStatus,
} from '../../model/user.entity';

/** 查询列固定写出，避免 SELECT * 以后加列把口令哈希带到不需要它的地方 */
const COLUMNS = `id, username, display_name, password_hash, role, status,
  can_use_terminal, can_use_batch, can_use_ai, can_manage_connections, can_configure_ai, can_use_files,
  can_view_monitor, can_view_audit, can_manage_skills, can_manage_snippets,
  created_at, updated_at, last_login_at, last_login_ip`;

function rowToUser(r: any): UserRecord {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    passwordHash: r.password_hash,
    role: r.role as UserRole,
    status: r.status as UserStatus,
    permissions: {
      terminal: !!r.can_use_terminal,
      batch: !!r.can_use_batch,
      ai: !!r.can_use_ai,
      connections: !!r.can_manage_connections,
      aiConfig: !!r.can_configure_ai,
      files: !!r.can_use_files,
      monitor: !!r.can_view_monitor,
      audit: !!r.can_view_audit,
      skills: !!r.can_manage_skills,
      snippets: !!r.can_manage_snippets,
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastLoginAt: r.last_login_at || null,
    lastLoginIp: r.last_login_ip || '',
  };
}

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const [rows] = await getPool().query(`SELECT ${COLUMNS} FROM users WHERE username = ? LIMIT 1`, [username]);
  const row = (rows as any[])[0];
  return row ? rowToUser(row) : null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const [rows] = await getPool().query(`SELECT ${COLUMNS} FROM users WHERE id = ? LIMIT 1`, [id]);
  const row = (rows as any[])[0];
  return row ? rowToUser(row) : null;
}

export async function listUsers(): Promise<UserRecord[]> {
  const [rows] = await getPool().query(`SELECT ${COLUMNS} FROM users ORDER BY created_at ASC`);
  return (rows as any[]).map(rowToUser);
}

/**
 * 成员简表：告警指派 / 值班表只需要「谁能被指派」。
 * 刻意不返回 role / permissions / 最近登录：有 monitor 权限的人能看到这份名单，
 * 但没有任何理由顺带看到别人的权限位与登录痕迹。
 */
export interface MemberBrief {
  id: string;
  username: string;
  displayName: string;
}

export async function listActiveMembers(): Promise<MemberBrief[]> {
  const [rows] = await getPool().query(
    "SELECT id, username, display_name FROM users WHERE status = 'active' ORDER BY username ASC",
  );
  return (rows as any[]).map((r) => ({
    id: String(r.id),
    username: String(r.username),
    displayName: String(r.display_name || r.username),
  }));
}

export async function countUsers(): Promise<number> {
  const [rows] = await getPool().query('SELECT COUNT(*) AS n FROM users');
  return Number((rows as any[])[0]?.n || 0);
}

/** 只剩一个管理员时不允许降级/删除/禁用，否则没人能再管账号 */
export async function countActiveAdmins(excludeId?: string): Promise<number> {
  const [rows] = await getPool().query(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status <> 'disabled'${excludeId ? ' AND id <> ?' : ''}`,
    excludeId ? [excludeId] : [],
  );
  return Number((rows as any[])[0]?.n || 0);
}

export async function insertUser(user: UserRecord): Promise<void> {
  const cols = ['id', 'username', 'display_name', 'password_hash', 'role', 'status'];
  const values: any[] = [user.id, user.username, user.displayName, user.passwordHash, user.role, user.status];
  for (const key of PERMISSION_KEYS) {
    cols.push(PERMISSION_COLUMNS[key]);
    values.push(user.permissions[key] ? 1 : 0);
  }
  cols.push('created_at', 'updated_at', 'last_login_at', 'last_login_ip');
  values.push(user.createdAt, user.updatedAt, user.lastLoginAt, user.lastLoginIp);

  await getPool().query(
    `INSERT INTO users (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    values,
  );
}

export interface UserUpdate {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  passwordHash?: string;
  permissions?: Partial<UserPermissions>;
}

export async function updateUser(id: string, patch: UserUpdate): Promise<void> {
  const sets: string[] = [];
  const values: any[] = [];

  if (patch.displayName !== undefined) { sets.push('display_name = ?'); values.push(patch.displayName); }
  if (patch.role !== undefined) { sets.push('role = ?'); values.push(patch.role); }
  if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
  if (patch.passwordHash !== undefined) { sets.push('password_hash = ?'); values.push(patch.passwordHash); }
  if (patch.permissions) {
    for (const key of PERMISSION_KEYS) {
      const value = patch.permissions[key];
      if (value === undefined) continue;
      // 列名只能来自白名单常量
      sets.push(`${PERMISSION_COLUMNS[key as PermissionKey]} = ?`);
      values.push(value ? 1 : 0);
    }
  }
  if (!sets.length) return;

  sets.push('updated_at = ?');
  values.push(new Date(), id);
  await getPool().query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, values);
}

export async function touchLogin(id: string, ip: string): Promise<void> {
  await getPool().query('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?', [new Date(), ip, id]);
}

export async function deleteUserRow(id: string): Promise<number> {
  const [result] = await getPool().query('DELETE FROM users WHERE id = ?', [id]);
  return (result as any).affectedRows || 0;
}

/**
 * 删除账号时连带清掉它名下的全部业务数据。
 * 不建外键（0001 的约定），所以必须在这里显式做，顺序按「子表在前」。
 */
export async function purgeOwnerData(ownerId: string): Promise<void> {
  const pool = getPool();
  // 子表在前：alerts 挂在 incidents 上，先删告警再删事件。
  // host_metrics_minute / error_fingerprints / alerts / alert_mutes / incidents / alert_oncall
  // 都是 P4–P6 新增的按账号数据，漏一张就会在删号后留下孤儿行（凭 id 还能被别处读到）。
  const tables = [
    'ai_messages', 'ai_history', 'audit_events', 'snippets', 'skills', 'sessions', 'ai_config',
    'host_metrics_minute', 'error_fingerprints', 'alerts', 'alert_mutes', 'incidents', 'alert_oncall',
    'connections',
  ];
  for (const table of tables) {
    await pool.query(`DELETE FROM ${table} WHERE owner_id = ?`, [ownerId]);
  }
}
