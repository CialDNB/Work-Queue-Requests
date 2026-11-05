// Pins scripts/deployment-target.mjs, the one reader that decides whether the CIAL provision and
// deploy paths may run, and its wiring into those paths.
//
// The reader fails closed, so most cases here are refusals: every way a marker can be invalid,
// and a missing marker in a tree that shows a sign of a DB Israel app. Each one must stop every
// guard, because a guard that read "no marker" as CIAL would turn the CIAL pipeline back on for a
// DB Israel app whose marker was deleted. The CIAL cases pin the other side: no marker and no
// sign is CIAL, exactly as before, and `--github-output` writes `cial=true` for it and nothing
// else.
//
// The wiring cases read the workflows and package.json just closely enough to find each guard:
// the ci.yml job deploy-staging needs, the two-ref refusals in the dispatched workflows, the daily
// edge-live skip, and the seven laptop scripts. They are drift tripwires against an accidental
// edit, not a lock: a PR can change both a workflow and this file, and its review is the gate.
// test/platform/deploy-ledger-contract.test.mjs also reads all five strictly, as GitHub evaluates
// them: each guard job fails closed (no continue-on-error, no step if:), each guarded job needs
// it, and deploy-staging and edge-live's check require its result and output as top-level &&
// operands. A workflow an app has deleted is skipped: a CIAL path that is not there cannot deploy.
//
// Fixtures are synthetic trees in a temp directory. Nothing here names the template as a literal:
// a renamed app keeps this file, and its residual scan would flag one. Run by `node --test`
// (test:scripts).
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ACCEPTED_CALLER_SHA256,
  CALLER_PATH,
  CALLER_TEXT,
  CENTRAL_DELIVERY_DOC,
  CREDENTIAL_ENV,
  callerSha256,
  isAcceptedCaller,
  LEGACY_CALLER_PATH,
  MARKER_MAX_BYTES,
  MARKER_PATH,
  main as readerMain,
  readMarker,
  resolveDeploymentTarget,
} from '../../scripts/deployment-target.mjs';
import { isTemplateRepo, KIT_REPOSITORY, TEMPLATE_KEBAB } from '../../scripts/new-app.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const READER = join(ROOT, 'scripts', 'deployment-target.mjs');

// The caller central accepts, pinned here independently of the reader's own list.
const CENTRAL_CALLER_SHA256 = '47c9caffc3ea213617010e2e8fa197078c69a34a6de0071c28a02b807551dee1';

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

const marker = (target, version = 1) =>
  `${JSON.stringify({ version, deploymentTarget: target })}\n`;
// The all-zero account id a DB Israel app's wrangler configs name (wrangler.test.jsonc's).
const SENTINEL = '0'.repeat(32);

/** A synthetic app tree: a CIAL app's two wrangler configs, then `files` (path → text). */
function tree(files = {}) {
  const dir = tempDir('deployment-target-');
  const all = {
    'wrangler.jsonc': `{ "name": "acme-app", "account_id": "${SENTINEL}" }\n`,
    'wrangler.staging.jsonc': '{ "name": "acme-app-staging" }\n',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    if (text === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

// The child sees none of this run's Actions or git environment unless a case sets it.
const OWN = new Set(['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_OUTPUT', 'CI']);
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !OWN.has(key) && !key.startsWith('GIT_') && !Object.values(CREDENTIAL_ENV).includes(key),
    ),
  );
  return { ...env, ...extra };
}
const ACTIONS = (repository = 'CialDNB/acme-app') => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: repository,
});

