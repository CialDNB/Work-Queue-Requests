// SERVICE IDENTITIES — the management rules. A service identity is a machine principal (an ETL, an
// integration): not a user, never able to sign in, authenticated only by bearer tokens, holding
// exactly ONE permission key, and accountable to a named human custodian. The table and its
// storage rules are src/data/serviceIdentities.ts; how one resolves and what it may do is
// src/auth/tokens.ts and src/auth/permissions.ts. This file is what an owner/admin may do to one;
// the HTTP surface over it is src/auth/serviceIdentityRoutes.ts.
//
// Every operation here re-checks that the actor is a PERSON on a SESSION whose role holds
// `serviceIdentities.manage` (actorOf) — the uniform 404 otherwise. executeRoute already refuses
// anyone else on the kit's routes (the key is owner/admin and non-delegable); this is the second
// wall, for any other caller of these functions (a fork route that forgets the key, a script), and
// it holds the PERMISSION, not just the transport: a member on a session is refused here too.
//
// GRANTS versus REDUCTIONS. Creating an identity, minting its token, and REVIVING it — re-enabling
// it, or handing an orphaned one to a new custodian, so that refused tokens work again — GRANT
// authority, so each is capped at what the actor may delegate (mayGrantServiceScope): its role, or
// the authoritative set that replaces the role where the app's authority hook set one —
// nobody can bring into being, or back to life, a machine holding a key they could not have put
// into a token themselves. In the kit owner and admin hold the same keys, so the cap bites in forks
// whose roles differ. Disabling, revoking, renaming, and changing the custodian of a working
// identity only take away or re-assign accountability, so any owner/admin may do them.
import { sendViaAlertSeam } from '../cron/alert';
import type { ApiTokenRow, Db, ServiceIdentityListRow } from '../data';
import { custodianDisabledEmail } from '../email/templates';
import type { Env } from '../env';
import { AppError, badRequest, conflict, notFound } from '../framework/errors';
import { logEvent } from '../platform/logEvent';
import {
  grantableScopesFor,
  isServiceGrantable,
  type PermissionKey,
  principalCan,
} from './permissions';
import { isReservedIdentifier, isValidServiceSlug, serviceIdentifierFor } from './serviceNamespace';
import { type MintTokenInput, mintApiTokenFor } from './tokens';
import type { PersonCookiePrincipal, PersonPrincipal, Principal } from './types';

/**
 * The actor, if it may manage service identities at all: a person, on a session, whose role holds
 * `serviceIdentities.manage`. Anyone else — a bearer token, a service, a member — gets the 404.
 */
function actorOf(principal: Principal): PersonCookiePrincipal {
  if (
    principal.kind !== 'person' ||
    principal.credentialTransport !== 'cookie' ||
    !principalCan(principal, 'serviceIdentities.manage')
  ) {
    throw notFound();
  }
  return principal;
}

/**
 * The keys `principal` may give a NEW service identity: service-grantable (not non-delegable, not
 * the agent family) AND delegable by the actor — what it holds on this request (its role, or the
 * authoritative set that replaces the role where the app's authority hook set one;
 * grantableScopesFor). What the admin page offers.
 */
export function serviceScopesFor(principal: Principal): PermissionKey[] {
  if (principal.kind !== 'person') return [];
  return grantableScopesFor(principal).filter(isServiceGrantable);
}

/** May `actor` GRANT `scope` to a machine — create an identity with it, mint for it, or revive it? */
export function mayGrantServiceScope(actor: PersonPrincipal, scope: string): boolean {
  return (serviceScopesFor(actor) as readonly string[]).includes(scope);
}

/**
 * Does a change bring a REFUSED identity back to a working one — the other way to grant a machine
 * authority? True when, before the change, the identity is disabled or its custodian is inactive,
 * and after it, it is enabled with an active custodian (a `custodianChanged` names an ACTIVE person
 * — the repository refuses anything else) and its scope is one a service may hold at all (if not,
 * its tokens stay refused whatever changes, so nothing is granted).
 */
export function revivesServiceIdentity(
  current: { disabled_at: string | null; custodian_active: boolean; scope: string },
  change: { disabled?: boolean; custodianChanged: boolean },
): boolean {
  const workingBefore = current.disabled_at === null && current.custodian_active;
  const enabledAfter =
    change.disabled === undefined ? current.disabled_at === null : !change.disabled;
  const custodianAfter = change.custodianChanged || current.custodian_active;
  return !workingBefore && enabledAfter && custodianAfter && isServiceGrantable(current.scope);
}

function custodianInactive(): AppError {
  return new AppError(
    400,
    'custodian_inactive',
    'custodian_email must be an active user of this app (a person, not a service identity)',
  );
}

