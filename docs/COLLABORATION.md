# Collaboration — working on an app with other people

> **Solo by default.** If you're the only person on this app, you can skip this file —
> nothing here changes the single-builder path, and none of it is required until a second
> person actually shows up. This is the doc you open the day someone else joins, takes over,
> or builds alongside you.

The first-builder path (`/new-app`) and the parallel-*agent* guidance (CLAUDE.md "Parallel
sessions") cover one person and one set of automated sessions. This file covers **more than
one human** on the same app. The machinery already exists — the PR-per-change flow, the
guard-bash hook, CODEOWNERS, the Linear standing rule, and the app's own role system.
Collaboration is just turning those on deliberately.

## Three things people call "ownership" (keep them separate)

| Axis | What it is | How many | The lever |
| --- | --- | --- | --- |
| **Build access** | Who can branch, open PRs, and review code in the repo | **Plural** — as many contributors as you trust | GitHub collaborators + CODEOWNERS |
| **Accountable owner** | Who signs off go-live, owns `ALERT_EMAIL`, is the named owner in `docs/GO-LIVE.md` | **One** — by design (central-owner model, DECISIONS 2026-06-23) | The handoff runbook below |
| **App RBAC** | owner / admin / member / viewer **inside the running app**, for its end users | As many as you invite | The Users tab |

Adding a second *builder* does not change *who owns production*. You can have several people
shipping code and still one named go-live owner. Don't conflate "I can't deploy prod" with
"I can't contribute" — different axes.

## App roles (RBAC) — what each can actually do

A teammate joining to *use or test* the app needs an invite **with the right role** (Users
tab). The matrix the framework enforces (`src/auth/permissions.ts`; the permission test pins
it, so this can't silently drift):

| Capability | owner | admin | member | viewer |
| --- | :-: | :-: | :-: | :-: |
| Manage users (invite, set roles) | ✓ | ✓¹ | — | — |
| Read the audit log | ✓ | ✓ | — | — |
| Manage settings (alerting, …) | ✓ | ✓ | — | — |
| Use AI features | ✓ | ✓ | ✓ | — |
| Manage own API tokens | ✓ | ✓ | ✓ | — |
| Read app data (e.g. notes) | ✓ | ✓ | ✓ | ✓ |
| Write app data | ✓ | ✓ | ✓ | — |

¹ Admins manage **members and viewers only** — never owners or other admins (`canManageRole`);
the **last owner can't be removed or demoted** (live DB-count guard in the route). To let a
collaborator exercise admin-only screens, invite them as **admin**; for ordinary use,
**member**; read-only stakeholders, **viewer**.

> App RBAC is about the *running app's users*, not the GitHub repo. A developer might be a
> repo collaborator (build access) **and** an admin in the app (to test admin flows) — two
> separate grants, made in two separate places.

## Scenario A — Joining an app someone else built

Run **`/join-app`** — it walks this. The short version:

1. **Get your environment green.** `gh repo clone CialDNB/<app> && cd <app> && npm install`,
   then `npm run ci`. Green proves your machine matches the kit; red is your first task.
2. **Read the state, not just the code.** The Linear project (standing rule — start every
   session there), `docs/DECISIONS.md` (why things are the way they are), `docs/RESOURCES.md`
   (what's provisioned), GUIDEBOOK + CLAUDE.md, and the golden examples (`src/routes/notes.ts`,
   its test, the matching page in `web/`).
3. **Get access.** Ask the current owner/admin to invite you in the app (Users tab) with the
   role you need (see the matrix). You do **not** need a Cloudflare token to build —
   provisioning and deploys run in CI; the owner handles repo + Cloudflare access.
4. **Claim work and ship.** Pick a Linear issue, `git switch -c <type>/<slug> origin/main`,
   build, `/ship`. Your first PR is your handshake with the gates.

## Scenario B — Two or more people building in parallel

The PR flow prevents most collisions; the rest is courtesy. The covenant:

- **Always branch from fresh `origin/main`; never work on `main`.** The guard-bash hook blocks
  commits/pushes to main locally, but the discipline is yours.
- **PR every change — including the tiny ones.** The review gate is how a second person sees
  your work *before* it's live. Self-merging "trivial" fixes skips the one safeguard
  collaboration depends on.
- **Coordinate shared-surface edits *before* you start them** (Linear or a quick message):
  `schema.sql` / migrations, anything in the protected core, the security headers, CI
  workflows. Two people editing the schema in parallel is the one merge that really hurts.
- **Review each other.** With two builders, every PR gets a real review (protected-core PRs
  get `/code-review` at high/max). That's the whole point of a second person.
- **Don't revert another session's in-flight work.** Touch only the files your task needs. If
  `main` moved under you, **merge it in — never force-push or `reset --hard`** (the harness
  blocks both); rebasing a shared branch rewrites history others may hold.
- **Leave the trail.** End every session with a Linear comment on what shipped; load-bearing
  choices go to `docs/DECISIONS.md`. The next person reads that, not your memory.

## Scenario C — Taking over (the handoff runbook)

When the **accountable owner** changes — a builder leaves, the app moves teams — transfer the
baton explicitly. This is the gap that otherwise kills an app when its builder moves on:

1. **App roles.** Promote the new owner to **owner** in the Users tab, *then* demote/remove the
   outgoing one (the framework won't let you remove the last owner). Verify in the audit log.
2. **CODEOWNERS.** Repoint `/.github/CODEOWNERS` from the old owner to the new one — and ideally
   list **two**, which closes the bus-factor (OPEN-QUESTIONS B4).
3. **Go-live owner + alerts.** Update the **Go-live owner** line and the record block in
   `docs/GO-LIVE.md`, and `ALERT_EMAIL`, so failure alerts reach the right person.
4. **Cloudflare token.** Rotate the scoped `CLOUDFLARE_API_TOKEN` (mint new → update the repo
   secret → revoke old; handbook §8.1). A handoff is a credential event.
5. **Linear.** Reassign the project lead, add the new owner, comment the handoff.
6. **Record it.** Append a `docs/DECISIONS.md` entry (who → who, when, what rotated); if it's a
   real milestone, run `/release-notes`.

## CI/CD posture — a per-app choice (and why CODEOWNERS won't block you early)

Branch protection on `main` is **off by default**, deliberately: on a solo repo it just makes
you bypass your own gate (DECISIONS 2026-06-12, OPEN-QUESTIONS B3). So out of the box,
**CODEOWNERS is review-*routing*, not a hard merge gate** — it never blocks a solo builder.
Each app picks its posture:

- **Solo / early (default), Claude Code:** convention + the guard-bash hook hold the line.
  CODEOWNERS advises reviewers; nothing is enforced server-side. **Zero friction.**
- **Solo, non-Claude-Code (Cursor / VS Code / plain git):** the guard-bash hook only fires inside
  Claude Code, so it does **not** hold the no-push-to-`main` line for you. `npm run hooks:install`
  gives you a git-native equivalent, but git never auto-installs hooks on clone and they're
  bypassable — so turn on the **minimal** ruleset even while solo: require a PR + passing CI
  (`ci`), **0 approvals** (you can still self-merge your own green PR), CODEOWNERS advisory. That
  makes "every change is a PR + CI" real for you without blocking your own merge.
- **Multi-person (recommended at 2+ maintainers):** step the same ruleset up — require **1**
  approving review and "require review from Code Owners" on protected paths. Two maintainers is
  exactly the trigger B3 was waiting for: the required review is now a *colleague's*, not a gate
  you bypass. **Don't require approvals while solo** — a PR author can't approve their own PR, so
  you'd block yourself on a review only you can give. (If you want the strict rule authored once,
  put the owner on a ruleset **Bypass list — "for pull requests only"**, then just remove them
  from it when a second maintainer joins; no rule rewrite.)

To enable: GitHub repo → **Settings → Rules → Rulesets** → protect `main` (require PR + status
check `ci`; approvals 0 solo / 1 at 2+ maintainers; add Code Owner review when you go to 1).
Record the choice in the block below and in `docs/GO-LIVE.md`.

## Maturity lifecycle — incubating → stable (the bus-factor model, made explicit)

Most apps start as one person's project and only later become something a team depends on. The
kit encodes that as **two modes** with an explicit graduation, so a solo builder carries **zero**
review friction early, and the heavier machinery (a second code owner, required review) turns on
exactly when it starts paying for itself — a triggered event, not a standing nag. The current mode
is a machine-readable stamp, `APP_MATURITY` in `src/framework/version.ts`, that the report cron
sends to the fleet registry (so it can flag an app whose reality has outgrown its mode).

**Incubating (default at `/new-app`).** One CODEOWNER, branch-protection at the per-editor floor
above (convention-only for solo + Claude Code), zero added friction. The one continuity
requirement — and it is a **go-live gate** — is a named **break-glass successor**: a *second person*
documented as holding (or able to obtain) access to the app's Cloudflare account and the
`CLOUDFLARE_API_TOKEN`, so a bus event isn't fatal. A successor is continuity **without** the
overhead of a co-reviewer; it is not the same as a second CODEOWNER.

**Graduate to stable when any one is true:**

- a **second maintainer** joins the repo (`/join-app` flags this — it *is* the graduation trigger),
- data classification reaches **PII / client / confidential** (per `docs/GO-LIVE.md` gate 2),
- the app has **sustained real production users** (not a demo/throwaway),
- an **ownership handoff** happens (Scenario C).

**Graduation checklist (one reviewed PR):**

1. **Second CODEOWNER** on the protected paths — a person, or ideally a `@CialDNB/<team>` that
   survives forking (closes the bus-factor B4).
2. **Branch-protection ruleset ON** — require PR + CI + **1** approving review + "require review
   from Code Owners" on protected paths (the multi-person posture above).
3. **Second `ALERT_EMAIL` recipient** so failure alerts don't dead-end at one inbox.
4. **Flip `APP_MATURITY` to `'stable'`** in `src/framework/version.ts`, and update the mode in the
   "This app" block below. The registry now sees `stable` and stops flagging drift.

The **kit repo itself** already meets the stable criteria (real dependents, PII-adjacent tooling);
graduating it is exactly the still-open item — naming the second platform CODEOWNER (B4).

## Using Cursor / VS Code / plain git instead of Claude Code

The kit is built around Claude Code, but the **security invariants are enforced by CI +
CODEOWNERS + branch protection — all editor-agnostic** — so you can build it from any editor.
What you lose in another editor are the *local* ergonomics, and there's one gap to close
deliberately:

1. **Install the git hooks first:** `npm install && npm run hooks:install && npm run ci`.
   `hooks:install` points `core.hooksPath` at `.githooks/`, which blocks commits/pushes to
   `main` and runs typecheck+lint pre-commit — the editor-agnostic stand-in for the Claude Code
   `guard-bash` hook. Pre-commit also refuses a local secrets file (`.env`, `.dev.vars`,
   `.secrets.json`, even force-added) and a real value pasted into a committed `.example`
   template. It is **not** auto-installed on clone, so this step is on you; emergencies can
   override once with `PAVEDROAD_ALLOW_PROTECTED=1`, a deliberate template edit with
   `PAVEDROAD_ALLOW_SECRET_FILE=1`.
2. **Turn on the minimal branch-protection ruleset** (above) even while solo — the git hook is a
   convenience, branch protection is the guarantee.
3. **The agent reads `AGENTS.md`, not `CLAUDE.md`.** `AGENTS.md` is a symlink to `CLAUDE.md`, so
   Cursor (and other AGENTS.md-aware tools) get the full working agreement. `.cursor/rules/`
   pins the load-bearing invariants as an always-on rule.
4. **Install the biome editor extension** (`.vscode/extensions.json` recommends it; Cursor reads
   `.vscode/settings.json`) so format-on-save matches the lint gate. Without it, `npm run lint`
   still catches style in CI — just later.
5. **Skills are runbooks, not slash-commands.** `/add-endpoint`, `/ship`, etc. don't exist in
   Cursor; follow [`docs/PLAYBOOKS.md`](PLAYBOOKS.md), which maps each skill to its written steps,
   golden example, and (for the Linear/docshub-backed ones) the manual fallback.

Everything else is identical: branch from `origin/main`, PR every change, let CI gate the merge.

## This app

- **Maturity mode:** _incubating | stable — must equal `APP_MATURITY` in `src/framework/version.ts`_
- **Maintainers (build access):** _list, or "solo: \<name\>"_
- **Editors in use:** _e.g. "Claude Code" | "Claude Code + Cursor" — drives the branch-protection floor_
- **Accountable owner:** _name, email — mirrors `docs/GO-LIVE.md`_
- **Break-glass successor (incubating):** _name, email — the second person with access if the owner is unavailable_
- **Branch-protection posture:** _convention-only (solo + Claude Code) | minimal (any non-Claude-Code builder) | protected (2+ maintainers)_
- **Last handoff:** _date + DECISIONS link, or "none"_
