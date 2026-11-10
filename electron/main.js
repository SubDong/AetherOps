/**
 * @file Electron 主进程入口
 * @description 创建桌面窗口，通过 IPC 直接处理终端通信（无需 HTTP/WebSocket 服务）
 *
 * 生产模式：加载本地 HTML，API 和终端都通过主进程 IPC 通信
 * 开发模式：连接 Vite 开发服务器（API 走 HTTP，终端走 WebSocket）
 */

const { app, BrowserWindow, shell, ipcMain, protocol, net, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { initAutoUpdater } = require('./updater');

// ========== 日志输出到文件（生产模式调试用） ==========
const logDir = path.join(os.homedir(), '.aetherops');
try { if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true }); } catch (e) { /* ignore */ }
const logFile = path.join(logDir, 'electron.log');
const logStream = (() => {
  try {
    return fs.createWriteStream(logFile, { flags: 'w' });
  } catch (e) { return null; }
})();
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
function ts() { return new Date().toISOString(); }
console.log = function(...args) {
  origLog.apply(console, args);
  if (logStream) logStream.write(`[${ts()}] LOG ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`);
};
console.error = function(...args) {
  origError.apply(console, args);
  if (logStream) logStream.write(`[${ts()}] ERR ${args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.message + '\n' + a.stack : JSON.stringify(a))).join(' ')}\n`);
};
console.warn = function(...args) {
  origWarn.apply(console, args);
  if (logStream) logStream.write(`[${ts()}] WRN ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`);
};
console.log(`[Electron] Log file: ${logFile}`);
console.log(`[Electron] App starting, packaged: ${app.isPackaged}, platform: ${process.platform}, arch: ${process.arch}`);
console.log(`[Electron] __dirname: ${__dirname}, cwd: ${process.cwd()}`);

// ========== 注册自定义协议（必须在 app.whenReady 之前） ==========
// 解决 file:// 协议下绝对路径（/public/xxx.js）无法加载的问题
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// 解析命令行参数
const args = process.argv.slice(app.isPackaged ? 1 : 2);
const devUrl = args.find(a => a.startsWith('--dev-url='))?.split('=')[1];
const isDev = !!devUrl;

let mainWindow = null;

// ========== 服务实例（延迟加载） ==========
let _services = null;

function serverDist(...parts) {
  return path.join(__dirname, '..', 'dist', 'server', ...parts);
}

function getServices() {
  if (_services) return _services;
  if (isDev) {
    console.warn('[Electron] Dev mode: services are provided by Vite dev server, IPC disabled');
    return null;
  }
  try {
    const serverPath = serverDist('index.js');
    console.log(`[Electron] Loading server module from: ${serverPath}`);
    console.log(`[Electron] __dirname: ${__dirname}`);
    console.log(`[Electron] File exists: ${require('fs').existsSync(serverPath)}`);
    const serverModule = require(serverPath);
    console.log(`[Electron] Server module loaded, keys: ${Object.keys(serverModule).join(', ')}`);
    _services = {
      serverModule,
      sshService: serverModule.sshService,
      connectionService: serverModule.connectionService,
      aiService: serverModule.aiService,
      monitorService: serverModule.monitorService,
    };
    // 检查各服务是否正常
    for (const [name, svc] of Object.entries(_services)) {
      console.log(`[Electron] Service '${name}': ${svc ? 'OK' : 'NULL'}`);
    }
    return _services;
  } catch (e) {
    console.error(`[Electron] Failed to load server module: ${e.message}`);
    console.error(e.stack);
    return null;
  }
}

/**
 * 启动依赖：连库 + 跑迁移 + Redis 探活 + 初始化服务。
 * 不能只 require 一下就开窗口：表结构 / 初始管理员 / 按账号懒加载的 AI 配置
 * 都依赖这一步；跳过它的话首次登录会直接报「表不存在」。
 */
