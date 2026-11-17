/**
 * 0007 —— 主机指标留存（按分钟聚合）。
 *
 * 为什么需要这张表：
 * 面板上的 CPU / 内存 / 磁盘 / 负载是**瞬时**采集，关掉页面就什么都没留下。
 * 于是「昨晚 3 点为什么慢」「磁盘按这个速度什么时候会满」这类问题，
 * AI 结构上就答不了 —— 它只能看见当下。留一份按分钟聚合的历史，
 * 才有趋势与归因可谈，且写入量是「每台主机每分钟一行」，代价可以忽略。
 *
 * 为什么用「增量聚合」而不是每分钟存一条原始采样：
 *  - 采集可能因为进程重启、面板重复触发而在同一分钟内写多次；
 *    存原始行会让点数不可控，查询时还得现场求平均。
 *  - 只存 <分钟, 主机> 这一行，用 samples 记次数、avg 做滑动平均、max 取峰值，
 *    重复写入天然幂等，查询侧也只剩「按区间取行」这一种形状。
 *
 * 归属：owner_id + connection_id 做复合主键。指标不是公共数据，
 * 别人的机器不该出现在你的查询里；本地 Shell 的 connection_id 固定为 __local__。
 *
 * 幂等：整表新建，IF NOT EXISTS 本身原子，不需要 information_schema 探测。
 */

export const HOST_METRICS_SQL = `
-- ------------------------------------------------------------
-- 主机指标（按分钟聚合）。每行 = 某账号某连接在某分钟内的一组统计值。
-- bucket 是分钟桶起点（服务端本地时间），与面板展示口径一致。
-- avg 走增量滑动平均，max 取峰值；samples 记录该分钟实际写入了几次采样。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS host_metrics_minute (
  owner_id            VARCHAR(64)       NOT NULL COMMENT '归属账号',
  connection_id       VARCHAR(64)       NOT NULL COMMENT '连接配置 ID；服务端本机固定 __local__',
  hostname            VARCHAR(128)      NOT NULL DEFAULT '' COMMENT '采集到的主机名，供人读',
  bucket              DATETIME          NOT NULL COMMENT '分钟桶起点（服务端本地时间）',
  samples             SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '该分钟内写入的采样次数',
  cpu_pct_avg         DECIMAL(5,2)      NULL COMMENT 'CPU 使用率 %（均值）',
  cpu_pct_max         DECIMAL(5,2)      NULL COMMENT 'CPU 使用率 %（峰值）',
  mem_pct_avg         DECIMAL(5,2)      NULL COMMENT '内存使用率 %（均值）',
  mem_pct_max         DECIMAL(5,2)      NULL COMMENT '内存使用率 %（峰值）',
  disk_pct_avg        DECIMAL(5,2)      NULL COMMENT '磁盘使用率 %（均值）',
  disk_pct_max        DECIMAL(5,2)      NULL COMMENT '磁盘使用率 %（峰值）',
  disk_total_bytes    BIGINT UNSIGNED   NULL COMMENT '磁盘容量（最新值，容量变化本身就是要看的信号）',
  disk_used_bytes_avg BIGINT UNSIGNED   NULL COMMENT '磁盘已用字节（均值）',
  disk_used_bytes_max BIGINT UNSIGNED   NULL COMMENT '磁盘已用字节（峰值）',
  load1_avg           DECIMAL(8,3)      NULL COMMENT '1 分钟负载（均值）',
  load1_max           DECIMAL(8,3)      NULL COMMENT '1 分钟负载（峰值）',
  load5_avg           DECIMAL(8,3)      NULL COMMENT '5 分钟负载（均值）',
  load5_max           DECIMAL(8,3)      NULL COMMENT '5 分钟负载（峰值）',
  load15_avg          DECIMAL(8,3)      NULL COMMENT '15 分钟负载（均值）',
  load15_max          DECIMAL(8,3)      NULL COMMENT '15 分钟负载（峰值）',
  updated_at          DATETIME(3)       NOT NULL COMMENT '最后一次写入时间',
  PRIMARY KEY (owner_id, connection_id, bucket),
  -- 保留期清理与「按时间扫全表」都走这个索引；主键前缀是 owner/connection，时间范围扫不动
  KEY idx_host_metrics_bucket (bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='主机指标留存（按分钟聚合）';
`;
