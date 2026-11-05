// The Trojan Source fence (CVE-2021-42574): no file in the repo holds a RAW bidirectional
// embedding, override or isolate control (U+202A–U+202E, U+2066–U+2069). Such a character changes
// how a line DISPLAYS without changing what it compiles to, so a reviewer reads different code from
// the code that runs. A test that needs one writes it as an escape ('\u202E'), which shows in the
// diff. The marks a Hebrew or Arabic string legitimately carries (U+200E, U+200F, U+061C) are not
// banned. Run by `node --test` (it reads the tree with node:fs), so it is picked up by
// `test:scripts`, like its siblings.
//
// EVERY text file is scanned, from the repo root, whatever its extension: git hooks have none,
// and package.json scripts, wrangler.jsonc, CODEOWNERS and the agent guidance files all steer what
// runs. A file is text if its first 8 KB hold no NUL byte. Skipped: `.git`, dependencies and build
// output, `docs/` (prose; a fork's docs may quote right-to-left text), and any nested git checkout
// (a worktree under .claude/worktrees is another branch, not this tree).
//
// Found by the P1 dry run on il-lingua (AICOE-667): its own repo-wide guard failed on a carried
// kit test that had pasted the characters raw. The kit had no guard, so nothing caught it here.
import { strict as assert } from 'node:assert';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Skipped wherever they appear: VCS metadata and dependencies. Skipped only at the repo root:
// prose and build/test output (.test-results holds Vitest's raw report, which quotes test
// titles) — a `src/docs/` or `src/dist/` folder is source and is scanned.
const SKIP_ANY_DEPTH = new Set(['.git', 'node_modules', '.wrangler']);
const SKIP_AT_ROOT = new Set(['docs', 'dist', 'coverage', '.test-results']);
// Written with escapes on purpose: this file must pass its own scan.
const RAW_BIDI = /[\u202A-\u202E\u2066-\u2069]/u;

function isText(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(8192);
    const n = readSync(fd, head, 0, head.length, 0);
    return !head.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

function* textFiles(dir, root) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_ANY_DEPTH.has(e.name)) continue;
      if (dir === root && SKIP_AT_ROOT.has(e.name)) continue;
      if (existsSync(join(path, '.git'))) continue; // a nested checkout or worktree
      yield* textFiles(path, root);
    } else if (e.isFile() && isText(path)) {
      yield path;
    }
  }
}

/** `path:line` for every line under `base` that carries a raw bidi control, and the files read. */
function scan(base) {
  const offenders = [];
  const read = new Set();
  for (const file of textFiles(base, base)) {
    const rel = relative(base, file).split(sep).join('/');
    read.add(rel);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (RAW_BIDI.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
  }
  return { offenders, read };
}

describe('source hygiene — no raw bidi controls (Trojan Source)', () => {
  it('names the controls by escape, refuses each of them, and allows the marks', () => {
    assert.equal(RAW_BIDI.test(RAW_BIDI.source), false);
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      assert.equal(RAW_BIDI.test(String.fromCodePoint(cp)), true, cp.toString(16));
    }
    // Marks and joiners that Hebrew, Arabic or an emoji legitimately carries.
    for (const cp of [0x200e, 0x200f, 0x061c, 0x200c, 0x200d]) {
      assert.equal(RAW_BIDI.test(String.fromCodePoint(cp)), false, cp.toString(16));
    }
  });

  it('no file in the repo carries one', () => {
    const { offenders, read } = scan(REPO);
    // The walk reaches what steers execution, not just code with a known extension.
    // Files every app has, then files the kit ships that an app may drop (Insights drops
    // test/ai/ui-intents.test.ts: it runs its own AI client) — pinned only where they exist, so the
    // guard never demands a file the app chose not to carry (P1 two-stage dry run, AICOE-667).
    for (const must of ['package.json', 'src/index.ts']) {
      assert.ok(read.has(must), `the scan never read ${must}`);
    }
    for (const kit of [
      '.githooks/pre-commit',
      'wrangler.jsonc',
      '.github/CODEOWNERS',
      'test/ai/ui-intents.test.ts',
    ]) {
      if (existsSync(join(REPO, kit))) assert.ok(read.has(kit), `the scan never read ${kit}`);
    }
    assert.ok(![...read].some((f) => f.startsWith('node_modules/') || f.startsWith('docs/')));
    assert.deepEqual(
      offenders,
      [],
      'write the character as an escape (\\u202E) so a reviewer can see it',
    );
  });

  it('catches a control in a nested file, an extensionless one and a src/docs file; skips binaries, deps, root docs and nested checkouts', () => {
    const base = mkdtempSync(join(tmpdir(), 'source-hygiene-'));
    try {
      const override = String.fromCodePoint(0x202e);
      mkdirSync(join(base, 'src', 'deep'), { recursive: true });
      writeFileSync(
        join(base, 'src', 'deep', 'x.ts'),
        `const ok = 1;\nconst a = 'x${override}y';\n`,
      );
      mkdirSync(join(base, '.githooks'));
      writeFileSync(join(base, '.githooks', 'pre-commit'), `#!/bin/sh\n# ${override}\n`);
      writeFileSync(
        join(base, 'src', 'clean.ts'),
        `const he = 'שלום${String.fromCodePoint(0x200f)}';\n`,
      );
      writeFileSync(join(base, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0xe2, 0x80, 0xae]));
      mkdirSync(join(base, 'src', 'docs'));
      writeFileSync(join(base, 'src', 'docs', 'y.ts'), `'${override}'\n`);
      mkdirSync(join(base, 'docs'));
      writeFileSync(join(base, 'docs', 'prose.md'), `${override}\n`);
      mkdirSync(join(base, 'node_modules'));
      writeFileSync(join(base, 'node_modules', 'dep.js'), `'${override}'`);
      // Vitest's raw JSON report keeps a title's control raw (JSON.stringify does not escape it).
      mkdirSync(join(base, '.test-results'));
      writeFileSync(join(base, '.test-results', 'vitest.json'), `{"title":"${override}"}`);
      mkdirSync(join(base, '.claude', 'worktrees', 'old', '.git'), { recursive: true });
      writeFileSync(join(base, '.claude', 'worktrees', 'old', 'stale.ts'), `'${override}'`);
      const { offenders, read } = scan(base);
      assert.deepEqual(offenders.sort(), [
        '.githooks/pre-commit:2',
        'src/deep/x.ts:2',
        'src/docs/y.ts:1',
      ]);
      // Root docs/ is prose and skipped; a docs/ folder inside src/ is source and is read.
      assert.deepEqual([...read].sort(), [
        '.githooks/pre-commit',
        'src/clean.ts',
        'src/deep/x.ts',
        'src/docs/y.ts',
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
