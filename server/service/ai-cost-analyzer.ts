/**
 * 成本档位分析：把「这个模型该算第几档」从用户手工填写变成可推导的结果。
 *
 * 为什么必须自动：costTier 默认是 3，用户配了四个模型却都没改，就是四个 3。
 * auto 路由在「离目标档同样远」时按 sort_order 取第一个，于是永远只用同一个模型 ——
 * 界面上照样显示「自动」，省 token 的能力完全失效，而且看不出异常。
 *
 * 两套依据，优先级从高到低：
 * 1) 定价目录（ai-pricing）：拿到单价就按「你自己这套配置里的相对排位」分档。
 *    用相对排位而不是绝对阈值，是因为厂商一降价绝对阈值全体错档；
 *    相对排位永远回答的是「你手上这几个谁更便宜」，这才是 auto 需要的语义。
 * 2) 模型名规则：目录里查不到（自建网关、私有部署、改名）时按族名兜底。
 *    规则只做粗分，命中不了就保持原值 —— 猜错档位会让 auto 把贵模型当便宜用，
 *    还不如不动。
 */
import { ensureCatalog, lookupPrice, blendedPrice } from './ai-pricing';

export interface CostTierInput {
  id: string;
  label: string;
  provider: string;
  model: string;
  enabled: boolean;
  costTier: number;
  costTierSource: 'auto' | 'manual';
  /** 美元 / 1M token */
  priceIn?: number | null;
  priceOut?: number | null;
}

export interface TierDecision {
  id: string;
  tier: number;
  priceIn: number | null;
  priceOut: number | null;
  /** catalog=定价目录推断，rule=模型名规则，unchanged=无法判断保留原值 */
  basis: 'catalog' | 'rule' | 'unchanged';
  detail: string;
}

export interface CostCheckupIssue {
  code: 'no-usable-model' | 'single-model' | 'uniform-tier' | 'no-cheap-model' | 'missing-price';
  severity: 'warn' | 'info';
  modelIds: string[];
}

export interface CostAnalysisResult {
  decisions: TierDecision[];
  issues: CostCheckupIssue[];
  catalog: { available: boolean; ok: boolean; matched: number };
}

/**
 * 模型名规则表。顺序即优先级，先便宜的再贵的，最后才是中间档：
 * `gpt-4o-mini` 必须在 `gpt-4o` 之前命中，否则会按 4o 的档位走。
 */
const NAME_RULES: Array<{ tier: number; pattern: RegExp; tag: string }> = [
  { tier: 1, pattern: /\b(mini|nano|flash|haiku|lite|tiny|free)\b/, tag: 'tiny' },
  { tier: 2, pattern: /\b(turbo|small|instant|spark|air|chat|instruct|standard)\b/, tag: 'light' },
  { tier: 5, pattern: /\b(opus|o3-pro|o1-pro|ultra|405b)\b/, tag: 'flagship' },
  { tier: 4, pattern: /\b(o1|o3|o4|pro|max|large|reasoner|thinking|70b)\b/, tag: 'heavy' },
  { tier: 3, pattern: /\b(sonnet|4o|4\.1|plus|medium|advanced)\b/, tag: 'balanced' },
];

function clampTier(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.round(value)));
}

function tierFromName(model: string): { tier: number; tag: string } | null {
  const name = (model || '').toLowerCase();
  if (!name) return null;
  for (const rule of NAME_RULES) {
    if (rule.pattern.test(name)) return { tier: rule.tier, tag: rule.tag };
  }
  return null;
}

/**
 * 按单价分位映射到 1-5。
 * 只有一种价格时给 3（中性）：全一样贵/全一样便宜的情况下，
 * 说哪个是「最便宜」没有意义。
 */
function assignTiersByPrice(items: Array<{ id: string; blend: number }>): Map<string, number> {
  const result = new Map<string, number>();
  if (!items.length) return result;
  const levels = Array.from(new Set(items.map((item) => item.blend))).sort((a, b) => a - b);
  for (const item of items) {
    if (levels.length === 1) {
      result.set(item.id, 3);
      continue;
    }
    const rank = levels.indexOf(item.blend);
    result.set(item.id, clampTier(1 + Math.round((rank / (levels.length - 1)) * 4)));
  }
  return result;
}

/**
 * 分析一组配置。
 *
 * @param opts.waitForCatalog 是否等待定价目录拉取完成。
 *   保存配置时为 false（不能把用户卡在网络上，用当前已缓存的目录 + 规则），
 *   用户主动点「重新分析」时为 true（这时他就是要一个准的结果）。
 */
