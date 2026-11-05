import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ALL_ROLES,
  can,
  isAgentScope,
  NON_DELEGABLE,
  PERMISSIONS,
  principalCan,
} from '../../src/auth/permissions';
import type { PersonBearerPrincipal, Principal, Role } from '../../src/auth/types';
import { defineRoute } from '../../src/framework/defineRoute';
import { fail } from '../../src/framework/envelope';
import { buildMcpTools, toolName, toolsForPrincipal } from '../../src/mcp/tools';
import { allRoutes } from '../../src/routes';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { eventNames } from '../helpers/logs';

// A live Principal the way the MCP adapter supplies one (re-resolved from the caller's token) —
// a LEGACY token's (scopes NULL), the widest a token can be.
function principal(role: Role): PersonBearerPrincipal {
  return {
    kind: 'person',
    email: USERS[role],
    name: `${role} user`,
    role,
    authMethod: 'api_token',
    credentialTransport: 'bearer',
    tokenScopes: null,
  };
}

// The same person on a session cookie: the role outright, no token ceiling.
function session(role: Role): Principal {
  const { tokenScopes: _none, ...identity } = principal(role);
  return { ...identity, authMethod: 'magic_link', credentialTransport: 'cookie' };
}

const tools = buildMcpTools(allRoutes);

