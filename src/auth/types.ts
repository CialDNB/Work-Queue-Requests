import type { UserRow } from '../data/users';
import type { Env } from '../env';
import type { PermissionKey } from './permissions';
import type { SessionData } from './sessions';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export type AuthMethod = 'magic_link' | 'entra_oidc' | 'api_token';

/**
 * How the credential arrived on THIS request: 'cookie' (session cookie — a browser
 * ambient credential the CSRF check must cover) or 'bearer' (Authorization header —
 * attached deliberately per request, so cross-site forgery cannot ride it). This is a
 * transport fact derived at the resolvePrincipal branch point, never stored: a session
 * is always presented as a cookie, a t_* token always as a bearer header. An agent turn
 * (resolveRunPrincipal) has no request of its own and is 'cookie': its grant is the session
 * the person presented as a cookie to start it. It exists so
 * transport-level defenses (CSRF) key on transport — not on `authMethod`, which is an
 * identity-provenance label a future session minter could set to anything.
 */
export type CredentialTransport = 'cookie' | 'bearer';

/**
 * WHAT the caller is — a fact about the IDENTITY, never about how the credential arrived. Set by
 * the resolvers in src/auth (resolvePrincipal's cookie branch, resolveApiTokenByHash, and
 * resolveRunPrincipal for an agent turn's stored session), never from anything the request
 * carries:
 *   'person'   a row in `users` — a human who signs in (magic link / Entra) and may also hold
 *              personal bearer tokens;
 *   'service'  a row in `service_identities` — a machine principal (an ETL, an integration). It is
 *              NOT a user, can never sign in or hold a session, and authenticates only with a
 *              bearer token an owner/admin minted for it (src/auth/serviceIdentities.ts).
 */
export type PrincipalKind = 'person' | 'service';

interface PrincipalBase {
  /**
   * The ATTRIBUTION identifier: what `audit_log.actor_email`, `read_log.principal`, the per-route
   * rate-limit bucket and the AI budget are keyed on. A person's lowercased email; a service's
   * reserved identifier `svc-<slug>@<app>.invalid` (src/auth/serviceNamespace.ts) — NEVER its
   * custodian's email, so a machine's actions are never attributed to a person.
   */
  readonly email: string;
  readonly name: string | null;
  readonly authMethod: AuthMethod;
  readonly credentialTransport: CredentialTransport;
}

/**
 * A human caller. INVARIANT (carried from Arena): authorization must NEVER branch on
 * `authMethod` — it exists for audit and session policy only. Permissions come from `role`
 * (and app-level group logic), or — in an app whose authority hook decides them — from the
 * AUTHORITATIVE set in `permissions`, which then replaces the role. Magic links today and Entra
 * SSO tomorrow mint the exact same Principal; swapping auth methods changes nothing else. The
 * CSRF check branches on `credentialTransport` (a transport fact), NOT on `authMethod` — so a
 * session minted with a wrong/novel authMethod value can never silently exempt cookie mutations
 * from CSRF.
 *
 * A bearer credential only ever NARROWS what the person holds (PIA C8): `principalCan()` in
 * src/auth/permissions.ts intersects the role (or the authoritative set) with the token's scopes
 * and removes the non-delegable set. That branch keys on `credentialTransport` too — never on
 * `authMethod`.
 *
 * A union keyed on `credentialTransport`, so the type carries that rule: a person bearer
 * principal MUST state its token's ceiling (`tokenScopes`), and a Principal literal without it
 * does not compile. A resolver that forgot to carry the stored scopes would otherwise build one
 * that principalCan() can only refuse outright (see PersonBearerPrincipal).
 */
export type PersonPrincipal = PersonCookiePrincipal | PersonBearerPrincipal;

