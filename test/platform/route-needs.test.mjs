// Pins scripts/kit-checks/check-route-needs.mjs — the route least-privilege coverage report.
//
// Run by `node --test` (it imports node:fs, not the Workers pool), so it's a *.test.mjs picked
// up by `test:scripts`, like its siblings.
//
// Three things are load-bearing here, and the FIRST one is the whole reason this check shipped
// as a report:
//
//   1. IT CANNOT RED A FORK. Without `--gate` the command exits 0 at any coverage, including
//      0%. ~268 defineRoutes across ~17 forks declare no `needs`; a check that could fail would
//      break every one of them on their next /kit-upgrade.
//   2. IT DOES NOT MISCOUNT. A `needs` in a comment, in a string, or nested inside `input:`
//      must NOT read as a declaration — a false "declared" inflates the very ratio the
//      graduation threshold is measured against, which would graduate the gate on a lie.
//   3. THE FLIP IS ALREADY WIRED. `--gate` is exercised in both directions here, so graduating
//      is a package.json edit rather than new code written under time pressure.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { maskNoise } from '../../scripts/kit-checks/check-core-reachability.mjs';
import {
  NEEDS_COVERAGE_GRADUATION_PCT,
  objectLiteralKeys,
  overDeclared,
  report,
  routeNeeds,
} from '../../scripts/kit-checks/check-route-needs.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'kit-checks', 'check-route-needs.mjs');

const DATA_INDEX = `import { widgetsRepo } from './widgets';
import { usersRepo } from './users';
export function makeDb(env: Env) {
  return { widgets: widgetsRepo(env.DB), users: usersRepo(env.DB) };
}
`;

function withFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'route-needs-'));
  try {
    for (const [rel, text] of Object.entries({ 'src/data/index.ts': DATA_INDEX, ...files })) {
      if (text === null) continue;
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One route file holding exactly the specs given, in the shape src/routes/ actually writes. */
function routeFile(...specs) {
  return `import { defineRoute } from '../framework/defineRoute';
export const widgetsRoutes = [
${specs.map((s) => `  defineRoute(${s}),`).join('\n')}
];
`;
}

// ---------------------------------------------------------------------------------------

describe('the real kit tree', () => {
  const scan = routeNeeds(REPO);

  it('finds every defineRoute the reachability gate finds', () => {
    // check-core-reachability counts `defineRoute(` in src/routes/ independently. The two
    // numbers are allowed to differ only by routes defined outside src/routes/ (this scan is
    // wider), never by a route one of them cannot read.
    assert.equal(scan.unreadable.length, 0, JSON.stringify(scan.unreadable));
    assert.ok(scan.total >= 20, `only found ${scan.total} routes`);
  });

  it('counts the golden example as declared and the rest as not', () => {
    const notes = scan.declared.filter((r) => r.file === 'src/routes/notes.ts');
    assert.equal(notes.length, 5, 'the golden example declares `needs` on all five routes');
    for (const r of notes) assert.deepEqual(r.needs, ['notes']);
    assert.ok(
      scan.undeclared.some((r) => r.file === 'src/routes/users.ts'),
      'src/routes/users.ts declares no `needs` today and must be named',
    );
  });

  it('names each undeclared route by file, line, method and path', () => {
    for (const r of scan.undeclared) {
      assert.match(r.file, /^src\/.*\.tsx?$/);
      assert.ok(r.line > 0);
      assert.match(r.method, /^(GET|POST|PUT|PATCH|DELETE)$/, `${r.file}:${r.line} ${r.method}`);
      assert.match(r.path, /^\/api\//, `${r.file}:${r.line} ${r.path}`);
    }
  });

  it('suggests the repositories each undeclared route actually reaches', () => {
    const audit = scan.undeclared.find((r) => r.path === '/api/audit');
    assert.deepEqual(audit.reaches, ['audit']);
    const me = scan.undeclared.find((r) => r.path === '/api/me');
    assert.deepEqual(me.reaches, [], '/api/me touches no repository — `needs: []` is its answer');
  });

  it('the golden example declares nothing it does not use', () => {
    assert.deepEqual(overDeclared(scan), []);
  });

  it('reports the coverage ratio it is graduated against', () => {
    const { text } = report(REPO);
    assert.match(text, /declare `needs`/);
    assert.match(text, new RegExp(`hard gate at ${NEEDS_COVERAGE_GRADUATION_PCT}%`));
    assert.equal(scan.percent, Math.round((scan.declared.length / scan.total) * 100));
  });
});

describe('it cannot red a fork — the property the whole design rests on', () => {
  it('report() never fails without --gate, even at 0% coverage', () => {
    withFixture({ 'src/routes/w.ts': routeFile("{ method: 'GET', path: '/api/w' }") }, (dir) => {
      const { failed, scan } = report(dir);
      assert.equal(scan.percent, 0);
      assert.equal(failed, false);
    });
  });

  it('the CLI exits 0 on the real repo, which is nowhere near the threshold', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.match(out, /REPORT ONLY, never fails the build/);
  });

  it('a route-less repo is vacuously covered rather than a failure', () => {
    withFixture({ 'src/index.ts': 'export default {};\n' }, (dir) => {
      const scan = routeNeeds(dir);
      assert.equal(scan.total, 0);
      assert.equal(scan.percent, 100);
      assert.equal(report(dir, { gate: true }).failed, false);
    });
  });
});

describe('the flip — --gate, already implemented so graduating is a package.json edit', () => {
  it('fails below the threshold and passes at or above it', () => {
    withFixture(
      {
        'src/routes/w.ts': routeFile(
          "{ method: 'GET', path: '/api/a', needs: ['widgets'], handler: async (ctx) => ctx.db.widgets.list() }",
          "{ method: 'GET', path: '/api/b' }",
        ),
      },
      (dir) => {
        assert.equal(routeNeeds(dir).percent, 50);
        assert.equal(report(dir, { gate: true, threshold: 80 }).failed, true);
        assert.equal(report(dir, { gate: true, threshold: 50 }).failed, false);
      },
    );
  });

  it('the CLI honours --gate and its threshold override', () => {
    const run = (args) => {
      try {
        execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
        return 0;
      } catch (err) {
        return err.status;
      }
    };
    assert.equal(run(['--gate']), 1, 'the real repo is below the graduation threshold today');
    assert.equal(run(['--gate=0']), 0);
    assert.equal(run([]), 0, 'the default invocation — the one CI runs — must never fail');
  });
});

describe('it does not miscount — a false "declared" would graduate the gate on a lie', () => {
  const scanOne = (spec) =>
    withFixture({ 'src/routes/w.ts': routeFile(spec) }, (dir) => routeNeeds(dir));

  it('a `needs` in a comment is not a declaration', () => {
    const scan = scanOne("{ method: 'GET', path: '/api/w' /* needs: ['widgets'] */ }");
    assert.equal(scan.declared.length, 0);
    assert.equal(scan.undeclared.length, 1);
  });

  it('a `needs` in a string is not a declaration', () => {
    const scan = scanOne("{ method: 'GET', path: '/api/w', summary: 'needs: widgets' }");
    assert.equal(scan.declared.length, 0);
  });

  it('a `needs` nested inside another key is not a declaration', () => {
    const scan = scanOne(
      "{ method: 'GET', path: '/api/w', input: z.object({ needs: z.string() }) }",
    );
    assert.equal(scan.declared.length, 0, 'input.needs is not RouteSpec.needs');
    assert.equal(scan.undeclared.length, 1);
  });

  it('a `needs` inside the handler body is not a declaration', () => {
    const scan = scanOne(
      "{ method: 'GET', path: '/api/w', handler: async () => ({ needs: 'nothing' }) }",
    );
    assert.equal(scan.declared.length, 0);
  });

  it('an empty `needs: []` IS a declaration — the route named its (empty) reach', () => {
    const scan = scanOne("{ method: 'GET', path: '/api/w', needs: [] }");
    assert.equal(scan.declared.length, 1);
    assert.deepEqual(scan.declared[0].needs, []);
  });

  it('a non-literal `needs` counts as declared, with members unread', () => {
    const scan = scanOne("{ method: 'GET', path: '/api/w', needs: WIDGETS_ONLY }");
    assert.equal(scan.declared.length, 1);
    assert.equal(scan.declared[0].needs, null, 'resolving a const is a type checker’s job');
  });

  it('an unreadable defineRoute is counted neither way', () => {
    withFixture(
      {
        'src/routes/w.ts': `import { defineRoute } from '../framework/defineRoute';
const spec = { method: 'GET', path: '/api/w' };
export const widgetsRoutes = [defineRoute(spec)];
`,
      },
      (dir) => {
        const scan = routeNeeds(dir);
        assert.equal(scan.total, 0);
        assert.equal(scan.unreadable.length, 1);
        assert.match(scan.unreadable[0].detail, /not an object literal/);
        assert.match(report(dir).text, /UNREADABLE \(1\)/);
      },
    );
  });
});

describe('objectLiteralKeys — members only, never a ternary arm', () => {
  it('reads the keys of a route spec at depth 1 only', () => {
    const src = "({ method: 'GET', path: '/api/w', input: z.object({ needs: z.string() }) })";
    const masked = maskNoise(src);
    const { keys } = objectLiteralKeys(masked, masked.indexOf('{'));
    assert.deepEqual(
      keys.map((k) => k.name),
      ['method', 'path', 'input'],
    );
  });

  it('does not read the middle of a ternary as a key', () => {
    const src = "({ audit: ok ? needs : other, method: 'GET' })";
    const masked = maskNoise(src);
    const { keys } = objectLiteralKeys(masked, masked.indexOf('{'));
    assert.deepEqual(
      keys.map((k) => k.name),
      ['audit', 'method'],
    );
  });

  it('returns null rather than guessing when the braces never balance', () => {
    const src = "({ method: 'GET', path: '/api/w'";
    const masked = maskNoise(src);
    assert.equal(objectLiteralKeys(masked, masked.indexOf('{')), null);
  });
});

describe('the suggestion — actionable, and never a guess', () => {
  it('names the repositories the spec body reaches', () => {
    withFixture(
      {
        'src/routes/w.ts': routeFile(
          "{ method: 'GET', path: '/api/w', handler: async (ctx) => { await ctx.db.widgets.list(); return ctx.db.users.get('a'); } }",
        ),
      },
      (dir) => {
        assert.deepEqual(routeNeeds(dir).undeclared[0].reaches, ['users', 'widgets']);
        assert.match(report(dir).text, /add `needs: \['users', 'widgets'\]`/);
      },
    );
  });

  it('a name that is not a repository in this app is not suggested', () => {
    withFixture(
      {
        'src/routes/w.ts': routeFile(
          "{ method: 'GET', path: '/api/w', handler: async (ctx) => ctx.db.prepare('SELECT 1') }",
        ),
      },
      (dir) => {
        assert.deepEqual(routeNeeds(dir).undeclared[0].reaches, []);
      },
    );
  });

  it('REGRESSION: a destructured ctx still reports the repositories it reaches', () => {
    // A dot-anchored `\.db\.` pattern reads `async ({ db }) => db.widgets.list()` as touching
    // no repository, and the report then says `add \`needs: []\`` — advice that breaks the
    // route the moment someone takes it. The one wrong answer this scan can give.
    withFixture(
      {
        'src/routes/w.ts': routeFile(
          "{ method: 'GET', path: '/api/w', handler: async ({ db }) => db.widgets.list() }",
        ),
      },
      (dir) => {
        assert.deepEqual(routeNeeds(dir).undeclared[0].reaches, ['widgets']);
      },
    );
  });

  it('a uniformityFixture seeds against the whole Db and never contributes to `needs`', () => {
    // `seed(db: Db)` is typed against the full data layer on purpose — it is the tripwire's
    // fixture, not the handler. Counting it would ask the route to declare reach it does not
    // have at request time, and its bare `db` parameter would mark every `:param` route opaque.
    withFixture(
      {
        'src/routes/w.ts': routeFile(
          "{ method: 'GET', path: '/api/w/:id', " +
            'uniformityFixture: { seed: async (db) => { await db.users.add({}); return { id: (await db.widgets.create()).id }; } }, ' +
            'handler: async (ctx) => ctx.db.widgets.get() }',
        ),
      },
      (dir) => {
        const route = routeNeeds(dir).undeclared[0];
        assert.deepEqual(
          route.reaches,
          ['widgets'],
          'the fixture’s users access is not the handler’s',
        );
        assert.equal(route.opaqueDb, false, 'the fixture’s bare `db` parameter is not opaque use');
      },
    );
  });

  it('an opaque ctx.db use suppresses the suggestion instead of guessing wrong', () => {
    withFixture(
      {
        'src/routes/w.ts': routeFile(
          "{ method: 'GET', path: '/api/w', handler: async (ctx) => { const { widgets } = ctx.db; return widgets.list(); } }",
        ),
      },
      (dir) => {
        assert.equal(routeNeeds(dir).undeclared[0].opaqueDb, true);
        assert.match(report(dir).text, /reaches ctx\.db opaquely/);
      },
    );
  });

  it('over-declaration is a printed hint, never a failure', () => {
    withFixture(
      {
        'src/routes/w.ts': routeFile(
          "{ method: 'GET', path: '/api/w', needs: ['widgets', 'users'], handler: async (ctx) => ctx.db.widgets.list() }",
        ),
      },
      (dir) => {
        const { text, failed, scan } = report(dir, { gate: true, threshold: 0 });
        assert.deepEqual(overDeclared(scan)[0].unused, ['users']);
        assert.match(text, /DECLARED BUT UNUSED \(1\)/);
        assert.equal(failed, false);
      },
    );
  });

  it('a route whose db use is opaque is never called over-declared', () => {
    withFixture(
      {
        'src/routes/w.ts': routeFile(
          "{ method: 'GET', path: '/api/w', needs: ['widgets'], handler: async (ctx) => pass(ctx.db) }",
        ),
      },
      (dir) => {
        assert.deepEqual(overDeclared(routeNeeds(dir)), []);
      },
    );
  });
});

describe('routes outside src/routes/ are still counted', () => {
  it('a defineRoute anywhere under src/ is in scope', () => {
    withFixture({ 'src/features/w.ts': routeFile("{ method: 'GET', path: '/api/w' }") }, (dir) => {
      const scan = routeNeeds(dir);
      assert.equal(scan.total, 1);
      assert.equal(scan.undeclared[0].file, 'src/features/w.ts');
    });
  });

  it('a missing src/data/index.ts degrades the suggestion, not the count', () => {
    withFixture(
      {
        'src/data/index.ts': null,
        'src/routes/w.ts': routeFile(
          "{ method: 'GET', path: '/api/w', handler: async (ctx) => ctx.db.gadgets.list() }",
        ),
      },
      (dir) => {
        const scan = routeNeeds(dir);
        assert.equal(scan.total, 1);
        assert.deepEqual(scan.undeclared[0].reaches, ['gadgets']);
      },
    );
  });
});
