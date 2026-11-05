# API Conventions

Every kit app's API looks the same, so a human or agent moving between apps never
relearns the basics. These conventions are enforced by the paved road itself —
`defineRoute` and the golden example (`src/routes/notes.ts`) make deviation take
effort. Derived from docshub/Arena practice.

## URLs & resources

- `/api/<resource>` — plural, kebab-case: `/api/notes`, `/api/cost-reports`.
- Item routes: `/api/<resource>/:id`. Sub-actions that aren't CRUD: POST
  `/api/<resource>/:id/<verb>` (e.g. `/api/users/:email/revoke-sessions`) — sparingly.
- No `/v1/` prefix. Internal APIs evolve **additively** (new fields/endpoints fine;
  renames/removals are breaking → DECISIONS.md migration note). A version prefix
  appears only when a real break forces one.

## The envelope (every JSON response)

```jsonc
{ "ok": true,  "data": … }                                  // success
{ "ok": false, "error": { "code": "…", "message": "…" } }   // failure
```

- `code` is machine-readable snake_case: `validation_failed`, `unauthorized`,
  `not_found`, `csrf_rejected`, `conflict`, `rate_limited`, `internal_error`,
  `domain_not_allowed`, `ai_unconfigured`, `ai_budget_*`, `ai_upstream_error`,
  `ai_refused`, `ai_model_not_allowed`, `ai_request_refused`, `ai_aborted`.
- `message` is human-safe. **Never stack traces, queries, or internals** — unknown
  errors render as an opaque 500 (`internal_error` / "Internal error"); details go to
  observability only.
- Exceptions to the envelope: 204 (no body) for DELETE/logout, 302 for auth redirects.

## Status codes

| Code | Meaning here |
| --- | --- |
| 200 / 201 | OK / created (POST create returns 201 with the row — except on a `machine: true` route, whose write returns its counts and never a record it read: see machine routes below) |
| 204 | Deleted / logged out |
| 400 | Validation failed (Zod message, ≤5 issues joined) |
| 401 | No/invalid credentials — "log in first" (leaks nothing about resources) |
| 403 | CSRF rejection ONLY — never resource access |
| **404** | Missing **or forbidden** resource, unknown API path — byte-identical everywhere (**the uniformity invariant**) |
| 409 | Conflict (duplicate, last-owner protection…) |
| 410 | Consumed/expired magic link |
| 422 | The AI model declined the request (`ai_refused`) — nothing partial is returned |
| 429 | Rate limit / AI budget refusal |
| 499 | The caller aborted its own AI call (`ai_aborted`) — nothing is returned to a client that has stopped listening |
| 5xx | Opaque. The AI client's configuration faults name the rule, never request content: `ai_model_not_allowed` (503, the model cannot be pinned to the inference region) and `ai_request_refused` (500, a tool, block or field outside the zero-data-retention allowlist) |

## Auth surfaces

- **SPA:** `__Host-app_session` cookie (HttpOnly, Secure, SameSite=Lax, 24h),
  CSRF = same-origin `Origin` check on mutations. A request with **no** `Origin` header is
  allowed (non-browser clients); `SameSite=Lax` is the backstop that stops a cross-site form
  from sending the cookie in a browser.
- **Programmatic/MCP:** `Authorization: Bearer t_…` (mint in the Tokens tab; hashed at
  rest, shown once, revocable, dies with the user). CSRF-exempt by nature. Every token
  **expires** (default and maximum 90 days — rotate machine tokens per
  `docs/runbooks/machine-token-rotation.md`) and carries **scopes**: optional `scopes` on
  `POST /api/tokens` names the permission keys it may use (default: everything your role may
  delegate at mint time). A token can never hold the **non-delegable** set — `tokens.self`,
  `users.manage`, `settings.manage`, `audit.read`, `readLog.read`, `meta.read`,
  `serviceIdentities.manage`, `agent.use`, `agent.erase` — so it cannot mint, list or revoke tokens,
  manage users, settings or service identities, read the audit logs or the manifest, start an agent
  run, or reach the agent's subject-rights route. Asking for one of them in `scopes` is a 400.
  Denied → the uniform 404, like any other denial (PIA C8, DECISIONS 2026-09-23 and 2026-10-04).
