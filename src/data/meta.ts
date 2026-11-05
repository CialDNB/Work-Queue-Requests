// The app's own SCHEMA self-description — which migrations this database has applied, and a
// fingerprint of the DDL it actually has (Fleet Ledger K1). Both are read out of tables nobody
// else in the kit owns: `d1_migrations`, which **wrangler** creates and writes, and
// `sqlite_master`, which SQLite maintains. They live behind a repository for one reason — the
// data fence. `env.DB` may only be touched inside src/data/, so "ask the database what shape it
// is in" needs a home here, not a `prepare()` in a cron.
//
// ── WHY BOTH NUMBERS, AND WHY THEY ARE NOT THE SAME NUMBER ────────────────────────────────
// `appliedMigrations()` is the list of migration FILES this database has run. `schemaHash()` is
// the shape the database is ACTUALLY in. The registry compares them across days, and the gap
// between them is the whole point: a hash that moves while the migration list stands still is
// DDL that ran without a migration file — a hand-run ALTER, a console edit, a `wrangler d1
// execute`. That is the drift signal. Reporting only the migration list would make exactly the
// unreviewed change invisible.
// ──────────────────────────────────────────────────────────────────────────────────────────
//
// NEITHER FUNCTION THROWS. The daily registry report is best-effort by contract (see
// src/cron/reportToRegistry.ts) and runs LAST in the ops loop; a database that cannot answer
// "which migrations have you applied" must degrade to a quieter report, never to a failed cron
// that pages the owner. `d1_migrations` is genuinely ABSENT on a freshly provisioned app (it is
// created by the first `wrangler d1 migrations apply`) and in the in-memory test runtime, so
// "no such table" is the NORMAL case here, not an error — it reports as `[]`, which is the true
// answer: no migrations have been applied.
//
// `triggers()` is the ONE reader here that DOES throw, and on purpose. It backs the daily
// append-only trigger check (src/cron/appendOnlyTriggers.ts), which PAGES: a read that cannot
// list the triggers has not shown that the WORM guarantee holds, so it must fail the task rather
// than quietly report "none missing". The failure direction is the opposite of the report's.
import { sha256Hex } from '../auth/tokens';
import { logEvent } from '../platform/logEvent';

// The registry's own limits on the fields these rows become. Clamped here rather than trusted:
// over either one, the ENTIRE daily report is refused, not just the migrations block.
const MAX_MIGRATION_NAME_LEN = 200;
const MAX_APPLIED_AT_LEN = 64;

/** One row of wrangler's own migration bookkeeping. Names are file names — never SQL. */
export interface AppliedMigration {
  name: string;
  /** wrangler's CURRENT_TIMESTAMP string, or null if the column is empty on this row. */
  applied_at: string | null;
}

/**
 * Objects excluded from the schema fingerprint, as a SQL predicate.
 *
 * - `sqlite_%` — SQLite's own internal objects (`sqlite_sequence`, autoindexes). `sqlite_sequence`
 *   in particular is created lazily the first time an AUTOINCREMENT table takes a row, so
 *   including it would make the hash move on the app's first write rather than on a DDL change.
 * - `_cf_%` — D1's platform bookkeeping tables, which Cloudflare may add or reshape under us.
 * - `d1_migrations` — excluded ON PURPOSE, and this is the load-bearing exclusion: applying a
 *   migration inserts a row into it but does not change its DDL, so leaving it in would not
 *   break the hash... until wrangler changes that table's shape, at which point every app in
 *   the fleet would report schema drift on the same day for a table that is not theirs.
 */
const SCHEMA_EXCLUSIONS =
  "name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'";

/**
 * Collapse every run of whitespace — the newlines and indentation SQLite stores verbatim from
 * whatever text created the object — to one space, and trim. `schema.sql` is a formatted,
 * heavily commented file, so without this a reflow of the checked-in DDL would move the
 * fingerprint on the next fresh provision without a single column changing.
 *
 * What this is NOT is a SQL-equivalence normalizer, and the scope of the claim matters: the
 * registry only ever compares an app's hash against THAT APP'S previous hash, never against
 * another app's. So the bar is "the same database, unchanged, fingerprints the same tomorrow" —
 * not "two databases with equivalent schemas agree". Trying for the second would mean parsing
 * SQL, and a parser that got it subtly wrong would hide real drift, which is the one failure
 * this must not have.
 *
 * Case is deliberately NOT folded either: `CREATE TABLE notes` and `create table NOTES` are the
 * same table to SQLite, but a change from one to the other is a real edit to the checked-in DDL,
 * and noticing edits is this fingerprint's entire job.
 */
