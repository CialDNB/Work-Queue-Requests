// THE UPSTREAM READ SEAM (PIA C15). `upstreamRead()` records a read of an upstream HTTP source —
// Autobahn, a government statistics API, any service a route fetches records from — in the
// `read_log` ledger, as `kind = 'upstream'`. Routes reach it as `ctx.readUpstream()`
// (src/framework/execute.ts), which fills in who, which route and which request.
//
// WHY. Before this, a route that read an upstream left no per-call record anywhere: `read_log`
// held only private-database (`aurora`) and own-D1 (`d1`) reads, and a GET declares no audit
// action. Insights' ruling-37 routes (`GET /api/reports/:ticketKey/data`, `…/by-duns/:duns`) read
// individual credit data from Autobahn that way. PIA condition C15: every route that reads client
// data from an upstream writes a per-call ledger record. This is that record.
//
// THE SHAPE OF A READ. A read is REGISTERED once, in protected code, with `defineUpstreamRead`:
//
//     export const AUTOBAHN_REPORT = defineUpstreamRead({
//       source: 'autobahn',          // a key of UPSTREAM_SOURCES — its class comes from there
//       name: 'report_datablocks',   // the read id the ledger records
//       target: 'ticket_key',        // the NAME of the identifier the read is keyed by
//     });
//
// and a route runs it with the fetch as a thunk, which the seam calls only when the ledger allows,
// handing it a GRANT the integration module checks before it fetches (see "The grant" below):
//
//     const report = await ctx.readUpstream(
//       AUTOBAHN_REPORT,
//       (grant) => fetchLiveReport(grant, cfg, order),
//       { count: (r) => (r.status === 'ok' ? 1 : 0) },
//     );
//
// `target` IS A NAME, NEVER A VALUE (Decision D6, DECISIONS 2026-09-25). The ledger records that
// the read was keyed by a `ticket_key`; it never records which one. Every identifier the seam
// writes — source, read id, target — must match `^[a-z][a-z0-9_]{0,63}$`, checked here at module
// load AND by a CHECK in the table (migrations/d1/0005_read_log_upstream.sql), so a DUNS, a CPF, a
// ticket key, an email or a URL cannot be written into any of them even by a caller that bypasses
// this file. When a DPO needs "who read THIS ticket", that is an audit action (`ctx.audit(action,
// ticketKey)` — `audit_log.target` holds values and is in the §7.3 DSR discovery), not the ledger.
//
// FAILURE POSTURE — the aurora seam's, Decision D3, keyed on the SOURCE's class:
//
//   client-class source   WRITE-AHEAD. The intent row is INSERTed and AWAITED before the thunk is
//                         called. If that insert fails, the read THROWS the kit's opaque 500 and
//                         the upstream is never contacted. A client-data read that cannot be
//                         recorded does not happen. The count is patched afterwards; a fetch that
//                         throws leaves `row_count` NULL, which MEANS "attempted".
//   internal-class source FIRE-AND-FORGET. The fetch runs first; the complete row is written after
//                         and never blocks the read. A fetch that throws is still recorded, as an
//                         attempted row. A ledger failure alerts; it never fails the read.
//
// A CALL AROUND THE SEAM. The seam records what goes through it; nothing in it can see a route
// that calls an integration module directly (the kit's fetch fence keeps `fetch()` out of routes,
// not integration calls). The GRANT is what closes that, once the integration module takes part:
// `ctx.readUpstream` hands the thunk a grant that only this file can mint, live only while the
// thunk runs, and an integration module for a registered source takes it as a parameter and calls
// `requireUpstreamGrant(grant, '<source>')` before it fetches. A call made around the seam then
// has no grant to pass — a type error, and at run time the opaque 500. The kit ships no upstream
// integration, so this is a rule for the fork that adds one, held in review: an integration module
// that fetches a registered source without requiring the grant is a bypass. The arming half —
// refusing an agent- or egress-exposed route that reads upstream without the ledger — belongs to
// the route-exposure declaration, not here.
//
// Unlike the d1 stream, this records whether or not `READ_AUDIT` is armed, as the aurora seam does:
// a route that calls it has opted in by calling it, and the client-class posture must not depend on
// a var.
import type { Env } from '../env';
import { d1ErrorCategory } from '../framework/d1ErrorCategory';
import { AppError } from '../framework/errors';
import { rowCountOf } from '../framework/readAudit';
import { logEvent } from '../platform/logEvent';
import { alertReadLedgerFailure, scheduleLedgerWork } from './aurora';
import {
  type ReadLogIntent,
  type ReadSourceClass,
  readLogRepo,
  readLogUpstreamSupport,
} from './readLog';

