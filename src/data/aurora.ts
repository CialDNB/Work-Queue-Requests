// THE READ SEAM. `auroraQuery()` is the only sanctioned path from this worker to a Hyperdrive
// binding, and every read it performs lands in the `read_log` ledger. Frozen contract, 2026-08-19
// (Fleet Ledger K2a) — the private-data-routes track builds against this signature, so a change
// here is a change to be reconciled with that track, not a refactor.
//
// WHY A SEAM AND NOT A CONVENTION. Client data lives on a Cloudflare account shared with every
// other app in the fleet, because Cloudflare offers no boundary below the account
// (binding-allowlist.jsonc carries the long version). Read attribution is the COMPENSATING
// CONTROL for that decision. A compensating control that a route author can forget is not one, so
// the enforcement sits BELOW the route: a route cannot obtain a Postgres client at all (the
// #204 semgrep fence keeps `env.HYPERDRIVE_*` inside src/data/, and `hyperdrive-binding-outside-
// aurora-seam` narrows that to this file), and inside src/data/ raw `.query()` calls outside this
// function fail CI (`aurora-raw-query-outside-seam`). Three controls, none sufficient alone.
//
// AND ONE LEGAL SITE. Those three rules, taken together, left no way to open a connection at all:
// the kit shipped no resolver, so it never tripped its own fence — the first fork to bind a
// database would have. `openAuroraClient()` below is that site, and the third rule exempts it BY
// NAME (not by file), so a new function added here does not inherit the exemption.
//
// FAILURE POSTURE (Decision D3) — the load-bearing half:
//
//   client-class source   WRITE-AHEAD. The intent row is INSERTed and AWAITED *before* the query
//                         is sent. If that insert fails, the read THROWS an opaque 500 and the
//                         query client is never called. A read that cannot be recorded does not
//                         happen — otherwise attribution evaporates exactly when the ledger is
//                         down, which is precisely when someone would want it gone.
//   internal-class source FIRE-AND-FORGET, matching the kit's audit-on-write posture. The query
//                         runs first, the row is flushed afterwards and never awaited on the
//                         request path. A failure alerts; it never blocks a read.
//
// Both failure paths alert through the same throttled ops seam the framework's audit failures
// use, so a silent ledger is a page rather than a log line nobody reads.
//
// TESTING. The Postgres client is INJECTED (the src/ai/anthropic.ts fake-fetcher pattern). The
// test runtime is offline and in-memory with no usable Hyperdrive binding, so every test passes a
// fake — while `read_log` is plain D1 and therefore fully exercised for real. The ledger half,
// which is the half that carries the security promise, is covered end to end.
import { sendViaAlertSeam } from '../cron/alert';
import type { Env } from '../env';
import { AppError } from '../framework/errors';
import { LOGS_CARRY_CLASS_ONLY, logEvent } from '../platform/logEvent';
import { rateLimit } from '../security/rateLimit';
import { type ReadLogIntent, type ReadSourceClass, readLogRepo } from './readLog';

// ---------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------

/**
 * Every private-database source this app may read, and the trust class of each. THE KIT BINDS
 * NOTHING, so this ships empty — a fork adds one entry per binding, in the SAME pull request as
 * the wrangler binding and its `binding-allowlist.jsonc` grant. `npm run verify:edge` cross-checks
 * all three: a granted binding with no entry here fails CI, and so does a class that disagrees
 * with the allowlist's.
 *
 * The key is the source NAME, which is the binding name minus the `HYPERDRIVE_`/`VPC_` prefix,
 * lowercased — `HYPERDRIVE_RET1_RO` is `ret1_ro`. Deriving it keeps one identifier, so a
 * reviewer reading a `read_log` row can find the binding it came from without a lookup table.
 *
 * A source's class is NOT a property of the query. It is a property of the database, decided
 * once where the grant is reviewed, so no individual query can quietly opt a client cluster into
 * the fire-and-forget path.
 */
