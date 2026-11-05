// Personal bearer tokens (t_*) for programmatic/MCP access. Plaintext is returned
// exactly once at creation; afterwards only the prefix identifies it.
//
// Every route here is `tokens.self`, which is NON-DELEGABLE (src/auth/permissions.ts): a bearer
// token cannot list, mint or revoke tokens — it gets the uniform 404, enforced in executeRoute.
// Minting goes through mintApiToken (src/auth/tokens.ts), which owns the scope ceiling and the
// expiry, so neither rule depends on this fork-owned file.
import { z } from 'zod';
import { mintApiToken, parseTokenScopes } from '../auth/tokens';
import type { ApiTokenRow } from '../data';
import { TOKEN_MAX_TTL_DAYS } from '../data/tokens';
import { defineRoute } from '../framework/defineRoute';
import { ok } from '../framework/envelope';
import { notFound } from '../framework/errors';

function masked(row: ApiTokenRow) {
  const parsed = parseTokenScopes(row.scopes);
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    // null = a legacy unscoped token (every role permission except the agent family, minus the
    // non-delegable set). A corrupt value reads as [] — such a token is refused at resolution.
    scopes: parsed ? parsed.scopes : [],
  };
}

export const tokensRoutes = [
  defineRoute({
    method: 'GET',
    path: '/api/tokens',
    permission: 'tokens.self',
    summary: 'List your own API tokens (masked)',
    input: z.object({}),
    handler: async (ctx) => ({
      tokens: (await ctx.db.tokens.listForUser(ctx.principal.email)).map(masked),
    }),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/tokens',
    permission: 'tokens.self',
    audit: 'token.create',
    summary: 'Create a token — the plaintext appears in this response only',
    input: z.object({
      name: z.string().min(1).max(100),
      // Optional; absent → the maximum. Every token expires (src/data/tokens.ts).
      expires_in_days: z.coerce.number().int().min(1).max(TOKEN_MAX_TTL_DAYS).optional(),
      // Optional; absent → everything your role may delegate today. Each key must be one your
      // role holds and not in the non-delegable set, or the request is a 400.
      scopes: z.array(z.string().min(1).max(64)).max(64).optional(),
    }),
    handler: async (ctx, input) => {
      const { token, row } = await mintApiToken(ctx.db, ctx.principal, {
        name: input.name,
        expiresInDays: input.expires_in_days,
        scopes: input.scopes,
      });
      const view = masked(row);
      // Content-free: the token's name and the permission keys it carries, never the secret.
      ctx.setAuditTarget(row.prefix, { name: row.name, scopes: view.scopes });
      return ok({ token, ...view }, 201);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/tokens/:id',
    permission: 'tokens.self',
    audit: 'token.revoke',
    summary: 'Revoke one of your tokens',
    input: z.object({ id: z.coerce.number().int().positive() }),
    uniformityFixture: {
      seed: async (db) => {
        const row = await db.tokens.create({
          email: 'fixture@test.example',
          name: 'synthetic fixture token',
          tokenHash: crypto.randomUUID() + crypto.randomUUID(),
          prefix: 't_fixture0',
          scopes: [],
        });
        return { id: String(row?.id ?? 0) };
      },
    },
    handler: async (ctx, input) => {
      // Scoped revoke: someone else's token id behaves exactly like a missing one.
      const revoked = await ctx.db.tokens.revoke(input.id, ctx.principal.email);
      if (!revoked) throw notFound();
      ctx.setAuditTarget(String(input.id));
      return new Response(null, { status: 204 });
    },
  }),
];
