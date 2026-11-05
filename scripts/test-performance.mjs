// The app's test-performance budget (test-performance-budget.json), the CI observer that
// reads it, and the /kit-upgrade audit that the observer's warnings trigger.
//
//   node scripts/test-performance.mjs check   # offline, in test-gates: is the budget valid?
//   node scripts/test-performance.mjs ci      # the read-only observer, after every gate on a PR
//   node scripts/test-performance.mjs audit [report] [--draft]
//                                             # at /kit-upgrade: the closeout line; --draft, once
//                                             # the final tree is profiled, drafts the audit
//
// Observations never select tests, change a threshold or certify coverage, and nothing waits on
// them. A budget that cannot be read fails `check`, which is a gate. A slow run, a sustained
// regression or an API that cannot be read is a warning to investigate, never a red check. An
// app with no budget file has not adopted one: every mode says so and exits 0, because ci.yml
// rides /kit-upgrade and the budget does not (#257 review F2).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainModule } from './kit-checks/main-module.mjs';

const CONFIG = 'test-performance-budget.json';
// The observer publishes each run's configuration fingerprint in its artifact's name,
// `test-performance-<run id>-<attempt>-<fingerprint>` (ci.yml), so a later run can find the runs
// that executed the same configuration by listing artifacts, without downloading any.
const ARTIFACT = 'test-performance';
const NOT_ADOPTED =
  'Test performance budget: not adopted (no test-performance-budget.json), so there is nothing to check or observe. To adopt one, see docs/TESTING.md, "App-owned budgets and the CI observer".';
const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const pathSafe = (p) =>
  typeof p === 'string' &&
  /^[\w./-]+$/.test(p) &&
  !p.split('/').includes('..') &&
  !p.startsWith('/');
const uniqueStrings = (v) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((x) => typeof x === 'string' && x.length > 0) &&
  new Set(v).size === v.length;
const time = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);
// A suite job as Actions lists it: the prefix, or the prefix, a space and the rest. A matrix job
// with no `name:` is listed as `<id> (<values>)`, and one with a `name:` as that name with the
// matrix values filled in (insights: `Workers suite shard 1/4`) (#287 review F2).
const isSuite = (name, c) => name === c.suiteJobPrefix || name.startsWith(`${c.suiteJobPrefix} `);
export function validateBudget(c) {
  if (c?.schemaVersion !== 1) throw new Error('Performance budget: expected schemaVersion 1');
  for (const key of [
    'focusedSeconds',
    'fullGateSeconds',
    'gateRunnerMinutes',
    'regressionPercent',
    'shardImbalanceRatio',
  ]) {
    if (!positive(c[key])) throw new Error(`Performance budget: invalid ${key}`);
  }
  if (c.shardImbalanceRatio <= 1)
    throw new Error('Performance budget: shardImbalanceRatio must exceed 1');
  if (!Number.isInteger(c.windowSize) || c.windowSize < 3 || c.windowSize > 10)
    throw new Error('Performance budget: windowSize must be 3..10');
  if (
    !Number.isInteger(c.historyLimit) ||
    c.historyLimit < c.windowSize * 2 - 1 ||
    c.historyLimit > 30
  )
    throw new Error('Performance budget: insufficient or excessive historyLimit');
  if (
    !pathSafe(c.workflowPath) ||
    !uniqueStrings(c.requiredJobs) ||
    !uniqueStrings(c.comparisonFiles) ||
    !c.comparisonFiles.every(pathSafe)
  )
    throw new Error('Performance budget: invalid workflow/jobs/comparison files');
  // Words separated by single spaces, so a display name fits (`Workers suite shard`), and no
  // required job may also count as a suite job.
  if (
    typeof c.suiteJobPrefix !== 'string' ||
    !/^[\w.-]+(?: [\w.-]+)*$/.test(c.suiteJobPrefix) ||
    c.requiredJobs.some((name) => isSuite(name, c))
  )
    throw new Error('Performance budget: invalid suiteJobPrefix');
  if (
    !Number.isInteger(c.expectedSuiteJobs) ||
    c.expectedSuiteJobs < 1 ||
    c.expectedSuiteJobs > 128
  )
    throw new Error('Performance budget: invalid expectedSuiteJobs');
  for (const path of [CONFIG, c.workflowPath, 'package-lock.json', 'vitest.config.ts']) {
    if (!c.comparisonFiles.includes(path))
      throw new Error(`Performance budget: comparison must include ${path}`);
  }
  return c;
}

