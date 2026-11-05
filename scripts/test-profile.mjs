// Timing evidence, not a test selector or a pass/fail gate. The existing Vitest command keeps
// its exit status and coverage thresholds. Only normalized timings/context leave the runner;
// assertion titles, failure text, environment dumps and the raw coverage map do not.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { isMainModule } from './kit-checks/main-module.mjs';

// Generated and git-ignored. The tree scans that run later in the same CI job and local `ci`
// chain (new-app's residual-identifier scan, source hygiene) skip it, as they skip coverage/.
export const RESULTS_DIRECTORY = '.test-results';
// Vitest's own JSON report: every test title, failure stack, absolute path and the coverage
// map. summarize reads it and then deletes it.
export const RAW_REPORT_PATH = `${RESULTS_DIRECTORY}/vitest.json`;
// The normalized profile, and the only file CI uploads.
export const PROFILE_PATH = `${RESULTS_DIRECTORY}/test-profile.json`;
const STARTED_PATH = `${RESULTS_DIRECTORY}/started.json`;
const DEFAULT_SCRIPT = 'test:coverage';
const SCRIPT_NAME = /^[\w:.-]+$/;
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function runnerContext(env = process.env) {
  const processors = cpus();
  return {
    node: process.version,
    platform: platform(),
    release: release(),
    architecture: arch(),
    logicalCpus: processors.length,
    availableParallelism: availableParallelism(),
    cpuModels: [...new Set(processors.map((cpu) => cpu.model))].sort(compare),
    totalMemoryBytes: totalmem(),
    // An allowlist: never serialize process.env, runner names or local account paths.
    github: {
      sha: env.GITHUB_SHA ?? null,
      runId: env.GITHUB_RUN_ID ?? null,
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
      job: env.GITHUB_JOB ?? null,
      runnerOs: env.RUNNER_OS ?? null,
      runnerArch: env.RUNNER_ARCH ?? null,
      imageVersion: env.ImageVersion ?? null,
    },
  };
}

export function startProfile(root = process.cwd(), env = process.env, now = Date.now()) {
  mkdirSync(join(root, RESULTS_DIRECTORY), { recursive: true });
  // A failed/crashed invocation must never inherit a previous invocation's green evidence.
  for (const path of [RAW_REPORT_PATH, PROFILE_PATH]) rmSync(join(root, path), { force: true });
  const started = { startedAtMs: now, context: runnerContext(env) };
  writeFileSync(join(root, STARTED_PATH), `${JSON.stringify(started, null, 2)}\n`);
  return started;
}

export function buildProfile(report, started, root, finishedAtMs, outcome = null) {
  const valid =
    report !== null &&
    typeof report === 'object' &&
    Array.isArray(report.testResults) &&
    finite(report.startTime) !== null &&
    report.startTime >= started.startedAtMs;
  const files = valid
    ? report.testResults
        .map((file) => {
          const path = relative(root, file.name ?? '');
          const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
          const begin = finite(file.startTime);
          const end = finite(file.endTime);
          return {
            // Do not publish an absolute path when a runner emits a file outside the checkout.
            path:
              !path || isAbsolute(path) || path.startsWith('..')
                ? '[outside checkout]'
                : path.replaceAll('\\', '/'),
            status: typeof file.status === 'string' ? file.status : 'unknown',
            durationMs: begin !== null && end !== null && end >= begin ? end - begin : null,
            assertions: assertions.length,
            assertionDurationMs: assertions.reduce(
              (sum, item) => sum + (finite(item.duration) ?? 0),
              0,
            ),
          };
        })
        .sort((a, b) => compare(a.path, b.path))
    : [];
  return {
    schemaVersion: 1,
    startedAt: new Date(started.startedAtMs).toISOString(),
    // Includes npm startup, runtime setup, reporting/coverage and the short step handoff.
    // It is wall time, not the sum of potentially concurrent file/test durations.
    elapsedMs: Math.max(0, finishedAtMs - started.startedAtMs),
    stepOutcome: ['success', 'failure', 'cancelled', 'skipped'].includes(outcome) ? outcome : null,
    reportStatus: valid ? 'available' : 'unavailable',
    reportedSuccess: valid && typeof report.success === 'boolean' ? report.success : null,
    counts: valid
      ? {
          files: files.length,
          tests: finite(report.numTotalTests),
          passed: finite(report.numPassedTests),
          failed: finite(report.numFailedTests),
          pending: finite(report.numPendingTests),
        }
      : null,
    context: started.context,
    files,
  };
}

const cell = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('`', '&#96;')
    .replace(/[\r\n]/g, ' ');

export function markdownSummary(profile) {
  const slowest = [...profile.files]
    .sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1) || compare(a.path, b.path))
    .slice(0, 10);
  return [
    '## Test timing evidence',
    '',
    `Coverage step: ${cell(profile.stepOutcome ?? 'local / see command exit status')}. Elapsed: ${(profile.elapsedMs / 1000).toFixed(2)}s.`,
    `Runner: ${cell(profile.context.platform)} ${cell(profile.context.architecture)}, Node ${cell(profile.context.node)}, ${profile.context.availableParallelism} available / ${profile.context.logicalCpus} logical CPUs.`,
    profile.counts
      ? `${profile.counts.files} files; ${profile.counts.passed} passed, ${profile.counts.failed} failed, ${profile.counts.pending} pending tests.`
      : 'No current valid Vitest report; no test result can be inferred from this artifact.',
    '',
    'File durations can overlap; they do not add up to wall time. Timing is evidence, not a pass criterion. See docs/TESTING.md.',
    '',
    '| Slowest file | Reported duration |',
    '| --- | ---: |',
    ...slowest.map(
      (file) =>
        `| ${cell(file.path)} | ${file.durationMs === null ? 'unknown' : `${(file.durationMs / 1000).toFixed(3)}s`} |`,
    ),
    '',
  ].join('\n');
}

