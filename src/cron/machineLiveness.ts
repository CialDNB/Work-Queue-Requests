// Daily machine-liveness check: "no machine batch in N hours". Lifted from the insights pilot
// (CialDNB/insights#271, plan item A1.4) and generalised from its two hard-coded ingest actions to
// the app's route table: every `machine: true` route that declares an audit action writes one row
// per successful batch (src/framework/execute.ts), so the NEWEST such row says when an integration
// last got a batch through. Once an integration sends only what changed, a stalled sync and a
// quiet upstream look the same in the data; this check tells the owner the sync has stopped.
//
// THE RULE — aggregated, deliberately. The check alerts when NO machine route has written a row in
// more than N hours, i.e. every machine stream is quiet. It does not alert per stream: a fork's
// machine actions include sporadic ones (insights' decision-children batches arrive only when a
// decision changed), and per-stream thresholds would page on a quiet afternoon. The heartbeat
// detail still lists every stream's age, so a single dead stream is visible there; an app that
// needs a per-stream alarm on a scheduled stream keeps its own check (insights' ingestLiveness).
// A writer whose token is refused leaves authz.denied rows the daily audit digest counts.
//
// WHOSE ROWS COUNT: only rows a SERVICE identity wrote (actor `svc-<slug>@<app>.invalid`), as
// audit.latestServiceRowAt reads them. An action name belongs to no one route: a person route may
// declare the same action (an admin's manual re-import), and any handler may write it through
// ctx.audit(). Counting those rows would read a stopped sync as live while people keep working —
// the ETL's token expires, every batch is refused, and a daily manual import keeps resetting the
// clock. A machine route admits only a service, so its rows always count. A service that writes
// the action through an ordinary route counts too: that is still the integration getting a batch
// through.
//
// THE DETAIL names the settings a go-live must check: `armed` when MACHINE_LIVENESS_ARMED is on,
// and `sync-run warn-only` while MACHINE_SYNC_RUN=warn lets rows through with `runId: null`. They
// close the parenthetical in the `clear` and the `stale` form alike (a stale detail goes on to
// ` — emailed …`), so GO-LIVE gate 13's evidence — the detail contains `, armed)` and not
// `sync-run warn-only` — reads the same either way. test/cron/machineLiveness.test.ts evaluates
// that rule, as each doc states it, against this detail.
//
// NEVER-WRITTEN DATABASES depend on MACHINE_LIVENESS_ARMED:
//   - Unarmed (the default): a database with no machine row at all is silent (detail `never`).
//     A fresh fork, or production before go-live, has no sync to have stopped. The check arms
//     itself on the first machine row, and audit_log is append-only, so once a row exists it stays.
//   - Armed (`true`, set at go-live): no machine row at all is as stale as a stopped sync — an
//     integration that never got one batch through (never pointed here, or refused on every call)
//     would otherwise read `never` in a green detail forever.
//
// Digest level, like auditAnomalyDigest.ts: a stale sync is a FINDING, not a cron failure. The
// task returns a green detail either way (so it never joins the `failures` set that pages), sends
// at most ONE alert per run, and folds a send failure into the detail. A failing QUERY throws and
// pages as a task failure: a check that cannot run is an ops problem. A deliberately paused sync
// alerts too, and that alert is expected.
//
// Cost: one query per distinct machine audit action (audit.latestServiceRowAt walks the
// (action, id) index from the newest row to the first service row — one row while only the
// integration writes the action). No machine routes → no query at all.
//
// Detection latency: the check runs once a day with the ops loop (03:00 UTC). N is the threshold
// at that one sample, not a window: a stall is reported between N and 24 + N hours after the last
// batch (up to 30h at the default N = 6).
import { makeDb } from '../data';
import type { Env } from '../env';
import type { RouteDef } from '../framework/defineRoute';
import { syncRunMode } from '../framework/machine';
import { allRoutes } from '../routes';
import { sendViaAlertSeam } from './alert';

export const MACHINE_LIVENESS_HOURS_DEFAULT = 6;

