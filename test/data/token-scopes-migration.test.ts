// The kit's api_token_scopes migration (0003 in the kit; found by slug, since a fork renumbers it —
// migrationBySlug in test/helpers/db.ts) (PIA C8), run for real against both shapes it will
// meet in the wild: an EXISTING database (pre-C8 api_tokens, rows to carry over) and a FRESH
// install (the new schema.sql baseline, then every migration). Both must end in the baseline's
// shape; the existing one must keep every row and id, give every legacy token NULL scopes, and
// force every legacy expiry to at most upgrade + 90 days. The fresh one may already hold SCOPED
// tokens when the migration first runs (the kit applies schema.sql at provision and the
// migrations only on the first CI deploy) — and those must keep their scopes, as they must when
// the file is applied a second time.
//
// Own file on purpose: every test here drops and rebuilds `api_tokens`.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { principalCan } from '../../src/auth/permissions';
import { resolveApiTokenByHash, sha256Hex } from '../../src/auth/tokens';
import type { PersonPrincipal } from '../../src/auth/types';
import { applySchema, migrationBySlug, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

const migrationSql = migrationBySlug('api_token_scopes.sql').sql;

// The migration holds no trigger bodies and no string literal containing `--` or `;`, so a
// line-comment strip + split on `;` is exactly how SQLite reads it.
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runMigration(): Promise<void> {
  for (const stmt of statements(migrationSql)) await env.DB.prepare(stmt).run();
}

// The migration's statements before the first one matching `step` — a first attempt that died
// just before that step. Found by content, not position, so a statement added earlier in the file
// cannot silently move the simulated failure point.
function stepsBefore(step: RegExp): string[] {
  const all = statements(migrationSql);
  const at = all.findIndex((s) => step.test(s));
  if (at === -1) throw new Error(`0003 has no statement matching ${step}`);
  return all.slice(0, at);
}

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

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

async function columns(): Promise<ColumnInfo[]> {
  const res = await env.DB.prepare('PRAGMA table_info(api_tokens)').all<ColumnInfo>();
  return res.results.map(({ name, type, notnull, dflt_value, pk }) => ({
    name,
    type,
    notnull,
    dflt_value,
    pk,
  }));
}

interface TokenRow {
  id: number;
  email: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  scopes?: string | null;
}

async function rows(): Promise<TokenRow[]> {
  return (await env.DB.prepare('SELECT * FROM api_tokens ORDER BY id').all<TokenRow>()).results;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysUntil = (t: string | null) =>
  t === null ? Number.NaN : (Date.parse(`${t.replace(' ', 'T')}Z`) - Date.now()) / DAY_MS;

// The shape schema.sql gives a fresh install, captured once before any test rebuilds the table.
let baselineColumns: ColumnInfo[] = [];
let baselineSql = '';

describe('0003_api_token_scopes migration', () => {
  beforeAll(async () => {
    await applySchema();
    baselineColumns = await columns();
    baselineSql =
      (
        await env.DB.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_tokens'",
        ).first<{ sql: string }>()
      )?.sql ?? '';
  });
  beforeEach(seedDb);
  afterEach(async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS api_tokens_c8').run();
    await env.DB.prepare('DROP TABLE IF EXISTS api_tokens').run();
    await applySchema();
  });

  it('the baseline is the C8 shape: scopes present, expires_at NOT NULL', () => {
    expect(baselineColumns.map((c) => c.name)).toEqual([
      'id',
      'email',
      'name',
      'token_hash',
      'prefix',
      'created_at',
      'last_used_at',
      'expires_at',
      'revoked_at',
      'scopes',
    ]);
    expect(baselineColumns.find((c) => c.name === 'expires_at')?.notnull).toBe(1);
    expect(baselineColumns.find((c) => c.name === 'scopes')?.notnull).toBe(0);
  });

  describe('on an EXISTING (pre-C8) database', () => {
    const legacyPlain = 't_legacyowner00000000000000000000000000000'.slice(0, 42);

    beforeEach(async () => {
      await env.DB.prepare('DROP TABLE api_tokens').run();
      await env.DB.prepare(PRE_C8_API_TOKENS).run();
      const insert = env.DB.prepare(
        "INSERT INTO api_tokens (id, email, name, token_hash, prefix, created_at, last_used_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, '2026-01-02 03:04:05', ?, ?, ?)",
      );
      await env.DB.batch([
        // 1: the case C8 exists for — a machine token with no expiry at all.
        insert.bind(
          1,
          USERS.owner,
          'etl',
          await sha256Hex(legacyPlain),
          legacyPlain.slice(0, 10),
          '2026-09-01 00:00:00',
          null,
          null,
        ),
        // 2: minted for a year under the old 365-day route maximum.
        insert.bind(2, USERS.member, 'year', 'h2', 't_year0000', null, '2099-01-01 00:00:00', null),
        // 3: already due inside the new window — kept exactly.
        insert.bind(3, USERS.member, 'soon', 'h3', 't_soon0000', null, 'SOON', null),
        // 5 (a gap, as after a DSR erasure): expired and revoked — carried over untouched.
        insert.bind(
          5,
          USERS.admin,
          'dead',
          'h5',
          't_dead0000',
          null,
          '2020-01-01 00:00:00',
          '2020-01-02 00:00:00',
        ),
      ]);
      await env.DB.prepare(
        "UPDATE api_tokens SET expires_at = datetime('now', '+10 days') WHERE id = 3",
      ).run();
    });

    it('applies cleanly and ends in exactly the fresh-install shape', async () => {
      await runMigration();
      expect(await columns()).toEqual(baselineColumns);
      const sql = await env.DB.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_tokens'",
      ).first<{ sql: string }>();
      // The CHECK on scopes came across (the constraint text itself, not just the column).
      expect(sql?.sql).toContain("json_type(scopes) = 'array'");
      expect(baselineSql).toContain("json_type(scopes) = 'array'");
      // No scratch table left behind.
      const scratch = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE name = 'api_tokens_c8'",
      ).first();
      expect(scratch).toBeNull();
    });

    it('keeps every row and id, and gives every legacy token NULL scopes', async () => {
      const before = await rows();
      await runMigration();
      const after = await rows();
      expect(after.map((r) => r.id)).toEqual([1, 2, 3, 5]);
      for (const r of after) expect(r.scopes).toBeNull();
      for (const [i, r] of after.entries()) {
        const { expires_at: _a, scopes: _s, ...rest } = r;
        const { expires_at: _b, ...was } = before[i] as TokenRow;
        expect(rest).toEqual(was); // email, name, hash, prefix, created/last-used/revoked intact
      }
    });

    it('back-fills a NULL expiry, caps a far one at +90 days, and keeps a sooner one', async () => {
      const soonBefore = (await rows()).find((r) => r.id === 3)?.expires_at;
      await runMigration();
      const byId = new Map((await rows()).map((r) => [r.id, r]));
      for (const id of [1, 2]) {
        const d = daysUntil(byId.get(id)?.expires_at ?? null);
        expect(d).toBeGreaterThan(89.9);
        expect(d).toBeLessThanOrEqual(90);
      }
      expect(byId.get(3)?.expires_at).toBe(soonBefore);
      expect(byId.get(5)?.expires_at).toBe('2020-01-01 00:00:00');
    });

    it('a carried-over token keeps working — as a LEGACY token, never with the non-delegable set', async () => {
      await runMigration();
      const p = (await resolveApiTokenByHash(
        env,
        await sha256Hex(legacyPlain),
      )) as PersonPrincipal | null;
      expect(p).not.toBeNull();
      expect(p?.tokenScopes).toBeNull();
      expect(principalCan(p!, 'users.read')).toBe(true);
      expect(principalCan(p!, 'tokens.self')).toBe(false);
      expect(principalCan(p!, 'users.manage')).toBe(false);
    });

    it('the rebuilt table enforces the new constraints and keeps UNIQUE(token_hash)', async () => {
      await runMigration();
      const insert = (hash: string, expires: string | null, scopes: string | null) =>
        env.DB.prepare(
          "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES ('x@test.example', 'x', ?, 't_x', ?, ?)",
        )
          .bind(hash, expires, scopes)
          .run();
      await expect(insert('fresh1', null, '[]')).rejects.toThrow(/NOT NULL/i);
      await expect(insert('fresh2', '2099-01-01 00:00:00', '{"a":1}')).rejects.toThrow();
      await expect(insert('h2', '2099-01-01 00:00:00', '[]')).rejects.toThrow(/UNIQUE/i);
      await insert('fresh3', '2099-01-01 00:00:00', '["notes.read"]');
      // AUTOINCREMENT continues past the copied ids.
      const last = await env.DB.prepare(
        "SELECT id FROM api_tokens WHERE token_hash = 'fresh3'",
      ).first<{ id: number }>();
      expect(last?.id).toBeGreaterThan(5);
    });

    it('is retry-safe after a failure between the copy and the DROP (re-copies, loses nothing)', async () => {
      // Simulate a first attempt that died after the copy: the scratch table exists and is
      // full, api_tokens is still there. The retry must finish with every row exactly once.
      for (const s of stepsBefore(/^DROP TABLE api_tokens$/)) await env.DB.prepare(s).run();
      await runMigration();
      expect((await rows()).map((r) => r.id)).toEqual([1, 2, 3, 5]);
    });

    // The old Worker keeps serving until the deploy that follows the migration, so rows can change
    // between a failed attempt and its retry. api_tokens rows are MUTABLE (unlike read_log, whose
    // 0002 rebuild this file's retry path first copied): the retry must take the source's current
    // rows, not the scratch table's stale copy — or a revocation, a last-used stamp or a DSR erasure
    // made in between is undone, and a revoked token works again as a legacy token.
    it('a retry takes the source rows as they are NOW: revocations, last-used stamps and erasures made after the failed attempt all survive', async () => {
      for (const s of stepsBefore(/^DROP TABLE api_tokens$/)) await env.DB.prepare(s).run();
      // Between the attempts: the owner revokes the working legacy token (1), token 2 is used,
      // token 3 is erased under a DSR request, and a new token is minted.
      await env.DB.batch([
        env.DB.prepare("UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = 1"),
        env.DB.prepare("UPDATE api_tokens SET last_used_at = '2026-09-20 10:00:00' WHERE id = 2"),
        env.DB.prepare('DELETE FROM api_tokens WHERE id = 3'),
        env.DB.prepare(
          "INSERT INTO api_tokens (id, email, name, token_hash, prefix, expires_at) VALUES (6, ?, 'new', 'h6', 't_new00000', datetime('now', '+30 days'))",
        ).bind(USERS.member),
      ]);

      await runMigration();

      const after = await rows();
      expect(after.map((r) => r.id)).toEqual([1, 2, 5, 6]); // 3 stays erased, 6 is carried
      const byId = new Map(after.map((r) => [r.id, r]));
      expect(byId.get(1)?.revoked_at).not.toBeNull();
      expect(byId.get(2)?.last_used_at).toBe('2026-09-20 10:00:00');
      // The revoked token stays dead — it does not come back as a working legacy token.
      expect(await resolveApiTokenByHash(env, await sha256Hex(legacyPlain))).toBeNull();
    });

    it('a failure between the DROP and the RENAME leaves every row in the scratch table', async () => {
      for (const s of stepsBefore(/^ALTER TABLE api_tokens_c8 RENAME/)) {
        await env.DB.prepare(s).run();
      }
      // The retry stops on the missing table instead of destroying the only copy…
      await expect(runMigration()).rejects.toThrow(/no such table/i);
      const kept = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens_c8').first<{
        n: number;
      }>();
      expect(kept?.n).toBe(4);
      // …and one RENAME recovers.
      await env.DB.prepare('ALTER TABLE api_tokens_c8 RENAME TO api_tokens').run();
      expect((await rows()).map((r) => r.id)).toEqual([1, 2, 3, 5]);
    });
  });

  describe('on a FRESH install (baseline, then migrations)', () => {
    it('is a no-op rebuild of the empty baseline table — same shape, no error', async () => {
      expect(await rows()).toEqual([]);
      await runMigration();
      expect(await columns()).toEqual(baselineColumns);
      expect(await rows()).toEqual([]);
    });
  });

  // The kit's setup applies schema.sql at provision and runs `wrangler d1 migrations apply` only
  // on the first CI / Deploy-production run, after a manual first deploy. So 0003 can first meet a
  // C8-shaped table that people have ALREADY minted scoped tokens into. Copying NULL into `scopes`
  // there would silently widen every one of them to legacy (the owner's role minus the
  // non-delegable set) — the reviewed blocker this pins.
  describe('on a C8-shaped table that already holds tokens (first CI deploy, or a second run)', () => {
    function bearer(token: string, method: string, path: string, body?: unknown) {
      return SELF.fetch(BASE + path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    async function mintScoped(scopes: string[]): Promise<{ token: string; id: number }> {
      const res = await asUser(USERS.admin, 'POST', '/api/tokens', { name: 'scoped', scopes });
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { token: string; id: number } }).data;
    }

    it('keeps every explicit scope list, so no scoped token widens', async () => {
      const reader = await mintScoped(['notes.read']);
      const identity = await mintScoped([]);
      expect((await bearer(reader.token, 'GET', '/api/users')).status).toBe(404);
      expect((await bearer(reader.token, 'POST', '/api/notes', { title: 'x' })).status).toBe(404);
      const before = await rows(); // after the calls above, which stamp last_used_at

      await runMigration();

      expect(await rows()).toEqual(before); // every column, scopes and expiry included
      expect(await columns()).toEqual(baselineColumns);
      // Still exactly as narrow over HTTP: users.read and notes.write were never granted.
      expect((await bearer(reader.token, 'GET', '/api/users')).status).toBe(404);
      expect((await bearer(reader.token, 'POST', '/api/notes', { title: 'x' })).status).toBe(404);
      expect((await bearer(reader.token, 'GET', '/api/notes')).status).toBe(200);
      expect((await bearer(identity.token, 'GET', '/api/notes')).status).toBe(404);
      expect((await bearer(identity.token, 'GET', '/api/me')).status).toBe(200);
    });

    it('keeps a legacy NULL as NULL — only a table WITHOUT the column produces legacy rows', async () => {
      await env.DB.prepare(
        "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 'legacy', 'hl', 't_legacy00', datetime('now', '+5 days'), NULL)",
      )
        .bind(USERS.member)
        .run();
      await mintScoped(['notes.read']);
      await runMigration();
      expect((await rows()).map((r) => r.scopes)).toEqual([null, '["notes.read"]']);
    });

    it('applying the whole file twice changes nothing the second time', async () => {
      await mintScoped(['notes.read', 'notes.write']);
      await env.DB.prepare(
        "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 'legacy', 'hl2', 't_legacy00', datetime('now', '+5 days'), NULL)",
      )
        .bind(USERS.member)
        .run();
      await runMigration();
      const once = await rows();
      await runMigration();
      expect(await rows()).toEqual(once);
      expect(once.map((r) => r.scopes)).toEqual(['["notes.read","notes.write"]', null]);
    });

    it('a hand-added `scopes` column with no CHECK: a non-array value is narrowed to [], never dropped', async () => {
      // A fork that wrote its own `ALTER TABLE … ADD COLUMN scopes TEXT` before adopting 0003.
      await env.DB.prepare('DROP TABLE api_tokens').run();
      await env.DB.prepare(PRE_C8_API_TOKENS).run();
      await env.DB.prepare('ALTER TABLE api_tokens ADD COLUMN scopes TEXT').run();
      await env.DB.prepare(
        "INSERT INTO api_tokens (id, email, name, token_hash, prefix, expires_at, scopes) VALUES (1, ?, 'ok', 'a', 't_a', NULL, '[\"notes.read\"]'), (2, ?, 'bad', 'b', 't_b', NULL, 'notes.read'), (3, ?, 'none', 'c', 't_c', NULL, NULL)",
      )
        .bind(USERS.member, USERS.member, USERS.member)
        .run();
      await runMigration();
      const after = await rows();
      expect(after.map((r) => [r.id, r.scopes])).toEqual([
        [1, '["notes.read"]'],
        [2, '[]'],
        [3, null],
      ]);
      for (const r of after) expect(daysUntil(r.expires_at)).toBeGreaterThan(89.9);
    });
  });
});
