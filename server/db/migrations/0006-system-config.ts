/**
 * 0006 —— 全局系统配置表，首个用途是「默认服务器 Shell」的口令。
 *
 * 为什么需要一张不分账号的表：
 * 「默认服务器 Shell」开在服务端那台机器上，它是**整台主机**的入口，
 * 不属于任何一个账号，也就不能塞进 ai_config 这类带 owner_id 的表里。
 *
 * 值是 scrypt 哈希串（沿用 auth.service 的 scrypt$N$r$p$salt$hash 格式），
 * 不存明文：这张表会被备份、被 DBA 看、被误导出，明文口令泄漏等同于交出一台机器。
 *
 * 幂等：IF NOT EXISTS。加列走 information_schema 的那套在这里用不上，
 * 因为这是一张新表，建表语句本身就是原子的。
 */

export const SYSTEM_CONFIG_SQL = `
-- ------------------------------------------------------------
-- 全局系统配置（与账号无关）。k 是配置键，v 存值：
-- 口令类配置存哈希串，其余为普通文本。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sys_config (
  k          VARCHAR(64)  NOT NULL COMMENT '配置键',
  v          TEXT         NULL     COMMENT '配置值（口令为 scrypt 哈希串）',
  updated_at DATETIME(3)  NOT NULL COMMENT '最后修改时间，供管理页展示',
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='全局系统配置（不分账号）';
`;
