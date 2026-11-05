import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { magicLinkOutboxKey, sanitizeReturnTo } from '../../src/auth/magicLink';
import { sha256Hex } from '../../src/auth/tokens';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { BASE } from '../helpers/http';

async function requestLink(email: string, returnTo?: string): Promise<Response> {
  return SELF.fetch(`${BASE}/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify(returnTo === undefined ? { email } : { email, return_to: returnTo }),
  });
}

// D1 stores only sha256(token) (AICOE-346) — usable for existence checks, never for login.
async function storedHashFor(email: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT token FROM magic_links WHERE email = ? ORDER BY created_at DESC',
  )
    .bind(email)
    .first<{ token: string }>();
  return row?.token ?? null;
}

// Capture the RAW token the way a builder without email gets it: from the non-production KV
// outbox. Tests have no EMAIL binding, so the transport skips and the non-prod branch parks the
// link under `magicLinkOutboxKey(email)` (src/auth/magicLink.ts) — it is never logged (PIA C5).
// Only an address listed in MAGIC_LINK_OUTBOX gets one: wrangler.test.jsonc lists USERS.member
// alone, which is why every token below is requested for that user.
// The outbox write rides waitUntil and can land AFTER the response resolves, and KV (unlike D1)
// is not reset between tests, so: clear the key first — a link from an earlier test must never be
// read as this one — then wait, bounded, for this request's link to appear.
async function requestLinkToken(email: string, returnTo?: string): Promise<string> {
  const key = magicLinkOutboxKey(email);
  await env.SESSIONS.delete(key);
  const res = await requestLink(email, returnTo);
  expect(res.status).toBe(200);
  for (let attempt = 0; attempt < 100; attempt++) {
    const link = await env.SESSIONS.get(key);
    const token = link ? /token=([a-f0-9]+)$/.exec(link)?.[1] : undefined;
    if (token) return token;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no link in the magic-link outbox — did the transport change?');
}

// GET = the confirmation interstitial (claims nothing — what a link scanner hits).
function verifyGet(token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/auth/verify?token=${token}`, { redirect: 'manual' });
}

