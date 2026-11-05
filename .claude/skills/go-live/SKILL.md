---
name: go-live
description: Walk the gated production checklist (docs/GO-LIVE.md) — verify every blocking gate with evidence, record skips, and stop at sign-off. Production DNS + deploy happen only after the named owner approves.
---

# /go-live — the gate between staging and a production DNS record

This skill VERIFIES; it does not deploy. Production deploys and the production custom
domain happen after sign-off by the go-live owner (see docs/GO-LIVE.md — currently the
platform owner), executed by a human.

**Deployment target first.** Run `node scripts/deployment-target.mjs` (or
`npm run -s deployment-target`, where `package.json` has it). It prints the app's target:
- `cial`: the steps below, as written. An app with no `scripts/deployment-target.mjs` predates
  the targets and is CIAL too.
- `dbisrael`: a DB Israel app, which the central pipeline takes to production. Walk the steps
  with the changes in **DB Israel apps** below.
- It exits 1: stop. The deployment marker is invalid, or missing in an app that shows a sign of
  DB Israel delivery. Which target the app has is the owner's decision, made in a reviewed PR;
  never write the marker yourself to get past it.

## Steps

1. Open `docs/GO-LIVE.md` and walk every item IN ORDER, collecting evidence (command
   output, URLs, audit rows) — not assertions. Blocking items that fail stop here.
