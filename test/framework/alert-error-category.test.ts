// ALERT ERROR CATEGORY (insights D1 growth plan, B13) — the two framework alerts that fire when the
// kit cannot write its own trail name WHICH KIND of D1 failure it was, and never repeat the text.
//
//   `read ledger FAILED (d1 flush)`  src/framework/readAudit.ts  (the read-attribution flush)
//   `audit write FAILED: <action>`   src/framework/execute.ts    (the declared audit write)
//
// Before this, both said `error class: Error` — true of every D1 failure — so an owner could not
// tell a busy database (contention: wait, or remove load) from a real bug (a constraint, a missing
// column) without opening Workers Logs, which expire within days. Each carries one category from a
// FIXED list now: overloaded, timeout/reset, network, constraint, other.
//
// Three things are pinned for every category, on both alerts:
//   1. the email and the Slack text carry `error category: <category>`;
//   2. NO RAW D1 TEXT reaches either. Every injected message carries a canary, and neither the
//      canary, the whole message, nor the message minus its `D1_ERROR: ` prefix may appear in the
//      subject, the body, or the webhook text. A D1 message can embed a column name, a CHECK
//      expression, a trigger's RAISE text or a bound value, and these alerts fan out to email and a
//      third-party webhook;
//   3. the failure's LOG line carries the category too, as its `category` field. The alerts are
//      throttled to one per window, so a second failure inside it sends nothing: its log line is
//      the only place its category can survive. And the log is no place to look for the MESSAGE
//      (insights staging's Workers Logs held only the stack; PIA C5 log hygiene keeps the error
//      class only), so no meaning may send the reader there for it.
import { env } from 'cloudflare:test';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../src/auth/types';
import type { Env } from '../../src/env';
import {
  D1_ERROR_CATEGORIES,
  D1_ERROR_CATEGORY_MEANING,
  d1ErrorCategory,
} from '../../src/framework/d1ErrorCategory';
import { defineRoute } from '../../src/framework/defineRoute';
import { executeRoute } from '../../src/framework/execute';
import { beginReadAudit, flushReadAudit, recordDb } from '../../src/framework/readAudit';
import { applySchema, seedDb, USERS } from '../helpers/db';

const CANARY = 'zz_canary_7f3a';

/**
 * One representative message per category, each carrying the canary. The prefixes are Cloudflare's
 * own (developers.cloudflare.com/d1/observability/debug-d1/); the constraint and `other` shapes are
 * what the workerd D1 binding actually throws for a SQLite error (`D1_ERROR: <sqlite text>:
 * SQLITE_<CODE>`), confirmed against the runtime these tests run in.
 */
const CASES = [
  {
    category: 'overloaded',
    message: `D1_ERROR: D1 DB is overloaded. Too many requests queued. ${CANARY}`,
  },
  {
    category: 'timeout/reset',
    message: `D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset. ${CANARY}`,
  },
  {
    category: 'network',
    message: `D1_ERROR: Network connection lost. ${CANARY}`,
  },
  {
    category: 'constraint',
    message: `D1_ERROR: NOT NULL constraint failed: audit_log.${CANARY}: SQLITE_CONSTRAINT`,
  },
  {
    category: 'other',
    message: `D1_ERROR: no such column: ${CANARY}: SQLITE_ERROR`,
  },
] as const;

const principal: Principal = {
  kind: 'person',
  email: USERS.member,
  name: null,
  role: 'member',
  authMethod: 'magic_link',
  credentialTransport: 'cookie',
};

/** A KV the alert throttle has never seen, so every test's alert is the first in its window. */
function freshKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
  } as unknown as KVNamespace;
}

interface Captured {
  env: Env;
  mails: Array<{ subject: string; text: string; html?: string }>;
  slack: string[];
}

/**
 * An env whose alert seam is observable: a fake EMAIL binding that keeps what it was handed, a
 * webhook whose POST bodies are kept, and a fresh throttle. Nothing leaves the test runtime.
 */
function capturing(base: Env = env as Env): Captured {
  const mails: Captured['mails'] = [];
  const slack: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: unknown, init: unknown) => {
    slack.push(String((init as RequestInit | undefined)?.body ?? ''));
    return new Response('ok');
  });
  return {
    env: {
      ...base,
      SESSIONS: freshKv(),
      EMAIL: { send: async (m: Captured['mails'][number]) => void mails.push(m) },
      ALERT_EMAIL: 'ops@test.example',
      ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
    } as unknown as Env,
    mails,
    slack,
  };
}

