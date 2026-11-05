/* Control-plane tripwire (Sensitive-Data Protection capability, OPT-IN): watch Cloudflare's
 * account Audit Log for changes to THIS app's OWN resources — its Worker, secrets, D1/R2 — and
 * alert when a change was made by an actor OUTSIDE the sanctioned deploy path.
 *
 * WHY THIS EXISTS. When an app seals a high-sensitivity field at rest (src/crypto/seal.ts), a D1
 * dump or an R2 backup carries only ciphertext. The one key that opens it, SEAL_KEY, lives solely
 * in the running Worker's env — so the ONLY way to turn it into plaintext is to run code with that
 * binding, i.e. deploy/edit the prod Worker or change its secrets. Every such change is a
 * CONTROL-PLANE event, recorded in Cloudflare's Audit Log with an actor and timestamp. Sanctioned
 * deploys all go through the "Deploy production" GitHub Action under one CI token; a change by ANY
 * other actor (a human in the dashboard, an unexpected token) is the signal worth raising.
 *
 * DETECTIVE, NOT PREVENTIVE. It reports that a change happened — it cannot stop a one-shot key
 * read, after which the holder can decrypt offline forever. The actual lock is least privilege
 * (humans can't deploy; only the CI token can) + branch protection — today docs/GO-LIVE.md gate 8a
 * (required to graduate an app to Stable); a dedicated preventive-lock gate is specced in Phase 3
 * and not yet landed. The seal + this tripwire are defense-in-depth around that lock.
 *
 * CORRECTNESS NOTES (load-bearing for a no-false-negative control — each fixes a confirmed hole a
 * max-effort review caught in the first draft of the Atlas original this is ported from):
 *  - SCOPING: a real Cloudflare audit entry for a D1/secret/script change puts an opaque UUID in
 *    resource.id and a bare verb in action.type — the human NAME lives in newValue/newValueJson/
 *    metadata. So we match the fragment against the WHOLE entry EXCEPT actor/ip (catches the name
 *    wherever Cloudflare put it; still can't be spoofed by an actor whose email contains it).
 *  - DEDUP is by event ID, never by timestamp. RFC3339 `when` values arrive in mixed forms
 *    (sub-second, +00:00 vs Z) that mis-order under string compare, so we never compare them. The
 *    `since` query bounds the window; a KV set of already-alerted ids prevents re-alerting across
 *    the overlap.
 *  - INGESTION LAG: the audit log indexes entries minutes after they happen, so the cursor trails
 *    real time by SAFETY_LAG and each tick re-queries that overlap — an event is re-fetched until
 *    the cursor passes it + the lag.
 *  - FAIL-SAFE: the whole run is wrapped (token resolution included); any failure degrades to an
 *    audit row and never rejects the cron, and the cursor only ever advances (never past an
 *    unfetched backlog on truncation, never on error) — so no window is skipped. The first-run
 *    anchor is persisted BEFORE the fetch, so a failing first tick can't lose the lookback window.
 *  - DELIVERY GATES THE COMMIT: the cursor + seenIds are written only AFTER the alert is out.
 *    Committing first (the original order) made a transient mailer failure permanent — the event
 *    ended up both past the cursor and inside seenIds, so no later tick could re-find it. A real
 *    transport failure now holds both and retries; an unreachable channel (no recipients, no EMAIL
 *    binding) commits but writes an `audit_watch_alert_undelivered` row instead of looping forever.
 *  - ALERTS RIDE THE SHARED SEAM (src/cron/alert.ts), never a raw sendEmail: ALERT_EMAIL is a
 *    comma-separated LIST kit-wide while the Email binding takes ONE address, so passing it raw
 *    silently killed the only channel as soon as a second recipient was added — which GO-LIVE
 *    gate 8a requires. The seam also adds the in-app recipients + the Slack webhook.
 *
 * HOSTING. This in-account cron is the default (it reuses the kit's cron + KV + audit + email).
 * Caveat: it sits in its OWN blast radius — a deploy-capable admin can disable the cron. For a
 * watcher that can't be silenced from inside the account, run the equivalent from GitHub Actions
 * (outside Cloudflare); see docs/runbooks/control-plane-tripwire.md.
 *
 * API: Cloudflare REST v1 `GET /accounts/{id}/audit_logs` (RFC3339 `since`, page-based). If
 * Cloudflare sunsets v1 for v2 (`/logs/audit`), only fetchAuditLog + the entry shape change;
 * detectSuspicious stays as-is.
 */

