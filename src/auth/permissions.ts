// Per-action permission map. Every defineRoute names one of these keys; the framework
// checks it before the handler runs. Adding an endpoint = adding/choosing a key here,
// and the permission-matrix test (test/auth/permissions.test.ts) must be extended to
// match — that test enumerates every key × role pair, so an unreviewed change fails CI.
import type { Db } from '../data';
import type { PersonPrincipal, Principal, Role } from './types';

export const ALL_ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer'];

export const PERMISSIONS = {
  'users.read': ['owner', 'admin'],
  'users.manage': ['owner', 'admin'],
  'audit.read': ['owner', 'admin'],
  // The read ledger (who read what). Deliberately its OWN key rather than a reuse of
  // 'audit.read': the two logs answer different questions, and an app that later wants to widen
  // one must not silently widen the other. Same roles today — that is a coincidence a separate
  // key lets a fork break.
  'readLog.read': ['owner', 'admin'],
  'settings.manage': ['owner', 'admin'],
  'meta.read': ['owner', 'admin'],
  'tokens.self': ['owner', 'admin', 'member'],
  // Create, list, rotate, revoke and disable SERVICE identities (machine principals —
  // src/auth/serviceIdentityRoutes.ts). Non-delegable: only a person at a keyboard, on a session,
  // may bring a machine principal into being or hand one a credential.
  'serviceIdentities.manage': ['owner', 'admin'],
  'ai.use': ['owner', 'admin', 'member'],
  // ---- the in-app agent (PIA C8, C15; DECISIONS 2026-10-04) ----
  // Start, watch and stop one's OWN agent turns and decide their approvals (the run routes, which
  // land with the agent loop). Non-delegable and agent-forbidden: no token, MCP client or model
  // ever starts or resumes a run. A run acts as the SESSION that started it, re-read per round and
  // per tool call (resolveRunPrincipal, src/auth/runPrincipal.ts) — which also re-checks this key,
  // so a person who loses it mid-turn (a demotion, an ACL set without it) gets no further call.
  'agent.use': ['owner', 'admin', 'member'],
  // The agent data subject-rights route (`POST /api/agent/dsr`: discover, find, export, erase;
  // lands with the transcript store). Owner only, non-delegable, agent-forbidden, and every action
  // also needs a session minted in the last 10 minutes (recentlyAuthenticated).
  'agent.erase': ['owner'],
  // ---- app permissions (golden example — replace alongside your app tables) ----
  'notes.read': ['owner', 'admin', 'member', 'viewer'],
  'notes.write': ['owner', 'admin', 'member'],
} as const satisfies Record<string, readonly Role[]>;

export type PermissionKey = keyof typeof PERMISSIONS;

/**
 * Role-only check. Use it for questions about a ROLE (the permission matrix, the manifest, the
 * SPA's own gating). For "may THIS caller do X" use principalCan(), which also applies a person's
 * authoritative set (it replaces the role where an authority hook set one) and the bearer
 * narrowing below — executeRoute and the MCP tool list both do.
 *
 * `null` is the role of a SERVICE principal (it has none) and holds nothing, so code that still
 * asks `can(principal.role, …)` fails closed for a machine caller instead of guessing a role.
 */
