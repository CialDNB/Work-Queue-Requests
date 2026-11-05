import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditDigestSlackText,
  type DigestFindings,
  detectAnomalies,
  findingsAreEmpty,
  runAuditAnomalyDigest,
  SENSITIVE_ACTIONS,
} from '../../src/cron/auditAnomalyDigest';
import { makeDb } from '../../src/data';
import type { AuditRow } from '../../src/data/audit';
import { applySchema, seedDb } from '../helpers/db';

// A synthetic audit row (only the fields the detector reads matter; the rest are filler).
function row(partial: Partial<AuditRow>): AuditRow {
  return {
    id: 1,
    actor_email: 'system@cron',
    action: 'noop',
    target: null,
    payload_json: null,
    ip: null,
    created_at: '2026-07-03T00:00:00Z',
    ...partial,
  };
}

const refusal = (domain: string): AuditRow =>
  row({
    action: 'magic_link_refused',
    actor_email: 'anonymous@refused',
    payload_json: JSON.stringify({ reason: 'unknown_or_disabled_user', domain }),
  });
const login = (actor: string, ip: string): AuditRow =>
  row({
    action: 'login',
    actor_email: actor,
    ip,
    payload_json: JSON.stringify({ method: 'magic_link' }),
  });

describe('detectAnomalies — pure anomaly detection', () => {
  it('flags a magic-link refusal flood over the threshold, but not below it', () => {
    const rows = [
      ...Array.from({ length: 12 }, () => refusal('probe.example')), // over the ≥10 threshold
      ...Array.from({ length: 3 }, () => refusal('typo.example')), // under → not flagged
    ];
    const f = detectAnomalies(rows, false);
    expect(f.refusalFloods).toEqual([{ domain: 'probe.example', count: 12 }]);
  });

  it('sorts multiple refusal floods by count, highest first', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => refusal('a.example')),
      ...Array.from({ length: 25 }, () => refusal('b.example')),
    ];
    const f = detectAnomalies(rows, false);
    expect(f.refusalFloods).toEqual([
      { domain: 'b.example', count: 25 },
      { domain: 'a.example', count: 10 },
    ]);
  });

  it('flags a first-seen IP only once the actor has a SECOND distinct IP in the window', () => {
    const rows = [
      login('alice@test.example', '1.1.1.1'), // first IP for alice — not notable alone
      login('alice@test.example', '1.1.1.1'), // same IP again — still not
      login('alice@test.example', '2.2.2.2'), // NEW IP alongside the first → flagged
      login('bob@test.example', '9.9.9.9'), // bob's only IP → not notable
    ];
    const f = detectAnomalies(rows, false);
    expect(f.firstSeenIpLogins).toEqual([{ actor: 'alice@test.example', ip: '2.2.2.2' }]);
  });

  it('flags a new IP only once even if it recurs after first appearing', () => {
    const rows = [
      login('alice@test.example', '1.1.1.1'),
      login('alice@test.example', '2.2.2.2'), // flagged here
      login('alice@test.example', '2.2.2.2'), // already seen → not flagged again
    ];
    const f = detectAnomalies(rows, false);
    expect(f.firstSeenIpLogins).toEqual([{ actor: 'alice@test.example', ip: '2.2.2.2' }]);
  });

  it('ignores login rows with no IP recorded', () => {
    const f = detectAnomalies(
      [
        login('alice@test.example', '1.1.1.1'),
        row({ action: 'login', actor_email: 'alice@test.example', ip: null }),
      ],
      false,
    );
    expect(f.firstSeenIpLogins).toEqual([]);
  });

  it('counts sensitive mutations and preserves the canonical action order', () => {
    const rows = [
      row({ action: 'user.update' }),
      row({ action: 'user.invite' }),
      row({ action: 'user.invite' }),
      row({ action: 'token.create' }),
      // Not sensitive in the kit → ignored (unless a fork lists it as its own).
      ...unlistedByTheApp(['note.create']).map((action) => row({ action })),
    ];
    const f = detectAnomalies(rows, false);
    expect(f.sensitiveCounts).toEqual([
      { action: 'user.invite', count: 2 },
      { action: 'user.update', count: 1 },
      { action: 'token.create', count: 1 },
    ]);
  });

  it('counts a service principal’s authz.denied rows — a machine refused a route is never noise', () => {
    const f = detectAnomalies(
      [row({ action: 'authz.denied' }), row({ action: 'authz.denied' })],
      false,
    );
    expect(f.sensitiveCounts).toEqual([{ action: 'authz.denied', count: 2 }]);
  });

  it('tolerates a refusal row with a missing/malformed payload (no domain → not counted)', () => {
    const rows = [
      row({ action: 'magic_link_refused', payload_json: null }),
      row({ action: 'magic_link_refused', payload_json: 'not json' }),
      row({ action: 'magic_link_refused', payload_json: JSON.stringify({ reason: 'x' }) }), // no domain
    ];
    const f = detectAnomalies(rows, false);
    expect(f.refusalFloods).toEqual([]);
  });

  it('propagates the capped flag', () => {
    expect(detectAnomalies([], true).capped).toBe(true);
    expect(detectAnomalies([], false).capped).toBe(false);
  });
});

