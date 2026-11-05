# The Paved Road Plugin

Paved Road ships as a **Claude Code plugin** so the whole kit — not just the agent harness,
but the Cloudflare app, the Linear/GitHub/Cloudflare bootstrap, and the deploy path — is one
`/plugin install` away on **any** repo, instead of only reachable through GitHub's "Use this
template" button.

This is the canonical reference for the plugin. The plugin's own short install card is
[`plugins/paved-road/README.md`](../plugins/paved-road/README.md); the decision record is in
[`DECISIONS.md`](DECISIONS.md) (2026-06-30).

> **Already have projects?** `/paved-road:pave` is for empty repos. To convert an **existing**
> local project (any stack) to paved-road guardrails + GitHub + Linear + (optionally)
> Cloudflare, use **`/paved-road:adopt`** — see [ADOPT-EXISTING.md](ADOPT-EXISTING.md).

---

## What "paved road" actually is (and what the plugin must carry)

Paved Road has three layers. The plugin delivers all three — but by **different mechanisms**,
because a Claude Code plugin can carry code and prompts, not secrets or live cloud resources.

| Layer | What it is | How the plugin delivers it |
| --- | --- | --- |
| **Harness** | Working agreement (`CLAUDE.md`), guard hooks, the 13-skill team and its 2 subagents | **Bundled in the plugin** — installed globally, active on every repo |
| **App template** | Cloudflare Worker + Hono API, React SPA, `schema.sql`, wrangler configs, tests, and the `provision.mjs` / `new-app.mjs` / deploy scripts | **Delivered by `/paved-road:pave`**, which clones the template into the target repo |
| **The bootstrap path** | Create the Linear project, (optionally) the GitHub repo; for a CIAL app, provision Cloudflare (D1/KV/R2/secrets), first staging deploy, production go-live; for a DB Israel app, the identity block and draft registration for the platform, which provisions and releases it centrally | **Orchestrated by the skills** (`/new-app`, `/go-live`) driving the cloned scripts + MCP servers |