// `satisfies` rather than a `: Readonly<Record<string, ReadSourceClass>>` ANNOTATION, and the
// difference is the whole point: an annotation makes `keyof typeof AURORA_SOURCES` collapse to
// `string`, so `KnownSourceName` would admit any string and the compile-time half of this contract
// would silently not exist. `satisfies` checks the values while leaving the keys narrow.
//
// Keep the literal inline in the `Object.freeze({ … })` call: `parseAuroraSources` in
// scripts/check-edge-hardening.mjs reads this table statically to cross-check it against
// binding-allowlist.jsonc, and it FAILS CLOSED on a shape it cannot read.
export const AURORA_SOURCES = Object.freeze({
  // A fork's sources land here, one line each: `ret1_ro: 'internal',`
}) satisfies Readonly<Record<string, ReadSourceClass>>;

/** Binding name (`HYPERDRIVE_RET1_RO`) → source name (`ret1_ro`). Exported for the CI check. */
export function sourceNameForBinding(binding: string): string {
  return binding.replace(/^(HYPERDRIVE|VPC)_/, '').toLowerCase();
}

/**
 * A source name known to this app — genuinely a union of the registered keys, so a typo is a
 * compile error and not merely a module-load throw. `never` in the kit, which is correct rather
 * than awkward: an app that binds no private database cannot define a query against one, and the
 * type says so. (A fork's first source widens it to that one name.)
 */
export type KnownSourceName = keyof typeof AURORA_SOURCES & string;

// ---------------------------------------------------------------------------------------
// The frozen contract
// ---------------------------------------------------------------------------------------

/**
 * A registered query against a private-database view. Written once in src/data/ (protected core,
 * code-owner review), then handed to `auroraQuery` by a repository function.
 *
 * `T` is the row type, declared by the frozen contract and supplied at the `auroraQuery` call
 * site (`auroraQuery<UsageRow>(ctx, spec)`). It is deliberately not carried by a field here: a
 * phantom carrier would make two specs with different row types non-interchangeable, which reads
 * as a nicety until it forces a cast in the one function allowed to touch the client.
 */
// biome-ignore lint/correctness/noUnusedVariables: T is the frozen contract's row type, consumed by auroraQuery<T>()'s return rather than by a field here — see the note above.
export interface AuroraQuerySpec<T> {
  /** Registered query id. An identifier that appears in the ledger — never SQL, never a value. */
  name: string;
  /** Which database. The union comes from the allowlist, so an unbound source will not type. */
  source: KnownSourceName;
  /**
   * The schema-qualified view this query reads (`app_ro.v_namespace_usage`). REQUIRED, and
   * checked at definition time: it is what the ledger attributes the read to, and a query whose
   * recorded surface is "unknown" is a query nobody can audit later. Schema-qualification is not
   * style — an unqualified name resolves against `search_path`, so the recorded view and the read
   * view could differ.
   */
  view: string;
  sql: string;
  params: unknown[];
  /**
   * The DECLARED identifier projection — the reviewed, conscious answer to "which records did
   * this touch" (Decision D6). Raw bind parameters are NEVER recorded: on these databases a bound
   * value can itself be client PII, so the polarity is flipped and the spec names what may be
   * kept. Omit it and the ledger records the view and the row count, which is the safe default.
   *
   * A STRING, not a value: write what the projection IS (`'client_code'`), never the value it
   * took. `auroraQuery` never evaluates it against `params`.
   */
  target?: string;
}

/**
 * The minimal Postgres surface the seam uses. Injected, so the offline test runtime can supply a
 * fake — and so this module never has to name a driver.
 */
export interface AuroraClient {
  query<R>(sql: string, params: unknown[]): Promise<{ rows: R[] }>;
}

