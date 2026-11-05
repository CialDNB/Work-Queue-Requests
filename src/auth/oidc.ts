// Microsoft Entra SSO (OIDC authorization-code + PKCE), the kit's second login method.
//
// INVARIANTS (same as everywhere in src/auth/):
//   - Authorization NEVER branches on auth method: this module ends in the exact same
//     `createSession()` a magic link uses. Roles come from the `users` table, period.
//   - Invite-only holds PER APP: a cryptographically valid Entra token for an address
//     that is not active in THIS app's `users` is refused. There is no JIT
//     provisioning — access to the shared Entra registration via some other kit app
//     grants nothing here. Domain policy (isAllowedDomain) applies too.
//   - Fail closed: partial configuration disables the whole path, loudly — including
//     the login button (entraFullyEnabled probes the secret so the UI never
//     advertises a path the callback would refuse).
//   - Anti-enumeration: every refusal renders the SAME interstitial (status, body) —
//     reasons go to structured logs only, and never include the email address.
//
// MULTI-TENANT is the load-bearing subtlety. The shared "CIAL Internal Apps"
// registration accepts sign-ins from ANY Entra tenant ("organizations" endpoint), so
// the server-side tenant allowlist below (`ENTRA_ALLOWED_TENANTS`, matched against the
// ID token's `tid` claim and its issuer) is what confines logins to the CIAL D&B /
// D&B Israel / Trusted Partners directories. Without it, any Azure tenant in the
// world could mint tokens with arbitrary email claims. Never validate the issuer as a
// mere prefix and never accept a tid outside the allowlist.
//
// The allowlist is NOT sufficient on its own, and it is a mistake to reason as if it
// were: it confines WHICH directories may authenticate, never WHICH addresses a
// directory may assert. Impersonation from INSIDE the allowlist (nOAuth) is closed
// separately, by the identity binding in verifyIdToken — read that comment before
// touching claim selection.
//
// The pre-redirect state (CSRF `state`, replay `nonce`, PKCE verifier, return path)
// travels in a short-lived __Host- cookie rather than KV/D1: it is browser-bound (an
// attacker cannot complete a flow in a victim's browser — the cookie won't match),
// stateless, and immune to KV eventual-consistency questions. Every field is either
// compared against a Microsoft-issued artifact or re-sanitized before use, so the
// cookie needs confidentiality (HttpOnly) but not a signature.
//
// ID-token validation is deliberately hand-rolled on WebCrypto (pinned RS256 against
// Microsoft's per-tenant JWKS) instead of pulling a JWT dependency into the protected
// auth core — see DECISIONS.md 2026-07-01. The checks are explicit and exhaustively
// tested in test/auth/oidc.test.ts; keep them boring.
import { makeDb } from '../data';
import { type Env, getSecret } from '../env';
import { logEvent } from '../platform/logEvent';
import { readCookie, serializeHostCookie, serializeSessionCookie } from './cookies';
import { appDisplayName, messagePage } from './interstitial';
import { isAllowedDomain, sanitizeReturnTo } from './magicLink';
import { isReservedIdentifier } from './serviceNamespace';
import { createSession, sessionTtlSec } from './sessions';
import { randomHex } from './tokens';

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Normalize one claim to a strictly email-SHAPED value, or '' if it isn't one. Applied per
 * claim before identity selection (see verifyIdToken), so a malformed value is simply not a
 * candidate rather than vetoing a good one.
 *
 * Stricter than "has an @": rejects internal whitespace and control characters (the old inline
 * gate only trim()med the ends, so `a\r\nb@x.example` slipped through and reached audit_log),
 * requires EXACTLY one '@' with a non-empty local part AND domain part (`a@evil.example@ok.example`
 * and `a@` are both out), and caps at 254.
 *
 * This is a SHAPE gate, not a trust gate — it says "could be an address", never "is yours". A real
 * B2B guest UPN (`contractor_gmail.com#EXT#@cialdnb.onmicrosoft.com`) has one '@' and PASSES here;
 * guests are handled by the identity binding + invite-only, not by this function. (Only the
 * doctored two-'@' variant in the test fixtures is shape-refused.)
 */
