// Principal resolution — the interchangeable-auth seam. Two surfaces mint the SAME
// Principal: session cookies (magic links today; Entra OIDC plugs in here later by
// minting sessions with auth_method 'entra_oidc' — nothing downstream changes) and
// pre-issued Bearer t_* tokens for programmatic/MCP access. Fail-closed: any doubt
// resolves to null, and a removed/disabled user dies on their next request because
// the live users table is consulted every time.
//
// Both branches then ask the app's AUTHORITY hook (src/routes/authorityPolicy.ts, via
// applyAuthority in src/auth/authority.ts) where this person's permissions come from: the role
// (the kit default — the principal is returned unchanged), an authoritative set that replaces the
// role (an ACL app), or a refusal (null). It runs on every request; nothing is cached.
//
// An agent turn has no request to resolve: its principal is re-derived from the session it was
// started on, per round and per tool call, by resolveRunPrincipal (src/auth/runPrincipal.ts) —
// the same live checks, with the authority hook handed `request: null`, plus `agent.use` itself.
import { makeDb } from '../data';
import type { Env } from '../env';
import { applyAuthority, FORK_AUTHORITY } from './authority';
import { readCookie, SESSION_COOKIE } from './cookies';
import { getSession, mintedAtMs } from './sessions';
import { resolveApiToken } from './tokens';
import type { AuthorityPolicy, PersonCookiePrincipal, Principal } from './types';

/**
 * The live Principal for `req`, or null (401). `authority` defaults to the fork's policy
 * (src/routes/authorityPolicy.ts, as FORK_AUTHORITY); it is a parameter only so tests can drive a
 * deciding, refusing or throwing hook without module mocking — the same pattern as
 * resolveApiTokenByHash's `refuse`.
 */
export async function resolvePrincipal(
  req: Request,
  env: Env,
  authority: AuthorityPolicy = FORK_AUTHORITY,
): Promise<Principal | null> {
  const authz = req.headers.get('authorization');
  if (authz?.toLowerCase().startsWith('bearer ')) {
    return resolveApiToken(env, authz.slice(7).trim(), authority, req);
  }

  const sid = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
  if (!sid) return null;

  const session = await getSession(env, sid);
  if (!session) return null;

  const user = await makeDb(env).users.getActive(session.email);
  if (!user) return null;

  const mintedAt = mintedAtMs(session);
  const principal: PersonCookiePrincipal = {
    // A session is only ever minted for a `users` row, so a cookie caller is always a person.
    kind: 'person',
    email: user.email,
    name: user.name,
    role: user.role,
    authMethod: session.auth_method ?? 'magic_link',
    // A transport fact, not a stored one: this branch fired because a session COOKIE was
    // presented, so CSRF applies regardless of what auth_method the session recorded.
    credentialTransport: 'cookie',
    // From the STORED session, for recentlyAuthenticated and an agent turn's grant; absent when
    // the session carries no usable mint time (every reader then fails closed).
    ...(mintedAt === null ? {} : { sessionCreatedAtMs: mintedAt }),
  };
  // Built from explicit fields only — never a spread of the session value — so nothing stored in
  // or presented with the session can put `permissions` on the principal. Only the hook can.
  return applyAuthority(authority, principal, { env, user, session, request: req });
}
