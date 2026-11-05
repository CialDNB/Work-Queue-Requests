# August 2026 — the private-data wave — the complete change list (2026-08-04 → 2026-08-26)

Companion to the [docshub deck](https://docshub.cballiance.com/p/KfujySG) — every PR
merged in the window, oldest first. The stakeholder story lives in the deck and in
CHANGELOG.md ("Unreleased" + "0.2.1 — 2026-08-04"); this is the raw list for the
detail-minded.

50 PRs (#137, #161, #162 merged in this window's first hours but are recorded in the
v0.2.0 list, so they are not repeated here):

- [#163](https://github.com/CialDNB/paved-road/pull/163) — docs(release-notes): record the v0.2.0 milestone deck + full PR list
- [#166](https://github.com/CialDNB/paved-road/pull/166) — feat(tools): bruno 07 pushes the app's Anthropic key into the Secrets Store (AICOE-478)
- [#167](https://github.com/CialDNB/paved-road/pull/167) — fix(ci): run the plugin-mirror guard in CI + re-sync add-page
- [#168](https://github.com/CialDNB/paved-road/pull/168) — fix(bootstrap): exempt tools/ from the residual-identifier tripwire
- [#169](https://github.com/CialDNB/paved-road/pull/169) — fix(csp): no-transform stops the zone's bot-JS injection from fighting our CSP
- [#171](https://github.com/CialDNB/paved-road/pull/171) — fix(config): keep the provisioning sentinel out of comments; enforce it in verify:edge (AICOE-480)
- [#172](https://github.com/CialDNB/paved-road/pull/172) — fix(config): restore the CACHE recipe #171 lost, and guard the drift that hid it (AICOE-480)
- [#173](https://github.com/CialDNB/paved-road/pull/173) — chore(release): cut kit 0.2.1 (AICOE-482)
- [#174](https://github.com/CialDNB/paved-road/pull/174) — fix(test): stop the OIDC rate-limit test straddling vitest's 30s timeout (AICOE-483)
- [#175](https://github.com/CialDNB/paved-road/pull/175) — fix(test): bruno-scripts pin self-skips when tools/ is absent (fork-safe)
- [#176](https://github.com/CialDNB/paved-road/pull/176) — feat(tools): bruno cf-provisioning writes per-Worker secrets, not Secrets Store entries
- [#170](https://github.com/CialDNB/paved-road/pull/170) — fix(test): edge-live pins the config mapping, not paved-road's identity (unbreaks every fork)
- [#164](https://github.com/CialDNB/paved-road/pull/164) — feat(secrets): per-app secrets become per-Worker, not account Secrets Store (AICOE-467 KIT-A)
- [#165](https://github.com/CialDNB/paved-road/pull/165) — feat(tools): secrets-migrator — cron-only Secrets Store → per-Worker secret migrator (AICOE-472)
- [#177](https://github.com/CialDNB/paved-road/pull/177) — fix(test): edge-live /auth/config fixture echoes the repo's own Turnstile posture
- [#178](https://github.com/CialDNB/paved-road/pull/178) — fix(ci): plugin-mirror guard glob loses the kit name (fork residual tripwires)
- [#179](https://github.com/CialDNB/paved-road/pull/179) — docs(skill): /kit-upgrade learns the five fork traps + blob provenance from the 0.2.1 wave
- [#181](https://github.com/CialDNB/paved-road/pull/181) — feat(cron): fleet reporting covers staging, not just production
- [#183](https://github.com/CialDNB/paved-road/pull/183) — docs(provision): deploy-token recipe gains Zone WAF:Edit (issue #182)
- [#184](https://github.com/CialDNB/paved-road/pull/184) — feat(provision): fail loudly when zone phases are unreadable (issue #182 hardening)
- [#180](https://github.com/CialDNB/paved-road/pull/180) — docs: teach dynamic workflows as guidance, not a gate; add /plan-to-graph
- [#186](https://github.com/CialDNB/paved-road/pull/186) — fix(scripts): main-module guards failed open through a symlinked path
- [#185](https://github.com/CialDNB/paved-road/pull/185) — refactor(ci): verify:skills — guard the skill files, not the prose about them
- [#187](https://github.com/CialDNB/paved-road/pull/187) — feat(ci): stamp the plugin payload against its version; stop the sync script running on import
- [#192](https://github.com/CialDNB/paved-road/pull/192) — docs: the two-roads boundary rule — paved road vs. Cloudflare OS
- [#189](https://github.com/CialDNB/paved-road/pull/189) — feat(cron): fleet AI-spend tripwire — one scalar on the daily registry report
- [#190](https://github.com/CialDNB/paved-road/pull/190) — feat(framework): a route can declare the repositories it needs; ctx.db narrows to them
- [#191](https://github.com/CialDNB/paved-road/pull/191) — feat(adopt): an adoption manifest generators can write, and a reader that still scans
- [#193](https://github.com/CialDNB/paved-road/pull/193) — feat(ci): reject dependencies published in the last 24h, over every lockfile entry
- [#194](https://github.com/CialDNB/paved-road/pull/194) — feat(ci): verify:core — protected-core reachability gate + size report
- [#195](https://github.com/CialDNB/paved-road/pull/195) — feat(manifest): publish each route's declared repository set, unscoped told apart from empty
- [#196](https://github.com/CialDNB/paved-road/pull/196) — feat(ci): verify:needs — count the routes that still hold the whole data layer (report only)
- [#198](https://github.com/CialDNB/paved-road/pull/198) — docs: land Wave 1's deferred stanzas + mirror the two-roads rule to GUIDEBOOK
- [#199](https://github.com/CialDNB/paved-road/pull/199) — feat(kit): shared checks travel as a stamped directory, reported to the fleet
- [#200](https://github.com/CialDNB/paved-road/pull/200) — feat(manifest): claims.complete — a manifest can say the export is a fragment
- [#201](https://github.com/CialDNB/paved-road/pull/201) — docs(secrets): one canonical page for where each secret lives, plus the migration runbook
- [#204](https://github.com/CialDNB/paved-road/pull/204) — feat(kit): gate private-database bindings behind a reviewed allowlist
- [#205](https://github.com/CialDNB/paved-road/pull/205) — feat(data): the read seam — a client-data read that cannot be recorded does not happen
- [#207](https://github.com/CialDNB/paved-road/pull/207) — feat(kit): report activity + migrations to the fleet registry (K1)
- [#208](https://github.com/CialDNB/paved-road/pull/208) — feat(framework): record ordinary D1 reads in the read ledger (K2b)
- [#209](https://github.com/CialDNB/paved-road/pull/209) — feat(cron): report read-audit arming explicitly in the fleet report (AICOE-571)
- [#210](https://github.com/CialDNB/paved-road/pull/210) — feat(data): openAuroraClient — the one legal way a fork opens a Postgres connection
- [#211](https://github.com/CialDNB/paved-road/pull/211) — fix(cron): declare the governance projection's type by subtraction, at both levels
- [#212](https://github.com/CialDNB/paved-road/pull/212) — fix(framework): one definition of "READ_AUDIT is armed", shared by the runtime and the gate
- [#213](https://github.com/CialDNB/paved-road/pull/213) — fix(semgrep): the secret-value taint fence now covers JavaScript, not only TypeScript
- [#217](https://github.com/CialDNB/paved-road/pull/217) — fix(ci): the binding gate discovers every wrangler config and refuses env-nested and unsafe bindings
- [#214](https://github.com/CialDNB/paved-road/pull/214) — docs(decisions): record the four load-bearing facts about the private-data path
- [#216](https://github.com/CialDNB/paved-road/pull/216) — docs(decisions): separate the semgrep-fence entry from the one below it
- [#215](https://github.com/CialDNB/paved-road/pull/215) — fix(kit): a fork can bind its first database without editing kit tests
- [#218](https://github.com/CialDNB/paved-road/pull/218) — docs(decisions): record the two owner data-path decisions (D1 c360 account, D2 IPA transport)
