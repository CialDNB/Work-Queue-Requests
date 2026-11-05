// READ ATTRIBUTION FOR ORDINARY D1 READS (Fleet Ledger K2b) — the `recordDb` proxy the framework
// wraps `ctx.db` in when `READ_AUDIT` is armed.
//
// K2a closed the private-database half: `auroraQuery` is the only path to a Hyperdrive binding
// and it records every read. This is the other half. An app's own D1 holds real data too, and a
// route reads it with `ctx.db.users.list()` — no seam, no spec, nothing to hook. So the hook goes
// where every request already passes: `executeRoute` builds the handler's data view, and when the
// app has armed the ledger it wraps that view in this proxy first. HTTP and MCP inherit it for
// free (both adapters are thin shells over `executeRoute`), and a route author cannot forget it
// because there is nothing to remember.
//
// ── WHAT THIS IS NOT ──────────────────────────────────────────────────────────────────────
// It is NOT a security boundary. A handler that reaches around `ctx.db` is stopped by the
// semgrep data fence, not by this. This is an ATTRIBUTION control: it answers "who read what,
// through which route" after the fact. Treating it as prevention would be a category error.
// ──────────────────────────────────────────────────────────────────────────────────────────
//
// ── FOUR PROPERTIES, EACH LOAD-BEARING ────────────────────────────────────────────────────
//
// 1. THE UNARMED PATH IS UNCHANGED. `READ_AUDIT` unset ⇒ `executeRoute` never calls into this
//    module and the handler receives the very object it received before K2b — no proxy, no
//    wrapper, no allocation. That is the same posture `scopeDb` takes for a route without
//    `needs`, and it is pinned the same way: `readRecorderOf()` returns `undefined`, so
//    "nothing wrapped it" is a fact CI checks rather than a claim in a PR body.
//
// 2. IT WRAPS *OUTSIDE* `scopeDb`. The composition is `recordDb(scopeDb(db))`, never the other
//    way round. A `needs` denial throws from the scoped view's `get` trap, which happens BELOW
//    this proxy — so a repository the route was refused is never recorded as a read. Recording
//    a refusal as an access would put a lie in the ledger, which is worse than a gap: a gap is
//    visibly a gap.
//
// 3. UNKNOWN METHODS COUNT AS READS. Classification is two lists of names that are definitely
//    WRITES: the kit's own `WRITE_METHOD_NAMES`, and whatever a repository declares about itself
//    under `DECLARED_WRITES` (src/data/declaredWrites.ts). Everything else records. A fork's new
//    `findByTaxId()` is attributed from the day it is written, with nobody having to remember to
//    register it. The failure mode of the opposite default — a read that quietly records nothing
//    — is invisible and permanent; the failure mode of this one is a spare row for a write, which
//    is legible and cheap, and test/isolation/declared-writes.test.ts turns the common case of it
//    (an undeclared `upsert*` / `insert*` / `delete*` / `replace*` / `bulk*`) into a red test.
//
// 4. A BUG HERE MUST NOT BREAK READS. This proxy sits on the hot path of every request of every
//    armed app, so every step except the call-through itself is wrapped: a throw from
//    classification, from the row-count heuristic, or from the recorder degrades to "not
//    recorded", never to a failed request. The call-through is deliberately NOT guarded — the
//    handler's own errors, and the `scopeDb` denial, must propagate exactly as they do today.
//
// ── DECISION D6 HOLDS BY SHAPE, AGAIN ─────────────────────────────────────────────────────
// This proxy sees every repository method's ARGUMENTS. `ReadEvent` has nowhere to put them:
// its fields are the repository name, the method name, and a row count. `args` is read for
// nothing but `Reflect.apply`. A patch that records "just the id, for debugging" has to add a
// field here, a column in `schema.sql`, and defeat the pin in test/data/read-log.test.ts — all
// in CODEOWNERS-gated files. That cost is the mechanism.
import { sendViaAlertSeam } from '../cron/alert';
import { declaredWritesOf } from '../data/declaredWrites';
import type { ReadLogIntent } from '../data/readLog';
import type { Env } from '../env';
import { LOGS_CARRY_CLASS_ONLY, logEvent } from '../platform/logEvent';
import { rateLimit } from '../security/rateLimit';
import { D1_ERROR_CATEGORY_MEANING, d1ErrorCategory } from './d1ErrorCategory';
import { isReadAuditArmed, READ_AUDIT_ARMED, READ_AUDIT_VAR } from './readAuditVocabulary.mjs';

