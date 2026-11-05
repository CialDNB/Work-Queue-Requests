// PIA C6: every model call is pinned to an inference region, and a model that cannot take the pin
// is refused before anything is reserved or sent. See src/ai/policy.ts.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAnthropic, effortFor, type Fetcher } from '../../src/ai/anthropic';
import { todayUtc } from '../../src/ai/budget';
import { ALLOWED_MODELS, inferenceGeoFor, modelPolicy } from '../../src/ai/policy';
import {
  isAllowedModel,
  ALLOWED_MODELS as MODEL_TABLE,
  resolveInferenceGeo,
} from '../../src/ai/policyVocabulary.mjs';
import { DEFAULT_RATES } from '../../src/ai/pricing';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { loggedEvents } from '../helpers/logs';

const gatewayEnv = (over: Partial<Env> = {}): Env => ({
  ...env,
  ANTHROPIC_API_KEY: 'sk-ant-test-synthetic',
  AI_GATEWAY_ID: 'all-pr-apps',
  AI_GATEWAY_TOKEN: 'gw-test-token',
  CF_ACCOUNT_ID: 'acct-test-123',
  ...over,
});

const reply = (fields: Record<string, unknown> = {}): Response =>
  Response.json({
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1000, output_tokens: 500 },
    stop_reason: 'end_turn',
    ...fields,
  });

