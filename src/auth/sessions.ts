// KV-backed sessions with force-logout support. A session is a random UUID mapped to
// { email, created_at_ms }. Revoking a user writes revoked-sessions:<email> = now;
// any session created at-or-before that instant dies within ~60s at every PoP —
// immediately at the location that served the revoke, but Workers KV caches reads
// (including negative lookups of a not-yet-seen tombstone) at each PoP for its ~60s
// minimum, so a PoP that resolved the session recently keeps honoring it up to that
// long. Sessions minted afterwards are honored (revocation bounces, it doesn't ban).
// The same window applies to destroySession/logout reads below — the millisecond
// `<=` boundary precision is exact only at the writing PoP. Genuinely INSTANT
// removal is the disable-a-user path: the live `users` D1 check runs on every
// request (src/auth/index.ts). If instant force-logout is ever required, the cheap
// design is a `revoked_at` column read inside that same per-request D1 query — not
// a KV cacheTtl tweak (60s is already KV's minimum). See DECISIONS 2026-08-03.
//
// KV keys are sha256(sid), never the raw sid (AICOE-346): the cookie value is a bearer
// credential, so a KV reader — the same holder-of-stored-credentials the WORM triggers and
// hashed api_tokens defend against — must not be able to replay stored keys as logins.
// Resolution hashes the presented sid; the raw sid exists only in the Set-Cookie header.
//
// THE SESSION KEY is that hash: sha256(sid) as lowercase hex, the suffix of the KV key. It is
// what an agent turn stores to name the session it runs on (src/auth/runPrincipal.ts, PIA C15):
// it finds the session again — so logout, the TTL, revocation and the reserved-identifier rule
// all still apply mid-turn — but presented as a cookie it is hashed again and misses, exactly like
// a key lifted from KV. sessionKeyOf derives it from a request, getSessionByKey resolves it, and
// getSession is getSessionByKey over the hash of a presented sid.
import type { Env } from '../env';
import { logEvent } from '../platform/logEvent';
import { readCookie, SESSION_COOKIE } from './cookies';
import { isReservedIdentifier } from './serviceNamespace';
import { sha256Hex } from './tokens';
import type { AuthMethod } from './types';

const SESSION_PREFIX = 'session:';
const REVOKED_PREFIX = 'revoked-sessions:';
/** A session key: what sha256Hex returns, and nothing else (never a raw sid). */
const SESSION_KEY_HEX = /^[0-9a-f]{64}$/;

async function sessionKey(sid: string): Promise<string> {
  return SESSION_PREFIX + (await sha256Hex(sid));
}

export interface SessionData {
  email: string;
  created_at_ms: number;
  /** How the session was minted. Audit/policy only — authorization NEVER reads this. */
  auth_method?: AuthMethod;
}

export function sessionTtlSec(env: Env): number {
  const n = Number(env.SESSION_TTL_SEC ?? '86400');
  return Number.isFinite(n) && n > 0 ? n : 86400;
}

/**
 * A reserved (service) identifier can never hold a session: a machine principal authenticates
 * only with a bearer token. createSession refuses to mint one (a programming error — every login
 * path refuses the address before it gets here) and getSession refuses to honour one (a session
 * minted before this rule existed, or written into KV by anything else).
 */
export class ReservedSessionError extends Error {
  constructor() {
    super('a session can never be minted for a reserved (service) identifier');
    this.name = 'ReservedSessionError';
  }
}

export async function createSession(
  env: Env,
  email: string,
  authMethod: AuthMethod = 'magic_link',
  // Mint timestamp; injectable so tests can place a session deterministically on either
  // side of a revocation instant without sleeping on the wall clock.
  nowMs: number = Date.now(),
): Promise<string> {
  if (isReservedIdentifier(email)) throw new ReservedSessionError();
  const sid = crypto.randomUUID();
  const data: SessionData = {
    email: email.toLowerCase(),
    created_at_ms: nowMs,
    auth_method: authMethod,
  };
  await env.SESSIONS.put(await sessionKey(sid), JSON.stringify(data), {
    expirationTtl: sessionTtlSec(env),
  });
  return sid;
}

/**
 * The session KEY `req` presents — sha256 of its session cookie's sid, as lowercase hex — or null
 * when it presents none. Never the sid: the key is safe to store (an agent turn row holds it until
 * the turn ends), because presented as a cookie it is hashed again and resolves nothing.
 *
 * Null too when the request carries a bearer `Authorization` header, whatever cookie rides along:
 * resolvePrincipal (src/auth/index.ts) resolves such a request through the token, so no session
 * authenticated it and there is no session to name.
 */
export async function sessionKeyOf(req: Request): Promise<string | null> {
  if (req.headers.get('authorization')?.toLowerCase().startsWith('bearer ')) return null;
  const sid = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
  return sid ? sha256Hex(sid) : null;
}

/** The session presented as cookie `sid`, under the rules getSessionByKey states. */
export async function getSession(env: Env, sid: string): Promise<SessionData | null> {
  return getSessionByKey(env, await sha256Hex(sid));
}

/**
 * The live session stored under KEY `keyHex` (sha256 of its sid — sessionKeyOf), or null. The same
 * rules as for a presented cookie, because getSession is this function: gone (logout, the TTL) is
 * null; a session minted at or before its owner's revocation is null; a reserved (service)
 * identifier is null. Anything but 64 lowercase hex characters is null before KV is read, so a raw
 * sid handed in by mistake never names a key.
 */
export async function getSessionByKey(env: Env, keyHex: string): Promise<SessionData | null> {
  if (typeof keyHex !== 'string' || !SESSION_KEY_HEX.test(keyHex)) return null;
  const raw = await env.SESSIONS.get(SESSION_PREFIX + keyHex);
  if (!raw) return null;
  let data: SessionData;
  try {
    data = JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
  if (!data.email) return null;
  if (isReservedIdentifier(data.email)) {
    logEvent('session_refused', { reason: 'service_identity' });
    return null;
  }
  // Sessions without created_at_ms are treated as 0 — any revocation kills them.
  const createdAt = typeof data.created_at_ms === 'number' ? data.created_at_ms : 0;
  const revokedAt = await env.SESSIONS.get(REVOKED_PREFIX + data.email.toLowerCase());
  // Boundary is INCLUSIVE (`<=`) on purpose — fail-safe: a session minted in the SAME
  // millisecond as the revoke dies rather than surviving. The cost is only that such a
  // session must re-authenticate (revocation bounces, it doesn't ban), which is the
  // safer trade than letting a same-instant session slip through a force-logout.
  if (revokedAt && createdAt <= Number(revokedAt)) return null;
  return data;
}

/**
 * When `session` was minted, if it says so usably — a non-negative safe integer of epoch ms — else
 * null. What a principal carries as `sessionCreatedAtMs`; a session without a usable one (minted
 * before the field, or written by anything else) carries none, and every reader of that field
 * fails closed.
 */
export function mintedAtMs(session: SessionData): number | null {
  const at: unknown = session.created_at_ms;
  return typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 ? at : null;
}

export async function destroySession(env: Env, sid: string): Promise<void> {
  await env.SESSIONS.delete(await sessionKey(sid));
}

/** Force-logout: kills every session the user holds — within ~60s at every PoP
 * (immediately at the revoking location); see the KV-cache note in the header. */
export async function revokeAllSessions(
  env: Env,
  email: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await env.SESSIONS.put(REVOKED_PREFIX + email.toLowerCase(), String(nowMs), {
    expirationTtl: sessionTtlSec(env) + 60,
  });
}
