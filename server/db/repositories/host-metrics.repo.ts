/**
 * 主机指标仓储（host_metrics_minute）。
 *
 * 只有两个动作值得记住：
 *  1) 写入是**增量聚合**：同一分钟内重复写不会产生新行，而是把新采样并进
 *     已有的 avg / max。所以 INSERT ... ON DUPLICATE KEY UPDATE 的赋值顺序
 *     必须保证「所有 avg 都在 samples = samples + 1 之前算完」，
 *     否则均值会按错误的样本数计权（顺序见下面 SQL 的注释）。
 *  2) 读出来的 DECIMAL / BIGINT 在 mysql2 里是字符串，聚合前必须显式转 number，
 *     否则 `+` 会变成字符串拼接，报表会出现 "12.5018.30" 这种结果。
 */
import { execute, query } from '../pool';

/** 一条分钟聚合样本（来自面板/定时采集的瞬时快照，单位已归一） */
export interface MinuteMetricInput {
  ownerId: string;
  connectionId: string;
  hostname: string;
  /** 分钟桶起点 */
  bucket: Date;
  /** CPU 使用率 %，采集不到传 null */
  cpuPct: number | null;
  memPct: number | null;
  diskPct: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  /** 三档负载；Windows 没有这个概念，传 null */
  load1: number | null;
  load5: number | null;
  load15: number | null;
}

/** 从库里读回的一行 */
export interface MinuteMetricRow {
  connectionId: string;
  hostname: string;
  bucket: Date;
  samples: number;
  cpuPctAvg: number | null;
  cpuPctMax: number | null;
  memPctAvg: number | null;
  memPctMax: number | null;
  diskPctAvg: number | null;
  diskPctMax: number | null;
  diskTotalBytes: number | null;
  diskUsedBytesAvg: number | null;
  diskUsedBytesMax: number | null;
  load1Avg: number | null;
  load1Max: number | null;
  load5Avg: number | null;
  load5Max: number | null;
  load15Avg: number | null;
  load15Max: number | null;
}

/** 有指标留存的连接（用于「这台账号下有哪些主机有数据」） */
export interface MetricHostRow {
  connectionId: string;
  hostname: string;
  lastBucket: Date;
  samples: number;
}

const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * 写入一条采样并合进当分钟。
 *
 * `samples = 1` 是初值：首次写入即一条采样；冲突时走 ON DUPLICATE 分支做增量合并。
 */
