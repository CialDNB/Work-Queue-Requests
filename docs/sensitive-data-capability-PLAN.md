# Sensitive-Data Protection — phased capability plan

A four-layer, **opt-in, dormant-by-default** capability that lets any kit app protect
*individually sensitive fields* (salaries, comp, national IDs, per-record tokens) against
an attacker who can read the **data at rest** — a D1 dump, an R2 backup, the dashboard D1
console, or a leaked read-only credential. It is a **bundle**: the four layers only work
together. Ported and generalized from a proven Atlas implementation (`src/crypto/money.ts`,
`src/scenarios/persist.ts`).

> **What this is NOT.** This is not blanket encryption and not a substitute for the existing
> RBAC/uniformity/audit controls. It seals a *small, deliberately chosen* set of columns and
> leaves everything else queryable. Most columns must never be sealed. See "The decision
> rule" below — the kit's job is to make the right choice easy and the wrong one (sealing a
> query predicate, skipping the key backup) hard.

## The boundary this buys (read first)

The protection is **data-plane vs control-plane**:

- **Data plane (what the seal covers):** anyone who reads bytes at rest — a D1 export, an R2
  backup blob, the dashboard D1 console, a stolen *read-only* DB token — sees **ciphertext**,
  not the salary. The Worker is the sole decryptor, and only *past* the permission gate.
- **Control plane (what the seal does NOT cover):** a **deploy-capable admin** can read the
  key out of the running Worker (deploy a one-line Worker that logs `env.SEAL_KEY`). The seal
  cannot stop that — so the control-plane **tripwire** (Layer 3) is **detective, not
  preventive**: it *reports* an out-of-band control-plane change (a secret read, a Worker
  deployed outside the sanctioned CI actor); it cannot block it.
- **The actual lock** (the preventive half) is least-privilege so humans can't deploy at all
  (only the CI service account can) + branch protection on the deploy branch. P3 ships this as a
  **required, named blocking gate in `docs/GO-LIVE.md`** (not a footnote) — see Phase 3's GO-LIVE
  preventive-lock gate for the two parts (Cloudflare least-privilege; GitHub branch protection +
  `production` Environment reviewers) and the org-vs-personal caveat. The seal + tripwire are
  defense-in-depth *around* that lock, and a meaningful mitigation for the shared-account residual
  risk recorded in `docs/SECURITY-EDGE.md` ("Account isolation").

Honest limits, stated everywhere this is documented:
- **Detection ≠ prevention.** The tripwire reports a one-shot key read; it can't stop it.
- **Key loss = data loss.** There is no envelope/escrow scheme. Lose the key → every sealed
  value is permanently unrecoverable. This is why Layer 2 (generate-and-vault-first) is the
  headline improvement over Atlas.
- **SQL can't aggregate sealed columns.** Random-IV sealing makes a column
  unqueryable/unsortable/unjoinable. Sum/sort/filter happen *in-Worker after open()*.
- **Watcher-in-blast-radius.** An in-account cron tripwire can itself be silenced by a
  deploy-capable admin. The out-of-account (GitHub Actions) variant can't — documented
  trade-off, app picks (see Layer 3 / Decision 3).

## The decision rule — "Payload, never predicate"

Seal a field **only if all three hold**:

1. **High-sensitivity** — a salary, comp figure, national ID, per-record secret. Not "mildly
   private". Most PII does not meet this bar; RBAC + uniformity already gate it.
2. **Display-only behind a permission gate** — it is shown to entitled users and never used to
   make a decision in SQL.
3. **Never a query predicate** — never appears in a `WHERE`, `ORDER BY`, `GROUP BY`, or `JOIN`.

Random-IV sealing makes the column unqueryable — that is the **constraint, not a bug**. If you
need to filter/sort/join on it, it cannot be sealed; redesign (e.g. keep a non-sensitive
derived bucket column for filtering, seal only the exact value). Layer 4 enforces rule 3
mechanically in CI via semgrep, so the one correctness rule is caught before review.

---

## Phasing (each ships independently; a later phase slipping never blocks an earlier one)

