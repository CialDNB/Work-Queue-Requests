// Minimal AI endpoint proving the plumbing end-to-end: permission gate → budget
// reservation → gateway call → usage ledger → audit. Replace the prompt shape with
// your app's real AI features; keep the structure.
import { z } from 'zod';
import { callAnthropic } from '../ai/anthropic';
import { defineRoute } from '../framework/defineRoute';

export const aiRoutes = [
  defineRoute({
    method: 'POST',
    path: '/api/ai/complete',
    permission: 'ai.use',
    // The framework writes the single `ai.call` row; the handler names its target + payload
    // (model + tokens + cost) via setAuditTarget below, so it's one rich row — no double-count.
    audit: 'ai.call',
    // Per-user abuse ceiling: the dollar budget caps SPEND, this caps REQUEST RATE so one
    // user can't drain the shared per-app-day budget (or hammer the gateway) for everyone
    // else — availability, not cost. Tune per app; generous for interactive use.
    rateLimit: { limit: 30, windowSec: 60 },
    summary: 'One-shot completion via AI Gateway with budget gates',
    input: z.object({
      prompt: z.string().min(1).max(20_000),
      system: z.string().max(10_000).optional(),
      max_tokens: z.coerce.number().int().min(1).max(8192).default(1024),
    }),
    handler: async (ctx, input) => {
      const result = await callAnthropic(ctx.env, ctx.principal.email, {
        system: input.system,
        messages: [{ role: 'user', content: input.prompt }],
        maxTokens: input.max_tokens,
      });
      ctx.setAuditTarget(result.model, {
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cost_usd: result.costUsd,
      });
      return { text: result.text, model: result.model, cost_usd: result.costUsd };
    },
  }),
];
