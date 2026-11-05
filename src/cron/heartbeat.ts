import { makeDb } from '../data';
import type { Env } from '../env';
import type { CronTaskResult } from './index';

/**
 * Records that the daily loop ran: KV key for /_health staleness math, plus an
 * append-only audit row carrying per-task results for forensics.
 */
export async function writeHeartbeat(env: Env, results: CronTaskResult[]): Promise<void> {
  await env.SESSIONS.put('heartbeat:last', new Date().toISOString());
  await makeDb(env).audit.insert({
    actor_email: 'system@cron',
    action: 'cron_heartbeat_done',
    payload_json: JSON.stringify({ results }),
  });
}

/**
 * Hours since the daily loop last wrote its heartbeat, or null when there is none or it does not
 * parse. Throws when KV does: the caller decides what an unreadable heartbeat means.
 */
export async function heartbeatAgeHours(env: Env): Promise<number | null> {
  const last = await env.SESSIONS.get('heartbeat:last');
  const at = last ? Date.parse(last) : Number.NaN;
  return Number.isFinite(at) ? (Date.now() - at) / 3_600_000 : null;
}

/** The fallback's claim on the daily loop. Not `heartbeat:last`, which /_health reads. */
export const FALLBACK_CLAIM_KEY = 'heartbeat:fallback_claim';

/**
 * Claim the daily loop for the unrecognized-trigger fallback, BEFORE the loop is dispatched: true
 * when this tick took the claim, false when an earlier fallback tick still holds it. The heartbeat
 * is written only when the loop ends, so without a claim every tick until then (or every tick, if
 * the loop dies first: a CPU limit, a failed heartbeat put) starts another loop. The claim expires
 * after `ttlHours`. Throws when KV does. KV has no compare-and-set, and a write can take up to
 * about 60 s to reach other locations: two ticks that close together, in different locations, can
 * both take it.
 */
export async function claimDailyLoopFallback(env: Env, ttlHours: number): Promise<boolean> {
  if ((await env.SESSIONS.get(FALLBACK_CLAIM_KEY)) !== null) return false;
  await env.SESSIONS.put(FALLBACK_CLAIM_KEY, new Date().toISOString(), {
    expirationTtl: ttlHours * 3600,
  });
  return true;
}