// A workflow's jobs as Actions shows them. Read as text, not parsed: a job is a line `  <id>:`
// in the top-level `jobs:` block, its name is its first `    name:` line (or its id when it has
// none), and `count` is how many jobs it runs (jobCount). Enough to catch a budget left behind
// by a renamed, display-named or re-sharded job; a workflow written another way is the owner's
// review to catch.
function workflowJobs(text) {
  const jobs = [];
  let inJobs = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^[^\s#]/.test(line)) inJobs = /^jobs:\s*(?:#.*)?$/.test(line);
    if (!inJobs) continue;
    const id = /^ {2}([A-Za-z_][\w-]*):\s*(?:#.*)?$/.exec(line);
    if (id) jobs.push({ id: id[1], lines: [] });
    else if (jobs.length && !/^\s*(?:#|$)/.test(line)) jobs.at(-1).lines.push(line);
  }
  return jobs.map(({ id, lines }) => {
    const name = lines.map((l) => /^ {4}name:\s*(.*)$/.exec(l)).find(Boolean)?.[1];
    const quoted = name && /^(['"])(.*)\1(?:\s+#.*)?$/.exec(name);
    return {
      name: name ? (quoted ? quoted[2] : name.replace(/\s+#.*$/, '').trim()) : id,
      count: jobCount(lines),
    };
  });
}

// How many jobs one workflow job runs, where its text shows it (#287 review R1): 1 with no
// `strategy:`, or one per value of a matrix with a single list of values (`shard: [1, 2, 3, 4]`).
// null for any other shape (include or exclude, an expression, several axes, a block list),
// whose count `check` leaves to the observer and the owner's review.
function jobCount(lines) {
  const at = lines.findIndex((l) => /^ {4}strategy:/.test(l));
  if (at < 0) return 1;
  if (!/^ {4}strategy:\s*(?:#.*)?$/.test(lines[at])) return null;
  const end = lines.findIndex((l, i) => i > at && /^ {4}\S/.test(l));
  const strategy = lines.slice(at + 1, end < 0 ? lines.length : end);
  const m = strategy.findIndex((l) => /^\s+matrix:\s*(?:#.*)?$/.test(l));
  if (m < 0) return null;
  const indent = (l) => /^ */.exec(l)[0].length;
  const below = strategy.slice(m + 1);
  const stop = below.findIndex((l) => indent(l) <= indent(strategy[m]));
  const axes = stop < 0 ? below : below.slice(0, stop);
  const axis =
    axes.length === 1 &&
    /^\s+(?!(?:include|exclude):)[\w-]+:\s*\[([^[\]{}$]*)\]\s*(?:#.*)?$/.exec(axes[0]);
  return axis ? (axis[1].match(/'[^']*'|"[^"]*"|[^\s,'"][^,'"]*/g) ?? []).length : null;
}

/**
 * Whether the workflow runs the budget's jobs under the names and count the observer matches
 * (#287 review F4, R1): each required job shown exactly once, a suite job shown under the
 * prefix, and, where every suite job's text shows its count, `expectedSuiteJobs` of them.
 * Without this, a renamed, display-named or re-sharded job turns every observation
 * "unavailable" while `check` stays green.
 */
export function workflowProblems(c, text) {
  const jobs = workflowJobs(text);
  const problems = [];
  for (const job of c.requiredJobs) {
    const count = jobs.filter(({ name }) => name === job).length;
    if (count !== 1)
      problems.push(
        `requiredJobs: ${job} is the name of ${count} jobs in ${c.workflowPath}, not 1 (a job's name is its \`name:\`, or its id when it has none)`,
      );
  }
  const suites = jobs.filter(({ name }) => isSuite(name, c));
  if (!suites.length)
    problems.push(
      `suiteJobPrefix: no job in ${c.workflowPath} is named ${c.suiteJobPrefix}, or ${c.suiteJobPrefix} and a space (a job's \`name:\` up to its shard number, or its id when it has none)`,
    );
  else if (suites.every(({ count }) => count !== null)) {
    const total = suites.reduce((n, { count }) => n + count, 0);
    if (total !== c.expectedSuiteJobs)
      problems.push(
        `expectedSuiteJobs: ${c.workflowPath} runs ${total} suite job${total === 1 ? '' : 's'}, not ${c.expectedSuiteJobs} (a job with no \`strategy:\` runs 1, and a matrix with a single list of values one per value)`,
      );
  }
  return problems;
}

/** The app's budget, validated, or null when the app has no budget file (not adopted). */
export function readBudget(root = process.cwd()) {
  const file = join(root, CONFIG);
  if (!existsSync(file)) return null;
  const c = validateBudget(JSON.parse(readFileSync(file, 'utf8')));
  for (const path of c.comparisonFiles)
    if (!existsSync(join(root, path)))
      throw new Error(`Performance comparison file missing: ${path}`);
  const problems = workflowProblems(c, readFileSync(join(root, c.workflowPath), 'utf8'));
  if (problems.length)
    throw new Error(`Performance budget does not match its workflow: ${problems.join('; ')}`);
  return c;
}

export function fingerprint(tree, c) {
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete configuration tree');
  const entries = new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  const files = [...c.comparisonFiles].sort().map((p) => {
    const sha = entries.get(p);
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error(`Configuration evidence missing: ${p}`);
    return [p, sha];
  });
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

// How far a job's start may precede its run attempt's start before it counts as an earlier
// attempt's: clock difference between the two records, not a re-run.
const CLOCK_SKEW_MS = 5000;
export function runMetrics(run, jobs, c, configHash) {
  const required = c.requiredJobs.map((name) => {
    const matches = jobs.filter((j) => j.name === name);
    if (matches.length !== 1) throw new Error(`Missing/duplicate gate job: ${name}`);
    return matches[0];
  });
  const suites = jobs.filter((j) => isSuite(j.name, c));
  if (
    suites.length !== c.expectedSuiteJobs ||
    new Set(suites.map((j) => j.name)).size !== suites.length
  )
    throw new Error('Missing/duplicate suite jobs');
  const selected = [...required, ...suites];
  const started = selected.map((j) => time(j.started_at));
  const ended = selected.map((j) => time(j.completed_at));
  for (const [i, j] of selected.entries()) {
    if (
      j.run_id !== run.id ||
      j.run_attempt !== run.run_attempt ||
      j.head_sha !== run.head_sha ||
      j.status !== 'completed' ||
      j.conclusion !== 'success' ||
      !Number.isFinite(started[i]) ||
      !Number.isFinite(ended[i]) ||
      ended[i] < started[i] ||
      !uniqueStrings(j.labels)
    )
      throw new Error('Incomplete, unsuccessful or wrong-identity gate evidence');
  }
  if (!Number.isFinite(time(run.created_at))) throw new Error('Missing workflow creation time');
  // Queue time counts from this attempt's start. created_at stays at the first attempt's
  // creation, so a re-run would count the time since then too (#257 review F12).
  const runStarted = time(run.run_started_at ?? run.created_at);
  if (!Number.isFinite(runStarted)) throw new Error('Invalid workflow start time');
  // "Re-run failed jobs" lists the jobs it carried over under the new attempt, with the first
  // attempt's times. Counted, they stretch the complete gate across both attempts and the wait
  // between them, and clamp the queue to 0, so no partial re-run is evidence (#287 review F1).
  if (started.some((t) => t < runStarted - CLOCK_SKEW_MS))
    throw new Error('Partial re-run: job evidence from an earlier attempt');
  const durations = selected.map((_, i) => (ended[i] - started[i]) / 1000);
  const suiteDurations = suites.map((j) => (time(j.completed_at) - time(j.started_at)) / 1000);
  const topology = selected
    .map((j) => [j.name, [...j.labels].sort()])
    .sort(([a], [b]) => a.localeCompare(b));
  return {
    runId: run.id,
    attempt: run.run_attempt,
    headSha: run.head_sha,
    createdAt: run.created_at,
    configHash,
    comparisonKey: createHash('sha256')
      .update(JSON.stringify([configHash, topology]))
      .digest('hex'),
    fullGateSeconds: (Math.max(...ended) - Math.min(...started)) / 1000,
    initialQueueSeconds: Math.max(0, (Math.min(...started) - runStarted) / 1000),
    gateRunnerMinutes: durations.reduce((a, b) => a + b, 0) / 60,
    suiteRunnerMinutes: suiteDurations.reduce((a, b) => a + b, 0) / 60,
    shardImbalanceRatio: Math.max(...suiteDurations) / (median(suiteDurations) || 1),
    suiteJobs: suites.length,
  };
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const middle = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[middle] : (s[middle - 1] + s[middle]) / 2) : null;
}

export function evaluateTrend(current, history, c) {
  const ids = new Set([current.runId]);
  const comparable = history
    .filter((r) => {
      if (
        r.comparisonKey !== current.comparisonKey ||
        ids.has(r.runId) ||
        time(r.createdAt) >= time(current.createdAt)
      )
        return false;
      ids.add(r.runId);
      return true;
    })
    .sort((a, b) => time(b.createdAt) - time(a.createdAt));
  const recent = [current, ...comparable].slice(0, c.windowSize);
  const baseline = comparable.slice(c.windowSize - 1, c.windowSize * 2 - 1);
  const warnings = [];
  const metrics = {};
  for (const key of ['fullGateSeconds', 'gateRunnerMinutes', 'shardImbalanceRatio']) {
    const rolling = recent.length === c.windowSize ? median(recent.map((r) => r[key])) : null;
    const prior = baseline.length === c.windowSize ? median(baseline.map((r) => r[key])) : null;
    metrics[key] = { current: current[key], rollingMedian: rolling, baselineMedian: prior };
    if (rolling !== null && rolling > c[key]) warnings.push(`${key}: sustained budget exceeded`);
    if (
      key !== 'shardImbalanceRatio' &&
      rolling !== null &&
      prior > 0 &&
      rolling > prior * (1 + c.regressionPercent / 100)
    )
      warnings.push(`${key}: sustained regression exceeds ${c.regressionPercent}%`);
  }
  return {
    status:
      recent.length < c.windowSize
        ? 'warming-up'
        : warnings.length
          ? 'investigate'
          : 'within-budget',
    comparableRuns: comparable.length,
    recentRunIds: recent.map((r) => r.runId),
    baselineRunIds: baseline.map((r) => r.runId),
    metrics,
    warnings,
  };
}

// Fixed GitHub origin; reject redirects so a token can never follow an API redirect off-host.
export function githubReader(repository, token, fetcher = fetch) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) || !token)
    throw new Error('Missing GitHub read credentials/context');
  const deadline = Date.now() + 120000;
  return async (path) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('GitHub observation time budget exhausted');
    const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(10000, remaining)),
    });
    if (!response.ok) throw new Error(`GitHub observation unavailable (HTTP ${response.status})`);
    return response.json();
  };
}

export async function collectPerformance(
  c,
  env = process.env,
  get = githubReader(env.GITHUB_REPOSITORY, env.GITHUB_TOKEN),
) {
  const id = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  // The commit this run executed: on a pull_request run, the merge commit, not the PR head.
  const sha = env.GITHUB_SHA;
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(attempt) ||
    attempt <= 0 ||
    !/^[a-f0-9]{40}$/.test(sha ?? '')
  )
    throw new Error('Invalid run identity');
  const run = await get(`actions/runs/${id}`);
  if (
    run.event !== 'pull_request' ||
    run.id !== id ||
    run.run_attempt !== attempt ||
    run.path !== c.workflowPath ||
    run.head_repository?.full_name !== env.GITHUB_REPOSITORY
  )
    throw new Error('Unexpected workflow identity');
  const jobsFor = async (r) => {
    const jobs = [];
    for (let page = 1; page <= 10; page++) {
      const data = await get(
        `actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100&page=${page}`,
      );
      if (!Array.isArray(data.jobs) || !Number.isInteger(data.total_count))
        throw new Error('Malformed jobs response');
      jobs.push(...data.jobs);
      if (jobs.length >= data.total_count) return jobs;
      if (!data.jobs.length) break;
    }
    throw new Error('Incomplete job pagination');
  };
  // A run's configuration fingerprint as that run published it: the one artifact named for its
  // id and attempt. A run that published none (no observer, or it failed) is not comparable.
  const publishedHash = async (r) => {
    const data = await get(`actions/runs/${r.id}/artifacts?per_page=100`);
    if (!Array.isArray(data.artifacts)) throw new Error('Malformed artifacts response');
    const prefix = `${ARTIFACT}-${r.id}-${r.run_attempt}-`;
    const names = data.artifacts
      .map((a) => a?.name)
      .filter((name) => typeof name === 'string' && name.startsWith(prefix));
    const hash = names.length === 1 ? names[0].slice(prefix.length) : '';
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('No published configuration');
    return hash;
  };
  // Fingerprint the tree this run executed. A PR run executes the merge commit, so the PR head's
  // tree can hold an older workflow, lockfile or config than the one that ran (#257 review F15).
  const hash = fingerprint(await get(`git/trees/${sha}?recursive=1`), c);
  const current = { ...runMetrics(run, await jobsFor(run), c, hash), sha };
  const list = await get(
    `actions/workflows/${run.workflow_id}/runs?event=pull_request&status=success&per_page=100`,
  );
  if (!Array.isArray(list.workflow_runs)) throw new Error('Malformed workflow history');
  const history = [];
  let excluded = 0;
  for (const old of list.workflow_runs
    .filter(
      (r) =>
        r.id !== id &&
        r.status === 'completed' &&
        r.conclusion === 'success' &&
        r.path === c.workflowPath &&
        r.head_repository?.full_name === env.GITHUB_REPOSITORY &&
        time(r.created_at) < time(run.created_at),
    )
    .slice(0, c.historyLimit)) {
    try {
      const oldHash = await publishedHash(old);
      if (oldHash !== hash) {
        excluded++;
        continue;
      }
      history.push(runMetrics(old, await jobsFor(old), c, oldHash));
    } catch {
      excluded++;
    }
  }
  return {
    schemaVersion: 1,
    observationStatus: 'available',
    current,
    trend: evaluateTrend(current, history, c),
    excludedHistoryRuns: excluded,
  };
}

/**
 * The report when nothing could be observed, with the reason. The script's own errors name what
 * was missing; a response body never reaches the reason (a JSON parse error quotes the body).
 */
export function unavailableReport(error) {
  const reason =
    error instanceof SyntaxError
      ? 'Malformed API response'
      : String(error?.message ?? error).slice(0, 200);
  return { schemaVersion: 1, observationStatus: 'unavailable', reason };
}

/** The GITHUB_OUTPUT line the upload step names the artifact with, which later runs read. */
export const configOutput = (report) =>
  `config=${report.current?.configHash ?? report.observationStatus}\n`;

export function performanceSummary(report) {
  if (report.observationStatus === 'not-adopted')
    return `## Test performance budgets\n\n${NOT_ADOPTED}\n`;
  if (report.observationStatus !== 'available')
    return `## Test performance budgets\n\nObservation unavailable (${report.reason ?? 'no reason given'}); no timing success or regression can be inferred. Existing CI gates remain required.\n`;
  const r = report.current;
  return [
    '## Test performance budgets',
    '',
    `Status: ${report.trend.status}; ${report.trend.comparableRuns} comparable historical runs (${report.excludedHistoryRuns} excluded).`,
    `Configuration ${r.configHash.slice(0, 12)}, from merge commit ${r.sha.slice(0, 12)} (PR head ${r.headSha.slice(0, 12)}).`,
    `Complete gate: ${r.fullGateSeconds.toFixed(1)}s; initial queue: ${r.initialQueueSeconds.toFixed(1)}s; gate runner-minutes: ${r.gateRunnerMinutes.toFixed(2)}; suite runner-minutes: ${r.suiteRunnerMinutes.toFixed(2)}.`,
    `Suite jobs: ${r.suiteJobs}; longest/median suite job: ${r.shardImbalanceRatio.toFixed(2)}.`,
    '',
    ...report.trend.warnings.map((w) => `- ${w}`),
    '',
    'Investigate sustained warnings with the timing profiles and docs/TESTING.md. Trends compare only runs that executed the same comparison files on the same job names and runner labels; runner image and load can still differ. This is not a matched benchmark or a test/coverage certificate.',
    '',
  ].join('\n');
}

// The /kit-upgrade audit (DECISIONS 2026-10-22, option B). Every upgrade records the observer's
// latest status for the app in one line. The dated audit (docs/test-performance/AUDIT-TEMPLATE.md)
// is required only when that status warns; otherwise it is optional.
const REPORT = '.test-results/test-performance.json';
const PROFILE = '.test-results/test-profile.json';
const DRAFT = '.test-results/test-audit.md';
// The runtime manifests of an app whose suite is split into Node and minimal Workers projects.
// Read as text and never imported: scripts/ may not import from test/ (the arming-seam fence,
// test/isolation/agentArmingSeams.ts), and an app without the split has no such file (#257
// review F1).
const MANIFEST = 'test/projects.mjs';
const MANIFEST_LISTS = ['nodeTestFiles', 'minimalWorkersTestFiles'];
const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim().slice(0, 200);
const cell = (v) =>
  String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('`', '&#96;')
    .replace(/[\r\n]/g, ' ');
const unavailableTrigger = (reason) => ({
  status: 'unavailable',
  required: false,
  reasons: [oneLine(reason)],
  run: null,
});

/**
 * What the observer's latest report means for an upgrade: `warning` (the audit is required) when
 * the observer warns of a sustained budget overrun or a sustained regression, or the reported
 * complete gate alone took longer than the budget's fullGateSeconds; `clear` (optional) when none
 * of those; `unavailable` (optional, and nothing inferred) when there is no budget, no report, an
 * unavailable observation, or a report without the evidence a status needs.
 */
export function auditTrigger(report, budget) {
  if (!budget || report?.observationStatus === 'not-adopted')
    return unavailableTrigger('no test-performance budget adopted');
  if (report === null || report === undefined) return unavailableTrigger('no observer report');
  if (report.observationStatus !== 'available')
    return unavailableTrigger(report.reason ?? 'observation unavailable');
  const gate = report.current?.fullGateSeconds;
  const trend = report.trend;
  if (
    typeof gate !== 'number' ||
    !Number.isFinite(gate) ||
    gate < 0 ||
    typeof trend?.status !== 'string' ||
    !Number.isInteger(trend.comparableRuns) ||
    !Array.isArray(trend.warnings) ||
    !trend.warnings.every((w) => typeof w === 'string')
  )
    return unavailableTrigger('malformed observer report');
  const { runId, attempt, createdAt } = report.current;
  // createdAt dates the tree the observer measured, which a draft's profile must postdate.
  const run =
    Number.isSafeInteger(runId) && Number.isSafeInteger(attempt)
      ? { id: runId, attempt, ...(typeof createdAt === 'string' ? { createdAt } : {}) }
      : null;
  const reasons = trend.warnings.map(oneLine);
  if (gate > budget.fullGateSeconds)
    reasons.push(
      `complete gate ${gate.toFixed(1)}s over fullGateSeconds ${budget.fullGateSeconds}s`,
    );
  if (reasons.length) return { status: 'warning', required: true, reasons, run };
  return {
    status: 'clear',
    required: false,
    reasons: [oneLine(`${trend.status}, ${trend.comparableRuns} comparable runs`)],
    run,
  };
}

/** The one line an upgrade's closeout records. */
export function auditLine(trigger) {
  const run = trigger.run ? `, observer run ${trigger.run.id} attempt ${trigger.run.attempt}` : '';
  return `Test performance: ${trigger.status} (${trigger.reasons.join('; ')})${run}. Audit ${trigger.required ? 'triggered' : 'not triggered'}.`;
}

// The list of plain string literals that starts at `from` (just after its `[`) and runs to its
// `]`, with commas, whitespace and comments between them, read token by token so a `]` inside a
// comment or a string does not end it. null for anything else (a spread, a call, a template),
// which the audit cannot read without running it.
function stringList(text, from) {
  const token = /\s+|,|\/\/[^\n]*|\/\*[\s\S]*?\*\/|'([^'\\\n]*)'|"([^"\\\n]*)"|(\])/y;
  token.lastIndex = from;
  const items = [];
  for (;;) {
    const m = token.exec(text);
    if (!m) return null;
    if (m[3]) return items;
    if (m[1] !== undefined || m[2] !== undefined) items.push(m[1] ?? m[2]);
  }
}

