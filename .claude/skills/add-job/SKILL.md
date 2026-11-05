---
name: add-job
description: Add a scheduled (cron) job that can't fail silently — a task in the daily ops loop (heartbeat, alert-on-failure), or, for its own cadence, a handler on its own trigger branch that never rejects, logs every failure, pages once it is past its bar (at most once a day) and is watched by a liveness task in the loop. Use for recurring background work.
---

# /add-job — a cron job that can't fail silently

**Prime directives apply** (CLAUDE.md). A job is a task in the daily loop in
`src/cron/index.ts` (`TASKS`) unless it needs its own cadence: the heartbeat records per-task
results, failures alert to the configured `ALERT_EMAIL` (see OPEN-QUESTIONS A4 / kickoff D9),
and /_health surfaces staleness. A job on its own cadence (step 4) runs outside the loop and gets
none of that for free, so step 4 gives it the same three things itself: a failure that is logged
and, once the job is past its bar, pages (at most once a day), a record of its last good run, and
a task in the loop that pages when that record goes stale. A job outside the loop without them is
invisible; don't build one.

**Deployment target first.** Run `node scripts/deployment-target.mjs` (or
`npm run -s deployment-target`, where `package.json` has it). It prints the app's target:
- `cial`: the steps below, as written. An app with no `scripts/deployment-target.mjs` predates
  the targets and is CIAL too. If the app also has a release caller
  (`.github/workflows/il-paved-road-release.yml`), it is dual-delivered: its central Worker takes
  the job's schedule, resource or secret from the catalog, so follow **DB Israel apps** below for
  that Worker as well.
- `dbisrael`: a DB Israel app, delivered centrally. The code is the same, but what the job runs
  on is granted centrally: see **DB Israel apps** below before step 4.
- It exits 1: stop. The deployment marker is invalid, or missing in an app that shows a sign of
  DB Israel delivery. Which target the app has is the owner's decision, made in a reviewed PR;
  never write the marker yourself to get past it.

## Steps

1. **Write the task** in `src/cron/<name>.ts`: `export async function runX(env: Env):
   Promise<string>` — the returned string is the heartbeat detail (make it informative:
   counts, keys written). A task in `TASKS` throws on failure; the loop catches, records, and
   alerts. (A handler on its own branch must never throw: step 4.)
2. **Data access through `src/data/`** repositories only (semgrep enforces). External
   calls go in a typed module, never raw fetch sprinkled in the task.
