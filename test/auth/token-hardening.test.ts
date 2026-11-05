// PIA C8 — token hardening, end to end over HTTP plus the pieces underneath. What a bearer token
// can do is now: its owner's LIVE role ∩ its stored scopes, minus the non-delegable set; it
// always expires (≤ 90 days); it can never mint, list or revoke tokens; and a fork's policy hook
// can refuse it. Every denial is the uniform 404 (or a 401 when there is no principal at all).
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { grantableScopes, NON_DELEGABLE } from '../../src/auth/permissions';
import {
  mintApiToken,
  mintApiTokenFor,
  parseTokenScopes,
  resolveApiTokenByHash,
  resolveMintScopes,
  sha256Hex,
} from '../../src/auth/tokens';
import type {
  PersonBearerPrincipal,
  PersonCookiePrincipal,
  Principal,
  Role,
  TokenRefusalCheck,
} from '../../src/auth/types';
import { makeDb } from '../../src/data';
import {
  ApiTokenSchemaDriftError,
  TOKEN_MAX_TTL_DAYS,
  tokensRepo,
  tokenTtlDays,
} from '../../src/data/tokens';
import { AppError } from '../../src/framework/errors';
import { allRoutes } from '../../src/routes';
import { refuseTokenFor } from '../../src/routes/tokenPolicy';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

const DAY_MS = 24 * 60 * 60 * 1000;

async function mint(
  email: string,
  body: Record<string, unknown> = { name: 'c8-token' },
): Promise<{ token: string; id: number; scopes: string[] | null; expires_at: string }> {
  const res = await asUser(email, 'POST', '/api/tokens', body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: never }).data;
}

