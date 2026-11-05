# Go-Live Checklist

Production = a DNS record on `cialdnb.ai` + a manual deploy. Neither exists until this
checklist passes and the **go-live owner signs off**. `/go-live` walks it and collects
evidence; humans execute the launch.

**Go-live owner:** Yoni Cohen (yoni.cohen@cialdnb.com) — delegation is a one-line
change here, by design.

## Blocking gates (all must pass, with evidence)

| # | Gate | Evidence |
| --- | --- | --- |
| 1 | `/security-review` run on the full app; blockers resolved | review report in Linear |
| 2 | **Data classification** written: data classes held; PII named or "none"; synthetic-data rule verified in seeds/fixtures/demos. **If the app holds real client/customer data, it must run in its OWN dedicated Cloudflare account (not the shared account)** — see DECISIONS 2026-06-23 / SECURITY-EDGE "Account isolation" (a future kit capability; until built, treat client-data apps as blocked from the shared account). | note in Linear + DECISIONS.md if PII |
| 3 | **Privacy Impact Assessment** prepared and stored in Linear — or, if the app holds no personal data, a recorded "PIA not required" justification (one line, tied to gate 2's classification) | PIA doc / justification linked in Linear |
| 4 | Auth verified: allowlist populated; fail-closed spot-check (anon → 401; under-privileged role → uniform 404) | command output |
| 5 | Backups observed: ≥1 `db-backups/*.jsonl.gz` in R2; `/_health` shows `last_backup_seen` (note: the post-deploy smoke check passes on `ok` **or** `degraded`, and a brand-new deploy reads `degraded` until the first backup + cron heartbeat — so this gate, not the smoke check, is what proves backups work) | object listing + health JSON |
| 5a | **Restore rehearsed:** the `restore_verify` cron has run green at least once — a backup being present (gate 5) is not proof it's *restorable*. Evidence: the `cron_heartbeat_done` audit payload shows a green `restore_verify` (a fresh `/_health` heartbeat only *corroborates* that the loop ran — it does not surface the per-task `restore_verify` result, and a failed verify pages separately rather than showing in the health JSON), **or** run it once (invoke the scheduled loop / trigger the cron) and confirm the green result. | `cron_heartbeat_done` payload showing `restore_verify` ok, or run output |
| 6 | AI budget gates **set** (if app calls AI): vars present; one refusal observed in test | test output |
| 7 | `docs/RESOURCES.md` current (`npm run provision -- --plan` regenerates) | file in repo |
| 8 | Named owner (a person, not a team) recorded below | this file updated |
| 8a | **Maturity mode + continuity** (`docs/COLLABORATION.md` → "Maturity lifecycle"): `APP_MATURITY` matches the app's reality. **Incubating** → a named **break-glass successor** (a second person with access to the CF account + `CLOUDFLARE_API_TOKEN`) is recorded below. **Stable** (2+ maintainers / PII / sustained users / post-handoff) → the graduation checklist is done: 2nd CODEOWNER, branch protection ON, 2nd `ALERT_EMAIL`. | successor named below (incubating), or the graduation checklist evidenced (stable) |
| 9 | Rollback documented: previous-version redeploy command verified readable | runbook line below |
| 10 | Linear project linked & current; CHANGELOG entry for launch | links |
| 11 | **Edge controls live** (docs/SECURITY-EDGE.md): `workers.dev`/preview disabled; zone WAF managed rules + `/auth/*` rate-limit (+ Host-pin on a dedicated zone) active; Turnstile enabled on login **or** a DECISIONS note on why it isn't needed for this app (it ships wired-but-disabled — SECURITY-EDGE treats it as per-app). Now MACHINE-CHECKED and continuously: `npm run verify:edge:live -- --env production` green (the `-- ` separator is required — without it npm eats `--env` and the check defaults to staging), and the daily `edge-live` Action stays green (it re-verifies between deploys, so this gate no longer decays the day after go-live). | `verify:edge:live` output (green) + the scheduled `edge-live` Action is enabled/green; login shows the widget (or the DECISIONS note) |
| 12 | **Login email delivered end-to-end** (if the app uses magic-link login): a real magic link was *received in an inbox* from the production sender — not merely "no error". Until zone email is onboarded, production login silently no-ops (the transport fails open and prod does not log the link), so this is a hard gate. | screenshot of the received email + `wrangler tail` showing `email_outcome: sent` |
| 13 | **Machine routes enforced and watched** (if any route is `machine: true` — `GET /api/meta/manifest` lists `routes[].machine`; otherwise record "no machine routes"): production does **not** set `MACHINE_SYNC_RUN=warn` (the adoption mode lets a batch without a valid `X-Sync-Run` through as `runId: null`, so its audit row loses the run trace DECISIONS 2026-09-24 / D13 relies on, and audit_log cannot be corrected later), and **does** set `MACHINE_LIVENESS_ARMED=true` (unarmed, an integration that never delivered a batch reads `never` in a green `machine_liveness` detail forever). See docs/API-CONVENTIONS.md → Machine routes. | the newest production `cron_heartbeat_done` payload: its `machine_liveness` detail contains `, armed)` and does not contain `sync-run warn-only` — the settings close the detail's parenthetical, so this holds whether it reads `clear` or `stale` (the gate checks the two settings, not that a batch has arrived); plus the production `vars` in `wrangler.jsonc` |

## Advisory (should-fix, non-blocking)

- Staging exercised via `/qa` (recommended for any app with a UI) — or skip-rubric reason recorded in DECISIONS.md (read-only throwaway, no real user data)
- AI budget-gate **tuning**: the caps are right for expected load (gate 6 only requires they're set)
- Docs current (README/GUIDEBOOK pointers, ARCHITECTURE delta if any)
- Uptime alert destination confirmed receiving (send a test alert)
- Error-tail walkthrough done (`wrangler tail <app>` shows clean traffic)
- Load sanity: any endpoint that could be hot has pagination + limits

## Launch steps (after sign-off) — in CI, never on a laptop

The scoped token lives only as the GitHub repo secret, so the launch runs entirely
through Actions (each step maps to a workflow below). The raw commands are a break-glass
reference only — running them needs the token locally, which the model avoids:

```bash
# ⚠ BREAK-GLASS REFERENCE ONLY — do NOT run these on a laptop. Use the CI workflows below;
# running them locally needs the scoped production token, which must never live on a laptop.
node scripts/provision.mjs --env production   # creates <app>-db, <app>-sessions, <app>-backups
npm run db:apply                              # schema to production D1
npm run deploy                                # creates <app>.cialdnb.ai custom domain
bash scripts/smoke-health.sh https://<app>.cialdnb.ai/_health
```

Every step above can run in CI instead of on a laptop, so the scoped token is never
touched locally:

- `provision` + `db:apply` (and an optional first-owner seed) → the **Provision
  production** workflow (Actions → *Provision production* → Run workflow, or `gh workflow
  run provision-production.yml`). It provisions, applies the schema, and uploads the
  filled `wrangler.jsonc` + regenerated `docs/RESOURCES.md` as an artifact — commit those
  via a normal PR (keeps gate 7 current); it does not deploy or commit.
- `npm run deploy` + the smoke check → the **Deploy production** workflow (Actions →
  *Deploy production* → Run workflow, or `gh workflow run deploy-prod.yml`) — the same
  sequence, in CI.

Both jobs use `environment: production`; add the go-live owner as a required reviewer on
that environment to gate every run (provision and deploy) on this sign-off.

Then: log in, verify the audit tab recorded your login, confirm the first cron
heartbeat within 26h, and comment "live" in the Linear project.

## Rollback

`npx wrangler rollback --name <app>` (or redeploy the previous git tag:
`git checkout <tag> && npm run deploy`). D1 restore: load the wanted
`db-backups/YYYY-MM-DD.jsonl.gz` per the handbook's restore runbook.

## DB Israel apps

A DB Israel app (`node scripts/deployment-target.mjs` prints `dbisrael`) reaches production
through the central DB Israel pipeline (`CialDNB/il-paved-road-deployment`), never through this
repo. The **Provision production** and **Deploy production** workflows, and `npm run provision`,
`db:apply` and `deploy`, refuse it. The blocking gates above still apply and the go-live owner
still signs off; what changes is how some gates are evidenced, and how the launch and a rollback
run.

**Production is enabled only after sign-off.** From the moment the catalog enables production,
every successful staging summary links to **Promote to production**, and any collaborator with
Write, Maintain or Admin can use it: in central's model, repository write access is production
release authority. So before sign-off nothing enables production. The go-live report lists what
the platform will do: the catalog PR that enables production with its hostname and variables
(open, not merged), the runtime secret names production needs, the enrollment as the operator
last checked it, and the repository's Write, Maintain and Admin collaborators, who can all
release to production from then on.

| Gate | For a DB Israel app |
| --- | --- |
| 2 | Central runs every DB Israel app in one shared DB Israel Cloudflare account, with deployment credentials that reach the whole fleet, so no app has an account of its own. An app with real client or customer data records that gap for the go-live owner; "not the shared account" never means "not the CIAL account". |
| 5, 5a | **Pending ILOPS-8891.** Central has no backup or restore of its own yet, and the first promotion is accepted under that issue. Record both gates as pending, with the issue link, never as passed. |
| 7 | The resource record is the app's central catalog entry and receipts (`catalog/apps/<app>.json`, `infrastructure/receipts/<app>/`), not `npm run provision -- --plan`. |
| 9 | A rollback runs through central's `operate-app` workflow (`rollback-production`), which only platform operators can run. Record "ask the platform operator". It redeploys code and assets only, never D1 data. |
| 13 | Production's vars are the catalog's `stages.production.vars`; central ignores `wrangler.jsonc`, so its values prove nothing. Before sign-off there is no production Worker or database, so the evidence is the two settings in the open catalog PR's `stages.production.vars`: `MACHINE_SYNC_RUN` is not `warn`, and `MACHINE_LIVENESS_ARMED` is `true`. A production `daily-evidence` run confirms them after the launch (below). |
| 8a, 11, 12 | Each names a CIAL mechanism that a DB Israel app does not have: the `CLOUDFLARE_API_TOKEN` and a second `ALERT_EMAIL` (central sends no email until ILOPS-8950), `verify:edge:live` and the `edge-live` Action, magic-link email. Record what the platform provides instead, or the gap, for the go-live owner to decide. |

**The rule for every gate:** where the evidence names a CIAL mechanism (a wrangler config value,
a `wrangler` command against the remote account, the CIAL token, CIAL email), record what the
platform provides instead, or the gap. Never mark a gate passed on CIAL evidence.

**Launch, after sign-off: the platform enables production, then the Promote to production link.** A
platform operator merges the catalog PR, runs `onboard-app` `apply` for production and merges its
receipt PR, and someone with DB Israel Cloudflare access sets every declared runtime secret on the
production Worker (staging values do not count). A staging summary written before that has no link,
so make a new staging release or ask the operator for a redeploy. The new summary carries it, in the
app's `il-paved-road-release` run and in the central run. A collaborator with Write, Maintain or
Admin opens the link, leaves the tag `production/<release-id>` and its target unchanged, and
publishes the release. That creates a protected tag, which can never be moved or deleted. The tag
starts the app's release run, and that run's result, not the release page, shows whether production
deployed. Use the link rather than making a tag by hand. Then, from an approved access path (the
central hostnames are WAF-restricted, and a WAF block page says nothing about the app), verify
`/_health` on the production hostname the catalog approved, and log in with Microsoft.

**After the launch: the first heartbeat, from a production `daily-evidence` run.** The app has no
D1 access of its own, so a platform operator dispatches one after the first daily run that follows
the launch, and within 26 hours of that run. The daily run is the catalog schedule that holds
`DAILY_OPS_CRON` (03:00 UTC unless the app moved it), so it comes within 24 hours of the launch.
Before it there is no heartbeat, and the run ends red with verdict `none` ("no daily run
recorded"). That is not a failed check: wait for the daily run and dispatch again. It succeeds
only when the latest daily run finished within 26 hours with every expected task ok. For an app
with machine routes it also confirms gate 13: the `machine_liveness` detail contains `, armed)`
and does not contain `sync-run warn-only`. It shows each task's detail cut at 200 characters, so
ask the operator for the whole row if the settings are cut off; a run that disagrees with the
catalog PR's settings goes to the go-live owner, and the fix is a catalog PR. Any other verdict
after the daily run (`failed`, `stale` or `invalid`) fails the first-heartbeat check, and its
reason goes to the go-live owner. Then comment "live" in the Linear project.

## App-specific record (fill at go-live)

- **App owner (accountable):** _name, email_ — also the go-live sign-off owner named above
- **Maturity mode:** _incubating | stable_ — matches `APP_MATURITY` (`src/framework/version.ts`)
- **Break-glass successor (incubating):** _name, email_ — second person with CF account + token access (gate 8a)
- **Maintainers (build access):** _list, or "solo"_ — see [COLLABORATION.md](COLLABORATION.md)
- **Branch-protection posture:** _convention-only (default) | protected (2+ maintainers)_
- **Went live:** _date, version_
- **Data classification:** _link_
- **Skips/notes:** _any gate skipped per rubric, with the DECISIONS.md link_

Ownership changing hands later? Follow the handoff runbook in
[COLLABORATION.md](COLLABORATION.md) — repoint CODEOWNERS, move this owner + `ALERT_EMAIL`,
rotate the scoped token, and record it.
