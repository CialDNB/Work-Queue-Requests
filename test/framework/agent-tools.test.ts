// THE IN-APP AGENT'S TOOL SET (buildAgentTools, src/framework/agentTools.ts). Default deny — only
// routes with an `agent:` block — filtered to what the LIVE principal may call (a person;
// principalMayCall), invoked only through executeRoute with `{ via: 'agent', turnId }`, refusals
// uniform, approval enforced before anything runs. Every route below is synthetic; the kit's own
// registry exposes nothing (test/isolation/agent-exposure.test.ts).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PERMISSIONS, type PermissionKey } from '../../src/auth/permissions';
import type { PersonBearerPrincipal, Principal, Role } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import {
  type AgentTool,
  buildAgentTools,
  callAgentTool,
  callerIp,
  GENERIC_DENIAL,
} from '../../src/framework/agentTools';
import { defineRoute, type RouteDef, type RouteSpec } from '../../src/framework/defineRoute';
import { fail, ok } from '../../src/framework/envelope';
import { conflict, notFound } from '../../src/framework/errors';
import { InvalidInvocationError } from '../../src/framework/invocation';
import { allRoutes } from '../../src/routes';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { captureLogs } from '../helpers/logs';

const TURN = '7f3a9c2e-1b4d-4e8f-9a0b-2c3d4e5f6a7b';
const ARMED = { ...env, READ_AUDIT: 'on' } as Env;
// Hermetic: these tests judge the tool set, not the app's bindings. A fork that binds a client-class
// private database must still see them green (docs/DATA-ROUTES.md: registering a source never turns
// a kit test red), so they pass an empty source table; the C3 test below passes its own.
const NO_PRIVATE_SOURCES = {} as const;

// The roles in this file are PERSONAS, not the app's PERMISSIONS rows: each carries an authoritative
// `permissions` set (the authority seam, src/auth/permissions.ts) equal to the kit's role column for
// the keys these routes use. The app section of PERMISSIONS is the fork's — Insights gives notes.*
// to owner/admin only — so reading the rows would turn this file red in a fork whose pipeline is
// correct (P1 dry run, AICOE-667). What is under test is the tool set for a principal holding a
// given set of keys; how the principal came to hold them is src/auth's business.
const PERSONA: Record<Role, readonly PermissionKey[]> = {
  viewer: ['notes.read'],
  member: ['notes.read', 'notes.write'],
  admin: ['notes.read', 'notes.write', 'users.read'],
  owner: Object.keys(PERMISSIONS) as PermissionKey[],
};

function session(role: Role): Principal {
  return {
    kind: 'person',
    email: USERS[role],
    name: null,
    role,
    authMethod: 'magic_link',
    credentialTransport: 'cookie',
    permissions: new Set(PERSONA[role]),
  };
}

function bearer(role: Role, tokenScopes: readonly string[] | null): PersonBearerPrincipal {
  return {
    kind: 'person',
    email: USERS[role],
    name: null,
    role,
    authMethod: 'api_token',
    credentialTransport: 'bearer',
    tokenScopes,
    permissions: new Set(PERSONA[role]),
  };
}

const SERVICE: Principal = {
  kind: 'service',
  email: 'svc-etl@test-app.invalid',
  name: 'Synthetic ETL',
  role: null,
  authMethod: 'api_token',
  credentialTransport: 'bearer',
  service: { id: 3, slug: 'etl', scope: 'notes.read', custodianEmail: USERS.member },
};

let handlerRuns = 0;