export interface CreateServiceIdentityInput {
  slug: string;
  name: string;
  scope: string;
  custodianEmail: string;
}

/**
 * Create an identity: `svc-<slug>@<app>.invalid`, holding `scope`, accountable to
 * `custodianEmail`. 400 for a slug off the rule, a scope a service may never hold or the actor may
 * not delegate, or a custodian who is not an active person; 409 when the slug was ever used.
 *
 * A new identity starts with NO working credential: any token already stored under its identifier
 * (a pre-upgrade machine user's) is revoked in the same write, and `revokedTokens` says how many —
 * the route puts it in the audit row. Mint the identity's own token afterwards.
 */
export async function createServiceIdentity(
  db: Pick<Db, 'serviceIdentities'>,
  env: Pick<Env, 'APP_NAME'>,
  principal: Principal,
  input: CreateServiceIdentityInput,
): Promise<{ identity: ServiceIdentityListRow; revokedTokens: number }> {
  const actor = actorOf(principal);
  if (!isValidServiceSlug(input.slug)) {
    throw badRequest(
      'slug: lowercase letters and digits in hyphen-separated words, starting with a letter, 2-40 characters',
    );
  }
  if (!isServiceGrantable(input.scope)) {
    throw badRequest(
      `scope: ${input.scope} can never be held by a service identity (unknown, non-delegable, or reserved)`,
    );
  }
  if (!mayGrantServiceScope(actor, input.scope)) {
    throw badRequest(`scope: not grantable by your role: ${input.scope}`);
  }
  if (isReservedIdentifier(input.custodianEmail)) throw custodianInactive();
  const res = await db.serviceIdentities.create({
    slug: input.slug,
    principalId: serviceIdentifierFor(input.slug, env.APP_NAME),
    name: input.name,
    scope: input.scope,
    custodianEmail: input.custodianEmail,
    createdBy: actor.email,
  });
  if (!res.ok) {
    if (res.reason === 'taken') {
      throw conflict('A service identity with this slug exists (slugs are never reused)');
    }
    throw custodianInactive();
  }
  const view = await db.serviceIdentities.getListRow(res.row.id);
  if (!view) throw new Error('service identity readback failed');
  return { identity: view, revokedTokens: res.revokedTokens };
}

/** The identity a path names, or the uniform 404 — a malformed id is an identity that does not exist. */
export async function loadServiceIdentity(
  db: Pick<Db, 'serviceIdentities'>,
  id: number | null,
): Promise<ServiceIdentityListRow> {
  const row = id === null ? null : await db.serviceIdentities.getListRow(id);
  if (!row) throw notFound();
  return row;
}

export interface UpdateServiceIdentityInput {
  name?: string;
  custodianEmail?: string;
  disabled?: boolean;
}

/**
 * Change what may change: the display name, the custodian (an ACTIVE person, else 400 and nothing
 * is applied — it is checked first), and the kill switch. Slug, identifier and scope are fixed by
 * the schema; a different scope is a different identity. A change that REVIVES the identity
 * (revivesServiceIdentity) is a grant: 400 unless the actor may grant its scope, checked before
 * anything is written. Returns the identity after the change and what actually changed (for the
 * audit payload).
 */
export async function updateServiceIdentity(
  db: Pick<Db, 'serviceIdentities'>,
  principal: Principal,
  id: number | null,
  input: UpdateServiceIdentityInput,
): Promise<{ identity: ServiceIdentityListRow; changed: Record<string, unknown> }> {
  const actor = actorOf(principal);
  const current = await loadServiceIdentity(db, id);
  const changed: Record<string, unknown> = {};
  const custodian = input.custodianEmail?.toLowerCase();
  // Naming the current custodian again is a no-op only while that person is still active; naming
  // an inactive one — the same or another — is the 400, so a leaver can never be re-confirmed.
  const setsCustodian =
    custodian !== undefined && !(custodian === current.custodian_email && current.custodian_active);
  if (
    revivesServiceIdentity(current, {
      disabled: input.disabled,
      custodianChanged: setsCustodian,
    }) &&
    !mayGrantServiceScope(actor, current.scope)
  ) {
    throw badRequest(`scope: not grantable by your role: ${current.scope}`);
  }
  if (custodian !== undefined && setsCustodian) {
    if (isReservedIdentifier(custodian)) throw custodianInactive();
    if (!(await db.serviceIdentities.setCustodian(current.id, custodian, actor.email))) {
      throw custodianInactive();
    }
    if (custodian !== current.custodian_email) changed.custodian_email = custodian;
  }
  if (input.name !== undefined && input.name !== current.name) {
    await db.serviceIdentities.rename(current.id, input.name, actor.email);
    changed.name = input.name;
  }
  if (input.disabled !== undefined) {
    if (await db.serviceIdentities.setDisabled(current.id, input.disabled, actor.email)) {
      changed.disabled = input.disabled;
    }
  }
  return { identity: await loadServiceIdentity(db, current.id), changed };
}

