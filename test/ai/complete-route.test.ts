// The golden AI route (/api/ai/complete) end to end through the real route pipeline, with only the
// provider stubbed: what a refusal looks like to a route that copies the golden example. The client
// tests in anthropic.test.ts pin callAnthropic itself; this pins what the ROUTE does with it —
// nothing is returned, no success audit row is written, and the budget is settled.
//
// executeRoute (not SELF.fetch) because the test worker has no API key by design, so the HTTP path
// stops at 503 before any fetch. The route passes no fetcher, so the global one is stubbed.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { todayUtc } from '../../src/ai/budget';
import type { Principal } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import type { RouteSpec } from '../../src/framework/defineRoute';
import { AppError } from '../../src/framework/errors';
import { executeRoute } from '../../src/framework/execute';
import { aiRoutes } from '../../src/routes/ai';
import { applySchema, seedDb, USERS } from '../helpers/db';
// BASE, not a literal host: a fork that copies this file keeps it free of the template name its
// verify:bootstrap residual scan rejects.
import { BASE } from '../helpers/http';

const gatewayEnv = (): Env => ({
  ...env,
  ANTHROPIC_API_KEY: 'sk-ant-test-synthetic',
  AI_GATEWAY_ID: 'all-pr-apps',
  AI_GATEWAY_TOKEN: 'gw-test-token',
  CF_ACCOUNT_ID: 'acct-test-123',
});

const member: Principal = {
  kind: 'person',
  email: USERS.member,
  name: null,
  role: 'member',
  authMethod: 'magic_link',
  credentialTransport: 'cookie',
};

const route = aiRoutes.find((r) => r.spec.path === '/api/ai/complete');

function complete(prompt: string): Promise<unknown> {
  return executeRoute(gatewayEnv(), route?.spec as RouteSpec<z.ZodTypeAny>, member, {
    ip: '',
    params: {},
    request: new Request(`${BASE}/api/ai/complete`, { method: 'POST' }),
    waitUntil: () => {},
    invocation: { via: 'http' },
    buildRawInput: () => ({ prompt }),
  });
}

function provider(body: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'hello from the model' }],
      usage: { input_tokens: 1000, output_tokens: 500 },
      stop_reason: 'end_turn',
      ...body,
    }),
  );
}

async function aiCallAuditRows(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ai.call'",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

async function usageRows(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_usage').first<{ n: number }>();
  return row?.n ?? 0;
}

describe('/api/ai/complete — refusals through the route pipeline', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  it('a normal reply returns the text and writes exactly one ai.call audit row (the control)', async () => {
    const fetchSpy = provider({});
    const result = await complete('synthetic prompt');
    expect(result).toMatchObject({ text: 'hello from the model', model: 'claude-sonnet-5' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await aiCallAuditRows()).toBe(1);
    expect(await usageRows()).toBe(1);
  });

  it('a refusal throws 422 ai_refused: no text, no success audit row, budget released', async () => {
    const prompt = 'synthetic-route-prompt-4be1';
    const fetchSpy = provider({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: prompt },
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const err = await complete(prompt).catch((e: unknown) => e);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // it reached the provider; this is not the 503 path
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 422, code: 'ai_refused' });
    // Opaque: neither the prompt nor the provider's explanation comes back to the caller.
    expect((err as AppError).message).not.toContain(prompt);
    // The framework writes the declared audit row only after a successful handler.
    expect(await aiCallAuditRows()).toBe(0);
    // Unbilled: both budget scopes back to zero and nothing in the ledger.
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, todayUtc())).toBe(0);
    expect(await repo.reservedToday('g', todayUtc())).toBe(0);
    expect(await usageRows()).toBe(0);
  });
});