// A small synthetic surface: two exposed reads, an exposed write that needs approval for long
// titles, an exposed destructive delete by uuid, an admin-only exposed read, and one route that is
// NOT exposed at all.
const listNotes = defineRoute({
  method: 'GET',
  path: '/api/agent-notes',
  permission: 'notes.read',
  needs: ['notes'],
  summary: 'List notes',
  input: z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) }),
  agent: { effect: 'read', render: 'notes.list' },
  handler: async (ctx, input) => {
    handlerRuns += 1;
    return ctx.db.notes.list({ limit: input.limit });
  },
});
const createNote = defineRoute({
  method: 'POST',
  path: '/api/agent-notes',
  permission: 'notes.write',
  needs: ['notes'],
  audit: 'agent_note.create',
  input: z.object({ title: z.string().min(1).max(200) }),
  agent: {
    effect: 'write',
    description: 'Create a note with a title',
    needsApproval: (input) => input.title.length > 10,
    approvalSummary: (input) => ({ key: 'notes.create', params: { title: input.title } }),
  },
  handler: async (ctx, input) => {
    handlerRuns += 1;
    const note = await ctx.db.notes.create({
      title: input.title,
      body: '',
      createdBy: ctx.principal.email,
    });
    ctx.setAuditTarget(note.id, { len: input.title.length });
    return ok(note, 201);
  },
});
const deleteNote = defineRoute({
  method: 'DELETE',
  path: '/api/agent-notes/:id',
  permission: 'notes.write',
  needs: ['notes'],
  audit: 'agent_note.delete',
  uniformityFixture: { seed: async () => ({ id: crypto.randomUUID() }) },
  input: z.object({ id: z.uuid() }),
  agent: { effect: 'destructive', needsApproval: true },
  handler: async (ctx, input) => {
    handlerRuns += 1;
    if (!(await ctx.db.notes.remove(input.id))) throw notFound();
    return new Response(null, { status: 204 });
  },
});
const adminRead = defineRoute({
  method: 'GET',
  path: '/api/agent-people',
  permission: 'users.read',
  needs: ['users'],
  input: z.object({}),
  agent: { effect: 'read' },
  handler: async () => {
    handlerRuns += 1;
    return { people: 0 };
  },
});
const notExposed = defineRoute({
  method: 'GET',
  path: '/api/agent-hidden',
  permission: 'notes.read',
  needs: ['notes'],
  input: z.object({}),
  handler: async () => ({ hidden: true }),
});
const ROUTES: RouteDef[] = [listNotes, createNote, deleteNote, adminRead, notExposed];

const names = (tools: readonly AgentTool[]) => tools.map((t) => t.name).sort();
function tool(tools: readonly AgentTool[], name: string): AgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
async function auditPayloads(action: string): Promise<(string | null)[]> {
  const res = await env.DB.prepare(
    'SELECT payload_json FROM audit_log WHERE action = ? ORDER BY id',
  )
    .bind(action)
    .all<{ payload_json: string | null }>();
  return res.results.map((r) => r.payload_json);
}
async function noteCount(): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{ n: number }>())?.n ?? 0;
}

