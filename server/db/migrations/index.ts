import { INIT_SQL } from './0001-init';
import { ACCOUNTS_SQL } from './0002-accounts';
import { MULTI_AI_SQL } from './0003-multi-ai';
import { COST_CONTROL_SQL } from './0004-cost-control';
import { BATCH_PERMISSION_SQL } from './0005-batch-permission';
import { SYSTEM_CONFIG_SQL } from './0006-system-config';
import { HOST_METRICS_SQL } from './0007-host-metrics';
import { CONNECTION_SAMPLING_SQL } from './0008-connection-sampling';
import { ERROR_FINGERPRINTS_SQL } from './0009-error-fingerprints';
import { ALERTS_SQL } from './0010-alerts';
import { COLLABORATION_SQL } from './0011-collaboration';
import { WATCH_TOKENS_SQL } from './0012-watch-tokens';
import { AUTH_SESSIONS_SQL, AUTH_SESSIONS_SQLITE_SQL } from './0013-auth-sessions';

/**
 * 迁移清单。
 *
 * 为什么 SQL 写在 .ts 里而不是 .sql 文件：
 * VSCode 宿主的 server.js 由 esbuild 打成单文件、Electron 走 asar 归档，
 * 运行时用 fs 读 .sql 在两种打包形态下都得额外把文件带上并猜对路径；
 * 模板字符串跟着 JS 一起编译/内联，四种宿主（Web / Docker / Electron / VSCode）
 * 拿到的都是同一份内容。需要给 DBA 看纯 SQL 时用 dumpMigrationSql() 导出即可。
 *
 * 规则：
 * - version 必须单调可排序（0001、0002……），一次只做一件事；
 * - 已合并进 master 的迁移内容不许再改（迁移器会比对 sha256，改了会拒绝启动）；
 *   要修就追加一个新迁移。
 */
export interface Migration {
  version: string;
  name: string;
  /** MySQL 正文；企业级后端与 `--dump` 导出用它 */
  sql: string;
  /**
   * SQLite 专用正文（lite 模式）。
   *
   * 日常 DML/DDL 能由 dialect.ts 自动翻译，但 MySQL 的 information_schema 探测、
   * PREPARE 动态 DDL、多列 ALTER、FULLTEXT 这些在 SQLite 上没有等价写法，
   * 一旦出现在新迁移里就必须在这里补一份 SQLite 版本（否则 lite 启动会报错并指明本条迁移）。
   * 可选：不填时走通用翻译器。
   */
  sqliteSql?: string;
}

export const MIGRATIONS: Migration[] = [
  { version: '0001', name: 'init-schema', sql: INIT_SQL },
  { version: '0002', name: 'accounts-and-ownership', sql: ACCOUNTS_SQL },
  { version: '0003', name: 'multi-ai-profiles-and-chats', sql: MULTI_AI_SQL },
  { version: '0004', name: 'ai-cost-control', sql: COST_CONTROL_SQL },
  { version: '0005', name: 'batch-permission', sql: BATCH_PERMISSION_SQL },
  { version: '0006', name: 'system-config', sql: SYSTEM_CONFIG_SQL },
  { version: '0007', name: 'host-metrics', sql: HOST_METRICS_SQL },
  { version: '0008', name: 'connection-sampling', sql: CONNECTION_SAMPLING_SQL },
  { version: '0009', name: 'error-fingerprints', sql: ERROR_FINGERPRINTS_SQL },
  { version: '0010', name: 'alerts', sql: ALERTS_SQL },
  { version: '0011', name: 'collaboration', sql: COLLABORATION_SQL },
  { version: '0012', name: 'watch-tokens', sql: WATCH_TOKENS_SQL },
  { version: '0013', name: 'auth-sessions', sql: AUTH_SESSIONS_SQL, sqliteSql: AUTH_SESSIONS_SQLITE_SQL },
];

/** 供 CLI 导出 .sql 文本 */
export function dumpMigrationSql(version: string): string {
  const found = MIGRATIONS.find((m) => m.version === version);
  if (!found) throw new Error(`没有版本 ${version} 的迁移（现有：${MIGRATIONS.map((m) => m.version).join(', ')}）`);
  return `-- AetherOps migration ${found.version} - ${found.name}\n${found.sql.trim()}\n`;
}