/**
 * The one thing the flush needs from the data layer. Taken as a PARAMETER rather than built from
 * `env.DB` here: `env.DB` outside `src/data/` fails the semgrep data fence, and rightly so — the
 * framework already holds a `makeDb()` result for its own audit writes and hands the same
 * `readLog` repository in. Structural rather than `Db['readLog']` so a test can inject a writer
 * that fails, which is the only way to exercise the fail-open path honestly.
 */
export interface ReadLedgerWriter {
  insertManyComplete(
    rows: readonly { intent: ReadLogIntent; rowCount: number | null }[],
  ): Promise<void>;
}

/**
 * The arming vocabulary, re-exported so it keeps reading as a fact about the framework at every
 * existing call site. It is DEFINED in readAuditVocabulary.mjs, which
 * `scripts/check-edge-hardening.mjs` imports too — the gate that refuses a client-class private
 * database in an unarmed config and this runtime now read the same constants and the same
 * comparison rather than spellings that happen to match. See that file for why it is plain
 * JavaScript.
 *
 * `isReadAuditArmed` rides along deliberately, even with no TypeScript caller yet. It is the
 * ANSWER to the question a future `src/cron/` or `src/mcp/` module will have — "is this raw value
 * armed?" — and a module that finds only `READ_AUDIT_ARMED` here writes `v === READ_AUDIT_ARMED`,
 * which is a fourth comparison nothing watches. Every prohibition needs a named legal way to do
 * the legitimate thing (DECISIONS 2026-08-20); this is that way, reachable from the module a
 * framework consumer already imports.
 */
export { isReadAuditArmed, READ_AUDIT_ARMED, READ_AUDIT_VAR };

/**
 * Is the read ledger armed for this app? The var is the app's DECLARATION that it has adopted
 * read attribution — `npm run verify:edge` refuses a client-class binding in a config that has
 * not set it (scripts/check-edge-hardening.mjs). Kept as one exported predicate so the framework
 * and the tests agree on what "armed" means.
 *
 * Everything the gate could disagree with is delegated: the var NAME (indexed by
 * `READ_AUDIT_VAR` rather than written `env.READ_AUDIT`, so a rename that reaches only one side
 * stops type-checking here) and the comparison itself (`isReadAuditArmed`). What is left is the
 * only part that legitimately differs — reading the value off a live `Env`.
 */
export function readAuditArmed(env: Env): boolean {
  return isReadAuditArmed(env[READ_AUDIT_VAR]);
}

/**
 * The KIT's repository method names that MUTATE. Everything not on this list, and not declared by
 * its own repository under `DECLARED_WRITES`, is treated as a read — see property 3 in the header.
 * Every entry is a method that exists in the kit's `src/data/` today and is unambiguously a write;
 * adding a name here is a decision to stop attributing it, so the list grows only for methods that
 * genuinely write.
 *
 * A name here applies to EVERY repository, a fork's included, which is why it holds only the
 * kit's own names. A fork does not add to it: it declares its writes on the repository that owns
 * them (src/data/declaredWrites.ts), where the declaration applies to that repository alone and
 * travels with it. An undeclared fork write costs one spare ledger row per call and nothing else,
 * which is the direction the error is allowed to point.
 */
