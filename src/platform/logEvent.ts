// THE structured logger — the only file under src/ allowed to touch `console`
// (semgrep `console-outside-log-event` fences everything else).
//
// WHY A CLOSED REGISTRY (PIA condition C5): Workers Logs are on with head_sampling_rate 1, keep
// every line for 7 days, and cannot delete a single entry. Whatever a Worker prints is therefore an
// undeletable, account-visible copy for a week — outside every retention sweep and every DSR
// erasure. So a log line may carry no message or tool content, no third-party identifier, no
// magic-link URL and no recipient email. "Be careful what you log" held until it didn't: the kit
// itself logged a raw provider error body (`ai_call_failed`), raw thrown errors (`unhandled_error`,
// `mcp_tool_error`), and — in staging — every undelivered magic link with its token and address.
//
// HOW: every event is declared below with its level and the ONLY keys it may carry, each with a
// value KIND. `logEvent` type-checks the call against the registry, then re-checks at runtime,
// because a type is not a control (a cast, `any`, or a value that is a string at runtime but was
// never meant to be one all walk past it):
//   * unknown keys are DROPPED (only their count survives, as `_dropped_keys`);
//   * numbers must be finite (`count`/`status` also integral and in range), booleans booleans;
//   * `enum` values must be one of the declared literals;
//   * every string kind is length-capped, then REPLACED WITH A MARKER — never passed through —
//     if it looks like an email (`@`), a URL or query (`://`, `www.`, `?`, `&`, `=`, `#`), free
//     text (whitespace), a credential (the kit's `t_<40 hex>` bearer, an `sk-` key, a JWT, a long
//     hex or mixed letter-and-digit run), or a national/company number (a run of 9+ digits: CPF,
//     CNPJ, DUNS, CUIT, an Israeli ID), and then must match its kind's shape (an identifier, a
//     route pattern, a GUID, a hostname). The marker names the reason (`[redacted:email]`), never
//     the value;
//   * an `error` value is REDUCED to its category — `name`, `code`, `status` — and each of those
//     is screened like an identifier (a numeric code must be at most 6 digits). The message, the
//     stack, `cause` and any body are never read.
// A malformed call degrades to markers or to a fixed `log_event_rejected` line; `logEvent` never
// throws, because it runs inside catch blocks and alert paths that must not fail.
//
// ADDING AN EVENT: add it to KIT_LOG_EVENTS (protected core, code-owner review) with the narrowest
// kinds that carry what an operator needs — a status code, a count, an enum, a route pattern. If a
// value you want to log would only fit a free-text kind, that is the signal it is content: log a
// category instead. There is deliberately no `text` kind. Fork/app events belong in the app's own
// registry via `createLogger` (same checks, no edit to this file).
//
// BOUNDS, recorded so nobody mistakes this for more than it is: the screens catch the SHAPES of
// content, not its meaning. An identifier-shaped value (`alice.smith`, a CPF written with its
// punctuation and a letter in front, `x123.456.789-09`, a short secret) passes an `id` field. The defence against that is the registry
// itself — every field is a named, reviewed key whose kind says what may flow into it — and the
// semgrep fence that makes this the only door. Semgrep 1.97 cannot follow a value across files,
// so the runtime checks here are the control and the rule is the backstop.

import { D1_ERROR_CATEGORIES } from '../framework/d1ErrorCategory';
import { PRIVATE_SERVICE_FAILURES } from '../framework/privateServiceFailure';

/** Where a line goes: `info` → console.info, `warn` → console.warn, `error` → console.error. */
export type LogLevel = 'info' | 'warn' | 'error';

type ScalarKind =
  | 'count' // non-negative safe integer
  | 'num' // finite number
  | 'status' // HTTP status, integer 100–599
  | 'bool'
  | 'method' // an HTTP method (GET, POST, …); anything else is a marker
  | 'id' // code identifier: [A-Za-z][A-Za-z0-9_.:-]*, ≤ 64
  | 'path' // route PATTERN: /api/notes/:id (no long digit runs), ≤ 128
  | 'route' // "<METHOD> <path>", as beginReadAudit labels a recorder
  | 'guid' // an Entra tenant id and the like
  | 'domain' // a hostname, ≤ 253
  | 'error'; // reduced to { name, code?, status? }

export type FieldSpec =
  | { readonly kind: ScalarKind }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

export interface EventSpec {
  readonly level: LogLevel;
  readonly fields: { readonly [key: string]: FieldSpec };
}

export type EventRegistry = { readonly [event: string]: EventSpec };

type ValueOf<F extends FieldSpec> = F extends { kind: 'enum'; values: readonly (infer V)[] }
  ? V
  : F extends { kind: 'count' | 'num' | 'status' }
    ? number
    : F extends { kind: 'bool' }
      ? boolean
      : F extends { kind: 'error' }
        ? unknown
        : string;

