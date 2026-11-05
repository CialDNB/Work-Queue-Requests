import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Env } from '../../src/env';
import { defineRoute, mountRoutes } from '../../src/framework/defineRoute';
import { fail, ok } from '../../src/framework/envelope';
import { notFound } from '../../src/framework/errors';
import { errorClass } from '../../src/framework/execute';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { cookieFor } from '../helpers/http';
import { eventNames } from '../helpers/logs';

describe('defineRoute definition-time guards', () => {
  it('rejects mutating routes without a declared audit action', () => {
    expect(() =>
      defineRoute({
        method: 'POST',
        path: '/api/things',
        permission: 'authenticated',
        input: z.object({}),
        handler: async () => ({}),
      }),
    ).toThrow(/audit/);
  });

  it('accepts an explicit audit opt-out', () => {
    expect(() =>
      defineRoute({
        method: 'POST',
        path: '/api/things',
        permission: 'authenticated',
        audit: false,
        input: z.object({}),
        handler: async () => ({}),
      }),
    ).not.toThrow();
  });

  it('rejects :param routes without a uniformity fixture', () => {
    expect(() =>
      defineRoute({
        method: 'GET',
        path: '/api/things/:id',
        permission: 'authenticated',
        input: z.object({ id: z.string() }),
        handler: async () => ({}),
      }),
    ).toThrow(/uniformityFixture/);
  });

  it('rejects a rateLimit with a non-positive or non-integer limit/window', () => {
    for (const rl of [
      { limit: 0, windowSec: 60 },
      { limit: 10, windowSec: 0 },
      { limit: -1, windowSec: 60 },
      { limit: 1.5, windowSec: 60 },
    ]) {
      expect(() =>
        defineRoute({
          method: 'GET',
          path: '/api/rl',
          permission: 'authenticated',
          input: z.object({}),
          rateLimit: rl,
          handler: async () => ({}),
        }),
      ).toThrow(/rateLimit/);
    }
  });
});

describe('defineRoute request handling', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  function appWith(routes: Parameters<typeof mountRoutes>[1]): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    mountRoutes(app, routes);
    return app;
  }

  it('input precedence: path params > query > body', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/echo/:id',
        permission: 'authenticated',
        audit: false,
        input: z.object({ id: z.string(), extra: z.string().optional() }),
        uniformityFixture: { seed: async () => ({ id: 'fixture' }) },
        handler: async (_ctx, input) => input,
      }),
    ]);
    const res = await app.request(
      'https://x.test/api/echo/from-path?id=from-query',
      {
        method: 'POST',
        headers: {
          cookie: await cookieFor(USERS.member),
          origin: 'https://x.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id: 'from-body', extra: 'kept' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; extra: string } };
    expect(body.data.id).toBe('from-path');
    expect(body.data.extra).toBe('kept');
  });

  it('renders unknown errors as an opaque 500 (no internals leak)', async () => {
    const app = appWith([
      defineRoute({
        method: 'GET',
        path: '/api/boom',
        permission: 'authenticated',
        input: z.object({}),
        handler: async () => {
          throw new Error('secret-internal-detail-xyz');
        },
      }),
    ]);
    const res = await app.request(
      'https://x.test/api/boom',
      { headers: { cookie: await cookieFor(USERS.member) } },
      env,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('secret-internal-detail-xyz');
    const body = JSON.parse(text) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('Internal error');
  });

  it('rate limits per principal once the window limit is hit, with a Retry-After header', async () => {
    const app = appWith([
      defineRoute({
        method: 'GET',
        path: '/api/limited',
        permission: 'authenticated',
        input: z.object({}),
        rateLimit: { limit: 2, windowSec: 60 },
        handler: async () => ({ ok: true }),
      }),
    ]);
    const cookie = await cookieFor(USERS.member);
    const hit = () => app.request('https://x.test/api/limited', { headers: { cookie } }, env);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
  });

  it('applies rateLimit AFTER the permission check (a forbidden caller stays 404, never 429)', async () => {
    // viewer lacks `ai.use`; even past the limit the permission denial wins, proving the
    // rate-limit never fires for — and so never leaks the existence of — a forbidden route.
    const app = appWith([
      defineRoute({
        method: 'GET',
        path: '/api/limited-perm',
        permission: 'ai.use',
        input: z.object({}),
        rateLimit: { limit: 1, windowSec: 60 },
        handler: async () => ({ ok: true }),
      }),
    ]);
    const cookie = await cookieFor(USERS.viewer);
    for (let i = 0; i < 3; i++) {
      const res = await app.request(
        'https://x.test/api/limited-perm',
        { headers: { cookie } },
        env,
      );
      expect(res.status).toBe(404);
    }
  });

  it('requires authentication on every route (fail-closed)', async () => {
    const app = appWith([
      defineRoute({
        method: 'GET',
        path: '/api/secret',
        permission: 'authenticated',
        input: z.object({}),
        handler: async () => ({ ok: true }),
      }),
    ]);
    const res = await app.request('https://x.test/api/secret', {}, env);
    expect(res.status).toBe(401);
  });
});

