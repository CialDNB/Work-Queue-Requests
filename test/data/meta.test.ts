import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeDb } from '../../src/data';
import { migrationNamesHash } from '../../src/data/meta';
import type { Env } from '../../src/env';
import { applySchema } from '../helpers/db';

// wrangler's own bookkeeping table, exactly as `wrangler d1 migrations apply` creates it. The
// kit never creates this — that is the point of the tests below.
const D1_MIGRATIONS = `CREATE TABLE d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

const db = () => makeDb(env as Env).meta;

describe('meta repo — migrations + schema fingerprint', () => {
  beforeAll(applySchema);
  // Storage is isolated per FILE, so each test states its own precondition for a table that
  // may or may not exist rather than inheriting whatever the previous one left behind.
  beforeEach(async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS d1_migrations').run();
  });

  it('appliedMigrations returns [] — not a throw — when d1_migrations does not exist', async () => {
    // THE case this contract exists for. A freshly provisioned app has never run
    // `wrangler d1 migrations apply`, so the table is genuinely absent, and so it is in this
    // runtime (tests apply schema.sql directly). The daily report is best-effort and runs LAST
    // in the ops loop: if this threw, a brand-new app's first report would fail as a cron error.
    await expect(db().appliedMigrations()).resolves.toEqual([]);
  });

  it('appliedMigrations reads wrangler’s table oldest-first, carrying names and applied_at', async () => {
    await env.DB.prepare(D1_MIGRATIONS).run();
    await env.DB.prepare(
      "INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_read_log.sql', '2026-08-01 03:00:00'), ('0002_later.sql', '2026-08-05 03:00:00')",
    ).run();
    const rows = await db().appliedMigrations();
    expect(rows.map((r) => r.name)).toEqual(['0001_read_log.sql', '0002_later.sql']);
    expect(rows[0]?.applied_at).toBe('2026-08-01 03:00:00');
  });

  it('a NULL applied_at reads as null, never as undefined or a crash', async () => {
    // wrangler defaults the column, but a hand-repaired row (or a future wrangler) may not.
    await env.DB.prepare(
      'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP)',
    ).run();
    await env.DB.prepare("INSERT INTO d1_migrations (name) VALUES ('0001_x.sql')").run();
    expect(await db().appliedMigrations()).toEqual([{ name: '0001_x.sql', applied_at: null }]);
  });

  it('drops a migration row the registry would reject, instead of 400-ing the whole report', async () => {
    // `d1_migrations` is WRANGLER'S table: `name` is TEXT UNIQUE with no NOT NULL, nothing in this
    // repo constrains it, and a hand-repaired ledger or an interrupted apply can leave a null or
    // empty name behind. Sent as `{ name: null }` it fails the registry's
    // `z.string().min(1).max(200)` and the ENTIRE daily report is refused — status, health and
    // manifest included — every day until a human noticed. A reader that promises never to throw
    // must also never emit something the wire rejects.
    await env.DB.prepare(
      'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, applied_at TIMESTAMP)',
    ).run();
    const overLong = `${'m'.repeat(400)}.sql`;
    await env.DB.prepare(
      "INSERT INTO d1_migrations (name, applied_at) VALUES (NULL, '2026-08-01 03:00:00'), ('', '2026-08-01 03:00:00'), ('0003_ok.sql', '2026-08-01 03:00:00'), (?, '2026-08-01 03:00:00')",
    )
      .bind(overLong)
      .run();
    const rows = await db().appliedMigrations();
    expect(rows.map((r) => r.name)).toEqual(['0003_ok.sql', overLong.slice(0, 200)]);
    expect(rows.every((r) => r.name.length > 0 && r.name.length <= 200)).toBe(true);
    expect(rows.every((r) => (r.applied_at?.length ?? 0) <= 64)).toBe(true);
  });

  it('schemaHash is stable across calls and independent of d1_migrations existing', async () => {
    // The exclusion that matters most: applying a migration writes a ROW into d1_migrations,
    // and if that table's own DDL were in the hash, a future wrangler reshaping it would make
    // the entire fleet report schema drift on the same day for a table none of them own.
    const before = await db().schemaHash();
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(await db().schemaHash()).toBe(before);
    await env.DB.prepare(D1_MIGRATIONS).run();
    expect(await db().schemaHash()).toBe(before);
  });

  it('schemaHash MOVES when DDL runs with no migration behind it — the drift signal', async () => {
    const before = await db().schemaHash();
    // Exactly the unreviewed change the fingerprint exists to catch: a hand-run CREATE.
    await env.DB.prepare('CREATE TABLE drift_probe (id INTEGER PRIMARY KEY, note TEXT)').run();
    const after = await db().schemaHash();
    expect(after).not.toBe(before);
    // …and it comes back when the change is reverted, so the hash tracks shape, not history.
    await env.DB.prepare('DROP TABLE drift_probe').run();
    expect(await db().schemaHash()).toBe(before);
  });

  it('schemaHash survives a reflow of the DDL — indentation and line breaks are not drift', async () => {
    const before = await db().schemaHash();
    await env.DB.prepare('CREATE TABLE fmt_probe (id INTEGER PRIMARY KEY, note TEXT)').run();
    const withProbe = await db().schemaHash();
    await env.DB.prepare('DROP TABLE fmt_probe').run();
    // Same tokens, reflowed the way schema.sql is actually written — newlines and indentation
    // between them. SQLite stores the CREATE text verbatim, so without normalization a reformat
    // of the checked-in DDL would report as schema drift on the next fresh provision.
    await env.DB.prepare(
      'CREATE TABLE fmt_probe (id\n     INTEGER   PRIMARY KEY,\n\n     note    TEXT)',
    ).run();
    expect(await db().schemaHash()).toBe(withProbe);
    await env.DB.prepare('DROP TABLE fmt_probe').run();
    expect(await db().schemaHash()).toBe(before);
  });

  it('schemaHash carries no schema TEXT — it is a fingerprint, not an export', async () => {
    // A hash cannot smuggle DDL, column names, or data into the registry payload. Pinned so a
    // future "make drift easier to debug" change has to break a test to send the DDL itself.
    const hash = await db().schemaHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('CREATE');
    expect(hash).not.toContain('read_log');
  });

  it('migrationNamesHash is order-independent but content-sensitive', async () => {
    // The registry unions migration names by key, so two apps that applied the same set in a
    // different order ARE at the same schema version. A rename, however, keeps `count` identical
    // and would otherwise be invisible — this hash is what makes it visible.
    const a = await migrationNamesHash(['0001_a.sql', '0002_b.sql']);
    expect(await migrationNamesHash(['0002_b.sql', '0001_a.sql'])).toBe(a);
    expect(await migrationNamesHash(['0001_a.sql', '0002_renamed.sql'])).not.toBe(a);
    expect(await migrationNamesHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
