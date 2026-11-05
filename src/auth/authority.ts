// THE AUTHORITY SEAM — where a PERSON's permissions come from, decided once per resolution.
//
// Most apps authorise from the role (`users.role` → PERMISSIONS), and for them nothing here does
// anything: the fork-owned hook (`authorityFor`, src/routes/authorityPolicy.ts) ships answering
// `null`, and the principal is returned exactly as the resolver built it. An app whose authority is
// EXTERNAL — insights authorises from the CIAL ACL grant of the caller's current company — answers
// with an authoritative set instead, and principalCan then reads that set in place of the role
// (src/auth/permissions.ts). Before this seam such an app had to fork the protected core
// (src/auth/index.ts, src/auth/types.ts, src/auth/permissions.ts, src/framework/execute.ts,
// src/mcp/tools.ts) to do so, and a forked core stops receiving the kit's fixes.
//
// THE RULES, each load-bearing:
//   1. ONLY THE RESOLVERS CALL IT, and only here is `permissions` set: from the hook's answer,
//      never from anything the request carries (a header, a body, a session value). The principal
//      the hook is handed is the resolver's own, frozen, with no `permissions` on it.
//   2. EVERY RESOLUTION, NO CACHE. The kit keeps nothing between requests, so the authority's
//      revocation lands on the caller's next request and no permission snapshot outlives the
//      request that derived it (PIA C15). A hook that wants a cache owns the staleness it buys.
//   3. FAIL CLOSED. A hook that throws, or answers anything but an AuthorityDecision, REFUSES: no
//      principal, a 401. It never falls back to the role — an authority that failed is not an
//      authority that said "use the role", and silently restoring role authority during an outage
//      of the real one is exactly the widening the seam exists to prevent. Only an explicit `null`
//      means the role: `undefined` — a hook branch that fell off the end without a `return` — is
//      `no_answer`, a refusal, and the AuthorityCheck type does not admit it either.
//   4. THE LOG CARRIES CODES, NEVER DATA: the refusal reason (a sanitized identifier), the
//      transport, a cause literal, a count. Never the principal, the keys held, or an attribute.
//   5. EXTERNAL AUTHORITY IS DECLARED BY THE APP (`authorityIsExternal`, same fork file), not
//      inferred from one principal: an ACL app's hook leaves a bearer token on the role, so a token
//      principal carries no set and looks role-only. The declaration is what the agent-run refusal
//      reads (authorityRefusesAgentRun, below), and a hook that answers a set on an env not
//      declared external refuses — the two cannot silently disagree.
import type { Env } from '../env';
import { type KIT_LOG_EVENTS, logEvent } from '../platform/logEvent';
import { authorityFor, authorityIsExternal } from '../routes/authorityPolicy';
import { PERMISSIONS, type PermissionKey } from './permissions';
import type {
  AuthorityContext,
  AuthorityPolicy,
  PersonPrincipal,
  Principal,
  PrincipalAttributes,
} from './types';

/** The fork's policy (src/routes/authorityPolicy.ts): what the resolvers and the flag use. */
export const FORK_AUTHORITY: AuthorityPolicy = Object.freeze({
  authorityFor,
  authorityIsExternal,
});

/** Past this many keys an answer is refused, not truncated: PERMISSIONS is a few dozen keys. */
export const MAX_AUTHORITY_KEYS = 256;

const REASON_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Why an answer was refused as malformed: one of the literals the `principal_authority_invalid`
 * event declares (src/platform/logEvent.ts) — derived from the registry, so the two cannot drift.
 */
export type AuthorityInvalidCause =
  (typeof KIT_LOG_EVENTS)['principal_authority_invalid']['fields']['cause']['values'][number];

type ReadDecision =
  | { readonly kind: 'role' }
  | { readonly kind: 'refuse'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly cause: AuthorityInvalidCause }
  | {
      readonly kind: 'authoritative';
      readonly permissions: ReadonlySet<PermissionKey>;
      readonly attributes: Readonly<PrincipalAttributes> | undefined;
      readonly dropped: number;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Read the hook's answer. Pure and total: whatever the hook returned (plain JavaScript, a cast, an
 * iterable that throws, a getter that throws), this returns one of four outcomes and never throws —
 * a throw while reading the answer is `permissions_unreadable`, a refusal like any other.
 */
