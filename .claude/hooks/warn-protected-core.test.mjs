// Tests for warn-protected-core.mjs and its path list (lib/protected-paths.mjs).
//
// The hook and .github/CODEOWNERS are two halves of one boundary: CODEOWNERS routes the review,
// the hook makes the crossing visible while the edit is being made. They were kept in step by
// hand and had drifted — CODEOWNERS covered src/mcp, src/platform, src/index.ts, src/env.ts and
// migrations/ while the hook warned on none of them. So the consistency is pinned here, over
// every file in the repo plus the paths the kit is about to grow (web/src/agent/):
//   - EVERYWHERE, every path the hook warns on has an owner in CODEOWNERS. A fork takes the kit's
//     CODEOWNERS entries (with its own owner) through /kit-upgrade, so the kit's protected core is
//     routed to review in every app.
//   - IN THE KIT ONLY (wrangler.jsonc still carries the template's name, the signal the kit's
//     other gates read), the other direction too: every path CODEOWNERS owns warns, and no pattern
//     here is dead. A fork may own MORE than the kit protects (insights owns src/ingest/ and
//     src/cial/), and this file rides /kit-upgrade into it — held to both directions there, its
//     test:hooks would go red with the only remedy an edit to this kit-owned list.
//
// Plain `node --test`, wired into CI via the `test:hooks` script.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as newApp from '../../scripts/new-app.mjs';
import { isProtectedPath, PROTECTED_PATHS } from './lib/protected-paths.mjs';

const HOOK = fileURLToPath(new URL('./warn-protected-core.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../..', import.meta.url));
// Paths are judged under a synthetic root, so the answer never depends on where the checkout sits.
const ROOT = '/work/app';
const at = (rel) => `${ROOT}/${rel}`;

/**
 * The unforked kit, or an app? An unreadable wrangler.jsonc reads as the kit, so the stricter set
 * of tests runs. A scripts/new-app.mjs too old to export the identity (an app that took .claude/
 * ahead of scripts/) can only be an app: the kit's own is pinned to export both.
 */
function unforkedKit() {
  const { parseJsonc, TEMPLATE_KEBAB } = newApp;
  if (typeof parseJsonc !== 'function' || typeof TEMPLATE_KEBAB !== 'string') return false;
  try {
    return parseJsonc(readFileSync(join(REPO, 'wrangler.jsonc'), 'utf8'))?.name === TEMPLATE_KEBAB;
  } catch {
    return true;
  }
}
const KIT_ONLY = unforkedKit() ? {} : { skip: 'an app may own paths the kit does not protect' };

/** CODEOWNERS entries (root-anchored patterns), in file order. */
function codeownersEntries() {
  return readFileSync(join(REPO, '.github', 'CODEOWNERS'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0]);
}

/** Whether CODEOWNERS assigns an owner to repo-relative `rel`: a `/dir/` entry covers everything
 *  under it, a `/file` entry that file. (Every kit entry is root-anchored and names an owner.) */
function owned(entries, rel) {
  return entries.some((entry) =>
    entry.endsWith('/') ? `/${rel}`.startsWith(entry) : `/${rel}` === entry,
  );
}

/** Every file in the working tree, repo-relative — build output and dependencies aside, and
 *  tools/: platform-maintainer sub-projects with their own `src/`, `tsconfig.json` and wrangler
 *  config, which the hook (told only an absolute path, never the repo root) cannot tell from the
 *  app's. It warns there; that is the known, harmless direction of the imprecision. */
function repoFiles() {
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', '.wrangler', 'tools']);
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(relative(REPO, abs).split(sep).join('/'));
    }
  };
  walk(REPO);
  return out;
}

function runHook(stdin) {
  return execFileSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8' });
}

