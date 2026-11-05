// SERVICE PRINCIPALS end to end: a service identity's bearer token resolves to a machine principal
// (kind 'service', its own svc-…@….invalid identifier, no role) whose whole authority is ONE
// permission key; it is refused while the identity is disabled or its custodian is not an active
// user; everything it does is attributed to the identity, never to the custodian; and its token is
// minted only through mintApiTokenFor. Every identity here is synthetic.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { NON_DELEGABLE } from '../../src/auth/permissions';
import { mintApiTokenFor, resolveApiTokenByHash, sha256Hex } from '../../src/auth/tokens';
import type { Principal, Role, ServicePrincipal } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import type { RouteSpec } from '../../src/framework/defineRoute';
import { AppError } from '../../src/framework/errors';
import { executeRoute } from '../../src/framework/execute';
import { allRoutes } from '../../src/routes';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

const SVC = 'svc-etl@test-app.invalid';
const DAY_MS = 24 * 60 * 60 * 1000;
const daysUntil = (t: string) => (Date.parse(`${t.replace(' ', 'T')}Z`) - Date.now()) / DAY_MS;
const CANONICAL_404 = JSON.stringify({
  ok: false,
  error: { code: 'not_found', message: 'Not found' },
});

function session(email: string, role: Role): Principal {
  return {
    kind: 'person',
    email,
    name: null,
    role,
    authMethod: 'magic_link',
    credentialTransport: 'cookie',
  };
}

const OWNER = session(USERS.owner, 'owner');

async function identity(
  scope = 'notes.write',
  opts: { slug?: string; custodian?: string } = {},
): Promise<number> {
  const slug = opts.slug ?? 'etl';
  const res = await makeDb(env).serviceIdentities.create({
    slug,
    principalId: `svc-${slug}@test-app.invalid`,
    name: 'Synthetic ETL',
    scope,
    custodianEmail: opts.custodian ?? USERS.member,
    createdBy: USERS.owner,
  });
  if (!res.ok) throw new Error(`identity: ${res.reason}`);
  return res.row.id;
}

async function serviceToken(principalId = SVC, expiresInDays?: number) {
  return mintApiTokenFor(makeDb(env), OWNER, principalId, { name: 'etl prod', expiresInDays });
}

function bearer(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A token row inserted by hand, as a pre-upgrade or tampered one would be. */
async function rawServiceToken(scopes: string | null, email = SVC): Promise<string> {
  const plaintext = `t_${crypto.randomUUID().replaceAll('-', '')}rawsvc00`.slice(0, 42);
  await env.DB.prepare(
    "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 'raw', ?, ?, datetime('now', '+30 days'), ?)",
  )
    .bind(email, await sha256Hex(plaintext), plaintext.slice(0, 10), scopes)
    .run();
  return plaintext;
}

function jsonEvents(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    if (typeof call[0] !== 'string') continue;
    try {
      out.push(JSON.parse(call[0]) as Record<string, unknown>);
    } catch {
      // not a structured event
    }
  }
  return out;
}

async function status(p: Promise<unknown>): Promise<number | undefined> {
  const e = await p.catch((x: unknown) => x);
  return e instanceof AppError ? e.status : undefined;
}

