// The read ledger's THIRD stream (PIA C15): `kind = 'upstream'`, added by
// migrations/d1/0005_read_log_upstream.sql and by the matching schema.sql baseline.
//
// Three things are pinned, in this order, and the order is load-bearing — storage is per FILE, so
// the first describe block below meets a database that has never seen 0005:
//
//   1. THE MIGRATION ON AN EXISTING DATABASE, through the real test harness (#232). The file's
//      database is brought up to the migration BEFORE 0005 — which, because 0002 rebuilds the
//      table in its own shape, is exactly what a deployed pre-C15 app holds — rows are written in
//      every shape the older ledger allows, and then the harness applies the pending 0005 under
//      its real name, the way `wrangler d1 migrations apply` would. Every row must survive
//      byte-for-byte, and the table must end in the fresh-install shape.
//   2. THE TRIGGERS, VERBATIM. A rebuild drops the append-only triggers with the table; 0005
//      recreates them. Their SQL must be identical, character for character, in schema.sql, 0002
//      and 0005, and what the live database stores must be that text.
//   3. THE CHECK. An upstream row carries a source, a registered read id and a DECLARED target
//      NAME, each an identifier, and no view. A value — a DUNS, a CPF, a ticket key, an email, a
//      URL — is refused by the database itself. The aurora and d1 streams are not newly
//      constrained by any of it.
//
// The migration is found by CONTENT (its scratch table's name), not by file name, so a fork that
// renumbers it — as the file tells forks to — keeps this test without an edit.
import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import schemaSql from '../../schema.sql?raw';
import { readLogRepo } from '../../src/data/readLog';
import { applySchema, applySchemaWith, MIGRATIONS, seedDb, USERS } from '../helpers/db';

const UPSTREAM_MIGRATION = MIGRATIONS.find((m) => m.sql.includes('read_log_c15'));
const KIND_MIGRATION = MIGRATIONS.find((m) => m.sql.includes('read_log_k2b'));

function migration(): { name: string; sql: string } {
  if (!UPSTREAM_MIGRATION) throw new Error('no migration rebuilds read_log into read_log_c15');
  return UPSTREAM_MIGRATION;
}

/** Every migration before the upstream one — the database a deployed pre-C15 app holds. */
function migrationsBeforeUpstream() {
  return MIGRATIONS.slice(0, MIGRATIONS.indexOf(migration()));
}

const TRIGGERS = ['read_log_count_patch_only', 'read_log_no_replace'] as const;

/**
 * One CREATE TRIGGER statement, as written in a source file: from `CREATE TRIGGER` to its closing
 * `END;`. Neither read_log trigger holds a nested END, so the first `END;` at a line start is its
 * own.
 */
function triggerText(source: string, name: string): string {
  const start = source.indexOf(`CREATE TRIGGER IF NOT EXISTS ${name}\n`);
  if (start === -1) throw new Error(`no CREATE TRIGGER ${name}`);
  const end = source.indexOf('\nEND;', start);
  if (end === -1) throw new Error(`CREATE TRIGGER ${name} never ends`);
  return source.slice(start, end + '\nEND'.length);
}

/**
 * The same statement as SQLite stores it in sqlite_master: the `IF NOT EXISTS` clause is not part
 * of the stored text (sqlite.org/schematab.html, "Interpretation Of The Schema Table").
 */
function storedForm(text: string): string {
  return text.replace('CREATE TRIGGER IF NOT EXISTS ', 'CREATE TRIGGER ');
}

async function liveTriggers(): Promise<Record<string, string>> {
  const res = await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'read_log' ORDER BY name",
  ).all<{ name: string; sql: string }>();
  return Object.fromEntries(res.results.map((r) => [r.name, r.sql]));
}

async function liveIndexes(): Promise<string[]> {
  const res = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'read_log' AND sql IS NOT NULL ORDER BY name",
  ).all<{ name: string }>();
  return res.results.map((r) => r.name);
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

async function columns(): Promise<ColumnInfo[]> {
  const res = await env.DB.prepare('PRAGMA table_info(read_log)').all<ColumnInfo>();
  return res.results.map(({ name, type, notnull, dflt_value, pk }) => ({
    name,
    type,
    notnull,
    dflt_value,
    pk,
  }));
}

