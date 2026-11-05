import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SSHService } from './ssh.service';
import { OS_FAMILY_LABEL, jsonItems, localFamily, readSections, scriptFor, scriptForWindowsWith } from '../utils/os-detect';
import type { OsFamily } from '../utils/os-detect';

/**
 * 服务器状态采集。
 *
 * 设计要点：
 *  1) 远端只用一条只读命令（独立 exec 通道）拿全部指标，每 2 秒一刷也不会占满 SSH 通道，
 *     且不打断终端里的前台进程；
 *  2) 命令按识别出来的系统家族下发（Windows / macOS / Linux / HarmonyOS / 其它 Unix），
 *     各家的口径差异在 normalize() 里抹平，后面的差值计算只有一套逻辑；
 *  3) CPU 占用率与网络速率都是「差值」，必须由服务端记住上一次采样，
 *     否则每次都得在远端 sleep 采样，面板刷新就会拖到一两秒；
 *     Windows / macOS 的系统命令直接给瞬时值，就用瞬时值；
 *  4) 本机会话（本地 Shell）没有远端主机，改用 Node 的 os / fs 采集；
 *     任何一项拿不到都明确标记「不可用」，而不是报 0 骗人。
 */

/** 面板展示用的服务器状态快照，容量统一用字节，比例统一用 0-100 的数值 */
export interface ServerStatusSnapshot {
  /** 采样时间戳 */
  at: number;
  hostname: string;
  /** 发行版描述，如 Ubuntu 24.04 LTS / macOS 15.2 / HarmonyOS 4.0 */
  os: string;
  /** 识别出来的系统家族：面板按它显示徽标，也用来解释某项指标为什么不可用 */
  osFamily: OsFamily;
  cpuModel: string;
  cpuCores: number;
  /** CPU 占用率 0-100 */
  cpuPercent: number;
  /** 1 / 5 / 15 分钟平均负载；Windows 没有这个概念，是空数组 */
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
  /** 各项指标在当前系统上是否采得到 */
  cpuSupported: boolean;
  memSupported: boolean;
  diskSupported: boolean;
  swapSupported: boolean;
  netSupported: boolean;
}

/** 各家族脚本输出归一化后的中间结构 */
interface NormalizedStatus {
  hostname: string;
  os: string;
  cpuModel: string;
  cpuCores: number;
  /** /proc/stat 口径的累计 jiffies（Linux / 鸿蒙）：有它就用两次采样差值算占用率 */
  cpuStat?: { total: number; idle: number };
  /** 系统直接给出的瞬时占用率（Windows 的 WMI、macOS 的 top） */
  cpuInstant?: number;
  loadAvg: number[];
  uptimeSec: number;
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  disk?: { mount: string; total: number; used: number };
  /** 累计收发字节（Linux / macOS / 鸿蒙），与 netInstant 二选一 */
  net?: NetSample;
  /** 每秒速率（Windows 的 WMI 性能计数器就是这个口径，不需要差值） */
  netInstant?: { rx: number; tx: number };
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

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** /proc/meminfo 摘出来的 `MemTotal:16384000` 这类行 ⇒ 对象（单位 KB） */
function parseMemInfo(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of (raw || '').split(/\r?\n/)) {
    const m = /^(\w+):\s+(\d+)/.exec(line.trim());
    if (m) out[m[1]] = num(m[2]);
  }
  return out;
}

/** `cpu  123 456 ...` ⇒ 总 jiffies 与空闲 jiffies（idle + iowait） */
function parseCpuStat(stat: string): { total: number; idle: number } | null {
  const m = /^cpu\s+(.+)$/.exec((stat || '').trim());
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
  // 字段顺序：rx_bytes(0) ... tx_bytes(8)
  if (nums.length < 9) return null;
  return { iface: m[1].trim(), rx: nums[0], tx: nums[8] };
}

/**
 * `/proc/net/dev` 的整段文本 ⇒ 逐个非回环网卡的累计收发。
 * 本机采集（读文件）与远端采集（脚本回传）共用，段内按行分隔。
 */