/**
 * The runtime manifests, read from test/projects.mjs as data: `export const <list> = [...]` of
 * plain strings. A list the file does not name is left out, so a test it does not list runs in
 * full Workers. A list it names in any other form is refused, never read as empty. No file is
 * null: the app has no manifests, and its vitest.config.ts alone says where each test runs (a
 * fork may define DOM projects there, #288 review F6).
 */
export function readManifests(root = process.cwd()) {
  const file = join(root, MANIFEST);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const manifests = {};
  for (const name of MANIFEST_LISTS) {
    if (!new RegExp(String.raw`\b${name}\b`).test(text)) continue;
    const start = new RegExp(String.raw`\bexport\s+const\s+${name}\s*=\s*\[`).exec(text);
    const items = start && stringList(text, start.index + start[0].length);
    if (!items)
      throw new Error(
        `${MANIFEST}: ${name} is not \`export const ${name} = [...]\` of plain strings, so the audit cannot read it as data`,
      );
    manifests[name] = items;
  }
  return manifests;
}

/**
 * The audit's review draft: the trigger, the 20 slowest files and their runtime, the checklist.
 * `manifests` is readManifests()'s result; null (no test/projects.mjs) labels no runtime.
 */
export function auditMarkdown(profile, manifests = null, trigger = undefined) {
  if (
    profile?.schemaVersion !== 1 ||
    profile.reportStatus !== 'available' ||
    !Array.isArray(profile.files) ||
    !profile.files.every((f) => typeof f?.path === 'string') ||
    !profile.counts
  )
    throw new Error(
      `Audit requires a current normalized test profile (${PROFILE}, from npm run test:profile)`,
    );
  const node = new Set(manifests?.nodeTestFiles ?? []);
  const minimal = new Set(manifests?.minimalWorkersTestFiles ?? []);
  const unlisted = manifests ? 'full Workers' : 'unlisted (runtime per vitest.config.ts)';
  const files = [...profile.files].sort(
    (a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1) || a.path.localeCompare(b.path),
  );
  const layer = (p) => (node.has(p) ? 'Node' : minimal.has(p) ? 'minimal Workers' : unlisted);
  return [
    '# Test-suite audit — DRAFT, review required',
    '',
    `Trigger: ${trigger ? cell(auditLine(trigger)) : 'not recorded'}`,
    `Profile date: ${cell(profile.startedAt)}; coverage step: ${cell(profile.stepOutcome ?? 'local: record the command exit status')}.`,
    `${profile.counts.files} files; ${profile.counts.tests} test cases; suite-step wall time ${(profile.elapsedMs / 1000).toFixed(2)}s. File times overlap and leave out some startup and coverage work.`,
    '',
    '| Slowest file | Runtime | File seconds |',
    '| --- | --- | ---: |',
    ...files
      .slice(0, 20)
      .map(
        (f) =>
          `| ${cell(f.path)} | ${layer(f.path)} | ${typeof f.durationMs === 'number' ? (f.durationMs / 1000).toFixed(3) : 'unknown'} |`,
      ),
    '',
    'Complete every section of docs/test-performance/AUDIT-TEMPLATE.md as docs/test-performance/<date>-<upgrade>.md; this draft does not complete the audit.',
    '',
    '- [ ] Baseline: revisions, command exits, inventory, coverage and security results, complete-gate and runner-minute evidence.',
    '- [ ] The 20 slowest files above, and every full Workers test added since the last audit.',
    '- [ ] Imports, setup, fixtures and waits; runtime placement and transitive imports; shard balance.',
    '- [ ] Test intent: each candidate, the failure it detects, its independent expected result, the retained case and its regression or mutation proof, the decision.',
    '- [ ] Focused feedback measured locally; every PR gate, coverage floor and security tripwire kept.',
    '- [ ] Budget ownership, unresolved gaps, and the owner or issue for each.',
    '',
    'End in an evidence-backed change, or an evidenced no-change decision. This draft moves and deletes nothing; a moved, split or consolidated test is its own reviewable change.',
    '',
  ].join('\n');
}