Dependency order: **P1 → P2 → P3 → P4**. P1 stands alone (the cipher + safe key handling are
useful immediately). P2 (tripwire) is independent of P1 and could even ship first, but is
ordered after because the cipher's threat model is what *motivates* it. P3 (doctrine +
guardrail) documents and fences P1+P2. P4 wires both into `/new-app` + `/kit-upgrade`.

### Phase 1 — Sealing primitive + key lifecycle — ✅ SHIPPED

> **Status: implemented** (`src/crypto/seal.ts`, `scripts/seal-key.mjs`,
> `docs/runbooks/sensitive-data-key.md`, `test/crypto/seal.test.ts`).

**Size: M.** Surface area: 2 new src files, 1 new test file, 1 new runbook, 1 modified
provisioning script (or new helper), env.ts + the three wrangler configs touched, CHANGELOG +
DECISIONS entries. New external dependencies: **none** (Web Crypto only). New endpoints: none.
Test count: ~30 unit tests (the seal/open matrix). Decision points resolved: 1 (key store), 2
(decrypt seam — deferred to a documented doctrine, no invasive wiring), with the rationale in
this doc + the PR.

Deliverables:
- `src/crypto/seal.ts` — generalized `sealNumber`/`openNumber`, `sealText`/`openText`,
  `sealJson`/`openJson`. AES-256-GCM, packed `base64(iv(12) || ciphertext+tag)`, fresh random
  IV per value (no equality leakage), module-cached key (re-imports on rotation), **integrity
  throw — never substitute**, errors that leak no plaintext, null/undefined passthrough. Key
  from `env.SEAL_KEY` (64 hex chars = 32 bytes), resolved via the existing `getSecret()` (so it
  works as a plain Worker secret OR a Secrets Store binding — same seam as `ANTHROPIC_API_KEY`).
  Generic key name, no `ATLAS_` prefix, no hardcoded ids.
- `test/crypto/seal.test.ts` — round-trips for number/text/JSON; null/undefined passthrough;
  unique-ciphertext-per-call (IV randomness); integrity throw on tamper/truncation/wrong-key;
  no-plaintext-in-error-message; bad-key-config throws distinctly (deployment fault, outside the
  per-value catch); unicode/empty/large-text; non-finite-number rejection; `SEAL_KEY` absent
  throws the config error.
- `env.ts` — add `SEAL_KEY?: string | SecretsStoreSecret` to the secrets block (optional:
  unset = capability dormant; resolving it only happens when an app actually seals a field).
- **Key lifecycle done right** (the headline fix over Atlas's pipe-and-forget):
  - A **`scripts/seal-key.mjs`** generate-and-print helper that mints 32 random bytes as 64 hex
    and **prints them to stdout with explicit vault-first instructions** — it does NOT pipe
    straight into `wrangler secret put`. The operator must capture the value into the org vault
    (1Password / KMS) **before** it goes write-only into Cloudflare. Backing up the key is made
    hard to skip by two guards: a `--print` acknowledgement (no key is ever emitted unasked) and
    a refusal to write the key when stdout is not a terminal — so `seal-key.mjs --print | wrangler
    secret put SEAL_KEY`, the pipe-and-forget one-liner, is rejected rather than merely
    discouraged. `--json` remains the deliberate machine-readable mode for automation that owns
    its own vaulting step. Both guards are pinned by `test/platform/seal-key.test.mjs`.
  - **Per-app distinct key by construction** — the secret name is per-Worker (no sharing across
    apps), same posture as the existing per-app `<APP>_*` Secrets Store prefix.
  - `docs/runbooks/sensitive-data-key.md` — backup + rotation runbook. Rotation = decrypt-with-old
    / re-seal-with-new (no envelope scheme), so it documents the migration shape and the hard rule
    that the **old key must be retained until re-seal completes**. States plainly: lose the key →
    lose the data.
  - `.dev.vars.example` (if present) / wrangler.test.jsonc gets a throwaway test `SEAL_KEY` so the
    suite can exercise sealing without a real secret.

Ships standalone: an app can seal a field today with explicit `seal/open` calls at its
repository's persistence boundary, with a real key-backup story. Layers 2–4 harden the
*operational* and *enforcement* story but are not required to use the cipher safely.

### Phase 2 — Control-plane tripwire (independent of P1) — ✅ SHIPPED

> **Status: implemented.** Ported from Atlas's **hardened, merged** `audit-watch` (PRs #123 +
> #124), not the first draft — every load-bearing correctness property below is carried, and the
> kit's 21-case + 2 cron-routing tests pin them. Dormant by default (no `AUDIT_API_TOKEN` → the
> hourly tick no-ops and audits a skip).

