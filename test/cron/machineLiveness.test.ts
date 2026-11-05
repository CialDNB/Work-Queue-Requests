// The daily machine-liveness check (src/cron/machineLiveness.ts): "no machine batch in N hours",
// lifted from insights#271. Pure rule first, then the task against a real audit_log and a
// test-local route table. The kit ships no machine route, but a fork that adopts B9 does, and this
// file rides /kit-upgrade: no case may assume the app's own table (allRoutes) has none. All rows
// are synthetic.
//
// The reference below is Vite's `import.meta.glob` typing (see the note in test/helpers/db.ts), for
// reading the GO-LIVE gate 13 evidence rule out of the docs that state it.
/// <reference types="vite/types/import-meta.d.ts" />
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executeScheduledRun } from '../../src/cron';
import {
  assessMachineLiveness,
  MACHINE_LIVENESS_HOURS_DEFAULT,
  machineAuditActions,
  machineLivenessArmed,
  machineLivenessHours,
  machineLivenessSlackText,
  parseAuditTimestamp,
  runMachineLiveness,
} from '../../src/cron/machineLiveness';
import type { Env } from '../../src/env';
import { defineRoute, type RouteDef } from '../../src/framework/defineRoute';
import { allRoutes } from '../../src/routes';
import { applySchema, seedDb, USERS } from '../helpers/db';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const hoursAgo = (h: number): string =>
  new Date(NOW - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19); // SQLite shape

const machine = (path: string, audit: string | false): RouteDef =>
  defineRoute({
    method: 'POST',
    path,
    permission: 'notes.write',
    machine: true,
    audit,
    input: z.object({}),
    handler: async () => ({}),
  });