// `audit [report] [--draft]`: prints the closeout line for the observer report (by default
// .test-results/test-performance.json). Only --draft drafts the audit, required or optional,
// and only from a profile newer than the observer run. Step 2 of /kit-upgrade runs it before the
// upgrade, when .test-results/test-profile.json, if any, profiles an earlier tree; step 5 runs it
// with --draft once npm run ci has profiled the final tree (#288 review F1).
function runAudit(args) {
  const draft = args.includes('--draft');
  const paths = args.filter((a) => a !== '--draft');
  if (paths.length > 1 || paths.some((p) => p.startsWith('-'))) {
    console.error('Usage: node scripts/test-performance.mjs audit [observer report] [--draft]');
    process.exitCode = 2;
    return;
  }
  // Step 2's command run again in a later shell, which has lost its variables, passes an empty
  // path, or in bash the glob it could not expand. That is not a missing report, so it gets no
  // line: an "unavailable" line here would skip an audit the real report requires (#288 review
  // R1, round 2).
  if (paths.some((p) => p === '' || p.includes('*'))) {
    console.error(
      `Audit: ${JSON.stringify(oneLine(paths[0]))} is empty or an unexpanded glob, not an observer report. Shell variables do not survive from one command to the next: pass the path /kit-upgrade step 2 printed after "Observer report:", written out.`,
    );
    process.exitCode = 2;
    return;
  }
  const path = paths[0] ?? REPORT;
  // A JSON parse error quotes the file it read, so its message never reaches the line.
  const reason = (what, error) =>
    `${what}: ${error instanceof SyntaxError ? 'not JSON' : (error?.message ?? error)}`;
  let budget;
  let trigger;
  try {
    budget = readBudget();
  } catch (error) {
    trigger = unavailableTrigger(reason('budget unreadable', error));
  }
  if (!trigger) {
    if (!budget) trigger = auditTrigger(null, null);
    else if (!existsSync(path)) trigger = unavailableTrigger(`no observer report at ${path}`);
    else {
      try {
        trigger = auditTrigger(JSON.parse(readFileSync(path, 'utf8')), budget);
      } catch (error) {
        trigger = unavailableTrigger(
          error instanceof SyntaxError ? 'Malformed observer report' : reason(path, error),
        );
      }
    }
  }
  console.log(auditLine(trigger));
  if (!draft) return;
  if (existsSync(DRAFT)) {
    console.error(
      `Audit draft: kept ${DRAFT}. Move the reviewed draft to docs/test-performance/ before drafting another.`,
    );
    process.exitCode = 1;
    return;
  }
  let profile;
  try {
    profile = JSON.parse(readFileSync(PROFILE, 'utf8'));
  } catch {
    console.error(
      `Audit draft: no readable ${PROFILE}. Run npm run test:profile (or npm run ci) on the final tree, then run this again.`,
    );
    process.exitCode = 1;
    return;
  }
  let text;
  try {
    text = auditMarkdown(profile, readManifests(), trigger);
  } catch (error) {
    console.error(`Audit draft: ${error.message}.`);
    process.exitCode = 1;
    return;
  }
  // A profile from before the observer run profiles a tree from before this upgrade: an earlier
  // npm run ci, or a step-5 chain that stopped before its test:profile step.
  const observedAt = Date.parse(trigger.run?.createdAt ?? '');
  if (Number.isFinite(observedAt) && !(Date.parse(profile.startedAt) > observedAt)) {
    console.error(
      `Audit draft: ${PROFILE} (started ${oneLine(profile.startedAt)}) is not newer than observer run ${trigger.run.id} (${oneLine(trigger.run.createdAt)}), so it profiles an earlier tree. Run npm run test:profile (or npm run ci) on the final tree, then run this again.`,
    );
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(DRAFT), { recursive: true });
  writeFileSync(DRAFT, text, { flag: 'wx' });
  console.log(
    `Audit draft: ${DRAFT}. Complete it from docs/test-performance/AUDIT-TEMPLATE.md; it moves and deletes nothing.`,
  );
}

