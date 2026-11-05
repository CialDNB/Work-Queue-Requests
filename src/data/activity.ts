// DAILY ACTIVITY DIGESTS — what this app did, as counts (Fleet Ledger K1).
//
// One row per (UTC day × stream). The registry stores these to answer fleet questions no single
// app can answer for itself: is this app's read volume ten times last week's, did anyone touch
// it at all this month, which app is spending the AI budget. It answers them from VOLUMES.
//
// ── THE PRIVACY INVARIANT, HELD BY SHAPE ──────────────────────────────────────────────────
// Actor emails and record identifiers NEVER leave the app. That is not a promise this module
// makes politely, it is what its RETURN TYPE can express: `ActivityDigest` has exactly two
// numeric fields and a list of NAMES, and there is no field on it that could carry an email, a
// row id, SQL text, or a bind value. `actors` is a `COUNT(DISTINCT …)` computed here, inside the
// app that owns the data — the registry receives the integer, never the set. `top` carries
// PREDICATES (an audit verb, a model name, a declared view name) — the vocabulary the app's own
// manifest already publishes to the fleet — never a value a user supplied or a record was keyed
// by. The kit already drew this line for `ai_spend_30d` (one scalar, no per-user breakdown to
// leak); this is the same line, one table wider.
//
// Every SELECT below is therefore an aggregate. Grep this file for a bare identifier column in a
// projection and you will not find one; adding one has to change the interface, the tests that
// pin the payload shape, and a CODEOWNERS-gated file. That is the intended cost.
// ──────────────────────────────────────────────────────────────────────────────────────────
//
// Reading across three tables (audit_log, ai_usage, read_log) from ONE module is deliberate. The
// alternative — a `dailyActivity()` on each owning repository — spreads the privacy argument
// over three files and makes it something a reviewer has to reassemble. Here it is one file, one
// return type, one invariant.
import { readLogUpstreamSupport } from './readLog';

/**
 * The five streams the fleet registry's ingest PINS — its `z.enum(ACTIVITY_STREAMS)` in
 * CialDNB/app-registry src/data/ledger.ts, under a 40-row cap. A stream outside this list, or a
 * sixth week of rows, inside `activity[]` would 400 the WHOLE daily report (status, health and
 * manifest with it), so adding one here takes a registry change first.
 */
export const REGISTRY_ACTIVITY_STREAMS = [
  'writes',
  'reads_d1',
  'reads_aurora',
  'auth',
  'ai',
] as const;

/**
 * Every stream this app digests: the five the registry pins, plus `reads_upstream` (PIA C15) —
 * reads of an upstream HTTP source, `read_log.kind = 'upstream'`. The registry does not pin that one
 * yet, so src/cron/reportToRegistry.ts sends it as its own sibling block (`activity_upstream`),
 * which today's registry strips as an unknown key and a later one can ingest — never inside
 * `activity[]`, and never folded into `reads_aurora`.
 */
export type ActivityStream = (typeof REGISTRY_ACTIVITY_STREAMS)[number] | 'reads_upstream';

/** A busiest-NAME entry: a predicate (verb / model / view), never a record identifier. */
export interface ActivityTop {
  name: string;
  count: number;
}

export interface ActivityDigest {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  stream: ActivityStream;
  events: number;
  /**
   * DISTINCT COUNT of actors. Never a list, never an email. On the `writes` stream it leaves out
   * service identities (the reserved `.invalid` namespace; see AUDIT_ACTOR below).
   */
  actors: number;
  top?: ActivityTop[];
  /** App-side flags — short slugs, no values. Omitted when there is nothing to flag. */
  anomalies?: string[];
}

