#!/usr/bin/env bash
# Apply Supabase (Postgres) migrations — INERT until an app opts in.
#
# Supabase is the by-exception Postgres option (docs/IMPLEMENTATION-HANDBOOK.md §5
# "Supabase rubric (D10)"); D1 is the default and most apps never reach this script.
#
# The deploy workflows call this BEFORE `wrangler deploy`, with SUPABASE_DB_URL injected
# from the repo secret IT adds when they provision the instance — so migrations run only
# in CI (no local secret, no local run), the same posture as D1.
#
#   • SUPABASE_DB_URL unset            -> skip (the common case; D1-only apps)
#   • no *.sql in migrations/supabase  -> nothing to apply
#   • otherwise                        -> apply each unapplied file once, in order,
#                                         recorded in the _kit_schema_migrations table
#
# Each file is wrapped in ONE transaction with its tracking row (so a failure records
# nothing) UNLESS its FIRST LINE is `-- kit:no-transaction` — the opt-out for statements
# that can't run in a transaction (CREATE INDEX CONCURRENTLY, ALTER TYPE … ADD VALUE). A
# no-transaction migration isn't atomic with its tracking row, so it MUST be idempotent
# (e.g. CREATE INDEX CONCURRENTLY IF NOT EXISTS). Migration files must not contain their
# own BEGIN/COMMIT; the runner owns the transaction.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
migrations_dir="${repo_root}/migrations/supabase"

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SUPABASE_DB_URL not set — skipping Supabase migrations (D1 is the default)."
  exit 0
fi

# Bash globs expand in lexical (LC_COLLATE) order, so zero-padded names sort correctly.
shopt -s nullglob
files=("${migrations_dir}"/*.sql)
shopt -u nullglob
if [ "${#files[@]}" -eq 0 ]; then
  echo "No Supabase migrations in ${migrations_dir} — nothing to apply."
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "::error::psql not found — install postgresql-client to run Supabase migrations."
  exit 1
fi

psql_run() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --quiet --no-psqlrc "$@"; }

# Tracking table (idempotent). Names are recorded so a migration never re-runs.
psql_run -c "CREATE TABLE IF NOT EXISTS _kit_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"

for f in "${files[@]}"; do
  name="$(basename "$f")"
  # Filenames are repo-controlled; escape single quotes anyway as defensive hygiene.
  esc="${name//\'/\'\'}"
  applied="$(psql_run --tuples-only --no-align -c "SELECT 1 FROM _kit_schema_migrations WHERE name = '${esc}';")"
  if [ "${applied}" = "1" ]; then
    echo "skip (already applied): ${name}"
    continue
  fi
  record="INSERT INTO _kit_schema_migrations (name) VALUES ('${esc}');"
  # The opt-out is a FIRST-LINE directive only (`head -n 1`), so a mention of it further
  # down — in an explanatory comment or inside a /* … */ block — can't silently switch a
  # normal migration to the non-atomic path.
  if head -n 1 "$f" | grep -qiE '^[[:space:]]*--[[:space:]]*kit:no-transaction\b'; then
    # Opt-out for statements that can't run inside a transaction (CREATE INDEX
    # CONCURRENTLY, ALTER TYPE … ADD VALUE, VACUUM). The runner does NOT wrap it, so the
    # body and the tracking row are applied as TWO statements — a crash between them leaves
    # the body applied but unrecorded, replayed next deploy. So a no-transaction migration
    # MUST be idempotent / re-runnable: use the IF NOT EXISTS forms Postgres allows here,
    # e.g. `CREATE INDEX CONCURRENTLY IF NOT EXISTS …`, so a replay is a clean no-op.
    echo "apply (no-transaction): ${name}"
    psql_run -f "$f"
    psql_run -c "$record"
  else
    # Default: body + tracking row commit together in ONE transaction, so a failed
    # migration leaves nothing recorded and the deploy fails closed. The runner owns the
    # transaction — a migration file must NOT contain its own BEGIN/COMMIT (that would
    # close the wrapper early and unrecord the body); add `-- kit:no-transaction` instead.
    echo "apply: ${name}"
    psql_run --single-transaction -f "$f" -c "$record"
  fi
done

echo "Supabase migrations up to date."
