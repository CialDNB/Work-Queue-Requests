// READ ATTRIBUTION FOR ORDINARY D1 READS (Fleet Ledger K2b) — the framework's `recordDb` proxy.
//
// Four properties are being pinned, and they are different in kind:
//
//   1. THE UNARMED PATH IS UNCHANGED. `READ_AUDIT` unset ⇒ the handler receives the very object
//      it received before K2b. Pinned the same way route-needs.test.ts pins the no-`needs` arm —
//      through a brand that must be `undefined`, so "nothing wrapped it" is a fact and not a
//      claim. The rest of the suite runs unarmed, so every other test in the repo is a second,
//      much broader witness for this one.
//   2. AN ARMED READ IS RECORDED — through HTTP and through MCP, because both adapters are thin
//      shells over one `executeRoute`.
//   3. A `needs` DENIAL IS NOT A READ. The proxy wraps OUTSIDE `scopeDb`, so a repository the
//      route was refused never reaches the ledger. A lie in an audit trail is worse than a gap.
//   4. A BUG IN THE PROXY BREAKS LOGGING, NEVER READS. Every fault injected below leaves the
//      request answering normally.
//
// Two refinements sit on top of those. A repository's DECLARED writes are not reads, while an
// undeclared method still is. And identical `(repo, method)` reads in one request aggregate into
// one row with `row_count` summed.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import { DECLARED_WRITES } from '../../src/data/declaredWrites';
import type { ReadLogRow } from '../../src/data/readLog';
import type { Env } from '../../src/env';
import { defineRoute, mountRoutes, type RouteSpec } from '../../src/framework/defineRoute';
import { executeRoute } from '../../src/framework/execute';
import {
  beginReadAudit,
  flushReadAudit,
  isReadAuditArmed,
  MAX_READ_EVENTS_PER_REQUEST,
  READ_AUDIT_ARMED,
  READ_AUDIT_VAR,
  readAuditArmed,
  readRecorderOf,
  recordDb,
  rowCountOf,
  WRITE_METHOD_NAMES,
} from '../../src/framework/readAudit';
import { scopedNeedsOf } from '../../src/framework/scopedDb';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { cookieFor } from '../helpers/http';
import { eventNames } from '../helpers/logs';

const ARMED = { ...env, READ_AUDIT: 'on' } as Env;

const principal: Principal = {
  kind: 'person',
  email: USERS.admin,
  name: null,
  role: 'admin',
  authMethod: 'magic_link',
  credentialTransport: 'cookie',
};

/**
 * Run one spec through the real pipeline, collecting what it hands to `waitUntil` and draining it
 * before returning. The flush is deliberately background work; a test that did not drain would be
 * asserting on a race.
 */
async function run(
  spec: RouteSpec<z.ZodTypeAny>,
  opts: { armed?: boolean; input?: unknown } = {},
): Promise<unknown> {
  const pending: Promise<unknown>[] = [];
  try {
    return await executeRoute(opts.armed === false ? (env as Env) : ARMED, spec, principal, {
      ip: '',
      params: {},
      request: new Request('https://x.test/api/t'),
      waitUntil: (p) => {
        pending.push(p);
      },
      invocation: { via: 'http' },
      buildRawInput: () => opts.input ?? {},
    });
  } finally {
    await Promise.allSettled(pending);
  }
}

/** Two independent property reads, compared. Written this way so biome sees no self-comparison. */
function readTwice(db: object, prop: string): boolean {
  const view = db as unknown as Record<string, unknown>;
  const first = view[prop];
  const second = view[prop];
  return first === second;
}

const ledger = () => makeDb(env as Env).readLog;
const rows = async (): Promise<ReadLogRow[]> => (await ledger().list({ limit: 100 })).items;

// A route shape used over and over below: reads notes, returns whatever it read.
function readingRoute(
  path: string,
  handler: RouteSpec<z.ZodTypeAny>['handler'],
): RouteSpec<z.ZodTypeAny> {
  return defineRoute({
    method: 'GET',
    path,
    permission: 'authenticated',
    input: z.object({}),
    handler,
  }).spec;
}

