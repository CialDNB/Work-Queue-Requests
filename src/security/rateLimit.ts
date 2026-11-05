// Coarse KV-windowed rate limiter for abuse ceilings (NOT precise accounting — KV
// increments race, which is fine for "stop a runaway loop" limits). For spend-shaped
// limits use the atomic D1 budget ledger in src/ai/budget.ts instead.
import type { Env } from '../env';

export interface RateResult {
  ok: boolean;
  retryAfterSec: number;
}

export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const kvKey = `rl:${key}:${windowStart}`;
  const current = Number((await env.SESSIONS.get(kvKey)) ?? '0');
  if (current >= limit) {
    return { ok: false, retryAfterSec: windowStart + windowSec - now };
  }
  await env.SESSIONS.put(kvKey, String(current + 1), { expirationTtl: windowSec * 2 });
  return { ok: true, retryAfterSec: 0 };
}
