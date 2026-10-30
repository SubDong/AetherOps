/**
 * 账号体系端到端验证（对已启动的服务）
 * 覆盖：登录签发 / 待授权限制 / 权限拦截 / 数据隔离 / 单点登录踢人 / 滑动续期 / 删号下线
 *
 * 用法：node scripts/verify-auth.mjs
 *   BASE=http://127.0.0.1:18080 ADMIN_USER=admin ADMIN_PASS=xxx node scripts/verify-auth.mjs
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const BASE = process.env.BASE || 'http://127.0.0.1:18080';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`);
}

async function post(pathname, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(BASE + pathname, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  let json = null;
  try { json = await resp.json(); } catch { /* 非 JSON 响应 */ }
  return { status: resp.status, json };
}

const U1 = 'verify_u' + Date.now().toString(36).slice(-5);
const PASS = 'Passw0rd!23';

async function main() {
  // 1. 管理员登录
  const adminLogin = await post('/oauth/token', { grant_type: 'password', username: ADMIN_USER, password: ADMIN_PASS });
  const tokA = adminLogin.json?.access_token;
  check('管理员登录签发 Bearer 令牌', adminLogin.status === 200 && !!tokA, `status=${adminLogin.status}`);
  check('令牌有效期 7200s', adminLogin.json?.expires_in === 7200, `expires_in=${adminLogin.json?.expires_in}`);
  if (!tokA) throw new Error('管理员登录失败，后续无法验证');

  // 2. 自助注册 -> pending
  const reg = await post('/api/auth/register', { username: U1, password: PASS, displayName: '验证账号' });
  const u1 = reg.json?.data?.user;
  check('自助注册成功且状态 pending', reg.status === 200 && u1?.status === 'pending', `status=${reg.status} user.status=${u1?.status}`);

  // 3. pending 账号可以登录，但业务接口一律 403
  const pendingLogin = await post('/oauth/token', { grant_type: 'password', username: U1, password: PASS });
  const tokPending = pendingLogin.json?.access_token;
  const pendingCall = await post('/api/connection/getConnections', {}, tokPending);
  check('待授权账号登录后调用业务接口被 403 拦截', pendingCall.status === 403, `status=${pendingCall.status}`);

  // 4. 管理员授权：激活 + 只给 connections/terminal/files
  const upd = await post('/api/users/update', {
    id: u1.id,
    status: 'active',
    permissions: { connections: true, terminal: true, files: true },
  }, tokA);
  check('管理员激活并授权', upd.status === 200 && upd.json?.data?.status === 'active', `status=${upd.status}`);

  // 5. 改权限会踢掉旧会话
  const oldTokenAfterUpdate = await post('/api/auth/me', {}, tokPending);
  check('改权限后旧令牌立即失效', oldTokenAfterUpdate.status === 401, `status=${oldTokenAfterUpdate.status}`);

  const u1Login = await post('/oauth/token', { grant_type: 'password', username: U1, password: PASS });
  const tokU = u1Login.json?.access_token;
  check('授权后登录成功', u1Login.status === 200 && !!tokU, `status=${u1Login.status}`);

  // 6. 隔离：U1 建连接，管理员看不到
  const add = await post('/api/connection/addConnection', {
    name: 'verify-conn-' + U1,
    host: '127.0.0.1',
    port: 22,
    username: 'demo',
    password: 'demo',
  }, tokU);
  const connId = add.json?.data?.id;
  check('U1 新增连接成功', add.status === 200 && !!connId, `status=${add.status} id=${connId}`);

  const u1List = await post('/api/connection/getConnections', {}, tokU);
  const adminList = await post('/api/connection/getConnections', {}, tokA);
  const u1Ids = (u1List.json?.data || []).map((c) => c.id);
  const adminIds = (adminList.json?.data || []).map((c) => c.id);
  check('U1 只能看到自己的连接', u1Ids.length === 1 && u1Ids[0] === connId, `u1=${u1Ids.length}`);
  check('管理员看不到 U1 的连接（角色不绕过隔离）', !adminIds.includes(connId), `admin=${adminIds.length}`);

  const adminPeek = await post('/api/connection/getConnection', { id: connId }, tokA);
  check('管理员按 id 直取 U1 的连接拿不到数据', adminPeek.status !== 200 || !adminPeek.json?.data,
    `status=${adminPeek.status} body=${String(JSON.stringify(adminPeek.json)).slice(0, 60)}`);

  // 7. 单点登录：再次登录踢掉上一个令牌
  const u1Login2 = await post('/oauth/token', { grant_type: 'password', username: U1, password: PASS });
  const tokU2 = u1Login2.json?.access_token;
  const kicked = await post('/api/connection/getConnections', {}, tokU);
  check('同账号二次登录后旧令牌失效（单点登录）', kicked.status === 401, `status=${kicked.status}`);

  // 8. 权限拦截：没有 monitor / snippets 权限
  const noMonitor = await post('/api/monitor/listMonitors', {}, tokU2);
  const noSnippet = await post('/api/snippet/list', {}, tokU2);
  check('未授权的 monitor 接口被 403', noMonitor.status === 403, `status=${noMonitor.status}`);
  check('未授权的 snippet 接口被 403', noSnippet.status === 403, `status=${noSnippet.status}`);

  const notAdmin = await post('/api/users/list', {}, tokU2);
  check('普通账号调用账号管理接口被 403', notAdmin.status === 403, `status=${notAdmin.status}`);

  // 9. 滑动续期：TTL 压到 300s（低于 1000s 阈值），再发一次请求应回满 7200s
  const { getRedis, redisKey } = require(path.join(root, 'dist/server/db/redis.js'));
  const { tokenTtl } = require(path.join(root, 'dist/server/service/auth.service.js'));
  const redis = await getRedis();
  const hash = crypto.createHash('sha256').update(tokU2).digest('hex');
  await redis.expire(redisKey('token:' + hash), 300);
  const before = await tokenTtl(tokU2);
  await post('/api/auth/me', {}, tokU2);
  const after = await tokenTtl(tokU2);
  check('剩余 <1000s 时一次操作即续期到 7200s', before <= 300 && after > 7000, `before=${before}s after=${after}s`);

  // 10. TTL 充足时不续期（否则等于永不失效）
  await redis.expire(redisKey('token:' + hash), 5000);
  await post('/api/auth/me', {}, tokU2);
  const steady = await tokenTtl(tokU2);
  check('TTL 充足时不做续期', steady > 4000 && steady <= 5000, `ttl=${steady}s`);

  // 11. 登出吊销
  await post('/oauth/revoke', { token: tokU2 });
  const afterLogout = await post('/api/auth/me', {}, tokU2);
  check('登出后令牌立即失效', afterLogout.status === 401, `status=${afterLogout.status}`);

  // 12. 删号 = 数据一起清。业务表之间没有外键级联，靠 deleteUserByAdmin 主动清；
  //     这里直接查库验证，只看接口返回 200 是看不出有没有留下孤儿数据的。
  const { query, closePool } = require(path.join(root, 'dist/server/db/pool.js'));
  const ownedBefore = await query('SELECT COUNT(*) AS c FROM connections WHERE owner_id = ?', [u1.id]);
  check('删号前该账号名下有连接数据', Number(ownedBefore[0]?.c) > 0, `c=${ownedBefore[0]?.c}`);

  const del = await post('/api/users/delete', { id: u1.id }, tokA);
  check('管理员删除账号', del.status === 200, `status=${del.status}`);

  const ownedAfter = await query('SELECT COUNT(*) AS c FROM connections WHERE owner_id = ?', [u1.id]);
  check('删号后其连接数据一并清除', Number(ownedAfter[0]?.c || 0) === 0, `left=${ownedAfter[0]?.c}`);
  const ghost = await post('/oauth/token', { grant_type: 'password', username: U1, password: PASS });
  check('已删账号无法登录', ghost.status === 401, `status=${ghost.status}`);

  // 13. 错误口令统一 invalid_grant（不泄露账号是否存在）
  const badPass = await post('/oauth/token', { grant_type: 'password', username: U1, password: 'wrong-pass' });
  check('密码错误返回 401 invalid_grant', badPass.status === 401 && badPass.json?.error === 'invalid_grant', `error=${badPass.json?.error}`);

  // 14. 终端 WebSocket 门禁：没令牌直接关连接，有令牌才放行
  const WS = require('ws');
  const wsUrl = BASE.replace(/^http/, 'ws') + '/ws/terminal';
  const wsNoToken = await new Promise((resolve) => {
    const sock = new WS(wsUrl);
    sock.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
    sock.on('error', () => resolve({ code: -1, reason: 'error' }));
    setTimeout(() => { try { sock.close(); } catch { /* ignore */ } resolve({ code: 0, reason: 'still-open' }); }, 3000);
  });
  check('WS 无令牌被拒', wsNoToken.code === 1008, `code=${wsNoToken.code} reason=${wsNoToken.reason}`);

  const wsWithToken = await new Promise((resolve) => {
    const sock = new WS(wsUrl + '?token=' + encodeURIComponent(tokA));
    sock.on('open', () => resolve({ open: true }));
    sock.on('close', (code, reason) => resolve({ open: false, code, reason: String(reason) }));
    sock.on('error', (e) => resolve({ open: false, code: -1, reason: e.message }));
    setTimeout(() => { try { sock.close(); } catch { /* ignore */ } }, 2000);
  });
  check('WS 带令牌可建立连接', wsWithToken.open === true, `open=${wsWithToken.open} reason=${wsWithToken.reason || ''}`);

  // 15. ?token= 只给 WS 用：普通 HTTP 接口不再接受 URL 里的令牌
  const queryOnly = await fetch(`${BASE}/api/auth/me?token=${encodeURIComponent(tokA)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  check('HTTP 不再接受 ?token= 传令牌', queryOnly.status === 401, `status=${queryOnly.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) {
    for (const f of failed) console.log(`未通过: ${f.name} | ${f.detail}`);
  }
  await redis.quit().catch(() => {});
  await closePool().catch(() => {});
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(2);
});
