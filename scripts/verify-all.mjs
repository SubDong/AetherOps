/**
 * 全量验证入口：按顺序跑 scripts/verify-*.mjs，任一套失败即非零退出。
 *
 * 用法：
 *   node scripts/verify-all.mjs             # 全部（先跑不需要数据库的，再跑需要 MySQL 的）
 *   node scripts/verify-all.mjs --offline   # 只跑不需要数据库的那几套（本机没起 MySQL 时用）
 *   node scripts/verify-all.mjs --list      # 列出套件以及是否依赖数据库
 *   node scripts/verify-all.mjs p4 p6       # 只跑指定套件（写后段即可，p6 = verify-p6-collab）
 *
 * 前置：先 pnpm build-server —— 每个套件都 require('../dist/server/**')，跑的是编译产物而不是源码。
 * 需要数据库的套件自己跑迁移，用随机 owner 前缀写入测试行并在 finally 里清理。
 *
 * CI 用的是同一份清单（.github/workflows/verify.yml），本地与流水线不会跑出两套结论。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

/**
 * 清单顺序就是执行顺序：先跑纯内存的（几秒出结果），再跑落库的（要迁移、要连 MySQL）。
 * `db: true` 的套件之前会先确保 schema 到位 —— search_audit 那套不自己跑迁移。
 */
const SUITES = [
  { id: 'p1-tools', file: 'verify-p1-tools.mjs', db: false, note: 'P1 第二片：三个工具' },
  { id: 'p2-approval', file: 'verify-p2-approval.mjs', db: false, note: 'P2：审批分级' },
  { id: 'p3-skills', file: 'verify-p3-skills.mjs', db: false, note: 'P3：技能渐进加载' },
  { id: 'search-audit', file: 'verify-search-audit.mjs', db: true, note: 'P1 第一片：search_audit' },
  { id: 'p4-fingerprints', file: 'verify-p4-fingerprints.mjs', db: true, note: 'P4：错误指纹' },
  { id: 'p5-alerts', file: 'verify-p5-alerts.mjs', db: true, note: 'P5：告警实体化' },
  { id: 'p6-collab', file: 'verify-p6-collab.mjs', db: true, note: 'P6：协同 + 复用' },
];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const wanted = argv.filter((a) => !a.startsWith('-'));

if (flags.has('--list')) {
  for (const s of SUITES) {
    console.log(`${s.id.padEnd(16)} ${s.db ? 'db ' : 'mem'}  ${s.file.padEnd(28)} ${s.note}`);
  }
  process.exit(0);
}

const offline = flags.has('--offline');
let selected = offline ? SUITES.filter((s) => !s.db) : SUITES;
if (wanted.length > 0) {
  // 允许写 p6 / verify-p6-collab / p6-collab：名字里包含即可，拼错要报错而不是静默跑空
  selected = selected.filter((s) => wanted.some((w) => s.id.includes(w) || s.file.includes(w)));
  const missing = wanted.filter((w) => !SUITES.some((s) => s.id.includes(w) || s.file.includes(w)));
  if (missing.length > 0) {
    console.error(`未知套件: ${missing.join(', ')}（--list 看可用名字）`);
    process.exit(2);
  }
  if (selected.length === 0) {
    console.error('筛选后没有可跑的套件（--offline 会排除所有 db 套件）');
    process.exit(2);
  }
}

if (!fs.existsSync(path.join(root, 'dist/server/service/ai.service.js'))) {
  console.error('缺少 dist/server 产物：先跑 pnpm build-server（验证脚本 require 的是编译产物）');
  process.exit(2);
}

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(root, 'scripts', file)], { cwd: root, stdio: 'inherit' });
    child.on('close', (code) => resolve({ code: code ?? 1, ms: Date.now() - started }));
    child.on('error', (err) => {
      console.error(`[verify-all] 无法启动 ${file}: ${err.message}`);
      resolve({ code: 1, ms: Date.now() - started });
    });
  });
}

/** search_audit 那套假设表已存在（它只验证查询口径），所以 db 套件前统一跑一次迁移 */
async function ensureSchema() {
  const { runMigrations } = require('../dist/server/db/migrate.js');
  const { closePool } = require('../dist/server/db/pool.js');
  try {
    const res = await runMigrations();
    console.log(`[schema] 迁移已是最新：本次应用 ${res.applied.length} 个，此前已应用 ${res.alreadyApplied.length} 个`);
  } finally {
    await closePool();
  }
}

const results = [];
let schemaReady = !selected.some((s) => s.db);

console.log(`[verify-all] 共 ${selected.length} 套：${selected.map((s) => s.id).join(' / ')}${offline ? '（--offline）' : ''}`);

for (const suite of selected) {
  if (suite.db && !schemaReady) {
    try {
      await ensureSchema();
      schemaReady = true;
    } catch (e) {
      // 迁移都跑不动就没必要再逐套去撞同一个连接错误，直接判失败并给出唯一原因
      console.error(`[schema] 迁移失败，跳过其余 db 套件: ${e?.message || e}`);
      results.push({ id: suite.id, code: 1, ms: 0, skipped: 'schema' });
      continue;
    }
  }
  console.log(`\n===== ${suite.id}（${suite.file}）=====`);
  const r = await run(suite.file);
  results.push({ id: suite.id, ...r });
}

const failed = results.filter((r) => r.code !== 0);
console.log('\n================ 汇总 ================');
for (const r of results) {
  const tail = r.skipped ? `已跳过（${r.skipped}）` : `${r.code === 0 ? 'PASS' : 'FAIL'}  ${(r.ms / 1000).toFixed(1)}s`;
  console.log(`  ${r.id.padEnd(16)} ${tail}`);
}
console.log(`  ${results.length - failed.length}/${results.length} 套通过`);
process.exit(failed.length === 0 ? 0 : 1);
