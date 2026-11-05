// The upstream read seam (PIA C15), src/data/upstream.ts. The upstream itself is a FAKE in every
// test — a thunk that records whether, and when, it was called — while `read_log` is real D1, so
// the ledger half, which carries the promise, runs end to end.
//
// The test that matters most is 'never contacts the upstream when the ledger write fails'. An
// implementation that recorded the read after performing it would pass nearly every other test in
// this file, so the ORDER is asserted directly: the thunk looks for its own intent row before it
// answers.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReadSourceClass, readLogUpstreamSupport } from '../../src/data/readLog';
import {
  __defineUpstreamReadForTest,
  __resetUpstreamRegistryForTest,
  defineUpstreamRead,
  registeredUpstreamReads,
  requireUpstreamGrant,
  UPSTREAM_SCHEMA_REMEDY,
  UPSTREAM_SOURCES,
  type UpstreamGrant,
  type UpstreamReadCtx,
  type UpstreamReadSpec,
  upstreamRead,
  upstreamSourceClass,
} from '../../src/data/upstream';
import type { Env } from '../../src/env';
import { AppError } from '../../src/framework/errors';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { captureLogs } from '../helpers/logs';

// A synthetic source table: one client-class upstream, one internal. Real apps get theirs from
// UPSTREAM_SOURCES, which ships EMPTY in the kit; nothing here asserts that emptiness, because it
// stops being true on a fork's first source.
const SOURCES: Record<string, ReadSourceClass> = { autobahn: 'client', stats_bureau: 'internal' };

/** A source name guaranteed absent from the SHIPPED table, in the kit and in any fork. */
const UNREGISTERED: never = ((): string => {
  let name = 'never_registered_upstream';
  while (name in UPSTREAM_SOURCES) name = `${name}_x`;
  return name;
})() as never;

function clientSpec(over: Partial<UpstreamReadSpec> = {}): UpstreamReadSpec {
  return __defineUpstreamReadForTest(
    { source: 'autobahn' as never, name: 'report_datablocks', target: 'ticket_key', ...over },
    SOURCES,
  );
}

function internalSpec(over: Partial<UpstreamReadSpec> = {}): UpstreamReadSpec {
  return __defineUpstreamReadForTest(
    { source: 'stats_bureau' as never, name: 'series_by_id', target: 'series_id', ...over },
    SOURCES,
  );
}

// Background ledger work the seam scheduled, drained explicitly rather than slept on.
let scheduled: Promise<unknown>[] = [];

function ctx(over: Partial<UpstreamReadCtx> = {}): UpstreamReadCtx {
  return {
    env: env as Env,
    principal: USERS.member,
    route: 'GET /api/reports/:ticketKey/data',
    requestId: 'req-up-1',
    waitUntil: (p) => {
      scheduled.push(p);
    },
    ...over,
  };
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 5 && scheduled.length > 0; pass += 1) {
    const pending = scheduled;
    scheduled = [];
    await Promise.all(pending);
  }
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function rows(): Promise<Record<string, unknown>[]> {
  return (
    await env.DB.prepare('SELECT * FROM read_log ORDER BY created_at, id').all<
      Record<string, unknown>
    >()
  ).results;
}

/** A fake upstream: records each call, and what the ledger held at the moment it was called. */
function fakeUpstream<T>(answer: T | (() => T), opts: { fail?: Error } = {}) {
  const calls: { ledgerAtCall: Record<string, unknown>[] }[] = [];
  const read = async (): Promise<T> => {
    calls.push({ ledgerAtCall: await rows() });
    if (opts.fail) throw opts.fail;
    return typeof answer === 'function' ? (answer as () => T)() : answer;
  };
  return { read, calls };
}

/** A KV the alert throttle has never seen, so every test's alert is the first in its window. */
function freshKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
  } as unknown as KVNamespace;
}

