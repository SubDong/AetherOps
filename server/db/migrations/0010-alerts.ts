/**
 * 0010 —— 告警实体（P5）。
 *
 * 为什么需要这张表：
 * 改造前告警只活在 MonitorService 的 `alertBuffer` 里 —— 200 条、进程重启即消失、
 * 关掉面板就再也看不到。日志刷 100 次同一个错误就生成 100 条，既不能「确认」，
 * 也没法推到群里。这张表把告警变成有状态、可确认、可投递的实体。
 *
 * 去重键怎么落：
 * MySQL 没有「部分唯一索引」，而需求是「未关闭的同一指纹只能有一行、已解决的
 * 允许再来一条新的」。用生成列 `open_key`：未解决时等于 fingerprint，已解决时为
 * NULL（NULL 不参与唯一性），于是唯一索引 `(owner_id, connection_id, open_key)`
 * 精确表达了这条规则，重复命中由数据库兜底，不依赖应用层先查后写。
 *
 * 为什么归属是 connection 而不是 session：
 * 与 error_fingerprints / host_metrics_minute 保持一致 —— 触发告警的那个终端
 * 断开，不代表主机上的问题结束了。
 *
 * alert_mutes 单独一张小表而不是塞进 sys_config：
 * 静默窗口是按账号 + 规则拆分的，放 sys_config 要自己拼多行 JSON 并处理并发覆盖，
 * 反而更难查。
 *
 * 幂等：两张表都是 IF NOT EXISTS，不需要 information_schema 探测。
 */

export const ALERTS_SQL = `
-- ------------------------------------------------------------
-- 告警。一行 = 一台机器上的一个「未关闭错误」；重复命中只累加 occurrences。
-- fingerprint 与 error_fingerprints 用同一份归一化实现（server/utils/fingerprint.ts），
-- 否则同一句报错在两张表里会得到两个 key。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '告警 ID',
  owner_id        VARCHAR(64)   NOT NULL COMMENT '归属账号',
  connection_id   VARCHAR(64)   NOT NULL COMMENT '连接配置 ID；服务端本机固定 __local__',
  fingerprint     CHAR(16)      NOT NULL COMMENT 'sha256(归一化代表行) 前 16 位',
  status          VARCHAR(16)   NOT NULL DEFAULT 'open' COMMENT 'open / acked / resolved',
  open_key        CHAR(16)      GENERATED ALWAYS AS (
                    CASE WHEN status = 'resolved' THEN NULL ELSE fingerprint END
                  ) STORED COMMENT '未关闭时的去重键；已解决置 NULL，允许同一指纹再次开新行',
  source          VARCHAR(16)   NOT NULL DEFAULT 'log' COMMENT '来源：log（日志规则命中）/ command（预留）',
  rule            VARCHAR(128)  NOT NULL DEFAULT '' COMMENT '规则标识（日志监控的匹配正则），静默按它生效',
  level           VARCHAR(16)   NOT NULL DEFAULT 'error' COMMENT 'warning / error / critical',
  message         VARCHAR(512)  NOT NULL DEFAULT '' COMMENT '最近一次告警文案（给人看）',
  sample_text     VARCHAR(512)  NOT NULL DEFAULT '' COMMENT '代表行原文（去 ANSI）',
  occurrences     INT UNSIGNED  NOT NULL DEFAULT 1 COMMENT '累计命中次数',
  first_seen      DATETIME(3)   NOT NULL COMMENT '首次出现（写后不再变）',
  last_seen       DATETIME(3)   NOT NULL COMMENT '最近一次命中；列表与投递判断都用它',
  acked_by        VARCHAR(64)   NULL COMMENT '确认人（账号 ID）',
  acked_at        DATETIME(3)   NULL COMMENT '确认时间',
  resolved_at     DATETIME(3)   NULL COMMENT '人工标记已解决的时间；保留期按它清理',
  PRIMARY KEY (id),
  -- 去重规则本体：未关闭的同一指纹只有一行
  UNIQUE KEY uk_alerts_open (owner_id, connection_id, open_key),
  -- 列表默认按「状态 + 最近命中」翻页
  KEY idx_alerts_owner_status (owner_id, status, last_seen),
  -- 去重时按指纹找「未关闭的那一行」；P6 按指纹反查历史处置也走它
  KEY idx_alerts_fingerprint (owner_id, connection_id, fingerprint),
  KEY idx_alerts_last_seen (last_seen),
  CONSTRAINT ck_alerts_status CHECK (status IN ('open', 'acked', 'resolved')),
  CONSTRAINT ck_alerts_level CHECK (level IN ('warning', 'error', 'critical')),
  CONSTRAINT ck_alerts_source CHECK (source IN ('log', 'command'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='告警实体（同一主机同一未关闭错误一行）';

-- ------------------------------------------------------------
-- 规则级静默：静默期间照常记录与累加，只是不投递 webhook。
-- 不删告警是有意的 —— 静默是「别吵我」，不是「当没发生」。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_mutes (
  owner_id   VARCHAR(64)  NOT NULL COMMENT '归属账号',
  rule       VARCHAR(128) NOT NULL COMMENT '被静默的规则标识',
  until      DATETIME(3)  NOT NULL COMMENT '静默截止时间',
  created_at DATETIME(3)  NOT NULL COMMENT '设置时间',
  PRIMARY KEY (owner_id, rule)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='告警规则级静默窗口';
`;
