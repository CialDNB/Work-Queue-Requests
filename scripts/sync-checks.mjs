#!/usr/bin/env node
// Keep a fork's copy of the shared kit CHECKS honest about which kit version it came from.
//
// The problem this exists for: 17 repos carry the kit, every one of them carries its own copy
// of the CI checks, and nothing said which copy was current. `/kit-upgrade` reconciles the
// whole kit by hand, so a fork could sit six months behind on a security gate and the only way
// to find out was to look. This is the narrow, mechanical version of that for the checks alone:
// one directory, one hash, one version, reported to the fleet registry beside kit_version.
//
//   node scripts/sync-checks.mjs --check          # CI gate: offline. Do my files match my stamp?
//   node scripts/sync-checks.mjs --stamp          # record the hash + version of what is here now
//   node scripts/sync-checks.mjs --pull <ref>     # fetch the payload from the kit at <ref>
//
// --check and --stamp are mutually exclusive: one verifies, the other mutates.
//
// WHY THE PAYLOAD IS A DIRECTORY, NOT A LIST. The kit's plugin sync (`sync-from-harness.mjs`)
// learned this the expensive way: its first version hashed an ALLOWLIST naming only skills and
// three hooks, which "silently left commands/, assets/ and hooks/hooks.json — most of what an
// installed user actually runs — outside the invariant it claimed to enforce." A list has to be
// remembered; a directory does not. Everything under scripts/kit-checks/ is payload except the
// stamp itself, so a check added tomorrow is covered the day it lands, by nobody's diligence.
//
// WHY --check IS OFFLINE. CI has network; a builder on a plane does not, and `npm run ci` is
// documented as "everything CI runs, locally". --check only compares local files to the local
// stamp, so it is deterministic and airplane-safe. Only --pull touches the network.
//
// WHY THE VERSION LIVES IN TWO PLACES. checks.sync.json is the stamp the sync script owns;
// CHECKS_VERSION in src/framework/version.ts is what the Worker reports to the registry, and a
// Worker cannot read a file at runtime (the same reason KIT_VERSION is a constant). Two copies
// can drift, so --check fails when they disagree and --stamp writes both together.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '..');

const PAYLOAD_DIR = 'scripts/kit-checks';
const STAMP_FILE = `${PAYLOAD_DIR}/checks.sync.json`;
const VERSION_FILE = 'src/framework/version.ts';

/** Canonical source of the payload. A fork overrides only to point at a different kit. */
const CANON_REPO = process.env.KIT_CHECKS_REPO || 'CialDNB/paved-road';

// ── payload ────────────────────────────────────────────────────────────────