/** The keys an event may carry, each typed by its kind. All optional: an absent key is omitted. */
export type EventFields<S extends EventSpec> = {
  readonly [K in keyof S['fields']]?: ValueOf<S['fields'][K]>;
};

/**
 * What a call may pass for event `E`. An event that declares NO fields takes no keys at all:
 * without this, its `EventFields` is `{}`, which TypeScript lets any object literal satisfy — so
 * `logEvent('email_skipped_no_binding', { to: email })` would typecheck (the runtime still drops
 * the key, but the compile-time half of the control would be silent exactly where a leak starts).
 */
export type FieldsArg<S extends EventSpec> = [keyof S['fields']] extends [never]
  ? Record<string, never>
  : EventFields<S>;

export type Logger<R extends EventRegistry> = <E extends keyof R & string>(
  event: E,
  fields?: FieldsArg<R[E]>,
) => void;

/** Field kinds, for building a registry. `oneOf(...)` declares an enum. */
export const field = {
  count: { kind: 'count' },
  num: { kind: 'num' },
  status: { kind: 'status' },
  bool: { kind: 'bool' },
  method: { kind: 'method' },
  id: { kind: 'id' },
  path: { kind: 'path' },
  route: { kind: 'route' },
  guid: { kind: 'guid' },
  domain: { kind: 'domain' },
  err: { kind: 'error' },
  oneOf: <const V extends readonly string[]>(...values: V) =>
    ({ kind: 'enum', values }) as { readonly kind: 'enum'; readonly values: V },
} as const;

const HTTP_METHODS: readonly string[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];
const method = field.method;

/** Which kind of D1 failure (src/framework/d1ErrorCategory.ts): a fixed literal, never the message. */
const D1_CATEGORY = field.oneOf(...D1_ERROR_CATEGORIES);

/** The inference region a call was pinned to (src/ai/policy.ts). */
const INFERENCE_GEO = field.oneOf('us', 'global');

/**
 * What an operator does about a token schema-drift refusal: an id naming the migration to apply
 * (migrations/d1/0003_api_token_scopes.sql), never a sentence — the logger has no free-text kind.
 */
const API_TOKEN_MIGRATION = field.oneOf('apply_migration_0003_api_token_scopes');

/** How the credential arrived (src/auth/types.ts CredentialTransport). */
const TRANSPORT = field.oneOf('cookie', 'bearer');

/** Where a D1 read-ledger write failed (src/data/aurora.ts). */
const LEDGER_STAGES = field.oneOf('write_ahead', 'count_patch', 'flush');

/**
 * Every event the kit emits, grouped by the module that emits it. Names are the pre-existing log
 * event names wherever one existed, so Workers Logs queries keep working; the exceptions are the
 * ones a closed registry forced (`alert_seam_*`, `audit_watch_*` — see the CHANGELOG).
 */
