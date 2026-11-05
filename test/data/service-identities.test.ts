// The service-identities repository and the table's own guarantees (schema.sql): a custodian is an
// ACTIVE user at the moment it is set, an identity's slug / identifier / scope never change, rows
// are never deleted, and a service identity's token lives 90 days by default and at most 365 —
// decided in the data layer from the owner's identifier, never by a caller's flag. All synthetic.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeDb } from '../../src/data';
import {
  SERVICE_TOKEN_DEFAULT_TTL_DAYS,
  SERVICE_TOKEN_MAX_TTL_DAYS,
  TOKEN_MAX_TTL_DAYS,
  tokenTtlDays,
} from '../../src/data/tokens';
import { applySchema, seedDb, USERS } from '../helpers/db';

const SVC = 'svc-etl@test-app.invalid';
const DAY_MS = 24 * 60 * 60 * 1000;
const daysUntil = (t: string) => (Date.parse(`${t.replace(' ', 'T')}Z`) - Date.now()) / DAY_MS;

function createEtl(
  overrides: Partial<Parameters<ReturnType<typeof makeDb>['serviceIdentities']['create']>[0]> = {},
) {
  return makeDb(env).serviceIdentities.create({
    slug: 'etl',
    principalId: SVC,
    name: 'Synthetic ETL',
    scope: 'notes.write',
    custodianEmail: USERS.member,
    createdBy: USERS.owner,
    ...overrides,
  });
}

async function created(): Promise<number> {
  const res = await createEtl();
  if (!res.ok) throw new Error(`create failed: ${res.reason}`);
  return res.row.id;
}

