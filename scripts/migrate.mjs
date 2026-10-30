#!/usr/bin/env node
/**
 * 显式迁移入口：给 CI、运维手工执行、以及「先建表再起服务」的场景用。
 * 服务端启动时会自动跑同一套迁移（server.js -> ensureDatabaseReady），两者互不冲突。
 *
 * 用法：
 *   node scripts/migrate.mjs              应用所有未执行的迁移
 *   node scripts/migrate.mjs --status     只看已应用版本与待执行数量
 *   node scripts/migrate.mjs --force      忽略已应用迁移的校验和不一致
 *   node scripts/migrate.mjs --dump 0001  把某个迁移导出成纯 .sql 给 DBA
 */
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const { MIGRATIONS, dumpMigrationSql } = require('../dist/server/db/migrations/index.js');
const { runMigrations, getAppliedVersions, checksumOf } = require('../dist/server/db/migrate.js');
const { closePool, probeDatabase } = require('../dist/server/db/pool.js');
const { loadConfig, describeDatabase } = require('../dist/server/utils/config.js');

if (has('--dump')) {
  const version = valueOf('--dump') || MIGRATIONS[MIGRATIONS.length - 1].version;
  process.stdout.write(dumpMigrationSql(version));
  process.exit(0);
}

if (!has('--help')) {
  console.log(`[migrate] target -> ${describeDatabase(loadConfig().database)}`);
}

try {
  if (has('--status')) {
    const applied = await getAppliedVersions();
    const appliedVersions = new Set(applied.map((r) => r.version));
    for (const r of applied) {
      const drift = MIGRATIONS.some((m) => m.version === r.version && checksumOf(m.sql) !== r.checksum);
      console.log(`  ${r.version}  ${r.name}  applied_at=${r.applied_at}  ${drift ? '⚠ 正文与记录不一致' : 'ok'}`);
    }
    const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version));
    console.log(`[migrate] 已应用 ${applied.length}，待执行 ${pending.length}${pending.length ? '（' + pending.map((m) => m.version).join(', ') + '）' : ''}`);
    process.exit(0);
  }

  const probe = await probeDatabase();
  console.log(`[migrate] MySQL ${probe.version} | 库 ${probe.database} | 服务端时区 ${probe.serverTz}（system ${probe.systemTz}）`);
  const result = await runMigrations(has('--force'));
  if (result.applied.length) {
    console.log(`[migrate] 本次应用: ${result.applied.join(', ')}`);
  } else {
    console.log('[migrate] 没有待执行的迁移，schema 已是最新');
  }
} catch (err) {
  console.error(`[migrate] FAIL: ${err && err.message ? err.message : String(err)}`);
  await closePool().catch(() => undefined);
  process.exit(1);
}

await closePool();
process.exit(0);
