# Reaching the Aurora databases

Context for anyone — human or Claude Code session — working on data access against a
private Aurora cluster reached over the Cloudflare Tunnel, or calling a private HTTP service
through a Workers VPC binding ("Private HTTP services" below). The binding names below are the
first app's; a fork substitutes its own, keeping the `HYPERDRIVE_` prefix, which the semgrep
fence and `binding-allowlist.jsonc` both key on.

## The route, as built

Six hops, and the shape of them decides what is and is not configurable further down this page:

```
  Worker
    └─ HYPERDRIVE_* binding            ← all your wrangler config carries: a name and an id
        └─ Hyperdrive configuration    ← the pool, and the only place credentials live
            └─ the PUBLISHED HOSTNAME of a Cloudflare Tunnel route   (a HOST origin, over TLS)
                └─ Cloudflare Access   ← authenticated by a SERVICE TOKEN held in the config
                    └─ cloudflared, running inside the AWS VPC
                        └─ Aurora PostgreSQL — private subnets, no public address
```

**This is Hyperdrive over a Tunnel-published hostname. It is not the Workers VPC Service
shape.** The distinction is not trivia: a VPC Service origin is `{ binding, service_id }` — a
private-network handle with no hostname, and therefore no origin-TLS settings of its own. What we
have instead is a **host origin**: Hyperdrive dials a real, publicly-resolvable hostname that
Cloudflare Access gates and `cloudflared` terminates inside the VPC. Everything in "TLS to the
origin" below exists *because* of that choice.

The Access **service token** is what makes a publicly-resolvable hostname safe to publish: the
hostname resolves for everyone, and Access refuses everyone who cannot present the token. The
token lives in the Hyperdrive configuration alongside the database credentials, which means it is
never in this repo, never in a wrangler config, and not something a Worker can read.

`VPC_*` bindings are still gated by `binding-allowlist.jsonc` and still resolvable by
`openAuroraClient` — because the allowlist gates *capabilities*, not just the one in use, and
`vpc_networks` in particular is the broadest of the three (see DECISIONS 2026-08-19,
"Private-database bindings"). Gating only the route we happen to take would have left the control
covering the careful path and missing the reckless one.

### What your config carries

A binding name and an id. Never a host, a user, a password, or the Access token — those live in
the Hyperdrive configuration, which is managed in the `Cial-Pulumi-VPC` stack and never returns
them. The id comes from a stack output.

| Binding | Environment | Cluster |
|---|---|---|
| `HYPERDRIVE_RET1_RO` | staging (`wrangler.staging.jsonc`) | internal-tools, staging |
| `HYPERDRIVE_RET1_RO` | production (`wrangler.jsonc`) | internal-tools, production |

(Illustrative — the kit itself binds nothing. Names are per app.) Same binding name in both
environments, different id, like the D1 and KV bindings already do, so application code never
branches on environment.

**Staging-only is a real state.** An app whose production allowlist is deliberately empty fails
CI the moment a binding appears in its `wrangler.jsonc`. That emptiness is what keeps it off
production data, and it is enforced rather than intended. Graduating is one approved allowlist
line, reviewed.

### TLS to the origin, and why `verify-ca` is the ceiling

Because the origin is a host, the Hyperdrive configuration can carry `mtls.ca_certificate_id` —
the Amazon RDS CA, uploaded to the account's certificate store — and set **`sslmode=verify-ca`**.
The chain is verified against that CA on every connection. On a VPC Service origin there would be
no host and no such setting to make.

**`verify-full` is unreachable by construction, and is not a TODO.** `verify-full` adds hostname
verification: the certificate presented must name the host that was dialled. Hyperdrive dials the
**published tunnel hostname**, and Aurora's certificate names the **RDS endpoint** — two different
names, by design, because the whole point of the tunnel is that the RDS endpoint has no public
name to dial. So hostname verification cannot pass, and no amount of certificate work will make it:
the only ways to reach it are to give Aurora a certificate for a hostname it does not serve, or to
give up the tunnel.

Read `verify-ca` here as **the ceiling of this architecture, not a compromise somebody should
tighten later**. What `verify-full` would have bought — "am I talking to the host I meant?" — is
supplied by a different control on this route: Access refuses any connection that cannot present
the service token, and `cloudflared` is the only thing on the far side of it. If you find yourself
raising `sslmode`, you are not hardening the route; you are breaking it, and the failure will look
like an intermittent connector fault.

## The rules

**1. Database access lives in `src/data/`. Always.**
`env.HYPERDRIVE_*` referenced anywhere else — a route, a service, a helper — fails
semgrep in CI. This is the same fence that already applies to `env.DB`. Routes call a
repository function; they never see a client.

**2. It is read-only, and it reads views, not tables.**
The database role holds `SELECT` on a schema of views and nothing else. There is no
write path, and adding one is a separate design conversation, not a grant.

**3. You do not add the binding yourself.**
The binding and its allowlist entry land together in one PR, gated by CODEOWNERS. Ask
for the id; it comes from a Pulumi stack output. Production deploys run only through
GitHub Actions and no repo user holds a Cloudflare token, so an unapproved binding
cannot reach production even if it merges locally.

**4. A new query is usually not a code change.**
Query logic lives in the views. Need a different shape — a join, an aggregate, another
column? That is an `ALTER VIEW` request to the database owners, and your repository
code is untouched. Reach for a code change only when the *shape of the result* changes.

