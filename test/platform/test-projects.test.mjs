// Pins the runtime split (docs/TESTING.md, "Put tests at the cheapest faithful layer"): which test
// runs in Node, which in minimal Workers, and that everything else runs in the full application.
//
// These are drift tripwires, not a security boundary. They catch the plausible accident: a
// manifest entry left stale or listed twice, an authz, audit or route suite moved out of full
// Workers for faster feedback, a moved test that still reaches the application, a Vitest config
// that stopped reading the manifests, or a minimal wrangler config that drifted from the full
// one. A PR that edits test/projects.mjs (code-owned) can edit this file in the same PR; the
// owner's review of that PR is the control for a deliberate move.
//
// The exact shape of vitest.config.ts is pinned in the kit only: a fork that adopts the split
// builds its own config (Insights adds DOM projects), and the manifest pins below hold for it.
// Run by `node --test` (test:scripts).
import assert from 'node:assert/strict';
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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parseJsonc } from '../../scripts/new-app.mjs';
import { minimalRuntimeViolations } from '../../scripts/test-runtime-boundary.mjs';
import { minimalWorkersTestFiles, nodeTestFiles } from '../projects.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
// The kit itself: its marketplace manifest never survives into a fork (new-app strips it).
const IN_KIT = existsSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
const KIT_ONLY = IN_KIT
  ? {}
  : { skip: "kit only: a fork's vitest.config.ts is its own; its manifests are pinned below" };
const MINIMAL_CONFIG = 'test/runtime/wrangler.test-minimal.jsonc';
const all = readdirSync(path.join(ROOT, 'test'), { recursive: true })
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => `test/${file.split(path.sep).join('/')}`)
  .sort();

// Suites that keep the full application whatever a manifest says (#257 review F7): the auth,
// framework, route, cron, security and isolation contracts, and the audit and read-log storage
// suites (PIA C15), whose WORM and ledger behaviour is the control evidence.
const FULL_WORKERS_ONLY =
  /^test\/(?:(?:auth|cron|framework|isolation|routes|security)\/|data\/(?:audit|read-log))/;

// One runtime list: at least one file, sorted, no repeats, each an exact path to an existing test.
function assertManifestList(name, files) {
  assert.ok(
    files.length > 0,
    `${name} lists no file: each runtime list names at least one reviewed test (start from the kit's test/projects.mjs: /kit-upgrade, "When adopting the split")`,
  );
  assert.deepEqual(files, [...files].sort());
  assert.equal(new Set(files).size, files.length);
  for (const file of files) {
    assert.match(file, /^test\/[^*?{}[\]!]+\.test\.ts$/);
    assert.ok(all.includes(file), `stale manifest entry: ${file}`);
  }
}

test('runtime manifests are exact, sorted, disjoint and contain existing tests', () => {
  assertManifestList('nodeTestFiles', nodeTestFiles);
  assertManifestList('minimalWorkersTestFiles', minimalWorkersTestFiles);
  assert.deepEqual(
    nodeTestFiles.filter((file) => minimalWorkersTestFiles.includes(file)),
    [],
  );
  const full = all.filter(
    (file) => !nodeTestFiles.includes(file) && !minimalWorkersTestFiles.includes(file),
  );
  assert.ok(full.length > 0, 'the manifests list every test: none is left in full Workers');
});

test('an empty runtime list is refused with a message that says each list needs a file (#291 review R1)', () => {
  // vitest.config.ts runs an empty list as no files, but this pin, which a fork that adopts the
  // split carries, wants each list to name at least one. Its refusal says so, as the config's
  // refusal of a missing list does, so neither sends an agent towards the other's failure.
  for (const name of ['nodeTestFiles', 'minimalWorkersTestFiles'])
    assert.throws(() => assertManifestList(name, []), {
      name: 'AssertionError',
      message: new RegExp(
        `^${name} lists no file: each runtime list names at least one reviewed test`,
      ),
    });
});

test('auth, framework, route, cron, security, isolation, audit and read-log suites stay in full Workers', () => {
  // Every area the rule names still matches (#291 review F9): an edit to the pattern that drops
  // one would leave a manifest free to list, say, test/framework/batchAudit.test.ts, which the
  // import guard passes. The samples are paths, not files, so a fork without one of the folders
  // keeps the rule.
  for (const area of ['auth', 'cron', 'framework', 'isolation', 'routes', 'security'])
    assert.match(`test/${area}/sample.test.ts`, FULL_WORKERS_ONLY, `test/${area}/ is held`);
  for (const sample of ['test/data/audit-sample.test.ts', 'test/data/read-log-sample.test.ts'])
    assert.match(sample, FULL_WORKERS_ONLY, `${sample} is held`);
  // The rule is not vacuous: it names real suites, the PIA C15 storage suites among them.
  const kept = all.filter((file) => FULL_WORKERS_ONLY.test(file));
  for (const file of [
    'test/auth/permissions.test.ts',
    'test/data/audit-append-only.test.ts',
    'test/data/audit.test.ts',
    'test/data/read-log-upstream.test.ts',
    'test/data/read-log.test.ts',
  ])
    assert.ok(kept.includes(file), `${file} is held in full Workers`);
  for (const [name, files] of [
    ['nodeTestFiles', nodeTestFiles],
    ['minimalWorkersTestFiles', minimalWorkersTestFiles],
  ])
    assert.deepEqual(
      files.filter((file) => FULL_WORKERS_ONLY.test(file)),
      [],
      `${name} lists a suite that keeps the full application`,
    );
});

