# Release notes

Stakeholder-facing release-notes presentations for this app — what shipped, why it matters,
what's next. Produced by **`/release-notes`** at milestones (go-live, an adopted kit-upgrade,
a big project/epic done) and weekly while the app is actively developed.

- **With docshub connected**, decks publish to docshub and the link is recorded below.
- **Without docshub**, the deck is a self-contained `.html` file in this folder (open in any
  browser), versioned alongside the code — and can be pushed to docshub later.

Newest first. Each row: date · occasion · link/file · one-line summary.

| Date | Occasion | Deck | Summary |
| --- | --- | --- | --- |
| 2026-08-26 | **The private-data wave** — kit 0.2.1 + everything since (milestone catch-up) | [docshub v33](https://docshub.cballiance.com/p/KfujySG) (`/paved-road-release-notes`) · [full PR list](2026-08-26-august-wave-prs.md) | 50 PRs over three weeks: the private-data road (read-only Aurora views over Hyperdrive+Tunnel, reviewed binding allowlist, read ledger — #204/#205/#210/#215/#217), per-app secrets became per-Worker (#164/#165/#201), 24h dependency release-age gate (#193), fleet self-reporting incl. staging + AI-spend tripwire (#181/#189/#207/#209), route-declared repositories (#190/#195), two-roads rule (#192). Next: c360 Insights rides the road; next kit cut. |
| 2026-08-03 | **v0.2.0 cut** — first version since bootstrap (milestone) | [docshub v21](https://docshub.cballiance.com/p/KfujySG) (`/paved-road-release-notes`) · [full PR list](2026-08-03-v0.2.0-prs.md) | 68 PRs over six weeks: Entra SSO, the pre-Dunable hardening pass (9 PRs, adversarially reviewed), Dependabot 8→0 incl. both highs, stateless-MCP template (2026-07-28 spec), fleet version-lag now live, SPA Settings/nav defaults. Fleet adoption: AICOE-461. |
| 2026-06-23 | Pre-launch hardening (milestone) | docshub `/paved-road-release-notes` (superseded by the v0.2.0 version above) | Tester-ready pass — 57 review findings fixed across 9 PRs (#68–#76): DB-enforced WORM audit, AI fail-closed in prod, loud prod-login failure + go-live email gate, first-run fixes, reconciled docs. |
