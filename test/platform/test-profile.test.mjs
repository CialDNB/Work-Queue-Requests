// Pins the timing evidence: what the profile may contain, and the wiring that produces it in CI
// (.github/workflows/ci.yml, `test-suite` job) and in local `npm run ci` (package.json). The
// wiring is pinned because every break in it is silent: the coverage step stays green, the upload
// still succeeds, and the profile just says "unavailable" or loses the step outcome. `/ship`
// reuses a local final-tree run as evidence, so local `ci` must keep running the suite through it.
//
// The wiring checks are drift tripwires, not a security boundary (docs/TESTING.md, "What the
// wiring tests catch"). They catch accidental and well-meant edits that break the wiring or
// soften the coverage gate: a dropped flag, reporter or env, a renamed step, a stray `|| true`,
// `continue-on-error:` or `if:` added to get green, coverage off, a test filter left in. A PR
// that edits ci.yml or package.json can edit this file in the same PR, so a deliberate softening
// is caught only by the owner's review of that PR. A fork's own flags, shards and script names
// pass. Run by `node --test` (test:scripts), like its siblings.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildProfile,
  consoleReporters,
  installedVitestVersion,
  isCodingAgent,
  markdownSummary,
  npmInvocation,
  PROFILE_PATH,
  RAW_REPORT_PATH,
  runnerContext,
  runProfile,
  startProfile,
  summarizeProfile,
} from '../../scripts/test-profile.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'test-profile.mjs');

const root = '/synthetic/repo';
const started = {
  startedAtMs: 1000,
  context: {
    platform: 'linux',
    architecture: 'x64',
    node: 'v22',
    availableParallelism: 2,
    logicalCpus: 2,
  },
};
const report = {
  startTime: 1001,
  success: true,
  numTotalTests: 3,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 1,
  testResults: [
    {
      name: `${root}/test/z.test.ts`,
      status: 'passed',
      startTime: 1010,
      endTime: 1030,
      assertionResults: [{ duration: 10 }, { status: 'pending' }],
    },
    {
      name: `${root}/test/a.test.ts`,
      status: 'passed',
      startTime: 1010,
      endTime: 1050,
      assertionResults: [
        { duration: 30, title: 'must not be exported', failureMessages: ['secret-like fixture'] },
      ],
    },
  ],
};

// Writes a current Vitest-shaped report at the repo-relative `path` a command was given.
function writeReport(directory, path, startedAtMs, testResults = []) {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(
    join(directory, path),
    JSON.stringify({ ...report, startTime: startedAtMs, testResults }),
  );
}

function outputFileOf(command) {
  const match = /(?:^|\s)--outputFile\.json=(\S+)/.exec(command);
  assert.ok(match, `no --outputFile.json= in: ${command}`);
  return match[1];
}

