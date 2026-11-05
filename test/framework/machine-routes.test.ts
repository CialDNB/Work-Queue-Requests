// `RouteSpec.machine: true` (insights D1 growth plan B9). A machine route is reachable ONLY by a
// service principal holding the route's permission: a person — on a session or on a personal
// token, of any role — gets the uniform 404, exactly as if the route were not there. On the way
// through, the framework requires a valid X-Sync-Run (or runs warn-only), stamps the validated id
// on the audit payload, and caps that payload at 1 KB. One declared audit row per request stays
// the invariant. Every identity and value here is synthetic.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ALL_ROLES, can, NON_DELEGABLE, type PermissionKey } from '../../src/auth/permissions';
import { mintApiTokenFor, resolveApiTokenByHash, sha256Hex } from '../../src/auth/tokens';
import type { PersonPrincipal, Principal, Role } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { defineRoute, mountRoutes, type RouteDef } from '../../src/framework/defineRoute';
import { buildManifest } from '../../src/framework/manifest';
import { buildMcpTools, toolsForPrincipal } from '../../src/mcp/tools';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { cookieFor } from '../helpers/http';
import { loggedEvents } from '../helpers/logs';

const ORIGIN = 'https://x.test';
const SVC = 'svc-etl@test-app.invalid';
const OWNER: PersonPrincipal = {
  kind: 'person',
  email: USERS.owner,
  name: null,
  role: 'owner',
  authMethod: 'magic_link',
  credentialTransport: 'cookie',
};

// The routes below are gated by `notes.write`, and the notes rows of PERMISSIONS belong to the app:
// a fork may give that key to fewer roles than the kit does (Insights: owner and admin only). So the
// person callers are picked by can(), never by role name, and the file holds in any fork.
const WRITER_ROLE = ALL_ROLES.find((r) => can(r, 'notes.write')) as Role;
const NON_WRITER_ROLE = ALL_ROLES.find((r) => !can(r, 'notes.write'));

let handlerCalls = 0;
let seenRunId: string | null | undefined;

/** The route under test: a machine batch endpoint any `notes.write` holder could otherwise reach. */
function machineBatch(payload?: () => Record<string, unknown>): RouteDef {
  return defineRoute({
    method: 'POST',
    path: '/api/batches',
    permission: 'notes.write',
    machine: true,
    audit: 'batch.push',
    input: z.object({ rows: z.number().int().default(0) }),
    handler: async (ctx, input) => {
      handlerCalls++;
      seenRunId = ctx.syncRunId;
      ctx.setAuditTarget('company-1:3', payload ? payload() : { received: input.rows });
      return { ok: true };
    },
  });
}

/** The same route without the flag, for the "nothing changes off the machine path" pins. */
const plainBatch = defineRoute({
  method: 'POST',
  path: '/api/plain-batches',
  permission: 'notes.write',
  audit: 'batch.plain',
  input: z.object({}),
  handler: async (ctx) => {
    seenRunId = ctx.syncRunId;
    ctx.setAuditTarget('company-1:1', { received: 1, runId: 'handler-said-this' });
    return { ok: true };
  },
});

function appWith(routes: RouteDef[]): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  mountRoutes(app, routes);
  return app;
}

async function serviceToken(scope = 'notes.write', slug = 'etl'): Promise<string> {
  const principalId = `svc-${slug}@test-app.invalid`;
  const res = await makeDb(env).serviceIdentities.create({
    slug,
    principalId,
    name: `Synthetic ${slug}`,
    scope,
    custodianEmail: USERS.member,
    createdBy: USERS.owner,
  });
  if (!res.ok) throw new Error(res.reason);
  return (await mintApiTokenFor(makeDb(env), OWNER, principalId, { name: slug })).token;
}

async function personalToken(email: string): Promise<string> {
  return (await mintApiTokenFor(makeDb(env), OWNER, email, { name: 'personal' })).token;
}

type Auth = { bearer: string } | { cookieOf: string };

