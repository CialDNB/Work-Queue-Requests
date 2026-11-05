-- Read ledger (Fleet Ledger K2a) — the table src/data/aurora.ts writes on every Aurora read.
--
-- WHY BOTH THIS AND schema.sql. `schema.sql` is the fresh-install baseline (applied at provision
-- and in tests); this migration is what an ALREADY-DEPLOYED database needs. Both carry the same
-- statements, all `IF NOT EXISTS`, so applying either or both is safe in any order.
--
-- ADOPTING FORKS: `migrations/` is deliberately NOT in the /kit-upgrade diff set (a fork's
-- migration numbering is its own). When you adopt this, copy the file and RENUMBER it to your
-- next free ordinal — the contents need no edit.
--
-- Semantics live with the table, in schema.sql. The two that matter: no column can ever hold SQL
-- text or bind values (Decision D6), and a NULL row_count means ATTEMPTED, not zero (Decision D3).

CREATE TABLE IF NOT EXISTS read_log (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  app TEXT NOT NULL,
  env TEXT NOT NULL,
  route TEXT NOT NULL,
  source TEXT NOT NULL,
  source_class TEXT NOT NULL CHECK (source_class IN ('client', 'internal')),
  view TEXT NOT NULL,
  query_name TEXT NOT NULL,
  target TEXT,
  row_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_read_log_created ON read_log(created_at);
CREATE INDEX IF NOT EXISTS idx_read_log_principal ON read_log(principal, created_at);
CREATE INDEX IF NOT EXISTS idx_read_log_source ON read_log(source, created_at);

CREATE TRIGGER IF NOT EXISTS read_log_count_patch_only
BEFORE UPDATE ON read_log
WHEN OLD.row_count IS NOT NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.principal IS NOT OLD.principal
  OR NEW.app IS NOT OLD.app
  OR NEW.env IS NOT OLD.env
  OR NEW.route IS NOT OLD.route
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
