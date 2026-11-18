/**
 * P1 第二片：list_connections / read_file / run_on_hosts 的校验（不需要数据库）。
 *
 * 钉住的是四类最容易「看起来能用、实际会出事」的地方：
 * 1. 权限：三个工具都不是「能对话就能用」，而且必须 fail closed（不传权限位即拒）；
 * 2. 不拨号：只打已有活会话，指定了没有会话的连接要明确拒绝，而不是偷偷连一台；
 * 3. 不泄露凭据：ConnectionService 给的是已解密实体，工具输出里不能出现口令/私钥；
 * 4. 限流：run_on_hosts 按 2 个一组、45s 总预算，skip 标记的连接不进 all_open 扫。
 *
 * 依赖全部用内存桩，跑完不落任何数据。
 *
 * 用法：node scripts/verify-p1-tools.mjs（先 pnpm build-server；不需要数据库）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AIService } = require('../dist/server/service/ai.service.js');

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
function section(title) {
  console.log(`\n== ${title} ==`);
}

const OWNER = 'verify-p1-owner';
const OTHER = 'verify-p1-other';

// ---------- SSH 桩 ----------
/**
 * sessions: [{ sessionId, connectionId, name }]
 * owners:   { sessionId -> ownerId }
 * dead:     Set(sessionId) —— 只在 metadata 里、终端进程已经没了的会话（重启后的典型形态）
 */
function makeSsh({ sessions = [], owners = {}, dead = new Set(), fileStore = new Map(), fileCalls = [] } = {}) {
  return {
    writeData: () => true,
    captureOutput: async () => '',
    captureOutputIdle: async () => '',
    getOutputBuffer: () => '',
    getSystemContext: async () => 'OS: Linux',
    getSession: (id) => (dead.has(id) ? undefined : sessions.find((s) => s.sessionId === id)),
    getSessions: () => sessions,
    getSessionOwner: (id) => owners[id],
    readFileHead: async (sessionId, remotePath, maxBytes = 64 * 1024) => {
      fileCalls.push({ sessionId, path: remotePath, maxBytes });
      const hit = fileStore.get(`${sessionId}|${remotePath}`);
      if (!hit) throw new Error('No such file or directory');
      const bytes = Math.min(Buffer.byteLength(hit.text, 'utf8'), maxBytes);
      const truncated = Buffer.byteLength(hit.text, 'utf8') > bytes;
      return { text: truncated ? hit.text.slice(0, bytes) : hit.text, bytes, size: Buffer.byteLength(hit.text, 'utf8'), truncated };
    },
  };
}

// ---------- 连接清单桩（故意带上凭据，验证工具不会把它们吐出来） ----------
const CONNECTIONS = [
  {
    id: 'conn-a', name: 'web-1', type: 'ssh', host: '10.0.0.5', port: 22, username: 'root',
    password: 'SECRET-PWD-A', privateKey: 'SECRET-KEY-A', passphrase: 'SECRET-PASS-A', enabled: true,
  },
  {
    id: 'conn-b', name: 'db-1', type: 'ssh', host: '10.0.0.6', port: 2222, username: 'admin',
    password: 'SECRET-PWD-B', enabled: false,
  },
  {
    id: 'conn-c', name: 'quiet', type: 'ssh', host: '10.0.0.7', port: 22, username: 'ops',
    sampling: 'skip', enabled: true,
  },
  { id: 'conn-e', name: 'idle', type: 'ssh', host: '10.0.0.9', port: 22, username: 'ops', enabled: true },
];
const connectionsStub = { getAllConnections: async () => CONNECTIONS };

const SESSIONS = [
  { sessionId: 'sess-a1', connectionId: 'conn-a', name: 'web-1' },
  { sessionId: 'sess-a2', connectionId: 'conn-a', name: 'web-1 #2' },
  { sessionId: 'sess-b1', connectionId: 'conn-b', name: 'db-1' },
  { sessionId: 'sess-c1', connectionId: 'conn-c', name: 'quiet' },
  { sessionId: 'sess-local', connectionId: '__local__', name: 'Default Server Shell' },
  { sessionId: 'sess-gone', connectionId: 'conn-a', name: 'restored-after-restart' },
  { sessionId: 'sess-other', connectionId: 'conn-a', name: 'someone-else' },
];
const OWNERS = {
  'sess-a1': OWNER, 'sess-a2': OWNER, 'sess-b1': OWNER, 'sess-c1': OWNER,
  'sess-local': OWNER, 'sess-gone': OWNER, 'sess-other': OTHER,
};