function inTempDir(prefix, body) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('test timing evidence', () => {
  it('normalizes file order without treating concurrent timings as wall time', () => {
    const profile = buildProfile(report, started, root, 1100, 'success');
    assert.deepEqual(
      profile.files.map((file) => file.path),
      ['test/a.test.ts', 'test/z.test.ts'],
    );
    assert.equal(profile.elapsedMs, 100);
    assert.equal(
      profile.files.reduce((sum, file) => sum + file.durationMs, 0),
      60,
    );
    assert.deepEqual(profile.counts, { files: 2, tests: 3, passed: 2, failed: 0, pending: 1 });
    assert.equal(JSON.stringify(profile).includes('secret-like fixture'), false);
    assert.equal(JSON.stringify(profile).includes('must not be exported'), false);
    assert.deepEqual(
      buildProfile(
        { ...report, testResults: [...report.testResults].reverse() },
        started,
        root,
        1100,
        'success',
      ),
      profile,
    );
  });

  it('retains a failing coverage step even when Vitest says its tests passed', () => {
    const profile = buildProfile(report, started, root, 1100, 'failure');
    assert.equal(profile.reportedSuccess, true);
    assert.equal(profile.stepOutcome, 'failure');
    assert.match(markdownSummary(profile), /Coverage step: failure/);
  });

  it('does not invent successful results from missing, malformed or stale evidence', () => {
    for (const input of [null, {}, { ...report, startTime: 900 }]) {
      const profile = buildProfile(input, started, root, 1100, 'failure');
      assert.equal(profile.reportStatus, 'unavailable');
      assert.equal(profile.counts, null);
      assert.equal(profile.reportedSuccess, null);
    }
  });

  it('exports only allowlisted runner context, never credentials or local paths', () => {
    const context = runnerContext({
      GITHUB_SHA: 'synthetic-sha',
      GH_TOKEN: 'synthetic-secret',
      HOME: '/synthetic/home',
    });
    assert.equal(context.github.sha, 'synthetic-sha');
    assert.equal(JSON.stringify(context).includes('synthetic-secret'), false);
    assert.equal(JSON.stringify(context).includes('/synthetic/home'), false);
    assert.ok(context.availableParallelism > 0);
  });

  it('escapes summary markup and keeps outside-checkout paths out of the artifact', () => {
    const profile = buildProfile(
      {
        ...report,
        testResults: [
          { name: '/private/elsewhere.ts', assertionResults: [] },
          { name: `${root}/test/<img>|evil.test.ts`, assertionResults: [] },
        ],
      },
      started,
      root,
      1100,
    );
    assert.equal(profile.files[0].path, '[outside checkout]');
    assert.equal(JSON.stringify(profile).includes('/private/'), false);
    assert.match(markdownSummary(profile), /&lt;img&gt;&#124;evil/);
  });

  it('clears previous evidence and writes an unavailable artifact when Vitest crashes', () => {
    inTempDir('test-profile-', (directory) => {
      startProfile(directory, {}, 1000);
      writeFileSync(join(directory, RAW_REPORT_PATH), JSON.stringify(report));
      summarizeProfile(directory, {}, 1100);
      // A report left by an interrupted run, and the previous run's profile: start clears both.
      writeFileSync(join(directory, RAW_REPORT_PATH), JSON.stringify(report));
      assert.ok(existsSync(join(directory, PROFILE_PATH)));
      startProfile(directory, {}, 2000);
      assert.equal(existsSync(join(directory, RAW_REPORT_PATH)), false);
      assert.equal(existsSync(join(directory, PROFILE_PATH)), false);
      const profile = summarizeProfile(directory, { TEST_STEP_OUTCOME: 'failure' }, 2100);
      assert.equal(profile.reportStatus, 'unavailable');
      assert.equal(profile.stepOutcome, 'failure');
      assert.deepEqual(JSON.parse(readFileSync(join(directory, PROFILE_PATH), 'utf8')), profile);
    });
  });

  it("keeps only the normalized profile: summarize deletes Vitest's raw report once read", () => {
    // The raw report holds titles, failure stacks, absolute paths and the coverage map. Left in
    // the checkout, every later tree scan in the job (verify:bootstrap) and any upload sees it.
    inTempDir('test-profile-raw-', (directory) => {
      const { startedAtMs } = startProfile(directory, {}, 1000);
      writeReport(directory, RAW_REPORT_PATH, startedAtMs, report.testResults);
      assert.equal(summarizeProfile(directory, {}, 1100).reportStatus, 'available');
      assert.equal(existsSync(join(directory, RAW_REPORT_PATH)), false);
      const kept = readFileSync(join(directory, PROFILE_PATH), 'utf8');
      assert.equal(kept.includes('must not be exported'), false);
    });
  });

  it('appends the ten slowest files, slowest first, to the GitHub job summary', () => {
    inTempDir('test-profile-summary-', (directory) => {
      const { startedAtMs } = startProfile(directory, {}, 1000);
      // Twelve files of known, distinct durations, listed fastest first: f01 = 0.1s … f12 = 1.2s.
      const files = Array.from({ length: 12 }, (_, i) => ({
        name: join(directory, 'test', `f${String(i + 1).padStart(2, '0')}.test.ts`),
        status: 'passed',
        startTime: 5000,
        endTime: 5000 + (i + 1) * 100,
        assertionResults: [],
      }));
      writeReport(directory, RAW_REPORT_PATH, startedAtMs, files);
      const summary = join(directory, 'step-summary.md');
      writeFileSync(summary, '# An earlier step\n');
      summarizeProfile(directory, { GITHUB_STEP_SUMMARY: summary }, 9000);
      const text = readFileSync(summary, 'utf8');
      assert.ok(text.startsWith('# An earlier step\n'), "appends; another step's summary stays");
      assert.match(text, /^## Test timing evidence$/m);
      const rows = text
        .split('\n')
        .filter((line) => line.startsWith('| test/'))
        .map((line) => line.split('|').map((cell) => cell.trim()));
      assert.deepEqual(
        rows.map(([, path, duration]) => `${path} ${duration}`),
        [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map(
          (n) => `test/f${String(n).padStart(2, '0')}.test.ts ${(n / 10).toFixed(3)}s`,
        ),
      );
      // Without the variable (local runs), nothing is appended anywhere.
      writeReport(directory, RAW_REPORT_PATH, startedAtMs, files);
      summarizeProfile(directory, {}, 9000);
      assert.equal(readFileSync(summary, 'utf8'), text);
    });
  });
});

describe('local coverage profiling preserves the command status', () => {
  // Calls runProfile with a stand-in for spawnSync that checks how the suite is started, writes a
  // passing report where the command was TOLD to write, and returns `result`.
  function profileWith(env, result, options, check = () => {}) {
    return inTempDir('test-profile-run-', (directory) => {
      const calls = [];
      const code = runProfile(
        directory,
        env,
        (command, args, spawnOptions) => {
          calls.push({ command, args, options: spawnOptions });
          check(command, args, spawnOptions, directory);
          const start = JSON.parse(
            readFileSync(join(directory, '.test-results/started.json'), 'utf8'),
          );
          writeReport(directory, outputFileOf(args.join(' ')), start.startedAtMs);
          return result;
        },
        { os: 'linux', vitestVersion: '4.1.11', ...options },
      );
      const profile = JSON.parse(readFileSync(join(directory, PROFILE_PATH), 'utf8'));
      return { code, calls, profile };
    });
  }

  for (const status of [0, 1, null])
    it(`propagates ${status ?? 'crash'} without converting assertion success to gate success`, () => {
      const env = { PATH: '/synthetic/bin' };
      const { code, calls, profile } = profileWith(env, { status }, {}, (cmd, args, options, d) => {
        assert.equal(cmd, 'npm');
        assert.deepEqual(args.slice(0, 3), ['run', 'test:coverage', '--']);
        assert.ok(args.includes('--reporter=default'), 'the console report must still run');
        assert.ok(args.includes('--reporter=json'));
        assert.equal(options.cwd, d);
        // The developer sees Vitest's own output (failing tests, the coverage table), and the
        // suite runs with the environment it was given.
        assert.equal(options.stdio, 'inherit');
        assert.equal(options.env, env);
        assert.equal(options.shell, false);
      });
      assert.equal(calls.length, 1, 'the suite runs once');
      assert.equal(code, status === 0 ? 0 : 1);
      assert.equal(profile.reportedSuccess, true);
      assert.equal(profile.stepOutcome, status === 0 ? 'success' : 'failure');
    });

  it("wraps the app's own coverage script when it is not named test:coverage", () => {
    const { calls } = profileWith({}, { status: 0 }, { script: 'coverage' });
    assert.deepEqual(calls[0].args.slice(0, 3), ['run', 'coverage', '--']);
  });

  it('picks the console reporter Vitest itself would pick', () => {
    // Vitest 4.1+ quiets passing tests under a coding agent with its `agent` reporter; naming
    // any reporter on the command line replaces that choice, so the wrapper has to make it.
    const claude = { CLAUDECODE: '1' };
    assert.deepEqual(consoleReporters(claude, '4.1.11'), ['agent']);
    assert.deepEqual(consoleReporters({ AI_AGENT: 'some-agent' }, '4.1.0'), ['agent']);
    assert.deepEqual(consoleReporters(claude, '5.0.0'), ['agent']);
    assert.deepEqual(consoleReporters({}, '4.1.11'), ['default']);
    // Before 4.1 there is no `agent` reporter (Arena-2 runs Vitest 3), and unknown means default.
    assert.deepEqual(consoleReporters(claude, '4.0.18'), ['default']);
    assert.deepEqual(consoleReporters(claude, '3.2.4'), ['default']);
    assert.deepEqual(consoleReporters(claude, null), ['default']);
    // On GitHub, Vitest adds its annotations reporter to whichever it picked.
    assert.deepEqual(consoleReporters({ GITHUB_ACTIONS: 'true' }, '4.1.11'), [
      'default',
      'github-actions',
    ]);
    for (const env of [
      { CLAUDE_CODE: '1' },
      { CURSOR_AGENT: '1' },
      { CODEX_SANDBOX: 'seatbelt' },
      { TERM_PROGRAM: 'kiro' },
      { PATH: `/home/u/.pi/agent/bin${delimiter}/usr/bin` },
    ])
      assert.equal(isCodingAgent(env), true, JSON.stringify(env));
    for (const env of [{}, { CLAUDECODE: '' }, { TERM_PROGRAM: 'vscode' }, { PATH: '/usr/bin' }])
      assert.equal(isCodingAgent(env), false, JSON.stringify(env));
  });

  it('runs the quiet agent reporter under an agent, and never both console reporters', () => {
    const { calls } = profileWith({ CLAUDECODE: '1' }, { status: 0 }, {});
    const reporters = calls[0].args.filter((arg) => arg.startsWith('--reporter='));
    assert.deepEqual(reporters, ['--reporter=agent', '--reporter=json']);
  });

  it('reads the Vitest version the app installed', () => {
    const { version } = JSON.parse(
      readFileSync(join(REPO, 'node_modules', 'vitest', 'package.json'), 'utf8'),
    );
    assert.equal(installedVitestVersion(REPO), version);
    inTempDir('test-profile-novitest-', (directory) => {
      assert.equal(installedVitestVersion(directory), null);
    });
  });

  it('starts npm without a shell through npm_execpath, and through a shell only on Windows', () => {
    const args = ['run', 'test:coverage', '--', '--reporter=json'];
    const posixCli = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
    const windowsCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    for (const [cli, os] of [
      [posixCli, 'linux'],
      [windowsCli, 'win32'],
    ])
      assert.deepEqual(npmInvocation(args, { npm_execpath: cli }, os), {
        command: process.execPath,
        args: [cli, ...args],
        shell: false,
      });
    // Not started by npm: Windows only finds npm.cmd through a shell (Node will not spawn a
    // .cmd without one), elsewhere `npm` is an executable on PATH.
    assert.deepEqual(npmInvocation(args, {}, 'win32'), {
      command: 'npm run test:coverage -- --reporter=json',
      args: [],
      shell: true,
    });
    assert.deepEqual(npmInvocation(args, {}, 'darwin'), { command: 'npm', args, shell: false });
    // Another package manager's CLI takes other arguments.
    assert.deepEqual(npmInvocation(args, { npm_execpath: '/opt/pnpm/bin/pnpm.cjs' }, 'linux'), {
      command: 'npm',
      args,
      shell: false,
    });
  });

  it('says why when the suite could not be started at all', () => {
    const error = mock.method(console, 'error', () => {});
    try {
      const failure = Object.assign(new Error('spawnSync npm ENOENT'), { code: 'ENOENT' });
      const { code, profile } = profileWith({}, { status: null, error: failure }, {});
      assert.equal(code, 1);
      assert.equal(profile.stepOutcome, 'failure');
      const printed = error.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
      assert.match(printed, /could not run `npm run test:coverage`: spawnSync npm ENOENT/);
    } finally {
      error.mock.restore();
    }
  });
});

// The wiring checks below are drift tripwires (header): a blocklist of plausible softening edits,
// not a parser or an allowlist that tries to prove nothing can soften the coverage step.

// Reads ci.yml just closely enough to find each job's steps: block-style maps and lists at any
// indentation (a step's `- ` under or beside `steps:`), and a value continued on deeper lines,
// a wrapped plain value or a `|`/`>` block scalar, read whole so a wrapped command is checked
// whole. Quotes and trailing comments are dropped. Not a YAML parser: a line in another shape
// (a flow map, a quoted key, an anchor) is skipped, since only a deliberate edit writes a
// workflow that way, and the owner's review of the PR covers those.
const KEY = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;
const BLOCK_SCALAR = /^[|>][1-9+-]{0,2}(?:\s+#.*)?$/;

function scalar(text) {
  const quoted = /^(['"])(.*)\1(?:\s+#.*)?$/.exec(text);
  if (quoted) return quoted[1] === "'" ? quoted[2].replaceAll("''", "'") : quoted[2];
  return text.replace(/\s+#.*$/, '');
}

function readWorkflow(text) {
  const lines = text.split(/\r?\n/).map((line) => ({
    indent: line.length - line.trimStart().length,
    text: line.trim(),
  }));
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && (!lines[i].text || lines[i].text.startsWith('#'))) i++;
  };
  // The value of a key at `indent`: a map or list on the deeper lines below it, or a scalar
  // joined with its continuation lines.
  const value = (rest, indent) => {
    if (!rest || rest.startsWith('#')) {
      skipBlank();
      const next = lines[i];
      if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith('- '))))
        return node(next.indent);
      return '';
    }
    const block = BLOCK_SCALAR.test(rest);
    const parts = block ? [] : [scalar(rest)];
    for (; i < lines.length && (!lines[i].text || lines[i].indent > indent); i++)
      if (lines[i].text && (block || !lines[i].text.startsWith('#'))) parts.push(lines[i].text);
    return parts.join(rest.startsWith('|') ? '\n' : ' ');
  };
  // The map or list whose entries start at column `indent`.
  const node = (indent) => {
    skipBlank();
    const list = lines[i]?.text.startsWith('- ');
    const out = list ? [] : {};
    for (skipBlank(); i < lines.length && lines[i].indent >= indent; skipBlank()) {
      const { indent: at, text } = lines[i];
      if (at > indent) {
        i++; // a line this reader cannot place
      } else if (list) {
        if (!text.startsWith('- ')) break;
        const content = text.slice(2).trimStart();
        if (KEY.test(content)) {
          // `- key: value` starts a map whose keys line up with this first one.
          lines[i] = { indent: at + text.length - content.length, text: content };
          out.push(node(lines[i].indent));
        } else {
          out.push(scalar(content));
          i++;
        }
      } else {
        const field = KEY.exec(text);
        i++;
        if (field) out[field[1]] = value(field[2], at);
      }
    }
    return out;
  };
  return node(0);
}

// ci.yml's jobs: each job's own fields, and its steps as maps of their fields (`env:` and `with:`
// nested maps).
function workflowJobs(text = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')) {
  const jobs = new Map();
  for (const [name, job] of Object.entries(readWorkflow(text).jobs ?? {})) {
    if (typeof job !== 'object' || Array.isArray(job)) continue;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    jobs.set(name, { fields: job, steps: steps.filter((step) => typeof step === 'object') });
  }
  return jobs;
}

// Every job that summarizes a timing profile, with the index of each step of the wiring. The kit
// has one such job (`test-suite`). A fork that shards its suite has its matrix job here instead
// and keeps its own coverage command (docs/TESTING.md, "Clone adoption"), so these checks hold per
// job and pin the invariants, not the kit's exact command line or job layout.
function profiledJobs(text) {
  const profiled = [];
  for (const [name, { fields, steps }] of workflowJobs(text)) {
    const summarize = steps.findIndex((s) => s.run === 'node scripts/test-profile.mjs summarize');
    if (summarize < 0) continue;
    const at = (predicate, label) => {
      const index = steps.findIndex(predicate);
      assert.ok(index >= 0, `ci.yml \`${name}\` summarizes a profile but has no ${label} step`);
      return index;
    };
    const outcome = /^\$\{\{ steps\.([\w-]+)\.outcome \}\}$/.exec(
      steps[summarize].env?.TEST_STEP_OUTCOME ?? '',
    );
    assert.ok(outcome, `\`${name}\`: summarize must get TEST_STEP_OUTCOME from a step's outcome`);
    const index = {
      start: at((s) => s.run === 'node scripts/test-profile.mjs start', 'profile start'),
      coverage: at((s) => s.id === outcome[1], `\`id: ${outcome[1]}\``),
      summarize,
      upload: at((s) => s.uses?.startsWith('actions/upload-artifact@'), 'timing upload'),
    };
    profiled.push({ name, fields, steps, index, step: (key) => steps[index[key]] });
  }
  assert.ok(profiled.length > 0, 'no ci.yml job runs `node scripts/test-profile.mjs summarize`');
  return profiled;
}

const SCRIPTS = () => JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts;

// What lets the shell, not the suite, decide a coverage step's exit status: `||`, a pipe (the
// step's default shell has no pipefail) or `;`. Checked with `${{ }}` expressions set aside,
// since an expression may hold `||` itself.
const STEP_OPERATORS = /[|;]/;
// Shell operators other than `&&`, in an npm script or the local `ci` chain: `||`, `;`, a pipe,
// a backgrounding `&` or a second line can each end the command on a status that is not the
// suite's. npm runs scripts through `sh`, which has no pipefail.
const OTHER_OPERATORS = /[|;&\r\n]/;
// Flags that, left in or added to get green, change what the suite proves while its step stays
// green. Names compare as Vitest's CLI reads them: without dashes or case, so
// `--test-name-pattern` is `--testNamePattern`. Every other flag passes: a fork's pool, workers,
// bail, timeouts, silence, shards, config or coverage reporters are its own setup.
const SOFTENING = [
  [
    /^(?:t|testnamepattern|exclude|dir|project|changed|related|tagsfilter)$/,
    'runs part of the suite',
  ],
  [
    /^(?:passwithnotests|allowonly|retry|u|update|dangerouslyignoreunhandlederrors)$/,
    'can report a failing or empty suite green',
  ],
  [/^(?:clearcache|listtags|standalone)$/, 'exits green without running a test'],
  [
    /^(?:nocoverage|coverage\.(?:thresholds|include|exclude)(?:\..+)?)$/,
    'turns coverage off, overrides a floor or narrows what coverage counts',
  ],
];
const COVERAGE = new Set(['coverage', 'coverage.enabled']);
const isOff = (value) => /^(?:false|0)$/i.test(value ?? '');
// Flags that take no value, so a bare word after one is a positional argument, not its value.
const NO_VALUE = new Set([
  ...'coverage run silent globals isolate typecheck logheapusage fileparallelism'.split(' '),
  ...'hideskippedtests passwithnotests allowonly dangerouslyignoreunhandlederrors'.split(' '),
  ...'clearcache standalone u update'.split(' '),
]);

// A command's arguments to Vitest as flags ({ text, name, value }) and positional arguments.
// `--flag value` reads as `--flag=value` unless the flag takes no value.
function readArgs(args) {
  const flags = [];
  const positional = [];
  let pending = null;
  for (const token of args) {
    if (token.startsWith('-')) {
      const [name, ...value] = token.replace(/^-+/, '').split('=');
      const flag = {
        text: token,
        name: name.replaceAll('-', '').toLowerCase(),
        value: value.length ? value.join('=') : undefined,
      };
      flags.push(flag);
      const takesValue = !NO_VALUE.has(flag.name) && !token.startsWith('--no-');
      pending = flag.value === undefined && takesValue ? flag : null;
    } else if (pending) {
      pending.value = token;
      pending.text += ` ${token}`;
      pending = null;
    } else positional.push(token);
  }
  return { flags, positional };
}

// True when a command line starts Vitest, directly or through package.json scripts. `vitest`
// is a word of its own there, so `.vitest-reports/` or `vitest-reach.json` is not a run.
const VITEST = /(?:^|[\s/])vitest(?:\s|$)/;
const runsVitest = (line, scripts, depth = 0) =>
  VITEST.test(line ?? '') ||
  (depth < 3 &&
    [
      ...(line ?? '').matchAll(/\bnpm (?:run(?:-script)?(?:\s+-\S+)*\s+([\w:.-]+)|t(?:est)?\b)/g),
    ].some(([, name = 'test']) => runsVitest(scripts[name], scripts, depth + 1)));

// The arguments Vitest receives from one command line, following `npm run <script> -- …` into
// package.json, where npm appends the step's arguments to the script's own.
function vitestArgs(label, line, scripts, depth = 0) {
  const tokens = line.trim().split(/\s+/);
  while (/^[A-Za-z_]\w*=/.test(tokens[0] ?? '')) tokens.shift(); // an env prefix
  if (tokens[0] === 'npm' && ['run', 'run-script', 'test', 't'].includes(tokens[1])) {
    const at = ['test', 't'].includes(tokens[1])
      ? 1
      : tokens.findIndex((token, index) => index > 1 && !token.startsWith('-'));
    const name = at === 1 ? 'test' : tokens[at];
    const script = scripts[name];
    assert.ok(
      typeof script === 'string',
      `${label} runs \`npm run ${name}\`, which package.json lacks`,
    );
    assert.ok(depth < 3, `${label}: \`${name}\` nests npm scripts too deeply to follow`);
    // npm appends the caller's arguments to the script's last command, which must be the suite.
    const parts = script.split('&&').map((part) => part.trim());
    for (const part of parts)
      assert.doesNotMatch(
        part,
        OTHER_OPERATORS,
        `${label}: \`${name}\` can end on a status that is not the suite's: ${script}`,
      );
    assert.ok(
      !parts.slice(0, -1).some((part) => runsVitest(part, scripts)),
      `${label}: \`${name}\` must run Vitest last, where npm appends the step's flags: ${script}`,
    );
    // npm passes the script every word after its name; a `-` flag before `--` is npm's own.
    const dashes = tokens.indexOf('--');
    const passed = [
      ...tokens.slice(at + 1, dashes < 0 ? undefined : dashes).filter((t) => !t.startsWith('-')),
      ...(dashes < 0 ? [] : tokens.slice(dashes + 1)),
    ];
    return [...vitestArgs(`${label} → ${name}`, parts.at(-1), scripts, depth + 1), ...passed];
  }
  const at = tokens.findIndex((token) => /(?:^|\/)vitest$/.test(token));
  assert.ok(at >= 0, `${label}: runs neither Vitest nor an npm script: ${line}`);
  const args = tokens.slice(at + 1);
  if (args[0] === 'run') return args.slice(1);
  // Bare `vitest` watches in a terminal, and `vitest related|list|bench` are not the suite.
  assert.ok(
    args[0]?.startsWith('-') && args.includes('--run'),
    `${label}: not \`vitest run\`: ${line}`,
  );
  return args;
}

// Refuses positional filters and softening flags, and requires coverage on, so the floors run.
function checkSuiteArgs(label, args, source) {
  const { flags, positional } = readArgs(args);
  assert.deepEqual(
    positional,
    [],
    `${label}: a positional argument filters test files, so only part of the suite runs: ${source}`,
  );
  for (const flag of flags) {
    for (const [pattern, why] of SOFTENING)
      assert.doesNotMatch(flag.name, pattern, `${label}: \`${flag.text}\` ${why}: ${source}`);
    assert.ok(
      !(COVERAGE.has(flag.name) && isOff(flag.value)),
      `${label}: \`${flag.text}\` turns coverage off, so no floor is enforced: ${source}`,
    );
  }
  assert.ok(
    flags.some((flag) => COVERAGE.has(flag.name)),
    `${label}: the coverage command does not enable coverage, so no floor is enforced: ${source}`,
  );
  return flags;
}

// A coverage step's `run:` command, with the npm script it names: one Vitest run whose exit
// status is the step's, the full suite with coverage on, the three reporters CI names, and a
// JSON report. Returns that report's path.
function checkSuiteCommand(label, run, scripts) {
  const command = run.replace(/\$\{\{[\s\S]*?\}\}/g, '{{expression}}');
  assert.doesNotMatch(
    command,
    STEP_OPERATORS,
    `${label}: \`||\`, a pipe or \`;\` lets the shell, not the suite, decide the step's status: ${run}`,
  );
  const suite = command
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#') && runsVitest(line, scripts));
  assert.equal(suite.length, 1, `${label}: the coverage step must start Vitest once: ${run}`);
  const flags = checkSuiteArgs(label, vitestArgs(label, suite[0], scripts), run);
  // CLI reporters replace Vitest's defaults, so each one it would have added is named.
  const reporters = flags.filter((flag) => flag.name === 'reporter').map((flag) => flag.value);
  for (const reporter of ['default', 'github-actions', 'json'])
    assert.ok(reporters.includes(reporter), `${label} lacks --reporter=${reporter}: ${run}`);
  const output = flags.find((flag) => flag.name === 'outputfile.json')?.value;
  assert.ok(output, `${label}: no --outputFile.json= for the JSON report: ${run}`);
  return output;
}

function checkCoverageStep(job, scripts) {
  const step = job.step('coverage');
  assert.ok(
    typeof step.run === 'string' && step.run,
    `\`${job.name}\`: no \`run:\` coverage command`,
  );
  const output = checkSuiteCommand(`\`${job.name}\``, step.run, scripts);
  assert.deepEqual(
    job.steps.filter((s) => s !== step && runsVitest(s.run, scripts)).map((s) => s.run),
    [],
    `\`${job.name}\` runs Vitest outside its coverage step`,
  );
  // The coverage step's own exit status is the gate: a condition can skip it on some events, and
  // continue-on-error turns its failure green.
  assert.equal(step.if, undefined, `\`${job.name}\`: \`if:\` on the coverage step can skip it`);
  for (const [where, fields] of [
    ['the coverage step', step],
    ['the job', job.fields],
  ])
    assert.ok(
      [undefined, 'false'].includes(fields['continue-on-error']),
      `\`${job.name}\`: \`continue-on-error:\` on ${where} turns a red suite green`,
    );
  // Behavior, not text: a report at the path the command names is one summarize finds.
  inTempDir('test-profile-wiring-', (directory) => {
    const { startedAtMs } = startProfile(directory, {}, 1000);
    writeReport(directory, output, startedAtMs);
    assert.equal(summarizeProfile(directory, {}, 1100).reportStatus, 'available');
  });
}

// Local `npm run ci` runs the suite once, through test:profile, and only `&&` joins the chain.
function checkLocalChain(scripts) {
  const adopt =
    'package.json does not ride /kit-upgrade: add "test:profile": "node scripts/test-profile.mjs run" ' +
    '(naming your coverage script if it is not test:coverage) and use it in `ci` in place of ' +
    'that script (CHANGELOG, manual steps for forks)';
  const profile = /^node scripts\/test-profile\.mjs run(?: ([\w:.-]+))?$/.exec(
    scripts['test:profile'] ?? '',
  );
  assert.ok(profile, adopt);
  const wrapped = profile[1] ?? 'test:coverage';
  assert.ok(typeof scripts[wrapped] === 'string', `test:profile wraps ${wrapped}: ${adopt}`);
  // The wrapper adds only reporter flags, so the script it wraps passes the coverage step's own
  // checks: one `vitest run`, coverage on, nothing that narrows the suite or its floors. /ship
  // reuses this run as final-tree evidence.
  checkSuiteArgs(
    'test:profile',
    vitestArgs('test:profile', `npm run ${wrapped}`, scripts),
    `${wrapped}: ${scripts[wrapped]}`,
  );
  const links = (scripts.ci ?? '').split('&&').map((link) => link.trim());
  // Only `&&` joins the chain, so a failing suite stops local CI and its exit status is CI's.
  for (const link of links)
    assert.doesNotMatch(
      link,
      OTHER_OPERATORS,
      `ci: only \`&&\` may join the chain, or a red suite can end in a green \`npm run ci\`: ${link}`,
    );
  assert.equal(links.filter((link) => link === 'npm run test:profile').length, 1, adopt);
  assert.deepEqual(
    links.filter((link) => link !== 'npm run test:profile' && runsVitest(link, scripts)),
    [],
    'a second full suite run, or one outside the profile',
  );
}

describe('the timing evidence is wired into CI and into local `npm run ci`', () => {
  const ALWAYS_AFTER = (id) => `\${{ always() && steps.${id}.outcome != 'skipped' }}`;

  it('runs the coverage command with a JSON report at the path the summarizer reads', () => {
    const scripts = SCRIPTS();
    for (const job of profiledJobs()) checkCoverageStep(job, scripts);
  });

  it("refuses plausible softening edits to the coverage command, and passes a fork's own setup", () => {
    // Drift mutants: edits that kept the step green on a failing suite or floor, ran part of
    // it, or lost the timing wiring. Each is refused.
    const scripts = {
      'test:coverage': 'vitest run --coverage',
      test: 'vitest run',
      'test:watch': 'vitest',
    };
    const tail =
      '--reporter=default --reporter=github-actions --reporter=json --outputFile.json=.test-results/vitest.json';
    const kit = `npm run test:coverage -- ${tail}`;
    for (const command of [
      `${kit} || true`,
      `${kit}; exit 0`,
      // Without spaces nothing but the operator check sees it: the token is still a reporter.
      `npm run test:coverage -- --reporter=default||true ${tail}`,
      `${kit} | tee vitest.log`,
      `${kit} --coverage.enabled=false`,
      `${kit} --coverage=false`,
      `${kit} --no-coverage`,
      `${kit} --coverage.thresholds.lines=0`,
      `${kit} --coverage.include=src/health.ts`,
      `${kit} --coverage.exclude=src/auth/**`,
      `${kit} test/routes`,
      `npm run test:coverage -- test/routes ${tail}`,
      `npm run test:coverage test/routes -- ${tail}`,
      `${kit} -t health`,
      `${kit} --testNamePattern=health`,
      `${kit} --test-name-pattern health`,
      `${kit} --exclude=test/isolation/**`,
      `${kit} --project=node`,
      `${kit} --dir=test/routes`,
      `${kit} --changed`,
      `${kit} --related src/health.ts`,
      `${kit} --tagsFilter=fast`,
      `${kit} --passWithNoTests`,
      `${kit} --allowOnly`,
      `${kit} --retry=3`,
      `${kit} -u`,
      `${kit} --dangerouslyIgnoreUnhandledErrors`,
      `${kit} --clearCache`,
      kit.replace(' --reporter=default', ''),
      kit.replace(' --reporter=github-actions', ''),
      kit.replace(' --reporter=json', ''),
      kit.replace(/ --outputFile\S+/, ''),
      `npm run test -- ${tail}`,
      `npm run test:watch -- ${tail}`,
      `npm run test:missing -- ${tail}`,
      `npx vitest --coverage ${tail}`,
      `node scripts/run-suite.mjs ${tail}`,
    ])
      assert.throws(
        () => checkSuiteCommand('test', command, scripts),
        assert.AssertionError,
        command,
      );
    // npm appends the step's flags to the script it names, so that script is checked too.
    for (const script of [
      'vitest run --coverage || true',
      'vitest run --coverage --reporter=default||true',
      'vitest run --coverage; exit 0',
      'vitest run --coverage\nexit 0',
      'vitest run --coverage && node scripts/after.mjs',
      'vitest run --coverage --exclude=test/isolation/**',
      'vitest run --coverage --coverage.thresholds.lines=0',
      'vitest run --coverage test/routes',
      'vitest --coverage',
      'vitest run',
    ])
      assert.throws(
        () => checkSuiteCommand('test', kit, { 'test:coverage': script }),
        assert.AssertionError,
        script,
      );
    // A fork's own setup passes: other runner flags in either form, shards, another config or
    // coverage reporter, Vitest directly, a shard matrix's merge job, another script name (one
    // that prepares something first), the reporters in the script, an npm flag, an env prefix, a
    // command wrapped over lines, and an expression that holds `||`.
    const fork = {
      ...scripts,
      'test:coverage:shard': 'vitest run --coverage --reporter=blob',
      coverage: 'node scripts/prepare.mjs && cross-env TZ=UTC vitest run --coverage --pool=forks',
      'test:coverage:ci': `vitest run --coverage ${tail}`,
    };
    for (const command of [
      kit,
      `${kit} --pool=forks --bail=1 --silent --maxWorkers=50% --testTimeout=30000`,
      `${kit} --pool forks --max-workers 2 --no-file-parallelism --silent=passed-only`,
      `${kit} --shard=1/4 --coverage.reporter=lcov --coverage.reportsDirectory=coverage/shard-1`,
      `${kit} --config=vitest.ci.config.ts --sequence.shuffle`,
      `npm run test:coverage:shard -- --shard=\${{ matrix.shard }}/\${{ strategy.job-total || 4 }} --maxWorkers=2 ${tail}`,
      `npx vitest run --coverage --shard=\${{ matrix.shard }}/4 ${tail} --outputFile.blob=.vitest-reports/blob-\${{ matrix.shard }}.json`,
      `npx vitest run --merge-reports=.vitest-reports --coverage ${tail}`,
      `npm run coverage -- ${tail}`,
      'npm run test:coverage:ci',
      `npm run --silent test:coverage -- ${tail}`,
      `NODE_OPTIONS=--max-old-space-size=6144 ${kit}`,
      `npm run test:coverage -- \\\n  --reporter=default --reporter=github-actions \\\n  --reporter=json --outputFile.json=.test-results/vitest.json`,
    ])
      checkSuiteCommand('test', command, fork);
  });

  it('reads a profiled job in the styles a fork writes, and refuses a softened coverage step', () => {
    const run =
      'npm run test:coverage -- --reporter=default --reporter=github-actions --reporter=json --outputFile.json=.test-results/vitest.json';
    const workflow = [
      'name: CI',
      'jobs:',
      '  test:',
      '    needs: [gate]',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm ci',
      '      - name: Record test runner context',
      '        run: node scripts/test-profile.mjs start',
      '      - name: Full suite with coverage and timing report',
      '        id: coverage',
      `        run: ${run}`,
      '      - name: Summarize test timings',
      `        if: ${ALWAYS_AFTER('coverage')}`,
      '        env:',
      `          TEST_STEP_OUTCOME: \${{ steps.coverage.outcome }}`,
      '        run: node scripts/test-profile.mjs summarize',
      '      - run: mkdir -p .vitest-reports && cp vitest-reach.json .vitest-reports/',
      '      - name: Upload test timings',
      `        if: ${ALWAYS_AFTER('coverage')}`,
      '        continue-on-error: true',
      '        uses: actions/upload-artifact@v7 # v7.0.2',
      '        with:',
      `          name: test-profile-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      '          path: .test-results/test-profile.json',
      '      - run: npm run test:scripts',
      '',
    ].join('\n');
    const scripts = {
      'test:coverage': 'vitest run --coverage',
      'test:coverage:shard': 'vitest run --coverage --reporter=blob',
      'test:scripts': 'node --test test/platform/*.test.mjs',
    };
    const check = (text) => {
      for (const job of profiledJobs(text)) checkCoverageStep(job, scripts);
    };
    const edit = (from, to) => {
      assert.ok(workflow.includes(from), from);
      return workflow.replace(from, to);
    };
    const addAfter = (line, ...added) => edit(line, [line, ...added].join('\n'));
    const ID = '        id: coverage';
    const RUN = `        run: ${run}`;
    check(workflow);
    for (const [label, text] of [
      ['continue-on-error on the step', addAfter(ID, '        continue-on-error: true')],
      [
        'continue-on-error on the job',
        addAfter('    needs: [gate]', '    continue-on-error: true'),
      ],
      ['a condition on the step', addAfter(ID, "        if: github.event_name == 'push'")],
      [
        '`|| true` on a wrapped line',
        edit(RUN, `        run: >-\n          ${run}\n          || true`),
      ],
      [
        'a second suite run',
        addAfter('      - run: npm ci', '      - run: |', '          npx vitest run'),
      ],
      [
        'summarize without the outcome',
        edit(`          TEST_STEP_OUTCOME: \${{ steps.coverage.outcome }}\n`, ''),
      ],
    ])
      assert.throws(() => check(text), assert.AssertionError, label);
    // The same job in other plain styles: a trailing comment, a block scalar, a command wrapped
    // over lines, `- ` beside `steps:`, step settings that do not soften it, and Insights'
    // shard matrix with a folded job-level `if:`.
    for (const text of [
      edit(RUN, `${RUN}  # the gate`),
      edit(RUN, `        run: |\n          ${run}`),
      edit(
        RUN,
        `        run: >-\n          ${run.replace(' --reporter=json', '\n          --reporter=json')}`,
      ),
      workflow.replace(/^ {6}/gm, '    '),
      addAfter(
        ID,
        '        shell: bash',
        '        timeout-minutes: 30',
        '        continue-on-error: false',
        '        env:',
        '          NODE_OPTIONS: --max-old-space-size=6144',
      ),
      edit(
        '    runs-on: ubuntu-latest',
        [
          `    name: Workers suite shard \${{ matrix.shard }}/4`,
          '    if: >-',
          `      \${{ !cancelled()`,
          "          && needs.gate.outputs.tested != 'true' }}",
          '    runs-on: ubuntu-latest',
          '    strategy:',
          '      fail-fast: false',
          '      matrix:',
          '        shard: [1, 2, 3, 4]',
        ].join('\n'),
      ).replace(
        RUN,
        `        run: npm run test:coverage:shard -- --shard=\${{ matrix.shard }}/\${{ strategy.job-total }} --maxWorkers=2 ${run.replace('npm run test:coverage -- ', '')}`,
      ),
    ])
      check(text);
    const quoted = edit('        continue-on-error: true', "        continue-on-error: 'true'");
    assert.equal(profiledJobs(quoted)[0].step('upload')['continue-on-error'], 'true');
    assert.equal(profiledJobs(workflow)[0].step('upload').uses, 'actions/upload-artifact@v7');
  });

  it('records context before the suite, then summarizes and uploads even when it fails', () => {
    for (const { name, index, step } of profiledJobs()) {
      assert.ok(index.start < index.coverage, `\`${name}\`: start must clear old evidence first`);
      assert.ok(index.coverage < index.summarize && index.summarize < index.upload, name);
      assert.equal(step('start').if, undefined);
      assert.equal(step('summarize').if, ALWAYS_AFTER(step('coverage').id));
      assert.equal(step('upload').if, ALWAYS_AFTER(step('coverage').id));
    }
  });

  it("hands the summarizer the coverage step's own outcome, under the name it reads", () => {
    for (const { step } of profiledJobs()) {
      assert.deepEqual(step('summarize').env, {
        TEST_STEP_OUTCOME: `\${{ steps.${step('coverage').id}.outcome }}`,
      });
      for (const outcome of ['success', 'failure', 'cancelled']) {
        inTempDir('test-profile-outcome-', (directory) => {
          startProfile(directory, {}, 1000);
          const env = Object.fromEntries(
            Object.keys(step('summarize').env).map((key) => [key, outcome]),
          );
          assert.equal(summarizeProfile(directory, env, 1100).stepOutcome, outcome);
        });
      }
    }
  });

  it('uploads only the file summarize writes, from the hidden results folder, once per attempt', () => {
    for (const { name, step } of profiledJobs()) {
      const upload = step('upload').with;
      // A shard matrix adds its shard to the name; run id and attempt keep re-runs apart.
      assert.match(upload.name, /^test-profile-.*\$\{\{ github\.run_id \}\}/, name);
      assert.match(upload.name, /\$\{\{ github\.run_attempt \}\}/, name);
      assert.equal(upload['include-hidden-files'], 'true');
      assert.equal(upload['if-no-files-found'], 'error');
      assert.equal(upload['retention-days'], '14');
      // Exactly the normalized profile. The folder would also carry started.json and, after an
      // interrupted summarize, Vitest's raw report: titles, failure stacks, the coverage map.
      assert.equal(upload.path, PROFILE_PATH, `\`${name}\` uploads ${upload.path}`);
      inTempDir('test-profile-upload-', (directory) => {
        startProfile(directory, {}, 1000);
        summarizeProfile(directory, {}, 1100);
        assert.ok(statSync(join(directory, upload.path)).isFile());
      });
      // The artifact is evidence, never a merge input (docs/TESTING.md): an artifact-service
      // outage or quota must not turn the required check red. Summarize stays fail-closed.
      assert.equal(step('upload')['continue-on-error'], 'true', name);
      assert.equal(step('summarize')['continue-on-error'], undefined, name);
    }
  });

  it('local `npm run ci` runs the suite once, through test:profile', () => {
    checkLocalChain(SCRIPTS());
  });

  it('local `ci` refuses a test:profile that could pass without the suite or its floors', () => {
    const kit = {
      'test:coverage': 'vitest run --coverage',
      test: 'vitest run',
      'test:watch': 'vitest',
      'test:profile': 'node scripts/test-profile.mjs run',
      ci: 'npm run typecheck && npm run test:profile && npm run test:scripts',
    };
    checkLocalChain(kit);
    // Arena-2 names its coverage script; a fork's script may carry its own runner flags.
    checkLocalChain({
      ...kit,
      coverage: 'vitest run --coverage --pool=forks --silent',
      'test:profile': 'node scripts/test-profile.mjs run coverage',
      ci: 'npm run typecheck &&  npm run test:profile && npm run test:scripts',
    });
    for (const change of [
      // No coverage, so no floor: /ship would reuse this run as final-tree evidence.
      { 'test:profile': 'node scripts/test-profile.mjs run test' },
      // Bare `vitest` watches in a terminal, so local `ci` never finishes.
      { 'test:profile': 'node scripts/test-profile.mjs run test:watch' },
      { 'test:profile': 'node scripts/test-profile.mjs run missing' },
      { 'test:coverage': 'vitest run --coverage || true' },
      { 'test:coverage': 'vitest run --coverage --reporter=default||true' },
      { 'test:coverage': 'vitest run --coverage --exclude=test/isolation/**' },
      { 'test:coverage': 'vitest run --coverage --coverage.thresholds.lines=0' },
      { ci: 'npm run typecheck && npm run test:profile || true' },
      { ci: 'npm run test:profile && npm run test:coverage' },
      { ci: 'npm run typecheck && npm run test:coverage' },
      // Each ends `npm run ci` on a command after the suite's, so a red suite exits 0.
      { ci: 'npm run typecheck && npm run test:profile && npm run test:scripts; exit 0' },
      { ci: 'npm run typecheck && npm run test:profile && npm run test:scripts\nexit 0' },
      { ci: 'npm run typecheck && npm run test:profile && npm run test:scripts &' },
      { ci: 'npm run typecheck | tee typecheck.log && npm run test:profile' },
    ])
      assert.throws(
        () => checkLocalChain({ ...kit, ...change }),
        assert.AssertionError,
        JSON.stringify(change),
      );
  });

  it('/kit-upgrade carries the guide that the carried guidance links', () => {
    // CLAUDE.md, the Cursor rule, PLAYBOOKS, the skills and ci.yml all point at docs/TESTING.md.
    // A file both sides have is merged hunk by hunk there, so a fork keeps its own sections.
    const upgrade = readFileSync(
      join(REPO, '.claude', 'skills', 'kit-upgrade', 'SKILL.md'),
      'utf8',
    );
    const diffSet = upgrade.match(/git diff HEAD kit\/main -- ([^`]+)`/)?.[1].split(/\s+/) ?? [];
    assert.ok(diffSet.includes('docs/TESTING.md'), 'docs/TESTING.md is not in the diff set');
  });

  // End to end through the CLI and a real `npm run`, in a throwaway project whose coverage script
  // stands in for Vitest: it writes a passing report where it is told to, then exits with `exit`.
  // A clean environment keeps npm from resolving the outer repo (no inherited npm_* config), and
  // the update check off keeps it offline.
  function runCli(directory, args, env) {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        private: true,
        // Each script names itself, so a test can see which one the CLI ran.
        scripts: {
          'test:coverage': 'node fake-vitest.mjs test:coverage',
          coverage: 'node fake-vitest.mjs coverage',
        },
      }),
    );
    writeFileSync(
      join(directory, 'fake-vitest.mjs'),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const flag = '--outputFile.json=';",
        'const out = process.argv.find((arg) => arg.startsWith(flag)).slice(flag.length);',
        'mkdirSync(dirname(out), { recursive: true });',
        'const report = { startTime: Date.now(), success: true, numTotalTests: 0, testResults: [] };',
        'writeFileSync(out, JSON.stringify(report));',
        "writeFileSync('ran-script', process.argv[2]);",
        'process.exit(Number(process.env.FAKE_EXIT));',
      ].join('\n'),
    );
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: directory,
      env: { HOME: directory, npm_config_update_notifier: 'false', ...env },
      encoding: 'utf8',
    });
  }

  for (const [exit, script] of [
    [0, undefined],
    [3, undefined],
    [4, 'coverage'],
  ])
    it(`\`run${script ? ` ${script}` : ''}\` returns the coverage command's exit ${exit} and records its outcome`, () => {
      inTempDir('test-profile-cli-', (directory) => {
        const args = script ? ['run', script] : ['run'];
        const result = runCli(directory, args, { PATH: process.env.PATH, FAKE_EXIT: String(exit) });
        assert.equal(result.status, exit, result.stderr);
        const profile = JSON.parse(readFileSync(join(directory, PROFILE_PATH), 'utf8'));
        assert.equal(profile.reportStatus, 'available');
        assert.equal(profile.reportedSuccess, true);
        assert.equal(profile.stepOutcome, exit === 0 ? 'success' : 'failure');
        assert.equal(existsSync(join(directory, RAW_REPORT_PATH)), false);
        assert.equal(
          readFileSync(join(directory, 'ran-script'), 'utf8'),
          script ?? 'test:coverage',
        );
      });
    });

  it('`run` refuses a script argument that is not an npm script name', () => {
    inTempDir('test-profile-cli-', (directory) => {
      for (const args of [
        ['run', 'test:coverage && rm x'],
        ['run', 'a', 'b'],
      ]) {
        const result = runCli(directory, args, { PATH: process.env.PATH, FAKE_EXIT: '0' });
        assert.equal(result.status, 2, args.join(' '));
        assert.equal(existsSync(join(directory, '.test-results')), false);
        assert.equal(existsSync(join(directory, 'ran-script')), false);
      }
    });
  });

  it('under `npm run`, starts npm through npm_execpath, not whatever `npm` is on PATH', {
    skip:
      process.platform === 'win32' || !process.env.npm_execpath
        ? 'needs a POSIX shell for the decoy, and npm_execpath (set when npm runs the tests)'
        : false,
  }, () => {
    inTempDir('test-profile-cli-', (directory) => {
      // A decoy `npm` first on PATH: reached only if the wrapper ignores npm_execpath.
      const bin = join(directory, 'decoy-bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 97\n');
      chmodSync(join(bin, 'npm'), 0o755);
      const result = runCli(directory, ['run'], {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        npm_execpath: process.env.npm_execpath,
        FAKE_EXIT: '5',
      });
      assert.equal(result.status, 5, result.stderr);
    });
  });
});
