/**
 * lite（SQLite）模式的**合并基线 schema**。
 *
 * 为什么不直接重放 0001–0012：
 * 那批迁移是为 MySQL 写的 —— 里面有 `information_schema` 探测、`PREPARE`/`SET @ddl`
 * 动态 DDL、`DROP/ADD PRIMARY KEY`、`FULLTEXT ... WITH PARSER ngram`，这些在 SQLite
 * 上没有等价写法，硬转只会得到「迁移第 3 条语句失败」。
 * 所以 lite 模式把 0001–0012 的**最终形态**手工翻译成一份 SQLite DDL：
 * 首次建库执行它一次，然后把 0001–0012 原样登记为「已应用」（校验和仍取 MySQL 正文，
 * 这样两边对「哪个版本改过」的判断完全一致），之后的 0013+ 走正常迁移链。
 *
 * 翻译约定（与 MySQL 侧行为对齐的点）：
 * - 时间列一律 TEXT，格式固定 `YYYY-MM-DD HH:MM:SS.mmm`（UTC）。理由：SQLite 没有
 *   原生时间类型，而固定宽度字符串的字典序比较恰好等于时间先后，`>=` / `<` / `MAX()`
 *   全部可用；驱动层负责 Date <-> 字符串的双向转换（见 dialect.ts）。
 * - `TINYINT(1)` -> INTEGER（0/1）；`DECIMAL` -> REAL；`JSON`/`MEDIUMTEXT` -> TEXT。
 * - MySQL 的 `utf8mb4_0900_ai_ci` 是大小写不敏感的：账号名、连接名这类「人输入、
 *   用来判重」的列显式加 `COLLATE NOCASE`，否则 SQLite 会允许 'Admin' 与 'admin'
 *   并存 —— 那等于把仿冒账号放了进来。
 * - `alerts.open_key` 的生成列保留（SQLite 3.31+ 支持 STORED 生成列）：
 *   「未关闭的同一指纹只有一行」这条规则靠唯一索引兜底，不能降级成应用层先查后写。
 * - `FULLTEXT` 索引丢弃：仓库里的关键词查询本来就带 LIKE 兜底，lite 模式只走 LIKE。
 * - 不建外键：与 MySQL 侧一致（0001 的约定），跨表完整性由业务代码负责。
 *
 * 维护约束：这份基线一旦发版就**不要改**。已经建好的 lite 库不会重跑它，
 * 改动只会让新库与老库产生静默差异。要加表加列，写新的迁移（给 `sqliteSql` 字段）。
 */

/** 基线在 schema_version 里的版本号：比 0001 小，便于在列表里一眼认出 */
export const SQLITE_BASELINE_VERSION = '0000-baseline';
export const SQLITE_BASELINE_NAME = 'sqlite-baseline (0001~0012 merged)';

