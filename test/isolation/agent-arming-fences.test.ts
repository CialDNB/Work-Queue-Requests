// THE ARMING SEAMS, FENCED WHERE A FORK RUNS ITS CI (src/ai/agentArming.ts; privacy must-fix 14).
//
// Two names in agentArming.ts would turn a fail-closed check into a fork-satisfiable one if any
// module could reach them:
//
//   1. `registerDsrRoute`. Arming needs a route OBJECT the DSR module registered, by identity: a
//      stub at the DSR path, or a copy of the real definition, is not in the WeakSet. But the
//      WeakSet cannot tell who registered an object, so a stub that calls `registerDsrRoute(stub)`
//      itself would clear `dsr_route_missing` from any module. Only the DSR registrars may name
//      it: agentArming.ts, which defines it, and from P2-7 the kit's DSR module
//      (src/ai/dsrRoute.ts — P2-7 adds it to DSR_REGISTRARS below, in its own diff). A namespace
//      import, an `export *`, a `require` or a dynamic import of agentArming reaches it without
//      naming it, so outside the registrars the arming module may be named only the way the
//      kit's checkpoints (P2-8, P2-9) name it: in a named, default, type-only or side-effect
//      import, or a named re-export. Anywhere else it is refused, and so is a dynamic import or
//      `require` whose specifier is COMPUTED (a template with a substitution, or a string joined
//      with `+`) from a relative prefix that could reach src/ai, folded as esbuild folds a `+`
//      chain of literals: esbuild bundles every file such a pattern can match.
//   2. `armableEnvs`, the ladder test seam. A src/ caller passing it opens the rungs P2-9 and P2-11
//      have not, so only the two modules that DEFINE the option may name it.
//
// WHAT IS SCANNED: every JavaScript/TypeScript source in the repo (.jsx and .tsx, dot-files and
// dot-folders included), not just src/ and scripts/ — a worker module can live anywhere esbuild
// can reach from src/index.ts —
// except the UNSCANNED folders (dependencies, tests, build output, nested checkouts), which no
// scanned source may import from. The package.json, tsconfig/jsconfig and wrangler configs are
// read too, for the aliases esbuild resolves. HOW each file is read — every escape a literal or
// an identifier may hold, every quote, every alias — is the rule's header (agentArmingSeams.ts,
// beside this file, pure so plain node can run it over another checkout).
//
// A TRIPWIRE, NOT A PROOF. It reads text, it does not parse or bundle; every spelling it refuses is
// pinned on a fixture below, the evasive ones the pre-merge reviews bundled with esbuild 0.28
// included, and what made a reading slow is pinned on a timed ladder. What reaches the seam in a
// way no text scan sees — a dependency's own code (node_modules is not read), a build step or code
// generator, a resolution esbuild performs that the rule does not model — is not caught here, and
// where it lives in feature territory no review catches it either: .github/CODEOWNERS deliberately
// leaves src/routes/ and web/ un-owned, and package.json is not code-owned. That residual is open
// (DECISIONS 2026-10-04, item 4 and "What stays open"); it closes structurally only when there is
// no registration door to fence.
//
// WHY test/isolation/: like the uniformity tripwire and the agent-exposure pin beside it, this is a
// fence over the fork's OWN tree, so it must run where the fork's CI runs it and be reviewed like
// the core it guards. /kit-upgrade carries test/isolation into every fork (kit-upgrade SKILL.md
// step 3), and the folder is protected core: .github/CODEOWNERS routes it to the code owner and the
// warn-protected-core hook warns on an edit (pinned below). test/platform/edge-hardening.test.mjs
// is neither: /kit-upgrade does not carry it, so each fork runs the copy it bootstrapped with.
// The sources are read by Vite when it transforms this file (import.meta.glob with ?raw, made
// exhaustive), so the scan sees exactly the files on disk, a file added tomorrow included.
//
// WHAT IT DOES NOT COVER: a repo that edits this test, its rule, agentArming.ts or the DSR module.
// All four are protected core, so such an edit needs the code owner's review — and nothing undoes
// it after that: /kit-upgrade shows it as the fork's own hunk against the kit's copy, and a hunk
// the fork keeps stays.
/// <reference types="vite/types/import-meta.d.ts" />
import { describe, expect, it } from 'vitest';
import {
  type ArmingSeams,
  armingSeamFailures as seamFailures,
  UNSCANNED,
} from './agentArmingSeams';

/** The review-routing file that makes this folder protected core. */
const CODEOWNERS = import.meta.glob<string>('../../.github/CODEOWNER?', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// The sources, and the configs whose aliases esbuild (through wrangler) resolves, in ONE glob so
// both are read alike. It excludes exactly UNSCANNED (agentArmingSeams.ts), pinned below.
// `exhaustive`: without it Vite's glob skips every dot-file and dot-folder, so a stub at
// src/routes/.dsr/ (or a tsconfig beside it) would go unread while a scanned file imported it
// (P2-2 round-1 review P2). It also drops Vite's own node_modules ignore; the negation keeps it.
const FILES = import.meta.glob<string>(
  [
    '../../**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
    '../../**/package.json',
    '../../**/{tsconfig,jsconfig}*.json',
    '../../**/wrangler*.{json,jsonc}',
    '!../../**/node_modules/**',
    '!../../test/**',
    '!../../**/dist/**',
    '!../../coverage/**',
    '!../../.wrangler/**',
    '!../../.git/**',
    '!../../.claude/worktrees/**',
    '!../../.worktrees/**',
  ],
  { query: '?raw', import: 'default', eager: true, exhaustive: true },
);

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const repoRelative = (source: boolean): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(FILES)
      .filter(([path]) => SOURCE.test(path) === source)
      .map(([path, text]) => [path.replace(/^(?:\.\.\/)+/, ''), text]),
  );

