# Sensitive-Data doctrine (Phase 3) — DOCUMENTED, NOT YET IMPLEMENTED

> **Status.** This is the **ready-to-execute spec** for Phase 3 of the Sensitive-Data Protection
> capability. The cipher (P1) and the control-plane tripwire (P2) are **shipped**. The doctrine
> below is **documentation**; the **semgrep rule and any CI enforcement are intentionally NOT
> implemented yet** — a future session picks this up. The GO-LIVE preventive-lock gate is already
> specced in `docs/sensitive-data-capability-PLAN.md` (Phase 3) and partially in place; the rest of
> this file is the spec for the remaining P3 deliverables. Nothing here changes runtime behavior.

This doc is the single place that states **when** to seal a field and **how** to keep that choice
correct. Read it before adding any sealed column.

## 1. The decision rule — "Payload, never predicate"

Seal a field **only if all three hold**:

1. **High-sensitivity** — a salary, comp figure, national ID, per-record secret. Not "mildly
   private". Most PII does not clear this bar; the kit's RBAC + 404-uniformity + audit already gate
   it. Sealing is for the handful of columns where *reading the bytes at rest* is itself the breach.
2. **Display-only behind a permission gate** — shown to entitled users, never used to make a
   decision in SQL.
3. **Never a query predicate** — never in a `WHERE`, `ORDER BY`, `GROUP BY`, or `JOIN`.

Random-IV sealing makes the column **unqueryable / unsortable / unjoinable** — the same plaintext
seals to different ciphertext every time, so SQL can't match, range, or group it. **That is the
constraint, not a bug.** If you need to filter/sort/join on a value, it **cannot** be sealed;
redesign (e.g. keep a non-sensitive derived *bucket* column to filter on, and seal only the exact
value for display). Aggregate sealed values **in-Worker after `open*()`**, never in SQL.

## 2. Threat-model framing — data-plane vs control-plane

(To be added to `docs/IMPLEMENTATION-HANDBOOK.md` §7 as a sealed-field row + a short subsection.)

The boundary the seal buys is **data-plane vs control-plane**:

- **Data plane (covered):** anyone who reads bytes at rest — a D1 export, an R2 backup blob, the
  dashboard D1 console, a stolen *read-only* DB token — sees **ciphertext**. The Worker is the sole
  decryptor, and only *past* the permission gate.
- **Control plane (NOT covered):** a **deploy-capable admin** can read `SEAL_KEY` out of the running
  Worker (deploy a one-line Worker that logs it). The seal cannot stop that.
- Therefore the **tripwire (P2) is detective, not preventive** — it *reports* a control-plane change
  (a secret read, a Worker deployed by a non-CI actor); it cannot block the one-shot key read.
