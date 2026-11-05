// Pins scripts/test-runtime-boundary.mjs, the import check test-projects.test.mjs runs over every
// file the runtime manifests list. Each case names the exact violations it expects, so one rule
// that also fires cannot hide another that stopped working (#257 review F18). The guard is a
// tripwire for an accidental move, not a proof: the owner's review of test/projects.mjs is the
// control. Run by `node --test` (test:scripts).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { minimalRuntimeViolations } from '../../scripts/test-runtime-boundary.mjs';

const ENTRY = 'test/example.test.ts';
const at = (file) => (message) => `${file}: ${message}`;
const entry = at(ENTRY);

function check(files, runtime = 'workers') {
  return minimalRuntimeViolations(ENTRY, {
    runtime,
    readSource: (file) => {
      assert.ok(file in files, `unexpected read ${file}`);
      return files[file];
    },
    exists: (file) => file in files,
  });
}

// The entry's source, beside stand-ins for the application files a case reaches.
const withApp = (source) => ({
  [ENTRY]: source,
  'src/index.ts': '',
  'src/routes/notes.ts': '',
  'test/helpers/http.ts': '',
});

test('binding fixtures and type-only full-app imports need no application entrypoint', () => {
  assert.deepEqual(
    check({
      [ENTRY]:
        "import { env as bindings, fetchMock } from 'cloudflare:test'; import type { Env } from '../src/index'; import { type Principal } from '../src/routes/types'; import '../src/data/query'; import sql from '../schema.sql?raw'; void bindings.DB; void fetchMock;",
      'src/data/query.ts': 'export const query = 1;',
    }),
    [],
  );
});

test('each rule reports its own violation, and only it', () => {
  const app = 'full application entrypoint, route or HTTP fixture';
  const named = 'cloudflare:test must use explicit named imports';
  const commonJs = 'CommonJS runtime imports cannot be audited statically';
  for (const [source, expected] of [
    ["import '../src/index';", [at('src/index.ts')(app)]],
    ["import '../src/routes/notes';", [at('src/routes/notes.ts')(app)]],
    ["import './helpers/http';", [at('test/helpers/http.ts')(app)]],
    [
      "import { env } from 'cloudflare:test'; env.INGEST_WORKFLOW.create();",
      [entry('full-runtime identifier INGEST_WORKFLOW')],
    ],
    [
      "import { env } from 'cloudflare:test'; env['INGEST_WORKFLOW'].create();",
      [entry('full-runtime identifier INGEST_WORKFLOW')],
    ],
    [
      "import { WorkflowEntrypoint } from 'cloudflare:workers';",
      [entry('full-runtime identifier WorkflowEntrypoint')],
    ],
    ["import 'cloudflare:workflows';", [entry('Workflow runtime import')]],
    [
      "import { SELF } from 'cloudflare:test';",
      [entry('full-runtime cloudflare:test import SELF'), entry('full-runtime identifier SELF')],
    ],
    [
      "import { runInDurableObject } from 'cloudflare:test';",
      [entry('full-runtime cloudflare:test import runInDurableObject')],
    ],
    // A namespace or default import could reach any binding, and only this rule sees a computed
    // one: `t['SE' + 'LF']` names no identifier the other rules match.
    ["import * as t from 'cloudflare:test'; t['SE' + 'LF'].fetch('/');", [entry(named)]],
    ["import runtime from 'cloudflare:test'; void runtime;", [entry(named)]],
    ["import 'cloudflare:test';", [entry(named)]],
    ["export * from 'cloudflare:test';", [entry(named)]],
    [
      "import * as runtime from 'cloudflare:test'; runtime.SELF.fetch('/');",
      [entry(named), entry('full-runtime identifier SELF')],
    ],
    [
      "import('cloudflare:test');",
      [entry('dynamic cloudflare:test import must use explicit named imports')],
    ],
    [
      "const target = './helpers/http'; import(target);",
      [entry('dynamic import cannot be audited statically')],
    ],
    ["import { target } from './missing';", [entry('unresolved runtime import ./missing')]],
    ["require('../src/index');", [entry(commonJs)]],
    ["import app = require('../src/index');", [entry(commonJs)]],
    [
      "import { createRequire as load } from 'node:module';",
      [entry(commonJs), entry('unaudited runtime import node:module')],
    ],
    [
      "import { builtinModules } from 'node:module';",
      [entry('unaudited runtime import node:module')],
    ],
    ["import '@/src/index';", [entry('unaudited runtime import @/src/index')]],
  ])
    assert.deepEqual(check(withApp(source)), expected, source);
});

