# The Paved Road Guidebook

*For anyone at CIAL with an idea for an internal app.*

You have an idea — a tool for your team, a tracker, a dashboard, a little workflow app.
You could build it on whatever platform ad popped up in your feed this week. **Please
don't.** Not because we doubt you can — the builder energy across CIAL is real, and we
want more of it — but because we've already built the boring 80% for you, on
infrastructure the company actually stands behind. We call it the paved road: the right
way is now also the easy way.

## What you get (and what you're spared)

Start from this template and your app is born with:

- **Login that just works.** People sign in with their work email and a magic link —
  no passwords to store, leak, or reset. Only people you invite can get in. You get
  roles (owner / admin / member / viewer) without writing a line of security code.
  Apps can also switch on **Sign in with Microsoft** (Entra SSO for the CIAL D&B,
  D&B Israel, and Trusted Partners directories — see docs/runbooks/entra-sso-setup.md);
  magic links stay for everyone else, and permissions are identical either way.
  *(While the central email sender is being finished, you fetch your own first login link
  from the app's short-lived outbox — see [First login](#first-login) below. No real users are
  blocked by this: production go-live requires email to be live.)*
- **A real database with daily backups.** Every night your data is exported and
  stored safely. Restore is "pick a day".
- **An audit trail.** Every change records who did what, when. When someone asks
  "who deleted that?", you have an answer.
- **A safety net of automated checks.** Every change is tested, linted, and scanned
  for secrets before it can ship. You can't accidentally commit an API key or break
  login on a Friday afternoon.
- **A practice space.** Your app gets a staging copy at `staging-<your-app>.cialdnb.ai`
  that updates automatically — try things there, break things there. Real users only
  ever see what you promote.
- **AI with a budget.** If your app uses Claude, calls are pre-wired through our
  gateway with spending caps ($0.50/call, $5/person/day, $50/app/day) and a privacy
  setting that keeps your content out of logs. A runaway loop can't surprise anyone
  with a bill.
- **A health check and an alarm.** `/_health` says how your app is doing; if the
  nightly jobs fail, the platform owner and you get an email.
- **Claude Code as your team.** The repo teaches Claude how we build: `/add-page`,
  `/add-endpoint`, `/security-review`, `/qa`, `/ship`… You describe what you want;
  the skills keep it on the road.
- **Release notes that write themselves.** At every milestone — and weekly while you're
  actively building — `/release-notes` turns what shipped into a short stakeholder deck
  (what's new, why it matters, what's next). If you use docshub it lands there with a
  shareable link; if not, you get a self-contained slide file in your repo.

What you're spared: auth bugs, forgotten backups, secret leaks, surprise bills,
"it's down and nobody noticed", and the 2am realization that real employee data is
sitting in a public repo. (That last one isn't hypothetical — it happened here. The
kit makes the whole class of mistake hard to repeat.)

## Before you start (a few one-time things)

You don't need to be a developer, but a few tools need to be in place once. Starting from
nothing? Don't worry — Claude Code can install most of this *for* you; just ask it.

- **A GitHub account in CIAL's org.** Your code lives in **CialDNB** on GitHub, never a personal
  account — and you can't even *see* the template until you're a member. **No GitHub account yet,
  or not sure yours is tied to CIAL?** Ask the platform owner to invite your username to `CialDNB`
  (or set you up with a work account). Sort this first — everything else waits on it.