export interface AuroraCtx {
  env: Env;
  /** The injected Postgres client. Resolved from the binding by the repository, never by a route. */
  client: AuroraClient;
  /** Actor email. Stays app-local — the fleet registry only ever receives counts. */
  principal: string;
  /** The route serving this read, e.g. `GET /api/namespace-usage`. */
  route: string;
  /** Correlates every read made while serving one request. */
  requestId: string;
  /**
   * Background scheduling. Present on the request path; when absent, the post-query work is
   * awaited instead, so a caller outside a request (a cron) still records completely.
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

// ---------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------

const REGISTERED = Symbol('auroraQuerySpec.registered');

/**
 * What `defineAuroraQuery` seals into a spec: the resolved class, plus a SNAPSHOT of every field
 * that identifies the read.
 *
 * The snapshot exists because object spread copies own enumerable **symbol** properties too — so
 * `{ ...SPEC, params: [x] }`, the documented way to bind parameters, carries this mark along. That
 * is required for the documented pattern to work, and it is also the hole: without a snapshot,
 * `{ ...INTERNAL_SPEC, source: 'c360_ro' }` would keep a brand saying "internal" while reading a
 * CLIENT database — fire-and-forget posture on client data, recorded under the wrong class. The
 * class is supposed to be a property of the database, not of the query object, so the seam
 * re-checks rather than trusting what it is handed. `params` is deliberately NOT snapshotted: it
 * is the one field a call site is meant to vary.
 */
interface Registration {
  sourceClass: ReadSourceClass;
  name: string;
  source: string;
  view: string;
  sql: string;
  target: string | null;
}

interface RegisteredSpec<T> extends AuroraQuerySpec<T> {
  readonly [REGISTERED]: Registration;
}

/** Schema-qualified, lowercase identifiers: exactly one dot, no quoting, no wildcards. */
const SCHEMA_QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

const registry: AuroraQuerySpec<unknown>[] = [];

/**
 * Register a query. Throws AT MODULE LOAD on a malformed spec — the same posture as
 * `defineRoute`'s definition-time guards, so a violation is a failed import in the test suite
 * rather than a 500 on the one request that happens to hit it.
 *
 * The source's class is resolved HERE, from the allowlist-backed source table, and sealed into
 * the returned spec where no caller can reach it. That is why `auroraQuery` refuses an
 * unregistered object: a hand-rolled `{ name, source, view, sql, params }` literal carries no
 * class, and the fail-open path is exactly the one an attacker would want to pick.
 *
 * `sources` is a parameter only so tests can register against a synthetic table. It is not a
 * runtime knob: defining a query is protected-core work, and route code has no client to run one
 * with even if it could define it.
 */
export function defineAuroraQuery<T>(
  spec: AuroraQuerySpec<T>,
  sources: Readonly<Record<string, ReadSourceClass>> = AURORA_SOURCES,
): AuroraQuerySpec<T> {
  const where = `Aurora query ${JSON.stringify(spec.name)}`;
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new Error('Aurora query: `name` is required — it is the query id the ledger records.');
  }
  const sourceClass = sources[spec.source];
  if (sourceClass === undefined) {
    throw new Error(
      `${where}: unknown source ${JSON.stringify(spec.source)}. Add it to AURORA_SOURCES in the ` +
        'same pull request as the wrangler binding and its binding-allowlist.jsonc grant — the ' +
        'class comes from the reviewed allowlist, never from the query.',
    );
  }
  if (typeof spec.view !== 'string' || !SCHEMA_QUALIFIED.test(spec.view)) {
    throw new Error(
      `${where}: \`view\` must be a schema-qualified view like "app_ro.v_thing", found ` +
        `${JSON.stringify(spec.view)}. It is what the read ledger attributes the read to, and an ` +
        'unqualified name resolves against search_path — the recorded view could differ from the ' +
        'one read.',
    );
  }
  if (typeof spec.sql !== 'string' || spec.sql.trim() === '') {
    throw new Error(`${where}: \`sql\` is required.`);
  }
  if (!Array.isArray(spec.params)) {
    throw new Error(`${where}: \`params\` must be an array — parameterised, always.`);
  }
  if (spec.target !== undefined && (typeof spec.target !== 'string' || spec.target.trim() === '')) {
    throw new Error(
      `${where}: \`target\` names the identifier projection to record (e.g. "client_code"). ` +
        'It is a description, never a bound value.',
    );
  }
  const registered: RegisteredSpec<T> = {
    ...spec,
    [REGISTERED]: {
      sourceClass,
      name: spec.name,
      source: spec.source,
      view: spec.view,
      sql: spec.sql,
      target: spec.target ?? null,
    },
  };
  registry.push(registered as AuroraQuerySpec<unknown>);
  return registered;
}

