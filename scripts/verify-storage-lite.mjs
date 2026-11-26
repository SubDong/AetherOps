/**
 * lite 存储（SQLite）校验：配置判定 → 建库/迁移 → 各仓储读写 → 登录令牌落库。
 *
 * 为什么要单独一套：lite 不是「换了个连接串」，而是
 *   1) 迁移链从「重放 0001–0013」换成「合并基线 + 0013 之后增量」；
 *   2) SQL 要过方言翻译（ON DUPLICATE KEY UPDATE / GREATEST / VALUES() / DATE_FORMAT）；
 *   3) 登录令牌从 Redis 的 Lua 换成 auth_sessions 表 + 事务。
 * 这三件事任一没对上，个人部署（只有 SQLite、没有 MySQL/Redis）就会起不来，
 * 而 CI 的 MySQL 那套完全测不到。所以这里用临时目录建真库、真跑一遍。
 *
 * 不碰真实数据：库文件在系统临时目录里，跑完连库带目录一起删。
 *
 * 用法：node scripts/verify-storage-lite.mjs（先 pnpm build-server；Node >= 22.13，内置 node:sqlite）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 环境变量必须在 require 配置模块之前就位：config 是「读一次就缓存」的
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aetherops-lite-'));
const DB_FILE = path.join(TMP_DIR, 'verify.db');
process.env.AETHEROPS_STORAGE_MODE = 'lite';
process.env.AETHEROPS_DATA_DIR = TMP_DIR;
process.env.AETHEROPS_SQLITE_PATH = DB_FILE;

const require = createRequire(import.meta.url);
const config = require('../dist/server/utils/config.js');
const { ensureDatabaseReady, getAppliedVersions } = require('../dist/server/db/migrate.js');
const pool = require('../dist/server/db/pool.js');
const userRepo = require('../dist/server/db/repositories/user.repo.js');
const connRepo = require('../dist/server/db/repositories/connection.repo.js');
const metricsRepo = require('../dist/server/db/repositories/host-metrics.repo.js');
const auditRepo = require('../dist/server/db/repositories/audit.repo.js');
const { getTokenStore } = require('../dist/server/db/token-store.js');
const { AlertService } = require('../dist/server/service/alert.service.js');

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

const OWNER = `verify-lite-${Date.now()}`;
const CONN_ID = `conn-lite-${Date.now()}`;
const USER_ID = `${OWNER}-user`;

/** 连接实体：字段名与 connection.repo 的 toRow 一一对应，只填必需项 */
function connectionEntity(over = {}) {
  return {
    id: CONN_ID,
    name: 'lite-verify-host',
    type: 'ssh',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'enc:v1:fake',
    forwardAgent: false,
    terminal: { cols: 120, rows: 30, fontSize: 13, fontFamily: 'Menlo', theme: 'dark', cursorStyle: 'block' },
    options: { keepAlive: true },
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

try {
  // ============ 一、配置与模式判定 ============
  check('AETHEROPS_STORAGE_MODE=lite → resolveStorageMode() = lite',
    config.resolveStorageMode() === 'lite', config.resolveStorageMode());
  check('getSqlitePath() 用的是 AETHEROPS_SQLITE_PATH',
    path.resolve(config.getSqlitePath()) === path.resolve(DB_FILE), config.getSqlitePath());
  check('describeStorage() 指明 lite + SQLite', /lite \(SQLite\)/.test(config.describeStorage()),
    config.describeStorage());
  check('lite 模式下没有配置不全的抱怨', config.validateConfig(config.loadConfig()).length === 0,
    config.validateConfig(config.loadConfig()).join('; '));

  // ============ 二、建库 + 迁移 ============
  const ready = await ensureDatabaseReady();
  check('探活走 SQLite（probe.engine = sqlite）', ready.probe.engine === 'sqlite', ready.probe.engine);
  check('库文件真的建出来了', fs.existsSync(DB_FILE), DB_FILE);
  check('首次建库只应用 0013（0001–0012 已被合并基线覆盖）',
    JSON.stringify(ready.migrate.applied) === '["0013"]', JSON.stringify(ready.migrate.applied));

  const applied = await getAppliedVersions();
  const versions = applied.map((r) => r.version);
  check('schema_version 里有基线行（漂移防护）', versions.includes('0000-baseline'), versions.join(','));
  check('0001–0013 全部登记为已应用',
    Array.from({ length: 13 }, (_, i) => String(i + 1).padStart(4, '0')).every((v) => versions.includes(v)),
    versions.join(','));
  const baseline = applied.find((r) => r.version === '0000-baseline');
  check('基线行带 checksum 与可读的 applied_at',
    !!baseline && /^[0-9a-f]{64}$/.test(baseline.checksum) && /\d{4}-\d{2}-\d{2}/.test(baseline.applied_at),
    JSON.stringify(baseline));

  const tableRows = await pool.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  const tables = tableRows.map((r) => r.name);
  check('基线建出全部业务表（≥20 张）', tables.length >= 20, `${tables.length}: ${tables.join(',')}`);
  for (const t of ['users', 'connections', 'audit_events', 'alerts', 'auth_sessions', 'host_metrics_minute']) {
    check(`表 ${t} 存在`, tables.includes(t));
  }

  // 二次启动必须幂等：没有待执行的迁移，也不能重复登记基线
  const again = await ensureDatabaseReady();
  check('二次 ensureDatabaseReady 不重复应用迁移', again.migrate.applied.length === 0,
    JSON.stringify(again.migrate.applied));

  // ============ 三、users：大小写不敏感 + 权限位 + 登录痕迹 ============
  const now = new Date();
  await userRepo.insertUser({
    id: USER_ID,
    username: 'VerifyAdmin',
    displayName: 'Verify Admin',
    passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
    role: 'admin',
    status: 'active',
    permissions: {
      terminal: true, batch: true, ai: true, connections: true, aiConfig: true,
      files: true, monitor: true, audit: true, skills: false, snippets: false,
    },
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    lastLoginIp: '',
  });

  const foundLower = await userRepo.findUserByUsername('verifyadmin');
  check('username 大小写不敏感命中（COLLATE NOCASE）', foundLower?.id === USER_ID, foundLower?.id);
  const foundById = await userRepo.findUserById(USER_ID);
  check('读回的权限位正确', foundById?.permissions?.terminal === true && foundById?.permissions?.skills === false,
    JSON.stringify(foundById?.permissions));
  check('created_at 读回是 Date 且与写入相差 < 2s',
    foundById?.createdAt instanceof Date && Math.abs(foundById.createdAt.getTime() - now.getTime()) < 2000,
    String(foundById?.createdAt));

  await userRepo.updateUser(USER_ID, { displayName: 'Renamed Admin', permissions: { skills: true } });
  const afterUpdate = await userRepo.findUserById(USER_ID);
  check('updateUser 局部 SET 生效（displayName + 单个权限位）',
    afterUpdate?.displayName === 'Renamed Admin' && afterUpdate?.permissions?.skills === true, afterUpdate?.displayName);

  await userRepo.touchLogin(USER_ID, '10.0.0.9');
  const afterLogin = await userRepo.findUserById(USER_ID);
  check('touchLogin 落 last_login_at / last_login_ip',
    afterLogin?.lastLoginIp === '10.0.0.9' && afterLogin?.lastLoginAt instanceof Date,
    `${afterLogin?.lastLoginIp} / ${afterLogin?.lastLoginAt}`);

  check('countUsers ≥ 1', (await userRepo.countUsers()) >= 1);
  check('countActiveAdmins 能按 id 排除自己', (await userRepo.countActiveAdmins(USER_ID)) === 0,
    String(await userRepo.countActiveAdmins(USER_ID)));
  const members = await userRepo.listActiveMembers();
  check('listActiveMembers 含该账号且带显示名',
    members.some((m) => m.id === USER_ID && m.displayName === 'Renamed Admin'), JSON.stringify(members));

  // ============ 四、登录令牌：auth_sessions 表 ============
  const store = getTokenStore();
  const ttlSeconds = 60;
  const payloadA = JSON.stringify({ userId: USER_ID, kind: 'session', issuedAt: Date.now() });
  await store.issue(USER_ID, 'hash-a', payloadA, ttlSeconds);
  check('issue 后能按哈希读回 payload', (await store.read('hash-a')) === payloadA);
  const ttl = await store.ttl('hash-a');
  check('ttl 落在 (0, 60] 秒', ttl > 0 && ttl <= ttlSeconds, String(ttl));

  const renewed = await store.renew('hash-a', USER_ID, 3600, ttlSeconds);
  check('剩余不足阈值 → 续期返回满 TTL', renewed === ttlSeconds, String(renewed));

  // 单账号单会话：再签发一次必须把旧令牌顶掉（Redis 版靠 Lua，这里靠 DELETE + 唯一索引）
  const payloadB = JSON.stringify({ userId: USER_ID, kind: 'session', issuedAt: Date.now() });
  await store.issue(USER_ID, 'hash-b', payloadB, ttlSeconds);
  check('重新签发给该账号的旧令牌失效', (await store.read('hash-a')) === null);
  check('新令牌可读', (await store.read('hash-b')) === payloadB);
  check('库里同一 user_id 只有一行', Number((await pool.query(
    'SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?', [USER_ID],
  ))[0].n) === 1);

  await store.remove('hash-b', USER_ID);
  check('remove 删掉令牌', (await store.read('hash-b')) === null);
  await store.issue(USER_ID, 'hash-c', payloadA, ttlSeconds);
  // 直接读底层连接拿原生行：pool.query 会按方言把时间列还原成 Date，看不到库里的真实形态
  const rawToken = require('../dist/server/db/sqlite.js').getSqlite()
    .prepare('SELECT issued_at, expires_at FROM auth_sessions WHERE token_hash = ?').get('hash-c');
  check('时间列在库里是定宽文本（YYYY-MM-DD HH:MM:SS.mmm）',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(String(rawToken?.expires_at)), String(rawToken?.expires_at));
  check('issued_at / expires_at 相差 ≈ 60 秒',
    Math.abs(Date.parse(String(rawToken?.expires_at).replace(' ', 'T') + 'Z')
      - Date.parse(String(rawToken?.issued_at).replace(' ', 'T') + 'Z') - ttlSeconds * 1000) < 1500,
    `${rawToken?.issued_at} -> ${rawToken?.expires_at}`);
  const readBack = await pool.query('SELECT expires_at FROM auth_sessions WHERE token_hash = ?', ['hash-c']);
  check('读回时时间列自动还原为 Date（与 MySQL 驱动的读法一致）',
    readBack[0]?.expires_at instanceof Date, String(readBack[0]?.expires_at));
  await store.kick(USER_ID);
  check('kick 删掉该账号全部令牌', (await store.read('hash-c')) === null);
  check('kick 后表里不再有该账号的行', Number((await pool.query(
    'SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?', [USER_ID],
  ))[0].n) === 0);

  // ============ 五、connections：反引号标识符 + JSON 列 + 名称判重 ============
  await connRepo.insertConnection(OWNER, connectionEntity());
  const listed = await connRepo.listConnections(OWNER);
  check('insertConnection / listConnections 往返一致',
    listed.length === 1 && listed[0].id === CONN_ID && listed[0].port === 22, JSON.stringify(listed.map((c) => c.id)));
  check('options JSON 列能解析回对象', listed[0]?.options?.keepAlive === true, JSON.stringify(listed[0]?.options));
  check('terminal 子结构完整', listed[0]?.terminal?.cols === 120 && listed[0]?.terminal?.cursorStyle === 'block');
  check('密文字段原样返回（解密不在仓储层）', listed[0]?.password === 'enc:v1:fake', listed[0]?.password);
  check('isConnectionNameTaken 命中同名', await connRepo.isConnectionNameTaken(OWNER, 'lite-verify-host'));
  check('名称判重支持 exceptId（改自己不算重名）',
    !(await connRepo.isConnectionNameTaken(OWNER, 'lite-verify-host', CONN_ID)));

  await connRepo.replaceConnection(OWNER, connectionEntity({ name: 'renamed-host', enabled: false }));
  const replaced = await connRepo.getConnectionById(OWNER, CONN_ID);
  check('replaceConnection 整行覆盖', replaced?.name === 'renamed-host' && replaced?.enabled === false,
    `${replaced?.name}/${replaced?.enabled}`);
  const sampling = await connRepo.listConnectionsForSampling();
  check('listConnectionsForSampling 带出 owner_id', sampling.some((r) => r.ownerId === OWNER));

  // ============ 六、host_metrics：ON DUPLICATE KEY UPDATE + VALUES() + GREATEST() ============
  const bucket = new Date(Math.floor(Date.now() / 60000) * 60000);
  const metric = (cpu, mem) => ({
    ownerId: OWNER,
    connectionId: CONN_ID,
    hostname: 'lite-host',
    bucket,
    cpuPct: cpu,
    memPct: mem,
    diskPct: 40,
    diskTotalBytes: 1024 ** 3,
    diskUsedBytes: 400 * 1024 ** 2,
    load1: 1,
    load5: null,
    load15: null,
  });
  await metricsRepo.upsertMinuteMetric(metric(10, 50));
  await metricsRepo.upsertMinuteMetric(metric(20, 70));
  const series = await metricsRepo.listMinuteMetrics(OWNER, CONN_ID, new Date(bucket.getTime() - 1000),
    new Date(bucket.getTime() + 60000));
  check('同分钟两次写入合并成一行', series.length === 1, `rows=${series.length}`);
  check('samples 累加为 2', series[0]?.samples === 2, String(series[0]?.samples));
  check('avg 按样本数加权（(10+20)/2 = 15）', series[0]?.cpuPctAvg === 15, String(series[0]?.cpuPctAvg));
  check('max 取较大值（GREATEST → MAX）', series[0]?.cpuPctMax === 20, String(series[0]?.cpuPctMax));
  check('本次无值的 load5 保持 null（CASE WHEN VALUES(..) IS NULL）',
    series[0]?.load5Avg === null, String(series[0]?.load5Avg));
  const hosts = await metricsRepo.listMetricHosts(OWNER, new Date(bucket.getTime() - 1000));
  check('listMetricHosts 的 JOIN 子查询可用', hosts.length === 1 && hosts[0].samples === 2,
    JSON.stringify(hosts.map((h) => h.samples)));

  // ============ 七、audit：DATE_FORMAT 自定义函数 + LIKE 关键词 ============
  const auditId = `${OWNER}-audit-1`;
  const auditAt = Date.now() - 1000;
  await auditRepo.insertAuditEvent({
    id: auditId,
    ownerId: OWNER,
    timestamp: auditAt,
    sessionId: `${OWNER}-sess`,
    connectionId: CONN_ID,
    userMessage: 'check disk usage',
    tool: 'execute_command',
    command: 'df -h',
    result: 'Connection refused by remote host',
    duration: 12,
    status: 'error',
  });
  const { entries, total } = await auditRepo.queryAuditEvents({ ownerId: OWNER, limit: 10 });
  check('INSERT / SELECT 往返 1 条', total === 1 && entries.length === 1, `total=${total}`);
  check('occurred_at 时间戳往返误差 < 2s',
    Math.abs((entries[0]?.timestamp || 0) - auditAt) < 2000, `${entries[0]?.timestamp} vs ${auditAt}`);
  // audit_date 是纯日期列，读回必须是字符串：一旦被驱动当本地零点转成 Date，日期会漂一天
  const rawAuditDate = await pool.query('SELECT audit_date FROM audit_events WHERE owner_id = ?', [OWNER]);
  check('audit_date 读回 YYYY-MM-DD 字符串',
    typeof rawAuditDate[0]?.audit_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawAuditDate[0].audit_date),
    JSON.stringify(rawAuditDate[0]?.audit_date));
  const kw = await auditRepo.queryAuditEvents({ ownerId: OWNER, keyword: 'Connection refused', limit: 10 });
  check('关键词查询走 LIKE（lite 无 MATCH AGAINST）', kw.total === 1, `total=${kw.total}`);
  const kwMiss = await auditRepo.queryAuditEvents({ ownerId: OWNER, keyword: 'no-such-word', limit: 10 });
  check('关键词不命中 → 0 条', kwMiss.total === 0, `total=${kwMiss.total}`);
  const dates = await auditRepo.listAuditDates(OWNER);
  check('listAuditDates 走 DATE_FORMAT 自定义函数', dates.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(dates[0]),
    JSON.stringify(dates));

  // ============ 八、alerts：去重状态机 + open_key 生成列唯一索引 ============
  const svc = new AlertService();
  const line = '2026-11-26 10:00:00,001 [ERROR] /var/log/app.log: Connection refused to 10.0.0.5:5432 (pid 42)';
  const first = await svc.ingest({ ownerId: OWNER, connectionId: CONN_ID, rule: '(ERROR|FATAL)', level: 'error', line });
  check('首次 ingest → created/open', first.action === 'created' && first.alert?.status === 'open',
    `${first.action}/${first.alert?.status}`);
  const second = await svc.ingest({ ownerId: OWNER, connectionId: CONN_ID, rule: '(ERROR|FATAL)', level: 'error', line });
  check('同指纹再命中 → updated 且 occurrences = 2',
    second.action === 'updated' && second.alert?.occurrences === 2,
    `${second.action}/${second.alert?.occurrences}`);

  const resolved = await svc.resolve(OWNER, second.alert.id);
  check('resolve → resolved', resolved?.status === 'resolved', resolved?.status);
  const third = await svc.ingest({ ownerId: OWNER, connectionId: CONN_ID, rule: '(ERROR|FATAL)', level: 'error', line });
  check('resolved 后同指纹再命中 → 新开一条（open_key 生成列放行 NULL）',
    third.action === 'created' && third.alert?.id !== second.alert.id,
    `${third.action}/${third.alert?.id} vs ${second.alert?.id}`);
  const counts = await svc.list(OWNER, {});
  check('同一个连接上并存 resolved + open 两条', counts.items.length === 2, `items=${counts.items.length}`);
  check('计数接口区分状态', counts.counts.open === 1 && counts.counts.resolved === 1, JSON.stringify(counts.counts));

  // ============ 九、账号删除的级联清理 ============
  await userRepo.purgeOwnerData(OWNER);
  const left = Number((await pool.query('SELECT COUNT(*) AS n FROM audit_events WHERE owner_id = ?', [OWNER]))[0].n);
  check('purgeOwnerData 清掉业务数据（含 alerts/connections/audit）',
    left === 0 && Number((await pool.query('SELECT COUNT(*) AS n FROM alerts WHERE owner_id = ?', [OWNER]))[0].n) === 0,
    String(left));
  await userRepo.deleteUserRow(USER_ID);
  check('deleteUserRow 后再删返回 0 行', (await userRepo.deleteUserRow(USER_ID)) === 0);
} catch (e) {
  fail += 1;
  console.error(`  FAIL  脚本异常: ${e && e.stack ? e.stack : e}`);
} finally {
  // ============ 十、收尾 ============
  try {
    await pool.closePool();
    const probe = await pool.probeDatabase();
    check('closePool 之后能重新打开（WAL 均已合并）', probe.engine === 'sqlite');
  } catch (e) {
    check('closePool 之后能重新打开（WAL 均已合并）', false, String(e?.message || e));
  }
  await pool.closePool().catch(() => undefined);
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    check('临时目录已清理', !fs.existsSync(TMP_DIR), TMP_DIR);
  } catch (e) {
    check('临时目录已清理', false, String(e?.message || e));
  }

  console.log(`\n[lite] 通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