let servicesReady = null;
function ensureServicesReady() {
  if (servicesReady) return servicesReady;
  servicesReady = (async () => {
    if (isDev) return null;
    const { ensureDatabaseReady } = require(serverDist('db', 'migrate.js'));
    await ensureDatabaseReady();
    const { probeRedis } = require(serverDist('db', 'redis.js'));
    await probeRedis();
    const services = getServices();
    if (services) {
      await services.serverModule.initServices();
      setupMonitorEvents();
    }
    return services;
  })().catch((e) => {
    console.error('[Electron] 依赖初始化失败: ' + (e && e.message ? e.message : e));
    servicesReady = null;
    return null;
  });
  return servicesReady;
}

/* ------------------------------------------------------------------ */
/* IPC 鉴权                                                            */
/* ------------------------------------------------------------------ */

/**
 * Electron 生产模式没有 HTTP 网关在门口鉴权，IPC 就是唯一门禁。
 * 每条消息都验一次太贵（终端输入每秒好几条），所以按 sender 缓存 15s：
 * 单点登录踢人在桌面端的生效延迟最多 15s，这是刻意的取舍。
 */
const AUTH_CACHE_MS = 15000;
const authCache = new Map();

async function resolveUser(token, senderId) {
  const raw = String(token || '');
  if (!raw) return null;
  const cached = senderId != null ? authCache.get(senderId) : null;
  if (cached && cached.token === raw && Date.now() - cached.at < AUTH_CACHE_MS) return cached.user;
  try {
    const { authenticate } = require(serverDist('service', 'auth.service.js'));
    const user = await authenticate(raw);
    if (senderId != null) {
      if (user) authCache.set(senderId, { token: raw, user, at: Date.now() });
      else authCache.delete(senderId);
    }
    return user;
  } catch (e) {
    console.error('[IPC] 令牌校验失败: ' + (e && e.message ? e.message : e));
    return null;
  }
}

/** 与 server.js 的 assertSessionAccess 同一套语义 */
async function assertSessionAccess(token, sessionId, permissionKeys) {
  const user = await resolveUser(token);
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };
  const permissions = user.permissions || {};
  if (!permissionKeys.some((k) => permissions[k])) {
    return { ok: false, status: 403, error: 'Forbidden: missing permission' };
  }
  let owner = '';
  try {
    const services = getServices();
    owner = services?.sshService?.getSessionOwner(String(sessionId)) || '';
  } catch { /* ignore */ }
  if (owner && owner !== user.userId) {
    return { ok: false, status: 403, error: 'Forbidden: session belongs to another user' };
  }
  return { ok: true };
}

// ========== API IPC 处理（替代渲染进程 require） ==========

