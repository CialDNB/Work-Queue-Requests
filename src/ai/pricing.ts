// Pricing table for cost accounting, verified against Anthropic's published rates
// (platform.claude.com/docs/en/about-claude/pricing, 2026-09-23). Override per-app via code if
// rates change; unknown models fall back to a deliberately EXPENSIVE rate so a new model can never
// silently undercount spend.

export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
  /** "Cache hits and refreshes", per MTok. Per model: 0.1× input on most, 0.05× on Opus 5.5. */
  cacheReadPerMTok: number;
}

export const DEFAULT_RATES: Record<string, ModelRate> = {
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
};

export const FALLBACK_RATE: ModelRate = {
  inputPerMTok: 15,
  outputPerMTok: 75,
  cacheReadPerMTok: 1.5,
};

// Cache WRITES bill at a multiple of the model's input rate, by the entry's TTL — the same on
// every model. (Reads are per model, above.)
export const CACHE_WRITE_MULTIPLIER_5M = 1.25;
export const CACHE_WRITE_MULTIPLIER_1H = 2;

/** Where inference may run (`inference_geo`). 'global' is the API default; 'us' pins it. */
export type InferenceGeo = 'us' | 'global';

/** US-only inference bills 1.1× on EVERY token category — input, output, cache writes and cache
 *  reads — on the Claude 4.6+ models, the only ones that accept `inference_geo` at all. */
export const INFERENCE_GEO_US_MULTIPLIER = 1.1;

/** A tool-bearing request also pays for a tool-use system prompt the API adds: 286–589 tokens
 *  across the models the client allows (804 is the largest listed for any model). The estimate
 *  reserves this rounded-up ceiling rather than a per-model table. */
export const TOOL_USE_PROMPT_TOKENS = 1_000;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** The provider's TTL split of `cache_creation_input_tokens` (present when it reports one). */
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
}

// A provider may echo a dated snapshot id (`claude-haiku-4-5-20251001`) for an undated alias
// it was asked for. The snapshot is the same model at the same price, so price it as its base
// id rather than letting a known model fall through to the fallback rate.
const DATED_SUFFIX = /-\d{8}$/;

/** The model id with a trailing `-YYYYMMDD` snapshot date removed (unchanged otherwise). */
export function baseModelId(model: string): string {
  return model.replace(DATED_SUFFIX, '');
}

// Own keys only: the id is provider-echoed data, and a plain index would resolve
// `constructor` / `__proto__` to Object.prototype members instead of a rate.
function ownRate(id: string): ModelRate | undefined {
  return Object.hasOwn(DEFAULT_RATES, id) ? DEFAULT_RATES[id] : undefined;
}

export function rateFor(model: string): ModelRate {
  return ownRate(model) ?? ownRate(baseModelId(model)) ?? FALLBACK_RATE;
}

// A token count as the provider reported it, or 0 when the field is absent or not a finite,
// non-negative number. Absent usage already meant zero here; this extends that to a PARTIAL or
// malformed block so a NaN can never reach the budget reservation rows or the ai_usage ledger.
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The provider's usage block with every counter coerced to a finite, non-negative number. */
export function normalizeUsage(raw: unknown): TokenUsage {
  const u = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const usage: TokenUsage = {
    input_tokens: tokenCount(u.input_tokens),
    output_tokens: tokenCount(u.output_tokens),
    cache_creation_input_tokens: tokenCount(u.cache_creation_input_tokens),
    cache_read_input_tokens: tokenCount(u.cache_read_input_tokens),
  };
  const split = u.cache_creation;
  if (split && typeof split === 'object') {
    const s = split as Record<string, unknown>;
    usage.cache_creation = {
      ephemeral_5m_input_tokens: tokenCount(s.ephemeral_5m_input_tokens),
      ephemeral_1h_input_tokens: tokenCount(s.ephemeral_1h_input_tokens),
    };
  }
  return usage;
}

// Cache-write tokens by TTL. The provider reports the total and its split (the total "equals the
// sum" of the split); if the two ever disagree, the larger wins and whatever the split does not
// place at 1 hour bills at the 5-minute rate — so a malformed split can raise a price, never lower
// one below what either field reports.
function cacheWrites(usage: TokenUsage): { fiveMin: number; oneHour: number } {
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const splitTotal = oneHour + (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0);
  const total = Math.max(usage.cache_creation_input_tokens ?? 0, splitTotal);
  return { fiveMin: total - oneHour, oneHour };
}

/** Every token the call was billed for, across the same counters costUsd prices. */
export function billedTokens(usage: TokenUsage): number {
  const writes = cacheWrites(usage);
  return (
    usage.input_tokens +
    usage.output_tokens +
    writes.fiveMin +
    writes.oneHour +
    (usage.cache_read_input_tokens ?? 0)
  );
}

// Characters per token for the pre-call estimate. "Approximately 4 characters" is the documented
// rule of thumb for English on the previous tokenizer; Claude 4.7 and later use a newer one that
// "produces approximately 30% more tokens for the same text" (pricing docs, verified 2026-09-23;
// Sonnet 4.6 and earlier keep the previous one). 4 / 1.3 ≈ 3.1, so the newer tokenizer is estimated
// at 3. A model not listed here is estimated at 3 too: a model the kit does not know must never be
// estimated LOW.
const PREVIOUS_TOKENIZER: ReadonlySet<string> = new Set(['claude-sonnet-4-6', 'claude-haiku-4-5']);

