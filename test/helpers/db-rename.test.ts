// The one harness test that renames a table seedDb() resets by name (TABLES in test/helpers/db.ts),
// so it runs in a file — and a database — of its own: after it, every seedDb() in the same file
// would fail on "no such table: notes", as the README's hand-kept-TABLES note says it must.
//
// What it pins: a RENAMEd table keeps its indexes, and the per-call baseline, whose
// `CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at)` still names the old table,
// skips that statement rather than throw. IF NOT EXISTS is no help: SQLite resolves the ON-table
// before it checks whether the index exists. db.test.ts covers the trigger half (app_identity).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applySchemaWith, MIGRATIONS, type Migration } from './db';

const RENAME_INDEXED_TABLE: Migration = {
  name: '9009_synthetic_rename_notes.sql',
  sql: 'ALTER TABLE notes RENAME TO synthetic_documents;',
};
const WITH_RENAME = [...MIGRATIONS, RENAME_INDEXED_TABLE];

async function tableExists(name: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(name)
    .first();
  return row !== null;
}

async function indexTable(name: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?",
  )
    .bind(name)
    .first<{ tbl_name: string }>();
  return row?.tbl_name ?? null;
}

describe('test harness — a migration that renames an indexed baseline table', () => {
  it('keeps the index on the renamed table, and the baseline never re-targets the old name', async () => {
    await applySchemaWith(WITH_RENAME);
    // The call that used to throw "no such table: main.notes".
    await applySchemaWith(WITH_RENAME);
    await applySchemaWith(MIGRATIONS); // the real list knows nothing of 9009, and must not undo it

    expect(await tableExists('notes')).toBe(false);
    expect(await tableExists('synthetic_documents')).toBe(true);
    expect(await indexTable('idx_notes_created')).toBe('synthetic_documents');
  });

  it('a renamed table a test drops comes back under its new name, index included', async () => {
    await env.DB.prepare('DROP TABLE synthetic_documents').run();
    await applySchemaWith(MIGRATIONS);
    expect(await tableExists('notes')).toBe(false);
    expect(await indexTable('idx_notes_created')).toBe('synthetic_documents');
  });
});