function setupApiIPC() {
  ipcMain.handle('api:request', async (_event, payload) => {
    const services = await ensureServicesReady();
    if (!services) {
      return { status: 500, data: { ret: 500, msg: 'Services not available' } };
    }
    const pathname = String(payload?.pathname || '');
    const body = payload?.body || {};
    const token = String(payload?.token || '');

    try {
      // 账号相关端点：登录时还没有令牌，必须交给 handleAccountRoutes 自己判
      if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/users/') || pathname.startsWith('/oauth/')) {
        const { handleAccountRoutes } = require(serverDist('routes', 'auth.routes.js'));
        const user = await resolveUser(token);
        const result = await handleAccountRoutes(pathname, body, { token, user, ip: 'ipc' });
        if (!result) return { status: 404, data: { error: 'not_found', error_description: pathname } };
        return { status: result.status, data: result.body };
      }

      if (!pathname.startsWith('/api/')) {
        return { status: 400, data: { ret: 400, msg: 'Invalid API path' } };
      }
      // 业务接口必须登录：三个参数里第三个就是登录人，所有仓储都按它隔离
      const user = await resolveUser(token);
      if (!user) return { status: 401, data: { ret: 401, msg: 'Unauthorized' } };
      const data = await services.serverModule.handleRoutes(pathname, body, user);
      return { status: 200, data };
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      console.error('[IPC] API request failed:', err?.message || err);
      return { status, data: { ret: status, msg: err?.message || 'Internal error' } };
    }
  });

  // 文件上传 IPC 处理（app:// 协议下 fetch 不可用）
  ipcMain.handle('file:upload', async (_event, payload) => {
    const services = await ensureServicesReady();
    if (!services) {
      return { success: false, error: 'Services not available' };
    }
    try {
      const { sessionId, fileName, fileData, token } = payload;
      if (!sessionId || !fileName || !fileData) {
        return { success: false, error: 'Missing sessionId, fileName, or fileData' };
      }
      const access = await assertSessionAccess(token, sessionId, ['files', 'terminal']);
      if (!access.ok) return { success: false, error: access.error };
      console.log(`[IPC] File upload: session=${sessionId}, file=${fileName}, size=${fileData.byteLength || fileData.length}`);
      const buffer = Buffer.from(fileData);
      // tracked 版本会顺手把这次传输记进审计（管理员在账号管理页看得到）
      const bytes = await services.sshService.uploadFileTracked(sessionId, fileName, buffer);
      return { success: true, bytes, fileName };
    } catch (err) {
      console.error('[IPC] File upload error:', err);
      return { success: false, error: err.message };
    }
  });

  // 文件下载 IPC 处理（app:// 协议下 fetch 不可用；直接在主进程保存到用户选择路径）
  ipcMain.handle('file:download', async (_event, payload) => {
    const services = await ensureServicesReady();
    if (!services) {
      return { success: false, error: 'Services not available' };
    }
    try {
      const { sessionId, remotePath, fileName, token } = payload || {};
      if (!sessionId || !remotePath) {
        return { success: false, error: 'Missing sessionId or remotePath' };
      }
      const access = await assertSessionAccess(token, sessionId, ['files', 'terminal']);
      if (!access.ok) return { success: false, error: access.error };
      const buffer = await services.sshService.downloadFileTracked(sessionId, remotePath);
      const { dialog } = require('electron');
      const defaultName = fileName || path.basename(remotePath) || 'download';
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save file as',
        defaultPath: path.join(os.homedir(), defaultName),
      });
      if (canceled || !filePath) {
        return { success: false, canceled: true };
      }
      fs.writeFileSync(filePath, buffer);
      return { success: true, filePath, size: buffer.length };
    } catch (err) {
      console.error('[IPC] File download error:', err);
      return { success: false, error: err.message };
    }
  });

  // 查询当前终端所在目录（Electron 模式：上传前由前端拉取，确保文件落到当前目录）
  ipcMain.handle('terminal:get-cwd', async (_event, payload) => {
    const services = await ensureServicesReady();
    if (!services) {
      return { cwd: '', error: 'Services not available' };
    }
    try {
      // zmodem=true 表示远端 rz 正在等待接收文件：禁止注入式探测，避免打断 rz
      // force=true 表示忽略缓存重新探测（用户手动重新检测 / 上传前兜底）
      const { sessionId, zmodem, force, token } = payload || {};
      if (!sessionId) {
        return { cwd: '', error: 'Missing sessionId' };
      }
      const access = await assertSessionAccess(token, sessionId, ['files', 'terminal']);
      if (!access.ok) return { cwd: '', error: access.error };
      const { cwd, reliable } = await services.sshService.getSessionCwdDetailed(sessionId, {
        allowShellProbe: !zmodem,
        preferTransferProcess: !!zmodem,
        force: !!force,
      });
      return { cwd, reliable };
    } catch (err) {
      console.error('[IPC] get-cwd error:', err);
      return { cwd: '', error: err.message };
    }
  });
}

// ========== 剪贴板 IPC 处理（sandbox 模式兜底） ==========

