// An offline approximation of the workflow audit DB Israel enrollment runs: classifyWorkflow() in
// src/delivery/controls.ts of the central DB Israel deployment repository, which reads each
// workflow with the YAML subset of its src/shared/yaml.ts. Enrollment refuses an app while any workflow
// on any ref could reach the shared trigger secret, or is written outside that subset, so a kit
// workflow that fails here would block every DB Israel app built on the kit.
//
// THIS IS NOT LIVE ENFORCEMENT. Central runs its own code, over every branch and tag, and its
// verdict is the one that counts. This mirrors the rules that matter for the kit's own files:
//   - the trigger secret's name, current or retired, anywhere in the raw text;
//   - the central notifier workflow named anywhere but in the accepted caller;
//   - `secrets: inherit`, and a `secrets` context read whole or by index (`secrets[…]`,
//     `toJSON(secrets)`) inside a ${{ }};
//   - YAML outside the subset: a tab in the indentation, a second document, an anchor, alias or
//     tag, a non-empty flow mapping, a key that is single-quoted or not a plain name, and a block
//     scalar header other than | and > with an optional - or +;
//   - a directory under .github/workflows, and both the current and the legacy caller at once.
// The accepted caller itself (scripts/deployment-target.mjs) is exempt at its own path.
//
// The approximation lives in scripts/deployment-target.mjs (enrollmentProblems and
// repoEnrollmentProblems), where `verify:bootstrap` runs it on a DB Israel app too, and builds the
// trigger secret names from parts. This file runs it over this repo's workflows in the kit, whose
// files every app starts from, and in an app that shows a sign of DB Israel delivery. A CIAL app
// with no caller is never enrolled, so its own workflows are its business. The self-tests prove
// each rule fires: the file rules on a synthetic workflow, and the two repository rules on a
// synthetic tree in a temp directory. Run by `node --test` (test:scripts).
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  CALLER_PATH,
  CALLER_TEXT,
  enrollmentProblems,
  israelSignals,
  LEGACY_CALLER_PATH,
  NOTIFIER,
  repoEnrollmentProblems as repoProblems,
  resolveDeploymentTarget,
  TRIGGER_SECRETS,
} from '../../scripts/deployment-target.mjs';
import { isTemplateRepo } from '../../scripts/new-app.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const WORKFLOWS = '.github/workflows';

const enrolled =
  isTemplateRepo(ROOT) ||
  israelSignals(ROOT).length > 0 ||
  resolveDeploymentTarget({ root: ROOT, env: {} }).target === 'dbisrael';

describe('the workflows pass an approximation of the enrollment audit', {
  skip: !enrolled && 'a CIAL app with no DB Israel caller is never enrolled',
}, () => {
  it(`every file under ${WORKFLOWS}`, () => {
    const problems = repoProblems(ROOT);
    assert.deepEqual(problems, [], problems.join('\n'));
  });
});

