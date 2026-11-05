// Daily token-expiry notice (PIA C8). Every token now expires — at most 90 days after it was
// minted, and every token that predates C8 at upgrade + 90 days (migrations/d1/0003). A machine
// integration whose token lapses does not degrade, it stops with a bare 401, so this task warns
// the alert recipients (the same seam as the cron-failure alert and the audit digest) while there
// is still time to rotate: docs/runbooks/machine-token-rotation.md.
//
// Design rules, borrowed from the audit digest:
//   1. A QUIET DAY IS SILENCE. Nothing entering a notice window → no email, no Slack.
//   2. FINDINGS ARE NOT A CRON FAILURE. The task returns a green detail either way, and a send
//      failure is folded into that detail — it never joins the `failures` set that pages.
//   3. STATELESS, AND ONE NOTICE PER WINDOW. Windows are counted in UTC CALENDAR DAYS: a token is
//      reported on the run whose UTC date is exactly 14, 7, 3 or 1 day(s) before its expiry DATE.
//      The day index of a run depends only on its date, never on the minute it started, so the
//      jitter in when this task runs (cron trigger delay, plus however long backup,
//      restore_verify and the digest take before it) can neither skip a window nor repeat one.
//      The one assumption: the loop runs once per UTC day, which the kit's 03:00 UTC schedule
//      holds with hours to spare. The unrecognized-trigger fallback breaks it while a frequent
//      trigger sits unwired beside the daily one: its extra run lands on the same UTC date, and
//      that day's notices go out twice (DECISIONS 2026-09-28). (An earlier cut counted
//      floor(ms left / 24h) from Date.now(), and an expiry that fell within that jitter of the run
//      time could miss or double a window.) No "already notified" row is kept anywhere.
//   4. ONLY TOKENS THAT HAVE BEEN USED, OWNED BY AN ACTIVE USER. A token nobody ever presented, or
//      one whose owner is disabled (already refused at resolution), breaks nothing by expiring.
//   5. NEVER A SILENT CAP. The email lists up to NOTICE_LIST_LIMIT tokens and states the full
//      count: every legacy token shares the 0003 back-fill expiry, so the migration's cohort
//      reaches each window on the same day.
//
// SERVICE IDENTITIES get a stronger digest from the same task (runServiceIdentityDigest), because a
// machine's token is rotated by a custodian on a schedule and a lapse is an outage nobody sees
// until the data is stale:
//   - on EVERY run while the token has less than 14 days (by the clock) left — not only on the
//     14/7/3/1 windows — until it is rotated and the old one revoked: a nag, deliberately, for a
//     narrow and accountable audience;
//   - each row names the identity AND ITS CUSTODIAN, and each custodian also gets their own copy
//     listing only their identities (the person who must rotate hears it directly);
//   - ORPHANED identities — enabled, holding live tokens, custodian no longer an active user — are
//     reported every day too: their tokens are already REFUSED (src/auth/tokens.ts fails closed),
//     so this is how an ingestion stopped by an offboarding is never silent.
// Same rules otherwise: a quiet day is silence, findings are never a cron failure, Slack gets
// counts only. Person tokens keep their 14/7/3/1 notice unchanged; service tokens never appear in
// it (the query excludes the reserved namespace).
import { serviceGrantableScopes } from '../auth/permissions';
import { makeDb } from '../data';
import type { ExpiringServiceTokenRow, ExpiringTokenRow } from '../data/tokens';
import {
  type OrphanedServiceIdentityRow,
  type ServiceTokenNoticeRow,
  type StrandedServiceIdentityRow,
  serviceIdentityDigestEmail,
  serviceTokenCustodianEmail,
  type TokenExpiryNoticeRow,
  tokenExpiryEmail,
} from '../email/templates';
import { sendEmail } from '../email/transport';
import type { Env } from '../env';
import { logEvent } from '../platform/logEvent';
import { sendViaAlertSeam } from './alert';

