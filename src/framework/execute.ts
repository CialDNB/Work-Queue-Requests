// THE SHARED EXECUTION CORE of the paved road. The HTTP entry (`handle()` in defineRoute.ts),
// the MCP tool adapter (src/mcp/tools.ts) and the in-app agent's tools (buildAgentTools,
// src/framework/agentTools.ts) are all thin adapters over this one function:
// it runs the permission check, the per-principal abuse ceiling, input validation, the handler,
// and audit-on-write — in that fixed order — and throws an AppError on any refusal, which each
// adapter renders in its own transport shape. Extracting it is WHY an MCP tool inherits the exact
// same enforcement as an HTTP route: there is one pipeline, not a copy that can drift. It is also
// the ONLY caller of a route's handler: semgrep `agent-dispatch-bypass` fails CI on any other.
//
// Ordering is load-bearing: permission is checked BEFORE any input is built or validated, so a
// forbidden caller never receives validation feedback that would reveal a route it can't see
// (404-uniformity). buildRawInput() is therefore a thunk the adapter supplies, invoked here only
// after the permission + rate checks pass.
import type { z } from 'zod';
import { authorityWithholds, principalMayCall } from '../auth/permissions';
import type { PersonPrincipal, Principal, ServicePrincipal } from '../auth/types';
import { sendViaAlertSeam } from '../cron/alert';
import { makeDb } from '../data';
import { upstreamRead } from '../data/upstream';
import type { Env } from '../env';
import { LOGS_CARRY_CLASS_ONLY, logEvent } from '../platform/logEvent';
import { rateLimit } from '../security/rateLimit';
import { D1_ERROR_CATEGORY_MEANING, d1ErrorCategory } from './d1ErrorCategory';
import type { RouteCtx, RouteSpec } from './defineRoute';
import { badRequest, notFound, tooManyRequests } from './errors';
import {
  auditPayloadJson,
  checkedInvocation,
  type Invocation,
  readLedgerRequestId,
} from './invocation';
import {
  isExemptMachineWrite,
  machineAuditPayload,
  machineRowAttributes,
  readSyncRun,
  SYNC_RUN_HEADER,
  syncRunMode,
} from './machine';
import {
  beginReadAudit,
  discardReadAudit,
  flushReadAudit,
  type ReadLedgerWriter,
  type ReadRecorder,
  readAuditArmed,
  recordDb,
} from './readAudit';
import { flushWhenBodyEnds, readAuditStreamTimeoutMs } from './readAuditStream';
import { scopeDb } from './scopedDb';

export interface ExecuteOpts {
  /** Client IP written on audit rows ('' when unknown, e.g. a non-HTTP adapter). */
  ip: string;
  /** Path-param values, used only for the audit-target default (the resource the caller named). */
  params: Record<string, string>;
  /** Exposed as ctx.request; HTTP passes the real Request, other adapters a synthetic one. */
  request: Request;
  waitUntil: (p: Promise<unknown>) => void;
  /**
   * Builds the raw (pre-validation) input object. Invoked AFTER the permission + rate checks, so a
   * forbidden caller triggers no parsing and a malformed-body error can never precede the 404. The
   * HTTP adapter merges body+query+params here; the MCP adapter returns the tool arguments.
   */
  buildRawInput: () => Promise<unknown> | unknown;
  /**
   * Which surface is calling, and for the in-app agent which turn (src/framework/invocation.ts).
   * REQUIRED, and set only by an adapter: the HTTP adapter passes `{ via: 'http' }`, the MCP
   * adapter `{ via: 'mcp' }`, the agent's tools `{ via: 'agent', turnId }`. It stamps `_via` /
   * `_turn` on the call's audit rows and puts the turn id in `read_log.request_id`. Checked before
   * anything runs; a malformed one throws InvalidInvocationError (an adapter bug — rendered as an
   * opaque 500), because a call that cannot be attributed does not run.
   */
  invocation: Invocation;
}

/**
 * Run a route's spec against an already-authenticated principal. Returns the handler's result
 * (a plain value, or a Response for handlers that set a custom status). Throws AppError on
 * permission denial (notFound), over-limit (tooManyRequests), or invalid input (badRequest);
 * lets any other handler error propagate for the adapter to render as an opaque failure.
 */
