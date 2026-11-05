// MACHINE ROUTES — the runtime half of `RouteSpec.machine` (defineRoute.ts). A machine route is
// an endpoint a SERVICE identity calls in bulk (an ETL pushing batches): no person may reach it,
// and its audit rows must stay small however large the batch. The permission half (a person gets
// the uniform 404) lives in principalMayCall (src/auth/permissions.ts); this module holds the two
// request-time rules executeRoute applies once a caller is through that check:
//
//   1. X-SYNC-RUN. The caller names the sync run a request belongs to, so an auditor can group
//      one run's batches — and match them to the caller's own run log — without a runs table.
//      The value is at most 64 characters of [A-Za-z0-9._:-]; anything else is DROPPED, never
//      stored or logged (it is caller text). A machine route REQUIRES it: a missing or invalid
//      value is a 400. `MACHINE_SYNC_RUN=warn` is the adoption mode for an app whose caller does
//      not send the header yet: the request goes through, its row records `runId: null`, and one
//      content-free warning is logged (`machine_sync_run_missing|invalid`, route pattern only).
//      Only the exact word `warn` selects it, so a typo stays in the enforcing default.
//
//   2. THE AUDIT PAYLOAD CAP. A machine route's audit payloads — the declared row and any
//      ctx.audit() extra — carry the validated `runId` (stamped by the framework, so a handler
//      cannot record a different one) and are capped at MACHINE_AUDIT_PAYLOAD_MAX_BYTES of UTF-8
//      JSON. An oversize payload is stored as `{ oversize: true, bytes, runId }` — plus
//      `suppressed: true` when the payload carried it, because that flag is the evidence of an
//      erasure interlock and must survive — with one warning log line. The cap is the backstop:
//      batchAudit() (./batchAudit.ts) builds payloads that already fit.
//
// Neither rule adds an audit row: one declared row per request stays the framework invariant.
// Warnings go to the log only, as events in the kit logger's closed registry (KIT_LOG_EVENTS in
// src/platform/logEvent.ts: `machine_sync_run_missing`, `machine_sync_run_invalid`,
// `machine_audit_payload_oversize`) — the route pattern and a byte count, never a value or payload.
//
// A third rule belongs to the read ledger, and this module only DECIDES it:
//
//   3. READ ATTRIBUTION (isExemptMachineWrite and machineRowAttributes, at the end of this file).
//      When READ_AUDIT is armed, a service identity's successful, audited write through a machine
//      route is attributed by its declared audit row instead of by read_log rows. executeRoute
//      applies it, and drops the reads only once that audit row has LANDED carrying the route's own
//      payload, whole, and the caller's X-Sync-Run id; every other request records exactly as
//      before. DECISIONS 2026-09-24 (machine read attribution).
import type { z } from 'zod';
import { machineGateAdmits } from '../auth/permissions';
import { isReservedIdentifier } from '../auth/serviceNamespace';
import type { Principal } from '../auth/types';
import { logEvent } from '../platform/logEvent';
import type { Method, RouteSpec } from './defineRoute';
import { RESERVED_AUDIT_KEY_PREFIX } from './invocation';

/** The request header a machine caller names its sync run in. Header names are case-insensitive. */
export const SYNC_RUN_HEADER = 'X-Sync-Run';

const SYNC_RUN_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** Is `value` a run id the kit will store: 1–64 characters of [A-Za-z0-9._:-]? */
export function isValidSyncRunId(value: unknown): value is string {
  return typeof value === 'string' && SYNC_RUN_PATTERN.test(value);
}

export type SyncRunProblem = 'missing' | 'invalid';

export type SyncRunReading =
  | { runId: string; problem: null }
  | { runId: null; problem: SyncRunProblem };

/**
 * Read X-Sync-Run from a request's headers. A header sent twice arrives joined with ", " (the
 * Fetch spec), which the pattern refuses, so a repeated header is `invalid`, never a guess at
 * which copy was meant.
 */
export function readSyncRun(headers: Headers): SyncRunReading {
  const raw = headers.get(SYNC_RUN_HEADER);
  if (raw === null) return { runId: null, problem: 'missing' };
  if (!isValidSyncRunId(raw)) return { runId: null, problem: 'invalid' };
  return { runId: raw, problem: null };
}

export type SyncRunMode = 'enforce' | 'warn';

/**
 * `MACHINE_SYNC_RUN`: only the exact word `warn` (trimmed, any case) selects the warn-only
 * adoption mode. Unset or anything else enforces — the documented default, and the one a typo
 * lands in.
 */
export function syncRunMode(raw: string | undefined): SyncRunMode {
  return (raw ?? '').trim().toLowerCase() === 'warn' ? 'warn' : 'enforce';
}

