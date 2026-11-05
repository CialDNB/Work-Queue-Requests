# Testing and feedback as an app grows

Keep the full release contract while making the development loop short. A mature clone's
slow suite is a reason to measure setup, imports, fixtures and execution separately, then
change the expensive layer. Test count and line coverage alone do not measure confidence.

## The development loop

1. Run the changed behavior's files, or use watch mode while editing:
   `npm test -- test/routes/notes.test.ts` or `npm run test:watch -- test/routes/notes.test.ts`.
   These are focused checks, not a full-suite certificate. For permission/auth/route changes,
   include the affected permission matrix and isolation tripwires; for shared fixtures or
   runtime/config changes, expand to every suite that depends on them.
2. Run typecheck and lint before calling the change ready. Finish edits, including guidance,
   generated mirrors and stamps, then run `npm run ci` once on that final tree. It includes
   the full suite with coverage and the local guards. `verify:deps` contacts the npm registry;
   the tests themselves remain offline.
3. Record the command, result, revision and any uncommitted/untracked changes included in
   verification. If `/add-endpoint` just ran full CI and `/ship` starts without any input
   changing, that evidence counts. A new skill name is not a new test input. A source/test/
   config/dependency/environment change, a rebase or uncertain evidence requires a new final
   run. This is session-level evidence reuse, not a persistent cache or a CI bypass.
4. Every PR still runs every mandatory gate, including the permission matrix, cross-route
   uniformity tripwires and coverage floors. The existing exact-tree memo can reuse PR evidence
   after a squash merge. Production keeps its separate manual sign-off and verification.

Avoid overlapping full suites on the same machine when measuring them. Separate worktrees
prevent file conflicts, but still share CPUs and memory. Record concurrent work rather than
mistaking contention for a code regression. Never stop somebody else's process to benchmark.

## Put tests at the cheapest faithful layer

| Contract | Appropriate layer | What must remain real |
| --- | --- | --- |
| Parsing, formatting, deterministic policy/calculation | Node unit project | Inputs, outputs and edge cases |
| D1 queries, migrations, KV/R2, Workers APIs | Minimal or full Workers project | Binding/storage behavior and isolation |
| Route auth, permissions, CSRF, audit, uniform errors | Full Workers and generated tripwires | Framework and principal/data seams |
| Critical user journeys and rendering | Browser checks | Browser behavior at the relevant boundary |

The kit's TypeScript suite runs in three disjoint Vitest projects (`vitest.config.ts`), with one
combined coverage map and the same floors; its plain-JS scripts and hooks run under `node --test`:

- `node`: the files `nodeTestFiles` lists in `test/projects.mjs`, pure calculations, in plain
  Node. `test/setup/node-no-network.ts` makes an unstubbed `fetch` reject and the `WebSocket`
  constructor throw before every test, so a portable test injects its fetcher;
  `test/setup/node-no-network.test.ts` exercises it. It does not reach a package that opens its
  own sockets (`undici`, `ws`, a database client): a test that needs one stays in Workers.
- `workers-minimal`: the files `minimalWorkersTestFiles` lists, binding-level tests, in a real
  Workers runtime with the full test config's bindings, vars and compatibility settings, apart
  from its Workflows (`test/runtime/wrangler.test-minimal.jsonc`), and an entrypoint that refuses
  every HTTP request. A Durable Object binding stays in it: the runtime starts, and a test that
  uses a class only `src/index.ts` exports fails with "does not export a … Durable Object", so
  such a suite stays in full Workers. The config sits under `test/runtime/`, not the repo root,
  because `verify:edge` reads every root wrangler config as one that deploys.
- `workers`: every other file, and every new one: the full application.