if (isMainModule(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'audit') runAudit(process.argv.slice(3));
  else if (mode !== 'check' && mode !== 'ci') {
    console.error('Usage: node scripts/test-performance.mjs check|ci|audit');
    process.exitCode = 2;
  } else {
    if (mode === 'check') {
      const c = readBudget();
      console.log(c ? 'Test performance budget/config: valid' : `::notice::${NOT_ADOPTED}`);
    } else {
      // The observer never goes red over its own input: a budget it cannot read is reported as
      // unavailable, and `check` in test-gates is where that fails.
      let report;
      try {
        const c = readBudget();
        report = c
          ? await collectPerformance(c)
          : { schemaVersion: 1, observationStatus: 'not-adopted' };
      } catch (error) {
        report = unavailableReport(error);
      }
      mkdirSync('.test-results', { recursive: true });
      writeFileSync('.test-results/test-performance.json', `${JSON.stringify(report, null, 2)}\n`);
      // The upload step names the artifact with this, which is how later runs read it.
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, configOutput(report));
      const summary = performanceSummary(report);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      console.log(summary);
      for (const warning of report.trend?.warnings ?? [])
        console.log(`::warning::Test performance: ${warning}. See docs/TESTING.md.`);
      if (report.observationStatus === 'unavailable')
        console.log(
          '::warning::Test performance observation unavailable; inspect API access and workflow/config mapping.',
        );
      if (report.observationStatus === 'not-adopted') console.log(`::notice::${NOT_ADOPTED}`);
    }
  }
}
