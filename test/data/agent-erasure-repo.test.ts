// agentErasureRepo (src/data/agentErasure.ts): the count, locate, export, erase and prune half of the
// agent transcript store, for the DSR route (P2-7) and the retention sweep (P2-6). Pinned here:
//   - counts are each table's own rows, never a cascade's (D1's meta.changes counts cascaded rows,
//     shown below, so a parent-first delete would over-report to a data subject);
//   - an erase page is one transaction of at most 50 threads, every IN-list ≤ 50 parameters, and it
//     queues Workflow instance ids only for turns inside the purge window;
//   - the row-level sweep deletes children first against one fixed cutoff, chunked, under a pass
//     cap, and measures the backlog when the cap stops it;
//   - locate searches case-folded (accented capitals included) and JSON-escaped, and by
//     masked-token label; export pages whole threads and never carries an approval's arguments;
//   - writes are declared on the repository, not on the read ledger's global list.
// Every 64-hex value is built at run time (test/helpers/agentRows.ts says why).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeDb } from '../../src/data';
import {
  AGENT_ERASE_BATCH,
  AGENT_FIND_MAX_NEEDLES,
  AGENT_FIND_NEEDLE_CHARS,
  AGENT_PRUNE_CHUNK_ROWS,
  AGENT_PRUNE_MAX_PASSES,
  AGENT_SELECTOR_MAX_THREADS,
  type AgentRowCounts,
  agentErasureRepo,
} from '../../src/data/agentErasure';
import { repositoryDataClass } from '../../src/data/dataClass';
import { declaredWritesOf } from '../../src/data/declaredWrites';
import { WRITE_METHOD_NAMES } from '../../src/framework/readAudit';
import {
  addApproval,
  addFeedback,
  addFullThread,
  addMessage,
  addPurge,
  addThread,
  addTurn,
  at,
  countRows,
  T0,
} from '../helpers/agentRows';
import { applySchema, seedDb, USERS } from '../helpers/db';

// Bound once, by name: `npm run verify:core` traces repository calls through a binding like this
// one (`const x = agentErasureRepo(…)`), not through an arrow that returns a fresh repository.
const erasure = agentErasureRepo(env.DB);
const A = USERS.member;
const B = USERS.admin;
const ZERO: AgentRowCounts = { threads: 0, messages: 0, turns: 0, approvals: 0, feedback: 0 };

/**
 * A D1Database that records, per prepared statement, how many parameters were bound and the
 * longest `IN (…)` list in its SQL — the two numbers D1's 100-parameter ceiling and rule 2 bound.
 * Bound statements are the real ones, so `batch` takes them unchanged.
 */