export async function upsertMinuteMetric(input: MinuteMetricInput): Promise<void> {
  await execute(
    `INSERT INTO host_metrics_minute (
       owner_id, connection_id, hostname, bucket, samples,
       cpu_pct_avg, cpu_pct_max,
       mem_pct_avg, mem_pct_max,
       disk_pct_avg, disk_pct_max,
       disk_total_bytes, disk_used_bytes_avg, disk_used_bytes_max,
       load1_avg, load1_max, load5_avg, load5_max, load15_avg, load15_max,
       updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       hostname = VALUES(hostname),
       -- 顺序敏感：每个 avg 都用「自增前的 samples」计权，因此必须写在 samples = samples + 1 之前。
       -- MySQL 在 ON DUPLICATE KEY UPDATE 里按书写顺序逐个赋值，顺序反了均值就会被算成重复计数。
       -- 三分支缺一不可：本次无值→保留；历史无值→直接落新值（当成 0 参与平均会把首值稀释，
       -- 例如前 3 次没采到 load、第 4 次采到 1，两分支写法会得到 0.25 而不是 1）；否则正常滑动平均。
       cpu_pct_avg = CASE
         WHEN VALUES(cpu_pct_avg) IS NULL THEN cpu_pct_avg
         WHEN cpu_pct_avg IS NULL THEN VALUES(cpu_pct_avg)
         ELSE ROUND((cpu_pct_avg * samples + VALUES(cpu_pct_avg)) / (samples + 1), 2) END,
       cpu_pct_max = CASE WHEN VALUES(cpu_pct_max) IS NULL THEN cpu_pct_max
         ELSE GREATEST(COALESCE(cpu_pct_max, VALUES(cpu_pct_max)), VALUES(cpu_pct_max)) END,
       mem_pct_avg = CASE
         WHEN VALUES(mem_pct_avg) IS NULL THEN mem_pct_avg
         WHEN mem_pct_avg IS NULL THEN VALUES(mem_pct_avg)
         ELSE ROUND((mem_pct_avg * samples + VALUES(mem_pct_avg)) / (samples + 1), 2) END,
       mem_pct_max = CASE WHEN VALUES(mem_pct_max) IS NULL THEN mem_pct_max
         ELSE GREATEST(COALESCE(mem_pct_max, VALUES(mem_pct_max)), VALUES(mem_pct_max)) END,
       disk_pct_avg = CASE
         WHEN VALUES(disk_pct_avg) IS NULL THEN disk_pct_avg
         WHEN disk_pct_avg IS NULL THEN VALUES(disk_pct_avg)
         ELSE ROUND((disk_pct_avg * samples + VALUES(disk_pct_avg)) / (samples + 1), 2) END,
       disk_pct_max = CASE WHEN VALUES(disk_pct_max) IS NULL THEN disk_pct_max
         ELSE GREATEST(COALESCE(disk_pct_max, VALUES(disk_pct_max)), VALUES(disk_pct_max)) END,
       -- 容量不是可聚合量：取最新值（换了盘/扩了容要能立刻反映出来）
       disk_total_bytes = COALESCE(VALUES(disk_total_bytes), disk_total_bytes),
       disk_used_bytes_avg = CASE
         WHEN VALUES(disk_used_bytes_avg) IS NULL THEN disk_used_bytes_avg
         WHEN disk_used_bytes_avg IS NULL THEN VALUES(disk_used_bytes_avg)
         ELSE ROUND((disk_used_bytes_avg * samples + VALUES(disk_used_bytes_avg)) / (samples + 1)) END,
       disk_used_bytes_max = CASE WHEN VALUES(disk_used_bytes_max) IS NULL THEN disk_used_bytes_max
         ELSE GREATEST(COALESCE(disk_used_bytes_max, VALUES(disk_used_bytes_max)), VALUES(disk_used_bytes_max)) END,
       load1_avg = CASE
         WHEN VALUES(load1_avg) IS NULL THEN load1_avg
         WHEN load1_avg IS NULL THEN VALUES(load1_avg)
         ELSE ROUND((load1_avg * samples + VALUES(load1_avg)) / (samples + 1), 3) END,
       load1_max = CASE WHEN VALUES(load1_max) IS NULL THEN load1_max
         ELSE GREATEST(COALESCE(load1_max, VALUES(load1_max)), VALUES(load1_max)) END,
       load5_avg = CASE
         WHEN VALUES(load5_avg) IS NULL THEN load5_avg
         WHEN load5_avg IS NULL THEN VALUES(load5_avg)
         ELSE ROUND((load5_avg * samples + VALUES(load5_avg)) / (samples + 1), 3) END,
       load5_max = CASE WHEN VALUES(load5_max) IS NULL THEN load5_max
         ELSE GREATEST(COALESCE(load5_max, VALUES(load5_max)), VALUES(load5_max)) END,
       load15_avg = CASE
         WHEN VALUES(load15_avg) IS NULL THEN load15_avg
         WHEN load15_avg IS NULL THEN VALUES(load15_avg)
         ELSE ROUND((load15_avg * samples + VALUES(load15_avg)) / (samples + 1), 3) END,
       load15_max = CASE WHEN VALUES(load15_max) IS NULL THEN load15_max
         ELSE GREATEST(COALESCE(load15_max, VALUES(load15_max)), VALUES(load15_max)) END,
       samples = samples + 1,
       updated_at = VALUES(updated_at)`,
    [
      input.ownerId,
      input.connectionId,
      input.hostname || '',
      input.bucket,
      input.cpuPct,
      input.cpuPct,
      input.memPct,
      input.memPct,
      input.diskPct,
      input.diskPct,
      input.diskTotalBytes,
      input.diskUsedBytes,
      input.diskUsedBytes,
      input.load1,
      input.load1,
      input.load5,
      input.load5,
      input.load15,
      input.load15,
      new Date(),
    ],
  );
}