**5. Never widen a grant to make something work.**
If a query fails on permissions, the answer is a view that exposes what you need, not a
broader grant. In particular: Hyperdrive's connection test at configuration time passes
with only `LOGIN` and `CONNECT`, so a green connection proves nothing about your grants.

## Writing a query

Every read goes through **`auroraQuery()`** in `src/data/aurora.ts`. It is the only sanctioned
path to a Hyperdrive binding, and it writes the `read_log` ledger on the way past. The signature
is **frozen** (2026-08-19) — the consuming track builds against it, so changing it is a
reconciliation, not a refactor.

```ts
// src/data/<yourRepo>.ts — the repository owns the spec; the seam owns the client and the ledger
const LIST_USAGE = defineAuroraQuery<UsageRow>({
  name: 'listNamespaceUsage',        // registered id; appears in the ledger
  source: 'ret1_ro',                 // union of AURORA_SOURCES' keys — a typo is a compile error
  view: 'app_ro.v_namespace_usage',  // REQUIRED, schema-qualified, checked at module load
  sql: 'select namespace, seats, updated_at from app_ro.v_namespace_usage where client_code = $1',
  params: [],
  target: 'client_code',             // DECLARED projection — the NAME, never the value
});

export async function listNamespaceUsage(ctx: AuroraCtx, clientCode: string) {
  const rows = await auroraQuery<UsageRow>(ctx, { ...LIST_USAGE, params: [clientCode] });
  return rows.map(toUsage);
}
```

**Spread only to bind `params`.** A registered spec carries a sealed snapshot of everything that
identifies the read, and `auroraQuery` re-checks it: spreading one and changing `source`, `view`,
`sql`, `target`, or `name` is refused at the call. Without that, `{ ...INTERNAL_SPEC, source:
'c360_ro' }` would read a client database on the internal fire-and-forget posture and record it
under the wrong class — the class is a property of the database, not of the object you hand in.
Need a different shape? Register another query.

Parameterised, always. Schema-qualified, always (`app_ro.`) — an unqualified name resolves
against `search_path`, so the view the ledger records could differ from the one read.

## Getting a client

`auroraQuery()` takes the client; it does not make one. **`openAuroraClient()`** does, and it is
the only place in the repo allowed to — `.connect()` is banned everywhere else in `src/`, and the
semgrep exemption names this one function.

The kit ships **no Postgres driver** and will not: it binds no private database, and a driver is a
dependency with a release-age gate and a bundle cost. The fork that binds one adds `pg` itself
(`nodejs_compat` is already set in every kit wrangler config) and passes a **factory**:

```ts
// src/data/<yourRepo>.ts
import { Client } from 'pg';
import { type AuroraCtx, auroraQuery, openAuroraClient } from './aurora';

export async function listNamespaceUsage(base: Omit<AuroraCtx, 'client'>, clientCode: string) {
  const client = await openAuroraClient(base.env, 'ret1_ro', (cs) => new Client({
    connectionString: cs,
  }));
  try {
    const rows = await auroraQuery<UsageRow>(
      { ...base, client },
      { ...LIST_USAGE, params: [clientCode] },
    );
    return rows.map(toUsage);
  } finally {
    if (base.waitUntil) base.waitUntil(client.end());
    else await client.end();
  }
}
```

**The factory constructs and nothing more.** It must not connect and must not query — that is what
keeps your line legal, and it is why the parameter is a factory rather than a live client. Hand in
something already connected and the `.connect()` call moves back into your file, where the rule
refuses it, and you are back to having no legal site at all.

**`pg`'s shape, or an adapter you cannot write.** The driver must carry node-postgres'
`query(text, values)`. A template-tag driver like `postgres.js` does not, and wrapping one is not a
workaround: the adapter would have to call `.unsafe()`, which stays banned outside the seam.
Deliberate — `query(text, values)` is what keeps SQL and bind values apart all the way to the wire.

**Open once per request, not per query**, and close what you opened: the seam never calls `end()`,
because only the caller knows when the request is done with the connection. `waitUntil` on the
request path, `finally` in a cron.

**What it refuses** — every one an opaque 500, with the detail in the log:

| | Why |
|---|---|
| a source absent from `AURORA_SOURCES` | it has no reviewed class, so nothing knows whether to fail closed on it — this is the check that stops the resolver becoming a way to read a database the allowlist never granted |
| no `HYPERDRIVE_*` / `VPC_*` binding for the source | normal mid-rollout: staging binds it, production does not |
| **both** prefixes bound for one source | two bindings are two databases; the ledger records only the source name, so the read could not be attributed to either |
| a binding with no `connectionString` | not a private-database binding at all |
| a factory that returns a non-connection | caught before connecting, rather than several frames deep in the seam |

The connection string is a **live credential** — it embeds the password. It goes to the driver and
nowhere else: never logged, never returned, never in an error. Every refusal above names the
*binding*, which is something a reviewer can act on.

## The read ledger — what gets recorded, and what cannot be

Every `auroraQuery()` writes a `read_log` row (app-local D1, next to `audit_log`):
who, which app/env/route, which source and view, the declared target, the row count, and a
`request_id` that groups every read made while serving one request.

**Pass `ctx.requestId` as `AuroraCtx.requestId`.** The seam records whatever id the caller hands
it; the framework mints one per call and gives it to the handler as `ctx.requestId` — the same id
its own D1 recorder and `ctx.readUpstream` write, and, for a call from the in-app agent, the TURN
id. Build the context from it and the call's Aurora rows correlate with its D1 and upstream rows
and with the agent turn:

