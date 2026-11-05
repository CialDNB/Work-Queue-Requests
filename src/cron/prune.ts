import { makeDb } from '../data';
import type { ReadLogPruneResult } from '../data/readLog';
import type { Env } from '../env';

/** Magic-link tokens are single-use and short-lived; drop rows 7 days past expiry. */
export async function pruneMagicLinks(env: Env): Promise<string> {
  const removed = await makeDb(env).magicLinks.pruneExpired(7);
  return `pruned ${removed} expired magic links`;
}

// audit_log and ai_usage are deliberately APPEND-ONLY (forensics + spend history that
// survives feature removal) — they are NOT pruned here. Their long-term retention is the
// daily R2 backup (+ any external archival), never in-code deletion. The only growth
// table that is safe to prune is the per-day budget ledger below.
const BUDGET_RESERVATION_RETENTION_DAYS = 7;

/**
 * ai_budget_reservations is a per-UTC-day working ledger (~users+1 rows/day); days older
 * than the window are dead weight that nothing reads again. Prune them so the table
 * doesn't grow unbounded.
 */
export async function pruneBudgetReservations(env: Env): Promise<string> {
  const cutoff = new Date(Date.now() - BUDGET_RESERVATION_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const removed = await makeDb(env).aiBudget.pruneOlderThan(cutoff);
  return `pruned ${removed} ai_budget_reservation rows older than ${cutoff}`;
}

/**
 * read_log retention (Decision D4). 60 days by default, overridable per app with
 * READ_LOG_RETENTION_DAYS.
 *
 * WHY THIS TABLE IS PRUNED WHEN audit_log IS NOT. The audit log is a forensic record of writes and
 * is kept forever. The read ledger is high-volume access metadata about CLIENT data — it is the
 * one table whose own accumulation enlarges the target it exists to protect, so its retention is a
 * deletion promise rather than an archive. The daily R2 backup quietly extends that promise by its
 * own window (BACKUP_RETENTION_DAYS); that interaction is a compliance note in
 * docs/DATA-ROUTES.md, not something this task can resolve.
 */
export const READ_LOG_RETENTION_DAYS_DEFAULT = 60;

/**
 * Parse the override. Fails SAFE rather than closed: anything unusable (unset, non-numeric,
 * zero, negative, fractional) falls back to the default. A typo must not silently become
 * "retain nothing" — an over-eager prune destroys the attribution trail, which is the one
 * outcome worse than keeping rows a while longer. Exported for the test that pins each arm.
 */
export function readLogRetentionDays(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return READ_LOG_RETENTION_DAYS_DEFAULT;
  return parsed;
}

/**
 * How far past its deletion date the oldest waiting read_log row may be, after a run that hit the
 * nightly pass cap, before the task pages. The cap itself is not an alarm: a backlog that drains
 * over a few nights, oldest first, is working as designed. A backlog that never drains is. It
 * happens when more eligible rows arrive each day than the cap deletes (more than 200,000 a day at
 * the defaults), and then nothing else would ever say so: every run is a green "pass cap
 * reached". Stateless on purpose: the check reads only the current backlog, never a record of
 * earlier runs.
 */
export const READ_LOG_PRUNE_MAX_OVERDUE_DAYS = 3;

/**
 * The operator-facing outcome of one prune run: a detail string, or a throw, which pages the
 * owner through the ops loop. Pure, so the thresholds are testable without 200,000 rows. The text
 * carries counts and day spans only.
 */
export function readLogPruneOutcome(days: number, run: ReadLogPruneResult): string {
  const base = `pruned ${run.deleted} read_log rows older than ${days} days in ${run.passes} pass(es)`;
  if (run.drained) return base;
  const overdue = run.overdueDays ?? 0;
  if (overdue > READ_LOG_PRUNE_MAX_OVERDUE_DAYS) {
    throw new Error(
      `read_log retention is falling behind: this run deleted ${run.deleted} rows in ` +
        `${run.passes} passes (the nightly cap) and the oldest row still waiting is ` +
        `${overdue.toFixed(1)} days past its ${days}-day deletion date (limit ` +
        `${READ_LOG_PRUNE_MAX_OVERDUE_DAYS}). Right after READ_LOG_RETENTION_DAYS is shortened ` +
        'this clears as the backlog drains. If it pages night after night, more eligible rows ' +
        'arrive each day than the cap deletes: raise READ_LOG_PRUNE_MAX_PASSES ' +
        '(src/data/readLog.ts) or cut the read_log inflow.',
    );
  }
  return `${base}; pass cap reached, oldest waiting row ${overdue.toFixed(1)} day(s) past its deletion date, the rest continue next run`;
}

export async function pruneReadLog(env: Env): Promise<string> {
  const days = readLogRetentionDays(env.READ_LOG_RETENTION_DAYS);
  return readLogPruneOutcome(days, await makeDb(env).readLog.pruneOlderThan(days));
}