export async function executeRoute(
  env: Env,
  spec: RouteSpec<z.ZodTypeAny>,
  principal: Principal,
  opts: ExecuteOpts,
): Promise<Response | unknown> {
  // 0. Attribution — the adapter's invocation, checked before ANYTHING else (it depends on no
  //    caller data, so it cannot turn into an oracle about the route). Frozen copy from here on.
  const invocation = checkedInvocation(opts.invocation);

  // 1. Permission — denial is a uniform 404, checked BEFORE any input work. principalMayCall, not
  //    can(role): a bearer caller holds only its role ∩ its token's scopes, minus the
  //    non-delegable set (PIA C8), and a SERVICE principal holds exactly its identity's one scope
  //    and no 'authenticated' route. Enforced HERE — the one pipeline HTTP and MCP share, in the
  //    protected core — so a fork's routes cannot forget it and a fork's MCP shell cannot skip it.
  //    A SERVICE principal's denial also leaves a content-free `authz.denied` audit row — at most
  //    AUTHZ_DENIED_AUDIT_LIMIT per identity × route pattern per hour (recordServiceDenial below) —
  //    written in the background, so the 404 stays byte-identical and, over HTTP, no slower.
  //    A PERSON denied because an authority hook's set (an ACL grant) lacks the key leaves one
  //    content-free log line instead (logAuthorityDenial); a denial by the role, or by a bearer's
  //    ceiling over a set that holds the key, leaves nothing, as before.
  //    A MACHINE route (spec.machine) admits only a service holding its key: a person is refused
  //    here, before anything else is read, with the same 404 and no row (principalMayCall).
  const machine = spec.machine === true;
  if (!principalMayCall(principal, spec.permission, { machine })) {
    if (principal.kind === 'service') {
      recordServiceDenial(env, spec, principal, opts, invocation);
    } else if (authorityWithholds(principal, spec.permission)) {
      logAuthorityDenial(spec, principal);
    }
    throw notFound();
  }

  // 2. Per-principal abuse ceiling — after permission, so a forbidden caller has already 404'd and
  //    only permitted users are ever limited. Keyed per route + principal.
  if (spec.rateLimit) {
    const limit = await rateLimit(
      env,
      `route:${spec.method}:${spec.path}:${principal.email}`,
      spec.rateLimit.limit,
      spec.rateLimit.windowSec,
    );
    if (!limit.ok) throw tooManyRequests(limit.retryAfterSec);
  }

  // 2b. Machine routes: the caller's sync run id (src/framework/machine.ts). After permission, so
  //     only a caller already allowed the route ever learns the header exists. A missing or
  //     invalid value is a 400 unless the app runs warn-only (MACHINE_SYNC_RUN=warn), where it is
  //     recorded as null with one content-free warning (a registered logEvent; the route pattern
  //     only). The value itself is never logged.
  let syncRunId: string | null = null;
  if (machine) {
    const reading = readSyncRun(opts.request.headers);
    if (reading.problem === null) {
      syncRunId = reading.runId;
    } else if (syncRunMode(env.MACHINE_SYNC_RUN) === 'enforce') {
      throw badRequest(
        `${SYNC_RUN_HEADER}: required on this route — 1-64 characters of A-Z a-z 0-9 . _ : -`,
      );
    } else {
      logEvent(
        reading.problem === 'missing' ? 'machine_sync_run_missing' : 'machine_sync_run_invalid',
        { route: `${spec.method} ${spec.path}` },
      );
    }
  }

  // 3. Build (post-permission) and validate the input against the route's schema.
  const parsed = spec.input.safeParse(await opts.buildRawInput());
  if (!parsed.success) {
    const message = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ');
    throw badRequest(message);
  }

  // 4. Build ctx and run the handler.
  const db = makeDb(env);
  // Per-route least privilege, OPT-IN and OFF the default path. A route that declared
  // `needs` hands its handler a view that throws on any repository it did not name; a route
  // that declared nothing gets `db` ITSELF — same object, no proxy, no extra allocation.
  // This line runs on every request of every app, so the no-`needs` arm stays exactly what
  // it was before `needs` existed (test/framework/route-needs.test.ts pins that: a handler
  // with no `needs` receives an unbranded, unwrapped makeDb() result).
  //
  // The framework keeps `db` — not the view — for its own audit writes below and for
  // ctx.audit(): those are capabilities the route declares through `audit:`, mediated by
  // the framework. `needs` scopes what the HANDLER reaches directly.
  const scopedDb = spec.needs ? scopeDb(db, spec.needs, spec.method, spec.path) : db;

  // THE READ-LEDGER REQUEST ID: one per call, decided HERE and nowhere else (`requestId` below).
  // Every read_log row this call writes carries it — the d1 recorder's rows (READ_AUDIT armed),
  // ctx.readUpstream's rows (always, PIA C15) and the Aurora rows a handler writes with
  // ctx.requestId — so one call's reads group under one id whichever streams it touched. A
  // correlation id a caller supplies (an agent turn) replaces the minted uuid and so reaches every
  // stream; set on one side only, the streams stop correlating.

  // READ ATTRIBUTION for ordinary D1 reads (Fleet Ledger K2b). OPT-IN per app and OFF the default
  // path: `READ_AUDIT` unset ⇒ `recorder` is null and `handlerDb` is the very object the line
  // above produced — no proxy, no allocation, byte-identical to the pre-K2b framework
  // (test/framework/read-audit.test.ts pins it through `readRecorderOf`, exactly as
  // route-needs.test.ts pins the no-`needs` arm).
  //
  // WRAPPED OUTSIDE scopeDb, and the order is the point: a `needs` denial throws from the SCOPED
  // view, below this proxy, so a repository the route was refused is never recorded as a read.
  //
  // The framework's own writes keep `db` — the unwrapped object — so the declared audit row and
  // ctx.audit() never appear in the read ledger, and neither does the ledger's own flush.
  //
  // ONE REQUEST ID for every ledger stream of this call — the D1 recorder's rows here,
  // ctx.readUpstream's rows, and the Aurora rows a handler writes by passing ctx.requestId as
  // AuroraCtx.requestId: an agent call's TURN id (so all of one turn's reads correlate), a fresh
  // uuid otherwise. Minted whether or not READ_AUDIT is armed, because the upstream and Aurora
  // streams record either way.
  const requestId = readLedgerRequestId(invocation) ?? crypto.randomUUID();
  const recorder = readAuditArmed(env)
    ? beginReadAudit(principal.email, `${spec.method} ${spec.path}`, requestId)
    : null;
  const handlerDb = recorder ? recordDb(scopedDb, recorder) : scopedDb;
  // THE MACHINE-WRITE EXEMPTION (src/framework/machine.ts, DECISIONS 2026-09-24): a service
  // identity, a `machine: true` route, a mutating method, a declared audit action. Consulted only
  // when armed, so the unarmed path never evaluates it. Passing it skips nothing yet: the recorder
  // still collects every read, and step 6 drops them only once the declared audit row has landed
  // carrying the route's own payload, whole, and the caller's run id.
  const exemptCandidate = recorder !== null && isExemptMachineWrite(principal, spec);
  // The one way this request's reads are flushed, from 4b and from step 6 alike: at the end of a
  // streamed body, at once otherwise (flushWhenBodyEnds). Returns what the request answers with.
  const flushReads = (res: unknown, rec: ReadRecorder): unknown =>
    flushWhenBodyEnds(
      res,
      () => scheduleReadAuditFlush(env, db.readLog, rec, opts.waitUntil),
      readAuditStreamTimeoutMs(env),
      `${spec.method} ${spec.path}`,
      opts.request.method,
    );
  let auditTarget: string | undefined;
  let auditPayload: Record<string, unknown> | undefined;

  // The payload_json of every audit row this call writes: the route's payload with any reserved
  // `_`-prefixed key stripped, plus `_via` / `_turn` for an MCP or agent call. HTTP rows with no
  // reserved key are byte-identical to before (src/framework/invocation.ts).
  const attributedJson = (action: string, payload: Record<string, unknown> | undefined) => {
    const { json, stripped } = auditPayloadJson(payload, invocation);
    if (stripped > 0) logEvent('audit_reserved_keys_stripped', { action, count: stripped });
    return json;
  };
  // Machine routes (src/framework/machine.ts): the validated run id is stamped over whatever the
  // handler set and the ROUTE's payload is capped at 1 KB (oversize → `{ oversize, bytes, runId }`
  // and one warning) — THEN the attribution above runs on the result, so `_via` / `_turn` still
  // land last and an oversize stub is attributed like any row (DECISIONS 2026-09-25, P1-A,
  // Coordination). Ordinary routes are exactly `attributedJson`.
  const payloadJson = (
    action: string,
    payload: Record<string, unknown> | undefined,
  ): string | null => {
    if (!machine) return attributedJson(action, payload);
    const capped = machineAuditPayload(payload, syncRunId);
    if (capped.oversizeBytes !== null) {
      logEvent('machine_audit_payload_oversize', {
        route: `${spec.method} ${spec.path}`,
        bytes: capped.oversizeBytes,
      });
    }
    return attributedJson(action, capped.payload);
  };

  const ctx: RouteCtx = {
    principal,
    db: handlerDb,
    env,
    request: opts.request,
    ip: opts.ip,
    invocation,
    requestId,
    setAuditTarget: (target, payload) => {
      auditTarget = target;
      auditPayload = payload;
    },
    audit: async (action, target, payload) => {
      try {
        await db.audit.insert({
          actor_email: principal.email,
          action,
          target: target ?? null,
          payload_json: payloadJson(action, payload),
          ip: opts.ip,
        });
      } catch (err) {
        logEvent('audit_write_failed', { action, err });
      }
    },
    syncRunId,
    waitUntil: opts.waitUntil,
    // UPSTREAM READS (PIA C15), ledgered by src/data/upstream.ts armed or not, under the call's
    // one ledger id (ctx.requestId, above) — an agent call's rows carry its turn, armed or not.
    readUpstream: (upstream, read, readOpts) =>
      upstreamRead(
        {
          env,
          principal: principal.email,
          route: `${spec.method} ${spec.path}`,
          requestId,
          waitUntil: opts.waitUntil,
        },
        upstream,
        read,
        readOpts,
      ),
  };

  let result: Response | unknown;
  // True once the handler has RETURNED on an exempt candidate: its reads then wait for step 6,
  // which drops them only if the declared audit row lands and can stand in for them. A throw never
  // gets past the `await`, so it leaves this false and the `finally` below flushes those reads like
  // every other request's: a failed write writes no audit row, and a request must never end with
  // neither record.
  let readsAwaitAuditRow = false;
  try {
    // The one sanctioned handler call in the codebase (semgrep `agent-dispatch-bypass`).
    result = await spec.handler(ctx, parsed.data);
    readsAwaitAuditRow = exemptCandidate;
  } finally {
    // 4b. Flush the read ledger. In a `finally`, so a handler that THREW still records what it
    //     read before it threw — those reads happened, and a route that 500s is exactly when an
    //     operator wants to know what it touched. Scheduled, never awaited on the request path:
    //     D1 reads are internal-class, so the fail-open posture is the aurora seam's
    //     internal-class one, not Decision D3's write-ahead fence. flushReadAudit never rejects.
    //
    //     WHEN is set by the response: the `d1` stream is REQUEST-scoped, and a request that
    //     returned a STREAMING body is not over until that body is. So a Response with a
    //     ReadableStream body gets the flush deferred to the body's end (close, cancel, error or a
    //     hard timer), and everything else — a plain value, a thrown handler, any HEAD request (its
    //     body is discarded unread) — flushes now, as always. A wrapper that cannot be built returns the ORIGINAL Response and flushes now: a
    //     bug there must never break the response (src/framework/readAuditStream.ts).
    //
    //     An exempt request whose handler returned is settled in step 6 instead.
    if (recorder && !readsAwaitAuditRow) {
      result = flushReads(result, recorder);
    }
  }

  // 5. Audit-on-write: the framework is the SINGLE writer of the declared action. It fires
  //    exactly once, only after a SUCCESSFUL handler — a thrown error skips it (catch is
  //    upstream in the adapter), and a handler-returned error Response (status >= 400) is a
  //    FAILED mutation, so no success row is written for it either. Target: what the handler
  //    named via setAuditTarget(), else the first path param (the resource the caller named).
  //
  //    Unlike handler-called ctx.audit() extras (best-effort by documented contract), the
  //    declared write is completeness-critical: audit rows are the kit's headline invariant.
  //    On insert failure the response stays 2xx — the mutation is already committed, and a
  //    500 would misreport completed work without restoring atomicity (fail-open, DECISIONS
  //    2026-08-03) — but the failure raises a visible signal through the alert seam instead
  //    of dying in a log line nobody watches.
  const handlerFailed = result instanceof Response && result.status >= 400;
  let auditRowWritten = false;
  if (typeof spec.audit === 'string' && !handlerFailed) {
    try {
      await db.audit.insert({
        actor_email: principal.email,
        action: spec.audit,
        target: auditTarget ?? Object.values(opts.params)[0] ?? null,
        payload_json: payloadJson(spec.audit, auditPayload),
        ip: opts.ip,
      });
      auditRowWritten = true;
    } catch (err) {
      // The category rides the log line as well as the alert, because the alert is throttled per
      // action and a suppressed failure leaves its category here or nowhere. A fixed literal.
      logEvent('audit_declared_write_failed', {
        action: spec.audit,
        category: d1ErrorCategory(err),
        err,
      });
      try {
        // Off the hot path: the seam reads settings and fans out email + webhook (5s cap).
        // The MCP adapter awaits its collected waitUntil promises before returning, so the
        // alert is not dropped on non-HTTP transports.
        opts.waitUntil(alertAuditWriteFailure(env, spec.audit, principal.email, err));
      } catch {
        // Even a broken waitUntil must not turn fail-open into a 500. Event name only —
        // the insert failure above already logged the interesting detail.
        logEvent('audit_alert_schedule_failed');
      }
    }
  }

  // 6. Settle an exempt request's reads (the machine-write exemption, src/framework/machine.ts).
  //    Only a request whose handler returned gets here with reads still open, and step 5 cannot
  //    throw past this point (its insert, its alert and the alert's scheduling are each caught;
  //    machineRowAttributes never throws).
  //    If the declared audit row LANDED and carries what it stands in for — the route's own
  //    payload, stored whole rather than as the oversize stub, and the caller's X-Sync-Run id
  //    (machineRowAttributes) — that row is the request's attribution: the collected reads are
  //    closed out unwritten — no ledger rows, no ledger write, no "read ledger FAILED" alert for a
  //    machine batch. Otherwise the reads are flushed after all, by 4b's own path, so a streamed
  //    body (an error Response is one) still defers the flush to the body's end: when the row did
  //    NOT land (an error Response, so step 5 wrote nothing; or the insert failed and the alert
  //    above went out), and when it landed with nothing an investigator could match a batch by
  //    (no payload of the route's own, an oversize stub, `runId: null`). Fail toward recording:
  //    the request leaves at least one record that answers for it, never zero. A discard is
  //    immediate whatever the body: a read the body makes later is a counted drop on a closed
  //    recorder, and the audit row attributes the request either way.
  if (recorder && readsAwaitAuditRow) {
    if (auditRowWritten && machineRowAttributes(auditPayload, syncRunId)) {
      discardReadAudit(recorder);
    } else {
      result = flushReads(result, recorder);
    }
  }

  return result;
}