const HOUR_MS = 3_600_000;

/**
 * Parse MACHINE_LIVENESS_HOURS. Anything unusable (unset, blank, non-numeric, zero, negative,
 * fractional) falls back to the default, so a typo never silently disarms the check.
 */
export function machineLivenessHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return MACHINE_LIVENESS_HOURS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return MACHINE_LIVENESS_HOURS_DEFAULT;
  return parsed;
}

/**
 * Parse MACHINE_LIVENESS_ARMED, fail-OFF: only the exact word `true` (trimmed, any case) arms it,
 * so a fresh fork never gets a daily alert for an integration that was never pointed at it. The
 * detail says `armed` when it is on, so a value that did not arm it is visible there.
 */
export function machineLivenessArmed(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/** The distinct audit actions of the app's machine routes, sorted — the streams this check reads. */
export function machineAuditActions(routes: readonly RouteDef[]): string[] {
  const actions = new Set<string>();
  for (const { spec } of routes) {
    if (spec.machine === true && typeof spec.audit === 'string') actions.add(spec.audit);
  }
  return [...actions].sort();
}

const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Epoch ms of an audit_log `created_at`. SQLite's datetime('now') writes `YYYY-MM-DD HH:MM:SS` in
 * UTC with no zone marker, which JavaScript would parse as LOCAL time, so it is read explicitly as
 * UTC. NaN when the text is unreadable.
 */
export function parseAuditTimestamp(createdAt: string): number {
  return SQLITE_UTC.test(createdAt)
    ? Date.parse(`${createdAt.replace(' ', 'T')}Z`)
    : Date.parse(createdAt);
}

export interface MachineStreamStatus {
  action: string;
  /** created_at of the stream's newest row, or null when it was never written here. */
  lastAt: string | null;
  /** Hours since that row; null when there is no row or its timestamp is unreadable. */
  ageHours: number | null;
}

export interface MachineLivenessAssessment {
  streams: MachineStreamStatus[];
  /** Hours since the newest machine row of ANY stream; null when there is none (or none readable). */
  newestAgeHours: number | null;
  /** True when no machine row ever reached this database. */
  neverReceived: boolean;
  stale: boolean;
}

/**
 * Pure staleness rule (I/O-free, unit-tested). Stale when the newest row across every machine
 * stream is MORE than `hours` old. No row at all is stale only when `armed`. When rows exist but
 * none has a readable timestamp, liveness cannot be shown, so that is stale. A row dated in the
 * future (clock skew) is live.
 */
export function assessMachineLiveness(
  latest: ReadonlyArray<{ action: string; lastAt: string | null }>,
  nowMs: number,
  hours: number,
  armed = false,
): MachineLivenessAssessment {
  const streams = latest.map(({ action, lastAt }): MachineStreamStatus => {
    if (lastAt === null) return { action, lastAt, ageHours: null };
    const at = parseAuditTimestamp(lastAt);
    return { action, lastAt, ageHours: Number.isNaN(at) ? null : (nowMs - at) / HOUR_MS };
  });
  const ages = streams.flatMap((s) => (s.ageHours === null ? [] : [s.ageHours]));
  const newestAgeHours = ages.length > 0 ? Math.min(...ages) : null;
  const neverReceived = streams.every((s) => s.lastAt === null);
  const stale = neverReceived ? armed : newestAgeHours === null || newestAgeHours > hours;
  return { streams, newestAgeHours, neverReceived, stale };
}

function describeAge(s: MachineStreamStatus): string {
  if (s.lastAt === null) return 'never';
  if (s.ageHours === null) return 'unreadable timestamp';
  return `${s.ageHours.toFixed(1)}h ago`;
}

/**
 * Slack text: action names and ages only. The webhook POSTs to a third-party host, so, as with the
 * other alert texts, no actor, payload or error text crosses to it. Exported for test.
 */
export function machineLivenessSlackText(
  appName: string,
  appEnv: string,
  assessment: MachineLivenessAssessment,
  hours: number,
): string {
  return [
    `[${appName}/${appEnv}] machine liveness: no machine batch in over ${hours}h`,
    ...assessment.streams.map((s) =>
      s.lastAt === null
        ? `• ${s.action}: never received`
        : `• ${s.action}: last row ${describeAge(s)}`,
    ),
    'Check the integration run log and its service token. Expected if the sync was paused on purpose.',
  ].join('\n');
}

async function alert(
  env: Env,
  assessment: MachineLivenessAssessment,
  hours: number,
): Promise<{ recipients: number; emailed: number; failed: number; webhook: boolean }> {
  const subject = `[${env.APP_NAME}/${env.APP_ENV}] machine liveness: no machine batch in over ${hours}h`;
  const text = [
    `No machine route has written an audit row in over ${hours}h (MACHINE_LIVENESS_HOURS, default ${MACHINE_LIVENESS_HOURS_DEFAULT}).`,
    '',
    ...assessment.streams.map((s) =>
      s.lastAt === null
        ? `- ${s.action}: no row ever received`
        : `- ${s.action}: last row ${s.lastAt} UTC (${describeAge(s)})`,
    ),
    '',
    'Every batch an integration gets through a machine route writes one of these rows, so silence',
    'this long usually means the sync has stopped. Check its run log, and check that its service',
    'token still works: a revoked or expired token is refused before any audit row is written.',
    ...(assessment.neverReceived
      ? [
          '',
          'MACHINE_LIVENESS_ARMED is on, so a database that has never received a machine batch counts',
          'as stopped. Check that the integration was pointed at this environment and that its service',
          "identity holds the machine routes' permission.",
        ]
      : []),
    '',
    'If the sync was paused on purpose (a maintenance window), this alert is expected.',
  ].join('\n');
  return await sendViaAlertSeam(
    env,
    'machine_liveness',
    { subject, text },
    machineLivenessSlackText(env.APP_NAME, env.APP_ENV, assessment, hours),
  );
}

/**
 * The cron entry point (registered in src/cron/index.ts TASKS). Resolves to a green detail whether
 * or not the sync is stale; see the header for why. `routes` defaults to the app's route table.
 */
export async function runMachineLiveness(
  env: Env,
  routes: readonly RouteDef[] = allRoutes,
): Promise<string> {
  const actions = machineAuditActions(routes);
  if (actions.length === 0) return 'machine liveness: skipped (no machine routes)';

  const hours = machineLivenessHours(env.MACHINE_LIVENESS_HOURS);
  const armed = machineLivenessArmed(env.MACHINE_LIVENESS_ARMED);
  const audit = makeDb(env).audit;
  const latest: Array<{ action: string; lastAt: string | null }> = [];
  for (const action of actions) {
    latest.push({ action, lastAt: await audit.latestServiceRowAt(action) });
  }

  const assessment = assessMachineLiveness(latest, Date.now(), hours, armed);
  const summary = assessment.streams.map((s) => `${s.action} ${describeAge(s)}`).join(', ');
  // Warn-only X-Sync-Run (MACHINE_SYNC_RUN=warn) is named here because the detail is the durable
  // record of it: it lands in the cron_heartbeat_done audit row every day, where /go-live looks
  // for it (docs/GO-LIVE.md gate 13). A request's own warning is a log line, gone in 7 days.
  const warnOnly = syncRunMode(env.MACHINE_SYNC_RUN) === 'warn';
  const settings = `threshold ${hours}h${armed ? ', armed' : ''}${warnOnly ? ', sync-run warn-only' : ''}`;
  if (!assessment.stale) return `machine liveness: clear (${summary}; ${settings})`;

  const { recipients, emailed, failed, webhook } = await alert(env, assessment, hours);
  const failedNote = failed > 0 ? ` (${failed} failed)` : '';
  return `machine liveness: stale (${summary}; ${settings}) — emailed ${emailed}/${recipients}${failedNote}${webhook ? ' + slack' : ''}`;
}