describe('a service token resolves to a SERVICE principal', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('kind service, its own identifier, no role, exactly its identity — set by the resolver', async () => {
    const id = await identity('notes.write');
    const { token } = await serviceToken();
    const p = await resolveApiTokenByHash(env, await sha256Hex(token));
    expect(p).toEqual({
      kind: 'service',
      email: SVC,
      name: 'Synthetic ETL',
      role: null,
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      service: { id, slug: 'etl', scope: 'notes.write', custodianEmail: USERS.member },
    } satisfies ServicePrincipal);
  });

  it('touches last_used_at like any token', async () => {
    await identity();
    const { token, row } = await serviceToken();
    expect(row.last_used_at).toBeNull();
    await resolveApiTokenByHash(env, await sha256Hex(token));
    const after = await env.DB.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?')
      .bind(row.id)
      .first<{ last_used_at: string | null }>();
    expect(after?.last_used_at).not.toBeNull();
  });

  it('never resolves through `users` — a person row with the same address lends it nothing', async () => {
    // A pre-upgrade il-lingua-style users row for the identifier, role owner, and NO identity row.
    await env.DB.prepare("INSERT INTO users (email, role, added_by) VALUES (?, 'owner', ?)")
      .bind(SVC, USERS.owner)
      .run();
    const token = await rawServiceToken(null);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await resolveApiTokenByHash(env, await sha256Hex(token))).toBeNull();
      expect((await bearer(token, 'GET', '/api/users')).status).toBe(401);
      expect(jsonEvents(spy)).toContainEqual(
        expect.objectContaining({ event: 'api_token_refused', reason: 'service_identity_missing' }),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the one-scope ceiling, over HTTP', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('does exactly its scope: notes.write may create, and may NOT read — though every role that writes can', async () => {
    await identity('notes.write');
    const { token } = await serviceToken();
    expect((await bearer(token, 'POST', '/api/notes', { title: 'from the ETL' })).status).toBe(201);
    const read = await bearer(token, 'GET', '/api/notes');
    expect(read.status).toBe(404);
    expect(await read.text()).toBe(CANONICAL_404);
  });

  it('cannot exceed its scope whatever a role would allow — every other route is the uniform 404', async () => {
    await identity('notes.read');
    const { token } = await serviceToken();
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(200);
    const attempts: Array<[string, string, unknown?]> = [
      ['POST', '/api/notes', { title: 'x' }],
      ['GET', '/api/users'],
      ['POST', '/api/ai/complete', { prompt: 'x' }],
      ['GET', '/api/me'], // 'authenticated' — a person surface, never a machine's
      ['GET', '/api/tokens'],
      ['POST', '/api/tokens', { name: 'child' }],
      ['GET', '/api/audit'],
      ['GET', '/api/read-log'],
      ['GET', '/api/meta/manifest'],
      ['GET', '/api/settings/alerting'],
      ['POST', '/api/users', { email: 'x@test.example', role: 'viewer' }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await bearer(token, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.text()).toBe(CANONICAL_404);
    }
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
    expect(n?.n).toBe(1); // it minted nothing
  });

  it('a WIDER stored token ceiling adds nothing: authority is the identity’s scope, not the token’s', async () => {
    await identity('notes.read');
    const token = await rawServiceToken(
      JSON.stringify(['notes.read', 'notes.write', 'users.read']),
    );
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(200);
    expect((await bearer(token, 'POST', '/api/notes', { title: 'x' })).status).toBe(404);
    expect((await bearer(token, 'GET', '/api/users')).status).toBe(404);
  });

  it('a LEGACY (NULL) ceiling — a pre-upgrade token a fork ADOPTED by a data step — holds only the scope', async () => {
    await identity('notes.read');
    const token = await rawServiceToken(null);
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(200);
    expect((await bearer(token, 'POST', '/api/notes', { title: 'x' })).status).toBe(404);
  });

  it('a stored ceiling that EXCLUDES the scope is refused outright (401, logged)', async () => {
    await identity('notes.read');
    const token = await rawServiceToken(JSON.stringify(['notes.write']));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await bearer(token, 'GET', '/api/notes')).status).toBe(401);
      expect(jsonEvents(spy)).toContainEqual(
        expect.objectContaining({ event: 'api_token_refused', reason: 'service_scope_mismatch' }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('a scope that is no longer service-grantable refuses every token (the key moved, or is gone)', async () => {
    // Only a hand insert (or a later change to NON_DELEGABLE) can leave such a row.
    for (const [slug, scope] of [
      ['held', [...NON_DELEGABLE][0] as string],
      ['gone', 'no.such.key'],
    ]) {
      await env.DB.prepare(
        "INSERT INTO service_identities (slug, principal_id, name, scope, custodian_email, created_by) VALUES (?, ?, 'x', ?, ?, ?)",
      )
        .bind(slug, `svc-${slug}@test-app.invalid`, scope, USERS.member, USERS.owner)
        .run();
      const token = await rawServiceToken(JSON.stringify([scope]), `svc-${slug}@test-app.invalid`);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect((await bearer(token, 'GET', '/api/notes')).status).toBe(401);
        expect(jsonEvents(spy)).toContainEqual(
          expect.objectContaining({ reason: 'service_scope_not_grantable' }),
        );
      } finally {
        spy.mockRestore();
      }
    }
  });
});

describe('kill switch and custodian: fail closed, per request', () => {
  beforeAll(applySchema);

  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await seedDb();
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it('a DISABLED identity’s tokens are refused at once, and work again when it is re-enabled', async () => {
    const id = await identity('notes.read');
    const { token } = await serviceToken();
    const repo = makeDb(env).serviceIdentities;
    await repo.setDisabled(id, true, USERS.owner);
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(401);
    expect(jsonEvents(spy)).toContainEqual({
      event: 'api_token_refused',
      reason: 'service_identity_disabled',
      token_id: expect.any(Number),
      service_identity_id: id,
    });
    await repo.setDisabled(id, false, USERS.owner);
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(200);
  });

  it('a DISABLED custodian stops the machine (401) until someone accountable takes it over', async () => {
    const id = await identity('notes.read');
    const { token } = await serviceToken();
    await makeDb(env).users.setDisabled(USERS.member, true);
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(401);
    expect(jsonEvents(spy)).toContainEqual(
      expect.objectContaining({ reason: 'service_custodian_inactive', service_identity_id: id }),
    );
    // Log lines carry ids and a reason code, never an address.
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/@/);
    expect(await makeDb(env).serviceIdentities.setCustodian(id, USERS.admin, USERS.owner)).toBe(
      true,
    );
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(200);
  });

  it('a REMOVED custodian (the users row is gone) stops it too', async () => {
    await identity('notes.read');
    const { token } = await serviceToken();
    await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(USERS.member).run();
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(401);
  });

  it('an expired or revoked service token is refused like any other', async () => {
    await identity('notes.read');
    const { token, row } = await serviceToken();
    await makeDb(env).tokens.revoke(row.id, SVC);
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(401);
  });
});

