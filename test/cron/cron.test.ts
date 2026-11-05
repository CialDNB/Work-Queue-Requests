import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DAILY_OPS_CRON,
  executeScheduledRun,
  firesAtMostOnceADay,
  runScheduled,
  UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS,
} from '../../src/cron';
import { SECURITY_WATCH_CRON } from '../../src/cron/auditWatch';
import { FALLBACK_CLAIM_KEY } from '../../src/cron/heartbeat';
import {
  pruneReadLog,
  READ_LOG_PRUNE_MAX_OVERDUE_DAYS,
  READ_LOG_RETENTION_DAYS_DEFAULT,
  readLogPruneOutcome,
  readLogRetentionDays,
} from '../../src/cron/prune';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import productionConfig from '../../wrangler.jsonc?raw';
import stagingConfig from '../../wrangler.staging.jsonc?raw';
import { addFullThread, addMessage, addPurge, countRows } from '../helpers/agentRows';
import { applySchema, seedDb, USERS } from '../helpers/db';

async function gunzipToText(body: ReadableStream): Promise<string> {
  return new Response(body.pipeThrough(new DecompressionStream('gzip'))).text();
}

describe('daily ops cron', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('runs all tasks green and records a heartbeat with per-task results', async () => {
    const results = await executeScheduledRun(env);
    expect(results.every((r) => r.ok)).toBe(true);

    const heartbeat = await env.SESSIONS.get('heartbeat:last');
    expect(heartbeat).toBeTruthy();
    expect(Date.now() - Date.parse(heartbeat as string)).toBeLessThan(10_000);

    const audit = await env.DB.prepare(
      "SELECT payload_json FROM audit_log WHERE action = 'cron_heartbeat_done'",
    ).first<{ payload_json: string }>();
    expect(audit).toBeTruthy();
    const payload = JSON.parse(audit?.payload_json ?? '{}') as { results: { task: string }[] };
    expect(payload.results.map((r) => r.task)).toContain('backup');
  });

  it('writes a daily gzipped JSONL backup to R2 with a meta header', async () => {
    await executeScheduledRun(env);
    const day = new Date().toISOString().slice(0, 10);
    const object = await env.BACKUPS!.get(`db-backups/${day}.jsonl.gz`);
    expect(object).toBeTruthy();
    const text = await gunzipToText(object!.body);
    const lines = text.split('\n');
    const meta = JSON.parse(lines[0] as string) as { _meta: string; tables: string[] };
    expect(meta._meta).toBe('work-queue-requests-d1-backup');
    expect(meta.tables).toContain('users');
    // Seeded users appear as rows tagged with their table.
    expect(text).toContain(`"_table":"users"`);
    expect(text).toContain(USERS.owner);

    const marker = await env.BACKUPS!.get('db-backups/latest-marker');
    expect(marker).toBeTruthy();
  });

  it('never writes magic_links (live login tokens) into a backup (AICOE-204)', async () => {
    const liveToken = 'secret-live-magic-token-do-not-leak';
    await env.DB.prepare(
      "INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))",
    )
      .bind(liveToken, USERS.member)
      .run();

    await executeScheduledRun(env);
    const day = new Date().toISOString().slice(0, 10);
    const object = await env.BACKUPS!.get(`db-backups/${day}.jsonl.gz`);
    const text = await gunzipToText(object!.body);
    const meta = JSON.parse((text.split('\n')[0] as string) ?? '{}') as { tables: string[] };

    expect(meta.tables).not.toContain('magic_links');
    expect(text).not.toContain('"_table":"magic_links"');
    expect(text).not.toContain(liveToken);
  });

  it('never writes an agent_* table (transcripts) into a backup — every one, by prefix (narrows the PIA C19 exposure)', async () => {
    // One row in every agent table, carrying a marker the dump must not contain.
    const marker = 'synthetic-transcript-marker';
    const { threadId } = await addFullThread();
    await addMessage(threadId, { content: `a question about ${marker}` });
    await addPurge('turn-awaiting-purge');

    await executeScheduledRun(env);
    const day = new Date().toISOString().slice(0, 10);
    const object = await env.BACKUPS!.get(`db-backups/${day}.jsonl.gz`);
    const text = await gunzipToText(object!.body);
    const meta = JSON.parse((text.split('\n')[0] as string) ?? '{}') as { tables: string[] };

    expect(meta.tables.filter((t) => t.startsWith('agent_'))).toEqual([]);
    expect(meta.tables).toContain('users'); // the rest of the database is still backed up
    expect(text).not.toContain('"_table":"agent_');
    expect(text).not.toContain(marker);
    // The rows are still in D1: the exclusion is from the copy, not from the store.
    expect(await countRows('agent_messages', 'thread_id = ?', threadId)).toBe(3);
  });

  it('prunes magic links that expired more than 7 days ago', async () => {
    await env.DB.prepare(
      "INSERT INTO magic_links (token, email, expires_at) VALUES ('old-token', ?, datetime('now', '-10 days'))",
    )
      .bind(USERS.member)
      .run();
    await env.DB.prepare(
      "INSERT INTO magic_links (token, email, expires_at) VALUES ('fresh-token', ?, datetime('now', '+10 minutes'))",
    )
      .bind(USERS.member)
      .run();
    await executeScheduledRun(env);
    const remaining = await env.DB.prepare('SELECT token FROM magic_links').all<{
      token: string;
    }>();
    expect(remaining.results.map((r) => r.token)).toEqual(['fresh-token']);
  });

  it('prunes daily backups past the retention window, keeping today + the marker (AICOE-207)', async () => {
    // An ancient daily backup + a recent one + the marker.
    await env.BACKUPS!.put('db-backups/2020-01-01.jsonl.gz', 'old');
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await env.BACKUPS!.put(`db-backups/${recent}.jsonl.gz`, 'recent');

    await executeScheduledRun(env);

    const today = new Date().toISOString().slice(0, 10);
    expect(await env.BACKUPS!.head('db-backups/2020-01-01.jsonl.gz')).toBeNull(); // past retention → gone
    expect(await env.BACKUPS!.head(`db-backups/${recent}.jsonl.gz`)).toBeTruthy(); // within window → kept
    expect(await env.BACKUPS!.head(`db-backups/${today}.jsonl.gz`)).toBeTruthy(); // today → kept
    expect(await env.BACKUPS!.head('db-backups/latest-marker')).toBeTruthy(); // marker → kept
  });

  it('prunes ai_budget_reservations older than the window, keeping recent days (AICOE-207)', async () => {
    await env.DB.prepare(
      "INSERT INTO ai_budget_reservations (scope, day, reserved_usd) VALUES ('g', ?, 1)",
    )
      .bind('2020-01-01')
      .run();
    const recentDay = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO ai_budget_reservations (scope, day, reserved_usd) VALUES ('g', ?, 2)",
    )
      .bind(recentDay)
      .run();

    await executeScheduledRun(env);

    const days = await env.DB.prepare('SELECT day FROM ai_budget_reservations ORDER BY day').all<{
      day: string;
    }>();
    expect(days.results.map((r) => r.day)).toEqual([recentDay]); // ancient row pruned, recent kept
  });

  it('reports the budget-reservation prune as a green cron task', async () => {
    const results = await executeScheduledRun(env);
    const task = results.find((r) => r.task === 'prune_budget_reservations');
    expect(task?.ok).toBe(true);
  });

  it('redacts the Slack webhook from app_settings in the backup (AICOE-227)', async () => {
    // The app_settings table is backed up (operational config worth restoring), but the alerting
    // override embeds a Slack webhook URL — a post-only channel credential. It must not land in a
    // binding-only R2 blob, so the dump redacts that one field while keeping the rest of the row.
    const secret = 'https://hooks.slack.com/services/T00/B00/SUPERSECRETWEBHOOKTOKEN';
    await makeDb(env).settings.setAlerting(
      { recipients: ['ops@test.example'], slackWebhookUrl: secret },
      USERS.owner,
    );
    await executeScheduledRun(env);
    const day = new Date().toISOString().slice(0, 10);
    const object = await env.BACKUPS!.get(`db-backups/${day}.jsonl.gz`);
    const text = await gunzipToText(object!.body);
    expect(text).toContain('"_table":"app_settings"'); // table still backed up
    expect(text).not.toContain('SUPERSECRETWEBHOOKTOKEN'); // live credential is NOT
    expect(text).toContain('[redacted]'); // redaction marker present
    expect(text).toContain('ops@test.example'); // non-secret settings preserved
  });
});