export const SQLITE_BASELINE_SQL = `
-- ------------------------------------------------------------
-- 账号（0002 + 0005）
-- username 大小写不敏感：'Admin' 与 'admin' 视为同一账号，避免仿冒
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                     TEXT    NOT NULL,
  username               TEXT    NOT NULL COLLATE NOCASE,
  display_name           TEXT    NOT NULL DEFAULT '',
  password_hash          TEXT    NOT NULL,
  role                   TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  status                 TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  can_use_terminal       INTEGER NOT NULL DEFAULT 0,
  can_use_batch          INTEGER NOT NULL DEFAULT 0,
  can_use_ai             INTEGER NOT NULL DEFAULT 0,
  can_manage_connections INTEGER NOT NULL DEFAULT 0,
  can_configure_ai       INTEGER NOT NULL DEFAULT 0,
  can_use_files          INTEGER NOT NULL DEFAULT 0,
  can_view_monitor       INTEGER NOT NULL DEFAULT 0,
  can_view_audit         INTEGER NOT NULL DEFAULT 0,
  can_manage_skills      INTEGER NOT NULL DEFAULT 0,
  can_manage_snippets    INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,
  last_login_at          TEXT    NULL,
  last_login_ip          TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status, created_at);

-- ------------------------------------------------------------
-- 连接配置（0001 + 0002 + 0008）
-- *_enc 沿用既有 AES-256-GCM 密文（enc:v1: 前缀），密钥仍在数据目录
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connections (
  id                TEXT    NOT NULL,
  owner_id          TEXT    NOT NULL,
  name              TEXT    NOT NULL COLLATE NOCASE,
  type              TEXT    NOT NULL DEFAULT 'ssh' CHECK (type IN ('ssh','local')),
  host              TEXT    NOT NULL DEFAULT '',
  port              INTEGER NOT NULL DEFAULT 22,
  username          TEXT    NOT NULL DEFAULT '',
  auth_type         TEXT    NOT NULL DEFAULT 'auto' CHECK (auth_type IN ('password','privateKey','auto')),
  password_enc      TEXT    NULL,
  private_key_enc   TEXT    NULL,
  passphrase_enc    TEXT    NULL,
  shell             TEXT    NOT NULL DEFAULT '',
  startup_script    TEXT    NULL,
  forward_agent     INTEGER NOT NULL DEFAULT 0,
  term_cols         INTEGER NOT NULL DEFAULT 80,
  term_rows         INTEGER NOT NULL DEFAULT 24,
  term_font_size    INTEGER NOT NULL DEFAULT 14,
  term_font_family  TEXT    NOT NULL DEFAULT 'Menlo, Monaco, "Courier New", monospace',
  term_theme        TEXT    NOT NULL DEFAULT 'dark',
  term_cursor_style TEXT    NOT NULL DEFAULT 'block' CHECK (term_cursor_style IN ('block','underline','bar')),
  options           TEXT    NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  sampling          TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_connections_type_name ON connections (type, name);
CREATE INDEX IF NOT EXISTS idx_connections_updated ON connections (updated_at);
CREATE INDEX IF NOT EXISTS idx_connections_owner_updated ON connections (owner_id, updated_at);

-- ------------------------------------------------------------
-- 终端会话元数据（0001 + 0002）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT NOT NULL,
  owner_id       TEXT NOT NULL,
  connection_id  TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('ssh','local')),
  name           TEXT NOT NULL DEFAULT '',
  system_context TEXT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_connection ON sessions (connection_id);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions (owner_id, created_at);

-- ------------------------------------------------------------
-- AI 服务商配置（0001 + 0002 + 0003 + 0004）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_config (
  id               TEXT    NOT NULL,
  owner_id         TEXT    NOT NULL,
  label            TEXT    NOT NULL DEFAULT '默认',
  enabled          INTEGER NOT NULL DEFAULT 0,
  provider         TEXT    NOT NULL DEFAULT '',
  base_url         TEXT    NOT NULL DEFAULT '',
  model            TEXT    NOT NULL DEFAULT '',
  api_key_enc      TEXT    NULL,
  max_tokens       INTEGER NULL,
  temperature      REAL    NULL,
  cost_tier        INTEGER NOT NULL DEFAULT 3,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  cost_tier_source TEXT    NOT NULL DEFAULT 'manual',
  price_in         REAL    NULL,
  price_out        REAL    NULL,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ai_config_enabled ON ai_config (enabled);
CREATE INDEX IF NOT EXISTS idx_ai_config_owner_enabled ON ai_config (owner_id, enabled);

-- ------------------------------------------------------------
-- AI 对话历史（展示用，0001 + 0002）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_history (
  session_id    TEXT    NOT NULL,
  owner_id      TEXT    NOT NULL,
  session_name  TEXT    NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  preview       TEXT    NOT NULL DEFAULT '',
  messages      TEXT    NOT NULL,
  saved_at      TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  PRIMARY KEY (owner_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_history_saved ON ai_history (saved_at);
CREATE INDEX IF NOT EXISTS idx_history_owner_saved ON ai_history (owner_id, saved_at);

-- ------------------------------------------------------------
-- 喂给模型的上下文消息（0001 + 0002）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_messages (
  session_id    TEXT    NOT NULL,
  owner_id      TEXT    NOT NULL,
  messages      TEXT    NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  PRIMARY KEY (owner_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_updated ON ai_messages (updated_at);

-- ------------------------------------------------------------
-- AI 对话窗口（0003）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_chats (
  id            TEXT    NOT NULL,
  owner_id      TEXT    NOT NULL,
  connection_id TEXT    NOT NULL DEFAULT '',
  title         TEXT    NOT NULL DEFAULT '',
  model_id      TEXT    NOT NULL DEFAULT 'auto',
  message_count INTEGER NOT NULL DEFAULT 0,
  preview       TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ai_chats_owner_conn ON ai_chats (owner_id, connection_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_ai_chats_owner_updated ON ai_chats (owner_id, updated_at);

-- ------------------------------------------------------------
-- AI 用量与成本（0004）
-- id 用 AUTOINCREMENT（SQLite 里只有 INTEGER PRIMARY KEY AUTOINCREMENT 才严格递增不复用）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id          TEXT    NOT NULL,
  chat_id           TEXT    NOT NULL DEFAULT '',
  connection_id     TEXT    NOT NULL DEFAULT '',
  model_id          TEXT    NOT NULL DEFAULT '',
  model_label       TEXT    NOT NULL DEFAULT '',
  auto_routed       INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL    NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_owner_chat ON ai_usage (owner_id, chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_owner_created ON ai_usage (owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_owner_model ON ai_usage (owner_id, model_id, created_at);

-- ------------------------------------------------------------
-- AI 用量预算（0004）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_budget (
  owner_id          TEXT    NOT NULL,
  chat_token_limit  INTEGER NOT NULL DEFAULT 0,
  daily_token_limit INTEGER NOT NULL DEFAULT 0,
  daily_cost_limit  REAL    NOT NULL DEFAULT 0,
  updated_at        TEXT    NOT NULL,
  PRIMARY KEY (owner_id)
);

-- ------------------------------------------------------------
-- 命令审计流水（0001 + 0002）。FULLTEXT 丢弃，关键词查询走 LIKE
-- audit_date 是本地日期的 'YYYY-MM-DD'，与旧文件名口径一致
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id             TEXT    NOT NULL,
  owner_id       TEXT    NOT NULL,
  occurred_at    TEXT    NOT NULL,
  audit_date     TEXT    NOT NULL,
  session_id     TEXT    NOT NULL,
  session_name   TEXT    NULL,
  connection_id  TEXT    NULL,
  user_message   TEXT    NULL,
  tool           TEXT    NOT NULL DEFAULT '',
  command        TEXT    NULL,
  result         TEXT    NULL,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL CHECK (status IN ('success','error','blocked','rewritten')),
  rewritten_from TEXT    NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_audit_date_session ON audit_events (audit_date, session_id);
CREATE INDEX IF NOT EXISTS idx_audit_status_date ON audit_events (status, audit_date);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_events (occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_owner_date ON audit_events (owner_id, audit_date);

-- ------------------------------------------------------------
-- 技能（0001 + 0002）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skills (
  id          TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NULL,
  tags        TEXT NULL,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('system','user')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_skills_source ON skills (source);

-- ------------------------------------------------------------
-- 命令片段（0001 + 0002）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snippets (
  id         TEXT    NOT NULL,
  owner_id   TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  command    TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS idx_snippets_sort ON snippets (sort_order);

-- ------------------------------------------------------------
-- 全局系统配置（0006）：与账号无关，口令类值存 scrypt 哈希串
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sys_config (
  k          TEXT NOT NULL,
  v          TEXT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (k)
);

-- ------------------------------------------------------------
-- 主机指标留存（0007）
-- bucket 是分钟桶起点；avg/max 由仓储层的 upsert 增量合并
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS host_metrics_minute (
  owner_id            TEXT    NOT NULL,
  connection_id       TEXT    NOT NULL,
  hostname            TEXT    NOT NULL DEFAULT '',
  bucket              TEXT    NOT NULL,
  samples             INTEGER NOT NULL DEFAULT 1,
  cpu_pct_avg         REAL    NULL,
  cpu_pct_max         REAL    NULL,
  mem_pct_avg         REAL    NULL,
  mem_pct_max         REAL    NULL,
  disk_pct_avg        REAL    NULL,
  disk_pct_max        REAL    NULL,
  disk_total_bytes    INTEGER NULL,
  disk_used_bytes_avg INTEGER NULL,
  disk_used_bytes_max INTEGER NULL,
  load1_avg           REAL    NULL,
  load1_max           REAL    NULL,
  load5_avg           REAL    NULL,
  load5_max           REAL    NULL,
  load15_avg          REAL    NULL,
  load15_max          REAL    NULL,
  updated_at          TEXT    NOT NULL,
  PRIMARY KEY (owner_id, connection_id, bucket)
);
CREATE INDEX IF NOT EXISTS idx_host_metrics_bucket ON host_metrics_minute (bucket);

-- ------------------------------------------------------------
-- 错误指纹聚合（0009）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS error_fingerprints (
  owner_id         TEXT    NOT NULL,
  connection_id    TEXT    NOT NULL,
  fingerprint      TEXT    NOT NULL,
  sample_text      TEXT    NOT NULL DEFAULT '',
  tool             TEXT    NOT NULL DEFAULT '',
  command          TEXT    NOT NULL DEFAULT '',
  occurrences      INTEGER NOT NULL DEFAULT 1,
  first_seen       TEXT    NOT NULL,
  last_seen        TEXT    NOT NULL,
  last_resolved_at TEXT    NULL,
  PRIMARY KEY (owner_id, connection_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_error_fp_last_seen ON error_fingerprints (last_seen);

-- ------------------------------------------------------------
-- 告警实体（0010 + 0011）
-- open_key 生成列复刻 MySQL 的「部分唯一索引」：
-- 未解决 = fingerprint，已解决 = NULL（NULL 不参与唯一性），
-- 于是「同一台机器同一指纹只能有一个未关闭告警」由数据库兜底
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     TEXT    NOT NULL,
  connection_id TEXT   NOT NULL,
  fingerprint  TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','acked','resolved')),
  open_key     TEXT    GENERATED ALWAYS AS (CASE WHEN status = 'resolved' THEN NULL ELSE fingerprint END) STORED,
  source       TEXT    NOT NULL DEFAULT 'log' CHECK (source IN ('log','command')),
  rule         TEXT    NOT NULL DEFAULT '',
  level        TEXT    NOT NULL DEFAULT 'error' CHECK (level IN ('warning','error','critical')),
  message      TEXT    NOT NULL DEFAULT '',
  sample_text  TEXT    NOT NULL DEFAULT '',
  occurrences  INTEGER NOT NULL DEFAULT 1,
  first_seen   TEXT    NOT NULL,
  last_seen    TEXT    NOT NULL,
  acked_by     TEXT    NULL,
  acked_at     TEXT    NULL,
  assignee_id  TEXT    NULL,
  incident_id  INTEGER NULL,
  resolved_at  TEXT    NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_alerts_open ON alerts (owner_id, connection_id, open_key);
CREATE INDEX IF NOT EXISTS idx_alerts_owner_status ON alerts (owner_id, status, last_seen);
CREATE INDEX IF NOT EXISTS idx_alerts_fingerprint ON alerts (owner_id, connection_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_alerts_last_seen ON alerts (last_seen);
CREATE INDEX IF NOT EXISTS idx_alerts_assignee ON alerts (owner_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_incident ON alerts (incident_id);

-- ------------------------------------------------------------
-- 规则级静默（0010）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_mutes (
  owner_id   TEXT NOT NULL,
  rule       TEXT NOT NULL,
  "until"    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, rule)
);

-- ------------------------------------------------------------
-- 告警归并出的事件（0011）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      TEXT    NOT NULL,
  connection_id TEXT    NOT NULL,
  title         TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  alert_count   INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  resolved_at   TEXT    NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_owner_open ON incidents (owner_id, status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_incidents_conn ON incidents (owner_id, connection_id, status);

-- ------------------------------------------------------------
-- 值班时间窗（0011）：只用于 webhook 里 @谁
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_oncall (
  owner_id     TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute   INTEGER NOT NULL,
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (owner_id, user_id, start_minute)
);
CREATE INDEX IF NOT EXISTS idx_oncall_window ON alert_oncall (owner_id, start_minute);

-- ------------------------------------------------------------
-- 只读监控令牌（0012）：哈希落库，明文只在签发时返回一次
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_watch_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  token_hash   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  revoked_at   TEXT    NULL,
  last_used_at TEXT    NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_watch_token_hash ON auth_watch_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_watch_owner ON auth_watch_tokens (owner_id, revoked_at, expires_at);
`;