function bearer(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A token as the 0003 migration leaves a pre-C8 one: scopes NULL, a finite expiry. */
async function legacyToken(email: string): Promise<string> {
  const plaintext = `t_${crypto.randomUUID().replaceAll('-', '')}legacy00`.slice(0, 42);
  await env.DB.prepare(
    "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 'legacy', ?, ?, datetime('now', '+30 days'), NULL)",
  )
    .bind(email, await sha256Hex(plaintext), plaintext.slice(0, 10))
    .run();
  return plaintext;
}

function daysUntil(sqliteUtc: string): number {
  return (Date.parse(`${sqliteUtc.replace(' ', 'T')}Z`) - Date.now()) / DAY_MS;
}

/** Every console.error line that parses as a JSON event, for asserting on the distinct signal. */
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

const CANONICAL_404 = JSON.stringify({
  ok: false,
  error: { code: 'not_found', message: 'Not found' },
});

describe('C8: a bearer token can never manage tokens', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('cannot mint, list or revoke — each is the byte-identical uniform 404', async () => {
    const { token, id } = await mint(USERS.owner);
    const attempts = [
      await bearer(token, 'POST', '/api/tokens', { name: 'child' }),
      await bearer(token, 'GET', '/api/tokens'),
      await bearer(token, 'DELETE', `/api/tokens/${id}`),
    ];
    const missing = await bearer(token, 'GET', '/api/definitely-not-a-route');
    const missingBody = await missing.text();
    expect(missingBody).toBe(CANONICAL_404);
    for (const res of attempts) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(missingBody);
    }
    // Nothing was minted and nothing was revoked.
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n, MAX(revoked_at) AS r FROM api_tokens',
    ).first<{ n: number; r: string | null }>();
    expect(rows).toEqual({ n: 1, r: null });
  });

  it('holds for a LEGACY (NULL-scope) token too — tokens.self is non-delegable, not just unscoped', async () => {
    const token = await legacyToken(USERS.owner);
    expect((await bearer(token, 'POST', '/api/tokens', { name: 'child' })).status).toBe(404);
    expect((await bearer(token, 'GET', '/api/tokens')).status).toBe(404);
  });

  it('mintApiToken refuses a bearer principal directly (the second wall, for fork routes)', async () => {
    const p: Principal = {
      kind: 'person',
      email: USERS.owner,
      name: null,
      role: 'owner',
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      tokenScopes: null,
    };
    const err = await mintApiToken(makeDb(env), p, { name: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(404);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe('C8: the non-delegable set is out of reach of every bearer token', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  // Owner-level routes behind each non-delegable key; the owner's SESSION reaches every one.
  const GUARDED: Array<[string, string, string, unknown?]> = [
    ['users.manage', 'POST', '/api/users', { email: 'new@test.example', role: 'viewer' }],
    ['audit.read', 'GET', '/api/audit'],
    ['readLog.read', 'GET', '/api/read-log'],
    ['settings.manage', 'GET', '/api/settings/alerting'],
    ['meta.read', 'GET', '/api/meta/manifest'],
    ['tokens.self', 'GET', '/api/tokens'],
    ['serviceIdentities.manage', 'GET', '/api/service-identities'],
  ];

  // Non-delegable keys no route carries YET: the agent keys, whose routes land with the agent DSR
  // route (agent.erase) and the run routes (agent.use). Until then a token's hold on them is pinned
  // at the principal and GET /api/me (below, and test/auth/permissions.test.ts). Each entry expires
  // on its own: the test after next fails the day a route carries the key, until it moves to
  // GUARDED with that route.
  const ROUTELESS = ['agent.use', 'agent.erase'];

  it('covers the whole set (a new non-delegable key needs a row here)', () => {
    expect(new Set([...GUARDED.map(([k]) => k), ...ROUTELESS])).toEqual(new Set(NON_DELEGABLE));
  });

  it('a ROUTELESS key really has no route — once one does, it moves to GUARDED', () => {
    for (const key of ROUTELESS) {
      expect(
        allRoutes.some((r) => r.spec.permission === key),
        key,
      ).toBe(false);
    }
  });

  for (const [key, method, path, body] of GUARDED) {
    it(`${key}: an owner's legacy token gets 404 on ${method} ${path}; the owner's session does not`, async () => {
      const token = await legacyToken(USERS.owner);
      const viaToken = await bearer(token, method, path, body);
      expect(viaToken.status).toBe(404);
      expect(await viaToken.text()).toBe(CANONICAL_404);
      const viaSession = await asUser(USERS.owner, method, path, body);
      expect(viaSession.status).toBeLessThan(300);
    });
  }

  it('an explicit scope list cannot smuggle one in: a stored non-delegable key is ignored', async () => {
    // Written straight to the table — the mint path would 400 it (below).
    const plaintext = 't_smuggle0000000000000000000000000000000000'.slice(0, 42);
    await env.DB.prepare(
      "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 's', ?, 't_smuggle0', datetime('now', '+1 day'), ?)",
    )
      .bind(USERS.owner, await sha256Hex(plaintext), JSON.stringify([...NON_DELEGABLE]))
      .run();
    for (const [, method, path, body] of GUARDED) {
      expect((await bearer(plaintext, method, path, body)).status).toBe(404);
    }
  });

  it('a legacy token keeps every DELEGABLE permission of its role (no lockout on upgrade)', async () => {
    const token = await legacyToken(USERS.admin);
    expect((await bearer(token, 'GET', '/api/users')).status).toBe(200); // users.read
    expect((await bearer(token, 'POST', '/api/notes', { title: 'etl' })).status).toBe(201);
  });

  it('GET /api/me reports the token’s EFFECTIVE permissions, not the role’s', async () => {
    const token = await legacyToken(USERS.owner);
    const res = await bearer(token, 'GET', '/api/me');
    const body = (await res.json()) as { data: { role: string; permissions: string[] } };
    expect(body.data.role).toBe('owner');
    for (const key of NON_DELEGABLE) expect(body.data.permissions).not.toContain(key);
    expect(body.data.permissions).toContain('users.read');
    const session = (await (await asUser(USERS.owner, 'GET', '/api/me')).json()) as {
      data: { permissions: string[] };
    };
    for (const key of NON_DELEGABLE) expect(session.data.permissions).toContain(key);
  });
});

describe('C8: scopes are a ceiling', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('a token minted without scopes gets an explicit snapshot of what the role may delegate', async () => {
    const created = await mint(USERS.admin);
    expect(created.scopes).toEqual(grantableScopes('admin'));
    const row = await env.DB.prepare('SELECT scopes FROM api_tokens WHERE id = ?')
      .bind(created.id)
      .first<{ scopes: string }>();
    expect(JSON.parse(row?.scopes ?? 'null')).toEqual(grantableScopes('admin'));
  });

  it('a scoped token can do exactly what it names, within its role', async () => {
    const { token } = await mint(USERS.member, { name: 'reader', scopes: ['notes.read'] });
    expect((await bearer(token, 'GET', '/api/notes')).status).toBe(200);
    expect((await bearer(token, 'POST', '/api/notes', { title: 'x' })).status).toBe(404);
  });

  it('refuses at mint a scope beyond the role, a non-delegable scope, or an unknown key (400)', async () => {
    for (const scopes of [['users.read'], ['tokens.self'], ['notes.read', 'no.such.key']]) {
      const res = await asUser(USERS.member, 'POST', '/api/tokens', { name: 'x', scopes });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('validation_failed');
      expect(body.error.message).toMatch(/not grantable/);
    }
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('dedupes and sorts the requested scopes; [] is a valid identity-only token', async () => {
    const a = await mint(USERS.member, {
      name: 'x',
      scopes: ['notes.write', 'notes.read', 'notes.write'],
    });
    expect(a.scopes).toEqual(['notes.read', 'notes.write']);
    const b = await mint(USERS.member, { name: 'id-only', scopes: [] });
    expect(b.scopes).toEqual([]);
    expect((await bearer(b.token, 'GET', '/api/me')).status).toBe(200);
    expect((await bearer(b.token, 'GET', '/api/notes')).status).toBe(404);
  });

  it('a later PROMOTION of the owner never widens an existing token', async () => {
    const { token } = await mint(USERS.member);
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE email = ?")
      .bind(USERS.member)
      .run();
    expect((await bearer(token, 'GET', '/api/users')).status).toBe(404); // users.read: not minted
  });

  it('a DEMOTION of the owner narrows every token at once (the live role still bounds it)', async () => {
    const { token } = await mint(USERS.admin);
    expect((await bearer(token, 'GET', '/api/users')).status).toBe(200);
    await env.DB.prepare("UPDATE users SET role = 'viewer' WHERE email = ?")
      .bind(USERS.admin)
      .run();
    expect((await bearer(token, 'GET', '/api/users')).status).toBe(404);
    expect((await bearer(token, 'POST', '/api/notes', { title: 'x' })).status).toBe(404);
  });

  it('resolveMintScopes: omitted → the agent-free snapshot; given → validated, sorted', () => {
    expect(resolveMintScopes('viewer')).toEqual(['notes.read']);
    expect(resolveMintScopes('owner', ['notes.read'])).toEqual(['notes.read']);
    expect(() => resolveMintScopes('owner', ['users.manage'])).toThrow(/not grantable/);
  });

  it('a stored scope value that is not an array of short strings refuses the token (401)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const plaintext = 't_corrupt0000000000000000000000000000000000'.slice(0, 42);
      // Valid JSON array (the CHECK admits it), but not strings — the parser is the second wall.
      await env.DB.prepare(
        "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 'c', ?, 't_corrupt0', datetime('now', '+1 day'), '[1]')",
      )
        .bind(USERS.owner, await sha256Hex(plaintext))
        .run();
      expect((await bearer(plaintext, 'GET', '/api/me')).status).toBe(401);
      expect(jsonEvents(spy).some((e) => e.event === 'api_token_scopes_invalid')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('the schema itself rejects a scopes value that is not a JSON array', async () => {
    for (const bad of ['not json', '{"a":1}', '"notes.read"']) {
      await expect(
        env.DB.prepare(
          "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES ('x@test.example', 'x', ?, 't_x', datetime('now', '+1 day'), ?)",
        )
          .bind(crypto.randomUUID(), bad)
          .run(),
      ).rejects.toThrow();
    }
  });

  it('parseTokenScopes: null is legacy, an array is a ceiling, anything else is corrupt', () => {
    expect(parseTokenScopes(null)).toEqual({ scopes: null });
    expect(parseTokenScopes('["notes.read"]')).toEqual({ scopes: ['notes.read'] });
    expect(parseTokenScopes('[]')).toEqual({ scopes: [] });
    for (const bad of [
      'nope',
      '{}',
      '[1]',
      '[""]',
      `["${'x'.repeat(65)}"]`,
      JSON.stringify(Array(65).fill('a')),
    ]) {
      expect(parseTokenScopes(bad)).toBeNull();
    }
  });
});

// The admin-issued / service-identity case (il-lingua issues tokens for an integration's own
// non-loginable account under users.manage). mintApiToken only mints for the caller; this is the
// sanctioned path for a token OWNED BY someone else, with the same walls plus a two-role ceiling.
describe('C8: mintApiTokenFor — a token owned by another account', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  function session(email: string, role: Role): PersonCookiePrincipal {
    return {
      kind: 'person',
      email,
      name: null,
      role,
      authMethod: 'magic_link',
      credentialTransport: 'cookie',
    };
  }

  async function status(err: Promise<unknown>): Promise<number | undefined> {
    const e = await err.catch((x: unknown) => x);
    return e instanceof AppError ? e.status : undefined;
  }

  async function tokenCount(): Promise<number> {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
    return n?.n ?? -1;
  }

  it('an admin issues a member account its token: owned by, and acting as, the member', async () => {
    const { token, row } = await mintApiTokenFor(
      makeDb(env),
      session(USERS.admin, 'admin'),
      USERS.member,
      { name: 'svc-etl' },
    );
    expect(row.email).toBe(USERS.member);
    // Default: the snapshot of what BOTH roles may delegate — here the member's delegable keys.
    expect(parseTokenScopes(row.scopes)?.scopes).toEqual(grantableScopes('member'));
    expect(Math.round(daysUntil(row.expires_at))).toBe(TOKEN_MAX_TTL_DAYS);
    const me = (await (await bearer(token, 'GET', '/api/me')).json()) as {
      data: { email: string; role: string };
    };
    expect(me.data).toMatchObject({ email: USERS.member, role: 'member' });
    expect((await bearer(token, 'POST', '/api/notes', { title: 'etl' })).status).toBe(201);
    expect((await bearer(token, 'GET', '/api/users')).status).toBe(404); // the member's role
  });

  it('the ceiling is BOTH roles: a less privileged minter cannot hand an admin-owned token more than it holds', async () => {
    const minter = session(USERS.member, 'member');
    expect(
      await status(
        mintApiTokenFor(makeDb(env), minter, USERS.admin, { name: 'x', scopes: ['users.read'] }),
      ),
    ).toBe(400);
    const { row } = await mintApiTokenFor(makeDb(env), minter, USERS.admin, { name: 'y' });
    const scopes = parseTokenScopes(row.scopes)?.scopes ?? [];
    expect(scopes).not.toContain('users.read');
    expect(scopes).toEqual(grantableScopes('member'));
  });

  it("a scope beyond the OWNER's role, or a non-delegable one, is a 400 naming it", async () => {
    const admin = session(USERS.admin, 'admin');
    for (const scopes of [['users.read'], ['tokens.self'], ['no.such.key']]) {
      const e = await mintApiTokenFor(makeDb(env), admin, USERS.member, {
        name: 'x',
        scopes,
      }).catch((x: unknown) => x);
      expect((e as AppError).status).toBe(400);
      expect((e as AppError).message).toContain(scopes[0] as string);
    }
    expect(await tokenCount()).toBe(0);
  });

  it('explicit scopes within both ceilings are kept exactly (deduped, sorted)', async () => {
    const { row } = await mintApiTokenFor(
      makeDb(env),
      session(USERS.owner, 'owner'),
      USERS.member,
      {
        name: 'reader',
        scopes: ['notes.read', 'notes.read'],
      },
    );
    expect(parseTokenScopes(row.scopes)?.scopes).toEqual(['notes.read']);
  });

  it('refuses a bearer minter, and an unknown or disabled owner, with the uniform 404 — and writes nothing', async () => {
    const bearerAdmin: Principal = {
      ...session(USERS.admin, 'admin'),
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      tokenScopes: null,
    };
    expect(
      await status(mintApiTokenFor(makeDb(env), bearerAdmin, USERS.member, { name: 'x' })),
    ).toBe(404);
    const admin = session(USERS.admin, 'admin');
    expect(
      await status(mintApiTokenFor(makeDb(env), admin, 'nobody@test.example', { name: 'x' })),
    ).toBe(404);
    await env.DB.prepare("UPDATE users SET disabled_at = datetime('now') WHERE email = ?")
      .bind(USERS.viewer)
      .run();
    expect(await status(mintApiTokenFor(makeDb(env), admin, USERS.viewer, { name: 'x' }))).toBe(
      404,
    );
    expect(await tokenCount()).toBe(0);
  });

  it('clamps a fork route’s 365-day request to the cap, like every mint', async () => {
    const { row } = await mintApiTokenFor(
      makeDb(env),
      session(USERS.admin, 'admin'),
      USERS.member,
      {
        name: 'svc',
        expiresInDays: 365,
      },
    );
    expect(Math.round(daysUntil(row.expires_at))).toBe(TOKEN_MAX_TTL_DAYS);
  });
});

describe('C8: every new token expires, within 90 days', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('defaults to TOKEN_MAX_TTL_DAYS when no expiry is asked for', async () => {
    const { expires_at } = await mint(USERS.member);
    expect(TOKEN_MAX_TTL_DAYS).toBe(90);
    expect(daysUntil(expires_at)).toBeGreaterThan(89.9);
    expect(daysUntil(expires_at)).toBeLessThanOrEqual(90);
  });

  it('honours a shorter expiry', async () => {
    const { expires_at } = await mint(USERS.member, { name: 'short', expires_in_days: 7 });
    expect(Math.round(daysUntil(expires_at))).toBe(7);
  });

  it('the kit route refuses more than the cap (400)', async () => {
    const res = await asUser(USERS.member, 'POST', '/api/tokens', {
      name: 'forever-ish',
      expires_in_days: 365,
    });
    expect(res.status).toBe(400);
  });

  it('the DATA LAYER clamps a longer request to the cap — a fork route offering 365 still gets 90', async () => {
    const row = await tokensRepo(env.DB).create({
      email: USERS.member,
      name: 'fork-route',
      tokenHash: crypto.randomUUID(),
      prefix: 't_forkrt00',
      scopes: [],
      expiresInDays: 365,
    });
    expect(Math.round(daysUntil(row?.expires_at ?? ''))).toBe(90);
  });

  it('tokenTtlDays: absent → cap, over → cap, garbage → throws', () => {
    expect(tokenTtlDays()).toBe(90);
    expect(tokenTtlDays(1)).toBe(1);
    expect(tokenTtlDays(90)).toBe(90);
    expect(tokenTtlDays(365)).toBe(90);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => tokenTtlDays(bad)).toThrow(RangeError);
    }
  });

  it('an ordinary D1 error is passed through, not mislabelled as schema drift', async () => {
    const repo = tokensRepo(env.DB);
    const input = {
      email: USERS.member,
      name: 'dup',
      tokenHash: 'same-hash',
      prefix: 't_dup00000',
      scopes: [] as string[],
    };
    await repo.create(input);
    const err = await repo.create(input).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApiTokenSchemaDriftError);
    expect(String(err)).toMatch(/UNIQUE/i);
  });

  it('the schema refuses a token with no expiry at all', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO api_tokens (email, name, token_hash, prefix) VALUES ('x@test.example', 'x', ?, 't_x')",
      )
        .bind(crypto.randomUUID())
        .run(),
    ).rejects.toThrow(/NOT NULL/i);
  });
});

