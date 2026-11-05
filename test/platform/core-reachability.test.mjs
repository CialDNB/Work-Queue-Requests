// Pins scripts/kit-checks/check-core-reachability.mjs — the protected-core reachability gate and its
// size thermometer. Run by `node --test` (it imports node:fs, not the Workers pool), so it's a
// *.test.mjs picked up by `test:scripts`, like its siblings.
//
// Two halves, and BOTH are load-bearing:
//
//   1. the real tree passes — the gate is honest about the code it ships with
//   2. the gate CATCHES injected drift — a guard that passes everything is hollow
//
// The masker gets the most attention here, and it earned it. Its first two cuts each produced
// a runaway that blanked the rest of a file, and the second one reported a live method
// (magicLinksRepo.claim) as DEAD — a false red on a hard gate, the exact failure mode that
// would have broken 17 forks on /kit-upgrade. Both triggers are pinned below.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CORE_SIZE_CEILING_LINES,
  calledMethods,
  coreSizes,
  dataReachability,
  isMainModule,
  maskNoise,
  registeredRouteSymbols,
  repoMethods,
  report,
  routeRegistration,
} from '../../scripts/kit-checks/check-core-reachability.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// These fixtures are ABOUT template interpolation, and a literal `${` written inside a quoted
// string is exactly what biome's noTemplateCurlyInString exists to catch — so the sequence is
// assembled rather than typed. Lint stays clean without weakening the rule or the fixture.
const OPEN = '${';

// ---------------------------------------------------------------------------------------
// A throwaway "repo" with the minimum shape both checks read.
// ---------------------------------------------------------------------------------------

const DEFAULT_REPO_FILE = `export function widgetsRepo(db: D1Database) {
  return {
    async get(id: string) {
      return db.prepare('SELECT 1').first();
    },
    async list() {
      return db.prepare('SELECT 2').all();
    },
  };
}
`;

const DEFAULT_DATA_INDEX = `import { widgetsRepo } from './widgets';
export function makeDb(env: Env) {
  return { widgets: widgetsRepo(env.DB) };
}
`;

const DEFAULT_ROUTE_FILE = `import { defineRoute } from '../framework/defineRoute';
export const widgetsRoutes = [defineRoute({ method: 'GET', path: '/api/widgets' })];
`;

const DEFAULT_ROUTE_INDEX = `import type { RouteDef } from '../framework/defineRoute';
import { widgetsRoutes } from './widgets';
export const allRoutes: readonly RouteDef[] = [...widgetsRoutes];
`;

