/**
 * AI 模型配置仓储：ai-config.json 的替代品。
 *
 * 一个账号可以有多套配置（主键是 (owner_id, id)）：不同服务商、不同价位、
 * 同一服务商的快慢两个模型……auto 模式正是靠 cost_tier 在这些配置之间挑。
 * 这里只负责搬运，加解密由 AIService 负责。
 *
 * api_key_enc 里是 AES-256-GCM 密文（enc:v1: 前缀），密钥仍是数据目录下的
 * ai-config.key。
 */
import { execute, query, queryOne } from '../pool';

const DEFAULT_ID = 'default';

export interface AIConfigRow {
  id: string;
  label: string;
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyEnc: string;
  maxTokens: number | null;
  temperature: number | null;
  /** 1=最便宜 … 5=最强，auto 路由按它分档 */
  costTier: number;
  /** auto=由定价目录/规则推断（允许再被重算），manual=用户手填（不再自动覆盖） */
  costTierSource: 'auto' | 'manual';
  /** 美元 / 1M token；null 表示定价目录里没查到，不做金额估算 */
  priceIn: number | null;
  priceOut: number | null;
  sortOrder: number;
  updatedAt: Date;
}

const COLUMNS = 'id, label, enabled, provider, base_url, model, api_key_enc, max_tokens, temperature, cost_tier, cost_tier_source, price_in, price_out, sort_order, updated_at';

function mapRow(row: any): AIConfigRow {
  return {
    id: row.id,
    label: row.label || '',
    enabled: !!row.enabled,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    apiKeyEnc: row.api_key_enc || '',
    maxTokens: row.max_tokens === null ? null : Number(row.max_tokens),
    temperature: row.temperature === null ? null : Number(row.temperature),
    costTier: row.cost_tier === null ? 3 : Number(row.cost_tier),
    costTierSource: row.cost_tier_source === 'auto' ? 'auto' : 'manual',
    priceIn: row.price_in === null || row.price_in === undefined ? null : Number(row.price_in),
    priceOut: row.price_out === null || row.price_out === undefined ? null : Number(row.price_out),
    sortOrder: row.sort_order === null ? 0 : Number(row.sort_order),
    updatedAt: row.updated_at,
  };
}

export async function listAIConfigRows(ownerId: string): Promise<AIConfigRow[]> {
  const rows = await query<any>(
    `SELECT ${COLUMNS} FROM ai_config WHERE owner_id = ? ORDER BY sort_order ASC, created_at ASC`,
    [ownerId],
  );
  return rows.map(mapRow);
}

export async function loadAIConfigRow(ownerId: string, id: string = DEFAULT_ID): Promise<AIConfigRow | null> {
  const row = await queryOne<any>(
    `SELECT ${COLUMNS} FROM ai_config WHERE owner_id = ? AND id = ?`,
    [ownerId, id],
  );
  return row ? mapRow(row) : null;
}

/**
 * 写入配置（不存在则插入）。
 * 用 ON DUPLICATE KEY UPDATE 而不是「先查后写」：两次网络往返换成一次，
 * 也避免并发保存时两次都判定为「不存在」然后主键冲突。
 */
export async function saveAIConfigRow(ownerId: string, row: Omit<AIConfigRow, 'updatedAt'>, id: string = DEFAULT_ID): Promise<void> {
  const now = new Date();
  await execute(
    `INSERT INTO ai_config (owner_id, id, label, enabled, provider, base_url, model, api_key_enc, max_tokens, temperature, cost_tier, cost_tier_source, price_in, price_out, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       label = VALUES(label),
       enabled = VALUES(enabled),
       provider = VALUES(provider),
       base_url = VALUES(base_url),
       model = VALUES(model),
       api_key_enc = VALUES(api_key_enc),
       max_tokens = VALUES(max_tokens),
       temperature = VALUES(temperature),
       cost_tier = VALUES(cost_tier),
       cost_tier_source = VALUES(cost_tier_source),
       price_in = VALUES(price_in),
       price_out = VALUES(price_out),
       sort_order = VALUES(sort_order),
       updated_at = VALUES(updated_at)`,
    [
      ownerId,
      id,
      row.label,
      row.enabled ? 1 : 0,
      row.provider,
      row.baseUrl,
      row.model,
      row.apiKeyEnc || null,
      row.maxTokens,
      row.temperature,
      row.costTier,
      row.costTierSource || 'manual',
      row.priceIn,
      row.priceOut,
      row.sortOrder,
      now,
      now,
    ],
  );
}

export async function deleteAIConfigRow(ownerId: string, id: string): Promise<number> {
  const r = await execute('DELETE FROM ai_config WHERE owner_id = ? AND id = ?', [ownerId, id]);
  return r.affectedRows;
}

export async function countAIConfigRows(ownerId: string): Promise<number> {
  const row = await queryOne<any>('SELECT COUNT(*) AS c FROM ai_config WHERE owner_id = ?', [ownerId]);
  return Number(row?.c) || 0;
}

export { DEFAULT_ID as DEFAULT_AI_CONFIG_ID };
