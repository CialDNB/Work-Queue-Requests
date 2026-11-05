#!/usr/bin/env bash
# Post-deploy smoke check: /_health must report "ok" or "degraded" (never "unhealthy"
# or unreachable). 5 attempts, 10s apart — a bad deploy is loud in CI instead of being
# discovered by a user.
set -euo pipefail

URL="${1:?usage: smoke-health.sh <health-url>}"

for attempt in 1 2 3 4 5; do
  body="$(curl -fsS --max-time 10 "$URL" 2>/dev/null || true)"
  if echo "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"(ok|degraded)"'; then
    echo "healthy (attempt ${attempt}): ${body}"
    exit 0
  fi
  echo "attempt ${attempt}: not healthy yet: ${body:-<unreachable>}"
  sleep 10
done

echo "FAIL: ${URL} did not report ok/degraded after 5 attempts"
exit 1