The one thing a plugin **cannot** carry is **credentials** — the Cloudflare API token, Linear
auth, and Anthropic key. Those you configure once (see [Keys](#keys-what-you-configure-once)).
A DB Israel app holds no Cloudflare credential at all.

---

## Install

```text
/plugin marketplace add CialDNB/paved-road
/plugin install paved-road@paved-road
```

> The GitHub-shorthand form (`CialDNB/paved-road`) resolves to that repo's **default branch**.
> Until this work is merged to `main` there, install from a clone instead:
> ```text
> /plugin marketplace add ./           # from a local clone of the branch
> /plugin install paved-road@paved-road
> ```

Once installed, the plugin is available on every repo you open in Claude Code.

> **Installed a version older than 1.7.0?** Its `/paved-road:pave` and `/paved-road:new-app` never
> ask the deployment target, so they make a CIAL app every time. Update the plugin (`/plugin`)
> before you start a DB Israel app. If an older `pave` already ran, run the repo's own `/new-app`
> (the copy `pave` cloned, which is current) before anything is provisioned. On a tree fresh from
> the bootstrap, with no deployment marker, it asks the target once, and on "DB Israel" converts
> the tree with `node scripts/new-app.mjs <name> --target dbisrael`. The bootstrap refuses the
> conversion once anything is provisioned, in the working tree or in the git history.

> **Installed a version older than 1.6.0?** Its copies of `/qa`, `/go-live`, `/ship`,
> `/kit-upgrade`, `/join-app` and `/add-job` ignore the deployment target, so in a DB Israel app
> they give CIAL instructions: a CIAL staging host, a magic-link outbox read with a Cloudflare
> token, the Provision and Deploy production workflows. The workflow guards still protect such an
> app, since its CIAL provision and deploy paths refuse to run, but the guidance does not. Update
> the plugin (`/plugin`) before working on a DB Israel app.

> **Scope — the guard hooks are global, by design.** Once installed, `guard-bash` runs on
> **every** repo you open, not just paved-road apps: it blocks `rm -rf`, `git push --force`,
> `git reset --hard`, destructive SQL/Cloudflare deletes, direct commits/pushes to
> `main`/`master`, and unpinned remote package execution (`npx --yes <pkg>@latest`,
> `npm create <x>@latest`, a bare `npx <pkg>` that isn't installed). That is the point — the
> discipline travels. On a repo where pushing straight to `main` is the normal flow, disable the
> plugin for that project (via `/plugin`) rather than weakening the hook.

---

## The full critical path, end to end

```
              ┌─────────────────────────────────────────────────────────────┐
   any repo → │  /paved-road:pave                                            │
              │    • asks the deployment target: CIAL (default) or DB Israel │
              │    • clones the template into this repo (the CF app + scripts)│
              │    • runs new-app.mjs --target (rename, reset ids/secrets)   │
              │    • npm install                                              │
              └───────────────┬─────────────────────────────────────────────┘
                              ↓
              ┌─────────────────────────────────────────────────────────────┐
   /new-app → │  conversational bootstrap (skill + MCP)                      │
              │    • create / connect the Linear project        (Linear MCP) │
              │  CIAL app:                                                   │
              │    • provision Cloudflare staging: D1, KV, R2,  (provision.mjs│
              │      secrets, AI-Gateway token                   + CF creds)  │
              │    • first staging deploy                        (wrangler)   │
              │  DB Israel app:                                              │
              │    • identity block + draft catalog entry  (central:proposal)│
              │    • the platform onboards, enrolls and releases centrally   │
              └───────────────┬─────────────────────────────────────────────┘
                              ↓
   /add-page · /add-endpoint · /add-job   →  build features the paved-road way
   /security-review · /qa · /ship         →  review, QA, PR + gates + merge
                              ↓
   /go-live  →  gated production checklist → human sign-off → production deploy
```

Every step is a bundled skill; the executable scripts they call (`provision.mjs`,
`new-app.mjs`, `wrangler deploy`) ride along in the template that `pave` laid down.

---

## Keys (what you configure once)

The plugin and template are public-safe; **no secrets are bundled**. Per app you provide:

| Credential | Where it's used | How to set it |
| --- | --- | --- |
| **Cloudflare API token** (CIAL apps only; per-app scoped — see `provision.mjs` header for exact scopes) | `provision.mjs`, `wrangler deploy` | `wrangler login` or `CLOUDFLARE_API_TOKEN` env |
| **Linear** | `/new-app` creates the project | Linear MCP auth (the template ships `.mcp.json`) |
| **Anthropic API key** | budget-gated AI features | CIAL: wrangler secret; DB Israel: a runtime secret the platform sets, once AI is approved; `.dev.vars` locally (gitignored) |

`.dev.vars` is local-only and gitignored. Never commit a key. In a **CIAL app**, production
secrets live in Cloudflare's Secrets Store, set during `/new-app` provisioning. A **DB Israel
app** holds no Cloudflare credential (no token, no `wrangler login` for it) and has no Secrets
Store bindings: its runtime secrets are declared in its central catalog entry and set by someone
with DB Israel Cloudflare access ([SECRETS.md](SECRETS.md), "DB Israel apps").

---

## What's bundled vs. delivered vs. configured

- **Bundled in the plugin** (`plugins/paved-road/`): `hooks/` (guard-bash, warn-protected-core,
  and warn-design-drift, which stays silent unless a repo has a `.paved-road/design.json` in
  `mode: "port"`), all 13 `skills/`, the two `/port-ui` subagents in `agents/` (`ui-inventory`,
  `ui-parity-reviewer`), and the plugin's own `commands/` (`pave`, `adopt`). The hooks, skills
  and subagents are **byte-identical copies** of the protected `.claude/` originals, kept so by
  `sync-from-harness.mjs`.
  - **Subagents are auto-discovered.** `agents/` sits at the plugin root and needs no manifest
    key (an `"agents"` key in `plugin.json` is invalid and was removed); the sync mirrors
    `.claude/agents/` into it.
  - **Not bundled: `.claude/workflows/`.** The plugin manifest declares `commands`, `skills`,
    and `hooks` (agents are found by folder), so a workflow script is repo-local — it reaches
    template forks and `/kit-upgrade` (whose diff list includes `.claude`), never a
    `/plugin install` user. The kit
    ships no workflow script today (DECISIONS 2026-08-05); this is the constraint to know before
    one is ever added.
- **Delivered by `pave`** (cloned at scaffold time, always current): the entire Cloudflare app
  template + its scripts.
- **Configured by you**: the credentials above.

### Why `pave` clones instead of bundling the app

The full app tree is **not** copied into the plugin package. `pave` clones the canonical repo
at scaffold time so a paved app is always on the latest template, and the plugin stays small.
The trade-off: `pave` needs **read access to the template repo**. (Self-hosting the template,
or bundling it for fully-offline scaffolding, is a documented future option — see
[Scope decisions](#scope-decisions--open-questions).)

---

## Scaffolded apps never carry the packaging

The marketplace manifest (`.claude-plugin/marketplace.json`) and the `plugins/paved-road/` shell
belong to **this** repo — the template/marketplace — not to an app built from it. Both scaffold
paths keep them out of a new app:

- **`/paved-road:pave`** excludes `plugins/` and `.claude-plugin/` when it copies the tree.
- **"Use this template" → `/new-app`** copies the whole tree, so `scripts/new-app.mjs` **strips**
  `plugins/` + `.claude-plugin/`, removes the `verify:plugin` gate from the app's `package.json`,
  and drops the marker-delimited plugin-install block from `README.md` (the
  `<!-- plugin-install:start -->…<!-- plugin-install:end -->` pitch) during the rename.
  `npm run verify:bootstrap` then fails loudly if any of it reappears in a scaffolded app.

So a paved app is never a self-referential marketplace, never ships duplicated skills, and never
inherits a `verify:plugin` gate it can't satisfy.

## Keeping the plugin honest (no drift)

The bundled skills/hooks are copies, and copies rot. One script is the source of truth for that
copy:

```bash
node plugins/paved-road/sync-from-harness.mjs          # mirror .claude/ → plugin
node plugins/paved-road/sync-from-harness.mjs --check   # CI gate: fail (exit 1) on drift
node plugins/paved-road/sync-from-harness.mjs --stamp   # re-record the payload hash + version
```

- **Edit skills/hooks in `.claude/`** (the protected source of truth), then run the sync.
- `--check` runs in CI as **`npm run verify:plugin`** (wired into `npm run ci`), so a drifted
  copy can't merge.
- **`--check` and `--stamp` are mutually exclusive** and the script refuses both together
  (exit 2). One verifies, the other mutates — and `npm run verify:plugin -- --stamp` expands to
  exactly that pair, so without the refusal the gate would be bypassable by the command a stale
  stamp trains you to reach for.

### The bundle stamp (why a version bump can't be forgotten)

Mirroring proves the plugin's copies match `.claude/`. It says nothing about whether the
plugin's **`version`** moved when they did — and an installed plugin only picks up changes when
the version does. So a new skill could land on `main`, correctly mirrored, `verify:plugin` green,
and reach **no installed user at all**. That failure is silent by construction.

`.claude-plugin/bundle.sync.json` records a hash of the shipped payload next to the version it
ships under, and `--check` fails until you re-stamp — forcing a conscious "does this need a
version bump?" decision. Re-stamping at the **same** version is a legitimate answer (a typo fix
needn't ship); skipping the question isn't.

The hash covers the payload by **exclusion**: everything under the plugin directory except the
stamp itself, the sync script (maintainer tooling, not a component), and untracked debris
(`.DS_Store`, `*.orig` and friends — otherwise a working tree and a clean checkout disagree).
`plugin.json` IS hashed: its `commands`/`skills`/`hooks` declarations decide what the plugin
exposes, and an earlier cut that excluded the whole manifest directory left them unguarded.
Symlinks are hashed by target path, the way git stores them, never followed. An earlier cut used an allowlist of skills + three hooks,
which silently left `commands/`, `assets/` and `hooks/hooks.json` — most of what an installed
user actually runs — outside the invariant it claimed to enforce. Exclusion means a new
component is covered the day it's added, with no list to update.
- The repo-local `postedit-format` PostToolUse hook is **not** bundled — it assumes this repo's
  biome config and isn't portable.

---

## Publishing this plugin (where does a push go?)

`origin` is **`https://github.com/CialDNB/paved-road.git`** — the CIAL org repo. Pushing the
plugin branch there requires **write access to that repo**; a read-only collaborator's push is
rejected. Two clean ways to publish:

1. **Fork + upstream PR** (recommended if the goal is to land it in the official kit):
   ```bash
   gh repo fork CialDNB/paved-road --remote --remote-name fork
   git push fork feat/paved-road-plugin
   gh pr create --repo CialDNB/paved-road --base main --head <your-org>:feat/paved-road-plugin
   ```
   The PR runs all the kit's CI gates; a maintainer (e.g. the repo owner) reviews and merges.

2. **Your own repo** (if you want an independently-installable copy):
   ```bash
   gh repo create <you>/paved-road --private --source . --remote myrepo --push
   ```
   Then users install from **your** marketplace: `/plugin marketplace add <you>/paved-road`.

Until merged to a default branch somewhere, anyone can still install from a **local clone**
(`/plugin marketplace add ./`).

---

## Developing the plugin

The repo is **both** a normal project and a marketplace — they don't conflict.

- Marketplace manifest: `.claude-plugin/marketplace.json` (repo root).
- Plugin manifest + components: `plugins/paved-road/`.
- After changing a skill or portable hook in `.claude/`, run the sync script and commit the
  mirrored copy alongside the original (CI's `verify:plugin` enforces this).
- Bump `version` in `plugins/paved-road/.claude-plugin/plugin.json` when you want installed
  users to pick up changes (pushing alone isn't enough when a version is pinned).

---

## Decisions & open questions

Settled (2026-07-01):

- **Template delivery = clone, not bundle.** `pave` clones the canonical repo at scaffold time
  so a paved app is always current and the plugin stays small. Trade-off: `pave` needs read
  access to the template repo. (Bundling for fully-offline scaffolding remains a future option.)
- **Repo-first, not auto-create.** Both `pave` and `adopt` operate inside a repo you already
  created; they wire up `origin` but don't run `gh repo create` for you. Fewer assumed
  permissions, no surprise public repos.
- **Existing projects = `/paved-road:adopt`.** Converting an existing project is a first-class
  path, tiered (guardrails vs. full migration) — see [ADOPT-EXISTING.md](ADOPT-EXISTING.md).

Still open:

- **MCP servers.** The Linear/Cloudflare/docshub MCP config ships with the *template* (per-app
  `.mcp.json`), not the global plugin, to avoid noise on unrelated repos. Bundling it globally
  is an option if the whole bootstrap should work before `pave`/`adopt`.
