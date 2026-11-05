# Using Paved Road on existing projects

`/paved-road:pave` turns an **empty** repo into a full Cloudflare kit app. But most real
adoption is the other direction: you already have projects — built locally, in various
stacks, with their own code — that need the paved-road **guardrails, a GitHub repo, a Linear
project, and (where it fits) Cloudflare connection and deployment**. That's what
**`/paved-road:adopt`** is for.

> Prerequisite: install the plugin once (see [PLUGIN.md](PLUGIN.md)). Its guard hooks and the
> skill team then work on every repo, including the ones you're adopting.

## Two tiers — pick per project

Adoption is **not** all-or-nothing. The command reviews the project and offers two tiers:

### Tier 1 — Guardrails (any stack, recommended default)

Apply the paved-road *discipline* without changing how the app runs. Good for a Flask API, a
React SPA, a CLI tool, a data pipeline — anything. You get:

- a **working agreement** (`CLAUDE.md` + `AGENTS.md`) tuned to the project — the prime
  directives (branch + PR, fail closed, synthetic data, green-or-it-doesn't-ship) and iron
  laws, with this repo's real commands filled in;
- **branch/PR discipline** enforced — the plugin's guard hooks block direct commits/pushes to
  `main` and destructive commands in Claude Code; a git pre-push hook covers other editors;
- a **GitHub repo** (repo-first — you create it, the flow wires it up);
- a **Linear project**, with starter issues seeded from the review (e.g. "rotate committed
  key", "add CI gate");
- **CI gate suggestions** appropriate to the stack.

The app keeps its own framework and deploy target. This is the right tier for most existing
projects.

### Tier 2 — Full paved-road platform (migration)

The project should be **rebuilt on the kit** (Cloudflare Workers + Hono + magic-link RBAC +
audit + budget-gated AI + the full CI/CD and go-live path). This is a migration, so the
command produces a **plan** and moves incrementally — it never clobbers your code:

1. Map the app's routes / data model / auth / jobs onto the kit's `defineRoute`,
   repositories, RBAC, and cron loop. **Map its screens and design system too.**
2. Scaffold the kit alongside via `/paved-road:pave`, then port logic into `src/routes/` +
   `web/` in reviewable PRs, staying green.
3. **Port the UI with `/paved-road:port-ui` (default on).** The rebuilt app keeps the original's
   design system, shell and screens instead of falling back to the kit's neutral baseline:
   - a design contract pointing at the original;
   - the source CSS carried verbatim into `web/src/theme/`;
   - the shell rebuilt over the kit's view registry;
   - a screenshot parity loop against the running original.

   Skip it only on an explicit decision, such as a planned redesign. See
   [DESIGN-PORT.md](DESIGN-PORT.md).
4. `/new-app` handles the Linear + Cloudflare provisioning + first staging deploy; `/qa` and
   `/security-review` gate `/go-live`.

## The flow

```text
existing local project
        │
        ▼
  /paved-road:adopt
        │
        ├─ 1. REVIEW   manifest (if any) → stack, commands, git state
        │              risk scan (secrets / real data / no CI) — always, independently
        │
        ├─ 2. CHOOSE   Tier 1 (guardrails)  ·  Tier 2 (full platform migration)
        │
        ├─ Tier 1 ──── working agreement → git hooks → GitHub repo → Linear → CI gates → /ship
        │
        └─ Tier 2 ──── migration plan → pave alongside → port in PRs (API + /port-ui) → /new-app → /go-live
```

## Generated apps: skip the guesswork

Step 1 is detection, and on an arbitrary repo detection is inference. On an app produced by a
**generator** it doesn't have to be: the tool wrote every byte, so it can simply state the stack,
the entry point and the real commands in a file it drops at `.paved-road/adopt.json`.

`/paved-road:adopt` reads that file first. When it's a valid v1 manifest, the review takes the
stack and commands from it, picks up `.paved-road/ORIGIN.md` (the originating prompt and
iteration history — for a Tier 2 rebuild that's worth more than the generated code, and the
generator is the only place it exists), and goes straight to the tier question.

One thing a manifest can tell you that nothing else can: **the export may be a fragment.** A
generator with a size cap ships only part of the project past that cap, and the delivered repo
looks no different from a complete one. A `claims.complete` that isn't `"yes"` says so, and
`adopt` puts it in front of you *before* the tier question — Tier 1 would put guardrails around a
partial app, and Tier 2 would plan a rebuild from a partial `ORIGIN.md`.

Two things do **not** change:

- **The risk scan still runs, in full, independently.** The manifest is written by the artifact
  being adopted, so its `claims` block is an assertion, not a finding. Secrets and real data are
  found by looking, every time.
- **No manifest, or a broken one, is not an error.** Adoption falls back to detection exactly as
  before. A metadata file never blocks adopting a working app.

The format is generator-agnostic and pinned in
[ADOPTION-MANIFEST.md](ADOPTION-MANIFEST.md) — that's also the conformance checklist for anyone
writing a producer.

## What you configure (same as a fresh app)

The plugin carries no secrets. Per project you provide what each integration needs:

- **GitHub** — `gh auth login` (repo-first: you create the repo).
- **Linear** — the Linear MCP, authenticated.
- **Cloudflare** (Tier 2 only) — a per-app scoped API token / `wrangler login`.

See [PLUGIN.md → Keys](PLUGIN.md#keys-what-you-configure-once).

## Doing several projects

Run `/paved-road:adopt` in each project directory. Tier 1 is fast and uniform, so a batch of
local projects can all reach the same baseline (working agreement + GitHub + Linear + CI)
quickly; reserve Tier 2 for the ones that genuinely belong on Cloudflare. Each adoption is its
own branch + PR — the discipline applies to adoption itself.

## Guarantees

- **Additive, never destructive.** `adopt` reads first, confirms before writes that aren't
  obviously safe, and confirms before every outward-facing action (repo creation, Linear,
  pushes). It adopts your code; it does not replace it.
- **Synthetic data only**, including when cleaning up existing seeds/fixtures.
- **Every change rides a branch + PR** — adoption included.
