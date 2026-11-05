import * as fs from 'fs';
import * as os from 'os';

/**
 * 操作系统自识别与「一条命令拿全」的采集脚本。
 *
 * 为什么要有这个模块：服务器状态面板和 AI 助手的环境信息原先都按 Linux 写死
 * （读 /proc、用 /etc/os-release），连上 Windows / macOS / 鸿蒙设备时命令要么不存在
 * 要么全空，面板一片 0、AI 拿到的环境描述也是错的。现在先探测家族，再按家族发对应脚本。
 *
 * 脚本统一用「标记行 + 原始输出」的分段格式，刻意不用 `$(...)` 命令替换：
 *  - OpenHarmony 的 msh 是极简 shell，命令替换与 awk 之类不一定有；
 *  - Windows 上 sshd 的默认 shell 可能是 cmd.exe 也可能是 PowerShell，两种都要能跑。
 * 所以每条命令自己把结果打到 stdout，分段靠 `__OSD_XXX__` 标记，解析全在服务端做。
 */

/** 前四种是需求点名的，unix 是 BSD/Solaris 这类兜底，unknown 表示两轮探测都没结果 */
export type OsFamily = 'windows' | 'macos' | 'linux' | 'harmony' | 'unix' | 'unknown';

/** 展示与写进 AI 提示用的名字 */
export const OS_FAMILY_LABEL: Record<OsFamily, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  harmony: 'HarmonyOS',
  unix: 'Unix-like',
  unknown: 'Unknown',
};

const MARKER_RE = /__OSD_([A-Z0-9_]+)__/;

/** 拼一段「echo 标记; 命令」，命令失败就留空段，不影响其它指标 */
function section(key: string, ...commands: string[]): string {
  return [`echo __OSD_${key}__`, ...commands].join('; ');
}

/** Windows 段：PowerShell 里 echo 是 Write-Output 别名，标记照常打出来 */
function psSection(key: string, ...expressions: string[]): string {
  return [`Write-Output __OSD_${key}__`, ...expressions].join('; ');
}

/** 脚本里用过的命令名：回显行（cmd 把 `;` 当参数分隔符时会连着命令一起打出来）靠它识别 */
const SCRIPT_WORD_RE = /^(uname|cat|echo|param|sw_vers|sysctl|df|hostname|whoami|head|grep|netstat|uptime|top|node|python3?|docker|command|Get-CimInstance|Write-Output)\b/i;

/**
 * 把 `echo __OSD_X__` + 后续输出切成段。
 * 标记按「行内包含」匹配，因为 cmd 会把 `echo A; hostname` 合并成一行 `A hostname`。
 * 一行里出现两个以上标记 = 这条是把整段脚本回显出来了（写进交互式终端时必有），
 * 直接丢弃，真正的数据在后面的行里。
 */
export function readSections(raw: string): Record<string, string> {
  const buckets: Record<string, string[]> = {};
  let key = '';
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const hit = MARKER_RE.exec(trimmed);
    if (hit) {
      const second = MARKER_RE.exec(trimmed.slice(hit.index + hit[0].length));
      if (second) continue; // 回显的脚本本身
      key = hit[1];
      buckets[key] = buckets[key] || [];
      const rest = trimmed.slice(hit.index + hit[0].length).replace(/^[;\s]+/, '').trim();
      // 只有标记行的行尾残余需要过滤（cmd 会把 `echo A; hostname` 合成一行）；
      // 普通数据行不筛，否则 `Python 3.11.2`、`Docker version 24.0.7` 这种正经输出会被误杀
      if (rest && !SCRIPT_WORD_RE.test(rest)) buckets[key].push(rest);
      continue;
    }
    if (key) buckets[key].push(trimmed);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(buckets)) out[k] = v.join('\n').trim();
  return out;
}

/** 探测脚本：只问最基础的问题，任何 shell 里都不该整段炸掉 */
export const PROBE_SCRIPT = [
  section('UNAME', 'uname -s'),
  section('FULL', 'uname -a'),
  section('OSREL', 'cat /etc/os-release'),
  section('OHOS', 'param get const.product.software.version'),
].join('; ');

