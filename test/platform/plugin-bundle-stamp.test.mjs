// Pins the BUNDLE STAMP half of the plugin sync script — the guard that stops the plugin's
// shipped payload from changing without a conscious decision about its `version`. An installed
// plugin only picks up changes when the version moves, so a skill can land on main, correctly
// mirrored, --check green, and reach nobody. That failure is silent by construction, which is
// exactly why it needs tests that prove the guard FAILS on it.
//
// Mostly in-process: the script exports its logic and guards its CLI block, so these drive
// `run()` directly instead of spawning node per case. The three tests at the bottom MUST spawn —
// they are about the guard itself, which an in-process caller never reaches.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Discovered, never named — a `plugins/<kit>/` literal in a fork-adopted test plants the
// template identity and reds that fork's verify:bootstrap (#178). Forks carry no plugins/
// mirror at all (new-app strips it), so this suite self-skips there.
function findPluginDir() {
  const dir = join(REPO, 'plugins');
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'sync-from-harness.mjs')))
    .map((e) => join(dir, e.name))
    .sort();
  return hits[0] ?? null;
}

const REAL_PLUGIN = findPluginDir();
const SCRIPT = REAL_PLUGIN && join(REAL_PLUGIN, 'sync-from-harness.mjs');
const { run, bundleHash, stampDrift, readManifestVersion } = REAL_PLUGIN
  ? await import(join(REAL_PLUGIN, 'sync-from-harness.mjs'))
  : {};

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A throwaway repo: one skill, the portable hook files, and a plugin shell at v1.0.0. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bundlestamp-'));
  write(root, '.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: x\n---\n');
  write(root, '.claude/hooks/guard-bash.mjs', '// hook\n');
  write(root, '.claude/hooks/warn-protected-core.mjs', '// hook\n');
  write(root, '.claude/hooks/lib/protected-branches.mjs', 'export const B = [];\n');
  write(root, '.claude/hooks/lib/remote-exec.mjs', 'export const R = null;\n');
  write(root, '.claude/hooks/lib/protected-paths.mjs', 'export const P = [];\n');
  write(root, '.claude/hooks/warn-design-drift.mjs', '// hook\n');
  const plugin = join(root, 'plugins/kit');
  write(
    root,
    'plugins/kit/.claude-plugin/plugin.json',
    `${JSON.stringify({ name: 'kit', version: '1.0.0' })}\n`,
  );
  // Payload beyond the mirrored skills/hooks — the class the first cut left unhashed.
  write(root, 'plugins/kit/commands/pave.md', '# pave\n');
  write(root, 'plugins/kit/assets/working-agreement.md', '# agreement\n');
  write(root, 'plugins/kit/hooks/hooks.json', '{}\n');
  write(root, 'plugins/kit/README.md', '# card\n');
  return { root, plugin };
}