// Paths the kit does not have yet, or that exist to be told apart: the protected ones P1–P3 add,
// and the SPA's look-alikes of worker paths, which are feature code.
const PROSPECTIVE = {
  protected: [
    'src/mcp/server.ts',
    'src/platform/logEvent.ts',
    'src/env.ts',
    'src/index.ts',
    'migrations/d1/0099_agent_tables.sql',
    'migrations/supabase/0001_init.sql',
    'web/src/agent/reducer.ts',
    'web/src/agent/aguiClient.ts',
  ],
  feature: [
    'src/routes/notes.ts',
    'web/src/pages/Notes.tsx',
    'web/src/index.ts',
    'web/src/env.ts',
    'web/src/ai/summary.ts',
    'web/src/platform/theme.ts',
    'web/src/i18n/he.ts',
    'web/src/views.ts',
    'test/routes/notes.test.ts',
    'docs/GO-LIVE.md',
  ],
};

/** Repo files plus the prospective paths, each judged by the hook and by CODEOWNERS. */
function judged() {
  const entries = codeownersEntries();
  assert.ok(entries.length > 20, `read ${entries.length} CODEOWNERS entries`);
  const paths = [...new Set([...repoFiles(), ...PROSPECTIVE.protected, ...PROSPECTIVE.feature])];
  return paths.map((rel) => ({ rel, warns: isProtectedPath(at(rel)), owned: owned(entries, rel) }));
}

test('every path the hook warns on has an owner in CODEOWNERS', () => {
  const unowned = judged()
    .filter(({ warns, owned }) => warns && !owned)
    .map(({ rel }) => `${rel}: hook warns, CODEOWNERS does not own it`);
  assert.deepEqual(
    unowned,
    [],
    'lib/protected-paths.mjs protects a path .github/CODEOWNERS routes to nobody — add the owner ' +
      "(in an app: take the kit's CODEOWNERS entries on /kit-upgrade, with your own owner)",
  );
});

test('every path CODEOWNERS owns warns (the kit only: an app may own more)', KIT_ONLY, () => {
  const silent = judged()
    .filter(({ warns, owned }) => owned && !warns)
    .map(({ rel }) => `${rel}: CODEOWNERS owns it, hook silent`);
  assert.deepEqual(silent, [], 'lib/protected-paths.mjs and .github/CODEOWNERS disagree');
});

test(
  'a directory entry in CODEOWNERS is protected even while the directory is empty',
  KIT_ONLY,
  () => {
    // The walk above only sees files that exist. A CODEOWNERS directory with nothing in it yet (the
    // agent's web/src/agent/ lands in a later phase) must still warn on its first file.
    for (const entry of codeownersEntries()) {
      const sample = entry.endsWith('/') ? `${entry}new-file.ts` : entry;
      assert.ok(isProtectedPath(`${ROOT}${sample}`), `${entry} does not warn`);
    }
  },
);

test('the paths P1 made protected warn; their SPA look-alikes do not', () => {
  for (const rel of PROSPECTIVE.protected) assert.ok(isProtectedPath(at(rel)), rel);
  for (const rel of PROSPECTIVE.feature) assert.ok(!isProtectedPath(at(rel)), rel);
});

test(
  'every pattern in the list is exercised by some owned path (no dead entries)',
  KIT_ONLY,
  () => {
    const entries = codeownersEntries();
    const samples = [
      ...repoFiles().filter((rel) => owned(entries, rel)),
      ...PROSPECTIVE.protected,
    ].map(at);
    for (const re of PROTECTED_PATHS) {
      assert.ok(
        samples.some((p) => re.test(p)),
        `${re} matches no path CODEOWNERS owns — remove it or add the owner`,
      );
    }
  },
);

test('the hook warns on a protected path and is silent otherwise', () => {
  const warn = runHook(JSON.stringify({ tool_input: { file_path: at('src/mcp/tools.ts') } }));
  const { systemMessage } = JSON.parse(warn);
  assert.match(systemMessage, /^⚠ Protected core \(mcp\/tools\.ts\)/);
  assert.equal(runHook(JSON.stringify({ tool_input: { file_path: at('src/routes/x.ts') } })), '');
  // Malformed input and a missing path both allow silently — the hook only ever warns.
  assert.equal(runHook('not json'), '');
  assert.equal(runHook(JSON.stringify({ tool_input: {} })), '');
  assert.equal(isProtectedPath(undefined), false);
});