interface PersonIdentity extends PrincipalBase {
  readonly kind: 'person';
  readonly role: Role;
  /**
   * The AUTHORITATIVE permission set: present only when the app's authority hook (`authorityFor`
   * in src/routes/authorityPolicy.ts) decided it for this request — an external authority such as
   * a CIAL ACL grant. When present it REPLACES the role's column of PERMISSIONS in principalCan: a
   * key absent from it is denied, and `role` is NOT consulted as a second chance (a stale local
   * role must never widen what the authority granted). A bearer credential still narrows it —
   * the token's scopes and the non-delegable set apply exactly as they do to a role.
   *
   * Absent (undefined) → the role decides, exactly as before this field existed. Any other value
   * that is not a Set (a hand cast, plain JavaScript) holds NOTHING — only an absent field falls
   * back to the role.
   *
   * Set ONLY by the resolvers in src/auth (resolvePrincipal, resolveApiTokenByHash, and
   * resolveRunPrincipal, which asks the hook with `request: null` before every agent round and
   * tool call) from the hook's answer — never from anything the request carries — and re-derived
   * on every resolution, so it never outlives the resolution that derived it: a request, or one
   * agent round or tool call (PIA C15: no permission snapshot).
   */
  readonly permissions?: ReadonlySet<PermissionKey>;
  /**
   * Fork-declared DATA the authority hook attached with `permissions` (PrincipalAttributes, e.g.
   * an ACL company list for a picker) — frozen, never read by any authorization check. Absent
   * whenever `permissions` is.
   */
  readonly attributes?: Readonly<PrincipalAttributes>;
}

/** A person on a session cookie: holds its role outright, and never carries a token ceiling. */
export interface PersonCookiePrincipal extends PersonIdentity {
  readonly credentialTransport: 'cookie';
  readonly tokenScopes?: undefined;
  /**
   * When the session this principal rides was minted (its stored `created_at_ms`, epoch ms). Set
   * ONLY by the session resolvers — resolvePrincipal (src/auth/index.ts) and resolveRunPrincipal
   * (src/auth/runPrincipal.ts) — from the stored session, never from anything the request
   * carries; applyAuthority's spread keeps it. A fact about the session, NOT authority: no
   * permission check reads it. Two readers:
   *   - recentlyAuthenticated (src/auth/runPrincipal.ts): "signed in within the last N minutes",
   *     the agent DSR route's step-up;
   *   - an agent turn, which stores it beside the session key so that its per-call re-resolution
   *     accepts only THAT session, never a later one under the same email.
   * Absent when the stored session has no usable timestamp (mintedAtMs, src/auth/sessions.ts);
   * both readers then fail closed.
   */
  readonly sessionCreatedAtMs?: number;
}

/**
 * A person on a bearer credential: a personal `t_*` token over HTTP, or one the MCP adapter
 * re-resolved from its hash.
 */
export interface PersonBearerPrincipal extends PersonIdentity {
  readonly credentialTransport: 'bearer';
  /**
   * The token's stored scope ceiling (`api_tokens.scopes`), REQUIRED. `null` is a legacy unscoped
   * token (every role permission except the reserved `agent` family); an array is an explicit
   * ceiling. It can never WIDEN anything: principalCan() intersects it with the live role. A
   * bearer principal that lacks it anyway (a hand cast, plain JavaScript) holds NOTHING —
   * principalCan fails closed, because only an explicit `null` is legacy.
   */
  readonly tokenScopes: readonly string[] | null;
}

/** The service identity a ServicePrincipal acts as — the `service_identities` row, as resolved. */
export interface ServiceIdentityRef {
  /** `service_identities.id`: stable, never reused. What content-free rows (authz.denied) name. */
  readonly id: number;
  /** The identity's slug — the `<slug>` in `svc-<slug>@<app>.invalid`. */
  readonly slug: string;
  /**
   * The ONE permission key this identity may exercise, fixed when it was created. A string, not a
   * PermissionKey: it is stored data, and principalCan() re-checks on every request that it is
   * still a key a service may hold (not non-delegable, not the agent family).
   */
  readonly scope: string;
  /** The accountable human: an ACTIVE user when this principal was resolved (else no principal). */
  readonly custodianEmail: string;
}

/**
 * A machine caller (a service identity). It has NO role — `role` is `null`, so `can()` and
 * `canManageRole()` answer false for it — and its whole authority is `service.scope`, one
 * permission key (principalCan). Always a bearer token: no resolver produces a service principal
 * from a cookie, and principalCan refuses one that claims any other transport.
 */
