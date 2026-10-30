/**
 * 0002 —— 账号体系 + 全量数据按账号隔离。
 *
 * 三件事：
 *   1) 建 users 表（角色 + 状态 + 细粒度权限位）。
 *   2) 清空 0001 建出来的业务数据。账号体系上线后「无主数据」没有意义，
 *      旧数据（单用户的连接 / 会话 / AI 配置 / 审计 / 技能 / 片段）一律丢弃，
 *      这是与使用方明确确认过的取舍，不是遗漏。
 *   3) 给每张业务表加 owner_id 归属列，并把「主键里带固定 ID」的表改成复合主键：
 *      connections（本地连接固定 id=__local__）、ai_config（默认配置 id=default）、
 *      skills / snippets / ai_history / ai_messages（id 由前端或会话生成，跨账号会撞）。
 *
 * 为什么 ALTER 全部套一层 information_schema 判断 + PREPARE：
 *   迁移器「中途失败不登记版本、下次重跑」的设计要求每条语句可重入，
 *   而 MySQL 8 不支持 ADD COLUMN IF NOT EXISTS。ALTER TABLE 本身是原子的，
 *   所以「owner_id 列存在」就等价于「这条 ALTER 已整体成功」，以此作为幂等开关。
 *
 * 为什么 owner_id 不给 DEFAULT ''：
 *   漏写归属列时希望它直接报错(STRICT 模式)，而不是静默落成空串——
 *   空串归属的数据任何账号都查不到，属于最难发现的数据丢失。
 */

export const ACCOUNTS_SQL = `
-- ------------------------------------------------------------
-- 账号（角色管账号、权限管功能；两者独立：
--   role=admin 能管别人的账号，但看不到别人的连接/会话/审计数据）
-- username 的唯一索引继承库级 utf8mb4_0900_ai_ci，大小写不敏感，
-- 'Admin' 与 'admin' 视为同一账号——这是刻意的，避免仿冒账号。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                     VARCHAR(64)  NOT NULL COMMENT 'UUID',
  username               VARCHAR(64)  NOT NULL,
  display_name           VARCHAR(64)  NOT NULL DEFAULT '',
  password_hash          VARCHAR(255) NOT NULL COMMENT 'scrypt$N$r$p$salt$hash，见 auth.service',
  role                   VARCHAR(16)  NOT NULL DEFAULT 'user' COMMENT 'admin | user',
  status                 VARCHAR(16)  NOT NULL DEFAULT 'pending' COMMENT 'pending | active | disabled',
  can_use_terminal       TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '终端（SSH / 本地 Shell）',
  can_use_ai             TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'AI 对话与 Agent',
  can_manage_connections TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '自行增删改连接',
  can_configure_ai       TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '配置自己的 AI 模型与 Key',
  can_use_files          TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'SFTP 文件管理与传输',
  can_view_monitor       TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '日志监控与告警',
  can_view_audit         TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '查看自己的审计日志',
  can_manage_skills      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '增删自己的自定义技能',
  can_manage_snippets    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '增删自己的命令片段',
  created_at             DATETIME(3)  NOT NULL,
  updated_at             DATETIME(3)  NOT NULL,
  last_login_at          DATETIME(3)  NULL,
  last_login_ip          VARCHAR(64)  NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  KEY idx_users_status (status, created_at),
  CONSTRAINT ck_users_role CHECK (role IN ('admin','user')),
  CONSTRAINT ck_users_status CHECK (status IN ('pending','active','disabled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='账号、角色与功能权限';

-- ------------------------------------------------------------
-- 丢弃无主旧数据（按「直接清空重建」的决定）。DELETE 而非 TRUNCATE：
-- TRUNCATE 需要 DROP 权限，这里的账号通常只给了 DML 权限。
-- ------------------------------------------------------------
DELETE FROM ai_messages;
DELETE FROM ai_history;
DELETE FROM audit_events;
DELETE FROM snippets;
DELETE FROM skills;
DELETE FROM sessions;
DELETE FROM ai_config;
DELETE FROM connections;

-- ------------------------------------------------------------
-- 连接：主键改 (owner_id, id)，本地连接固定 id=__local__ 才能多账号共存
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connections' AND COLUMN_NAME = 'owner_id') = 0,
  'ALTER TABLE connections ADD COLUMN owner_id VARCHAR(64) NOT NULL AFTER id, DROP PRIMARY KEY, ADD PRIMARY KEY (owner_id, id), ADD KEY idx_connections_owner_updated (owner_id, updated_at)',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- 会话：session_id 本身是随机串，主键保持不动，只加归属列与查询索引
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'owner_id') = 0,
  'ALTER TABLE sessions ADD COLUMN owner_id VARCHAR(64) NOT NULL AFTER session_id, ADD KEY idx_sessions_owner (owner_id, created_at)',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- AI 配置：每个账号一套独立 Key，主键改 (owner_id, id)
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_config' AND COLUMN_NAME = 'owner_id') = 0,
  'ALTER TABLE ai_config ADD COLUMN owner_id VARCHAR(64) NOT NULL AFTER id, DROP PRIMARY KEY, ADD PRIMARY KEY (owner_id, id), ADD KEY idx_ai_config_owner_enabled (owner_id, enabled)',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- AI 展示历史：历史可能比会话活得久，归属必须自带而不是靠 session_id 反查
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_history' AND COLUMN_NAME = 'owner_id') = 0,
  'ALTER TABLE ai_history ADD COLUMN owner_id VARCHAR(64) NOT NULL AFTER session_id, DROP PRIMARY KEY, ADD PRIMARY KEY (owner_id, session_id), ADD KEY idx_history_owner_saved (owner_id, saved_at)',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- 模型上下文消息：同上
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_messages' AND COLUMN_NAME = 'owner_id') = 0,
  'ALTER TABLE ai_messages ADD COLUMN owner_id VARCHAR(64) NOT NULL AFTER session_id, DROP PRIMARY KEY, ADD PRIMARY KEY (owner_id, session_id)',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- 审计：id 是 UUID 主键，只加归属列；(owner_id, audit_date) 是本账号最常用的过滤
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events' AND COLUMN_NAME = 'owner_id') = 0,
  'ALTER TABLE audit_events ADD COLUMN owner_id VARCHAR(64) NOT NULL AFTER id, ADD KEY idx_audit_owner_date (owner_id, audit_date)',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- 技能：内置技能仍读 data/skills/*.md 不入库，本表只存 source=user，
-- 因此主键必须是 (owner_id, id)，否则两个账号不能有同名技能
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'skills' AND COLUMN_NAME = 'owner_id') = 0,
  'ALTER TABLE skills ADD COLUMN owner_id VARCHAR(64) NOT NULL AFTER id, DROP PRIMARY KEY, ADD PRIMARY KEY (owner_id, id)',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- 命令片段：同上
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'snippets' AND COLUMN_NAME = 'owner_id') = 0,
  'ALTER TABLE snippets ADD COLUMN owner_id VARCHAR(64) NOT NULL AFTER id, DROP PRIMARY KEY, ADD PRIMARY KEY (owner_id, id)',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
`;
