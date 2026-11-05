import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveApiTokenByHash, sha256Hex } from '../../src/auth/tokens';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

describe('bearer tokens (t_*)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  async function createToken(asEmail: string): Promise<{ token: string; id: number }> {
    const res = await asUser(asEmail, 'POST', '/api/tokens', { name: 'test-token' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { token: string; id: number } };
    return body.data;
  }

  it('mints a t_ token whose plaintext authenticates as the user', async () => {
    const { token } = await createToken(USERS.member);
    expect(token.startsWith('t_')).toBe(true);
    expect(token.length).toBe(42);

    const me = await SELF.fetch(`${BASE}/api/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { data: { email: string; auth_method: string } };
    expect(body.data.email).toBe(USERS.member);
    expect(body.data.auth_method).toBe('api_token');
  });

  it('stores only the hash; the list endpoint masks tokens', async () => {
    const { token } = await createToken(USERS.member);
    const row = await env.DB.prepare('SELECT token_hash, prefix FROM api_tokens').first<{
      token_hash: string;
      prefix: string;
    }>();
    expect(row?.token_hash).toBe(await sha256Hex(token));
    expect(row?.prefix).toBe(token.slice(0, 10));

    const list = await asUser(USERS.member, 'GET', '/api/tokens');
    const body = (await list.json()) as { data: { tokens: Record<string, unknown>[] } };
    expect(body.data.tokens[0]).not.toHaveProperty('token');
    expect(body.data.tokens[0]).not.toHaveProperty('token_hash');
  });

  it('revoked tokens stop working immediately', async () => {
    const { token, id } = await createToken(USERS.member);
    const del = await asUser(USERS.member, 'DELETE', `/api/tokens/${id}`);
    expect(del.status).toBe(204);
    const me = await SELF.fetch(`${BASE}/api/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
  });

  it("revoking someone else's token id behaves like a missing one (404)", async () => {
    const { id } = await createToken(USERS.member);
    const res = await asUser(USERS.admin, 'DELETE', `/api/tokens/${id}`);
    expect(res.status).toBe(404);
  });

  // resolveApiTokenByHash backs the MCP adapter's per-call live re-resolution (it stores the
  // token HASH in session state, never the plaintext) — so it must be live-checked like the
  // plaintext path: same principal for a valid hash, null once the token or the user dies.
  describe('resolveApiTokenByHash (MCP live re-resolution)', () => {
    it('resolves a live principal from the token hash, matching the plaintext path', async () => {
      const { token } = await createToken(USERS.member);
      const p = await resolveApiTokenByHash(env, await sha256Hex(token));
      expect(p).toMatchObject({
        email: USERS.member,
        role: 'member',
        authMethod: 'api_token',
        credentialTransport: 'bearer',
      });
    });

    it('returns null for an unknown hash', async () => {
      expect(await resolveApiTokenByHash(env, await sha256Hex('t_nope'))).toBeNull();
    });

    it('returns null once the token is revoked (mid-session revocation takes effect)', async () => {
      const { token, id } = await createToken(USERS.member);
      const hash = await sha256Hex(token);
      expect(await resolveApiTokenByHash(env, hash)).not.toBeNull();
      await asUser(USERS.member, 'DELETE', `/api/tokens/${id}`);
      expect(await resolveApiTokenByHash(env, hash)).toBeNull();
    });

    it('returns null once the user is disabled (the live user check)', async () => {
      const { token } = await createToken(USERS.member);
      const hash = await sha256Hex(token);
      await env.DB.prepare("UPDATE users SET disabled_at = datetime('now') WHERE email = ?")
        .bind(USERS.member)
        .run();
      expect(await resolveApiTokenByHash(env, hash)).toBeNull();
    });
  });

  it('a disabled user’s tokens die with them (live user check)', async () => {
    const { token } = await createToken(USERS.member);
    await env.DB.prepare("UPDATE users SET disabled_at = datetime('now') WHERE email = ?")
      .bind(USERS.member)
      .run();
    const me = await SELF.fetch(`${BASE}/api/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(401);
  });

  it('expired tokens are rejected', async () => {
    const plaintext = 't_expired00000000000000000000000000000000';
    await env.DB.prepare(
      "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at) VALUES (?, 'old', ?, 't_expired0', datetime('now', '-1 day'))",
    )
      .bind(USERS.member, await sha256Hex(plaintext))
      .run();
    const me = await SELF.fetch(`${BASE}/api/me`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(me.status).toBe(401);
  });

  // PIA C8: tokens.self is NON-DELEGABLE. Bearer requests are CSRF-exempt, so a token that could
  // mint would let a leak outlive its own revocation. The denial is the uniform 404 — the same
  // bytes as a route that does not exist — even for an owner's token.
  it('a bearer token cannot mint, list or revoke tokens (uniform 404, even for an owner)', async () => {
    const { token, id } = await createToken(USERS.owner);
    const call = (method: string, path: string, body?: unknown) =>
      SELF.fetch(BASE + path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const missing = await (await call('GET', '/api/no-such-route')).text();
    for (const res of [
      await call('POST', '/api/tokens', { name: 'child' }),
      await call('GET', '/api/tokens'),
      await call('DELETE', `/api/tokens/${id}`),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(missing);
    }
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n, MAX(revoked_at) AS revoked FROM api_tokens',
    ).first<{ n: number; revoked: string | null }>();
    expect(row).toEqual({ n: 1, revoked: null }); // nothing minted, nothing revoked
  });

  it('viewers cannot mint tokens (tokens.self excludes viewer)', async () => {
    const res = await asUser(USERS.viewer, 'POST', '/api/tokens', { name: 'nope' });
    expect(res.status).toBe(404);
  });

  // AICOE-208: last_used_at is refreshed at most once per window, not per request.
  describe('last_used_at throttle', () => {
    const lastUsed = (id: number) =>
      env.DB.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?')
        .bind(id)
        .first<{ last_used_at: string | null }>()
        .then((r) => r?.last_used_at ?? null);

    const hit = (token: string) =>
      SELF.fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${token}` } });

    it('records last_used_at on first use', async () => {
      const { token, id } = await createToken(USERS.member);
      expect(await lastUsed(id)).toBeNull();
      expect((await hit(token)).status).toBe(200);
      expect(await lastUsed(id)).not.toBeNull();
    });

    it('does NOT rewrite last_used_at on rapid subsequent use', async () => {
      const { token, id } = await createToken(USERS.member);
      // Seed a recent (within-window) timestamp; a fresh token must not trigger a write.
      await env.DB.prepare(
        "UPDATE api_tokens SET last_used_at = datetime('now', '-1 minute') WHERE id = ?",
      )
        .bind(id)
        .run();
      const before = await lastUsed(id);
      expect((await hit(token)).status).toBe(200);
      expect(await lastUsed(id)).toBe(before); // unchanged — no per-request write
    });

    it('refreshes last_used_at once it is stale', async () => {
      const { token, id } = await createToken(USERS.member);
      await env.DB.prepare(
        "UPDATE api_tokens SET last_used_at = datetime('now', '-1 hour') WHERE id = ?",
      )
        .bind(id)
        .run();
      const before = await lastUsed(id);
      expect((await hit(token)).status).toBe(200);
      expect(await lastUsed(id)).not.toBe(before); // stale → refreshed
    });
  });
});
