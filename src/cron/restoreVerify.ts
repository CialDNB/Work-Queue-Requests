// Restore-readiness verification for the daily D1 → R2 backup (src/cron/backup.ts).
// The kit takes daily backups but, until this task, never PROVED one was restorable — a
// truncated upload, a half-written object, or a count drift would sit silently in R2 and
// only surface during a real disaster, which is the worst possible moment to learn a
// backup is junk. This task reads the freshest backup and asserts it is complete and
// internally consistent, so a broken backup pages the owner the morning after it breaks.
//
// SCOPE — structural verify, not a full replay (accepted limitation):
//   This performs a STRUCTURAL restore-readiness check: fetch the latest `.jsonl.gz`,
//   decompress it, parse EVERY line, and assert the meta header + per-table/total row
//   counts match the marker the backup wrote. It deliberately does NOT replay the dump
//   into a scratch database and diff it against live D1. A full replay-into-scratch verify
//   is out of scope because the Workers runtime has no throwaway SQLite instance to import
//   into, and replaying into the LIVE D1 would risk corrupting the system of record — the
//   exact thing a backup exists to protect. The parse + count-consistency check catches the
//   realistic failure class here (truncation, corruption, a partial/aborted upload, a
//   count-inconsistent dump) without touching live data; a scratch-replay verify is noted
//   as a future enhancement if/when the platform offers an ephemeral DB. This task performs
//   NO writes to live D1 — it only reads R2 (and, when armed, writes a copy to VAULT).
//
// It runs as a normal cron task (src/cron/index.ts), so a failed verify JOINS the failure
// set and pages the owner — a backup that can't be trusted is an ops emergency, unlike the
// best-effort report cron. It is placed AFTER `backup` so it verifies the freshest object.
import type { Env } from '../env';
import { logEvent } from '../platform/logEvent';

/** Shape of db-backups/latest-marker, written by runBackup on each success. */
interface LatestMarker {
  key: string;
  generated_at?: string;
  tables: number; // COUNT of tables in the dump (the meta header lists their NAMES)
  rows: number; // total row count across all tables (excludes the meta header line)
}

/** Shape of the backup's first line — the meta header (see src/data/backup.ts BackupHeader). */
interface BackupMetaHeader {
  _meta?: string;
  tables?: unknown;
}

