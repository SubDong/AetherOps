/**
 * 0003 —— AI 模型从「一账号一套」扩到「一账号多套」，并把对话从终端会话里拆出来。
 *
 * 两个变化：
 * 1) ai_config 增加 cost_tier / sort_order。auto 模式要靠 cost_tier 在多个配置之间
 *    挑模型（1=最便宜 … 5=最强），sort_order 只是给设置页一个稳定顺序。
 *    表本来就是 (owner_id, id) 复合主键，多套配置不需要改主键。
 * 2) 新建 ai_chats：一个连接下可以有多个对话窗口，对话自身带 chatId 与 model_id。
 *    原先对话直接以终端 sessionId 为 key，而 sessionId 每次开终端都会变，
 *    所以「回到这个连接继续上次对话」在旧结构里根本做不到。
 *
 * 旧对话按「不迁移、直接清空」处理：ai_history / ai_messages 的 session_id
 * 存的是终端会话 ID，无法可靠地重新归属到一个新 chatId 上。
 * 这两条 DELETE 只会随本迁移执行一次，不是每次启动都跑。
 */

export const MULTI_AI_SQL = `
-- ------------------------------------------------------------
-- 多套模型配置：cost_tier 供 auto 路由分档，sort_order 供设置页排序
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_config' AND COLUMN_NAME = 'cost_tier') = 0,
  'ALTER TABLE ai_config ADD COLUMN cost_tier INT NOT NULL DEFAULT 3 COMMENT ''成本档位 1=最便宜 5=最强，auto 路由用'' AFTER temperature',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_config' AND COLUMN_NAME = 'sort_order') = 0,
  'ALTER TABLE ai_config ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER cost_tier',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- 对话窗口：一个连接多个对话，各自记住用的模型
-- connection_id 用空串而不是 NULL：唯一索引与 ORDER BY 都不好处理 NULL，
-- 而「未绑定连接」本身在语义上就是一个空值而不是缺失。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_chats (
  id            VARCHAR(64)  NOT NULL COMMENT '对话 ID，前端生成或服务端下发',
  owner_id      VARCHAR(64)  NOT NULL,
  connection_id VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '绑定的连接；本地终端为 __local__',
  title         VARCHAR(255) NOT NULL DEFAULT '',
  model_id      VARCHAR(32)  NOT NULL DEFAULT 'auto' COMMENT 'auto 或 ai_config.id',
  message_count INT          NOT NULL DEFAULT 0,
  preview       VARCHAR(512) NOT NULL DEFAULT '' COMMENT '列表页摘要',
  created_at    DATETIME(3)  NOT NULL,
  updated_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (owner_id, id),
  KEY idx_ai_chats_owner_conn (owner_id, connection_id, updated_at),
  KEY idx_ai_chats_owner_updated (owner_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='AI 对话窗口（与连接绑定）';

-- ------------------------------------------------------------
-- 旧对话按决定清空：session_id 指向的是终端会话，无法重新归属到 chatId
-- ------------------------------------------------------------
DELETE FROM ai_messages;
DELETE FROM ai_history;
`;
