// The service-identity admin surface (src/auth/serviceIdentityRoutes.ts): owner/admin on a
// session create, list, rotate (mint new, revoke old), revoke and disable machine principals; no
// bearer caller — a person's token or a service's own — reaches any of it (uniform 404); grants are
// capped at what the actor may delegate. All identities synthetic.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceIdentity,
  custodianDisabledSlackText,
  mayGrantServiceScope,
  mintServiceIdentityToken,
  noticeCustodianDisabled,
  revivesServiceIdentity,
  revokeAllServiceIdentityTokens,
  revokeServiceIdentityToken,
  serviceScopesFor,
  updateServiceIdentity,
} from '../../src/auth/serviceIdentities';
import { serviceIdentityRoutes } from '../../src/auth/serviceIdentityRoutes';
import { mintApiTokenFor, resolveApiTokenByHash, sha256Hex } from '../../src/auth/tokens';
import type { Principal } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { AppError } from '../../src/framework/errors';
import { allRoutes } from '../../src/routes';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

// What the route mints for slug `etl`: the app's own name (APP_NAME) is the domain label.
const SVC = `svc-etl@${env.APP_NAME}.invalid`;
const DAY_MS = 24 * 60 * 60 * 1000;
const daysUntil = (t: string) => (Date.parse(`${t.replace(' ', 'T')}Z`) - Date.now()) / DAY_MS;
const CANONICAL_404 = JSON.stringify({
  ok: false,
  error: { code: 'not_found', message: 'Not found' },
});