/** Runs the reader in `cwd`; with `output`, under a fresh $GITHUB_OUTPUT whose text it returns. */
function cli(cwd, args = [], { env = {}, output = false } = {}) {
  const extra = { ...env };
  let outFile;
  if (output) {
    outFile = join(tempDir('deployment-target-out-'), 'github-output');
    extra.GITHUB_OUTPUT = outFile;
  }
  const r = spawnSync(process.execPath, [READER, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(extra),
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    output: outFile && existsSync(outFile) ? readFileSync(outFile, 'utf8') : null,
  };
}
/**
 * The same CLI run in this process, on `dir` passed as --root: the cases that repeat across many
 * trees, without a Node start for each. cli() covers the real entry point and exit codes.
 */
function inProcess(dir, args = [], { env = {}, output = false } = {}) {
  const extra = { ...env };
  let outFile;
  if (output) {
    outFile = join(tempDir('deployment-target-out-'), 'github-output');
    extra.GITHUB_OUTPUT = outFile;
  }
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (...parts) => out.push(`${parts.join(' ')}\n`);
  console.error = (...parts) => err.push(`${parts.join(' ')}\n`);
  let status;
  try {
    status = readerMain([...args, '--root', dir], cleanEnv(extra));
  } finally {
    console.log = log;
    console.error = error;
  }
  return {
    status,
    stdout: out.join(''),
    stderr: err.join(''),
    output: outFile && existsSync(outFile) ? readFileSync(outFile, 'utf8') : null,
  };
}
const transcript = (r) => `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
const resolveIn = (dir, env = {}) => resolveDeploymentTarget({ root: dir, env });

// Every invalid marker the reader must refuse: [what, how to make it].
const INVALID_MARKERS = [
  ['a symlink to a valid marker', (dir) => linkMarker(dir)],
  ['a symlinked folder', (dir) => linkFolder(dir)],
  ['a directory', (dir) => mkdirSync(join(dir, MARKER_PATH), { recursive: true })],
  ['over 1 KB', (dir) => put(dir, marker('cial').padEnd(MARKER_MAX_BYTES + 1, ' '))],
  ['unparseable JSON', (dir) => put(dir, '{ "version": 1, ')],
  ['an array', (dir) => put(dir, '[]\n')],
  ['null', (dir) => put(dir, 'null\n')],
  ['a string', (dir) => put(dir, '"dbisrael"\n')],
  ['a missing key', (dir) => put(dir, '{ "version": 1 }\n')],
  ['an extra key', (dir) => put(dir, '{ "version": 1, "deploymentTarget": "cial", "x": 1 }\n')],
  // JSON.parse keeps the last of two equal keys, so each of these shows "dbisrael" and parses as
  // "cial". The second spells the key with a JSON escape (backslash, u0054 for the T), built here
  // from parts.
  [
    'a repeated key',
    (dir) =>
      put(dir, '{ "version": 1, "deploymentTarget": "dbisrael", "deploymentTarget": "cial" }\n'),
  ],
  [
    'a repeated key spelled with an escape',
    (dir) =>
      put(
        dir,
        `{ "version": 1, "deploymentTarget": "dbisrael", "deployment${String.fromCharCode(92)}u0054arget": "cial" }\n`,
      ),
  ],
  [
    'a repeated key behind an object value',
    (dir) =>
      put(
        dir,
        '{ "version": 1, "deploymentTarget": { "a": "dbisrael" }, "deploymentTarget": "cial" }\n',
      ),
  ],
  ['a string version', (dir) => put(dir, '{ "version": "1", "deploymentTarget": "cial" }\n')],
  ['an unknown version', (dir) => put(dir, marker('cial', 2))],
  ['a numeric target', (dir) => put(dir, '{ "version": 1, "deploymentTarget": 1 }\n')],
  ['an unknown target', (dir) => put(dir, marker('dual'))],
  ['a target in another case', (dir) => put(dir, marker('CIAL'))],
];
function put(dir, text) {
  mkdirSync(dirname(join(dir, MARKER_PATH)), { recursive: true });
  writeFileSync(join(dir, MARKER_PATH), text);
}
function linkMarker(dir) {
  writeFileSync(join(dir, 'real.json'), marker('cial'));
  mkdirSync(dirname(join(dir, MARKER_PATH)), { recursive: true });
  symlinkSync(join(dir, 'real.json'), join(dir, MARKER_PATH));
}
function linkFolder(dir) {
  mkdirSync(join(dir, 'elsewhere'));
  writeFileSync(join(dir, 'elsewhere', 'deployment.json'), marker('cial'));
  symlinkSync(join(dir, 'elsewhere'), join(dir, dirname(MARKER_PATH)));
}

// Every sign of a DB Israel app that makes a missing marker an error: [what, files].
const SIGNALS = [
  ['the release caller', { [CALLER_PATH]: CALLER_TEXT }],
  ['an edited release caller', { [CALLER_PATH]: `${CALLER_TEXT}# edited\n` }],
  ['the legacy release caller', { [LEGACY_CALLER_PATH]: 'name: legacy\n' }],
  [
    'a dbisrael.ai route in wrangler.jsonc',
    {
      'wrangler.jsonc':
        '{ "name": "acme-app", "routes": [{ "pattern": "acme-app.staging.dbisrael.ai", "custom_domain": true }] }\n',
    },
  ],
  [
    'a dbisrael.ai var in wrangler.staging.jsonc',
    {
      'wrangler.staging.jsonc':
        '{ "name": "acme-app-staging", "vars": { "DASHBOARD_HOST": "acme-app.staging.DBISRAEL.ai" } }\n',
    },
  ],
  [
    'a dbisrael.ai value in a config this parser cannot read',
    { 'wrangler.staging.jsonc': '{ "name": "x", "routes": ["acme-app.staging.dbisrael.ai",], }\n' },
  ],
  [CENTRAL_DELIVERY_DOC, { [CENTRAL_DELIVERY_DOC]: '# Central delivery\n' }],
];

describe('the deployment marker', () => {
  it('is missing in a tree without one, valid for each target, and holds no template name', () => {
    assert.deepEqual(readMarker(tree()), { state: 'missing' });
    for (const target of ['cial', 'dbisrael']) {
      assert.deepEqual(readMarker(tree({ [MARKER_PATH]: marker(target) })), {
        state: 'valid',
        target,
      });
      assert.equal(marker(target).includes(TEMPLATE_KEBAB), false);
    }
    // Any JSON layout of the one object is the marker; 1 KB exactly is within the limit.
    const spaced = '{\n  "deploymentTarget": "dbisrael",\n  "version": 1\n}\n';
    assert.equal(readMarker(tree({ [MARKER_PATH]: spaced })).state, 'valid');
    const atLimit = marker('cial').padEnd(MARKER_MAX_BYTES, ' ');
    assert.equal(readMarker(tree({ [MARKER_PATH]: atLimit })).state, 'valid');
  });

  for (const [what, make] of INVALID_MARKERS) {
    it(`refuses a marker that is ${what}, in every mode`, () => {
      const dir = tree();
      make(dir);
      assert.equal(readMarker(dir).state, 'invalid');
      const resolution = resolveIn(dir);
      assert.equal(resolution.target, undefined);
      assert.match(resolution.error, /Write the marker/);
      for (const args of [[], ['--require', 'cial']]) {
        const r = inProcess(dir, args);
        assert.equal(r.status, 1, transcript(r));
        assert.equal(r.stdout, '');
        assert.ok(r.stderr.includes(MARKER_PATH), transcript(r));
      }
      const gh = inProcess(dir, ['--github-output'], { env: ACTIONS(), output: true });
      assert.equal(gh.status, 1, transcript(gh));
      assert.equal(gh.output, null, 'an error writes no output');
    });
  }
});