export function summarizeProfile(root = process.cwd(), env = process.env, now = Date.now()) {
  const started = JSON.parse(readFileSync(join(root, STARTED_PATH), 'utf8'));
  const raw = join(root, RAW_REPORT_PATH);
  let report = null;
  try {
    report = JSON.parse(readFileSync(raw, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  // Keep only the normalized profile. Left in place, the raw report (titles, failure stacks,
  // absolute paths, the coverage map) is there for every later tree scan or upload to pick up.
  rmSync(raw, { force: true });
  const profile = buildProfile(report, started, root, now, env.TEST_STEP_OUTCOME);
  writeFileSync(join(root, PROFILE_PATH), `${JSON.stringify(profile, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdownSummary(profile));
  console.log(`Test timing report: ${PROFILE_PATH} (${profile.reportStatus})`);
  return profile;
}

// Vitest picks its console reporter only when the command names none: `agent` under a coding
// agent (failed tests and the totals only; Vitest 4.1 and later), `default` otherwise, plus
// `github-actions` on GitHub. Naming the JSON reporter replaces that choice, so make the same
// one here. Otherwise an agent's `npm run ci` prints every passing test's output. These are the
// variables std-env, Vitest's detector, reads.
const AGENT_VARIABLES = [
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'REPL_ID',
  'GEMINI_CLI',
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  'OPENCODE',
  'AUGMENT_AGENT',
  'GOOSE_PROVIDER',
  'CURSOR_AGENT',
];
const AGENT_PATTERNS = [
  ['PATH', /\.pi[\\/]agent/],
  ['EDITOR', /devin/],
  ['TERM_PROGRAM', /kiro/],
];

export function isCodingAgent(env) {
  return (
    AGENT_VARIABLES.some((name) => Boolean(env[name])) ||
    AGENT_PATTERNS.some(([name, pattern]) => pattern.test(env[name] ?? ''))
  );
}

export function consoleReporters(env, vitestVersion) {
  const [major, minor] = String(vitestVersion ?? '')
    .split('.')
    .map(Number);
  const hasAgentReporter = major > 4 || (major === 4 && minor >= 1);
  return [
    isCodingAgent(env) && hasAgentReporter ? 'agent' : 'default',
    ...(env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : []),
  ];
}

// The Vitest the app's own scripts run, or null when none resolves (then: `default`).
export function installedVitestVersion(root) {
  try {
    const manifest = createRequire(join(root, 'package.json')).resolve('vitest/package.json');
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// How to start `npm <args>`. `npm run` exports npm_execpath, npm's own CLI script: running that
// with this Node needs no shell on any OS. Started any other way, Windows finds npm (npm.cmd)
// only through a shell, since Node refuses to spawn a .cmd without one. The arguments are fixed
// flags and a checked script name, so the one command line needs no quoting. Another package
// manager's CLI takes other arguments, so it is not used.
export function npmInvocation(args, env, os = process.platform) {
  const cli = env.npm_execpath ?? '';
  if (/^npm-cli\.[cm]?js$/.test(cli.split(/[\\/]/).pop())) {
    return { command: process.execPath, args: [cli, ...args], shell: false };
  }
  if (os === 'win32') return { command: ['npm', ...args].join(' '), args: [], shell: true };
  return { command: 'npm', args, shell: false };
}

// Run the app's existing coverage command and propagate its status, even when JSON says
// assertions passed. Local CI gains normalized evidence without an extra suite invocation.
export function runProfile(
  root = process.cwd(),
  env = process.env,
  runner = spawnSync,
  {
    script = DEFAULT_SCRIPT,
    vitestVersion = installedVitestVersion(root),
    os = process.platform,
  } = {},
) {
  startProfile(root, env);
  const call = npmInvocation(
    [
      'run',
      script,
      '--',
      ...consoleReporters(env, vitestVersion).map((name) => `--reporter=${name}`),
      '--reporter=json',
      `--outputFile.json=${RAW_REPORT_PATH}`,
    ],
    env,
    os,
  );
  const result = runner(call.command, call.args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: call.shell,
  });
  if (result.error) {
    console.error(`test-profile: could not run \`npm run ${script}\`: ${result.error.message}`);
  }
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  summarizeProfile(root, { ...env, TEST_STEP_OUTCOME: exitCode === 0 ? 'success' : 'failure' });
  return exitCode;
}

if (isMainModule(import.meta.url)) {
  const [mode, script = DEFAULT_SCRIPT, ...extra] = process.argv.slice(2);
  if (mode === 'start') startProfile();
  else if (mode === 'summarize') summarizeProfile();
  else if (mode === 'run' && SCRIPT_NAME.test(script) && extra.length === 0) {
    process.exitCode = runProfile(process.cwd(), process.env, spawnSync, { script });
  } else {
    console.error('Usage: node scripts/test-profile.mjs start | summarize | run [npm script]');
    process.exitCode = 2;
  }
}