describe('cron dispatch by controller.cron', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  // ctx.waitUntil collects the work promise so the test can await it. Only waitUntil is used, so
  // the rest of ExecutionContext is stubbed via an unknown cast.
  function fakeCtx() {
    const work: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => void work.push(p),
    } as unknown as ExecutionContext;
    return { ctx, work };
  }

  const heartbeatAgo = (hours: number) =>
    env.SESSIONS.put('heartbeat:last', new Date(Date.now() - hours * 3_600_000).toISOString());

  /** The `cron_trigger_unrecognized` lines logEvent wrote to console.warn, parsed. */
  function unrecognizedLines(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return warn.mock.calls
      .map((args) => JSON.parse(String(args[0])) as Record<string, unknown>)
      .filter((line) => line.event === 'cron_trigger_unrecognized');
  }

  /**
   * `env` with SESSIONS calls for which `fails(op, key)` is true rejecting (a KV fault), and every
   * other call reaching the real namespace.
   */
  function kvFaulty(fails: (op: 'get' | 'put', key: string) => boolean): Env {
    const kv = env.SESSIONS as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const through =
      (op: string) =>
      (...args: unknown[]) =>
        (op === 'get' || op === 'put') && fails(op, String(args[0]))
          ? Promise.reject(new TypeError('kv unavailable in this test'))
          : (kv[op] as (...a: unknown[]) => Promise<unknown>).apply(env.SESSIONS, args);
    const sessions = Object.fromEntries(
      ['get', 'getWithMetadata', 'put', 'delete', 'list'].map((op) => [op, through(op)]),
    );
    return { ...env, SESSIONS: sessions } as unknown as Env;
  }

  /** The live `triggers.crons` of a wrangler config (commented-out lines ignored). */
  const declared = (jsonc: string): string[] => {
    const live = jsonc
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const list = live.match(/"crons"\s*:\s*\[([^\]]*)\]/)?.[1];
    if (list === undefined) throw new Error('no triggers.crons in the config');
    return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
  };

  const auditRows = async () =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>())?.n;
  const backupKeys = async () => (await env.BACKUPS!.list()).objects.map((o) => o.key).sort();

  it('routes the hourly tripwire cron to runAuditWatch (dormant: no token → audited skip, no ops run)', async () => {
    const { ctx, work } = fakeCtx();
    // env has no AUDIT_API_TOKEN in the test config → the tripwire no-ops + audits a skip.
    await runScheduled({ cron: SECURITY_WATCH_CRON } as ScheduledController, env, ctx);
    await Promise.all(work);

    const skipped = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit_watch_skipped'",
    ).first<{ n: number }>();
    expect(skipped?.n).toBe(1);
    // The daily ops loop did NOT run on this cron (no heartbeat written).
    expect(await env.SESSIONS.get('heartbeat:last')).toBeNull();
  });

  it('routes the hourly tripwire cron to runAuditWatch however stale the heartbeat: a recognized trigger never falls back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await heartbeatAgo(48);
    const before = await env.SESSIONS.get('heartbeat:last');
    const { ctx, work } = fakeCtx();
    await runScheduled({ cron: SECURITY_WATCH_CRON } as ScheduledController, env, ctx);
    await Promise.all(work);

    expect(work).toHaveLength(1);
    expect(await env.SESSIONS.get('heartbeat:last')).toBe(before); // the loop did not run
    expect(unrecognizedLines(warn)).toEqual([]);
  });

  // No pin on DAILY_OPS_CRON's literal: a fork may move its daily (insights runs at 30 3 * * *).
  // What matters is that both wrangler configs declare it, pinned below.
  it('routes the daily cron to the ops loop (heartbeat written, tripwire not run)', async () => {
    const { ctx, work } = fakeCtx();
    await runScheduled({ cron: DAILY_OPS_CRON } as ScheduledController, env, ctx);
    await Promise.all(work);

    expect(await env.SESSIONS.get('heartbeat:last')).toBeTruthy();
    const skipped = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit_watch_skipped'",
    ).first<{ n: number }>();
    expect(skipped?.n).toBe(0); // tripwire did not run on the daily cron
  });

  it('the daily cron runs the ops loop however fresh the heartbeat, and logs nothing about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await heartbeatAgo(0);
    const before = await env.SESSIONS.get('heartbeat:last');
    const { ctx, work } = fakeCtx();
    await runScheduled({ cron: DAILY_OPS_CRON } as ScheduledController, env, ctx);
    expect(work).toHaveLength(1);
    await Promise.all(work);

    expect(await env.SESSIONS.get('heartbeat:last')).not.toBe(before); // rewritten by this run
    expect(unrecognizedLines(warn)).toEqual([]);
  });

  // Only the `controller.cron !== DAILY_OPS_CRON` short-circuit keeps the daily trigger off the
  // heartbeat and the claim. A refactor that reads either first (to log the age on every tick,
  // say) would let a KV read outage at 03:00 reject the daily tick: no backup and no page.
  it('the daily cron runs the ops loop when KV will not give up the heartbeat or the claim', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noFallbackReads = kvFaulty(
      (op, key) => op === 'get' && (key === 'heartbeat:last' || key === FALLBACK_CLAIM_KEY),
    );
    const { ctx, work } = fakeCtx();

    await expect(
      runScheduled({ cron: DAILY_OPS_CRON } as ScheduledController, noFallbackReads, ctx),
    ).resolves.toBeUndefined();

    expect(work).toHaveLength(1);
    const [results] = (await Promise.all(work)) as { task: string; ok: boolean }[][];
    expect(results?.find((r) => r.task === 'backup')?.ok).toBe(true);
    expect(await env.SESSIONS.get(FALLBACK_CLAIM_KEY)).toBeNull(); // the daily trigger claims nothing
    expect(unrecognizedLines(warn)).toEqual([]);
  });

  it('declares the daily trigger in both wrangler configs, so the ops loop never depends on the fallback', () => {
    for (const config of [productionConfig, stagingConfig]) {
      expect(declared(config)).toContain(DAILY_OPS_CRON);
    }
  });

  // An expression no branch claims: a trigger added in wrangler without its branch, or a rollback
  // to a version from before it (Cloudflare does not version triggers with the code). The old
  // fallback ran the whole daily loop on every tick of it.
  describe('an unrecognized trigger runs the daily loop only when the loop is due', () => {
    // An expression no app declares. Not '* * * * *': forks wire that one (a pipeline tick, a job
    // sweep) in a branch above the fallback, and /kit-upgrade carries this file into their CI.
    // Sub-daily in shape (a step in the minute field).
    const UNKNOWN = '*/7 7 7 7 *';
    // The shape of a renamed daily schedule: one fixed minute and hour. Declared by no app either.
    const UNKNOWN_ONCE_A_DAY = '7 7 7 7 *';

    it('precondition: no wrangler config declares the expression these tests treat as unwired', () => {
      for (const [name, config] of [
        ['wrangler.jsonc', productionConfig],
        ['wrangler.staging.jsonc', stagingConfig],
      ] as const) {
        for (const expression of [UNKNOWN, UNKNOWN_ONCE_A_DAY]) {
          expect(
            declared(config).includes(expression),
            `${name} declares ${expression}, so a branch in runScheduled may claim it: pick another expression for it in this test`,
          ).toBe(false);
        }
      }
    });

    it('fresh heartbeat: the tick is skipped (no backup, no heartbeat, no audit row) and logged', async () => {
      expect(UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS).toBe(20);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await heartbeatAgo(1);
      const before = await env.SESSIONS.get('heartbeat:last');
      const backups = await backupKeys();
      const { ctx, work } = fakeCtx();

      await runScheduled({ cron: UNKNOWN } as ScheduledController, env, ctx);

      expect(work).toHaveLength(0);
      expect(await env.SESSIONS.get('heartbeat:last')).toBe(before);
      expect(await env.SESSIONS.get(FALLBACK_CLAIM_KEY)).toBeNull(); // a skipped tick claims nothing
      expect(await backupKeys()).toEqual(backups);
      expect(await auditRows()).toBe(0);
      expect(unrecognizedLines(warn)).toEqual([
        {
          event: 'cron_trigger_unrecognized',
          daily_loop: 'skipped',
          once_a_day: false,
          heartbeat: 'fresh',
          heartbeat_age_hours: 1,
        },
      ]);
    });

    it('a heartbeat just under the bar is still fresh', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await heartbeatAgo(UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS - 0.1);
      const { ctx, work } = fakeCtx();
      await runScheduled({ cron: UNKNOWN } as ScheduledController, env, ctx);

      expect(work).toHaveLength(0);
      expect(unrecognizedLines(warn)).toMatchObject([
        { daily_loop: 'skipped', heartbeat: 'fresh' },
      ]);
    });

    it('a heartbeat 20 hours old: the daily loop runs and writes a new heartbeat', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await heartbeatAgo(UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS);
      const { ctx, work } = fakeCtx();
      await runScheduled({ cron: UNKNOWN } as ScheduledController, env, ctx);

      expect(work).toHaveLength(1);
      const results = (await Promise.all(work))[0] as { task: string; ok: boolean }[];
      expect(results.map((r) => r.task)).toContain('backup');
      const last = Date.parse((await env.SESSIONS.get('heartbeat:last')) as string);
      expect(Date.now() - last).toBeLessThan(10_000);
      expect(unrecognizedLines(warn)).toEqual([
        {
          event: 'cron_trigger_unrecognized',
          daily_loop: 'ran',
          once_a_day: false,
          heartbeat: 'stale',
          heartbeat_age_hours: UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS,
          claim: 'taken',
        },
      ]);
    });

    it('no heartbeat at all, or one that does not parse: the daily loop runs, so it degrades safely', async () => {
      for (const seed of [null, 'not-a-date']) {
        vi.restoreAllMocks();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await env.SESSIONS.delete(FALLBACK_CLAIM_KEY); // the previous iteration's run took it
        if (seed === null) await env.SESSIONS.delete('heartbeat:last');
        else await env.SESSIONS.put('heartbeat:last', seed);
        const { ctx, work } = fakeCtx();

        await runScheduled({ cron: UNKNOWN } as ScheduledController, env, ctx);

        expect(work).toHaveLength(1);
        await Promise.all(work);
        const last = Date.parse((await env.SESSIONS.get('heartbeat:last')) as string);
        expect(Date.now() - last).toBeLessThan(10_000);
        expect(unrecognizedLines(warn)).toEqual([
          {
            event: 'cron_trigger_unrecognized',
            daily_loop: 'ran',
            once_a_day: false,
            heartbeat: 'missing',
            claim: 'taken',
          },
        ]);
      }
    });

    it('an unreadable heartbeat skips the tick without throwing, and logs only the error class', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failing = {
        ...env,
        SESSIONS: { get: () => Promise.reject(new TypeError('kv unavailable in this test')) },
      } as unknown as Env;
      const { ctx, work } = fakeCtx();

      await expect(
        runScheduled({ cron: UNKNOWN } as ScheduledController, failing, ctx),
      ).resolves.toBeUndefined();

      expect(work).toHaveLength(0);
      expect(await auditRows()).toBe(0);
      const lines = unrecognizedLines(warn);
      expect(lines).toEqual([
        {
          event: 'cron_trigger_unrecognized',
          daily_loop: 'skipped',
          once_a_day: false,
          heartbeat: 'unreadable',
          err: { name: 'TypeError' },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain('kv unavailable');
    });

    // A renamed daily schedule is the case the fallback exists for, and it fires at most once a
    // day, so it cannot become a loop per tick: KV trouble must not cost it the day's backup, WORM
    // check and anomaly digest (whose 24 h window has no cursor, so a skipped day is never read).
    it('a once-a-day trigger runs the loop when the heartbeat is unreadable', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const noHeartbeatRead = kvFaulty((op, key) => op === 'get' && key === 'heartbeat:last');
      const { ctx, work } = fakeCtx();

      await runScheduled({ cron: UNKNOWN_ONCE_A_DAY } as ScheduledController, noHeartbeatRead, ctx);

      expect(work).toHaveLength(1);
      const [results] = (await Promise.all(work)) as { task: string; ok: boolean }[][];
      expect(results?.find((r) => r.task === 'backup')?.ok).toBe(true);
      expect(unrecognizedLines(warn)).toEqual([
        {
          event: 'cron_trigger_unrecognized',
          daily_loop: 'ran',
          once_a_day: true,
          heartbeat: 'unreadable',
          claim: 'taken',
          err: { name: 'TypeError' },
        },
      ]);
    });

    it('a once-a-day trigger runs the loop when the claim cannot be written', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {}); // cron_heartbeat_failed
      await heartbeatAgo(UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS + 4);
      const noPut = kvFaulty((op) => op === 'put');
      const { ctx, work } = fakeCtx();

      await runScheduled({ cron: UNKNOWN_ONCE_A_DAY } as ScheduledController, noPut, ctx);

      expect(work).toHaveLength(1);
      await Promise.all(work);
      expect(unrecognizedLines(warn)).toMatchObject([
        { daily_loop: 'ran', once_a_day: true, heartbeat: 'stale', claim: 'failed' },
      ]);
    });

    it('a once-a-day trigger still skips on a fresh heartbeat or a held claim', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await heartbeatAgo(9); // a second daily schedule beside a healthy one
      const fresh = fakeCtx();
      await runScheduled({ cron: UNKNOWN_ONCE_A_DAY } as ScheduledController, env, fresh.ctx);
      expect(fresh.work).toHaveLength(0);

      await heartbeatAgo(UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS + 1);
      await env.SESSIONS.put(FALLBACK_CLAIM_KEY, new Date().toISOString());
      const held = fakeCtx();
      await runScheduled({ cron: UNKNOWN_ONCE_A_DAY } as ScheduledController, env, held.ctx);
      expect(held.work).toHaveLength(0);

      expect(unrecognizedLines(warn).map((l) => [l.daily_loop, l.heartbeat, l.claim])).toEqual([
        ['skipped', 'fresh', undefined],
        ['skipped', 'stale', 'held'],
      ]);
    });

    it('firesAtMostOnceADay: one fixed minute and one fixed hour, whatever the day fields', () => {
      for (const once of ['0 3 * * *', '30 3 * * *', '7 7 7 7 *', '0 2 * * 1-5', ' 15 4 1 * * ']) {
        expect(firesAtMostOnceADay(once), once).toBe(true);
      }
      for (const more of [
        '* * * * *',
        '*/5 * * * *',
        '0 * * * *',
        '40 * * * *',
        '0 11,19 * * *',
        '0 0-2,6,10-23 * * *',
        '*/7 7 7 7 *',
        '0 */12 * * *',
        '',
        '0',
      ]) {
        expect(firesAtMostOnceADay(more), more).toBe(false);
      }
    });

    // The heartbeat is written when the loop ENDS, and runScheduled hands the loop to waitUntil and
    // returns. Without a claim taken before dispatch, every tick until the heartbeat lands (or
    // every tick, if the loop dies first) starts another full loop.
    it('a second tick while the first loop is still running starts no second loop', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await heartbeatAgo(UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS + 1);
      const { ctx, work } = fakeCtx();

      await runScheduled({ cron: UNKNOWN } as ScheduledController, env, ctx);
      await runScheduled({ cron: UNKNOWN } as ScheduledController, env, ctx); // loop 1 not awaited
      expect(work).toHaveLength(1);
      await Promise.all(work);

      // The claim expires with the bar, so a renamed daily trigger runs again the next day.
      const [claim] = (await env.SESSIONS.list({ prefix: FALLBACK_CLAIM_KEY })).keys;
      const ttlSeconds = (claim?.expiration ?? 0) - Date.now() / 1000;
      expect(ttlSeconds).toBeGreaterThan(UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS * 3600 - 60);
      expect(ttlSeconds).toBeLessThanOrEqual(UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS * 3600);

      expect(unrecognizedLines(warn)).toEqual([
        {
          event: 'cron_trigger_unrecognized',
          daily_loop: 'ran',
          once_a_day: false,
          heartbeat: 'stale',
          heartbeat_age_hours: UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS + 1,
          claim: 'taken',
        },
        {
          event: 'cron_trigger_unrecognized',
          daily_loop: 'skipped',
          once_a_day: false,
          heartbeat: 'stale',
          heartbeat_age_hours: UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS + 1,
          claim: 'held',
        },
      ]);
    });

    it('a fallback loop that never writes its heartbeat still closes the gate for 20 hours', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {}); // cron_heartbeat_failed
      await heartbeatAgo(UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS + 1);
      const noHeartbeat = kvFaulty((op, key) => op === 'put' && key === 'heartbeat:last');

      const first = fakeCtx();
      await runScheduled({ cron: UNKNOWN } as ScheduledController, noHeartbeat, first.ctx);
      expect(first.work).toHaveLength(1);
      const [results] = (await Promise.all(first.work)) as { task: string; ok: boolean }[][];
      expect(results?.find((r) => r.task === 'heartbeat')?.ok).toBe(false);

      const second = fakeCtx();
      await runScheduled({ cron: UNKNOWN } as ScheduledController, noHeartbeat, second.ctx);
      expect(second.work).toHaveLength(0);
      expect(unrecognizedLines(warn).map((l) => [l.daily_loop, l.claim])).toEqual([
        ['ran', 'taken'],
        ['skipped', 'held'],
      ]);
    });

    it('a claim that cannot be written skips the tick: no claim, no loop', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await heartbeatAgo(UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS + 1);
      const noPut = kvFaulty((op) => op === 'put');
      const { ctx, work } = fakeCtx();

      await expect(
        runScheduled({ cron: UNKNOWN } as ScheduledController, noPut, ctx),
      ).resolves.toBeUndefined();

      expect(work).toHaveLength(0);
      const lines = unrecognizedLines(warn);
      expect(lines).toEqual([
        {
          event: 'cron_trigger_unrecognized',
          daily_loop: 'skipped',
          once_a_day: false,
          heartbeat: 'stale',
          heartbeat_age_hours: UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS + 1,
          claim: 'failed',
          err: { name: 'TypeError' },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain('kv unavailable');
    });
  });
});

