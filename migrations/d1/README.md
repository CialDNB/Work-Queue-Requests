# D1 migrations (the default database)

`schema.sql` at the repo root is the **fresh-install baseline** — the full shape a
brand-new database starts with, applied once at provision (`npm run db:apply*`) and in
tests (`applySchema`, which then applies this folder — see [In tests](#in-tests)).
**This folder holds every change made *after* that baseline.**

Each deploy (staging on push to `main`, production via the *Deploy production* workflow)
runs `wrangler d1 migrations apply` against the remote DB **before** shipping the new
Worker, using the `CLOUDFLARE_API_TOKEN` already in CI. So:

- you never run migrations on a laptop, and
- the schema is in place before the code that needs it goes live.

## Adding a migration

Once your app is live, change the schema **here**, not in `schema.sql`:

1. Create `NNNN_short_description.sql` — the **next free** four-digit ordinal and a
   lowercase snake_case slug. `wrangler d1 migrations create DB "short description"`
   scaffolds one (by the `DB` binding, never the database name). Ordinals are unique and
   contiguous from `0000`: `test/platform/migration-ordinals.test.mjs` fails CI on a
   duplicate, a gap, or a malformed name. wrangler itself would apply two `0004_*` files
   without complaint, so when parallel branches both take the same number, the one that
   merges second renumbers. Because ordinals must be contiguous on every branch, a file
   cannot take an ordinal ahead of one that is not yet on main: reserving numbers in
   advance fixes the merge order. **Never rename a file that has been applied anywhere** —
   wrangler records migrations by file name, so a renamed file runs again on the next
   deploy. A fork whose folder predates the guard lists such a name in the guard's
   `APPLIED_BEFORE_THE_GUARD` set instead.
2. Write the change. Use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` so
   the file is safe to re-run. `ALTER TABLE … ADD COLUMN` is one-shot (SQLite has no
   `IF NOT EXISTS` for it) — that's fine: it lives **only** in the migration, never folded
   back into the frozen `schema.sql`, so a fresh install (baseline → migrations) and an
   existing DB each apply it exactly once (`wrangler` tracks applied migrations per DB in
   `d1_migrations`).
3. Commit it. The next deploy applies it automatically. The deploy log runs
   `wrangler d1 migrations list` per environment as the pending check; `npm run
   db:migrate:check` lists **staging**'s pending migrations locally.

Apply locally against the in-memory dev DB with `npm run db:migrate:local`.

## In tests

`test/helpers/db.ts` treats a test file's database the way a deploy treats a real one:

- It **discovers** every `*.sql` file here (Vite `import.meta.glob`), so a new migration
  needs no edit to the helper.
- It applies each migration **once per test file** — storage is isolated per file — in
  ordinal order, recording it by name in `d1_test_migrations` (wrangler's `d1_migrations`
  shape under a harness-only name; the app's own tests own `d1_migrations`). `schema.sql`
  and the row reset still run before every test (`seedDb`). So a plain `ADD COLUMN`
  migration just works; it is never replayed into a *duplicate column name*.
- A migration that alters a table the harness drops and recreates — the WORM tables
  `audit_log` / `ai_usage` on every `seedDb`, or a table a test drops to fake an outage —
  keeps its columns, indexes and triggers: the helper rebuilds any missing object from the
  migrated shape it snapshots after the migrations run, not from `schema.sql`. A run that
  fails on a later file is snapshotted too: the files before it stay applied and recorded.
- A migration that DROPs or RENAMEs something `schema.sql` creates — a table, an index, a
  column — stays applied: the per-test baseline skips every statement that would recreate
  (or seed) an object the migrated shape no longer has, so the object does not reappear and
  an index on a dropped column does not throw. A renamed table's **indexes and triggers**
  are covered too: they move with the table under their own names, and the baseline skips
  its `CREATE INDEX` / `CREATE TRIGGER … ON <old name>` instead of failing on *no such
  table* (SQLite resolves that table before it reads `IF NOT EXISTS`).

`test/helpers/db.test.ts` and `db-rename.test.ts` pin all four with synthetic migrations,
including a file with a `CASE … END` trigger body, `/* */` comments, and `;` / `--` inside
string literals and inside `` `backtick` `` identifiers, which the helper splits into
statements the way SQLite and wrangler's local apply read them. **No `;`, `--` or `/*` inside
a `[bracket]` identifier:** SQLite accepts one, but `npm run db:migrate:local` (wrangler's
local splitter) cuts the statement there, so the helper does too and the migration fails in
CI. Quote such a name with `"…"` or backticks. Two things the helper cannot know for you:

- **`seedDb`'s `TABLES` list is hand-kept.** A migration that drops or renames a table on
  it updates the list in the same PR, or every `seedDb` fails on *no such table* (loudly).
- **Rows a migration INSERTs do not survive the reset** in a table `seedDb` clears — they
  are applied once, and the first `beforeEach` empties the table. Seed the rows a test
  needs in the test (or in `seedDb`), not by leaning on the migration.

**Known limit: virtual tables (FTS5).** The kit ships none, and the helper does not handle
them yet (DATADEV-2266). The snapshot records a virtual table's shadow tables as ordinary
tables. So if a test drops a virtual table that a migration created, the next `applySchema`
fails with *object name reserved for internal use*. Also, a `CREATE VIRTUAL TABLE` in
`schema.sql` always runs, so a migration cannot drop or rename it yet.

## Why baseline + migrations (not edit `schema.sql` in place)

`schema.sql` is what the kit's tests and a fresh provision apply; migrations are what an
already-deployed database needs. Keeping app changes out of `schema.sql` means a
migration's `ADD COLUMN` can never collide with a fresh install (the baseline doesn't
carry it). A from-scratch rebuild of a long-lived DB is a backup-restore scenario (see
the R2 backups + restore runbook), not a migration replay.

The kit ships `0000_kit_app_identity.sql` (kit-owned, keeps its number in every fork), the
read-ledger pair `0001` / `0002`, `0003_api_token_scopes.sql` (token scopes and mandatory
expiry, PIA C8), `0004_service_identities.sql` (machine principals),
`0005_read_log_upstream.sql` (the read ledger's upstream stream, PIA C15 — a table rebuild like
`0002`, so it needs `0001` and `0002` before it), and `0006_agent_tables.sql` (the in-app
agent's transcript store, PIA C1/C7/C17 — pure create, needs no earlier kit migration); your
app's migrations continue the sequence.

**`agent_threads` is never rebuilt.** It is the one foreign-key parent of the agent store, and
every child cascades from it: the 12-step rebuild (create new, copy, `DROP TABLE` the old one,
rename) deletes every message, turn, approval and feedback row under it, even with
`defer_foreign_keys`. The kit changes it by `ALTER TABLE … ADD COLUMN` only; a later kit migration
may rebuild a child table. **A fork changes no `agent_*` table at all**: no `ALTER`, index,
rebuild, or foreign key to one. The carried `test/data/agent-tables.test.ts` pins their exact DDL
and fails on a foreign key to any of them, so such a change turns CI red, and an edit that makes
the test agree is undone by the next `/kit-upgrade`. Keep agent-adjacent data in a table of your own, with no FK to
`agent_threads`, and erase it through the P2-7 erasure hook (`erasure` in
`src/routes/agentPolicy.ts`). The test harness resets the six `agent_*` tables
children first (`TABLES` in `test/helpers/db.ts`), so a fork merging that list keeps them ahead of
its own.

## Kit migrations in a fork

A fork copies each kit migration by hand (`migrations/` does not ride `/kit-upgrade`) and gives it
its own next free ordinal, keeping the kit's slug. `npm run verify:kit-migrations`
(`scripts/check-kit-migrations.mjs`, which CI and the production deploy also run as a plain `node`
step) checks that every kit migration pinned in `scripts/kit-migrations.json` has a copy here —
matched by **content**, under any number. ("Here" is the folder the `DB` binding's
`migrations_dir` names in `wrangler.jsonc`, which `wrangler.staging.jsonc` must name too; a
`migrations_pattern` is refused.) Comments and whitespace may differ, so rewriting the "ADOPTING
FORKS" header on a renumbered copy is fine; the statements may not, and a copy whose statements
were edited fails as *modified*. `0000_kit_app_identity.sql` keeps its number and its one
permitted edit is the seeded app name, which must be exactly your `vars.APP_NAME`. Each failure
names the kit file and the command that copies it (`git show kit/main:migrations/d1/<file> >
migrations/d1/<NNNN>_<slug>.sql`). The kit's migration tests find each kit migration by that slug
(`migrationBySlug` in `test/helpers/db.ts`), so a correctly copied one is always found.

**In the kit** the same check also holds the manifest to this folder: a new kit migration fails CI
until it is pinned (`npm run verify:kit-migrations -- --write`, then commit the manifest), and a
pinned one fails if its statements change — a shipped kit migration is immutable, because forks
applied the pinned text and wrangler never re-runs a migration it has recorded. Ship the change as
a new migration. See DECISIONS 2026-09-25.