/**
 * Every spec registered so far — the walk-test surface. A test can assert that each one still
 * satisfies the definition-time guards, so the invariants hold for the whole registered set and
 * not merely for whichever query a test happened to exercise.
 */
export function registeredAuroraQueries(): ReadonlyArray<AuroraQuerySpec<unknown>> {
  return registry;
}

/** Test-only: drop registrations so one file's synthetic specs don't leak into another's walk. */
export function __resetAuroraRegistryForTest(): void {
  registry.length = 0;
}

/**
 * Recover the registration, refusing anything that is not exactly what was registered.
 *
 * Two refusals, and the second is the one worth reading. An ABSENT mark means a hand-rolled spec:
 * it carries no class, and guessing one would pick the fail-open branch an attacker wants. A
 * DIVERGENT mark means a registered spec was spread and edited — the mark survives the spread
 * (that is what makes `{ ...SPEC, params: [x] }` work), so without this check a swapped `source`
 * would run a client database on the internal posture, and a swapped `view` or `sql` would record
 * a read of one thing while performing a read of another. Attribution that can be pointed at the
 * wrong view is worse than none, because it is believed.
 *
 * `params` is exempt by design: varying it is the documented call-site pattern, and it never
 * reaches the ledger.
 */
function registrationOf<T>(spec: AuroraQuerySpec<T>): Registration {
  const mark =
    spec === null || typeof spec !== 'object' ? undefined : (spec as RegisteredSpec<T>)[REGISTERED];
  const name = typeof spec?.name === 'string' ? spec.name : '?';
  if (!mark || (mark.sourceClass !== 'client' && mark.sourceClass !== 'internal')) {
    // Deliberately opaque to the caller: a hand-rolled spec is a programming error, and the
    // detail belongs in the log, not in a response body.
    logEvent('aurora_unregistered_spec', { spec: name });
    throw internalError();
  }
  if (
    spec.name !== mark.name ||
    spec.source !== mark.source ||
    spec.view !== mark.view ||
    spec.sql !== mark.sql ||
    (spec.target ?? null) !== mark.target
  ) {
    logEvent('aurora_spec_mutated_after_registration', { spec: name, registered: mark.name });
    throw internalError();
  }
  return mark;
}

// ---------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------

function internalError(): AppError {
  return new AppError(500, 'internal_error', 'Something went wrong');
}

/**
 * Run a registered query against a private-database view, recording it in the read ledger.
 *
 * The ordering below IS the security property. For a client-class source the ledger write is
 * awaited before `ctx.client.query` is ever reached, so a rejecting ledger means the query client
 * is never called — pinned by test/data/aurora.test.ts, because an implementation that logged
 * after the read would pass every other test in this file.
 */
