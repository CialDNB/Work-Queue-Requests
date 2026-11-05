// The read seam. The Postgres client is a FAKE in every test here (the src/ai/ fake-fetcher
// pattern) because the offline test runtime has no usable Hyperdrive binding — but `read_log` is
// real D1, so the ledger half, which is the half carrying the security promise, is exercised for
// real end to end.
//
// The test that matters most is 'never calls the query client when the ledger write fails'. An
// implementation that recorded the read AFTER performing it would pass every other assertion in
// this file while quietly destroying the guarantee, so ordering is asserted directly rather than
// inferred from the rows that end up in the table.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAuroraRegistryForTest,
  AURORA_SOURCES,
  type AuroraClient,
  type AuroraConnection,
  type AuroraCtx,
  type AuroraDriver,
  type AuroraQuerySpec,
  auroraQuery,
  defineAuroraQuery,
  openAuroraClient,
  registeredAuroraQueries,
  sourceNameForBinding,
} from '../../src/data/aurora';
import type { ReadSourceClass } from '../../src/data/readLog';
import type { Env } from '../../src/env';
import { AppError } from '../../src/framework/errors';
import { applySchema, seedDb, USERS } from '../helpers/db';

// A synthetic source table. Real apps get theirs from AURORA_SOURCES, which `npm run verify:edge`
// cross-checks against binding-allowlist.jsonc — and holds EMPTY for as long as the repo is still
// the unforked kit (`sourceTableFailures`, scripts/check-edge-hardening.mjs). Nothing in this file
// asserts that emptiness: it stops being true on a fork's first source, and a proof that fails on
// the first legitimate adoption is a fork tax rather than a control. What is asserted here is what
// must hold in EVERY fork — see 'refuses a source the SHIPPED table does not carry' below.
const SOURCES: Record<string, ReadSourceClass> = { c360_ro: 'client', ret1_ro: 'internal' };

/**
 * A source name guaranteed absent from `AURORA_SOURCES` — in the kit, where the table is empty,
 * and in a fork, where it is not. COMPUTED rather than written down, so the refusal assertions
 * below cannot be defeated by an app that happens to register the name they picked. Typed
 * `never`, which is assignable to `KnownSourceName` whatever a fork has widened it to.
 */
const UNREGISTERED: never = ((): string => {
  let name = 'never_registered_source';
  while (name in AURORA_SOURCES) name = `${name}_x`;
  return name;
})() as never;

/** Records the call order across the ledger and the client, which is what the D3 posture is about. */
class FakeClient implements AuroraClient {
  calls: { sql: string; params: unknown[] }[] = [];
  rows: unknown[] = [];
  failWith: Error | null = null;

  async query<R>(sql: string, params: unknown[]): Promise<{ rows: R[] }> {
    this.calls.push({ sql, params });
    if (this.failWith) throw this.failWith;
    return { rows: this.rows as R[] };
  }
}

function spec(over: Partial<AuroraQuerySpec<unknown>> = {}) {
  return defineAuroraQuery(
    {
      name: 'listUsage',
      source: 'ret1_ro' as never,
      view: 'app_ro.v_namespace_usage',
      sql: 'select namespace from app_ro.v_namespace_usage where client_code = $1',
      params: ['ACME-001'],
      ...over,
    },
    SOURCES,
  );
}

// Background work the seam scheduled, collected so tests await it rather than sleeping. The count
// patch is genuinely off the request path, so a timing-based drain would be a flake waiting to
// happen — and a flaky assertion about a security control is one that gets deleted.
let scheduled: Promise<unknown>[] = [];

function ctx(client: AuroraClient, over: Partial<AuroraCtx> = {}): AuroraCtx {
  return {
    env,
    client,
    principal: USERS.member,
    route: 'GET /api/namespace-usage',
    requestId: 'req-1',
    waitUntil: (p: Promise<unknown>) => {
      scheduled.push(p);
    },
    ...over,
  };
}

