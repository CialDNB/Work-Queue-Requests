// Pins scripts/kit-checks/main-module.mjs — the guard that decides whether a CLI script's body runs.
//
// This one MUST spawn subprocesses. The bug it exists to prevent is invisible in-process: the
// entry point is whatever started node, so `run()`-style unit tests can never observe it. The
// previous form (`import.meta.url === pathToFileURL(process.argv[1]).href`) compared a
// realpathed URL against a non-realpathed one, so reaching a gate through a symlinked path made
// the comparison false, the CLI body never ran, and the process exited 0 having verified
// nothing — a gate reporting success without checking. Every assertion below is about that.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../../scripts/kit-checks/main-module.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(REPO, 'scripts');
const HELPER = join(SCRIPTS, 'kit-checks', 'main-module.mjs');

/** A temp dir plus a symlink pointing at it. mkdtemp alone is not enough on macOS, where
 *  os.tmpdir() is ALREADY behind /private — the bug needs a link we control. */
function linkedDir() {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'mainmod-')));
  const link = `${real}-link`;
  symlinkSync(real, link);
  return {
    real,
    link,
    cleanup: () => {
      rmSync(link, { force: true }); // the link is a sibling of `real`, not inside it
      rmSync(real, { recursive: true, force: true });
    },
  };
}

/** A script that prints a marker only if its body runs. */
function writeProbe(dir) {
  mkdirSync(join(dir, 'scripts', 'kit-checks'), { recursive: true });
  // COPY the shipped helper — never a hand-written stand-in. An earlier cut inlined an
  // equivalent-looking duplicate here, so these tests validated the duplicate: reverting the
  // real helper to the buggy comparison left the whole suite green.
  cpSync(HELPER, join(dir, 'scripts', 'kit-checks', 'main-module.mjs'));
  writeFileSync(
    join(dir, 'scripts', 'probe.mjs'),
    "import { isMainModule } from './kit-checks/main-module.mjs';\n" +
      "if (isMainModule(import.meta.url)) {\n  console.log('RAN');\n  process.exit(3);\n}\n",
  );
  return join(dir, 'scripts', 'probe.mjs');
}

const node = (script) => spawnSync('node', [script], { encoding: 'utf8' });

