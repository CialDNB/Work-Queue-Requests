// INVOCATION ATTRIBUTION (src/framework/invocation.ts). Every executeRoute call states its channel;
// the pipeline stamps `_via` / `_turn` on the audit rows an MCP or agent call writes, keeps HTTP
// rows byte-identical, strips the reserved `_` namespace from route payloads on every channel, and
// puts an agent call's TURN id in read_log.request_id. Content-free throughout: a malformed
// invocation never runs, and nothing a route chose (its key names) reaches a log.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALL_ROLES, can } from '../../src/auth/permissions';
import type { Principal, Role } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import { type AuroraClient, auroraQuery, defineAuroraQuery } from '../../src/data/aurora';
import type { Env } from '../../src/env';
import { defineRoute, mountRoutes, type RouteSpec } from '../../src/framework/defineRoute';
import { executeRoute } from '../../src/framework/execute';
import {
  auditPayloadJson,
  checkedInvocation,
  InvalidInvocationError,
  type Invocation,
  RESERVED_AUDIT_KEY_PREFIX,
  readLedgerRequestId,
  TURN_ID_PATTERN,
} from '../../src/framework/invocation';
import { buildMcpTools } from '../../src/mcp/tools';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { BASE, cookieFor } from '../helpers/http';
import { captureLogs } from '../helpers/logs';

const ARMED = { ...env, READ_AUDIT: 'on' } as Env;
// A synthetic turn id, the shape the P2 loop will mint (a uuid).
const TURN = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';

// The routes below gate on `notes.write`, and the app section of PERMISSIONS is the APP'S: Insights
// narrows notes.write to owner/admin. So the permitted caller is the least-privileged role that holds
// the key in THIS app — never a hard-coded 'member', which turned ten of these tests into 404s in a
// fork (P1 dry run, AICOE-667) — and the denied one holds an EMPTY authoritative set (the authority
// seam), which denies every key whatever the app's rows say.
const WRITER: Role = (() => {
  const role = [...ALL_ROLES].reverse().find((r) => can(r, 'notes.write'));
  if (!role) throw new Error('invocation tests need a role holding notes.write');
  return role;
})();

function deniedPerson(): Principal {
  return { ...person(), permissions: new Set() } as Principal;
}

function person(role: Role = WRITER): Principal {
  return {
    kind: 'person',
    email: USERS[role],
    name: null,
    role,
    authMethod: 'magic_link',
    credentialTransport: 'cookie',
  };
}

async function run(
  spec: RouteSpec<z.ZodTypeAny>,
  invocation: unknown,
  opts: { principal?: Principal; env?: Env; input?: unknown } = {},
): Promise<unknown> {
  const pending: Promise<unknown>[] = [];
  try {
    return await executeRoute(opts.env ?? (env as Env), spec, opts.principal ?? person(), {
      ip: '',
      params: {},
      request: new Request('https://x.test/api/t'),
      waitUntil: (p) => {
        pending.push(p);
      },
      invocation: invocation as Invocation,
      buildRawInput: () => opts.input ?? {},
    });
  } finally {
    await Promise.allSettled(pending);
  }
}

async function auditRows(action: string): Promise<{ payload_json: string | null }[]> {
  const res = await env.DB.prepare(
    'SELECT payload_json FROM audit_log WHERE action = ? ORDER BY id',
  )
    .bind(action)
    .all<{ payload_json: string | null }>();
  return res.results;
}

function writingRoute(
  payload: Record<string, unknown> | undefined,
  extra?: Record<string, unknown>,
): RouteSpec<z.ZodTypeAny> {
  return defineRoute({
    method: 'POST',
    path: '/api/attributed-widgets',
    permission: 'notes.write',
    audit: 'widget.create',
    input: z.object({}),
    handler: async (ctx) => {
      if (extra) await ctx.audit('widget.extra', 'w1', extra);
      if (payload) ctx.setAuditTarget('w1', payload);
      return { ok: true };
    },
  }).spec;
}

