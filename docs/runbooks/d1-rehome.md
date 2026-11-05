# Runbook — Re-homing a D1 database whose `app_identity` names another app

**Goal:** get an app deploying again after the D1 ownership preflight
(`scripts/check-d1-identity.mjs`, DECISIONS 2026-08-18) refuses with
`THIS DATABASE BELONGS TO "<other>", NOT "<this>"` — **without** ever letting a deploy overwrite an
identity row. The row is frozen by triggers on purpose; re-homing is a deliberate human act, and
this is the procedure.

**Who runs this:** a human with a Cloudflare token holding `D1: Edit` on the account, from their
own terminal — **not** an agent session. The Claude Code hook (`.claude/hooks/guard-bash.mjs`)
blocks `DROP TABLE` by design, and that block is the control, not an obstacle.

## First decide which of the two stories is true

The preflight cannot tell them apart; you can.

| | (a) Your config is wrong | (b) Your config is right; the database was mis-stamped |
|---|---|---|
| **Symptom** | `database_id` in `wrangler.jsonc` / `wrangler.staging.jsonc` is not the id recorded for THIS app in `docs/RESOURCES.md` (or shown for your database in the Cloudflare dashboard). | The id **is** yours. Some other app `<other>` carries YOUR id in ITS config and deployed while your database was still unstamped (the acknowledged one-deploy window) — its `0000_kit_app_identity.sql` wrote `('app', '<other>')` into your table. |
| **Fix** | Correct the id (or re-run `npm run provision`) and redeploy. **Stop here — do not touch the database.** | Continue below. |

Check (b) before believing (a): if the uuid in your config matches the one in `docs/RESOURCES.md`
and the dashboard, the database is yours and the stamp is what is wrong.

## Re-homing (story b)

Every command below addresses the **`DB` binding**, never a database name — the same rule as
everywhere else in the kit. Add `--config wrangler.staging.jsonc` for staging.

1. **Fix the other app first.** Find which repo's config carries your `database_id` (search the
   fleet's repos for the uuid; `<other>` is the name the preflight printed) and open a PR there
   correcting it. Until that lands, every deploy of `<other>` runs DDL against **your** database.
2. **Take a backup.** Nightly R2 dumps exist (`<app>-backups`), but export now anyway:
   `npx wrangler d1 export DB --remote --output rehome-<date>.sql`
3. **Drop the identity table.** This is the deliberate act — the freeze triggers make `UPDATE` /
   `DELETE` impossible, so the table goes as a whole:
   `npx wrangler d1 execute DB --remote --command "DROP TABLE app_identity"`
4. **Re-stamp with YOUR name.** `d1_migrations` already records the `0000` migration as applied,
   so `npm run db:migrate*` will **not** re-run it. Apply the seed explicitly (idempotent):
   `npx wrangler d1 execute DB --remote --file migrations/d1/0000_kit_app_identity.sql`
   (`npm run db:apply` / `db:apply:staging` re-applies the whole baseline and works too.)
5. **Verify.**
   `npx wrangler d1 execute DB --remote --json --command "SELECT value FROM app_identity WHERE key = 'app'"`
   must print your `vars.APP_NAME`. Redeploy; the preflight now reads `ok`.
6. **Record it** in your app's `docs/DECISIONS.md` — what was stamped, by which app, when fixed.
   Cloudflare logs nothing for the D1 query path, so this note is the only record there will be.

## What not to do

- Do not "fix" story (b) by editing your own `database_id` to something else — that points you at
  a database that is not yours, which is the exact failure the preflight exists to stop.
- Do not delete the triggers or bypass the preflight. `Do NOT work around this check` means it.
- Do not run this from an agent session. The harness blocks destructive SQL on purpose.