/**
 * A PERSON denied by an AUTHORITATIVE set — the app's authority hook decided the caller's
 * permissions (src/auth/authority.ts) and the route's key is not among them (authorityWithholds; a
 * set that holds the key but a token ceiling that does not is the credential's denial, unlogged). One
 * `route_permission_denied` line, because "which authority denied it" is the first question when an
 * ACL grant looks wrong, and the response cannot answer it (404-uniformity). CONTENT-FREE: the
 * route PATTERN, the key, `source: 'authority'`, the transport and how many keys the set holds —
 * never the caller, never the keys themselves (PIA C5).
 *
 * People on the ROLE are denied routinely (a stale bookmark, the SPA probing) and stay unlogged,
 * exactly as before the seam, so a role-only app's logs do not change. Synchronous and I/O-free:
 * the 404 is unchanged in bytes and in timing.
 */
function logAuthorityDenial(spec: RouteSpec<z.ZodTypeAny>, principal: PersonPrincipal): void {
  const held: unknown = principal.permissions;
  logEvent('route_permission_denied', {
    method: spec.method,
    path: spec.path,
    permission: spec.permission,
    source: 'authority',
    transport: principal.credentialTransport,
    held: held instanceof Set ? held.size : 0,
  });
}

/**
 * authz.denied rows kept per service identity × route pattern × window; denials past it are logged
 * (`authz_denied_audit_suppressed`), not written. Five an hour is plenty of evidence — the first
 * denial is the signal, and a stolen token exploring shows up as rows on MANY route patterns, each
 * its own bucket — while a retrying ETL or a flood stays bounded: audit_log is append-only and
 * never pruned, and no zone rate limit covers /api/* (the kit's only zone rule is /auth/*).
 */