/** 取某个连接在 [from, to) 区间内的分钟序列，按时间升序 */
export async function listMinuteMetrics(
  ownerId: string,
  connectionId: string,
  from: Date,
  to: Date,
  limit = 2000,
): Promise<MinuteMetricRow[]> {
  const rows = await query<any>(
    `SELECT connection_id, hostname, bucket, samples,
            cpu_pct_avg, cpu_pct_max, mem_pct_avg, mem_pct_max,
            disk_pct_avg, disk_pct_max, disk_total_bytes, disk_used_bytes_avg, disk_used_bytes_max,
            load1_avg, load1_max, load5_avg, load5_max, load15_avg, load15_max
     FROM host_metrics_minute
     WHERE owner_id = ? AND connection_id = ? AND bucket >= ? AND bucket < ?
     ORDER BY bucket ASC
     LIMIT ${Number(limit) > 0 ? Number(limit) : 2000}`,
    [ownerId, connectionId, from, to],
  );
  return rows.map((r) => ({
    connectionId: String(r.connection_id || ''),
    hostname: String(r.hostname || ''),
    bucket: r.bucket instanceof Date ? r.bucket : new Date(r.bucket),
    samples: Number(r.samples) || 0,
    cpuPctAvg: numOrNull(r.cpu_pct_avg),
    cpuPctMax: numOrNull(r.cpu_pct_max),
    memPctAvg: numOrNull(r.mem_pct_avg),
    memPctMax: numOrNull(r.mem_pct_max),
    diskPctAvg: numOrNull(r.disk_pct_avg),
    diskPctMax: numOrNull(r.disk_pct_max),
    diskTotalBytes: numOrNull(r.disk_total_bytes),
    diskUsedBytesAvg: numOrNull(r.disk_used_bytes_avg),
    diskUsedBytesMax: numOrNull(r.disk_used_bytes_max),
    load1Avg: numOrNull(r.load1_avg),
    load1Max: numOrNull(r.load1_max),
    load5Avg: numOrNull(r.load5_avg),
    load5Max: numOrNull(r.load5_max),
    load15Avg: numOrNull(r.load15_avg),
    load15Max: numOrNull(r.load15_max),
  }));
}

/**
 * 该账号下有留存数据的主机。
 *
 * 按 connection_id 分组而不是 hostname：同一个 connectionId 换了目标机、
 * 或者两台机器同名都很常见，分组键必须选「你配的那条连接」。
 */
export async function listMetricHosts(ownerId: string, since: Date): Promise<MetricHostRow[]> {
  const rows = await query<any>(
    `SELECT connection_id, MAX(hostname) AS hostname, MAX(bucket) AS last_bucket, SUM(samples) AS samples
     FROM host_metrics_minute
     WHERE owner_id = ? AND bucket >= ?
     GROUP BY connection_id
     ORDER BY last_bucket DESC`,
    [ownerId, since],
  );
  return rows.map((r) => ({
    connectionId: String(r.connection_id || ''),
    hostname: String(r.hostname || ''),
    lastBucket: r.last_bucket instanceof Date ? r.last_bucket : new Date(r.last_bucket),
    samples: Number(r.samples) || 0,
  }));
}

/** 保留期清理：删掉早于 cutoff 的分钟桶 */
export async function purgeMetricsBefore(cutoff: Date): Promise<number> {
  const result = await execute('DELETE FROM host_metrics_minute WHERE bucket < ?', [cutoff]);
  return result.affectedRows;
}
