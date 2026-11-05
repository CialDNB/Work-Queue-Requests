---
name: kit-upgrade
description: Pull improvements from the paved-road template into this app (template repos don't propagate — this skill is the upgrade path). Use when the kit CHANGELOG announces something you want.
---

# /kit-upgrade — adopt template improvements deliberately

Template repositories don't push updates downstream; upgrades are a deliberate diff-
and-adopt. The kit's protected core is designed to be app-agnostic, so most upgrades
apply cleanly.

**Deployment target first.** Run `node scripts/deployment-target.mjs` (or
`npm run -s deployment-target`, where `package.json` has it). It prints the app's target:
- `cial`: the steps below, as written, unless the app has a release caller
  (`.github/workflows/il-paved-road-release.yml`, or the legacy `paved-road-release.yml`). A
  `cial` app with a caller is dual-delivered: its CIAL pipeline and the central DB Israel one both
  release it, so the rules in **DB Israel apps** below apply to it too. An app with no
  `scripts/deployment-target.mjs` predates the targets and is CIAL too, unless it has a caller:
  see the same section.
- `dbisrael`: a DB Israel app, delivered centrally. Follow the steps with the rules in
  **DB Israel apps** below.
- It exits 1: stop, before you adopt anything. The deployment marker is invalid, or missing in an
  app that shows a sign of DB Israel delivery, and every guard this upgrade carries fails closed
  on it. Which target the app has is the owner's decision, made in its own reviewed PR before the
  upgrade; never write the marker yourself to get past it.

## Steps

1. **Fetch the template:**
   `git remote get-url kit || git remote add kit https://github.com/CialDNB/paved-road.git`
   then `git fetch kit main`.
2. **Read first:** `git log --oneline HEAD..kit/main -- CHANGELOG.md` and the kit's
   CHANGELOG.md entries since your last upgrade (the kit versions its changes; each
   entry says what changed and whether migration steps apply). Collect every entry's
   **Manual steps for forks** into one list before you start: they are the changes the
   diff set below cannot carry — wrangler vars and bindings, `package.json` scripts,
   kit migrations to copy, CODEOWNERS owners — and nothing else will remind you of them.
   Then, before you adopt anything, download the test-performance observer's latest report and
   read its status (the "Test-suite performance audit" bullet in step 4): the upgrade changes
   the files the observer compares, so its history starts again.
3. **Diff the protected core** (where upgrades concentrate and apply cleanly):
   `git diff HEAD kit/main -- src/index.ts src/env.ts src/framework src/auth src/data src/email src/security src/ai src/cron src/mcp src/platform src/health.ts schema.sql web/public/_headers web/src/agent semgrep test/isolation test/helpers test/framework test/auth test/data test/web test/ai test/mcp test/cron test/email test/security test/health.test.ts test/platform/log-event.test.ts test/platform/migration-ordinals.test.mjs test/platform/source-hygiene.test.mjs test/platform/port-ui-scripts.test.mjs test/platform/new-app.test.mjs test/platform/bootstrap.test.ts test/platform/deployment-target.test.mjs test/platform/workflow-enrollment-safety.test.mjs test/platform/template-purity.test.mjs test/platform/central-proposal.test.mjs test/platform/runtime-config.test.mjs migrations/d1/README.md templates docs/runbooks docs/IMPLEMENTATION-HANDBOOK.md docs/DESIGN-PORT.md docs/TESTING.md docs/test-performance/AUDIT-TEMPLATE.md .github .claude .githooks scripts CLAUDE.md AGENTS.md .cursor docs/PLAYBOOKS.md docs/agent-guidance.sync.json tsconfig.json test/tsconfig.json web/tsconfig.json vitest.config.ts biome.json`

   This is the whole protected core plus what pins and documents it — one set, because each
   part fails without the others:

   - **The core.** `src/` framework, auth, data, email, security, ai, cron, mcp and platform,
     `index.ts`, `env.ts` and `health.ts`; the `schema.sql` system tables; the security headers;
     the uniformity tripwire and the test helpers. `src/platform` and `src/mcp` are core too:
     every carried file logs through `src/platform/logEvent.ts`, so a core adopted without it
     does not typecheck. `src/env.ts` is carried because the core reads the fields it declares —
     a carried file naming a field your `Env` lacks does not typecheck either. On the client,
     `web/src/agent` — the agent panel's stream, reducer, UI intents and its own catalogs (the AI
     disclosure, errors, approval summaries), protected like `src/ai`. The three typecheck
     configs (`tsconfig.json`, `test/tsconfig.json`, `web/tsconfig.json`) are gates: take the
     kit's tightening, never loosen one to make a carried file compile.
   - **The kit's tests for that core** — `test/framework`, `test/auth`, `test/data`, `test/web`,
     `test/ai`, `test/mcp`, `test/cron`, `test/email`, `test/security`, `test/health.test.ts`
     and the eleven `test/platform` files named. The third, `source-hygiene`, fails on a raw
     bidi control character in any text file of your repo (Trojan Source). The fourth,
     `port-ui-scripts`, pins `/port-ui`'s scripts and skips itself, with a reason, until you adopt
     `/port-ui`. The next five pin the bootstrap and the deployment target, so your copies follow
     the `scripts/` and `src/platform` files they test. `new-app.test.mjs` and `bootstrap.test.ts`
     pin the bootstrap's rename and its residual scan, and accept entries of your own in the
     self-reference allowlist (keep them in both source files); the neutral-file scan leaves out a
     carried file your app does not have. `deployment-target.test.mjs` pins the reader and the
     guards' wiring in your workflows (take their hunks with it), and in a CIAL app it skips the
     laptop-script cases, with a reason, until your `package.json` has the guarded scripts (a
     CHANGELOG manual step). `workflow-enrollment-safety.test.mjs` reads your own workflows only in
     an app that shows a sign of DB Israel delivery, and `template-purity.test.mjs` skips itself
     outside the kit. The last two follow the modules the upgrade carries for a DB Israel app's
     registration: `central-proposal.test.mjs` pins `scripts/central-proposal.mjs` on synthetic
     trees, and `runtime-config.test.mjs` pins `src/platform/runtimeConfig.mjs`, comparing it with
     `src/env.ts` only in the kit (your `Env` may have fields of its own). A core adopted without
     its tests is unpinned: the next edit that breaks one
     of its invariants stays green.
   - **What the core points at** — `docs/runbooks` (the runbooks CHANGELOG entries, alerts and
     the core's own messages send you to), `docs/IMPLEMENTATION-HANDBOOK.md`, `templates/`, and
     `docs/DESIGN-PORT.md` (the `/port-ui` method that `CLAUDE.md`, the Cursor rule, PLAYBOOKS and
     the skill link), and `docs/TESTING.md` (the testing guide the same files, the authoring
     skills and `ci.yml` link). An app that already has its own `docs/TESTING.md` merges it
     hunk by hunk like any file both sides have: take the kit's sections, keep the app's.
     `docs/test-performance/AUDIT-TEMPLATE.md` is the audit the observer's warnings trigger
     (step 4); your own dated audits beside it are yours, and the set leaves them out.
   - **Yours, inside those paths — skip those hunks.** Your repositories in `src/data`, the
     `schema.sql` APP TABLES section, your own `Env` fields in `src/env.ts` (take the kit's new
     fields, keep yours), your own `paths`/`include` entries in the tsconfigs, your own runbooks,
     your entries below the `---- app actions` line at the end of `SENSITIVE_ACTIONS` in
     `src/cron/auditAnomalyDigest.ts` (see the app-sections bullet below),
     and your own tests. The test folders hold both: a
     file only the kit has is new — take it; a file both have is a hunk-by-hunk merge (the
     permission matrix in `test/auth/permissions.test.ts` keeps your rows); a file only you have
     shows in the diff as a deletion — skip it, never delete your tests to match the kit. One
     kit-only test is NOT new for every app: `test/ai/ui-intents.test.ts` also drives the kit's AI
     client (`assertCustomTools`, `callAnthropic`), so an app that runs its own `src/ai/anthropic.ts`
     skips it at every upgrade.
   - **Migrations.** The set carries the two kit files that govern `migrations/d1/` — the
     ordinal guard and the folder's README — but never the `*.sql` files themselves: a fork's
     migration numbering is its own. Copy each new kit migration by hand to your next free
     ordinal (`0000_kit_app_identity.sql` keeps its number and seeds your `APP_NAME`).
     `node scripts/check-kit-migrations.mjs` — it rides `scripts/`, with its manifest
     `scripts/kit-migrations.json`, and CI runs it — matches every kit migration by content
     under any number, and names each one still missing with the file name to copy it to. Keep
     the kit's slug when you renumber (that file name does): the carried migration tests find a
     kit migration by slug (`migrationBySlug` in `test/helpers/db.ts`), never by the kit's
     number. The guard's `APPLIED_BEFORE_THE_GUARD` set is yours as well — see trap T1.
   - **Not carried: `web/src/i18n`.** The kit ships no such folder — the kit's catalogs for the
     agent panel belong under `web/src/agent`, which is carried — and several apps have their own
     i18n system there. It is yours, like the rest of `web/` outside `web/src/agent`.

   Apply hunk-by-hunk (`git checkout -p kit/main -- <path>` or manual). Your app code
   (src/routes/, src/data/<your repos>, web/ pages, schema APP TABLES) is yours — the
   kit never overwrites it.
   - **Blob provenance beats guessing.** For each kit-core file your repo has touched,
     check whether your copy's blob exists in kit history:
     `git log --oneline --find-object=$(git rev-parse HEAD:<path>) kit/main | head -1`.
     A hit means the file is provably an unmodified kit version — take the kit's current
     copy wholesale. Reserve hand-merging for files where the check misses (real fork
     divergence), and use YOUR actual divergence point as the 3-way base, not the kit
     release you last stamped (`git merge-tree --write-tree --merge-base=<base>`
     mechanizes this). Proven across the 11-fork 0.2.1 wave (AICOE-484).
   - **App-owned files inside the core — never take the kit's entries.** `src/ai/uiTargets.ts`
     (`AGENT_VIEWS` / `AGENT_FORMS`: what the in-app agent may open and prefill) is yours after
     its first adoption, like the app section of `PERMISSIONS`. Keep your entries and skip the
     kit's hunks EVEN WHEN blob provenance says your copy is an unmodified kit version: a kit
     entry taken wholesale widens what the agent reaches in your app without a decision of
     yours. Add an entry only on purpose, reviewed. (`src/ai/uiIntents.ts`, the mechanism, is
     kit-owned — take it whole.)
   - **App sections inside kit-owned lists — take the kit's lines, keep yours below the marker.**
     `SENSITIVE_ACTIONS` in `src/cron/auditAnomalyDigest.ts` (the audit actions the daily digest
     counts) ends in a `---- app actions` line. The entries above it are the kit's: take those
     hunks. The lines below it are yours: keep every one. Taking the whole file, or a kit hunk
     that reaches past the marker, deletes them, and **no test fails**: the kit's tests pin only
     the kit's entries, and the tripwire (`test/isolation/sensitive-actions.test.ts`) only checks
     that each listed name is written. The action just stops reaching the digest. Pin your
     entries in a test of your own, outside the folders this skill carries (the kit CHANGELOG
     entry "The daily audit digest counts the settings and force-logout actions…", step 1).
   - **Never adopt from the kit:** `tools/`, `plugins/`, `.claude-plugin/`, and kit
     planning docs — platform-maintainer surfaces. The ci.yml plugin-mirror step is safe
     to keep (its glob is name-free and self-skips without a `plugins/` dir); strip the
     `verify:plugin` package script unless you keep a localized `plugins/<app>` mirror.
   - **Security headers — always reconcile these on upgrade.** The kit tightens its
     security-header defaults over time, and they live in two mirrored places:
     `src/index.ts` (worker responses) and `web/public/_headers` (the SPA document +
     static assets). Diff BOTH every upgrade and adopt the tightened defaults (CSP, HSTS,
     X-Frame-Options, X-Content-Type-Options, Referrer-Policy). Only skip a hunk if your
     app has a **documented** reason to diverge — e.g. a CSP that must allow an extra
     script/style/connect origin for a third-party widget — and record that divergence in
     `docs/DECISIONS.md` so the next upgrade knows it's deliberate, not drift.
   - **Agent-guidance mirrors — reconcile when `CLAUDE.md` moves.** The kit's working agreement
     (`CLAUDE.md`, surfaced to non-Claude-Code tools as the `AGENTS.md` symlink) has two curated
     mirrors: `.cursor/rules/paved-road.mdc` and `docs/PLAYBOOKS.md`. If you adopt a `CLAUDE.md`
     hunk that touches a load-bearing invariant, update those mirrors too, then re-stamp:
     `npm run verify:agents -- --write`. Same forcing-function as the edge flags below — if you
     skip a `CLAUDE.md` hunk and `npm run verify:agents` then fails, the kit moved the canonical
     guidance: adopt it, update the mirrors, re-stamp.
4. **Renamed-identity caution:** template files carry YOUR app name post-bootstrap;
   diffs against the template will show `paved-road` ↔ `<your-app>` noise in
   wrangler/package files — skip those hunks unless structure changed. **But** if you skip a
   `wrangler.*.jsonc` hunk and `npm run verify:edge` then fails, the kit tightened the edge
   flags — set `workers_dev: false` and `preview_urls: false` by hand in both deploying
   configs so the gate passes (never re-enable them).
   - **Fleet reporting (opt-in):** the registry URL is baked into the kit and rides this upgrade,
     so a production **or staging** app reports to the App Registry as soon as its `REGISTRY_TOKEN` is set — the
     one wrangler step upgrade can't do for you. If you want this app in the fleet catalogue, wire
     the token **per Worker you want listed** — prod and staging are separate Workers, so arming
     one never arms the other (uncomment the `REGISTRY_TOKEN` `secrets_store_secrets` block in
     `wrangler.jsonc` and/or `wrangler.staging.jsonc`, or `wrangler secret put REGISTRY_TOKEN`
     with the matching `--config`) per docs/MANIFEST.md → "Reporting to the fleet registry".
   - **Opt-in capabilities ship DORMANT — adopt the code, stay off until you need it.** The
     **Sensitive-Data Protection** capability (at-rest field sealing + the control-plane tripwire)
     is one such: pulling it adds `src/crypto/seal.ts`, `src/cron/auditWatch.ts`,
     `scripts/seal-key.mjs`, the `securityAlertEmail` template, the `SEAL_KEY`/`AUDIT_*` env
     fields, the commented wrangler bindings + the hourly cron, the runbooks, and
     `docs/sensitive-data-doctrine.md` — but it does **nothing** until you set `SEAL_KEY` / seal a
     column / arm the tripwire (`AUDIT_API_TOKEN`). Adopt the hunks so a future field is one
     doctrine-read away; do not turn it on as part of the upgrade. Read
     `docs/sensitive-data-doctrine.md` ("payload, never predicate") before sealing anything.
   - **Test timing and performance tooling: what rides the diff set, and what you adopt.** Step
     3 carries `scripts/test-profile.mjs`, `scripts/test-performance.mjs` and their
     `scripts/kit-checks/main-module.mjs` helper; in `ci.yml`, the timing steps, the budget check
     and the `test-performance` observer job; `docs/TESTING.md`; and
     `docs/test-performance/AUDIT-TEMPLATE.md`. `ci.yml` calls both scripts with `node`, so CI
     needs no package command, and both pass in an app with no budget ("not adopted"). Nothing
     else arrives on its own. Adopt by hand, per the CHANGELOG entries' manual steps:
     - **`package.json`** (trap T5): `test:profile` in your `ci` chain in place of your coverage
       script (`node scripts/test-profile.mjs run coverage` when yours is not `test:coverage`),
       `verify:test-performance` in `ci`, and `test:performance` and `test:audit`;
     - **`.gitignore`:** `.test-results/`;
     - **the tests that pin the tooling**, which the set leaves out:
       `git checkout kit/main -- test/platform/test-profile.test.mjs test/platform/test-performance.test.mjs`;
     - **`test-performance-budget.json`**, once your CI layout is settled. From then on it is
       yours: keep your limits, job names, suite-job count and comparison files at every
       upgrade. Its CODEOWNERS line rides `.github`; keep your owner on it.

     Keep the fork's existing coverage command, test selection and floors; runtime-project
     splitting and sharding require app-specific review and measurements.
   - **The runtime split (Node, minimal Workers and full Workers test projects) is optional, and
     adopted on its own.** Step 3 carries `vitest.config.ts`, `scripts/test-runtime-boundary.mjs`,
     `docs/TESTING.md` and the CODEOWNERS and hook entries for the split's files. **Take the
     CODEOWNERS entries (`/test/projects.mjs`, `/test/runtime/`, `/test/setup/`, with your owner)
     on this upgrade whether or not you adopt the split:** the carried hook list warns on those
     paths, and `test:hooks` fails ("hook warns, CODEOWNERS does not own it") for any of them
     your tree already has. Until your app has `test/projects.mjs`, the carried
     `vitest.config.ts` runs the single full-Workers project it ran before, with the same
     coverage map and floors (#257 review F2), so taking it changes nothing; never create
     `test/projects.mjs` on its own, since the config then expects every file below. A
     `vitest.config.ts` of your own (more projects, other setup) merges hunk by hunk, like any
     file both sides have. **When adopting the split**, as its own PR with before/after
     evidence:
     - carry the files step 3 leaves out:
       `git checkout kit/main -- test/runtime test/setup test/platform/test-projects.test.mjs test/platform/test-runtime-boundary.test.mjs`.
       **Not if your app already runs a split of its own** (it has its own `test/projects.mjs`,
       `test/setup/` or `test-projects.test.mjs`, as Insights does): the checkout overwrites them.
       Merge each of those files hunk by hunk instead, keeping your manifests, setup and
       placement pins, and record in DECISIONS any reviewed placement that differs from the
       kit's never-move list below;
     - write YOUR `test/projects.mjs`. Start from the kit's: both of its lists, each naming at
       least one file (`test-projects.test.mjs` refuses an empty one, #291 review R1), and only
       files whose imports it passes for the runtime you list them in. The auth, framework,
       route, cron, security, isolation, audit and read-log suites never move, and a new test
       stays in full Workers;
     - rebuild `test/runtime/wrangler.test-minimal.jsonc` from YOUR `wrangler.test.jsonc`: the
       same bindings, vars and compatibility settings apart from `workflows`, which it leaves
       out (the parity test holds the rest equal and refuses `workflows`), with its own `name`
       and `"main": "minimal-worker.ts"`. A Durable Object binding stays: the runtime starts,
       and a test that uses a class only `src/index.ts` exports fails with "does not export a …
       Durable Object", so such a suite stays in full Workers. Keep the config under
       `test/runtime/`: `verify:edge` reads every root wrangler config as one that deploys;
     - **`package.json`** (trap T5): `"@babel/parser": "7.29.7"` in `devDependencies`, which the
       import guard parses with (already in your lockfile through the coverage tooling; run
       `npm install` so the lockfile records it as direct), and the `test:node`, `test:workers`
       and `test:workers:minimal` scripts;
     - in `test-performance-budget.json`, if you have one, add `test/projects.mjs`,
       `test/runtime/minimal-worker.ts`, `test/runtime/wrangler.test-minimal.jsonc` and
       `test/setup/node-no-network.ts` to `comparisonFiles`: they change what a run executes,
       so the observer's history starts again;
     - prove the move: the same test names before and after, the coverage floors green, and a
       full `npm run ci`. Node's Intl and WebCrypto and Workers' native APIs can differ: a test
       that passes in Node does not show that workerd behaves the same.
   - **Test-suite performance audit: when the observer warns, not on every upgrade** (DECISIONS
     2026-10-22, option B). In step 2, before you adopt anything, download the observer report
     of the app's latest green PR run with an available observation: the newest of the last ten
     whose `test-performance-<id>-<attempt>-*` artifact name ends in a 64-hex configuration
     fingerprint. Skip a run whose artifact ends in `-unavailable`: after "Re-run failed jobs",
     for one, the green attempt's observer refuses the jobs it carried over from the failed
     attempt.
     When none of the ten has one, take the newest; its line says why. Then run the trigger:

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
     node scripts/test-performance.mjs audit "$report"
     ```

     (`npm run test:audit -- "$report"` once `package.json` has it.) **On the upgrade that brings
     the `audit` mode**, your tree's script does not have it yet: it prints
     `Usage: node scripts/test-performance.mjs check|ci` and exits 2, or the script is missing.
     Run the command in step 2 all the same, and keep the path it printed after
     `Observer report:`. Shell variables do not survive from one command to the next (each Bash
     call starts a fresh shell), so `$run` and `$report` are gone by step 3. Right after step 3
     has carried the kit's script, run `node scripts/test-performance.mjs audit <path>` with
     that path written out. The script refuses an empty or unexpanded path, and prints no line
     for it. The report is still the pre-upgrade run's, so its line holds. The command prints
     the one line step 5 records:
     - **warning: the dated audit is required.** The observer warned of a sustained budget
       overrun (complete gate, gate runner-minutes or shard imbalance) or of a sustained
       regression in latency or runner-minutes above the budget's `regressionPercent` (20% in
       the kit's budget), or the latest complete gate alone took longer than `fullGateSeconds`.
     - **clear:** none of those. The audit is optional.
     - **unavailable:** no budget, which prints
       `Test performance: unavailable (no test-performance budget adopted). Audit not triggered.`,
       or no available observation in the last ten green PR runs. Nothing is inferred and the
       audit is optional. A partial re-run is unavailable by design; when recent runs stay
       unavailable for another reason (an API error, say), open an issue for that reason.

     When it is required, copy `docs/test-performance/AUDIT-TEMPLATE.md` to
     `docs/test-performance/<date>-<upgrade>.md`. The step-2 command only prints the line: a
     timing profile an earlier `npm run ci` left describes the tree before the upgrade. Once step
     5's `npm run ci` has profiled the final tree, run it again with `--draft`, on the path step
     2 printed (`node scripts/test-performance.mjs audit <path> --draft`). It drafts
     `.test-results/test-audit.md` with the 20 slowest files and the runtime each runs in, from
     `test/projects.mjs` ("unlisted" when the app has none, since `vitest.config.ts` then says
     where each test runs). It refuses a profile no newer than the observer run and never
     overwrites a draft; `--draft` drafts an optional audit too. The audit covers
     the 20 slowest files and every full Workers test added since the last audit; imports,
     setup, fixtures and waits; runtime placement and shard balance; and test intent (the
     failure each case detects, its independent expected result, and the retained case that
     catches the same defect). It ends in an evidence-backed change or an evidenced no-change
     decision; a filled-in template is not that. A claimed speedup needs three matched CI runs
     per variant. Nothing moves or deletes a test on its own: a moved, split or consolidated
     test is its own reviewable PR, with an old-to-retained map for anything removed. Commit the
     audit with the upgrade; an upgrade that brings a security fix does not wait for it, and
     then a follow-up PR holds it. The per-PR review of what tests check stays in `/ship`.
5. **Verify — on a FRESH install:** `rm -rf node_modules && npm ci` first (a stale
   node_modules can mask a dropped dependency — trap T5 below), then `npm run ci` green
   (this runs `verify:bootstrap`, `verify:edge`, `verify:kit-migrations` — once your
   `package.json` has it, trap T5 — and `verify:agents`, the agent-guidance drift guard); run the
   uniformity tripwire output specifically.
   - **Upgrading a repo with unknown debt?** Run every gate independently FIRST
     (`typecheck`, `lint`, `build:web`, `test:coverage`, `test:hooks`, `test:scripts`,
     each `verify:*`) and enumerate ALL reds before fixing any — `npm run ci`'s `&&`
     chain stops at the first failure and hides everything behind it (this is how
     app-registry's 0.2.0 adopt shipped a red main that looked green).
   If a kit change altered an invariant, there will be a DECISIONS.md entry in the
   template explaining it — copy it into your app's DECISIONS.md with the adoption date.
   - **Closeout line, on every upgrade.** Put the line the audit command printed on step 2's
     report (right after step 3, on the upgrade that brings the command), as it printed it, in
     the upgrade PR's body and in step 6's CHANGELOG entry, for example
     `Test performance: clear (within-budget, 9 comparable runs), observer run <id> attempt 1. Audit not triggered.`
     or, with no budget,
     `Test performance: unavailable (no test-performance budget adopted). Audit not triggered.`
     When it says "Audit triggered", add the dated audit's path, or the follow-up PR that holds
     it.
   - **A ported app** (`.paved-road/design.json` with `mode: "port"`) loads a scoped copy of
     `web/src/styles.css`, not the file itself. `styles.css` is yours, so the kit's changes to it
     reach you as CHANGELOG manual steps. After applying them, run
     `node .claude/skills/port-ui/scope-kit-css.mjs --check`, and on "stale" regenerate the copy
     (the same command without `--check`): a stale copy leaves the kit's own pages (Users, Audit,
     Tokens, Settings, Login) with the old baseline.
   - **Bootstrap tripwire — run it especially if your app predates it.** `npm run
     verify:bootstrap` (`node scripts/new-app.mjs --verify-only`) flags inherited bootstrap
     defects: carried-over template staging ids, leftover `PAVED_ROAD_*` per-app secret
     prefixes, and stale `paved-road` identifiers. Apps bootstrapped before the 2026-06-17
     hardening (e.g. by hand) can carry these silently — green tests don't catch them. If it
     flags a per-app `PAVED_ROAD_*` secret, repoint it to `<APP>_*` (binding names stay
     canonical; the shared `PAVED_ROAD_ALERT_WEBHOOK_URL` and `PAVED_ROAD_ENTRA_CLIENT_SECRET`
     are intentionally kept — never "fix" those to a per-app prefix); if it flags a
     template staging id, the binding points at paved-road's resource — reset the id +
     re-provision that config.
6. **Record:** the kit cuts versions now — adopting `src/framework/version.ts` wholesale
   brings the right `KIT_VERSION` stamp along (it's what the fleet registry uses to compute
   your lag), **but `APP_MATURITY` in that same file is YOURS** — re-apply your value if this
   app has graduated past `incubating`. Then a CHANGELOG.md entry in your app ("adopted kit
   <version> — …"), a Linear comment, and a note for any hunks deliberately NOT adopted and why.
7. **Announce user-visible upgrades.** If the adopted changes affect what people see or do,
   run `/release-notes` — an upgrade is a milestone. Purely-internal core bumps with no
   user-facing effect don't need a deck.

## DB Israel apps

These rules are for every app with a release caller or a deployment marker: a DB Israel app, and
a dual-delivered app (a `cial` marker and a caller). Such an app upgrades through the same
steps, with these rules on top:

- **Before step 1, note what the upgrade must leave as it is:** the commit you start from
  (`git rev-parse HEAD`) and what `node scripts/deployment-target.mjs` prints. On an older tree
  with no reader yet (the upgrade brings it), the target is the `deploymentTarget` value in
  `.paved-road/deployment.json`; with no marker there, the next rule stops you. The last rule
  below compares both after step 5.
- **A release caller and no marker: stop before step 3.** An app with
  `.github/workflows/il-paved-road-release.yml` (or the legacy `paved-road-release.yml`) or
  another sign of DB Israel delivery, and no `.paved-road/deployment.json`, fails closed in every
  guard this upgrade carries. On an older tree with no reader yet, look for the caller yourself.
  Which target the app has (`cial` if the CIAL pipeline stays live beside the caller, as in a
  dual-delivered app; `dbisrael` otherwise) is the owner's decision. It lands in its own reviewed
  PR before the upgrade, never inside it.
- **Never delete, edit or localize the caller.** The kit has no such file, so step 3's diff shows
  it as a deletion, like a test only your app has: skip that hunk. `git checkout -p` asks "Apply
  deletion to index and worktree" for it: answer `n`. `git checkout kit/main -- .github` keeps it,
  but `git restore --source kit/main` on `.github` deletes it. Enrollment compares its bytes,
  CRLF read as LF. Never let an editor or a formatter wrap its first line: it is 103 characters,
  over `.editorconfig`'s 100. A new caller from central is its own PR, made by an org admin, never
  part of an upgrade.
- **Never touch the marker.** `.paved-road/deployment.json` is outside the diff set; keep it
  out of the upgrade.
- **Trap T2 never rewrites `il-paved-road-*`** (the trap, below).
- **In an enrolled app, the workflow hunks go to an org admin, on the upgrade's own branch.**
  Enrollment installs a push ruleset on `.github/workflows/**` for every branch and tag, and org
  admins are its only bypass, so you cannot push those hunks, on any branch, and only an org admin
  can merge a PR that has them. Keep them in the upgrade, never in a PR against `main` of their
  own: the tests this upgrade carries pin the workflows (`deployment-target.test.mjs` and
  `workflow-enrollment-safety.test.mjs` read them), and the guards call the reader in `scripts/`.
  Split into two PRs, neither goes green, and workflows merged before the reader fail every
  guarded run. So make every other change, push it and open the PR; its CI stays red on the
  workflow pins until the hunks land, as expected. Then ask an org admin to put the hunks on a
  branch of their own stacked on the upgrade's branch, or to push them straight onto it (never the
  caller's deletion), and to merge the upgrade once it is green. Anything you change after that is
  a new commit that touches no workflow file. Dependabot's `github-actions` PRs change the same
  files, so they need an org admin too.
- **After step 5, check that the target and the caller are as they were.**
  `node scripts/deployment-target.mjs` prints what it printed before step 1, and
  `git diff --exit-code <start> -- .paved-road/ .github/workflows/il-paved-road-release.yml .github/workflows/paved-road-release.yml`
  prints nothing (`<start>` is the commit you noted). Then run `npm run verify:bootstrap` on its
  own and read what it says, even when `npm run ci` is green. Besides the residual-name scan, it
  checks what the target requires (DECISIONS 2026-10-27, "new-app DB Israel target", item 9), and
  each failure is a real invariant, not a reader problem:
  - **any target:** the target can be read (no invalid marker, no sign of DB Israel delivery
    without one);
  - **`dbisrael`:** the caller is present and accepted, with no legacy caller; every workflow
    passes the enrollment approximation; both wrangler configs name the sentinel account and
    store and no real `CF_ACCOUNT_ID`; no CIAL platform tooling under `tools/`; and central's
    build prerequisites hold (the lockfile from the npm registry with sha512 integrity and no
    links, the `.npmrc`, a 4.x Wrangler at 4.125.0 or later, the migration names, `build:web`,
    `src/index.ts`). A step 3 that restored `.github` from `kit/main` (deleting the caller) or took
    a lockfile entry from another registry shows here;
  - **`cial` with a caller (dual-delivered):** the caller's bytes and the enrollment
    approximation. Restore a caller by hand, never by rerunning the bootstrap (the message says
    how).

  A marker whose value changed, or a caller deleted under a `cial` marker, passes it; only the
  comparison shows them.

## The five traps — each one broke a real fork upgrade (AICOE-461 / AICOE-484)

1. **T1 — `test/helpers/db.ts` TABLES.** `seedDb` truncates its `TABLES` list between tests,
   and the list moves on both sides: the kit adds its own tables (`service_identities`, the
   agent's tables later), and yours are not on it. A whole-file take drops yours — fork tests
   leak rows into each other; keeping your file drops the kit's — the carried tests fail on rows
   they did not write. Merge the two lists, children before parents (FK order).
   The migration-ordinal guard has the same shape: `APPLIED_BEFORE_THE_GUARD` in
   `test/platform/migration-ordinals.test.mjs` lists files your fork applied under a name
   the slug rule rejects, and the kit ships it empty. Merge the kit's hunks around it and
   keep YOUR entries — a whole-file take wipes them and turns the guard red. Never clear
   that red by renaming an applied file: wrangler records migrations by file name, so a
   renamed file runs a second time on the next deploy.
2. **T2 — identity literals in carried files.** `verify:bootstrap` names every carried
   file that still holds the template name. The kit keeps carried files neutral, so only the ten
   whose structure needs the app's own identity hold it, and the bootstrap renamed them: ci.yml's
   deploy names (D1 database, smoke host), the other three CIAL workflows (`deploy-prod.yml`,
   `provision-staging.yml`, `provision-production.yml`), `schema.sql`'s `app_identity` seed,
   `CLAUDE.md`'s title, `test/helpers/http.ts` BASE, the health test's app name, the cron test's
   backup name (`<app>-d1-backup`) and `test/ai/anthropic.test.ts`. Re-localize those at every
   upgrade. Take any other carried file without localizing it: the step 3 rules for app-owned
   files and app sections (`src/ai/uiTargets.ts`, `SENSITIVE_ACTIONS`, your rows in
   `test/auth/permissions.test.ts`) still apply. A missed literal reds CI only after you adopt the
   file. **Never localize `il-paved-road-*`:** the DB Israel release caller's file name, its
   `name:`, its `CialDNB/il-paved-road-deployment` reference and the `IL_PAVEDROAD_*` secret name
   are central's names, not the template's identity (**DB Israel apps**, above).
3. **T3 — keep the golden example registered.** `...notesRoutes` and the
   `...createMetaRoutes(() => allRoutes)` FACTORY call must stay in
   `src/routes/index.ts` — the uniformity tripwire and permission matrix assume them.
4. **T4 — `wrangler.test.jsonc` vars.** The kit tests the diff set carries require `SEAL_KEY` +
   the Entra test vars in the TEST config, and no wrangler config rides the diff set. Add them by
   hand, from the CHANGELOG's manual steps, to every test config your Vitest projects run
   (`wrangler.test*.jsonc`, and `test/runtime/wrangler.test-minimal.jsonc` once you have adopted
   the runtime split); updating only the deploying configs fails the auth/seal suites.
5. **T5 — `package.json`: dropped fork dependencies (the silent one), and kit scripts that
   never arrive.** `package.json` is not in the diff set, so the kit's changes to its `scripts`
   block reach you only by hand: a new gate (`verify:kit-migrations`) and its link in the
   `npm run ci` chain, a renamed or re-flagged script. Diff the block (`git diff HEAD kit/main --
   package.json`), adopt every new `verify:*` / `test:*` script and each new link in `ci`, keep
   yours, and skip the name-noise hunks. **One exception: the runtime split's `test:node`,
   `test:workers` and `test:workers:minimal`** arrive only when you adopt the split ("When
   adopting the split", above): without `test/projects.mjs` there is no project of those names,
   and each exits with "No projects matched the filter". A gate the kit wires into ci.yml as a plain
   `node scripts/…` step still runs in CI without it; your local `npm run ci` does not.
   The reverse is the silent one: a wholesale `package.json` adopt
   drops every dependency your app added on top of the kit's. Before finalizing, diff OLD
   vs NEW dependency **names** (deps + devDeps): any name present before and absent after
   is a fork dep the adopt dropped — restore it. The fresh-install rule in step 5 is what
   makes this failure visible locally instead of on CI (or worse, on main).
   **`overrides` floors are the same trap, and nothing goes red.** A fork raises a floor to
   clear an advisory before the kit does (il-Lingua raised `sharp` to `^0.35.4` while the
   kit was still on `^0.35.0`).
   Taking the kit's `overrides` block and its `package-lock.json` puts the vulnerable
   version back, and `npm ci` stays green: it only checks that the lock satisfies
   `package.json`, and a lower floor with a lower lock satisfies it. So diff OLD vs NEW
   `overrides` too (`git diff HEAD -- package.json` before you commit the adopt shows each
   change as a `-`/`+` pair): an entry present before and absent after was dropped, and a
   floor that went DOWN was lowered. **Before you restore one or keep your floor, check what
   the kit itself had at the kit commit your last upgrade adopted:**
   `git show <last-adopted-kit-ref>:package.json`. Restore or keep only what the kit never
   had, or what you raised above the kit's old value — **never lower a floor your fork
   raised.** Most fork overrides
   came from the kit (`esbuild`, `ws`, `undici`, `sharp`) and are temporary advisory pins, so
   if the kit removed or lowered one itself, that was deliberate: follow its CHANGELOG entry
   and check `npm ls <pkg>` instead of restoring. On `0.x` packages the caret floor is also a
   ceiling (`^0.28.1` means `<0.29.0`), so compare whole ranges, not just the lower bound.
   (A kit floor above yours is the kit clearing an advisory — take it.)
   Then regenerate the lock from the merged `package.json` with `npm install` rather than
   copying the kit's; if the lock still resolves below a floor you kept, the fresh `npm ci`
   in step 5 refuses it (`lock file's <pkg>@<old> does not satisfy …`).
