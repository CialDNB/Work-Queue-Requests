// Pre-issued bearer tokens: `t_` + 40 hex chars, shown once, stored as SHA-256.
// The format is shared kit-wide so MCP clients and scripts work identically against
// any kit app.
//
// PIA C8 — token hardening — is enforced HERE and in executeRoute, never in src/routes/: routes
// are fork-owned and do not travel with /kit-upgrade, so a rule that lived in the route would
// never reach a fork. What lives in this file:
//   - resolution: a token resolves to a Principal carrying its stored scopes, so principalCan()
//     can narrow the role (src/auth/permissions.ts); corrupt scopes, schema drift, or a refusal
//     by the fork's policy hook all resolve to NO principal (401), never to the full role;
//   - minting: mintApiToken() (a token for the signed-in caller) and mintApiTokenFor() (a token
//     owned by another account, e.g. a service identity an admin issues for) are the only
//     sanctioned mint paths. Both refuse a bearer caller, cap the requested scopes at what may be
//     delegated, and always set an expiry (the data layer clamps it to TOKEN_MAX_TTL_DAYS, or to
//     SERVICE_TOKEN_MAX_TTL_DAYS for a service identity's token).
//
// SERVICE PRINCIPALS. A token whose owner is in the reserved `.invalid` namespace
// (src/auth/serviceNamespace.ts) is a SERVICE token, full stop: it resolves only through a live
// `service_identities` row, never through `users` — so a person row carrying such an address (a
// pre-upgrade or hand-inserted one) can never lend a machine token a role. The resolver sets
// `kind`; nothing the request carries can.
import { type ApiTokenRow, type Db, makeDb, type UserRow } from '../data';
import { ServiceIdentitySchemaDriftError } from '../data/serviceIdentities';
import { ApiTokenSchemaDriftError } from '../data/tokens';
import type { Env } from '../env';
import { AppError, badRequest, notFound } from '../framework/errors';
import { logEvent } from '../platform/logEvent';
import { refuseTokenFor } from '../routes/tokenPolicy';
import { applyAuthority, FORK_AUTHORITY } from './authority';
import {
  grantableScopes,
  grantableScopesFor,
  isAgentScope,
  isServiceGrantable,
  type PermissionKey,
  principalCan,
} from './permissions';
import { isReservedIdentifier } from './serviceNamespace';
import type {
  AuthorityPolicy,
  PersonBearerPrincipal,
  PersonCookiePrincipal,
  PersonPrincipal,
  Principal,
  Role,
  ServicePrincipal,
  TokenRefusalCheck,
} from './types';

export function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, chars);
}

