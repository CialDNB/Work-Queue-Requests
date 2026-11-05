import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import schemaSql from '../../schema.sql?raw';
import { executeScheduledRun } from '../../src/cron';
import {
  APPEND_ONLY_TRIGGERS,
  missingAppendOnlyTriggers,
  runAppendOnlyTriggerCheck,
} from '../../src/cron/appendOnlyTriggers';
import { makeDb } from '../../src/data';
import { metaRepo } from '../../src/data/meta';
import type { Env } from '../../src/env';
import { healthResponse } from '../../src/health';
import { applySchema, seedDb } from '../helpers/db';

// The six WORM triggers schema.sql puts on the two forensic tables. Spelled out here, not read
// from APPEND_ONLY_TRIGGERS, so these tests would still fail if the constant lost an entry.
const WORM_TRIGGERS = [
  'audit_log_no_update',
  'audit_log_no_delete',
  'audit_log_no_replace',
  'ai_usage_no_update',
  'ai_usage_no_delete',
  'ai_usage_no_replace',
] as const;

// schema.sql's six statements in the form SQLite stores them in sqlite_master.sql: the text from
// the trigger name to END, behind "CREATE TRIGGER " (SQLite drops IF NOT EXISTS when it stores a
// trigger). This is what the check reads on a database built from schema.sql.
const STORED_SQL = new Map(
  [
    ...schemaSql.matchAll(
      /CREATE TRIGGER IF NOT EXISTS ((?:audit_log|ai_usage)_no_\w+)\b[\s\S]*?\bEND\b/g,
    ),
  ].map((m) => [m[1] as string, m[0].replace('CREATE TRIGGER IF NOT EXISTS ', 'CREATE TRIGGER ')]),
);

// One audit row, so a DELETE has something to delete and a BEFORE DELETE guard actually fires.
async function insertAuditRow(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (actor_email, action, target, payload_json) VALUES ('seed@test.example', 'test.row', 't', '{}')",
  ).run();
}

// An env whose EMAIL binding records every send, so "it pages" is asserted on the mail the owner
// would actually receive (ALERT_EMAIL is set in wrangler.test.jsonc), not on an internal flag.
function capturingEnv(): { env: Env; sent: Array<{ to: string; subject: string; text: string }> } {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const e = {
    ...env,
    EMAIL: {
      send: async (m: { to: string; subject: string; text: string }) => {
        sent.push({ to: m.to, subject: m.subject, text: m.text });
      },
    },
  } as unknown as Env;
  return { env: e, sent };
}

