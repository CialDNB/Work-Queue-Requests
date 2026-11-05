// Daily D1 → R2 backup as gzipped JSON Lines: db-backups/YYYY-MM-DD.jsonl.gz.
// Internal-app databases are small, so daily full exports are cheap and the restore
// story stays trivial (one file = one day). Restore runbook:
// docs/IMPLEMENTATION-HANDBOOK.md → "Backups & restore".
//
// The dump is STREAMED row-by-row through gzip into R2 (never fully buffered), and old
// daily backups are pruned to a retention window so R2 doesn't grow without bound.
import { streamBackupLines } from '../data/backup';
import type { Env } from '../env';

const DEFAULT_RETENTION_DAYS = 30;

function retentionDays(env: Env): number {
  const n = Number(env.BACKUP_RETENTION_DAYS ?? '');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

export async function runBackup(env: Env): Promise<string> {
  if (!env.BACKUPS) {
    // Surfaced in the heartbeat payload and as a /_health note — visible, not fatal.
    return 'skipped: BACKUPS binding absent (provision the R2 bucket to enable)';
  }
  const day = new Date().toISOString().slice(0, 10);
  const key = `db-backups/${day}.jsonl.gz`;

  // Stream JSONL row-by-row through gzip; only the COMPRESSED result is materialized for
  // the R2 put (R2 needs a known length). We never build the full raw-row array or the
  // joined megastring the old code did — peak raw memory is a single table, and the
  // buffered bytes are the (small) compressed backup.
  const { readable, writable } = new CompressionStream('gzip');
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const compressed = new Response(readable).arrayBuffer();

  let lineCount = 0;
  let tables = 0;
  try {
    for await (const line of streamBackupLines(env)) {
      await writer.write(enc.encode(lineCount === 0 ? line : `\n${line}`));
      if (lineCount === 0) tables = (JSON.parse(line) as { tables: string[] }).tables.length;
      lineCount++;
    }
    await writer.close();
  } catch (err) {
    await writer.abort(err).catch(() => {});
    throw err;
  }
  await env.BACKUPS.put(key, await compressed);
  const rows = Math.max(0, lineCount - 1); // minus the meta header line

  await env.BACKUPS.put(
    'db-backups/latest-marker',
    JSON.stringify({ key, generated_at: new Date().toISOString(), tables, rows }),
  );

  const pruned = await pruneOldBackups(env, day);
  return `wrote ${key} (${tables} tables, ${rows} rows); pruned ${pruned} backup(s) past retention`;
}

/**
 * Delete dated daily backups older than the retention window. Keeps today's file, the
 * latest-marker, and any non-dated object (left for a human to reason about).
 */
async function pruneOldBackups(env: Env, today: string): Promise<number> {
  const bucket = env.BACKUPS;
  if (!bucket) return 0;
  const cutoffMs = Date.now() - retentionDays(env) * 86_400_000;
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: 'db-backups/', cursor });
    for (const obj of page.objects) {
      const m = obj.key.match(/^db-backups\/(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/);
      if (!m || m[1] === today) continue; // marker / non-dated / today's → keep
      if (Date.parse(`${m[1]}T00:00:00Z`) < cutoffMs) {
        await bucket.delete(obj.key);
        removed++;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}