describe('serviceIdentities repository', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('creates an identity, lowercasing the identifier, custodian and creator', async () => {
    const res = await createEtl({
      principalId: 'SVC-ETL@TEST-APP.INVALID',
      custodianEmail: USERS.member.toUpperCase(),
      createdBy: USERS.owner.toUpperCase(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row).toMatchObject({
      slug: 'etl',
      principal_id: SVC,
      name: 'Synthetic ETL',
      scope: 'notes.write',
      custodian_email: USERS.member,
      created_by: USERS.owner,
      disabled_at: null,
      updated_by: null,
    });
  });

  it('a slug or identifier is never reused (taken), and nothing is overwritten', async () => {
    await created();
    expect(await createEtl({ principalId: 'svc-other@test-app.invalid' })).toEqual({
      ok: false,
      reason: 'taken',
    });
    expect(await createEtl({ slug: 'other' })).toEqual({ ok: false, reason: 'taken' });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM service_identities').first<{
      n: number;
    }>();
    expect(n?.n).toBe(1);
  });

  it('refuses a custodian who is not an active user — disabled, or not a user at all', async () => {
    await makeDb(env).users.setDisabled(USERS.viewer, true);
    for (const custodianEmail of [USERS.viewer, 'nobody@test.example']) {
      expect(await createEtl({ custodianEmail })).toEqual({
        ok: false,
        reason: 'custodian_inactive',
      });
    }
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM service_identities').first<{
      n: number;
    }>();
    expect(n?.n).toBe(0);
  });

  // A token row inserted by hand, as a pre-upgrade machine user's (il-lingua's) would be.
  const rawToken = (email: string, hash: string) =>
    env.DB.prepare(
      "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 'raw', ?, 't_raw00000', datetime('now', '+30 days'), NULL)",
    )
      .bind(email, hash)
      .run();
  const liveOwners = async () =>
    (
      await env.DB.prepare(
        'SELECT email FROM api_tokens WHERE revoked_at IS NULL ORDER BY id',
      ).all<{ email: string }>()
    ).results.map((r) => r.email);

  it('a NEW identity inherits no credential: tokens already stored under its identifier are revoked in the same write', async () => {
    // A legacy machine USER for the same address, killed by disabling it, still holding a token.
    await env.DB.prepare(
      "INSERT INTO users (email, role, added_by, disabled_at) VALUES (?, 'member', ?, datetime('now'))",
    )
      .bind(SVC, USERS.owner)
      .run();
    await rawToken(SVC, 'legacy-1');
    await rawToken(SVC.toUpperCase(), 'legacy-2');
    await rawToken(USERS.member, 'personal');
    const res = await createEtl();
    expect(res).toMatchObject({ ok: true, revokedTokens: 2 });
    expect(await liveOwners()).toEqual([USERS.member]);
    // Tokens minted AFTER creation are the identity's own.
    expect((await createEtl({ slug: 'other', principalId: 'svc-other@test-app.invalid' })).ok).toBe(
      true,
    );
    expect(await liveOwners()).toEqual([USERS.member]);
  });

  it('a refused create revokes nothing — not when the slug is taken, not when the custodian is inactive', async () => {
    await rawToken(SVC, 'legacy');
    await makeDb(env).users.setDisabled(USERS.viewer, true);
    expect(await createEtl({ custodianEmail: USERS.viewer })).toEqual({
      ok: false,
      reason: 'custodian_inactive',
    });
    expect(await liveOwners()).toEqual([SVC]);
    await rawToken('svc-taken@test-app.invalid', 'taken');
    expect((await createEtl({ slug: 'taken', principalId: 'svc-taken@test-app.invalid' })).ok).toBe(
      true,
    );
    await rawToken('svc-taken@test-app.invalid', 'minted-later');
    expect(await createEtl({ slug: 'taken', principalId: 'svc-taken@test-app.invalid' })).toEqual({
      ok: false,
      reason: 'taken',
    });
    expect(await liveOwners()).toEqual([SVC, 'svc-taken@test-app.invalid']);
  });

  it('getByPrincipalId reports the custodian’s LIVE state (the resolver reads it per request)', async () => {
    await created();
    const repo = makeDb(env).serviceIdentities;
    expect((await repo.getByPrincipalId(SVC.toUpperCase()))?.custodian_active).toBe(true);
    await makeDb(env).users.setDisabled(USERS.member, true);
    expect((await repo.getByPrincipalId(SVC))?.custodian_active).toBe(false);
    await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(USERS.member).run();
    expect((await repo.getByPrincipalId(SVC))?.custodian_active).toBe(false);
    expect(await repo.getByPrincipalId('svc-nope@test-app.invalid')).toBeNull();
  });

  it('setCustodian: only to an active user, recording who changed it', async () => {
    const id = await created();
    const repo = makeDb(env).serviceIdentities;
    await makeDb(env).users.setDisabled(USERS.viewer, true);
    expect(await repo.setCustodian(id, USERS.viewer, USERS.owner)).toBe(false);
    expect(await repo.setCustodian(id, 'nobody@test.example', USERS.owner)).toBe(false);
    expect((await repo.get(id))?.custodian_email).toBe(USERS.member);
    expect(await repo.setCustodian(id, USERS.admin.toUpperCase(), USERS.owner)).toBe(true);
    const row = await repo.get(id);
    expect(row?.custodian_email).toBe(USERS.admin);
    expect(row?.updated_by).toBe(USERS.owner);
    expect(row?.updated_at).not.toBeNull();
  });

  it('setDisabled toggles the kill switch and reports whether anything changed', async () => {
    const id = await created();
    const repo = makeDb(env).serviceIdentities;
    expect(await repo.setDisabled(id, true, USERS.admin)).toBe(true);
    expect(await repo.setDisabled(id, true, USERS.admin)).toBe(false);
    expect((await repo.get(id))?.disabled_at).not.toBeNull();
    expect(await repo.setDisabled(id, false, USERS.admin)).toBe(true);
    expect(await repo.setDisabled(id, false, USERS.admin)).toBe(false);
    expect((await repo.get(id))?.disabled_at).toBeNull();
    expect(await repo.setDisabled(999, true, USERS.admin)).toBe(false);
  });

  it('rename changes only the display name', async () => {
    const id = await created();
    const repo = makeDb(env).serviceIdentities;
    expect(await repo.rename(id, 'Renamed ETL', USERS.admin)).toBe(true);
    expect(await repo.get(id)).toMatchObject({ name: 'Renamed ETL', principal_id: SVC });
    expect(await repo.rename(999, 'x', USERS.admin)).toBe(false);
  });

  it('list carries the custodian state and a live-token summary', async () => {
    const id = await created();
    const db = makeDb(env);
    const mint = (hash: string) =>
      db.tokens.create({
        email: SVC,
        name: hash,
        tokenHash: hash,
        prefix: 't_svc00000',
        scopes: ['notes.write'],
        expiresInDays: hash === 'soon' ? 10 : 200,
      });
    const soon = await mint('soon');
    await mint('later');
    const revoked = await mint('revoked');
    await db.tokens.revoke(revoked?.id ?? 0, SVC);
    await db.tokens.touchLastUsed(soon?.id ?? 0);
    // Someone else's token never counts toward the identity.
    await db.tokens.create({
      email: USERS.member,
      name: 'personal',
      tokenHash: 'personal',
      prefix: 't_person00',
      scopes: [],
    });

    const [row] = await db.serviceIdentities.list();
    expect(row?.id).toBe(id);
    expect(row?.custodian_active).toBe(true);
    expect(row?.live_tokens).toBe(2);
    expect(row?.next_expiry).toBe(soon?.expires_at);
    expect(row?.last_used_at).not.toBeNull();
    await db.users.setDisabled(USERS.member, true);
    expect((await db.serviceIdentities.list())[0]?.custodian_active).toBe(false);
  });
});