function setupClipboardIPC() {
  const { clipboard } = require('electron');
  ipcMain.on('clipboard:write', (_event, text) => {
    clipboard.writeText(text);
  });
  ipcMain.handle('clipboard:read', () => {
    return clipboard.readText();
  });
}

// ========== 终端 IPC 处理（替代 WebSocket） ==========

// 跟踪每个窗口的 sessionId 列表（用于窗口关闭时清理）
const windowSessions = new Map();

function setupTerminalIPC() {
  ipcMain.on('terminal:message', async (event, msg) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    const send = (response) => {
      if (!win.isDestroyed()) {
        win.webContents.send('terminal:event', response);
      }
    };

    const { type, sessionId: sid, data } = msg;
    const services = getServices();
    if (!services) {
      send({ type: 'error', data: 'Services not available (dev mode - use Vite WebSocket instead)' });
      return;
    }
    const { sshService, aiService, monitorService } = services;

    try {
      // 渲染进程在每条消息里都附了 token：Electron 生产模式没有网关，IPC 就是门禁
      const user = await resolveUser(msg.token, event.sender.id);
      if (!user) {
        send({ type: 'error', sessionId: sid, data: 'Unauthorized' });
        return;
      }
      if (type !== 'ai-agent-run' && type !== 'ai-agent-stop' && !user.permissions?.terminal) {
        send({ type: 'error', sessionId: sid, data: 'Forbidden: missing permission' });
        return;
      }
      // 会话归属：create 是新建，其余按 sessionId 校（AI 会话用 aiSessionId）
      const targetSessionId = type === 'ai-agent-run' ? (data && data.aiSessionId) : sid;
      if (targetSessionId && type !== 'create') {
        const owner = sshService.getSessionOwner(targetSessionId);
        if (owner && owner !== user.userId) {
          send({ type: 'error', sessionId: targetSessionId, data: 'Forbidden: session belongs to another user' });
          return;
        }
      }

      switch (type) {
        case 'create': {
          const { connectionId, cols, rows, name, serverShellPassword } = data || {};
          if (!connectionId) {
            send({ type: 'error', data: 'Missing connectionId' });
            return;
          }
          const sessionId = sid || `ssh-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;

          // 跟踪此窗口的 session
          if (!windowSessions.has(win.id)) windowSessions.set(win.id, new Set());
          windowSessions.get(win.id).add(sessionId);

          const session = await sshService.createSession(sessionId, connectionId, cols || 80, rows || 24, name, (msg) => {
            send({ type: 'conn-log', sessionId, data: msg });
          }, user.userId, { serverShellPassword });

          // 绑定输出
          const sendOutput = (chunk) => {
            if (win.isDestroyed()) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const hasBinary = buf.some(b => b > 127);
            if (!hasBinary) {
              try { sshService.notifyOutput(sessionId, buf.toString('utf-8')); } catch (e) { /* ignore */ }
            }
            if (hasBinary) {
              send({ type: 'terminal', sessionId, data: buf.toString('base64'), binary: true });
            } else {
              send({ type: 'terminal', sessionId, data: buf.toString('utf-8') });
            }
          };
          const sendClose = (source) => () => {
            console.log(`[IPC] ${source} closed: ${sessionId}`);
            send({ type: 'close', sessionId });
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

          send({ type: 'status', sessionId, data: 'connected' });
          break;
        }

        case 'reconnect': {
          if (sid) {
            sshService.closeSession(sid);
          }
          // 复用 create 逻辑
          const { connectionId, cols, rows, name, serverShellPassword } = data || {};
          if (!connectionId) {
            send({ type: 'error', data: 'Missing connectionId' });
            return;
          }
          const sessionId = sid || `ssh-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;

          if (!windowSessions.has(win.id)) windowSessions.set(win.id, new Set());
          windowSessions.get(win.id).add(sessionId);

          const session = await sshService.createSession(sessionId, connectionId, cols || 80, rows || 24, name, (msg) => {
            send({ type: 'conn-log', sessionId, data: msg });
          }, user.userId, { serverShellPassword });

          const sendOutput = (chunk) => {
            if (win.isDestroyed()) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const hasBinary = buf.some(b => b > 127);
            if (!hasBinary) {
              try { sshService.notifyOutput(sessionId, buf.toString('utf-8')); } catch (e) { /* ignore */ }
            }
            if (hasBinary) {
              send({ type: 'terminal', sessionId, data: buf.toString('base64'), binary: true });
            } else {
              send({ type: 'terminal', sessionId, data: buf.toString('utf-8') });
            }
          };
          const sendClose = (source) => () => {
            send({ type: 'close', sessionId });
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

          send({ type: 'status', sessionId, data: 'connected' });
          break;
        }

        case 'terminal': {
          if (sid && data) {
            if (msg.binary) {
              sshService.writeData(sid, Buffer.from(data, 'base64'));
            } else {
              sshService.writeData(sid, data);
            }
          }
          break;
        }

        case 'resize': {
          if (sid && data) {
            sshService.resize(sid, data.cols, data.rows);
          }
          break;
        }

        case 'close': {
          if (sid) {
            sshService.deleteSession(sid);
            const sessions = windowSessions.get(win.id);
            if (sessions) sessions.delete(sid);
          }
          break;
        }

        case 'ai-agent-run': {
          // 与 server.js / vite.config.ts 的 WS 处理保持同一套参数：
          // chatId 是对话存储 key，aiSessionId 是命令要跑在哪个终端，两者不是一回事。
          const { aiSessionId, chatId, message, context, skillId, locale, modelId } = data || {};
          if (!user.permissions?.ai) {
            send({ type: 'ai-agent-event', event: { type: 'error', error: 'Forbidden: missing permission' } });
            return;
          }
          // aiSessionId 允许为空：终端关掉时纯问答仍然有意义，
          // 执行命令由 ai.service 的 terminalGuard 拦住并说明「先打开终端」
          if (!message) {
            send({ type: 'ai-agent-event', event: { type: 'error', error: 'Missing params: message' } });
            return;
          }
          const terminalSid = typeof aiSessionId === 'string' ? aiSessionId : '';
          const conversationId = chatId || terminalSid;
          if (!conversationId) {
            send({ type: 'ai-agent-event', event: { type: 'error', error: 'Missing params: chatId' } });
            return;
          }
          console.log(`[IPC] AI Agent run: chat=${conversationId}, terminal=${terminalSid || 'none'}, model=${modelId || 'auto'}, skill=${skillId || 'none'}`);
          aiService.agentRun(user.userId, conversationId, terminalSid, message, context, (agentEvent) => {
            send({ type: 'ai-agent-event', sessionId: terminalSid, chatId: conversationId, event: agentEvent });
          }, { skillId, locale, modelId }).catch((err) => {
            send({ type: 'ai-agent-event', sessionId: terminalSid, chatId: conversationId, event: { type: 'error', error: err.message } });
          });
          break;
        }

        case 'ai-agent-stop': {
          const { aiSessionId: stopSid, chatId: stopChatId } = data || {};
          // 中止的粒度是对话而不是终端；带 ownerId 才不会拿别人的 id 中止对方的 Agent
          const stopTarget = stopChatId || stopSid;
          if (stopTarget) aiService.stopAgent(user.userId, stopTarget);
          break;
        }

        default:
          send({ type: 'error', data: `Unknown message type: ${type}` });
      }
    } catch (err) {
      console.error('[IPC] Error processing message:', err);
      send({ type: 'error', data: err.message || 'Internal error', code: err.code });
    }
  });
}