export const KIT_LOG_EVENTS = {
  // ── worker entry ────────────────────────────────────────────────────────────────────────
  unhandled_error: { level: 'error', fields: { method, path: field.path, err: field.err } },
  // One line per request, in place of the platform's invocation log (off: it records the full URL,
  // query string included). The matched route PATTERN only — never the URL or its parameters.
  request_done: {
    level: 'info',
    fields: { method, path: field.path, status: field.status, duration_ms: field.num },
  },

  // ── framework ───────────────────────────────────────────────────────────────────────────
  route_error: { level: 'error', fields: { method, path: field.path, err: field.err } },
  audit_write_failed: { level: 'error', fields: { action: field.id, err: field.err } },
  // `category` rides the line as well as the alert: the alert is throttled per action, and a
  // failure it suppresses leaves its category here or nowhere.
  audit_declared_write_failed: {
    level: 'error',
    fields: { action: field.id, category: D1_CATEGORY, err: field.err },
  },
  audit_alert_schedule_failed: { level: 'error', fields: {} },
  // A route put `_`-prefixed keys (reserved for `_via` / `_turn`, src/framework/invocation.ts) in
  // an audit payload; they were stripped and the row written. The action and a count — never the
  // key names, which the route chose.
  audit_reserved_keys_stripped: { level: 'warn', fields: { action: field.id, count: field.count } },
  audit_fail_alert_suppressed: { level: 'error', fields: { action: field.id } },
  audit_fail_alert_failed: { level: 'error', fields: {} },
  read_audit_schedule_failed: { level: 'error', fields: {} },
  read_audit_record_failed: {
    level: 'error',
    fields: { repo: field.id, method: field.id, err: field.err },
  },
  read_audit_wrap_failed: {
    level: 'error',
    fields: { repo: field.id, method: field.id, err: field.err },
  },
  read_audit_repo_wrap_failed: {
    level: 'error',
    fields: { repo: field.id, method: field.id, err: field.err },
  },
  read_audit_view_wrap_failed: { level: 'error', fields: { repo: field.id, err: field.err } },
  read_audit_declared_writes_failed: {
    level: 'error',
    fields: { repo: field.id, err: field.err },
  },
  read_audit_events_dropped: {
    level: 'warn',
    fields: { route: field.route, dropped: field.count },
  },
  read_audit_flush_failed: {
    level: 'error',
    fields: { route: field.route, events: field.count, category: D1_CATEGORY, err: field.err },
  },
  read_audit_alert_suppressed: { level: 'error', fields: { route: field.route } },
  read_audit_alert_failed: { level: 'error', fields: {} },
  // A streamed response's deferred flush (src/framework/readAuditStream.ts): the wrapper could not
  // be built (the original Response was served and the flush ran at once), or the completion
  // callback threw (the body still read to the end).
  read_audit_stream_wrap_failed: { level: 'error', fields: { route: field.route, err: field.err } },
  read_audit_stream_complete_failed: { level: 'error', fields: { err: field.err } },
  jsonSchema_unexpected_conversion_error: { level: 'warn', fields: { err: field.err } },
  // A service identity's denied call (src/framework/execute.ts recordServiceDenial). The identity's
  // numeric id and the route PATTERN — never its svc-…@… identifier or a path value.
  authz_denied_audit_failed: { level: 'error', fields: { err: field.err } },
  authz_denied_schedule_failed: { level: 'error', fields: {} },
  authz_denied_audit_suppressed: {
    level: 'error',
    fields: { service_identity_id: field.count, route: field.route },
  },
  // A PERSON denied by an AUTHORITATIVE set (src/framework/execute.ts): the app's authority hook
  // decided the caller's permissions, and the route's key is not among them. Logged because "which
  // authority denied it" is the first question when an ACL grant looks wrong; role denials stay
  // unlogged (routine). The route PATTERN, the key, the transport and how many keys the set holds —
  // never the caller, never the keys themselves.
  route_permission_denied: {
    level: 'warn',
    fields: {
      method,
      path: field.path,
      permission: field.id,
      source: field.oneOf('authority'),
      transport: TRANSPORT,
      held: field.count,
    },
  },
  // Machine routes (RouteSpec.machine, src/framework/machine.ts). Warn-only mode
  // (MACHINE_SYNC_RUN=warn) let a request through without a usable X-Sync-Run: the route PATTERN
  // only — never the header's value, which is caller text and is dropped.
  machine_sync_run_missing: { level: 'warn', fields: { route: field.route } },
  machine_sync_run_invalid: { level: 'warn', fields: { route: field.route } },
  // A machine route's audit payload was over the 1 KB cap and was stored as { oversize, bytes,
  // runId }: the route PATTERN and the refused payload's UTF-8 size — never the payload.
  machine_audit_payload_oversize: {
    level: 'warn',
    fields: { route: field.route, bytes: field.count },
  },
  // batchAudit() (src/framework/batchAudit.ts) was given counts that do not add up to `received`;
  // the row keeps them as given. The table name only — no key, no count.
  batch_audit_counts_mismatch: { level: 'warn', fields: { table: field.id } },
  // Evaluating the machine-write read exemption threw (isExemptMachineWrite,
  // src/framework/machine.ts); it answered false, so the request's reads are recorded. The
  // error's category only — never the principal, its identifier or the route's values.
  read_audit_exemption_check_failed: { level: 'error', fields: { err: field.err } },

  // ── MCP adapter ─────────────────────────────────────────────────────────────────────────
  mcp_tool_error: { level: 'error', fields: { method, path: field.path, err: field.err } },
  mcp_waituntil_drain_capped: { level: 'error', fields: { method, path: field.path } },

  // ── in-app agent tools (src/framework/agentTools.ts) ───────────────────────────────────────
  // The route PATTERN and the error's category — never the tool arguments or the turn id.
  agent_tool_error: { level: 'error', fields: { method, path: field.path, err: field.err } },
  agent_waituntil_drain_capped: { level: 'error', fields: { method, path: field.path } },

  // ── security ────────────────────────────────────────────────────────────────────────────
  turnstile_misconfigured: { level: 'error', fields: { cause: field.oneOf('secret_missing') } },
  turnstile_network_error: { level: 'error', fields: { err: field.err } },

  // ── auth: magic link ────────────────────────────────────────────────────────────────────
  // The refused address's DOMAIN is kept (per-domain flood triage, mirrored in audit_log); the
  // address never is.
  magic_link_refused: {
    level: 'warn',
    fields: {
      reason: field.oneOf(
        'unknown_or_disabled_user',
        'domain_not_allowed',
        'entra_only_login',
        'service_identity', // a reserved svc-…@….invalid identifier: never a person, never a link
      ),
      domain: field.domain,
    },
  },
  magic_link_refused_audit_failed: { level: 'error', fields: { err: field.err } },
  magic_link_delivery_failed: {
    level: 'error',
    fields: { outcome: field.oneOf('skipped', 'failed') },
  },
  // Non-production only. `outbox` says whether the link was parked in the opt-in KV outbox
  // (src/auth/magicLink.ts) or the address is not listed in MAGIC_LINK_OUTBOX. Never the link.
  magic_link_not_emailed: {
    level: 'warn',
    fields: {
      outcome: field.oneOf('skipped', 'failed'),
      outbox: field.oneOf('parked', 'not_listed'),
    },
  },
  magic_link_outbox_failed: { level: 'error', fields: { err: field.err } },
  magic_link_sent_audit_failed: { level: 'error', fields: { err: field.err } },
  login_settings_unreadable: { level: 'error', fields: { err: field.err } },
  // A link or a session for a reserved (service) identifier redeems nothing. The reason only.
  magic_link_verify_refused: { level: 'warn', fields: { reason: field.oneOf('service_identity') } },
  session_refused: { level: 'warn', fields: { reason: field.oneOf('service_identity') } },

  // ── auth: bearer tokens (src/auth/tokens.ts, src/data/tokens.ts) ────────────────────────
  // The row id only — never an email, a token, its prefix or its hash. `reason` is a fixed
  // service_* literal or the fork refusal hook's sanitized identifier.
  api_token_refused: {
    level: 'error',
    fields: { reason: field.id, token_id: field.count, service_identity_id: field.count },
  },
  api_token_refusal_hook_failed: { level: 'error', fields: { err: field.err } },
  api_token_scopes_invalid: { level: 'error', fields: { token_id: field.count } },
  api_token_schema_drift: {
    level: 'error',
    fields: { op: field.id, remedy: API_TOKEN_MIGRATION },
  },
  api_token_no_expiry: {
    level: 'error',
    fields: { token_id: field.count, remedy: API_TOKEN_MIGRATION },
  },

  // ── auth: the authority seam (src/auth/authority.ts) ────────────────────────────────────
  // The fork's authority hook refused, failed, or answered malformed: no principal (401). Codes
  // only — `reason` is the hook's sanitized identifier, `cause` a fixed literal; never the
  // principal, the keys, or anything the authority returned.
  principal_authority_refused: {
    level: 'warn',
    fields: { transport: TRANSPORT, reason: field.id },
  },
  principal_authority_hook_failed: {
    level: 'error',
    fields: { transport: TRANSPORT, err: field.err },
  },
  principal_authority_invalid: {
    level: 'error',
    fields: {
      transport: TRANSPORT,
      cause: field.oneOf(
        'no_answer',
        'not_an_object',
        'ambiguous',
        'no_decision',
        'permissions_not_iterable',
        'permissions_unreadable',
        'key_not_a_string',
        'too_many_keys',
        'attributes_not_an_object',
        'undeclared_external',
      ),
    },
  },
  // The hook named keys this app's PERMISSIONS does not define: dropped (they grant nothing), and
  // counted so a drifted ACL map shows up.
  principal_authority_keys_dropped: {
    level: 'warn',
    fields: { transport: TRANSPORT, dropped: field.count },
  },

  // ── auth: service identities (src/auth/serviceIdentities.ts, src/data/serviceIdentities.ts) ──
  service_identities_schema_drift: {
    level: 'error',
    fields: { op: field.id, remedy: field.oneOf('apply_migration_0004_service_identities') },
  },
  custodian_disabled_notice_failed: { level: 'error', fields: { err: field.err } },
  custodian_disabled_alert_failed: { level: 'error', fields: {} },
  custodian_disabled_schedule_failed: { level: 'error', fields: {} },

  // ── auth: Entra OIDC ────────────────────────────────────────────────────────────────────
  entra_misconfigured: {
    level: 'error',
    fields: {
      cause: field.oneOf(
        'secret_bound_without_ids', // ENTRA_CLIENT_SECRET bound, ENTRA_CLIENT_ID/_ALLOWED_TENANTS unset
        'ids_not_guids', // ENTRA_CLIENT_ID / ENTRA_ALLOWED_TENANTS are not GUIDs
        'secret_unreadable', // the secret binding exists but reading it threw
        'secret_missing', // ids set, secret absent — SSO disabled (fail closed)
      ),
      err: field.err,
    },
  },
  entra_jwks_error: { level: 'error', fields: { tid: field.guid, status: field.status } },
  entra_jwks_unreachable: { level: 'error', fields: { tid: field.guid, err: field.err } },
  oidc_email_claim_untrusted: { level: 'warn', fields: { tid: field.guid } },
  // `code` is Microsoft's error code (`?error=` or the token endpoint's `error`): an identifier
  // when it is genuine, a marker when a caller stuffed free text into the query string.
  entra_login_refused: {
    level: 'warn',
    fields: {
      reason: field.id,
      code: field.id,
      status: field.status,
      tid: field.guid,
      domain: field.domain,
    },
  },
  entra_token_endpoint_unreachable: { level: 'error', fields: { err: field.err } },

  // ── AI client ───────────────────────────────────────────────────────────────────────────
  ai_gateway_not_configured: { level: 'warn', fields: {} },
  ai_feature_tag_rejected: { level: 'warn', fields: {} },
  ai_call_network_error: { level: 'error', fields: { err: field.err } },
  // The provider's HTTP status and its error TYPE (`overloaded_error`, `gateway_2009`) — never
  // the body, which can echo the request.
  ai_call_failed: { level: 'error', fields: { status: field.status, error_type: field.id } },
  // `reason`: the body did not parse, parsed to something other than an object, or called a tool
  // the request did not offer (the tool's name is not logged).
  ai_call_bad_body: {
    level: 'error',
    fields: {
      reason: field.oneOf('unparseable', 'not_an_object', 'unoffered_tool'),
      err: field.err,
    },
  },
  ai_call_refused: { level: 'warn', fields: { model: field.id } },
  // A pinned call the provider reports running elsewhere (PIA C6): the two region tokens only.
  ai_inference_geo_mismatch: {
    level: 'warn',
    fields: { requested: INFERENCE_GEO, echoed: field.id },
  },
  // `fault` is the stream's failure kind, or `exception` for anything else (then `err` carries its
  // category); `error_type` is the provider's `error` event type when it sent one.
  ai_stream_failed: {
    level: 'error',
    fields: {
      fault: field.oneOf(
        'provider_error',
        'malformed',
        'incomplete',
        'unoffered_tool',
        'exception',
      ),
      error_type: field.id,
      err: field.err,
    },
  },
  ai_budget_settle_failed: { level: 'error', fields: { err: field.err } },
  // A content block type this client never asks for: the provider's type token, or 'unknown'.
  ai_response_block_dropped: { level: 'warn', fields: { block_type: field.id } },
  // A request shape refused before it left (src/ai/policy.ts REFUSALS): the reason key.
  ai_request_refused: { level: 'error', fields: { reason: field.id } },

  // ── data ────────────────────────────────────────────────────────────────────────────────
  meta_applied_migrations_unavailable: { level: 'warn', fields: { err: field.err } },
  meta_schema_hash_unavailable: { level: 'warn', fields: { err: field.err } },
  aurora_unregistered_spec: { level: 'error', fields: { spec: field.id } },
  aurora_spec_mutated_after_registration: {
    level: 'error',
    fields: { spec: field.id, registered: field.id },
  },
  read_log_write_ahead_failed: { level: 'error', fields: { spec: field.id, err: field.err } },
  read_log_count_patch_failed: { level: 'error', fields: { spec: field.id, err: field.err } },
  read_log_flush_failed: { level: 'error', fields: { spec: field.id, err: field.err } },
  aurora_binding_missing: { level: 'error', fields: { source: field.id } },
  aurora_binding_ambiguous: { level: 'error', fields: { source: field.id, found: field.count } },
  aurora_binding_malformed: { level: 'error', fields: { binding: field.id } },
  aurora_open_unknown_source: { level: 'error', fields: { source: field.id } },
  aurora_driver_malformed: { level: 'error', fields: { source: field.id } },
  read_log_background_failed: { level: 'error', fields: { err: field.err } },
  read_log_schedule_failed: { level: 'error', fields: {} },
  read_ledger_alert_suppressed: {
    level: 'error',
    fields: { source: field.id, stage: LEDGER_STAGES },
  },
  read_ledger_alert_failed: { level: 'error', fields: {} },
  // The upstream read seam (src/data/upstream.ts, PIA C15). `source` and `spec` are the registered
  // source name and read id — identifiers checked at registration — never a URL or the value the
  // read was keyed by.
  upstream_unregistered_spec: { level: 'error', fields: { spec: field.id } },
  // The private HTTP service transport (src/data/privateServices.ts). `service` is the registered
  // service name (`invalid` for a name that is not one); `reason` names which control refused or
  // what failed. Never the host, path, credential or an error message — a network error's message
  // can carry the URL.
  private_service_failed: {
    level: 'error',
    fields: { service: field.id, reason: field.oneOf(...PRIVATE_SERVICE_FAILURES) },
  },
  // An integration module refused a call that held no live grant for its source — a call made
  // around ctx.readUpstream, or a grant kept past its read. `source` is the module's own literal.
  upstream_grant_refused: { level: 'error', fields: { source: field.id } },
  upstream_read_write_ahead_failed: {
    level: 'error',
    fields: { source: field.id, spec: field.id, category: D1_CATEGORY, err: field.err },
  },
  upstream_read_count_patch_failed: {
    level: 'error',
    fields: { source: field.id, spec: field.id, err: field.err },
  },
  upstream_read_flush_failed: {
    level: 'error',
    fields: { source: field.id, spec: field.id, err: field.err },
  },
  upstream_read_count_failed: {
    level: 'warn',
    fields: {
      source: field.id,
      spec: field.id,
      reason: field.oneOf('threw', 'not_a_count'),
      err: field.err,
    },
  },
  // The database is older than the code: read_log refuses kind='upstream'. The remedy as an id.
  upstream_read_schema_drift: {
    level: 'error',
    fields: { remedy: field.oneOf('apply_migration_0005_read_log_upstream') },
  },

  // ── email transport ─────────────────────────────────────────────────────────────────────
  // No recipient, no subject: the address is personal data and a subject can carry content.
  email_skipped_no_binding: { level: 'warn', fields: {} },
  email_send_failed: { level: 'error', fields: { err: field.err } },

  // ── alert seam (src/cron/alert.ts) ──────────────────────────────────────────────────────
  // `channel` is the caller's seam name ('alert', 'audit_digest', 'audit_fail', …). These were
  // `<channel>_settings_read_failed` etc.; one fixed name plus a field keeps the registry closed.
  alert_seam_settings_read_failed: {
    level: 'error',
    fields: { channel: field.id, err: field.err },
  },
  alert_seam_email_failed: { level: 'error', fields: { channel: field.id, err: field.err } },
  alert_seam_webhook_failed: { level: 'error', fields: { channel: field.id, err: field.err } },
  alert_seam_webhook_skipped_non_https: { level: 'warn', fields: { channel: field.id } },

  // ── cron ────────────────────────────────────────────────────────────────────────────────
  cron_task_failed: { level: 'error', fields: { task: field.id, err: field.err } },
  cron_heartbeat_failed: { level: 'error', fields: { err: field.err } },
  cron_report_failed: { level: 'error', fields: { err: field.err } },
  // A trigger no dispatch branch in src/cron/index.ts claims: one line per tick. `daily_loop` says
  // whether the fallback ran the loop or skipped the tick; `once_a_day` whether the expression
  // fires at most once a day (one fixed minute and hour). `heartbeat` is what it found: `fresh`
  // skips; `stale` or `missing` makes the tick due; `unreadable` (with the KV error's category)
  // makes a once-a-day tick due and skips any other. A due tick then takes the fallback claim
  // (`claim`): `taken` runs the loop, `held` (an earlier tick's loop) skips, `failed` (with the KV
  // error's category) runs a once-a-day tick and skips any other. The expression itself cannot
  // ride the line (it has spaces, which the screens read as free text): compare wrangler
  // `triggers.crons` with the branches in runScheduled.
  cron_trigger_unrecognized: {
    level: 'warn',
    fields: {
      daily_loop: field.oneOf('ran', 'skipped'),
      once_a_day: field.bool,
      heartbeat: field.oneOf('fresh', 'stale', 'missing', 'unreadable'),
      heartbeat_age_hours: field.num,
      claim: field.oneOf('taken', 'held', 'failed'),
      err: field.err,
    },
  },
  registry_report_block_failed: { level: 'warn', fields: { block: field.id, err: field.err } },
  restore_verify_vault_copy_failed: { level: 'error', fields: { err: field.err } },
  audit_watch_unconfigured: { level: 'warn', fields: {} },
  audit_watch_truncated: { level: 'warn', fields: { fetched: field.count } },
  audit_watch_clear: { level: 'info', fields: { scanned: field.count } },
  audit_watch_alert_undelivered: {
    level: 'error',
    fields: {
      recipients: field.count,
      emailed: field.count,
      failed: field.count,
      webhook: field.bool,
    },
  },
  audit_watch_retry_held: { level: 'warn', fields: {} },
  audit_watch_run_failed: { level: 'error', fields: { err: field.err } },
  service_identity_digest_custodian_email_failed: { level: 'error', fields: { err: field.err } },

  // ── the logger itself ───────────────────────────────────────────────────────────────────
  log_event_rejected: {
    level: 'error',
    fields: { reason: field.oneOf('unknown_event', 'internal') },
  },
} as const satisfies EventRegistry;

