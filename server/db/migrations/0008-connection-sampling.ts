/**
 * 0008 —— 连接级的「不参与无会话采集」标记。
 *
 * 为什么需要：0007 的采集器只跟进活会话，把 metrics.offlineSampling 打开后它就会
 * **主动拨号**。有些机器不能接受无人值守登录（生产库、客户环境、审计要求严格的主机），
 * 而它们恰恰是配置在列表里的连接——所以必须有「这台别采」的表达方式，
 * 否则唯一的选择是关掉全局开关，等于让所有机器一起失去历史。
 *
 * 为什么不用现有的 enabled 列：
 * enabled 是「是否启用」的遗留字段，服务端目前没有任何一处读它来做判断，
 * 拿它当采集开关会让「这台机器为什么没数据」同时指向两件互不相干的事。
 * 这里用独立列，语义只有一条：skip = 不参与无会话采集；空串 = 跟随全局配置。
 * 它不影响手动打开终端、也不影响面板（人连上去照样采）。
 *
 * 为什么默认空串而不是 NULL：与 enabled 等列保持同一种形状（NOT NULL + 空值兜底），
 * 读取侧只判断 'skip'，多一个 NULL 分支只会让写入侧多一次判空。
 *
 * 幂等：MySQL 8 不支持 ADD COLUMN IF NOT EXISTS，沿用 0002 的
 * information_schema 探测 + PREPARE 写法，保证迁移中途失败后可以重跑。
 */

export const CONNECTION_SAMPLING_SQL = `
-- ------------------------------------------------------------
-- 连接：无会话采集标记。'skip' = 该连接不被定时采集器主动拨号，
-- 空串 = 跟随全局 metrics.offlineSampling 配置。
-- ------------------------------------------------------------
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connections' AND COLUMN_NAME = 'sampling') = 0,
  'ALTER TABLE connections ADD COLUMN sampling VARCHAR(16) NOT NULL DEFAULT '''' COMMENT ''无会话采集标记：空=跟随全局，skip=不采'' AFTER enabled',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
`;