// ========== 注册监控事件回调 ==========

function setupMonitorEvents() {
  const services = getServices();
  if (services?.monitorService) {
    services.monitorService.onEvent((sid, event) => {
      // 广播到所有窗口（简化处理）
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('terminal:event', { type: 'monitor-event', sessionId: sid, event });
        }
      });
    });
  }
}

// ========== 窗口关闭清理 ==========

function cleanupWindow(win) {
  const sessions = windowSessions.get(win.id);
  if (sessions) {
    const services = getServices();
    if (services) {
      sessions.forEach(sid => {
        try {
          services.monitorService.stopSessionMonitors(sid);
          // 仅关闭连接，不删除元数据（保留 sessions.json 供下次启动恢复）
          services.sshService.closeSession(sid);
        } catch (e) { /* ignore */ }
      });
    }
    windowSessions.delete(win.id);
  }
}

// ========== 创建窗口 ==========

function createWindow(loadTarget) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'AetherOps - AI Terminal',
    icon: path.join(__dirname, '..', 'public', process.platform === 'darwin' ? 'favicon.icns' : process.platform === 'win32' ? 'favicon.ico' : 'favicon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (loadTarget.startsWith('http')) {
    mainWindow.loadURL(loadTarget);
  } else if (loadTarget.startsWith('app://')) {
    mainWindow.loadURL(loadTarget);
  } else {
    mainWindow.loadFile(loadTarget);
  }

  mainWindow.on('closed', () => {
    if (mainWindow) {
      cleanupWindow(mainWindow);
      mainWindow = null;
    }
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 生产模式下可通过快捷键打开 DevTools 调试
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });
}