describe('READ_AUDIT arming', () => {
  // Hardcoded on purpose, like the permission matrix: changing the kit's arming vocabulary has to
  // be a conscious edit to a test that spells the word out, not a value that follows along.
  it('is armed by exactly "on" and by nothing else', () => {
    expect(readAuditArmed({ ...env, READ_AUDIT: 'on' } as Env)).toBe(true);
    for (const value of [undefined, '', 'off', 'ON', 'true', '1', 'yes']) {
      expect(readAuditArmed({ ...env, READ_AUDIT: value } as Env)).toBe(false);
    }
  });

  // The RUNTIME half of the single-source pin (the gate half is in
  // test/platform/edge-hardening.test.mjs, which cannot import this TypeScript). Both wrappers must
  // agree with the shared comparison value for value, including the whitespace near-misses, or the
  // two definitions have quietly split again: an app whose config reads `" on "` would be armed on
  // one side and refused on the other. The wrapper is allowed to differ from `isReadAuditArmed`
  // only in WHERE it reads the value from.
  it('agrees with the shared comparison, value for value', () => {
    const nearMisses = [
      READ_AUDIT_ARMED,
      undefined,
      '',
      ' on ',
      'on ',
      ' on',
      'ON',
      'On',
      'true',
      '1',
      'yes',
      'off',
    ];
    for (const value of nearMisses) {
      expect(readAuditArmed({ ...env, [READ_AUDIT_VAR]: value } as Env)).toBe(
        isReadAuditArmed(value),
      );
    }
  });

  it('the kit ships DORMANT — the test runtime, like every unmigrated fork, is unarmed', () => {
    expect(readAuditArmed(env as Env)).toBe(false);
  });
});

describe('the unarmed path is byte-identical to the pre-K2b framework', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('a handler with no `needs` gets the makeDb() object itself — unbranded, unwrapped', async () => {
    const seen: Record<string, unknown> = {};
    await run(
      readingRoute('/api/unarmed', async (ctx) => {
        seen.recorder = readRecorderOf(ctx.db) ?? null;
        seen.needs = scopedNeedsOf(ctx.db) ?? null;
        seen.repositories = Object.keys(ctx.db).sort();
        return await ctx.db.notes.list({ limit: 5 });
      }),
      { armed: false },
    );
    // Both brands absent = nothing wrapped it at all. This is the whole claim.
    expect(seen.recorder).toBeNull();
    expect(seen.needs).toBeNull();
    expect(seen.repositories).toEqual(Object.keys(makeDb(env as Env)).sort());
    expect(await rows()).toHaveLength(0);
  });

  it('a `needs` route unarmed gets the scoped view and nothing more', async () => {
    let recorder: unknown = 'unset';
    let needs: unknown = 'unset';
    const spec = defineRoute({
      method: 'GET',
      path: '/api/unarmed-scoped',
      permission: 'authenticated',
      needs: ['notes'],
      input: z.object({}),
      handler: async (ctx) => {
        recorder = readRecorderOf(ctx.db) ?? null;
        needs = scopedNeedsOf(ctx.db) ?? null;
        return null;
      },
    }).spec;
    await run(spec, { armed: false });
    expect(recorder).toBeNull();
    expect(needs).toEqual(['notes']);
    expect(await rows()).toHaveLength(0);
  });
});