function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reachability-'));
  const files = {
    'src/data/widgets.ts': DEFAULT_REPO_FILE,
    'src/data/index.ts': DEFAULT_DATA_INDEX,
    'src/routes/widgets.ts': DEFAULT_ROUTE_FILE,
    'src/routes/index.ts': DEFAULT_ROUTE_INDEX,
    // A caller for every default declaration, so the baseline fixture is clean.
    'src/routes/use.ts': `export async function useThem(ctx) {
  await ctx.db.widgets.get('a');
  await ctx.db.widgets.list();
  return makeDb;
}
`,
    ...overrides,
  };
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function withFixture(overrides, fn) {
  const dir = fixture(overrides);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------

describe('maskNoise — offsets survive, code survives, noise does not', () => {
  it('never changes length and never eats a newline', () => {
    for (const rel of ['src/auth/magicLink.ts', 'src/routes/users.ts', 'src/data/tokens.ts']) {
      const raw = readFileSync(join(REPO, rel), 'utf8');
      const masked = maskNoise(raw);
      assert.equal(masked.length, raw.length, `${rel}: length changed`);
      assert.equal(masked.split('\n').length, raw.split('\n').length, `${rel}: line count changed`);
    }
  });

  it('blanks line comments, block comments and string contents', () => {
    const masked = maskNoise(`const a = 'secret'; // db.x.dead()\n/* db.x.alsoDead() */ b.c();\n`);
    assert.ok(!masked.includes('secret'));
    assert.ok(!masked.includes('dead'));
    assert.ok(masked.includes('b.c();'));
  });

  it('REGRESSION: a closing backtick closes the template — it does not open a new one', () => {
    // First cut tested the opening-backtick case before template text, so every closing
    // backtick pushed instead of popping and the rest of the file vanished.
    const masked = maskNoise('const a = `plain`;\nctx.db.widgets.get(id);\n');
    assert.ok(masked.includes('ctx.db.widgets.get(id);'), masked);
  });

  it('REGRESSION: an interpolated URL does not open a phantom line comment', () => {
    // Second cut tested comments before template text. `//` in an interpolated URL ate the
    // closing backtick, the runaway blanked the rest of src/auth/magicLink.ts, and
    // magicLinksRepo.claim — called on line 135 — was reported DEAD.
    const masked = maskNoise(
      `const link = \`https://${OPEN}env.HOST}/auth/verify?token=${OPEN}t}\`;\nawait db.magicLinks.claim(h);\n`,
    );
    assert.ok(masked.includes('await db.magicLinks.claim(h);'), masked);
  });

  it('keeps calls written inside an interpolation', () => {
    const masked = maskNoise(`const s = \`n=${OPEN}ctx.db.widgets.list()}\`;\n`);
    assert.ok(masked.includes('ctx.db.widgets.list()'), masked);
  });

  it('a JSX closing tag does not open a phantom regex', () => {
    const masked = maskNoise('return <div>{x}</div>;\nctx.db.widgets.get(id);\n');
    assert.ok(masked.includes('ctx.db.widgets.get(id);'), masked);
  });

  it('the real kit tree survives masking — src/auth/magicLink.ts keeps its repo call', () => {
    const masked = maskNoise(readFileSync(join(REPO, 'src/auth/magicLink.ts'), 'utf8'));
    assert.ok(masked.includes('db.magicLinks.claim('), 'masking swallowed a real call site');
  });
});

describe('repoMethods — depth-1 members only', () => {
  it('reads the kit repo shape', () => {
    const masked = maskNoise(readFileSync(join(REPO, 'src/data/notes.ts'), 'utf8'));
    const start = masked.indexOf('export function notesRepo');
    assert.deepEqual(repoMethods(masked, start), ['create', 'get', 'list', 'update', 'remove']);
  });

  it('does not invent methods from nested objects or inline arrows', () => {
    const src = `export function xRepo(db) {
  return {
    async get(id) {
      const opts = { nested: 1, deeper: { alsoNested: 2 } };
      const fn = (a) => a;
      return [1, 2].map(fn);
    },
    plain: async () => 1,
  };
}`;
    assert.deepEqual(repoMethods(maskNoise(src), 0), ['get', 'plain']);
  });

  it('returns null rather than guessing when there is no readable object literal', () => {
    const src = 'export function xRepo(db) {\n  return buildRepo(db);\n}';
    assert.equal(repoMethods(maskNoise(src), 0), null);
  });
});

describe('calledMethods — every call shape the kit actually writes', () => {
  const opts = { key: 'widgets', factory: 'widgetsRepo', selfFile: false };

  it('direct member chain', () => {
    assert.ok(calledMethods('await ctx.db.widgets.list(o);', opts).has('list'));
  });

  it('local bound to the repo key (src/ai/budget.ts shape)', () => {
    const t = 'const repo = makeDb(env).widgets;\nawait repo.tryReserve(a, b);';
    assert.ok(calledMethods(t, opts).has('tryReserve'));
  });

  it('local bound to the factory (test/data/audit.test.ts shape)', () => {
    const t = 'const repo = widgetsRepo(env.DB);\nawait repo.listByAction("login", 10);';
    assert.ok(calledMethods(t, opts).has('listByAction'));
  });

  it('destructured off the repo', () => {
    assert.ok(calledMethods('const { list } = db.widgets;\nawait list();', opts).has('list'));
  });

  it('`this.` self-call, but only inside the repo file (src/data/notes.ts shape)', () => {
    const t = 'const existing = await this.get(id);';
    assert.ok(calledMethods(t, { ...opts, selfFile: true }).has('get'));
    assert.ok(!calledMethods(t, opts).has('get'));
  });

  it('a same-named method on an unrelated object is not a call on this repo', () => {
    assert.ok(!calledMethods('await ctx.db.gadgets.list();', opts).has('list'));
  });
});

describe('route registration — the gate', () => {
  it('the real tree registers every route module', () => {
    const { findings, modules, declared } = routeRegistration(REPO);
    assert.deepEqual(findings, []);
    assert.ok(modules.length >= 8, `only found ${modules.length} route modules`);
    assert.ok(declared >= 16, `only found ${declared} declared routes`);
  });

  it('scans the kit-owned route modules in src/auth/ too — the service-identity admin is one', () => {
    const { modules } = routeRegistration(REPO);
    const kit = modules.find((m) => m.file === 'src/auth/serviceIdentityRoutes.ts');
    assert.ok(kit, 'src/auth/serviceIdentityRoutes.ts was not scanned');
    assert.deepEqual(kit.wired, ['serviceIdentityRoutes']);
  });

  it('CATCHES a kit-owned route module in src/auth/ that the fork never registered', () => {
    withFixture(
      {
        'src/auth/kitRoutes.ts': `import { defineRoute } from '../framework/defineRoute';
export const kitAdminRoutes = [defineRoute({ method: 'GET', path: '/api/kit-admin' })];
`,
      },
      (dir) => {
        const { findings } = routeRegistration(dir);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].file, 'src/auth/kitRoutes.ts');
        assert.match(findings[0].detail, /allRoutes/);
      },
    );
  });

  it('the `readonly RouteDef[]` type annotation does not defeat the array scan', () => {
    const symbols = registeredRouteSymbols(REPO);
    for (const name of ['meRoutes', 'notesRoutes', 'usersRoutes', 'createMetaRoutes']) {
      assert.ok(symbols.has(name), `allRoutes scan missed ${name}`);
    }
  });

  it('CATCHES a route module that never reaches allRoutes', () => {
    withFixture(
      {
        'src/routes/orphan.ts': `import { defineRoute } from '../framework/defineRoute';
export const orphanRoutes = [defineRoute({ method: 'GET', path: '/api/orphan' })];
`,
      },
      (dir) => {
        const { findings } = routeRegistration(dir);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].file, 'src/routes/orphan.ts');
        assert.match(findings[0].detail, /allRoutes/);
      },
    );
  });

  it('CATCHES a route module that exports nothing at all', () => {
    withFixture(
      {
        'src/routes/orphan.ts': `import { defineRoute } from '../framework/defineRoute';
const orphanRoutes = [defineRoute({ method: 'GET', path: '/api/orphan' })];
`,
      },
      (dir) => {
        const { findings } = routeRegistration(dir);
        assert.equal(findings.length, 1);
        assert.match(findings[0].detail, /exports nothing/);
      },
    );
  });

  it('FAILS LOUD when the registry itself is unreadable', () => {
    withFixture({ 'src/routes/index.ts': 'export const routes = [];\n' }, (dir) => {
      const { findings } = routeRegistration(dir);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].file, 'src/routes/index.ts');
    });
  });
});

