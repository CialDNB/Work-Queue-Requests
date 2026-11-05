// Pins the pure logic behind /port-ui's two scripts (.claude/skills/port-ui/):
//   - scope-kit-css.mjs: the kit baseline must be fully scoped and namespaced, or it leaks into a
//     ported app's screens (the failure that motivated it: kit-blue buttons, full-width selects
//     and a 1180px `.app` inside a ported sidebar shell);
//   - parity.mjs: argument parsing, screen-map validation and the style-census delta (the drift
//     signal the parity reviewer works from).
// Neither needs a browser; the screenshot half of parity.mjs is exercised by /port-ui itself.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = join(REPO, '.claude', 'skills', 'port-ui');
// The kit itself: its marketplace manifest never survives into a fork (new-app strips it, and
// verify:bootstrap fails a fork that has one).
const IN_KIT = existsSync(join(REPO, '.claude-plugin', 'marketplace.json'));
// Skip ONLY where /port-ui was never adopted (no skill directory), and say so. Anywhere the skill
// is present, and always in the kit, its scripts must load: a moved or renamed script fails here
// instead of turning both suites into a green "0 tests".
const NOT_ADOPTED =
  IN_KIT || existsSync(join(SKILL, 'SKILL.md'))
    ? false
    : '/port-ui is not adopted in this repo (.claude/skills/port-ui/ is absent)';
const scope = NOT_ADOPTED ? {} : await import(join(SKILL, 'scope-kit-css.mjs'));
const parity = NOT_ADOPTED ? {} : await import(join(SKILL, 'parity.mjs'));

/** Every style rule in `css`, including those inside grouping at-rules, as `{ selector }`. */
function rulesOf(css) {
  return scope.topLevel(css).flatMap((c) => {
    if (c.type === 'rule') return [c];
    if (c.type === 'at' && /^@(media|supports|container|layer)\b/.test(c.prelude)) {
      return rulesOf(c.body);
    }
    return [];
  });
}

/** Fails naming the first source selector whose scoped form is missing from `out`. */
function assertEverySelectorScoped(src, out) {
  const flat = out.replace(/\s+/g, ' ');
  let checked = 0;
  for (const rule of rulesOf(src)) {
    for (const part of scope.splitSelectors(rule.selector)) {
      const want = scope.scopeOne(part, '.kit-page');
      if (!want) continue; // a page-level-only selector: the source theme owns the page
      assert.ok(flat.includes(want.replace(/\s+/g, ' ')), `${part}: missing from the scoped copy`);
      checked++;
    }
  }
  return checked;
}

/**
 * `fn(path)` on a kit-shaped stylesheet in a fresh temp dir. Only the kit-only test reads the
 * real web/src/styles.css: in a fork that file is app-owned, and may hold at-rules the scoper
 * refuses (`@page`) or be gone.
 */