export const WRITE_METHOD_NAMES: ReadonlySet<string> = new Set([
  'add',
  'addMember',
  'adjust',
  'claim',
  'create',
  'insert',
  'insertComplete',
  'insertIntent',
  'insertManyComplete',
  'insertUsage',
  'patchRowCount',
  'pruneExpired',
  'pruneOlderThan',
  'remove',
  'removeMember',
  'rename',
  'revoke',
  'revokeAllForOwner',
  'setAlerting',
  'setCustodian',
  'setDisabled',
  'setLogin',
  'setRole',
  'touchLastUsed',
  'tryReserve',
  'update',
]);

/**
 * One recorded read. NO FIELD CAN CARRY A BIND VALUE — see the header. `rowCount: null` means
 * the call rejected: the read was authorized and started and its outcome is unknown, which is
 * exactly what a NULL `row_count` already means in `read_log` (Decision D3).
 */
interface ReadEvent {
  repo: string;
  method: string;
  rowCount: number | null;
}

/**
 * Per-request collector. Created by `beginReadAudit`, filled by the proxy, drained once by
 * `flushReadAudit`.
 *
 * `closed` exists because a handler can leave a read in flight — a floating promise it never
 * awaited, or one it handed to `ctx.waitUntil`. Its `.then` recorder can therefore fire AFTER the
 * flush has already scheduled its batch. Appending to a drained array would silently lose the
 * event and, worse, grow an array nobody will ever read again. Closing makes the late event a
 * counted, logged drop instead of a leak.
 */
export interface ReadRecorder {
  readonly events: ReadEvent[];
  readonly route: string;
  readonly principal: string;
  readonly requestId: string;
  closed: boolean;
  /** Reads that arrived after the flush, or that overflowed the cap. Surfaced in the log line. */
  dropped: number;
  /**
   * Every read recorded before the flush closed the recorder: repeats folded into an existing
   * event and reads over the cap included. `events.length` counts ledger ROWS, and aggregation makes
   * that far smaller than the number of calls, so this is the count a failed flush reports as
   * "reads missing".
   */
  reads: number;
  /**
   * `events`, indexed by the aggregation key so a repeat read is O(1) to find. Held on the
   * recorder rather than closed over, because `record()` is a free function and the recorder is
   * the only per-request object it is handed. Cleared alongside the splice, by `flushReadAudit`
   * and by `discardReadAudit`.
   */
  readonly index: Map<string, ReadEvent>;
}

/**
 * Hard ceiling on DISTINCT read shapes collected per request. Identical `(repo, method)` reads
 * aggregate into one event (see `record`), so a hundred polls of one method cost one slot, while
 * a pathological handler reaching 200 different shapes still trips this and is still counted as
 * `dropped` and logged. Counting shapes rather than calls is the meaningful budget: the ledger is
 * supposed to make an app observable, not to be the thing that takes it down. Over the cap, reads
 * still HAPPEN normally.
 */
export const MAX_READ_EVENTS_PER_REQUEST = 200;

/**
 * Open a recorder for one request. `requestId` is what each of its ledger rows carries in
 * `request_id`: executeRoute passes the ONE id it decides per call, which ctx.readUpstream's rows
 * (PIA C15) carry too, so a call's d1 and upstream reads group under one id — an agent call's TURN
 * id (src/framework/invocation.ts), so all the reads of one turn correlate under it, and a fresh
 * uuid otherwise. A fresh uuid when omitted. An identifier by contract (the turn id is
 * pattern-checked before it gets here) — never anything a caller wrote.
 */
export function beginReadAudit(
  principal: string,
  route: string,
  requestId: string = crypto.randomUUID(),
): ReadRecorder {
  return {
    events: [],
    route,
    principal,
    requestId,
    closed: false,
    dropped: 0,
    reads: 0,
    index: new Map(),
  };
}

/** The brand a recorded view carries, so tests can prove the unarmed path wrapped nothing. */
export const READ_AUDITED = Symbol('kit.readAudit');

/**
 * The recorder behind a recorded `ctx.db`, or `undefined` for an unrecorded view. This is how the
 * tests prove the unarmed path is byte-identical: it must return `undefined`, i.e. nothing
 * wrapped the data view at all.
 */
export function readRecorderOf(db: object): ReadRecorder | undefined {
  return (db as Record<symbol, ReadRecorder | undefined>)[READ_AUDITED];
}

