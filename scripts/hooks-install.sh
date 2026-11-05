#!/usr/bin/env bash
# Installs the editor-agnostic git hooks by pointing core.hooksPath at the committed,
# version-controlled .githooks/ dir. Works for ANY tool (Cursor, VS Code, JetBrains, plain
# git) — not just Claude Code, whose own guard-bash hook is wired separately via
# .claude/settings.json. Run once per clone: `npm run hooks:install`. Git never auto-installs
# committed hooks, so a fresh clone has NO local guard until this runs — which is exactly why
# non-Claude-Code builders should also turn on GitHub branch protection (server-side, the only
# guard that survives a developer who never installs the hook). See docs/COLLABORATION.md.
set -euo pipefail
cd "$(dirname "$0")/.."

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push

echo "Installed git hooks via core.hooksPath=.githooks:"
echo "  pre-commit → blocks commits to a protected branch and of local secrets files"
echo "               (.env, .dev.vars, .secrets.json), then typecheck + lint"
echo "  pre-push   → blocks pushes to a protected branch"
echo "Override once (emergencies only): PAVEDROAD_ALLOW_PROTECTED=1 git <cmd>"
echo "Override once (a deliberate .example template edit): PAVEDROAD_ALLOW_SECRET_FILE=1 git commit"