export async function auroraQuery<T>(ctx: AuroraCtx, spec: AuroraQuerySpec<T>): Promise<T[]> {
  const { sourceClass } = registrationOf(spec);
  const ledger = readLogRepo(ctx.env.DB);
  const intent: ReadLogIntent = {
    id: crypto.randomUUID(),
    request_id: ctx.requestId,
    principal: ctx.principal,
    app: ctx.env.APP_NAME,
    env: ctx.env.APP_ENV,
    route: ctx.route,
    // WHICH STREAM. Explicit rather than left to the column default: this seam and the
    // framework's recordDb proxy are the ledger's only two writers, and each one naming its own
    // stream is what keeps K1's `reads_aurora` / `reads_d1` split honest at the call site.
    kind: 'aurora',
    source: spec.source,
    source_class: sourceClass,
    view: spec.view,
    query_name: spec.name,
    target: spec.target ?? null,
    // Note what is NOT here, and cannot be: spec.sql and spec.params. ReadLogIntent has no field
    // for either, so this object literal is the whole of what can ever reach the ledger.
  };

  if (sourceClass === 'client') {
    // WRITE-AHEAD. Awaited before the query exists on the wire.
    try {
      await ledger.insertIntent(intent);
    } catch (err) {
      logEvent('read_log_write_ahead_failed', { spec: spec.name, err });
      // Not awaited: the refusal below must not wait on an alert fanout. The seam already has the
      // outcome it needs — the read is not happening.
      void scheduleLedgerWork(ctx, alertReadLedgerFailure(ctx.env, 'write_ahead', intent, err));
      // Fail CLOSED. The caller sees the kit's opaque error; the route renders a 500 and the
      // client data is not read. Decision D3.
      throw internalError();
    }

    const rows = (await runQuery(ctx, spec)) as T[];

    // Patch the count off the hot path when there is a scheduler; await it when there is not (see
    // `scheduleLedgerWork`). If it never lands — a crash, an evicted isolate — the row keeps row_count NULL,
    // which MEANS "attempted", and listAttempted() surfaces it.
    await scheduleLedgerWork(
      ctx,
      ledger.patchRowCount(intent.id, rows.length).catch((err) => {
        logEvent('read_log_count_patch_failed', { spec: spec.name, err });
        return alertReadLedgerFailure(ctx.env, 'count_patch', intent, err);
      }),
    );
    return rows;
  }

  // INTERNAL-CLASS. The read never waits on the ledger; the complete row is flushed after.
  const rows = (await runQuery(ctx, spec)) as T[];
  await scheduleLedgerWork(
    ctx,
    ledger.insertComplete(intent, rows.length).catch((err) => {
      logEvent('read_log_flush_failed', { spec: spec.name, err });
      return alertReadLedgerFailure(ctx.env, 'flush', intent, err);
    }),
  );
  return rows;
}

/**
 * THE ONLY raw QUERY call in the repo (`aurora-raw-query-outside-seam` fails CI on any other; the
 * rule's one other exemption, `openAuroraClient` below, opens connections and never queries).
 * Kept as its own function so both class branches above share one call site — two call sites
 * would be two places for a future edit to skip the ledger.
 *
 * Deliberately NOT generic. The semgrep rule that fences every other raw call scopes its
 * exemption to this function by name (`pattern-not-inside: async function runQuery(...)`), and a
 * type-parameter list is exactly the sort of signature detail a pattern can fail to match — which
 * would fail OPEN, exempting nothing and reporting the seam itself. The row type is asserted by
 * the two call sites above, where `T` came from; the driver returns `unknown` rows either way, so
 * the assertion adds no claim the generic form was not already making.
 */
async function runQuery(ctx: AuroraCtx, spec: AuroraQuerySpec<unknown>): Promise<unknown[]> {
  const result = await ctx.client.query<unknown>(spec.sql, spec.params);
  return result.rows;
}

// ---------------------------------------------------------------------------------------
// Opening a client
// ---------------------------------------------------------------------------------------

/**
 * The private-database binding surface this seam reads. Hyperdrive and Workers VPC both expose
 * `connectionString`, and it is the only field either one is ever asked for.
 *
 * That string is a LIVE CREDENTIAL — it embeds the password. It is read once, handed straight to
 * the driver, and never logged, returned, or placed in an error message. Every refusal below
 * names the BINDING instead: a name is something a reviewer can act on and a secret is not.
 */
export interface AuroraBinding {
  connectionString: string;
}

