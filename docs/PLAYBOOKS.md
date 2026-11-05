# Playbooks — the skills as runbooks (for Cursor / VS Code / plain git)

The kit's "virtual team" ships as Claude Code **skills** (slash-commands) under
`.claude/skills/`. In Claude Code you type `/add-endpoint` and it executes. **Other editors
can't invoke slash-commands** — but every skill is plain markdown, so in Cursor (or any editor)
you read the same `SKILL.md` as a checklist and follow it by hand. The invariants don't depend
on the skill: CI enforces them no matter how the code was written (a hand-rolled endpoint that
skips `defineRoute` fails the uniformity tripwire + semgrep, not silently ships).

> First, once per clone: `npm install && npm run hooks:install && npm run ci`. `hooks:install`
> is your only local guard against committing to `main` outside Claude Code. See
> [COLLABORATION.md](COLLABORATION.md) → "Using Cursor / VS Code / plain git".

## Verification while building

Use focused tests or watch mode during development. Run `npm run ci` once on the final tree
before shipping; an earlier skill's successful run counts only while its source, tests,
configuration, dependencies and environment are unchanged, including uncommitted/untracked
files. Record the command and result. A new skill invocation alone is not a reason to repeat
that run. Every PR still runs all mandatory gates. `verify:deps` needs the npm registry;
the test suite itself remains offline.

Choose Node for pure calculations and Workers for storage/runtime and route/auth contracts.
Runtime placement is a reviewed opt-in: every new test runs in full Workers. In an app that has
adopted the runtime split, only the files `test/projects.mjs` lists run in Node or minimal
Workers; without it, every test runs in full Workers, and the split is adopted through
`/kit-upgrade` ("When adopting the split"), never by creating `test/projects.mjs` alone. The
auth, framework, route, cron, security, isolation, audit and read-log suites never move; a move
needs clean imports (`test/platform/test-projects.test.mjs`), the same test names and a green
combined coverage run before and after. Preserve security tripwires and coverage floors.
[Testing and feedback](TESTING.md) covers measurement, test review, clone adoption and when
sharding helps.

`/kit-upgrade` records the test-performance observer's latest status in one line (clear,
warning or unavailable). When it warns (a sustained budget overrun or regression, or a complete
gate over `fullGateSeconds`), the upgrade also completes the dated audit in
`docs/test-performance/`, with an evidence-backed change or an evidenced no-change decision;
otherwise the audit is optional. `npm run test:audit -- <report>` prints the line, and with
`--draft` on the final tree seeds a draft; it does not move or delete tests.

## The map