// ---------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------

/**
 * Every upstream HTTP source this app records reads of, and the trust class of each. THE KIT READS
 * NO UPSTREAM, so this ships empty — a fork adds one line per source, in protected core, under
 * code-owner review, in the same pull request as the integration module that fetches it.
 *
 * The class is a property of the SOURCE, decided once here, never of a read: `client` when the
 * upstream returns client or third-party records (Autobahn's credit reports), `internal` when it
 * returns public or CIAL-internal data (a statistics bureau's series). No individual read can opt a
 * client source into the fire-and-forget path.
 *
 * `satisfies`, not an annotation, for the reason AURORA_SOURCES spells out: an annotation collapses
 * `keyof typeof UPSTREAM_SOURCES` to `string`, and `KnownUpstreamSource` would admit any string.
 */
export const UPSTREAM_SOURCES = Object.freeze({
  // A fork's upstream sources land here, one line each: `autobahn: 'client',`
}) satisfies Readonly<Record<string, ReadSourceClass>>;

/** A source name registered above — `never` in the kit, which reads no upstream. */
export type KnownUpstreamSource = keyof typeof UPSTREAM_SOURCES & string;

/**
 * The identifier shape for every name the seam records — the same rule the table's CHECK enforces
 * on an upstream row: a lowercase letter, then lowercase letters, digits or `_`, at most 64.
 */
export const UPSTREAM_IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;

// ---------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------

/** A registered upstream read. Frozen: what was registered is what the ledger records. */
export interface UpstreamReadSpec {
  /** Which upstream. Its class comes from UPSTREAM_SOURCES, never from the read. */
  readonly source: KnownUpstreamSource;
  /** The registered read id (`report_datablocks`). An identifier, never a URL or a path. */
  readonly name: string;
  /**
   * The DECLARED identifier projection: the NAME of what the read is keyed by (`ticket_key`,
   * `duns`, `series_id`), never the value it took. Required — an upstream read that cannot say
   * what selected its records is a read nobody can audit later.
   */
  readonly target: string;
}

export interface UpstreamReadCtx {
  env: Env;
  /** Actor email or service identifier. Stays app-local — the registry only ever gets counts. */
  principal: string;
  /** The route serving this read, e.g. `GET /api/reports/:ticketKey/data`. */
  route: string;
  /** Correlates every read made while serving one request, d1 and aurora rows included. */
  requestId: string;
  /**
   * Background scheduling. Present on the request path; absent in a cron, where the post-read
   * ledger work is awaited instead so it is not lost when the invocation ends.
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

export interface UpstreamReadOptions<T> {
  /**
   * How many records the result holds, for `row_count`. Default: the ledger's shape heuristic
   * (array → length, `{ items }` → items.length, null/undefined → 0, anything else → 1). Supply one
   * when the upstream answers with an envelope — a `{ status: 'empty' }` is 0 records, not 1. A
   * counter that throws or returns anything but a non-negative integer falls back to the heuristic
   * (logged), because bookkeeping never breaks a read.
   */
  count?: (result: T) => number;
}

// ---------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------