**Size: M–L.** Surface area: 1 new cron module (`src/cron/auditWatch.ts`) dispatched by
`controller.cron` in `src/cron/index.ts` (the hourly tripwire cron vs. the daily ops loop); a KV
cursor + a KV "seen" dedup set (the existing `SESSIONS` seam — KV, not D1, to stay off the
audited DB path); reuse of the kit's `sendEmail` transport + the `ALERT_EMAIL`/Slack alert channel
and a new branded `securityAlertEmail` template (DANGER header); `env.ts` + both wrangler configs
(hourly cron, `AUDIT_DEPLOY_ACTORS`/`AUDIT_MATCH` vars, a commented `AUDIT_API_TOKEN` Secrets Store
binding — dormant); `docs/runbooks/control-plane-tripwire.md`. Test count: 23 (21 detect/orchestrate
+ 2 cron-routing). Decision points resolved: 3 (tripwire hosting).

Load-bearing correctness properties carried from the hardened Atlas original (each fixes a
confirmed false-negative a max-effort review caught in the first draft):
- **Scoping** matches the fragment against the **whole entry except actor/ip** — a real CF audit
  entry puts a UUID in `resource.id` + a bare verb in `action.type`, and the human name only in
  `newValue`/`newValueJson`/`metadata`; matching resource/action alone would miss every D1/secret/
  script change. Excluding actor blocks fragment-in-email spoofing.
- **Dedup by event ID** (a KV "seen" set) + the `since` window — **never** timestamp comparison
  (RFC3339 `when` arrives in mixed sub-second/offset forms that mis-order under string compare).
- **Ingestion-lag cursor** — trails real time by `SAFETY_LAG` (20m) and re-queries the overlap; on
  pagination truncation advances only to the newest **fetched** event (drains the backlog), never
  to `now`.
- **Fail-safe** — the whole run is wrapped, degrades to an `audit_watch_error` row, never rejects
  the cron, never advances the cursor on error.