/** One call; returns the parsed wire body (or throws what the client threw). */
async function wireBody(testEnv: Env, model?: string): Promise<Record<string, unknown>> {
  let raw = '';
  await callAnthropic(
    testEnv,
    USERS.member,
    { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, model },
    async (_url, init) => {
      raw = init.body as string;
      return reply(model ? { model } : {});
    },
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

async function reserved(): Promise<[number, number]> {
  const repo = makeDb(env).aiBudget;
  return [
    await repo.reservedToday(`u:${USERS.member}`, todayUtc()),
    await repo.reservedToday('g', todayUtc()),
  ];
}

describe('inference_geo — pinned on every call', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  it('sends inference_geo "us" by default, through the gateway', async () => {
    expect((await wireBody(gatewayEnv())).inference_geo).toBe('us');
  });

  it('sends it on the dev direct route too — the region does not depend on the gateway', async () => {
    const direct: Env = { ...env, ANTHROPIC_API_KEY: 'sk-ant-test-synthetic' };
    expect((await wireBody(direct)).inference_geo).toBe('us');
  });

  it('sends it for every allowed model', async () => {
    for (const model of Object.keys(ALLOWED_MODELS)) {
      expect((await wireBody(gatewayEnv(), model)).inference_geo, model).toBe('us');
    }
  });

  it('an empty AI_INFERENCE_GEO is the default, not a way to drop the pin', async () => {
    expect((await wireBody(gatewayEnv({ AI_INFERENCE_GEO: '' }))).inference_geo).toBe('us');
    expect(inferenceGeoFor(gatewayEnv({ AI_INFERENCE_GEO: undefined }))).toBe('us');
  });

  it('AI_INFERENCE_GEO "global" is sent explicitly and priced at the standard rate', async () => {
    const testEnv = gatewayEnv({ AI_INFERENCE_GEO: 'global' });
    expect((await wireBody(testEnv)).inference_geo).toBe('global');
    await seedDb();
    const result = await callAnthropic(
      testEnv,
      USERS.member,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      async () => reply(),
    );
    expect(result.costUsd).toBeCloseTo(0.0105, 6); // 1000 in @ $3/M + 500 out @ $15/M, no 1.1×
  });

  it('prices a "us" call at 1.1× in the result, the budget and the ledger', async () => {
    const result = await callAnthropic(
      gatewayEnv(),
      USERS.member,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      async () => reply(),
    );
    expect(result.costUsd).toBeCloseTo(0.01155, 6);
    expect(await reserved()).toEqual([
      expect.closeTo(0.01155, 6) as unknown as number,
      expect.closeTo(0.01155, 6) as unknown as number,
    ]);
    const row = await env.DB.prepare('SELECT cost_usd FROM ai_usage').first<{ cost_usd: number }>();
    expect(row?.cost_usd).toBeCloseTo(0.01155, 6);
  });

  it('fails CLOSED on any other AI_INFERENCE_GEO — before the fetch and before any reservation', async () => {
    for (const bad of ['US', 'eu', ' us', 'us,global', 'any', 'none']) {
      let called = false;
      const fetcher: Fetcher = async () => {
        called = true;
        return reply();
      };
      await expect(
        callAnthropic(
          gatewayEnv({ AI_INFERENCE_GEO: bad }),
          USERS.member,
          { messages: [{ role: 'user', content: 'hi' }] },
          fetcher,
        ),
        bad,
      ).rejects.toMatchObject({ status: 503, code: 'ai_unconfigured' });
      expect(called, bad).toBe(false);
    }
    expect(await reserved()).toEqual([0, 0]);
  });

  it('refuses "global" in PRODUCTION — before the fetch and before any reservation', async () => {
    // Review finding: one dashboard var turned off the C6 pin on every production call. "Any
    // location" in production is a DPO-assessed exception, never a var.
    let called = false;
    await expect(
      callAnthropic(
        gatewayEnv({ AI_INFERENCE_GEO: 'global', APP_ENV: 'production' }),
        USERS.member,
        { messages: [{ role: 'user', content: 'hi' }] },
        async () => {
          called = true;
          return reply();
        },
      ),
    ).rejects.toMatchObject({ status: 503, code: 'ai_unconfigured' });
    expect(called).toBe(false);
    expect(await reserved()).toEqual([0, 0]);
    // Production with the default or an explicit "us" pin is untouched.
    for (const pinned of [undefined, '', 'us']) {
      expect(
        inferenceGeoFor(gatewayEnv({ AI_INFERENCE_GEO: pinned, APP_ENV: 'production' })),
        String(pinned),
      ).toBe('us');
    }
    // Staging and dev keep the explicit opt-out.
    for (const appEnv of ['staging', 'development', 'test'] as const) {
      expect(inferenceGeoFor(gatewayEnv({ AI_INFERENCE_GEO: 'global', APP_ENV: appEnv }))).toBe(
        'global',
      );
    }
  });

  it('resolveInferenceGeo is the one region rule the runtime and verify:edge share', () => {
    const table: [unknown, unknown, string][] = [
      [undefined, 'production', 'us'],
      ['', 'production', 'us'],
      ['us', 'production', 'us'],
      ['global', 'production', 'global_in_production'],
      ['global', 'staging', 'global'],
      ['global', undefined, 'global'],
      ['US', 'staging', 'invalid'],
      [' us', 'staging', 'invalid'],
      ['eu', 'staging', 'invalid'],
      [1, 'staging', 'invalid'],
      [null, 'staging', 'invalid'],
    ];
    for (const [value, appEnv, want] of table) {
      expect(resolveInferenceGeo(value, appEnv), `${String(value)} / ${String(appEnv)}`).toBe(want);
    }
  });

  it('surfaces the provider-reported region, and only a well-formed one', async () => {
    const call = (usage: Record<string, unknown>) =>
      callAnthropic(
        gatewayEnv(),
        USERS.member,
        { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
        async () => reply({ usage: { input_tokens: 1, output_tokens: 1, ...usage } }),
      );
    expect((await call({ inference_geo: 'us' })).inferenceGeo).toBe('us');
    expect((await call({})).inferenceGeo).toBe(null);
    expect((await call({ inference_geo: 'US; drop table' })).inferenceGeo).toBe(null);
    expect((await call({ inference_geo: 7 })).inferenceGeo).toBe(null);
  });

  it('flags a pinned call the provider says ran elsewhere, and still prices it at the us rate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await callAnthropic(
      gatewayEnv(),
      USERS.member,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      async () => reply({ usage: { input_tokens: 1000, output_tokens: 500, inference_geo: 'eu' } }),
    );
    expect(loggedEvents(warn.mock.calls)).toContainEqual({
      event: 'ai_inference_geo_mismatch',
      requested: 'us',
      echoed: 'eu',
    });
    expect(result.inferenceGeo).toBe('eu');
    expect(result.costUsd).toBeCloseTo(0.01155, 6);
  });

  it('prices at the us rate when the provider says us, even if the call asked for global', async () => {
    const result = await callAnthropic(
      gatewayEnv({ AI_INFERENCE_GEO: 'global' }),
      USERS.member,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      async () => reply({ usage: { input_tokens: 1000, output_tokens: 500, inference_geo: 'us' } }),
    );
    expect(result.costUsd).toBeCloseTo(0.01155, 6);
  });
});