/**
 * A driver connection: the query surface `auroraQuery` runs on, plus the lifecycle calls a
 * Postgres driver exposes.
 *
 * `connect()` is called by `openAuroraClient` and nowhere else in this repo. `end()` is NOT
 * called here — only the caller knows when the request is finished with the connection, and
 * closing one the seam is still holding would be a worse failure than leaking one. On the request
 * path that is `ctx.waitUntil(client.end())`; in a cron it is a `finally`.
 */
export interface AuroraConnection extends AuroraClient {
  connect(): Promise<void>;
  end(): Promise<void>;
}

/**
 * Builds an UNCONNECTED driver connection from a connection string.
 *
 * THE KIT SHIPS NO POSTGRES DRIVER, and this parameter is why it does not have to. A driver is a
 * dependency with a release-age gate, a bundle cost and a Node-compat surface, and the kit binds
 * no private database — so the fork that binds one brings its own (`pg`; `nodejs_compat` is
 * already set in every kit wrangler config) and passes a one-line factory:
 *
 *     const client = await openAuroraClient(env, 'ret1_ro', (cs) => new Client({
 *       connectionString: cs,
 *     }));
 *
 * The factory CONSTRUCTS and nothing more — it must not connect and must not query. That is what
 * keeps the fork's line legal under `aurora-raw-query-outside-seam`, and it is the whole reason
 * this takes a factory rather than an already-live client: a parameter typed `AuroraConnection`
 * would push the `.connect()` call back out into the fork, where the rule would (correctly)
 * refuse it, and there would again be no legal site.
 *
 * WHICH DRIVERS FIT: those carrying node-postgres' `query(text, values)` shape — `pg` and its
 * compatible clients. A template-tag driver such as `postgres.js` does not, and wrapping one is
 * not a workaround: the adapter would have to call `.unsafe()`, which stays banned outside the
 * seam. Deliberate. `query(text, values)` is the shape that keeps SQL and bind values separate
 * all the way to the wire, and it is the shape `AuroraQuerySpec` is built around.
 */
export type AuroraDriver = (connectionString: string) => AuroraConnection;

/** The prefixes a private-database binding may carry — the two `sourceNameForBinding` strips. */
const BINDING_PREFIXES = ['HYPERDRIVE', 'VPC'] as const;

/**
 * Find the binding a registered source name refers to, by reversing `sourceNameForBinding`.
 *
 * Both prefixes are tried because a source is reached over Hyperdrive or over Workers VPC and the
 * source name records neither. Finding BOTH is refused rather than resolved by precedence: two
 * bindings mean two databases, the ledger records only the source name, and attribution that
 * cannot say which of two databases was read is attribution nobody can use. Naming them apart is
 * one line in the allowlist; guessing here would be permanent.
 *
 * `Env` declares no private-database binding — the kit binds none, and a fork adds its own — so
 * the lookup is by name off the environment bag. That is the third place the `HYPERDRIVE_*` /
 * `VPC_*` naming convention is load-bearing, alongside the semgrep fence and the allowlist check;
 * all three key on the same prefix, which is why none of them may be relaxed alone.
 */
function bindingForSource(env: Env, source: string): AuroraBinding {
  const bag = env as unknown as Record<string, unknown>;
  const found = BINDING_PREFIXES.map((prefix) => `${prefix}_${source.toUpperCase()}`).filter(
    (name) => bag[name] !== undefined && bag[name] !== null,
  );
  const [name] = found;
  if (name === undefined) {
    // A registered source with no binding in THIS environment. Common and legitimate mid-rollout
    // — staging binds it, production does not — so the log names the source rather than
    // asserting a typo; the candidates it looked for are HYPERDRIVE_<SOURCE> and VPC_<SOURCE>.
    logEvent('aurora_binding_missing', { source });
    throw internalError();
  }
  if (found.length > 1) {
    logEvent('aurora_binding_ambiguous', { source, found: found.length });
    throw internalError();
  }
  const binding = bag[name] as Partial<AuroraBinding>;
  if (typeof binding.connectionString !== 'string' || binding.connectionString === '') {
    // Not a Hyperdrive/VPC binding at all — a KV namespace, a var, a stub left in a config. Named
    // by BINDING, never by value: the value is the credential.
    logEvent('aurora_binding_malformed', { binding: name });
    throw internalError();
  }
  return binding as AuroraBinding;
}

