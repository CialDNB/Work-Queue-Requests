// THE READ LEDGER'S OWN SURFACE (Fleet Ledger K2b). This is where "who read record X" is
// answered — inside the app that owns the data, never in the fleet registry. K1's daily report
// sends the registry COUNTS plus an `activity_url` deep link (`https://<DASHBOARD_HOST>/reads`);
// this endpoint backs that page, and the wave-3 CLI's `--app` mode queries it directly.
//
// Admin-only, and that is the whole design: the ledger records the actor of every read, so it is
// itself a concentration of exactly the access metadata the ledger exists to protect. A viewer
// who could page through it would learn which of their colleagues looked at what.
//
// Reading this endpoint is ITSELF recorded when READ_AUDIT is armed — the framework's recordDb
// proxy wraps `ctx.db` for every route, this one included. That is intentional rather than an
// oversight to work around: an admin paging through the access trail is precisely the kind of
// access a trail should carry.
import { z } from 'zod';
import { defineRoute } from '../framework/defineRoute';

export const readLogRoutes = [
  defineRoute({
    method: 'GET',
    path: '/api/read-log',
    permission: 'readLog.read',
    summary:
      'Read the read-attribution ledger (D1, private-database and upstream reads), newest first',
    needs: ['readLog'],
    // The cursor is COMPOSITE — (created_at, id) — because `created_at` has one-second precision
    // and one request routinely makes several reads inside the same second. A `created_at`-only
    // cursor silently skips the rest of a tied second, which on an audit surface is
    // under-reporting rather than a paging nicety (src/data/readLog.ts spells this out).
    //
    // Query strings cannot nest, so the two halves arrive flat and are recombined below. Both or
    // neither: a half-cursor is a client bug, and accepting it would page from a position nobody
    // asked for.
    input: z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before_created_at: z.string().min(1).max(40).optional(),
        before_id: z.string().min(1).max(100).optional(),
      })
      .refine((v) => (v.before_created_at === undefined) === (v.before_id === undefined), {
        message: 'before_created_at and before_id must be provided together',
        path: ['before_id'],
      }),
    handler: async (ctx, input) =>
      ctx.db.readLog.list({
        limit: input.limit,
        ...(input.before_created_at && input.before_id
          ? { before: { created_at: input.before_created_at, id: input.before_id } }
          : {}),
      }),
  }),
];
