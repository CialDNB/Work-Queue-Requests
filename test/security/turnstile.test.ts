import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authRoutes } from '../../src/auth/routes';
import type { Env } from '../../src/env';
import { type Fetcher, verifyTurnstile } from '../../src/security/turnstile';
import { BASE } from '../helpers/http';

// Base test env has no Turnstile config → disabled. Override per-case.
const envWith = (over: Partial<Env>): Env => ({ ...(env as unknown as Env), ...over });
const enabled = (over: Partial<Env> = {}): Env =>
  envWith({ TURNSTILE_SITE_KEY: 'site-test', TURNSTILE_SECRET: 'secret-test', ...over });

const ok = (): Response => Response.json({ success: true });
const bad = (codes: string[]): Response => Response.json({ success: false, 'error-codes': codes });
const never: Fetcher = () => {
  throw new Error('fetcher should not be called');
};

describe('verifyTurnstile', () => {
  it('is disabled (pass-through) when no site key is set — never calls siteverify', async () => {
    const res = await verifyTurnstile(
      envWith({ TURNSTILE_SITE_KEY: '' }),
      'anything',
      '1.2.3.4',
      never,
    );
    expect(res).toEqual({ enabled: false, ok: true });
  });

  it('accepts a valid token and sends secret + response + remoteip to siteverify', async () => {
    let captured: { url: string; body: string } | null = null;
    const res = await verifyTurnstile(enabled(), 'good-token', '1.2.3.4', async (url, init) => {
      captured = { url, body: String(init.body) };
      return ok();
    });
    expect(res).toEqual({ enabled: true, ok: true });
    expect(captured!.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(captured!.body).toContain('secret=secret-test');
    expect(captured!.body).toContain('response=good-token');
    expect(captured!.body).toContain('remoteip=1.2.3.4');
  });

  it('rejects an invalid token and surfaces the error codes', async () => {
    const res = await verifyTurnstile(enabled(), 'bad', '1.2.3.4', async () =>
      bad(['invalid-input-response']),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCodes).toEqual(['invalid-input-response']);
  });

  it('fails CLOSED when enabled but the secret is missing — never calls siteverify', async () => {
    const res = await verifyTurnstile(
      envWith({ TURNSTILE_SITE_KEY: 'site-test', TURNSTILE_SECRET: undefined }),
      'good',
      '1.2.3.4',
      never,
    );
    expect(res).toEqual({ enabled: true, ok: false, errorCodes: ['missing-secret'] });
  });

  it('fails CLOSED when enabled but no token was supplied — never calls siteverify', async () => {
    const res = await verifyTurnstile(enabled(), '', '1.2.3.4', never);
    expect(res).toEqual({ enabled: true, ok: false, errorCodes: ['missing-input-response'] });
  });

  it('fails CLOSED on a network error', async () => {
    const res = await verifyTurnstile(enabled(), 'good', '1.2.3.4', async () => {
      throw new Error('boom');
    });
    expect(res).toEqual({ enabled: true, ok: false, errorCodes: ['network-error'] });
  });

  it('fails CLOSED on a non-2xx siteverify response', async () => {
    const res = await verifyTurnstile(
      enabled(),
      'good',
      '1.2.3.4',
      async () => new Response('nope', { status: 500 }),
    );
    expect(res).toEqual({ enabled: true, ok: false, errorCodes: ['http-500'] });
  });

  it('treats an unset (undefined) site key as disabled', async () => {
    const res = await verifyTurnstile(envWith({}), 'tok', '1.2.3.4', never);
    expect(res).toEqual({ enabled: false, ok: true });
  });

  it('omits remoteip from siteverify when the ip is empty', async () => {
    let body = '';
    const res = await verifyTurnstile(enabled(), 'good', '', async (_url, init) => {
      body = String(init.body);
      return ok();
    });
    expect(res.ok).toBe(true);
    expect(body).not.toContain('remoteip');
  });

  it('falls back to a generic code when siteverify returns no error-codes', async () => {
    const res = await verifyTurnstile(enabled(), 'bad', '1.2.3.4', async () =>
      Response.json({ success: false }),
    );
    expect(res).toEqual({ enabled: true, ok: false, errorCodes: ['verification-failed'] });
  });

  it('fails CLOSED when siteverify returns 200 with a non-JSON body', async () => {
    const res = await verifyTurnstile(
      enabled(),
      'good',
      '1.2.3.4',
      async () => new Response('not-json', { status: 200 }),
    );
    expect(res).toEqual({ enabled: true, ok: false, errorCodes: ['verification-failed'] });
  });

  it('uses the real fetch by default (no injected fetcher) and fails closed', async () => {
    // The test pool has no outbound network, so the default fetcher path resolves to a
    // rejection (→ network-error). Either way the contract holds: enabled, not ok.
    const res = await verifyTurnstile(enabled(), 'good', '1.2.3.4');
    expect(res.enabled).toBe(true);
    expect(res.ok).toBe(false);
  });
});

describe('/auth/config + /auth/request challenge gate', () => {
  const post = (body: unknown, env: Env) =>
    authRoutes().request(
      `${BASE}/auth/request`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify(body),
      },
      env,
    );

  it('exposes the public site key via /auth/config', async () => {
    const res = await authRoutes().request(`${BASE}/auth/config`, {}, enabled());
    const body = (await res.json()) as { data: { turnstile_site_key: string } };
    expect(body.data.turnstile_site_key).toBe('site-test');
  });

  it('returns an empty site key when the challenge is disabled', async () => {
    const res = await authRoutes().request(
      `${BASE}/auth/config`,
      {},
      envWith({ TURNSTILE_SITE_KEY: '' }),
    );
    const body = (await res.json()) as { data: { turnstile_site_key: string } };
    expect(body.data.turnstile_site_key).toBe('');
  });

  it('trims the site key so a whitespace-only value reads as disabled (matches verifyTurnstile)', async () => {
    const res = await authRoutes().request(
      `${BASE}/auth/config`,
      {},
      envWith({ TURNSTILE_SITE_KEY: '   ' }),
    );
    const body = (await res.json()) as { data: { turnstile_site_key: string } };
    expect(body.data.turnstile_site_key).toBe('');
  });

  it('rejects a login request with no Turnstile token when enabled', async () => {
    const res = await post({ email: 'someone@cialdnb.com' }, enabled());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('challenge_failed');
  });

  it('rejects an oversized turnstile_token (capped before siteverify) when enabled', async () => {
    const res = await post(
      { email: 'someone@cialdnb.com', turnstile_token: 'A'.repeat(4096) },
      enabled(),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('challenge_failed');
  });

  it('fails closed if enabled but the secret is missing (no silent bypass)', async () => {
    const res = await post(
      { email: 'someone@cialdnb.com', turnstile_token: 'x' },
      envWith({ TURNSTILE_SITE_KEY: 'site-test', TURNSTILE_SECRET: undefined }),
    );
    expect(res.status).toBe(403);
  });
});
