// authz.denied: a SERVICE principal refused a route leaves exactly one content-free audit row
// (actor = the identity's own identifier, target = the route PATTERN, payload = the permission key
// and the identity id) — and the response stays the byte-identical uniform 404. A PERSON's denial
// leaves nothing (routine, and noise would bury the machine signal). All identities synthetic.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { mintApiTokenFor, resolveApiTokenByHash, sha256Hex } from '../../src/auth/tokens';
import type { Principal } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import type { RouteSpec } from '../../src/framework/defineRoute';
import { AppError } from '../../src/framework/errors';
import {
  AUTHZ_DENIED_AUDIT_LIMIT,
  AUTHZ_DENIED_AUDIT_WINDOW_SEC,
  executeRoute,
} from '../../src/framework/execute';
import { buildMcpTools } from '../../src/mcp/tools';
import { allRoutes } from '../../src/routes';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';
import { eventNames, loggedEvents } from '../helpers/logs';

const SVC = 'svc-etl@test-app.invalid';
const OWNER: Principal = {
  kind: 'person',
  email: USERS.owner,
  name: null,
  role: 'owner',
  authMethod: 'magic_link',
  credentialTransport: 'cookie',
};

let identityId = 0;

async function serviceToken(scope = 'notes.write'): Promise<string> {
  const res = await makeDb(env).serviceIdentities.create({
    slug: 'etl',
    principalId: SVC,
    name: 'Synthetic ETL',
    scope,
    custodianEmail: USERS.member,
    createdBy: USERS.owner,
  });
  if (!res.ok) throw new Error(res.reason);
  identityId = res.row.id;
  return (await mintApiTokenFor(makeDb(env), OWNER, SVC, { name: 'etl' })).token;
}

function bearer(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'cf-connecting-ip': '198.51.100.23',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface Row {
  actor_email: string;
  target: string | null;
  payload_json: string | null;
  ip: string | null;
}

async function denials(): Promise<Row[]> {
  return (
    await env.DB.prepare(
      "SELECT actor_email, target, payload_json, ip FROM audit_log WHERE action = 'authz.denied' ORDER BY id",
    ).all<Row>()
  ).results;
}

/**
 * The denial rows once the background write has landed. Over HTTP the row is written in the
 * worker's waitUntil (a KV throttle check, then the insert) AFTER the 404 is returned, so a test
 * that reads straight away races it; wait for `count` rows (bounded, then fail).
 */
async function landedDenials(count = 1): Promise<Row[]> {
  return vi.waitFor(
    async () => {
      const rows = await denials();
      if (rows.length < count) throw new Error(`waiting for ${count} authz.denied row(s)`);
      return rows;
    },
    { timeout: 2000, interval: 10 },
  );
}

const VARIABLE_HEADERS = new Set(['date', 'cf-ray', 'report-to', 'nel']);
function headerFingerprint(res: Response): string {
  return JSON.stringify(
    [...res.headers.entries()]
      .map(([k, v]) => [k.toLowerCase(), v] as const)
      .filter(([k]) => !VARIABLE_HEADERS.has(k))
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

describe('authz.denied — service principals only', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('a denied service call is the uniform 404 AND one content-free row', async () => {
    const token = await serviceToken('notes.write');
    const denied = await bearer(token, 'GET', '/api/users');
    const missing = await bearer(token, 'GET', '/api/definitely-not-a-route');
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
    expect(headerFingerprint(denied)).toBe(headerFingerprint(missing));

    expect(await landedDenials()).toEqual([
      {
        actor_email: SVC,
        target: 'GET /api/users',
        payload_json: JSON.stringify({ permission: 'users.read', service_identity_id: identityId }),
        ip: '198.51.100.23',
      },
    ]);
  });

  it('records the route PATTERN, never a path value, and never the input', async () => {
    const token = await serviceToken('notes.read');
    const note = await makeDb(env).notes.create({
      title: 'real',
      body: '',
      createdBy: USERS.owner,
    });
    const res = await bearer(token, 'PUT', `/api/notes/${note.id}`, {
      title: 'secret-title-value',
    });
    expect(res.status).toBe(404);
    const [row] = await landedDenials();
    expect(row?.target).toBe('PUT /api/notes/:id');
    const everything = JSON.stringify(
      (await env.DB.prepare('SELECT * FROM audit_log').all()).results,
    );
    expect(everything).not.toContain(note.id);
    expect(everything).not.toContain('secret-title-value');
  });

  it("an 'authenticated' route is a denial for a machine too", async () => {
    const token = await serviceToken('notes.read');
    expect((await bearer(token, 'GET', '/api/me')).status).toBe(404);
    expect(JSON.parse((await landedDenials())[0]?.payload_json ?? '{}')).toEqual({
      permission: 'authenticated',
      service_identity_id: identityId,
    });
  });

  it('an ALLOWED service call writes no denial', async () => {
    const token = await serviceToken('notes.write');
    expect((await bearer(token, 'POST', '/api/notes', { title: 'ok' })).status).toBe(201);
    expect(await denials()).toEqual([]);
  });

  it('a PERSON denied — by session or by a narrowed personal token — writes nothing', async () => {
    expect((await asUser(USERS.viewer, 'GET', '/api/users')).status).toBe(404);
    const { token } = await mintApiTokenFor(makeDb(env), OWNER, USERS.member, {
      name: 'narrow',
      scopes: [],
    });
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(404);
    expect((await bearer(token, 'GET', '/api/tokens')).status).toBe(404);
    expect(await denials()).toEqual([]);
  });

  it('over MCP too: the tool call reads as the generic refusal, and the row is written', async () => {
    const token = await serviceToken('notes.read');
    const principal = (await resolveApiTokenByHash(env, await sha256Hex(token))) as Principal;
    const tool = buildMcpTools(allRoutes).find((t) => t.name === 'post_notes');
    const result = await tool?.invoke(env, principal, { title: 'x' });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'This action is not available.' }],
      isError: true,
    });
    expect((await denials())[0]).toMatchObject({ actor_email: SVC, target: 'POST /api/notes' });
  });
});