/** POSIX 命令一点输出都没有时才发这条：cmd 会展开 %OS%，PowerShell 会原样打印，两者都能认出 Windows */
export const WINDOWS_PROBE_SCRIPT = 'echo __OSD_WIN__; echo AOPS_%OS%; ver';

/**
 * OpenHarmony / HarmonyOS 的识别信号。
 * 内核还是 Linux，所以 uname 给的是 Linux；区别在 os-release 写的是 OpenHarmony、
 * 有 `param` 这个鸿蒙特有的属性命令、内核串里带 HongMeng。
 */
function looksLikeHarmony(osrel: string, full: string, ohos: string): boolean {
  const rel = osrel.toLowerCase();
  if (/openharmony|harmonyos|\bohos\b/.test(rel)) return true;
  if (/hongmeng|harmony/i.test(full)) return true;
  return /openharmony|harmony|\bohos\b/i.test(ohos);
}

const OTHER_UNIX_RE = /FREEBSD|OPENBSD|NETBSD|DRAGONFLY|SUNOS|SOLARIS|AIX|HP-UX|IRIX|OSF1|GNU\/HURD/i;
/** Git Bash / Cygwin / MSYS 的 uname 形如 MINGW64_NT-10.0：壳是 POSIX，机器仍是 Windows */
const WINDOWS_UNAME_RE = /_NT|CYGWIN|MSYS|MINGW/i;

/**
 * 依据探测结果定家族。winProbeRaw 为空表示没做过 Windows 探测。
 */
export function detectFamily(sections: Record<string, string>, winProbeRaw = ''): OsFamily {
  const uname = (sections.UNAME || '').toUpperCase();
  const full = sections.FULL || '';
  if (uname.includes('DARWIN')) return 'macos';
  if (uname.includes('LINUX')) {
    return looksLikeHarmony(sections.OSREL || '', full, sections.OHOS || '') ? 'harmony' : 'linux';
  }
  if (uname && WINDOWS_UNAME_RE.test(uname)) return 'windows';
  if (uname && OTHER_UNIX_RE.test(uname)) return 'unix';
  // uname 认不出来但确实有输出：按类 Unix 兜底，至少 hostname / df 通常能用
  if (uname) return 'unix';
  if (/WINDOWS_NT|%OS%|MICROSOFT WINDOWS \[VERSION/i.test(winProbeRaw)) return 'windows';
  return 'unknown';
}

/**
 * 本机（跑服务这台机器 / 本地 Shell）属于哪个家族。
 * Linux 内核的鸿蒙发行版在 Node 里也报 linux，所以还要看 os-release。
 */
export function localFamily(): OsFamily {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') {
    try {
      if (looksLikeHarmony(fs.readFileSync('/etc/os-release', 'utf-8'), '', '')) return 'harmony';
    } catch {
      // 读不到 os-release 就按普通 Linux
    }
    return 'linux';
  }
  // Node 在 BSD 上会报 freebsd/openbsd/sunos 等，uname 前缀去掉即家族
  return OTHER_UNIX_RE.test(os.type()) ? 'unix' : 'unknown';
}

/**
 * Windows 的脚本要点：整条命令行里不能出现 `$`、`%`、`"` 和反引号。
 * 因为 sshd 的默认 shell 可能是 cmd（会展开 %VAR%、把 `"` 当参数边界），
 * 也可能是 PowerShell（会在双引号参数里展开 `$变量`）。
 * 于是取数一律走 `Select-Object -ExpandProperty` 或 `ConvertTo-Json`，
 * 变量读取走 `[Environment]::GetEnvironmentVariable('X')`。
 */
function psWrap(script: string): string {
  return `powershell -NoProfile -NonInteractive -Command "try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; ${script}"`;
}

const PS_OS = `(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,CSName,TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime | ConvertTo-Json -Compress)`;
const PS_CPU = `(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfLogicalProcessors,LoadPercentage | ConvertTo-Json -Compress)`;
const PS_PAGEFILE = `(Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize,CurrentUsage | ConvertTo-Json -Compress)`;
const PS_DISK = `(Get-CimInstance Win32_LogicalDisk | Where-Object DeviceID -eq ([Environment]::GetEnvironmentVariable('SystemDrive')) | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress)`;
const PS_NET = `(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Select-Object Name,BytesReceivedPersec,BytesSentPersec | ConvertTo-Json -Compress)`;