describe('a missing marker', () => {
  it('is CIAL when the tree shows no sign of a DB Israel app', () => {
    assert.deepEqual(resolveIn(tree()), { target: 'cial' });
  });

  for (const [what, files] of SIGNALS) {
    it(`is an error beside ${what}`, () => {
      const dir = tree(files);
      const resolution = resolveIn(dir);
      assert.equal(resolution.target, undefined);
      assert.match(resolution.error, /shows signs of a DB Israel app/);
      assert.match(
        resolution.error,
        /"deploymentTarget": "cial" } if the CIAL pipeline stays live/,
      );
      const r = inProcess(dir, ['--require', 'cial']);
      assert.equal(r.status, 1, transcript(r));
      // With a marker, the same tree resolves: dual delivery says "cial".
      put(dir, marker('cial'));
      assert.deepEqual(resolveIn(dir), { target: 'cial' });
      put(dir, marker('dbisrael'));
      assert.deepEqual(resolveIn(dir), { target: 'dbisrael' });
    });
  }

  it('is no error beside a dbisrael.co.il mail domain, a longer host, or a dbisrael.ai comment', () => {
    const dir = tree({
      'wrangler.jsonc':
        '{\n  // staging moves to acme-app.staging.dbisrael.ai\n  "name": "acme-app",\n' +
        '  "vars": { "ENTRA_ALLOWED_DOMAINS": "cialdnb.com,dbisrael.co.il", "X": "notdbisrael.ai", "Y": "dbisrael.aid" }\n}\n',
    });
    assert.deepEqual(resolveIn(dir), { target: 'cial' });
  });
});

describe('a repository created from the template, before its bootstrap merges', () => {
  const template = () =>
    tree({
      'wrangler.jsonc': JSON.stringify({ name: TEMPLATE_KEBAB }),
      'wrangler.staging.jsonc': null,
    });

  it('is unbootstrapped in Actions, outside the kit repository', () => {
    assert.deepEqual(resolveIn(template(), ACTIONS()), { target: 'unbootstrapped' });
  });

  it('is CIAL in the kit repository (in any case), and outside Actions', () => {
    assert.deepEqual(resolveIn(template(), ACTIONS(KIT_REPOSITORY)), { target: 'cial' });
    assert.deepEqual(resolveIn(template(), ACTIONS(KIT_REPOSITORY.toUpperCase())), {
      target: 'cial',
    });
    assert.deepEqual(resolveIn(template(), {}), { target: 'cial' });
  });

  it('still honours a dbisrael marker and still refuses an invalid one', () => {
    const dir = template();
    put(dir, marker('dbisrael'));
    assert.deepEqual(resolveIn(dir, ACTIONS()), { target: 'dbisrael' });
    put(dir, marker('dual'));
    assert.ok(resolveIn(dir, ACTIONS()).error);
  });
});

describe('the command line', () => {
  const cial = () => tree();
  const israel = () => tree({ [MARKER_PATH]: marker('dbisrael'), [CALLER_PATH]: CALLER_TEXT });
  const unbootstrappedTree = () =>
    tree({ 'wrangler.jsonc': JSON.stringify({ name: TEMPLATE_KEBAB }) });

  it('prints the target, exit 0', () => {
    for (const [dir, env, want] of [
      [cial(), {}, 'cial'],
      [israel(), {}, 'dbisrael'],
      [unbootstrappedTree(), ACTIONS(), 'unbootstrapped'],
    ]) {
      const r = cli(dir, [], { env });
      assert.equal(r.status, 0, transcript(r));
      assert.equal(r.stdout, `${want}\n`);
    }
  });

  it('--require cial passes a CIAL app only', () => {
    assert.equal(cli(cial(), ['--require', 'cial']).status, 0);
    assert.equal(cli(cial(), ['--require=cial']).status, 0);
    const refused = cli(israel(), ['--require', 'cial']);
    assert.equal(refused.status, 1, transcript(refused));
    assert.match(refused.stderr, /This is a DB Israel app/);
    const early = cli(unbootstrappedTree(), ['--require', 'cial'], { env: ACTIONS() });
    assert.equal(early.status, 1, transcript(early));
    assert.match(early.stderr, /has not been bootstrapped/);
  });

  it('--github-output writes exactly cial=true for CIAL and cial=false otherwise', () => {
    const yes = cli(cial(), ['--github-output'], { env: ACTIONS(), output: true });
    assert.equal(yes.status, 0, transcript(yes));
    assert.equal(yes.output, 'cial=true\n');
    for (const [dir, env] of [
      [israel(), ACTIONS()],
      [unbootstrappedTree(), ACTIONS()],
    ]) {
      const no = cli(dir, ['--github-output'], { env, output: true });
      assert.equal(no.status, 0, transcript(no));
      assert.equal(no.output, 'cial=false\n');
      assert.match(no.stdout, /^::notice::CIAL deploy jobs skip/);
    }
    const unset = cli(cial(), ['--github-output'], { env: ACTIONS() });
    assert.equal(unset.status, 1, 'without GITHUB_OUTPUT it fails rather than write nowhere');
  });

  it('goes red for a DB Israel app that holds DEPLOY_ENABLED or a Cloudflare token, and writes nothing', () => {
    const on = {
      [CREDENTIAL_ENV.deployEnabled]: 'true',
      [CREDENTIAL_ENV.cloudflare]: 'false',
    };
    const token = {
      [CREDENTIAL_ENV.deployEnabled]: 'false',
      [CREDENTIAL_ENV.cloudflare]: 'true',
    };
    for (const [env, says] of [
      [on, /::error::DEPLOY_ENABLED is "true": remove it; this is a DB Israel app/],
      [token, /::error::a CLOUDFLARE_API_TOKEN secret is visible .*: remove it/],
    ]) {
      const r = cli(israel(), ['--github-output'], { env: { ...ACTIONS(), ...env }, output: true });
      assert.equal(r.status, 1, transcript(r));
      assert.match(r.stderr, says);
      assert.equal(r.output, null);
    }
    const off = {
      [CREDENTIAL_ENV.deployEnabled]: 'false',
      [CREDENTIAL_ENV.cloudflare]: 'false',
    };
    const quiet = cli(israel(), ['--github-output'], {
      env: { ...ACTIONS(), ...off },
      output: true,
    });
    assert.equal(quiet.output, 'cial=false\n', transcript(quiet));
    // A CIAL app needs both.
    const both = {
      [CREDENTIAL_ENV.deployEnabled]: 'true',
      [CREDENTIAL_ENV.cloudflare]: 'true',
    };
    const live = cli(cial(), ['--github-output'], { env: { ...ACTIONS(), ...both }, output: true });
    assert.equal(live.output, 'cial=true\n', transcript(live));
  });

  // dnbnews and il-Lingua-paved keep the CIAL pipeline, with DEPLOY_ENABLED and a token, beside
  // the caller, and say so with a cial marker. The credential refusal is for a dbisrael target
  // only: tightened to "any app with a caller" or "any app with a marker", it would stop
  // deploy-staging in both on every push to main.
  it('passes a dual-delivered app (a cial marker beside the caller) that holds DEPLOY_ENABLED and a token', () => {
    const dual = tree({ [MARKER_PATH]: marker('cial'), [CALLER_PATH]: CALLER_TEXT });
    const both = {
      [CREDENTIAL_ENV.deployEnabled]: 'true',
      [CREDENTIAL_ENV.cloudflare]: 'true',
    };
    const env = { ...ACTIONS(), ...both };
    const out = cli(dual, ['--github-output'], { env, output: true });
    assert.equal(out.status, 0, transcript(out));
    assert.equal(out.output, 'cial=true\n', transcript(out));
    const required = cli(dual, ['--require', 'cial'], { env });
    assert.equal(required.status, 0, transcript(required));
  });

  it('--root reads another checkout, so a guard can refuse when the two refs disagree', () => {
    const runRef = cial();
    const defaultBranch = israel();
    assert.equal(cli(runRef, ['--require', 'cial']).status, 0);
    const refused = cli(runRef, ['--require', 'cial', '--root', defaultBranch]);
    assert.equal(refused.status, 1, transcript(refused));
    assert.ok(refused.stderr.includes(defaultBranch), 'the message names the checkout it read');
    assert.equal(cli(defaultBranch, ['--require', 'cial', `--root=${runRef}`]).status, 0);
  });

  it('refuses a usage error with exit 1 and the usage', () => {
    for (const args of [
      ['--bogus'],
      ['--require', 'dbisrael'],
      ['--require'],
      ['--root'],
      ['--root', '--require', 'cial'],
      ['--root', join(tmpdir(), 'no-such-dir-for-deployment-target')],
      ['--require', 'cial', '--require', 'cial'],
      ['--require', 'cial', '--github-output'],
      ['--github-output=1'],
      ['cial'],
    ]) {
      const r = cli(cial(), args, { output: true });
      assert.equal(r.status, 1, `${args.join(' ')}\n${transcript(r)}`);
      assert.equal(r.output, null);
    }
    assert.match(cli(cial(), ['--bogus']).stderr, /^unknown argument "--bogus"\nUsage:/);
    assert.equal(cli(cial(), ['--help']).status, 0);
  });

  it('annotates an error in Actions as one ::error:: line', () => {
    const r = cli(tree({ [MARKER_PATH]: marker('dual') }), [], { env: ACTIONS() });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^::error::\S.*\n$/);
  });
});