/** The windows, in UTC calendar days before the expiry date, a token is reported on. Descending. */
export const TOKEN_EXPIRY_NOTICE_DAYS: readonly number[] = [14, 7, 3, 1];

/** How many tokens one notice lists by name; the rest are counted. */
export const NOTICE_LIST_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** SQLite `datetime()` text ("YYYY-MM-DD HH:MM:SS", UTC) → epoch ms, or NaN. */
function parseSqliteUtc(value: string): number {
  return Date.parse(`${value.replace(' ', 'T')}Z`);
}

/** The UTC day number of an instant (days since the epoch) — the same for any minute of a date. */
function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/**
 * The UTC calendar dates (`YYYY-MM-DD`) whose tokens enter a notice window on a run at `nowMs`:
 * today + 14, + 7, + 3 and + 1 day(s). What the repository filters on.
 */
export function noticeDates(nowMs: number): string[] {
  const today = utcDay(nowMs);
  return TOKEN_EXPIRY_NOTICE_DAYS.map((d) =>
    new Date((today + d) * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * Pure selection: which of `rows` enter a notice window on a run at `nowMs`, and which one. A row
 * is due when its expiry date is one of TOKEN_EXPIRY_NOTICE_DAYS UTC calendar days after the
 * run's date. An unparseable or already-past expiry is skipped (the column is always written by
 * datetime(), so this is defensive, not expected).
 */
export function dueTokenNotices(
  rows: readonly ExpiringTokenRow[],
  nowMs: number,
): TokenExpiryNoticeRow[] {
  const due: TokenExpiryNoticeRow[] = [];
  for (const row of rows) {
    const expiresMs = parseSqliteUtc(row.expires_at);
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs) continue;
    const daysLeft = utcDay(expiresMs) - utcDay(nowMs);
    if (!TOKEN_EXPIRY_NOTICE_DAYS.includes(daysLeft)) continue;
    due.push({
      prefix: row.prefix,
      name: row.name,
      owner: row.email,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      daysLeft,
    });
  }
  return due;
}

/**
 * Slack text: COUNTS only. The webhook POSTs to a third party (hooks.slack.com), so — like the
 * digest and the failure alert — it names no token, no owner. The email carries the detail.
 */
export function tokenExpirySlackText(
  appName: string,
  appEnv: string,
  due: readonly TokenExpiryNoticeRow[],
  total: number = due.length,
): string {
  const soonest = Math.min(...due.map((d) => d.daysLeft));
  const when = soonest === 1 ? 'tomorrow' : `in ${soonest} days`;
  return `[${appName}/${appEnv}] ${total} API token(s) in use expire soon (soonest ${when}, UTC). Rotate before they lapse — see the alert email and docs/runbooks/machine-token-rotation.md.`;
}

/**
 * The service digest reports a service token on every run while it has LESS THAN this many days
 * (× 24 hours, by the clock) left.
 */
export const SERVICE_TOKEN_DIGEST_DAYS = 14;

/**
 * The exclusive cutoff the service digest's query uses on a run at `nowMs`: exactly
 * SERVICE_TOKEN_DIGEST_DAYS × 24h later, as SQLite `datetime()` text ("YYYY-MM-DD HH:MM:SS", UTC —
 * the same shape as `expires_at`, so the comparison is a plain text one). Exact, not a calendar
 * date, so the total the digest states is the number of tokens it means.
 */
export function serviceDigestCutoff(nowMs: number): string {
  return new Date(nowMs + SERVICE_TOKEN_DIGEST_DAYS * DAY_MS)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
}

/**
 * Pure selection for the service digest: every row expiring later than `nowMs` with LESS THAN
 * SERVICE_TOKEN_DIGEST_DAYS × 24h left — by the clock, not by calendar day, so "< 14 days" means
 * exactly that. (The person notice counts calendar days because it fires on four exact windows and
 * must neither skip nor repeat one; the service digest fires on every run inside its window, so
 * run-time jitter can at most move its first report by one run.) `daysLeft` is the WHOLE days
 * left, 0–13 (0 = less than 24 hours).
 */
export function dueServiceTokens(
  rows: readonly ExpiringServiceTokenRow[],
  nowMs: number,
): ServiceTokenNoticeRow[] {
  const due: ServiceTokenNoticeRow[] = [];
  for (const row of rows) {
    const expiresMs = parseSqliteUtc(row.expires_at);
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs) continue;
    const msLeft = expiresMs - nowMs;
    if (msLeft >= SERVICE_TOKEN_DIGEST_DAYS * DAY_MS) continue;
    const daysLeft = Math.floor(msLeft / DAY_MS);
    due.push({
      identity: row.service_name,
      identifier: row.principal_id,
      tokenName: row.name,
      prefix: row.prefix,
      custodian: row.custodian_email,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      daysLeft,
    });
  }
  return due;
}