const fileStore = new Map();
fileStore.set('sess-a1|/etc/nginx/nginx.conf', { text: 'user nginx;\nworker_processes auto;\n' });
fileStore.set('sess-a1|/var/log/big.log', { text: 'x'.repeat(200_000) });
fileStore.set('sess-a1|/tmp/data.bin', { text: 'ab\u0000cd' });
fileStore.set('sess-a1|/etc/hosts', { text: '127.0.0.1 localhost\n' });
fileStore.set('sess-a2|/etc/hosts', { text: '127.0.0.1 localhost\n' });
const fileCalls = [];
const ssh = makeSsh({ sessions: SESSIONS, owners: OWNERS, dead: new Set(['sess-gone']), fileStore, fileCalls });

// ---------- 批量执行桩 ----------
function makeBatch({ delayMs = 0, throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    executeBatch: async (ownerId, sessionIds, command, timeout) => {
      calls.push({ ownerId, sessionIds: [...sessionIds], command, timeout });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (throwOn && throwOn(sessionIds)) throw new Error('Forbidden: session belongs to another user');
      return {
        results: sessionIds.map((sessionId) => ({
          sessionId,
          connectionId: SESSIONS.find((s) => s.sessionId === sessionId)?.connectionId || '',
          sessionName: SESSIONS.find((s) => s.sessionId === sessionId)?.name || sessionId,
          success: !sessionId.includes('fail'),
          output: sessionId.includes('fail') ? '' : 'Filesystem / 40G used',
          duration: 12,
          error: sessionId.includes('fail') ? 'connection reset' : undefined,
        })),
      };
    },
  };
}

// ---------- 审计桩 ----------
const auditRows = [];
const auditStub = { log: async (ownerId, entry) => { auditRows.push({ ownerId, ...entry }); } };

const svcAI = new AIService(ssh, undefined, auditStub, undefined, connectionsStub, makeBatch());
const registry = svcAI.toolRegistry;
const ctxOf = (permissions) => ({ sessionId: 'chat_verify', custom: { ownerId: OWNER, terminalSessionId: 'sess-a1', permissions } });
const P_ALL = { connections: true, files: true, terminal: true, batch: true };

// ============================================================
section('一、工具注册');
// ============================================================
const defs = svcAI.getToolDefinitions();
const byName = new Map(defs.map((d) => [d.function?.name, d]));
check('三个新工具都已注册',
  ['list_connections', 'read_file', 'run_on_hosts'].every((n) => byName.has(n)),
  [...byName.keys()].join(','));
check('工具总数 9（原有 4 + 本片 3 + P3 的 load_skill + P6 的 recall_fix）', defs.length === 9, `count=${defs.length}`);
check('read_file 的 path 是必填', (byName.get('read_file')?.function.parameters.required || []).includes('path'));
check('run_on_hosts 的 command 是必填', (byName.get('run_on_hosts')?.function.parameters.required || []).includes('command'));
check('run_on_hosts 的 scope 只有 all_open',
  JSON.stringify(byName.get('run_on_hosts')?.function.parameters.properties.scope.enum) === '["all_open"]');
check('list_connections 不需要参数',
  Object.keys(byName.get('list_connections')?.function.parameters.properties || {}).length === 0);
check('read_file 说明里写明不拨号',
  /never dials a new connection/i.test(byName.get('read_file').function.description));
check('run_on_hosts 说明里写明并发与预算',
  /2 hosts run at a time/i.test(byName.get('run_on_hosts').function.description)
  && /45s total budget/i.test(byName.get('run_on_hosts').function.description));

// ============================================================
section('二、权限门禁（fail closed）');
// ============================================================
const noPerm = { sessionId: 'chat_verify', custom: { ownerId: OWNER, terminalSessionId: 'sess-a1' } };
check('没有任何权限位时 list_connections 被拒',
  (await registry.execute('list_connections', {}, noPerm)).startsWith('PERMISSION_DENIED'));
check('没有任何权限位时 read_file 被拒',
  (await registry.execute('read_file', { path: '/etc/hosts' }, noPerm)).startsWith('PERMISSION_DENIED'));
