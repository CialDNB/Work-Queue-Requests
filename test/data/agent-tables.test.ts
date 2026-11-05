// The agent transcript store's SHAPE (migrations/d1/0006_agent_tables.sql, kit 0006; found by slug,
// since a fork renumbers it). What is pinned, in order:
//
//   1. THE MIGRATION AND THE BASELINE ARE ONE TEXT. schema.sql carries the migration's statements
//      character for character, and a database the migration builds stores exactly the DDL a fresh
//      install stores (sqlite_master, compared as text). The file only creates, so it is a no-op on
//      a fresh install and safe to run twice.
//   2. ONE CASCADE PARENT. Only `agent_threads` is referenced, every FK cascades, nothing references
//      `users`; a child cannot exist without its thread, and a thread takes all of it when deleted.
//   3. THE PRIVACY RULES ARE THE DATABASE'S. No REPLACE, on any unique key (the partial indexes
//      included); no NULL primary key, and no status default a REPLACE could swap in for a NULL
//      after the triggers ran; every timestamp in the one shape the sweep and expiry compare; owner
//      and subject fixed; a final message is never edited; an approval only moves forward and holds
//      no arguments once denied, expired or consumed; a done turn is final, holds no session
//      pointer, in-flight events or unsettled spend, and its held transcript can only be taken; one
//      active turn and one live approval per thread — each refused by a CHECK, a trigger or a
//      unique index, not by application code. Where a trigger and a CHECK could both refuse, the
//      test names the trigger's message, so removing either one fails a test.
//   4. THE HARNESS RESETS IT. seedDb() empties every agent table, children first.
//
// Every 64-hex value is built at run time (test/helpers/agentRows.ts says why).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import schemaSql from '../../schema.sql?raw';
import { AGENT_TABLES, AGENT_TRIGGERS, agentRepo } from '../../src/data/agent';
import { agentErasureRepo } from '../../src/data/agentErasure';
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
  hex64,
  insertRow,
  nextId,
  T0,
} from '../helpers/agentRows';
import { applySchema, migrationBySlug, seedDb, statementsOf, USERS } from '../helpers/db';

const MIGRATION = migrationBySlug('agent_tables.sql');
const BLOCK_START = '-- ── agent_threads: the ONE cascade parent';
const BLOCK_END =
  'CREATE INDEX IF NOT EXISTS idx_agent_instance_purges_queued ON agent_instance_purges(queued_at);';
const CHILDREN = ['agent_messages', 'agent_turns', 'agent_approvals', 'agent_feedback'] as const;

/** The DDL block, from its first table banner to its last index, exactly as the file holds it. */
function ddlBlock(source: string, label: string): string {
  const start = source.indexOf(BLOCK_START);
  const end = source.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) throw new Error(`${label}: no agent DDL block`);
  if (source.indexOf(BLOCK_START, start + 1) !== -1) throw new Error(`${label}: two agent blocks`);
  return source.slice(start, end + BLOCK_END.length);
}

interface StoredObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** Every stored object on an agent_* table, as SQLite keeps it. */
async function agentObjects(): Promise<StoredObject[]> {
  const res = await env.DB.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name LIKE 'agent\\_%' ESCAPE '\\' ORDER BY type, name",
  ).all<StoredObject>();
  return res.results;
}

async function runMigration(): Promise<void> {
  for (const statement of statementsOf(MIGRATION.sql)) await env.DB.prepare(statement).run();
}

async function dropAgentTables(): Promise<void> {
  for (const table of AGENT_TABLES) await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
}

