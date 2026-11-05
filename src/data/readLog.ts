// The read ledger's repository (Fleet Ledger K2a + K2b, PIA C15). THREE STREAMS, one table:
//   kind='aurora'    a private-database read through src/data/aurora.ts — the read-attribution
//                    trail that compensates for client data living on a shared Cloudflare account
//                    with no per-Worker boundary (binding-allowlist.jsonc explains why there isn't
//                    one).
//   kind='d1'        an ordinary read of this app's own D1, recorded by the framework's recordDb
//                    proxy (src/framework/readAudit.ts) when READ_AUDIT is armed.
//   kind='upstream'  a read of an upstream HTTP source through src/data/upstream.ts
//                    (`ctx.readUpstream()` in a route) — the per-call record PIA C15 asks of every
//                    route that reads one (migrations/d1/0005_read_log_upstream.sql).
// The registry never receives these rows; it receives counts, and K1's digest splits its read
// streams on `kind` (src/data/activity.ts). Actor emails and declared targets stay inside the app
// that owns the data.
//
// `kind` (WHERE the data lives) and `source_class` (HOW SENSITIVE it is, Decision D3) are
// independent axes. Every d1 row is `internal`; an aurora or upstream row carries whatever class
// its reviewed source table assigned. Neither column can be derived from the other.
//
// ── THE STRUCTURAL INVARIANT (Decision D6) ─────────────────────────────────────────────────
// `ReadLogIntent` has NO FIELD that can carry SQL text or bind values, and neither does the
// table. That is not a convention anyone has to remember: `auroraQuery` builds this object out
// of named spec fields, so `spec.sql` and `spec.params` have nowhere to go. What identifies
// "which records" is `target` — an explicit projection the query spec DECLARES, which is a
// reviewed decision rather than whatever happened to be bound. A patch adding a `sql` column or
// a `params` field has to change this interface, this table, and the pin in
// test/data/read-log.test.ts, in a CODEOWNERS-gated file. That is the intended cost.
//
// The d1 stream (K2b) inherits the same shape and therefore the same invariant. The recordDb
// proxy sees a repository method's ARGUMENTS on every call and there is nowhere on this interface
// to put them: it fills `source` with the repository name and `query_name` with the method name,
// both identifiers taken from the code, never from a caller.
//
// The upstream stream (C15) inherits it too, and the table enforces it on top: an upstream row's
// `source`, `query_name` and `target` must each be an identifier (a lowercase letter, then
// lowercase letters, digits or `_`), so the ticket key, DUNS or URL a fetch was made with cannot be
// written into any of them — the value is refused by a CHECK, not merely left out by convention.
// ───────────────────────────────────────────────────────────────────────────────────────────

/** Which trust class the source belongs to — set from binding-allowlist.jsonc, never by a route. */
export type ReadSourceClass = 'client' | 'internal';

/**
 * WHICH STREAM a row belongs to: a private-database read (`aurora`), a read of this app's own D1
 * (`d1`), or a read of an upstream HTTP source (`upstream`). Orthogonal to `ReadSourceClass` — see
 * the header. K1's digest reports each as its own stream and R2 alerts on them separately, so this
 * is not a label, it is a routing key.
 */
export type ReadKind = 'aurora' | 'd1' | 'upstream';

/**
 * The write-ahead intent row: everything known BEFORE the query runs. Deliberately complete
 * without the result, because for a client-class source this is inserted and awaited while the
 * query has not yet been sent — so a row that never gains a count still says, truthfully, that
 * this principal was authorized to read this view through this route.
 */
export interface ReadLogIntent {
  id: string;
  request_id: string;
  principal: string;
  app: string;
  env: string;
  route: string;
  /** Defaults to `'aurora'` when omitted, matching the column default and every pre-K2b row. */
  kind?: ReadKind;
  /**
   * aurora: the registered source name. d1: the repository name (`notes`, `users`). upstream: the
   * registered upstream source name (`autobahn`).
   */
  source: string;
  source_class: ReadSourceClass;
  /** Schema-qualified view the query spec declared. NULL on a d1 or upstream row — there is none. */
  view: string | null;
  /**
   * aurora: the registered query id. d1: the repository METHOD name. upstream: the registered read
   * id. An identifier, never SQL, never a URL.
   */
  query_name: string | null;
  /**
   * Declared identifier projection — its NAME (`client_code`, `duns`), never its value — or null
   * when the spec declared none (view + count only). Required on an upstream row.
   */
  target: string | null;
}