2. The classic blockers, verified live:
   - `/security-review` run on the full app; blockers resolved.
   - Data classification written: what data classes the app holds, PII named or
     "none"; synthetic-data rule verified across seeds/fixtures/demos.
   - **Privacy Impact Assessment** prepared and stored in Linear — or, if the app holds
     no personal data, a one-line "PIA not required" justification recorded in Linear
     (tied to the data classification above).
   - Auth: invite-only allowlist populated with real users; fail-closed spot-check
     (logged-out API call → 401; viewer → uniform 404 on a privileged resource).
   - Backups: at least one `db-backups/YYYY-MM-DD.jsonl.gz` object observed in R2,
     and /_health shows `last_backup_seen`.
   - Budget gates set if the app uses AI (vars present, test refusal observed).
   - `docs/RESOURCES.md` current (regenerate via `npm run provision -- --plan`).
   - Named owner + rollback documented (the previous-deploy rollback command).
   - Linear project linked and current; docs current.
   - Machine routes (GO-LIVE gate 13), if the manifest lists any `routes[].machine: true`:
     `MACHINE_SYNC_RUN` is not `warn` in production and `MACHINE_LIVENESS_ARMED=true`. Evidence:
     the newest production `cron_heartbeat_done` payload's `machine_liveness` detail contains
     `, armed)` and does not contain `sync-run warn-only`, whether it reads `clear` or `stale`
     (the item checks the two settings, not that a batch has arrived: an app that goes live
     before its integration's first production batch reads stale, and passes). A fork's own
     `docs/GO-LIVE.md` is not carried by `/kit-upgrade`, so check this item even where that file
     lacks the row.
3. Produce the go-live report in the Linear project: every gate → evidence → pass/fail,
   plus the explicit ask for sign-off, assigned to the go-live owner.
4. **Stop.** After human sign-off, the launch runs in CI so the scoped token is never
   touched locally: the **Provision production** workflow (provision + `db:apply` +
   optional first-owner seed; commit the artifact's ids via PR), then the **Deploy
   production** workflow (`npm run deploy` + smoke check). Both use `environment:
   production`, so the go-live owner approves each as a required reviewer. (Equivalent
   manual fallback: `node scripts/provision.mjs --env production`, `npm run db:apply`,
   `npm run deploy`.) Then verify `https://<app>.cialdnb.ai/_health` and smoke-log in.
5. Post-launch: confirm the first production cron ran (heartbeat within 26h), alerting
   destination verified, and the Linear project gets its "live" comment.
6. **Announce it.** Go-live is the canonical milestone — run `/release-notes` to produce
   the launch deck (publishes to docshub if connected, else a self-contained HTML deck in
   `docs/release-notes/`) and, if the app will keep evolving, set up the opt-in weekly run.

## DB Israel apps

The central DB Israel pipeline takes the app to production, and this repo's CIAL paths refuse
it: the **Provision production** and **Deploy production** workflows, and `npm run provision`,
`db:apply` and `deploy`, all exit 1 in a DB Israel app. Step 1 still walks every gate;
docs/GO-LIVE.md, "DB Israel apps", says which evidence changes (a fork's copy may lack that
section, so the gates are named here too). These replace the CIAL parts of steps 2, 4 and 5.

**The gates (step 2):**

- **Gate 2: there is no account of the app's own.** Central runs every DB Israel app in one
  shared DB Israel Cloudflare account, with deployment credentials that reach the whole fleet. For
  an app with real client or customer data, record that gap for the go-live owner; "not the
  shared account" never means "not the CIAL account".
- **Backups (gates 5 and 5a) are pending ILOPS-8891.** Central has no backup or restore of its own
  yet, and the first promotion is accepted under that issue. Record both gates as pending, with
  the issue link, never as passed.
- **Rollback (gate 9) and the other operator actions** (a manual staging deploy or redeploy, and
  `rollback-production`) run through central's `operate-app` workflow, which only platform
  operators can run. The go-live record says "ask the platform operator", not a command. A
  rollback redeploys code and assets only, never D1 data.
- **Gate 13: the open catalog PR's settings.** Production's vars are the catalog's
  `stages.production.vars`; central ignores `wrangler.jsonc`, so its values prove nothing.
  Production is enabled only after sign-off, so before it there is no production Worker,
  database or heartbeat to read. The evidence is the two settings in the open catalog PR's
  `stages.production.vars`: `MACHINE_SYNC_RUN` is not `warn`, and `MACHINE_LIVENESS_ARMED` is
  `true`. A production `daily-evidence` run confirms them after the launch (step 5, below).
- **Any other gate whose evidence names a CIAL mechanism** (8a's `CLOUDFLARE_API_TOKEN` and second
  `ALERT_EMAIL`, 11's `verify:edge:live` and `edge-live`, 12's magic-link email, any `wrangler`
  command against the remote account): record what the platform provides instead, or the gap,
  for the go-live owner. Never pass one on CIAL evidence.

**The launch (step 4):**

- **Production is enabled only after sign-off.** From the moment the catalog enables production,
  every successful staging summary links to **Promote to production**, and any collaborator with
  Write, Maintain or Admin can use it: in central's model, repository write access is production
  release authority. So before sign-off, nothing is provisioned from here and nothing enables
  production. The go-live report lists what the platform will do instead: the catalog PR that
  enables production with its hostname and variables (open, not merged), the runtime secret
  names production needs, the enrollment as the operator last checked it, and the repository's
  Write, Maintain and Admin collaborators, who can all release to production from then on.
- **After sign-off, the platform enables production.** A platform operator merges the catalog PR,
  runs `onboard-app` `apply` for production and merges its receipt PR, and someone with DB Israel
  Cloudflare access sets every declared runtime secret on the production Worker (staging values
  do not count). A staging summary written before that has no link: make a new staging release,
  or ask the operator for a redeploy.
- **Then production goes through the Promote to production link,** which the summary of each
  successful staging release now carries: the app's `il-paved-road-release` run and the central
  run both show it. A collaborator with Write, Maintain or Admin opens the link, leaves the tag
  `production/<release-id>` and its target unchanged, and publishes the release. That creates a
  protected tag, which can never be moved or deleted. The tag starts the app's release run, and
  that run's result, not the release page, shows whether production deployed. Use the link
  rather than making a tag by hand.
- **Then verify `/_health` on the production hostname the catalog approved,** and smoke-log in
  with Microsoft, from an approved access path: the central hostnames are WAF-restricted. A WAF
  block page says nothing about the app; record it as blocked (network), never as a result.

**After the launch (step 5):**

- **The first heartbeat, and gate 13's settings, come from a production `daily-evidence` run.**
  The app has no D1 access of its own, so ask a platform operator to dispatch one after the
  first daily run that follows the launch, and within 26 hours of that run. The daily run is the
  catalog schedule that holds `DAILY_OPS_CRON` (03:00 UTC unless the app moved it), so it comes
  within 24 hours of the launch. Before it there is no heartbeat, and the run ends red with
  verdict `none` ("no daily run recorded"): that is not a failed check, so wait for the daily
  run and dispatch again. It succeeds only when the latest daily run finished within 26 hours
  with every expected task ok. For an app with machine routes, its `machine_liveness` detail
  contains `, armed)` and does not contain `sync-run warn-only`. It shows each task's detail cut
  at 200 characters; if the settings are cut off, ask the operator for the whole row. If it
  disagrees with the catalog PR's settings, tell the go-live owner: the fix is a catalog PR. Any
  other verdict after the daily run (`failed`, `stale` or `invalid`) fails the first-heartbeat
  check: record its reason for the go-live owner.
- **The alerting destination is not `ALERT_EMAIL`.** It is a catalog var, and central sends no
  email until ILOPS-8950 enables the stage's catalog `email` block for alerts; until then a
  failure alert reaches the Worker's logs only. Verify a Slack channel instead (an admin sets its
  webhook in the app's settings, or the catalog declares an optional `ALERT_WEBHOOK_URL` Worker
  secret) by posting a test message to that webhook, or record the gap for the go-live owner.
