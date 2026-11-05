# Architecture

One Cloudflare Worker serves everything: the JSON API (Hono), the built SPA (Workers
Static Assets), the auth surfaces, the health endpoint, and the daily cron. One D1
database is the system of record; KV holds sessions; R2 holds backups.

```
Browser ──► <app>.cialdnb.ai ─┬─► /api/*  ──► defineRoute (the paved road)
                              ├─► /auth/* ──► magic links (rate-limited, anti-enum)
                              ├─► /_health──► public health JSON
                              └─► /*      ──► Static Assets (web/dist, SPA fallback)
Scripts/MCP ──Bearer t_*────────► /api/*  (same routes; role ∩ token scopes − non-delegable)
Integrations ─Bearer t_* (svc)──► /api/*  (a service identity: exactly ONE permission key)

defineRoute injects, in order:
  principal (cookie session | t_* token, fail-closed, live users-table check)
  → CSRF (same-origin for cookie mutations)
  → permission check — principalCan: role (or the authority hook's authoritative set, which
    replaces it), narrowed for bearer tokens; a service identity's one scope (denial ≡ 404; a
    SERVICE principal's denial also writes a content-free authz.denied audit row)
  → rate limit (optional, per-principal — AFTER permission, so a forbidden caller 404s first)
  → Zod validation (params > query > body)
  → ctx.db repositories (the ONLY D1 access path — semgrep-fenced)
  → handler
  → audit-on-write (append-only)
  → envelope ({ok,data} | {ok,error}) with opaque 500s

Cron (03:00 UTC): backup (D1→R2 jsonl.gz) → restore_verify → append_only_triggers (live
      sqlite_master) → prune → heartbeat (KV+audit) → alert-on-failure
AI: src/ai → AI Gateway (cf-aig-collect-log-payload: false) → Anthropic
      with atomic budget reservation before, reconcile + usage ledger after
```

> **AI prerequisite:** the AI Gateway named in `wrangler.*.jsonc` is the FLEET-SHARED
> `all-pr-apps` — one gateway for every kit app, never per-app (per-app attribution rides the
> `cf-aig-metadata` header; DECISIONS 2026-08-28). `scripts/provision.mjs` ensures it exists and
> verifies its settings. Until it exists *and* the Anthropic API key secret is set, AI calls
> fail with `ai_upstream_error` — do NOT create a gateway named after your app.

## Directory map

| Path | What | Protection |
| --- | --- | --- |
| `src/framework/` | defineRoute, envelope, errors | protected core |
| `src/auth/` | principal seam, magic links, sessions, tokens, permissions | protected core |
| `src/data/` | repositories — the only place `env.DB` exists | protected core |
| `src/email/` `src/security/` `src/ai/` `src/cron/` `src/health.ts` | transport seam, CSRF/rate-limit, gateway client + budgets, ops loop | protected core |
| `src/routes/` | **your endpoints** (golden example: notes.ts) | feature land |
| `web/` | **your SPA** (golden example: pages/Notes.tsx) | feature land |
| `schema.sql` | system tables + your APP TABLES section | protected core (system part) |
| `test/` | suite incl. permission matrix + uniformity tripwire | helpers/isolation protected |
| `.claude/` | hooks + skills (the harness ships IN the repo) | protected core |
| `scripts/` | provision, new-app, pre-commit, smoke | protected core |

## Environments

| | production | staging | test |
| --- | --- | --- | --- |
| config | wrangler.jsonc | wrangler.staging.jsonc | wrangler.test.jsonc |
| deploy | manual, post-GO-LIVE sign-off | CI on main (DEPLOY_ENABLED) | never (vitest only) |
| host | `<app>.cialdnb.ai` | `staging-<app>.cialdnb.ai` | in-memory |
| resources | `<app>-db`, `<app>-sessions`, `<app>-backups` | `…-staging` variants | miniflare |
| crons | on | on (deliberate — see DECISIONS) | invoked by tests |

Binding names are canonical across all kit apps (`DB`, `SESSIONS`, `BACKUPS`, `EMAIL`,
optional `CACHE`/`MEDIA`); the app prefix lives in resource names. `env.DB` means the
same thing in every kit app — that's what lets builders and agents move between apps
without relearning anything.

## Auth model (the interchangeable seam)

