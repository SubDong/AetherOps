#!/usr/bin/env node

const crypto = require('crypto');
const { exec, spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

const projectRoot = path.resolve(__dirname, '..');

// ============================================================
// 统一数据目录管理（与 server/utils/data-dir.ts 保持一致）
// 所有写入文件必须通过 getDataPath() 获取路径
// ============================================================

/** 获取数据目录路径 */
function getDataDir() {
  return process.env.AETHEROPS_DATA_DIR || path.join(os.homedir(), '.aetherops');
}

/** 获取数据目录下的文件路径 */
function getDataPath(...segments) {
  return path.join(getDataDir(), ...segments);
}

/** 递归修复权限：目录 755，文件 644 */
function fixPermissions(dir) {
  try {
    fs.chmodSync(dir, 0o755);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) fixPermissions(fullPath);
        else fs.chmodSync(fullPath, 0o644);
      } catch { /* 单个文件失败不影响其他 */ }
    }
  } catch { /* ignore */ }
}

/** 确保数据目录存在且可写 */
function ensureDataDir() {
  const dir = getDataDir();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    } else {
      try { fs.accessSync(dir, fs.constants.W_OK); } catch {
        fixPermissions(dir);
        try { fs.accessSync(dir, fs.constants.W_OK); } catch {
          throw new Error(`Permission denied even after chmod: ${dir}`);
        }
      }
    }
  } catch (e) {
    console.error(`Cannot access data directory ${dir}: ${e.message}`);
    console.error('Try: sudo chown -R $(whoami) ' + dir);
    process.exit(1);
  }
  return dir;
}

// PID 文件操作
// 服务端的 PID 文件是按端口区分的（server.js: aetherops.server.<PORT>.pid），
// 本 CLI 以前写死 aetherops.server.pid，两边对不上：server.js 自己写的 PID
// 本 CLI 根本读不到，stop 只能依赖 lsof 兑底（而 lsof 在 Windows 上不存在）。
// 现在统一按端口命名，并确保默认端口与配置层一致。
function loadRuntimeConfig() {
  try {
    const { loadConfig } = require(path.join(projectRoot, 'dist/server/utils/config'));
    return loadConfig();
  } catch {
    // dist 尚未构建（刚 clone 仓库 / 只装了依赖）：回退到与 config 默认值一致的行为
    return null;
  }
}
// 懒加载：loadConfig 在配置文件缺失时会生成模板，不能因为用户只跑了 -v / help
// 就往数据目录写文件；只真正需要配置的命令（start/stop/restart）才触发。
let _runtimeConfig;
let _runtimeConfigLoaded = false;
function getRuntimeConfig() {
  if (!_runtimeConfigLoaded) {
    _runtimeConfigLoaded = true;
    _runtimeConfig = loadRuntimeConfig();
  }
  return _runtimeConfig;
}
const pidFileFor = (port) => getDataPath(`aetherops.server.${port}.pid`);

const readPid = (port) => {
  const f = pidFileFor(port);
  return fs.existsSync(f) ? parseInt(fs.readFileSync(f, 'utf8')) : null;
};
const getAccessToken = () => {
  // loadConfig 已经把 AETHEROPS_ACCESS_TOKEN 等环境变量合进来了，优先用配置结果
  const cfg = getRuntimeConfig();
  const configured = cfg ? cfg.auth.accessToken : process.env.AETHEROPS_ACCESS_TOKEN;
  if (configured) return configured;
  ensureDataDir();
  const f = getDataPath('access-token');
  try {
    if (fs.existsSync(f)) {
      const token = fs.readFileSync(f, 'utf8').trim();
      if (token) return token;
    }
  } catch { /* ignore */ }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(f, token, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* ignore */ }
  return token;
};
const writePid = (pid, port) => {
  ensureDataDir();
  fs.writeFileSync(pidFileFor(port), pid.toString());
};
const deletePid = (port) => {
  const f = pidFileFor(port);
  if (fs.existsSync(f)) fs.unlinkSync(f);
};

/** 从命令行参数解析端口，start / stop / restart 共用 */
function resolvePort() {
  const portIndex = commandArgs.findIndex(arg => arg === '-p' || arg === '--port');
  const raw = portIndex !== -1 ? commandArgs[portIndex + 1] : undefined;
  const parsed = parseInt(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const cfg = getRuntimeConfig();
  return cfg ? cfg.server.port : (Number(process.env.PORT) || 9802);
}

const args = process.argv.slice(2);
const command = args[0] || 'help';
const commandArgs = args.slice(1);

switch (command) {
  case 'start': startProject(); break;
  case 'stop': stopProject(); break;
  case 'restart': restartProject(); break;
  case '-v':
  case '--version': showVersion(); break;
  default: showHelp(); break;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port);
  });
}