interface Registration {
  readonly sourceClass: ReadSourceClass;
}

/** Registered specs → their resolved class. A spec not in here is refused, whatever it claims. */
const registrations = new WeakMap<object, Registration>();
const registry: UpstreamReadSpec[] = [];
const registeredKeys = new Set<string>();
/** What a TEST registered (`__defineUpstreamReadForTest`) — the only entries a reset forgets. */
const testRegistered = new Set<UpstreamReadSpec>();

type SourceTable = Readonly<Record<string, ReadSourceClass>>;

/** `table[key]` when it is the table's OWN entry and a real class; `undefined` otherwise. */
function ownClass(table: SourceTable, key: string): ReadSourceClass | undefined {
  if (!Object.hasOwn(table, key)) return undefined;
  const cls: unknown = table[key];
  return cls === 'client' || cls === 'internal' ? cls : undefined;
}

/**
 * The class a source's reads run under. For a source the REVIEWED table lists, it is that table's
 * class, always. `synthetic` is how a test names a source the reviewed table does not carry: it can
 * ADD a source, never reclassify a listed one — so nothing that registers a read can move a
 * client upstream onto the fire-and-forget path. Throws on a source neither table carries.
 *
 * Pure: it registers nothing, so exporting it (for the tests that pin this rule against a
 * synthetic reviewed table) hands a caller nothing. `reviewed` is never passed in production.
 */
export function upstreamSourceClass(
  source: string,
  synthetic?: SourceTable,
  reviewed: SourceTable = UPSTREAM_SOURCES,
): ReadSourceClass {
  const listed = ownClass(reviewed, source);
  const offered = synthetic ? ownClass(synthetic, source) : undefined;
  if (listed !== undefined) {
    if (offered !== undefined && offered !== listed) {
      throw new Error(
        `upstream source ${JSON.stringify(source)} is ${listed}-class in UPSTREAM_SOURCES; a ` +
          `synthetic table cannot reclassify it as ${offered} — the class comes from the reviewed ` +
          'table, never from a caller.',
      );
    }
    return listed;
  }
  if (offered !== undefined) return offered;
  throw new Error(
    `unknown upstream source ${JSON.stringify(source)}. Add it to UPSTREAM_SOURCES ` +
      '(src/data/upstream.ts) with its class, under code-owner review — the class comes from the ' +
      'reviewed table, never from the read.',
  );
}

/** One identifier field of a spec, already read ONCE by the caller, checked. */
function identifier(where: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || !UPSTREAM_IDENTIFIER.test(value)) {
    throw new Error(
      `${where}: \`${field}\` must be an identifier like "ticket_key" (a lowercase letter, then ` +
        `lowercase letters, digits or _, at most 64), found ${JSON.stringify(value)}. The ledger ` +
        'records it, and read_log refuses anything else on an upstream row. `target` names the ' +
        'identifier the read is keyed by — never its value.',
    );
  }
  return value;
}

function register(
  spec: UpstreamReadSpec,
  synthetic: SourceTable | undefined,
  forTest: boolean,
): UpstreamReadSpec {
  // Each field is read EXACTLY ONCE, into a local, and only the locals are validated, resolved and
  // frozen. A spec whose getters answer differently on each read (a Proxy) cannot pass validation
  // with one value and be recorded — or classed — with another.
  const rawSource: unknown = spec?.source;
  const rawName: unknown = spec?.name;
  const rawTarget: unknown = spec?.target;
  const where = `Upstream read ${JSON.stringify(rawName)}`;
  const source = identifier(where, 'source', rawSource);
  const name = identifier(where, 'name', rawName);
  const target = identifier(where, 'target', rawTarget);
  let sourceClass: ReadSourceClass;
  try {
    sourceClass = upstreamSourceClass(source, synthetic);
  } catch (err) {
    throw new Error(`${where}: ${(err as Error).message}`);
  }
  const key = `${source}.${name}`;
  if (registeredKeys.has(key)) {
    throw new Error(
      `${where}: ${key} is already registered. One read id names one read — the ledger could not ` +
        'tell two apart.',
    );
  }
  const registered = Object.freeze({ source, name, target }) as UpstreamReadSpec;
  registrations.set(registered, { sourceClass });
  registeredKeys.add(key);
  registry.push(registered);
  if (forTest) testRegistered.add(registered);
  return registered;
}