async function allRows(): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare('SELECT * FROM read_log ORDER BY id').all<Record<string, unknown>>())
    .results;
}

let seq = 0;

/** A raw insert, so every column — `kind` and `view` included — is exactly what the test says. */
async function insertRow(over: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const row: Record<string, unknown> = {
    id: `u-${seq}`,
    request_id: 'req-upstream',
    principal: USERS.member,
    app: 'test-app',
    env: 'test',
    route: 'GET /api/reports/:ticketKey/data',
    kind: 'upstream',
    source: 'autobahn',
    source_class: 'client',
    view: null,
    query_name: 'report_datablocks',
    target: 'ticket_key',
    row_count: null,
    ...over,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO read_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  )
    .bind(...cols.map((c) => row[c]))
    .run();
  return row.id as string;
}

// Values an upstream fetch is MADE with, and which must therefore never be what it is recorded
// by. Synthetic, and built so no scanner mistakes them for a real identifier.
const VALUES_NOT_NAMES: readonly [label: string, value: string][] = [
  ['a DUNS', '123456789'],
  ['a CPF, punctuated', '123.456.789-09'],
  ['a ticket key', 'INS-2026-0001'],
  ['an email', 'alice@test.example'],
  ['a URL with a query', 'https://upstream.test/report?duns=123456789'],
  ['free text', 'report for acme'],
  ['upper case', 'Ticket_Key'],
  ['a leading digit', '9ticket'],
  ['a leading underscore', '_ticket'],
  ['a path', 'reports/data'],
  ['the empty string', ''],
  ['65 characters', `t${'x'.repeat(64)}`],
];

/**
 * THE CHECK MATRIX, shared by the fresh install and the migrated database — both must answer every
 * case identically, which is what "ends in the fresh-install shape" means for a constraint.
 */
async function assertUpstreamCheck(): Promise<void> {
  // Accepted: the shape the seam writes, both classes, an intent and a completed row.
  const intent = await insertRow({ source_class: 'client' });
  await insertRow({ source_class: 'internal', row_count: 3, target: 'duns' });
  await insertRow({ target: 'x', source: 's', query_name: 'q' });
  await insertRow({ target: `t${'x'.repeat(63)}` }); // exactly 64
  await insertRow({ target: 'ticket_key_v2', source: 'cbs_2', query_name: 'series_by_id_3' });
  expect(await readLogRepo(env.DB).patchRowCount(intent, 1)).toBe(true);

  // Refused: a view (an HTTP source has none — and a URL must never land there), a missing read id
  // or target, and a value in any of the three identifier columns.
  await expect(insertRow({ view: 'autobahn.reports' })).rejects.toThrow(/CHECK/);
  await expect(insertRow({ query_name: null })).rejects.toThrow(/CHECK/);
  await expect(insertRow({ target: null })).rejects.toThrow(/CHECK/);
  for (const [, value] of VALUES_NOT_NAMES) {
    await expect(insertRow({ target: value })).rejects.toThrow(/CHECK/);
    await expect(insertRow({ query_name: value })).rejects.toThrow(/CHECK/);
    await expect(insertRow({ source: value })).rejects.toThrow(/CHECK/);
  }
  // …and a kind nobody declared is still refused.
  await expect(insertRow({ kind: 'http' })).rejects.toThrow(/CHECK/);

  // The two older streams are NOT newly constrained. An aurora row keeps K2a's guarantee (it must
  // name its view and query) and nothing more — its target is the spec's declared projection and
  // has never been held to a shape, so a fork's existing aurora target keeps working. A d1 row
  // still names no view.
  await insertRow({
    kind: 'aurora',
    source: 'C360_RO',
    view: 'c360_ro.v_accounts',
    query_name: 'listAccounts',
    target: 'client-code',
  });
  await insertRow({ kind: 'd1', source: 'notes', view: null, query_name: 'list', target: null });
  await expect(insertRow({ kind: 'aurora', view: null, query_name: 'q' })).rejects.toThrow(/CHECK/);
}

