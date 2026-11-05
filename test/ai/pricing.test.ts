import { describe, expect, it } from 'vitest';
import {
  baseModelId,
  billedTokens,
  CACHE_WRITE_MULTIPLIER_1H,
  CACHE_WRITE_MULTIPLIER_5M,
  charsPerToken,
  costUsd,
  DEFAULT_RATES,
  estimateCallUsd,
  estimateRequest,
  FALLBACK_RATE,
  INFERENCE_GEO_US_MULTIPLIER,
  normalizeUsage,
  rateFor,
  TOOL_USE_PROMPT_TOKENS,
} from '../../src/ai/pricing';

describe('AI pricing', () => {
  it('pins the whole rate table — a rate or model change must update this test on purpose', () => {
    // Literal on purpose: every budget cap and cost report downstream is sized against these.
    // Each row is the docs' "Base input / Cache hits and refreshes / Output" columns, per MTok.
    expect(DEFAULT_RATES).toEqual({
      'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
      'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
      'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
      'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
      'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
      'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
    });
    expect(FALLBACK_RATE).toEqual({ inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5 });
    expect(CACHE_WRITE_MULTIPLIER_5M).toBe(1.25);
    expect(CACHE_WRITE_MULTIPLIER_1H).toBe(2);
    expect(INFERENCE_GEO_US_MULTIPLIER).toBe(1.1);
  });

  it('prices sonnet-5 at $2/$10 and opus-5 at $5/$25 per MTok (not the fallback)', () => {
    expect(
      costUsd('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 0 }, 'global'),
    ).toBe(2);
    expect(
      costUsd('claude-sonnet-5', { input_tokens: 0, output_tokens: 1_000_000 }, 'global'),
    ).toBe(10);
    expect(costUsd('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 0 }, 'global')).toBe(
      5,
    );
    expect(costUsd('claude-opus-5', { input_tokens: 0, output_tokens: 1_000_000 }, 'global')).toBe(
      25,
    );
  });

  it('prices a dated snapshot echo as its base model', () => {
    expect(rateFor('claude-haiku-4-5-20251001')).toEqual(DEFAULT_RATES['claude-haiku-4-5']);
    expect(rateFor('claude-sonnet-5-20260915')).toEqual(DEFAULT_RATES['claude-sonnet-5']);
    expect(
      costUsd('claude-opus-5-20260101', { input_tokens: 0, output_tokens: 1_000_000 }, 'global'),
    ).toBe(25);
  });

  it('strips only a trailing 8-digit date — anything else unknown still bills at the fallback', () => {
    for (const id of [
      'claude-future-9-20260101', // dated, but the base is unknown
      'claude-sonnet-5-2026', // not a full date
      'claude-sonnet-5-202609151', // nine digits
      'claude-sonnet-5-20260915-20260915', // stripped once only
      'claude-sonnet-5-20260915-preview', // date not at the end
      'claude-sonnet-5x', // near-miss id
      '',
    ]) {
      expect(rateFor(id), id).toEqual(FALLBACK_RATE);
    }
    expect(baseModelId('claude-sonnet-5-20260915')).toBe('claude-sonnet-5');
    expect(baseModelId('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(baseModelId('claude-sonnet-5-2026')).toBe('claude-sonnet-5-2026');
  });

  it('never resolves a prototype key to a rate (the model id is provider-echoed data)', () => {
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty-20260101']) {
      expect(rateFor(id), id).toEqual(FALLBACK_RATE);
      expect(costUsd(id, { input_tokens: 1_000_000, output_tokens: 0 }, 'global'), id).toBe(15);
    }
  });

  it('prices sonnet-4-6 at $3/$15 per MTok', () => {
    expect(
      costUsd('claude-sonnet-4-6', { input_tokens: 1_000_000, output_tokens: 0 }, 'global'),
    ).toBe(3);
    expect(
      costUsd('claude-sonnet-4-6', { input_tokens: 0, output_tokens: 1_000_000 }, 'global'),
    ).toBe(15);
  });

  it('prices opus-4-8 at $5/$25 per MTok', () => {
    expect(
      costUsd('claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'global'),
    ).toBe(30);
  });

  it('prices an unsplit cache write at the 5-minute rate (1.25×) and reads at the model rate', () => {
    const usd = costUsd(
      'claude-sonnet-4-6',
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      },
      'global',
    );
    expect(usd).toBeCloseTo(3 * 1.25 + 3 * 0.1, 6);
  });

  it('unknown models fall back to an expensive rate (never undercounts)', () => {
    expect(rateFor('claude-future-9')).toEqual(FALLBACK_RATE);
    expect(
      costUsd('claude-future-9', { input_tokens: 1_000_000, output_tokens: 0 }, 'global'),
    ).toBe(15);
  });

  it('estimates conservatively: chars/4 input on the previous tokenizer + full max_tokens output', () => {
    const est = estimateCallUsd('claude-sonnet-4-6', 4_000_000, 1_000_000, 'global');
    expect(est).toBeCloseTo(3 + 15, 6);
  });

  it('reserves sonnet-5 at its own rate, not the $15/$75 fallback', () => {
    // 3 chars per token on the Claude 4.7+ tokenizer: 3M chars = 1M input tokens.
    expect(estimateCallUsd('claude-sonnet-5', 3_000_000, 1_000_000, 'global')).toBeCloseTo(
      2 + 10,
      6,
    );
  });
});

describe('AI usage normalization', () => {
  it('keeps every well-formed counter as reported', () => {
    const usage = {
      input_tokens: 1200,
      output_tokens: 340,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 7,
    };
    expect(normalizeUsage(usage)).toEqual(usage);
  });

  it('reads an absent or non-object usage block as all zeros', () => {
    const zeros = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    for (const raw of [undefined, null, 'usage', 42, []]) {
      expect(normalizeUsage(raw), JSON.stringify(raw)).toEqual(zeros);
    }
  });

  it('coerces a missing, non-numeric, negative or non-finite counter to 0 — never NaN', () => {
    const usage = normalizeUsage({
      input_tokens: '1000',
      output_tokens: Number.NaN,
      cache_creation_input_tokens: Number.POSITIVE_INFINITY,
      cache_read_input_tokens: -3,
    });
    expect(usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    const partial = normalizeUsage({ output_tokens: 20 });
    expect(partial.input_tokens).toBe(0);
    expect(costUsd('claude-sonnet-5', partial, 'global')).toBeCloseTo(0.0002, 6);
  });

  it('billedTokens sums the same four counters costUsd prices', () => {
    expect(
      billedTokens({
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      }),
    ).toBe(10);
    // A cache-read-only call is billed (0.1× input) even though it rounds to $0 at micro-dollar
    // precision — which is why the refusal branch counts tokens rather than testing cost > 0.
    const cacheOnly = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1 };
    expect(billedTokens(cacheOnly)).toBe(1);
    expect(costUsd('claude-haiku-4-5', cacheOnly, 'global')).toBe(0);
    expect(billedTokens({ input_tokens: 0, output_tokens: 0 })).toBe(0);
  });
});

describe('AI pricing — cache TTLs, per-model cache reads, inference geo', () => {
  const M = 1_000_000;

  it('bills 1-hour cache writes at 2× and 5-minute writes at 1.25× the input rate, from the split', () => {
    const usd = costUsd(
      'claude-sonnet-4-6',
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 2 * M,
        cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M },
      },
      'global',
    );
    expect(usd).toBeCloseTo(3 * 1.25 + 3 * 2, 6);
  });

  it('a malformed split can raise a price, never lower it below either field', () => {
    // Total larger than the split: the unplaced remainder bills at the 5-minute rate.
    const underSplit = costUsd(
      'claude-sonnet-4-6',
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 3 * M,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M },
      },
      'global',
    );
    expect(underSplit).toBeCloseTo(3 * 2 + 2 * 3 * 1.25, 6);
    // Split larger than the total: the split wins.
    const overSplit = costUsd(
      'claude-sonnet-4-6',
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M },
      },
      'global',
    );
    expect(overSplit).toBeCloseTo(3 * 1.25 + 3 * 2, 6);
    expect(
      billedTokens({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5 },
      }),
    ).toBe(5);
  });

  it('reads the cache at a per-model rate — 0.05× on Opus 5.5, 0.1× elsewhere', () => {
    const read = (model: string) =>
      costUsd(model, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: M }, 'global');
    expect(read('claude-opus-5-5')).toBeCloseTo(0.2, 6); // 0.05 × $4
    expect(read('claude-sonnet-5')).toBeCloseTo(0.2, 6); // 0.1 × $2
    expect(read('claude-opus-5')).toBeCloseTo(0.5, 6);
    expect(read('claude-sonnet-4-6')).toBeCloseTo(0.3, 6);
    expect(read('claude-opus-4-8')).toBeCloseTo(0.5, 6);
    expect(read('claude-haiku-4-5')).toBeCloseTo(0.1, 6);
    expect(read('claude-future-9')).toBeCloseTo(1.5, 6); // fallback stays expensive
  });

  it('prices Opus 5.5 at $4/$20 with $5 / $8 cache writes (1.25× / 2×)', () => {
    expect(costUsd('claude-opus-5-5', { input_tokens: M, output_tokens: M }, 'global')).toBe(24);
    expect(
      costUsd(
        'claude-opus-5-5',
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 2 * M,
          cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M },
        },
        'global',
      ),
    ).toBe(13);
  });

  it('applies the 1.1× us multiplier to every category — input, output, writes and reads', () => {
    const usage = {
      input_tokens: M,
      output_tokens: M,
      cache_read_input_tokens: M,
      cache_creation_input_tokens: 2 * M,
      cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M },
    };
    // sonnet-5: 2 in + 10 out + 0.2 read + 2.5 (5m) + 4 (1h) = 18.7
    expect(costUsd('claude-sonnet-5', usage, 'global')).toBeCloseTo(18.7, 6);
    expect(costUsd('claude-sonnet-5', usage, 'us')).toBeCloseTo(18.7 * 1.1, 6);
    // One category at a time, so no category can be left out of the multiplier unseen.
    for (const only of [
      { input_tokens: M, output_tokens: 0 },
      { input_tokens: 0, output_tokens: M },
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: M },
      { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: M },
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: M,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M },
      },
    ]) {
      const base = costUsd('claude-opus-4-8', only, 'global');
      expect(base, JSON.stringify(only)).toBeGreaterThan(0);
      expect(costUsd('claude-opus-4-8', only, 'us'), JSON.stringify(only)).toBeCloseTo(
        base * 1.1,
        6,
      );
    }
  });

  it('prices and estimates at the kit default pin, "us", when no geo is passed — never 10% low', () => {
    // The client always passes the region it pinned; a fork calling these helpers directly and
    // forgetting the geo must over-read a global call, not under-read a pinned one.
    const usage = { input_tokens: M, output_tokens: M };
    expect(costUsd('claude-opus-4-8', usage)).toBe(costUsd('claude-opus-4-8', usage, 'us'));
    expect(costUsd('claude-opus-4-8', usage)).toBeCloseTo(30 * 1.1, 6);
    expect(estimateCallUsd('claude-sonnet-4-6', 4 * M, M)).toBe(
      estimateCallUsd('claude-sonnet-4-6', 4 * M, M, 'us'),
    );
    expect(estimateRequest('claude-sonnet-5', [{ chars: 3 * M }], { maxTokens: M }).usd).toBe(
      estimateRequest('claude-sonnet-5', [{ chars: 3 * M }], { maxTokens: M, geo: 'us' }).usd,
    );
  });

  it('normalizes the provider cache split, and leaves it out when not reported', () => {
    expect(
      normalizeUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 'x' },
      }).cache_creation,
    ).toEqual({ ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 });
    expect(normalizeUsage({ input_tokens: 1, output_tokens: 2 })).not.toHaveProperty(
      'cache_creation',
    );
    expect(normalizeUsage({ cache_creation: null })).not.toHaveProperty('cache_creation');
  });
});