The manifests are reviewed, exact opt-ins, and code-owned. `test/platform/test-projects.test.mjs`
keeps the auth, framework, route, cron, security and isolation suites, and the audit and read-log
storage suites (PIA C15), out of both lists. It runs `scripts/test-runtime-boundary.mjs` over
every listed file and each file it imports: a minimal Workers test may not reach the
application's entrypoint, routes or HTTP fixture, `SELF` or a Workflow, and a Node test may not
import a Workers binding or global, a Wrangler Text module (`.md`, `.sql`) or a network module.
Neither may use an `import.meta.glob` that loads modules; one that reads files as text
(`query: '?raw'`) passes.
These checks catch an accidental move; they do not prove a file portable, and the review of
`test/projects.mjs` is the control. A move also needs the same test names and a green combined
coverage run before and after it. Node's Intl and WebCrypto and Workers' native APIs can differ,
so keep locale-sensitive tests in Workers: a pass in Node does not show that workerd behaves the
same. In an app with the split, `npm run test:node`, `test:workers:minimal` and `test:workers`
run one project while developing, and `npm run test:watch` restarts when `test/projects.mjs`
changes, as it does for `vitest.config.ts`.

An app without `test/projects.mjs` runs the single full-Workers project the config falls back
to, with the same coverage map, so `/kit-upgrade` can carry `vitest.config.ts` to an app that has
not adopted the split. The split is adopted on its own (`/kit-upgrade`, "When adopting the
split"). First isolate a pure module and its tests; do not replace storage/auth contracts with
mocks merely to move it. Shared setup should seed only what a test needs. Optimize schema
parsing/batching only with equivalent constraints, triggers, isolation and negative cases proven
intact.

The fixture helper (`test/helpers/db.ts`) sends each reset phase as one ordered D1 batch: the
shape restore, the schema baseline, the WORM table drops and the row deletes. The baseline still
runs on EVERY call; migrations apply once per database with database-backed bookkeeping, and the
migrated shape still restores dropped objects and respects renamed or removed ones. Keep
child-before-parent deletes, WORM drop-and-recreate, the KV prefixes, synthetic users and per-file
isolation, and never replace them with a module-level "initialized" flag or shared state.

For each new or changed test, review the failure it would detect and the source of its
expected result. Copying the implementation's calculation into the assertion proves little.
A bug fix should demonstrate the regression test failing without the fix. An independent
permission matrix or published specification can provide a stronger oracle. Keep all relevant
negative/security cases. Consolidate duplicates only after showing which retained case kills
the same defect; prefer a named table of meaningful boundaries over dozens of copied cases.
Property tests or targeted mutation checks can expose missing cases, but measure their cost
and scope them to the relevant pure logic/security contract. A slow exhaustive or mutation
job can supplement PR CI; it does not replace an existing required PR test.

## Read the timing evidence

CI adds Vitest's JSON reporter to the existing full coverage command. Reporters named on the
command line replace the ones Vitest would pick itself, so the step also names those two:
`--reporter=default --reporter=github-actions --reporter=json`. The normal console report, the
PR annotations and the coverage thresholds still run. `scripts/test-profile.mjs` writes
`.test-results/test-profile.json` and a GitHub job summary, then deletes Vitest's raw report
(`vitest.json`: titles, failure stacks, absolute paths, the coverage map). CI keeps only the
normalized JSON, as a 14-day artifact. It contains:

- A versioned schema, sorted repository-relative file paths, per-file durations and counts.
- Wall elapsed time around the coverage step, plus the actual GitHub step outcome. Passing
  tests can coexist with a failing coverage floor; the step outcome is authoritative.
- Node/OS/architecture, CPU models, logical and available CPU counts, RAM, runner image,
  revision, run/attempt and job identifiers. It never dumps environment variables, local
  account paths, assertion titles, failure messages or the raw coverage map.

A crash or absent/stale JSON report produces `reportStatus: unavailable`, not invented green
results. Cancelled jobs may have no artifact. Neither the artifact nor its reported test
success decides whether anything can merge: an artifact-service failure shows on the upload
step without failing the job. GitHub's original coverage step retains its exit status, and
all existing gates and deploy dependencies remain required.

File/test durations can overlap; do not sum them and call the sum wall time. The wall interval
includes npm/runtime startup, imports, coverage/reporting and the short step handoff. Use the
Vitest console's transform/import/test breakdown and GitHub's separate install/build/guard
step timings when locating the cost. Compare like-for-like revisions, dependency versions,
CPU availability, runner images, shard counts, cold/warm state and concurrent workload.

For local full coverage, `npm run test:profile` records context, runs the existing coverage
command, writes the normalized profile and propagates the coverage command's exit status.
Local `npm run ci` uses this wrapper, so the suite runs once. It runs `test:coverage`, or the
script it names (`node scripts/test-profile.mjs run coverage`). Its console reporter is the
one Vitest would pick: the quiet `agent` reporter (failed tests and the totals) under a coding
agent on Vitest 4.1 or later, `default` otherwise. To collect the evidence by hand, run these
commands separately so a failing test command is not hidden by the summarizer's exit code:

```sh
node scripts/test-profile.mjs start
npm run test:coverage -- --reporter=default --reporter=json --outputFile.json=.test-results/vitest.json
node scripts/test-profile.mjs summarize
```

Record the coverage command's exit status. The local summary intentionally does not infer it
from the JSON reporter. Generated reports are ignored by Git, and the tree scans that run
after the suite (`verify:bootstrap`'s residual-identifier scan, source hygiene) skip
`.test-results/`.

Start with reporting, not a noisy elapsed-time hard gate. For a clone, record a desired local
feedback and PR critical-path budget in its decisions and in its budget file (below), then
compare several runs. A useful starting target is focused feedback within a minute and full PR
feedback within ten minutes; these are investigation triggers, not permission to drop tests or
a universal runner SLA. Look at median and tail times, the longest file and total
runner-minutes. A 20-minute local loop can be multiple full runs or CPU contention even when
one CI run is much shorter.

## App-owned budgets and the CI observer

`test-performance-budget.json` holds an app's limits and the CI layout they apply to. It belongs
to the app: `/kit-upgrade` never carries it, and a clone keeps its own job names, shard count and
limits, never the kit's. The kit's defaults are set for its one-runner suite: focused feedback
within 60 seconds (a target for the local loop; nothing measures it automatically), the complete
gate within 600 seconds (the ten-minute full-PR-feedback starting target above) and 15 gate
runner-minutes. The kit's own complete gate took 190–303 s on recent runs, mostly 283–303 s
(416–438 s on the #287 and #288 runs, before the ordered fixture batches), inside that limit. A
PR's observer warns of the gate only when the median of three comparable runs passes the limit. The
single-gate rule (one gate over the limit) applies only to the `/kit-upgrade` status line below.
Until 2026-10-25 the kit's limit was 300 s. That sat right at its measured gate, and it is the file
a clone starts from (DECISIONS 2026-10-25, fullGateSeconds). A clone measures its own instead of
copying these:
one that shards picks the smallest measured capacity that meets its target, sets its own cost
cap and records the trade-off in DECISIONS.
Runner-minutes count how long runners were busy, not billed money: GitHub rounds each job up to
a whole minute, and the observer's own job is not counted.

`ci.yml` calls the script with `node`, since `package.json` does not ride `/kit-upgrade`:

- `node scripts/test-performance.mjs check` (`npm run verify:test-performance`) runs in
  `test-gates` and in local `npm run ci`. It is offline and a hard gate. It fails an invalid
  limit, a repeated job name, a suite prefix that would also count a required job, a comparison
  file that does not exist, and a layout the workflow does not show: each required job exactly
  once, a suite job under the prefix, and `expectedSuiteJobs` suite jobs. It reads the workflow
  as text, not as YAML: each job's id under `jobs:`, its job-level `name:` and its `strategy:`. A
  suite job with no `strategy:` counts 1, and one whose matrix is a single list of values
  (`shard: [1, 2, 3, 4]`) one per value. So a renamed or display-named job, or a suite sharded in
  place or re-sharded, that the budget did not follow fails here, not as an observer that is
  always "unavailable". A matrix whose size the text does not show (`include` or `exclude`, an
  expression such as a planned `fromJSON(...)`, several axes, a block list) is not counted: there
  a wrong `expectedSuiteJobs` shows only as "unavailable" observations. An app with no budget file
  has not adopted one: it prints a notice and passes.
- `node scripts/test-performance.mjs ci` (`npm run test:performance`) is the `test-performance`
  job. It runs on PRs only, after `test`, semgrep, actionlint and secrets-scan all succeeded,
  with a token that reads job timings and repository contents and nothing else, under a
  5-minute cap. It installs nothing. It is not a required check and nothing needs it, so it can
  never fail one or hold a deploy. The job and its upload continue on error, so a red
  observation leaves the run green. One cost remains: main's tree memo counts a PR head as tested
  only once that PR's whole run has finished green. A merge made while the observer is still
  running (it takes seconds) therefore re-runs the full gate on main before the deploy. It
  writes `.test-results/test-performance.json` and a job summary, and keeps the file as a 90-day
  artifact (or for the repository's maximum retention, if that is lower). An API it cannot read,
  a budget it cannot read, or incomplete evidence is reported as "unavailable", and nothing is
  inferred from it.

**What it measures**, from the jobs of this exact run attempt (paginated, so a matrix is whole):
the complete gate, from the first required job's start to the last one's end, including
installs, shutdown, coverage and the waits between jobs; the initial queue, from this attempt's
start, separately; gate runner-minutes over every required and suite job, and suite
runner-minutes over the suite jobs alone; and the longest suite job against the median. Deploy
and observer jobs are left out. A failed, skipped, missing, duplicated or wrong-run job is
refused as evidence, and so is a suite-job count other than `expectedSuiteJobs`. So is a partial
re-run ("Re-run failed jobs"): it lists the jobs it carried over under the new attempt, with
their first attempt's times, so it has no complete gate of its own. Its observation is
"unavailable", and later runs leave it out of their history. A full re-run ("Re-run all jobs")
is measured from its own start.

**What it compares.** Each run fingerprints the budget's `comparisonFiles` in the merge commit
it executed (`GITHUB_SHA`), not in the PR head, which can hold an older workflow, lockfile or
config than the one that ran. It puts that fingerprint in its artifact's name
(`test-performance-<run id>-<attempt>-<fingerprint>`). A later run compares itself only with the
last `historyLimit` (default 12) successful same-repository PR runs of the workflow that
published the same fingerprint, on the same job names and runner labels; a run that published
none is left out. History reaches back only as far as those artifacts are kept (90 days, or the
repository's maximum retention if lower), so a run whose artifact expired is left out too, and
an app with few PRs takes longer to collect the six comparable runs a relative trend needs.
List every config, setup or coverage file that changes how the suite runs, so
that changing one starts a new history. Application source is left out on purpose, so gradual
suite growth shows as a trend. These trends are matched on configuration, not benchmarks: the
runner image, CPU load and cache state still vary, so claim a speedup only from matched runs of
the same source.

**What it warns about.** By default it compares the median of the last three comparable runs,
this one included, with the budget, and with the median of the three before them for a rise of
more than 20% in latency or runner-minutes. A longest/median suite-job ratio above 1.5 warns of
imbalance. The first three observations warm up, and the relative trend needs six. Three samples
are not a p95. A warning is a prompt to investigate (open an issue, read the timing profiles,
measure the slow layer), never a reason to raise a limit quietly or drop a test. At the app's
next `/kit-upgrade`, it also triggers the audit below.

**Adopting it in a clone:** copy the kit's file once, then set `requiredJobs` to the clone's own
required jobs, `suiteJobPrefix` to its suite or shard job, `expectedSuiteJobs` to its shard
count, its own limits, and its own runtime and setup files in `comparisonFiles`. Each name is
the job's name as Actions shows it: its `name:`, or its id when it has none. For a shard job,
leave out the shard. Actions lists an id-named matrix job `test-shard` as `test-shard (1)`, so
its prefix is `test-shard`. It lists insights' `name: Workers suite shard ${{ matrix.shard }}/4`
as `Workers suite shard 1/4`, so its prefix is `Workers suite shard`. Then run:

```sh
npm run verify:test-performance   # valid limits, existing files, the workflow's job names and shards
npm run test:profile              # the local full run, with the timing profile
```

`npm run test:performance` needs a PR run's environment (the run id, attempt, `GITHUB_SHA` and a
token); run locally, it reports "unavailable".

## The upgrade audit, when the observer warns

`/kit-upgrade` does not audit the suite on every upgrade (DECISIONS 2026-10-22, option B). Every
upgrade records one line: the observer's latest status for the app, and whether it triggered the
audit. Read it before the upgrade adopts anything, since the upgrade changes the comparison files
and the observer's history starts again. Take the latest green PR run with an available
observation: the newest of the last ten whose observer artifact name ends in a 64-hex
configuration fingerprint. Skip an `-unavailable` artifact: after "Re-run failed jobs", for one,
the green attempt's observer refuses the jobs it carried over from the failed attempt. When none
of the ten has one, take the newest; its line says why.

```sh
pick= newest=
for run in $(gh run list --workflow ci.yml --event pull_request --status success --limit 10 \
    --json databaseId,attempt --jq '.[] | "\(.databaseId)-\(.attempt)"'); do
  newest=${newest:-$run}
  gh api "repos/{owner}/{repo}/actions/runs/${run%-*}/artifacts?per_page=100" --jq '.artifacts[].name' \
    | grep -Eq "^test-performance-$run-[0-9a-f]{64}\$" && { pick=$run; break; }
done
run=${pick:-$newest}
gh run download "${run%-*}" --pattern "test-performance-$run-*" --dir .test-results/observer
report=$(find .test-results/observer -path "*/test-performance-$run-*/test-performance.json" 2>/dev/null | head -n 1)
report=${report:-.test-results/observer/test-performance-$run/test-performance.json}
echo "Observer report: $report"
npm run test:audit -- "$report"
```

The report's path is found without a shell glob, so zsh prints a line too when the run has no
artifact left to download (an expired one, say). On the upgrade that brings the `audit` mode, the
clone's script does not have it yet (it prints `Usage: node scripts/test-performance.mjs check|ci`
and exits 2) and `package.json` has no `test:audit`. Run the commands first all the same, and keep
the path printed after `Observer report:`. Shell variables do not survive into a later shell, so
once `/kit-upgrade` step 3 has carried the kit's script, run
`node scripts/test-performance.mjs audit <path>` with that path written out: the report is still
the pre-upgrade run's, so its line holds. The script refuses an empty or unexpanded path, and
prints no line for it.

- **warning**, and the audit is required: the observer warned of a sustained budget overrun (the
  median of the last `windowSize` comparable runs, three by default, over a limit) or a sustained
  regression in latency or runner-minutes above `regressionPercent` (20% in the kit's budget), or
  the latest complete gate alone took longer than `fullGateSeconds`.
- **clear**, and the audit is optional: none of those.
- **unavailable**, optional, and nothing is inferred: no budget
  (`Test performance: unavailable (no test-performance budget adopted). Audit not triggered.`),
  or no available observation in the last ten green PR runs. A partial re-run is unavailable by
  design; if recent runs stay unavailable for another reason, open an issue for that reason.

The audit is [the template](test-performance/AUDIT-TEMPLATE.md), completed as
`docs/test-performance/<date>-<upgrade>.md`. The command above only prints the line, since a
timing profile an earlier `npm run ci` left describes the tree before the upgrade. Once
`npm run ci` has profiled the final tree, `npm run test:audit -- <path> --draft`, on the path
printed after `Observer report:`, drafts
`.test-results/test-audit.md` with the 20 slowest files and the runtime each runs in, from
`test/projects.mjs`. Without that file, each reads "unlisted (runtime per vitest.config.ts)",
since a clone may define DOM projects there. `--draft` refuses a profile no newer than the
observer run, never overwrites a draft, and drafts an optional audit too. Nothing in the audit
moves or deletes a test. The audit covers the 20 slowest files and every
full Workers test added since the last audit; imports, setup, fixtures and waits; runtime
placement and shard balance; and test intent. It ends in an evidence-backed change or an
evidenced no-change decision. A claimed speedup needs three matched CI runs per variant. The
per-PR review of what each changed test detects stays in `/ship`.

**Change the measured bottleneck:**

- Imports or setup: import the module itself, not the application or a barrel. Move a test to a
  cheaper runtime only after checking its transitive imports, its behavior and the coverage.
- Fixtures: seed only what the contract needs. Keep per-file isolation, per-test resets,
  migration and shape recovery, and WORM semantics.
- Waits: await an explicit completion or condition, and bound any polling. Fake timers fit only
  a clock the test controls; they do not expire Workers KV, R2 or cache entries. Never trade an
  eventual-consistency check for a shorter sleep.
- One long file: split it into independent groups, each with its own complete setup. Sharding
  cannot divide a file, and hundreds of tiny files add startup cost, so measure the trade.
- Capacity: compare measured shard counts and balance each runtime's imports across shards,
  keeping the exact-once, report-identity and combined-coverage checks ("Clone adoption", step 4).

**Clean up what tests check, with evidence.** A similar-looking test is a candidate, not proof
of redundancy. For each candidate, record the failure it detects, its independent expected
result, and the retained case that catches the same defect, shown with the bug restored or a
targeted mutation. Keep distinct auth, permission, uniformity, isolation, migration and negative
cases. A removal is its own reviewable PR with an old-to-retained map. A no-change decision names
what was inspected and why it stays.

## What the wiring tests catch

`test/platform/test-profile.test.mjs` pins the timing wiring in `ci.yml` and `package.json`.
Those checks are drift tripwires. They catch an accidental or well-meant edit that silently
breaks the evidence or softens the coverage gate:

- a dropped reporter, JSON report path or `TEST_STEP_OUTCOME`, or a renamed step id;
- `|| true`, `; exit 0` or a pipe after the coverage command or inside the npm script it runs,
  and anything but `&&` joining the local `ci` chain (including a second line or a trailing `&`);
- `continue-on-error:` or `if:` on the coverage step, or `continue-on-error:` on its job;
- coverage turned off, a floor overridden, or coverage narrowed (`--coverage.include`,
  `--coverage.exclude`);
- a test filter left in: a file path, `-t`/`--testNamePattern`, `--exclude`, `--dir`,
  `--project`, `--changed`, `--related` or `--tagsFilter`;
- a flag that reports a red or empty run green (`--passWithNoTests`, `--allowOnly`, `--retry`,
  `-u`, `--dangerouslyIgnoreUnhandledErrors`), or exits green without running a test
  (`--clearCache`, `--listTags`);
- the wrong script (one without coverage, or watch mode), or a second suite run.

`test/platform/ci-parallel-runtime.test.mjs` does the same for the required `test` check, which
passes only when every job it needs succeeds: `test-gates` and each job that runs the profiled
suite (found by what it runs, so a clone's shard matrix passes under its own id). It catches
`!cancelled()` dropped from that job's `if:` or a result term added to it, a result read from
the wrong job, `continue-on-error:` on a job `test` needs or on a gate step, `if:` added to a
gate, a gate step or timeout lost (`verify:plugin` wherever a plugin mirror exists), a renamed
required check, a workflow that lost its read-only `permissions:`, and a write scope on a job
that installs dependencies. It also runs the tree memo's script against a stand-in `gh` (with
`jq`) and fails if the memo answers "tested" for a direct push, a tree other than the merged
PR's, a PR head with no green same-repo run of this workflow, or an API error. In the kit the
memo must also answer "tested" for the tree that passed, which shows the stand-in drives it; a
fork's memo that the stand-in cannot drive answers "not tested", which only costs CI time, and
passes. It pins the `test-performance` observer as evidence that gates nothing: PRs only,
after every required check, a read-only token that can read job timings, a cap of at most 5
minutes, no job that needs it, `continue-on-error: true` on the job and on its upload, no
install and a checkout without persisted credentials, an artifact kept at least 90 days under
the name later runs read, and `node` (never an npm script a fork lacks) for the observer and for
the budget check in `test-gates`. A fork may drop the observer; the kit may not. The pin's
self-tests edit the kit's `ci.yml`, so they run only in the kit.
`test/platform/test-performance.test.mjs` runs its job-layout cases on a budget of its own, so a
clone's budget fails only if it is invalid or names jobs its workflow does not show. In the kit,
it also requires the kit's budget to exist, with the job layout those cases model.

`test/platform/test-projects.test.mjs` and `test-runtime-boundary.test.mjs` do the same for the
runtime split. They catch a stale or repeated manifest entry, a protected suite listed for Node or
minimal Workers, a listed file whose imports reach what its runtime lacks, a `vitest.config.ts`
that stopped reading the manifests, lost its single-project fallback or stopped reloading them in
watch mode, and a minimal config that drifted from `wrangler.test.jsonc`. Each guard case names
the exact violation it expects, so one rule that fires cannot hide another that stopped working.
The config shape is pinned in the kit only; a clone that adopts the split builds its own
`vitest.config.ts`.

They are not a security boundary. A PR that edits `ci.yml`, `package.json` or
`test/projects.mjs` can edit the test in the same PR, and a crafted edit can get past any text
check. The owner's review of the PR is
the control for a deliberate softening: the ruleset requires a PR to reach `main`, and a
reviewer reads a change to the coverage step, or to this test, as a change to the gate. So the
checks are a short blocklist of plausible edits. They are not a parser or an allowlist that
tries to prove nothing can soften the step. A fork's own runner flags (`--pool`,
`--maxWorkers`, `--bail`, timeouts, `--silent`), shards, another config, extra coverage
reporters and its script names all pass.

## Clone adoption and scaling

Adopt measurement first, then benchmark one change at a time:

1. `/kit-upgrade`'s diff set carries `scripts/test-profile.mjs`, its
   `scripts/kit-checks/main-module.mjs` dependency and this guide. Adopt by hand what it does
   not carry: `test/platform/test-profile.test.mjs` and the `.test-results/` ignore entry.
   If the clone already has its own `docs/TESTING.md`, merge this guide into it hunk by hunk
   and keep the clone's sections; `/kit-upgrade`'s diff set carries it from then on. Adopt the
   start/report/upload steps around the clone's existing coverage command, adding all three
   reporters (`--reporter=default --reporter=github-actions --reporter=json`) and the
   `--outputFile.json=.test-results/vitest.json` path. CI needs no new package dependency or
   script. Local `npm run ci` needs the `test:profile` script in place of the coverage script
   in its `ci` chain (`node scripts/test-profile.mjs run <script>` when that script is not
   `test:coverage`); `package.json` does not ride `/kit-upgrade`, so add both by hand. On a
   shard matrix, give artifacts a shard-unique name. Keep the existing coverage command's
   config, file selection, shard arguments and exit status; never replace the fork's command
   wholesale with the template's. The carried test is a drift tripwire (see "What the wiring
   tests catch" above). It refuses the plausible softening edits listed there. It accepts the
   clone's own command shape (an npm script, or `npx vitest run`), its runner flags, shards,
   config and script names.
2. Reconcile the authoring/ship skills, `CLAUDE.md`, Cursor and Playbooks mirrors (the diff set
   carries them); re-stamp with `npm run verify:agents -- --write`. The kit also syncs/stamps its
   plugin; forks without a plugin mirror do not acquire the kit's `plugins/` directory.
   `/kit-upgrade` never carries `package.json`, `package-lock.json`, `.gitignore`, a wrangler
   config, `test-performance-budget.json` or `test/platform/` beyond the four files it names:
   adopt those by hand (`/kit-upgrade`, "Test timing and performance tooling"), and the runtime
   split's files, dependency and scripts when you adopt it (`/kit-upgrade`, "When adopting the
   split").
3. Adopt the runtime split with the clone's own reviewed manifests and minimal config, leaving
   Workers-sensitive contracts in full Workers. Prove the before/after discovered test
   inventory, outcomes and security coverage match. Preserve one combined coverage report
   with the same source inclusion and global/per-directory floors. Do not assume Vitest's
   `--related` graph sees SQL, raw imports, generated registries or configuration; focused
   selection stays a development aid until such dependencies are accounted for.
4. After reducing repeated startup and fixture cost, use measured file sharding on standard
   runners. Compare 1/2/4/8 shards including install/startup/merge overhead and runner-minutes;
   a single long file limits the benefit. Upload all shard reports, fail if any expected shard
   or report is absent, merge coverage and enforce the unchanged thresholds once. Never average
   coverage percentages or apply a full-project floor independently to incomplete shard
   coverage. Count files per runtime on every shard: equal total counts can hide three times as
   many full Workers imports on one runner. Use measured durations inside balanced runtime
   counts. Bind timing hints to test-source/dependency hashes and record runtime/coverage
   versions; unknown or edited files retain fallback costs and still run exactly once. Verify
   discovery-order invariance, stale-data behavior and assignment completeness at every
   supported capacity.
5. Tie every shard report to its source SHA, run id, attempt, shard index/count and successful
   test outcome. Reject missing, duplicate, unexpected, stale, malformed, failed, skipped or
   cancelled reports before merging. Do not reuse another attempt's artifact on a partial
   rerun. Run the full workflow again. Insights' `scripts/check-vitest-blobs.mjs` and its
   identity tests are an adoption reference; reconcile the clone's coverage engine format.
6. Preserve the required final aggregate gate (the kit's `test` job) and its result check. List
   every shard job, the merge job if there is one, and every static gate job (`test-gates`) in
   its `needs:` and its check, and keep the deployment's dependency on it. The shard matrix replaces `test-suite`;
   never run both. The shard merge and coverage floors run in their own job that `test` needs,
   or in `test` after the result check, which stays the first step. A job that waits for the
   static gates needs `test-gates`, never `test`: a job `test` needs that needs `test` is a
   cycle, and GitHub rejects the workflow. Test missing, failed, cancelled and legitimately
   memo-skipped outcomes. The exact shipped tree must have the same complete evidence as before
   the optimization.

Do not use broad path skips, smoke-only PRs, retry-to-green flakes, disabled isolation or
lowered floors as performance fixes. An optimization must reduce verification latency or total
runner cost while preserving the contract. Report both measures and the evidence that no
required case disappeared.

## Mature clones: capacity and benchmark evidence

The kit keeps one suite runner. A clone with a long suite reduces startup and fixture cost first
(the runtime split above, the batched fixture helper), then chooses its capacity from
measurements. For a 20-minute gate, a reduction of more than 75% means under five minutes with the
same test inventory and coverage and security gates: a measured acceptance target, not a
guarantee.

- **Evidence.** At least three matched baseline and candidate CI runs on the same source,
  dependencies, runner class and coverage mode. Report the median, the slowest sample and total
  runner-minutes; three samples do not establish p95. Keep queue and deploy time separate. A local
  pilot, or a run without coverage, does not establish a CI result.
- **Cost.** A faster critical path can take more runner-minutes. Record both, and choose the
  smallest measured capacity that meets the app's budget. Approve paid capacity only with verified
  runner labels, a measured gain, current pricing and a cost cap; standard runners stay the
  default. Stop adding shards when setup, merge and queue overhead dominate.
- **Balance each runtime.** Count each shard's files per runtime: equal totals can hide three times
  as many full Workers imports on one runner. Timing hints place files; they never establish
  success or completeness, and an unknown or edited file still runs exactly once.
- **Bound concurrency.** Start at one worker per Workers project, record how many projects run at
  once on each runner, and raise it only after complete green runs. A Workers runtime can finish
  its assertions and then hang at shutdown under more workers, so prove shutdown as well as
  completion, and keep a hard job timeout that fails the aggregate. A process-wide CPU measurement
  counts other Vitest threads: run such a test in isolated Node processes and keep its budget.

**Reference: Insights, October 9.** Three baseline and three candidate runs on the same
application source, lockfile, test inventory (937 files, 13,530 tests, one original skip) and
coverage and security floors. The complete gate, with installation, shutdown and merged coverage,
went from a median of 20m22s (20m22s, 20m35s, 18m25s) to 4m33s (4m34s, 4m33s, 4m24s), 77.7%
faster, on 32 standard runners with two isolated Node processes and one worker per Workers
project. Median suite runner-minutes rose from 61.55 to 74.28 (20.7%): latency bought with
capacity, not 77.7% less computation. Its earlier 61-test local pilot (minimal Workers and batched
fixtures, two workers, no coverage) went from a median of 12.473 s to 3.690 s; that does not
establish the CI result. The implementation and evidence are in
[Insights PR #339](https://github.com/CialDNB/insights/pull/339).

## Further reading

- [The Test Suite Is the New Code Review](https://allen.hutchison.org/2026/09/17/the-test-suite-is-the-new-code-review/): treat tests and their intent as reviewed engineering artifacts.
- [Vitest projects](https://vitest.dev/guide/projects) and [performance guidance](https://vitest.dev/guide/improving-performance): separate environments and measure bottlenecks.
- [Vitest sharding](https://vitest.dev/guide/improving-performance#sharding) and [coverage](https://vitest.dev/guide/coverage): distribute execution while preserving complete evidence.
- [Cloudflare Workers testing](https://developers.cloudflare.com/workers/testing/vitest-integration/): preserve faithful runtime/storage behavior.
