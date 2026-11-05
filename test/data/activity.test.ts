import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isReservedIdentifier } from '../../src/auth/serviceNamespace';
import { makeDb } from '../../src/data';
import {
  ACTIVITY_WINDOW_DAYS,
  type ActivityDigest,
  anomaliesFor,
  REGISTRY_ACTIVITY_STREAMS,
  SERVICE_ACTOR_SQL,
  splitForRegistry,
  windowDays,
} from '../../src/data/activity';
import type { Env } from '../../src/env';
import { applySchema, seedDb } from '../helpers/db';

// Synthetic identities only — kit-wide hard rule, and the whole point of the privacy pins below
// is that none of these strings can reach the payload.
const ALICE = 'alice@test.example';
const BOB = 'bob@test.example';
const READER = 'reader@test.example';

const activity = () => makeDb(env as Env).activity;

async function auditRow(actor: string, action: string, agoDays = 0): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (actor_email, action, created_at) VALUES (?, ?, datetime('now', ?))",
  )
    .bind(actor, action, `-${agoDays} days`)
    .run();
}

async function aiRow(actor: string, model: string, agoDays = 0): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO ai_usage (actor_email, model, cost_usd, created_at) VALUES (?, ?, 0.01, datetime('now', ?))",
  )
    .bind(actor, model, `-${agoDays} days`)
    .run();
}

let readSeq = 0;
async function readRow(
  principal: string,
  view: string,
  opts: { agoDays?: number; rowCount?: number | null } = {},
): Promise<void> {
  readSeq += 1;
  await env.DB.prepare(
    `INSERT INTO read_log (id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, row_count, created_at)
     VALUES (?, 'req', ?, 'my-app', 'test', 'GET /api/x', 'aurora', 'clientdb', 'client', ?, 'q', ?, datetime('now', ?))`,
  )
    .bind(
      `r${readSeq}`,
      principal,
      view,
      opts.rowCount === undefined ? 1 : opts.rowCount,
      `-${opts.agoDays ?? 0} days`,
    )
    .run();
}

/** A d1-stream row: no view, the repository name in `source` and the method in `query_name`. */
async function d1ReadRow(
  principal: string,
  repo: string,
  method: string,
  opts: { rowCount?: number | null } = {},
): Promise<void> {
  readSeq += 1;
  await env.DB.prepare(
    `INSERT INTO read_log (id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, row_count)
     VALUES (?, 'req', ?, 'my-app', 'test', 'GET /api/y', 'd1', ?, 'internal', NULL, ?, ?)`,
  )
    .bind(`r${readSeq}`, principal, repo, method, opts.rowCount === undefined ? 1 : opts.rowCount)
    .run();
}

/** An upstream-stream row (PIA C15): no view, the source and read id, a declared target NAME. */
async function upstreamReadRow(
  principal: string,
  source: string,
  read: string,
  opts: { rowCount?: number | null; target?: string } = {},
): Promise<void> {
  readSeq += 1;
  await env.DB.prepare(
    `INSERT INTO read_log (id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, target, row_count)
     VALUES (?, 'req', ?, 'my-app', 'test', 'GET /api/reports/:ticketKey/data', 'upstream', ?, 'client', NULL, ?, ?, ?)`,
  )
    .bind(
      `r${readSeq}`,
      principal,
      source,
      read,
      opts.target ?? 'ticket_key',
      opts.rowCount === undefined ? 1 : opts.rowCount,
    )
    .run();
}

function pick(digests: ActivityDigest[], stream: string, day: string): ActivityDigest | undefined {
  return digests.find((d) => d.stream === stream && d.day === day);
}

const TODAY = () => new Date().toISOString().slice(0, 10);

