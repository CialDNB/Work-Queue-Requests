# Paved Road — Implementation Handbook

**Audience:** the platform maintainer and future agent sessions. This is the canonical
spec: a cold senior engineer should be able to rebuild or evolve the kit from this
document alone. The builder-facing story is [../GUIDEBOOK.md](../GUIDEBOOK.md); the
exec story lives on docshub. Decisions referenced here are recorded in
[DECISIONS.md](DECISIONS.md) (append-only).

**Provenance:** the kit distills three production CIAL codebases — **docshub** (auth,
sessions, AI gateway + budgets, cron/backup/health, CI gates, engineering norms),
**Arena-2** (defineRoute paved road, protected core + CODEOWNERS, semgrep fence,
isolation tripwire, harness hooks, dormant-deploy CI), and the **gstack practice
review** in the Arena 2.0 master plan (skills-as-virtual-team, repo-native harness,
prime-directive preambles, "completeness is cheap" — adapted into our own audited
code; we never blanket-install third-party skills/hooks on systems holding company
data). Patterns were copied; identifiers never were: everything here targets the Cial
account `13878ca5057070dd0140af23d2d5508f`, zone `cialdnb.ai`
(`56e69188863ffae4a16ee94fc4f8891b`). docshub itself runs on a different account —
copy its patterns, never its IDs.

---

## 1. Component spec & rationale

### 1.1 Worker + SPA (single deployable)

One Worker serves API + auth + health + cron and the built SPA via Static Assets
(`run_worker_first` pins `/api/*`, `/auth/*`, `/_health`, `/mcp`; everything else
falls through to `web/dist` with SPA not-found handling). *Rationale:* one deployable
= one resource set per environment, one health surface, zero CORS (same-origin SPA),
and the cheapest possible mental model for builders. Arena's three-worker split
(origin isolation for client-facing content) is deliberately not carried — §3.

### 1.2 The paved road (`src/framework/defineRoute.ts`)

`defineRoute({ method, path, permission, input, audit, rateLimit?, needs?, uniformityFixture, handler })`
with definition-time guards: mutations must declare `audit` (string or explicit
`false`); `:param` routes must carry a `uniformityFixture`; a `rateLimit` (if given) must
have positive-integer `limit`/`windowSec`. The mount pipeline injects
principal resolution → CSRF → permission check (denial renders `notFound()`) → optional
per-principal `rateLimit` (over the limit → `429` + `Retry-After`; placed AFTER the
permission check so a forbidden caller still 404s and a 429 can't leak a route's existence)
→ Zod parse (precedence params > query > body) → repositories (`ctx.db`) → handler →
audit-on-write → canonical envelope; non-AppError exceptions render an opaque 500.
`needs: ['notes']` (optional) narrows `ctx.db` to `Pick<Db, 'notes'>` at compile time and
backs it with a view that throws on any other repository (`src/framework/scopedDb.ts`) —
least privilege for the data layer instead of ambient authority over every table. Omitting
it keeps the whole `Db` on the pre-`needs` path: no view is built, nothing extra allocated.
`npm run verify:needs` counts how many of an app's routes declare it and names by file, line,
method and path every route that does not — with the `needs` each one would declare. It is
**report-only** and always exits 0: `needs` is opt-in by construction, so a gate today would
red every fork that predates it. The report is what moves the number; it becomes a gate on a
coverage threshold (`--gate`, already implemented) — see DECISIONS, `verify:needs`.
*Rationale:* the framework is where invariants live; handlers stay 10-line business
logic. Guards throw at module load so violations fail every test run, not just review.
There is intentionally no `'public'` permission: public surfaces (auth, health) live
outside the framework, making "fail-closed" a structural property, not a convention.

### 1.3 Auth module (§6 has the security model)