function withFixture(body) {
  const fx = fixture();
  try {
    body(fx);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

/** Mirror + stamp, the normal starting state. */
function primed(plugin) {
  run([], plugin);
  run(['--stamp'], plugin);
}

describe('plugin bundle stamp', { skip: !REAL_PLUGIN }, () => {
  it('this repo is stamped, in sync, and at its declared version', () => {
    const res = run(['--check'], REAL_PLUGIN);
    assert.equal(res.code, 0, res.err);
    const dir = join(REAL_PLUGIN, '.claude-plugin');
    const stamp = JSON.parse(readFileSync(join(dir, 'bundle.sync.json'), 'utf8'));
    const { version } = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
    assert.equal(stamp.version, version, 'stamp must record the shipping version');
    assert.equal(stamp.sha256, bundleHash(REAL_PLUGIN));
  });

  it('refuses --check --stamp instead of letting the mutation win', () => {
    withFixture(({ plugin }) => {
      primed(plugin);
      const before = readFileSync(join(plugin, '.claude-plugin/bundle.sync.json'), 'utf8');
      const res = run(['--check', '--stamp'], plugin);
      assert.equal(res.code, 2, 'must exit non-zero and non-1 so it reads as misuse');
      assert.match(res.err, /mutually exclusive/);
      assert.equal(
        readFileSync(join(plugin, '.claude-plugin/bundle.sync.json'), 'utf8'),
        before,
        'a refused invocation must not write the stamp',
      );
    });
  });

  // The regression that made the first cut's gate bypassable: `npm run verify:plugin --
  // --stamp` expands to exactly this, on a tree --check alone rejects.
  it('refuses --check --stamp even when the tree is drifted', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      write(root, '.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: edited\n---\n');
      assert.equal(run(['--check'], plugin).code, 1, 'drifted tree must fail --check');
      assert.equal(run(['--check', '--stamp'], plugin).code, 2, 'and must not be stampable');
    });
  });

  it('fails before anything has been stamped', () => {
    withFixture(({ plugin }) => {
      run([], plugin);
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1);
      assert.match(res.err, /not yet stamped/);
    });
  });

  it('passes once stamped', () => {
    withFixture(({ plugin }) => {
      primed(plugin);
      const res = run(['--check'], plugin);
      assert.equal(res.code, 0, res.err);
      assert.match(res.out, /in sync with harness ✓ \(v1\.0\.0\)/);
    });
  });

  // THE failure this exists for: payload changes, mirror refreshed, version untouched.
  it('fails when a bundled skill changes and the version does not', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      write(root, '.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: new\n---\n');
      run([], plugin); // re-mirror, so the copies match again
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1, 'a changed payload at an unchanged version must fail');
      assert.match(res.err, /changed since the last stamp/);
    });
  });

  // The coverage hole: an allowlist of skills+hooks left most of the payload unguarded.
  for (const file of [
    'commands/pave.md',
    'assets/working-agreement.md',
    'hooks/hooks.json',
    'README.md',
    // The manifest's non-version fields (commands/skills/hooks declarations) decide what the
    // plugin exposes; an earlier cut excluded the whole .claude-plugin/ dir and left them loose.
    '.claude-plugin/plugin.json',
  ]) {
    it(`covers ${file}, which no mirror check touches`, () => {
      withFixture(({ plugin }) => {
        primed(plugin);
        // The manifest must stay valid JSON, or it fails earlier for an unrelated reason and the
        // test would pass without proving the file is inside the hash.
        writeFileSync(
          join(plugin, file),
          file.endsWith('plugin.json')
            ? `${JSON.stringify({ name: 'kit', version: '1.0.0', commands: './commands/' })}\n`
            : 'CHANGED\n',
        );
        const res = run(['--check'], plugin);
        assert.equal(res.code, 1, `${file} must be inside the stamp`);
        assert.match(res.err, /changed since the last stamp/);
      });
    });
  }

  it('mirrors .claude/agents into agents/ and covers them with the stamp', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      write(root, '.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: x\n---\n');
      const drifted = run(['--check'], plugin);
      assert.equal(drifted.code, 1, 'an unmirrored agent must fail --check');
      assert.match(drifted.err, /agents\/reviewer\.md/);
      run([], plugin);
      assert.equal(
        readFileSync(join(plugin, 'agents/reviewer.md'), 'utf8'),
        '---\nname: reviewer\ndescription: x\n---\n',
      );
      assert.match(run(['--check'], plugin).err, /changed since the last stamp/);
      run(['--stamp'], plugin);
      assert.equal(run(['--check'], plugin).code, 0);
    });
  });

  it('removes a mirrored agent once its source is gone, even with no .claude/agents left', () => {
    withFixture(({ root, plugin }) => {
      write(root, '.claude/agents/reviewer.md', '# a\n');
      primed(plugin);
      rmSync(join(root, '.claude/agents'), { recursive: true, force: true });
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1);
      assert.match(res.err, /agents\/reviewer\.md \(stale/);
      run([], plugin);
      assert.equal(existsSync(join(plugin, 'agents/reviewer.md')), false);
    });
  });

  it('ignores its own script and manifest dir, so stamping is idempotent', () => {
    withFixture(({ plugin }) => {
      primed(plugin);
      const first = bundleHash(plugin);
      run(['--stamp'], plugin); // writing the stamp must not change the hash
      assert.equal(bundleHash(plugin), first);
      writeFileSync(join(plugin, 'sync-from-harness.mjs'), '// maintainer tooling, not payload\n');
      assert.equal(bundleHash(plugin), first, 'the script itself is not payload');
    });
  });

  it('accepts a re-stamp at the same version (a change that need not ship)', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      write(root, '.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: typo\n---\n');
      run([], plugin);
      run(['--stamp'], plugin);
      assert.equal(run(['--check'], plugin).code, 0);
      const stamp = JSON.parse(
        readFileSync(join(plugin, '.claude-plugin/bundle.sync.json'), 'utf8'),
      );
      assert.equal(stamp.version, '1.0.0');
    });
  });

  it('fails when the version moves but the stamp is not refreshed', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      write(
        root,
        'plugins/kit/.claude-plugin/plugin.json',
        `${JSON.stringify({ name: 'kit', version: '2.0.0' })}\n`,
      );
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1);
      // The manifest is itself payload, so a bump trips the hash first. Either way you are told
      // to re-stamp, which is the point.
      assert.match(res.err, /changed since the last stamp/);
      assert.match(res.err, /--stamp/);
    });
  });

  it('fails when the stamp names a version the manifest does not', () => {
    withFixture(({ plugin }) => {
      primed(plugin);
      // A hand-edited stamp: the hash still matches, only the recorded version is wrong. This is
      // the one path that reaches the version comparison now that plugin.json is hashed.
      writeFileSync(
        join(plugin, '.claude-plugin/bundle.sync.json'),
        `${JSON.stringify({ version: '9.9.9', sha256: bundleHash(plugin) }, null, 2)}\n`,
      );
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1);
      assert.match(res.err, /records v9\.9\.9 but the manifest says v1\.0\.0/);
    });
  });

  it('reports mirror drift before stamp drift, and says so', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      write(
        root,
        '.claude/skills/demo/SKILL.md',
        '---\nname: demo\ndescription: unmirrored\n---\n',
      );
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1);
      assert.match(res.err, /out of sync with \.claude\//);
      assert.doesNotMatch(res.err, /bundle stamp is stale/);
    });
  });

  // Malformed inputs must produce the guard's own message, never a stack trace.
  for (const [label, body, expected] of [
    ['null', 'null\n', /not a JSON object/],
    ['an array', '[]\n', /not a JSON object/],
    ['a bare string', '"nope"\n', /not a JSON object/],
    ['truncated JSON', '{"version":\n', /not valid JSON/],
  ]) {
    it(`reports a stamp file containing ${label} rather than crashing`, () => {
      withFixture(({ plugin }) => {
        primed(plugin);
        writeFileSync(join(plugin, '.claude-plugin/bundle.sync.json'), body);
        const res = run(['--check'], plugin);
        assert.equal(res.code, 1);
        assert.match(res.err, expected);
      });
    });
  }

  it('reports an unreadable stamp distinctly from an absent one', () => {
    withFixture(({ plugin }) => {
      primed(plugin);
      const stamp = join(plugin, '.claude-plugin/bundle.sync.json');
      rmSync(stamp);
      mkdirSync(stamp); // a directory where a file belongs: EISDIR, not ENOENT
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1);
      assert.match(res.err, /unreadable/);
      assert.doesNotMatch(res.err, /not yet stamped/);
    });
  });

  for (const [label, body, expected] of [
    ['absent', null, /not found/],
    ['malformed', '{oops\n', /not valid JSON/],
    ['missing a version', '{"name":"kit"}\n', /no "version"/],
  ]) {
    it(`reports a manifest that is ${label} rather than crashing`, () => {
      withFixture(({ plugin }) => {
        primed(plugin);
        const manifest = join(plugin, '.claude-plugin/plugin.json');
        if (body === null) rmSync(manifest);
        else writeFileSync(manifest, body);
        const res = run(['--check'], plugin);
        assert.equal(res.code, 1);
        assert.match(res.err, expected);
        assert.doesNotMatch(res.err, /at Object|node:internal/, 'no stack trace');
      });
    });
  }

  it('exposes the same verdict through stampDrift as through run()', () => {
    withFixture(({ plugin }) => {
      primed(plugin);
      const { version } = readManifestVersion(plugin);
      assert.equal(stampDrift(plugin, version), '');
      writeFileSync(join(plugin, 'README.md'), 'CHANGED\n');
      assert.match(stampDrift(plugin, version), /changed since the last stamp/);
    });
  });
  it('rejects an unrecognized argument instead of mutating', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      write(root, '.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: edited\n---\n');
      const before = readFileSync(join(plugin, 'skills/demo/SKILL.md'), 'utf8');
      for (const arg of ['--help', '-h', '--dry-run', '--chekc', 'check']) {
        const res = run([arg], plugin);
        assert.equal(res.code, 2, `${arg} must be rejected, not treated as the default mode`);
        assert.match(res.err, /unrecognized argument/);
      }
      assert.equal(
        readFileSync(join(plugin, 'skills/demo/SKILL.md'), 'utf8'),
        before,
        'a rejected invocation must not have mirrored anything',
      );
    });
  });

  it('ignores untracked debris so a working tree and a clean checkout agree', () => {
    withFixture(({ plugin }) => {
      primed(plugin);
      const hash = bundleHash(plugin);
      writeFileSync(join(plugin, '.DS_Store'), 'finder junk\n');
      writeFileSync(join(plugin, 'commands/pave.md.orig'), 'merge leftover\n');
      assert.equal(bundleHash(plugin), hash, 'debris must not change the payload hash');
      assert.equal(run(['--check'], plugin).code, 0);
    });
  });

  it('reports a missing harness source instead of throwing', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      rmSync(join(root, '.claude/hooks/guard-bash.mjs'));
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1);
      assert.match(res.err, /guard-bash\.mjs: missing/);
      assert.doesNotMatch(res.err, /at Object|node:internal/, 'no stack trace');
    });
  });

  it('reports a missing .claude/skills instead of throwing', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      rmSync(join(root, '.claude/skills'), { recursive: true });
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1);
      assert.match(res.err, /nothing to mirror from/);
      assert.doesNotMatch(res.err, /at Object|node:internal/, 'no stack trace');
    });
  });

  // ── The three behaviours added to close the previous review's findings. Each was measured
  // UNPINNED before these existed: reverting the fix left the suite fully green.

  it('refuses every mode when a harness source is missing, and stamps nothing', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      const stampPath = join(plugin, '.claude-plugin/bundle.sync.json');
      const before = readFileSync(stampPath, 'utf8');
      rmSync(join(root, '.claude/hooks/guard-bash.mjs'));
      for (const argv of [[], ['--check'], ['--stamp']]) {
        const label = argv.join(' ') || '(bare)';
        const res = run(argv, plugin);
        assert.equal(res.code, 1, `${label} must be fatal, not a "synced" report`);
        assert.match(res.err, /cannot mirror the harness/, label);
        // The original defect: the missing source was reported as if it had been COPIED.
        assert.doesNotMatch(res.err ?? '', /synced/, `${label} must not claim it synced anything`);
      }
      assert.equal(
        readFileSync(stampPath, 'utf8'),
        before,
        '--stamp must not record a stamp for a tree it could not mirror',
      );
    });
  });

  it('mirrors a symlinked skill directory instead of crashing on it', () => {
    withFixture(({ root, plugin }) => {
      primed(plugin);
      // A real skill directory living elsewhere, linked into .claude/skills/. Without the
      // follow traversal this reaches readFileSync as a leaf and dies with a raw EISDIR.
      write(root, 'external/linked/SKILL.md', '---\nname: linked\ndescription: x\n---\n');
      symlinkSync(join(root, 'external/linked'), join(root, '.claude/skills/linked'));
      const res = run([], plugin);
      assert.equal(res.code, 0, res.err);
      assert.ok(
        existsSync(join(plugin, 'skills/linked/SKILL.md')),
        'the linked skill must be mirrored, not skipped or thrown on',
      );
    });
  });

  it('says what the debris pattern excluded, in both write modes', () => {
    withFixture(({ plugin }) => {
      primed(plugin);
      writeFileSync(join(plugin, 'commands/pave.md.orig'), 'debris\n');
      const bare = run([], plugin);
      assert.match(bare.out, /not hashed \(debris pattern\)[^\n]*pave\.md\.orig/);
      const stamped = run(['--stamp'], plugin);
      assert.match(
        stamped.out,
        /not hashed \(debris pattern\)[^\n]*pave\.md\.orig/,
        '--stamp commits the hash, so it above all must say what it left out',
      );
    });
  });

  it('survives a dangling symlink in the plugin tree', () => {
    withFixture(({ plugin }) => {
      primed(plugin);
      symlinkSync(join(plugin, 'gone.md'), join(plugin, 'dangling.md'));
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1, 'the link is new payload, so the stamp is stale — but no crash');
      assert.match(res.err, /changed since the last stamp/);
    });
  });
  // ── The entry-point guard. Nothing above reaches it: every case calls run() directly, so a
  // mutation of isMainModule() is invisible in-process. These spawn.
  //
  // The companion check — that IMPORTING this module has no side effects — deliberately lives in
  // main-module.test.mjs instead. It cannot live here: this file imports the module at top level,
  // so a module that exits during evaluation takes the whole suite with it, and node's runner
  // books the vanished file as ONE passing test. A mutation run proved that: 32 cases became 1,
  // green. A guard for that failure has to sit in a file the failure cannot reach.

  it('runs when reached through a symlinked path', () => {
    // The naive `pathToFileURL(argv[1])` comparison silently skips the body here — the exact
    // fail-open 1fed602 fixed for scripts/, which this file's inlined copy can reintroduce.
    const link = mkdtempSync(join(tmpdir(), 'pluginlink-'));
    const via = join(link, 'repo');
    try {
      symlinkSync(REPO, via);
      const res = spawnSync('node', [join(via, relative(REPO, SCRIPT)), '--check'], {
        encoding: 'utf8',
      });
      // Only that the body RAN. Asserting the repo is currently in sync would make unrelated
      // local drift fail this test with a message about symlinks.
      assert.notEqual(res.stdout.trim(), '', 'the gate must actually run through a symlink');
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  });

  it('distinguishes an unreadable manifest from an absent one', () => {
    withFixture(({ plugin }) => {
      primed(plugin);
      const manifest = join(plugin, '.claude-plugin/plugin.json');
      rmSync(manifest);
      mkdirSync(manifest); // a directory where a file belongs: EISDIR, not ENOENT
      const res = run(['--check'], plugin);
      assert.equal(res.code, 1);
      assert.match(res.err, /unreadable/);
      assert.doesNotMatch(res.err, /not found/, 'must not tell you to create a path that exists');
    });
  });
});