async function call(
  app: Hono<{ Bindings: Env }>,
  path: string,
  auth: Auth,
  opts: { syncRun?: string; body?: unknown; testEnv?: Env } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN };
  if ('bearer' in auth) headers.authorization = `Bearer ${auth.bearer}`;
  else headers.cookie = await cookieFor(auth.cookieOf);
  if (opts.syncRun !== undefined) headers['x-sync-run'] = opts.syncRun;
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const res = await app.request(
    `${ORIGIN}${path}`,
    { method: 'POST', headers, body: JSON.stringify(opts.body ?? {}) },
    opts.testEnv ?? env,
    executionCtx,
  );
  await Promise.allSettled(pending);
  return res;
}

interface AuditRow {
  actor_email: string;
  action: string;
  target: string | null;
  payload_json: string | null;
}

async function rows(action?: string): Promise<AuditRow[]> {
  const sql = action
    ? 'SELECT actor_email, action, target, payload_json FROM audit_log WHERE action = ? ORDER BY id'
    : 'SELECT actor_email, action, target, payload_json FROM audit_log ORDER BY id';
  const stmt = env.DB.prepare(sql);
  return (await (action ? stmt.bind(action) : stmt).all<AuditRow>()).results;
}

const payloadOf = (row: AuditRow | undefined): unknown => JSON.parse(row?.payload_json ?? 'null');

describe('machine routes — definition-time guards', () => {
  it("refuses machine: true on an 'authenticated' route (no service reaches one, no person may)", () => {
    expect(() =>
      defineRoute({
        method: 'POST',
        path: '/api/batches',
        permission: 'authenticated',
        machine: true,
        audit: 'batch.push',
        input: z.object({}),
        handler: async () => ({}),
      }),
    ).toThrow(/machine/);
  });

  it('refuses machine: true on a key no service may hold (the route would be unreachable)', () => {
    for (const permission of ['users.manage', 'audit.read', 'tokens.self'] as const) {
      expect(() =>
        defineRoute({
          method: 'POST',
          path: '/api/batches',
          permission,
          machine: true,
          audit: 'batch.push',
          input: z.object({}),
          handler: async () => ({}),
        }),
      ).toThrow(/machine/);
    }
    // Every non-delegable key: none is ever a service's scope, so a machine route behind one
    // would be unreachable. On the kit that includes P2-3's agent keys (agent.use, agent.erase),
    // but the loop names no key, so the case holds in a fork that took P1 and not P2-3; the agent
    // keys' own membership is pinned with P2-3, in test/auth/permissions.test.ts.
    expect(NON_DELEGABLE.size).toBeGreaterThan(0);
    for (const permission of [...NON_DELEGABLE] as PermissionKey[]) {
      expect(() =>
        defineRoute({
          method: 'POST',
          path: '/api/batches',
          permission,
          machine: true,
          audit: 'batch.push',
          input: z.object({}),
          handler: async () => ({}),
        }),
      ).toThrow(/machine/);
    }
  });

  it('refuses an `agent:` block on a machine route: the agent acts for a person, whom it 404s', () => {
    // The guard is P1's (src/framework/agentExposure.ts); this pins it through the real field.
    expect(() =>
      defineRoute({
        method: 'GET',
        path: '/api/machine-exposed',
        permission: 'notes.read',
        machine: true,
        needs: ['notes'],
        input: z.object({}),
        agent: { effect: 'read' },
        handler: async () => ({ ok: true }),
      }),
    ).toThrow(/machine-only route .* can never be exposed/);
  });

  it('accepts machine: true on a service-grantable key', () => {
    expect(() => machineBatch()).not.toThrow();
  });
});