import { makeDb } from '../data';
import { type AuditAlertEvent, securityAlertEmail } from '../email/templates';
import { type Env, getSecret } from '../env';
import { logEvent } from '../platform/logEvent';
import { sendViaAlertSeam } from './alert';

/** Hourly. Detection latency, not prevention, so the hour granularity is fine. */
export const SECURITY_WATCH_CRON = '0 * * * *';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const CURSOR_KEY = '__audit_watch:cursor'; // canonical ISO high-water for the `since` query
const SEEN_KEY = '__audit_watch:seen'; // JSON array of already-ALERTED (delivered) event ids
// Ids whose forensic row is already in audit_log. SEPARATE from SEEN_KEY because the two answer
// different questions: SEEN gates re-detection (only delivered events stop being re-found), while
// RECORDED makes the forensic insert idempotent. Without this split, holding seen-ids to retry an
// undelivered alert makes every retry tick re-insert the same security_audit_alert row — hourly
// duplicates in an append-only, never-pruned log, which is the bloat we removed elsewhere.
const RECORDED_KEY = '__audit_watch:recorded';
const PER_PAGE = 1000;
const MAX_PAGES = 5; // backstop against a runaway pull; an hourly window is tiny
const SAFETY_LAG_MS = 20 * 60_000; // re-query window covering audit-log ingestion lag
const FIRST_RUN_LOOKBACK_MS = 60 * 60_000; // missing/evicted cursor → cover recent past, don't skip it
const SEEN_RETENTION = 500; // cap on remembered alerted ids (alerts are rare)

// A non-null actor for the kit's append-only audit repo (which lowercases + rejects null). These
// tripwire rows are system-generated, not user actions.
const SYSTEM_ACTOR = 'system';

// Subset of the v1 audit-log entry we rely on; all fields optional/defensive. The value/metadata
// blobs are where the human resource NAME actually lives.
export interface AuditLogEntry {
  id?: string;
  when?: string;
  actor?: { id?: string; email?: string; ip?: string; type?: string };
  action?: { type?: string; result?: boolean };
  resource?: { id?: string; type?: string };
  newValue?: unknown;
  newValueJson?: unknown;
  oldValue?: unknown;
  oldValueJson?: unknown;
  metadata?: unknown;
}

/** An alert event (the email shape) plus the audit-log id used for dedup. */
export interface SuspiciousEvent extends AuditAlertEvent {
  id: string;
}

export interface DetectConfig {
  /** Lowercased fragment that scopes account-wide logs to THIS app's resources. */
  appMatch: string;
  /** Lowercased sanctioned actor identities (emails and/or ids) — the CI deploy token. */
  deployActors: Set<string>;
  /** Event ids already alerted on a previous overlapping tick (dedup). */
  seenIds: Set<string>;
}

/* Scope an account-wide entry to this app by matching the fragment against the whole entry EXCEPT
 * the actor/ip — the resource NAME can appear in resource.id, action.type, newValue(Json)/
 * oldValue(Json), or metadata, and excluding the actor means a deployer whose email contains the
 * fragment can't masquerade as a resource. */
function touchesApp(e: AuditLogEntry, match: string): boolean {
  const hay = JSON.stringify([
    e.resource,
    e.action?.type,
    e.newValue,
    e.newValueJson,
    e.oldValue,
    e.oldValueJson,
    e.metadata,
  ]).toLowerCase();
  return hay.includes(match);
}