// Every statement in this file that drops or creates a trigger runs against the in-memory test
// database only (vitest-pool-workers, wrangler.test.jsonc). seedDb drops and recreates audit_log
// + ai_usage from schema.sql before each test, so all six triggers are back in place every time.
describe('daily cron pages when an append-only trigger is missing from the live schema', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('runs the trigger check as a green task when all six are present, and sends no page', async () => {
    const { env: e, sent } = capturingEnv();
    const results = await executeScheduledRun(e);
    const task = results.find((r) => r.task === 'append_only_triggers');
    expect(task?.ok).toBe(true);
    expect(task?.detail).toMatch(/6\/6/);
    expect(sent).toHaveLength(0);
  });

  for (const trigger of WORM_TRIGGERS) {
    it(`pages the owner when ${trigger} has been dropped`, async () => {
      await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
      const { env: e, sent } = capturingEnv();

      const results = await executeScheduledRun(e);

      const task = results.find((r) => r.task === 'append_only_triggers');
      expect(task?.ok).toBe(false);
      expect(task?.error).toContain(trigger);
      // The page: the cron-failure email reaches the alert recipient and names the trigger.
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0]?.to).toBe('alerts@test.example');
      expect(sent[0]?.subject).toMatch(/cron failure/);
      expect(sent[0]?.text).toContain('append_only_triggers');
      expect(sent[0]?.text).toContain(trigger);
    });
  }

  it('names every missing trigger in one page when several are gone', async () => {
    await env.DB.prepare('DROP TRIGGER audit_log_no_delete').run();
    await env.DB.prepare('DROP TRIGGER ai_usage_no_update').run();
    const { env: e, sent } = capturingEnv();
    await executeScheduledRun(e);
    expect(sent).toHaveLength(1); // one alert email per recipient, not one per trigger
    expect(sent[0]?.text).toContain('audit_log_no_delete');
    expect(sent[0]?.text).toContain('ai_usage_no_update');
  });

  it('a sanctioned purge window pages at most one run: the run after the recreate is green', async () => {
    // A WORM-exception purge (insights A7.3) drops audit_log_no_delete and recreates it in the
    // same script, seconds later. The check keeps no state between runs (no "last failure" flag,
    // no cool-down), so only a daily run that lands inside that window can page, and the next run
    // after the trigger is back is green with no page. Test DB only.
    await env.DB.prepare('DROP TRIGGER audit_log_no_delete').run();
    const during = capturingEnv();
    const duringResults = await executeScheduledRun(during.env);
    expect(duringResults.find((r) => r.task === 'append_only_triggers')?.ok).toBe(false);
    expect(during.sent.length).toBeGreaterThan(0);

    // The purge's own last step: CREATE TRIGGER IF NOT EXISTS, verbatim from schema.sql.
    await applySchema();

    const after = capturingEnv();
    const afterResults = await executeScheduledRun(after.env);
    const task = afterResults.find((r) => r.task === 'append_only_triggers');
    expect(task?.ok).toBe(true);
    expect(task?.detail).toMatch(/6\/6/);
    expect(after.sent).toHaveLength(0);
  });

  it('pages when a trigger with the right name sits on the wrong table', async () => {
    // SQLite trigger names are unique per schema, not per table: a same-named trigger on another
    // table protects nothing, and a name-only check would pass it.
    await env.DB.prepare('DROP TRIGGER audit_log_no_delete').run();
    await env.DB.prepare(
      'CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON notes BEGIN SELECT 1; END',
    ).run();
    try {
      await expect(runAppendOnlyTriggerCheck(env as Env)).rejects.toThrow(
        /audit_log_no_delete \(on another table, expected on audit_log\)/,
      );
    } finally {
      // seedDb only drops audit_log + ai_usage, so a trigger on `notes` would survive it, and
      // schema.sql's CREATE TRIGGER IF NOT EXISTS would then skip the real one for every later
      // test in this file. Remove the impostor and put the real trigger back (test DB only).
      await env.DB.prepare('DROP TRIGGER audit_log_no_delete').run();
      await applySchema();
    }
  });

  it('never echoes the wrong table name into the page, the task error or the heartbeat row', async () => {
    // A table name is free text to SQLite, chosen by whoever holds D1 write access, and the page
    // goes out from the app's own sender. Echoing it would hand that person a phishing line in the
    // owner's inbox. Test DB only.
    const hostile = 'URGENT: audit restore needed, sign in at https://attacker.example/restore';
    await env.DB.prepare('DROP TRIGGER audit_log_no_delete').run();
    await env.DB.prepare(`CREATE TABLE "${hostile}" (x)`).run();
    await env.DB.prepare(
      `CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON "${hostile}" BEGIN SELECT 1; END`,
    ).run();
    try {
      const { env: e, sent } = capturingEnv();

      const results = await executeScheduledRun(e);

      const task = results.find((r) => r.task === 'append_only_triggers');
      expect(task?.ok).toBe(false);
      expect(task?.error).toContain(
        'audit_log_no_delete (on another table, expected on audit_log)',
      );
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0]?.text).toContain('audit_log_no_delete (on another table');
      const heartbeat = await env.DB.prepare(
        "SELECT payload_json FROM audit_log WHERE action = 'cron_heartbeat_done'",
      ).first<{ payload_json: string }>();
      expect(heartbeat?.payload_json).toContain('audit_log_no_delete (on another table');
      for (const sink of [task?.error, ...sent.map((m) => m.text), heartbeat?.payload_json]) {
        expect(sink).not.toMatch(/URGENT|attacker\.example|sign in/);
      }
    } finally {
      // The impostor sits on a table seedDb never drops: remove both, then put the real guard back.
      await env.DB.prepare('DROP TRIGGER audit_log_no_delete').run();
      await env.DB.prepare(`DROP TABLE "${hostile}"`).run();
      await applySchema();
    }
  });

  it('pages when a same-named trigger was recreated to do nothing (the one-statement neutering)', async () => {
    // A holder of D1 credentials swaps the guard for a harmless trigger under the same name, on
    // the same table. A name-and-table check reads that as "6/6 present". Test DB only.
    await env.DB.prepare('DROP TRIGGER audit_log_no_delete').run();
    await env.DB.prepare(
      'CREATE TRIGGER audit_log_no_delete BEFORE INSERT ON audit_log WHEN 0 BEGIN SELECT 1; END',
    ).run();
    // Precondition: the guard really is off, a DELETE now goes through.
    await insertAuditRow();
    await env.DB.prepare('DELETE FROM audit_log').run();
    const { env: e, sent } = capturingEnv();

    const results = await executeScheduledRun(e);

    const task = results.find((r) => r.task === 'append_only_triggers');
    expect(task?.ok).toBe(false);
    expect(task?.error).toContain('audit_log_no_delete (altered');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]?.text).toContain('audit_log_no_delete');
  });

  it('does not page for a working trigger whose name and table differ only in case, even after db:apply', async () => {
    // SQLite identifiers are case-insensitive and sqlite_master keeps them as typed. This trigger
    // guards audit_log, and the documented repair (schema.sql's CREATE TRIGGER IF NOT EXISTS,
    // i.e. `npm run db:apply`) skips it because the name already exists. Paging on it would be a
    // nightly false alarm that no repair clears. Test DB only; seedDb drops audit_log with it.
    await env.DB.prepare('DROP TRIGGER audit_log_no_delete').run();
    await env.DB.prepare(
      "CREATE TRIGGER AUDIT_LOG_NO_DELETE BEFORE DELETE ON AUDIT_LOG BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
    ).run();
    await applySchema();
    await insertAuditRow();
    await expect(env.DB.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/);
    const { env: e, sent } = capturingEnv();

    const results = await executeScheduledRun(e);

    const task = results.find((r) => r.task === 'append_only_triggers');
    expect(task?.ok).toBe(true);
    expect(task?.detail).toMatch(/6\/6/);
    expect(sent).toHaveLength(0);
  });

  it('does not page for a recreate that differs only in quoting, layout, FOR EACH ROW or message', async () => {
    await env.DB.prepare('DROP TRIGGER audit_log_no_update').run();
    await env.DB.prepare(
      `CREATE TRIGGER "audit_log_no_update"
         before update on "audit_log" for each row
       begin
         select raise ( abort , 'rows in this table never change' ) ;
       end`,
    ).run();
    await expect(runAppendOnlyTriggerCheck(env as Env)).resolves.toMatch(/6\/6/);
  });

  it('pages when sqlite_master cannot be read — an unreadable list is not "none missing"', async () => {
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('D1_ERROR: simulated read failure');
        },
      },
    } as unknown as Env;
    await expect(runAppendOnlyTriggerCheck(broken)).rejects.toThrow(/simulated read failure/);
  });

  it('is read-only: the live schema is byte-identical before and after the check', async () => {
    // Compare rows only: the whole .all() result carries meta.duration, which varies by a
    // millisecond between runs and made this assertion flaky.
    const snapshot = async () =>
      (
        await env.DB.prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
        ).all()
      ).results;
    const before = await snapshot();
    await runAppendOnlyTriggerCheck(env as Env);
    // A failing check must not "repair" anything either.
    await env.DB.prepare('DROP TRIGGER ai_usage_no_delete').run();
    const dropped = await snapshot();
    await expect(runAppendOnlyTriggerCheck(env as Env)).rejects.toThrow(/ai_usage_no_delete/);
    expect(await snapshot()).toEqual(dropped);
    expect(dropped.length).toBe(before.length - 1);
  });

  it('does not advertise a missing trigger on the public /_health endpoint', async () => {
    // /_health is unauthenticated. "This app's audit log is writable right now" goes to the owner
    // by page, never to the internet.
    await env.DB.prepare('DROP TRIGGER audit_log_no_delete').run();
    const res = await healthResponse(env as Env);
    const body = await res.text();
    expect(body).not.toMatch(/trigger|append.only|worm/i);
  });
});