export const AUTHZ_DENIED_AUDIT_LIMIT = 5;
export const AUTHZ_DENIED_AUDIT_WINDOW_SEC = 60 * 60;

/**
 * AUTHZ.DENIED — for SERVICE principals only. A machine holds exactly one permission key and
 * calls a fixed set of routes, so a denial is rare and means something: a misconfigured
 * integration (it is calling a route its identity was never given) or a stolen token being used
 * to explore. People are denied routinely (a viewer's stale bookmark, the SPA probing what it may
 * show), so their denials stay unaudited — rows nobody could act on would bury the ones that
 * matter.
 *
 * The row is CONTENT-FREE: the actor is the identity's own svc-…@….invalid identifier, the target
 * is the route PATTERN (`GET /api/users/:email` — never a path value), and the payload is the
 * permission key the route needs and the identity's id. No input was built or read (step 1 runs
 * before buildRawInput), so no body, query or parameter value can reach it. The daily
 * audit-anomaly digest counts it (src/cron/auditAnomalyDigest.ts) — a lower bound, given the cap.
 *
 * BOUNDED: at most AUTHZ_DENIED_AUDIT_LIMIT rows per identity × route pattern per
 * AUTHZ_DENIED_AUDIT_WINDOW_SEC (the KV rate limiter, keyed on the identity id and the pattern);
 * past that, one log line per denial and no row. If KV itself fails, the row is written anyway —
 * while the store that bounds it is down, evidence wins over the bound (the declared-audit failure
 * alert makes the same call).
 *
 * The response stays the uniform 404: the throttle check and the write are handed to waitUntil and
 * never awaited here, and a failure is logged (error class only) and swallowed — an audit gap must
 * never turn a denial into a 500. Over HTTP that adds no latency a caller could time. The MCP
 * adapter (src/mcp/tools.ts) has no executionCtx and DRAINS waitUntil work before it returns, so
 * there a service principal's denied call to an EXISTING tool takes one KV round trip (and at most
 * one D1 insert) longer than a call naming no tool at all. Accepted: it reveals only which tool
 * names exist — the kit's route table, which the per-principal tool list and the source already
 * disclose — and only to a caller already holding a valid service token.
 */