describe('buildAgentTools — default deny, then the principal', () => {
  it('the kit registry exposes nothing, to anyone', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(buildAgentTools(allRoutes, session(role), NO_PRIVATE_SOURCES)).toEqual([]);
    }
  });

  it('offers only exposed routes the caller may call — never an unexposed one', () => {
    expect(names(buildAgentTools(ROUTES, session('viewer'), NO_PRIVATE_SOURCES))).toEqual([
      'get_agent_notes',
    ]);
    expect(names(buildAgentTools(ROUTES, session('member'), NO_PRIVATE_SOURCES))).toEqual([
      'delete_agent_notes_by_id',
      'get_agent_notes',
      'post_agent_notes',
    ]);
    expect(names(buildAgentTools(ROUTES, session('admin'), NO_PRIVATE_SOURCES))).toEqual([
      'delete_agent_notes_by_id',
      'get_agent_notes',
      'get_agent_people',
      'post_agent_notes',
    ]);
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(names(buildAgentTools(ROUTES, session(role), NO_PRIVATE_SOURCES))).not.toContain(
        'get_agent_hidden',
      );
    }
  });

  it('a bearer person holds only its token scopes; a service principal is offered nothing', () => {
    expect(
      names(buildAgentTools(ROUTES, bearer('admin', ['notes.read']), NO_PRIVATE_SOURCES)),
    ).toEqual(['get_agent_notes']);
    expect(buildAgentTools(ROUTES, bearer('admin', []), NO_PRIVATE_SOURCES)).toEqual([]);
    expect(buildAgentTools(ROUTES, SERVICE, NO_PRIVATE_SOURCES)).toEqual([]);
  });

  it('describes each tool from its block, frozen', () => {
    const [list, create] = [
      tool(buildAgentTools(ROUTES, session('member'), NO_PRIVATE_SOURCES), 'get_agent_notes'),
      tool(buildAgentTools(ROUTES, session('member'), NO_PRIVATE_SOURCES), 'post_agent_notes'),
    ];
    expect(list.description).toBe('List notes'); // defaults to the summary
    expect(create.description).toBe('Create a note with a title');
    expect([list.effect, create.effect]).toEqual(['read', 'write']);
    expect(list.render).toBe('notes.list');
    expect(create.render).toBeNull();
    expect([list.egress, list.egressRuling]).toEqual([[], null]);
    expect((create.inputSchema as { required?: string[] }).required).toEqual(['title']);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it('throws on a tool-name collision among exposed routes', () => {
    expect(() =>
      buildAgentTools([listNotes, listNotes], session('member'), NO_PRIVATE_SOURCES),
    ).toThrow(/collision/);
  });

  it('re-checks every block: a hand-built RouteDef cannot smuggle a forbidden exposure in', () => {
    const smuggled: RouteDef = {
      spec: {
        ...(notExposed.spec as RouteSpec<z.ZodTypeAny>),
        path: '/api/agent-audit',
        permission: 'audit.read',
        agent: { effect: 'read' },
      },
    };
    expect(() => buildAgentTools([smuggled], session('owner'), NO_PRIVATE_SOURCES)).toThrow(
      /can never be exposed/,
    );
  });

  it('builds nothing in an app that binds a client-class private database, until every exposure is ruled (PIA C3)', () => {
    const CLIENT_DB = { c360_ro: 'client', ret1_ro: 'internal' } as const;
    expect(() => buildAgentTools(ROUTES, session('member'), CLIENT_DB)).toThrow(
      /Route GET \/api\/agent-notes: agent exposure — egressRuling is required: the app binds a client-class private database \(c360_ro\)/,
    );
    const ruled = ROUTES.map(
      ({ spec }): RouteDef => ({
        spec: spec.agent ? { ...spec, agent: { ...spec.agent, egressRuling: 'C36-1561' } } : spec,
      }),
    );
    expect(names(buildAgentTools(ruled, session('member'), CLIENT_DB))).toEqual([
      'delete_agent_notes_by_id',
      'get_agent_notes',
      'post_agent_notes',
    ]);
    // An internal-only table changes nothing.
    expect(names(buildAgentTools(ROUTES, session('viewer'), { ret1_ro: 'internal' }))).toEqual([
      'get_agent_notes',
    ]);
  });
});