describe('AI pricing — request estimator', () => {
  const M = 1_000_000;

  it('reserves a cache-marked prefix as a cache WRITE — never a read — with the rest at the input rate', () => {
    // sonnet-4-6: input $3, output $15 per MTok; 5-minute writes 1.25×. The cache may be cold (a
    // first round, an expired entry, an eviction), and nothing before the call can know otherwise.
    const est = estimateRequest(
      'claude-sonnet-4-6',
      [
        { chars: 400_000, cacheTtl: '5m' }, // tools
        { chars: 400_000 }, // system
        { chars: 400_000, cacheTtl: '5m' }, // an old message — the last breakpoint
        { chars: 400_000 }, // the new message
      ],
      { maxTokens: 100_000, geo: 'global' },
    );
    expect(est.cacheWrite5mTokens).toBe(300_000);
    expect(est.cacheWrite1hTokens).toBe(0);
    expect(est.inputTokens).toBe(100_000);
    expect(est.outputTokens).toBe(100_000);
    expect(est.usd).toBeCloseTo(0.3 * 3 * 1.25 + 0.1 * 3 + 0.1 * 15, 6);
  });

  it('splits the prefix by TTL the way the provider bills a miss: 2× to the last 1-hour breakpoint, 1.25× after', () => {
    // opus-5-5: input $4 per MTok. 1h writes $8, 5m writes $5 (prompt-caching docs, "Mixing
    // different TTLs": 1-hour writes for (B - A), 5-minute writes for (C - B), with A = 0 on a miss).
    const est = estimateRequest(
      'claude-opus-5-5',
      [
        { chars: 300_000, cacheTtl: '1h' }, // tools, 1h (3 chars per token on this model)
        { chars: 300_000, cacheTtl: '1h' }, // system, 1h — B
        { chars: 300_000, cacheTtl: '5m' }, // transcript, 5m — C
        { chars: 300_000 }, // the new message
      ],
      { maxTokens: 0, geo: 'global' },
    );
    expect(est.cacheWrite1hTokens).toBe(200_000);
    expect(est.cacheWrite5mTokens).toBe(100_000);
    expect(est.inputTokens).toBe(100_000);
    expect(est.usd).toBeCloseTo(0.2 * 8 + 0.1 * 5 + 0.1 * 4, 6);
  });

  it('a breakpoint can never make the reservation smaller than the same prompt unmarked', () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-future-9',
    ]) {
      const plain = estimateRequest(model, [{ chars: 4 * M }, { chars: 400 }], {
        maxTokens: 1000,
        geo: 'global',
      });
      for (const ttl of ['5m', '1h'] as const) {
        const marked = estimateRequest(model, [{ chars: 4 * M, cacheTtl: ttl }, { chars: 400 }], {
          maxTokens: 1000,
          geo: 'global',
        });
        expect(marked.usd, `${model} ${ttl}`).toBeGreaterThan(plain.usd);
      }
    }
  });

  it('with no breakpoint everything is input; the tool-use prompt is added at the input rate', () => {
    const est = estimateRequest('claude-sonnet-5', [{ chars: 3_000 }], {
      maxTokens: 0,
      toolPromptTokens: TOOL_USE_PROMPT_TOKENS,
      geo: 'global',
    });
    expect(est.cacheWrite5mTokens + est.cacheWrite1hTokens).toBe(0);
    expect(est.inputTokens).toBe(1_000 + TOOL_USE_PROMPT_TOKENS);
    expect(est.usd).toBeCloseTo((2_000 / M) * 2, 6);
  });

  it('applies the us multiplier to the whole estimate', () => {
    const segments = [{ chars: 3 * M, cacheTtl: '5m' as const }, { chars: 3 * M }];
    const global = estimateRequest('claude-opus-4-8', segments, { maxTokens: M, geo: 'global' });
    const us = estimateRequest('claude-opus-4-8', segments, { maxTokens: M, geo: 'us' });
    expect(global.usd).toBeCloseTo(6.25 + 5 + 25, 6);
    expect(us.usd).toBeCloseTo((6.25 + 5 + 25) * 1.1, 6);
  });

  it('rounds tokens UP, so a sliver of text is never a free token', () => {
    expect(
      estimateRequest('claude-sonnet-5', [{ chars: 1 }], { maxTokens: 0, geo: 'global' })
        .inputTokens,
    ).toBe(1);
  });

  it('counts ~3 chars per token on the Claude 4.7+ tokenizer and ~4 on the previous one', () => {
    // The pricing docs: Claude 4.7 and later "produce approximately 30% more tokens for the same
    // text"; Sonnet 4.6 and earlier keep the previous tokenizer.
    for (const model of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
      expect(charsPerToken(model), model).toBe(4);
    }
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-future-9', // unknown: never estimated low
      'constructor',
    ]) {
      expect(charsPerToken(model), model).toBe(3);
    }
    const text = [{ chars: 12_000 }];
    expect(
      estimateRequest('claude-sonnet-4-6', text, { maxTokens: 0, geo: 'global' }).inputTokens,
    ).toBe(3_000);
    expect(
      estimateRequest('claude-sonnet-5', text, { maxTokens: 0, geo: 'global' }).inputTokens,
    ).toBe(4_000);
    expect(
      estimateRequest('claude-sonnet-5', text, { maxTokens: 0, geo: 'global' }).charsPerToken,
    ).toBe(3);
  });

  it('estimateCallUsd is the one-segment, no-breakpoint case (and takes a geo)', () => {
    expect(estimateCallUsd('claude-sonnet-4-6', 4 * M, M, 'global')).toBe(
      estimateRequest('claude-sonnet-4-6', [{ chars: 4 * M }], { maxTokens: M, geo: 'global' }).usd,
    );
    expect(estimateCallUsd('claude-sonnet-4-6', 4 * M, M, 'us')).toBeCloseTo((3 + 15) * 1.1, 6);
  });
});
