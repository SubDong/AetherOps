/**
 * 0005 —— 批量操作独立成一个权限位。
 *
 * 批量执行是「一条命令打到 N 台主机」，影响面比单个终端大得多，
 * 之前它跟着 terminal 权限走（有终端就能批量），没法单独收回。
 *
 * 迁移把新列默认给 0，然后继承一次 can_use_terminal：
 * 拆分权限位不该让原本能用批量的人突然用不了，
 * 想收回的人由管理员在账号管理页逐个取消勾选。
 *
 * 幂等：加列套 information_schema 判断 + PREPARE（MySQL 8 没有 ADD COLUMN IF NOT EXISTS），
 * UPDATE 带 can_use_batch = 0 条件，重跑不会把管理员后来关掉的权限又打开。
 */

export const BATCH_PERMISSION_SQL = `
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'can_use_batch') = 0,
  'ALTER TABLE users ADD COLUMN can_use_batch TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''批量操作（多主机并行下发命令）'' AFTER can_use_terminal',
  'DO 0');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 只补「有终端权限但批量位还是默认 0」的账号：
-- 条件里带上 can_use_batch = 0，重跑本迁移不会覆盖管理员已经收回的授权
UPDATE users SET can_use_batch = 1 WHERE can_use_terminal = 1 AND can_use_batch = 0;
`;
