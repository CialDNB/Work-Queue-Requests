// Pins scripts/test-performance.mjs: the offline budget check that runs in test-gates, and the
// read-only observer that runs after every required check on a PR (.github/workflows/ci.yml,
// `test-performance` job). The observer is evidence, never a gate: these tests pin that it
// counts the right jobs, compares only runs that executed the same configuration, and reports
// "unavailable" or "not adopted" rather than inventing a green trend. And the /kit-upgrade audit
// (`audit`): which observer reports trigger it, its one closeout line, and its draft.
//
// Every case about job names, shard counts and limits runs on KIT, a budget written here, never
// on the app's own test-performance-budget.json. That file belongs to the app after adoption: a
// sharded fork names its own jobs, shard count and limits, and a carried test that read it would
// fail there (#257 review F5). The app's own file is only checked for validity and against its
// own workflow's job names; in the unforked kit it must also exist, with the layout KIT models
// (#287 review F7). Run by `node --test` (test:scripts), like its siblings.
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseJsonc, TEMPLATE_KEBAB } from '../../scripts/new-app.mjs';
import {
  auditLine,
  auditMarkdown,
  auditTrigger,
  collectPerformance,
  configOutput,
  evaluateTrend,
  fingerprint,
  githubReader,
  performanceSummary,
  readBudget,
  readManifests,
  runMetrics,
  unavailableReport,
  validateBudget,
  workflowProblems,
} from '../../scripts/test-performance.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'test-performance.mjs');
// Set when this file runs inside the fork simulation below, so it does not simulate again.
const CARRIED = process.env.TEST_PERFORMANCE_CARRIED === '1';
const readOr = (path, fallback) => {
  try {
    return readFileSync(join(ROOT, path), 'utf8');
  } catch {
    return fallback;
  }
};
// The unforked kit, whose wrangler.jsonc still carries the template's name (the signal
// ci-parallel-runtime.test.mjs reads). The kit's budget is its own, so there it must exist.
const IN_KIT = parseJsonc(readOr('wrangler.jsonc', '{}'))?.name === TEMPLATE_KEBAB;

// The kit's topology, as a fixture: five required jobs and one unsharded suite job.
const KIT = validateBudget({
  schemaVersion: 1,
  focusedSeconds: 60,
  fullGateSeconds: 300,
  gateRunnerMinutes: 15,
  regressionPercent: 20,
  windowSize: 3,
  historyLimit: 12,
  shardImbalanceRatio: 1.5,
  workflowPath: '.github/workflows/ci.yml',
  requiredJobs: ['test-gates', 'test', 'actionlint', 'secrets-scan', 'semgrep'],
  suiteJobPrefix: 'test-suite',
  expectedSuiteJobs: 1,
  comparisonFiles: [
    '.github/workflows/ci.yml',
    'package-lock.json',
    'vitest.config.ts',
    'test/projects.mjs',
    'test/runtime/minimal-worker.ts',
    'test/runtime/wrangler.test-minimal.jsonc',
    'test/setup/node-no-network.ts',
    'wrangler.test.jsonc',
    'test-performance-budget.json',
  ],
});
// The same budget in an app without the runtime split: its comparison files name no manifest,
// minimal runtime or Node setup, since it has none.
const UNSPLIT = validateBudget({
  ...KIT,
  comparisonFiles: KIT.comparisonFiles.filter(
    (path) => !/^test\/(?:projects\.mjs$|runtime\/|setup\/)/.test(path),
  ),
});
const c = KIT;
const HEAD = 'a'.repeat(40);
// A pull_request run executes the merge commit (GITHUB_SHA), not the PR head.
const MERGE = 'e'.repeat(40);
const REPO = 'synthetic/repo';
const ENV = {
  GITHUB_REPOSITORY: REPO,
  GITHUB_RUN_ID: '100',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_SHA: MERGE,
};
const run = {
  event: 'pull_request',
  id: 100,
  run_attempt: 2,
  head_sha: HEAD,
  created_at: '2026-10-10T10:00:00Z',
  workflow_id: 10,
  path: c.workflowPath,
  head_repository: { full_name: REPO },
};
const job = (name, duration = 60, of = run, start = '2026-10-10T10:00:10Z') => ({
  name,
  run_id: of.id,
  run_attempt: of.run_attempt,
  head_sha: of.head_sha,
  status: 'completed',
  conclusion: 'success',
  labels: ['ubuntu-latest'],
  started_at: start,
  completed_at: new Date(Date.parse(start) + duration * 1000).toISOString(),
  runner_name: 'private-runner',
  steps: [{ name: 'secret-like text' }],
});
const jobsOf = (of = run, start = undefined) => [
  ...c.requiredJobs.map((name) => job(name, 60, of, start)),
  job(c.suiteJobPrefix, 120, of, start),
];
const jobs = jobsOf();
const tree = {
  truncated: false,
  tree: [
    ...c.comparisonFiles.map((path, i) => ({
      path,
      type: 'blob',
      sha: i.toString(16).padStart(40, '0'),
    })),
    { path: 'src/index.ts', type: 'blob', sha: 'f'.repeat(40) },
  ],
};
const sample = (id, seconds, cost = seconds / 60, key = 'same', imbalance = 1) => ({
  runId: id,
  attempt: 1,
  createdAt: new Date(Date.UTC(2026, 9, 10, 0, id)).toISOString(),
  comparisonKey: key,
  fullGateSeconds: seconds,
  gateRunnerMinutes: cost,
  shardImbalanceRatio: imbalance,
});
// A workflow that runs a budget's jobs under the names Actions shows: each required job by its
// id, and the suite job by the prefix.
const workflowOf = (budget) =>
  [
    'name: CI',
    'on: pull_request',
    'jobs:',
    ...[...budget.requiredJobs, budget.suiteJobPrefix].flatMap((id) => [
      `  ${id}:`,
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: node scripts/test-performance.mjs check',
    ]),
    '',
  ].join('\n');

// A sharded fork's own workflow, for the simulation at the end: an extra required gate, and 8
// shards under a display name, as insights names its 4.
const FORK_CI = `name: CI
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  test-gates:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/test-performance.mjs check
  test-shard:
    name: Workers suite shard \${{ matrix.shard }}/8
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4, 5, 6, 7, 8]
    steps:
      - name: Run one shard
        run: npm run test:coverage -- --shard=\${{ matrix.shard }}/8
  test:
    needs: [test-gates, test-shard]
    runs-on: ubuntu-latest
    steps:
      - run: test "\${{ needs.test-shard.result }}" = success
  codeql:
    runs-on: ubuntu-latest
    steps:
      - run: echo analyze
  semgrep:
    runs-on: ubuntu-latest
    steps:
      - run: echo scan
  actionlint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
  secrets-scan:
    runs-on: ubuntu-latest
    steps:
      - run: echo scan
  test-performance:
    needs: [test, codeql, semgrep, actionlint, secrets-scan]
    runs-on: ubuntu-latest
    steps:
      - id: observe
        run: node scripts/test-performance.mjs ci
      - uses: actions/upload-artifact@v7
        with:
          name: test-performance-\${{ github.run_id }}-\${{ github.run_attempt }}-\${{ steps.observe.outputs.config }}
`;