interface Identity {
  id: number;
  identifier: string;
  scope: string;
  status: string;
  custodian_email: string;
  custodian_active: boolean;
  live_tokens: number;
  next_expiry: string | null;
  name: string;
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function create(
  body: Record<string, unknown> = {},
  as: string = USERS.owner,
): Promise<Response> {
  return asUser(as, 'POST', '/api/service-identities', {
    slug: 'etl',
    name: 'C360 ETL (synthetic)',
    scope: 'notes.write',
    custodian_email: USERS.member,
    ...body,
  });
}

async function created(body: Record<string, unknown> = {}): Promise<Identity> {
  const res = await create(body);
  expect(res.status).toBe(201);
  return data<Identity>(res);
}

async function mint(id: number, body: Record<string, unknown> = {}) {
  const res = await asUser(USERS.owner, 'POST', `/api/service-identities/${id}/tokens`, body);
  expect(res.status).toBe(201);
  return data<{ id: number; token: string; expires_at: string; scopes: string[]; prefix: string }>(
    res,
  );
}

function bearer(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function auditRows(action: string) {
  return (
    await env.DB.prepare(
      'SELECT actor_email, target, payload_json FROM audit_log WHERE action = ? ORDER BY id',
    )
      .bind(action)
      .all<{ actor_email: string; target: string; payload_json: string }>()
  ).results;
}

describe('service identity management — create and list', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('an owner creates one: svc-<slug>@<app>.invalid, one scope, a live custodian — audited', async () => {
    const identity = await created();
    expect(identity).toMatchObject({
      slug: 'etl',
      identifier: SVC,
      name: 'C360 ETL (synthetic)',
      scope: 'notes.write',
      custodian_email: USERS.member,
      custodian_active: true,
      status: 'active',
      live_tokens: 0,
      next_expiry: null,
    });
    const [row] = await auditRows('service_identity.create');
    expect(row).toMatchObject({ actor_email: USERS.owner, target: SVC });
    expect(JSON.parse(row?.payload_json ?? '{}')).toEqual({
      service_identity_id: identity.id,
      scope: 'notes.write',
      custodian_email: USERS.member,
    });
    // Not a user: nothing was added to the allowlist.
    expect(await makeDb(env).users.get(SVC)).toBeNull();
  });

  it('creating an identity never REVIVES a credential: a killed legacy machine user’s token stays dead', async () => {
    // Pre-upgrade (il-lingua-style) machine USER for the same identifier, killed by disabling it,
    // with a live legacy (NULL-scope) token. Refused today: no identity row, and never via `users`.
    await env.DB.prepare(
      "INSERT INTO users (email, role, added_by, disabled_at) VALUES (?, 'member', ?, datetime('now'))",
    )
      .bind(SVC, USERS.owner)
      .run();
    const legacy = `t_${'b'.repeat(38)}01`;
    await env.DB.prepare(
      "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 'legacy', ?, 't_bbbbbbbb', datetime('now', '+80 days'), NULL)",
    )
      .bind(SVC, await sha256Hex(legacy))
      .run();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await bearer(legacy, 'POST', '/api/notes', { title: 'x' })).status).toBe(401);
      const identity = await created(); // slug 'etl' → the same identifier, SVC
      expect(identity.identifier).toBe(SVC);
      expect(identity.live_tokens).toBe(0);
      expect((await bearer(legacy, 'POST', '/api/notes', { title: 'x' })).status).toBe(401);
      // Said out loud in the audit row, with the count.
      const [row] = await auditRows('service_identity.create');
      expect(JSON.parse(row?.payload_json ?? '{}')).toEqual({
        service_identity_id: identity.id,
        scope: 'notes.write',
        custodian_email: USERS.member,
        revoked_preexisting_tokens: 1,
      });
      // Its own tokens, minted after creation, work.
      const { token } = await mint(identity.id);
      expect((await bearer(token, 'POST', '/api/notes', { title: 'x' })).status).toBe(201);
    } finally {
      spy.mockRestore();
    }
  });

  it('an admin may too; a member or viewer gets the uniform 404', async () => {
    expect((await create({ slug: 'by-admin' }, USERS.admin)).status).toBe(201);
    for (const who of [USERS.member, USERS.viewer]) {
      const res = await create({ slug: 'nope' }, who);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(CANONICAL_404);
    }
  });

  it('refuses a scope a service may never hold — non-delegable, agent family, unknown (400)', async () => {
    for (const scope of [
      'users.manage',
      'tokens.self',
      'serviceIdentities.manage',
      'agent.run',
      'nope',
    ]) {
      const res = await create({ scope });
      expect(res.status, scope).toBe(400);
    }
    expect((await makeDb(env).serviceIdentities.list()).length).toBe(0);
  });

  it('refuses a bad slug (400), a reused slug (409), and a custodian who is not an active person (400)', async () => {
    for (const slug of ['E', 'Bad Slug', '2etl', 'etl-', 'a'.repeat(41)]) {
      expect((await create({ slug })).status, slug).toBe(400);
    }
    await created();
    expect((await create({ name: 'again' })).status).toBe(409);
    await makeDb(env).users.setDisabled(USERS.viewer, true);
    for (const custodian_email of [USERS.viewer, 'nobody@test.example', 'svc-x@test-app.invalid']) {
      const res = await create({ slug: 'other', custodian_email });
      expect(res.status, custodian_email).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'custodian_inactive',
      );
    }
  });

  it('lists identities with status, custodian and token summary, plus the scopes this caller may grant', async () => {
    const identity = await created();
    await mint(identity.id, { expires_in_days: 30 });
    const res = await asUser(USERS.admin, 'GET', '/api/service-identities');
    expect(res.status).toBe(200);
    const body = await data<{ service_identities: Identity[]; grantable_scopes: string[] }>(res);
    expect(body.grantable_scopes.sort()).toEqual([
      'ai.use',
      'notes.read',
      'notes.write',
      'users.read',
    ]);
    expect(body.service_identities).toHaveLength(1);
    expect(body.service_identities[0]).toMatchObject({ id: identity.id, live_tokens: 1 });
    expect(daysUntil(body.service_identities[0]?.next_expiry ?? '')).toBeCloseTo(30, 0);
  });
});

