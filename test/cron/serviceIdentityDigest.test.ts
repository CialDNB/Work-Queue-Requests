// The daily SERVICE-IDENTITY digest (src/cron/tokenExpiry.ts, run by the token_expiry_notice
// task): every used service token within 14 days of expiry, every day until it is rotated, named
// with its identity and custodian — to the alert recipients and to each custodian (their own
// identities only) — plus every identity whose custodian left, whose tokens are refused. Slack gets
// counts only; a quiet day sends nothing. Every identity and address here is synthetic.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeScheduledRun } from '../../src/cron';
import {
  dueServiceTokens,
  runServiceIdentityDigest,
  runTokenExpiryNotice,
  SERVICE_TOKEN_DIGEST_DAYS,
  serviceDigestCutoff,
  serviceDigestSlackText,
} from '../../src/cron/tokenExpiry';
import { makeDb } from '../../src/data';
import type { ExpiringServiceTokenRow } from '../../src/data/tokens';
import {
  type ServiceTokenNoticeRow,
  serviceIdentityDigestEmail,
  serviceTokenCustodianEmail,
} from '../../src/email/templates';
import type { Env } from '../../src/env';
import { applySchema, seedDb, USERS } from '../helpers/db';

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN = Date.UTC(2026, 8, 24, 3, 0, 0); // a 03:00 UTC run

function row(
  expiresAt: string,
  over: Partial<ExpiringServiceTokenRow> = {},
): ExpiringServiceTokenRow {
  return {
    id: 1,
    name: 'etl prod',
    prefix: 't_abcdef12',
    expires_at: expiresAt,
    last_used_at: '2026-09-23 22:00:00',
    service_identity_id: 7,
    service_slug: 'etl',
    service_name: 'C360 ETL',
    principal_id: 'svc-etl@test-app.invalid',
    custodian_email: USERS.member,
    ...over,
  };
}

/** The SQLite text for 12:00 UTC on the date `days` after RUN's date. */
const at = (days: number, hour = 12) =>
  new Date(Date.UTC(2026, 8, 24 + days, hour)).toISOString().replace('T', ' ').slice(0, 19);

/** The SQLite text for an instant `ms` after the epoch. */
const sqlite = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

