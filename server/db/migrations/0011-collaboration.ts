/**
 * 0011 —— 协同 + 复用（P6）。
 *
 * 三件事共用一条迁移，因为它们是同一层语义（「这条告警归谁、和哪些告警是一件事」）
 * 的三个字段，拆开只会让 schema 版本多出一串「加了列但没人读」的中间态：
 *
 * 1. `alerts.assignee_id`：处理人。与 `acked_by` 分开是有意的 ——
 *    确认是「我看到了」，指派是「这件事归你」；一个人可以先被派给别人再确认，
 *    也可能看一眼就转派。合成一列以后就再也分不清「谁认领的」和「谁确认的」。
 * 2. `alerts.incident_id` + `incidents`：同 connection 30 分钟内 ≥3 条未解决告警
 *    自动并成一件事（规则版，不做根因推断）。归并结果落在列上，`incidents`
 *    只存「事情本身」（标题 / 起止时间 / 关联条数），不存根因。
 * 3. `alert_oncall`：值班表（账号 + 每日时间窗）。它**只用来决定 webhook 里 @谁**，
 *    不给项目加邮件/IM 渠道 —— 通知渠道是接收端的事，这里只描述「此刻谁在岗」。
 *
 * 幂等：加列沿用 0002/0008 的 information_schema 探测 + PREPARE 写法
 * （MySQL 8 不支持 ADD COLUMN IF NOT EXISTS）；新表用 IF NOT EXISTS。
 * 索引也先探测再建，避免中途失败重跑时撞「Duplicate key name」。
 */

export const COLLABORATION_SQL = `
-- ------------------------------------------------------------
-- 告警：处理人 + 归并到的 incident。
-- assignee_id 只对「当前未解决」的行有意义，已解决的行保留历史值（谁处理的）。
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND COLUMN_NAME = 'assignee_id') = 0,
  'ALTER TABLE alerts ADD COLUMN assignee_id VARCHAR(64) NULL COMMENT ''处理人（账号 ID）；认领 = 确认 + 指派给自己'' AFTER acked_at',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND COLUMN_NAME = 'incident_id') = 0,
  'ALTER TABLE alerts ADD COLUMN incident_id BIGINT UNSIGNED NULL COMMENT ''归并到的 incident；NULL = 尚未归并'' AFTER assignee_id',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND INDEX_NAME = 'idx_alerts_assignee') = 0,
  'ALTER TABLE alerts ADD KEY idx_alerts_assignee (owner_id, assignee_id, status)',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND INDEX_NAME = 'idx_alerts_incident') = 0,
  'ALTER TABLE alerts ADD KEY idx_alerts_incident (incident_id)',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- incident：一件事。多个告警归并到一行，方便「这一波到底出了几个问题」。
-- 不做根因推断：无数据时推出来的都是演示效果，宁可只记事实。
-- title 由应用层用首条告警文案填，之后不再变 —— 它是给人在列表里认的标签。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'incident ID',
  owner_id     VARCHAR(64)   NOT NULL COMMENT '归属账号',
  connection_id VARCHAR(64)  NOT NULL COMMENT '归并维度：同一台主机',
  title        VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '首条告警文案（列表标签）',
  status       VARCHAR(16)   NOT NULL DEFAULT 'open' COMMENT 'open / resolved',
  alert_count  INT UNSIGNED  NOT NULL DEFAULT 0 COMMENT '当前关联告警条数（应用层维护）',
  started_at   DATETIME(3)   NOT NULL COMMENT '第一条告警归入时间',
  last_seen_at DATETIME(3)   NOT NULL COMMENT '最近一次有告警命中/归入',
  resolved_at  DATETIME(3)   NULL COMMENT '关联告警全部解决的时间',
  PRIMARY KEY (id),
  KEY idx_incidents_owner_open (owner_id, status, last_seen_at),
  KEY idx_incidents_conn (owner_id, connection_id, status),
  CONSTRAINT ck_incidents_status CHECK (status IN ('open', 'resolved'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='告警归并出的事件（规则版：同主机 30 分钟内 ≥3 条未解决）';

-- ------------------------------------------------------------
-- 值班表：每人可以有多个每日时间窗（例如 09:00-13:00 与 14:00-18:00）。
-- 分钟数用「当天 0 点起的分钟」表示，跨零点用 start > end 表达（20:00-08:00）。
-- 只决定 webhook 里 @谁：项目内不建通知渠道，邮件/IM 由接收端自己发。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_oncall (
  owner_id      VARCHAR(64)  NOT NULL COMMENT '归属账号（告警归属）',
  user_id       VARCHAR(64)  NOT NULL COMMENT '值班人账号 ID',
  start_minute  SMALLINT UNSIGNED NOT NULL COMMENT '每日开始（0-1439，本地时区）',
  end_minute    SMALLINT UNSIGNED NOT NULL COMMENT '每日结束（0-1440，左闭右开；小于 start 表示跨零点）',
  created_at    DATETIME(3)  NOT NULL COMMENT '设置时间',
  PRIMARY KEY (owner_id, user_id, start_minute),
  KEY idx_oncall_window (owner_id, start_minute)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='值班时间窗（只用于 webhook 的 @人）';
`;