describe('service_identities table guarantees (against a holder of D1 credentials too)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('slug, identifier, scope and creation are fixed', async () => {
    const id = await created();
    for (const set of [
      "slug = 'other'",
      "principal_id = 'svc-other@test-app.invalid'",
      "scope = 'users.manage'",
      "created_by = 'x@test.example'",
      "created_at = '2000-01-01 00:00:00'",
      'id = 999',
    ]) {
      await expect(
        env.DB.prepare(`UPDATE service_identities SET ${set} WHERE id = ?`).bind(id).run(),
        set,
      ).rejects.toThrow(/fixed/);
    }
    expect((await makeDb(env).serviceIdentities.get(id))?.scope).toBe('notes.write');
  });

  it('rows are never deleted, and INSERT OR REPLACE cannot overwrite one', async () => {
    const id = await created();
    await expect(
      env.DB.prepare('DELETE FROM service_identities WHERE id = ?').bind(id).run(),
    ).rejects.toThrow(/never deleted/);
    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO service_identities (id, slug, principal_id, name, scope, custodian_email, created_by)
         VALUES (?, 'etl', ?, 'evil', 'users.manage', ?, ?)`,
      )
        .bind(id, SVC, USERS.member, USERS.owner)
        .run(),
    ).rejects.toThrow(/never overwritten/);
    expect((await makeDb(env).serviceIdentities.get(id))?.scope).toBe('notes.write');
  });

  it('CHECKs: the identifier is in the reserved namespace, the custodian is not, the slug is clean', async () => {
    const insert = (slug: string, principalId: string, custodian: string) =>
      env.DB.prepare(
        "INSERT INTO service_identities (slug, principal_id, name, scope, custodian_email, created_by) VALUES (?, ?, 'x', 'notes.read', ?, 'o@test.example')",
      )
        .bind(slug, principalId, custodian)
        .run();
    await expect(insert('etl', 'etl@test-app.example', USERS.member)).rejects.toThrow(/CHECK/);
    await expect(insert('etl', SVC, 'svc-other@test-app.invalid')).rejects.toThrow(/CHECK/);
    await expect(insert('Bad Slug', SVC, USERS.member)).rejects.toThrow(/CHECK/);
    await expect(insert('e', SVC, USERS.member)).rejects.toThrow(/CHECK/);
  });
});

describe('a service identity’s token lifetime and shape (data layer)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const mint = (email: string, expiresInDays?: number, scopes: string[] = ['notes.write']) =>
    makeDb(env).tokens.create({
      email,
      name: 'ttl',
      tokenHash: crypto.randomUUID(),
      prefix: 't_ttl00000',
      scopes,
      expiresInDays,
    });

  it('tokenTtlDays: a service defaults to 90 and is capped at 365; a person stays at 90', () => {
    expect(tokenTtlDays(undefined, 'service')).toBe(SERVICE_TOKEN_DEFAULT_TTL_DAYS);
    expect(tokenTtlDays(200, 'service')).toBe(200);
    expect(tokenTtlDays(10_000, 'service')).toBe(SERVICE_TOKEN_MAX_TTL_DAYS);
    expect(tokenTtlDays(365)).toBe(TOKEN_MAX_TTL_DAYS);
    expect(tokenTtlDays(365, 'person')).toBe(TOKEN_MAX_TTL_DAYS);
    expect(() => tokenTtlDays(0, 'service')).toThrow(RangeError);
    expect([SERVICE_TOKEN_DEFAULT_TTL_DAYS, SERVICE_TOKEN_MAX_TTL_DAYS]).toEqual([90, 365]);
  });

  it('the cap follows the OWNER’s identifier, not the caller: 90 by default, 365 at most', async () => {
    expect(daysUntil((await mint(SVC))?.expires_at ?? '')).toBeCloseTo(90, 0);
    expect(daysUntil((await mint(SVC, 400))?.expires_at ?? '')).toBeCloseTo(365, 0);
    expect(daysUntil((await mint(SVC, 180))?.expires_at ?? '')).toBeCloseTo(180, 0);
    // A person asking for the same 400 days still gets 90.
    expect(daysUntil((await mint(USERS.member, 400, []))?.expires_at ?? '')).toBeCloseTo(90, 0);
  });

  it('a service token carries exactly ONE scope — zero or two is refused before any write', async () => {
    await expect(mint(SVC, undefined, [])).rejects.toThrow(/exactly one scope/);
    await expect(mint(SVC, undefined, ['notes.read', 'notes.write'])).rejects.toThrow(
      /exactly one scope/,
    );
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('revokeAllForOwner revokes every live token of that owner and no one else’s', async () => {
    await mint(SVC);
    await mint(SVC);
    const other = await mint(USERS.member, undefined, []);
    const db = makeDb(env);
    expect(await db.tokens.revokeAllForOwner(SVC.toUpperCase())).toBe(2);
    expect(await db.tokens.revokeAllForOwner(SVC)).toBe(0);
    const live = await env.DB.prepare('SELECT id FROM api_tokens WHERE revoked_at IS NULL').all<{
      id: number;
    }>();
    expect(live.results.map((r) => r.id)).toEqual([other?.id]);
  });
});
