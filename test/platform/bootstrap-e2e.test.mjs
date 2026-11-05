// The CIAL new-app bootstrap, run for real on a copy of this tree.
//
// Every other bootstrap test drives one helper on a fixture. None ran the whole rename, and
// `verify:bootstrap` does nothing on the template itself, so a carried file that named the
// template turned the bootstrap red for every new app while the kit's own CI stayed green: on
// 2026-10-27 `node scripts/new-app.mjs <name>` on a clean kit main exited 1, listing 35 residual
// files (one at ec1ecd4, 2026-06-21). The renamed CLAUDE.md also left verify:agents red, because
// its sync stamp still recorded the template's bytes.
//
// So this copies the tree git would commit (no .git, no node_modules), runs the bootstrap the way
// a builder does, then two of the gates a new app's CI runs on that result (`verify:bootstrap`,
// which is `--verify-only`, and `verify:agents`), and pins what the bootstrap may change: the
// rename list, the resource manifest, the agent-guidance stamp and the plugin strip, and nothing
// else. A rerun must change nothing, because the plugin path runs the bootstrap twice.
//
// A third case runs the tests /kit-upgrade carries for the bootstrap and the deployment target in
// that copy: once as generated, and once as a fork that kept what the upgrade does not carry (a
// package.json from before the reader, a trimmed workflow set). Those tests ride into every fork,
// so they must pass there on the fork's own files.
//
// The second describe runs the opt-in DB Israel target the same way: generation, every rerun and
// target-change row of the bootstrap's tree-state table, the refusals, the plugin path, a
// /kit-upgrade overlay and --verify-only, and that the CIAL default stays what it was, whichever way
// it is asked for: byte for byte the plain rename, computed here from the template's own files
// with the rename helpers, not only equal to another run of the same script. It makes four
// full-tree copies (the DB Israel generation, the plugin path, the CIAL-to-DB Israel switch, and
// one CIAL copy that the CIAL variants, every refusal and the git-history switch case reuse,
// restored between cases and checked by tree hash), and the git-history case clones that copy
// once more, shallow.
//
// The third describe runs a new app's own node gates in a copy generated for each target:
// `test:scripts` (the whole node suite), `test:hooks` and `verify:kit-migrations`, through the
// copy's own package.json, before and after the app's first own migration. Until 2026-10-28 a new
// app's `test:scripts` was red there, in test/platform/kit-migrations.test.mjs, while the kit's CI
// stayed green. It makes two more full-tree copies, run at the same time.
//
// Kit only: it copies the template, so it skips itself in a renamed app, where the rename has
// already run. Nothing here writes the template's name as a literal; a renamed app keeps this file,
// and its residual scan would flag one. Run by `node --test` (test:scripts).
import { strict as assert } from 'node:assert';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { proposalProblems } from '../../scripts/central-proposal.mjs';
import { nextOrdinal, sqlFiles } from '../../scripts/check-kit-migrations.mjs';
import {
  ACCEPTED_CALLER_SHA256,
  CALLER_PATH,
  CALLER_TEXT,
  CENTRAL_DELIVERY_DOC,
  callerSha256,
  LEGACY_CALLER_PATH,
  MARKER_PATH,
} from '../../scripts/deployment-target.mjs';
import {
  dropPluginVerifyScript,
  FILES,
  isTemplateRepo,
  parseJsonc,
  placeholderManifest,
  renameTemplateRefs,
  resetStagingResourceIds,
  stripReadmePluginBlock,
  TEMPLATE_KEBAB,
} from '../../scripts/new-app.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const NAME = 'e2e-probe';
// The display the bootstrap derives from NAME when --display is not given (each word's first
// character upper-cased, so the "2" keeps the "e" after it lower case).
const DISPLAY = 'E2e Probe';
// Files the series must never generate for a CIAL app (the DB Israel marker and caller).
const MARKER = `.${TEMPLATE_KEBAB}/deployment.json`;
const CALLER = `.github/workflows/il-${TEMPLATE_KEBAB}-release.yml`;
// What the bootstrap may change besides the rename list: the stamped resource manifest, the
// re-stamped agent-guidance manifest, and the README whose plugin-install block it strips.
const AGENT_GUIDANCE_MANIFEST = 'docs/agent-guidance.sync.json';
const ALSO_CHANGED = ['docs/RESOURCES.md', AGENT_GUIDANCE_MANIFEST, 'README.md'];
// What it must change on this tree.
const MUST_CHANGE = [
  'CLAUDE.md',
  'docs/RESOURCES.md',
  'docs/agent-guidance.sync.json',
  'package.json',
  'wrangler.jsonc',
  'wrangler.staging.jsonc',
];
const PLUGIN_PACKAGING = /^(?:plugins|\.claude-plugin)\//;

// The children never see this checkout's git: a leaked GIT_DIR once pointed a test's git calls at
// the shared clone. CI=1 skips the bootstrap's network step (tagging the GitHub repo).
const childEnv = Object.fromEntries(
  Object.entries({ ...process.env, CI: '1' }).filter(([key]) => !key.startsWith('GIT_')),
);

/** The tree git would commit: tracked files plus untracked ones that are not ignored. */
function committableFiles(from = ROOT) {
  const out = execFileSync(
    'git',
    ['-C', from, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', env: childEnv, maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

function copyTree(dest, { exclude = null, from = ROOT } = {}) {
  for (const rel of committableFiles(from)) {
    if (exclude?.test(rel)) continue;
    let st;
    try {
      st = lstatSync(join(from, rel));
    } catch {
      continue; // deleted in the working tree, not yet committed
    }
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(join(from, rel)), join(dest, rel));
    else if (st.isFile()) copyFileSync(join(from, rel), join(dest, rel));
  }
}

/** path → content digest (a symlink by its target), for every file under `dir`. */
function snapshot(dir) {
  const out = new Map();
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isSymbolicLink()) out.set(child, `link:${readlinkSync(join(dir, child))}`);
      else
        out.set(
          child,
          createHash('sha256')
            .update(readFileSync(join(dir, child)))
            .digest('hex'),
        );
    }
  };
  walk('');
  return out;
}

function compare(before, after) {
  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  const changed = [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p));
  return { added, removed, changed };
}

const run = (cwd, script, args = []) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: childEnv });

const transcript = (r) => `exit ${r.status}\n${r.stdout}\n${r.stderr}`;

/**
 * The bytes the CIAL bootstrap must give `rel`, computed from the template's own file with the
 * rename helpers alone: the rename, the staging-id reset, the plugin strip. Nothing of the DB
 * Israel branch may reach a CIAL app, so its output is pinned here and not only against another
 * run of the same script.
 */
function expectedCialFile(rel, display) {
  const original = readFileSync(join(ROOT, rel), 'utf8');
  if (rel === 'README.md') return stripReadmePluginBlock(original);
  let text = renameTemplateRefs(original, NAME, display);
  if (rel === 'wrangler.staging.jsonc') text = resetStagingResourceIds(text).text;
  if (rel === 'package.json') text = dropPluginVerifyScript(text);
  return text;
}

/** Requires the CIAL app in `dir` to be the plain rename of the template, byte for byte. */
function assertPlainCialRename(dir, display) {
  // First the CIAL values the DB Israel branch replaces, by name, so a failure says which moved.
  for (const file of ['wrangler.jsonc', 'wrangler.staging.jsonc']) {
    const expected = parseJsonc(expectedCialFile(file, display));
    const app = parseJsonc(readFileSync(join(dir, file), 'utf8'));
    assert.ok(expected.routes?.length > 0, `the template's ${file} has routes`);
    for (const key of ['account_id', 'routes', 'secrets_store_secrets']) {
      assert.deepEqual(app[key], expected[key], `${file}: ${key}`);
    }
    for (const key of [
      'CF_ACCOUNT_ID',
      'AI_GATEWAY_ID',
      'MAIL_FROM',
      'ALERT_EMAIL',
      'DASHBOARD_HOST',
    ]) {
      assert.equal(app.vars[key], expected.vars[key], `${file}: vars.${key}`);
    }
  }
  for (const rel of [...FILES, 'README.md']) {
    assert.ok(
      readFileSync(join(dir, rel), 'utf8') === expectedCialFile(rel, display),
      `${rel} is not the plain CIAL rename of the template`,
    );
  }
  assert.equal(readFileSync(join(dir, 'docs/RESOURCES.md'), 'utf8'), placeholderManifest(NAME));
}

