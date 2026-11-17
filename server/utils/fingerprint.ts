/**
 * 错误指纹（P4）。**纯函数，不碰数据库、不依赖服务实例。**
 *
 * 为什么必须独立成模块：
 * P4 把「同一个错误出现过几次」落进 error_fingerprints，P5 要拿同一个指纹给告警
 * 去重，P6 要按指纹召回「上次是怎么修好的」。三处一旦各算各的，同一个错误会得到
 * 两套 key，聚合与去重全部失效。所以归一化 + 哈希只允许有这一份实现，谁需要指纹
 * 都从这里 import。
 *
 * 归一化的取舍：
 * - 折叠的是**噪声**（时间戳、UUID、hex、PID、行号、路径里的数字），不是内容 ——
 *   主机 IP、端口数字中的差异有的保留有的折叠，见下面逐条注释；
 * - 只取**一行**代表行（命中失败特征的第一行），不拿整段输出：同一条错误后面跟着
 *   不同的 tail 输出时，整段哈希会散成无数个指纹；
 * - 长度截到 200 字符再哈希：日志行尾的滚动内容（计数器、耗时）不该参与分组。
 */
import * as crypto from 'crypto';
import { stripAnsiEscapes } from './ansi';

/** 指纹取 sha256 的前 16 位十六进制（64 bit），够单表规模用，也比全长好读 */
export const FINGERPRINT_HEX_LENGTH = 16;

/** 参与哈希的最大长度：行尾的计数器 / 耗时不参与分组 */
const MAX_NORMALIZED_CHARS = 200;

/** 单行处理上限：防御异常长行把正则拖慢（终端里粘一坨日志很正常） */
const MAX_LINE_CHARS = 2000;

/** sample_text 列宽，与迁移 0009 保持一致 */
export const MAX_SAMPLE_TEXT = 512;

/**
 * 我们的**控制流文案**，不是主机故障。
 *
 * execute_command 在真正执行前会返回这些前缀（需要确认 / 被高危规则挡掉 / 无权限 /
 * 无会话）。它们由策略决定、文案固定，记成指纹只会把「同一个错误」污染成策略计数，
 * 而且 P5 拿它报警等于把「模型被拦了」当成主机出事。
 */
const CONTROL_MESSAGE_RE =
  /^(?:NEEDS_CONFIRM|BLOCKED|PERMISSION_DENIED|NO_LIVE_SESSION|AUDIT_UNAVAILABLE|SKILLS?_UNAVAILABLE|SKILL_NOT_FOUND|Invalid (?:arguments|path|skill|status)|Missing|Unknown tool)/i;

/**
 * 失败特征。**宁漏不滥**：P5 要拿它去重告警，误判会把告警数量直接放大。
 *
 * 刻意不收的：光秃秃的 `ERROR` 单词（`grep ERROR app.log` 的正常输出）、
 * `warning`、`not found`（少了冒号与「command」就太宽）。
 */