/** 有流量但 WMI 性能计数器不给 Name 时的占位，交给上层判断 */
const WINDOWS_ENV_SCRIPT = psWrap([
  psSection('HOST', `[Environment]::MachineName`),
  psSection('OS', PS_OS),
  psSection('CPU', PS_CPU),
  psSection('ARCH', `[Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE')`),
  psSection('USER', `[Environment]::GetEnvironmentVariable('USERNAME')`),
  psSection('SHELL', `'PowerShell'`),
  psSection('KERNEL', `[Environment]::OSVersion.Version.ToString()`),
  psSection('MEM', PS_OS),
  psSection('SWAP', PS_PAGEFILE),
  psSection('DISK', PS_DISK),
  psSection('NET', PS_NET),
  // 工具版本直接跑命令拿字符串：`(Get-Command node).Version` 会被 PowerShell 排成
  // “Major Minor Build Revision” 的表格，拿到一堆表头而不是版本号
  psSection('NODE', 'try { node --version } catch { }'),
  psSection('PYTHON', 'try { python --version } catch { try { python3 --version } catch { } }'),
  psSection('DOCKER', 'try { docker --version } catch { }'),
].join('; '));

const POSIX_COMMON_TAIL = [
  section('PM', 'command -v apt-get || command -v dnf || command -v yum || command -v pacman || command -v zypper || command -v apk || command -v brew'),
  section('NODE', 'node --version'),
  section('PYTHON', 'python3 --version || python --version'),
  section('DOCKER', 'docker --version'),
];

const LINUX_SCRIPT_BODY = [
  section('HOST', 'hostname'),
  section('OS', 'cat /etc/os-release', 'cat /etc/issue.net'),
  section('UNAME', 'uname -s'),
  section('FULL', 'uname -a'),
  section('KERNEL', 'uname -r'),
  section('ARCH', 'uname -m'),
  section('USER', 'whoami'),
  section('SHELL', 'echo $SHELL'),
  section('CORES', 'nproc'),
  section('CPU', "grep -m1 'model name' /proc/cpuinfo"),
  section('LOAD', 'cat /proc/loadavg'),
  section('UPTIME', 'cat /proc/uptime'),
  section('STAT', 'head -n1 /proc/stat'),
  section('MEM', "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo"),
  section('DISK', 'df -kP /'),
  section('NET', "grep -E '^ *[a-zA-Z0-9_.:-]+:' /proc/net/dev | grep -v '^ *lo:'"),
  ...POSIX_COMMON_TAIL,
].join('; ');

const MACOS_SCRIPT_BODY = [
  section('HOST', 'hostname'),
  section('OS', 'sw_vers -productName', 'sw_vers -productVersion', 'sw_vers -buildVersion'),
  section('UNAME', 'uname -s'),
  section('FULL', 'uname -a'),
  section('KERNEL', 'uname -r'),
  section('ARCH', 'uname -m'),
  section('USER', 'whoami'),
  section('SHELL', 'echo $SHELL'),
  section('CORES', 'sysctl -n hw.ncpu'),
  section('CPU', 'sysctl -n machdep.cpu.brand_string'),
  section('LOAD', 'uptime'),
  section('UPTIME', 'sysctl -n kern.boottime'),
  // top -l 1 打印的是「开机以来」的快照，-n 0 表示不要进程明细，只要那行 CPU usage
  section('STAT', "top -l 1 -n 0 | grep 'CPU usage'"),
  section('MEM', 'sysctl -n hw.memsize', 'vm_stat'),
  section('SWAP', 'sysctl -n vm.swapusage'),
  section('DISK', 'df -kP /'),
  section('NET', 'netstat -ibn'),
  ...POSIX_COMMON_TAIL,
].join('; ');

/**
 * 鸿蒙设备（OpenHarmony 标准系统）：只依赖 echo / cat / uname / df / param。
 * msh 里命令替换与 grep、cut 不一定有，所以全部把原始文件 cat 出来在服务端解析；
 * 段之间用 `;` 连成一行，避免极简 shell 解析多行时出岔子。
 */
