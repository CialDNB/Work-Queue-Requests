// The harness every other test stands on (test/helpers/db.ts), tested through its own apply path.
//
// What it pins: migrations/d1/*.sql apply ONCE per database — as `wrangler d1 migrations apply`
// does — while schema.sql and the row reset run on every seedDb(), and the shape the migrations
// leave is what every later call rebuilds and respects. The synthetic migrations below go through
// applySchemaWith / seedDbWith, the very code applySchema / seedDb run, so a migration that is a
// plain `ALTER TABLE … ADD COLUMN` — or one that drops or renames a baseline object, or holds a
// trigger, comment, string or quoted identifier the statement splitter must read as SQLite does —
// is proven to survive the harness before a real one lands. Storage is per FILE, so the tests below
// build on each other in order, deliberately.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applySchema,
  applySchemaWith,
  MIGRATIONS,
  type Migration,
  seedDb,
  seedDbWith,
  USERS,
} from './db';

// Ordinals far past any real file, so they can never collide with one.
const ADD_NOTES_COLUMN: Migration = {
  name: '9001_synthetic_notes_flag.sql',
  sql: '-- one-shot: SQLite has no ADD COLUMN IF NOT EXISTS\nALTER TABLE notes ADD COLUMN synthetic_flag INTEGER NOT NULL DEFAULT 0;',
};
// audit_log is a WORM table: seedDb() drops and recreates it on every call. With each migration
// applied only once, that recreate is exactly where a migration's column could vanish without a
// sound — recreated from schema.sql, with the migration already recorded and never re-run.
const ALTER_WORM_TABLE: Migration = {
  name: '9002_synthetic_audit_tier.sql',
  sql: [
    'ALTER TABLE audit_log ADD COLUMN synthetic_tier TEXT;',
    'CREATE INDEX IF NOT EXISTS idx_audit_synthetic_tier ON audit_log(synthetic_tier);',
  ].join('\n'),
};
const WITH_SYNTHETIC = [...MIGRATIONS, ADD_NOTES_COLUMN, ALTER_WORM_TABLE];

// A file that fails on its second statement, after its first one ran — so the batch must undo both.
const BROKEN: Migration = {
  name: '9003_synthetic_broken.sql',
  sql: 'CREATE TABLE synthetic_half (id INTEGER PRIMARY KEY);\nALTER TABLE no_such_table ADD COLUMN x INTEGER;',
};
// Applied in the same call, just before BROKEN, to a WORM table the next seedDb() rebuilds.
const ALTER_BEFORE_A_FAILURE: Migration = {
  name: '9010_synthetic_audit_channel.sql',
  sql: 'ALTER TABLE audit_log ADD COLUMN synthetic_channel TEXT;',
};

// The removals. Each targets an object schema.sql creates with IF NOT EXISTS, so the per-call
// baseline would put it straight back if nothing stopped it.
const DROP_WORM_INDEX: Migration = {
  name: '9004_synthetic_drop_audit_actor_index.sql',
  sql: 'DROP INDEX idx_audit_actor;',
};
// SQLite refuses to drop an indexed column, so the migration drops the index first — and the
// baseline's `CREATE INDEX … ON ai_usage(actor_email, created_at)` then names a column that is
// gone. Re-run, it would not reappear quietly: it would throw.
const DROP_COLUMN: Migration = {
  name: '9005_synthetic_drop_ai_usage_created_at.sql',
  sql: 'DROP INDEX idx_ai_usage_actor;\nALTER TABLE ai_usage DROP COLUMN created_at;',
};
const RENAME_TABLE: Migration = {
  name: '9006_synthetic_rename_app_settings.sql',
  sql: 'ALTER TABLE app_settings RENAME TO synthetic_settings;',
};
const WITH_REMOVALS = [...WITH_SYNTHETIC, DROP_WORM_INDEX, DROP_COLUMN, RENAME_TABLE];
// app_settings above has no index or trigger; app_identity has two triggers. A RENAME moves them
// to the new table under their OWN names, so they stay in the snapshot while the baseline still
// says `… ON app_identity` — and SQLite resolves that table before it reads IF NOT EXISTS.
// (The index half, notes → a new name, is in db-rename.test.ts: seedDb() resets notes by name.)
const RENAME_TRIGGERED_TABLE: Migration = {
  name: '9007_synthetic_rename_app_identity.sql',
  sql: 'ALTER TABLE app_identity RENAME TO synthetic_identity;',
};

