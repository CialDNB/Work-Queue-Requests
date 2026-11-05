-- Read ledger, third stream (PIA C15) — teach `read_log` to hold reads of an UPSTREAM HTTP source.
--
-- WHY BOTH THIS AND schema.sql. `schema.sql` is the fresh-install baseline (applied at provision
-- and in tests); this migration is what an ALREADY-DEPLOYED database needs. Both end in the same
-- shape. A fresh install applies the baseline (already in the new shape) and then this file,
-- which rebuilds a table it finds empty — same shape out, zero rows moved. An existing database
-- rebuilds with its rows preserved.
--
-- ADOPTING FORKS: `migrations/` is deliberately NOT in the /kit-upgrade diff set (a fork's
-- migration numbering is its own). When you adopt this, copy the file and RENUMBER it to your
-- next free ordinal — the contents need no edit. It REQUIRES the read ledger's 0001 + 0002 (the
-- `kind` column): a fork without `read_log` adopts those two first, in order, then this one.
--
-- WHAT CHANGES, AND WHY IT NEEDS A REBUILD RATHER THAN AN `ALTER`:
--
--   1. `kind` GAINS 'upstream' — a read of an upstream HTTP source (Autobahn, a government API)
--      through src/data/upstream.ts. Before this, a route that read an upstream left NO per-call
--      record anywhere: read_log held only 'aurora' and 'd1', and a GET declares no audit action.
--      That gap is PIA condition C15. The kind CHECK is part of the column definition, and SQLite
--      has no `ALTER … CHECK`, so widening it is the documented 12-step rebuild (minus the pragmas
--      D1 does not expose) — the same procedure 0002 used.
--
--   2. A SECOND table-level CHECK, for the upstream stream only. An upstream row must carry:
--        view        NULL — an HTTP source has no schema-qualified view, and a URL must never be
--                    written into that column (a URL is where identifier VALUES hide);
--        source      the registered upstream source name (`autobahn`);
--        query_name  the registered read id (`report_datablocks`);
--        target      the DECLARED identifier projection NAME (`ticket_key`, `duns`) — REQUIRED.
--      Each of the three is held to an identifier shape: a lowercase letter, then lowercase
--      letters, digits or `_`, at most 64 characters. That is Decision D6 carried into the schema
--      for this stream: `target` holds the NAME of the identifier, never its value (DECISIONS
--      2026-09-25). A DUNS or a CPF (digits), a ticket key (`INS-123`), an email (`@`, `.`) or a
--      URL cannot satisfy the shape, so a writer that tries to record the value is refused by the
--      database itself, not only by the seam's definition-time guard.
--      The aurora and d1 streams keep exactly the guarantee they shipped with: the existing CHECK
--      is carried over with 'upstream' added to its exempt list, and nothing about an aurora or
--      d1 row is newly constrained.
--
-- NOT CHANGED: no column is added or removed, the indexes are the same three, and the two
-- append-only triggers are reinstated VERBATIM from schema.sql — test/data/read-log-upstream.test.ts
-- compares their stored SQL, character for character, with a fresh install's.

-- RETRY SAFETY, as in 0002. Between `DROP TABLE read_log` and the RENAME there is one copy of the
-- ledger, and it is in the scratch table, so NOTHING in this file ever drops the scratch table.
-- With `IF NOT EXISTS` and a copy that skips the ids it already copied, the file is re-runnable: a
-- retry after a failed DROP re-copies harmlessly and finishes, and a retry after a failed RENAME
-- stops on "no such table: read_log" with every row still in `read_log_c15`, one RENAME from
-- recovery.
CREATE TABLE IF NOT EXISTS read_log_c15 (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  app TEXT NOT NULL,
  env TEXT NOT NULL,
  route TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'aurora' CHECK (kind IN ('aurora', 'd1', 'upstream')),
  source TEXT NOT NULL,
  source_class TEXT NOT NULL CHECK (source_class IN ('client', 'internal')),
  view TEXT,
  query_name TEXT,
  target TEXT,
  row_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (kind IN ('d1', 'upstream') OR (view IS NOT NULL AND query_name IS NOT NULL)),
  CHECK (kind <> 'upstream' OR (
    view IS NULL
    AND length(source) BETWEEN 1 AND 64 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9_]*'
    AND query_name IS NOT NULL
    AND length(query_name) BETWEEN 1 AND 64 AND query_name GLOB '[a-z]*' AND query_name NOT GLOB '*[^a-z0-9_]*'
    AND target IS NOT NULL
    AND length(target) BETWEEN 1 AND 64 AND target GLOB '[a-z]*' AND target NOT GLOB '*[^a-z0-9_]*'
  ))
);

-- Every column named on BOTH sides, `kind` copied as it stands: every database this file can meet
-- already carries the column (0002 is a prerequisite), and no row a kit-shaped ledger can hold
-- trips the new CHECKs (none is 'upstream'; 0002 already held aurora rows to a view and a query).
--
-- NOT `INSERT OR IGNORE`, which 0002 used: IGNORE skips a row that breaks a CHECK or a NOT NULL
-- exactly as silently as a duplicate key, and the DROP below would then take the only copy of that
-- row with it. The `WHERE` skips only ids this file already copied (a retry); a row the new table
-- refuses — possible only in a fork that loosened its read_log by hand — FAILS the file here,
-- before the DROP, with read_log untouched. Loud and intact beats a green run that lost a row.
INSERT INTO read_log_c15
  (id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, target, row_count, created_at)
SELECT
  id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, target, row_count, created_at
FROM read_log
WHERE id NOT IN (SELECT id FROM read_log_c15);

-- Drops the old indexes and triggers with it; both are recreated below.
DROP TABLE read_log;
ALTER TABLE read_log_c15 RENAME TO read_log;

CREATE INDEX IF NOT EXISTS idx_read_log_created ON read_log(created_at);
CREATE INDEX IF NOT EXISTS idx_read_log_principal ON read_log(principal, created_at);
CREATE INDEX IF NOT EXISTS idx_read_log_source ON read_log(source, created_at);

-- Reinstated VERBATIM from schema.sql (and from 0002, which already listed `kind`). No column was
-- added, so the immutable-column list is unchanged: the count patch is still the ONLY legal UPDATE,
-- and rewriting which stream — or which upstream — a recorded read belongs to is as forbidden as
-- rewriting who performed it.
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