describe('service identity management — tokens: mint, rotate, revoke', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('mints through mintApiTokenFor: exactly the scope, owned by the identity, 90 days, shown once', async () => {
    const identity = await created();
    const minted = await mint(identity.id);
    expect(minted.token).toMatch(/^t_[0-9a-f]{40}$/);
    expect(minted.scopes).toEqual(['notes.write']);
    expect(daysUntil(minted.expires_at)).toBeCloseTo(90, 0);
    const list = await data<{ tokens: Array<Record<string, unknown>> }>(
      await asUser(USERS.owner, 'GET', `/api/service-identities/${identity.id}/tokens`),
    );
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0]).not.toHaveProperty('token');
    expect(list.tokens[0]).not.toHaveProperty('token_hash');
    expect(JSON.stringify(list)).not.toContain(minted.token);
    const [row] = await auditRows('token.create');
    expect(row?.actor_email).toBe(USERS.owner);
    expect(JSON.parse(row?.payload_json ?? '{}')).toMatchObject({
      owner: SVC,
      service_identity_id: identity.id,
      scopes: ['notes.write'],
    });
    expect(JSON.stringify(await auditRows('token.create'))).not.toContain(minted.token);
  });

  it('expiry up to 365 days; 366 or a non-integer is a 400', async () => {
    const identity = await created();
    expect(daysUntil((await mint(identity.id, { expires_in_days: 365 })).expires_at)).toBeCloseTo(
      365,
      0,
    );
    for (const expires_in_days of [366, 0, 1.5, '90']) {
      const res = await asUser(
        USERS.owner,
        'POST',
        `/api/service-identities/${identity.id}/tokens`,
        {
          expires_in_days,
        },
      );
      expect(res.status, String(expires_in_days)).toBe(400);
    }
  });

  it('ROTATE: mint the replacement, both work during the overlap, revoke the old — audited', async () => {
    const identity = await created();
    const old = await mint(identity.id, { name: 'etl 2026-09' });
    const fresh = await mint(identity.id, { name: 'etl 2026-12' });
    for (const t of [old, fresh]) {
      expect((await bearer(t.token, 'POST', '/api/notes', { title: 'x' })).status).toBe(201);
    }
    const res = await asUser(
      USERS.owner,
      'DELETE',
      `/api/service-identities/${identity.id}/tokens/${old.id}`,
    );
    expect(res.status).toBe(204);
    expect((await bearer(old.token, 'POST', '/api/notes', { title: 'x' })).status).toBe(401);
    expect((await bearer(fresh.token, 'POST', '/api/notes', { title: 'x' })).status).toBe(201);
    const [row] = await auditRows('token.revoke');
    expect(row).toMatchObject({ actor_email: USERS.owner, target: String(old.id) });
    expect(JSON.parse(row?.payload_json ?? '{}')).toEqual({
      owner: SVC,
      service_identity_id: identity.id,
    });
  });

  it('a token id that is not this identity’s, or malformed, is the uniform 404 — nothing revoked', async () => {
    const a = await created();
    const b = await created({ slug: 'other' });
    const tokenOfB = await mint(b.id);
    const personal = await mintApiTokenFor(makeDb(env), ownerSession(), USERS.member, {
      name: 'personal',
    });
    for (const [id, tokenId] of [
      [a.id, tokenOfB.id],
      [a.id, personal.row.id],
      [a.id, 999999],
      [a.id, '0x1'],
      [a.id, `0${tokenOfB.id}`],
      ['abc', tokenOfB.id],
      [`${a.id}.0`, tokenOfB.id],
    ]) {
      const res = await asUser(
        USERS.owner,
        'DELETE',
        `/api/service-identities/${id}/tokens/${tokenId}`,
      );
      expect(res.status, `${id}/${tokenId}`).toBe(404);
      expect(await res.text()).toBe(CANONICAL_404);
    }
    const live = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL',
    ).first<{ n: number }>();
    expect(live?.n).toBe(2);
  });

  it('INCIDENT: revoke-tokens revokes every token the identity holds, and only its own', async () => {
    const identity = await created();
    const t1 = await mint(identity.id);
    const t2 = await mint(identity.id);
    const other = await created({ slug: 'other' });
    const t3 = await mint(other.id);
    const res = await asUser(
      USERS.owner,
      'POST',
      `/api/service-identities/${identity.id}/revoke-tokens`,
    );
    expect(await data<{ revoked: number }>(res)).toEqual({ revoked: 2 });
    for (const t of [t1, t2]) {
      expect((await bearer(t.token, 'POST', '/api/notes', { title: 'x' })).status).toBe(401);
    }
    expect((await bearer(t3.token, 'POST', '/api/notes', { title: 'x' })).status).toBe(201);
    const [row] = await auditRows('service_identity.revoke_tokens');
    expect(JSON.parse(row?.payload_json ?? '{}')).toEqual({
      service_identity_id: identity.id,
      revoked: 2,
    });
  });
});