- Both mint the same Principal; permissions come from the role, never the method — or, in an app
  whose authority hook (`src/routes/authorityPolicy.ts`) answers one, from an AUTHORITATIVE set
  that replaces the role (an ACL grant). A bearer token only NARROWS what its owner holds
  (`principalCan`, keyed on `credentialTransport`), never widens it. In such an app the role is
  bookkeeping: a route that asks a role question (`canManageRole(ctx.principal.role, …)`) must
  decide what that means for an externally-authorised caller.
- **`permission: 'authenticated'` is outside the scope system.** It means "any active PERSON",
  so the key check (and with it the token's scopes) is skipped: every personal token reaches such
  a route, `scopes: []` included. A service identity never does. The kit uses it only for
  `GET /api/me`. Anything that mutates, or returns more than the caller's own identity, takes a
  real permission key.
- **Integrations authenticate as a SERVICE IDENTITY** (`svc-<slug>@<app>.invalid`), with a bearer
  token an owner/admin mints under Settings → Service identities: exactly ONE permission key, 90
  days by default and up to 365, recorded under its own identifier. It gets the same uniform 404
  on any other route (plus an `authz.denied` audit row) and a `401` while its identity is disabled
  or its custodian is not an active user. Give a machine-facing route its own narrow key so an
  identity can hold exactly it. See docs/runbooks/service-identities.md.

## Validation, pagination, idempotency, audit

- **Validation at the boundary:** every route declares a Zod schema; handlers receive
  typed input. Merge precedence: **path params > query > body** (a body can never
  redirect a mutation).
- **Pagination:** `?limit=` (default 50, capped) + a `cursor` (keyset). Treat the cursor as
  **client-opaque**, but note it is base64-encoded `{created_at, id}`, **not** encrypted — so
  never put anything secret in it or rely on it being unguessable. Responses return
  `{ items, next_cursor | null }`. Newest-first by default. (Numeric `before` cursors
  acceptable for append-only logs, e.g. `/api/audit`.)
- **Filtering/sorting:** explicit validated query params only (`?status=…`), never
  pass-through to SQL. Default sort documented per resource.
- **Idempotency:** GET/PUT/DELETE idempotent; POST create is not (clients shouldn't
  blind-retry; deduplicate by natural key where it matters).
- **Audit-on-write:** every mutation writes `audit_log(actor, action, target,
  params)` — `<resource>.<verb>` action names (`note.create`, `user.invite`). Payloads
  carry params/metadata, never request bodies (PII discipline). Payload keys starting with `_`
  are **reserved** for the framework's attribution — `_via` (`mcp` | `agent`) and `_turn` (the
  agent turn id) — and a route's own `_` keys are stripped (logged as
  `audit_reserved_keys_stripped`). An HTTP call's row carries neither key.

## Exposing a route to the in-app agent

Default deny: the agent can call a route only if its `defineRoute` declares an `agent:` block,
and the kit declares none. The block states what the tool does and where its data goes, and
`defineRoute` checks it when the module loads (`src/framework/agentExposure.ts`):

```ts
agent: {
  effect: 'read' | 'write' | 'destructive' | 'external', // must fit the method
  description?: string,             // what the model reads; defaults to `summary`
  needsApproval?: boolean | ((input) => boolean), // a throwing predicate means "approve"
  approvalSummary?: (input) => ({ key: 'i18n.key', params: { name: 'value' } }), // one visible line each
  egress?: ['api.example.com'],     // hosts the route sends data to; required for 'external'
  egressRuling?: 'C36-1561',        // Linear DPO ruling; required for client-class data or egress
  render?: 'component.id',
}
```

- An exposed route declares `needs` (naming no `AGENT_FORBIDDEN_REPOSITORIES` entry — the audit
  log, the read ledger, credentials, settings, the AI budget), takes a `z.object` carrying every
  `:param`, has a permission other than `'authenticated'` and outside `AGENT_FORBIDDEN`, and a tool
  name of at most 64 characters.