export function can(role: Role | null, permission: PermissionKey): boolean {
  if (role === null) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/**
 * NON-DELEGABLE permissions (PIA C8). A bearer credential — a `t_*` token, over HTTP or through
 * the MCP adapter — NEVER holds these, whatever its role and whatever its scopes say. Each one
 * either lets a stolen token outlive or widen itself, or reads the actor-level record of who did
 * what, which exists for an owner/admin at a keyboard, not for a script:
 *
 *   tokens.self      list/mint/revoke tokens. Bearer requests are CSRF-exempt, so a leaked token
 *                    that could mint would survive its own revocation.
 *   users.manage     invite, change a role, remove — escalation and persistence.
 *   settings.manage  alert recipients, the Slack webhook, login policy — silences the alarms.
 *   audit.read       the audit log: actor emails, IPs, targets.
 *   readLog.read     the read ledger: which person read what.
 *   meta.read        the governance manifest. No consumer reads it with a token: the fleet
 *                    registry receives it through the daily push (src/cron/reportToRegistry.ts),
 *                    and a GitHub code search of the CialDNB org found no bearer pull (DECISIONS
 *                    2026-09-23). Structure intel with no machine consumer stays session-only.
 *   serviceIdentities.manage
 *                    create machine principals and mint their tokens. A token that could would
 *                    mint its own long-lived successor under a name nobody reads as a person.
 *   agent.use        start or resume an agent run. A run is a second delegation — the person's
 *                    authority handed to a model for many calls — and its grant is the SESSION
 *                    that started it, re-read on every call (src/auth/runPrincipal.ts). A token
 *                    carries no session to re-read, so a run on one would rest on nothing the
 *                    kit can revoke mid-turn. No bearer or MCP run exists before a P4 addendum.
 *   agent.erase      the agent DSR route: find, export and erase other people's transcripts. A
 *                    leaked token that could would read or destroy them in bulk.
 *
 * Enforced by principalCan() inside executeRoute — the one pipeline HTTP and MCP share, in the
 * protected core — so no fork route can forget it. Adding a key narrows every existing token on
 * the next deploy; removing one needs a DECISIONS entry. Pinned by test/auth/permissions.test.ts.
 */
export const NON_DELEGABLE: ReadonlySet<string> = new Set<PermissionKey>([
  'tokens.self',
  'users.manage',
  'settings.manage',
  'audit.read',
  'readLog.read',
  'meta.read',
  'serviceIdentities.manage',
  'agent.use',
  'agent.erase',
]);

/**
 * The reserved `agent` scope family — the permissions of the in-app agent loop. A legacy unscoped
 * token (scopes NULL) never carries one, a service identity never holds one, and the default
 * scope snapshot at mint leaves them out. Deliberately a bare prefix: anything spelled `agent…` is
 * reserved, so a key cannot slip past the rule on punctuation (`agent.run`, `agent:run`,
 * `agents.read`).
 *
 * The two keys that exist (`agent.use`, `agent.erase`) are ALSO non-delegable, so no token holds
 * them whatever its scopes say — asking for one by name at mint is a 400. The prefix rule is the
 * second wall for them, and the only one for a future agent key a PIA addendum might make
 * delegable: such a key would still reach a token only when asked for by name.
 */
export const AGENT_SCOPE_PREFIX = 'agent';

export function isAgentScope(key: string): boolean {
  return key.startsWith(AGENT_SCOPE_PREFIX);
}

/**
 * The key the agent subject-rights route (`POST /api/agent/dsr`) carries. Reserved in
 * AGENT_FORBIDDEN before it existed (P1), and a real key since P2: it can never become an agent
 * tool — an erasure a prompt injection could drive is the one agent action that cannot be undone
 * and cannot be audited after the fact.
 */
export const AGENT_ERASE_PERMISSION = 'agent.erase' satisfies PermissionKey;

/**
 * AGENT-FORBIDDEN permissions: a route gated by one of these can NEVER be exposed to the in-app
 * agent. `defineRoute` refuses an `agent:` block on such a route at module load
 * (src/framework/agentExposure.ts), so no fork can hand one to a model by accident or by drift.
 *
 * An agent tool runs as the signed-in person, but the arguments are written by a model that reads
 * text nobody vetted — tool results, client documents, upstream descriptions. So the question here
 * is not "may this person do X" (principalCan answers that) but "may X be done on this person's
 * behalf by something a prompt injection can steer". For each key below the answer is no:
 *
 *   tokens.self              mint a credential — persistence that outlives the conversation.
 *   users.manage             invite, re-role, remove — escalation and persistence.
 *   settings.manage          alert recipients, the Slack webhook, login policy — silences alarms.
 *   audit.read               the audit log: actor emails, IPs, targets — who did what.
 *   readLog.read             the read ledger: which person read what.
 *   meta.read                the governance manifest — structure intel with no agent use.
 *   serviceIdentities.manage create machine principals and mint their tokens.
 *   agent.use                start a run — a model that starts runs is a loop no person began.
 *   agent.erase              (AGENT_ERASE_PERMISSION) subject erasure.
 *
 * RELATION TO NON_DELEGABLE, and why they are two sets. NON_DELEGABLE answers "may a bearer
 * CREDENTIAL hold this key"; this answers "may a MODEL be handed this key's routes". They agree
 * today on every existing key, because an agent is a delegation of the person's authority to
 * something they do not control, exactly as a token is. The invariant pinned by
 * test/auth/permissions.test.ts is ONE-WAY: NON_DELEGABLE ⊆ AGENT_FORBIDDEN — a key too dangerous
 * for a script is too dangerous for a model. The reverse need not hold (a key may be forbidden to
 * the agent and say nothing about tokens — `agent.erase` was, while it was reserved), so neither
 * set is derived from the other: moving a key out of NON_DELEGABLE must not quietly hand it to the
 * agent, and a key forbidden to the agent must not quietly narrow every token.
 *
 * Built over PermissionKey, so a typo is a type error; exported as a string set so callers can ask
 * about any label. Adding a key forbids its routes' exposure on the next build (defineRoute throws
 * at load); removing one needs a DECISIONS entry. See DECISIONS 2026-09-25 and 2026-10-04.
 */
export const AGENT_FORBIDDEN: ReadonlySet<string> = new Set<PermissionKey>([
  'tokens.self',
  'users.manage',
  'settings.manage',
  'audit.read',
  'readLog.read',
  'meta.read',
  'serviceIdentities.manage',
  'agent.use',
  AGENT_ERASE_PERMISSION,
]);

/** May a route gated by `permission` ever be exposed to the agent? ('authenticated' never is.) */
export function isAgentForbidden(permission: string): boolean {
  return permission === 'authenticated' || AGENT_FORBIDDEN.has(permission);
}

/**
 * AGENT-FORBIDDEN REPOSITORIES: an exposed route may not name one of these in `needs`, whatever
 * its permission. AGENT_FORBIDDEN looks at the route's LABEL; this looks at what the route can
 * REACH — without it, a route gated by an exposable key (`notes.read`) that declares
 * `needs: ['audit']` would hand the model the audit log with no ruling and no approval. The data
 * behind each forbidden key, by repository:
 *
 *   audit, readLog      who did what, who read what (audit.read, readLog.read)
 *   activity            the daily counts computed from both, and from ai_usage
 *   tokens              credentials (tokens.self; serviceIdentities.manage mints them too)
 *   serviceIdentities   machine principals (serviceIdentities.manage)
 *   magicLinks          live login links — a session for whoever holds one
 *   settings            alert recipients, the webhook, login policy (settings.manage)
 *   meta                governance metadata (meta.read)
 *   aiBudget            the per-actor AI spend ledger, and the budget that brakes the agent itself
 *   agent, agentErasure the agent's own transcript store (migration 0006): every person's threads,
 *                       held transcripts and approval arguments. No tool reads a transcript — the
 *                       agent has no memory beyond the thread it runs in. Reached only by the agent
 *                       engine, its run routes (agent.use: `agent`), the retention sweep and the
 *                       DSR route (agent.erase: `agent`, `agentErasure`), none of them an agent
 *                       tool.
 *
 * `users` and `groups` are NOT here: `users.read` is an exposable key backed by the `users`
 * repository, and a person's role is changed by users.manage routes, which AGENT_FORBIDDEN already
 * refuses. Pinned in test/auth/permissions.test.ts against the keys above; the guard is
 * checkedAgentExposure (src/framework/agentExposure.ts). Adding a repository here refuses its
 * exposure on the next build; removing one needs a DECISIONS entry.
 */
export const AGENT_FORBIDDEN_REPOSITORIES: ReadonlySet<string> = new Set<keyof Db>([
  'audit',
  'readLog',
  'activity',
  'tokens',
  'serviceIdentities',
  'magicLinks',
  'settings',
  'meta',
  'aiBudget',
  'agent',
  'agentErasure',
]);

/** May an exposed route declare `repository` in its `needs`? */
export function isAgentForbiddenRepository(repository: string): boolean {
  return AGENT_FORBIDDEN_REPOSITORIES.has(repository);
}

/**
 * The delegation rule on its own, over plain strings: does a bearer credential whose stored
 * scopes are `scopes` carry `permission`? It assumes the ROLE already grants it (principalCan
 * checks that first) — this can only take away. Exported so the rule is testable for keys that do
 * not exist yet (the agent family).
 *
 *   - NON_DELEGABLE: never, whatever the scopes say.
 *   - scopes exactly `null` (a legacy token — `api_tokens.scopes` NULL): every role permission
 *     except the agent family.
 *   - scopes an array: exactly the keys listed — a ceiling, never a grant.
 *   - anything else — ABSENT (undefined) or not an array: nothing. Legacy is the widest a token
 *     can be, so only an explicit null means it; a bearer principal built without its token's
 *     stored scopes (a fork resolver that forgot to carry them, a hand-cast Principal) fails
 *     closed instead of widening to its owner's whole role.
 */
export function scopeAllows(
  scopes: readonly string[] | null | undefined,
  permission: string,
): boolean {
  if (NON_DELEGABLE.has(permission)) return false;
  if (scopes === null) return !isAgentScope(permission);
  return Array.isArray(scopes) && scopes.includes(permission);
}

/**
 * The service-holding rule on its own, over plain strings and a given key set (`isKey`): a key a
 * service may hold is a real key that is neither non-delegable nor in the reserved agent family.
 * Exported so the agent clause is testable while no agent key exists (over PERMISSIONS alone,
 * `isKey` already refuses every `agent…` string, so the clause could be deleted unnoticed) — the
 * same reason scopeAllows() takes plain strings.
 */
export function serviceMayHold(key: string, isKey: (key: string) => boolean): boolean {
  return isKey(key) && !NON_DELEGABLE.has(key) && !isAgentScope(key);
}

/**
 * May a SERVICE principal ever hold `key`? Only a real permission key that is neither
 * non-delegable nor in the reserved agent family (serviceMayHold over PERMISSIONS). A service
 * identity's one scope is chosen from these at creation, and re-checked on every request (a later
 * kit change that moves a key into NON_DELEGABLE takes it away from every service on the next
 * deploy).
 */
export function isServiceGrantable(key: string): key is PermissionKey {
  return serviceMayHold(key, (k) => Object.hasOwn(PERMISSIONS, k));
}

/** Every key a service identity may be created with — the input to the admin page's picker. */
export function serviceGrantableScopes(): PermissionKey[] {
  return (Object.keys(PERMISSIONS) as PermissionKey[]).filter(isServiceGrantable);
}

/**
 * THE authorization question for a live caller: may `principal` exercise `permission`?
 *
 *   - A SERVICE principal has no role. It holds exactly its identity's one scope, and only while
 *     that scope is still service-grantable — no role, no token ceiling, no transport and no
 *     `permissions` field can add anything to it. Only a bearer service principal is recognised
 *     (the only kind a resolver produces).
 *   - A PERSON: what the person HOLDS must include it (personHolds: the AUTHORITATIVE set when the
 *     app's authority hook attached one, otherwise the role); a cookie session then holds it
 *     outright; anything else — a bearer token, or a transport value this code has never heard of
 *     — only holds what scopeAllows() leaves, and a person bearer principal with no `tokenScopes`
 *     there holds nothing. Fails closed on the transport axis the way requiresCsrfCheck does on
 *     its own: only an exact 'cookie' is undelegated. The authoritative set replaces the ROLE
 *     only — the bearer ceiling and the non-delegable set narrow it exactly as they narrow a role.
 *   - Anything else (a principal with no `kind`, or one this code has never heard of) holds
 *     nothing.
 */
export function principalCan(principal: Principal, permission: PermissionKey): boolean {
  if (principal.kind === 'service') {
    return (
      principal.credentialTransport === 'bearer' &&
      principal.service.scope === permission &&
      isServiceGrantable(permission)
    );
  }
  if (principal.kind !== 'person') return false;
  if (!personHolds(principal, permission)) return false;
  if (principal.credentialTransport === 'cookie') return true;
  return scopeAllows(principal.tokenScopes, permission);
}

/**
 * What a PERSON holds before any credential narrowing — the AUTHORITY half of principalCan.
 *
 *   - `permissions` ABSENT (undefined): the role's column of PERMISSIONS (`can`), exactly as
 *     before the authority seam existed. Every role-only app takes this arm on every request.
 *   - `permissions` a Set: that set, and nothing else. It REPLACES the role — a key missing from
 *     it is denied even when the role grants it, and a key in it is held even when the role does
 *     not. The hook decided it for this request (src/auth/authority.ts); the role is bookkeeping.
 *   - anything else (null, an array, a plain object — a hand cast or plain JavaScript): NOTHING.
 *     Only an absent field falls back to the role, the same rule scopeAllows applies to a bearer
 *     principal's `tokenScopes`: the permissive reading is reserved for the one explicit shape.
 */
function personHolds(principal: PersonPrincipal, permission: PermissionKey): boolean {
  const authoritative: unknown = principal.permissions;
  if (authoritative === undefined) return can(principal.role, permission);
  return authoritative instanceof Set && authoritative.has(permission);
}

/**
 * The machine-route gate on its own: may `principal` so much as be considered for a MACHINE route
 * (RouteSpec.machine)? Only a principal whose `kind` is exactly `'service'`. Every other value —
 * `'person'`, no kind at all, or a kind this code has never heard of — is refused (fail closed).
 *
 * It asks about KIND only; the key and the transport stay principalCan's question. It is its own
 * function, pinned by its own test, so that the gate never leans on principalCan staying strict:
 * written as "refuse persons", it would let through any future kind principalCan admits (an agent
 * acting for a person, say), and a test through principalMayCall alone could not tell.
 */
export function machineGateAdmits(principal: Principal): boolean {
  return principal.kind === 'service';
}

/**
 * May `principal` call a route gated by `permission`? The route-level form of principalCan, used
 * by executeRoute and the MCP tool list. Two differences from principalCan:
 *
 *   - The `'authenticated'` gate (any active principal, no key) admits every PERSON, and NO
 *     service. Those routes are identity surfaces for people (GET /api/me), and a route that skips
 *     the key check is exactly where a service could otherwise act beyond its one scope — so a
 *     machine caller never reaches one.
 *   - A MACHINE route (`route.machine`, RouteSpec.machine) admits ONLY a service principal, and
 *     that service still needs principalCan for the route's key. A person — any role, on a session
 *     or on a personal token — is refused, and so is a principal of any other or no `kind` (fail
 *     closed; machineGateAdmits). The two rules together mean no route admits both a person
 *     without a key check and a machine; defineRoute refuses the combinations that would admit
 *     nobody.
 */
export function principalMayCall(
  principal: Principal,
  permission: PermissionKey | 'authenticated',
  route: { readonly machine?: boolean } = {},
): boolean {
  if (route.machine === true && !machineGateAdmits(principal)) return false;
  if (permission === 'authenticated') return principal.kind === 'person';
  return principalCan(principal, permission);
}

/**
 * Did a person's AUTHORITATIVE set withhold `permission`? True only when the app's authority hook
 * decided the set for this request and the key is not in it — not when the set holds the key and
 * a bearer ceiling or the non-delegable set denied it (the CREDENTIAL denied it then), and never for
 * a role-only person, a service, or the `'authenticated'` gate. What executeRoute's
 * `route_permission_denied` line keys on, so its `source: 'authority'` names the right one.
 */
export function authorityWithholds(
  principal: Principal,
  permission: PermissionKey | 'authenticated',
): boolean {
  if (principal.kind !== 'person' || principal.permissions === undefined) return false;
  if (permission === 'authenticated') return false;
  return !personHolds(principal, permission);
}

/** Every permission key `principal` holds right now (for GET /api/me and the MCP tool list). */
export function effectivePermissions(principal: Principal): PermissionKey[] {
  return (Object.keys(PERMISSIONS) as PermissionKey[]).filter((key) =>
    principalCan(principal, key),
  );
}

/** Anything gated by a route permission: a RouteSpec, an MCP tool, an agent tool. */
export interface PermissionGated {
  readonly permission: PermissionKey | 'authenticated';
  /** A MACHINE route's item (RouteSpec.machine): offered only to a service, never a person. */
  readonly machine?: boolean;
}

/**
 * THE OFFER FILTER: the items `principal` may call, by exactly the check executeRoute enforces
 * (principalMayCall). Whatever the surface — the MCP tool list (toolsForPrincipal), the agent's
 * tool list — an item the caller's authority withholds is never OFFERED, so a model is never shown
 * a tool every call to which would 404. That includes a person's AUTHORITATIVE set (an ACL grant):
 * a key the authority withholds is not offered even when the person's role holds it.
 *
 * One function for every list, on purpose: two filters are two rules, and the day they drift an
 * agent is offered what the HTTP surface refuses (or the reverse). The executeRoute re-check on
 * every call stays the security boundary; this is what keeps the offer honest.
 */
export function callableBy<T extends PermissionGated>(
  principal: Principal,
  items: readonly T[],
): T[] {
  return items.filter((item) =>
    principalMayCall(principal, item.permission, { machine: item.machine === true }),
  );
}

/**
 * What `role` may put into a NEW token's scopes: its permissions minus the non-delegable set.
 * Today that excludes every agent key (`agent.use` and `agent.erase` are non-delegable). A future
 * delegable agent key would be included when the role holds it — asking for it by name is the one
 * way a token gets one (the default snapshot at mint leaves the family out; src/auth/tokens.ts).
 */
export function grantableScopes(role: Role): PermissionKey[] {
  return (Object.keys(PERMISSIONS) as PermissionKey[]).filter(
    (key) => can(role, key) && !NON_DELEGABLE.has(key),
  );
}

/**
 * What `principal` may DELEGATE — put into a token it mints, or give a service identity it
 * creates: what the person's AUTHORITY holds (personHolds: the role, or the authoritative set that
 * replaces it), minus the non-delegable set. With no authoritative set this is exactly
 * `grantableScopes(principal.role)`, whatever the credential. With one, it is that set's keys
 * instead, so a delegated credential never carries a key the minter's authority withholds — even
 * though its role (bookkeeping, in such an app) would grant it. The minters
 * (src/auth/tokens.ts, src/auth/serviceIdentities.ts) use this, never the bare role.
 *
 * It answers for the PERSON, not the credential: refusing a minter that is not on a session is the
 * minters' own wall (sessionMinter, actorOf), checked before this ceiling is ever read.
 */
export function grantableScopesFor(principal: PersonPrincipal): PermissionKey[] {
  return (Object.keys(PERMISSIONS) as PermissionKey[]).filter(
    (key) => personHolds(principal, key) && !NON_DELEGABLE.has(key),
  );
}

/**
 * Role-hierarchy guard for user management: owners manage everyone; admins manage
 * members/viewers only (never owners or other admins). Nobody manages themselves
 * through this path — self-demotion and last-owner protection are checked in the
 * route with a live DB count. A `null` actor (a service principal) manages nobody.
 */
export function canManageRole(actor: Role | null, target: Role): boolean {
  if (actor === 'owner') return true;
  if (actor === 'admin') return target === 'member' || target === 'viewer';
  return false;
}