// An app keeps the copy of this file it was generated with, while /kit-upgrade replaces the reader
// under it. So the cases that hold in every app check what survives the accepted-hash process
// (DECISIONS 2026-10-27): the caller the reader generates is one it accepts, with LF and one final
// newline. The exact bytes and the one-element list change with that process, so only the kit,
// whose copy changes with its reader, pins them.
describe('the release caller', () => {
  it('is one the kit accepts: LF lines, one final newline, its sha256 in the accepted list', () => {
    assert.equal(CALLER_TEXT.includes('\r'), false);
    assert.ok(CALLER_TEXT.endsWith('\n') && !CALLER_TEXT.endsWith('\n\n'), 'one final newline');
    assert.equal(isAcceptedCaller(CALLER_TEXT), true, 'the caller generated is one accepted');
    assert.ok(ACCEPTED_CALLER_SHA256.length > 0);
    for (const hash of ACCEPTED_CALLER_SHA256) assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(new Set(ACCEPTED_CALLER_SHA256).size, ACCEPTED_CALLER_SHA256.length);
  });

  it('in the kit, is the block central accepts, byte for byte: 13 LF lines, 507 bytes, the pinned sha256', {
    skip: !isTemplateRepo(ROOT) && 'kit only: an app keeps this copy while upgrades move the list',
  }, () => {
    assert.equal(Buffer.byteLength(CALLER_TEXT), 507);
    assert.equal(CALLER_TEXT.endsWith('}}\n'), true);
    assert.equal(CALLER_TEXT.split('\n').length, 14, '13 lines and one final newline');
    // Line 1 is over the editor's 100 columns; nothing may wrap it.
    assert.equal(CALLER_TEXT.split('\n')[0].length, 103);
    assert.equal(callerSha256(CALLER_TEXT), CENTRAL_CALLER_SHA256);
    assert.deepEqual([...ACCEPTED_CALLER_SHA256], [CENTRAL_CALLER_SHA256]);
  });

  it('is accepted with CRLF line endings, and refused with one byte more, one less or one changed', () => {
    assert.equal(isAcceptedCaller(CALLER_TEXT), true);
    assert.equal(isAcceptedCaller(CALLER_TEXT.replace(/\n/g, '\r\n')), true);
    assert.equal(isAcceptedCaller(`${CALLER_TEXT}\n`), false);
    assert.equal(isAcceptedCaller(`${CALLER_TEXT} `), false);
    assert.equal(isAcceptedCaller(CALLER_TEXT.slice(0, -1)), false);
    assert.equal(isAcceptedCaller(`%${CALLER_TEXT.slice(1)}`), false);
  });
});