/**
 * Mint a token for the identity — the first one, or a rotation's replacement (mint the new one,
 * deploy it, then revoke the old: the two overlap on purpose). Goes through mintApiTokenFor, the
 * one sanctioned path, which fixes the scope and the lifetime.
 */
export async function mintServiceIdentityToken(
  db: Pick<Db, 'serviceIdentities' | 'tokens' | 'users'>,
  principal: Principal,
  id: number | null,
  input: Pick<MintTokenInput, 'expiresInDays'> & { name?: string },
): Promise<{ identity: ServiceIdentityListRow; token: string; row: ApiTokenRow }> {
  actorOf(principal);
  const identity = await loadServiceIdentity(db, id);
  const { token, row } = await mintApiTokenFor(db, principal, identity.principal_id, {
    name: input.name ?? `${identity.slug} token`,
    expiresInDays: input.expiresInDays,
  });
  return { identity, token, row };
}

/** Revoke ONE of the identity's tokens. Another owner's token id is a missing one (404). */
export async function revokeServiceIdentityToken(
  db: Pick<Db, 'serviceIdentities' | 'tokens'>,
  principal: Principal,
  id: number | null,
  tokenId: number | null,
): Promise<ServiceIdentityListRow> {
  actorOf(principal);
  const identity = await loadServiceIdentity(db, id);
  if (tokenId === null || !(await db.tokens.revoke(tokenId, identity.principal_id))) {
    throw notFound();
  }
  return identity;
}

/** The incident switch: revoke EVERY live token the identity holds. Returns how many. */
export async function revokeAllServiceIdentityTokens(
  db: Pick<Db, 'serviceIdentities' | 'tokens'>,
  principal: Principal,
  id: number | null,
): Promise<{ identity: ServiceIdentityListRow; revoked: number }> {
  actorOf(principal);
  const identity = await loadServiceIdentity(db, id);
  return { identity, revoked: await db.tokens.revokeAllForOwner(identity.principal_id) };
}

/** Slack text for the custodian-disabled alert: the COUNT only — no identity, identifier or person. */
export function custodianDisabledSlackText(appName: string, appEnv: string, count: number): string {
  return `[${appName}/${appEnv}] A user who was custodian of ${count} service identit${count === 1 ? 'y' : 'ies'} was disabled — ${count === 1 ? 'its' : 'their'} tokens are now refused. Hand ${count === 1 ? 'it' : 'them'} to a new custodian: see the alert email and docs/runbooks/service-identities.md.`;
}

/**
 * A person was just DISABLED. If they are the custodian of enabled identities that hold live
 * tokens, every one of those tokens is refused from the next request (the fail-closed custodian
 * rule) — so say so NOW, not at the next daily digest: an alert through the alert seam (the email
 * names each identity; Slack gets the count), scheduled on `waitUntil` so the disable does not
 * wait on mail. Returns how many identities stopped, for the caller's audit row.
 *
 * Call it from wherever the app disables people: the kit's PATCH /api/users does; a fork that also
 * disables users elsewhere (an ACL sync) should too — otherwise the daily digest is its only
 * signal. NEVER THROWS: a failed lookup (0004 not applied) or a broken scheduler is logged and
 * counts as nothing, because it must never undo or fail the disable itself.
 */
export async function noticeCustodianDisabled(
  db: Pick<Db, 'serviceIdentities'>,
  env: Env,
  custodianEmail: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<number> {
  let stopped: ServiceIdentityListRow[];
  try {
    stopped = await db.serviceIdentities.listLiveByCustodian(custodianEmail);
  } catch (err) {
    logEvent('custodian_disabled_notice_failed', { err });
    return 0;
  }
  if (stopped.length === 0) return 0;
  const alert = sendViaAlertSeam(
    env,
    'custodian_disabled',
    custodianDisabledEmail(
      env.APP_NAME,
      env.APP_ENV,
      custodianEmail.toLowerCase(),
      stopped.map((o) => ({
        identity: o.name,
        identifier: o.principal_id,
        custodian: o.custodian_email,
        liveTokens: o.live_tokens,
        lastUsedAt: o.last_used_at,
      })),
    ),
    custodianDisabledSlackText(env.APP_NAME, env.APP_ENV, stopped.length),
  ).catch(() => logEvent('custodian_disabled_alert_failed'));
  try {
    waitUntil(alert);
  } catch {
    logEvent('custodian_disabled_schedule_failed');
  }
  return stopped.length;
}
