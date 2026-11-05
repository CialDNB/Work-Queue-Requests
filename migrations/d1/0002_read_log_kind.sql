-- Read ledger, second stream (Fleet Ledger K2b) — teach `read_log` to hold ordinary D1 reads.
--
-- WHY BOTH THIS AND schema.sql. `schema.sql` is the fresh-install baseline (applied at provision
-- and in tests); this migration is what an ALREADY-DEPLOYED database needs. Both end in the same
-- shape. A fresh install applies the baseline (already in the new shape) and then this file,
-- which rebuilds a table it finds empty — same shape out, zero rows moved. An existing database
-- rebuilds with its rows preserved.
--
-- ADOPTING FORKS: `migrations/` is deliberately NOT in the /kit-upgrade diff set (a fork's
-- migration numbering is its own). When you adopt this, copy the file and RENUMBER it to your
-- next free ordinal — the contents need no edit.
--
-- WHAT CHANGES, AND WHY IT NEEDS A REBUILD RATHER THAN AN `ALTER`:
--
--   1. NEW COLUMN `kind` ('aurora' | 'd1') — WHERE the data lives. `source_class` already
--      existed but means something else entirely: client-vs-internal SENSITIVITY (Decision D3).
--      Those are different axes, so neither can stand in for the other. K1's daily digest splits
--      `reads_d1` from `reads_aurora` ON THIS COLUMN (src/data/activity.ts) and R2 alerts on the
--      two streams separately. `DEFAULT 'aurora'` is what makes this a no-backfill change: every
--      row written before K2b came from src/data/aurora.ts, so the default is not a guess — it is
--      the fact. (src/data/activity.ts already probes for this column at runtime and reports
--      everything as `reads_aurora` until it appears, precisely so this migration can land after
--      the reporter.)
--
--   2. `view` and `query_name` RELAXED TO NULLABLE. An ordinary D1 read has no schema-qualified
--      view to name, so the K2a `NOT NULL` made a d1 row unrepresentable. SQLite has no
--      `ALTER COLUMN`, so dropping a `NOT NULL` is a table rebuild — the documented 12-step
--      procedure, minus the pragmas D1 does not expose. The aurora stream keeps its guarantee
--      through a table-level CHECK instead: `kind = 'd1' OR (view IS NOT NULL AND query_name IS
--      NOT NULL)`. A private-database read that cannot name the view it read stays impossible.
--
-- NOT CHANGED, and worth saying out loud: no column that could hold a query string or a bind
-- value is added here, because none can ever be (Decision D6 — schema.sql / src/data/readLog.ts).
-- `query_name` on a d1 row is the repository METHOD name (`list`, `getActive`); `source` is the
-- repository name. Both are identifiers from the code, never anything a caller supplied.

-- RETRY SAFETY. A rebuild has a window: between `DROP TABLE read_log` and the RENAME below there
-- is exactly one copy of the ledger, and it is in the scratch table. So NOTHING in this file ever
-- drops that scratch table — an earlier draft opened with `DROP TABLE IF EXISTS read_log_k2b`,
-- which on a retry after a mid-file failure would have destroyed the only surviving copy. With
-- `IF NOT EXISTS` + `INSERT OR IGNORE` the file is re-runnable instead: a retry after a failed
-- DROP re-copies harmlessly and finishes, and a retry after a failed RENAME stops on "no such
-- table: read_log" with every row still sitting in `read_log_k2b`, one RENAME from recovery.
-- Stuck-but-intact beats clean-but-empty on a table whose whole job is to be the record.
CREATE TABLE IF NOT EXISTS read_log_k2b (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  app TEXT NOT NULL,
  env TEXT NOT NULL,
  route TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'aurora' CHECK (kind IN ('aurora', 'd1')),
  source TEXT NOT NULL,
  source_class TEXT NOT NULL CHECK (source_class IN ('client', 'internal')),
  view TEXT,
  query_name TEXT,
  target TEXT,
  row_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (kind = 'd1' OR (view IS NOT NULL AND query_name IS NOT NULL))
);

-- Columns named explicitly on BOTH sides: the source table may or may not already carry `kind`
-- (a fresh install applies the new baseline first), and `SELECT *` would break in one of those
-- two orders. The literal 'aurora' is the no-backfill classification described above.
-- `OR IGNORE` makes the copy idempotent on a retry (see the retry-safety note above); the only
-- thing it can skip is a primary-key collision, i.e. a row this file already copied.
INSERT OR IGNORE INTO read_log_k2b
  (id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, target, row_count, created_at)
SELECT
  id, request_id, principal, app, env, route, 'aurora', source, source_class, view, query_name, target, row_count, created_at
FROM read_log;

-- Drops the old indexes and triggers with it; both are recreated below.
DROP TABLE read_log;
ALTER TABLE read_log_k2b RENAME TO read_log;

CREATE INDEX IF NOT EXISTS idx_read_log_created ON read_log(created_at);
CREATE INDEX IF NOT EXISTS idx_read_log_principal ON read_log(principal, created_at);
CREATE INDEX IF NOT EXISTS idx_read_log_source ON read_log(source, created_at);

-- Reinstated verbatim from schema.sql, plus `kind` in the immutable-column list: the count patch
-- is still the ONLY legal UPDATE, and it still may not move anything else. Rewriting which stream
-- a recorded read belongs to is exactly as forbidden as rewriting who performed it.
CREATE TRIGGER IF NOT EXISTS read_log_count_patch_only
BEFORE UPDATE ON read_log
WHEN OLD.row_count IS NOT NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.principal IS NOT OLD.principal
  OR NEW.app IS NOT OLD.app
  OR NEW.env IS NOT OLD.env
  OR NEW.route IS NOT OLD.route
  OR NEW.kind IS NOT OLD.kind
  OR NEW.source IS NOT OLD.source
  OR NEW.source_class IS NOT OLD.source_class
  OR NEW.view IS NOT OLD.view
  OR NEW.query_name IS NOT OLD.query_name
  OR NEW.target IS NOT OLD.target
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'read_log is append-only except the one-shot row_count patch');
END;

CREATE TRIGGER IF NOT EXISTS read_log_no_replace
BEFORE INSERT ON read_log
WHEN EXISTS (SELECT 1 FROM read_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'read_log rows are never overwritten');
END;
