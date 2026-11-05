import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/cookies';
import { createSession } from '../../src/auth/sessions';
import type { Principal } from '../../src/auth/types';
import { requiresCsrfCheck } from '../../src/security/csrf';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE, cookieFor } from '../helpers/http';

describe('CSRF defense', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('cookie-authenticated mutations from a foreign origin are rejected', async () => {
    const res = await SELF.fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: {
        cookie: await cookieFor(USERS.member),
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'forged' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('csrf_rejected');
  });

  it('same-origin mutations pass', async () => {
    const res = await asUser(USERS.member, 'POST', '/api/notes', { title: 'fine' });
    expect(res.status).toBe(201);
  });

  it('mutations without an Origin header pass (non-browser clients; Lax covers browsers)', async () => {
    const res = await SELF.fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: { cookie: await cookieFor(USERS.member), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'curl-style' }),
    });
    expect(res.status).toBe(201);
  });

  it('bearer requests are exempt (deliberate header, not an ambient credential)', async () => {
    const created = await asUser(USERS.member, 'POST', '/api/tokens', { name: 'csrf-test' });
    const { token } = ((await created.json()) as { data: { token: string } }).data;
    const res = await SELF.fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://elsewhere.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'from a script' }),
    });
    expect(res.status).toBe(201);
  });

  it('GET requests are never CSRF-blocked', async () => {
    const res = await SELF.fetch(`${BASE}/api/me`, {
      headers: { cookie: await cookieFor(USERS.member), origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
  });

  // ADVERSARIAL (AICOE-448): the CSRF check keys on how the credential ARRIVED, not on the
  // session's stored auth_method. A buggy or future session minter that stamps 'api_token'
  // (the value the old predicate exempted) must NOT exempt cookie mutations from CSRF —
  // the credential still arrived as a cookie, so cross-origin must still 403. Before the
  // credentialTransport fix, this exact request sailed through.
  it('a cookie session stamped with a bogus authMethod is still CSRF-checked', async () => {
    const sid = await createSession(env, USERS.member, 'api_token');
    const res = await SELF.fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${sid}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'forged via bogus minter' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('csrf_rejected');
  });

  // …and the same bogus-minter session works fine same-origin: the transport fix must not
  // break legitimate cookie flows, whatever auth_method the session recorded.
  it('a cookie session stamped with a bogus authMethod still works same-origin', async () => {
    const sid = await createSession(env, USERS.member, 'api_token');
    const res = await SELF.fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${sid}`,
        origin: BASE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'legit same-origin' }),
    });
    expect(res.status).toBe(201);
  });

  // MIXED CREDENTIALS: the bearer branch has unconditional precedence in resolvePrincipal.
  // The exemption stays safe with a cookie riding along because the ACTING principal is the
  // token's — the ambient cookie identity is never consulted. Pin both halves so a future
  // "fall back to the cookie when the bearer is stale" refactor cannot drift in silently.
  it('bearer + cookie: acts as the token principal and stays exempt cross-origin', async () => {
    const created = await asUser(USERS.member, 'POST', '/api/tokens', { name: 'mixed-test' });
    const { token } = ((await created.json()) as { data: { token: string } }).data;
    const res = await SELF.fetch(`${BASE}/api/me`, {
      headers: {
        authorization: `Bearer ${token}`,
        cookie: await cookieFor(USERS.admin), // a DIFFERENT user's ambient cookie
        origin: 'https://elsewhere.example',
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { email: string } };
    expect(body.data.email).toBe(USERS.member); // the token's identity, not the cookie's
  });

  it('an invalid bearer with a valid cookie alongside is 401 — no cookie fallback', async () => {
    const res = await SELF.fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer t_definitely_not_a_real_token',
        cookie: await cookieFor(USERS.member),
        origin: BASE,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'should not exist' }),
    });
    expect(res.status).toBe(401);
  });

  it('a non-bearer Authorization scheme falls to the cookie branch and is CSRF-checked', async () => {
    const res = await SELF.fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: {
        authorization: 'Basic dXNlcjpwYXNz',
        cookie: await cookieFor(USERS.member),
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'forged' }),
    });
    expect(res.status).toBe(403);
  });

  // POLARITY PIN: requiresCsrfCheck must fail CLOSED for anything that is not 'bearer' —
  // including an absent field (a hand-cast Principal in a fork adapter) and a future
  // transport value. `=== 'cookie'` would pass every HTTP test above yet exempt both of
  // these; this unit pin is what makes that mutant die.
  describe('requiresCsrfCheck polarity', () => {
    const base: Principal = {
      kind: 'person',
      email: 'p@test.example',
      name: null,
      role: 'member',
      authMethod: 'magic_link',
      credentialTransport: 'cookie',
    };
    it('cookie → checked; bearer → exempt', () => {
      expect(requiresCsrfCheck(base)).toBe(true);
      expect(requiresCsrfCheck({ ...base, credentialTransport: 'bearer', tokenScopes: null })).toBe(
        false,
      );
    });
    it('a future/unknown transport value is checked (fail-closed)', () => {
      const novel = { ...base, credentialTransport: 'mtls' } as unknown as Principal;
      expect(requiresCsrfCheck(novel)).toBe(true);
    });
    it('an absent transport field is checked (fail-closed for hand-cast Principals)', () => {
      const cast = { ...base, credentialTransport: undefined } as unknown as Principal;
      expect(requiresCsrfCheck(cast)).toBe(true);
    });
  });
});