/** Every file under the payload dir except the stamp. Sorted, so the hash is stable. */
export function payloadFiles(root = REPO_ROOT) {
  const dir = join(root, PAYLOAD_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else out.push(relative(root, child).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.filter((rel) => rel !== STAMP_FILE).sort();
}

/** sha256 over the payload — path and bytes, so a rename is a change. */
export function payloadHash(root = REPO_ROOT) {
  const h = createHash('sha256');
  for (const rel of payloadFiles(root)) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(root, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

// ── stamp + version ────────────────────────────────────────────────────────

export function readStamp(root = REPO_ROOT) {
  try {
    const raw = JSON.parse(readFileSync(join(root, STAMP_FILE), 'utf8'));
    if (!raw || typeof raw !== 'object') return { error: `${STAMP_FILE}: not a JSON object` };
    return raw;
  } catch (err) {
    if (err?.code === 'ENOENT') return { error: `${STAMP_FILE}: not yet stamped` };
    if (err instanceof SyntaxError) return { error: `${STAMP_FILE}: not valid JSON` };
    return { error: `${STAMP_FILE}: unreadable (${err?.code ?? err})` };
  }
}

/** CHECKS_VERSION as the Worker will report it. Read from source, not from the stamp. */
export function declaredVersion(root = REPO_ROOT) {
  try {
    const src = readFileSync(join(root, VERSION_FILE), 'utf8');
    const m = src.match(/export const CHECKS_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Every reason this tree is not in a good state. Empty array = green. */
export function drift(root = REPO_ROOT) {
  const failures = [];
  const files = payloadFiles(root);
  if (files.length === 0) {
    failures.push(`${PAYLOAD_DIR}/: no payload found — nothing to verify`);
    return failures;
  }
  const stamp = readStamp(root);
  if (stamp.error) {
    failures.push(`${stamp.error} — run: node scripts/sync-checks.mjs --stamp`);
    return failures;
  }
  const actual = payloadHash(root);
  if (stamp.sha256 !== actual) {
    failures.push(
      `${PAYLOAD_DIR}/ changed since it was stamped (stamp ${String(stamp.sha256).slice(0, 12)}…, ` +
        `actual ${actual.slice(0, 12)}…) — re-stamp, and decide whether CHECKS_VERSION should move`,
    );
  }
  const declared = declaredVersion(root);
  if (declared === null) {
    failures.push(`${VERSION_FILE}: CHECKS_VERSION not found — the Worker cannot report it`);
  } else if (stamp.checksVersion !== declared) {
    failures.push(
      `version drift: ${STAMP_FILE} says ${stamp.checksVersion}, ${VERSION_FILE} says ${declared}. ` +
        `The registry reports the second; the stamp governs the first. --stamp writes both.`,
    );
  }
  return failures;
}

export function writeStamp(root = REPO_ROOT) {
  const version = declaredVersion(root);
  if (version === null) throw new Error(`${VERSION_FILE}: CHECKS_VERSION not found — add it first`);
  const body = { checksVersion: version, sha256: payloadHash(root), source: CANON_REPO };
  writeFileSync(join(root, STAMP_FILE), `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

// ── pull ───────────────────────────────────────────────────────────────────

/**
 * Fetch the payload from the canonical repo at `ref` and write it here. Uses `gh`, which every
 * builder already has authenticated for PRs — deliberately NOT an npm dependency, so the kit's
 * own release-age gate never has to make an exception for the kit's own checks.
 */
export function pull(ref, root = REPO_ROOT) {
  if (!ref) throw new Error('--pull needs a ref: a tag, branch or sha in ' + CANON_REPO);
  const listed = execFileSync(
    'gh',
    [
      'api',
      `repos/${CANON_REPO}/contents/${PAYLOAD_DIR}?ref=${encodeURIComponent(ref)}`,
      '--jq',
      '.[] | select(.type=="file") | .name',
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((name) => `${PAYLOAD_DIR}/${name}` !== STAMP_FILE);

  for (const name of listed) {
    const content = execFileSync(
      'gh',
      [
        'api',
        `repos/${CANON_REPO}/contents/${PAYLOAD_DIR}/${name}?ref=${encodeURIComponent(ref)}`,
        '--jq',
        '.content',
      ],
      { encoding: 'utf8' },
    ).trim();
    writeFileSync(join(root, PAYLOAD_DIR, name), Buffer.from(content, 'base64'));
  }
  return listed;
}

// ── cli ────────────────────────────────────────────────────────────────────

export function run(argv, root = REPO_ROOT) {
  const check = argv.includes('--check');
  const stamp = argv.includes('--stamp');
  if (check && stamp) return { code: 2, out: '--check and --stamp are mutually exclusive' };

  const pullAt = argv.indexOf('--pull');
  if (pullAt !== -1) {
    const files = pull(argv[pullAt + 1], root);
    return {
      code: 0,
      out: `pulled ${files.length} file(s) from ${CANON_REPO}\n  then: node scripts/sync-checks.mjs --stamp`,
    };
  }

  if (stamp) {
    const body = writeStamp(root);
    return {
      code: 0,
      out: `stamped kit checks: v${body.checksVersion} (${body.sha256.slice(0, 12)}…)`,
    };
  }

  const failures = drift(root);
  if (failures.length > 0) {
    return { code: 1, out: `kit-checks drift:\n${failures.map((f) => `  - ${f}`).join('\n')}` };
  }
  const s = readStamp(root);
  return {
    code: 0,
    out: `kit checks in sync ✓ (v${s.checksVersion}, ${payloadFiles(root).length} files)`,
  };
}

// Compares realpaths so a symlinked invocation still counts as "run directly".
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { code, out } = run(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
}