describe('the CIAL paths ask the reader', () => {
  it('provision.mjs refuses a DB Israel app or an error before it writes anything, and runs for CIAL', () => {
    const provision = join(ROOT, 'scripts', 'provision.mjs');
    const plan = (dir) =>
      spawnSync(process.execPath, [provision, '--plan'], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnv(),
      });
    for (const dir of [
      tree({ [MARKER_PATH]: marker('dbisrael'), 'docs/.keep': '' }),
      tree({ [CALLER_PATH]: CALLER_TEXT, 'docs/.keep': '' }),
    ]) {
      const r = plan(dir);
      assert.equal(r.status, 1, transcript(r));
      assert.match(r.stderr, /DB Israel/);
      assert.equal(existsSync(join(dir, 'docs', 'RESOURCES.md')), false);
    }
    const dir = tree({ 'docs/.keep': '' });
    const r = plan(dir);
    assert.equal(r.status, 0, transcript(r));
    assert.ok(existsSync(join(dir, 'docs', 'RESOURCES.md')));
  });

  it('verify:bootstrap (new-app.mjs --verify-only) goes red on an error, and passes either target', () => {
    const verify = (dir) =>
      spawnSync(process.execPath, [join(ROOT, 'scripts', 'new-app.mjs'), '--verify-only'], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnv(),
      });
    for (const files of [{ [MARKER_PATH]: marker('dual') }, { [CALLER_PATH]: CALLER_TEXT }]) {
      const r = verify(tree(files));
      assert.equal(r.status, 1, transcript(r));
      assert.ok(r.stderr.includes(MARKER_PATH), transcript(r));
    }
    for (const files of [
      {},
      { [MARKER_PATH]: marker('cial'), [CALLER_PATH]: CALLER_TEXT },
      israelApp(),
    ]) {
      const r = verify(tree(files));
      assert.equal(r.status, 0, transcript(r));
      assert.match(r.stdout, /Bootstrap verified/);
    }
    // A DB Israel app is also held to what central's build needs (a mirror of its checks) and to
    // the sentinel account, and a dual-delivered app to its caller's bytes and the enrollment
    // approximation. Each case names the one check it breaks, so dropping that check fails it.
    const wranglerAt = (version) => (lock) => {
      lock.packages['node_modules/wrangler'].version = version;
      return lock;
    };
    const wranglerEntry = (edit) => (lock) => {
      edit(lock.packages['node_modules/wrangler']);
      return lock;
    };
    const unsafeWorkflow = 'name: x\non: push\njobs:\n  a:\n    secrets: inherit\n';
    for (const [files, says] of [
      [{ [MARKER_PATH]: marker('dbisrael'), [CALLER_PATH]: CALLER_TEXT }, /package-lock\.json/],
      [
        { ...israelApp(), [CALLER_PATH]: `${CALLER_TEXT}# edited\n` },
        /not a caller the kit accepts/,
      ],
      [{ ...israelApp(), [CALLER_PATH]: null }, /no release caller/],
      [
        { [MARKER_PATH]: marker('cial'), [CALLER_PATH]: `${CALLER_TEXT}# edited\n` },
        /not a caller the kit accepts/,
      ],
      // A dual-delivered app's workflows pass the enrollment approximation too.
      [
        {
          [MARKER_PATH]: marker('cial'),
          [CALLER_PATH]: CALLER_TEXT,
          '.github/workflows/extra.yml': unsafeWorkflow,
        },
        /extra\.yml: line 5: secrets: inherit/,
      ],
      // The account is the sentinel, present: a config without one acts on the login's account.
      [
        israelApp({ files: { 'wrangler.staging.jsonc': '{ "name": "acme-app-staging" }\n' } }),
        /wrangler\.staging\.jsonc: account_id \(missing\)/,
      ],
      [
        israelApp({
          files: {
            'wrangler.jsonc': `${JSON.stringify({
              name: 'acme-app',
              account_id: SENTINEL,
              env: { x: { account_id: 'ab'.repeat(16) } },
            })}\n`,
          },
        }),
        /wrangler\.jsonc: env\.x\.account_id/,
      ],
      // Central's build prerequisites, one by one.
      [israelApp({ lock: wranglerAt('4.124.9') }), /the locked wrangler is 4\.124\.9/],
      [israelApp({ lock: wranglerAt('5.0.0') }), /the locked wrangler is 5\.0\.0/],
      [
        israelApp({ lock: (lock) => ({ ...lock, lockfileVersion: 2 }) }),
        /lockfileVersion must be 3/,
      ],
      [
        israelApp({ lock: wranglerEntry((entry) => delete entry.integrity) }),
        /node_modules\/wrangler has no sha512 integrity/,
      ],
      [
        israelApp({
          lock: wranglerEntry((entry) =>
            Object.assign(entry, { integrity: `sha1-${'A'.repeat(27)}=` }),
          ),
        }),
        /node_modules\/wrangler has no sha512 integrity/,
      ],
      [
        israelApp({
          lock: (lock) => {
            lock.packages['node_modules/local'] = { resolved: 'packages/local', link: true };
            return lock;
          },
        }),
        /node_modules\/local is a linked package/,
      ],
      [israelApp({ files: { 'src/index.ts': null } }), /src\/index\.ts is missing/],
    ]) {
      const r = verify(tree(files));
      assert.equal(r.status, 1, transcript(r));
      assert.match(r.stderr, says, transcript(r));
    }
  });

  // A dual-delivered app's caller is restored by hand. Rerunning the bootstrap there would take its
  // CIAL branch: reset the provisioned staging ids and re-stamp docs/RESOURCES.md, and still not
  // write the caller. A DB Israel app's rerun restores it, idempotently.
  it("verify:bootstrap's caller fix depends on the target: by hand under cial, a rerun under dbisrael", () => {
    const verify = (dir) =>
      spawnSync(process.execPath, [join(ROOT, 'scripts', 'new-app.mjs'), '--verify-only'], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnv(),
      });
    const edited = `${CALLER_TEXT}# edited\n`;
    // A cial app with no caller is a plain CIAL app: only an edited caller is a problem there.
    const dual = verify(tree({ [MARKER_PATH]: marker('cial'), [CALLER_PATH]: edited }));
    assert.equal(dual.status, 1, transcript(dual));
    assert.doesNotMatch(dual.stderr, /new-app\.mjs <name>|Rerun the bootstrap/, transcript(dual));
    assert.match(dual.stderr, /CALLER_TEXT/, transcript(dual));
    assert.match(dual.stderr, /never rerun the bootstrap/i, transcript(dual));
    for (const caller of [edited, null]) {
      const israel = verify(tree({ ...israelApp(), [CALLER_PATH]: caller }));
      assert.equal(israel.status, 1, transcript(israel));
      assert.match(israel.stderr, /node scripts\/new-app\.mjs <name>/, transcript(israel));
    }
  });
});

