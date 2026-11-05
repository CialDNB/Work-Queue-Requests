// Daily audit-anomaly digest. Prevention is deep across this kit, but nobody READS the
// audit log — so once a day this task scans the last ~24h of audit_log and surfaces
// security-relevant anomalies through the SAME alert seam the cron-failure path uses
// (resolveAlertTargets → sendEmail + optional Slack webhook).
//
// Two hard design rules, both to keep this from becoming noise or a false page:
//   1. A QUIET DAY IS SILENCE. If nothing is notable the task self-skips: it returns
//      'audit digest: nothing notable' and sends NO email/Slack. An empty digest every
//      morning trains people to ignore the channel.
//   2. FINDINGS ARE NOT A CRON FAILURE. This task returns a green detail whether or not it
//      found anomalies — the FINDINGS ride the digest email, never the failure-alert channel
//      (which pages the owner). A digest-SEND failure is likewise best-effort: it is logged
//      and folded into the returned detail, and never thrown, so the ops loop keeps it green
//      and it never joins the `failures` set that triggers sendAlert (see src/cron/index.ts).
import { makeDb } from '../data';
import { AUDIT_WINDOW_ROW_CAP, type AuditRow } from '../data/audit';
import { auditDigestEmail } from '../email/templates';
import type { Env } from '../env';
import { sendViaAlertSeam } from './alert';

// How far back the digest looks, and the thresholds that make a signal "notable".
const WINDOW_HOURS = 24;
// A single domain drawing this many magic-link refusals in a day is a probe/spray signal,
// not organic typos. Tunable; deliberately conservative so a quiet app stays silent.
const REFUSAL_FLOOD_THRESHOLD = 10;

// Audit actions the digest counts as "sensitive mutations" — the writes worth a daily glance
// even at low volume (privilege grants, invites, credential minting, platform config changes).
//
// Each entry is an action name EXACTLY as its writer writes it: a route's `audit:` verb, or the
// `action:` of a direct audit insert. A name nothing writes matches no row, and the digest is
// silent about it every day; test/isolation/sensitive-actions.test.ts fails on such a name.
// (Until CialDNB/paved-road#256 this list held `settings.update` and `user.remove`, which nothing
// in the kit ever wrote, and left out the settings and force-logout actions the routes do write.)
//
// Deliberately NOT here: `login` and `magic_link_refused` (detectAnomalies counts them itself);
// ordinary data and AI writes (`note.*`, `ai.call`); and routine bookkeeping rows
// (`magic_link_sent`, `cron_heartbeat_done`, `audit_watch_initialized`, `audit_watch_truncated`).
// A fork adds its own sensitive verbs below the app-actions line at the end.
export const SENSITIVE_ACTIONS = [
  // People and their access (src/routes/users.ts). The kit never deletes a user: taking someone's
  // access away is `user.update` with `disabled: true`, so there is no `user.remove`.
  'user.invite',
  'user.update',
  // An admin forcing someone out of every session: incident response, or a lock-out. Either way
  // worth a glance.
  'user.revoke_sessions',
  'token.create',
  'token.revoke',
  // Platform settings (src/routes/settings.ts), one action per area. Alerting decides who hears
  // about the next incident: redirecting or clearing it is how an intruder goes quiet. The login
  // policy switches magic-link sign-in off or back on.
  'settings.alerting.update',
  'settings.login.update',
  // A SERVICE principal refused a route (src/framework/execute.ts). Machines call a fixed set of
  // routes, so any of these is a misconfigured integration or a stolen token exploring — worth a
  // daily glance at any volume.
  'authz.denied',
  // Service-identity management (src/auth/serviceIdentityRoutes.ts): bringing a machine principal
  // into being, changing its custodian or kill switch, and the revoke-everything incident switch.
  // Minting or revoking ONE of its tokens lands as token.create / token.revoke (owner = the
  // identity), already counted above.
  'service_identity.create',
  'service_identity.update',
  'service_identity.revoke_tokens',
  // Control-plane tripwire rows (src/cron/auditWatch.ts). Included because the tripwire runs on
  // its OWN cron, outside executeScheduledRun — so its failures never reach sendAlert, and
  // without a digest line a broken or DISARMED tripwire is indistinguishable from a quiet week.
  // Revoking AUDIT_API_TOKEN is the obvious first move against a watcher; these make it visible.
  'audit_watch_error',
  'audit_watch_skipped',
  'audit_watch_alert_undelivered',
  'security_audit_alert',
  // ---- app actions: your app's own sensitive verbs go below this line ----
  // Spell each exactly as your routes write it (the tripwire holds them to that too). On
  // /kit-upgrade take the kit's entries above and keep yours here. No kit test pins your lines,
  // so losing one fails nothing: pin them in a test of your own (see the kit CHANGELOG).
] as const;