- **Homebrew, Node 22+, git, and the GitHub CLI.** On a Mac, install [Homebrew](https://brew.sh)
  once, then `brew install node git gh` (the kit builds and tests on Node 22; a newer Node is fine
  for local work). On Windows/Linux, get Node from [nodejs.org](https://nodejs.org) and the GitHub
  CLI from [cli.github.com](https://cli.github.com) — or simply ask Claude Code to install them for
  you.
- **Sign in to GitHub.** Run `gh auth login` → choose **GitHub.com** → **HTTPS** (no SSH keys to
  set up), and log in with your CIAL org account.
- **Your editor.** Claude Code is the default — the repo teaches it how we build (the `/`-skills).
  Prefer **Cursor, VS Code, or plain git**? That works too: the guardrails that matter (CI,
  reviews, branch protection) don't depend on the editor. Run `npm run hooks:install` once, and
  see [docs/COLLABORATION.md](docs/COLLABORATION.md) → "Using Cursor / VS Code / plain git" plus
  [docs/PLAYBOOKS.md](docs/PLAYBOOKS.md) (the skills written out as runbooks).
- **Recommended: install the Paved Road plugin.** On Claude Code, the kit also ships as a
  plugin installed straight from this repo — `/plugin marketplace add CialDNB/paved-road`, then
  `/plugin install paved-road@paved-road` — so the skill team and the guard hooks travel to
  **every** repo you open, not just cloned kit apps. It adds `/paved-road:pave` (scaffold the
  kit into an empty repo) and `/paved-road:adopt` (convert an existing project). Heads-up: the
  guard hooks are deliberately global (they block force-pushes and direct commits to `main`
  everywhere); on a repo where that isn't the norm, disable the plugin for that project via
  `/plugin`. Full guide: [docs/PLUGIN.md](docs/PLUGIN.md).

That's the whole toolkit. The blow-by-blow — every command, every snag to expect — lives in the
**[Builder's Implementer Handbook](https://docshub.cballiance.com/p/AFCLqnu)**.

## The journey

1. **Create your app from the template.** Open a terminal wherever you keep projects — make a home
   for them if you need one (e.g. `mkdir -p ~/projects && cd ~/projects`). Then create your *own*
   copy of the template **and** clone it with one command, naming your repo as you go (kebab-case,
   e.g. `vendor-tracker`):

   ```bash
   gh repo create CialDNB/vendor-tracker --template CialDNB/paved-road --private --clone
   ```

   That creates a `vendor-tracker/` folder (named after your repo). Step into it and install:

   ```bash
   cd vendor-tracker && npm install
   ```

   Prefer clicking? Go to `github.com/CialDNB/paved-road` → **Use this template** → create
   `CialDNB/<your-app>`, then `gh repo clone CialDNB/<your-app>` and `cd` in.
   *(Can't see the template, or can't create the repo? That's CialDNB org access — ask the
   platform owner to add you, or to create the repo from the template for you to clone.)*
2. **Open that `vendor-tracker/` folder in Claude Code — it's Claude's working directory — and run `/new-app`.** It asks first whether this is a DB Israel app (most apps are
   not; see [Deployment targets](#deployment-targets) — the rest of this step is the standard
   CIAL path). It renames everything to your app and connects a
   **Linear** project — it asks which team, or links an existing one. **No Linear account?
   That's fine** — it parks the project under a standing team so the work stays tracked.
   Putting the app on staging needs a **one-time platform step**: an admin sets the repo's
   `CLOUDFLARE_API_TOKEN` secret and `DEPLOY_ENABLED=true` (you never mint or hold a Cloudflare
   token), and then provisioning + the first deploy run in GitHub Actions. As part of that same
   step, your app's **own** API keys — its Anthropic key and AI-Gateway token — are set once on
   the first deploy (they live as this app's private Worker secrets, not shared with other apps),
   and persist afterwards; `/new-app` prints the exact command. `/new-app` walks you
   through it and pauses if that secret isn't set yet — so the first staging deploy is not
   instant if you don't have repo-admin rights. From here on, just talk: "add a page that
   lists vendor contracts with a status filter."

   *Want to see your app before staging is wired? Run it locally:* `npm install` →
   `npm run db:apply:local` *(one-time — creates your local database)* → `npm run dev` (API on
   `:8787`) and `npm run dev:web` *(the SPA). Local login uses the same magic-link outbox —
   see [First login](#first-login).*
3. **Build with the skills.** `/add-endpoint` and `/add-page` produce code that
   already has validation, permissions, audit, and tests. `/ship` opens the PR, gets
   every gate green plus a code review, and squash-merges — nothing reaches staging
   unreviewed, and nothing lands on main directly.
4. **See it live on staging.** Once the one-time platform step in step 2 is done, every merge
   lands on `https://staging-<your-app>.cialdnb.ai` automatically and health-checks itself.
   **No login email is sent yet** — until the central sender is configured (a platform task in
   flight), you fetch your login link from the app's outbox. See **[First login](#first-login)**
   for exactly how.
5. **Invite your users.** The Users tab is your allowlist — only invited people can
   log in, each with a role you choose.
6. **Pass go-live.** Run `/qa` and `/security-review`, then `/go-live` walks the
   checklist (backups observed, data classification done, owner named, rollback
   documented…). The platform owner signs off.
7. **Your app at `<your-app>.cialdnb.ai`.** Production exists only after that
   sign-off — which is exactly what makes it trustworthy.
8. **Tell people what you shipped.** Run `/release-notes` to announce the launch, then
   again at each milestone (and weekly while you keep building) so your users always
   know what's new.

## Deployment targets

Every app has one deployment target, chosen once, first, when `/new-app` asks: "Is this a DB
Israel application deployed under dbisrael.ai, or a standard CIAL application?" No answer means
CIAL, and nothing guesses it for you: not the app's name, not the GitHub org.

- **A standard CIAL application** (the default) is everything above: this repo's own GitHub
  Actions provision staging and deploy it to `staging-<your-app>.cialdnb.ai`, and production ships
  through the **Deploy production** workflow after sign-off.
- **A DB Israel application** is built and released by the central DB Israel pipeline
  (`CialDNB/il-paved-road-deployment`). It is **not enrolled or deployed until the platform
  enrolls it**. You hold no Cloudflare token, and the CIAL provision and deploy paths refuse to
  run. Instead:
  1. `/new-app` collects the app's identity and prints a draft of its central catalog entry
     (`npm run central:proposal`), with the decisions to make: sign-in, AI, alerts, schedules,
     backups and the rest.
  2. The platform owner opens the catalog PR, onboards the app and enrolls it. Until then the
     `il-paved-road-release` run on `main` is red; that is expected.
  3. A platform operator sets the app's runtime secrets and seeds you as the first owner
     (`seed-owner`). Sign-in is Microsoft (Entra), because central sends no email yet.
  4. Every merge to `main` then releases `https://<your-app>.staging.dbisrael.ai`, and production
     goes through the **Promote to production** link once the platform enables it.

  The app's own `docs/CENTRAL-DELIVERY.md` has the full list, and what never to create (a
  Cloudflare token, a `DEPLOY_ENABLED` variable, `IL_PAVEDROAD_*` secrets). Changing an app's
  target later is a reviewed migration, never a rerun of `/new-app`.

## First login

Your app is invite-only, so the first person who needs to get in is **you** (the owner). When
staging is provisioned you pass your own address as the seed owner, so you're already invited.
Here's how to get your first magic link while the central email sender is still being finished:

1. **Opt your address in to the outbox (once).** Outside production, a link that could not be
   emailed is parked in the app's session store for 15 minutes — but only for an address listed
   in `MAGIC_LINK_OUTBOX`, because that store then holds a live login link that anyone with
   Cloudflare KV read access on the account could use. Unset, nobody gets one. Add yours as a
   staging secret (it keeps your address out of git):

   ```bash
   echo "you@cialdnb.com" | npx wrangler secret put MAGIC_LINK_OUTBOX --config wrangler.staging.jsonc
   ```

   Comma-separate several builders. **Delete it once email works:**
   `npx wrangler secret delete MAGIC_LINK_OUTBOX --config wrangler.staging.jsonc`.
2. **Trigger the link.** Open your app's login page and submit your work email. You'll see a
   "check your email" message — but no mail is sent yet (expected for now).
3. **Fetch the link from the outbox,** under your address **in lowercase** (the app lowercases
   what you typed before it stores the link, so `You@CialDNB.com` is `you@cialdnb.com` here):

   ```bash
   npx wrangler kv key get --binding SESSIONS "magic-link-outbox:you@cialdnb.com" \
     --remote --config wrangler.staging.jsonc
   ```

   For local dev, put `APP_ENV=development` and `MAGIC_LINK_OUTBOX=you@cialdnb.com` in
   `.dev.vars` (the outbox is never written in production) and use `--local` instead of
   `--remote --config …`. **Heads-up:** the remote commands require you to be logged in to
   Cloudflare (`wrangler login`); if you don't have Cloudflare access, ask the platform owner to
   opt you in and pull your first link. The link is **not** in the logs: Workers Logs keep every
   line for 7 days and can't delete one, so the kit never logs a login link or an address
   (`wrangler tail` shows only `magic_link_not_emailed`, with `outbox: parked` or `not_listed`).
4. **Open it and confirm.** The link first shows a "Confirm sign-in" page — this is deliberate,
   so that email link-scanners can't silently burn your one-time link. Click the button to
   actually sign in. Each link works once.

Once the central email sender is live this all disappears — links just arrive by email — and
**no app reaches production login until email works** (it's a go-live gate).

## The approved-services menu

| You need | Use | Why it's the default |
| --- | --- | --- |
| Hosting + API | Cloudflare Workers (built in) | We already pay for it; your low-volume app costs ~nothing more |
| Database | D1 (built in) | Backed up nightly, queryable, zero servers |
| File storage | R2 (one line to enable) | Same account, same visibility |
| Login | The kit's magic links | No passwords; company SSO plugs in later without code changes |
| AI | Claude via our AI Gateway (built in) | Budget caps + privacy headers already set |
| Postgres-shaped needs | Supabase — **by exception** | Only for genuinely Postgres-shaped needs (heavy relational queries, vector search, realtime); requires a decision note in your repo |

## Why we standardized (the honest half-page)

When company tools live on personal accounts on lovable, railway, v0, or base44:
**security** — company data sits outside our control, with no audit trail, often
without real login; one pasted spreadsheet and employee or client data is on someone
else's cloud forever. **Cost** — five platforms × five subscriptions, paid on personal
cards, invisible until renewal. **Continuity** — the builder changes teams and the app
dies with their laptop; nobody else can fix or even find it. We're not banning tools —
we're making the safe path the path of least resistance: our Cloudflare Enterprise
account is already paid for, so your internal app's marginal cost is roughly zero, on
infrastructure with backups, logs, and a named owner.

## The rules (there are only five)

1. Company apps live in **CialDNB GitHub** — not personal repos.
2. Every app has a **Linear project** — created or linked by `/new-app`.
3. **No real data in code.** Seeds, fixtures, demos: synthetic only. Real data lives
   in the database, behind login.
4. **Go-live is gated.** Nothing gets a production address without the checklist and
   a sign-off.
5. **No new company apps on lovable / railway / v0 / base44 or personal clouds.**
   Prototype ideas anywhere; the moment colleagues use it or company data enters it,
   it belongs on the paved road.

## Two roads (this kit, or Cloudflare OS)

Not every idea needs this kit, and not every idea is safe without it. There is a second,
much lighter road: **Cloudflare OS**, a workspace for throwaway internal work — a read-only
view over a connector we already trust, a one-week analysis, a prototype you fully intend
to delete. It's genuinely good at that, and standing up a whole app with provisioning and a
go-live checklist is the wrong price for something you'll throw away.

One rule decides which road an idea takes, and it's lopsided on purpose: **any single
paved-road trigger wins; Cloudflare OS requires every condition to hold.**

**It goes on the PAVED ROAD if ANY of these is true:**

- it serves anyone outside CIAL's Entra tenant;
- it is a system of record;
- it needs per-record authorization (row ownership, not just who can open the app);
- it needs a retained, exportable audit trail or a restore drill;
- it will outlive its author;
- it needs an anonymous or public surface.

**It goes on CLOUDFLARE OS only if ALL of these are true:**

- every user is a CIAL employee in-tenant;
- data is read through a connector we already trust;
- the artifact is disposable;
- the worst case of it being wrong is a wrong answer rather than a leak, a fine, or one
  client seeing another.

**Ambiguous goes paved-road.** **Prototypes graduate OS → paved-road, never the reverse** —
an OS artifact that starts mattering gets rebuilt here; a paved-road app is never
"simplified" onto OS to move faster.

Why so lopsided: Cloudflare OS can decide who may open a workspace, but not who may see
which row — so "this record belongs to this client" is a sentence it can't say. Its audit
log is prose, it lives inside the workspace, and it dies with it; there's nothing to export
and nothing to hand an auditor. There are no backups, so "restore is pick a day" doesn't
exist there. Each of those gaps is one of the paved-road triggers above, which is why one
trigger is enough to settle it: if your idea trips even one, the lighter road can't hold it.

## Already built something elsewhere? (Amnesty, not trouble)

If you have an app running on one of those platforms today: **good news — it clearly
proved its value, and nobody is in trouble.** The deal: tell the platform owner, and
we'll migrate it together — usually a session or two with Claude Code (`/new-app`,
then port the screens and data). You keep ownership; the company gains backups, login,
and continuity. The migration playbook is in
[docs/IMPLEMENTATION-HANDBOOK.md](docs/IMPLEMENTATION-HANDBOOK.md).

## Joining an app someone else built

Not every app starts with you. If you're **picking up an app a colleague built**, **taking it
over** because they've moved on, or **building alongside** them, you don't start from scratch —
run **`/join-app`** and it walks you in: clone, install, a one-command health check
(`npm run ci`), then a read of the Linear project, the decisions log, and what's already live.
Ask the current owner to invite you into the app with a role (owner / admin / member / viewer)
so you can actually use it while you build.

This is the answer to the continuity worry above — an app no longer dies when its builder
changes teams, because picking it up is a paved path too. The full playbook — building in
parallel without stepping on each other, and the take-over/handoff steps when ownership changes
hands — is in **[docs/COLLABORATION.md](docs/COLLABORATION.md)**.

## Getting more out of Claude itself

Most of your app gets built in ordinary back-and-forth: you describe, Claude builds, you
look and correct. That loop is the default and it's what almost everything ships from.

Two things are worth knowing beyond it. First, **the skills do more than you'd guess** —
most "how do I…" moments are a skill you haven't tried yet (`/add-page`, `/add-endpoint`,
`/qa`, `/ship`). Second, Claude can **fan out into many parallel agents** for work that's
genuinely many independent pieces at once — and knowing when *not* to do that matters more
than knowing how, because it's easy to spend a lot for a task that wanted one session.

**[docs/WORKING-WITH-CLAUDE.md](docs/WORKING-WITH-CLAUDE.md)** is the short version: when
to stay linear, when fanning out actually pays, what it costs, and the one constraint that
decides most cases — a parallel run can't stop to ask you anything, so anything you'll want
to steer mid-way stays a normal conversation. If you're sitting on a phased plan and want
to know what could run in parallel, **`/plan-to-graph`** works it out for you.

## Where to get help

- **The skills** — `/new-app` onward; they answer most "how do I…" questions by doing it.
- **The docs** — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together,
  [docs/API-CONVENTIONS.md](docs/API-CONVENTIONS.md) for API shape,
  [docs/GO-LIVE.md](docs/GO-LIVE.md) for launch,
  [docs/WORKING-WITH-CLAUDE.md](docs/WORKING-WITH-CLAUDE.md) for working with Claude well.
- **A human** — the platform owner (Yoni Cohen, yoni.cohen@cialdnb.com). Bring ideas
  early; the whole point is to say yes faster.