function recordServiceDenial(
  env: Env,
  spec: RouteSpec<z.ZodTypeAny>,
  principal: ServicePrincipal,
  opts: ExecuteOpts,
  invocation: Invocation,
): void {
  const write = writeServiceDenial(env, spec, principal, opts.ip, invocation).catch(
    (err: unknown) => logEvent('authz_denied_audit_failed', { err }),
  );
  try {
    opts.waitUntil(write);
  } catch {
    logEvent('authz_denied_schedule_failed');
  }
}

async function writeServiceDenial(
  env: Env,
  spec: RouteSpec<z.ZodTypeAny>,
  principal: ServicePrincipal,
  ip: string,
  invocation: Invocation,
): Promise<void> {
  const route = `${spec.method} ${spec.path}`;
  let fresh = true;
  try {
    fresh = (
      await rateLimit(
        env,
        `authz_denied:${principal.service.id}:${route}`,
        AUTHZ_DENIED_AUDIT_LIMIT,
        AUTHZ_DENIED_AUDIT_WINDOW_SEC,
      )
    ).ok;
  } catch {
    // KV down: write the row anyway (see the doc comment above).
  }
  if (!fresh) {
    logEvent('authz_denied_audit_suppressed', {
      service_identity_id: principal.service.id,
      route,
    });
    return;
  }
  await makeDb(env).audit.insert({
    actor_email: principal.email,
    action: 'authz.denied',
    target: route,
    // Framework-built, so nothing reserved to strip; an MCP denial gains `_via` like every other
    // row an MCP call writes.
    payload_json: auditPayloadJson(
      { permission: spec.permission, service_identity_id: principal.service.id },
      invocation,
    ).json,
    ip,
  });
}