/**
 * Open a connected Postgres client for a registered source. THE ONLY legal way to obtain one.
 *
 * Three rules interlock to keep it that way, and before this function existed they left no legal
 * site at all: `env.HYPERDRIVE_*` / `env.VPC_*` is fenced out of everything but `src/data/`, then
 * narrowed again to this file, and `.connect()` is banned across `src/` outside the seam. The kit
 * shipped no resolver, so it never tripped its own rule — the first fork to bind a database would
 * have been the one to find that out. This is the resolver, and `aurora-raw-query-outside-seam`
 * exempts it BY NAME.
 *
 * BY NAME, not by file, and that distinction is the security property: a new function added to
 * this file does not inherit the exemption. If you are here to add one that connects or queries,
 * that is the conversation to have out loud — not a pattern to widen.
 *
 * WHAT IT REFUSES. Only a source in `AURORA_SOURCES` can be opened. The table is the same one
 * `defineAuroraQuery` resolves a class from and the same one `npm run verify:edge` cross-checks
 * against `binding-allowlist.jsonc`, so a binding present in the environment but absent from the
 * reviewed table cannot be reached even from inside this file. Without that check the resolver
 * would be a way to read a database the allowlist never granted — the one hole a resolver could
 * plausibly open.
 *
 * Every refusal is the kit's OPAQUE 500. A misconfigured binding is a deployment fact about which
 * databases this Worker holds credentials for, and the detail belongs in the log.
 *
 * Deliberately NOT generic, for the reason spelled out on `runQuery`: the semgrep exemption
 * matches this signature, and a type-parameter list is exactly the detail a pattern can miss.
 *
 * `sources` is a parameter only so tests can resolve against a synthetic table, mirroring
 * `defineAuroraQuery`. It is not a runtime knob.
 */
export async function openAuroraClient(
  env: Env,
  source: KnownSourceName,
  driver: AuroraDriver,
  sources: Readonly<Record<string, ReadSourceClass>> = AURORA_SOURCES,
): Promise<AuroraConnection> {
  if (sources[source] === undefined) {
    logEvent('aurora_open_unknown_source', { source });
    throw internalError();
  }
  const binding = bindingForSource(env, source);
  const connection = driver(binding.connectionString);
  if (
    connection === null ||
    typeof connection !== 'object' ||
    typeof connection.connect !== 'function' ||
    typeof connection.query !== 'function'
  ) {
    // Caught before connecting, so a driver factory that returns the wrong thing fails here
    // rather than several frames deep inside `runQuery` with the read already half-attempted.
    logEvent('aurora_driver_malformed', { source });
    throw internalError();
  }
  await connection.connect();
  return connection;
}

/**
 * Hand off background ledger work. Never rejects, so what it returns is always safe for waitUntil.
 * Shared with the upstream seam (src/data/upstream.ts), which has the same two callers — a request
 * with a scheduler, a cron without one — and the same reason to await in the second case.
 *
 * Returns a promise the caller AWAITS when there is no scheduler. That case is a cron or a test —
 * no request whose latency could suffer — and leaving the work floating there is not free: a
 * Workers isolate can be torn down the moment the cron's own promise settles, so a floating count
 * patch is simply lost, and the row keeps `row_count` NULL. NULL means "attempted", so every
 * cron-driven client read would pollute exactly the signal `listAttempted()` exists to provide.
 * Awaiting costs one D1 round-trip off the request path and keeps that signal meaningful.
 *
 * With a scheduler, it stays off the hot path, and a broken waitUntil is swallowed for the same
 * reason the framework's audit alert swallows one: fail-open must not become a 500.
 */