/** Rows in every shape the pre-C15 ledger allows, written before 0005 runs. */
async function writePreC15Rows(): Promise<void> {
  const insert = env.DB.prepare(
    `INSERT INTO read_log (id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, target, row_count, created_at)
     VALUES (?, ?, ?, 'test-app', 'staging', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    // An aurora client read whose count landed, with a declared target.
    insert.bind(
      'pre-1',
      'req-a',
      USERS.member,
      'GET /api/accounts',
      'aurora',
      'c360_ro',
      'client',
      'c360_ro.v_accounts',
      'listAccounts',
      'client_code',
      4,
      '2026-09-01 10:00:00',
    ),
    // An aurora intent that never got its count: NULL means ATTEMPTED and must stay NULL.
    insert.bind(
      'pre-2',
      'req-a',
      USERS.member,
      'GET /api/accounts',
      'aurora',
      'c360_ro',
      'client',
      'c360_ro.v_accounts',
      'listAccounts',
      null,
      null,
      '2026-09-01 10:00:01',
    ),
    // An internal aurora read, and two d1 reads — one of them attempted.
    insert.bind(
      'pre-3',
      'req-b',
      USERS.admin,
      'GET /api/usage',
      'aurora',
      'ret1_ro',
      'internal',
      'app_ro.v_usage',
      'listUsage',
      null,
      12,
      '2026-09-02 08:30:00',
    ),
    insert.bind(
      'pre-4',
      'req-c',
      USERS.viewer,
      'GET /api/notes',
      'd1',
      'notes',
      'internal',
      null,
      'list',
      null,
      2,
      '2026-09-03 09:00:00',
    ),
    insert.bind(
      'pre-5',
      'req-c',
      USERS.viewer,
      'GET /api/notes',
      'd1',
      'users',
      'internal',
      null,
      'getActive',
      null,
      null,
      '2026-09-03 09:00:00',
    ),
  ]);
}

// ── 1. THE MIGRATION, ON A DATABASE THAT HAS NEVER SEEN IT ───────────────────────────────────

describe('0005 on an EXISTING (pre-C15) database, through the test harness', () => {
  let before: Record<string, unknown>[] = [];

  beforeAll(async () => {
    // This file's database is brand new. Bring it up to the migration BEFORE 0005 — baseline,
    // then 0000…0004. 0002 rebuilds read_log in ITS shape, so what stands here is exactly the
    // ledger a deployed pre-C15 app holds, not a hand-written approximation of it.
    await applySchemaWith(migrationsBeforeUpstream());
    await writePreC15Rows();
    before = await allRows();
  });

  it('the migration exists, and it runs after the kind migration it rebuilds on', () => {
    expect(UPSTREAM_MIGRATION).toBeDefined();
    expect(KIND_MIGRATION).toBeDefined();
    expect(MIGRATIONS.indexOf(migration())).toBeGreaterThan(
      MIGRATIONS.indexOf(KIND_MIGRATION as (typeof MIGRATIONS)[number]),
    );
    // No contiguity check here: test/platform/migration-ordinals.test.mjs guards the folder, and a
    // fork with two applied files on one ordinal (Insights' 0002s, which may never be renamed)
    // could never pass one (P1 two-stage dry run). The ORDER above is what this test needs.
  });

  // Non-vacuous: the database really is pre-C15, so everything below is a real upgrade.
  it('before it, the ledger refuses an upstream row', async () => {
    await expect(insertRow()).rejects.toThrow(/CHECK/);
    expect(await allRows()).toEqual(before);
  });

  it('applies through the harness and keeps every row, byte for byte', async () => {
    // The pending 0005, under its real name, in ONE batch with its bookkeeping row — the way
    // wrangler sends a migration file.
    await applySchemaWith(MIGRATIONS);
    const applied = await env.DB.prepare('SELECT name FROM d1_test_migrations WHERE name = ?')
      .bind(migration().name)
      .first<{ name: string }>();
    expect(applied?.name).toBe(migration().name);
    expect(await allRows()).toEqual(before);
    // `kind` is COPIED, not re-derived: a d1 row stays d1, an aurora row stays aurora, and an
    // attempted row stays attempted.
    const byId = Object.fromEntries((await allRows()).map((r) => [r.id, r]));
    expect(byId['pre-4']?.kind).toBe('d1');
    expect(byId['pre-2']?.row_count).toBe(null);
  });

  it('leaves no scratch table behind', async () => {
    const scratch = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'read_log_c15'",
    ).first();
    expect(scratch).toBeNull();
  });

  it('ends with the three indexes and both triggers — the triggers as schema.sql writes them', async () => {
    expect(await liveIndexes()).toEqual([
      'idx_read_log_created',
      'idx_read_log_principal',
      'idx_read_log_source',
    ]);
    const live = await liveTriggers();
    expect(Object.keys(live)).toEqual([...TRIGGERS]);
    for (const name of TRIGGERS) {
      expect(live[name]).toBe(storedForm(triggerText(schemaSql, name)));
    }
  });

  it('now accepts the upstream stream, with the same CHECK a fresh install has', async () => {
    await assertUpstreamCheck();
  });

  it('keeps the migrated rows append-only', async () => {
    await expect(
      env.DB.prepare("UPDATE read_log SET kind = 'upstream' WHERE id = 'pre-4'").run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("UPDATE read_log SET row_count = 99 WHERE id = 'pre-1'").run(),
    ).rejects.toThrow(/append-only/);
    // The one legal UPDATE still works on a migrated attempted row.
    expect(await readLogRepo(env.DB).patchRowCount('pre-2', 0)).toBe(true);
  });

  it('is safe to run twice — a fresh install runs it over the new baseline, rows and all', async () => {
    const rowsNow = await allRows();
    await applySchemaWith([
      ...MIGRATIONS,
      { name: '9105_rerun_read_log_upstream.sql', sql: migration().sql },
    ]);
    expect(await allRows()).toEqual(rowsNow);
    const live = await liveTriggers();
    for (const name of TRIGGERS) {
      expect(live[name]).toBe(storedForm(triggerText(schemaSql, name)));
    }
  });
});

// ── 1b. RETRY SAFETY: A FIRST ATTEMPT THAT DIED PART-WAY ─────────────────────────────────────

// wrangler sends a file as one batch, so a partial run should not survive — but 0002 and 0005 are
// written to be safe even if one does: nothing drops the scratch table, and 0005's copy skips the
// ids it already copied (`WHERE id NOT IN …`) rather than ignoring every conflict.
// The file holds trigger bodies, so it is split the way SQLite reads it: line comments stripped
// (none of its string literals holds `--`), then `;` outside BEGIN … END.
function statements(sql: string): string[] {
  const cleaned = sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
  const out: string[] = [];
  const re = /\bBEGIN\b|\bEND\b|;/gi;
  let depth = 0;
  let start = 0;
  for (let m = re.exec(cleaned); m !== null; m = re.exec(cleaned)) {
    const tok = m[0].toUpperCase();
    if (tok === 'BEGIN') depth++;
    else if (tok === 'END') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const stmt = cleaned.slice(start, m.index).trim();
      if (stmt) out.push(stmt);
      start = re.lastIndex;
    }
  }
  const tail = cleaned.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

describe('0005 retry safety', () => {
  beforeAll(async () => {
    await applySchema();
    await seedDb();
  });
  afterAll(async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS read_log_c15').run();
    await applySchema();
  });

  it('a retry after a first attempt died before the DROP re-copies harmlessly and finishes', async () => {
    await insertRow({ source_class: 'internal', row_count: 1 });
    await insertRow({ kind: 'd1', source: 'notes', query_name: 'list', target: null });
    const rowsBefore = await allRows();
    const all = statements(migration().sql);
    const drop = all.findIndex((s) => /^DROP TABLE read_log$/.test(s));
    expect(drop).toBeGreaterThan(0);
    // The first attempt: scratch table created and filled, then it died.
    for (const stmt of all.slice(0, drop)) await env.DB.prepare(stmt).run();
    // The retry: the whole file.
    for (const stmt of all) await env.DB.prepare(stmt).run();
    expect(await allRows()).toEqual(rowsBefore);
    const live = await liveTriggers();
    for (const name of TRIGGERS) {
      expect(live[name]).toBe(storedForm(triggerText(schemaSql, name)));
    }
  });

  it('never drops its own scratch table — the one copy of the ledger mid-rebuild', () => {
    expect(migration().sql).not.toMatch(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?read_log_c15/i);
  });

  // `INSERT OR IGNORE` would make the copy idempotent, but IGNORE skips a row that breaks a CHECK
  // or a NOT NULL just as silently as a duplicate key — and the DROP that follows would take the
  // only copy of that row with it. The copy skips only ids it already copied, so anything else the
  // new table refuses fails the file loudly, BEFORE the drop.
  it('copies without OR IGNORE, skipping only ids already copied', () => {
    const sql = statements(migration().sql).join('\n');
    expect(sql).not.toMatch(/INSERT\s+OR\s+IGNORE/i);
    expect(sql).toMatch(
      /INSERT INTO read_log_c15[\s\S]*WHERE id NOT IN \(SELECT id FROM read_log_c15\)/,
    );
  });
});

// ── 1c. A LEDGER THE NEW TABLE WOULD REFUSE: LOUD, NEVER LOSSY ──────────────────────────────

describe('0005 on a hand-altered read_log', () => {
  afterAll(async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS read_log_c15').run();
    await env.DB.prepare('DROP TABLE IF EXISTS read_log').run();
    await applySchema();
  });

  // A fork that loosened its read_log by hand (no table-level CHECK) can hold a row no kit-shaped
  // ledger can: here an aurora read that names no view. The rebuilt table refuses it, and the only
  // acceptable outcome is a migration that FAILS with the row still in read_log — never one that
  // succeeds without it.
  it('stops on the copy, before the DROP, with every row still in read_log', async () => {
    await applySchema();
    await seedDb();
    await env.DB.prepare('DROP TABLE read_log').run();
    await env.DB.prepare(
      `CREATE TABLE read_log (
         id TEXT PRIMARY KEY, request_id TEXT NOT NULL, principal TEXT NOT NULL, app TEXT NOT NULL,
         env TEXT NOT NULL, route TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'aurora',
         source TEXT NOT NULL, source_class TEXT NOT NULL, view TEXT, query_name TEXT, target TEXT,
         row_count INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
    await insertRow({ kind: 'd1', source: 'notes', query_name: 'list', target: null });
    await insertRow({ kind: 'aurora', source: 'c360_ro', view: null, query_name: 'listAccounts' });
    const rowsBefore = await allRows();
    expect(rowsBefore).toHaveLength(2);

    const all = statements(migration().sql);
    let failedAt = -1;
    for (const [i, stmt] of all.entries()) {
      try {
        await env.DB.prepare(stmt).run();
      } catch {
        failedAt = i;
        break;
      }
    }
    const drop = all.findIndex((s) => /^DROP TABLE read_log$/.test(s));
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(failedAt).toBeLessThan(drop);
    expect(all[failedAt]).toMatch(/^INSERT INTO read_log_c15/);
    expect(await allRows()).toEqual(rowsBefore);
  });
});