/** A content fingerprint of tables 0006 must never touch. */
async function untouched(): Promise<string> {
  const parts: unknown[] = [];
  for (const table of ['users', 'api_tokens', 'audit_log', 'read_log', 'notes']) {
    parts.push((await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results);
  }
  return JSON.stringify(parts);
}

beforeAll(applySchema);
beforeEach(seedDb);

// ── 1. ONE TEXT, TWO PATHS ─────────────────────────────────────────────────────────────────────

describe('0006_agent_tables: the migration and the baseline', () => {
  it('schema.sql carries the migration’s DDL block character for character', () => {
    const migrated = ddlBlock(MIGRATION.sql, MIGRATION.name);
    expect(ddlBlock(schemaSql, 'schema.sql')).toBe(migrated);
    expect(new Set(migrated.match(/(?<=CREATE TABLE IF NOT EXISTS )agent_\w+/g))).toEqual(
      new Set(AGENT_TABLES),
    );
  });

  it('only creates: every statement is IF NOT EXISTS, nothing alters, drops, inserts or replaces', () => {
    const statements = statementsOf(MIGRATION.sql);
    expect(statements.length).toBeGreaterThan(20);
    for (const s of statements) {
      expect(s, s.slice(0, 80)).toMatch(
        /^CREATE (?:TABLE IF NOT EXISTS agent_|(?:UNIQUE )?INDEX IF NOT EXISTS idx_agent_|TRIGGER IF NOT EXISTS agent_)/,
      );
    }
    // Comments stripped: no REPLACE, no conflict clause, no datetime() anywhere in a statement.
    expect(statements.join('\n')).not.toMatch(/\bON\s+CONFLICT\b|\bREPLACE\b|\bdatetime\s*\(/i);
  });

  it('a pre-0006 database, migrated by the file, stores exactly the fresh-install DDL', async () => {
    const fresh = await agentObjects();
    expect(
      fresh.filter((o) => o.type === 'table').map((o) => o.name),
      'agent_ is the kit store’s prefix: backups skip every agent_* table (src/data/backup.ts), ' +
        'so a table of your own named agent_* would never be backed up — rename it',
    ).toEqual([...AGENT_TABLES].sort());
    const before = await untouched();
    await dropAgentTables();
    expect(await agentObjects()).toEqual([]);

    await runMigration();
    expect(await agentObjects()).toEqual(fresh);
    expect(await untouched()).toBe(before);
    expect(await agentRepo(env.DB).schemaSupport()).toBe('accepted');
  });

  it('is a no-op on a fresh install — safe to run twice, rows kept', async () => {
    const fresh = await agentObjects();
    const { threadId } = await addFullThread();
    await runMigration();
    await runMigration();
    expect(await agentObjects()).toEqual(fresh);
    expect(await countRows('agent_threads', 'id = ?', threadId)).toBe(1);
    for (const child of CHILDREN) expect(await countRows(child), child).toBeGreaterThan(0);
  });

  it('has no title column, and timestamps are ISO-8601 with milliseconds, never datetime()', async () => {
    const cols = await env.DB.prepare('PRAGMA table_info(agent_threads)').all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual([
      'id',
      'user_email',
      'subject_kind',
      'subject_id',
      'created_at',
      'last_message_at',
    ]);
    await expect(addThread({ created_at: '2026-10-01 10:00:00' })).rejects.toThrow(/CHECK/);
    await expect(addThread({ last_message_at: '2026-10-01T10:00:00Z' })).rejects.toThrow(/CHECK/);
    await expect(addThread({ user_email: 'Alice@Test.Example' })).rejects.toThrow(/CHECK/);
    await expect(addThread({ subject_kind: 'company', subject_id: null })).rejects.toThrow(/CHECK/);
    await expect(addThread({ id: 'has space' })).rejects.toThrow(/CHECK/);
    await expect(addTurn(await addThread(), { id: '-leading-dash' })).rejects.toThrow(/CHECK/);
    await expect(addPurge('-leading-dash')).rejects.toThrow(/CHECK/);
  });

  // SQLite admits NULL in a PRIMARY KEY that is not an INTEGER PRIMARY KEY unless the column is also
  // NOT NULL, and an id CHECK passes a NULL (it evaluates to NULL). A NULL-id row escapes every
  // `id IN (SELECT id …)` the sweep deletes through, so its thread never empties and keeps its
  // owner's email; a NULL thread id makes every erase page of its owner throw.
  it('every primary key refuses NULL, under any conflict verb', async () => {
    const threadId = await addThread();
    const nullKey: Record<string, (verb: string) => Promise<unknown>> = {
      agent_threads: (verb) =>
        insertRow(
          'agent_threads',
          { id: null, user_email: USERS.member, created_at: T0, last_message_at: T0 },
          verb,
        ),
      agent_messages: (verb) =>
        insertRow(
          'agent_messages',
          {
            id: null,
            thread_id: threadId,
            seq: 1,
            role: 'user',
            state: 'final',
            content: 'x',
            created_at: T0,
          },
          verb,
        ),
      agent_turns: (verb) =>
        insertRow(
          'agent_turns',
          {
            id: null,
            thread_id: threadId,
            kind: 'message',
            reply_message_id: 'r-null',
            delivery: 'partial',
            status: 'done',
            outcome: 'completed',
            ended_at: T0,
            budget_settled_at: T0,
            budget_day: '2026-10-01',
            budget_reserved_usd: 0,
            created_at: T0,
          },
          verb,
        ),
      agent_approvals: async (verb) =>
        insertRow(
          'agent_approvals',
          {
            id: null,
            thread_id: threadId,
            turn_id: 'turn-null',
            actor_email: USERS.member,
            tool_name: 'post_notes',
            tool_use_id: 'toolu-null',
            args_sha256: await hex64('fixture-args-null'),
            status: 'denied',
            created_at: T0,
            expires_at: at(1),
          },
          verb,
        ),
      agent_feedback: (verb) =>
        insertRow(
          'agent_feedback',
          {
            id: null,
            thread_id: threadId,
            message_id: 'msg-null',
            rating: 1,
            created_at: T0,
            updated_at: T0,
          },
          verb,
        ),
      agent_instance_purges: (verb) =>
        insertRow('agent_instance_purges', { run_id: null, queued_at: T0 }, verb),
    };
    expect(Object.keys(nullKey).sort()).toEqual([...AGENT_TABLES].sort());
    for (const [table, insert] of Object.entries(nullKey)) {
      for (const verb of ['INSERT', 'INSERT OR REPLACE', 'REPLACE']) {
        await expect(insert(verb), `${verb} ${table}`).rejects.toThrow(
          new RegExp(`NOT NULL constraint failed: ${table}\\.(?:id|run_id)`),
        );
      }
      await insert('INSERT OR IGNORE'); // skipped, not written
    }
    for (const table of AGENT_TABLES) {
      const key = table === 'agent_instance_purges' ? 'run_id' : 'id';
      expect(await countRows(table, `${key} IS NULL`), table).toBe(0);
    }
  });

  // The sweep, the reaper and expiry compare these columns as TEXT against a toISOString() bound,
  // so a value of any other shape is never older than any cutoff: its row, and the thread under
  // it, would outlive the retention. Every one is refused unless it is exactly that shape.
  const STAMP_NOT_ISO = [
    'Sun Sep 20 2026 10:00:00 GMT', // Date.prototype.toString()
    '2026-10-01 10:00:00', // datetime('now')
    '2026-10-01T10:00:00Z', // no milliseconds
    '2026-10-01t10:00:00.000z', // lower case: LIKE would have let it through
    'zzzz-zz-zzTzz:zz:zz.zzzZ', // the shape, without the digits: LIKE's _ matches anything
    '2026-02-30T10:00:00.000Z', // not a day
    '2026-10-01T10:00:00.000+02:00', // an offset
    'yesterday',
    '',
  ];

  /** Per timestamp column: insert one otherwise-valid row with that column set to `value`. */
  const STAMPED: Record<string, (value: string) => Promise<unknown>> = {
    'agent_threads.created_at': (v) => addThread({ created_at: v }),
    'agent_threads.last_message_at': (v) => addThread({ last_message_at: v }),
    'agent_messages.created_at': async (v) => addMessage(await addThread(), { created_at: v }),
    'agent_turns.created_at': async (v) => addTurn(await addThread(), { created_at: v }),
    'agent_turns.started_at': async (v) =>
      addTurn(await addThread(), { status: 'running', started_at: v }),
    'agent_turns.heartbeat_at': async (v) =>
      addTurn(await addThread(), { status: 'running', heartbeat_at: v }),
    'agent_turns.pending_expires_at': async (v) =>
      addTurn(await addThread(), { status: 'running', pending_json: '{}', pending_expires_at: v }),
    'agent_turns.ended_at': async (v) =>
      addTurn(await addThread(), { status: 'done', ended_at: v }),
    'agent_turns.budget_settled_at': async (v) =>
      addTurn(await addThread(), { status: 'done', budget_settled_at: v }),
    'agent_approvals.created_at': async (v) => addApproval(await addThread(), { created_at: v }),
    'agent_approvals.expires_at': async (v) => addApproval(await addThread(), { expires_at: v }),
    'agent_approvals.decided_at': async (v) =>
      addApproval(await addThread(), {
        status: 'denied',
        args_json: null,
        summary_json: null,
        decided_at: v,
      }),
    'agent_approvals.consumed_at': async (v) =>
      addApproval(await addThread(), {
        status: 'consumed',
        args_json: null,
        summary_json: null,
        consumed_turn_id: 'turn-c',
        consumed_at: v,
      }),
    'agent_feedback.created_at': async (v) => {
      const threadId = await addThread();
      return addFeedback(threadId, await addMessage(threadId), { created_at: v });
    },
    'agent_feedback.updated_at': async (v) => {
      const threadId = await addThread();
      return addFeedback(threadId, await addMessage(threadId), { updated_at: v });
    },
    'agent_instance_purges.queued_at': (v) => addPurge(nextId('run'), { queued_at: v }),
  };

  it('every timestamp column holds exactly the toISOString() shape, or nothing else', async () => {
    // Complete: every *_at column of every agent table is listed above (a new one must join).
    const columns: string[] = [];
    for (const table of AGENT_TABLES) {
      const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      for (const { name } of info.results)
        if (name.endsWith('_at')) columns.push(`${table}.${name}`);
    }
    expect(columns.sort()).toEqual(Object.keys(STAMPED).sort());

    for (const [column, insert] of Object.entries(STAMPED)) {
      await insert(at(-0.5)); // the real shape is accepted
      for (const bad of STAMP_NOT_ISO) {
        await expect(insert(bad), `${column} = ${JSON.stringify(bad)}`).rejects.toThrow(/CHECK/);
      }
    }
    // budget_day is a UTC date, held the same way.
    await addTurn(await addThread(), { budget_day: '2026-10-01' });
    for (const bad of ['2026-1-01', 'zzzz-zz-zz', '2026-02-30', '2026-10-01T00:00:00.000Z']) {
      await expect(addTurn(await addThread(), { budget_day: bad }), bad).rejects.toThrow(/CHECK/);
    }
  });

  it('so no transcript row can sit outside the sweep: an old thread with a junk-dated child is impossible', async () => {
    const threadId = await addThread({ created_at: at(-40), last_message_at: at(-40) });
    await expect(
      addApproval(threadId, {
        status: 'denied',
        args_json: null,
        summary_json: null,
        created_at: 'Sun Sep 20 2026 10:00:00 GMT',
        expires_at: 'whenever',
      }),
    ).rejects.toThrow(/CHECK/);
    await addApproval(threadId, {
      status: 'denied',
      args_json: null,
      summary_json: null,
      created_at: at(-40),
      expires_at: at(-40),
    });
    const swept = await agentErasureRepo(env.DB).pruneTranscripts(at(-30));
    expect(swept.deleted).toMatchObject({ approvals: 1, threads: 1 });
    expect(await countRows('agent_threads', 'id = ?', threadId)).toBe(0);
  });
});

describe('agentRepo.schemaSupport — the 0006 probe', () => {
  it('accepted with the store, refused when a load-bearing object is missing, unknown when D1 fails', async () => {
    const repo = agentRepo(env.DB);
    expect(await repo.schemaSupport()).toBe('accepted');

    const forward = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'agent_approvals_forward'",
    ).first<{ sql: string }>();
    await env.DB.prepare('DROP TRIGGER agent_approvals_forward').run();
    expect(await repo.schemaSupport()).toBe('refused');
    await env.DB.prepare(forward?.sql ?? '').run();
    expect(await repo.schemaSupport()).toBe('accepted');

    await env.DB.prepare('DROP INDEX idx_agent_turns_one_active').run();
    expect(await repo.schemaSupport()).toBe('refused');
    await runMigration(); // IF NOT EXISTS puts back only what is missing
    expect(await repo.schemaSupport()).toBe('accepted');

    await dropAgentTables();
    expect(await repo.schemaSupport()).toBe('refused');
    await runMigration();

    const unreachable = {
      prepare() {
        throw new Error('D1_ERROR: network connection lost');
      },
    } as unknown as D1Database;
    expect(await agentRepo(unreachable).schemaSupport()).toBe('unknown');
  });

  it('requires every trigger and both partial unique indexes the migration creates', async () => {
    const created = (kind: RegExp) =>
      statementsOf(MIGRATION.sql)
        .map((s) => kind.exec(s)?.[1])
        .filter((name): name is string => name !== undefined)
        .sort();
    expect(created(/^CREATE TRIGGER IF NOT EXISTS (\w+)/)).toEqual([...AGENT_TRIGGERS].sort());
    const unique = created(/^CREATE UNIQUE INDEX IF NOT EXISTS (\w+)/);
    expect(unique).toEqual(['idx_agent_approvals_one_live', 'idx_agent_turns_one_active']);

    const repo = agentRepo(env.DB);
    for (const [type, name] of [
      ...AGENT_TRIGGERS.map((n) => ['TRIGGER', n] as const),
      ...unique.map((n) => ['INDEX', n] as const),
    ]) {
      await env.DB.prepare(`DROP ${type} ${name}`).run();
      expect(await repo.schemaSupport(), name).toBe('refused');
      await runMigration();
      expect(await repo.schemaSupport(), name).toBe('accepted');
    }
  });
});

// ── 2. ONE CASCADE PARENT ──────────────────────────────────────────────────────────────────────

describe('foreign keys: agent_threads is the one cascade parent', () => {
  it('only agent_threads is referenced, every FK cascades, and nothing references users', async () => {
    const references: Record<string, { table: string; on_delete: string }[]> = {};
    for (const table of AGENT_TABLES) {
      const res = await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{
        table: string;
        on_delete: string;
      }>();
      references[table] = res.results.map(({ table: t, on_delete }) => ({ table: t, on_delete }));
    }
    for (const child of CHILDREN) {
      expect(references[child], child).toEqual([{ table: 'agent_threads', on_delete: 'CASCADE' }]);
    }
    expect(references.agent_threads).toEqual([]);
    expect(references.agent_instance_purges).toEqual([]);
    // Across the whole database, no table points at an agent table except the four children, and
    // no agent table points at users.
    const all = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    ).all<{ name: string }>();
    for (const { name } of all.results) {
      const fks = await env.DB.prepare(`PRAGMA foreign_key_list(${name})`).all<{ table: string }>();
      for (const fk of fks.results) {
        if (fk.table.startsWith('agent_')) expect(CHILDREN as readonly string[]).toContain(name);
        if (name.startsWith('agent_')) expect(fk.table).not.toBe('users');
      }
    }
  });

  it('deleting a thread cascades all four children, and only its own', async () => {
    const doomed = await addFullThread();
    const kept = await addFullThread();
    await env.DB.prepare('DELETE FROM agent_threads WHERE id = ?').bind(doomed.threadId).run();
    for (const child of CHILDREN) {
      expect(await countRows(child, 'thread_id = ?', doomed.threadId), child).toBe(0);
      expect(await countRows(child, 'thread_id = ?', kept.threadId), child).toBeGreaterThan(0);
    }
  });

  it('the interlock: a message, turn, approval or feedback row for a missing thread is refused', async () => {
    const ghost = 'th-never-existed';
    await expect(addMessage(ghost)).rejects.toThrow(/FOREIGN KEY/);
    await expect(addTurn(ghost)).rejects.toThrow(/FOREIGN KEY/);
    await expect(addApproval(ghost)).rejects.toThrow(/FOREIGN KEY/);
    await expect(addFeedback(ghost, 'msg-x')).rejects.toThrow(/FOREIGN KEY/);
    // A purge row has no FK on purpose: it outlives the erased thread.
    await addPurge('turn-of-an-erased-thread');
    expect(await countRows('agent_instance_purges')).toBe(1);
  });
});