function parseNetDev(raw: string): NetSample[] {
  const list: NetSample[] = [];
  for (const chunk of (raw || '').split(/\r?\n/)) {
    const item = parseNetLine(chunk);
    if (!item || item.iface === 'lo' || item.iface === 'lo0') continue;
    list.push(item);
  }
  return list;
}

/**
 * `netstat -ibn`（macOS / BSD）⇒ 网卡累计收发。
 * 同一块网卡会按协议族重复出现，取同名网卡里最大的一组，避免重复累加。
 */
function parseNetstatIb(raw: string): NetSample[] {
  const perIface = new Map<string, NetSample>();
  for (const line of (raw || '').split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const iface = cols[0];
    if (!iface || iface === 'lo0' || iface === 'lo') continue;
    const rx = num(cols[6]);
    const tx = num(cols[9]);
    if (rx <= 0 && tx <= 0) continue;
    const prev = perIface.get(iface);
    if (!prev || rx + tx > prev.rx + prev.tx) perIface.set(iface, { iface, rx, tx });
  }
  return [...perIface.values()];
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

/** `df -kP /` 单行 ⇒ 挂载点与容量（字节） */
function parseDfLine(line: string): { mount: string; total: number; used: number } | null {
  const parts = (line || '').trim().split(/\s+/);
  if (parts.length < 6) return null;
  return { mount: parts[5], total: num(parts[1]) * 1024, used: num(parts[2]) * 1024 };
}

/** 取段内最后一行：df 这类输出前面可能有表头，最后一行才是数据 */
function lastLine(raw: string): string {
  const lines = (raw || '').split(/\r?\n/).filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1] : '';
}

function firstLine(raw: string): string {
  const lines = (raw || '').split(/\r?\n/).filter((l) => l.trim());
  return lines.length ? lines[0] : '';
}

/** `PRETTY_NAME="Ubuntu 24.04 LTS"` 优先，其次 NAME+VERSION_ID，最后 /etc/issue 里的人话 */
function prettyOsName(raw: string, fallback: string): string {
  const text = raw || '';
  const pretty = /PRETTY_NAME="?([^"\r\n]+)"?/i.exec(text);
  if (pretty) return pretty[1].trim();
  const name = /^NAME="?([^"\r\n]+)"?/im.exec(text);
  const version = /^VERSION_ID="?([^"\r\n]+)"?/im.exec(text);
  if (name) return `${name[1].trim()}${version ? ' ' + version[1].trim() : ''}`;
  const issue = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/%[a-zA-Z]/.test(l) && !/^#\d+$/ .test(l));
  return issue || fallback;
}

// ========== 各家族的归一化解析 ==========

