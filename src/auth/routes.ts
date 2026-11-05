// Pre-authentication surfaces — deliberately OUTSIDE the paved road (defineRoute is
// fail-closed authenticated-only). Everything here is rate-limited and anti-enumerating.
import { Hono } from 'hono';
import { makeDb } from '../data';
import type { Env } from '../env';
import { fail, ok } from '../framework/envelope';
import { logEvent } from '../platform/logEvent';
import { isSameOrigin } from '../security/csrf';
import { rateLimit } from '../security/rateLimit';
import { verifyTurnstile } from '../security/turnstile';
import { clearSessionCookie, readCookie, SESSION_COOKIE, serializeSessionCookie } from './cookies';
import { appDisplayName, confirmPage, messagePage } from './interstitial';
import { auditMagicLinkRefusal, requestMagicLink, verifyMagicLink } from './magicLink';
import { beginOidcLogin, completeOidcLogin, entraEmailDomains, entraFullyEnabled } from './oidc';
import { destroySession, getSession, sessionTtlSec } from './sessions';

// Magic-link tokens are 64 hex chars (randomHex(64)); pin the shape so a token is
// only ever embedded into the confirm page once it's known to carry no HTML
// metacharacters, and to cheaply reject junk before any work.
const TOKEN_RE = /^[a-f0-9]{16,256}$/;

