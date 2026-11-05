// D1 export for the daily backup cron. Lives in src/data/ because it reads the
// database — the cron layer receives serialized lines, never a DB handle.
//
// Streamed TABLE-BY-TABLE: the generator holds at most one table's rows in memory at a
// time and yields them, instead of building a single array of every row across every
// table (the old shape, which also got joined into one megastring before gzip — two
// full in-memory copies that risked the 128 MB Worker ceiling as audit_log / ai_usage
// grow). The cron pipes these lines straight into gzip → R2.
import type { Env } from '../env';

const SKIP_PREFIXES = ['sqlite_', '_cf', 'd1_'];

// Ephemeral credentials that must never land in a backup. magic_links rows hold
// plaintext, possibly-still-valid login tokens (15-min TTL) — a daily 03:00 dump can
// capture an unconsumed one, and a backup is exactly where it shouldn't live. They are
// single-use and short-lived, so there is no restore value in keeping them either.
// (api_tokens stores only a SHA-256 hash, so it stays.)
const EXCLUDE_TABLES = new Set(['magic_links']);

// Whole table FAMILIES that never land in a backup, by name prefix, so a table added to the family
// later is excluded from its first night.
//   agent_   the in-app agent's transcript store (migrations/d1/0006_agent_tables.sql): message
//            text, held transcripts, approval arguments, feedback. Content with a retention
//            promise (AGENT_TRANSCRIPT_RETENTION_DAYS) and an erasure route; a cleartext copy in R2
//            would outlive both by the backup window (PIA §7.6). This narrows what the backup
//            lifecycle rule has to bound; it does not verify that rule, so PIA C19 stays open for
//            every other table. EVERY agent_* table, not just the content ones: thread ownership
//            and feedback ratings are personal data too, and a partial set cannot restore — the
//            dump is in name order, so `agent_approvals` would be inserted before its FK parent
//            `agent_threads` and refused. The cost is deliberate: transcripts are NOT restorable
//            after a D1 loss (DECISIONS 2026-10-04; owner question 3's default, DPO-facing).
//            The prefix is the kit's: a fork table named agent_* would be skipped too, so
//            test/data/agent-tables.test.ts fails on any agent_* table the kit does not own.
const EXCLUDE_PREFIXES = ['agent_'];

// Secret-bearing VALUES to scrub from a backup even when the table is otherwise worth keeping.
// app_settings.value_json (key='alerting') embeds the Slack webhook URL — a post-only channel
// credential — so redact just that field and keep the rest of the row. A restore then carries no
// live webhook (it falls back to the ALERT_WEBHOOK_URL env default; an admin re-sets the override
// in-app). Extend as new secret-bearing settings appear.
const ROW_REDACTORS: Record<string, (row: Record<string, unknown>) => Record<string, unknown>> = {
  app_settings: (row) => {
    if (row.key !== 'alerting' || typeof row.value_json !== 'string') return row;
    try {
      const v = JSON.parse(row.value_json) as Record<string, unknown>;
      if (v && typeof v === 'object' && v.slackWebhookUrl) {
        return { ...row, value_json: JSON.stringify({ ...v, slackWebhookUrl: '[redacted]' }) };
      }
    } catch {
      // Unparseable settings JSON: leave as-is (the write-time schema prevents this in practice).
    }
    return row;
  },
};

export interface BackupHeader {
  _meta: string;
  app: string;
  env: string;
  generated_at: string;
  tables: string[];
}

async function backupTables(db: D1Database): Promise<string[]> {
  const res = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  return res.results
    .map((r) => r.name)
    .filter(
      (name) =>
        !SKIP_PREFIXES.some((p) => name.startsWith(p)) &&
        !EXCLUDE_PREFIXES.some((p) => name.startsWith(p)) &&
        !EXCLUDE_TABLES.has(name),
    );
}

/**
 * Yields JSON Lines for the backup: one meta header first, then one line per row tagged
 * with `_table`. Reads ONE table into memory at a time, so peak memory is a single table
 * — not the whole database.
 */
export async function* streamBackupLines(env: Env): AsyncGenerator<string, void, unknown> {
  const db = env.DB;
  const tables = await backupTables(db);
  const header: BackupHeader = {
    _meta: `${env.APP_NAME}-d1-backup`,
    app: env.APP_NAME,
    env: env.APP_ENV,
    generated_at: new Date().toISOString(),
    tables,
  };
  yield JSON.stringify(header);

  for (const table of tables) {
    const redact = ROW_REDACTORS[table];
    // Table names come from sqlite_master (not user input); quoting is defense-in-depth.
    const rows = await db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();
    for (const row of rows.results) {
      const r = row as Record<string, unknown>;
      yield JSON.stringify({ _table: table, ...(redact ? redact(r) : r) });
    }
  }
}
