import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeScheduledRun } from '../src/cron';
import type { Env } from '../src/env';
import { healthResponse } from '../src/health';
import { applySchema, seedDb } from './helpers/db';
import { BASE } from './helpers/http';

interface Health {
  status: string;
  app: string;
  env: string;
  version: string;
  checks: Record<string, unknown>;
  notes: string[];
}

describe('/_health', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('is public, uncached, and reports ok with check timings', async () => {
    const res = await SELF.fetch(`${BASE}/_health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Health;
    expect(body.status).toBe('ok');
    expect(body.app).toBe('work-queue-requests');
    expect(typeof body.checks.d1_ms).toBe('number');
    expect(typeof body.checks.kv_ms).toBe('number');
    expect(body.notes).toContain('no_heartbeat_yet'); // informational in test env
  });

  it('reflects heartbeat and backup state after a cron run', async () => {
    await executeScheduledRun(env);
    const res = await SELF.fetch(`${BASE}/_health`);
    const body = (await res.json()) as Health;
    expect(body.status).toBe('ok');
    expect(body.notes).not.toContain('no_heartbeat_yet');
    expect(body.checks.cron_last_heartbeat).toBeTruthy();
    expect(body.checks.last_backup_seen).toBeTruthy();
  });

  it('degrades in production when the EMAIL binding is absent (misconfig surfaced)', async () => {
    // The test runtime has no EMAIL binding (email is fail-open in tests). In production that
    // means magic-link login would silently break, so /_health degrades and names it.
    const res = await healthResponse({ ...env, APP_ENV: 'production' } as Env);
    const body = (await res.json()) as Health;
    expect(body.status).toBe('degraded');
    expect(body.notes).toContain('email_binding_absent');
    expect(body.checks.email_binding).toBe(false);
  });

  it('degrades when the backup marker is stale (silent backup failure surfaces)', async () => {
    // A marker whose backup logical time is >26h old means the daily backup has been failing
    // silently — the cron still runs and heartbeats, but runBackup throws before refreshing the
    // marker. /_health must degrade on that staleness, not just on an absent marker.
    const stale = new Date(Date.now() - 30 * 3_600_000).toISOString();
    await env.BACKUPS!.put(
      'db-backups/latest-marker',
      JSON.stringify({ key: 'db-backups/old.jsonl.gz', generated_at: stale, tables: 3, rows: 0 }),
    );
    try {
      const res = await healthResponse(env);
      const body = (await res.json()) as Health;
      expect(body.status).toBe('degraded');
      expect(body.notes).toContain('backup_stale');
      expect(body.checks.last_backup_seen).toBe(stale);
    } finally {
      await env.BACKUPS!.delete('db-backups/latest-marker'); // don't leak the stale marker
    }
  });

  it('falls back to the R2 upload time when the marker timestamp is unparseable', async () => {
    // A corrupt/partial/foreign marker can be valid JSON with a non-ISO generated_at. It must NOT
    // read as fresh via NaN (Date.parse → NaN, NaN > 26 is false) — fall back to the R2 upload
    // time so last_backup_seen stays a real timestamp and the staleness math still runs.
    await env.BACKUPS!.put(
      'db-backups/latest-marker',
      JSON.stringify({ key: 'db-backups/x.jsonl.gz', generated_at: 'not-a-real-date' }),
    );
    try {
      const res = await healthResponse(env);
      const body = (await res.json()) as Health;
      expect(body.checks.last_backup_seen).not.toBe('not-a-real-date'); // not the garbage value
      expect(Number.isNaN(Date.parse(body.checks.last_backup_seen as string))).toBe(false); // valid
      expect(typeof body.checks.last_backup_age_hours).toBe('number'); // computed, not NaN-skipped
      expect(body.notes).not.toContain('backup_stale'); // upload time ≈ now → fresh
    } finally {
      await env.BACKUPS!.delete('db-backups/latest-marker');
    }
  });
});
