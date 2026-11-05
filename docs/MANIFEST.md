# The app manifest

Every paved-road app can describe itself. `GET /api/meta/manifest` (owner/admin only) returns
a machine-readable projection of the app's **own ontology** — the routes it exposes, the
permission each needs, the audit verb each writes, and the JSON Schema of each input — plus the
app identity and the kit version it is synced to.

Nothing new is declared to produce it: `src/framework/manifest.ts` walks the live route registry
(`src/routes/index.ts`), the permission matrix (`src/auth/permissions.ts`), and the app identity
(`src/env.ts`). Add a route or a permission and the manifest changes automatically — there is no
second list to maintain, and it can never silently drift from what the app actually enforces.

It exposes **structure, never data or secrets**.

## Why it exists

The manifest is the seam the fleet grows on:

- **Fleet registry** (App Registry) ingests each app's manifest to build a governance map —
  which apps hold which permissions, expose which AI actions, and how far each lags the kit
  (`kit_version`), across the estate, with zero data centralization.
- **MCP tool generation** derives agent tools from route specs, so every tool inherits the same
  permission check, audit row, and 404-uniformity as the HTTP surface (no parallel unpaved road).
- **Typed web-client codegen** generates the SPA's API client from the same specs, killing the
  hand-maintained client/server drift.

## Schema