/** An env whose alert seam is observable: a fake EMAIL binding, a kept webhook, a fresh throttle. */
function alerting(base: Env = env as Env) {
  const mails: { subject: string; text: string }[] = [];
  const slack: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: unknown, init: unknown) => {
    slack.push(String((init as RequestInit | undefined)?.body ?? ''));
    return new Response('ok');
  });
  return {
    env: {
      ...base,
      SESSIONS: freshKv(),
      EMAIL: { send: async (m: { subject: string; text: string }) => void mails.push(m) },
      ALERT_EMAIL: 'ops@test.example',
      ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
    } as unknown as Env,
    mails,
    slack,
  };
}

// ── definition time ─────────────────────────────────────────────────────────────────────────

describe('defineUpstreamRead — definition-time guards', () => {
  afterEach(__resetUpstreamRegistryForTest);

  it('accepts a well-formed read and returns a FROZEN copy', () => {
    const spec = clientSpec();
    expect(spec).toEqual({ source: 'autobahn', name: 'report_datablocks', target: 'ticket_key' });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(() => {
      (spec as { target: string }).target = 'duns';
    }).toThrow(TypeError);
    expect(registeredUpstreamReads()).toContain(spec);
  });

  // `target` names the identifier a read is keyed by. A VALUE there — a DUNS, a ticket key, an
  // email, a URL — is the one thing the ledger must never hold, so it fails at module load.
  it.each([
    ['a DUNS', '123456789'],
    ['a ticket key', 'INS-2026-0001'],
    ['an email', 'alice@test.example'],
    ['a URL', 'https://upstream.test/r?duns=123456789'],
    ['upper case', 'TicketKey'],
    ['a path', 'reports/data'],
    ['empty', ''],
    ['65 characters', `t${'x'.repeat(64)}`],
  ])('refuses %s as a target, a read id or a source', (_label, value) => {
    expect(() => clientSpec({ target: value })).toThrow(/identifier/);
    expect(() => clientSpec({ name: value })).toThrow(/identifier/);
    expect(() => clientSpec({ source: value as never })).toThrow(/identifier/);
  });

  it('refuses a read with no target at all', () => {
    expect(() => clientSpec({ target: undefined as never })).toThrow(/identifier/);
  });

  it('refuses a source neither table carries — the class comes from a table, never the read', () => {
    expect(() =>
      __defineUpstreamReadForTest(
        { source: 'datagov' as never, name: 'search', target: 'dataset_id' },
        SOURCES,
      ),
    ).toThrow(/unknown upstream source/);
  });

  it('refuses a source the SHIPPED table does not carry', () => {
    expect(() => defineUpstreamRead({ source: UNREGISTERED, name: 'x', target: 'y' })).toThrow(
      /unknown upstream source/,
    );
  });

  // The production entry point has NO class-table parameter. An earlier cut took one "for tests",
  // which let feature code register a client upstream as 'internal' and put it on the fail-open
  // path; an extra argument must change nothing, whatever it claims.
  it('takes no class table: a second argument is ignored, not honoured', () => {
    const withTable = defineUpstreamRead as unknown as (spec: unknown, table: unknown) => unknown;
    expect(() =>
      withTable({ source: UNREGISTERED, name: 'x', target: 'y' }, { [UNREGISTERED]: 'internal' }),
    ).toThrow(/unknown upstream source/);
    expect(registeredUpstreamReads().map((r) => r.source)).not.toContain(UNREGISTERED);
  });

  // A spec whose fields answer differently on each read (a Proxy, a getter) must not validate one
  // value and freeze another: each field is read once, and what was checked is what is recorded.
  it('reads each field once — what was validated is what is frozen', () => {
    const answers: Record<string, string[]> = {
      source: ['autobahn', 'stats_bureau'],
      name: ['shifty_read', 'https://upstream.test/x'],
      target: ['ticket_key', 'INS-2026-0001'],
    };
    const shifty = new Proxy({} as UpstreamReadSpec, {
      get: (_t, key) => {
        const queue = answers[String(key)];
        return queue && queue.length > 1 ? queue.shift() : queue?.[0];
      },
    });
    const spec = __defineUpstreamReadForTest(shifty, SOURCES);
    expect(spec).toEqual({ source: 'autobahn', name: 'shifty_read', target: 'ticket_key' });
  });

  it('refuses a second read under the same source and id — the ledger could not tell them apart', () => {
    clientSpec();
    expect(() => clientSpec({ target: 'duns' })).toThrow(/already registered/);
    expect(() => internalSpec({ name: 'report_datablocks' })).not.toThrow();
  });

  // A reset forgets what a TEST registered, and nothing else: the spec is refused afterwards and its
  // key is free again. (Reads a module registers for real are never forgotten — the walk in
  // test/data/upstream-registry.test.ts depends on that.)
  it('a reset forgets test registrations: the spec is refused and its key is free again', async () => {
    const spec = clientSpec();
    __resetUpstreamRegistryForTest();
    expect(registeredUpstreamReads()).not.toContain(spec);
    expect(() => clientSpec()).not.toThrow();
    await expect(upstreamRead(ctx(), spec, async () => 1)).rejects.toThrow(AppError);
  });
});