describe('C8: the fork refusal hook (refuseTokenFor)', () => {
  beforeAll(applySchema);
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await seedDb();
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  async function hashOf(email: string): Promise<string> {
    const { token } = await mint(email);
    return sha256Hex(token);
  }

  it('the kit default allows every token', async () => {
    const p = (await resolveApiTokenByHash(
      env,
      await hashOf(USERS.member),
    )) as PersonBearerPrincipal;
    expect(p).not.toBeNull();
    expect(
      await refuseTokenFor(p, { env, user: (await makeDb(env).users.getActive(USERS.member))! }),
    ).toBeNull();
  });

  it('a refusing hook resolves to no principal and logs its reason code', async () => {
    const hash = await hashOf(USERS.member);
    const seen: Array<{ p: PersonBearerPrincipal; addedBy: string | null }> = [];
    const refuse: TokenRefusalCheck = (p, { user }) => {
      seen.push({ p, addedBy: user.added_by });
      return user.added_by === 'seed@test.example' ? 'acl_user_no_grant_snapshot' : null;
    };
    expect(await resolveApiTokenByHash(env, hash, refuse)).toBeNull();
    // The hook saw the live user row and an ALREADY-narrowed bearer principal.
    expect(seen[0]?.addedBy).toBe('seed@test.example');
    expect(seen[0]?.p.credentialTransport).toBe('bearer');
    expect(seen[0]?.p.tokenScopes).toEqual(grantableScopes('member'));
    expect(jsonEvents(spy)).toContainEqual({
      event: 'api_token_refused',
      reason: 'acl_user_no_grant_snapshot',
    });
  });

  it('an allowing hook changes nothing', async () => {
    const hash = await hashOf(USERS.member);
    expect(await resolveApiTokenByHash(env, hash, async () => null)).toMatchObject({
      email: USERS.member,
      credentialTransport: 'bearer',
    });
  });

  it('a hook that THROWS refuses (a broken policy is not an open door)', async () => {
    const hash = await hashOf(USERS.member);
    const refuse: TokenRefusalCheck = () => {
      throw new TypeError('acl down');
    };
    expect(await resolveApiTokenByHash(env, hash, refuse)).toBeNull();
    const events = jsonEvents(spy);
    expect(events).toContainEqual({
      event: 'api_token_refusal_hook_failed',
      err: { name: 'TypeError' },
    });
    expect(events).toContainEqual({ event: 'api_token_refused', reason: 'policy_error' });
  });

  it('a reason that is not a plain code is logged as `unspecified` — no data reaches the log', async () => {
    const hash = await hashOf(USERS.member);
    expect(await resolveApiTokenByHash(env, hash, () => `refused ${USERS.member}`)).toBeNull();
    expect(jsonEvents(spy)).toContainEqual({ event: 'api_token_refused', reason: 'unspecified' });
    expect(spy.mock.calls.flat().join(' ')).not.toContain(USERS.member);
  });
});