export function readAuthorityDecision(answer: unknown): ReadDecision {
  try {
    return readDecisionUnguarded(answer);
  } catch {
    return { kind: 'invalid', cause: 'permissions_unreadable' };
  }
}

function readDecisionUnguarded(answer: unknown): ReadDecision {
  if (answer === null) return { kind: 'role' };
  // NOT the role: a hook that answered nothing (a branch with no `return`, typically the error path
  // of an upstream call) has not said "use the role", and reading it so would hand an externally-
  // authorised caller their bookkeeping role exactly when the authority is failing.
  if (answer === undefined) return { kind: 'invalid', cause: 'no_answer' };
  if (!isPlainObject(answer)) return { kind: 'invalid', cause: 'not_an_object' };
  const { permissions, refuse, attributes } = answer;
  if (refuse !== undefined && (permissions !== undefined || attributes !== undefined)) {
    return { kind: 'invalid', cause: 'ambiguous' };
  }
  if (refuse !== undefined) {
    // A refusal that is not a clean code still refuses; only its name is withheld from the log.
    return {
      kind: 'refuse',
      reason: typeof refuse === 'string' && REASON_RE.test(refuse) ? refuse : 'unspecified',
    };
  }
  if (permissions === undefined) return { kind: 'invalid', cause: 'no_decision' };
  // A string is iterable (by character) and would read as a set of one-letter keys: refused.
  if (
    typeof permissions !== 'object' ||
    permissions === null ||
    typeof (permissions as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function'
  ) {
    return { kind: 'invalid', cause: 'permissions_not_iterable' };
  }
  if (attributes !== undefined && !isPlainObject(attributes)) {
    return { kind: 'invalid', cause: 'attributes_not_an_object' };
  }
  const held = new Set<PermissionKey>();
  let seen = 0;
  let dropped = 0;
  // A throwing iterator is caught by readAuthorityDecision: `permissions_unreadable`.
  for (const key of permissions as Iterable<unknown>) {
    seen += 1;
    if (seen > MAX_AUTHORITY_KEYS) return { kind: 'invalid', cause: 'too_many_keys' };
    if (typeof key !== 'string') return { kind: 'invalid', cause: 'key_not_a_string' };
    // A key this app does not define grants nothing anywhere; dropping it keeps the set exact and
    // the count says the hook's map has drifted from PERMISSIONS.
    if (Object.hasOwn(PERMISSIONS, key)) held.add(key as PermissionKey);
    else dropped += 1;
  }
  return {
    kind: 'authoritative',
    permissions: held,
    attributes: attributes === undefined ? undefined : Object.freeze({ ...attributes }),
    dropped,
  };
}

/** A copy of `principal` nothing can write through: the object, and a bearer's scope array. */
function frozenCopy(principal: PersonPrincipal): Readonly<PersonPrincipal> {
  if (principal.credentialTransport === 'bearer' && Array.isArray(principal.tokenScopes)) {
    return Object.freeze({
      ...principal,
      tokenScopes: Object.freeze([...principal.tokenScopes]),
    });
  }
  return Object.freeze({ ...principal });
}

/**
 * The app's declaration for `env`, read fail-closed: `true` / `false` as declared, and `null` when
 * the declaration threw or answered anything but a boolean. Each reader treats `null` as the
 * answer that refuses (applyAuthority: not declared; authorityRefusesAgentRun: external).
 */
function declaredExternal(policy: AuthorityPolicy, env: Env): boolean | null {
  try {
    const answer: unknown = policy.authorityIsExternal(env);
    return typeof answer === 'boolean' ? answer : null;
  } catch {
    return null;
  }
}

/**
 * Ask the app's authority hook about `principal`, as the resolver built it, and return the
 * principal the request runs as — or `null`, which the resolver returns as "no principal" (401).
 *
 *   hook answers null              → `principal`, unchanged: the role decides.
 *   { permissions, attributes? }   → `principal` with that set (and data) attached — only when the
 *                                    app declares its authority external on this env; otherwise
 *                                    null (`undeclared_external`).
 *   { refuse }, a throw, `undefined` or any malformed answer → null, logged by code.
 *
 * The hook receives a FROZEN copy — its token scopes a frozen copy too — so a hook cannot rewrite
 * the principal's role, kind or ceiling in place; what comes back is always built from the
 * resolver's own object.
 */
export async function applyAuthority<P extends PersonPrincipal>(
  policy: AuthorityPolicy,
  principal: P,
  context: AuthorityContext,
): Promise<P | null> {
  const transport = principal.credentialTransport;
  let answer: unknown;
  try {
    answer = await policy.authorityFor(frozenCopy(principal), context);
  } catch (err) {
    logEvent('principal_authority_hook_failed', { transport, err });
    return null;
  }
  const decision = readAuthorityDecision(answer);
  switch (decision.kind) {
    case 'role':
      return principal;
    case 'refuse':
      logEvent('principal_authority_refused', { transport, reason: decision.reason });
      return null;
    case 'invalid':
      logEvent('principal_authority_invalid', { transport, cause: decision.cause });
      return null;
    case 'authoritative':
      // A set on an env the app does not declare external: the declaration is what the agent-run
      // refusal reads, so a hook and a declaration that disagree refuse rather than let the flag
      // miss this app's tokens.
      if (declaredExternal(policy, context.env) !== true) {
        logEvent('principal_authority_invalid', { transport, cause: 'undeclared_external' });
        return null;
      }
      if (decision.dropped > 0) {
        logEvent('principal_authority_keys_dropped', { transport, dropped: decision.dropped });
      }
      return {
        ...principal,
        permissions: decision.permissions,
        ...(decision.attributes === undefined ? {} : { attributes: decision.attributes }),
      };
  }
}

/**
 * THE AGENT-RUN REFUSAL FLAG. True when the in-app agent loop must refuse to START a run for
 * `principal`; the loop (plan P2) checks it before a run exists and answers the uniform 404.
 *
 *   - a SERVICE principal: false. It never carries an authoritative set; its one scope decides, and
 *     the agent scope family is not service-grantable anyway.
 *   - a principal of no or an unknown `kind`: true (fail closed).
 *   - a PERSON carrying an authoritative set on anything but a session cookie — a bearer, or a
 *     transport this code has never heard of: true, whatever the app declares. So is a malformed
 *     set (not a Set).
 *   - in an app whose authority is the ROLE on this env (`authorityIsExternal(env)` is `false` —
 *     the kit default and every role-only app): false. Nothing changes for them.
 *   - in an app whose authority is EXTERNAL (the declaration is `true`, throws, or answers a
 *     non-boolean): false only for a person on a SESSION cookie whose permissions the hook decided.
 *     Every token — including one the hook left on the role, which is how an ACL app keeps its
 *     local-authority tokens working — and every principal still on the role: true.
 *
 * Why a token is refused rather than narrowed: an agent run acts on the caller's authority for many
 * calls, and in an ACL app that authority is the upstream grant, re-derived per request from what
 * the SESSION carries (the ACL credential). A personal token carries no such credential — it is
 * local authority the upstream grant cannot re-derive — so a run started on one would rest on the
 * role, not on the grant plan invariant 1 requires, and stack a second delegation (token → agent)
 * on top. Why the APP's declaration and not the principal's set: see rule 5 in the header.
 *
 * `policy` defaults to the fork's (FORK_AUTHORITY); it is a parameter only so tests can drive
 * another without module mocking.
 */
export function authorityRefusesAgentRun(
  principal: Principal,
  env: Env,
  policy: AuthorityPolicy = FORK_AUTHORITY,
): boolean {
  if (principal.kind === 'service') return false;
  if (principal.kind !== 'person') return true;
  const held: unknown = principal.permissions;
  const onSession = principal.credentialTransport === 'cookie';
  if (held !== undefined && !(held instanceof Set)) return true;
  if (held !== undefined && !onSession) return true;
  if (declaredExternal(policy, env) === false) return false;
  return !(onSession && held instanceof Set);
}