// ── the class comes from the reviewed table ─────────────────────────────────────────────────

describe('upstreamSourceClass — the reviewed table decides, a synthetic one can only add', () => {
  const REVIEWED: Record<string, ReadSourceClass> = {
    autobahn: 'client',
    stats_bureau: 'internal',
  };

  it('resolves a listed source to its reviewed class', () => {
    expect(upstreamSourceClass('autobahn', undefined, REVIEWED)).toBe('client');
    expect(upstreamSourceClass('stats_bureau', { stats_bureau: 'internal' }, REVIEWED)).toBe(
      'internal',
    );
  });

  // THE downgrade the review found: a client upstream re-registered as internal would fetch
  // first and never refuse when the ledger is down.
  it('refuses a synthetic table that reclassifies a listed source, in either direction', () => {
    expect(() => upstreamSourceClass('autobahn', { autobahn: 'internal' }, REVIEWED)).toThrow(
      /cannot reclassify/,
    );
    expect(() => upstreamSourceClass('stats_bureau', { stats_bureau: 'client' }, REVIEWED)).toThrow(
      /cannot reclassify/,
    );
  });

  it('lets a synthetic table add a source the reviewed one does not list', () => {
    expect(upstreamSourceClass('datagov', { datagov: 'internal' }, REVIEWED)).toBe('internal');
  });

  it('refuses an unknown source, an inherited key, and a class that is not one', () => {
    expect(() => upstreamSourceClass('datagov', undefined, REVIEWED)).toThrow(/unknown upstream/);
    expect(() => upstreamSourceClass('constructor', undefined, REVIEWED)).toThrow(
      /unknown upstream/,
    );
    expect(() =>
      upstreamSourceClass('datagov', { datagov: 'public' as ReadSourceClass }, REVIEWED),
    ).toThrow(/unknown upstream/);
  });

  // Against the SHIPPED table: vacuous in the kit (it lists nothing), real in every fork that
  // lists a source — no test registration can flip one.
  it('the test factory cannot reclassify any source the shipped table lists', () => {
    for (const [source, cls] of Object.entries(UPSTREAM_SOURCES) as [string, ReadSourceClass][]) {
      const flipped: ReadSourceClass = cls === 'client' ? 'internal' : 'client';
      expect(() =>
        __defineUpstreamReadForTest(
          { source: source as never, name: 'reclassify_probe', target: 'probe_key' },
          { [source]: flipped },
        ),
      ).toThrow(/cannot reclassify/);
    }
  });
});

// ── client-class: write-ahead, fail closed ──────────────────────────────────────────────────

