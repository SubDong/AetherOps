/**
 * 账号模型。
 *
 * 角色与权限是两件事：
 * - role=admin 决定「能不能管别人的账号」（建号 / 禁用 / 授权 / 重置密码）；
 * - 权限位决定「这个账号自己能用哪些功能」。
 * 管理员默认看不到别人的连接、会话、AI 配置与审计——隔离不因角色破例，
 * 需要看别人数据只能走数据库，这是刻意的。
 */

export type UserRole = 'admin' | 'user';
export type UserStatus = 'pending' | 'active' | 'disabled';

/** 功能权限；键名就是前端与 API 里用的名字 */
export interface UserPermissions {
  /** 终端：SSH / 本地 Shell */
  terminal: boolean;
  /** AI 对话与 Agent */
  ai: boolean;
  /** 自行增删改连接 */
  connections: boolean;
  /** 配置自己的 AI 模型与 Key */
  aiConfig: boolean;
  /** SFTP 文件管理与传输 */
  files: boolean;
  /** 日志监控 */
  monitor: boolean;
  /** 查看自己的审计 */
  audit: boolean;
  /** 自定义技能 */
  skills: boolean;
  /** 命令片段 */
  snippets: boolean;
}

export type PermissionKey = keyof UserPermissions;

/**
 * 权限 → 列名白名单。
 * 拼 SQL 时只允许出现在这里的列名，不接受任何外部输入，
 * 否则「更新权限」接口会变成一个可以改 role/status 的注入点。
 */
export const PERMISSION_COLUMNS: Record<PermissionKey, string> = {
  terminal: 'can_use_terminal',
  ai: 'can_use_ai',
  connections: 'can_manage_connections',
  aiConfig: 'can_configure_ai',
  files: 'can_use_files',
  monitor: 'can_view_monitor',
  audit: 'can_view_audit',
  skills: 'can_manage_skills',
  snippets: 'can_manage_snippets',
};

export const PERMISSION_KEYS = Object.keys(PERMISSION_COLUMNS) as PermissionKey[];

/** 全开 / 全关，用于初始化管理员与新建账号 */
export function emptyPermissions(): UserPermissions {
  return {
    terminal: false,
    ai: false,
    connections: false,
    aiConfig: false,
    files: false,
    monitor: false,
    audit: false,
    skills: false,
    snippets: false,
  };
}

export function fullPermissions(): UserPermissions {
  return {
    terminal: true,
    ai: true,
    connections: true,
    aiConfig: true,
    files: true,
    monitor: true,
    audit: true,
    skills: true,
    snippets: true,
  };
}

/** 库里的完整记录（含口令哈希，绝不外抛） */
export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  permissions: UserPermissions;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  lastLoginIp: string;
}

/** 对外视图：去掉 passwordHash */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  permissions: UserPermissions;
  createdAt: string;
  lastLoginAt: string | null;
  lastLoginIp: string;
}

export function toPublicUser(u: UserRecord): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    permissions: u.permissions,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    lastLoginIp: u.lastLoginIp,
  };
}
