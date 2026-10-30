import { INIT_SQL } from './0001-init';
import { ACCOUNTS_SQL } from './0002-accounts';

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
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { version: '0001', name: 'init-schema', sql: INIT_SQL },
  { version: '0002', name: 'accounts-and-ownership', sql: ACCOUNTS_SQL },
];

/** 供 CLI 导出 .sql 文本 */
export function dumpMigrationSql(version: string): string {
  const found = MIGRATIONS.find((m) => m.version === version);
  if (!found) throw new Error(`没有版本 ${version} 的迁移（现有：${MIGRATIONS.map((m) => m.version).join(', ')}）`);
  return `-- AetherOps migration ${found.version} - ${found.name}\n${found.sql.trim()}\n`;
}
