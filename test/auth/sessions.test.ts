import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/cookies';
import {
  createSession,
  destroySession,
  getSession,
  getSessionByKey,
  mintedAtMs,
  revokeAllSessions,
  type SessionData,
  sessionKeyOf,
} from '../../src/auth/sessions';
import { sha256Hex } from '../../src/auth/tokens';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE, cookieFor } from '../helpers/http';

describe('sessions & force-logout', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  // AICOE-346 — a KV reader must not be able to replay stored keys as logins.
  it('KV stores sessions under sha256(sid), never the raw sid', async () => {
    const sid = await createSession(env, USERS.member, 'magic_link');
    expect(await env.SESSIONS.get(`session:${sid}`)).toBeNull(); // raw sid is not a key
    const stored = await env.SESSIONS.get(`session:${await sha256Hex(sid)}`);
    expect(stored).toContain(USERS.member); // the hashed key holds the session
    // and the cookie round-trip still resolves end to end
    const res = await SELF.fetch(`${BASE}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(res.status).toBe(200);
  });

  // AICOE-346 — the exact replay the hashing defends against: a KV reader who lifts the
  // stored key material and presents it as the cookie is re-hashed on lookup, so it misses.
  it('presenting the stored KV key (sha256(sid)) as the cookie is rejected', async () => {
    const sid = await createSession(env, USERS.member, 'magic_link');
    const storedKeyMaterial = await sha256Hex(sid); // what a KV read exposes, not the raw sid
    expect(storedKeyMaterial).not.toBe(sid);
    const res = await SELF.fetch(`${BASE}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${storedKeyMaterial}` },
    });
    expect(res.status).toBe(401); // getSession hashes it again → sha256(hash) ≠ stored key
  });

  it('revoke boundary: sessions at-or-before the revoke die, after survive (deterministic)', async () => {
    // Explicit mint timestamps — no wall-clock sleep — exercise the exact boundary,
    // including the same-millisecond case (inclusive `<=`, fail-safe).
    const before = await createSession(env, USERS.member, 'magic_link', 5_000);
    const sameMs = await createSession(env, USERS.member, 'magic_link', 6_000);
    const after = await createSession(env, USERS.member, 'magic_link', 6_001);
    await revokeAllSessions(env, USERS.member, 6_000);

    const status = async (sid: string) =>
      (await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: `${SESSION_COOKIE}=${sid}` } }))
        .status;
    expect(await status(before)).toBe(401); // minted before the revoke
    expect(await status(sameMs)).toBe(401); // same instant → killed (bounce, not ban)
    expect(await status(after)).toBe(200); // minted after the revoke → honored
  });

  it('admin force-logout endpoint kills the target’s sessions', async () => {
    const cookie = await cookieFor(USERS.member);
    const res = await asUser(USERS.admin, 'POST', `/api/users/${USERS.member}/revoke-sessions`, {});
    expect(res.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('logout destroys the session and clears the cookie', async () => {
    const cookie = await cookieFor(USERS.member);
    const res = await SELF.fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { cookie, origin: BASE },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('garbage session ids are 401', async () => {
    const res = await SELF.fetch(`${BASE}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${crypto.randomUUID()}` },
    });
    expect(res.status).toBe(401);
  });
});

// THE SESSION KEY (P2 run authority): sha256(sid) as hex, the suffix of the KV key. An agent turn
// stores it to find its session again, so resolving by key must be EXACTLY resolving by cookie —
// same revocation, same reserved-identifier rule — and the key must never be, or reveal, the sid.
describe('session keys: getSessionByKey and sessionKeyOf', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  function cookieRequest(sid: string, extra: Record<string, string> = {}): Request {
    return new Request(`${BASE}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${sid}`, ...extra },
    });
  }

  it('getSessionByKey(sha256(sid)) ≡ getSession(sid): live, revoked, logged out, unknown', async () => {
    const live = await createSession(env, USERS.member, 'magic_link', 9_000);
    const revoked = await createSession(env, USERS.admin, 'entra_oidc', 9_000);
    await revokeAllSessions(env, USERS.admin, 9_500);
    const loggedOut = await createSession(env, USERS.viewer, 'magic_link', 9_000);
    await destroySession(env, loggedOut);
    const unknown = crypto.randomUUID();
    for (const sid of [live, revoked, loggedOut, unknown]) {
      expect(await getSessionByKey(env, await sha256Hex(sid))).toEqual(await getSession(env, sid));
    }
    expect(await getSessionByKey(env, await sha256Hex(live))).toEqual({
      email: USERS.member,
      created_at_ms: 9_000,
      auth_method: 'magic_link',
    });
    expect(await getSessionByKey(env, await sha256Hex(revoked))).toBeNull();
    expect(await getSessionByKey(env, await sha256Hex(loggedOut))).toBeNull();
  });

  it('a session minted after a revocation resolves by ITS key; the revoked one stays dead', async () => {
    const before = await createSession(env, USERS.member, 'magic_link', 9_000);
    await revokeAllSessions(env, USERS.member, 9_000);
    const after = await createSession(env, USERS.member, 'magic_link', 9_001);
    expect(await getSessionByKey(env, await sha256Hex(before))).toBeNull();
    expect((await getSessionByKey(env, await sha256Hex(after)))?.created_at_ms).toBe(9_001);
  });

  it('anything but 64 lowercase hex characters names no key — a raw sid least of all', async () => {
    const sid = await createSession(env, USERS.member, 'magic_link');
    const key = await sha256Hex(sid);
    // The pre-AICOE-346 shape, a value stored under the RAW sid, is never honoured by key.
    await env.SESSIONS.put(
      `session:${sid}`,
      JSON.stringify({ email: USERS.member, created_at_ms: 1 }),
    );
    for (const bad of [sid, key.toUpperCase(), key.slice(1), `${key}0`, '', ` ${key}`]) {
      expect(await getSessionByKey(env, bad), JSON.stringify(bad)).toBeNull();
    }
    expect(await getSessionByKey(env, 42 as unknown as string)).toBeNull();
    expect(await getSessionByKey(env, key)).not.toBeNull();
  });

  it('sessionKeyOf is the KV key suffix — and never the sid', async () => {
    const sid = await createSession(env, USERS.member, 'magic_link');
    const key = await sessionKeyOf(cookieRequest(sid));
    expect(key).toBe(await sha256Hex(sid));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(sid);
    expect(key).not.toContain(sid);
    expect(await env.SESSIONS.get(`session:${key}`)).not.toBeNull();
    // Presented as a cookie, the key is hashed again and resolves nothing — exactly like a key
    // lifted from KV (the AICOE-346 replay test above).
    const replay = await SELF.fetch(`${BASE}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${key}` },
    });
    expect(replay.status).toBe(401);
  });

  it('sessionKeyOf is null without a session cookie, and for any bearer request', async () => {
    const sid = await createSession(env, USERS.member, 'magic_link');
    expect(await sessionKeyOf(new Request(`${BASE}/api/me`))).toBeNull();
    expect(await sessionKeyOf(cookieRequest('', {}))).toBeNull();
    expect(
      await sessionKeyOf(new Request(`${BASE}/api/me`, { headers: { cookie: `other=${sid}` } })),
    ).toBeNull();
    // resolvePrincipal takes the bearer branch for such a request, so no session authenticated it.
    for (const authorization of ['Bearer t_x', 'bearer t_x', 'BEARER t_x']) {
      expect(await sessionKeyOf(cookieRequest(sid, { authorization }))).toBeNull();
    }
  });

  it('mintedAtMs reads a usable mint time only', () => {
    const base: SessionData = { email: USERS.member, created_at_ms: 9_000 };
    expect(mintedAtMs(base)).toBe(9_000);
    expect(mintedAtMs({ ...base, created_at_ms: 0 })).toBe(0);
    for (const bogus of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '9000', null, undefined]) {
      expect(
        mintedAtMs({ ...base, created_at_ms: bogus as unknown as number }),
        String(bogus),
      ).toBeNull();
    }
  });
});