export function scheduleLedgerWork(
  ctx: Pick<AuroraCtx, 'waitUntil'>,
  work: Promise<unknown>,
): Promise<void> {
  const safe = work.then(
    () => undefined,
    (err) => {
      logEvent('read_log_background_failed', { err });
    },
  );
  if (!ctx.waitUntil) return safe;
  try {
    ctx.waitUntil(safe);
  } catch {
    logEvent('read_log_schedule_failed');
  }
  return Promise.resolve();
}

// ---------------------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------------------

/**
 * One alert per source per window. A ledger outage hits EVERY read on that source; an unthrottled
 * fanout would flood the shared webhook and rate-limit away the cron-failure page riding the same
 * channel — the same reasoning as the framework's audit-failure throttle.
 */
const READ_LEDGER_ALERT_WINDOW_SEC = 15 * 60;

type LedgerFailureStage = 'write_ahead' | 'count_patch' | 'flush';

/**
 * Never throws. Carries the query NAME and the view — both registered identifiers — and the error
 * CLASS, never the message: a thrown Postgres error can embed SQL fragments and bound values, and
 * this fans out to email and a third-party webhook. The principal is omitted for the same reason
 * the fleet digests omit it.
 *
 * The upstream seam (src/data/upstream.ts) raises its ledger failures here too: an upstream intent
 * has no view, so its alert names the declared target (a NAME, never a value) in that line. `remedy`
 * is a fixed sentence the caller chose from its own literals — never anything derived from `err`.
 */
export async function alertReadLedgerFailure(
  env: Env,
  stage: LedgerFailureStage,
  intent: ReadLogIntent,
  err: unknown,
  remedy?: string,
): Promise<unknown> {
  let fresh = true;
  try {
    fresh = (
      await rateLimit(env, `alert:read_ledger:${intent.source}`, 1, READ_LEDGER_ALERT_WINDOW_SEC)
    ).ok;
  } catch {
    // KV down as well — alert anyway. Noise beats silence when everything is failing at once.
  }
  if (!fresh) {
    logEvent('read_ledger_alert_suppressed', { source: intent.source, stage });
    return;
  }
  const errClass = err instanceof Error ? err.name : 'error';
  const closed = intent.source_class === 'client';
  const upstream = intent.kind === 'upstream';
  const subject = `[${env.APP_NAME}/${env.APP_ENV}] read ledger FAILED (${stage}): ${intent.source}`;
  const text =
    `The read-attribution ledger could not record ${upstream ? 'an upstream' : 'a private-database'} read.\n\n` +
    `stage: ${stage}\nsource: ${intent.source} (${intent.source_class}-class)\n` +
    `query: ${intent.query_name}\n` +
    (upstream ? `target: ${intent.target}\n` : `view: ${intent.view}\n`) +
    `route: ${intent.route}\n` +
    `error class: ${errClass}\n\n` +
    (closed
      ? stage === 'write_ahead'
        ? 'The read was REFUSED (fail-closed, Decision D3) — no client data was returned. ' +
          'Client-class reads stay refused until the ledger is writable again.'
        : 'The read COMPLETED and its intent row is recorded, but the row count did not land. ' +
          'The row stays NULL, which reads as "attempted"; attribution is intact, the outcome ' +
          'is not.'
      : 'The read completed — internal-class sources never block on the ledger. This read is ' +
        'missing from the trail.') +
    (remedy ? `\n\n${remedy}` : '') +
    `\n\nCheck /_health. ${LOGS_CARRY_CLASS_ONLY}`;
  const slack =
    `:rotating_light: [${env.APP_NAME}/${env.APP_ENV}] read ledger FAILED (${stage}) on ` +
    `\`${intent.source}\` (${intent.source_class}-class, ${errClass}) — ` +
    (closed && stage === 'write_ahead' ? 'read REFUSED.' : 'read completed, trail incomplete.');
  return await sendViaAlertSeam(env, 'read_ledger_fail', { subject, text }, slack).catch(() => {
    logEvent('read_ledger_alert_failed');
  });
}