async function findAvailablePort(startPort) {
  let port = startPort;
  for (let i = 0; i < 100; i++) {
    if (await isPortAvailable(port)) return port;
    port++;
  }
  throw new Error(`Cannot find available port, tried 100 times`);
}

async function startProject() {
  console.log('Starting aetherops...');

  const port = resolvePort();
  const pid = readPid(port);
  if (pid) {
    try {
      process.kill(pid, 0);
      console.log('Server is already running with PID:', pid);
      return;
    } catch (error) {
      if (error.code === 'ESRCH') {
        console.log('Cleaning up stale PID file...');
        deletePid(port);
      }
    }
  }

  let startPort = port;

  try {
    startPort = await findAvailablePort(startPort);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  ensureDataDir();
  const logFilePath = getDataPath('server.log');
  let logFileFd;
  try {
    logFileFd = fs.openSync(logFilePath, 'a');
  } catch (e) { /* ignore */ }

  const child = spawn('node', ['server.js', '-p', startPort.toString()], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', logFileFd || 'inherit', logFileFd || 'inherit']
  });

  child.unref();
  writePid(child.pid, startPort);

  const accessToken = getAccessToken();
  const startUrl = `http://localhost:${startPort}/?token=${encodeURIComponent(accessToken)}`;
  console.log('Server started with PID:', child.pid);
  console.log(`aetherops is running at http://localhost:${startPort}`);
  openBrowser(startUrl);
}

function stopProject() {
  console.log('Stopping aetherops...');

  // 端口解析与 start 共用同一入口（不再各自写死 9801）
  const port = resolvePort();

  let stopped = false;

  // 1) 优先用 PID 文件
  const pid = readPid(port);
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log('Stopped process from PID file:', pid);
      stopped = true;
    } catch (error) {
      if (error.code !== 'ESRCH') {
        console.error('Failed to stop PID', pid + ':', error.message);
      }
    }
  }

  // 2) 兜底：查找监听该端口的进程（PID 文件丢失/跨用户/进程已变均适用）
  const portPids = findPidsByPort(port);
  for (const p of portPids) {
    try {
      process.kill(p, 'SIGTERM');
      console.log('Stopped process on port', port + ':', p);
      stopped = true;
    } catch (error) {
      if (error.code !== 'ESRCH') {
        console.error('Failed to stop PID', p + ':', error.message);
      }
    }
  }

  // 3) 清理本端口的 PID 文件，避免下次 start 误判
  deletePid(port);

  if (stopped) {
    console.log('Server stopped');
  } else {
    console.log('No running aetherops server found on port', port);
  }
}

// 查找监听指定端口的进程 PID（Windows 用 netstat，其余平台用 lsof）
function findPidsByPort(port) {
  const pids = new Set();
  if (process.platform === 'win32') {
    try {
      // netstat -ano 行形如：  TCP  0.0.0.0:9802  0.0.0.0:0  LISTENING  1234
      const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5 || cols[3].toUpperCase() !== 'LISTENING') continue;
        if (cols[1].endsWith(':' + port)) {
          const p = parseInt(cols[4]);
          if (!Number.isNaN(p) && p !== process.pid) pids.add(p);
        }
      }
    } catch { /* netstat 不可用或无可匹配进程 */ }
    return [...pids];
  }
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null`).toString().trim();
    if (out) {
      for (const line of out.split('\n')) {
        const p = parseInt(line.trim());
        if (!isNaN(p)) pids.add(p);
      }
    }
  } catch { /* lsof 不可用或无可匹配进程 */ }
  return [...pids];
}

function restartProject() {
  stopProject();
  const port = resolvePort();
  for (let i = 0; i < 10; i++) {
    if (!readPid(port)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  startProject();
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  const args = platform === 'win32' ? ['', url] : [url];
  const proc = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: platform === 'win32' });
  proc.unref();
}

function showVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  console.log(pkg.version);
}

function showHelp() {
  console.log('aetherops - AI-powered SSH Terminal');
  console.log('');
  console.log('Usage:');
  console.log('  aetherops start    Start the server');
  console.log('  aetherops stop     Stop the server');
  console.log('  aetherops restart  Restart the server');
  console.log('  aetherops -v       Show version');
  console.log('');
}
