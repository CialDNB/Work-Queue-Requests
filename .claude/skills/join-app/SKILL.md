---
name: join-app
description: Onboard to an existing paved-road app you didn't bootstrap — clone, run the CI health check, read the Linear project + decisions + resources, get invited with a role, and claim a first issue. Includes a take-over mode for inheriting ownership. Use when a new person picks up, joins, or takes over an app.
---

# /join-app — pick up an app someone else built

**Prime directives apply** (CLAUDE.md): paved road only, fail closed, synthetic data only,
green or it doesn't ship. This is the counterpart to `/new-app`: that one *creates* an app;
this one gets *you* productive on one that already exists. The full model is
`docs/COLLABORATION.md` — this skill walks the steps; don't skip them.

**Deployment target first.** Once you have cloned the app (step 1), run
`node scripts/deployment-target.mjs` (or `npm run -s deployment-target`, where `package.json` has
it). It prints the app's target:
- `cial`: the steps below, as written. An app with no `scripts/deployment-target.mjs` predates
  the targets and is CIAL too.
- `dbisrael`: a DB Israel app, delivered centrally. Follow the steps with the changes in
  **DB Israel apps** below.
- It exits 1: stop and tell the owner. The deployment marker is invalid, or missing in an app
  that shows a sign of DB Israel delivery. Which target the app has is the owner's decision, made
  in a reviewed PR; never write the marker yourself to get past it.

## 1. Get oriented (your environment, green)

Clone and install, then prove your machine matches the kit:
```sh
gh repo clone CialDNB/<app> && cd <app>
npm install
npm run db:apply:local   # one-time: local D1 schema (needed before `npm run dev`)
npm run ci               # green proves your setup; red is your first task
```
If `npm run ci` is red on a fresh clone, that's an environment or broken-main problem — fix it
(or flag the owner) before writing anything. Don't build on a red baseline.

**Not using Claude Code?** If you build in Cursor / VS Code / plain git, also run
`npm run hooks:install` (your editor-agnostic guard against committing to `main` — Claude Code's
own hook won't be protecting you), install the biome editor extension, and read
`docs/PLAYBOOKS.md` (the skills are runbooks there, not slash-commands). The owner should turn on
at least the **minimal** branch-protection ruleset (PR + CI, 0 approvals) — see
`docs/COLLABORATION.md` → "Using Cursor / VS Code / plain git".

## 2. Read the state, not just the code

Start where the standing rule points — the **Linear project** — then the docs that explain *why*:
- **Linear** — open the project (link in `docs/RESOURCES.md` / README); read In Progress + recent
  Done to see what's live, in flight, and planned. (Standing rule: every session starts here.)
- **`docs/DECISIONS.md`** — the load-bearing choices and their rejected alternatives; read top-down.
- **`docs/RESOURCES.md`** — what's provisioned (Cloudflare, DNS, secrets, Linear).
- **GUIDEBOOK.md + CLAUDE.md** — the working agreement and the plain-language tour.
- **Golden examples** — `src/routes/notes.ts` (+ its test) and the matching page in `web/` are the
  pattern every feature copies.

## 3. Get access (build access and app access are two separate grants)

- **In the app:** ask the current owner/admin to invite you (Users tab) with the role you need —
  **admin** to exercise admin screens, **member** for ordinary use, **viewer** for read-only (role
  matrix in `docs/COLLABORATION.md`). You don't need a Cloudflare token to build — provisioning and
  deploys run in CI.
- **In the repo:** the owner adds you as a GitHub collaborator. **If you're the second person on the
  app**, this is the **graduation trigger** (`docs/COLLABORATION.md` → "Maturity lifecycle"): the app
  moves incubating → **stable**. Run the graduation checklist — repoint/extend `.github/CODEOWNERS` to
  the real owners (list two — that closes the bus-factor), turn on branch protection (require PR + CI +
  1 review + Code Owner on protected paths), add a second `ALERT_EMAIL` recipient, and **flip
  `APP_MATURITY` to `'stable'`** in `src/framework/version.ts`. Record the mode in
  `docs/COLLABORATION.md` ("This app") + `docs/GO-LIVE.md`.

## 4. Make your first change

Claim a Linear issue (move it to In Progress), branch from fresh main
(`git fetch origin && git switch -c <type>/<slug> origin/main`), build with the skills
(`/add-endpoint`, `/add-page`), and `/ship`. Your first PR is your handshake with the gates —
expect a real review from another maintainer.

## Take-over mode (you're inheriting ownership, not just joining)

If you're becoming the **accountable owner** (the previous owner is leaving, or the app is moving
teams), transfer the baton explicitly — the full runbook is `docs/COLLABORATION.md` § "Taking over".
In order:
1. **App roles** — promote yourself to **owner** in the Users tab, *then* demote/remove the outgoing
   owner (the framework blocks removing the last owner, so promote first); verify in the audit log.
2. **CODEOWNERS** — repoint `.github/CODEOWNERS` to you (list two if you can).
3. **Go-live owner + alerts** — update the owner line + record block in `docs/GO-LIVE.md` and
   `ALERT_EMAIL`, so failure alerts reach you.
4. **Cloudflare token** — rotate the scoped `CLOUDFLARE_API_TOKEN` (mint new → update repo secret →
   revoke old; handbook §8.1). A handoff is a credential event.
5. **Linear** — reassign the project lead, add yourself, comment the handoff.
6. **Record it** — a `docs/DECISIONS.md` entry (who → who, when, what rotated); run `/release-notes`
   if it's a milestone.

## DB Israel apps

The steps are the same, except where they name the CIAL pipeline:

- **Step 2: the resource record is central.** The app's catalog entry and receipts
  (`catalog/apps/<app>.json` and `infrastructure/receipts/<app>/` in
  `CialDNB/il-paved-road-deployment`) say what the app may use and what exists;
  `docs/RESOURCES.md` does not. Ask the platform operator if you cannot read them.
- **Step 3: no Cloudflare access to build.** The central pipeline builds and releases the app,
  and no Cloudflare token exists for it. A new app's first owner is seeded by a platform operator
  (central `seed-owner`); everyone else is invited in the app, as above.
- **Step 3's graduation checklist and take-over step 3: `ALERT_EMAIL` sends nothing yet.** It is a
  catalog var (central ignores `wrangler.jsonc`), and central sends no email until ILOPS-8950
  enables the stage's catalog `email` block for alerts; until then a failure alert reaches the
  Worker's logs only. So editing it reaches nobody. Record the gap in the handoff, or route alerts
  to a Slack channel: an admin sets its webhook in the app's settings, or the catalog declares an
  optional `ALERT_WEBHOOK_URL` Worker secret (docs/SECRETS.md, "DB Israel apps"). Never record
  that failure alerts reach you because a config file names you.
- **Take-over step 4: there is no `CLOUDFLARE_API_TOKEN` to rotate.** A DB Israel app holds none;
  never create one, and its `deployment-target` guard goes red if one appears. If the handoff
  calls for rotating a runtime secret the app uses (an API key, the Entra client secret), the
  value lives on the app's central Worker: ask the platform operator who can set it.

## Close the loop

Update the Linear project — comment what you set up or took over, and what you're picking up next.
From here you're a normal contributor: branch, PR, `/ship`, and keep `docs/COLLABORATION.md` handy
for the parallel-work covenant.
