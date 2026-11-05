# Modularization plan — publishing the paved-road core
**Status:** to modularize core components of paved road that we don't want other apps to mess with. On a related point, implement a path to prevent app drift from the paved road template and be aware when that's happening.

> **Status:** planned, deliberately deferred. The decision is recorded in
> [DECISIONS.md](DECISIONS.md) → *2026-07-02 — Kit-upgrade beyond v1 (answers C4)*, which is
> canonical; this doc is the expanded execution plan and the standing answer to *"why not yet."*
>
> **Where we are:** the **in-tree boundary** (Phase 0) and the **drift-integrity gate** (Phase 1)
> are the foundation this plan builds on. The **publish** (Phases 2–3) is what "modularization" means
> here, and it stays parked until the trigger below fires.

---

## TL;DR

- **The destination is right.** Eventually the protected core ships as a **versioned package**
  (`@cial/paved-core`) that apps *depend on*, instead of a copy each fork *vendors* and then edits.
- **The timing is not now.** Publishing at today's N≈1 versions seams few real apps have stress-tested
  results in a real legibility cost, for a payoff that only compounds across many consumers.
- **So we do the cheap half now and the expensive half later.** Draw the boundary and a drift gate
  **in-tree** today (reversible, no registry); publish the package, the reusable CI, and the shared
  configs **when the trigger fires** (≈3 consuming forks, or divergence starts to hurt).
- **This cures the *right* drift.** The problem is **divergence** (forks aging apart), not
  **local edits** (an app weakening an invariant) — that second one is already CI-enforced and needs
  no packaging.

---

## The problem: two kinds of drift, only one of them undefended

A "paved-road app" is a fork of this template. The protected core — `src/framework/`, `src/auth/`,
`src/data/`, `src/email/`, `src/security/`, `src/ai/`, `src/cron/`, `schema.sql`, the CI gates — is
roughly **two-thirds of the shipped code** (see the LOC split in the DECISIONS entry). Every fork
copies all of it, and from the moment of the fork that copy starts to age.