// ── 3. THE PRIVACY RULES ───────────────────────────────────────────────────────────────────────

describe('threads: owner, subject and creation time are fixed (C17)', () => {
  it('a thread never changes hands or subject; only its last-message time moves', async () => {
    const threadId = await addThread({ subject_kind: 'company', subject_id: 'c-1' });
    for (const change of [
      "id = 'th-renamed'",
      `user_email = '${USERS.admin}'`,
      "subject_kind = 'person'",
      "subject_id = 'c-2'",
      'subject_kind = NULL, subject_id = NULL',
      `created_at = '${at(1)}'`,
    ]) {
      await expect(
        env.DB.prepare(`UPDATE agent_threads SET ${change} WHERE id = ?`).bind(threadId).run(),
        change,
      ).rejects.toThrow(/owner, subject and creation time are fixed/);
    }
    await env.DB.prepare('UPDATE agent_threads SET last_message_at = ? WHERE id = ?')
      .bind(at(1), threadId)
      .run();
    const row = await env.DB.prepare(
      'SELECT user_email, subject_kind, subject_id, last_message_at FROM agent_threads WHERE id = ?',
    )
      .bind(threadId)
      .first();
    expect(row).toEqual({
      user_email: USERS.member,
      subject_kind: 'company',
      subject_id: 'c-1',
      last_message_at: at(1),
    });
  });
});

