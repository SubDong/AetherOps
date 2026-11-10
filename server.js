#!/usr/bin/env node

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const WebSocket = require('ws');

// 统一数据目录管理（所有写入文件必须通过此模块获取路径）
const { ensureDataDir, getDataPath } = require('./dist/server/utils/data-dir');
// 统一配置入口：优先级 环境变量 > ~/.aetherops/config.json > 内置默认值
const { loadConfig, validateConfig, describeDatabase, getConfigPath } = require('./dist/server/utils/config');
const {
  isAllowedOrigin,
  extractBearerToken,
  normalizeUploadName,
  maxUploadBytes,
} = require('./dist/server/utils/security');
// 终端 socket 的共享登记表：紧急断开由业务层触发，但它拿不到 wss，只能靠这张表找到人
const { registerTerminalSocket, unregisterTerminalSocket } = require('./dist/server/utils/socket-registry');
const dataDir = ensureDataDir();
// 账号体系：登录/注册/OAuth2 令牌/账号管理这些端点在两种宿主里共用同一份实现
const { PUBLIC_PATHS, handleAccountRoutes } = require('./dist/server/routes/auth.routes');

// 配置文件损坏（非法 JSON 等）必须立即退出：继续跑等于拿默认空配置去连库
let appConfig;
try {
  appConfig = loadConfig();
} catch (err) {
  console.error('[FATAL] 配置加载失败:', err.message);
  process.exit(1);
}
// 数据库配置不完整 = 不起。存储层已切到 MySQL（server/db），没有任何「降级回
// JSON 文件」的分支：宁可启动失败并打印人话原因，也不要两套存储并存导致
// 用户以为数据写进了库、实际始终在本地文件里。
const configProblems = validateConfig(appConfig);
if (configProblems.length) {
  console.error('[FATAL] 数据库配置不完整: ' + configProblems.join('; '));
  console.error('[FATAL] 请编辑 ' + getConfigPath() + '（或用 AETHEROPS_DB_* 环境变量提供）');
  process.exit(1);
}
console.log('[config] database -> ' + describeDatabase(appConfig.database));

const uploadLimitBytes = maxUploadBytes();

// 日志文件路径（写入数据目录，非安装目录）
const logFilePath = getDataPath('server.log');
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
  const output = args.map(a => {
    if (typeof a === 'object') return JSON.stringify(a);
    return String(a);
  }).join(' ') + '\n';
  logStream.write(`[${new Date().toISOString()}] ${output}`);
  originalLog.apply(console, args);
};

console.error = function (...args) {
  const output = args.map(a => {
    if (typeof a === 'object') return JSON.stringify(a);
    return String(a);
  }).join(' ') + '\n';
  logStream.write(`[${new Date().toISOString()}] [ERROR] ${output}`);
  originalError.apply(console, args);
};

// 创建 express 应用
const app = express();
const server = http.createServer(app);

// 静态文件目录
const staticDir = path.join(__dirname, 'dist');

// 解析 JSON 请求体
app.use(express.json());

// 检查 server 构建产物
const serverIndexPath = path.join(__dirname, 'dist/server/index.js');
// 打包态（VSCode 扩展 runtime）下服务端已内联进本文件，dist/server 已被删除，
// 跳过此校验；开发态仍保留校验以提供友好报错。
if (!process.env.AETHEROPS_BUNDLED && !fs.existsSync(serverIndexPath)) {
  console.error(`[ERROR] 找不到 server 构建产物: ${serverIndexPath}`);
  console.error('[ERROR] 请先运行构建: pnpm run build-only');
  process.exit(1);
}