// ========== 应用菜单 ==========

function setupMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: 'About AetherOps', click: () => shell.openExternal('https://aigcwhere.com/opensource/aetherops') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Connection', accelerator: 'CmdOrCtrl+N', click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('menu:action', 'new-connection');
          }
        }},
        { type: 'separator' },
        { role: 'quit', label: 'Quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal('https://github.com/SubDong/AetherOps') },
        { label: 'Report Issue', click: () => shell.openExternal('https://github.com/SubDong/AetherOps/issues') },
        { type: 'separator' },
        { label: 'About', click: () => shell.openExternal('https://aigcwhere.com/opensource/aetherops') },
        { type: 'separator' },
        { label: 'Check for Updates...', click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('menu:action', 'check-update');
          }
        }},
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ========== 应用生命周期 ==========

app.whenReady().then(() => {
  // 注册 app:// 协议处理器（生产模式加载本地文件）
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    // app://local/xxx → 项目根目录/dist/xxx
    const filePath = path.join(__dirname, '..', 'dist', pathname);
    // 前端是 history 路由：/login、/users 这类地址不是文件，
    // 不回落就会拿到一个不存在的路径（登录页白屏、刷新白屏）。
    // Web 那边有 server.js 的 SPA fallback 兼底，桌面端只能在这里自己做。
    const isFile = path.extname(pathname) !== '';
    if (!isFile || !fs.existsSync(filePath)) {
      return net.fetch('file://' + path.join(__dirname, '..', 'dist', 'view', 'index.html'));
    }
    return net.fetch('file://' + filePath);
  });

  setupApiIPC();
  setupTerminalIPC();
  setupClipboardIPC();
  setupMenu();

  // 初始化服务（仅生产模式加载模块，开发模式由 Vite 提供）
  // 必须等依赖就绪：连库、迁移、Redis、初始管理员都在这一里，
  // 否则首个登录请求会报「表不存在」或没有初始账号。
  ensureServicesReady().then((services) => {
    if (services) console.log('[Electron] Services initialized (production mode)');
    else console.log('[Electron] Services skipped (dev mode - using Vite dev server)');
  });

  let target;
  if (isDev) {
    target = devUrl;
    console.log(`[Electron] Dev mode, connecting to ${target}`);
  } else {
    target = 'app://local/view/index.html';
    console.log(`[Electron] Production mode, loading ${target}`);
  }

  createWindow(target);

  // 初始化自动更新（生产模式启用，开发模式自动禁用）
  initAutoUpdater({ isDev });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(target);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
