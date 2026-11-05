import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cronFailureSlackText,
  isSlackWebhook,
  parseRecipients,
  resolveAlertTargets,
  sendViaAlertSeam,
} from '../../src/cron/alert';
import type { AlertingSettings } from '../../src/data';
import type { Env } from '../../src/env';
import { applySchema, seedDb } from '../helpers/db';
import { captureLogs } from '../helpers/logs';

const envWith = (alertEmail?: string) => ({ ALERT_EMAIL: alertEmail }) as unknown as Env;

describe('isSlackWebhook — SSRF guard for the admin-settable override', () => {
  it('accepts only HTTPS hooks.slack.com URLs', () => {
    expect(isSlackWebhook('https://hooks.slack.com/services/T/B/x')).toBe(true);
  });

  it('rejects other hosts, schemes, and malformed input', () => {
    for (const url of [
      'http://hooks.slack.com/services/x', // not HTTPS
      'https://evil.example/exfil', // arbitrary host (SSRF)
      'https://hooks.slack.com.evil.example/x', // suffix trick
      'https://internal.local/admin',
      'ftp://hooks.slack.com/x',
      'not-a-url',
      '',
    ]) {
      expect(isSlackWebhook(url)).toBe(false);
    }
  });
});

describe('parseRecipients', () => {
  it('splits on commas/semicolons/whitespace and drops non-addresses', () => {
    expect(parseRecipients('a@x.com, b@y.com;c@z.com  d@w.com')).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
      'd@w.com',
    ]);
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients('garbage, also-garbage')).toEqual([]);
  });
});

describe('resolveAlertTargets — env defaults layered with in-app overrides', () => {
  // 3rd arg = the env webhook already resolved by the caller (may be a Secrets Store secret).
  it('no override → env owner + env webhook', () => {
    const t = resolveAlertTargets(
      envWith('owner@cialdnb.com'),
      null,
      'https://hooks.slack.com/env',
    );
    expect(t.recipients).toEqual(['owner@cialdnb.com']);
    expect(t.webhook).toBe('https://hooks.slack.com/env');
  });

  it('stored recipients are UNIONed with the env owner (extras added, not replacing)', () => {
    const stored: AlertingSettings = { recipients: ['ops@cialdnb.com'], slackWebhookUrl: null };
    const t = resolveAlertTargets(envWith('owner@cialdnb.com'), stored, null);
    expect(t.recipients).toEqual(['owner@cialdnb.com', 'ops@cialdnb.com']);
  });

  it('dedupes when a stored recipient equals the env owner', () => {
    const stored: AlertingSettings = { recipients: ['owner@cialdnb.com'], slackWebhookUrl: null };
    const t = resolveAlertTargets(envWith('owner@cialdnb.com'), stored, null);
    expect(t.recipients).toEqual(['owner@cialdnb.com']);
  });

  it('stored Slack webhook overrides the env default', () => {
    const stored: AlertingSettings = {
      recipients: [],
      slackWebhookUrl: 'https://hooks.slack.com/override',
    };
    const t = resolveAlertTargets(
      envWith('owner@cialdnb.com'),
      stored,
      'https://hooks.slack.com/env',
    );
    expect(t.webhook).toBe('https://hooks.slack.com/override');
  });

  it('falls back to the env webhook when the stored override is null', () => {
    const stored: AlertingSettings = { recipients: ['ops@cialdnb.com'], slackWebhookUrl: null };
    const t = resolveAlertTargets(
      envWith('owner@cialdnb.com'),
      stored,
      'https://hooks.slack.com/env',
    );
    expect(t.webhook).toBe('https://hooks.slack.com/env');
  });

  // A row written before the write-time isSlackWebhook check could be any HTTPS URL — an SSRF
  // primitive. resolveAlertTargets must drop it and fall back to the trusted env default.
  it('ignores a legacy NON-Slack stored override → falls back to the env default', () => {
    const stored: AlertingSettings = {
      recipients: [],
      slackWebhookUrl: 'https://evil.example/exfil',
    };
    const t = resolveAlertTargets(
      envWith('owner@cialdnb.com'),
      stored,
      'https://hooks.slack.com/env',
    );
    expect(t.webhook).toBe('https://hooks.slack.com/env');
  });

  it('drops a legacy non-Slack stored override to null when there is no env default', () => {
    const stored: AlertingSettings = {
      recipients: [],
      slackWebhookUrl: 'https://evil.example/exfil',
    };
    const t = resolveAlertTargets(envWith('owner@cialdnb.com'), stored, null);
    expect(t.webhook).toBeNull();
  });

  it('no env webhook and no override → null (email-only)', () => {
    const t = resolveAlertTargets(envWith('owner@cialdnb.com'), null, null);
    expect(t.webhook).toBeNull();
  });
});