```ts
handler: async (ctx, input) =>
  listNamespaceUsage(
    {
      env: ctx.env,
      principal: ctx.principal.email,
      route: 'GET /api/namespace-usage',
      requestId: ctx.requestId, // never a uuid of your own
      waitUntil: ctx.waitUntil,
    },
    input.clientCode,
  ),
```

### Three streams, told apart by `kind`

`read_log` carries every half of read attribution, and `kind` is what separates them:

| | `kind = 'aurora'` | `kind = 'd1'` | `kind = 'upstream'` |
|---|---|---|---|
| Written by | `auroraQuery()` (this page's seam) | the framework's `recordDb` proxy, `src/framework/readAudit.ts` | `ctx.readUpstream()` → `upstreamRead()`, `src/data/upstream.ts` |
| What it records | a private-database read | an ordinary read of the app's **own** D1 through `ctx.db` | a read of an upstream **HTTP** source (Autobahn, a statistics API) |
| `source` | the registered source name (`ret1_ro`) | the repository name (`notes`) | the registered upstream name (`autobahn`) |
| `query_name` | the registered query id | the repository **method** (`list`) | the registered read id (`report_datablocks`) |
| `view` | the declared schema-qualified view | `NULL` — an ordinary D1 read declares none | always `NULL` — never a URL |
| `target` | the declared projection name, optional | `NULL` | the declared projection **name** (`ticket_key`), **required** |
| `source_class` | whatever the reviewed grant assigned | always `internal` | whatever `UPSTREAM_SOURCES` assigns |
| Failure posture | per the table below (client = fail-closed) | fail-open, throttled alert | per the table below (client = fail-closed) |
| Needs `READ_AUDIT` armed | no — always records | **yes** | no — always records |

`kind` and `source_class` are **different axes** and neither derives from the other: `kind` is
*where the data lives*, `source_class` is *how sensitive it is*. K1's daily digest splits
`reads_d1`, `reads_aurora` and `reads_upstream` on `kind`, and R2's rule engine alerts on each
separately — so a row recorded under the wrong `kind` is not cosmetic. The registry stores digests,
not rows, and the streams can never be separated again afterwards.

### The d1 stream — reads you did not have to remember to record

When `READ_AUDIT` is armed, `executeRoute` wraps the handler's `ctx.db` in a recording proxy
before calling the handler. Nothing is declared per route and nothing can be forgotten; HTTP and
MCP both inherit it because both are thin adapters over that one function.

- **Unknown methods count as READS.** Classification is by names that are definitely writes: the
  kit's own `WRITE_METHOD_NAMES`, plus whatever each repository declares about itself; a fork's
  new `findByTaxId()` is attributed the day it is written. The cost of the mistake in this
  direction is a spare row; in the other it is a read nobody ever sees.
- **Your repositories declare their own writes.** The kit list names the kit's methods only, so a
  fork's `upsertBatch` is a read until its repository says otherwise. Declare it on the repository
  object, next to the methods (`src/data/declaredWrites.ts`):

  ```ts
  return {
    [DECLARED_WRITES]: ['upsertBatch', 'recordMigrations'],
    async upsertBatch(rows) { /* … */ },
    async recordMigrations(ids) { /* … */ },
    async bySubscriberNumber(n) { /* … */ },   // a read: recorded
  };
  ```

  A declared method is never recorded again, for any caller, so declare only methods that write
  and hand no stored rows back: a `bulkExport` that returns client rows is a read, whatever its
  name. The declaration covers that repository only and travels with the object. The tripwire
  `test/isolation/declared-writes.test.ts` walks every `makeDb()` repository and fails, naming
  each one, on an undeclared method called `upsert…`, `insert…`, `delete…`, `replace…` or `bulk…`,
  and on a declared name that is not a method. Writes named with another verb (`recordMigrations`,
  `setStatus`) are not caught by name, so declare those as you write them.
- **Identical reads in one request are one row.** Reads sharing a `(repository, method)` within a
  request aggregate into a single row with `row_count` summed, so a handler that calls
  `notes.list` three times writes one `notes.list` row. A read that rejected (`row_count` NULL,
  *attempted*) is never summed into a count: it keeps its own row. The per-request cap
  (`MAX_READ_EVENTS_PER_REQUEST`, 200) counts distinct shapes, not calls. What aggregation costs:
  the number of calls. A read that finds nothing adds 0, so 500 `users.getByEmail` probes that find
  3 users leave one row with `row_count` 3, and the ledger no longer shows the probing (DECISIONS
  2026-09-23 leaves that to the D6/D13 approvers). The `read ledger FAILED (d1 flush)` alert still
  counts reads, not rows: `reads missing` is every read the request made before its flush.
- **It wraps *outside* `scopeDb`.** A repository a route did not declare in `needs` throws below
  the proxy, so a refusal is never recorded as an access. A lie in the trail is worse than a gap.
- **It is attribution, not prevention.** What keeps a handler off `env.DB` is the semgrep data
  fence, not this.
- **Row counts are a heuristic** over the kit's real page shapes (array → length, `{items}` →
  `items.length`, `null` → 0, anything else → 1). An unfamiliar shape reports 1, never 0 —
  under-reporting is the failure worth avoiding on an attribution surface.
- **Arguments are never recorded**, and there is nowhere to put them. Decision D6 holds by shape
  on this stream exactly as it does on the aurora one.
- **Fail-open.** One batched INSERT per request via `waitUntil`, after the handler returns. A
  failure alerts through the same throttled ops seam and never fails the request — D1 is the app's
  own database, so Decision D3's write-ahead fence does not apply and must not be imitated.