/**
 * A DB binding whose `INSERT INTO <table>` statement throws `message`; every other statement (the
 * alert seam's settings read, for one) reaches the real test database.
 */
function dbFailingInsertsInto(table: string, message: string): D1Database {
  const real = env.DB;
  const failing = {
    bind: () => failing,
    run: async () => {
      throw new Error(message);
    },
    all: async () => {
      throw new Error(message);
    },
    first: async () => {
      throw new Error(message);
    },
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) =>
          sql.startsWith(`INSERT INTO ${table} `) ? failing : target.prepare(sql);
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Everything the alert put in front of a person, as one string per surface. */
function surfaces(c: Captured): string[] {
  return [
    ...c.mails.flatMap((m) => [m.subject, m.text, m.html ?? '']),
    ...c.slack.map((body) => (JSON.parse(body) as { text: string }).text),
  ];
}

function expectNoRawText(c: Captured, message: string): void {
  const withoutPrefix = message.replace(/^D1_ERROR: /, '');
  for (const surface of surfaces(c)) {
    expect(surface).not.toContain(CANARY);
    expect(surface).not.toContain(message);
    expect(surface).not.toContain(withoutPrefix);
  }
}

/** Run a declared-audit mutation through the real pipeline and drain its background work. */
async function mutate(e: Env, action: string): Promise<unknown> {
  const pending: Promise<unknown>[] = [];
  try {
    return await executeRoute(
      e,
      defineRoute({
        method: 'POST',
        path: '/api/category-widgets',
        permission: 'authenticated',
        audit: action,
        input: z.object({}),
        handler: async () => ({ ok: true }),
      }).spec,
      principal,
      {
        ip: '',
        params: {},
        request: new Request('https://x.test/api/category-widgets', { method: 'POST' }),
        waitUntil: (p) => {
          pending.push(p);
        },
        invocation: { via: 'http' },
        buildRawInput: () => ({}),
      },
    );
  } finally {
    await Promise.allSettled(pending);
  }
}

/** Flush one recorded read into a ledger writer that throws `message`. */
async function flushInto(e: Env, message: string): Promise<void> {
  const recorder = beginReadAudit(USERS.member, 'GET /api/category-reads');
  const view = recordDb({ notes: { list: async () => ({ items: [1, 2] }) } }, recorder) as {
    notes: { list: () => Promise<unknown> };
  };
  await view.notes.list();
  await flushReadAudit(
    e,
    {
      insertManyComplete: async () => {
        throw new Error(message);
      },
    },
    recorder,
  );
}

/** Every logEvent record `console.error` printed under `event`, parsed, in order. */
function logLines(spy: MockInstance, event: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const args of spy.mock.calls) {
    if (args.length !== 1 || typeof args[0] !== 'string') continue;
    try {
      const record = JSON.parse(args[0]) as Record<string, unknown>;
      if (record.event === event) records.push(record);
    } catch {
      // not a logEvent line
    }
  }
  return records;
}

// The alert seam reads the in-app alerting settings before it sends, so the schema is in place
// for every block, not only the one that writes audit rows.
let errorSpy: MockInstance;
beforeAll(applySchema);
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('read ledger FAILED (d1 flush) carries an error category and no raw D1 text', () => {
  for (const { category, message } of CASES) {
    it(`${category}`, async () => {
      const c = capturing();
      await flushInto(c.env, message);

      expect(c.mails).toHaveLength(1);
      expect(c.mails[0]!.subject).toContain('read ledger FAILED (d1 flush)');
      expect(c.mails[0]!.text).toContain(`error category: ${category}\n`);
      expect(c.mails[0]!.text).toContain(`what it means: ${D1_ERROR_CATEGORY_MEANING[category]}\n`);
      expect(c.slack).toHaveLength(1);
      expect(c.slack[0]).toContain(`error category: ${category}`);
      expectNoRawText(c, message);
    });
  }
});