/**
 * Hand the read-ledger flush to the scheduler, swallowing a broken `waitUntil` for exactly the
 * reason the declared-audit alert swallows one: an attribution gap must never become a 500. When
 * the scheduler itself throws, the flush is awaited nowhere and the reads are simply not
 * recorded — logged, not raised. (`flushReadAudit` already closes the recorder and never
 * rejects, so nothing here can produce an unhandled rejection.)
 */
function scheduleReadAuditFlush(
  env: Env,
  ledger: ReadLedgerWriter,
  recorder: ReadRecorder,
  waitUntil: (p: Promise<unknown>) => void,
): void {
  try {
    waitUntil(flushReadAudit(env, ledger, recorder));
  } catch {
    logEvent('read_audit_schedule_failed');
  }
}

/**
 * Error CLASS for an ops alert body: the class name is diagnostic, while the raw message
 * can carry SQL or binding internals that don't belong in email/Slack. Exported for the
 * unit tests that pin both arms.
 */
export function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}

// At most one audit-failure alert per action per window. During a sustained audit_log
// outage EVERY mutation lands in the failure path; an unthrottled fanout would flood the
// shared webhook/inbox and rate-limit away the cron-failure page riding the same channel.
const AUDIT_FAIL_ALERT_WINDOW_SEC = 15 * 60;