export interface ReadLogRow extends ReadLogIntent {
  /** Always present on a stored row (the column has a default); never `undefined` on read. */
  kind: ReadKind;
  /** NULL/null means ATTEMPTED — the read started and the outcome is unknown. 0 means empty. */
  row_count: number | null;
  created_at: string;
}

/**
 * Opaque paging cursor: the (created_at, id) of the oldest row on a page.
 *
 * BOTH halves are required. `created_at` is a `datetime('now')` string with ONE-SECOND precision,
 * and a single request routinely makes several reads inside one second — so a `created_at`-only
 * cursor (`WHERE created_at < ?`) skips every remaining row that shares that second. On an audit
 * surface that is silent under-reporting: the page after a tie comes back empty and the reads in
 * between are never shown. `id` breaks the tie, matching the `created_at DESC, id DESC` ordering.
 */
export interface ReadLogCursor {
  created_at: string;
  id: string;
}

export interface ReadLogPage {
  items: ReadLogRow[];
  /** Cursor for the next older page, or null when this is the last one. */
  next_before: ReadLogCursor | null;
}

/**
 * Rows one retention DELETE may remove. read_log rows are ~190 bytes across three secondary
 * indexes, so 5,000 is a short statement that never approaches D1's per-query time limit, and a
 * day of rows on the busiest fork measured so far (~20k) is still only a handful of passes.
 */
export const READ_LOG_PRUNE_CHUNK_ROWS = 5_000;

/**
 * Most DELETE passes one prune run makes: 200,000 rows a night at the default chunk, for at most
 * 42 D1 queries (one cutoff + 40 passes + one backlog read when the cap is hit) out of the ~1,000
 * one cron invocation may spend.
 */
export const READ_LOG_PRUNE_MAX_PASSES = 40;

export interface ReadLogPruneResult {
  /** Rows deleted across every pass. */
  deleted: number;
  /** DELETE statements issued. A run that finds nothing still makes one pass. */
  passes: number;
  /**
   * True when nothing eligible is left: a pass came back short, or the cap was hit on the very
   * last eligible row. False when the pass cap stopped the loop with rows still waiting.
   */
  drained: boolean;
  /**
   * Only when `drained` is false: how many days past the cutoff the oldest row still waiting is.
   * The cron pages on it (src/cron/prune.ts), so a backlog that never drains is not a quiet,
   * green "pass cap reached" every night.
   */
  overdueDays?: number;
}

const COLUMNS =
  'id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, target, row_count, created_at';

/** The insert column list, shared by all three write paths so they cannot drift apart. */
const INSERT_COLUMNS =
  'id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, target';

/**
 * The bind values for one intent, in `INSERT_COLUMNS` order. ONE place builds this tuple, so a
 * column added to the table is a single edit rather than three that must agree — and, more to the
 * point, there is exactly one function to read when checking that nothing but named identifier
 * fields reaches the wire (Decision D6).
 */
function intentValues(intent: ReadLogIntent): unknown[] {
  return [
    intent.id,
    intent.request_id,
    intent.principal.toLowerCase(),
    intent.app,
    intent.env,
    intent.route,
    intent.kind ?? 'aurora',
    intent.source,
    intent.source_class,
    intent.view,
    intent.query_name,
    intent.target,
  ];
}

/**
 * Can this database's `read_log` hold an upstream row — has migration 0005 (PIA C15) run? Read off
 * the table's own DDL, where 0005's CHECK names the kind:
 *
 *   'accepted'  read_log exists and its definition admits `'upstream'`;
 *   'refused'   no read_log at all, or one whose definition predates 0005 — the database is older
 *               than the code (a fork renumbers kit migrations by hand, so that window is real);
 *   'unknown'   the probe itself failed (D1 unreachable): nothing can be said either way.
 *
 * Two readers, and each needs `unknown` on its own side: the activity digest reports
 * `reads_upstream` only on 'accepted' (a zero it cannot back is a claim), and the upstream seam
 * names the 0005 remedy only on 'refused' (a remedy it cannot back sends an operator to the wrong
 * fix). Never throws.
 */