describe('dueServiceTokens — every day while LESS THAN 14 days are left, not only on windows', () => {
  it('reports a token with less than 14×24h left, by the clock — not by calendar day', () => {
    const due = dueServiceTokens(
      [
        row(sqlite(RUN + 14 * DAY_MS - 60 * 60 * 1000), { id: 1, name: '13d23h' }),
        row(sqlite(RUN + 14 * DAY_MS), { id: 2, name: 'exactly-14d' }),
        row(sqlite(RUN + 14 * DAY_MS + 60 * 60 * 1000), { id: 3, name: '14d1h' }),
        // Same UTC calendar date as 14 days out, but 14d20h away: never "less than 14 days".
        row(sqlite(Date.UTC(2026, 9, 8, 23, 0, 0)), { id: 4, name: '14d20h' }),
      ],
      RUN,
    );
    expect(due.map((d) => [d.tokenName, d.daysLeft])).toEqual([['13d23h', 13]]);
  });

  it('reports whole days left 0–13, and nothing later or already past', () => {
    const rows = [
      ...Array.from({ length: 16 }, (_, d) => row(at(d), { id: d, name: `d${d}` })),
      row('2026-09-24 02:00:00', { id: 99, name: 'already-expired' }),
    ];
    const due = dueServiceTokens(rows, RUN);
    // at(d) is 12:00 UTC, the run 03:00: d days and 9 hours left — d = 14 is past the mark.
    expect(due.map((d) => d.daysLeft)).toEqual(Array.from({ length: 14 }, (_, d) => d));
    expect(due.map((d) => d.tokenName)).not.toContain('d14');
    expect(due.map((d) => d.tokenName)).not.toContain('already-expired');
  });

  it('the same token is reported on EVERY run from the 14-day mark until it expires', () => {
    const token = row(at(14, 9)); // 14 days and 6 hours after the first run
    const seen: number[] = [];
    for (let day = 0; day <= 16; day++) {
      const due = dueServiceTokens([token], RUN + day * DAY_MS);
      if (due.length > 0) seen.push(due[0]?.daysLeft ?? -1);
    }
    expect(seen).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('carries the identity, identifier and custodian — never a hash or a scope', () => {
    const [due] = dueServiceTokens([row(at(5))], RUN);
    expect(due).toEqual({
      identity: 'C360 ETL',
      identifier: 'svc-etl@test-app.invalid',
      tokenName: 'etl prod',
      prefix: 't_abcdef12',
      custodian: USERS.member,
      expiresAt: at(5),
      lastUsedAt: '2026-09-23 22:00:00',
      daysLeft: 5,
    } satisfies ServiceTokenNoticeRow);
  });

  it('serviceDigestCutoff is exactly 14×24h after the run, in expires_at’s own text shape', () => {
    expect(SERVICE_TOKEN_DIGEST_DAYS).toBe(14);
    expect(serviceDigestCutoff(RUN)).toBe('2026-10-08 03:00:00');
    expect(serviceDigestCutoff(Date.UTC(2026, 8, 24, 23, 59, 30))).toBe('2026-10-08 23:59:30');
  });
});

describe('the digest content', () => {
  const due = dueServiceTokens([row(at(3)), row(at(10), { name: '<b>x</b>' })], RUN);
  const orphans = [
    {
      identity: 'Old CRM sync',
      identifier: 'svc-crm@test-app.invalid',
      custodian: 'leaver@test.example',
      liveTokens: 2,
      lastUsedAt: null,
    },
  ];

  it('Slack gets counts only — no identity, identifier, token or custodian crosses to the third party', () => {
    const text = serviceDigestSlackText('test-app', 'production', 2, 1, 1);
    expect(text).toContain('1 service identity has no active custodian');
    expect(text).toContain('1 service identity holds a scope no service may hold (tokens refused)');
    expect(text).toContain('2 service token(s) expire within 14 days');
    for (const leak of ['svc-', '@', 't_abc', 'C360', 'etl prod']) expect(text).not.toContain(leak);
    expect(serviceDigestSlackText('a', 'b', 0, 3)).not.toContain('expire');
  });

  it('the alert email names each token with its identity AND custodian, and each orphan, escaped', () => {
    const mail = serviceIdentityDigestEmail('test-app', 'production', due, 2, orphans);
    expect(mail.subject).toBe(
      '[test-app/production] Service identities: 1 without a custodian, 2 token(s) expiring',
    );
    for (const s of [
      'C360 ETL',
      'svc-etl@test-app.invalid',
      `custodian ${USERS.member}`,
      'in 3 days',
    ]) {
      expect(mail.text).toContain(s);
    }
    expect(mail.text).toContain('svc-crm@test-app.invalid');
    expect(mail.text).toContain('leaver@test.example is no longer an active user');
    expect(mail.text).toContain('REFUSED');
    expect(mail.text).toContain('docs/runbooks/service-identities.md');
    expect(mail.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>x</b>');
  });

  it('states the full count when the list is capped', () => {
    const mail = serviceIdentityDigestEmail('a', 'b', due, 9, []);
    expect(mail.text).toContain('7 more service token(s) are due');
  });

  it('the custodian’s copy lists only their tokens, addressed to them as custodian', () => {
    const mail = serviceTokenCustodianEmail('test-app', 'production', due);
    expect(mail.subject).toBe(
      '[test-app/production] 2 service token(s) you are custodian of expire soon',
    );
    expect(mail.text).toContain('C360 ETL');
    expect(mail.text).not.toContain('custodian alice');
  });
});

describe('runServiceIdentityDigest — end to end', () => {
  beforeAll(applySchema);

  // Mail is observed through an injected EMAIL binding — what the transport was handed — never
  // through the transport's own log lines: PIA C5 (#241) strips `to` and `subject` from those.
  let sent: Array<{ to: string; subject: string; text: string }>;
  let mailEnv: Env;
  beforeEach(async () => {
    await seedDb();
    sent = [];
    mailEnv = {
      ...env,
      APP_NAME: 'test-app',
      EMAIL: {
        send: async (m: { to: string; subject: string; text: string }) => void sent.push(m),
      },
    } as unknown as Env;
  });

  async function identity(slug: string, custodian: string = USERS.member): Promise<string> {
    const principalId = `svc-${slug}@test-app.invalid`;
    const res = await makeDb(env).serviceIdentities.create({
      slug,
      principalId,
      name: `${slug} (synthetic)`,
      scope: 'notes.write',
      custodianEmail: custodian,
      createdBy: USERS.owner,
    });
    if (!res.ok) throw new Error(res.reason);
    return principalId;
  }

  async function token(
    owner: string,
    daysAhead: number,
    opts: { used?: boolean; revoked?: boolean; name?: string } = {},
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, last_used_at, revoked_at, scopes)
       VALUES (?, ?, ?, 't_svcnote0', datetime(date('now', ?), '+12 hours'), ${opts.used === false ? 'NULL' : "datetime('now', '-1 hour')"}, ${opts.revoked ? "datetime('now')" : 'NULL'}, '["notes.write"]')`,
    )
      .bind(owner, opts.name ?? `tok-${daysAhead}`, crypto.randomUUID(), `+${daysAhead} days`)
      .run();
  }

  /** Every send the digest handed to the transport, in order. */
  const sends = () => sent.map(({ to, subject }) => ({ to, subject }));

  it('a quiet day is silence: null, and nothing sent', async () => {
    const svc = await identity('etl');
    await token(svc, 20);
    await token(svc, 5, { used: false });
    await token(svc, 5, { revoked: true });
    expect(await runServiceIdentityDigest(mailEnv)).toBeNull();
    expect(sends()).toEqual([]);
  });

  it('the query cuts off at exactly 14×24h from now, so the total it states is exact', async () => {
    const svc = await identity('etl');
    const insert = (offset: string) =>
      env.DB.prepare(
        `INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, last_used_at, scopes)
         VALUES (?, ?, ?, 't_svcnote0', datetime('now', '+14 days', ?), datetime('now', '-1 hour'), '["notes.write"]')`,
      )
        .bind(svc, `edge${offset}`, crypto.randomUUID(), offset)
        .run();
    await insert('+1 hour');
    expect(await runServiceIdentityDigest(mailEnv)).toBeNull();
    await insert('-1 hour');
    expect(await runServiceIdentityDigest(mailEnv)).toMatch(
      /^service identities: 1 token\(s\) expiring/,
    );
  });

  it('a used service token 10 days out — between the person windows — goes to the alert inbox AND its custodian', async () => {
    const svc = await identity('etl');
    await token(svc, 10);
    const detail = await runServiceIdentityDigest(mailEnv);
    expect(detail).toBe(
      'service identities: 1 token(s) expiring, 0 without a custodian — emailed 1/1 + 1/1 custodian(s)',
    );
    expect(sends()).toEqual([
      {
        to: 'alerts@test.example',
        subject: '[test-app/test] Service identities: 1 token(s) expiring',
      },
      {
        to: USERS.member,
        subject: '[test-app/test] 1 service token(s) you are custodian of expire soon',
      },
    ]);
  });

  it('each custodian hears only about their own identities', async () => {
    await token(await identity('etl', USERS.member), 3, { name: 'etl-token' });
    await token(await identity('crm', USERS.admin), 4, { name: 'crm-token' });
    await runServiceIdentityDigest(mailEnv);
    const mine = sent.find((m) => m.to === USERS.member)?.text ?? '';
    const theirs = sent.find((m) => m.to === USERS.admin)?.text ?? '';
    expect(mine).toContain('etl-token');
    expect(mine).not.toContain('crm-token');
    expect(theirs).toContain('crm-token');
    expect(theirs).not.toContain('etl-token');
    const inbox = sent.find((m) => m.to === 'alerts@test.example')?.text ?? '';
    expect(inbox).toContain('etl-token');
    expect(inbox).toContain('crm-token');
  });

  it('an ORPHANED identity (custodian left, live tokens refused) is reported even with nothing expiring', async () => {
    const svc = await identity('etl', USERS.viewer);
    await token(svc, 60);
    await makeDb(env).users.setDisabled(USERS.viewer, true);
    const detail = await runServiceIdentityDigest(mailEnv);
    expect(detail).toContain('0 token(s) expiring, 1 without a custodian');
    expect(sends().map((s) => s.to)).toEqual(['alerts@test.example']); // a leaver gets no mail
    expect(sends()[0]?.subject).toBe('[test-app/test] Service identities: 1 without a custodian');
    // Its expiring tokens are not double-reported as "expiring": they are already refused.
    await token(svc, 3);
    expect(await runServiceIdentityDigest(mailEnv)).toContain(
      '0 token(s) expiring, 1 without a custodian',
    );
  });

  it('an identity whose scope a service may no longer hold (tokens refused) is reported every day — not silently stranded, and not as "expiring"', async () => {
    await env.DB.prepare(
      "INSERT INTO service_identities (slug, principal_id, name, scope, custodian_email, created_by) VALUES ('old', 'svc-old@test-app.invalid', 'Old sync (synthetic)', 'users.manage', ?, ?)",
    )
      .bind(USERS.member, USERS.owner)
      .run();
    await token('svc-old@test-app.invalid', 60);
    await token('svc-old@test-app.invalid', 3); // refused anyway: no "rotate it" advice
    const detail = await runServiceIdentityDigest(mailEnv);
    expect(detail).toContain(
      '0 token(s) expiring, 0 without a custodian, 1 with a scope no service may hold',
    );
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      [
        'alerts@test.example',
        '[test-app/test] Service identities: 1 with a scope no service may hold',
      ],
    ]);
    expect(sent[0]?.text).toContain('svc-old@test-app.invalid');
    expect(sent[0]?.text).toContain('users.manage can no longer be held by a service identity');
  });

  it('a DISABLED identity is deliberate: neither expiring nor orphaned', async () => {
    const svc = await identity('etl', USERS.viewer);
    await token(svc, 3);
    const [row] = await makeDb(env).serviceIdentities.list();
    await makeDb(env).serviceIdentities.setDisabled(row?.id ?? 0, true, USERS.owner);
    await makeDb(env).users.setDisabled(USERS.viewer, true);
    expect(await runServiceIdentityDigest(mailEnv)).toBeNull();
  });

  it('service tokens never appear in the PERSON notice — even with a legacy users row for the address', async () => {
    const svc = await identity('etl');
    await env.DB.prepare("INSERT INTO users (email, role, added_by) VALUES (?, 'member', ?)")
      .bind(svc, USERS.owner)
      .run();
    await token(svc, 7); // a PERSON window day too (14/7/3/1), and under 14 days at any hour
    const detail = await runTokenExpiryNotice(env);
    expect(detail).toMatch(
      /^token expiry: nothing entering a notice window; service identities: 1/,
    );
  });

  it('a missing service_identities table (0004 not applied) fails the task LOUDLY, with the remedy — after the person notice went out', async () => {
    await token(USERS.member, 7, { name: 'personal-7' }); // a person's token in the 7-day window
    await env.DB.prepare('DROP TABLE service_identities').run(); // seedDb recreates it
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runTokenExpiryNotice(mailEnv)).rejects.toThrow(/0004_service_identities\.sql/);
      expect(sent.map((m) => m.subject)).toEqual(['[test-app/test] 1 API token(s) expiring soon']);
      const results = await executeScheduledRun(env);
      const task = results.find((r) => r.task === 'token_expiry_notice');
      expect(task?.ok).toBe(false);
      expect(task?.error).toContain('token expiry: 1 token(s) noticed');
    } finally {
      err.mockRestore();
    }
  });

  it('a failing PERSON notice does not suppress the service digest (and still fails the task)', async () => {
    await token(await identity('etl'), 3);
    await expect(
      runTokenExpiryNotice(mailEnv, Date.now(), {
        person: async () => {
          throw new Error('person notice broke');
        },
      }),
    ).rejects.toThrow(/person notice broke.*service identities: 1 token\(s\) expiring/);
    expect(sent.map((m) => m.subject)).toContain(
      '[test-app/test] Service identities: 1 token(s) expiring',
    );
  });

  it('runs inside the daily ops loop with the person notice, and never counts as a failure', async () => {
    await token(await identity('etl'), 2);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const results = await executeScheduledRun(env);
      const task = results.find((r) => r.task === 'token_expiry_notice');
      expect(task?.ok).toBe(true);
      expect(task?.detail).toContain('service identities: 1 token(s) expiring');
    } finally {
      err.mockRestore();
    }
  });
});
