import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AiEffort,
  callAnthropic,
  effortFor,
  type Fetcher,
  gatewayMessagesUrl,
} from '../../src/ai/anthropic';
import { todayUtc } from '../../src/ai/budget';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { AppError } from '../../src/framework/errors';
import { aiRoutes } from '../../src/routes/ai';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser } from '../helpers/http';
import { type CapturedLogs, captureLogs } from '../helpers/logs';

const gatewayEnv = (): Env => ({
  ...env,
  ANTHROPIC_API_KEY: 'sk-ant-test-synthetic',
  // The FLEET-SHARED gateway id — one gateway for every kit app, never renamed on
  // bootstrap (per-app attribution is cf-aig-metadata, not the gateway id).
  AI_GATEWAY_ID: 'all-pr-apps',
  AI_GATEWAY_TOKEN: 'gw-test-token',
  CF_ACCOUNT_ID: 'acct-test-123',
});

function fakeResponse(fields: Record<string, unknown> = {}): Response {
  return Response.json({
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'hello from the model' }],
    usage: { input_tokens: 1000, output_tokens: 500 },
    ...fields,
  });
}

describe('Anthropic client via AI Gateway', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  it('routes through the gateway with payload logging OFF (the privacy invariant)', async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const result = await callAnthropic(
      gatewayEnv(),
      USERS.member,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      async (url, init) => {
        captured = { url, headers: init.headers as Record<string, string> };
        return fakeResponse();
      },
    );
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(gatewayMessagesUrl('acct-test-123', 'all-pr-apps'));
    expect(captured!.headers['cf-aig-collect-log-payload']).toBe('false');
    // Cache-skip is per-request defense in depth: the fleet gateway's cache keys ignore
    // which app asked, so this must ride every call even while gateway caching is off.
    expect(captured!.headers['cf-aig-skip-cache']).toBe('true');
    expect(captured!.headers['cf-aig-authorization']).toBe('Bearer gw-test-token');
    expect(captured!.headers['anthropic-version']).toBe('2023-06-01');
    expect(result.text).toBe('hello from the model');
  });

  it('attributes every gateway call to this app via cf-aig-metadata (fleet-shared gateway)', async () => {
    const testEnv = gatewayEnv();
    let headers: Record<string, string> | null = null;
    await callAnthropic(
      testEnv,
      USERS.member,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      async (_url, init) => {
        headers = init.headers as Record<string, string>;
        return fakeResponse();
      },
    );
    // The contract: attribution comes from the required APP_NAME/APP_ENV vars, EXACTLY —
    // and nothing else. No emails, no user identifiers: metadata lands in the shared
    // gateway's logs, which every fleet builder can see. (budget.ts owns per-user spend.)
    // LITERALS on purpose, not testEnv.APP_NAME: toEqual treats undefined-valued keys as
    // absent, so an env-derived expectation goes vacuous exactly when attribution silently
    // disappears. The literals mirror wrangler.test.jsonc and rename together on a fork.
    const metaHeader = headers!['cf-aig-metadata'];
    expect(metaHeader).toBeDefined();
    expect(JSON.parse(metaHeader as string)).toEqual({ app: 'work-queue-requests', env: 'test' });
  });

  it('drops a feature tag that is not a static ASCII label — nothing dynamic reaches gateway logs', async () => {
    let headers: Record<string, string> | null = null;
    await callAnthropic(
      gatewayEnv(),
      USERS.member,
      {
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        // Synthetic PII-shaped value: fails FEATURE_TAG (spaces, '@', non-ASCII) — and a
        // non-Latin-1 header value would make fetch() itself throw, so dropping it also
        // keeps the call alive.
        feature: 'user user1@test.example asked: שלום',
      },
      async (_url, init) => {
        headers = init.headers as Record<string, string>;
        return fakeResponse();
      },
    );
    const metaHeader = headers!['cf-aig-metadata'];
    expect(JSON.parse(metaHeader as string)).toEqual({ app: 'work-queue-requests', env: 'test' });
  });

  it('passes the optional feature tag through as the third (and last) metadata key', async () => {
    const testEnv = gatewayEnv();
    let headers: Record<string, string> | null = null;
    await callAnthropic(
      testEnv,
      USERS.member,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, feature: 'unit-test' },
      async (_url, init) => {
        headers = init.headers as Record<string, string>;
        return fakeResponse();
      },
    );
    const metaHeader = headers!['cf-aig-metadata'];
    expect(metaHeader).toBeDefined();
    const meta = JSON.parse(metaHeader as string) as Record<string, string>;
    expect(meta).toEqual({ app: 'work-queue-requests', env: 'test', feature: 'unit-test' });
    // Cloudflare persists at most 5 metadata entries per request; the client stays under it.
    expect(Object.keys(meta).length).toBeLessThanOrEqual(5);
  });

  it('computes cost from usage and records it in the ledger', async () => {
    const testEnv = gatewayEnv();
    const result = await callAnthropic(
      testEnv,
      USERS.member,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
      async () => fakeResponse(),
    );
    // (1000 in @ $3/M + 500 out @ $15/M) × 1.1 for the us pin = (0.003 + 0.0075) × 1.1
    expect(result.costUsd).toBeCloseTo(0.01155, 6);
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBeCloseTo(0.01155, 6);
    const usage = await env.DB.prepare('SELECT model, cost_usd FROM ai_usage').first<{
      model: string;
      cost_usd: number;
    }>();
    expect(usage?.model).toBe('claude-sonnet-4-6');
  });

  it('falls back to the direct API when the gateway is not configured (non-production)', async () => {
    const direct: Env = { ...env, ANTHROPIC_API_KEY: 'sk-ant-test-synthetic' };
    let capturedUrl = '';
    let headers: Record<string, string> | null = null;
    await callAnthropic(
      direct,
      USERS.member,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, feature: 'unit-test' },
      async (url, init) => {
        capturedUrl = url;
        headers = init.headers as Record<string, string>;
        return fakeResponse();
      },
    );
    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
    // cf-aig-* headers are gateway instructions; none go to the provider directly.
    expect(headers!['cf-aig-metadata']).toBeUndefined();
    expect(headers!['cf-aig-collect-log-payload']).toBeUndefined();
    expect(headers!['cf-aig-authorization']).toBeUndefined();
    expect(headers!['cf-aig-skip-cache']).toBeUndefined();
  });

  it('fails closed in PRODUCTION when the gateway is not configured (no direct fallback)', async () => {
    const prod: Env = { ...env, ANTHROPIC_API_KEY: 'sk-ant-test-synthetic', APP_ENV: 'production' };
    let called = false;
    await expect(
      callAnthropic(
        prod,
        USERS.member,
        { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 },
        async () => {
          called = true;
          return fakeResponse();
        },
      ),
    ).rejects.toMatchObject({ code: 'ai_unconfigured', status: 503 });
    expect(called).toBe(false); // never reached the provider directly
    // and no reservation was booked — the check precedes reserveBudget
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBe(0);
  });

  it('returns 503 ai_unconfigured when no API key exists (CI never calls the gateway)', async () => {
    await expect(
      callAnthropic(env, USERS.member, { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'ai_unconfigured', status: 503 });
  });

  it('releases the reservation when the upstream call fails', async () => {
    await expect(
      callAnthropic(
        gatewayEnv(),
        USERS.member,
        { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
        async () => new Response('boom', { status: 500 }),
      ),
    ).rejects.toMatchObject({ code: 'ai_upstream_error', status: 502 });
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBe(0);
  });

  // A 2xx means the provider generated and billed the message before it sent the status, so a body
  // that cannot be read is BOOKED at the reservation, never released (DECISIONS 2026-09-23; this
  // reverses the release of 2026-06-29 item 2, which fixed the open reservation but under-read).
  async function bookedAtReservation(fetcher: Fetcher): Promise<void> {
    await seedDb();
    let during = -1;
    const repo = makeDb(env).aiBudget;
    await expect(
      callAnthropic(
        gatewayEnv(),
        USERS.member,
        { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
        async (url, init) => {
          during = await repo.reservedToday(`u:${USERS.member}`, todayUtc());
          return fetcher(url, init);
        },
      ),
    ).rejects.toMatchObject({ code: 'ai_upstream_error', status: 502 });
    expect(during).toBeGreaterThan(0);
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBeCloseTo(during, 6);
    expect(await repo.reservedToday('g', todayUtc())).toBeCloseTo(during, 6);
    const rows = await env.DB.prepare('SELECT model, cost_usd FROM ai_usage').all<{
      model: string;
      cost_usd: number;
    }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.cost_usd).toBeCloseTo(during, 6);
  }

  it('books the reservation when a 200 response carries an unparseable body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await bookedAtReservation(
      async () => new Response('<html>gateway hiccup, not JSON</html>', { status: 200 }),
    );
  });

  it('books the reservation when a 200 body is JSON but not an object (no TypeError escapes)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const text of ['null', '42', '"text"', '[]']) {
      await bookedAtReservation(async () => new Response(text, { status: 200 }));
    }
  });

  it('refuses over-budget calls before any network request', async () => {
    const tight: Env = { ...gatewayEnv(), AI_MAX_CALL_USD: '0.0001' };
    let called = false;
    await expect(
      callAnthropic(
        tight,
        USERS.member,
        { messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096 },
        async () => {
          called = true;
          return fakeResponse();
        },
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(called).toBe(false);
  });

  it('the /api/ai/complete route is permission-gated and reports unconfigured safely', async () => {
    const viewer = await asUser(USERS.viewer, 'POST', '/api/ai/complete', { prompt: 'hi' });
    expect(viewer.status).toBe(404); // ai.use excludes viewer → uniform 404
    const member = await asUser(USERS.member, 'POST', '/api/ai/complete', { prompt: 'hi' });
    expect(member.status).toBe(503); // no key in test env; checked before any fetch
  });

  it('declares the ai.call audit action — the framework writes the single row the handler shapes', () => {
    // Single-writer: the route declares `audit: 'ai.call'` and the handler names the target
    // (model) + payload (tokens, cost) via ctx.setAuditTarget, so exactly one rich row is
    // written. (It used to opt out with `audit: false` and write the row by hand — that is the
    // pattern the single-writer change replaced; see DECISIONS 2026-06-19.)
    const route = aiRoutes.find((r) => r.spec.path === '/api/ai/complete');
    expect(route?.spec.audit).toBe('ai.call');
  });
});