// 访问控制：改用账号体系的 OAuth2 Bearer 令牌（此前是单一全局 access-token）。
// 登录态在这里统一解析，后面的 /api/* 与 WebSocket 直接读 req.user / ws.user。
app.use(async (req, res, next) => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!isAllowedOrigin(origin, host)) {
    res.statusCode = 403;
    res.end('Forbidden origin');
    return;
  }

  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id, X-File-Name, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const requestUrl = new URL(req.url, `http://${host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  // HTTP 只认 Authorization: Bearer。URL 里的令牌会进日志、浏览记录与 Referer，
  // 不能扩散到普通接口；浏览器 WebSocket 带不了自定义头，只有 /ws/ 升级才看 ?token=
  const token = extractBearerToken(req.headers)
    || (pathname.startsWith('/ws/') ? requestUrl.searchParams.get('token') || '' : '');
  req.authToken = token;
  req.user = null;
  if (token) {
    try {
      const { authenticate } = require('./dist/server/service/auth.service');
      req.user = await authenticate(token);
    } catch (err) {
      // Redis 故障等：不把异常当「已登录」，但要让它落日志而不是静默 401
      console.error('[Auth] 令牌校验失败: ' + (err && err.message ? err.message : err));
    }
  }

  // 只有接口需要登录：静态资源与 SPA 必须放行，否则登录页本身打不开
  const needsAuth = pathname.startsWith('/api/') || pathname.startsWith('/ws/');
  const isPublic = PUBLIC_PATHS.has(pathname);
  if (needsAuth && !isPublic && !req.user) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    // error=unauthorized 时前端清令牌回登录页；session_replaced 由单点登录踢人时区分为同一提示
    res.end(JSON.stringify({ ret: 401, msg: 'Unauthorized', error: 'unauthorized' }));
    return;
  }

  next();
});

// 独立路由（/api/file-upload、/api/cwd、/api/file/download）不走 handleRoutes，
// 所以权限点与会话归属要在这里自己校验一遍——否则它们就是绕开权限的侧门。
function assertSessionAccess(req, sessionId, permissionKeys) {
  if (!req.user) return { ok: false, status: 401, error: 'Unauthorized' };
  const permissions = req.user.permissions || {};
  if (!permissionKeys.some((k) => permissions[k])) {
    return { ok: false, status: 403, error: 'Forbidden: missing permission' };
  }
  try {
    const owner = require('./dist/server/index.js').sshService.getSessionOwner(String(sessionId));
    if (owner && owner !== req.user.userId) {
      return { ok: false, status: 403, error: 'Forbidden: session belongs to another user' };
    }
  } catch (err) {
    return { ok: false, status: 500, error: err.message || 'Access check failed' };
  }
  return { ok: true };
}

// 健康检查端点：供 VSCode 扩展探活。若设置了启动令牌，则必须携带正确 token，
// 避免端口被其它无关进程占用时被误判为服务已就绪。
app.get('/health', (req, res) => {
  const tok = appConfig.auth.launchToken;
  if (tok) {
    const q = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('token');
    if (q !== tok) {
      res.status(401).json({ ok: false });
      return;
    }
  }
  res.json({ ok: true });
});

// HTTP 文件上传端点（绕过 WebSocket，支持大文件）
app.post('/api/file-upload', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  let fileName;
  try {
    fileName = normalizeUploadName(req.headers['x-file-name']);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Invalid file name' });
    return;
  }
  if (!sessionId || !fileName) {
    res.status(400).json({ success: false, error: 'Missing X-Session-Id or X-File-Name header' });
    return;
  }
  const access = assertSessionAccess(req, sessionId, ['files', 'terminal']);
  if (!access.ok) { res.status(access.status).json({ success: false, error: access.error, fileName }); return; }
  try {
    const serverModule = require('./dist/server/index.js');
    const { sshService } = serverModule;
    // 收集原始请求体（文件二进制数据）
    console.log(`[HTTP-Upload] Receiving file: session=${sessionId}, file=${fileName}`);
    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > uploadLimitBytes) {
        res.status(413).json({ success: false, error: `File too large, limit ${uploadLimitBytes} bytes`, fileName });
        return;
      }
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);
    console.log(`[HTTP-Upload] Received ${fileBuffer.length} bytes, calling SFTP...`);
    const bytes = await sshService.uploadFileTracked(sessionId, fileName, fileBuffer);
    console.log(`[HTTP-Upload] SFTP done: ${fileName}, ${bytes} bytes`);
    res.json({ success: true, bytes, fileName });
  } catch (err) {
    console.error(`[HTTP-Upload] Error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message, fileName });
  }
});

// 查询当前终端所在目录（Web 模式：上传前由前端拉取，确保文件落到当前目录）
// zmodem=1 表示远端 rz 正在等待接收文件：此时禁止向交互式 shell 注入探测命令，
// 否则 Ctrl+C 会打断 rz，注入的文本也会被 rz 当成数据吞掉。
app.get('/api/cwd', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  if (!sessionId) {
    res.status(400).json({ success: false, error: 'Missing sessionId' });
    return;
  }
  const zmodem = req.query.zmodem === '1' || req.query.zmodem === 'true';
  const force = req.query.force === '1' || req.query.force === 'true';
  const access = assertSessionAccess(req, sessionId, ['files', 'terminal']);
  if (!access.ok) { res.status(access.status).json({ success: false, cwd: '', error: access.error }); return; }
  try {
    const serverModule = require('./dist/server/index.js');
    const { sshService } = serverModule;
    const { cwd, reliable } = await sshService.getSessionCwdDetailed(String(sessionId), {
      allowShellProbe: !zmodem,
      preferTransferProcess: !!zmodem,
      force,
    });
    res.json({ success: true, cwd, reliable });
  } catch (err) {
    res.status(200).json({ success: false, cwd: '', error: err.message || String(err) });
  }
});

