/**
 * P5：告警（alerts / alert_mutes / webhook）校验 —— 纯函数 + 真实库 + 投递器 + 路由。
 *
 * 要钉住的事：
 * 1. 同一行日志刷 100 次 → 1 条 open、occurrences=100、只投递 1 次；
 * 2. ack 后同级别再命中不重开、不重投；级别升级才退回 open 并再投一次；
 * 3. resolved 后同指纹再命中 = 一条新告警（旧行保留）；
 * 4. 服务重启（换一个 AlertService 实例）读到的还是同一行 —— 告警离开了页面；
 * 5. 规则静默：照常记账、只是不投递；取消后恢复；
 * 6. webhook 不可达不阻塞：4 次尝试（首次 + 3 次重试）后放弃，调用方早已返回；
 * 7. 签名可用密钥复算、5 分钟去抖窗口内同一指纹只发一次；
 * 8. 监控命中一行 → sink 收到归属 / 级别 / 规则；未命中的行不产生告警。
 *
 * 会往真实库里插行，owner 用随机前缀 `verify-p5-*`，跑完按前缀删干净。
 *
 * 用法：node scripts/verify-p5-alerts.mjs（先 pnpm build-server；需要可连的 MySQL）
 */
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { AlertService, normalizeConnectionId } = require('../dist/server/service/alert.service.js');
const { AlertDispatcher } = require('../dist/server/service/alert-dispatcher.js');
const alertRepo = require('../dist/server/db/repositories/alert.repo.js');
const { fingerprintLine } = require('../dist/server/utils/fingerprint.js');
const { runMigrations } = require('../dist/server/db/migrate.js');
const { execute, query, closePool } = require('../dist/server/db/pool.js');
const { loadConfig, resetConfigCache } = require('../dist/server/utils/config.js');
const { MonitorService } = require('../dist/server/service/monitor.service.js');
const { handleRoutes } = require('../dist/server/index.js');

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
// 重试等待用的是 unref 定时器，脚本必须自己握着事件循环
const keepAlive = setInterval(() => {}, 1000);

const OWNER = `verify-p5-${Date.now()}`;
const OTHER = `${OWNER}-other`;
const CONN_A = `conn-p5-${Date.now()}-a`;
const CONN_B = `conn-p5-${Date.now()}-b`;
const RULE = '(ERROR|FATAL|CRITICAL)';

const LINE_1 = '2026-11-17 03:12:44,123 [ERROR] /var/log/app-20261117.log: Connection refused to 10.0.0.5:5432 (pid 4021)';
const LINE_2 = '2026-11-18 07:55:01,902 [ERROR] /var/log/app-20261231.log: Connection refused to 10.0.0.5:5432 (pid 997)';

function alertStub(over = {}) {
  const now = new Date();
  return {
    id: 1,
    ownerId: OWNER,
    connectionId: CONN_A,
    fingerprint: 'a'.repeat(16),
    status: 'open',
    source: 'log',
    rule: RULE,
    level: 'error',
    message: LINE_1,
    sampleText: LINE_1,
    occurrences: 1,
    firstSeen: now,
    lastSeen: now,
    ackedBy: null,
    ackedAt: null,
    resolvedAt: null,
    ...over,
  };
}

/** 记录 enqueue 调用，不真发请求 */
function spyDispatcher() {
  const calls = [];
  return { calls, enqueue: (kind, alert) => calls.push({ kind, alert }) };
}

function fakeFetch(script = []) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const step = script.length > 0 ? script.shift() : { status: 200 };
    if (step instanceof Error) throw step;
    const status = step?.status ?? 200;
    return { ok: status >= 200 && status < 300, status };
  };
  fn.calls = calls;
  return fn;
}