// --- Failure logs carry no content (PIA C5) ----------------------------------------------

describe('Anthropic client — failure logs are content-free', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  const secret = ['synthetic-prompt-echo', '5d1e'].join('-');

  /** Run one failing call with every console method captured, as Workers Logs would keep it. */
  async function failWith(fetcher: Fetcher): Promise<CapturedLogs> {
    const logs = captureLogs();
    try {
      await expect(
        callAnthropic(
          gatewayEnv(),
          USERS.member,
          { messages: [{ role: 'user', content: secret }], maxTokens: 100 },
          fetcher,
        ),
      ).rejects.toMatchObject({ code: 'ai_upstream_error', status: 502 });
    } finally {
      logs.restore();
    }
    logs.expectAbsent(secret);
    return logs;
  }

  it('ai_call_failed logs the status and provider error type — never the body that echoes the prompt', async () => {
    const logs = await failWith(async () =>
      Response.json(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: `messages.0.content: "${secret}"` },
        },
        { status: 400 },
      ),
    );
    expect(logs.named('ai_call_failed')).toEqual([
      { event: 'ai_call_failed', status: 400, error_type: 'invalid_request_error', level: 'error' },
    ]);
  });

  it('ai_call_failed reads an unusable error body as type "unknown"', async () => {
    for (const body of [
      `<html>${secret}</html>`,
      JSON.stringify({ error: { type: `x ${secret}` } }),
      JSON.stringify({ error: { type: 42 } }),
      JSON.stringify({ error: [{ code: `x ${secret}` }] }),
      'null',
    ]) {
      const logs = await failWith(async () => new Response(body, { status: 529 }));
      expect(logs.named('ai_call_failed')).toEqual([
        { event: 'ai_call_failed', status: 529, error_type: 'unknown', level: 'error' },
      ]);
    }
  });

  it('ai_call_bad_body logs a reason and the error category only (a JSON SyntaxError message quotes the body)', async () => {
    const logs = await failWith(
      async () => new Response(`{"content": "${secret}`, { status: 200 }),
    );
    expect(logs.named('ai_call_bad_body')).toEqual([
      {
        event: 'ai_call_bad_body',
        reason: 'unparseable',
        err: { name: 'SyntaxError' },
        level: 'error',
      },
    ]);
  });

  it('ai_call_network_error logs the error category only', async () => {
    const logs = await failWith(async () => {
      throw new TypeError(`connect failed while sending ${secret}`);
    });
    expect(logs.named('ai_call_network_error')).toEqual([
      { event: 'ai_call_network_error', err: { name: 'TypeError' }, level: 'error' },
    ]);
  });

  it('a thrown error whose NAME carries content is logged as a marker, never the name', async () => {
    const logs = await failWith(async () => {
      throw Object.assign(new Error('x'), { name: `name with ${secret}` });
    });
    expect(logs.named('ai_call_network_error')[0]?.err).toEqual({ name: '[redacted:text]' });
  });
});

