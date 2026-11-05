// The reserved service namespace (`*.invalid`, src/auth/serviceNamespace.ts): a machine
// principal's identifier can never be a person. It cannot be invited, cannot get or redeem a magic
// link, cannot hold a session — each refused on its own, not merely because the address is absent
// from `users`. (The Entra callback's refusal is pinned in test/auth/oidc.test.ts, where the fake
// Microsoft lives.) Every identity here is synthetic.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/cookies';
import { requestMagicLink, verifyMagicLink } from '../../src/auth/magicLink';
import {
  isReservedIdentifier,
  isValidServiceSlug,
  serviceDomainLabel,
  serviceIdentifierFor,
} from '../../src/auth/serviceNamespace';
import { createSession, getSession, ReservedSessionError } from '../../src/auth/sessions';
import { sha256Hex } from '../../src/auth/tokens';
import { makeDb } from '../../src/data';
import { ReservedAddressError } from '../../src/data/users';
import type { Env } from '../../src/env';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

const SVC = 'svc-etl@test-app.invalid';

// A users row for a reserved address can only be a hand insert (users.add refuses one) — the case
// the refusals must hold against, so a pre-upgrade or imported row never becomes a way in.
async function handInsertUser(email: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (email, name, role, added_by) VALUES (?, 'x', 'owner', ?)",
  )
    .bind(email, USERS.owner)
    .run();
}

/** Every console line (any level) that parses as a JSON event. */
function events(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    if (typeof call[0] !== 'string') continue;
    try {
      out.push(JSON.parse(call[0]) as Record<string, unknown>);
    } catch {
      // not a structured event
    }
  }
  return out;
}

describe('isReservedIdentifier — the whole .invalid TLD, however it is spelled', () => {
  it('recognises the TLD, any subdomain, any case, a trailing root dot and padding', () => {
    for (const a of [
      SVC,
      'SVC-ETL@TEST-APP.INVALID',
      'anyone@invalid',
      'x@a.b.invalid',
      'svc-etl@test-app.invalid.',
      ' svc-etl@test-app.invalid ',
      'not-svc-shaped@app.invalid', // not a well-formed svc-* id, still never a person
      'a@b@c.invalid', // the domain a mail system routes on is after the LAST '@'
    ]) {
      expect(isReservedIdentifier(a), a).toBe(true);
    }
  });

  it('leaves real addresses alone, including look-alikes', () => {
    for (const a of [
      USERS.owner,
      'svc-etl@test-app.example',
      'invalid@test.example',
      'x@invalid.example',
      'x@notinvalid',
      'x@a.invalidx',
      'no-at-sign.invalid',
      '',
    ]) {
      expect(isReservedIdentifier(a), a).toBe(false);
    }
  });
});

describe('service identifiers', () => {
  it('slugs: lowercase words joined by single hyphens, starting with a letter, 2–40 chars', () => {
    for (const s of ['etl', 'c360-etl', 'crm', 'sap-hr', 'intranet2', 'ab', 'a'.repeat(40)]) {
      expect(isValidServiceSlug(s), s).toBe(true);
    }
    for (const s of ['a', 'a'.repeat(41), 'ETL', '2etl', 'etl-', '-etl', 'e--tl', 'e_tl', 'e tl']) {
      expect(isValidServiceSlug(s), s).toBe(false);
    }
  });

  it('svc-<slug>@<app>.invalid — the app name as the label, or `app` when it is not a clean one', () => {
    expect(serviceIdentifierFor('c360-etl', 'insights')).toBe('svc-c360-etl@insights.invalid');
    expect(serviceIdentifierFor('crm', 'il-lingua')).toBe('svc-crm@il-lingua.invalid'); // il-lingua's own
    expect(serviceDomainLabel('Test-App')).toBe('test-app');
    for (const bad of ['', 'a', 'has space', 'x--y', '-x', 'x-', 'dots.in.it', 'a'.repeat(64)]) {
      expect(serviceDomainLabel(bad), bad).toBe('app');
    }
    expect(isReservedIdentifier(serviceIdentifierFor('etl', 'whatever'))).toBe(true);
  });

  it('refuses to build an identifier from an invalid slug (a programming error, not a fallback)', () => {
    expect(() => serviceIdentifierFor('Bad Slug', 'test-app')).toThrow(/invalid slug/);
  });
});