/** The ceiling on one machine-route audit payload, in UTF-8 bytes of its stored JSON. */
export const MACHINE_AUDIT_PAYLOAD_MAX_BYTES = 1024;

/** UTF-8 bytes of a JSON text, as D1 stores it. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface MachineAuditJson {
  /** The payload_json to store. */
  json: string;
  /** The UTF-8 size of the payload that was refused, when it was over the cap; else null. */
  oversizeBytes: number | null;
}

export interface MachineAuditPayload {
  /** The payload to store: the stamped payload, or the oversize stub. */
  payload: Record<string, unknown>;
  /** The UTF-8 size of the payload that was refused, when it was over the cap; else null. */
  oversizeBytes: number | null;
}

/**
 * The payload a machine route stores, as an object: the handler's payload with the framework's
 * validated `runId` stamped over any `runId` it carried, capped at MACHINE_AUDIT_PAYLOAD_MAX_BYTES
 * of its JSON. Over the cap it becomes `{ oversize: true, bytes, runId }` (+ `suppressed: true`
 * when the payload said so): numbers, a flag and a ≤ 64-character id, so the replacement is always
 * far under the cap.
 *
 * executeRoute hands the result to the audit attribution (auditPayloadJson, ./invocation.ts),
 * which strips reserved `_` keys and appends `_via` / `_turn` LAST — the composition DECISIONS
 * 2026-09-25 (P1-A, Coordination) fixed: stamp and cap the ROUTE's payload, then attribute. So the
 * cap decision is the same on every channel, and an MCP row may run past 1 KB by its 13-byte
 * `,"_via":"mcp"` (the agent never reaches a machine route; HTTP adds nothing).
 */
export function machineAuditPayload(
  payload: Record<string, unknown> | undefined,
  runId: string | null,
): MachineAuditPayload {
  const stamped = { ...(payload ?? {}), runId };
  const bytes = utf8Bytes(JSON.stringify(stamped));
  if (bytes <= MACHINE_AUDIT_PAYLOAD_MAX_BYTES) return { payload: stamped, oversizeBytes: null };
  return {
    payload: {
      oversize: true,
      bytes,
      runId,
      ...(payload?.suppressed === true ? { suppressed: true } : {}),
    },
    oversizeBytes: bytes,
  };
}

/**
 * machineAuditPayload as the payload_json text a plain HTTP call stores (no attribution to add).
 */
export function machineAuditJson(
  payload: Record<string, unknown> | undefined,
  runId: string | null,
): MachineAuditJson {
  const capped = machineAuditPayload(payload, runId);
  return { json: JSON.stringify(capped.payload), oversizeBytes: capped.oversizeBytes };
}

// ── 3. READ ATTRIBUTION: THE MACHINE-WRITE EXEMPTION ─────────────────────────────────────────
//
// ONE request shape stops writing ledger rows, and only while READ_AUDIT is armed (unarmed,
// executeRoute never asks): a SERVICE identity's write through a MACHINE route that declares an
// audit action, once that request's declared audit row has landed. The row names the actor (the
// identity's svc-…@….invalid identifier), the action, the target, the time, the ip and, on a
// machine route, the counts, the key fingerprint and the caller's X-Sync-Run id. The ledger rows
// would have named the same actor and route plus the lookups the write made on its way in, so
// the request is attributed once, by the stronger record, and a machine's batches stop filling
// read_log. D13 read B; piloted in insights as A5.2 (CialDNB/insights#280).
//
// FOUR CONDITIONS, ANDed, each written so that anything unexpected answers false:
//   1. the principal is a SERVICE identity: machineGateAdmits (an exact `kind: 'service'`, which
//      only the kit's resolvers set) AND an attribution identifier in the reserved `.invalid`
//      namespace (isReservedIdentifier). A person has neither, so a person is never exempt; and
//      the actor an exempt row names is always one the fleet digest leaves out of `actors`
//      (src/data/activity.ts), so the two halves of this policy cannot disagree about who is a
//      machine;
//   2. the route is `machine: true`, so a service's call to an ordinary route (a GET it was
//      scoped to, or a write) is recorded;
//   3. the method is mutating, so a service's GET is recorded, on a machine route or not. This is
//      the DECLARED method, not what the handler does: nothing here sees the response, so a
//      machine POST that returned records it read would carry them out unrecorded. The rule that
//      a machine route returns counts and the keys it was sent, and that a lookup is a GET, is a
//      convention (docs/API-CONVENTIONS.md → machine routes) that /security-review checks, not
//      something this check enforces;
//   4. the route declares an audit action (a non-empty string), so `audit: false` or no
//      declaration is recorded.
// executeRoute adds one more at run time, in the same direction: the declared audit row must
// LAND, and carry what it stands in for (machineRowAttributes, below). A throw, an error Response
// (no success row is written), or a failed insert (the "audit write FAILED" alert goes out
// instead) leaves the reads to be flushed like any other request's, so no request ends with
// neither record. So does a row that landed without the route's own payload, with only the
// oversize stub, or with no run id (warn-only adoption, and every MCP call). And an error while
// evaluating any of this answers false: the request is recorded.
//
// Not affected: the aurora seam (src/data/aurora.ts records every private-database read itself,
// outside this proxy), the upstream seam (ctx.readUpstream, src/data/upstream.ts, which ledgers
// each upstream read itself, armed or not), cron work (it never passes through executeRoute), and
// every principal and route shape above that fails a condition.
// ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The methods defineRoute obliges to declare an `audit:` action (pinned against it by
 * test/framework/machine-read-attribution.test.ts). Typed on `Method`, so a method added there is
 * recorded here until someone adds it on purpose.
 */