/**
 * Row count from a repository return value, over the kit's REAL page shapes:
 *
 *   an array                      → its length      (`listMembers`, `sinceHours`, `listForUser`)
 *   `{ items: [...] }`            → items.length    (`list` on notes / users / audit / read_log)
 *   `null` / `undefined`          → 0               (`get` missing, `getAlerting` unset)
 *   anything else                 → 1               (a single row, a scalar, a boolean)
 *
 * A HEURISTIC, and named as one. It is right for every shape `src/data/` returns today and it
 * degrades honestly rather than cleverly: an unfamiliar shape reports 1, which says "this read
 * touched something" — never 0, which would say "this read found nothing" about a read that may
 * well have returned a thousand rows. Under-reporting a count on an attribution surface is the
 * failure worth avoiding.
 */
export function rowCountOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value === null || value === undefined) return 0;
  if (typeof value === 'object') {
    const items = (value as { items?: unknown }).items;
    if (Array.isArray(items)) return items.length;
  }
  return 1;
}

/**
 * THE AGGREGATION KEY. Identical `(repo, method)` reads within one request collapse into one
 * ledger row with `row_count` summed: the row already says who read which repository, by which
 * method, through which route, and how many rows it touched, and a hundred copies of that add
 * nothing. It applies to every request alike, because a mechanism that fired only for some shape
 * of handler (a polling loop, a stream) would be a second code path to keep correct forever.
 *
 * The third component is the ATTEMPTED flag, and it is not cosmetic. `rowCount: null` means the
 * read was authorized and started and its outcome is unknown (`readLog.listAttempted()` surfaces
 * exactly those), and a null cannot be summed into a count without inventing one. So a method
 * that both succeeded and rejected inside one request writes two rows: the summed count, and the
 * NULL. A space separates the parts: it cannot occur in an identifier, and repository and method
 * names are identifiers, so no pair of them can collide by concatenation.
 *
 * Ported from insights (CialDNB/insights#97), unchanged in behaviour.
 */
function aggregationKey(repo: string, method: string, rowCount: number | null): string {
  return `${repo} ${method} ${rowCount === null ? 'attempted' : 'counted'}`;
}

function record(recorder: ReadRecorder, repo: string, method: string, rowCount: number | null) {
  if (recorder.closed) {
    recorder.dropped += 1;
    return;
  }
  recorder.reads += 1;
  const key = aggregationKey(repo, method, rowCount);
  const existing = recorder.index.get(key);
  if (existing) {
    // A repeat of a shape already in the batch. It adds no row, so it is NOT measured against the
    // cap: the cap bounds the D1 batch, and this does not grow it.
    if (rowCount !== null) existing.rowCount = (existing.rowCount ?? 0) + rowCount;
    return;
  }
  // A NEW shape. This one does grow the batch, so this is where the cap applies.
  if (recorder.events.length >= MAX_READ_EVENTS_PER_REQUEST) {
    recorder.dropped += 1;
    return;
  }
  const event: ReadEvent = { repo, method, rowCount };
  recorder.events.push(event);
  recorder.index.set(key, event);
}

/** Cheap duck-check for a promise, so a synchronous repository method is handled too. */
function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as PromiseLike<unknown>).then === 'function'
  );
}

