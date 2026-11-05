import { describe, expect, it } from 'vitest';
import { cronFailureEmail, magicLinkEmail } from '../../src/email/templates';

describe('magicLinkEmail', () => {
  const link = 'https://app.cialdnb.ai/auth/verify?token=abc123';

  it('returns a branded HTML email + plaintext fallback with the login link', () => {
    const mail = magicLinkEmail('Vendor Tracker', link, 'user@cialdnb.com');
    expect(mail.to).toBe('user@cialdnb.com');
    expect(mail.subject).toBe('Log in to Vendor Tracker');
    // Branded, Outlook-safe shell: full document, table layout, the app wordmark + footer.
    expect(mail.html).toContain('<!DOCTYPE html>');
    expect(mail.html).toContain('role="presentation"');
    expect(mail.html).toContain('Vendor Tracker');
    expect(mail.html).toContain('CIAL Dun &amp; Bradstreet');
    expect(mail.html).toContain(link); // the CTA + paste-link both carry the URL
    // Plaintext fallback stands alone with the link.
    expect(mail.text).toContain(link);
    expect(mail.text).toContain('Log in to Vendor Tracker');
  });

  it('HTML-escapes the app name and link (no markup injection)', () => {
    const mail = magicLinkEmail('<b>Evil</b>', 'https://x.test/verify?t=a&b="c"', 'u@x.test');
    expect(mail.html).not.toContain('<b>Evil</b>');
    expect(mail.html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
    // The link's & and " are escaped where interpolated into HTML.
    expect(mail.html).toContain('a&amp;b=&quot;c&quot;');
  });
});

describe('cronFailureEmail', () => {
  it('returns subject + branded body listing each failure (no `to` — the cron fans out)', () => {
    const mail = cronFailureEmail('Vendor Tracker', 'production', [
      { task: 'backup', error: 'R2 write failed' },
      { task: 'prune', error: null },
    ]);
    expect('to' in mail).toBe(false);
    expect(mail.subject).toBe('[Vendor Tracker/production] cron failure: 2 task(s)');
    expect(mail.html).toContain('<!DOCTYPE html>');
    expect(mail.html).toContain('backup');
    expect(mail.html).toContain('R2 write failed');
    expect(mail.html).toContain('failed'); // null error → 'failed'
    expect(mail.text).toContain('• backup: R2 write failed');
    expect(mail.text).toContain('• prune: failed');
  });

  it('points at where the detail lives — the heartbeat audit row — never at `wrangler tail`', () => {
    // After PIA C5 Workers Logs carry a task's name and error class only, so "check wrangler tail
    // for detail" would send the operator to less than this email already holds.
    const mail = cronFailureEmail('App', 'production', [{ task: 'backup', error: 'x' }]);
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain('cron_heartbeat_done');
      expect(body).not.toContain('wrangler tail');
    }
  });

  it('HTML-escapes a failure error (a thrown message can contain markup)', () => {
    const mail = cronFailureEmail('App', 'staging', [
      { task: 'job', error: '<img src=x onerror=alert(1)>' },
    ]);
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