// The framework is the SINGLE writer of a route's declared audit action: it fires exactly
// once on success, never twice. These guard the contract that replaced the old double-write
// (handler ctx.audit() + framework auto-fire both stamping the append-only log).
describe('defineRoute audit-on-write (single writer)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  function appWith(routes: Parameters<typeof mountRoutes>[1]): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    mountRoutes(app, routes);
    return app;
  }

  const mutate = async (
    app: Hono<{ Bindings: Env }>,
    method: string,
    url: string,
  ): Promise<Response> =>
    app.request(
      url,
      {
        method,
        headers: {
          cookie: await cookieFor(USERS.member),
          origin: 'https://x.test',
          'content-type': 'application/json',
        },
        body: '{}',
      },
      env,
    );

  async function auditRows(action: string) {
    const rows = await env.DB.prepare(
      'SELECT action, target, payload_json FROM audit_log WHERE action = ? ORDER BY id',
    )
      .bind(action)
      .all<{ action: string; target: string | null; payload_json: string | null }>();
    return rows.results;
  }

  it('writes the declared action exactly once, defaulting the target to the path param', async () => {
    const app = appWith([
      defineRoute({
        method: 'PUT',
        path: '/api/widgets/:id',
        permission: 'authenticated',
        audit: 'widget.update',
        input: z.object({ id: z.string() }),
        uniformityFixture: { seed: async () => ({ id: 'fixture' }) },
        handler: async () => ({ ok: true }),
      }),
    ]);
    const res = await mutate(app, 'PUT', 'https://x.test/api/widgets/w-1');
    expect(res.status).toBe(200);
    const rows = await auditRows('widget.update');
    expect(rows.length).toBe(1); // exactly one — no double-write
    expect(rows[0]?.target).toBe('w-1'); // defaulted to the :id path param
    expect(rows[0]?.payload_json).toBeNull(); // no noisy {params} payload
  });

  it('setAuditTarget names the target and attaches the payload for the single row', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: 'widget.create',
        input: z.object({}),
        handler: async (ctx) => {
          ctx.setAuditTarget('w-42', { color: 'blue' }); // URL carries no id on a create
          return { id: 'w-42' };
        },
      }),
    ]);
    const res = await mutate(app, 'POST', 'https://x.test/api/widgets');
    expect(res.status).toBe(200);
    const rows = await auditRows('widget.create');
    expect(rows.length).toBe(1);
    expect(rows[0]?.target).toBe('w-42'); // the handler-named id, not a null path param
    expect(JSON.parse(rows[0]?.payload_json ?? '{}')).toEqual({ color: 'blue' });
  });

  it('does not write the audit row when the handler throws', async () => {
    const app = appWith([
      defineRoute({
        method: 'DELETE',
        path: '/api/widgets/:id',
        permission: 'authenticated',
        audit: 'widget.delete',
        input: z.object({ id: z.string() }),
        uniformityFixture: { seed: async () => ({ id: 'fixture' }) },
        handler: async () => {
          throw notFound();
        },
      }),
    ]);
    const res = await mutate(app, 'DELETE', 'https://x.test/api/widgets/gone');
    expect(res.status).toBe(404);
    expect((await auditRows('widget.delete')).length).toBe(0);
  });

  it('writes nothing when audit is false, even if setAuditTarget is called', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: false,
        input: z.object({}),
        handler: async (ctx) => {
          ctx.setAuditTarget('w-99'); // shaping a row that is never written
          return { ok: true };
        },
      }),
    ]);
    const res = await mutate(app, 'POST', 'https://x.test/api/widgets');
    expect(res.status).toBe(200);
    const all = await env.DB.prepare('SELECT id FROM audit_log').all();
    expect(all.results.length).toBe(0);
  });

  // AICOE-449: the declared write fires only on handler SUCCESS. A handler that reports
  // failure by RETURNING an error Response (the documented custom-status contract) must not
  // produce a success audit row — before this fix it did, exactly like a 200.
  it('does not write the audit row when the handler returns fail(4xx)', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: 'widget.create',
        input: z.object({}),
        handler: async () => fail(409, 'conflict', 'nope'),
      }),
    ]);
    const res = await mutate(app, 'POST', 'https://x.test/api/widgets');
    expect(res.status).toBe(409); // the Response passes through untouched
    expect((await auditRows('widget.create')).length).toBe(0); // no success row for a failure
  });

  it('does not write the audit row for a handler-returned 5xx Response either', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: 'widget.create',
        input: z.object({}),
        handler: async () => new Response(null, { status: 503 }),
      }),
    ]);
    const res = await mutate(app, 'POST', 'https://x.test/api/widgets');
    expect(res.status).toBe(503);
    expect((await auditRows('widget.create')).length).toBe(0);
  });

  it('still writes the row for a success Response with a custom status (ok(…, 201))', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: 'widget.create',
        input: z.object({}),
        handler: async (ctx) => {
          ctx.setAuditTarget('w-201');
          return ok({ id: 'w-201' }, 201);
        },
      }),
    ]);
    const res = await mutate(app, 'POST', 'https://x.test/api/widgets');
    expect(res.status).toBe(201);
    expect((await auditRows('widget.create')).length).toBe(1); // 2xx Responses still audit
  });

  it('defaults the target to null on a create with no setAuditTarget and no path params', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: 'widget.create',
        input: z.object({}),
        handler: async () => ({ ok: true }), // never names a target
      }),
    ]);
    const res = await mutate(app, 'POST', 'https://x.test/api/widgets');
    expect(res.status).toBe(200);
    const rows = await auditRows('widget.create');
    expect(rows.length).toBe(1);
    expect(rows[0]?.target).toBeNull(); // ?? null default, not undefined leaking into D1
  });

  // AICOE-449: a failed declared insert is FAIL-OPEN (the mutation already committed; a 500
  // would misreport completed work) but never silent — it logs the structured event and
  // schedules the ops alert on waitUntil. DECISIONS 2026-08-03.
  it('a failed declared audit insert keeps the 2xx, logs, and schedules the alert', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: 'widget.create',
        input: z.object({}),
        handler: async () => ({ ok: true }),
      }),
    ]);
    // Make the insert fail for real: drop the table the audit repo writes to.
    await env.DB.prepare('DROP TABLE audit_log').run();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduled: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => {
        scheduled.push(p);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    try {
      const res = await app.request(
        'https://x.test/api/widgets',
        {
          method: 'POST',
          headers: {
            cookie: await cookieFor(USERS.member),
            origin: 'https://x.test',
            'content-type': 'application/json',
          },
          body: '{}',
        },
        env,
        executionCtx,
      );
      expect(res.status).toBe(200); // fail-open: the mutation result is unchanged
      expect(eventNames(errorSpy.mock.calls)).toContain('audit_declared_write_failed'); // …but never silent
      expect(scheduled.length).toBe(1); // the alert-seam send was scheduled
      await expect(scheduled[0]).resolves.toBeDefined(); // and its promise never rejects
    } finally {
      errorSpy.mockRestore();
      await applySchema(); // restore the dropped table for subsequent suites
      await seedDb();
    }
  });

  it('a broken waitUntil cannot turn fail-open into a 500', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: 'widget.create',
        input: z.object({}),
        handler: async () => ({ ok: true }),
      }),
    ]);
    await env.DB.prepare('DROP TABLE audit_log').run();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const executionCtx = {
      waitUntil: () => {
        throw new Error('executionCtx is gone');
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    try {
      const res = await app.request(
        'https://x.test/api/widgets',
        {
          method: 'POST',
          headers: {
            cookie: await cookieFor(USERS.member),
            origin: 'https://x.test',
            'content-type': 'application/json',
          },
          body: '{}',
        },
        env,
        executionCtx,
      );
      expect(res.status).toBe(200); // still fail-open
      expect(eventNames(errorSpy.mock.calls)).toContain('audit_alert_schedule_failed');
    } finally {
      errorSpy.mockRestore();
      await applySchema();
      await seedDb();
    }
  });

  it('errorClass names Error classes and degrades to "error" for non-Errors', () => {
    expect(errorClass(new RangeError('x'))).toBe('RangeError');
    expect(errorClass('a thrown string')).toBe('error');
  });

  // GATE BOUNDARY pins (panel finding: `> 400` and `>= 300` mutants survived the interior
  // tests). 400 is the most common client-error status — it must skip the audit; a 3xx is
  // not a failure — it must still audit, exactly as every returned Response did pre-change.
  it('a handler-returned 400 Response writes no audit row (the exact gate edge)', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: 'widget.create',
        input: z.object({}),
        handler: async () => fail(400, 'bad_request', 'nope'),
      }),
    ]);
    const res = await mutate(app, 'POST', 'https://x.test/api/widgets');
    expect(res.status).toBe(400);
    expect((await auditRows('widget.create')).length).toBe(0);
  });

  it('a handler-returned 3xx Response still audits (redirects are not failures)', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: 'widget.create',
        input: z.object({}),
        handler: async () => new Response(null, { status: 303, headers: { location: '/x' } }),
      }),
    ]);
    const res = await mutate(app, 'POST', 'https://x.test/api/widgets');
    expect(res.status).toBe(303);
    expect((await auditRows('widget.create')).length).toBe(1);
  });

  // Panel finding: without a throttle, a sustained audit_log outage fires the full alert
  // fanout on EVERY mutation — flooding the shared webhook and rate-limiting away the
  // cron-failure page riding the same channel. One alert per action per window; KV-down
  // fails open (noise beats silence when everything is failing at once).
  it('repeat audit-write failures suppress the alert within the window; KV-down alerts anyway', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/floods',
        permission: 'authenticated',
        audit: 'widget.flood', // own action → own KV suppression key, isolated from other tests
        input: z.object({}),
        handler: async () => ({ ok: true }),
      }),
    ]);
    await env.DB.prepare('DROP TABLE audit_log').run();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduled: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => {
        scheduled.push(p);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const post = async (e: Env) =>
      app.request(
        'https://x.test/api/floods',
        {
          method: 'POST',
          headers: {
            cookie: await cookieFor(USERS.member),
            origin: 'https://x.test',
            'content-type': 'application/json',
          },
          body: '{}',
        },
        e,
        executionCtx,
      );
    try {
      expect((await post(env)).status).toBe(200); // 1st failure: alert goes out
      expect((await post(env)).status).toBe(200); // 2nd: suppressed by the window
      await Promise.allSettled(scheduled);
      const events = eventNames(errorSpy.mock.calls);
      expect(events.filter((e) => e === 'audit_declared_write_failed').length).toBe(2);
      expect(events.filter((e) => e === 'audit_fail_alert_suppressed').length).toBe(1);

      // KV down FOR THE GATE: only the suppression keys throw (sessions still resolve, so
      // auth works) → the gate fails open and the alert goes out anyway.
      errorSpy.mockClear();
      const flakyKv = new Proxy(env.SESSIONS, {
        get(target, prop) {
          if (prop === 'get' || prop === 'put') {
            return (key: string, ...rest: unknown[]) => {
              if (key.includes('alert:audit_fail')) throw new Error('KV degraded');
              // biome-ignore lint/suspicious/noExplicitAny: test-only passthrough
              return (target as any)[prop](key, ...rest);
            };
          }
          return Reflect.get(target, prop);
        },
      });
      const brokenKv = { ...env, SESSIONS: flakyKv } as unknown as Env;
      expect((await post(brokenKv)).status).toBe(200);
      await Promise.allSettled(scheduled);
      const events2 = eventNames(errorSpy.mock.calls);
      expect(events2.includes('audit_fail_alert_suppressed')).toBe(false); // gate failed open
      await expect(scheduled[scheduled.length - 1]).resolves.toBeDefined();
    } finally {
      errorSpy.mockRestore();
      await applySchema();
      await seedDb();
    }
  });
});

