// Daily ops loop (03:00 UTC): backup → integrity checks → prune → heartbeat → alert-on-failure.
// Every task is individually wrapped; one failure never stops the others, and the
// heartbeat records per-task results so /_health and the audit log show exactly
// what ran. executeScheduledRun() is exported so tests drive it directly.
import type { Env } from '../env';
import { logEvent } from '../platform/logEvent';
import { sendAlert } from './alert';
import { runAppendOnlyTriggerCheck } from './appendOnlyTriggers';
import { runAuditAnomalyDigest } from './auditAnomalyDigest';
import { runAuditWatch, SECURITY_WATCH_CRON } from './auditWatch';
import { runBackup } from './backup';
import { runEdgeProbe } from './edgeProbe';
import { claimDailyLoopFallback, heartbeatAgeHours, writeHeartbeat } from './heartbeat';
import { runMachineLiveness } from './machineLiveness';
import { pruneBudgetReservations, pruneMagicLinks, pruneReadLog } from './prune';
import { runReportToRegistry } from './reportToRegistry';
import { runRestoreVerify } from './restoreVerify';
import { runTokenExpiryNotice } from './tokenExpiry';

export interface CronTaskResult {
  task: string;
  ok: boolean;
  detail?: string;
  error?: string;
}

type CronTask = [name: string, run: (env: Env) => Promise<string>];

const TASKS: CronTask[] = [
  ['backup', runBackup],
  // Verify the freshest backup is restorable — placed AFTER backup so it checks the object
  // just written. A failure JOINS `failures` and pages the owner: an unrestorable backup is
  // an ops emergency (unlike the best-effort report cron below, which never pages).
  ['restore_verify', runRestoreVerify],
  // The six WORM triggers on audit_log + ai_usage must exist, unaltered, in the LIVE sqlite_master.
  // A missing or altered one means the audit trail is silently writable, so a failure PAGES like
  // restore_verify. One read-only query; it never recreates a trigger (a person does that, verbatim
  // from schema.sql).
  ['append_only_triggers', runAppendOnlyTriggerCheck],
  ['prune_magic_links', pruneMagicLinks],
  ['prune_budget_reservations', pruneBudgetReservations],
  // read_log retention (READ_LOG_RETENTION_DAYS, default 60). A no-op on every app that binds no
  // private database — the table exists and is simply empty — so it ships armed rather than as a
  // step someone remembers when the first Aurora binding lands.
  ['prune_read_log', pruneReadLog],
  // Reads the last 24h of audit_log and emails a digest of security anomalies through the
  // alert seam. Self-skips on a quiet day; its FINDINGS ride the digest email, not the
  // failure alert — so it returns a green detail here and never pages the owner as a failure.
  ['audit_anomaly_digest', runAuditAnomalyDigest],
  // API tokens in use that are about to hit their forced expiry (PIA C8: every token expires,
  // legacy ones at upgrade + 90 days). Emails the alert recipients at 14/7/3/1 day(s) out and is
  // silent otherwise; like the digest, its findings never page as a failure. SERVICE identities
  // get a daily digest from the same task: tokens with less than 14 days left (to the alert
  // recipients AND each custodian), and identities whose tokens are refused though nobody switched
  // them off (custodian left, or a scope no service may hold any more).
  ['token_expiry_notice', runTokenExpiryNotice],
  // "No machine batch in N hours" (MACHINE_LIVENESS_HOURS, default 6) across every machine route's
  // audit action. Skips with no machine routes; silent on a database that never received a batch
  // unless MACHINE_LIVENESS_ARMED. A stale sync is a digest finding, never a paged failure.
  ['machine_liveness', runMachineLiveness],
  // Credential-free edge-drift watch: the ONE regression the worker can catch on its own — the
  // workers.dev off-zone ingress coming back. PAGES if it's serving this app; transient fetch
  // errors never page. Dormant unless WORKERS_DEV_HOST is set. Everything else (WAF/rate-limit
  // rules, headers, Turnstile) is checked by verify:edge:live in CI + the daily scheduled Action —
  // the worker holds no CF token.
  ['edge_probe', runEdgeProbe],
  // Add app crons via the /add-job skill: ['my_task', runMyTask],
];

export async function executeScheduledRun(env: Env): Promise<CronTaskResult[]> {
  const results: CronTaskResult[] = [];
  for (const [task, run] of TASKS) {
    try {
      results.push({ task, ok: true, detail: await run(env) });
    } catch (err) {
      logEvent('cron_task_failed', { task, err });
      results.push({ task, ok: false, error: String(err) });
    }
  }

  // Heartbeat last, recording everything above. If even this fails, /_health
  // reports the stale heartbeat within 26h — silence is itself a signal.
  try {
    await writeHeartbeat(env, results);
  } catch (err) {
    logEvent('cron_heartbeat_failed', { err });
    results.push({ task: 'heartbeat', ok: false, error: String(err) });
  }

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    await sendAlert(env, failures);
  }

  // Fleet self-report — LAST: after the heartbeat (so the snapshot reflects this run) and after
  // the failure alert (so a slow registry never delays a page). Best-effort + gated on
  // REGISTRY_TOKEN (the registry URL is baked in; production + staging report, test/development
  // only with an explicit REGISTRY_URL — see
  // reportToRegistry.ts); a registry outage is not this app's alert, so it never joins the
  // already-computed `failures` set — its outcome rides only the returned results (and, when it
  // throws, the `cron_report_failed` log event).
  try {
    results.push({ task: 'report_to_registry', ok: true, detail: await runReportToRegistry(env) });
  } catch (err) {
    logEvent('cron_report_failed', { err });
    results.push({ task: 'report_to_registry', ok: false, error: String(err) });
  }
  return results;
}