describe('machine routes — who may call', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    handlerCalls = 0;
    seenRunId = undefined;
  });

  it('a PERSON on a session gets the uniform 404 — whatever the role — and nothing runs or is written', async () => {
    const app = appWith([machineBatch(), plainBatch]);
    // The reference 404: a person denied an ordinary route by permission.
    expect(NON_WRITER_ROLE, 'a role without notes.write, for the reference denial').toBeDefined();
    const reference = await call(app, '/api/plain-batches', {
      cookieOf: USERS[NON_WRITER_ROLE as Role],
    });
    expect(reference.status).toBe(404);
    const referenceBody = await reference.text();
    for (const who of [USERS.owner, USERS.admin, USERS.member, USERS.viewer]) {
      const res = await call(app, '/api/batches', { cookieOf: who }, { syncRun: 'run-1' });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(referenceBody);
    }
    expect(handlerCalls).toBe(0);
    expect(await rows('batch.push')).toEqual([]);
    expect(await rows('authz.denied')).toEqual([]); // person denials stay unaudited
  });

  it('a PERSON on a personal bearer token gets the same 404', async () => {
    const app = appWith([machineBatch()]);
    const token = await personalToken(USERS.owner);
    const res = await call(app, '/api/batches', { bearer: token }, { syncRun: 'run-1' });
    expect(res.status).toBe(404);
    expect(handlerCalls).toBe(0);
    expect(await rows('authz.denied')).toEqual([]);
  });

  it('the person 404 comes before the header check: no X-Sync-Run still reads as 404, not 400', async () => {
    const app = appWith([machineBatch()]);
    const res = await call(app, '/api/batches', { cookieOf: USERS.owner });
    expect(res.status).toBe(404);
  });

  it('a SERVICE holding the route permission gets through, once, with its run id', async () => {
    const app = appWith([machineBatch()]);
    const token = await serviceToken('notes.write');
    const res = await call(
      app,
      '/api/batches',
      { bearer: token },
      { syncRun: 'etl-2026-09-24T10:00:00Z.r1', body: { rows: 3 } },
    );
    expect(res.status).toBe(200);
    expect(handlerCalls).toBe(1);
    expect(seenRunId).toBe('etl-2026-09-24T10:00:00Z.r1');
    const written = await rows('batch.push');
    expect(written).toHaveLength(1); // one declared row per request
    expect(written[0]).toMatchObject({ actor_email: SVC, target: 'company-1:3' });
    expect(payloadOf(written[0])).toEqual({ received: 3, runId: 'etl-2026-09-24T10:00:00Z.r1' });
  });

  it('a SERVICE without the route permission still needs principalCan: 404 plus one authz.denied row', async () => {
    const app = appWith([machineBatch()]);
    const token = await serviceToken('notes.read');
    // No X-Sync-Run either: the permission 404 comes first.
    const res = await call(app, '/api/batches', { bearer: token });
    expect(res.status).toBe(404);
    expect(handlerCalls).toBe(0);
    const denied = await rows('authz.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ actor_email: SVC, target: 'POST /api/batches' });
  });
});