export interface ServicePrincipal extends PrincipalBase {
  readonly kind: 'service';
  readonly role: null;
  readonly authMethod: 'api_token';
  readonly credentialTransport: 'bearer';
  readonly service: ServiceIdentityRef;
  /** Never set: a service's ceiling is `service.scope`, not a token's stored scopes. */
  readonly tokenScopes?: undefined;
  /**
   * Never set: the authority hook runs for PERSONS only, and a service's whole authority is
   * `service.scope`. principalCan ignores this field on a service even if a cast sets it.
   */
  readonly permissions?: undefined;
  /** Never set, for the same reason. */
  readonly attributes?: undefined;
}

/**
 * The authenticated caller: a person or a service, told apart by `kind`; a person is further told
 * apart by `credentialTransport`. Narrow on `kind` before reading person-only fields (`role` as a
 * Role, `tokenScopes`) or service-only ones (`service`). Every variant is shaped so both
 * invariants hold at compile time: a person bearer principal carries `tokenScopes`, a cookie
 * principal and a service principal never do, and a service principal is only ever `bearer`.
 */
export type Principal = PersonPrincipal | ServicePrincipal;

/** The transport-keyed names PIA C8 introduced, kept for fork code that already uses them. */
export type CookiePrincipal = PersonCookiePrincipal;
export type BearerPrincipal = PersonBearerPrincipal | ServicePrincipal;

/**
 * The fork-owned token refusal hook (`refuseTokenFor` in src/routes/tokenPolicy.ts). Called once
 * per PERSON bearer resolution, AFTER the token and the live user have been found and the app's
 * authority hook has answered (so `principal.permissions` is set when that hook set it), and
 * BEFORE the Principal is returned. Return a short reason CODE (e.g. `'acl_user_no_grant_snapshot'`) to
 * refuse — the request is then unauthenticated (401) and the kit logs `api_token_refused` with
 * that code — or `null` to allow. A reason is a fixed identifier, never an email or other data:
 * anything outside `[A-Za-z0-9_.:-]{1,64}` is logged as `unspecified`. A hook that throws refuses.
 *
 * Service principals do not pass through it: they have no `users` row to hand it, and their
 * refusal policy (disabled identity, inactive custodian, scope) is the kit's own, in
 * src/auth/tokens.ts.
 */
export type TokenRefusalCheck = (
  principal: PersonBearerPrincipal,
  context: { readonly env: Env; readonly user: UserRow },
) => string | null | Promise<string | null>;

/**
 * Fork-declared DATA the authority hook may attach alongside an authoritative set — what the
 * authority returned that the app's own routes want on the same request (insights: the ACL company
 * list its picker renders), so the request does not pay for the upstream call twice.
 *
 * DATA, NEVER AUTHORITY: principalCan and every other kit check ignore it. A fork names its fields
 * by augmenting this interface from a file it owns (src/routes/authorityPolicy.ts):
 *
 *   declare module '../auth/types' {
 *     interface PrincipalAttributes { readonly aclCompanies?: readonly AclCompanySummary[] }
 *   }
 *
 * and reads them as `ctx.principal.attributes?.aclCompanies` — absent and empty alike, since a
 * principal the authority did not decide (a role-only one) carries none.
 */
export interface PrincipalAttributes {
  readonly [key: string]: unknown;
}

/**
 * What the app's authority hook answers (`authorityFor` in src/routes/authorityPolicy.ts):
 *
 *   null                       no external authority for this caller: the ROLE decides. The kit
 *                              default, and every role-only app's answer on every request. Only
 *                              an explicit `null`: `undefined` (a branch with no `return`) is not
 *                              an AuthorityDecision, does not typecheck, and refuses at runtime.
 *   { permissions, attributes? }
 *                              the AUTHORITATIVE set for THIS request: it replaces the role in
 *                              principalCan (a bearer still narrows it). Keys this app's
 *                              PERMISSIONS does not define are dropped and counted in the log.
 *                              `attributes` is optional non-authoritative data (see above).
 *   { refuse: code }           no principal at all: the request is unauthenticated (401) and the
 *                              kit logs `principal_authority_refused` with the code — a fixed
 *                              identifier, never data; anything outside `[A-Za-z0-9_.:-]{1,64}` is
 *                              logged as `unspecified`.
 *
 * Anything else — `undefined`, both, neither, a non-iterable or string `permissions`, a non-string
 * key, more than 256 keys, a non-object `attributes` — REFUSES, like a hook that throws. None of it ever
 * falls back to the role: an authority that answered wrongly is not an authority that said "role".
 */