// The CLI in a throwaway directory, with nothing from this checkout but the script.
function inTemp(body) {
  const root = mkdtempSync(join(tmpdir(), 'test-performance-'));
  const invoke = (mode, env = {}, args = []) =>
    spawnSync(process.execPath, [SCRIPT, mode, ...args], {
      cwd: root,
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
    });
  try {
    return body(root, invoke);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const write = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
// A stub `gh` for /kit-upgrade step 2's command: `run list`, a run's artifact names, and
// `run download --pattern`, which puts each artifact in <dir>/<artifact name>/ as gh does for a
// pattern. It serves GH_STUB_RUNS: the runs, newest first, each with its artifacts' reports.
const GH_STUB = String.raw`import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const runs = JSON.parse(readFileSync(process.env.GH_STUB_RUNS, 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const artifacts = (id) => runs.find((r) => String(r.id) === id)?.artifacts ?? {};
if (args[0] === 'run' && args[1] === 'list') {
  for (const r of runs) console.log(r.id + '-' + r.attempt);
} else if (args[0] === 'api' && /\/runs\/\d+\/artifacts\?/.test(args[1])) {
  for (const name of Object.keys(artifacts(/\/runs\/(\d+)\//.exec(args[1])[1]))) console.log(name);
} else if (args[0] === 'run' && args[1] === 'download' && /^[^*]+\*$/.test(flag('--pattern'))) {
  const prefix = flag('--pattern').slice(0, -1);
  const found = Object.entries(artifacts(args[2])).filter(([name]) => name.startsWith(prefix));
  if (!found.length) {
    console.error('no valid artifacts found to download');
    process.exit(1);
  }
  for (const [name, report] of found) {
    mkdirSync(join(flag('--dir'), name), { recursive: true });
    writeFileSync(join(flag('--dir'), name, 'test-performance.json'), JSON.stringify(report));
  }
} else {
  console.error('gh stub: unexpected ' + args.join(' '));
  process.exit(64);
}
`;
const adopt = (root, budget = c) => {
  for (const path of budget.comparisonFiles) write(root, path, 'synthetic');
  write(root, budget.workflowPath, workflowOf(budget));
  write(root, 'test-performance-budget.json', JSON.stringify(budget));
};
// The fields that say which jobs and files the observer reads, as opposed to its limits.
const LAYOUT = [
  'workflowPath',
  'requiredJobs',
  'suiteJobPrefix',
  'expectedSuiteJobs',
  'comparisonFiles',
];

describe("the app's own budget", () => {
  // #287 review F7: in the kit, a moved or deleted budget passed `check` on a notice and turned
  // every observation into "not adopted", with every test green. A fork may still go without one.
  it('is valid, names jobs the workflow runs and files that exist; the kit has one', (t) => {
    const own = readBudget(ROOT);
    if (IN_KIT) {
      assert.notEqual(own, null, 'the kit has no test-performance-budget.json');
      // KIT models the kit's own layout, so the job-layout cases test the layout that ships.
      for (const key of LAYOUT)
        assert.deepEqual(own[key], KIT[key], `KIT.${key} has drifted from the kit's budget`);
    } else if (own === null)
      t.diagnostic('no test-performance-budget.json: this app has not adopted one');
    else assert.equal(validateBudget(own), own);
  });
});

describe('budget validation', () => {
  it('refuses disabled or invalid limits and an incomplete comparison identity', () => {
    for (const patch of [
      { fullGateSeconds: 0 },
      { gateRunnerMinutes: Number.NaN },
      { regressionPercent: -1 },
      { windowSize: 1 },
      { historyLimit: 2 },
      { expectedSuiteJobs: 0 },
      { comparisonFiles: ['package-lock.json'] },
      { comparisonFiles: [...c.comparisonFiles, '../secret'] },
      { requiredJobs: ['test', 'test'] },
      { suiteJobPrefix: 'test' },
      { suiteJobPrefix: '' },
      { suiteJobPrefix: ' test-suite' },
      { suiteJobPrefix: 'Workers  suite' },
      // A required job the suite prefix would also count.
      { requiredJobs: [...c.requiredJobs, 'test-suite merge'] },
    ])
      assert.throws(() => validateBudget({ ...c, ...patch }), JSON.stringify(patch));
    // A suite job's display name, as insights names its shards.
    assert.doesNotThrow(() => validateBudget({ ...c, suiteJobPrefix: 'Workers suite shard' }));
  });
});

// #287 review F4: nothing compared the budget's job names with the workflow, so a renamed,
// display-named or sharded job turned every observation "unavailable" while `check` passed.
describe("the budget's jobs in its workflow", () => {
  it('refuses a job name the workflow does not show exactly once', () => {
    const kit = workflowOf(c);
    assert.deepEqual(workflowProblems(c, kit), []);
    for (const [label, text, budget, refusal] of [
      [
        'a required job given a display name',
        kit.replace('  semgrep:\n', '  semgrep:\n    name: static analysis\n'),
        c,
        /^requiredJobs: semgrep is the name of 0 jobs/,
      ],
      [
        'two jobs shown under one required name',
        kit.replace('  test-gates:\n', '  test-gates:\n    name: semgrep\n'),
        c,
        /^requiredJobs: semgrep is the name of 2 jobs/,
      ],
      ['the suite job renamed', kit.replace('  test-suite:\n', '  suite:\n'), c, /^suiteJobPrefix/],
      [
        'the suite job given a display name',
        kit.replace('  test-suite:\n', '  test-suite:\n    name: Workers suite\n'),
        c,
        /^suiteJobPrefix: no job .* is named test-suite/,
      ],
      ['a prefix the workflow lacks', kit, { ...c, suiteJobPrefix: 'suite' }, /^suiteJobPrefix/],
      [
        'a required check from another workflow',
        kit,
        { ...c, requiredJobs: [...c.requiredJobs, 'codeql'] },
        /^requiredJobs: codeql is the name of 0 jobs/,
      ],
      [
        'a job id outside `jobs:`',
        kit.replace('jobs:\n', 'env:\n  codeql: x\njobs:\n'),
        { ...c, requiredJobs: [...c.requiredJobs, 'codeql'] },
        /^requiredJobs: codeql/,
      ],
    ]) {
      const problems = workflowProblems(budget, text);
      assert.ok(
        problems.some((problem) => refusal.test(problem)),
        `${label}: ${JSON.stringify(problems)}`,
      );
    }
  });

  it("accepts a matrix under its id, and a shard job's display name before the shard", () => {
    const kit = workflowOf(c);
    const matrix = kit.replace(
      '  test-suite:\n',
      '  test-suite: # the suite\n    strategy:\n      matrix:\n        shard: [1, 2]\n',
    );
    assert.deepEqual(workflowProblems({ ...c, expectedSuiteJobs: 2 }, matrix), []);
    const shards = { ...c, suiteJobPrefix: 'Workers suite shard', expectedSuiteJobs: 4 };
    for (const name of [
      `Workers suite shard \${{ matrix.shard }}/4`,
      `"Workers suite shard \${{ matrix.shard }}/4" # quoted`,
    ]) {
      const named = workflowOf(c).replace(
        '  test-suite:\n',
        `  test-shard:\n    name: ${name}\n    strategy:\n      matrix:\n        shard: [1, 2, 3, 4]\n`,
      );
      assert.deepEqual(workflowProblems(shards, named), [], name);
    }
    // A step's `name:` is not the job's.
    const step = kit.replace(
      '  semgrep:\n    runs-on: ubuntu-latest\n    steps:\n',
      '  semgrep:\n    runs-on: ubuntu-latest\n    steps:\n      - name: static analysis\n',
    );
    assert.deepEqual(workflowProblems(c, step), []);
  });

  // #287 review R1: the check matched the suite job's name but never its count, so a suite
  // sharded in place, or a fork's shard count changed, passed `check` while every observation
  // refused the run ("Missing/duplicate suite jobs").
  const strategy = (...lines) =>
    workflowOf(c).replace(
      '  test-suite:\n',
      `  test-suite:\n    strategy:\n${lines.map((l) => `      ${l}\n`).join('')}`,
    );
  const fork = {
    ...c,
    requiredJobs: [...c.requiredJobs, 'codeql'],
    suiteJobPrefix: 'Workers suite shard',
  };
  it('refuses a suite-job count other than the one its matrix shows', () => {
    for (const [label, text, budget, refusal] of [
      [
        "the kit's test-suite sharded in place, the budget left at 1",
        strategy('matrix:', '  shard: [1, 2, 3, 4]'),
        c,
        /^expectedSuiteJobs: .* runs 4 suite jobs, not 1/,
      ],
      [
        'a fork that went from 4 shards to 8, the budget left at 4',
        FORK_CI,
        { ...fork, expectedSuiteJobs: 4 },
        /^expectedSuiteJobs: .* runs 8 suite jobs, not 4/,
      ],
      [
        'a fork that stopped sharding, the budget left at 4',
        workflowOf(fork).replace(
          '  Workers suite shard:\n',
          '  test-suite:\n    name: Workers suite shard\n',
        ),
        { ...fork, expectedSuiteJobs: 4 },
        /^expectedSuiteJobs: .* runs 1 suite job, not 4/,
      ],
    ]) {
      const problems = workflowProblems(budget, text);
      assert.ok(
        problems.some((problem) => refusal.test(problem)),
        `${label}: ${JSON.stringify(problems)}`,
      );
    }
    assert.deepEqual(workflowProblems({ ...fork, expectedSuiteJobs: 8 }, FORK_CI), []);
  });

  it('counts a single list of values, and leaves a matrix it cannot read uncounted', () => {
    // Quoted values, a comment, and strategy keys around the matrix.
    const two = strategy(
      'max-parallel: 2',
      'matrix: # two shards',
      `  shard: ['1, of 2', "2"] # two`,
      'fail-fast: false',
    );
    assert.deepEqual(workflowProblems({ ...c, expectedSuiteJobs: 2 }, two), []);
    assert.ok(workflowProblems(c, two).some((p) => /^expectedSuiteJobs: .* runs 2 /.test(p)));
    // Shapes whose count the text does not show: never refused for it.
    for (const [label, lines] of [
      ['include', ['matrix:', '  include:', '    - shard: 1', '    - shard: 2']],
      ['exclude', ['matrix:', '  shard: [1, 2, 3]', '  exclude:', '    - shard: 3']],
      [
        'a planned axis, as arena-go sizes its vitest shards',
        ['matrix:', `  shard: \${{ fromJSON(needs.plan.outputs.vitest_shards) }}`],
      ],
      ['a planned matrix', [`matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}`]],
      ['several axes', ['matrix:', '  shard: [1, 2]', '  node: [20, 22]']],
      ['a block list', ['matrix:', '  shard:', '    - 1', '    - 2']],
    ])
      assert.deepEqual(
        workflowProblems({ ...c, expectedSuiteJobs: 3 }, strategy(...lines)),
        [],
        label,
      );
  });
});

describe('run metrics', () => {
  it('complete gate wall time is not the sum of parallel job times; cost counts both', () => {
    const m = runMetrics(run, jobs, c, 'configuration');
    assert.equal(m.fullGateSeconds, 120);
    assert.equal(m.initialQueueSeconds, 10);
    assert.equal(m.gateRunnerMinutes, 7);
    assert.equal(m.suiteRunnerMinutes, 2);
    assert.equal(m.configHash, 'configuration');
    assert.equal(m.headSha, HEAD);
    assert.equal(JSON.stringify(m).includes('private-runner'), false);
    assert.equal(JSON.stringify(m).includes('secret-like text'), false);
  });

  // #257 review F12: created_at is fixed at the first attempt, so a re-run 40 minutes later
  // reported about 2,400 s of queue.
  it("measures a re-run's queue from its own start, not from the first attempt's creation", () => {
    const rerun = { ...run, run_started_at: '2026-10-10T10:40:00Z' };
    const m = runMetrics(rerun, jobsOf(rerun, '2026-10-10T10:40:10Z'), c, 'configuration');
    assert.equal(m.initialQueueSeconds, 10);
    assert.equal(m.fullGateSeconds, 120);
    assert.equal(m.createdAt, run.created_at);
    // A run object without run_started_at falls back to created_at.
    assert.equal(runMetrics(run, jobs, c, 'configuration').initialQueueSeconds, 10);
    assert.throws(
      () => runMetrics({ ...rerun, run_started_at: 'invalid' }, jobs, c, 'h'),
      /start time/,
    );
  });

  // #287 review F1: "Re-run failed jobs" lists the jobs it carried over under the new attempt,
  // with their first attempt's times. Counted, they stretched the complete gate across both
  // attempts and the wait between them, and the queue read 0.
  it("refuses a partial re-run, whose carried-over jobs keep their first attempt's times", () => {
    const rerun = { ...run, run_started_at: '2026-10-10T10:40:00Z' };
    const carried = [
      ...c.requiredJobs.map((name) => job(name, 60, rerun)),
      job(c.suiteJobPrefix, 120, rerun, '2026-10-10T10:40:10Z'),
    ];
    assert.throws(() => runMetrics(rerun, carried, c, 'configuration'), /Partial re-run/);
    // A few seconds between the run's clock and a job's is not an earlier attempt.
    const skewed = runMetrics(rerun, jobsOf(rerun, '2026-10-10T10:39:58Z'), c, 'configuration');
    assert.equal(skewed.initialQueueSeconds, 0);
    assert.equal(skewed.fullGateSeconds, 120);
  });

  // #287 review F2: a shard job with its own `name:` is listed by that name, with the matrix
  // values filled in (insights: `Workers suite shard 1/4`), never by its id.
  it('counts shard jobs listed by their display name', () => {
    const named = validateBudget({
      ...c,
      suiteJobPrefix: 'Workers suite shard',
      expectedSuiteJobs: 4,
    });
    const shards = [1, 2, 3, 4].map((n) => job(`Workers suite shard ${n}/4`, 60 * n));
    const m = runMetrics(
      run,
      [...jobs.slice(0, -1), ...shards, job('Workers suite sharding report')],
      named,
      'one',
    );
    assert.equal(m.suiteJobs, 4);
    assert.equal(m.suiteRunnerMinutes, 10);
  });

  it('failed, skipped, stale, missing and duplicate jobs cannot provide performance evidence', () => {
    for (const patch of [
      { conclusion: 'failure' },
      { conclusion: 'skipped' },
      { status: 'in_progress' },
      { run_id: 99 },
      { run_attempt: 1 },
      { head_sha: 'b'.repeat(40) },
      { started_at: null },
      { completed_at: 'invalid' },
      { labels: [] },
    ])
      assert.throws(() => runMetrics(run, [{ ...jobs[0], ...patch }, ...jobs.slice(1)], c, 'hash'));
    assert.throws(() => runMetrics(run, jobs.slice(1), c, 'hash'));
    assert.throws(() => runMetrics(run, [...jobs, jobs[0]], c, 'hash'));
    assert.throws(() => runMetrics(run, jobs.slice(0, -1), c, 'hash'));
    assert.throws(() => runMetrics(run, [...jobs, job(`${c.suiteJobPrefix} (2)`)], c, 'hash'));
  });

  it('changed configuration, runner class and matrix size start separate histories', () => {
    assert.notEqual(
      runMetrics(run, jobs, c, 'one').comparisonKey,
      runMetrics(run, jobs, c, 'two').comparisonKey,
    );
    assert.notEqual(
      runMetrics(run, jobs, c, 'one').comparisonKey,
      runMetrics(
        run,
        jobs.map((j) => ({ ...j, labels: ['larger-runner'] })),
        c,
        'one',
      ).comparisonKey,
    );
    const matrix = [
      ...jobs.slice(0, -1),
      job(`${c.suiteJobPrefix} (1)`, 60),
      job(`${c.suiteJobPrefix} (2)`, 180),
    ];
    const m = runMetrics(run, matrix, { ...c, expectedSuiteJobs: 2 }, 'one');
    assert.equal(m.suiteJobs, 2);
    assert.equal(m.shardImbalanceRatio, 1.5);
    assert.equal(m.suiteRunnerMinutes, 4);
  });
});

describe('configuration fingerprints', () => {
  it('ignore discovery order but reject missing or truncated trees', () => {
    assert.equal(fingerprint(tree, c), fingerprint({ ...tree, tree: [...tree.tree].reverse() }, c));
    assert.throws(() => fingerprint({ ...tree, truncated: true }, c));
    assert.throws(() => fingerprint({ ...tree, tree: tree.tree.slice(1) }, c));
  });

  // #257 review F17: no case fed trees whose contents differ, so a fingerprint of the paths
  // alone kept every test green.
  it("change when a comparison file's contents change, and only then", () => {
    const changed = (path, sha) => ({
      ...tree,
      tree: tree.tree.map((entry) => (entry.path === path ? { ...entry, sha } : entry)),
    });
    assert.notEqual(
      fingerprint(changed('vitest.config.ts', 'd'.repeat(40)), c),
      fingerprint(tree, c),
    );
    assert.equal(fingerprint(changed('src/index.ts', 'd'.repeat(40)), c), fingerprint(tree, c));
  });
});

describe('trends', () => {
  it('one outlier does not warn; sustained latency and capacity regressions do', () => {
    const history = [
      sample(5, 100),
      sample(4, 100),
      sample(3, 100),
      sample(2, 100),
      sample(1, 100),
    ];
    const quiet = evaluateTrend(sample(6, 1000), history, c);
    assert.deepEqual(quiet.warnings, []);
    assert.equal(quiet.metrics.fullGateSeconds.rollingMedian, 100);
    const sustained = evaluateTrend(
      sample(6, 500, 30),
      [sample(5, 500, 30), ...history.slice(1)],
      c,
    );
    assert.equal(sustained.status, 'investigate');
    assert.ok(sustained.warnings.includes('fullGateSeconds: sustained budget exceeded'));
    assert.ok(sustained.warnings.includes('gateRunnerMinutes: sustained regression exceeds 20%'));
  });

  it('short history warms up, excludes incompatible, future and duplicate runs, and keeps windows apart', () => {
    assert.equal(evaluateTrend(sample(6, 1000), [], c).status, 'warming-up');
    const h = [sample(5, 100), sample(4, 100), sample(3, 100), sample(2, 100), sample(1, 100)];
    const r = evaluateTrend(
      sample(6, 100),
      [...h, sample(5, 999), sample(7, 999), sample(0, 999, 999, 'other')],
      c,
    );
    assert.equal(r.comparableRuns, 5);
    assert.deepEqual(r.recentRunIds, [6, 5, 4]);
    assert.deepEqual(r.baselineRunIds, [3, 2, 1]);
  });

  // #287 review F10: every sample had a ratio of 1, so dropping the key, or turning its budget
  // check into a relative one, kept the suite green.
  it('warns of sustained shard imbalance against its limit, never as a relative regression', () => {
    const skewed = (id) => sample(id, 100, undefined, 'same', 2);
    const r = evaluateTrend(
      skewed(6),
      [skewed(5), skewed(4), sample(3, 100), sample(2, 100), sample(1, 100)],
      c,
    );
    assert.deepEqual(r.warnings, ['shardImbalanceRatio: sustained budget exceeded']);
    assert.equal(r.metrics.shardImbalanceRatio.rollingMedian, 2);
    assert.equal(r.metrics.shardImbalanceRatio.baselineMedian, 1);
  });
});

describe('the observer', () => {
  it('keeps credentials on the fixed origin and never prints response bodies', async () => {
    const get = githubReader(REPO, 'synthetic-token', async (url, options) => {
      assert.ok(url.startsWith(`https://api.github.com/repos/${REPO}/`));
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, 'Bearer synthetic-token');
      return { ok: false, status: 403, json: async () => ({ message: 'secret-like text' }) };
    });
    await assert.rejects(get('actions/runs/100'), /HTTP 403/);
    assert.throws(() => githubReader('../elsewhere', 'token'));
  });

  // #257 review F15: a PR run executes the merge commit. Fingerprinting the PR head files a run
  // that ran main's newer lockfile or config under the head's older configuration.
  it('fingerprints the merge commit the run executed, and publishes it with the observation', async () => {
    let pages = 0;
    const calls = [];
    const get = async (p) => {
      calls.push(p);
      if (p === 'actions/runs/100') return run;
      if (p === `git/trees/${MERGE}?recursive=1`) return tree;
      if (p.includes('/attempts/2/jobs')) {
        pages++;
        return {
          total_count: jobs.length,
          jobs: p.endsWith('page=1') ? jobs.slice(0, 2) : jobs.slice(2),
        };
      }
      if (p.startsWith('actions/workflows/'))
        return { workflow_runs: [{ ...run, id: 99, status: 'completed', conclusion: 'failure' }] };
      throw new Error(`Unexpected mock path ${p}`);
    };
    const report = await collectPerformance(c, ENV, get);
    assert.equal(pages, 2);
    assert.equal(report.observationStatus, 'available');
    assert.equal(report.trend.status, 'warming-up');
    assert.equal(report.current.sha, MERGE);
    assert.equal(report.current.headSha, HEAD);
    assert.equal(report.current.configHash, fingerprint(tree, c));
    assert.deepEqual(
      calls.filter((p) => p.startsWith('git/trees/')),
      [`git/trees/${MERGE}?recursive=1`],
    );
    assert.equal(
      calls.some((p) => p.includes('/99/')),
      false,
    );
    const summary = performanceSummary(report);
    assert.match(
      summary,
      new RegExp(`configuration ${report.current.configHash.slice(0, 12)}`, 'i'),
    );
    assert.match(summary, new RegExp(`merge commit ${MERGE.slice(0, 12)}`, 'i'));
    for (const sha of [undefined, '', 'HEAD', 'e'.repeat(39)])
      await assert.rejects(collectPerformance(c, { ...ENV, GITHUB_SHA: sha }, get), /identity/);
  });

  // #287 review F9: only the reader's half of the cross-run key was tested. Writing anything but
  // the fingerprint to GITHUB_OUTPUT left every later run without comparable history.
  it("publishes the fingerprint a later run reads back from the artifact's name", async (t) => {
    const tree100 = (p) => (p === `git/trees/${MERGE}?recursive=1` ? tree : undefined);
    const first = await collectPerformance(c, ENV, async (p) => {
      if (p === 'actions/runs/100') return run;
      if (p.includes('/attempts/2/jobs')) return { total_count: jobs.length, jobs };
      if (p.startsWith('actions/workflows/')) return { workflow_runs: [] };
      return tree100(p) ?? assert.fail(`Unexpected mock path ${p}`);
    });
    const output = configOutput(first);
    assert.equal(output, `config=${first.current.configHash}\n`);
    assert.equal(configOutput({ observationStatus: 'unavailable' }), 'config=unavailable\n');
    // The upload step's name, as this repo's workflow writes it.
    const template = /^\s*name: (test-performance-\S*\$\{\{.*)$/m.exec(
      readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
    )?.[1];
    if (!template) {
      assert.equal(IN_KIT, false, "the kit's ci.yml uploads no test-performance artifact");
      return t.diagnostic('this workflow has no observer, so no artifact name to read back');
    }
    const name = template
      .replaceAll(`\${{ github.run_id }}`, String(run.id))
      .replaceAll(`\${{ github.run_attempt }}`, String(run.run_attempt))
      .replace(/\$\{\{ steps\.[\w-]+\.outputs\.config \}\}/, output.slice('config='.length, -1));
    const later = {
      ...run,
      id: 200,
      run_attempt: 1,
      created_at: '2026-10-10T11:00:00Z',
    };
    const second = await collectPerformance(
      c,
      { ...ENV, GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '1' },
      async (p) => {
        if (p === 'actions/runs/200') return later;
        if (p.includes('/200/attempts/1/jobs')) {
          const own = jobsOf(later, '2026-10-10T11:00:10Z');
          return { total_count: own.length, jobs: own };
        }
        if (p.includes('/100/attempts/2/jobs')) return { total_count: jobs.length, jobs };
        if (p === 'actions/runs/100/artifacts?per_page=100')
          return { total_count: 1, artifacts: [{ name }] };
        if (p.startsWith('actions/workflows/'))
          return {
            workflow_runs: [later, { ...run, status: 'completed', conclusion: 'success' }],
          };
        return tree100(p) ?? assert.fail(`Unexpected mock path ${p}`);
      },
    );
    assert.equal(second.excludedHistoryRuns, 0);
    assert.equal(second.trend.comparableRuns, 1);
  });

  // #257 review F17: the only history case was one failed run, which the filter drops, so the
  // history bound, the same-repo filter and the configuration comparison never ran.
  it("compares only bounded same-repo history that published this run's configuration", async () => {
    const hash = fingerprint(tree, c);
    const other = 'b'.repeat(64);
    const past = (id, fields = {}) => ({
      ...run,
      id,
      run_attempt: 1,
      head_sha: `${id}`.padStart(40, 'c'),
      status: 'completed',
      conclusion: 'success',
      // Older runs have lower ids; every one of them was created before this run.
      created_at: new Date(Date.parse(run.created_at) - (120 - id) * 60000).toISOString(),
      ...fields,
    });
    // Newest first, as the API lists them: 13 eligible runs (50..38) for a limit of 12. Run 39's
    // second attempt re-ran only its failed jobs, so its others keep the first attempt's times.
    const eligible = Array.from({ length: 13 }, (_, i) =>
      past(50 - i, 50 - i === 39 ? { run_attempt: 2, run_started_at: '2026-10-10T10:30:00Z' } : {}),
    );
    const listed = [
      run,
      past(101, { created_at: '2026-10-10T11:00:00Z' }),
      past(99, { conclusion: 'failure' }),
      past(98, { head_repository: { full_name: 'fork/repo' } }),
      past(97, { path: '.github/workflows/other.yml' }),
      ...eligible,
    ];
    // What each run's artifact listing holds, beside its timing profile: by default, its own
    // observation of this configuration. 45 observed another configuration, 44 published none,
    // 42 holds only another run's observation and 41 only another attempt's.
    const published = {
      45: [`test-performance-45-1-${other}`],
      44: [],
      42: [`test-performance-41-1-${hash}`],
      41: [`test-performance-41-2-${hash}`],
      39: [`test-performance-39-2-${hash}`],
    };
    const calls = [];
    const get = async (p) => {
      calls.push(p);
      if (p === 'actions/runs/100') return run;
      if (p === `git/trees/${MERGE}?recursive=1`) return tree;
      if (p.startsWith('actions/workflows/')) return { workflow_runs: listed };
      const artifacts = /^actions\/runs\/(\d+)\/artifacts\?per_page=100$/.exec(p);
      if (artifacts) {
        const id = Number(artifacts[1]);
        const names = published[id] ?? [`test-performance-${id}-1-${hash}`];
        return {
          total_count: names.length + 1,
          artifacts: [`test-profile-${id}-1`, ...names].map((name) => ({ name })),
        };
      }
      const attempt = /^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/.exec(p);
      if (attempt) {
        const of =
          Number(attempt[1]) === 100 ? run : listed.find((r) => r.id === Number(attempt[1]));
        const own = jobsOf(of);
        // Run 43 published the same configuration, but one of its gates did not succeed.
        if (of.id === 43) own[0] = { ...own[0], conclusion: 'failure' };
        return { total_count: own.length, jobs: own };
      }
      throw new Error(`Unexpected mock path ${p}`);
    };
    const report = await collectPerformance(c, ENV, get);
    // Examined: 50..39. Excluded: 45, 44, 42 and 41 (no observation of this configuration under
    // their own name), 43 (a red gate) and 39 (a partial re-run).
    assert.equal(report.trend.comparableRuns, 6);
    assert.equal(report.excludedHistoryRuns, 6);
    assert.equal(report.trend.status, 'within-budget');
    assert.deepEqual(report.trend.recentRunIds, [100, 50, 49]);
    assert.deepEqual(report.trend.baselineRunIds, [48, 47, 46]);
    const touched = (id) => calls.filter((p) => p.startsWith(`actions/runs/${id}/`));
    // Filtered before any call: future, failed, foreign, other workflow, and past the limit.
    for (const id of [101, 99, 98, 97, 38]) assert.deepEqual(touched(id), [], `run ${id}`);
    // Another configuration is excluded on its published name alone: no jobs are read.
    for (const id of [45, 44, 42, 41])
      assert.deepEqual(touched(id), [`actions/runs/${id}/artifacts?per_page=100`]);
    assert.equal(touched(50).length, 2);
    assert.deepEqual(touched(39), [
      'actions/runs/39/artifacts?per_page=100',
      'actions/runs/39/attempts/2/jobs?per_page=100&page=1',
    ]);
    // History is never re-fingerprinted from a PR head: the only tree read is this run's.
    assert.deepEqual(
      calls.filter((p) => p.startsWith('git/trees/')),
      [`git/trees/${MERGE}?recursive=1`],
    );
  });

  it('stays unavailable on incomplete pagination and a wrong workflow identity', async () => {
    await assert.rejects(
      collectPerformance(c, ENV, async () => ({ ...run, run_attempt: 1 })),
      /identity/,
    );
    await assert.rejects(
      collectPerformance(c, ENV, async (p) =>
        p === 'actions/runs/100'
          ? run
          : p.startsWith('git/trees/')
            ? tree
            : { jobs: [], total_count: 100 },
      ),
      /pagination/,
    );
    assert.match(
      performanceSummary({ observationStatus: 'unavailable' }),
      /no timing success or regression can be inferred/,
    );
    // The reason names what was missing, never a response body.
    assert.equal(
      unavailableReport(new Error('Invalid run identity')).reason,
      'Invalid run identity',
    );
    let parseError;
    try {
      JSON.parse('<html>secret-like text</html>');
    } catch (error) {
      parseError = error;
    }
    const report = unavailableReport(parseError);
    assert.equal(report.reason, 'Malformed API response');
    assert.doesNotMatch(performanceSummary(report), /secret-like/);
  });
});

// The /kit-upgrade audit (DECISIONS 2026-10-22, option B): every upgrade records the observer's
// latest status in one line, and the dated audit is required only when that status warns. The
// expected triggers below come from the decision's text, not from the script: a sustained budget
// overrun, a sustained regression above the budget's regressionPercent, or one complete gate over
// fullGateSeconds. The observer's warnings are produced by evaluateTrend itself, so a renamed
// warning still triggers.
describe('the upgrade audit', () => {
  const observed = (current, history = []) => ({
    schemaVersion: 1,
    observationStatus: 'available',
    current,
    trend: evaluateTrend(current, history, c),
    excludedHistoryRuns: 0,
  });
  // Profiled after every observer run below (sample() dates them 2026-10-10), as step 5's
  // npm run ci profiles the upgraded tree after the observer measured the old one.
  const profile = {
    schemaVersion: 1,
    reportStatus: 'available',
    startedAt: '2026-10-22T09:00:00.000Z',
    stepOutcome: 'failure',
    counts: { files: 23, tests: 40 },
    elapsedMs: 1000,
    files: [
      { path: 'test/pure.test.ts', durationMs: 900 },
      { path: 'test/store.test.ts', durationMs: 800 },
      { path: 'test/<img>|route.test.ts', durationMs: null },
      ...Array.from({ length: 20 }, (_, i) => ({
        path: `test/routes/r${String(i).padStart(2, '0')}.test.ts`,
        durationMs: 100 + i,
      })),
    ],
  };

  it('is required on a sustained budget overrun, a sustained regression, or one complete gate over budget', () => {
    const overrun = auditTrigger(observed(sample(10, 400), [sample(9, 400), sample(8, 400)]), c);
    assert.equal(overrun.status, 'warning');
    assert.equal(overrun.required, true);
    assert.ok(overrun.reasons.includes('fullGateSeconds: sustained budget exceeded'));

    // Every run within budget, the last three 40% slower and costlier than the three before.
    const slower = auditTrigger(
      observed(sample(10, 280), [
        sample(9, 280),
        sample(8, 280),
        sample(7, 200),
        sample(6, 200),
        sample(5, 200),
      ]),
      c,
    );
    assert.equal(slower.required, true);
    assert.deepEqual(slower.reasons, [
      'fullGateSeconds: sustained regression exceeds 20%',
      'gateRunnerMinutes: sustained regression exceeds 20%',
    ]);

    const skewed = (id) => sample(id, 100, undefined, 'same', 2);
    const imbalance = auditTrigger(observed(skewed(10), [skewed(9), skewed(8)]), c);
    assert.equal(imbalance.required, true);
    assert.deepEqual(imbalance.reasons, ['shardImbalanceRatio: sustained budget exceeded']);

    // History still warming up, so the observer warns of nothing; the one gate is over budget.
    const one = observed(sample(10, 416));
    assert.deepEqual(one.trend.warnings, []);
    const single = auditTrigger(one, c);
    assert.equal(single.status, 'warning');
    assert.equal(single.required, true);
    assert.deepEqual(single.reasons, ['complete gate 416.0s over fullGateSeconds 300s']);
  });

  it('is clear, and optional, when nothing warns and the latest gate is within budget', () => {
    for (const report of [
      observed(sample(10, 300)),
      observed(sample(10, 120), [sample(9, 120), sample(8, 120), sample(7, 110)]),
    ]) {
      const t = auditTrigger(report, c);
      assert.equal(t.status, 'clear');
      assert.equal(t.required, false);
    }
    assert.deepEqual(auditTrigger(observed(sample(10, 300)), c).reasons, [
      'warming-up, 0 comparable runs',
    ]);
  });

  it('is unavailable, and never required, when no budget or observation can be read', () => {
    // In budget, so each malformed case below would otherwise read as clear (#288 review F8).
    const fine = observed(sample(10, 120));
    assert.equal(auditTrigger(fine, c).status, 'clear');
    for (const [report, budget, reason] of [
      [observed(sample(10, 900)), null, /no test-performance budget adopted/],
      [{ schemaVersion: 1, observationStatus: 'not-adopted' }, c, /no test-performance budget/],
      [null, c, /no observer report/],
      [unavailableReport(new Error('GitHub observation unavailable (HTTP 403)')), c, /HTTP 403/],
      // "available" with no evidence behind it is not a clear status.
      [{ schemaVersion: 1, observationStatus: 'available' }, c, /malformed observer report/],
      [{ ...observed(sample(10, 900)), current: { fullGateSeconds: '900' } }, c, /malformed/],
      [{ ...observed(sample(10, 900)), trend: { warnings: 'none' } }, c, /malformed/],
      // A truncated or older-format trend, which would otherwise read as
      // "clear (undefined, undefined comparable runs)".
      [{ ...fine, trend: { warnings: [] } }, c, /malformed/],
      [{ ...fine, trend: { ...fine.trend, status: 3 } }, c, /malformed/],
      [{ ...fine, trend: { ...fine.trend, comparableRuns: '3' } }, c, /malformed/],
      // A warning that is not text, which would otherwise trigger an audit on its own.
      [{ ...fine, trend: { ...fine.trend, warnings: [1] } }, c, /malformed/],
      [{ ...fine, current: { ...fine.current, fullGateSeconds: -1 } }, c, /malformed/],
      // JSON reads 1e999 as Infinity, which would otherwise be a gate over any budget.
      [
        { ...fine, current: { ...fine.current, fullGateSeconds: JSON.parse('1e999') } },
        c,
        /malformed/,
      ],
    ]) {
      const t = auditTrigger(report, budget);
      assert.equal(t.status, 'unavailable');
      assert.equal(t.required, false);
      assert.match(t.reasons.join(' '), reason);
    }
  });

  // #288 review F4: after "Re-run failed jobs", the green attempt's observer refuses the jobs it
  // carried over and publishes an unavailable report, whose line would skip a required audit.
  // So /kit-upgrade step 2 takes the newest run whose observer artifact name ends in a 64-hex
  // fingerprint, which only an available observation's does.
  it('names only an available observation by its fingerprint, which step 2 selects on', () => {
    const fingerprinted = /^config=[0-9a-f]{64}\n$/;
    const current = { ...sample(10, 416), configHash: 'b'.repeat(64) };
    assert.match(configOutput(observed(current)), fingerprinted);
    const rerun = { ...run, run_started_at: '2026-10-10T10:40:00Z' };
    let partial;
    assert.throws(
      () => runMetrics(rerun, jobsOf(rerun), c, 'configuration'),
      (error) => {
        partial = unavailableReport(error);
        return /Partial re-run/.test(error.message);
      },
    );
    for (const report of [partial, { schemaVersion: 1, observationStatus: 'not-adopted' }])
      assert.doesNotMatch(configOutput(report), fingerprinted);
    assert.equal(auditTrigger(partial, c).status, 'unavailable');
  });

  // #288 review R1 (round 2): on the upgrade that brings the audit mode, the skill said to run
  // step 2's last command again after step 3. Its glob needs step 2's $run, and an agent's shell
  // starts fresh on each call: there bash passed the unexpanded test-performance--* through, and
  // the CLI printed "unavailable ... Audit not triggered" for a run that warned. And zsh printed no
  // line at all when the run it fell back to had no artifact left to download. So step 2 prints
  // the report's path, written out, for the later command. This runs step 2's command as the skill
  // and docs/TESTING.md print it, against a stub gh, in bash and, where installed, zsh.
  const shells = [
    ['bash', ['-c']],
    ['zsh', ['-f', '-c']],
  ].filter(([shell]) => spawnSync(shell, ['-c', 'exit 0']).status === 0);
  const documented = ['.claude/skills/kit-upgrade/SKILL.md', 'docs/TESTING.md'].flatMap((doc) => {
    const text = readOr(doc, null);
    if (text === null) return [];
    const block = [...text.matchAll(/^( *)```sh\n([\s\S]*?)\n\1```$/gm)].find((m) =>
      m[2].includes('gh run download'),
    );
    const dedent = (m) => m[2].replace(new RegExp(`^${m[1]}`, 'gm'), '');
    return [[doc, block ? dedent(block) : null]];
  });
  it('step 2 prints the report path, which a later call audits once step 3 carries the script', (t) => {
    if (IN_KIT) assert.equal(documented.length, 2, 'the kit documents step 2 twice');
    if (!documented.length) return t.skip('this app carries neither document');
    assert.ok(
      shells.some(([shell]) => shell === 'bash'),
      'bash is not installed',
    );
    const hex = 'b'.repeat(64);
    const warned = observed({ ...sample(11, 416), configHash: hex });
    const partial = unavailableReport(new Error('Partial re-run: synthetic'));
    for (const [doc, command] of documented) {
      assert.ok(command, `${doc}: no sh block runs gh run download`);
      for (const [shell, flags] of shells)
        inTemp((root) => {
          const label = `${doc} in ${shell}`;
          adopt(root);
          write(root, 'bin/gh-stub.mjs', GH_STUB);
          write(root, 'bin/gh', '#!/bin/sh\nexec "$NODE" "$GH_STUB" "$@"\n');
          chmodSync(join(root, 'bin', 'gh'), 0o755);
          const env = {
            PATH: [join(root, 'bin'), dirname(process.execPath), process.env.PATH].join(delimiter),
            HOME: root,
            NODE: process.execPath,
            GH_STUB: join(root, 'bin', 'gh-stub.mjs'),
            GH_STUB_RUNS: join(root, 'runs.json'),
          };
          const step2 = (runs) => {
            write(root, 'runs.json', JSON.stringify(runs));
            rmSync(join(root, '.test-results'), { recursive: true, force: true });
            return spawnSync(shell, [...flags, command], { cwd: root, env, encoding: 'utf8' });
          };
          // The upgrade that brings the audit mode: the tree's script has none, and package.json
          // has no test:audit. The newest green run is a partial re-run, so step 2 takes run 11.
          write(
            root,
            'scripts/test-performance.mjs',
            "console.error('Usage: node scripts/test-performance.mjs check|ci');\nprocess.exitCode = 2;\n",
          );
          write(root, 'package.json', JSON.stringify({ private: true, scripts: {} }));
          const before = step2([
            { id: 12, attempt: 2, artifacts: { 'test-performance-12-2-unavailable': partial } },
            { id: 11, attempt: 1, artifacts: { [`test-performance-11-1-${hex}`]: warned } },
          ]);
          const printed = /^Observer report: (\S+)$/m.exec(before.stdout)?.[1];
          assert.equal(
            printed,
            `.test-results/observer/test-performance-11-1-${hex}/test-performance.json`,
            `${label}:\n${before.stdout}${before.stderr}`,
          );
          // Step 3 carries the kit's script. A later call, with none of step 2's variables, runs
          // the audit on the path step 2 printed.
          for (const path of ['scripts/test-performance.mjs', 'scripts/kit-checks/main-module.mjs'])
            write(root, path, readFileSync(join(ROOT, path), 'utf8'));
          write(
            root,
            'package.json',
            JSON.stringify({
              private: true,
              scripts: { 'test:audit': 'node scripts/test-performance.mjs audit' },
            }),
          );
          const after = spawnSync(
            process.execPath,
            ['scripts/test-performance.mjs', 'audit', printed],
            { cwd: root, env, encoding: 'utf8' },
          );
          assert.equal(after.status, 0, `${label}: ${after.stderr}`);
          assert.match(
            after.stdout,
            /^Test performance: warning \(complete gate 416\.0s over fullGateSeconds 300s\), observer run 11 attempt 1\. Audit triggered\.$/m,
            label,
          );
          // None of the ten has an available observation, and the newest has no artifact left
          // (expired, or an observer that crashed), so its line says there is no report.
          const expired = step2([
            { id: 13, attempt: 1, artifacts: {} },
            { id: 12, attempt: 2, artifacts: { 'test-performance-12-2-unavailable': partial } },
          ]);
          assert.match(
            expired.stdout,
            /^Test performance: unavailable \(no observer report at \.test-results\/observer\/test-performance-13-1\/test-performance\.json\)\. Audit not triggered\.$/m,
            `${label}:\n${expired.stdout}${expired.stderr}`,
          );
        });
    }
  });

  it('prints one closeout line: the status, the observer run, and whether the audit was triggered', () => {
    assert.equal(
      auditLine(auditTrigger(observed(sample(10, 416)), c)),
      'Test performance: warning (complete gate 416.0s over fullGateSeconds 300s), observer run 10 attempt 1. Audit triggered.',
    );
    assert.equal(
      auditLine(auditTrigger(observed(sample(10, 200)), c)),
      'Test performance: clear (warming-up, 0 comparable runs), observer run 10 attempt 1. Audit not triggered.',
    );
    assert.equal(
      auditLine(auditTrigger(null, null)),
      'Test performance: unavailable (no test-performance budget adopted). Audit not triggered.',
    );
  });

  it('drafts the 20 slowest files with their runtime, keeps a failing outcome, and escapes paths', () => {
    const trigger = auditTrigger(observed(sample(10, 416)), c);
    const md = auditMarkdown(
      profile,
      { nodeTestFiles: ['test/pure.test.ts'], minimalWorkersTestFiles: ['test/store.test.ts'] },
      trigger,
    );
    assert.match(md, /DRAFT, review required/);
    assert.match(md, /coverage step: failure/);
    assert.match(md, /^Trigger: Test performance: warning \(complete gate 416\.0s/m);
    const rows = md.split('\n').filter((l) => l.startsWith('| test/'));
    assert.equal(rows.length, 20);
    assert.match(rows[0], /^\| test\/pure\.test\.ts \| Node \| 0\.900 \|$/);
    assert.match(rows[1], /^\| test\/store\.test\.ts \| minimal Workers \| 0\.800 \|$/);
    assert.match(rows[2], /^\| test\/routes\/r19\.test\.ts \| full Workers \| 0\.119 \|$/);
    // Slowest first, so the two fastest and the unknown duration fall outside the 20.
    assert.doesNotMatch(md, /r00\.test\.ts|r01\.test\.ts|&lt;img&gt;/);
    const unknown = auditMarkdown(
      { ...profile, files: [{ path: 'test/<img>|route.test.ts', durationMs: null }] },
      {},
      trigger,
    );
    assert.match(
      unknown,
      /\| test\/&lt;img&gt;&#124;route\.test\.ts \| full Workers \| unknown \|/,
    );
    // #288 review F6: with no test/projects.mjs, vitest.config.ts alone says where a test runs
    // (a fork's happy-dom or jsdom project, say), so the draft does not call it full Workers.
    for (const none of [null, undefined]) {
      const rows = auditMarkdown(profile, none, trigger)
        .split('\n')
        .filter((l) => l.startsWith('| test/'));
      assert.equal(rows.length, 20);
      for (const row of rows)
        assert.match(row, /^\| \S+ \| unlisted \(runtime per vitest\.config\.ts\) \|/);
    }
    assert.match(md, /independent expected result/);
    assert.match(md, /evidence-backed change, or an evidenced no-change decision/);
    assert.throws(
      () => auditMarkdown({ ...profile, reportStatus: 'unavailable' }, {}, trigger),
      /current normalized test profile/,
    );
  });

  // #257 review F1: the audit imported ../test/projects.mjs, which the arming-seam fence refuses
  // (scripts/ may not import from test/), and which a fork without the runtime split has not got.
  it('reads the runtime manifests as data, never by importing them, and no file is null', () =>
    inTemp((root) => {
      assert.equal(readManifests(root), null);
      write(
        root,
        'test/projects.mjs',
        [
          "throw new Error('imported');",
          '// Audited opt-ins only. Every unlisted test uses the full application Workers runtime.',
          'export const nodeTestFiles = [',
          "  'test/ai/mask.test.ts', // reviewed [2026-10-22]",
          '  "test/ai/pricing.test.ts", // pure',
          '];',
          '',
          '/* reviewed */ export const minimalWorkersTestFiles = [];',
          '',
        ].join('\n'),
      );
      assert.deepEqual(readManifests(root), {
        nodeTestFiles: ['test/ai/mask.test.ts', 'test/ai/pricing.test.ts'],
        minimalWorkersTestFiles: [],
      });
      write(root, 'test/projects.mjs', "export const nodeTestFiles = ['test/a.test.ts'];\n");
      assert.deepEqual(readManifests(root), { nodeTestFiles: ['test/a.test.ts'] });
      // A list the audit cannot read as plain strings is refused, never read as empty.
      for (const text of [
        "export const nodeTestFiles = ['test/a.test.ts', ...more];\n",
        "const n = ['test/a.test.ts'];\nexport { n as nodeTestFiles };\n",
        "export const minimalWorkersTestFiles = [join('test', 'a.test.ts')];\n",
      ]) {
        write(root, 'test/projects.mjs', text);
        assert.throws(() => readManifests(root), /test\/projects\.mjs: .*TestFiles/);
      }
    }));

  // #288 review F1: step 2 runs the trigger before the upgrade, when any profile left by an
  // earlier npm run ci describes an older tree. It drafted from that, and step 5's documented
  // re-run then kept the stale draft and exited 1.
  it('CLI: the trigger run only prints the line; --draft drafts from a profile of the final tree, and never overwrites a draft', () =>
    inTemp((root, invoke) => {
      adopt(root, UNSPLIT);
      write(root, 'observer.json', JSON.stringify(observed(sample(10, 416))));
      const draft = join(root, '.test-results', 'test-audit.md');
      const line =
        'Test performance: warning (complete gate 416.0s over fullGateSeconds 300s), observer run 10 attempt 1. Audit triggered.\n';
      // Step 2, with a profile an earlier npm run ci left, from before the observer's run.
      const stale = { ...profile, startedAt: '2026-09-01T00:00:00.000Z' };
      write(root, '.test-results/test-profile.json', JSON.stringify(stale));
      const trigger = invoke('audit', {}, ['observer.json']);
      assert.equal(trigger.status, 0, trigger.stderr);
      assert.equal(trigger.stdout, line);
      assert.equal(existsSync(draft), false);
      // --draft refuses that profile, and one with no start time, rather than draft from them.
      for (const startedAt of [stale.startedAt, sample(10).createdAt, undefined]) {
        write(root, '.test-results/test-profile.json', JSON.stringify({ ...profile, startedAt }));
        const old = invoke('audit', {}, ['observer.json', '--draft']);
        assert.equal(old.status, 1);
        assert.equal(old.stdout, line);
        assert.match(old.stderr, /is not newer than observer run 10 .*npm run test:profile/);
        assert.equal(existsSync(draft), false);
      }
      rmSync(join(root, '.test-results', 'test-profile.json'));
      const noProfile = invoke('audit', {}, ['observer.json', '--draft']);
      assert.equal(noProfile.status, 1);
      assert.equal(noProfile.stdout, line);
      assert.match(noProfile.stderr, /no readable .*npm run test:profile/);
      // Step 5: npm run ci has profiled the final tree.
      write(root, '.test-results/test-profile.json', JSON.stringify(profile));
      // No test/projects.mjs, as in any fork without the runtime split.
      assert.equal(existsSync(join(root, 'test', 'projects.mjs')), false);
      const drafted = invoke('audit', {}, ['observer.json', '--draft']);
      assert.equal(drafted.status, 0, drafted.stderr);
      assert.match(drafted.stdout, /^Audit draft: \.test-results\/test-audit\.md\./m);
      assert.match(
        readFileSync(draft, 'utf8'),
        /\| test\/pure\.test\.ts \| unlisted \(runtime per vitest\.config\.ts\) \|/,
      );
      assert.match(readFileSync(draft, 'utf8'), /^Trigger: .*Audit triggered\.$/m);
      writeFileSync(draft, 'reviewed draft');
      // Without --draft, the line alone, whatever is on disk.
      const line2 = invoke('audit', {}, ['observer.json']);
      assert.equal(line2.status, 0, line2.stderr);
      assert.equal(line2.stdout, line);
      const again = invoke('audit', {}, ['observer.json', '--draft']);
      assert.equal(again.status, 1);
      assert.match(again.stderr, /kept \.test-results\/test-audit\.md/);
      assert.equal(readFileSync(draft, 'utf8'), 'reviewed draft');
    }));

  // #288 review F7: the CLI must read the app's own manifests, from where it runs.
  it('CLI: --draft labels each runtime from test/projects.mjs, and refuses one it cannot read', () =>
    inTemp((root, invoke) => {
      adopt(root);
      write(root, 'observer.json', JSON.stringify(observed(sample(10, 416))));
      write(root, '.test-results/test-profile.json', JSON.stringify(profile));
      const draft = join(root, '.test-results', 'test-audit.md');
      write(root, 'test/projects.mjs', "export const nodeTestFiles = ['test/pure.test.ts'];\n");
      const drafted = invoke('audit', {}, ['observer.json', '--draft']);
      assert.equal(drafted.status, 0, drafted.stderr);
      const text = readFileSync(draft, 'utf8');
      assert.match(text, /^\| test\/pure\.test\.ts \| Node \| 0\.900 \|$/m);
      // A file the manifest does not list runs in full Workers, as test/projects.mjs says.
      assert.match(text, /^\| test\/store\.test\.ts \| full Workers \| 0\.800 \|$/m);
      rmSync(draft);
      write(
        root,
        'test/projects.mjs',
        "export const nodeTestFiles = ['test/pure.test.ts', ...more];\n",
      );
      const refused = invoke('audit', {}, ['observer.json', '--draft']);
      assert.equal(refused.status, 1);
      assert.match(refused.stdout, /^Test performance: warning .*Audit triggered\.$/m);
      assert.match(refused.stderr, /test\/projects\.mjs: nodeTestFiles .*cannot read it as data/);
      assert.equal(existsSync(draft), false);
    }));

  it('CLI: a clear or unavailable status drafts only when asked and is never an error', () =>
    inTemp((root, invoke) => {
      const none = invoke('audit');
      assert.equal(none.status, 0, none.stderr);
      assert.match(
        none.stdout,
        /^Test performance: unavailable \(no test-performance budget adopted\)\. Audit not triggered\.$/m,
      );
      adopt(root);
      const missing = invoke('audit');
      assert.equal(missing.status, 0, missing.stderr);
      assert.match(
        missing.stdout,
        /unavailable \(no observer report at \.test-results\/test-performance\.json\)/,
      );
      write(root, '.test-results/test-profile.json', JSON.stringify(profile));
      write(root, 'clear.json', JSON.stringify(observed(sample(10, 200))));
      const clear = invoke('audit', {}, ['clear.json']);
      assert.equal(clear.status, 0, clear.stderr);
      assert.match(clear.stdout, /^Test performance: clear .*Audit not triggered\.$/m);
      const draft = join(root, '.test-results', 'test-audit.md');
      assert.equal(existsSync(draft), false);
      const optional = invoke('audit', {}, ['clear.json', '--draft']);
      assert.equal(optional.status, 0, optional.stderr);
      assert.match(readFileSync(draft, 'utf8'), /^Trigger: Test performance: clear/m);
      // A report that is not JSON is unavailable, and its text never reaches the output.
      write(root, 'bad.json', '{"synthetic-body":');
      const bad = invoke('audit', {}, ['bad.json']);
      assert.equal(bad.status, 0, bad.stderr);
      assert.match(bad.stdout, /unavailable \(Malformed observer report\)/);
      assert.doesNotMatch(bad.stdout + bad.stderr, /synthetic-body/);
      assert.equal(invoke('audit', {}, ['clear.json', 'bad.json']).status, 2);
    }));

  // #288 review R1 (round 2): step 2's command, run again in a later shell that has lost its
  // variables, passes an empty path, or in bash the glob it cannot expand. Neither is the
  // observer's report, so neither gets a closeout line to record.
  it('CLI: refuses an empty or unexpanded report path, and prints no closeout line for it', () =>
    inTemp((root, invoke) => {
      adopt(root);
      for (const path of ['', '.test-results/observer/test-performance--*/test-performance.json']) {
        const refused = invoke('audit', {}, [path]);
        assert.equal(refused.status, 2, path);
        assert.equal(refused.stdout, '', path);
        assert.match(refused.stderr, /Observer report:/, path);
      }
      // The reviewer's reproduction: the old step-2 line in a fresh bash, with $run unset.
      const fresh = spawnSync(
        'bash',
        [
          '-c',
          'node "$SCRIPT" audit .test-results/observer/test-performance-$run-*/test-performance.json',
        ],
        { cwd: root, env: { PATH: process.env.PATH, SCRIPT }, encoding: 'utf8' },
      );
      assert.equal(fresh.status, 2, fresh.stdout);
      assert.doesNotMatch(fresh.stdout, /Test performance:/);
    }));
});

describe('the CLI', () => {
  it('fails a bad budget or a missing comparison file, and replaces a stale green observation', () =>
    inTemp((root, invoke) => {
      adopt(root, { ...c, fullGateSeconds: 0 });
      assert.notEqual(invoke('check').status, 0);
      adopt(root);
      const valid = invoke('check');
      assert.equal(valid.status, 0, valid.stderr);
      assert.match(valid.stdout, /budget\/config: valid/);
      // #257 review F17: a comparison file the budget names but the tree lacks fails the check.
      rmSync(join(root, 'wrangler.test.jsonc'));
      const missing = invoke('check');
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /Performance comparison file missing: wrangler\.test\.jsonc/);
      write(root, 'wrangler.test.jsonc', 'synthetic');
      // #287 review F4: a budget whose suite job the workflow no longer runs.
      write(root, c.workflowPath, workflowOf({ ...c, suiteJobPrefix: 'suite' }));
      const drifted = invoke('check');
      assert.notEqual(drifted.status, 0);
      assert.match(drifted.stderr, /suiteJobPrefix: no job in \.github\/workflows\/ci\.yml/);
      // The observer reports a budget it cannot read as unavailable; it never goes red itself.
      const broken = invoke('ci');
      assert.equal(broken.status, 0, broken.stderr);
      assert.match(broken.stdout, /Observation unavailable \(Performance budget/);
      write(root, c.workflowPath, workflowOf(c));
      write(
        root,
        '.test-results/test-performance.json',
        JSON.stringify({ observationStatus: 'available' }),
      );
      write(root, 'output', '');
      const unavailable = invoke('ci', { GITHUB_OUTPUT: join(root, 'output') });
      assert.equal(unavailable.status, 0);
      assert.match(unavailable.stdout, /observation unavailable/);
      const observed = JSON.parse(
        readFileSync(join(root, '.test-results/test-performance.json'), 'utf8'),
      );
      assert.equal(observed.observationStatus, 'unavailable');
      assert.match(observed.reason, /credentials/);
      assert.equal(readFileSync(join(root, 'output'), 'utf8'), 'config=unavailable\n');
    }));

  // #257 review F2: ci.yml rides /kit-upgrade, the budget does not. A fork that takes the
  // workflow before it adopts a budget must stay green.
  it('passes with a notice, and records "not adopted", in an app with no budget', () =>
    inTemp((root, invoke) => {
      // #288 review F9: an unknown mode (a typo for audit, say) is a usage error. It never falls
      // through to the observer, which would overwrite the report.
      const bogus = invoke('audt', {}, ['observer.json']);
      assert.equal(bogus.status, 2);
      assert.match(bogus.stderr, /check\|ci\|audit/);
      assert.equal(bogus.stdout, '');
      assert.equal(existsSync(join(root, '.test-results')), false);
      const check = invoke('check');
      assert.equal(check.status, 0, check.stderr);
      assert.match(check.stdout, /not adopted/);
      write(root, 'output', '');
      const ci = invoke('ci', { GITHUB_OUTPUT: join(root, 'output') });
      assert.equal(ci.status, 0, ci.stderr);
      assert.match(ci.stdout, /not adopted/);
      assert.equal(
        JSON.parse(readFileSync(join(root, '.test-results/test-performance.json'), 'utf8'))
          .observationStatus,
        'not-adopted',
      );
      assert.equal(readFileSync(join(root, 'output'), 'utf8'), 'config=not-adopted\n');
      const audit = invoke('audit');
      assert.equal(audit.status, 0, audit.stderr);
      assert.match(audit.stdout, /unavailable \(no test-performance budget adopted\)/);
    }));

  it('every test-performance command the workflow runs passes in an app with no budget', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const modes = [
      ...workflow.matchAll(/^\s*(?:- )?run: node scripts\/test-performance\.mjs (\S+)$/gm),
    ].map((m) => m[1]);
    // The budget check is a static gate everywhere; a fork may drop the observer (`ci`).
    assert.ok(modes.includes('check'), 'ci.yml runs no `node scripts/test-performance.mjs check`');
    for (const mode of modes) assert.ok(['check', 'ci'].includes(mode), `unknown mode ${mode}`);
    // package.json does not ride /kit-upgrade, so the workflow never calls the npm scripts.
    assert.doesNotMatch(workflow, /npm run (?:verify:test-performance|test:performance)\b/);
    inTemp((_, invoke) => {
      for (const mode of ['check', 'ci']) {
        const result = invoke(mode);
        assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
        assert.match(result.stdout, /not adopted/, mode);
      }
    });
  });

  // #257 review F5: a fork carries this file and keeps its own budget. Runs this very file in a
  // simulated fork with 8 shards and an extra required gate, and in one with no budget at all.
  // #287 review F2: the fork names its shard job as insights does, so Actions lists the shards
  // as `Workers suite shard 1/8` and so on, never by the job's id.
  it(
    'this test file passes in a sharded fork with its own budget, and in one with none',
    {
      skip: CARRIED && 'already running inside the fork simulation',
    },
    () =>
      inTemp((root) => {
        for (const path of [
          'scripts/test-performance.mjs',
          'scripts/kit-checks/main-module.mjs',
          'scripts/new-app.mjs',
          'test/platform/test-performance.test.mjs',
        ]) {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          copyFileSync(join(ROOT, path), join(root, path));
        }
        write(root, '.github/workflows/ci.yml', FORK_CI);
        const sharded = {
          ...c,
          fullGateSeconds: 600,
          gateRunnerMinutes: 60,
          windowSize: 5,
          historyLimit: 20,
          requiredJobs: [...c.requiredJobs, 'codeql'],
          suiteJobPrefix: 'Workers suite shard',
          expectedSuiteJobs: 8,
          comparisonFiles: [...c.comparisonFiles, 'vitest.shards.json'],
        };
        for (const path of sharded.comparisonFiles)
          if (!existsSync(join(root, path))) write(root, path, 'synthetic');
        const carried = () =>
          spawnSync(process.execPath, ['--test', 'test/platform/test-performance.test.mjs'], {
            cwd: root,
            env: { PATH: process.env.PATH, TEST_PERFORMANCE_CARRIED: '1' },
            encoding: 'utf8',
          });
        write(root, 'test-performance-budget.json', JSON.stringify(sharded));
        const fork = carried();
        assert.equal(fork.status, 0, `sharded fork:\n${fork.stdout}${fork.stderr}`);
        rmSync(join(root, 'test-performance-budget.json'));
        const none = carried();
        assert.equal(none.status, 0, `no budget:\n${none.stdout}${none.stderr}`);
      }),
  );
});
