/**
 * AI 配置仓储：ai-config.json 的替代品。
 *
 * 只存一份（id='default'）：改造没有多套配置切换的 UI，但表结构留了 id 主键，
 * 以后要做「工作/私人两套模型」不需要再迁移一次。
 *
 * api_key_enc 里是 AES-256-GCM 密文（enc:v1: 前缀），密钥仍是数据目录下的
 * ai-config.key —— 加密/解密由 AIService 负责，本模块只搬运字符串。
 */
import { execute, queryOne } from '../pool';

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
  updatedAt: Date;
}

export async function loadAIConfigRow(ownerId: string, id: string = DEFAULT_ID): Promise<AIConfigRow | null> {
  const row = await queryOne<any>(
    'SELECT id, label, enabled, provider, base_url, model, api_key_enc, max_tokens, temperature, updated_at'
      + ' FROM ai_config WHERE owner_id = ? AND id = ?',
    [ownerId, id],
  );
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    enabled: !!row.enabled,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    apiKeyEnc: row.api_key_enc || '',
    maxTokens: row.max_tokens === null ? null : Number(row.max_tokens),
    temperature: row.temperature === null ? null : Number(row.temperature),
    updatedAt: row.updated_at,
  };
}

/**
 * 写入配置（不存在则插入）。
 * 用 ON DUPLICATE KEY UPDATE 而不是「先查后写」：两次网络往返换成一次，
 * 也避免并发保存时两次都判定为「不存在」然后主键冲突。
 */
export async function saveAIConfigRow(ownerId: string, row: Omit<AIConfigRow, 'updatedAt'>, id: string = DEFAULT_ID): Promise<void> {
  const now = new Date();
  await execute(
    `INSERT INTO ai_config (owner_id, id, label, enabled, provider, base_url, model, api_key_enc, max_tokens, temperature, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       label = VALUES(label),
       enabled = VALUES(enabled),
       provider = VALUES(provider),
       base_url = VALUES(base_url),
       model = VALUES(model),
       api_key_enc = VALUES(api_key_enc),
       max_tokens = VALUES(max_tokens),
       temperature = VALUES(temperature),
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
      now,
      now,
    ],
  );
}

export { DEFAULT_ID as DEFAULT_AI_CONFIG_ID };