describe('service identity management — disable, custodian, rename', () => {
  beforeAll(applySchema);

  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await seedDb();
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  const patch = (id: number | string, body: Record<string, unknown>, as: string = USERS.owner) =>
    asUser(as, 'PATCH', `/api/service-identities/${id}`, body);

  it('DISABLE is the kill switch (tokens refused at once, not revoked); re-enable restores them', async () => {
    const identity = await created();
    const { token } = await mint(identity.id);
    const off = await data<Identity>(await patch(identity.id, { disabled: true }));
    expect(off.status).toBe('disabled');
    expect((await bearer(token, 'POST', '/api/notes', { title: 'x' })).status).toBe(401);
    const on = await data<Identity>(await patch(identity.id, { disabled: false }, USERS.admin));
    expect(on.status).toBe('active');
    expect((await bearer(token, 'POST', '/api/notes', { title: 'x' })).status).toBe(201);
    const rows = await auditRows('service_identity.update');
    expect(rows.map((r) => JSON.parse(r.payload_json))).toEqual([
      { service_identity_id: identity.id, disabled: true },
      { service_identity_id: identity.id, disabled: false },
    ]);
  });

  it('CUSTODIAN CHANGE: only to an active person; a leaver’s identity shows custodian_inactive until handed over', async () => {
    const identity = await created();
    const { token } = await mint(identity.id);
    await makeDb(env).users.setDisabled(USERS.member, true); // the custodian leaves
    const listed = await data<{ service_identities: Identity[] }>(
      await asUser(USERS.owner, 'GET', '/api/service-identities'),
    );
    expect(listed.service_identities[0]?.status).toBe('custodian_inactive');
    expect((await bearer(token, 'POST', '/api/notes', { title: 'x' })).status).toBe(401);

    expect((await patch(identity.id, { custodian_email: USERS.member })).status).toBe(400);
    expect((await patch(identity.id, { custodian_email: SVC })).status).toBe(400);
    const handed = await data<Identity>(await patch(identity.id, { custodian_email: USERS.admin }));
    expect(handed).toMatchObject({ custodian_email: USERS.admin, status: 'active' });
    expect((await bearer(token, 'POST', '/api/notes', { title: 'x' })).status).toBe(201);
    expect(
      JSON.parse((await auditRows('service_identity.update'))[0]?.payload_json ?? '{}'),
    ).toEqual({ service_identity_id: identity.id, custodian_email: USERS.admin });
  });

  it('an identity whose scope a service may no longer hold shows scope_not_grantable — its tokens are refused, and the page says so', async () => {
    // Only a hand insert — or a later kit/app change that makes the key non-delegable — leaves one.
    await env.DB.prepare(
      "INSERT INTO service_identities (slug, principal_id, name, scope, custodian_email, created_by) VALUES ('old', 'svc-old@test-app.invalid', 'Old sync', 'users.manage', ?, ?)",
    )
      .bind(USERS.member, USERS.owner)
      .run();
    const listed = await data<{ service_identities: Identity[] }>(
      await asUser(USERS.owner, 'GET', '/api/service-identities'),
    );
    expect(listed.service_identities[0]).toMatchObject({
      identifier: 'svc-old@test-app.invalid',
      status: 'scope_not_grantable',
    });
    // The kill switch and a missing custodian still read first — the resolver's own order.
    await makeDb(env).users.setDisabled(USERS.member, true);
    const orphaned = await data<{ service_identities: Identity[] }>(
      await asUser(USERS.owner, 'GET', '/api/service-identities'),
    );
    expect(orphaned.service_identities[0]?.status).toBe('custodian_inactive');
  });

  it('a failed custodian change applies nothing else in the same request', async () => {
    const identity = await created();
    const res = await patch(identity.id, {
      custodian_email: 'nobody@test.example',
      name: 'renamed',
      disabled: true,
    });
    expect(res.status).toBe(400);
    const listed = await data<{ service_identities: Identity[] }>(
      await asUser(USERS.owner, 'GET', '/api/service-identities'),
    );
    expect(listed.service_identities[0]).toMatchObject({
      name: 'C360 ETL (synthetic)',
      status: 'active',
    });
  });

  it('rename changes the display name only; the identifier and scope are fixed', async () => {
    const identity = await created();
    const renamed = await data<Identity>(
      await patch(identity.id, {
        name: 'Renamed',
        scope: 'users.read',
        identifier: 'x',
        slug: 'y',
      }),
    );
    expect(renamed).toMatchObject({ name: 'Renamed', identifier: SVC, scope: 'notes.write' });
  });

  it('an unknown or malformed id is the uniform 404', async () => {
    for (const id of ['999999', '0', '-1', '1e1', '0x1', ' 1']) {
      const res = await patch(encodeURIComponent(id), { disabled: true });
      expect(res.status, id).toBe(404);
      expect(await res.text()).toBe(CANONICAL_404);
    }
  });
});