Magic links: 64-hex tokens in **D1**, 15-min TTL, consumed by conditional
`UPDATE…RETURNING` (atomic anti-replay; docshub's 2026-05-18 move). Sessions: KV,
24h TTL, `__Host-app_session` (HttpOnly/Secure/Lax), `revoked-sessions:<email>`
timestamp for force-logout (effective within ~60s at every PoP — KV read caching;
disable-a-user is the instant path via the per-request live `users` D1 check). Roles
owner/admin/member/viewer + `canManageRole` hierarchy + last-owner protections.
`t_*` bearer tokens: 40 hex, SHA-256 at rest, prefix for UI, per-user revocation,
same live-user check, mandatory expiry (≤ 90 days), a scope ceiling, and never the
non-delegable set (PIA C8 — `principalCan`, src/auth/permissions.ts). Email behind `src/email/transport.ts` (Cloudflare Email Service
binding; fail-open outside production while zone email is pending, the undelivered link parked
in a 15-minute SESSIONS KV outbox for addresses opted in via `MAGIC_LINK_OUTBOX` — never logged,
PIA C5).
Entra lands by adding an OIDC callback that calls `createSession(env, email,
'entra_oidc')` — the Principal seam means nothing downstream changes; authorization
never branches on `authMethod` (Arena invariant, kept verbatim).

### 1.4 Data layer

All D1 access in `src/data/` repositories; semgrep rule `d1-access-outside-data-layer`
fails CI on `*.DB` member access anywhere else (the health ping is exported FROM the
data layer for exactly this reason). Repos return typed rows, `null` for missing,
booleans for mutations, keyset cursors for lists. *Rationale:* the fence is how past
incidents (unscoped access from feature code) become impossible rather than reviewed-for.

**Machine upserts: an unchanged row writes nothing.** A sync, ETL or job that pushes rows it
has pushed before must make an unchanged row a no-op. The `ON CONFLICT … DO UPDATE` carries
a `WHERE` that compares every mirrored column with `IS NOT` — `WHERE t.a IS NOT excluded.a
OR t.b IS NOT excluded.b …`, or, when the upsert merges with `COALESCE`, `WHERE
COALESCE(excluded.a, t.a) IS NOT t.a OR …`. Use `IS NOT`, never `<>`: `NULL <> 'x'` is NULL,
so a `<>` chain silently skips a row whose value went to or from NULL. A skipped row reports
`meta.changes = 0`, so the repository can return changed vs unchanged counts and the caller
can see wasted pushes. Two rules follow, and they are the point, not side effects:

- **`*_synced_at` means "last changed", not "last seen".** A timestamp the upsert stamps moves
  only when a mirrored value moves. Stamping it on every push turns every push into a real
  write, billed and indexed like any other. That is how insights (2026-09) wrote 5.9M upserts
  in 7 days into a 40k-row table.
- **Liveness comes from a run marker.** "Did the sync run?" is answered by one small record
  per run (started/finished, pushed/changed/unchanged counts) in the app's run table or a KV
  key, the way `heartbeat:last` and the heartbeat audit row answer it for the daily cron.
  Never answer it by rewriting data rows to refresh their timestamps.

Before choosing a sync strategy, ask the question insights learned to ask first: **does the
source record when a row changed?** And does that timestamp cover every column you mirror? A
column joined in from another table can change without moving the parent's timestamp. If
yes, sync incrementally on a keyset watermark (that timestamp, with the key as tiebreak) and
send only what changed. If no, incremental sync is impossible in principle: the only correct
answers are a full refresh of a bounded subset, made cheap by the rule above, or an upstream
schema change (insights DECISIONS 2026-09-11, C36-1760/1761). The predicate is proven in
dnbnews (`src/data/companies.ts`, `upsertRegistry`): re-upserting 500 unchanged rows took
24 s before it and is a no-op after it.

### 1.5 AI plumbing

`src/ai/anthropic.ts` — raw typed fetch (deliberate; the gateway contract stays
auditable) to `gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic/v1/messages`
when `AI_GATEWAY_ID` + `AI_GATEWAY_TOKEN` resolve, else direct API with a warning.
The gateway is FLEET-SHARED (`all-pr-apps` — one authenticated gateway for every kit
app; Cloudflare caps gateways at ~20/account) and each call carries
`cf-aig-metadata: {app, env}` for per-app logs/analytics/spend attribution (DECISIONS
2026-08-28); **every gateway call sends `cf-aig-collect-log-payload: false`** (app
content must not persist in gateway logs — docshub decision 2026-06-11, kit-wide
invariant).
Budgets (D11): per-call $0.50, per-user-day $5, per-app-day $50, env-overridable,
0 disables; enforced by atomic reserve-then-reconcile on `ai_budget_reservations`
(closes the check-then-spend race because D1 serializes writes); every billed call appends
to `ai_usage`. Pricing table verified against Anthropic's catalog (opus-5-5 $4/$20,
sonnet-5 $2/$10, opus-5 $5/$25, sonnet-4-6 $3/$15, opus-4-8 $5/$25, haiku-4-5 $1/$5; cache
write 1.25× 5-minute / 2× 1-hour, read 0.1× — 0.05× on opus-5-5); a dated snapshot echo
(`<id>-YYYYMMDD`) prices as its base id, and unknown models price at an expensive fallback so
new models can't undercount. An optional
`effort` rides as `output_config.effort` only to models a single capability table says
accept that level (never Haiku 4.5, which rejects it); `budget_tokens` and sampling params
are never sent. Every result carries `stopReason`; a `stop_reason: "refusal"` (an HTTP 200
when any model or a safety classifier declines; most common on the generation-5 models)
settles the budget on billed usage and throws `422 ai_refused` — it never returns as a
reply. Every call is pinned with `inference_geo` (`AI_INFERENCE_GEO`, default `"us"`, billed
1.1×; `"global"` is refused in production) and goes only to a model on the allowlist in
`src/ai/policyVocabulary.mjs` — Claude 4.6+ models the kit prices, never Haiku 4.5 (it rejects the
pin) or a Covered Model — else `503 ai_model_not_allowed`; `npm run verify:edge` refuses a
deploying config that names either. Requests carry content blocks (`text`, `tool_use`,
`tool_result`, `thinking`, `redacted_thinking`), custom tools and `tool_choice`, rebuilt from an
allowlist: server tools, images, documents, Files API references, beta headers and any endpoint
but `/v1/messages` are refused as `500 ai_request_refused` (the zero-data-retention guard, PIA
C6); a returned call for a tool the request did not offer is refused too. Pricing adds 1-hour
cache writes (2×) and per-model cache reads (0.05× on Opus 5.5), and the reservation stays worst
case: tools, system and blocks at ~3 characters per token on the Claude 4.7+ tokenizer (~4 on
the previous one), a cache-marked prefix reserved as the write a miss bills (a breakpoint inside a
`tool_result` included). Once the request is sent the call is billed: an abort after that books
it (a non-streaming call its reservation, a stream what was observed), as does a non-streaming
body that never arrives whole; only an abort before sending, a network error or a non-2xx
releases it.

`streamAnthropic()` streams normalized events over SSE and settles the budget once — on
completion, failure, abort, or a consumer's `break` / `return()` — booking what was observed
after the 2xx, and the whole `max_tokens` on an early end where output may be hidden (Opus 5.5,
Opus 5 and Sonnet 5 think without streaming it). The settlement runs in the generator's
`finally`, so **a route that streams to a client** must: (1) pass an AbortSignal as
`input.signal` — `return()` waits behind a pending read, so only an abort stops the provider
promptly while it thinks; (2) in its ReadableStream's `cancel()`, abort that signal and then call
`generator.return()`; (3) hand that promise to `ctx.waitUntil`, since a client disconnect can
cancel un-registered work before the D1 writes land. A generator dropped without `return()` never
settles. Failure logs carry the status and the provider's error type, never a body (PIA C5). CI
never calls the gateway (no key in CI; tests inject fetchers).