const HARMONY_SCRIPT_BODY = [
  section('HOST', 'hostname'),
  section('OS', 'cat /etc/os-release'),
  section('OHOS', 'param get const.product.software.version', 'param get const.product.model'),
  section('UNAME', 'uname -s'),
  section('FULL', 'uname -a'),
  section('KERNEL', 'uname -r'),
  section('ARCH', 'uname -m'),
  section('USER', 'whoami'),
  section('CORES', 'cat /proc/cpuinfo'),
  section('LOAD', 'cat /proc/loadavg'),
  section('UPTIME', 'cat /proc/uptime'),
  section('STAT', 'cat /proc/stat'),
  section('MEM', 'cat /proc/meminfo'),
  section('DISK', 'df -kP /'),
  section('NET', 'cat /proc/net/dev'),
].join('; ');

/** BSD / Solaris 这类没专门适配的系统：能拿多少算多少，拿不到的段留空 */
const UNIX_SCRIPT_BODY = [
  section('HOST', 'hostname'),
  section('OS', 'cat /etc/os-release', 'cat /etc/issue.net', 'uname -s'),
  section('UNAME', 'uname -s'),
  section('FULL', 'uname -a'),
  section('KERNEL', 'uname -r'),
  section('ARCH', 'uname -m'),
  section('USER', 'whoami'),
  section('CORES', 'getconf _NPROCESSORS_ONLN'),
  section('LOAD', 'uptime'),
  section('UPTIME', 'uptime'),
  section('MEM', 'sysctl -n hw.memsize', 'sysctl -n hw.physmem'),
  section('DISK', 'df -kP /'),
  section('NET', 'netstat -ibn'),
  ...POSIX_COMMON_TAIL,
].join('; ');

/**
 * 每个家族一条脚本，服务器状态面板与 AI 环境信息共用。
 * 采集一次约 1KB 输出，两类消费方各取需要的段，省掉「同一台机器问两遍」。
 */
export const FAMILY_SCRIPTS: Record<OsFamily, string> = {
  linux: LINUX_SCRIPT_BODY,
  macos: MACOS_SCRIPT_BODY,
  harmony: HARMONY_SCRIPT_BODY,
  unix: UNIX_SCRIPT_BODY,
  windows: WINDOWS_ENV_SCRIPT,
  unknown: LINUX_SCRIPT_BODY,
};

/** 脚本里没有 `$(...)`，鸿蒙/极简 shell 用；Windows 走 PowerShell */
export function scriptFor(family: OsFamily): string {
  return FAMILY_SCRIPTS[family] || FAMILY_SCRIPTS.unknown;
}

/** Windows 上用 pwsh 装的机器（少数），powershell.exe 拿不到东西时的第二次尝试 */
export function scriptForWindowsWith(pwsh: boolean): string {
  if (!pwsh) return FAMILY_SCRIPTS.windows;
  return FAMILY_SCRIPTS.windows.replace('powershell -NoProfile', 'pwsh -NoProfile');
}

// ========== 供 AI 环境信息使用的文本渲染 ==========

