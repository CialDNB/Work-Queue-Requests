import { z } from 'zod';
import { defineRoute } from '../framework/defineRoute';

export const auditRoutes = [
  defineRoute({
    method: 'GET',
    path: '/api/audit',
    permission: 'audit.read',
    summary: 'Read the append-only audit log, newest first',
    input: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      before: z.coerce.number().int().positive().optional(),
    }),
    // The repo owns the cursor logic (limit+1/hasMore), like notesRepo — it returns
    // { items, next_before } directly, so the route just forwards the page.
    handler: async (ctx, input) => ctx.db.audit.list(input),
  }),
];