**Masking (PIA C3)** — `src/ai/mask.ts` (identifier lists and check digits in
`src/ai/maskVocabulary.ts`), dormant until the P2 loop. Every tool result goes through
`maskToolResult` before the model sees it: the PARSED payload, before the MCP adapter or the loop
serializes it, and before it is truncated for the context window. National ids and identity fields
become per-turn tokens, by key (CPF, RUT, CURP, DNI, birth date, address, nationality … in
en/pt/es, plurals and one-case compounds included) and by checksum-valid value in any string (CPF,
person CUIT/CUIL and RUC, punctuated RUT, CURP, person RFC). Company ids are not masked, except a
Peruvian RUC 20 that is also a valid person CUIT. Raw values stay in the step's `MaskTurn` and are
never serialized; `turn.counters()` carries the numbering to the next Workflow step. A DPO
egressRuling's `allowRaw` names the fields that go raw, and `identityKeys` the extra fields a
route masks. A token in model output is untrusted: a raw value may replace one only for the same
turn and step, in a plain text node, never in a URL or an attribute.

**Token format, for the DSR search (PIA §7.3):** `[LABEL#N]`, where LABEL is one of CPF, RUT,
CURP, RFC, CUIT, CUIL, RUC, DNI, SSN, PASSPORT, ID, DOB, BIRTHPLACE, NATIONALITY, ADDRESS, PARENT
and N counts per label from 1 in each turn (regex: `MASK_TOKEN_PATTERN`). A token is not a
pseudonym: it restarts every turn and no token-to-value map is kept, so a transcript cannot be
searched for a subject by token. Identifiers still reach transcripts: through what a user types,
through fields an egressRuling lets through raw, through the model repeating either, and through
anything the masker misses. So search every message (user, assistant and tool content) for every
format of the subject's identifier as §7.3 lists them, and read a token hit as "some identifier
was masked here", never whose. A token-shaped literal in source data is rewritten to `(LABEL#N)`,
so every token in a masked tool result was minted by the masker; one in model output may not be.

### 1.6 Ops loop

Daily cron 03:00 UTC: full D1→R2 backup (`db-backups/YYYY-MM-DD.jsonl.gz`, meta header
+ `_table`-tagged JSONL rows; daily-not-weekly per DECISIONS), magic-link prune,
heartbeat (KV `heartbeat:last` + audit row with per-task results), alert-on-failure
(email `ALERT_EMAIL`, optional `ALERT_WEBHOOK_URL`; best-effort). This cron is the
PRIMARY backup retention; `provision` also sets an idempotent R2 **lifecycle backstop**
on the backups bucket (delete `db-backups/` past `BACKUP_RETENTION_DAYS` + 7d) so PII
backups expire even if the cron is down — a fixed-id rule PUT-replaced, so re-provisioning
never duplicates it. `/_health`: D1 ping
(unhealthy if down), KV roundtrip, backup marker, heartbeat staleness >26h →
degraded; CI's deploy smoke passes ok|degraded, fails unhealthy/unreachable.
**Restore runbook:** download the day's object → gunzip → for each line with
`_table`, INSERT into that table (header line lists tables; restore into a fresh D1
then swap binding, or in place after truncating affected tables via reviewed migration
— never ad-hoc; the bash guard blocks DROP/TRUNCATE for this reason). **`api_tokens` rows
from a backup taken before PIA C8** (DECISIONS 2026-09-23) need 0003's rule applied as they
are inserted: the C8 shape makes `expires_at` NOT NULL, and nothing re-runs the migration's
back-fill for restored rows. Insert `expires_at` as `datetime('now', '+90 days')` when it is
NULL or later than that, and leave `scopes` NULL (a legacy token), exactly as
`migrations/d1/0003_api_token_scopes.sql` does — or skip those rows and have the owners
re-mint. Never restore a token with no expiry, or with more than 90 days left — except a
SERVICE identity's token (`email` under `.invalid`), which may have up to 365.
**`service_identities`** (DECISIONS 2026-09-24) refuses DELETE and any change to its slug,
identifier or scope by trigger, so restore it into a FRESH D1 (the default above) rather than
truncating in place; restore it before its tokens, since a service token resolves only through
its identity row. **The agent transcript store (`agent_*`, migration 0006) is never in a backup**
(`EXCLUDE_PREFIXES`, `src/data/backup.ts`; DECISIONS 2026-10-04): a restored database starts with
the six tables empty (schema.sql or 0006 creates them), and no transcript, approval or feedback row
comes back after a D1 loss. That is the design's default for owner question 3 (pending DPO
confirmation), not a gap: a backup copy would outlive the transcript retention and every erasure.
Only D1 Time Travel (30 days) can bring agent rows back, and a DSR erasure done since must then be
re-run. It narrows what the R2 lifecycle rule has to bound; PIA C19 (that rule verified on both
backup buckets) still stands for every other table.

### 1.7 CI/CD