describe('upstreamRead — client-class (write-ahead, fail-closed)', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    scheduled = [];
  });
  afterEach(() => {
    __resetUpstreamRegistryForTest();
    vi.restoreAllMocks();
  });

  it('writes the intent BEFORE the fetch and patches the count after', async () => {
    const upstream = fakeUpstream([{ block: 'a' }, { block: 'b' }]);
    const result = await upstreamRead(ctx(), clientSpec(), upstream.read);
    await settle();

    expect(result).toHaveLength(2);
    // ORDER, asserted directly: when the upstream was contacted, its intent row already existed,
    // uncounted.
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.ledgerAtCall).toHaveLength(1);
    expect(upstream.calls[0]?.ledgerAtCall[0]).toMatchObject({ kind: 'upstream', row_count: null });

    const [logged] = await rows();
    expect(logged).toMatchObject({
      request_id: 'req-up-1',
      principal: USERS.member,
      route: 'GET /api/reports/:ticketKey/data',
      kind: 'upstream',
      source: 'autobahn',
      source_class: 'client',
      view: null,
      query_name: 'report_datablocks',
      target: 'ticket_key',
      row_count: 2,
    });
  });

  // THE test. A client-data read that cannot be recorded does not happen — "does not happen"
  // meaning the upstream is never contacted, not contacted and discarded.
  it('never contacts the upstream when the ledger write fails', async () => {
    const upstream = fakeUpstream({ status: 'ok' });
    await env.DB.prepare('DROP TABLE read_log').run();
    try {
      await expect(upstreamRead(ctx(), clientSpec(), upstream.read)).rejects.toThrow(AppError);
      expect(upstream.calls).toEqual([]);
    } finally {
      await settle();
      await applySchema();
    }
  });

  it('surfaces that refusal as the OPAQUE 500, naming neither the ledger nor the source', async () => {
    await env.DB.prepare('DROP TABLE read_log').run();
    try {
      const err = await upstreamRead(ctx(), clientSpec(), async () => 'never').catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(500);
      expect((err as AppError).code).toBe('internal_error');
      expect((err as AppError).message).toBe('Something went wrong');
    } finally {
      await settle();
      await applySchema();
    }
  });

  it('leaves row_count NULL — "attempted" — when the fetch itself fails, and rethrows it as is', async () => {
    const boom = new Error('upstream 503');
    const upstream = fakeUpstream(null, { fail: boom });
    await expect(upstreamRead(ctx(), clientSpec(), upstream.read)).rejects.toBe(boom);
    await settle();
    const [logged] = await rows();
    expect(logged).toMatchObject({ source_class: 'client', row_count: null });
  });

  it('counts with the caller’s counter when it gives a real count', async () => {
    await upstreamRead(ctx(), clientSpec(), async () => ({ status: 'empty' }), {
      count: (r) => (r.status === 'ok' ? 1 : 0),
    });
    await settle();
    expect((await rows())[0]?.row_count).toBe(0);
  });

  it('falls back to the shape heuristic when the counter throws or returns a non-count', async () => {
    const logs = captureLogs();
    try {
      const spec = clientSpec();
      await upstreamRead(ctx(), spec, async () => [1, 2, 3], {
        count: () => {
          throw new Error('bad counter');
        },
      });
      await upstreamRead(ctx(), spec, async () => ({ items: [1] }), { count: () => -1 });
      await upstreamRead(ctx(), spec, async () => ({ one: 'record' }), { count: () => 1.5 });
      await settle();
    } finally {
      logs.restore();
    }
    expect((await rows()).map((r) => r.row_count).sort()).toEqual([1, 1, 3]);
    expect(logs.named('upstream_read_count_failed').map((e) => e.reason)).toEqual([
      'threw',
      'not_a_count',
      'not_a_count',
    ]);
  });

  // The heuristic itself reads `items` off the result; a result whose getter throws must still be
  // returned to the handler — the fetch already answered — and counts as 1, never 0.
  it('returns a result even the heuristic cannot read, counted as 1', async () => {
    const hostile = {
      get items(): unknown[] {
        throw new Error('no peeking');
      },
    };
    const logs = captureLogs();
    let result: unknown;
    try {
      result = await upstreamRead(ctx(), clientSpec(), async () => hostile);
      await settle();
    } finally {
      logs.restore();
    }
    expect(result).toBe(hostile);
    expect((await rows())[0]?.row_count).toBe(1);
    expect(logs.named('upstream_read_count_failed')[0]?.reason).toBe('threw');
  });

  // A cron has no waitUntil, and an isolate can end the moment its promise settles: the patch is
  // AWAITED there, so the row is counted by the time upstreamRead returns. No settle() on purpose.
  it('has already patched the count when no waitUntil is available', async () => {
    await upstreamRead(ctx({ waitUntil: undefined }), clientSpec(), async () => [1, 2, 3, 4]);
    expect((await rows())[0]?.row_count).toBe(4);
  });

  it('pages the owner when the write-ahead fails, with the class and never the message', async () => {
    const c = alerting();
    await env.DB.prepare('DROP TABLE read_log').run();
    const logs = captureLogs();
    try {
      await expect(
        upstreamRead(ctx({ env: c.env }), clientSpec(), async () => 'never'),
      ).rejects.toThrow(AppError);
      await settle();
    } finally {
      logs.restore();
      await applySchema();
    }
    expect(c.mails).toHaveLength(1);
    expect(c.mails[0]?.subject).toContain('read ledger FAILED (write_ahead): autobahn');
    expect(c.mails[0]?.text).toContain('could not record an upstream read');
    expect(c.mails[0]?.text).toContain('target: ticket_key');
    expect(c.mails[0]?.text).toContain('The read was REFUSED');
    expect(c.mails[0]?.text).not.toContain('no such table');
    expect(logs.named('upstream_read_write_ahead_failed')[0]).toMatchObject({
      source: 'autobahn',
      spec: 'report_datablocks',
    });
  });

  // Drift is ASKED of the database, not guessed from the error class. On a database that HAS
  // applied 0005, a NOT NULL failure (here: an unset APP_ENV) is still a refusal, but telling the
  // operator to apply 0005 would send them to the wrong fix in the middle of an outage.
  it('refuses on any ledger failure, but names the migration only when the table predates it', async () => {
    const c = alerting({ ...(env as Env), APP_ENV: null } as unknown as Env);
    const upstream = fakeUpstream('never');
    const logs = captureLogs();
    try {
      await expect(upstreamRead(ctx({ env: c.env }), clientSpec(), upstream.read)).rejects.toThrow(
        AppError,
      );
      await settle();
    } finally {
      logs.restore();
    }
    expect(upstream.calls).toEqual([]);
    expect(logs.named('upstream_read_write_ahead_failed')[0]?.category).toBe('constraint');
    expect(logs.named('upstream_read_schema_drift')).toEqual([]);
    expect(c.mails).toHaveLength(1);
    expect(c.mails[0]?.text).not.toContain(UPSTREAM_SCHEMA_REMEDY);
  });

  // And when the database cannot be asked at all, nothing is claimed either way.
  it('names no remedy when the database cannot be reached to ask', async () => {
    const down = {
      prepare: () => {
        throw new Error('D1 unreachable');
      },
    } as unknown as D1Database;
    const c = alerting({ ...(env as Env), DB: down } as Env);
    const logs = captureLogs();
    try {
      await expect(
        upstreamRead(ctx({ env: c.env }), clientSpec(), async () => 'never'),
      ).rejects.toThrow(AppError);
      await settle();
    } finally {
      logs.restore();
    }
    expect(logs.named('upstream_read_schema_drift')).toEqual([]);
    expect(c.mails[0]?.text ?? '').not.toContain(UPSTREAM_SCHEMA_REMEDY);
  });

  it('pages the owner when the count patch fails, and still returns the result', async () => {
    const c = alerting();
    const logs = captureLogs();
    let result: unknown;
    try {
      result = await upstreamRead(ctx({ env: c.env }), clientSpec(), async () => {
        // The intent is in; take the table away before the patch.
        await env.DB.prepare('DROP TABLE read_log').run();
        return [1];
      });
      await settle();
    } finally {
      logs.restore();
      await applySchema();
    }
    expect(result).toEqual([1]);
    expect(logs.named('upstream_read_count_patch_failed')).toHaveLength(1);
    expect(c.mails[0]?.subject).toContain('read ledger FAILED (count_patch)');
  });
});