describe('invoke — one pipeline, attributed to the turn', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    handlerRuns = 0;
  });

  it('a permitted call runs through executeRoute and its audit row carries _via/_turn', async () => {
    const member = session('member');
    const create = tool(buildAgentTools(ROUTES, member, NO_PRIVATE_SOURCES), 'post_agent_notes');
    const res = await create.invoke(env as Env, member, { title: 'short' }, { turnId: TURN });
    expect(res.ok).toBe(true);
    expect((res as { data: { title: string } }).data.title).toBe('short'); // 201 envelope unwrapped
    expect(await auditPayloads('agent_note.create')).toEqual([
      `{"len":5,"_via":"agent","_turn":"${TURN}"}`,
    ]);
  });

  it("records the person's request IP on the call's audit rows, IP-shaped values only", async () => {
    const member = session('member');
    const create = tool(buildAgentTools(ROUTES, member, NO_PRIVATE_SOURCES), 'post_agent_notes');
    const call = (ip?: string) =>
      create.invoke(env as Env, member, { title: 'short' }, { turnId: TURN, ip });
    for (const ip of ['203.0.113.7', '2001:db8::1', undefined, 'not an address', 'a@b.test']) {
      expect((await call(ip)).ok, String(ip)).toBe(true);
    }
    const ips = await env.DB.prepare(
      "SELECT ip FROM audit_log WHERE action = 'agent_note.create' ORDER BY id",
    ).all<{ ip: string }>();
    expect(ips.results.map((r) => r.ip)).toEqual(['203.0.113.7', '2001:db8::1', '', '', '']);
    expect(callerIp('198.51.100.1')).toBe('198.51.100.1');
    for (const bad of [null, 42, '', '...', 'deadbeef', 'x'.repeat(46), '1.2.3.4 ; drop']) {
      expect(callerIp(bad), String(bad)).toBe('');
    }
  });

  it("an armed read's ledger rows carry the turn id as request_id", async () => {
    const viewer = session('viewer');
    const list = tool(buildAgentTools(ROUTES, viewer, NO_PRIVATE_SOURCES), 'get_agent_notes');
    const res = await list.invoke(ARMED, viewer, {}, { turnId: TURN });
    expect(res.ok).toBe(true);
    const rows = (await makeDb(env as Env).readLog.list({ limit: 10 })).items;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.request_id).toBe(TURN);
      expect(r.route).toBe('GET /api/agent-notes');
    }
  });

  it('re-checks the LIVE principal: a caller demoted since the list was built is refused uniformly', async () => {
    const create = tool(
      buildAgentTools(ROUTES, session('member'), NO_PRIVATE_SOURCES),
      'post_agent_notes',
    );
    const res = await create.invoke(
      env as Env,
      session('viewer'),
      { title: 'x' },
      { turnId: TURN },
    );
    expect(res).toEqual({ ok: false, code: 'unavailable', message: GENERIC_DENIAL });
    expect(handlerRuns).toBe(0);
    expect(await auditPayloads('agent_note.create')).toEqual([]);
  });

  it('refuses a service principal outright — no pipeline, no authz.denied row', async () => {
    const list = tool(
      buildAgentTools(ROUTES, session('viewer'), NO_PRIVATE_SOURCES),
      'get_agent_notes',
    );
    const res = await list.invoke(env as Env, SERVICE, {}, { turnId: TURN });
    expect(res).toEqual({ ok: false, code: 'unavailable', message: GENERIC_DENIAL });
    expect(handlerRuns).toBe(0);
    expect(await auditPayloads('authz.denied')).toEqual([]);
  });

  it('an unknown tool name reads exactly like a denied one', async () => {
    const tools = buildAgentTools(ROUTES, session('viewer'), NO_PRIVATE_SOURCES);
    const unknown = await callAgentTool(
      env as Env,
      session('viewer'),
      tools,
      'get_nothing',
      {},
      {
        turnId: TURN,
      },
    );
    const notOffered = await callAgentTool(
      env as Env,
      session('viewer'),
      tools,
      'post_agent_notes',
      { title: 'x' },
      { turnId: TURN },
    );
    expect(unknown).toEqual(notOffered);
    expect(unknown).toEqual({ ok: false, code: 'unavailable', message: GENERIC_DENIAL });
  });

  it('a malformed turn id is a loop bug: it throws and nothing runs', async () => {
    const member = session('member');
    const tools = buildAgentTools(ROUTES, member, NO_PRIVATE_SOURCES);
    const create = tool(tools, 'post_agent_notes');
    for (const turnId of ['', 'a turn', 'x@y', 'a'.repeat(65)]) {
      await expect(
        create.invoke(env as Env, member, { title: 'x' }, { turnId }),
      ).rejects.toBeInstanceOf(InvalidInvocationError);
      await expect(
        callAgentTool(env as Env, member, tools, 'nope', {}, { turnId }),
      ).rejects.toBeInstanceOf(InvalidInvocationError);
    }
    expect(handlerRuns).toBe(0);
  });
});

