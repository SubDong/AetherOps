/**
 * P6：协同 + 复用（认领 / 指派 / 值班 / incident 归并 / recall_fix / 技能自建）校验。
 *
 * 要钉住的事（对应 roadmap P6 的四项范围与两条验收）：
 * 1. 认领 = 确认 + 指派给自己；已被别人确认过的行，认领只改处理人、不改第一个确认人；
 * 2. 指派只接受 active 账号；列表里显示处理人（账号 ID 换成显示名）；
 * 3. 值班表只决定 webhook 里 @谁：窗口左闭右开、支持跨零点、入库校验 0-1440；
 * 4. incident 规则版归并：同 connection 30 分钟内 ≥3 条未解决 → 一件事；窗口外的旧告警
 *    不参与计数也不被带进来；关联告警全部 resolve 才关事件；人工关联会带入窗口内其他告警；
 * 5. recall_fix：**时间下界是 firstSeen**（用 lastSeen 会把「上次修好的那条」排除掉），
 *    只回失败之后成功的命令、且输出里不再带同一错误的那些，最多 3 条；
 * 6. 技能自建：id 规则、内置技能不可覆盖、正文不能空、tags 归一、删自己的技能；
 * 7. 路由层：认领/指派/值班/事件/技能都对权限与参数错误有明确状态码（不是 500）。
 *
 * 会往真实库里插行，owner 用随机前缀 `verify-p6-*`，跑完按前缀删干净。
 *
 * 用法：node scripts/verify-p6-collab.mjs（先 pnpm build-server；需要可连的 MySQL）
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AlertService, inOnCallWindow } = require('../dist/server/service/alert.service.js');
const { buildPayload } = require('../dist/server/service/alert-dispatcher.js');
const alertRepo = require('../dist/server/db/repositories/alert.repo.js');
const incidentRepo = require('../dist/server/db/repositories/incident.repo.js');
const userRepo = require('../dist/server/db/repositories/user.repo.js');
const errorRepo = require('../dist/server/db/repositories/error-fingerprint.repo.js');
const { insertAuditEvent, listSuccessfulCommandsAfter } = require('../dist/server/db/repositories/audit.repo.js');
const { fingerprintLine, fingerprintOf } = require('../dist/server/utils/fingerprint.js');
const { runMigrations } = require('../dist/server/db/migrate.js');
const { execute, query, closePool } = require('../dist/server/db/pool.js');
const { AIService } = require('../dist/server/service/ai.service.js');
const { AuditService } = require('../dist/server/service/audit.service.js');
const { SkillService } = require('../dist/server/service/skill.service.js');
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

const STAMP = Date.now();
const OWNER = `verify-p6-${STAMP}`;
const OTHER = `${OWNER}-other`;
const PURGE_OWNER = `${OWNER}-purge`;
const U_A = `${OWNER}-u1`;
const U_B = `${OWNER}-u2`;
const U_OFF = `${OWNER}-u3`;

const CONN_CLAIM = `conn-p6-${STAMP}-claim`;
const CONN_INC = `conn-p6-${STAMP}-inc`;
const CONN_WIN = `conn-p6-${STAMP}-win`;
const CONN_MAN = `conn-p6-${STAMP}-man`;
const CONN_RES = `conn-p6-${STAMP}-res`;
const CONN_R1 = `conn-p6-${STAMP}-r1`;
const CONN_R2 = `conn-p6-${STAMP}-r2`;
const CONN_RX = `conn-p6-${STAMP}-rx`;

/** 同一句报错（指纹相同），用于 recall_fix 场景 A */
const ERR_A = 'nginx: [emerg] unknown directive "gzip_static" in /etc/nginx/conf.d/a.conf:3';
const FP_A = fingerprintOf(ERR_A);
/** 场景 B 的另一种报错 */
const ERR_B = 'docker: Error response from daemon: driver failed programming external connectivity on endpoint web';
const FP_B = fingerprintOf(ERR_B);

const HOUR = 3600_000;
const MIN = 60_000;

/** 记录 enqueue 调用，不真发请求 */
function spyDispatcher() {
  const calls = [];
  return { calls, enqueue: (kind, alert, onCall) => calls.push({ kind, alert, onCall }) };
}

async function seedMember(id, username, displayName, status = 'active') {
  await execute(
    `INSERT INTO users (id, username, display_name, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'verify-only', 'user', ?, ?, ?)`,
    [id, username, displayName, status, new Date(), new Date()],
  );
}

async function auditRow(over) {
  await insertAuditEvent({
    id: `${OWNER}-${Math.random().toString(36).slice(2, 10)}`,
    ownerId: OWNER,
    timestamp: Date.now(),
    sessionId: 'sess-p6',
    sessionName: 'web-1',
    connectionId: CONN_R1,
    userMessage: '',
    tool: 'execute_command',
    command: '',
    result: '',
    duration: 10,
    status: 'success',
    ...over,
  });
}