describe('schema drift: code adopted, migration 0004 not applied', () => {
  beforeAll(applySchema);
  beforeEach(seedDb); // recreates service_identities after each test drops it

  it('a service token is REFUSED (401, logged with the remedy) — never an opaque 500 — and people are untouched', async () => {
    await identity('notes.read');
    const { token } = await serviceToken();
    const personal = await mintApiTokenFor(makeDb(env), OWNER, USERS.member, { name: 'p' });
    await env.DB.prepare('DROP TABLE service_identities').run();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await bearer(token, 'GET', '/api/notes')).status).toBe(401);
      expect(await resolveApiTokenByHash(env, await sha256Hex(token))).toBeNull();
      expect(jsonEvents(spy)).toContainEqual(
        expect.objectContaining({
          event: 'service_identities_schema_drift',
          remedy: 'apply_migration_0004_service_identities',
        }),
      );
      expect((await bearer(personal.token, 'GET', '/api/notes')).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('attribution: the identity, never the custodian', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('audit_log and the row itself name the service identity', async () => {
    await identity('notes.write');
    const { token } = await serviceToken();
    const res = await bearer(token, 'POST', '/api/notes', { title: 'ingested' });
    const note = ((await res.json()) as { data: { id: string; created_by: string } }).data;
    expect(note.created_by).toBe(SVC);
    const audit = await env.DB.prepare(
      "SELECT actor_email, target FROM audit_log WHERE action = 'note.create'",
    ).all<{ actor_email: string; target: string }>();
    expect(audit.results).toEqual([{ actor_email: SVC, target: note.id }]);
    const custodianRows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM audit_log WHERE actor_email = ?',
    )
      .bind(USERS.member)
      .first<{ n: number }>();
    expect(custodianRows?.n).toBe(0);
  });

  it('read_log names the service identity (READ_AUDIT armed)', async () => {
    await identity('notes.read');
    await makeDb(env).notes.create({ title: 'n', body: '', createdBy: USERS.owner });
    const { token } = await serviceToken();
    const principal = (await resolveApiTokenByHash(env, await sha256Hex(token))) as Principal;
    const spec = allRoutes.find((r) => r.spec.method === 'GET' && r.spec.path === '/api/notes')
      ?.spec as RouteSpec<z.ZodTypeAny>;
    const pending: Promise<unknown>[] = [];
    await executeRoute({ ...env, READ_AUDIT: 'on' } as Env, spec, principal, {
      ip: '',
      params: {},
      request: new Request(`${BASE}/api/notes`),
      waitUntil: (p) => {
        pending.push(p);
      },
      invocation: { via: 'http' },
      buildRawInput: () => ({}),
    });
    await Promise.allSettled(pending);
    const reads = (await makeDb(env).readLog.list({ limit: 10 })).items;
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.principal).toBe(SVC);
  });
});