describe('isMainModule', () => {
  it('runs the body when invoked by its real absolute path', () => {
    const d = linkedDir();
    try {
      const res = node(writeProbe(d.real));
      assert.equal(res.status, 3, res.stderr);
      assert.match(res.stdout, /RAN/);
    } finally {
      d.cleanup();
    }
  });

  // THE regression: same file, reached through a symlinked ancestor.
  it('runs the body when invoked through a symlinked path', () => {
    const d = linkedDir();
    try {
      writeProbe(d.real);
      const res = node(join(d.link, 'scripts', 'probe.mjs'));
      assert.equal(
        res.status,
        3,
        `a gate reached through a symlink must still run; got exit ${res.status} and stdout ${JSON.stringify(res.stdout)}`,
      );
      assert.match(res.stdout, /RAN/);
    } finally {
      d.cleanup();
    }
  });

  it('proves the OLD form was the thing that broke', () => {
    const d = linkedDir();
    try {
      mkdirSync(join(d.real, 'scripts'), { recursive: true });
      const old = join(d.real, 'scripts', 'old.mjs');
      writeFileSync(
        old,
        "import { pathToFileURL } from 'node:url';\n" +
          'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {\n' +
          "  console.log('RAN');\n  process.exit(3);\n}\n",
      );
      assert.equal(node(old).status, 3, 'old form works on a real path');
      const viaLink = node(join(d.link, 'scripts', 'old.mjs'));
      assert.equal(viaLink.status, 0, 'old form silently did nothing — this is the bug');
      assert.equal(viaLink.stdout, '', 'and produced no output at all');
    } finally {
      d.cleanup();
    }
  });

  it('is false for a module that is not the entry point', () => {
    // The helper itself is imported, never started — unlike THIS file, which `node --test`
    // does pass as argv[1], so `isMainModule(import.meta.url)` is legitimately true here.
    const helper = pathToFileURL(join(REPO, 'scripts', 'lib', 'main-module.mjs')).href;
    assert.equal(isMainModule(helper), false);
  });

  it('fails closed on an unresolvable entry point', () => {
    const saved = process.argv[1];
    try {
      process.argv[1] = join(REPO, 'no-such-file.mjs');
      assert.equal(isMainModule(import.meta.url), false);
      process.argv[1] = undefined;
      assert.equal(isMainModule(import.meta.url), false);
    } finally {
      process.argv[1] = saved;
    }
  });

  it('throws on a bad argument instead of silently answering false', () => {
    // `isMainModule()` is the easy typo. Answering false would disable the caller's gate in
    // exactly the way the bug this helper exists to fix did, so it must be loud.
    //
    // Match the MESSAGE, not just TypeError: `fileURLToPath` throws TypeError for every one of
    // these inputs on its own, so a class-only assertion passes even with the guard deleted —
    // it pins Node's behaviour rather than ours. A mutation run proved exactly that.
    const bad = [
      undefined,
      null,
      '',
      '/tmp/x.mjs',
      'data:text/javascript,1',
      42,
      new URL('file:///tmp/x.mjs'), // a URL object is not a string; fileURLToPath accepts it
    ];
    for (const arg of bad) {
      assert.throws(() => isMainModule(arg), /expects a file: URL/, `no throw for ${String(arg)}`);
    }
  });

  it('throws on a bad argument even when there is no entry point', () => {
    // The guard runs BEFORE the `!argv[1]` early return, so `--eval`/REPL must not turn a
    // programming error into a quiet false.
    const saved = process.argv[1];
    try {
      process.argv[1] = undefined;
      assert.throws(() => isMainModule(undefined), /expects a file: URL/);
    } finally {
      process.argv[1] = saved;
    }
  });

  it('is false, not true, when neither path resolves', () => {
    // Pins the `self !== null` half of the return: two unresolvable paths are both null, and
    // null === null must not read as "this is the entry point".
    const saved = process.argv[1];
    try {
      process.argv[1] = join(REPO, 'no-such-entry.mjs');
      assert.equal(isMainModule(pathToFileURL(join(REPO, 'no-such-module.mjs')).href), false);
    } finally {
      process.argv[1] = saved;
    }
  });

  it('propagates a realpath failure that is not ENOENT', () => {
    const d = linkedDir();
    const saved = process.argv[1];
    try {
      // A symlink cycle: realpathSync raises ELOOP, which must not be read as "not main".
      const loop = join(d.real, 'loop-a');
      symlinkSync(join(d.real, 'loop-b'), loop);
      symlinkSync(loop, join(d.real, 'loop-b'));
      process.argv[1] = loop;
      assert.throws(() => isMainModule(import.meta.url), { code: 'ELOOP' });
    } finally {
      process.argv[1] = saved;
      d.cleanup();
    }
  });

  // The POSITIVE invariant. An earlier cut blacklisted one literal spelling, which is a bandaid
  // on a defect this repo has now shipped twice in two different spellings (`file:${argv[1]}`,
  // then `pathToFileURL(argv[1])`). Assert what must be TRUE instead: every gate goes through
  // the helper, and no file hand-rolls an entry-point comparison. Recursive, so scripts/kit-checks —
  // the helper itself — is inside the ban it enforces, which it previously was not.
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith('.mjs')
          ? [join(dir, e.name)]
          : [],
    );
  /** Source with comment lines dropped — the helper documents the banned form on purpose. */
  const code = (src) =>
    src
      .split('\n')
      .filter((l) => {
        const s = l.trim();
        return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*'));
      })
      .join('\n');

  // BEST EFFORT, and deliberately so: this is a spelling blacklist, and a determined rewrite
  // (`import { argv } from 'node:process'`, `!==`, a comparison via locals) evades it. It is a
  // tripwire for the two spellings this repo has actually shipped, not a proof. The proof that
  // the helper itself is correct is the symlink probe above.
  // Placed here, not in plugin-bundle-stamp.test.mjs: that suite imports the sync script at top
  // level, so a module that exits during evaluation collapses it into one phantom passing test.
  // This file never imports it, so it survives to report the failure.
  it('importing the plugin sync script has no side effects and does not exit', () => {
    const dir = join(REPO, 'plugins');
    if (!existsSync(dir)) return; // a scaffolded fork carries no plugins/ mirror
    const script = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'sync-from-harness.mjs')))
      .map((e) => join(dir, e.name, 'sync-from-harness.mjs'))
      .sort()[0];
    if (!script) return;
    const res = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(script).href)}); process.stdout.write('CLEAN');`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      res.stdout,
      'CLEAN',
      'importing it must neither print nor exit — its body writes and deletes files',
    );
  });

  it('lets no file under scripts/ hand-roll an entry-point comparison', () => {
    const banned = [
      /import\.meta\.url\s*===/,
      /===\s*import\.meta\.url/,
      /process\.argv\[1\]\s*===/,
      /===\s*process\.argv\[1\]/,
      /pathToFileURL\(process\.argv\[1\]\)/,
    ];
    // plugins/ is in scope too. Its sync script legitimately INLINES the comparison — it ships
    // where scripts/ does not exist — which makes it the copy most able to drift back to the
    // fail-open spelling and, until a mutation run showed it, the one copy nothing watched.
    const roots = [SCRIPTS, join(REPO, 'plugins')].filter((d) => existsSync(d));
    const scanned = roots.flatMap(walk);
    const offenders = scanned
      .filter((f) => banned.some((re) => re.test(code(readFileSync(f, 'utf8')))))
      .map((f) => relative(REPO, f));
    assert.deepEqual(offenders, [], 'these compare the entry point by hand — use isMainModule');
    // The walk must descend: a non-recursive version would exempt scripts/kit-checks/ — including the
    // helper itself — and a mutation run showed nothing else caught that.
    assert.ok(scanned.includes(HELPER), 'the scan must reach scripts/kit-checks/');
  });
});