function withFixtureCss(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'scope-kit-fixture-'));
  try {
    const input = join(tmp, 'styles.css');
    writeFileSync(input, ':root { --accent: #0050f0; }\nbutton { color: var(--accent); }\n');
    return fn(input);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('scope-kit-css', { skip: NOT_ADOPTED }, () => {
  const css = `
    /* comment { not a rule } */
    :root { --accent: #0050f0; --radius: 10px; }
    body { margin: 0; font-family: system-ui; }
    * { box-sizing: border-box; }
    button, .btn { background: var(--accent); border-radius: var(--radius); }
    @media (max-width: 600px) { .card { padding: 4px; } html { font-size: 12px; } }
    @keyframes pulse { from { opacity: var(--o); } }
    @import url("x.css");
  `;
  const out = scope.scopeKitCss(css, '.kit-page');

  it('prefixes every selector with the scope and drops page-level rules', () => {
    assert.match(out, /\.kit-page button,\n\.kit-page \.btn \{/);
    assert.match(out, /\.kit-page \* \{/);
    assert.doesNotMatch(out, /(^|\n)\s*body\s*\{/);
    assert.doesNotMatch(out, /\.kit-page (:root|body|html)\b/);
  });

  it('moves every kit custom property into the --kit-* namespace', () => {
    assert.match(out, /var\(--kit-accent\)/);
    assert.match(out, /var\(--kit-radius\)/);
    assert.doesNotMatch(out.replace(/--kit-[\w-]+/g, ''), /var\(--/);
  });

  it('seeds the kit values as a zero-specificity fallback the bridge can override', () => {
    assert.match(
      out,
      /:where\(:root\) \{\n {2}--kit-accent: #0050f0;\n {2}--kit-radius: 10px;\n\}/,
    );
  });

  it('scopes rules inside @media, keeps @keyframes, drops @import', () => {
    assert.match(out, /@media \(max-width: 600px\) \{\n {2}\.kit-page \.card \{/);
    assert.doesNotMatch(out, /kit-page html/);
    assert.match(out, /@keyframes pulse \{[\s\S]*var\(--kit-o\)/);
    assert.doesNotMatch(out, /@import/);
  });

  // Kit only: a fork's web/src/styles.css is app-owned (the 2026-10-04 lesson: kit tests never read
  // app-owned data). Token blocks are recognised by SHAPE, not position: a rule ahead of :root
  // (a fork's dark theme, or the kit's own one day) must not turn this red.
  it('scopes the real kit stylesheet with no unscoped selector left behind', {
    skip: IN_KIT ? false : "kit only: a fork's web/src/styles.css is app-owned",
  }, () => {
    const src = readFileSync(join(REPO, 'web', 'src', 'styles.css'), 'utf8');
    const real = scope.scopeKitCss(src);
    assert.ok(assertEverySelectorScoped(src, real) > 20, 'the kit stylesheet has its rules');
    const tokenOnly = /^\{(\s*--kit-[\w-]+\s*:[^;{}]+;)+\s*\}$/;
    for (const block of real.split('\n\n').slice(1)) {
      const open = block.indexOf('{');
      const selector = block.slice(0, open).trim();
      if (!selector || selector.startsWith('@') || tokenOnly.test(block.slice(open).trim())) {
        continue;
      }
      for (const part of scope.splitSelectors(selector)) {
        assert.match(part, /^(?:(?:html|body|:root)\S* )?\.kit-page /, part);
      }
    }
  });

  it('runs the same checks on a fork-shaped stylesheet (a rule before :root)', () => {
    const src = `:root[data-theme=dark] { --bg: #000; }
      .shell { display: grid; }
      :root { --accent: #0050f0; }
      button { color: var(--accent); }`;
    const out = scope.scopeKitCss(src);
    assert.equal(assertEverySelectorScoped(src, out), 2);
    assert.match(out, /:root\[data-theme=dark\] \{\n {2}--kit-bg: #000;/);
  });

  it('/kit-upgrade carries what /port-ui points at outside .claude/', () => {
    // CLAUDE.md, the Cursor rule, PLAYBOOKS and SKILL.md all link docs/DESIGN-PORT.md (the delta
    // catalogue), and forks are told to run this test: a diff set without them leaves a fork's
    // guidance pointing at a file it never received.
    const upgrade = readFileSync(
      join(REPO, '.claude', 'skills', 'kit-upgrade', 'SKILL.md'),
      'utf8',
    );
    const diffSet = upgrade.match(/git diff HEAD kit\/main -- ([^`]+)`/)?.[1].split(/\s+/) ?? [];
    for (const path of [
      '.claude',
      'docs/DESIGN-PORT.md',
      'test/platform/port-ui-scripts.test.mjs',
    ]) {
      assert.ok(diffSet.includes(path), `${path} is not in the /kit-upgrade diff set`);
    }
  });

  it('tells forks to take those paths by hand on the upgrade that adds them to the diff set', {
    skip: IN_KIT ? false : "kit only: CHANGELOG.md is the kit's own release notes",
  }, () => {
    // A fork adopting this release runs its CURRENT /kit-upgrade, whose diff set lists neither
    // path: that upgrade carries CLAUDE.md, .cursor, PLAYBOOKS and the skill, which all link
    // docs/DESIGN-PORT.md, but not the doc itself, and it drops the test.
    const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8');
    const start = changelog.indexOf('`/port-ui`, two subagents');
    assert.ok(start > 0, 'the /port-ui CHANGELOG entry');
    const entry = changelog.slice(start, changelog.indexOf('\n- **', start)).replace(/\s+/g, ' ');
    assert.match(
      entry,
      /git checkout kit\/main -- docs\/DESIGN-PORT\.md test\/platform\/port-ui-scripts\.test\.mjs/,
    );
    assert.doesNotMatch(entry, /none beyond `\/kit-upgrade`/);
  });

  it('a port re-checks kit-scoped.css: /kit-upgrade does not carry styles.css', () => {
    // styles.css is app-owned (web/ outside web/src/agent): kit changes to it arrive as manual
    // steps, so nothing regenerates the scoped copy unless a step says to run --check.
    const upgrade = readFileSync(
      join(REPO, '.claude', 'skills', 'kit-upgrade', 'SKILL.md'),
      'utf8',
    );
    const diffSet = upgrade.match(/git diff HEAD kit\/main -- ([^`]+)`/)?.[1].split(/\s+/) ?? [];
    assert.ok(!diffSet.some((p) => p === 'web' || p === 'web/src' || p === 'web/src/styles.css'));
    assert.match(upgrade, /scope-kit-css\.mjs --check/);
    const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
    assert.match(skill.slice(skill.indexOf('## Phase 6')), /scope-kit-css\.mjs[^\n]*--check/);
    for (const file of [
      join(SKILL, 'SKILL.md'),
      join(SKILL, 'scope-kit-css.mjs'),
      join(REPO, 'docs', 'DESIGN-PORT.md'),
      join(REPO, 'docs', 'DECISIONS.md'),
    ]) {
      const text = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
      assert.doesNotMatch(text, /kit-upgrade`? (keeps merging|merges) (it|`?styles\.css)/, file);
    }
  });

  it("the contract template's token bridge maps the kit's --kit-* names, never bare ones", () => {
    // The scoped baseline reads only --kit-*; a bridge filled with bare kit names (--muted, --bg)
    // overrides the source's own tokens and invites `--muted: var(--muted)`, a cycle.
    const template = readFileSync(join(SKILL, 'references', 'design-contract.template.md'), 'utf8');
    // The bridge list is the code span of placeholders right after the heading.
    const bridge = template.slice(template.indexOf('**Token bridge**'));
    const list = bridge.match(/`([^`]*【】[^`]*)`/)?.[1] ?? '';
    const names = list.match(/--[\w-]+/g) ?? [];
    assert.ok(names.length >= 9, names.join(' '));
    for (const name of names) assert.match(name, /^--kit-/, name);
  });

  it("the design.json schema warns that verify:bootstrap scans it for the kit's name", () => {
    // The kit's app-metadata folder, where design.json lives, is not a self-reference prefix, so an
    // absolute source.path under a folder named after the kit turns a port PR's verify:bootstrap
    // red with a misleading fix hint.
    const schema = readFileSync(join(SKILL, 'references', 'design.schema.md'), 'utf8');
    assert.match(schema.replace(/\s+/g, ' '), /verify:bootstrap` scans this file/);
    assert.match(schema, /"path": "\.\.\/[^"]+", +\/\/ local checkout, RELATIVE/);
  });

  it('SKILL.md runs its scripts from its own directory, never a hard-coded repo path', () => {
    // The plugin exposes its port-ui command to repos that have no .claude/skills/port-ui/ yet.
    const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /node \.claude\/skills\/port-ui\//);
    for (const script of ['parity.mjs', 'scope-kit-css.mjs']) {
      assert.match(skill, new RegExp(`node <skill-dir>/${script.replace('.', '\\.')}`), script);
    }
    const stale = withFixtureCss((input) =>
      scope.run(['--in', input, '--out', '/nonexistent/x.css', '--check']),
    );
    assert.ok(stale.err.includes(join(SKILL, 'scope-kit-css.mjs')), stale.err);
  });

  it('every script SKILL.md runs exists next to it', () => {
    const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
    const scripts = [...new Set(skill.match(/[\w-]+\.mjs\b/g) ?? [])];
    assert.deepEqual(scripts.sort(), ['parity.mjs', 'scope-kit-css.mjs']);
    for (const script of scripts) assert.ok(existsSync(join(SKILL, script)), script);
  });

  it('splits only top-level commas and keeps page-level conditions in front', () => {
    const t = scope.scopeKitCss(
      `.x:is(a, b) { color: red; }
       body.dark .card { color: var(--text); }
       html[dir=rtl] .tab { margin: 0; }
       :root[data-theme=dark] { --accent: #fff; --accent-soft: color-mix(in srgb, var(--accent) 12%, white); }
       @media (prefers-color-scheme: dark) { :root { --bg: #000; } }`,
      '.kit-page',
    );
    assert.match(t, /\.kit-page \.x:is\(a, b\) \{/);
    assert.match(t, /body\.dark \.kit-page \.card \{/);
    assert.match(t, /html\[dir=rtl\] \.kit-page \.tab \{/);
    assert.match(
      t,
      /:root\[data-theme=dark\] \{\n {2}--kit-accent: #fff;\n {2}--kit-accent-soft: color-mix\(in srgb, var\(--kit-accent\) 12%, white\);/,
    );
    assert.match(
      t,
      /@media \(prefers-color-scheme: dark\) \{\n {2}:where\(:root\) \{\n {4}--kit-bg: #000;/,
    );
  });

  it('loses no rule: statements, @layer, @container, nesting, mixed :root lists, strings', () => {
    // Each construct below was silently dropped (or swallowed the next rule). The script is
    // re-run after every kit upgrade, so the first upgrade that adds one would ship unstyled kit
    // pages with --check reporting the copy as current.
    const src = `@charset "utf-8";
       :root { --a: 1px; }
       @layer base, components;
       button { color: red; }
       @layer base { .card { padding: 4px; } }
       @container (min-width: 400px) { .grid { gap: 2px; } }
       @media (min-width: 1px) { @supports (display: grid) { .tab { margin: 0; } } }
       :root, .dark { --bg: #000; }
       .q::before { content: "{ not a block"; }
       .after-string { padding: 1px; }
       @property --spin { syntax: '<angle>'; inherits: false; initial-value: 0deg; }`;
    const t = scope.scopeKitCss(src, '.kit-page');
    assert.equal(assertEverySelectorScoped(src, t), 7);
    assert.match(t, /:where\(:root\) \{\n {2}--kit-a: 1px;/);
    assert.match(t, /@layer base, components;/);
    assert.match(t, /\.kit-page button \{/);
    assert.match(t, /@layer base \{\n {2}\.kit-page \.card \{/);
    assert.match(t, /@container \(min-width: 400px\) \{\n {2}\.kit-page \.grid \{/);
    assert.match(t, /@supports \(display: grid\) \{\n {4}\.kit-page \.tab \{/);
    assert.match(t, /:where\(:root\) \{\n {2}--kit-bg: #000;/);
    assert.match(t, /\.kit-page \.dark \{\s*--kit-bg: #000;/);
    assert.match(t, /\.kit-page \.q::before \{\s*content: "\{ not a block";/);
    assert.match(t, /\.kit-page \.after-string \{\s*padding: 1px;/);
    assert.match(t, /@property --kit-spin \{/);
    assert.doesNotMatch(t, /@charset/);
  });

  it('refuses an at-rule it does not know how to scope instead of dropping it', () => {
    assert.throws(
      () => scope.scopeKitCss('@scope (.card) { .title { color: red; } }'),
      /unhandled at-rule @scope/,
    );
    assert.throws(
      () => scope.scopeKitCss('@namespace svg url(x);'),
      /unhandled at-rule @namespace/,
    );
  });

  it('--check: current after a write, stale after any change, and a missing input fails', () => {
    // Every fork runs --check after an upgrade: output that is not deterministic (a timestamp in
    // the header) or a check that never says "current" would leave it red forever.
    const tmp = mkdtempSync(join(tmpdir(), 'scope-kit-'));
    try {
      const input = join(tmp, 'styles.css');
      const output = join(tmp, 'kit-scoped.css');
      writeFileSync(input, ':root { --accent: #0050f0; }\nbutton { color: var(--accent); }\n');
      assert.equal(scope.run(['--in', input, '--out', output]).code, 0);
      const current = scope.run(['--in', input, '--out', output, '--check']);
      assert.equal(current.code, 0, current.err);
      assert.match(current.out, /current/);
      // Re-generating in ANOTHER process is byte-identical (no timestamp, no ordering noise): a
      // fork's --check runs long after the copy was written.
      const first = readFileSync(output, 'utf8');
      const again = join(tmp, 'again.css');
      const cli = spawnSync(
        process.execPath,
        [join(SKILL, 'scope-kit-css.mjs'), '--in', input, '--out', again],
        { encoding: 'utf8' },
      );
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(readFileSync(again, 'utf8'), first);
      writeFileSync(output, `${first} `);
      assert.equal(scope.run(['--in', input, '--out', output, '--check']).code, 1);
      writeFileSync(output, first);
      writeFileSync(input, ':root { --accent: #000; }\nbutton { color: var(--accent); }\n');
      assert.equal(scope.run(['--in', input, '--out', output, '--check']).code, 1);
      const missing = scope.run(['--in', join(tmp, 'nope.css'), '--out', output, '--check']);
      assert.equal(missing.code, 1);
      assert.match(missing.err, /not found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--check reports a stale copy instead of writing', () => {
    const res = withFixtureCss((input) =>
      scope.run(['--in', input, '--out', '/nonexistent/x.css', '--check']),
    );
    assert.equal(res.code, 1);
    assert.match(res.err, /stale/);
    assert.equal(existsSync('/nonexistent/x.css'), false);
  });

  it("stays green in a fork whatever the fork's own styles.css holds, or without one", {
    skip: process.env.PORT_UI_FORK_SIMULATION ? 'already inside the fork simulation' : false,
  }, () => {
    // A fork receives this file and .claude/ on every /kit-upgrade, but web/src/styles.css is
    // app-owned (the 2026-10-04 lesson): print styles (`@page`), a view transition or a deleted
    // stylesheet must not turn a fork's `npm run ci` red. The suite is re-run in a fork-shaped
    // copy (no marketplace manifest) whose stylesheet the scoper refuses, then with none.
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'port-ui-fork-')));
    try {
      for (const dir of ['.claude', 'docs']) {
        cpSync(join(REPO, dir), join(tmp, dir), { recursive: true });
      }
      mkdirSync(join(tmp, 'test', 'platform'), { recursive: true });
      cpSync(
        fileURLToPath(import.meta.url),
        join(tmp, 'test', 'platform', 'port-ui-scripts.test.mjs'),
      );
      mkdirSync(join(tmp, 'web', 'src'), { recursive: true });
      const styles = join(tmp, 'web', 'src', 'styles.css');
      for (const css of ['.shell { display: grid; }\n@page { margin: 1cm; }\n', null]) {
        if (css === null) rmSync(styles, { force: true });
        else writeFileSync(styles, css);
        const run = spawnSync(
          process.execPath,
          [
            '--test',
            '--test-reporter=tap',
            join(tmp, 'test', 'platform', 'port-ui-scripts.test.mjs'),
          ],
          {
            cwd: tmp,
            encoding: 'utf8',
            // NODE_TEST_CONTEXT would make the child report to this runner, not to stdout.
            env: { ...process.env, NODE_TEST_CONTEXT: undefined, PORT_UI_FORK_SIMULATION: '1' },
          },
        );
        const failed = (run.stdout.match(/^\s*not ok .*$/gm) ?? []).join('\n');
        assert.equal(run.status, 0, `${css ? 'with @page' : 'without styles.css'}:\n${failed}`);
        assert.match(run.stdout, /# skipped [1-9]/); // the kit-only real-stylesheet test
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('parity', { skip: NOT_ADOPTED }, () => {
  it('parses --key value pairs; rejects stray words', () => {
    assert.deepEqual(parity.parseArgs(['--source', 'http://a', '--only', 'x,y']), {
      source: 'http://a',
      only: 'x,y',
    });
    assert.throws(() => parity.parseArgs(['oops']), /unexpected argument/);
  });

  it('reads --key=value too, and refuses a credential flag in either form', () => {
    assert.deepEqual(parity.parseArgs(['--source=http://a', '--only=x']), {
      source: 'http://a',
      only: 'x',
    });
    for (const flag of ['target-login', 'target-cookie', 'source-cookie']) {
      for (const argv of [[`--${flag}=secret-value`], [`--${flag}`, 'secret-value']]) {
        assert.throws(
          () => parity.credentialsFrom(parity.parseArgs(argv), {}),
          /environment variable/,
          argv.join(' '),
        );
      }
    }
  });

  it('refuses an unknown option or a value option with no value, instead of ignoring it', () => {
    assert.throws(() => parity.parseArgs(['--sorce', 'http://a']), /unknown option --sorce/);
    assert.throws(() => parity.parseArgs(['--targt=http://a']), /unknown option --targt/);
    assert.throws(() => parity.parseArgs(['--source']), /--source needs a value/);
    assert.throws(() => parity.parseArgs(['--out', '--only', 'x']), /--out needs a value/);
  });

  it('validates the screen map and honours --only', () => {
    const design = {
      screens: [
        { id: 'a', source: '/', target: '/a' },
        { id: 'b', source: '/b', target: '/b' },
      ],
    };
    assert.deepEqual(
      parity.screensFrom(design, 'b').map((s) => s.id),
      ['b'],
    );
    assert.throws(
      () => parity.screensFrom({ screens: [{ id: 'x', source: '/' }] }),
      /missing target/,
    );
    assert.throws(() => parity.screensFrom({ screens: [] }), /no screens/);
  });

  it('enforces the schema: unique kebab-case ids, and paths rather than URLs', () => {
    const ok = { id: 'board', source: '/b', target: '/b' };
    const bad = (s) => () => parity.screensFrom({ screens: [ok, s] });
    // The id goes into the screenshot file name: a duplicate overwrites a pair, and a path-like id
    // writes outside the output directory.
    assert.throws(bad({ ...ok }), /board: duplicate id/);
    for (const id of ['../../web/public/x', 'a/b', 'Board', 'a b', '-a', 'a--b']) {
      assert.throws(bad({ ...ok, id }), /kebab-case/, id);
    }
    for (const path of ['https://evil.example/x', '//evil.example/x', 'board', '']) {
      assert.throws(bad({ ...ok, id: 'x', source: path }), /x: source must be a path/, path);
      assert.throws(bad({ ...ok, id: 'x', target: path }), /x: target must be a path/, path);
    }
    assert.equal(parity.screensFrom({ screens: [ok, { ...ok, id: 'board-2' }] }).length, 2);
  });

  it('refuses a "path" the URL parser turns into another host, and never navigates off-origin', () => {
    // The WHATWG parser reads `\` as `/` in http(s) URLs and strips tabs and newlines, so each of
    // these resolves to http://evil.example/x against any base: a screenshot of a host that
    // checkSource never allowed, past the schema's "paths, not URLs" rule.
    const ok = { id: 'board', source: '/b', target: '/b' };
    const offOrigin = [
      '/\\evil.example/x',
      '/\t/evil.example/x',
      '/\n/evil.example/x',
      '/\r/evil.example/x',
      '\\/evil.example/x',
    ];
    for (const path of offOrigin) {
      assert.equal(new URL(path, 'http://localhost:5175').host, 'evil.example', 'premise');
      const bad = (side) => () =>
        parity.screensFrom({ screens: [ok, { ...ok, id: 'x', [side]: path }] });
      assert.throws(bad('source'), /x: source must be a path/, JSON.stringify(path));
      assert.throws(bad('target'), /x: target must be a path/, JSON.stringify(path));
      assert.throws(
        () => parity.screenUrl('http://localhost:5175', path),
        /not a path on http:\/\/localhost:5175/,
        JSON.stringify(path),
      );
    }
    // A path that keeps the origin is unchanged, query and hash included.
    assert.equal(
      parity.screenUrl('http://127.0.0.1:8787/', '/positions/p_1?tab=open#top'),
      'http://127.0.0.1:8787/positions/p_1?tab=open#top',
    );
    assert.equal(parity.screensFrom({ screens: [{ ...ok, source: '/a b?q=1' }] }).length, 1);
  });

  it('takes credentials only from the environment, never from flags', () => {
    assert.throws(
      () => parity.credentialsFrom({ 'target-login': 'u' }, {}),
      /environment variable/,
    );
    assert.throws(() => parity.credentialsFrom({}, { PORT_UI_TARGET_LOGIN: ' ' }), /set but empty/);
    assert.deepEqual(
      parity.credentialsFrom(
        {},
        { PORT_UI_TARGET_LOGIN: 'http://l/auth/verify?t=1', PORT_UI_SOURCE_COOKIE: 'a=b' },
      ),
      { targetLogin: 'http://l/auth/verify?t=1', targetCookie: undefined, sourceCookie: 'a=b' },
    );
  });

  it('no doc or message tells anyone to pass a credential as a flag', () => {
    // The runner refuses these flags; a doc that still teaches them puts the cookie in shell
    // history and `ps` before the refusal fires (the exposure efe13e9 closed).
    const docs = [
      join(SKILL, 'SKILL.md'),
      join(SKILL, 'parity.mjs'),
      join(SKILL, 'references', 'design.schema.md'),
      join(REPO, '.claude', 'agents', 'ui-parity-reviewer.md'),
      join(REPO, 'docs', 'DESIGN-PORT.md'),
    ];
    for (const file of docs) {
      const hits = readFileSync(file, 'utf8').match(
        /--(target-login|target-cookie|source-cookie)\b/g,
      );
      assert.deepEqual(hits, null, file);
    }
    const schema = readFileSync(join(SKILL, 'references', 'design.schema.md'), 'utf8');
    assert.match(schema, /PORT_UI_TARGET_COOKIE/);
    assert.doesNotMatch(schema, /command line only|never an error/);
  });

  it('refuses an output directory inside the working directory', () => {
    assert.throws(() => parity.outputDir('/repo/out', '/repo'), /outside the repo/);
    assert.throws(() => parity.outputDir('/repo', '/repo'), /outside the repo/);
    assert.equal(parity.outputDir('/tmp/parity-x', '/repo'), '/tmp/parity-x');
  });

  it('keeps output out of the whole repo: a ..-named child, a subdirectory cwd, a symlink', () => {
    // A child directory whose name starts with '..' is inside, not a parent.
    assert.throws(() => parity.outputDir('/repo/..parity', '/repo'), /outside the repo/);
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'port-ui-out-')));
    try {
      const repo = join(tmp, 'mono');
      const app = join(repo, 'apps', 'hiring');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(app, { recursive: true });
      // Run from a nested app (where the default --design resolves): ../../shots is still the repo.
      assert.throws(() => parity.outputDir('../../shots', app), /outside the repo/);
      assert.throws(() => parity.outputDir(join(repo, 'shots'), app), /outside the repo/);
      // The same repo reached through a symlink (macOS /tmp vs /private/tmp) is still the repo.
      const link = join(tmp, 'link');
      symlinkSync(repo, link);
      assert.throws(
        () => parity.outputDir(join(repo, 'x'), join(link, 'apps')),
        /outside the repo/,
      );
      assert.throws(() => parity.outputDir(join(link, 'x'), repo), /outside the repo/);
      // Next to the repo is fine.
      assert.equal(parity.outputDir(join(tmp, 'shots'), app), join(tmp, 'shots'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('creates its output private: an unpredictable 0700 default dir, 0600 files', () => {
    const mode = (p) => statSync(p).mode & 0o777;
    const made = parity.prepareOutput(undefined, REPO);
    try {
      // mkdtemp: a fresh name another user cannot pre-create or predict (shared /tmp on Linux).
      assert.match(made, /port-ui-parity-[\w]{6}$/);
      assert.equal(dirname(made), realpathSync(tmpdir()));
      assert.equal(mode(made), 0o700);
      parity.writePrivate(join(made, 'a.source.png'), 'png');
      assert.equal(mode(join(made, 'a.source.png')), 0o600);
      const explicit = join(made, 'run', 'two');
      assert.equal(parity.prepareOutput(explicit, REPO), explicit);
      assert.equal(mode(explicit), 0o700);
    } finally {
      rmSync(made, { recursive: true, force: true });
    }
  });

  it('removes the session dir (a live cookie) even when the run is interrupted', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const p = await import(${JSON.stringify(join(SKILL, 'parity.mjs'))});
         const { writeFileSync } = await import('node:fs');
         const dir = p.privateSessionDir();
         writeFileSync(dir + '/target-session.json', '{}');
         console.log(dir);
         process.kill(process.pid, 'SIGINT');
         await new Promise((r) => setTimeout(r, 5000));`,
      ],
      { encoding: 'utf8' },
    );
    const dir = child.stdout.trim();
    assert.ok(dir, child.stderr);
    assert.equal(child.status, 130);
    assert.equal(existsSync(dir), false, `${dir} survived SIGINT`);
  });

  it('uses an absolute per-user cache dir, whatever XDG_CACHE_HOME holds', () => {
    const want = join('/home/u', '.cache', 'port-ui-parity', `pw-${parity.PLAYWRIGHT_VERSION}`);
    for (const xdg of [undefined, '', 'relative/cache']) {
      assert.equal(parity.playwrightCacheDir({ XDG_CACHE_HOME: xdg }, '/home/u'), want, xdg);
    }
    assert.equal(
      parity.playwrightCacheDir({ XDG_CACHE_HOME: '/x/cache' }, '/home/u'),
      join('/x/cache', 'port-ui-parity', `pw-${parity.PLAYWRIGHT_VERSION}`),
    );
  });

  it('loads only the pinned Playwright in the cache, never one found further up', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'port-ui-pw-'));
    const fakePlaywright = (at, version) => {
      mkdirSync(join(at, 'node_modules', 'playwright'), { recursive: true });
      writeFileSync(
        join(at, 'node_modules', 'playwright', 'package.json'),
        JSON.stringify({ name: 'playwright', version, main: 'index.js' }),
      );
      writeFileSync(
        join(at, 'node_modules', 'playwright', 'index.js'),
        `module.exports = { version: ${JSON.stringify(version)} };`,
      );
    };
    try {
      const dir = join(tmp, '.cache', 'port-ui-parity', 'pw');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
      // A stray ~/node_modules/playwright (or NODE_PATH) must not stand in for the pinned one.
      fakePlaywright(tmp, '1.2.3');
      assert.throws(() => parity.loadPinnedPlaywright(dir), /not installed/);
      fakePlaywright(dir, '1.0.0');
      assert.throws(() => parity.loadPinnedPlaywright(dir), /1\.0\.0.*want/);
      fakePlaywright(dir, parity.PLAYWRIGHT_VERSION);
      assert.deepEqual(parity.loadPinnedPlaywright(dir), { version: parity.PLAYWRIGHT_VERSION });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('installs Playwright inside the supply-chain rules the lockfile gets', () => {
    // verify:deps reads only package-lock.json and the repo's .npmrc does not apply under
    // --prefix, so the off-lockfile install carries the 24h floor and the no-scripts rule itself.
    const now = Date.parse('2026-10-21T12:00:00Z');
    const args = parity.playwrightInstallArgs('/c/pw', now);
    assert.ok(args.includes('--ignore-scripts'), args.join(' '));
    assert.ok(args.includes('--before=2026-10-20T12:00:00.000Z'), args.join(' '));
    assert.ok(args.includes(`playwright@${parity.PLAYWRIGHT_VERSION}`), args.join(' '));
    assert.match(parity.PLAYWRIGHT_VERSION, /^\d+\.\d+\.\d+$/, 'an exact pin, never a range');
    // The children (npm, the Chromium download) never see the session credentials.
    const env = parity.childEnv({
      PATH: '/bin',
      PORT_UI_TARGET_LOGIN: 'x',
      PORT_UI_TARGET_COOKIE: 'y',
      PORT_UI_SOURCE_COOKIE: 'z',
    });
    assert.deepEqual(env, { PATH: '/bin' });
  });

  it("builds cookies Chromium accepts for the kit's __Host- session on http://localhost", () => {
    // Playwright's `url` form derives `secure` from the scheme, so an http:// target made the kit's
    // __Host-app_session non-Secure and Chromium refused the whole addCookies call.
    assert.deepEqual(
      parity.cookieList('__Host-app_session=abc; theme=dark', 'http://localhost:8790/'),
      [
        { name: '__Host-app_session', value: 'abc', domain: 'localhost', path: '/', secure: true },
        { name: 'theme', value: 'dark', domain: 'localhost', path: '/', secure: false },
      ],
    );
    assert.equal(parity.cookieList('__Secure-x=1', 'http://127.0.0.1:5175')[0].secure, true);
    assert.equal(parity.cookieList('a=1', 'https://staging.example')[0].secure, true);
    assert.deepEqual(parity.cookieList(undefined, 'http://localhost'), []);
    assert.throws(() => parity.cookieList('novalue', 'http://localhost'), /name=value/);
  });

  it('opens the magic link on the local target, whatever host the kit minted it for', () => {
    // The kit mints https://<DASHBOARD_HOST>/auth/verify?token=..., even under wrangler dev.
    const fakeLinkId = 'f'.repeat(64);
    assert.equal(
      parity.targetLoginUrl(
        `https://app.cialdnb.example/auth/verify?token=${fakeLinkId}`,
        'http://localhost:8790',
      ),
      `http://localhost:8790/auth/verify?token=${fakeLinkId}`,
    );
    // Anything that is not a kit verify link is refused, and the value never reaches the message.
    for (const raw of [
      `https://x/login?token=${fakeLinkId}`,
      'https://x/auth/verify',
      'not a url',
    ]) {
      assert.throws(
        () => parity.targetLoginUrl(raw, 'http://localhost:8790'),
        (err) => /PORT_UI_TARGET_LOGIN/.test(err.message) && !err.message.includes(fakeLinkId),
        raw,
      );
    }
  });

  it('gets the local link from the email wrangler dev writes, not the KV outbox', {
    skip: process.platform === 'win32' ? 'the documented command is a POSIX shell one' : false,
  }, () => {
    // `wrangler dev` simulates the kit's send_email binding: env.EMAIL.send() resolves, so the
    // link is "sent" (into .wrangler/tmp/email/*/email-text/<uuid>.txt) and never parked in the
    // magic-link outbox. `wrangler kv key get ... --local` then prints "Value not found" and exits
    // 0, and the runner stopped on "PORT_UI_TARGET_LOGIN is not a URL".
    const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
    const header = readFileSync(join(SKILL, 'parity.mjs'), 'utf8').split('\nimport ')[0];
    for (const [name, text] of [
      ['SKILL.md', skill],
      ['parity.mjs header', header],
    ]) {
      const flat = text.replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ');
      assert.doesNotMatch(flat, /kv key get[^`]*--local/, name);
      assert.match(flat, /\.wrangler\/tmp\/email\/\*\/email-text\/\*\.txt/, name);
    }
    // Run the command SKILL.md gives, in a directory shaped like wrangler dev's output: an older
    // magic-link email and the newest one, and an HTML twin the glob must not pick.
    const block = skill
      .match(/```\n([^`]*\.wrangler\/tmp\/email[^`]*)```/)?.[1]
      .replace(/\\\n\s*/g, '');
    const assign = block?.split('\n').find((l) => l.trim().startsWith('PORT_UI_TARGET_LOGIN='));
    assert.ok(assign, 'SKILL.md Phase 5 gives the local command in a code block');
    const substitution = assign.trim().split(' node ')[0];
    const tmp = mkdtempSync(join(tmpdir(), 'port-ui-mail-'));
    try {
      const mail = join(tmp, '.wrangler', 'tmp', 'email', 'miniflare-0a1b');
      mkdirSync(join(mail, 'email-text'), { recursive: true });
      mkdirSync(join(mail, 'email-html'), { recursive: true });
      const link = (id) => `https://app.cialdnb.example/auth/verify?token=${id.repeat(64)}`;
      const body = (url) =>
        `Log in to Demo\n\nClick to log in (works once, expires in 15 minutes):\n${url}\n\n` +
        "If you didn't request this, you can ignore this email.\n";
      writeFileSync(join(mail, 'email-text', 'old.txt'), body(link('a')));
      utimesSync(join(mail, 'email-text', 'old.txt'), 1_000_000, 1_000_000);
      writeFileSync(join(mail, 'email-text', 'new.txt'), body(link('f')));
      writeFileSync(join(mail, 'email-html', 'new.html'), `<a href="${link('b')}">x</a>`);
      const run = spawnSync('sh', ['-c', `${substitution}; printf %s "$PORT_UI_TARGET_LOGIN"`], {
        cwd: tmp,
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, link('f'));
      assert.equal(
        parity.targetLoginUrl(run.stdout, 'http://127.0.0.1:8787'),
        `http://127.0.0.1:8787/auth/verify?token=${'f'.repeat(64)}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('never echoes a tokened URL in an error', () => {
    const fakeLinkId = 'f'.repeat(64);
    const msg = parity.redactUrls(
      `page.goto: net::ERR_NAME_NOT_RESOLVED at https://h/auth/verify?token=${fakeLinkId}\n` +
        `  - navigating to "http://localhost:1/auth/verify?token=${fakeLinkId}"`,
    );
    assert.doesNotMatch(msg, new RegExp(fakeLinkId));
    assert.match(msg, /ERR_NAME_NOT_RESOLVED/);
  });

  it('classes a capture as failed on no census or an HTTP error, else as comparable', () => {
    const census = { fontFamily: {} };
    assert.equal(parity.captureFailed({ status: 200, census }), false);
    assert.equal(parity.captureFailed({ status: null, census }), false); // same-document navigation
    assert.equal(parity.captureFailed({ status: 200, census: null }), true);
    assert.equal(parity.captureFailed({ status: 404, census }), true);
    assert.equal(parity.captureFailed({ status: 500, census }), true);
  });

  it('counts the target as signed in only on a 2xx from /api/me', () => {
    assert.equal(parity.sessionEstablished(200), true);
    for (const status of [401, 404, 302, 500, null]) {
      assert.equal(parity.sessionEstablished(status), false, String(status));
    }
  });

  it('asks /api/me from a page, as the captures do, so an http://127.0.0.1 session counts', async () => {
    // Playwright 1.63's API client (context.request) sends a Secure cookie over http only to
    // localhost and *.localhost; Chromium pages also send it to http://127.0.0.1 and [::1], where
    // wrangler dev listens on Windows. Asked through context.request, a signed-in 127.0.0.1
    // target failed every run as "the cookie or storage state is stale". The fake below models
    // both clients the way the real ones behaved against a kit stand-in (playwright-core 1.63.0,
    // system Chrome: context.request 401, page.goto 200).
    const sendsSecure = (u, client) =>
      u.protocol === 'https:' ||
      u.hostname === 'localhost' ||
      u.hostname.endsWith('.localhost') ||
      (client === 'page' && (/^127\./.test(u.hostname) || u.hostname === '[::1]'));
    const kit = ({ redirectMe = false } = {}) => ({
      async newContext() {
        const jar = [];
        const answer = (client, u) => {
          const sent = jar.filter(
            (c) => c.domain === u.hostname && (!c.secure || sendsSecure(u, client)),
          );
          if (u.pathname !== '/api/me') return { status: 200 };
          if (redirectMe) return { status: 302, location: '/' };
          const ok = sent.some((c) => c.name === '__Host-app_session' && c.value === 'live');
          return { status: ok ? 200 : 401 };
        };
        return {
          async addCookies(list) {
            jar.push(...list);
          },
          request: {
            async get(url) {
              const { status } = answer('request', new URL(url));
              return { status: () => status };
            },
          },
          async newPage() {
            return {
              async goto(url) {
                let previous = null;
                for (let hop = new URL(url); ; ) {
                  const { status, location } = answer('page', hop);
                  const from = previous;
                  const response = { status: () => status };
                  const request = { redirectedFrom: () => from, response: async () => response };
                  response.request = () => request;
                  if (!location) return response;
                  previous = request;
                  hop = new URL(location, hop);
                }
              },
            };
          },
          async close() {},
        };
      },
    });
    const live = { cookie: '__Host-app_session=live' };
    for (const target of ['http://127.0.0.1:8787', 'http://[::1]:8787', 'http://localhost:8787']) {
      assert.equal(await parity.targetSessionStatus(kit(), target, live), 200, target);
      assert.equal(
        await parity.targetSessionStatus(kit(), target, { cookie: '__Host-app_session=old' }),
        401,
        target,
      );
    }
    // A /api/me that redirects (to a login page answering 200) is not a session.
    const redirected = await parity.targetSessionStatus(
      kit({ redirectMe: true }),
      'http://127.0.0.1:8787',
      live,
    );
    assert.equal(redirected, 302);
    assert.equal(parity.sessionEstablished(redirected), false);
  });

  it("captures with each app's own CSP in force, freezing motion without injecting CSS", () => {
    // bypassCSP let a font or stylesheet the port's CSP blocks render in parity (and logged no
    // "Refused to load" error), so a port broken on staging passed every check.
    const opts = parity.contextOptions({ width: 1, height: 1 }, 'state.json');
    assert.equal('bypassCSP' in opts, false);
    assert.equal(opts.reducedMotion, 'reduce');
    assert.equal(opts.storageState, 'state.json');
    assert.equal('storageState' in parity.contextOptions({ width: 1, height: 1 }), false);
    assert.deepEqual(parity.SCREENSHOT_OPTIONS, {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  });

  it('shoots the source only on synthetic data, on this machine unless allowed', () => {
    // Source screenshots go to a model subagent and a published report: real data must never be
    // in them (CLAUDE.md "Synthetic only").
    const synthetic = { source: { data: 'synthetic' } };
    for (const design of [{}, { source: {} }, { source: { data: 'real' } }]) {
      assert.throws(
        () => parity.checkSource(design, 'http://localhost:5175', false),
        /source\.data.*synthetic/,
      );
    }
    for (const url of [
      'http://localhost:5175',
      'http://127.0.0.1:5175',
      'http://[::1]:5175',
      'http://app.localhost:1',
    ]) {
      assert.doesNotThrow(() => parity.checkSource(synthetic, url, false), url);
    }
    for (const url of [
      'https://hr.example.com',
      'http://10.0.0.5:5175',
      'http://localhost.example.com',
    ]) {
      assert.throws(() => parity.checkSource(synthetic, url, false), /not on this machine/, url);
      assert.doesNotThrow(() => parity.checkSource(synthetic, url, true), url);
    }
    assert.deepEqual(parity.parseArgs(['--allow-remote-source']), { 'allow-remote-source': true });
  });

  it('reports only style values the port renders and the source never does', () => {
    const source = { fontFamily: { '"Open Sans"': 40 }, color: { 'rgb(10, 23, 56)': 30 } };
    const target = {
      fontFamily: { '"Open Sans"': 38, 'system-ui': 5 },
      color: { 'rgb(10, 23, 56)': 29 },
      borderRadius: { '10px': 12 },
    };
    assert.deepEqual(parity.censusDelta(source, target), {
      fontFamily: [{ value: 'system-ui', count: 5 }],
      borderRadius: [{ value: '10px', count: 12 }],
    });
    assert.deepEqual(parity.censusDelta(source, source), {});
  });
});