function wrapMethod(
  fn: (...args: unknown[]) => unknown,
  repo: string,
  method: string,
  recorder: ReadRecorder,
): (...args: unknown[]) => unknown {
  return function recorded(this: unknown, ...args: unknown[]): unknown {
    // THE CALL-THROUGH. Deliberately outside every try/catch in this module: a repository's own
    // error is the handler's business and must reach it unchanged. `this` is forwarded so a
    // repository method that closes over its object keeps working.
    const result = Reflect.apply(fn, this, args);

    // Everything from here down is bookkeeping, and bookkeeping never breaks a read.
    try {
      if (!isThenable(result)) {
        record(recorder, repo, method, rowCountOf(result));
        return result;
      }
      return Promise.resolve(result).then(
        (value) => {
          try {
            record(recorder, repo, method, rowCountOf(value));
          } catch (err) {
            logEvent('read_audit_record_failed', { repo, method, err });
          }
          return value;
        },
        (err: unknown) => {
          try {
            // NULL row_count = ATTEMPTED. The read was authorized and started; its outcome is
            // unknown. Same meaning the aurora write-ahead path gives an unpatched row, and
            // `listAttempted()` already surfaces both.
            record(recorder, repo, method, null);
          } catch (recErr) {
            logEvent('read_audit_record_failed', { repo, method, err: recErr });
          }
          throw err;
        },
      );
    } catch (err) {
      logEvent('read_audit_wrap_failed', { repo, method, err });
      return result;
    }
  };
}

/**
 * The repository's own write declaration, read ONCE when it is wrapped. Isolated like every other
 * piece of bookkeeping here (property 4): a declaration that cannot be read declares nothing, so
 * the repository's writes record as reads — a spare row — and the repository itself is still
 * wrapped and still records its reads. Failing the other way, by leaving the repository unwrapped,
 * would turn a classification glitch into an attribution gap.
 */
function declaredWritesSafe(repo: object, repoName: string): ReadonlySet<string> {
  try {
    return declaredWritesOf(repo);
  } catch (err) {
    logEvent('read_audit_declared_writes_failed', { repo: repoName, err });
    return new Set();
  }
}

/**
 * Wrap ONE repository so its read methods record. Memoised by the caller, so `ctx.db.notes` is
 * the same object every time a handler reads it (`ctx.db.notes === ctx.db.notes`) — an identity
 * a handler is entitled to assume, and one that a fresh proxy per property access would break.
 *
 * A method is left unwrapped, and so unrecorded, when its name is on the kit's
 * `WRITE_METHOD_NAMES` or on THIS repository's `DECLARED_WRITES`. The declaration is per
 * repository: `apps.upsertStatus` declared on `apps` says nothing about an `upsertStatus` on any
 * other repository.
 */
function wrapRepo(repo: object, repoName: string, recorder: ReadRecorder): object {
  const methods = new Map<string, unknown>();
  const declaredWrites = declaredWritesSafe(repo, repoName);
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      try {
        if (typeof prop !== 'string' || typeof value !== 'function') return value;
        if (WRITE_METHOD_NAMES.has(prop) || declaredWrites.has(prop)) return value;
        const cached = methods.get(prop);
        if (cached) return cached;
        const wrapped = wrapMethod(value as (...a: unknown[]) => unknown, repoName, prop, recorder);
        methods.set(prop, wrapped);
        return wrapped;
      } catch (err) {
        logEvent('read_audit_repo_wrap_failed', { repo: repoName, method: String(prop), err });
        return value;
      }
    },
  });
}

/**
 * The recording view of a data layer. `T` is whatever `executeRoute` already built — the full
 * `Db`, or the `Pick<Db, N>` that `scopeDb` produced — and the return type is the SAME type, so
 * a route's declared `needs` narrowing survives this wrapper untouched.
 *
 * Ordering note (property 2 in the header): this must wrap the SCOPED view, not the raw `Db`.
 * The scoped view's `get` trap throws for an undeclared repository, and that throw travels
 * straight through the `Reflect.get` below — before anything has been recorded.
 *
 * ONE TRAP, DELIBERATELY. `scopeDb` also traps `getOwnPropertyDescriptor`, because a handler
 * reading `Object.getOwnPropertyDescriptor(ctx.db, 'users').value` would otherwise walk straight
 * past its `get` denial — and `scopeDb` is a boundary that has to hold against that. This is not:
 * it is attribution, and the same descriptor read here yields an unrecorded repository. That is a
 * deliberate evasion, not an accident of ordinary code (spread, `Object.entries`, `Object.values`
 * and `Object.assign` all route through [[Get]] and ARE recorded), and what actually keeps a
 * handler on the sanctioned path is the semgrep data fence. Say so wherever the ledger is
 * presented as complete — see the "honest limits" section of docs/DATA-ROUTES.md.
 */