function actorIdentities(a: AuditLogEntry['actor']): string[] {
  return [a?.email, a?.id]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map((x) => x.toLowerCase());
}

function toSuspicious(e: AuditLogEntry): SuspiciousEvent {
  return {
    id: e.id ?? '',
    when: e.when ?? 'unknown',
    actor: e.actor?.email ?? e.actor?.id ?? 'unknown',
    actorType: e.actor?.type ?? 'unknown',
    actorIp: e.actor?.ip ?? 'unknown',
    action: e.action?.type ?? 'unknown',
    resource: [e.resource?.type, e.resource?.id].filter(Boolean).join(':') || 'unknown',
    // A missing result is NOT success — never tell the owner a denied attempt "ok".
    result: e.action?.result === false ? 'failed' : e.action?.result === true ? 'ok' : 'unknown',
  };
}

/* Pure core (where the security correctness lives): the app-scoped events, not already alerted,
 * whose actor is NOT in the sanctioned deploy allowlist. An EMPTY allowlist flags every change to
 * this app — the safe default (no false negatives): better a deploy receipt than a missed read. No
 * timestamp logic here by design; the `since` query bounds the window and seenIds handles dedup. */
export function detectSuspicious(entries: AuditLogEntry[], cfg: DetectConfig): SuspiciousEvent[] {
  const out: SuspiciousEvent[] = [];
  for (const e of entries) {
    if (!touchesApp(e, cfg.appMatch)) continue;
    if (e.id && cfg.seenIds.has(e.id)) continue;
    if (actorIdentities(e.actor).some((a) => cfg.deployActors.has(a))) continue;
    out.push(toSuspicious(e));
  }
  return out;
}

/* Newest parsed `when` across the fetched entries (epoch ms), floored at the current cursor — used
 * only to drain a truncated backlog forward. */
