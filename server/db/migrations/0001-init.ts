/**
 * 0001 —— 把原先散在 ~/.aetherops 下的 JSON/JSONL 数据全部建成表。
 *
 * 写法约束（都来自对目标实例的实测，不是通用常识）：
 * - MySQL 8.4.11，sql_mode 含 STRICT_TRANS_TABLES / NO_ZERO_DATE，
 *   因此时间列一律 DATETIME(3) NOT NULL 且不给数据库侧默认值。
 * - 服务端 system_time_zone=CST，而驱动 timezone 传 '+00:00'：
 *   所有 created_at/updated_at 必须由应用层给 JS Date（按 UTC 解释），
 *   绝不用 NOW()/CURRENT_TIMESTAMP，否则读写差 8 小时。
 * - lower_case_table_names=0，标识符大小写敏感，统一 snake_case。
 * - 不使用 ENUM：ENUM 的取值比较依赖列的排序规则，utf8mb4_0900_ai_ci 是
 *   大小写不敏感的，'privateKey'/'privatekey' 会被视为同一个值。改用
 *   VARCHAR + CHECK，取值由代码里的常量约束，大小写保真。
 * - JSON / TEXT 列在 MySQL 里不能带 DEFAULT，所以只能 NOT NULL 或留空。
 * - 不建外键：现有删除路径都是「直接删」（删连接不关心历史会话残留），
 *   加级联会改变语义；单用户本地数据也没有跨表完整性诉求。
 */