describe('an armed read lands in the ledger', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('records the repository, the method, the route, the actor and the count', async () => {
    await makeDb(env as Env).notes.create({ title: 'a', body: '', createdBy: USERS.member });
    await makeDb(env as Env).notes.create({ title: 'b', body: '', createdBy: USERS.member });

    await run(readingRoute('/api/reads', async (ctx) => ctx.db.notes.list({ limit: 10 })));

    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      kind: 'd1',
      source: 'notes',
      query_name: 'list',
      view: null,
      // D1 is the app's OWN database: internal-class, always. `kind` — not `source_class` — is
      // what separates this stream from the private-database one.
      source_class: 'internal',
      route: 'GET /api/reads',
      principal: USERS.admin,
      target: null,
      row_count: 2,
      app: env.APP_NAME,
      env: env.APP_ENV,
    });
  });

  it('correlates every read of one request under a single request_id', async () => {
    await run(
      readingRoute('/api/multi', async (ctx) => {
        await ctx.db.notes.list({ limit: 5 });
        await ctx.db.users.getActive(USERS.member);
        await ctx.db.audit.list({ limit: 5 });
        return null;
      }),
    );
    const all = await rows();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((r) => r.request_id)).size).toBe(1);
    const byRequest = await ledger().listByRequest(all[0]?.request_id as string);
    expect(byRequest.map((r) => `${r.source}.${r.query_name}`).sort()).toEqual([
      'audit.list',
      'notes.list',
      'users.getActive',
    ]);
  });

  it('a second request gets its OWN request_id', async () => {
    const spec = readingRoute('/api/twice', async (ctx) => ctx.db.notes.list({ limit: 1 }));
    await run(spec);
    await run(spec);
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.request_id)).size).toBe(2);
  });

  it('counts rows over the kit’s real page shapes', async () => {
    await makeDb(env as Env).notes.create({ title: 'x', body: '', createdBy: USERS.member });
    await run(
      readingRoute('/api/shapes', async (ctx) => {
        await ctx.db.notes.list({ limit: 10 }); // { items: [...] } → 1
        await ctx.db.audit.listByAction('nothing.at.all', 10); // [] → 0
        await ctx.db.notes.get('missing'); // null → 0
        await ctx.db.users.getActive(USERS.member); // one row object → 1
        return null;
      }),
    );
    const counts = Object.fromEntries(
      (await rows()).map((r) => [`${r.source}.${r.query_name}`, r.row_count]),
    );
    expect(counts).toEqual({
      'notes.list': 1,
      'audit.listByAction': 0,
      'notes.get': 0,
      'users.getActive': 1,
    });
  });

  it('records a REJECTED read as attempted (NULL), not as empty (0)', async () => {
    // Same meaning an unpatched write-ahead intent carries: authorized, started, outcome unknown.
    // Collapsing it to 0 would assert that the read found nothing, which nobody knows.
    await expect(
      run(
        readingRoute('/api/rejects', async (ctx) => {
          const broken = ctx.db as unknown as { notes: { list: (o: unknown) => Promise<unknown> } };
          // A repository call that rejects — here by handing `list` an input it cannot use.
          return await broken.notes.list({ limit: {} as unknown as number });
        }),
      ),
    ).rejects.toThrow();
    const [row] = await rows();
    expect(row?.query_name).toBe('list');
    expect(row?.row_count).toBeNull();
    expect((await ledger().listAttempted(10)).map((r) => r.source)).toEqual(['notes']);
  });

  it('records what a handler read BEFORE it threw', async () => {
    // A route that 500s is exactly when an operator wants to know what it touched, so the flush
    // sits in a `finally`, not on the success path.
    await expect(
      run(
        readingRoute('/api/boom', async (ctx) => {
          await ctx.db.notes.list({ limit: 5 });
          throw new Error('handler exploded');
        }),
      ),
    ).rejects.toThrow(/handler exploded/);
    expect((await rows()).map((r) => `${r.source}.${r.query_name}`)).toEqual(['notes.list']);
  });

  it('does NOT record writes, or the framework’s own audit row', async () => {
    const spec = defineRoute({
      method: 'POST',
      path: '/api/writes',
      permission: 'authenticated',
      audit: 'test.write',
      input: z.object({}),
      handler: async (ctx) => {
        // A write method (in WRITE_METHOD_NAMES) plus the read that follows it.
        await ctx.db.notes.create({ title: 'w', body: '', createdBy: ctx.principal.email });
        return await ctx.db.notes.list({ limit: 5 });
      },
    }).spec;
    await run(spec);
    // Only the read. `create` is a write, and the framework's declared audit row goes through the
    // UNWRAPPED db — a route's audit trail is not a read of itself.
    expect((await rows()).map((r) => `${r.source}.${r.query_name}`)).toEqual(['notes.list']);
    // …and the audit row really was written, so "not recorded" is not "not executed".
    expect(await makeDb(env as Env).audit.listByAction('test.write', 5)).toHaveLength(1);
  });

  it('a route that reads nothing writes nothing — no empty batch, no wasted round-trip', async () => {
    await run(readingRoute('/api/silent', async () => ({ ok: true })));
    expect(await rows()).toHaveLength(0);
  });

  it('identical reads in one request land as ONE row, row_count summed', async () => {
    // The same repository method three times says one thing, not three. `row_count` already
    // means "rows this read touched", so the sum needs no schema change. A different method is
    // a different shape and keeps its own row.
    await makeDb(env as Env).notes.create({ title: 'a', body: '', createdBy: USERS.member });
    await makeDb(env as Env).notes.create({ title: 'b', body: '', createdBy: USERS.member });
    await run(
      readingRoute('/api/repeat', async (ctx) => {
        await ctx.db.notes.list({ limit: 10 });
        await ctx.db.notes.list({ limit: 10 });
        await ctx.db.users.getActive(USERS.member);
        return await ctx.db.notes.list({ limit: 10 });
      }),
    );
    const counts = Object.fromEntries(
      (await rows()).map((r) => [`${r.source}.${r.query_name}`, r.row_count]),
    );
    expect(counts).toEqual({ 'notes.list': 6, 'users.getActive': 1 });
  });
});