function newestFetchedMs(entries: AuditLogEntry[], floorMs: number): number {
  let max = floorMs;
  for (const e of entries) {
    const t = Date.parse(e.when ?? '');
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

async function fetchAuditLog(
  accountId: string,
  token: string,
  since: string,
): Promise<{ entries: AuditLogEntry[]; truncated: boolean }> {
  const all: AuditLogEntry[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `${API_BASE}/accounts/${accountId}/audit_logs` +
      `?since=${encodeURIComponent(since)}&per_page=${PER_PAGE}&page=${page}&direction=asc`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`audit-log API HTTP ${res.status}`);
    const body = (await res.json()) as {
      success?: boolean;
      result?: AuditLogEntry[];
      errors?: unknown;
    };
    if (body.success === false) {
      throw new Error(`audit-log API error: ${JSON.stringify(body.errors)}`);
    }
    const batch = body.result ?? [];
    all.push(...batch);
    if (batch.length < PER_PAGE) return { entries: all, truncated: false }; // last page
  }
  return { entries: all, truncated: true }; // hit MAX_PAGES with a full final page
}

async function loadIds(env: Env, key: string): Promise<Set<string>> {
  try {
    const raw = await env.SESSIONS.get(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

const loadSeen = (env: Env): Promise<Set<string>> => loadIds(env, SEEN_KEY);

/* Cron entrypoint (dispatched by `controller.cron` in src/cron/index.ts on SECURITY_WATCH_CRON).
 * Wrapped end-to-end: any failure degrades to an audit row and never rejects the cron. DORMANT by
 * default — no AUDIT_API_TOKEN ⇒ no-op + an audit row, so "unconfigured" is visible, not silent. */
export async function runAuditWatch(env: Env, now: Date = new Date()): Promise<void> {
  const db = makeDb(env);
  try {
    // The token is a Secrets Store binding in prod (a plain string in test/dev) — ALWAYS resolve
    // through getSecret(), never use it raw, or a binding object serializes to "[object Object]" in
    // the Bearer header and 401s. Resolved INSIDE the try because .get() can reject (secret deleted
    // after the binding was uncommented, or a transient Secrets Store fault) — "the whole run is
    // wrapped" has to mean it, or waitUntil swallows the rejection and no audit row is ever written.
    const token = await getSecret(env.AUDIT_API_TOKEN);
    const accountId = env.CF_ACCOUNT_ID;
    // For a security control, "unconfigured" must be VISIBLE, not silent. Only reachable when the
    // hourly trigger was deliberately uncommented without setting the token (both ship commented
    // together), so this is a half-configured tripwire shouting — not noise on an opted-out fork.
    if (!token || !accountId) {
      logEvent('audit_watch_unconfigured'); // AUDIT_API_TOKEN / CF_ACCOUNT_ID absent — skipping
      await db.audit.insert({
        actor_email: SYSTEM_ACTOR,
        action: 'audit_watch_skipped',
        payload_json: JSON.stringify({ reason: 'unconfigured' }),
      });
      return;
    }

    // Missing/evicted cursor → scan a recent lookback rather than skipping the gap between deploy
    // (or eviction) and the first tick.
    let cursor = await env.SESSIONS.get(CURSOR_KEY);
    if (!cursor) {
      cursor = new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString();
      // PERSIST the anchor immediately, before the fetch that might throw. Otherwise a failing
      // first tick (CF 500, a token still propagating) leaves nothing stored, and the next tick
      // re-anchors 1h back from ITS own `now` — so the window between the two ticks is never
      // scanned by anyone. With a persistently bad token that silently skips the whole outage.
      await env.SESSIONS.put(CURSOR_KEY, cursor);
      await db.audit.insert({
        actor_email: SYSTEM_ACTOR,
        action: 'audit_watch_initialized',
        payload_json: JSON.stringify({ since: cursor }),
      });
    }

    const cfg: DetectConfig = {
      appMatch: (env.AUDIT_MATCH ?? env.APP_NAME).toLowerCase(),
      deployActors: new Set(
        (env.AUDIT_DEPLOY_ACTORS ?? '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
      seenIds: await loadSeen(env),
    };

    const { entries, truncated } = await fetchAuditLog(accountId, token, cursor);
    const suspicious = detectSuspicious(entries, cfg);

    // Advance the cursor. Normal case: trail real time by SAFETY_LAG so the next tick re-queries
    // the lag window (catching late-indexed events). Truncated case: advance only to the newest
    // event we actually fetched, so the unfetched backlog is drained on later ticks instead of
    // being skipped. Never move it backwards (clock skew / a stale-but-newer stored cursor).
    const curMs = Date.parse(cursor);
    const nextMs = truncated ? newestFetchedMs(entries, curMs) : now.getTime() - SAFETY_LAG_MS;
    // DEFERRED, not applied here: committing the cursor before the alert is delivered is what
    // makes a failed send unrecoverable — the event ends up behind the cursor AND in seenIds, so
    // no later tick can re-find it. Commit only once the alert is out (or once we know a retry
    // cannot help). See the delivery block below.
    const commitCursor = async (): Promise<void> => {
      if (Number.isFinite(curMs) && nextMs > curMs) {
        await env.SESSIONS.put(CURSOR_KEY, new Date(nextMs).toISOString());
      }
    };
    if (truncated) {
      // Window truncated — the backlog drains next tick.
      logEvent('audit_watch_truncated', { fetched: entries.length });
      await db.audit.insert({
        actor_email: SYSTEM_ACTOR,
        action: 'audit_watch_truncated',
        payload_json: JSON.stringify({ fetched: entries.length }),
      });
    }

    if (suspicious.length === 0) {
      await commitCursor();
      logEvent('audit_watch_clear', { scanned: entries.length });
      return;
    }

    // Forensic rows FIRST — they survive even if delivery fails, and they are the DURABLE record
    // (the email is only the notification). Idempotent: a retry tick re-detects the same event by
    // design, so skip ids already recorded rather than duplicating the row every hour.
    const recorded = await loadIds(env, RECORDED_KEY);
    const fresh = suspicious.filter((s) => !s.id || !recorded.has(s.id));
    for (const s of fresh) {
      await db.audit.insert({
        actor_email: SYSTEM_ACTOR,
        action: 'security_audit_alert',
        target: s.actor,
        payload_json: JSON.stringify(s),
      });
    }
    if (fresh.length > 0) {
      const nextRecorded = [...fresh.map((s) => s.id).filter(Boolean), ...recorded];
      await env.SESSIONS.put(
        RECORDED_KEY,
        JSON.stringify([...new Set(nextRecorded)].slice(0, SEEN_RETENTION)),
      );
    }

    // Deliver through the SHARED alert seam, not a raw sendEmail. ALERT_EMAIL is contractually a
    // comma-separated LIST everywhere else in the kit, while the Email binding takes exactly one
    // address — so passing it raw made the tripwire's only channel die the moment a second
    // recipient was added, which docs/GO-LIVE.md REQUIRES to graduate an app to Stable. The seam
    // parses the list, fans out per recipient, adds the in-app extra recipients, and posts Slack.
    const summary = `${suspicious.length} unsanctioned change${suspicious.length === 1 ? '' : 's'}`;
    const slackText = [
      `:rotating_light: *${env.APP_NAME}* — ${summary} to infrastructure (${env.DASHBOARD_HOST})`,
      ...suspicious
        .slice(0, 10)
        .map((s) => `• ${s.when} — ${s.actor} — ${s.action} on ${s.resource}`),
      suspicious.length > 10 ? `…and ${suspicious.length - 10} more (see the audit log)` : '',
      'Not the deploy pipeline. If unexpected, treat SEAL_KEY as exposed and review deploy access.',
    ]
      .filter(Boolean)
      .join('\n');

    const delivery = await sendViaAlertSeam(
      env,
      'audit_watch',
      securityAlertEmail({ appName: env.APP_NAME, host: env.DASHBOARD_HOST, events: suspicious }),
      slackText,
    );

    // A tripwire that cannot reach anyone is the failure mode that matters most, so it is never
    // inferred from silence: it gets its own audited, digest-visible row.
    const reached = delivery.emailed > 0 || delivery.webhook;
    if (!reached) {
      logEvent('audit_watch_alert_undelivered', delivery);
      await db.audit.insert({
        actor_email: SYSTEM_ACTOR,
        action: 'audit_watch_alert_undelivered',
        payload_json: JSON.stringify({ events: suspicious.length, ...delivery }),
      });
    }

    // Retry ONLY a real transport failure — every attempt errored and no webhook absorbed it.
    // Holding the cursor + seenIds makes the next tick re-detect and re-send. Deliberately NOT
    // retried: an empty recipient list, and the no-EMAIL-binding fail-open (outcome 'skipped',
    // so failed === 0) — a retry cannot conjure a channel, and looping would re-alert forever.
    if (!reached && delivery.failed > 0) {
      logEvent('audit_watch_retry_held'); // cursor + seen-ids held; the alert retries next tick
      return;
    }

    await commitCursor();
    // Remember these ids so the lag-window overlap doesn't re-alert them.
    const remembered = [...suspicious.map((s) => s.id).filter(Boolean), ...cfg.seenIds];
    await env.SESSIONS.put(
      SEEN_KEY,
      JSON.stringify([...new Set(remembered)].slice(0, SEEN_RETENTION)),
    );
  } catch (err) {
    // Quiet degrade: never reject the cron; leave the cursor wherever it was so the next tick
    // re-covers this window. A failure is itself audited.
    logEvent('audit_watch_run_failed', { err });
    await db.audit.insert({
      actor_email: SYSTEM_ACTOR,
      action: 'audit_watch_error',
      payload_json: JSON.stringify({ error: String(err) }),
    });
  }
}