// ── schema drift: the code is newer than the database ───────────────────────────────────────

describe('upstreamRead — a database without migration 0005', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    scheduled = [];
    // read_log as a pre-C15 app holds it: 0002's shape, whose CHECK knows only aurora and d1.
    await env.DB.prepare('DROP TABLE read_log').run();
    await env.DB.prepare(
      `CREATE TABLE read_log (
         id TEXT PRIMARY KEY, request_id TEXT NOT NULL, principal TEXT NOT NULL, app TEXT NOT NULL,
         env TEXT NOT NULL, route TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'aurora' CHECK (kind IN ('aurora', 'd1')),
         source TEXT NOT NULL, source_class TEXT NOT NULL CHECK (source_class IN ('client', 'internal')),
         view TEXT, query_name TEXT, target TEXT, row_count INTEGER,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         CHECK (kind = 'd1' OR (view IS NOT NULL AND query_name IS NOT NULL)))`,
    ).run();
  });
  afterEach(async () => {
    __resetUpstreamRegistryForTest();
    vi.restoreAllMocks();
    await env.DB.prepare('DROP TABLE read_log').run();
    await applySchema();
  });

  it('refuses a client-class read, names the migration in the log and the alert', async () => {
    const c = alerting();
    const upstream = fakeUpstream('never');
    const logs = captureLogs();
    try {
      await expect(upstreamRead(ctx({ env: c.env }), clientSpec(), upstream.read)).rejects.toThrow(
        AppError,
      );
      await settle();
    } finally {
      logs.restore();
    }
    expect(upstream.calls).toEqual([]);
    expect(logs.named('upstream_read_write_ahead_failed')[0]?.category).toBe('constraint');
    expect(logs.named('upstream_read_schema_drift')).toEqual([
      expect.objectContaining({ remedy: 'apply_migration_0005_read_log_upstream' }),
    ]);
    expect(c.mails[0]?.text).toContain(UPSTREAM_SCHEMA_REMEDY);
    // The remedy is the kit's sentence; the D1 error's own text never reaches the alert.
    expect(c.mails[0]?.text).not.toMatch(/CHECK constraint|SQLITE/);
  });

  it('serves an internal-class read and alerts with the remedy', async () => {
    const c = alerting();
    const result = await upstreamRead(ctx({ env: c.env }), internalSpec(), async () => [1, 2]);
    await settle();
    expect(result).toEqual([1, 2]);
    expect(await rows()).toEqual([]);
    expect(c.mails[0]?.subject).toContain('read ledger FAILED (flush): stats_bureau');
    expect(c.mails[0]?.text).toContain(UPSTREAM_SCHEMA_REMEDY);
  });
});

