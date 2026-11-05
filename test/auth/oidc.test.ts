// Adversarial suite for the Entra SSO path (src/auth/oidc.ts). No network: a fake
// fetcher plays Microsoft's token + JWKS endpoints, and ID tokens are signed with a
// test RSA key generated in-runtime. The multi-tenant allowlist, the pinned RS256
// validation, the browser-bound transaction cookie, and the invite-only/domain gates
// each get a hostile test — and every refusal must be byte-identical (anti-enumeration).
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/cookies';
import {
  beginOidcLogin,
  completeOidcLogin,
  entraConfig,
  type Fetcher,
  OIDC_TXN_COOKIE,
  resetOidcJwksForTests,
  setOidcFetcherForTests,
  verifyIdToken,
} from '../../src/auth/oidc';
import { authRoutes } from '../../src/auth/routes';
import { sha256Hex } from '../../src/auth/tokens';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { BASE } from '../helpers/http';

// Must match wrangler.test.jsonc (synthetic on purpose — real tenant IDs never appear
// in fixtures; they live in docs/runbooks/entra-sso-setup.md).
const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FOREIGN_TENANT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ---------------------------------------------------------------------------
// JWT forging kit
// ---------------------------------------------------------------------------

const te = new TextEncoder();
const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const b64urlJson = (obj: unknown): string => b64url(te.encode(JSON.stringify(obj)));

let signingKeys: CryptoKeyPair; // the "Microsoft" key
let rogueKeys: CryptoKeyPair; // an attacker's key, never in the served JWKS
let jwkA: JsonWebKey;
let jwkRotated: JsonWebKey;
let rotatedKeys: CryptoKeyPair;

const KID = 'test-kid-1';
const KID_ROTATED = 'test-kid-2';