describe('activity repo — daily digests', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('reports every day of the window for every stream, zero-filled', async () => {
    // Silence has to arrive as a NUMBER, for the same reason ai_spend_30d reports 0 rather than
    // null: an absent row is indistinguishable from an app that never reported, and "this app
    // went quiet" is precisely the fleet signal the digests exist to carry.
    const digests = await activity().dailyDigests();
    const days = windowDays(ACTIVITY_WINDOW_DAYS);
    expect(days).toHaveLength(ACTIVITY_WINDOW_DAYS);
    // All six streams: `read_log.kind` ships with K2b, so reads_d1 is reported from day one, and
    // read_log accepts upstream rows once 0005 has run (PIA C15), so reads_upstream is too.
    expect(digests).toHaveLength(ACTIVITY_WINDOW_DAYS * 6);
    expect(digests.every((d) => d.events === 0 && d.actors === 0)).toBe(true);
    expect([...new Set(digests.map((d) => d.stream))].sort()).toEqual([
      'ai',
      'auth',
      'reads_aurora',
      'reads_d1',
      'reads_upstream',
      'writes',
    ]);
  });

  it('stays inside every bound the registry enforces on one report', async () => {
    // The registry caps a report's `activity[]` at 40 digest rows, 20 top entries, 20 anomalies,
    // and requires (day, stream) to be unique — a duplicate pair is REPLACED, not summed, so a
    // violation would silently understate the app's volume. The five pinned streams x this window
    // must fit; `reads_upstream` rides its own block (splitForRegistry) and is bounded the same way.
    const digests = await activity().dailyDigests();
    const { activity: pinned, upstream } = splitForRegistry(digests);
    expect(ACTIVITY_WINDOW_DAYS * REGISTRY_ACTIVITY_STREAMS.length).toBeLessThanOrEqual(40);
    expect(pinned.length).toBeLessThanOrEqual(40);
    expect(upstream.length).toBeLessThanOrEqual(40);
    expect(pinned.length + upstream.length).toBe(digests.length);
    const pairs = digests.map((d) => `${d.day}/${d.stream}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const d of digests) {
      expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A real calendar day, and never in the future: the registry rejects both, and a fake
      // day would outlive its own retention sweep.
      expect(new Date(`${d.day}T00:00:00Z`).toISOString().slice(0, 10)).toBe(d.day);
      expect(d.day <= TODAY()).toBe(true);
      expect(d.top?.length ?? 0).toBeLessThanOrEqual(20);
      expect(d.anomalies?.length ?? 0).toBeLessThanOrEqual(20);
      for (const t of d.anomalies ?? []) expect(t.length).toBeLessThanOrEqual(64);
      for (const t of d.top ?? []) expect(t.name.length).toBeLessThanOrEqual(120);
    }
  });

  it('splits audit_log into auth events and application writes', async () => {
    // A login storm must not read as a busy Tuesday. `events` alone cannot tell them apart.
    await auditRow(ALICE, 'note.create');
    await auditRow(ALICE, 'note.update');
    await auditRow(BOB, 'login');
    await auditRow(BOB, 'magic_link_sent');
    await auditRow(BOB, 'magic_link_refused');
    const digests = await activity().dailyDigests();
    expect(pick(digests, 'writes', TODAY())?.events).toBe(2);
    expect(pick(digests, 'auth', TODAY())?.events).toBe(3);
  });

  it('actors is a DISTINCT COUNT of people, never a list of them', async () => {
    await auditRow(ALICE, 'note.create');
    await auditRow(ALICE, 'note.update');
    await auditRow(BOB, 'note.create');
    const writes = pick(await activity().dailyDigests(), 'writes', TODAY());
    expect(writes?.events).toBe(3);
    expect(writes?.actors).toBe(2);
  });

  it('top carries PREDICATE names — audit verbs, models, declared views — highest first', async () => {
    await auditRow(ALICE, 'note.create');
    await auditRow(BOB, 'note.create');
    await auditRow(ALICE, 'note.delete');
    await aiRow(ALICE, 'claude-sonnet-4-6');
    await readRow(READER, 'clients.company_summary');
    const digests = await activity().dailyDigests();
    expect(pick(digests, 'writes', TODAY())?.top).toEqual([
      { name: 'note.create', count: 2 },
      { name: 'note.delete', count: 1 },
    ]);
    expect(pick(digests, 'ai', TODAY())?.top).toEqual([{ name: 'claude-sonnet-4-6', count: 1 }]);
    expect(pick(digests, 'reads_aurora', TODAY())?.top).toEqual([
      { name: 'clients.company_summary', count: 1 },
    ]);
  });

  it('keeps at most five top names, breaking ties by name so a re-report is byte-identical', async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await auditRow(ALICE, `verb.${n}`);
    await auditRow(ALICE, 'verb.a'); // one clear winner, six tied at 1
    const first = pick(await activity().dailyDigests(), 'writes', TODAY());
    expect(first?.top).toHaveLength(5);
    expect(first?.top?.[0]).toEqual({ name: 'verb.a', count: 2 });
    // Deterministic ordering matters beyond tidiness: anything downstream that diffs two
    // reports would read a reshuffled tie as a change.
    const second = pick(await activity().dailyDigests(), 'writes', TODAY());
    expect(JSON.stringify(second?.top)).toBe(JSON.stringify(first?.top));
  });

  it('attributes rows to the UTC day they happened on, and drops anything older than the window', async () => {
    await auditRow(ALICE, 'note.create', 0);
    await auditRow(ALICE, 'note.create', 3);
    await auditRow(ALICE, 'note.create', 30); // outside the window entirely
    const digests = await activity().dailyDigests();
    const days = windowDays(ACTIVITY_WINDOW_DAYS);
    expect(pick(digests, 'writes', days[days.length - 1]!)?.events).toBe(1);
    expect(pick(digests, 'writes', days[days.length - 4]!)?.events).toBe(1);
    expect(digests.filter((d) => d.stream === 'writes').reduce((n, d) => n + d.events, 0)).toBe(2);
  });

  it('the SQL filter and the emitted days share ONE boundary — the oldest window day is inclusive', async () => {
    // The filter binds `windowDays(days)[0]` rather than letting SQLite evaluate its own
    // `date('now', '-6 days')`. Two independent clock reads could straddle a UTC midnight and
    // shift the windows apart by a day; in the direction that hurts, the oldest day is emitted
    // with events: 0 despite having had activity — and the registry REPLACES on (app, day,
    // stream), so that zero overwrites a complete day already reported.
    const days = windowDays(ACTIVITY_WINDOW_DAYS);
    await auditRow(ALICE, 'note.create', ACTIVITY_WINDOW_DAYS - 1); // exactly the oldest day
    await auditRow(ALICE, 'note.create', ACTIVITY_WINDOW_DAYS); // one day before it
    const digests = await activity().dailyDigests();
    expect(pick(digests, 'writes', days[0]!)?.events).toBe(1);
    expect(digests.filter((d) => d.stream === 'writes').reduce((n, d) => n + d.events, 0)).toBe(1);
  });

  it('an aurora row reports as reads_aurora and never leaks into reads_d1', async () => {
    // Lumping the two together would be permanent: the registry stores digests and not rows, so
    // D1 traffic mixed into the stream that exists to watch CLIENT-data access can never be
    // separated out again.
    await readRow(READER, 'clients.company_summary');
    const digests = await activity().dailyDigests();
    expect(pick(digests, 'reads_d1', TODAY())?.events).toBe(0);
    expect(pick(digests, 'reads_aurora', TODAY())?.events).toBe(1);
    expect(pick(digests, 'reads_aurora', TODAY())?.actors).toBe(1);
  });

  it('flags a day whose write-ahead read intents never got their count patched', async () => {
    await readRow(READER, 'clients.company_summary', { rowCount: null });
    await readRow(READER, 'clients.company_summary', { rowCount: 4 });
    const today = pick(await activity().dailyDigests(), 'reads_aurora', TODAY());
    expect(today?.events).toBe(2);
    expect(today?.anomalies).toEqual(['attempted_uncounted']);
  });

  it('flags an auth day where refusals outnumber logins', async () => {
    await auditRow(BOB, 'login');
    await auditRow(BOB, 'magic_link_refused');
    await auditRow(BOB, 'magic_link_refused');
    expect(pick(await activity().dailyDigests(), 'auth', TODAY())?.anomalies).toEqual([
      'refusals_exceed_logins',
    ]);
  });

  it('does not flag a healthy auth day', async () => {
    await auditRow(BOB, 'login');
    await auditRow(BOB, 'login');
    await auditRow(BOB, 'magic_link_refused');
    expect(pick(await activity().dailyDigests(), 'auth', TODAY())?.anomalies).toBeUndefined();
  });

  it('truncates a top NAME to the registry’s 120 characters instead of 400-ing the whole report', async () => {
    // The one place app-controlled text reaches the payload: a fork defines its own view names
    // and audit verbs. The registry's `name: z.string().max(120)` rejects the ENTIRE ingest —
    // status, health and manifest with it — so an over-long name would silently take the app out
    // of the fleet catalogue every day. Trimmed, not dropped: the name is still recognisable.
    const long = `clients.${'x'.repeat(200)}`;
    await readRow(READER, long);
    const top = pick(await activity().dailyDigests(), 'reads_aurora', TODAY())?.top;
    expect(top?.[0]?.name).toHaveLength(120);
    expect(top?.[0]?.name).toBe(long.slice(0, 120));
    expect(top?.[0]?.count).toBe(1);
  });

  it('anomaly flags read past the reported top five — they are fed the FULL name list', () => {
    // `dailyDigests` computes flags BEFORE capping `top`, and this is the hazard that ordering
    // avoids. `refusals_exceed_logins` looks up two specific auth verbs by name, so handed the
    // already-truncated five it would go silent the moment a fork adds a fourth and fifth auth
    // verb — no error, no signal, on exactly the busy days it exists for. Not reachable end-to-end
    // today (the kit defines exactly three auth actions, so nothing can be truncated out of
    // reach), so what is pinned here is the difference the ordering makes, not an app-level
    // repro: full list versus the same list cut to five.
    const busy = [
      { name: 'sso_denied', count: 40 },
      { name: 'session_revoked', count: 30 },
      { name: 'token_refresh', count: 20 },
      { name: 'magic_link_sent', count: 10 },
      { name: 'device_trusted', count: 8 },
      { name: 'magic_link_refused', count: 5 }, // 6th — outside any top-5
      { name: 'login', count: 1 }, // 7th
    ];
    expect(anomaliesFor('auth', busy, 0)).toEqual(['refusals_exceed_logins']);
    // …and the same list truncated to five, which is what the buggy ordering would have passed,
    // cannot see either verb and stays silent. That difference IS the regression.
    expect(anomaliesFor('auth', busy.slice(0, 5), 0)).toEqual([]);
  });

  it('anomaliesFor is a pure function of counts — it never sees an identity', () => {
    expect(anomaliesFor('writes', [{ name: 'note.create', count: 99 }], 0)).toEqual([]);
    expect(anomaliesFor('auth', [{ name: 'magic_link_refused', count: 1 }], 0)).toEqual([
      'refusals_exceed_logins',
    ]);
    expect(anomaliesFor('auth', undefined, 0)).toEqual([]);
    expect(anomaliesFor('reads_aurora', undefined, 3)).toEqual(['attempted_uncounted']);
  });

  // ---- THE PRIVACY INVARIANT ----------------------------------------------------------------

  it('NO actor email and NO record identifier survives into a digest, on any stream', async () => {
    // The absolute line: actor emails and record identifiers never leave the app. Asserted over
    // the serialized digests rather than field by field, so a NEW field carrying an identity
    // fails this test the day it is added — which is the only version of this check that keeps
    // working as the shape grows.
    await auditRow(ALICE, 'note.create');
    await auditRow(BOB, 'login');
    await aiRow(ALICE, 'claude-sonnet-4-6');
    await readRow(READER, 'clients.company_summary', { rowCount: 7 });
    const serialized = JSON.stringify(await activity().dailyDigests());
    for (const identity of [ALICE, BOB, READER, 'test.example', '@']) {
      expect(serialized).not.toContain(identity);
    }
    // The read ledger's own identifier columns are equally out of bounds: `principal` is the
    // reader, `target` is the DECLARED record projection, and `request_id` correlates one call.
    for (const column of ['principal', 'target', 'request_id', 'actor_email', 'query_name']) {
      expect(serialized).not.toContain(column);
    }
    // Every key on every digest comes from a closed set. Nothing else may appear.
    const allowed = ['day', 'stream', 'events', 'actors', 'top', 'anomalies'];
    for (const d of await activity().dailyDigests()) {
      expect(Object.keys(d).filter((k) => !allowed.includes(k))).toEqual([]);
      expect(typeof d.actors).toBe('number');
    }
  });
});

describe('activity repo — the two read streams split on read_log.kind (K2b)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('splits the two read streams on kind, and never lumps D1 reads in with Aurora ones', async () => {
    await readRow(READER, 'clients.summary');
    await d1ReadRow(ALICE, 'notes', 'list');
    await d1ReadRow(BOB, 'notes', 'list');
    const digests = await activity().dailyDigests();
    expect(pick(digests, 'reads_aurora', TODAY())?.events).toBe(1);
    expect(pick(digests, 'reads_d1', TODAY())?.events).toBe(2);
    expect(pick(digests, 'reads_d1', TODAY())?.actors).toBe(2);
    expect(digests).toHaveLength(ACTIVITY_WINDOW_DAYS * 6);
    // What the report sends as `activity[]` stays inside the registry's 40-row cap.
    expect(splitForRegistry(digests).activity).toHaveLength(ACTIVITY_WINDOW_DAYS * 5);
    expect(JSON.stringify(digests)).not.toContain(ALICE);
  });

  // A d1 row has NO view (the column is nullable precisely for it), and the top-name projection
  // has to survive that. Without a COALESCE the d1 half of the union yields a NULL name, which is
  // not a cosmetic problem: indexTop calls .slice() on it and the WHOLE daily report throws —
  // status, health and manifest with it. Both forms stay PREDICATES, never a supplied value.
  it('names a d1 read by repository.method, an aurora read by its declared view', async () => {
    await readRow(READER, 'clients.summary');
    await d1ReadRow(ALICE, 'users', 'getActive');
    await d1ReadRow(BOB, 'notes', 'list');
    await d1ReadRow(BOB, 'notes', 'list');
    const digests = await activity().dailyDigests();
    expect(pick(digests, 'reads_aurora', TODAY())?.top).toEqual([
      { name: 'clients.summary', count: 1 },
    ]);
    expect(pick(digests, 'reads_d1', TODAY())?.top).toEqual([
      { name: 'notes.list', count: 2 },
      { name: 'users.getActive', count: 1 },
    ]);
    // …and nothing anywhere in the payload is null-shaped or an identity.
    const serialized = JSON.stringify(digests);
    expect(serialized).not.toContain('null');
    expect(serialized).not.toContain(ALICE);
    expect(serialized).not.toContain(BOB);
  });

  it('flags a d1 day whose reads rejected, separately from the aurora stream', async () => {
    // A rejected repository call records row_count NULL — "attempted, outcome unknown", the same
    // meaning an unpatched write-ahead intent carries. The flag has to land on the stream it
    // happened in, or an operator chases a client-data incident that was a D1 blip.
    await d1ReadRow(ALICE, 'notes', 'list', { rowCount: null });
    await readRow(READER, 'clients.summary');
    const digests = await activity().dailyDigests();
    expect(pick(digests, 'reads_d1', TODAY())?.anomalies).toEqual(['attempted_uncounted']);
    expect(pick(digests, 'reads_aurora', TODAY())?.anomalies).toBeUndefined();
  });
});

describe('activity repo — the upstream stream is its own (PIA C15)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  // Hardcoded on purpose, like the permission matrix: this is the registry's `z.enum` today
  // (CialDNB/app-registry src/data/ledger.ts ACTIVITY_STREAMS). A stream added here without the
  // registry learning it first would 400 every report — so changing it is a conscious edit.
  it('the registry-pinned streams are exactly the five the registry ingests', () => {
    expect([...REGISTRY_ACTIVITY_STREAMS]).toEqual([
      'writes',
      'reads_d1',
      'reads_aurora',
      'auth',
      'ai',
    ]);
  });

  it('an upstream read reports as reads_upstream, and never inside reads_aurora or reads_d1', async () => {
    await upstreamReadRow(READER, 'autobahn', 'report_datablocks');
    await upstreamReadRow(ALICE, 'autobahn', 'report_by_duns', { target: 'duns' });
    await readRow(BOB, 'clients.summary');
    const digests = await activity().dailyDigests();
    expect(pick(digests, 'reads_upstream', TODAY())?.events).toBe(2);
    expect(pick(digests, 'reads_upstream', TODAY())?.actors).toBe(2);
    expect(pick(digests, 'reads_aurora', TODAY())?.events).toBe(1);
    expect(pick(digests, 'reads_d1', TODAY())?.events).toBe(0);
  });

  it('names an upstream read by source.read — never by its target, never by a value', async () => {
    await upstreamReadRow(READER, 'autobahn', 'report_datablocks');
    await upstreamReadRow(READER, 'autobahn', 'report_datablocks');
    await upstreamReadRow(ALICE, 'stats_bureau', 'series_by_id', { target: 'series_id' });
    const digests = await activity().dailyDigests();
    expect(pick(digests, 'reads_upstream', TODAY())?.top).toEqual([
      { name: 'autobahn.report_datablocks', count: 2 },
      { name: 'stats_bureau.series_by_id', count: 1 },
    ]);
    const serialized = JSON.stringify(digests);
    for (const absent of [READER, ALICE, 'ticket_key', 'series_id', 'null']) {
      expect(serialized).not.toContain(absent);
    }
  });

  it('flags an upstream day with uncounted write-ahead intents, on that stream alone', async () => {
    await upstreamReadRow(READER, 'autobahn', 'report_datablocks', { rowCount: null });
    await readRow(BOB, 'clients.summary');
    const digests = await activity().dailyDigests();
    expect(pick(digests, 'reads_upstream', TODAY())?.anomalies).toEqual(['attempted_uncounted']);
    expect(pick(digests, 'reads_aurora', TODAY())?.anomalies).toBeUndefined();
  });

  it('splitForRegistry keeps reads_upstream out of activity[] and in its own list', async () => {
    await upstreamReadRow(READER, 'autobahn', 'report_datablocks');
    const { activity: pinned, upstream } = splitForRegistry(await activity().dailyDigests());
    expect(pinned).toHaveLength(ACTIVITY_WINDOW_DAYS * 5);
    expect(
      pinned.every((d) => (REGISTRY_ACTIVITY_STREAMS as readonly string[]).includes(d.stream)),
    ).toBe(true);
    expect(upstream).toHaveLength(ACTIVITY_WINDOW_DAYS);
    expect(upstream.every((d) => d.stream === 'reads_upstream')).toBe(true);
    expect(upstream.find((d) => d.day === TODAY())?.events).toBe(1);
  });

  it('a stream name the registry does not know goes in neither list', () => {
    const odd = [{ day: TODAY(), stream: 'agent' as never, events: 1, actors: 1 }];
    expect(splitForRegistry(odd)).toEqual({ activity: [], upstream: [] });
  });
});

describe('activity repo — a database without 0005 (upstream adoption lag)', () => {
  beforeAll(applySchema);

  // The code is newer than the schema: read_log still refuses kind='upstream', so a client-class
  // upstream read is refused and an internal one goes unrecorded. `reads_upstream: 0` would then
  // be a claim the ledger cannot back — the stream is left out, and the next report fills it in.
  it('omits reads_upstream while read_log cannot hold an upstream row, and reports the rest', async () => {
    await seedDb();
    await env.DB.prepare('DROP TABLE read_log').run();
    await env.DB.prepare(
      `CREATE TABLE read_log (
         id TEXT PRIMARY KEY, request_id TEXT NOT NULL, principal TEXT NOT NULL, app TEXT NOT NULL,
         env TEXT NOT NULL, route TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'aurora' CHECK (kind IN ('aurora', 'd1')),
         source TEXT NOT NULL, source_class TEXT NOT NULL, view TEXT, query_name TEXT, target TEXT,
         row_count INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
         CHECK (kind = 'd1' OR (view IS NOT NULL AND query_name IS NOT NULL)))`,
    ).run();
    try {
      await d1ReadRow(ALICE, 'notes', 'list');
      const digests = await activity().dailyDigests();
      expect(digests.some((d) => d.stream === 'reads_upstream')).toBe(false);
      expect(digests).toHaveLength(ACTIVITY_WINDOW_DAYS * 5);
      expect(pick(digests, 'reads_d1', TODAY())?.events).toBe(1);
    } finally {
      await env.DB.prepare('DROP TABLE read_log').run();
      await applySchema();
    }
  });
});

describe('activity repo — an app that has not applied 0002 yet (adoption lag)', () => {
  beforeAll(applySchema);

  // The runtime probe K1 shipped. The kit's own migration lands `kind` before the Worker that
  // needs it (CI migrates, THEN deploys), but a fork adopting the kit renumbers migrations by
  // hand, so a window where the code is newer than the schema is real. Reporting everything as
  // reads_aurora during that window is the safe arm: a missing stream is a gap the next report
  // fills, a corrupted one is permanent.
  it('reports everything as reads_aurora and omits reads_d1 while the column is absent', async () => {
    await seedDb();
    // Rebuild read_log in its pre-K2b shape. Storage is per FILE, so this DDL is undone
    // explicitly at the end rather than left to leak into a later test.
    await env.DB.prepare('DROP TABLE read_log').run();
    await env.DB.prepare(
      `CREATE TABLE read_log (
         id TEXT PRIMARY KEY, request_id TEXT NOT NULL, principal TEXT NOT NULL, app TEXT NOT NULL,
         env TEXT NOT NULL, route TEXT NOT NULL, source TEXT NOT NULL, source_class TEXT NOT NULL,
         view TEXT NOT NULL, query_name TEXT NOT NULL, target TEXT, row_count INTEGER,
         created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ).run();
    try {
      await env.DB.prepare(
        `INSERT INTO read_log (id, request_id, principal, app, env, route, source, source_class, view, query_name, row_count)
         VALUES ('old1','req',?,'my-app','test','GET /api/x','clientdb','client','clients.summary','q',1)`,
      )
        .bind(READER)
        .run();
      const digests = await activity().dailyDigests();
      expect(digests.some((d) => d.stream === 'reads_d1')).toBe(false);
      expect(digests).toHaveLength(ACTIVITY_WINDOW_DAYS * 4);
      expect(pick(digests, 'reads_aurora', TODAY())?.events).toBe(1);
      expect(pick(digests, 'reads_aurora', TODAY())?.top).toEqual([
        { name: 'clients.summary', count: 1 },
      ]);
    } finally {
      await env.DB.prepare('DROP TABLE read_log').run();
      await applySchema();
    }
  });
});