export type KitLogEvent = keyof typeof KIT_LOG_EVENTS;

// ── screening ───────────────────────────────────────────────────────────────────────────────

/** What replaces a value that failed its screen. Names the reason, never the value. */
export const REDACTED = {
  email: '[redacted:email]',
  url: '[redacted:url]',
  text: '[redacted:text]',
  secret: '[redacted:secret]',
  long: '[redacted:long]',
  format: '[redacted:format]',
  number: '[redacted:number]',
  enum: '[redacted:enum]',
  type: '[redacted:type]',
  unreadable: '[redacted:unreadable]',
} as const;

const MAX_ID = 64;
const MAX_PATH = 128;
const MAX_DOMAIN = 253;

const ID_RE = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const PATH_RE = /^[/*][A-Za-z0-9_\-/:.*]*$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const URL_SHAPE = /:\/\/|^www\.|[?&=#]/i;
const WHITESPACE = /\s/;
// Credential shapes: the kit's own bearer token (`t_` + 40 hex, src/auth/tokens.ts), an API key
// (`sk-…`, `sk_…`), a JWT (a base64url `eyJ…` header, then a dot), and any run of 32+ hex digits
// (a key, a token, a digest). A mixed run is handled in looksSecret below.
const SECRET_SHAPE = /^t_[0-9a-f]{40}$|^sk[-_]|^eyJ[A-Za-z0-9_-]*\.|[0-9a-f]{32,}/i;
// An identifier is words joined by separators; an unbroken alphanumeric run this long that mixes
// letters and digits is a key or a token.
const MIXED_RUN_MIN = 20;
// A national or company number written as bare digits — DUNS and an Israeli ID (9), CPF and CUIT
// (11), CNPJ (14) — in ANY string kind. Shorter runs pass on purpose: provider codes
// (`gateway_2009`, Cloudflare's 5-digit API codes) and a dated model snapshot (`…-20251001`, 8) are
// operational, not personal.
const ID_DIGIT_RUN = /\d{9,}/;
// A route PATTERN never has a long run of digits (`:id` stands in for the value). A concrete path
// that does is carrying a record or national identifier — a DUNS, a CPF, a ticket number.
const LONG_DIGIT_RUN = /\d{5,}/;
// A numeric error code is a protocol code (an HTTP-ish status, `2009`, a SQLite result code), never
// more than 6 digits; a longer one is somebody's number.
const MAX_NUMERIC_CODE = 999_999;

function looksSecret(value: string): boolean {
  if (SECRET_SHAPE.test(value)) return true;
  for (const run of value.split(/[^A-Za-z0-9]+/)) {
    if (run.length >= MIXED_RUN_MIN && /\d/.test(run) && /[A-Za-z]/.test(run)) return true;
  }
  return false;
}

/** The shape screens every string kind shares. null = passed; otherwise the marker. */
function screen(value: string, max: number): string | null {
  if (value.length > max) return REDACTED.long;
  if (value.includes('@')) return REDACTED.email;
  if (URL_SHAPE.test(value)) return REDACTED.url;
  if (WHITESPACE.test(value)) return REDACTED.text;
  if (looksSecret(value)) return REDACTED.secret;
  if (ID_DIGIT_RUN.test(value)) return REDACTED.number;
  return null;
}

function cleanId(value: string): string {
  return screen(value, MAX_ID) ?? (ID_RE.test(value) ? value : REDACTED.format);
}

function cleanPath(value: string): string {
  const bad = screen(value, MAX_PATH);
  if (bad) return bad;
  if (!PATH_RE.test(value)) return REDACTED.format;
  return LONG_DIGIT_RUN.test(value) ? REDACTED.number : value;
}

function cleanString(kind: ScalarKind, value: string): string {
  switch (kind) {
    case 'id':
      return cleanId(value);
    case 'method':
      return HTTP_METHODS.includes(value) ? value : REDACTED.enum;
    case 'path':
      return cleanPath(value);
    case 'route': {
      // "<METHOD> <path>" — the one kind with a space in it, so split before screening.
      const [verb, path, ...rest] = value.split(' ');
      if (rest.length > 0 || verb === undefined || path === undefined) return REDACTED.format;
      if (!HTTP_METHODS.includes(verb)) return REDACTED.format;
      const cleaned = cleanPath(path);
      return cleaned === path ? value : cleaned;
    }
    case 'guid':
      return screen(value, 36) ?? (GUID_RE.test(value) ? value : REDACTED.format);
    case 'domain': {
      const bad = screen(value, MAX_DOMAIN);
      if (bad) return bad;
      return DOMAIN_RE.test(value) ? value.toLowerCase() : REDACTED.format;
    }
    default:
      return REDACTED.type;
  }
}

/** Read one property of a thrown value without trusting it (a getter may throw). */
function readProp(obj: object, key: 'name' | 'code' | 'status'): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * An error's CATEGORY: its class name, a code, an HTTP status — each screened. Never `message`,
 * `stack`, `cause`, or a body: those are where request content, SQL fragments with bound values,
 * provider echoes and addresses live. Exported for the unit tests.
 */
export function reduceError(err: unknown): {
  name: string;
  code?: string | number;
  status?: number;
} {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) {
    return { name: `thrown_${err === null ? 'null' : typeof err}` };
  }
  const name = readProp(err, 'name');
  const out: { name: string; code?: string | number; status?: number } = {
    name: typeof name === 'string' && name !== '' ? cleanId(name) : 'unnamed',
  };
  const code = readProp(err, 'code');
  if (typeof code === 'string' && code !== '') out.code = cleanId(code);
  else if (typeof code === 'number' && Number.isSafeInteger(code)) {
    out.code = Math.abs(code) <= MAX_NUMERIC_CODE ? code : REDACTED.number;
  }
  const status = readProp(err, 'status');
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    out.status = status;
  }
  return out;
}