// The agent keys gate routes that land with the agent loop (the run routes, `agent.use`; the DSR
// route, `agent.erase`), so no registered route carries them yet. These stand-ins do, so the list
// and invoke pins below cover every non-delegable key today. Their handlers record a call; under a
// bearer, none may ever run.
const ROUTELESS: readonly string[] = ['agent.use', 'agent.erase'];
const agentHandlerRuns: string[] = [];
const AGENT_STAND_INS = [
  defineRoute({
    method: 'POST',
    path: '/api/agent-stand-in/runs',
    permission: 'agent.use',
    audit: 'agent.stand_in.run',
    input: z.object({}),
    handler: async () => {
      agentHandlerRuns.push('agent.use');
      return { started: true };
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/api/agent-stand-in/dsr',
    permission: 'agent.erase',
    audit: 'agent.stand_in.dsr',
    input: z.object({}),
    handler: async () => {
      agentHandlerRuns.push('agent.erase');
      return { erased: 0 };
    },
  }),
];
const withAgentStandIns = buildMcpTools([...allRoutes, ...AGENT_STAND_INS]);

// A MACHINE route (RouteSpec.machine, B9) beside the live table. The kit ships none, but a fork's
// table may hold several (Insights' and il-Lingua's ingest routes), so the list oracle below must
// hold with one in it — this stand-in makes the kit's own CI prove that.
const MACHINE_STAND_IN = defineRoute({
  method: 'POST',
  path: '/api/machine-stand-in/batches',
  permission: 'notes.write',
  machine: true,
  audit: 'machine.stand_in.batch',
  input: z.object({}),
  handler: async () => ({ ok: true }),
});
const MACHINE_TOOL = 'post_machine_stand_in_batches';
const withMachineStandIn = buildMcpTools([...allRoutes, MACHINE_STAND_IN]);

const tool = (name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

async function countNotes(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{ n: number }>();
  return row?.n ?? 0;
}
async function countAudit(action: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?')
    .bind(action)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('MCP tool generation', () => {
  it('names tools deterministically and collision-free from method + path', () => {
    expect(toolName('GET', '/api/notes')).toBe('get_notes');
    expect(toolName('POST', '/api/notes')).toBe('post_notes');
    expect(toolName('GET', '/api/notes/:id')).toBe('get_notes_by_id');
    expect(toolName('POST', '/api/users/:email/revoke-sessions')).toBe(
      'post_users_by_email_revoke_sessions',
    );
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // all unique
  });

  it('builds one tool per registered route, each with an input schema', () => {
    expect(tools.length).toBe(allRoutes.length);
    for (const t of tools) expect(t.inputSchema).toBeTypeOf('object');
    expect(tools.some((t) => t.name === 'get_meta_manifest')).toBe(true);
  });

  it('throws on a tool-name collision (definition-time guard)', () => {
    const dup = allRoutes.find((d) => d.spec.path === '/api/notes' && d.spec.method === 'GET');
    if (!dup) throw new Error('fixture route missing');
    expect(() => buildMcpTools([dup, dup])).toThrow(/collision/i);
  });

  it('input schema is the input view — a defaulted field is optional, not required', () => {
    const schema = tool('post_notes').inputSchema as { required?: string[] };
    expect(schema.required).toEqual(['title']); // body defaults to '' → not required
  });

  // The list is filtered on the caller's EFFECTIVE permissions (principalCan), not its role: an
  // MCP caller is a bearer token, and a bearer never holds the non-delegable set (PIA C8).
  it('toolsForPrincipal exposes exactly what the caller may call (enumeration = 404-uniformity)', () => {
    expect(withMachineStandIn.map((t) => t.name)).toContain(MACHINE_TOOL);
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      for (const p of [principal(role), session(role)]) {
        const visible = new Set(toolsForPrincipal(withMachineStandIn, p).map((t) => t.name));
        for (const t of withMachineStandIn) {
          // A machine tool is a service's only: principalCan says a writer holds its key, but no
          // person may call it (principalMayCall), so no person is offered it.
          const allowed =
            !t.machine && (t.permission === 'authenticated' || principalCan(p, t.permission));
          expect(visible.has(t.name)).toBe(allowed);
        }
      }
    }
    // A viewer never sees the admin-only user tools.
    const viewerTools = new Set(toolsForPrincipal(tools, principal('viewer')).map((t) => t.name));
    expect(viewerTools.has('get_users')).toBe(false);
    expect(viewerTools.has('get_notes')).toBe(true);
  });

  it('a bearer owner is NOT offered a single non-delegable tool; the same owner on a session is', () => {
    const bearer = new Set(
      toolsForPrincipal(withAgentStandIns, principal('owner')).map((t) => t.permission),
    );
    const onSession = new Set(
      toolsForPrincipal(withAgentStandIns, session('owner')).map((t) => t.permission),
    );
    for (const key of NON_DELEGABLE) {
      expect(bearer.has(key as keyof typeof PERMISSIONS)).toBe(false);
      expect(onSession.has(key as keyof typeof PERMISSIONS)).toBe(true);
    }
    // Spelled out for the ones a leaked token would want most.
    const names = new Set(toolsForPrincipal(tools, principal('owner')).map((t) => t.name));
    for (const name of ['post_tokens', 'delete_tokens_by_id', 'get_tokens', 'get_audit']) {
      expect(names.has(name)).toBe(false);
    }
    expect(names.has('get_users')).toBe(true); // users.read stays delegable
  });

  // No MCP caller ever runs the agent or reaches its DSR route (PIA C8): an MCP caller is a bearer,
  // and both agent keys are non-delegable — whatever the role, and whatever the token's scopes say.
  it('no agent route appears in any bearer MCP list; the same owner on a session is offered both', () => {
    for (const role of ALL_ROLES) {
      const askedForThem: Principal = { ...principal(role), tokenScopes: [...ROUTELESS, 'ai.use'] };
      for (const p of [principal(role), askedForThem]) {
        const agentTools = toolsForPrincipal(withAgentStandIns, p).filter(
          (t) => t.permission !== 'authenticated' && isAgentScope(t.permission),
        );
        expect(agentTools.map((t) => t.name)).toEqual([]);
      }
    }
    const svc: Principal = {
      kind: 'service',
      email: 'svc-etl@test-app.invalid',
      name: 'Synthetic ETL',
      role: null,
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      service: { id: 1, slug: 'etl', scope: 'agent.use', custodianEmail: USERS.member },
    };
    expect(toolsForPrincipal(withAgentStandIns, svc)).toEqual([]);
    // The filter is the delegation rule, not the stand-ins' absence: a session is offered both.
    const onSession = toolsForPrincipal(withAgentStandIns, session('owner')).map(
      (t) => t.permission,
    );
    for (const key of ROUTELESS) expect(onSession).toContain(key);
  });

  it('a scoped token sees only its scopes (∩ role) — a scope beyond the role adds nothing', () => {
    const scoped: Principal = { ...principal('member'), tokenScopes: ['notes.read', 'users.read'] };
    const names = toolsForPrincipal(tools, scoped)
      .filter((t) => t.permission !== 'authenticated')
      .map((t) => t.permission);
    expect(new Set(names)).toEqual(new Set(['notes.read'])); // users.read is not a member's
    expect(can('member', 'notes.write')).toBe(true); // the role could write…
    expect(names).not.toContain('notes.write'); // …the token cannot
  });
});

describe('MCP tool list for a SERVICE principal', () => {
  it('lists exactly the tools behind its one scope — no authenticated tool, nothing else', () => {
    const svc: Principal = {
      kind: 'service',
      email: 'svc-etl@test-app.invalid',
      name: 'Synthetic ETL',
      role: null,
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      service: { id: 1, slug: 'etl', scope: 'notes.write', custodianEmail: USERS.member },
    };
    const listed = toolsForPrincipal(tools, svc);
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed.map((t) => t.permission))).toEqual(new Set(['notes.write']));
    expect(listed.map((t) => t.name)).not.toContain('get_me');
    // A machine tool behind its one scope is listed too: the machine gate admits a service.
    expect(toolsForPrincipal(withMachineStandIn, svc).map((t) => t.name)).toContain(MACHINE_TOOL);
  });
});

