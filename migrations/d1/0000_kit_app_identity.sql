-- KIT-OWNED MIGRATION (DECISIONS 2026-08-18). Numbered 0000 so it sorts ahead of an app's own
-- migrations, which the README starts at 0001 — a fork that already has 0001_* is unaffected.
--
-- ADOPTING FORKS — this differs from 0001/0002, so read it. `migrations/` is deliberately NOT in
-- the /kit-upgrade diff set, so this file does not arrive with scripts/ and .github/: copy it by
-- hand (the CHANGELOG entry that announced it says so), KEEP the 0000 number (kit-owned, it
-- collides with nothing), and — unlike 0001/0002, whose contents need no edit — CHANGE the seeded
-- value below from the template's name to your app's `vars.APP_NAME`, exactly as the matching
-- schema.sql hunk must. The stamp is immutable: a database stamped with the wrong name fails
-- every later deploy of its own app, and the way back is docs/runbooks/d1-rehome.md.
-- `npm run verify:bootstrap` reds on a residual template identifier here, and the ownership
-- preflight (scripts/check-d1-identity.mjs) refuses to deploy while this file is missing or seeds
-- a name that is not your APP_NAME — but neither can copy the file for you.
--
-- Mirrors the app_identity block in schema.sql. It has to exist in BOTH places: schema.sql is
-- the fresh-install baseline and never runs against an already-provisioned database, so without
-- this migration every database that existed before 2026-08-18 would stay unstamped and the
-- ownership preflight (scripts/check-d1-identity.mjs) would be permanently inert on exactly the
-- databases it exists to protect. Both are idempotent (IF NOT EXISTS / INSERT OR IGNORE), so a
-- fresh install applies the baseline and then no-ops here.
CREATE TABLE IF NOT EXISTS app_identity (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO app_identity (key, value) VALUES ('app', 'work-queue-requests');
CREATE TRIGGER IF NOT EXISTS app_identity_no_update
BEFORE UPDATE ON app_identity
BEGIN
  SELECT RAISE(ABORT, 'app_identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS app_identity_no_delete
BEFORE DELETE ON app_identity
BEGIN
  SELECT RAISE(ABORT, 'app_identity is immutable');
END;