try {
  // ================= 一、配置：alerts 段 + 环境变量 =================
  const savedEnv = {
    url: process.env.AETHEROPS_ALERTS_WEBHOOK_URL,
    secret: process.env.AETHEROPS_ALERTS_WEBHOOK_SECRET,
    timeout: process.env.AETHEROPS_ALERTS_WEBHOOK_TIMEOUT_MS,
  };
  process.env.AETHEROPS_ALERTS_WEBHOOK_URL = 'https://example.com/aetherops-hook';
  process.env.AETHEROPS_ALERTS_WEBHOOK_SECRET = 's3cret';
  process.env.AETHEROPS_ALERTS_WEBHOOK_TIMEOUT_MS = '2500';
  resetConfigCache();
  const cfg = loadConfig();
  check('默认配置带上 alerts 段（且默认不投递）',
    !!cfg.alerts && cfg.alerts.webhookTimeoutMs > 0, JSON.stringify(cfg.alerts));
  check('AETHEROPS_ALERTS_WEBHOOK_URL 覆盖 alerts.webhookUrl',
    cfg.alerts.webhookUrl === 'https://example.com/aetherops-hook', cfg.alerts.webhookUrl);
  check('AETHEROPS_ALERTS_WEBHOOK_SECRET 覆盖 alerts.webhookSecret', cfg.alerts.webhookSecret === 's3cret');
  check('AETHEROPS_ALERTS_WEBHOOK_TIMEOUT_MS 覆盖超时（数字）', cfg.alerts.webhookTimeoutMs === 2500,
    String(cfg.alerts.webhookTimeoutMs));
  // 还原环境，避免影响后面的真实配置
  for (const [key, value] of Object.entries({
    AETHEROPS_ALERTS_WEBHOOK_URL: savedEnv.url,
    AETHEROPS_ALERTS_WEBHOOK_SECRET: savedEnv.secret,
    AETHEROPS_ALERTS_WEBHOOK_TIMEOUT_MS: savedEnv.timeout,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();

  // ================= 二、指纹：日志行复用同一份实现 =================
  const fp1 = fingerprintLine(LINE_1);
  const fp2 = fingerprintLine(LINE_2);
  check('只差时间 / PID / 路径日期的两行 → 同一指纹', !!fp1 && !!fp2 && fp1.fingerprint === fp2.fingerprint,
    `${fp1?.fingerprint} vs ${fp2?.fingerprint}`);
  check('指纹 16 位十六进制', !!fp1 && /^[0-9a-f]{16}$/.test(fp1.fingerprint), fp1?.fingerprint);
  check('换掉错误内容 → 指纹不同',
    fingerprintLine(LINE_1.replace('Connection refused', 'Authentication failed')).fingerprint !== fp1.fingerprint);
  check('空行 → null', fingerprintLine('   ') === null);
  check('连接口径归一：空串 / local / __local__ 都是 __local__',
    normalizeConnectionId('') === '__local__'
    && normalizeConnectionId('local') === '__local__'
    && normalizeConnectionId('__local__') === '__local__'
    && normalizeConnectionId(CONN_A) === CONN_A);

  // ================= 三、真实库：迁移 + 去重状态机 =================
  try {
    const migrated = await runMigrations();
    check('迁移 0010 已应用（alerts / alert_mutes 可用）',
      migrated.applied.includes('0010') || migrated.alreadyApplied.includes('0010'),
      `applied=${migrated.applied.join(',')}`);
  } catch (e) {
    check('迁移 0010 已应用（alerts / alert_mutes 可用）', false, String(e?.message || e));
  }
  await query('SELECT 1 FROM alerts LIMIT 1');
  await query('SELECT 1 FROM alert_mutes LIMIT 1');

  const spy = spyDispatcher();
  const svc = new AlertService(spy);
  const ingest = (over = {}) => svc.ingest({
    ownerId: OWNER,
    connectionId: CONN_A,
    rule: RULE,
    level: 'error',
    line: LINE_1,
    ...over,
  });

  const first = await ingest();
  check('首次命中 → created / open', first.action === 'created' && first.alert?.status === 'open',
    `${first.action}/${first.alert?.status}`);
  check('首次命中 → 投递 1 次', spy.calls.length === 1 && spy.calls[0].kind === 'created', String(spy.calls.length));

  for (let i = 0; i < 99; i += 1) await ingest({ line: i % 2 === 0 ? LINE_2 : LINE_1 });
  const rows = await query(
    'SELECT id, status, occurrences, first_seen, last_seen FROM alerts WHERE owner_id = ? AND connection_id = ? AND fingerprint = ?',
    [OWNER, CONN_A, fp1.fingerprint],
  );
  check('同一行刷 100 次 → 只有 1 行', rows.length === 1, `rows=${rows.length}`);
  check('occurrences = 100', Number(rows[0]?.occurrences) === 100, String(rows[0]?.occurrences));
  check('刷 99 次不重复投递（仍只有第一次）', spy.calls.length === 1, String(spy.calls.length));
  const firstSeen = rows[0].first_seen instanceof Date ? rows[0].first_seen.getTime() : new Date(rows[0].first_seen).getTime();
  const lastSeen = rows[0].last_seen instanceof Date ? rows[0].last_seen.getTime() : new Date(rows[0].last_seen).getTime();
  check('last_seen 不早于 first_seen', lastSeen >= firstSeen);

  // 「服务重启」：换一个实例，数据仍在（告警离开了页面）
  const afterRestart = new AlertService(spyDispatcher());
  const listed = await afterRestart.list(OWNER, { status: 'open' });
  check('换实例仍能读到这条告警（持久化）', listed.items.length === 1 && listed.items[0].occurrences === 100,
    `items=${listed.items.length}`);
  check('计数接口：open=1', listed.counts.open === 1, JSON.stringify(listed.counts));

  const alertId = listed.items[0].id;
  const acked = await svc.ack(OWNER, alertId, 'tester');
  check('ack → acked 且记下确认人', acked?.status === 'acked' && acked?.ackedBy === 'tester', acked?.status);
  const afterAck = await ingest();
  check('ack 后同级别再命中 → 状态仍是 acked', afterAck.action === 'updated' && afterAck.alert?.status === 'acked',
    `${afterAck.action}/${afterAck.alert?.status}`);
  check('ack 后再命中 → occurrences 继续累加', afterAck.alert?.occurrences === 101, String(afterAck.alert?.occurrences));
  check('ack 后再命中 → 不重复投递', spy.calls.length === 1, String(spy.calls.length));

  const escalated = await ingest({ level: 'critical' });
  check('级别升级 → escalated 并退回 open',
    escalated.action === 'escalated' && escalated.alert?.status === 'open', `${escalated.action}/${escalated.alert?.status}`);
  check('级别升级 → 清掉确认人', escalated.alert?.ackedAt === null && escalated.alert?.ackedBy === null);
  check('级别升级 → 再投递一次', spy.calls.length === 2 && spy.calls[1].kind === 'escalated', String(spy.calls.length));
  check('升级后 level = critical', escalated.alert?.level === 'critical', escalated.alert?.level);

  // 降级不重开、不投递
  const downgraded = await ingest({ level: 'warning' });
  check('级别回落 → 不降级、不重开、不投递',
    downgraded.action === 'updated' && downgraded.alert?.level === 'critical' && spy.calls.length === 2,
    `${downgraded.action}/${downgraded.alert?.level}`);

  const resolved = await svc.resolve(OWNER, alertId);
  check('resolve → resolved 且记下时间', resolved?.status === 'resolved' && !!resolved?.resolvedAt);
  const again = await ingest();
  check('resolved 后同指纹再命中 → 新建一条 open', again.action === 'created' && again.alert?.status === 'open',
    `${again.action}/${again.alert?.status}`);
  check('新旧两条不是同一行', again.alert?.id !== alertId, `${again.alert?.id} vs ${alertId}`);
  check('新建也投递（去重只针对未关闭的）', spy.calls.length === 3, String(spy.calls.length));

  // 归属隔离
  const otherConn = await ingest({ connectionId: CONN_B });
  check('换 connection → 另起一条', otherConn.action === 'created' && otherConn.alert?.connectionId === CONN_B);
  const otherOwner = await ingest({ ownerId: OTHER });
  check('换 owner → 另起一条（跨账号不串）', otherOwner.action === 'created' && otherOwner.alert?.ownerId === OTHER);

  // 本地终端三种写法归一
  const localA = await ingest({ connectionId: '', line: 'local: [ERROR] disk full' });
  const localB = await ingest({ connectionId: 'local', line: 'local: [ERROR] disk full' });
  check('本机连接空串与 local 归一到同一行',
    localA.action === 'created' && localB.action === 'updated' && localA.alert?.id === localB.alert?.id,
    `${localA.alert?.id} vs ${localB.alert?.id}`);
  check('本机告警 connection_id = __local__', localA.alert?.connectionId === '__local__', localA.alert?.connectionId);

  // 跳过
  check('没有 ownerId → 不记账', (await svc.ingest({ ownerId: '', line: LINE_1 })).action === 'skipped');
  check('空行 → 不记账', (await svc.ingest({ ownerId: OWNER, connectionId: CONN_A, line: '   ' })).action === 'skipped');
  const swallowed = await svc.recordFromMonitor({ ownerId: '', line: LINE_1 });
  check('recordFromMonitor 对无效入参不抛错', swallowed.action === 'skipped');

  // 并发命中：唯一键 + 回落 touch 不能丢计数、也不能抛错
  const before = spy.calls.length;
  await Promise.all(Array.from({ length: 5 }, () => ingest({ line: 'concurrent: [ERROR] same thing' })));
  const concRows = await query(
    'SELECT COUNT(*) AS n, MAX(occurrences) AS occ FROM alerts WHERE owner_id = ? AND connection_id = ? AND message = ?',
    [OWNER, CONN_A, 'concurrent: [ERROR] same thing'],
  );
  check('并发 5 次同一行 → 只有 1 行、计数 5',
    Number(concRows[0].n) === 1 && Number(concRows[0].occ) === 5,
    `n=${concRows[0].n} occ=${concRows[0].occ}`);
  check('并发下只投递首次', spy.calls.length === before + 1, `${spy.calls.length} vs ${before + 1}`);

  // 静默
  const mutedList = await svc.mute(OWNER, RULE, 30);
  check('设置规则静默 30 分钟', mutedList.length === 1 && mutedList[0].rule === RULE
    && mutedList[0].until.getTime() > Date.now(), JSON.stringify(mutedList));
  const beforeMuted = spy.calls.length;
  const mutedHit = await ingest({ line: 'muted: [ERROR] still recorded' });
  check('静默期间照常记账（open）', mutedHit.action === 'created', mutedHit.action);
  check('静默期间不投递', spy.calls.length === beforeMuted, String(spy.calls.length));
  const afterUnmute = await svc.unmute(OWNER, RULE);
  check('取消静默后列表为空', afterUnmute.length === 0);
  const afterUnmuteHit = await ingest({ line: 'muted: [ERROR] resume delivery' });
  check('取消静默后恢复投递', afterUnmuteHit.action === 'created' && spy.calls.length === beforeMuted + 1);

  // 保留期：只清已解决
  await execute(
    'UPDATE alerts SET status = ?, resolved_at = ? WHERE id = ?',
    ['resolved', new Date(Date.now() - 40 * 24 * 3600_000), alertId],
  );
  await execute('UPDATE alerts SET last_seen = ? WHERE id = ?', [new Date(Date.now() - 40 * 24 * 3600_000), again.alert.id]);
  const removed = await svc.pruneNow();
  check('prune 删掉 30 天前已解决的行', removed >= 1, `removed=${removed}`);
  check('已解决的旧行被删除', (await alertRepo.getAlertById(OWNER, alertId)) === undefined);
  check('未关闭的旧行保留（不能把没处理的问题清掉）',
    (await alertRepo.getAlertById(OWNER, again.alert.id)) !== undefined);

  // ================= 四、投递器 =================
  const noUrl = new AlertDispatcher({ getConfig: () => ({ webhookUrl: '', webhookSecret: '', webhookTimeoutMs: 1000 }) });
  const skipped = await noUrl.dispatch('created', alertStub());
  check('未配置 webhook → skipped、不发请求', skipped.skipped && !skipped.delivered && skipped.attempts === 0);

  const hookCalls = fakeFetch([{ status: 200 }]);
  const dispatcher = new AlertDispatcher({
    getConfig: () => ({ webhookUrl: 'https://example.com/hook', webhookSecret: 'topsecret', webhookTimeoutMs: 1000 }),
    fetchImpl: hookCalls,
    debounceMs: 600_000,
    retryDelaysMs: [5, 10, 15],
  });
  const okResult = await dispatcher.dispatch('created', alertStub());
  check('webhook 2xx → delivered', okResult.delivered && okResult.attempts === 1, JSON.stringify(okResult));
  check('只发了一次 POST', hookCalls.calls.length === 1);
  const sent = hookCalls.calls[0];
  check('推的是 POST + JSON', sent.options.method === 'POST'
    && sent.options.headers['content-type'] === 'application/json');
  const payload = JSON.parse(sent.options.body);
  check('payload.event = alert.created', payload.event === 'alert.created', payload.event);
  check('payload 带连接 / 指纹 / 次数', payload.alert.connectionId === CONN_A
    && payload.alert.fingerprint === 'a'.repeat(16) && payload.alert.occurrences === 1);
  check('payload 不包含凭据字段', !/password|secret|privateKey/i.test(sent.options.body));
  const ts = sent.options.headers['x-aetherops-timestamp'];
  const expectedSig = crypto.createHmac('sha256', 'topsecret').update(`${ts}.${sent.options.body}`).digest('hex');
  check('HMAC-SHA256 签名可用密钥复算',
    sent.options.headers['x-aetherops-signature'] === `sha256=${expectedSig}`,
    sent.options.headers['x-aetherops-signature']);
  check('事件头 = alert.created', sent.options.headers['x-aetherops-event'] === 'alert.created');

  const debounced = await dispatcher.dispatch('created', alertStub());
  check('5 分钟窗口内同一指纹 → 去抖（不再发）', debounced.skipped && hookCalls.calls.length === 1,
    JSON.stringify(debounced));
  const otherFp = await dispatcher.dispatch('escalated', alertStub({ fingerprint: 'b'.repeat(16), level: 'critical' }));
  check('不同指纹 → 照常发，且事件是 escalated',
    otherFp.delivered && hookCalls.calls.length === 2
    && hookCalls.calls[1].options.headers['x-aetherops-event'] === 'alert.escalated');

  const retryFetch = fakeFetch([{ status: 500 }, { status: 200 }]);
  const retryDispatcher = new AlertDispatcher({
    getConfig: () => ({ webhookUrl: 'https://example.com/hook', webhookSecret: '', webhookTimeoutMs: 1000 }),
    fetchImpl: retryFetch,
    debounceMs: 0,
    retryDelaysMs: [5, 10, 15],
  });
  const retried = await retryDispatcher.dispatch('created', alertStub({ fingerprint: 'c'.repeat(16) }));
  check('首次 500 → 重试后成功', retried.delivered && retried.attempts === 2, JSON.stringify(retried));
  check('不配置密钥 → 不带签名头', !('x-aetherops-signature' in retryFetch.calls[0].options.headers));

  const deadFetch = fakeFetch([new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), new Error('ECONNREFUSED')]);
  const deadDispatcher = new AlertDispatcher({
    getConfig: () => ({ webhookUrl: 'https://example.com/hook', webhookSecret: 'x', webhookTimeoutMs: 1000 }),
    fetchImpl: deadFetch,
    debounceMs: 0,
    retryDelaysMs: [5, 10, 15],
  });
  const deadResult = await deadDispatcher.dispatch('created', alertStub({ fingerprint: 'd'.repeat(16) }));
  check('接收端不可达 → 首次 + 3 次重试 = 4 次尝试',
    !deadResult.delivered && deadResult.attempts === 4 && deadFetch.calls.length === 4,
    JSON.stringify(deadResult));
  check('接收端不可达 → 不抛错，返回 error 文案', typeof deadResult.error === 'string' && deadResult.error.length > 0);

  deadDispatcher.stop();
  dispatcher.stop();
  retryDispatcher.stop();
  noUrl.stop();

  // ================= 五、监控下沉 =================
  const monitorSvc = new MonitorService({ getConnectionById: async () => null });
  const sinkCalls = [];
  monitorSvc.setAlertSink((input) => sinkCalls.push(input));
  const monitorStub = {
    id: 'mon-p5',
    ownerId: OWNER,
    sessionId: 'sess-p5',
    connectionId: '',
    logPath: '/var/log/syslog',
    pattern: RULE,
    lineBuffer: [],
    alertBuffer: [],
    lastAnalyzedAt: Date.now(),
    lineCount: 0,
    running: true,
  };
  monitorSvc.handleMonitorData(monitorStub, 'app: [ERROR] boom\nall good\n');
  check('命中规则的行 → sink 收到一次', sinkCalls.length === 1, String(sinkCalls.length));
  check('sink 带归属 / 规则 / 级别 / 原文',
    sinkCalls[0]?.ownerId === OWNER && sinkCalls[0]?.rule === RULE
    && sinkCalls[0]?.level === 'error' && sinkCalls[0]?.line.includes('[ERROR] boom'),
    JSON.stringify(sinkCalls[0]));
  monitorSvc.handleMonitorData(monitorStub, 'still fine\n');
  check('未命中的行 → 不产生告警', sinkCalls.length === 1, String(sinkCalls.length));
  check('实时缓冲仍然保留（面板行为不变）', monitorStub.alertBuffer.length === 1 && monitorStub.lineBuffer.length >= 3,
    `${monitorStub.alertBuffer.length}/${monitorStub.lineBuffer.length}`);
  monitorSvc.destroy();

  // ================= 六、HTTP 路由 =================
  const ctx = { userId: OWNER, username: 'verify', role: 'user', permissions: { monitor: true } };
  const routeList = await handleRoutes('/api/alerts/list', {}, ctx);
  check('路由 list 返回条目与计数', Array.isArray(routeList.items) && routeList.items.length > 0
    && typeof routeList.counts.open === 'number', `items=${routeList.items?.length}`);
  const target = routeList.items.find((item) => item.status === 'open');
  const routeAck = await handleRoutes('/api/alerts/ack', { id: target.id }, ctx);
  check('路由 ack 生效', routeAck.status === 'acked' && routeAck.ackedBy === OWNER, routeAck.status);
  const conflict = await handleRoutes('/api/alerts/ack', { id: target.id }, ctx).then(() => 0).catch((e) => e.statusCode);
  check('重复 ack → 409', conflict === 409, String(conflict));
  const badStatus = await handleRoutes('/api/alerts/list', { status: 'opne' }, ctx).then(() => 0).catch((e) => e.statusCode);
  check('非法 status → 400（不被当成查全部）', badStatus === 400, String(badStatus));
  const forbidden = await handleRoutes('/api/alerts/list', {}, {
    userId: OWNER, username: 'verify', role: 'user', permissions: {},
  }).then(() => 0).catch((e) => e.statusCode);
  check('没有 monitor 权限 → 403', forbidden === 403, String(forbidden));
  const routeMutes = await handleRoutes('/api/alerts/mute', { rule: RULE, minutes: 5 }, ctx);
  check('路由 mute 生效', Array.isArray(routeMutes) && routeMutes.some((m) => m.rule === RULE));
  const routeUnmutes = await handleRoutes('/api/alerts/unmute', { rule: RULE }, ctx);
  check('路由 unmute 生效', Array.isArray(routeUnmutes) && routeUnmutes.length === 0);
  const routeResolve = await handleRoutes('/api/alerts/resolve', { id: target.id }, ctx);
  check('路由 resolve 生效', routeResolve.status === 'resolved', routeResolve.status);
} finally {
  clearInterval(keepAlive);
  try {
    await execute("DELETE FROM alerts WHERE owner_id LIKE 'verify-p5-%'");
    await execute("DELETE FROM alert_mutes WHERE owner_id LIKE 'verify-p5-%'");
  } catch (e) {
    console.log(`  WARN  清理测试数据失败: ${e?.message || e}`);
  }
  try {
    await closePool();
  } catch { /* ignore */ }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
}