export async function analyzeProfiles(
  profiles: CostTierInput[],
  opts?: { waitForCatalog?: boolean },
): Promise<CostAnalysisResult> {
  const catalogOk = await ensureCatalog({ wait: opts?.waitForCatalog });

  const priced: Array<{ id: string; blend: number; priceIn: number; priceOut: number; catalogId: string }> = [];
  const decisions: TierDecision[] = [];

  for (const profile of profiles) {
    const price = lookupPrice(profile.provider, profile.model);
    if (price) {
      priced.push({
        id: profile.id,
        blend: blendedPrice(price),
        priceIn: price.inputPerM,
        priceOut: price.outputPerM,
        catalogId: price.catalogId,
      });
      continue;
    }
    const byName = tierFromName(profile.model);
    decisions.push({
      id: profile.id,
      tier: byName ? byName.tier : clampTier(profile.costTier),
      priceIn: profile.priceIn ?? null,
      priceOut: profile.priceOut ?? null,
      basis: byName ? 'rule' : 'unchanged',
      detail: byName ? `rule:${byName.tag}` : 'keep',
    });
  }

  const byPrice = assignTiersByPrice(priced.map((p) => ({ id: p.id, blend: p.blend })));
  for (const item of priced) {
    // 只有一个模型有价时算不出「谁更便宜」，分位会把它硬塞成 3 档；
    // 这时退回模型名规则，比给一个没有依据的中间档更有用。
    const byName = priced.length >= 2 ? null : tierFromName(profiles.find((p) => p.id === item.id)?.model || '');
    decisions.push({
      id: item.id,
      tier: byName ? byName.tier : byPrice.get(item.id) ?? 3,
      priceIn: item.priceIn,
      priceOut: item.priceOut,
      basis: byName ? 'rule' : 'catalog',
      detail: byName ? `rule:${byName.tag}` : `catalog:${item.catalogId}`,
    });
  }

  return {
    decisions,
    issues: checkupProfiles(profiles, decisions),
    catalog: { available: catalogOk, ok: catalogOk, matched: priced.length },
  };
}

/**
 * 配置体检：只做纯计算，回答「这套配置能不能真的省钱」。
 * 这些问题光看设置页是看不出来的 —— 每个模型都显示着自己的档位，看起来很正常。
 */
export function checkupProfiles(profiles: CostTierInput[], decisions: TierDecision[]): CostCheckupIssue[] {
  const issues: CostCheckupIssue[] = [];
  const usable = profiles.filter((p) => p.enabled && p.model);
  if (!usable.length) {
    issues.push({ code: 'no-usable-model', severity: 'warn', modelIds: [] });
    return issues;
  }

  const tierOf = new Map(decisions.map((d) => [d.id, d.tier]));
  const usableTiers = usable.map((p) => tierOf.get(p.id) ?? p.costTier);

  if (usable.length === 1) {
    issues.push({ code: 'single-model', severity: 'warn', modelIds: usable.map((p) => p.id) });
  }
  if (usable.length >= 2 && new Set(usableTiers).size === 1) {
    issues.push({ code: 'uniform-tier', severity: 'warn', modelIds: usable.map((p) => p.id) });
  }
  if (Math.min(...usableTiers) >= 3) {
    issues.push({ code: 'no-cheap-model', severity: 'info', modelIds: usable.map((p) => p.id) });
  }
  const missing = decisions.filter((d) => d.priceIn === null && d.priceOut === null && usable.some((p) => p.id === d.id));
  if (missing.length) {
    issues.push({ code: 'missing-price', severity: 'info', modelIds: missing.map((d) => d.id) });
  }
  return issues;
}

/** 一次调用的金额（美元）。单价未知返回 null，调用方负责显示「未知」而不是 0 */
export function estimateCostUsd(
  tokens: { promptTokens?: number; completionTokens?: number },
  price: { priceIn?: number | null; priceOut?: number | null },
): number | null {
  const priceIn = price.priceIn;
  const priceOut = price.priceOut;
  if (priceIn === null || priceIn === undefined || priceOut === null || priceOut === undefined) return null;
  const prompt = Math.max(0, tokens.promptTokens || 0);
  const completion = Math.max(0, tokens.completionTokens || 0);
  // 单价是「美元 / 1M token」
  return (prompt * priceIn + completion * priceOut) / 1e6;
}