// What a fork's migration may hold, and wrangler applies as written, that the statement splitter
// must read the way SQLite does: a CASE…END inside a trigger body (its END is not the trigger's),
// a ';' inside a block comment, a '/*' inside a line comment (it opens nothing — so the table
// between it and the next real block comment is not swallowed), and '--', ';', CASE and END
// inside string literals.
const SPLITTER_EDGE_CASES: Migration = {
  name: '9008_synthetic_splitter_edge_cases.sql',
  sql: [
    '-- A line comment may name migrations/d1/*.sql without opening a block comment.',
    "CREATE TABLE synthetic_labels (id INTEGER PRIMARY KEY, label TEXT, note TEXT NOT NULL DEFAULT 'a -- b; c');",
    '/* A block comment is whitespace to SQLite: this ; separates nothing. */',
    'CREATE TRIGGER synthetic_labels_need_a_label',
    'BEFORE INSERT ON synthetic_labels',
    'BEGIN',
    "  SELECT CASE WHEN NEW.label IS NULL THEN RAISE(ABORT, 'synthetic: in case of no label; the end') END;",
    'END;',
    'CREATE INDEX synthetic_labels_by_label ON synthetic_labels(label);',
  ].join('\n'),
};

// The identifier quote SQLite and wrangler's local splitter both accept beyond "double quotes":
// `backticks`. Inside one, ';' separates nothing, '--' and '/*' open no comment, and CASE opens no
// block — so the table below must arrive whole, with its columns named exactly so, and the index
// after it must run as a statement of its own.
const BACKTICK_IDENTIFIERS: Migration = {
  name: '9011_synthetic_backtick_identifiers.sql',
  sql: [
    'CREATE TABLE `synthetic_tick;table` (id INTEGER PRIMARY KEY, `tick -- note` TEXT, `tick /* open` TEXT, `case` TEXT);',
    'CREATE INDEX synthetic_tick_by_note ON `synthetic_tick;table`(`tick -- note`);',
  ].join('\n'),
};

// [Brackets] are an identifier quote to SQLite, but NOT to `wrangler d1 migrations apply --local`:
// its splitter cuts at the ';' below and drops the line from the '--' on. The harness reads them the
// same way, so each of these fails in CI as it would on `npm run db:migrate:local`.
const BRACKET_SEMICOLON: Migration = {
  name: '9012_synthetic_bracket_semicolon.sql',
  sql: 'CREATE TABLE [synthetic_bracket;table] (id INTEGER PRIMARY KEY);',
};
const BRACKET_DASHES: Migration = {
  name: '9013_synthetic_bracket_dashes.sql',
  sql: 'CREATE TABLE [synthetic_bracket -- note] (id INTEGER PRIMARY KEY);',
};

async function columns(table: string): Promise<string[]> {
  const res = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return res.results.map((r) => r.name);
}

async function recorded(): Promise<{ name: string; applied_at: string | null }[]> {
  const res = await env.DB.prepare(
    'SELECT name, applied_at FROM d1_test_migrations ORDER BY id',
  ).all<{ name: string; applied_at: string | null }>();
  return res.results;
}

async function exists(type: 'table' | 'index' | 'trigger', name: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
    .bind(type, name)
    .first();
  return row !== null;
}

/** The table sqlite_master files an index or trigger under — null if there is no such object. */
async function tableOf(type: 'index' | 'trigger', name: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT tbl_name FROM sqlite_master WHERE type = ? AND name = ?')
    .bind(type, name)
    .first<{ tbl_name: string }>();
  return row?.tbl_name ?? null;
}

async function auditRows(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>();
  return row?.n ?? -1;
}