// POST = the actual claim (what the human's "Sign in" button does), same-origin.
function verifyPost(token: string, origin = BASE): Promise<Response> {
  return SELF.fetch(`${BASE}/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'manual',
  });
}

describe('magic-link auth', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('returns an identical generic response for known and unknown emails (no enumeration)', async () => {
    const known = await requestLink(USERS.member);
    const unknown = await requestLink('stranger@test.example');
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.text()).toBe(await unknown.text());
    expect(await storedHashFor(USERS.member)).toBeTruthy();
    expect(await storedHashFor('stranger@test.example')).toBeNull();
  });

  it('refuses disallowed email domains even for invited users', async () => {
    await env.DB.prepare("INSERT INTO users (email, role, added_by) VALUES (?, 'member', ?)")
      .bind('bob@blocked.example', USERS.owner)
      .run();
    const res = await requestLink('bob@blocked.example');
    expect(res.status).toBe(200); // still generic
    expect(await storedHashFor('bob@blocked.example')).toBeNull();
  });

  // The refusal now writes an audit row (so the daily anomaly digest can flag a per-domain
  // flood), but must stay privacy-preserving: DOMAIN ONLY, a sentinel actor — never the
  // probe target's address. The deferred waitUntil work has completed by the time the
  // response await returns (same guarantee the deferred-send test relies on).
  it('writes a domain-only magic_link_refused audit row for an unknown user (never the address)', async () => {
    const probe = 'ghost@unknown-probe.example';
    const res = await requestLink(probe);
    expect(res.status).toBe(200); // generic, no enumeration
    const rowRes = await env.DB.prepare(
      "SELECT actor_email, payload_json, ip FROM audit_log WHERE action = 'magic_link_refused' ORDER BY id DESC",
    ).first<{ actor_email: string; payload_json: string; ip: string | null }>();
    expect(rowRes).toBeTruthy();
    // Sentinel actor — NOT the unknown address (storing it would persist the probe target).
    expect(rowRes?.actor_email).toBe('anonymous@refused');
    const payload = JSON.parse(rowRes?.payload_json ?? '{}') as { reason: string; domain: string };
    expect(payload.reason).toBe('unknown_or_disabled_user');
    expect(payload.domain).toBe('unknown-probe.example'); // domain kept
    // The full unknown address and its local-part appear NOWHERE in the row (privacy).
    const serialized = JSON.stringify(rowRes);
    expect(serialized).not.toContain(probe);
    expect(serialized).not.toContain('ghost');
  });

  it('audits a domain refusal with reason domain_not_allowed, still domain-only', async () => {
    await env.DB.prepare("INSERT INTO users (email, role, added_by) VALUES (?, 'member', ?)")
      .bind('carol@blocked.example', USERS.owner)
      .run();
    await requestLink('carol@blocked.example');
    const rowRes = await env.DB.prepare(
      "SELECT actor_email, payload_json FROM audit_log WHERE action = 'magic_link_refused' ORDER BY id DESC",
    ).first<{ actor_email: string; payload_json: string }>();
    const payload = JSON.parse(rowRes?.payload_json ?? '{}') as { reason: string; domain: string };
    expect(payload.reason).toBe('domain_not_allowed');
    expect(payload.domain).toBe('blocked.example');
    // Even for a known-but-blocked user, the address is not persisted as the actor.
    expect(rowRes?.actor_email).toBe('anonymous@refused');
    expect(JSON.stringify(rowRes)).not.toContain('carol');
  });

  // The bug this guards against: an email-security scanner (Microsoft Safe Links,
  // etc.) pre-fetches the link with a GET, which must NOT consume the single-use
  // token — otherwise the human's click lands on an already-burned link.
  it('the confirmation GET renders a page and does not consume the token', async () => {
    const token = await requestLinkToken(USERS.member);

    const get = await verifyGet(token);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('text/html');
    // The page reflects a live token — it must never be cached.
    expect(get.headers.get('cache-control')).toContain('no-store');
    const html = await get.text();
    expect(html).toContain('action="/auth/verify"'); // the confirm form
    expect(html).toContain(token); // token carried in the hidden field

    // A GET-only pre-fetch left the link intact: the human's POST still works.
    const post = await verifyPost(token);
    expect(post.status).toBe(302);
  });

  it('verify (POST) sets a __Host- session cookie and the session works', async () => {
    const token = await requestLinkToken(USERS.member);
    const res = await verifyPost(token);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-app_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const cookie = setCookie.split(';')[0] ?? '';
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { data: { email: string; auth_method: string } };
    expect(body.data.email).toBe(USERS.member);
    expect(body.data.auth_method).toBe('magic_link');
  });

  it('a magic link works exactly once (atomic claim kills replay)', async () => {
    const token = await requestLinkToken(USERS.member);
    const first = await verifyPost(token);
    expect(first.status).toBe(302);
    const replay = await verifyPost(token);
    expect(replay.status).toBe(410);
  });

  // AICOE-346 — the at-rest hashing invariant, end to end.
  it('stores only the SHA-256 of the emailed token; the emailed token still logs in', async () => {
    const token = await requestLinkToken(USERS.member);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const stored = await storedHashFor(USERS.member);
    expect(stored).toBe(await sha256Hex(token));
    expect(stored).not.toBe(token); // the plaintext never touches D1
    expect((await verifyPost(token)).status).toBe(302); // full hashed round-trip works
  });

  it('a stolen magic_links row is not a login (the stored hash is not the credential)', async () => {
    const token = await requestLinkToken(USERS.member);
    const stored = await storedHashFor(USERS.member);
    // An attacker with D1 read access replays the stored value as if it were the token.
    expect((await verifyPost(stored ?? '')).status).toBe(410);
    // The failed replay consumed nothing: the legitimate emailed token still works.
    expect((await verifyPost(token)).status).toBe(302);
  });

  it('rejects a cross-origin verify POST (only the first-party confirm form claims)', async () => {
    const token = await requestLinkToken(USERS.member);
    const res = await verifyPost(token, 'https://evil.example');
    expect(res.status).toBe(403);
    // and the link was not consumed — a same-origin POST still works
    expect((await verifyPost(token)).status).toBe(302);
  });

  it('a malformed token shows an error page, never a redirect', async () => {
    const res = await verifyGet('not-a-real-token');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('expired tokens are rejected', async () => {
    const raw = 'deadbeef'.repeat(8);
    await env.DB.prepare(
      "INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, datetime('now', '-1 hour'))",
    )
      .bind(await sha256Hex(raw), USERS.member)
      .run();
    const res = await verifyPost(raw);
    expect(res.status).toBe(410);
  });

  it('a user disabled between mint and click cannot log in, and the link is burned', async () => {
    const token = await requestLinkToken(USERS.member);
    await env.DB.prepare("UPDATE users SET disabled_at = datetime('now') WHERE email = ?")
      .bind(USERS.member)
      .run();
    const res = await verifyPost(token);
    expect(res.status).toBe(410);
  });

  it('rate-limits repeated requests for the same email', async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await requestLink(USERS.member);
      expect(ok.status).toBe(200);
    }
    const sixth = await requestLink(USERS.member);
    expect(sixth.status).toBe(429);
  });

  it('still performs the deferred send + audit after responding (AICOE-201)', async () => {
    // The email send now runs via waitUntil (off the response path, to kill the timing
    // oracle). The token is inserted synchronously, and the deferred work still runs:
    await requestLink(USERS.member);
    expect(await storedHashFor(USERS.member)).toBeTruthy(); // synchronous insert
    const audit = await env.DB.prepare(
      "SELECT 1 AS hit FROM audit_log WHERE action = 'magic_link_sent' AND actor_email = ?",
    )
      .bind(USERS.member)
      .first<{ hit: number }>();
    expect(audit?.hit).toBe(1); // deferred audit row was written
  });

  it('rejects cross-origin auth requests', async () => {
    const res = await SELF.fetch(`${BASE}/auth/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: USERS.member }),
    });
    expect(res.status).toBe(403);
  });

  // AICOE-197: the post-login redirect must never leave this origin.
  it('drops an open-redirect return_to and lands on / after login', async () => {
    const token = await requestLinkToken(USERS.member, '/\\evil.com'); // browser would read this as //evil.com
    const res = await verifyPost(token);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/'); // malicious value rejected → safe default
  });

  it('preserves a legitimate same-origin return_to through login', async () => {
    const token = await requestLinkToken(USERS.member, '/notes?tab=mine');
    const res = await verifyPost(token);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/notes?tab=mine');
  });

  // "Back after login": the confirm page sits in browser history right before the app
  // (POST-redirect-GET), so the first browser Back re-hits GET /auth/verify. A LIVE session
  // must bounce straight into the app, not re-render "Confirm sign-in".
  it('an already-signed-in GET /auth/verify redirects into the app (Back after login)', async () => {
    const token = await requestLinkToken(USERS.member);
    const login = await verifyPost(token); // real login → live session cookie
    expect(login.status).toBe(302);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toContain('__Host-app_session=');

    // Pressing Back re-requests the confirm URL (well-formed but now-consumed token) WITH the
    // session cookie → 302 into the app, not the confirm page.
    const back = await SELF.fetch(`${BASE}/auth/verify?token=${token}`, {
      method: 'GET',
      headers: { cookie },
      redirect: 'manual',
    });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/');
  });

  // The scanner defense must survive the new session short-circuit: NO cookie → still the
  // static confirm page, and the token stays claimable for the human's POST.
  it('a scanner GET (no session cookie) still gets the static confirm page — token unclaimed', async () => {
    const token = await requestLinkToken(USERS.member);
    const get = await verifyGet(token); // no cookie
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('text/html');
    expect(await get.text()).toContain('action="/auth/verify"');
    expect((await verifyPost(token)).status).toBe(302); // unclaimed — the human still logs in
  });

  // Fail-closed: a forged/junk session cookie resolves to NO live session, so the redirect
  // must not fire — never trust an unvalidated cookie value.
  it('a GET with a forged session cookie falls through to the confirm page (fail-closed)', async () => {
    const token = await requestLinkToken(USERS.member);
    const forged = `__Host-app_session=${'0'.repeat(36)}`; // not a real sid
    const get = await SELF.fetch(`${BASE}/auth/verify?token=${token}`, {
      method: 'GET',
      headers: { cookie: forged },
      redirect: 'manual',
    });
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('text/html');
  });
});

describe('sanitizeReturnTo (open-redirect defense)', () => {
  it('keeps same-origin relative paths verbatim', () => {
    expect(sanitizeReturnTo('/')).toBe('/');
    expect(sanitizeReturnTo('/notes?x=1')).toBe('/notes?x=1');
    expect(sanitizeReturnTo('/notes#frag')).toBe('/notes#frag');
    expect(sanitizeReturnTo('/%2F%2Fevil.com')).toBe('/%2F%2Fevil.com'); // stays encoded, safe
  });

  it('rejects every off-origin / scheme-relative / backslash trick', () => {
    for (const evil of [
      undefined,
      '',
      '//evil.com',
      '/\\evil.com',
      '/\\/evil.com',
      '/\t/evil.com',
      '\\/evil.com',
      '/..//evil.com', // '..'-collapse → normalized pathname '//evil.com' (protocol-relative)
      '/.//evil.com',
      '/foo/..//evil.com',
      '/%2e%2e//evil.com',
      'https://evil.com',
      'http:evil.com',
      'javascript:alert(1)',
      'foo', // no leading slash — path-relative inputs only
    ]) {
      expect(sanitizeReturnTo(evil as string | undefined)).toBeNull();
    }
  });
});
