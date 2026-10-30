import { fileURLToPath, URL } from 'node:url';
import * as http from "node:http";
import * as url from "node:url";
import { defineConfig, type Connect, type PluginOption } from 'vite';

import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import CopyPlugin from 'vite-plugin-files-copy';
import ViteNunjucksPlugin from '@fefeding/vite-nunjucks-plugin';
import * as path from 'path';
import * as fs from 'fs';

// 直接导入服务端代码（开发模式不再依赖编译产物）
//
// 服务实例一律复用 server/index 的：自己再 new 一份，会出现「WS 在实例 A 上建会话、
// REST 在实例 B 上查不到」这种只在 dev 才复现的怪问题。
// 初始化时机与 server.js 完全一致：ensureDatabaseReady -> probeRedis -> initServices。
import {
  initServices as initServerServices,
  handleRoutes,
  connectionService,
  sshService,
  skillService,
  auditService,
  monitorService,
  batchService,
  aiService,
  snippetService,
  type AuthContext,
} from './server/index';
import { authenticate } from './server/service/auth.service';
import { PUBLIC_PATHS, handleAccountRoutes } from './server/routes/auth.routes';
import { extractBearerToken, isAllowedOrigin, normalizeUploadName, maxUploadBytes } from './server/utils/security';

const urlPrefix = process.env.PREFIX ? `/${process.env.PREFIX}` : '';
const devUploadLimitBytes = maxUploadBytes();

let servicesReady: Promise<void> | null = null;
function initServices(): Promise<void> {
  if (!servicesReady) {
    servicesReady = initServerServices().catch((e: any) => {
      // dev 模式把原因说清楚：这是「没连上库/Redis」而不是「页面白屏」
      console.error(`[dev] 服务初始化失败: ${e && e.message ? e.message : e}`);
      servicesReady = null;
      throw e;
    });
  }
  return servicesReady;
}

/** 读取 JSON 请求体：dev 模式没有 express.json() */
function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/**
 * 独立端点（上传 / 取 cwd）不走 handleRoutes，
 * 所以权限点与会话归属要自己校一遍——与 server.js 的 assertSessionAccess 保持一致。
 */
function assertSessionAccess(ctx: AuthContext | null, sessionId: string, permissionKeys: string[]) {
  if (!ctx) return { ok: false, status: 401, error: 'Unauthorized' };
  const permissions = (ctx.permissions || {}) as Record<string, boolean>;
  if (!permissionKeys.some((k) => permissions[k])) {
    return { ok: false, status: 403, error: 'Forbidden: missing permission' };
  }
  const owner = sshService.getSessionOwner(String(sessionId));
  if (owner && owner !== ctx.userId) {
    return { ok: false, status: 403, error: 'Forbidden: session belongs to another user' };
  }
  return { ok: true };
}

const defaultInitState = {
    "config": {"prefix": urlPrefix, "apiUrl": process.env.API_URL||""},
    "title": process.env.TITLE || 'aetherops Terminal'
};

const nunjucksPlugin = ViteNunjucksPlugin({
    variables: {
        prefix: '',
        viteTarget: '',
        __DEFAULTINITIAL_STATE__: JSON.stringify(defaultInitState),
    }
});

const viewDir = path.resolve(__dirname, './src');