describe('test harness — migrations apply once per database, the reset runs per test', () => {
  beforeAll(applySchema);

  it('finds every migrations/d1 file and records each one once, by name, in ordinal order', async () => {
    // The glob is the directory listing: an empty list would make every other test here vacuous.
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS[0]?.name).toBe('0000_kit_app_identity.sql');
    const names = MIGRATIONS.map((m) => m.name);
    expect(names).toEqual([...names].sort());
    // Contiguous from 0000, as the node:fs ordinal guard requires of the folder: so a glob that
    // silently dropped a file mid-sequence fails here, not just one that found nothing.
    expect(MIGRATIONS.map((m) => Number.parseInt(m.name, 10))).toEqual(MIGRATIONS.map((_, i) => i));
    expect(MIGRATIONS.every((m) => m.sql.trim().length > 0)).toBe(true);

    await applySchema();
    await seedDb();
    await seedDb();
    const rows = await recorded();
    expect(rows.map((r) => r.name)).toEqual(names);
    expect(rows.every((r) => typeof r.applied_at === 'string')).toBe(true);
  });

  it('an ADD COLUMN migration survives consecutive seedDb() calls', async () => {
    await seedDbWith(WITH_SYNTHETIC);
    await seedDbWith(WITH_SYNTHETIC);
    await seedDbWith(WITH_SYNTHETIC);

    expect(await columns('notes')).toContain('synthetic_flag');
    const rows = (await recorded()).filter((r) => r.name === ADD_NOTES_COLUMN.name);
    expect(rows).toHaveLength(1);
    // Why the bookkeeping is load-bearing: run the same statement a second time and SQLite
    // refuses — this is the error every test after the first would die on under a replay.
    await expect(env.DB.prepare(ADD_NOTES_COLUMN.sql).run()).rejects.toThrow(
      /duplicate column name/,
    );
  });

  it('the migrated column is still there for the next test in the file, and seedDb() keeps it', async () => {
    // Storage persists across tests within a file — the assumption "once per database" rests on.
    expect(await columns('notes')).toContain('synthetic_flag');
    await seedDb(); // the real list: it knows nothing of 9001, and must not undo it
    expect(await columns('notes')).toContain('synthetic_flag');
    await env.DB.prepare(
      "INSERT INTO notes (id, title, body, created_by, synthetic_flag) VALUES ('n1', 't', 'b', ?, 1)",
    )
      .bind(USERS.member)
      .run();
    await seedDb();
    // …while the per-test reset still empties it.
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('a migration that ALTERs a WORM table keeps its column and index through the drop + recreate reset', async () => {
    await seedDbWith(WITH_SYNTHETIC);
    await seedDbWith(WITH_SYNTHETIC);
    expect(await columns('audit_log')).toContain('synthetic_tier');
    expect(await exists('index', 'idx_audit_synthetic_tier')).toBe(true);

    await env.DB.prepare(
      "INSERT INTO audit_log (actor_email, action, synthetic_tier) VALUES (?, 'note.create', 'fast')",
    )
      .bind(USERS.member)
      .run();
    // Still WORM after the rebuild: the triggers came back with the table.
    await expect(env.DB.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/i);
    await expect(env.DB.prepare("UPDATE audit_log SET action = 'x'").run()).rejects.toThrow(
      /append-only/i,
    );
    for (const trigger of ['audit_log_no_update', 'audit_log_no_delete', 'audit_log_no_replace']) {
      expect(await exists('trigger', trigger)).toBe(true);
    }

    await seedDb();
    expect(await auditRows()).toBe(0); // the reset still resets
    expect(await columns('audit_log')).toContain('synthetic_tier');
  });

  it('a table a test drops comes back in its MIGRATED shape, not the schema.sql one', async () => {
    // The outage-faking pattern several suites use: DROP, exercise, applySchema() to restore.
    await env.DB.prepare('DROP TABLE audit_log').run();
    await env.DB.prepare('DROP TABLE notes').run();
    await applySchema();

    expect(await columns('audit_log')).toContain('synthetic_tier');
    expect(await exists('index', 'idx_audit_synthetic_tier')).toBe(true);
    expect(await exists('trigger', 'audit_log_no_delete')).toBe(true);
    expect(await columns('notes')).toContain('synthetic_flag');
    expect(await exists('index', 'idx_notes_created')).toBe(true);
  });

  it('an index a test drops on its own comes back from the migrated shape too', async () => {
    // Its table survives, so only a per-object restore sees the gap.
    await env.DB.prepare('DROP INDEX idx_audit_synthetic_tier').run();
    await applySchema();
    expect(await exists('index', 'idx_audit_synthetic_tier')).toBe(true);
  });

  it('a migration the splitter must read as SQLite does applies whole, and once', async () => {
    const upTo = [...WITH_SYNTHETIC, SPLITTER_EDGE_CASES];
    await seedDbWith(upTo);
    await seedDbWith(upTo);
    expect((await recorded()).filter((r) => r.name === SPLITTER_EDGE_CASES.name)).toHaveLength(1);
    expect(await exists('trigger', 'synthetic_labels_need_a_label')).toBe(true);
    // The statement after the trigger ran too: the split resumed in the right place.
    expect(await exists('index', 'synthetic_labels_by_label')).toBe(true);

    // The trigger arrived whole: its CASE…END and the message's ';' / "case" / "end" intact.
    await expect(
      env.DB.prepare('INSERT INTO synthetic_labels (id) VALUES (1)').run(),
    ).rejects.toThrow(/synthetic: in case of no label; the end/);
    await env.DB.prepare("INSERT INTO synthetic_labels (id, label) VALUES (2, 'kept')").run();
    const row = await env.DB.prepare('SELECT note FROM synthetic_labels WHERE id = 2').first<{
      note: string;
    }>();
    expect(row?.note).toBe('a -- b; c'); // a string literal is not a comment, nor a separator
  });

  it('a migration with ; -- /* and CASE inside `backtick` identifiers applies whole, and once', async () => {
    const upTo = [...WITH_SYNTHETIC, SPLITTER_EDGE_CASES, BACKTICK_IDENTIFIERS];
    await seedDbWith(upTo);
    await seedDbWith(upTo);
    expect((await recorded()).filter((r) => r.name === BACKTICK_IDENTIFIERS.name)).toHaveLength(1);

    // The table under its whole name, every column intact: nothing was cut at the ';' or stripped
    // from the '--' / '/*' on.
    expect(await columns('"synthetic_tick;table"')).toEqual([
      'id',
      'tick -- note',
      'tick /* open',
      'case',
    ]);
    // The statement after the table ran on its own: the split resumed in the right place.
    expect(await tableOf('index', 'synthetic_tick_by_note')).toBe('synthetic_tick;table');

    // And it is in the migrated shape: dropped, it comes back from it.
    await env.DB.prepare('DROP TABLE `synthetic_tick;table`').run();
    await applySchema();
    expect(await exists('table', 'synthetic_tick;table')).toBe(true);
    expect(await exists('index', 'synthetic_tick_by_note')).toBe(true);
  });

  it('a migration with ; or -- inside a [bracket] identifier fails, as wrangler --local cuts it', async () => {
    const upTo = [...WITH_SYNTHETIC, SPLITTER_EDGE_CASES, BACKTICK_IDENTIFIERS];
    for (const migration of [BRACKET_SEMICOLON, BRACKET_DASHES]) {
      await expect(applySchemaWith([...upTo, migration]), migration.name).rejects.toThrow(
        /unrecognized token/,
      );
      expect((await recorded()).map((r) => r.name)).not.toContain(migration.name);
    }
    expect(await exists('table', 'synthetic_bracket;table')).toBe(false);
    expect(await exists('table', 'synthetic_bracket -- note')).toBe(false);
  });

  it('a migration that fails part-way is not recorded and leaves nothing behind', async () => {
    await expect(applySchemaWith([...WITH_SYNTHETIC, BROKEN])).rejects.toThrow(/no such table/);
    expect(await exists('table', 'synthetic_half')).toBe(false);
    expect((await recorded()).map((r) => r.name)).not.toContain(BROKEN.name);
  });

  it('a migration applied in the same call as a failing one is in the migrated shape', async () => {
    // Each file commits on its own, so the one before the failure stays applied and recorded — and
    // will never run again. Left out of the snapshot, the WORM reset below would rebuild audit_log
    // from the shape before it, and the column would be gone for good.
    await expect(
      applySchemaWith([...WITH_SYNTHETIC, ALTER_BEFORE_A_FAILURE, BROKEN]),
    ).rejects.toThrow(/no such table/);
    const names = (await recorded()).map((r) => r.name);
    expect(names).toContain(ALTER_BEFORE_A_FAILURE.name);
    expect(names).not.toContain(BROKEN.name);

    await seedDbWith([...WITH_SYNTHETIC, ALTER_BEFORE_A_FAILURE]);
    expect(await columns('audit_log')).toContain('synthetic_channel');
    await seedDb();
    expect(await columns('audit_log')).toContain('synthetic_channel');
  });

  it('an index a migration DROPs stays dropped — through the WORM reset and a drop + restore', async () => {
    expect(await exists('index', 'idx_audit_actor')).toBe(true); // schema.sql made it
    const upTo = [...WITH_SYNTHETIC, DROP_WORM_INDEX];
    await seedDbWith(upTo);
    await seedDbWith(upTo);
    expect(await exists('index', 'idx_audit_actor')).toBe(false);

    await env.DB.prepare('DROP TABLE audit_log').run();
    await applySchema();
    expect(await exists('index', 'idx_audit_actor')).toBe(false);
    // …and nothing else about the table was lost on the way.
    expect(await exists('index', 'idx_audit_created')).toBe(true);
    expect(await exists('trigger', 'audit_log_no_delete')).toBe(true);
    expect(await columns('audit_log')).toContain('synthetic_tier');
  });

  it('a column a migration DROPs stays dropped, and the baseline never trips over it', async () => {
    const upTo = [...WITH_SYNTHETIC, DROP_WORM_INDEX, DROP_COLUMN];
    await seedDbWith(upTo);
    // The baseline index on the dropped column is SKIPPED, not created-then-dropped: running it
    // would throw "no such column" and take every seedDb() in the file down with it.
    await seedDbWith(upTo);
    await seedDb();
    expect(await columns('ai_usage')).not.toContain('created_at');
    expect(await exists('index', 'idx_ai_usage_actor')).toBe(false);
    expect(await exists('trigger', 'ai_usage_no_update')).toBe(true);
    await expect(
      env.DB.prepare(
        'CREATE INDEX IF NOT EXISTS idx_ai_usage_actor ON ai_usage(actor_email, created_at)',
      ).run(),
    ).rejects.toThrow(/no such column/);
  });

  it('a table a migration RENAMEs keeps its new name — the old one is not recreated beside it', async () => {
    await seedDbWith(WITH_REMOVALS);
    await seedDbWith(WITH_REMOVALS);
    await applySchema();
    expect(await exists('table', 'app_settings')).toBe(false);
    expect(await columns('synthetic_settings')).toEqual([
      'key',
      'value_json',
      'updated_by',
      'updated_at',
    ]);
  });

  it('a table a migration RENAMEs keeps its triggers, and the baseline never re-targets the old name', async () => {
    const upTo = [...WITH_REMOVALS, RENAME_TRIGGERED_TABLE];
    await seedDbWith(upTo);
    // The call that used to throw "no such table: main.app_identity": the snapshot still holds
    // both triggers (by their own names), and the baseline's CREATE TRIGGER names the old table.
    await seedDbWith(upTo);
    await seedDb();
    expect(await exists('table', 'app_identity')).toBe(false);
    for (const trigger of ['app_identity_no_update', 'app_identity_no_delete']) {
      expect(await tableOf('trigger', trigger)).toBe('synthetic_identity');
    }
    // Still frozen under its new name, and its one row was neither lost nor re-seeded beside it.
    await expect(
      env.DB.prepare("UPDATE synthetic_identity SET value = 'synthetic'").run(),
    ).rejects.toThrow(/immutable/);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM synthetic_identity').first<{
      n: number;
    }>();
    expect(left?.n).toBe(1);
  });

  it('a table a test makes for itself is neither dropped nor resurrected', async () => {
    // Only what the migrated shape records is ever rebuilt, and nothing is ever dropped by name.
    await env.DB.prepare('CREATE TABLE synthetic_scratch (id INTEGER PRIMARY KEY)').run();
    await seedDb();
    expect(await exists('table', 'synthetic_scratch')).toBe(true);
    await env.DB.prepare('DROP TABLE synthetic_scratch').run();
    await seedDb();
    expect(await exists('table', 'synthetic_scratch')).toBe(false);
  });

  it('keeps its bookkeeping out of the way of the app’s own d1_migrations reader', async () => {
    // src/data/meta.ts reports wrangler's table, and its tests rely on it being absent in a
    // fresh test database. The harness must never create it.
    expect(await exists('table', 'd1_migrations')).toBe(false);
    expect(await exists('table', 'd1_test_migrations')).toBe(true);
  });
});