const MUTATING_METHODS: ReadonlySet<Method> = new Set<Method>(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The static half of the machine-write exemption: true only when all four conditions above hold.
 * On its own it skips nothing; executeRoute still records unless the request's declared audit row
 * is written and machineRowAttributes accepts it. Never throws: an error while evaluating it is
 * logged as `read_audit_exemption_check_failed` (the error's category only, never a principal or a
 * value) and answers false, so the request is recorded.
 */
export function isExemptMachineWrite(
  principal: Principal,
  spec: Pick<RouteSpec<z.ZodTypeAny>, 'method' | 'machine' | 'audit'>,
): boolean {
  try {
    return (
      machineGateAdmits(principal) &&
      isReservedIdentifier(principal.email) &&
      spec.machine === true &&
      MUTATING_METHODS.has(spec.method) &&
      typeof spec.audit === 'string' &&
      spec.audit !== ''
    );
  } catch (err) {
    logEvent('read_audit_exemption_check_failed', { err });
    return false;
  }
}

/**
 * The run-time half of the exemption's last condition: can a machine write's declared audit row,
 * once it has landed, stand in for the request's read rows? Only when it carries what that
 * attribution is (DECISIONS 2026-09-24): the run id the caller sent in X-Sync-Run, and the route's
 * OWN payload — at least one key besides the stamped `runId` and the reserved `_` keys the
 * attribution strips — stored WHOLE, not replaced by the oversize stub. batchAudit() builds one
 * that always qualifies: counts and a key fingerprint, under the cap. The kit cannot check that a
 * payload holds counts rather than something else of the handler's choosing; it can check that
 * the row holds more than the actor, the action and a stub, which is all a row without a payload,
 * an oversize row or a row with `runId: null` (warn-only adoption, and every MCP call) gives an
 * investigator to match a batch by. Any of those keeps the reads: fail toward recording.
 *
 * `payload` is the handler's, before the framework stamps `runId` and caps it; `runId` is the
 * validated id executeRoute stamps (ctx.syncRunId). Pure, and it re-runs machineAuditPayload, so
 * its oversize verdict is the one the stored row got. The keys it counts are the STORED row's,
 * not the handler object's: it reads back the JSON round trip of that payload, so a key JSON
 * leaves out (an undefined, function or symbol value — `{ written: res?.meta?.changes }` with no
 * meta) does not count, and a row stored as `{ runId }` alone keeps the reads. Never throws: an
 * error is logged as `read_audit_exemption_check_failed` (the error's category only) and answers
 * false.
 */
export function machineRowAttributes(
  payload: Record<string, unknown> | undefined,
  runId: string | null,
): boolean {
  try {
    if (!isValidSyncRunId(runId)) return false;
    if (payload === undefined || payload === null || typeof payload !== 'object') return false;
    const capped = machineAuditPayload(payload, runId);
    if (capped.oversizeBytes !== null) return false;
    // The row as payload_json holds it (auditPayloadJson stringifies this same object; the `_`
    // keys it strips are left out below).
    const stored: unknown = JSON.parse(JSON.stringify(capped.payload));
    return (
      stored !== null &&
      typeof stored === 'object' &&
      !Array.isArray(stored) &&
      (stored as Record<string, unknown>).runId === runId &&
      Object.keys(stored).some(
        (key) => key !== 'runId' && !key.startsWith(RESERVED_AUDIT_KEY_PREFIX),
      )
    );
  } catch (err) {
    logEvent('read_audit_exemption_check_failed', { err });
    return false;
  }
}
