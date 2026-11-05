#!/usr/bin/env node
// Editor-agnostic pre-commit guard: blocks committing while standing ON a protected branch.
// This is the git-native twin of the Claude Code Bash guard's protected-branch rule
// (.claude/hooks/guard-bash.mjs) — it runs from .githooks/pre-commit for ANY tool (Cursor,
// VS Code, JetBrains, plain git), so non-Claude-Code builders get the same "branch first,
// then PR" line the harness gives Claude Code sessions. Both paths share the protected-branch
// definition in protected-branches.mjs, so they can't drift.
//
// Exit 0 = allow, 1 = block. Fail-OPEN on any git error (detached HEAD, not a repo): a guard
// that can't read the branch must never wedge an unrelated commit. Emergency escape hatch:
// PAVEDROAD_ALLOW_PROTECTED=1 (mirrors PAVEDROAD_SKIP_PRECOMMIT; CI is still the real wall).
import { execFileSync } from 'node:child_process';
import { isProtectedBranch } from './protected-branches.mjs';

function currentBranch() {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return ''; // detached HEAD / not a repo → nothing to protect
  }
}

const branch = currentBranch();
if (isProtectedBranch(branch)) {
  if (process.env.PAVEDROAD_ALLOW_PROTECTED === '1') {
    process.stderr.write(
      `⚠ PAVEDROAD_ALLOW_PROTECTED=1 — allowing a commit to ${branch}. CI + branch protection still apply.\n`,
    );
    process.exit(0);
  }
  process.stderr.write(
    `
✗ Blocked: no direct commits to ${branch}. Every change rides a branch + PR.
  Branch first:  git switch -c <type>/<slug> origin/main
  then commit and open a PR (see CLAUDE.md "Git workflow").
  Override once (discouraged):  PAVEDROAD_ALLOW_PROTECTED=1 git commit ...

`,
  );
  process.exit(1);
}
process.exit(0);
