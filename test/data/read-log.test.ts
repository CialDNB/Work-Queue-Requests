// The read ledger's storage layer. Two things are being pinned here and they are different in
// kind: the repository behaves correctly, AND the table cannot be made to hold what it must never
// hold. The second is the one that matters in a year — it is the test a "just log the SQL for
// debugging" patch has to argue with.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeDb } from '../../src/data';
import { type ReadLogIntent, readLogRepo } from '../../src/data/readLog';
import { applySchema, migrationBySlug, seedDb, USERS } from '../helpers/db';

// Bound directly rather than behind a factory arrow: the repository closes over env.DB, which is
// stable for the whole file, and this is the shape the protected-core reachability scanner reads
// as a call site. A `() => readLogRepo(...)` wrapper made three real methods look dead.
const repo = readLogRepo(env.DB);

let seq = 0;
function intent(over: Partial<ReadLogIntent> = {}): ReadLogIntent {
  seq += 1;
  return {
    id: `row-${seq}`,
    request_id: 'req-1',
    principal: USERS.member,
    app: 'test-app',
    env: 'test',
    route: 'GET /api/namespace-usage',
    source: 'ret1_ro',
    source_class: 'internal',
    view: 'app_ro.v_namespace_usage',
    query_name: 'listNamespaceUsage',
    target: null,
    ...over,
  };
}