- **A streamed response is flushed when its BODY ends, not when the handler returns.** The stream is
  request-scoped, and a request is not over until its response is: a handler that returns a
  `Response` with a streaming body (an SSE route that polls D1 per tick) goes on reading after it
  returns. `executeRoute` therefore defers that request's flush to the body's close, cancel (a
  client disconnect) or error, with a 120-second hard timer as a backstop for a stuck stream
  (`src/framework/readAuditStream.ts`). A plain-value handler — the usual case — and any HEAD
  request (the runtime runs the GET route and discards its body unread) flush at once, as before.
  Whoever consumes a route's `Response` must read or cancel its body — the HTTP runtime and the MCP
  adapter do, and so must any new in-process caller of `executeRoute` (an agent tool invoke) — or
  its rows wait on that timer, which nothing keeps alive once the request's context has ended. A body the wrapper cannot take (a locked stream) is served untouched and flushed at
  once (`read_audit_stream_wrap_failed`): a bug there never breaks the response. A stream that runs
  past the timer has its later reads dropped and counted (`read_audit_events_dropped`).
- **One exemption: a machine's audited write.** When a **service identity** writes through a
  **`machine: true`** route with a **mutating** method and a **declared audit action**, and that
  request's declared audit row **lands** carrying the route's own payload, whole (not the oversize
  stub), and the caller's `X-Sync-Run` id, its reads are not written: the audit row (actor, action,
  target, run id and — built with `batchAudit()` — counts and key fingerprint) is its attribution
  (`isExemptMachineWrite` and `machineRowAttributes`, `src/framework/machine.ts`; DECISIONS
  2026-09-24). Everything else records as above — a person, always; a service's GET, on a machine
  route or not; a service on an ordinary route; a route with `audit: false`; any request whose
  audit row did not land (a throw, an error Response, a failed insert); and any whose row landed
  with nothing to match a batch by (no payload of the route's own — counted on the row as stored,
  so a key whose value is `undefined` does not count — the oversize stub, `runId: null` under
  `MACHINE_SYNC_RUN=warn` or over MCP) — each flushed by the rule above, at its body's end when it
  returned a `Response`. It is this
  stream's exemption only: the request's Aurora and upstream reads are recorded by their own seams
  as always. There is no flag to set: the exemption follows from `machine: true` and the caller's
  identity, and omitting either over-records. **A machine route returns counts and the keys it was
  sent, never records it read; a lookup the integration needs is a GET, which stays recorded.** The
  exemption reads the declared method, not what the handler returns, so this rule is the only thing
  keeping a bulk lookup off the unrecorded path (docs/API-CONVENTIONS.md → machine routes).

### The upstream stream — reads of an HTTP source (PIA C15)

A route that fetches records from an upstream over HTTP — Insights' `GET
/api/reports/:ticketKey/data` reading Autobahn is the case that prompted it — used to leave **no
per-call record**: a GET declares no audit action, and neither seam above sees an HTTP call. Now it
records through the same ledger, with the aurora seam's posture:

```ts
// src/data/upstream.ts (protected core): the source's class, once, under code-owner review…
export const UPSTREAM_SOURCES = Object.freeze({ autobahn: 'client' })
  satisfies Readonly<Record<string, ReadSourceClass>>;

// …and each read, registered at module load (protected core too):
export const AUTOBAHN_REPORT = defineUpstreamRead({
  source: 'autobahn',
  name: 'report_datablocks',
  target: 'ticket_key', // the NAME of what the read is keyed by — never the value
});

// The integration module takes the GRANT and checks it before it fetches…
export async function fetchLiveReport(grant: UpstreamGrant, cfg: Cfg, order: Order) {
  requireUpstreamGrant(grant, 'autobahn'); // no live grant for autobahn → opaque 500, no fetch
  // …
}

