/**
 * P1 第 1 片：search_audit 的端到端校验（真实库）。
 *
 * 验证的是三件最容易出错的事：
 * 1. connection_id 真的进了 WHERE（以前只出现在 SELECT 里，查不了主机）；
 * 2. 时间窗按 occurred_at 走，且与日志保留期口径一致（跨天能查到、超期查不到）；
 * 3. 工具的账号隔离 —— ownerId 只从 ctx.custom 取，换一个 owner 就查不到别人的流水。
 *
 * 会临时插几条审计行，owner 用随机前缀，跑完按前缀删干净，不碰真实账号的数据。
 *
 * 用法：node scripts/verify-search-audit.mjs（先 pnpm build-server；需要可连的 MySQL）
 */
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { AuditService } = require('../dist/server/service/audit.service.js');
const { AIService } = require('../dist/server/service/ai.service.js');
const repo = require('../dist/server/db/repositories/audit.repo.js');
const { execute, closePool } = require('../dist/server/db/pool.js');

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

const OWNER = `verify-audit-${Date.now()}`;
const OTHER = `${OWNER}-other`;
const CONN_A = `conn-${Date.now()}-a`;
const CONN_B = `conn-${Date.now()}-b`;
const svc = new AuditService();

/** 30 小时前的那条：用来证明时间窗真的生效（log() 会强制用当前时间，只能直插） */
async function seedOld() {
  await repo.insertAuditEvent({
    id: crypto.randomUUID(),
    ownerId: OWNER,
    timestamp: Date.now() - 30 * 3600_000,
    sessionId: 'verify-old-session',
    sessionName: 'old-web',
    connectionId: CONN_A,
    userMessage: '',
    tool: 'execute_command',
    command: 'yum install -y nginx',
    result: 'Complete!',
    duration: 4200,
    status: 'success',
  });
}

