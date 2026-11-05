// Single source of truth for which branches forbid direct commits/pushes (every change
// rides a branch + PR — CLAUDE.md "Git workflow"). Imported by BOTH the Claude Code Bash
// guard (.claude/hooks/guard-bash.mjs) and the editor-agnostic git-native hooks
// (.githooks/, via the helpers in this dir), so the two enforcement paths can never drift
// on the definition. Add a name here and both paths protect it.
export const PROTECTED_BRANCHES = ['main', 'master'];

/** True when `name` is a protected branch. Trims + tolerates null/undefined (fail-safe). */
export function isProtectedBranch(name) {
  return PROTECTED_BRANCHES.includes(String(name ?? '').trim());
}