/** `NAME="Ubuntu"` / `PRETTY_NAME="Ubuntu 24.04 LTS"` ⇒ 取可读名字 */
function prettyNameFromOsRelease(raw: string): string {
  const pretty = /PRETTY_NAME="?([^"\n]+)"?/i.exec(raw || '');
  if (pretty) return pretty[1].trim();
  const name = /^NAME="?([^"\n]+)"?/im.exec(raw || '');
  const version = /^VERSION_ID="?([^"\n]+)"?/im.exec(raw || '');
  if (name) return `${name[1].trim()}${version ? ' ' + version[1].trim() : ''}`;
  // /etc/issue.net 里常见 `%s %n` 这类占位，能识别出来的只有前几个发行版的写法
  const issue = (raw || '').split(/\r?\n/).find((l) => l.trim() && !/%[a-zA-Z]/.test(l));
  return issue ? issue.trim() : '';
}

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Windows 的段常见 `{"Caption":"..."}`，多台 CPU 时是 `[{...},{...}]`，非 JSON 返回 null */
export function parseMaybeJson(raw: string): any {
  const text = (raw || '').trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** JSON 段统一成数组，方便「取第一台」与「按台数累加」两种用法 */
export function jsonItems(raw: string): any[] {
  const value = parseMaybeJson(raw);
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstArrayItem(value: any): any {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

/**
 * 渲染成给 AI 的环境说明。
 * 只列拿到的项：拿不到就说没有，比硬编一个「Linux」在鸿蒙/Windows 机器上骗人强。
 */
export function renderEnvInfo(family: OsFamily, sections: Record<string, string>): string {
  const info: Record<string, string> = {};
  const put = (label: string, value?: string | number) => {
    const text = String(value ?? '').trim();
    // `$SHELL` 这类没展开的占位、纯空值都当没拿到
    if (!text || /^\$[A-Z_]+$/.test(text) || /not recognized|command not found|is not recognized/i.test(text)) return;
    info[label] = text;
  };

  const json = family === 'windows' ? parseMaybeJson(sections.OS || '') : null;
  const winOs = firstArrayItem(json);

  if (family === 'windows') {
    const osText = winOs
      ? [winOs.Caption, winOs.BuildNumber ? `build ${winOs.BuildNumber}` : winOs.Version].filter(Boolean).join(' ')
      : (sections.OS || '').split('\n')[0];
    put('OS', osText || 'Windows');
    const cpus = jsonItems(sections.CPU || '');
    if (cpus.length) {
      const threads = cpus.reduce((sum, item) => sum + Number(item.NumberOfLogicalProcessors || 0), 0);
      put('CPU', `${cpus[0].Name || 'unknown'} (${threads} threads)`);
    }
    if (winOs?.TotalVisibleMemorySize) {
      put('Memory', humanBytes(Number(winOs.TotalVisibleMemorySize) * 1024));
    }
  } else {
    const osRelease = sections.OSREL || sections.OS || '';
    const pretty = family === 'macos'
      ? (sections.OS || '').split('\n').filter(Boolean).join(' ')
      : prettyNameFromOsRelease(osRelease);
    const harmonyVersion = (sections.OHOS || '').split('\n').find((l) => l.trim() && !/^\s*$/.test(l));
    put('OS', pretty || (family === 'harmony' ? 'HarmonyOS' : sections.FULL?.split('\n')[0]) || OS_FAMILY_LABEL[family]);
    if (family === 'harmony') put('OS version', harmonyVersion || '');
    put('Kernel', sections.KERNEL || '');
    put('Arch', sections.ARCH || '');
    // 鸿蒙没有 nproc，CPU 段是整段 cpuinfo；型号与核数都要从里面自己取
    const cpuText = sections.CPU || sections.CORES || '';
    const model = /^model name\s*:\s*(.+)$/im.exec(cpuText);
    const hardware = /^(Hardware|Model name|Model)\s*:\s*(.+)$/im.exec(cpuText);
    put('CPU', (model?.[1] || hardware?.[1] || '').trim());
    const coresRaw = (sections.CORES || '').trim();
    const coresCount = /^\d+$/.test(coresRaw)
      ? coresRaw
      : String((coresRaw.match(/^processor\s*:/img) || []).length || '');
    put('CPU cores', coresCount);
    const memTotal = /MemTotal:\s+(\d+)/.exec(sections.MEM || '');
    if (memTotal) put('Memory', humanBytes(Number(memTotal[1]) * 1024));
    else {
      // macOS / BSD 没有 meminfo，hw.memsize 直接是字节，且是段里的第一行
      const first = ((sections.MEM || '').split(/\r?\n/).find((l) => l.trim()) || '').trim();
      if (/^\d+$/.test(first)) put('Memory', humanBytes(Number(first)));
    }
  }

  put('Hostname', sections.HOST || '');
  put('User', sections.USER || '');
  put('Shell', sections.SHELL || (family === 'windows' ? 'PowerShell' : ''));
  put('Package Manager', sections.PM || '');
  put('Node.js', sections.NODE || '');
  put('Python', sections.PYTHON || '');
  put('Docker', sections.DOCKER || '');

  if (Object.keys(info).length === 0) return '';
  const lines = [`System environment info (${OS_FAMILY_LABEL[family]}):`];
  for (const [key, val] of Object.entries(info)) lines.push(`- ${key}: ${val}`);
  return lines.join('\n');
}