describe('audit write FAILED carries an error category and no raw D1 text', () => {
  beforeEach(seedDb);

  for (const { category, message } of CASES) {
    it(`${category}`, async () => {
      const c = capturing({ ...env, DB: dbFailingInsertsInto('audit_log', message) } as Env);
      const result = await mutate(c.env, 'widget.category');

      expect(result).toEqual({ ok: true }); // still fail-open
      expect(c.mails).toHaveLength(1);
      expect(c.mails[0]!.subject).toContain('audit write FAILED: widget.category');
      expect(c.mails[0]!.text).toContain(`error category: ${category}\n`);
      expect(c.mails[0]!.text).toContain(`what it means: ${D1_ERROR_CATEGORY_MEANING[category]}\n`);
      expect(c.slack).toHaveLength(1);
      expect(c.slack[0]).toContain(`error category: ${category}`);
      expectNoRawText(c, message);
    });
  }

  it('a REAL trigger abort from the workerd D1 binding is a constraint, and its RAISE text stays out', async () => {
    // Not an injected string: a genuine BEFORE INSERT trigger on the test database, so the message
    // shape is whatever the runtime's D1 binding produces for a SQLite constraint today
    // (`D1_ERROR: <raise text>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`).
    // In-memory test storage only; seedDb drops and recreates audit_log, which takes this trigger
    // with it.
    await env.DB.prepare(
      `CREATE TRIGGER zz_category_probe BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, '${CANARY} refused'); END`,
    ).run();
    const c = capturing();
    const result = await mutate(c.env, 'widget.category_real');

    expect(result).toEqual({ ok: true });
    expect(c.mails).toHaveLength(1);
    expect(c.mails[0]!.text).toContain('error category: constraint\n');
    expectNoRawText(c, `D1_ERROR: ${CANARY} refused`);
  });
});

describe('the category is LOGGED with each failure, so a throttled alert does not lose it', () => {
  beforeEach(seedDb);

  for (const { category, message } of CASES) {
    it(`read_audit_flush_failed carries category ${category}`, async () => {
      const c = capturing();
      await flushInto(c.env, message);
      const lines = logLines(errorSpy, 'read_audit_flush_failed');
      expect(lines).toHaveLength(1);
      expect(lines[0]?.category).toBe(category);
      expect(JSON.stringify(lines)).not.toContain(CANARY);
    });

    it(`audit_declared_write_failed carries category ${category}`, async () => {
      const c = capturing({ ...env, DB: dbFailingInsertsInto('audit_log', message) } as Env);
      await mutate(c.env, 'widget.category_log');
      const lines = logLines(errorSpy, 'audit_declared_write_failed');
      expect(lines).toHaveLength(1);
      expect(lines[0]?.category).toBe(category);
      expect(JSON.stringify(lines)).not.toContain(CANARY);
    });
  }

  it('read ledger: a second failure inside the window sends nothing, and its log line still names its category', async () => {
    const c = capturing();
    await flushInto(c.env, `D1_ERROR: D1 DB is overloaded. Too many requests queued. ${CANARY}`);
    await flushInto(c.env, `D1_ERROR: UNIQUE constraint failed: read_log.id: SQLITE_CONSTRAINT`);

    expect(c.mails).toHaveLength(1); // throttled: one alert per window
    expect(c.mails[0]!.text).toContain('error category: overloaded\n');
    expect(logLines(errorSpy, 'read_audit_alert_suppressed')).toHaveLength(1);
    const lines = logLines(errorSpy, 'read_audit_flush_failed');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.category)).toEqual(['overloaded', 'constraint']);
  });

  it('audit write: a second failure inside the window sends nothing, and its log line still names its category', async () => {
    const c = capturing({
      ...env,
      DB: dbFailingInsertsInto('audit_log', `D1_ERROR: Network connection lost. ${CANARY}`),
    } as Env);
    await mutate(c.env, 'widget.category_twice');
    await mutate(
      {
        ...c.env,
        DB: dbFailingInsertsInto('audit_log', `D1_ERROR: D1 DB is overloaded. ${CANARY}`),
      } as Env,
      'widget.category_twice',
    );

    expect(c.mails).toHaveLength(1); // the throttle is per action, and this is the same action
    expect(c.mails[0]!.text).toContain('error category: network\n');
    expect(logLines(errorSpy, 'audit_fail_alert_suppressed')).toHaveLength(1);
    const lines = logLines(errorSpy, 'audit_declared_write_failed');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.category)).toEqual(['network', 'overloaded']);
  });

  it('no meaning sends the reader to the logs for the message', () => {
    // Workers Logs are not where the message is: on insights staging the failure line held only
    // the stack, and PIA C5 log hygiene reduces a logged error to its class. `other` is the one
    // category that most needs the detail, so it says where the detail CAN come from.
    for (const category of D1_ERROR_CATEGORIES) {
      expect(D1_ERROR_CATEGORY_MEANING[category]).not.toMatch(/\blogs?\b|wrangler tail/i);
    }
    expect(D1_ERROR_CATEGORY_MEANING.other).toContain('reproduce it locally');
  });
});