/**
 * Drain what the seam scheduled. `schedule()` never rejects, so these always settle. Loops because
 * draining one promise can schedule another, and re-reads the array each pass for the same reason.
 * When a test supplies no waitUntil, the work runs unscheduled — one microtask turn covers it.
 */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 5 && scheduled.length > 0; pass += 1) {
    const pending = scheduled;
    scheduled = [];
    await Promise.all(pending);
  }
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function rows() {
  const res = await env.DB.prepare('SELECT * FROM read_log ORDER BY created_at, id').all<
    Record<string, unknown>
  >();
  return res.results;
}

describe('defineAuroraQuery — definition-time guards', () => {
  afterEach(__resetAuroraRegistryForTest);

  it('accepts a well-formed spec', () => {
    expect(() => spec()).not.toThrow();
  });

  // Schema-qualification is not style. An unqualified name resolves against search_path, so the
  // view the ledger records and the view actually read could differ — which makes the trail
  // confidently wrong, the worst state for an audit artifact.
  it.each([['v_namespace_usage'], ['app_ro.'], ['App_RO.V_Thing'], ['a.b.c'], ['app_ro.*'], ['']])(
    'rejects the unqualified or malformed view %j',
    (view) => {
      expect(() => spec({ view })).toThrow(/schema-qualified/);
    },
  );

  it('rejects a view that is missing entirely', () => {
    expect(() => spec({ view: undefined as never })).toThrow(/schema-qualified/);
  });

  // The class comes from the reviewed allowlist. A source nobody granted has no class, and
  // guessing one is exactly the fail-open this design exists to avoid.
  it('rejects an unregistered source', () => {
    expect(() => spec({ source: 'shadow_db' as never })).toThrow(/unknown source/);
  });

  it('rejects an empty name, empty sql, or non-array params', () => {
    expect(() => spec({ name: '  ' })).toThrow(/name/);
    expect(() => spec({ sql: '' })).toThrow(/sql/);
    expect(() => spec({ params: 'ACME' as never })).toThrow(/params/);
  });

  // `target` is a DESCRIPTION of a projection, never a value. An empty one is a spec author
  // reaching for the field and not saying anything, which should not read as "declared".
  it('rejects an empty target', () => {
    expect(() => spec({ target: '   ' })).toThrow(/identifier projection/);
  });

  it('collects registered specs for the walk-test', () => {
    spec({ name: 'one' });
    spec({ name: 'two' });
    expect(registeredAuroraQueries().map((s) => s.name)).toEqual(['one', 'two']);
  });

  // The kit binds nothing, so it registers nothing. This is the walk-test in its shipped state:
  // it becomes load-bearing the moment a fork adds its first query.
  it('every registered query in the shipped kit satisfies the guards', () => {
    for (const registered of registeredAuroraQueries()) {
      expect(registered.view).toMatch(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/);
      expect(AURORA_SOURCES[registered.source]).toBeDefined();
    }
  });

  // The SHIPPED table, checked in the two ways that stay true after a fork registers its first
  // source. (1) Structure: every entry is a lowercase source name carrying a reviewed class —
  // vacuous while the kit's table is empty, load-bearing the moment it is not. The kit's own
  // half — that the table is empty AT ALL, and that it parses statically — is proved where the
  // template can be told from a fork: `sourceTableFailures` in scripts/check-edge-hardening.mjs.
  it('carries only lowercase source names, each with a reviewed class', () => {
    expect(Object.isFrozen(AURORA_SOURCES)).toBe(true);
    for (const [name, cls] of Object.entries(AURORA_SOURCES)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      // The key IS the binding name minus its prefix, lowercased. An entry that does not round
      // trip could never match the binding it was written for.
      expect(sourceNameForBinding(`HYPERDRIVE_${name.toUpperCase()}`)).toBe(name);
      expect(['client', 'internal']).toContain(cls);
    }
  });

  // (2) Behaviour: a source the reviewed table does not carry is refused. Non-vacuous in the kit
  // AND in every fork — this is the guard that stops a query being defined against a database
  // nobody granted a class to, and it is checked against the DEFAULT table (no `sources`
  // argument), so it also pins that the default is the real one.
  it('refuses a source the SHIPPED table does not carry', () => {
    expect(() => defineAuroraQuery({ ...spec(), source: UNREGISTERED })).toThrow(/unknown source/);
  });

  it('derives the source name from the binding name', () => {
    expect(sourceNameForBinding('HYPERDRIVE_RET1_RO')).toBe('ret1_ro');
    expect(sourceNameForBinding('VPC_IPA')).toBe('ipa');
  });
});

