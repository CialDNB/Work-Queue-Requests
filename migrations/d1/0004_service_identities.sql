-- Service identities — first-class MACHINE principals, so integrations stop running on people's
-- personal tokens (an ETL whose every write is attributed to the person whose token it borrowed).
--
-- WHY BOTH THIS AND schema.sql. `schema.sql` is the fresh-install baseline (applied at provision
-- and in tests); this migration is what an ALREADY-DEPLOYED database needs. Both end in the same
-- shape, and every statement here is `IF NOT EXISTS`, so on a fresh install (baseline, then every
-- migration) this file is a no-op, and it is safe to run twice. Nothing existing is altered: no
-- `ALTER TABLE`, no rebuild, no data copied — `users`, `api_tokens`, `audit_log` and `read_log` keep
-- every row exactly as it is. A service identity's tokens are ordinary `api_tokens` rows whose
-- `email` is the identity's `principal_id`, so the token table needs no new column.
--
-- ADOPTING FORKS: `migrations/` is deliberately NOT in the /kit-upgrade diff set (a fork's
-- migration numbering is its own). Copy this file and RENUMBER it to your next free ordinal — the
-- contents need no edit. Do it in the SAME change that adopts the src/auth + src/data hunks: until
-- this has run, every service token is refused (401, logged as `service_identities_schema_drift`
-- naming this file), the admin page answers an opaque 500, and the daily `token_expiry_notice` task
-- fails with the same remedy (after the person notice has gone out), while every PERSON and personal
-- token keeps working unchanged.
--
-- HISTORY IS NOT REWRITTEN. Rows an integration wrote while it ran on a person's token stay
-- attributed to that person; only actions taken after it moves to a service identity carry the
-- identity's own `svc-…@….invalid` identifier.
--
-- The table, its CHECKs and its three triggers are documented where they are defined, in
-- schema.sql (SYSTEM TABLES). In short:
--   - a service identity is not a user and never gets a `users` row;
--   - `scope` is its ONE permission key — its whole authority (it has no role);
--   - `custodian_email` is the accountable human; while that person is not an active user, every
--     token of the identity is refused;
--   - id, slug, principal_id, scope and creation are fixed, and rows are never deleted (retire an
--     identity by disabling it), so an identifier in the audit log always names one machine.
CREATE TABLE IF NOT EXISTS service_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 2 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'),
  principal_id TEXT NOT NULL UNIQUE CHECK (principal_id LIKE 'svc-%@%.invalid'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  custodian_email TEXT NOT NULL CHECK (custodian_email NOT LIKE '%.invalid'),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  updated_at TEXT,
  disabled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_service_identities_custodian ON service_identities(custodian_email);

CREATE TRIGGER IF NOT EXISTS service_identities_fixed_columns
BEFORE UPDATE ON service_identities
WHEN NEW.id IS NOT OLD.id
  OR NEW.slug IS NOT OLD.slug
  OR NEW.principal_id IS NOT OLD.principal_id
  OR NEW.scope IS NOT OLD.scope
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'service_identities: id, slug, principal_id, scope and creation are fixed');
END;

CREATE TRIGGER IF NOT EXISTS service_identities_no_delete
BEFORE DELETE ON service_identities
BEGIN
  SELECT RAISE(ABORT, 'service_identities rows are never deleted, disable instead');
END;

CREATE TRIGGER IF NOT EXISTS service_identities_no_replace
BEFORE INSERT ON service_identities
WHEN EXISTS (
  SELECT 1 FROM service_identities
  WHERE id = NEW.id OR slug = NEW.slug OR principal_id = NEW.principal_id
)
BEGIN
  SELECT RAISE(ABORT, 'service_identities rows are never overwritten');
END;