// 文件下载端点：通过 SFTP 读取远程文件并以二进制流返回
app.get('/api/file/download', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  const filePath = req.query.path;
  if (!sessionId || !filePath) {
    return res.status(400).json({ success: false, error: 'Missing sessionId or path' });
  }
  const access = assertSessionAccess(req, sessionId, ['files', 'terminal']);
  if (!access.ok) { return res.status(access.status).json({ success: false, error: access.error }); }
  try {
    const serverModule = require('./dist/server/index.js');
    const { sshService } = serverModule;
    const buf = await sshService.downloadFileTracked(String(sessionId), String(filePath));
    const baseName = path.basename(String(filePath)) || 'download';
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// 账号相关端点：/api/auth/*（自助）与 /api/users/*（管理员），不分 GET/POST
app.use(async (req, res, next) => {
  const pathname = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`).pathname;
  if (!pathname.startsWith('/api/auth/') && !pathname.startsWith('/api/users/') && !pathname.startsWith('/oauth/')) {
    return next();
  }
  try {
    const handled = await handleAccountRoutes(pathname, req.body, {
      token: req.authToken || '',
      user: req.user || null,
      ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
    });
    if (!handled) return next();
    if (handled.headers) {
      for (const [k, v] of Object.entries(handled.headers)) res.setHeader(k, v);
    }
    res.status(handled.status).json(handled.body);
  } catch (error) {
    console.error('Auth API Error:', error);
    res.status(500).json({ ret: 500, msg: error.message || 'Internal server error' });
  }
});

// 处理业务 API 请求（账号相关端点已在上面先拦掉）
app.use('/api/', async (req, res, next) => {
  if (req.method === 'POST') {
    try {
      const serverModule = require('./dist/server/index.js');
      const pathname = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`).pathname;
      // 第三个参数是当前登录人：业务层所有查询都必须带 ownerId，不能靠「服务实例里记住上一个用户」
      const result = await serverModule.handleRoutes(pathname, req.body, req.user);
      res.status(200).json({ ret: 0, msg: 'success', data: result });
    } catch (error) {
      console.error('API Error:', error);
      // ApiError 带 statusCode：401/403 不能都报成 500，否则前端无法区分「该重登」和「没权限」
      res.status(error.statusCode || 500).json({ ret: error.statusCode || 500, msg: error.message || 'Internal server error' });
    }
  } else {
    next();
  }
});

// 静态文件
app.use('/public', express.static(path.join(staticDir, 'public'), { dotfiles: 'allow' }));

// SPA fallback
app.use((req, res) => {
  const indexPath = path.join(staticDir, 'view', 'index.html');
  res.sendFile(indexPath, { dotfiles: 'allow' }, (err) => {
    if (err) {
      res.status(500).send('Error loading index.html:' + err.toString());
    }
  });
});

// WebSocket 文件消息限制跟随上传限制，base64 约有 33% 膨胀
const wss = new WebSocket.Server({ server, path: '/ws/terminal', maxPayload: Math.ceil(uploadLimitBytes * 1.4) });
console.log(`[WS] WebSocket server created on path /ws/terminal (maxPayload: ${Math.ceil(uploadLimitBytes * 1.4)} bytes)`);

// 分块上传缓冲区: uploadId -> { chunks: string[], totalChunks: number, fileName: string, sessionId: string }
const pendingUploads = new Map();

// 跟踪 sessionId -> WebSocket 映射（用于推送监控事件）
const wsBySessionId = new Map();

// 注册日志监控事件回调（全局注册，通过 sessionId 查找对应的 WebSocket）
try {
  const serverModule = require('./dist/server/index.js');
  if (serverModule.monitorService) {
    serverModule.monitorService.onEvent((sid, event) => {
      const targetWs = wsBySessionId.get(sid);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        try { targetWs.send(JSON.stringify({ type: 'monitor-event', sessionId: sid, event })); }
        catch(e) { console.warn('[WS] monitor-event send error:', e.code, e.message); }
      }
    });
  }
} catch (e) {
  console.error('[WS] Failed to register monitor event callback:', e.message);
}

