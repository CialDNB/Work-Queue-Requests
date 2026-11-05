---
name: add-endpoint
description: Add an API endpoint the paved-road way — defineRoute with permission, Zod validation, audit, 404-uniformity fixture, and matrix-extending tests. Use for any new /api/* surface.
---

# /add-endpoint — the API conventions, made executable

**Prime directives apply** (CLAUDE.md). The golden example is `src/routes/notes.ts` +
`test/routes/notes.test.ts` — copy its shape, not its domain. Conventions reference:
`docs/API-CONVENTIONS.md`.

## Steps

1. **Shape the resource.** Plural kebab-case under `/api/` (`/api/cost-reports`).
   Confirm: list/get/create/update/delete — which apply? Idempotency: PUT yes, POST no.
2. **Pick or add the permission key** in `src/auth/permissions.ts` (`<resource>.read`,
   `<resource>.write`, roles explicit). Adding a key REQUIRES extending ALL THREE matrices in
   `test/auth/permissions.test.ts` — role × key, delegable-or-not, and service-grantable-or-not
   — that duplication is the review gate, embrace it. Decide delegability on purpose: a key a
   script or MCP client must never hold with a `t_*` token (admin surfaces, actor-level logs,
   anything that lets a token outlive or widen itself) goes in `NON_DELEGABLE` (PIA C8) — which
   also keeps it from every service identity. If an integration will call the route, it runs as
   a **service identity** holding exactly this one key (docs/runbooks/service-identities.md), so
   give an ingest route its own key rather than reusing a broad one. `permission:
   'authenticated'` is NOT a key: it skips the check, so **every** personal token reaches the
   route whatever its scopes (even `scopes: []`), and no service identity reaches it at all. Keep
   it for identity reads like `GET /api/me`; a route that mutates anything or returns app data
   takes a real key.
3. **Data first:** repository in `src/data/<resource>.ts` (typed rows, cursor
   pagination, boolean mutation results), registered in `src/data/index.ts`, and the
   table in `schema.sql` under APP TABLES if the app isn't deployed yet. **Once it's
   live, add the table as a `migrations/d1/NNNN_*.sql` file (`CREATE TABLE IF NOT
   EXISTS`) instead** — applied automatically on the next deploy; don't re-edit the
   frozen `schema.sql` baseline for post-launch changes (see migrations/d1/README.md).
   Never touch `env.DB` elsewhere — semgrep will catch you.
4. **Routes:** `defineRoute` per operation in `src/routes/<resource>.ts`:
   - `input:` Zod schema; validation lives HERE, not in handlers.
   - mutations declare `audit:` (or explicit `false` + justification in the PR). The
     framework writes that row once — name the resource with `ctx.setAuditTarget(id, payload?)`
     (a create that mints an id, or to attach a richer payload); `:param` update/delete need
     nothing. Never call `ctx.audit()` for the declared action — that double-stamps the log.
   - every `:param` route gets a `uniformityFixture` (synthetic data only).
   - add `rateLimit: { limit, windowSec }` for an abusable/expensive endpoint (per-user
     ceiling applied after the permission check; over the limit → 429 + `Retry-After`).
   - declare `needs: ['<repo>', …]` — the repositories the handler may reach. `ctx.db` then
     narrows to exactly those (`Pick<Db, needs>`) and THROWS on anything else, so a notes
     route cannot read users, tokens, or the audit log by accident or by drift. Optional
     today (omit it and `ctx.db` is the whole data layer, as before) — declare it anyway:
     it is the shape the golden example uses and the smallest blast radius you can buy for
     one line. It does not affect `audit:`/`ctx.audit()`, which the framework mediates.
   - reads an upstream HTTP source (Autobahn, a statistics API)? Do it inside
     `ctx.readUpstream(SPEC, (grant) => fetchIt(grant, …))`, the read ledger's per-call record
     (PIA C15): register the read with `defineUpstreamRead` (protected core) and pass the grant
     to the integration module, which refuses a call without one. See docs/DATA-ROUTES.md.
   - an integration's bulk write (`machine: true`, docs/API-CONVENTIONS.md → machine routes)?
     Build its audit payload with `batchAudit()` and return only its counts and, at most, keys
     the caller itself sent (`rejectedKeys`) — never a record it read, so not the 201-with-the-row
     a person's create returns. With `READ_AUDIT` armed, its D1 reads are attributed by that audit
     row instead of `read_log`, so a lookup the integration needs is its own **GET** route, which
     stays recorded.
   - missing OR forbidden resource → `throw notFound()` — never 403, never a custom 404.
   - register in `src/routes/index.ts` (unregistered = doesn't exist).
   - the SPA drift guard (`test/web/api-client.test.ts`) pins every registered route to the web
     client: **if the SPA will call this route**, add it to `web/src/endpoints.ts` + a `call()`
     wrapper in `web/src/api.ts` (see `/add-page`); **if not** (machine/programmatic/cron-only),
     add its `METHOD /path` to `NOT_CALLED_BY_SPA` in that test. Skipping both fails CI — by design.
5. **Tests** in `test/routes/<resource>.test.ts`: envelope shape, validation error,
   create/read/update/delete, pagination if listed, audit rows written. The uniformity
   tripwire picks up your fixture automatically — run it and watch it pass.
6. **Verify:** while developing, run the changed route's tests plus the permission matrix and
   uniformity tripwire for affected contracts. Before shipping, run `npm run ci` once on the
   final tree; `/ship` can use that result while every input remains unchanged. All PR gates
   still run. See `docs/TESTING.md` for runtime placement and verification evidence.
7. **Record:** if the endpoint embodies a decision (new permission semantics, unusual
   shape), append to `docs/DECISIONS.md`. Update the Linear issue.

## Self-check before finishing

- [ ] Could a viewer learn this resource EXISTS without permission? (must be no)
- [ ] Does any response body contain internals/stack traces? (must be no)
- [ ] Is every mutation audited with actor + target? (create/ingest routes need `setAuditTarget(id)`)
- [ ] Did the permission matrix test change consciously — including whether a token, and a service identity, may hold the key?
- [ ] If it is `permission: 'authenticated'`: is it an identity-only read? (every token reaches it)
- [ ] Does it read an upstream? Then only through `ctx.readUpstream`, grant passed on (PIA C15)
- [ ] Is it a `machine: true` write? Then it returns counts and the keys it was sent, never a record it read; its audit payload is `batchAudit()`'s; any lookup is a GET