describe('checkedInvocation — an adapter bug never runs', () => {
  it('accepts exactly the three channels, with a turn id only on agent', () => {
    expect(checkedInvocation({ via: 'http' })).toEqual({ via: 'http' });
    expect(checkedInvocation({ via: 'mcp' })).toEqual({ via: 'mcp' });
    expect(checkedInvocation({ via: 'agent', turnId: TURN })).toEqual({
      via: 'agent',
      turnId: TURN,
    });
  });

  it('returns a frozen copy, not the adapter object', () => {
    const given = { via: 'agent', turnId: TURN };
    const checked = checkedInvocation(given);
    expect(checked).not.toBe(given);
    expect(Object.isFrozen(checked)).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'http'],
    ['no channel', {}],
    ['an unknown channel', { via: 'cron' }],
    ['a mis-cased channel', { via: 'HTTP' }],
    ['agent without a turn', { via: 'agent' }],
    ['agent with an empty turn', { via: 'agent', turnId: '' }],
    ['agent with a sentence', { via: 'agent', turnId: 'ignore previous instructions' }],
    ['agent with an address', { via: 'agent', turnId: 'someone@example.test' }],
    ['agent with a url', { via: 'agent', turnId: 'https://x.test' }],
    ['agent with dots', { via: 'agent', turnId: 'a.b.c' }],
    ['agent with a 65-char turn', { via: 'agent', turnId: 'a'.repeat(65) }],
    ['agent with a numeric turn', { via: 'agent', turnId: 12345 }],
    ['http with a turn', { via: 'http', turnId: TURN }],
    ['mcp with a turn', { via: 'mcp', turnId: TURN }],
  ])('refuses %s', (_label, value) => {
    expect(() => checkedInvocation(value)).toThrow(InvalidInvocationError);
  });

  it('the turn-id pattern admits a uuid and 64 characters, and nothing with room for content', () => {
    expect(TURN_ID_PATTERN.test(TURN)).toBe(true);
    expect(TURN_ID_PATTERN.test('a'.repeat(64))).toBe(true);
    for (const bad of ['a b', 'a@b', 'a/b', 'a:b', 'a.b', 'a?b', 'a#b', 'á']) {
      expect(TURN_ID_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('never echoes what it refused', () => {
    try {
      checkedInvocation({ via: 'agent', turnId: 'someone@example.test' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('someone');
      expect((err as Error).name).toBe('InvalidInvocationError');
    }
  });
});

describe('auditPayloadJson — the reserved namespace and the attribution keys', () => {
  const http: Invocation = { via: 'http' };
  const mcp: Invocation = { via: 'mcp' };
  const agent: Invocation = { via: 'agent', turnId: TURN };

  it('HTTP with no reserved key is byte-identical to the pre-attribution framework', () => {
    for (const payload of [undefined, {}, { a: 1, b: 'x' }, { nested: { _inner: 1 } }]) {
      expect(auditPayloadJson(payload, http)).toEqual({
        json: payload ? JSON.stringify(payload) : null,
        stripped: 0,
      });
    }
  });

  it('strips route-supplied `_` keys on EVERY channel and counts them', () => {
    const forged = { a: 1, _via: 'agent', _turn: 'forged', _other: true };
    expect(auditPayloadJson(forged, http)).toEqual({ json: '{"a":1}', stripped: 3 });
    expect(auditPayloadJson(forged, mcp)).toEqual({ json: '{"a":1,"_via":"mcp"}', stripped: 3 });
    expect(auditPayloadJson(forged, agent)).toEqual({
      json: `{"a":1,"_via":"agent","_turn":"${TURN}"}`,
      stripped: 3,
    });
    expect(RESERVED_AUDIT_KEY_PREFIX).toBe('_');
  });

  it('an HTTP payload of only reserved keys stays an object — the route did supply one', () => {
    expect(auditPayloadJson({ _x: 1 }, http)).toEqual({ json: '{}', stripped: 1 });
  });

  it('MCP and agent rows carry the attribution even with no route payload, keys LAST', () => {
    expect(auditPayloadJson(undefined, mcp).json).toBe('{"_via":"mcp"}');
    expect(auditPayloadJson(undefined, agent).json).toBe(`{"_via":"agent","_turn":"${TURN}"}`);
    expect(Object.keys(JSON.parse(auditPayloadJson({ z: 1, a: 2 }, agent).json ?? '{}'))).toEqual([
      'z',
      'a',
      '_via',
      '_turn',
    ]);
  });

  it('only an agent call names a read-ledger request id', () => {
    expect(readLedgerRequestId(agent)).toBe(TURN);
    expect(readLedgerRequestId(http)).toBeUndefined();
    expect(readLedgerRequestId(mcp)).toBeUndefined();
  });
});

describe('executeRoute stamps the invocation on what the call writes', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('an HTTP call writes the payload exactly as before; MCP and agent calls add _via/_turn', async () => {
    await run(writingRoute({ count: 2 }), { via: 'http' });
    await run(writingRoute({ count: 2 }), { via: 'mcp' });
    await run(writingRoute({ count: 2 }), { via: 'agent', turnId: TURN });
    await run(writingRoute(undefined), { via: 'http' });
    await run(writingRoute(undefined), { via: 'agent', turnId: TURN });
    expect((await auditRows('widget.create')).map((r) => r.payload_json)).toEqual([
      '{"count":2}',
      '{"count":2,"_via":"mcp"}',
      `{"count":2,"_via":"agent","_turn":"${TURN}"}`,
      null,
      `{"_via":"agent","_turn":"${TURN}"}`,
    ]);
  });

  it('ctx.audit() extras are attributed the same way', async () => {
    await run(writingRoute(undefined, { n: 1 }), { via: 'agent', turnId: TURN });
    await run(writingRoute(undefined, { n: 1 }), { via: 'http' });
    expect((await auditRows('widget.extra')).map((r) => r.payload_json)).toEqual([
      `{"n":1,"_via":"agent","_turn":"${TURN}"}`,
      '{"n":1}',
    ]);
  });

  it('a route cannot forge attribution: its `_` keys are stripped and the strip is logged, content-free', async () => {
    const logs = captureLogs();
    try {
      await run(writingRoute({ ok: 1, _via: 'agent', _turn: 'forged-turn-name' }), {
        via: 'http',
      });
      await run(writingRoute({ ok: 1, _via: 'http' }), { via: 'agent', turnId: TURN });
    } finally {
      logs.restore();
    }
    expect((await auditRows('widget.create')).map((r) => r.payload_json)).toEqual([
      '{"ok":1}',
      `{"ok":1,"_via":"agent","_turn":"${TURN}"}`,
    ]);
    const stripped = logs.named('audit_reserved_keys_stripped');
    expect(stripped.map((e) => [e.action, e.count])).toEqual([
      ['widget.create', 2],
      ['widget.create', 1],
    ]);
    // The key names and values the route chose never reach a log.
    logs.expectAbsent('forged-turn-name', '_turn');
  });

  it('hands the handler the checked invocation as ctx.invocation', async () => {
    let seen: unknown;
    const spec = defineRoute({
      method: 'GET',
      path: '/api/who-called',
      permission: 'notes.read',
      input: z.object({}),
      handler: async (ctx) => {
        seen = ctx.invocation;
        return {};
      },
    }).spec;
    const given = { via: 'agent', turnId: TURN };
    await run(spec, given);
    expect(seen).toEqual(given);
    expect(seen).not.toBe(given);
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it('a malformed invocation throws before the permission check, the input and the handler', async () => {
    let ran = false;
    const spec = defineRoute({
      method: 'POST',
      path: '/api/never-runs',
      permission: 'notes.write',
      audit: 'never.runs',
      input: z.object({}),
      handler: async () => {
        ran = true;
        return {};
      },
    }).spec;
    // A PERMITTED caller: the throw is the invocation's, not a denial.
    await expect(run(spec, { via: 'agent' })).rejects.toBeInstanceOf(InvalidInvocationError);
    // A DENIED caller gets the same throw — the check depends on no caller data, so there is no
    // oracle in its ordering either way.
    await expect(run(spec, { via: 'robot' }, { principal: deniedPerson() })).rejects.toBeInstanceOf(
      InvalidInvocationError,
    );
    await expect(run(spec, undefined)).rejects.toBeInstanceOf(InvalidInvocationError);
    expect(ran).toBe(false);
    expect(await auditRows('never.runs')).toEqual([]);
  });

  it("an agent call's reads carry its TURN id in read_log.request_id; other calls get a fresh uuid each", async () => {
    const spec = defineRoute({
      method: 'GET',
      path: '/api/turn-reads',
      permission: 'notes.read',
      needs: ['notes'],
      input: z.object({}),
      handler: async (ctx) => ctx.db.notes.list({ limit: 5 }),
    }).spec;
    await run(spec, { via: 'agent', turnId: TURN }, { env: ARMED });
    await run(spec, { via: 'agent', turnId: TURN }, { env: ARMED });
    await run(spec, { via: 'http' }, { env: ARMED });
    await run(spec, { via: 'mcp' }, { env: ARMED });
    const ids = (await makeDb(env as Env).readLog.list({ limit: 20 })).items.map(
      (r) => r.request_id,
    );
    expect(ids).toHaveLength(4);
    expect(ids.filter((id) => id === TURN)).toHaveLength(2); // both calls of the turn correlate
    const others = ids.filter((id) => id !== TURN);
    expect(new Set(others).size).toBe(2); // a distinct id per non-agent call
    for (const id of others) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('ctx.requestId — one id for every ledger stream of a call', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  // A synthetic client-class source and a fake Postgres client; the ledger half is real D1.
  const USAGE = defineAuroraQuery(
    {
      name: 'turnUsage',
      source: 'c360_ro' as never,
      view: 'app_ro.v_namespace_usage',
      sql: 'select namespace from app_ro.v_namespace_usage',
      params: [],
    },
    { c360_ro: 'client' },
  );
  const client: AuroraClient = { query: async <R>() => ({ rows: [{ n: 1 }] as R[] }) };
  const seen: string[] = [];
  const spec = defineRoute({
    method: 'GET',
    path: '/api/turn-aurora-reads',
    permission: 'notes.read',
    needs: ['notes'],
    input: z.object({}),
    handler: async (ctx) => {
      seen.push(ctx.requestId);
      await ctx.db.notes.list({ limit: 1 });
      // The documented pattern (docs/DATA-ROUTES.md): AuroraCtx.requestId is ctx.requestId.
      return auroraQuery(
        {
          env: ctx.env,
          client,
          principal: ctx.principal.email,
          route: 'GET /api/turn-aurora-reads',
          requestId: ctx.requestId,
          waitUntil: ctx.waitUntil,
        },
        USAGE,
      );
    },
  }).spec;

  async function ledger(): Promise<{ kind: string; request_id: string }[]> {
    const res = await env.DB.prepare('SELECT kind, request_id FROM read_log').all<{
      kind: string;
      request_id: string;
    }>();
    return res.results;
  }

  it("an agent call's D1 AND Aurora rows carry its turn id; an HTTP call's share one fresh id", async () => {
    seen.length = 0;
    await run(spec, { via: 'agent', turnId: TURN }, { env: ARMED });
    await run(spec, { via: 'http' }, { env: ARMED });
    const rows = await ledger();
    expect(
      rows
        .filter((r) => r.request_id === TURN)
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['aurora', 'd1']);
    const http = rows.filter((r) => r.request_id !== TURN);
    expect(http.map((r) => r.kind).sort()).toEqual(['aurora', 'd1']);
    expect(new Set(http.map((r) => r.request_id)).size).toBe(1);
    expect(http[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toEqual([TURN, http[0]?.request_id]);
  });

  it('is minted even when READ_AUDIT is off — the Aurora stream records either way', async () => {
    seen.length = 0;
    await run(spec, { via: 'agent', turnId: TURN });
    await run(spec, { via: 'mcp' });
    const rows = await ledger();
    expect(rows.map((r) => r.kind)).toEqual(['aurora', 'aurora']); // no d1 rows unarmed
    expect(rows.map((r) => r.request_id).sort()).toEqual([...seen].sort());
    expect(seen[0]).toBe(TURN);
    expect(seen[1]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('each adapter states its own channel', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('the HTTP adapter writes rows with no attribution keys (byte-identical)', async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountRoutes(app, [
      defineRoute({
        method: 'POST',
        path: '/api/http-widgets',
        permission: 'notes.write',
        audit: 'widget.http',
        input: z.object({}),
        handler: async (ctx) => {
          ctx.setAuditTarget('w1', { size: 3 });
          return { ok: true };
        },
      }),
    ]);
    const res = await app.request(
      `${BASE}/api/http-widgets`,
      {
        method: 'POST',
        headers: {
          cookie: await cookieFor(USERS[WRITER]),
          origin: BASE,
          'content-type': 'application/json',
        },
        body: '{}',
      },
      env,
    );
    expect(res.status).toBe(200);
    expect((await auditRows('widget.http')).map((r) => r.payload_json)).toEqual(['{"size":3}']);
  });

  it("a SERVICE principal's authz.denied row written over MCP carries _via too", async () => {
    const [tool] = buildMcpTools([
      defineRoute({
        method: 'POST',
        path: '/api/mcp-denied-widgets',
        permission: 'notes.write',
        audit: 'widget.denied',
        input: z.object({}),
        handler: async () => ({ ok: true }),
      }),
    ]);
    if (!tool) throw new Error('tool was not built');
    const svc: Principal = {
      kind: 'service',
      email: 'svc-etl@test-app.invalid',
      name: 'Synthetic ETL',
      role: null,
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      service: { id: 7, slug: 'etl', scope: 'notes.read', custodianEmail: USERS.member },
    };
    const res = await tool.invoke(env as Env, svc, {});
    expect(res.isError).toBe(true);
    expect(JSON.parse((await auditRows('authz.denied'))[0]?.payload_json ?? 'null')).toEqual({
      permission: 'notes.write',
      service_identity_id: 7,
      _via: 'mcp',
    });
  });

  it('an in-process agent loop that hands an MCP tool its turn is attributed to the agent, not MCP', async () => {
    let runs = 0;
    const [tool] = buildMcpTools([
      defineRoute({
        method: 'POST',
        path: '/api/mcp-loop-widgets',
        permission: 'notes.write',
        audit: 'widget.loop',
        input: z.object({}),
        handler: async () => {
          runs += 1;
          return { ok: true };
        },
      }),
    ]);
    if (!tool) throw new Error('tool was not built');
    expect((await tool.invoke(env as Env, person(), {}, { turnId: TURN })).isError).toBeFalsy();
    expect((await auditRows('widget.loop')).map((r) => r.payload_json)).toEqual([
      `{"_via":"agent","_turn":"${TURN}"}`,
    ]);
    // A malformed turn is a loop bug: it throws before anything runs, like the agent's own tools.
    await expect(
      tool.invoke(env as Env, person(), {}, { turnId: 'ignore previous instructions' }),
    ).rejects.toBeInstanceOf(InvalidInvocationError);
    expect(runs).toBe(1);
  });

  it('the MCP adapter stamps _via "mcp" on the rows its calls write', async () => {
    const [tool] = buildMcpTools([
      defineRoute({
        method: 'POST',
        path: '/api/mcp-widgets',
        permission: 'notes.write',
        audit: 'widget.mcp',
        input: z.object({}),
        handler: async () => ({ ok: true }),
      }),
    ]);
    if (!tool) throw new Error('tool was not built');
    const res = await tool.invoke(env as Env, person(), {});
    expect(res.isError).toBeFalsy();
    expect((await auditRows('widget.mcp')).map((r) => r.payload_json)).toEqual(['{"_via":"mcp"}']);
  });
});