describe('authz.denied — bounded: a flood cannot grow the append-only audit_log without limit', () => {
  beforeAll(applySchema);

  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await seedDb(); // also clears the rate-limit counters (rl:*) in KV
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  const LIMIT = 5; // rows per identity × route pattern × hour

  it('the bound is five rows per identity × route pattern per hour (pinned: change it on purpose)', () => {
    expect([AUTHZ_DENIED_AUDIT_LIMIT, AUTHZ_DENIED_AUDIT_WINDOW_SEC]).toEqual([LIMIT, 3600]);
  });

  const specOf = (method: string, path: string) =>
    allRoutes.find((r) => r.spec.method === method && r.spec.path === path)
      ?.spec as RouteSpec<z.ZodTypeAny>;

  // executeRoute directly, draining each call's background work before the next — so the count is
  // deterministic (over HTTP, KV's racy increments may let a burst through a little past the limit).
  async function deny(principal: Principal, spec: RouteSpec<z.ZodTypeAny>): Promise<unknown> {
    const pending: Promise<unknown>[] = [];
    const err = await executeRoute(env, spec, principal, {
      ip: '',
      params: {},
      request: new Request(`${BASE}${spec.path}`),
      waitUntil: (p) => {
        pending.push(p);
      },
      invocation: { via: 'http' },
      buildRawInput: () => ({}),
    }).catch((e: unknown) => e);
    await Promise.allSettled(pending);
    return err;
  }

  it(`keeps the first ${LIMIT} rows per identity and route pattern per hour; every answer is still the 404`, async () => {
    const token = await serviceToken('notes.read');
    const principal = (await resolveApiTokenByHash(env, await sha256Hex(token))) as Principal;
    const users = specOf('GET', '/api/users');
    const me = specOf('GET', '/api/me');
    for (let i = 0; i < LIMIT + 3; i++) {
      expect(((await deny(principal, users)) as AppError).status).toBe(404);
    }
    expect(((await deny(principal, me)) as AppError).status).toBe(404);
    const rows = await denials();
    expect(rows.filter((r) => r.target === 'GET /api/users')).toHaveLength(LIMIT);
    // Another route is its own bucket: its first denial is still evidence.
    expect(rows.filter((r) => r.target === 'GET /api/me')).toHaveLength(1);
    // The rest are counted in the logs, content-free (identity id + route pattern).
    const suppressed = loggedEvents(spy.mock.calls).filter(
      (e) => e.event === 'authz_denied_audit_suppressed',
    );
    expect(suppressed).toEqual(
      Array.from({ length: 3 }, () => ({
        event: 'authz_denied_audit_suppressed',
        service_identity_id: identityId,
        route: 'GET /api/users',
      })),
    );
  });

  it('the bucket is per identity: a second identity denied the same route still leaves its rows', async () => {
    const first = await serviceToken('notes.read');
    const a = (await resolveApiTokenByHash(env, await sha256Hex(first))) as Principal;
    const res = await makeDb(env).serviceIdentities.create({
      slug: 'crm',
      principalId: 'svc-crm@test-app.invalid',
      name: 'Synthetic CRM',
      scope: 'notes.read',
      custodianEmail: USERS.member,
      createdBy: USERS.owner,
    });
    if (!res.ok) throw new Error(res.reason);
    const second = await mintApiTokenFor(makeDb(env), OWNER, 'svc-crm@test-app.invalid', {
      name: 'crm',
    });
    const b = (await resolveApiTokenByHash(env, await sha256Hex(second.token))) as Principal;
    const users = specOf('GET', '/api/users');
    for (let i = 0; i < LIMIT + 1; i++) await deny(a, users);
    await deny(b, users);
    const actors = (await denials()).map((r) => r.actor_email);
    expect(actors.filter((x) => x === SVC)).toHaveLength(LIMIT);
    expect(actors.filter((x) => x === 'svc-crm@test-app.invalid')).toHaveLength(1);
  });
});

