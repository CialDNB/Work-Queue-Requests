// RUN AUTHORITY — who an in-app agent turn acts as, re-derived for every round and every tool call
// (PIA C15). DECISIONS 2026-10-04.
//
// A turn outlives the request that started it: it runs in a Workflow step, with no request at all.
// Its grant is the SESSION that started (or approved) it, and the turn row names that session by
// two values only — its KEY (sha256 of the sid, the suffix of its KV key; never the sid, AICOE-346)
// and its mint time — both cleared when the turn ends. No permission set is ever stored: what the
// person may do is re-derived each time from the live session, the live `users` row and the app's
// authority hook, so a revocation lands on the turn's next call, not its next turn.
//
// resolveRunPrincipal answers null — the engine then ends the turn `revoked`, and no further call
// runs — when any of these holds:
//   1. the session is gone: logout deleted it, its TTL ran out, or its owner was force-logged-out
//      at or after its mint (getSessionByKey). KV caches reads per PoP, so each of the three can
//      take up to ~60 s to land at a PoP other than the one that served the logout or revoke — and
//      a Workflow step usually runs elsewhere — exactly as for a browser request (sessions.ts);
//   2. it is not the session the turn was started on: another email, or another mint time;
//   3. the user is disabled or removed (users.getActive — instant);
//   4. the app's authority hook refuses, throws or answers anything malformed (applyAuthority) —
//      it is handed `request: null`, so an ACL app derives the grant from `session` alone;
//   5. authorityRefusesAgentRun: in an app whose authority is external, a session the hook left on
//      the role;
//   6. the principal no longer holds `agent.use` — a demotion (a viewer holds it not), or a decided
//      set that leaves it out. The model rounds go straight to the provider, so no route's
//      permission check covers them: this is the one place the key is re-checked mid-turn.
//
// Sessions do not slide. A turn started minutes before its session expires ends `revoked` when it
// does; the person signs in again and retries. Accepted, and documented in DECISIONS.
//
// A thrown error (KV or D1 down) propagates: it is never a principal, and the caller treats it as
// it treats any failure to resolve — no call runs.
import { makeDb } from '../data';
import type { Env } from '../env';
import { applyAuthority, authorityRefusesAgentRun, FORK_AUTHORITY } from './authority';
import { principalCan } from './permissions';
import { getSessionByKey, mintedAtMs } from './sessions';
import type { AuthorityPolicy, PersonCookiePrincipal, Principal } from './types';

/**
 * What an agent turn stores to name the session it runs on — taken from the starting request:
 * `email` and `sessionCreatedAtMs` from its resolved principal, `sessionKey` from sessionKeyOf
 * (src/auth/sessions.ts). Identifiers only: nothing here is a credential or a permission.
 */
export interface RunAuthority {
  readonly email: string;
  readonly sessionKey: string;
  readonly sessionCreatedAtMs: number;
}

/**
 * The principal an agent turn acts as right now, or null (the turn ends `revoked`). Call it before
 * every model round and every tool call; never cache its answer across calls.
 *
 * The result is a person on a session cookie, built from explicit fields — never a spread of the
 * stored session — and then handed to the app's authority hook exactly as resolvePrincipal hands
 * it, so it holds what a browser request on the same session would hold at this instant, the
 * hook's authoritative set included.
 *
 * `policy` defaults to the fork's (FORK_AUTHORITY); it is a parameter only so tests can drive a
 * deciding, refusing or throwing hook without module mocking.
 */
export async function resolveRunPrincipal(
  env: Env,
  run: RunAuthority,
  policy: AuthorityPolicy = FORK_AUTHORITY,
): Promise<PersonCookiePrincipal | null> {
  const session = await getSessionByKey(env, run.sessionKey);
  if (!session) return null;
  // The SAME session, not merely a live one: a key names one session, and the stored email and
  // mint time must both still be what the turn recorded.
  if (session.email !== run.email) return null;
  const mintedAt = mintedAtMs(session);
  if (mintedAt === null || mintedAt !== run.sessionCreatedAtMs) return null;

  const user = await makeDb(env).users.getActive(session.email);
  if (!user) return null;

  const principal: PersonCookiePrincipal = {
    kind: 'person',
    email: user.email,
    name: user.name,
    role: user.role,
    authMethod: session.auth_method ?? 'magic_link',
    // The turn's grant is a session the person presented as a cookie; the run routes accept only
    // a cookie principal (PIA C8), so this is the transport the turn was started on.
    credentialTransport: 'cookie',
    sessionCreatedAtMs: mintedAt,
  };
  const resolved = await applyAuthority(policy, principal, { env, user, session, request: null });
  if (!resolved) return null;
  if (resolved.kind !== 'person' || resolved.credentialTransport !== 'cookie') return null;
  if (authorityRefusesAgentRun(resolved, env, policy)) return null;
  // A turn is a use of the agent: without the key, not one more round or tool call (PIA §1).
  if (!principalCan(resolved, 'agent.use')) return null;
  return resolved;
}

/**
 * Was `principal`'s session minted within the last `maxAgeMs`, as of `nowMs`? True only for a
 * person on a session cookie whose `sessionCreatedAtMs` lies in `[nowMs - maxAgeMs, nowMs]`. A
 * bearer or service principal, a session with no usable mint time, a mint time in the future (only
 * a KV writer or a bad clock makes one, and it must not pass forever), and any non-finite or
 * negative argument: false.
 *
 * A step-up precondition, never a permission: a route that uses it checks its permission key as
 * usual and this as well (the agent DSR route: every action needs a session ≤ 10 minutes old).
 * A session is minted only by a completed sign-in, so this is the time since that sign-in. It is a
 * true re-authentication only where the sign-in makes the person present credentials again: a
 * magic link does; Entra on `prompt=select_account` may mint a new session from the IdP's own
 * session without one (owner question Q8: `prompt=login` / `max_age`).
 */
export function recentlyAuthenticated(
  principal: Principal,
  maxAgeMs: number,
  nowMs: number,
): boolean {
  if (principal.kind !== 'person' || principal.credentialTransport !== 'cookie') return false;
  const mintedAt: unknown = principal.sessionCreatedAtMs;
  if (typeof mintedAt !== 'number' || !Number.isFinite(mintedAt)) return false;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(nowMs)) return false;
  return mintedAt <= nowMs && mintedAt >= nowMs - maxAgeMs;
}