async function row(id: string) {
  return env.DB.prepare('SELECT * FROM read_log WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
}

describe('read_log schema', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  // THE structural invariant (Decision D6). Not "we agreed not to log SQL" — there is nowhere to
  // put it. A patch that adds a column here fails this test in a CODEOWNERS-gated file, which is
  // the whole mechanism: the cost of recording a bound value is a reviewed schema change, not a
  // one-line convenience during a debugging session.
  it('has no column that could carry SQL text or bind values', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(read_log)').all<{ name: string }>();
    const names = columns.results.map((c) => c.name);
    expect(names).toEqual([
      'id',
      'request_id',
      'principal',
      'app',
      'env',
      'route',
      'kind',
      'source',
      'source_class',
      'view',
      'query_name',
      'target',
      'row_count',
      'created_at',
    ]);
    for (const forbidden of ['sql', 'params', 'query', 'bindings', 'args', 'statement', 'values']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('rejects a source_class outside client|internal', async () => {
    await expect(repo.insertIntent(intent({ source_class: 'sneaky' as never }))).rejects.toThrow();
  });

  // The migration and the fresh-install baseline have to agree, or an app provisioned today and an
  // app upgraded today diverge silently — and the divergence only shows up the first time someone
  // queries the ledger on one of them.
  it('the migration matches the baseline column-for-column', async () => {
    // By slug, not path: a fork renumbers the kit's 0001 (migrationBySlug, test/helpers/db.ts).
    const migration = migrationBySlug('read_log.sql').sql;
    for (const column of ['id', 'request_id', 'principal', 'source_class', 'row_count', 'target']) {
      expect(migration).toContain(column);
    }
    expect(migration).not.toMatch(/\b(sql|params)\b\s+TEXT/i);
    // Both halves carry the count-patch trigger; a migration that dropped it would leave upgraded
    // apps with a rewritable ledger while fresh ones are protected.
    expect(migration).toContain('read_log_count_patch_only');
    expect(migration).toContain('read_log_no_replace');
  });

  // 0002 is a TABLE REBUILD (SQLite has no ALTER COLUMN, and `view`/`query_name` had to lose
  // NOT NULL). A rebuild that forgets to reinstate the indexes or the triggers leaves an upgraded
  // app with a ledger that is rewritable and unindexed while a freshly provisioned one is neither
  // — and nobody notices until the first time someone queries it.
  it('the kind migration rebuilds the table WITH its indexes and triggers intact', async () => {
    const migration = migrationBySlug('read_log_kind.sql').sql;
    expect(migration).toMatch(/kind TEXT NOT NULL DEFAULT 'aurora'/);
    expect(migration).toMatch(/CHECK \(kind IN \('aurora', 'd1'\)\)/);
    // The aurora stream keeps K2a's guarantee through a conditional CHECK rather than NOT NULL.
    expect(migration).toMatch(/kind = 'd1' OR \(view IS NOT NULL AND query_name IS NOT NULL\)/);
    expect(migration).toContain('read_log_count_patch_only');
    expect(migration).toContain('read_log_no_replace');
    for (const index of ['idx_read_log_created', 'idx_read_log_principal', 'idx_read_log_source']) {
      expect(migration).toContain(index);
    }
    // `kind` joins the immutable-column list: rewriting which stream a read belongs to is as
    // forbidden as rewriting who performed it.
    expect(migration).toContain('NEW.kind IS NOT OLD.kind');
    expect(migration).not.toMatch(/\b(sql|params)\b\s+TEXT/i);
  });

  // The two streams are told apart by `kind`, and the constraint is what stops a private-database
  // read from being recorded as unattributable. Belongs in the schema, not in a code path a
  // future writer could skip.
  it('lets a d1 row omit the view, and refuses an aurora row that omits it', async () => {
    const d1 = intent({ kind: 'd1', source: 'notes', view: null, query_name: 'list' });
    await repo.insertComplete(d1, 3);
    const stored = await row(d1.id);
    expect(stored?.kind).toBe('d1');
    expect(stored?.view).toBe(null);

    await expect(repo.insertComplete(intent({ view: null }), 1)).rejects.toThrow();
    await expect(repo.insertComplete(intent({ query_name: null }), 1)).rejects.toThrow();
  });

  it('defaults an unlabelled row to the aurora stream — no backfill needed for K2a rows', async () => {
    // Every row written before K2b came from src/data/aurora.ts, so the column default is not a
    // guess. It is what makes 0002 a no-backfill migration.
    const i = intent();
    await repo.insertIntent(i);
    expect((await row(i.id))?.kind).toBe('aurora');
  });

  it('rejects a kind outside aurora|d1|upstream', async () => {
    // `view` deliberately left populated so the ONLY constraint that can fire is the kind CHECK —
    // a null view would also trip the aurora guard and the test would pass for the wrong reason.
    await expect(repo.insertComplete(intent({ kind: 'postgres' as never }), 1)).rejects.toThrow();
  });
});

describe('read_log batched insert (the d1 stream)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('writes many complete rows in one batch', async () => {
    await repo.insertManyComplete([
      {
        intent: intent({ kind: 'd1', source: 'notes', view: null, query_name: 'list' }),
        rowCount: 2,
      },
      {
        intent: intent({ kind: 'd1', source: 'users', view: null, query_name: 'getActive' }),
        rowCount: 1,
      },
      // A rejected read: NULL means ATTEMPTED, not empty.
      {
        intent: intent({ kind: 'd1', source: 'audit', view: null, query_name: 'list' }),
        rowCount: null,
      },
    ]);
    const page = await repo.list({ limit: 10 });
    expect(page.items).toHaveLength(3);
    expect(page.items.every((r) => r.kind === 'd1')).toBe(true);
    expect(page.items.map((r) => `${r.source}.${r.query_name}`).sort()).toEqual([
      'audit.list',
      'notes.list',
      'users.getActive',
    ]);
    expect((await repo.listAttempted(10)).map((r) => r.source)).toEqual(['audit']);
  });

  it('is a no-op on an empty list — a route that read nothing touches no binding', async () => {
    await repo.insertManyComplete([]);
    expect((await repo.list({ limit: 10 })).items).toHaveLength(0);
  });
});

