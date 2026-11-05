// Shared test fixtures. ALL fixture identities are synthetic — that is a kit-wide hard rule.
//
// STORAGE IS PER FILE. vitest-pool-workers gives each test FILE its own D1/KV/R2, and state
// persists across the tests inside it: apply the schema in beforeAll, seed in beforeEach. seedDb
// resets rows (and KV) between tests; it never hands a test a fresh database.
//
// BASELINE ON EVERY CALL, MIGRATIONS ONCE PER DATABASE — the split a deployed database has.
// `schema.sql` is the frozen baseline and all IF NOT EXISTS, so applySchema() re-runs it on every
// call. migrations/d1/*.sql are applied the way `wrangler d1 migrations apply` applies them: in
// ordinal order, each exactly once per database, recorded by name in a bookkeeping table the reset
// never touches. That is what lets a migration be a plain `ALTER TABLE … ADD COLUMN` (one-shot in
// SQLite): a helper that replays every migration on every seedDb() throws "duplicate column name"
// on the second test of the file — which is what a fork hits the day it adds one.
//
// The bookkeeping lives in the database it describes, so the record and the schema it records are
// created, kept and discarded together — a module-level "already migrated" flag could outlive, or
// predate, the storage it claims to describe. It is `d1_test_migrations`, NOT wrangler's
// `d1_migrations`: same shape, but `d1_migrations` belongs to the app under test
// (src/data/meta.ts reports it to the registry) and its tests create, fill and drop it
// themselves. The `d1_` prefix keeps both harness tables out of the backup export, like
// wrangler's own (src/data/backup.ts SKIP_PREFIXES).
//
// THE MIGRATED SHAPE IS THE TRUTH ONCE A MIGRATION HAS RUN. The migration run snapshots the
// resulting DDL (tables, indexes, views, triggers) into `d1_test_shape` — also when a later file in
// the same run fails, since the files before it stay applied — and every later call reads it both
// ways:
//   - What the database LACKS is rebuilt from the snapshot, before the baseline runs. seedDb()
//     drops the WORM tables on every call and some tests drop a table to fake an outage; rebuilt
//     from schema.sql instead, such a table would silently lose a migration's column, index or
//     trigger — and the migration, already recorded, would never run again.
//   - What the snapshot LACKS, the baseline does not create. A migration that DROPs or RENAMEs an
//     object schema.sql creates would otherwise see it reappear on the next call, and a statement
//     the baseline runs against a dropped column (an index on it) would throw. A RENAMEd table
//     keeps its indexes and triggers under their own names, so the snapshot still holds them while
//     the baseline's CREATE INDEX / CREATE TRIGGER still says `ON <old name>` — and SQLite resolves
//     that table before it reads IF NOT EXISTS, so it too would throw. The baseline therefore also
//     skips an index or trigger whose ON-table the snapshot lacks. It skips such statements rather
//     than creating and then dropping the object, so nothing is ever dropped by name, and a table
//     a test makes for itself is never touched.
//
// ONE ORDERED BATCH PER PHASE. The shape restore, the baseline, the WORM drops and the row reset
// each go to D1 as one `batch` (runInOrder): the same statements, in the same order, on every
// call, in one transaction per phase instead of one round trip per statement. Batching changes
// how often the harness crosses into D1, not what runs or when. A phase that fails part-way
// leaves none of itself behind, as a migration file already does, and the call throws as before.
//
// The reference below is Vite's `import.meta.glob` typing, for the migration discovery. Vite ships
// that entry point for userland on purpose: a `types` reference to its importMeta.d.ts directly
// does not resolve (TypeScript issue 45096, per the note inside the file). It sits in this file,
// not in test/sql.d.ts, so a fork that takes this file on /kit-upgrade takes its typing with it.
/// <reference types="vite/types/import-meta.d.ts" />
import { env } from 'cloudflare:test';
import schemaSql from '../../schema.sql?raw';