check('没有任何权限位时 run_on_hosts 被拒',
  (await registry.execute('run_on_hosts', { command: 'uptime' }, noPerm)).startsWith('PERMISSION_DENIED'));

const deniedOut = await registry.execute('list_connections', {}, ctxOf({ ai: true }));
check('只有 ai 权限不足以看连接清单', deniedOut.startsWith('PERMISSION_DENIED'), deniedOut.slice(0, 40));
check('拒绝文案要求不要换参数重试', /Do NOT retry/.test(deniedOut));
check('拒绝文案指明需要哪个权限位', /connections or terminal/.test(deniedOut), deniedOut.slice(0, 120));

const batchDenied = await registry.execute('run_on_hosts', { command: 'uptime' }, ctxOf({ terminal: true, files: true }));
check('有 terminal 但没有 batch 时 run_on_hosts 仍被拒', batchDenied.startsWith('PERMISSION_DENIED'), batchDenied.slice(0, 40));

// ============================================================
section('三、list_connections');
// ============================================================
const listed = await registry.execute('list_connections', {}, ctxOf(P_ALL));
check('列出本账号 4 条连接', /Saved connections for this account \(4\)/.test(listed), listed.split('\n')[0]);
check('带口令/私钥的连接正常出现', listed.includes('connection_id=conn-a'));
check('输出里没有密码', !listed.includes('SECRET-PWD-A') && !listed.includes('SECRET-PWD-B'));
check('输出里没有私钥', !listed.includes('SECRET-KEY-A'));
check('输出里没有 passphrase', !listed.includes('SECRET-PASS-A'));
check('输出里连字段名都不该出现', !/password|privateKey|passphrase/i.test(listed));
check('有活会话的连接标注会话数', /connection_id=conn-a .*open sessions=2/.test(listed), listed.split('\n').find((l) => l.includes('conn-a')));
check('没有活会话的连接明确标注', /connection_id=conn-e .*no open session/.test(listed), listed.split('\n').find((l) => l.includes('conn-e')));
check('禁用的连接带 DISABLED', /connection_id=conn-b .*DISABLED/.test(listed));
check('sampling=skip 被标出来', /connection_id=conn-c .*offline-sampling=skip/.test(listed));
check('非 SSH 连接显示端口', listed.includes('ssh root@10.0.0.5:22') && listed.includes('ssh admin@10.0.0.6:2222'));
check('默认服务器 Shell 单独一行并带会话数', /Default Server Shell \(connection_id=__local__\): 1 open session/.test(listed));
check('统计口径排除已断会话与他人会话（5 条）', /Open terminal sessions right now: 5\./.test(listed),
  listed.split('\n').slice(-1)[0]);
check('提示 read_file / run_on_hosts 的可见范围', /only reach hosts that already have one of these sessions/.test(listed));

const noConnSvc = new AIService(ssh, undefined, auditStub, undefined, undefined, makeBatch()).toolRegistry;
const noConnOut = await noConnSvc.execute('list_connections', {}, ctxOf(P_ALL));
check('没有连接服务时给出明确不可用', noConnOut.startsWith('CONNECTIONS_UNAVAILABLE'), noConnOut.slice(0, 40));

// ============================================================
section('四、read_file');
// ============================================================
const noTermOut = await registry.execute('read_file', { path: '/etc/hosts' }, ctxOf({ files: true }));
// ctxOf 带的是 sess-a1，先换成没有终端的上下文
const noTerm = await registry.execute('read_file', { path: '/etc/nginx/nginx.conf' },
  { sessionId: 'chat_x', custom: { ownerId: OWNER, permissions: { files: true } } });
check('没绑终端时拒绝并说明「从不拨号」',
  noTerm.startsWith('NO_LIVE_SESSION') && /never dials a connection/.test(noTerm), noTerm.slice(0, 60));
check('没绑终端时不把它说成主机不可达', !/unreachable|down/i.test(noTerm.replace('Do NOT report this as the host being down or unreachable', '')));
check('（前置）绑了终端的上下文本身可用', noTermOut.includes('/etc/hosts'), noTermOut.slice(0, 60));

