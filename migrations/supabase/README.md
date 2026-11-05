# Supabase (Postgres) migrations — by exception

**D1 is the default.** Supabase is permitted only for genuinely Postgres-shaped needs
(heavy relational/analytical queries, `pgvector`, realtime, an existing Postgres estate)
and requires a DECISIONS.md entry in your app — see docs/IMPLEMENTATION-HANDBOOK.md §5
"Supabase rubric (D10)". Most apps never use this folder.

## You don't provision it; IT does

So you never hold a database password locally, the instances are provisioned **for** you.
Staging and production get **separate Supabase projects** — the same isolation as the two
D1 databases (`<app>-db` / `<app>-db-staging`), so a staging compromise never touches prod
data and staging holds **synthetic data only**.

1. Ask IT (a Linear request) for **two Supabase projects** for your app — one production,
   one staging.
2. IT adds each project's **pooled connection string** to this repo as an Actions secret
   (Settings → Secrets and variables → Actions):
   - **`SUPABASE_DB_URL`** → production (used by the *Deploy production* workflow)
   - **`SUPABASE_DB_URL_STAGING`** → staging (used by the staging auto-deploy)

   That's the only setup — no local `.env`, no local secret.

Until the env's secret exists, that deploy's Supabase step **skips** (the common case).

> **Per-PR preview databases instead?** If you specifically want a throwaway, isolated
> Postgres per pull request (not a standing staging project), **Supabase Branching** is the
> by-exception alternative — but it runs migrations via Supabase's own GitHub integration
> on its own schedule, *separate* from this deploy-time runner, so adopt it deliberately
> and record it in your app's DECISIONS.md. The kit default is two projects + this runner.

## Adding a migration

Put ordered, zero-padded SQL files here: `NNNN_description.sql` (`0001_…`, `0002_…`).
Each deploy (staging + production) runs `scripts/migrate-supabase.sh` **before** shipping
the Worker. When `SUPABASE_DB_URL` is set, it applies each unapplied file once, in order,
tracked in a `_kit_schema_migrations` table. No local run.

**Transactions.** The runner wraps each file in **one transaction** together with its
tracking row, so a failed migration records nothing and the deploy fails closed. Because
the runner owns the transaction, **do not put `BEGIN`/`COMMIT` in a migration file.** For
statements Postgres can't run inside a transaction — `CREATE INDEX CONCURRENTLY`,
`ALTER TYPE … ADD VALUE`, `VACUUM` — make the file's **first line** `-- kit:no-transaction`
(only the first line is honored, so mentioning it in a later comment can't accidentally
opt out). The runner then applies it unwrapped, and because its body and tracking row are
no longer atomic, such a migration **must be idempotent / re-runnable** — use the
`IF NOT EXISTS` forms Postgres allows, e.g. `CREATE INDEX CONCURRENTLY IF NOT EXISTS …`,
so a replay after an interrupted deploy is a clean no-op.

Write plain Postgres DDL; prefer idempotent forms (`CREATE TABLE IF NOT EXISTS`, etc.).

## Still the kit's rules

Auth stays the kit's (Supabase is a database here, never an identity provider), and all
access is fenced through `src/data/` repositories — same as D1.

This folder starts empty — that's expected.
