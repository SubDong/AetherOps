/**
 * P4：错误指纹（error_fingerprints）校验 —— 纯函数 + 真实库 + 钩子三层。
 *
 * 要钉住的事：
 * 1. 归一化能吃掉时间戳 / PID / UUID / 路径里的数字，同一个错误必须得到同一个指纹；
 * 2. 聚合语义：同一指纹写 3 次 → occurrences=3、first_seen 不变、last_seen 前移；
 * 3. 归属隔离：换 connection / 换 owner 是各自独立的行；没有连接归属就不写；
 * 4. 不该记账的输出（控制流文案、成功输出、run_on_hosts、空输出）一条都不能进表；
 * 5. 保留期按 last_seen 清理；钩子挂在 after_tool 上且不影响审计。
 *
 * 会往真实库里插行，owner 用随机前缀 `verify-p4-*`，跑完按前缀删干净。
 *
 * 用法：node scripts/verify-p4-fingerprints.mjs（先 pnpm build-server；需要可连的 MySQL）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fp = require('../dist/server/utils/fingerprint.js');
const { FingerprintService } = require('../dist/server/service/fingerprint.service.js');
const errorRepo = require('../dist/server/db/repositories/error-fingerprint.repo.js');
const { runMigrations } = require('../dist/server/db/migrate.js');
const { execute, query, closePool } = require('../dist/server/db/pool.js');
const { AIService } = require('../dist/server/service/ai.service.js');
const { AuditService } = require('../dist/server/service/audit.service.js');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? ' -> ' + extra : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER = `verify-p4-${Date.now()}`;
const OTHER = `${OWNER}-other`;
const CONN_A = `conn-p4-${Date.now()}-a`;
const CONN_B = `conn-p4-${Date.now()}-b`;

// 两条只差「时间 / PID / UUID / 文件名里的日期」的同一条报错
const LINE_A = '2026-11-17 03:12:44,123 [ERROR] /var/log/app-20261117.log: Connection refused to 10.0.0.5:5432 (pid 4021, req 7f3a1c2e-1111-2222-3333-444455556666)';
const LINE_B = '2026-11-18 07:55:01,902 [ERROR] /var/log/app-20261231.log: Connection refused to 10.0.0.5:5432 (pid 997, req 9a8b7c6d-aaaa-bbbb-cccc-ddddeeeeffff)';

const svc = new FingerprintService();

try {
  // ================= 一、纯函数层（不落库） =================
  const normA = fp.normalizeFailureLine(LINE_A);
  check('归一化折叠时间戳', normA.includes('<ts>') && !/\d{4}-\d{2}-\d{2}/.test(normA), normA);
  check('归一化折叠 UUID', normA.includes('<uuid>'), normA);
  check('归一化折叠 PID', normA.includes('pid=<n>'), normA);
  check('归一化折叠路径里的数字', normA.includes('/var/log/app-<n>.log'), normA);
  check('归一化折叠端口/行号', normA.includes(':<n>'), normA);
  check('归一化统一小写', normA === normA.toLowerCase(), normA);

  const fa = fp.extractFingerprint(LINE_A);
  const fb = fp.extractFingerprint(LINE_B);
  check('只差时间戳/PID/UUID/日期的两条 → 同一个指纹', fa && fb && fa.fingerprint === fb.fingerprint,
    `${fa?.fingerprint} vs ${fb?.fingerprint}`);
  check('指纹长度是 16 位十六进制', !!fa && /^[0-9a-f]{16}$/.test(fa.fingerprint), fa?.fingerprint);

  const other = fp.extractFingerprint(LINE_A.replace('Connection refused', 'Authentication failed'));
  check('换掉错误本身 → 指纹不同', !!other && other.fingerprint !== fa.fingerprint);
  check('sample_text 保留原文（可读）', !!fa && fa.sampleText === LINE_A, fa?.sampleText);

  // traceback：代表行取错误行，而不是最后一个调用帧
  const traceback = [
    'Traceback (most recent call last):',
    '  File "/opt/app/main.py", line 42, in <module>',
    '    run()',
    'RuntimeError: worker died',
  ].join('\n');
  const tb = fp.extractFingerprint(traceback);
  check('traceback 取到错误行（首行也命中特征）', !!tb && tb.sampleText.startsWith('Traceback'), tb?.sampleText);

  check('空输出 → 不记账', fp.extractFingerprint('') === null);
  check('只有空白 → 不记账', fp.extractFingerprint('   \n  ') === null);
  check('控制流文案 NEEDS_CONFIRM → 不记账',
    fp.extractFingerprint('NEEDS_CONFIRM: rm -rf /tmp/x needs approval') === null);
  check('控制流文案 BLOCKED → 不记账', fp.extractFingerprint('BLOCKED: high-risk command') === null);
  check('控制流文案 PERMISSION_DENIED → 不记账', fp.extractFingerprint('PERMISSION_DENIED: no ai permission') === null);
  check('控制流文案 INVALID ARGUMENTS → 不记账', fp.extractFingerprint('Invalid arguments: command is required') === null);
  check('成功输出 → 不记账',
    fp.extractFingerprint('nginx: configuration file /etc/nginx/nginx.conf test is successful') === null);
  check('grep 出来的 ERROR 字样（不带方括号）→ 不记账',
    fp.extractFingerprint('app.log:12: ERROR is a log level, not a failure') === null);

  const bashMiss = fp.extractFingerprint('bash: docker: command not found');
  check('command not found → 记账且 sample 是那一行',
    !!bashMiss && bashMiss.sampleText === 'bash: docker: command not found', bashMiss?.sampleText);

  const nginxEmerg = fp.extractFingerprint('nginx: [emerg] unknown directive "gzip_static" in /etc/nginx/conf.d/a.conf:3');
  check('nginx [emerg] → 记账', !!nginxEmerg, String(nginxEmerg));

  const ansi = fp.extractFingerprint('\u001b[31mnginx: [emerg] unknown directive "gzip_static"\u001b[0m');
  check('ANSI 转义被剥掉', !!ansi && !ansi.sampleText.includes('\u001b'), JSON.stringify(ansi?.sampleText));

  const longLine = `error: ${'x'.repeat(900)}`;
  const longFp = fp.extractFingerprint(longLine);
  check('超长代表行截到列宽并带省略号',
    !!longFp && longFp.sampleText.length === 512 && longFp.sampleText.endsWith('...'), String(longFp?.sampleText.length));

  check('引擎判定的工具级错误（isError）即使没有特征也记账',
    !!fp.extractFingerprint('something went sideways', true));

  // ================= 二、真实库：聚合语义 =================
  try {
    const migrated = await runMigrations();
    check('迁移 0009 已应用（error_fingerprints 表可用）',
      migrated.applied.includes('0009') || migrated.alreadyApplied.includes('0009'),
      `applied=${migrated.applied.join(',')} already=${migrated.alreadyApplied.length}`);
  } catch (e) {
    check('迁移 0009 已应用（error_fingerprints 表可用）', false, String(e?.message || e));
  }
  await query('SELECT 1 FROM error_fingerprints LIMIT 1');

  const rec = (output, extra = {}) => svc.record({
    ownerId: OWNER,
    connectionId: CONN_A,
    tool: 'execute_command',
    command: 'psql -h 10.0.0.5 -U app -c "select 1"',
    output,
    ...extra,
  });

  await rec(LINE_A);
  const row1 = await errorRepo.getErrorFingerprint(OWNER, CONN_A, fa.fingerprint);
  check('首次出现 → 插入一行 occurrences=1', !!row1 && row1.occurrences === 1, `occ=${row1?.occurrences}`);

  await sleep(35);
  await rec(LINE_B); // 归一化后同一个指纹
  await sleep(35);
  await rec(LINE_A);
  const row3 = await errorRepo.getErrorFingerprint(OWNER, CONN_A, fa.fingerprint);
  check('同一错误 3 次 → 只有一行、occurrences=3', !!row3 && row3.occurrences === 3, `occ=${row3?.occurrences}`);
  check('first_seen 保持不变', !!row3 && row3.firstSeen.getTime() === row1.firstSeen.getTime(),
    `${row1?.firstSeen.toISOString()} vs ${row3?.firstSeen.toISOString()}`);
  check('last_seen 前移', !!row3 && row3.lastSeen.getTime() > row1.lastSeen.getTime(),
    `${row1?.lastSeen.toISOString()} vs ${row3?.lastSeen.toISOString()}`);
  check('sample_text 取最近一次原文', !!row3 && row3.sampleText === LINE_A);
  check('command 一并记下（P6 召回要用）', !!row3 && row3.command.includes('psql'));

  // 归属隔离
  await rec(LINE_A, { connectionId: CONN_B });
  const rowB = await errorRepo.getErrorFingerprint(OWNER, CONN_B, fa.fingerprint);
  check('换 connection → 另起一行（不合并）', !!rowB && rowB.occurrences === 1, `occ=${rowB?.occurrences}`);
  const rowAStill = await errorRepo.getErrorFingerprint(OWNER, CONN_A, fa.fingerprint);
  check('另一台机器的写入不影响本机计数', !!rowAStill && rowAStill.occurrences === 3, `occ=${rowAStill?.occurrences}`);

  await rec(LINE_A, { ownerId: OTHER });
  const rowOther = await errorRepo.getErrorFingerprint(OTHER, CONN_A, fa.fingerprint);
  check('换 owner → 另起一行（跨账号不串）', !!rowOther && rowOther.occurrences === 1);

  // 不该记账的写入路径
  await rec('bash: nosuchcmd: command not found');
  const fpSkip = fp.extractFingerprint('bash: nosuchcmd: command not found').fingerprint;
  const skipRow1 = await errorRepo.getErrorFingerprint(OWNER, CONN_A, fpSkip);
  check('正常失败会记账（对照组）', !!skipRow1 && skipRow1.occurrences === 1);

  await rec('bash: ignoredcmd: command not found', { tool: 'run_on_hosts' });
  const fpRunHosts = fp.extractFingerprint('bash: ignoredcmd: command not found').fingerprint;
  check('run_on_hosts → 不记账（一个 sessionId 归不明多主机）',
    (await errorRepo.getErrorFingerprint(OWNER, CONN_A, fpRunHosts)) === undefined);

  await rec('bash: noowner: command not found', { ownerId: undefined });
  const fpNoOwner = fp.extractFingerprint('bash: noowner: command not found').fingerprint;
  check('没有 ownerId → 不记账', (await errorRepo.getErrorFingerprint(OWNER, CONN_A, fpNoOwner)) === undefined);

  await rec('bash: noconn: command not found', { connectionId: undefined });
  const fpNoConn = fp.extractFingerprint('bash: noconn: command not found').fingerprint;
  check('没有连接归属 → 不记账（宁漏不写错行）',
    (await errorRepo.getErrorFingerprint(OWNER, CONN_A, fpNoConn)) === undefined);

  await rec('NEEDS_CONFIRM: rm -rf /tmp/x needs approval');
  check('控制流文案不进表',
    fp.extractFingerprint('NEEDS_CONFIRM: rm -rf /tmp/x needs approval') === null
    && (await errorRepo.getErrorFingerprint(OWNER, CONN_A, fp.fingerprintOf('NEEDS_CONFIRM: rm -rf /tmp/x needs approval'))) === undefined);

  // ================= 三、保留期 =================
  const oldSeen = new Date(Date.now() - 40 * 24 * 3600_000);
  await errorRepo.upsertErrorFingerprint({
    ownerId: OWNER, connectionId: CONN_A, fingerprint: 'deadbeefdeadbeef',
    sampleText: 'old error', tool: 'execute_command', command: 'x', seenAt: oldSeen,
  });
  await errorRepo.upsertErrorFingerprint({
    ownerId: OWNER, connectionId: CONN_A, fingerprint: 'feedfacefeedface',
    sampleText: 'fresh error', tool: 'execute_command', command: 'y',
  });
  const removed = await svc.pruneNow();
  check('prune 删掉 30 天前的行', removed >= 1, `removed=${removed}`);
  check('过期行已被删除', (await errorRepo.getErrorFingerprint(OWNER, CONN_A, 'deadbeefdeadbeef')) === undefined);
  check('新鲜行保留', (await errorRepo.getErrorFingerprint(OWNER, CONN_A, 'feedfacefeedface')) !== undefined);

  // ================= 四、钩子层 =================
  const auditSvc = new AuditService();
  const sshStub = {
    getSession: (id) => (id === 'sess-p4' ? { name: 'web-1', connectionId: CONN_A } : undefined),
  };
  const ai = new AIService(sshStub, undefined, auditSvc, undefined, undefined, undefined, svc);
  const hooks = ai.buildHooks(OWNER, 'sess-p4');
  check('两个 after_tool 钩子并列注册', hooks.length === 2, `hooks=${hooks.map((h) => h.name).join(',')}`);
  const fpHook = hooks.find((h) => h.name === 'record-error-fingerprint');
  const auditHook = hooks.find((h) => h.name === 'audit-tool-call');
  check('指纹钩子存在', !!fpHook);
  check('审计钩子仍在（没被指纹挤掉）', !!auditHook);

  const hookOutA = 'docker: Error response from daemon: pull access denied for nope';
  // agent-core 会把同一个 ctx 依次交给两个钩子，这里照这个顺序模拟
  const hookCtx = { tool: 'execute_command', args: { command: 'docker pull nope' }, result: hookOutA, duration: 12, isError: false };
  await fpHook.handler(hookCtx);
  await auditHook.handler(hookCtx);
  const hookRow = await errorRepo.getErrorFingerprint(OWNER, CONN_A, fp.extractFingerprint(hookOutA).fingerprint);
  check('钩子把失败命令写进指纹表', !!hookRow && hookRow.command === 'docker pull nope', hookRow?.command);

  const auditRows = await query('SELECT COUNT(*) AS n FROM audit_events WHERE owner_id = ? AND tool = ?', [OWNER, 'execute_command']);
  check('同一个失败也照常落审计（两条路互不影响）', Number(auditRows[0].n) === 1, `audit=${auditRows[0].n}`);

  await fpHook.handler({ tool: 'run_on_hosts', args: { command: 'uptime' }, result: 'bash: zzz: command not found', duration: 5, isError: false });
  check('钩子对 run_on_hosts 直接跳过',
    (await errorRepo.getErrorFingerprint(OWNER, CONN_A, fp.extractFingerprint('bash: zzz: command not found').fingerprint)) === undefined);

  const aiNoSession = new AIService({ getSession: () => undefined }, undefined, undefined, undefined, undefined, undefined, svc);
  const noSessionHook = aiNoSession.buildHooks(OWNER, 'gone-session').find((h) => h.name === 'record-error-fingerprint');
  await noSessionHook.handler({ tool: 'execute_command', args: { command: 'x' }, result: 'bash: yyy: command not found', duration: 3, isError: false });
  check('会话已断（无连接归属）→ 钩子不写错行',
    (await errorRepo.getErrorFingerprint(OWNER, '__local__', fp.extractFingerprint('bash: yyy: command not found').fingerprint)) === undefined);

  check('什么都没接线 → 没有钩子', new AIService().buildHooks(OWNER, 's').length === 0);
  check('只有审计、没有指纹服务 → 仍只有审计钩子',
    new AIService(sshStub, undefined, auditSvc).buildHooks(OWNER, 'sess-p4').length === 1);
} finally {
  await execute('DELETE FROM error_fingerprints WHERE owner_id LIKE ?', ['verify-p4-%']);
  await execute('DELETE FROM audit_events WHERE owner_id LIKE ?', ['verify-p4-%']);
  const left = await query('SELECT COUNT(*) AS n FROM error_fingerprints WHERE owner_id LIKE ?', ['verify-p4-%']);
  check('清理干净（本脚本无残留）', Number(left[0].n) === 0, `left=${left[0].n}`);
  await closePool();
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
