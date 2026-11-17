/**
 * 0009 —— 错误指纹聚合（P4）。
 *
 * 为什么需要这张表：
 * audit_events 是**流水**：一次工具调用一行，30 天后按天清掉。它能回答「这台机器上
 * 某条命令的结果是什么」，答不了「这个报错是不是老毛病、一共几次、上次是什么时候」。
 * 把报错归一化成一个指纹、按指纹聚合，才有「同一个错误」这个概念。
 *
 * 为什么主键带 connection_id（不是 session）：
 * 告警与指标的归属维度统一在「连接」上 —— 跳板机上那个 session 断了，不代表问题
 * 结束了。代价是同一个错误在 3 台机器上是 3 行，这是有意的：P5 要按主机去重与投递。
 *
 * 为什么只存一行原文（sample_text）而不存整个输出：
 * 这张表的用途是「计数 + 认脸」，不是回放。要看完整输出请按 last_seen 去
 * audit_events 里查同一时刻那一行 —— 两份数据用时间对得上，不必重复存储。
 *
 * 幂等：整表新建，IF NOT EXISTS 本身原子，不需要 information_schema 探测。
 */

export const ERROR_FINGERPRINTS_SQL = `
-- ------------------------------------------------------------
-- 错误指纹聚合。主键 = 账号 + 连接 + 指纹，所以「同一台机器上的同一个错误」只有一行。
-- fingerprint = sha256(归一化代表行)[:16]，归一化与哈希只允许有 server/utils/fingerprint.ts
-- 这一份实现（P5 告警去重、P6 历史召回都复用它），否则同一个错误会算出两套 key。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS error_fingerprints (
  owner_id         VARCHAR(64)   NOT NULL COMMENT '归属账号',
  connection_id    VARCHAR(64)   NOT NULL COMMENT '连接配置 ID；服务端本机固定 __local__',
  fingerprint      CHAR(16)      NOT NULL COMMENT 'sha256(归一化代表行) 前 16 位',
  sample_text      VARCHAR(512)  NOT NULL DEFAULT '' COMMENT '代表行原文（去 ANSI），给人看',
  tool             VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '触发工具；目前只有 execute_command',
  command          VARCHAR(512)  NOT NULL DEFAULT '' COMMENT '最近一次触发它的命令',
  occurrences      INT UNSIGNED  NOT NULL DEFAULT 1 COMMENT '累计出现次数',
  first_seen       DATETIME(3)   NOT NULL COMMENT '首次出现（写后不再变）',
  last_seen        DATETIME(3)   NOT NULL COMMENT '最近一次出现；保留期按它清理',
  last_resolved_at DATETIME(3)   NULL COMMENT '人工标记「已修复」的时间；P6 用，本阶段只建列',
  PRIMARY KEY (owner_id, connection_id, fingerprint),
  -- 保留期清理按 last_seen 扫；主键前缀是 owner/connection，时间范围扫不动
  KEY idx_error_fp_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='错误指纹聚合（同一主机同一错误一行）';
`;