describe('the CIAL new-app bootstrap, end to end', {
  skip: !isTemplateRepo(ROOT) && 'kit only: this repo is already renamed',
  timeout: 120_000,
}, () => {
  it('renames a copy of the template, passes --verify-only and verify:agents on it, and changes nothing outside its list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-e2e-'));
    try {
      copyTree(dir);
      const before = snapshot(dir);

      const bootstrap = run(dir, 'scripts/new-app.mjs', [NAME]);
      assert.equal(bootstrap.status, 0, transcript(bootstrap));
      // The CIAL next steps, as today: provision through Actions, then the CIAL staging host.
      assert.match(bootstrap.stdout, /CLOUDFLARE_API_TOKEN \+ variable DEPLOY_ENABLED=true/);
      assert.match(bootstrap.stdout, /Run "Provision staging"/);
      assert.ok(
        bootstrap.stdout.includes(`https://staging-${NAME}.cialdnb.ai/_health`),
        transcript(bootstrap),
      );
      // The CIAL app is the plain rename, computed here from the template: the CIAL account,
      // routes, store and hosts as they were (ILOPS-8888: the CIAL default stays unchanged).
      assertPlainCialRename(dir, DISPLAY);

      // Two of the gates a new app's CI runs on the result: verify:bootstrap and verify:agents.
      const verify = run(dir, 'scripts/new-app.mjs', ['--verify-only']);
      assert.equal(verify.status, 0, transcript(verify));
      assert.match(verify.stdout, /Bootstrap verified/);
      const agents = run(dir, 'scripts/check-agent-guidance-sync.mjs');
      assert.equal(agents.status, 0, transcript(agents));

      const after = snapshot(dir);
      const { added, removed, changed } = compare(before, after);
      assert.deepEqual(added, [], 'the CIAL bootstrap adds no file');
      assert.equal(after.has(MARKER), false);
      assert.equal(after.has(CALLER), false);
      assert.deepEqual(
        removed.filter((p) => !PLUGIN_PACKAGING.test(p)),
        [],
        'it removes only the plugin packaging',
      );
      assert.ok(removed.length > 0, 'the plugin packaging is stripped');
      const allowed = new Set([...FILES, ...ALSO_CHANGED]);
      assert.deepEqual(
        changed.filter((p) => !allowed.has(p)),
        [],
        'it changes only the rename list and the manifests it stamps',
      );
      for (const p of MUST_CHANGE) assert.ok(changed.includes(p), `${p} is renamed or stamped`);

      // The plugin path runs the bootstrap a second time on the renamed tree.
      const rerun = run(dir, 'scripts/new-app.mjs', [NAME]);
      assert.equal(rerun.status, 0, transcript(rerun));
      assert.deepEqual(compare(after, snapshot(dir)), { added: [], removed: [], changed: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // /kit-upgrade carries these into every fork (bootstrap.test.ts too, which runs under Vitest and
  // reads no file of the app's). package.json and the workflows the fork chose to keep are not
  // carried, so the tests run on the fork's own: as generated, the laptop-script wiring is strict;
  // in a fork whose package.json predates the reader (copying the guarded scripts in is
  // recommended, not required, for a CIAL app) it skips with that CHANGELOG step as the reason;
  // and a workflow the fork does not have holds nothing to check (2026-10-27 review F1, F6).
  it('the carried bootstrap and deployment-target tests pass in the new app and in a fork that kept an older package.json and fewer workflows', () => {
    const CARRIED_TESTS = [
      'test/platform/deployment-target.test.mjs',
      'test/platform/new-app.test.mjs',
      'test/platform/template-purity.test.mjs',
      'test/platform/workflow-enrollment-safety.test.mjs',
      'test/platform/central-proposal.test.mjs',
      'test/platform/runtime-config.test.mjs',
    ];
    const LAPTOP = /^ok \d+ - wiring: the laptop deploy and D1 scripts(?: # SKIP (.*))?$/m;
    // The nested runner must not report to this one.
    const testEnv = Object.fromEntries(
      Object.entries(childEnv).filter(([key]) => key !== 'NODE_TEST_CONTEXT'),
    );
    const carried = (cwd) =>
      spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...CARRIED_TESTS], {
        cwd,
        encoding: 'utf8',
        env: testEnv,
      });
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-e2e-carried-'));
    try {
      copyTree(dir);
      const bootstrap = run(dir, 'scripts/new-app.mjs', [NAME]);
      assert.equal(bootstrap.status, 0, transcript(bootstrap));

      const fresh = carried(dir);
      assert.equal(fresh.status, 0, transcript(fresh));
      assert.equal(LAPTOP.exec(fresh.stdout)?.[1], undefined, 'strict in a new app');

      // A fork from before the reader: its package.json has neither the deployment-target script
      // nor the guarded prefix, and it never took edge-live.yml.
      const pkgPath = join(dir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const prefix = 'node scripts/deployment-target.mjs --require cial && ';
      for (const [name, script] of Object.entries(pkg.scripts)) {
        if (script.startsWith(prefix)) pkg.scripts[name] = script.slice(prefix.length);
      }
      delete pkg.scripts['deployment-target'];
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      unlinkSync(join(dir, '.github', 'workflows', 'edge-live.yml'));

      const older = carried(dir);
      assert.equal(older.status, 0, transcript(older));
      assert.match(
        LAPTOP.exec(older.stdout)?.[1] ?? '',
        /deployment-target reader entry, manual step 2/,
        'the laptop-script wiring skips, naming the CHANGELOG step',
      );
      assert.match(older.stdout, /# SKIP edge-live\.yml is not in this app/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The bootstrap re-stamps the agent-guidance manifest only when its stamp matched CLAUDE.md
  // before the rename. Re-stamping always would turn a kit CLAUDE.md edit that nobody reconciled
  // (no `verify:agents -- --write`) green in every new app, and its mirrors would never be
  // reconsidered. The unit tests drive the helper with an explicit flag; this pins the wiring.
  it('leaves an agent-guidance stamp that was stale before the rename, so verify:agents still fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-e2e-stale-'));
    try {
      copyTree(dir);
      appendFileSync(join(dir, 'CLAUDE.md'), '\nAn edit nobody reconciled with the mirrors.\n');
      const stamp = readFileSync(join(dir, AGENT_GUIDANCE_MANIFEST));

      const bootstrap = run(dir, 'scripts/new-app.mjs', [NAME]);
      assert.equal(bootstrap.status, 0, transcript(bootstrap));
      assert.match(bootstrap.stderr, /was already out of date before the rename/);
      assert.doesNotMatch(bootstrap.stdout, /re-stamped:/);
      assert.deepEqual(readFileSync(join(dir, AGENT_GUIDANCE_MANIFEST)), stamp);

      const agents = run(dir, 'scripts/check-agent-guidance-sync.mjs');
      assert.equal(agents.status, 1, transcript(agents));
      assert.match(agents.stderr, /CLAUDE\.md changed since/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The DB Israel target ─────────────────────────────────────────────────────────────────────
//
// The bootstrap asks no question itself: the target is CIAL unless `--target dbisrael` says
// otherwise, and the tree state decides what a rerun may do (scripts/new-app.mjs, planBootstrap).
// These cases follow that table row by row on real copies of the template.

const ISRAEL = [NAME, '--target', 'dbisrael'];
// What the bootstrap writes, in Biome's format.
const ISRAEL_MARKER = '{ "version": 1, "deploymentTarget": "dbisrael" }\n';
const CIAL_MARKER = '{ "version": 1, "deploymentTarget": "cial" }\n';
const STAGING_HOST = `${NAME}.staging.dbisrael.ai`;
const SENTINEL = '0'.repeat(32);
// The caller's workflow name, built from parts: a renamed app keeps this file.
const CALLER_NAME = `il-${TEMPLATE_KEBAB}-release`;
// Files the DB Israel bootstrap adds, and the platform-maintainer folder it removes.
const ISRAEL_ADDED = [CALLER_PATH, MARKER_PATH, CENTRAL_DELIVERY_DOC].sort();
const TOOLS = /^tools\//;
// A CIAL hostname or mail domain in a value (the caller's `CialDNB/` organization is not one).
const CIAL_HOST = /(?:[a-z0-9-]+\.)*cialdnb\.(?:ai|com)/g;
const isCialHost = (value) => new RegExp(CIAL_HOST.source).test(value);

/** The CIAL provider ids the template's own configs carry: the account, store and AI gateway. */
function cialIds() {
  const ids = new Set();
  for (const file of ['wrangler.jsonc', 'wrangler.staging.jsonc']) {
    const cfg = parseJsonc(readFileSync(join(ROOT, file), 'utf8'));
    ids.add(cfg.account_id);
    ids.add(cfg.vars.CF_ACCOUNT_ID);
    ids.add(cfg.vars.AI_GATEWAY_ID);
    for (const s of cfg.secrets_store_secrets ?? []) ids.add(s.store_id);
  }
  ids.delete(undefined);
  ids.delete('');
  return [...ids];
}

/** Every string among the parsed values of `value`. */
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** One digest for a whole snapshot: equal trees, equal hash. */
const treeHash = (snap) =>
  createHash('sha256')
    .update(JSON.stringify([...snap].sort()))
    .digest('hex');

/** Every file under `dir` as bytes (a symlink by its target), and every directory. */
function capture(dir) {
  const files = new Map();
  const dirs = new Set();
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.add(child);
        walk(child);
      } else if (entry.isSymbolicLink()) files.set(child, readlinkSync(join(dir, child)));
      else files.set(child, readFileSync(join(dir, child)));
    }
  };
  walk('');
  return { files, dirs };
}

/** Puts `dir` back as `saved` captured it: what was added goes, what changed or went comes back. */
function restore(dir, saved) {
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (saved.dirs.has(child)) walk(child);
        else rmSync(join(dir, child), { recursive: true, force: true });
      } else if (!saved.files.has(child)) rmSync(join(dir, child), { force: true });
    }
  };
  walk('');
  for (const [rel, content] of saved.files) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    let st = null;
    try {
      st = lstatSync(abs);
    } catch {
      // gone: written below
    }
    if (typeof content === 'string') {
      if (st?.isSymbolicLink() && readlinkSync(abs) === content) continue;
      rmSync(abs, { recursive: true, force: true });
      symlinkSync(content, abs);
    } else {
      if (st?.isFile() && readFileSync(abs).equals(content)) continue;
      rmSync(abs, { recursive: true, force: true });
      writeFileSync(abs, content);
    }
  }
}

const put = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

// Every kind of invalid marker the reader refuses (deployment-target.test.mjs pins each variant).
const INVALID_MARKERS = [
  [
    'a symlink',
    (dir) => {
      writeFileSync(join(dir, 'real.json'), ISRAEL_MARKER);
      mkdirSync(dirname(join(dir, MARKER_PATH)), { recursive: true });
      symlinkSync(join(dir, 'real.json'), join(dir, MARKER_PATH));
    },
  ],
  ['a directory', (dir) => mkdirSync(join(dir, MARKER_PATH), { recursive: true })],
  ['over 1 KB', (dir) => put(dir, MARKER_PATH, ISRAEL_MARKER.padEnd(1025, ' '))],
  ['unparseable JSON', (dir) => put(dir, MARKER_PATH, '{ "version": 1, ')],
  [
    'an extra key',
    (dir) => put(dir, MARKER_PATH, '{ "version": 1, "deploymentTarget": "dbisrael", "x": 1 }\n'),
  ],
  [
    'a repeated key',
    (dir) =>
      put(
        dir,
        MARKER_PATH,
        '{ "version": 1, "deploymentTarget": "cial", "deploymentTarget": "dbisrael" }\n',
      ),
  ],
  [
    'an unknown version',
    (dir) => put(dir, MARKER_PATH, '{ "version": 2, "deploymentTarget": "dbisrael" }\n'),
  ],
  [
    'an unknown target',
    (dir) => put(dir, MARKER_PATH, '{ "version": 1, "deploymentTarget": "dual" }\n'),
  ],
];

// Each sign of a DB Israel app that makes a missing marker an error.
const SIGNS = [
  ['the release caller', (dir) => put(dir, CALLER_PATH, CALLER_TEXT)],
  ['the legacy release caller', (dir) => put(dir, LEGACY_CALLER_PATH, 'name: legacy\n')],
  [
    'a dbisrael.ai value in wrangler.staging.jsonc',
    (dir) => {
      const path = join(dir, 'wrangler.staging.jsonc');
      const text = readFileSync(path, 'utf8');
      const next = text.replace(/("DASHBOARD_HOST":\s*)"[^"]*"/, `$1"${STAGING_HOST}"`);
      assert.notEqual(next, text, 'the staging config sets DASHBOARD_HOST');
      writeFileSync(path, next);
    },
  ],
  [CENTRAL_DELIVERY_DOC, (dir) => put(dir, CENTRAL_DELIVERY_DOC, '# Central delivery\n')],
];

/** Runs the bootstrap in `dir` and requires it to refuse with exit 1, changing nothing. */
function refuses(dir, args, says) {
  const before = treeHash(snapshot(dir));
  const r = run(dir, 'scripts/new-app.mjs', args);
  assert.equal(r.status, 1, `${args.join(' ')}: ${transcript(r)}`);
  if (says) assert.match(r.stderr, says, `${args.join(' ')}: ${transcript(r)}`);
  assert.equal(treeHash(snapshot(dir)), before, `${args.join(' ')} changed the tree`);
  return r;
}

describe('the DB Israel target in the new-app bootstrap, end to end', {
  skip: !isTemplateRepo(ROOT) && 'kit only: this repo is already renamed',
  timeout: 300_000,
}, () => {
  const temps = [];
  const tempTree = (prefix, options) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    copyTree(dir, options);
    return dir;
  };
  // The fresh DB Israel generation every other path must reproduce.
  let israelDir;
  let israel;
  let israelOut;
  let israelPristine;
  let generated;
  before(() => {
    israelDir = tempTree('bootstrap-e2e-israel-');
    israelPristine = snapshot(israelDir);
    const r = run(israelDir, 'scripts/new-app.mjs', ISRAEL);
    assert.equal(r.status, 0, transcript(r));
    israelOut = r;
    israel = snapshot(israelDir);
    generated = capture(israelDir);
  });
  after(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('generates a DB Israel app: marker, caller, central config values, no tools/, stamped docs and the handoff', () => {
    const { added, removed, changed } = compare(israelPristine, israel);
    assert.deepEqual(added.sort(), ISRAEL_ADDED, 'it adds the marker, the caller and the doc');
    assert.deepEqual(
      removed.filter((p) => !PLUGIN_PACKAGING.test(p) && !TOOLS.test(p)),
      [],
      'it removes only the plugin packaging and tools/',
    );
    assert.ok(
      removed.some((p) => TOOLS.test(p)),
      'tools/ is removed',
    );
    assert.equal(existsSync(join(israelDir, 'tools')), false);
    const allowed = new Set([...FILES, ...ALSO_CHANGED]);
    assert.deepEqual(
      changed.filter((p) => !allowed.has(p)),
      [],
    );
    for (const p of MUST_CHANGE) assert.ok(changed.includes(p), `${p} is renamed or stamped`);

    // The marker, byte for byte, as Biome formats it.
    const markerText = readFileSync(join(israelDir, MARKER_PATH), 'utf8');
    assert.equal(markerText, ISRAEL_MARKER);
    const biome = join(ROOT, 'node_modules', '.bin', 'biome');
    if (existsSync(biome)) {
      const formatted = spawnSync(biome, ['format', `--stdin-file-path=${MARKER_PATH}`], {
        input: markerText,
        encoding: 'utf8',
        env: childEnv,
      });
      assert.equal(formatted.status, 0, formatted.stderr);
      assert.equal(formatted.stdout, markerText, 'Biome leaves the marker as it is');
    }
    // The caller central accepts, byte for byte.
    const caller = readFileSync(join(israelDir, CALLER_PATH), 'utf8');
    assert.equal(caller, CALLER_TEXT);
    assert.ok(ACCEPTED_CALLER_SHA256.includes(callerSha256(caller)));

    // Both wrangler configs, set by key: the sentinel account and store ids, no routes, the
    // staging host, no CIAL gateway, sender or alert address, and the header that says central
    // delivery ignores them.
    const ids = cialIds();
    assert.ok(ids.length >= 3, 'the template carries the CIAL account, store and gateway ids');
    for (const [file, host] of [
      ['wrangler.jsonc', ''],
      ['wrangler.staging.jsonc', STAGING_HOST],
    ]) {
      const text = readFileSync(join(israelDir, file), 'utf8');
      const cfg = parseJsonc(text);
      assert.ok(cfg, `${file} still parses`);
      assert.equal(cfg.account_id, SENTINEL, file);
      for (const s of cfg.secrets_store_secrets) assert.equal(s.store_id, SENTINEL, file);
      assert.equal('routes' in cfg, false, `${file} has no routes`);
      assert.equal(cfg.vars.DASHBOARD_HOST, host, file);
      assert.equal(cfg.vars.CF_ACCOUNT_ID, '', file);
      assert.equal(cfg.vars.AI_GATEWAY_ID, '', file);
      assert.equal(cfg.vars.MAIL_FROM, 'auth@invalid.example', file);
      assert.equal(cfg.vars.ALERT_EMAIL, '', file);
      assert.equal(cfg.vars.APP_NAME, NAME, file);
      for (const id of ids) assert.equal(text.includes(id), false, `${file} still holds ${id}`);
      assert.deepEqual(strings(cfg).filter(isCialHost), [], file);
      assert.match(
        text,
        /^\/\/ Local development and tests only\. DB Israel central delivery ignores this file; bindings, vars,\n\/\/ crons and hostnames come from the central catalog/,
        file,
      );
      assert.equal(text.includes(TEMPLATE_KEBAB), false, file);
    }

    // What stays CIAL in the workflows (the guarded CIAL paths, never rewritten) is exactly the
    // list in docs/DECISIONS.md 2026-10-27, "new-app DB Israel target".
    const gateway = parseJsonc(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')).vars
      .AI_GATEWAY_ID;
    const left = new Set();
    const workflows = join(israelDir, '.github', 'workflows');
    for (const name of readdirSync(workflows)) {
      const text = readFileSync(join(workflows, name), 'utf8');
      for (const m of text.matchAll(CIAL_HOST)) left.add(`${name}: ${m[0]}`);
      for (const id of ids) if (text.includes(id)) left.add(`${name}: ${id}`);
    }
    assert.deepEqual([...left].sort(), [
      `ci.yml: staging-${NAME}.cialdnb.ai`,
      `deploy-prod.yml: ${NAME}.cialdnb.ai`,
      `provision-production.yml: ${gateway}`,
      `provision-staging.yml: ${gateway}`,
    ]);

    // The generated files hold no CIAL provider id or hostname.
    for (const rel of [MARKER_PATH, CALLER_PATH, CENTRAL_DELIVERY_DOC, 'docs/RESOURCES.md']) {
      const text = readFileSync(join(israelDir, rel), 'utf8');
      assert.deepEqual(text.match(CIAL_HOST), null, rel);
      for (const id of ids) assert.equal(text.includes(id), false, `${rel} holds ${id}`);
    }
    const resources = readFileSync(join(israelDir, 'docs/RESOURCES.md'), 'utf8');
    assert.match(resources, new RegExp(`^# Resources — ${NAME}\\n`));
    assert.match(resources, /central catalog/);
    assert.doesNotMatch(resources, /Provision staging/);
    const doc = readFileSync(join(israelDir, CENTRAL_DELIVERY_DOC), 'utf8');
    assert.match(doc, /not enrolled or deployed until the platform enrolls it/);
    assert.ok(doc.includes(`https://${STAGING_HOST}`));
    for (const word of ['seed-owner', 'Promote to production', CALLER_NAME]) {
      assert.ok(doc.includes(word), `the doc names ${word}`);
    }

    // The DB Israel handoff, the identity block and the proposal, and none of the CIAL steps.
    const out = israelOut.stdout;
    for (const word of [
      `https://${STAGING_HOST}`,
      `${CALLER_NAME}`,
      'expected to be red',
      'seed-owner',
      'Promote to production',
      'npm run central:proposal',
      "Don't create",
      'catalog app name',
      '"schema": "ilpr.app/v1"',
    ]) {
      assert.ok(out.includes(word), `the handoff says ${word}\n${transcript(israelOut)}`);
    }
    assert.doesNotMatch(out, /DEPLOY_ENABLED=true|gh workflow run provision|cialdnb\.ai/);
    // The npm scripts the handoff, docs/CENTRAL-DELIVERY.md and /new-app send the owner to.
    const scripts = JSON.parse(readFileSync(join(israelDir, 'package.json'), 'utf8')).scripts;
    assert.equal(scripts['central:proposal'], 'node scripts/central-proposal.mjs');
    assert.equal(scripts['deployment-target'], 'node scripts/deployment-target.mjs');

    // The new app's own gates on it: --verify-only, the agent-guidance check and the reader. Its
    // whole node suite, which includes the kit tests that read its wrangler configs (the DB Israel
    // values change them), runs in the third describe, on a generation of its own.
    const verify = run(israelDir, 'scripts/new-app.mjs', ['--verify-only']);
    assert.equal(verify.status, 0, transcript(verify));
    assert.match(verify.stdout, /Bootstrap verified/);
    const agents = run(israelDir, 'scripts/check-agent-guidance-sync.mjs');
    assert.equal(agents.status, 0, transcript(agents));
    const reader = run(israelDir, 'scripts/deployment-target.mjs');
    assert.equal(reader.stdout, 'dbisrael\n', transcript(reader));
    assert.equal(treeHash(snapshot(israelDir)), treeHash(israel), 'the gates wrote nothing');
  });

  it('npm run central:proposal prints the same draft the bootstrap printed, deterministically, and writes nothing', () => {
    const one = run(israelDir, 'scripts/central-proposal.mjs');
    const two = run(israelDir, 'scripts/central-proposal.mjs');
    assert.equal(one.status, 0, transcript(one));
    assert.equal(one.stdout, two.stdout);
    assert.ok(israelOut.stdout.includes(one.stdout), 'the bootstrap printed the same draft');
    const json = one.stdout.slice(one.stdout.indexOf('{'), one.stdout.indexOf('\n}\n') + 2);
    const draft = JSON.parse(json);
    assert.equal(draft.app, NAME);
    assert.deepEqual(draft.stages.staging.hostnames, [STAGING_HOST]);
    assert.equal(draft.stages.staging.vars.APP_NAME, NAME);
    assert.equal(draft.stages.staging.vars.DASHBOARD_HOST, STAGING_HOST);
    assert.deepEqual(draft.runtime_secrets, []);
    assert.equal(json.match(CIAL_HOST), null);
    for (const id of cialIds()) assert.equal(json.includes(id), false, id);
    // The draft read from the app's real staging config passes the kit's mirror of central's
    // catalog rules once its repository id is filled in. (The bootstrap's own run always reports
    // the missing id, so another problem would not stand out there.)
    assert.deepEqual(
      proposalProblems({ ...draft, repository: { ...draft.repository, id: 1 } }),
      [],
    );
    // Every variable it proposes is one the kit's vocabulary knows.
    assert.doesNotMatch(one.stdout, /Not in the kit's runtime vocabulary/);
    assert.equal(treeHash(snapshot(israelDir)), treeHash(israel), 'the proposal wrote nothing');
  });

  it('a rerun keeps the target and is idempotent; a target change or another name is refused', () => {
    try {
      for (const args of [[NAME], ISRAEL, [NAME, '--target=dbisrael']]) {
        const r = run(israelDir, 'scripts/new-app.mjs', args);
        assert.equal(r.status, 0, `${args.join(' ')}: ${transcript(r)}`);
        assert.deepEqual(compare(israel, snapshot(israelDir)), {
          added: [],
          removed: [],
          changed: [],
        });
      }
      refuses(israelDir, [NAME, '--target', 'cial'], /reviewed migration/);
      refuses(israelDir, ['other-name', '--target', 'dbisrael'], /other-name/);
      refuses(israelDir, ['other-name'], /other-name/);
    } finally {
      restore(israelDir, generated);
    }
  });

  it('a rerun restores a missing or edited caller, keeps a CRLF one, and --verify-only says which caller is wrong', () => {
    const verify = () => run(israelDir, 'scripts/new-app.mjs', ['--verify-only']);
    const callerAt = join(israelDir, CALLER_PATH);
    try {
      for (const [what, damage] of [
        ['a missing caller', () => unlinkSync(callerAt)],
        ['a caller with one byte more', () => appendFileSync(callerAt, ' ')],
        [
          'a caller with one byte changed',
          () => writeFileSync(callerAt, `%${CALLER_TEXT.slice(1)}`),
        ],
      ]) {
        damage();
        const v = verify();
        assert.equal(v.status, 1, `${what}: ${transcript(v)}`);
        assert.ok(v.stderr.includes(CALLER_PATH), `${what}: ${transcript(v)}`);
        const r = run(israelDir, 'scripts/new-app.mjs', [NAME]);
        assert.equal(r.status, 0, `${what}: ${transcript(r)}`);
        assert.deepEqual(
          compare(israel, snapshot(israelDir)),
          { added: [], removed: [], changed: [] },
          what,
        );
        assert.equal(readFileSync(callerAt, 'utf8'), CALLER_TEXT, `${what} is restored`);
      }

      // A CRLF checkout is the same caller, as central reads it: verify passes, a rerun keeps it.
      writeFileSync(callerAt, CALLER_TEXT.replace(/\n/g, '\r\n'));
      assert.equal(verify().status, 0, 'a CRLF caller passes');
      assert.equal(run(israelDir, 'scripts/new-app.mjs', [NAME]).status, 0);
      assert.equal(readFileSync(callerAt, 'utf8'), CALLER_TEXT.replace(/\n/g, '\r\n'));
      restore(israelDir, generated);

      // The legacy caller beside the current one, or a directory under .github/workflows.
      put(israelDir, LEGACY_CALLER_PATH, 'name: legacy\n');
      const legacy = verify();
      assert.equal(legacy.status, 1, transcript(legacy));
      assert.ok(legacy.stderr.includes(LEGACY_CALLER_PATH), transcript(legacy));
      restore(israelDir, generated);
      mkdirSync(join(israelDir, '.github', 'workflows', 'nested'));
      const nested = verify();
      assert.equal(nested.status, 1, transcript(nested));
      assert.match(nested.stderr, /a directory under \.github\/workflows/);
      restore(israelDir, generated);

      // Without its marker the tree still shows the signs, so verify and a rerun fail closed.
      unlinkSync(join(israelDir, MARKER_PATH));
      const noMarker = verify();
      assert.equal(noMarker.status, 1, transcript(noMarker));
      assert.match(noMarker.stderr, /shows signs of a DB Israel app/);
      refuses(israelDir, [NAME], /shows signs of a DB Israel app/);
      refuses(israelDir, ISRAEL, /shows signs of a DB Israel app/);
    } finally {
      restore(israelDir, generated);
    }
  });

  it('--verify-only checks the DB Israel invariants: provider ids, build prerequisites, enrollment', () => {
    const verify = () => run(israelDir, 'scripts/new-app.mjs', ['--verify-only']);
    const edit = (rel, from, to) => {
      const path = join(israelDir, rel);
      const text = readFileSync(path, 'utf8');
      const next = text.replace(from, to);
      assert.notEqual(next, text, `${rel}: ${from}`);
      writeFileSync(path, next);
    };
    // A real-looking account id, built here: any id but the sentinel names a real account.
    const account = 'ab'.repeat(16);
    const cases = [
      [
        'an account id',
        () =>
          edit(
            'wrangler.staging.jsonc',
            `"account_id": "${SENTINEL}"`,
            `"account_id": "${account}"`,
          ),
        /account_id/,
      ],
      [
        // No account at all: a raw wrangler command would act on the login's account.
        'no account_id',
        () => {
          for (const file of ['wrangler.jsonc', 'wrangler.staging.jsonc']) {
            edit(file, new RegExp(`^[ \\t]*"account_id": "${SENTINEL}",\\n`, 'm'), '');
          }
        },
        /wrangler\.jsonc: account_id \(missing\)[\s\S]*wrangler\.staging\.jsonc: account_id \(missing\)/,
      ],
      [
        'a store id',
        () => edit('wrangler.jsonc', `"store_id": "${SENTINEL}"`, `"store_id": "${account}"`),
        /store_id/,
      ],
      [
        // The CIAL platform tooling the bootstrap removed, back: a deployable CIAL-account Worker.
        'the CIAL platform tooling',
        () => put(israelDir, 'tools/secrets-migrator/wrangler.jsonc', '{}\n'),
        /tools\/secrets-migrator/,
      ],
      [
        'a CF_ACCOUNT_ID var',
        () =>
          edit('wrangler.staging.jsonc', '"CF_ACCOUNT_ID": ""', `"CF_ACCOUNT_ID": "${account}"`),
        /CF_ACCOUNT_ID/,
      ],
      [
        'a lockfile entry outside the registry',
        () =>
          edit(
            'package-lock.json',
            /"resolved": "https:\/\/registry\.npmjs\.org\//,
            '"resolved": "https://example.invalid/',
          ),
        /registry/,
      ],
      [
        'an .npmrc key',
        () => appendFileSync(join(israelDir, '.npmrc'), 'registry=https://example.invalid/\n'),
        /\.npmrc/,
      ],
      [
        'a migration name outside the pattern',
        () => put(israelDir, 'migrations/d1/0099-Bad.sql', 'SELECT 1;\n'),
        /0099-Bad\.sql/,
      ],
      [
        'no build:web script',
        () => edit('package.json', '"build:web":', '"build:site":'),
        /build:web/,
      ],
      [
        'an unsafe workflow',
        () =>
          put(
            israelDir,
            '.github/workflows/extra.yml',
            'name: x\non: push\njobs:\n  a:\n    secrets: inherit\n',
          ),
        /extra\.yml/,
      ],
    ];
    try {
      for (const [what, make, says] of cases) {
        make();
        const v = verify();
        assert.equal(v.status, 1, `${what}: ${transcript(v)}`);
        assert.match(v.stderr, says, `${what}: ${transcript(v)}`);
        restore(israelDir, generated);
      }
      assert.equal(verify().status, 0, 'the generated tree passes again');
    } finally {
      restore(israelDir, generated);
    }
  });

  it('a /kit-upgrade overlay keeps the marker and the caller, and verify still passes', () => {
    try {
      const upgrade = readFileSync(
        join(ROOT, '.claude', 'skills', 'kit-upgrade', 'SKILL.md'),
        'utf8',
      );
      const diffSet = upgrade.match(/git diff HEAD kit\/main -- ([^`]+)`/)?.[1].split(/\s+/) ?? [];
      assert.ok(diffSet.length > 10, 'the /kit-upgrade skill names its diff set');
      const inSet = (p) => diffSet.some((d) => p === d || p.startsWith(`${d}/`));
      // What keeps a DB Israel app's own files through an upgrade. The marker, its wrangler configs,
      // its doc and the tools/ it no longer has are outside the diff set, so step 3 never takes
      // them. The caller is inside it (`.github`), and only the rule that an upgrade never takes a
      // deletion keeps it: the kit has no caller, so the diff shows the app's as one.
      for (const p of [
        MARKER_PATH,
        'wrangler.jsonc',
        'wrangler.staging.jsonc',
        CENTRAL_DELIVERY_DOC,
        ...committableFiles().filter((p) => TOOLS.test(p)),
      ]) {
        assert.equal(inSet(p), false, `${p} is outside the /kit-upgrade diff set`);
      }
      assert.equal(inSet(CALLER_PATH), true, 'the caller is inside the diff set');
      // Step 3 takes the kit's files (it never takes a deletion), and trap T2 re-localizes the
      // carried files the bootstrap renames.
      let taken = 0;
      for (const rel of committableFiles().filter(inSet)) {
        const from = join(ROOT, rel);
        if (!lstatSync(from).isFile()) continue;
        const text = readFileSync(from);
        const next = FILES.includes(rel)
          ? Buffer.from(renameTemplateRefs(text.toString('utf8'), NAME, DISPLAY))
          : text;
        put(israelDir, rel, next);
        taken++;
      }
      assert.ok(taken > 100, `the overlay took ${taken} files`);
      assert.equal(readFileSync(join(israelDir, MARKER_PATH), 'utf8'), ISRAEL_MARKER);
      assert.equal(readFileSync(join(israelDir, CALLER_PATH), 'utf8'), CALLER_TEXT);
      assert.equal(existsSync(join(israelDir, 'tools')), false, 'the upgrade brings no tools/');
      const reader = run(israelDir, 'scripts/deployment-target.mjs');
      assert.equal(reader.stdout, 'dbisrael\n', transcript(reader));
      const verify = run(israelDir, 'scripts/new-app.mjs', ['--verify-only']);
      assert.equal(verify.status, 0, transcript(verify));
    } finally {
      restore(israelDir, generated);
    }
  });

  it('the plugin path (an rsync copy, a run with --target, a second run without it) gives the same app', () => {
    const dir = tempTree('bootstrap-e2e-plugin-', { exclude: PLUGIN_PACKAGING });
    const first = run(dir, 'scripts/new-app.mjs', ISRAEL);
    assert.equal(first.status, 0, transcript(first));
    assert.equal(readFileSync(join(dir, MARKER_PATH), 'utf8'), ISRAEL_MARKER);
    const once = snapshot(dir);
    const second = run(dir, 'scripts/new-app.mjs', [NAME]);
    assert.equal(second.status, 0, transcript(second));
    assert.deepEqual(compare(once, snapshot(dir)), { added: [], removed: [], changed: [] });
    assert.deepEqual(compare(israel, snapshot(dir)), { added: [], removed: [], changed: [] });
  });

  it('a renamed CIAL tree switches to DB Israel only while nothing is provisioned, and then equals a fresh generation', () => {
    const dir = tempTree('bootstrap-e2e-switch-');
    const cial = run(dir, 'scripts/new-app.mjs', [NAME]);
    assert.equal(cial.status, 0, transcript(cial));
    assert.equal(existsSync(join(dir, MARKER_PATH)), false, 'a CIAL app first');
    const switched = run(dir, 'scripts/new-app.mjs', ISRAEL);
    assert.equal(switched.status, 0, transcript(switched));
    assert.equal(readFileSync(join(dir, MARKER_PATH), 'utf8'), ISRAEL_MARKER);
    assert.deepEqual(compare(israel, snapshot(dir)), { added: [], removed: [], changed: [] });
  });

  it('the CIAL default is unchanged however it is asked for, and the refusals change nothing', () => {
    const dir = tempTree('bootstrap-e2e-cial-');
    const pristine = capture(dir);
    const pristineHash = treeHash(snapshot(dir));

    // No --target, --target cial and --target=cial: the same CIAL app and the same output.
    const cialRun = (args) => {
      restore(dir, pristine);
      const r = run(dir, 'scripts/new-app.mjs', args);
      assert.equal(r.status, 0, `${args.join(' ')}: ${transcript(r)}`);
      return { r, snap: snapshot(dir) };
    };
    const base = cialRun([NAME]);
    assertPlainCialRename(dir, DISPLAY);
    assert.equal(base.snap.has(MARKER_PATH), false);
    assert.equal(base.snap.has(CALLER_PATH), false);
    assert.equal(base.snap.has(CENTRAL_DELIVERY_DOC), false);
    assert.ok(
      [...base.snap.keys()].some((p) => TOOLS.test(p)),
      'a CIAL app keeps tools/',
    );
    assert.ok(base.r.stdout.includes(`https://staging-${NAME}.cialdnb.ai/_health`));
    for (const args of [
      [NAME, '--target', 'cial'],
      [NAME, '--target=cial'],
      ['--target', 'cial', NAME],
    ]) {
      const { r, snap } = cialRun(args);
      assert.equal(r.stdout, base.r.stdout, args.join(' '));
      assert.equal(r.stderr, base.r.stderr, args.join(' '));
      assert.deepEqual(compare(base.snap, snap), { added: [], removed: [], changed: [] });
    }
    // A name that looks like a DB Israel app's is still CIAL: the target is never inferred.
    const ilName = cialRun(['il-foo']);
    assert.equal(ilName.snap.has(MARKER_PATH), false);
    assert.equal(ilName.snap.has(CALLER_PATH), false);
    assert.ok(ilName.r.stdout.includes('https://staging-il-foo.cialdnb.ai/_health'));
    // --display=, now read (it used to be ignored), in either position.
    const eq = cialRun([NAME, '--display=Probe App']);
    const spaced = cialRun(['--display', 'Probe App', NAME]);
    assert.deepEqual(compare(eq.snap, spaced.snap), { added: [], removed: [], changed: [] });
    assertPlainCialRename(dir, 'Probe App');
    const mailName = parseJsonc(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')).vars
      .MAIL_FROM_NAME;
    assert.equal(mailName, 'Probe App');

    // Usage errors: exit 1, the usage, and no change.
    restore(dir, pristine);
    assert.equal(treeHash(snapshot(dir)), pristineHash);
    for (const args of [
      [NAME, '--target', 'foo'],
      [NAME, '--target'],
      [NAME, '--target='],
      [NAME, '--tagret', 'dbisrael'],
      [NAME, '--target', 'cial', '--target', 'dbisrael'],
      [NAME, 'extra'],
      [NAME, '--display'],
      ['--verify-only', NAME],
      [`e2e-${'x'.repeat(29)}`, '--target', 'dbisrael'],
    ]) {
      refuses(dir, args, /Usage: node scripts\/new-app\.mjs/);
    }

    // An invalid marker, or a missing one beside a sign of a DB Israel app: exit 1, no change.
    for (const [what, make] of [...INVALID_MARKERS, ...SIGNS]) {
      restore(dir, pristine);
      make(dir);
      for (const args of [[NAME], ISRAEL]) {
        const r = refuses(dir, args);
        assert.ok(r.stderr.includes(MARKER_PATH), `${what}, ${args.join(' ')}: ${transcript(r)}`);
      }
    }

    // The template with a marker already in it: honoured only when --target names the same
    // target (a rerun after a failed run), and then it is the same app as a fresh generation.
    restore(dir, pristine);
    put(dir, MARKER_PATH, ISRAEL_MARKER);
    refuses(dir, [NAME], /--target/);
    refuses(dir, [NAME, '--target', 'cial'], /--target/);
    const honoured = run(dir, 'scripts/new-app.mjs', ISRAEL);
    assert.equal(honoured.status, 0, transcript(honoured));
    assert.deepEqual(compare(israel, snapshot(dir)), { added: [], removed: [], changed: [] });
    restore(dir, pristine);
    put(dir, MARKER_PATH, CIAL_MARKER);
    refuses(dir, ISRAEL, /--target/);

    // A renamed CIAL tree: a dual-delivered app passes verify with a cial marker and the caller;
    // the switch to DB Israel is refused once anything is provisioned or stamped, or under a
    // cial marker, or under another name.
    restore(dir, pristine);
    assert.equal(run(dir, 'scripts/new-app.mjs', [NAME]).status, 0);
    const renamed = capture(dir);
    put(dir, MARKER_PATH, CIAL_MARKER);
    put(dir, CALLER_PATH, CALLER_TEXT);
    const dual = run(dir, 'scripts/new-app.mjs', ['--verify-only']);
    assert.equal(dual.status, 0, transcript(dual));
    appendFileSync(join(dir, CALLER_PATH), ' ');
    const dualEdited = run(dir, 'scripts/new-app.mjs', ['--verify-only']);
    assert.equal(dualEdited.status, 1, transcript(dualEdited));
    assert.ok(dualEdited.stderr.includes(CALLER_PATH), transcript(dualEdited));
    // Restored by hand: a rerun would take the CIAL branch and reset the app's provisioned ids.
    assert.doesNotMatch(dualEdited.stderr, /Rerun the bootstrap/, transcript(dualEdited));
    restore(dir, renamed);
    put(dir, MARKER_PATH, CIAL_MARKER);
    refuses(dir, ISRAEL, /reviewed migration/);
    // A provisioned-looking id, built here (a D1 id is a UUID).
    const provisioned = ['1', '2', '3', '4', '5']
      .map((c, i) => c.repeat([8, 4, 4, 4, 12][i]))
      .join('-');
    for (const [what, make] of [
      [
        'a provisioned staging D1 id',
        () => {
          const path = join(dir, 'wrangler.staging.jsonc');
          writeFileSync(
            path,
            readFileSync(path, 'utf8').replace(
              /("database_id":\s*)"PLACEHOLDER_RUN_PROVISION"/,
              `$1"${provisioned}"`,
            ),
          );
        },
      ],
      [
        'a provisioned production KV id',
        () => {
          const path = join(dir, 'wrangler.jsonc');
          writeFileSync(
            path,
            readFileSync(path, 'utf8').replace(
              /("id":\s*)"PLACEHOLDER_RUN_PROVISION"/,
              `$1"${'c'.repeat(32)}"`,
            ),
          );
        },
      ],
      [
        'a regenerated resource manifest',
        () => appendFileSync(join(dir, 'docs/RESOURCES.md'), '\n| D1 | x |\n'),
      ],
    ]) {
      restore(dir, renamed);
      make();
      refuses(dir, ISRAEL, /CIAL resources/);
      assert.ok(what);
    }
    restore(dir, renamed);
    refuses(dir, ['other-name', '--target', 'dbisrael'], /other-name/);

    // A plain CIAL rerun resets the working tree's staging ids and manifest, never the git
    // history, so the switch reads the history too. First the way a "Use this template"
    // repository starts: the template committed (the kit's own staging ids among it), then the
    // bootstrap. The switch is allowed there, and gives the same app.
    restore(dir, pristine);
    const hooks = mkdtempSync(join(tmpdir(), 'bootstrap-e2e-hooks-'));
    temps.push(hooks);
    const gitEnv = { ...childEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = (...args) => {
      const config = [
        ['user.name', 'e2e'],
        ['user.email', 'e2e@example.invalid'],
        ['commit.gpgsign', 'false'],
        ['core.hooksPath', hooks],
        ['init.defaultBranch', 'main'],
      ].flatMap(([key, value]) => ['-c', `${key}=${value}`]);
      const r = spawnSync('git', [...config, ...args], { cwd: dir, encoding: 'utf8', env: gitEnv });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    const withoutGit = (snap) => new Map([...snap].filter(([p]) => !p.startsWith('.git/')));
    git('init', '-q');
    // No background `gc --auto` after a commit: it repacks .git/objects while the tree is hashed.
    git('config', 'gc.auto', '0');
    git('config', 'maintenance.auto', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'the template');
    assert.equal(run(dir, 'scripts/new-app.mjs', [NAME]).status, 0);
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: bootstrap');
    const fresh = run(dir, 'scripts/new-app.mjs', ISRAEL);
    assert.equal(fresh.status, 0, transcript(fresh));
    assert.deepEqual(compare(israel, withoutGit(snapshot(dir))), {
      added: [],
      removed: [],
      changed: [],
    });
    git('checkout', '-q', '--', '.');
    git('clean', '-q', '-f', '-d');
    const stagingConfig = join(dir, 'wrangler.staging.jsonc');
    const placeholderId = /("database_id":\s*)"PLACEHOLDER_RUN_PROVISION"/;
    const provisionId = () =>
      writeFileSync(
        stagingConfig,
        readFileSync(stagingConfig, 'utf8').replace(placeholderId, `$1"${provisioned}"`),
      );
    const regenerateManifest = () =>
      appendFileSync(join(dir, 'docs/RESOURCES.md'), '\n| D1 | x |\n');
    // Every ref counts, and either kind of evidence refuses on its own: the provisioning commit on
    // a side branch (the owner's PR of the Provision-staging artifact's ids) while main, with the
    // placeholders, is checked out.
    for (const [what, edits, holds] of [
      ['the staging id and the manifest', [provisionId, regenerateManifest], null],
      ['the manifest alone', [regenerateManifest], 'a regenerated docs/RESOURCES.md'],
      ['a staging id alone', [provisionId], 'a provisioned id in wrangler.staging.jsonc'],
    ]) {
      git('checkout', '-q', '-b', 'chore/staging-ids');
      for (const edit of edits) edit();
      git('commit', '-q', '-a', '-m', `chore: ${what}`);
      git('checkout', '-q', 'main');
      const r = refuses(dir, ISRAEL, /CIAL resources: its git history holds/);
      if (holds)
        assert.ok(r.stderr.includes(`holds ${holds} (commit `), `${what}: ${transcript(r)}`);
      git('branch', '-q', '-D', 'chore/staging-ids');
    }
    // A .git whose history git cannot read refuses, whichever step fails: a corrupt HEAD
    // (rev-parse), the same .git inside another repository (git passes over it and would read
    // that repository's history), a .git set bare, a .git that links to nothing (a volume not
    // mounted: git finds no repository), and a blob the history names gone (the read).
    const unread = (because) => new RegExp(`git history cannot be read \\(${because}\\)`);
    const headPath = join(dir, '.git', 'HEAD');
    const head = readFileSync(headPath);
    writeFileSync(headPath, 'not a ref\n');
    refuses(dir, ISRAEL, unread('git rev-parse failed'));
    const outer = mkdtempSync(join(tmpdir(), 'bootstrap-e2e-outer-'));
    temps.push(outer);
    git('init', '-q', outer);
    const nested = join(outer, 'app');
    renameSync(dir, nested);
    refuses(nested, ISRAEL, unread('git does not use the .git here'));
    renameSync(nested, dir);
    writeFileSync(headPath, head);
    git('config', 'core.bare', 'true');
    refuses(dir, ISRAEL, unread('git does not use the .git here'));
    git('config', 'core.bare', 'false');
    const parked = mkdtempSync(join(tmpdir(), 'bootstrap-e2e-parked-'));
    temps.push(parked);
    renameSync(join(dir, '.git'), join(parked, '.git'));
    symlinkSync(join(parked, 'unmounted', '.git'), join(dir, '.git'));
    refuses(dir, ISRAEL, unread('git rev-parse failed'));
    unlinkSync(join(dir, '.git'));
    renameSync(join(parked, '.git'), join(dir, '.git'));
    const blob = git('rev-parse', 'HEAD:wrangler.staging.jsonc').trim();
    const objectPath = join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    const object = readFileSync(objectPath);
    unlinkSync(objectPath);
    refuses(dir, ISRAEL, unread('git log failed'));
    writeFileSync(objectPath, object);
    // Then a provisioned CIAL app: its staging id and manifest committed, then a plain rerun,
    // which puts the placeholders back in the working tree. The history still refuses the switch.
    provisionId();
    regenerateManifest();
    git('commit', '-q', '-a', '-m', 'chore: the provisioned staging ids');
    refuses(dir, ISRAEL, /CIAL resources/);
    const rerun = run(dir, 'scripts/new-app.mjs', [NAME]);
    assert.equal(rerun.status, 0, transcript(rerun));
    assert.match(readFileSync(stagingConfig, 'utf8'), placeholderId, 'the rerun reset the id');
    assert.equal(readFileSync(join(dir, 'docs/RESOURCES.md'), 'utf8'), placeholderManifest(NAME));
    refuses(dir, ISRAEL, /CIAL resources[\s\S]*git history/);
    // The rerun committed, so the tip holds the placeholders, and the same repository cloned
    // with --depth 1: the provisioning commit lies past the shallow boundary, so the history git
    // reads there is not the whole history, and the switch refuses until it is fetched.
    git('commit', '-q', '-a', '-m', 'chore: rerun the bootstrap');
    refuses(dir, ISRAEL, /CIAL resources: its git history holds/);
    const clone = join(mkdtempSync(join(tmpdir(), 'bootstrap-e2e-shallow-')), 'app');
    temps.push(dirname(clone));
    git('clone', '-q', '--depth', '1', `file://${dir}`, clone);
    refuses(clone, ISRAEL, unread('the clone is shallow; git fetch --unshallow fetches the rest'));
    git('-C', clone, 'fetch', '-q', '--unshallow');
    refuses(clone, ISRAEL, /CIAL resources: its git history holds/);
  });
});

// ── A new app's own CI ───────────────────────────────────────────────────────────────────────
//
// The node gates of a new app's first CI run (the `test-gates` job), in a copy generated for each
// target, through the copy's own package.json: `test:scripts` (every test/platform/*.test.mjs),
// `test:hooks` and `verify:kit-migrations`. Each must exit 0 and leave the tree as it found it.
// The copy has no node_modules, so this checkout's is linked in. Then the app's first own
// migration goes in, the state every fork is in from its first feature, and the tests that read
// migrations/d1 as the kit's (kit-migrations.test.mjs) and the ordinal guard run again, with the
// gate. The two targets run at the same time.
//
// Not the copy's Vitest suite (the `test-suite` job). It is the kit's own suite with the rename
// applied to the test configs and four test files, which the kit's CI runs already, and it is the
// cost: the kit's one Vitest run is its CI long pole (about 4 min 45 s), and two more here would
// make this file longer than that. Run by hand on 2026-10-28, it passed in both generated copies.

const execFileAsync = promisify(execFile);

// The copy leaves out a top-level node_modules and gets this checkout's linked in once, after the
// bootstrap. A checkout can have a symlink there (a worktree that borrows another clone's
// node_modules), and git lists that link as an untracked file, since .gitignore's `node_modules/`
// matches only a directory, so copyTree would copy it and the link would then collide with it.
// The gate cases and the case that pins this all make the copy through copyForGates.
const NODE_MODULES = /^node_modules$/;
/** The gates' copy of `from` at `dir`: its committable tree, without a top-level node_modules. */
const copyForGates = (dir, from = ROOT) => copyTree(dir, { exclude: NODE_MODULES, from });
/** Links `from`'s node_modules into the copy at `dir`, for the copy's gates to resolve packages. */
const linkModules = (dir, from = ROOT) =>
  symlinkSync(join(from, 'node_modules'), join(dir, 'node_modules'));

describe("a new app's own CI gates, in a copy generated for each target", {
  skip: !isTemplateRepo(ROOT) && 'kit only: this repo is already renamed',
  timeout: 300_000,
  concurrency: true,
}, () => {
  // A fresh shell, as a CI step starts: the nested runners must not report to this one, and npm
  // must find the copy's package.json, not read the outer run's npm_* settings.
  const gateEnv = Object.fromEntries(
    Object.entries(childEnv).filter(
      ([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'INIT_CWD' && !/^npm_/i.test(key),
    ),
  );
  /** `command args` in `cwd`, without blocking, so both copies run at once. */
  const runAsync = async (cwd, command, args) => {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd,
        env: gateEnv,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { status: 0, stdout, stderr };
    } catch (err) {
      return { status: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
    }
  };
  // What kit-migrations.test.mjs reports for each case it runs in the kit only (spec or TAP).
  const KIT_ONLY_SKIP = /# (?:SKIP )?kit only: in an app, migrations\/d1 is the app's own/;
  const AS_AN_APP =
    /Kit migration guard passed: all \d+ kit migration\(s\) present, matched by content/;

  it('the copy gets node_modules once, also from a checkout that links it in', () => {
    const borrowed = mkdtempSync(join(tmpdir(), 'bootstrap-e2e-modules-'));
    const from = mkdtempSync(join(tmpdir(), 'bootstrap-e2e-linked-'));
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-e2e-ci-'));
    try {
      // The fixture's git ignores only what its .gitignore says. A machine's own excludes (a
      // core.excludesFile, or ~/.config/git/ignore by default) or a git template's info/exclude
      // often list a plain `node_modules`, which would hide the link and leave nothing to pin.
      execFileSync('git', ['init', '-q', '--template=', from], { env: childEnv });
      execFileSync('git', ['-C', from, 'config', 'core.excludesFile', devNull], { env: childEnv });
      writeFileSync(join(from, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(from, 'package.json'), '{}\n');
      symlinkSync(borrowed, join(from, 'node_modules'));
      assert.ok(committableFiles(from).includes('node_modules'), 'git lists the link as a file');

      copyForGates(dir, from);
      linkModules(dir, from);
      assert.equal(readlinkSync(join(dir, 'node_modules')), join(from, 'node_modules'));
      assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{}\n');
    } finally {
      for (const d of [dir, from, borrowed]) rmSync(d, { recursive: true, force: true });
    }
  });

  for (const [target, args] of [
    ['CIAL', [NAME]],
    ['DB Israel', ISRAEL],
  ]) {
    it(`${target}: test:scripts, test:hooks and verify:kit-migrations pass, and still pass after its first own migration`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bootstrap-e2e-ci-'));
      try {
        copyForGates(dir);
        const bootstrap = run(dir, 'scripts/new-app.mjs', args);
        assert.equal(bootstrap.status, 0, transcript(bootstrap));
        linkModules(dir);
        const generated = treeHash(snapshot(dir));
        const gate = async (command, gateArgs) => {
          const r = await runAsync(dir, command, gateArgs);
          assert.equal(
            r.status,
            0,
            `${target}: ${command} ${gateArgs.join(' ')}: ${transcript(r)}`,
          );
          return r;
        };

        const scripts = await gate('npm', ['run', '-s', 'test:scripts']);
        assert.match(scripts.stdout, KIT_ONLY_SKIP, 'kit-migrations.test.mjs ran, as an app');
        await gate('npm', ['run', '-s', 'test:hooks']);
        const migrations = await gate('npm', ['run', '-s', 'verify:kit-migrations']);
        assert.match(migrations.stdout, AS_AN_APP);
        assert.equal(treeHash(snapshot(dir)), generated, 'the gates wrote nothing');

        // The app's first own migration, at the next free ordinal (migrations/d1/README.md).
        const folder = join(dir, 'migrations', 'd1');
        const own = `${nextOrdinal(sqlFiles(readdirSync(folder)))}_e2e_widgets.sql`;
        writeFileSync(
          join(folder, own),
          'CREATE TABLE IF NOT EXISTS e2e_widgets (id INTEGER PRIMARY KEY);\n',
        );
        await gate(process.execPath, [
          '--test',
          'test/platform/kit-migrations.test.mjs',
          'test/platform/migration-ordinals.test.mjs',
        ]);
        assert.match((await gate('npm', ['run', '-s', 'verify:kit-migrations'])).stdout, AS_AN_APP);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