describe('the proxy wraps OUTSIDE scopeDb — a needs denial is never recorded as a read', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('records the declared repository and NOT the refused one', async () => {
    const spec = defineRoute({
      method: 'GET',
      path: '/api/scoped-armed',
      permission: 'authenticated',
      needs: ['notes'],
      input: z.object({}),
      handler: async (ctx) => {
        await ctx.db.notes.list({ limit: 5 });
        // Exactly the ambient reach `needs` exists to stop. The denial must survive the recording
        // proxy untouched — swallowing it here would turn `needs` back into advice.
        const escaped = ctx.db as unknown as ReturnType<typeof makeDb>;
        return await escaped.users.getActive(USERS.owner);
      },
    }).spec;
    await expect(run(spec)).rejects.toThrow(/did not declare/);
    // notes.list happened and is recorded; users was REFUSED and so is not a read that occurred.
    expect((await rows()).map((r) => `${r.source}.${r.query_name}`)).toEqual(['notes.list']);
  });

  it('keeps the scoped view’s shape and both brands visible', async () => {
    let shape: unknown;
    const spec = defineRoute({
      method: 'GET',
      path: '/api/scoped-shape',
      permission: 'authenticated',
      needs: ['notes'],
      input: z.object({}),
      handler: async (ctx) => {
        shape = {
          keys: Object.keys(ctx.db),
          needs: scopedNeedsOf(ctx.db),
          recorded: readRecorderOf(ctx.db) !== undefined,
          // A handler is entitled to assume repository identity is stable across accesses —
          // a fresh proxy per property read would quietly break `===` on ctx.db.notes.
          stable: readTwice(ctx.db, 'notes'),
        };
        return null;
      },
    }).spec;
    await run(spec);
    expect(shape).toEqual({ keys: ['notes'], needs: ['notes'], recorded: true, stable: true });
  });
});

