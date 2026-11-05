// PIA C8, item "schema drift fails closed". A fork that adopts the kit's src/auth + src/data (they
// ride /kit-upgrade) but not migrations/d1/0003_api_token_scopes.sql (migrations/ does not) runs
// code that expects `api_tokens.scopes` against a table without it. The one unacceptable outcome
// is the old one — a token resolving to its owner's FULL role because "no scopes" read as
// "unscoped". Every path must refuse instead, with a distinct, grep-able log event naming the fix.
//
// Own file on purpose: every test here replaces `api_tokens` with the PRE-C8 shape.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveApiTokenByHash, sha256Hex } from '../../src/auth/tokens';
import type { PersonPrincipal } from '../../src/auth/types';
import { ApiTokenSchemaDriftError, tokensRepo } from '../../src/data/tokens';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

// api_tokens exactly as schema.sql declared it before C8: no scopes, nullable expires_at.
const PRE_C8_API_TOKENS = `CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
)`;

const PLAINTEXT = 't_drift000000000000000000000000000000000000'.slice(0, 42);

function driftEvents(spy: { mock: { calls: unknown[][] } }): Array<{ op: string; remedy: string }> {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((m): m is string => typeof m === 'string' && m.includes('api_token_schema_drift'))
    .map((m) => JSON.parse(m) as { op: string; remedy: string });
}

describe('schema drift: code expecting api_tokens.scopes on a database without it', () => {
  beforeAll(applySchema);
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await seedDb();
    await env.DB.prepare('DROP TABLE api_tokens').run();
    await env.DB.prepare(PRE_C8_API_TOKENS).run();
    // An owner's never-expiring token — the worst case the old code would have honoured in full.
    await env.DB.prepare(
      "INSERT INTO api_tokens (email, name, token_hash, prefix) VALUES (?, 'etl', ?, 't_drift000')",
    )
      .bind(USERS.owner, await sha256Hex(PLAINTEXT))
      .run();
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    spy.mockRestore();
    // Put the real baseline back so nothing outside this suite inherits the old shape.
    await env.DB.prepare('DROP TABLE IF EXISTS api_tokens').run();
    await applySchema();
  });

  it('a bearer request is REFUSED (401), never served with the full role', async () => {
    for (const path of ['/api/me', '/api/users', '/api/audit']) {
      const res = await SELF.fetch(BASE + path, {
        headers: { authorization: `Bearer ${PLAINTEXT}` },
      });
      expect(res.status).toBe(401);
    }
  });

  it('logs a distinct event that names the missing migration', async () => {
    await SELF.fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${PLAINTEXT}` } });
    const events = driftEvents(spy);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.op).toBe('findActiveByHash');
    // An id naming the migration, not a sentence: logs take no free text (PIA C5).
    expect(events[0]?.remedy).toBe('apply_migration_0003_api_token_scopes');
  });

  it('the MCP re-resolution path refuses too', async () => {
    expect(await resolveApiTokenByHash(env, await sha256Hex(PLAINTEXT))).toBeNull();
  });

  it('minting fails closed: opaque 500 to the caller, the distinct event to the operator, no row', async () => {
    const res = await asUser(USERS.owner, 'POST', '/api/tokens', { name: 'new' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'internal_error', message: 'Internal error' });
    expect(driftEvents(spy).map((e) => e.op)).toContain('create');
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
    expect(n?.n).toBe(1); // only the seeded legacy row
  });

  it('listing fails closed the same way', async () => {
    const res = await asUser(USERS.owner, 'GET', '/api/tokens');
    expect(res.status).toBe(500);
    expect(driftEvents(spy).map((e) => e.op)).toContain('listForUser');
  });

  it('the repository throws the typed error on every path that touches the column', async () => {
    const repo = tokensRepo(env.DB);
    await expect(repo.findActiveByHash(await sha256Hex(PLAINTEXT))).rejects.toBeInstanceOf(
      ApiTokenSchemaDriftError,
    );
    await expect(repo.listForUser(USERS.owner)).rejects.toBeInstanceOf(ApiTokenSchemaDriftError);
    await expect(
      repo.create({
        email: USERS.owner,
        name: 'x',
        tokenHash: crypto.randomUUID(),
        prefix: 't_x',
        scopes: [],
      }),
    ).rejects.toBeInstanceOf(ApiTokenSchemaDriftError);
  });

  it('an unknown hash is still just "no token" (nothing to classify, no drift event)', async () => {
    expect(await tokensRepo(env.DB).findActiveByHash('0'.repeat(64))).toBeNull();
    expect(driftEvents(spy)).toHaveLength(0);
  });
});

// PARTIAL drift: the `scopes` column exists but the table is otherwise pre-C8 — `expires_at` still
// admits NULL and nothing back-filled it. That is what a fork gets by writing its own
// `ALTER TABLE api_tokens ADD COLUMN scopes TEXT` instead of copying 0003. A token with no expiry
// must be refused (it never expires otherwise) AND the operator must be told why — a silent 401
// is exactly the opaque failure C8 rules out.
describe('partial drift: a hand-added scopes column on a table 0003 never rebuilt', () => {
  beforeAll(applySchema);
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await seedDb();
    await env.DB.prepare('DROP TABLE api_tokens').run();
    await env.DB.prepare(PRE_C8_API_TOKENS).run();
    await env.DB.prepare('ALTER TABLE api_tokens ADD COLUMN scopes TEXT').run();
    await env.DB.prepare(
      "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 'etl', ?, 't_drift000', NULL, '[\"notes.read\"]')",
    )
      .bind(USERS.owner, await sha256Hex(PLAINTEXT))
      .run();
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    spy.mockRestore();
    await env.DB.prepare('DROP TABLE IF EXISTS api_tokens').run();
    await applySchema();
  });

  function events(name: string): Array<{ token_id: number; remedy: string }> {
    return (spy.mock.calls as unknown[][])
      .map((c) => c[0])
      .filter((m): m is string => typeof m === 'string' && m.includes(`"${name}"`))
      .map((m) => JSON.parse(m) as { token_id: number; remedy: string });
  }

  it('a token with no expiry is refused (401) and logs api_token_no_expiry naming 0003', async () => {
    const res = await SELF.fetch(`${BASE}/api/notes`, {
      headers: { authorization: `Bearer ${PLAINTEXT}` },
    });
    expect(res.status).toBe(401);
    const [event] = events('api_token_no_expiry');
    expect(event?.token_id).toBe(1);
    expect(event?.remedy).toBe('apply_migration_0003_api_token_scopes');
    // Distinct from the full-drift signal, and carries no email, prefix or hash.
    expect(driftEvents(spy)).toHaveLength(0);
    const logged = spy.mock.calls.flat().join(' ');
    for (const leak of [USERS.owner, 't_drift000', await sha256Hex(PLAINTEXT)]) {
      expect(logged).not.toContain(leak);
    }
  });

  it('the same token with an expiry resolves normally — the column itself is not the problem', async () => {
    await env.DB.prepare("UPDATE api_tokens SET expires_at = datetime('now', '+1 day')").run();
    const p = (await resolveApiTokenByHash(env, await sha256Hex(PLAINTEXT))) as PersonPrincipal;
    expect(p?.kind).toBe('person');
    expect(p?.tokenScopes).toEqual(['notes.read']);
    expect(events('api_token_no_expiry')).toHaveLength(0);
  });
});