export function recordDb<T extends object>(db: T, recorder: ReadRecorder): T {
  const repos = new Map<string, object>();
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === READ_AUDITED) return recorder;
      // May THROW — a `scopeDb` denial for a repository this route did not declare. Outside the
      // try below on purpose: the denial is the framework working, and swallowing it here would
      // turn `needs` back into advice.
      const value = Reflect.get(target, prop, receiver);
      try {
        if (typeof prop !== 'string' || value === null || typeof value !== 'object') return value;
        // Own properties of a makeDb() result ARE the repositories. Anything else — an inherited
        // member, a `then` probe — is left exactly as it is.
        if (!Object.hasOwn(db, prop)) return value;
        const cached = repos.get(prop);
        if (cached) return cached;
        const wrapped = wrapRepo(value, prop, recorder);
        repos.set(prop, wrapped);
        return wrapped;
      } catch (err) {
        logEvent('read_audit_view_wrap_failed', { repo: String(prop), err });
        return value;
      }
    },
  }) as T;
}

/**
 * Turn the collected events into ledger rows and write them in ONE batch.
 *
 * FAIL-OPEN, matching audit-on-write (DECISIONS 2026-08-03) and the aurora INTERNAL-class path.
 * D1 reads are internal-class by definition — this is the app's own database — so Decision D3's
 * write-ahead, fail-CLOSED posture does not apply and must not be imitated here: refusing to
 * serve a page because the ledger is briefly unwritable would trade a real outage for a metadata
 * gap. The gap is instead made loud, through the same throttled ops seam an audit-write failure
 * uses.
 *
 * Never throws and never rejects, so the returned promise is always safe for `waitUntil`.
 */
export async function flushReadAudit(
  env: Env,
  ledger: ReadLedgerWriter,
  recorder: ReadRecorder,
): Promise<void> {
  recorder.closed = true;
  const events = recorder.events.splice(0, recorder.events.length);
  // The index points into the array just drained. Left behind, a second flush would aggregate
  // into detached objects nobody will ever write. `closed` already blocks every later record, so
  // this is hygiene rather than a second guard.
  recorder.index.clear();
  if (recorder.dropped > 0) {
    // Not an alert: a busy handler is not an incident, and this must not page. It is the one
    // place the cap becomes visible, so an operator wondering why a route's counts look low has
    // something to grep for.
    logEvent('read_audit_events_dropped', { route: recorder.route, dropped: recorder.dropped });
  }
  if (events.length === 0) return;
  try {
    await ledger.insertManyComplete(
      events.map((e) => ({
        intent: intentFor(env, recorder, e),
        rowCount: e.rowCount,
      })),
    );
  } catch (err) {
    // The category rides the log line as well as the alert: the alert is throttled, and a failure
    // it suppresses leaves its category here or nowhere. One literal from a fixed list.
    logEvent('read_audit_flush_failed', {
      route: recorder.route,
      events: events.length,
      category: d1ErrorCategory(err),
      err,
    });
    // The READ count, not `events.length`: aggregation folds repeats into one row, and the alert
    // is the owner's measure of how much went missing from the trail.
    await alertReadAuditFlushFailure(env, recorder.route, recorder.reads, err);
  }
}

/**
 * The ledger row for one event. `source` is the REPOSITORY name and `query_name` the METHOD name
 * — both identifiers lifted from the code, so the ledger reads as `notes.list` rather than as
 * anything a caller supplied. `view` is null: an ordinary D1 read declares no view, which is
 * exactly why K2b relaxed that column (migrations/d1/0002_read_log_kind.sql).
 *
 * `source_class` is `internal` for every d1 row, unconditionally. This is the app's own database;
 * the class axis exists for private databases whose grant was reviewed, and `kind` — not
 * `source_class` — is what tells the two streams apart.
 */