describe('MCP tool invocation shares the route pipeline', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('a permitted call runs the handler and writes the same audit row', async () => {
    const before = await countNotes();
    const res = await tool('post_notes').invoke(env, principal('member'), { title: 'from agent' });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0]!.text) as { id: string; title: string };
    expect(data.title).toBe('from agent');
    expect(await countNotes()).toBe(before + 1);
    expect(await countAudit('note.create')).toBe(1); // audit-on-write fired, exactly once
  });

  it('a read tool returns data; a create tool (Response via ok(…,201)) is unwrapped to the payload', async () => {
    // post_notes' handler returns `ok(note, 201)` (a Response) — the invoke must unwrap it to the note.
    const created = await tool('post_notes').invoke(env, principal('member'), { title: 'listed' });
    expect(created.isError).toBeFalsy();
    expect((JSON.parse(created.content[0]!.text) as { title: string }).title).toBe('listed');
    // get_notes returns a plain page object { items, next_cursor }.
    const res = await tool('get_notes').invoke(env, principal('viewer'), {});
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0]!.text) as { items: { title: string }[] };
    expect(data.items.some((n) => n.title === 'listed')).toBe(true);
  });

  // A delete handler returns `new Response(null, { status: 204 })` — no JSON body. The unwrap
  // must read that as a successful no-content result, not crash on an empty .json() and misreport
  // an already-committed, already-audited delete as an error (the HTTP path returns 204 fine).
  it('a 204 delete tool reports success (empty-body Response is not an error)', async () => {
    const created = await tool('post_notes').invoke(env, principal('member'), { title: 'doomed' });
    const { id } = JSON.parse(created.content[0]!.text) as { id: string };
    const del = await tool('delete_notes_by_id').invoke(env, principal('member'), { id });
    expect(del.isError).toBeFalsy(); // success, not "Internal error."
    expect(await countNotes()).toBe(0); // the note is actually gone
    expect(await countAudit('note.delete')).toBe(1); // and the delete was audited
  });

  it('a forbidden call is refused generically, runs no handler, writes no audit', async () => {
    const before = await countNotes();
    const res = await tool('post_notes').invoke(env, principal('viewer'), { title: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('This action is not available.');
    expect(await countNotes()).toBe(before); // handler never ran
    expect(await countAudit('note.create')).toBe(0); // nothing audited
  });

  it('denial is uniform: a forbidden tool reads identically to any other forbidden tool', async () => {
    const denyWrite = await tool('post_notes').invoke(env, principal('viewer'), { title: 'x' });
    const denyUsers = await tool('get_users').invoke(env, principal('viewer'), {});
    expect(denyWrite.content[0]!.text).toBe(denyUsers.content[0]!.text);
    expect(denyWrite.isError).toBe(true);
    expect(denyUsers.isError).toBe(true);
  });

  it('a bearer owner calling a non-delegable tool gets the generic denial and mints nothing', async () => {
    const res = await tool('post_tokens').invoke(env, principal('owner'), { name: 'escalate' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('This action is not available.');
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect(await countAudit('token.create')).toBe(0);
    const audit = await tool('get_audit').invoke(env, principal('owner'), {});
    expect(audit.content[0]!.text).toBe('This action is not available.');
  });

  it('a bearer owner whose token names an agent key is refused generically; no handler runs', async () => {
    const askedForThem: Principal = { ...principal('owner'), tokenScopes: [...ROUTELESS] };
    const agentTools = withAgentStandIns.filter((t) => ROUTELESS.includes(t.permission));
    expect(agentTools).toHaveLength(ROUTELESS.length);
    for (const t of agentTools) {
      for (const p of [principal('owner'), askedForThem]) {
        const res = await t.invoke(env, p, {});
        expect(res.isError).toBe(true);
        expect(res.content[0]!.text).toBe('This action is not available.');
      }
    }
    expect(agentHandlerRuns).toEqual([]);
  });

  it('a permitted caller sees a validation error (but a denied one never reaches validation)', async () => {
    // Permitted: member may write notes, so a missing title surfaces as a validation error.
    const invalid = await tool('post_notes').invoke(env, principal('member'), {});
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]!.text).not.toBe('This action is not available.'); // a real field error
    expect(invalid.content[0]!.text.toLowerCase()).toContain('title');
    // Denied: a viewer with the SAME invalid body still gets only the generic denial (perm first).
    const denied = await tool('post_notes').invoke(env, principal('viewer'), {});
    expect(denied.content[0]!.text).toBe('This action is not available.');
  });

  it('every permission is represented by at least one tool (the surface is complete)', () => {
    const usedPerms = new Set(tools.map((t) => t.permission));
    for (const key of Object.keys(PERMISSIONS)) {
      // A ROUTELESS key has no route yet, and must not: the day a route carries one, this fails
      // until the key leaves ROUTELESS — so the exemption expires on its own.
      expect(usedPerms.has(key as keyof typeof PERMISSIONS), key).toBe(!ROUTELESS.includes(key));
    }
  });

  // AICOE-449 mirrors: one executeRoute pipeline means the audit hardening applies to MCP
  // identically — a handler-returned error Response writes no success row, and background
  // work scheduled on ctx.waitUntil is awaited before the tool call returns (there is no
  // executionCtx here to keep dropped promises alive).
  it('a tool whose handler returns fail(4xx) writes no audit row', async () => {
    const [failing] = buildMcpTools([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: 'widget.create',
        input: z.object({}),
        handler: async () => fail(409, 'conflict', 'nope'),
      }),
    ]);
    if (!failing) throw new Error('tool was not built'); // never let this pass vacuously
    const res = await failing.invoke(env, principal('member'), {});
    expect(res).toBeDefined(); // the pipeline genuinely ran
    expect(await countAudit('widget.create')).toBe(0); // no success row for a failure
    // NOTE: res.isError is currently unset for handler-returned error Responses — that
    // misreporting is AICOE-457's scope, deliberately not asserted here either way.
  });

  it('awaits ctx.waitUntil background work before the tool call returns', async () => {
    let settled = false;
    const [tool_] = buildMcpTools([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: false,
        input: z.object({}),
        handler: async (ctx) => {
          ctx.waitUntil(
            new Promise<void>((resolve) =>
              setTimeout(() => {
                settled = true;
                resolve();
              }, 25),
            ),
          );
          return { ok: true };
        },
      }),
    ]);
    const res = await tool_?.invoke(env, principal('member'), {});
    expect(res?.isError).toBeFalsy();
    expect(settled).toBe(true); // the collected promise ran to completion, not dropped
  });

  it('drains background work scheduled BY background work (late pushes)', async () => {
    let chained = false;
    const [tool_] = buildMcpTools([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: false,
        input: z.object({}),
        handler: async (ctx) => {
          ctx.waitUntil(
            new Promise<void>((r) => setTimeout(r, 10)).then(() => {
              // Scheduled while the drain is already awaiting the first batch.
              ctx.waitUntil(
                new Promise<void>((r) => setTimeout(r, 10)).then(() => {
                  chained = true;
                }),
              );
            }),
          );
          return { ok: true };
        },
      }),
    ]);
    if (!tool_) throw new Error('tool was not built');
    await tool_.invoke(env, principal('member'), {});
    expect(chained).toBe(true); // the drain loop picked up the late push
  });

  it('a result JSON cannot carry resolves as Internal error. — logged, never a rejection', async () => {
    const [tool_] = buildMcpTools([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: false,
        input: z.object({}),
        handler: async () => ({ count: 10n }), // a BigInt: JSON.stringify throws
      }),
    ]);
    if (!tool_) throw new Error('tool was not built');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await tool_.invoke(env, principal('member'), {});
      expect(res).toEqual({ content: [{ type: 'text', text: 'Internal error.' }], isError: true });
      expect(eventNames(errorSpy.mock.calls)).toContain('mcp_tool_error');
      // An in-process agent turn logs it on the agent's channel.
      errorSpy.mockClear();
      const turn = { turnId: '7f3a9c2e-1b4d-4e8f-9a0b-2c3d4e5f6a7b' };
      expect((await tool_.invoke(env, principal('member'), {}, turn)).isError).toBe(true);
      expect(eventNames(errorSpy.mock.calls)).toContain('agent_tool_error');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a path param with an underscore is one name, as Hono reads it', async () => {
    const [tool_] = buildMcpTools([
      defineRoute({
        method: 'POST',
        path: '/api/widgets/:ticket_key/close',
        permission: 'authenticated',
        audit: 'widget.close',
        uniformityFixture: { seed: async () => ({ ticket_key: 'OPS-1' }) },
        input: z.object({ ticket_key: z.string().max(20) }),
        handler: async () => ({ closed: true }),
      }),
    ]);
    if (!tool_) throw new Error('tool was not built');
    expect(tool_.name).toBe('post_widgets_by_ticket_key_close');
    const res = await tool_.invoke(env, principal('member'), { ticket_key: 'OPS-42' });
    expect(res.isError).toBeFalsy();
    // The audit target defaults to the path param's value, exactly as the HTTP adapter records it.
    const row = await env.DB.prepare(
      "SELECT target FROM audit_log WHERE action = 'widget.close'",
    ).first<{ target: string | null }>();
    expect(row?.target).toBe('OPS-42');
  });

  it('caps the drain: a never-settling waitUntil promise cannot hang the tool call', async () => {
    const [tool_] = buildMcpTools([
      defineRoute({
        method: 'POST',
        path: '/api/widgets',
        permission: 'authenticated',
        audit: false,
        input: z.object({}),
        handler: async (ctx) => {
          ctx.waitUntil(new Promise(() => {})); // never settles
          return { ok: true };
        },
      }),
    ]);
    if (!tool_) throw new Error('tool was not built');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const capped = { ...env, MCP_WAITUNTIL_CAP_MS: '50' } as typeof env;
      const res = await tool_.invoke(capped, principal('member'), {});
      expect(res.isError).toBeFalsy(); // the result is unaffected by the hung background work
      expect(eventNames(errorSpy.mock.calls)).toContain('mcp_waituntil_drain_capped');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
