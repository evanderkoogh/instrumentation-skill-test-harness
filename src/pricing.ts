// Token pricing for the instrumentation agent, so a run's token mix can be
// collapsed to a single dollar figure. Rates are USD per 1M tokens.
//
// Opus 4.8 (claude-opus-4-8): $5 input / $25 output, cache write 1.25x (5m) /
// 2x (1h), cache read 0.1x. The 1M context window is billed at standard rates —
// there is NO long-context (>200k) premium on Opus 4.8 — so a single flat rate
// per token type is correct. Source: claude-api skill (cached 2026-06-04).
//
// Cache reads dominate spend on a long agentic run (the system prompt + skill
// content is re-sent every turn, mostly served from cache). The SDK reports
// cumulative usage per model in `modelUsage`; we price each model separately so
// a sub-agent on a cheaper tier (e.g. a Haiku Explore) is costed correctly
// rather than at Opus rates.

export interface TokenBreakdown {
  input_tokens: number; // uncached input
  output_tokens: number;
  cache_read_input_tokens: number;
  // modelUsage reports a single cache-creation figure (no 5m/1h split), so we
  // price all cache creation at the 5m rate — the SDK's default cache TTL.
  cache_creation_input_tokens: number;
}

export interface ModelRates {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number; // 5-minute ephemeral (the default TTL)
}

// Keyed by base model id (context-tier suffix like "[1m]" stripped first).
const RATES: Record<string, ModelRates> = {
  "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

export function ratesFor(model: string): ModelRates {
  const base = model.replace(/\[.*$/, ""); // "claude-opus-4-8[1m]" -> "claude-opus-4-8"
  if (RATES[base]) return RATES[base];
  if (base.startsWith("claude-haiku-")) return RATES["claude-haiku-4-5"];
  if (base.startsWith("claude-sonnet-")) return RATES["claude-sonnet-4-6"];
  return RATES["claude-opus-4-8"]; // opus-* and unknowns default to Opus-tier
}

export interface CostBreakdown {
  total_usd: number;
  input_usd: number;
  output_usd: number;
  cache_read_usd: number;
  cache_write_usd: number;
}

function emptyCost(): CostBreakdown {
  return { total_usd: 0, input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0 };
}

export function costForModel(tokens: TokenBreakdown, model: string): CostBreakdown {
  const r = ratesFor(model);
  const per = (count: number, rate: number) => (count * rate) / 1_000_000;
  const input_usd = per(tokens.input_tokens, r.input);
  const output_usd = per(tokens.output_tokens, r.output);
  const cache_read_usd = per(tokens.cache_read_input_tokens, r.cache_read);
  const cache_write_usd = per(tokens.cache_creation_input_tokens, r.cache_write);
  return {
    total_usd: input_usd + output_usd + cache_read_usd + cache_write_usd,
    input_usd,
    output_usd,
    cache_read_usd,
    cache_write_usd,
  };
}

// Sum cost across every model the run touched (the SDK's `modelUsage` map),
// pricing each model with its own rates. Returns the aggregated per-bucket
// breakdown so it always sums to total_usd.
export function costFromModelUsage(perModel: Array<{ model: string; tokens: TokenBreakdown }>): CostBreakdown {
  return perModel.reduce((acc, { model, tokens }) => {
    const c = costForModel(tokens, model);
    return {
      total_usd: acc.total_usd + c.total_usd,
      input_usd: acc.input_usd + c.input_usd,
      output_usd: acc.output_usd + c.output_usd,
      cache_read_usd: acc.cache_read_usd + c.cache_read_usd,
      cache_write_usd: acc.cache_write_usd + c.cache_write_usd,
    };
  }, emptyCost());
}
