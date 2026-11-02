import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SSHService } from './ssh.service';

/**
 * 服务器状态采集。
 *
 * 设计要点：
 *  1) 远端只用一条只读 shell 命令（独立 exec 通道）拿全部指标，
 *     每 2 秒轮询一次也不会把 SSH 通道占满，且不会打断终端里的前台进程；
 *  2) CPU 占用率与网络速率都是「差值」，必须由服务端记住上一次采样，
 *     否则每次都得在远端 sleep 采样，面板刷新就会拖到一两秒；
 *  3) 本机会话（本地 Shell）没有远端主机，改用 Node 的 os / fs 采集，
 *     Swap 与网络拿不到就明确标记为「不可用」，而不是报 0 骗人。
 */

/** 面板展示用的服务器状态快照，容量统一用字节，比例统一用 0-100 的数值 */
export interface ServerStatusSnapshot {
  /** 采样时间戳 */
  at: number;
  hostname: string;
  /** 发行版描述，如 Ubuntu 24.04 LTS */
  os: string;
  cpuModel: string;
  cpuCores: number;
  /** CPU 占用率 0-100 */
  cpuPercent: number;
  /** 1 / 5 / 15 分钟平均负载 */
  loadAvg: number[];
  uptimeSec: number;
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  diskTotal: number;
  diskUsed: number;
  diskMount: string;
  netIface: string;
  /** 网络收发速率（字节/秒） */
  netRxBps: number;
  netTxBps: number;
  /** 该主机是否真有 Swap / 网络指标可采（本机会话通常没有） */
  swapSupported: boolean;
  netSupported: boolean;
}

/** 上一次采样：所有速率类指标都要靠它与本次的差值算 */
interface PrevSample {
  at: number;
  cpuTotal: number;
  cpuIdle: number;
  rx: number;
  tx: number;
  snapshot: ServerStatusSnapshot;
}

/** 单块网卡的累计收发字节 */
interface NetSample {
  iface: string;
  rx: number;
  tx: number;
}

const execFileAsync = promisify(execFile);

/**
 * 远端采集脚本。
 * 全部用 grep / cut / tr / tail 拼，刻意避开 awk —— awk 的脚本本身要用单引号，
 * 套在外层命令里就得再转义一层，很容易在「$2 被 shell 先展开」这种地方翻车。
 */
const STATUS_SCRIPT = [
  'HOST=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)',
  "OS=$(. /etc/os-release 2>/dev/null; printf '%s' \"$PRETTY_NAME\")",
  "CPUNAME=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2)",
  'CORES=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)',
  "LOAD=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)",
  "UPTIME=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)",
  'STAT=$(head -n1 /proc/stat 2>/dev/null)',
  "MEMINFO=$(grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null | tr -d ' ' | tr '\\n' ';')",
  'DISKLINE=$(df -kP / 2>/dev/null | tail -n1)',
  // 多网卡都取回来（管道分隔）：只取第一块容易抽到 docker0/veth 这种零流量的虚拟网卡
  "NETDEV=$(grep -E '^ *[a-zA-Z0-9_.:-]+:' /proc/net/dev 2>/dev/null | grep -v '^ *lo:' | tr '\\n' '|')",
  "printf 'HOST=%s\\nOS=%s\\nCPUNAME=%s\\nCORES=%s\\nLOAD=%s\\nUPTIME=%s\\nSTAT=%s\\nMEMINFO=%s\\nDISKLINE=%s\\nNETDEV=%s\\n' \"$HOST\" \"$OS\" \"$CPUNAME\" \"$CORES\" \"$LOAD\" \"$UPTIME\" \"$STAT\" \"$MEMINFO\" \"$DISKLINE\" \"$NETDEV\"",
].join('\n');

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 把 `KEY=value` 多行输出解析成对象（值里允许出现 = ） */
function parseKvLines(output: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    map[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return map;
}

/** /proc/meminfo 摘出来的 `MemTotal:16384000;MemAvailable:...;` ⇒ 对象（单位 KB） */
function parseMemInfo(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    out[pair.slice(0, idx)] = num(pair.slice(idx + 1));
  }
  return out;
}

/** `cpu  123 456 ...` ⇒ 总 jiffies 与空闲 jiffies（idle + iowait） */
function parseCpuStat(stat: string): { total: number; idle: number } | null {
  const m = /^cpu\s+(.+)$/.exec(stat.trim());
  if (!m) return null;
  const nums = m[1].trim().split(/\s+/).map(num);
  if (nums.length < 4) return null;
  const idle = nums[3] + (nums[4] || 0);
  return { total: nums.reduce((a, b) => a + b, 0), idle };
}