// Bodiless mutations (AICOE-398). A browser's fetch wrapper advertises `content-type:
// application/json` on EVERY request, bodiless DELETEs included — and the framework used to call
// c.req.json() on that empty body and 400 with "Invalid JSON body". Net: every delete button in
// every fork was broken. The suite missed it because the test client only sent the header
// alongside a body, i.e. it was politer than the real client. These pin the browser's actual
// shapes, so the reproduction lives in CI rather than in a bug report.
describe('defineRoute — bodiless mutations advertising a JSON content-type', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const app = (): Hono<{ Bindings: Env }> => {
    const a = new Hono<{ Bindings: Env }>();
    mountRoutes(a, [
      // No :param — a param route would need a uniformityFixture (the 404-uniformity guard),
      // which is orthogonal to what these tests are about: the empty-body parse.
      defineRoute({
        method: 'DELETE',
        path: '/api/things',
        permission: 'authenticated',
        audit: 'thing.delete',
        input: z.object({}), // nothing required — a bodiless DELETE must satisfy it
        handler: async () => ({ deleted: true }),
      }),
      defineRoute({
        method: 'POST',
        path: '/api/things',
        permission: 'authenticated',
        audit: 'thing.create',
        input: z.object({ title: z.string() }), // REQUIRES a body field
        handler: async () => ({ created: true }),
      }),
    ]);
    return a;
  };

  const send = async (method: string, url: string, body?: string): Promise<Response> =>
    app().request(
      url,
      {
        method,
        headers: {
          cookie: await cookieFor(USERS.member),
          origin: 'https://x.test',
          'content-type': 'application/json', // always — this is what browsers do
        },
        ...(body === undefined ? {} : { body }),
      },
      env,
    );

  // The exact request the SPA sends when a user clicks delete.
  it('bodiless DELETE succeeds (the browser shape that used to 400)', async () => {
    const res = await send('DELETE', 'https://x.test/api/things');
    expect(res.status).toBe(200);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n  '],
  ])('DELETE with a %s body succeeds (no body input, not malformed)', async (_label, body) => {
    const res = await send('DELETE', 'https://x.test/api/things', body);
    expect(res.status).toBe(200);
  });

  // The relaxation must NOT swallow genuinely broken payloads.
  it('a NON-EMPTY malformed body is still a hard 400', async () => {
    const res = await send('DELETE', 'https://x.test/api/things', 'not json');
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { message: string } }>()).error.message).toBe(
      'Invalid JSON body',
    );
  });

  it('a non-object JSON body is still a hard 400', async () => {
    const res = await send('DELETE', 'https://x.test/api/things', '[1,2]');
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { message: string } }>()).error.message).toBe(
      'Body must be a JSON object',
    );
  });

  // The load-bearing one: an empty body must not become a validation BYPASS. It contributes no
  // keys, so Zod still rejects the missing field — and says so specifically, which is strictly
  // more useful than the old blanket "Invalid JSON body".
  it('an empty body does NOT bypass validation on a route with required fields', async () => {
    const res = await send('POST', 'https://x.test/api/things', '');
    expect(res.status).toBe(400);
    const msg = (await res.json<{ error: { message: string } }>()).error.message;
    expect(msg).not.toBe('Invalid JSON body');
    expect(msg.toLowerCase()).toContain('title');
  });
});
