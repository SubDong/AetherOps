/**
 * 0013 —— 登录会话表（lite 模式下的「Redis 替代品」）。
 *
 * 为什么需要这张表：
 * enterprise 模式把登录令牌放 Redis，理由是「按 TTL 自动过期，用库表还得扫表」。
 * lite 模式下没有 Redis，令牌必须有地方放 —— 那就是这个文件里的库。
 * 放进来之后 TTL 语义改为「存 expires_at、读的时候比时间」，顺手解决了
 * 「Redis 重启后所有会话失效」的反向问题（单机部署重启 Redis 的成本比重启库高）。
 *
 * 表结构对齐了 Redis 那套 key 的两层语义：
 *   token:<hash>          -> payload           ==> auth_sessions.token_hash + payload
 *   user:<id>:token       -> 该账号当前的哈希  ==> user_id 上的唯一索引
 * 唯一索引 (user_id) 是「单账号单会话」的落点：签发新令牌时先删同一 user_id 的旧行，
 * 事务保证「删旧 + 写新」之间插不进另一个登录请求，与 Redis 的 Lua 脚本等价。
 *
 * 为什么 MySQL 侧也建这张表：
 * 两种后端共用一条迁移链（脚本/CI 只需要跑一种）。MySQL 侧这张表目前不写入
 * （令牌仍在 Redis），但保留它让两边的 schema 版本与 --dump 输出一致；
 * 将来若要彻底去掉 Redis，把 TokenStore 的企业实现切到表上即可，不需要再补迁移。
 */
export const AUTH_SESSIONS_SQL = `
-- ------------------------------------------------------------
-- 登录会话（lite 模式的令牌存储）
-- token_hash 是访问令牌的 sha256(hex)：库里存的东西不能直接拿去登录
-- payload 是会话身份快照（userId/username/角色/权限位/登录 IP），
-- 与 TokenPayload 一一对应；鉴权命中后直接用它，不必再查 users
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_sessions (
  -- CHAR(64) 而不是 TEXT：sha256 hex 就是定长 64，且 MySQL 不允许 TEXT/BLOB 直接作主键
  -- （ER_BLOB_KEY_WITHOUT_LENGTH，要么给前缀长度，要么换成定长类型）
  token_hash CHAR(64)  NOT NULL COMMENT '访问令牌的 SHA-256（hex，定长 64）',
  user_id    VARCHAR(64) NOT NULL COMMENT '归属账号',
  payload    TEXT      NOT NULL COMMENT 'TokenPayload 的 JSON 快照',
  issued_at  DATETIME(3) NOT NULL COMMENT '签发时间（UTC）',
  expires_at DATETIME(3) NOT NULL COMMENT '到期时间（UTC）；滑动续期时后移',
  PRIMARY KEY (token_hash),
  -- 单账号单会话：同一账号同时只能有一枚有效会话令牌
  UNIQUE KEY uk_auth_sessions_user (user_id),
  KEY idx_auth_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='登录会话令牌（lite/SQLite 模式使用；MySQL 模式令牌在 Redis）';
`;

/**
 * SQLite 版本。
 * 类型按方言约定映射：时间列存 `YYYY-MM-DD HH:MM:SS.mmm`（UTC）的 TEXT，
 * 比较大小靠定宽字符串的字典序（见 server/db/dialect.ts）。
 */
export const AUTH_SESSIONS_SQLITE_SQL = `
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  payload    TEXT NOT NULL,
  issued_at  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (token_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions (expires_at);
`;