describe('activity repo — service identities are not write actors (machine read attribution)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  // Synthetic service identifiers, in the kit's reserved namespace (src/auth/serviceNamespace.ts).
  const ETL = 'svc-etl@my-app.invalid';
  const CRM = 'svc-crm@my-app.invalid';

  it('the writes stream counts a service’s rows as EVENTS but not as an ACTOR', async () => {
    await auditRow('system@cron', 'cron_heartbeat_done');
    await auditRow(ETL, 'batch.push');
    await auditRow(ETL, 'batch.push');
    await auditRow(CRM, 'batch.push');
    const writes = pick(await activity().dailyDigests(), 'writes', TODAY());
    expect(writes?.events).toBe(4);
    expect(writes?.actors).toBe(1); // system@cron alone
    expect(writes?.top).toEqual([
      { name: 'batch.push', count: 3 },
      { name: 'cron_heartbeat_done', count: 1 },
    ]);
  });

  it('people and the app’s own system identities still count', async () => {
    await auditRow('system@cron', 'cron_heartbeat_done');
    await auditRow('system', 'audit_watch_run');
    await auditRow(ETL, 'batch.push');
    await auditRow(ALICE, 'note.create');
    const writes = pick(await activity().dailyDigests(), 'writes', TODAY());
    expect(writes?.events).toBe(4);
    expect(writes?.actors).toBe(3);
  });

  it('the auth stream is untouched: its actors are counted exactly as before', async () => {
    // No service signs in; the refusal row names a fixed placeholder. Whatever lands on the auth
    // stream keeps its plain DISTINCT count, a reserved-namespace address included.
    await auditRow(BOB, 'login');
    await auditRow('anonymous@refused', 'magic_link_refused');
    await auditRow('someone@my-app.invalid', 'magic_link_refused');
    const auth = pick(await activity().dailyDigests(), 'auth', TODAY());
    expect(auth?.events).toBe(3);
    expect(auth?.actors).toBe(3);
  });

  it('the SQL test agrees with isReservedIdentifier, address for address', async () => {
    const addresses = [
      ETL,
      'SVC-ETL@MY-APP.INVALID',
      'svc-etl@my-app.invalid.',
      'svc-etl@my-app.invalid..',
      ' svc-etl@my-app.invalid ',
      'svc-etl@deep.sub.my-app.invalid',
      'svc-etl@invalid',
      '@my-app.invalid',
      'a@b@my-app.invalid',
      // …and every near miss is NOT reserved, in both definitions:
      'svc-etl.invalid',
      'svc-etl@my-app.invalidx',
      'svc-etl@my-appinvalid',
      'svc-etl@invalid.example',
      'x.invalid@example.com',
      'svc-etl@my-app.invalid@example.com',
      'system@cron',
      'anonymous@refused',
      ALICE,
      '',
    ];
    for (const address of addresses) {
      const row = await env.DB.prepare(
        `SELECT ${SERVICE_ACTOR_SQL} AS reserved FROM (SELECT ?1 AS actor_email)`,
      )
        .bind(address)
        .first<{ reserved: number }>();
      expect({ address, reserved: row?.reserved === 1 }).toEqual({
        address,
        reserved: isReservedIdentifier(address),
      });
    }
  });
});
