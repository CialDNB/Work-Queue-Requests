# Open questions — decisions needed to finish the paved road

> **✅ Resolved 2026-06-13.** Every item below was answered by the platform owner — see the
> consolidated outcomes in [DECISIONS.md](DECISIONS.md) (entry "Platform decisions resolved").
> This file is kept as the question-and-recommendation record; DECISIONS.md is now canonical
> for what was chosen. A few items are **blocked on access** (B1 staging token/DNS, A1 email
> DNS/service) or **deferred** (A2 Entra, B2 internal-visibility + security slug, B3/B4) and
> remain tracked in Linear.

The kit ships at **v0.1.0**: scaffold, auth module, data layer, AI plumbing, CI/CD with
the tree-memo gate, the harness, and ten skills are all built and green (see
[CHANGELOG.md](../CHANGELOG.md) and [docs/DECISIONS.md](DECISIONS.md)). What's left to
"fully build the template" is mostly **platform wiring that needs a human with credentials**,
plus a handful of decisions that were defaulted during the build and deserve an explicit
yes/no now.

Each item below has a **recommendation** and a **default if you don't answer** — silence
means I proceed with the default and record it in [DECISIONS.md](DECISIONS.md). Anything
marked **🔒 needs you** can't be defaulted: it requires an action only you (or IT) can take.
Answer inline, in a comment on the linked Linear issue, or just tell me which defaults to flip.

Decisions trace back to the kickoff's D1–D12 (preserved in
[docs/PAVED-ROAD-KICKOFF-PROMPT.md](PAVED-ROAD-KICKOFF-PROMPT.md)); the D-number is noted
where one applies.

---

## Tier A — Blocks real (non-staging) functionality

These gate whether a kit app can actually authenticate real users and alert on failure.
Until they're resolved, apps run on staging with login links pulled from the SESSIONS KV outbox
by builders opted in via `MAGIC_LINK_OUTBOX` (GUIDEBOOK "First login"; links are never logged —
PIA C5).

### A1 — Magic-link email sending (D6) 🔒 needs you

**Question:** Zone email on `cialdnb.ai` is unconfigured (known from Atlas, HQ-18). How do
kit apps send magic-link emails — one central sender for all apps, or one per app? And who
configures the DNS (SPF/DKIM/DMARC + routing)?

- **Recommendation:** One central sender, `auth@cialdnb.ai`, configured once as a platform
  task; every kit app sends through it via the `EMAIL` binding seam. Per-app senders multiply
  DNS and deliverability surface for no benefit on internal tools.
- **Default if silent:** Kit stays as-is — email behind the transport seam, fail-open in dev,
  apps document "opt in, then fetch your link from the KV outbox" until the central sender
  exists. No app reaches production login without this.

### A2 — Identity / Entra SSO (D5) 🔒 needs you

**Question:** The auth module is built with an interchangeable seam (magic links today, Entra
SSO later, same `Principal`). To wire Entra we need: one shared **"CIAL Internal Apps"** app
registration with per-app redirect URIs vs. per-app registrations; **who creates it** (IT or
you); and the **tenant ID**.

- **Recommendation:** Single shared registration, you or IT creates it once, Entra lands
  behind the seam so each new app only adds a redirect URI + config. Magic links remain the
  day-one path so apps aren't blocked on IT.
- **Default if silent:** Magic links only; Entra documented as "pending setup" with this
  issue. The seam is already in place, so turning Entra on later is config, not code.

### A3 — Magic-link allowlist domains (D5)

**Question:** Which email domains count as "us" for invite-eligibility — `@cialdnb.com` only,
or also `@cballiance.com` and others?

- **Recommendation:** `@cialdnb.com` as the baseline allowlist; add `@cballiance.com` if
  cross-entity builders are expected. Invites remain explicit per app regardless of domain.
- **Default if silent:** `@cialdnb.com` only, set as the documented default in `/new-app`;
  widening is a one-line config change per app.

### A4 — Uptime & alerting destination (D9) 🔒 needs you

**Question:** Where do health-check failures and cron-heartbeat misses go? Builder's email
plus a central address? A Slack channel?

- **Recommendation:** Builder email + one central platform address now; a shared dashboard or
  Slack webhook later. Keeps the signal reaching a human without standing up infrastructure.
- **Default if silent:** Alerting wired to the app owner's email only (the value `/new-app`
  already collects); central address added when you name one.

---

## Tier B — Turns the kit on / hardens it

These don't block app-building, but they decide how exposed and how guarded the platform is.

### B1 — Living staging demo (D3)

**Question:** Keep the skeleton itself continuously deployed at `staging-paved-road.cialdnb.ai`
so the template is always smoke-tested? This needs `DEPLOY_ENABLED=true`, a scoped Cloudflare
token in repo secrets, and the DNS record — all in account `13878ca5…`, staging only.

- **Recommendation:** Yes, staging only. A continuously-deployed reference app is the best
  proof the template stays green, and the CI deploy job is already built and dormant.
- **Default if silent:** Stays dormant (CI green from commit one, no deploy). I can flip it on
  in one PR once you confirm the token + DNS, since no production anything is involved.

### B2 — Repo visibility

**Question:** `CialDNB/paved-road` is currently **private**. The kickoff (D2) suggested
private **or internal**. Internal makes it visible (read) to the whole CialDNB org — useful
for a "use this template" starter everyone can discover.

- **Recommendation:** **Internal** — a paved-road template works best when every builder in
  the org can find and instantiate it; the protected core + CODEOWNERS still gate changes.