describe('data-layer reachability — the gate', () => {
  it('the real tree has no dead declarations', () => {
    const { dead, unparsed } = dataReachability(REPO);
    assert.deepEqual(
      dead.map((d) => `${d.file}:${d.line} ${d.label}`),
      [],
    );
    assert.deepEqual(unparsed, []);
  });

  it('src/data/groups.ts is exempt by declared intent, not by accident', () => {
    const { exempt } = dataReachability(REPO);
    const labels = exempt.filter((d) => d.file === 'src/data/groups.ts').map((d) => d.label);
    assert.ok(labels.includes('groupsRepo.create'), 'the groups exemption stopped applying');
    for (const d of exempt) assert.ok(d.exempt.length > 0, 'an exemption carries no reason');
  });

  it('CATCHES a repo method nothing calls', () => {
    withFixture(
      {
        'src/data/widgets.ts': DEFAULT_REPO_FILE.replace(
          '  };',
          "    async orphaned(id: string) {\n      return db.prepare('SELECT 3').run();\n    },\n  };",
        ),
      },
      (dir) => {
        const { dead } = dataReachability(dir);
        assert.deepEqual(
          dead.map((d) => d.label),
          ['widgetsRepo.orphaned'],
        );
      },
    );
  });

  it('CATCHES a plain export nothing references', () => {
    withFixture({ 'src/data/consts.ts': 'export const UNUSED_CAP = 5;\n' }, (dir) => {
      const { dead } = dataReachability(dir);
      assert.deepEqual(
        dead.map((d) => d.label),
        ['UNUSED_CAP'],
      );
    });
  });

  it('a caller in test/ keeps a method out of DEAD, but reports it as test-only', () => {
    withFixture(
      {
        'src/data/widgets.ts': DEFAULT_REPO_FILE.replace(
          '  };',
          "    async testedOnly(id: string) {\n      return db.prepare('SELECT 3').run();\n    },\n  };",
        ),
        'test/widgets.test.ts': 'await db.widgets.testedOnly("a");\n',
      },
      (dir) => {
        const { dead, testOnly } = dataReachability(dir);
        assert.deepEqual(dead, []);
        assert.deepEqual(
          testOnly.map((d) => d.label),
          ['widgetsRepo.testedOnly'],
        );
      },
    );
  });

  it('an `@reachability-exempt:` marker WITH a reason exempts; without one it does not', () => {
    const withReason = DEFAULT_REPO_FILE.replace(
      'export function widgetsRepo',
      '// @reachability-exempt: scaffolding\nexport function widgetsRepo',
    ).replace(
      '  };',
      "    async orphaned(id: string) {\n      return db.prepare('SELECT 3').run();\n    },\n  };",
    );
    withFixture({ 'src/data/widgets.ts': withReason }, (dir) => {
      const { dead, exempt } = dataReachability(dir);
      assert.deepEqual(dead, []);
      assert.ok(exempt.some((d) => d.label === 'widgetsRepo.orphaned'));
    });

    const bareMarker = withReason.replace(
      '// @reachability-exempt: scaffolding',
      '// @reachability-exempt:',
    );
    withFixture({ 'src/data/widgets.ts': bareMarker }, (dir) => {
      const { dead } = dataReachability(dir);
      assert.deepEqual(
        dead.map((d) => d.label),
        ['widgetsRepo.orphaned'],
        'a reasonless marker must not exempt anything',
      );
    });
  });

  it('a marker does NOT leak across a blank line to the next declaration', () => {
    // The window is the CONTIGUOUS comment block above the declaration. A fixed N-line window
    // would let a marker written for one method silently exempt the one after it.
    const detached = DEFAULT_REPO_FILE.replace(
      'export function widgetsRepo',
      '// @reachability-exempt: belongs to nothing\n\nexport function widgetsRepo',
    ).replace(
      '  };',
      "    async orphaned(id: string) {\n      return db.prepare('SELECT 3').run();\n    },\n  };",
    );
    withFixture({ 'src/data/widgets.ts': detached }, (dir) => {
      const { dead, exempt } = dataReachability(dir);
      assert.deepEqual(
        dead.map((d) => d.label),
        ['widgetsRepo.orphaned'],
      );
      assert.deepEqual(exempt, []);
    });
  });

  it('a factory whose shape it cannot read is reported, never silently skipped', () => {
    withFixture(
      { 'src/data/widgets.ts': 'export function widgetsRepo(db) {\n  return build(db);\n}\n' },
      (dir) => {
        const { unparsed } = dataReachability(dir);
        assert.deepEqual(
          unparsed.map((u) => u.factory),
          ['widgetsRepo'],
        );
      },
    );
  });
});