const config = defineConfig({
    publicDir: false,
    plugins: [
        vue() as PluginOption,
        vueJsx() as PluginOption,
        // @ts-ignore
        CopyPlugin({ patterns: [] }),
        nunjucksPlugin,
        {
            name: 'copy-server-files',
            writeBundle: async () => {
                const serverSrcDir = path.resolve(__dirname, './server');
                const serverDistDir = path.resolve(__dirname, './dist/server');
                if (!fs.existsSync(serverDistDir)) {
                    fs.mkdirSync(serverDistDir, { recursive: true });
                }
                const copyRecursiveSync = (src: string, dest: string) => {
                    const exists = fs.existsSync(src);
                    const stats = exists ? fs.statSync(src) : null;
                    const isDirectory = exists && stats && stats.isDirectory();
                    if (isDirectory) {
                        if (!fs.existsSync(dest)) fs.mkdirSync(dest);
                        fs.readdirSync(src).forEach(childItemName => {
                            copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
                        });
                    } else {
                        if (src.endsWith('.ts') || src.endsWith('.js')) fs.copyFileSync(src, dest);
                    }
                };
                copyRecursiveSync(serverSrcDir, serverDistDir);
                console.log('Server files copied to', serverDistDir);
            }
        },
        {
            name: 'fix-html-paths',
            writeBundle: async () => {
                const publicDir = path.resolve(__dirname, './dist/public');
                // 产物文件名为固定 [name].js（无内容哈希），WebView 极易缓存旧版本 JS，
                // 导致重建后前端改动迟迟不生效；这里给静态资源引用加上构建时间戳强制失效缓存。
                const assetVersion = Date.now().toString(36);
                // HTML 输出路径随源目录变化：src/index.html -> dist/public/src/index.html
                const htmlPath = path.join(publicDir, 'src/index.html');
                if (fs.existsSync(htmlPath)) {
                    let html = fs.readFileSync(htmlPath, 'utf-8');
                    html = html.replace(/\.\.\/([a-zA-Z0-9_-]+\.(js|css|woff|woff2|png|jpg|jpeg|gif|svg|ico))/g, '/public/$1?v=' + assetVersion);
                    fs.writeFileSync(htmlPath, html);
                }
                // 纯终端页（VSCode 扩展 WebView 用）：留在 src/ 下被静态服务，
                // 仅重写 ../ 资源引用为 /public/ 绝对路径
                const termHtmlPath = path.join(publicDir, 'src/term.html');
                if (fs.existsSync(termHtmlPath)) {
                    let termHtml = fs.readFileSync(termHtmlPath, 'utf-8');
                    termHtml = termHtml.replace(/\.\.\/([a-zA-Z0-9_-]+\.(js|css|woff|woff2|png|jpg|jpeg|gif|svg|ico))/g, '/public/$1?v=' + assetVersion);
                    fs.writeFileSync(termHtmlPath, termHtml);
                }
                // VSCode 扩展 WebView 专用终端页（复用 TerminalTab，含 AI 对话 / 文件浏览）
                const vscodeHtmlPath = path.join(publicDir, 'src/vscode-term.html');
                if (fs.existsSync(vscodeHtmlPath)) {
                    let vscodeHtml = fs.readFileSync(vscodeHtmlPath, 'utf-8');
                    vscodeHtml = vscodeHtml.replace(/\.\.\/([a-zA-Z0-9_-]+\.(js|css|woff|woff2|png|jpg|jpeg|gif|svg|ico))/g, '/public/$1?v=' + assetVersion);
                    fs.writeFileSync(vscodeHtmlPath, vscodeHtml);
                }
                // VSCode 扩展「新增 / 编辑连接」专用页（复用 ConnectionEditor）
                const vscodeEditHtmlPath = path.join(publicDir, 'src/vscode-edit.html');
                if (fs.existsSync(vscodeEditHtmlPath)) {
                    let vscodeEditHtml = fs.readFileSync(vscodeEditHtmlPath, 'utf-8');
                    vscodeEditHtml = vscodeEditHtml.replace(/\.\.\/([a-zA-Z0-9_-]+\.(js|css|woff|woff2|png|jpg|jpeg|gif|svg|ico))/g, '/public/$1?v=' + assetVersion);
                    fs.writeFileSync(vscodeEditHtmlPath, vscodeEditHtml);
                }
                const viewHtmlPath = path.join(publicDir, 'src/index.html');
                const destViewDir = path.resolve(__dirname, './dist/view');
                const destViewHtmlPath = path.join(destViewDir, 'index.html');
                if (fs.existsSync(viewHtmlPath)) {
                    if (!fs.existsSync(destViewDir)) fs.mkdirSync(destViewDir, { recursive: true });
                    let html = fs.readFileSync(viewHtmlPath, 'utf-8');
                    fs.writeFileSync(destViewHtmlPath, html);
                    fs.unlinkSync(viewHtmlPath);
                    // 清理空的 src 目录
                    const srcDir = path.join(publicDir, 'src');
                    if (fs.existsSync(srcDir) && fs.readdirSync(srcDir).length === 0) {
                        fs.rmdirSync(srcDir);
                    }
                }
            }
        },
        {
            name: 'vite-plugin-spa-fallback-with-nunjucks',
            configureServer(server) {
                return () => {
                    server.middlewares.use(async (req: http.IncomingMessage, res: http.ServerResponse, next: Connect.NextFunction) => {
                        const requestUrl = req.url || '';
                        if (requestUrl.startsWith('/api/') || requestUrl.startsWith('/ws/')) return next();
                        if (requestUrl.startsWith('/@vite/') || requestUrl.startsWith('/__vite_')) return next();
                        if (req.headers.upgrade === 'websocket') return next();
                        if (requestUrl !== '/index.html' && (/\.[a-zA-Z0-9]{1,4}(\?.*)?$/.test(requestUrl) || requestUrl.includes('@vite/client'))) return next();
                        const accept = req.headers.accept || '';
                        if (!accept.includes('text/html')) return next();
                        try {
                            const indexPath = path.resolve(viewDir, 'index.html');
                            if (!fs.existsSync(indexPath)) return next();
                            let html = fs.readFileSync(indexPath, 'utf-8');
                            html = await nunjucksPlugin.transformIndexHtml(html, { path: indexPath });
                            res.statusCode = 200;
                            res.setHeader('Content-Type', 'text/html');
                            res.end(html);
                        } catch (e: any) {
                            return next(e);
                        }
                    });
                };
            },
        },
        {
            name: 'server-api',
            async configureServer(server) {
                // 只在开发服务器启动时初始化服务
                await initServices();
                server.middlewares.use(async (req: Connect.IncomingMessage, res: http.ServerResponse, next: Connect.NextFunction) => {
                    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
                    const pathname = requestUrl.pathname;
                    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
                        res.statusCode = 403;
                        res.end('Forbidden origin');
                        return;
                    }

                    // 登录态在这里统一解析，后面的路由直接读 ctx，与 server.js 同一套语义：
                    // HTTP 只认 Bearer，?token= 只留给 WebSocket 升级（URL 里的令牌不该扩散到普通接口）
                    const token = extractBearerToken(req.headers)
                        || (pathname.startsWith('/ws/') ? requestUrl.searchParams.get('token') || '' : '');
                    let user: AuthContext | null = null;
                    if (token) {
                        try {
                            user = await authenticate(token) as unknown as AuthContext;
                        } catch (err: any) {
                            // Redis 故障等：不把异常当「已登录」，但要落日志而不是静默 401
                            console.error('[dev][Auth] 令牌校验失败: ' + (err && err.message ? err.message : err));
                        }
                    }
                    (req as any).user = user;
                    (req as any).authToken = token;

                    // 只有接口需要登录：静态资源与 SPA 必须放行，否则登录页本身打不开
                    const needsAuth = pathname.startsWith('/api/') || pathname.startsWith('/ws/');
                    if (needsAuth && !PUBLIC_PATHS.has(pathname) && !user) {
                        res.statusCode = 401;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ ret: 401, msg: 'Unauthorized', error: 'unauthorized' }));
                        return;
                    }

                    // 账号相关端点：直接调 server 侧同一份实现，不在这里再写一遍
                    if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/users/') || pathname.startsWith('/oauth/')) {
                        try {
                            const body = req.method && req.method.toUpperCase() === 'POST' ? await readJsonBody(req) : {};
                            const handled = await handleAccountRoutes(pathname, body, {
                                token,
                                user: user as any,
                                ip: String(req.socket?.remoteAddress || '').replace(/^::ffff:/, ''),
                            });
                            if (!handled) { next(); return; }
                            if (handled.headers) {
                                for (const [k, v] of Object.entries(handled.headers)) res.setHeader(k, v as string);
                            }
                            res.statusCode = handled.status;
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify(handled.body));
                        } catch (err: any) {
                            console.error('[dev] Auth API Error:', err);
                            res.statusCode = 500;
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify({ ret: 500, msg: err?.message || 'Internal server error' }));
                        }
                        return;
                    }

                    if (pathname.startsWith('/api/')) {
                        // serverRoute 是异步的，必须 await：不 await 拿到的是 Promise，永远为真
                        if (!(await serverRoute(req, res, next, user))) {
                            res.statusCode = 404;
                            res.end('Not Found');
                        }
                    } else {
                        next();
                    }
                });
            },
        },
        {
            name: 'server-ws',
            async configureServer(server) {
                // 只在开发服务器启动时初始化服务
                await initServices();
                try {
                    console.log('[WS] SSH service initialized from source');

                    const WebSocket = require('ws');
                    // 使用 noServer: true 避免和 Vite 的 HMR WebSocket 冲突
                    const wss = new WebSocket.Server({ noServer: true, maxPayload: Math.ceil(devUploadLimitBytes * 1.4) });
                    console.log('[WS] WebSocket server (noServer) ready for /ws/terminal');

                    // 手动处理 upgrade，只拦截 /ws/terminal 路径
                    server.httpServer.on('upgrade', async (req, socket, head) => {
                        const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
                        if (requestUrl.pathname === '/ws/terminal') {
                            if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
                                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                                socket.destroy();
                                return;
                            }
                            // 浏览器 WebSocket 带不了自定义请求头，令牌走 ?token=
                            const upgradeToken = extractBearerToken(req.headers) || requestUrl.searchParams.get('token');
                            let wsUser: AuthContext | null = null;
                            try { wsUser = await authenticate(upgradeToken) as unknown as AuthContext; }
                            catch (err: any) { console.error('[dev][WS] 令牌校验失败: ' + (err && err.message ? err.message : err)); }
                            if (!wsUser) {
                                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                                socket.destroy();
                                return;
                            }
                            // 终端权限在门禁处就拦掉，不要等进入 switch 才判
                            if (!wsUser.permissions || !wsUser.permissions.terminal) {
                                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                                socket.destroy();
                                return;
                            }
                            (req as any).user = wsUser;
                            wss.handleUpgrade(req, socket, head, (ws: any) => {
                                wss.emit('connection', ws, req);
                            });
                        }
                        // 其他 WebSocket 请求（如 Vite HMR）不处理，自动放行
                    });

                    wss.on('connection', async (ws: any, req: any) => {
                        const wsUser: AuthContext = req.user;
                        const ownerId = wsUser.userId;
                        console.log(`[WS] Client connected to Vite dev WebSocket user=${wsUser.username}`);
                        let sessionId: string | null = null;

                        // 捕获底层 socket 的 error 事件，防止 EAGAIN 等错误成为未捕获异常导致进程崩溃
                        if (ws._socket) {
                            ws._socket.on('error', (err: any) => {
                                if (err && (err.code === 'EAGAIN' || err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
                                    console.warn('[WS] Socket recoverable error (code=%s): %s', err.code, err.message);
                                } else {
                                    console.error('[WS] Socket error:', err);
                                }
                            });
                        }
                        ws.on('error', (err: any) => {
                            if (err && (err.code === 'EAGAIN' || err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
                                console.warn('[WS] Recoverable socket error (code=%s): %s', err.code, err.message);
                                return;
                            }
                            console.error('[WS] WebSocket error:', err);
                        });

                        // 安全发送 WebSocket 消息：捕获 EAGAIN 等写入异常，防止未处理的 'error' 事件导致进程崩溃
                        // highFreq=true 时启用背压检测，缓冲区超过阈值则丢弃该消息（终端输出可丢帧，不影响连接）
                        const WS_BACKPRESSURE_LIMIT = 4 * 1024 * 1024; // 4MB
                        const safeSend = (data: string, highFreq = false) => {
                            if (ws.readyState !== WebSocket.OPEN) return;
                            if (highFreq && ws.bufferedAmount > WS_BACKPRESSURE_LIMIT) {
                                console.warn(`[WS] Backpressure: dropping message (buffered: ${ws.bufferedAmount} bytes)`);
                                return;
                            }
                            try {
                                ws.send(data);
                            } catch (err: any) {
                                // EAGAIN / ECONNRESET / EPIPE 等 — 记录但不崩溃
                                console.warn(`[WS] safeSend error (code=${err.code}): ${err.message}`);
                            }
                        };

                        ws.on('message', async (raw: Buffer) => {
                            let msg: any;
                            try {
                                msg = JSON.parse(raw.toString());
                            } catch (e) {
                                safeSend(JSON.stringify({ type: 'error', data: 'Invalid message format' }));
                                return;
                            }

                            const { type, sessionId: sid, data } = msg;

                            // 会话归属校验：sessionId 由前端传入，必须属于当前登录人，
                            // 否则猜到别人的 id 就能读写对方终端。type=create 例外（新建）。
                            const targetSessionId = type === 'ai-agent-run' ? (data && data.aiSessionId) : sid;
                            if (targetSessionId && type !== 'create') {
                                const owner = sshService.getSessionOwner(targetSessionId);
                                if (owner && owner !== ownerId) {
                                    console.warn(`[WS] 拒绝访问他人会话: user=${wsUser.username} session=${targetSessionId}`);
                                    safeSend(JSON.stringify({ type: 'error', sessionId: targetSessionId, data: 'Forbidden: session belongs to another user' }));
                                    return;
                                }
                            }

                            switch (type) {
                                case 'create': {
                                    const { connectionId, cols, rows, name } = data || {};
                                    if (!connectionId) {
                                        safeSend(JSON.stringify({ type: 'error', data: 'Missing connectionId' }));
                                        return;
                                    }
                                    sessionId = sid || `ssh-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
                                    try {
                                        // SSH 连接过程日志推送到前端终端信息流（绕过 ZMODEM sentry）
                                        const sendLog = (msg: string) => {
                                            safeSend(JSON.stringify({ type: 'conn-log', sessionId, data: msg }));
                                        };

                                        const sshSession = await sshService.createSession(sessionId, connectionId, cols || 80, rows || 24, name, sendLog, ownerId);

                                        // 根据会话类型设置数据接收
                                        const sendOutput = (chunk: any) => {
                                            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(typeof chunk === 'string' ? chunk : chunk);
                                            const hasBinary = buf.some((b: number) => b > 127);
                                            // 通知输出监听器（用于 Agent 捕获输出）
                                            if (!hasBinary) {
                                                try { sshService.notifyOutput(sessionId!, buf.toString('utf-8')); } catch(e) {}
                                            }
                                            const zmSig = Buffer.from([42, 42, 24, 66]);
                                            if (buf.length >= 4 && buf.includes(zmSig)) {
                                                console.log('[WS-DEBUG] ZMODEM sig in SSH output! buf.length:', buf.length,
                                                    'hasBinary:', hasBinary,
                                                    'first 30 bytes:', Array.from(buf.slice(0, 30)).join(','));
                                            }
                                            if (hasBinary) {
                                                safeSend(JSON.stringify({ type: 'terminal', sessionId, data: buf.toString('base64'), binary: true }), true);
                                            } else {
                                                safeSend(JSON.stringify({ type: 'terminal', sessionId, data: buf.toString('utf-8') }), true);
                                            }
                                        };
                                        const sendClose = (source: string) => () => {
                                            safeSend(JSON.stringify({ type: 'close', sessionId }));
                                        };

                                        if (sshSession.pty) {
                                            // node-pty 模式
                                            sshSession.pty.onData(sendOutput);
                                            sshSession.pty.onExit(sendClose('Local PTY'));
                                        } else if (sshSession.childProcess) {
                                            // child_process 降级模式
                                            sshSession.childProcess.stdout?.on('data', sendOutput);
                                            sshSession.childProcess.stderr?.on('data', sendOutput);
                                            sshSession.childProcess.on('exit', sendClose('Local shell'));
                                        } else if (sshSession.stream) {
                                            // SSH 模式
                                            sshSession.stream.on('data', sendOutput);
                                            sshSession.stream.on('close', sendClose('SSH stream'));
                                        }

                                        safeSend(JSON.stringify({ type: 'status', sessionId, data: 'connected' }));
                                    } catch (err: any) {
                                        safeSend(JSON.stringify({ type: 'error', sessionId, data: err.message || '连接失败' }));
                                    }
                                    break;
                                }
                                case 'terminal': {
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
                                    if (sid) sshService.resize(sid, data.cols, data.rows);
                                    break;
                                }
                                case 'close': {
                                    if (sid) sshService.closeSession(sid);
                                    break;
                                }
                                case 'ai-agent-run': {
                                    const { aiSessionId, message, context, skillId, locale } = data || {};
                                    if (!wsUser.permissions || !wsUser.permissions.ai) {
                                        safeSend(JSON.stringify({ type: 'ai-agent-event', event: { type: 'error', error: 'Forbidden: missing permission' } }));
                                        break;
                                    }
                                    if (!aiSessionId || !message) {
                                        safeSend(JSON.stringify({ type: 'ai-agent-event', event: { type: 'error', error: 'Missing params' } }));
                                        break;
                                    }
                                    aiService.agentRun(ownerId, aiSessionId, message, context, (event: any) => {
                                        safeSend(JSON.stringify({ type: 'ai-agent-event', sessionId: aiSessionId, event }));
                                    }, skillId, locale).catch((err: any) => {
                                        safeSend(JSON.stringify({ type: 'ai-agent-event', sessionId: aiSessionId, event: { type: 'error', error: err.message } }));
                                    });
                                    break;
                                }
                                case 'ai-agent-stop': {
                                    const { aiSessionId: stopSid } = data || {};
                                    if (stopSid) aiService.stopAgent(ownerId, stopSid);
                                    break;
                                }
                            }
                        });

                        ws.on('close', () => {
                            if (sessionId) sshService.closeSession(sessionId);
                        });
                    });
                } catch (e) {
                    console.error('[WS] Failed to start WebSocket server:', e);
                }
            },
        },
    ],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            '#': fileURLToPath(new URL('../', import.meta.url)),
        },
    },
    build: {
        outDir: 'dist/public',
        assetsInlineLimit: 4096,
        manifest: true,
        minify: false,
        modulePreload: true,
        rollupOptions: {
            external: ['../../server/index', './server/index'],
            input: getViewInputs(viewDir),
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: '[name].js',
                assetFileNames: '[name].[ext]',
                manualChunks(id) {
                    const ms = [...id.matchAll(/\/node_modules\/([^\/]+)\//ig)];
                    if (ms && ms.length) {
                        const m = ms[ms.length - 1];
                        if (m && m[1]) {
                            if (m[1].includes('@vue') || m[1].includes('vue-') || m[1] == 'vue') return 'vue';
                            if (m[1].includes('bootstrap')) return 'bootstrap';
                            if (m[1].includes('xterm')) return 'xterm';
                        }
                    }
                }
            }
        },
    },
    base: urlPrefix,
    server: {
        host: process.env.HOST || process.env.AETHEROPS_HOST || '127.0.0.1',
        port: +`${process.env.VITE_PORT}` || 9801,
        cors: false,
    },
});
export default config;

function getViewInputs(dir: string): { [key: string]: string } {
    const entries = fs.readdirSync(dir);
    const htmlFiles = entries.filter(filename => filename.endsWith('.html'));
    const inputObj: { [key: string]: string } = {};
    for (const file of htmlFiles) {
        const name = path.basename(file, '.html');
        inputObj[name] = path.resolve(dir, file);
    }
    return inputObj;
}

async function serverRoute(req: Connect.IncomingMessage, res: http.ServerResponse, next: Connect.NextFunction, ctx: AuthContext | null) {
    try {
        if (!req.url?.startsWith('/api/')) return next();
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname || '';
        const method = req.method?.toLowerCase();

        // 文件上传端点：接收原始二进制数据，通过 SFTP 写入远程服务器
        if (pathname === '/api/file-upload') {
            const sessionId = req.headers['x-session-id'] as string;
            let fileName: string;
            try {
                fileName = normalizeUploadName(req.headers['x-file-name'] as string);
            } catch (err: any) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message || 'Invalid file name' }));
                return true;
            }
            if (!sessionId || !fileName) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing X-Session-Id or X-File-Name header' }));
                return true;
            }
            const uploadAccess = assertSessionAccess(ctx, sessionId, ['files', 'terminal']);
            if (!uploadAccess.ok) {
                res.writeHead(uploadAccess.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: uploadAccess.error, fileName }));
                return true;
            }
            const chunks: Buffer[] = [];
            let receivedBytes = 0;
            let aborted = false;
            req.on('data', (chunk: Buffer) => {
                receivedBytes += chunk.length;
                if (receivedBytes > devUploadLimitBytes) {
                    aborted = true;
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `File too large, limit ${devUploadLimitBytes} bytes`, fileName }));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', async () => {
                if (aborted) return;
                try {
                    const fileBuffer = Buffer.concat(chunks);
                    console.log(`[HTTP-Upload] Received ${fileBuffer.length} bytes, calling SFTP...`);
                    const bytes = await sshService!.uploadFileViaSftp(sessionId, fileName, fileBuffer);
                    console.log(`[HTTP-Upload] SFTP done: ${fileName}, ${bytes} bytes`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, bytes, fileName }));
                } catch (err: any) {
                    console.error(`[HTTP-Upload] Error: ${err.message}`);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: err.message, fileName }));
                }
            });
            req.on('error', (err: Error) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            });
            return true;
        }

        // 查询当前终端所在目录（dev 模式：上传前由前端拉取，确保文件落到当前目录）
        // zmodem=1 表示远端 rz 正在等待接收文件：禁止注入式探测，避免打断 rz
        if (pathname === '/api/cwd' && method === 'get') {
            const sessionId = (req.headers['x-session-id'] as string) || (parsedUrl.query.sessionId as string);
            if (!sessionId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing sessionId' }));
                return true;
            }
            const zmodem = parsedUrl.query.zmodem === '1' || parsedUrl.query.zmodem === 'true';
            const force = parsedUrl.query.force === '1' || parsedUrl.query.force === 'true';
            const cwdAccess = assertSessionAccess(ctx, sessionId, ['files', 'terminal']);
            if (!cwdAccess.ok) {
                res.writeHead(cwdAccess.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, cwd: '', error: cwdAccess.error }));
                return true;
            }
            try {
                const { cwd, reliable } = await sshService!.getSessionCwdDetailed(String(sessionId), {
                    allowShellProbe: !zmodem,
                    preferTransferProcess: !!zmodem,
                    force,
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, cwd, reliable }));
            } catch (err: any) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, cwd: '', error: err.message || String(err) }));
            }
            return true;
        }

        if (method !== 'post') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ret: 405, msg: 'Only POST method is allowed' }));
            return true;
        }
        const body = await readJsonBody(req);
        try {
            const data = await handleRoutes(pathname, body, ctx as AuthContext);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ret: 0, msg: 'success', data }));
        } catch (error: any) {
            console.error(error);
            // ApiError 自带 statusCode：403 不能报成 500，否则前端分不清「没权限」和「服务异常」
            const status = error?.statusCode || 500;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ret: status, msg: error?.message || '系统异常' }));
        }
    } catch (error: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ret: 500, msg: error.message || 'Internal server error' }));
    }
    return true;
}

// 业务路由全部走 server/index 的 handleRoutes：
// 之前 dev 模式自己维护一份 handleRoute，两边签名一改就出现「生产能用、dev 401/500」的差异，
// 账号体系把 ownerId 串进了每个仓储，两份实现已经无法靠人工保持同步。