/** `/proc/net/dev` 单行 ⇒ 接口名与累计收发字节 */
function parseNetLine(line: string): NetSample | null {
  const m = /^\s*([^:]+):\s*(.+)$/.exec(line || '');
  if (!m) return null;
  const nums = m[2].trim().split(/\s+/).map(num);
  // 字段顺序：rx_bytes ...(0)  tx_bytes ...(8)
  if (nums.length < 9) return null;
  return { iface: m[1].trim(), rx: nums[0], tx: nums[8] };
}

/** 管道分隔的多网卡串 `eth0: ...|ens5: ...|` ⇒ 逐个网卡的累计收发（已剔除回环） */
function parseNetDev(raw: string): NetSample[] {
  const list: NetSample[] = [];
  for (const chunk of raw.split('|')) {
    const item = parseNetLine(chunk);
    if (!item || item.iface === 'lo' || item.iface === 'lo0') continue;
    list.push(item);
  }
  return list;
}

/**
 * 汇总全部非回环网卡：速率按总量算（容器 / VPN 的流量也是这台机器真切的进出带宽），
 * 标签取流量最大的那块网卡，多于一块有流量时补个 +N。
 */
function summarizeNet(list: NetSample[]): NetSample | null {
  if (!list.length) return null;
  let rx = 0;
  let tx = 0;
  let active = 0;
  let primary = list[0].iface;
  let best = -1;
  for (const item of list) {
    rx += item.rx;
    tx += item.tx;
    const total = item.rx + item.tx;
    if (total > 0) active++;
    if (total > best) {
      best = total;
      primary = item.iface;
    }
  }
  return { iface: active > 1 ? `${primary} +${active - 1}` : primary, rx, tx };
}

/** 调一次系统命令，拿不到就返回空串（监控采集不该因为缺命令而报错） */
async function runCommand(file: string, args: string[], timeout = 3000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return String(stdout || '');
  } catch (error: any) {
    return typeof error?.stdout === 'string' ? error.stdout : '';
  }
}

/**
 * 本机会话的网络累计流量。
 * 三个平台三套口径：Linux 读 /proc/net/dev，macOS 解析 netstat -ib，
 * Windows 只有 netstat -e 的整机字节数（没有分网卡计数器）。
 */
async function readLocalNet(): Promise<NetSample[] | null> {
  if (process.platform === 'linux') {
    try {
      const raw = await fs.promises.readFile('/proc/net/dev', 'utf-8');
      return parseNetDev(raw.split(/\r?\n/).join('|'));
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const out = await runCommand('netstat', ['-ibn']);
    // 同一块网卡会按协议族重复出现，取同名网卡里最大的一组，避免重复累加
    const perIface = new Map<string, NetSample>();
    for (const line of out.split(/\r?\n/).slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const iface = cols[0];
      if (!iface || iface === 'lo0' || iface === 'lo') continue;
      const rx = num(cols[6]);
      const tx = num(cols[9]);
      const prev = perIface.get(iface);
      if (!prev || rx + tx > prev.rx + prev.tx) perIface.set(iface, { iface, rx, tx });
    }
    return perIface.size ? [...perIface.values()] : null;
  }
  if (process.platform === 'win32') {
    // Windows 没有分网卡的字节计数，netstat -e 给的是整机累计。
    // 行首标题随系统语言变（英文 Bytes / 中文 字节），只认「行尾两个整数」的第一行 = 字节行
    const out = await runCommand('netstat', ['-e']);
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*\D.*?(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) return [{ iface: 'all', rx: num(m[1]), tx: num(m[2]) }];
    }
    return null;
  }
  return null;
}

/** Windows 页面文件要起 PowerShell，几百毫秒起步；30 秒缓存一次就够 */
let swapCache: { at: number; value: { total: number; used: number } | null } | null = null;

