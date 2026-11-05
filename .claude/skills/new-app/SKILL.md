---
name: new-app
description: Conversational bootstrap for a fresh kit app — ask the deployment target (a standard CIAL app or a DB Israel app), rename the template, connect Linear (ask team + existing project id), then provision CIAL staging and make the first staging deploy, or hand a DB Israel app to the platform for central delivery. Run once, right after "Use this template".
---

# /new-app — turn the template into YOUR app

**Prime directives apply** (CLAUDE.md): paved road only, fail closed, synthetic data
only, green or it doesn't ship. This skill walks the whole bootstrap; don't skip steps.

## 0. The deployment target — ask first

**The question, in these words:**

> Is this a DB Israel application deployed under dbisrael.ai, or a standard CIAL application?

- **No answer, or anything but a clear "DB Israel", means CIAL.**
- **Never infer it:** not from the name (an `il-` prefix included), the GitHub org, the git
  remote, or who the builder is.
- The answer is final for this setup. Changing the target later is a reviewed migration, not a
  rerun of this skill.

**On the template** (`wrangler.jsonc`'s `name` is still the template's), ask it now, before
anything else.

**On a tree that is already renamed** (the plugin's `pave` ran the bootstrap, or a setup was
interrupted), run `npm run -s deployment-target` first:
- **It exits 1:** stop. The marker is invalid, or missing beside a sign of a DB Israel app, and the
  target is the owner's decision.
- **It prints `dbisrael`,** or `cial` with a `.paved-road/deployment.json` marker: the target is
  set. Don't ask.
- **It prints `cial`, there is no marker, and the tree is fresh from the bootstrap:**
  `docs/RESOURCES.md` still starts with the bootstrap's `NOT YET GENERATED` stamp, and the D1 and
  KV ids in both `wrangler.jsonc` and `wrangler.staging.jsonc` are still
  `PLACEHOLDER_RUN_PROVISION`. Then the bootstrap ran as CIAL, either because the owner chose CIAL
  or because an older `pave` (plugin 1.6.0 and before) never asked. If the question was asked and
  answered earlier in this setup (the current `pave` asks it), keep that answer and don't ask
  again. Otherwise ask it once, now. On a clear "DB Israel", run
  `node scripts/new-app.mjs <name> --target dbisrael` with the app's own name: it converts the
  tree, and the result is the same app a fresh DB Israel bootstrap makes. The bootstrap refuses
  the conversion once anything is provisioned, in the working tree or in the git history; say so,
  and treat the app as CIAL. If it refuses because the clone is shallow, run
  `git fetch --unshallow` and run it again. Then carry on with step 1 for that target.
- **It prints `cial` and anything is provisioned** (a real id in a wrangler config, a regenerated
  `docs/RESOURCES.md`): the app is CIAL. Don't ask.

## 1. Name the app

Ask the builder:
- **App name** (kebab-case). It becomes:
  - **CIAL:** `<name>.cialdnb.ai`, staging `staging-<name>.cialdnb.ai`, `<name>-db`,
    `CialDNB/<name>`… 3–40 chars; validate with the rules in `src/platform/naming.ts`.
  - **DB Israel:** staging `<name>.staging.dbisrael.ai`, the central catalog app name, `APP_NAME`
    and the `app_identity` row, `CialDNB/<name>`… 3–32 chars (central's rule,
    `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`), and the `naming.ts` rules too.
- **Display name** (what users see, e.g. "Arena Go").
- One sentence: what does this app do, and does it touch any real person/client data?
  (If yes, note it now — it drives the data-classification gate at go-live.)

Then run, with the target from step 0:
`node scripts/new-app.mjs <name> --display "<Display Name>" --target <cial|dbisrael>`
and show the diff summary. An unknown flag, a missing value or a bad target exits 1 and changes
nothing; fix the command, never drop `--target`.