export interface Migration {
  /** The file name — the key wrangler records it under. */
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS_TABLE = 'd1_test_migrations';
const SHAPE_TABLE = 'd1_test_shape';

// wrangler's order (compareMigrationPaths): the leading number, then the name. Identical to a plain
// sort while ordinals stay unique and 4-digit, which test/platform/migration-ordinals.test.mjs pins.
function byOrdinal(a: Migration, b: Migration): number {
  const diff = Number.parseInt(a.name, 10) - Number.parseInt(b.name, 10);
  if (diff) return diff;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// Every migrations/d1/*.sql, discovered when Vite transforms this file — adding a migration needs no
// edit here. `*.sql` is wrangler's own default pattern, so README.md is skipped by both.
const migrationFiles = import.meta.glob<string>('../../migrations/d1/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const MIGRATIONS: readonly Migration[] = Object.entries(migrationFiles)
  .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf('/') + 1), sql }))
  .sort(byOrdinal);

/**
 * The one migration whose name, minus its ordinal, is `slug` (`'api_token_scopes.sql'`). A test of
 * a KIT migration finds it this way, never by importing `0003_…` by path: a fork copies each kit
 * migration to its OWN next free ordinal (scripts/check-kit-migrations.mjs names the file to copy
 * it to, keeping the slug), and the kit's tests ride /kit-upgrade into that fork. Throws unless
 * exactly one migration carries the slug.
 */
export function migrationBySlug(
  slug: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Migration {
  const found = migrations.filter((m) => m.name.replace(/^\d+_/, '') === slug);
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    throw new Error(
      `expected exactly one migrations/d1/<NNNN>_${slug}, found ${found.length}` +
        (found.length ? ` (${found.map((m) => m.name).join(', ')})` : '') +
        ' — `node scripts/check-kit-migrations.mjs` names the kit migrations this app must hold.',
    );
  }
  return only;
}

const TABLES = [
  // The agent transcript store (migrations/d1/0006_agent_tables.sql), CHILDREN FIRST: foreign keys
  // are enforced and `agent_threads` is the one parent. None carries a no-DELETE trigger, so a plain
  // DELETE resets each and none is a WORM table. A fork merges these six into its own list (trap T1).
  'agent_instance_purges',
  'agent_feedback',
  'agent_approvals',
  'agent_messages',
  'agent_turns',
  'agent_threads',
  'group_members',
  'groups',
  'magic_links',
  'api_tokens',
  // Its triggers refuse DELETE (rows are never deleted — schema.sql), so it is reset like the
  // WORM tables below: dropped and recreated.
  'service_identities',
  'audit_log',
  'ai_usage',
  'ai_budget_reservations',
  // read_log is NOT a WORM table: its triggers allow the one-shot row_count patch, and DELETE
  // stays legal because retention (READ_LOG_RETENTION_DAYS) is a deletion promise the daily prune
  // keeps. So a plain DELETE resets it, unlike audit_log / ai_usage below.
  'read_log',
  'notes',
  'users',
];

// audit_log + ai_usage carry WORM triggers (schema.sql) that reject UPDATE/DELETE, and
// service_identities one that rejects DELETE, so seedDb cannot reset them with DELETE — it drops
// them, and applySchema recreates them. Every table whose triggers refuse DELETE goes HERE; the
// row reset skips these wherever they sit in TABLES, so listing one there too is fine. Listed in
// TABLES alone, it makes every seedDb() throw once a test has written a row to it.
const WORM_TABLES = ['audit_log', 'ai_usage', 'service_identities'];