// …and the route: the fetch goes INSIDE the thunk, with the grant the thunk is handed.
handler: async (ctx, input) => {
  const order = await ctx.db.subscriberOrders.findByTicketKey(companyId, input.ticketKey);
  if (!order) throw notFound();
  return ctx.readUpstream(AUTOBAHN_REPORT, (grant) => fetchLiveReport(grant, cfg, order), {
    count: (r) => (r.status === 'ok' ? 1 : 0), // optional; default is the shape heuristic
  });
},
```

- **Client-class source → write-ahead, fail-closed.** The intent row is written and awaited
  before the thunk runs. If it cannot be written, the thunk never runs and the request is the
  kit's opaque 500. A fetch that throws leaves `row_count` NULL (*attempted*) and its error
  reaches the handler unchanged.
- **Internal-class source → fire-and-forget.** The fetch runs first; one complete row is written
  after. A fetch that throws is still recorded, as attempted. A ledger failure alerts and never
  fails the read.
- **The framework fills in who, which route and which request.** The row's `principal` is the
  caller and its `route` the route pattern. `executeRoute` decides ONE ledger `request_id` per call,
  in one place, and every row the call writes carries it: its upstream rows, and its d1 rows when
  `READ_AUDIT` is armed. A correlation id a caller supplies (an agent turn) is set there once and
  reaches both streams.
- **Recorded whether or not `READ_AUDIT` is armed**, like the aurora seam: calling it is the opt-in.
- **`target` is a NAME, never a value** (Decision D6; DECISIONS 2026-09-25). `source`, the read id
  and `target` must each be an identifier (`^[a-z][a-z0-9_]{0,63}$`). `defineUpstreamRead` refuses
  anything else at import, and `read_log`'s CHECK refuses it for an upstream row even from a caller
  that bypasses the seam — so a DUNS, a CPF, a ticket key, an email or a URL cannot land in the
  ledger. When a DPO needs *"who read THIS ticket"*, declare an audit action and call
  `ctx.audit(action, ticketKey)`: `audit_log.target` holds values and is in the DSR discovery. The
  read ledger answers *"who read Autobahn reports by ticket key, through which route, when, and how
  many"*.
- **The class comes from `UPSTREAM_SOURCES`, and only from there.** `defineUpstreamRead` takes no
  other table, so no read — and no route — can register a client source as internal. (Tests
  register through `__defineUpstreamReadForTest`, whose synthetic table can add a source but can
  never reclassify one the reviewed table lists.)
- **A forged or edited spec is refused.** Only the frozen object `defineUpstreamRead` returned is
  accepted, so a spread copy with a swapped `source` cannot run a client upstream on the
  fire-and-forget path.
- **Schema drift fails closed and says so.** On a database that has not applied
  `migrations/d1/0005_read_log_upstream.sql` (forks: its renumbered copy), `read_log` refuses the
  row: client-class reads are refused, `upstream_read_schema_drift` is logged with the remedy, and
  the alert names the migration. Drift is asked of the database (its `read_log` definition), not
  guessed from the error: any other ledger failure is refused the same way but names no migration.

**Coverage is opt-in, and the grant is what fences it.** The seam records what goes through it. A
handler that calls an integration module directly, around `ctx.readUpstream`, writes no row, and
nothing in the kit's CI notices: unlike `env.DB` or a Hyperdrive binding (both fenced by semgrep),
an integration call has no binding to fence. What closes it is the **grant**. `ctx.readUpstream`
hands its thunk an `UpstreamGrant` only the seam can mint (live only while the thunk runs, and for
a client-class source only once its intent row is in), and an integration module for a registered
source takes it as a parameter and calls `requireUpstreamGrant(grant, '<source>')` before it
fetches. A call around the seam then has no grant to pass: a type error, and at run time the opaque
500 with `upstream_grant_refused` logged. The kit ships no upstream integration, so this holds
exactly as far as each fork's integration modules require the grant — `/security-review` checks
that, and an integration module for a registered source that fetches without requiring one is a
bypass. It is attribution, not an egress control.

`GET /api/read-log` (admin-and-up) pages the ledger, and the SPA's `/reads` page is what K1
publishes to the registry as this app's `activity_url`.

**No SQL text. No bind values. Ever.** There is no column that could hold either, and
`ReadLogIntent` has no field for them — so it is not a rule to remember, it is a shape. What
answers *"which records"* is the spec's `target`: a **declared projection**, written as the
identifier's name (`'client_code'`), never the value it took. Omit it and the ledger records the
view and the count, which is the safe default. On these databases a bound parameter can itself be
client PII, so the polarity is deliberately flipped: nothing is recorded unless a reviewer named it.

**`row_count` NULL means ATTEMPTED, not zero.** A `0` is a real empty result. A `NULL` is a read
that was authorized and started, whose outcome is unknown — the honest state after a crash between
the write-ahead row and the count patch. `readLog.listAttempted()` surfaces them.

Retention is **60 days** (`READ_LOG_RETENTION_DAYS`), pruned by the daily cron. Unlike `audit_log`,
this table *is* pruned: it is high-volume access metadata about client data, and keeping it past
usefulness enlarges the very target it protects. Note the honest caveat — `read_log` **is** included
in the daily R2 backup, so a deletion promise is really 60 days + `BACKUP_RETENTION_DAYS`. That is
a deliberate trade (a restore that loses attribution loses the control) and a compliance note, not
a bug.

The prune deletes in chunks of 5,000 rows, oldest first, with at most 40 passes (200,000 rows) a
night, so it cannot time out on a backlog. If you shorten `READ_LOG_RETENTION_DAYS` on a busy app,
the backlog drains over a few nights, and until it has, the heartbeat's `prune_read_log` detail says
"pass cap reached" and how many days past its deletion date the oldest waiting row is. Once that is
more than 3 days, the task fails and pages the owner: either the backlog is too large for a few
nights (shorten in smaller steps) or more rows arrive each day than the cap deletes, so the
deletion promise would lapse for ever without it.

## Failure posture — the part to read before you build on this

Each source carries a **class**, set in `binding-allowlist.jsonc` where the grant is reviewed, and
mirrored in `AURORA_SOURCES`. It is a property of the *database*, never of a query — no individual
query can opt a client cluster into the cheaper path.

| | `client` | `internal` |
|---|---|---|
| Ledger write | **Write-ahead** — inserted and **awaited before** the query is sent | Fire-and-forget flush, after the query |
| Ledger unwritable | **The read THROWS** (opaque 500). The query client is never called. | The read succeeds; the failure alerts |
| Row count | Patched after, via `waitUntil` | Written with the row |
| CI requirement | The config must also set `"vars": { "READ_AUDIT": "on" }` | none |

(The `d1` stream has no class axis — it is always `internal`, and always fail-open. The `upstream`
stream takes its class from `UPSTREAM_SOURCES` in `src/data/upstream.ts` and follows the same two
columns, with "the thunk is never called" for "the query client is never called"; it has no
binding, so the CI requirement row does not apply to it. See the streams table above.)

**A client-class read that cannot be recorded does not happen.** Read attribution is the
compensating control for client data living on a shared Cloudflare account, so it must not
evaporate exactly when the ledger is down — which is precisely when someone would want it gone.
Build for it: an Aurora route over a client source can return a 500 for a reason that has nothing
to do with the database.

Both failure paths raise a throttled ops alert (one per source per 15 minutes) carrying the query
name, view, and error *class* — never the error message, which can embed SQL and bound values.

## Why you cannot skip the seam

Four controls, none sufficient alone:

1. `env.HYPERDRIVE_*` outside `src/data/` — semgrep (`hyperdrive-access-outside-data-layer`, #204).
2. `env.HYPERDRIVE_*` inside `src/data/` but outside `aurora.ts` — semgrep
   (`hyperdrive-binding-outside-aurora-seam`). The binding lives in exactly one file.
3. A raw `.query()` / `.connect()` / `.unsafe()` anywhere in `src/` outside the seam — semgrep
   (`aurora-raw-query-outside-seam`). **Two functions are exempt, each for exactly one call:**
   `runQuery` may query, `openAuroraClient` may connect. Neither borrows the other's licence, and
   the exemption is scoped to the FUNCTION, never the file — a new function in `aurora.ts`
   inherits nothing.
4. A client-class grant without `READ_AUDIT` armed, or a class that disagrees with `AURORA_SOURCES`
   — `npm run verify:edge`. The gate reads **every** wrangler config in the repo root, not a fixed
   pair — a binding in `wrangler.mcp.jsonc` is exactly as live as one in `wrangler.jsonc` — and it
   refuses gated bindings nested under `env.*` blocks outright: bindings live at the top level of
   one config file per environment, where the allowlist grants them and a code owner reviews them.
   `unsafe` is refused the same way — wrangler uploads `unsafe.bindings[].type` verbatim, so a
   `{ "type": "hyperdrive" }` entry there would mint an unreviewed binding. The same gate reads
   `AURORA_SOURCES` statically and fails closed on a table it cannot parse, on an entry that is
   not a lowercase source name carrying a reviewed class, and — only while the repo is still the
   unforked kit — on the table being non-empty at all.

Enforcement sits **below** the route, so a GET route cannot reach Aurora unrecorded. That is
stronger than a per-route declaration, which can be forgotten.

## Adding a source — the exact checklist

**Per source: three files, one pull request**, code-owner reviewed together. There is no fourth
edit for a source, and in particular there is **no kit test file** on this list:

| # | File | The edit |
|---|---|---|
| 1 | the deploying wrangler config — `wrangler.staging.jsonc`, `wrangler.jsonc`, or both | the binding: `"hyperdrive": [{ "binding": "HYPERDRIVE_RET1_RO", "id": "<Pulumi stack output>" }]`. Binding both environments makes this row two files, one line each — same binding **name**, different **id**. |
| 2 | `binding-allowlist.jsonc` | the grant, under the same config key: `{ "id": "<the same id>", "class": "client" \| "internal" }` |
| 3 | `src/data/aurora.ts` | one line in `AURORA_SOURCES`: `ret1_ro: 'internal',` — the binding name minus its `HYPERDRIVE_`/`VPC_` prefix, **lowercased**, carrying the **same** class as the grant |

Plus, **in the file you already edited at step 1**, `"vars": { "READ_AUDIT": "on" }` if the class
is `client`. Not a fourth file: CI refuses a client-class binding in a config that has not armed
the ledger, so the permission and the compensating control land together or neither does.

**Once per app, not per source — two more files, the first time only:** `package.json` and
`package-lock.json`, for the **driver**. The kit ships no Postgres driver and will not: it binds no
database, and a driver is a dependency with a release-age gate and a bundle cost. Add `pg` yourself
(`nodejs_compat` is already set in every kit wrangler config); it goes through `npm run verify:deps`
like anything else, so add it the day before you need it rather than the hour.

The kit ships every list empty, so nothing is red today, and nothing above is red until you
deliberately make it so.

### If a kit test goes red when you register a source, that is a bug — report it

It used to. Three assertions pinned `AURORA_SOURCES` empty from inside the suite — two in
`test/data/aurora.test.ts`, one in `test/platform/edge-hardening.test.mjs` — and every one of them
failed on a fork's first source. The fix was not to weaken the guarantee: "the kit binds nothing"
is now proved by `npm run verify:edge` (`sourceTableFailures` in `scripts/check-edge-hardening.mjs`),
conditioned on the repo still being the unforked template. It is loud in the kit and silent in your
app. See DECISIONS 2026-08-21.

So the rule stands without an exception: **adopting a source never edits a kit test.** If one goes
red, do not edit it — open an issue against the kit. What *does* still fail in your app, and should:

- a source table that cannot be read statically (a spread, a computed key, a call inside
  `Object.freeze({ … })`);
- an entry whose key is not a lowercase source name, or whose class is not `client`/`internal`;
- a class that disagrees with the allowlist's, a granted id nothing binds, a bound id nothing grants;
- at runtime, `defineAuroraQuery` or `openAuroraClient` against a source the table does not carry;
- **a route exposed to the in-app agent with no `egressRuling`, once a `client` source is bound**
  (`test/isolation/agent-exposure.test.ts`; `buildAgentTools` refuses to build too). See below.

## Private HTTP services — a Workers VPC service that is not a database

A Workers VPC service can front an **HTTP service** instead of a database: an on-premises gateway
published through a Cloudflare Tunnel. On a DB Israel app the central catalog grants it; delivery
binds it as `VPC_<SERVICE>` and sets its host in the plain var `VPC_<SERVICE>_HOST` (for example
`VPC_EXAMPLE_API` and `example-api.private.staging.dbisrael.ai`), and the app's credential is a
per-Worker secret the catalog names. It is granted like a database — same binding kind, same flat
`Connectivity Directory Bind` account permission, same allowlist pairing — but it has no connection
string, no SQL and no read seam, so it takes its own grant class and its own transport.

**Per service: four files, one pull request**, code-owner reviewed together:

| # | File | The edit |
|---|---|---|
| 1 | the deploying wrangler config(s) | the binding and its host: `"vpc_services": [{ "binding": "VPC_EXAMPLE_API", "service_id": "<id>" }]` and `"vars": { "VPC_EXAMPLE_API_HOST": "<host>" }` — a bare lowercase host name, no scheme, port or path |
| 2 | `binding-allowlist.jsonc` | the grant, under the same config key: `{ "id": "<the same id>", "class": "http" }` |
| 3 | `src/data/privateServices.ts` | one line in `PRIVATE_SERVICES`: `example_api: 'EXAMPLE_API_TOKEN',` — the binding name minus `VPC_`, **lowercased**, and the **name** of the secret holding the credential |
| 4 | your integration module in `src/data/` | the client: it calls `privateServiceFetch(env, 'example_api', '/v1/…')` and maps the response |

On a DB Israel app the id comes from the app's onboarding receipt in the central repository, and
central delivery builds the deployed Worker's bindings from the catalog, not from these configs.
The rows above still land: they are what the app's own tests, local runs and code review see, and
the gate keeps the binding, its host, its grant and its credential together.

`npm run verify:edge` refuses:

- an `http` grant on `hyperdrive` or `vpc_networks` — Hyperdrive is always a database, and a network
  binding reaches a whole tunnel; those stay `client`/`internal` exactly as before;
- an `http` binding not named `VPC_` + an UPPER_SNAKE_CASE service name (the transport looks it up
  that way), or one ending in `_HOST`;
- an `http` binding without `VPC_<SERVICE>_HOST`, or with a host that is not a bare host name;
- an `http` service not registered in `PRIVATE_SERVICES`, or one registered in `AURORA_SOURCES` too
  (and a database grant registered in `PRIVATE_SERVICES`) — one binding is one kind of thing;
- one id granted twice under the same config key, in either order — for any binding kind;
- everything it refused before: an unlisted id, a stale grant, a name without the `VPC_` prefix.

An `http` grant needs no `AURORA_SOURCES` entry and no `READ_AUDIT` arming.

### Calling one

```ts
// src/data/exampleApi.ts — protected core, like every module under src/data/
import type { Env } from '../env';
import { PrivateServiceError, privateServiceFetch } from './privateServices';