// The declared-audit failure alert. Never throws (the seam is best-effort and this adds a
// terminal catch), so the returned promise is safe for waitUntil. Carries the error CLASS and the
// error CATEGORY (one literal from the fixed list in d1ErrorCategory.ts: contention vs. a real
// bug), never the raw message.
async function alertAuditWriteFailure(
  env: Env,
  action: string,
  actor: string,
  err: unknown,
): Promise<unknown> {
  let fresh = true;
  try {
    fresh = (await rateLimit(env, `alert:audit_fail:${action}`, 1, AUDIT_FAIL_ALERT_WINDOW_SEC)).ok;
  } catch {
    // KV down too — alert anyway: noise beats silence when everything is failing at once.
  }
  if (!fresh) {
    logEvent('audit_fail_alert_suppressed', { action });
    return;
  }
  const errClass = errorClass(err);
  const category = d1ErrorCategory(err);
  const subject = `[${env.APP_NAME}/${env.APP_ENV}] audit write FAILED: ${action}`;
  const text =
    `The framework could not write the declared audit row.\n\n` +
    `action: ${action}\nactor: ${actor}\nerror class: ${errClass}\n` +
    `error category: ${category}\nwhat it means: ${D1_ERROR_CATEGORY_MEANING[category]}\n\n` +
    `The mutation itself committed (fail-open by design — DECISIONS 2026-08-03). ` +
    `The audit trail has a gap until audit_log availability is restored; ` +
    `check /_health. ${LOGS_CARRY_CLASS_ONLY}`;
  const slack =
    `:rotating_light: [${env.APP_NAME}/${env.APP_ENV}] audit write FAILED for \`${action}\` ` +
    `(actor ${actor}, ${errClass}, error category: ${category}) — mutation committed, audit row ` +
    `missing.`;
  return await sendViaAlertSeam(env, 'audit_fail', { subject, text }, slack).catch(() => {
    // The seam already logged its own failure with detail; this catch only guarantees the
    // returned promise never rejects.
    logEvent('audit_fail_alert_failed');
  });
}