// read_log retention (Fleet Ledger K2a, Decision D4). The table exists on every kit app even
// though none binds a private database yet, so this task ships armed and is a no-op until the
// first Aurora binding lands — rather than a step someone has to remember on that day.
describe('read_log retention', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('defaults to 60 days, and falls back to it on any unusable override', () => {
    expect(readLogRetentionDays(undefined)).toBe(READ_LOG_RETENTION_DAYS_DEFAULT);
    expect(READ_LOG_RETENTION_DAYS_DEFAULT).toBe(60);
    expect(readLogRetentionDays('90')).toBe(90);
    // Fails SAFE, not closed: a typo must never become "retain nothing". An over-eager prune
    // destroys the attribution trail, which is worse than keeping rows a while longer.
    for (const bad of ['', 'sixty', '0', '-5', '1.5', 'NaN']) {
      expect(readLogRetentionDays(bad)).toBe(READ_LOG_RETENTION_DAYS_DEFAULT);
    }
  });

  it('prunes rows past the horizon as a green cron task', async () => {
    const insert = (id: string, age: string) =>
      env.DB.prepare(
        `INSERT INTO read_log (id, request_id, principal, app, env, route, source, source_class, view, query_name, row_count, created_at) VALUES (?, 'req', ?, 'work-queue-requests', 'test', 'GET /api/x', 'ret1_ro', 'internal', 'app_ro.v_x', 'q', 1, datetime('now', ?))`,
      )
        .bind(id, USERS.member, age)
        .run();
    await insert('old', '-90 days');
    await insert('recent', '-1 days');

    const results = await executeScheduledRun(env);
    const task = results.find((r) => r.task === 'prune_read_log');
    expect(task?.ok).toBe(true);
    // One short pass drains it, so the detail carries no "pass cap reached" tail.
    expect(task?.detail).toBe('pruned 1 read_log rows older than 60 days in 1 pass(es)');

    const kept = await env.DB.prepare('SELECT id FROM read_log').all<{ id: string }>();
    expect(kept.results.map((r) => r.id)).toEqual(['recent']);
  });

  // The nightly pass cap (40 x 5,000 rows) must not become a quiet failure. A fork whose daily
  // inflow is above the cap deletes 200,000 rows every night while the backlog grows for ever and
  // the deletion promise lapses. Stateless escalation: after a capped run, the task throws, and so
  // pages, once the oldest row still waiting is more than 3 days past its deletion date.
  it('pages when a night at the real pass cap leaves rows more than 3 days past their deletion date', async () => {
    // 200,010 rows, all ~90 days old: the cap deletes 200,000 and 10 remain, ~30 days overdue.
    await env.DB.prepare(
      `INSERT INTO read_log (id, request_id, principal, app, env, route, source, source_class, view, query_name, row_count, created_at)
       WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 200010)
       SELECT 'bulk-' || n, 'req', ?, 'work-queue-requests', 'test', 'GET /api/x', 'ret1_ro', 'internal', 'app_ro.v_x', 'q', 1,
              datetime('now', '-90 days', '+' || (n / 1000) || ' seconds') FROM c`,
    )
      .bind(USERS.member)
      .run();

    await expect(pruneReadLog(env)).rejects.toThrow(
      /read_log retention is falling behind: this run deleted 200000 rows in 40 passes \(the nightly cap\) and the oldest row still waiting is 30\.0 days past its 60-day deletion date/,
    );
    // It still did the night's work before paging: oldest first, 10 rows left for tomorrow.
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM read_log').first<{ n: number }>();
    expect(left?.n).toBe(10);
  });

  it('a capped run stays green while the backlog is within the overdue limit, and pages past it', () => {
    const capped = (overdueDays: number) => ({
      deleted: 200_000,
      passes: 40,
      drained: false,
      overdueDays,
    });
    expect(READ_LOG_PRUNE_MAX_OVERDUE_DAYS).toBe(3);
    // Draining over a few nights is working as designed: green, and the detail says how far behind.
    expect(readLogPruneOutcome(60, capped(3))).toBe(
      'pruned 200000 read_log rows older than 60 days in 40 pass(es); pass cap reached, oldest waiting row 3.0 day(s) past its deletion date, the rest continue next run',
    );
    expect(() => readLogPruneOutcome(60, capped(3.05))).toThrow(/falling behind/);
    // A drained run never pages, whatever it deleted.
    expect(readLogPruneOutcome(60, { deleted: 7, passes: 1, drained: true })).toBe(
      'pruned 7 read_log rows older than 60 days in 1 pass(es)',
    );
  });
});