try {
  // ================= 一、迁移 0011：schema =================
  try {
    const migrated = await runMigrations();
    check('迁移 0011 已应用',
      migrated.applied.includes('0011') || migrated.alreadyApplied.includes('0011'),
      `applied=${migrated.applied.join(',')} already=${migrated.alreadyApplied.join(',')}`);
  } catch (e) {
    check('迁移 0011 已应用', false, String(e?.message || e));
  }

  const cols = await query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND COLUMN_NAME IN ('assignee_id','incident_id')`,
  );
  const colNames = cols.map((r) => String(r.COLUMN_NAME || r.column_name));
  check('alerts 有 assignee_id / incident_id 两列',
    colNames.includes('assignee_id') && colNames.includes('incident_id'), colNames.join(','));
  const idx = await query(
    `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts'
        AND INDEX_NAME IN ('idx_alerts_assignee','idx_alerts_incident')`,
  );
  check('两个新索引都在（不建索引等于每次列表全表扫）', idx.length === 2, String(idx.length));
  await query('SELECT 1 FROM incidents LIMIT 1');
  await query('SELECT 1 FROM alert_oncall LIMIT 1');

  // ================= 二、成员 / 认领 / 指派 =================
  await seedMember(U_A, `p6a${STAMP}`, '验证成员A');
  await seedMember(U_B, `p6b${STAMP}`, '验证成员B');
  await seedMember(U_OFF, `p6c${STAMP}`, '停用成员', 'disabled');

  const spy = spyDispatcher();
  const svc = new AlertService(spy);
  const ingest = (line, connectionId = CONN_CLAIM, over = {}) => svc.ingest({
    ownerId: OWNER, connectionId, rule: 'p6', level: 'error', line, ...over,
  });

  const members = await svc.members();
  const memberIds = members.map((m) => m.id);
  check('成员清单含两个 active 账号', memberIds.includes(U_A) && memberIds.includes(U_B), memberIds.join(','));
  check('成员清单不含 disabled 账号', !memberIds.includes(U_OFF));
  check('成员简表只带 id / username / displayName',
    members.every((m) => Object.keys(m).sort().join(',') === 'displayName,id,username'),
    JSON.stringify(members[0]));

  const a1 = (await ingest('claim: [ERROR] disk quota exceeded')).alert;
  check('造出一条 open 告警', a1?.status === 'open', a1?.status);

  const assigned = await svc.assign(OWNER, a1.id, U_B);
  check('指派给成员 → assigneeId 落库', assigned?.assigneeId === U_B, String(assigned?.assigneeId));
  check('指派不改状态（不是确认）', assigned?.status === 'open' && assigned?.ackedBy === null,
    `${assigned?.status}/${assigned?.ackedBy}`);

  const listed = await svc.list(OWNER, { status: '' });
  const listedA1 = listed.items.find((item) => item.id === a1.id);
  check('列表把账号 ID 换成显示名（验收①）', listedA1?.assigneeName === '验证成员B',
    String(listedA1?.assigneeName));
  check('列表同时带原始 assigneeId', listedA1?.assigneeId === U_B, String(listedA1?.assigneeId));

  const cleared = await svc.assign(OWNER, a1.id, '');
  check('指派传空串 = 取消指派', cleared?.assigneeId === null, String(cleared?.assigneeId));

  const unknownRejected = await svc.assign(OWNER, a1.id, 'no-such-member').then(() => '').catch((e) => e.message);
  check('指派给不存在的账号 → 拒绝', /member/i.test(unknownRejected), unknownRejected);
  const disabledRejected = await svc.assign(OWNER, a1.id, U_OFF).then(() => '').catch((e) => e.message);
  check('指派给停用账号 → 拒绝（不能把告警交给没人）', /member/i.test(disabledRejected), disabledRejected);

  const claimed = await svc.claim(OWNER, a1.id, U_A);
  check('认领 = 确认 + 指派给自己',
    claimed?.status === 'acked' && claimed?.ackedBy === U_A && claimed?.assigneeId === U_A,
    `${claimed?.status}/${claimed?.ackedBy}/${claimed?.assigneeId}`);

  const reClaimed = await svc.claim(OWNER, a1.id, U_B);
  check('别人再认领 → 转派处理人', reClaimed?.assigneeId === U_B, String(reClaimed?.assigneeId));
  check('别人再认领不覆盖第一个确认人', reClaimed?.ackedBy === U_A, String(reClaimed?.ackedBy));

  await svc.resolve(OWNER, a1.id);
  check('已解决的告警不可认领', (await svc.claim(OWNER, a1.id, U_A)) === null);
  check('已解决的告警不可指派', (await svc.assign(OWNER, a1.id, U_B)) === null);

  // ================= 三、值班表 =================
  check('时间窗左闭右开（09:00-18:00）',
    inOnCallWindow(540, 540, 1080) && inOnCallWindow(1079, 540, 1080) && !inOnCallWindow(1080, 540, 1080));
  check('跨零点窗口 20:00-08:00 覆盖两端',
    inOnCallWindow(1200, 1200, 480) && inOnCallWindow(0, 1200, 480) && inOnCallWindow(479, 1200, 480)
    && !inOnCallWindow(480, 1200, 480) && !inOnCallWindow(720, 1200, 480));
  check('长度为 0 的窗口谁都不覆盖', !inOnCallWindow(540, 540, 540));

  const on1 = await svc.setOnCall(OWNER, U_A, 540, 1080);
  check('保存值班时间窗', on1.length === 1 && on1[0].userId === U_A && on1[0].endMinute === 1080,
    JSON.stringify(on1));
  check('值班行带 username（webhook 的 @文本要用）', on1[0]?.username === `p6a${STAMP}`, on1[0]?.username);

  const on2 = await svc.setOnCall(OWNER, U_A, 540, 720);
  check('同人同开始时间 = 覆盖结束时间（不是插两行）',
    on2.length === 1 && on2[0].endMinute === 720, JSON.stringify(on2));
  const on3 = await svc.setOnCall(OWNER, U_B, 1200, 480);
  check('跨零点窗口能存下来', on3.length === 2 && on3.some((r) => r.userId === U_B && r.endMinute === 480),
    JSON.stringify(on3));

  const at10 = await svc.onCallAt(OWNER, new Date(2026, 0, 5, 10, 0));
  check('10:00 → 命中 U_A', at10?.userId === U_A, String(at10?.userId));
  const at2 = await svc.onCallAt(OWNER, new Date(2026, 0, 5, 2, 0));
  check('02:00 → 命中跨零点的 U_B', at2?.userId === U_B, String(at2?.userId));
  const at8 = await svc.onCallAt(OWNER, new Date(2026, 0, 5, 8, 0));
  check('08:00 → 无人值班（窗口外）', at8 === null, JSON.stringify(at8));

  const badStart = await svc.setOnCall(OWNER, U_A, 1440, 60).then(() => '').catch((e) => e.message);
  check('startMinute > 1439 → 拒绝', /startMinute/.test(badStart), badStart);
  const zeroLen = await svc.setOnCall(OWNER, U_A, 600, 600).then(() => '').catch((e) => e.message);
  check('长度为 0 的时间窗 → 拒绝', /长度为 0/.test(zeroLen), zeroLen);
  const badMember = await svc.setOnCall(OWNER, U_OFF, 600, 700).then(() => '').catch((e) => e.message);
  check('值班人必须是 active 成员', /member/i.test(badMember), badMember);

  // 投递 payload：onCall 只描述「此刻谁在岗」，不代收件人决定语法
  const payloadOnCall = buildPayload('created', {
    id: 1, ownerId: OWNER, connectionId: CONN_CLAIM, fingerprint: FP_A, status: 'open', source: 'log',
    rule: 'p6', level: 'error', message: ERR_A, sampleText: ERR_A, occurrences: 1,
    firstSeen: new Date(), lastSeen: new Date(), ackedBy: null, ackedAt: null,
    assigneeId: null, incidentId: null, resolvedAt: null,
  }, on3.find((r) => r.userId === U_A) || null);
  check('webhook payload 带 onCall.userId / mention',
    payloadOnCall.onCall?.userId === U_A && payloadOnCall.onCall?.mention === `@p6a${STAMP}`,
    JSON.stringify(payloadOnCall.onCall));
  const payloadNoOnCall = buildPayload('created', {
    id: 1, ownerId: OWNER, connectionId: CONN_CLAIM, fingerprint: FP_A, status: 'open', source: 'log',
    rule: 'p6', level: 'error', message: ERR_A, sampleText: ERR_A, occurrences: 1,
    firstSeen: new Date(), lastSeen: new Date(), ackedBy: null, ackedAt: null,
    assigneeId: null, incidentId: null, resolvedAt: null,
  }, null);
  check('无人值班 → onCall 为 null（照常投递）', payloadNoOnCall.onCall === null);

  const afterClear = await svc.clearOnCall(OWNER, U_B, 1200);
  check('删除值班时间窗', afterClear.length === 1 && afterClear[0].userId === U_A, JSON.stringify(afterClear));

  // ================= 四、incident 规则版归并 =================
  const i1 = await ingest('incident: [ERROR] no space left on device', CONN_INC);
  const i2 = await ingest('incident: [ERROR] io error on sda', CONN_INC);
  check('前两条不成事件（<3 条）', !i1.incidentId && !i2.incidentId, `${i1.incidentId}/${i2.incidentId}`);
  const i3 = await ingest('incident: [ERROR] read-only file system', CONN_INC);
  check('第 3 条触发归并并带回 incidentId', !!i3.incidentId, String(i3.incidentId));

  const incRows = await query(
    'SELECT id, incident_id FROM alerts WHERE owner_id = ? AND connection_id = ? ORDER BY id',
    [OWNER, CONN_INC],
  );
  check('同主机前三条都归到同一个事件',
    incRows.length === 3 && incRows.every((r) => Number(r.incident_id) === i3.incidentId),
    incRows.map((r) => r.incident_id).join(','));
  const inc = await incidentRepo.getIncidentById(OWNER, i3.incidentId);
  check('事件状态 open、条数 3、维度是这台主机',
    inc?.status === 'open' && inc?.alertCount === 3 && inc?.connectionId === CONN_INC,
    `${inc?.status}/${inc?.alertCount}/${inc?.connectionId}`);

  const i4 = await ingest('incident: [ERROR] journal aborted', CONN_INC);
  check('窗口内第 4 条并进同一个事件', i4.incidentId === i3.incidentId, String(i4.incidentId));
  const inc4 = await incidentRepo.getIncidentById(OWNER, i3.incidentId);
  check('事件条数随归并刷新为 4', inc4?.alertCount === 4, String(inc4?.alertCount));

  const otherConn = await ingest('incident: [ERROR] now on another host', `conn-p6-${STAMP}-inc2`);
  check('换主机不归并（跨主机没有「同一件事」的证据）', !otherConn.incidentId, String(otherConn.incidentId));

  // 窗口外的旧告警：不参与计数，也不被带进来
  const oldAt = Date.now() - 40 * MIN;
  await ingest('window: [ERROR] stale one', CONN_WIN, { at: oldAt });
  await ingest('window: [ERROR] stale two', CONN_WIN, { at: oldAt });
  const w1 = await ingest('window: [ERROR] fresh one', CONN_WIN);
  check('窗口外的旧告警不计入 3 条阈值', !w1.incidentId, String(w1.incidentId));
  await ingest('window: [ERROR] fresh two', CONN_WIN);
  const w3 = await ingest('window: [ERROR] fresh three', CONN_WIN);
  const winInc = w3.incidentId ? await incidentRepo.getIncidentById(OWNER, w3.incidentId) : undefined;
  check('窗口内凑满 3 条才成事件，且只带窗口内的告警',
    !!winInc && winInc.alertCount === 3, `${w3.incidentId}/${winInc?.alertCount}`);

  // 全部关联告警解决 → 事件关闭
  const resAlerts = [];
  for (const n of [1, 2, 3]) resAlerts.push((await ingest(`resolve: [ERROR] item ${n}`, CONN_RES)).alert);
  const resIncId = (await incidentRepo.listIncidents(OWNER, { status: 'open' }))
    .find((r) => r.connectionId === CONN_RES)?.id;
  check('凑满 3 条后出现一个 open 事件', !!resIncId, String(resIncId));
  await svc.resolve(OWNER, resAlerts[0].id);
  await svc.resolve(OWNER, resAlerts[1].id);
  const stillOpen = await incidentRepo.getIncidentById(OWNER, resIncId);
  check('还有告警没解决 → 事件保持 open', stillOpen?.status === 'open', stillOpen?.status);
  await svc.resolve(OWNER, resAlerts[2].id);
  const closed = await incidentRepo.getIncidentById(OWNER, resIncId);
  check('最后一条解决 → 事件自动关闭', closed?.status === 'resolved' && !!closed?.resolvedAt, closed?.status);

  // 人工关联
  const m1 = (await ingest('manual: [ERROR] first', CONN_MAN)).alert;
  const manual1 = await svc.attachIncident(OWNER, m1.id);
  check('人工关联：没有活跃事件就新建', manual1?.created === true, JSON.stringify(manual1));
  const again1 = await svc.attachIncident(OWNER, m1.id);
  check('重复关联同一条 → 幂等（不新建事件）',
    again1?.incidentId === manual1.incidentId && again1?.created === false, JSON.stringify(again1));
  await ingest('manual: [ERROR] second', CONN_MAN);
  const m3 = (await ingest('manual: [ERROR] third', CONN_MAN)).alert;
  const manual3 = await svc.attachIncident(OWNER, m3.id);
  const manInc = await incidentRepo.getIncidentById(OWNER, manual3.incidentId);
  check('人工关联带入窗口内其他未归并告警',
    manual3.created === false && manInc?.alertCount === 3, `${manual3.created}/${manInc?.alertCount}`);

  // 保留期：事件跟着告警一起清
  const oldResolved = new Date(Date.now() - 40 * 24 * HOUR);
  await execute('UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ?', ['resolved', oldResolved, resIncId]);
  await execute('UPDATE alerts SET status = ?, resolved_at = ? WHERE incident_id = ?', ['resolved', oldResolved, resIncId]);
  await svc.pruneNow();
  check('保留期清理连带删掉旧事件',
    (await incidentRepo.getIncidentById(OWNER, resIncId)) === undefined);
  check('未解决的事件不受保留期影响',
    (await incidentRepo.getIncidentById(OWNER, manual1.incidentId)) !== undefined);

  // ================= 五、recall_fix =================
  // 场景 A：上次修过、这次又犯。lastSeen 之后又跑了一条「成功但没修好」的命令。
  const t0 = Date.now() - 3 * HOUR;
  const fixAt = t0 + 5 * MIN;
  const recurAt = Date.now() - 1 * HOUR;
  await errorRepo.upsertErrorFingerprint({
    ownerId: OWNER, connectionId: CONN_R1, fingerprint: FP_A,
    sampleText: ERR_A, tool: 'execute_command', command: 'nginx -t', seenAt: new Date(t0),
  });
  await errorRepo.upsertErrorFingerprint({
    ownerId: OWNER, connectionId: CONN_R1, fingerprint: FP_A,
    sampleText: ERR_A, tool: 'execute_command', command: 'nginx -t', seenAt: new Date(recurAt),
  });
  const fpRow = await errorRepo.getErrorFingerprint(OWNER, CONN_R1, FP_A);
  check('指纹行记下两次出现（first / last 不同）',
    fpRow?.occurrences === 2 && fpRow?.firstSeen.getTime() === t0 && fpRow?.lastSeen.getTime() === recurAt,
    `${fpRow?.occurrences}/${fpRow?.firstSeen?.toISOString()}/${fpRow?.lastSeen?.toISOString()}`);

  // 失败命令本身
  await auditRow({ connectionId: CONN_R1, timestamp: t0 + 1 * MIN, command: 'nginx -t', result: ERR_A, status: 'error' });
  // 上次的修法：成功、输出里不再有这个错误
  await auditRow({
    connectionId: CONN_R1, timestamp: fixAt,
    command: 'sed -i "s/gzip_static;//" /etc/nginx/conf.d/a.conf && systemctl reload nginx',
    result: 'nginx: configuration file /etc/nginx/nginx.conf test is successful',
  });
  // 这次复发之后「成功但没修好」：退出码 0，输出里仍带同一错误
  await auditRow({
    connectionId: CONN_R1, timestamp: recurAt + 10 * MIN,
    command: 'service nginx restart', result: `Job for nginx.service started.\n${ERR_A}`,
  });

  const sshStub = {
    getSessions: (owner) => (owner === OWNER ? [{ sessionId: 'sess-p6', connectionId: CONN_R1, name: 'web-1' }] : []),
  };
  const ai = new AIService(sshStub, undefined, new AuditService());
  const defs = ai.getToolDefinitions();
  const byName = new Map(defs.map((d) => [d.function?.name, d]));
  check('recall_fix 已注册到工具表', byName.has('recall_fix'), defs.map((d) => d.function?.name).join(','));
  const recallDef = byName.get('recall_fix')?.function;
  check('recall_fix 的说明写清「只读历史、不拨号」',
    /never runs anything|only reads stored history/i.test(recallDef?.description || ''),
    String(recallDef?.description).slice(0, 80));
  check('recall_fix 的三个参数都不是必填（error_text / fingerprint / connection_id 二选一语义）',
    (recallDef?.parameters?.required || []).length === 0
    && Object.keys(recallDef?.parameters?.properties || {}).sort().join(',') === 'connection_id,error_text,fingerprint',
    JSON.stringify(recallDef?.parameters?.required));

  const ctxWithSession = { sessionId: 'chat-p6', custom: { ownerId: OWNER, terminalSessionId: 'sess-p6' } };
  const recall = (args, ctx = ctxWithSession) => ai.toolRegistry.execute('recall_fix', args, ctx);

  const outA = await recall({ error_text: ERR_A });
  const numberedA = outA.split(/\r?\n/).filter((line) => /^\d+\.\s/.test(line));
  check('【验收②】上次修过、这次又犯 → 返回上次那条成功命令', outA.includes('sed -i') && numberedA.length === 1,
    `entries=${numberedA.length}`);
  check('不把失败的命令本身捞出来（status=error 不进候选）', !outA.includes('nginx -t'), outA.slice(0, 200));
  check('成功但输出仍带同一错误的命令被过滤', !outA.includes('service nginx restart'), numberedA.join(' | '));
  check('时间下界按 firstSeen 而不是 lastSeen', !/No successful command/i.test(outA), outA.slice(0, 120));
  check('输出带 hosts / 命令 / 时间三样', /conn=/.test(outA) && /cmd:/.test(outA) && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(outA));

  // 场景 B：候选多于 3 条 → 只回最新的 3 条
  const t0b = Date.now() - 6 * HOUR;
  await errorRepo.upsertErrorFingerprint({
    ownerId: OWNER, connectionId: CONN_R2, fingerprint: FP_B,
    sampleText: ERR_B, tool: 'execute_command', command: 'docker compose up -d', seenAt: new Date(t0b),
  });
  await auditRow({ connectionId: CONN_R2, timestamp: t0b, command: 'bad-cmd', result: ERR_B, status: 'error' });
  for (let n = 1; n <= 5; n += 1) {
    await auditRow({
      connectionId: CONN_R2, timestamp: t0b + n * MIN, command: `fix-step-${n}`, result: `step ${n} ok`,
    });
  }
  await auditRow({
    connectionId: CONN_R2, timestamp: t0b + 6 * MIN, command: 'fix-dirty', result: `ok\n${ERR_B}`,
  });
  await auditRow({ connectionId: CONN_RX, timestamp: t0b + 7 * MIN, command: 'other-conn', result: 'ok' });
  await auditRow({
    connectionId: CONN_R2, timestamp: t0b + 8 * MIN, command: 'batch-run', result: 'ok', tool: 'run_on_hosts',
  });

  const outB = await recall({ fingerprint: FP_B, connection_id: CONN_R2 }, { sessionId: 'chat-x', custom: { ownerId: OWNER } });
  const numberedB = outB.split(/\r?\n/).filter((line) => /^\d+\.\s/.test(line));
  check('候选多于 3 条时只回最新 3 条', numberedB.length === 3, `entries=${numberedB.length}`);
  check('回的是最新的 3 条（fix-step-3/4/5）',
    ['fix-step-3', 'fix-step-4', 'fix-step-5'].every((c) => outB.includes(c)), numberedB.join(' | '));
  check('更早的候选被截掉', !outB.includes('fix-step-1') && !outB.includes('fix-step-2'));
  check('别的 connection 上的成功命令不混进来', !outB.includes('other-conn'));
  check('run_on_hosts 不属于「单机修法」，不进候选', !outB.includes('batch-run'));
  check('无终端时用显式 connection_id 也能查（只读历史）', outB.includes('Recall for fingerprint'), outB.slice(0, 100));

  // 参数与边界
  const badFp = await recall({ fingerprint: 'ZZZZ' });
  check('非法指纹 → 明确提示 16 位十六进制', /Invalid fingerprint/.test(badFp), badFp.slice(0, 80));
  const noArgs = await recall({});
  check('两个参数都不给 → Invalid arguments', /Invalid arguments/.test(noArgs), noArgs.slice(0, 80));
  const notFound = await recall({ fingerprint: 'deadbeefdeadbeef' });
  check('指纹没记录过 → FINGERPRINT_NOT_FOUND', /FINGERPRINT_NOT_FOUND/.test(notFound), notFound.slice(0, 80));
  const noTarget = await recall({ error_text: ERR_A }, { sessionId: 'chat-y', custom: { ownerId: OWNER } });
  check('没有终端也没给 connection_id → NO_TARGET_CONNECTION', /NO_TARGET_CONNECTION/.test(noTarget),
    noTarget.slice(0, 80));
  const listRows = await listSuccessfulCommandsAfter(OWNER, CONN_R2, new Date(t0b));
  check('专用查询本身只取 success + execute_command',
    listRows.every((r) => r.status === 'success' && r.tool === 'execute_command') && listRows.length === 6,
    `rows=${listRows.length}`);

  // ================= 六、技能自建 =================
  const skillSvc = new SkillService();
  await skillSvc.init();
  const systemSkills = await skillSvc.getSkills(OWNER);
  const hasBuiltin = systemSkills.some((s) => s.source === 'system' && s.id === 'docker-manage');
  check('内置技能已加载（对照组）', hasBuiltin, systemSkills.map((s) => s.id).join(','));

  const badId = await skillSvc.saveUserSkill(OWNER, { id: 'Bad Id', content: 'x' }).then(() => '').catch((e) => e.message);
  check('非法 id（大写 / 空格）→ 拒绝', /id/.test(badId), badId);
  const dupBuiltin = await skillSvc.saveUserSkill(OWNER, { id: 'docker-manage', content: 'x' })
    .then(() => '').catch((e) => e.message);
  check('内置技能 id 不能覆盖', /内置/.test(dupBuiltin), dupBuiltin);
  const emptyContent = await skillSvc.saveUserSkill(OWNER, { id: 'p6-empty', content: '   ' })
    .then(() => '').catch((e) => e.message);
  check('正文为空 → 拒绝', /正文/.test(emptyContent), emptyContent);
  const tooLong = await skillSvc.saveUserSkill(OWNER, { id: 'p6-long', content: 'x'.repeat(20001) })
    .then(() => '').catch((e) => e.message);
  check('正文超上限 → 拒绝', /最多/.test(tooLong), tooLong);

  const skillId = `p6-check-${STAMP}`;
  const saved = await skillSvc.saveUserSkill(OWNER, {
    id: skillId, name: 'P6 验证技能', description: '验证用', tags: 'ops, docker ,ops ', content: '## steps\n1. do it',
  });
  check('保存用户技能（tags 去空去重）',
    saved.source === 'user' && saved.tags.join(',') === 'ops,docker', JSON.stringify(saved.tags));
  const visible = await skillSvc.getSkills(OWNER);
  check('自己的技能出现在列表里', visible.some((s) => s.id === skillId));
  const fetched = await skillSvc.getSkill(OWNER, skillId);
  check('按 id 取回正文', fetched?.content.includes('do it') && fetched?.name === 'P6 验证技能', fetched?.name);
  const invisible = await skillSvc.getSkills(OTHER);
  check('别人的技能列表里看不到（跨账号隔离）', !invisible.some((s) => s.id === skillId));

  const updated = await skillSvc.saveUserSkill(OWNER, { id: skillId, name: '改过的名字', content: '## v2' });
  const rowsAfter = await query('SELECT name, content FROM skills WHERE owner_id = ? AND id = ?', [OWNER, skillId]);
  check('同 id 再保存 = 更新（不是插一条新的）',
    rowsAfter.length === 1 && updated.name === '改过的名字' && rowsAfter[0].name === '改过的名字',
    `rows=${rowsAfter.length}`);

  check('删除用户技能', (await skillSvc.deleteUserSkill(OWNER, skillId)) === true);
  check('重复删除 → false', (await skillSvc.deleteUserSkill(OWNER, skillId)) === false);
  check('删掉用户技能后内置技能仍在',
    (await skillSvc.getSkill(OWNER, 'docker-manage'))?.source === 'system');

  // ================= 七、HTTP 路由层 =================
  const ctx = { userId: OWNER, username: 'verify', role: 'user', permissions: { monitor: true, skills: true } };
  const status = (p) => p.then(() => 0).catch((e) => e.statusCode);

  const routeMembers = await handleRoutes('/api/alerts/members', {}, ctx);
  check('路由 members 只返回成员简表',
    Array.isArray(routeMembers) && routeMembers.every((m) => Object.keys(m).sort().join(',') === 'displayName,id,username'),
    JSON.stringify(routeMembers?.[0]));

  const rAlert = (await ingest('route: [ERROR] assign me')).alert;
  const routeAssigned = await handleRoutes('/api/alerts/assign', { id: rAlert.id, assigneeId: U_A }, ctx);
  check('路由 assign 生效', routeAssigned.assigneeId === U_A, String(routeAssigned.assigneeId));
  const routeList = await handleRoutes('/api/alerts/list', { status: 'open' }, ctx);
  const routeRow = routeList.items.find((item) => item.id === rAlert.id);
  check('【验收①】列表里显示处理人', routeRow?.assigneeName === '验证成员A', String(routeRow?.assigneeName));

  check('路由 assign 非法成员 → 400', (await status(handleRoutes('/api/alerts/assign', { id: rAlert.id, assigneeId: 'nope' }, ctx))) === 400);
  const routeClaim = await handleRoutes('/api/alerts/claim', { id: rAlert.id }, ctx);
  check('路由 claim 生效（确认 + 指派给自己）',
    routeClaim.status === 'acked' && routeClaim.assigneeId === OWNER, `${routeClaim.status}/${routeClaim.assigneeId}`);
  await handleRoutes('/api/alerts/resolve', { id: rAlert.id }, ctx);
  check('路由 claim 已解决 → 409', (await status(handleRoutes('/api/alerts/claim', { id: rAlert.id }, ctx))) === 409);
  check('路由 claim 缺 id → 400', (await status(handleRoutes('/api/alerts/claim', {}, ctx))) === 400);

  check('路由 setOncall 时间窗非法 → 400（不是 500）',
    (await status(handleRoutes('/api/alerts/setOncall', { userId: U_A, startMinute: 600, endMinute: 600 }, ctx))) === 400);
  check('路由 setOncall startMinute 越界 → 400',
    (await status(handleRoutes('/api/alerts/setOncall', { userId: U_A, startMinute: 1440, endMinute: 60 }, ctx))) === 400);
  const routeOnCall = await handleRoutes('/api/alerts/setOncall', { userId: U_A, startMinute: 540, endMinute: 1080 }, ctx);
  check('路由 setOncall 生效', Array.isArray(routeOnCall) && routeOnCall.some((r) => r.startMinute === 540),
    JSON.stringify(routeOnCall));
  const routeClear = await handleRoutes('/api/alerts/clearOncall', { userId: U_A, startMinute: 540 }, ctx);
  check('路由 clearOncall 生效', Array.isArray(routeClear) && !routeClear.some((r) => r.startMinute === 540),
    JSON.stringify(routeClear));
  check('路由 clearOncall 缺 userId → 400',
    (await status(handleRoutes('/api/alerts/clearOncall', { startMinute: 540 }, ctx))) === 400);
  const routeOnCallList = await handleRoutes('/api/alerts/oncall', {}, ctx);
  check('路由 oncall 返回列表', Array.isArray(routeOnCallList));

  const routeInc = await handleRoutes('/api/alerts/incidents', { status: 'open' }, ctx);
  check('路由 incidents 返回 open 事件', Array.isArray(routeInc) && routeInc.every((r) => r.status === 'open'),
    `n=${routeInc?.length}`);
  check('路由 incidents 非法 status → 400',
    (await status(handleRoutes('/api/alerts/incidents', { status: 'closed' }, ctx))) === 400);
  const attachTarget = (await ingest('route: [ERROR] attach me', `conn-p6-${STAMP}-route`)).alert;
  const routeAttach = await handleRoutes('/api/alerts/attachIncident', { id: attachTarget.id }, ctx);
  check('路由 attachIncident 生效', routeAttach.created === true && routeAttach.incidentId > 0, JSON.stringify(routeAttach));
  check('路由 attachIncident 缺 id → 400',
    (await status(handleRoutes('/api/alerts/attachIncident', {}, ctx))) === 400);

  check('没有 monitor 权限 → 403',
    (await status(handleRoutes('/api/alerts/claim', { id: rAlert.id }, {
      userId: OWNER, username: 'verify', role: 'user', permissions: {},
    }))) === 403);
  check('路由 saveSkill 没有 skills/ai 权限 → 403',
    (await status(handleRoutes('/api/ai/saveSkill', { id: 'x', content: 'y' }, {
      userId: OWNER, username: 'verify', role: 'user', permissions: {},
    }))) === 403);
  check('路由 saveSkill 非法 id → 400（校验在服务层，路由只转码）',
    (await status(handleRoutes('/api/ai/saveSkill', { id: 'Bad Id', content: 'y' }, ctx))) === 400);
  const routeSkill = await handleRoutes('/api/ai/saveSkill', {
    id: `p6-route-${STAMP}`, name: '路由技能', content: '## ok',
  }, ctx);
  check('路由 saveSkill 保存成功', routeSkill?.id === `p6-route-${STAMP}` && routeSkill?.source === 'user',
    JSON.stringify(routeSkill));
  check('路由 deleteSkill 生效', (await handleRoutes('/api/ai/deleteSkill', { id: `p6-route-${STAMP}` }, ctx)) === true);
  check('路由 deleteSkill 不存在的 id → 404',
    (await status(handleRoutes('/api/ai/deleteSkill', { id: 'nope-such-skill' }, ctx))) === 404);

  // ================= 八、删号连带清理 =================
  await ingest('purge: [ERROR] data of a deleted account', `conn-p6-${STAMP}-purge`, { ownerId: PURGE_OWNER });
  const purgeAlert = await query('SELECT id FROM alerts WHERE owner_id = ?', [PURGE_OWNER]);
  const purgeInc = await incidentRepo.insertIncident(PURGE_OWNER, `conn-p6-${STAMP}-purge`, 'purge', new Date());
  await alertRepo.upsertOnCall(PURGE_OWNER, U_A, 60, 120, new Date());
  await userRepo.purgeOwnerData(PURGE_OWNER);
  const purgeLeft = await Promise.all([
    query('SELECT COUNT(*) AS n FROM alerts WHERE owner_id = ?', [PURGE_OWNER]),
    query('SELECT COUNT(*) AS n FROM incidents WHERE owner_id = ?', [PURGE_OWNER]),
    query('SELECT COUNT(*) AS n FROM alert_oncall WHERE owner_id = ?', [PURGE_OWNER]),
  ]);
  check('删号连带清掉 alerts / incidents / alert_oncall（P6 新增的三张表）',
    purgeAlert.length === 1 && purgeInc > 0 && purgeLeft.every((r) => Number(r[0].n) === 0),
    purgeLeft.map((r) => r[0].n).join(','));
} finally {
  try {
    await execute("DELETE FROM alerts WHERE owner_id LIKE 'verify-p6-%'");
    await execute("DELETE FROM incidents WHERE owner_id LIKE 'verify-p6-%'");
    await execute("DELETE FROM alert_oncall WHERE owner_id LIKE 'verify-p6-%'");
    await execute("DELETE FROM alert_mutes WHERE owner_id LIKE 'verify-p6-%'");
    await execute("DELETE FROM error_fingerprints WHERE owner_id LIKE 'verify-p6-%'");
    await execute("DELETE FROM audit_events WHERE owner_id LIKE 'verify-p6-%'");
    await execute("DELETE FROM skills WHERE owner_id LIKE 'verify-p6-%'");
    await execute("DELETE FROM users WHERE id LIKE 'verify-p6-%'");
    const left = await query(
      `SELECT (SELECT COUNT(*) FROM alerts WHERE owner_id LIKE 'verify-p6-%')
            + (SELECT COUNT(*) FROM incidents WHERE owner_id LIKE 'verify-p6-%')
            + (SELECT COUNT(*) FROM alert_oncall WHERE owner_id LIKE 'verify-p6-%')
            + (SELECT COUNT(*) FROM audit_events WHERE owner_id LIKE 'verify-p6-%')
            + (SELECT COUNT(*) FROM skills WHERE owner_id LIKE 'verify-p6-%')
            + (SELECT COUNT(*) FROM users WHERE id LIKE 'verify-p6-%') AS n`,
    );
    check('清理干净（本脚本无残留）', Number(left[0].n) === 0, `left=${left[0].n}`);
  } catch (e) {
    console.log(`  WARN  清理测试数据失败: ${e?.message || e}`);
  }
  await closePool();
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