`ci.yml`: `test-gates` (typecheck ×3, biome **hard gate**, web build, hook/script tests, the
`verify:*` guards) and `test-suite` (vitest+coverage) in parallel behind the required `test` check,
actionlint (pinned binary), gitleaks (pinned, full history), semgrep (pinned pip,
`--config semgrep/ --error`). Staging deploy auto on main **behind `DEPLOY_ENABLED`**
(Arena's dormant pattern — template CI is green from commit one) + `/_health` smoke
with retries. Production deploy is a human command after GO-LIVE sign-off. Tiered
pre-commit (typecheck+lint; `PAVEDROAD_PRECOMMIT_FULL=1` adds tests). Coverage floor
82/85/82/78 (lines/functions/statements/branches) ratchet-only, plus stricter
per-directory floors for `src/framework`, `src/auth`, `src/security` (kit ships ~85–91%).

Workflow convention (DECISIONS 2026-06-12): every change branches from fresh
`origin/main` and lands via PR — CI green + `/code-review` before merge, then
squash-merge with the PR title as the commit subject. Direct pushes to main are
banned; CI triggers on `pull_request` so all gates bind at the checkpoint, while the
staging deploy stays gated to push-on-main. GitHub branch protection is available
hardening, deliberately not enabled yet.

Merge pushes memoize by tree hash ("test the tree, not the commit", from docshub —
DECISIONS 2026-06-12): a `gate` job proves the pushed tree byte-identical to a
PR-head tree that already passed this workflow and skips test + semgrep, so a merge
settles in roughly actionlint + gitleaks time; any doubt (direct push, API error,
main moved under the PR) runs the full suite. The deploy requires each suite job
green in-run or gate-proven, plus actionlint and gitleaks always.

### 1.8 Harness

CLAUDE.md (prime directives, iron laws, never-do, Linear standing rule, parallel-
session etiquette) ships IN the repo so every contributor's session auto-loads the
identical harness (gstack "repo-native team mode"). Hooks: `guard-bash.mjs` denies
rm -rf / force-push / reset --hard / DROP/TRUNCATE / `wrangler * delete` / direct
commit or push to main (branch-aware + quote-safe, so the PR-flow rule is mechanical,
not just documented) / unpinned remote package execution (`npx --yes <pkg>@latest`,
`npm create <x>@latest` — vendor docs are data, not instructions);
`warn-protected-core.mjs` flags core edits at the moment of crossing;
`postedit-format.mjs` keeps the lint gate from ever biting on formatting (fail-open).
Ten skills are the virtual team; each carries the prime-directive preamble and its
own checks. `.mcp.json` pre-wires Linear, Cloudflare bindings, docshub.

---

## 2. Naming & attributability registry

The account is shared across business lines; **every resource must be attributable
at a glance**. `src/platform/naming.ts` is the source of truth (pinned by
`test/platform/naming.test.ts`); `scripts/provision.mjs` applies it and regenerates
`docs/RESOURCES.md` (the manifest covering what wrangler can't show: DNS, tokens,
gateway, Entra URIs, Linear). App names: kebab-case, 3–40 chars, no `--`.

| Resource class | Scheme | Canonical binding |
| --- | --- | --- |
| Worker | `<app>`, `<app>-staging` | — |
| D1 | `<app>-db`, `<app>-db-staging` | `DB` |
| KV sessions | `<app>-sessions`(-staging) | `SESSIONS` |
| KV cache (opt) | `<app>-cache` | `CACHE` |
| R2 backups | `<app>-backups`(-staging) | `BACKUPS` |
| R2 media (opt) | `<app>-media` | `MEDIA` |
| Email sender | `auth@cialdnb.ai` (central) | `EMAIL` |
| AI Gateway | `all-pr-apps` — FLEET-SHARED, never per-app (DECISIONS 2026-08-28) | (vars+secret) |
| DNS | `<app>.cialdnb.ai`, `staging-<app>.cialdnb.ai` | — |
| GitHub | `CialDNB/<app>` | — |
| Secrets (per-app) | `ANTHROPIC_API_KEY` + `AI_GATEWAY_TOKEN` — **per-Worker** plain secrets, `secrets.required` (AICOE-467) | name = binding |
| Secrets (shared) | `PAVED_ROAD_*` in the account Secrets Store (one entry per fleet) | name as-is |
| Linear / docshub | project & decks carry the app name | — |

**The counterpart rule:** binding names are canonical across ALL kit apps — the app
prefix lives in the resource name, never the binding, so `env.DB` means the same thing
everywhere. Orphan audits of the shared account reduce to "list resources; flag any
not matching `<known-app>-…`" (the pre-kit `linear_intercom_sync` snake_case resources
on the account are the cautionary example).

## 3. Arena right-sizing record (deliberately NOT carried, and why)

| Arena mechanism | Kit decision | Why |
| --- | --- | --- |
| Branded `ArenaId` + `ScopedDb` (compile-time tenant scoping) | **Not carried**; documented opt-in | Single-tenant internal tools have no tenant boundary to scope; the tax on every query buys nothing. Apps going client-facing adopt it from Arena-2 (`src/data/scoped.ts`, `repository.ts`) |
| Cross-tenant isolation tripwire | **Right-sized** into the 404-uniformity tripwire | The enforcement *pattern* (every `:param` route must register a fixture; suite walks the registry; no silent opt-out) is the valuable part — re-aimed at permission-vs-existence instead of tenant-vs-tenant |
| Three workers (app/content/MCP origin isolation) | **Not carried** | Origin isolation defends user-authored HTML serving; kit apps serve their own SPA only. MCP is an opt-in template, mounted on the same worker behind `t_*` auth |
| `enforceResponseScope` runtime walker | **Not carried** | It exists to catch foreign-tenant leaks; no tenants → no signal, real per-request cost |
| Postgres/Hyperdrive seam | **Not carried** | D1 is the default (§5); the repository pattern IS the seam if an app outgrows it |
| External-viewer share grants | **Not carried** | Invite-only is the kit's trust model; external sharing is an app-level feature with its own review |
| 8h session TTL | 24h + revocation + live user check | Internal-tool friction trade; the instant-removal property is preserved (DECISIONS) |
| Console-only audit sink | D1 `audit_log` table (docshub-style) | Internal apps need queryable "who did what" more than log-pipeline flexibility |
| Kept verbatim: | fail-closed auth · 404-uniformity · authorization-never-branches-on-authMethod · data-layer semgrep fence · protected core + CODEOWNERS · guard/scope-lock hooks · dormant deploys · audit-on-write | These are the invariants that survive any tenancy model |

## 4. Staging-default rubric