test('import.meta.glob is followed only as raw text, in both runtimes (#291 review F10)', () => {
  // Vite expands a glob into imports the walker never sees, so a glob that loads modules is
  // refused. The house pattern (test/helpers/db.ts) reads files as text, which runs nothing.
  const glob = entry('import.meta.glob that loads modules cannot be audited statically');
  for (const [source, expected] of [
    ["import.meta.glob('../src/routes/*.ts', { eager: true });", [glob]],
    ["import.meta.glob('../src/routes/*.ts');", [glob]],
    ["import.meta.glob('../src/routes/*.ts', { query: '?url', eager: true });", [glob]],
    ["const options = { query: '?raw' }; import.meta.glob('../src/*.ts', options);", [glob]],
    ["import.meta.glob(['../src/a.ts', '../src/b.ts'], { import: 'default' });", [glob]],
    [
      "import.meta.glob<string>('../migrations/d1/*.sql', { query: '?raw', import: 'default', eager: true });",
      [],
    ],
    ["import.meta.glob('../docs/*.md', { as: 'raw', eager: true });", []],
  ])
    for (const runtime of ['workers', 'node'])
      assert.deepEqual(check(withApp(source), runtime), expected, `${source} (${runtime})`);
});

test('multiline aliases and transitive re-exports cannot hide SELF', () => {
  const target = at('test/helpers/target.ts');
  assert.deepEqual(
    check({
      [ENTRY]: "import { request } from './helpers/barrel'; request();",
      'test/helpers/barrel.ts': "export { request } from './target';",
      'test/helpers/target.ts':
        "import {\n SELF as target\n} from 'cloudflare:test'; export const request = () => target.fetch('/');",
    }),
    [target('full-runtime cloudflare:test import SELF'), target('full-runtime identifier SELF')],
  );
});

test('literal dynamic imports are traversed and cycles terminate', () => {
  const second = at('test/helpers/second.ts');
  assert.deepEqual(
    check({
      [ENTRY]: "import('./helpers/first');",
      'test/helpers/first.ts': "import './second';",
      'test/helpers/second.ts': "import './first'; import { SELF } from 'cloudflare:test';",
    }),
    [second('full-runtime cloudflare:test import SELF'), second('full-runtime identifier SELF')],
  );
});

test('Node placement rejects Workers bindings, globals, Text modules and network modules', () => {
  for (const [source, expected] of [
    ["import { env } from 'cloudflare:test';", 'Workers import in Node project cloudflare:test'],
    ["import { connect } from 'workerd:unsafe';", 'Workers import in Node project workerd:unsafe'],
    [
      "import '../src/knowledge/corpus/astra.md';",
      'Wrangler Text module requires Workers ../src/knowledge/corpus/astra.md',
    ],
    ["import schema from '../schema.sql';", 'Wrangler Text module requires Workers ../schema.sql'],
    ['new HTMLRewriter();', 'Workers HTMLRewriter global'],
    // A portable test injects its fetcher; node-no-network.ts refuses fetch, and this keeps a
    // test from going around it.
    ["import { request } from 'node:http';", 'network module in Node project node:http'],
    ["import https from 'https';", 'network module in Node project https'],
    ["import { connect } from 'node:net';", 'network module in Node project node:net'],
    [
      "import { lookup } from 'node:dns/promises';",
      'network module in Node project node:dns/promises',
    ],
  ]) {
    assert.deepEqual(check({ [ENTRY]: source }, 'node'), [entry(expected)], source);
    // The Node-only rules leave minimal Workers alone: there, these are the runtime's own.
    assert.deepEqual(check({ [ENTRY]: source }), [], `${source} (minimal Workers)`);
  }
});

test('a real multi-file import chain is followed on disk', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-boundary-'));
  try {
    const write = (file, source) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
    };
    write(ENTRY, "import { total } from './helpers/sum';\ntotal();\n");
    write(
      'test/helpers/sum.ts',
      "import { log } from '../../src/platform/log';\nexport const total = () => log(1);\n",
    );
    write(
      'src/platform/log.ts',
      "import { env } from 'cloudflare:workers';\nexport const log = (n: number) => (env ? n : 0);\n",
    );
    write('test/helpers/app.ts', "import '../../src/index';\nexport const app = 1;\n");
    write('src/index.ts', 'export default {};\n');
    // In Node, the binding two files away is found, and reported where it is.
    assert.deepEqual(minimalRuntimeViolations(ENTRY, { root, runtime: 'node' }), [
      'src/platform/log.ts: Workers import in Node project cloudflare:workers',
    ]);
    // Minimal Workers has the bindings, so the same chain passes there…
    assert.deepEqual(minimalRuntimeViolations(ENTRY, { root }), []);
    // …until a helper on the way reaches the application's entrypoint.
    write(ENTRY, "import { total } from './helpers/sum';\nimport './helpers/app';\ntotal();\n");
    assert.deepEqual(minimalRuntimeViolations(ENTRY, { root }), [
      'src/index.ts: full application entrypoint, route or HTTP fixture',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