describe('cronFailureSlackText — third-party webhook egress hygiene', () => {
  it('lists failed task names only — never raw error text', () => {
    // The webhook POSTs to hooks.slack.com (third-party, plaintext), so a thrown task error
    // (which can embed SQL / table fragments) must not ride along — task names say WHAT broke.
    const text = cronFailureSlackText('App', 'production', [
      { task: 'backup' },
      { task: 'prune_magic_links' },
    ]);
    expect(text).toContain('• backup');
    expect(text).toContain('• prune_magic_links');
    expect(text).toContain('cron failures (2)');
    // Points ops at where the detail actually lives. Not `wrangler tail`: after PIA C5 the tail
    // carries the task name and error class only, which this text already has.
    expect(text).toContain('cron_heartbeat_done');
    expect(text).not.toContain('wrangler tail');
  });

  it('drops an error field a caller spreads in (only task is read)', () => {
    const text = cronFailureSlackText('App', 'staging', [
      { task: 'backup', error: 'D1_ERROR near "salary": secret-table' } as { task: string },
    ]);
    expect(text).not.toContain('secret-table');
    expect(text).not.toContain('D1_ERROR');
    expect(text).toContain('• backup');
  });
});

// The shared egress primitive behind both sendAlert and the audit digest. Exercises the actual
// fetch POST + HTTPS gate + the emailed/failed accounting, which the pure-helper tests above
// don't reach.
describe('sendViaAlertSeam — shared email + HTTPS-gated webhook egress', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const body = { subject: 's', text: 't', html: '<p>t</p>' };

  it('POSTs the slack text to an https webhook and reports it', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: unknown, init: unknown) => {
        calls.push({ url: String(url), body: String((init as RequestInit)?.body) });
        return new Response('ok');
      });
    try {
      const testEnv = {
        ...env,
        ALERT_EMAIL: 'ops@test.example',
        ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
      } as unknown as Env;
      const r = await sendViaAlertSeam(testEnv, 'audit_digest', body, 'hello-from-digest');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://hooks.slack.com/services/T/B/x');
      expect(calls[0]!.body).toContain('hello-from-digest');
      expect(r.webhook).toBe(true);
      expect(r.recipients).toBe(1);
      // No EMAIL binding in tests → sendEmail returns 'skipped' → neither emailed nor failed.
      expect(r.emailed).toBe(0);
      expect(r.failed).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('never POSTs to a non-https webhook (cleartext/SSRF gate)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('x'));
    const logs = captureLogs();
    try {
      const testEnv = {
        ...env,
        ALERT_EMAIL: 'ops@test.example',
        ALERT_WEBHOOK_URL: 'http://insecure.example/hook',
      } as unknown as Env;
      await sendViaAlertSeam(testEnv, 'audit_digest', body, 'nope');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logs.named('alert_seam_webhook_skipped_non_https')).toEqual([
        { event: 'alert_seam_webhook_skipped_non_https', channel: 'audit_digest', level: 'warn' },
      ]);
      // The URL is an operator-supplied secret-bearing string; the log never echoes it.
      logs.expectAbsent('insecure.example', 'ops@test.example');
    } finally {
      fetchSpy.mockRestore();
      logs.restore();
    }
  });

  it('counts a failed email send distinctly from a fail-open skip', async () => {
    // A present-but-broken EMAIL binding: sendEmail catches the throw and returns 'failed', so
    // the seam counts a failure — the signal a broken mailer during a live event needs.
    const testEnv = {
      ...env,
      ALERT_EMAIL: 'ops@test.example',
      EMAIL: {
        send: async () => {
          throw new Error('smtp down');
        },
      },
    } as unknown as Env;
    const logs = captureLogs();
    try {
      const r = await sendViaAlertSeam(testEnv, 'audit_digest', body, 'x');
      expect(r.failed).toBe(1);
      expect(r.emailed).toBe(0);
      // Logged as a category — never the recipient, the subject, or the transport's error text.
      expect(logs.named('email_send_failed')).toEqual([
        { event: 'email_send_failed', err: { name: 'Error' }, level: 'error' },
      ]);
      logs.expectAbsent('ops@test.example', 'smtp down');
    } finally {
      logs.restore();
    }
  });
});