describe('model allowlist — models that cannot take the pin are refused', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('pins the allowlist: Claude 4.6+ models the kit prices, no Covered Models', () => {
    expect(ALLOWED_MODELS).toEqual({
      'claude-opus-5-5': { forcedToolChoice: false, hiddenThinking: true },
      'claude-sonnet-5': { forcedToolChoice: true, hiddenThinking: true },
      'claude-opus-5': { forcedToolChoice: true, hiddenThinking: true },
      'claude-opus-4-8': { forcedToolChoice: true, hiddenThinking: false },
      'claude-sonnet-4-6': { forcedToolChoice: true, hiddenThinking: false },
    });
  });

  it('the runtime allowlist IS the vocabulary module the gate reads — one table, not two', () => {
    expect(ALLOWED_MODELS).toBe(MODEL_TABLE);
    expect(Object.isFrozen(MODEL_TABLE)).toBe(true);
    for (const model of Object.keys(MODEL_TABLE)) expect(isAllowedModel(model), model).toBe(true);
    for (const junk of ['claude-haiku-4-5', 'constructor', '__proto__', '', 7, null, undefined]) {
      expect(isAllowedModel(junk), String(junk)).toBe(false);
    }
  });

  it('every allowed model has its own verified rate row and effort row (one reviewed edit)', () => {
    for (const model of Object.keys(ALLOWED_MODELS)) {
      expect(Object.hasOwn(DEFAULT_RATES, model), model).toBe(true);
      expect(effortFor(model, 'low'), model).toBe('low');
    }
  });

  it('the kit configs pin an allowed default and large model', () => {
    // wrangler.test.jsonc mirrors wrangler.jsonc and wrangler.staging.jsonc for these two.
    expect(() => modelPolicy(env.AI_DEFAULT_MODEL)).not.toThrow();
    expect(() => modelPolicy(env.AI_LARGE_MODEL as string)).not.toThrow();
  });

  it('refuses every other model before the fetch, before any reservation, before the key is read', async () => {
    const refused = [
      'claude-haiku-4-5', // rejects inference_geo with a 400
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-fable-5-1', // Covered Model: 30-day retention, no ZDR
      'claude-mythos-5',
      'claude-sonnet-5-20260915', // exact ids only
      'claude-future-9',
      'constructor',
      '__proto__',
      '',
    ];
    for (const model of refused) {
      let called = false;
      await expect(
        callAnthropic(
          // No API key: the allowlist answers first, so a refusal never depends on config.
          { ...env },
          USERS.member,
          { messages: [{ role: 'user', content: 'hi' }], model },
          async () => {
            called = true;
            return reply();
          },
        ),
        model,
      ).rejects.toMatchObject({ status: 503, code: 'ai_model_not_allowed' });
      expect(called, model).toBe(false);
    }
    expect(await reserved()).toEqual([0, 0]);
  });

  it('refuses a disallowed AI_DEFAULT_MODEL the same way (the config path, not just an override)', async () => {
    await expect(
      callAnthropic(
        gatewayEnv({ AI_DEFAULT_MODEL: 'claude-haiku-4-5' }),
        USERS.member,
        { messages: [{ role: 'user', content: 'hi' }] },
        async () => reply(),
      ),
    ).rejects.toMatchObject({ status: 503, code: 'ai_model_not_allowed' });
  });
});