describe('REPLACE is refused on every table that has a trigger or is a parent', () => {
  it('threads: a REPLACE would cascade-delete the children — refused, children intact', async () => {
    const { threadId } = await addFullThread();
    await expect(addThread({ id: threadId }), 'plain duplicate').rejects.toThrow(/never replaced/);
    await expect(
      insertRow(
        'agent_threads',
        { id: threadId, user_email: USERS.member, created_at: T0, last_message_at: T0 },
        'INSERT OR REPLACE',
      ),
    ).rejects.toThrow(/never replaced/);
    for (const child of CHILDREN)
      expect(await countRows(child, 'thread_id = ?', threadId)).toBeGreaterThan(0);
  });

  it('messages, by id AND by (thread_id, seq); turns and approvals by id (their partial keys below)', async () => {
    const threadId = await addThread();
    const messageId = await addMessage(threadId, { seq: 7, content: 'original' });
    await expect(addMessage(threadId, { id: messageId, seq: 8 })).rejects.toThrow(/never replaced/);
    await expect(
      insertRow(
        'agent_messages',
        {
          id: messageId,
          thread_id: threadId,
          seq: 9,
          role: 'user',
          state: 'final',
          content: 'x',
          created_at: T0,
        },
        'REPLACE',
      ),
    ).rejects.toThrow(/never replaced/);
    await expect(
      insertRow(
        'agent_messages',
        {
          id: 'msg-other',
          thread_id: threadId,
          seq: 7,
          role: 'user',
          state: 'final',
          content: 'x',
          created_at: T0,
        },
        'INSERT OR REPLACE',
      ),
    ).rejects.toThrow(/never replaced/);
    const kept = await env.DB.prepare('SELECT content FROM agent_messages WHERE id = ?')
      .bind(messageId)
      .first<{ content: string }>();
    expect(kept?.content).toBe('original');

    const turnId = await addTurn(threadId);
    await expect(
      insertRow(
        'agent_turns',
        {
          id: turnId,
          thread_id: threadId,
          kind: 'message',
          reply_message_id: 'r',
          delivery: 'partial',
          status: 'queued',
          budget_day: '2026-10-01',
          budget_reserved_usd: 0,
          created_at: T0,
        },
        'INSERT OR REPLACE',
      ),
    ).rejects.toThrow(/never replaced/);
    const approvalId = await addApproval(threadId);
    await expect(
      addApproval(threadId, {
        id: approvalId,
        status: 'expired',
        args_json: null,
        summary_json: null,
      }),
    ).rejects.toThrow(/never replaced/);
  });

  // REPLACE settles a conflict on ANY unique index by deleting the row holding it — with a NEW id,
  // the conflict is on the partial index, and the row deleted is the thread's queued or running
  // turn (with its session pointer and in-flight booking) or its live approval. No trigger keyed on
  // `id` sees it. Every pair of live statuses is tried under every conflict verb, and the refusal
  // must carry the TRIGGER's message: a plain INSERT the index would refuse anyway, but under
  // REPLACE, OR IGNORE and ON CONFLICT DO NOTHING the index refuses nothing, so a trigger narrowed
  // to fewer statuses would pass every case it no longer covers but these.
  const VERBS = [
    'INSERT',
    'INSERT OR REPLACE',
    'REPLACE',
    'INSERT OR IGNORE',
    'ON CONFLICT DO NOTHING',
  ] as const;

  async function insertVia(
    verb: (typeof VERBS)[number],
    table: string,
    row: Record<string, unknown>,
  ): Promise<void> {
    if (verb !== 'ON CONFLICT DO NOTHING') return insertRow(table, row, verb);
    const cols = Object.keys(row);
    await env.DB.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`,
    )
      .bind(...cols.map((c) => row[c]))
      .run();
  }

  const turnRow = (threadId: string, status: string, over: Record<string, unknown> = {}) => ({
    id: nextId('turn'),
    thread_id: threadId,
    kind: 'message',
    reply_message_id: nextId('reply'),
    delivery: 'partial',
    status,
    budget_day: '2026-10-01',
    budget_reserved_usd: 0,
    created_at: T0,
    ...over,
  });

  it('turns: no verb lets a new queued or running turn evict a queued or running one', async () => {
    for (const existing of ['queued', 'running']) {
      for (const incoming of ['queued', 'running']) {
        for (const verb of VERBS) {
          const label = `existing ${existing}, ${verb} ${incoming}`;
          const threadId = await addThread();
          const live = await addTurn(threadId, {
            status: existing,
            session_key: await hex64('fixture-session-evict'),
            session_created_at_ms: Date.parse(T0),
            inflight_usd: 0.5,
            inflight_json: '{"seq":1}',
          });
          await expect(
            insertVia(verb, 'agent_turns', turnRow(threadId, incoming)),
            label,
          ).rejects.toThrow(
            /UNIQUE constraint failed: agent_turns\.thread_id, one active turn per thread/,
          );
          const kept = await env.DB.prepare(
            'SELECT id, status, session_key IS NOT NULL AS has_session, inflight_usd FROM agent_turns WHERE thread_id = ?',
          )
            .bind(threadId)
            .all();
          expect(kept.results, label).toEqual([
            { id: live, status: existing, has_session: 1, inflight_usd: 0.5 },
          ]);
        }
      }
    }
    // A done turn never holds the slot, so it may still be written beside the active one.
    const threadId = await addThread();
    await addTurn(threadId, { status: 'running' });
    await insertRow(
      'agent_turns',
      turnRow(threadId, 'done', { outcome: 'completed', ended_at: T0, budget_settled_at: T0 }),
    );
  });

  it('approvals: no verb lets a new pending or approved approval evict a pending or approved one', async () => {
    const argsSha = await hex64('fixture-args-evict');
    for (const existing of ['pending', 'approved']) {
      for (const incoming of ['pending', 'approved']) {
        for (const verb of VERBS) {
          const label = `existing ${existing}, ${verb} ${incoming}`;
          const threadId = await addThread();
          const live = await addApproval(threadId, {
            status: existing,
            ...(existing === 'approved' ? { decided_at: T0 } : {}),
          });
          await expect(
            insertVia(verb, 'agent_approvals', {
              id: nextId('appr'),
              thread_id: threadId,
              turn_id: 'turn-z',
              actor_email: USERS.member,
              tool_name: 'post_notes',
              tool_use_id: nextId('toolu'),
              args_sha256: argsSha,
              args_json: '{"title":"incoming"}',
              status: incoming,
              created_at: T0,
              expires_at: at(1),
            }),
            label,
          ).rejects.toThrow(
            /UNIQUE constraint failed: agent_approvals\.thread_id, one live approval per thread/,
          );
          const kept = await env.DB.prepare(
            'SELECT id, status, args_json FROM agent_approvals WHERE thread_id = ?',
          )
            .bind(threadId)
            .all();
          expect(kept.results, label).toEqual([
            { id: live, status: existing, args_json: '{"title":"synthetic"}' },
          ]);
        }
      }
    }
    // A denied, expired or consumed approval never holds the slot.
    const threadId = await addThread();
    await addApproval(threadId, { status: 'approved', decided_at: T0 });
    await addApproval(threadId, { status: 'expired', args_json: null, summary_json: null });
  });
});

describe('a NULL status never gets past the triggers', () => {
  // Under OR REPLACE, SQLite swaps a NULL in a NOT NULL column for the column's DEFAULT only AFTER
  // the BEFORE triggers ran, and every status predicate in them is NULL for a NULL status, so none
  // fires: with a default, a REPLACE with a NULL status evicted the running turn or the approved
  // approval, and UPDATE OR REPLACE moved running back to queued and approved back to pending. The
  // two status columns have NO default, so a NULL status aborts on NOT NULL under every verb.
  it('INSERT or UPDATE, plain or OR REPLACE: refused on NOT NULL, the live rows intact', async () => {
    const threadId = await addThread();
    const running = await addTurn(threadId, {
      status: 'running',
      session_key: await hex64('fixture-session-null-status'),
      session_created_at_ms: Date.parse(T0),
      inflight_usd: 0.5,
      inflight_json: '{"seq":1}',
    });
    const approved = await addApproval(threadId, { status: 'approved', decided_at: T0 });
    const turnRow = (over: Record<string, unknown>) => ({
      id: nextId('turn'),
      thread_id: threadId,
      kind: 'message',
      reply_message_id: nextId('reply'),
      delivery: 'partial',
      budget_day: '2026-10-01',
      budget_reserved_usd: 0,
      created_at: T0,
      ...over,
    });
    const approvalRow = async (over: Record<string, unknown>) => ({
      id: nextId('appr'),
      thread_id: threadId,
      turn_id: 'turn-z',
      actor_email: USERS.member,
      tool_name: 'post_notes',
      tool_use_id: nextId('toolu'),
      args_sha256: await hex64('fixture-args-null-status'),
      created_at: T0,
      expires_at: at(1),
      ...over,
    });
    for (const verb of ['INSERT OR REPLACE', 'REPLACE', 'INSERT']) {
      await expect(insertRow('agent_turns', turnRow({ status: null }), verb), verb).rejects.toThrow(
        /NOT NULL constraint failed: agent_turns\.status/,
      );
      await expect(
        insertRow('agent_approvals', await approvalRow({ status: null }), verb),
        verb,
      ).rejects.toThrow(/NOT NULL constraint failed: agent_approvals\.status/);
    }
    // Omitted, a status is NULL too — never a silent 'queued' or 'pending'.
    await expect(insertRow('agent_turns', turnRow({}))).rejects.toThrow(
      /NOT NULL constraint failed: agent_turns\.status/,
    );
    await expect(insertRow('agent_approvals', await approvalRow({}))).rejects.toThrow(
      /NOT NULL constraint failed: agent_approvals\.status/,
    );
    // OR IGNORE skips the row: nothing written, nothing evicted.
    await insertRow('agent_turns', turnRow({ status: null }), 'INSERT OR IGNORE');
    await insertRow('agent_approvals', await approvalRow({ status: null }), 'INSERT OR IGNORE');
    for (const verb of ['UPDATE OR REPLACE', 'UPDATE', 'UPDATE OR IGNORE']) {
      const turn = env.DB.prepare(`${verb} agent_turns SET status = NULL WHERE id = ?`)
        .bind(running)
        .run();
      const approval = env.DB.prepare(`${verb} agent_approvals SET status = NULL WHERE id = ?`)
        .bind(approved)
        .run();
      if (verb === 'UPDATE OR IGNORE') {
        await turn;
        await approval;
      } else {
        await expect(turn, verb).rejects.toThrow(/NOT NULL constraint failed: agent_turns\.status/);
        await expect(approval, verb).rejects.toThrow(
          /NOT NULL constraint failed: agent_approvals\.status/,
        );
      }
    }
    const turns = await env.DB.prepare(
      'SELECT id, status, session_key IS NOT NULL AS has_session, inflight_usd FROM agent_turns WHERE thread_id = ?',
    )
      .bind(threadId)
      .all();
    expect(turns.results).toEqual([
      { id: running, status: 'running', has_session: 1, inflight_usd: 0.5 },
    ]);
    const approvals = await env.DB.prepare(
      'SELECT id, status, args_json IS NOT NULL AS has_args FROM agent_approvals WHERE thread_id = ?',
    )
      .bind(threadId)
      .all();
    expect(approvals.results).toEqual([{ id: approved, status: 'approved', has_args: 1 }]);
  });
});

describe('a final message is never edited (PIA §7.9)', () => {
  it('a streaming reply fills in and goes final; after that nothing about it moves', async () => {
    const threadId = await addThread();
    const id = await addMessage(threadId, { role: 'assistant', state: 'streaming', content: '' });
    const set = (sql: string, ...binds: unknown[]) =>
      env.DB.prepare(`UPDATE agent_messages SET ${sql} WHERE id = ?`)
        .bind(...binds, id)
        .run();

    await set('content = ?', 'partial answer');
    await set("content = ?, meta_json = ?, state = 'final'", 'final answer', '{"notice":"done"}');
    await expect(set('content = ?', 'rewritten')).rejects.toThrow(/never edited/);
    await expect(set('meta_json = ?', '{}')).rejects.toThrow(/never edited/);
    await expect(set('meta_json = NULL')).rejects.toThrow(/never edited/);
    await expect(set("state = 'streaming'")).rejects.toThrow(/never edited/);
    const row = await env.DB.prepare('SELECT content, state FROM agent_messages WHERE id = ?')
      .bind(id)
      .first<{ content: string; state: string }>();
    expect(row).toEqual({ content: 'final answer', state: 'final' });
  });

  it('owner, order and turn are fixed even while streaming; a user message is always final', async () => {
    const threadId = await addThread();
    const other = await addThread();
    const id = await addMessage(threadId, { role: 'assistant', state: 'streaming' });
    for (const change of [
      `thread_id = '${other}'`,
      'seq = 999',
      "role = 'user'",
      "turn_id = 'turn-x'",
      `created_at = '${at(1)}'`,
    ]) {
      await expect(
        env.DB.prepare(`UPDATE agent_messages SET ${change} WHERE id = ?`).bind(id).run(),
        change,
      ).rejects.toThrow(/a final message is never edited/);
    }
    // Nor is a message renamed, streaming or final: feedback names its message by id, and the
    // reply a turn writes is found by it (agent_turns.reply_message_id).
    const final = await addMessage(threadId);
    for (const message of [id, final]) {
      await expect(
        env.DB.prepare('UPDATE agent_messages SET id = ? WHERE id = ?')
          .bind(nextId('msg-renamed'), message)
          .run(),
        message,
      ).rejects.toThrow(/a final message is never edited/);
    }
    expect(await countRows('agent_messages', 'id IN (?, ?)', id, final)).toBe(2);
    await expect(addMessage(threadId, { role: 'user', state: 'streaming' })).rejects.toThrow(
      /CHECK/,
    );
    await expect(addMessage(threadId, { content: 'x'.repeat(100_001) })).rejects.toThrow(/CHECK/);
    await expect(addMessage(threadId, { meta_json: 'not json' })).rejects.toThrow(/CHECK/);
  });
});

describe('approvals: single use, bound, forward only', () => {
  const update = (id: string, sql: string, ...binds: unknown[]) =>
    env.DB.prepare(`UPDATE agent_approvals SET ${sql} WHERE id = ?`)
      .bind(...binds, id)
      .run();

  it('pending → approved → consumed is the path, and consuming clears the arguments and card', async () => {
    const threadId = await addThread();
    const id = await addApproval(threadId);
    await update(id, "status = 'approved', decided_at = ?", at(1 / 1440));
    await expect(
      update(
        id,
        "status = 'consumed', consumed_turn_id = 'turn-resume', consumed_at = ?",
        at(2 / 1440),
      ),
    ).rejects.toThrow(/CHECK/);
    await update(
      id,
      "status = 'consumed', consumed_turn_id = 'turn-resume', consumed_at = ?, args_json = NULL, summary_json = NULL",
      at(2 / 1440),
    );
    const row = await env.DB.prepare(
      'SELECT status, args_json, summary_json FROM agent_approvals WHERE id = ?',
    )
      .bind(id)
      .first();
    expect(row).toEqual({ status: 'consumed', args_json: null, summary_json: null });

    // …and never back, never re-armed, never re-pointed.
    await expect(update(id, "status = 'approved'")).rejects.toThrow(/only moves forward/);
    await expect(update(id, "status = 'pending'")).rejects.toThrow(/only moves forward/);
    await expect(update(id, "consumed_turn_id = 'turn-other'")).rejects.toThrow(
      /only moves forward/,
    );
    await expect(update(id, "args_json = '{}'")).rejects.toThrow(/only moves forward/);
  });

  it('of the twenty status moves, exactly the five forward ones are allowed', async () => {
    const STATUSES = ['pending', 'approved', 'denied', 'expired', 'consumed'] as const;
    const FORWARD = new Set([
      'pending>approved',
      'pending>denied',
      'pending>expired',
      'approved>consumed',
      'approved>expired',
    ]);
    const decided = (s: string) => s === 'denied' || s === 'expired' || s === 'consumed';
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to) continue;
        const id = await addApproval(await addThread(), {
          status: from,
          ...(decided(from) ? { args_json: null, summary_json: null } : {}),
          ...(from === 'consumed' ? { consumed_turn_id: 'turn-c', consumed_at: T0 } : {}),
        });
        // Every column the CHECKs want for `to` is set, so only the trigger can refuse.
        const extra = [
          ...(decided(to) ? ['args_json = NULL', 'summary_json = NULL'] : []),
          ...(to === 'consumed' && from !== 'consumed'
            ? ["consumed_turn_id = 'turn-c'", `consumed_at = '${T0}'`]
            : []),
        ];
        const move = update(id, [`status = '${to}'`, ...extra].join(', '));
        if (FORWARD.has(`${from}>${to}`)) await move;
        else await expect(move, `${from} → ${to}`).rejects.toThrow(/only moves forward/);
      }
    }
  });

  it('a denied, expired or consumed approval holds no arguments or card; a consumed one names its turn', async () => {
    const threadId = await addThread();
    const id = await addApproval(threadId);
    await expect(update(id, "status = 'denied'")).rejects.toThrow(/CHECK/);
    await update(
      id,
      "status = 'denied', args_json = NULL, summary_json = NULL, decided_at = ?",
      at(0.001),
    );
    for (const status of ['denied', 'expired', 'consumed']) {
      await expect(
        addApproval(await addThread(), { status, consumed_turn_id: 't', consumed_at: T0 }),
        status,
      ).rejects.toThrow(/CHECK/);
      await expect(
        addApproval(await addThread(), {
          status,
          args_json: null,
          consumed_turn_id: 't',
          consumed_at: T0,
        }),
        status,
      ).rejects.toThrow(/CHECK/);
    }
    await expect(
      addApproval(await addThread(), { status: 'consumed', args_json: null, summary_json: null }),
    ).rejects.toThrow(/CHECK/);
  });

  it('bound fields are fixed, cleared content is never re-set, and pending cannot jump to consumed', async () => {
    const otherThread = await addThread();
    const otherArgs = await hex64('other-args');
    // A pending approval, and an approved one that still holds the model's arguments and card:
    // neither is re-pointed to another thread (whose owner would then hold the args), renamed, or
    // re-bound in any other field.
    for (const status of ['pending', 'approved']) {
      const threadId = await addThread();
      const id = await addApproval(threadId, {
        status,
        ...(status === 'approved' ? { decided_at: T0 } : {}),
      });
      for (const change of [
        `thread_id = '${otherThread}'`,
        `id = '${nextId('appr-renamed')}'`,
        `args_sha256 = '${otherArgs}'`,
        "tool_name = 'delete_notes_by_id'",
        "tool_use_id = 'toolu_other'",
        `actor_email = '${USERS.admin}'`,
        "turn_id = 'turn-other'",
        `expires_at = '${at(1)}'`,
        `created_at = '${at(1)}'`,
      ]) {
        await expect(update(id, change), `${status}: ${change}`).rejects.toThrow(
          /bound fields are fixed and status only moves forward/,
        );
      }
      expect(
        await env.DB.prepare('SELECT thread_id, args_json FROM agent_approvals WHERE id = ?')
          .bind(id)
          .first(),
      ).toEqual({ thread_id: threadId, args_json: '{"title":"synthetic"}' });
    }
    expect(await countRows('agent_approvals', 'thread_id = ?', otherThread)).toBe(0);

    const id = await addApproval(await addThread());
    await update(id, 'summary_json = NULL'); // clearing is forward
    await expect(update(id, "summary_json = '{}'")).rejects.toThrow(/only moves forward/);
    await expect(
      update(
        id,
        "status = 'consumed', consumed_turn_id = 't', consumed_at = ?, args_json = NULL",
        T0,
      ),
    ).rejects.toThrow(/only moves forward/);
    await expect(addApproval(await addThread(), { args_sha256: 'not-a-hash' })).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      addApproval(await addThread(), { actor_email: 'Alice@Test.Example' }),
    ).rejects.toThrow(/CHECK/);
  });
});

describe('turns: bound at start, final once done', () => {
  const update = (id: string, sql: string, ...binds: unknown[]) =>
    env.DB.prepare(`UPDATE agent_turns SET ${sql} WHERE id = ?`)
      .bind(...binds, id)
      .run();

  async function runningTurn(): Promise<string> {
    const threadId = await addThread();
    const id = await addTurn(threadId, {
      session_key: await hex64('fixture-session-1'),
      session_created_at_ms: Date.parse(T0),
      request_ip: '203.0.113.7',
    });
    await update(id, "status = 'running', started_at = ?, events_json = '[]'", T0);
    return id;
  }

  const FINISH = `status = 'done', outcome = 'completed', ended_at = ?, budget_settled_at = ?,
    session_key = NULL, session_created_at_ms = NULL, request_ip = '', events_json = NULL`;

  it('queued → running → done, and a done turn keeps no session pointer, IP or in-flight events', async () => {
    const id = await runningTurn();
    await expect(update(id, "status = 'queued'")).rejects.toThrow(/done turn is final/);
    // Each transient column left set makes "done" impossible.
    for (const left of ['session_key', 'session_created_at_ms', 'request_ip', 'events_json']) {
      const clear = FINISH.replace(
        `${left} = ${left === 'request_ip' ? "''" : 'NULL'}`,
        `${left} = ${left}`,
      );
      await expect(update(id, clear, T0, T0), left).rejects.toThrow(/CHECK/);
    }
    await expect(
      update(id, FINISH.replace('budget_settled_at = ?', 'budget_settled_at = NULL'), T0),
    ).rejects.toThrow(/CHECK/);
    await update(id, FINISH, T0, T0);
    const row = await env.DB.prepare(
      'SELECT status, session_key, request_ip, events_json FROM agent_turns WHERE id = ?',
    )
      .bind(id)
      .first();
    expect(row).toEqual({ status: 'done', session_key: null, request_ip: '', events_json: null });
  });

  it('a done turn is final: status, outcome, end, spend and a re-set pending transcript are refused', async () => {
    const id = await runningTurn();
    await update(id, FINISH, T0, T0);
    for (const change of [
      "status = 'running'",
      "outcome = 'erased'",
      `ended_at = '${at(1)}'`,
      'spent_usd = 9',
    ]) {
      await expect(update(id, change), change).rejects.toThrow(/done turn is final/);
    }
    // The trigger refuses this before the awaiting-only CHECK is reached.
    await expect(update(id, "pending_json = '{}', pending_expires_at = ?", T0)).rejects.toThrow(
      /done turn is final/,
    );
    // The counters stay writable for the finish batch's metrics.
    await update(id, 'rounds = 3, tool_calls = 2');
  });

  it('a turn with an unsettled call (in-flight spend) cannot be done; settling it first can', async () => {
    const id = await runningTurn();
    await update(id, 'inflight_usd = 0.4, inflight_json = \'{"seq":1}\'');
    await expect(update(id, FINISH, T0, T0)).rejects.toThrow(/CHECK/);
    await update(id, `${FINISH}, inflight_usd = NULL, inflight_json = NULL`, T0, T0);
    await expect(update(id, "inflight_usd = 0.1, inflight_json = '{}'")).rejects.toThrow(/CHECK/);
  });

  it('only an awaiting-approval turn keeps its held transcript once done, and it can be taken', async () => {
    const id = await runningTurn();
    const expiry = at(10 / 1440);
    await update(id, 'pending_json = \'{"held":true}\', pending_expires_at = ?', expiry);
    await expect(update(id, FINISH, T0, T0)).rejects.toThrow(/CHECK/);
    await update(id, FINISH.replace("'completed'", "'awaiting_approval'"), T0, T0);
    // Held, it is neither rewritten nor kept longer, nor half cleared.
    for (const change of [
      'pending_json = \'{"held":"rewritten"}\'',
      "pending_expires_at = '9999-12-31T00:00:00.000Z'",
      'pending_expires_at = NULL',
    ]) {
      await expect(update(id, change), change).rejects.toThrow(/done turn is final/);
    }
    await update(id, 'pending_json = NULL, pending_expires_at = NULL'); // takePending
    // Taken, it is never put back — the awaiting-only CHECK alone would allow this.
    await expect(
      update(id, 'pending_json = \'{"held":true}\', pending_expires_at = ?', expiry),
    ).rejects.toThrow(/done turn is final/);
    const row = await env.DB.prepare(
      'SELECT outcome, pending_json, pending_expires_at FROM agent_turns WHERE id = ?',
    )
      .bind(id)
      .first();
    expect(row).toEqual({
      outcome: 'awaiting_approval',
      pending_json: null,
      pending_expires_at: null,
    });
  });

  it('bound fields are fixed from the start, and done turns cannot be inserted half-closed', async () => {
    const otherThread = await addThread();
    const held = { pending_json: '{"held":true}', pending_expires_at: at(10 / 1440) };
    // A queued turn, a running one holding a paused transcript, and a done one awaiting approval
    // that still holds it: none is moved to another thread (whose owner would then be handed the
    // held transcript), renamed, re-parented or re-bound.
    const BOUND = {
      queued: {},
      running: { status: 'running', ...held },
      awaiting: { status: 'done', outcome: 'awaiting_approval', ...held },
    };
    for (const [label, over] of Object.entries(BOUND)) {
      const threadId = await addThread();
      const id = await addTurn(threadId, {
        parent_turn_id: 'turn-parent',
        user_message_id: 'msg-question',
        ...over,
      });
      for (const change of [
        `thread_id = '${otherThread}'`,
        `id = '${nextId('turn-renamed')}'`,
        "parent_turn_id = 'turn-parent-other'",
        "user_message_id = 'msg-other'",
        'budget_reserved_usd = 5',
        "budget_day = '2026-10-02'",
        "delivery = 'deferred'",
        "kind = 'resume'",
        "reply_message_id = 'r-other'",
        "approval_id = 'appr-x'",
        `created_at = '${at(1)}'`,
      ]) {
        await expect(update(id, change), `${label}: ${change}`).rejects.toThrow(
          /bound fields are fixed and a done turn is final/,
        );
      }
      expect(
        await env.DB.prepare('SELECT thread_id, pending_json FROM agent_turns WHERE id = ?')
          .bind(id)
          .first(),
        label,
      ).toEqual({
        thread_id: threadId,
        pending_json: label === 'queued' ? null : held.pending_json,
      });
    }
    expect(await countRows('agent_turns', 'thread_id = ?', otherThread)).toBe(0);

    const threadId = await addThread();
    await expect(
      addTurn(threadId, { status: 'done', events_json: '[]', thread_id: await addThread() }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      addTurn(await addThread(), { status: 'done', session_key: await hex64('fixture-session-2') }),
    ).rejects.toThrow(/CHECK/);
    await expect(addTurn(await addThread(), { session_key: 'ABC' })).rejects.toThrow(/CHECK/);
    await expect(addTurn(await addThread(), { outcome: 'completed' })).rejects.toThrow(/CHECK/);
    await expect(
      addTurn(await addThread(), { outcome: 'Has Caps', status: 'done' }),
    ).rejects.toThrow(/CHECK/);
    await expect(addTurn(await addThread(), { inflight_usd: 0.2 })).rejects.toThrow(/CHECK/);
  });
});

describe('partial unique indexes: one active turn and one live approval per thread', () => {
  it('a second queued or running turn on a thread is refused, atomically, until the first is done', async () => {
    const threadId = await addThread();
    const first = await addTurn(threadId);
    await expect(addTurn(threadId)).rejects.toThrow(/UNIQUE/);
    await expect(addTurn(threadId, { status: 'running' })).rejects.toThrow(/UNIQUE/);
    // A race inside one batch commits neither.
    const other = await addThread();
    const insert = env.DB.prepare(
      "INSERT INTO agent_turns (id, thread_id, kind, reply_message_id, delivery, status, budget_day, budget_reserved_usd, created_at) VALUES (?, ?, 'message', ?, 'partial', 'queued', '2026-10-01', 1, ?)",
    );
    await expect(
      env.DB.batch([
        insert.bind('turn-race-a', other, 'r-a', T0),
        insert.bind('turn-race-b', other, 'r-b', T0),
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await countRows('agent_turns', 'thread_id = ?', other)).toBe(0);

    await env.DB.prepare(
      "UPDATE agent_turns SET status = 'done', outcome = 'reaped', ended_at = ?, budget_settled_at = ? WHERE id = ?",
    )
      .bind(T0, T0, first)
      .run();
    await addTurn(threadId); // the next turn may start
    await addTurn(threadId, { status: 'done' }); // done turns never collide
  });

  it('a second pending or approved approval on a thread is refused until the first is denied, expired or consumed', async () => {
    const threadId = await addThread();
    const first = await addApproval(threadId);
    await expect(addApproval(threadId)).rejects.toThrow(/UNIQUE/);
    await expect(addApproval(threadId, { status: 'approved' })).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare(
      "UPDATE agent_approvals SET status = 'expired', args_json = NULL, summary_json = NULL WHERE id = ?",
    )
      .bind(first)
      .run();
    await addApproval(threadId);
  });
});

// ── 4. THE HARNESS ─────────────────────────────────────────────────────────────────────────────

describe('seedDb resets the agent store', () => {
  it('empties every agent table, rows in all six, children first', async () => {
    await addFullThread();
    await addPurge('turn-queued-for-purge');
    for (const table of AGENT_TABLES) expect(await countRows(table), table).toBeGreaterThan(0);
    await seedDb();
    for (const table of AGENT_TABLES) expect(await countRows(table), table).toBe(0);
  });
});