/**
 * Register an upstream read. Throws AT MODULE LOAD on a malformed spec — defineRoute's and
 * defineAuroraQuery's posture — so a violation is a failed import in CI, not a 500 on the one
 * request that happens to reach it.
 *
 * The class is resolved from UPSTREAM_SOURCES and nothing else: there is deliberately no parameter
 * for another table. Defining a read is protected-core work.
 */
export function defineUpstreamRead(spec: UpstreamReadSpec): UpstreamReadSpec {
  return register(spec, undefined, false);
}

/**
 * TEST-ONLY: register a read against a synthetic source table, for a kit that ships
 * UPSTREAM_SOURCES empty. `sources` can ADD a source; it cannot reclassify one UPSTREAM_SOURCES
 * lists (see `upstreamSourceClass`), so even a misuse outside test/ cannot downgrade a client
 * upstream. What it registers is what `__resetUpstreamRegistryForTest` forgets.
 */
export function __defineUpstreamReadForTest(
  spec: UpstreamReadSpec,
  sources: SourceTable,
): UpstreamReadSpec {
  return register(spec, sources, true);
}

/** Every read registered so far — the walk-test surface, as for registeredAuroraQueries. */
export function registeredUpstreamReads(): ReadonlyArray<UpstreamReadSpec> {
  return registry;
}

/**
 * TEST-ONLY: forget what `__defineUpstreamReadForTest` registered — the walk list, the duplicate
 * guard and the registration itself (a forgotten spec is refused) — so one test's synthetic reads
 * do not leak into the next. A read registered with `defineUpstreamRead` is never forgotten.
 */
export function __resetUpstreamRegistryForTest(): void {
  for (const spec of testRegistered) {
    registrations.delete(spec);
    registeredKeys.delete(`${spec.source}.${spec.name}`);
    const at = registry.indexOf(spec);
    if (at >= 0) registry.splice(at, 1);
  }
  testRegistered.clear();
}

/**
 * The registration, or the opaque refusal. A spec that did not come out of `defineUpstreamRead` —
 * a hand-rolled literal, or a spread copy with a field swapped — carries no class, and guessing one
 * would pick the fire-and-forget path an attacker wants. The registered object itself is frozen,
 * so it cannot be edited in place either.
 */
function registrationOf(spec: UpstreamReadSpec): Registration {
  const mark = spec !== null && typeof spec === 'object' ? registrations.get(spec) : undefined;
  if (!mark) {
    logEvent('upstream_unregistered_spec', {
      spec: typeof spec?.name === 'string' ? spec.name : '?',
    });
    throw internalError();
  }
  return mark;
}

function internalError(): AppError {
  return new AppError(500, 'internal_error', 'Something went wrong');
}

// ---------------------------------------------------------------------------------------
// The grant
// ---------------------------------------------------------------------------------------

/** Never exported: a type outside this file cannot write the brand, so it cannot make a grant. */
declare const GRANT_BRAND: unique symbol;

/**
 * Proof, handed to a read's thunk, that the ledger has cleared THIS read of THIS source — for a
 * client-class source, that its intent row is in. Minted only by `upstreamRead`, frozen, and live
 * only while the thunk's promise is pending: kept past its read, it is refused like a forgery.
 *
 * An integration module for a registered upstream takes it as a parameter and checks it before it
 * fetches, which is what makes a call AROUND `ctx.readUpstream` refusable:
 *
 *     export async function fetchLiveReport(grant: UpstreamGrant, cfg: Cfg, order: Order) {
 *       requireUpstreamGrant(grant, 'autobahn');
 *       …
 *     }
 */
