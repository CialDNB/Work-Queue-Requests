// Public, unauthenticated health endpoint. CI's post-deploy smoke check requires
// "ok" or "degraded"; "unhealthy" (D1 down) returns 503 and fails the deploy loudly.
// Exposes operational facts only — never user data, never internals.
import { pingDb } from './data';
import type { Env } from './env';

export type HealthStatus = 'ok' | 'degraded' | 'unhealthy';

export interface HealthResult {
  status: HealthStatus;
  checks: Record<string, unknown>;
  notes: string[];
}

// The structured health computation, shared by the HTTP endpoint (healthResponse) and the fleet
// report cron (src/cron/reportToRegistry.ts) — one place that decides ok/degraded/unhealthy and
// the check numbers, so the reported status matches exactly what /_health serves.
export async function computeHealth(env: Env): Promise<HealthResult> {
  let status: HealthStatus = 'ok';
  const notes: string[] = [];
  const checks: Record<string, unknown> = {};
  const degrade = () => {
    if (status === 'ok') status = 'degraded';
  };

  // D1 — the system of record; unreachable means unhealthy.
  const d1Start = Date.now();
  try {
    await pingDb(env);
    checks.d1_ms = Date.now() - d1Start;
  } catch {
    status = 'unhealthy';
    checks.d1_ms = null;
    notes.push('d1_unreachable');
  }

  // KV — sessions live here; failure degrades.
  const kvStart = Date.now();
  try {
    await env.SESSIONS.put('health:ping', '1', { expirationTtl: 60 });
    await env.SESSIONS.get('health:ping');
    checks.kv_ms = Date.now() - kvStart;
  } catch {
    degrade();
    checks.kv_ms = null;
    notes.push('kv_failed');
  }

  // R2 backups — optional binding; absence is a note, not a failure.
  if (env.BACKUPS) {
    try {
      // GET (not HEAD) so we can read the marker's own `generated_at` — the backup's logical
      // time, refreshed on each SUCCESS (src/cron/backup.ts). A present-but-STALE marker is the
      // silent-backup-failure signal: the daily cron still runs and heartbeats, but runBackup
      // throws before refreshing the marker, so backups quietly stop. Degrade on staleness
      // (>26h, the daily window — same as the heartbeat), not just on absence.
      const marker = await env.BACKUPS.get('db-backups/latest-marker');
      checks.r2_ok = true;
      if (!marker) {
        checks.last_backup_seen = null;
        notes.push('no_backup_yet');
      } else {
        const meta = (await marker.json().catch(() => null)) as { generated_at?: string } | null;
        const parsed = meta?.generated_at ? Date.parse(meta.generated_at) : Number.NaN;
        // Prefer the marker's logical time; fall back to the R2 upload time when generated_at is
        // missing OR unparseable. A corrupt/partial/foreign marker (non-ISO generated_at) must not
        // read as "fresh" — without this, Date.parse → NaN and `NaN > 26` is false, silently
        // skipping the degrade. seenMs is therefore always finite.
        const seenMs = Number.isFinite(parsed) ? parsed : marker.uploaded.getTime();
        const ageHours = (Date.now() - seenMs) / 3_600_000;
        checks.last_backup_seen = new Date(seenMs).toISOString();
        checks.last_backup_age_hours = Math.round(ageHours * 10) / 10;
        if (ageHours > 26) {
          degrade();
          notes.push('backup_stale');
        }
      }
    } catch {
      degrade();
      checks.r2_ok = false;
      notes.push('r2_failed');
    }
  } else {
    checks.r2_ok = null;
    notes.push('backups_binding_absent');
  }

  // Cron heartbeat — stale (>26h) or missing means the daily ops loop isn't running.
  try {
    const last = await env.SESSIONS.get('heartbeat:last');
    if (!last) {
      notes.push('no_heartbeat_yet');
      if (env.APP_ENV === 'production' || env.APP_ENV === 'staging') degrade();
    } else {
      const ageHours = (Date.now() - Date.parse(last)) / 3_600_000;
      checks.cron_last_heartbeat = last;
      checks.cron_heartbeat_age_hours = Math.round(ageHours * 10) / 10;
      if (ageHours > 26) {
        degrade();
        notes.push('heartbeat_stale');
      }
    }
  } catch {
    notes.push('heartbeat_check_failed');
  }

  // Email transport binding — in production it must be present; a regression that drops it
  // would silently break magic-link login (the transport fails open). Absent in prod →
  // degrade so the dashboard surfaces it. (Necessary, not sufficient: zone email must also be
  // onboarded for delivery — that is the email-delivery gate in docs/GO-LIVE.md.)
  if (env.APP_ENV === 'production' && !env.EMAIL) {
    degrade();
    checks.email_binding = false;
    notes.push('email_binding_absent');
  }

  return { status, checks, notes };
}

export async function healthResponse(env: Env): Promise<Response> {
  const { status, checks, notes } = await computeHealth(env);
  return Response.json(
    {
      status,
      app: env.APP_NAME,
      env: env.APP_ENV,
      version: env.APP_BUILD_VERSION ?? 'unversioned',
      checks,
      notes,
      checked_at: new Date().toISOString(),
    },
    { status: status === 'unhealthy' ? 503 : 200, headers: { 'cache-control': 'no-store' } },
  );
}