describe('approval — enforced before anything runs', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    handlerRuns = 0;
  });

  it('a call that needs approval returns the card and runs nothing until approved', async () => {
    const member = session('member');
    const create = tool(buildAgentTools(ROUTES, member, NO_PRIVATE_SOURCES), 'post_agent_notes');
    const args = { title: 'a much longer title' };
    const pending = await create.invoke(env as Env, member, args, { turnId: TURN });
    expect(pending).toEqual({
      ok: false,
      code: 'approval_required',
      message: expect.any(String),
      approval: { key: 'notes.create', params: { title: 'a much longer title' } },
    });
    expect(handlerRuns).toBe(0);
    expect(await noteCount()).toBe(0);

    // Anything but an exact `true` is not an approval.
    const sloppy = await create.invoke(env as Env, member, args, {
      turnId: TURN,
      approved: 'yes' as unknown as boolean,
    });
    expect(sloppy.ok).toBe(false);
    expect(handlerRuns).toBe(0);

    const approved = await create.invoke(env as Env, member, args, {
      turnId: TURN,
      approved: true,
    });
    expect(approved.ok).toBe(true);
    expect(await noteCount()).toBe(1);
  });

  it('a predicate that says no approval lets the call run straight away', async () => {
    const member = session('member');
    const create = tool(buildAgentTools(ROUTES, member, NO_PRIVATE_SOURCES), 'post_agent_notes');
    const res = await create.invoke(env as Env, member, { title: 'short' }, { turnId: TURN });
    expect(res.ok).toBe(true);
  });

  it('a denied caller never learns a tool needs approval (permission is checked first)', async () => {
    const create = tool(
      buildAgentTools(ROUTES, session('member'), NO_PRIVATE_SOURCES),
      'post_agent_notes',
    );
    const res = await create.invoke(
      env as Env,
      session('viewer'),
      { title: 'a much longer title' },
      { turnId: TURN },
    );
    expect(res).toEqual({ ok: false, code: 'unavailable', message: GENERIC_DENIAL });
  });

  it('invalid arguments skip the approval step and fail validation — the handler never runs', async () => {
    const member = session('member');
    const del = tool(
      buildAgentTools(ROUTES, member, NO_PRIVATE_SOURCES),
      'delete_agent_notes_by_id',
    );
    const res = await del.invoke(env as Env, member, { id: 'not-a-uuid' }, { turnId: TURN });
    expect(res.ok).toBe(false);
    expect((res as { code: string }).code).toBe('invalid_input');
    expect(handlerRuns).toBe(0);
  });

  it('a destructive tool with needsApproval: true always asks, with the generic card', async () => {
    const member = session('member');
    const del = tool(
      buildAgentTools(ROUTES, member, NO_PRIVATE_SOURCES),
      'delete_agent_notes_by_id',
    );
    const id = crypto.randomUUID();
    const res = await del.invoke(env as Env, member, { id }, { turnId: TURN });
    expect(res).toMatchObject({
      code: 'approval_required',
      approval: { key: 'agent.approval.generic', params: { tool: 'delete_agent_notes_by_id' } },
    });
    // Approved but missing → the handler's own notFound() reads as the uniform denial.
    const gone = await del.invoke(env as Env, member, { id }, { turnId: TURN, approved: true });
    expect(gone).toEqual({ ok: false, code: 'unavailable', message: GENERIC_DENIAL });
  });
});