// The kit's entries, pinned by hand like the permission matrix: changing them without changing
// this fails. They are the head of the list and a fork's own follow the app-actions line, so this
// file holds unchanged in a fork that takes it on /kit-upgrade. The cost: an entry added after the
// kit's reads as an app's, so a new kit entry comes with its line here. A fork's own entries are
// not pinned here, nor anywhere in the kit: a fork pins them in a test of its own (CHANGELOG).
// test/isolation/sensitive-actions.test.ts holds every entry, the app's included, to a real writer.
const KIT_SENSITIVE_ACTIONS = [
  'user.invite',
  'user.update',
  'user.revoke_sessions',
  'token.create',
  'token.revoke',
  'settings.alerting.update',
  'settings.login.update',
  'authz.denied',
  'service_identity.create',
  'service_identity.update',
  'service_identity.revoke_tokens',
  'audit_watch_error',
  'audit_watch_skipped',
  'audit_watch_alert_undelivered',
  'security_audit_alert',
];

// Names the kit's digest ignores. The negative cases judge only the kit's entries: a fork may list
// any of these names below the app-actions line (a `user.remove` for an erasure route of its own,
// say), and that is the fork's call, not this file's. So a case drops the names the app lists
// (`unlistedByTheApp`) before it expects nothing, as test/isolation/declared-writes.test.ts judges
// its fixtures against a list it owns. Without that, this carried file fails in such a fork, and
// the way out is to edit a kit test or drop the verb from the digest.
const NOT_SENSITIVE_IN_THE_KIT = [
  // The old entries: nothing in the kit ever wrote them.
  'settings.update',
  'user.remove',
  // Ordinary data and AI writes.
  'note.create',
  'note.update',
  'note.delete',
  'ai.call',
  // Routine bookkeeping rows.
  'magic_link_sent',
  'cron_heartbeat_done',
  'audit_watch_initialized',
  'audit_watch_truncated',
  // A permission key is not an action, and matching is exact.
  'settings.manage',
  'users.manage',
  'SETTINGS.LOGIN.UPDATE',
  'settings.alerting',
];

/** `actions` without the app's own entries (everything after the kit's head), read at call time. */
function unlistedByTheApp(actions: string[]): string[] {
  const app = new Set<string>(SENSITIVE_ACTIONS.slice(KIT_SENSITIVE_ACTIONS.length));
  return actions.filter((action) => !app.has(action));
}

function expectNothingCounted(actions: string[]): void {
  const f = detectAnomalies(
    unlistedByTheApp(actions).map((action) => row({ action })),
    false,
  );
  expect(f.sensitiveCounts).toEqual([]);
  expect(findingsAreEmpty(f)).toBe(true);
}

/** Runs `fn` with `entries` appended below the app-actions line, as a fork lists its own. */
function withAppEntries(entries: string[], fn: () => void): void {
  const list = SENSITIVE_ACTIONS as unknown as string[];
  const kitLength = list.length;
  list.push(...entries);
  try {
    fn();
  } finally {
    list.length = kitLength;
  }
}

describe('SENSITIVE_ACTIONS — the actions the kit writes', () => {
  it("starts with exactly the kit's entries, in this order", () => {
    expect(SENSITIVE_ACTIONS.slice(0, KIT_SENSITIVE_ACTIONS.length)).toEqual(KIT_SENSITIVE_ACTIONS);
  });

  it.each(['user.revoke_sessions', 'settings.alerting.update', 'settings.login.update'])(
    'counts one %s row as a sensitive mutation',
    (action) => {
      const f = detectAnomalies([row({ action })], false);
      expect(f.sensitiveCounts).toEqual([{ action, count: 1 }]);
      expect(findingsAreEmpty(f)).toBe(false);
    },
  );

  it('counts nothing for the retired names, the routine writes or near misses', () => {
    expectNothingCounted(NOT_SENSITIVE_IN_THE_KIT);
  });

  it('still counts nothing in a fork that lists some of those names as its own', () => {
    withAppEntries(['user.remove', 'note.delete'], () => {
      expectNothingCounted(NOT_SENSITIVE_IN_THE_KIT);
    });
  });

  it('prints a line per new action in the Slack text', () => {
    const f = detectAnomalies(
      [
        row({ action: 'settings.alerting.update' }),
        row({ action: 'user.revoke_sessions' }),
        row({ action: 'user.revoke_sessions' }),
      ],
      false,
    );
    const text = auditDigestSlackText('App', 'staging', f);
    expect(text).toContain('• 2× user.revoke_sessions\n• 1× settings.alerting.update');
  });
});

describe('findingsAreEmpty', () => {
  it('is true only when every finding bucket is empty', () => {
    const empty: DigestFindings = {
      refusalFloods: [],
      firstSeenIpLogins: [],
      sensitiveCounts: [],
      capped: false,
    };
    expect(findingsAreEmpty(empty)).toBe(true);
    expect(findingsAreEmpty({ ...empty, refusalFloods: [{ domain: 'x', count: 10 }] })).toBe(false);
    expect(findingsAreEmpty({ ...empty, firstSeenIpLogins: [{ actor: 'a', ip: 'i' }] })).toBe(
      false,
    );
    expect(
      findingsAreEmpty({ ...empty, sensitiveCounts: [{ action: 'user.invite', count: 1 }] }),
    ).toBe(false);
    // capped alone is metadata, not a finding — an empty-but-capped digest still self-skips.
    expect(findingsAreEmpty({ ...empty, capped: true })).toBe(true);
  });
});

