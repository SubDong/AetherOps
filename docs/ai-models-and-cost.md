# AI Models, Auto Routing and Cost Control

**English** · [简体中文](./ai-models-and-cost.zh.md)

Two profiles can differ in every dimension that matters here — provider, endpoint, model, key,
temperature — and AetherOps treats model selection as an operational decision with a price tag, not
a dropdown.

- [Provider profiles](#provider-profiles)
- [Choosing a model: `auto`](#choosing-a-model-auto)
- [Cost tiers and how they are assigned](#cost-tiers-and-how-they-are-assigned)
- [The pricing catalog](#the-pricing-catalog)
- [Usage accounting](#usage-accounting)
- [Budgets](#budgets)
- [Cost insights and the "saved" number](#cost-insights-and-the-saved-number)
- [Non-agent chat](#non-agent-chat)
- [Design notes for contributors](#design-notes-for-contributors)

## Provider profiles

Each account keeps its own set of profiles in `ai_config` (primary key `(owner_id, id)`), each with
provider, base URL, model name, API key, temperature, max tokens, `enabled`, `sort_order`,
`cost_tier`, `cost_tier_source`, `price_in`, `price_out`.

Providers offered in the UI: **OpenAI**, **Anthropic (Claude)**, **Tencent**, **Azure OpenAI**, and
**Custom**. "Custom" means you paste any OpenAI-compatible base URL and model name — that is how
DeepSeek, Qwen, vLLM/Ollama gateways, or an internal proxy get used. Keys are encrypted at rest
(`enc:v1:` AES-256-GCM, key in the data directory) and never returned to a non-owner view.

**Test** on a profile performs a real completion, so a typo in the base URL is caught before you
burn a turn on it.

## Choosing a model: `auto`

The model picker includes a virtual entry `auto` (`AUTO_MODEL_ID`); it is not a row in `ai_config`.
When a turn runs in `auto` mode, the server scores the request locally and maps the score onto one
of your profiles' cost tiers.

```
tier = clamp(1 + min(score, 4), 1, 5)
```

Score signals (each contributes 1–2 points, additive):

| Reason tag | Trigger |
|------------|---------|
| `long-prompt` / `medium-prompt` | Instruction length — long instructions usually mean multi-step work |
| `has-code` | Message contains a code block or script |
| `wants-action` | Verbs asking the agent to *do* something rather than explain it |
| `troubleshooting` | Error / exception / failure vocabulary |
| `large-context` | Long terminal output attached |
| `deep-tool-chain` | This session already made several tool calls |
| `long-conversation` | Many stored history messages |
| `short-question` | Nothing matched → tier 1, the cheapest profile |

Profile selection then minimizes `|profile.costTier − targetTier| + healthPenalty`, with ties broken
toward the **cheaper** profile. The chosen profile, score and reasons are logged
(`tier=3 score=4 pick=... reasons=...`) and surfaced so you can see why a model ran.

**Health penalty** uses measured per-model success from recent `ai_usage` rows: with at least 5
samples, a model that keeps failing is pushed away from the pick. Below 5 samples no penalty applies,
because one failure would otherwise mean "100 % failure rate".

Deliberately **not** implemented: "ask a small model which model to use". That costs an extra API
call, and the call usually costs more than the tokens it saves. Routing here has zero added calls.

## Cost tiers and how they are assigned

`cost_tier` is 1 (cheapest) … 5 (strongest), and `cost_tier_source` records who decided it:
`auto` (derived) or `manual` (you set it). That column exists because without it, every save would
overwrite a tier you intentionally pinned.

Tier derivation (`ai-cost-analyzer.ts`), highest priority first:

1. **Pricing catalog** — if the profile has (or can look up) a price, rank it *relative to your other
   profiles*. Relative ranking is the point: absolute thresholds go stale the moment a vendor cuts
   prices, while `auto` only needs to know "which of the ones you own is cheaper".
2. **Model-name rules** — coarse family heuristics for gateways/private deployments that are not in
   the catalog.
3. **Unchanged** — if neither applies, the existing value stays. A guessed tier makes `auto` spend
   money on the wrong model, which is worse than no tier.

If you configure four models and never set tiers, they all sit at the default 3, and `auto` then
always resolves to the same one (first by `sort_order` among equally distant targets) — the UI would
say "auto" while saving nothing. That silent failure is exactly what this derivation exists to
prevent.

## The pricing catalog

`server/service/ai-pricing.ts` fetches the public OpenRouter model catalog
(`https://openrouter.ai/api/v1/models`, no API key) and extracts input/output price per 1M tokens.

Three rules it obeys, which matter if you operate in a restricted network:

1. **It never blocks the main flow.** Offline, blocked or timeout → empty catalog, tiers degrade to
   name rules, and costs display as *unknown* rather than zero. An invented cost is worse than none.
2. **Cache 24 h on success, 5 min on failure**, so saving a profile does not hit the network every
   time.
3. **Name collisions resolve to the more expensive entry** — estimates should err on the high side,
   or you will believe you are saving money.

Timeout is 8 s, response capped at 8 MB, provider prefixes map your provider onto catalog IDs
(Azure shares OpenAI's naming; `custom` matches by model name). Outbound request: see
[README § Network egress](../README.md#network-egress--privacy).

## Usage accounting

Every completed LLM call writes one `ai_usage` row:

| Column | Meaning |
|--------|---------|
| `owner_id`, `chat_id`, `connection_id` | Who, which conversation, which host it was working on |
| `model_id`, `model_label` | Which profile ran |
| `auto_routed` | Whether `auto` picked it (so you can measure what auto actually did) |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | From the provider's `usage` in the `done` event |
| `cost_usd` | Computed **at write time** from the price of that moment |
| `ok` | Failures are recorded too — that is what feeds the health penalty |

Details that are intentional:

- A successful call with no `usage` in the response is **not** recorded: a 0-token row drags averages
  down and makes "savings" meaningless.
- Cost is frozen at write time. Vendor prices change; the history of what you actually paid should
  not change with them.
- If a profile's stored price is null (catalog was not loaded when it was saved), pricing is looked
  up again in the in-memory catalog at write time, so the panel does not report a bogus $0.
- Recording failures are swallowed with a warning. Bookkeeping problems must not break your chat.

## Budgets

One `ai_budget` row per account, three caps, `0` = unlimited:

| Cap | Checked against | Failure code |
|-----|-----------------|--------------|
| `chatTokenLimit` | total tokens for this chat | `chat-token-limit` |
| `dailyTokenLimit` | total tokens since local midnight | `daily-token-limit` |
| `dailyCostLimit` | USD cost since local midnight | `daily-cost-limit` |

The check runs **before** the call, and exceeding a cap emits an explicit error event to the UI
(with the numbers, e.g. `(182340/200000)`) instead of silently truncating. If the budget row cannot be
read, the turn is allowed and a warning is logged — a broken budget table should not take the AI
feature down.

If you want per-day *notifications* rather than a hard cap, that is not implemented; watch the cost
panel or query `ai_usage`.

## Cost insights and the "saved" number

The insights endpoint (`getCostInsights`) returns:

- today's totals and `byModel` breakdown for the day,
- the current chat's totals,
- the account's budget row,
- `baselineModel` — the **most expensive priced profile you own**,
- `savedUsd` — `(same tokens at the baseline price) − (actual spend today)`, i.e. "what would this
  day have cost if every turn had gone to your priciest model",
- `partial` — true when some calls had no known price. Treat today's total as a **floor**, not an
  exact figure; the UI must say so instead of presenting an under-estimate as fact.

## Non-agent chat

Plain Q&A (`chat()` — no tools) resolves a profile by preference: your requested model if it is
usable, otherwise the **cheapest available** by tier. A chat that is only explaining something has no
business spending tier-5 money.

## Design notes for contributors

- Routing logic is local, deterministic and explainable. Keep the reason list intact — an `auto`
  mode the user cannot audit is indistinguishable from a broken one.
- Never substitute `0` for an unknown price, and never silently pick a tier.
- New models/providers: extend the provider→catalog-prefix map in `ai-pricing.ts` rather than
  hard-coding prices in the UI. Prices belong to the catalog lookup path so they expire with it.
- If you add another per-call side effect, do it after the response is forwarded and swallow its
  errors. The user's turn matters more than the accounting.