function recordingDb(): { db: D1Database; seen: { params: number; inList: number }[] } {
  const seen: { params: number; inList: number }[] = [];
  const real = env.DB;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          const inList = Math.max(
            0,
            ...[...sql.matchAll(/\bIN \(((?:\?\d*, )*\?\d*)\)/g)].map(
              (m) => (m[1] ?? '').split(',').length,
            ),
          );
          return new Proxy(stmt, {
            get(s, p) {
              if (p === 'bind') {
                return (...args: unknown[]) => {
                  seen.push({ params: args.length, inList });
                  return s.bind(...args);
                };
              }
              const v = Reflect.get(s, p, s);
              return typeof v === 'function' ? v.bind(s) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db, seen };
}

/** `n` threads for `email`, each with one user message, in one batch. Returns the ids, sorted. */
async function manyThreads(n: number, email: string, prefix: string): Promise<string[]> {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(3, '0')}`);
  const thread = env.DB.prepare(
    'INSERT INTO agent_threads (id, user_email, created_at, last_message_at) VALUES (?, ?, ?, ?)',
  );
  const message = env.DB.prepare(
    "INSERT INTO agent_messages (id, thread_id, seq, role, state, content, created_at) VALUES (?, ?, 1, 'user', 'final', 'synthetic', ?)",
  );
  await env.DB.batch(
    ids.flatMap((id) => [thread.bind(id, email, T0, T0), message.bind(`m-${id}`, id, T0)]),
  );
  return ids.sort();
}

beforeAll(applySchema);
beforeEach(seedDb);

describe('the repository is a declared writer, forbidden to tools, and client-class', () => {
  it('declares exactly its three writes, none of them on the global WRITE_METHOD_NAMES', () => {
    const db = makeDb(env);
    expect([...declaredWritesOf(db.agentErasure)].sort()).toEqual([
      'eraseApprovalsByActor',
      'eraseThreads',
      'pruneTranscripts',
    ]);
    expect([...declaredWritesOf(db.agent)]).toEqual([]);
    for (const name of [
      ...declaredWritesOf(db.agentErasure),
      ...Object.keys(db.agent),
      ...Object.keys(db.agentErasure),
    ]) {
      expect(WRITE_METHOD_NAMES.has(name), name).toBe(false);
    }
  });

  it('both halves of the store are client-class: unlisted in dataClass.ts on purpose', () => {
    expect(repositoryDataClass('agent')).toBe('client');
    expect(repositoryDataClass('agentErasure')).toBe('client');
  });
});

describe('hasAnyRows and countFor — exact, never cascade-inflated', () => {
  it('hasAnyRows is false on an empty store and true with any transcript row', async () => {
    expect(await erasure.hasAnyRows()).toBe(false);
    await addThread();
    expect(await erasure.hasAnyRows()).toBe(true);
  });

  it('D1 counts cascaded rows in meta.changes — which is why every count here is explicit', async () => {
    const { threadId } = await addFullThread();
    const res = await env.DB.prepare('DELETE FROM agent_threads WHERE id = ?').bind(threadId).run();
    // One thread row — but the report includes its cascaded children.
    expect(res.meta.changes).toBeGreaterThan(1);
  });

  it('counts per table for a user, a subject and a list of threads', async () => {
    const a1 = await addFullThread({ user_email: A, subject_kind: 'company', subject_id: 'c-1' });
    const a2 = await addFullThread({ user_email: A });
    await addMessage(a2.threadId, { content: 'a third message' });
    const b1 = await addFullThread({ user_email: B, subject_kind: 'company', subject_id: 'c-1' });
    // An approval A acted on inside B's thread: reached by A's selector through the actor column.
    await addApproval(b1.threadId, {
      actor_email: A,
      status: 'expired',
      args_json: null,
      summary_json: null,
    });

    expect(await erasure.countFor({ kind: 'user', email: A })).toEqual({
      threads: 2,
      messages: 5,
      turns: 2,
      approvals: 3,
      feedback: 2,
    });
    // The selector folds case like users.email does.
    expect(await erasure.countFor({ kind: 'user', email: ' Alice@Test.Example ' })).toEqual(
      await erasure.countFor({ kind: 'user', email: A }),
    );
    expect(
      await erasure.countFor({ kind: 'subject', subjectKind: 'company', subjectId: 'c-1' }),
    ).toEqual({
      threads: 2,
      messages: 4,
      turns: 2,
      approvals: 3,
      feedback: 2,
    });
    expect(
      await erasure.countFor({
        kind: 'threads',
        threadIds: [a1.threadId, b1.threadId, a1.threadId, 'th-none'],
      }),
    ).toEqual({ threads: 2, messages: 4, turns: 2, approvals: 3, feedback: 2 });
    expect(await erasure.countFor({ kind: 'user', email: USERS.viewer })).toEqual(ZERO);
  });

  it('a user selector reaches both stored forms of a non-ASCII address, by thread and by actor', async () => {
    // SQLite's lower() in the CHECK folds ASCII only, so a row may hold 'Élise@…' as well as the
    // fully folded 'élise@…' every kit writer stores. An erasure must reach both.
    const folded = 'élise@test.example'; // JS toLowerCase(): what users.ts stores
    const asciiOnly = 'Élise@test.example'; // what lower() alone admits
    const t1 = await addFullThread({ user_email: folded });
    const t2 = await addFullThread({ user_email: asciiOnly });
    const other = await addFullThread({ user_email: B });
    await addApproval(other.threadId, {
      actor_email: asciiOnly,
      status: 'expired',
      args_json: null,
      summary_json: null,
    });
    const sel = { kind: 'user', email: 'ÉLISE@TEST.EXAMPLE' } as const;
    expect(await erasure.countFor(sel)).toEqual({
      threads: 2,
      messages: 4,
      turns: 2,
      approvals: 3,
      feedback: 2,
    });
    expect(await erasure.threadIdsFor(sel, null, 10)).toEqual([t1.threadId, t2.threadId].sort());
    const exported = (await erasure.exportPage(sel, null, 10)).threads;
    expect(Object.fromEntries(exported.map((t) => [t.threadId, t.userEmail]))).toEqual({
      [t1.threadId]: folded,
      [t2.threadId]: asciiOnly,
    });
    expect(await erasure.eraseApprovalsByActor(sel.email)).toBe(3);
    expect(await countRows('agent_approvals', 'actor_email = ?', B)).toBe(1);
  });

  it('a threads selector of 100 ids is counted in IN-lists of at most 50; 101 is refused', async () => {
    const ids = await manyThreads(AGENT_SELECTOR_MAX_THREADS, A, 'th-cnt');
    const { db, seen } = recordingDb();
    expect((await agentErasureRepo(db).countFor({ kind: 'threads', threadIds: ids })).threads).toBe(
      100,
    );
    expect(seen.length).toBe(2);
    for (const s of seen) {
      expect(s.inList).toBeLessThanOrEqual(AGENT_ERASE_BATCH);
      expect(s.params).toBeLessThanOrEqual(100);
    }
    await expect(
      erasure.countFor({ kind: 'threads', threadIds: [...ids, 'th-one-more'] }),
    ).rejects.toThrow(RangeError);
  });

  it('malformed selectors throw without echoing the value', async () => {
    const secret = 'not-an-email-but-personal';
    await expect(erasure.countFor({ kind: 'user', email: secret })).rejects.toThrow(
      /needs an email address$/,
    );
    await expect(erasure.countFor({ kind: 'user', email: secret })).rejects.not.toThrow(
      new RegExp(secret),
    );
    await expect(
      erasure.countFor({ kind: 'subject', subjectKind: 'Company', subjectId: 'c-1' }),
    ).rejects.toThrow(TypeError);
    await expect(erasure.countFor({ kind: 'threads', threadIds: ['bad id'] })).rejects.toThrow(
      /malformed thread id$/,
    );
    await expect(erasure.countFor({ kind: 'nope' } as never)).rejects.toThrow(/unknown selector/);
  });
});

describe('threadIdsFor — erase pages in id order', () => {
  it('pages a user’s threads 50 at a time, after a cursor', async () => {
    const ids = await manyThreads(55, A, 'th-page');
    await manyThreads(3, B, 'th-other');
    const first = await erasure.threadIdsFor({ kind: 'user', email: A }, null, AGENT_ERASE_BATCH);
    expect(first).toEqual(ids.slice(0, 50));
    const rest = await erasure.threadIdsFor(
      { kind: 'user', email: A },
      first[49] ?? null,
      AGENT_ERASE_BATCH,
    );
    expect(rest).toEqual(ids.slice(50));
    expect(await erasure.threadIdsFor({ kind: 'user', email: A }, ids[54] ?? null, 10)).toEqual([]);
    await expect(erasure.threadIdsFor({ kind: 'user', email: A }, null, 51)).rejects.toThrow(
      RangeError,
    );
    await expect(erasure.threadIdsFor({ kind: 'user', email: A }, null, 0)).rejects.toThrow(
      RangeError,
    );
    await expect(erasure.threadIdsFor({ kind: 'user', email: A }, 'bad cursor', 5)).rejects.toThrow(
      TypeError,
    );
  });

  it('a threads selector yields only threads that exist, across its 50-id chunks', async () => {
    const ids = await manyThreads(60, A, 'th-sel');
    const asked = [...ids, ...Array.from({ length: 40 }, (_, i) => `th-zz-missing-${i}`)];
    const page1 = await erasure.threadIdsFor({ kind: 'threads', threadIds: asked }, null, 50);
    expect(page1).toEqual(ids.slice(0, 50));
    const page2 = await erasure.threadIdsFor(
      { kind: 'threads', threadIds: asked },
      page1[49] ?? null,
      50,
    );
    expect(page2).toEqual(ids.slice(50));
  });

  it('a subject selector pages too', async () => {
    const t1 = await addThread({ subject_kind: 'company', subject_id: 'c-9' });
    await addThread({ subject_kind: 'company', subject_id: 'c-8' });
    expect(
      await erasure.threadIdsFor(
        { kind: 'subject', subjectKind: 'company', subjectId: 'c-9' },
        null,
        50,
      ),
    ).toEqual([t1]);
  });
});

describe('eraseThreads — one transaction per page of ≤ 50, children first', () => {
  it('returns exactly what countFor reported, leaves others intact, and erasing again finds nothing', async () => {
    const doomed = await addFullThread({ user_email: A });
    const kept = await addFullThread({ user_email: B });
    const before = await erasure.countFor({ kind: 'threads', threadIds: [doomed.threadId] });
    const erased = await erasure.eraseThreads([doomed.threadId], {
      queuePurgesCreatedSinceIso: at(-8),
      nowIso: at(1),
    });
    expect(erased).toEqual(before);
    expect(erased).toEqual({ threads: 1, messages: 2, turns: 1, approvals: 1, feedback: 1 });
    expect(await erasure.countFor({ kind: 'threads', threadIds: [doomed.threadId] })).toEqual(ZERO);
    expect(await erasure.countFor({ kind: 'threads', threadIds: [kept.threadId] })).toEqual(before);
    expect(
      await erasure.eraseThreads([doomed.threadId], {
        queuePurgesCreatedSinceIso: at(-8),
        nowIso: at(1),
      }),
    ).toEqual(ZERO);
    expect(
      await erasure.eraseThreads([], { queuePurgesCreatedSinceIso: at(-8), nowIso: at(1) }),
    ).toEqual(ZERO);
  });

  it('queues purge ids only for turns created inside the window, once each, with the erase time', async () => {
    const threadId = await addThread();
    const recent = await addTurn(threadId, { status: 'done', created_at: at(-2) });
    const old = await addTurn(threadId, { status: 'done', created_at: at(-9) });
    const boundary = await addTurn(threadId, { status: 'done', created_at: at(-8) });
    const otherThread = await addThread();
    const elsewhere = await addTurn(otherThread, { status: 'done', created_at: at(-1) });

    await erasure.eraseThreads([threadId], { queuePurgesCreatedSinceIso: at(-8), nowIso: at(0.5) });
    const queued = await env.DB.prepare(
      'SELECT run_id, queued_at, attempts FROM agent_instance_purges ORDER BY run_id',
    ).all();
    expect(queued.results).toEqual(
      [boundary, recent].sort().map((run_id) => ({ run_id, queued_at: at(0.5), attempts: 0 })),
    );
    expect(queued.results.map((r) => r.run_id)).not.toContain(old);
    expect(queued.results.map((r) => r.run_id)).not.toContain(elsewhere);

    // A run id already queued (an earlier attempt, a retry) is kept exactly as it was: the insert
    // skips it rather than failing the page or resetting its attempts.
    const retried = await addThread();
    const retriedTurn = await addTurn(retried, { status: 'done', created_at: at(-1) });
    await addPurge(retriedTurn, { queued_at: at(-1), attempts: 3, last_error_code: 1101 });
    await erasure.eraseThreads([retried], { queuePurgesCreatedSinceIso: at(-8), nowIso: at(0.6) });
    expect(
      await env.DB.prepare(
        'SELECT queued_at, attempts, last_error_code FROM agent_instance_purges WHERE run_id = ?',
      )
        .bind(retriedTurn)
        .first(),
    ).toEqual({ queued_at: at(-1), attempts: 3, last_error_code: 1101 });
    expect(await countRows('agent_threads', 'id = ?', retried)).toBe(0);
  });

  it('erases 50 threads in one batch with IN-lists of at most 50 and ≤ 100 parameters; 51 is refused', async () => {
    const ids = await manyThreads(50, A, 'th-erase');
    const { db, seen } = recordingDb();
    const erased = await agentErasureRepo(db).eraseThreads(ids, {
      queuePurgesCreatedSinceIso: at(-8),
      nowIso: at(1),
    });
    expect(erased).toEqual({ threads: 50, messages: 50, turns: 0, approvals: 0, feedback: 0 });
    expect(seen.length).toBe(6);
    for (const s of seen) {
      expect(s.inList).toBe(50);
      expect(s.params).toBeLessThanOrEqual(100);
    }
    await expect(
      erasure.eraseThreads([...ids, 'th-51'], {
        queuePurgesCreatedSinceIso: at(-8),
        nowIso: at(1),
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      erasure.eraseThreads(['th-1'], { queuePurgesCreatedSinceIso: '2026-10-01', nowIso: at(1) }),
    ).rejects.toThrow(/queuePurgesCreatedSinceIso/);
    await expect(
      erasure.eraseThreads(['th-1'], { queuePurgesCreatedSinceIso: at(-8), nowIso: 'yesterday' }),
    ).rejects.toThrow(/nowIso/);
    // The shape, but not a day: Date.parse rolls these over (to 2 March, 1 May) and the columns'
    // strftime CHECK refuses them, so the guard refuses them too.
    for (const impossible of ['2026-02-30T10:00:00.000Z', '2026-04-31T00:00:00.000Z']) {
      await expect(
        erasure.eraseThreads(['th-1'], { queuePurgesCreatedSinceIso: impossible, nowIso: at(1) }),
      ).rejects.toThrow(/queuePurgesCreatedSinceIso/);
      await expect(
        erasure.eraseThreads(['th-1'], { queuePurgesCreatedSinceIso: at(-8), nowIso: impossible }),
      ).rejects.toThrow(/nowIso/);
    }
  });

  // The purge insert skips only a run id already queued (ON CONFLICT (run_id) DO NOTHING). INSERT
  // OR IGNORE, the design's wording, also skips a row that breaks a CHECK, silently, and the
  // DELETEs in the same batch would then commit: threads erased with no Workflow instance queued
  // for purge, reported as success. The guard and the CHECK agree today, so this database makes
  // them disagree: it binds an impossible date where the repository bound `nowIso`.
  it('a purge row the CHECK refuses fails the whole page: never skipped while the erase commits', async () => {
    const threadId = await addThread();
    await addTurn(threadId, { status: 'done', created_at: at(-1) });
    const nowIso = at(0.5);
    const lenient = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes('INTO agent_instance_purges')) return stmt;
            return new Proxy(stmt, {
              get(s, p) {
                if (p === 'bind') {
                  return (...args: unknown[]) =>
                    s.bind(...args.map((a) => (a === nowIso ? '2026-02-30T10:00:00.000Z' : a)));
                }
                const v = Reflect.get(s, p, s);
                return typeof v === 'function' ? v.bind(s) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await expect(
      agentErasureRepo(lenient).eraseThreads([threadId], {
        queuePurgesCreatedSinceIso: at(-8),
        nowIso,
      }),
    ).rejects.toThrow(/CHECK constraint failed: queued_at/);
    expect(await countRows('agent_threads', 'id = ?', threadId)).toBe(1);
    expect(await countRows('agent_turns', 'thread_id = ?', threadId)).toBe(1);
    expect(await countRows('agent_instance_purges')).toBe(0);
  });

  it('a page is all or nothing: one failing statement rolls the whole batch back', async () => {
    const { threadId } = await addFullThread();
    await env.DB.prepare(
      "CREATE TRIGGER test_block_thread_delete BEFORE DELETE ON agent_threads BEGIN SELECT RAISE(ABORT, 'blocked for the test'); END",
    ).run();
    try {
      await expect(
        erasure.eraseThreads([threadId], { queuePurgesCreatedSinceIso: at(-8), nowIso: at(1) }),
      ).rejects.toThrow(/blocked for the test/);
      expect(await erasure.countFor({ kind: 'threads', threadIds: [threadId] })).toEqual({
        threads: 1,
        messages: 2,
        turns: 1,
        approvals: 1,
        feedback: 1,
      });
      expect(await countRows('agent_instance_purges')).toBe(0);
    } finally {
      await env.DB.prepare('DROP TRIGGER test_block_thread_delete').run();
    }
  });
});

describe('eraseApprovalsByActor — the PIA §7.4 approvals statement', () => {
  it('removes every approval the person acted on, in any thread, and nothing else', async () => {
    const a = await addFullThread({ user_email: A });
    const b = await addFullThread({ user_email: B });
    await addApproval(b.threadId, {
      actor_email: A,
      status: 'expired',
      args_json: null,
      summary_json: null,
    });
    expect(await erasure.eraseApprovalsByActor('ALICE@test.example')).toBe(2);
    expect(await countRows('agent_approvals', 'actor_email = ?', A)).toBe(0);
    expect(await countRows('agent_approvals', 'actor_email = ?', B)).toBe(1);
    expect(await countRows('agent_messages', 'thread_id = ?', a.threadId)).toBe(2);
  });
});

describe('findThreads — the PIA §7.3 locate', () => {
  it('finds as written, lowercased, JSON-escaped, and by masked-token label, across every content column', async () => {
    const inContent = await addThread();
    await addMessage(inContent, { content: 'Report for Acme Ltda, please' });
    const inMeta = await addThread();
    await addMessage(inMeta, {
      role: 'assistant',
      content: 'done',
      meta_json: JSON.stringify({
        intents: [{ type: 'ui_prefill', text: 'She said "Acme Ltda" twice' }],
      }),
    });
    const inPending = await addThread();
    await addTurn(inPending, {
      status: 'running',
      pending_json: JSON.stringify({ transcript: 'holder [CPF#1] of record' }),
      pending_expires_at: at(0.01),
    });
    const inEvents = await addThread();
    await addTurn(inEvents, {
      status: 'running',
      events_json: JSON.stringify([{ delta: 'acme ltda again' }]),
    });
    const inArgs = await addThread();
    await addApproval(inArgs, { args_json: JSON.stringify({ name: 'ACME LTDA' }) });
    const inCard = await addThread();
    await addApproval(inCard, {
      summary_json: JSON.stringify({ key: 'k', params: { who: 'Acme Ltda' } }),
    });
    const nowhere = await addThread();
    await addMessage(nowhere, { content: 'unrelated' });

    const found = await erasure.findThreads({ needles: ['Acme Ltda'], tokenLabels: [] });
    expect(found.map((f) => f.threadId).sort()).toEqual(
      [inArgs, inCard, inContent, inEvents, inMeta].sort(),
    );

    // A quote is stored escaped in a JSON column; the escaped form is searched too.
    expect(await erasure.findThreads({ needles: ['said "Acme'], tokenLabels: [] })).toEqual([
      { threadId: inMeta, hits: 1 },
    ]);
    // A masked token is found by its label.
    expect(await erasure.findThreads({ needles: [], tokenLabels: ['CPF'] })).toEqual([
      { threadId: inPending, hits: 1 },
    ]);
    expect(await erasure.findThreads({ needles: [], tokenLabels: ['RUT'] })).toEqual([]);
  });

  it('finds a name whatever the case of its accented letters: João / JOÃO, Muñoz / MUÑOZ', async () => {
    // SQLite's lower() folds ASCII only, credit-bureau payloads print names in capitals, and
    // pt/es names carry accents: a needle folded the same way as the column misses 'JOÃO' for
    // 'João' in either direction. Content stored in one case throughout is found either way.
    const capitals = await addThread();
    await addMessage(capitals, { content: 'JOÃO DA CONCEIÇÃO, CPF [CPF#1]' });
    const lowercase = await addThread();
    await addMessage(lowercase, { content: 'relatório de joão da conceição' });
    const inMeta = await addThread();
    await addMessage(inMeta, {
      role: 'assistant',
      content: 'done',
      meta_json: JSON.stringify({ intents: [{ type: 'ui_prefill', text: 'Sra. Muñoz' }] }),
    });
    const inPending = await addThread();
    await addTurn(inPending, {
      status: 'running',
      pending_json: JSON.stringify({ transcript: 'TITULAR MUÑOZ, RUT [RUT#1]' }),
      pending_expires_at: at(0.01),
    });
    const elsewhere = await addThread();
    await addMessage(elsewhere, { content: 'unrelated' });
    const found = async (needle: string) =>
      (await erasure.findThreads({ needles: [needle], tokenLabels: [] }))
        .map((f) => f.threadId)
        .sort();

    for (const needle of ['João da Conceição', 'JOÃO DA CONCEIÇÃO', 'joão da conceição']) {
      expect(await found(needle), needle).toEqual([capitals, lowercase].sort());
    }
    for (const needle of ['Muñoz', 'MUÑOZ', 'muñoz']) {
      expect(await found(needle), needle).toEqual([inMeta, inPending].sort());
    }
  });

  it('counts one hit per matching row per needle, most hits first', async () => {
    const busy = await addThread();
    await addMessage(busy, { content: 'needle-one and needle-two' });
    await addMessage(busy, { content: 'needle-one again' });
    const quiet = await addThread();
    await addMessage(quiet, { content: 'needle-two only' });
    expect(
      await erasure.findThreads({
        needles: ['needle-one', 'needle-two', 'needle-one'],
        tokenLabels: [],
      }),
    ).toEqual([
      { threadId: busy, hits: 3 },
      { threadId: quiet, hits: 1 },
    ]);
  });

  it('bounds its input and never echoes a needle in an error', async () => {
    const needle = 'private-needle';
    const tooMany = Array.from({ length: AGENT_FIND_MAX_NEEDLES + 1 }, (_, i) => `${needle}-${i}`);
    await expect(erasure.findThreads({ needles: tooMany, tokenLabels: [] })).rejects.toThrow(
      RangeError,
    );
    await expect(erasure.findThreads({ needles: ['ab'], tokenLabels: [] })).rejects.toThrow(
      RangeError,
    );
    await expect(
      erasure.findThreads({
        needles: ['x'.repeat(AGENT_FIND_NEEDLE_CHARS.max + 1)],
        tokenLabels: [],
      }),
    ).rejects.toThrow(RangeError);
    await expect(erasure.findThreads({ needles: [], tokenLabels: ['cpf'] })).rejects.toThrow(
      TypeError,
    );
    await expect(erasure.findThreads({ needles: [], tokenLabels: [] })).rejects.toThrow(
      /nothing to find/,
    );
    await expect(erasure.findThreads({ needles: tooMany, tokenLabels: [] })).rejects.not.toThrow(
      new RegExp(needle),
    );
  });
});

describe('exportPage — whole threads, paged, never an approval’s arguments', () => {
  it('pages 50 threads at a time with a cursor, and the last page says so', async () => {
    const ids = await manyThreads(55, A, 'th-exp');
    const first = await erasure.exportPage({ kind: 'user', email: A }, null, 50);
    expect(first.threads.map((t) => t.threadId)).toEqual(ids.slice(0, 50));
    expect(first.nextAfterId).toBe(ids[49]);
    const second = await erasure.exportPage({ kind: 'user', email: A }, first.nextAfterId, 50);
    expect(second.threads.map((t) => t.threadId)).toEqual(ids.slice(50));
    expect(second.nextAfterId).toBeNull();
    const exact = await erasure.exportPage({ kind: 'user', email: A }, null, 55 - 50 + 45);
    expect(exact.threads).toHaveLength(50);
    expect(await erasure.exportPage({ kind: 'user', email: USERS.viewer }, null, 50)).toEqual({
      threads: [],
      nextAfterId: null,
    });
    await expect(erasure.exportPage({ kind: 'user', email: A }, null, 51)).rejects.toThrow(
      RangeError,
    );
  });

  it('carries messages with provenance, approval outcomes and ratings — and no arguments or card', async () => {
    const threadId = await addThread({ user_email: A, subject_kind: 'company', subject_id: 'c-1' });
    const turnId = 'turn-export';
    const q = await addMessage(threadId, {
      turn_id: turnId,
      content: 'what changed?',
      created_at: T0,
    });
    const r = await addMessage(threadId, {
      turn_id: turnId,
      role: 'assistant',
      content: 'the score moved',
      meta_json: JSON.stringify({ provenance: ['get_companies_by_id'] }),
      created_at: at(0.001),
    });
    await addApproval(threadId, {
      turn_id: turnId,
      args_json: JSON.stringify({ secretArgument: 'ARG-VALUE-NOT-EXPORTED' }),
      summary_json: JSON.stringify({ key: 'k', params: { card: 'CARD-VALUE-NOT-EXPORTED' } }),
    });
    await addFeedback(threadId, r, { rating: -1 });

    const page = await erasure.exportPage({ kind: 'threads', threadIds: [threadId] }, null, 50);
    expect(page.nextAfterId).toBeNull();
    const [thread] = page.threads;
    expect(thread).toMatchObject({
      threadId,
      userEmail: A,
      subject: { kind: 'company', id: 'c-1' },
      createdAt: T0,
      lastMessageAt: T0,
    });
    expect(thread?.messages.map((m) => [m.id, m.role, m.state, m.content, m.meta])).toEqual([
      [q, 'user', 'final', 'what changed?', null],
      [r, 'assistant', 'final', 'the score moved', { provenance: ['get_companies_by_id'] }],
    ]);
    expect(thread?.approvals).toHaveLength(1);
    expect(Object.keys(thread?.approvals[0] ?? {}).sort()).toEqual(
      ['consumedAt', 'createdAt', 'decidedAt', 'id', 'status', 'toolName'].sort(),
    );
    expect(thread?.feedback).toEqual([{ messageId: r, rating: -1, createdAt: T0, updatedAt: T0 }]);
    const text = JSON.stringify(page);
    expect(text).not.toContain('ARG-VALUE-NOT-EXPORTED');
    expect(text).not.toContain('CARD-VALUE-NOT-EXPORTED');
  });
});

describe('pruneTranscripts — the row-level retention sweep (PIA C1)', () => {
  const CUTOFF = at(-30);
  const OLD = at(-40);
  const NEW = at(-1);

  it('deletes every row older than the cutoff, children first; a thread goes only once old and empty', async () => {
    // A thread entirely past the cutoff: everything goes, thread included. Built old from the
    // start (a final message is never edited, so its time cannot be moved afterwards).
    const oldThread = await addThread({ created_at: OLD, last_message_at: OLD });
    const oldTurn = await addTurn(oldThread, { status: 'done', created_at: OLD });
    const oldQ = await addMessage(oldThread, { turn_id: oldTurn, created_at: OLD });
    const oldR = await addMessage(oldThread, {
      turn_id: oldTurn,
      role: 'assistant',
      created_at: OLD,
    });
    await addApproval(oldThread, {
      turn_id: oldTurn,
      status: 'denied',
      args_json: null,
      summary_json: null,
      created_at: OLD,
    });
    await addFeedback(oldThread, oldR, { created_at: OLD, updated_at: OLD });

    // A thread in use: its old rows go, its new rows and the thread stay.
    const live = await addThread({ created_at: OLD, last_message_at: NEW });
    const liveOldMsg = await addMessage(live, { created_at: OLD });
    const liveOldReply = await addMessage(live, { role: 'assistant', created_at: OLD });
    // Feedback given recently on an old message goes with the message it rates.
    await addFeedback(live, liveOldReply, { created_at: NEW, updated_at: NEW });
    const liveNewMsg = await addMessage(live, { created_at: NEW });

    // An old message of a turn still running is never pruned, nor its thread.
    const busy = await addThread({ created_at: OLD, last_message_at: OLD });
    const running = await addTurn(busy, { status: 'running', created_at: OLD });
    const runningMsg = await addMessage(busy, { turn_id: running, created_at: OLD });

    const result = await erasure.pruneTranscripts(CUTOFF);
    expect(result).toEqual({
      deleted: { feedback: 2, messages: 4, approvals: 1, turns: 1, threads: 1 },
      passes: 5,
      drained: true,
      overdueDays: null,
    });
    expect(await countRows('agent_threads', 'id = ?', oldThread)).toBe(0);
    expect(
      await countRows('agent_messages', 'id IN (?, ?, ?, ?)', oldQ, oldR, liveOldMsg, liveOldReply),
    ).toBe(0);
    expect(await countRows('agent_threads', 'id = ?', live)).toBe(1);
    expect(await countRows('agent_messages', 'id = ?', liveNewMsg)).toBe(1);
    expect(await countRows('agent_messages', 'id = ?', runningMsg)).toBe(1);
    expect(await countRows('agent_turns', 'id = ?', running)).toBe(1);
    expect(await countRows('agent_threads', 'id = ?', busy)).toBe(1);
    expect(await countRows('agent_feedback')).toBe(0);

    // Idempotent: a second run against the same cutoff finds nothing.
    expect((await erasure.pruneTranscripts(CUTOFF)).deleted).toEqual(ZERO);
  });

  // Step 5 takes a thread only when it is old AND holds nothing, and each child table is its own
  // guard. Without one, an old thread whose only row in that table is still young would be deleted,
  // its cascade would take the young row early, and the run would count it as a thread.
  it('an old thread whose one child is younger than the cutoff stays, whichever table it is in', async () => {
    const YOUNG = at(-29);
    const CHILD: Record<string, (threadId: string) => Promise<unknown>> = {
      agent_messages: (t) => addMessage(t, { created_at: YOUNG }),
      agent_turns: (t) => addTurn(t, { status: 'done', created_at: YOUNG }),
      agent_approvals: (t) =>
        addApproval(t, {
          status: 'denied',
          args_json: null,
          summary_json: null,
          created_at: YOUNG,
        }),
      agent_feedback: (t) =>
        addFeedback(t, 'msg-rated-elsewhere', { created_at: YOUNG, updated_at: YOUNG }),
    };
    for (const [table, addChild] of Object.entries(CHILD)) {
      const threadId = await addThread({ created_at: OLD, last_message_at: OLD });
      await addChild(threadId);
      const result = await erasure.pruneTranscripts(CUTOFF);
      expect(result, table).toEqual({ deleted: ZERO, passes: 5, drained: true, overdueDays: null });
      expect(await countRows('agent_threads', 'id = ?', threadId), table).toBe(1);
      expect(await countRows(table, 'thread_id = ?', threadId), table).toBe(1);
    }
  });

  it('chunks each step and stops at the pass cap, measuring how overdue the oldest waiting row is', async () => {
    const threadId = await addThread({ created_at: at(-50), last_message_at: at(-50) });
    for (let i = 0; i < 7; i++) await addMessage(threadId, { created_at: at(-50 + i) });

    // chunk 2, cap 3: pass 1 is feedback (nothing due), passes 2 and 3 take the four oldest
    // messages (-50 … -47), and the cap stops the run with three messages still due.
    const capped = await erasure.pruneTranscripts(CUTOFF, { chunk: 2, maxPasses: 3 });
    expect(capped.deleted).toEqual({ ...ZERO, messages: 4 });
    expect(capped.passes).toBe(3);
    expect(capped.drained).toBe(false);
    // The oldest row still due is the message at -46: 16 days past the -30 cutoff. (The thread is
    // older, but not due: it still holds messages.)
    expect(capped.overdueDays).toBeCloseTo(16, 5);

    const rest = await erasure.pruneTranscripts(CUTOFF, {
      chunk: 2,
      maxPasses: AGENT_PRUNE_MAX_PASSES,
    });
    expect(rest.deleted).toEqual({ ...ZERO, messages: 3, threads: 1 });
    expect(rest.drained).toBe(true);
    expect(rest.overdueDays).toBeNull();
    expect(await countRows('agent_threads')).toBe(0);
  });

  it('a cap that lands exactly on the last due row reports drained', async () => {
    const threadId = await addThread({ created_at: NEW, last_message_at: NEW });
    await addMessage(threadId, { created_at: OLD });
    await addMessage(threadId, { created_at: OLD });
    // Pass 1 feedback (none), pass 2 deletes both messages (a full chunk of 2) and the cap stops it.
    const result = await erasure.pruneTranscripts(CUTOFF, { chunk: 2, maxPasses: 2 });
    expect(result).toEqual({
      deleted: { ...ZERO, messages: 2 },
      passes: 2,
      drained: true,
      overdueDays: null,
    });
  });

  it('refuses a cutoff or a bound it cannot honour', async () => {
    await expect(erasure.pruneTranscripts('2026-10-01 00:00:00')).rejects.toThrow(/cutoffIso/);
    await expect(erasure.pruneTranscripts('2026-02-30T10:00:00.000Z')).rejects.toThrow(/cutoffIso/);
    await expect(erasure.pruneTranscripts('2026-13-01T00:00:00.000Z')).rejects.toThrow(/cutoffIso/);
    await expect(erasure.pruneTranscripts(CUTOFF, { chunk: 0 })).rejects.toThrow(RangeError);
    await expect(erasure.pruneTranscripts(CUTOFF, { maxPasses: 1.5 })).rejects.toThrow(RangeError);
    expect(AGENT_PRUNE_CHUNK_ROWS).toBe(500);
    expect(AGENT_PRUNE_MAX_PASSES).toBe(40);
  });
});
