// User administration. Hierarchy rules live in canManageRole(); last-owner and
// self-modification protections are checked here against the live table.
import { z } from 'zod';
import { isAllowedDomain } from '../auth/magicLink';
import { canManageRole } from '../auth/permissions';
import { noticeCustodianDisabled } from '../auth/serviceIdentities';
import { isReservedIdentifier } from '../auth/serviceNamespace';
import { revokeAllSessions } from '../auth/sessions';
import type { Db } from '../data';
import { defineRoute } from '../framework/defineRoute';
import { ok } from '../framework/envelope';
import { AppError, conflict, notFound } from '../framework/errors';

const roleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);

const userFixture = {
  seed: async (db: Db) => {
    const email = `fixture-${crypto.randomUUID()}@test.example`;
    await db.users.add({
      email,
      name: 'Synthetic Fixture',
      role: 'member',
      addedBy: 'fixture@test.example',
    });
    return { email };
  },
};

export const usersRoutes = [
  defineRoute({
    method: 'GET',
    path: '/api/users',
    permission: 'users.read',
    summary: 'List users (the invite allowlist), oldest first, keyset-paginated',
    input: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().optional(),
    }),
    handler: async (ctx, input) => {
      const page = await ctx.db.users.list(input);
      return { users: page.items, next_cursor: page.next_cursor };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/users',
    permission: 'users.manage',
    audit: 'user.invite',
    summary: 'Invite a user (adds them to the allowlist so magic links work)',
    input: z.object({
      email: z.email().max(254),
      name: z.string().max(200).optional(),
      role: roleSchema.default('member'),
    }),
    handler: async (ctx, input) => {
      // Admins may not mint owners/admins — uniform 404, like any other denial.
      if (!canManageRole(ctx.principal.role, input.role)) throw notFound();
      // `.invalid` is the reserved service namespace: never a person (src/data/users.ts refuses it
      // too). Service identities are created under Settings → Service identities.
      if (isReservedIdentifier(input.email)) {
        throw new AppError(
          400,
          'reserved_address',
          'Addresses under .invalid are reserved for service identities; create one under Service identities',
        );
      }
      if (!isAllowedDomain(ctx.env, input.email.toLowerCase())) {
        throw new AppError(
          400,
          'domain_not_allowed',
          'Email domain is not in ALLOWED_EMAIL_DOMAINS',
        );
      }
      const created = await ctx.db.users.add({
        email: input.email,
        name: input.name ?? null,
        role: input.role,
        addedBy: ctx.principal.email,
      });
      if (!created) throw conflict('User already exists');
      ctx.setAuditTarget(created.email, { role: created.role });
      return ok(created, 201);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/users/:email',
    permission: 'users.manage',
    audit: 'user.update',
    summary: 'Change role and/or disable/re-enable a user',
    input: z.object({
      email: z.string().min(3).max(254),
      role: roleSchema.optional(),
      disabled: z.boolean().optional(),
    }),
    uniformityFixture: userFixture,
    handler: async (ctx, input) => {
      const target = await ctx.db.users.get(input.email);
      if (!target) throw notFound();
      if (!canManageRole(ctx.principal.role, target.role)) throw notFound();
      if (target.email === ctx.principal.email) {
        throw conflict('You cannot modify your own access; use another owner/admin account');
      }

      if (input.role && input.role !== target.role) {
        if (!canManageRole(ctx.principal.role, input.role)) throw notFound();
        if (target.role === 'owner' && (await ctx.db.users.countActiveOwners()) <= 1) {
          throw conflict('Cannot demote the last active owner');
        }
        await ctx.db.users.setRole(target.email, input.role);
      }

      // Service identities this person answered for that stop working now (fail-closed custodian
      // rule): alerted at once, and counted in the audit row.
      let orphaned = 0;
      if (typeof input.disabled === 'boolean') {
        if (
          input.disabled &&
          target.role === 'owner' &&
          (await ctx.db.users.countActiveOwners()) <= 1
        ) {
          throw conflict('Cannot disable the last active owner');
        }
        await ctx.db.users.setDisabled(target.email, input.disabled);
        if (input.disabled) {
          await revokeAllSessions(ctx.env, target.email);
          if (target.disabled_at === null) {
            orphaned = await noticeCustodianDisabled(ctx.db, ctx.env, target.email, ctx.waitUntil);
          }
        }
      }

      ctx.setAuditTarget(target.email, {
        role: input.role,
        disabled: input.disabled,
        ...(orphaned > 0 ? { orphaned_service_identities: orphaned } : {}),
      });
      return ctx.db.users.get(target.email);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/users/:email/revoke-sessions',
    permission: 'users.manage',
    audit: 'user.revoke_sessions',
    summary:
      'Force-logout: invalidate every session the user holds (effective within ~60s at every location)',
    input: z.object({ email: z.string().min(3).max(254) }),
    uniformityFixture: userFixture,
    handler: async (ctx, input) => {
      const target = await ctx.db.users.get(input.email);
      if (!target) throw notFound();
      if (!canManageRole(ctx.principal.role, target.role)) throw notFound();
      await revokeAllSessions(ctx.env, target.email);
      ctx.setAuditTarget(target.email);
      return { revoked: true };
    },
  }),
];