wss.on('connection', async (ws, req) => {
  // 握手完成到鉴权结束之间有一段空窗：authenticate 要走 Redis（远程实例可能几十毫秒到几秒），
  // 而浏览器是在 onopen 里就把 create 发出来的。ws 在没有任何 'message' 监听器时会把
  // 到达的帧直接丢掉（EventEmitter 无监听即丢弃，不排队），表现就是连接建立成功、
  // 终端却永远停在 Connecting。所以握手后第一件事就是挂个缓冲器，
  // 鉴权通过后再把攒下的消息按到达顺序回放给正式处理器。
  const earlyMessages = [];
  const bufferEarlyMessage = (raw) => earlyMessages.push(raw);
  ws.on('message', bufferEarlyMessage);

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
    ws.close(1008, 'Forbidden origin');
    return;
  }
  // 浏览器 WebSocket 带不了自定义请求头，令牌只能走 ?token=（HTTP 那头只认 Bearer）
  const wsToken = extractBearerToken(req.headers) || requestUrl.searchParams.get('token') || '';
  let wsUser = null;
  try {
    const { authenticate } = require('./dist/server/service/auth.service');
    wsUser = await authenticate(wsToken);
  } catch (err) {
    console.error('[WS] 令牌校验失败: ' + (err && err.message ? err.message : err));
  }
  if (!wsUser) {
    ws.close(1008, 'Unauthorized');
    return;
  }
  // 终端权限在门禁处就拦掉，不要等进入 switch 才判
  if (!wsUser.permissions || !wsUser.permissions.terminal) {
    ws.close(1008, 'Forbidden');
    return;
  }
  ws.user = wsUser;

  let sessionId = null;
  const ownerId = wsUser.userId;
  // 按账号登记：管理员在账号管理页点「紧急断开」时要按 ownerId 找到这个人的所有终端 socket
  registerTerminalSocket(ownerId, ws);
  console.log(`[WS] Client connected from ${req.socket.remoteAddress} user=${wsUser.username}`);

  // 安全发送 WebSocket 消息：捕获 EAGAIN 等写入异常，防止未处理的 'error' 事件导致进程崩溃
  // highFreq=true 时启用背压检测，缓冲区超过阈值则丢弃该消息（终端输出可丢帧，不影响连接）
  const WS_BACKPRESSURE_LIMIT = 4 * 1024 * 1024; // 4MB
  function safeSend(data, highFreq = false) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (highFreq && ws.bufferedAmount > WS_BACKPRESSURE_LIMIT) {
      console.warn(`[WS] Backpressure: dropping message (buffered: ${ws.bufferedAmount} bytes)`);
      return;
    }
    try {
      ws.send(data);
    } catch (err) {
      // EAGAIN / ECONNRESET / EPIPE 等 — 记录但不崩溃
      console.warn(`[WS] safeSend error (code=${err.code}): ${err.message}`);
    }
  }

  // 提取会话创建逻辑，供 create 和 reconnect 复用
  async function createSSHSession(sid, data) {
    const serverModule = require('./dist/server/index.js');
    const { sshService } = serverModule;
    const { connectionId, cols, rows, name, serverShellPassword } = data || {};
    if (!connectionId) {
      ws.send(JSON.stringify({ type: 'error', data: '缺少 connectionId' }));
      return;
    }

    sessionId = sid || `ssh-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    console.log(`[WS] Creating SSH session: ${sessionId}, connectionId: ${connectionId}`);

    // 将连接过程日志推送到前端终端信息流
    // 使用独立的 conn-log 类型，避免经过 ZMODEM sentry 处理被吞掉
    const sendLog = (msg) => {
      safeSend(JSON.stringify({ type: 'conn-log', sessionId, data: msg }));
    };

    const session = await sshService.createSession(sessionId, connectionId, cols || 80, rows || 24, name, sendLog, ownerId, { serverShellPassword });
    console.log(`[WS] SSH session created: ${sessionId}`);

    // 根据会话类型绑定输出和关闭事件
    const sendOutput = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const hasBinary = buf.some(b => b > 127);
      // 通知输出监听器（用于 Agent 捕获输出）
      if (!hasBinary) {
        try { sshService.notifyOutput(sessionId, buf.toString('utf-8')); } catch(e) {}
      }
      if (hasBinary) {
        safeSend(JSON.stringify({ type: 'terminal', sessionId, data: buf.toString('base64'), binary: true }), true);
      } else {
        safeSend(JSON.stringify({ type: 'terminal', sessionId, data: buf.toString('utf-8') }), true);
      }
    };
    const sendClose = (source) => () => {
      console.log(`[WS] ${source} closed: ${sessionId}`);
      safeSend(JSON.stringify({ type: 'close', sessionId }));
    };

    if (session.pty) {
      session.pty.onData(sendOutput);
      session.pty.onExit(sendClose('Local PTY'));
    } else if (session.childProcess) {
      session.childProcess.stdout.on('data', sendOutput);
      session.childProcess.stderr.on('data', sendOutput);
      session.childProcess.on('close', sendClose('Local shell'));
    } else if (session.stream) {
      session.stream.on('data', sendOutput);
      session.stream.on('close', sendClose('SSH stream'));
    }

    safeSend(JSON.stringify({ type: 'status', sessionId, data: 'connected' }));
    // 注册 sessionId -> ws 映射
    wsBySessionId.set(sessionId, ws);
    console.log(`[WS] Session ${sessionId} connected, status sent`);
  }

  const handleMessage = async (raw) => {
    console.log(`[WS] Received raw message: ${raw.toString().substring(0, 200)}`);
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error('[WS] Invalid message format:', e.message);
      ws.send(JSON.stringify({ type: 'error', data: 'Invalid message format' }));
      return;
    }

    const { type, sessionId: sid, data } = msg;
    console.log(`[WS] Processing message type: ${type}, sessionId: ${sid}`);
    
    // 会话归属校验：sessionId 是前端传来的，必须确认属于当前登录人，
    // 否则猜到别人的 sessionId 就能直接读写对方终端。
    // type=create 例外：那是新建，归属由 createSession 里的 ownerId 决定。
    const targetSessionId = type === 'ai-agent-run' ? (data && data.aiSessionId) : sid;
    if (targetSessionId && type !== 'create') {
      const owner = require('./dist/server/index.js').sshService.getSessionOwner(targetSessionId);
      if (owner && owner !== ownerId) {
        console.warn(`[WS] 拒绝访问他人会话: user=${wsUser.username} session=${targetSessionId}`);
        ws.send(JSON.stringify({ type: 'error', sessionId: targetSessionId, data: 'Forbidden: session belongs to another user' }));
        return;
      }
    }
    
    try {
      const serverModule = require('./dist/server/index.js');
      const { sshService, connectionService } = serverModule;

      if (!sshService || !connectionService) {
        console.error('[WS] Server module not loaded properly');
        ws.send(JSON.stringify({ type: 'error', data: 'Server module not loaded' }));
        return;
      }

      switch (type) {
        case 'create': {
          // 创建新的 SSH 会话
          try {
            await createSSHSession(sid, data);
          } catch (err) {
            console.error(`[WS] SSH session creation failed: ${err.message}`);
            // code 透传给前端：口令缺失/未设置时要弹输入框，不能当成普通连接失败
            ws.send(JSON.stringify({ type: 'error', sessionId, code: err.code, data: err.message || 'SSH 连接失败' }));
          }
          break;
        }

        case 'reconnect': {
          // 重连：关闭旧会话并重新创建
          console.log(`[WS] Reconnecting session: ${sid}`);
          try {
            const serverModule = require('./dist/server/index.js');
            // 先关闭旧会话
            if (sid) {
              serverModule.sshService.closeSession(sid);
            }
            await createSSHSession(sid, data);
          } catch (err) {
            console.error(`[WS] SSH session reconnect failed: ${err.message}`);
            ws.send(JSON.stringify({ type: 'error', sessionId, code: err.code, data: err.message || '重连失败' }));
          }
          break;
        }

        case 'terminal': {
          // 用户输入转发到 SSH
          if (sid && data) {
            if (msg.binary) {
              // 二进制数据（ZMODEM等）
              sshService.writeData(sid, Buffer.from(data, 'base64'));
            } else {
              sshService.writeData(sid, data);
            }
          }
          break;
        }

        case 'resize': {
          // 调整终端大小
          if (sid && data) {
            sshService.resize(sid, data.cols, data.rows);
          }
          break;
        }

        case 'close': {
          // 关闭会话
          if (sid) {
            console.log(`[WS] Closing session: ${sid}`);
            sshService.closeSession(sid);
          }
          break;
        }

        case 'ai-agent-run': {
          // 一轮 Agent 执行。
          // aiSessionId 是命令要跑在哪个终端；chatId 是这一轮属于哪个对话（存储 key）。
          // 老前端只传 aiSessionId 时退化为「对话 = 终端会话」，不影响可用性。
          const { aiSessionId, chatId, message, context, skillId, locale, modelId } = data || {};
          if (!wsUser.permissions || !wsUser.permissions.ai) {
            ws.send(JSON.stringify({ type: 'ai-agent-event', event: { type: 'error', error: 'Forbidden: missing permission' } }));
            break;
          }
          // aiSessionId 允许为空：面板开着但终端已经关掉时，纯问答仍然有意义。
          // 真正的命令执行由 ai.service 里的 terminalGuard 拦住，会给出「先打开终端」的明确说明，
          // 不会再拿一个查不到的会话 id 得出「终端会话已断开」。
          if (!message) {
            ws.send(JSON.stringify({ type: 'ai-agent-event', event: { type: 'error', error: 'Missing params: message' } }));
            break;
          }
          const { aiService } = serverModule;
          if (!aiService) {
            ws.send(JSON.stringify({ type: 'ai-agent-event', event: { type: 'error', error: 'AI service unavailable' } }));
            break;
          }
          const terminalSid = typeof aiSessionId === 'string' ? aiSessionId : '';
          const conversationId = chatId || terminalSid;
          if (!conversationId) {
            ws.send(JSON.stringify({ type: 'ai-agent-event', event: { type: 'error', error: 'Missing params: chatId' } }));
            break;
          }
          console.log(`[WS] AI Agent run: chat=${conversationId}, terminal=${terminalSid || 'none'}, model=${modelId || 'auto'}, skill=${skillId || 'none'}, locale=${locale || 'auto'}, message=${message.substring(0, 50)}`);
          aiService.agentRun(ownerId, conversationId, terminalSid, message, context, (event) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ai-agent-event', sessionId: terminalSid, chatId: conversationId, event }));
            }
          }, { skillId, locale, modelId }).catch((err) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ai-agent-event', sessionId: terminalSid, chatId: conversationId, event: { type: 'error', error: err.message } }));
            }
          });
          break;
        }

        case 'file-upload': {
          // SFTP 文件上传 - 单消息模式（小文件，<上传限制）
          let fileName;
          const { data: fileData } = data || {};
          try {
            fileName = normalizeUploadName(data?.fileName);
          } catch (err) {
            ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: err.message || 'Invalid file name' }));
            break;
          }
          if (!sid || !fileName || !fileData) {
            console.error(`[WS] file-upload missing params: sid=${sid}, fileName=${fileName}, hasData=${!!fileData}`);
            ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: 'Missing params', fileName }));
            break;
          }
          const fileBuffer = Buffer.from(fileData, 'base64');
          if (fileBuffer.length > uploadLimitBytes) {
            ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: `File too large, limit ${uploadLimitBytes} bytes`, fileName }));
            break;
          }
          try {
            console.log(`[WS] SFTP upload START: session=${sid}, file=${fileName}, bytes=${fileBuffer.length}, wsReady=${ws.readyState}`);
            const bytes = await sshService.uploadFileTracked(sid, fileName, fileBuffer);
            console.log(`[WS] SFTP upload DONE: ${fileName}, ${bytes} bytes, wsReady=${ws.readyState}`);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'file-upload-result', success: true, bytes, fileName }));
            } else {
              console.error(`[WS] Cannot send result, WS not open: state=${ws.readyState}`);
            }
          } catch (err) {
            console.error(`[WS] SFTP upload ERROR: ${err.message}`, err.stack);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: err.message, fileName }));
            }
          }
          break;
        }

        case 'get-cwd': {
          // 查询当前终端所在目录（由服务端可靠解析，避免依赖前端提示符解析）
          try {
            const cwd = await sshService.getSessionCwd(sid);
            ws.send(JSON.stringify({ type: 'cwd', sessionId: sid, cwd }));
          } catch (err) {
            ws.send(JSON.stringify({ type: 'cwd', sessionId: sid, cwd: '', error: err.message || String(err) }));
          }
          break;
        }

        case 'file-upload-start': {
          // 分块上传 - 开始（大文件）
          const { uploadId, totalChunks } = data || {};
          let startFileName;
          try {
            startFileName = normalizeUploadName(data?.fileName);
          } catch (err) {
            ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: err.message || 'Invalid file name' }));
            break;
          }
          if (!uploadId || !startFileName || !Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 10000) {
            ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: 'Invalid upload params', fileName: startFileName }));
            break;
          }
          console.log(`[WS] Chunked upload start: id=${uploadId}, file=${startFileName}, chunks=${totalChunks}`);
          pendingUploads.set(uploadId, { chunks: new Array(totalChunks), totalChunks, fileName: startFileName, sessionId: sid, receivedChunks: 0, receivedBytes: 0, createdAt: Date.now() });
          break;
        }

        case 'file-upload-chunk': {
          // 分块上传 - 数据块
          const { uploadId: chunkId, chunkIndex, data: chunkData } = data || {};
          const upload = chunkId ? pendingUploads.get(chunkId) : null;
          if (!upload) {
            ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: 'Upload session not found' }));
            break;
          }
          if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= upload.totalChunks || typeof chunkData !== 'string') {
            pendingUploads.delete(chunkId);
            ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: 'Invalid upload chunk', fileName: upload.fileName }));
            break;
          }
          const chunkBytes = Buffer.byteLength(chunkData, 'base64');
          const previousBytes = upload.chunks[chunkIndex] ? Buffer.byteLength(upload.chunks[chunkIndex], 'base64') : 0;
          upload.receivedBytes += chunkBytes - previousBytes;
          if (upload.receivedBytes > uploadLimitBytes) {
            pendingUploads.delete(chunkId);
            ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: `File too large, limit ${uploadLimitBytes} bytes`, fileName: upload.fileName }));
            break;
          }
          if (upload.chunks[chunkIndex] === undefined) upload.receivedChunks++;
          upload.chunks[chunkIndex] = chunkData;
          // 每 10 个 chunk 反馈一次进度
          if (upload.receivedChunks % 10 === 0 || upload.receivedChunks === upload.totalChunks) {
            ws.send(JSON.stringify({ type: 'file-upload-progress', uploadId: chunkId, received: upload.receivedChunks, total: upload.totalChunks }));
          }
          break;
        }

        case 'file-upload-end': {
          // 分块上传 - 结束，拼接并 SFTP 写入
          const { uploadId: endId } = data || {};
          const endUpload = endId ? pendingUploads.get(endId) : null;
          if (!endUpload) {
            console.error(`[WS] file-upload-end: upload session not found: ${endId}`);
            ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: 'Upload session not found' }));
            break;
          }
          try {
            console.log(`[WS] Chunked upload end: id=${endId}, file=${endUpload.fileName}, received=${endUpload.receivedChunks}/${endUpload.totalChunks}`);
            // 检查是否收到所有 chunk
            const missingChunks = endUpload.chunks.reduce((acc, c, i) => c === undefined ? [...acc, i] : acc, []);
            if (missingChunks.length > 0) {
              console.error(`[WS] Missing chunks: ${missingChunks.join(',')}`);
              ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: `Missing ${missingChunks.length} chunks`, fileName: endUpload.fileName }));
              pendingUploads.delete(endId);
              break;
            }
            const fullB64 = endUpload.chunks.join('');
            console.log(`[WS] Joined ${endUpload.totalChunks} chunks -> b64len=${fullB64.length}, calling SFTP upload...`);
            const bytes = await sshService.uploadFileTracked(endUpload.sessionId, endUpload.fileName, Buffer.from(fullB64, 'base64'));
            console.log(`[WS] Chunked upload SFTP DONE: ${endUpload.fileName}, ${bytes} bytes, wsReady=${ws.readyState}`);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'file-upload-result', success: true, bytes, fileName: endUpload.fileName }));
            }
          } catch (err) {
            console.error(`[WS] Chunked upload ERROR: ${err.message}`, err.stack);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'file-upload-result', success: false, error: err.message, fileName: endUpload.fileName }));
            }
          } finally {
            pendingUploads.delete(endId);
          }
          break;
        }

        case 'ai-agent-stop': {
          // 停止 AI Agent：中止的粒度是「对话」，不是终端
          const { aiSessionId: stopSid, chatId: stopChatId } = data || {};
          const stopTarget = stopChatId || stopSid;
          if (stopTarget) {
            const { aiService } = serverModule;
            if (aiService) {
              // 带 ownerId：否则拿到别人的 chatId 就能把对方的 Agent 中止掉
              aiService.stopAgent(ownerId, stopTarget);
              console.log(`[WS] AI Agent stop requested: ${stopTarget}`);
            }
          }
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', data: `Unknown message type: ${type}` }));
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err);
      ws.send(JSON.stringify({ type: 'error', data: err.message || '服务端异常' }));
    }
  };

  // 鉴权已通过：卸掉缓冲器，换成正式处理器，再把空窗期攒下的消息补处理掉
  ws.off('message', bufferEarlyMessage);
  ws.on('message', handleMessage);
  for (const raw of earlyMessages) {
    await handleMessage(raw);
  }

  ws.on('close', () => {
    console.log(`[WS] Client disconnected, sessionId: ${sessionId}`);
    unregisterTerminalSocket(ownerId, ws);
    // 移除 sessionId -> ws 映射
    if (sessionId) {
      wsBySessionId.delete(sessionId);
      try {
        const serverModule = require('./dist/server/index.js');
        // 停止该会话的监控
        if (serverModule.monitorService) {
          serverModule.monitorService.stopSessionMonitors(sessionId);
        }
        serverModule.sshService.closeSession(sessionId);
      } catch (e) {
        // ignore
      }
    }
  });

  ws.on('error', (err) => {
    // EAGAIN 等可恢复错误仅警告，不中断连接
    if (err && (err.code === 'EAGAIN' || err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
      console.warn('[WS] Recoverable socket error (code=%s): %s', err.code, err.message);
      return;
    }
    console.error('[WS] WebSocket error:', err);
  });

  // 捕获底层 socket 的 error 事件，防止 EAGAIN 等错误成为未捕获异常导致进程崩溃
  if (ws._socket) {
    ws._socket.on('error', (err) => {
      if (err && (err.code === 'EAGAIN' || err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
        console.warn('[WS] Socket recoverable error (code=%s): %s', err.code, err.message);
      } else {
        console.error('[WS] Socket error:', err);
      }
    });
  }
});

// 解析命令行参数获取端口
let portFromArgs;
for (let i = 0; i < process.argv.length; i++) {
  if ((process.argv[i] === '--port' || process.argv[i] === '-p') && process.argv[i + 1]) {
    portFromArgs = parseInt(process.argv[i + 1]);
    break;
  }
}

// 启动服务器（优先级：命令行参数 > 环境变量 > 配置文件 > 默认值；
// 后三层已由 config 模块合并完毕）
const PORT = portFromArgs || appConfig.server.port;
const HOST = appConfig.server.host;

// PID 文件路径：按端口区分，避免多实例（桌面端 / CLI / 多个 VSCode 窗口）互相覆盖
// （多个进程监听不同端口，共用同一数据目录时，同名 PID 文件会导致 stop 杀错对象）
const pidFilePath = getDataPath('aetherops.server.' + PORT + '.pid');

// 进程退出时清理 PID 文件
function cleanupPid() {
  try { if (fs.existsSync(pidFilePath)) fs.unlinkSync(pidFilePath); } catch {}
}
// 启动前必须让依赖就绪：MySQL 探活 + 跑完迁移 + Redis 探活 + 加载服务配置。
// 迁移完成后才 listen：服务还没开始接请求就失败退出，
// 不会出现「端口已开但一查就错」这种更难排查的中间态。
async function bootstrapDatabase() {
  try {
    const { ensureDatabaseReady } = require('./dist/server/db/migrate');
    await ensureDatabaseReady();
    // Redis 持有登录令牌，连不上等于没人能登录，同样按硬依赖处理
    const { probeRedis } = require('./dist/server/db/redis');
    await probeRedis();
    // 建表完成后才能读表：服务的初始化（AI 配置、连接列表等）必须在这一步之后
    const { initServices } = require('./dist/server/index.js');
    await initServices();
  } catch (err) {
    console.error('[FATAL] ' + (err && err.message ? err.message : String(err)));
    console.error('[FATAL] 依赖服务不可用（MySQL / Redis），服务不启动。校对配置: ' + getConfigPath());
    try { logStream.end(); } catch (e) { /* ignore */ }
    process.exit(1);
  }
}

function startListening() {
  server.listen(PORT, HOST, () => {
    fs.writeFileSync(pidFilePath, process.pid.toString());
    console.log(`PID ${process.pid} written to ${pidFilePath}`);
    console.log(`aetherops Server is running on ${HOST}:${PORT}`);
    // 绑 0.0.0.0 / :: 时 localhost 只在"服务这台机器上"有效，
    // 直接把各网卡的 IPv4 列出来，省得用户再去 ipconfig 里翻。
    const lanIps = HOST === '0.0.0.0' || HOST === '::' || HOST === ''
      ? Object.values(os.networkInterfaces())
          .flat()
          .filter((a) => a && a.family === 'IPv4' && !a.internal)
          .map((a) => a.address)
      : [HOST];
    for (const ip of ['127.0.0.1', ...lanIps]) {
      console.log(`http://${ip}:${PORT}/   （账号登录页；初始管理员见上方 [Auth] 日志）`);
    }
  });
}

bootstrapDatabase().then(startListening);

// 进程退出处理
process.on('exit', () => { cleanupPid(); logStream.end(); });
process.on('SIGTERM', () => { cleanupPid(); process.exit(0); });
process.on('SIGINT', () => { cleanupPid(); process.exit(0); });
process.on('uncaughtException', (err) => {
  // EAGAIN 等可恢复错误不退出进程
  if (err && (err.code === 'EAGAIN' || err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
    console.warn('[Process] Recoverable socket error (code=%s): %s', err.code, err.message);
    return;
  }
  console.error('Uncaught exception:', err);
  try { cleanupPid(); } catch(e) {}
  try { logStream.end(); } catch(e) {}
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  try { cleanupPid(); } catch(e) {}
  try { logStream.end(); } catch(e) {}
  process.exit(1);
});