describe('offboarding a custodian is never silent — the alert goes out when the person is disabled', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  async function mailbox() {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const mailEnv = {
      ...env,
      APP_NAME: 'test-app',
      EMAIL: {
        send: async (m: { to: string; subject: string; text: string }) => void sent.push(m),
      },
    } as unknown as Env;
    return { sent, mailEnv };
  }

  it('disabling a custodian counts, in the user.update audit row, the working identities that just stopped', async () => {
    const working = await created(); // custodian: the member
    await mint(working.id);
    const idle = await created({ slug: 'idle' }); // no live token: nothing stops
    const off = await created({ slug: 'off' }); // disabled on purpose: nothing stops
    await mint(off.id);
    await asUser(USERS.owner, 'PATCH', `/api/service-identities/${off.id}`, { disabled: true });
    const other = await created({ slug: 'other', custodian_email: USERS.admin });
    await mint(other.id);
    expect(idle.live_tokens).toBe(0);

    const res = await asUser(USERS.owner, 'PATCH', `/api/users/${USERS.member}`, {
      disabled: true,
    });
    expect(res.status).toBe(200);
    const [row] = await auditRows('user.update');
    expect(JSON.parse(row?.payload_json ?? '{}')).toEqual({
      disabled: true,
      orphaned_service_identities: 1,
    });
    // Disabling someone who is nobody's custodian leaves the payload as it was.
    await asUser(USERS.owner, 'PATCH', `/api/users/${USERS.viewer}`, { disabled: true });
    expect(JSON.parse((await auditRows('user.update'))[1]?.payload_json ?? '{}')).toEqual({
      disabled: true,
    });
  });

  it('noticeCustodianDisabled alerts at once, naming each identity (email) and only the count (Slack)', async () => {
    const identity = await created();
    await mint(identity.id);
    await makeDb(env).users.setDisabled(USERS.member, true);
    const { sent, mailEnv } = await mailbox();
    const pending: Promise<unknown>[] = [];
    const n = await noticeCustodianDisabled(makeDb(env), mailEnv, USERS.member, (p) => {
      pending.push(p);
    });
    expect(n).toBe(1);
    await Promise.all(pending);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      [
        'alerts@test.example',
        '[test-app/test] 1 service identity stopped: its custodian was disabled',
      ],
    ]);
    expect(sent[0]?.text).toContain(SVC);
    expect(sent[0]?.text).toContain(USERS.member);
    expect(sent[0]?.text).toContain('REFUSED');
    expect(sent[0]?.text).toContain('docs/runbooks/service-identities.md');
    expect(custodianDisabledSlackText('test-app', 'test', 1)).not.toMatch(/svc-|@/);
  });

  it('nobody to warn about → no alert; a lookup failure (0004 missing) never fails the disable', async () => {
    const { sent, mailEnv } = await mailbox();
    const pending: Promise<unknown>[] = [];
    const schedule = (p: Promise<unknown>) => {
      pending.push(p);
    };
    expect(await noticeCustodianDisabled(makeDb(env), mailEnv, USERS.viewer, schedule)).toBe(0);
    expect(pending).toEqual([]);
    await env.DB.prepare('DROP TABLE service_identities').run(); // seedDb recreates it
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await noticeCustodianDisabled(makeDb(env), mailEnv, USERS.member, schedule)).toBe(0);
      expect(
        (await asUser(USERS.owner, 'PATCH', `/api/users/${USERS.member}`, { disabled: true }))
          .status,
      ).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(sent).toEqual([]);
  });
});