export interface DigestFindings {
  /** Domains at/over the refusal-flood threshold, with their counts, highest first. */
  refusalFloods: Array<{ domain: string; count: number }>;
  /** Logins from an actor+IP pair not seen for that actor earlier in the window. */
  firstSeenIpLogins: Array<{ actor: string; ip: string }>;
  /** Count per sensitive action that occurred at least once in the window. */
  sensitiveCounts: Array<{ action: string; count: number }>;
  /** True when sinceHours hit its row cap — the window is partial, so counts undercount. */
  capped: boolean;
}

/** Nothing to report? Then stay silent. */
export function findingsAreEmpty(f: DigestFindings): boolean {
  return (
    f.refusalFloods.length === 0 &&
    f.firstSeenIpLogins.length === 0 &&
    f.sensitiveCounts.length === 0
  );
}

/**
 * Pure detection over a window of audit rows (id-ASC / oldest-first, as sinceHours returns
 * them). Kept I/O-free so it is exhaustively unit-testable without a DB or the alert seam.
 */
export function detectAnomalies(rows: AuditRow[], capped: boolean): DigestFindings {
  const refusalByDomain = new Map<string, number>();
  const sensitive = new Map<string, number>();
  // Per-actor set of IPs already seen EARLIER in the window; the first time an actor+IP
  // login appears it's "first-seen" (new-device/new-location signal). Because rows are
  // oldest-first, the first occurrence in this pass is the first occurrence in the window.
  const ipsByActor = new Map<string, Set<string>>();
  const firstSeenIpLogins: Array<{ actor: string; ip: string }> = [];

  for (const row of rows) {
    if (row.action === 'magic_link_refused') {
      // The refusal audit row carries {reason, domain} in payload_json (domain only, never
      // the address — see src/auth/magicLink.ts). Count by that domain.
      const domain = readDomain(row.payload_json);
      if (domain) refusalByDomain.set(domain, (refusalByDomain.get(domain) ?? 0) + 1);
      continue;
    }
    if (row.action === 'login') {
      const actor = row.actor_email;
      const ip = row.ip;
      if (!ip) continue; // no IP recorded → nothing to compare
      let seen = ipsByActor.get(actor);
      if (!seen) {
        seen = new Set<string>();
        ipsByActor.set(actor, seen);
      }
      if (!seen.has(ip)) {
        // First time we've seen this actor from this IP in the window.
        seen.add(ip);
        // Only FLAG it if the actor already logged in from a DIFFERENT IP earlier in the
        // window — a brand-new IP alongside an existing one is the new-location signal. An
        // actor's very first login in the window (their only IP) is not, on its own, notable.
        if (seen.size > 1) firstSeenIpLogins.push({ actor, ip });
      }
      continue;
    }
    if ((SENSITIVE_ACTIONS as readonly string[]).includes(row.action)) {
      sensitive.set(row.action, (sensitive.get(row.action) ?? 0) + 1);
    }
  }

  const refusalFloods = [...refusalByDomain.entries()]
    .filter(([, count]) => count >= REFUSAL_FLOOD_THRESHOLD)
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count);

  const sensitiveCounts = SENSITIVE_ACTIONS.filter((a) => sensitive.has(a)).map((action) => ({
    action,
    count: sensitive.get(action) as number,
  }));

  return { refusalFloods, firstSeenIpLogins, sensitiveCounts, capped };
}