export async function listItems(env: Env): Promise<Item[]> {
  const res = await privateServiceFetch(env, 'example_api', '/v1/items?limit=20', {
    timeoutMs: 5_000,
  });
  if (!res.ok) throw new ExampleApiError(res.status); // map to your own typed failure
  return parseItems(await res.json());
}
```

`privateServiceFetch` is the only way to reach the service, and it holds the rules so a client does
not have to remember them:

- **Through the binding, to `https://<host><path>`.** The caller passes a path starting with one
  `/`; the transport takes the host from `VPC_<SERVICE>_HOST` and refuses a path that could resolve
  anywhere else (`//host`, a backslash, a fragment, whitespace). The host is never in app code.
- **The credential, every time.** The registered secret is sent as `Authorization: Bearer …`. A
  caller that sets `Authorization` or `Host` itself, or passes a `cf` override, is refused, not
  overwritten.
- **No redirects, always a timeout.** A 3xx is refused (it could carry the credential-bearing
  request anywhere). The deadline — 10 s by default, at most 30 s — covers the whole call, the
  credential lookup included; a caller's own `signal` still works.
- **Opaque failures, clean logs.** A failure throws `PrivateServiceError` — the kit's opaque 500,
  with a `reason` from a fixed list and `transient` true for `timeout` and `network`, the two worth
  retrying (your own `signal` firing is `aborted`, not transient). It logs `private_service_failed` with the service name and the reason only: never the
  host, the path, the credential or an error message.