try {
  // ---- 造数据：CONN_A 三条 + CONN_B 一条 + 他人一条 + 30h 前一条 ----
  await svc.log(OWNER, {
    sessionId: 'verify-s1', sessionName: 'web-1', connectionId: CONN_A,
    userMessage: 'nginx 起不来', tool: 'execute_command',
    command: 'nginx -t', result: 'nginx: [emerg] unknown directive "gzip_static"',
    duration: 120, status: 'error',
  });
  await svc.log(OWNER, {
    sessionId: 'verify-s1', sessionName: 'web-1', connectionId: CONN_A,
    userMessage: 'nginx 起不来', tool: 'execute_command',
    command: 'nginx -t', result: 'nginx: configuration file test is successful',
    duration: 90, status: 'success',
  });
  await svc.log(OWNER, {
    sessionId: 'verify-s1', sessionName: 'web-1', connectionId: CONN_A,
    userMessage: '清空根目录', tool: 'execute_command',
    command: 'rm -rf /', result: 'BLOCKED: high-risk destructive command requires manual execution',
    duration: 0, status: 'blocked',
  });
  await svc.log(OWNER, {
    sessionId: 'verify-s2', sessionName: 'db-1', connectionId: CONN_B,
    userMessage: '', tool: 'execute_command',
    command: 'uptime', result: ' 10:00:00 up 3 days', duration: 40, status: 'success',
  });
  await svc.log(OTHER, {
    sessionId: 'verify-other', sessionName: 'other-1', connectionId: CONN_A,
    userMessage: '', tool: 'execute_command',
    command: 'nginx -t', result: 'ok', duration: 30, status: 'success',
  });
  await seedOld();

  // ---- 一、仓储 / 服务层 ----
  const inWindow = await svc.search(OWNER);
  check('默认 24h 窗口只返回窗口内的行', inWindow.total === 4, `total=${inWindow.total}`);
  check('30 小时前那条不在 24h 窗口里', !inWindow.entries.some((e) => e.command === 'yum install -y nginx'));

  const a24 = await svc.search(OWNER, { connectionId: CONN_A });
  check('按 connectionId 过滤（24h）', a24.total === 3, `total=${a24.total}`);
  check('过滤结果全部属于该连接', a24.entries.every((e) => e.connectionId === CONN_A));

  const a48 = await svc.search(OWNER, { connectionId: CONN_A, hours: 48 });
  check('放宽到 48h 能查到 30 小时前那条', a48.total === 4, `total=${a48.total}`);
  check('48h 里包含那条旧命令', a48.entries.some((e) => e.command === 'yum install -y nginx'));

  const byKeyword = await svc.search(OWNER, { keyword: 'gzip_static' });
  check('keyword 走 LIKE 兜底命中（带下划线的词）', byKeyword.total === 1, `total=${byKeyword.total}`);
  check('命中那条是失败记录', byKeyword.entries[0]?.status === 'error', byKeyword.entries[0]?.status);

  const aSuccessNginx = await svc.search(OWNER, { connectionId: CONN_A, keyword: 'nginx', status: 'success' });
  check('connectionId + keyword + status 三者叠加', aSuccessNginx.total === 1, `total=${aSuccessNginx.total}`);
  const aNginx = await svc.search(OWNER, { connectionId: CONN_A, keyword: 'nginx' });
  check('去掉 status 后同一关键词命中两条（证明 status 真的在收窄）', aNginx.total === 2, `total=${aNginx.total}`);

  const blocked = await svc.search(OWNER, { status: 'blocked' });
  check('status 过滤生效', blocked.total === 1 && blocked.entries[0].command === 'rm -rf /');

  const noneTool = await svc.search(OWNER, { tool: 'file-transfer' });
  check('tool 过滤生效（本账号没有传输记录）', noneTool.total === 0, `total=${noneTool.total}`);

  const crossOwner = await svc.search(OTHER, { connectionId: CONN_A });
  check('另一个账号查不到本账号的流水', crossOwner.total === 1 && crossOwner.entries[0].command === 'nginx -t',
    `total=${crossOwner.total}`);

  const clamped = await svc.search(OWNER, { hours: 99999 });
  check('hours 被夹到 720（与 30 天保留期对齐）', clamped.hours === 720, `hours=${clamped.hours}`);

  const apiPath = await svc.getLogs(OWNER, { connectionId: CONN_B });
  check('getLogs（/api/audit/getLogs 走的路径）也认 connectionId', apiPath.total === 1, `total=${apiPath.total}`);

  // ---- 二、工具层 ----
  const svcAI = new AIService(undefined, undefined, svc, undefined);
  const defs = svcAI.getToolDefinitions();
  const def = defs.find((d) => d.function?.name === 'search_audit');
  check('search_audit 已注册', !!def);
  check('工具声明了 6 个参数', def && Object.keys(def.function.parameters.properties).length === 6,
    def ? Object.keys(def.function.parameters.properties).join(',') : '');
  check('status 参数是枚举', !!def?.function.parameters.properties.status?.enum);
  check('另有其他工具仍在（P4 时共 4 个，P6 后 9 个）', defs.length === 9, `toolCount=${defs.length}`);

  const registry = svcAI.toolRegistry;
  const ctxOf = (ownerId) => ({ sessionId: 'chat_verify', custom: { ownerId } });

  const toolOut = await registry.execute('search_audit', { connection_id: CONN_A }, ctxOf(OWNER));
  check('工具输出带命中统计', /Matched 3 of 3 entries within the last 24h/.test(toolOut), toolOut.split('\n')[0]);
  check('工具输出带连接标识', toolOut.includes(`conn=${CONN_A}`));
  check('工具输出带命令与结果摘要', toolOut.includes('cmd: nginx -t') && toolOut.includes('out: nginx: [emerg]'));

  const limited = await registry.execute('search_audit', { connection_id: CONN_A, limit: 1 }, ctxOf(OWNER));
  check('limit 生效并提示剩余条数', /Matched 1 of 3/.test(limited) && /2 more not shown/.test(limited),
    limited.split('\n').slice(-1)[0]);

  const emptyOut = await registry.execute('search_audit', { keyword: 'zzz-no-such-thing' }, ctxOf(OWNER));
  check('空结果明确说明覆盖边界（手敲命令不在内）', /typed by hand/.test(emptyOut), emptyOut.slice(0, 60));

  const isolated = await registry.execute('search_audit', { connection_id: CONN_A }, ctxOf(OTHER));
  check('工具按 ctx.custom.ownerId 隔离，不越权', /Matched 1 of 1/.test(isolated), isolated.split('\n')[0]);

  const noOwner = await registry.execute('search_audit', { keyword: 'nginx' }, { sessionId: 'chat_x', custom: {} });
  check('没有 ownerId 时直接拒绝', noOwner.startsWith('AUDIT_UNAVAILABLE'), noOwner);

  const badStatus = await registry.execute('search_audit', { status: 'oops' }, ctxOf(OWNER));
  check('非法 status 给出可用的取值范围', /Invalid status/.test(badStatus) && /blocked/.test(badStatus), badStatus);

  // ---- 三、审计覆盖：新工具自己的调用也必须留一行 ----
  // 钩子是挂在 engine 上的 after_tool，对所有工具生效；这里直接触发它，
  // 验的是「新工具没被漏到审计之外」，而不是重测 execute_command。
  const hooks = svcAI.buildHooks(OWNER, '');
  const auditHook = hooks.find((h) => h.name === 'audit-tool-call');
  check('after_tool 审计钩子已注册', !!auditHook);
  await auditHook.handler({
    tool: 'search_audit', args: { keyword: 'nginx' }, result: 'Matched 1 of 1', duration: 7, isError: false,
  });
  const hookRows = await repo.queryAuditEvents({
    ownerId: OWNER, tool: 'search_audit', fromTs: Date.now() - 3600_000,
  });
  check('search_audit 的调用会落审计行', hookRows.total === 1, `total=${hookRows.total}`);
  check('审计行记下了参数（可回溯模型查了什么）',
    /keyword/.test(hookRows.entries[0]?.command || ''), hookRows.entries[0]?.command);
  check('审计行没有把空结果当成 error', hookRows.entries[0]?.status === 'success', hookRows.entries[0]?.status);
} finally {
  await execute('DELETE FROM audit_events WHERE owner_id LIKE ?', ['verify-audit-%']);
  const left = await repo.queryAuditEvents({ ownerId: OWNER, fromTs: Date.now() - 3 * 24 * 3600_000 });
  check('清理干净（本账号无残留）', left.total === 0, `left=${left.total}`);
  await closePool();
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