function emailShaped(value: unknown): string {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (s.length === 0 || s.length > 254) return '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point.
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return '';
  const at = s.indexOf('@');
  if (at < 1 || at === s.length - 1) return ''; // needs a local part AND a domain part
  if (s.indexOf('@', at + 1) !== -1) return ''; // exactly one '@'
  return s;
}

// Test seam. Unlike src/ai/anthropic.ts (whose tests call the function directly and
// pass a fetcher parameter), the OIDC flow is also exercised END-TO-END through
// SELF.fetch — the route handlers can't take a test parameter, so the seam is a
// module-level slot (vitest-pool-workers runs tests in the worker's own isolate, so a
// test can swap it and SELF-driven requests observe the swap). Direct-call tests may
// still inject per call via verifyIdToken's parameter. Reset in afterEach, always.
const defaultFetch: Fetcher = (url, init) => fetch(url, init);
let fetchImpl: Fetcher = defaultFetch;
export function setOidcFetcherForTests(f: Fetcher | null): void {
  fetchImpl = f ?? defaultFetch;
}

export const OIDC_TXN_COOKIE = '__Host-oidc_txn';
const TXN_TTL_SEC = 600; // one login attempt; MS interactive auth comfortably fits
const CLOCK_SKEW_SEC = 300;
const UPSTREAM_TIMEOUT_MS = 10_000;
// Keys are re-fetched when unknown, and a cached key is trusted at most this long —
// the window in which a key REMOVED from Microsoft's JWKS (revocation) still verifies.
const JWKS_KEY_TTL_MS = 6 * 3600_000;
// Refetch cooldowns: a fetch that FAILED backs off briefly (so one blip doesn't wall
// off logins for a minute), a fetch that succeeded but lacked the kid holds longer
// (kid-spam can't stampede Microsoft).
const JWKS_OK_COOLDOWN_MS = 60_000;
const JWKS_FAIL_COOLDOWN_MS = 5_000;
// return_to must fit comfortably inside the txn cookie (browsers drop Set-Cookie past
// ~4KB, which would fail every login AFTER the Microsoft hop — silently). Longer
// values fall back to '/', they don't break the flow.
const RETURN_TO_MAX_CHARS = 512;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// login_hint is forwarded to Microsoft to pre-fill the account picker. UX only —
// nothing downstream trusts it, but only plausibly-email-shaped values (conservative
// character set, post-lowercase) are worth forwarding; everything else is dropped.
const LOGIN_HINT_RE = /^[a-z0-9._%+'-]{1,190}@[a-z0-9.-]{1,63}$/;

const te = new TextEncoder();
const td = new TextDecoder();

export interface EntraConfig {
  clientId: string;
  /** Lowercased tenant GUIDs whose ID tokens are accepted. The security boundary. */
  allowedTenants: readonly string[];
}

/**
 * Resolves the Entra var-side configuration, or null when disabled. Fail closed and
 * LOUD on partial/malformed config: a typo'd tenant GUID disables SSO entirely rather
 * than silently narrowing (or worse, widening) the allowlist.
 */
export function entraConfig(env: Env): EntraConfig | null {
  const clientId = (env.ENTRA_CLIENT_ID ?? '').trim().toLowerCase();
  const rawTenants = (env.ENTRA_ALLOWED_TENANTS ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!clientId && rawTenants.length === 0) {
    // Plainly disabled — stay quiet, unless the SECRET half was configured (binding
    // present) while the vars were forgotten: that half-done state must be loud too.
    if (env.ENTRA_CLIENT_SECRET !== undefined) {
      // ENTRA_CLIENT_SECRET is bound but ENTRA_CLIENT_ID/ENTRA_ALLOWED_TENANTS are unset.
      logEvent('entra_misconfigured', { cause: 'secret_bound_without_ids' });
    }
    return null;
  }
  if (
    !GUID_RE.test(clientId) ||
    rawTenants.length === 0 ||
    rawTenants.some((t) => !GUID_RE.test(t))
  ) {
    // ENTRA_CLIENT_ID and ENTRA_ALLOWED_TENANTS must be GUIDs; SSO disabled (fail closed).
    logEvent('entra_misconfigured', { cause: 'ids_not_guids' });
    return null;
  }
  return { clientId, allowedTenants: rawTenants };
}

/** getSecret, but a Secrets Store read failure (secret deleted / never created) reads
 * as "missing" instead of throwing — a thrown 500 would be a distinguishable oracle
 * on the refusal surface, and login handlers must stay uniform. */
async function resolveEntraSecret(env: Env): Promise<string | null> {
  try {
    return (await getSecret(env.ENTRA_CLIENT_SECRET)) ?? null;
  } catch (err) {
    // ENTRA_CLIENT_SECRET binding exists but the secret could not be read.
    logEvent('entra_misconfigured', { cause: 'secret_unreadable', err });
    return null;
  }
}

/**
 * The REAL enablement gate: vars valid AND the client secret resolvable. The login
 * button, /auth/oidc/login, and the entra-only setting all key off this — never off
 * entraConfig() alone — so a half-configured app (vars set, secret binding forgotten)
 * hides the button instead of bouncing every user through Microsoft into a dead end.
 * The secret probe short-circuits when no binding exists, so apps with SSO off pay
 * nothing on their login-config fetch.
 */
export async function entraFullyEnabled(env: Env): Promise<EntraConfig | null> {
  const cfg = entraConfig(env);
  if (!cfg) return null;
  if ((await resolveEntraSecret(env)) === null) {
    // ENTRA_CLIENT_ID/ENTRA_ALLOWED_TENANTS set but ENTRA_CLIENT_SECRET is missing; SSO disabled
    // (fail closed).
    logEvent('entra_misconfigured', { cause: 'secret_missing' });
    return null;
  }
  return cfg;
}

/** Email domains steered to Microsoft sign-in by the login page (UX only — magic
 * links stay valid for them unless the app turns on entra-only login). */
export function entraEmailDomains(env: Env): string[] {
  return (env.ENTRA_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/** OAuth requires the authorize-request and token-exchange redirect_uri to match
 * byte-for-byte (and the runbook registers this exact literal in Entra) — ONE
 * definition site, used by both legs. */
function redirectUri(env: Env): string {
  return `https://${env.DASHBOARD_HOST}/auth/oidc/callback`;
}

// ---------------------------------------------------------------------------
// Encoding helpers (exported so the test suite forges tokens with the SAME codec
// the verifier decodes — two copies drifting would test the encoding, not the
// security property)
// ---------------------------------------------------------------------------

export function b64url(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...bytes) spreads the whole array onto the stack
  // and throws RangeError past ~100KB of input. Auth payloads are far smaller, but
  // an encoder in the auth core shouldn't have an input-size cliff at all.
  let bin = '';
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** bytes → JSON, accepting only a plain object (bare strings/numbers/arrays are
 * "malformed", identically at every parse site: JWT header, JWT claims, txn cookie). */
function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(td.decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Login transaction cookie
// ---------------------------------------------------------------------------

interface OidcTxn {
  state: string;
  nonce: string;
  verifier: string; // PKCE code_verifier (64 hex chars — within RFC 7636's 43..128)
  rt: string | null; // sanitized return path; re-sanitized again at use
  iat: number; // seconds; server-side TTL check (cookie Max-Age is client-enforced only)
}

function encodeTxn(txn: OidcTxn): string {
  return b64url(te.encode(JSON.stringify(txn)));
}

/** Strict decode: shape-checks every field so a tampered cookie reads as absent. */
export function decodeTxn(value: string | null, nowSec: number): OidcTxn | null {
  if (!value) return null;
  const bytes = b64urlDecode(value);
  if (!bytes) return null;
  const t = parseJsonObject(bytes);
  if (!t) return null;
  const HEX = /^[a-f0-9]{32,128}$/;
  if (typeof t.state !== 'string' || !HEX.test(t.state)) return null;
  if (typeof t.nonce !== 'string' || !HEX.test(t.nonce)) return null;
  if (typeof t.verifier !== 'string' || !HEX.test(t.verifier)) return null;
  if (t.rt !== null && typeof t.rt !== 'string') return null;
  if (typeof t.iat !== 'number' || !Number.isFinite(t.iat)) return null;
  if (nowSec - t.iat > TXN_TTL_SEC || t.iat - nowSec > CLOCK_SKEW_SEC) return null;
  return { state: t.state, nonce: t.nonce, verifier: t.verifier, rt: t.rt, iat: t.iat };
}

const txnCookie = (value: string, maxAge: number): string =>
  serializeHostCookie(OIDC_TXN_COOKIE, value, maxAge);

// ---------------------------------------------------------------------------
// /auth/oidc/login — mint the transaction and hand off to Microsoft
// ---------------------------------------------------------------------------

const notEnabledPage = (brand: string): Response =>
  messagePage(
    brand,
    'Microsoft sign-in unavailable',
    'Microsoft sign-in is not enabled for this app. Use the email link on the sign-in page instead.',
    404,
  );

export async function beginOidcLogin(
  env: Env,
  request: Request,
  nowMs: number = Date.now(),
): Promise<Response> {
  const brand = appDisplayName(env.APP_NAME, env.MAIL_FROM_NAME);
  // Gate on the FULL config (secret included): never bounce a user through an
  // interactive Microsoft login the callback is already guaranteed to refuse.
  const cfg = await entraFullyEnabled(env);
  if (!cfg) return notEnabledPage(brand);

  const url = new URL(request.url);
  // Cap what rides in the cookie: an oversized Set-Cookie is silently dropped by the
  // browser and the flow would fail AFTER the Microsoft hop, deterministically. A long
  // deep-link degrades to landing on '/', never to a broken login.
  const rtRaw = sanitizeReturnTo(url.searchParams.get('return_to') ?? undefined);
  const txn: OidcTxn = {
    state: randomHex(32),
    nonce: randomHex(32),
    verifier: randomHex(64),
    rt: rtRaw && rtRaw.length <= RETURN_TO_MAX_CHARS ? rtRaw : null,
    iat: Math.floor(nowMs / 1000),
  };
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(txn.verifier))),
  );

  // `organizations` = any work/school account may AUTHENTICATE; the tid allowlist on
  // the callback decides who may ENTER. Personal Microsoft accounts are excluded.
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri(env),
    scope: 'openid profile email',
    state: txn.state,
    nonce: txn.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  // Smart steering: the login page forwards the address the user already typed so
  // Microsoft pre-fills the picker. Shape-gated; junk is dropped, never rejected.
  const hint = (url.searchParams.get('login_hint') ?? '').trim().toLowerCase();
  if (LOGIN_HINT_RE.test(hint)) params.set('login_hint', hint);

  const authorize = new URL(
    'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
  );
  authorize.search = params.toString();

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      'Set-Cookie': txnCookie(encodeTxn(txn), TXN_TTL_SEC),
      'Cache-Control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// ID-token validation
// ---------------------------------------------------------------------------

interface IdTokenClaims {
  email: string; // lowercased, shape-checked
  tid: string;
  name: string | null;
}

type VerifyResult = { ok: true; claims: IdTokenClaims } | { ok: false; reason: string };

// Per-isolate JWKS cache: `${tid}:${kid}` → imported verify key + import time (TTL'd:
// a revoked key must fall out even in a long-lived isolate). Bounded because keys are
// only ever fetched for ALLOWLISTED tenants (a handful), each serving ~6 keys.
const jwksKeys = new Map<string, { key: CryptoKey; importedAtMs: number }>();
// Per-tenant fetch bookkeeping: outcome-aware cooldown + in-flight dedup (two cold
// logins racing must share one fetch, not refuse the second).
const jwksLastAttempt = new Map<string, { atMs: number; ok: boolean }>();
const jwksInflight = new Map<string, Promise<void>>();
export function resetOidcJwksForTests(): void {
  jwksKeys.clear();
  jwksLastAttempt.clear();
  jwksInflight.clear();
}

function cachedKey(tid: string, kid: string, nowMs: number): CryptoKey | null {
  const entry = jwksKeys.get(`${tid}:${kid}`);
  if (!entry) return null;
  if (nowMs - entry.importedAtMs > JWKS_KEY_TTL_MS) {
    jwksKeys.delete(`${tid}:${kid}`);
    return null;
  }
  return entry.key;
}

async function fetchJwks(tid: string, fetcher: Fetcher, nowMs: number): Promise<void> {
  // Per-tenant JWKS URL, using the ALREADY-ALLOWLISTED tid — never a value the token
  // alone controls. (Entra signing keys are global, but fetching per validated tenant
  // keeps the issuer→key binding explicit.)
  let ok = false;
  try {
    const res = await fetcher(`https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`, {
      method: 'GET',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      logEvent('entra_jwks_error', { tid, status: res.status });
    } else {
      const body = (await res.json()) as {
        keys?: Array<{ kty?: string; use?: string; kid?: string; n?: string; e?: string }>;
      };
      for (const k of body.keys ?? []) {
        if (k.kty !== 'RSA' || !k.kid || !k.n || !k.e) continue;
        if (k.use && k.use !== 'sig') continue;
        try {
          const key = await crypto.subtle.importKey(
            'jwk',
            { kty: 'RSA', n: k.n, e: k.e },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
          );
          // Re-importing a known kid on a fresh fetch is deliberate: Microsoft just
          // (re)published it, so its TTL clock should restart.
          jwksKeys.set(`${tid}:${k.kid}`, { key, importedAtMs: nowMs });
        } catch {
          // Skip a malformed key; the kid lookup decides success.
        }
      }
      ok = true;
    }
  } catch (err) {
    logEvent('entra_jwks_unreachable', { tid, err });
  }
  jwksLastAttempt.set(tid, { atMs: nowMs, ok });
}

async function signingKey(
  tid: string,
  kid: string,
  fetcher: Fetcher,
  nowMs: number,
): Promise<CryptoKey | null> {
  const hit = cachedKey(tid, kid, nowMs);
  if (hit) return hit;

  // Someone is already fetching this tenant's keys — share their result instead of
  // burning a cooldown refusal (the cold-start thundering-herd case).
  const inflight = jwksInflight.get(tid);
  if (inflight) {
    await inflight;
    return cachedKey(tid, kid, nowMs);
  }

  const last = jwksLastAttempt.get(tid);
  if (last && nowMs - last.atMs < (last.ok ? JWKS_OK_COOLDOWN_MS : JWKS_FAIL_COOLDOWN_MS)) {
    return null; // cooldown: kid-spam can't stampede; a failed fetch retries in seconds
  }

  const p = fetchJwks(tid, fetcher, nowMs);
  jwksInflight.set(tid, p);
  try {
    await p;
  } finally {
    jwksInflight.delete(tid);
  }
  return cachedKey(tid, kid, nowMs);
}

/**
 * Full ID-token validation: structure → alg pinned to RS256 → aud → tid GUID +
 * allowlist → issuer exact-match (with that tid) → time window → nonce → signature
 * (fetched per validated tenant). Cheap, network-free checks run first; the order is
 * also why `tid` may be used in the JWKS URL. Exported for direct adversarial tests.
 */
export async function verifyIdToken(
  idToken: string,
  cfg: EntraConfig,
  expectedNonce: string,
  fetcher: Fetcher = fetchImpl,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  const parts = idToken.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed_jwt' };
  const [h, p, s] = parts as [string, string, string];

  const headerBytes = b64urlDecode(h);
  const payloadBytes = b64urlDecode(p);
  const sigBytes = b64urlDecode(s);
  if (!headerBytes || !payloadBytes || !sigBytes) return { ok: false, reason: 'malformed_jwt' };

  const header = parseJsonObject(headerBytes);
  const claims = parseJsonObject(payloadBytes);
  if (!header || !claims) return { ok: false, reason: 'malformed_jwt' };

  // Pinned algorithm. `alg: none` / HS256 / anything else is an instant reject — the
  // header never chooses how we verify.
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    return { ok: false, reason: 'bad_alg_or_kid' };
  }

  if (claims.aud !== cfg.clientId) return { ok: false, reason: 'aud_mismatch' };

  const tid = typeof claims.tid === 'string' ? claims.tid.toLowerCase() : '';
  if (!GUID_RE.test(tid)) return { ok: false, reason: 'bad_tid' };
  if (!cfg.allowedTenants.includes(tid)) return { ok: false, reason: 'tenant_not_allowed' };

  // Exact issuer for v2.0 tokens from THIS tenant — never a prefix/substring check.
  if (claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) {
    return { ok: false, reason: 'iss_mismatch' };
  }
  if (claims.ver !== '2.0') return { ok: false, reason: 'bad_ver' };

  const nowSec = Math.floor(nowMs / 1000);
  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  const nbf = typeof claims.nbf === 'number' ? claims.nbf : 0;
  if (exp < nowSec - CLOCK_SKEW_SEC) return { ok: false, reason: 'expired' };
  if (nbf > nowSec + CLOCK_SKEW_SEC) return { ok: false, reason: 'not_yet_valid' };

  if (typeof claims.nonce !== 'string' || claims.nonce !== expectedNonce) {
    return { ok: false, reason: 'nonce_mismatch' };
  }

  const key = await signingKey(tid, header.kid, fetcher, nowMs);
  if (!key) return { ok: false, reason: 'unknown_signing_key' };
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    sigBytes,
    te.encode(`${h}.${p}`),
  );
  if (!valid) return { ok: false, reason: 'bad_signature' };

  // IDENTITY BINDING — the nOAuth defense. Read this before touching the selection order.
  //
  // `email` in an Entra ID token is MUTABLE DIRECTORY DATA, not proof of address ownership:
  // a tenant admin (and, where self-service is on, a regular user) can set it to ANY string,
  // including another organization's address. Entra does not check that the domain belongs
  // to the issuing tenant unless you ask for `xms_edov`. So `email` must never be trusted as
  // identity on its own — that is the nOAuth attack (Descope, 2023).
  //
  // The tenant allowlist does NOT cover this, and neither do the gates below. The allowlist
  // confines WHICH directories may authenticate, not WHICH addresses a directory may assert;
  // invite-only is useless here because the impersonated address is invited (that's the
  // point); and ALLOWED_EMAIL_DOMAINS passes the spoof through because the spoofed address is
  // AT an allowed domain. A member of any allowlisted tenant could otherwise sign in as the
  // owner by putting the owner's address in their own profile — cross-tenant takeover that
  // exceeds even the "tenant admins are trusted parties" model a partner directory implies.
  //
  // So: trust `email` ONLY with proof the issuing tenant may assert it. Two independent
  // proofs, either sufficient:
  //   (a) xms_edov: true — Entra's "email domain owner verified" claim (an optional claim on
  //       the registration; see docs/runbooks/entra-sso-setup.md).
  //   (b) email === preferred_username.
  //
  // Be precise about WHY (b) is safe, because the obvious justification is wrong.
  // `preferred_username` is NOT always a UPN — with "email as an alternate login ID" it is a
  // ProxyAddress, and for a B2B guest it is the HOME tenant's UPN — and Microsoft documents it as
  // mutable and explicitly says it "can't be used to make authorization decisions." So (b) does
  // NOT rest on "a UPN is domain-verified." It rests on two other things:
  //   1. Entra only synchronizes emails in domains VERIFIED for the tenant, so a value appearing
  //      here is domain-bound in practice; and, more importantly,
  //   2. (b) is structurally incapable of granting anything: when it fires, email === upn, so it
  //      returns byte-identically what the `else if (upn)` fallback below would have returned. It
  //      is a fast path, not a privilege. All of (b)'s security therefore reduces to the fallback's.
  // Which is why (a) — a claim only Entra itself can emit — is the ONLY thing that ever lets a
  // value DIVERGENT from the fallback become identity.
  //
  // Otherwise fall back to `preferred_username`. With neither, refuse: an unverified, divergent
  // email is exactly the attack, and refusing is the safe failure (the user is never admitted AS
  // SOMEONE ELSE).
  //
  // Shape is validated PER CLAIM, before selection, for two reasons: a present-but-malformed
  // `email` must not veto a perfectly good UPN (that was a lockout, not a defense), and the
  // old gate accepted internal whitespace/CR/LF that then flowed into audit_log.
  //
  // KNOWN CONSEQUENCE — B2B guests (#EXT# accounts). A guest's `email` is at a domain the
  // inviting tenant does NOT own (contractor@gmail.com), so xms_edov is false and email != UPN:
  // identity becomes their `..._gmail.com#EXT#@tenant.onmicrosoft.com` UPN, and they are refused
  // unless invited under THAT address. This is deliberate, not an oversight: an external address
  // the tenant cannot vouch for is precisely what must not be trusted (a tenant admin can point
  // it anywhere — the attack). xms_edov does NOT lift this and never will. To admit a guest,
  // invite their UPN, or let them use a magic link (which proves mailbox possession — real
  // verification). See DECISIONS 2026-07-15.
  const emailClaim = emailShaped(claims.email);
  const upn = emailShaped(claims.preferred_username);
  // BOOLEAN ONLY, deliberately. Genuine Entra emits xms_edov as a JSON boolean; string forms
  // ('true'/'1') are the shape a claims-mapping-POLICY-injected value takes, and this predicate is
  // the single thing deciding whether attacker-controlled `email` becomes identity — so it is kept
  // as narrow as the real emitter. (Injection is already blocked independently: `xms_*` is in
  // Entra's restricted claim set, so a tenant admin's policy cannot emit it, and unlocking
  // restricted claims needs a custom signing key whose kid our global JWKS fetch would not match.
  // This is belt-and-braces on top of that.) A non-boolean therefore reads as false → fall back to
  // the UPN → at worst a refusal, never a bypass. If a real tenant is ever observed emitting a
  // string, widen it deliberately, after seeing the token.
  const edov = claims.xms_edov === true;

  let email: string;
  if (emailClaim && (edov || emailClaim === upn)) {
    email = emailClaim; // domain-verified by the tenant, or it IS the domain-bound UPN
  } else if (upn) {
    // An unverified `email` never overrides the UPN. Log the DIVERGENCE (never the addresses —
    // anti-enumeration): absent this line the resulting "user not found" is byte-identical to a
    // genuinely uninvited user, which makes a missing xms_edov claim undiagnosable in production.
    if (emailClaim && emailClaim !== upn) {
      // email != preferred_username and xms_edov absent/false; identity fell back to UPN.
      logEvent('oidc_email_claim_untrusted', { tid });
    }
    email = upn;
  } else {
    return { ok: false, reason: 'no_usable_email_claim' };
  }

  return {
    ok: true,
    claims: { email, tid, name: typeof claims.name === 'string' ? claims.name : null },
  };
}

// ---------------------------------------------------------------------------
// /auth/oidc/callback — validate everything, then mint the SAME session as magic links
// ---------------------------------------------------------------------------

export async function completeOidcLogin(
  env: Env,
  request: Request,
  ip: string,
  nowMs: number = Date.now(),
): Promise<Response> {
  const brand = appDisplayName(env.APP_NAME, env.MAIL_FROM_NAME);
  const cfg = entraConfig(env);
  if (!cfg) return notEnabledPage(brand);

  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  const txn = decodeTxn(
    readCookie(request.headers.get('cookie'), OIDC_TXN_COOKIE),
    Math.floor(nowMs / 1000),
  );
  // Burn the transaction cookie ONLY when this request proved it owns it (state
  // matches). A cross-site GET to the callback with junk params (SameSite=Lax sends
  // the cookie on top-level navigations) must NOT be able to destroy a victim's
  // in-flight login — their real callback still deserves its transaction.
  const ownsTxn = txn !== null && state !== '' && state === txn.state;

  /** Uniform refusal: byte-identical page for every failure mode; reason logged only
   * (mirrors magic_link_refused: reason + tenant only, NEVER the email address). */
  const refuse = (
    reason: string,
    extra: { code?: string; status?: number; tid?: string; domain?: string } = {},
  ): Response => {
    logEvent('entra_login_refused', { reason, ...extra });
    const res = messagePage(
      brand,
      'Sign-in didn’t complete',
      'Microsoft sign-in couldn’t be completed — the attempt may have expired, been cancelled, or this account may not have access. Try again, or use the email link on the sign-in page.',
      400,
    );
    if (ownsTxn) res.headers.append('Set-Cookie', txnCookie('', 0));
    return res;
  };

  // User cancelled / tenant policy / consent missing — Microsoft reports via ?error=.
  const upstreamError = url.searchParams.get('error');
  if (upstreamError) return refuse('upstream_error', { code: upstreamError });

  const code = url.searchParams.get('code') ?? '';
  if (!code || code.length > 4096 || !state) return refuse('missing_code_or_state');
  if (!txn) return refuse('missing_or_expired_txn');
  // Browser-bound CSRF check: the state Microsoft echoed must match the cookie minted
  // on THIS browser at /auth/oidc/login. An attacker-initiated code can't satisfy it.
  if (!ownsTxn) return refuse('state_mismatch');

  const secret = await resolveEntraSecret(env);
  if (!secret) {
    // ENTRA_CLIENT_SECRET missing/unreadable; refusing login (fail closed). Error-level via the
    // misconfiguration event; the refusal itself is logged like every other.
    logEvent('entra_misconfigured', { cause: 'secret_missing' });
    return refuse('client_secret_missing');
  }

  // Authorization-code exchange (confidential client + PKCE). The `organizations`
  // token endpoint serves all work/school tenants; the ID token's iss/tid — validated
  // strictly in verifyIdToken — is what pins the actual issuing tenant.
  let tokenRes: Response;
  try {
    tokenRes = await fetchImpl(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: secret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(env),
          code_verifier: txn.verifier,
        }).toString(),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (err) {
    logEvent('entra_token_endpoint_unreachable', { err });
    return refuse('token_endpoint_unreachable');
  }
  if (!tokenRes.ok) {
    // Log Microsoft's error CODE for ops (AADSTS…), never the full body.
    let errorCode = 'unknown';
    try {
      const errBody = (await tokenRes.json()) as { error?: string };
      if (typeof errBody.error === 'string') errorCode = errBody.error;
    } catch {
      // opaque body — keep 'unknown'
    }
    return refuse('token_exchange_failed', { status: tokenRes.status, code: errorCode });
  }
  let idToken = '';
  try {
    const body = (await tokenRes.json()) as { id_token?: string };
    idToken = typeof body.id_token === 'string' ? body.id_token : '';
  } catch {
    return refuse('token_response_malformed');
  }
  if (!idToken) return refuse('token_response_malformed');

  const verdict = await verifyIdToken(idToken, cfg, txn.nonce, undefined, nowMs);
  if (!verdict.ok) return refuse(verdict.reason);
  const { email, tid } = verdict.claims;

  // A reserved (service) address never signs in. No tenant can verify `.invalid`, so no genuine
  // token should ever assert one — refused outright anyway, before the users lookup.
  if (isReservedIdentifier(email)) return refuse('service_identity', { tid });

  // From here the flow is IDENTICAL to a magic link: domain policy, invite-only
  // (PER APP — no JIT provisioning; the shared registration authenticates, this
  // app's users table authorizes), same session mint, same audit action.
  if (!isAllowedDomain(env, email)) {
    return refuse('domain_not_allowed', { tid, domain: email.split('@')[1] ?? 'invalid' });
  }
  const db = makeDb(env);
  const user = await db.users.getActive(email);
  if (!user) return refuse('unknown_or_disabled_user', { tid });

  const sid = await createSession(env, email, 'entra_oidc', nowMs);
  await db.audit.insert({
    actor_email: email,
    action: 'login',
    payload_json: JSON.stringify({ method: 'entra_oidc', tid }),
    ip,
  });

  const headers = new Headers({
    Location: sanitizeReturnTo(txn.rt ?? undefined) ?? '/', // authoritative sanitize — the cookie is unsigned; the mint-time pass is only hygiene
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', serializeSessionCookie(sid, sessionTtlSec(env)));
  headers.append('Set-Cookie', txnCookie('', 0)); // transaction is one-shot
  return new Response(null, { status: 302, headers });
}
