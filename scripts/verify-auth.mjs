/**
 * 账号体系端到端验证（对已启动的服务）
 * 覆盖：登录签发 / 待授权限制 / 权限拦截 / 数据隔离 / 单点登录踢人 / 滑动续期 / 只读监控令牌 / 删号下线
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
/**
 * 口令字段一律以密文上行（服务端拒收明文），直接用服务端的同一实现。
 * 这里是 Node 侧，不依赖浏览器环境。
 */
const { sealString } = require(path.join(root, 'dist/server/utils/transport-crypto.js'));
const seal = (plain) => sealString(plain);
/**
 * TTL 与续期阈值从服务端同一份实现取，而不是在断言里再写一遍 7200。
 * 它们现在是配置项（auth.tokenTtlSeconds），写死等于让改了配置的部署跑出假失败。
 */
const { tokenTtl, tokenTtlSeconds, tokenRenewThresholdSeconds } = require(path.join(root, 'dist/server/service/auth.service.js'));
const TTL = tokenTtlSeconds();
const RENEW_THRESHOLD = tokenRenewThresholdSeconds();
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
  const adminLogin = await post('/oauth/token', { grant_type: 'password', username: ADMIN_USER, password: seal(ADMIN_PASS) });
  const tokA = adminLogin.json?.access_token;
  check('管理员登录签发 Bearer 令牌', adminLogin.status === 200 && !!tokA, `status=${adminLogin.status}`);
  check(`令牌有效期 = auth.tokenTtlSeconds (${TTL}s)`, adminLogin.json?.expires_in === TTL, `expires_in=${adminLogin.json?.expires_in}`);
  if (!tokA) throw new Error('管理员登录失败，后续无法验证');

  // 2. 自助注册 -> pending
  const reg = await post('/api/auth/register', { username: U1, password: seal(PASS), displayName: '验证账号' });
  const u1 = reg.json?.data?.user;
  check('自助注册成功且状态 pending', reg.status === 200 && u1?.status === 'pending', `status=${reg.status} user.status=${u1?.status}`);

  // 3. pending 账号可以登录，但业务接口一律 403
  const pendingLogin = await post('/oauth/token', { grant_type: 'password', username: U1, password: seal(PASS) });
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

  const u1Login = await post('/oauth/token', { grant_type: 'password', username: U1, password: seal(PASS) });
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
  const u1Login2 = await post('/oauth/token', { grant_type: 'password', username: U1, password: seal(PASS) });
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

  // 9. 滑动续期：把 TTL 压到续期阈值以下，再发一次请求应回满
  const { getRedis, redisKey } = require(path.join(root, 'dist/server/db/redis.js'));
  const redis = await getRedis();
  const hash = crypto.createHash('sha256').update(tokU2).digest('hex');
  const low = Math.max(1, RENEW_THRESHOLD - 60);
  await redis.expire(redisKey('token:' + hash), low);
  const before = await tokenTtl(tokU2);
  await post('/api/auth/me', {}, tokU2);
  const after = await tokenTtl(tokU2);
  check(`剩余 <${RENEW_THRESHOLD}s 时一次操作即续期到 ${TTL}s`, before <= low && after > TTL - 60, `before=${before}s after=${after}s`);

  // 10. TTL 充足时不续期（否则等于永不失效）
  const steadyStart = RENEW_THRESHOLD + 900;
  await redis.expire(redisKey('token:' + hash), steadyStart);
  await post('/api/auth/me', {}, tokU2);
  const steady = await tokenTtl(tokU2);
  check('TTL 充足时不做续期', steady > steadyStart - 100 && steady <= steadyStart, `ttl=${steady}s`);

  // 11. 登出吊销
  await post('/oauth/revoke', { token: tokU2 });
  const afterLogout = await post('/api/auth/me', {}, tokU2);
  check('登出后令牌立即失效', afterLogout.status === 401, `status=${afterLogout.status}`);

  // 11b. 只读监控令牌：能读大屏端点，别处一律拒绝，且不占单点登录名额
  const grantMonitor = await post('/api/users/update', {
    id: u1.id,
    permissions: { connections: true, terminal: true, files: true, monitor: true },
  }, tokA);
  check('管理员给 U1 补 monitor 位', grantMonitor.status === 200, `status=${grantMonitor.status}`);
  const u1Login3 = await post('/oauth/token', { grant_type: 'password', username: U1, password: seal(PASS) });
  const tokU3 = u1Login3.json?.access_token;
  check('补权限后重新登录成功', !!tokU3, `status=${u1Login3.status}`);

  const issued = await post('/api/auth/createWatchToken', { label: 'verify-wall' }, tokU3);
  const watchToken = issued.json?.data?.token;
  const watchId = issued.json?.data?.brief?.id;
  check('签发只读令牌（aow_ 前缀）', issued.status === 200 && String(watchToken).startsWith('aow_'), `status=${issued.status}`);

  const watchOk = await post('/api/watch/overview', {}, watchToken);
  check('只读令牌能读 /api/watch/overview', watchOk.status === 200 && !!watchOk.json?.data?.alerts, `status=${watchOk.status}`);

  const watchMe = await post('/api/auth/me', {}, watchToken);
  // 401 而不是 403：三个宿主只对 /api/watch/* 打开 allowWatch，前缀在鉴权那层就被挡了。
  // handleAccountRoutes 里的 403 是第二道门（今后若有宿主放宽 allowWatch，账号接口仍然进不去）。
  check('只读令牌被账号接口拒绝（401）', watchMe.status === 401, `status=${watchMe.status}`);

  const watchConn = await post('/api/connection/getConnections', {}, watchToken);
  check('只读令牌不能读连接接口（401）', watchConn.status === 401, `status=${watchConn.status}`);

  const watchMonitor = await post('/api/monitor/listMonitors', {}, watchToken);
  check('只读令牌不能冒用 monitor 接口（401）', watchMonitor.status === 401, `status=${watchMonitor.status}`);

  const alive = await post('/api/auth/me', {}, tokU3);
  check('大屏令牌不占单点登录名额（原会话仍有效）', alive.status === 200, `status=${alive.status}`);

  const list = await post('/api/auth/listWatchTokens', {}, tokU3);
  check('签发后清单里能看到这一枚',
    (list.json?.data || []).some((t) => t.id === watchId && t.state === 'active'), `count=${(list.json?.data || []).length}`);

  const rev = await post('/api/auth/revokeWatchToken', { id: watchId }, tokU3);
  const watchGone = await post('/api/watch/overview', {}, watchToken);
  check('吊销后令牌立即失效', rev.status === 200 && watchGone.status === 401, `revoke=${rev.status} use=${watchGone.status}`);

  // 12. 删号 = 数据一起清。业务表之间没有外键级联，靠 deleteUserByAdmin 主动清；
  //     这里直接查库验证，只看接口返回 200 是看不出有没有留下孤儿数据的。
  const { query, closePool } = require(path.join(root, 'dist/server/db/pool.js'));
  const ownedBefore = await query('SELECT COUNT(*) AS c FROM connections WHERE owner_id = ?', [u1.id]);
  check('删号前该账号名下有连接数据', Number(ownedBefore[0]?.c) > 0, `c=${ownedBefore[0]?.c}`);

  const del = await post('/api/users/delete', { id: u1.id }, tokA);
  check('管理员删除账号', del.status === 200, `status=${del.status}`);

  const ownedAfter = await query('SELECT COUNT(*) AS c FROM connections WHERE owner_id = ?', [u1.id]);
  check('删号后其连接数据一并清除', Number(ownedAfter[0]?.c || 0) === 0, `left=${ownedAfter[0]?.c}`);
  const watchLeft = await query('SELECT COUNT(*) AS c FROM auth_watch_tokens WHERE owner_id = ?', [u1.id]);
  check('删号后其只读令牌一并清除', Number(watchLeft[0]?.c || 0) === 0, `left=${watchLeft[0]?.c}`);
  const ghost = await post('/oauth/token', { grant_type: 'password', username: U1, password: seal(PASS) });
  check('已删账号无法登录', ghost.status === 401, `status=${ghost.status}`);

  // 13. 错误口令统一 invalid_grant（不泄露账号是否存在）
  const badPass = await post('/oauth/token', { grant_type: 'password', username: U1, password: seal('wrong-pass') });
  check('密码错误返回 401 invalid_grant', badPass.status === 401 && badPass.json?.error === 'invalid_grant', `error=${badPass.json?.error}`);

  // 13b. 明文口令一律拒收：链路上不允许出现可读的口令
  const plainPass = await post('/oauth/token', { grant_type: 'password', username: U1, password: 'wrong-pass' });
  check('明文口令被拒（cipher_required）', plainPass.status === 400 && plainPass.json?.error === 'cipher_required',
    `status=${plainPass.status} error=${plainPass.json?.error}`);

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
