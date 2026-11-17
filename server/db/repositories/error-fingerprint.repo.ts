/**
 * 错误指纹仓储（error_fingerprints）。
 *
 * 只做三件事：写一次出现、按指纹读一行、按保留期清理。**P4 阶段只写不读**，
 * 读接口先给验证脚本与 P5 的告警去重用，不挂任何 HTTP 路由。
 *
 * upsert 的语义（这是整张表的核心）：
 * - 命中主键（owner + connection + fingerprint）就 `occurrences + 1`、`last_seen` 前移；
 * - `first_seen` 永远不动 —— 「第一次是什么时候」是这张表最有价值的字段；
 * - `last_resolved_at` 也不动：它属于 P6 的人工处置，重复出现不代表「没修好」被撤销。
 */
import { execute, query } from '../pool';

export interface ErrorFingerprintInput {
  ownerId: string;
  connectionId: string;
  fingerprint: string;
  sampleText: string;
  tool: string;
  command: string;
  /** 出现时间，默认 now；验证脚本用它构造「30 天前」 */
  seenAt?: Date;
}

export interface ErrorFingerprintRow {
  ownerId: string;
  connectionId: string;
  fingerprint: string;
  sampleText: string;
  tool: string;
  command: string;
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
  lastResolvedAt: Date | null;
}

/** 写一次出现：首次插入，之后只累加 */
export async function upsertErrorFingerprint(input: ErrorFingerprintInput): Promise<void> {
  const seenAt = input.seenAt ?? new Date();
  await execute(
    `INSERT INTO error_fingerprints (
       owner_id, connection_id, fingerprint, sample_text, tool, command,
       occurrences, first_seen, last_seen, last_resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
       occurrences = occurrences + 1,
       last_seen   = VALUES(last_seen),
       -- 原文与命令取最新一次：看的时候对得上「最近这次是怎么报的」
       sample_text = VALUES(sample_text),
       command     = VALUES(command),
       tool        = VALUES(tool)`,
    [
      input.ownerId,
      input.connectionId,
      input.fingerprint,
      input.sampleText,
      input.tool,
      input.command,
      seenAt,
      seenAt,
    ],
  );
}

/** 按主键读一行（验证脚本与 P5 去重用） */
export async function getErrorFingerprint(
  ownerId: string,
  connectionId: string,
  fingerprint: string,
): Promise<ErrorFingerprintRow | undefined> {
  const rows = await query<any>(
    `SELECT owner_id, connection_id, fingerprint, sample_text, tool, command,
            occurrences, first_seen, last_seen, last_resolved_at
       FROM error_fingerprints
      WHERE owner_id = ? AND connection_id = ? AND fingerprint = ?
      LIMIT 1`,
    [ownerId, connectionId, fingerprint],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    ownerId: String(r.owner_id),
    connectionId: String(r.connection_id),
    fingerprint: String(r.fingerprint),
    sampleText: String(r.sample_text || ''),
    tool: String(r.tool || ''),
    command: String(r.command || ''),
    occurrences: Number(r.occurrences) || 0,
    firstSeen: r.first_seen instanceof Date ? r.first_seen : new Date(r.first_seen),
    lastSeen: r.last_seen instanceof Date ? r.last_seen : new Date(r.last_seen),
    lastResolvedAt: r.last_resolved_at
      ? (r.last_resolved_at instanceof Date ? r.last_resolved_at : new Date(r.last_resolved_at))
      : null,
  };
}

/**
 * 清理保留期外的行（按 last_seen，不是 first_seen）：
 * 只要还在复发就留着，「老毛病」的意义就在于它一直没消停。
 */
export async function pruneErrorFingerprints(before: Date): Promise<number> {
  const { affectedRows } = await execute('DELETE FROM error_fingerprints WHERE last_seen < ?', [before]);
  return affectedRows;
}