const FAILURE_SIGNAL_RES: RegExp[] = [
  // 我们自己的执行异常（executeCommand 的 catch 分支）
  /^Command execution failed:/i,
  // shell / 文件系统
  /: command not found\b/i,
  /\bNo such file or directory\b/i,
  /\bPermission denied\b/i,
  /\bOperation not permitted\b/i,
  /\bRead-only file system\b/i,
  /\bNo space left on device\b/i,
  /\bToo many open files\b/i,
  /\bSegmentation fault\b/i,
  /\b(?:cannot|could not) (?:open|access|execute|find|connect|create|remove|stat)\b/i,
  // 通用错误行（编译器 / 解释器 / 语言运行时）
  /^\s*error(?:\[|:|\s)/im,
  /^\s*Error: /m,
  // nginx / apache 风格：`nginx: [emerg] unknown directive ...`，[error] 带方括号才算
  /\[(?:emerg|alert|crit|error|fatal)\]/i,
  /\btest failed\b/i,
  /\bTraceback \(most recent call last\)/,
  /\bat .*\(.*:\d+:\d+\)/,
  /\bfatal:/i,
  // 运维生态
  /\bnpm ERR!/,
  /\bdocker: Error response from daemon\b/i,
  /\bJob for .* failed\b/i,
  /\bFailed with result\b/i,
  /\b(?:Failed|Unable) to (?:start|restart|stop|load|connect|resolve|mount)\b/i,
  /\bnot a git repository\b/i,
  /^make(?:\[\d+\])?: \*\*\*/m,
  // 网络
  /\bConnection (?:refused|timed out|reset by peer)\b/i,
  /\bName or service not known\b/i,
  /\bTemporary failure in name resolution\b/i,
  /\bNetwork is unreachable\b/i,
];

const TIMESTAMP_RES: RegExp[] = [
  // 2026-11-17 03:12:44.123 / 2026-11-17T03:12:44.123Z / +08:00
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
  // syslog: Nov 17 03:12:44
  /\b[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2}\b/g,
  // 裸时间 03:12:44(.123)
  /\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g,
  // 2026/11/17
  /\b\d{4}\/\d{1,2}\/\d{1,2}\b/g,
];

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const HEX_LITERAL_RE = /0x[0-9a-f]+/gi;
const PID_RE = /\bpid[=:\s]*\d+\b/gi;
const BRACKET_NUMBER_RE = /\[\d+\]/g;
/** 路径令牌：以 / 或 \ 开头（可带盘符），数字段折成 <n>。IP 与端口不带斜杠，不受影响 */
const PATH_TOKEN_RE = /(?:[A-Za-z]:)?[\\/][^\s"'`();:|]*\d[^\s"'`();:|]*/g;
/** 行号 / 列号 / 端口：foo.ts:12:5、0.0.0.0:5432 */
const LINE_NUMBER_RE = /:\d+(?::\d+)?\b/g;
const LINE_WORD_RE = /\b(?:line|row) \d+\b/gi;

export interface FailureFingerprint {
  /** sha256(归一化代表行) 的前 16 位 */
  fingerprint: string;
  /** 代表行原文（去 ANSI、截到列宽），给人看的那一行 */
  sampleText: string;
}

/** 这段输出算不算「命令失败」，交给指纹层判定（见文件头注释） */
export function isCommandFailure(output: string, isError = false): boolean {
  const text = (output || '').trim();
  // 空输出没有可归一的材料；引擎会把空结果也标成 error，但那多半是命令本来就静默
  if (!text) return false;
  if (CONTROL_MESSAGE_RE.test(text)) return false;
  if (isError) return true;
  return FAILURE_SIGNAL_RES.some((re) => re.test(text));
}

/**
 * 代表行：命中失败特征的第一行；都没有就退回第一条非空行。
 * 栈信息取「错误行」而不是最后一行 —— 最后一行通常是 `at ...` 的调用帧。
 */
export function pickFailureLine(output: string): string {
  const lines = stripAnsiEscapes(output || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (FAILURE_SIGNAL_RES.some((re) => re.test(line))) return line;
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (line) return line;
  }
  return '';
}

/** 归一化：抹掉每次都会变的噪声，只留「是哪一个错误」这部分内容 */
export function normalizeFailureLine(line: string): string {
  let text = stripAnsiEscapes(line || '').slice(0, MAX_LINE_CHARS);
  for (const re of TIMESTAMP_RES) text = text.replace(re, '<ts>');
  text = text.replace(UUID_RE, '<uuid>');
  text = text.replace(LONG_HEX_RE, '<hex>');
  text = text.replace(HEX_LITERAL_RE, '<hex>');
  text = text.replace(PID_RE, 'pid=<n>');
  text = text.replace(BRACKET_NUMBER_RE, '[<n>]');
  text = text.replace(PATH_TOKEN_RE, (token) => token.replace(/\d+/g, '<n>'));
  text = text.replace(LINE_WORD_RE, (m) => m.replace(/\d+/, '<n>'));
  text = text.replace(LINE_NUMBER_RE, ':<n>');
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_NORMALIZED_CHARS);
}

/** 指纹 = sha256(归一化文本) 前 16 位 */
export function fingerprintOf(text: string): string {
  return crypto.createHash('sha256').update(normalizeFailureLine(text), 'utf8').digest('hex').slice(0, FINGERPRINT_HEX_LENGTH);
}

/** 截到列宽，超长明确带上省略号（人一眼能看出被截过） */
function clampSample(text: string): string {
  return text.length > MAX_SAMPLE_TEXT ? `${text.slice(0, MAX_SAMPLE_TEXT - 3)}...` : text;
}

/**
 * 单行 → 指纹。**不再做「算不算失败」的判定**：调用方已经判过了
 * （日志监控的正则命中 / 命令失败的两层判定），这里只负责归一化 + 哈希。
 */
export function fingerprintLine(line: string): FailureFingerprint | null {
  const sample = stripAnsiEscapes(line || '').trim();
  if (!sample) return null;
  const normalized = normalizeFailureLine(sample);
  if (!normalized) return null;
  return {
    fingerprint: crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, FINGERPRINT_HEX_LENGTH),
    sampleText: clampSample(sample),
  };
}

/**
 * 从一次工具输出里取出指纹；不是失败、没有材料、或只是控制流文案时返回 null。
 * 这是 P4 写入路径与 P5 去重共用的唯一入口。
 */
export function extractFingerprint(output: string, isError = false): FailureFingerprint | null {
  if (!isCommandFailure(output, isError)) return null;
  const sample = pickFailureLine(output);
  if (!sample) return null;
  return fingerprintLine(sample);
}
