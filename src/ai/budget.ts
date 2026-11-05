// Budget gates (D11): per-call ceiling + per-user and global daily caps, checked
// BEFORE the model call via atomic reservation, reconciled to actual cost after.
// Defaults (env-overridable; 0 disables a gate): $0.50/call, $5/user/day, $50/day.
import { makeDb } from '../data';
import type { Env } from '../env';

export interface BudgetCaps {
  maxCallUsd: number;
  dailyUserCapUsd: number;
  dailyGlobalCapUsd: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function capsFromEnv(env: Env): BudgetCaps {
  return {
    maxCallUsd: num(env.AI_MAX_CALL_USD, 0.5),
    dailyUserCapUsd: num(env.AI_DAILY_USER_CAP_USD, 5),
    dailyGlobalCapUsd: num(env.AI_DAILY_GLOBAL_CAP_USD, 50),
  };
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export type GateRefusal = 'per_call_cap' | 'user_daily_cap' | 'global_daily_cap';

export type ReserveResult =
  | { ok: true; day: string; reservedUsd: number }
  | { ok: false; reason: GateRefusal };

export async function reserveBudget(
  env: Env,
  email: string,
  estimateUsd: number,
): Promise<ReserveResult> {
  const caps = capsFromEnv(env);
  if (caps.maxCallUsd > 0 && estimateUsd > caps.maxCallUsd) {
    return { ok: false, reason: 'per_call_cap' };
  }

  const repo = makeDb(env).aiBudget;
  const day = todayUtc();
  const userScope = `u:${email.toLowerCase()}`;

  if (caps.dailyUserCapUsd > 0) {
    const okUser = await repo.tryReserve(userScope, day, estimateUsd, caps.dailyUserCapUsd);
    if (!okUser) return { ok: false, reason: 'user_daily_cap' };
  }
  if (caps.dailyGlobalCapUsd > 0) {
    const okGlobal = await repo.tryReserve('g', day, estimateUsd, caps.dailyGlobalCapUsd);
    if (!okGlobal) {
      // Roll back the user reservation so a refused call doesn't burn their budget.
      if (caps.dailyUserCapUsd > 0) await repo.adjust(userScope, day, -estimateUsd);
      return { ok: false, reason: 'global_daily_cap' };
    }
  }
  return { ok: true, day, reservedUsd: estimateUsd };
}

// RESIDUAL (documented, accepted): reserve→reconcile is not crash-atomic. If the isolate
// dies after reserveBudget() but before reconcileBudget() runs (model call throws and even
// the catch-path reconcile is lost), the reservation stays booked and over-counts that
// scope's spend for the rest of the UTC day. It is conservative (it can only REFUSE later
// calls, never overspend), self-heals at the UTC day rollover (the day key changes), and the
// stale row is pruned after 7 days (src/cron/prune.ts). There is deliberately no intra-day
// sweeper — the failure is rare and fail-safe. "Atomic" here means the per-row reserve/adjust,
// not crash durability across the pair.
/** Settle the reservation against actual cost and append the usage row. */
export async function reconcileBudget(
  env: Env,
  email: string,
  day: string,
  reservedUsd: number,
  actual: { model: string; inputTokens: number; outputTokens: number; costUsd: number } | null,
): Promise<void> {
  const repo = makeDb(env).aiBudget;
  const actualUsd = actual?.costUsd ?? 0;
  const delta = actualUsd - reservedUsd;
  const userScope = `u:${email.toLowerCase()}`;
  await repo.adjust(userScope, day, delta);
  await repo.adjust('g', day, delta);
  if (actual) {
    await repo.insertUsage({
      email,
      model: actual.model,
      inputTokens: actual.inputTokens,
      outputTokens: actual.outputTokens,
      costUsd: actual.costUsd,
    });
  }
}