function personSession(email: string, role: 'owner' | 'admin' | 'member' | 'viewer') {
  return {
    kind: 'person',
    email,
    name: null,
    role,
    authMethod: 'magic_link',
    credentialTransport: 'cookie',
  } as const satisfies Principal;
}

function ownerSession(): Principal {
  return {
    kind: 'person',
    email: USERS.owner,
    name: null,
    role: 'owner',
    authMethod: 'magic_link',
    credentialTransport: 'cookie',
  };
}

describe('no bearer caller reaches service identity management', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('every management route answers an owner’s personal token AND a service’s own token with the byte-identical 404', async () => {
    const identity = await created();
    const svc = await mint(identity.id);
    const personal = await mintApiTokenFor(makeDb(env), ownerSession(), USERS.owner, {
      name: 'owner script',
    });
    const legacy = `t_${'a'.repeat(38)}ff`;
    await env.DB.prepare(
      "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 'legacy', ?, 't_aaaaaaaa', datetime('now', '+30 days'), NULL)",
    )
      .bind(USERS.owner, await sha256Hex(legacy))
      .run();

    const fill = (path: string) =>
      path.replace(':id', String(identity.id)).replace(':tokenId', String(svc.id));
    for (const token of [personal.token, legacy, svc.token]) {
      for (const { spec } of serviceIdentityRoutes) {
        const body =
          spec.method === 'GET'
            ? undefined
            : {
                slug: 'evil',
                name: 'x',
                scope: 'notes.read',
                custodian_email: USERS.owner,
                disabled: true,
              };
        const res = await bearer(token, spec.method, fill(spec.path), body);
        expect(res.status, `${spec.method} ${spec.path}`).toBe(404);
        expect(await res.text()).toBe(CANONICAL_404);
      }
    }
    // Nothing changed: one identity, still active, its one token still live.
    const [row] = await makeDb(env).serviceIdentities.list();
    expect(row).toMatchObject({ slug: 'etl', disabled_at: null, live_tokens: 1 });
    expect(await makeDb(env).serviceIdentities.list()).toHaveLength(1);
  });

  it('the operations refuse a non-session caller themselves (the second wall)', async () => {
    const identity = await created();
    const { token } = await mint(identity.id);
    const svc = (await resolveApiTokenByHash(env, await sha256Hex(token))) as Principal;
    const bearerOwner = { ...ownerSession(), credentialTransport: 'bearer' } as Principal;
    const db = makeDb(env);
    for (const p of [svc, bearerOwner]) {
      const attempts: Array<Promise<unknown>> = [
        createServiceIdentity(db, env, p, {
          slug: 'evil',
          name: 'x',
          scope: 'notes.read',
          custodianEmail: USERS.owner,
        }),
        updateServiceIdentity(db, p, identity.id, { disabled: true }),
        mintServiceIdentityToken(db, p, identity.id, {}),
        revokeServiceIdentityToken(db, p, identity.id, 1),
        revokeAllServiceIdentityTokens(db, p, identity.id),
      ];
      for (const attempt of attempts) {
        const err = await attempt.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).status).toBe(404);
      }
      expect(serviceScopesFor(p)).toEqual(
        p.kind === 'service' ? [] : serviceScopesFor(ownerSession()),
      );
    }
  });

  it('a SESSION without serviceIdentities.manage (member, viewer) is refused by the functions too — the uniform 404, nothing written', async () => {
    const identity = await created();
    const { id: tokenId } = await mint(identity.id);
    const db = makeDb(env);
    for (const role of ['member', 'viewer'] as const) {
      const p = personSession(role === 'member' ? USERS.member : USERS.viewer, role);
      const attempts: Array<[string, Promise<unknown>]> = [
        [
          'create',
          // notes.read: a key a member COULD put into its own token — the refusal is the permission.
          createServiceIdentity(db, env, p, {
            slug: `by-${role}`,
            name: 'x',
            scope: 'notes.read',
            custodianEmail: USERS.member,
          }),
        ],
        ['update', updateServiceIdentity(db, p, identity.id, { disabled: true })],
        ['mint', mintServiceIdentityToken(db, p, identity.id, { expiresInDays: 365 })],
        ['mintApiTokenFor', mintApiTokenFor(db, p, SVC, { name: 'x', expiresInDays: 365 })],
        ['revoke', revokeServiceIdentityToken(db, p, identity.id, tokenId)],
        ['revokeAll', revokeAllServiceIdentityTokens(db, p, identity.id)],
      ];
      for (const [what, attempt] of attempts) {
        const err = await attempt.catch((e: unknown) => e);
        expect(err, `${role} ${what}`).toBeInstanceOf(AppError);
        expect((err as AppError).status, `${role} ${what}`).toBe(404);
      }
    }
    const [row] = await db.serviceIdentities.list();
    expect(row).toMatchObject({ disabled_at: null, live_tokens: 1 });
    expect(await db.serviceIdentities.list()).toHaveLength(1);
  });

  it('grants are capped at what the ACTOR may delegate — the keys offered, and reviving an identity counts as a grant', () => {
    const member = personSession(USERS.member, 'member');
    const owner = personSession(USERS.owner, 'owner');
    expect(serviceScopesFor(member).sort()).toEqual(['ai.use', 'notes.read', 'notes.write']);
    expect(mayGrantServiceScope(member, 'users.read')).toBe(false);
    expect(mayGrantServiceScope(member, 'notes.read')).toBe(true);
    expect(mayGrantServiceScope(owner, 'users.read')).toBe(true);
    expect(mayGrantServiceScope(owner, 'users.manage')).toBe(false); // never service-grantable
    const live = { disabled_at: null, custodian_active: true, scope: 'notes.read' };
    const off = { ...live, disabled_at: '2026-09-01 00:00:00' };
    const orphan = { ...live, custodian_active: false };
    // Only a change that turns a refused identity back into a working one is a grant.
    expect(revivesServiceIdentity(off, { disabled: false, custodianChanged: false })).toBe(true);
    expect(revivesServiceIdentity(orphan, { custodianChanged: true })).toBe(true);
    expect(revivesServiceIdentity(live, { disabled: false, custodianChanged: true })).toBe(false);
    expect(revivesServiceIdentity(off, { custodianChanged: true })).toBe(false); // still disabled
    expect(revivesServiceIdentity(orphan, { disabled: false, custodianChanged: false })).toBe(
      false,
    ); // still orphaned
    expect(
      revivesServiceIdentity(
        { ...off, custodian_active: false },
        { disabled: false, custodianChanged: true },
      ),
    ).toBe(true);
    // A scope no service may hold stays refused whatever changes: nothing is revived.
    expect(
      revivesServiceIdentity(
        { ...off, scope: 'users.manage' },
        { disabled: false, custodianChanged: false },
      ),
    ).toBe(false);
  });

  it('the routes are registered — the uniformity tripwire walks them', () => {
    const registered = new Set(allRoutes.map((r) => `${r.spec.method} ${r.spec.path}`));
    for (const { spec } of serviceIdentityRoutes) {
      expect(registered.has(`${spec.method} ${spec.path}`)).toBe(true);
      expect(spec.permission).toBe('serviceIdentities.manage');
    }
  });
});