| | **Local-edit drift** | **Divergence drift** |
|---|---|---|
| **What** | An app edits the core to weaken an invariant (drops a permission check, distinguishes 404-vs-403, touches `env.DB` outside `src/data/`) | The kit fixes/improves the core; forks fall behind. A security patch (e.g. #91 token-hashing, #92 Entra) must be hand-diffed into every fork |
| **Defended today?** | **Yes.** The behavioral CI gates catch it regardless of packaging: the 404-uniformity tripwire (`test/isolation/`), the semgrep data-fence, the coverage floor, the permission matrix | **No.** Nothing carries a kit improvement into a fork except a human running `/kit-upgrade` — a manual `git checkout -p` hand-diff |
| **Fixed by** | Already fixed — leave it alone | **This plan** |

The cost of divergence drift is not flat: it scales with the number of forks **and** with every
security patch. At N forks, one core CVE fix is N hand-diffs, each an opportunity to get it subtly
wrong. That is the curve packaging flattens.

### What the ontology track already gave us (and what it didn't)

The route-registry / fleet work (#99–#102: the machine-readable manifest, the `KIT_VERSION` stamp in
`src/framework/version.ts`, apps self-reporting to the fleet registry) delivered the **read model**:
*"which apps are behind"* is now visible fleet-wide. That is real progress — but **visibility is not
remediation, and it is not integrity**:

- The registry reports a fork's **claimed** `KIT_VERSION`. Nothing yet proves the fork's core actually
  **matches** that version — an app can locally edit core without the number moving. (Phase 1 closes this.)
- Even when the registry says *"you're three versions behind,"* catching up is still a manual hand-diff.
  (Phase 2 turns it into `npm update`.)

**Packaging is the complement to the registry, not a substitute:** the registry answers *who is behind*;
`@cial/paved-core` + `verify:core` make *catching up cheap* and *prove the core is untampered*.

---

## The governing principle: seal the internals, expose a typed seam

The reviewer's instinct — "apps shouldn't be able to change auth on their own" — is right, but the
mechanism is **not a wall**. A wall (forbid all edits) breaks legitimate extension; Entra SSO (#92) is
exactly the kind of change a wall would have blocked. The rule is:

> **Seal the invariant-bearing internals. Expose a typed seam for everything an app legitimately varies.**

| Concern | Sealed (lives in the core) | Seam (how an app extends it) |
|---|---|---|
| HTTP surface | auth injection, CSRF, permission check, Zod validation, audit-on-write, opaque errors | `defineRoute()` — declare a route; the framework wraps it |
| Authorization | the permission-check engine, 404-uniformity | add a role/verb in the **permission registry**; the matrix test enforces it |
| Identity | session issuance, the `Principal` shape, fail-closed | **auth-provider registry** — magic-link + Entra mint the same `Principal`; add a provider, don't fork sessions |
| Data | the repository base, the `env.DB` fence | extend the base repository; never touch `env.DB` directly |
| Email | the transport seam, the on-brand shell | **template registry** — add a template |
| Outbound | the typed integration modules (`src/ai/` etc.) | add a typed module; routes never call `fetch()` |

Auth is the proof the seam model works: it is the most-sealed subsystem **and** it already has two
providers behind one interface. That is the pattern the whole core follows once packaged — **you can't
edit `sessions.ts`, but you can register a provider.**

---

## Why NOT yet — the deferral logic

All four reasons must be *false* before publishing is the right call. Today they're all true.

1. **Seam validation.** A published seam is a contract. At N≈1 you'd be freezing an `exports` surface
   that exactly one app has ever consumed — you'd version guesses. Each additional in-tree consumer
   *before* publishing is free stress-testing of where the seam is wrong. Publish the seam after it has
   survived contact with a second and third real app, not before.

2. **Legibility cost.** The kit's pedagogy is *"read the golden example."* A semi-technical builder
   opens `src/auth/sessions.ts` and sees how login works. A dependency in `node_modules` is not that —
   it's a version number and a changelog. That cost is worth paying once the core is stable and the
   fleet is large; it's pure loss while the core is still changing weekly and the fleet is tiny.

3. **The read model already covers visibility.** The one thing publishing would *urgently* buy —
   knowing which forks are behind — the ontology track already delivered. That removes the pressure to
   publish early; what's left (remediation + integrity) is cheaper to do in-tree until scale.

4. **Publishing infrastructure only pays back across N consumers.** A published package means a release
   process, a semver policy, a version matrix, a private registry (GitHub Packages), and CI to cut
   releases. That overhead is justified by *reuse*. Amortized over 1–2 apps it's a tax; over 3+ actively
   maintained forks receiving security patches, it's a saving.

### The trigger — how we know we're ready

Publish (start Phase 2) when **any one** of these is true — the platform owner tracks N:

- **N ≥ 3 actively-maintained consuming forks** exist (paved-road itself is the producer, not a consumer).
- **A security or correctness patch has had to be hand-diffed into ≥ 2 forks** — divergence has started
  to cost real work.
- **`verify:core` reports genuine integrity drift** across forks the fleet registry can see.
- **A fork is blocked** on catching up (can't take a fix without a painful manual merge).

Until then, the in-tree boundary + drift gate are the whole job, and they're reversible.

---

## The phased plan

### Phase 0 — draw the boundary in-tree *(the "now" work; reversible)*

Move the runtime core into an internal workspace package, `packages/core`, consumed by the template app
via a workspace dependency (`"@cial/paved-core": "*"`). **No registry, no version numbers, no publish.**

- **The one real design task is the public `exports` surface** — the seam. Everything the table above
  calls a "seam" is a named export; everything sealed is internal to the package and not re-exported.
- This is a **monorepo-of-one.** It does **not** commit us to an all-apps monorepo (explicitly rejected —
  it would fight the per-app owner / per-app Linear / per-app Cloudflare-account isolation model).
- Reversible: if it's wrong, it's a directory move back.

> _Fill in once landed:_ link the PR and the actual `packages/core/index.ts` `exports` list here, so
> this doc cites the real seam rather than the sketch above.

### Phase 1 — the drift-integrity gate *(the "now" work)*

Add `verify:core`, modeled on the existing `verify:plugin` / `plugins/paved-road/sync-from-harness.mjs`
pattern (which already fails CI when the bundled harness copy drifts):

- **Reuse the existing `KIT_VERSION`** stamp (`src/framework/version.ts`) — do **not** add a second stamp.
- Assert **no app file shadows a kit module** (a fork can't quietly override a sealed file).
- Assert **kit-owned files match the stamped version** (unmodified, or the diff is explicitly declared in
  DECISIONS.md). This is the integrity check the fleet registry can't do from a version number alone.
- Wire it into `npm run ci` alongside the other `verify:*` gates.

### Phase 2 — publish *(the "trigger" work)*

When the trigger fires, distribute **by artifact type** — not "npm-package everything":

| Artifact | Distribution mechanism |
|---|---|
| Runtime TypeScript core | **`@cial/paved-core`** on GitHub Packages (repo is already on GitHub + Dependabot, #90) |
| The CI gates | a **reusable GitHub Actions workflow** (e.g. `CialDNB/paved-ci`) forks reference, + the semgrep ruleset **published**, not copied |
| System DB tables | the `schema.sql` **SYSTEM** tables shipped as **versioned migrations** from the package (the SYSTEM/APP split already exists) |
| Shared configs | base `tsconfig` / `biome` / `wrangler` configs the app **`extends`** |
| The harness (`.claude/`) | already solved — the plugin + `verify:plugin` |
| Secrets, DNS, per-fork identity | **stay per-app** — never packaged |

Convert the template and the app-registry to consume the published version. **One package to start** —
not per-domain splits (`@paved/auth`, `@paved/data`, …); the `defineRoute → auth → data` coupling makes
early splitting a version-matrix burden for no gain.

### Phase 3 — flip the gates *(the "trigger" work)*

Once apps consume a version instead of a copy:

- **Go-live requires `paved-core ≥` a floor version** (a stale fork can't ship to prod).
- **`/kit-upgrade` changes meaning** — from "hand-diff the template" to "bump the dependency + run
  migrations." The skill becomes a dependency bump, not a merge.
- **CODEOWNERS shrinks** from guarding the whole core to guarding only the seam definitions and shared
  configs (the package boundary now does the heavy lifting).

---

## Explicitly *not* doing

- **Publishing now, at N≈1** — premature; freezes unvalidated seams and pays the legibility cost before a
  second consumer justifies it.
- **A monorepo holding all apps** — fights per-app owner / Linear / Cloudflare-account isolation. Polyrepo
  + a published package is the model; `packages/core` is a monorepo-*of-one* only.
- **Splitting the core into per-domain packages up front** — one package until a real independent-release
  seam appears.
- **Sealing auth as a wall** (forbidding edits outright) — breaks legitimate extension like Entra.
- **Retiring the CI behavioral gates** once packaged — they defend *local-edit* drift, which packaging
  does not address. They stay.

---

## Design questions to settle at Phase 2 (not before)

- **The exact `exports` surface.** The hard one. Every export is a support commitment; under-export and
  apps monkey-patch, over-export and you've sealed nothing. Phase 0's in-tree seam is the draft; Phase 2
  ratifies it as the published contract.
- **Semver policy for a seam.** What counts as a breaking change (removing/renaming an export, tightening
  a type, changing `Principal`)? Breaking changes are the expensive ones across N forks — define the rule
  before the first `2.0.0`.
- **Migration ownership.** System-table migrations ship *from* the package and run in the app; settle how
  an app applies them on upgrade (and how that interacts with the daily-backup / restore drill).
- **The workspace → published-dependency cutover.** How an app moves from `"*"` (workspace) to `"^1.2.0"`
  (registry) without a flag day.

---

## How we'll know it worked

- A core security patch reaches every fork via **`npm update @cial/paved-core` + a migration**, not N
  hand-diffs.
- **`verify:core` proves integrity** — the fleet registry's version numbers are trustworthy because
  nothing can claim a version its code doesn't match.
- A **new app onboards by depending on a version**, and the golden-example legibility is preserved through
  docs + the (still-readable) template, not lost to `node_modules`.

---

## References

- [DECISIONS.md](DECISIONS.md) — *2026-07-02 — Kit-upgrade beyond v1 (answers C4)* (canonical decision)
- [DECISIONS.md](DECISIONS.md) — *2026-07-02 — The app manifest: routes as a machine-readable ontology*
  (the read-model this complements)
- [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) — C4
- `src/framework/version.ts` — the `KIT_VERSION` stamp Phase 1 reuses
- `plugins/paved-road/sync-from-harness.mjs` — the `verify:plugin` pattern Phase 1 mirrors
- [SECURITY-EDGE.md](SECURITY-EDGE.md) — the sibling "full plan, phased" doc this one is modeled on