describe('a fault in the recorder never fails a request', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('an unwritable ledger is a logged, alerted gap — never a failed flush promise', async () => {
    // FAIL-OPEN, matching audit-on-write (DECISIONS 2026-08-03) and the aurora seam's
    // internal-class path. Refusing to serve a page because the ledger blinked would trade a real
    // outage for a metadata gap. `flushReadAudit` is handed to waitUntil, so it must also never
    // REJECT — an unhandled rejection in background work is its own incident.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const recorder = beginReadAudit(USERS.admin, 'GET /api/ledger-down');
      const view = recordDb({ notes: { list: async () => ({ items: [1] }) } }, recorder) as {
        notes: { list: () => Promise<unknown> };
      };
      await view.notes.list();
      await expect(
        flushReadAudit(
          env as Env,
          {
            insertManyComplete: async () => {
              throw new Error('D1_ERROR: no such table: read_log');
            },
          },
          recorder,
        ),
      ).resolves.toBeUndefined();
      expect(eventNames(errorSpy.mock.calls)).toContain('read_audit_flush_failed');
      // …and the events were DRAINED, not left to accumulate across a failed flush: a ledger
      // outage must not turn a long-lived isolate into an ever-growing array of unwritable rows.
      expect(recorder.events).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a failed flush reports the READS it lost, not the ledger rows they folded into', async () => {
    // Aggregation folds identical reads into one row, so the batch length stopped being a count
    // of reads. The alert is the owner's measure of the attribution gap: 250 `notes.list` calls
    // that went missing must read as 250, not as the 1 row they would have become.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mails: Array<{ subject: string; text: string }> = [];
    const slack: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: unknown, init: unknown) => {
      slack.push(String((init as RequestInit | undefined)?.body ?? ''));
      return new Response('ok');
    });
    const store = new Map<string, string>();
    const alerting = {
      ...env,
      // A throttle that has never fired, so this alert is the first in its window.
      SESSIONS: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => void store.set(key, value),
      },
      EMAIL: { send: async (m: { subject: string; text: string }) => void mails.push(m) },
      ALERT_EMAIL: 'ops@test.example',
      ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
    } as unknown as Env;
    try {
      const recorder = beginReadAudit(USERS.admin, 'GET /api/ledger-down-many');
      const view = recordDb({ notes: { list: async () => ({ items: [1] }) } }, recorder) as {
        notes: { list: () => Promise<unknown> };
      };
      const calls = MAX_READ_EVENTS_PER_REQUEST + 50;
      for (let i = 0; i < calls; i++) await view.notes.list();
      expect(recorder.events).toHaveLength(1); // one row, `calls` reads
      await flushReadAudit(
        alerting,
        {
          insertManyComplete: async () => {
            throw new Error('D1_ERROR: no such table: read_log');
          },
        },
        recorder,
      );
      expect(mails).toHaveLength(1);
      expect(mails[0]?.text).toContain(`reads missing: ${calls}\n`);
      expect(slack).toHaveLength(1);
      expect((JSON.parse(slack[0] ?? '{}') as { text: string }).text).toContain(`(${calls} reads,`);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('the whole request still answers with the ledger table gone', async () => {
    // The unit test above proves the flush swallows a writer fault; this one proves the wiring —
    // a real request, a real repository, a genuinely unwritable table — still returns its data.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.DB.prepare('DROP TABLE read_log').run();
    try {
      const result = await run(
        readingRoute('/api/ledger-down-live', async (ctx) => ctx.db.notes.list({ limit: 5 })),
      );
      expect(result).toMatchObject({ items: [] });
      expect(eventNames(errorSpy.mock.calls)).toContain('read_audit_flush_failed');
    } finally {
      errorSpy.mockRestore();
      // Storage is per FILE, so the table is put back explicitly rather than left to leak.
      await applySchema();
    }
  });

  it('a broken waitUntil degrades to "not recorded", never to a 500', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await executeRoute(
        ARMED,
        readingRoute('/api/no-scheduler', async (ctx) => ctx.db.notes.list({ limit: 5 })),
        principal,
        {
          ip: '',
          params: {},
          request: new Request('https://x.test/api/t'),
          waitUntil: () => {
            throw new Error('no execution context');
          },
          invocation: { via: 'http' },
          buildRawInput: () => ({}),
        },
      );
      expect(result).toMatchObject({ items: [] });
      expect(eventNames(errorSpy.mock.calls)).toContain('read_audit_schedule_failed');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a repository whose method access throws still answers the call it can', () => {
    // The `get` trap's bookkeeping is isolated; only the call-through is not. A repository object
    // with a hostile accessor must degrade to "unrecorded", not to a broken data layer.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const recorder = beginReadAudit('a@test.example', 'GET /api/x');
      const hostile = {
        repo: Object.create(null, {
          boom: {
            enumerable: true,
            get() {
              throw new Error('hostile accessor');
            },
          },
        }),
      };
      const view = recordDb(hostile, recorder) as unknown as Record<
        string,
        Record<string, unknown>
      >;
      // The accessor's own throw belongs to the caller — it is the call-through, not bookkeeping.
      expect(() => view.repo?.boom).toThrow(/hostile accessor/);
      expect(recorder.events).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('recordDb, as a unit', () => {
  const recorder = () => beginReadAudit('a@test.example', 'GET /api/x');

  it('treats an UNKNOWN method as a read — over-record, never under-record', () => {
    // The failure mode of the opposite default is invisible and permanent: a read that quietly
    // records nothing. A fork's new finder is attributed the day it is written.
    const r = recorder();
    const view = recordDb({ clients: { findByTaxId: async () => [{ id: 1 }, { id: 2 }] } }, r) as {
      clients: { findByTaxId: () => Promise<unknown> };
    };
    return view.clients.findByTaxId().then(() => {
      expect(r.events).toEqual([{ repo: 'clients', method: 'findByTaxId', rowCount: 2 }]);
    });
  });

  it('leaves every WRITE_METHOD_NAMES entry unwrapped and unrecorded', async () => {
    const r = recorder();
    const repo: Record<string, () => Promise<string>> = {};
    for (const name of WRITE_METHOD_NAMES) repo[name] = async () => name;
    const view = recordDb({ things: repo }, r) as { things: Record<string, () => Promise<string>> };
    for (const name of WRITE_METHOD_NAMES) {
      // Unwrapped means IDENTICAL — not merely equivalent.
      expect(view.things[name]).toBe(repo[name]);
      await view.things[name]?.();
    }
    expect(r.events).toHaveLength(0);
  });

  it('handles a SYNCHRONOUS repository method', () => {
    const r = recorder();
    const view = recordDb({ cache: { peek: () => [1, 2, 3] } }, r) as {
      cache: { peek: () => number[] };
    };
    expect(view.cache.peek()).toEqual([1, 2, 3]);
    expect(r.events).toEqual([{ repo: 'cache', method: 'peek', rowCount: 3 }]);
  });

  it('leaves non-repository property access exactly as it was (no landmines)', () => {
    const r = recorder();
    const db = { notes: { list: async () => [] }, notARepo: 'plain string', count: 7 };
    const view = recordDb(db, r) as unknown as Record<string, unknown>;
    expect(view.notARepo).toBe('plain string');
    expect(view.count).toBe(7);
    expect(view.missing).toBeUndefined();
    expect((view as { then?: unknown }).then).toBeUndefined(); // an await probe must not explode
    expect(() => JSON.stringify(view)).not.toThrow();
  });

  it('forwards `this`, so a repository method that uses it keeps working', async () => {
    const r = recorder();
    const repo = {
      rows: [1, 2, 3, 4],
      async all(this: { rows: number[] }) {
        return this.rows;
      },
    };
    const view = recordDb({ things: repo }, r) as { things: typeof repo };
    expect(await view.things.all()).toEqual([1, 2, 3, 4]);
    expect(r.events[0]?.rowCount).toBe(4);
  });

  it('collapses 250 identical reads into ONE event with row_count summed', async () => {
    // A hundred polls of the same repository method say one thing, not a hundred. `row_count`
    // already carries exactly this meaning, so no schema change.
    const r = recorder();
    const view = recordDb({ things: { one: async () => ({ id: 1 }) } }, r) as {
      things: { one: () => Promise<unknown> };
    };
    const calls = MAX_READ_EVENTS_PER_REQUEST + 50;
    for (let i = 0; i < calls; i++) expect(await view.things.one()).toEqual({ id: 1 });
    expect(r.events).toEqual([{ repo: 'things', method: 'one', rowCount: calls }]);
    // …while the recorder still knows how many READS that one row stands for.
    expect(r.reads).toBe(calls);
    // Aggregation is not a way past the cap: nothing was dropped, because nothing overflowed.
    expect(r.dropped).toBe(0);
  });

  it('still caps at 250 DISTINCT read shapes, and still counts the drops', async () => {
    // A pathological handler must not turn one request into an unbounded D1 batch. Counting
    // distinct SHAPES is the meaningful budget: 200 shapes is pathological, 200 polls is a
    // working stream. The reads themselves keep working past the cap.
    const r = recorder();
    const shapes = MAX_READ_EVENTS_PER_REQUEST + 50;
    const repo: Record<string, () => Promise<unknown>> = {};
    for (let i = 0; i < shapes; i++) repo[`read${i}`] = async () => ({ id: i });
    const view = recordDb({ things: repo }, r) as {
      things: Record<string, () => Promise<unknown>>;
    };
    for (let i = 0; i < shapes; i++) {
      expect(await view.things[`read${i}`]?.()).toEqual({ id: i });
    }
    expect(r.events).toHaveLength(MAX_READ_EVENTS_PER_REQUEST);
    expect(r.dropped).toBe(50);
    // Every read counts toward `reads`, the ones over the cap too: all of them are missing from
    // the trail if the flush then fails.
    expect(r.reads).toBe(shapes);
  });

  it('keeps an ATTEMPTED read in its own bucket, never summed into a count', async () => {
    // NULL row_count means "authorized, started, outcome unknown" and listAttempted() depends on
    // it. A null cannot be summed, so the aggregation key carries the attempted flag and one
    // method that both succeeded and rejected yields two rows.
    const r = recorder();
    let fail = false;
    const view = recordDb(
      {
        things: {
          one: async () => {
            if (fail) throw new Error('D1_ERROR: forced');
            return [1, 2];
          },
        },
      },
      r,
    ) as { things: { one: () => Promise<unknown> } };
    await view.things.one();
    await view.things.one();
    fail = true;
    await expect(view.things.one()).rejects.toThrow(/forced/);
    await expect(view.things.one()).rejects.toThrow(/forced/);
    expect(r.events).toEqual([
      { repo: 'things', method: 'one', rowCount: 4 },
      { repo: 'things', method: 'one', rowCount: null },
    ]);
    expect(r.dropped).toBe(0);
  });

  it('aggregates per (repo, method): the same method on another repository is its own row', async () => {
    const r = recorder();
    const view = recordDb({ a: { list: async () => [1] }, b: { list: async () => [1, 2] } }, r) as {
      a: { list: () => Promise<unknown> };
      b: { list: () => Promise<unknown> };
    };
    await view.a.list();
    await view.b.list();
    await view.a.list();
    expect(r.events).toEqual([
      { repo: 'a', method: 'list', rowCount: 2 },
      { repo: 'b', method: 'list', rowCount: 2 },
    ]);
  });

  it('a repeat flush is a no-op: no duplicate rows, no second batch', async () => {
    // Repeat flushes must be harmless, and that is pinned rather than assumed. The aggregation
    // index points into the drained array, so the flush clears it with the array.
    const batches: unknown[][] = [];
    const sink = {
      insertManyComplete: async (batch: readonly unknown[]) => {
        batches.push([...batch]);
      },
    };
    const r = recorder();
    const view = recordDb({ things: { one: async () => [1, 2, 3] } }, r) as {
      things: { one: () => Promise<unknown> };
    };
    await view.things.one();
    await flushReadAudit(env as Env, sink, r);
    await flushReadAudit(env as Env, sink, r);
    await flushReadAudit(env as Env, sink, r);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(r.index.size).toBe(0);
  });

  it('drops (and counts) a read that lands after the flush, rather than leaking it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const written: unknown[] = [];
    const sink = {
      insertManyComplete: async (batch: readonly unknown[]) => {
        written.push(...batch);
      },
    };
    try {
      const r = beginReadAudit('a@test.example', 'GET /api/late');
      const view = recordDb({ things: { one: async () => null } }, r) as {
        things: { one: () => Promise<unknown> };
      };
      await flushReadAudit(env as Env, sink, r); // nothing collected yet: a no-op flush
      expect(r.closed).toBe(true);
      expect(written).toHaveLength(0); // an empty flush touches the ledger not at all
      await view.things.one(); // a handler's floating promise, resolving too late
      expect(r.events).toHaveLength(0);
      expect(r.dropped).toBe(1);
      expect(r.reads).toBe(0); // a late read is a drop, not a read a flushed batch lost
      // The second flush surfaces the drop in the log rather than paging anyone: a busy handler
      // is not an incident.
      await flushReadAudit(env as Env, sink, r);
      expect(eventNames(warnSpy.mock.calls)).toContain('read_audit_events_dropped');
      expect(written).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('a repository’s DECLARED writes are not reads; an undeclared method still is', () => {
  const recorder = () => beginReadAudit('a@test.example', 'POST /api/ingest');

  it('leaves a declared write unwrapped and unrecorded, and still records the reads', async () => {
    const r = recorder();
    const repo = {
      [DECLARED_WRITES]: ['upsertBatch'],
      upsertBatch: async () => 3,
      bySubscriberNumber: async () => [{ id: 1 }],
    };
    const view = recordDb({ subscriberDecisions: repo }, r) as {
      subscriberDecisions: typeof repo;
    };
    // Unwrapped means IDENTICAL, exactly as for the kit list.
    expect(view.subscriberDecisions.upsertBatch).toBe(repo.upsertBatch);
    expect(await view.subscriberDecisions.upsertBatch()).toBe(3);
    await view.subscriberDecisions.bySubscriberNumber();
    expect(r.events).toEqual([
      { repo: 'subscriberDecisions', method: 'bySubscriberNumber', rowCount: 1 },
    ]);
  });

  it('an UNDECLARED write-named method still records, because unknown methods count as reads', async () => {
    // "Nothing to remember" survives: forgetting a declaration costs a spare row (and a red
    // tripwire in test/isolation/), never a read that goes missing.
    const r = recorder();
    const view = recordDb({ subscriberDecisions: { upsertBatch: async () => 3 } }, r) as {
      subscriberDecisions: { upsertBatch: () => Promise<number> };
    };
    await view.subscriberDecisions.upsertBatch();
    expect(r.events).toEqual([{ repo: 'subscriberDecisions', method: 'upsertBatch', rowCount: 1 }]);
  });

  it('a declaration is per REPOSITORY: the same name elsewhere still records', async () => {
    const r = recorder();
    const view = recordDb(
      {
        a: { [DECLARED_WRITES]: ['sync'], sync: async () => null },
        b: { sync: async () => null },
      },
      r,
    ) as { a: { sync: () => Promise<unknown> }; b: { sync: () => Promise<unknown> } };
    await view.a.sync();
    await view.b.sync();
    expect(r.events).toEqual([{ repo: 'b', method: 'sync', rowCount: 0 }]);
  });

  it("app-registry's seven ingest writes, declared, file no read rows (they filed seven before)", async () => {
    // POST /api/apps/ingest per report (app-registry src/routes/apps.ts). The one read it makes,
    // `ledger.countIngest`, is still recorded.
    const makeRepos = () => ({
      apps: {
        upsertBySource: async () => 'app-1',
        upsertStatus: async () => undefined,
        upsertManifest: async () => undefined,
        upsertObservedSecrets: async () => undefined,
      },
      ledger: {
        countIngest: async () => 3,
        upsertDigests: async () => undefined,
        recordMigrations: async () => undefined,
        upsertReportState: async () => undefined,
      },
    });
    type Repos = ReturnType<typeof makeRepos>;
    const ingest = async (db: Repos) => {
      await db.ledger.countIngest();
      await db.apps.upsertBySource();
      await db.apps.upsertStatus();
      await db.apps.upsertManifest();
      await db.ledger.upsertDigests();
      await db.ledger.recordMigrations();
      await db.ledger.upsertReportState();
      await db.apps.upsertObservedSecrets();
    };

    const before = recorder();
    await ingest(recordDb(makeRepos(), before));
    // Undeclared, every write is filed as a read: seven false rows beside the one real read.
    expect(before.events.map((e) => `${e.repo}.${e.method}`)).toEqual([
      'ledger.countIngest',
      'apps.upsertBySource',
      'apps.upsertStatus',
      'apps.upsertManifest',
      'ledger.upsertDigests',
      'ledger.recordMigrations',
      'ledger.upsertReportState',
      'apps.upsertObservedSecrets',
    ]);

    const base = makeRepos();
    const declared = {
      apps: {
        [DECLARED_WRITES]: [
          'upsertBySource',
          'upsertStatus',
          'upsertManifest',
          'upsertObservedSecrets',
        ],
        ...base.apps,
      },
      ledger: {
        [DECLARED_WRITES]: ['upsertDigests', 'recordMigrations', 'upsertReportState'],
        ...base.ledger,
      },
    };
    const after = recorder();
    await ingest(recordDb(declared, after));
    expect(after.events).toEqual([{ repo: 'ledger', method: 'countIngest', rowCount: 1 }]);
  });

  it('a malformed declaration degrades to "counts as reads" and never breaks the repository', async () => {
    const r = recorder();
    const view = recordDb(
      {
        str: { [DECLARED_WRITES]: 'upsertBatch', upsertBatch: async () => 1 },
        mixed: { [DECLARED_WRITES]: [7, 'upsertBatch'], upsertBatch: async () => 1 },
      },
      r,
    ) as unknown as Record<string, { upsertBatch: () => Promise<number> }>;
    expect(await view.str?.upsertBatch()).toBe(1);
    expect(await view.mixed?.upsertBatch()).toBe(1);
    // A string is not a list: nothing was declared, so the write records (the safe direction).
    // The mixed array keeps its one valid entry.
    expect(r.events).toEqual([{ repo: 'str', method: 'upsertBatch', rowCount: 1 }]);
  });

  it('a declaration whose getter throws is a logged gap in classification, never a broken read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = recorder();
      const hostile = {
        upsertBatch: async () => 1,
        list: async () => [1, 2],
      };
      Object.defineProperty(hostile, DECLARED_WRITES, {
        get() {
          throw new Error('hostile declaration');
        },
      });
      const view = recordDb({ things: hostile }, r) as { things: typeof hostile };
      expect(await view.things.list()).toEqual([1, 2]);
      expect(await view.things.upsertBatch()).toBe(1);
      // Both recorded: an unreadable declaration declares nothing, and the repository is still
      // WRAPPED (a gap in classification is not a gap in attribution).
      expect(r.events.map((e) => e.method)).toEqual(['list', 'upsertBatch']);
      expect(eventNames(errorSpy.mock.calls)).toContain('read_audit_declared_writes_failed');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('the declaration travels with the object: a spread repository keeps it', async () => {
    const r = recorder();
    const base = { [DECLARED_WRITES]: ['upsertBatch'], upsertBatch: async () => 1 };
    const composed = { ...base, find: async () => null };
    const view = recordDb({ things: composed }, r) as { things: typeof composed };
    await view.things.upsertBatch();
    await view.things.find();
    expect(r.events).toEqual([{ repo: 'things', method: 'find', rowCount: 0 }]);
  });
});

describe('rowCountOf — the heuristic, named as one', () => {
  it('reads the kit’s real page shapes', () => {
    expect(rowCountOf([])).toBe(0);
    expect(rowCountOf([1, 2, 3])).toBe(3);
    expect(rowCountOf({ items: [], next_cursor: null })).toBe(0);
    expect(rowCountOf({ items: [1, 2] })).toBe(2);
    expect(rowCountOf(null)).toBe(0);
    expect(rowCountOf(undefined)).toBe(0);
  });

  it('degrades an unfamiliar shape to 1, never to 0', () => {
    // 1 says "this read touched something". 0 would ASSERT that it found nothing — a claim about
    // a read that may well have returned a thousand rows. Under-reporting is the failure worth
    // avoiding on an attribution surface.
    expect(rowCountOf({ id: 'n1', title: 't' })).toBe(1);
    expect(rowCountOf({ items: 'not an array' })).toBe(1);
    expect(rowCountOf(42)).toBe(1);
    expect(rowCountOf(true)).toBe(1);
    expect(rowCountOf('a string')).toBe(1);
  });
});

describe('every adapter inherits it, because there is one pipeline', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('HTTP: a real request through mountRoutes records its reads', async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountRoutes(app, [
      defineRoute({
        method: 'GET',
        path: '/api/http-reads',
        permission: 'authenticated',
        input: z.object({}),
        handler: async (ctx) => ctx.db.notes.list({ limit: 5 }),
      }),
    ]);
    const pending: Promise<unknown>[] = [];
    const res = await app.request(
      'https://x.test/api/http-reads',
      { headers: { cookie: await cookieFor(USERS.member) } },
      ARMED,
      {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    await Promise.allSettled(pending);
    const [row] = await rows();
    expect(row).toMatchObject({
      kind: 'd1',
      source: 'notes',
      query_name: 'list',
      route: 'GET /api/http-reads',
      principal: USERS.member,
    });
  });

  it('MCP: the same route invoked as a tool records identically', async () => {
    // Not a parallel authorization path and not a parallel attribution path either — the MCP
    // adapter is a shell over the same executeRoute, so this is inherited rather than duplicated.
    const { buildMcpTools } = await import('../../src/mcp/tools');
    const [tool] = buildMcpTools([
      defineRoute({
        method: 'GET',
        path: '/api/mcp-reads',
        permission: 'authenticated',
        input: z.object({}),
        handler: async (ctx) => ctx.db.notes.list({ limit: 5 }),
      }),
    ]);
    const result = await tool?.invoke(ARMED, principal, {});
    expect(result?.isError).toBeUndefined();
    const [row] = await rows();
    expect(row).toMatchObject({
      kind: 'd1',
      source: 'notes',
      query_name: 'list',
      route: 'GET /api/mcp-reads',
      principal: USERS.admin,
    });
  });
});