describe('APPEND_ONLY_TRIGGERS matches schema.sql', () => {
  it('lists exactly the triggers schema.sql defines on audit_log and ai_usage, on the right table and event', () => {
    const inSchema = [
      ...schemaSql.matchAll(
        /CREATE TRIGGER IF NOT EXISTS (\w+)\s+BEFORE\s+(\w+)\s+ON\s+(audit_log|ai_usage)\b/g,
      ),
    ].map((m) => ({ name: m[1] as string, event: m[2] as string, table: m[3] as string }));
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    expect(inSchema).toHaveLength(6);
    expect(
      APPEND_ONLY_TRIGGERS.map((t) => ({ name: t.name, event: t.event, table: t.table })).sort(
        byName,
      ),
    ).toEqual(inSchema.sort(byName));
    expect(APPEND_ONLY_TRIGGERS.map((t) => t.name).sort()).toEqual([...WORM_TRIGGERS].sort());
  });

  it("accepts schema.sql's own six statements, in the form SQLite stores them", () => {
    const stored = APPEND_ONLY_TRIGGERS.map((t) => ({
      name: t.name,
      table: t.table,
      sql: STORED_SQL.get(t.name) ?? '',
    }));
    expect(STORED_SQL.size).toBe(6);
    expect(missingAppendOnlyTriggers(stored)).toEqual([]);
  });
});