describe('mintApiTokenFor — a service identity’s token', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('carries exactly the identity’s scope and is OWNED by its identifier', async () => {
    await identity('notes.write');
    const { token, row } = await serviceToken();
    expect(token).toMatch(/^t_[0-9a-f]{40}$/);
    expect(row.email).toBe(SVC);
    expect(JSON.parse(row.scopes ?? 'null')).toEqual(['notes.write']);
  });

  it('expiry: 90 days by default, what is asked for up to 365, and never more', async () => {
    await identity('notes.write');
    expect(daysUntil((await serviceToken()).row.expires_at)).toBeCloseTo(90, 0);
    expect(daysUntil((await serviceToken(SVC, 365)).row.expires_at)).toBeCloseTo(365, 0);
    expect(daysUntil((await serviceToken(SVC, 3650)).row.expires_at)).toBeCloseTo(365, 0);
  });

  it('scopes, if given, must be exactly the identity’s one scope (400) — no narrowing, no widening', async () => {
    await identity('notes.write');
    const db = makeDb(env);
    for (const scopes of [[], ['notes.read'], ['notes.write', 'notes.read'], ['users.manage']]) {
      expect(
        await status(mintApiTokenFor(db, OWNER, SVC, { name: 'x', scopes })),
        String(scopes),
      ).toBe(400);
    }
    const { row } = await mintApiTokenFor(db, OWNER, SVC, {
      name: 'x',
      scopes: ['notes.write', 'notes.write'],
    });
    expect(JSON.parse(row.scopes ?? 'null')).toEqual(['notes.write']);
  });

  it('refuses a bearer minter and an unknown identity with the uniform 404, writing nothing', async () => {
    await identity('notes.write');
    const db = makeDb(env);
    const bearerOwner = { ...OWNER, credentialTransport: 'bearer' } as Principal;
    expect(await status(mintApiTokenFor(db, bearerOwner, SVC, { name: 'x' }))).toBe(404);
    expect(
      await status(mintApiTokenFor(db, OWNER, 'svc-nope@test-app.invalid', { name: 'x' })),
    ).toBe(404);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('a SERVICE principal can never mint (it is not a person on a session)', async () => {
    await identity('notes.write');
    const { token } = await serviceToken();
    const svc = (await resolveApiTokenByHash(env, await sha256Hex(token))) as Principal;
    expect(await status(mintApiTokenFor(makeDb(env), svc, SVC, { name: 'child' }))).toBe(404);
  });

  it('refuses while the custodian is inactive (409 custodian_inactive)', async () => {
    await identity('notes.write');
    await makeDb(env).users.setDisabled(USERS.member, true);
    const err = await mintApiTokenFor(makeDb(env), OWNER, SVC, { name: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('custodian_inactive');
  });

  it('refuses a scope that is no longer service-grantable (409 scope_not_grantable)', async () => {
    await env.DB.prepare(
      "INSERT INTO service_identities (slug, principal_id, name, scope, custodian_email, created_by) VALUES ('etl', ?, 'x', 'tokens.self', ?, ?)",
    )
      .bind(SVC, USERS.member, USERS.owner)
      .run();
    const err = await mintApiTokenFor(makeDb(env), OWNER, SVC, { name: 'x' }).catch((e) => e);
    expect((err as AppError).code).toBe('scope_not_grantable');
  });

  it('only a session holding serviceIdentities.manage may mint one — a member cannot, even for a key it could delegate (404)', async () => {
    await identity('notes.write'); // a member may put notes.write into its OWN token
    for (const [email, role] of [
      [USERS.member, 'member'],
      [USERS.viewer, 'viewer'],
    ] as const) {
      expect(
        await status(
          mintApiTokenFor(makeDb(env), session(email, role), SVC, {
            name: 'x',
            expiresInDays: 365,
          }),
        ),
      ).toBe(404);
    }
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
    expect(n?.n).toBe(0);
    const admin = session(USERS.admin, 'admin');
    expect((await mintApiTokenFor(makeDb(env), admin, SVC, { name: 'x' })).row.email).toBe(SVC);
  });

  it('mints for a DISABLED identity (the incident flow) — the token is inert until re-enabled', async () => {
    const id = await identity('notes.read');
    await makeDb(env).serviceIdentities.setDisabled(id, true, USERS.owner);
    const { token } = await serviceToken();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await bearer(token, 'GET', '/api/notes')).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
    await makeDb(env).serviceIdentities.setDisabled(id, false, USERS.owner);
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(200);
  });

  it('a person owner still takes the person path (unchanged)', async () => {
    const { row } = await mintApiTokenFor(makeDb(env), OWNER, USERS.member, { name: 'x' });
    expect(row.email).toBe(USERS.member);
    expect(daysUntil(row.expires_at)).toBeCloseTo(90, 0);
    expect((await asUser(USERS.member, 'GET', '/api/tokens')).status).toBe(200);
  });
});
