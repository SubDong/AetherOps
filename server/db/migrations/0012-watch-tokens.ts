/**
 * 0012 —— 只读监控令牌（watch token）。
 *
 * 为什么单独一张表，而不是塞进 Redis：
 * 这类令牌要**能被列出、能被单独吊销**。登录令牌放在 Redis 是因为它只需要按 TTL 过期；
 * 而大屏令牌是一张「谁签的、什么时候签的、最后用在哪一刻、有没有被吊销」的清单，
 * 用库表才能在一次查询里回答，界面也不必为了列个清单去反查 Redis 的扫描结果。
 *
 * 哈希落库、明文只在签发时返回一次：与 users.password_hash 同一套思路 ——
 * 库里存的东西不该能直接拿去登录。
 *
 * 与登录会话的关系：**不占用「单账号单会话」的名额**。同一账号可以一边在电脑上登录，
 * 一边有三块大屏各持一枚只读令牌，互不踢线。这也是这张表必须存在的原因 ——
 * 登录令牌的「一账号一枚」是 Lua 脚本里写死的，长寿命只读令牌走它就会把用户踢下线。
 */
export const WATCH_TOKENS_SQL = `
CREATE TABLE IF NOT EXISTS auth_watch_tokens (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '令牌 ID（吊销时用它，不用哈希）',
  owner_id     VARCHAR(64)   NOT NULL COMMENT '归属账号',
  label        VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '用途标签，如「值班大屏」',
  token_hash   CHAR(64)      NOT NULL COMMENT '令牌 SHA-256（hex）；明文只在签发时出现一次',
  created_at   DATETIME(3)   NOT NULL COMMENT '签发时间',
  expires_at   DATETIME(3)   NOT NULL COMMENT '到期时间；到期后连同登录会话一样 401',
  revoked_at   DATETIME(3)   NULL COMMENT '吊销时间；NULL = 仍可用',
  last_used_at DATETIME(3)   NULL COMMENT '最近一次被使用；写频率在应用层节流',
  PRIMARY KEY (id),
  UNIQUE KEY uk_watch_token_hash (token_hash),
  KEY idx_watch_owner (owner_id, revoked_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='只读监控令牌（大屏/值班机）；只认 /api/watch/*，不占单会话名额';
`;
