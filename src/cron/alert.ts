// Failure alerting (D9 + A4): email to the app owner + extra recipients, and/or a
// Slack incoming webhook. The env vars ALERT_EMAIL (comma-separated) and
// ALERT_WEBHOOK_URL are the defaults; admins can layer overrides in-app (settings
// repo). Best-effort by design — a failed alert never breaks the cron; the failure
// is still in the heartbeat row and logs.
import { type AlertingSettings, makeDb } from '../data';
import { cronFailureEmail } from '../email/templates';
import { type OutboundEmail, sendEmail } from '../email/transport';
import { type Env, getSecret } from '../env';
import { logEvent } from '../platform/logEvent';
import type { CronTaskResult } from './index';

/** Split a comma/semicolon/space list into trimmed addresses. */
export function parseRecipients(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => e.includes('@'));
}

// The in-app-settable alert webhook is an SSRF primitive (the cron POSTs to it), so the
// admin-supplied override is constrained to HTTPS Slack incoming-webhook URLs at write
// time. The env default (ALERT_WEBHOOK_URL) is operator-trusted and only required to be
// HTTPS at send time (see sendAlert).
export function isSlackWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

// Exported so the audit-anomaly digest reuses the exact same send-time HTTPS gate for its
// webhook egress (never speak cleartext to an operator/admin-supplied URL) rather than
// duplicating it.
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Slack text for a cron-failure alert: the failed task NAMES only. Unlike the email (operator
 * inboxes, with escaped per-task detail), the webhook POSTs to a third-party host
 * (hooks.slack.com) in plaintext, so it must never carry raw error text — a thrown D1/R2 error
 * can embed SQL fragments or table/column names. The full String(err) stays in the audit row
 * (the `cron_heartbeat_done` payload) and the operator email; Workers Logs carry the task name and
 * error class only (PIA C5).
 */
export function cronFailureSlackText(
  appName: string,
  appEnv: string,
  failures: ReadonlyArray<{ task: string }>,
): string {
  const list = failures.map((f) => `• ${f.task}`).join('\n');
  return (
    `[${appName}/${appEnv}] cron failures (${failures.length}):\n${list}\n` +
    'Per-task errors: the alert email and the `cron_heartbeat_done` audit row. ' +
    '/_health shows the heartbeat.'
  );
}

/**
 * Effective alert targets: env defaults layered with in-app overrides (A4).
 * Recipients are the UNION of ALERT_EMAIL (owner + extras) and the stored extras;
 * the Slack webhook is the stored override when set AND still a valid Slack URL, else
 * the env default.
 * Pure (no I/O) so it's unit-testable — the env webhook is resolved by the caller
 * (it may be a Secrets Store binding, hence async), then passed in.
 */
export function resolveAlertTargets(
  env: Env,
  stored: AlertingSettings | null,
  envWebhook: string | null,
): { recipients: string[]; webhook: string | null } {
  const recipients = [
    ...new Set([...parseRecipients(env.ALERT_EMAIL), ...(stored?.recipients ?? [])]),
  ];
  // The stored override is an admin-supplied SSRF primitive, so honor it only if it's STILL a
  // Slack webhook — a legacy row written before the write-time isSlackWebhook check (AICOE-205)
  // could be any HTTPS URL, and the send-time gate below only checks isHttpsUrl. An invalid
  // override falls back to the operator-trusted env default rather than POSTing to an arbitrary
  // host.
  const storedWebhook =
    stored?.slackWebhookUrl && isSlackWebhook(stored.slackWebhookUrl)
      ? stored.slackWebhookUrl
      : null;
  const webhook = storedWebhook ?? envWebhook ?? null;
  return { recipients, webhook };
}

/**
 * The shared best-effort egress primitive behind BOTH the cron-failure alert and the daily
 * audit-anomaly digest: resolve targets (env defaults layered with in-app overrides), email
 * every recipient, and — when a webhook is configured — POST the names/counts-only Slack text to
 * it (HTTPS-gated so we never speak cleartext to an operator/admin-supplied URL, timeout-bounded
 * so a hung webhook can't stall the cron, error-CLASS-only logging so the Slack secret in the URL
 * never reaches the log sink). Best-effort throughout: a send failure is logged, never thrown, so
 * the caller stays green. `logPrefix` names the caller in the seam's log events — the
 * `channel` field of `alert_seam_*` ('alert' | 'audit_digest' | 'audit_fail' | …; an
 * identifier, screened as one); the return reports per-channel outcome so a caller
 * can surface it. Callers are no longer cron-only: the framework's declared-audit failure path
 * (src/framework/execute.ts) invokes the seam from the per-request mutation path — throttled to
 * one alert per action per window there, so seam edits must not assume cron cadence.
 */
export async function sendViaAlertSeam(
  env: Env,
  logPrefix: string,
  email: Omit<OutboundEmail, 'to'>,
  slackText: string,
): Promise<{ recipients: number; emailed: number; failed: number; webhook: boolean }> {
  let stored: AlertingSettings | null = null;
  try {
    stored = await makeDb(env).settings.getAlerting();
  } catch (err) {
    logEvent('alert_seam_settings_read_failed', { channel: logPrefix, err }); // env defaults
  }
  const envWebhook = (await getSecret(env.ALERT_WEBHOOK_URL)) ?? null;
  const { recipients, webhook } = resolveAlertTargets(env, stored, envWebhook);

  let emailed = 0;
  let failed = 0;
  for (const to of recipients) {
    try {
      // sendEmail catches its own transport errors and returns 'failed' (never throws); 'skipped'
      // means no EMAIL binding (fail-open by design). Distinguish 'failed' from 'skipped' so a
      // broken mailer during a live event is observable, not silently identical to a quiet day.
      const outcome = await sendEmail(env, { to, ...email });
      if (outcome === 'sent') emailed++;
      else if (outcome === 'failed') failed++;
    } catch (err) {
      failed++;
      logEvent('alert_seam_email_failed', { channel: logPrefix, err });
    }
  }

  // Require HTTPS and bound the request — a webhook is an outbound POST to an
  // operator/admin-supplied URL, so never speak cleartext and never hang the cron.
  if (webhook && isHttpsUrl(webhook)) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: slackText }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (err) {
      // Log the error CATEGORY only — the raw error can serialize the webhook URL, whose path is
      // the Slack secret; never write it to the log sink.
      logEvent('alert_seam_webhook_failed', { channel: logPrefix, err });
    }
  } else if (webhook) {
    logEvent('alert_seam_webhook_skipped_non_https', { channel: logPrefix });
  }

  return { recipients: recipients.length, emailed, failed, webhook: webhook !== null };
}

export async function sendAlert(env: Env, failures: CronTaskResult[]): Promise<void> {
  await sendViaAlertSeam(
    env,
    'alert',
    cronFailureEmail(env.APP_NAME, env.APP_ENV, failures),
    cronFailureSlackText(env.APP_NAME, env.APP_ENV, failures),
  );
}