// ── 2. THE TRIGGERS, VERBATIM ───────────────────────────────────────────────────────────────

describe('read_log triggers are recreated VERBATIM', () => {
  beforeAll(applySchema);

  // The rebuild drops the triggers with the table. A reinstatement that drifted by one column
  // would leave an upgraded app's ledger rewritable in a way a fresh install's is not — and
  // nothing but this comparison would ever notice.
  it.each(TRIGGERS)('%s is the same text in schema.sql, 0002 and 0005', (name) => {
    const baseline = triggerText(schemaSql, name);
    expect(triggerText(migration().sql, name)).toBe(baseline);
    expect(triggerText((KIND_MIGRATION as { sql: string }).sql, name)).toBe(baseline);
  });

  it('what the live database stores is exactly that text', async () => {
    const live = await liveTriggers();
    expect(Object.keys(live)).toEqual([...TRIGGERS]);
    for (const name of TRIGGERS) {
      expect(live[name]).toBe(storedForm(triggerText(schemaSql, name)));
    }
  });

  it('the count-patch trigger still names every column, `kind` included', () => {
    const body = triggerText(migration().sql, 'read_log_count_patch_only');
    for (const column of [
      'id',
      'request_id',
      'principal',
      'app',
      'env',
      'route',
      'kind',
      'source',
      'source_class',
      'view',
      'query_name',
      'target',
      'created_at',
    ]) {
      expect(body).toContain(`NEW.${column} IS NOT OLD.${column}`);
    }
  });
});

