// Daily check that the append-only (WORM) triggers still exist in the LIVE database.
//
// `audit_log` and `ai_usage` are append-only at the database layer: schema.sql puts six BEFORE
// UPDATE / DELETE / INSERT-collision triggers on them, so "append-only" holds even against a holder
// of D1 credentials (DECISIONS 2026-06-23). Until this task, only the TEST database proved those
// triggers were there (test/data/audit-append-only.test.ts). A `DROP TRIGGER` against a real
// database, whether a hand-run exception that forgot to recreate it, a console edit or a botched
// restore, would switch the guarantee off with no signal at all: every write still succeeds,
// nothing errors, and the audit trail is quietly editable from then on.
//
// This task reads `sqlite_master` once and PAGES (throws, so the ops loop routes it to sendAlert
// like restore_verify) when any of the six is missing, sits on the wrong table, or has been
// altered. It is READ-ONLY: it never drops, creates or repairs a trigger. Putting one back is a
// person's job, using the verbatim `CREATE TRIGGER IF NOT EXISTS` text from schema.sql, because
// recreating a security control is exactly the kind of change that needs a human and a record.
//
// Why the cron and not /_health: /_health is public and unauthenticated. Announcing to the
// internet that this app's audit log is currently writable is the wrong failure mode. The page
// goes to the owner; the per-task result is kept in the `cron_heartbeat_done` audit row.
//
// "Altered" is a STRUCTURAL comparison, not a text match. A trigger dropped and recreated under
// the same name with a harmless body (another event, a `WHEN 0`, an `UPDATE OF col` list, a RAISE
// that can never run) keeps its name and table, so a name-and-table check would read it as
// present. The registry does not catch it either: the daily schema fingerprint moves, but the
// registry only records that as a `schema_drift` row on its change timeline, and no alert rule
// watches that kind. So the stored `sql` is compared against the guard's shape after folding
// case, identifier quoting and all whitespace, and ignoring the RAISE message. Forks whose
// trigger text differs only in layout or message therefore do not page. What this still cannot
// see: a trigger dropped and put back between two daily runs, or a deliberate rewrite built to
// match this shape. For those the evidence is the backups and the registry's schema_hash history.
//
// Names and tables compare case-insensitively (ASCII only, as SQLite folds identifiers):
// `AUDIT_LOG_NO_DELETE ON AUDIT_LOG` is the same working trigger to SQLite, and schema.sql's
// `CREATE TRIGGER IF NOT EXISTS` skips it, so paging on it would be a false alarm no repair clears.
import { makeDb } from '../data';
import type { Env } from '../env';

export interface AppendOnlyTrigger {
  readonly name: string;
  readonly table: string;
  /** The one statement kind the guard fires on: `BEFORE <event> ON <table>`. */
  readonly event: 'UPDATE' | 'DELETE' | 'INSERT';
  /** The guard's WHEN condition as schema.sql writes it. Only the *_no_replace guards have one. */
  readonly when?: string;
}

/**
 * The six WORM triggers schema.sql defines on the two forensic tables, each with the table it
 * must sit on and the shape of its guard. test/cron/appendOnlyTriggers.test.ts pins this list
 * against schema.sql, so a trigger added there without being added here fails CI rather than
 * going unwatched.
 */
export const APPEND_ONLY_TRIGGERS: ReadonlyArray<AppendOnlyTrigger> = [
  { name: 'audit_log_no_update', table: 'audit_log', event: 'UPDATE' },
  { name: 'audit_log_no_delete', table: 'audit_log', event: 'DELETE' },
  {
    name: 'audit_log_no_replace',
    table: 'audit_log',
    event: 'INSERT',
    when: 'EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)',
  },
  { name: 'ai_usage_no_update', table: 'ai_usage', event: 'UPDATE' },
  { name: 'ai_usage_no_delete', table: 'ai_usage', event: 'DELETE' },
  {
    name: 'ai_usage_no_replace',
    table: 'ai_usage',
    event: 'INSERT',
    when: 'EXISTS (SELECT 1 FROM ai_usage WHERE id = NEW.id)',
  },
];

