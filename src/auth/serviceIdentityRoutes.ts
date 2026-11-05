// SERVICE IDENTITY MANAGEMENT — the kit-owned HTTP surface over src/auth/serviceIdentities.ts.
//
// WHY THESE ROUTES LIVE IN src/auth/ AND NOT src/routes/. src/routes/ is fork-owned: /kit-upgrade
// never overwrites it, so a fix to a route there reaches a fork only as a hand-copied CHANGELOG
// step. These routes GRANT machine credentials — the one surface where a missed fix is a security
// bug, not a cosmetic one — so they live in the protected core, travel with /kit-upgrade, and are
// CODEOWNERS-gated like the rules they call. What stays fork-owned is the one line that serves them:
// `...serviceIdentityRoutes` in src/routes/index.ts (the registry the uniformity tripwire walks).
// PIA C8 set the pattern this follows — rules in the core, thin routes — and takes it one step
// further for a kit-owned admin surface.
//
// Every route is `serviceIdentities.manage`: owner/admin, and NON-DELEGABLE, so only a person on a
// session reaches one — a bearer token (a person's or a service's) gets the uniform 404 from
// executeRoute before any input is read. Every :param route has a uniformityFixture; a malformed
// id is an identity that does not exist (404), never a 400 that would say which spellings exist.
import { z } from 'zod';
import type { ApiTokenRow, Db, ServiceIdentityListRow } from '../data';
import { SERVICE_TOKEN_MAX_TTL_DAYS } from '../data/tokens';
import { defineRoute } from '../framework/defineRoute';
import { ok } from '../framework/envelope';
import { isServiceGrantable } from './permissions';
import {
  createServiceIdentity,
  loadServiceIdentity,
  mintServiceIdentityToken,
  revokeAllServiceIdentityTokens,
  revokeServiceIdentityToken,
  serviceScopesFor,
  updateServiceIdentity,
} from './serviceIdentities';
import { parseTokenScopes } from './tokens';

// The one spelling of a positive id: decimal digits, no sign, no leading zero, at most 15 digits
// (inside Number's exact range). z.coerce.number() would also read '0x1f', '1e1', ' 7', '07' —
// other names for a real row on a path. Anything else is null, which loadServiceIdentity renders
// as the uniform 404.
const POSITIVE_DECIMAL = /^[1-9]\d{0,14}$/;

export function idFrom(raw: string): number | null {
  return POSITIVE_DECIMAL.test(raw) ? Number(raw) : null;
}

type Status = 'active' | 'disabled' | 'custodian_inactive' | 'scope_not_grantable';

/**
 * What an owner/admin sees of an identity. `status` says whether its tokens work right now, and
 * if not, the FIRST reason the resolver refuses them (src/auth/tokens.ts, same order): the kill
 * switch, then the custodian, then a scope no service may hold any more (a later kit or app change
 * made the key non-delegable, or removed it — the identity must be replaced, not repaired).
 */
export function presentServiceIdentity(row: ServiceIdentityListRow) {
  const status: Status = row.disabled_at
    ? 'disabled'
    : !row.custodian_active
      ? 'custodian_inactive'
      : !isServiceGrantable(row.scope)
        ? 'scope_not_grantable'
        : 'active';
  return {
    id: row.id,
    slug: row.slug,
    identifier: row.principal_id,
    name: row.name,
    scope: row.scope,
    custodian_email: row.custodian_email,
    custodian_active: row.custodian_active,
    status,
    disabled_at: row.disabled_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    live_tokens: row.live_tokens,
    next_expiry: row.next_expiry,
    last_used_at: row.last_used_at,
  };
}

/** A token as the list shows it: prefix and dates, never the hash. */
function maskedToken(row: ApiTokenRow) {
  const parsed = parseTokenScopes(row.scopes);
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    scopes: parsed ? parsed.scopes : [],
  };
}

const slugInput = z.string().trim().toLowerCase().min(1).max(64);
const nameInput = z.string().trim().min(1).max(200);
const emailInput = z.string().trim().toLowerCase().min(3).max(254);

// Seeds a real identity (and its synthetic custodian) for the 404-uniformity tripwire.
async function seedIdentity(db: Db): Promise<ServiceIdentityListRow> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const custodian = `fixture-custodian-${suffix}@test.example`;
  await db.users.add({ email: custodian, role: 'member', addedBy: 'fixture@test.example' });
  const res = await db.serviceIdentities.create({
    slug: `fx-${suffix}`,
    principalId: `svc-fx-${suffix}@fixture.invalid`,
    name: 'Synthetic fixture integration',
    scope: 'notes.read',
    custodianEmail: custodian,
    createdBy: 'fixture@test.example',
  });
  const row = res.ok ? await db.serviceIdentities.getListRow(res.row.id) : null;
  if (!row) throw new Error('service identity fixture failed');
  return row;
}

const identityFixture = {
  seed: async (db: Db) => ({ id: String((await seedIdentity(db)).id) }),
};

const identityTokenFixture = {
  seed: async (db: Db) => {
    const identity = await seedIdentity(db);
    const token = await db.tokens.create({
      email: identity.principal_id,
      name: 'synthetic fixture token',
      tokenHash: crypto.randomUUID() + crypto.randomUUID(),
      prefix: 't_fixture0',
      scopes: [identity.scope],
    });
    return { id: String(identity.id), tokenId: String(token?.id ?? 0) };
  },
};