describe('readLogUpstreamSupport — the probe both readers share', () => {
  beforeAll(applySchema);
  afterEach(applySchema);

  it('accepted on a database with 0005, refused before it or without read_log, unknown when unreachable', async () => {
    expect(await readLogUpstreamSupport(env.DB)).toBe('accepted');
    await env.DB.prepare('DROP TABLE read_log').run();
    expect(await readLogUpstreamSupport(env.DB)).toBe('refused');
    await env.DB.prepare(
      `CREATE TABLE read_log (id TEXT PRIMARY KEY,
         kind TEXT NOT NULL DEFAULT 'aurora' CHECK (kind IN ('aurora', 'd1')))`,
    ).run();
    expect(await readLogUpstreamSupport(env.DB)).toBe('refused');
    await env.DB.prepare('DROP TABLE read_log').run();
    const down = {
      prepare: () => {
        throw new Error('D1 unreachable');
      },
    } as unknown as D1Database;
    expect(await readLogUpstreamSupport(down)).toBe('unknown');
  });
});

// ── internal-class: fire and forget ─────────────────────────────────────────────────────────

describe('upstreamRead — internal-class (fire-and-forget)', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    scheduled = [];
  });
  afterEach(() => {
    __resetUpstreamRegistryForTest();
    vi.restoreAllMocks();
  });

  it('fetches first and writes one complete row after', async () => {
    const upstream = fakeUpstream({ items: [1, 2, 3] });
    const result = await upstreamRead(ctx(), internalSpec(), upstream.read);
    // Nothing was written before the fetch — this class never waits on the ledger.
    expect(upstream.calls[0]?.ledgerAtCall).toEqual([]);
    await settle();
    expect(result).toEqual({ items: [1, 2, 3] });
    const [logged] = await rows();
    expect(logged).toMatchObject({
      kind: 'upstream',
      source: 'stats_bureau',
      source_class: 'internal',
      query_name: 'series_by_id',
      target: 'series_id',
      row_count: 3,
    });
  });

  // The mirror image of the client test: an internal read must never be refused by the ledger.
  it('returns normally when the ledger is unwritable', async () => {
    await env.DB.prepare('DROP TABLE read_log').run();
    try {
      // A plain thunk: fakeUpstream would look for its intent row in the table just dropped.
      let calls = 0;
      const read = async () => {
        calls += 1;
        return [1, 2];
      };
      await expect(upstreamRead(ctx(), internalSpec(), read)).resolves.toEqual([1, 2]);
      expect(calls).toBe(1);
      await settle();
    } finally {
      await applySchema();
    }
  });

  it('records a fetch that failed as ATTEMPTED, and rethrows its error unchanged', async () => {
    const boom = new Error('bureau timeout');
    await expect(
      upstreamRead(ctx(), internalSpec(), fakeUpstream(null, { fail: boom }).read),
    ).rejects.toBe(boom);
    await settle();
    expect(await rows()).toEqual([
      expect.objectContaining({ source_class: 'internal', row_count: null }),
    ]);
  });

  it('awaits the row when no waitUntil is available', async () => {
    await upstreamRead(ctx({ waitUntil: undefined }), internalSpec(), async () => null);
    expect((await rows())[0]?.row_count).toBe(0);
  });
});