/**
 * How many trailing days each stream reports, INCLUDING today.
 *
 * Seven, and the ceiling is not arbitrary: the registry bounds one report at 40 digest rows, and
 * `activity[]` carries five streams, so eight days would sit exactly at the cap with no headroom
 * for a sixth stream (which is why `reads_upstream` rides its own block). Seven also means today's partial count (the ops loop runs at 03:00 UTC, three
 * hours into the day) is re-reported as a COMPLETE count on each of the next six runs — the
 * registry's upsert is keyed (app, day, stream) and REPLACES, so the last report of a day wins.
 * That is what makes a week of silence self-heal instead of leaving a permanently truncated day.
 */
export const ACTIVITY_WINDOW_DAYS = 7;

/** Busiest names kept per (day, stream). Bounded well under the registry's cap of 20. */
const TOP_N = 5;

/** The registry's own limit on a `top[].name`. Over it, the WHOLE report 400s — so we trim. */
const MAX_TOP_NAME_LEN = 120;

/**
 * Audit actions that are AUTHENTICATION events rather than application writes. Splitting them
 * out is the difference between "this app is being used" and "people are trying to get in" —
 * the second is a security signal and a login storm must not read as a busy Tuesday.
 * Kept in step with the actions src/auth/ writes (magicLink.ts, oidc.ts).
 */
const AUTH_ACTIONS = ['login', 'magic_link_sent', 'magic_link_refused'] as const;

// The `IN (…)` list, inlined rather than bound: it is a fixed literal array in this file, never
// caller input, and SQLite has no array binding.
const AUTH_IN = AUTH_ACTIONS.map((a) => `'${a}'`).join(', ');
const AUDIT_STREAM = `CASE WHEN action IN (${AUTH_IN}) THEN 'auth' ELSE 'writes' END`;

/**
 * SQL twin of `isReservedIdentifier` (src/auth/serviceNamespace.ts), over `audit_log.actor_email`:
 * true for an address in the reserved `.invalid` namespace, which is always a SERVICE identity's
 * attribution identifier (`svc-<slug>@<app>.invalid`) and never a person's — the kit refuses the
 * whole TLD on every path a person uses. The same rules: there must be an `@`, case is ignored,
 * surrounding spaces and trailing root dots are dropped, and the bare TLD counts as well as any
 * subdomain. `LIKE` is safe here because the patterns hold no `_` and a `%` only at the start.
 * Exported for the parity test that runs both definitions over the same addresses.
 */
export const SERVICE_ACTOR_SQL = `(instr(actor_email, '@') > 0 AND (rtrim(lower(trim(actor_email)), '.') LIKE '%.invalid' OR rtrim(lower(trim(actor_email)), '.') LIKE '%@invalid'))`;

/**
 * THE WRITES STREAM'S `actors` LEAVES SERVICE IDENTITIES OUT (DECISIONS 2026-09-24, machine read
 * attribution). The fleet registry's `read_audit_silent` rule reads `actors >= 2` on the writes
 * stream as "somebody other than the ops loop wrote today", because the ops loop writes as ONE
 * identity (`system@cron`). A machine's audited writes through a machine route write no read rows
 * (src/framework/machine.ts), so an ETL writing on a day nobody else touched the app would make
 * `system@cron` + the ETL two actors against zero reads, and a working ledger would page.
 * Excluding the reserved namespace keeps `actors` meaning what the rule needs: people (and the
 * app's own system identities). `events` still counts every row — a machine's writes are real
 * volume — and the `auth` stream is untouched (a service never signs in). A service's writes
 * through ordinary routes are left out of `actors` too: it is the same identity, and a count of
 * distinct machines is not the question `actors` answers.
 */
const AUDIT_ACTOR = `CASE WHEN ${AUDIT_STREAM} = 'writes' AND ${SERVICE_ACTOR_SQL} THEN NULL ELSE actor_email END`;

interface TotalRow {
  day: string;
  stream: string;
  events: number;
  actors: number;
}
interface TopRow {
  day: string;
  stream: string;
  name: string;
  count: number;
}

