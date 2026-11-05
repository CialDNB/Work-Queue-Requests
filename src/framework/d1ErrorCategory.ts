// WHICH KIND OF D1 FAILURE — a category for an ops alert, from a fixed list, never the message.
//
// Two framework alerts fire when the kit cannot write its own trail: `audit write FAILED` (the
// declared audit write, execute.ts) and `read ledger FAILED (d1 flush)` (readAudit.ts). Both used
// to carry only the error CLASS, which is `Error` for every D1 failure there is. An owner could not
// tell a busy database (contention: transient, fixed by removing load) from a real bug (a
// constraint, a missing column) without opening Workers Logs, which expire after a few days (7 on
// the paid plan). This names the kind.
//
// ── NEVER THE MESSAGE ─────────────────────────────────────────────────────────────────────
// A D1 message can embed a column name, a CHECK expression, a trigger's RAISE text or a bound
// value, and these alerts fan out to email and a third-party webhook. So the answer is one of the
// literals in `D1_ERROR_CATEGORIES`, picked by matching KNOWN message prefixes, and the return type
// is that union: no substring of the message can come back out, and a message nobody listed is
// `other` rather than "whatever it said".
// ──────────────────────────────────────────────────────────────────────────────────────────
//
// ── THE CATEGORY IS LOGGED TOO; THE MESSAGE IS NOT SOMETHING TO COUNT ON ───────────────────
// Each caller writes the category, as the `category` field, on the failure log line it already
// emits (`read_audit_flush_failed`, `audit_declared_write_failed`; an enum in KIT_LOG_EVENTS). The alerts are throttled to
// one per window, so a second failure inside it, maybe of another kind, sends nothing, and its log
// line is the only record of its category. A fixed literal is safe on that line whatever the log
// policy is. Nobody should be sent to the logs for the raw message, though: on insights staging
// the Workers Logs line for a failed flush held only the stack (2026-09-22), and PIA C5 log
// hygiene (kit PR #241) reduces every logged error to its name, code and status. So no meaning
// below points at the logs for detail.
//
// Sources: Cloudflare's D1 error table (https://developers.cloudflare.com/d1/observability/debug-d1/)
// for the platform messages, and SQLite's own constraint text as the workerd D1 binding surfaces it
// — `D1_ERROR: NOT NULL constraint failed: t.c: SQLITE_CONSTRAINT`, with an ` (extended: …)` tail
// in the local runtime — confirmed against the runtime the tests use
// (test/framework/alert-error-category.test.ts drives a real trigger abort through it).

/** The fixed list, in the order an alert reader triages it. Adding one is a reviewed edit here. */
export const D1_ERROR_CATEGORIES = [
  'overloaded',
  'timeout/reset',
  'network',
  'constraint',
  'other',
] as const;

export type D1ErrorCategory = (typeof D1_ERROR_CATEGORIES)[number];

/**
 * One fixed sentence per category for the email body, so the reader knows what to DO without
 * knowing D1's vocabulary. Literals only; nothing here is derived from the error.
 */
export const D1_ERROR_CATEGORY_MEANING: Readonly<Record<D1ErrorCategory, string>> = {
  overloaded: 'contention — the database had too many requests queued and turned this one away',
  'timeout/reset':
    'the database restarted, or an operation hit a time, memory or CPU limit (transient unless it repeats)',
  network: 'the Worker lost its connection to the database (transient)',
  constraint:
    'the database rejected the row (a constraint or trigger) — a bug or schema drift, not load',
  other:
    'not a known D1 failure pattern — the alert cannot say more; check /_health, then reproduce it locally for the detail',
};

/**
 * Message prefixes, matched AFTER the `D1_ERROR: ` wrapper is removed. Each platform entry is the
 * start of a row in Cloudflare's error table, verbatim; the constraint entries are SQLite's.
 */
const PREFIXES: readonly (readonly [prefix: string, category: D1ErrorCategory])[] = [
  // Both queue messages: "Requests queued for too long." and "Too many requests queued."
  ['D1 DB is overloaded.', 'overloaded'],

  ['D1 DB storage operation exceeded timeout', 'timeout/reset'],
  ['D1 DB reset because its code was updated.', 'timeout/reset'],
  ['Internal error while starting up D1 DB storage caused object to be reset.', 'timeout/reset'],
  ['Internal error in D1 DB storage caused object to be reset.', 'timeout/reset'],
  ["D1 DB's isolate exceeded its memory limit and was reset.", 'timeout/reset'],
  ['D1 DB exceeded its CPU time limit and was reset.', 'timeout/reset'],

  ['Network connection lost.', 'network'],
  ['Replica disconnected from primary.', 'network'],
  ['Cannot resolve D1 DB due to transient issue on remote node.', 'network'],
  ["Can't read from request stream because client disconnected.", 'network'],

  ['UNIQUE constraint failed:', 'constraint'],
  ['NOT NULL constraint failed:', 'constraint'],
  ['CHECK constraint failed:', 'constraint'],
  ['FOREIGN KEY constraint failed', 'constraint'],
];

/**
 * A trigger's `RAISE(ABORT, '<any text>')` has no fixed prefix — the text is the trigger author's —
 * but D1 ends every SQLite error with its result code, and an abort's code is SQLITE_CONSTRAINT.
 * Anchored to the END of the message, so it matches the code D1 appends and not a mention of it
 * mid-sentence.
 */
const SQLITE_CONSTRAINT_TAIL = /: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_[A-Z]+\))?$/;

/** Wrappers stripped before matching: workerd's `D1_ERROR: `, and an `Error: ` a rethrow added. */
const WRAPPERS = ['D1_ERROR: ', 'Error: '] as const;
const MAX_WRAPPERS = 3;

/**
 * The category of a failure thrown by a D1 call. Never throws: a hostile or exotic `err` (a thrown
 * string, an object whose `message` getter throws) is `other`, because this runs inside alert paths
 * that must not fail.
 */
export function d1ErrorCategory(err: unknown): D1ErrorCategory {
  try {
    if (typeof err !== 'object' || err === null) return 'other';
    const raw: unknown = (err as { message?: unknown }).message;
    if (typeof raw !== 'string') return 'other';
    let message = raw;
    for (let i = 0; i < MAX_WRAPPERS; i++) {
      const wrapper = WRAPPERS.find((w) => message.startsWith(w));
      if (wrapper === undefined) break;
      message = message.slice(wrapper.length);
    }
    for (const [prefix, category] of PREFIXES) {
      if (message.startsWith(prefix)) return category;
    }
    return SQLITE_CONSTRAINT_TAIL.test(message) ? 'constraint' : 'other';
  } catch {
    return 'other';
  }
}