Every app gets staging (`staging-<app>.cialdnb.ai`, auto-deployed, crons on) — set up
by `/new-app` without asking. **Skipping is legitimate only when ALL hold:** read-only
tool; no real user/company data flows through it; expected lifespan weeks, not
quarters; blast radius of a bad deploy ≈ one team's afternoon. A skip is recorded in
the app's DECISIONS.md and resurfaces as GO-LIVE gate #4 — the reviewer re-judges it
at launch. (Cost is NOT a reason; a staging worker on the Enterprise account is ~free.)

## 5. Supabase rubric (D10)

**D1 is the default system of record.** Supabase is permitted only for genuinely
Postgres-shaped needs: heavy relational/analytical queries beyond SQLite comfort;
**pgvector** (the in-house example: building-my-agent's semantic-search memory);
realtime subscriptions; integration with an existing Postgres estate. Using it
requires: a DECISIONS.md entry in the app (need, alternatives, data classification);
access still fenced through `src/data/` repositories; named on the GO-LIVE report. Auth
stays the kit's — Supabase is a database here, never an identity provider.

**When to leave D1 — shape, not size.** A big or failing D1 is almost never a reason to
leave. insights (2026-09) looked like one: a 704 MB file, a daily backup failing every night,
alert emails. Its business data was about 33 MB. About 90% of what it stored was the kit's own
logging tables, filled by a machine sync that re-pushed a whole table every hour, with each
batch audited and read-logged as if a person had done it. The backup failed because it read
each table in one query. Postgres would have inherited the same write amplification and the
same append-only audit growth, on a second bill and a second connection path.

*Fix these first. They are D1 hygiene, not D1 limits:*

- the backup on a current kit (paged, not one `SELECT *` per table);
- machine ingest from a non-person identity, with its audit and read logging sized to runs,
  not to rows or batches;
- skip-unchanged upserts (§1.4), and a sync that sends only what changed where the source
  records changes;
- the kit's logging tables (`audit_log`, `read_log`, `ai_usage`) growing by at most 50% of what
  the backup grows by, or by under 50 MB, counted from when the fixes above landed. Append-only
  `audit_log` history written before them stays and does not count: it is not hygiene to fix,
  and deleting it takes a recorded WORM exception, never routine clean-up;
- indexes checked against real query plans.

*Then leave only if one of these still holds, measured after the fixes:*

1. **Business data** (every table except the kit's logging tables) is projected to pass
   **50% of the D1 per-database cap (10 GB) within 12 months**, from at least 30 days of
   measured size history.
2. **A Postgres-only capability** is needed: pgvector, realtime subscriptions, an extension,
   or large analytical joins that measured D1 query plans cannot serve.
3. **Changed-row writes** (not pushed rows) stay beyond what one D1 writer serves, measured as
   sustained D1 overload on those writes after batching and skip-unchanged: Cloudflare's `D1 DB
   is overloaded` errors, the `overloaded` category in the kit's alert emails. A failed audit or
   read-ledger flush is not that evidence on its own. A long request, a constraint error or a
   bug fails a flush the same way; insights (2026-09) had one flush failure in 7 days, not
   enough to call contention.
4. **The system of record must live in an existing Postgres estate.** A mirror of that estate
   does not count: mirrors stay on D1.

*Not reasons:* a big file; a failing backup; a large `audit_log`; slow queries from missing
indexes; a sync that re-sends everything. Each one has a fix inside D1, listed above.

The D1 limits a busy app does meet are solved in code, not by moving: 100 bound parameters
per statement (chunk the batch), the ~1,000-query ceiling per Worker invocation (derive the
batch cap from it), and the single-result memory limit (page the read). Leaving still needs
the app's DECISIONS.md entry above, and that entry cites the measurement that met the
trigger. The thresholds change only with a kit DECISIONS entry (2026-09-23).

**Provisioning + migrations (no local secrets).** The builder doesn't stand up Supabase
or hold its password: they ask IT for **two projects** (prod + staging — the same
two-instance isolation as D1, staging synthetic-only), and IT adds each pooled connection
string as a repo Actions secret — **`SUPABASE_DB_URL`** (prod) and
**`SUPABASE_DB_URL_STAGING`** (staging). Schema lives in `migrations/supabase/NNNN_*.sql`
and is applied to each env's project on its own deploy by `scripts/migrate-supabase.sh`
(which skips cleanly until that env's secret exists) — the same deploy-time, CI-only
posture as D1. An app that instead wants per-PR preview databases may opt into Supabase
Branching by exception (record it in the app's DECISIONS.md; it runs migrations via
Supabase's GitHub integration, not this runner). See `migrations/supabase/README.md`.

## 6. Security model of the auth module

**Trust anchors:** possession of a work inbox (magic links) + the invite-only `users`
table + role hierarchy. **Properties and mechanisms:**

- *No password surface* — nothing to stuff, spray, or leak.
- *Anti-enumeration* — `/auth/request` responds identically for known/unknown/blocked
  addresses; refusals log the domain only.
- *Anti-replay* — atomic claim in D1: one verify wins ever; expired/consumed → 410;
  a user disabled between mint and click burns the link unauthenticated.
- *Rate limits* — 5/email/hour + 10/IP/hour on request (KV windows; coarse by design —
  spend-shaped limits use the D1 ledger instead).
- *Session integrity* — `__Host-` prefix (host-locked, no Domain, Secure forced),
  HttpOnly, SameSite=Lax; CSRF = same-origin Origin check on cookie mutations
  (Bearer exempt); cookies never reach sibling subdomains.
- *Instant revocation* — live `users` check every request (removal/disable acts within
  one request) + `revoked-sessions` timestamp (kills outstanding sessions, honors new
  ones); disabling a user revokes sessions and orphans their tokens.
- *Token hygiene* — `t_*` plaintext shown once; SHA-256 at rest; prefix-only in UIs;
  expiry mandatory (≤ 90 days, with 14/7/3/1-day notices); scoped; never able to mint
  tokens or reach admin surfaces; revocation immediate.
- *Self-protection* — nobody edits their own access; admins can't touch owners/admins;
  the last active owner can't be demoted/disabled.
- *Uniformity* — permission denial ≡ missing resource, byte-identical (tripwire-tested).

## 7. Threat model (who can do what damage, and what stops them)

| Actor | Damage vector | Stopped by |
| --- | --- | --- |
| Anonymous internet | reach data; enumerate users; guess links | fail-closed 401 on all /api; anti-enum responses; 64-hex single-use 15-min tokens; rate limits |
| Invited viewer/member | privilege escalation; read admin surfaces; existence probing | permission map + matrix tests; uniform 404s; self-modification ban |
| Compromised inbox | one magic-link login | TTL+single-use limits window; disable kills access on the next request (force-logout follows within ~60s at every PoP); audit trail shows actions |
| Stolen `t_*` token | the token's scopes (∩ the user's role) until it expires or is noticed — never minting tokens, managing users/settings, or reading audit/read logs | non-delegable set + scope ceiling; ≤ 90-day expiry; revocation; hashes at rest (DB leak ≠ token leak); audit; (rotate by mint+switch+revoke) |
| Malicious/careless builder (the real risk) | bypass auth, leak PII in seeds, unscoped queries, secret commits, runaway AI spend | the paved road itself + definition-time guards; semgrep fence; synthetic-data rule + gitleaks full-history; budget gates + payload-logging-off; CODEOWNERS on core; guard hooks on destructive commands; GO-LIVE gates |
| Compromised CI | deploy bad code to staging; exfil secrets | scoped per-app token only (blast radius = that app); prod deploy is human-only; gitleaks; secrets never in repo |
| Cloudflare account insider error | cross-app resource confusion | per-app scoped tokens (HQ-17); naming scheme + RESOURCES.md manifests make orphans/anomalies visible |
| AI prompt injection (app feature) | exfil other users' data via model context | handlers feed the model only role-readable data (review point in /security-review); payload logging off; budget caps bound cost |

Residual risks, accepted: D1 in one region (backup daily, RPO ≤24h); KV rate-limit
races (coarse ceilings only); email transport fail-open in non-prod (undelivered links parked
in a 15-minute KV outbox — needed until zone email lands; never written in production, nor under
any `APP_ENV` the allowlist does not name, nor for an address not listed in `MAGIC_LINK_OUTBOX`.
The parked value is a raw login link readable with account-wide KV read, a deliberate exception
to AICOE-346 — DECISIONS 2026-09-23).

## 8. Provisioning runbooks

### 8.1 Per-app scoped Cloudflare token (HQ-17 pattern — humans mint, never agents)

Mint an **account-owned** token — NOT a personal/user-owned ("My Profile → API Tokens")
one: Dash → the account → **Manage Account → API Tokens → Create Token → Custom** (requires
**Super Administrator**), or `POST /accounts/{account_id}/tokens`. Account-owned so the CI
credential outlives the builder — it belongs to the account, every super-admin can roll it,
and deploys audit as a service principal, not a person (see DECISIONS 2026-07-13). Scope to
**account `13878ca5057070dd0140af23d2d5508f`** and **zone `cialdnb.ai` only**: Workers
Scripts:Edit · D1:Edit · Workers KV Storage:Edit · R2:Edit · Secrets Store:Edit ·
AI Gateway:**Read** (read-only on purpose — see the note below) · Email Sending:Write (account — the outbound `send_email` permission, NOT
inbound Email Routing) · Zone DNS:Edit · Zone Workers Routes:Edit · Zone WAF:Edit · Zone Read
(all cialdnb.ai). Zone WAF grants the `/zones/{zone}/rulesets/phases/*/entrypoint` reads/writes
that `provision.mjs` (the `/auth` rate-limit rule) and `check-edge-live.mjs` (GO-LIVE gate 11)
both need — a token without it provisions "successfully" but gate 11 can never go green
(issue #182).
**AI Gateway scope (2026-08-28):** deploy tokens carry **Read, never Edit**. With the
fleet-shared `all-pr-apps` gateway, account-scope Edit on every app's CI token would mean any
one fork's leaked `CLOUDFLARE_API_TOKEN` could delete or de-authenticate the WHOLE fleet's
gateway (production fails closed → every app's AI 502s). Read is all `provision.mjs` needs:
it verifies the live gateway settings on every run (GET + drift check); a deploy token can
neither create nor edit the gateway (provision attempts a create only on a genuine 404,
which succeeds solely under a platform-owner credential — under the bootstrap credential,
bruno 03a reads and drift-checks it, 03 creates it, and 03b repairs drift read-modify-write,
carrying every non-kit setting over). Tokens minted before this change still carry Edit and keep working;
re-mint and revoke them per the bruno README's Rotation section.
Name it
`<app> provisioning token`; store in the owner vault/1Password; hand to the builder +
set as repo secret `CLOUDFLARE_API_TOKEN`; flip repo variable `DEPLOY_ENABLED=true`.
Record in RESOURCES.md. Rotate on builder change; revoke at app retirement.

**Zone Workers Routes:Edit is required even though the kit only declares `custom_domain`
routes.** `workers_dev: false` is a kit invariant, and on that path wrangler pre-checks every
route — custom domains included — with `GET /zones/{zone}/workers/routes`. Omit the scope and
the Worker uploads successfully, then the deploy dies on a bare `Authentication error [code:
10000]` far from its cause. See DECISIONS 2026-07-27.

**Per-app secrets are per-Worker now (AICOE-467) — provision no longer mints or stores them.**
`ANTHROPIC_API_KEY` + `AI_GATEWAY_TOKEN` are per-Worker plain secrets (not account Secrets Store
entries), declared `secrets.required` in both wrangler configs so a deploy fails closed if either
is missing. A per-Worker secret lives on the Worker, which a new app first gets at deploy, so they
ride the FIRST deploy via `--secrets-file`, or go onto an inert placeholder Worker the platform owner creates
first (bruno 05b/05c) — see §8.2 for the exact ordering. (`provision.mjs` therefore needs no
`API Tokens:Edit` scope anymore; the account-owned token's scope set in §8.1 is unchanged.)

### 8.2 Resources, DNS, deploys

The **Provision staging** / **Provision production** workflows do the whole bootstrap —
provision D1/KV/R2 (the fleet AI Gateway is VERIFIED read-only, never created here — §8.1), idempotently fill the `PLACEHOLDER_RUN_PROVISION`
ids, `db:apply`, optional first-owner seed — and upload the filled config + regenerated
RESOURCES.md as an artifact (commit the ids via PR). Deploys run in CI too. **The scoped
token lives only as the repo secret — never minted, held, or run on a laptop.** Under the
hood each workflow runs `node scripts/provision.mjs --env staging|production` then
`npm run db:apply:staging` (or `db:apply`) with `CLOUDFLARE_API_TOKEN` from the Actions
secret — the same script, just never on a developer machine.
**DNS records are never hand-created:** the Workers custom domain in each wrangler
config creates `staging-<app>.cialdnb.ai` on first staging deploy; `<app>.cialdnb.ai`
exists only via
the GO-LIVE launch steps.

**Per-app secrets ride the FIRST deploy (per-Worker; AICOE-467).** A new app's own
`ANTHROPIC_API_KEY` + `AI_GATEWAY_TOKEN` are **per-Worker plain secrets**, not account Secrets
Store entries — so a fresh app consumes **zero** slots of the 100-cap account store. Both are
declared `secrets.required` in the wrangler configs, so any deploy **fails closed** (listing the
missing name) until they exist. A per-Worker secret lives on the Worker, which creates a one-time
bootstrap ordering: **carry both on the first deploy with `--secrets-file`** (a break-glass,
human-run step — you are handling real key material, like the SEAL_KEY runbook). **Not**
`wrangler secret put` first: on a missing Worker, wrangler silently creates a stub one (its
"create a new Worker?" prompt defaults to yes, even non-interactively), and that stub gets a
workers.dev route — an off-zone ingress until the first real deploy turns it off.

```sh
# .secrets.<env>.json is gitignored — delete it after; the values persist on the Worker.
printf '{"ANTHROPIC_API_KEY":"<key>","AI_GATEWAY_TOKEN":"<ai-gateway-run-token>"}' > .secrets.staging.json
npx wrangler deploy --config wrangler.staging.jsonc --secrets-file .secrets.staging.json
rm .secrets.staging.json
```

**Alternative without key material in a file — the Worker first (platform owner).** The
[cf-provisioning Bruno collection](../tools/bruno/cf-provisioning) breaks the ordering the way
`wrangler secret put` does on a missing Worker: **05b** uploads an inert placeholder Worker
(answers 503, reads no bindings, no routes — it runs only after 05 has just proved that exact
Worker missing, because the same upload against a live Worker would replace its code), **05c**
switches its workers.dev and preview URLs off, then **05 → 06/07/07b** set the secrets on it.
The first real deploy replaces the placeholder code and keeps the secrets: wrangler sends an
`inherit` binding for every name in `secrets.required`. Production does the same on `<app>` at
go-live, right before the Deploy production workflow.

Do this **before** flipping `DEPLOY_ENABLED=true` (or the first CI deploy fails the `required`
gate). After it, secrets persist across every later deploy — CI's plain `wrangler deploy` carries
no secrets file. Rotate later with `wrangler secret put <NAME> --config <cfg>` (the Worker now
exists). One key per app (same values in prod + staging). An app that genuinely uses no AI can
drop the two names from `secrets.required` in both configs. Shared secrets
(`PAVED_ROAD_ALERT_WEBHOOK_URL`, Entra, Turnstile, registry) stay single account Secrets Store
entries — see §8.4 and docs/SECURITY-EDGE.md.

**Database migrations run on deploy — never on a laptop.** `schema.sql` is the
fresh-install baseline (applied at provision + in tests). Every change *after* that goes
in `migrations/d1/NNNN_*.sql`, and each deploy — staging (push to `main`) and production
(*Deploy production*) — runs `wrangler d1 migrations apply` **before** shipping the
Worker, using the `CLOUDFLARE_API_TOKEN` already in CI. So a builder edits a migration
file and the schema lands on the next deploy; the D1 key is the only credential needed.
The deploy log runs `wrangler d1 migrations list` per environment as the pending-migration
check (`npm run db:migrate:check` lists staging locally). **Supabase** (by-exception — §5) follows the
same shape: numbered files in `migrations/supabase/`, applied by
`scripts/migrate-supabase.sh` when the `SUPABASE_DB_URL` repo secret exists (IT adds it
when they provision the instance), inert otherwise. See `migrations/d1/README.md`.

### 8.3 Zone email for magic links (one-time platform task — D6)

Central sender `auth@cialdnb.ai` for ALL kit apps. Steps: `npx wrangler email sending
enable cialdnb.ai` (or Dash → Email) → add the offered DNS records (SPF/DKIM/MX) to
the zone → verify → confirm `npx wrangler email sending list` shows the domain →
send a test via any kit app. Until done, every app's transport fail-opens with logged
links (non-prod only). One domain onboarding covers every app because all senders are
`@cialdnb.ai` and the `EMAIL` binding is unrestricted-send within verified domains.
Step-by-step: [runbooks/cloudflare-email-setup.md](runbooks/cloudflare-email-setup.md).

### 8.4 Entra app registration (one-time platform task — D5)

Step-by-step: [runbooks/entra-sso-setup.md](runbooks/entra-sso-setup.md).

One shared **multi-tenant** registration **"CIAL Internal Apps"** (hosted in the CIAL
tenant, covering the D&B Israel + Trusted Partners directories via admin consent —
the kit validates the token's `tid` against `ENTRA_ALLOWED_TENANTS`, fail-closed):
Entra admin → App registrations → New → **accounts in any organizational directory**
→ redirect URIs (Web) added **per app** as
`https://<app>.cialdnb.ai/auth/oidc/callback` (+staging) → `email` **and `xms_edov`**
optional claims (ID token; `xms_edov` is REQUIRED — see the identity binding below) →
create a client secret per major rotation window (Secrets Store:
`PAVED_ROAD_ENTRA_CLIENT_SECRET` — shared, never renamed on bootstrap) → record
client ID + secret expiry in the kit's RESOURCES.md. Kit-side (shipped 2026-07-01):
`src/auth/oidc.ts` validates the ID token (signature/issuer/tid/audience/nonce),
**binds identity to a domain-VERIFIED claim** (below), requires the user active in
**this app's** `users` (no JIT provisioning; SCIM deliberately out of scope), and calls
`createSession(env, email, 'entra_oidc')`.
**Identity binding — do not simplify this back to "use the `email` claim".** `email` is
mutable directory data Entra does not verify: any tenant can set it to any address, so
trusting it lets a member of ANY allowlisted tenant sign in as anyone — including the
owner (nOAuth; the tenant allowlist does not cover it, because it confines which
*directories* authenticate, not which *addresses* they assert). So `email` is trusted
only with `xms_edov: true` (domain-owner verified) or when it equals
`preferred_username` (the UPN, domain-bound by construction); otherwise the UPN is the
identity; with neither, the login is refused. See DECISIONS 2026-07-15. Per-app onboarding cost after that: one
redirect URI line + three vars. *Why shared:* one registration to audit, one secret
to rotate, per-app URIs keep the blast radius per-app.

### 8.5 Linear & docshub

Linear: `/new-app` asks the team AND whether an existing project should be linked
(URL/ID) — new projects get the standing rule in the description; linked ones get it
as a comment. docshub: app decks (handbooks, leadership decks) are uploaded under the
app's name; allowlist deliberately.

## 9. Go-live gates & owners

Definitions and evidence requirements live in [GO-LIVE.md](GO-LIVE.md): 10 blocking
gates (security review, data classification + synthetic-data verification, fail-closed
spot-check, staging-or-rubric, observed backup, AI budget gates, RESOURCES.md current,
named owner, rollback, Linear/docs) + advisory items. **Owner: Yoni Cohen** —
delegation is editing one line in GO-LIVE.md, deliberately. `/go-live` collects
evidence and stops; humans execute the launch steps.

## 10. Kit versioning & downstream upgrades

The kit is a **GitHub template repository** (clean history; no fork link). Versions
are CHANGELOG entries on `CialDNB/paved-road` main (semver-ish: breaking protected-core
changes bump minor pre-1.0). **Propagation is pull-based:** `/kit-upgrade` in each app
adds the template as a `kit` remote, reads CHANGELOG deltas, diffs the protected core
(which is app-agnostic by design — app identity lives in configs and feature land),
adopts hunk-by-hunk, runs `npm run ci`, and records the adoption. The maintainer
announces upgrade-worthy versions in the kit's Linear project. v2 option if app count
grows: a scheduled agent that opens upgrade PRs across `CialDNB/*` kit apps.

## 11. Migration playbook (existing vibe-coded apps)

**Assess** — inventory: where it runs, who uses it, what data it holds (classify
PII!), auth-or-not, what the platform did for it (cron? storage? auth?). Screenshot
every screen. Export the data. **Rehost** — "Use this template" → `/new-app` → port
the schema into APP TABLES → import data (one-off script or `wrangler d1 execute`
inserts) → rebuild screens with `/add-page`+`/add-endpoint` (the DESIGN-PROMPT
template helps when the UI deserves rethinking) → invite the existing users with
roles. **Redirect** — old platform URL → interstitial or platform redirect to
`<app>.cialdnb.ai` after GO-LIVE; run both for one overlap week max. **Retire** —
delete the old deployment AND its data (verify, don't assume), cancel the
subscription, record the retirement in the app's DECISIONS.md + Linear. Per-app effort
is dominated by screen count and data cleanliness — size by those, not by calendar.

## 12. Maintenance duties (the kit's own)

| Duty | Cadence / trigger |
| --- | --- |
| Dependency bumps (wrangler, hono, vitest, biome, react) + `npm run ci` + CHANGELOG | monthly, or on security advisories |
| Pricing table & default models vs Anthropic catalog | on model launches; verify, never invent |
| Pinned CI tool versions (actionlint/gitleaks/semgrep) | quarterly |
| Re-run the kit's own staging demo bootstrap (template smoke) | after protected-core changes |
| Review downstream DECISIONS for patterns worth upstreaming | monthly skim |
| Rotate: kit demo scoped token; Entra secret | 6-monthly / per policy |
| Account orphan audit (resources vs RESOURCES.md manifests) | quarterly |
| Platform pendings until closed: zone email (D6), Entra registration (D5), central alert address (D9) | tracked as Linear issues |

## 13. Verification & evidence (verified on current `main`)

`npm run ci` green from a fresh clone: typecheck (3 configs) · biome clean · web build
· **233 tests / 24 files** in a real Workers runtime · coverage ~89% lines / ~88%
stmts / ~85% branches / ~91% funcs against the 82/85/82/78 floor (plus stricter
per-directory floors for framework/auth/security). The uniformity
tripwire covers every registered `:param` route; the permission matrix enumerates
every key × role. CI additionally runs gitleaks (full history) and actionlint on
every push; semgrep runs on every PR and on any main push the tree-memo gate
can't prove already-tested (§1.7).