export interface UpstreamGrant {
  readonly source: string;
  readonly name: string;
  readonly [GRANT_BRAND]: true;
}

/** Grants whose read is still running. A WeakSet: a grant carries nothing and holds nothing. */
const liveGrants = new WeakSet<object>();

/**
 * For an integration module: refuse unless `grant` is a live grant for `source` — i.e. unless this
 * call is running inside `ctx.readUpstream` (or `upstreamRead`) for a read of that source. Anything
 * else — a literal, a cast, a grant kept past its read, a grant for another source, nothing — logs
 * `upstream_grant_refused` and throws the kit's opaque 500, BEFORE the integration fetches.
 */
export function requireUpstreamGrant(grant: UpstreamGrant, source: KnownUpstreamSource): void {
  const live = grant !== null && typeof grant === 'object' && liveGrants.has(grant);
  if (live && grant.source === source) return;
  logEvent('upstream_grant_refused', { source });
  throw internalError();
}

/** Run `read` holding a fresh grant for `spec`, and revoke it the moment `read` settles. */
async function withGrant<T>(
  spec: UpstreamReadSpec,
  read: (grant: UpstreamGrant) => Promise<T>,
): Promise<T> {
  // The brand is a type-level fact only (no property is written); the WeakSet is the runtime one.
  const grant = Object.freeze({ source: spec.source, name: spec.name }) as unknown as UpstreamGrant;
  liveGrants.add(grant);
  try {
    return await read(grant);
  } finally {
    liveGrants.delete(grant);
  }
}

// ---------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------

/**
 * The remedy an alert names when the ledger refuses an upstream row because the database is older
 * than the code. A fixed sentence — never anything taken from the error.
 */
export const UPSTREAM_SCHEMA_REMEDY =
  'read_log does not accept upstream rows yet: apply migrations/d1/0005_read_log_upstream.sql ' +
  '(forks: copy it and renumber it to your next free ordinal; a fork without read_log adopts ' +
  '0001 and 0002 first). Client-class upstream reads are refused until then.';

/**
 * Raise a ledger failure through the read-ledger alert, naming the 0005 remedy ONLY when the
 * database is older than the code. That is ASKED of the database (`readLogUpstreamSupport`), never
 * guessed from the error: a NOT NULL failure, a trigger abort or a fork's own constraint on a
 * database that HAS applied 0005 is a constraint failure too, and pointing its operator at a
 * migration that already ran sends them to the wrong fix mid-outage. The probe runs here, in the
 * background alert work, so a refusal never waits on it. Nothing from the error is logged or sent
 * beyond its class.
 */
async function raiseLedgerFailure(
  ctx: UpstreamReadCtx,
  stage: 'write_ahead' | 'flush',
  intent: ReadLogIntent,
  err: unknown,
): Promise<unknown> {
  const drift = (await readLogUpstreamSupport(ctx.env.DB)) === 'refused';
  if (drift) {
    logEvent('upstream_read_schema_drift', { remedy: 'apply_migration_0005_read_log_upstream' });
  }
  return alertReadLedgerFailure(
    ctx.env,
    stage,
    intent,
    err,
    drift ? UPSTREAM_SCHEMA_REMEDY : undefined,
  );
}

/**
 * Run an upstream read, recording it in the read ledger. See the header for the posture; the
 * ordering below IS the security property — for a client-class source `read` is not called until
 * the intent row is in, and test/data/upstream.test.ts asserts that directly.
 */
