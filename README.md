# Paved Road

**CIAL's starter kit for internal apps.** Click "Use this template", open Claude Code,
run `/new-app`, and start talking — everything that comes out runs on approved
infrastructure with auth, RBAC, audit, backups, CI gates, budget-capped AI, Linear
tracking, and a go-live process already in place.

**Start here → [GUIDEBOOK.md](GUIDEBOOK.md)** (the plain-language guide for builders).

**Joining or taking over an app someone else built?** Run `/join-app` and read
[docs/COLLABORATION.md](docs/COLLABORATION.md) — the kit handles more than one person too.

## Overviews by audience (slide decks)

Audience-pitched walkthroughs, hosted on docshub (CIAL-internal — behind login, not
visible to a fork):

- **Leadership** — [The Paved Road — Leadership Overview](https://docshub.cballiance.com/p/ptFNVHr): why it exists, the cost & governance story, status and the asks.
- **Technical / security reviewers** — [Technical Overview](https://docshub.cballiance.com/p/zKVdh1C): the `defineRoute` pipeline, the security invariants, the CI gates, and the Cloudflare edge.
- **Builders** — [Builder's Implementer Handbook](https://docshub.cballiance.com/p/AFCLqnu): every step from the template button to production, with the exact commands.

The decks are overviews; the in-repo docs (GUIDEBOOK, the handbook below, DECISIONS) are
canonical when they differ.

## What's in the box

| | |
| --- | --- |
| Runtime | Cloudflare Worker (Hono) + Vite/React SPA, on the Cial account |
| Auth | Magic links (passwordless), invite-only, sessions, roles, force-logout; Entra SSO-ready seam |
| Security | Fail-closed everywhere, 404-uniformity tripwire, CSRF, append-only audit, semgrep data fence |
| Data | D1 + repositories, daily backups to R2, KV sessions |
| AI | Anthropic via AI Gateway, payload logging off, $0.50/$5/$50 budget gates |
| CI/CD | biome (hard gate), typecheck, 230+ test suite + coverage floor, gitleaks, actionlint, semgrep; staging auto-deploy + /_health smoke; prod manual behind [docs/GO-LIVE.md](docs/GO-LIVE.md) |
| Harness | [CLAUDE.md](CLAUDE.md), guard hooks, 13 skills (/new-app /join-app /add-page /add-endpoint /add-job /security-review /qa /ship /go-live /kit-upgrade /release-notes /plan-to-graph /port-ui) and 2 subagents; working with Claude well is [docs/WORKING-WITH-CLAUDE.md](docs/WORKING-WITH-CLAUDE.md) |
| Ops | /_health, daily cron heartbeat, failure alerting, [docs/RESOURCES.md](docs/RESOURCES.md) manifest |
| Delivery | A **standard CIAL app** (the default) deploys from its own CI. A **DB Israel app** (opt-in at `/new-app`) is released by the central DB Israel pipeline, and is not enrolled or deployed until the platform enrolls it. See [Deployment targets](#deployment-targets). |

## Deployment targets

`/new-app` asks first: "Is this a DB Israel application deployed under dbisrael.ai, or a standard
CIAL application?" No answer means CIAL, and the target is never inferred.

- **CIAL** (the default): the app's own GitHub Actions provision and deploy it on the CIAL
  Cloudflare account, at `staging-<app>.cialdnb.ai` and, after go-live, `<app>.cialdnb.ai`.
- **DB Israel**: the bootstrap (`node scripts/new-app.mjs <name> --target dbisrael`) writes the
  deployment marker and the central release caller, points both wrangler configs away from any
  Cloudflare account, and prints the platform handoff and a draft catalog entry
  (`npm run central:proposal`). The central pipeline then releases
  `<app>.staging.dbisrael.ai`, and the app's CIAL provision and deploy paths refuse to run. It is
  **not enrolled or deployed until the platform enrolls it**; the app's own
  `docs/CENTRAL-DELIVERY.md` says what happens until then.

`npm run deployment-target` prints an app's target. Changing it later is a reviewed migration.
See [GUIDEBOOK.md](GUIDEBOOK.md#deployment-targets).

## For maintainers

The complete spec — architecture rationale, runbooks, threat model, upgrade path — is
[docs/IMPLEMENTATION-HANDBOOK.md](docs/IMPLEMENTATION-HANDBOOK.md). Decisions live in
[docs/DECISIONS.md](docs/DECISIONS.md) (append-only). Kit changes are versioned in
[CHANGELOG.md](CHANGELOG.md); downstream apps adopt them via `/kit-upgrade`.

## Quick commands

```bash
npm install
npm run ci             # everything CI runs: types, lint, build, tests + coverage
npm run db:apply:local # one-time: apply the schema to your LOCAL D1 (run before `npm run dev`)
npm run dev            # worker on :8787       npm run dev:web   # SPA with proxy
npm run new-app <name> # rename the template (or run the /new-app skill — the supported path)
npm run provision      # create CF resources
```