export async function readLogUpstreamSupport(
  db: D1Database,
): Promise<'accepted' | 'refused' | 'unknown'> {
  try {
    const row = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'read_log'")
      .first<{ sql: string | null }>();
    if (typeof row?.sql !== 'string') return 'refused';
    return row.sql.includes("'upstream'") ? 'accepted' : 'refused';
  } catch {
    return 'unknown';
  }
}

export function readLogRepo(db: D1Database) {
  return {
    /**
     * Insert the intent row. For a client-class source the caller AWAITS this before running the
     * query, and a rejection here means the read must not happen (Decision D3); for an
     * internal-class source the caller schedules it and never blocks on it.
     */
    async insertIntent(intent: ReadLogIntent): Promise<void> {
      await db
        .prepare(
          `INSERT INTO read_log (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...intentValues(intent))
        .run();
    },

    /**
     * Insert a COMPLETE row in one statement — the internal-class path, where the query has
     * already returned and there is nothing to be gained by splitting the write in two.
     */
    async insertComplete(intent: ReadLogIntent, rowCount: number): Promise<void> {
      await db
        .prepare(
          `INSERT INTO read_log (${INSERT_COLUMNS}, row_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...intentValues(intent), rowCount)
        .run();
    },

    /**
     * Insert MANY complete rows in ONE D1 round-trip — the d1-stream path (K2b).
     *
     * A single request routinely makes several repository reads (a list plus a permission lookup
     * plus a count), and one INSERT each would multiply the ledger's cost by the number of reads
     * on every request of every armed app. `db.batch` sends them as one statement group.
     *
     * Every row carries its count already: unlike the aurora write-ahead path, this flush happens
     * AFTER the handler returned, so there is no window in which the outcome is unknown and
     * nothing to patch later. An empty list is a no-op that touches no binding — the common case
     * on a route that reads nothing.
     */
    async insertManyComplete(
      rows: readonly { intent: ReadLogIntent; rowCount: number | null }[],
    ): Promise<void> {
      if (rows.length === 0) return;
      const stmt = db.prepare(
        `INSERT INTO read_log (${INSERT_COLUMNS}, row_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      await db.batch(rows.map((r) => stmt.bind(...intentValues(r.intent), r.rowCount)));
    },

    /**
     * The one-shot count patch that closes a write-ahead row. `WHERE row_count IS NULL` makes it
     * idempotent from the application side and keeps it in step with the DB-layer trigger, which
     * rejects a second patch outright: an already-counted row is settled history. Returns whether
     * a row actually moved, so a caller can tell "patched" from "already settled or gone".
     */
    async patchRowCount(id: string, rowCount: number): Promise<boolean> {
      const res = await db
        .prepare('UPDATE read_log SET row_count = ? WHERE id = ? AND row_count IS NULL')
        .bind(rowCount, id)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Newest first, with a COMPOSITE (created_at, id) cursor for paging back in time. The
     * tie-breaking `OR (created_at = ? AND id < ?)` is what keeps rows written in the same second
     * — the normal case for one request making several reads — from being skipped entirely.
     * Fetches limit+1 and trims, so a cursor is emitted only when an older row really exists.
     */
    async list(opts: { limit: number; before?: ReadLogCursor }): Promise<ReadLogPage> {
      const res = opts.before
        ? await db
            .prepare(
              `SELECT ${COLUMNS} FROM read_log WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .bind(opts.before.created_at, opts.before.created_at, opts.before.id, opts.limit + 1)
            .all<ReadLogRow>()
        : await db
            .prepare(`SELECT ${COLUMNS} FROM read_log ORDER BY created_at DESC, id DESC LIMIT ?`)
            .bind(opts.limit + 1)
            .all<ReadLogRow>();
      const hasMore = res.results.length > opts.limit;
      const items = hasMore ? res.results.slice(0, opts.limit) : res.results;
      const last = items[items.length - 1];
      return {
        items,
        next_before: hasMore && last ? { created_at: last.created_at, id: last.id } : null,
      };
    },

    /** Every read made while serving one request, oldest first — the "what did that call touch" view. */
    async listByRequest(requestId: string): Promise<ReadLogRow[]> {
      const res = await db
        .prepare(
          `SELECT ${COLUMNS} FROM read_log WHERE request_id = ? ORDER BY created_at ASC, id ASC`,
        )
        .bind(requestId)
        .all<ReadLogRow>();
      return res.results;
    },

    /**
     * Rows whose count never landed — a write-ahead intent whose request died between the
     * ledger write and the patch. These are the honest "attempted, outcome unknown" reads, and
     * an operator wants them separable from empty results, so this is a first-class query
     * rather than something a caller has to remember to express as `row_count IS NULL`.
     */
    async listAttempted(limit: number): Promise<ReadLogRow[]> {
      const res = await db
        .prepare(
          `SELECT ${COLUMNS} FROM read_log WHERE row_count IS NULL ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(limit)
        .all<ReadLogRow>();
      return res.results;
    },

    /**
     * Retention (Decision D4: 60 days). Unlike audit_log, the read ledger is PRUNED rather than
     * kept forever: it is high-volume access metadata about client data, so keeping it longer
     * than it is useful enlarges exactly the target the ledger exists to protect. Deletion is the
     * promise; the daily R2 backup quietly extends it by its own window, which is a compliance
     * note in docs/DATA-ROUTES.md, not something this function can fix.
     *
     * CHUNKED, NOT ONE STATEMENT. Each pass deletes at most `chunkRows` rows, oldest first,
     * through `id IN (SELECT id … LIMIT ?)` (plain SQLite; `DELETE … LIMIT` needs a compile-time
     * option D1 does not document), and the loop runs until a pass comes back short. At the
     * default window a few passes cover one day of rows. The chunking is for the day someone
     * shortens READ_LOG_RETENTION_DAYS or the cron misses a week: a single statement over the
     * whole backlog is the one that times out, rolls back, and leaves the deletion promise
     * unkept. The cutoff is computed ONCE, so every pass deletes against the same horizon and
     * the eligible set only shrinks, which is what guarantees the loop ends.
     *
     * `maxPasses` bounds one run. The daily cron shares a single invocation's D1 query budget with
     * the backup, the heartbeat and the registry report, so a huge backlog drains over a few
     * nights (oldest rows first) instead of spending that budget. When the cap stops the loop, one
     * more read (MIN over idx_read_log_created, a single index row) measures how far behind the
     * backlog is, as `overdueDays`; `drained: false` says rows remain for the next run.
     */
    async pruneOlderThan(
      days: number,
      opts: { chunkRows?: number; maxPasses?: number } = {},
    ): Promise<ReadLogPruneResult> {
      const chunkRows = opts.chunkRows ?? READ_LOG_PRUNE_CHUNK_ROWS;
      const maxPasses = opts.maxPasses ?? READ_LOG_PRUNE_MAX_PASSES;
      // Each of these, if zero or negative, would make retention a green no-op or (for `days`)
      // "retain nothing". Throw instead, so the cron task goes red and the alert goes out.
      for (const [name, value] of [
        ['days', days],
        ['chunkRows', chunkRows],
        ['maxPasses', maxPasses],
      ] as const) {
        if (!Number.isInteger(value) || value < 1) {
          throw new RangeError(`read_log prune: ${name} must be a positive integer, got ${value}`);
        }
      }

      const horizon = await db
        .prepare("SELECT datetime('now', ?) AS cutoff")
        .bind(`-${days} days`)
        .first<{ cutoff: string }>();
      if (!horizon?.cutoff) throw new Error(`read_log prune: no cutoff for ${days} days`);

      let deleted = 0;
      for (let passes = 1; passes <= maxPasses; passes += 1) {
        const res = await db
          .prepare(
            'DELETE FROM read_log WHERE id IN (SELECT id FROM read_log WHERE created_at < ? ORDER BY created_at LIMIT ?)',
          )
          .bind(horizon.cutoff, chunkRows)
          .run();
        deleted += res.meta.changes;
        if (res.meta.changes < chunkRows) return { deleted, passes, drained: true };
      }
      // The cap stopped the loop. Measure the backlog so the cron can tell a backlog that drains
      // over a few nights from one that never will.
      const backlog = await db
        .prepare(
          'SELECT julianday(?1) - julianday(MIN(created_at)) AS overdue_days FROM read_log WHERE created_at < ?1',
        )
        .bind(horizon.cutoff)
        .first<{ overdue_days: number | null }>();
      const overdueDays = backlog?.overdue_days;
      if (overdueDays === null || overdueDays === undefined) {
        return { deleted, passes: maxPasses, drained: true };
      }
      return { deleted, passes: maxPasses, drained: false, overdueDays };
    },
  };
}