/** The daily ops loop's own trigger (wrangler `triggers.crons`, both configs): always runs the loop. */
export const DAILY_OPS_CRON = '0 3 * * *';

/**
 * A trigger no branch in runScheduled claims runs the daily loop only when the loop's heartbeat is
 * at least this old, or missing. Cloudflare does not version triggers with the code, so the old
 * fallback (run the loop on ANY unrecognized trigger) ran backup, restore verify, the digest and
 * the registry report on every tick of a trigger added in wrangler without its branch, or met by a
 * rollback to a version from before its branch: 1,440 times a day for a per-minute trigger. With
 * the guard, and the claim a due tick takes before it dispatches the loop (claimDailyLoopFallback,
 * held for the same 20 h), such a trigger starts at most one loop per 20 h (about 20 h after the
 * last one, beside the daily trigger's own), even while that loop is still running or after it
 * died before its heartbeat. A daily schedule renamed in wrangler still runs the loop every day.
 * 20 h, not 24 h: the heartbeat is written when the loop ENDS, so the next daily tick finds it a
 * little under 24 h old, and a 24 h bar would skip every renamed daily tick. The cost: beside a
 * healthy daily trigger, that extra run lands on the SAME UTC date as the daily's, and the loop's
 * mailing tasks assume one run per UTC date (tokenExpiry.ts rule 3), so that day the token-expiry
 * notices and the digests go out twice and a failing task pages twice. See DECISIONS 2026-09-28.
 */
export const UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS = 20;

/**
 * Whether a cron expression fires at most once a day: one fixed minute and one fixed hour
 * (`17 4 * * *`, `0 2 * * 1-5`), whatever its day fields. A renamed daily schedule has this shape.
 */
export function firesAtMostOnceADay(cron: string): boolean {
  const [minute = '', hour = ''] = cron.trim().split(/\s+/);
  return /^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour);
}

/**
 * Whether an unrecognized trigger runs the daily loop on this tick. One warn line either way, so
 * an unwired trigger always shows in Workers Logs; never an audit row (audit_log is append-only
 * and a per-minute trigger would add 1,440 rows a day). A due tick runs the loop only if it takes
 * the fallback claim first; a claim an earlier tick holds skips it. KV trouble (an unreadable
 * heartbeat, a claim KV will not read or write) skips a sub-daily trigger, because a KV outage
 * must not turn it back into a loop per tick. It does NOT skip a trigger that fires at most once a
 * day: that one cannot become a loop per tick, and it is the renamed daily schedule the fallback
 * exists for, so skipping it would cost the day's backup, WORM check and anomaly digest. The
 * expression itself does not ride the line (see `cron_trigger_unrecognized` in
 * src/platform/logEvent.ts).
 */
async function unrecognizedTriggerRunsDailyLoop(env: Env, cron: string): Promise<boolean> {
  const onceADay = firesAtMostOnceADay(cron);
  let heartbeat: 'fresh' | 'stale' | 'missing' | 'unreadable';
  let ageHours: number | undefined;
  let err: unknown;
  try {
    const age = await heartbeatAgeHours(env);
    heartbeat =
      age === null
        ? 'missing'
        : age >= UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS
          ? 'stale'
          : 'fresh';
    // Floored, so a skipped tick never logs an age that reads as the 20 h bar.
    ageHours = age === null ? undefined : Math.floor(age * 10) / 10;
  } catch (readErr) {
    heartbeat = 'unreadable';
    err = readErr;
  }
  const due =
    heartbeat === 'stale' || heartbeat === 'missing' || (heartbeat === 'unreadable' && onceADay);
  let claim: 'taken' | 'held' | 'failed' | undefined;
  if (due) {
    try {
      claim = (await claimDailyLoopFallback(env, UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS))
        ? 'taken'
        : 'held';
    } catch (claimErr) {
      claim = 'failed';
      err ??= claimErr;
    }
  }
  const runs = claim === 'taken' || (claim === 'failed' && onceADay);
  logEvent('cron_trigger_unrecognized', {
    daily_loop: runs ? 'ran' : 'skipped',
    once_a_day: onceADay,
    heartbeat,
    heartbeat_age_hours: ageHours,
    claim,
    err,
  });
  return runs;
}

// Cron dispatch by schedule. The daily ops loop and the hourly control-plane tripwire run on
// distinct cron expressions (wrangler `triggers.crons`); `controller.cron` carries which one fired
// so each handler only does its own work. A new trigger gets its own branch here, above the daily
// loop, in the same PR as its wrangler entry (/add-job step 4). An expression no branch claims
// falls back to the daily loop only when the loop is due (UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS)
// and no earlier fallback tick holds the claim, so an unwired trigger degrades safely: never
// silently a no-op, never a loop on every tick.
export async function runScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  if (controller.cron === SECURITY_WATCH_CRON) {
    ctx.waitUntil(runAuditWatch(env));
    return;
  }
  // App triggers: one branch per expression, here, above the fallback.
  if (
    controller.cron !== DAILY_OPS_CRON &&
    !(await unrecognizedTriggerRunsDailyLoop(env, controller.cron))
  ) {
    return;
  }
  ctx.waitUntil(executeScheduledRun(env));
}