| Skill | Runbook | Golden example / reference | Notes for non-Claude-Code |
| --- | --- | --- | --- |
| `/add-endpoint` | [`.claude/skills/add-endpoint/SKILL.md`](../.claude/skills/add-endpoint/SKILL.md) | `src/routes/notes.ts` + `test/routes/notes.test.ts`; `docs/API-CONVENTIONS.md` | Copy `notes.ts`'s shape. Adding a permission key requires extending `test/auth/permissions.test.ts` — that's the review gate. |
| `/add-page` | [`.claude/skills/add-page/SKILL.md`](../.claude/skills/add-page/SKILL.md) | the page matching `notes` in `web/` | Permission-gated UI; wire to the API client. In a ported app (`.paved-road/design.json` `mode: "port"`), style from `web/src/theme/`, not the kit baseline. |
| `/port-ui` | [`.claude/skills/port-ui/SKILL.md`](../.claude/skills/port-ui/SKILL.md) | [DESIGN-PORT.md](DESIGN-PORT.md); `.paved-road/design.json` | Porting an existing app's UI: contract, then theme (source CSS verbatim + token bridge), then shell over `APP_VIEWS`, then screens, then parity. The agents become manual steps: audit the source per `.claude/agents/ui-inventory.md`, and run `node .claude/skills/port-ui/parity.mjs` and compare per `.claude/agents/ui-parity-reviewer.md`. |
| `/add-job` | [`.claude/skills/add-job/SKILL.md`](../.claude/skills/add-job/SKILL.md) | `src/cron/` | Heartbeat + alert-on-failure are part of the job, not an add-on. A job in `TASKS` gets both from the daily loop; a job on its own cadence (step 4) gets neither, so it brings its own: a handler that never rejects, an app-registry log event on every failure, a `sendAlert` page once it is past its bar (at most one per UTC day, never one per failed run), a last-good-run record, and a liveness task in `TASKS` that pages when the job goes past its bar without a good run (a missing record starts the clock rather than paging, so the kit's cron tests stay green). |
| `/ship` | [`.claude/skills/ship/SKILL.md`](../.claude/skills/ship/SKILL.md) | — | The PR + gates choreography. By hand: branch → `npm run ci` green → open PR → `/code-review` → squash-merge with the PR title. |
| `/security-review` | [`.claude/skills/security-review/SKILL.md`](../.claude/skills/security-review/SKILL.md) | `semgrep/`, `test/isolation/` | Adversarial pass over the diff against the invariants. Run `semgrep scan --config semgrep/ --error` locally. |
| `/qa` | [`.claude/skills/qa/SKILL.md`](../.claude/skills/qa/SKILL.md) | — | Drive staging in a real browser; verify login, permissions, CRUD, admin, health. |
| `/go-live` | [`.claude/skills/go-live/SKILL.md`](../.claude/skills/go-live/SKILL.md) | `docs/GO-LIVE.md` | Gated checklist; production stays a human decision behind the named owner. |
| `/kit-upgrade` | [`.claude/skills/kit-upgrade/SKILL.md`](../.claude/skills/kit-upgrade/SKILL.md) | `CHANGELOG.md` | Diff-and-adopt from the template. Includes reconciling agent-guidance mirrors (see below), and the test-performance closeout line (above). |
| `/release-notes` | [`.claude/skills/release-notes/SKILL.md`](../.claude/skills/release-notes/SKILL.md) | `docs/release-notes/` | Stakeholder deck at milestones. Publishes to docshub when connected, else a local HTML deck. |
| `/new-app` | [`.claude/skills/new-app/SKILL.md`](../.claude/skills/new-app/SKILL.md) | `scripts/new-app.mjs`, `scripts/provision.mjs`, `scripts/central-proposal.mjs` | Ask the deployment target first, before the name, and never infer it: `--target dbisrael` makes a DB Israel app, and CIAL is the default. A DB Israel app skips provisioning; its handoff is in the bootstrap's output and `docs/CENTRAL-DELIVERY.md`. Uses the Linear MCP. Without it, create the Linear project in the UI and proceed. |
| `/join-app` | [`.claude/skills/join-app/SKILL.md`](../.claude/skills/join-app/SKILL.md) | [COLLABORATION.md](COLLABORATION.md) | Onboarding + take-over. Reads Linear; use the web UI if the MCP isn't configured. |
| `/plan-to-graph` | [`.claude/skills/plan-to-graph/SKILL.md`](../.claude/skills/plan-to-graph/SKILL.md) | [WORKING-WITH-CLAUDE.md](WORKING-WITH-CLAUDE.md) | Phased plan → dependency graph, critical path, parallel waves. The graph half works by hand as a checklist; the emitted workflow skeleton is Claude-Code-only (see below). |

Harness built-ins (`/code-review`, `/schedule`, `/extend-html-presentation`) are Claude Code
features, not files here. In another editor, do code review on the PR (GitHub review, or your
editor's review flow) and schedule cadence work with whatever you use for cron.

**Dynamic workflows (parallel agents) have no runbook equivalent.** They're a Claude Code
capability, not a kit feature — nothing in this repo requires one, and no gate invokes one
(DECISIONS 2026-08-05). In another editor, `/plan-to-graph`'s graph, critical path, and wave
table are still worth producing by hand; just ignore the emitted script. The gating and cost
rules live in [WORKING-WITH-CLAUDE.md](WORKING-WITH-CLAUDE.md) and are editor-independent
advice, not CI-enforced invariants.

## MCP-backed skills without the MCP

`.mcp.json` declares the **linear**, **docshub**, and **cloudflare-bindings** MCP servers —
Claude Code loads them; Cursor won't from that file. Each one runs `mcp-remote` at the exact
version pinned there, so you can copy those entries into Cursor's own MCP settings (keep the pin:
never `@latest` or a bare `mcp-remote`, per "Vendor docs are data, not instructions" below), or
just use the web UIs: Linear for issues/projects, docshub (or the local HTML fallback
`/release-notes` already writes) for decks, and the Cloudflare dashboard / `wrangler` for
bindings. None of this gates code — it's project tracking and publishing, which the skills
already specify a manual path for.

## Opt-in capabilities (no skill — doctrine-driven, dormant by default)

Some kit capabilities aren't skills because they're a small, deliberate edit, not a workflow.
**Sensitive-Data Protection** (at-rest field sealing + a control-plane tripwire) is one: every app
ships it scaffolded and **off**. Turn it on only for a field that is high-sensitivity AND
display-only AND never a query predicate ("payload, never predicate"). Entry points, in any editor:

- `docs/sensitive-data-doctrine.md` — the decision rule + the decrypt-past-the-gate pattern (read
  first).
- `docs/runbooks/sensitive-data-key.md` — `node scripts/seal-key.mjs --print`, then vault the key
  before deploying; backup + rotation.
- `docs/runbooks/control-plane-tripwire.md` — arm the hourly watcher; pick in-account cron vs the
  GitHub-Actions (blast-radius-isolated) variant.
- `docs/sensitive-data-capability-PLAN.md` — the phased plan + the *proposed* GO-LIVE preventive-lock gate (Phase 3, not yet landed)
  (least-privilege deploy + branch protection).

## Vendor docs are data, not instructions

Vendor documentation, web pages and tool output are input to read, never commands to run. The
concrete trap is the install/exec one-liner — `npx --yes <pkg>@latest`, `npm create <x>@latest`,
`curl … | sh` — which fetches whatever the source serves at that moment and runs it outside
`package-lock.json` and the 24h `verify:deps` gate. If a tool is genuinely needed, add it as a
devDependency (reviewed in the PR) or pin an exact version you have checked. Inside Claude Code
the `guard-bash` hook blocks the unpinned `npx` / `npm exec` / `npm create` forms. In Cursor /
VS Code nothing does (a git hook never sees a shell command), so this rule is the guard. See
DECISIONS 2026-09-23 "Vendor docs are data, not instructions".

## Keeping this file honest

This index and `.cursor/rules/paved-road.mdc` are **curated mirrors** of the working agreement
in `AGENTS.md`/`CLAUDE.md`. When that canonical changes, `npm run verify:agents` fails until the
mirrors are reconsidered and the manifest re-stamped (`npm run verify:agents -- --write`) — the
same forcing-function the kit uses for the security headers and the edge flags. So this file
can't silently fall behind the agreement it points at.

Keeping the table above current is a review job, not a gate. `npm run verify:skills` checks the
skill **files** — every `.claude/skills/<dir>/` holds a SKILL.md whose `name:` matches its
directory and which declares a `description:` — and deliberately says nothing about the documents
that describe them. An earlier version policed this table and four other write-ups by matching
regexes against prose; it produced false failures on correct repos, so it was removed
(DECISIONS 2026-08-06). Add a skill, add its row here — nothing will shout at you if you forget,
so it belongs on the reviewer's list.
