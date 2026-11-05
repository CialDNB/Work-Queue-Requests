// The daily token-expiry notice (PIA C8). Every token now expires, so a machine integration that
// is not rotated in time stops with a bare 401; this task warns the alert recipients 14, 7, 3 and
// 1 UTC calendar day(s) before a used token's expiry date, statelessly, and stays silent otherwise.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeScheduledRun } from '../../src/cron';
import {
  dueTokenNotices,
  noticeDates,
  runTokenExpiryNotice,
  TOKEN_EXPIRY_NOTICE_DAYS,
  tokenExpirySlackText,
} from '../../src/cron/tokenExpiry';
import { type ExpiringTokenRow, tokensRepo } from '../../src/data/tokens';
import { tokenExpiryEmail } from '../../src/email/templates';
import { applySchema, seedDb, USERS } from '../helpers/db';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The kit's daily loop fires at 03:00 UTC. */
const NOW = Date.parse('2026-09-23T03:00:00Z');

/** SQLite datetime() text for an epoch-ms instant. */
function sqlite(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** SQLite datetime() text for NOW + `days`. */
function at(days: number): string {
  return sqlite(NOW + days * DAY_MS);
}

function row(id: number, expiresAt: string): ExpiringTokenRow {
  return {
    id,
    email: USERS.member,
    name: `token-${id}`,
    prefix: `t_${String(id).padStart(8, '0')}`,
    expires_at: expiresAt,
    last_used_at: at(-1),
  };
}

/** Midnight UTC of NOW's date + `days`, plus `hours` into that day. */
function onDate(days: number, hours: number): string {
  const midnight = Math.floor(NOW / DAY_MS) * DAY_MS;
  return sqlite(midnight + days * DAY_MS + hours * HOUR_MS);
}

describe('dueTokenNotices — which tokens enter a window on this run', () => {
  it('fires when the expiry DATE is 14, 7, 3 or 1 UTC day(s) after the run date, at any hour', () => {
    const due = dueTokenNotices(
      [
        row(1, onDate(14, 23.99)), // late on day 14 — still the 14-day window
        row(2, onDate(7, 0.01)), // just after midnight on day 7
        row(3, onDate(3, 12)),
        row(4, onDate(1, 2)), // tomorrow, earlier in the day than the run
        row(5, onDate(10, 12)), // between windows
        row(6, onDate(15, 0)), // day 15 — tomorrow's 14
        row(7, onDate(0, 20)), // later today — already past its 1-day notice
      ],
      NOW,
    );
    expect(due.map((d) => [d.name, d.daysLeft])).toEqual([
      ['token-1', 14],
      ['token-2', 7],
      ['token-3', 3],
      ['token-4', 1],
    ]);
  });

  it('notices each token exactly once per window across consecutive daily runs', () => {
    const token = row(1, at(20.4));
    const hits: number[] = [];
    for (let day = 0; day < 25; day++) {
      for (const d of dueTokenNotices([token], NOW + day * DAY_MS)) hits.push(d.daysLeft);
    }
    expect(hits).toEqual([...TOKEN_EXPIRY_NOTICE_DAYS]);
  });

  // The reviewed defect: counting floor(ms left / 24h) from the moment the task happens to start
  // skipped or doubled a window when the expiry's time of day fell inside the run-time jitter.
  it('run-time jitter can neither skip nor repeat a window (expiry at the run’s own time of day)', () => {
    // Expiry a few seconds either side of 03:00, 14 days out; runs drift by seconds either way.
    const cases: Array<[expiryOffsetMs: number, secondRunDriftMs: number]> = [
      [3_000, 5_000], // was: both runs silent — the 14-day window skipped
      [-3_000, -5_000], // was: both runs said 14 — the window sent twice
    ];
    for (const [offset, drift] of cases) {
      const token = row(1, sqlite(NOW + 14 * DAY_MS + offset));
      const first = dueTokenNotices([token], NOW).map((d) => d.daysLeft);
      const second = dueTokenNotices([token], NOW + DAY_MS + drift).map((d) => d.daysLeft);
      expect([...first, ...second]).toEqual([14]);
    }
  });

  it('holds under hours of jitter for every expiry time of day', () => {
    // Deterministic jitter per run in [-1h, +3h] around 03:00 — far more than the loop ever takes.
    const jitter = (day: number) => (((day * 7919) % 241) - 60) * 60 * 1000;
    for (let minute = 0; minute < 24 * 60; minute += 17) {
      const token = row(
        1,
        sqlite(Math.floor(NOW / DAY_MS) * DAY_MS + 30 * DAY_MS + minute * 60_000),
      );
      const hits: number[] = [];
      for (let day = 0; day < 32; day++) {
        for (const d of dueTokenNotices([token], NOW + day * DAY_MS + jitter(day))) {
          hits.push(d.daysLeft);
        }
      }
      expect(hits).toEqual([...TOKEN_EXPIRY_NOTICE_DAYS]);
    }
  });

  it('skips expired and unparseable rows', () => {
    expect(
      dueTokenNotices([row(1, at(-0.1)), { ...row(2, onDate(3, 12)), expires_at: 'garbage' }], NOW),
    ).toEqual([]);
  });

  it('carries prefix, name, owner and dates — never a hash', () => {
    const [d] = dueTokenNotices([row(9, onDate(1, 5))], NOW);
    expect(d).toEqual({
      prefix: 't_00000009',
      name: 'token-9',
      owner: USERS.member,
      expiresAt: onDate(1, 5),
      lastUsedAt: at(-1),
      daysLeft: 1,
    });
  });

  it('noticeDates: the UTC dates the repository filters on, whatever the minute of the run', () => {
    const expected = ['2026-10-07', '2026-09-30', '2026-09-26', '2026-09-24'];
    expect(noticeDates(NOW)).toEqual(expected);
    expect(noticeDates(Date.parse('2026-09-23T00:00:00Z'))).toEqual(expected);
    expect(noticeDates(Date.parse('2026-09-23T23:59:59Z'))).toEqual(expected);
  });
});

describe('the notice content', () => {
  const due = dueTokenNotices([row(1, onDate(7, 1)), row(2, onDate(1, 1))], NOW);

  it('Slack gets counts only — no token name, prefix or owner crosses to the third party', () => {
    const text = tokenExpirySlackText('Vendor Tracker', 'production', due);
    expect(text).toContain('2 API token(s)');
    expect(text).toContain('soonest tomorrow');
    for (const leak of ['token-1', 't_00000001', USERS.member]) expect(text).not.toContain(leak);
    // The full count, when the list was capped.
    expect(tokenExpirySlackText('Vendor Tracker', 'production', due, 250)).toContain(
      '250 API token(s)',
    );
  });

  it('the email names each token (escaped) with its owner and window, plus the runbook', () => {
    const mail = tokenExpiryEmail('Vendor Tracker', 'production', [
      { ...(due[0] as (typeof due)[number]), name: '<b>etl</b>' },
      due[1] as (typeof due)[number],
    ]);
    expect(mail.subject).toBe('[Vendor Tracker/production] 2 API token(s) expiring soon');
    expect(mail.html).toContain('&lt;b&gt;etl&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>etl</b>');
    expect(mail.html).toContain('expires in 7 days');
    expect(mail.text).toContain('expires tomorrow');
    expect(mail.text).toContain(USERS.member);
    expect(mail.text).toContain('docs/runbooks/machine-token-rotation.md');
    expect(mail.text).not.toContain('more token(s)');
  });

  it('a capped list still states the full count and how many it left out', () => {
    const mail = tokenExpiryEmail('Vendor Tracker', 'production', due, 250);
    expect(mail.subject).toBe('[Vendor Tracker/production] 250 API token(s) expiring soon');
    expect(mail.text).toContain('248 more token(s) are due and not listed here');
    expect(mail.html).toContain('248 more token(s)');
  });
});

describe('runTokenExpiryNotice — end to end over api_tokens', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  /** A token expiring at `hours` into the UTC date `daysAhead` days from today (SQLite's clock). */
  async function insert(
    name: string,
    daysAhead: number,
    opts: { used?: boolean; revoked?: boolean; owner?: string; hours?: number } = {},
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, last_used_at, revoked_at, scopes)
       VALUES (?, ?, ?, 't_notice00', datetime(date('now', ?), ?), ${opts.used === false ? 'NULL' : "datetime('now', '-1 hour')"}, ${opts.revoked ? "datetime('now')" : 'NULL'}, '[]')`,
    )
      .bind(
        opts.owner ?? USERS.member,
        name,
        crypto.randomUUID(),
        `+${daysAhead} days`,
        `+${opts.hours ?? 12} hours`,
      )
      .run();
  }

  it('is silent when nothing enters a window (no send attempted)', async () => {
    await insert('far', 40);
    await insert('mid-window', 10);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await runTokenExpiryNotice(env)).toBe(
        'token expiry: nothing entering a notice window',
      );
      expect(warn.mock.calls.flat().join(' ')).not.toContain('email_skipped_no_binding');
    } finally {
      warn.mockRestore();
    }
  });

  it('notices a USED, live token entering a window; ignores unused and revoked ones', async () => {
    await insert('etl', 14);
    await insert('never-used', 14, { used: false });
    await insert('revoked', 14, { revoked: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const detail = await runTokenExpiryNotice(env);
      expect(detail).toMatch(/^token expiry: 1 token\(s\) noticed — emailed \d+\/\d+/);
      // No EMAIL binding in tests: the seam's fail-open skip proves a send was attempted.
      expect(warn.mock.calls.flat().join(' ')).toContain('email_skipped_no_binding');
    } finally {
      warn.mockRestore();
    }
  });

  it('skips a token whose owner is disabled or gone — it is already refused at resolution', async () => {
    await env.DB.prepare("UPDATE users SET disabled_at = datetime('now') WHERE email = ?")
      .bind(USERS.admin)
      .run();
    await insert('disabled-owner', 7, { owner: USERS.admin });
    await insert('no-such-owner', 7, { owner: 'gone@test.example' });
    await insert('live', 7);
    const { rows, total } = await tokensRepo(env.DB).listUsedExpiringOn(noticeDates(Date.now()));
    expect(rows.map((r) => r.name)).toEqual(['live']);
    expect(total).toBe(1);
  });

  it('the repository lists at most `limit` rows but counts them all (the 0003 cohort case)', async () => {
    for (let i = 0; i < 5; i++) await insert(`cohort-${i}`, 3);
    await insert('elsewhere', 5);
    const { rows, total } = await tokensRepo(env.DB).listUsedExpiringOn(noticeDates(Date.now()), 2);
    expect(rows).toHaveLength(2);
    expect(total).toBe(5);
    expect(await tokensRepo(env.DB).listUsedExpiringOn([])).toEqual({ rows: [], total: 0 });
  });

  it('runs inside the daily ops loop and never counts as a failure', async () => {
    await insert('etl', 3);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const results = await executeScheduledRun(env);
      const task = results.find((r) => r.task === 'token_expiry_notice');
      expect(task?.ok).toBe(true);
      expect(task?.detail).toContain('1 token(s) noticed');
    } finally {
      warn.mockRestore();
      err.mockRestore();
    }
  });
});
