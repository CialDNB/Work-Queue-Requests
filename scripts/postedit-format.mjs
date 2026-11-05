#!/usr/bin/env node
// Claude Code PostToolUse hook: auto-format files after Edit/Write so the biome
// hard gate in CI never bites on formatting. FAIL-OPEN by design — this hook must
// never block an edit; if biome is missing or errors, we exit 0 silently.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const file = input?.tool_input?.file_path;
  if (
    typeof file === 'string' &&
    /\.(ts|tsx|js|mjs|cjs|jsx|json|jsonc|css)$/.test(file) &&
    existsSync(file)
  ) {
    execFileSync('npx', ['--no-install', '@biomejs/biome', 'check', '--write', file], {
      stdio: 'ignore',
      timeout: 15_000,
    });
  }
} catch {
  // fail-open: formatting is a convenience, never a gate at edit time
}
process.exit(0);