// ── 3. THE UPSTREAM STREAM'S CHECK, ON A FRESH INSTALL ──────────────────────────────────────

/**
 * Every CHECK (…) in the CREATE TABLE statement for `table`, comments stripped and whitespace
 * collapsed — so the baseline and the migration can be compared constraint by constraint, whatever
 * their comments and line breaks.
 */
function checksOf(sql: string, table: string): string[] {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start === -1) throw new Error(`no CREATE TABLE ${table}`);
  const body = sql
    .slice(start, sql.indexOf('\n);', start))
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')');
  const out: string[] = [];
  for (let at = body.indexOf('CHECK ('); at !== -1; at = body.indexOf('CHECK (', at + 1)) {
    let depth = 0;
    let end = at + 'CHECK '.length;
    for (; end < body.length; end++) {
      if (body[end] === '(') depth++;
      else if (body[end] === ')' && --depth === 0) break;
    }
    out.push(body.slice(at, end + 1));
  }
  return out;
}

describe('the upstream stream on a fresh install', () => {
  beforeAll(applySchema);

  // The harness applies the baseline and THEN every migration, so the behavioural tests below
  // exercise what 0005 leaves. This is the other half: the baseline a fresh provision starts from
  // declares the very same constraints, so a fix made in one file and not the other is red.
  it('schema.sql and 0005 declare the same four CHECKs', () => {
    const baseline = checksOf(schemaSql, 'read_log');
    expect(baseline).toHaveLength(4);
    expect(checksOf(migration().sql, 'read_log_c15')).toEqual(baseline);
    expect(baseline).toContain("CHECK (kind IN ('aurora', 'd1', 'upstream'))");
    expect(baseline).toContain(
      "CHECK (kind IN ('d1', 'upstream') OR (view IS NOT NULL AND query_name IS NOT NULL))",
    );
  });

  it('has the same columns the ledger always had — no column was added for it', async () => {
    expect((await columns()).map((c) => c.name)).toEqual([
      'id',
      'request_id',
      'principal',
      'app',
      'env',
      'route',
      'kind',
      'source',
      'source_class',
      'view',
      'query_name',
      'target',
      'row_count',
      'created_at',
    ]);
  });

  it('accepts an upstream row keyed by a NAME and refuses one keyed by a VALUE', async () => {
    await seedDb();
    await assertUpstreamCheck();
  });

  it('an upstream row is append-only like every other: its stream, source and target are fixed', async () => {
    await seedDb();
    const id = await insertRow({ row_count: null });
    for (const sql of [
      "UPDATE read_log SET kind = 'd1' WHERE id = ?",
      "UPDATE read_log SET source = 'someone_else' WHERE id = ?",
      "UPDATE read_log SET target = 'duns' WHERE id = ?",
      "UPDATE read_log SET query_name = 'another_read' WHERE id = ?",
      "UPDATE read_log SET source_class = 'internal' WHERE id = ?",
    ]) {
      await expect(env.DB.prepare(sql).bind(id).run()).rejects.toThrow(/append-only/);
    }
    expect(await readLogRepo(env.DB).patchRowCount(id, 2)).toBe(true);
    await expect(
      env.DB.prepare('UPDATE read_log SET row_count = 3 WHERE id = ?').bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(insertRow({ id })).rejects.toThrow(/never overwritten/);
  });

  it('the repository writes and reads an upstream row like any other', async () => {
    await seedDb();
    const repo = readLogRepo(env.DB);
    await repo.insertIntent({
      id: 'repo-1',
      request_id: 'req-9',
      principal: USERS.admin,
      app: 'test-app',
      env: 'test',
      route: 'GET /api/reports/by-duns/:duns',
      kind: 'upstream',
      source: 'autobahn',
      source_class: 'client',
      view: null,
      query_name: 'report_by_duns',
      target: 'duns',
    });
    const [row] = await repo.listByRequest('req-9');
    expect(row).toMatchObject({ kind: 'upstream', source: 'autobahn', target: 'duns' });
    expect(row?.row_count).toBe(null);
    expect((await repo.listAttempted(10)).map((r) => r.id)).toEqual(['repo-1']);
  });
});