/** Swap：Linux 读 /proc/meminfo，macOS 问 sysctl，Windows 看页面文件 */
async function readLocalSwap(): Promise<{ total: number; used: number } | null> {
  if (process.platform === 'linux') {
    try {
      const raw = await fs.promises.readFile('/proc/meminfo', 'utf-8');
      const pick = (key: string) => {
        const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(raw);
        return m ? Number(m[1]) * 1024 : 0;
      };
      const total = pick('SwapTotal');
      if (total <= 0) return null;
      return { total, used: Math.max(0, total - pick('SwapFree')) };
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    // total = 2048.00M  used = 215.25M  free = 1832.75M
    const out = await runCommand('sysctl', ['-n', 'vm.swapusage']);
    const pick = (key: string) => {
      const m = new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMG])`, 'i').exec(out);
      if (!m) return 0;
      const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase() as 'K' | 'M' | 'G'] || 1;
      return Number(m[1]) * unit;
    };
    const total = pick('total');
    return total > 0 ? { total, used: pick('used') } : null;
  }
  if (process.platform === 'win32') {
    if (swapCache && Date.now() - swapCache.at < 30000) return swapCache.value;
    const out = await runCommand('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$p = Get-CimInstance Win32_PageFileUsage; $t = ($p | Measure-Object AllocatedBaseSize -Sum).Sum; $u = ($p | Measure-Object CurrentUsage -Sum).Sum; "{0} {1}" -f $t, $u',
    ], 8000);
    const m = /(\d+)\s+(\d+)/.exec(out);
    const value = m ? { total: num(m[1]) * 1024 * 1024, used: num(m[2]) * 1024 * 1024 } : null;
    swapCache = { at: Date.now(), value };
    return value;
  }
  return null;
}

/** `df -kP /` 单行 ⇒ 挂载点与容量（字节） */
function parseDfLine(line: string): { mount: string; total: number; used: number } | null {
  const parts = (line || '').trim().split(/\s+/);
  if (parts.length < 6) return null;
  return { mount: parts[5], total: num(parts[1]) * 1024, used: num(parts[2]) * 1024 };
}

export class SystemStatusService {
  private ssh: SSHService;
  /** 按会话保存上一次采样：CPU 与网络速率都依赖两次采样的差值 */
  private samples = new Map<string, PrevSample>();
  /** 同一会话的最小采样间隔：多个面板同时轮询时别重复开 SSH 通道 */
  private readonly minIntervalMs = 1000;

  constructor(ssh: SSHService) {
    this.ssh = ssh;
  }

  /**
   * 采集指定终端会话所在主机的状态。
   * sessionId 的归属由调用方（handleRoutes）统一校验，这里只管数据。
   */
  async collect(sessionId: string): Promise<ServerStatusSnapshot> {
    const type = this.ssh.getSessionType(sessionId);
    if (!type) throw new Error('会话不存在或已断开');

    const cached = this.samples.get(sessionId);
    if (cached && Date.now() - cached.at < this.minIntervalMs) return cached.snapshot;

    return type === 'ssh' ? this.collectRemote(sessionId) : this.collectLocal(sessionId);
  }

  /** 远端 Linux：一条命令拿全，差值在本地算 */
  private async collectRemote(sessionId: string): Promise<ServerStatusSnapshot> {
    const raw = await this.ssh.execReadonly(sessionId, STATUS_SCRIPT, 8000);
    if (!raw.trim()) {
      throw new Error('未取到监控数据：远端可能不是 Linux，或该账号无权读取 /proc');
    }

    const kv = parseKvLines(raw);
    const now = Date.now();
    const prev = this.samples.get(sessionId);

    const cpu = parseCpuStat(kv.STAT || '');
    let cpuPercent = 0;
    if (cpu && prev && cpu.total > prev.cpuTotal) {
      const dTotal = cpu.total - prev.cpuTotal;
      const dIdle = Math.min(cpu.idle - prev.cpuIdle, dTotal);
      cpuPercent = ((dTotal - dIdle) / dTotal) * 100;
    }
    cpuPercent = Math.max(0, Math.min(100, cpuPercent));

    const net = summarizeNet(parseNetDev(kv.NETDEV || ''));
    let netRxBps = 0;
    let netTxBps = 0;
    if (net && prev) {
      const dt = (now - prev.at) / 1000;
      if (dt > 0.2) {
        netRxBps = Math.max(0, (net.rx - prev.rx) / dt);
        netTxBps = Math.max(0, (net.tx - prev.tx) / dt);
      }
    }

    const mem = parseMemInfo(kv.MEMINFO || '');
    const memTotal = num(mem.MemTotal) * 1024;
    // MemAvailable 才是「真正还能用」的口径；老内核没有这个字段时退回 free+buffers+cached
    const memAvailable = num(mem.MemAvailable) > 0
      ? num(mem.MemAvailable) * 1024
      : (num(mem.MemFree) + num(mem.Buffers) + num(mem.Cached)) * 1024;
    const swapTotal = num(mem.SwapTotal) * 1024;
    const swapFree = num(mem.SwapFree) * 1024;

    const disk = parseDfLine(kv.DISKLINE || '');

    const snapshot: ServerStatusSnapshot = {
      at: now,
      hostname: kv.HOST || '',
      os: kv.OS || '',
      cpuModel: (kv.CPUNAME || '').trim(),
      cpuCores: num(kv.CORES),
      cpuPercent,
      loadAvg: (kv.LOAD || '').split(/\s+/).filter(Boolean).slice(0, 3).map(num),
      uptimeSec: num(kv.UPTIME),
      memTotal,
      memUsed: Math.max(0, memTotal - memAvailable),
      swapTotal,
      swapUsed: Math.max(0, swapTotal - swapFree),
      diskTotal: disk?.total || 0,
      diskUsed: disk?.used || 0,
      diskMount: disk?.mount || '/',
      netIface: net?.iface || '',
      netRxBps,
      netTxBps,
      swapSupported: swapTotal > 0,
      netSupported: !!net,
    };

    this.samples.set(sessionId, {
      at: now,
      cpuTotal: cpu?.total || 0,
      cpuIdle: cpu?.idle || 0,
      rx: net?.rx || 0,
      tx: net?.tx || 0,
      snapshot,
    });
    return snapshot;
  }

  /** 本机会话：Node 直接取本机指标，网络 / Swap 走各平台自己的口径 */
  private async collectLocal(sessionId: string): Promise<ServerStatusSnapshot> {
    const now = Date.now();
    const prev = this.samples.get(sessionId);

    const [netList, swap] = await Promise.all([readLocalNet(), readLocalSwap()]);
    const net = summarizeNet(netList || []);

    let netRxBps = 0;
    let netTxBps = 0;
    if (net && prev) {
      const dt = (now - prev.at) / 1000;
      if (dt > 0.2) {
        netRxBps = Math.max(0, (net.rx - prev.rx) / dt);
        netTxBps = Math.max(0, (net.tx - prev.tx) / dt);
      }
    }

    const cpus = os.cpus();
    let cpuTotal = 0;
    let cpuIdle = 0;
    for (const cpu of cpus) {
      const times = cpu.times;
      cpuTotal += times.user + times.nice + times.sys + times.idle + times.irq;
      cpuIdle += times.idle;
    }
    let cpuPercent = 0;
    if (prev && cpuTotal > prev.cpuTotal) {
      const dTotal = cpuTotal - prev.cpuTotal;
      const dIdle = Math.min(cpuIdle - prev.cpuIdle, dTotal);
      cpuPercent = ((dTotal - dIdle) / dTotal) * 100;
    }
    cpuPercent = Math.max(0, Math.min(100, cpuPercent));

    let diskTotal = 0;
    let diskUsed = 0;
    try {
      const statfs = (fs as any).statfsSync;
      if (typeof statfs === 'function') {
        const stat = statfs(os.homedir());
        diskTotal = num(stat.blocks) * num(stat.bsize);
        diskUsed = (num(stat.blocks) - num(stat.bfree)) * num(stat.bsize);
      }
    } catch {
      // 平台不支持 statfs 就不显示磁盘，不影响其它指标
    }

    const memTotal = os.totalmem();
    const snapshot: ServerStatusSnapshot = {
      at: now,
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      cpuModel: cpus[0]?.model || '',
      cpuCores: cpus.length,
      cpuPercent,
      loadAvg: os.loadavg().map((v) => Math.round(v * 100) / 100),
      uptimeSec: os.uptime(),
      memTotal,
      memUsed: Math.max(0, memTotal - os.freemem()),
      swapTotal: swap?.total || 0,
      swapUsed: swap?.used || 0,
      diskTotal,
      diskUsed,
      diskMount: os.homedir(),
      netIface: net?.iface || '',
      netRxBps,
      netTxBps,
      swapSupported: !!swap,
      netSupported: !!net,
    };

    this.samples.set(sessionId, {
      at: now,
      cpuTotal,
      cpuIdle,
      rx: net?.rx || 0,
      tx: net?.tx || 0,
      snapshot,
    });
    return snapshot;
  }
}