**Branch first — the bootstrap rides a PR like every other change.** A fresh clone leaves you
on `main`, and the `guard-bash` hook blocks commits on `main` by design, so create a branch
*before* committing:
```sh
git switch -c chore/bootstrap-<name>
git add -A && git commit -m "chore: bootstrap <name> from paved-road template"
```
Then open it as a PR (`/ship` walks the gates). Don't try to commit on `main` — the hook refuses it.

That script also tags the GitHub repo with the `paved-road` topic (best-effort) so every
kit app is discoverable org-wide via `topic:paved-road` (search: `org:CialDNB topic:paved-road`).
If it prints `skip: could not tag repo topic`, run `gh repo edit --add-topic paved-road` once
`gh` is authed against the new repo.

## 2. Connect Linear (always ask — never assume)

Ask BOTH questions:
1. **Which Linear team should this app's project live in?** (Suggest the builder's own
   team; HQ is the fallback for cross-functional tools.)
2. **Is there an existing Linear project to link instead of creating one?** (Accept a
   project URL or ID.)

**If the builder has no Linear account** (so they can't own a project): default the
project to the **AI Center of Excellence** team (`afba88bb-7df0-4fc0-b65f-e38e5b6f677e`),
created/led by **Shai Lelchuk** (`shail@trustedpartners.com`) as the standing proxy owner —
every app stays tracked even without a builder seat (DECISIONS 2026-06-13). Note the real
builder by name in the project description.

Then, via the Linear MCP:
- **Existing project** → link it: append a comment with the standing rule (below) and
  the repo URL; do not rename their project.
- **New project** → create `"<Display Name>"` in the chosen team. Description must
  include the repo URL, the staging URL, and the standing rule:

> **Standing rule:** every working session starts by reading this project's state and
> ends with issue updates + a comment on what shipped/changed. Every load-bearing
> decision goes to docs/DECISIONS.md (append-only, newest first).

Record the project URL in `docs/RESOURCES.md` (Linear row) and in the README header. In a DB
Israel app, record it in the README header and the identity block (step 3b): its
`docs/RESOURCES.md` points at the central catalog and has no rows.

**A DB Israel app: go to step 3b now.** Steps 3 and 4's provisioning and deploy are CIAL only.

## 3. Provision staging (the default posture) — in CI, no token on a laptop (CIAL apps)

Staging is opt-OUT, not opt-in. The only legitimate skip: a read-only throwaway tool
touching no real user data, retired within weeks. If skipped, record the reason in
`docs/DECISIONS.md` — it resurfaces on the go-live checklist.

Provisioning and deploys run in **GitHub Actions** with the app's scoped
`CLOUDFLARE_API_TOKEN` held as a repo secret — the builder never mints, holds, or pastes
a Cloudflare token.

1. **Wire the deploy credential — one-time, IT / platform owner.** On the GitHub repo set
   secret `CLOUDFLARE_API_TOKEN` (the per-app scoped token; minting runbook in
   `docs/IMPLEMENTATION-HANDBOOK.md` §8.1) and variable `DEPLOY_ENABLED` = `true`. If the
   builder can't do this, open a Linear issue assigned to the platform owner and pause —
   nothing below works until the secret exists.
2. **Provision via CI.** Run the **Provision staging** workflow (Actions → *Provision
   staging* → Run workflow, or `gh workflow run provision-staging.yml`), passing the
   builder's address as `seed_owner_email` to seed them as the first invite-only owner. It
   creates D1/KV/R2 (the AI gateway is FLEET-SHARED `all-pr-apps` — verified read-only,
   never created per-app; if provision ever reports it MISSING, the platform owner creates
   it via the bruno collection's request 03), applies `schema.sql`, and uploads the filled
   `wrangler.staging.jsonc` + regenerated `docs/RESOURCES.md` as an artifact.
3. **Commit the real ids.** Download that artifact and commit the filled
   `wrangler.staging.jsonc` + `docs/RESOURCES.md` via a normal PR — the placeholder ids
   become concrete. Before committing, check the artifact's Linear row: CI regenerated the
   manifest from `main`, which may predate what step 2 recorded locally — re-apply the
   project URL if the row shows `_pending_` (provision carries it forward from then on).
4. **Deploy is automatic.** Once those ids + `DEPLOY_ENABLED` are on `main`, the standing
   CI job deploys to `staging-<name>.cialdnb.ai` and smoke-checks `/_health`; confirm it
   returns ok/degraded. Until zone email is configured, an undelivered magic link is parked in
   the staging SESSIONS KV outbox for 15 minutes — but only for an address opted in via the
   `MAGIC_LINK_OUTBOX` secret (`echo "<address>" | npx wrangler secret put MAGIC_LINK_OUTBOX
   --config wrangler.staging.jsonc`), because the parked value is a live login link any KV reader
   on the account could use. Fetch it with `npx wrangler kv key get --binding SESSIONS
   "magic-link-outbox:<address, lowercase>" --remote --config wrangler.staging.jsonc`. It is never
   logged (PIA C5 — kits before the log-hygiene change printed it to `wrangler tail`). Both
   commands need `wrangler login` / Cloudflare access; if the builder has none, the platform owner
   opts them in and pulls their first link. Delete the secret once email works. Point the builder
   at GUIDEBOOK "First login".

## 3b. DB Israel apps: hand the app to the platform

A DB Israel app is built and released by the central DB Israel pipeline. Nobody on the app team
holds a Cloudflare token for it, and every CIAL provision and deploy path refuses it. The
bootstrap printed the identity block, the handoff and the draft registration; it also wrote
`docs/CENTRAL-DELIVERY.md`, which keeps the handoff for later. Walk the builder through them:

1. **Collect the identity block** for the catalog PR, filling in what the bootstrap printed as
   placeholders:
   - the catalog app name: the bootstrap name, which is also `APP_NAME` and the `app_identity` row
     `schema.sql` seeds;
   - the display name;
   - the repository, `CialDNB/<repo>`, and its numeric id once it exists
     (`gh api repos/CialDNB/<repo> --jq .id`), on branch `main`;
   - the first owner's sign-in email, for the operator's `seed-owner`;
   - the data-sensitivity answer from step 1;
   - the Linear project from step 2.

   Keep the email out of the repo: it goes to the platform owner, not into a file.
2. **Push and protect.** Push to `CialDNB/<repo>`, merge the bootstrap PR at once, and protect
   `main` (PR and CI). Until the bootstrap merges, the CIAL jobs skip as `unbootstrapped`.
3. **Walk through the registration proposal** with the builder: run
   `npm run central:proposal -- --repository CialDNB/<repo> --repository-id <id>`. It prints the
   draft `catalog/apps/<name>.json` and writes nothing. Go through each decision in plain
   language and record the owner's answer:
   - **Sign-in:** central sends no mail yet (ILOPS-8950), so it is Microsoft sign-in (Entra): the
     `ENTRA_*` vars, `ENTRA_CLIENT_SECRET` as a required Worker secret, and the redirect URI
     `https://<name>.staging.dbisrael.ai/auth/oidc/callback`;
   - **AI:** off unless the platform approves it (ILOPS-8949);
   - **email alerts:** none until ILOPS-8950;
   - **schedules:** at most 5, the same on every stage;
   - **backups:** the R2 `BACKUPS` bucket, or D1 Time Travel (ILOPS-8891);
   - **optional Worker secrets:** the alert webhook, Turnstile, the registry (a data flow to the
     CIAL fleet registry, ILOPS-8968);
   - **what is dropped:** placement, routes, Secrets Store bindings and `send_email`;
   - **ingress and health:** `waf-restricted` with `fail` is the default; a `public` app uses
     `accept` until its first daily run;
   - **Workers invocation logs:** central's Worker config does not turn them off (PIA C5): a
     central change or a recorded PIA decision.
4. **Send the platform owner** the identity block and the proposal output with the answers, and
   ask for source access (both GitHub App installations) and the catalog PR. Open a Linear issue
   for it, assigned to the platform owner.
5. **What the platform does next:** onboarding (plan and apply, then the resource receipt) and
   enrollment (the rulesets, the audit of every ref, the secret grant). **Until enrollment, the
   `il-paved-road-release` run on `main` is expected to be red.** Then someone with DB Israel
   Cloudflare access sets each declared runtime secret on the receipt's Worker (every release stops
   until then), and a platform operator runs `seed-owner` with the first owner's email. After that,
   each merge to `main` releases `https://<name>.staging.dbisrael.ai`, and production goes through
   the **Promote to production** link once the platform enables it (`/go-live`).
6. **Don't create:** `CLOUDFLARE_API_TOKEN` or `DEPLOY_ENABLED`; any `IL_PAVEDROAD_*` repository
   secret or variable (a repository secret shadows the organization's); `production/*` tags;
   GitHub environments; a Worker secret the catalog does not declare. Never edit, reformat or
   delete `.github/workflows/il-paved-road-release.yml`, and never touch the deployment marker.

Then step 4, without the provisioning: `/qa` for a DB Israel app needs Entra and the seeded owner.

## 4. Close the loop

- `npm run ci` must be green (run `npm install` first on a fresh clone); commit and push
  everything.
- Update the Linear project with what was done; create issues for anything pending
  (token, email, CI secrets; for a DB Israel app, the catalog PR, enrollment, the runtime
  secrets and `seed-owner`).
- The app starts **incubating** (`APP_MATURITY` in `src/framework/version.ts`) — one owner, zero
  review friction. Two things follow from that (no action now, just know them): go-live needs a
  named **break-glass successor** (a second person with CF-account access — gate 8a), and the app
  **graduates to stable** — second CODEOWNER + branch protection — when a 2nd maintainer joins, it
  handles PII, or it gets real users. See `docs/COLLABORATION.md` → "Maturity lifecycle".
- Tell the builder their three next moves: `/add-page`, `/add-endpoint`, `/qa`.
- **Ported from an existing app?** (Tier 2 `/paved-road:adopt`, or the builder names an
  original.) Then the first move is `/port-ui`, before any `/add-page`. It carries the
  original's design system, shell and screens over, so the app doesn't regress to the kit's
  baseline look. Skipping it takes an explicit "no" from the builder, recorded in
  `docs/DECISIONS.md`.

## 5. Sensitive-Data Protection — present but DORMANT (opt-in)

Every kit app ships the Sensitive-Data Protection capability **scaffolded and off**. Do **not**
arm it during bootstrap — most apps seal nothing, and turning it on blindly is wrong (sealed
columns become unqueryable; a lost key destroys data). Leave it dormant; an app opts a field in
**deliberately**, only when it has a field that is high-sensitivity AND display-only AND never a
query predicate ("payload, never predicate").

What's already in place, inert until used:
- **The seal cipher** (`src/crypto/seal.ts`) — `sealNumber`/`openNumber`, `sealText`/`openText`,
  `sealJson`/`openJson`. No `SEAL_KEY` is provisioned, so nothing is sealed.
- **The control-plane tripwire** (`src/cron/auditWatch.ts`) — the hourly cron is wired but
  **no-ops + audits a skip** until `AUDIT_API_TOKEN` is set (the binding is commented in both
  wrangler configs).

If (and only if) the app needs it, point the builder at:
- `docs/sensitive-data-doctrine.md` — the decision rule + the required decrypt-past-the-gate
  pattern (read this BEFORE sealing anything).
- `docs/runbooks/sensitive-data-key.md` — generate-and-vault-first the key (`node
  scripts/seal-key.mjs --print`), backup + rotation.
- `docs/runbooks/control-plane-tripwire.md` — arming the tripwire + the in-account-vs-GitHub-Actions
  hosting choice.
- The preventive lock (least-privilege deploy + branch protection) is **proposed** as a GO-LIVE
  gate in Phase 3 — specced, NOT yet landed; see `docs/sensitive-data-capability-PLAN.md`. The
  closest control live today is `docs/GO-LIVE.md` gate 8a, which requires branch protection to
  graduate an app to Stable.
