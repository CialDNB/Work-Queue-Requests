// Pins the layout behind the required `test` check (.github/workflows/ci.yml). The static gates
// (`test-gates`) and every job that runs the profiled suite (the kit's `test-suite`, or a clone's
// shard matrix under its own id) start under the tree memo's condition, each with a hard
// timeout, and the `test` job passes only when every job it needs succeeded in the same run. It
// also pins the parts of that contract no other test reads: the memo's verdict (its script, run
// against a stand-in `gh`), deploy-staging's dependency on `test`, the workflow's read-only
// token, and the four required check names (the ruleset requires `test`, `semgrep`,
// `actionlint` and `secrets-scan`; a check is named after its job id unless the job sets
// `name:`). And it pins the test-performance observer as evidence that never gates: it runs on
// PRs only, after every required check, with a read-only token and a 5-minute cap; nothing needs
// it; it continues on error, and so does its upload, so a red observation leaves the run green
// for main's tree memo; it installs nothing and its checkout keeps no token; its artifact, which
// later runs compare with, is kept at least 90 days; and the workflow calls its script with
// `node`, never through an npm script a fork lacks.
//
// These checks are drift tripwires, not a security boundary (docs/TESTING.md, "What the wiring
// tests catch"). They catch an accidental or well-meant edit after which `test` passes, or a
// deploy ships, with a red suite: `!cancelled()` dropped from the aggregate's `if:`, a result
// term added to it, a result read from the wrong job, `continue-on-error:` or `if:` added to get
// green, a gate step lost in a move, a timeout dropped, a required check renamed, a memo that
// answers "tested" for a tree that never passed, a write token where dependencies install. They
// pass what fails closed: a clone's own job ids, extra jobs, a stricter `if:` on a job `test`
// needs (a skipped job reads `skipped`, and `test` fails), steps after the aggregate's check, a
// fork's memo that answers "tested" less often. A PR that edits ci.yml can edit this file in
// the same PR, so a deliberate softening is caught only by the owner's review of that PR. Run by
// `node --test` (test:scripts), like its siblings.
//
// The first five tests check this repo's own ci.yml, in the kit or in a fork that carries this
// file. The rest are the pin's self-tests: they edit the kit's ci.yml text, so they run only in
// the unforked kit.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { parseJsonc, TEMPLATE_KEBAB } from '../../scripts/new-app.mjs';

const ROOT = new URL('../../', import.meta.url);
const CI = readFileSync(new URL('.github/workflows/ci.yml', ROOT), 'utf8');
const readOr = (path, fallback) => {
  try {
    return readFileSync(new URL(path, ROOT), 'utf8');
  } catch {
    return fallback;
  }
};
// What this repo is, for the two rules that depend on it:
// - `kit`: the unforked kit, whose wrangler.jsonc still carries the template's name (the signal
//   isTemplateRepo() in scripts/new-app.mjs reads). Its memo is the one the stand-in `gh` below is
//   written for.
// - `pluginMirror`: a plugin mirror exists, as the verify:plugin step's own guard,
//   hashFiles('plugins/*/sync-from-harness.mjs'), finds it. The step then always runs.
const REPO = {
  kit: parseJsonc(readOr('wrangler.jsonc', '{}'))?.name === TEMPLATE_KEBAB,
  pluginMirror: (() => {
    try {
      return readdirSync(new URL('plugins/', ROOT)).some((dir) =>
        existsSync(new URL(`plugins/${dir}/sync-from-harness.mjs`, ROOT)),
      );
    } catch {
      return false;
    }
  })(),
};

// Reads ci.yml just closely enough to find each job's fields and steps: block-style maps and
// lists (a list item is a map, `- run: …`, or a scalar, `- gate`), and a value continued on
// deeper lines (a wrapped value, or a `|`/`>-` block) read whole. Comments, blank lines and
// quotes around a whole value are dropped. Not a YAML parser: a line in another shape (a flow
// map, an anchor) is skipped, since only a deliberate edit writes a workflow that way, and the
// owner's review of the PR covers those.
const FIELD = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;