/**
 * A DB Israel app's files beyond tree()'s, for verify:bootstrap to pass: the marker and the caller,
 * a staging config that names the sentinel account like tree()'s production one, and what
 * central's build reads (a lockfile of registry packages with a 4.x Wrangler, the build script,
 * the entry point, a migration). `lock` edits the lockfile; `files` overrides, null to leave out.
 */
function israelApp({ lock = (l) => l, files = {} } = {}) {
  // A lockfile entry's integrity is a sha512 digest in base64; this one is built, not real.
  const integrity = `sha512-${'A'.repeat(86)}==`;
  const lockfile = lock({
    name: 'acme-app',
    lockfileVersion: 3,
    packages: {
      '': { name: 'acme-app' },
      'node_modules/wrangler': {
        version: '4.130.0',
        resolved: 'https://registry.npmjs.org/wrangler/-/wrangler-4.130.0.tgz',
        integrity,
      },
    },
  });
  return {
    [MARKER_PATH]: marker('dbisrael'),
    [CALLER_PATH]: CALLER_TEXT,
    'wrangler.staging.jsonc': `{ "name": "acme-app-staging", "account_id": "${SENTINEL}" }\n`,
    'package.json': `${JSON.stringify({ name: 'acme-app', scripts: { 'build:web': 'vite build' } })}\n`,
    'package-lock.json': `${JSON.stringify(lockfile)}\n`,
    'src/index.ts': 'export default {};\n',
    'migrations/d1/0000_init.sql': 'SELECT 1;\n',
    ...files,
  };
}

// ── wiring ───────────────────────────────────────────────────────────────────────────────────

const workflowPath = (file) => join(ROOT, '.github', 'workflows', file);
const readWorkflow = (file) =>
  existsSync(workflowPath(file)) ? readFileSync(workflowPath(file), 'utf8') : null;
const skipWithout = (file) => !existsSync(workflowPath(file)) && `${file} is not in this app`;

/** The lines of each job directly under `jobs:` (two spaces in, as every kit workflow writes them). */
function jobsOf(text) {
  const lines = text.split(/\r?\n/);
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
    if (/^\S/.test(line)) break;
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) {
      current = [];
      jobs.set(id[1], current);
    } else current?.push(line);
  }
  return jobs;
}

/** A job's lines as text; fails when the job is missing. */
function job(text, id) {
  const lines = jobsOf(text).get(id);
  assert.ok(lines, `no job \`${id}\` (jobs: ${[...jobsOf(text).keys()].join(', ')})`);
  return lines.join('\n');
}

/** The steps of a job, each as its lines' text. */
const stepsOf = (jobText) =>
  jobText
    .split(/\n(?= {6}- )/)
    .filter((s) => /^ {6}- /.test(s.split('\n').find((l) => l.trim()) ?? ''));

/** A step's `id:`, or undefined. */
const stepId = (step) => /(?:^|\n) {6}[- ] id: (\S+)(?:\n|$)/.exec(step)?.[1];

/** The job's step whose one-line `run:` is exactly `command`. */
function stepRunning(jobText, command) {
  const hits = stepsOf(jobText).filter((s) =>
    s
      .split('\n')
      .some((l) => /^ {6}[- ] run: /.test(l) && l.replace(/^ {6}[- ] run: /, '') === command),
  );
  assert.equal(hits.length, 1, `exactly one step runs \`${command}\``);
  return hits[0];
}

/** A job-level key's value, with any lines under it (a folded `if: >-`), as one line. */
function jobKey(jobText, key) {
  const lines = jobText.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`    ${key}:`));
  if (at === -1) return null;
  const under = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && !l.startsWith('      ')) break;
    under.push(l.trim());
  }
  return [lines[at].slice(key.length + 5).trim(), ...under].join(' ').replace(/\s+/g, ' ').trim();
}

