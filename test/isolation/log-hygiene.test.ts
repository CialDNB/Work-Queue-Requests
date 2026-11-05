// THE LOG-HYGIENE TRIPWIRE (PIA condition C5). Workers Logs are on at head_sampling_rate 1, keep
// every line for 7 days, and cannot delete one — so whatever these paths print is an undeletable
// account-wide copy for a week, outside every retention sweep and every erasure. Each test drives a
// path that USED to print content — the undelivered magic link (link + address), the email
// transport (recipient + subject + error text), the worker's last-resort error handler, the route
// and MCP adapters (raw thrown errors), and the AI client (the provider's error body) — with
// planted content, and asserts that no captured console line, on any level, carries any of it.
//
// It lives in test/isolation/ because /kit-upgrade carries this directory to every fork.
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { callAnthropic } from '../../src/ai/anthropic';
import { magicLinkOutboxKey, requestMagicLink } from '../../src/auth/magicLink';
import type { Principal } from '../../src/auth/types';
import { sendEmail } from '../../src/email/transport';
import type { Env } from '../../src/env';
import { defineRoute, mountRoutes } from '../../src/framework/defineRoute';
import worker from '../../src/index';
import { buildMcpTools } from '../../src/mcp/tools';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { BASE, cookieFor } from '../helpers/http';
import { type CapturedLogs, captureLogs } from '../helpers/logs';

// Planted content: an address, a link with a token, and a sentence — the three shapes C5 names.
// Hosts derive from BASE (test/helpers/http.ts, which /new-app renames), never a literal: this file
// is carried to every fork, where the template's host does not exist.
const HOST = new URL(BASE).host;
const VICTIM = 'maria.silva@client.example';
const LINK = `${BASE}/auth/verify?token=5eed5eed5eed`;
const SENTENCE = 'Summarize the credit file for Maria Silva, CPF 123.456.789-09';
const CONTENT_ERROR = `${SENTENCE} (${VICTIM}; ${LINK})`;
/** Needles no log line may contain, whatever the path. */
const PLANTED = ['maria', 'client.example', '5eed5eed', 'token=', 'credit file', '123.456.789'];

/**
 * Run `fn` with every console method captured; assert nothing planted leaked. `base` is PLANTED
 * except where a test deliberately keeps one of those shapes (the refused-request DOMAIN).
 */
async function withLogs<T>(
  fn: () => Promise<T>,
  extraNeedles: string[] = [],
  base: readonly string[] = PLANTED,
): Promise<{ result: T; logs: ReturnType<typeof captureLogs> }> {
  const logs = captureLogs();
  let result: T;
  try {
    result = await fn();
  } finally {
    logs.restore();
  }
  logs.expectAbsent(...base, ...extraNeedles);
  return { result, logs };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collect waitUntil work so a test can await the deferred half of a request. */
function deferred(): { waitUntil: (p: Promise<unknown>) => void; settle: () => Promise<unknown> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p) => {
      pending.push(p);
    },
    settle: () => Promise.allSettled(pending),
  };
}

const throwingEmail = {
  send: async () => {
    throw new Error(`550 mailbox unavailable: ${VICTIM} — subject "Your sign-in link" ${LINK}`);
  },
};