export type AuthorityDecision =
  | {
      readonly permissions: Iterable<PermissionKey>;
      readonly attributes?: PrincipalAttributes;
      readonly refuse?: undefined;
    }
  | { readonly refuse: string; readonly permissions?: undefined; readonly attributes?: undefined }
  | null;

/** What the resolver hands the authority hook alongside the principal it built. */
export interface AuthorityContext {
  readonly env: Env;
  /** The live `users` row the principal was built from — already checked active. */
  readonly user: UserRow;
  /**
   * The session the cookie resolved to — or, for an agent turn, the session its stored key resolved
   * to (resolveRunPrincipal); `null` on a bearer credential.
   */
  readonly session: SessionData | null;
  /**
   * The request being authenticated, when there is one. `null` when a principal is re-resolved
   * outside an HTTP request:
   *   - a bearer principal from a stored token hash (the MCP adapter, per tool call);
   *   - a SESSION principal from a stored session key (resolveRunPrincipal,
   *     src/auth/runPrincipal.ts) — an agent turn, every round and before every tool call. An ACL
   *     app's hook must then derive the grant from `session` alone; a hook that refuses or throws
   *     there, or whose set leaves out `agent.use`, ends the turn `revoked`.
   */
  readonly request: Request | null;
}

/**
 * The fork-owned AUTHORITY hook (`authorityFor` in src/routes/authorityPolicy.ts): where a
 * PERSON's permissions come from. Called once per person resolution — a session cookie
 * (resolvePrincipal), a personal bearer token (resolveApiTokenByHash), or an agent turn's stored
 * session (resolveRunPrincipal, with `request: null`) — after the live `users` row is found, and
 * before the refusal hook and the return. It is handed a FROZEN copy of the principal as resolved
 * (role-based, no `permissions`), and answers an AuthorityDecision.
 *
 * Called on EVERY resolution and never cached by the kit, so an authority's revocation takes
 * effect on the caller's next request (an agent turn's next round or tool call), and no permission
 * snapshot outlives the resolution that derived it (PIA C15). A hook that throws REFUSES (401; an
 * agent turn ends `revoked`), and so does one that answers anything but an AuthorityDecision.
 * Service principals never reach it: their authority is the kit's.
 */
export type AuthorityCheck = (
  principal: Readonly<PersonPrincipal>,
  context: AuthorityContext,
) => AuthorityDecision | Promise<AuthorityDecision>;

/**
 * The fork-owned EXTERNAL-AUTHORITY declaration (`authorityIsExternal` in
 * src/routes/authorityPolicy.ts): is this app's authority, on this env, an external one (an ACL)
 * rather than the role? A fact about the APP, not about one principal — answered from
 * configuration, synchronously, and the same for every caller.
 *
 * It exists because the per-principal fact cannot carry it: an ACL app's hook answers `null` for a
 * bearer token (tokens stay local authority there), so a token principal carries no set and looks
 * exactly like a role-only one. Two things read the declaration, both fail-closed:
 *   - authorityRefusesAgentRun (src/auth/authority.ts): while it is true, the in-app agent runs
 *     only for a person on a SESSION whose permissions the hook decided — never on a token, never
 *     on the role;
 *   - applyAuthority: a hook that answers a set on an env it did NOT declare external refuses (401,
 *     `principal_authority_invalid` / `undeclared_external`), so the declaration cannot silently
 *     disagree with the hook.
 * A declaration that throws, or answers anything but a boolean, counts as neither: both readers
 * refuse.
 */
export type ExternalAuthorityCheck = (env: Env) => boolean;

/**
 * The fork's authority policy as the kit consumes it: the per-resolution hook and the app-level
 * declaration, both from src/routes/authorityPolicy.ts (FORK_AUTHORITY in src/auth/authority.ts).
 * The resolvers and authorityRefusesAgentRun take it as an optional last parameter only so tests
 * can drive another policy without module mocking.
 */
export interface AuthorityPolicy {
  readonly authorityFor: AuthorityCheck;
  readonly authorityIsExternal: ExternalAuthorityCheck;
}
