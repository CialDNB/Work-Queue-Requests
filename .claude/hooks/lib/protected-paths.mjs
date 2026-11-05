// The protected core, as path patterns — the list the warn-protected-core hook warns on, in a
// module of its own so .claude/hooks/warn-protected-core.test.mjs can hold it against
// .github/CODEOWNERS, the review-routing half of the same boundary. Every path CODEOWNERS lists
// warns here, and every pattern here covers a path CODEOWNERS lists; the test fails when either
// side moves alone. Add a protected path in BOTH, in the same change.
//
// The patterns match anywhere in an absolute path, because the hook is not told the repo root.
// That is why the worker's `src/` is told apart from the SPA's `web/src/` by a lookbehind rather
// than by an anchor: `web/src/index.ts` or a `web/src/ai/` folder is feature code, `src/index.ts`
// and `src/ai/` are not.
export const PROTECTED_PATHS = [
  /(?<!\/web)\/src\/(framework|auth|data|email|security|ai|cron|mcp|platform)\//,
  /(?<!\/web)\/src\/(health|index|env)\.ts$/,
  // The in-app agent's client: it renders model output and turns it into navigation.
  /\/web\/src\/agent\//,
  /\/web\/public\/_headers$/,
  /\/schema\.sql$/,
  /\/migrations\//,
  /\/semgrep\//,
  /\/test\/(isolation|helpers|runtime|setup)\//,
  // The reviewed runtime manifests: moving a suite out of full Workers is a change to a gate.
  /\/test\/projects\.mjs$/,
  // The Trojan Source guard: narrowing what it scans is a change to a gate.
  /\/test\/platform\/source-hygiene\.test\.mjs$/,
  /\/\.github\//,
  /\/\.claude\//,
  /\/\.githooks\//,
  /\/\.cursor\//,
  /\/scripts\//,
  /\/wrangler(\.staging|\.test)?\.jsonc$/,
  /\/binding-allowlist\.jsonc$/,
  /\/(tsconfig\.json|vitest\.config\.ts|test-performance-budget\.json|biome\.json|CLAUDE\.md|AGENTS\.md)$/,
  /\/docs\/(PLAYBOOKS\.md|agent-guidance\.sync\.json)$/,
];

/** True when `filePath` (absolute) is in the protected core. Tolerates null/undefined. */
export function isProtectedPath(filePath) {
  const path = String(filePath ?? '');
  return PROTECTED_PATHS.some((re) => re.test(path));
}