describe('auroraQuery — client-class (write-ahead, fail-closed)', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    scheduled = [];
  });
  afterEach(__resetAuroraRegistryForTest);

  const clientSpec = (over: Partial<AuroraQuerySpec<unknown>> = {}) =>
    spec({ source: 'c360_ro' as never, view: 'c360_ro.v_accounts', ...over });

  it('records the intent BEFORE the query and patches the count after', async () => {
    const client = new FakeClient();
    client.rows = [{ a: 1 }, { a: 2 }];
    const result = await auroraQuery(ctx(client), clientSpec({ target: 'client_code' }));
    await settle();

    expect(result).toHaveLength(2);
    const [logged] = await rows();
    expect(logged).toMatchObject({
      principal: USERS.member,
      route: 'GET /api/namespace-usage',
      source: 'c360_ro',
      source_class: 'client',
      view: 'c360_ro.v_accounts',
      query_name: 'listUsage',
      target: 'client_code',
      row_count: 2,
      request_id: 'req-1',
    });
  });

  // THE test. A ledger that cannot record must stop the read, and "stop" has to mean the query was
  // never sent — not that it was sent and the response discarded. Attribution is the compensating
  // control for client data on a shared account, so it must not evaporate exactly when the log is
  // down, which is precisely when someone would want it gone.
  it('never calls the query client when the ledger write fails', async () => {
    const client = new FakeClient();
    // Drop the table out from under the insert: a real, un-fakeable D1 failure.
    await env.DB.prepare('DROP TABLE read_log').run();

    await expect(auroraQuery(ctx(client), clientSpec())).rejects.toThrow(AppError);
    expect(client.calls).toEqual([]);

    await applySchema(); // restore for the following tests in this file
  });

  it('surfaces that refusal as an OPAQUE 500, leaking nothing about the ledger', async () => {
    const client = new FakeClient();
    await env.DB.prepare('DROP TABLE read_log').run();

    const err = await auroraQuery(ctx(client), clientSpec()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(500);
    expect((err as AppError).code).toBe('internal_error');
    expect((err as AppError).message).toBe('Something went wrong');
    // No SQL, no view, no binding name in what the caller can see.
    expect((err as AppError).message).not.toContain('read_log');
    expect((err as AppError).message).not.toContain('c360_ro');

    await applySchema();
  });

  // A crash between the write-ahead row and the count patch is the designed-for case, and NULL is
  // the honest answer: this read was authorized and started, and we do not know what it returned.
  it('leaves row_count NULL — meaning "attempted" — when the query itself fails', async () => {
    const client = new FakeClient();
    client.failWith = new Error('connector down');

    await expect(auroraQuery(ctx(client), clientSpec())).rejects.toThrow('connector down');
    await settle();

    const [logged] = await rows();
    expect(logged?.row_count).toBe(null);
    expect(logged?.source_class).toBe('client');
  });

  it('records the view and count only when the spec declares no target', async () => {
    const client = new FakeClient();
    client.rows = [{ a: 1 }];
    await auroraQuery(ctx(client), clientSpec());
    await settle();
    expect((await rows())[0]).toMatchObject({ target: null, row_count: 1 });
  });

  // Without a scheduler (a cron, not a request) the patch still has to happen — otherwise every
  // cron-driven read would look permanently "attempted".
  // Without a scheduler the patch is AWAITED rather than left floating: a cron's isolate can be
  // torn down the moment its own promise settles, and a lost patch leaves row_count NULL — which
  // means "attempted", polluting the exact signal listAttempted() exists to provide. No settle()
  // here, deliberately: the count must already be there when auroraQuery returns.
  it('has already patched the count when no waitUntil is available', async () => {
    const client = new FakeClient();
    client.rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    await auroraQuery(ctx(client, { waitUntil: undefined }), clientSpec());
    expect((await rows())[0]?.row_count).toBe(3);
  });
});