export function authRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Login-policy read that can never take the login page down: a failed/malformed
  // settings read degrades to "no policy" (both methods available) — same posture as the
  // repo's corrupt-row handling. Access is still gated by invite; only METHOD policy
  // fails open here.
  const loginPolicySafe = async (env: Env): Promise<{ entraOnly: boolean }> => {
    try {
      const stored = await makeDb(env).settings.getLogin();
      return { entraOnly: stored?.entraOnly === true };
    } catch (err) {
      logEvent('login_settings_unreadable', { err });
      return { entraOnly: false };
    }
  };

  // Public bootstrap config for the login page. Exposes only the PUBLIC Turnstile site key
  // (empty when the challenge is disabled), whether Entra SSO is usable (a boolean gated on
  // the FULL config incl. the secret — never advertise a button the callback would refuse),
  // whether the app is entra-only (magic links off), and the steering domain list. The
  // client id itself stays server-side; no secrets. Trimmed so the client's enabled/disabled
  // view matches verifyTurnstile's (which also trims) — a whitespace-only key reads as
  // disabled on both sides, never "enabled on the client, off on the server".
  app.get('/auth/config', async (c) => {
    const entra = await entraFullyEnabled(c.env);
    // entra-only is IGNORED while SSO is down/misconfigured: a config mistake must never
    // brick every login path, and magic links are a sanctioned method (fail toward
    // availability — the setting re-engages the moment SSO is healthy again).
    const login = entra ? await loginPolicySafe(c.env) : null;
    return ok({
      turnstile_site_key: (c.env.TURNSTILE_SITE_KEY ?? '').trim(),
      entra_enabled: entra !== null,
      entra_only: entra !== null && login?.entraOnly === true,
      entra_domains: entra !== null ? entraEmailDomains(c.env) : [],
    });
  });

  // Microsoft Entra SSO (multi-tenant OIDC) — the second way to mint the SAME session.
  // Both are top-level browser navigations (no CSRF origin check by design: login has an
  // interactive Microsoft hop in the middle, and the callback is cross-site by nature —
  // the __Host- transaction cookie is the browser-binding). Rendered refusals are
  // interstitials, not JSON: a human is looking at these, not the SPA's fetch client.
  //
  // Rate limits are per-IP only (pre-auth, no user dimension exists yet), and SSO is the
  // primary path for whole offices behind one corporate NAT egress — so the buckets are
  // deliberately generous. They guard against abuse loops, not against Monday morning;
  // the zone-level /auth/* rate limit (docs/SECURITY-EDGE.md) remains the volumetric gate.
  const tooManyAttempts = (env: Env): Response =>
    messagePage(
      appDisplayName(env.APP_NAME, env.MAIL_FROM_NAME),
      'Too many attempts',
      'Too many sign-in attempts from your network; try again later.',
      429,
    );
  const oidcHandler =
    (key: string, max: number, run: (env: Env, req: Request, ip: string) => Promise<Response>) =>
    async (c: { env: Env; req: { raw: Request } }): Promise<Response> => {
      const ip = c.req.raw.headers.get('cf-connecting-ip') ?? 'unknown';
      const limit = await rateLimit(c.env, `${key}:${ip}`, max, 3600);
      if (!limit.ok) return tooManyAttempts(c.env);
      return run(c.env, c.req.raw, ip);
    };

  app.get(
    '/auth/oidc/login',
    oidcHandler('oidc-login', 120, (env, req) => beginOidcLogin(env, req)),
  );
  app.get(
    '/auth/oidc/callback',
    oidcHandler('oidc-callback', 120, (env, req, ip) => completeOidcLogin(env, req, ip)),
  );

  app.post('/auth/request', async (c) => {
    if (!isSameOrigin(c.req.raw)) {
      return fail(403, 'csrf_rejected', 'Cross-origin request rejected');
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return fail(400, 'validation_failed', 'Invalid JSON body');
    }
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || !email.includes('@') || email.length > 254) {
      return fail(400, 'validation_failed', 'A valid email address is required');
    }

    const ip = c.req.raw.headers.get('cf-connecting-ip') ?? 'unknown';

    // Bot challenge (Turnstile) — first line of defense, before we touch the rate-limit
    // budget or issue a link. No-op unless TURNSTILE_SITE_KEY is set; fail-closed when it is.
    // A Turnstile token is a few hundred chars; cap it so a giant body can't be forwarded to
    // siteverify. Oversized/missing/non-string → '' → fail-closed when the challenge is enabled.
    const rawToken = body.turnstile_token;
    const turnstileToken = typeof rawToken === 'string' && rawToken.length <= 2048 ? rawToken : '';
    // Pass a real client IP or nothing — never the 'unknown' sentinel (siteverify expects an
    // IP for remoteip; a bogus value risks a bad-request rejection of an otherwise-valid token).
    const challenge = await verifyTurnstile(c.env, turnstileToken, ip === 'unknown' ? '' : ip);
    if (!challenge.ok) {
      return fail(403, 'challenge_failed', 'Bot challenge failed; please retry.');
    }

    const perIp = await rateLimit(c.env, `auth-request:${ip}`, 10, 3600);
    const perEmail = await rateLimit(c.env, `auth-request-email:${email.toLowerCase()}`, 5, 3600);
    if (!perIp.ok || !perEmail.ok) {
      return fail(429, 'rate_limited', 'Too many login requests; try again later');
    }

    // Entra-only login policy (app setting): magic links are switched off — respond with
    // the SAME generic body (no oracle for which methods an address could use) and send
    // nothing. Only enforced while SSO is FULLY configured; if SSO breaks, magic links
    // resume (availability over policy — the login page mirrors this via /auth/config).
    const login = await loginPolicySafe(c.env);
    if (login.entraOnly && (await entraFullyEnabled(c.env)) !== null) {
      const domain = email.split('@')[1]?.toLowerCase() ?? 'invalid';
      logEvent('magic_link_refused', { reason: 'entra_only_login', domain });
      // Audit it too (domain only) so the anomaly digest's per-domain flood detection also covers
      // an entra-only app being probe-sprayed — otherwise these refusals are logged but never land
      // in audit_log. Deferred + best-effort, same shape as the magic-link refusal path.
      c.executionCtx.waitUntil(auditMagicLinkRefusal(c.env, 'entra_only_login', domain, ip));
      return ok({ message: 'If that address is registered, a login link is on its way.' });
    }

    const returnTo = typeof body.return_to === 'string' ? body.return_to : undefined;
    await requestMagicLink(c.env, email, returnTo, ip, (p) => c.executionCtx.waitUntil(p));

    // Identical response whether or not the address is registered.
    return ok({ message: 'If that address is registered, a login link is on its way.' });
  });

  // GET renders a confirmation interstitial and claims NOTHING. Email-security
  // scanners (Microsoft Defender "Safe Links", etc.) pre-fetch links to detonate
  // them; if the GET consumed the single-use token, that automated fetch would burn
  // the link before the human ever clicks. The token is claimed only on the POST
  // below, which a scanner never issues.
  app.get('/auth/verify', async (c) => {
    // Already signed in? After a magic-link login the confirm page sits in browser history
    // right before the app (classic POST-redirect-GET), so the first browser Back lands the
    // user back here. Bounce a LIVE session straight into the app instead of re-rendering
    // "Confirm sign-in" — this completes the history-aware "Back stays in-app" work from #144,
    // which governs only IN-app history and cannot delete this pre-app entry (see DECISIONS
    // 2026-08-03, "Back after login"). A link scanner (Safe Links, etc.) carries no session
    // cookie, so it still gets the static page below and the token stays unclaimed on GET —
    // the whole reason GET never consumes. A forged/expired cookie resolves to no session and
    // also falls through (fail-closed).
    const sid = readCookie(c.req.header('cookie'), SESSION_COOKIE);
    if (sid && (await getSession(c.env, sid))) {
      return new Response(null, { status: 302, headers: { Location: '/' } });
    }
    const brand = appDisplayName(c.env.APP_NAME, c.env.MAIL_FROM_NAME);
    const token = c.req.query('token') ?? '';
    if (!TOKEN_RE.test(token)) {
      return messagePage(
        brand,
        'Link not recognized',
        'This sign-in link is malformed. Head back and request a new one.',
        400,
      );
    }
    return confirmPage(brand, token);
  });

  // POST is the real verification: same-origin only (the interstitial form is
  // first-party), and the atomic claim still guarantees exactly one success ever.
  app.post('/auth/verify', async (c) => {
    if (!isSameOrigin(c.req.raw)) {
      return fail(403, 'csrf_rejected', 'Cross-origin request rejected');
    }
    const body = await c.req.parseBody();
    const token = typeof body.token === 'string' ? body.token : '';

    const ip = c.req.raw.headers.get('cf-connecting-ip') ?? 'unknown';
    const result = await verifyMagicLink(c.env, token, ip);
    if (!result) {
      return messagePage(
        appDisplayName(c.env.APP_NAME, c.env.MAIL_FROM_NAME),
        'This link has expired',
        'This sign-in link is invalid or was already used. Head back and request a new one.',
        410,
      );
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: result.returnTo,
        'Set-Cookie': serializeSessionCookie(result.sid, sessionTtlSec(c.env)),
      },
    });
  });

  app.post('/auth/logout', async (c) => {
    if (!isSameOrigin(c.req.raw)) {
      return fail(403, 'csrf_rejected', 'Cross-origin request rejected');
    }
    const sid = readCookie(c.req.header('cookie'), SESSION_COOKIE);
    if (sid) await destroySession(c.env, sid);
    return new Response(null, { status: 204, headers: { 'Set-Cookie': clearSessionCookie() } });
  });

  return app;
}