for (const bad of ['/etc/shadow', '/root/.ssh/id_rsa', '/proc/self/environ', '/home/u/.docker/config.json', '/srv/app/server.pem']) {
  const out = await registry.execute('read_file', { path: bad }, ctxOf({ files: true }));
  check(`凭据/设备路径被拒：${bad}`, out.startsWith('Invalid path') && /not allowed/.test(out), out.slice(0, 80));
}
const relative = await registry.execute('read_file', { path: 'etc/nginx/nginx.conf' }, ctxOf({ files: true }));
check('相对路径被拒（读哪个文件不能取决于远端 cwd）', relative.startsWith('Invalid path') && /absolute/.test(relative), relative.slice(0, 80));
const globPath = await registry.execute('read_file', { path: '/var/log/*.log' }, ctxOf({ files: true }));
check('通配符路径被拒', globPath.startsWith('Invalid path') && /metacharacters/.test(globPath), globPath.slice(0, 80));

const conf = await registry.execute('read_file', { path: '/etc/nginx/nginx.conf' }, ctxOf({ files: true }));
check('正常读到配置内容', conf.includes('worker_processes auto;'));
check('输出带路径、会话与真实大小', /File: \/etc\/nginx\/nginx\.conf \| session=sess-a1 \| size=35 bytes/.test(conf), conf.split('\n')[0]);
check('小文件标注 full content', /full content/.test(conf));

const big = await registry.execute('read_file', { path: '/var/log/big.log' }, ctxOf({ files: true }));
check('大文件按 max_bytes 截断并说明', /size=200000 bytes \| showing the first 16384 bytes/.test(big), big.split('\n')[0]);
check('截断后仍提示可用 sed/grep 取精确片段', /sed \/ grep/.test(big), big.split('\n').slice(-1)[0]);

const clamped = await registry.execute('read_file', { path: '/var/log/big.log', max_bytes: 10 * 1024 * 1024 }, ctxOf({ files: true }));
check('max_bytes 被夹到 131072', fileCalls[fileCalls.length - 1].maxBytes === 131072, String(fileCalls[fileCalls.length - 1].maxBytes));
check('夹紧后仍是截断状态', /showing the first 131072 bytes/.test(clamped), clamped.split('\n')[0]);

const tiny = await registry.execute('read_file', { path: '/etc/nginx/nginx.conf', max_bytes: 1 }, ctxOf({ files: true }));
check('max_bytes 有 1024 下限', fileCalls[fileCalls.length - 1].maxBytes === 1024, String(fileCalls[fileCalls.length - 1].maxBytes));

const binary = await registry.execute('read_file', { path: '/tmp/data.bin' }, ctxOf({ files: true }));
check('二进制文件不把乱码塞进上下文', binary.includes('FILE_LOOKS_BINARY'), binary.split('\n')[1]);

const missing = await registry.execute('read_file', { path: '/etc/nope.conf' }, ctxOf({ files: true }));
check('读不到时给出 FILE_READ_FAILED', missing.startsWith('FILE_READ_FAILED') && /No such file/.test(missing), missing.slice(0, 80));

const otherConnNoSession = await registry.execute('read_file', { path: '/etc/hosts', connection_id: 'conn-d' }, ctxOf({ files: true }));
check('指定的连接没有活会话时拒绝（不为此拨号）',
  otherConnNoSession.startsWith('NO_LIVE_SESSION') && /conn-d/.test(otherConnNoSession), otherConnNoSession.slice(0, 80));

const viaConn = await registry.execute('read_file', { path: '/etc/hosts', connection_id: 'conn-a' }, ctxOf({ files: true }));
check('指定有活会话的连接时改从该连接的会话读', /session=sess-a1/.test(viaConn) && viaConn.includes('127.0.0.1 localhost'), viaConn.split('\n')[0]);

const forbidden = await registry.execute('read_file', { path: '/etc/hosts' },
  { sessionId: 'chat_x', custom: { ownerId: OTHER, terminalSessionId: 'sess-a1', permissions: { files: true } } });
check('绑定到他人会话时拒绝', forbidden.startsWith('FILE_FORBIDDEN'), forbidden.slice(0, 60));