describe('log hygiene — the magic link is never logged (link or address)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  /** The test env with USERS.member opted in to the outbox — set here, not read from the
   * wrangler config, because this file is carried to forks whose config does not list anyone. */
  const optedIn = (overrides: Record<string, unknown> = {}): Env =>
    ({ ...env, MAGIC_LINK_OUTBOX: USERS.member, ...overrides }) as unknown as Env;

  async function requestFor(target: Env, email: string): Promise<CapturedLogs> {
    const { logs } = await withLogs(async () => {
      const d = deferred();
      await requestMagicLink(target, email, '/notes', '203.0.113.9', d.waitUntil);
      await d.settle();
    }, [USERS.member, USERS.member.split('@')[0] as string, `${HOST}/auth`, 'http']);
    return logs;
  }

  it('non-production, email not configured, address opted in: the link goes to the KV outbox; the log says only THAT', async () => {
    const member = USERS.member;
    await env.SESSIONS.delete(magicLinkOutboxKey(member));
    const logs = await requestFor(optedIn(), member);
    expect(logs.named('email_skipped_no_binding')).toEqual([
      { event: 'email_skipped_no_binding', level: 'warn' },
    ]);
    expect(logs.named('magic_link_not_emailed')).toEqual([
      { event: 'magic_link_not_emailed', outcome: 'skipped', outbox: 'parked', level: 'warn' },
    ]);
    // The builder's copy: parked under the address, for the token's own lifetime (15 min).
    const link = await env.SESSIONS.get(magicLinkOutboxKey(member));
    expect(link).toMatch(new RegExp(`^${escapeRegExp(BASE)}/auth/verify\\?token=[a-f0-9]{64}$`));
    const token = link?.split('token=')[1] ?? '';
    expect(logs.lines.join('\n')).not.toContain(token);
    const listed = await env.SESSIONS.list({ prefix: magicLinkOutboxKey(member) });
    const expiresInSec = (listed.keys[0]?.expiration ?? 0) - Date.now() / 1000;
    expect(expiresInSec).toBeGreaterThan(14 * 60);
    expect(expiresInSec).toBeLessThanOrEqual(15 * 60 + 1);
  });

  it('an address NOT opted in gets no outbox entry — an anonymous request cannot park a link for it', async () => {
    // The raw link at rest is an exception to AICOE-346 (SESSIONS otherwise holds only hashes), so
    // it exists only for an address someone deliberately listed. Unset, empty, or someone else.
    for (const listed of [undefined, '', ` , ${USERS.admin}`]) {
      await env.SESSIONS.delete(magicLinkOutboxKey(USERS.member));
      const logs = await requestFor(optedIn({ MAGIC_LINK_OUTBOX: listed }), USERS.member);
      expect(logs.named('magic_link_not_emailed')).toEqual([
        {
          event: 'magic_link_not_emailed',
          outcome: 'skipped',
          outbox: 'not_listed',
          level: 'warn',
        },
      ]);
      expect(await env.SESSIONS.get(magicLinkOutboxKey(USERS.member))).toBeNull();
    }
  });

  it('the opt-in list and the key are case- and whitespace-insensitive (the key is the lowercased address)', async () => {
    const shouty = `  ${USERS.member.toUpperCase()} `;
    await env.SESSIONS.delete(magicLinkOutboxKey(USERS.member));
    expect(magicLinkOutboxKey(shouty)).toBe(`magic-link-outbox:${USERS.member}`);
    await requestFor(optedIn({ MAGIC_LINK_OUTBOX: `${USERS.admin},${shouty}` }), shouty);
    expect(await env.SESSIONS.get(`magic-link-outbox:${USERS.member}`)).toMatch(
      /token=[a-f0-9]{64}$/,
    );
  });

  it('a failed audit insert neither drops the outbox write nor escapes as a raw rejection', async () => {
    // The runtime logs an unhandled waitUntil rejection WITH its message (D1 text included),
    // outside logEvent — so the insert failure must be caught and logged as a category.
    await env.SESSIONS.delete(magicLinkOutboxKey(USERS.member));
    const auditDown = optedIn({
      DB: new Proxy(env.DB, {
        get(target, prop) {
          if (prop === 'prepare') {
            return (sql: string) => {
              if (sql.includes('INSERT INTO audit_log')) {
                throw new Error(`D1_ERROR: ${CONTENT_ERROR}`);
              }
              return target.prepare(sql);
            };
          }
          return Reflect.get(target, prop);
        },
      }),
    });
    const settled: PromiseSettledResult<unknown>[] = [];
    const { logs } = await withLogs(async () => {
      const d = deferred();
      await requestMagicLink(auditDown, USERS.member, undefined, '203.0.113.9', d.waitUntil);
      settled.push(...((await d.settle()) as PromiseSettledResult<unknown>[]));
    }, [USERS.member, 'D1_ERROR']);
    expect(settled.map((r) => r.status)).toEqual(['fulfilled']);
    expect(logs.named('magic_link_sent_audit_failed')).toEqual([
      { event: 'magic_link_sent_audit_failed', err: { name: 'Error' }, level: 'error' },
    ]);
    expect(await env.SESSIONS.get(magicLinkOutboxKey(USERS.member))).toMatch(/token=[a-f0-9]{64}$/);
  });

  it('non-production, the send FAILS: the transport error text and the address stay out', async () => {
    const staging = optedIn({ APP_ENV: 'staging', EMAIL: throwingEmail });
    const { logs } = await withLogs(async () => {
      const d = deferred();
      await requestMagicLink(staging, USERS.member, undefined, '203.0.113.9', d.waitUntil);
      await d.settle();
    }, [USERS.member, 'mailbox unavailable', 'sign-in link']);
    expect(logs.named('email_send_failed')).toEqual([
      { event: 'email_send_failed', err: { name: 'Error' }, level: 'error' },
    ]);
    expect(logs.named('magic_link_not_emailed')).toEqual([
      { event: 'magic_link_not_emailed', outcome: 'failed', outbox: 'parked', level: 'warn' },
    ]);
  });

  it('production: no outbox at all even for a listed address, a loud delivery failure — and still no link or address', async () => {
    await env.SESSIONS.delete(magicLinkOutboxKey(USERS.member));
    const production = optedIn({ APP_ENV: 'production' });
    const { logs } = await withLogs(async () => {
      const d = deferred();
      await requestMagicLink(production, USERS.member, undefined, '203.0.113.9', d.waitUntil);
      await d.settle();
    }, [USERS.member, 'http']);
    expect(logs.named('magic_link_delivery_failed')).toEqual([
      { event: 'magic_link_delivery_failed', outcome: 'skipped', level: 'error' },
    ]);
    expect(logs.named('magic_link_not_emailed')).toEqual([]);
    expect(await env.SESSIONS.get(magicLinkOutboxKey(USERS.member))).toBeNull();
  });

  it('an APP_ENV nobody listed is treated as production (fail closed): no outbox', async () => {
    await env.SESSIONS.delete(magicLinkOutboxKey(USERS.member));
    const typo = optedIn({ APP_ENV: 'prod' });
    const { logs } = await withLogs(async () => {
      const d = deferred();
      await requestMagicLink(typo, USERS.member, undefined, '203.0.113.9', d.waitUntil);
      await d.settle();
    });
    expect(logs.named('magic_link_delivery_failed')).toHaveLength(1);
    expect(await env.SESSIONS.get(magicLinkOutboxKey(USERS.member))).toBeNull();
  });

  it('a refused request logs the reason and the domain — never the address', async () => {
    // The refused DOMAIN is kept on purpose (per-domain flood triage, mirrored in audit_log), so
    // this test holds every planted shape except the domain.
    const { logs } = await withLogs(
      async () => {
        const res = await SELF.fetch(`${BASE}/auth/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify({ email: VICTIM }),
        });
        expect(res.status).toBe(200);
      },
      [VICTIM],
      PLANTED.filter((needle) => needle !== 'client.example'),
    );
    expect(logs.named('magic_link_refused')).toEqual([
      {
        event: 'magic_link_refused',
        reason: 'unknown_or_disabled_user',
        domain: 'client.example',
        level: 'warn',
      },
    ]);
  }, 30_000);
});

describe('log hygiene — the email transport never logs a recipient, subject or error text', () => {
  it('no binding: a bare skip event', async () => {
    const { result, logs } = await withLogs(() =>
      sendEmail(env, { to: VICTIM, subject: SENTENCE, text: LINK }),
    );
    expect(result).toBe('skipped');
    expect(logs.events).toEqual([{ event: 'email_skipped_no_binding', level: 'warn' }]);
  });

  it('a failing binding: the error category only', async () => {
    const failing = { ...env, EMAIL: throwingEmail } as unknown as Env;
    const { result, logs } = await withLogs(
      () => sendEmail(failing, { to: VICTIM, subject: SENTENCE, text: LINK }),
      ['mailbox unavailable', 'sign-in link'],
    );
    expect(result).toBe('failed');
    expect(logs.events).toEqual([
      { event: 'email_send_failed', err: { name: 'Error' }, level: 'error' },
    ]);
  });
});

describe('log hygiene — thrown errors are logged as a category, never a message', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('unhandled_error (the worker’s last-resort handler): method, route pattern, error class', async () => {
    // A KV outage mid-request, whose error text carries content: the rate limiter's KV read throws
    // outside any route adapter, so only app.onError sees it.
    const kvDown = {
      ...env,
      SESSIONS: new Proxy(env.SESSIONS, {
        get(target, prop) {
          if (prop === 'get') {
            return async () => {
              throw new TypeError(CONTENT_ERROR);
            };
          }
          return Reflect.get(target, prop);
        },
      }),
    } as Env;
    const { result: res, logs } = await withLogs(async () => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${BASE}/auth/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify({ email: VICTIM }),
        }),
        kvDown,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('Maria'); // opaque to the caller, as ever
    expect(logs.named('unhandled_error')).toEqual([
      {
        event: 'unhandled_error',
        method: 'POST',
        path: '/auth/request',
        err: { name: 'TypeError' },
        level: 'error',
      },
    ]);
  });

  it('route_error (the HTTP route adapter)', async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountRoutes(app, [
      defineRoute({
        method: 'POST',
        path: '/api/summaries',
        permission: 'authenticated',
        audit: false,
        input: z.object({}),
        handler: async () => {
          throw new Error(CONTENT_ERROR);
        },
      }),
    ]);
    const { result: res, logs } = await withLogs(async () =>
      app.request(
        `${BASE}/api/summaries`,
        {
          method: 'POST',
          headers: {
            cookie: await cookieFor(USERS.member),
            origin: BASE,
            'content-type': 'application/json',
          },
          body: '{}',
        },
        env,
        createExecutionContext(),
      ),
    );
    expect(res.status).toBe(500);
    expect(logs.named('route_error')).toEqual([
      {
        event: 'route_error',
        method: 'POST',
        path: '/api/summaries',
        err: { name: 'Error' },
        level: 'error',
      },
    ]);
  });

  it('mcp_tool_error (the MCP adapter): the agent gets "Internal error.", the log gets a class', async () => {
    const [tool] = buildMcpTools([
      defineRoute({
        method: 'POST',
        path: '/api/summaries',
        permission: 'authenticated',
        audit: false,
        input: z.object({ note: z.string() }),
        handler: async (_ctx, input) => {
          // A tool failure whose message quotes the tool's own arguments — the classic leak.
          throw Object.assign(new Error(`could not summarize: ${input.note}`), {
            code: 'provider said: see https://x.example/?q=maria',
          });
        },
      }),
    ]);
    if (!tool) throw new Error('tool was not built');
    const principal: Principal = {
      kind: 'person',
      email: USERS.member,
      name: 'member user',
      role: 'member',
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      tokenScopes: null,
    };
    const { result, logs } = await withLogs(
      () => tool.invoke(env, principal, { note: CONTENT_ERROR }),
      [USERS.member, 'could not summarize', 'provider said'],
    );
    expect(result).toEqual({ content: [{ type: 'text', text: 'Internal error.' }], isError: true });
    expect(logs.named('mcp_tool_error')).toEqual([
      {
        event: 'mcp_tool_error',
        method: 'POST',
        path: '/api/summaries',
        err: { name: 'Error', code: '[redacted:url]' },
        level: 'error',
      },
    ]);
  });
});

describe('log hygiene — the AI client logs the provider status and error type, never the body', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const gatewayEnv = (): Env => ({
    ...env,
    ANTHROPIC_API_KEY: 'sk-ant-test-synthetic',
    AI_GATEWAY_ID: 'all-pr-apps',
    AI_GATEWAY_TOKEN: 'gw-test-token',
    CF_ACCOUNT_ID: 'acct-test-123',
  });

  async function failedCall(response: Response) {
    return withLogs(async () => {
      await expect(
        callAnthropic(
          gatewayEnv(),
          USERS.member,
          { messages: [{ role: 'user', content: SENTENCE }], maxTokens: 100 },
          async () => response,
        ),
      ).rejects.toMatchObject({ code: 'ai_upstream_error', status: 502 });
    }, [USERS.member]);
  }

  it('an Anthropic error body: status + error.type — the message (which can echo the prompt) is dropped', async () => {
    const { logs } = await failedCall(
      Response.json(
        { type: 'error', error: { type: 'overloaded_error', message: `echo: ${CONTENT_ERROR}` } },
        { status: 529 },
      ),
    );
    expect(logs.named('ai_call_failed')).toEqual([
      { event: 'ai_call_failed', status: 529, error_type: 'overloaded_error', level: 'error' },
    ]);
  });

  it('an AI Gateway error body: its numeric code', async () => {
    const { logs } = await failedCall(
      Response.json(
        { success: false, error: [{ code: 2009, message: `Unauthorized ${VICTIM}` }] },
        { status: 401 },
      ),
    );
    expect(logs.named('ai_call_failed')).toEqual([
      { event: 'ai_call_failed', status: 401, error_type: 'gateway_2009', level: 'error' },
    ]);
  });

  it('a non-JSON or content-shaped body: "unknown" — never the text', async () => {
    const plain = await failedCall(new Response(CONTENT_ERROR, { status: 500 }));
    expect(plain.logs.named('ai_call_failed')[0]).toMatchObject({ error_type: 'unknown' });
    // The client's own shape check refuses it before the logger's screens would mark it.
    const stuffed = await failedCall(
      Response.json({ error: { type: CONTENT_ERROR } }, { status: 400 }),
    );
    expect(stuffed.logs.named('ai_call_failed')[0]).toMatchObject({ error_type: 'unknown' });
  });
});
