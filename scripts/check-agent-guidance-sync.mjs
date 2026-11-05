// Agent-guidance drift guard. The working agreement lives in CLAUDE.md (Claude Code reads it
// natively; non-Claude-Code tools see the same bytes through the AGENTS.md symlink). Two
// curated MIRRORS restate its load-bearing parts for other tools: the Cursor always-on rule
// (.cursor/rules/paved-road.mdc) and the skills-as-runbooks index (docs/PLAYBOOKS.md). When
// CLAUDE.md changes, those mirrors must be reconsidered — this guard makes that mechanical.
//
// It records the canonical's sha256 in docs/agent-guidance.sync.json. If CLAUDE.md changed
// since the last stamp, CI fails with a remediation message; the author reconsiders the
// mirrors and re-stamps (`npm run verify:agents -- --write`). Same UX as the permission matrix
// (consciously re-touch the mirror when the source moves) and the verify:edge fix-then-green
// loop. Deliberately TREE-ONLY (a content hash, not a `git diff` of the PR): the kit distrusts
// commit/PR-range context — "test the tree, not the commit" (DECISIONS 2026-06-12) — so this
// runs identically in `npm run ci` locally, on a PR, and on the staging gate, and rides the
// CI tree-hash memo for free. Runs in plain Node, wired into `npm run ci` + ci.yml.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './kit-checks/main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = 'docs/agent-guidance.sync.json';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Read + parse the manifest (throws a readable error if missing/invalid). */
export function readManifest(root = ROOT) {
  const path = join(root, MANIFEST);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${MANIFEST}: not found — the agent-guidance drift guard needs it`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${MANIFEST}: not valid JSON (${err.message})`);
  }
}

/** True when `linkOrFile` (AGENTS.md) and `canonical` (CLAUDE.md) are the same content. */
function pointsAtCanonical(root, mirrorPath, canonicalPath) {
  const abs = join(root, mirrorPath);
  const st = lstatSync(abs); // lstat: don't follow, so we can detect a symlink
  if (st.isSymbolicLink()) {
    const target = readlinkSync(abs);
    const resolved = isAbsolute(target) ? target : resolve(dirname(abs), target);
    return realpathSync(resolved) === realpathSync(join(root, canonicalPath));
  }
  // Windows / no-symlink fallback: a real file is fine as long as it copies the canonical.
  return readFileSync(abs).equals(readFileSync(join(root, canonicalPath)));
}

/** Failures for the current tree (empty = in sync). Pure — used by the test. */
export function agentGuidanceDrift(root = ROOT) {
  const failures = [];
  let manifest;
  try {
    manifest = readManifest(root);
  } catch (err) {
    return [err.message];
  }

  const sourcePath = manifest.source?.path;
  if (!sourcePath) return [`${MANIFEST}: missing source.path`];

  let sourceBytes;
  try {
    sourceBytes = readFileSync(join(root, sourcePath));
  } catch {
    return [`${sourcePath}: canonical agent guidance not found`];
  }
  const actual = sha256(sourceBytes);
  // Normalize the stored hash (a hand-edit could upper-case or pad it) before comparing —
  // digest('hex') is always lowercase/untrimmed.
  const recorded = String(manifest.source?.sha256 ?? '')
    .trim()
    .toLowerCase();
  if (actual !== recorded) {
    failures.push(
      `${sourcePath} changed since the mirrors were last reconciled ` +
        `(recorded ${recorded.slice(0, 12)}…, now ${actual.slice(0, 12)}…).`,
    );
  }

  for (const mirror of manifest.mirrors ?? []) {
    const p = mirror.path;
    let st;
    try {
      st = lstatSync(join(root, p));
    } catch {
      failures.push(`${p}: declared mirror is missing`);
      continue;
    }
    if (!st.isSymbolicLink() && st.size === 0) {
      failures.push(`${p}: mirror is empty`);
    }
    // The AGENTS.md mirror must actually carry the canonical's bytes (symlink or copy),
    // or non-Claude-Code tools would read a stale agreement.
    if (mirror.equalsSource) {
      try {
        if (!pointsAtCanonical(root, p, sourcePath)) {
          failures.push(
            `${p}: does not match ${sourcePath}. Expected a symlink to it (Mac/Linux/CI), or a content copy where git can't materialize symlinks (Windows without Developer Mode). Re-sync a copy with \`npm run verify:agents -- --write\`, or enable symlinks (\`git config core.symlinks true\`).`,
          );
        }
      } catch (err) {
        failures.push(`${p}: could not verify it matches ${sourcePath} (${err.message})`);
      }
    }
  }
  return failures;
}

/** Re-stamp the manifest with the canonical's current hash (the `--write` action). Also
 * re-syncs any `equalsSource` mirror that is a content COPY (not a symlink) so `--write` is
 * closed-loop on Windows / no-symlink checkouts — there the symlink path can't fix a stale
 * copy, and the read path would otherwise stay red after a re-stamp. */
export function stampManifest(root = ROOT) {
  const manifest = readManifest(root);
  const sourcePath = manifest.source?.path;
  if (!sourcePath) throw new Error(`${MANIFEST}: missing source.path — cannot re-stamp`);
  const sourceAbs = join(root, sourcePath);

  for (const mirror of manifest.mirrors ?? []) {
    if (!mirror.equalsSource) continue;
    const abs = join(root, mirror.path);
    let isSymlink = false;
    try {
      isSymlink = lstatSync(abs).isSymbolicLink();
    } catch {
      isSymlink = false; // missing → we'll (re)create it as a copy below
    }
    // A real symlink already tracks the canonical; only a copy can go stale.
    if (!isSymlink) copyFileSync(sourceAbs, abs);
  }

  manifest.source.sha256 = sha256(readFileSync(sourceAbs));
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.source.sha256;
}

function main() {
  if (process.argv.includes('--write')) {
    const hash = stampManifest();
    console.log(`Re-stamped ${MANIFEST}: source sha256 = ${hash.slice(0, 12)}…`);
    return;
  }
  const failures = agentGuidanceDrift();
  if (failures.length) {
    console.error('Agent-guidance drift guard FAILED:\n');
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(
      '\nThe canonical agent guidance (CLAUDE.md, surfaced to other tools as AGENTS.md) and its\n' +
        'curated mirrors are out of sync. Reconsider the mirrors — the Cursor rule\n' +
        '(.cursor/rules/paved-road.mdc) and the playbook index (docs/PLAYBOOKS.md) — update them if\n' +
        'the change touched a load-bearing invariant, then re-stamp:\n\n' +
        '    npm run verify:agents -- --write\n\n' +
        'Re-stamping records that you looked; it is not optional bookkeeping.',
    );
    process.exit(1);
  }
  console.log(
    'Agent-guidance drift guard passed: CLAUDE.md, AGENTS.md, and the mirrors are in sync.',
  );
}

// Run only as a CLI; importing the module (the pin test) must not exit.
if (isMainModule(import.meta.url)) {
  main();
}