// A quoted string or identifier, in the forms both SQLite and wrangler's local splitter skip whole:
// 'string', "identifier" and `identifier` (MySQL style), each escaping its quote by doubling it.
// Whatever is inside one is text, never a comment, a keyword or a separator.
//
// NOT [identifier], on purpose. SQLite accepts it, but `wrangler d1 migrations apply --local`
// (`npm run db:migrate:local`; wrangler 4.124's splitSqlIntoStatements) does not skip it: it cuts
// the statement at a ';' inside the brackets and drops the rest of the line from a '--' or '/*'
// inside them. The harness reads a bracket the same way, so a migration the local apply would cut
// apart fails here in CI too. Name such an identifier in "double quotes" or `backticks` instead.
const QUOTED = [`'[^']*(?:''[^']*)*'`, `"[^"]*(?:""[^"]*)*"`, '`[^`]*(?:``[^`]*)*`'].join('|');

/** A token the scan matched as QUOTED: it opens with one of the three quote characters. */
function isQuoted(token: string): boolean {
  return /^['"`]/.test(token);
}

// Split SQL into statements on ';', but keep `CREATE TRIGGER ... BEGIN ... END;` bodies intact: a
// ';' inside a BEGIN/END block is part of the trigger, not a separator. CASE opens a block too, or
// the END that closes a `CASE WHEN … END` in a trigger body would close the trigger instead.
// Every migrations/d1 file comes through here, so it must read what wrangler would apply.
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  const re = new RegExp(String.raw`${QUOTED}|\bBEGIN\b|\bCASE\b|\bEND\b|;`, 'gi');
  let depth = 0;
  let start = 0;
  let m = re.exec(sql);
  while (m !== null) {
    const tok = m[0].toUpperCase();
    if (isQuoted(tok)) {
      // quoted text: skipped whole
    } else if (tok === 'BEGIN' || tok === 'CASE') {
      depth++;
    } else if (tok === 'END') {
      if (depth > 0) depth--;
    } else if (depth === 0) {
      const stmt = sql.slice(start, m.index).trim();
      if (stmt) statements.push(stmt);
      start = re.lastIndex;
    }
    m = re.exec(sql);
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

// Blank `--` and `/* */` comments BEFORE splitting (they may hold ';', BEGIN, CASE or END). One
// left-to-right scan, as SQLite's tokenizer reads it: whichever of a quote, `--` or `/*` opens
// first wins, so a `/*` inside a line comment opens nothing, and a `--` or `/*` inside quotes is
// text. An unterminated block comment runs to the end of the input, as it does in SQLite.
const QUOTED_OR_COMMENT = new RegExp(String.raw`${QUOTED}|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`, 'g');

function stripComments(sql: string): string {
  return sql.replace(QUOTED_OR_COMMENT, (m) => (isQuoted(m) ? m : ' '));
}

/**
 * A SQL file as the statements the harness sends — comments blanked, split on `;` outside quotes
 * and BEGIN … END — exactly what applySchema() runs for schema.sql and for each migration. Exported
 * so a migration test can run a kit migration by hand on a database the harness built, and compare
 * what SQLite stores against what the baseline stores, character for character.
 */
export function statementsOf(sql: string): string[] {
  return splitSqlStatements(stripComments(sql));
}

/** `type:name`, lowercased — SQLite names are case-insensitive. */
function objectKey(type: string, name: string): string {
  return `${type.toLowerCase()}:${name.toLowerCase()}`;
}

// The object a baseline statement creates (`CREATE [UNIQUE] TABLE|INDEX|VIEW|TRIGGER [IF NOT
// EXISTS] name`) or the table it seeds (`INSERT [OR …] INTO name`) — the only two kinds of
// statement schema.sql holds. Anything else yields null and always runs. It (and ON_TABLE below)
// tolerates an opening quote of any identifier form, then reads the name as word characters only:
// enough for schema.sql, whose names are all plain words. A quoted name with a space or other
// punctuation in it would be keyed by its first word, so keep schema.sql's names plain.
const BASELINE_TARGET =
  /^(?:CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?|INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO\s+)["`[]?(\w+)/i;

// The table an index or trigger is attached to: the first `ON name` after the object's own name
// (SQLite allows no schema prefix there). For a trigger, only the part before BEGIN is read, so
// nothing in its body — or its WHEN clause, which follows ON — can be mistaken for it.
const ON_TABLE = /\bON\s+["`[]?(\w+)/i;

interface BaselineTarget {
  /** The object the statement creates or seeds. */
  readonly key: string;
  /** For an index or trigger, the table it attaches to; null otherwise. */
  readonly onTable: string | null;
}

function baselineTarget(statement: string): BaselineTarget | null {
  const m = BASELINE_TARGET.exec(statement);
  if (!m?.[2]) return null;
  const type = (m[1] ?? 'table').toLowerCase();
  let onTable: string | null = null;
  if (type === 'index' || type === 'trigger') {
    const rest = statement.slice(m[0].length);
    const head = type === 'trigger' ? rest.split(/\bBEGIN\b/i, 1)[0] : rest;
    const on = ON_TABLE.exec(head ?? '');
    if (on?.[1]) onTable = objectKey('table', on[1]);
  }
  return { key: objectKey(type, m[2]), onTable };
}

// Sends one phase as ONE D1 batch: in the order given, in one transaction. D1 refuses an empty
// batch ("No SQL statements detected"), so a phase with nothing to do sends nothing.
async function runInOrder(statements: readonly string[]): Promise<void> {
  if (statements.length === 0) return;
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
}

async function tableExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(name)
    .first();
  return row !== null;
}

// Applies each migration this database has not recorded yet, in the order given, then snapshots the
// shape they leave. The file and its bookkeeping row go in ONE batch — one transaction, the way
// wrangler sends a file together with its INSERT — so a migration that fails part-way leaves
// nothing behind and is not recorded. The files before it in the same call are committed and
// recorded, though, and will never run again: the snapshot is taken in `finally`, or the next call
// would rebuild from a shape that predates them and silently undo them.
async function applyPendingMigrations(migrations: readonly Migration[]): Promise<void> {
  // wrangler's d1_migrations DDL, verbatim, under the harness's own name (see the header).
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT UNIQUE,
       applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ).run();
  const recorded = await env.DB.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all<{
    name: string;
  }>();
  const applied = new Set(recorded.results.map((r) => r.name));
  let count = 0;
  try {
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      await env.DB.batch([
        ...statementsOf(migration.sql).map((statement) => env.DB.prepare(statement)),
        env.DB.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`).bind(migration.name),
      ]);
      count++;
    }
  } finally {
    if (count > 0) await snapshotMigratedShape();
  }
}

// The DDL of every app object as the migrations left it. SQLite keeps sqlite_master's text current
// through ALTER TABLE, so an added (or dropped) column is in it, and a renamed table is under its
// new name. Excluded: SQLite's own tables, D1's `_cf_*`, and every `d1_*` bookkeeping table (the
// harness's, and wrangler's, which tests create and drop on purpose and must not see resurrected).
async function snapshotMigratedShape(): Promise<void> {
  await env.DB.prepare(`DROP TABLE IF EXISTS ${SHAPE_TABLE}`).run();
  await env.DB.prepare(
    `CREATE TABLE ${SHAPE_TABLE} AS
     SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE type IN ('table', 'index', 'view', 'trigger') AND sql IS NOT NULL
       AND tbl_name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       AND tbl_name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       AND tbl_name NOT LIKE 'd1\\_%' ESCAPE '\\'`,
  ).run();
}

interface ShapeObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

/** The snapshot, in the order it can be rebuilt; null until the first migration run takes one. */
async function readMigratedShape(): Promise<readonly ShapeObject[] | null> {
  if (!(await tableExists(SHAPE_TABLE))) return null;
  const rows = await env.DB.prepare(
    `SELECT type, name, sql FROM ${SHAPE_TABLE}
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`,
  ).all<ShapeObject>();
  return rows.results;
}

// Rebuilds every snapshotted object that is missing now — tables first, then the indexes, views and
// triggers (DROP TABLE takes a table's indexes and triggers with it). One batch commits all or
// nothing: after a test drops an FTS5 table, whose shadow tables the snapshot also holds (the known
// limit in migrations/d1/README.md), every later call in that file fails, not just the next one.
async function restoreMigratedShape(shape: readonly ShapeObject[]): Promise<void> {
  const present = await env.DB.prepare('SELECT type, name FROM sqlite_master').all<{
    type: string;
    name: string;
  }>();
  const have = new Set(present.results.map((r) => objectKey(r.type, r.name)));
  await runInOrder(
    shape
      .filter((object) => !have.has(objectKey(object.type, object.name)))
      .map((object) => object.sql),
  );
}

// schema.sql, minus every statement that would create — or seed — an object the migrated shape no
// longer has (a migration removed it), or an index or trigger on a table it no longer has (a
// migration renamed or dropped that table). Before the first snapshot, the whole baseline runs.
async function applyBaseline(shape: readonly ShapeObject[] | null): Promise<void> {
  const kept = shape ? new Set(shape.map((o) => objectKey(o.type, o.name))) : null;
  // Every call, in schema.sql's order: batching changes the round trips, not the schema's lifetime.
  await runInOrder(
    statementsOf(schemaSql).filter((statement) => {
      const target = baselineTarget(statement);
      if (!kept || !target) return true;
      return kept.has(target.key) && (target.onTable === null || kept.has(target.onTable));
    }),
  );
}

/**
 * applySchema() with an explicit migration list. Only the harness's own tests pass one (to push a
 * synthetic migration through the real apply path); everything else uses applySchema().
 */
export async function applySchemaWith(migrations: readonly Migration[]): Promise<void> {
  const shape = await readMigratedShape();
  if (shape) await restoreMigratedShape(shape);
  await applyBaseline(shape);
  await applyPendingMigrations(migrations);
}

// No parameters on purpose: `beforeAll(applySchema)` / `beforeEach(seedDb)` hand the hook's
// suite / context object to whatever the function's first parameter is.
export function applySchema(): Promise<void> {
  return applySchemaWith(MIGRATIONS);
}

export const USERS = {
  owner: 'owner@test.example',
  admin: 'admin@test.example',
  member: 'alice@test.example',
  viewer: 'vera@test.example',
} as const;

/** seedDb() with an explicit migration list — harness tests only, as for applySchemaWith(). */
export async function seedDbWith(migrations: readonly Migration[]): Promise<void> {
  // WORM tables reject DELETE (append-only triggers) — reset them by drop + recreate;
  // applySchema rebuilds them in their migrated shape, indexes and triggers included.
  await runInOrder(WORM_TABLES.map((table) => `DROP TABLE IF EXISTS ${table}`));
  await applySchemaWith(migrations);
  // In TABLES' order, children before parents: foreign keys are checked statement by statement
  // inside the batch, as they were outside it.
  await runInOrder(
    TABLES.filter((table) => !WORM_TABLES.includes(table)).map((table) => `DELETE FROM ${table}`),
  );
  // Storage is isolated per FILE, not per test — clear cross-test KV state
  // (rate-limit windows, revocations, heartbeats) so tests stay independent.
  for (const prefix of ['rl:', 'revoked-sessions:', 'heartbeat:', 'health:']) {
    const listed = await env.SESSIONS.list({ prefix });
    for (const key of listed.keys) {
      await env.SESSIONS.delete(key.name);
    }
  }
  const insert = env.DB.prepare(
    'INSERT INTO users (email, name, role, added_by) VALUES (?, ?, ?, ?)',
  );
  await env.DB.batch([
    insert.bind(USERS.owner, 'Owen Owner', 'owner', 'seed@test.example'),
    insert.bind(USERS.admin, 'Ada Admin', 'admin', 'seed@test.example'),
    insert.bind(USERS.member, 'Alice Member', 'member', 'seed@test.example'),
    insert.bind(USERS.viewer, 'Vera Viewer', 'viewer', 'seed@test.example'),
  ]);
}

export function seedDb(): Promise<void> {
  return seedDbWith(MIGRATIONS);
}