describe('read_log append-only enforcement', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('allows exactly one row_count patch on a NULL row', async () => {
    const i = intent();
    await repo.insertIntent(i);
    expect((await row(i.id))?.row_count).toBe(null);

    expect(await repo.patchRowCount(i.id, 7)).toBe(true);
    expect((await row(i.id))?.row_count).toBe(7);
  });

  it('refuses to overwrite a count that already landed', async () => {
    const i = intent();
    await repo.insertIntent(i);
    await repo.patchRowCount(i.id, 7);

    // The repository's own `WHERE row_count IS NULL` makes this a no-op...
    expect(await repo.patchRowCount(i.id, 999)).toBe(false);
    // ...and the DB-layer trigger refuses it even for a caller that bypasses the repository,
    // which is the point: this holds against a holder of D1 credentials, not just against our code.
    await expect(
      env.DB.prepare('UPDATE read_log SET row_count = 999 WHERE id = ?').bind(i.id).run(),
    ).rejects.toThrow(/append-only/);
    expect((await row(i.id))?.row_count).toBe(7);
  });

  it('refuses to rewrite who read what', async () => {
    const i = intent();
    await repo.insertIntent(i);
    for (const sql of [
      "UPDATE read_log SET principal = 'someone.else@test.example' WHERE id = ?",
      "UPDATE read_log SET view = 'app_ro.v_innocent' WHERE id = ?",
      "UPDATE read_log SET target = 'something-else' WHERE id = ?",
      // 'client' because the fixture is 'internal': the trigger guards CHANGES, so setting a
      // column to the value it already holds is a no-op and legitimately passes. Downgrading the
      // class after the fact is the interesting attempt, and it is the one that must fail.
      "UPDATE read_log SET source_class = 'client' WHERE id = ?",
      "UPDATE read_log SET route = 'GET /api/harmless' WHERE id = ?",
    ]) {
      await expect(env.DB.prepare(sql).bind(i.id).run()).rejects.toThrow(/append-only/);
    }
    const after = await row(i.id);
    expect(after?.principal).toBe(USERS.member);
    expect(after?.view).toBe('app_ro.v_namespace_usage');
  });

  // D1 runs with recursive_triggers OFF, so a REPLACE's implicit delete would not fire the UPDATE
  // trigger — overwrite-by-id would sail past every guard above. Same hole audit_log closes.
  it('refuses to overwrite a row by id with INSERT OR REPLACE', async () => {
    const i = intent();
    await repo.insertIntent(i);
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO read_log (id, request_id, principal, app, env, route, source, source_class, view, query_name) VALUES (?, 'x', 'attacker@test.example', 'a', 'e', 'r', 's', 'internal', 'a.b', 'q')",
      )
        .bind(i.id)
        .run(),
    ).rejects.toThrow(/never overwritten/);
    expect((await row(i.id))?.principal).toBe(USERS.member);
  });
});