describe('machine routes — X-Sync-Run', () => {
  beforeAll(applySchema);
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await seedDb();
    handlerCalls = 0;
    seenRunId = undefined;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const INVALID = [
    '', // empty
    'x'.repeat(65), // too long
    'run 1', // space
    'run/1', // slash
    'run;drop', // punctuation outside the set
    'run-a, run-b', // a header sent twice arrives joined like this
    'run@1', // outside the set
  ];

  it('accepts 1-64 characters of [A-Za-z0-9._:-]', async () => {
    const app = appWith([machineBatch()]);
    const token = await serviceToken();
    for (const runId of ['a', 'x'.repeat(64), 'A-Z_a.z:0-9']) {
      const res = await call(app, '/api/batches', { bearer: token }, { syncRun: runId });
      expect(res.status).toBe(200);
      expect(seenRunId).toBe(runId);
    }
  });

  it('enforce (the default): a missing header is a 400 and nothing runs', async () => {
    const app = appWith([machineBatch()]);
    const token = await serviceToken();
    const res = await call(app, '/api/batches', { bearer: token });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /X-Sync-Run/,
    );
    expect(handlerCalls).toBe(0);
    expect(await rows('batch.push')).toEqual([]);
  });

  it('enforce: every invalid value is a 400, and the value is never echoed', async () => {
    const app = appWith([machineBatch()]);
    const token = await serviceToken();
    for (const runId of INVALID) {
      const res = await call(app, '/api/batches', { bearer: token }, { syncRun: runId });
      expect(res.status).toBe(400);
      if (runId.length > 1) expect(await res.text()).not.toContain(runId);
    }
    expect(handlerCalls).toBe(0);
  });

  it('a typo in MACHINE_SYNC_RUN stays enforcing', async () => {
    const app = appWith([machineBatch()]);
    const token = await serviceToken();
    for (const mode of ['warn-only', 'warning', 'off', 'false', '']) {
      const res = await call(
        app,
        '/api/batches',
        { bearer: token },
        { testEnv: { ...env, MACHINE_SYNC_RUN: mode } as Env },
      );
      expect(res.status).toBe(400);
    }
  });

  it('warn-only: a missing header goes through as runId null, with one content-free warning', async () => {
    const app = appWith([machineBatch()]);
    const token = await serviceToken();
    const res = await call(
      app,
      '/api/batches',
      { bearer: token },
      { testEnv: { ...env, MACHINE_SYNC_RUN: ' Warn ' } as Env },
    );
    expect(res.status).toBe(200);
    expect(seenRunId).toBeNull();
    expect(payloadOf((await rows('batch.push'))[0])).toMatchObject({ runId: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(loggedEvents(warn.mock.calls)).toEqual([
      { event: 'machine_sync_run_missing', route: 'POST /api/batches' },
    ]);
  });

  it('warn-only: a VALID header is used as in enforce mode — the run id reaches the handler and the row, no warning', async () => {
    // The adoption state itself: the caller has started sending X-Sync-Run while the app still
    // runs warn-only. Every row of that window must carry the id; audit_log cannot be backfilled.
    const app = appWith([machineBatch()]);
    const token = await serviceToken();
    const res = await call(
      app,
      '/api/batches',
      { bearer: token },
      {
        syncRun: 'run-ok',
        body: { rows: 2 },
        testEnv: { ...env, MACHINE_SYNC_RUN: 'warn' } as Env,
      },
    );
    expect(res.status).toBe(200);
    expect(seenRunId).toBe('run-ok');
    expect(payloadOf((await rows('batch.push'))[0])).toEqual({ received: 2, runId: 'run-ok' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warn-only: an invalid value is dropped — runId null, and the value reaches neither row nor log', async () => {
    const app = appWith([machineBatch()]);
    const token = await serviceToken();
    const value = 'leak me/please';
    const res = await call(
      app,
      '/api/batches',
      { bearer: token },
      { syncRun: value, testEnv: { ...env, MACHINE_SYNC_RUN: 'warn' } as Env },
    );
    expect(res.status).toBe(200);
    expect(seenRunId).toBeNull();
    const [row] = await rows('batch.push');
    expect(payloadOf(row)).toMatchObject({ runId: null });
    expect(JSON.stringify(await rows())).not.toContain('leak me');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(loggedEvents(warn.mock.calls)).toEqual([
      { event: 'machine_sync_run_invalid', route: 'POST /api/batches' },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('leak me');
  });

  it('the framework stamps the validated id over any runId the handler wrote', async () => {
    const app = appWith([machineBatch(() => ({ received: 1, runId: 'forged-by-handler' }))]);
    const token = await serviceToken();
    await call(app, '/api/batches', { bearer: token }, { syncRun: 'real-run' });
    expect(payloadOf((await rows('batch.push'))[0])).toEqual({ received: 1, runId: 'real-run' });
  });

  it('off the machine path nothing changes: the header is not read and the payload is not stamped', async () => {
    // An ordinary route never reads X-Sync-Run: with no header, a valid one and an invalid one, in
    // enforce and in warn-only mode alike, the handler sees null, nothing is refused or logged,
    // and the handler's own payload is stored as it wrote it. Sending the header is the point —
    // a request without it cannot tell a route that ignores it from one that reads it.
    const app = appWith([plainBatch]);
    const modes = [env, { ...env, MACHINE_SYNC_RUN: 'warn' } as Env];
    const values = [undefined, 'run-ok', 'leak me/please'];
    for (const testEnv of modes) {
      for (const syncRun of values) {
        seenRunId = undefined;
        const res = await call(
          app,
          '/api/plain-batches',
          { cookieOf: USERS[WRITER_ROLE] },
          { syncRun, testEnv },
        );
        expect(res.status, `${testEnv.MACHINE_SYNC_RUN} / ${syncRun}`).toBe(200);
        expect(seenRunId).toBeNull();
      }
    }
    const written = await rows('batch.plain');
    expect(written).toHaveLength(modes.length * values.length);
    for (const row of written) {
      expect(payloadOf(row)).toEqual({ received: 1, runId: 'handler-said-this' });
    }
    expect(JSON.stringify(await rows())).not.toContain('leak me');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('machine routes — the 1 KB audit payload cap', () => {
  beforeAll(applySchema);
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await seedDb();
    handlerCalls = 0;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('an oversize payload is stored as { oversize, bytes, runId }, with one warning', async () => {
    const big = {
      received: 50,
      keys: Array.from({ length: 50 }, (_, i) => `KEY-${i}-${'x'.repeat(30)}`),
    };
    const app = appWith([machineBatch(() => big)]);
    const token = await serviceToken();
    const res = await call(app, '/api/batches', { bearer: token }, { syncRun: 'run-7' });
    expect(res.status).toBe(200); // the cap never fails the request
    const written = await rows('batch.push');
    expect(written).toHaveLength(1); // still exactly one declared row
    const bytes = new TextEncoder().encode(JSON.stringify({ ...big, runId: 'run-7' })).length;
    expect(bytes).toBeGreaterThan(1024);
    expect(payloadOf(written[0])).toEqual({ oversize: true, bytes, runId: 'run-7' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(loggedEvents(warn.mock.calls)).toEqual([
      { event: 'machine_audit_payload_oversize', route: 'POST /api/batches', bytes },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('KEY-0-');
  });

  it('an oversize payload that was SUPPRESSED keeps suppressed: true', async () => {
    const big = { suppressed: true, note: 'y'.repeat(2000) };
    const app = appWith([machineBatch(() => big)]);
    const token = await serviceToken();
    await call(app, '/api/batches', { bearer: token }, { syncRun: 'run-8' });
    const stored = payloadOf((await rows('batch.push'))[0]) as Record<string, unknown>;
    expect(stored).toMatchObject({ oversize: true, suppressed: true, runId: 'run-8' });
    expect(Object.keys(stored).sort()).toEqual(['bytes', 'oversize', 'runId', 'suppressed']);
  });

  it('a payload at exactly 1024 bytes is stored as it is', async () => {
    // {"pad":"…","runId":"r"} — size the pad so the stamped JSON is exactly 1024 bytes.
    const frame = JSON.stringify({ pad: '', runId: 'r' }).length;
    const exact = { pad: 'p'.repeat(1024 - frame) };
    const app = appWith([machineBatch(() => exact)]);
    const token = await serviceToken();
    await call(app, '/api/batches', { bearer: token }, { syncRun: 'r' });
    const [row] = await rows('batch.push');
    expect(new TextEncoder().encode(row?.payload_json ?? '').length).toBe(1024);
    expect(payloadOf(row)).toEqual({ ...exact, runId: 'r' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('bytes are UTF-8 bytes, not characters', async () => {
    // 400 three-byte characters: 400 characters, 1,200 bytes.
    const app = appWith([machineBatch(() => ({ text: '\u20ac'.repeat(400) }))]);
    const token = await serviceToken();
    await call(app, '/api/batches', { bearer: token }, { syncRun: 'r' });
    expect(payloadOf((await rows('batch.push'))[0])).toMatchObject({ oversize: true });
  });

  it('a ctx.audit() extra on a machine route is stamped and capped too', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/batches',
        permission: 'notes.write',
        machine: true,
        audit: 'batch.push',
        input: z.object({}),
        handler: async (ctx) => {
          await ctx.audit('batch.extra', 't', { blob: 'z'.repeat(3000) });
          await ctx.audit('batch.extra.small', 't', { n: 1 });
          return { ok: true };
        },
      }),
    ]);
    const token = await serviceToken();
    await call(app, '/api/batches', { bearer: token }, { syncRun: 'run-9' });
    expect(payloadOf((await rows('batch.extra'))[0])).toMatchObject({
      oversize: true,
      runId: 'run-9',
    });
    expect(payloadOf((await rows('batch.extra.small'))[0])).toEqual({ n: 1, runId: 'run-9' });
    // The declared row, with no handler payload, still names the run.
    expect(payloadOf((await rows('batch.push'))[0])).toEqual({ runId: 'run-9' });
  });

  it('off the machine path a large payload is stored untouched (the cap is machine-only)', async () => {
    const big = { blob: 'q'.repeat(3000) };
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/plain-batches',
        permission: 'notes.write',
        audit: 'batch.plain',
        input: z.object({}),
        handler: async (ctx) => {
          ctx.setAuditTarget('t', big);
          return { ok: true };
        },
      }),
    ]);
    const res = await call(app, '/api/plain-batches', { cookieOf: USERS[WRITER_ROLE] });
    expect(res.status).toBe(200);
    expect(payloadOf((await rows('batch.plain'))[0])).toEqual(big);
  });
});

describe('machine routes — MCP and the manifest', () => {
  const routes = [machineBatch(), plainBatch];

  it('the MCP tool list never offers a machine tool to a person; a service with the key sees it', async () => {
    const tools = buildMcpTools(routes);
    // The owner on a session, and on a legacy unscoped personal token (the widest a token gets).
    const people: Principal[] = [
      OWNER,
      { ...OWNER, credentialTransport: 'bearer', tokenScopes: null },
    ];
    for (const person of people) {
      const names = toolsForPrincipal(tools, person).map((t) => t.name);
      expect(names).not.toContain('post_batches');
      expect(names).toContain('post_plain_batches');
    }
    const svc: Principal = {
      kind: 'service',
      email: SVC,
      name: 'Synthetic ETL',
      role: null,
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      service: { id: 1, slug: 'etl', scope: 'notes.write', custodianEmail: USERS.member },
    };
    expect(
      toolsForPrincipal(tools, svc)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['post_batches', 'post_plain_batches']);
  });

  it('an MCP call to a machine tool by a person is the generic refusal', async () => {
    const tool = buildMcpTools(routes).find((t) => t.name === 'post_batches');
    const result = await tool?.invoke(env, OWNER, {});
    expect(result).toEqual({
      content: [{ type: 'text', text: 'This action is not available.' }],
      isError: true,
    });
  });

  it('the manifest publishes machine: true on the machine route and false elsewhere', () => {
    const m = buildManifest({ APP_NAME: 'x', APP_ENV: 'test' } as unknown as Env, routes);
    const byPath = Object.fromEntries(m.routes.map((r) => [r.path, r.machine]));
    expect(byPath).toEqual({ '/api/batches': true, '/api/plain-batches': false });
  });
});

describe('machine routes — a service over MCP', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const svc: Principal = {
    kind: 'service',
    email: SVC,
    name: 'Synthetic ETL',
    role: null,
    authMethod: 'api_token',
    credentialTransport: 'bearer',
    service: { id: 1, slug: 'etl', scope: 'notes.write', custodianEmail: USERS.member },
  };

  it('carries no X-Sync-Run, so enforce mode refuses it with the header message', async () => {
    const tool = buildMcpTools([machineBatch()]).find((t) => t.name === 'post_batches');
    const result = await tool?.invoke(env, svc, {});
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toMatch(/X-Sync-Run/);
    expect(await rows('batch.push')).toEqual([]);
  });

  it('goes through in warn-only mode, recorded as runId null', async () => {
    const tool = buildMcpTools([machineBatch()]).find((t) => t.name === 'post_batches');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await tool?.invoke({ ...env, MACHINE_SYNC_RUN: 'warn' } as Env, svc, {});
      expect(result?.isError).toBeUndefined();
      expect(payloadOf((await rows('batch.push'))[0])).toMatchObject({ runId: null });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('machine routes — composed with the audit attribution (P1, src/framework/invocation.ts)', () => {
  beforeAll(applySchema);
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await seedDb();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const svc: Principal = {
    kind: 'service',
    email: SVC,
    name: 'Synthetic ETL',
    role: null,
    authMethod: 'api_token',
    credentialTransport: 'bearer',
    service: { id: 1, slug: 'etl', scope: 'notes.write', custodianEmail: USERS.member },
  };
  const WARN_ENV = { ...env, MACHINE_SYNC_RUN: 'warn' } as Env;

  it('an MCP row carries the stamped runId AND _via: mcp', async () => {
    const tool = buildMcpTools([machineBatch()]).find((t) => t.name === 'post_batches');
    await tool?.invoke(WARN_ENV, svc, {});
    expect(payloadOf((await rows('batch.push'))[0])).toEqual({
      received: 0,
      runId: null,
      _via: 'mcp',
    });
  });

  it("the cap is on the ROUTE's payload, then _via is appended (DECISIONS 2026-09-25 P1-A order)", async () => {
    // Sized so the stamped payload fits (1020 bytes): the MCP attribution does not tip it over, so
    // the cap decides the same way on every channel. The stored row is the payload plus `_via`.
    const blob = 'x'.repeat(996);
    expect(new TextEncoder().encode(JSON.stringify({ blob, runId: null })).length).toBe(1020);
    const fits = buildMcpTools([machineBatch(() => ({ blob }))]).find(
      (t) => t.name === 'post_batches',
    );
    await fits?.invoke(WARN_ENV, svc, {});
    expect(payloadOf((await rows('batch.push'))[0])).toEqual({ blob, runId: null, _via: 'mcp' });
    expect(
      loggedEvents(warn.mock.calls).filter((e) => e.event === 'machine_audit_payload_oversize'),
    ).toEqual([]);
  });

  it('an oversize payload over MCP: one row, the stub, and the stub is attributed too', async () => {
    const big = { received: 50, blob: 'y'.repeat(2000) };
    const bytes = new TextEncoder().encode(JSON.stringify({ ...big, runId: null })).length;
    const tool = buildMcpTools([machineBatch(() => big)]).find((t) => t.name === 'post_batches');
    const result = await tool?.invoke(WARN_ENV, svc, {});
    expect(result?.isError).toBeUndefined(); // the cap never fails the call
    const written = await rows('batch.push');
    expect(written).toHaveLength(1);
    expect(payloadOf(written[0])).toEqual({ oversize: true, bytes, runId: null, _via: 'mcp' });
    expect(
      loggedEvents(warn.mock.calls).filter((e) => e.event === 'machine_audit_payload_oversize'),
    ).toEqual([{ event: 'machine_audit_payload_oversize', route: 'POST /api/batches', bytes }]);
  });

  it('a handler cannot forge attribution on a machine row: reserved keys are stripped, runId stamped', async () => {
    const app = appWith([machineBatch(() => ({ received: 1, _via: 'agent', _turn: 'forged' }))]);
    const token = await serviceToken();
    const res = await call(app, '/api/batches', { bearer: token }, { syncRun: 'run-9' });
    expect(res.status).toBe(200);
    expect(payloadOf((await rows('batch.push'))[0])).toEqual({ received: 1, runId: 'run-9' });
    expect(loggedEvents(warn.mock.calls)).toEqual([
      { event: 'audit_reserved_keys_stripped', action: 'batch.push', count: 2 },
    ]);
  });
});

describe('machine routes — the service principal resolved from a real token', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('resolves as kind service, which is what the machine gate keys on', async () => {
    const token = await serviceToken('notes.write');
    const principal = await resolveApiTokenByHash(env, await sha256Hex(token));
    expect(principal?.kind).toBe('service');
  });
});