function readWorkflow(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }))
    .filter((line) => line.text && !line.text.startsWith('#'));
  let i = 0;
  const scalar = (raw) => {
    const value = raw.replace(/\s+#.*$/, '');
    const quoted = /^(['"])(.*)\1$/.exec(value);
    return quoted ? quoted[2] : value;
  };
  const value = (rest, indent) => {
    if (!rest) {
      const next = lines[i];
      const nested =
        next && (next.indent > indent || (next.indent === indent && next.text.startsWith('- ')));
      return nested ? node(next.indent) : '';
    }
    const parts = /^[|>]/.test(rest) ? [] : [scalar(rest)];
    for (; i < lines.length && lines[i].indent > indent; i++) parts.push(lines[i].text);
    return parts.join(rest.startsWith('|') ? '\n' : ' ');
  };
  const node = (indent) => {
    const list = lines[i].text.startsWith('- ');
    const out = list ? [] : {};
    while (i < lines.length && lines[i].indent >= indent) {
      const { indent: at, text } = lines[i];
      if (at > indent) {
        i++; // a line this reader cannot place
      } else if (list) {
        if (!text.startsWith('- ')) break;
        const content = text.slice(2).trimStart();
        if (FIELD.test(content)) {
          // `- key: value` starts a map whose keys line up with this first one.
          lines[i] = { indent: at + text.length - content.length, text: content };
          out.push(node(lines[i].indent));
        } else {
          out.push(scalar(content));
          i++;
        }
      } else {
        if (text.startsWith('- ')) break;
        const field = FIELD.exec(text);
        i++;
        if (field) out[field[1]] = value(field[2], at);
      }
    }
    return out;
  };
  return node(0);
}

const jobsOf = (text) => readWorkflow(text).jobs ?? {};
const squash = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const needsOf = (job) => {
  if (Array.isArray(job?.needs)) return job.needs.map(squash).filter(Boolean);
  const flow = /^\[(.*)\]$/.exec(squash(job?.needs));
  return (flow ? flow[1].split(',') : [job?.needs ?? '']).map(squash).filter(Boolean);
};
const stepsOf = (job) => (Array.isArray(job?.steps) ? job.steps : []);
// `continue-on-error: true` turns a failure green; only `false` (or nothing) keeps it red.
const softened = (fields) => ![undefined, 'false'].includes(fields?.['continue-on-error']);
// A token that can write nothing: every scope `read` or `none`, `read-all`, or `{}`.
const readOnly = (permissions) =>
  ['read-all', '{}'].includes(permissions) ||
  (typeof permissions === 'object' &&
    !Array.isArray(permissions) &&
    Object.values(permissions).every((scope) => ['read', 'none'].includes(scope)));

// The tree memo's condition: every job behind `test`, `test` itself and semgrep run on every PR
// (the push-only gate job is skipped there), and on a push to main unless the gate proved the
// tree already passed on its PR. The aggregate's `if:` is exactly this; a job it needs carries
// both terms and may add its own.
const MEMO_IF = `\${{ !cancelled() && needs.gate.outputs.tested != 'true' }}`;
const MEMO_TERMS = ['!cancelled()', "needs.gate.outputs.tested != 'true'"];
// The static gates the single `test` job ran before the split, each in test-gates exactly once,
// as written or in a stricter form. `if` is the one condition a gate may carry.
const STATIC_GATES = [
  'npm run typecheck',
  'npm run lint',
  'npm run build:web',
  'npm run test:hooks',
  'npm run test:scripts',
  'npm run verify:core',
  // Report-only today; it graduates in place with `-- --gate` (DECISIONS 2026-08-14).
  ['npm run verify:needs', /^npm run verify:needs(?: -- --gate(?:=\d+)?)?$/],
  'npm run verify:bootstrap',
  'npm run verify:edge',
  'node scripts/check-kit-migrations.mjs',
  // Passes with a notice in an app with no budget file, so every fork can carry it.
  'node scripts/test-performance.mjs check',
  'npm run verify:agents',
  'npm run verify:skills',
  // Required where a plugin mirror exists (the kit, and a fork that keeps its own); a fork
  // without one may drop the step, which would only skip itself there.
  [
    'npm run verify:plugin',
    /^npm run verify:plugin$/,
    { mirror: true, if: `\${{ hashFiles('plugins/*/sync-from-harness.mjs') != '' }}` },
  ],
  'npm run verify:deps',
].map((gate) => {
  const [command, pattern, options] = Array.isArray(gate) ? gate : [gate];
  return { command, matches: (run) => (pattern ? pattern.test(run) : run === command), ...options };
});
// `npm ci` and its own flags (`--no-audit`); an operator after it is not an install step.
const INSTALL = /^npm ci(?: --?[\w-]+(?:=[\w.@/:-]+)?)*$/;
// Any step that fetches or runs dependency code, written any way: the write-scope rule's blocklist.
const FETCHES = /\b(?:npm\s+(?:ci|install|i|add|exec|x)|npx|pnpm|yarn|bunx?)\b/;
const installs = (job) => stepsOf(job).some((step) => FETCHES.test(String(step.run ?? '')));
const PROFILED = (step) => step.run === 'node scripts/test-profile.mjs summarize';
const TIMING_UPLOAD = (step) => String(step.uses ?? '').startsWith('actions/upload-artifact@');
const RESULT = /^\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}$/;
const REQUIRED_CHECKS = ['test', 'semgrep', 'actionlint', 'secrets-scan'];
// The jobs that run the suite, found as test-profile.test.mjs finds them: by what they run.
const suiteJobsOf = (jobs) => Object.keys(jobs).filter((id) => stepsOf(jobs[id]).some(PROFILED));

/** test-gates and the suite jobs: the memo's condition, a hard timeout, every static gate. */
function parallelProblems(text, repo = REPO) {
  const jobs = jobsOf(text);
  const problems = [];
  const suites = suiteJobsOf(jobs);
  if (!suites.length) problems.push('no job runs the profiled suite (test-profile.mjs summarize)');
  for (const id of new Set(['test-gates', ...suites])) {
    const job = jobs[id];
    if (!job) {
      problems.push(`no \`${id}\` job`);
      continue;
    }
    if (!needsOf(job).includes('gate')) problems.push(`${id}: needs no \`gate\`, so no memo`);
    for (const term of MEMO_TERMS)
      if (!squash(job.if).includes(term))
        problems.push(`${id}: \`if: ${squash(job.if)}\` lacks the memo's \`${term}\``);
    // GitHub's default is 360 minutes; a stalled Workers runtime would hold `test` that long.
    const timeout = /^\d+$/.test(job['timeout-minutes'] ?? '') ? Number(job['timeout-minutes']) : 0;
    if (!(timeout > 0 && timeout < 360))
      problems.push(`${id}: no \`timeout-minutes:\` below GitHub's 360-minute default`);
    if (!stepsOf(job).some((step) => INSTALL.test(step.run ?? '')))
      problems.push(`${id}: installs nothing (no \`npm ci\` step)`);
  }
  const gates = stepsOf(jobs['test-gates']);
  for (const gate of STATIC_GATES) {
    const found = gates.filter((step) => gate.matches(step.run ?? ''));
    const optional = gate.mirror && !repo.pluginMirror;
    if (found.length !== 1 && !(optional && found.length === 0)) {
      problems.push(`test-gates: \`${gate.command}\` appears ${found.length} times, not once`);
      continue;
    }
    for (const step of found)
      if (![undefined, gate.if].map(squash).includes(squash(step.if)))
        problems.push(`test-gates: \`${gate.command}\` has \`if: ${squash(step.if)}\``);
  }
  // Every job's steps: only the timing upload, which is evidence and never a gate, may continue
  // on error (test-profile.test.mjs pins that one).
  for (const [id, job] of Object.entries(jobs))
    for (const step of stepsOf(job))
      if (softened(step) && !TIMING_UPLOAD(step))
        problems.push(`${id}: \`continue-on-error:\` on \`${step.run ?? step.uses ?? step.name}\``);
  return problems;
}

/** The required `test` aggregate: when it runs, what it waits for, and what it reads. */
function aggregateProblems(text) {
  const jobs = jobsOf(text);
  const job = jobs.test;
  if (!job) return ['no `test` job: the required check never reports'];
  const problems = [];
  const needs = needsOf(job);
  for (const id of ['gate', 'test-gates'])
    if (!needs.includes(id)) problems.push(`test: does not need ${id}`);
  // The suite's coverage step (pinned by test-profile.test.mjs) is in a job `test` waits for.
  for (const id of suiteJobsOf(jobs))
    if (!needs.includes(id)) problems.push(`test: does not need ${id}, which runs the suite`);
  // A job allowed to fail reports `success` as its result, so `test` would read a red job green.
  for (const id of needs)
    if (id !== 'gate' && softened(jobs[id]))
      problems.push(`${id}: job-level \`continue-on-error:\` reads as success in \`test\``);
  // Exact on purpose. A required job that is skipped reports success: without `!cancelled()`
  // the implicit success() skips `test` on every PR, and a term on a needed job's result skips it
  // exactly when that job fails.
  if (squash(job.if) !== MEMO_IF)
    problems.push(`test: \`if: ${squash(job.if)}\` is not the memo's condition ${MEMO_IF}`);
  if (softened(job)) problems.push('test: job-level `continue-on-error:` turns it green');
  // The check is the first step. A clone's steps after it (insights merges its shards' coverage
  // and enforces the floors there) run only once it passed: they can add a red, never hide one.
  const [step] = stepsOf(job);
  if (!step) return [...problems, 'test: no steps, so no check'];
  if (step.if !== undefined) problems.push(`test: \`if: ${squash(step.if)}\` can skip the check`);
  if (softened(step)) problems.push('test: `continue-on-error:` on the check turns it green');
  // Every needed job but the gate is read once, from its own result.
  // Anything else it reads (insights' docs-only scope) can pass `test` without that success.
  const env = typeof step.env === 'object' && !Array.isArray(step.env) ? step.env : {};
  const read = [];
  const names = [];
  for (const [name, value] of Object.entries(env)) {
    const from = RESULT.exec(value);
    if (!from) problems.push(`test: env ${name} is \`${value}\`, not a needed job's result`);
    else {
      read.push(from[1]);
      names.push(name);
    }
  }
  const expected = needs.filter((id) => id !== 'gate').sort();
  if (JSON.stringify([...read].sort()) !== JSON.stringify(expected))
    problems.push(`test: env reads [${read.sort()}], not each of [${expected}] once`);
  if (typeof step.run !== 'string' || !step.run) return [...problems, 'test: no `run:` check'];
  // Behavior, not text: the check passes on all-success, and fails when any one result is
  // anything else, including no result at all.
  const run = (values) =>
    spawnSync('bash', ['-e', '-c', step.run], {
      env: { PATH: process.env.PATH, ...values },
      encoding: 'utf8',
    }).status;
  const allGreen = Object.fromEntries(names.map((name) => [name, 'success']));
  if (run(allGreen) !== 0) problems.push('test: fails when every needed job succeeded');
  for (const name of names)
    for (const result of ['failure', 'cancelled', 'skipped', ''])
      if (run({ ...allGreen, [name]: result }) === 0)
        problems.push(`test: passes with ${name}=${JSON.stringify(result)}`);
  return problems;
}

/** The memo's wiring, deploy-staging's needs and condition, the token, the check names. */
function contractProblems(text) {
  const workflow = readWorkflow(text);
  const jobs = workflow.jobs ?? {};
  const problems = [];
  const gate = jobs.gate;
  if (squash(gate?.if) !== "github.event_name == 'push'")
    problems.push(`gate: \`if: ${squash(gate?.if)}\`; the memo answers pushes only`);
  if (squash(gate?.outputs?.tested) !== `\${{ steps.memo.outputs.tested }}`)
    problems.push('gate: `outputs.tested` is not the memo step output');
  if (!needsOf(jobs.semgrep).includes('gate') || squash(jobs.semgrep?.if) !== MEMO_IF)
    problems.push('semgrep: not on the memo condition');
  const deploy = jobs['deploy-staging'];
  for (const id of ['gate', 'test', 'semgrep', 'actionlint', 'secrets-scan'])
    if (!needsOf(deploy).includes(id)) problems.push(`deploy-staging: does not need ${id}`);
  // A skipped `test` or semgrep ships only with the gate's proof that this tree passed on its PR.
  const condition = squash(deploy?.if);
  for (const clause of [
    "needs.gate.result == 'success'",
    "needs.actionlint.result == 'success'",
    "needs.secrets-scan.result == 'success'",
    ...['test', 'semgrep'].map(
      (id) =>
        `(needs.${id}.result == 'success' || (needs.${id}.result == 'skipped' && needs.gate.outputs.tested == 'true'))`,
    ),
  ])
    if (!condition.includes(clause)) problems.push(`deploy-staging: \`if:\` lacks ${clause}`);
  // A job without its own `permissions:` gets the workflow's, and with no workflow block, the
  // repository default: write, on this repository. test-gates and the suite jobs run `npm ci`
  // lifecycle scripts, and actions/checkout keeps the token in .git/config. So a job `test` reads
  // may hold a write scope only if it installs nothing: a fork's check that needs a push-level
  // token (arena-go's verify:merge-settings) runs in a job of its own, with no dependency code.
  if (!readOnly(workflow.permissions))
    problems.push('workflow: `permissions:` is not read-only, so jobs get the repository default');
  for (const id of ['test', ...needsOf(jobs.test)])
    if (
      jobs[id]?.permissions !== undefined &&
      !readOnly(jobs[id].permissions) &&
      installs(jobs[id])
    )
      problems.push(
        `${id}: \`permissions:\` grants a write scope to a job that installs dependencies`,
      );
  // A check is named after its job unless the job sets `name:`; a renamed required check never
  // reports, and another job named like one would report in its place.
  for (const id of REQUIRED_CHECKS) {
    if (!jobs[id]) problems.push(`no \`${id}\` job: the required check never reports`);
    else if (jobs[id].name !== undefined) problems.push(`${id}: \`name:\` renames its check`);
    if (softened(jobs[id])) problems.push(`${id}: job-level \`continue-on-error:\``);
  }
  for (const [id, job] of Object.entries(jobs))
    if (REQUIRED_CHECKS.includes(squash(job.name)) && squash(job.name) !== id)
      problems.push(`${id}: \`name: ${job.name}\` reports as a required check`);
  return problems;
}

// The test-performance observer: found by what it runs, so a fork may give it its own id. A fork
// may also drop it, since it is evidence, not a gate; the kit keeps it. The workflow calls the
// script with `node`, as it does the kit-migration guard: package.json does not ride /kit-upgrade,
// so a fork has no npm script for it (#257 review F2).
const OBSERVES = (step) => step.run === 'node scripts/test-performance.mjs ci';
const NPM_PERFORMANCE = /\bnpm run (?:verify:test-performance|test:performance)\b/;
const OBSERVER_TIMEOUT = 5;
// Later runs compare only with runs whose observation artifact still exists.
const OBSERVER_RETENTION_DAYS = 90;

/** The observer runs on PRs after every required check, reads only, is capped, and gates nothing. */
function observerProblems(text, repo = REPO) {
  const jobs = jobsOf(text);
  const problems = [];
  for (const [id, job] of Object.entries(jobs))
    for (const step of stepsOf(job))
      if (NPM_PERFORMANCE.test(String(step.run ?? '')))
        problems.push(
          `${id}: \`${squash(step.run)}\` needs an npm script a fork does not carry; run \`node scripts/test-performance.mjs\``,
        );
  const observers = Object.keys(jobs).filter((id) => stepsOf(jobs[id]).some(OBSERVES));
  if (!observers.length && repo.kit)
    problems.push('no job runs the observer (`node scripts/test-performance.mjs ci`)');
  for (const id of observers) {
    const job = jobs[id];
    const condition = squash(job.if);
    // After every required check has succeeded in this run, on PRs only. Without `!cancelled()`
    // the implicit success() skips it on every PR, where the push-only gate job is skipped.
    for (const check of REQUIRED_CHECKS) {
      if (!needsOf(job).includes(check))
        problems.push(`${id}: does not need ${check}, so it can observe a run that gate failed`);
      if (!condition.includes(`needs.${check}.result == 'success'`))
        problems.push(`${id}: \`if:\` lacks needs.${check}.result == 'success'`);
    }
    for (const term of ['!cancelled()', "github.event_name == 'pull_request'"])
      if (!condition.includes(term)) problems.push(`${id}: \`if:\` lacks \`${term}\``);
    // Its own token: it reads job timings (actions) and the run's tree (contents), and writes
    // nothing. Without its own block it gets the workflow's, which cannot read job timings.
    if (!readOnly(job.permissions) || job.permissions?.actions !== 'read')
      problems.push(`${id}: \`permissions:\` is not read-only with \`actions: read\``);
    const timeout = /^\d+$/.test(job['timeout-minutes'] ?? '') ? Number(job['timeout-minutes']) : 0;
    if (!(timeout > 0 && timeout <= OBSERVER_TIMEOUT))
      problems.push(`${id}: no \`timeout-minutes:\` of at most ${OBSERVER_TIMEOUT}`);
    // Nothing waits on it: a slow, red or missing observation never holds a merge or a deploy.
    for (const [other, dependent] of Object.entries(jobs))
      if (needsOf(dependent).includes(id))
        problems.push(`${other}: needs ${id}, so an observation can hold a merge or a deploy`);
    // A red observation leaves the run's conclusion success. Main's tree memo counts only a PR run
    // that concluded success, so without this a red observer re-runs the whole gate on main
    // (#287 review F3).
    if (job['continue-on-error'] !== 'true')
      problems.push(
        `${id}: no job-level \`continue-on-error: true\`, so a red observation fails the run and main's tree memo misses it`,
      );
    // It runs the PR's code with a token that reads every run's logs and artifacts: no
    // dependency code beside it, and no token left in .git/config (#287 review F6).
    if (installs(job))
      problems.push(`${id}: installs dependencies beside its \`actions: read\` token`);
    for (const step of stepsOf(job))
      if (
        String(step.uses ?? '').startsWith('actions/checkout@') &&
        step.with?.['persist-credentials'] !== 'false'
      )
        problems.push(
          `${id}: checks out without \`persist-credentials: false\`, so its token stays in .git/config`,
        );
    // Later runs find the runs that executed this configuration by the artifact's name.
    const observe = stepsOf(job).find(OBSERVES);
    const upload = stepsOf(job).find(TIMING_UPLOAD);
    // An artifact-service outage or a full quota shows on the step, not as a red job.
    if (upload && upload['continue-on-error'] !== 'true')
      problems.push(
        `${id}: the upload does not continue on error, so an artifact-service failure turns the observer red`,
      );
    // History reaches back only as far as the artifacts do (#287 review F8).
    const retention = upload?.with?.['retention-days'];
    if (
      retention !== undefined &&
      !(/^\d+$/.test(retention) && Number(retention) >= OBSERVER_RETENTION_DAYS)
    )
      problems.push(
        `${id}: keeps its observation for ${retention} days, under ${OBSERVER_RETENTION_DAYS}, so comparable history ends there`,
      );
    const name = `test-performance-\${{ github.run_id }}-\${{ github.run_attempt }}-\${{ steps.${observe.id}.outputs.config }}`;
    if (!observe.id)
      problems.push(`${id}: the observer step has no \`id:\`, so the upload cannot name its run`);
    else if (squash(upload?.with?.name) !== name)
      problems.push(`${id}: the upload is not named ${name}, so no later run can compare with it`);
    if (upload?.with?.path !== '.test-results/test-performance.json')
      problems.push(`${id}: the upload does not carry .test-results/test-performance.json`);
  }
  return problems;
}

// The memo's verdict, from its own `run:` script in bash as the runner runs it (`bash -e`), with
// a stand-in `gh` first on PATH. The stand-in answers the one call form the kit's memo makes,
// `gh api <path> --jq <filter>`, from a JSON fixture the way the REST API would (the runs list
// filtered by its `head_sha` and `status` query), and applies the filter with jq, as gh's own
// `--jq` does. Any other call fails, so a memo written another way looks nothing up and answers
// tested=false. jq ships on GitHub's runners and on macOS.
const GH_STAND_IN = `#!/usr/bin/env bash
set -u
if [ -n "\${GH_FAIL:-}" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
if [ "\${1:-}" != api ] || [ "\${3:-}" != --jq ]; then echo "gh stand-in: $*" >&2; exit 2; fi
path=\${2%%\\?*} query= filter=$4
case "$2" in *\\?*) query=\${2#*\\?} ;; esac
param() { printf '%s\\n' "$query" | tr '&' '\\n' | sed -n "s/^$1=//p" | head -n 1; }
repo="repos/$GITHUB_REPOSITORY"
case "$path" in
  "$repo/commits/$GITHUB_SHA/pulls") body=$(jq -c .pulls "$GH_FIXTURE") ;;
  "$repo/git/commits/"*)
    body=$(jq -ce --arg sha "\${path##*/}" '.commits[$sha]' "$GH_FIXTURE") ||
      { echo "HTTP 404: Not Found" >&2; exit 1; } ;;
  "$repo/actions/runs")
    body=$(jq -c --arg head "$(param head_sha)" --arg status "$(param status)" \\
      '{workflow_runs: [.runs[] | select(($head == "" or .head_sha == $head)
        and ($status == "" or .conclusion == $status))]}' "$GH_FIXTURE") ;;
  *) echo "HTTP 404: Not Found" >&2; exit 1 ;;
esac
printf '%s' "$body" | jq -r "$filter"
`;
const SHA = Object.fromEntries(
  ['merge', 'head', 'tree', 'other'].map((k, n) => [k, 'abcd'[n].repeat(40)]),
);
const MEMO_ENV = {
  GITHUB_REPOSITORY: 'org/app',
  GITHUB_SHA: SHA.merge,
  GITHUB_WORKFLOW_REF: 'org/app/.github/workflows/ci.yml@refs/heads/main',
  TREE: SHA.tree,
};
const MEMO_CASES = (() => {
  const pr = {
    merged_at: '2026-10-22T00:00:00Z',
    merge_commit_sha: SHA.merge,
    head: { sha: SHA.head },
  };
  const run = (fields) => ({
    head_sha: SHA.head,
    conclusion: 'success',
    path: '.github/workflows/ci.yml',
    head_repository: { full_name: 'org/app' },
    ...fields,
  });
  const proven = {
    pulls: [pr],
    commits: { [SHA.head]: { tree: { sha: SHA.tree } } },
    runs: [run()],
  };
  const other = { [SHA.head]: { tree: { sha: SHA.other } } };
  // [what the push is, the API's answers, env overrides, the verdict]
  return [
    ['a tree that passed on its merged PR', proven, {}, 'true'],
    ['a direct push (no merged PR)', { ...proven, pulls: [] }, {}, 'false'],
    [
      'a PR merged as another commit',
      { ...proven, pulls: [{ ...pr, merge_commit_sha: SHA.other }] },
      {},
      'false',
    ],
    ['main moved under the PR (another tree)', { ...proven, commits: other }, {}, 'false'],
    ['a push with no tree id', proven, { TREE: '' }, 'false'],
    [
      'a PR head whose runs all failed',
      { ...proven, runs: [run({ conclusion: 'failure' })] },
      {},
      'false',
    ],
    [
      'a green run of another commit only',
      { ...proven, runs: [run({ head_sha: SHA.other })] },
      {},
      'false',
    ],
    [
      "a fork's green run only",
      { ...proven, runs: [run({ head_repository: { full_name: 'x/app' } })] },
      {},
      'false',
    ],
    [
      "another workflow's green run only",
      { ...proven, runs: [run({ path: '.github/workflows/x.yml' })] },
      {},
      'false',
    ],
    ['an API that fails', proven, { GH_FAIL: '1' }, 'false'],
  ];
})();
const memoRuns = new Map();
const memoOf = (text) => stepsOf(jobsOf(text).gate).find((s) => s.id === 'memo');
// Each case's verdict from the memo's own script, run once per distinct script.
const memoResults = (script) => {
  if (!memoRuns.has(script)) memoRuns.set(script, runMemo(script));
  return memoRuns.get(script);
};

/**
 * The memo answers tested=true only for a tree that passed this workflow on its merged PR.
 *
 * In any repo, it must never answer tested=true for the nine cases that did not pass: that is
 * what would skip the suites and semgrep and ship an untested tree. In the kit it must also give
 * the proven tree tested=true and exit 0 in every case. The stand-in is written for the kit's
 * memo, and a memo it cannot drive answers tested=false for every case, so without that the nine
 * checks would pass on a memo that looked nothing up. A fork's memo that the stand-in cannot
 * drive (arena-go's reads earlier runs' job listings and artifacts; Arena-2's reads the tree with
 * git) answers false here, which only costs CI time, so it passes (review round 2 R2).
 */
function memoProblems(text, repo = REPO) {
  const step = memoOf(text);
  if (typeof step?.run !== 'string') return ['gate: no `memo` step with a `run:` script'];
  const results = memoResults(step.run);
  if (typeof results === 'string') return [results];
  const problems = [];
  for (const { label, want, got, status, stderr } of results) {
    if (want !== 'true' && got === 'true')
      problems.push(`gate: the memo answers tested=true for ${label}, not false`);
    else if (!repo.kit) continue;
    else if (status !== 0) problems.push(`gate: the memo exits ${status} for ${label}: ${stderr}`);
    else if (got !== want)
      problems.push(`gate: the memo answers tested=${got} for ${label}, not ${want}`);
  }
  return problems;
}

/** Whether the stand-in drove this memo to tested=true for the proven tree. */
const memoDriven = (text) => {
  const results = memoResults(memoOf(text)?.run ?? '');
  return Array.isArray(results) && results.some(({ want, got }) => want === 'true' && got === want);
};

function runMemo(script) {
  if (spawnSync('jq', ['--version']).status !== 0)
    return 'gate: the memo check needs jq on PATH (GitHub runners and macOS ship it)';
  const dir = mkdtempSync(join(tmpdir(), 'ci-memo-'));
  try {
    writeFileSync(join(dir, 'gh'), GH_STAND_IN, { mode: 0o755 });
    const results = [];
    for (const [label, fixture, env, want] of MEMO_CASES) {
      const paths = {
        GH_FIXTURE: 'fixture.json',
        GITHUB_OUTPUT: 'out',
        GITHUB_STEP_SUMMARY: 'sum',
        RUNNER_TEMP: 'runner-temp',
      };
      for (const [name, file] of Object.entries(paths)) paths[name] = join(dir, file);
      rmSync(paths.RUNNER_TEMP, { recursive: true, force: true });
      mkdirSync(paths.RUNNER_TEMP);
      writeFileSync(paths.GH_FIXTURE, JSON.stringify(fixture));
      writeFileSync(paths.GITHUB_OUTPUT, '');
      const result = spawnSync('bash', ['-e', '-c', script], {
        env: { PATH: `${dir}${delimiter}${process.env.PATH}`, ...MEMO_ENV, ...paths, ...env },
        encoding: 'utf8',
      });
      // Every `tested=` the memo wrote: the last one is the output, and any `true` is refused.
      const said = [...readFileSync(paths.GITHUB_OUTPUT, 'utf8').matchAll(/^tested=(.*)$/gm)];
      const values = said.map((match) => match[1]);
      results.push({
        label,
        want,
        got: values.includes('true') && want !== 'true' ? 'true' : values.at(-1),
        status: result.status,
        stderr: String(result.stderr ?? '').trim(),
      });
    }
    return results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const allProblems = (text, repo = REPO) => [
  ...parallelProblems(text, repo),
  ...aggregateProblems(text),
  ...contractProblems(text),
  ...memoProblems(text, repo),
  ...observerProblems(text, repo),
];

// The self-tests below edit the kit's ci.yml, so they run only in the kit, and each states the
// repo it stands for.
const KIT = { kit: true, pluginMirror: true };
const FORK = { kit: false, pluginMirror: false };
const SELF_TEST = REPO.kit
  ? {}
  : { skip: "these self-tests edit the kit's ci.yml; the kit's CI runs them" };

// An edit inside one job: the first `from` after the job's own `  <id>:` line.
function edit(id, from, to, text = CI) {
  const start = text.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `no job ${id}`);
  const at = text.indexOf(from, start);
  const next = text.slice(start + 1).search(/\n {2}[\w-]+:\n/);
  assert.ok(at >= 0 && (next < 0 || at < start + 1 + next), `${id}: no ${from}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

// The workflow without one exact piece of its text.
function without(from, text = CI) {
  assert.ok(text.includes(from), `no ${JSON.stringify(from)}`);
  return text.replace(from, '');
}

// Another job, inserted before actionlint.
function addJob(job, text = CI) {
  const at = text.indexOf('\n  actionlint:\n');
  assert.ok(at >= 0, 'no actionlint job');
  return `${text.slice(0, at + 1)}${job}\n${text.slice(at + 1)}`;
}

const E2E = `  e2e:
    needs: [gate]
    if: \${{ !cancelled() && needs.gate.outputs.tested != 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: npm ci
      - run: npm run test:e2e
`;

// A clone that shards as insights does: the matrix under its own id, started after the static
// gates, the merge and coverage floors in `test` after its result check, block-style `needs:`,
// and no plugin mirror (so no verify:plugin step).
function sharded() {
  let text = edit('test-suite', '  test-suite:\n', '  test-shard:\n');
  text = edit('test-shard', '    needs: [gate]\n', '    needs: [gate, test-gates]\n', text);
  text = edit(
    'test-shard',
    `    if: ${MEMO_IF}\n`,
    `    if: >-\n      \${{ !cancelled()\n          && needs.gate.outputs.tested != 'true'\n          && needs.test-gates.result == 'success' }}\n`,
    text,
  );
  text = edit(
    'test-shard',
    '    timeout-minutes: 30\n',
    '    timeout-minutes: 30\n    strategy:\n      fail-fast: false\n      matrix:\n        shard: [1, 2, 3, 4]\n',
    text,
  );
  text = edit(
    'test-shard',
    'npm run test:coverage -- ',
    `npm run test:coverage -- --shard=\${{ matrix.shard }}/\${{ strategy.job-total }} `,
    text,
  );
  text = edit(
    'test',
    '    needs: [gate, test-gates, test-suite]\n',
    '    needs:\n      - gate\n      - test-gates\n      - test-shard\n',
    text,
  );
  text = edit(
    'test',
    `SUITE_RESULT: \${{ needs.test-suite.result }}`,
    `SUITE_RESULT: \${{ needs.test-shard.result }}`,
    text,
  );
  text = edit(
    'test',
    '            exit 1\n          fi\n',
    `            exit 1\n          fi\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - run: npm ci\n      - name: Merge results and enforce coverage floors\n        run: npm run test:coverage:merge\n`,
    text,
  );
  text = edit(
    'test-gates',
    `      - run: npm run verify:plugin\n        if: \${{ hashFiles('plugins/*/sync-from-harness.mjs') != '' }}\n`,
    '',
    text,
  );
  return edit(
    'deploy-staging',
    '    needs: [gate, test, semgrep, actionlint, secrets-scan, deployment-target]\n',
    '    needs:\n      - gate\n      - test\n      - semgrep\n      - actionlint\n      - secrets-scan\n      - deployment-target\n',
    text,
  );
}

describe('the required `test` check behind parallel static gates and the full suite', () => {
  it('static gates and the full suite start together on the memo, each with a hard timeout', () => {
    assert.deepEqual(parallelProblems(CI), []);
  });

  it('`test` passes only when every job it needs succeeded in this run', () => {
    assert.deepEqual(aggregateProblems(CI), []);
  });

  it("deploy-staging needs `test`, the memo's wiring, the read-only token and check names hold", () => {
    assert.deepEqual(contractProblems(CI), []);
  });

  it('the memo answers tested=true only for a tree that passed on its merged PR', (t) => {
    assert.deepEqual(memoProblems(CI), []);
    if (!REPO.kit && !memoDriven(CI))
      t.diagnostic(
        'the stand-in gh could not drive this memo to tested=true for a proven tree, so this ' +
          'checked only that it never answers tested=true for a tree that did not pass; its own ' +
          'tests must prove when it answers true',
      );
  });

  it('the test-performance observer runs after every required check, reads only, and gates nothing', () => {
    assert.deepEqual(observerProblems(CI), []);
  });
});

// The pin's own tests: each edits the kit's ci.yml and states the repo it stands for.
describe("the pin's self-tests, on the kit's ci.yml", SELF_TEST, () => {
  it('refuses the plausible edits that pass `test` or a deploy on a red suite, or lose the memo', () => {
    const IF = `    if: ${MEMO_IF}\n`;
    const OFF_MEMO = `    if: \${{ needs.gate.outputs.tested != 'true' }}\n`;
    const SUITE = `          SUITE_RESULT: \${{ needs.test-suite.result }}\n`;
    const STEP = '      - name: Require the static gates and the full suite\n';
    const LINT = '      - run: npm run lint\n';
    const TOKEN = 'permissions:\n  contents: read\n\n';
    // Each edit with the problem it must be refused for, so one rule cannot hide another.
    for (const [label, text, refusal] of [
      // #257 review F4: each of the first three kept every earlier pin green.
      ['`!cancelled()` dropped', edit('test', IF, OFF_MEMO), /^test: `if: .*memo's condition/],
      [
        'a result term in `if:`',
        edit('test', IF, IF.replace(' }}', " && needs.test-suite.result == 'success' }}")),
        /^test: `if: .*memo's condition/,
      ],
      [
        'a result read from the wrong job',
        edit('test', SUITE, SUITE.replace('test-suite', 'test-gates')),
        /^test: env reads \[test-gates,test-gates\]/,
      ],
      [
        'the suite not needed',
        edit('test', 'needs: [gate, test-gates, test-suite]', 'needs: [gate, test-gates]'),
        /^test: does not need test-suite, which runs the suite$/,
      ],
      ['a result not read', edit('test', SUITE, ''), /^test: env reads \[test-gates\], not/],
      [
        'a constant result',
        edit('test', SUITE, '          SUITE_RESULT: success\n'),
        /^test: env SUITE_RESULT is `success`/,
      ],
      [
        '`if:` on the check step',
        edit('test', STEP, `${STEP}        if: github.event_name == 'push'\n`),
        /^test: `if: .*` can skip the check$/,
      ],
      [
        'continue-on-error on the check step',
        edit('test', STEP, `${STEP}        continue-on-error: true\n`),
        /^test: `continue-on-error:` on the check/,
      ],
      [
        'continue-on-error on the job',
        edit('test', IF, `${IF}    continue-on-error: true\n`),
        /^test: job-level `continue-on-error:`/,
      ],
      [
        'continue-on-error on the suite job',
        edit('test-suite', IF, `${IF}    continue-on-error: true\n`),
        /^test-suite: job-level `continue-on-error:` reads as success/,
      ],
      ['the exit dropped', edit('test', '            exit 1\n', ''), /^test: passes with /],
      [
        'the check exits 0',
        edit('test', '            exit 1\n', '            exit 0\n'),
        /^test: passes with STATIC_RESULT="failure"$/,
      ],
      ['the check renamed', edit('test', IF, `${IF}    name: Tests\n`), /^test: `name:` renames/],
      // #257 review F13: a Workers shutdown stall holds `test` for GitHub's 360-minute default.
      [
        'no suite timeout',
        edit('test-suite', '    timeout-minutes: 30\n', ''),
        /^test-suite: no `timeout-minutes:`/,
      ],
      [
        'the default timeout written out',
        edit('test-gates', '    timeout-minutes: 20\n', '    timeout-minutes: 360\n'),
        /^test-gates: no `timeout-minutes:`/,
      ],
      [
        'the suite off the memo',
        edit('test-suite', IF, OFF_MEMO),
        /^test-suite: `if: .*` lacks the memo's `!cancelled\(\)`$/,
      ],
      [
        'a gate lost in the move',
        edit('test-gates', '      - run: npm run verify:edge\n', ''),
        /^test-gates: `npm run verify:edge` appears 0 times/,
      ],
      [
        'a gate softened with `|| true`',
        edit('test-gates', LINT, '      - run: npm run lint || true\n'),
        /^test-gates: `npm run lint` appears 0 times/,
      ],
      [
        'a graduated gate softened with `|| true`',
        edit(
          'test-gates',
          '      - run: npm run verify:needs\n',
          '      - run: npm run verify:needs -- --gate || true\n',
        ),
        /^test-gates: `npm run verify:needs` appears 0 times/,
      ],
      [
        'a gate allowed to fail',
        edit('test-gates', LINT, `${LINT}        continue-on-error: true\n`),
        /^test-gates: `continue-on-error:` on `npm run lint`/,
      ],
      [
        'a gate skipped on pushes',
        edit('test-gates', LINT, `${LINT}        if: github.event_name == 'pull_request'\n`),
        /^test-gates: `npm run lint` has `if: /,
      ],
      [
        'the plugin guard skipped on pushes',
        edit(
          'test-gates',
          `        if: \${{ hashFiles('plugins/*/sync-from-harness.mjs') != '' }}\n`,
          "        if: github.event_name == 'pull_request'\n",
        ),
        /^test-gates: `npm run verify:plugin` has `if: /,
      ],
      // Review round 2 R1: where a plugin mirror exists (the kit), its guard is a static gate.
      [
        'the plugin guard lost where a mirror exists',
        edit(
          'test-gates',
          `      - run: npm run verify:plugin\n        if: \${{ hashFiles('plugins/*/sync-from-harness.mjs') != '' }}\n`,
          '',
        ),
        /^test-gates: `npm run verify:plugin` appears 0 times/,
      ],
      [
        'the suite moved to a job `test` does not need',
        edit('test-suite', '  test-suite:\n', '  coverage:\n'),
        /^test: does not need coverage, which runs the suite$/,
      ],
      [
        'deploy without `test`',
        edit('deploy-staging', 'needs: [gate, test, ', 'needs: [gate, '),
        /^deploy-staging: does not need test$/,
      ],
      [
        'a skipped `test` deploys without proof',
        edit(
          'deploy-staging',
          "(needs.test.result == 'skipped' && needs.gate.outputs.tested == 'true')",
          "needs.test.result == 'skipped'",
        ),
        /^deploy-staging: `if:` lacks \(needs\.test\.result/,
      ],
      [
        'the memo on PRs',
        edit('gate', "if: github.event_name == 'push'", 'if: always()'),
        /^gate: `if: always\(\)`/,
      ],
      // Review round 1 F7: each kept every wiring pin green, and the memo then answers "tested"
      // for a tree that never passed, so the suites and semgrep skip and deploy-staging ships it.
      [
        'the memo counting every run, not only green ones',
        edit('gate', '&status=success', ''),
        /^gate: the memo answers tested=true for a PR head whose runs all failed/,
      ],
      [
        'the memo accepting zero green runs',
        edit('gate', '-ge 1', '-ge 0'),
        /^gate: the memo answers tested=true for a PR head whose runs all failed/,
      ],
      [
        "the memo's default flipped",
        edit('gate', '          tested=false\n', '          tested=true\n'),
        /^gate: the memo answers tested=true for a direct push/,
      ],
      [
        "the memo's tree comparison dropped",
        edit('gate', `if [ "\${pr_tree:-}" = "$TREE" ]; then`, 'if true; then'),
        /^gate: the memo answers tested=true for main moved under the PR/,
      ],
      // Review round 1 F8: without it the jobs get the repository default, write on this repo.
      ['the read-only token dropped', without(TOKEN), /^workflow: `permissions:` is not read-only/],
      [
        'a write token on the suite job',
        edit('test-suite', IF, `${IF}    permissions: write-all\n`),
        /^test-suite: `permissions:` grants a write scope to a job that installs dependencies$/,
      ],
      [
        'a write token on the static gates',
        edit('test-gates', IF, `${IF}    permissions:\n      contents: write\n`),
        /^test-gates: `permissions:` grants a write scope to a job that installs dependencies$/,
      ],
      [
        'semgrep renamed',
        edit('semgrep', '    needs: [gate]\n', '    name: static analysis\n    needs: [gate]\n'),
        /^semgrep: `name:` renames/,
      ],
      [
        'another job reporting as `test`',
        edit('test-suite', '    needs: [gate]\n', '    name: test\n    needs: [gate]\n'),
        /^test-suite: `name: test` reports as a required check$/,
      ],
    ]) {
      const problems = allProblems(text, KIT);
      assert.ok(
        problems.some((problem) => refusal.test(problem)),
        `${label}: ${JSON.stringify(problems)}`,
      );
    }
  });

  it("passes a clone's own layout: another suite job, a longer timeout, a folded `if:`", () => {
    const folded = `    if: >-\n      \${{ !cancelled()\n          && needs.gate.outputs.tested != 'true' }}\n`;
    let text = edit('test-suite', `    if: ${MEMO_IF}\n`, folded);
    text = edit('test-suite', '    timeout-minutes: 30\n', '    timeout-minutes: 45\n', text);
    text = edit(
      'test',
      'needs: [gate, test-gates, test-suite]',
      'needs: [gate, test-gates, test-suite, e2e]',
      text,
    );
    text = edit(
      'test',
      `          SUITE_RESULT: \${{ needs.test-suite.result }}\n`,
      `          SUITE_RESULT: \${{ needs.test-suite.result }}\n          E2E_RESULT: \${{ needs.e2e.result }}\n`,
      text,
    );
    text = edit('test', ' ]; then\n', ' ] || [ "$E2E_RESULT" != "success" ]; then\n', text);
    text = addJob(E2E, text);
    assert.deepEqual(allProblems(text, KIT), []);
    // The same clone, its new suite job's result left unread: refused.
    assert.notDeepEqual(
      allProblems(text.replace(`          E2E_RESULT: \${{ needs.e2e.result }}\n`, ''), KIT),
      [],
    );
    // Review round 1 F3: its extra job allowed to fail, so `needs.e2e.result` reads success on a
    // red e2e and `test` passes.
    const soft = edit(
      'e2e',
      '    timeout-minutes: 15\n',
      '    timeout-minutes: 15\n    continue-on-error: true\n',
      text,
    );
    assert.ok(
      allProblems(soft, KIT).some((problem) =>
        /^e2e: job-level `continue-on-error:`/.test(problem),
      ),
      JSON.stringify(allProblems(soft, KIT)),
    );
  });

  // Review round 1 F2 and F5: each of these failed closed and was refused.
  it('passes a sharded clone: its own matrix id, a merge after the check, block-style needs', () => {
    // A clone without a plugin mirror, so it has no verify:plugin step (review round 2 R1).
    const clone = { ...KIT, pluginMirror: false };
    const text = sharded();
    assert.deepEqual(allProblems(text, clone), []);
    // The same layout in a repo that has a plugin mirror: its guard is gone, so refused.
    assert.ok(
      allProblems(text, KIT).some((problem) =>
        /^test-gates: `npm run verify:plugin` appears 0 times/.test(problem),
      ),
    );
    // The same clone, its shards' result left unread, or the merge put before the check: refused.
    assert.ok(
      allProblems(
        edit('test', 'needs.test-shard.result }}', 'needs.test-gates.result }}', text),
        clone,
      ).some((problem) => /^test: env reads \[test-gates,test-gates\]/.test(problem)),
    );
    const STEP = '      - name: Require the static gates and the full suite\n';
    const first = edit('test', STEP, `      - run: npm run test:coverage:merge\n${STEP}`, text);
    assert.ok(
      allProblems(first, clone).some((problem) => /^test: env reads \[\], not/.test(problem)),
    );
  });

  // Review round 2 R3: arena-go's verify:merge-settings reads settings GitHub shows only to a
  // token that can push. In a job of its own that installs nothing, the write scope runs no
  // dependency code; the same job with `npm ci` is refused.
  it('passes a write scope on a needed job that installs nothing, and refuses it with `npm ci`', () => {
    const SETTINGS = `  test-settings:
    needs: [gate]
    if: ${MEMO_IF}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - if: \${{ github.actor != 'dependabot[bot]' }}
        run: npm run verify:merge-settings -- --require
        env:
          GH_TOKEN: \${{ github.token }}
`;
    const SUITE = `          SUITE_RESULT: \${{ needs.test-suite.result }}\n`;
    let text = edit(
      'test',
      'needs: [gate, test-gates, test-suite]',
      'needs: [gate, test-gates, test-suite, test-settings]',
    );
    text = edit(
      'test',
      SUITE,
      `${SUITE}          SETTINGS_RESULT: \${{ needs.test-settings.result }}\n`,
      text,
    );
    text = edit('test', ' ]; then\n', ' ] || [ "$SETTINGS_RESULT" != "success" ]; then\n', text);
    text = addJob(SETTINGS, text);
    assert.deepEqual(allProblems(text, KIT), []);
    const installs = edit(
      'test-settings',
      '          persist-credentials: false\n',
      '          persist-credentials: false\n      - run: npm ci\n',
      text,
    );
    assert.ok(
      allProblems(installs, KIT).some((problem) =>
        /^test-settings: `permissions:` grants a write scope to a job that installs dependencies$/.test(
          problem,
        ),
      ),
      JSON.stringify(allProblems(installs, KIT)),
    );
  });

  // Review round 2 R2: a memo the stand-in `gh` cannot drive answers tested=false for every
  // case, the proven tree included. That only costs CI time, so a fork's memo passes when it
  // never answers tested=true for a tree that did not pass. The kit's memo is the one the
  // stand-in is written for: it must give every verdict, or the cases above check nothing.
  it("passes a fork's memo that fails closed under the stand-in; the kit's must answer every case", () => {
    for (const [label, text] of [
      [
        "the tree read with git, as Arena-2's memo does",
        edit(
          'gate',
          `if [ "\${pr_tree:-}" = "$TREE" ]; then`,
          `if [ "\${pr_tree:-}" = "$(git rev-parse 'HEAD^{tree}')" ]; then`,
        ),
      ],
      [
        "runs listed with `gh api -X GET … -f`, as arena-go's memo does",
        edit(
          'gate',
          `gh api "repos/\${GITHUB_REPOSITORY}/actions/runs?head_sha=\${pr_head}&status=success&per_page=100"`,
          `gh api -X GET "repos/\${GITHUB_REPOSITORY}/actions/runs" -f head_sha="\${pr_head}" -f status=success -f per_page=100`,
        ),
      ],
    ]) {
      assert.deepEqual(memoProblems(text, FORK), [], label);
      assert.ok(
        memoProblems(text, KIT).some((problem) =>
          /^gate: the memo answers tested=false for a tree that passed on its merged PR, not true$/.test(
            problem,
          ),
        ),
        `${label}: ${JSON.stringify(memoProblems(text, KIT))}`,
      );
    }
    // A fork's memo that answers "tested" for a tree that never passed is still refused.
    assert.ok(
      memoProblems(edit('gate', '          tested=false\n', '          tested=true\n'), FORK).some(
        (problem) => /^gate: the memo answers tested=true for a direct push/.test(problem),
      ),
    );
  });

  // #257 split, PR 3: the observer is evidence. Each edit below either lets it gate a merge or a
  // deploy, or loses the evidence silently.
  it('refuses the plausible edits that let the observer gate anything or lose its evidence', () => {
    const NEEDS = '    needs: [test, semgrep, actionlint, secrets-scan]\n';
    const OBSERVE = '        run: node scripts/test-performance.mjs ci\n';
    const CHECK = '      - run: node scripts/test-performance.mjs check\n';
    for (const [label, text, refusal] of [
      [
        'deploy-staging waits for the observer',
        edit(
          'deploy-staging',
          'needs: [gate, test, semgrep, actionlint, secrets-scan, deployment-target]',
          'needs: [gate, test, semgrep, actionlint, secrets-scan, deployment-target, test-performance]',
        ),
        /^deploy-staging: needs test-performance, so an observation can hold/,
      ],
      [
        'the observer on pushes too',
        edit(
          'test-performance',
          "!cancelled() && github.event_name == 'pull_request'\n",
          '!cancelled()\n',
        ),
        /^test-performance: `if:` lacks `github\.event_name == 'pull_request'`$/,
      ],
      [
        '`!cancelled()` dropped from the observer',
        edit('test-performance', `\${{ !cancelled() && github`, `\${{ github`),
        /^test-performance: `if:` lacks `!cancelled\(\)`$/,
      ],
      [
        'the observer started before semgrep',
        edit('test-performance', NEEDS, '    needs: [test, actionlint, secrets-scan]\n'),
        /^test-performance: does not need semgrep/,
      ],
      [
        "a gate's result not read",
        edit('test-performance', " && needs.semgrep.result == 'success'", ''),
        /^test-performance: `if:` lacks needs\.semgrep\.result == 'success'$/,
      ],
      [
        'a write scope on the observer',
        edit(
          'test-performance',
          '      actions: read\n',
          '      actions: read\n      pull-requests: write\n',
        ),
        /^test-performance: `permissions:` is not read-only/,
      ],
      [
        'the observer without its actions scope',
        edit('test-performance', '      actions: read\n', ''),
        /^test-performance: `permissions:` is not read-only with `actions: read`$/,
      ],
      [
        'the cap dropped',
        edit('test-performance', '    timeout-minutes: 5\n', ''),
        /^test-performance: no `timeout-minutes:` of at most 5$/,
      ],
      [
        'the cap raised',
        edit('test-performance', '    timeout-minutes: 5\n', '    timeout-minutes: 30\n'),
        /^test-performance: no `timeout-minutes:` of at most 5$/,
      ],
      [
        'the observer through an npm script',
        edit('test-performance', OBSERVE, '        run: npm run test:performance\n'),
        /^test-performance: `npm run test:performance` needs an npm script a fork does not carry/,
      ],
      [
        'the observer lost',
        edit('test-performance', OBSERVE, '        run: npm run test:performance\n'),
        /^no job runs the observer/,
      ],
      [
        'the budget check through an npm script',
        edit('test-gates', CHECK, '      - run: npm run verify:test-performance\n'),
        /^test-gates: `npm run verify:test-performance` needs an npm script a fork does not carry/,
      ],
      [
        'the budget check softened with `|| true`',
        edit('test-gates', CHECK, '      - run: node scripts/test-performance.mjs check || true\n'),
        /^test-gates: `node scripts\/test-performance\.mjs check` appears 0 times/,
      ],
      // #287 review F6: the observer runs the PR's code with a token that reads every run's logs
      // and artifacts, so it installs nothing and its checkout keeps no token.
      [
        "test-gates' install copied into the observer",
        edit(
          'test-performance',
          '      - name: Observe complete CI latency',
          '      - run: npm ci\n      - name: Observe complete CI latency',
        ),
        /^test-performance: installs dependencies beside its `actions: read` token$/,
      ],
      [
        "the observer's checkout keeps its token",
        edit('test-performance', '        with:\n          persist-credentials: false\n', ''),
        /^test-performance: checks out without `persist-credentials: false`/,
      ],
      // #287 review F3: main's tree memo counts only a PR run that concluded success.
      [
        "the observer's job-level continue-on-error dropped",
        edit(
          'test-performance',
          '    timeout-minutes: 5\n    continue-on-error: true\n',
          '    timeout-minutes: 5\n',
        ),
        /^test-performance: no job-level `continue-on-error: true`/,
      ],
      [
        "the observer's upload made fail-closed",
        edit('test-performance', '        continue-on-error: true\n', ''),
        /^test-performance: the upload does not continue on error/,
      ],
      // #287 review F8: the timing upload's 14 days, copied over.
      [
        'the observation kept for two weeks',
        edit('test-performance', 'retention-days: 90', 'retention-days: 14'),
        /^test-performance: keeps its observation for 14 days, under 90/,
      ],
      [
        'the artifact renamed without the fingerprint',
        edit(
          'test-performance',
          `-\${{ github.run_attempt }}-\${{ steps.observe.outputs.config }}`,
          `-\${{ github.run_attempt }}`,
        ),
        /^test-performance: the upload is not named/,
      ],
    ]) {
      const problems = allProblems(text, KIT);
      assert.ok(
        problems.some((problem) => refusal.test(problem)),
        `${label}: ${JSON.stringify(problems)}`,
      );
    }
  });

  it("passes a fork's own observer layout, and a fork without one", () => {
    let text = edit(
      'test-performance',
      '    needs: [test, semgrep, actionlint, secrets-scan]\n',
      '    needs:\n      - test\n      - semgrep\n      - actionlint\n      - secrets-scan\n',
    );
    text = edit('test-performance', '    timeout-minutes: 5\n', '    timeout-minutes: 3\n', text);
    text = edit(
      'test-performance',
      '      actions: read\n',
      '      actions: read\n      pull-requests: read\n',
      text,
    );
    text = edit('test-performance', '  test-performance:\n', '  perf-observer:\n', text);
    assert.deepEqual(allProblems(text, KIT), []);
    // The observer removed: a fork may go without it; the kit may not.
    const start = CI.indexOf('\n  test-performance:\n');
    const end = CI.indexOf('\n  actionlint:\n');
    assert.ok(start > 0 && end > start);
    const without = CI.slice(0, start) + CI.slice(end);
    assert.deepEqual(observerProblems(without, FORK), []);
    assert.deepEqual(observerProblems(without, KIT), [
      'no job runs the observer (`node scripts/test-performance.mjs ci`)',
    ]);
  });

  // Review round 1 F6: the graduated gate the verify:needs comment points to was refused.
  it('passes the stricter forms of a static gate and the install', () => {
    for (const [from, to] of [
      ['      - run: npm run verify:needs\n', '      - run: npm run verify:needs -- --gate\n'],
      ['      - run: npm run verify:needs\n', '      - run: npm run verify:needs -- --gate=80\n'],
      ['      - run: npm ci\n', '      - run: npm ci --no-audit\n'],
    ])
      assert.deepEqual(allProblems(edit('test-gates', from, to), KIT), [], to.trim());
  });
});