/** Slack text for the service digest: COUNTS only, never an identity, a token or a custodian. */
export function serviceDigestSlackText(
  appName: string,
  appEnv: string,
  dueCount: number,
  orphanCount: number,
  strandedCount = 0,
): string {
  const parts = [
    ...(orphanCount > 0
      ? [
          `${orphanCount} service identit${orphanCount === 1 ? 'y has' : 'ies have'} no active custodian (tokens refused)`,
        ]
      : []),
    ...(strandedCount > 0
      ? [
          `${strandedCount} service identit${strandedCount === 1 ? 'y holds' : 'ies hold'} a scope no service may hold (tokens refused)`,
        ]
      : []),
    ...(dueCount > 0 ? [`${dueCount} service token(s) expire within 14 days`] : []),
  ];
  return `[${appName}/${appEnv}] ${parts.join('; ')}. See the alert email and docs/runbooks/service-identities.md.`;
}

/**
 * The daily service-identity digest. Returns a detail for the cron result, or null on a quiet day
 * (nothing expiring within 14 days, no orphaned or stranded identity) — when nothing is sent.
 */
export async function runServiceIdentityDigest(
  env: Env,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const db = makeDb(env);
  const grantable = serviceGrantableScopes();
  const { rows, total } = await db.tokens.listServiceTokensExpiringBefore(
    serviceDigestCutoff(nowMs),
    grantable,
    NOTICE_LIST_LIMIT,
  );
  const due = dueServiceTokens(rows, nowMs);
  const orphans: OrphanedServiceIdentityRow[] = (await db.serviceIdentities.listOrphaned()).map(
    (o) => ({
      identity: o.name,
      identifier: o.principal_id,
      custodian: o.custodian_email,
      liveTokens: o.live_tokens,
      lastUsedAt: o.last_used_at,
    }),
  );
  // A scope no service may hold any more: refused for a reason no custodian change fixes. Named
  // every day (alert recipients only — the fix is an owner/admin's) until the identity is replaced.
  const stranded: StrandedServiceIdentityRow[] = (
    await db.serviceIdentities.listScopeStranded(grantable)
  ).map((o) => ({
    identity: o.name,
    identifier: o.principal_id,
    scope: o.scope,
    custodian: o.custodian_email,
    liveTokens: o.live_tokens,
    lastUsedAt: o.last_used_at,
  }));
  if (due.length === 0 && orphans.length === 0 && stranded.length === 0) return null;
  const count = due.length === 0 ? 0 : Math.max(total, due.length);

  const seam = await sendViaAlertSeam(
    env,
    'service_identity_digest',
    serviceIdentityDigestEmail(env.APP_NAME, env.APP_ENV, due, count, orphans, stranded),
    serviceDigestSlackText(env.APP_NAME, env.APP_ENV, count, orphans.length, stranded.length),
  );

  // Each custodian's own copy — only the identities they are accountable for. Best-effort, like
  // the seam: a failed send is counted, never thrown.
  const byCustodian = new Map<string, ServiceTokenNoticeRow[]>();
  for (const row of due)
    byCustodian.set(row.custodian, [...(byCustodian.get(row.custodian) ?? []), row]);
  let custodiansEmailed = 0;
  let custodiansFailed = 0;
  for (const [custodian, theirs] of byCustodian) {
    try {
      const outcome = await sendEmail(env, {
        to: custodian,
        ...serviceTokenCustodianEmail(env.APP_NAME, env.APP_ENV, theirs),
      });
      if (outcome === 'sent') custodiansEmailed++;
      else if (outcome === 'failed') custodiansFailed++;
    } catch (err) {
      custodiansFailed++;
      logEvent('service_identity_digest_custodian_email_failed', { err });
    }
  }
  const failedNote =
    seam.failed + custodiansFailed > 0 ? ` (${seam.failed + custodiansFailed} failed)` : '';
  const strandedNote =
    stranded.length > 0 ? `, ${stranded.length} with a scope no service may hold` : '';
  return `service identities: ${count} token(s) expiring, ${orphans.length} without a custodian${strandedNote} — emailed ${seam.emailed}/${seam.recipients} + ${custodiansEmailed}/${byCustodian.size} custodian(s)${failedNote}${seam.webhook ? ' + slack' : ''}`;
}

