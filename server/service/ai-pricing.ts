/**
 * 模型定价目录。
 *
 * 目的：给 ai_config 的两个单价（美元 / 1M token）找一个不靠自己瞎编的来源。
 * 用的是 OpenRouter 的公开目录 https://openrouter.ai/api/v1/models —— 不需要
 * API Key，返回各家的模型与每 token 单价。它当然不是「官方价」，但对本项目的
 * 用途足够了：我们只需要知道模型之间的相对贵贱，以及一个能算钱的量级。
 *
 * 三条原则：
 * 1) 绝不阻塞主流程。目录拉不到（离线 / 被墙 / 超时）就返回空，档位退化成
 *    规则推断，金额显示为「未知」而不是 0 —— 算错的成本比没有成本更糟。
 * 2) 缓存 24 小时，失败只缓存 5 分钟，避免每次保存配置都去打一次网络。
 * 3) 同名冲突取更贵的那个：成本估算宁可偏高，偏低会让用户以为很省。
 */
import * as https from 'https';

export interface ModelPrice {
  /** 美元 / 1M token */
  inputPerM: number;
  outputPerM: number;
  /** 命中的目录条目，便于在界面上说明依据 */
  catalogId: string;
}

interface CatalogState {
  at: number;
  /** 上一次拉取是否成功；失败时 entries 可能为空但保留旧值 */
  ok: boolean;
  entries: Map<string, ModelPrice>;
}

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 服务商 → 目录里的 id 前缀。Azure 与 OpenAI 同源，custom 直接按模型名匹配 */
const PROVIDER_PREFIX: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  azure: 'openai',
  tencent: 'tencent',
  google: 'google',
  deepseek: 'deepseek',
};

let catalog: CatalogState | null = null;
let inflight: Promise<Map<string, ModelPrice>> | null = null;

/**
 * 归一化模型名，让 `claude-3-5-sonnet-20241022` 与目录里的
 * `anthropic/claude-3.5-sonnet` 这类差异不至于完全匹配不上。
 */
export function normalizeModelKey(model: string): string {
  let s = (model || '').trim().toLowerCase();
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  // ollama 风格的 tag：llama3:8b
  s = s.replace(/:.*$/, '');
  // 日期后缀 / -latest / -preview 反复剥，`gpt-4o-2024-08-06` 这类可能叠两层
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/[-@](?:\d{8}|\d{4}-\d{2}-\d{2}|latest|preview|beta|exp|stable)$/, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** 排序用的混合单价：输入 token 在真实用量里占大头，输出单价高但量少 */
export function blendedPrice(price: { inputPerM: number; outputPerM: number }): number {
  return price.inputPerM + price.outputPerM * 0.25;
}

function toPerMillion(value: any): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // 目录给的是「每 token 美元」，换算成「每 1M token 美元」，保留 6 位小数
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

function putEntry(map: Map<string, ModelPrice>, key: string, price: ModelPrice): void {
  if (!key) return;
  const prev = map.get(key);
  // 同名冲突（不同厂商的同名模型）取更贵者，成本估算偏保守
  if (!prev || blendedPrice(price) > blendedPrice(prev)) map.set(key, price);
}

function parseCatalog(payload: any): Map<string, ModelPrice> {
  const entries = new Map<string, ModelPrice>();
  const list = Array.isArray(payload?.data) ? payload.data : [];
  for (const item of list) {
    const id = String(item?.id || '').toLowerCase();
    if (!id) continue;
    const inputPerM = toPerMillion(item?.pricing?.prompt);
    const outputPerM = toPerMillion(item?.pricing?.completion);
    // 两个都为 null 说明这条没有可用价格（部分模型只标了部分字段）
    if (inputPerM === null && outputPerM === null) continue;
    const price: ModelPrice = {
      inputPerM: inputPerM ?? 0,
      outputPerM: outputPerM ?? 0,
      catalogId: id,
    };
    putEntry(entries, id, price);
    putEntry(entries, normalizeModelKey(id), price);
  }
  return entries;
}

function fetchCatalog(): Promise<Map<string, ModelPrice>> {
  return new Promise((resolve, reject) => {
    const req = https.get(CATALOG_URL, { headers: { accept: 'application/json' } }, (res) => {
      const status = res.statusCode || 0;
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      let body = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new Error('catalog too large'));
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(parseCatalog(JSON.parse(body)));
        } catch (error: any) {
          reject(new Error(`catalog parse failed: ${error.message}`));
        }
      });
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('catalog timeout')));
    req.on('error', reject);
  });
}

function load(): Promise<Map<string, ModelPrice>> {
  if (inflight) return inflight;
  inflight = fetchCatalog()
    .then((entries) => {
      catalog = { at: Date.now(), ok: true, entries };
      console.log(`[ai-pricing] 定价目录已更新：${entries.size} 个索引条目`);
      return entries;
    })
    .catch((error: any) => {
      // 失败不清空旧目录：昨天拉到的价格比没有强，但把 ok 置 false 让界面能说明
      catalog = { at: Date.now(), ok: false, entries: catalog?.entries || new Map() };
      console.warn(`[ai-pricing] 定价目录拉取失败（${error.message}），档位将退化为规则推断`);
      return catalog.entries;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * 确保目录可用。
 * wait=false（默认）时只在后台触发加载，立刻返回当前状态 —— 保存配置这类
 * 用户正在等的操作不能卡在网络请求上。
 */
export async function ensureCatalog(opts?: { wait?: boolean }): Promise<boolean> {
  const fresh = catalog && Date.now() - catalog.at < (catalog.ok ? CATALOG_TTL_MS : FAIL_TTL_MS);
  if (fresh) return !!catalog!.ok;
  if (!opts?.wait) {
    void load();
    return !!catalog?.ok;
  }
  await load();
  return !!catalog?.ok;
}

/** 进程启动时预热一次，让首次保存配置就能用上目录 */
export function prefetchCatalog(): void {
  void ensureCatalog({ wait: false });
}

export function lookupPrice(provider: string, model: string): ModelPrice | null {
  const entries = catalog?.entries;
  if (!entries || !entries.size) return null;
  const raw = (model || '').trim().toLowerCase();
  if (!raw) return null;
  const candidates: string[] = [];
  if (raw.includes('/')) {
    candidates.push(raw);
  } else {
    const prefix = PROVIDER_PREFIX[(provider || '').toLowerCase()];
    if (prefix) candidates.push(`${prefix}/${raw}`);
    candidates.push(raw);
  }
  candidates.push(normalizeModelKey(raw));
  for (const key of candidates) {
    const hit = entries.get(key);
    if (hit) return hit;
  }
  return null;
}

export function getCatalogStatus(): { available: boolean; ok: boolean; ageMs: number; size: number } {
  return {
    available: !!catalog?.entries?.size,
    ok: !!catalog?.ok,
    ageMs: catalog ? Date.now() - catalog.at : -1,
    size: catalog?.entries?.size || 0,
  };
}