/** Domain out of a refusal row's `{reason, domain}` payload, or null if unreadable. */
function readDomain(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as { domain?: unknown };
    return typeof parsed.domain === 'string' ? parsed.domain : null;
  } catch {
    return null;
  }
}

/**
 * One-line-per-finding Slack text: NAMES + COUNTS only, never raw payloads. The webhook POSTs
 * to a third-party host (hooks.slack.com) in plaintext, so it mirrors cronFailureSlackText's
 * discipline — domains and actor emails are the app's own low-sensitivity identifiers, but no
 * audit payload_json, IP list, or error text ever crosses to the third party. Exported for test.
 */
export function auditDigestSlackText(appName: string, appEnv: string, f: DigestFindings): string {
  const lines: string[] = [];
  for (const r of f.refusalFloods) lines.push(`• ${r.count} magic-link refusals at ${r.domain}`);
  if (f.firstSeenIpLogins.length > 0)
    lines.push(`• ${f.firstSeenIpLogins.length} first-seen-IP login(s)`);
  for (const s of f.sensitiveCounts) lines.push(`• ${s.count}× ${s.action}`);
  if (f.capped) lines.push('• (window truncated at the row cap — counts are a floor)');
  return `[${appName}/${appEnv}] audit digest (last ${WINDOW_HOURS}h):\n${lines.join('\n')}\nCheck /_health and the audit log for detail.`;
}

/**
 * Deliver the digest through the shared alert seam (sendViaAlertSeam — the SAME egress the
 * cron-failure alert uses: same recipients + Slack channel, HTTPS-gated, timeout-bounded,
 * names/counts-only webhook). Best-effort — a send failure is not the caller's failure — so it
 * returns a short outcome string for the task detail rather than throwing. A genuinely FAILED
 * email send is surfaced distinctly from a fail-open SKIP so a broken mailer during a live
 * security event is observable in the heartbeat detail, not silently indistinguishable from a
 * quiet/unconfigured day.
 */
async function sendDigest(env: Env, f: DigestFindings): Promise<string> {
  const { recipients, emailed, failed, webhook } = await sendViaAlertSeam(
    env,
    'audit_digest',
    auditDigestEmail(env.APP_NAME, env.APP_ENV, f, WINDOW_HOURS),
    auditDigestSlackText(env.APP_NAME, env.APP_ENV, f),
  );
  const failedNote = failed > 0 ? ` (${failed} failed)` : '';
  return `emailed ${emailed}/${recipients}${failedNote}${webhook ? ' + slack' : ''}`;
}

/**
 * The cron entry point (registered in src/cron/index.ts TASKS). Scans the window, and either
 * self-skips (quiet day → no send) or sends the digest. ALWAYS resolves to a green detail
 * string — findings are not a failure, and a digest-send hiccup is swallowed inside sendDigest.
 */
export async function runAuditAnomalyDigest(env: Env): Promise<string> {
  const rows = await makeDb(env).audit.sinceHours(WINDOW_HOURS);
  // The cap lives in sinceHours; if we got exactly that many rows the window is (very likely)
  // truncated, so counts are a floor — the digest says so rather than silently undercounting.
  // Same constant sinceHours defaults to, so the two can't drift apart.
  const capped = rows.length >= AUDIT_WINDOW_ROW_CAP;
  const findings = detectAnomalies(rows, capped);

  if (findingsAreEmpty(findings)) {
    return 'audit digest: nothing notable';
  }

  const parts = [
    findings.refusalFloods.length > 0 ? `${findings.refusalFloods.length} refusal-flood(s)` : null,
    findings.firstSeenIpLogins.length > 0
      ? `${findings.firstSeenIpLogins.length} first-seen-IP login(s)`
      : null,
    findings.sensitiveCounts.length > 0
      ? `${findings.sensitiveCounts.length} sensitive-action type(s)`
      : null,
  ].filter((p): p is string => p !== null);

  const sent = await sendDigest(env, findings);
  return `audit digest: ${parts.join(', ')} — ${sent}`;
}