/**
 * The cron entry point (registered in src/cron/index.ts TASKS): the person notice, then the service
 * digest — INDEPENDENTLY. Each runs whatever the other did, so a broken half can never suppress the
 * other half's email. If either throws, the task fails AFTER both have run (so the cron-failure
 * alert fires), and the error names what did complete. A database without service_identities
 * (migration 0004 not applied) is such a failure: the error is the drift remedy, and every service
 * token is being refused meanwhile (src/auth/tokens.ts).
 *
 * `parts` exists only so tests can drive a failing half without module mocking.
 */
export async function runTokenExpiryNotice(
  env: Env,
  nowMs: number = Date.now(),
  parts: {
    person?: (env: Env, nowMs: number) => Promise<string>;
    service?: (env: Env, nowMs: number) => Promise<string | null>;
  } = {},
): Promise<string> {
  const failures: string[] = [];
  let person: string | null = null;
  try {
    person = await (parts.person ?? runPersonTokenNotice)(env, nowMs);
  } catch (err) {
    failures.push(`token expiry notice failed: ${String(err)}`);
  }
  let service: string | null = null;
  try {
    service = await (parts.service ?? runServiceIdentityDigest)(env, nowMs);
  } catch (err) {
    failures.push(`service identity digest failed: ${String(err)}`);
  }
  const done = [person, service].filter((d): d is string => d !== null).join('; ');
  if (failures.length > 0) {
    throw new Error([...failures, ...(done ? [`completed: ${done}`] : [])].join(' | '));
  }
  return done;
}

// The 14/7/3/1 notice for every other token (PIA C8), unchanged by service identities.
async function runPersonTokenNotice(env: Env, nowMs: number): Promise<string> {
  const { rows, total } = await makeDb(env).tokens.listUsedExpiringOn(
    noticeDates(nowMs),
    NOTICE_LIST_LIMIT,
  );
  const due = dueTokenNotices(rows, nowMs);
  if (due.length === 0) return 'token expiry: nothing entering a notice window';
  // The repository's count covers rows past the list limit; never report fewer than we list.
  const count = Math.max(total, due.length);

  const { recipients, emailed, failed, webhook } = await sendViaAlertSeam(
    env,
    'token_expiry',
    tokenExpiryEmail(env.APP_NAME, env.APP_ENV, due, count),
    tokenExpirySlackText(env.APP_NAME, env.APP_ENV, due, count),
  );
  const failedNote = failed > 0 ? ` (${failed} failed)` : '';
  return `token expiry: ${count} token(s) noticed — emailed ${emailed}/${recipients}${failedNote}${webhook ? ' + slack' : ''}`;
}
