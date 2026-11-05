// `ctx.readUpstream` — the upstream ledger (PIA C15) as a route sees it. The seam's own posture is
// pinned in test/data/upstream.test.ts; this file pins what the FRAMEWORK adds:
//
//   1. WHO, WHICH ROUTE, WHICH REQUEST come from the pipeline, never from the handler. The row's
//      principal is the caller, its route is the route pattern (never a path value), and every
//      ledger row of one call — upstream and, when READ_AUDIT is armed, d1 — carries ONE request
//      id, decided once in executeRoute for both streams.
//   2. IT RECORDS WHETHER OR NOT READ_AUDIT IS ARMED, like the aurora seam: calling it is the
//      opt-in, and a client-class read's fail-closed posture cannot hang on a var.
//   3. FAIL-CLOSED REACHES THE WIRE AS THE KIT'S OPAQUE 500, over HTTP and over MCP, because both
//      adapters are shells over one executeRoute.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import type { ReadLogRow, ReadSourceClass } from '../../src/data/readLog';
import {
  __defineUpstreamReadForTest,
  __resetUpstreamRegistryForTest,
  requireUpstreamGrant,
  type UpstreamReadSpec,
} from '../../src/data/upstream';
import type { Env } from '../../src/env';
import { defineRoute, mountRoutes, type RouteSpec } from '../../src/framework/defineRoute';
import { executeRoute } from '../../src/framework/execute';
import { beginReadAudit } from '../../src/framework/readAudit';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { cookieFor } from '../helpers/http';

const SOURCES: Record<string, ReadSourceClass> = { autobahn: 'client', stats_bureau: 'internal' };
const ARMED = { ...env, READ_AUDIT: 'on' } as Env;
const UNARMED = env as Env;

const principal: Principal = {
  kind: 'person',
  email: USERS.admin,
  name: null,
  role: 'admin',
  authMethod: 'magic_link',
  credentialTransport: 'cookie',
};

let REPORT: UpstreamReadSpec;
let SERIES: UpstreamReadSpec;

function register(): void {
  REPORT = __defineUpstreamReadForTest(
    { source: 'autobahn' as never, name: 'report_datablocks', target: 'ticket_key' },
    SOURCES,
  );
  SERIES = __defineUpstreamReadForTest(
    { source: 'stats_bureau' as never, name: 'series_by_id', target: 'series_id' },
    SOURCES,
  );
}

function route(path: string, handler: RouteSpec<z.ZodTypeAny>['handler']): RouteSpec<z.ZodTypeAny> {
  return defineRoute({
    method: 'GET',
    path,
    permission: 'authenticated',
    input: z.object({}),
    handler,
  }).spec;
}

async function run(e: Env, spec: RouteSpec<z.ZodTypeAny>, input: unknown = {}): Promise<unknown> {
  const pending: Promise<unknown>[] = [];
  try {
    return await executeRoute(e, spec, principal, {
      ip: '',
      params: {},
      request: new Request('https://x.test/api/t'),
      waitUntil: (p) => {
        pending.push(p);
      },
      buildRawInput: () => input,
      invocation: { via: 'http' },
    });
  } finally {
    // Twice: a flush can schedule an alert, which is itself background work.
    await Promise.allSettled(pending);
    await Promise.allSettled(pending);
  }
}

const rows = async (): Promise<ReadLogRow[]> =>
  (await makeDb(env as Env).readLog.list({ limit: 100 })).items;

