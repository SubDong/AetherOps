/**
 * AI 用量仓储：一次模型调用结束就落一行。
 *
 * 为什么不用「在 ai_chats 上累加」代替：
 * - 按模型拆账要 group by model，累加列做不到；
 * - 路由自适应要按模型算成功率，累加列更做不到；
 * - 每日预算要按时间窗口求和，累加列只能给「总计」。
 * 行数会涨，但一行只有几十字节，而且查询都带 (owner_id, created_at) 索引。
 *
 * cost_usd 是写入时按当时单价算好的：单价会变（厂商降价、用户改档位），
 * 历史账不该跟着变，否则「昨天花了多少」每天看都不一样。
 */
import { execute, query, queryOne } from '../pool';

export interface UsageRecord {
  chatId: string;
  connectionId: string;
  modelId: string;
  modelLabel: string;
  autoRouted: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** null 表示单价未知，落库为 0 但语义是「算不出来」 */
  costUsd: number | null;
  ok: boolean;
}

export interface UsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** 有多少次调用是单价未知（金额被低估的部分） */
  unknownCostCalls: number;
}

export interface UsageByModel {
  modelId: string;
  modelLabel: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageByChat {
  chatId: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
}

export interface ModelHealth {
  modelId: string;
  calls: number;
  okCalls: number;
  totalTokens: number;
  avgTokens: number;
}

const EMPTY_TOTALS: UsageTotals = {
  calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, unknownCostCalls: 0,
};

export async function insertUsageRow(ownerId: string, record: UsageRecord): Promise<void> {
  await execute(
    `INSERT INTO ai_usage
       (owner_id, chat_id, connection_id, model_id, model_label, auto_routed,
        prompt_tokens, completion_tokens, total_tokens, cost_usd, ok, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerId,
      record.chatId || '',
      record.connectionId || '',
      record.modelId || '',
      (record.modelLabel || '').substring(0, 128),
      record.autoRouted ? 1 : 0,
      Math.max(0, Math.round(record.promptTokens || 0)),
      Math.max(0, Math.round(record.completionTokens || 0)),
      Math.max(0, Math.round(record.totalTokens || 0)),
      record.costUsd === null ? 0 : Number(record.costUsd.toFixed(8)),
      record.ok ? 1 : 0,
      new Date(),
    ],
  );
}

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapTotals(row: any): UsageTotals {
  if (!row) return { ...EMPTY_TOTALS };
  return {
    calls: num(row.calls),
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    totalTokens: num(row.total_tokens),
    costUsd: num(row.cost_usd),
    unknownCostCalls: num(row.unknown_cost_calls),
  };
}

/**
 * 求和。chatId / since / modelId 都可选，组合出「这个对话的」「今天的」「这个模型的」。
 * unknown_cost_calls 用 cost_usd = 0 且 total_tokens > 0 来近似 ——
 * 真正免费（目录价 0）的模型也会落到这里，显示成「部分金额未知」不算错。
 */
export async function sumUsage(
  ownerId: string,
  filter?: { chatId?: string; modelId?: string; since?: Date },
): Promise<UsageTotals> {
  const where = ['owner_id = ?'];
  const params: any[] = [ownerId];
  if (filter?.chatId) {
    where.push('chat_id = ?');
    params.push(filter.chatId);
  }
  if (filter?.modelId) {
    where.push('model_id = ?');
    params.push(filter.modelId);
  }
  if (filter?.since) {
    where.push('created_at >= ?');
    params.push(filter.since);
  }
  const row = await queryOne<any>(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd,
            COALESCE(SUM(CASE WHEN cost_usd = 0 AND total_tokens > 0 THEN 1 ELSE 0 END), 0) AS unknown_cost_calls
       FROM ai_usage WHERE ${where.join(' AND ')}`,
    params,
  );
  return mapTotals(row);
}

export async function groupUsageByModel(ownerId: string, since?: Date): Promise<UsageByModel[]> {
  const params: any[] = [ownerId];
  const sinceClause = since ? ' AND created_at >= ?' : '';
  if (since) params.push(since);
  const rows = await query<any>(
    `SELECT model_id,
            MAX(model_label) AS model_label,
            COUNT(*) AS calls,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM ai_usage WHERE owner_id = ?${sinceClause}
      GROUP BY model_id ORDER BY total_tokens DESC`,
    params,
  );
  return rows.map((row: any) => ({
    modelId: row.model_id || '',
    modelLabel: row.model_label || row.model_id || '',
    calls: num(row.calls),
    totalTokens: num(row.total_tokens),
    costUsd: num(row.cost_usd),
  }));
}

/** 一次查回一批对话的用量，避免列表页对每条对话都发一次聚合查询 */
export async function groupUsageByChat(ownerId: string, chatIds: string[]): Promise<Map<string, UsageByChat>> {
  const result = new Map<string, UsageByChat>();
  const ids = chatIds.filter(Boolean).slice(0, 200);
  if (!ids.length) return result;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await query<any>(
    `SELECT chat_id, COUNT(*) AS calls,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM ai_usage WHERE owner_id = ? AND chat_id IN (${placeholders})
      GROUP BY chat_id`,
    [ownerId, ...ids],
  );
  for (const row of rows) {
    result.set(row.chat_id, {
      chatId: row.chat_id,
      calls: num(row.calls),
      totalTokens: num(row.total_tokens),
      costUsd: num(row.cost_usd),
    });
  }
  return result;
}

/** 路由自适应用：近 N 天每个模型的调用数、成功数、平均 token */
export async function loadModelHealth(ownerId: string, since: Date): Promise<ModelHealth[]> {
  const rows = await query<any>(
    `SELECT model_id, COUNT(*) AS calls,
            COALESCE(SUM(ok), 0) AS ok_calls,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(AVG(total_tokens), 0) AS avg_tokens
       FROM ai_usage WHERE owner_id = ? AND created_at >= ?
      GROUP BY model_id`,
    [ownerId, since],
  );
  return rows.map((row: any) => ({
    modelId: row.model_id || '',
    calls: num(row.calls),
    okCalls: num(row.ok_calls),
    totalTokens: num(row.total_tokens),
    avgTokens: num(row.avg_tokens),
  }));
}

/** 删对话时一并清掉它的用量：否则预算里会永久挂着一笔查不到来源的账 */
export async function deleteUsageByChat(ownerId: string, chatId: string): Promise<number> {
  const r = await execute('DELETE FROM ai_usage WHERE owner_id = ? AND chat_id = ?', [ownerId, chatId]);
  return r.affectedRows;
}

/** 返回本地时区今天的零点 */
export function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