function normalizeDdl(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export function metaRepo(db: D1Database) {
  return {
    /**
     * Every migration wrangler has applied to THIS database, oldest first.
     *
     * Returns `[]` — never throws, never null — when `d1_migrations` does not exist. That is a
     * fresh provision (nothing has been migrated yet) and it is also every test run, since the
     * in-memory runtime applies `schema.sql` directly and never invokes wrangler's migration
     * machinery. An empty list is SAFE against the registry's diff engine, which only records a
     * change for migration names it has never seen: a report that lists nothing can add nothing,
     * so a degraded read can never fabricate a migration event.
     */
    async appliedMigrations(): Promise<AppliedMigration[]> {
      try {
        const res = await db
          .prepare('SELECT name, applied_at FROM d1_migrations ORDER BY id ASC')
          .all<{ name: string; applied_at: string | null }>();
        return (
          (res.results ?? [])
            // `d1_migrations` is WRANGLER'S table, not the kit's: `name` is `TEXT UNIQUE` with no
            // NOT NULL, nothing in this repo constrains its shape, and a future wrangler may change
            // it. A row with a null or empty name (a hand-repaired ledger, an interrupted apply)
            // would otherwise reach the wire as `{ name: null }` and fail the registry's
            // `z.string().min(1).max(200)` — which 400s the WHOLE report, status and manifest
            // included, every day until a human noticed. A reader that promises never to throw
            // must also never emit something the wire rejects, so unusable rows are dropped and
            // the survivors are clamped to the same 200/64 limits the registry publishes.
            .filter((r): r is { name: string; applied_at: string | null } =>
              Boolean(typeof r.name === 'string' && r.name.length > 0),
            )
            .map((r) => ({
              name: r.name.slice(0, MAX_MIGRATION_NAME_LEN),
              applied_at:
                typeof r.applied_at === 'string' && r.applied_at.length > 0
                  ? r.applied_at.slice(0, MAX_APPLIED_AT_LEN)
                  : null,
            }))
        );
      } catch (err) {
        // Expected and unremarkable on a fresh provision / in tests. Logged rather than silent so
        // a real failure on a long-lived database is still findable in Workers Logs (the event and
        // its error class — never the message, PIA C5).
        logEvent('meta_applied_migrations_unavailable', { err });
        return [];
      }
    },

    /**
     * A stable fingerprint of this database's own DDL — sha256 over every user object's
     * normalized `CREATE …` text, ordered by (type, name) so the hash is independent of the
     * order objects happened to be created in.
     *
     * `sql IS NULL` rows are skipped: SQLite stores implicitly-created indexes (the ones backing
     * a UNIQUE or PRIMARY KEY constraint) with a null `sql`, and they carry no information the
     * owning table's own DDL does not already carry.
     *
     * Returns null — never throws — when the read fails, so the caller omits the field rather
     * than reporting a fingerprint it did not compute. A null hash suppresses drift detection
     * for that day (the registry compares two non-null hashes), which is the correct failure
     * direction: a missed drift signal costs a day, a fabricated one costs a page.
     */
    async schemaHash(): Promise<string | null> {
      try {
        const res = await db
          .prepare(
            `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND ${SCHEMA_EXCLUSIONS} ORDER BY type ASC, name ASC`,
          )
          .all<{ type: string; name: string; sql: string }>();
        const canonical = (res.results ?? [])
          .map((o) => `${o.type}:${o.name}:${normalizeDdl(o.sql)}`)
          .join('\n');
        return await sha256Hex(canonical);
      } catch (err) {
        logEvent('meta_schema_hash_unavailable', { err });
        return null;
      }
    },

    /**
     * Every trigger in the live database, as (name, table, stored definition) from
     * `sqlite_master`, sorted by name. READ-ONLY: one SELECT, nothing written, no DDL.
     *
     * The table matters as much as the name: SQLite trigger names are unique per schema, not per
     * table, so a trigger called `audit_log_no_delete` that sits on some other table protects
     * nothing, and a name-only check would pass it. The stored `sql` matters too: a same-named
     * trigger on the right table can have been recreated to do nothing. Names and tables come
     * back exactly as typed (SQLite keeps their case); the caller compares case-insensitively.
     *
     * THROWS when the read fails (see the file header): its caller pages on a missing trigger, and
     * a list it could not read is not evidence that none are missing.
     */
    async triggers(): Promise<Array<{ name: string; table: string; sql: string }>> {
      const res = await db
        .prepare(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name ASC",
        )
        .all<{ name: string; tbl_name: string; sql: string | null }>();
      // A trigger always has its CREATE text; an empty one would fail the shape check and page.
      return (res.results ?? []).map((r) => ({
        name: r.name,
        table: r.tbl_name,
        sql: r.sql ?? '',
      }));
    },
  };
}

/**
 * Fingerprint of the applied-migration NAME LIST. Pure (no I/O), so it lives beside the repo
 * rather than inside it. The registry stores this next to `count`, which lets it tell "the same
 * 12 migrations" from "12 migrations, one of them renamed" — a rename keeps the count identical
 * and is otherwise invisible.
 *
 * Sorted before hashing: `app_migrations` is a keyed union on the registry side, so two apps
 * that applied the same set in a different order ARE at the same schema version and must
 * fingerprint the same.
 */
export function migrationNamesHash(names: readonly string[]): Promise<string> {
  return sha256Hex([...names].sort().join('\n'));
}