Two credential types mint the same `Principal { email, name, role, authMethod,
credentialTransport }`: session cookies (magic links today; Entra OIDC later adds a
second minting path with `auth_method: 'entra_oidc'` and changes nothing downstream —
authorization NEVER branches on authMethod) and pre-issued `t_*` bearer tokens
(SHA-256 stored, shown once, expiring within 90 days, scoped). `credentialTransport` ('cookie' | 'bearer') records how
the credential arrived on THIS request — derived at the resolvePrincipal branch point,
never stored — and is what the CSRF check keys on: only 'bearer' is exempt; anything
else (including an absent or future value) is same-origin-checked. The permission check keys on it
too (`principalCan`, src/auth/permissions.ts): a cookie holds its role; anything else holds its role ∩
the token's stored scopes, minus the non-delegable set (tokens, user management, settings, the audit
and read logs, the manifest, service identities, and the agent's run and erasure keys — PIA C8). Every request re-checks the live `users` table, so removal/disable takes effect
within one request. Force-logout is a per-email revocation timestamp in KV.

**Where a person's permissions come from — the authority seam.** By default, the role. An app whose
authority is EXTERNAL (insights: the CIAL ACL grant of the caller's current company) answers in its
fork-owned hook, `authorityFor` (`src/routes/authorityPolicy.ts`), which every person resolver calls
on every resolution (`src/auth/authority.ts`) — a session cookie, a personal token, and an agent
turn's stored session (`resolveRunPrincipal`, below, with `request: null`): `null` keeps the role;
`{ permissions }` is an AUTHORITATIVE set for this resolution that replaces the role in
`principalCan` (a bearer token's scopes and the non-delegable set still narrow it); `{ refuse }`, a
throw or a malformed answer is no principal (401), never the role. Only the resolvers set
`principal.permissions`; nothing is cached, so no permission snapshot outlives the resolution that
derived it (PIA C15). The same fork file DECLARES whether the app's
authority is external on this env (`authorityIsExternal`), and a set answered on an env not declared
external refuses. Every tool list filters through `callableBy`, so a tool the authority withholds is
never offered, and while the declaration is true the agent loop starts a run only for a person on a
session whose permissions the hook decided — never on a token, never on the role
(`authorityRefusesAgentRun`, `src/auth/authority.ts`). See DECISIONS 2026-09-25.

**Run authority — an agent turn acts as its session.** A turn outlives the request that started it
(it runs in a Workflow step, with no request), so its grant is the SESSION that started or approved
it. The turn row stores only that session's KEY — `sha256(sid)`, the suffix of its KV key, never the
sid — and its mint time, both cleared when the turn ends; no permission set is ever stored.
`resolveRunPrincipal` (`src/auth/runPrincipal.ts`) re-reads the session by key, checks it is the same
one (email and mint time), re-reads the live user, asks the authority hook with `request: null`,
applies `authorityRefusesAgentRun`, and requires that the result still holds `agent.use` — before
every model round and every tool call. Any failure ends the turn `revoked` (PIA C15); logout, the
TTL and a force-logout reach it through KV, so up to ~60 s later at another PoP. Sessions do not slide, so a turn started just before its session
expires ends `revoked` too. `agent.use` and `agent.erase` are non-delegable: no token or MCP client
starts a run or reaches the agent's subject-rights route (PIA C8). See DECISIONS 2026-10-04.

**Two KINDS of principal** (`kind: 'person' | 'service'`, set only by the resolvers). A PERSON is a
`users` row, as above. A SERVICE identity is a machine principal (an ETL, an integration) in its own
`service_identities` table: never a user, never able to sign in (the reserved `.invalid` namespace
is refused by every login and session path), authenticated only by bearer tokens (90 days by
default, up to 365), with **no role** — its whole authority is ONE permission key — and a named
custodian who must be an active person, or its tokens are refused. It acts as, and is recorded in
audit_log / read_log as, its own `svc-<slug>@<app>.invalid` identifier. Owners/admins manage them on
a session only (`serviceIdentities.manage`, non-delegable; the kit-owned routes live in
`src/auth/serviceIdentityRoutes.ts`). See DECISIONS 2026-09-24 and
[runbooks/service-identities.md](runbooks/service-identities.md).

Full rationale, threat model, and runbooks: [IMPLEMENTATION-HANDBOOK.md](IMPLEMENTATION-HANDBOOK.md).
