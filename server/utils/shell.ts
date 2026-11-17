import * as crypto from 'crypto';

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/**
 * 命令风险档位。
 *
 * - `safe`    —— 常规命令，直接跑；
 * - `confirm` —— 会造成事实损失、但属于运维日常（`rm -rf /var/log/nginx`）：不直接拦，
 *                交给人类在界面上点一下确认，AI 自己点不了；
 * - `blocked` —— 不可逆的毁灭性操作（`rm -rf /`、`mkfs`、`dd of=/dev/sda`）：没有确认入口。
 *
 * 三档而不是两档的原因：二元判断把「删一个日志目录」和「格式化磁盘」同等对待，
 * 结果是为了不误伤而整体放宽，闸门等于没有。
 */
export type CommandRiskLevel = 'safe' | 'confirm' | 'blocked';

export interface CommandRisk {
  /**
   * 是否「不需要硬拦」。**注意它不是「可以直接执行」**：
   * `confirm` 档同样是 true，因为批量面板等处是人在界面上点执行，人工点击本身就是确认。
   * 机器自动跑（AI 工具）必须以 `level` 判断，只看 `safe` 会把确认档当放行。
   */
  safe: boolean;
  level: CommandRiskLevel;
  /** 命中的规则代号：前端按它显示本地化说明，不去解析 reason 里的英文 */
  code?: string;
  reason?: string;
}

interface RiskRule {
  code: string;
  pattern: RegExp;
}

/**
 * 硬拦：造成的数据不可恢复，且几乎不可能是正常运维意图。
 * 这些不给确认入口 —— 需要人工执行请打开终端自己敲。
 */
const BLOCKED_RULES: RiskRule[] = [
  { code: 'rm-root', pattern: /(?:^|[;&|(]\s*)rm\s+[^\n]*\s(?:\/|\/\*|--no-preserve-root)(?:\s|$)/i },
  { code: 'mkfs', pattern: /(?:^|[;&|(]\s*)mkfs(?:\.|\s)/i },
  { code: 'dd-device', pattern: /(?:^|[;&|(]\s*)dd\s+[^\n]*(?:of=\/dev\/|if=\/dev\/zero)/i },
  // shred 普通文件落 confirm（下面有规则），只有抹设备才硬拦
  { code: 'shred-device', pattern: /(?:^|[;&|(]\s*)shred\s+[^\n]*\/dev\//i },
  // 只拦「整盘」：/var/www 上是运维常见（且可恢复）的权限事故，落 confirm 就够
  { code: 'chmod-root', pattern: /(?:^|[;&|(]\s*)chmod\s+-R\s+777\s+\/\*?(?:\s|$)/i },
  { code: 'chown-root', pattern: /(?:^|[;&|(]\s*)chown\s+-R\s+[^\n]+\s+\/\*?(?:\s|$)/i },
  { code: 'format-drive', pattern: /(?:^|[;&|(]\s*)format\s+[a-z]:/i },
  { code: 'clear-disk', pattern: /(?:^|[;&|(]\s*)Clear-Disk\b/i },
  { code: 'remove-drive', pattern: /(?:^|[;&|(]\s*)Remove-Item\s+[^\n]*(?:-Recurse\s+[^\n]*)?[a-z]:\\\s*$/i },
  { code: 'fork-bomb', pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/ },
  { code: 'pipe-to-shell', pattern: /(?:curl|wget)\s+[^\n|;]+\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python|node)/i },
  // 不带锚点：> /dev/sda 前面总是还有 echo / cat 这类命令
  { code: 'write-device', pattern: />\s*\/dev\/(?:sd|hd|nvme|vd|xvd)/i },
];

/**
 * 需要人类确认：会丢数据、断服务、改系统配置，但在运维里是正常动作。
 *
 * 只做「命令文本层面」的识别，不做语义分析 —— 一条 `bash -c "$(cat file)"`
 * 就能绕过，所以它是闸门，不是沙箱。
 */
const CONFIRM_RULES: RiskRule[] = [
  { code: 'rm-recursive', pattern: /(?:^|[;&|(]\s*)rm\s+-[a-z]*r[a-z]*\s/i },
  { code: 'find-delete', pattern: /(?:^|[;&|(]\s*)find\s+[^\n]*-delete/i },
  { code: 'truncate', pattern: /(?:^|[;&|(]\s*)truncate\s+-s\s*0\b/i },
  { code: 'shred', pattern: /(?:^|[;&|(]\s*)shred\s+/i },
  { code: 'dd-write', pattern: /(?:^|[;&|(]\s*)dd\s+[^\n]*of=/i },
  { code: 'service-stop', pattern: /(?:^|[;&|(]\s*)(?:systemctl|service)\s+(?:stop|disable|mask|kill)\s/i },
  { code: 'kill-wide', pattern: /(?:^|[;&|(]\s*)(?:killall|pkill)\s|(?:^|[;&|(]\s*)kill\s+-9\s+-1\b/i },
  { code: 'firewall-flush', pattern: /(?:^|[;&|(]\s*)(?:iptables\s+-F|iptables\s+-X|ufw\s+disable|firewall-cmd\s+--panic)/i },
  { code: 'etc-write', pattern: /(?:>|>>)\s*\/etc\/|(?:^|[;&|(]\s*)sed\s+-i[^\n]*\s\/etc\/|(?:^|[;&|(]\s*)(?:cp|mv)\s+[^\n]*\s\/etc\//i },
  { code: 'perm-recursive', pattern: /(?:^|[;&|(]\s*)(?:chmod|chown)\s+-R/i },
  { code: 'pkg-remove', pattern: /(?:^|[;&|(]\s*)(?:apt|apt-get|yum|dnf|zypper|apk)\s+(?:remove|purge|erase|autoremove)|(?:^|[;&|(]\s*)pacman\s+-R/i },
  { code: 'power', pattern: /(?:^|[;&|(]\s*)(?:reboot|shutdown|poweroff|halt)\b|(?:^|[;&|(]\s*)init\s+[06]\b/i },
  { code: 'user-cron', pattern: /(?:^|[;&|(]\s*)(?:userdel|visudo)\s|(?:^|[;&|(]\s*)passwd\s|(?:^|[;&|(]\s*)crontab\s+-r/i },
  { code: 'docker-prune', pattern: /(?:^|[;&|(]\s*)docker\s+system\s+prune|(?:^|[;&|(]\s*)docker\s+(?:rm|rmi)\s+-f/i },
  { code: 'git-rewind', pattern: /(?:^|[;&|(]\s*)git\s+(?:reset\s+--hard|clean\s+-[a-z]*f)/i },
];

export function assessDangerousCommand(command: string): CommandRisk {
  const trimmed = String(command || '').trim();
  if (!trimmed) return { safe: false, level: 'blocked', code: 'empty', reason: 'Empty command' };

  // 行接续折平，再把 sudo 剥掉：否则每条规则都要写一份 sudo 变体，早晚漏一条
  const normalized = trimmed
    .replace(/\\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(^|[;&|(]\s*)sudo\s+/gi, '$1');

  for (const rule of BLOCKED_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        safe: false,
        level: 'blocked',
        code: rule.code,
        reason: 'BLOCKED: high-risk destructive command requires manual execution',
      };
    }
  }

  for (const rule of CONFIRM_RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        safe: true,
        level: 'confirm',
        code: rule.code,
        reason: 'CONFIRM: this command needs a human confirmation before it runs',
      };
    }
  }

  return { safe: true, level: 'safe' };
}

export function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}