describe('d1ErrorCategory — the fixed list and the known prefixes', () => {
  it('is exactly the five categories, spelled out', () => {
    // Hardcoded, like the permission matrix: changing the list has to be a conscious edit to a
    // test that names every entry, not a value that follows along.
    expect([...D1_ERROR_CATEGORIES]).toEqual([
      'overloaded',
      'timeout/reset',
      'network',
      'constraint',
      'other',
    ]);
    expect(Object.keys(D1_ERROR_CATEGORY_MEANING).sort()).toEqual([...D1_ERROR_CATEGORIES].sort());
  });

  // Every row of Cloudflare's D1 error table that names a transient platform condition, verbatim
  // (developers.cloudflare.com/d1/observability/debug-d1/), plus SQLite's constraint shapes as the
  // workerd binding throws them. Each is pinned with and without the `D1_ERROR: ` wrapper.
  const KNOWN: ReadonlyArray<readonly [string, string]> = [
    ['D1 DB is overloaded. Requests queued for too long.', 'overloaded'],
    ['D1 DB is overloaded. Too many requests queued.', 'overloaded'],
    ['D1 DB storage operation exceeded timeout which caused object to be reset.', 'timeout/reset'],
    ['D1 DB reset because its code was updated.', 'timeout/reset'],
    ['Internal error while starting up D1 DB storage caused object to be reset.', 'timeout/reset'],
    ['Internal error in D1 DB storage caused object to be reset.', 'timeout/reset'],
    ["D1 DB's isolate exceeded its memory limit and was reset.", 'timeout/reset'],
    ['D1 DB exceeded its CPU time limit and was reset.', 'timeout/reset'],
    ['Network connection lost.', 'network'],
    ['Replica disconnected from primary.', 'network'],
    ['Cannot resolve D1 DB due to transient issue on remote node.', 'network'],
    ["Can't read from request stream because client disconnected.", 'network'],
    ['UNIQUE constraint failed: notes.id: SQLITE_CONSTRAINT', 'constraint'],
    [
      'NOT NULL constraint failed: audit_log.actor_email: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)',
      'constraint',
    ],
    ['CHECK constraint failed: n > 0: SQLITE_CONSTRAINT', 'constraint'],
    ['FOREIGN KEY constraint failed: SQLITE_CONSTRAINT', 'constraint'],
    // A trigger abort: no fixed prefix, recognised by the result code D1 appends.
    [
      'audit_log is append-only: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
      'constraint',
    ],
    ['read_log rows are never overwritten: SQLITE_CONSTRAINT', 'constraint'],
  ];

  for (const [message, category] of KNOWN) {
    it(`${category} <- ${message.slice(0, 48)}`, () => {
      expect(d1ErrorCategory(new Error(`D1_ERROR: ${message}`))).toBe(category);
      expect(d1ErrorCategory(new Error(message))).toBe(category);
    });
  }

  it("strips a rethrow's `Error: ` wrapper as well as `D1_ERROR: `", () => {
    expect(
      d1ErrorCategory(new Error('Error: D1_ERROR: D1 DB is overloaded. Too many requests queued.')),
    ).toBe('overloaded');
    expect(d1ErrorCategory(new Error('D1_ERROR: Error: Network connection lost.'))).toBe('network');
  });

  it('is `other` for everything it does not know — never a fragment of the message', () => {
    for (const message of [
      'D1_ERROR: no such table: read_log: SQLITE_ERROR',
      'D1_ERROR: too many SQL variables: SQLITE_ERROR',
      'D1_ERROR: Memory limit exceeded before EOF.',
      "D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'",
      'D1_ERROR: Exceeded maximum DB size.',
      // A mention of the code mid-sentence is not the code D1 appends.
      'D1_ERROR: SQLITE_CONSTRAINT: something else entirely',
      // A known phrase that is not at the start is not a known prefix.
      'wrapped: D1 DB is overloaded. Too many requests queued.',
      '',
    ]) {
      expect(d1ErrorCategory(new Error(message))).toBe('other');
    }
  });

  it('never throws, whatever was thrown', () => {
    const hostile = Object.create(null, {
      message: {
        get() {
          throw new Error('hostile getter');
        },
      },
    });
    expect(d1ErrorCategory(hostile)).toBe('other');
    expect(d1ErrorCategory('D1_ERROR: D1 DB is overloaded. Too many requests queued.')).toBe(
      'other',
    );
    expect(d1ErrorCategory(undefined)).toBe('other');
    expect(d1ErrorCategory(null)).toBe('other');
    expect(d1ErrorCategory({ message: 42 })).toBe('other');
    // A non-Error object with a string message is classified: a rejected value need not be an
    // Error instance from this realm to carry D1's text.
    expect(d1ErrorCategory({ message: 'D1_ERROR: Network connection lost.' })).toBe('network');
  });
});