// ============================================================
section('五、run_on_hosts');
// ============================================================
const manySessions = [];
const manyOwners = {};
for (let i = 1; i <= 6; i += 1) {
  manySessions.push({ sessionId: `s${i}`, connectionId: `c${i}`, name: `host-${i}` });
  manyOwners[`s${i}`] = OWNER;
}
const manySsh = makeSsh({ sessions: manySessions, owners: manyOwners });
const manyConns = {
  getAllConnections: async () => manySessions.map((s, i) => ({
    id: s.connectionId, name: s.name, type: 'ssh', host: `10.0.0.${i + 1}`, port: 22, username: 'root',
    sampling: s.connectionId === 'c6' ? 'skip' : undefined, enabled: true,
  })),
};
const batch = makeBatch();
const svcMany = new AIService(manySsh, undefined, auditStub, undefined, manyConns, batch);
const regMany = svcMany.toolRegistry;
const ctxMany = (permissions = { batch: true }) => ({ sessionId: 'chat_verify', custom: { ownerId: OWNER, terminalSessionId: 's1', permissions } });

const emptySvc = new AIService(makeSsh(), undefined, auditStub, undefined, manyConns, makeBatch());
const noHosts = await emptySvc.toolRegistry.execute('run_on_hosts', { command: 'uptime' }, ctxMany());
check('没有任何活会话时拒绝并说明不拨号',
  noHosts.startsWith('NO_LIVE_SESSION') && /never dials one/.test(noHosts), noHosts.slice(0, 60));

const danger = await regMany.execute('run_on_hosts', { command: 'rm -rf /', scope: 'all_open' }, ctxMany());
check('高危命令在批量放大前就挡掉', danger.startsWith('BLOCKED'), danger.slice(0, 80));
check('高危命令说明为什么比单终端更严', /every targeted host/.test(danger));

const needTarget = await regMany.execute('run_on_hosts', { command: 'uptime' }, ctxMany());
check('不给目标时拒绝并列出可选主机',
  needTarget.startsWith('Invalid arguments') && needTarget.includes('c1 ("host-1")'), needTarget.slice(0, 120));