describe('ctx.readUpstream — attribution comes from the pipeline', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    register();
  });
  afterEach(__resetUpstreamRegistryForTest);

  it('records the caller, the route PATTERN and the declared target — unarmed', async () => {
    const ticketKey = 'INS-2026-0042';
    const result = await run(
      UNARMED,
      defineRoute({
        method: 'GET',
        path: '/api/reports/:ticketKey/data',
        permission: 'authenticated',
        input: z.object({ ticketKey: z.string() }),
        // Required of every :param route; this one is never mounted, so it is never seeded.
        uniformityFixture: { seed: async () => ({ ticketKey: 'INS-0000-0000' }) },
        handler: async (ctx, input) =>
          ctx.readUpstream(REPORT, async () => ({ status: 'ok', ticket: input.ticketKey })),
      }).spec as RouteSpec<z.ZodTypeAny>,
      { ticketKey },
    );
    expect(result).toEqual({ status: 'ok', ticket: ticketKey });
    const [row] = await rows();
    expect(row).toMatchObject({
      principal: USERS.admin,
      route: 'GET /api/reports/:ticketKey/data',
      kind: 'upstream',
      source: 'autobahn',
      source_class: 'client',
      query_name: 'report_datablocks',
      target: 'ticket_key',
      row_count: 1,
    });
    expect(row?.request_id).toMatch(/^[0-9a-f-]{36}$/);
    // The value the route was called with never reaches the ledger.
    expect(JSON.stringify(await rows())).not.toContain(ticketKey);
  });

  it('gives every upstream read of one request the same request id, and the next request another', async () => {
    const spec = route('/api/two-reads', async (ctx) => {
      await ctx.readUpstream(REPORT, async () => [1]);
      await ctx.readUpstream(SERIES, async () => [1, 2]);
      return null;
    });
    await run(UNARMED, spec);
    await run(UNARMED, spec);
    const all = await rows();
    expect(all).toHaveLength(4);
    const ids = new Set(all.map((r) => r.request_id));
    expect(ids.size).toBe(2);
    for (const id of ids) {
      expect(
        all
          .filter((r) => r.request_id === id)
          .map((r) => r.source)
          .sort(),
      ).toEqual(['autobahn', 'stats_bureau']);
    }
  });

  it('armed: the upstream row shares its request id with the request’s d1 rows', async () => {
    await run(
      ARMED,
      route('/api/mixed', async (ctx) => {
        await ctx.db.notes.list({ limit: 5 });
        return ctx.readUpstream(REPORT, async () => [1, 2]);
      }),
    );
    const all = await rows();
    expect(all.map((r) => r.kind).sort()).toEqual(['d1', 'upstream']);
    expect(new Set(all.map((r) => r.request_id)).size).toBe(1);
  });

  // Upstream first, then D1, then upstream again: whichever stream a call touches first, both
  // carry the one id the call decided before either ran.
  it('armed: every row of one call carries ONE id, whatever order the streams are read in', async () => {
    await run(
      ARMED,
      route('/api/interleaved', async (ctx) => {
        await ctx.readUpstream(SERIES, async () => [1]);
        await ctx.db.notes.list({ limit: 5 });
        return ctx.readUpstream(REPORT, async () => [1, 2]);
      }),
    );
    const all = await rows();
    expect(all.map((r) => r.kind).sort()).toEqual(['d1', 'upstream', 'upstream']);
    expect(new Set(all.map((r) => r.request_id)).size).toBe(1);
  });

  // The seam that makes "one place" possible: the recorder takes the call's id instead of minting
  // its own, so executeRoute decides it once for both streams (and a correlation id a caller
  // supplies — an agent turn — is set there, once, and reaches both).
  it('the d1 recorder carries the id it is given, and mints one only when given none', () => {
    expect(beginReadAudit(USERS.admin, 'GET /api/x', 'turn-1234').requestId).toBe('turn-1234');
    expect(beginReadAudit(USERS.admin, 'GET /api/x').requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  // The grant reaches a route's thunk through the pipeline, so an integration module that requires
  // one works from ctx.readUpstream — and only from there.
  it('hands the thunk a live grant for its source, which an integration module accepts', async () => {
    let fetched = 0;
    const result = await run(
      UNARMED,
      route('/api/granted', async (ctx) =>
        ctx.readUpstream(REPORT, async (grant) => {
          requireUpstreamGrant(grant, 'autobahn' as never);
          fetched += 1;
          return [1];
        }),
      ),
    );
    expect(result).toEqual([1]);
    expect(fetched).toBe(1);
  });

  it('a request that reads no upstream writes no upstream row', async () => {
    await run(
      UNARMED,
      route('/api/no-upstream', async () => ({ ok: true })),
    );
    expect(await rows()).toEqual([]);
  });
});

describe('ctx.readUpstream — fail-closed reaches every adapter as the opaque 500', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    register();
  });
  afterEach(async () => {
    __resetUpstreamRegistryForTest();
    await applySchema();
  });

  it('HTTP: an unwritable ledger answers 500 internal_error, and the upstream is never called', async () => {
    let called = 0;
    const app = new Hono<{ Bindings: Env }>();
    mountRoutes(app, [
      defineRoute({
        method: 'GET',
        path: '/api/live-report',
        permission: 'authenticated',
        input: z.object({}),
        handler: async (ctx) =>
          ctx.readUpstream(REPORT, async () => {
            called += 1;
            return { status: 'ok' };
          }),
      }),
    ]);
    await env.DB.prepare('DROP TABLE read_log').run();
    const pending: Promise<unknown>[] = [];
    const res = await app.request(
      'https://x.test/api/live-report',
      { headers: { cookie: await cookieFor(USERS.member) } },
      UNARMED,
      {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    await Promise.allSettled(pending);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('internal_error');
    expect(JSON.stringify(body)).not.toMatch(/read_log|autobahn|ticket_key/);
    expect(called).toBe(0);
  });

  it('MCP: the same route as a tool is refused the same way', async () => {
    const { buildMcpTools } = await import('../../src/mcp/tools');
    let called = 0;
    const [tool] = buildMcpTools([
      defineRoute({
        method: 'GET',
        path: '/api/mcp-live-report',
        permission: 'authenticated',
        input: z.object({}),
        handler: async (ctx) =>
          ctx.readUpstream(REPORT, async () => {
            called += 1;
            return { status: 'ok' };
          }),
      }),
    ]);
    await env.DB.prepare('DROP TABLE read_log').run();
    const result = await tool?.invoke(UNARMED, principal, {});
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/read_log|autobahn|ticket_key/);
    expect(called).toBe(0);
  });

  it('an internal-class read still answers when the ledger is down', async () => {
    await env.DB.prepare('DROP TABLE read_log').run();
    const result = await run(
      UNARMED,
      route('/api/series', async (ctx) => ctx.readUpstream(SERIES, async () => [1, 2, 3])),
    );
    expect(result).toEqual([1, 2, 3]);
  });
});