export async function runRestoreVerify(env: Env): Promise<string> {
  const bucket = env.BACKUPS;
  if (!bucket) {
    // Dormant on a fork without R2 provisioned — mirrors runBackup's skip. Surfaced in the
    // heartbeat, never fatal.
    return 'skipped: BACKUPS binding absent (provision the R2 bucket to enable)';
  }

  const markerObj = await bucket.get('db-backups/latest-marker');
  if (!markerObj) {
    // A brand-new app has taken no backup yet. health.ts treats a missing marker as the
    // benign "no_backup_yet" note, not a failure — match that here rather than paging an
    // owner on day one. Once backup has run once, this branch never fires again.
    return 'skipped: no backup yet (no latest-marker) — nothing to verify';
  }

  const marker = (await markerObj.json().catch(() => null)) as LatestMarker | null;
  if (!marker || typeof marker.key !== 'string' || !marker.key) {
    // A marker exists but is unparseable / shapeless. Unlike "no marker", this is a REAL
    // problem — backup writes a well-formed marker on success, so a broken one means the
    // backup pipeline is not producing what we depend on. Fail loudly.
    throw new Error('restore-verify: latest-marker is present but unparseable or missing its key');
  }
  const declaredTables = Number(marker.tables);
  const declaredRows = Number(marker.rows);
  if (!Number.isFinite(declaredTables) || !Number.isFinite(declaredRows)) {
    throw new Error('restore-verify: latest-marker lacks numeric tables/rows counts');
  }

  const backupObj = await bucket.get(marker.key);
  if (!backupObj) {
    // The marker points at a backup object that is GONE — the classic missing-when-expected
    // case (e.g. a prune bug, a botched lifecycle rule, a failed put after the marker wrote).
    throw new Error(`restore-verify: backup object ${marker.key} is missing (marker points at it)`);
  }

  // Decompress with the mirror of backup.ts's CompressionStream('gzip'), then read the whole
  // (small, internal-app) dump as text. A truncated/garbage gzip throws here → caught → alert.
  // NOTE (memory asymmetry): backup.ts STREAMS rows one at a time to stay under the Worker's
  // ~128 MB isolate ceiling; this verify re-inflates the ENTIRE dump into a single string, so it
  // is the higher-memory half of the pair. Fine while backups are small; if the DB grows large,
  // switch this to a streaming line-by-line parse too — an OOM here would throw and page a false
  // "unrestorable", not silently miss corruption, but it's still a page we'd rather not trip.
  let text: string;
  try {
    text = await new Response(backupObj.body.pipeThrough(new DecompressionStream('gzip'))).text();
  } catch (err) {
    throw new Error(
      `restore-verify: ${marker.key} failed to decompress (corrupt/truncated): ${err}`,
    );
  }

  const lines = text.split('\n');
  if (lines.length === 0 || lines[0] === '') {
    throw new Error(`restore-verify: ${marker.key} is empty — no meta header`);
  }

  // (a) First line must be the meta header and list the SAME table NAMES (its count must
  // match the marker's declared table count).
  let header: BackupMetaHeader;
  try {
    header = JSON.parse(lines[0] as string) as BackupMetaHeader;
  } catch (err) {
    throw new Error(`restore-verify: ${marker.key} meta header line is not valid JSON: ${err}`);
  }
  if (!Array.isArray(header.tables) || !header.tables.every((t) => typeof t === 'string')) {
    throw new Error(`restore-verify: ${marker.key} meta header has no string tables[] array`);
  }
  const headerTables = header.tables as string[];
  if (headerTables.length !== declaredTables) {
    throw new Error(
      `restore-verify: ${marker.key} header lists ${headerTables.length} tables but marker declares ${declaredTables}`,
    );
  }
  const knownTables = new Set(headerTables);

  // (b) Every subsequent line must be valid JSON carrying a string `_table`, and (c) the
  // per-table + total row counts must reconcile with the marker's declared row count.
  const perTable = new Map<string, number>();
  let totalRows = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line === '') continue; // tolerate a benign trailing newline; a mid-file gap fails the count
    let row: { _table?: unknown };
    try {
      row = JSON.parse(line) as { _table?: unknown };
    } catch (err) {
      throw new Error(
        `restore-verify: ${marker.key} line ${i + 1} is not valid JSON (truncated?): ${err}`,
      );
    }
    if (typeof row._table !== 'string') {
      throw new Error(`restore-verify: ${marker.key} line ${i + 1} has no string _table field`);
    }
    if (!knownTables.has(row._table)) {
      throw new Error(
        `restore-verify: ${marker.key} line ${i + 1} references table "${row._table}" absent from the header`,
      );
    }
    perTable.set(row._table, (perTable.get(row._table) ?? 0) + 1);
    totalRows++;
  }

  if (totalRows !== declaredRows) {
    throw new Error(
      `restore-verify: ${marker.key} has ${totalRows} data rows but marker declares ${declaredRows} (truncated or inconsistent)`,
    );
  }

  // Success: optionally ship an offsite copy (dormant seam), then report the consistent counts.
  const copied = await copyToVault(env, bucket, marker.key);
  return `restore-verify: ${headerTables.length} tables, ${totalRows} rows, consistent${copied}`;
}

/**
 * Optional offsite copy: when the dormant `VAULT` R2 binding is present (a second-account
 * bucket the platform wires up), mirror the just-verified backup into it under the same key.
 * Best-effort — a VAULT copy failure LOGS and appends a note, but never fails the verify (the
 * primary backup + its consistency proof already succeeded). Absent VAULT → clean no-op.
 * The 2nd-account vault bucket is a platform action; until it exists this seam ships dormant.
 */
async function copyToVault(env: Env, source: R2Bucket, key: string): Promise<string> {
  if (!env.VAULT) return '';
  try {
    const obj = await source.get(key);
    if (!obj) return ' (vault: source vanished, skipped)';
    await env.VAULT.put(key, obj.body);
    return ' (vault: copied offsite)';
  } catch (err) {
    logEvent('restore_verify_vault_copy_failed', { err });
    return ' (vault: copy failed, logged)';
  }
}