// ── the grant: what lets an integration module refuse a call made around the seam ───────────

/**
 * A fork's integration module, as the seam asks one to be written: it takes the grant and checks it
 * before it fetches. `fetched` counts the fetches that really happened.
 */
function integrationFor(source: string) {
  const state = { fetched: 0 };
  async function fetchIt(grant: UpstreamGrant): Promise<{ status: string }> {
    requireUpstreamGrant(grant, source as never);
    state.fetched += 1;
    return { status: 'ok' };
  }
  return { fetchIt, state };
}

describe('the upstream grant', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    scheduled = [];
  });
  afterEach(() => {
    __resetUpstreamRegistryForTest();
    vi.restoreAllMocks();
  });

  it('reaches the thunk live, naming its source and read, on both classes', async () => {
    const autobahn = integrationFor('autobahn');
    const bureau = integrationFor('stats_bureau');
    let seen: UpstreamGrant | undefined;
    await upstreamRead(ctx(), clientSpec(), (grant) => {
      seen = grant;
      return autobahn.fetchIt(grant);
    });
    await upstreamRead(ctx(), internalSpec(), (grant) => bureau.fetchIt(grant));
    await settle();
    expect(autobahn.state.fetched).toBe(1);
    expect(bureau.state.fetched).toBe(1);
    expect(seen).toMatchObject({ source: 'autobahn', name: 'report_datablocks' });
    expect(Object.isFrozen(seen)).toBe(true);
    // For a client-class source the grant exists only once its intent row is in.
    expect((await rows()).map((r) => r.source).sort()).toEqual(['autobahn', 'stats_bureau']);
  });

  // THE property: an integration called AROUND ctx.readUpstream — with a literal, a cast, nothing —
  // does not fetch, and says so in the log, not the response.
  it('refuses a call made around the seam: a forged grant, null, or none at all', async () => {
    const autobahn = integrationFor('autobahn');
    const logs = captureLogs();
    const refusals: unknown[] = [];
    try {
      for (const forged of [
        { source: 'autobahn', name: 'report_datablocks' },
        Object.freeze({ source: 'autobahn', name: 'report_datablocks' }),
        null,
        undefined,
      ]) {
        refusals.push(await autobahn.fetchIt(forged as unknown as UpstreamGrant).catch((e) => e));
      }
    } finally {
      logs.restore();
    }
    expect(autobahn.state.fetched).toBe(0);
    for (const err of refusals) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(500);
      expect((err as AppError).message).toBe('Something went wrong');
    }
    expect(logs.named('upstream_grant_refused')).toHaveLength(4);
    expect(logs.named('upstream_grant_refused')[0]).toMatchObject({ source: 'autobahn' });
    expect(await rows()).toEqual([]);
  });

  it('refuses a grant kept past its read — it dies when the thunk settles, even a thunk that threw', async () => {
    const autobahn = integrationFor('autobahn');
    let kept: UpstreamGrant | undefined;
    await upstreamRead(ctx(), clientSpec(), async (grant) => {
      kept = grant;
      return autobahn.fetchIt(grant);
    });
    let keptFromFailure: UpstreamGrant | undefined;
    await expect(
      upstreamRead(ctx(), internalSpec(), async (grant) => {
        keptFromFailure = grant;
        throw new Error('bureau timeout');
      }),
    ).rejects.toThrow('bureau timeout');
    await settle();
    const bureau = integrationFor('stats_bureau');
    await expect(autobahn.fetchIt(kept as UpstreamGrant)).rejects.toThrow(AppError);
    await expect(bureau.fetchIt(keptFromFailure as UpstreamGrant)).rejects.toThrow(AppError);
    expect(autobahn.state.fetched).toBe(1);
    expect(bureau.state.fetched).toBe(0);
  });

  it('refuses a grant for one source at another source’s integration', async () => {
    const autobahn = integrationFor('autobahn');
    await expect(
      upstreamRead(ctx(), internalSpec(), (grant) => autobahn.fetchIt(grant)),
    ).rejects.toThrow(AppError);
    expect(autobahn.state.fetched).toBe(0);
  });

  it('cannot be written as a literal — the brand is private to the seam', () => {
    // @ts-expect-error — a call outside the seam has no grant to pass, and cannot make one.
    const literal: UpstreamGrant = { source: 'autobahn', name: 'report_datablocks' };
    expect(() => requireUpstreamGrant(literal, 'autobahn' as never)).toThrow(AppError);
  });
});

