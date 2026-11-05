// HTML for the magic-link confirmation step. The emailed /auth/verify link renders
// confirmPage() on GET — a static page that claims NOTHING — so email-security
// scanners that pre-fetch links (Microsoft Defender "Safe Links", Outlook link
// preview, etc.) can't burn the single-use token before the human clicks. The
// page's button POSTs back to /auth/verify, where the token is actually consumed
// (see routes.ts). A scanner GETs but never submits the form.
//
// These two pages are the only worker responses that render HTML, so they carry
// their own CSP: still default-src 'none' (no scripts, no external fetches of any
// kind), relaxed only to allow the single inline <style> block and to pin form
// submissions to our own origin. src/index.ts honors a route-set CSP rather than
// overwriting it with the strict JSON default.
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const FONT = "'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif";

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 16px; font-family: ${FONT}; color: #3a3f47; background: #fafbfc;
    background-image:
      radial-gradient(55% 45% at 82% 8%, rgba(0,210,255,.12), transparent 60%),
      radial-gradient(50% 50% at 8% 94%, rgba(0,80,240,.09), transparent 60%);
  }
  .card {
    width: 384px; max-width: 100%; background: #fff; border: 1px solid rgba(0,0,0,.06);
    border-radius: 20px; box-shadow: 0 30px 60px -30px rgba(0,80,240,.45); overflow: hidden;
  }
  .bar { height: 5px; background: linear-gradient(90deg, #0050f0 10%, #00d2ff 90%); }
  .body { padding: 34px 32px 30px; }
  .brand { display: flex; align-items: center; gap: 8px; margin-bottom: 22px; }
  .brand i { width: 16px; height: 2px; border-radius: 2px; background: linear-gradient(90deg,#0050f0,#00d2ff); }
  .brand span { font-weight: 700; font-size: 13px; letter-spacing: .01em; color: #687078; }
  h1 { font-size: 21px; font-weight: 800; letter-spacing: -.01em; margin: 0 0 6px; }
  p { font-size: 13.5px; line-height: 1.55; color: #687078; margin: 0 0 20px; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; width: 100%;
    padding: 11px 18px; border: none; border-radius: 10px; background: #0050f0; color: #fff;
    font: inherit; font-weight: 700; font-size: 14px; cursor: pointer; text-decoration: none;
  }
  .btn:hover { background: #0043cc; }
  .foot { font-size: 11.5px; color: #aab1b8; margin: 16px 0 0; }
`;

// e.g. "arena-go" → "Arena Go": a readable brand label from the kebab APP_NAME, the FALLBACK
// for appDisplayName when no configured display name is set. (Example stays token-free so this
// file isn't flagged by the bootstrap residual tripwire — same reason as the ci.yml comment.)
function brandName(appName: string): string {
  const titled = appName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return titled || appName;
}

// The app's human display name for user-facing surfaces (the magic-link email body + the auth
// pages). Prefer MAIL_FROM_NAME (the per-app configured display name, e.g. "Applicant Pay
// Management") with a trailing env marker — " (staging)" / " (test)" — stripped, so login, the
// interstitial, and the email all read the SAME name, not the kebab-derived APP_NAME (which
// abbreviates: app-pay-management → "App Pay Management"). Only the known env markers are stripped,
// so a legitimate trailing parenthetical (e.g. "Acme (R&D)") survives. Falls back to the APP_NAME
// title-case when MAIL_FROM_NAME is unset.
export function appDisplayName(appName: string, mailFromName?: string): string {
  const fromMail = (mailFromName ?? '').replace(/\s*\((?:staging|test)\)\s*$/i, '').trim();
  return fromMail || brandName(appName);
}

// HTML-escape a value before interpolating it into the page. `brand` now comes from the free-form
// MAIL_FROM_NAME (see appDisplayName), not just the metacharacter-free kebab APP_NAME, so it must
// be escaped — the branded email shell escapes the same way (src/email/templates.ts).
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function shell(brand: string, title: string, inner: string, status: number): Response {
  const safeBrand = esc(brand);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${safeBrand}</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <div class="bar"></div>
    <div class="body">
      <div class="brand"><i></i><span>${safeBrand}</span></div>
${inner}
    </div>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PAGE_CSP,
      // The confirm page carries a live, still-claimable token in a hidden field —
      // never let a browser/proxy/bfcache retain it. `no-transform` additionally stops the
      // zone's bot JavaScript Detections from injecting an inline script that this page's
      // strict PAGE_CSP would block (same fix as web/public/_headers; DECISIONS 2026-08-04).
      'cache-control': 'no-store, no-transform',
    },
  });
}

// The confirm step. `token` MUST already be validated as hex by the caller — it is
// interpolated into an attribute value, and hex carries no HTML metacharacters.
export function confirmPage(brand: string, token: string): Response {
  return shell(
    brand,
    'Sign in',
    `      <h1>Confirm sign-in</h1>
      <p>You're about to sign in to ${esc(brand)}. For your security, confirm it's you to finish.</p>
      <form method="post" action="/auth/verify">
        <input type="hidden" name="token" value="${token}">
        <button type="submit" class="btn">Sign in</button>
      </form>
      <p class="foot">This link works once and expires shortly. If you didn't request it, just close this tab.</p>`,
    200,
  );
}

// Shown when the token is malformed (GET) or already-used/expired (POST). Carries a
// link back to the app login so the user can request a fresh link.
export function messagePage(brand: string, title: string, body: string, status: number): Response {
  return shell(
    brand,
    title,
    `      <h1>${title}</h1>
      <p>${body}</p>
      <a href="/" class="btn">Back to sign in</a>`,
    status,
  );
}