export const INIT_SQL = `
-- ------------------------------------------------------------
-- 连接配置（原 connections.json）
-- 三个 *_enc 列沿用既有加密方案：AES-256-GCM，密文带 enc:v1: 前缀，
-- 密钥仍是数据目录下的 connections.key。改成明文列会直接放大泄露面。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connections (
  id               VARCHAR(64)  NOT NULL COMMENT '连接 ID；本地 shell 固定为 __local__',
  name             VARCHAR(255) NOT NULL,
  type             VARCHAR(8)   NOT NULL DEFAULT 'ssh' COMMENT 'ssh | local',
  host             VARCHAR(255) NOT NULL DEFAULT '',
  port             INT          NOT NULL DEFAULT 22,
  username         VARCHAR(255) NOT NULL DEFAULT '',
  auth_type        VARCHAR(16)  NOT NULL DEFAULT 'auto' COMMENT 'password | privateKey | auto',
  password_enc     TEXT         NULL,
  private_key_enc  LONGTEXT     NULL,
  passphrase_enc   TEXT         NULL,
  shell            VARCHAR(255) NOT NULL DEFAULT '' COMMENT '仅 type=local',
  startup_script   TEXT         NULL COMMENT '连接后自动执行，跳板机场景',
  forward_agent    TINYINT(1)   NOT NULL DEFAULT 0,
  term_cols        INT          NOT NULL DEFAULT 80,
  term_rows        INT          NOT NULL DEFAULT 24,
  term_font_size   INT          NOT NULL DEFAULT 14,
  term_font_family VARCHAR(255) NOT NULL DEFAULT 'Menlo, Monaco, "Courier New", monospace',
  term_theme       VARCHAR(64)  NOT NULL DEFAULT 'dark',
  term_cursor_style VARCHAR(16) NOT NULL DEFAULT 'block' COMMENT 'block | underline | bar',
  options          JSON         NULL COMMENT 'keepalive 等扩展项，形状不稳定，不拆列',
  enabled          TINYINT(1)   NOT NULL DEFAULT 1,
  created_at       DATETIME(3)  NOT NULL,
  updated_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_connections_type_name (type, name),
  KEY idx_connections_updated (updated_at),
  CONSTRAINT ck_connections_type CHECK (type IN ('ssh','local')),
  CONSTRAINT ck_connections_auth CHECK (auth_type IN ('password','privateKey','auto')),
  CONSTRAINT ck_connections_cursor CHECK (term_cursor_style IN ('block','underline','bar'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='SSH / 本地终端连接配置';

-- ------------------------------------------------------------
-- 终端会话元数据（原 sessions.json）
-- 只存元数据用于重启后恢复 tab，活的 PTY / SSH 句柄仍在内存里。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  session_id     VARCHAR(64)  NOT NULL,
  connection_id  VARCHAR(64)  NOT NULL,
  type           VARCHAR(8)   NOT NULL,
  name           VARCHAR(255) NOT NULL DEFAULT '',
  system_context MEDIUMTEXT   NULL COMMENT 'AI 上下文用的系统信息 / MOTD 采集结果',
  created_at     DATETIME(3)  NOT NULL,
  updated_at     DATETIME(3)  NOT NULL,
  PRIMARY KEY (session_id),
  KEY idx_sessions_connection (connection_id),
  CONSTRAINT ck_sessions_type CHECK (type IN ('ssh','local'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='终端会话元数据';

-- ------------------------------------------------------------
-- AI 服务商配置（原 ai-config.json，apiKey 加密）
-- 用 id 主键而不是单行表，为「多套模型配置来回切」留出空间。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_config (
  id          VARCHAR(32)  NOT NULL COMMENT '配置标识，默认 default',
  label       VARCHAR(128) NOT NULL DEFAULT '默认',
  enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  provider    VARCHAR(64)  NOT NULL DEFAULT '',
  base_url    VARCHAR(512) NOT NULL DEFAULT '',
  model       VARCHAR(128) NOT NULL DEFAULT '',
  api_key_enc TEXT         NULL COMMENT 'AES-256-GCM，enc:v1: 前缀，密钥 ai-config.key',
  max_tokens  INT          NULL,
  temperature DOUBLE       NULL,
  created_at  DATETIME(3)  NOT NULL,
  updated_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_ai_config_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='AI 服务商配置';

-- ------------------------------------------------------------
-- AI 对话历史（原 ai-history/*.json：HistoryFile = meta + DisplayMessage[]）
-- messages 是给人看的渲染结果，与下面喂给 LLM 的 ai_messages 不是一回事。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_history (
  session_id    VARCHAR(64)  NOT NULL,
  session_name  VARCHAR(255) NULL,
  message_count INT          NOT NULL DEFAULT 0,
  preview       VARCHAR(512) NOT NULL DEFAULT '' COMMENT '列表页摘要',
  messages      JSON         NOT NULL COMMENT 'DisplayMessage[]，含 agentSteps',
  saved_at      DATETIME(3)  NOT NULL,
  updated_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (session_id),
  KEY idx_history_saved (saved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='AI 会话历史（前端展示用）';

-- ------------------------------------------------------------
-- 喂给 LLM 的上下文消息（原 messages/<sessionId>.json）
-- 保留最近 MAX_MESSAGES 条，整包覆盖写。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_messages (
  session_id    VARCHAR(64) NOT NULL,
  messages      JSON        NOT NULL COMMENT 'Message[]（role/content）',
  message_count INT         NOT NULL DEFAULT 0,
  created_at    DATETIME(3) NOT NULL,
  updated_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (session_id),
  KEY idx_ai_messages_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='AI 会话的模型上下文消息';

-- ------------------------------------------------------------
-- 命令审计（原 audit/YYYY-MM-DD.jsonl，30 天保留）
-- 落表后 AuditQuery 里的 keyword / status / sessionId 才真的能跨天查——
-- 文件版只能读单个日期文件，跨日必须走 getLogsRange 逐文件全量读。
-- ngram 全文索引是为中文关键词准备的，查询侧仍保留 LIKE 兜底。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id             CHAR(36)     NOT NULL,
  occurred_at    DATETIME(3)  NOT NULL,
  audit_date     DATE         NOT NULL COMMENT '按本地日切分，与旧文件名口径一致',
  session_id     VARCHAR(64)  NOT NULL,
  session_name   VARCHAR(255) NULL,
  connection_id  VARCHAR(64)  NULL,
  user_message   MEDIUMTEXT   NULL,
  tool           VARCHAR(64)  NOT NULL DEFAULT '',
  command        MEDIUMTEXT   NULL,
  result         MEDIUMTEXT   NULL,
  duration_ms    INT          NOT NULL DEFAULT 0,
  status         VARCHAR(16)  NOT NULL COMMENT 'success | error | blocked | rewritten',
  rewritten_from MEDIUMTEXT   NULL COMMENT '被安全护栏改写前的原命令',
  PRIMARY KEY (id),
  KEY idx_audit_date_session (audit_date, session_id),
  KEY idx_audit_status_date (status, audit_date),
  KEY idx_audit_occurred (occurred_at),
  FULLTEXT KEY ft_audit_search (user_message, command, result) WITH PARSER ngram,
  CONSTRAINT ck_audit_status CHECK (status IN ('success','error','blocked','rewritten'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='AI Agent 执行的命令审计流水';

-- ------------------------------------------------------------
-- 技能（原 data/skills/*.md 内置 + ~/.aetherops/skills/*.md 用户）
-- 内置技能文件仍是上游定义，启动时按需 seed 进来；用户技能以本表为准。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skills (
  id          VARCHAR(128) NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT         NULL,
  tags        JSON         NULL,
  content     MEDIUMTEXT   NOT NULL COMMENT 'front matter 之后的 markdown 正文',
  source      VARCHAR(8)   NOT NULL DEFAULT 'user' COMMENT 'system | user',
  created_at  DATETIME(3)  NOT NULL,
  updated_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_skills_source (source),
  CONSTRAINT ck_skills_source CHECK (source IN ('system','user'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Agent 技能定义';

-- ------------------------------------------------------------
-- 命令片段（原先只存在浏览器 localStorage，换机器/换浏览器就没了）
-- sort_order 承接前端数组顺序（新增在前的语义）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snippets (
  id         VARCHAR(64)  NOT NULL,
  name       VARCHAR(255) NOT NULL,
  command    MEDIUMTEXT   NOT NULL,
  sort_order INT          NOT NULL DEFAULT 0,
  created_at DATETIME(3)  NOT NULL,
  updated_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_snippets_sort (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='常用命令片段';
`;