describe('auditDigestSlackText — third-party egress hygiene (names/counts only)', () => {
  it("lists counts + the app's own identifiers, never audit payloads", () => {
    const f: DigestFindings = {
      refusalFloods: [{ domain: 'probe.example', count: 14 }],
      firstSeenIpLogins: [{ actor: 'alice@test.example', ip: '2.2.2.2' }],
      sensitiveCounts: [{ action: 'user.invite', count: 3 }],
      capped: false,
    };
    const text = auditDigestSlackText('App', 'production', f);
    expect(text).toContain('14 magic-link refusals at probe.example');
    expect(text).toContain('1 first-seen-IP login(s)');
    expect(text).toContain('3× user.invite');
    expect(text).toContain('audit digest');
    // The Slack channel never gets the raw IP (a first-seen-IP entry is summarized as a COUNT).
    expect(text).not.toContain('2.2.2.2');
  });

  it('notes a truncated window', () => {
    const f: DigestFindings = {
      refusalFloods: [{ domain: 'x.example', count: 10 }],
      firstSeenIpLogins: [],
      sensitiveCounts: [],
      capped: true,
    };
    expect(auditDigestSlackText('App', 'staging', f)).toContain('window truncated');
  });
});

// Storage-backed end-to-end: seed audit_log, run the task, assert self-skip vs. send.
describe('runAuditAnomalyDigest — end to end over audit_log', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('self-skips on a quiet day: returns the sentinel and attempts NO send', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const detail = await runAuditAnomalyDigest(env);
      expect(detail).toBe('audit digest: nothing notable');
      // sendDigest is never reached, so sendEmail never runs → no skip log for the digest.
      const attempted = warn.mock.calls.some(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('email_skipped_no_binding'),
      );
      expect(attempted).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('a lone sensitive mutation is not a flood but IS notable → sends a digest', async () => {
    // Email is fail-open with no EMAIL binding in tests, so sendEmail returns 'skipped' and logs
    // `email_skipped_no_binding` — we assert on that to prove a send was ATTEMPTED to the
    // configured ALERT_EMAIL recipient, without needing a live transport.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await makeDb(env).audit.insert({
        actor_email: 'admin@test.example',
        action: 'user.invite',
        ip: '1.2.3.4',
      });
      const detail = await runAuditAnomalyDigest(env);
      expect(detail).toContain('audit digest:');
      expect(detail).toContain('1 sensitive-action type(s)');
      expect(detail).toContain('emailed'); // sendDigest ran
      const attempted = warn.mock.calls.some(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('email_skipped_no_binding'),
      );
      expect(attempted).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('a changed alert target and a force-logout reach the digest', async () => {
    const db = makeDb(env);
    await db.audit.insert({
      actor_email: 'admin@test.example',
      action: 'settings.alerting.update',
    });
    await db.audit.insert({ actor_email: 'admin@test.example', action: 'user.revoke_sessions' });
    const detail = await runAuditAnomalyDigest(env);
    expect(detail).toContain('2 sensitive-action type(s)');
  });

  it('flags a refusal flood from the actual magic_link_refused rows', async () => {
    const db = makeDb(env);
    for (let i = 0; i < 11; i++) {
      await db.audit.insert({
        actor_email: 'anonymous@refused',
        action: 'magic_link_refused',
        payload_json: JSON.stringify({
          reason: 'unknown_or_disabled_user',
          domain: 'probe.example',
        }),
        ip: '9.9.9.9',
      });
    }
    const detail = await runAuditAnomalyDigest(env);
    expect(detail).toContain('1 refusal-flood(s)');
  });

  it('flags a first-seen-IP login end to end', async () => {
    const db = makeDb(env);
    await db.audit.insert({ actor_email: 'alice@test.example', action: 'login', ip: '1.1.1.1' });
    await db.audit.insert({ actor_email: 'alice@test.example', action: 'login', ip: '2.2.2.2' });
    const detail = await runAuditAnomalyDigest(env);
    expect(detail).toContain('1 first-seen-IP login(s)');
  });

  it('only scans the last 24h — an old anomaly outside the window is ignored', async () => {
    // Backdate 11 refusals to 40h ago; they must NOT count toward today's digest.
    for (let i = 0; i < 11; i++) {
      await env.DB.prepare(
        "INSERT INTO audit_log (actor_email, action, payload_json, created_at) VALUES ('anonymous@refused', 'magic_link_refused', ?, datetime('now', '-40 hours'))",
      )
        .bind(JSON.stringify({ reason: 'unknown_or_disabled_user', domain: 'old.example' }))
        .run();
    }
    const detail = await runAuditAnomalyDigest(env);
    expect(detail).toBe('audit digest: nothing notable');
  });
});