describe('auroraQuery — internal-class (fire-and-forget)', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    scheduled = [];
  });
  afterEach(__resetAuroraRegistryForTest);

  it('records a complete row after the query, without blocking it', async () => {
    const client = new FakeClient();
    client.rows = [{ a: 1 }];
    const result = await auroraQuery(ctx(client), spec());
    await settle();

    expect(result).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ source_class: 'internal', row_count: 1 });
  });

  // The mirror image of the client-class test, and the reason both exist: for an internal source
  // the ledger must never be able to refuse a read.
  it('returns rows normally when the ledger is unwritable', async () => {
    const client = new FakeClient();
    client.rows = [{ a: 1 }, { a: 2 }];
    await env.DB.prepare('DROP TABLE read_log').run();

    const result = await auroraQuery(ctx(client), spec());
    await settle();

    expect(result).toHaveLength(2);
    expect(client.calls).toHaveLength(1);

    await applySchema();
  });
});

describe('auroraQuery — what cannot reach the ledger', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    scheduled = [];
  });
  afterEach(__resetAuroraRegistryForTest);

  // Decision D6, asserted against the stored row rather than against the type: the SQL text and
  // the bound value are both distinctive strings, and neither appears anywhere in what was written.
  it('writes no SQL text and no bind value, in any column', async () => {
    const client = new FakeClient();
    await auroraQuery(
      ctx(client),
      spec({
        sql: 'select secret_column from app_ro.v_thing where national_id = $1',
        params: ['999-88-7777'],
        target: 'national_id',
      }),
    );
    await settle();

    const serialized = JSON.stringify(await rows());
    expect(serialized).not.toContain('999-88-7777'); // the bound value
    expect(serialized).not.toContain('select'); // the statement
    expect(serialized).not.toContain('secret_column');
    // The DECLARED projection is recorded — the name of the identifier, never its value.
    expect(serialized).toContain('national_id');
    // ...and the client did receive the real query. The ledger is lossy on purpose, not broken.
    expect(client.calls[0]?.params).toEqual(['999-88-7777']);
  });

  // Spreading a registered spec to bind params is the DOCUMENTED pattern, so the mark has to
  // survive it — object spread copies own enumerable symbol properties, which it does.
  it('accepts a registered spec spread to bind params', async () => {
    const client = new FakeClient();
    const base = spec({ params: [] });
    const rowsBack = await auroraQuery(ctx(client), { ...base, params: ['ACME-001'] });
    await settle();
    expect(rowsBack).toEqual([]);
    expect(client.calls[0]?.params).toEqual(['ACME-001']);
    expect((await rows())[0]?.query_name).toBe('listUsage');
  });

  // ...and that is exactly why the mark alone cannot be trusted. Swapping `source` on a spread
  // would otherwise run a CLIENT database on the internal fire-and-forget posture, recorded under
  // the wrong class — the class is a property of the database, not of the object handed in.
  it('refuses a registered spec whose source was swapped after registration', async () => {
    const client = new FakeClient();
    const internal = spec(); // ret1_ro => internal
    const swapped = { ...internal, source: 'c360_ro' as never }; // a CLIENT database

    await expect(auroraQuery(ctx(client), swapped)).rejects.toThrow(AppError);
    expect(client.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  // A swapped view or sql would record a read of one thing while performing a read of another.
  // Attribution that can be aimed at the wrong view is worse than none, because it is believed.
  it.each([
    ['view', { view: 'app_ro.v_something_else' }],
    ['sql', { sql: 'select * from app_ro.v_something_else' }],
    ['target', { target: 'a_different_projection' }],
    ['name', { name: 'a_different_query' }],
  ])('refuses a registered spec whose %s was swapped after registration', async (_label, over) => {
    const client = new FakeClient();
    const swapped = { ...spec(), ...over };

    await expect(auroraQuery(ctx(client), swapped)).rejects.toThrow(AppError);
    expect(client.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  // A hand-rolled object literal carries no class, so honouring it would mean guessing — and the
  // guess an attacker wants is 'internal'. Refusing is the only fail-closed answer.
  it('refuses a spec that never went through defineAuroraQuery', async () => {
    const client = new FakeClient();
    const forged = {
      name: 'forged',
      source: 'c360_ro',
      view: 'c360_ro.v_accounts',
      sql: 'select 1',
      params: [],
    } as unknown as AuroraQuerySpec<unknown>;

    await expect(auroraQuery(ctx(client), forged)).rejects.toThrow(AppError);
    expect(client.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

// The resolver. Everything above injects `ctx.client`; this is where that client legitimately
// comes from — the one function `aurora-raw-query-outside-seam` lets call `.connect()`. Nothing
// here connects to anything: the driver is a factory the caller supplies, so the offline runtime
// fakes it exactly the way it fakes the query client.
//
// The refusals are the interesting half. A resolver is the natural place for a fence to leak —
// it is the one function holding a live credential and a name-to-binding lookup — so each one
// asserts the same two things: the driver was never called, and the caller learned nothing.
describe('openAuroraClient — the one legal way to get a client', () => {
  const CONNECTION_STRING = 'postgres://u:p@example.invalid:5432/db';

  class FakeConnection extends FakeClient implements AuroraConnection {
    connected = 0;
    ended = 0;
    async connect(): Promise<void> {
      this.connected += 1;
    }
    async end(): Promise<void> {
      this.ended += 1;
    }
  }

  /** Records what the seam handed the driver, so a test can assert on it without a real one. */
  function fakeDriver(connection: AuroraConnection = new FakeConnection()) {
    const seen: string[] = [];
    const driver: AuroraDriver = (cs) => {
      seen.push(cs);
      return connection;
    };
    return { driver, seen, connection };
  }

  /** `env` plus whatever bindings this test wants to pretend the config declares. */
  function envWith(bindings: Record<string, unknown>): Env {
    return { ...env, ...bindings } as unknown as Env;
  }

  const bound = envWith({ HYPERDRIVE_C360_RO: { connectionString: CONNECTION_STRING } });

  function refusal(err: unknown): AppError {
    expect(err).toBeInstanceOf(AppError);
    const app = err as AppError;
    expect(app.status).toBe(500);
    expect(app.code).toBe('internal_error');
    expect(app.message).toBe('Something went wrong');
    return app;
  }

  it('resolves the binding, connects, and returns the client', async () => {
    const { driver, seen, connection } = fakeDriver();

    const client = await openAuroraClient(bound, 'c360_ro' as never, driver, SOURCES);

    expect(client).toBe(connection);
    expect(seen).toEqual([CONNECTION_STRING]);
    expect((connection as FakeConnection).connected).toBe(1);
  });

  // `connect()` before the caller ever sees it. A resolver that returned an unconnected client
  // would push the call back out to the fork, where the semgrep rule refuses it — which is the
  // state this function exists to end.
  it('has already connected when it returns', async () => {
    const connection = new FakeConnection();
    const { driver } = fakeDriver(connection);

    const client = (await openAuroraClient(bound, 'c360_ro' as never, driver, SOURCES)) as {
      query: FakeConnection['query'];
    };
    await client.query('select 1', []);

    expect(connection.connected).toBe(1);
    expect(connection.calls).toHaveLength(1);
  });

  // The seam never closes what it opened — only the caller knows when the request is done with it.
  it('does not end the connection it hands back', async () => {
    const connection = new FakeConnection();
    const { driver } = fakeDriver(connection);

    await openAuroraClient(bound, 'c360_ro' as never, driver, SOURCES);

    expect(connection.ended).toBe(0);
  });

  it('resolves a Workers VPC binding under the same source name', async () => {
    const { driver, seen } = fakeDriver();
    const viaVpc = envWith({ VPC_C360_RO: { connectionString: CONNECTION_STRING } });

    await openAuroraClient(viaVpc, 'c360_ro' as never, driver, SOURCES);

    expect(seen).toEqual([CONNECTION_STRING]);
  });

  // THE ONE HOLE A RESOLVER COULD PLAUSIBLY OPEN. A binding present in the environment but absent
  // from the reviewed source table is a database the allowlist never granted a class to — so
  // nothing would know whether to fail closed on it. Refused before the binding is even looked up.
  it('refuses a source the reviewed table does not list, even when its binding is present', async () => {
    const { driver, seen } = fakeDriver();
    const rogue = envWith({ HYPERDRIVE_ROGUE_RO: { connectionString: CONNECTION_STRING } });

    refusal(await openAuroraClient(rogue, 'rogue_ro' as never, driver, SOURCES).catch((e) => e));
    expect(seen).toEqual([]);
  });

  // The same refusal against the DEFAULT source table — the real one, not a permissive fallback.
  // The binding is present and correctly named, so the only thing refusing the open is the
  // source's absence from the reviewed table. True in the kit (where nothing is registered) and
  // in every fork (where this name still is not).
  it('refuses a source absent from the SHIPPED table, even with its binding present', async () => {
    const { driver, seen } = fakeDriver();
    const present = envWith({
      [`HYPERDRIVE_${String(UNREGISTERED).toUpperCase()}`]: { connectionString: CONNECTION_STRING },
    });

    // No `sources` argument: the real AURORA_SOURCES.
    refusal(await openAuroraClient(present, UNREGISTERED, driver).catch((e) => e));
    expect(seen).toEqual([]);
  });

  it('refuses a registered source with no binding in this environment', async () => {
    const { driver, seen } = fakeDriver();

    refusal(
      await openAuroraClient(envWith({}), 'c360_ro' as never, driver, SOURCES).catch((e) => e),
    );
    expect(seen).toEqual([]);
  });

  // Two bindings, one source name. The ledger records the NAME, so a read attributed to `c360_ro`
  // could have come from either database — attribution that cannot say which is worse than none.
  it('refuses a source bound over BOTH Hyperdrive and VPC rather than picking one', async () => {
    const { driver, seen } = fakeDriver();
    const ambiguous = envWith({
      HYPERDRIVE_C360_RO: { connectionString: CONNECTION_STRING },
      VPC_C360_RO: { connectionString: 'postgres://u:p@other.invalid:5432/db' },
    });

    refusal(await openAuroraClient(ambiguous, 'c360_ro' as never, driver, SOURCES).catch((e) => e));
    expect(seen).toEqual([]);
  });

  it('refuses a binding that carries no connection string', async () => {
    const { driver, seen } = fakeDriver();
    const wrongKind = envWith({ HYPERDRIVE_C360_RO: { get: () => 'not a database' } });

    refusal(await openAuroraClient(wrongKind, 'c360_ro' as never, driver, SOURCES).catch((e) => e));
    expect(seen).toEqual([]);
  });

  // Caught BEFORE connecting, so a factory returning the wrong shape fails here rather than
  // several frames deep inside runQuery with a read already half-attempted.
  it('refuses a driver that returns something that is not a connection', async () => {
    const notAConnection = { query: 'nope' } as unknown as AuroraConnection;
    const { driver } = fakeDriver(notAConnection);

    refusal(await openAuroraClient(bound, 'c360_ro' as never, driver, SOURCES).catch((e) => e));
  });

  // The connection string embeds the password. It goes to the driver and nowhere else — not into
  // the error a route could render, and not into the value handed back.
  it('never puts the connection string in what a caller can see', async () => {
    const wrongKind = envWith({ HYPERDRIVE_C360_RO: { connectionString: 42 } });
    const { driver } = fakeDriver();

    const err = refusal(
      await openAuroraClient(wrongKind, 'c360_ro' as never, driver, SOURCES).catch((e) => e),
    );
    expect(JSON.stringify(err.message)).not.toContain('postgres://');
    expect(err.message).not.toContain('HYPERDRIVE_C360_RO');
    expect(err.message).not.toContain('c360_ro');
  });

  // Opening a client is not a read, so it records nothing. The ledger row is written by
  // auroraQuery, once per query — a connection that is opened and never used must leave no trace
  // suggesting client data was touched.
  it('writes no read_log row — opening is not reading', async () => {
    const { driver } = fakeDriver();

    await openAuroraClient(bound, 'c360_ro' as never, driver, SOURCES);

    expect(await rows()).toEqual([]);
  });
});