describe('a reserved address can never be a person', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('users.add refuses it (the data-layer wall) — nothing is written', async () => {
    for (const email of [SVC, 'Someone@Team.INVALID']) {
      await expect(
        makeDb(env).users.add({ email, role: 'viewer', addedBy: USERS.owner }),
      ).rejects.toBeInstanceOf(ReservedAddressError);
    }
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE email LIKE '%.invalid'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('POST /api/users answers 400 reserved_address, before the domain policy', async () => {
    const res = await asUser(USERS.owner, 'POST', '/api/users', { email: SVC, role: 'viewer' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('reserved_address');
  });
});

describe('a reserved address never gets or redeems a magic link', () => {
  beforeAll(applySchema);

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await seedDb();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  // An OPEN domain policy and an active users row for the address: the two things that would
  // otherwise let a link through. Only the namespace rule stands in the way.
  const OPEN = { ...env, ALLOWED_EMAIL_DOMAINS: '' } as Env;

  it('/auth/request mints nothing, logs no link, and records the refusal (domain only)', async () => {
    await handInsertUser(SVC);
    const deferred: Promise<unknown>[] = [];
    await requestMagicLink(OPEN, SVC, '/', '203.0.113.9', (p) => deferred.push(p));
    await Promise.all(deferred);

    const links = await env.DB.prepare('SELECT COUNT(*) AS n FROM magic_links').first<{
      n: number;
    }>();
    expect(links?.n).toBe(0);
    const logged = events(warn);
    expect(logged).toContainEqual({
      event: 'magic_link_refused',
      reason: 'service_identity',
      domain: 'test-app.invalid',
    });
    expect(logged.some((e) => e.event === 'magic_link_not_emailed')).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SVC);
    const audit = await env.DB.prepare(
      "SELECT actor_email, payload_json FROM audit_log WHERE action = 'magic_link_refused'",
    ).first<{ actor_email: string; payload_json: string }>();
    expect(audit?.actor_email).toBe('anonymous@refused');
    expect(JSON.parse(audit?.payload_json ?? '{}')).toEqual({
      reason: 'service_identity',
      domain: 'test-app.invalid',
    });
    const sent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'magic_link_sent'",
    ).first<{ n: number }>();
    expect(sent?.n).toBe(0);
  });

  it('the HTTP surface answers exactly as for an unknown address', async () => {
    const post = (email: string) =>
      SELF.fetch(`${BASE}/auth/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ email }),
      });
    const reserved = await post(SVC);
    const unknown = await post('nobody@test.example');
    expect(reserved.status).toBe(unknown.status);
    expect(await reserved.text()).toBe(await unknown.text());
  });

  it('/auth/verify burns a link minted for one by anything else, and signs nobody in', async () => {
    await handInsertUser(SVC);
    const token = 'ab'.repeat(32);
    await makeDb(env).magicLinks.insert(await sha256Hex(token), SVC, null, 900);
    expect(await verifyMagicLink(env, token, '203.0.113.9')).toBeNull();
    expect(events(warn)).toContainEqual({
      event: 'magic_link_verify_refused',
      reason: 'service_identity',
    });
    // Burnt: the claim consumed it, so it can never be retried.
    const row = await env.DB.prepare('SELECT consumed_at FROM magic_links').first<{
      consumed_at: string | null;
    }>();
    expect(row?.consumed_at).not.toBeNull();
    const logins = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login'",
    ).first<{ n: number }>();
    expect(logins?.n).toBe(0);
  });
});

describe('a reserved address can never hold a session', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('createSession refuses to mint one', async () => {
    await expect(createSession(env, SVC)).rejects.toBeInstanceOf(ReservedSessionError);
    await expect(createSession(env, 'X@Y.INVALID', 'entra_oidc')).rejects.toBeInstanceOf(
      ReservedSessionError,
    );
  });

  it('getSession refuses one written into KV by anything else — /api/me is a 401', async () => {
    await handInsertUser(SVC);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sid = crypto.randomUUID();
      await env.SESSIONS.put(
        `session:${await sha256Hex(sid)}`,
        JSON.stringify({ email: SVC, created_at_ms: Date.now(), auth_method: 'magic_link' }),
      );
      expect(await getSession(env, sid)).toBeNull();
      const me = await SELF.fetch(`${BASE}/api/me`, {
        headers: { cookie: `${SESSION_COOKIE}=${sid}`, origin: BASE },
      });
      expect(me.status).toBe(401);
      expect(events(warn)).toContainEqual({ event: 'session_refused', reason: 'service_identity' });
    } finally {
      warn.mockRestore();
    }
  });

  it('a person’s session is unaffected', async () => {
    const sid = await createSession(env, USERS.member);
    expect((await getSession(env, sid))?.email).toBe(USERS.member);
  });
});
