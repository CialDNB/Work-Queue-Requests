import { z } from 'zod';
import { effectivePermissions } from '../auth/permissions';
import { defineRoute } from '../framework/defineRoute';

export const meRoutes = [
  defineRoute({
    method: 'GET',
    path: '/api/me',
    permission: 'authenticated',
    summary: 'Who am I + which permissions I hold on this request (drives SPA gating)',
    input: z.object({}),
    handler: async (ctx) => ({
      email: ctx.principal.email,
      name: ctx.principal.name,
      role: ctx.principal.role,
      auth_method: ctx.principal.authMethod,
      // EFFECTIVE permissions: the role's for a session; for a bearer token, the role ∩ the
      // token's scopes minus the non-delegable set — exactly what executeRoute will allow.
      permissions: effectivePermissions(ctx.principal),
    }),
  }),
];