function cleanValue(spec: FieldSpec, value: unknown): unknown {
  switch (spec.kind) {
    case 'error':
      return reduceError(value);
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? value : REDACTED.enum;
    case 'bool':
      return typeof value === 'boolean' ? value : REDACTED.type;
    case 'num':
      return typeof value === 'number' && Number.isFinite(value) ? value : REDACTED.type;
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : REDACTED.type;
    case 'status':
      return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
        ? value
        : REDACTED.type;
    default:
      return typeof value === 'string' ? cleanString(spec.kind, value) : REDACTED.type;
  }
}

// ── emitting ────────────────────────────────────────────────────────────────────────────────

function write(level: LogLevel, record: Record<string, unknown>): void {
  try {
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  } catch {
    // A broken console must never break the caller — logging runs inside catch blocks.
  }
}

function emit(registry: EventRegistry, event: string, fields: unknown): void {
  const spec = Object.hasOwn(registry, event) ? registry[event] : undefined;
  if (spec === undefined) {
    // The name itself is not echoed: a caller that got here passed something the registry does
    // not know, and that something could be anything.
    write('error', { event: 'log_event_rejected', reason: 'unknown_event' });
    return;
  }
  const record: Record<string, unknown> = { event };
  let dropped = 0;
  if (fields !== null && typeof fields === 'object') {
    let keys: string[] = [];
    try {
      keys = Object.keys(fields);
    } catch {
      dropped++;
    }
    for (const key of keys) {
      const fieldSpec = Object.hasOwn(spec.fields, key) ? spec.fields[key] : undefined;
      if (fieldSpec === undefined) {
        dropped++;
        continue;
      }
      let value: unknown;
      try {
        value = (fields as Record<string, unknown>)[key];
      } catch {
        record[key] = REDACTED.unreadable;
        continue;
      }
      if (value === undefined) continue;
      record[key] = cleanValue(fieldSpec, value);
    }
  }
  if (dropped > 0) record._dropped_keys = dropped;
  write(spec.level, record);
}