// ── what cannot reach the ledger ────────────────────────────────────────────────────────────

describe('upstreamRead — what cannot reach the ledger', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    scheduled = [];
  });
  afterEach(__resetUpstreamRegistryForTest);

  // Decision D6 on this stream: the thunk closes over the identifier VALUE and the URL it fetches,
  // and neither appears anywhere in what was written — only the NAME of the identifier does.
  it('writes no URL and no identifier value, in any column', async () => {
    const duns = '987654321';
    const url = `https://upstream.test/reports/by-duns/${duns}?namespace=acme`;
    const seen: string[] = [];
    await upstreamRead(ctx(), clientSpec({ name: 'report_by_duns', target: 'duns' }), async () => {
      seen.push(url);
      return { duns, blocks: [] };
    });
    await settle();
    const serialized = JSON.stringify(await rows());
    expect(serialized).not.toContain(duns);
    expect(serialized).not.toContain('upstream.test');
    expect(serialized).not.toContain('namespace');
    expect(serialized).toContain('"target":"duns"');
    expect(seen).toEqual([url]); // the fetch did happen, with the value — the ledger is lossy on purpose
  });

  // A hand-rolled literal carries no class; honouring it would mean guessing, and the guess an
  // attacker wants is 'internal'.
  it('refuses a spec that never went through defineUpstreamRead', async () => {
    const upstream = fakeUpstream('x');
    const forged = { source: 'autobahn', name: 'forged', target: 'ticket_key' } as never;
    await expect(upstreamRead(ctx(), forged, upstream.read)).rejects.toThrow(AppError);
    expect(upstream.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  // A spread copy is a NEW object, so it is not registered — whatever it claims. Swapping the
  // source of an internal read to a client upstream must not run on the fire-and-forget path.
  it('refuses a registered spec spread and edited', async () => {
    const upstream = fakeUpstream('x');
    const swapped = { ...internalSpec(), source: 'autobahn' as never };
    await expect(upstreamRead(ctx(), swapped, upstream.read)).rejects.toThrow(AppError);
    const retargeted = { ...clientSpec(), target: 'duns' };
    await expect(upstreamRead(ctx(), retargeted, upstream.read)).rejects.toThrow(AppError);
    expect(upstream.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it('refuses a null spec opaquely', async () => {
    await expect(upstreamRead(ctx(), null as never, async () => 1)).rejects.toThrow(AppError);
  });
});
