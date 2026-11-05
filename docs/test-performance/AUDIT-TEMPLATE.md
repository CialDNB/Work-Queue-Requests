# Test-suite audit — <app>, <date>, <upgrade / issue / PR>

Status: DRAFT until every section has an evidenced decision and a reviewer.

`/kit-upgrade` requires this audit only when the test-performance observer warns: a sustained
budget overrun, a sustained regression above the budget's `regressionPercent` (20% in the kit's
budget), or a complete gate over `fullGateSeconds` (DECISIONS 2026-10-22, option B). Otherwise it
is optional. Copy this file to `docs/test-performance/<date>-<upgrade>.md` and keep it with the PR.
`npm run test:audit -- <observer report>` prints the trigger line. Once `npm run ci` has profiled
the final tree, the same command with `--draft` drafts the slowest-file table. Synthetic data
only: link CI artifacts rather than copying raw
failures, test titles or credentials.

## Trigger and baseline

- Trigger line, as `npm run test:audit` printed it, and the observer run it came from:
- App and kit revisions, lockfile, Vitest and Workers pool versions, runner class, cold or warm
  cache, other work on the machine, the full-suite command and its exit status:
- Complete CI runs and their timing artifacts, with the initial queue kept separate:
- Discovered files and test cases, passes, failures and skips; coverage (global and per-folder
  floors) and the permission matrix, uniformity and security results:
- `test-performance-budget.json`: focused seconds, complete-gate seconds, gate runner-minutes,
  suite jobs, imbalance ratio; its owner, and the DECISIONS entry for any deviation:
- Focused or watch command, and its measured local seconds:

## Runtime and repeated work

Review the 20 slowest files AND every full Workers test added since the last audit. Full Workers
is the default because it is faithful; this review keeps portable tests from piling up there.

| File or group | Runtime now | Contract that needs that runtime | Import, setup, fixture or wait cost (evidence) | Decision and measurement |
| --- | --- | --- | --- | --- |
| | | | | |

Check for application or barrel imports where a direct import would do, seeds larger than the
contract needs, repeated schema, migration or reset work, waits on a fixed sleep, and files much
longer than the rest. Split a long file only into independent groups with their own complete
setup and reset, never by sharing mutable state. Workers storage semantics, migration and WORM
recovery, locale and native API behavior, and resource shutdown stay real. Fake timers fit only a
clock the test controls; they do not expire Workers storage. Move nothing to another runtime
without checking its transitive imports and the combined coverage.

## Test intent

Similar-looking tests are a lead, never proof of redundancy.

| Candidate tests or cases | Failure or boundary it detects | Independent expected result | Retained case, and its regression or mutation proof | Keep, consolidate or rewrite; reviewer |
| --- | --- | --- | --- | --- |
| | | | | |

Show the retained case failing with the defect restored, or under a targeted mutation that the
removed case also caught. Keep every distinct negative, auth, permission, isolation and migration
case. If nothing can be consolidated safely, record what was inspected and why it stays. A removal
is its own reviewable change with an old-to-retained map; never delete an app's own tests to match
the kit. Equal line coverage does not prove equal fault detection.

## Capacity and feedback

- Shard counts measured, the slowest and median shard, install, startup, merge and queue overhead,
  and the smallest runner pool that meets the budget; exact-once and report-identity checks kept:
- Focused tests and watch mode cover the affected auth, permission and isolation contracts; every
  required PR gate and the full combined coverage stay in place:
- Any added exhaustive or mutation job has a bounded cost and supplements the PR checks; no
  required case leaves PR CI:

## Evidence and closeout

| Variant / revision | CI run | Complete gate s | Initial queue s | Gate runner-min | Suite runner-min | Inventory, outcomes, coverage |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Baseline | | | | | | |
| Candidate | | | | | | |

A claimed speedup needs at least three matched runs per variant: report the median, the slowest
and the runner-minutes. The observer's trends match configuration and runner labels; they are not
a controlled benchmark, and three samples are not a p95.

- The evidence-backed change and its measured effect, OR the evidenced no-change decision:
- Failures and gaps left visible; each sustained warning resolved, or given an owner and issue:
- The final clean-install `npm run ci` on the final tree, its revision and any uncommitted inputs:
- Code-owner reviewer, and the issue and PR links:
