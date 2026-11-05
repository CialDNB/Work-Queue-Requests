#!/usr/bin/env bash
# Tiered pre-commit hook (install once: npm run hooks:install).
#   default                      → typecheck + lint (fast; catches cheap breakage)
#   PAVEDROAD_PRECOMMIT_FULL=1   → also run the full test suite
#   PAVEDROAD_SKIP_PRECOMMIT=1   → emergency skip (CI still runs everything)
# Rationale: a slow hook pushes people toward fewer, fatter commits — the opposite
# of bisectable. CI is the real wall; this catches breakage before it leaves the machine.
set -euo pipefail

if [ "${PAVEDROAD_SKIP_PRECOMMIT:-}" = "1" ]; then
  echo "pre-commit: skipped (PAVEDROAD_SKIP_PRECOMMIT=1)"
  exit 0
fi

staged="$(git diff --cached --name-only --diff-filter=ACMR | grep -E '\.(ts|tsx|js|mjs|sql|jsonc?|ya?ml)$' || true)"
if [ -z "$staged" ]; then
  echo "pre-commit: no staged code files — skipping checks"
  exit 0
fi

echo "pre-commit: typecheck"
npm run --silent typecheck

echo "pre-commit: lint"
npm run --silent lint

if [ "${PAVEDROAD_PRECOMMIT_FULL:-}" = "1" ]; then
  echo "pre-commit: full test suite (PAVEDROAD_PRECOMMIT_FULL=1)"
  npm test
fi

echo "pre-commit: ok"