/** ~Characters per token for `model`'s tokenizer: 4 on the previous one, 3 on Claude 4.7+. */
export function charsPerToken(model: string): number {
  return PREVIOUS_TOKENIZER.has(baseModelId(model)) ? 4 : 3;
}

function geoMultiplier(geo: InferenceGeo): number {
  return geo === 'us' ? INFERENCE_GEO_US_MULTIPLIER : 1;
}

/**
 * Actual cost of a completed call, rounded to micro-dollars. `geo` is where it was pinned; it
 * defaults to 'us', the kit's default pin, so a caller that forgets it over-reads a global call
 * by 10% rather than under-reading a pinned one.
 */
export function costUsd(model: string, usage: TokenUsage, geo: InferenceGeo = 'us'): number {
  const rate = rateFor(model);
  const writes = cacheWrites(usage);
  const usd =
    ((usage.input_tokens / 1_000_000) * rate.inputPerMTok +
      (writes.fiveMin / 1_000_000) * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER_5M +
      (writes.oneHour / 1_000_000) * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER_1H +
      ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * rate.cacheReadPerMTok +
      (usage.output_tokens / 1_000_000) * rate.outputPerMTok) *
    geoMultiplier(geo);
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** One piece of a prompt, in the order the provider caches it: tools, system, then messages. */
export interface PromptSegment {
  chars: number;
  /** The piece carries `cache_control` with this TTL: a cache breakpoint, and the prefix up to and
   *  including it is written to the cache (or read from it, on a hit). */
  cacheTtl?: '5m' | '1h';
}

export interface RequestEstimate {
  /** Input priced at the base rate: after the last cache breakpoint, plus the tool-use prompt. */
  inputTokens: number;
  /** Input up to the last 1-hour breakpoint, reserved as a 1-hour cache WRITE (2× input). */
  cacheWrite1hTokens: number;
  /** Input after that, up to the last breakpoint, reserved as a 5-minute cache WRITE (1.25×). */
  cacheWrite5mTokens: number;
  /** max_tokens: the whole output budget, thinking included. */
  outputTokens: number;
  /** The characters-per-token the estimate used (see charsPerToken) — also the divisor for the
   *  output floor of a stream that ends early. */
  charsPerToken: number;
  usd: number;
}

/**
 * Pre-call WORST-CASE estimate for the budget reservation, reconciled to actual after the call:
 * charsPerToken(model) on input, the full max_tokens on output. A cache-marked prefix is reserved
 * as a cache WRITE, never a read, because nothing before the call can know the cache is warm — the
 * entry may have expired (5 minutes is short next to a tool call or a user's pause), been evicted,
 * or never been written. Worst case is the provider's own billing rule with no hit (prompt-caching
 * docs, "Mixing different TTLs", verified 2026-09-23): tokens up to the last 1-hour breakpoint bill
 * as 1-hour writes (2×), tokens from there to the last breakpoint as 5-minute writes (1.25×), the
 * rest as input. A hit only lowers the actual cost, and the reconcile books the actual. Pricing the
 * prefix at the read rate instead let one call reserve $0.22 and book $7.92 — past the per-call cap
 * and the per-user day in a single request. The geo multiplier (default 'us', as in costUsd)
 * applies to all of it.
 */
export function estimateRequest(
  model: string,
  segments: readonly PromptSegment[],
  opts: { maxTokens: number; toolPromptTokens?: number; geo?: InferenceGeo },
): RequestEstimate {
  const rate = rateFor(model);
  let last1h = -1;
  let lastBreakpoint = -1;
  segments.forEach((s, i) => {
    if (s.cacheTtl === '1h') last1h = i;
    if (s.cacheTtl) lastBreakpoint = i;
  });
  let chars1h = 0;
  let chars5m = 0;
  let uncachedChars = 0;
  segments.forEach((s, i) => {
    if (i <= last1h) chars1h += s.chars;
    else if (i <= lastBreakpoint) chars5m += s.chars;
    else uncachedChars += s.chars;
  });
  const perToken = charsPerToken(model);
  const cacheWrite1hTokens = Math.ceil(chars1h / perToken);
  const cacheWrite5mTokens = Math.ceil(chars5m / perToken);
  const inputTokens = Math.ceil(uncachedChars / perToken) + (opts.toolPromptTokens ?? 0);
  const outputTokens = opts.maxTokens;
  const usd =
    ((inputTokens / 1_000_000) * rate.inputPerMTok +
      (cacheWrite1hTokens / 1_000_000) * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER_1H +
      (cacheWrite5mTokens / 1_000_000) * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER_5M +
      (outputTokens / 1_000_000) * rate.outputPerMTok) *
    geoMultiplier(opts.geo ?? 'us');
  return {
    inputTokens,
    cacheWrite1hTokens,
    cacheWrite5mTokens,
    outputTokens,
    charsPerToken: perToken,
    usd: Math.round(usd * 1_000_000) / 1_000_000,
  };
}

/**
 * Pre-call worst-case estimate for a plain-text call: charsPerToken(model) on input, full
 * max_tokens on output. Kept for callers that size a reservation from a character count; the client
 * itself uses estimateRequest, which also counts tools and structured blocks.
 */
export function estimateCallUsd(
  model: string,
  inputChars: number,
  maxTokens: number,
  geo: InferenceGeo = 'us',
): number {
  return estimateRequest(model, [{ chars: inputChars }], { maxTokens, geo }).usd;
}