export async function upstreamRead<T>(
  ctx: UpstreamReadCtx,
  spec: UpstreamReadSpec,
  read: (grant: UpstreamGrant) => Promise<T>,
  opts: UpstreamReadOptions<T> = {},
): Promise<T> {
  const { sourceClass } = registrationOf(spec);
  const ledger = readLogRepo(ctx.env.DB);
  const intent: ReadLogIntent = {
    id: crypto.randomUUID(),
    request_id: ctx.requestId,
    principal: ctx.principal,
    app: ctx.env.APP_NAME,
    env: ctx.env.APP_ENV,
    route: ctx.route,
    kind: 'upstream',
    source: spec.source,
    source_class: sourceClass,
    view: null,
    query_name: spec.name,
    target: spec.target,
    // Note what is NOT here, and cannot be: the URL, the query string, the identifier VALUE the
    // fetch was made with. ReadLogIntent has no field for any of them.
  };
  const labels = { source: spec.source, spec: spec.name };

  if (sourceClass === 'client') {
    // WRITE-AHEAD. Awaited before the upstream is contacted.
    try {
      await ledger.insertIntent(intent);
    } catch (err) {
      logEvent('upstream_read_write_ahead_failed', {
        ...labels,
        category: d1ErrorCategory(err),
        err,
      });
      // Not awaited: the refusal must not wait on the drift probe or an alert fanout.
      void scheduleLedgerWork(ctx, raiseLedgerFailure(ctx, 'write_ahead', intent, err));
      // Fail CLOSED: the kit's opaque 500, and the upstream is never called. Decision D3.
      throw internalError();
    }

    // A throw here propagates unchanged and leaves the intent's row_count NULL — "attempted". The
    // grant exists only from here on: after the intent row is in.
    const result = await withGrant(spec, read);
    await scheduleLedgerWork(
      ctx,
      ledger.patchRowCount(intent.id, countOf(result, labels, opts.count)).catch((err) => {
        logEvent('upstream_read_count_patch_failed', { ...labels, err });
        return alertReadLedgerFailure(ctx.env, 'count_patch', intent, err);
      }),
    );
    return result;
  }

  // INTERNAL-CLASS. The read never waits on the ledger; the row is written after, either way.
  let result: T;
  try {
    result = await withGrant(spec, read);
  } catch (err) {
    // The fetch was authorized and started; its outcome is unknown to the ledger. Recorded as
    // ATTEMPTED (row_count NULL) — the d1 stream's rule for a rejected read — then rethrown as is.
    await scheduleLedgerWork(ctx, ledger.insertIntent(intent).catch(flushFailed(ctx, intent)));
    throw err;
  }
  await scheduleLedgerWork(
    ctx,
    ledger
      .insertComplete(intent, countOf(result, labels, opts.count))
      .catch(flushFailed(ctx, intent)),
  );
  return result;
}

function flushFailed(ctx: UpstreamReadCtx, intent: ReadLogIntent) {
  return (err: unknown) => {
    logEvent('upstream_read_flush_failed', {
      source: intent.source,
      spec: intent.query_name ?? '?',
      err,
    });
    return raiseLedgerFailure(ctx, 'flush', intent, err);
  };
}

/**
 * `row_count` for a result: the caller's counter when it gives a real count, else the heuristic.
 * Never throws — it runs after the fetch has answered, and bookkeeping never breaks a read. A result
 * even the heuristic cannot read (a hostile getter) counts as 1: "this read touched something",
 * never 0, which would claim it found nothing.
 */
function countOf<T>(
  result: T,
  labels: { source: string; spec: string },
  count: ((result: T) => number) | undefined,
): number {
  if (count) {
    try {
      const n = count(result);
      if (Number.isSafeInteger(n) && n >= 0) return n;
      logEvent('upstream_read_count_failed', { ...labels, reason: 'not_a_count' });
    } catch (err) {
      logEvent('upstream_read_count_failed', { ...labels, reason: 'threw', err });
    }
  }
  try {
    return rowCountOf(result);
  } catch (err) {
    logEvent('upstream_read_count_failed', { ...labels, reason: 'threw', err });
    return 1;
  }
}