describe('authz.denied — an audit failure never changes the answer', () => {
  beforeAll(applySchema);

  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await seedDb();
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  const spec = allRoutes.find((r) => r.spec.method === 'GET' && r.spec.path === '/api/users')
    ?.spec as RouteSpec<z.ZodTypeAny>;

  async function deny(waitUntil: (p: Promise<unknown>) => void): Promise<unknown> {
    const token = await serviceToken('notes.read');
    const principal = (await resolveApiTokenByHash(env, await sha256Hex(token))) as Principal;
    return executeRoute(env, spec, principal, {
      ip: '',
      params: {},
      request: new Request(`${BASE}/api/users`),
      waitUntil,
      invocation: { via: 'http' },
      buildRawInput: () => {
        throw new Error('input must never be built for a denied caller');
      },
    }).catch((e: unknown) => e);
  }

  it('a failed insert is logged by error class and swallowed — still the 404', async () => {
    const token = await serviceToken('notes.read');
    const principal = (await resolveApiTokenByHash(env, await sha256Hex(token))) as Principal;
    await env.DB.prepare('DROP TABLE audit_log').run(); // seedDb recreates it for the next test
    const pending: Promise<unknown>[] = [];
    const err = await executeRoute(env, spec, principal, {
      ip: '',
      params: {},
      request: new Request(`${BASE}/api/users`),
      waitUntil: (p) => {
        pending.push(p);
      },
      invocation: { via: 'http' },
      buildRawInput: () => ({}),
    }).catch((e: unknown) => e);
    await Promise.allSettled(pending);
    expect((err as AppError).status).toBe(404);
    expect(loggedEvents(spy.mock.calls)).toContainEqual({
      event: 'authz_denied_audit_failed',
      err: { name: 'Error' },
    });
  });

  it('a broken waitUntil is swallowed — still the 404, input never built', async () => {
    const err = await deny(() => {
      throw new Error('no scheduler');
    });
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(404);
    expect(eventNames(spy.mock.calls)).toContain('authz_denied_schedule_failed');
  });
});