| Field | Meaning |
|---|---|
| `manifest_version` | Shape version of the manifest format itself; bumps on any field added, renamed, or removed (see [Reading `manifest_version`](#reading-manifest_version)). |
| `kit_version` | The paved-road kit version the app is synced to (`src/framework/version.ts`, the stamp `/kit-upgrade` bumps). Distinct from `app.build_version`. |
| `checks_version` | The version of the shared CI-check directory this app is synced to (`CHECKS_VERSION` in `src/framework/version.ts`, kept in step by `npm run verify:checks`). Distinct from `kit_version`: a fork can be current on checks and behind on the kit. |
| `app` | `{ name, env, build_version }` from `src/env.ts` (`build_version` is the deploy SHA, or null). |
| `roles` | The role ladder (`owner, admin, member, viewer`). |
| `permissions` | The full per-key → roles matrix, verbatim. |
| `routes[]` | Per route: `method`, `path`, `permission`, `audit` (action string, `false` if opted out, or `null` for a read), `summary`, `rate_limited`, `machine` (see below), `needs` (see below), `agent` (see below), and `input_schema` — the JSON Schema of the **input** the caller sends (`io:'input'`, so a field with a default is optional, not `required`, and its default is shown). |
| `audit_actions[]` | Distinct declared audit verbs — the app's write vocabulary, sorted. |
| `agent_exposed` | How many routes the in-app agent can call (routes whose `agent` is not null). `0` in the kit. |
| `agent_client_egress` | How many of those reach client-class data (as `routes[].agent.client_class` defines it) or declare egress — exactly the exposed routes that must carry an `egressRuling` (PIA C3). `0` in the kit. |
| `generated_at` | ISO timestamp, stamped by the HTTP route (the builder itself is pure/deterministic). |

### `routes[].machine` — routes no person can reach

`machine` is `true` on a route declared `RouteSpec.machine: true` and `false` on every other route
(always present, never omitted). A machine route is reachable only by a **service identity** that
holds the route's `permission`; a person of any role, on a session or a personal token, gets the
uniform 404. Such routes are bulk endpoints an integration calls (an ETL's batch push); their audit
rows are counts-only and capped at 1 KB, and each request names its sync run in `X-Sync-Run` — see
[Machine routes](API-CONVENTIONS.md#machine-routes). Added in `manifest_version` 4.

### `routes[].needs` — which route may touch which table

`needs` publishes the repositories a route declared through `RouteSpec.needs` (the opt-in
least-privilege view behind `ctx.db`, see `src/framework/scopedDb.ts`), sorted. It answers, per
route and across the fleet, *what data can this endpoint reach* — enforced at runtime, not
documented by hand.

**`null` and `[]` are opposite facts. Never conflate them:**

| Value | The route declared | `ctx.db` is |
|---|---|---|
| `["notes"]` | `needs: ['notes']` | only the `notes` repository; every other one throws |
| `[]` | `needs: []` | scoped to **nothing** — no repository at all |
| `null` | **nothing** | the **whole** data layer — unscoped, the widest surface an app has |

An undeclared route is the widest kind of route, so it is published as `null`, never as an empty
list: a consumer that read the two the same way would rank the app's least-constrained endpoints
as its most-constrained. Reading it right is one line — `needs === null` means *unscoped*,
`needs.length === 0` means *reaches nothing*.

Fleet-wide, `needs === null` is the adoption backlog: `needs` is deliberately opt-in (making it
mandatory would break ~268 `defineRoute`s across the fork estate on the next `/kit-upgrade`), so
the manifest reports honestly on what has been narrowed and what has not.

`needs` also rides in the **governance slice** the daily registry cron pushes (below) — and which
route can touch which table is ontology. The slice keeps `manifest_version`, `kit_version`,
`checks_version`, `roles`, `permissions`, `audit_actions`, `agent_exposed`,
`agent_client_egress`, and per route `method`, `path`,
`permission`, `audit` and `needs`. It drops the top-level `app` block (the payload already carries
name/env/build_version as `source_key`/`name`/`status`) and, per route, `input_schema` — request
shapes, the bulk of the manifest — plus `summary`, `rate_limited`, `machine` and `agent` (see
[`routes[].agent`](#routesagent--what-the-in-app-agent-can-do-with-a-route); the slice carries the
two agent counts instead).

**The drop list is the mechanism, not a description of one.** `governanceManifest()` in
`src/cron/reportToRegistry.ts` declares its return type by *subtraction* — `GovernanceManifest` is
`Required<AppManifest>` minus the named top-level drops, and `GovRoute` is
`Required<ManifestRoute>` minus the named per-route drops. A field added to the manifest therefore
lands in the projection's type immediately and the projection stops compiling until someone either
sends it or writes it into a drop list. (A kept-field list would have protected nothing: a new
field simply would not be listed, which is how `checks_version` reported `NULL` fleet-wide from
#199 to #209. The `Required` is load-bearing too — `Omit` preserves optionality, so a field added
as `foo?:` would otherwise be dropped silently: the same bug in its next disguise.)

What the types do **not** catch is an extra key arriving through a spread, which TypeScript does
not excess-property-check. The runtime pins in `test/cron/reportToRegistry.test.ts` stand behind
that gap, at both the top level and per route.

Of the five per-route drops, two are settled — `input_schema` and `summary`. `rate_limited`,
`machine` and `agent` are not (`agent` is covered in its own section below):

- **`summary` is dropped for good.** It is prose written for a human reading this endpoint. It is
  not governance and adding it would grow the daily report by the route count for no query anyone
  asks of the fleet.
- **`rate_limited` is a known gap, not a judgement.** *"Which write routes are unthrottled?"* is a
  governance question, and because the registry has never received the field the fleet cannot
  answer it at all — a consumer that assumes "absent means false" is reading a field that was
  never sent. It is coming, as a coordinated kit+registry pair (the registry must agree to ingest
  it before the kit sends it), together with the `manifest_version` bump that change earns — the
  slice is in scope of that number, see below.
- **`machine` is deferred on the same terms.** *"Which routes can no person reach?"* is governance
  too, but the registry's ingest schema has no field for it — it would strip the key — so it waits
  for the same kind of kit+registry pair. Until then it is visible here, in
  `GET /api/meta/manifest`, and not fleet-wide.

### `routes[].agent` — what the in-app agent can do with a route

`agent` publishes the route's `agent:` block (`RouteSpec.agent`, `src/framework/agentExposure.ts`)
as structure — or **`null` when the route has none, which by default deny means the agent cannot
call it**. It is always present, so every route publishes the same key set.

| Field | Meaning |
|---|---|
| `effect` | `read`, `write`, `destructive` or `external` — checked against the method when the route loads. |
| `needs_approval` | `always` (`needsApproval: true`), `never` (absent or `false`), or `conditional` (a predicate over the input). A function is never published; its existence is. |
| `egress` | The hosts the route sends data to, sorted. `[]` when it declares none. |
| `egress_ruling` | The Linear decision (a DPO ruling with a necessity test) that covers the route's data leaving, or `null`. |
| `client_class` | Whether the route may reach client-class data: its `needs` names a repository `src/data/dataClass.ts` does not classify `internal` (unclassified means client), **or** the app binds a client-class private database — an Aurora read is invisible to `needs`, so there every exposed route is client-class (fail closed; docs/DATA-ROUTES.md). |

The tool `description` (prose for the model) and `render` (a UI component id) are not published:
neither is governance. The exact set of exposed routes is also pinned in
`test/isolation/agent-exposure.test.ts`, so a change to it is a reviewed diff before it is a
manifest change.

**The registry slice carries the two counts, not the per-route block.** `agent` is a per-route
field the registry's ingest schema does not have (its Zod objects strip unknown keys), so it is a
deferred drop exactly like `rate_limited`, and ships later as a coordinated kit+registry pair. The
fleet question that matters first — *which apps hand client data to a model, and how many routes
can a model call* — is answered by `agent_exposed` and `agent_client_egress`, sent from version 3
on. Until the registry adds them to its schema (optional forever, like `ai_spend_30d`) it strips
them and accepts the report; nothing about the report is rejected in the meantime. The handshake
is recorded in DECISIONS 2026-09-25.

### Reading `manifest_version`

`manifest_version` bumps when the manifest's SHAPE changes — a field added, renamed, or removed, at
the top level, inside `app`, or inside a route — **and equally when a published projection of it
changes what it sends**, the governance slice included. It says nothing about the app
(`kit_version`) or the deploy (`app.build_version`).

**The projections are in scope deliberately**, because that is where the number actually broke.
Two of the three shapes below differ *only* in what the daily report sent; a version that tracked
the builder alone would call all three identical and go on reproducing the ambiguity it exists to
end.

**So `2` is not a reliable discriminator, and a consumer must not treat it as one.** Three
distinct shapes have gone out as `manifest_version: 2`: before #199; after #199, which added
`checks_version` to the manifest and to this endpoint but never to the daily registry report, so
every app in the fleet published the column as `NULL` until #209 caught it; and after #209, which
sent it. Nothing distinguishes them by version alone — use `kit_version` for anything in that
window, and treat a missing field as *unknown* rather than as a value. Version `3` is the first
bump that means what it says:

| Version | Builder adds | Registry slice |
|---|---|---|
| `2` | `routes[].needs` (and, from #199, `checks_version`) | three variants — see above |
| `3` | `routes[].agent`; top-level `agent_exposed`, `agent_client_egress` | adds `agent_exposed`, `agent_client_egress`; drops `routes[].agent` |
| `4` | `routes[].machine` | unchanged from `3` — drops `routes[].machine` |

**How much of this is enforced, precisely.** Two tests record the key sets each version stands
for — the builder's in `test/framework/manifest.test.ts`, the registry slice's in
`test/cron/reportToRegistry.test.ts` — each keyed by `MANIFEST_VERSION` and each failing with a
message naming the fix. A third, in `test/routes/meta.test.ts`, covers `generated_at`, which this
endpoint adds and the builder deliberately does not. What no test can do is prove an author bumped
the version rather than widened a recorded entry: the records are append-only by convention, so
the wrong edit is a visible rewrite of shipped history in review, not an impossibility.

## Example (trimmed)

```json
{
  "manifest_version": 4,
  "kit_version": "0.1.0",
  "checks_version": "1.0.0",
  "app": { "name": "app-registry", "env": "production", "build_version": "4466fd0" },
  "roles": ["owner", "admin", "member", "viewer"],
  "permissions": { "notes.read": ["owner","admin","member","viewer"], "meta.read": ["owner","admin"] },
  "routes": [
    {
      "method": "POST", "path": "/api/notes", "permission": "notes.write",
      "audit": "note.create", "summary": "Create a note", "rate_limited": false,
      "machine": false, "needs": ["notes"],
      "agent": null,
      "input_schema": { "type": "object", "properties": { "title": { "type": "string", "maxLength": 200 } }, "required": ["title"] }
    }
  ],
  "audit_actions": ["note.create", "note.delete", "note.update"],
  "agent_exposed": 0,
  "agent_client_egress": 0,
  "generated_at": "2026-07-02T00:00:00.000Z"
}
```

## Access

Owner/admin via a **session** only. The `meta.read` permission gates it, and it is
**non-delegable** (PIA C8, DECISIONS 2026-09-23): a bearer token gets the same uniform 404 as any
other denied caller, whatever its owner's role. The fleet registry never needed a token for it —
it receives the manifest through the daily push below.

## Reporting to the fleet registry

The daily `report_to_registry` cron pushes this app's status + governance manifest to the App
Registry's `/api/apps/ingest`. **The registry URL is baked into the kit** (`app-registry.cialdnb.ai`,
in `src/cron/reportToRegistry.ts`), so it rides `/kit-upgrade` and there is **no `REGISTRY_URL` var
to set**. **Production AND staging** report (most kit apps live in staging for months, and a
prod-only catalogue can't see most of the fleet); the two stay distinct because `source_key` is
env-qualified — `my-app` vs `my-app-staging`. `test`/`development` never report off the baked-in
URL. Reporting is gated on one secret — turning an app on is:

1. **Mint one token** in the registry (app-registry.cialdnb.ai) as a member/admin/owner: the
   Tokens page → a `t_…` token (shown once). This is a **fleet-shared** credential — one token for
   every app: the registry keys on `source_key`, not the token, so per-app tokens buy no isolation
   today (they'd only help if you want independent per-app revocation).
2. **Give each app the token** as `REGISTRY_TOKEN`, either way. **Do this PER WORKER you want in
   the catalogue** — prod and staging are separate Workers, so arming one never arms the other:
   - **Secrets Store** (kit default): store the value ONCE in the account Secrets Store under the
     name `REGISTRY_TOKEN`, then uncomment the `REGISTRY_TOKEN` block in `wrangler.jsonc` →
     `secrets_store_secrets` **and/or `wrangler.staging.jsonc`** (the template already sets
     `secret_name` to the shared `REGISTRY_TOKEN` — leave it). Every app points at that one secret.
     *(This binding is the one step `/kit-upgrade` can't do for you — it never edits wrangler
     configs.)* Want independent per-app revocation instead? Mint a separate token and use a
     per-app `secret_name` (e.g. `<APP>_REGISTRY_TOKEN`).
   - **Plain secret** (zero wrangler edits): `wrangler secret put REGISTRY_TOKEN` for prod, and
     `wrangler secret put REGISTRY_TOKEN --config wrangler.staging.jsonc` for staging.
3. **Pre-link `app_sources`** in the registry for each `source_key` you are about to arm
   (`<app>` and/or `<app>-staging`) if you want the reports attached to an existing app record.
   An unlinked first report arrives as a NEW row — the known duplicate-row trap.
4. **Deploy.** Each armed Worker reports on its next daily run and appears in the registry's
   **Apps** + **Governance** views (staging as `<app>-staging`, named `<App> (staging)`).
   To confirm from the app side, `wrangler tail` shows the cron's
   `report_to_registry: reported to registry: health=ok` — note it is NOT in `/_health` or the
   heartbeat audit row, which are written before the report runs.

**Staging reports too — but it is a SEPARATE Worker, so it needs its own token binding.** Wiring
`REGISTRY_TOKEN` in `wrangler.jsonc` arms production only; uncomment the matching block in
`wrangler.staging.jsonc` (or `wrangler secret put REGISTRY_TOKEN --config wrangler.staging.jsonc`)
to arm the staging Worker. It reports as `<app>-staging` — `source_key` is env-qualified, so a
staging row can never clobber prod's.

`test` and `development` never report off the baked-in URL. To point one of those at a *separate*
registry, set `REGISTRY_URL` explicitly in that env's config.

Once the token is wired, every future `/kit-upgrade` keeps reporting working with no further action
— **except rotation**. Once the registry runs a kit with C8 token hardening (DECISIONS 2026-09-23),
its tokens expire (at most 90 days after minting; tokens that predate the upgrade at upgrade +
90 days). `REGISTRY_TOKEN` is such a token, and an expired one fails every app's report with a 401
(logged, never paged — the report is best-effort). Rotate it before it lapses:
[docs/runbooks/machine-token-rotation.md](runbooks/machine-token-rotation.md). With the
Secrets Store default that is one value to replace for the whole fleet. Mint the replacement with
only the scope the registry's ingest route needs.

### What the `status` object carries

`env`, `build_version`, `kit_version`, `health`, `backup_age_hours`, `heartbeat_age_hours`,
`maturity_mode`, **`ai_spend_30d`**, and **`read_audit`**.

`ai_spend_30d` is this app's total AI cost in USD over the trailing 30 days, `SUM(cost_usd)` over
the local `ai_usage` table. An app that has never called the AI reports `0` (never `null`), so
silence and zero spend read the same across the fleet.

`read_audit` (boolean) is whether this app has **armed read attribution** — `true` exactly when
`READ_AUDIT` is set to `on`, sourced from the same `readAuditArmed()` predicate the framework
branches on. It is **always present**, never omitted when false, so a receiver never has to
guess. Two things a consumer must get right:

- **Absent ≠ false.** A fork that has not yet taken this kit version omits the key entirely.
  During that adoption window the discriminator is `status.kit_version`, which the report has
  always carried: absent from a kit that predates the field means *unknown*, and treating it as
  `false` would read an already-armed fork as unarmed. Do not infer arming from any other field —
  in particular not from `activity_url`, which every app with a `DASHBOARD_HOST` publishes whether
  or not the ledger is armed.
- **`false` does not mean "records nothing".** The flag gates the ordinary-D1 stream. Private
  database reads through `src/data/aurora.ts` are recorded unconditionally, so an app with an
  internal-class Hyperdrive binding and `READ_AUDIT` unset reports `false` and still writes
  `read_log` rows. (`npm run verify:edge` refuses a *client*-class binding without arming, so the
  gap is confined to internal-class sources.)

It is a **single aggregate on purpose**. The fleet spends roughly $129/month across 17 apps, with
87% of that in one app — at that size per-user attribution machinery is not justified, but an
alarm for when it stops being true is. So there is no hashed actor id, no roll-up table, and no
per-user breakdown: `actor_email` never leaves the app. If the number outgrows what the owner
cares about, attribution gets designed then, against real volume rather than a guess.

### What the ledger blocks carry (Fleet Ledger)

Four **optional** blocks ride the same daily report as siblings of `status` and `manifest` —
never inside the manifest, which is pure and I/O-free by design. Each is built independently and
**omitted if its read fails**, so one broken aggregate can never take the whole report down (that
would present to an operator as the app going dark, not as a missing chart). A registry that has
never heard of a block ignores it; a kit that cannot compute one simply does not send it.

| Block | What it is |
|---|---|
| `activity[]` | One row per **UTC day × stream** for the trailing 7 days. Streams: `writes`, `auth`, `ai`, `reads_aurora`, and `reads_d1` once `read_log` carries a `kind` column. Each row is `{ day, stream, events, actors, top?, anomalies? }`. |
| `migrations` | `{ count, names_hash, schema_hash?, applied[] }` — read from **wrangler's own** `d1_migrations` table (`src/data/meta.ts`). |
| `activity_url` | Deep link to this app's own read-log page — `https://<DASHBOARD_HOST>/reads`. |
| `activity_upstream[]` | The `reads_upstream` stream (PIA C15): reads of an upstream HTTP source, `read_log.kind = 'upstream'`, in the same row shape as `activity[]` — one row per UTC day for the trailing 7 days, `top` naming `source.read` (`autobahn.report_datablocks`). Its own block because the registry's `activity[]` pins exactly five stream names and 40 rows: a sixth name there would 400 the whole report. Today's registry strips it as an unknown key; a registry that learns it ingests it. Sent only once `read_log` accepts upstream rows (migration 0005). |

**The privacy line is the same one `ai_spend_30d` draws, one table wider.** Actor emails and
record identifiers **never leave the app**. `actors` is a `COUNT(DISTINCT …)` computed inside the
app — the registry receives the integer, never the set. On the `writes` stream it leaves out
service identities (addresses in the reserved `.invalid` namespace), whose rows still count in
`events`: the registry reads writes-stream `actors` as "who, besides the ops loop, used this app"
(DECISIONS 2026-09-24, machine read attribution). `top` carries **predicates**: an audit
verb, a model name, a declared view name — the vocabulary this manifest already publishes — never
a value a user supplied or a record was keyed by. Every projection in `src/data/activity.ts` is an
aggregate, and the return type has no field that could hold an identity, SQL text, or a bind
value. That is pinned by payload-shape tests on both the repository and the cron.

**Quiet days report as `0`, not as a missing row** — for the same reason `ai_spend_30d` reports
`0` rather than `null`: a fleet console can only read "this app went quiet" if silence arrives as
a number. An absent row is indistinguishable from an app that never reported.

**Why two migration numbers.** `count`/`applied` is the list of migration *files* this database
has run; `schema_hash` is the shape it is *actually* in. A hash that moves while the migration
list stands still is DDL that ran with no migration behind it — a hand-run `ALTER`, a console
edit — and that gap is the drift signal. `d1_migrations` is genuinely **absent** on a freshly
provisioned app, which reports as `count: 0`; that is the true answer and it is safe, because the
registry only records a change for migration names it has never seen.

**`activity_url` answers what the registry deliberately cannot.** The registry stores volumes and
timelines; *"who read record X"* is answered inside the app that owns the data, one click away.
The path must match the read-ledger view in `web/src/views.ts` — `web/` cannot import from `src/`,
so `READ_LOG_VIEW_PATH` in `src/cron/reportToRegistry.ts` and that view's path are kept in step by
test (`test/web/views.test.ts`), not by the type system.

## Deploys the registry pulls

Beyond the build this report carries, the registry will also **pull** every staging and
production deploy that runs through the kit's two deploy jobs, straight from GitHub, once its
deploy ledger ships (planned in `docs/DEPLOY-LEDGER-PLAN.md`, which the kit's PR #277 adds). With
a token the registry holds, it will read each catalogued repository's Actions runs of
`deploy-staging` in `.github/workflows/ci.yml` (a push to `main`) and `deploy` in
`.github/workflows/deploy-prod.yml` (`workflow_dispatch` on `main`; its first step, a guard,
refuses any other ref before it migrates, and the registry lists production runs on `main` only,
so a dispatch from another branch that shipped would never reach the ledger). Nothing in the app
is armed for it. A deploy that bypasses those jobs (`npm run deploy` or `npm run deploy:staging` from
a laptop, or a `wrangler rollback`) leaves no Actions run, so the ledger cannot list it.

The registry will match the jobs on the display name the Actions jobs API reports, which is the job
id only while nothing at job level renames it (a `name:`, a matrix, a reusable-workflow call), and
no other job of the workflow may be reported by that name, or it would read that job as a deploy
too. It will find them only in their own workflow's runs, so neither workflow may be callable: a
caller runs an `on: workflow_call` workflow's jobs inside its own run. It will read each deploy
job's outcome from its steps (whether it shipped, or was refused before it could), matching three
steps by name: the ship step, named exactly `Deploy to staging` or `Deploy to production`, and the
two migrations steps, whose names start with `Check + apply D1 migrations` and
`Apply Supabase migrations`. Those are the steps it reads as able to touch the environment. The
ship step must be the only step of its job by that name, since the registry reads the first it
finds; a job may carry more than one migrations step under the same prefix (a second D1 database,
say), and the registry reads each of them. So the file names, the job ids, those three
step names and those absences are already a contract, pinned by
`test/platform/deploy-ledger-contract.test.mjs` along with when each job deploys: a rename is a
registry change, not a refactor (DECISIONS 2026-10-12, "Deploy visibility is PULLED by the fleet
registry from GitHub Actions", which the kit's PR #277 also adds).
