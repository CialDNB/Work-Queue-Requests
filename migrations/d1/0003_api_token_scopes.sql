-- Token hardening (PIA C8) — give `api_tokens` a scope ceiling and a mandatory expiry.
--
-- WHY BOTH THIS AND schema.sql. `schema.sql` is the fresh-install baseline (applied at provision
-- and in tests); this migration is what an ALREADY-DEPLOYED database needs. Both end in the same
-- shape. (This is the 0002_read_log_kind pattern, for the same reason: `NOT NULL` cannot be added
-- by `ALTER`, and a plain `ADD COLUMN` would collide with the baseline on every fresh install.)
--
-- THIS FILE MEETS TWO SHAPES, AND KEEPS EVERY TOKEN'S SCOPES IN BOTH.
--   - A PRE-C8 table (no `scopes` column): an existing database. Every row becomes a LEGACY token.
--   - A C8-SHAPED table, possibly FULL: a fresh install. The kit's setup applies schema.sql at
--     provision (`npm run db:apply*`) but the migrations only on the first CI / Deploy-production
--     run (`wrangler d1 migrations apply`), and the first deploy is manual — so by the time this
--     runs, people may already have minted scoped tokens against the new baseline. The same holds
--     if the file is ever applied twice (a fork that renames an applied file, or a retry).
--   The copy therefore reads `scopes` from the table when the column exists and writes NULL only
--   when it does not. A copy that wrote NULL unconditionally would silently WIDEN every scoped
--   token to legacy (its owner's whole role minus the non-delegable set) — the bug this guards.
--
-- ADOPTING FORKS: `migrations/` is deliberately NOT in the /kit-upgrade diff set (a fork's
-- migration numbering is its own). Copy this file and RENUMBER it to your next free ordinal — the
-- contents need no edit. Do it in the SAME change that adopts the src/auth + src/data hunks: code
-- that expects `scopes` refuses every bearer token (logging `api_token_schema_drift`) until this
-- has run.
--
-- WHAT CHANGES:
--
--   1. NEW COLUMN `scopes` — the token's permission CEILING, a JSON array of permission keys
--      (src/auth/permissions.ts: principalCan intersects it with the owner's live role and removes
--      the non-delegable set). A row from a table WITHOUT the column gets NULL, which the code
--      reads as a LEGACY token: every role permission except the reserved `agent` family. New
--      tokens always carry an explicit array (mintApiToken, src/auth/tokens.ts). A CHECK keeps
--      anything but a JSON array out of the column.
--
--   2. `expires_at` BECOMES NOT NULL, and every legacy token gets a deadline: 90 days after this
--      migration runs, or its existing expiry if that is sooner. Tokens used to be allowed to live
--      forever (and could be minted for up to 365 days); from this deploy on nothing outlives
--      upgrade + 90 days. MACHINE TOKENS (an ETL integration, a registry reporter) must be
--      rotated before then — docs/runbooks/machine-token-rotation.md. The daily
--      `token_expiry_notice` cron task (src/cron/tokenExpiry.ts) emails the alert recipients at
--      14, 7, 3 and 1 day(s) out for every token that has been used. On a C8-shaped table this is
--      a no-op: every expiry is already at most mint + 90 days, so never later than now + 90.
--
-- NOT CHANGED: ids are copied verbatim, so audit rows that name a token by id still point at it.
-- One known limit: AUTOINCREMENT's high-water mark restarts at the largest id copied, so an id
-- that was hard-DELETED at the very top of the range (a DSR erasure) can be issued again. Nothing
-- authorizes by token id (revoke is scoped to the owner's email), so this is a forensics nuance,
-- recorded rather than worked around: rewriting `sqlite_sequence` is not something D1 promises.
--
-- RETRY SAFETY — 0002's scratch-table shape, with a REFRESHING copy. Between `DROP TABLE
-- api_tokens` and the RENAME there is exactly one copy of the tokens, in the scratch table, so
-- NOTHING in this file drops or empties it. A retry after a failure before the DROP finds a scratch
-- table already filled by the failed attempt — and unlike read_log (append-only, where 0002's
-- `INSERT OR IGNORE` is exact), api_tokens rows CHANGE: the old Worker keeps serving until the
-- deploy that follows the migration, so a token can be revoked, used, or hard-deleted (a DSR
-- erasure) in between. Ignoring the rows already copied would keep their stale versions and bring
-- a revoked token back as a working legacy token. So the retry REFRESHES the scratch table from the
-- source: the DELETE drops every scratch row whose id the source no longer has, and
-- `INSERT OR REPLACE` overwrites every row it does. A retry after a failed RENAME stops on the
-- DELETE — "no such table: api_tokens" — before touching `api_tokens_c8`, with every row still in
-- it, one RENAME from recovery. A second run after a full success is harmless too (see above): same
-- rows, same scopes, same expiries.
CREATE TABLE IF NOT EXISTS api_tokens_c8 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  scopes TEXT CHECK (scopes IS NULL OR (json_valid(scopes) AND json_type(scopes) = 'array'))
);

-- The retry refresh (see RETRY SAFETY above). On a first run the scratch table is empty and this
-- deletes nothing. Written against the SOURCE on purpose: once `api_tokens` has been dropped, the
-- subquery cannot resolve and the statement fails before it can empty the only copy.
DELETE FROM api_tokens_c8 WHERE id NOT IN (SELECT id FROM api_tokens);

-- Columns named explicitly on BOTH sides, and every source column qualified with `src.`, because
-- the source table may or may not carry `scopes` and `SELECT *` would break in one of the two.
--
-- HOW `scopes` IS READ WHEN IT MAY NOT EXIST. SQLite resolves an unqualified column name in a
-- subquery against the innermost FROM first, then outward. The subquery below reads `scopes` from
-- `cur` (the same row of api_tokens, by primary key). If api_tokens HAS the column, that is the
-- row's own value. If it does NOT, the name falls through to the outer `legacy` row, whose only
-- column is `scopes` = NULL — the legacy classification. One statement, correct on both shapes,
-- no dynamic SQL. (test/data/token-scopes-migration.test.ts runs it on both.)
--
-- A value that is not a JSON array (only possible in a fork that hand-added the column without
-- this CHECK) becomes '[]' — identity only, the narrowest ceiling — rather than failing the CHECK,
-- which would abort the migration on that one row.
--
-- The CASE on expires_at is the forced expiry: a NULL deadline, or one further out than 90 days
-- from now, becomes now + 90 days; a sooner one is kept. `expires_at` is always written by
-- SQLite's datetime(), so the string comparison is a time comparison.
INSERT OR REPLACE INTO api_tokens_c8
  (id, email, name, token_hash, prefix, created_at, last_used_at, expires_at, revoked_at, scopes)
SELECT
  src.id, src.email, src.name, src.token_hash, src.prefix, src.created_at, src.last_used_at,
  CASE
    WHEN src.expires_at IS NULL OR src.expires_at > datetime('now', '+90 days')
      THEN datetime('now', '+90 days')
    ELSE src.expires_at
  END,
  src.revoked_at,
  (
    SELECT CASE
      WHEN scopes IS NULL OR (json_valid(scopes) AND json_type(scopes) = 'array') THEN scopes
      ELSE '[]'
    END
    FROM api_tokens AS cur
    WHERE cur.id = src.id
  )
FROM api_tokens AS src
CROSS JOIN (SELECT NULL AS scopes) AS legacy;

-- api_tokens has no indexes or triggers of its own beyond the UNIQUE(token_hash) autoindex, which
-- the new table's definition recreates, so there is nothing to reinstate after the swap.
DROP TABLE api_tokens;
ALTER TABLE api_tokens_c8 RENAME TO api_tokens;