test('reviewed runtime dependency graphs retain faithful placement', () => {
  for (const file of nodeTestFiles)
    assert.deepEqual(minimalRuntimeViolations(file, { runtime: 'node' }), [], file);
  for (const file of minimalWorkersTestFiles)
    assert.deepEqual(minimalRuntimeViolations(file), [], file);
});

// vitest.config.ts as Vitest loads it: Vite's config loader bundles it, in a scratch root holding
// a copy of it, package.json and the given repo files. Its cloudflareTest is a stand-in that
// returns its options, so each project's wrangler config reads back; vitest and vite are the
// repo's own. `run` gets the root and a `load` that reads the config again, in this process.
async function withConfigRoot(files, run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vitest-config-'));
  try {
    for (const file of ['package.json', 'vitest.config.ts', ...files]) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      cpSync(path.join(ROOT, file), path.join(dir, file));
    }
    const modules = path.join(dir, 'node_modules');
    const stub = path.join(modules, '@cloudflare', 'vitest-pool-workers');
    mkdirSync(stub, { recursive: true });
    writeFileSync(
      path.join(stub, 'package.json'),
      JSON.stringify({
        name: '@cloudflare/vitest-pool-workers',
        type: 'module',
        exports: './index.js',
      }),
    );
    writeFileSync(
      path.join(stub, 'index.js'),
      "export const cloudflareTest = (options) => ({ name: 'cloudflare-test-stand-in', options });\n",
    );
    for (const pkg of ['vite', 'vitest'])
      symlinkSync(path.join(ROOT, 'node_modules', pkg), path.join(modules, pkg), 'dir');
    const vite = createRequire(path.join(ROOT, 'package.json')).resolve('vite');
    const { loadConfigFromFile } = await import(pathToFileURL(vite).href);
    const load = async () =>
      (
        await loadConfigFromFile(
          { command: 'serve', mode: 'test' },
          path.join(dir, 'vitest.config.ts'),
          dir,
          'silent',
        )
      ).config;
    return await run({ dir, load });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const loadVitestConfig = (files) => withConfigRoot(files, ({ load }) => load());

// The root plugin that restarts the watcher when the manifests change (#291 review F12).
const MANIFEST_WATCH = 'kit:runtime-manifests';
const pluginNames = (plugins) => (plugins ?? []).flat().map((plugin) => plugin.name);
const wranglerOf = (plugins) =>
  (plugins ?? [])
    .flat()
    .filter((plugin) => plugin.name !== MANIFEST_WATCH)
    .map((plugin) => plugin.options?.wrangler?.configPath);

test(
  'without test/projects.mjs, vitest.config.ts is the single full-Workers config (#257 review F2)',
  KIT_ONLY,
  async () => {
    // /kit-upgrade carries vitest.config.ts; the manifests, the minimal runtime and the Node setup
    // arrive only when an app adopts the split. An app that has not adopted it keeps the config it
    // had: every test in full Workers, the same coverage map and floors.
    const config = await loadVitestConfig([]);
    assert.deepEqual(pluginNames(config.plugins), ['cloudflare-test-stand-in', MANIFEST_WATCH]);
    assert.deepEqual(wranglerOf(config.plugins), ['./wrangler.test.jsonc']);
    assert.equal(config.test.projects, undefined);
    assert.deepEqual(config.test.include, ['test/**/*.test.ts']);
    assert.equal(config.test.exclude, undefined);
    assert.equal(config.test.testTimeout, 30_000);
    const split = await loadVitestConfig(['test/projects.mjs']);
    assert.deepEqual(config.test.coverage, split.test.coverage);
  },
);

test(
  'with the manifests, every test file runs in exactly one project, and new files in full Workers',
  KIT_ONLY,
  async () => {
    const config = await loadVitestConfig(['test/projects.mjs']);
    assert.deepEqual(pluginNames(config.plugins), [MANIFEST_WATCH]);
    assert.equal(config.test.include, undefined);
    const projects = config.test.projects.map(({ plugins, test: t }) => ({
      name: t.name,
      environment: t.environment,
      include: t.include,
      exclude: t.exclude,
      setupFiles: t.setupFiles,
      testTimeout: t.testTimeout,
      wrangler: wranglerOf(plugins),
    }));
    assert.deepEqual(projects, [
      {
        name: 'node',
        environment: 'node',
        include: nodeTestFiles,
        exclude: undefined,
        setupFiles: ['./test/setup/node-no-network.ts'],
        testTimeout: 30_000,
        wrangler: [],
      },
      {
        name: 'workers-minimal',
        environment: undefined,
        include: minimalWorkersTestFiles,
        exclude: undefined,
        setupFiles: undefined,
        testTimeout: 30_000,
        wrangler: [`./${MINIMAL_CONFIG}`],
      },
      {
        name: 'workers',
        environment: undefined,
        include: ['test/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/.git/**', ...nodeTestFiles, ...minimalWorkersTestFiles],
        setupFiles: undefined,
        testTimeout: 30_000,
        wrangler: ['./wrangler.test.jsonc'],
      },
    ]);
  },
);

test(
  'an edited manifest reaches the next config load, and an edit restarts the watcher (#291 review F12)',
  KIT_ONLY,
  async () => {
    // Vitest's watcher restarts on an edit to vitest.config.ts, not to a file it imports, and
    // restarts in the same process, where an imported module is cached.
    await withConfigRoot(['test/projects.mjs'], async ({ dir, load }) => {
      const manifest = path.join(dir, 'test', 'projects.mjs');
      const lists = async () => (await load()).test.projects.map(({ test: t }) => t.include);
      assert.deepEqual((await lists()).slice(0, 2), [nodeTestFiles, minimalWorkersTestFiles]);
      writeFileSync(
        manifest,
        "export const nodeTestFiles = ['test/moved.test.ts'];\nexport const minimalWorkersTestFiles = [];\n",
      );
      assert.deepEqual((await lists()).slice(0, 2), [['test/moved.test.ts'], []]);

      const config = await load();
      const watch = config.plugins.flat().find((plugin) => plugin.name === MANIFEST_WATCH);
      const handlers = {};
      const added = [];
      let restarts = 0;
      watch.configureServer({
        watcher: {
          add: (file) => added.push(file),
          on: (event, handler) => {
            handlers[event] = handler;
          },
        },
        restart: async () => {
          restarts += 1;
        },
      });
      assert.deepEqual(
        added.map((file) => realpathSync(file)),
        [realpathSync(manifest)],
      );
      handlers.change(path.join(dir, 'test', 'other.test.ts'));
      assert.equal(restarts, 0, 'another file does not restart the watcher');
      for (const event of ['change', 'add', 'unlink']) handlers[event](manifest);
      assert.equal(restarts, 3, 'an edit, a new manifest and a removed one each restart it');
    });
  },
);

test(
  'a manifest without both lists is refused by name, not with a TypeError (#291 review F3)',
  KIT_ONLY,
  async () => {
    await withConfigRoot(['test/projects.mjs'], async ({ dir, load }) => {
      writeFileSync(
        path.join(dir, 'test', 'projects.mjs'),
        "export const nodeTestFiles = ['test/ai/mask.test.ts'];\n",
      );
      // It states the rule the manifest pin holds: a list of at least one file (#291 review R1).
      await assert.rejects(load(), {
        message:
          /test\/projects\.mjs must export minimalWorkersTestFiles, a list of at least one test file/,
      });
    });
  },
);

test('minimal Workers keeps the full test bindings, compatibility and variables, outside the repo root (#257 review F8)', () => {
  // Under test/runtime/, not the root: verify:edge reads every root wrangler config as a deploying
  // one (edge-hardening.test.mjs pins that list), and this one never deploys.
  const full = parseJsonc(readFileSync(path.join(ROOT, 'wrangler.test.jsonc'), 'utf8'));
  const minimal = parseJsonc(readFileSync(path.join(ROOT, MINIMAL_CONFIG), 'utf8'));
  assert.equal(minimal.main, 'minimal-worker.ts');
  // The one binding it leaves out: the application's Workflows, which the import guard keeps
  // minimal tests off. A Durable Object binding stays: the runtime starts, and a test that uses
  // a class only src/index.ts exports fails with "does not export a ... Durable Object", so such
  // a suite stays in full Workers (#291 review F6).
  assert.equal(minimal.workflows, undefined);
  assert.equal(
    path.resolve(ROOT, path.dirname(MINIMAL_CONFIG), minimal.$schema),
    path.resolve(ROOT, full.$schema),
  );
  for (const key of ['$schema', 'name', 'main', 'workflows']) delete full[key];
  for (const key of ['$schema', 'name', 'main']) delete minimal[key];
  assert.deepEqual(minimal, full);
  const entry = readFileSync(path.join(ROOT, 'test/runtime/minimal-worker.ts'), 'utf8');
  assert.match(entry, /throw new Error\(/);
  assert.doesNotMatch(entry, /\bimport\b/);
});