/** SQLite folds identifier case in ASCII only (sqlite3StrICmp), so this does too. */
function foldCase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Case, identifier quoting ("x", `x`, [x]) and every whitespace run removed. */
function squash(sql: string): string {
  return foldCase(sql)
    .replace(/["`[\]]/g, '')
    .replace(/\s+/g, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a trigger's stored `sql` is the guard `want` describes: `CREATE TRIGGER <name> BEFORE
 * <event> ON <table> [FOR EACH ROW] [WHEN <the guard's own condition>] BEGIN SELECT RAISE(ABORT,
 * <any message>); END`, anchored at both ends. SQLite stores the text from the trigger name to
 * END (it drops IF NOT EXISTS and any schema prefix), so that is the whole statement. The message
 * is SQLite's name token: a single-quoted string (which may hold a `)`), or, once `squash` has
 * dropped double quotes, any run without a quote or `)`.
 */
function isGuardShape(want: AppendOnlyTrigger, sql: string): boolean {
  const when = want.when ? `when${escapeRegExp(squash(want.when))}` : '';
  const shape = new RegExp(
    `^createtrigger${escapeRegExp(foldCase(want.name))}before${foldCase(want.event)}on` +
      `${escapeRegExp(foldCase(want.table))}(?:foreachrow)?${when}` +
      `beginselectraise\\(abort,(?:'(?:[^']|'')*'|[^')]*)\\);end$`,
  );
  return shape.test(squash(sql));
}

/**
 * The required triggers that are absent from `present`, present on a different table, or present
 * but altered. Pure, so the rule is testable without a database. Each entry is a short,
 * human-readable reason that names only the kit's own identifiers from `required`, because it
 * lands in the alert email (sent from the app's own sender), the console log and the heartbeat
 * audit row. Nothing read back from the live schema is echoed: not row data, not the live trigger
 * text, and not the live table name. Anyone with D1 write access chooses those, and a table name
 * is free text to SQLite (`CREATE TABLE "sign in at https://..."(x)` is valid), so echoing one
 * would put that person's words in the owner's inbox. The repair does not need it either: it is
 * `DROP TRIGGER <want.name>` and schema.sql, and the person doing it can read sqlite_master.
 */
export function missingAppendOnlyTriggers(
  present: ReadonlyArray<{ name: string; table: string; sql: string }>,
  required: ReadonlyArray<AppendOnlyTrigger> = APPEND_ONLY_TRIGGERS,
): string[] {
  const byName = new Map(present.map((t) => [foldCase(t.name), t]));
  const problems: string[] = [];
  for (const want of required) {
    const live = byName.get(foldCase(want.name));
    if (live === undefined) {
      problems.push(`${want.name} (missing, expected on ${want.table})`);
    } else if (foldCase(live.table) !== foldCase(want.table)) {
      problems.push(`${want.name} (on another table, expected on ${want.table})`);
    } else if (!isGuardShape(want, live.sql)) {
      problems.push(
        `${want.name} (altered: not the BEFORE ${want.event} ... RAISE(ABORT) guard schema.sql defines)`,
      );
    }
  }
  return problems;
}

export async function runAppendOnlyTriggerCheck(env: Env): Promise<string> {
  // A failed read throws straight through: the check could not show the triggers are there, so
  // the task fails and pages, the same as a missing trigger.
  const present = await makeDb(env).meta.triggers();
  const problems = missingAppendOnlyTriggers(present);
  if (problems.length > 0) {
    throw new Error(
      `append-only triggers not in place: ${problems.join('; ')}. audit_log / ai_usage can be ` +
        'rewritten until a person recreates each one verbatim from schema.sql ' +
        '(CREATE TRIGGER IF NOT EXISTS; a same-named trigger that is on the wrong table or ' +
        'altered must be dropped first, or IF NOT EXISTS skips it).',
    );
  }
  const tables = [...new Set(APPEND_ONLY_TRIGGERS.map((t) => t.table))].join(', ');
  return `append-only triggers: ${APPEND_ONLY_TRIGGERS.length}/${APPEND_ONLY_TRIGGERS.length} present and unaltered on ${tables}`;
}