// --- Per-model request shape, stop_reason, and refusals (generation-5 models) ------------

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// A generation-5 reply: fakeResponse's body with the model the calls below ask for and a stop_reason.
const modelResponse = (fields: Record<string, unknown>): Response =>
  fakeResponse({ model: 'claude-sonnet-5', stop_reason: 'end_turn', ...fields });

/** Run one call and return the JSON body the client put on the wire. */
async function sentBody(
  model: string,
  effort: AiEffort | undefined,
  system?: string,
): Promise<Record<string, unknown>> {
  let raw = '';
  await callAnthropic(
    gatewayEnv(),
    USERS.member,
    { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, model, effort, system },
    async (_url, init) => {
      raw = init.body as string;
      return modelResponse({ model });
    },
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

async function usageRows(): Promise<{ model: string; cost_usd: number }[]> {
  const { results } = await env.DB.prepare('SELECT model, cost_usd FROM ai_usage').all<{
    model: string;
    cost_usd: number;
  }>();
  return results;
}

describe('Anthropic client — per-model request shape', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('sends effort to sonnet-5 as output_config.effort — and nothing a generation-5 model rejects', async () => {
    const body = await sentBody('claude-sonnet-5', 'low', 'be brief');
    expect(body.output_config).toEqual({ effort: 'low' });
    // The whole top-level shape, so a stray thinking/sampling field cannot ride along unseen.
    expect(Object.keys(body).sort()).toEqual(
      ['inference_geo', 'max_tokens', 'messages', 'model', 'output_config', 'system'].sort(),
    );
    const wire = JSON.stringify(body);
    for (const banned of ['budget_tokens', 'thinking', 'temperature', 'top_p', 'top_k']) {
      expect(wire, banned).not.toContain(banned);
    }
  });

  it('passes every effort level through to the models that accept all five', async () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-4-8',
    ]) {
      for (const effort of EFFORTS) {
        const body = await sentBody(model, effort);
        expect(body.output_config, `${model}/${effort}`).toEqual({ effort });
      }
    }
  });

  it('never sends effort to haiku-4-5 (it errors on it) — it is not called at all now', async () => {
    // Haiku 4.5 also rejects inference_geo, so the model allowlist refuses it before any request
    // (test/ai/geo.test.ts). effortFor still answers for it, dated snapshot included, so a fork
    // that re-admits it cannot send it an effort.
    for (const model of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
      for (const effort of EFFORTS)
        expect(effortFor(model, effort), `${model}/${effort}`).toBe(undefined);
      await expect(sentBody(model, 'low')).rejects.toMatchObject({ code: 'ai_model_not_allowed' });
    }
  });

  it('keys the effort table by base id, so a dated snapshot of an effort model keeps its effort', () => {
    // The Haiku case above cannot show normalization happened: a missed lookup also means "no
    // effort". An effort-accepting dated id can — without baseModelId it would lose its effort.
    // (effortFor directly: the allowlist admits exact ids only, and 4.6+ ids carry no date.)
    for (const model of ['claude-sonnet-5-20260915', 'claude-opus-5-20260101']) {
      expect(effortFor(model, 'low'), model).toBe('low');
    }
  });

  it('omits a level the model does not accept (sonnet-4-6 has no xhigh) but sends the rest', async () => {
    expect(await sentBody('claude-sonnet-4-6', 'xhigh')).not.toHaveProperty('output_config');
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      expect((await sentBody('claude-sonnet-4-6', effort)).output_config).toEqual({ effort });
    }
  });

  it('sends no output_config when no effort is asked for', async () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-6']) {
      const body = await sentBody(model, undefined);
      expect(body, model).not.toHaveProperty('output_config');
      expect(Object.keys(body).sort(), model).toEqual([
        'inference_geo',
        'max_tokens',
        'messages',
        'model',
      ]);
    }
  });

  it('fails safe on anything outside the table: unknown models and untyped levels get no effort', async () => {
    expect(effortFor('claude-future-9', 'low')).toBeUndefined();
    // Prototype keys must not read as table rows.
    expect(effortFor('constructor', 'low')).toBeUndefined();
    // …and neither reaches the wire: the model allowlist refuses both before any request.
    for (const model of ['claude-future-9', 'constructor']) {
      await expect(sentBody(model, 'low'), model).rejects.toMatchObject({
        code: 'ai_model_not_allowed',
      });
    }
    // A caller outside the type system (e.g. a value read from JSON) cannot inject a level.
    const bogus = 'turbo' as unknown as AiEffort;
    expect(await sentBody('claude-sonnet-5', bogus)).not.toHaveProperty('output_config');
    expect(effortFor('claude-sonnet-5', 'includes' as unknown as AiEffort)).toBeUndefined();
  });

  it('effortFor is the single decision point the request shape follows', () => {
    expect(effortFor('claude-opus-5', 'max')).toBe('max');
    expect(effortFor('claude-opus-5-20260101', 'medium')).toBe('medium');
    expect(effortFor('claude-haiku-4-5', 'low')).toBeUndefined();
    expect(effortFor('claude-sonnet-4-6', 'xhigh')).toBeUndefined();
    expect(effortFor('claude-sonnet-5', undefined)).toBeUndefined();
  });
});

