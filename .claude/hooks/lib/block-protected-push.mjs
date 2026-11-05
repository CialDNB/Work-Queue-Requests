#!/usr/bin/env node
// Editor-agnostic pre-push guard: blocks pushing to a protected branch. The git-native twin
// of the Claude Code Bash guard's pushesMain() rule (.claude/hooks/guard-bash.mjs), run from
// .githooks/pre-push for ANY tool. Reading the destination ref straight from git's stdin is
// more robust than re-parsing a command string, so this guard doesn't reuse guard-bash's
// command regexes — only the shared protected-branch definition (protected-branches.mjs).
//
// git feeds one line per ref on stdin:  <local ref> <local sha> <remote ref> <remote sha>
// Reject if any <remote ref> targets a protected branch. Exit 0 = allow, 1 = block.
// Fail-OPEN on unreadable stdin. Escape hatch: PAVEDROAD_ALLOW_PROTECTED=1.
import { readFileSync } from 'node:fs';
import { isProtectedBranch } from './protected-branches.mjs';

let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch {
  process.exit(0); // no stdin → nothing to judge
}

for (const line of input.split('\n')) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) continue; // not a refspec line
  const branch = parts[2].replace(/^refs\/heads\//, ''); // parts[2] = remote ref
  if (isProtectedBranch(branch)) {
    if (process.env.PAVEDROAD_ALLOW_PROTECTED === '1') {
      process.stderr.write(
        `⚠ PAVEDROAD_ALLOW_PROTECTED=1 — allowing a push to ${branch}. CI + branch protection still apply.\n`,
      );
      process.exit(0);
    }
    process.stderr.write(
      `
✗ Blocked: no direct pushes to ${branch}. Open a PR from your branch and let
  CI + review gate the merge (see CLAUDE.md "Git workflow").
  Override once (discouraged):  PAVEDROAD_ALLOW_PROTECTED=1 git push ...

`,
    );
    process.exit(1);
  }
}
process.exit(0);