/** Repo-relative path → source text. */
const TREE = repoRelative(true);
/** Repo-relative path → config text. */
const CONFIGS = repoRelative(false);

/** The only files that may register a DSR route. P2-7 adds 'src/ai/dsrRoute.ts'. */
const DSR_REGISTRARS: readonly string[] = ['src/ai/agentArming.ts'];

/** The only files that may name the ladder seam: the two that define the option. */
const LADDER_SEAM_OWNERS: readonly string[] = [
  'src/ai/agentArming.ts',
  'scripts/check-edge-hardening.mjs',
];

const SEAMS: ArmingSeams = { dsrRegistrars: DSR_REGISTRARS, ladderSeamOwners: LADDER_SEAM_OWNERS };

/** The rule, with this repo's allow-lists: every file that reaches a fenced seam, and why. */
function armingSeamFailures(
  tree: Readonly<Record<string, string>>,
  configs: Readonly<Record<string, string>> = {},
): string[] {
  return seamFailures(tree, configs, SEAMS);
}

describe('the arming seams are fenced (privacy must-fix 14)', () => {
  it('reads the real tree: every source in the repo, not only src/ and scripts/', () => {
    const files = Object.keys(TREE);
    expect(files.length).toBeGreaterThan(100);
    for (const rel of [...DSR_REGISTRARS, ...LADDER_SEAM_OWNERS, 'src/index.ts']) {
      expect(files, rel).toContain(rel);
    }
    // Outside src/ and scripts/ too: a worker module can live wherever src/index.ts reaches.
    expect(files).toContain('vitest.config.ts');
    expect(files).toContain('web/vite.config.ts');
    // …and in dot-folders, which the glob skips unless it is exhaustive (/kit-upgrade carries
    // .claude/ with this folder). The configs ride the same glob, so they are read there too.
    expect(files).toContain('.claude/hooks/warn-protected-core.mjs');
    // …but never a dependency, a test (its fixtures name the seams on purpose) or build output.
    expect(files.filter((rel) => /(?:^|\/)(?:node_modules|dist)\//.test(rel))).toEqual([]);
    expect(files.filter((rel) => rel.startsWith('test/'))).toEqual([]);
    expect(TREE['src/ai/agentArming.ts']).toMatch(/export function registerDsrRoute\b/);
    // The globs leave out exactly the folders the rule calls UNSCANNED (whose imports it refuses).
    for (const rel of [...files, ...Object.keys(CONFIGS)]) {
      for (const folder of UNSCANNED) {
        const inside = folder.startsWith('**/')
          ? rel.split('/').includes(folder.slice(3))
          : rel.startsWith(`${folder}/`);
        expect(inside, `${rel} is in ${folder}`).toBe(false);
      }
    }
    // …and the configs whose aliases esbuild resolves are read with them.
    expect(Object.keys(CONFIGS)).toEqual(
      expect.arrayContaining([
        'package.json',
        'tsconfig.json',
        'web/tsconfig.json',
        'wrangler.jsonc',
      ]),
    );
  });

  it('no module but a DSR registrar can reach registerDsrRoute, and none but the owners names armableEnvs', () => {
    expect(armingSeamFailures(TREE, CONFIGS)).toEqual([]);
  });

  it('is itself protected core: it lives in test/isolation/, which CODEOWNERS routes to an owner', () => {
    // An edit to DSR_REGISTRARS is an edit to the fence. It must reach the code owner, not merge
    // as an ordinary test change (.claude/hooks/warn-protected-core.test.mjs holds the hook's
    // list to CODEOWNERS, so the warn hook covers what CODEOWNERS routes).
    expect(new URL(import.meta.url).pathname).toMatch(
      /\/test\/isolation\/agent-arming-fences\.test\.ts$/,
    );
    const owners = CODEOWNERS['../../.github/CODEOWNERS'];
    expect(owners, '.github/CODEOWNERS').toBeTypeOf('string');
    expect(owners).toMatch(/^\/test\/isolation\/\s+@\S+/m);
  });

  describe('the rule itself, on fixtures', () => {
    const STUB = 'src/routes/agentDsrStub.ts';
    /** The timed ladders' budget per run: the scan is synchronous, so no test timeout can stop it. */
    const BUDGET_MS = 250;
    const time = (text: string) => {
      const started = performance.now();
      armingSeamFailures({ 'src/routes/x.cjs': text });
      return performance.now() - started;
    };

    it('refuses a fork module that registers its own stub as the DSR route', () => {
      const tree = {
        [STUB]: [
          "import { registerDsrRoute } from '../ai/agentArming';",
          "const stub = defineRoute({ method: 'GET', path: '/api/agent/dsr' /* … */ });",
          'registerDsrRoute(stub);',
        ].join('\n'),
      };
      expect(armingSeamFailures(tree)).toEqual([`${STUB} names registerDsrRoute`]);
    });

    it('refuses every way of reaching it without naming it', () => {
      const cases: [string, string][] = [
        ["import * as arming from '../ai/agentArming';", 'imports agentArming as a namespace'],
        ['import*as arming from "../ai/agentArming.ts";', 'imports agentArming as a namespace'],
        ["export * from '../ai/agentArming';", 're-exports all of agentArming'],
        ["export * as arming from './agentArming.js';", 're-exports all of agentArming'],
        ["const m = await import('../ai/agentArming');", 'imports agentArming dynamically'],
        ['const m = await import(`../ai/agentArming`);', 'imports agentArming dynamically'],
        ["const m = require('../ai/agentArming.cjs');", 'requires agentArming'],
      ];
      for (const [text, says] of cases) {
        expect(armingSeamFailures({ [STUB]: text }), text).toEqual([`${STUB} ${says}`]);
      }
    });

    it('refuses the evasive spellings: comments between tokens, escapes, a default beside *', () => {
      // A backslash built at run time, so this file holds no escape the tools around it decode.
      const u = `${String.fromCharCode(92)}u`;
      const x = `${String.fromCharCode(92)}x`;
      const cases: [string, string][] = [
        ["import /* x */ * as a from '../ai/agentArming';", 'imports agentArming as a namespace'],
        [
          'import * /* x */ as a // x\n from "../ai/agentArming";',
          'imports agentArming as a namespace',
        ],
        ["import d, * as ns from '../ai/agentArming';", 'imports agentArming as a namespace'],
        ["export /* x */ * from '../ai/agentArming';", 're-exports all of agentArming'],
        ["const m = await import(/* x */ '../ai/agentArming');", 'imports agentArming dynamically'],
        ["const m = require( // x\n '../ai/agentArming');", 'requires agentArming'],
        [`import { registerDsr${u}0052oute } from '../ai/agentArming';`, 'names registerDsrRoute'],
        [`import { registerDsr${u}{52}oute as r } from '../ai/x';`, 'names registerDsrRoute'],
        [`import * as a from '../ai/${u}0061gentArming';`, 'imports agentArming as a namespace'],
        [`const m = await import('../ai/agent${x}41rming');`, 'imports agentArming dynamically'],
      ];
      for (const [text, says] of cases) {
        expect(armingSeamFailures({ [STUB]: text }), text).toEqual([`${STUB} ${says}`]);
      }
      expect(armingSeamFailures({ [STUB]: `run({ armable${u}0045nvs: ['staging'] });` })).toEqual([
        `${STUB} names the ladder seam armableEnvs`,
      ]);
    });

    it('refuses a computed specifier whose static prefix can reach src/ai, wherever the file is', () => {
      // The fixtures are plain strings, so a template substitution in them is written `#{`.
      const reach = (rel: string, text: string) =>
        armingSeamFailures({ [rel]: text.replaceAll('#{', `\${`) });
      const refused: [string, string, string][] = [
        ['src/routes/x.ts', "await import(`../ai/agent#{'Arming'}.ts`);", '../ai/agent'],
        ['src/routes/x.ts', "await import('../ai/' + name);", '../ai/'],
        ['src/routes/x.ts', 'await import(`../#{dir}/agentArming.ts`);', '../'],
        ['src/x.ts', "require('./' /* x */ + name);", './'],
        ['lib/dsrStub.jsx', 'await import(`../src/#{rest}`);', '../src/'],
        ['scripts/x.mjs', 'await import(`../../#{up}`);', '../../'],
      ];
      for (const [rel, text, prefix] of refused) {
        const kind = text.includes('require') ? 'requires' : 'imports';
        const says =
          kind === 'requires' ? 'requires agentArming' : 'imports agentArming dynamically';
        expect(reach(rel, text), `${rel}: ${text}`).toEqual([
          `${rel} ${says} through a computed specifier ${JSON.stringify(prefix)}`,
        ]);
      }
      // A prefix that cannot reach src/ai, a literal elsewhere, and what esbuild leaves to run
      // time — an expression, a prefix that is not relative (the shapes Insights' and arena-go's
      // node scripts use) — are not this fence's business.
      const allowed: [string, string][] = [
        ['src/i18n/load.ts', 'await import(`./locales/#{lang}.json`);'],
        ['src/routes/x.ts', "await import('./views/' + name);"],
        ['src/routes/x.ts', "await import('../data/notes');"],
        ['src/routes/x.ts', 'await import(specifier);'],
        ['src/routes/x.ts', 'await import(`#{base}/agentArming.ts`);'],
        ['src/routes/x.ts', "await import('@/ai/' + name);"],
        ['scripts/askfit/behaviour.mjs', 'await import(`#{PW}/index.mjs`);'],
        ['scripts/check-routing.mjs', 'await import(`file:///#{join(root, harness)}`);'],
        ['scripts/yield.mjs', 'import(`data:text/javascript;base64,#{code}`);'],
      ];
      for (const [rel, text] of allowed) {
        expect(reach(rel, text), `${rel}: ${text}`).toEqual([]);
      }
    });

    it('refuses every spelling a JavaScript string allows: identity escapes, continuations, octal', () => {
      // The 2026-10-21 re-review's probes, each clean under `biome check` and bundled by esbuild
      // 0.28 into a call to registerDsrRoute. A backslash built at run time, as above.
      const b = String.fromCharCode(92);
      const ls = String.fromCharCode(0x2028);
      const cases: [string, string, string][] = [
        [
          STUB,
          `import { 'registerDsr${b}Route' as register } from '../ai/agentArming';\nregister(stub);`,
          'names registerDsrRoute',
        ],
        [
          STUB,
          `import { "registerDsr${b}\nRoute" as r } from '../ai/agentArming';`,
          'names registerDsrRoute',
        ],
        [
          STUB,
          `import { 'registerDsr${b}122oute' as r } from '../ai/x';`,
          'names registerDsrRoute',
        ],
        [
          STUB,
          `import * as arming from '../ai/agent${b}Arming';\nObject.entries(arming).find(([k]) => k.startsWith('registerDsr'));`,
          'imports agentArming as a namespace',
        ],
        [
          STUB,
          `import * as a from '../ai/agent${b}\nArming';`,
          'imports agentArming as a namespace',
        ],
        [
          STUB,
          `import * as a from '../ai/agent${b}\r\nArming';`,
          'imports agentArming as a namespace',
        ],
        [
          STUB,
          `import * as a from '..${b}/ai/agentArming.t${b}s';`,
          'imports agentArming as a namespace',
        ],
        [
          'src/routes/legacy.cjs',
          `const m = require('../ai/agent${b}101rming');`,
          'requires agentArming',
        ],
        // A line comment ends at any line terminator, CR and LS included, not only at LF.
        [
          STUB,
          `import * as a //${ls}from '../ai/agentArming';`,
          'imports agentArming as a namespace',
        ],
        [STUB, "import * as a //\rfrom '../ai/agentArming';", 'imports agentArming as a namespace'],
        // A backtick in JSX text opens no template: a reader that took it for one, and read on
        // from there, would skip the import between the two (every quote is read, so none hides).
        [
          'src/routes/view.tsx',
          "const t = <p>`</p>;\nimport * as a from '../ai/agentArming';\nconst u = <p>`</p>;",
          'imports agentArming as a namespace',
        ],
        // A legacy HTML comment, which esbuild honours in a .cjs file.
        [
          'src/routes/legacy.cjs',
          "const m = require(<!-- import { a } from\n'../ai/agentArming');",
          'requires agentArming',
        ],
      ];
      for (const [rel, text, says] of cases) {
        expect(armingSeamFailures({ [rel]: text }), text).toEqual([`${rel} ${says}`]);
      }
    });

    it('refuses the arming module wherever esbuild takes it from: parentheses, branches, folds', () => {
      const elsewhere = 'names agentArming other than in a named import';
      const cases: [string, string][] = [
        ["const m = await import(('../ai/agentArming'));", 'imports agentArming dynamically'],
        ["const m = require(('../ai/agentArming'));", 'requires agentArming'],
        ["const m = (require)('../ai/agentArming');", 'requires agentArming'],
        ["import m = require('../ai/agentArming');", 'requires agentArming'],
        [
          "const m = await import('../ai/agentArming', { with: {} });",
          'imports agentArming dynamically',
        ],
        ["const m = await import(c ? '../ai/agentArming' : './other');", elsewhere],
        ["const m = await import('' || '../ai/agentArming');", elsewhere],
        ["const m = await import(null ?? '../ai/agentArming');", elsewhere],
        ["const m = await import(1 && '../ai/agentArming');", elsewhere],
        ["const p = '../ai/agentArming' + suffix;", elsewhere],
        // A named-import clause faked inside a line comment does not make the next literal one,
        // nor does a `from` inside one (`export { a }` then a bare string: valid, and refused).
        ["const m = await import(c ? // import { a } from\n'../ai/agentArming' : x);", elsewhere],
        ["export { a } // from\n'../ai/agentArming';", elsewhere],
        ["const m = await import /* */ (c ? /* */ '../ai/agentArming' : y);", elsewhere],
        // Not JavaScript: it pins that an allowed clause's block comment ends at its first `*/`.
        ["import /* a */ (x) /* b */ y from '../ai/agentArming';", elsewhere],
        // Paths only the specifier itself can show: absolute, or through a link, any case, a query.
        ["import * as m from '/app/src/ai/AgentArming.ts';", 'imports agentArming as a namespace'],
        ["import * as m from './linked/agentArming?raw';", 'imports agentArming as a namespace'],
        ["import * as m from '../ai/agentArming?raw';", 'imports agentArming as a namespace'],
        ["import * as m from '../ai/AgentArming';", 'imports agentArming as a namespace'],
        ["import * as m from '../ai/./agentArming';", 'imports agentArming as a namespace'],
      ];
      for (const [text, says] of cases) {
        expect(armingSeamFailures({ [STUB]: text }), text).toEqual([`${STUB} ${says}`]);
      }
      // A computed specifier, parenthesized or in a branch esbuild resolves on its own.
      const computed: [string, string][] = [
        ["const m = await import(('../ai/') + n);", 'imports agentArming dynamically'],
        ["const m = (require)('../ai/' + n);", 'requires agentArming'],
      ];
      for (const [text, says] of computed) {
        expect(armingSeamFailures({ [STUB]: text }), text).toEqual([
          `${STUB} ${says} through a computed specifier "../ai/"`,
        ]);
      }
      const branched = [
        "const m = await import(c ? `../ai/#{n}` : './other');",
        "const m = await import('' || '../ai/' + n);",
        "const m = require(c ? './x' : ('../ai/' + n));",
      ];
      for (const text of branched) {
        expect(armingSeamFailures({ [STUB]: text.replaceAll('#{', `\${`) }), text).toEqual([
          `${STUB} computes a specifier from "../ai/" in a branch esbuild resolves, which can reach src/ai`,
        ]);
      }
    });

    it('reads a + chain of literals as the one string esbuild folds it into, TypeScript and an escaped require included', () => {
      // The 2026-10-22 round-2 review's probes and the shapes beside them, each bundled by esbuild
      // 0.28.1 (wrangler's options) into a call to registerDsrRoute, the rule having judged only a
      // chain's FIRST literal, and a call only by its plain spelling. A backslash built at run
      // time, as above.
      const b = String.fromCharCode(92);
      const computed = (prefix: string, kind = 'imports agentArming dynamically') =>
        `${STUB} ${kind} through a computed specifier ${JSON.stringify(prefix)}`;
      const dynamic = `${STUB} imports agentArming dynamically`;
      const cases: [string, string][] = [
        // esbuild folds the literals before it globs: the prefix is `./../ai/`, not `./`…
        ["await import('./' + '../ai/' + n);", computed('./../ai/')],
        ["await import(('./' + '../ai/') + n);", computed('./../ai/')],
        ["await import('./' + ('../ai/' + n));", computed('./../ai/')],
        ["await import('./' + '../ai/' + 'x'.slice(1) + n);", computed('./../ai/')],
        // …and a chain of nothing but literals is ONE specifier, which no literal of it names.
        ["await import('./' + '../ai/agentArm' + 'ing');", dynamic],
        ['await import(`./` + "../ai/agentArm" + `ing`);', dynamic],
        ["await import(('./') + ('../ai/') + ('agentArming'));", dynamic],
        // `require` is an identifier, so any escape spells it; TypeScript may give it type arguments.
        [`const m = r${b}u0065quire('../ai/' + n);`, computed('../ai/', 'requires agentArming')],
        [
          `const m = r${b}u{65}quire('./' + '../ai/agentArm' + 'ing');`,
          `${STUB} requires agentArming`,
        ],
        ["const m = require<any>('../ai/' + n);", computed('../ai/', 'requires agentArming')],
        // TypeScript esbuild strips before it folds: an assertion, a cast, a non-null mark.
        ["await import('./' + '../ai/agentArm' + ('ing' as string));", dynamic],
        ["await import(('./' + '../ai/agentArm' as string) + 'ing');", dynamic],
        ["await import('./' + '../ai/agentArm' + ('ing' satisfies string));", dynamic],
        ["await import(('./' + '../ai/agentArm')! + 'ing');", dynamic],
        ["await import('./' + '../ai/agentArm' + ('ing' as 'ing'));", dynamic],
        ["await import(('./' + '../ai/agentArm' as string | number) + 'ing');", dynamic],
        ["await import(<string>'./' + '../ai/' + n);", computed('./../ai/')],
        ["await import('../ai/' as string + n);", computed('../ai/')],
        // …in a branch, and anywhere else.
        [
          "await import(c ? './' + '../ai/' + n : x);",
          `${STUB} computes a specifier from "./../ai/" in a branch esbuild resolves, which can reach src/ai`,
        ],
        [
          "const p = '../ai/agentArm' + 'ing';",
          `${STUB} names agentArming other than in a named import`,
        ],
      ];
      for (const [text, says] of cases) {
        expect(armingSeamFailures({ [STUB]: text }), text).toEqual([says]);
      }
      // A chain that cannot reach src/ai passes, folded or not.
      for (const text of [
        "await import('./views/' + 'list' + '.ts');",
        "await import('./' + 'views/' + name);",
        "await import('./' + '../data/' + 'notes');",
        "const label = 'agent' + 'Arming';",
        "const m = require('./' + 'x') + '../ai/' + n;",
      ]) {
        expect(armingSeamFailures({ [STUB]: text }), text).toEqual([]);
      }
    });

    it('reads every extension esbuild rewrites to .ts: a .jsx specifier names agentArming.ts', () => {
      // esbuild 0.28.1 resolves a missing `.jsx` to the `.ts` beside it (round-1 review P3).
      const cases: [string, string][] = [
        ["import * as a from '../ai/agentArming.jsx';", 'imports agentArming as a namespace'],
        ["export * from '../ai/agentArming.jsx';", 're-exports all of agentArming'],
        ["const m = await import('../ai/agentArming.jsx');", 'imports agentArming dynamically'],
        ["const m = require('../ai/agentArming.jsx');", 'requires agentArming'],
        [
          "const m = await import(c ? '../ai/agentArming.jsx' : y);",
          'names agentArming other than in a named import',
        ],
      ];
      for (const [text, says] of cases) {
        expect(armingSeamFailures({ [STUB]: text }), text).toEqual([`${STUB} ${says}`]);
      }
      // …through an alias whose target is spelled .jsx, too.
      const aliases: [Record<string, string>, string][] = [
        [
          { 'package.json': JSON.stringify({ imports: { '#arm': './src/ai/agentArming.jsx' } }) },
          '#arm',
        ],
        [
          {
            'tsconfig.json': '{ "compilerOptions": { "paths": { "@ai/*": ["./src/ai/*.jsx"] } } }',
          },
          '@ai/agentArming',
        ],
      ];
      for (const [configs, spec] of aliases) {
        expect(
          armingSeamFailures({ [STUB]: `import * as a from '${spec}';` }, configs),
          spec,
        ).toEqual([`${STUB} imports agentArming as a namespace`]);
      }
      // The same rewrite reaches the root vitest config, which nothing may import.
      expect(armingSeamFailures({ [STUB]: "import c from '../../vitest.config.jsx';" })).toEqual([
        `${STUB} imports "../../vitest.config.jsx", test tooling that may import what this fence does not scan`,
      ]);
      // The kit's own shape, a named import, still passes however it is spelled.
      expect(
        armingSeamFailures({ [STUB]: "import { agentArming } from '../ai/agentArming.jsx';" }),
      ).toEqual([]);
    });

    it("follows the aliases esbuild resolves: package.json imports, exports, browser and a directory's entry, tsconfig paths through extends, wrangler alias", () => {
      const namespace = `${STUB} imports agentArming as a namespace`;
      const cases: [Record<string, string>, string][] = [
        [
          { 'package.json': JSON.stringify({ imports: { '#arm': './src/ai/agentArming.ts' } }) },
          '#arm',
        ],
        [
          { 'package.json': JSON.stringify({ imports: { '#a/*': './src/ai/agent*.ts' } }) },
          '#a/Arming',
        ],
        [
          {
            'package.json': JSON.stringify({
              name: 'app',
              exports: { './arm': './src/ai/agentArming.ts' },
            }),
          },
          'app/arm',
        ],
        [
          {
            'package.json': JSON.stringify({
              browser: { './src/routes/fake.ts': './src/ai/agentArming.ts' },
            }),
          },
          './fake',
        ],
        [
          {
            'tsconfig.json':
              '{\n  // a comment, as tsconfig allows\n  "compilerOptions": { "paths": { "#t": ["./src/ai/agentArming.ts"] }, },\n}',
          },
          '#t',
        ],
        [
          {
            'lib/tsconfig.json':
              '{ "compilerOptions": { "baseUrl": "..", "paths": { "@x/*": ["src/ai/*"] } } }',
          },
          '@x/agentArming',
        ],
        [{ 'wrangler.jsonc': '{ "alias": { "arm": "./src/ai/agentArming.ts" } }' }, 'arm'],
        [
          {
            'wrangler.staging.jsonc':
              '{ "env": { "x": { "alias": { "arm": "./src/ai/agentArming.ts" } } } }',
          },
          'arm',
        ],
        [{ 'tsconfig.json': '{ "compilerOptions": { "baseUrl": "." } }' }, 'src/ai/agentArming'],
        [
          {
            'package.json': `${String.fromCharCode(0xfeff)}{ "imports": { "#arm": "./src/ai/agentArming.ts" } }`,
          },
          '#arm',
        ],
        // A directory's own package.json entry: importing the directory resolves to it (esbuild's
        // browser, module and main fields, for wrangler's default platform). Round-2 review R4.
        [
          { 'src/routes/armdir/package.json': JSON.stringify({ main: '../../ai/agentArming.ts' }) },
          './armdir',
        ],
        [
          { 'src/routes/armdir/package.json': JSON.stringify({ module: '../../ai/agentArming' }) },
          './armdir/',
        ],
        [
          {
            'src/routes/armdir/package.json': JSON.stringify({
              browser: '../../ai/agentArming.ts',
            }),
          },
          './armdir',
        ],
        // A tsconfig's paths resolve against the baseUrl it extends, and an extended paths against
        // the extending config's own baseUrl (round-2 review R4).
        [
          {
            'tsconfig.json':
              '{ "extends": "./tsconfig.base.json", "compilerOptions": { "paths": { "@arm": ["ai/agentArming.ts"] } } }',
            'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": "./src" } }',
          },
          '@arm',
        ],
        [
          {
            'lib/tsconfig.json':
              '{ "extends": "../tsconfig.base", "compilerOptions": { "baseUrl": "../src/ai" } }',
            'tsconfig.base.json':
              '{ "compilerOptions": { "paths": { "@arm": ["agentArming.ts"] } } }',
          },
          '@arm',
        ],
      ];
      for (const [configs, spec] of cases) {
        expect(
          armingSeamFailures({ [STUB]: `import * as a from '${spec}';` }, configs),
          `${spec} via ${Object.keys(configs)[0]}`,
        ).toEqual([namespace]);
        // A named import through the same alias is the kit's own shape, and passes.
        expect(
          armingSeamFailures({ [STUB]: `import { agentArming } from '${spec}';` }, configs),
        ).toEqual([]);
      }
    });

    it('fails closed on a tsconfig that extends a config it does not read', () => {
      // The glob reads tsconfig*.json and jsconfig*.json; a base named anything else, which esbuild
      // follows, would hide its paths (round-2 review R4).
      expect(
        armingSeamFailures({}, { 'src/routes/sub/tsconfig.json': '{ "extends": "./base.json" }' }),
      ).toEqual([
        'src/routes/sub/tsconfig.json extends "./base.json", which this fence does not read, so its aliases are unknown',
      ]);
      expect(
        armingSeamFailures(
          {},
          {
            'tsconfig.json': '{ "extends": ["./tsconfig.base.json", "./test/tsconfig.json"] }',
            'tsconfig.base.json': '{}',
          },
        ),
      ).toEqual([
        'tsconfig.json extends "./test/tsconfig.json", in a folder this fence does not scan, so its aliases are unknown',
      ]);
      // A config it reads (status-admin's public/tsconfig.json extends ../tsconfig.json), or a
      // package's (a dependency's own config, which is not read, like its code), passes.
      expect(
        armingSeamFailures(
          {},
          { 'web/tsconfig.json': '{ "extends": "../tsconfig.json" }', 'tsconfig.json': '{}' },
        ),
      ).toEqual([]);
      expect(
        armingSeamFailures(
          {},
          { 'tsconfig.json': '{ "extends": "@tsconfig/strictest/tsconfig.json" }' },
        ),
      ).toEqual([]);
    });

    it('refuses a module that imports from a folder the fence does not scan', () => {
      // A stub under test/ (never scanned: its fixtures name the seams on purpose) that src/routes
      // imports by name would otherwise carry registerDsrRoute past the fence.
      const cases: [string, string][] = [
        ["import { r } from '../../test/zz/stub';", '../../test/zz/stub'],
        ["const { r } = await import('../../test/zz/stub');", '../../test/zz/stub'],
        ["export { r } from '../../coverage/x';", '../../coverage/x'],
        ["import { r } from '../../.claude/worktrees/w/src/x';", '../../.claude/worktrees/w/src/x'],
        ["import { r } from '../../.worktrees/feat/src/x';", '../../.worktrees/feat/src/x'],
      ];
      for (const [text, spec] of cases) {
        expect(armingSeamFailures({ [STUB]: text }), text).toEqual([
          `${STUB} imports "${spec}", from a folder this fence does not scan`,
        ]);
      }
      // A trailing comment that holds a `+` joins nothing: a loose reading of it did, called the
      // specifier computed, and let these imports pass (round-1 review P1).
      for (const text of [
        "import '../../test/zz/stub' // + a note",
        "import { r } from '../../test/zz/stub' // a + b\nr();",
        "export { r } from '../../test/zz/stub' /* a */ // b + c",
      ]) {
        expect(armingSeamFailures({ [STUB]: text }), text).toEqual([
          `${STUB} imports "../../test/zz/stub", from a folder this fence does not scan`,
        ]);
      }
      const globbed = 'const m = await import(`../../test/#{x}`);'.replaceAll('#{', `\${`);
      expect(armingSeamFailures({ [STUB]: globbed })).toEqual([
        `${STUB} computes a specifier from "../../test/", which can reach a folder this fence does not scan`,
      ]);
      const pkg = { 'package.json': JSON.stringify({ imports: { '#stub': './test/zz/stub.ts' } }) };
      expect(armingSeamFailures({ [STUB]: "import { r } from '#stub';" }, pkg)).toEqual([
        `${STUB} imports "#stub", from a folder this fence does not scan`,
      ]);
      const entry = {
        'src/routes/stubdir/package.json': JSON.stringify({ main: '../../../test/zz/stub.ts' }),
      };
      expect(armingSeamFailures({ [STUB]: "import { r } from './stubdir';" }, entry)).toEqual([
        `${STUB} imports "./stubdir", from a folder this fence does not scan`,
      ]);
      const linked = {
        'package.json': JSON.stringify({ dependencies: { stub: 'file:./test/zz' } }),
      };
      expect(armingSeamFailures({}, linked)).toEqual([
        'package.json links the dependency "stub" from a folder this fence does not scan',
      ]);
      const workspace = { 'package.json': JSON.stringify({ workspaces: ['test/*'] }) };
      expect(armingSeamFailures({}, workspace)).toEqual([
        'package.json makes "test/*" a workspace, from a folder this fence does not scan',
      ]);
      // A config it cannot read leaves its aliases unknown: that fails closed.
      expect(armingSeamFailures({}, { 'tsconfig.json': '{ "compilerOptions": ' })).toEqual([
        'tsconfig.json cannot be read as JSON (with comments), so its aliases are unknown',
      ]);
      // Reading a test fixture by path is not an import, and passes.
      expect(
        armingSeamFailures({ 'scripts/x.mjs': "readFileSync('../test/fixtures/a.json');" }),
      ).toEqual([]);
      // The root vitest config sets up the test run in node and may import test/ (Insights' does),
      // so nothing else may import it.
      expect(
        armingSeamFailures({ 'vitest.config.ts': "import { files } from './test/projects.mjs';" }),
      ).toEqual([]);
      expect(armingSeamFailures({ [STUB]: "import config from '../../vitest.config';" })).toEqual([
        `${STUB} imports "../../vitest.config", test tooling that may import what this fence does not scan`,
      ]);
    });

    it('reads every comment one way, so no input makes it backtrack: slashes and comment runs finish at once', () => {
      // A loose reading (a line comment that could end anywhere, a block comment that could run on
      // to a later one) split such runs exponentially many ways, and the scan is synchronous, so no
      // test timeout could stop it: an 80-slash separator line hung the fence (round-1 review P1).
      // Each size is timed before the next, larger one runs, so a regression fails here, fast.
      const shapes: [string, (n: number) => string][] = [
        [
          'a slash separator after a quoted comment',
          (n) =>
            `import { a } from './a';\n// Billing ('invoices' and 'credits')\n${'/'.repeat(n)}\nexport const b = a;\n`,
        ],
        ['slashes after import', (n) => `import ${'/'.repeat(n)}\nconst x = 1;`],
        ['slashes after export', (n) => `export ${'/'.repeat(n)}\nconst x = 1;`],
        ['slashes after a branch', (n) => `const v = c ? ${'/'.repeat(n)}\nx;`],
        ['block comments after import', (n) => `import ${'/**/ '.repeat(n)}x;`],
        ['line and block openers mixed', (n) => `import ${'// /* '.repeat(n)}\nx;`],
        ['HTML openers in a call', (n) => `require(${'<!--'.repeat(n)}\nx);`],
      ];
      for (const [shape, text] of shapes) {
        for (const n of [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 64, 80, 120, 200]) {
          expect(time(text(n)), `${shape}, ${n}`).toBeLessThan(BUDGET_MS);
        }
      }
      // And random mixes of the tokens a gap holds, from a fixed seed (mulberry32).
      let seed = 262;
      const random = (below: number) => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
      };
      const tokens = ['/', '//', '/*', '*/', '*', ' ', '\n', '\r', '<!--', '-->', "'a'", '+'];
      const heads = ['import ', 'export ', 'require(', 'x ? ', "f('a') "];
      for (let i = 0; i < 400; i += 1) {
        let text = heads[random(heads.length)] ?? '';
        for (let k = 30 + random(170); k > 0; k -= 1) text += tokens[random(tokens.length)];
        expect(time(text), JSON.stringify(text)).toBeLessThan(BUDGET_MS);
      }
    });

    it('reads each string once: a long string of escaped quotes (inline SVG, JSON.parse data) finishes at once', () => {
      // A literal read from every quote, escaped ones included, ran from each `\"` to the string's
      // end and kept every value it cooked: a 60 KB JSON.parse module ran a 4 GB heap out and
      // took the test worker down (round-2 review R1). Timed size by size, as above, to ~100 KB.
      const b = String.fromCharCode(92);
      const q = `${b}"`;
      const shapes: [string, (n: number) => string, number][] = [
        ['escaped quotes', (n) => `export const S = '${`${b}'`.repeat(n)}';`, 65_536],
        [
          'JSON.parse data',
          (n) =>
            `export const DATA = JSON.parse("[${Array.from({ length: n }, (_, i) => `{${q}code${q}:${q}${1000 + i}${q}}`).join(',')}]");`,
          8192,
        ],
        [
          'an inline SVG',
          (n) =>
            `export const HERO_SVG = "<svg xmlns=${q}http://www.w3.org/2000/svg${q}>${`<path d=${q}M0 0L9 9${q} fill=${q}#0a0${q}/>`.repeat(n)}</svg>";`,
          4096,
        ],
      ];
      for (const [shape, text, most] of shapes) {
        for (let n = 64; n <= most; n *= 2) {
          expect(time(text(n)), `${shape}, ${n}`).toBeLessThan(BUDGET_MS);
        }
        expect(armingSeamFailures({ 'web/src/data.ts': text(most) }), shape).toEqual([]);
      }
    });

    it('reads each gap, name and line once: comment-opener runs, minified lines, URLs and continuations finish at once', () => {
      // No reading backtracked exponentially any more, but some re-read: a line comment to its
      // line's end (or an unclosed block comment to the file's) from every literal end, branch or
      // keyword that reached it; a name that could swallow an HTML comment opener, so a name and
      // the gap after it split at every one (cubic in `import x<!--…, * as y<!--…`); the line
      // walked back for every allowed import; a continuation run read again from each backslash
      // in it (round-2 review R2). Timed size by size, as above, to hundreds of KB.
      const b = String.fromCharCode(92);
      const shapes: [string, (n: number) => string][] = [
        [
          'HTML openers around a namespace',
          (n) => `import x${'<!--'.repeat(n)}\n, * as y${'<!--'.repeat(n)}\n;`,
        ],
        ['HTML comment pairs after import', (n) => `import ${'<!---->'.repeat(n)}`],
        ['HTML closers after import', (n) => `import ${'-->'.repeat(n)}`],
        ['a minified line of imports', (n) => ';import{a}from"b"'.repeat(n)],
        ['dynamic imports on one line', (n) => "import('a')".repeat(n)],
        ['literals before line comments', (n) => "'a'//".repeat(n)],
        [
          'protocol-relative URLs on one line',
          (n) =>
            `export const U = [${Array.from({ length: n }, (_, i) => `'//cdn.example.com/${i}.js'`).join(',')}];`,
        ],
        ['a run of line continuations', (n) => `const s = '${`${b}\n`.repeat(n)}';`],
        ['unclosed block comments after branches', (n) => '?/*'.repeat(n)],
        ['unclosed block comments after import', (n) => 'import/*'.repeat(n)],
        [
          'imports inside one block comment',
          (n) => `${'import /* '.repeat(n)}*/ //${'x'.repeat(n)}`,
        ],
        // The `+` chains (above) are read once too: a long one, and a run of string types.
        ['a long + chain in a call', (n) => `import(${Array(n).fill("'./a'").join(' + ')});`],
        ['string types after as', (n) => `const t = 'a'${" as 'b'".repeat(n)};`],
      ];
      for (const [shape, text] of shapes) {
        for (let n = 250; n <= 16_000; n *= 2) {
          expect(time(text(n)), `${shape}, ${n}`).toBeLessThan(BUDGET_MS);
        }
      }
      // …and a name stops where a gap can start, so a name and the gap after it split one way and
      // a clause reads as the RegExp it replaced read it. (Not a module esbuild takes: it refuses
      // HTML comments there. It pins the reading.)
      for (const text of [
        "import x-->\n, * as y from '../ai/agentArming';",
        "import x\n--> c\n, * as y from '../ai/agentArming';",
      ]) {
        expect(armingSeamFailures({ 'src/routes/legacy.cjs': text }), text).toEqual([
          'src/routes/legacy.cjs imports agentArming as a namespace',
        ]);
      }
    });

    it('applies wherever the file lives and whatever its extension, dot-folders included', () => {
      for (const rel of [
        'lib/dsrStub.ts',
        'src/routes/dsr.jsx',
        'shared/arming.mjs',
        'src/routes/.dsr/stub.ts',
        '.hidden/stub.mjs',
      ]) {
        const text = "import { registerDsrRoute } from '../src/ai/agentArming';";
        expect(armingSeamFailures({ [rel]: text })).toEqual([`${rel} names registerDsrRoute`]);
      }
    });

    it('allows what the kit itself does: the registrar, named imports, type-only imports', () => {
      const tree = {
        'src/ai/agentArming.ts': 'export function registerDsrRoute(route: RouteDef): void {}',
        'src/ai/routes.ts': "import { agentArming, kvReaperProbe } from './agentArming';",
        'src/ai/agentWorkflow.ts': "import type * as Arming from './agentArming';",
        'src/routes/myAgentArmingNotes.ts': "import * as notes from './myagentArmingNotes';",
        // The other forms that bind no namespace: default, side-effect, a named or type-only re-export.
        'src/ai/a.ts': "import arming from './agentArming';",
        'src/ai/b.ts': "import /* side effects */ './agentArming';",
        'src/ai/c.ts': "export { agentArming as arm } from './agentArming';",
        'src/ai/d.ts': "export type * from './agentArming';",
        'src/ai/e.ts': "import type { AgentArming } from './agentArming';",
        // A line comment that ends at LS, inside a real clause.
        'src/ai/f.ts': `import { agentArming } //${String.fromCharCode(0x2028)}from './agentArming';`,
      };
      expect(armingSeamFailures(tree)).toEqual([]);
    });

    it('refuses the ladder seam outside the two modules that define it', () => {
      const tree = {
        'src/ai/routes.ts': "agentArming(env, routes, probes, { armableEnvs: ['staging'] });",
        'scripts/check-edge-hardening.mjs':
          'export function checkAgentArming(root, { armableEnvs }) {}',
        'src/ai/agentArming.ts': 'readonly armableEnvs?: readonly string[];',
      };
      expect(armingSeamFailures(tree)).toEqual([
        'src/ai/routes.ts names the ladder seam armableEnvs',
      ]);
    });
  });
});