// GO-LIVE gate 13's evidence rule — "the `machine_liveness` detail <ends|contains> `<needle>` and
// does not contain `<forbidden>`" — read from every file that states it. The carried /go-live skill
// always does; the others only where they exist and state it: a fork's own docs/GO-LIVE.md is not
// carried (it may not have gate 13 yet), CHANGELOG.md is the kit's, and a plugin mirror of the
// skill exists only where one is kept (`plugins/*`, so this file stays free of the template name).
const GATE_13_DOCS = import.meta.glob<string>(
  [
    '../../.claude/skills/go-live/SKILL.md',
    '../../docs/GO-LIVE.md',
    '../../CHANGELOG.md',
    '../../plugins/*/skills/go-live/SKILL.md',
  ],
  { query: '?raw', import: 'default', eager: true },
);
const GATE_13_RULE =
  /`machine_liveness`(?:'s)?\s+detail\s+(ends|contains)\s+`([^`]+)`\s+and\s+does\s+not\s+contain\s+`([^`]+)`/g;

interface Gate13Rule {
  file: string;
  op: string;
  needle: string;
  forbidden: string;
}

function gate13Rules(): Gate13Rule[] {
  return Object.entries(GATE_13_DOCS).flatMap(([file, text]) =>
    [...text.matchAll(GATE_13_RULE)].map((m) => ({
      file,
      op: m[1] ?? '',
      needle: m[2] ?? '',
      forbidden: m[3] ?? '',
    })),
  );
}

/** Whether `detail` passes the rule as written — what a /go-live run following it would report. */
function gate13Passes({ op, needle, forbidden }: Gate13Rule, detail: string): boolean {
  const found = op === 'ends' ? detail.endsWith(needle) : detail.includes(needle);
  return found && !detail.includes(forbidden);
}

const ROUTES: RouteDef[] = [
  machine('/api/ingest/orders', 'ingest.orders'),
  machine('/api/ingest/decisions', 'ingest.decisions'),
  machine('/api/ingest/decisions-again', 'ingest.decisions'), // same action, one stream
  machine('/api/ingest/ping', false), // no audit row, so not a stream
  defineRoute({
    method: 'POST',
    path: '/api/notes-like',
    permission: 'notes.write',
    audit: 'note.create', // a person route: never a machine stream
    input: z.object({}),
    handler: async () => ({}),
  }),
];

describe('machine liveness — settings', () => {
  it('N defaults to 6 and a typo never disarms it', () => {
    expect(MACHINE_LIVENESS_HOURS_DEFAULT).toBe(6);
    for (const raw of [undefined, '', '  ', 'six', '0', '-3', '1.5', 'NaN']) {
      expect(machineLivenessHours(raw)).toBe(6);
    }
    expect(machineLivenessHours('12')).toBe(12);
    expect(machineLivenessHours(' 1 ')).toBe(1);
  });

  it('only the word true arms it', () => {
    for (const raw of ['true', 'TRUE', ' True ']) expect(machineLivenessArmed(raw)).toBe(true);
    for (const raw of [undefined, '', 'yes', '1', 'on', 'armed', 'false']) {
      expect(machineLivenessArmed(raw)).toBe(false);
    }
  });

  it('the streams are the distinct audit actions of machine routes only', () => {
    expect(machineAuditActions(ROUTES)).toEqual(['ingest.decisions', 'ingest.orders']);
  });

  it('reads SQLite timestamps as UTC', () => {
    expect(parseAuditTimestamp('2026-09-24 12:00:00')).toBe(NOW);
    expect(parseAuditTimestamp('2026-09-24T12:00:00Z')).toBe(NOW);
    expect(Number.isNaN(parseAuditTimestamp('yesterday'))).toBe(true);
  });
});

describe('machine liveness — the rule (aggregated: every stream quiet)', () => {
  const at = (orders: string | null, decisions: string | null) => [
    { action: 'ingest.decisions', lastAt: decisions },
    { action: 'ingest.orders', lastAt: orders },
  ];

  it('live when the newest machine row of ANY stream is within N hours', () => {
    expect(assessMachineLiveness(at(hoursAgo(1), hoursAgo(30)), NOW, 6).stale).toBe(false);
    expect(assessMachineLiveness(at(hoursAgo(6), null), NOW, 6).stale).toBe(false); // exactly N
  });

  it('stale when every stream is older than N hours', () => {
    const a = assessMachineLiveness(at(hoursAgo(7), hoursAgo(9)), NOW, 6);
    expect(a.stale).toBe(true);
    expect(a.newestAgeHours).toBeCloseTo(7);
  });

  it('a database that never received a machine row is silent unless armed', () => {
    expect(assessMachineLiveness(at(null, null), NOW, 6).stale).toBe(false);
    const armed = assessMachineLiveness(at(null, null), NOW, 6, true);
    expect(armed).toMatchObject({ stale: true, neverReceived: true, newestAgeHours: null });
  });

  it('arming changes nothing once rows exist', () => {
    expect(assessMachineLiveness(at(hoursAgo(1), null), NOW, 6, true).stale).toBe(false);
    expect(assessMachineLiveness(at(hoursAgo(8), null), NOW, 6, false).stale).toBe(true);
  });

  it('rows whose timestamps cannot be read cannot show liveness: stale', () => {
    expect(assessMachineLiveness(at('garbage', null), NOW, 6).stale).toBe(true);
    // …but one readable, fresh stream is enough.
    expect(assessMachineLiveness(at('garbage', hoursAgo(1)), NOW, 6).stale).toBe(false);
  });

  it('a row dated in the future (clock skew) is live', () => {
    expect(assessMachineLiveness(at(hoursAgo(-2), null), NOW, 6).stale).toBe(false);
  });

  it('the Slack line carries action names and ages only', () => {
    const a = assessMachineLiveness(at(hoursAgo(7), null), NOW, 6);
    const text = machineLivenessSlackText('app', 'staging', a, 6);
    expect(text).toContain('[app/staging] machine liveness: no machine batch in over 6h');
    expect(text).toContain('• ingest.orders: last row 7.0h ago');
    expect(text).toContain('• ingest.decisions: never received');
  });
});

describe('machine liveness — the task', () => {
  beforeAll(applySchema);
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await seedDb();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    errSpy.mockRestore();
  });

  // A machine row is written by the service identity that called the route; `actor` overrides it
  // for the rows a person writes under the same action.
  async function row(action: string, createdAt: string, actor = 'svc-etl@test-app.invalid') {
    await env.DB.prepare(
      'INSERT INTO audit_log (actor_email, action, target, payload_json, ip, created_at) VALUES (?, ?, NULL, NULL, NULL, ?)',
    )
      .bind(actor, action, createdAt)
      .run();
  }

  // Alerts go through the seam; with no EMAIL binding and no webhook it sends nothing, and the
  // detail reports what it did. That is enough to tell "alerted" from "clear".
  const bare = (vars: Partial<Env> = {}): Env =>
    ({ ...env, EMAIL: undefined, ALERT_WEBHOOK_URL: undefined, ...vars }) as Env;

  it('skips, reading nothing, when the route table has no machine route (the kit as shipped)', async () => {
    const prepare = vi.spyOn(env.DB, 'prepare');
    try {
      expect(await runMachineLiveness(bare(), [])).toBe(
        'machine liveness: skipped (no machine routes)',
      );
      expect(await runMachineLiveness(bare(), ROUTES.slice(3))).toBe(
        'machine liveness: skipped (no machine routes)',
      ); // a machine route with no audit row, and a person route: still no stream
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });

  it("reads the app's own route table by default", async () => {
    expect(await runMachineLiveness(bare())).toBe(await runMachineLiveness(bare(), allRoutes));
  });

  it('clear when a machine batch landed within N hours', async () => {
    await row('ingest.orders', hoursAgo(2));
    await row('ingest.decisions', hoursAgo(40));
    const detail = await runMachineLiveness(bare(), ROUTES);
    expect(detail).toMatch(/^machine liveness: clear \(/);
    expect(detail).toContain('ingest.orders 2.0h ago');
    expect(detail).toContain('ingest.decisions 40.0h ago');
  });

  it('stale when every machine stream is quiet for more than N hours — and still a green detail', async () => {
    await row('ingest.orders', hoursAgo(7));
    await row('ingest.decisions', hoursAgo(9));
    await row('note.create', hoursAgo(0)); // a person write is not a machine batch
    const detail = await runMachineLiveness(bare(), ROUTES);
    expect(detail).toMatch(/^machine liveness: stale \(/);
    expect(detail).toContain('emailed 0/');
  });

  it('counts only rows a SERVICE wrote: a person writing the same action never resets the clock', async () => {
    // The ETL's last batch landed 30h ago (its token has since expired). An admin re-imports
    // through a person route that declares the same action, and a person-route handler writes the
    // other action as a ctx.audit() extra. Neither is a machine batch.
    await row('ingest.orders', hoursAgo(30));
    await row('ingest.orders', hoursAgo(1), USERS.admin);
    await row('ingest.decisions', hoursAgo(2), USERS.member);
    const detail = await runMachineLiveness(bare(), ROUTES);
    expect(detail).toMatch(/^machine liveness: stale \(/);
    expect(detail).toContain('ingest.orders 30.0h ago');
    expect(detail).toContain('ingest.decisions never');
    // …and a person's row is no first machine row either: unarmed, this database is still silent.
    await seedDb();
    await row('ingest.orders', hoursAgo(1), USERS.admin);
    expect(await runMachineLiveness(bare(), ROUTES)).toMatch(/^machine liveness: clear \(.*never/);
  });

  it('a service writing the action through an ordinary route still counts: the integration got through', async () => {
    await row('ingest.orders', hoursAgo(1), 'svc-crm@test-app.invalid');
    expect(await runMachineLiveness(bare(), ROUTES)).toContain('ingest.orders 1.0h ago');
  });

  it('a failing audit read rejects (the loop pages it as a task failure) — it is never read as "never"', async () => {
    // Unarmed, "never" reads clear: mapping a read error to "no row" would turn an unreadable log
    // into a green detail. Only the liveness read fails here; the settings read stays live.
    const real = env.DB.prepare.bind(env.DB);
    const prepare = vi.spyOn(env.DB, 'prepare').mockImplementation((query: string) => {
      if (query.includes('FROM audit_log')) throw new Error('D1_ERROR: synthetic outage');
      return real(query);
    });
    try {
      await expect(runMachineLiveness(bare(), ROUTES)).rejects.toThrow(/synthetic outage/);
      await expect(
        runMachineLiveness(bare({ MACHINE_LIVENESS_ARMED: 'true' }), ROUTES),
      ).rejects.toThrow(/synthetic outage/);
    } finally {
      prepare.mockRestore();
    }
  });

  it('the stale detail reports the alert it sent: emailed, failed and the webhook', async () => {
    await row('ingest.orders', hoursAgo(7));
    const posted: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      posted.push(String(url));
      return new Response('ok');
    });
    const targets = {
      ALERT_EMAIL: 'ops@test.example, oncall@test.example',
      ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
    };
    try {
      const failing = { send: async () => Promise.reject(new Error('smtp down')) };
      expect(
        await runMachineLiveness(
          bare({ ...targets, EMAIL: failing as unknown as Env['EMAIL'] }),
          ROUTES,
        ),
      ).toMatch(/ — emailed 0\/2 \(2 failed\) \+ slack$/);
      const sending = { send: async () => undefined };
      expect(
        await runMachineLiveness(
          bare({ ...targets, EMAIL: sending as unknown as Env['EMAIL'] }),
          ROUTES,
        ),
      ).toMatch(/ — emailed 2\/2 \+ slack$/);
      expect(posted).toEqual([targets.ALERT_WEBHOOK_URL, targets.ALERT_WEBHOOK_URL]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('names warn-only X-Sync-Run in the detail, the durable record /go-live reads (GO-LIVE gate 13)', async () => {
    await row('ingest.orders', hoursAgo(1));
    expect(await runMachineLiveness(bare({ MACHINE_SYNC_RUN: 'warn' }), ROUTES)).toMatch(
      /^machine liveness: clear \(.*; threshold 6h, sync-run warn-only\)$/,
    );
    expect(
      await runMachineLiveness(
        bare({ MACHINE_SYNC_RUN: 'warn', MACHINE_LIVENESS_ARMED: 'true' }),
        ROUTES,
      ),
    ).toMatch(/; threshold 6h, armed, sync-run warn-only\)$/);
    // Enforcing (unset, or a typo that stays enforcing) says nothing.
    for (const mode of [undefined, 'warn-only']) {
      expect(await runMachineLiveness(bare({ MACHINE_SYNC_RUN: mode }), ROUTES)).not.toContain(
        'warn-only',
      );
    }
  });

  it('the GO-LIVE gate 13 evidence rule, as each doc states it, passes an armed enforcing app whether clear or stale — and nothing else', async () => {
    // The gate's condition is the two settings, not a delivered batch: an app may go live before
    // its integration's first production batch, and the armed check then reads stale (and alerts).
    const rules = gate13Rules();
    expect(rules.some((r) => r.file.endsWith('/.claude/skills/go-live/SKILL.md'))).toBe(true);
    const ready: string[] = [];
    const notReady: string[] = [];
    const unready: Array<Partial<Env>> = [
      {}, // unarmed
      { MACHINE_SYNC_RUN: 'warn' },
      { MACHINE_SYNC_RUN: 'warn', MACHINE_LIVENESS_ARMED: 'true' },
    ];
    // Never received, last batch 7h ago, last batch 1h ago.
    for (const batch of [null, hoursAgo(7), hoursAgo(1)]) {
      if (batch !== null) await row('ingest.orders', batch);
      ready.push(await runMachineLiveness(bare({ MACHINE_LIVENESS_ARMED: 'true' }), ROUTES));
      for (const vars of unready) notReady.push(await runMachineLiveness(bare(vars), ROUTES));
    }
    expect(ready.map((d) => d.slice(0, d.indexOf(' (')))).toEqual([
      'machine liveness: stale',
      'machine liveness: stale',
      'machine liveness: clear',
    ]);
    for (const rule of rules) {
      for (const d of ready) expect(gate13Passes(rule, d), `${rule.file} on: ${d}`).toBe(true);
      for (const d of notReady) expect(gate13Passes(rule, d), `${rule.file} on: ${d}`).toBe(false);
    }
  });

  it('honours MACHINE_LIVENESS_HOURS', async () => {
    await row('ingest.orders', hoursAgo(7));
    expect(await runMachineLiveness(bare({ MACHINE_LIVENESS_HOURS: '12' }), ROUTES)).toMatch(
      /clear.*threshold 12h/,
    );
  });

  it('a never-written database: silent by default, stale when armed (and the detail says armed)', async () => {
    expect(await runMachineLiveness(bare(), ROUTES)).toMatch(/clear .*never.*threshold 6h\)$/);
    const armed = await runMachineLiveness(bare({ MACHINE_LIVENESS_ARMED: 'true' }), ROUTES);
    expect(armed).toMatch(/^machine liveness: stale \(.*threshold 6h, armed\)/);
  });

  it('reads the newest row per stream, never the whole log', async () => {
    for (let i = 0; i < 5; i++) await row('ingest.orders', hoursAgo(30 - i));
    await row('ingest.orders', hoursAgo(1));
    const prepare = vi.spyOn(env.DB, 'prepare');
    try {
      await runMachineLiveness(bare(), ROUTES);
      const sql = prepare.mock.calls.map((c) => c[0]);
      const reads = sql.filter((q) => q.includes('FROM audit_log'));
      expect(reads).toHaveLength(2); // one per stream
      for (const q of reads) {
        expect(q).toContain('ORDER BY id DESC LIMIT 1');
        expect(q).toContain("actor_email LIKE 'svc-%@%.invalid'"); // service rows only
        expect(q).not.toContain('payload_json');
      }
    } finally {
      prepare.mockRestore();
    }
  });
});

describe('machine liveness — in the daily loop', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it("is registered, and green there over the app's own route table", async () => {
    // The kit ships no machine route, so the kit's loop skips. A fork with machine routes runs the
    // check, and on a fresh test database it reads clear (or stale, if its test config arms it):
    // green either way — a stale sync is a digest finding, never a paged failure.
    const detail =
      machineAuditActions(allRoutes).length === 0
        ? 'machine liveness: skipped (no machine routes)'
        : expect.stringMatching(/^machine liveness: (clear|stale) \(/);
    const results = await executeScheduledRun(env);
    expect(results.find((r) => r.task === 'machine_liveness')).toEqual({
      task: 'machine_liveness',
      ok: true,
      detail,
    });
  });
});