/** UTC `YYYY-MM-DD` for today and the previous `days - 1` days, oldest first. */
export function windowDays(days: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Group top-name rows by `day|stream`, highest count first. NOT truncated here — the anomaly
 * flags below are computed from the FULL per-name counts and only the emitted `top` is capped.
 * Truncating first was a silent-degradation bug: `refusals_exceed_logins` reads the counts of
 * two specific auth verbs, so on any app with more than TOP_N distinct auth actions in a day one
 * of them falls out of the list and the flag stops firing — on exactly the busy days it is for.
 */
function indexTop(rows: readonly TopRow[]): Map<string, ActivityTop[]> {
  const byKey = new Map<string, ActivityTop[]>();
  for (const r of rows) {
    // A NULL name would throw on the `.slice()` below and take the WHOLE daily report with it —
    // status, health and manifest included — over a label. The projections above are written so
    // this cannot happen (see `readTopName`), and this is the second lock: a nullable column
    // added to any of the three source tables degrades to a missing top entry, not an outage.
    if (typeof r.name !== 'string') continue;
    const key = `${r.day}|${r.stream}`;
    const list = byKey.get(key) ?? [];
    // Names are TRUNCATED to the registry's own 120-character limit rather than sent whole. This
    // is the one place app-controlled text reaches the payload — a view or audit-action name is
    // defined by the fork, not by the kit — and an over-long one would fail the registry's
    // `z.string().max(120)`, which 400s the ENTIRE report: status, health and manifest with it.
    // A block that cannot be built is omitted; a name that does not fit is trimmed. Neither is
    // ever allowed to take the whole report down.
    list.push({ name: r.name.slice(0, MAX_TOP_NAME_LEN), count: r.count });
    byKey.set(key, list);
  }
  for (const [key, list] of byKey) {
    // Ties broken by name so the payload is deterministic run to run — otherwise a no-op
    // re-report can look like a change to anything downstream that diffs it.
    list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    byKey.set(key, list);
  }
  return byKey;
}

export function activityRepo(db: D1Database) {
  /**
   * Does `read_log` carry the `kind` column that separates a D1 read from an Aurora one?
   *
   * Detected at RUNTIME rather than assumed, because the column arrives in a later kit change
   * (K2b) than this reporter. Getting this wrong in the optimistic direction is the expensive
   * mistake: reporting D1 reads under `reads_aurora` mixes an app's routine internal traffic
   * into the stream that exists to watch CLIENT-data access, and because the registry stores
   * digests rather than raw rows, the two can never be told apart again. So until the column
   * exists, every read_log row reports as `reads_aurora` — which is exactly what it is today,
   * since src/data/aurora.ts is the only writer — and `reads_d1` is not reported at all. A
   * missing stream is a gap the next report fills; a corrupted stream is permanent.
   */
  async function hasKindColumn(): Promise<boolean> {
    try {
      const res = await db.prepare('PRAGMA table_info(read_log)').all<{ name: string }>();
      return (res.results ?? []).some((c) => c.name === 'kind');
    } catch {
      return false;
    }
  }

  return {
    /**
     * The whole window, every stream, ready for the wire. Days with no activity are reported as
     * ZERO rather than omitted — for the same reason `ai_spend_30d` reports 0 instead of null:
     * a fleet console can only read "this app went quiet" if silence arrives as a number. An
     * absent row is indistinguishable from an app that never reported.
     */
    async dailyDigests(days: number = ACTIVITY_WINDOW_DAYS): Promise<ActivityDigest[]> {
      // ONE clock read decides the window, and both halves use it. The earlier version let JS
      // pick the days to emit while SQLite evaluated `date('now', '-6 days')` for the filter —
      // two independent reads of the clock. A UTC midnight falling between them shifts the two
      // windows apart by a day, and the direction that hurts emits the oldest day with events: 0
      // although it had real activity. `upsertDigests` is keyed (app, day, stream) and REPLACES
      // rather than sums, so that zero would overwrite a complete day already reported. Binding
      // the first day of the JS window makes the mismatch unrepresentable.
      //
      // `created_at` is a `datetime('now')` string (`YYYY-MM-DD HH:MM:SS`), so comparing it
      // against a bare `YYYY-MM-DD` is a true "at or after midnight UTC that day": the date is a
      // prefix of every timestamp on it, and every later timestamp sorts after.
      const window = windowDays(days);
      const since = window[0] as string;
      const withKind = await hasKindColumn();
      // Can read_log hold an upstream row at all — has migration 0005 (PIA C15) run? Before it, a
      // client-class upstream read is refused and an internal-class one goes unrecorded, so
      // `reads_upstream: 0` would be a claim the ledger cannot back; the stream is left out
      // instead, and so it is when the probe cannot tell. A missing stream is a gap the next
      // report fills.
      const withUpstream = withKind && (await readLogUpstreamSupport(db)) === 'accepted';
      // Each kind its own stream. `reads_upstream` is NEVER folded into `reads_aurora`: that stream
      // exists to watch private-database access, and an upstream fetch is a different surface with
      // a different owner — merged, the two could never be told apart again.
      const readStream = withKind
        ? "CASE WHEN kind = 'd1' THEN 'reads_d1' WHEN kind = 'upstream' THEN 'reads_upstream' ELSE 'reads_aurora' END"
        : "'reads_aurora'";
      // The busiest-NAME projection for read_log, and it has to survive every stream. An aurora
      // row names the schema-qualified view it declared; a d1 row has NO view (K2b relaxed that
      // column precisely because an ordinary D1 read has none) and names the repository and
      // method instead — `notes.list`; an upstream row has no view either and names its source
      // and registered read — `autobahn.report_datablocks`, never the target or its value. Without the COALESCE the d1 half of the union yields a
      // NULL `name`, which is not merely an ugly label: `indexTop` calls `.slice()` on it and the
      // whole digest throws, taking the daily report down with it. Both forms are still
      // PREDICATES, never a value a user supplied — the privacy invariant is unchanged.
      const readTopName = withKind ? `COALESCE("view", source || '.' || query_name)` : `"view"`;

      const [auditTotals, auditTop, aiTotals, aiTop, readTotals, readTop] = await Promise.all([
        db
          .prepare(
            `SELECT date(created_at) AS day, ${AUDIT_STREAM} AS stream, COUNT(*) AS events, COUNT(DISTINCT ${AUDIT_ACTOR}) AS actors
             FROM audit_log WHERE created_at >= ?1 GROUP BY day, stream`,
          )
          .bind(since)
          .all<TotalRow>(),
        db
          .prepare(
            `SELECT date(created_at) AS day, ${AUDIT_STREAM} AS stream, action AS name, COUNT(*) AS count
             FROM audit_log WHERE created_at >= ?1 GROUP BY day, stream, name`,
          )
          .bind(since)
          .all<TopRow>(),
        db
          .prepare(
            `SELECT date(created_at) AS day, 'ai' AS stream, COUNT(*) AS events, COUNT(DISTINCT actor_email) AS actors
             FROM ai_usage WHERE created_at >= ?1 GROUP BY day`,
          )
          .bind(since)
          .all<TotalRow>(),
        db
          .prepare(
            `SELECT date(created_at) AS day, 'ai' AS stream, model AS name, COUNT(*) AS count
             FROM ai_usage WHERE created_at >= ?1 GROUP BY day, name`,
          )
          .bind(since)
          .all<TopRow>(),
        db
          .prepare(
            `SELECT date(created_at) AS day, ${readStream} AS stream, COUNT(*) AS events,
                    COUNT(DISTINCT principal) AS actors,
                    SUM(CASE WHEN row_count IS NULL THEN 1 ELSE 0 END) AS attempted
             FROM read_log WHERE created_at >= ?1 GROUP BY day, stream`,
          )
          .bind(since)
          .all<TotalRow & { attempted: number }>(),
        db
          .prepare(
            `SELECT date(created_at) AS day, ${readStream} AS stream, ${readTopName} AS name, COUNT(*) AS count
             FROM read_log WHERE created_at >= ?1 GROUP BY day, stream, name`,
          )
          .bind(since)
          .all<TopRow>(),
      ]);

      const totals = new Map<string, TotalRow>();
      const attempted = new Map<string, number>();
      for (const r of [...auditTotals.results, ...aiTotals.results, ...readTotals.results]) {
        totals.set(`${r.day}|${r.stream}`, r);
      }
      for (const r of readTotals.results) {
        attempted.set(`${r.day}|${r.stream}`, Number(r.attempted ?? 0));
      }
      const top = indexTop([...auditTop.results, ...aiTop.results, ...readTop.results]);

      const streams: ActivityStream[] = ['writes', 'auth', 'ai', 'reads_aurora'];
      if (withKind) streams.push('reads_d1');
      if (withUpstream) streams.push('reads_upstream');

      const digests: ActivityDigest[] = [];
      for (const day of window) {
        for (const stream of streams) {
          const key = `${day}|${stream}`;
          const t = totals.get(key);
          const names = top.get(key);
          // Flags see EVERY name; only the emitted list is capped at TOP_N. The two must not be
          // the same list — see indexTop.
          const flags = anomaliesFor(stream, names, attempted.get(key) ?? 0);
          const emitted = names?.slice(0, TOP_N);
          digests.push({
            day,
            stream,
            events: t?.events ?? 0,
            actors: t?.actors ?? 0,
            ...(emitted && emitted.length > 0 ? { top: emitted } : {}),
            ...(flags.length > 0 ? { anomalies: flags } : {}),
          });
        }
      }
      return digests;
    },
  };
}

/**
 * The digests as the registry report carries them: `activity` holds exactly the streams the
 * registry pins (`REGISTRY_ACTIVITY_STREAMS`), and `upstream` the `reads_upstream` rows, which ride
 * their own sibling block (src/cron/reportToRegistry.ts). A digest of any other stream goes in
 * neither — the report must never send the registry a stream name it would 400 on.
 */
export function splitForRegistry(digests: readonly ActivityDigest[]): {
  activity: ActivityDigest[];
  upstream: ActivityDigest[];
} {
  const pinned: readonly string[] = REGISTRY_ACTIVITY_STREAMS;
  return {
    activity: digests.filter((d) => pinned.includes(d.stream)),
    upstream: digests.filter((d) => d.stream === 'reads_upstream'),
  };
}

/**
 * App-side flags, derived from figures already fetched — no extra query, and nothing here can
 * carry a value. Deliberately few: an anomaly the registry cannot act on is noise, and R2's rule
 * engine does the cross-app thresholding. Each flag is a short slug (registry cap: 64 chars).
 */
export function anomaliesFor(
  stream: ActivityStream,
  top: readonly ActivityTop[] | undefined,
  attempted: number,
): string[] {
  const flags: string[] = [];
  if (stream === 'auth') {
    // More refusals than successful logins in a day is the shape of a spray or a broken
    // allowlist, and it is invisible in `events` alone (both actions count as auth traffic).
    const refused = top?.find((t) => t.name === 'magic_link_refused')?.count ?? 0;
    const logins = top?.find((t) => t.name === 'login')?.count ?? 0;
    if (refused > 0 && refused > logins) flags.push('refusals_exceed_logins');
  }
  if (attempted > 0) {
    // A write-ahead read intent whose row count never landed: the request died between the
    // ledger write and the patch. read_log already treats these as first-class ("attempted,
    // outcome unknown"); the fleet console should see that a day's attribution is incomplete
    // rather than silently trust the counts.
    // A BARE slug, with the count deliberately left out: R2's rule engine matches these
    // exactly, and a `…:37` suffix would make every day a different flag to match on.
    flags.push('attempted_uncounted');
  }
  return flags;
}