- **Any non-redirect status comes back to you.** Mapping a 401, 404 or 503 is the client's job.

Routes never touch the binding — the semgrep fence on `VPC_*` still keeps `env.VPC_*` out of
everything but `src/data/` — and they reach the client the way they reach any repository function.

### When the service returns client records

The transport does not record reads. If the service returns client or third-party records, it is
**also an upstream source**: register it in `UPSTREAM_SOURCES`, define its reads with
`defineUpstreamRead`, run them through `ctx.readUpstream`, and have the client call
`requireUpstreamGrant(grant, '<source>')` before `privateServiceFetch` — see "The upstream stream"
above. The two registrations answer different questions: `PRIVATE_SERVICES` says how to reach the
service, `UPSTREAM_SOURCES` says what reading from it means.

## Private data and the in-app agent (PIA C3)

A route reads a private database through a repository **function** it calls with `ctx.env` — not
through `needs`, which only scopes `ctx.db`. So nothing a route declares can prove its handler never
reaches Aurora, and the agent-exposure check (`src/framework/agentExposure.ts`) does not pretend
to: **in an app whose `AURORA_SOURCES` holds any source not classified exactly `internal`, every
route exposed to the agent (`agent:` on defineRoute) must carry an `egressRuling`** — a DPO-signed
Linear decision with a written necessity test. The manifest reports every exposed route there as
`client_class: true`. One ruling may cover several routes; that is the DPO's call, not the kit's.

