#!/usr/bin/env node
// PreToolUse scope-lock warning: editing the protected core is allowed but never
// casual. This hook makes the boundary visible at the moment it's crossed. The paths are
// lib/protected-paths.mjs, held against .github/CODEOWNERS by warn-protected-core.test.mjs.
import { readFileSync } from 'node:fs';
import { isProtectedPath } from './lib/protected-paths.mjs';

let filePath = '';
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  filePath = String(input?.tool_input?.file_path ?? '');
} catch {
  process.exit(0);
}

if (isProtectedPath(filePath)) {
  const name = filePath.split('/').slice(-2).join('/');
  console.log(
    JSON.stringify({
      systemMessage: `⚠ Protected core (${name}): CODEOWNERS-gated (auth / data fence / framework / migrations / agent / CI / harness). Keep the change deliberate — its own PR, adversarial tests, code-owner review. Feature work belongs in src/routes/ and web/.`,
    }),
  );
}
process.exit(0);