describe('results — each outcome in the agent shape', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  function exposedPost(
    path: string,
    handler: RouteSpec<z.ZodTypeAny>['handler'],
    extra: Partial<RouteSpec<z.ZodTypeAny>> = {},
  ): AgentTool {
    const def = defineRoute({
      method: 'POST',
      path,
      permission: 'notes.write',
      needs: ['notes'],
      audit: false,
      input: z.object({ n: z.number().int().optional() }),
      agent: { effect: 'write' },
      handler,
      ...extra,
    });
    return tool(
      buildAgentTools([def], session('member'), NO_PRIVATE_SOURCES),
      `post_${path.slice(5).replace(/-/g, '_')}`,
    );
  }
  const call = (t: AgentTool, args: unknown = {}) =>
    t.invoke(env as Env, session('member'), args, { turnId: TURN });

  it('a 204 is success with null data', async () => {
    const t = exposedPost('/api/agent-nocontent', async () => new Response(null, { status: 204 }));
    expect(await call(t)).toEqual({ ok: true, data: null });
  });

  it('a handler-returned 404 is the uniform denial; another 4xx failed; a 5xx is internal', async () => {
    const r404 = exposedPost('/api/agent-r404', async () => fail(404, 'not_found', 'Not found'));
    const r409 = exposedPost('/api/agent-r409', async () => fail(409, 'conflict', 'row 42 exists'));
    const r503 = exposedPost('/api/agent-r503', async () => fail(503, 'down', 'upstream down'));
    expect(await call(r404)).toEqual({ ok: false, code: 'unavailable', message: GENERIC_DENIAL });
    const failed = await call(r409);
    expect(failed).toMatchObject({ ok: false, code: 'failed' });
    expect((failed as { message: string }).message).not.toContain('42'); // the body is not surfaced
    expect(await call(r503)).toEqual({ ok: false, code: 'internal', message: 'Internal error.' });
  });

  it('a thrown AppError surfaces its message to the permitted caller; a validation error too', async () => {
    const t = exposedPost('/api/agent-conflict', async () => {
      throw conflict('Title already taken');
    });
    expect(await call(t)).toEqual({ ok: false, code: 'failed', message: 'Title already taken' });
    const res = await call(t, { n: 'x' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('the rate limit is the route’s own, reported as rate_limited', async () => {
    const t = exposedPost('/api/agent-limited', async () => ({ ok: true }), {
      rateLimit: { limit: 1, windowSec: 60 },
    });
    expect((await call(t)).ok).toBe(true);
    expect(await call(t)).toMatchObject({ ok: false, code: 'rate_limited' });
  });

  it('an unexpected throw is internal: its category is logged as agent_tool_error, the message nowhere', async () => {
    const t = exposedPost('/api/agent-boom', async () => {
      throw new TypeError('row for someone@client.example exploded');
    });
    const logs = captureLogs();
    let res: unknown;
    try {
      res = await call(t);
    } finally {
      logs.restore();
    }
    expect(res).toEqual({ ok: false, code: 'internal', message: 'Internal error.' });
    const [line] = logs.named('agent_tool_error');
    expect(line).toMatchObject({
      method: 'POST',
      path: '/api/agent-boom',
      err: { name: 'TypeError' },
    });
    logs.expectAbsent('someone@client.example', TURN);
  });

  it('a schema that throws on the model’s input is internal — the call resolves, the argument is logged nowhere', async () => {
    let ran = false;
    const t = exposedPost(
      '/api/agent-parse',
      async () => {
        ran = true;
        return { ok: true };
      },
      {
        input: z.object({
          blob: z
            .string()
            .max(80)
            .transform((v) => JSON.parse(v) as unknown),
        }),
      },
    );
    const logs = captureLogs();
    let res: unknown;
    try {
      res = await call(t, { blob: '{"who": someone@client.example' });
    } finally {
      logs.restore();
    }
    expect(res).toEqual({ ok: false, code: 'internal', message: 'Internal error.' });
    expect(ran).toBe(false);
    const [line] = logs.named('agent_tool_error');
    expect(line).toMatchObject({ method: 'POST', path: '/api/agent-parse' });
    logs.expectAbsent('someone@client.example', TURN);
  });

  it('a path param with an underscore fills the path and the audit target, as over HTTP', async () => {
    const def = defineRoute({
      method: 'POST',
      path: '/api/agent-tickets/:ticket_key/close',
      permission: 'notes.write',
      needs: ['notes'],
      audit: 'agent_ticket.close',
      uniformityFixture: { seed: async () => ({ ticket_key: 'OPS-1' }) },
      input: z.object({ ticket_key: z.string().regex(/^[A-Z]{2,5}-\d{1,6}$/) }),
      agent: { effect: 'write' },
      handler: async () => ({ closed: true }),
    });
    const t = tool(
      buildAgentTools([def], session('member'), NO_PRIVATE_SOURCES),
      'post_agent_tickets_by_ticket_key_close',
    );
    expect(await call(t, { ticket_key: 'OPS-42' })).toEqual({ ok: true, data: { closed: true } });
    const row = await env.DB.prepare(
      "SELECT target FROM audit_log WHERE action = 'agent_ticket.close'",
    ).first<{ target: string | null }>();
    expect(row?.target).toBe('OPS-42');
  });

  it('background work is drained before the call returns', async () => {
    let settled = false;
    const t = exposedPost('/api/agent-bg', async (ctx) => {
      ctx.waitUntil(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve();
          }, 20),
        ),
      );
      return { ok: true };
    });
    expect((await call(t)).ok).toBe(true);
    expect(settled).toBe(true);
  });

  it('a never-settling background promise is capped and logged as agent_waituntil_drain_capped', async () => {
    const t = exposedPost('/api/agent-hang', async (ctx) => {
      ctx.waitUntil(new Promise(() => {}));
      return { ok: true };
    });
    const logs = captureLogs();
    try {
      const res = await t.invoke(
        { ...env, MCP_WAITUNTIL_CAP_MS: '30' } as Env,
        session('member'),
        {},
        {
          turnId: TURN,
        },
      );
      expect(res.ok).toBe(true);
    } finally {
      logs.restore();
    }
    expect(logs.named('agent_waituntil_drain_capped')).toHaveLength(1);
  });

  it('the handler sees the agent invocation', async () => {
    let seen: unknown;
    const t = exposedPost('/api/agent-who', async (ctx) => {
      seen = ctx.invocation;
      return {};
    });
    await call(t);
    expect(seen).toEqual({ via: 'agent', turnId: TURN });
  });
});