describe('the approximation catches each rule (synthetic workflows)', () => {
  const secret = TRIGGER_SECRETS[0];
  const base = [
    'name: ci',
    'on:',
    '  push:',
    '    branches: [main]',
    "    tags: ['v*']",
    'permissions: {}',
    'jobs:',
    '  build:',
    '    if: >-',
    `      \${{ github.ref == 'refs/heads/main' }}`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4 # pinned elsewhere',
    '      - name: Use a token',
    '        env:',
    `          TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}`,
    '        run: |',
    '          echo "key: &not-an-anchor { a: b }"',
    "          'quoted': here",
    '',
  ].join('\n');
  const check = (text, path = `${WORKFLOWS}/ci.yml`) => enrollmentProblems(text, path);

  it('passes the baseline, block scalar content included', () => {
    assert.deepEqual(check(base), []);
  });

  it('accepts the caller at its own path only, with LF or CRLF line endings', () => {
    assert.deepEqual(check(CALLER_TEXT, CALLER_PATH), []);
    assert.deepEqual(check(CALLER_TEXT.replace(/\n/g, '\r\n'), CALLER_PATH), []);
    assert.match(check(CALLER_TEXT).join('\n'), /names /);
    assert.match(check(`${CALLER_TEXT}# edited\n`, CALLER_PATH).join('\n'), /names /);
  });

  const cases = [
    ['the trigger secret in a comment', `${base}# ${secret}\n`, /names /],
    ['the retired trigger secret', `${base}# ${TRIGGER_SECRETS[1].toLowerCase()}\n`, /names /],
    ['the central notifier', `${base}# calls ${NOTIFIER}\n`, /central notifier/],
    [
      'secrets: inherit',
      base.replace('    runs-on: ubuntu-latest', '    secrets: inherit'),
      /inherit/,
    ],
    [
      'an indexed secret',
      base.replace('secrets.CLOUDFLARE_API_TOKEN', "secrets['X']"),
      /whole or by index/,
    ],
    [
      'toJSON(secrets)',
      base.replace('secrets.CLOUDFLARE_API_TOKEN', 'toJSON(secrets)'),
      /whole or by index/,
    ],
    ['an open expression', base.replace(' }}\n        run', '\n        run'), /unterminated/],
    ['a tab', base.replace('    runs-on', '\truns-on'), /a tab/],
    ['a second document', `${base}---\nname: two\n`, /second YAML document/],
    [
      'an anchor',
      base.replace('    runs-on: ubuntu-latest', '    runs-on: &os ubuntu-latest'),
      /anchor/,
    ],
    [
      'an alias item',
      base.replace('      - uses: actions', '      - *step\n      - uses: actions'),
      /anchor/,
    ],
    ['a tag', base.replace('permissions: {}', 'permissions: !!map {}'), /anchor, alias or tag/],
    [
      'a flow mapping',
      base.replace('permissions: {}', 'permissions: { contents: read }'),
      /flow mapping/,
    ],
    ['a single-quoted key', base.replace('    runs-on:', "    'runs-on':"), /single-quoted key/],
    ['a block scalar with an indentation indicator', base.replace('run: |', 'run: |2'), /header/],
    [
      'a block scalar item',
      base.replace('      - uses: actions', '      - |\n        x\n      - uses: actions'),
      /sequence item/,
    ],
  ];
  for (const [what, text, says] of cases) {
    it(`fails ${what}`, () => {
      assert.match(check(text).join('\n'), says);
    });
  }
});

describe('the approximation catches each repository rule (synthetic trees)', () => {
  const temps = [];
  after(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });
  /** A synthetic repository holding `files` (path → text), and `dirs` as empty directories. */
  function repo(files, dirs = []) {
    const root = mkdtempSync(join(tmpdir(), 'enrollment-safety-'));
    temps.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
    return root;
  }
  const ci = { [`${WORKFLOWS}/ci.yml`]: 'name: ci\non:\n  push:\njobs: {}\n' };

  it('passes a tree with the accepted caller alone', () => {
    assert.deepEqual(repoProblems(repo({ ...ci, [CALLER_PATH]: CALLER_TEXT })), []);
  });

  it(`fails a directory under ${WORKFLOWS}, empty or not`, () => {
    for (const root of [
      repo(ci, [`${WORKFLOWS}/sub`]),
      repo({ ...ci, [`${WORKFLOWS}/sub/nested.yml`]: 'name: nested\n' }),
    ]) {
      assert.match(repoProblems(root).join('\n'), /sub: a directory under \.github\/workflows/);
    }
  });

  it('fails the current and the legacy caller at once', () => {
    const root = repo({
      ...ci,
      [CALLER_PATH]: CALLER_TEXT,
      [LEGACY_CALLER_PATH]: 'name: legacy\n',
    });
    assert.match(repoProblems(root).join('\n'), /two release callers/);
    const legacyOnly = repo({ ...ci, [LEGACY_CALLER_PATH]: 'name: legacy\n' });
    assert.doesNotMatch(repoProblems(legacyOnly).join('\n'), /two release callers/);
  });
});