describe('Anthropic client — stop_reason and refusals', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const call = (fetcher: Fetcher, content = 'hi') =>
    callAnthropic(
      gatewayEnv(),
      USERS.member,
      { messages: [{ role: 'user', content }], maxTokens: 100, model: 'claude-sonnet-5' },
      fetcher,
    );

  it('surfaces stop_reason end_turn on a normal reply', async () => {
    const result = await call(async () => modelResponse({}));
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('hello from the model');
  });

  it('surfaces stop_reason max_tokens so the caller can reject a cut-off reply', async () => {
    const result = await call(async () =>
      modelResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'half a' }] }),
    );
    expect(result.stopReason).toBe('max_tokens');
    expect(result.text).toBe('half a');
    // Billed like any other call: (1000 in @ $2/M + 500 out @ $10/M) × 1.1 us pin.
    expect(result.costUsd).toBeCloseTo(0.0077, 6);
  });

  it('reports null when stop_reason is absent or not a string', async () => {
    expect((await call(async () => modelResponse({ stop_reason: undefined }))).stopReason).toBe(
      null,
    );
    expect((await call(async () => modelResponse({ stop_reason: 42 }))).stopReason).toBe(null);
  });

  it('throws ai_refused on a pre-output refusal and releases the whole reservation', async () => {
    const secret = 'synthetic-request-marker-7f3a';
    const err = await call(
      async () =>
        modelResponse({
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: secret },
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      secret,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 422, code: 'ai_refused' });
    // Opaque: nothing from the request or the provider's explanation comes back to the caller.
    expect((err as AppError).message).not.toContain(secret);
    // Unbilled → both budget scopes back to zero and no usage row.
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBe(0);
    expect(await repo.reservedToday('g', todayUtc())).toBe(0);
    expect(await usageRows()).toEqual([]);
  });

  it('treats a refusal with no usage block as unbilled', async () => {
    await expect(
      call(async () => modelResponse({ stop_reason: 'refusal', content: [], usage: undefined })),
    ).rejects.toMatchObject({ status: 422, code: 'ai_refused' });
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBe(0);
    expect(await repo.reservedToday('g', todayUtc())).toBe(0);
    expect(await usageRows()).toEqual([]);
  });

  it('never returns partial output from a mid-output refusal, and books what was billed', async () => {
    const partial = 'synthetic-partial-output-91c2';
    const err = await call(async () =>
      modelResponse({
        stop_reason: 'refusal',
        content: [{ type: 'text', text: partial }],
        usage: { input_tokens: 1000, output_tokens: 200 },
      }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'ai_refused' });
    expect((err as AppError).message).not.toContain(partial);
    // Billed at actual: (1000 in @ $2/M + 200 out @ $10/M) × 1.1 = 0.0044 — not the
    // reservation, not zero.
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBeCloseTo(0.0044, 6);
    expect(await repo.reservedToday('g', todayUtc())).toBeCloseTo(0.0044, 6);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe('claude-sonnet-5');
    expect(rows[0]?.cost_usd).toBeCloseTo(0.0044, 6);
  });

  it('prices a partial usage block on what it reports — never NaN in the budget or the ledger', async () => {
    const result = await call(async () => modelResponse({ usage: { input_tokens: 1000 } }));
    // 1000 in @ $2/M × 1.1; the missing output counter is 0, not NaN.
    expect(result.costUsd).toBeCloseTo(0.0022, 6);
    expect(result.usage).toMatchObject({ input_tokens: 1000, output_tokens: 0 });
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBeCloseTo(0.0022, 6);
    expect(await repo.reservedToday('g', todayUtc())).toBeCloseTo(0.0022, 6);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost_usd).toBeCloseTo(0.0022, 6);
  });

  it('coerces malformed usage counters to 0 instead of letting them reach the arithmetic', async () => {
    const result = await call(async () =>
      modelResponse({
        usage: {
          input_tokens: '1000',
          output_tokens: null,
          cache_creation_input_tokens: Number.NaN,
          cache_read_input_tokens: -5,
        },
      }),
    );
    expect(result.costUsd).toBe(0);
    expect(Number.isFinite(result.costUsd)).toBe(true);
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBe(0);
    expect(await repo.reservedToday('g', todayUtc())).toBe(0);
  });

  it('books a refusal whose usage block is partial but non-zero (billed, not released)', async () => {
    await expect(
      call(async () =>
        modelResponse({ stop_reason: 'refusal', content: [], usage: { input_tokens: 800 } }),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'ai_refused' });
    // 800 in @ $2/M × 1.1 = 0.00176 — the missing output counter reads as 0, not NaN (which would
    // have released the reservation and dropped the ledger row).
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBeCloseTo(0.00176, 6);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost_usd).toBeCloseTo(0.00176, 6);
  });

  it('falls back to the requested model when the echoed model is not a usable string', async () => {
    for (const echoed of [42, '', null, { id: 'x' }]) {
      await seedDb();
      const result = await call(async () => modelResponse({ model: echoed }));
      expect(result.model, JSON.stringify(echoed)).toBe('claude-sonnet-5');
      // Priced at the requested model's rate: (1000 in @ $2/M + 500 out @ $10/M) × 1.1.
      expect(result.costUsd, JSON.stringify(echoed)).toBeCloseTo(0.0077, 6);
    }
  });

  it('prices a dated model echo at the base model rate in the ledger (not the fallback)', async () => {
    // Haiku 4.5 — the one model that echoes a dated id for its alias — is no longer allowed (it
    // rejects inference_geo), so the echo here is synthetic; the base-id pricing it pins is not.
    const result = await callAnthropic(
      gatewayEnv(),
      USERS.member,
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, model: 'claude-sonnet-4-6' },
      async () => modelResponse({ model: 'claude-sonnet-4-6-20260101' }),
    );
    // (1000 in @ $3/M + 500 out @ $15/M) × 1.1 = 0.01155 (the fallback would be 0.05775).
    expect(result.costUsd).toBeCloseTo(0.01155, 6);
    expect(result.model).toBe('claude-sonnet-4-6-20260101'); // what actually ran, as echoed
    const rows = await usageRows();
    expect(rows[0]?.model).toBe('claude-sonnet-4-6-20260101');
    expect(rows[0]?.cost_usd).toBeCloseTo(0.01155, 6);
  });
});