- **Default if silent:** Stays **private** (most conservative); flip to internal anytime — it's
  a repo-settings toggle, no code impact.

### B3 — GitHub branch protection

**Question:** The PR-based flow (DECISIONS 2026-06-12) is convention + harness only; branch
protection on `main` is deliberately not enabled. Turn it on now, or keep it deferred?

- **Recommendation:** Enable a light ruleset once the **second CODEOWNER exists** (B4) — require
  a PR + passing CI + one review before merge. Until there's a second reviewer, protection on a
  solo-admin repo mostly just makes you bypass it, which trains the wrong habit.
- **Default if silent:** Stays convention-only (as recorded); revisit when B4 is answered.
- **Update (2026-06-24):** answered at the *per-app* level — branch protection is now a documented
  per-app choice, recommended ON at 2+ maintainers (`docs/COLLABORATION.md`, DECISIONS 2026-06-24).
  Open only for the **kit repo itself**.

### B4 — Second platform owner (CODEOWNER) 🔒 needs you

**Question:** `.github/CODEOWNERS` lists only `@yonico` on the protected core — a bus-factor of
one, and the blocker for meaningful branch protection (B3). Who's the second owner?

- **Recommendation:** Name one more trusted reviewer for the protected core (auth, data,
  framework, CI). Even one more removes the single point of failure.
- **Default if silent:** Stays solo; flagged as the top hardening gap in the handbook.
- **Update (2026-06-24):** at the *app* level, the handoff runbook now tells a forked app to list
  two owners in CODEOWNERS (`docs/COLLABORATION.md`). The **kit repo's** own second owner is still
  unfilled.

### B5 — Go-live gate: blocking vs. advisory items (D8)

**Question:** You're the go-live sign-off owner (confirmed). Of the `docs/GO-LIVE.md` checklist
items, which **block** a production DNS record vs. which are **advisory**?

- **Recommendation:** Blocking: security review run, synthetic-data/PII classification, auth +
  allowlist verified, backups observed working, named owner, rollback documented. Advisory:
  staging exercised in a browser, docs polish, budget-gate tuning. (I'll mark the checklist
  accordingly.)
- **Default if silent:** I apply that blocking/advisory split in `docs/GO-LIVE.md` and you
  adjust on the first real go-live.

---

## Tier C — Rollout & adoption

The kit is the product; these decide who drives the first miles.

### C1 — Pilot app & builder 🔒 needs you

**Question:** Which builder and which app should be the first to instantiate the kit, and what
do we want to learn (time-to-first-deploy, where `/new-app` snags, which docs get used)?

- **Recommendation:** Pick a genuinely new, low-risk single-tenant internal tool with a willing
  semi-technical owner — a tracker or dashboard touching no sensitive data — so the run
  exercises `/new-app` → build → staging → go-live end to end without production stakes.
- **Default if silent:** No pilot scheduled; the kit is ready whenever you name one.

### C2 — Migration of existing apps

**Question:** Which already-built apps (Atlas, Arena, lintercom, others) migrate onto the kit,
and in what order? The handbook has the assess → rehost → redirect → retire playbook.

- **Recommendation:** Sequence by risk-reduction value: the app with the worst current
  exposure (no auth / real data / personal cloud) first. Inventory them, then migrate one as a
  second proof after the C1 pilot.
- **Default if silent:** No migrations scheduled; an inventory issue is created so the list
  exists when you're ready.

### C3 — Supabase rubric confirmation (D10)

**Question:** Confirm the rule: Cloudflare D1 is the default; Supabase is permitted **only**
for genuinely Postgres-shaped needs (heavy relational queries, pgvector, realtime, existing-PG
integration), and using it requires a DECISIONS.md entry in the app.

- **Recommendation:** Adopt as written — it's already in the handbook (§5) and GUIDEBOOK.
- **Default if silent:** Adopted as written and promoted to a DECISIONS.md entry.

### C4 — Kit-upgrade strategy beyond v1

**Question:** Downstream apps receive kit improvements via `/kit-upgrade` (template-diff), since
template repos don't propagate. Is diff-against-template enough for v1, or do you want a stronger
channel (e.g. a versioned shared package for the protected core)?

- **Recommendation:** Keep `/kit-upgrade` (template-diff) for v1 — a kit you can read beats a
  dependency you must version; revisit a shared package only if drift becomes painful across
  several apps.
- **Default if silent:** `/kit-upgrade` as-is; the question is parked in DECISIONS as
  "revisit when N≥3 apps exist."
- **✅ Answered (2026-07-02):** Confirmed with a refinement — see DECISIONS.md "Kit-upgrade beyond v1
  (answers C4)". `/kit-upgrade` (template-diff) stays for v1; the versioned shared package is the agreed
  destination but **sequenced**: carve the core boundary in-tree now (`packages/core` + a `verify:core`
  drift gate — both below the N≥3 trigger and reversible), publish `@cial/paved-core` at N≥3 or when
  divergence bites. Framed as a cure for *divergence* drift (local-edit drift is already CI-enforced);
  the seam principle — seal invariant internals, expose typed extension points — governs the split.

---

## How to answer

- **Fastest:** comment the flips on the Linear "Decisions" issue (linked from the project), or
  just reply here with "A1 central, B2 internal, B4 = <name>, rest defaults."
- **🔒 items** also need the underlying action (DNS, app registration, naming a person) — those
  become their own Linear issues assigned to you.
- Every answered item lands as a **DECISIONS.md** entry (Decision / Why / Rejected); every 🔒
  action is tracked to closure in Linear.