- The **actual lock** is the **preventive** half: least-privilege so humans can't deploy at all
  (only the CI service account) + branch protection. See the GO-LIVE preventive-lock gate
  (`docs/GO-LIVE.md` + the PLAN's Phase 3). The seal + tripwire are defense-in-depth around it.

**Honest limits (state them wherever this is documented):** detection ≠ prevention; key loss = data
loss (no envelope/escrow); the in-account watcher is in its own blast radius (the GitHub-Actions
variant is harder to silence); SQL can't aggregate sealed columns.

## 3. Decrypt-tie-to-the-gate doctrine (the required pattern)

The kit's decrypt seam (Decision 2) is **explicit `seal/open` at the repository's persistence
boundary**, not generic serializer wiring. The required pattern for any sealed field:

- **Seal on write** at the repository boundary (`await sealNumber(value, env)` before the `INSERT`/
  `UPDATE`); **open on read** only **after** the route's permission check has passed. Never `open*`
  a value the caller isn't entitled to see.
- **Serialize a withheld sensitive field as ABSENT, not null.** A `null` says "no value"; an absent
  key says "you may not see this" and is indistinguishable from a field the response never carries —
  consistent with how the kit already gates fields and with 404-uniformity. Concretely: build the
  response object **without** the key when the gate fails, rather than setting it to `null`.
- **The integrity throw is load-bearing.** `open*` throws on tamper/wrong-key rather than returning
  a plausible-but-wrong value. A serializer that decrypts a field must let that throw surface as an
  integrity error for *that field*, never swallow it into a default.

## 4. Semgrep rule design — enforce "payload, never predicate" in CI (TO IMPLEMENT)

> Not yet implemented. This is the design a future session executes in `semgrep/kit-rules.yml`
> (the kit's existing data fence), alongside `d1-access-outside-data-layer`.

**Goal:** fail CI when a **sealed column** appears in a `WHERE` / `ORDER BY` / `GROUP BY` / `JOIN`
predicate — catching the one correctness rule mechanically, not in review.

**Recognizing a sealed column (the open design question to settle first):** a static rule needs to
know which columns are sealed. Two viable mechanisms (pick one in P3, record it in DECISIONS):

- **(a) Naming convention — a `_sealed` column suffix.** Sealed columns are named e.g.
  `annual_cost_sealed`. The semgrep rule then flags any SQL string that contains a `*_sealed`
  identifier within a `WHERE|ORDER BY|GROUP BY|JOIN` clause. Simplest; self-documenting at the
  call site; no registry to keep in sync. Cost: a naming rule to follow.
- **(b) A small registry** (e.g. `src/crypto/sealed-columns.ts` exporting the list) that a rule (or
  a `verify:*` script) reads. More flexible (no rename), but adds a list to maintain and a custom
  check (semgrep can't easily read a TS array — this leans toward a `scripts/check-*.mjs` guard
  instead of a pure semgrep pattern).

**Recommended:** **(a) the `_sealed` suffix** — it keeps the rule a pure semgrep pattern (no new
script), makes sealing visible at every call site, and pairs naturally with the doctrine ("if it
ends in `_sealed`, it's display-only payload"). Sketch:

```yaml
# semgrep/kit-rules.yml (TO ADD in P3 — not present yet)
- id: sealed-column-as-query-predicate
  # Both languages, always — semgrep selects targets by EXTENSION, so `[typescript]` alone would
  # scan .ts/.tsx and nothing else, and this fence would silently skip any .js/.mjs/.cjs under
  # src/. That bug shipped twice (#212, #213). Nothing enforces this mechanically yet, which is
  # exactly why it is written here: this sketch is what the next person copies.
  languages: [typescript, javascript]
  severity: ERROR
  message: >
    A sealed column (…_sealed) must never appear in a WHERE / ORDER BY / GROUP BY / JOIN —
    random-IV sealing makes it unqueryable ("payload, never predicate"). Filter/sort on a
    non-sensitive derived column instead, and seal only the display value. See
    docs/sensitive-data-doctrine.md.
  # Pattern approach: match string literals passed to .prepare()/.bind() whose text contains a
  # *_sealed identifier inside a WHERE|ORDER BY|GROUP BY|JOIN clause. Finalize the metavariable-
  # regex against the first real sealed column; add fixture tests (a sealed col in a predicate
  # must flag; a sealed col only in SELECT/display must pass).
  paths:
    include: [src]
```

**Fixtures to ship with the rule (~5):** (1) `… WHERE annual_cost_sealed = ?` → flags; (2)
`… ORDER BY annual_cost_sealed` → flags; (3) `… JOIN … ON x.id = y.id` selecting `annual_cost_sealed`
→ passes (it's only in the SELECT/display projection); (4) a plain `SELECT annual_cost_sealed FROM …`
→ passes; (5) a non-sealed column in a `WHERE` → passes (no false positive).

## 5. `/security-review` sealed-field invariant (TO ADD to the skill)

> Not yet implemented. Add to `.claude/skills/security-review/SKILL.md` as an invariant.

When reviewing a diff (or the whole app at go-live), check:

- **Sealed column used as a predicate** (`WHERE`/`ORDER BY`/`GROUP BY`/`JOIN`) → **blocker**
  ("payload, never predicate"; the semgrep rule should already catch it, but review intent too).
- **Decrypt before the permission gate** → **blocker** (a value is `open*`'d on a path the caller
  isn't entitled to).
- **A withheld sensitive field serialized as `null` instead of absent** → **should-fix** (leaks
  "there is a value here" and breaks the absent-not-null doctrine).
- **A new high-sensitivity field added without sealing — or without a documented reason it doesn't
  need it** → **should-fix** (forces the decision rule to be applied consciously).
- **`SEAL_KEY` handling** — generated-and-vaulted (not piped write-only), per-app/per-env distinct,
  never committed → confirm against `docs/runbooks/sensitive-data-key.md`.

## 6. GO-LIVE preventive-lock gate (already specced)

The preventive half — least-privilege deploy + branch protection — is a **required, named GO-LIVE
blocking gate** (not a footnote). Its full spec (Cloudflare least-privilege; GitHub branch
protection + `production` Environment reviewers; the org-vs-personal caveat) is in
`docs/sensitive-data-capability-PLAN.md` (Phase 3). Wire it into `docs/GO-LIVE.md`'s blocking-gates
table when P3 is implemented.

---

**When P3 is implemented, update this header to "IMPLEMENTED" and remove the "not yet" caveats.**