describe('size — a thermometer, never a gate', () => {
  it('the shipped ceiling is at or above the tree it ships with', () => {
    // A ceiling below some file's current length is exactly what would red a fork's CI on
    // /kit-upgrade. It cannot be true here even at the moment it is set.
    const { files } = coreSizes(REPO);
    assert.ok(files.length > 0, 'measured no protected-core files');
    assert.ok(
      files[0].lines <= CORE_SIZE_CEILING_LINES,
      `ceiling ${CORE_SIZE_CEILING_LINES} is below the current largest file ` +
        `(${files[0].file}, ${files[0].lines} lines)`,
    );
  });

  it('a file over the ceiling is REPORTED and does not fail the run', () => {
    const dir = fixture({ 'src/data/huge.ts': `${'// filler\n'.repeat(2000)}` });
    try {
      const { over } = coreSizes(dir, 900);
      assert.deepEqual(
        over.map((f) => f.file),
        ['src/data/huge.ts'],
      );
      const { text, failed } = report(dir);
      assert.equal(failed, false, 'an oversized file must never fail the build');
      assert.match(text, /OVER/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('report — the exit code', () => {
  it('the real tree passes', () => {
    const { failed } = report(REPO);
    assert.equal(failed, false);
  });

  it('an unregistered route module fails the run', () => {
    withFixture(
      {
        'src/routes/orphan.ts': `import { defineRoute } from '../framework/defineRoute';
export const orphanRoutes = [defineRoute({ method: 'GET', path: '/api/orphan' })];
`,
      },
      (dir) => assert.equal(report(dir).failed, true),
    );
  });
});

describe('isMainModule (duplicated from scripts/kit-checks/main-module.mjs on purpose)', () => {
  it('throws on a non-URL argument rather than silently disabling the gate', () => {
    assert.throws(() => isMainModule('/some/path.mjs'), TypeError);
  });

  it('answers false for a module that is not the entry point', () => {
    assert.equal(
      isMainModule(
        pathToFileURL(join(REPO, 'scripts/kit-checks/check-core-reachability.mjs')).href,
      ),
      false,
    );
  });

  it('answers true for the entry point', () => {
    assert.equal(isMainModule(pathToFileURL(process.argv[1]).href), true);
  });

  it('still RUNS when invoked through a symlinked path (the fail-open trap)', () => {
    // The naive `import.meta.url === pathToFileURL(argv[1]).href` answers false whenever an
    // ancestor is a symlink — os.tmpdir() on macOS is one — and the gate then exits 0 having
    // checked nothing. For a verification gate that is the worst possible failure, so it is
    // pinned by actually running the CLI through such a path.
    const dir = mkdtempSync(join(tmpdir(), 'reachability-link-'));
    try {
      const link = join(dir, 'kit');
      symlinkSync(REPO, link);
      const out = execFileSync(
        process.execPath,
        [join(link, 'scripts/kit-checks/check-core-reachability.mjs')],
        {
          encoding: 'utf8',
        },
      );
      assert.match(out, /protected core/, 'the CLI produced no output — it silently no-opped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