- `needsApproval` is required for `destructive`, `external` and any route with `egress`, unless
  every argument is closed (PIA C16). Closedness is read from the Zod validator itself, never its
  JSON Schema (which drops regex flags and trusts `.meta()`) — and only from Zod's OWN checks that
  run on every value: a custom `z.stringFormat('uuid', fn)` is not a uuid, and a check with a
  `when` bounds nothing:
  - a **destructive** route with no egress: an enum, literal, boolean, integer, ISO date/time, a
    Zod `uuid`/`guid`/`ulid`/`nanoid`, or a `.regex()` with no flag but `i` whose pattern spells
    only `[A-Za-z0-9_-]` and at most 64 characters — or a list (`.max(n ≤ 50)`) or object of those;
  - a route whose data **leaves** (`external`, or any `egress`): no letter the model chose.
    Enums, literals, booleans, integers, ISO dates, `uuid`/`guid`/`ulid`, ISO times/datetimes with
    a fixed `precision` (≤ 9, e.g. `z.iso.datetime({ precision: 3 })` — the default takes any
    number of fractional digits) or a `.max()` of at most 32, and digit-only patterns (literal
    letters like the `Q` in `^\d{4}-Q[1-4]$` are fine) of at most 32 characters; lists only of
    enums, literals or booleans. A letter pattern (`^[A-Z0-9]{1,20}$`), a slug or a `nanoid` there
    needs approval — a predicate can limit it to the calls that carry one.
- The `agent:` block is a plain object literal of values — not a class instance, an
  `Object.create(…)` block or one with getters: the guard reads it once and keeps exactly what it
  checked.
- `egressRuling` is required when `needs` reaches a repository `src/data/dataClass.ts` does not
  classify `internal` (an unlisted repository is client-class), when the route declares `egress`,
  and on every exposed route of an app that binds a client-class private database (PIA C3;
  docs/DATA-ROUTES.md → *Private data and the in-app agent*).
- Add the route to `PINNED_AGENT_EXPOSURE` in `test/isolation/agent-exposure.test.ts` in the same
  PR. The manifest publishes the exposure (`routes[].agent`, docs/MANIFEST.md).
- The agent calls it through `buildAgentTools` → `executeRoute`, as the signed-in person; its
  audit rows carry `_via: 'agent'` and `_turn`, and its D1 read-ledger rows the turn id as
  `request_id` — its Aurora rows too, when the handler passes `ctx.requestId` as
  `AuroraCtx.requestId` (docs/DATA-ROUTES.md). Never call a route's `handler` yourself (semgrep
  `agent-dispatch-bypass`), and never build a data handle with `makeDb()` in a route module —
  `ctx.db` is what `needs` scopes (semgrep `data-handle-in-routes`).

## Machine routes

A bulk endpoint an integration calls (an ETL pushing batches) is declared `machine: true`:

```ts
defineRoute({
  method: 'POST', path: '/api/ingest/orders', permission: 'orders.ingest', machine: true,
  audit: 'ingest.orders', input: OrdersBatch,
  handler: async (ctx, input) => {
    const res = await ctx.db.orders.upsertBatch(input.rows);
    ctx.setAuditTarget(`${input.companyId}:${input.rows.length}`, await batchAudit({
      table: 'orders', received: input.rows.length, written: res.written,
      unchanged: res.unchanged, rejected: res.rejected, keys: input.rows.map((r) => r.id),
      rejectedKeys: res.rejectedKeys, runId: ctx.syncRunId,
    }));
    return res;
  },
});
```

- **Only a service identity reaches it.** A person of any role — session or personal token — gets
  the uniform 404, and a service still needs the route's key (else 404 + `authz.denied`). The key
  must be one a service may hold; `defineRoute` refuses `'authenticated'` or a non-delegable key.
  The manifest publishes `machine: true`. **Move the caller to a service-identity token before
  flipping a route:** a person's token scoped to exactly the route's key is still refused, and a
  person's denial writes no `authz.denied` row — so a caller left on a personal token 404s with no
  trace in `audit_log`.
- **`X-Sync-Run` is required**: the caller's id for the sync run, 1–64 characters of
  `[A-Za-z0-9._:-]`. Missing or invalid → `400` (checked after the permission 404, so only an
  allowed caller learns of it). `MACHINE_SYNC_RUN=warn` is the adoption mode until the caller sends
  it: the request goes through with `runId: null` and a warning log line. An invalid value is
  dropped, never stored or logged. The handler reads the validated id as `ctx.syncRunId`.