function intentFor(env: Env, recorder: ReadRecorder, event: ReadEvent): ReadLogIntent {
  return {
    id: crypto.randomUUID(),
    request_id: recorder.requestId,
    principal: recorder.principal,
    app: env.APP_NAME,
    env: env.APP_ENV,
    route: recorder.route,
    kind: 'd1',
    source: event.repo,
    source_class: 'internal',
    view: null,
    query_name: event.method,
    target: null,
    // Note what is NOT here and cannot be: the method's arguments. `ReadEvent` never carried
    // them and `ReadLogIntent` has no field that would take them (Decision D6).
  };
}

/**
 * One alert per app per window. A D1 outage hits every armed request at once; an unthrottled
 * fanout would flood the shared webhook and rate-limit away the cron-failure page riding the same
 * channel — the same reasoning as the framework's audit-failure throttle and the aurora seam's.
 */
const READ_AUDIT_ALERT_WINDOW_SEC = 15 * 60;

/**
 * Never throws. Carries the ROUTE, the error CLASS and the error CATEGORY — one literal from the
 * fixed list in d1ErrorCategory.ts, so an owner can tell contention from a real bug without opening
 * logs — and never the message, which on a D1 failure can embed SQL fragments and bound values, and
 * this fans out to email and a third-party webhook. The principal is omitted for the same reason
 * the fleet digests omit it. `count` is the number of READS the request made before its flush
 * (`ReadRecorder.reads`), not the rows they folded into.
 */
export async function alertReadAuditFlushFailure(
  env: Env,
  route: string,
  count: number,
  err: unknown,
): Promise<void> {
  let fresh = true;
  try {
    fresh = (await rateLimit(env, 'alert:read_audit_fail', 1, READ_AUDIT_ALERT_WINDOW_SEC)).ok;
  } catch {
    // KV down as well — alert anyway. Noise beats silence when everything is failing at once.
  }
  if (!fresh) {
    logEvent('read_audit_alert_suppressed', { route });
    return;
  }
  const errClass = err instanceof Error ? err.name : 'error';
  const category = d1ErrorCategory(err);
  const subject = `[${env.APP_NAME}/${env.APP_ENV}] read ledger FAILED (d1 flush): ${route}`;
  const text =
    `The read-attribution ledger could not record ordinary D1 reads.\n\n` +
    `route: ${route}\nreads missing: ${count}\nerror class: ${errClass}\n` +
    `error category: ${category}\nwhat it means: ${D1_ERROR_CATEGORY_MEANING[category]}\n\n` +
    `The request COMPLETED and its data was returned — D1 reads are internal-class and never ` +
    `block on the ledger (fail-open, DECISIONS 2026-08-03). Those reads are missing from the ` +
    `trail until read_log is writable again.\n\nCheck /_health. ${LOGS_CARRY_CLASS_ONLY}`;
  const slack =
    `:rotating_light: [${env.APP_NAME}/${env.APP_ENV}] read ledger FAILED (d1 flush) on ` +
    `\`${route}\` (${count} reads, ${errClass}, error category: ${category}) — request completed, ` +
    `trail incomplete.`;
  await sendViaAlertSeam(env, 'read_audit_fail', { subject, text }, slack).catch(() => {
    // The seam already logged its own failure with detail; this catch only guarantees the
    // returned promise never rejects.
    logEvent('read_audit_alert_failed');
  });
}

/**
 * Close a recorder WITHOUT writing it: the exit of a machine write whose declared audit row has
 * landed (the machine-write exemption in src/framework/machine.ts, DECISIONS 2026-09-24).
 * executeRoute is the only caller, and only once that row is in. It drains exactly as
 * flushReadAudit does, so a read that resolves later (a floating promise) is a counted drop, never
 * a leak, and nothing reaches the ledger: no rows, no ledger write, and no "read ledger FAILED"
 * alert for the batch.
 */
export function discardReadAudit(recorder: ReadRecorder): void {
  recorder.closed = true;
  recorder.events.splice(0, recorder.events.length);
  recorder.index.clear(); // as flushReadAudit: hygiene, since `closed` blocks every later record
}
