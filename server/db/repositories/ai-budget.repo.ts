/**
 * AI 预算仓储（按账号）。
 *
 * 0 一律表示「不限」而不是「额度为 0」：默认值必须让功能可用，
 * 否则新账号一上手就被自己的默认配置锁死。
 *
 * 预算只在发起一轮对话前检查（软限制）：已经开始的对话不会因为
 * 中途超限被掐断 —— 半途中断留下的是「说了一半的方案」，
 * 比多花一点 token 更难收拾。
 */
import { execute, queryOne } from '../pool';

export interface AIBudgetRow {
  /** 单对话累计 token 上限，0=不限 */
  chatTokenLimit: number;
  /** 每日 token 上限，0=不限 */
  dailyTokenLimit: number;
  /** 每日金额上限（美元），0=不限 */
  dailyCostLimit: number;
  updatedAt: number;
}

const ZERO_BUDGET: AIBudgetRow = {
  chatTokenLimit: 0,
  dailyTokenLimit: 0,
  dailyCostLimit: 0,
  updatedAt: 0,
};

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function loadBudgetRow(ownerId: string): Promise<AIBudgetRow> {
  const row = await queryOne<any>(
    'SELECT chat_token_limit, daily_token_limit, daily_cost_limit, updated_at FROM ai_budget WHERE owner_id = ?',
    [ownerId],
  );
  if (!row) return { ...ZERO_BUDGET };
  return {
    chatTokenLimit: num(row.chat_token_limit),
    dailyTokenLimit: num(row.daily_token_limit),
    dailyCostLimit: num(row.daily_cost_limit),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  };
}

export async function saveBudgetRow(ownerId: string, patch: Partial<AIBudgetRow>): Promise<AIBudgetRow> {
  const current = await loadBudgetRow(ownerId);
  const next: AIBudgetRow = {
    chatTokenLimit: patch.chatTokenLimit === undefined ? current.chatTokenLimit : num(patch.chatTokenLimit),
    dailyTokenLimit: patch.dailyTokenLimit === undefined ? current.dailyTokenLimit : num(patch.dailyTokenLimit),
    dailyCostLimit: patch.dailyCostLimit === undefined ? current.dailyCostLimit : Math.max(0, Number(patch.dailyCostLimit) || 0),
    updatedAt: Date.now(),
  };
  await execute(
    `INSERT INTO ai_budget (owner_id, chat_token_limit, daily_token_limit, daily_cost_limit, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       chat_token_limit = VALUES(chat_token_limit),
       daily_token_limit = VALUES(daily_token_limit),
       daily_cost_limit = VALUES(daily_cost_limit),
       updated_at = VALUES(updated_at)`,
    [ownerId, next.chatTokenLimit, next.dailyTokenLimit, next.dailyCostLimit, new Date()],
  );
  return next;
}