export function mintToken(): string {
  return `t_${randomHex(40)}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// last_used_at is a coarse "recently active" signal, not an access log — refresh it at
// most once per window so a busy bearer client (an MCP loop, a polling script) doesn't
// incur a D1 write on every request. The check uses the row already loaded by
// findActiveByHash, so a fresh token costs ZERO extra round-trips.
const LAST_USED_REFRESH_MS = 15 * 60 * 1000;

function lastUsedIsStale(lastUsedAt: string | null): boolean {
  if (!lastUsedAt) return true;
  // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC, space-separated, no zone).
  const t = Date.parse(`${lastUsedAt.replace(' ', 'T')}Z`);
  return Number.isNaN(t) || Date.now() - t >= LAST_USED_REFRESH_MS;
}

// Token events go through logEvent with fixed keys (KIT_LOG_EVENTS), so a log query can count them
// and nothing else rides along: never an email, a token, a prefix or a hash — the row id is enough
// to find the token for an owner/admin with D1 access.

const MAX_SCOPE_KEY_LENGTH = 64;
const MAX_SCOPES = 64;

/**
 * Parse a stored `api_tokens.scopes` value. `{ scopes: null }` is a legacy unscoped token;
 * `{ scopes: [...] }` an explicit ceiling; `null` means the value is CORRUPT (not a JSON array of
 * short strings) and the caller must fail closed — a corrupt ceiling is never read as "no
 * ceiling". The schema's CHECK already rejects non-arrays; this is the second wall.
 */
export function parseTokenScopes(raw: string | null): { scopes: readonly string[] | null } | null {
  if (raw === null) return { scopes: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > MAX_SCOPES ||
    !parsed.every((k) => typeof k === 'string' && k.length > 0 && k.length <= MAX_SCOPE_KEY_LENGTH)
  ) {
    return null;
  }
  return { scopes: parsed as string[] };
}

const REASON_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

// Run the fork's refusal hook. Returns the (sanitized) reason to refuse, or null to allow. A hook
// that throws REFUSES: a broken policy check must not become an open door.
async function refusalReason(
  refuse: TokenRefusalCheck,
  principal: PersonBearerPrincipal,
  context: { env: Env; user: UserRow },
): Promise<string | null> {
  let reason: string | null;
  try {
    reason = await refuse(principal, context);
  } catch (err) {
    logEvent('api_token_refusal_hook_failed', { err });
    return 'policy_error';
  }
  // `== null`: a JavaScript hook that returns nothing allows, exactly like one returning null.
  if (reason == null) return null;
  return REASON_RE.test(reason) ? reason : 'unspecified';
}

export async function resolveApiToken(
  env: Env,
  token: string,
  authority: AuthorityPolicy = FORK_AUTHORITY,
  request: Request | null = null,
): Promise<Principal | null> {
  if (!token.startsWith('t_')) return null;
  return resolveApiTokenByHash(env, await sha256Hex(token), refuseTokenFor, authority, request);
}

// Resolve a live Principal from a token's SHA-256 hash. The MCP adapter stores only this hash
// in its (persistent) session props and re-resolves on every tool call — so a token revoked, or
// a user disabled/role-changed, mid-session takes effect within one call, exactly as the HTTP
// path re-resolves on every request. Storing the hash rather than the plaintext keeps the
// credential-at-rest posture the rest of the kit holds (magic_links, api_tokens, sessions).
//
// A PERSON's token then passes the app's AUTHORITY hook (src/routes/authorityPolicy.ts — the role,
// an authoritative set that replaces it, or a refusal), and only then the fork's refusal hook,
// which therefore sees the principal the request would run as. A service token passes neither.
//
// `refuse` and `authority` default to the fork's hooks (src/routes/tokenPolicy.ts, and
// src/routes/authorityPolicy.ts as FORK_AUTHORITY); they are parameters only so tests can drive
// them without module mocking. `request` is the HTTP request when there is one, `null` for the MCP adapter's
// per-call re-resolution — it is handed to the authority hook, nothing else reads it.
export async function resolveApiTokenByHash(
  env: Env,
  tokenHash: string,
  refuse: TokenRefusalCheck = refuseTokenFor,
  authority: AuthorityPolicy = FORK_AUTHORITY,
  request: Request | null = null,
): Promise<Principal | null> {
  const db = makeDb(env);
  let row: ApiTokenRow | null;
  try {
    row = await db.tokens.findActiveByHash(tokenHash);
  } catch (err) {
    // Schema drift: the data layer already logged `api_token_schema_drift` with the remedy. The
    // token is refused — the one outcome that is never acceptable here is the full role.
    if (err instanceof ApiTokenSchemaDriftError) return null;
    throw err;
  }
  if (!row) return null;

  const parsed = parseTokenScopes(row.scopes);
  if (!parsed) {
    logEvent('api_token_scopes_invalid', { token_id: row.id });
    return null;
  }

  if (isReservedIdentifier(row.email)) {
    let service: ServicePrincipal | null;
    try {
      service = await resolveServicePrincipal(db, row, parsed.scopes);
    } catch (err) {
      // Migration 0004 not applied: the data layer already logged `service_identities_schema_drift`
      // with the remedy. Refused (401), exactly like the C8 drift above — never a 500.
      if (err instanceof ServiceIdentitySchemaDriftError) return null;
      throw err;
    }
    if (service && lastUsedIsStale(row.last_used_at)) await db.tokens.touchLastUsed(row.id);
    return service;
  }

  // Live user check: revoking a person revokes every credential they hold.
  const user = await db.users.getActive(row.email);
  if (!user) return null;

  const resolved: PersonBearerPrincipal = {
    kind: 'person',
    email: user.email,
    name: user.name,
    role: user.role,
    authMethod: 'api_token',
    // Presented as an Authorization header (or a hash the MCP adapter re-resolves from
    // one) — a deliberate per-request credential, so the CSRF check does not apply.
    credentialTransport: 'bearer',
    tokenScopes: parsed.scopes,
  };

  // The authority decides what the PERSON holds; the token's scopes then narrow that
  // (principalCan). A refusal here is logged by applyAuthority and is a 401, like any other.
  const principal = await applyAuthority(authority, resolved, {
    env,
    user,
    session: null,
    request,
  });
  if (!principal) return null;

  const reason = await refusalReason(refuse, principal, { env, user });
  if (reason !== null) {
    logEvent('api_token_refused', { reason });
    return null;
  }

  if (lastUsedIsStale(row.last_used_at)) await db.tokens.touchLastUsed(row.id);
  return principal;
}

/**
 * A SERVICE token's principal, or null (refused, logged as `api_token_refused` with a fixed reason,
 * the token id and the identity id — never an address). Every condition is read LIVE, per
 * request, from the one row getByPrincipalId returns:
 *   - the identity exists                    else `service_identity_missing`;
 *   - it is not disabled (the kill switch)   else `service_identity_disabled`;
 *   - its custodian is an ACTIVE user        else `service_custodian_inactive` — fail closed: a
 *     machine nobody is accountable for stops, loudly (the daily digest names it), rather than
 *     running on for up to a year;
 *   - its scope is still service-grantable   else `service_scope_not_grantable` (a later kit or
 *     fork change made the key non-delegable, or removed it);
 *   - the token's own ceiling includes that scope, else `service_scope_mismatch`. A token minted
 *     through mintApiTokenFor carries exactly [scope]; a wider or legacy (NULL) ceiling — a
 *     pre-upgrade machine user's token that a fork ADOPTED with a reviewed data step (the kit's own
 *     create revokes such tokens: src/data/serviceIdentities.ts) — is accepted but can still
 *     exercise only the identity's one scope (principalCan reads `service.scope`, never the token's).
 */
async function resolveServicePrincipal(
  db: Pick<Db, 'serviceIdentities'>,
  row: ApiTokenRow,
  tokenScopes: readonly string[] | null,
): Promise<ServicePrincipal | null> {
  const identity = await db.serviceIdentities.getByPrincipalId(row.email);
  const refuse = (reason: string): null => {
    logEvent('api_token_refused', {
      reason,
      token_id: row.id,
      ...(identity ? { service_identity_id: identity.id } : {}),
    });
    return null;
  };
  if (!identity) return refuse('service_identity_missing');
  if (identity.disabled_at !== null) return refuse('service_identity_disabled');
  if (!identity.custodian_active) return refuse('service_custodian_inactive');
  if (!isServiceGrantable(identity.scope)) return refuse('service_scope_not_grantable');
  if (tokenScopes !== null && !tokenScopes.includes(identity.scope)) {
    return refuse('service_scope_mismatch');
  }
  return {
    kind: 'service',
    email: identity.principal_id,
    name: identity.name,
    role: null,
    authMethod: 'api_token',
    credentialTransport: 'bearer',
    service: {
      id: identity.id,
      slug: identity.slug,
      scope: identity.scope,
      custodianEmail: identity.custodian_email,
    },
  };
}

/**
 * The scopes a NEW token minted by `minter` gets — a Role, or the minting PERSON itself. Omitted →
 * a SNAPSHOT of everything the minter may delegate today, minus the agent family: explicit, so a
 * later promotion of the user never widens an existing token (the live role still narrows it on
 * demotion — principalCan intersects both). Given → exactly those keys, each of which must be
 * delegable by the minter; anything else is a 400 naming the offending keys, never a silent drop.
 *
 * Given a person, "may delegate" is what that person's authority holds (grantableScopesFor): the
 * role — or, where the app's authority hook set an AUTHORITATIVE set, that set instead — so a
 * token never snapshots a key the minter's authority withholds. mintApiToken passes the person.
 */
export function resolveMintScopes(
  minter: Role | PersonPrincipal,
  requested?: readonly string[],
): PermissionKey[] {
  const grantable =
    typeof minter === 'string' ? grantableScopes(minter) : grantableScopesFor(minter);
  return scopesWithin(grantable, requested, 'your role');
}

// The rule above over an explicit ceiling (`grantable`): the snapshot when nothing is asked for,
// else the asked-for keys, validated against it, deduped and sorted.
function scopesWithin(
  grantable: readonly PermissionKey[],
  requested: readonly string[] | undefined,
  grantor: string,
): PermissionKey[] {
  if (requested === undefined) return grantable.filter((key) => !isAgentScope(key));
  const unique = [...new Set(requested)];
  const refused = unique.filter((key) => !(grantable as readonly string[]).includes(key));
  if (refused.length > 0) {
    throw badRequest(`scopes: not grantable by ${grantor}: ${refused.sort().join(', ')}`);
  }
  return (unique as PermissionKey[]).sort();
}

export interface MintTokenInput {
  name: string;
  /** Days until expiry; absent → TOKEN_MAX_TTL_DAYS, longer → clamped to it (src/data/tokens.ts). */
  expiresInDays?: number;
  /** Permission keys the token may exercise; absent → the delegable snapshot. */
  scopes?: readonly string[];
}

async function insertToken(
  db: Pick<Db, 'tokens'>,
  ownerEmail: string,
  input: MintTokenInput,
  scopes: readonly PermissionKey[],
): Promise<{ token: string; row: ApiTokenRow }> {
  const token = mintToken();
  const row = await db.tokens.create({
    email: ownerEmail,
    name: input.name,
    tokenHash: await sha256Hex(token),
    prefix: token.slice(0, 10),
    scopes,
    expiresInDays: input.expiresInDays,
  });
  if (!row) throw new Error('token insert readback failed');
  return { token, row };
}

/**
 * The minter, if it may mint at all: a PERSON signed in with a session cookie. Anything else — a
 * bearer token (a person's or a service's) — is the uniform 404. executeRoute already refuses a
 * bearer caller on `tokens.self` (NON_DELEGABLE); this is the second wall, for a route that mints
 * under some other permission key: a token must never be able to mint a token.
 */
function sessionMinter(principal: Principal): PersonCookiePrincipal {
  if (principal.kind !== 'person' || principal.credentialTransport !== 'cookie') throw notFound();
  return principal;
}

/**
 * Mint a token for `principal`. One of the TWO sanctioned mint paths (mintApiTokenFor below is
 * the other) — a fork route calling `db.tokens.create` directly skips the scope ceiling (and,
 * since `scopes` is required there, has to spell out what it grants). Returns the plaintext
 * exactly once. A caller that is not a person on a session is refused with the uniform 404.
 */
export async function mintApiToken(
  db: Pick<Db, 'tokens'>,
  principal: Principal,
  input: MintTokenInput,
): Promise<{ token: string; row: ApiTokenRow }> {
  const minter = sessionMinter(principal);
  return insertToken(db, minter.email, input, resolveMintScopes(minter, input.scopes));
}

/**
 * Mint a token OWNED BY another account, on the authority of the signed-in `minter` — the
 * admin-issued case. Two kinds of owner:
 *
 * A SERVICE IDENTITY (`ownerEmail` in the reserved `.invalid` namespace — the kit's service
 * identity routes, src/auth/serviceIdentityRoutes.ts): the token carries exactly the identity's
 * one scope, and lives 90 days by default, up to 365 (the data layer's service cap).
 *   - a bearer minter, a minter whose role lacks `serviceIdentities.manage` (only an owner/admin
 *     issues a machine credential, whatever route calls this), or an identifier with no identity
 *     row, is the uniform 404 — the permission is checked before the identity is looked up;
 *   - the identity's custodian must be an active user (409 `custodian_inactive`) — a token for an
 *     unaccountable machine would be refused at resolution anyway, so say so at mint;
 *   - its scope must still be service-grantable (409 `scope_not_grantable`) and one the MINTER may
 *     delegate (400; grantableScopesFor) — rotating a token never hands out more than the rotator
 *     holds;
 *   - `scopes`, if given, must be exactly `[identity.scope]` (400) — a service token cannot be
 *     narrowed to nothing or widened to anything.
 *   Minting for a DISABLED identity is allowed on purpose: the token is inert until the identity
 *   is re-enabled — the incident flow (disable, revoke, mint the replacement, hand it over,
 *   re-enable; docs/runbooks/service-identities.md).
 *
 * A PERSON's account (anything else): the token then acts as its OWNER, like any token: the
 * owner's live role ∩ its scopes, minus the non-delegable set. The route decides WHO may issue for
 * WHOM (its permission key, canManageRole, whatever the app needs); this decides what the token
 * may carry:
 *   - a bearer minter is refused with the uniform 404, as in mintApiToken;
 *   - the owner is read LIVE and must be an active user, else the uniform 404 — a role the caller
 *     hands in is never trusted;
 *   - the ceiling is what BOTH may delegate: the owner's role, and what the MINTER's authority
 *     holds (grantableScopesFor — its role, or the authoritative set that replaces it). Issuing
 *     a token for a more privileged account must never hand the minter a key they could not have
 *     delegated themselves; without this, an admin could mint an owner's token and act with the
 *     owner's role. The app's authority hook is not consulted for the OWNER at mint (the owner is
 *     not the caller); it runs each time the token RESOLVES, and what the token then holds is what
 *     the hook answers for a bearer there — a set (which the scopes narrow), a refusal, or `null`,
 *     which leaves it on the owner's role. In an app that declares its authority external, that
 *     last case can never start an agent run (authorityRefusesAgentRun).
 * Scopes default to the snapshot of that shared ceiling (minus the agent family); asked-for keys
 * outside it are a 400 naming them. Expiry is clamped exactly as for any token.
 */
export async function mintApiTokenFor(
  db: Pick<Db, 'tokens' | 'users' | 'serviceIdentities'>,
  minter: Principal,
  ownerEmail: string,
  input: MintTokenInput,
): Promise<{ token: string; row: ApiTokenRow }> {
  const issuer = sessionMinter(minter);
  if (isReservedIdentifier(ownerEmail)) return mintServiceToken(db, issuer, ownerEmail, input);
  const owner = await db.users.getActive(ownerEmail);
  if (!owner) throw notFound();
  const minterMay = new Set<string>(grantableScopesFor(issuer));
  const ceiling = grantableScopes(owner.role).filter((key) => minterMay.has(key));
  const scopes = scopesWithin(ceiling, input.scopes, "both the owner's role and yours");
  return insertToken(db, owner.email, input, scopes);
}

// The service half of mintApiTokenFor — see its doc comment for every rule.
async function mintServiceToken(
  db: Pick<Db, 'tokens' | 'serviceIdentities'>,
  issuer: PersonPrincipal,
  principalId: string,
  input: MintTokenInput,
): Promise<{ token: string; row: ApiTokenRow }> {
  if (!principalCan(issuer, 'serviceIdentities.manage')) throw notFound();
  const identity = await db.serviceIdentities.getByPrincipalId(principalId);
  if (!identity) throw notFound();
  if (!identity.custodian_active) {
    throw new AppError(
      409,
      'custodian_inactive',
      'The custodian of this service identity is not an active user; assign an active custodian first',
    );
  }
  if (!isServiceGrantable(identity.scope)) {
    throw new AppError(
      409,
      'scope_not_grantable',
      `This service identity's scope (${identity.scope}) can no longer be held by a service; create a new identity`,
    );
  }
  if (!(grantableScopesFor(issuer) as readonly string[]).includes(identity.scope)) {
    throw badRequest(`scopes: not grantable by your role: ${identity.scope}`);
  }
  if (input.scopes !== undefined) {
    const asked = [...new Set(input.scopes)];
    if (asked.length !== 1 || asked[0] !== identity.scope) {
      throw badRequest(
        `scopes: a service identity's token carries exactly its identity's scope (${identity.scope})`,
      );
    }
  }
  return insertToken(db, identity.principal_id, input, [identity.scope as PermissionKey]);
}