The check runs where the tool set is assembled — `assertPrivateSourcesRuled`, called by
`buildAgentTools` before any tool exists and by the isolation pin over your live registry — not in
`defineRoute`, so a route module's validity never depends on this table. An app whose sources are
all `internal` is unaffected, and the kit binds none.

## Testing

The Postgres client is **injected**, the way `src/ai/` injects its fetcher. Tests pass a
fake and assert on the SQL and the mapping. `openAuroraClient` is coverable for the same reason —
the driver is a factory, so a test supplies one and asserts on the binding it resolved and the
refusals it makes, without a database anywhere. This is what keeps the data layer coverable
in the offline test runtime and keeps the coverage gates green.

`read_log` is **plain D1**, so the ledger half runs for real in the offline runtime — the failure
posture is pinned end to end (`test/data/aurora.test.ts`), including the assertion that a rejecting
ledger means the query client was *never called*. An implementation that recorded reads after
performing them would pass every other test; that one is the guarantee.

**Never add a Hyperdrive binding to `wrangler.test.jsonc`.** The test runtime is
in-memory and network-free by design; Hyperdrive has no usable local binding, and adding
one would either fail or quietly reach a real database.

**Registering a source changes no test in this repo.** What the suite asserts about `AURORA_SOURCES`
is what stays true after you add one: it is frozen, every entry is a lowercase source name carrying
a reviewed class, and a source the table does not carry is refused by both `defineAuroraQuery` and
`openAuroraClient` — the refused name is *computed* from the table, so it cannot collide with
anything you register.

## Freshness

Hyperdrive caches read results, so a query can return data up to a minute old. It does
**not** invalidate on write — irrelevant today since there is no write path, but it is
why read-after-write is not something to design around here. If a screen genuinely needs
zero staleness, say so and it becomes a caching decision on the configuration, not a
code change.

## When it breaks

A per-route heartbeat runs on a schedule and names the layer that failed, so start with
the alert rather than guessing. Six hops mean six ways to look identical from inside the Worker:
the **Access service token** (expired or rotated), the **tunnel** (`cloudflared` down or its
route removed), the **security group**, the **database role**, the **origin TLS** (an RDS CA
rotation the Hyperdrive config has not picked up), or the query itself.

Two failures are worth naming because they present as flakiness rather than as errors:

- **Raising `sslmode` to `verify-full`.** It cannot pass on this route (see "TLS to the origin"),
  and what you get is failed connections that look like an intermittent connector fault.
- **A rotated Access service token.** Every connection is refused at the edge, before Postgres is
  involved, so the error names nothing about the database.

`Failed to acquire a connection from the pool` usually means pool saturation rather than
a broken route. Pool metrics per configuration are in the Cloudflare dashboard.

Do not debug by adding a binding, widening a grant, or pointing at a different
configuration id. Every one of those is a reviewed change for a reason.

## What is not on offer

- **Writes.** No writer configuration exists. It has a designed shape when it is needed.
- **The c360 client-data clusters.** The **read-audit trail is now shipped** (this page's seam),
  which closes one of the three conditions. The separate Cloudflare account and the second lock
  are still open, so the hold stands — do not add a binding for them yet.
- **Arbitrary SQL from a route.** The views *are* the query surface.
- **Raw bind values in the trail.** Declare a `target` instead. "Just log the query for debugging"
  is the request the typed event and the schema pin exist to refuse.

## Honest limits

This is **attribution, not tamper-proof forensics**. The ledger lives in the app's own D1, in the
same trust domain as the code that writes it, so a compromised app can fail to record its own
reads. On the `d1` stream specifically, the recording proxy traps property *reads* — so ordinary
code (including spread, `Object.entries`, `Object.assign`) is recorded, but a handler that goes out
of its way (`Object.getOwnPropertyDescriptor(ctx.db, 'users').value`) can reach an unrecorded
repository. What keeps a handler on the sanctioned path is the semgrep data fence, not the proxy. The compensating ladder is the DB-layer append-only trigger (which holds against a holder of
D1 credentials, not against the running Worker), the fleet registry's silence detection
("armed yesterday, quiet today"), and the orthogonal zone Logpush → R2 object-lock backstop in
docs/SECURITY-EDGE.md. Say this out loud wherever the trail is presented as evidence.

The `d1` stream is also **not complete by design for machine writes**. A service identity's
audited write through a `machine: true` route leaves its audit row and no read rows (the exemption
above), so for such a batch the app holds no record-level trace at all — row identity is reduced
to the audit row's key fingerprint, and the integration's own run log, matched by that fingerprint
and `X-Sync-Run`, is the record-level trace. That includes a batch carrying personal data. An
exempt request logs nothing; its evidence is its audit row and the absence of read rows by that
identity on that route. The exemption trusts the route's declared method: a `machine: true` POST
whose handler returns records it read is exempt as well, and those reads leave no `read_log` row
— whoever uses the service's token, including the person who minted it, since the audit row names
the service. Only the convention above (a machine route returns counts and the keys it was sent)
prevents that; review a machine route's response as you would its audit payload (`/security-review`
item 4 is that review, and `/add-endpoint` states the rule — the carried copies, since
`/kit-upgrade` does not carry this file). The fleet
digest's writes-stream `actors` leaves service identities out, so the registry's silence detection
judges a day by its people: it will not page on a day only the ops loop and a machine wrote, and
it cannot see a broken ledger on a day only machines used the app. The aurora and upstream
streams have no such exemption — `auroraQuery` records every private-database read, and
`ctx.readUpstream` every upstream read, inside a machine write included.