export const serviceIdentityRoutes = [
  defineRoute({
    method: 'GET',
    path: '/api/service-identities',
    permission: 'serviceIdentities.manage',
    needs: ['serviceIdentities'],
    summary:
      'List service identities (machine principals) with custodian, status and a live-token summary',
    input: z.object({}),
    handler: async (ctx) => ({
      service_identities: (await ctx.db.serviceIdentities.list()).map(presentServiceIdentity),
      // The keys this caller may give a NEW identity — what the admin page's picker offers.
      grantable_scopes: serviceScopesFor(ctx.principal),
    }),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/service-identities',
    permission: 'serviceIdentities.manage',
    needs: ['serviceIdentities'],
    audit: 'service_identity.create',
    summary:
      'Create a service identity: svc-<slug>@<app>.invalid, ONE permission key, an accountable custodian',
    input: z.object({
      slug: slugInput,
      name: nameInput,
      scope: z.string().min(1).max(64),
      custodian_email: emailInput,
    }),
    handler: async (ctx, input) => {
      const { identity, revokedTokens } = await createServiceIdentity(
        ctx.db,
        ctx.env,
        ctx.principal,
        {
          slug: input.slug,
          name: input.name,
          scope: input.scope,
          custodianEmail: input.custodian_email,
        },
      );
      ctx.setAuditTarget(identity.principal_id, {
        service_identity_id: identity.id,
        scope: identity.scope,
        custodian_email: identity.custodian_email,
        // Tokens already stored under the identifier (a pre-upgrade machine user's), revoked by
        // the create: a new identity never inherits — or revives — a credential.
        ...(revokedTokens > 0 ? { revoked_preexisting_tokens: revokedTokens } : {}),
      });
      return ok(presentServiceIdentity(identity), 201);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/service-identities/:id',
    permission: 'serviceIdentities.manage',
    needs: ['serviceIdentities'],
    audit: 'service_identity.update',
    summary: 'Rename, hand to a new custodian, or disable / re-enable a service identity',
    // Every body field optional, so an empty body is a valid, existence-checkable request.
    input: z.object({
      id: z.string(),
      name: nameInput.optional(),
      custodian_email: emailInput.optional(),
      disabled: z.boolean().optional(),
    }),
    uniformityFixture: identityFixture,
    handler: async (ctx, input) => {
      const { identity, changed } = await updateServiceIdentity(
        ctx.db,
        ctx.principal,
        idFrom(input.id),
        { name: input.name, custodianEmail: input.custodian_email, disabled: input.disabled },
      );
      ctx.setAuditTarget(identity.principal_id, { service_identity_id: identity.id, ...changed });
      return presentServiceIdentity(identity);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/service-identities/:id/tokens',
    permission: 'serviceIdentities.manage',
    needs: ['serviceIdentities', 'tokens'],
    summary: "List a service identity's tokens (masked: prefix and dates, never the hash)",
    input: z.object({ id: z.string() }),
    uniformityFixture: identityFixture,
    handler: async (ctx, input) => {
      const identity = await loadServiceIdentity(ctx.db, idFrom(input.id));
      return { tokens: (await ctx.db.tokens.listForUser(identity.principal_id)).map(maskedToken) };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/service-identities/:id/tokens',
    permission: 'serviceIdentities.manage',
    needs: ['serviceIdentities', 'tokens', 'users'],
    audit: 'token.create',
    summary:
      'Mint (or rotate in) a token for a service identity — the plaintext appears in this response only',
    input: z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(100).optional(),
      // 90 when absent; a service token may live up to 365 days (src/data/tokens.ts).
      expires_in_days: z.number().int().min(1).max(SERVICE_TOKEN_MAX_TTL_DAYS).optional(),
    }),
    uniformityFixture: identityFixture,
    handler: async (ctx, input) => {
      const { identity, token, row } = await mintServiceIdentityToken(
        ctx.db,
        ctx.principal,
        idFrom(input.id),
        { name: input.name, expiresInDays: input.expires_in_days },
      );
      const view = maskedToken(row);
      // Content-free: the token's name, owner and scope — never the secret. Same action as a
      // personal mint, so the audit-anomaly digest counts it; `owner` tells them apart.
      ctx.setAuditTarget(row.prefix, {
        name: row.name,
        owner: identity.principal_id,
        service_identity_id: identity.id,
        scopes: view.scopes,
        expires_at: row.expires_at,
      });
      return ok({ token, ...view }, 201);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/service-identities/:id/tokens/:tokenId',
    permission: 'serviceIdentities.manage',
    needs: ['serviceIdentities', 'tokens'],
    audit: 'token.revoke',
    summary: "Revoke one of a service identity's tokens (the last step of a rotation)",
    input: z.object({ id: z.string(), tokenId: z.string() }),
    uniformityFixture: identityTokenFixture,
    handler: async (ctx, input) => {
      const tokenId = idFrom(input.tokenId);
      const identity = await revokeServiceIdentityToken(
        ctx.db,
        ctx.principal,
        idFrom(input.id),
        tokenId,
      );
      ctx.setAuditTarget(String(tokenId), {
        owner: identity.principal_id,
        service_identity_id: identity.id,
      });
      return new Response(null, { status: 204 });
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/service-identities/:id/revoke-tokens',
    permission: 'serviceIdentities.manage',
    needs: ['serviceIdentities', 'tokens'],
    audit: 'service_identity.revoke_tokens',
    summary: 'Incident switch: revoke EVERY token a service identity holds',
    input: z.object({ id: z.string() }),
    uniformityFixture: identityFixture,
    handler: async (ctx, input) => {
      const { identity, revoked } = await revokeAllServiceIdentityTokens(
        ctx.db,
        ctx.principal,
        idFrom(input.id),
      );
      ctx.setAuditTarget(identity.principal_id, { service_identity_id: identity.id, revoked });
      return { revoked };
    },
  }),
];