const tooMany = await regMany.execute('run_on_hosts', { command: 'uptime', connection_ids: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11'] }, ctxMany());
check('connection_ids 超过 10 个被拒', tooMany.startsWith('Invalid arguments') && /at most 10/.test(tooMany), tooMany.slice(0, 90));

const chunked = await regMany.execute('run_on_hosts', { command: 'df -h /', connection_ids: ['c1', 'c2', 'c3', 'c4', 'c5'] }, ctxMany());
check('5 台按 2 个一组分成 3 批', batch.calls.length === 3, `calls=${batch.calls.length}`);
check('每批最多 2 个会话', batch.calls.every((c) => c.sessionIds.length <= 2), JSON.stringify(batch.calls.map((c) => c.sessionIds)));
check('分批顺序与原目标一致', JSON.stringify(batch.calls.flatMap((c) => c.sessionIds)) === '["s1","s2","s3","s4","s5"]');
check('默认每台超时 10s', batch.calls.every((c) => c.timeout === 10000), JSON.stringify(batch.calls.map((c) => c.timeout)));
check('输出带总览', /Ran on 5\/5 host\(s\): df -h \//.test(chunked) && /ok=5, failed=0/.test(chunked), chunked.split('\n').slice(0, 2).join(' | '));
check('输出逐台标注连接与耗时', /\[ok\] host-1 \(connection_id=c1\) 12ms/.test(chunked));
check('输出带命令结果摘要', chunked.includes('out: Filesystem / 40G used'));

const clampedTimeout = await (async () => {
  const b = makeBatch();
  const svc = new AIService(manySsh, undefined, auditStub, undefined, manyConns, b);
  await svc.toolRegistry.execute('run_on_hosts', { command: 'uptime', connection_ids: ['c1'], timeout_ms: 999999 }, ctxMany());
  return b.calls[0]?.timeout;
})();
check('timeout_ms 被夹到 60000', clampedTimeout === 60000, String(clampedTimeout));

const partial = await regMany.execute('run_on_hosts', { command: 'uptime', connection_ids: ['c1', 'c9'] }, ctxMany());
check('没有活会话的目标单独列出、不当成执行过', /No open session, not attempted: c9/.test(partial), partial.split('\n').slice(-2)[0]);
check('实际执行数只算命中的那台', /Ran on 1\/1 host\(s\)/.test(partial), partial.split('\n')[0]);

const sweep = await regMany.execute('run_on_hosts', { command: 'uptime', scope: 'all_open' }, ctxMany());
check('all_open 扫描 5 台（跳过 sampling=skip）', /Ran on 5\/5 host\(s\)/.test(sweep), sweep.split('\n')[0]);
check('被跳过的连接点名说明', /Excluded \(connection marked offline-sampling=skip\): host-6/.test(sweep), sweep.split('\n').slice(-1)[0]);

const dupSessions = [
  { sessionId: 'd1', connectionId: 'cx', name: 'web' },
  { sessionId: 'd2', connectionId: 'cx', name: 'web #2' },
];
const svcDup = new AIService(
  makeSsh({ sessions: dupSessions, owners: { d1: OWNER, d2: OWNER } }),
  undefined, auditStub, undefined,
  { getAllConnections: async () => [{ id: 'cx', name: 'web', type: 'ssh' }] },
  makeBatch(),
);
const dupOut = await svcDup.toolRegistry.execute('run_on_hosts', { command: 'uptime', scope: 'all_open' },
  { sessionId: 'chat_verify', custom: { ownerId: OWNER, terminalSessionId: 'd1', permissions: { batch: true } } });
check('同一连接多终端只跑一次', /Ran on 1\/1 host\(s\)/.test(dupOut), dupOut.split('\n')[0]);
check('优先复用当前终端所在会话', dupOut.includes('connection_id=cx'), dupOut.split('\n')[2]);

const budgetBatch = makeBatch();
const realNow = Date.now;
let fakeNow = realNow();
Date.now = () => fakeNow;
try {
  const svcBudget = new AIService(
    manySsh, undefined, auditStub, undefined, manyConns,
    {
      executeBatch: async (...args) => {
        fakeNow += 30_000;
        return budgetBatch.executeBatch(...args);
      },
    },
  );
  const budgetOut = await svcBudget.toolRegistry.execute('run_on_hosts', { command: 'uptime', scope: 'all_open' }, ctxMany());
  check('超过 45s 总预算后停止', /Stopped at the 45s budget, not attempted:/.test(budgetOut), budgetOut.split('\n').slice(-1)[0]);
  check('预算内已跑的批次仍然保留结果', /Ran on 4\/5 host\(s\)/.test(budgetOut), budgetOut.split('\n')[0]);
} finally {
  Date.now = realNow;
}

const failing = new AIService(
  makeSsh({ sessions: [{ sessionId: 'f1', connectionId: 'cf', name: 'flaky' }], owners: { f1: OWNER } }),
  undefined, auditStub, undefined,
  { getAllConnections: async () => [{ id: 'cf', name: 'flaky', type: 'ssh' }] },
  { executeBatch: async () => { throw new Error('Forbidden: session belongs to another user'); } },
);
const failedOut = await failing.toolRegistry.execute('run_on_hosts', { command: 'uptime', scope: 'all_open' },
  { sessionId: 'chat_verify', custom: { ownerId: OWNER, terminalSessionId: 'f1', permissions: { batch: true } } });
check('整批抛错时仍逐台记账，不谎报成功',
  /\[failed\] flaky/.test(failedOut) && failedOut.includes('err: Forbidden'), failedOut);
check('失败时 ok=0', /ok=0, failed=1/.test(failedOut), failedOut.split('\n')[1]);

// ============================================================
section('六、审计覆盖');
// ============================================================
auditRows.length = 0;
const hooks = svcAI.buildHooks(OWNER, 'sess-a1');
const auditHook = hooks.find((h) => h.name === 'audit-tool-call');
check('after_tool 审计钩子存在', !!auditHook);
for (const [tool, args] of [
  ['list_connections', {}],
  ['read_file', { path: '/etc/nginx/nginx.conf' }],
  ['run_on_hosts', { command: 'uptime', scope: 'all_open' }],
]) {
  await auditHook.handler({ tool, args, result: 'ok', duration: 5, isError: false });
}
check('三个新工具的调用都会落审计行', auditRows.length === 3, `rows=${auditRows.length}`);
check('审计行记下工具名', ['list_connections', 'read_file', 'run_on_hosts'].every((n) => auditRows.some((r) => r.tool === n)),
  auditRows.map((r) => r.tool).join(','));
check('非 execute_command 的工具把参数记进 command',
  /\/etc\/nginx\/nginx\.conf/.test(auditRows[1].command) && /all_open/.test(auditRows[2].command),
  auditRows[1].command);
check('审计行带终端会话与账号',
  auditRows.every((r) => r.sessionId === 'sess-a1' && r.ownerId === OWNER), JSON.stringify(auditRows[0]).slice(0, 120));

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