const EVENT_NAME_RE = /^[a-z][A-Za-z0-9_]*$/;

/**
 * Build a logger over a closed registry. Definition-time guard (like defineRoute): a malformed
 * registry — an event name or enum literal that would not pass its own screens, a reserved key —
 * throws at module load, so it fails the first test that imports it rather than a request.
 */
export function createLogger<const R extends EventRegistry>(registry: R): Logger<R> {
  for (const [event, spec] of Object.entries(registry)) {
    if (!EVENT_NAME_RE.test(event) || event.length > MAX_ID) {
      throw new Error(`logEvent registry: bad event name ${JSON.stringify(event)}`);
    }
    for (const [key, fieldSpec] of Object.entries(spec.fields)) {
      if (key === 'event' || key.startsWith('_') || !ID_RE.test(key)) {
        throw new Error(`logEvent registry: ${event} has a reserved or malformed key ${key}`);
      }
      if (fieldSpec.kind === 'enum') {
        for (const literal of fieldSpec.values) {
          if (literal === '' || screen(literal, MAX_ID) !== null) {
            throw new Error(`logEvent registry: ${event}.${key} has an unsafe enum literal`);
          }
        }
      }
    }
  }
  return (event, fields) => {
    try {
      emit(registry, event, fields);
    } catch {
      write('error', { event: 'log_event_rejected', reason: 'internal' });
    }
  };
}

/**
 * The sentence an operator alert ends with where it used to say "check `wrangler tail` for
 * detail": after C5 the tail holds the event and the error's category, which the alert already
 * carries, so it says where the detail is NOT, and how to get it.
 */
export const LOGS_CARRY_CLASS_ONLY =
  'Workers Logs hold the matching event with its error class only, never the message (PIA C5); ' +
  'reproduce locally for the detail.';

/** The kit's logger. `logEvent('route_error', { method, path, err })`. */
export const logEvent: Logger<typeof KIT_LOG_EVENTS> = createLogger(KIT_LOG_EVENTS);
