// THE ATTRIBUTION TRIPWIRE. One synthetic route, called once through every surface that runs a
// route — the HTTP adapter, an MCP tool, an MCP-shaped tool called by an IN-PROCESS agent loop with
// its turn, and an in-app agent tool (buildAgentTools) — and what each call wrote, end to end:
//
//   audit_log.payload_json   HTTP: the route's payload, byte-identical (no `_via`).
//                            MCP:  `_via: 'mcp'` appended.
//                            An agent call (either way in): `_via: 'agent'` and `_turn: <turn>`.
//   read_log.request_id      the turn id for an agent call; a fresh uuid for any other call.
//
// Why it lives in test/isolation/: /kit-upgrade carries this directory into every fork (kit-upgrade
// SKILL.md step 3), and the pieces that make it true live in files a fork may have DIVERGED and must
// hand-merge — src/framework/execute.ts (the invocation check, the payload stamp, the ledger id) and
// src/mcp/tools.ts. A partial merge that forgets one of them is a quiet attribution lie — agent
// writes filed as MCP or HTTP, a turn whose reads cannot be found — and this is the test that turns
// it red in the fork itself. The unit tests behind it are test/framework/invocation.test.ts and
// test/framework/agent-tools.test.ts.
//
// Fork-proof on purpose: it uses the kit's own `users` repository and `users.read` key, an owner
// session, and an `egressRuling` on its synthetic exposure (so an app that binds a client-class
// private database builds its tools too — docs/DATA-ROUTES.md). Nothing here is app data.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../src/auth/types';
import type { Env } from '../../src/env';
import { buildAgentTools, callAgentTool } from '../../src/framework/agentTools';
import { defineRoute, mountRoutes } from '../../src/framework/defineRoute';
import { buildMcpTools } from '../../src/mcp/tools';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { BASE, cookieFor } from '../helpers/http';

const ARMED = { ...env, READ_AUDIT: 'on' } as Env;
const ACTION = 'isolation_attribution.write';
const ROUTE = 'POST /api/isolation-attribution';
// Synthetic turn ids, the shape an agent loop mints (uuids).
const LOOP_TURN = '5d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6';
const AGENT_TURN = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';

const owner: Principal = {
  kind: 'person',
  email: USERS.owner,
  name: null,
  role: 'owner',
  authMethod: 'magic_link',
  credentialTransport: 'cookie',
};

// One read through the recorded data layer, one declared audit row.
const attributed = defineRoute({
  method: 'POST',
  path: '/api/isolation-attribution',
  permission: 'users.read',
  needs: ['users'],
  audit: ACTION,
  input: z.object({}),
  agent: { effect: 'write', egressRuling: 'C36-1561' },
  handler: async (ctx) => {
    await ctx.db.users.get(ctx.principal.email);
    ctx.setAuditTarget('isolation-target', { k: 1 });
    return { ok: true };
  },
});

async function payloads(): Promise<(string | null)[]> {
  const res = await env.DB.prepare(
    'SELECT payload_json FROM audit_log WHERE action = ? ORDER BY id',
  )
    .bind(ACTION)
    .all<{ payload_json: string | null }>();
  return res.results.map((r) => r.payload_json);
}

async function requestIds(): Promise<string[]> {
  const res = await env.DB.prepare('SELECT request_id FROM read_log WHERE route = ?')
    .bind(ROUTE)
    .all<{ request_id: string }>();
  return res.results.map((r) => r.request_id);
}

describe('every surface states its channel on what the call writes', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('HTTP, MCP, an in-process loop on MCP tools, and an agent tool — audit rows and ledger ids', async () => {
    // 1. HTTP adapter.
    const app = new Hono<{ Bindings: Env }>();
    mountRoutes(app, [attributed]);
    const scheduled: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => {
        scheduled.push(p);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const res = await app.request(
      `${BASE}/api/isolation-attribution`,
      {
        method: 'POST',
        headers: {
          cookie: await cookieFor(USERS.owner),
          origin: BASE,
          'content-type': 'application/json',
        },
        body: '{}',
      },
      ARMED,
      executionCtx,
    );
    expect(res.status).toBe(200);
    await Promise.allSettled(scheduled);

    // 2. An MCP tool, as the /mcp transport calls it.
    const [mcpTool] = buildMcpTools([attributed]);
    if (!mcpTool) throw new Error('the MCP tool was not built');
    expect((await mcpTool.invoke(ARMED, owner, {})).isError).toBeFalsy();

    // 3. The same MCP-shaped tool, called by an in-process agent loop that states its turn.
    expect((await mcpTool.invoke(ARMED, owner, {}, { turnId: LOOP_TURN })).isError).toBeFalsy();

    // 4. An in-app agent tool.
    const tools = buildAgentTools([attributed], owner);
    const result = await callAgentTool(
      ARMED,
      owner,
      tools,
      'post_isolation_attribution',
      {},
      {
        turnId: AGENT_TURN,
      },
    );
    expect(result).toEqual({ ok: true, data: { ok: true } });

    expect(await payloads()).toEqual([
      '{"k":1}',
      '{"k":1,"_via":"mcp"}',
      `{"k":1,"_via":"agent","_turn":"${LOOP_TURN}"}`,
      `{"k":1,"_via":"agent","_turn":"${AGENT_TURN}"}`,
    ]);

    const ids = await requestIds();
    expect(ids).toHaveLength(4);
    expect(ids.filter((id) => id === LOOP_TURN)).toHaveLength(1);
    expect(ids.filter((id) => id === AGENT_TURN)).toHaveLength(1);
    const others = ids.filter((id) => id !== LOOP_TURN && id !== AGENT_TURN);
    expect(new Set(others).size).toBe(2); // HTTP and MCP: a fresh id each
    for (const id of others) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