- **Audit rows are counts, not key lists.** Still ONE declared row per request. Build its payload
  with `batchAudit()` (`src/framework/batchAudit.ts`):
  `{ table, received, written, unchanged, rejected, duplicates?, suppressed?, keys, rejectedKeys?, runId }`,
  where `keys` is the fingerprint `{ count, keysSha256, firstKey, lastKey }` and `rejectedKeys`
  names at most 10. A suppressed batch keeps `suppressed: true`. Keys that contain a person
  identifier take `personKeys: true`: count and hash only, no key text at all. The counts add up:
  `received = written + unchanged + rejected + (duplicates ?? 0)`, and `written` (inserted or
  changed) does NOT include `unchanged` — unlike the #272 pilot's `updated`, so a pilot-style
  result maps as `written = inserted + updated - unchanged`. Counts that do not add up are stored
  as given, with a `batch_audit_counts_mismatch` warning.
- **The framework stamps `runId`** on every audit payload a machine route writes (so a handler
  cannot record a different one) and **caps each at 1 KB** of UTF-8 JSON: an oversize payload is
  stored as `{ oversize: true, bytes, runId }` (plus `suppressed: true` if it said so) with a
  warning. `batchAudit()` output always fits.
- **Liveness.** The daily `machine_liveness` task alerts when no machine route has written an
  audit row in `MACHINE_LIVENESS_HOURS` (default 6). It counts only rows a service identity wrote:
  a person route that declares the same action (a manual re-import), or a `ctx.audit()` extra
  under it, does not reset the clock. A database with no machine row at all stays
  silent until `MACHINE_LIVENESS_ARMED=true`. **At go-live** set it, and remove
  `MACHINE_SYNC_RUN=warn`: docs/GO-LIVE.md gate 13 checks both, from the daily detail, which says
  `armed` and `sync-run warn-only` when they apply.
- **Its reads are attributed by the audit row.** With `READ_AUDIT` armed, a service's successful
  write through a machine route (mutating method, declared `audit:` action) writes no `read_log`
  rows once its audit row has landed carrying the route's own payload, under the 1 KB cap, and the
  caller's `X-Sync-Run` id. Its GETs, every request whose audit row did not land, and every row
  without those three (no payload, the oversize stub, `runId: null` under warn-only or over MCP)
  are recorded as usual (docs/DATA-ROUTES.md → the d1 stream). The payload is judged as stored: a
  key whose value is `undefined` is not written, so `{ written: res?.meta?.changes }` with no
  `meta` is no payload. So a machine route's audit payload
  is its only in-app trace: build it with `batchAudit()` and have the caller send `X-Sync-Run`.
- **It returns counts and the keys it was sent, never records it read.** The exemption keys on the
  route's declared method, not on what its handler does, and nothing in the kit checks the
  response. A `machine: true` POST that hands back rows it looked up (a bulk lookup, a resolve-ids
  step, a diff) would carry those reads out with no `read_log` row and an audit row that names the
  service, not the person holding its token. A lookup the integration needs is a **GET**, which
  stays recorded; a write's response is its counts (the result the example returns) and, at most,
  keys the caller itself sent (`rejectedKeys`). No code checks this: `/security-review` (item 4) is
  the gate, and `/add-endpoint` states it.

**The `keysSha256` recipe** — publish it to the integration's owner so they can match rows to their
own run log: take every key the request carried (duplicates included), sort by Unicode code point,
serialize as a compact JSON array with every character from U+007F up escaped `\uXXXX` (lowercase,
per UTF-16 code unit), and SHA-256 the resulting ASCII text (lowercase hex). In Python, exactly:

```python
hashlib.sha256(json.dumps(sorted(keys), separators=(",", ":")).encode()).hexdigest()
```

For ASCII keys that is the SHA-256 of `["k1","k2",…]`. `firstKey`/`lastKey` are the ends of that
sorted list, so they bound the batch as a range.

## Adding an endpoint

Run `/add-endpoint`. It walks resource shape → permission key (+ matrix test) →
repository → defineRoute(s) → tests → `npm run ci`, and the uniformity tripwire covers
your `:param` routes automatically because registration requires a fixture.