/** Linux 与鸿蒙共用 /proc 口径；鸿蒙的 cpuinfo 是整段 cat，所以核数/型号要从里面数 */
function normalizeProc(family: OsFamily, s: Record<string, string>): NormalizedStatus {
  const mem = parseMemInfo(s.MEM || '');
  const memTotal = num(mem.MemTotal) * 1024;
  // MemAvailable 才是「真正还能用」的口径；老内核没有这个字段时退回 free+buffers+cached
  const memAvailable = num(mem.MemAvailable) > 0
    ? num(mem.MemAvailable) * 1024
    : (num(mem.MemFree) + num(mem.Buffers) + num(mem.Cached)) * 1024;
  const swapTotal = num(mem.SwapTotal) * 1024;
  const swapFree = num(mem.SwapFree) * 1024;

  // 鸿蒙脚本没有 nproc，只把整段 /proc/cpuinfo cat 到 CORES 段；Linux 的 CPU 段才是 model 行
  const cpuinfo = s.CPU || s.CORES || '';
  const modelLine = /^model name\s*:\s*(.+)$/im.exec(cpuinfo);
  const hardwareLine = /^(Hardware|Model name|Model)\s*:\s*(.+)$/im.exec(cpuinfo);
  let cpuCores = num(s.CORES);
  if (!cpuCores) {
    // /proc/cpuinfo 里每个核一个 processor 段，极简 shell 没有 nproc 时靠数行数
    cpuCores = (cpuinfo.match(/^processor\s*:/img) || []).length || 0;
  }

  const disk = parseDfLine(lastLine(s.DISK || ''));
  const loadAvg = (s.LOAD || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map(num);

  return {
    hostname: firstLine(s.HOST || ''),
    os: prettyOsName(s.OS || '', family === 'harmony' ? 'HarmonyOS' : `Linux ${(s.KERNEL || '').trim()}`),
    cpuModel: (modelLine?.[1] || hardwareLine?.[1] || '').trim(),
    cpuCores,
    cpuStat: parseCpuStat(s.STAT || '') || undefined,
    loadAvg,
    // /proc/uptime 第一段是秒
    uptimeSec: num((s.UPTIME || '').trim().split(/\s+/)[0]),
    memTotal,
    memUsed: memTotal > 0 ? Math.max(0, memTotal - memAvailable) : 0,
    swapTotal,
    swapUsed: Math.max(0, swapTotal - swapFree),
    disk: disk || undefined,
    net: summarizeNet(parseNetDev(s.NET || '')) || undefined,
  };
}

function normalizeLinux(s: Record<string, string>): NormalizedStatus {
  return normalizeProc('linux', s);
}

function normalizeHarmony(s: Record<string, string>): NormalizedStatus {
  const base = normalizeProc('harmony', s);
  // param 拿到的版本串比 /etc/os-release 更准（设备常两者都有），有就覆盖
  const ohos = (s.OHOS || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const version = ohos.find((l) => /harmony|ohos|\d/i.test(l));
  if (version) base.os = version;
  const model = ohos.find((l) => l !== version);
  if (model && !base.cpuModel) base.cpuModel = model;
  return base;
}

/** macOS：没有 /proc，全部走 sysctl / vm_stat / top / netstat */
function normalizeMacos(s: Record<string, string>): NormalizedStatus {
  const swVers = (s.OS || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const osName = swVers.length ? `${swVers[0]} ${swVers[1] || ''}`.trim() + (swVers[2] ? ` (${swVers[2]})` : '') : '';

  // vm_stat 表头带页大小，内存口径按 Activity Monitor 的「已用」近似：active + wired + compressed
  const pageMatch = /page size of (\d+) bytes/i.exec(s.MEM || '');
  const pageSize = num(pageMatch?.[1]) || 4096;
  const pages = (key: string) => {
    const m = new RegExp(`${key}:\\s+(\\d+)\\.`).exec(s.MEM || '');
    return m ? num(m[1]) * pageSize : 0;
  };
  const memTotal = num(firstLine(s.MEM || ''));
  // 空闲页 + 不活跃页 + 投机页都还能马上让出去，所以「已用」= 总量 - 这三项
  const memFreeBytes = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative'));

  const topIdle = /([0-9.]+)%\s*idle/i.exec(s.STAT || '');
  const cpuInstant = topIdle ? Math.max(0, Math.min(100, 100 - num(topIdle[1]))) : undefined;

  const loadMatch = /load averages?:\s*([\d.]+),?\s*([\d.]+),?\s*([\d.]+)/i.exec(s.LOAD || '');
  const bootSec = /sec\s*=\s*(\d+)/.exec(s.UPTIME || '');
  const swapMatch = {
    total: /total\s*=\s*([\d.]+)([KMG])/i.exec(s.SWAP || ''),
    used: /used\s*=\s*([\d.]+)([KMG])/i.exec(s.SWAP || ''),
  };
  const unit = (m: string | undefined) => ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as Record<string, number>)[(m || 'M').toUpperCase()] || 1;

  return {
    hostname: firstLine(s.HOST || ''),
    os: osName || `macOS ${(s.KERNEL || '').trim()}`,
    cpuModel: firstLine(s.CPU || ''),
    cpuCores: num(s.CORES),
    cpuInstant,
    loadAvg: loadMatch ? [num(loadMatch[1]), num(loadMatch[2]), num(loadMatch[3])] : [],
    uptimeSec: bootSec ? Math.max(0, Date.now() / 1000 - num(bootSec[1])) : 0,
    memTotal,
    memUsed: memTotal > 0 ? Math.max(0, Math.min(memTotal, memTotal - memFreeBytes)) : 0,
    swapTotal: swapMatch.total ? num(swapMatch.total[1]) * unit(swapMatch.total[2]) : 0,
    swapUsed: swapMatch.used ? num(swapMatch.used[1]) * unit(swapMatch.used[2]) : 0,
    disk: parseDfLine(lastLine(s.DISK || '')) || undefined,
    net: summarizeNet(parseNetstatIb(s.NET || '')) || undefined,
  };
}

/**
 * Windows 的日期字符串有三种形态，都得认：
 *  - PowerShell 5.1 的 ConvertTo-Json：`/Date(1793175565500+480)/`
 *  - pwsh 7 的 ConvertTo-Json：ISO 8601
 *  - WMI 原始串（没走 JSON 时）：`20261028081925.******+480`
 * 认不出来就返回 0，面板按「拿不到」处理，不会编一个开机时间。
 */
function parseWinDate(value: unknown): number {
  const text = String(value ?? '');
  const epoch = /\bDate\((\d+)(?:[+-]\d+)?\)/.exec(text);
  if (epoch) return num(epoch[1]);
  const wmi = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(text);
  if (wmi) {
    return new Date(num(wmi[1]), num(wmi[2]) - 1, num(wmi[3]), num(wmi[4]), num(wmi[5]), num(wmi[6])).getTime();
  }
  const iso = new Date(text).getTime();
  return Number.isNaN(iso) ? 0 : iso;
}

/** Windows：脚本回传的是 WMI 的 JSON 段，逐段取字段；WMI 没有的东西（load average）留空 */
function normalizeWindows(s: Record<string, string>): NormalizedStatus {
  const osRows = jsonItems(s.OS || '');
  const osInfo: any = osRows[0] || null;
  const cpus = jsonItems(s.CPU || '');
  const diskInfo: any = jsonItems(s.DISK || '')[0] || null;
  const pageFiles = jsonItems(s.SWAP || '');

  const cpuCores = cpus.reduce((sum, item) => sum + num(item.NumberOfLogicalProcessors), 0);
  // Win32_Processor.LoadPercentage 是每台 CPU 的平均值，多路机器取最大更接近「整机压力」
  const loads = cpus.map((item) => num(item.LoadPercentage)).filter((v) => v > 0);
  const memTotalKb = num(osInfo?.TotalVisibleMemorySize);
  const memFreeKb = num(osInfo?.FreePhysicalMemory);
  const swapTotalMb = pageFiles.reduce((sum, item) => sum + num(item.AllocatedBaseSize), 0);
  const swapUsedMb = pageFiles.reduce((sum, item) => sum + num(item.CurrentUsage), 0);

  let uptimeSec = 0;
  const bootAt = parseWinDate(osInfo?.LastBootUpTime);
  if (bootAt > 0) uptimeSec = Math.max(0, (Date.now() - bootAt) / 1000);

  const netRows = jsonItems(s.NET || '');
  const netRx = netRows.reduce((sum, item) => sum + num(item.BytesReceivedPersec), 0);
  const netTx = netRows.reduce((sum, item) => sum + num(item.BytesSentPersec), 0);
  const busiest = netRows.reduce((best, item) => (
    num(item.BytesReceivedPersec) + num(item.BytesSentPersec) > num(best?.BytesReceivedPersec) + num(best?.BytesSentPersec) ? item : best
  ), netRows[0]);

  return {
    hostname: firstLine(s.HOST || '') || String(osInfo?.CSName || ''),
    os: osInfo?.Caption
      ? `${osInfo.Caption}${osInfo.BuildNumber ? ` ${osInfo.BuildNumber}` : ''}`
      : 'Windows',
    cpuModel: String(cpus[0]?.Name || '').trim(),
    cpuCores,
    cpuInstant: loads.length ? Math.max(...loads) : undefined,
    loadAvg: [],
    uptimeSec,
    memTotal: memTotalKb * 1024,
    memUsed: memTotalKb > 0 ? Math.max(0, (memTotalKb - memFreeKb) * 1024) : 0,
    swapTotal: swapTotalMb * 1024 * 1024,
    swapUsed: swapUsedMb * 1024 * 1024,
    disk: diskInfo?.Size
      ? {
        mount: String(diskInfo.DeviceID || ''),
        total: num(diskInfo.Size),
        used: Math.max(0, num(diskInfo.Size) - num(diskInfo.FreeSpace)),
      }
      : undefined,
    // 速率已经由 WMI 算好，累计口径留 0，避免下一轮把「每秒值」当成累计量去做差
    netInstant: netRows.length ? { rx: netRx, tx: netTx } : undefined,
    net: netRows.length ? { iface: String(busiest?.Name || 'all'), rx: 0, tx: 0 } : undefined,
  };
}

/** BSD / Solaris 这类没专门适配的系统：能拿几项是几项，剩下的面板会标「不可用」 */
function normalizeUnix(s: Record<string, string>): NormalizedStatus {
  const memTotal = num(firstLine(s.MEM || ''));
  const uptimeMatch = /up\s+(\d+)\s+days?,\s*(\d+):(\d+)/i.exec(s.UPTIME || '');
  const dayMatch = /up\s+(\d+)\s+day/i.exec(s.UPTIME || '');
  const loadMatch = /load averages?:\s*([\d.]+),?\s*([\d.]+),?\s*([\d.]+)/i.exec(s.LOAD || '');
  return {
    hostname: firstLine(s.HOST || ''),
    os: prettyOsName(s.OS || '', (s.FULL || '').trim() || OS_FAMILY_LABEL.unix),
    cpuModel: (s.CPU || '').trim(),
    cpuCores: num(s.CORES),
    loadAvg: loadMatch ? [num(loadMatch[1]), num(loadMatch[2]), num(loadMatch[3])] : [],
    uptimeSec: dayMatch
      ? num(uptimeMatch?.[1]) * 86400 + num(uptimeMatch?.[2]) * 3600 + num(uptimeMatch?.[3]) * 60
      : 0,
    memTotal,
    memUsed: 0,
    swapTotal: 0,
    swapUsed: 0,
    disk: parseDfLine(lastLine(s.DISK || '')) || undefined,
    net: summarizeNet(parseNetstatIb(s.NET || '')) || undefined,
  };
}

/** 家族 → 归一化解析：所有口径差异止步于此，后面只面对 NormalizedStatus */
function normalize(family: OsFamily, s: Record<string, string>): NormalizedStatus {
  switch (family) {
    case 'windows': return normalizeWindows(s);
    case 'macos': return normalizeMacos(s);
    case 'harmony': return normalizeHarmony(s);
    case 'unix': return normalizeUnix(s);
    case 'linux':
    default: return normalizeLinux(s);
  }
}

/** 一眼就能看出脚本没跑起来的输出：命令原样被回显了（cmd / 极简 shell 的常见形态） */
function looksLikeShellEcho(raw: string): boolean {
  const text = (raw || '').toLowerCase();
  return /not recognized|command not found|no such file|syntax error|\becho __osd_/.test(text);
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

/** 本机会话的网络累计流量：三平台三套口径，都归一到 NetSample[] */
async function readLocalNet(): Promise<NetSample[] | null> {
  if (process.platform === 'linux') {
    try {
      const raw = await fs.promises.readFile('/proc/net/dev', 'utf-8');
      return parseNetDev(raw);
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const out = await runCommand('netstat', ['-ibn']);
    const list = parseNetstatIb(out);
    return list.length ? list : null;
  }
  if (process.platform === 'win32') {
    // Windows 本机没有分网卡的字节计数，netstat -e 给的是整机累计。
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
      const mem = parseMemInfo(await fs.promises.readFile('/proc/meminfo', 'utf-8'));
      const total = num(mem.SwapTotal) * 1024;
      if (total <= 0) return null;
      return { total, used: Math.max(0, total - num(mem.SwapFree) * 1024) };
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

  /** 远端：先定系统家族，再按家族下发脚本，最后统一归一化 */
  private async collectRemote(sessionId: string): Promise<ServerStatusSnapshot> {
    const family = await this.ssh.detectOsFamily(sessionId);
    if (family === 'unknown') {
      throw new Error('无法识别远端系统类型：既不是类 Unix（uname 无输出），也不认得 Windows 探测结果');
    }

    // Windows 要起 PowerShell，光进程启动就一两秒；其它家族一条 shell 内建命令足够快
    const timeoutMs = family === 'windows' ? 20000 : 8000;
    let sections = readSections(await this.ssh.execReadonly(sessionId, scriptFor(family), timeoutMs));
    if (!Object.keys(sections).length && family === 'windows') {
      // 只装了 pwsh 的机器没有 powershell.exe，换一次再试
      sections = readSections(await this.ssh.execReadonly(sessionId, scriptForWindowsWith(true), timeoutMs));
    }

    const parsed = normalize(family, sections);
    if (!this.hasAnyData(parsed)) {
      throw new Error(
        `识别为 ${OS_FAMILY_LABEL[family]}，但没采到任何指标：`
        + `${looksLikeShellEcho(Object.values(sections).join('\n')) ? '远端 shell 可能不支持脚本里的命令' : '该账号可能无权读取系统信息'}`,
      );
    }
    return this.assemble(sessionId, family, parsed);
  }

  /** 一个字段都没有就当采集失败：否则面板会显示一片 0，比报错更容易骗人 */
  private hasAnyData(parsed: NormalizedStatus): boolean {
    return Boolean(
      parsed.hostname || parsed.os || parsed.cpuCores || parsed.memTotal || parsed.disk
      || parsed.cpuStat || parsed.cpuInstant !== undefined || parsed.net || parsed.netInstant,
    );
  }

  /** 归一化结果 → 面板快照：差值在这里算，本机与远端共用同一段逻辑 */
  private assemble(sessionId: string, family: OsFamily, parsed: NormalizedStatus): ServerStatusSnapshot {
    const now = Date.now();
    const prev = this.samples.get(sessionId);

    let cpuPercent = parsed.cpuInstant ?? 0;
    if (parsed.cpuStat && prev && parsed.cpuStat.total > prev.cpuTotal) {
      const dTotal = parsed.cpuStat.total - prev.cpuTotal;
      const dIdle = Math.min(parsed.cpuStat.idle - prev.cpuIdle, dTotal);
      cpuPercent = ((dTotal - dIdle) / dTotal) * 100;
    }
    cpuPercent = Math.max(0, Math.min(100, cpuPercent));

    // 累计口径（Linux/macOS/鸿蒙）靠两次采样差值；瞬时口径（Windows）系统已经算好
    let netRxBps = parsed.netInstant?.rx ?? 0;
    let netTxBps = parsed.netInstant?.tx ?? 0;
    if (!parsed.netInstant && parsed.net && prev) {
      const dt = (now - prev.at) / 1000;
      if (dt > 0.2) {
        netRxBps = Math.max(0, (parsed.net.rx - prev.rx) / dt);
        netTxBps = Math.max(0, (parsed.net.tx - prev.tx) / dt);
      }
    }

    const snapshot: ServerStatusSnapshot = {
      at: now,
      hostname: parsed.hostname,
      os: parsed.os,
      osFamily: family,
      cpuModel: parsed.cpuModel,
      cpuCores: parsed.cpuCores,
      cpuPercent,
      loadAvg: parsed.loadAvg,
      uptimeSec: parsed.uptimeSec,
      memTotal: parsed.memTotal,
      memUsed: parsed.memUsed,
      swapTotal: parsed.swapTotal,
      swapUsed: parsed.swapUsed,
      diskTotal: parsed.disk?.total || 0,
      diskUsed: parsed.disk?.used || 0,
      diskMount: parsed.disk?.mount || '',
      netIface: parsed.net?.iface || (parsed.netInstant ? 'all' : ''),
      netRxBps,
      netTxBps,
      cpuSupported: parsed.cpuInstant !== undefined || parsed.cpuStat !== undefined,
      memSupported: parsed.memTotal > 0,
      diskSupported: !!parsed.disk && parsed.disk.total > 0,
      swapSupported: parsed.swapTotal > 0,
      netSupported: !!parsed.net || !!parsed.netInstant,
    };

    this.samples.set(sessionId, {
      at: now,
      cpuTotal: parsed.cpuStat?.total || 0,
      cpuIdle: parsed.cpuStat?.idle || 0,
      rx: parsed.net?.rx || 0,
      tx: parsed.net?.tx || 0,
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
    const loadAvg = os.loadavg().map((v) => Math.round(v * 100) / 100);
    const snapshot: ServerStatusSnapshot = {
      at: now,
      hostname: os.hostname(),
      // 本机就是本机：Node 的 os.type/release 比脚本更好拿，家族用 process.platform 判
      os: await this.localOsLabel(),
      osFamily: this.localFamilyCached(),
      cpuModel: cpus[0]?.model || '',
      cpuCores: cpus.length,
      cpuPercent,
      // Windows 上 os.loadavg() 恒为 [0,0,0]：这个平台没有 Unix 的平均负载概念，别当真值显示
      loadAvg: process.platform === 'win32' ? [] : loadAvg,
      uptimeSec: os.uptime(),
      memTotal,
      memUsed: Math.max(0, memTotal - os.freemem()),
      swapTotal: swap?.total || 0,
      swapUsed: swap?.used || 0,
      diskTotal,
      diskUsed,
      diskMount: diskTotal > 0 ? os.homedir() : '',
      netIface: net?.iface || '',
      netRxBps,
      netTxBps,
      cpuSupported: cpus.length > 0,
      memSupported: memTotal > 0,
      diskSupported: diskTotal > 0,
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

  /** 本机的可读系统名：Windows 的 Caption / macOS 的产品名 / Linux 的 PRETTY_NAME，拿不到就退回 os.type */
  private localOsCache: { at: number; value: string } | null = null;
  private localFamilyCache: OsFamily | null = null;

  private localFamilyCached(): OsFamily {
    if (!this.localFamilyCache) this.localFamilyCache = localFamily();
    return this.localFamilyCache;
  }

  /**
   * 只在服务自己这台机器上跑一次，结果缓存 5 分钟：
   * 面板 2 秒一刷，每次都去问 WMI / sw_vers 太浪费，而系统名也不会两秒变一次。
   */
  private async localOsLabel(): Promise<string> {
    const fallback = `${os.type()} ${os.release()}`;
    const family = this.localFamilyCached();
    if (family === 'unknown' || family === 'unix') return fallback;
    if (this.localOsCache && Date.now() - this.localOsCache.at < 300000) return this.localOsCache.value;

    let value = fallback;
    try {
      if (family === 'windows') {
        // 不带 UTF8 前缀时，中文系统的 Caption 会以 GBK 字节回来，解码成乱码写进面板
        const out = await runCommand('powershell', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; (Get-CimInstance Win32_OperatingSystem).Caption',
        ], 8000);
        const caption = out.trim().split(/\r?\n/).find((l) => l.trim());
        if (caption) value = `${caption.trim()} (${os.release()})`;
      } else if (family === 'macos') {
        const name = (await runCommand('sw_vers', ['-productName'])).trim();
        const version = (await runCommand('sw_vers', ['-productVersion'])).trim();
        if (name || version) value = `${name || 'macOS'} ${version}`.trim();
      } else {
        value = prettyOsName(fs.readFileSync('/etc/os-release', 'utf-8'), fallback);
      }
    } catch {
      // 拿不到就保留 Node 给的原样字符串，不影响其它指标
    }
    this.localOsCache = { at: Date.now(), value };
    return value;
  }
}