3. **Register** it in the `TASKS` array in `src/cron/index.ts`.
4. **Schedule:** the default daily 03:00 UTC cron (`DAILY_OPS_CRON`) covers most needs:
   everything in `TASKS` runs there. A task never sees `controller.cron`, so a different
   cadence cannot be a guard inside the task. A job on its own cadence is not in `TASKS` (its
   liveness check is) and is, in ONE PR:
   - the expression in `triggers.crons` of both `wrangler.jsonc` and
     `wrangler.staging.jsonc`, and an exported constant for it next to the handler
     (`export const MY_JOB_CRON = '*/15 * * * *'`);
   - a handler that **never rejects**. `waitUntil` catches nothing: a rejection goes to Workers
     Logs with its raw message and stack, outside `logEvent` (PIA C5), and nobody is alerted.
     Wrap the job end to end. On success, record the run. On failure, log an event from your
     app's own registry (`createLogger`; never edit `KIT_LOG_EVENTS`, which is protected core).
     Page with `sendAlert` only once the job has gone `MY_JOB_STALE_HOURS` without a good run,
     and then at most once per UTC day (`rateLimit` on `alert:my_job`, the way the kit throttles
     its declared-audit alert). Never page on every failed run: that is 12 pages for a 3 h outage
     of a `*/15` job, and 1,440 a day for a per-minute one. The page path can reject too (KV,
     `getSecret`), so it gets its own catch, and whatever it misses the liveness task below
     pages at the next daily run:
     ```ts
     // src/cron/myJob.ts (createLogger and field from src/platform/logEvent.ts, rateLimit from
     // src/security/rateLimit.ts, sendAlert from ./alert)
     const log = createLogger({
       my_job_failed: { level: 'error', fields: { err: field.err } },
       my_job_alert_failed: { level: 'error', fields: { err: field.err } },
     });
     export const MY_JOB_LAST_OK = 'heartbeat:my_job'; // SESSIONS KV: the last good run
     export const MY_JOB_STALE_HOURS = 2; // a few periods: no page until this long without a good run

     export async function runMyJobSafely(env: Env): Promise<void> {
       try {
         await runMyJob(env); // may throw, like any task
         await env.SESSIONS.put(MY_JOB_LAST_OK, new Date().toISOString());
       } catch (err) {
         log('my_job_failed', { err }); // every failed run is logged; only a page is throttled
         try {
           // Past the bar, one page per UTC day (rateLimit's window), never one per run.
           if (
             !((await hoursWithoutGoodRun(env)) < MY_JOB_STALE_HOURS) &&
             (await rateLimit(env, 'alert:my_job', 1, 86_400)).ok
           ) {
             await sendAlert(env, [{ task: 'my_job', ok: false, error: String(err) }]);
           }
         } catch (alertErr) {
           log('my_job_alert_failed', { err: alertErr });
         }
       }
     }
     ```
   - its own branch in `runScheduled` (`src/cron/index.ts`), above the daily-loop
     fallback, that runs only your handler:
     `if (controller.cron === MY_JOB_CRON) { ctx.waitUntil(runMyJobSafely(env)); return; }`;
   - a **liveness task in `TASKS`** (steps 1 and 3) that throws, and so pages through the loop,
     when the job has gone longer than `MY_JOB_STALE_HOURS` without a good run. Without it, a
     job whose trigger drops out of wrangler in a hand-merged edit, or that fails on every run,
     looks exactly like a quiet one. A missing record does not page at once: the first check
     that finds none starts the clock (`MY_JOB_WATCHED`), so a new job gets the whole bar for
     its first good run, and one that never has one pages at the next daily run. That grace is
     also what keeps the kit's own cron tests green with your task in `TASKS`: `seedDb` clears
     `heartbeat:` before every test, so they run the loop on an empty KV. Keep both keys under
     `heartbeat:`. Never seed the record in `seedDb` or in the kit's tests (both are carried
     at every `/kit-upgrade`), and never let a missing record pass for good (that hides a job
     that never fires):
     ```ts
     // src/cron/myJob.ts, continued
     export const MY_JOB_WATCHED = 'heartbeat:my_job_watched'; // a check first found no good run

     /** Hours without a good run: since the last one or, before the first, since a check found none. */
     export async function hoursWithoutGoodRun(env: Env): Promise<number> {
       let since = (await env.SESSIONS.get(MY_JOB_LAST_OK)) ?? (await env.SESSIONS.get(MY_JOB_WATCHED));
       if (since === null) {
         since = new Date().toISOString(); // a new job, or a kit test's empty KV: start the clock
         await env.SESSIONS.put(MY_JOB_WATCHED, since);
       }
       return (Date.now() - Date.parse(since)) / 3_600_000; // NaN for a garbled record
     }

     export async function checkMyJobLiveness(env: Env): Promise<string> {
       const hours = await hoursWithoutGoodRun(env);
       if (!(hours < MY_JOB_STALE_HOURS)) {
         throw new Error(`my_job: no good run in ${MY_JOB_STALE_HOURS} h`); // NaN pages too
       }
       return `my_job: ${hours.toFixed(1)} h without a good run (bar ${MY_JOB_STALE_HOURS} h)`;
     }
     // in TASKS: ['my_job_liveness', checkMyJobLiveness],
     ```
   - tests in `test/cron/`: `runScheduled({ cron: MY_JOB_CRON } …)` runs the handler and writes
     no heartbeat; with the job forced to throw, the work promise RESOLVES and your failure
     event is logged with the error's class only; one failed run right after a good one pages
     nobody, an outage pages once it passes the bar and then at most once per UTC day, and a
     page path that rejects is caught; the liveness task passes on an empty KV (and again a
     minute later), throws once the bar has passed with still no good run, throws on a stale or
     garbled record, and passes on a fresh one; and `MY_JOB_CRON` is declared in both configs
     (add it to the `declared(config)` check in `test/cron/cron.test.ts`, next to
     `DAILY_OPS_CRON`). Then run the whole of `test/cron/` and `test/health.test.ts`: they run
     the loop with your task in it, and must stay green as they are;
   - a DECISIONS.md note.

   Without the branch the trigger is unrecognized: it runs the daily loop only when the
   loop's heartbeat is at least `UNRECOGNIZED_CRON_MIN_HEARTBEAT_AGE_HOURS` (20) old, and
   otherwise logs `cron_trigger_unrecognized` and does nothing, so your job never runs on it.
5. **Tests** for a task in `TASKS`, in `test/cron/`: call `executeScheduledRun(env)` (or the
   task directly), assert the work happened AND the heartbeat payload includes your task green.
   Failure path: make it throw, assert the run records `ok: false` for it. (A handler on its
   own branch never reaches the heartbeat: its tests are step 4's.)
6. **Idempotency check:** the task must tolerate running twice (reruns, retries).
7. **Verify** the changed job and scheduler/failure contracts with focused tests while
   developing, then `npm run ci` once on the final tree before shipping. `/ship` can use that
   result while every input remains unchanged; all PR gates still run (see `docs/TESTING.md`).
   Update Linear; document the job in docs/ARCHITECTURE.md's ops section if it's load-bearing.

## DB Israel apps

The code is the same: the task, the handler, its branch, the liveness task and the tests. What a
job runs on comes from the app's entry in the central catalog, not from wrangler, and the
platform maintainer reviews every change to it:

- **A schedule** is an entry in the catalog's `schedules`: at most five five-field expressions,
  the same on every enabled stage, added by a catalog PR in the central repository. Keep the
  expression in both wrangler configs as step 4 says, because the kit's tests and local dev read
  them, but central ignores them. Its read-back is exact, so a trigger added in the Cloudflare
  dashboard fails the next release. Even the daily loop runs only once `schedules` holds
  `DAILY_OPS_CRON`.
- **A resource** (a D1, KV or R2 binding) is a catalog PR, then the platform's `onboard-app`
  `apply`, which creates it, then the receipt PR that records it.
- **A Worker secret** is declared in the catalog: `runtime_secrets` when every release needs it,
  `optional_runtime_secrets` when the app runs without it. Someone with DB Israel Cloudflare
  access sets its value on each stage's Worker (docs/SECRETS.md, "DB Israel apps"), in the order
  central's onboarding guide gives. A declared required secret without a value stops every
  release, and a secret on the Worker that the catalog does not declare fails the
  post-deployment read-back.
- **The catalog change lands first.** A merge to main releases at once, with whatever the
  catalog grants at that moment, so hold the merge of the app PR until the catalog PR (and, for a
  resource, its receipt) has merged.