describe('missingAppendOnlyTriggers (pure rule)', () => {
  const all = APPEND_ONLY_TRIGGERS.map((t) => ({
    name: t.name,
    table: t.table,
    sql: STORED_SQL.get(t.name) ?? '',
  }));
  const withSql = (name: string, sql: string) =>
    all.map((t) => (t.name === name ? { ...t, sql } : t));

  it('is empty when all six are present, whatever else exists', () => {
    const extra = [
      { name: 'read_log_no_replace', table: 'read_log', sql: 'CREATE TRIGGER read_log_no_replace' },
      ...all,
    ];
    expect(missingAppendOnlyTriggers(extra)).toEqual([]);
  });

  it('matches trigger names case-insensitively, as SQLite does', () => {
    const present = all.map((t) =>
      t.name === 'audit_log_no_delete'
        ? {
            name: 'AUDIT_LOG_NO_DELETE',
            table: 'audit_log',
            sql: "CREATE TRIGGER AUDIT_LOG_NO_DELETE BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
          }
        : t,
    );
    expect(missingAppendOnlyTriggers(present)).toEqual([]);
  });

  it('matches table names case-insensitively, as SQLite does', () => {
    const present = all.map((t) =>
      t.name === 'ai_usage_no_update'
        ? {
            ...t,
            table: 'AI_USAGE',
            sql: "CREATE TRIGGER ai_usage_no_update BEFORE UPDATE ON AI_USAGE BEGIN SELECT RAISE(ABORT, 'ai_usage is append-only'); END",
          }
        : t,
    );
    expect(missingAppendOnlyTriggers(present)).toEqual([]);
  });

  it('does not flag differences in whitespace, quoting, keyword case, FOR EACH ROW or message', () => {
    const present = withSql(
      'audit_log_no_replace',
      'CREATE TRIGGER "audit_log_no_replace"  before insert ON [audit_log] FOR EACH ROW\n\twhen exists(select 1 from audit_log where id=new.id)\nbegin select raise ( abort , \'no rewrites, ever\' ) ; end',
    );
    expect(missingAppendOnlyTriggers(present)).toEqual([]);
  });

  it('does not flag a RAISE message written in double quotes or with a ) inside it', () => {
    // SQLite's grammar takes the message as a name token, so "text" and 'text (x)' are both valid.
    const doubleQuoted = withSql(
      'audit_log_no_update',
      'CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, "audit_log is append-only"); END',
    );
    expect(missingAppendOnlyTriggers(doubleQuoted)).toEqual([]);
    const parenthesised = withSql(
      'ai_usage_no_delete',
      "CREATE TRIGGER ai_usage_no_delete BEFORE DELETE ON ai_usage BEGIN SELECT RAISE(ABORT, 'ai_usage is append-only (WORM)'); END",
    );
    expect(missingAppendOnlyTriggers(parenthesised)).toEqual([]);
  });

  const neutered: Array<[string, string, string]> = [
    [
      'the wrong event and no RAISE (the one-statement neutering)',
      'audit_log_no_delete',
      'CREATE TRIGGER audit_log_no_delete BEFORE INSERT ON audit_log WHEN 0 BEGIN SELECT 1; END',
    ],
    [
      'a WHEN clause that never fires',
      'audit_log_no_delete',
      "CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log WHEN 0 BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
    ],
    [
      'an UPDATE OF column list that narrows the guard',
      'audit_log_no_update',
      "CREATE TRIGGER audit_log_no_update BEFORE UPDATE OF id ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
    ],
    [
      'a RAISE that can never run',
      'ai_usage_no_update',
      "CREATE TRIGGER ai_usage_no_update BEFORE UPDATE ON ai_usage BEGIN SELECT RAISE(ABORT, 'x') WHERE 0; END",
    ],
    [
      'a RAISE with a bare message that can never run',
      'audit_log_no_update',
      'CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, x) WHERE 0; END',
    ],
    [
      'a replace guard whose WHEN never fires',
      'ai_usage_no_replace',
      "CREATE TRIGGER ai_usage_no_replace BEFORE INSERT ON ai_usage WHEN 0 BEGIN SELECT RAISE(ABORT, 'ai_usage is append-only'); END",
    ],
    [
      'RAISE(ABORT and the right event appear only inside a string literal',
      'ai_usage_no_delete',
      "CREATE TRIGGER ai_usage_no_delete BEFORE DELETE ON ai_usage WHEN 0 BEGIN SELECT 'RAISE(ABORT, before delete on ai_usage)'; END",
    ],
  ];
  for (const [label, name, sql] of neutered) {
    it(`flags a same-named trigger on the right table that was altered: ${label}`, () => {
      expect(missingAppendOnlyTriggers(withSql(name, sql))).toEqual([
        expect.stringContaining(`${name} (altered`),
      ]);
    });
  }

  it('reports every required trigger when none exist', () => {
    expect(missingAppendOnlyTriggers([])).toHaveLength(6);
  });

  it('reports a missing one and a misplaced one with distinct reasons', () => {
    const present = all
      .filter((t) => t.name !== 'ai_usage_no_replace')
      .map((t) => (t.name === 'audit_log_no_update' ? { ...t, table: 'notes' } : t));
    expect(missingAppendOnlyTriggers(present)).toEqual([
      'audit_log_no_update (on another table, expected on audit_log)',
      'ai_usage_no_replace (missing, expected on ai_usage)',
    ]);
  });

  it('never echoes a live table name, which anyone with D1 write access can choose', () => {
    // The reason lands in the alert email, the console log and the heartbeat audit row. Only the
    // kit's own identifiers (APPEND_ONLY_TRIGGERS) may appear in it, never text read back from
    // the live schema.
    const hostile = 'URGENT: audit restore needed, sign in at https://attacker.example/restore';
    const present = all.map((t) =>
      t.name === 'audit_log_no_delete' ? { ...t, table: hostile } : t,
    );
    const problems = missingAppendOnlyTriggers(present);
    expect(problems).toEqual(['audit_log_no_delete (on another table, expected on audit_log)']);
    expect(problems.join('\n')).not.toMatch(/URGENT|attacker\.example|sign in/);
  });
});

describe('metaRepo.triggers', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('lists live triggers with their table and stored definition, sorted by name', async () => {
    const triggers = await makeDb(env as Env).meta.triggers();
    const names = triggers.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(triggers).toContainEqual({
      name: 'audit_log_no_delete',
      table: 'audit_log',
      sql: STORED_SQL.get('audit_log_no_delete'),
    });
    expect(triggers).toContainEqual({
      name: 'ai_usage_no_replace',
      table: 'ai_usage',
      sql: STORED_SQL.get('ai_usage_no_replace'),
    });
  });

  it('throws on a failed read rather than returning an empty list', async () => {
    const broken = {
      prepare: () => ({
        all: async () => {
          throw new Error('D1_ERROR: overloaded');
        },
      }),
    } as unknown as D1Database;
    await expect(metaRepo(broken).triggers()).rejects.toThrow(/overloaded/);
  });
});