describe('readLog repository', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('is reachable on the shared data layer', () => {
    expect(typeof makeDb(env).readLog.insertIntent).toBe('function');
  });

  it('lowercases the principal, like every other actor column in the kit', async () => {
    const i = intent({ principal: 'MiXeD@Test.Example' });
    await repo.insertIntent(i);
    expect((await row(i.id))?.principal).toBe('mixed@test.example');
  });

  it('records a complete row in one write for the internal-class path', async () => {
    const i = intent({ target: 'client_code' });
    await repo.insertComplete(i, 3);
    const stored = await row(i.id);
    expect(stored?.row_count).toBe(3);
    expect(stored?.target).toBe('client_code');
  });

  // A zero result and an unrecorded outcome look the same to anyone who forgets the distinction,
  // and the distinction is the whole reason the write-ahead design exists.
  it('keeps "attempted" (NULL) apart from "empty" (0)', async () => {
    const attempted = intent();
    const empty = intent();
    await repo.insertIntent(attempted);
    await repo.insertComplete(empty, 0);

    const listed = await repo.listAttempted(10);
    expect(listed.map((r) => r.id)).toEqual([attempted.id]);
    expect((await row(empty.id))?.row_count).toBe(0);
  });

  it('groups every read made while serving one request', async () => {
    await repo.insertComplete(intent({ request_id: 'req-A', query_name: 'first' }), 1);
    await repo.insertComplete(intent({ request_id: 'req-A', query_name: 'second' }), 2);
    await repo.insertComplete(intent({ request_id: 'req-B', query_name: 'other' }), 3);

    const forA = await repo.listByRequest('req-A');
    expect(forA.map((r) => r.query_name).sort()).toEqual(['first', 'second']);
  });

  it('pages newest-first and emits no phantom trailing page', async () => {
    for (let n = 0; n < 3; n += 1) await repo.insertComplete(intent(), n);
    // Exactly-full final page: a bare LIMIT cursor would offer a next page that holds nothing.
    const full = await repo.list({ limit: 3 });
    expect(full.items).toHaveLength(3);
    expect(full.next_before).toBe(null);

    const first = await repo.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next_before).not.toBe(null);
  });

  // created_at has ONE-SECOND precision and a single request routinely makes several reads inside
  // one second, so this is the common case, not an exotic one. A created_at-only cursor returned
  // an EMPTY second page here and silently dropped three rows — on an audit surface, an operator
  // would have concluded two reads happened when five did.
  it('pages through rows that share a created_at second without dropping any', async () => {
    const stamp = '2026-08-20 04:03:39';
    for (let n = 0; n < 5; n += 1) {
      await env.DB.prepare(
        "INSERT INTO read_log (id, request_id, principal, app, env, route, source, source_class, view, query_name, row_count, created_at) VALUES (?, 'req', ?, 'test-app', 'test', 'GET /api/x', 'ret1_ro', 'internal', 'app_ro.v_x', 'q', 1, ?)",
      )
        .bind(`tie-${n}`, USERS.member, stamp)
        .run();
    }

    const seen: string[] = [];
    let cursor = (await repo.list({ limit: 2 })).next_before;
    seen.push(...(await repo.list({ limit: 2 })).items.map((r) => r.id));
    for (let page = 0; page < 5 && cursor; page += 1) {
      const next = await repo.list({ limit: 2, before: cursor });
      seen.push(...next.items.map((r) => r.id));
      cursor = next.next_before;
    }

    expect(seen.sort()).toEqual(['tie-0', 'tie-1', 'tie-2', 'tie-3', 'tie-4']);
    expect(cursor).toBe(null);
  });

  it('prunes rows past the retention horizon and keeps the rest', async () => {
    const fresh = intent();
    await repo.insertComplete(fresh, 1);
    // The old row is INSERTed with a backdated created_at rather than updated into the past: the
    // count-patch trigger rejects a created_at rewrite, which is itself the behaviour being relied
    // on everywhere else in this file.
    await env.DB.prepare(
      "INSERT INTO read_log (id, request_id, principal, app, env, route, source, source_class, view, query_name, row_count, created_at) VALUES ('ancient', 'req-old', ?, 'test-app', 'test', 'GET /api/x', 'ret1_ro', 'internal', 'app_ro.v_x', 'q', 1, datetime('now', '-90 days'))",
    )
      .bind(USERS.member)
      .run();

    expect(await repo.pruneOlderThan(60)).toEqual({ deleted: 1, passes: 1, drained: true });
    expect(await row('ancient')).toBe(null);
    expect(await row(fresh.id)).not.toBe(null);
  });

  // ── Chunked retention (insights D1 growth plan, B15) ──────────────────────────────────────
  // The prune used to be ONE unbounded `DELETE … WHERE created_at < …`. On a 60-day steady state
  // that is one day of rows, but the day someone shortens READ_LOG_RETENTION_DAYS (or the cron
  // misses a week) it becomes one statement over hundreds of thousands of rows — exactly the
  // statement that times out, and a timed-out retention delete deletes nothing: the task goes red
  // every night and the deletion promise is not kept. These tests force a tiny chunk so "more than
  // one chunk" is five rows, not five thousand.
  async function insertAged(id: string, daysOld: number) {
    await env.DB.prepare(
      "INSERT INTO read_log (id, request_id, principal, app, env, route, source, source_class, view, query_name, row_count, created_at) VALUES (?, 'req-old', ?, 'test-app', 'test', 'GET /api/x', 'ret1_ro', 'internal', 'app_ro.v_x', 'q', 1, datetime('now', ?))",
    )
      .bind(id, USERS.member, `-${daysOld} days`)
      .run();
  }

  /** env.DB with every prepared statement's SQL text recorded, so a test can see each pass. */
  function recordingDb(sink: string[]): D1Database {
    return new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            sink.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  async function remainingIds(): Promise<string[]> {
    const res = await env.DB.prepare('SELECT id FROM read_log ORDER BY id').all<{ id: string }>();
    return res.results.map((r) => r.id);
  }

  it('deletes a backlog larger than one chunk over several bounded passes', async () => {
    const fresh = intent();
    await repo.insertComplete(fresh, 1);
    for (let n = 1; n <= 5; n += 1) await insertAged(`old-${n}`, 90 + n);

    const sql: string[] = [];
    const result = await readLogRepo(recordingDb(sql)).pruneOlderThan(60, { chunkRows: 2 });

    // 5 eligible rows at 2 per pass: 2 + 2 + 1. The short third pass is what ends the loop.
    expect(result).toEqual({ deleted: 5, passes: 3, drained: true });
    expect(await remainingIds()).toEqual([fresh.id]);

    // Every DELETE is the bounded form. A regression to one unbounded statement would show up
    // here as a single DELETE with no LIMIT, even though it would delete the same five rows.
    const deletes = sql.filter((s) => /^\s*DELETE/i.test(s));
    expect(deletes).toHaveLength(3);
    for (const statement of deletes) {
      expect(statement).toMatch(/WHERE id IN \(SELECT id FROM read_log WHERE .+ LIMIT \?\)/);
    }
  });

  it('ends with one empty pass when the backlog is an exact multiple of the chunk', async () => {
    for (let n = 1; n <= 4; n += 1) await insertAged(`old-${n}`, 90 + n);

    // Two full passes cannot tell "done" from "more to come"; the third finds nothing and stops.
    expect(await repo.pruneOlderThan(60, { chunkRows: 2 })).toEqual({
      deleted: 4,
      passes: 3,
      drained: true,
    });
    expect(await remainingIds()).toEqual([]);
  });

  // The pass cap exists because the daily cron shares one invocation's D1 query budget with the
  // backup. A huge backlog should drain over a few nights, oldest first, rather than spend the
  // budget the heartbeat and the registry report still need.
  it('stops at the pass cap with the oldest rows gone, and the next run finishes', async () => {
    const fresh = intent();
    await repo.insertComplete(fresh, 1);
    // old-1 is the youngest eligible row (91 days), old-5 the oldest (95 days).
    for (let n = 1; n <= 5; n += 1) await insertAged(`old-${n}`, 90 + n);

    const capped = await repo.pruneOlderThan(60, { chunkRows: 2, maxPasses: 2 });
    expect(capped).toMatchObject({ deleted: 4, passes: 2, drained: false });
    // old-1 (91 days old) is still waiting: 31 days past the 60-day cutoff. The cron pages on
    // this number when it grows past READ_LOG_PRUNE_MAX_OVERDUE_DAYS (src/cron/prune.ts).
    expect(capped.overdueDays).toBeCloseTo(31, 1);
    expect(await remainingIds()).toEqual(['old-1', fresh.id].sort());

    const rest = await repo.pruneOlderThan(60, { chunkRows: 2, maxPasses: 2 });
    expect(rest).toEqual({ deleted: 1, passes: 1, drained: true });
    expect(await remainingIds()).toEqual([fresh.id]);
  });

  it('a capped run that happened to take the last eligible row reports drained', async () => {
    for (let n = 1; n <= 4; n += 1) await insertAged(`old-${n}`, 90 + n);

    // Both passes come back full, so the loop cannot tell "done" from "more to come"; the one
    // backlog read after the cap finds nothing older than the cutoff.
    expect(await repo.pruneOlderThan(60, { chunkRows: 2, maxPasses: 2 })).toEqual({
      deleted: 4,
      passes: 2,
      drained: true,
    });
  });

  // A zero chunk deletes nothing per pass and a zero cap never runs, so either one would turn the
  // retention task into a green no-op. A non-positive `days` is worse: it would "retain nothing".
  // All of them throw, which reds the cron task and sends the alert.
  it('refuses a retention window, chunk size or pass cap that is not a positive integer', async () => {
    await insertAged('old-1', 91);
    for (const days of [0, -1, 1.5, Number.NaN]) {
      await expect(repo.pruneOlderThan(days)).rejects.toThrow(RangeError);
    }
    for (const chunkRows of [0, -1, 2.5]) {
      await expect(repo.pruneOlderThan(60, { chunkRows })).rejects.toThrow(RangeError);
    }
    for (const maxPasses of [0, -1, 2.5]) {
      await expect(repo.pruneOlderThan(60, { maxPasses })).rejects.toThrow(RangeError);
    }
    expect(await remainingIds()).toEqual(['old-1']); // nothing was deleted on the way to a throw
  });
});
