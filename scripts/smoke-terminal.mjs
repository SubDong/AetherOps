/**
 * 终端链路冒烟测试
 *
 * 用途：验证「构建产物 + 原生依赖（node-pty）+ WS 传输层」这条主干是否真的通。
 * 做法：创建一个本地 shell 会话 -> 通过 WS 下发命令 -> 断言命令回显与执行结果都回来了。
 *
 * 前置：先启动后端（默认 127.0.0.1:9802）
 *   pnpm run build && node server.js
 *   node scripts/smoke-terminal.mjs          # 或 pnpm run smoke
 *
 * 退出码：0 = 通过，1 = 失败（可直接用于 CI 冒烟阶段）
 */
import WebSocket from 'ws';

// 后端只读 PORT（见 server.js：portFromArgs || process.env.PORT || 9802）
const PORT = process.env.PORT || 9802;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}/ws/terminal`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.ret !== 0) throw new Error(`${path} failed: ${json.msg}`);
  return json.data;
}

const marker = `AETHER_SMOKE_${Date.now().toString(36)}`;
const sessionId = `smoke-${Date.now().toString(36)}`;
const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';

// 1) 建一个临时本地连接（结束后删除，不留垃圾数据）
const conn = await api('/api/connection/addConnection', {
  name: `__smoke_${marker}__`,
  type: 'local',
  shell,
});
console.log(`[smoke] temp connection created: ${conn.id} (shell=${shell})`);

// 2) 走 WS 建会话并收集终端输出
const ws = new WebSocket(WS_URL);
let output = '';
let serverSessionId = null;
let serverError = null;

ws.on('open', () => {
  console.log('[smoke] ws open');
  ws.send(JSON.stringify({
    type: 'create',
    sessionId,
    data: { connectionId: conn.id, cols: 80, rows: 24, name: 'smoke' },
  }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.sessionId) serverSessionId = msg.sessionId;
  if (msg.type === 'terminal') {
    output += msg.binary ? Buffer.from(msg.data, 'base64').toString('utf-8') : msg.data;
  } else if (msg.type === 'status') {
    console.log(`[smoke] session status: ${msg.data}`);
  } else if (msg.type === 'error') {
    serverError = msg.data;
    console.log(`[smoke] server error: ${msg.data}`);
  }
});

ws.on('error', (e) => console.log(`[smoke] ws error: ${e.message}`));

// 3) 等 shell 就绪（本地会话启动时会先注入 chcp 等初始化命令，过早写入会被吞掉）
await sleep(6000);
const sid = serverSessionId || sessionId;
ws.send(JSON.stringify({ type: 'terminal', sessionId: sid, data: '\r\n' }));
await sleep(1500);
ws.send(JSON.stringify({ type: 'terminal', sessionId: sid, data: `echo ${marker}\r\n` }));

// 4) 轮询等待输出，最长 15s（出现两次 marker = 命令回显 + 执行结果）
const countMarker = () => output.split(marker).length - 1;
const deadline = Date.now() + 15000;
while (Date.now() < deadline && countMarker() < 2) {
  await sleep(500);
}

const echoed = countMarker();
const passed = echoed >= 2 && !serverError;

console.log(`[smoke] captured ${output.length} bytes, marker occurrences=${echoed}`);
if (!passed) {
  console.log('[smoke] raw output:', JSON.stringify(output));
}
console.log(passed
  ? '[smoke] RESULT: PASS ✅  (WS -> PTY -> 命令执行 -> 输出回传 全链路可用)'
  : '[smoke] RESULT: FAIL ❌  (见上方原始输出定位卡点)');

// 5) 清理
ws.send(JSON.stringify({ type: 'close', sessionId: sid }));
await sleep(500);
ws.close();
await api('/api/connection/deleteConnection', { id: conn.id });
console.log('[smoke] temp connection removed');
process.exit(passed ? 0 : 1);