const needs = (jobText) =>
  (jobKey(jobText, 'needs') ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const STATUS_FUNCTION = /\b(?:always|failure|cancelled|success)\s*\(/i;
const GUARD = 'deployment-target';
const READER_RUN = 'node scripts/deployment-target.mjs';

/**
 * The guard installs nothing, keeps no token, reads no secret, and cannot report a refusal as a
 * success (its comments aside).
 */
function assertGuardIsInert(text) {
  const jobText = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(jobText, /\bnpm (?:ci|install|i)\b/, 'the guard installs nothing');
  assert.doesNotMatch(jobText, /\bcontinue-on-error:/, 'a refusal fails the guard');
  assert.doesNotMatch(jobText, /\bsecrets\.(?!CLOUDFLARE_API_TOKEN != '')/, 'reads no secret');
  const checkouts = jobText.match(/uses: actions\/checkout@/g)?.length ?? 0;
  const persist = jobText.match(/persist-credentials: false/g)?.length ?? 0;
  assert.ok(checkouts > 0 && persist === checkouts, 'each checkout keeps no token');
}

describe('wiring: ci.yml', { skip: skipWithout('ci.yml') }, () => {
  it('the guard runs on a push to main, before deploy-staging, which needs its success and cial', () => {
    const ci = readWorkflow('ci.yml');
    const guard = job(ci, GUARD);
    assert.match(jobKey(guard, 'if'), /github\.event_name == 'push'/);
    assert.match(jobKey(guard, 'if'), /github\.ref == 'refs\/heads\/main'/);
    assertGuardIsInert(guard);
    const step = stepRunning(guard, `${READER_RUN} --github-output`);
    assert.equal(stepId(step), 'target');
    assert.ok(
      step.includes(`${CREDENTIAL_ENV.deployEnabled}: \${{ vars.DEPLOY_ENABLED == 'true' }}`),
      'the step hands the reader DEPLOY_ENABLED as GitHub evaluates it',
    );
    assert.ok(
      step.includes(`${CREDENTIAL_ENV.cloudflare}: \${{ secrets.CLOUDFLARE_API_TOKEN != '' }}`),
      'and whether a Cloudflare token is visible',
    );
    assert.ok(guard.includes(`      cial: \${{ steps.target.outputs.cial }}`));

    const deploy = job(ci, 'deploy-staging');
    assert.ok(needs(deploy).includes(GUARD), 'deploy-staging needs the guard');
    const gate = jobKey(deploy, 'if');
    assert.ok(gate.includes(`&& needs.${GUARD}.result == 'success'`), gate);
    assert.ok(gate.includes(`&& needs.${GUARD}.outputs.cial == 'true'`), gate);
  });
});

// The dispatched workflows: the job that reaches Cloudflare, by workflow.
const DISPATCHED = [
  ['deploy-prod.yml', 'deploy'],
  ['provision-staging.yml', 'provision-staging'],
  ['provision-production.yml', 'provision-production'],
];

/** The directory a guard checks the default branch out into. */
function defaultBranchDir(guard) {
  const checkout = stepsOf(guard).find((s) =>
    s.includes(`ref: \${{ github.event.repository.default_branch }}`),
  );
  assert.ok(checkout, 'the guard checks out the default branch');
  const path = /\n {10}path: (\S+)\n/.exec(`${checkout}\n`)?.[1];
  assert.ok(path, 'into a directory of its own');
  return path;
}

for (const [file, target] of DISPATCHED) {
  describe(`wiring: ${file}`, { skip: skipWithout(file) }, () => {
    it(`refuses unless the run's ref and the default branch are both CIAL, before ${target} starts`, () => {
      const text = readWorkflow(file);
      const guard = job(text, GUARD);
      assertGuardIsInert(guard);
      const dir = defaultBranchDir(guard);
      stepRunning(guard, `${READER_RUN} --require cial`);
      stepRunning(guard, `${READER_RUN} --require cial --root ${dir}`);
      const main = job(text, target);
      assert.ok(needs(main).includes(GUARD), `${target} needs the guard`);
      assert.doesNotMatch(jobKey(main, 'if') ?? '', STATUS_FUNCTION, 'and cannot run past it');
    });
  });
}

describe('wiring: edge-live.yml', { skip: skipWithout('edge-live.yml') }, () => {
  it('checks the edge only when both refs are CIAL, and skips green otherwise', () => {
    const text = readWorkflow('edge-live.yml');
    const guard = job(text, GUARD);
    assertGuardIsInert(guard);
    const dir = defaultBranchDir(guard);
    const runRef = stepRunning(guard, `${READER_RUN} --github-output`);
    const other = stepRunning(guard, `${READER_RUN} --github-output --root ${dir}`);
    const ids = [runRef, other].map(stepId);
    assert.ok(ids.every(Boolean), 'both steps have ids');
    assert.ok(
      guard.includes(
        `      cial: \${{ steps.${ids[0]}.outputs.cial == 'true' && steps.${ids[1]}.outputs.cial == 'true' }}`,
      ),
      'the output is cial only when both refs are',
    );
    const check = job(text, 'check');
    assert.ok(needs(check).includes(GUARD));
    const gate = jobKey(check, 'if');
    assert.ok(gate.includes(`needs.${GUARD}.result == 'success'`), gate);
    assert.ok(gate.includes(`needs.${GUARD}.outputs.cial == 'true'`), gate);
    assert.doesNotMatch(gate, /\|\|/, 'no clause can outvote the guard');
    assert.doesNotMatch(gate, STATUS_FUNCTION);
  });

  // A failed guard skips `check`, so a ping inside `check` would never fire for it, and that day's
  // drift check would not run with nothing in Slack. The ping is a job of its own that needs both.
  it('pings the alert webhook from a job of its own when the guard or the check fails', () => {
    const text = readWorkflow('edge-live.yml');
    const notify = job(text, 'notify');
    for (const id of [GUARD, 'check']) assert.ok(needs(notify).includes(id), `notify needs ${id}`);
    assert.equal(jobKey(notify, 'if'), 'failure()', 'it runs when any job it needs failed');
    const body = notify
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    assert.doesNotMatch(body, /\buses:/, 'it checks out and installs nothing');
    assert.doesNotMatch(body, /\bnpm\b/, 'it installs nothing');
    assert.deepEqual(body.match(/\bsecrets\.\w+/g), ['secrets.ALERT_WEBHOOK_URL']);
    assert.match(body, /\bcurl\b/);
    assert.doesNotMatch(job(text, 'check'), /ALERT_WEBHOOK_URL/, 'check pings nothing itself');
  });
});

// The laptop scripts that deploy or reach a remote database. package.json does not ride
// /kit-upgrade, so a fork has them only once it copies them (a CHANGELOG manual step).
const LAPTOP_SCRIPTS = [
  'deploy',
  'deploy:staging',
  'provision',
  'db:apply',
  'db:apply:staging',
  'db:migrate',
  'db:migrate:staging',
];
const REQUIRE_PREFIX = `${READER_RUN} --require cial && `;

/**
 * Why the laptop-script cases skip in the tree at `root`, or false when they run.
 *
 * This file rides /kit-upgrade and package.json does not, and for a CIAL app copying the guarded
 * scripts in is recommended, not required (the kit CHANGELOG's deployment-target reader entry,
 * manual step 2). So a CIAL fork whose package.json has none of them yet skips, with that step as
 * the reason. The kit, a new app (generated with them), a fork that copied any of them, and a DB
 * Israel app or an unreadable target stay strict: there the scripts must refuse. The target is
 * read from the tree alone, outside Actions, so the answer is the same on a laptop and in CI.
 */
function laptopScriptsSkip(root) {
  if (isTemplateRepo(root)) return false;
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  const adopted =
    scripts['deployment-target'] !== undefined ||
    LAPTOP_SCRIPTS.some((name) => scripts[name]?.startsWith(REQUIRE_PREFIX));
  if (adopted) return false;
  if (resolveDeploymentTarget({ root, env: {} }).target !== 'cial') return false;
  return (
    "this CIAL app's package.json predates the deployment-target scripts. Copying them in is " +
    'recommended, not required: kit CHANGELOG, the deployment-target reader entry, manual step 2 ' +
    '(which also says to take test/platform/migrations.test.mjs)'
  );
}

describe('the laptop-script cases skip only in a CIAL fork that has not copied the scripts', () => {
  const OLD_SCRIPTS = {
    deploy: 'npm run build:web && wrangler deploy',
    'db:migrate': 'wrangler d1 migrations apply DB --remote',
  };
  const pkgJson = (scripts) => `${JSON.stringify({ scripts })}\n`;

  it('skips, naming the CHANGELOG step, in a renamed CIAL app whose package.json has none', () => {
    const reason = laptopScriptsSkip(tree({ 'package.json': pkgJson(OLD_SCRIPTS) }));
    assert.equal(typeof reason, 'string');
    assert.match(reason, /deployment-target reader entry, manual step 2/);
    // A cial marker is the same CIAL app.
    const marked = tree({ 'package.json': pkgJson(OLD_SCRIPTS), [MARKER_PATH]: marker('cial') });
    assert.equal(typeof laptopScriptsSkip(marked), 'string');
  });

  it('runs once any of them is there, in a DB Israel app, on an unreadable target and in the kit', () => {
    const strict = {
      'the deployment-target script': {
        'package.json': pkgJson({ ...OLD_SCRIPTS, 'deployment-target': READER_RUN }),
      },
      'one prefixed script': {
        'package.json': pkgJson({ ...OLD_SCRIPTS, deploy: `${REQUIRE_PREFIX}wrangler deploy` }),
      },
      'a DB Israel marker': {
        'package.json': pkgJson(OLD_SCRIPTS),
        [MARKER_PATH]: marker('dbisrael'),
      },
      'a caller and no marker': {
        'package.json': pkgJson(OLD_SCRIPTS),
        [CALLER_PATH]: CALLER_TEXT,
      },
      'the template itself': {
        'package.json': pkgJson(OLD_SCRIPTS),
        'wrangler.jsonc': `{ "name": "${TEMPLATE_KEBAB}" }\n`,
      },
    };
    for (const [label, files] of Object.entries(strict)) {
      assert.equal(laptopScriptsSkip(tree(files)), false, label);
    }
  });
});

describe('wiring: the laptop deploy and D1 scripts', { skip: laptopScriptsSkip(ROOT) }, () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  it('each asks the reader first, and `npm run deployment-target` prints the target', () => {
    for (const name of LAPTOP_SCRIPTS) {
      assert.ok(pkg.scripts[name]?.startsWith(REQUIRE_PREFIX), `${name}: ${pkg.scripts[name]}`);
    }
    assert.equal(pkg.scripts['deployment-target'], READER_RUN);
  });

  // Each script runs in a synthetic app whose wrangler, npm and npx are stubs that log their
  // arguments, and whose provision.mjs logs too: in a DB Israel app nothing after the reader runs.
  it('stop before wrangler, npm or provision in a DB Israel app, and go on in a CIAL one', () => {
    const run = (files) => {
      const dir = tree(files);
      for (const path of [
        'package.json',
        'scripts/deployment-target.mjs',
        'scripts/new-app.mjs',
        'scripts/kit-checks/main-module.mjs',
      ]) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        copyFileSync(join(ROOT, path), join(dir, path));
      }
      const log = join(dir, 'stub.log');
      writeFileSync(
        join(dir, 'scripts', 'provision.mjs'),
        "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.STUB_LOG, 'provision\\n');\n",
      );
      const bin = join(dir, 'stub-bin');
      mkdirSync(bin);
      for (const tool of ['wrangler', 'npm', 'npx']) {
        writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "$STUB_LOG"\n`);
        chmodSync(join(bin, tool), 0o755);
      }
      const env = cleanEnv({
        STUB_LOG: log,
        PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
      });
      return LAPTOP_SCRIPTS.map((name) => {
        writeFileSync(log, '');
        const r = spawnSync('/bin/sh', ['-c', pkg.scripts[name]], {
          cwd: dir,
          encoding: 'utf8',
          env,
        });
        return { name, status: r.status, ran: readFileSync(log, 'utf8'), stderr: r.stderr };
      });
    };
    for (const r of run({ [MARKER_PATH]: marker('dbisrael') })) {
      assert.notEqual(r.status, 0, `${r.name} must fail in a DB Israel app`);
      assert.equal(r.ran, '', `${r.name} ran past the reader: ${r.ran}`);
      assert.match(r.stderr, /This is a DB Israel app/);
    }
    for (const r of run({})) {
      assert.equal(r.status, 0, `${r.name}: ${r.stderr}`);
      assert.notEqual(r.ran, '', `${r.name} stopped in a CIAL app`);
    }
  });
});