async function genKeys(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

interface Overrides {
  header?: Record<string, unknown>;
  key?: CryptoKey;
  [claim: string]: unknown;
}

/** A valid-by-default ID token for USERS.member from TENANT_A; override to attack. */
async function signIdToken(nonce: string, overrides: Overrides = {}): Promise<string> {
  const { header: headerOverride, key, ...claimOverrides } = overrides;
  const nowSec = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    aud: CLIENT_ID,
    iss: `https://login.microsoftonline.com/${TENANT_A}/v2.0`,
    tid: TENANT_A,
    ver: '2.0',
    iat: nowSec - 30,
    nbf: nowSec - 30,
    exp: nowSec + 3600,
    nonce,
    email: USERS.member,
    preferred_username: USERS.member,
    name: 'Alice Member',
    ...claimOverrides,
  };
  for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
  const header = { typ: 'JWT', alg: 'RS256', kid: KID, ...headerOverride };
  const h = b64urlJson(header);
  const p = b64urlJson(claims);
  if (header.alg === 'none') return `${h}.${p}.`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key ?? signingKeys.privateKey,
    te.encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// Fake Microsoft
// ---------------------------------------------------------------------------

interface Upstream {
  idToken?: string;
  tokenStatus?: number;
  tokenBody?: unknown;
  jwksKeys?: JsonWebKey[];
  calls: Array<{ url: string; body: string }>;
}

function fakeMicrosoft(u: Upstream): Fetcher {
  return async (url, init) => {
    u.calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
    if (url.includes('/discovery/v2.0/keys')) {
      const keys = (u.jwksKeys ?? [jwkA]).map((k, i) => ({
        kty: 'RSA',
        use: 'sig',
        kid: i === 0 ? KID : KID_ROTATED,
        n: k.n,
        e: k.e,
      }));
      return Response.json({ keys });
    }
    if (url.includes('/oauth2/v2.0/token')) {
      if (u.tokenStatus && u.tokenStatus !== 200) {
        return Response.json(u.tokenBody ?? { error: 'invalid_grant' }, { status: u.tokenStatus });
      }
      return Response.json(u.tokenBody ?? { id_token: u.idToken ?? '' });
    }
    throw new Error(`unexpected upstream fetch in test: ${url}`);
  };
}

// ---------------------------------------------------------------------------
// Flow helpers (direct module calls — same idiom as the AI budget tests)
// ---------------------------------------------------------------------------

async function begin(returnTo?: string): Promise<{ state: string; nonce: string; cookie: string }> {
  const qs = returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`;
  const res = await beginOidcLogin(env, new Request(`${BASE}/auth/oidc/login${qs}`));
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location') ?? '');
  const setCookie = res.headers.get('set-cookie') ?? '';
  return {
    state: loc.searchParams.get('state') ?? '',
    nonce: loc.searchParams.get('nonce') ?? '',
    cookie: setCookie.split(';')[0] ?? '',
  };
}

function callback(
  cookie: string | null,
  params: Record<string, string>,
  overrideEnv: Env = env,
): Promise<Response> {
  const url = `${BASE}/auth/oidc/callback?${new URLSearchParams(params).toString()}`;
  return completeOidcLogin(
    overrideEnv,
    new Request(url, { headers: cookie ? { cookie } : {} }),
    '203.0.113.7',
  );
}

/** Runs the whole dance for a signed token; returns the callback response. */
async function fullFlow(
  tokenClaims: Overrides = {},
  upstream: Partial<Upstream> = {},
  overrideEnv: Env = env,
): Promise<{ res: Response; calls: Upstream['calls'] }> {
  const { state, nonce, cookie } = await begin('/notes?x=1');
  const idToken = await signIdToken(nonce, tokenClaims);
  const u: Upstream = { idToken, calls: [], ...upstream };
  setOidcFetcherForTests(fakeMicrosoft(u));
  const res = await callback(cookie, { code: 'authcode-1', state }, overrideEnv);
  return { res, calls: u.calls };
}

// getSetCookie exists in workerd but not in this workers-types Headers surface yet.
const setCookies = (res: Response): string[] =>
  (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie();

const sessionSid = (res: Response): string | null => {
  for (const c of setCookies(res)) {
    if (c.startsWith(`${SESSION_COOKIE}=`)) return c.split(';')[0]?.split('=')[1] ?? null;
  }
  return null;
};

describe('Entra SSO (multi-tenant OIDC)', () => {
  beforeAll(async () => {
    await applySchema();
    signingKeys = await genKeys();
    rogueKeys = await genKeys();
    rotatedKeys = await genKeys();
    jwkA = (await crypto.subtle.exportKey('jwk', signingKeys.publicKey)) as JsonWebKey;
    jwkRotated = (await crypto.subtle.exportKey('jwk', rotatedKeys.publicKey)) as JsonWebKey;
  });
  beforeEach(async () => {
    await seedDb();
    // seedDb() does not reset app_settings (not in its TABLES), and tests here enable the
    // entra-only policy — clear it so no test inherits another's.
    await env.DB.prepare("DELETE FROM app_settings WHERE key = 'login'").run();
    resetOidcJwksForTests();
  });
  afterEach(() => setOidcFetcherForTests(null));

  // ---- configuration gate -------------------------------------------------

  describe('entraConfig', () => {
    it('is disabled when unset, without noise', () => {
      expect(entraConfig({ ...env, ENTRA_CLIENT_ID: '', ENTRA_ALLOWED_TENANTS: '' })).toBeNull();
      expect(
        entraConfig({ ...env, ENTRA_CLIENT_ID: undefined, ENTRA_ALLOWED_TENANTS: undefined }),
      ).toBeNull();
    });

    it('fails closed on partial or malformed config (typo ≠ narrower allowlist)', () => {
      expect(entraConfig({ ...env, ENTRA_ALLOWED_TENANTS: '' })).toBeNull(); // id only
      expect(entraConfig({ ...env, ENTRA_CLIENT_ID: '' })).toBeNull(); // tenants only
      expect(entraConfig({ ...env, ENTRA_ALLOWED_TENANTS: `${TENANT_A},not-a-guid` })).toBeNull();
      expect(entraConfig({ ...env, ENTRA_CLIENT_ID: 'not-a-guid' })).toBeNull();
    });

    it('parses and lowercases the allowlist', () => {
      const cfg = entraConfig({
        ...env,
        ENTRA_ALLOWED_TENANTS: ` ${TENANT_A.toUpperCase()} , ${TENANT_B} `,
      });
      expect(cfg).toEqual({ clientId: CLIENT_ID, allowedTenants: [TENANT_A, TENANT_B] });
    });
  });

  // ---- /auth/oidc/login ----------------------------------------------------

  describe('login initiation', () => {
    it('404s when SSO is disabled', async () => {
      const res = await beginOidcLogin(
        { ...env, ENTRA_CLIENT_ID: '', ENTRA_ALLOWED_TENANTS: '' },
        new Request(`${BASE}/auth/oidc/login`),
      );
      expect(res.status).toBe(404);
    });

    it('redirects to the organizations endpoint with PKCE S256 and a bound txn cookie', async () => {
      const res = await beginOidcLogin(env, new Request(`${BASE}/auth/oidc/login`));
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location') ?? '');
      expect(loc.origin).toBe('https://login.microsoftonline.com');
      expect(loc.pathname).toBe('/organizations/oauth2/v2.0/authorize');
      expect(loc.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(loc.searchParams.get('response_type')).toBe('code');
      expect(loc.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/oidc/callback`);
      expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
      expect(loc.searchParams.get('code_challenge')).toBeTruthy();
      expect(loc.searchParams.get('scope')).toBe('openid profile email');
      expect(loc.searchParams.get('state')).toMatch(/^[a-f0-9]{32}$/);
      expect(loc.searchParams.get('nonce')).toMatch(/^[a-f0-9]{32}$/);
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`${OIDC_TXN_COOKIE}=`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('Max-Age=600');
    });

    it('is mounted at GET /auth/oidc/login (route wiring)', async () => {
      const res = await SELF.fetch(`${BASE}/auth/oidc/login`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('login.microsoftonline.com');
    });

    // The per-IP ceiling in src/auth/routes.ts. Hardcoded here on purpose, like the permission
    // matrix: changing the constant without consciously updating this test fails CI.
    const OIDC_LOGIN_LIMIT = 120;

    // Drives the limiter to its boundary by topping up its OWN counter rather than brute-forcing
    // 121 sequential round-trips. The loop this replaces cost one full-stack request (PKCE crypto
    // + a KV get/put) per unit of the production constant, so its wall-clock scaled with a number
    // chosen for security reasons and swung ~10x with machine load — 3.5s to 32s, straddling
    // vitest's 30s default, which is what made it flaky (it failed in isolation on a loaded box,
    // not only under the full suite). 119 of those 121 iterations asserted nothing.
    //
    // The key is discovered from KV, not recomputed here, so the test carries no copy of the
    // `rl:<key>:<windowStart>` format and no hour-window arithmetic to straddle. If the route ever
    // stops going through the limiter, the prefix finds nothing and this fails on `rlKey`.
    it('rate-limits repeated initiations per IP (generous: offices share NAT egress IPs)', async () => {
      const ip = '203.0.113.7'; // TEST-NET-3 — documentation range, never routable
      const login = () =>
        SELF.fetch(`${BASE}/auth/oidc/login`, {
          redirect: 'manual',
          headers: { 'cf-connecting-ip': ip },
        });

      expect((await login()).status).toBe(302);
      const rlKey = (await env.SESSIONS.list({ prefix: 'rl:oidc-login:' })).keys[0]?.name;
      expect(rlKey).toContain(ip); // the route counts against THIS ip's window

      // One below the ceiling is still allowed — pins the off-by-one the old loop never checked,
      // since it only asserted the status of its final iteration.
      await env.SESSIONS.put(rlKey as string, String(OIDC_LOGIN_LIMIT - 1));
      expect((await login()).status).toBe(302);

      // ...and that request consumed the last slot, so the next one is refused.
      expect((await login()).status).toBe(429);
    });
  });

  // ---- ID-token validation (the security core) ------------------------------

  describe('verifyIdToken', () => {
    const cfg = { clientId: CLIENT_ID, allowedTenants: [TENANT_A, TENANT_B] };
    const NONCE = 'a'.repeat(32);

    async function verdictFor(overrides: Overrides, jwksKeys?: JsonWebKey[]) {
      const token = await signIdToken(NONCE, overrides);
      const u: Upstream = { calls: [], jwksKeys };
      return verifyIdToken(token, cfg, NONCE, fakeMicrosoft(u));
    }

    it('accepts a valid token and lowercases the email', async () => {
      const v = await verdictFor({ email: 'Alice@Test.Example' });
      expect(v).toEqual({
        ok: true,
        claims: { email: 'alice@test.example', tid: TENANT_A, name: 'Alice Member' },
      });
    });

    it('rejects alg:none and non-RS256 algorithms outright', async () => {
      expect(await verdictFor({ header: { alg: 'none' } })).toEqual({
        ok: false,
        reason: 'bad_alg_or_kid',
      });
      expect(await verdictFor({ header: { alg: 'HS256' } })).toEqual({
        ok: false,
        reason: 'bad_alg_or_kid',
      });
      expect(await verdictFor({ header: { kid: undefined } })).toMatchObject({ ok: false });
    });

    it('rejects a token for a different app (aud)', async () => {
      expect(await verdictFor({ aud: '22222222-2222-2222-2222-222222222222' })).toEqual({
        ok: false,
        reason: 'aud_mismatch',
      });
    });

    it('THE ALLOWLIST: rejects a validly-signed token from a foreign tenant', async () => {
      const v = await verdictFor({
        tid: FOREIGN_TENANT,
        iss: `https://login.microsoftonline.com/${FOREIGN_TENANT}/v2.0`,
      });
      expect(v).toEqual({ ok: false, reason: 'tenant_not_allowed' });
    });

    it('rejects an issuer that does not match the tid exactly', async () => {
      const v = await verdictFor({
        tid: TENANT_A,
        iss: `https://login.microsoftonline.com/${TENANT_B}/v2.0`,
      });
      expect(v).toEqual({ ok: false, reason: 'iss_mismatch' });
      // Prefix tricks must not pass an exact match.
      const sneaky = await verdictFor({
        iss: `https://login.microsoftonline.com/${TENANT_A}/v2.0.evil.example`,
      });
      expect(sneaky).toEqual({ ok: false, reason: 'iss_mismatch' });
    });

    it('rejects v1 tokens, expired tokens, and not-yet-valid tokens', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      expect(await verdictFor({ ver: undefined })).toEqual({ ok: false, reason: 'bad_ver' });
      expect(await verdictFor({ exp: nowSec - 3600 })).toEqual({ ok: false, reason: 'expired' });
      expect(await verdictFor({ nbf: nowSec + 3600 })).toEqual({
        ok: false,
        reason: 'not_yet_valid',
      });
    });

    it('rejects a nonce mismatch (token replay across transactions)', async () => {
      const token = await signIdToken('b'.repeat(32));
      const v = await verifyIdToken(token, cfg, NONCE, fakeMicrosoft({ calls: [] }));
      expect(v).toEqual({ ok: false, reason: 'nonce_mismatch' });
    });

    it('rejects signatures from a key not in the JWKS (rogue signer)', async () => {
      const v = await verdictFor({ key: rogueKeys.privateKey });
      expect(v).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects a tampered payload (signature over different bytes)', async () => {
      const token = await signIdToken(NONCE);
      const [h, , s] = token.split('.') as [string, string, string];
      const forged = `${h}.${b64urlJson({ aud: CLIENT_ID, iss: `https://login.microsoftonline.com/${TENANT_A}/v2.0`, tid: TENANT_A, ver: '2.0', exp: Math.floor(Date.now() / 1000) + 3600, nbf: 0, nonce: NONCE, email: USERS.owner })}.${s}`;
      const v = await verifyIdToken(forged, cfg, NONCE, fakeMicrosoft({ calls: [] }));
      expect(v).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('handles signing-key rotation: unknown kid is refused during the cooldown, accepted after refetch', async () => {
      // Prime the cache with the old JWKS.
      expect((await verdictFor({})).ok).toBe(true);
      const now = Date.now();
      const rotated = await signIdToken(NONCE, {
        header: { kid: KID_ROTATED },
        key: rotatedKeys.privateKey,
      });
      // Same instant → cooldown suppresses a refetch; fail closed.
      const during = await verifyIdToken(
        rotated,
        cfg,
        NONCE,
        fakeMicrosoft({ calls: [], jwksKeys: [jwkA, jwkRotated] }),
        now,
      );
      expect(during).toEqual({ ok: false, reason: 'unknown_signing_key' });
      // Past the cooldown the new key is fetched and the token verifies.
      const after = await verifyIdToken(
        rotated,
        cfg,
        NONCE,
        fakeMicrosoft({ calls: [], jwksKeys: [jwkA, jwkRotated] }),
        now + 61_000,
      );
      expect(after.ok).toBe(true);
    });

    it('falls back to an email-shaped preferred_username, refuses UPN-shaped ones', async () => {
      const fallback = await verdictFor({
        email: undefined,
        preferred_username: 'Vera@Test.Example',
      });
      expect(fallback).toMatchObject({ ok: true, claims: { email: 'vera@test.example' } });
      const upn = await verdictFor({
        email: undefined,
        preferred_username: 'guest_gmail.com#EXT#@partner.onmicrosoft.com@x',
      });
      expect(upn).toEqual({ ok: false, reason: 'no_usable_email_claim' });
      const none = await verdictFor({ email: undefined, preferred_username: undefined });
      expect(none).toEqual({ ok: false, reason: 'no_usable_email_claim' });
    });

    // --- nOAuth (identity binding) --------------------------------------------------
    // `email` is MUTABLE, UNVERIFIED directory data. These pin that it is only ever trusted
    // with proof the issuing tenant may assert it: xms_edov, or email === UPN. See the
    // identity-binding comment in src/auth/oidc.ts.

    it('nOAuth: a divergent UNVERIFIED email loses to the real UPN (no impersonation)', async () => {
      // The attack: a member of an ALLOWLISTED tenant sets their profile email to the owner's
      // address. The token is genuinely signed and passes tid/iss/aud/nonce/signature/time.
      const v = await verdictFor({
        email: USERS.owner, // spoofed
        preferred_username: 'attacker@partner.example', // the attacker's real, domain-bound UPN
      });
      // Identity must resolve to the ATTACKER, never the owner.
      expect(v).toMatchObject({ ok: true, claims: { email: 'attacker@partner.example' } });
      expect(v).not.toMatchObject({ claims: { email: USERS.owner } });
    });

    it('nOAuth: xms_edov === true (BOOLEAN ONLY) makes a divergent email trustworthy', async () => {
      const v = await verdictFor({
        email: 'alias@test.example',
        preferred_username: 'alice.upn@test.example',
        xms_edov: true,
      });
      expect(v).toMatchObject({ ok: true, claims: { email: 'alias@test.example' } });

      // Anything that is not the boolean `true` must NOT unlock the divergent email. The string
      // forms matter most: genuine Entra emits a boolean, so a string is the shape a
      // claims-mapping-POLICY-injected value takes — accepting it would widen the one predicate
      // that lets a divergent email become identity. Falling back to the UPN is the safe direction.
      for (const edov of [
        false,
        'true',
        '1',
        'false',
        '0',
        1,
        0,
        'True',
        'TRUE',
        undefined,
        null,
      ]) {
        const rejected = await verdictFor({
          email: 'alias@test.example',
          preferred_username: 'alice.upn@test.example',
          xms_edov: edov,
        });
        expect(rejected, `xms_edov=${JSON.stringify(edov)}`).toMatchObject({
          ok: true,
          claims: { email: 'alice.upn@test.example' },
        });
      }
    });

    it('nOAuth: email === UPN is trusted with no xms_edov (the common member path)', async () => {
      const v = await verdictFor({
        email: 'Alice@Test.Example',
        preferred_username: 'alice@test.example',
        xms_edov: undefined,
      });
      expect(v).toMatchObject({ ok: true, claims: { email: 'alice@test.example' } });
    });

    it('a present-but-malformed email falls back to the UPN instead of locking the user out', async () => {
      // Previously the shape gate ran AFTER selection, so a junk email vetoed a good UPN.
      for (const junk of ['not-an-email', 'a@b@c.example', '@test.example', 'a@', '   ', 42]) {
        const v = await verdictFor({ email: junk, preferred_username: 'alice@test.example' });
        expect(v, `email=${JSON.stringify(junk)}`).toMatchObject({
          ok: true,
          claims: { email: 'alice@test.example' },
        });
      }
    });

    it('rejects whitespace/control characters inside a claim (audit-log hygiene)', async () => {
      // trim() only strips the ENDS: an internal CR/LF used to survive into audit_log.
      const crlf = `alice${String.fromCharCode(13, 10)}x@test.example`;
      const withUpn = await verdictFor({ email: crlf, preferred_username: 'alice@test.example' });
      expect(withUpn).toMatchObject({ ok: true, claims: { email: 'alice@test.example' } });
      // Even xms_edov must not launder a malformed value.
      const edovJunk = await verdictFor({
        email: crlf,
        preferred_username: crlf,
        xms_edov: true,
      });
      expect(edovJunk).toEqual({ ok: false, reason: 'no_usable_email_claim' });
    });

    it('refuses when only a divergent unverified email exists (no usable UPN)', async () => {
      const v = await verdictFor({ email: USERS.owner, preferred_username: undefined });
      expect(v).toEqual({ ok: false, reason: 'no_usable_email_claim' });
    });

    it('warns (without leaking an address) when a divergent email is ignored — the only xms_edov signal', async () => {
      // The refusal that follows is byte-uniform and indistinguishable from a genuinely uninvited
      // user, so this warning is the ONLY way to diagnose "xms_edov was never added". It must fire
      // on divergence — and must never carry an address (anti-enumeration invariant).
      const warns: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
      try {
        await verdictFor({ email: USERS.owner, preferred_username: 'attacker@partner.example' });
      } finally {
        console.warn = original;
      }
      const line = warns.find((w) => w.includes('oidc_email_claim_untrusted'));
      expect(line, 'expected an oidc_email_claim_untrusted warning').toBeDefined();
      expect(line).toContain(TENANT_A); // tid is useful and not sensitive
      expect(line).not.toContain(USERS.owner); // never the victim's address
      expect(line).not.toContain('attacker@partner.example'); // nor the caller's

      // It must NOT fire on the clean common path (email == UPN) — that would be pure noise.
      const quiet: string[] = [];
      console.warn = (...args: unknown[]) => quiet.push(args.map(String).join(' '));
      try {
        await verdictFor({ email: USERS.member, preferred_username: USERS.member });
      } finally {
        console.warn = original;
      }
      expect(quiet.find((w) => w.includes('oidc_email_claim_untrusted'))).toBeUndefined();
    });

    it('B2B guests resolve to their #EXT# UPN, not their external email (deliberate)', async () => {
      // A real guest UPN has ONE '@' and so passes the shape gate — guests are handled by the
      // identity binding, not by emailShaped. Their external email is at a domain the tenant does
      // not own, so xms_edov is false and email !== UPN: the UPN wins. Documented consequence, and
      // the reason it must stay this way: a tenant admin can repoint that external address at will.
      const v = await verdictFor({
        email: 'contractor@gmail.example',
        preferred_username: 'contractor_gmail.example#EXT#@partner.onmicrosoft.example',
      });
      expect(v).toMatchObject({
        ok: true,
        claims: { email: 'contractor_gmail.example#ext#@partner.onmicrosoft.example' },
      });
      // The guest is admitted ONLY if invited under that UPN — never under the unverified email.
      expect(v).not.toMatchObject({ claims: { email: 'contractor@gmail.example' } });
    });

    it('rejects structural garbage without throwing', async () => {
      const f = fakeMicrosoft({ calls: [] });
      expect(await verifyIdToken('', cfg, NONCE, f)).toEqual({
        ok: false,
        reason: 'malformed_jwt',
      });
      expect(await verifyIdToken('a.b', cfg, NONCE, f)).toEqual({
        ok: false,
        reason: 'malformed_jwt',
      });
      expect(await verifyIdToken('!!.@@.##', cfg, NONCE, f)).toEqual({
        ok: false,
        reason: 'malformed_jwt',
      });
      expect(await verifyIdToken(`${b64urlJson('x')}.${b64urlJson(1)}.AA`, cfg, NONCE, f)).toEqual({
        ok: false,
        reason: 'malformed_jwt',
      });
    });
  });

  // ---- the callback: end-to-end mint + every refusal is byte-identical ------

  describe('callback', () => {
    it('mints the SAME session a magic link would: cookie, audit, role from users', async () => {
      const { res, calls } = await fullFlow();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/notes?x=1'); // return_to survived, sanitized

      // Token exchange carried the confidential-client credentials + PKCE verifier.
      const tokenCall = calls.find((c) => c.url.includes('/oauth2/v2.0/token'));
      expect(tokenCall).toBeTruthy();
      const body = new URLSearchParams(tokenCall?.body ?? '');
      expect(body.get('client_id')).toBe(CLIENT_ID);
      expect(body.get('client_secret')).toBe('test-entra-client-secret');
      expect(body.get('code_verifier')).toMatch(/^[a-f0-9]{64}$/);
      expect(body.get('redirect_uri')).toBe(`${BASE}/auth/oidc/callback`);

      // Session exists in KV, tagged entra_oidc (audit/policy only — never authorization).
      // KV keys are sha256(sid) — the raw sid lives only in the cookie (AICOE-346).
      const sid = sessionSid(res);
      expect(sid).toBeTruthy();
      const raw = await env.SESSIONS.get(`session:${await sha256Hex(sid ?? '')}`);
      expect(JSON.parse(raw ?? '{}')).toMatchObject({
        email: USERS.member,
        auth_method: 'entra_oidc',
      });

      // The txn cookie is burned on success.
      const cleared = setCookies(res).find((c) => c.startsWith(`${OIDC_TXN_COOKIE}=`));
      expect(cleared).toContain('Max-Age=0');

      // Authorization comes out identical to a magic-link session: /api/me sees the
      // same role the users table holds.
      const me = await SELF.fetch(`${BASE}/api/me`, {
        headers: { cookie: `${SESSION_COOKIE}=${sid}`, origin: BASE },
      });
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as { data: { email: string; role: string } };
      expect(meBody.data).toMatchObject({ email: USERS.member, role: 'member' });

      // Login is audited with the method and tenant.
      const audit = await env.DB.prepare(
        "SELECT payload_json FROM audit_log WHERE action = 'login' AND actor_email = ?",
      )
        .bind(USERS.member)
        .first<{ payload_json: string }>();
      expect(JSON.parse(audit?.payload_json ?? '{}')).toEqual({
        method: 'entra_oidc',
        tid: TENANT_A,
      });
    });

    // The writer half of the entra-only guard's contract: the `login` row THIS callback writes
    // is the proof auditRepo.hasSuccessfulLogin reads. Driven through the real callback, so a
    // change to the payload written here cannot silently make the guard refuse forever, nor let
    // a refused round trip count as proof. No settings-route call on purpose: this file travels
    // to every fork with /kit-upgrade, while src/routes/settings.ts is the fork's own (the route
    // half lives in test/routes/settings.test.ts).
    it('a COMPLETED callback writes the proof the entra-only guard reads; a refused one does not', async () => {
      const db = makeDb(env);

      // Expired shared secret: config looks complete, Microsoft refuses the token exchange.
      const failed = await fullFlow(
        {},
        { tokenStatus: 401, tokenBody: { error: 'invalid_client' } },
      );
      expect(failed.res.status).toBe(400);
      expect(await db.audit.hasSuccessfulLogin('entra_oidc')).toBe(false);
      expect(await db.audit.hasSuccessfulLogin('entra_oidc', TENANT_A)).toBe(false);

      // A completed TENANT_A sign-in proves TENANT_A, in the exact (lowercased) form the
      // allowlist holds — and nothing about TENANT_B, whose admin consent is its own.
      const completed = await fullFlow();
      expect(completed.res.status).toBe(302);
      expect(await db.audit.hasSuccessfulLogin('entra_oidc')).toBe(true);
      expect(await db.audit.hasSuccessfulLogin('entra_oidc', TENANT_A)).toBe(true);
      expect(await db.audit.hasSuccessfulLogin('entra_oidc', TENANT_B)).toBe(false);
    });

    it('nOAuth END-TO-END: an allowlisted-tenant attacker cannot become the owner', async () => {
      // The full attack, through the real callback: a legitimately-signed token from an
      // ALLOWLISTED tenant whose mutable `email` claim names the owner, while the attacker's
      // own domain-bound UPN is their real (uninvited) address. Every crypto/tenant check
      // passes — only the identity binding stands between this and total takeover.
      const { res } = await fullFlow({
        email: USERS.owner,
        preferred_username: 'attacker@partner.example',
      });

      // 1. No session cookie is minted at all.
      const sids = setCookies(res).filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
      const minted = sids.filter((c) => !/=;|=(?=;)|Max-Age=0/.test(c));
      expect(minted).toEqual([]);

      // 2. The owner has NO login audit row — the attack must not even look like the owner.
      const ownerLogin = await env.DB.prepare(
        "SELECT id FROM audit_log WHERE action = 'login' AND actor_email = ?",
      )
        .bind(USERS.owner)
        .first();
      expect(ownerLogin).toBeNull();

      // 3. Nor does the attacker get in as THEMSELVES. (Which gate stops them depends on the
      // app's ALLOWED_EMAIL_DOMAINS: under the test env's policy their own domain is refused
      // first, so this never reaches the invite check — either way, no session, no login row.)
      const anyLogin = await env.DB.prepare(
        "SELECT id FROM audit_log WHERE action = 'login' AND actor_email = ?",
      )
        .bind('attacker@partner.example')
        .first();
      expect(anyLogin).toBeNull();
    });

    it('refuses everything hostile with ONE byte-identical page (anti-enumeration)', async () => {
      const bodies = new Set<string>();
      const statuses = new Set<number>();

      // (1) Foreign-tenant token (validly signed).
      const foreign = await fullFlow({
        tid: FOREIGN_TENANT,
        iss: `https://login.microsoftonline.com/${FOREIGN_TENANT}/v2.0`,
      });
      // (2) Valid token for an address that was never invited.
      const uninvited = await fullFlow({
        email: 'stranger@test.example',
        preferred_username: 'stranger@test.example',
      });
      // (3) Valid token for an invited-but-disabled user.
      await env.DB.prepare("UPDATE users SET disabled_at = datetime('now') WHERE email = ?")
        .bind(USERS.viewer)
        .run();
      const disabled = await fullFlow({
        email: USERS.viewer,
        preferred_username: USERS.viewer,
      });
      // (4) Valid token whose domain the app's policy refuses (invited, wrong domain).
      await env.DB.prepare("INSERT INTO users (email, role, added_by) VALUES (?, 'member', ?)")
        .bind('bob@blocked.example', USERS.owner)
        .run();
      const blockedDomain = await fullFlow({
        email: 'bob@blocked.example',
        preferred_username: 'bob@blocked.example',
      });
      // (5) State mismatch (login-CSRF: attacker's code+state in a victim browser).
      const { cookie } = await begin();
      const other = await begin();
      const idToken = await signIdToken(other.nonce);
      setOidcFetcherForTests(fakeMicrosoft({ idToken, calls: [] }));
      const csrf = await callback(cookie, { code: 'authcode-x', state: other.state });
      // (6) No transaction cookie at all.
      const bare = await callback(null, { code: 'authcode-y', state: 'f'.repeat(32) });
      // (7) Token endpoint refuses the code (replay: Microsoft codes are single-use).
      const replayed = await fullFlow({}, { tokenStatus: 400 });
      // (8) User cancelled at Microsoft.
      const { cookie: c8, state: s8 } = await begin();
      const cancelled = await callback(c8, { error: 'access_denied', state: s8 });

      for (const r of [
        foreign.res,
        uninvited.res,
        disabled.res,
        blockedDomain.res,
        csrf,
        bare,
        replayed.res,
        cancelled,
      ]) {
        statuses.add(r.status);
        bodies.add(await r.text());
        expect(sessionSid(r)).toBeNull();
      }
      expect(statuses).toEqual(new Set([400]));
      expect(bodies.size).toBe(1); // byte-identical, every reason
    });

    it('a reserved (service) address never signs in — not even invited, under an open domain policy', async () => {
      // A users row (only a hand insert can make one) and no domain policy: the two gates that
      // would otherwise admit it. The namespace rule refuses first, with the ordinary page.
      await env.DB.prepare("INSERT INTO users (email, role, added_by) VALUES (?, 'owner', ?)")
        .bind('svc-etl@test-app.invalid', USERS.owner)
        .run();
      const warns: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
      let res: Response;
      try {
        ({ res } = await fullFlow(
          {
            email: 'svc-etl@test-app.invalid',
            preferred_username: 'svc-etl@test-app.invalid',
            xms_edov: true,
          },
          {},
          { ...env, ALLOWED_EMAIL_DOMAINS: '' },
        ));
      } finally {
        console.warn = original;
      }
      expect(res.status).toBe(400);
      expect(sessionSid(res)).toBeNull();
      expect(warns.map((w) => JSON.parse(w) as Record<string, unknown>)).toContainEqual({
        event: 'entra_login_refused',
        reason: 'service_identity',
        tid: TENANT_A,
      });
      expect(warns.join('\n')).not.toContain('svc-etl@');
      const logins = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login'",
      ).first<{ n: number }>();
      expect(logins?.n).toBe(0);
    });

    it('fails closed when the client secret is missing, without calling Microsoft', async () => {
      const calls: Upstream['calls'] = [];
      const { state, nonce, cookie } = await begin();
      const idToken = await signIdToken(nonce);
      setOidcFetcherForTests(fakeMicrosoft({ idToken, calls }));
      const res = await callback(
        cookie,
        { code: 'authcode-1', state },
        { ...env, ENTRA_CLIENT_SECRET: undefined },
      );
      expect(res.status).toBe(400);
      expect(calls).toEqual([]); // refused before any upstream call
    });

    it('404s when SSO is disabled (no oracle for the callback surface either)', async () => {
      const res = await callback(
        null,
        { code: 'x', state: 'y' },
        { ...env, ENTRA_CLIENT_ID: '', ENTRA_ALLOWED_TENANTS: '' },
      );
      expect(res.status).toBe(404);
    });

    it('never lands on a foreign origin: hostile return_to collapses to /', async () => {
      for (const evil of [
        'https://evil.example',
        '//evil.example',
        '/\\evil.example',
        '/..//evil.example',
      ]) {
        const { res } = await (async () => {
          const { state, nonce, cookie } = await begin(evil);
          const idToken = await signIdToken(nonce);
          setOidcFetcherForTests(fakeMicrosoft({ idToken, calls: [] }));
          return { res: await callback(cookie, { code: 'authcode-1', state }) };
        })();
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/');
      }
    });

    it('a tampered transaction cookie reads as absent (strict decode)', async () => {
      const { state, nonce } = await begin();
      const idToken = await signIdToken(nonce);
      setOidcFetcherForTests(fakeMicrosoft({ idToken, calls: [] }));
      const forged = btoa(
        JSON.stringify({ state, nonce: 'zz', verifier: 'nope', rt: '/x', iat: 1 }),
      );
      const res = await callback(`${OIDC_TXN_COOKIE}=${forged}`, { code: 'authcode-1', state });
      expect(res.status).toBe(400);
      expect(sessionSid(res)).toBeNull();
    });
  });

  // ---- public config -----------------------------------------------------

  it('/auth/config advertises the full login surface without leaking the client id', async () => {
    const res = await SELF.fetch(`${BASE}/auth/config`);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      turnstile_site_key: '',
      entra_enabled: true,
      entra_only: false,
      entra_domains: ['sso.example'],
    });
  });

  // ---- enablement honesty (never advertise a dead path) --------------------

  describe('secret-inclusive enablement gate', () => {
    it('login initiation 404s when only the secret is missing — never bounce through Microsoft into a dead end', async () => {
      for (const secret of [undefined, ''] as const) {
        const res = await beginOidcLogin(
          { ...env, ENTRA_CLIENT_SECRET: secret },
          new Request(`${BASE}/auth/oidc/login`),
        );
        expect(res.status).toBe(404);
      }
    });

    it('a Secrets Store read failure reads as disabled/refused, never a thrown 500 (uniformity oracle)', async () => {
      const throwing: Env = {
        ...env,
        ENTRA_CLIENT_SECRET: { get: () => Promise.reject(new Error('secret not found')) },
      };
      // Initiation: gate treats it as not-enabled.
      const begun = await beginOidcLogin(throwing, new Request(`${BASE}/auth/oidc/login`));
      expect(begun.status).toBe(404);
      // Callback: uniform 400 refusal, and Microsoft is never called.
      const { state, nonce, cookie } = await begin();
      const idToken = await signIdToken(nonce);
      const u: Upstream = { idToken, calls: [] };
      setOidcFetcherForTests(fakeMicrosoft(u));
      const res = await callback(cookie, { code: 'authcode-1', state }, throwing);
      expect(res.status).toBe(400);
      expect(u.calls).toEqual([]);
    });
  });

  // ---- steering inputs ------------------------------------------------------

  describe('login_hint + return_to hygiene', () => {
    it('forwards a well-shaped login_hint to Microsoft and drops junk', async () => {
      const good = await beginOidcLogin(
        env,
        new Request(
          `${BASE}/auth/oidc/login?login_hint=${encodeURIComponent('Alice@Test.Example')}`,
        ),
      );
      const goodLoc = new URL(good.headers.get('location') ?? '');
      expect(goodLoc.searchParams.get('login_hint')).toBe('alice@test.example');

      for (const junk of ['not-an-email', 'two@at@signs', `a@${'b'.repeat(400)}`, '<script>@x']) {
        const res = await beginOidcLogin(
          env,
          new Request(`${BASE}/auth/oidc/login?login_hint=${encodeURIComponent(junk)}`),
        );
        const loc = new URL(res.headers.get('location') ?? '');
        expect(loc.searchParams.get('login_hint')).toBeNull();
      }
    });

    it('caps return_to so the txn cookie can never outgrow what browsers accept', async () => {
      const huge = `/deep${'/x'.repeat(600)}?q=1`;
      const { state, nonce, cookie } = await begin(huge);
      expect(cookie.length).toBeLessThan(1024); // far under the ~4KB Set-Cookie ceiling
      const idToken = await signIdToken(nonce);
      setOidcFetcherForTests(fakeMicrosoft({ idToken, calls: [] }));
      const res = await callback(cookie, { code: 'authcode-1', state });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/'); // degraded landing, not a broken login
    });
  });

  // ---- transaction-cookie burn semantics ------------------------------------

  describe('txn cookie burn', () => {
    it('a cross-site junk callback cannot destroy a victim’s in-flight transaction', async () => {
      const { cookie } = await begin();
      // Attacker-forced navigation: ?error with no (or wrong) state — the request never
      // proves it owns the transaction, so the cookie must survive.
      const forced = await callback(cookie, { error: 'access_denied' });
      expect(forced.status).toBe(400);
      expect(setCookies(forced).find((c) => c.startsWith(`${OIDC_TXN_COOKIE}=`))).toBeUndefined();

      const wrongState = await callback(cookie, { code: 'x', state: 'f'.repeat(32) });
      expect(
        setCookies(wrongState).find((c) => c.startsWith(`${OIDC_TXN_COOKIE}=`)),
      ).toBeUndefined();
    });

    it('a refusal on the flow that OWNS the transaction burns it (one-shot)', async () => {
      const { state, cookie } = await begin();
      const res = await callback(cookie, { error: 'access_denied', state });
      expect(res.status).toBe(400);
      const cleared = setCookies(res).find((c) => c.startsWith(`${OIDC_TXN_COOKIE}=`));
      expect(cleared).toContain('Max-Age=0');
    });
  });

  // ---- JWKS availability + revocation windows -------------------------------

  describe('JWKS fetch resilience', () => {
    const cfg = { clientId: CLIENT_ID, allowedTenants: [TENANT_A, TENANT_B] };
    const NONCE = 'c'.repeat(32);

    it('a failed JWKS fetch backs off briefly instead of walling logins off for a minute', async () => {
      const t0 = Date.now();
      const token = await signIdToken(NONCE);
      const failing: Fetcher = () => Promise.reject(new Error('upstream blip'));
      expect(await verifyIdToken(token, cfg, NONCE, failing, t0)).toEqual({
        ok: false,
        reason: 'unknown_signing_key',
      });
      // Still inside the failure cooldown: refused without a refetch.
      const counting: Upstream = { calls: [] };
      expect(await verifyIdToken(token, cfg, NONCE, fakeMicrosoft(counting), t0 + 1000)).toEqual({
        ok: false,
        reason: 'unknown_signing_key',
      });
      expect(counting.calls).toEqual([]);
      // Past the (short) failure cooldown the working endpoint recovers immediately.
      const after = await verifyIdToken(token, cfg, NONCE, fakeMicrosoft({ calls: [] }), t0 + 6000);
      expect(after.ok).toBe(true);
    });

    it('concurrent cold-start logins share one JWKS fetch (no cooldown refusal for the loser)', async () => {
      const t0 = Date.now();
      const token = await signIdToken(NONCE);
      let releaseJwks: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseJwks = resolve;
      });
      let fetches = 0;
      const slow: Fetcher = async (url, init) => {
        fetches++;
        await gate;
        return fakeMicrosoft({ calls: [] })(url, init);
      };
      const a = verifyIdToken(token, cfg, NONCE, slow, t0);
      const b = verifyIdToken(token, cfg, NONCE, slow, t0);
      releaseJwks();
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.ok).toBe(true);
      expect(rb.ok).toBe(true);
      expect(fetches).toBe(1);
    });

    it('a cached key is not trusted past its TTL — a revoked key falls out', async () => {
      const t0 = Date.now();
      const longLived = await signIdToken(NONCE, { exp: Math.floor(t0 / 1000) + 8 * 3600 });
      expect(
        (await verifyIdToken(longLived, cfg, NONCE, fakeMicrosoft({ calls: [] }), t0)).ok,
      ).toBe(true);
      // 6h+ later Microsoft no longer publishes the key (revoked): the stale cache entry
      // must NOT keep verifying — the refetch comes back without it → refusal.
      const revokedAt = t0 + 6 * 3600_000 + 61_000;
      const gone = await verifyIdToken(
        longLived,
        cfg,
        NONCE,
        fakeMicrosoft({ calls: [], jwksKeys: [] }),
        revokedAt,
      );
      expect(gone).toEqual({ ok: false, reason: 'unknown_signing_key' });
    });
  });

  // ---- entra-only login policy (magic links off) ----------------------------

  describe('entra-only policy on /auth/request', () => {
    const requestBody = (email: string) =>
      ({
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ email }),
      }) as const;
    const fakeCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    it('refuses magic links generically while SSO is healthy — same body, nothing sent', async () => {
      await makeDb(env).settings.setLogin({ entraOnly: true }, USERS.owner);
      const app = authRoutes();
      const res = await app.request(
        `${BASE}/auth/request`,
        requestBody(USERS.member),
        env,
        fakeCtx,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { message: string } }).data.message).toContain(
        'If that address is registered',
      );
      const row = await env.DB.prepare('SELECT token FROM magic_links WHERE email = ?')
        .bind(USERS.member)
        .first();
      expect(row).toBeNull(); // no link minted — the policy is real, the response generic
    });

    it('audits the refusal (domain only, sentinel actor) so the anomaly digest sees entra-only probe floods', async () => {
      await makeDb(env).settings.setLogin({ entraOnly: true }, USERS.owner);
      // A ctx that actually runs the deferred work, so the waitUntil'd audit write lands.
      const tasks: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => tasks.push(p),
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;
      const app = authRoutes();
      const res = await app.request(
        `${BASE}/auth/request`,
        requestBody('ghost@probe.example'),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      await Promise.all(tasks); // let the deferred, best-effort audit insert complete
      const row = await env.DB.prepare(
        "SELECT actor_email, payload_json FROM audit_log WHERE action = 'magic_link_refused' ORDER BY id DESC LIMIT 1",
      ).first<{ actor_email: string; payload_json: string }>();
      expect(row).not.toBeNull();
      // Sentinel actor + domain-only payload — the probed address/local-part is never persisted.
      expect(row?.actor_email).toBe('anonymous@refused');
      const payload = JSON.parse(row?.payload_json ?? '{}') as { reason: string; domain: string };
      expect(payload).toEqual({ reason: 'entra_only_login', domain: 'probe.example' });
      expect(JSON.stringify(row)).not.toContain('ghost');
    });

    it('is IGNORED while SSO is misconfigured — magic links keep working (availability over policy)', async () => {
      await makeDb(env).settings.setLogin({ entraOnly: true }, USERS.owner);
      const broken: Env = { ...env, ENTRA_CLIENT_SECRET: undefined };
      const app = authRoutes();
      const res = await app.request(
        `${BASE}/auth/request`,
        requestBody(USERS.member),
        broken,
        fakeCtx,
      );
      expect(res.status).toBe(200);
      const row = await env.DB.prepare('SELECT token FROM magic_links WHERE email = ?')
        .bind(USERS.member)
        .first();
      expect(row).toBeTruthy(); // fail-open: a config mistake never bricks every login
    });
  });
});
