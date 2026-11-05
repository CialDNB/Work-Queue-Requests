import { describe, expect, it } from 'vitest';
import { appDisplayName, confirmPage, messagePage } from '../../src/auth/interstitial';
import { magicLinkEmail } from '../../src/email/templates';

describe('appDisplayName — the brand shown on user-facing surfaces', () => {
  it('prefers MAIL_FROM_NAME (the configured display name) over the kebab APP_NAME', () => {
    // The bootstrap brand-mismatch fix: the kebab `app-pay-management` title-cases to
    // "App Pay Management", but the app's real name is "Applicant Pay Management" (MAIL_FROM_NAME),
    // which is what the emails + SPA already use.
    expect(appDisplayName('app-pay-management', 'Applicant Pay Management')).toBe(
      'Applicant Pay Management',
    );
  });

  it('strips only the env marker " (staging)"/"(test)", not any trailing parenthetical', () => {
    expect(appDisplayName('app-pay-management', 'Applicant Pay Management (staging)')).toBe(
      'Applicant Pay Management',
    );
    expect(appDisplayName('paved-road', 'Paved Road (test)')).toBe('Paved Road');
    // A legitimate trailing parenthetical in the name must SURVIVE (narrow strip, not any "(...)").
    expect(appDisplayName('acme', 'Acme (R&D)')).toBe('Acme (R&D)');
  });

  it('falls back to the title-cased APP_NAME when MAIL_FROM_NAME is empty/unset', () => {
    expect(appDisplayName('arena-go', '')).toBe('Arena Go');
    expect(appDisplayName('arena-go', undefined)).toBe('Arena Go');
    // The template default still reads right: APP_NAME "paved-road" → "Paved Road".
    expect(appDisplayName('paved-road', undefined)).toBe('Paved Road');
  });
});

describe('interstitial pages — HTML-escape the (now free-form) brand', () => {
  // brand now derives from MAIL_FROM_NAME (operator free text), not the metacharacter-free kebab
  // APP_NAME, so it must be escaped before it lands in the page — or a `<`/`&`/`"` breaks/injects.
  it('escapes the brand in confirmPage (title, brand chip, and body)', async () => {
    const html = await confirmPage('Acme <b> & "Co"', 'deadbeef').text();
    expect(html).toContain('Acme &lt;b&gt; &amp; &quot;Co&quot;');
    expect(html).not.toContain('Acme <b>');
  });

  it('escapes the brand in messagePage', async () => {
    const html = await messagePage('Acme <script>', 'Nope', 'Body', 400).text();
    expect(html).toContain('Acme &lt;script&gt;');
    expect(html).not.toContain('Acme <script>');
  });
});

// DECISIONS 2026-08-04. These pages are the kit's ONLY worker-rendered HTML, and they carry a
// strict PAGE_CSP with no inline-script escape hatch. The zone's bot JavaScript Detections injects
// an inline <script> into HTML at the edge whose body embeds the per-request ray id — unhashable,
// so the CSP blocks it — and `no-transform` is Cloudflare's documented way to stop the injection.
// `no-store` must survive alongside it: the confirm page holds a live, still-claimable token.
describe('interstitial pages — Cache-Control keeps both no-store and no-transform', () => {
  it('confirmPage sends no-store (token safety) AND no-transform (edge must not inject script)', () => {
    const cc = confirmPage('Acme', 'ab12').headers.get('cache-control');
    expect(cc).toBe('no-store, no-transform');
  });

  it('messagePage sends the same pair, on error statuses too', () => {
    const cc = messagePage('Acme', 'Nope', 'Body', 400).headers.get('cache-control');
    expect(cc).toBe('no-store, no-transform');
  });

  // The fix is no-transform, NOT a CSP relaxation: `default-src 'none'` with no script-src
  // override means script-src falls back to 'none', so an injected inline script is still
  // blocked here. (The lone 'unsafe-inline' is style-src — this page's styles are inline by
  // design and carry no script capability.)
  it('the page CSP still gives inline script no route in — no-transform is not a CSP relaxation', () => {
    const csp = confirmPage('Acme', 'ab12').headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });
});

describe('the magic-link email reads the same display name as the interstitial', () => {
  it('renders the resolved display name in the body, not the kebab APP_NAME', () => {
    const brand = appDisplayName('app-pay-management', 'Applicant Pay Management');
    const mail = magicLinkEmail(brand, 'https://app.test/auth/verify?token=ab', 'u@test.example');
    expect(mail.subject).toBe('Log in to Applicant Pay Management');
    expect(mail.html).toContain('Applicant Pay Management');
    expect(mail.html).not.toContain('app-pay-management');
    expect(mail.text).not.toContain('app-pay-management');
  });
});
