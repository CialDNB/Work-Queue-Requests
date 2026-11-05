// Vitest config — the TypeScript suite runs in three disjoint projects, with one coverage map
// (docs/TESTING.md, "Put tests at the cheapest faithful layer"):
//   - `node`: the reviewed portable files test/projects.mjs lists, in plain Node, where an
//     unstubbed fetch or WebSocket fails (test/setup/node-no-network.ts);
//   - `workers-minimal`: the reviewed binding tests it lists, in a real Workers runtime with the
//     full test config's bindings and vars apart from its Workflows, whose entrypoint refuses
//     HTTP (test/runtime/);
//   - `workers`: every other file, and every new one — the full application in a real Workers
//     runtime via the cloudflareTest plugin (@cloudflare/vitest-pool-workers v0.16+), with the
//     bindings from wrangler.test.jsonc (in-memory D1/KV/R2 — no network, no production traffic
//     possible).
// Each test FILE gets an isolated Miniflare-backed runtime. Storage is isolated per file;
// test/helpers/db.ts seedDb() resets state between tests within a file.
//
// An app without test/projects.mjs keeps the single full-Workers config it had before the split
// (#257 review F2): /kit-upgrade carries this file, while the manifests, the minimal runtime and
// the Node setup arrive only when an app adopts the split (/kit-upgrade, "When adopting the
// split"). test/platform/test-projects.test.mjs loads this file both ways. The manifests are
// imported through a URL, not a literal path, so the config bundler never resolves a file the
// app does not have.
//
// In watch mode Vitest restarts, in the same process, when this file changes, but not when a
// file it imports does (#291 review F12). So the manifests are imported afresh whenever their
// text changes, and an edit to them, or their arrival, restarts the watcher like an edit here.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { configDefaults, defineConfig, defineProject, type Plugin } from 'vitest/config';

const manifestUrl = new URL('./test/projects.mjs', import.meta.url);
const manifestPath = fileURLToPath(manifestUrl);
const testTimeout = 30_000;
const workersRuntime = (configPath: string) => cloudflareTest({ wrangler: { configPath } });
// A watched path, through any symlinked folder (macOS's /var is /private/var); its folder
// remains when the file itself is removed.
function canonical(file: string) {
  try {
    return path.join(realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    return path.resolve(file);
  }
}
const manifestWatch: Plugin = {
  name: 'kit:runtime-manifests',
  configureServer(server) {
    server.watcher.add(manifestPath);
    const restart = (file: string) => {
      if (canonical(file) === canonical(manifestPath)) void server.restart();
    };
    for (const event of ['change', 'add', 'unlink'] as const) server.watcher.on(event, restart);
  },
};

async function readManifests() {
  if (!existsSync(manifestUrl)) return undefined;
  const version = createHash('sha256').update(readFileSync(manifestUrl)).digest('hex');
  const manifests = await import(`${manifestUrl.href}?v=${version}`);
  // The kit's two lists, by name: a manifest written for another config (DOM or timing projects)
  // belongs with that app's own vitest.config.ts (#291 review F3). The message states the rule
  // test/platform/test-projects.test.mjs holds, at least one file in each (#291 review R1).
  for (const list of ['nodeTestFiles', 'minimalWorkersTestFiles'])
    if (!Array.isArray(manifests[list]))
      throw new Error(
        `test/projects.mjs must export ${list}, a list of at least one test file (start from the kit's): see /kit-upgrade, "When adopting the split"`,
      );
  return manifests as { nodeTestFiles: string[]; minimalWorkersTestFiles: string[] };
}

export default defineConfig(async () => {
  const manifests = await readManifests();
  const projects = manifests && [
    defineProject({
      test: {
        name: 'node',
        environment: 'node',
        include: manifests.nodeTestFiles,
        setupFiles: ['./test/setup/node-no-network.ts'],
        testTimeout,
      },
    }),
    defineProject({
      plugins: [workersRuntime('./test/runtime/wrangler.test-minimal.jsonc')],
      test: { name: 'workers-minimal', include: manifests.minimalWorkersTestFiles, testTimeout },
    }),
    defineProject({
      plugins: [workersRuntime('./wrangler.test.jsonc')],
      test: {
        name: 'workers',
        include: ['test/**/*.test.ts'],
        exclude: [
          ...configDefaults.exclude,
          ...manifests.nodeTestFiles,
          ...manifests.minimalWorkersTestFiles,
        ],
        testTimeout,
      },
    }),
  ];
  return {
    plugins: projects ? [manifestWatch] : [workersRuntime('./wrangler.test.jsonc'), manifestWatch],
    test: {
      ...(projects ? { projects } : { include: ['test/**/*.test.ts'], testTimeout }),
      coverage: {
        provider: 'istanbul',
        // `.mjs` alongside `.ts`: src/ may hold dependency-free plain-JavaScript modules that a
        // plain-node script and the worker both import — the kit's own are the read-audit arming
        // vocabulary (src/framework/readAuditVocabulary.mjs), the AI model allowlist and region
        // rule (src/ai/policyVocabulary.mjs) and the agent's arming vocabulary
        // (src/ai/agentVocabulary.mjs), and a fork may add more. Leaving them out would
        // quietly move live logic out from under the coverage floors (the src/framework/** and
        // src/ai/** ones included) without any number changing.
        include: ['src/**/*.ts', 'src/**/*.mjs'],
        exclude: ['src/env.ts'],
        reporter: ['text-summary', 'html'],
        // Ratchet-only floors: raise as coverage grows, never lower. Global numbers sit a
        // few points under actual (lines ~86 / funcs ~89 / stmts ~85 / branch ~82) so a
        // small uncovered addition warns before it merges. The security core carries its
        // OWN, stricter per-directory floors — a security branch can no longer go untested
        // while the global aggregate stays green (the old branch:60 left ~40% of paths
        // unexercised). Per-glob thresholds are checked against each directory's aggregate.
        thresholds: {
          lines: 82,
          functions: 85,
          statements: 82,
          branches: 78,
          'src/framework/**': { lines: 88, functions: 85, statements: 88, branches: 88 },
          'src/auth/**': { lines: 90, functions: 95, statements: 88, branches: 75 },
          'src/security/**': { lines: 88, functions: 90, statements: 88, branches: 90 },
          // The AI client, its wire guard and tool-result masking (plan P1). The kit's own sit at
          // ~99 / 100 / 99 / 97; the floor leaves a fork's own src/ai modules room, like the others.
          'src/ai/**': { lines: 90, functions: 90, statements: 90, branches: 85 },
        },
      },
    },
  };
});