- **First-run / lost cursor** scans a 1h lookback (doesn't skip the gap).
- **Token via `getSecret()`** (Secrets Store binding | string) — never raw (a raw binding →
  `Bearer [object Object]` → 401).
- **Empty allowlist flags everything** (safe default); the **forensic audit row is written before
  the alert** (forensics survive a mail failure).

As built:
- **Pure core `detectSuspicious(entries, cfg)`** (no I/O, fully unit-testable) — the security
  logic, exported and tested independently.
- **`runAuditWatch(env, now)`** orchestrator dispatched on the hourly cron (`SECURITY_WATCH_CRON`)
  via `controller.cron` in `src/cron/index.ts`, so the daily ops loop is untouched.
- Generalized — `AUDIT_MATCH` (defaults to `APP_NAME`), `AUDIT_DEPLOY_ACTORS`, `CF_ACCOUNT_ID`
  (reused), `ALERT_EMAIL` (reused), `DASHBOARD_HOST` (reused). **No** Atlas account id, no `atlas`
  literal, no `ATLAS_` names.
- **Both hosting variants** in `docs/runbooks/control-plane-tripwire.md` (Decision 3): the
  in-account cron is the default; the **GitHub-Actions-scheduled** variant (outside the CF account,
  can't be silenced by a deploy-capable admin) is documented with its trade-off. The pure core is
  plain TS with no Worker bindings, so it ports to the Actions variant unchanged.

Ships standalone: an app gets control-plane change detection without touching the cipher.

### Phase 3 — Doctrine + mechanical guardrails — 📋 DOCUMENTED, NOT YET IMPLEMENTED

> **Status: specced only.** The doctrine + threat-model framing live in
> `docs/sensitive-data-doctrine.md` (and the GO-LIVE preventive-lock gate is already specced
> below). The **semgrep rule and any enforcement are intentionally NOT implemented in this phase** —
> a future session picks up the ready-to-execute spec in that doc. The GO-LIVE preventive-lock gate
> spec (below) is complete and ready to wire when P3 is implemented.

**Size: S–M.** Surface area: 1 new semgrep rule in `semgrep/kit-rules.yml`; a doctrine section
added to `docs/IMPLEMENTATION-HANDBOOK.md` (threat-model framing: data-plane vs control-plane); a
**new, named, REQUIRED `docs/GO-LIVE.md` blocking gate** for the preventive lock (least-privilege
deploy + branch protection — a checklist gate with evidence, not a footnote); an extension to the
`/security-review` skill (a sealed-field invariant). Test count: ~5 (semgrep rule fixtures — a
sealed column in a WHERE/ORDER BY/JOIN must flag; a sealed column only in SELECT/display must
pass). Decision points resolved: 5 (skill — fold into existing skills + this doctrine doc; no new
skill).

Deliverables:
- **Semgrep rule** that flags any column annotated as sealed appearing in a `WHERE` / `ORDER BY`
  / `GROUP BY` / `JOIN` predicate — the "payload, never predicate" rule, enforced in CI not
  review. (Mechanism: a naming convention — sealed columns carry a `_sealed` suffix, or a
  registry the rule reads — so the static rule can recognize them. Finalized in P3 against the
  first real sealed column; the convention itself is a P3 decision recorded in DECISIONS.)
- **Threat-model framing** in the handbook (§7 threat model gets a sealed-field row; a new
  subsection states data-plane vs control-plane, detective-not-preventive, key-loss-is-data-loss).
- **Decrypt-tie-to-the-gate doctrine:** the RBAC/serializer layer decrypts only *past* the
  permission check and serializes sensitive fields as **absent, not null** (mirrors how the kit
  already gates fields). Documented as the required pattern; the explicit-`seal/open`-at-the-
  persistence-boundary seam (Decision 2) keeps this out of invasive generic wiring.
- **`/security-review` extension** — a sealed-field invariant: any sealed column used as a
  predicate (blocker); decrypt before the permission gate (blocker); a new high-sensitivity
  field added without sealing-or-a-documented-reason (should-fix).
- **GO-LIVE preventive-lock gate — a REQUIRED, named blocking gate in `docs/GO-LIVE.md`, NOT a
  footnote.** The seal + tripwire are *detective* defense-in-depth; the actual **lock** is least
  privilege + branch protection, so any app that seals a field gets a concrete go-live gate with
  evidence (added to the numbered blocking-gates table, alongside gates 1–12). It has two parts,
  both checkboxes:
  - **(a) Cloudflare least-privilege.** Minimize Super Admins (a Super Admin cannot be constrained
    by roles, so they can always deploy and thus always read the key). Give everyone else **scoped
    roles WITHOUT Workers-edit**, so they genuinely cannot deploy → cannot read `SEAL_KEY` from the
    running Worker. Deploys run as a **dedicated CI service account**, never a human. *Evidence:*
    the account's member/role list shows ≤ the named Super Admins and no human with Workers-edit
    outside the CI service account.
  - **(b) GitHub branch protection on the deploy branch** (the branch production deploys from —
    `main`). Require a PR + passing status checks, **block force-push and deletion**, and enable
    **"include administrators"** (without it, branch protection is theater — an admin just pushes
    past it). Gate production behind a `production` **GitHub Environment with required reviewers**
    (already wired in `deploy-prod.yml` / `provision-production.yml` — the go-live owner is the
    reviewer). *Evidence:* the branch-protection settings screenshot + the Environment reviewer
    list. **Org-vs-personal caveat the gate MUST call out** (real apps hit this): branch protection
    and required reviewers on a **private repo under a personal account** may need **GitHub Pro**,
    or the repo to live in an **organization**. So the gate tells the builder to **host the app in
    the org** (the recommended path) — or, if it stays on a personal private repo without Pro,
    record in `docs/DECISIONS.md` that **this lock is unavailable and the control-plane tripwire is
    the only backstop** (a conscious, documented downgrade, since the preventive half is then
    missing). This is a decision checkbox, not a silent assumption.

  Without this gate, the seal is defense-in-depth around an open door — a deploy-capable human can
  read the key, and nothing detective stops the one-shot read.

Ships standalone: doctrine + the CI fence are valuable the moment any app seals a field.

### Phase 4 — `/new-app` + `/kit-upgrade` wiring (adoptability)

**Size: S.** Surface area: a `/new-app` step (the capability is **present-but-dormant** —
Decision 4); a `/kit-upgrade` note so existing apps pull it; a `docs/PLAYBOOKS.md` mirror entry;
possibly a tiny `/seal-field` *helper* doc folded into `/add-endpoint` (NOT a standalone skill —
Decision 5). Test count: ~0 new (rides existing bootstrap/agent-guidance drift guards). Decision
points resolved: 4 (`/new-app` posture = dormant-but-present).

Deliverables:
- `/new-app` mentions the capability and leaves it dormant (no `SEAL_KEY` provisioned, no sealed
  columns) — an app turns it on per-field deliberately, following the doctrine.
- `/kit-upgrade` CHANGELOG note + adoption path (pull `src/crypto/`, the cron task, the semgrep
  rule, the runbook, the doctrine).
- `docs/PLAYBOOKS.md` + the agent-guidance mirrors reconciled (the `verify:agents` drift guard
  forces this).

Ships standalone: pure wiring/discoverability; the capability already works without it.

---

## Decision points (defaulted conservatively for this PR — confirm in review)

The brief routes 5 decisions to the maintainer. Since they can't be confirmed interactively,
each is defaulted to the **conservative, documented** choice. All are reversible.

1. **Key store + rotation → per-Worker secret (Atlas's choice), resolved via `getSecret()` so
   Secrets Store works unchanged.** Rationale: it's the simplest store that already exists in the
   kit, needs no new infrastructure, and matches the per-app isolation posture. Because the kit
   reads it through `getSecret()`, an app that prefers Secrets Store or external KMS just binds
   `SEAL_KEY` differently in wrangler — no code change. Rotation = decrypt-old/re-seal-new
   (documented in the runbook); there is no envelope scheme to standardize, so the store choice
   doesn't change the rotation story. **Confirm in review.**

2. **Decrypt seam → explicit `seal/open` calls at the repository's persistence boundary, NOT
   invasive generic repository/serializer wiring.** Rationale: generic wiring would touch the
   protected-core serializer for every app whether or not it seals anything, couples the cipher to
   the RBAC layer's shape, and is hard to reason about per-field. Explicit calls keep sealing
   *opt-in and visible* at the exact column, are trivially testable, and match how Atlas did it.
   The doctrine (P3) still *requires* decrypt to happen past the gate and fields to serialize as
   absent-not-null — it's a documented pattern, not generic plumbing. **Confirm in review.**

3. **Tripwire hosting → ship the in-account cron as the default AND document the GitHub-Actions
   variant; the app picks.** Rationale: the in-account cron reuses the kit's existing cron +
   alerting (no new infra) and is the right default for most internal apps. But it sits in its own
   blast radius, so the out-of-account variant is documented for apps that need a watcher a
   deploy-capable admin can't silence. (Layer 3 / Phase 2.) **Confirm in review.**

4. **`/new-app` default posture → dormant-but-present (opt-in).** Rationale: most apps seal
   nothing; the constraint (unqueryable columns) and the operational cost (a key that, if lost,
   destroys data) mean blanket-on is wrong. The capability is scaffolded and one doctrine-read
   away, but off until an app declares a sensitive field. **Confirm in review.**

5. **Surface → fold into existing skills (`/add-endpoint`, `/security-review`, `/add-job`) + a
   doctrine doc; NO dedicated `/seal-field` skill.** Rationale: sealing a field is a small,
   doctrine-driven edit at a persistence boundary, not a multi-step workflow that warrants its own
   skill. A standalone skill would also risk making sealing feel routine — the opposite of the
   opt-in intent. The decision rule + the semgrep fence + the `/security-review` invariant do the
   teaching. **Confirm in review.**
