/**
 * 0004 —— 成本管控：档位自动识别的溯源 + 实测用量 + 预算。
 *
 * 三件事：
 *   1) ai_config 加 cost_tier_source / price_in / price_out。
 *      cost_tier_source 记录档位是「谁定的」：auto=由定价目录推断，manual=用户手填。
 *      没有这一列，自动识别会在每次保存时把用户故意调的档位覆盖掉。
 *      两个单价存「美元 / 1M token」，为空表示目录里没查到——宁可留空，
 *      也不要瞎猜一个价格去算成本，算错的成本比没有成本更糟。
 *   2) 新建 ai_usage：一行 = 一次 LLM 调用结束时的用量。
 *      done 事件本来就带 usage，但此前只是转发给前端就丢了，
 *      没有它就无法回答「这个对话花了多少」「auto 到底省了多少」。
 *      cost_usd 在写入时按当时的单价算好并固化：单价以后会变，
 *      历史账不该跟着变。
 *   3) 新建 ai_budget：账号级的 token / 金额上限，0 表示不限。
 *
 * 幂等：与 0002 同样的 information_schema 判断 + PREPARE 手法，
 * 迁移中途失败后重跑不会报表已存在。
 */

export const COST_CONTROL_SQL = `
-- ------------------------------------------------------------
-- 档位来源：auto（定价目录推断）/ manual（用户手填，不再被自动覆盖）
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_config' AND COLUMN_NAME = 'cost_tier_source') = 0,
  'ALTER TABLE ai_config ADD COLUMN cost_tier_source VARCHAR(16) NOT NULL DEFAULT ''manual'' COMMENT ''auto=目录推断, manual=用户手填'' AFTER sort_order',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- 单价：美元 / 1M token。NULL 表示未知，不做任何金额估算
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_config' AND COLUMN_NAME = 'price_in') = 0,
  'ALTER TABLE ai_config ADD COLUMN price_in DECIMAL(10,4) NULL COMMENT ''输入单价 美元/1M token'' AFTER cost_tier_source',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_config' AND COLUMN_NAME = 'price_out') = 0,
  'ALTER TABLE ai_config ADD COLUMN price_out DECIMAL(10,4) NULL COMMENT ''输出单价 美元/1M token'' AFTER price_in',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- 实测用量：一行 = 一次模型调用结束
-- chat_id 为空表示不属于任何对话窗口（一次性问答等）
-- cost_usd 写入时固化，不跟随 ai_config 的单价变化
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id          VARCHAR(64)  NOT NULL,
  chat_id           VARCHAR(64)  NOT NULL DEFAULT '',
  connection_id     VARCHAR(64)  NOT NULL DEFAULT '',
  model_id          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'ai_config.id',
  model_label       VARCHAR(128) NOT NULL DEFAULT '',
  auto_routed       TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '是否由 auto 路由选中',
  prompt_tokens     INT          NOT NULL DEFAULT 0,
  completion_tokens INT          NOT NULL DEFAULT 0,
  total_tokens      INT          NOT NULL DEFAULT 0,
  cost_usd          DECIMAL(14,8) NOT NULL DEFAULT 0 COMMENT '按写入时单价算出的金额',
  ok                TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '0=这一轮失败了（用于路由自适应）',
  created_at        DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_ai_usage_owner_chat (owner_id, chat_id, created_at),
  KEY idx_ai_usage_owner_created (owner_id, created_at),
  KEY idx_ai_usage_owner_model (owner_id, model_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='AI 调用用量与成本';

-- ------------------------------------------------------------
-- 预算：0 表示不限。放在独立表而不是 users 上，
-- 是因为它属于「AI 功能配置」，与账号权限/状态无关
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_budget (
  owner_id          VARCHAR(64)   NOT NULL,
  chat_token_limit  INT           NOT NULL DEFAULT 0 COMMENT '单对话 token 上限，0=不限',
  daily_token_limit INT           NOT NULL DEFAULT 0 COMMENT '每日 token 上限，0=不限',
  daily_cost_limit  DECIMAL(10,4) NOT NULL DEFAULT 0 COMMENT '每日金额上限（美元），0=不限',
  updated_at        DATETIME(3)   NOT NULL,
  PRIMARY KEY (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='AI 用量预算（按账号）';
`;
