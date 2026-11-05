# Runbook — finishing the Secrets Store → per-Worker migration

**State at last measurement (2026-08-14): 66 / 100 store secrets.** Three Workers are migrated and
verified (`dunable-staging`, `app-registry`, `app-registry-staging`); their six store entries are
deleted. The rest of the fleet is still to do.

Read [../SECRETS.md](../SECRETS.md) first — it is the *what goes where* rule. This is the *how to
move what's left*.

---

## Why this isn't finished yet

The store refills while you drain it. During the first execution day it went 71 → 67 (four orphan
deletes) → **71 again** within hours: two Cloudflare Access service tokens from the tunnel rollout
and two from a newly bootstrapped app. Two structural fixes are in place —
new apps no longer mint store secrets (KIT-A), and the Bruno collection writes per-Worker by
default (#176) — but **existing** apps and **new integrations on old apps** still add to it.

Treat the cap as a live constraint, not a background chore.

---

## Order of work

Lowest risk first; each app is independent, so these can run as parallel sessions.

| # | App | Store secrets to move | Class | Notes |
|---|---|---|---|---|
| 1 | zero-one | 3 | 2 re-mint + 1 extract (Zapier URL) | staging-only |
| 2 | cbs-macrolens | 2 | re-mint | staging-only |
| 3 | arena-go-cortex | 2 | re-mint | staging-only |
| 4 | status-admin | 2 | re-mint | staging-only; already hybrid |
| 5 | c360-workflow-builder | 2 | re-mint | **new app** — confirm whether it bootstrapped pre-KIT-A |
| 6 | product | 3 | 2 re-mint + 1 extract (Linear key) | prod+staging share one value |
| 7 | atlas | 5 | 2 re-mint + 3 extract (BambooHR, Linear, audit token) | HR-sensitive; drifted `ATLAS_*` binding names |
| 8 | consumption-statement | 6 | 2 re-mint + 2 Access + 2 extract (upstream bearer) | coordinate with the tunnel/Access rollout |
| 9 | authorization-mini-app | 4 | 2 Access + 2 extract (HEMUNAH) | prod HEMUNAH is pre-staged for a Worker that does not exist yet |
| 10 | intercom-linear-sync | 10 | 6 extract + **4 → vars** | **non-kit** — hand-rolled, no `/kit-upgrade` path |
| 11 | app-pay-management | 10 | extract (Stripe, Salesforce ×2, BillForward, C360 — ×2 envs) | **last**: payments, four hard-to-reissue third parties |

**Classes:** *re-mint* = reissue a fresh credential, no extraction needed (all `*_AI_GATEWAY_TOKEN`,
`*_ANTHROPIC_*`, Access service tokens, CF/GitHub tokens). *extract* = the value must be carried
over because reissuing is disruptive (payment/CRM keys, upstream bearers, signed-URL secrets,
webhook secrets). *→ vars* = not actually secret (`LINEAR_TEAM_ID`, `LINEAR_TEAM_NAME`,
`INTERCOM_APP_ID`, `INTERCOM_ADMIN_ID`).

### Out of scope — AI Gateway BYOK keys (leave them in the store)

`dify_anthropic_default`, `dify_openai_default`, `dunable_anthropic_default`,
`il_economic_news_anthropic_default` — scoped **`ai_gateway` only** (not `workers`), commented
"Managed by AI Gateway", and created by the gateway itself.

These are **not migration candidates and cannot become per-Worker secrets**: a
`secrets_store_secrets` binding requires the `workers` scope, so no Worker can bind them, and the
consumer is AI Gateway's own BYOK path rather than app code. Migrating one would break that
gateway's provider config. They are already in the right place — the store is exactly what
account-level, gateway-consumed values are for (see docs/SECRETS.md).

Do not confuse them with an app's own Anthropic key. `dunable_anthropic_default` (gateway BYOK,
stays) is a different value from `DUNABLE_ANTHROPIC_API_KEY` (the app's key, already migrated to a
per-Worker secret and deleted from the store). The near-identical names are the trap.

Cost: 4 slots, permanently. Deciding whether a gateway still needs BYOK at all is an AI Gateway
question, not a secrets-migration one.

### Deferred orphans (delete at the end)

`STRIPE_API_KEY_APP_PAY_PAVED_ROAD`, `SALESFORCE_CONSUMER_KEY_APP_PAY_PAVED_ROAD`,
`SALESFORCE_CONSUMER_SECRET_APP_PAY_PAVED_ROAD`, `BILLFORWARD_API_KEY_APP_PAY_PAVED_ROAD`,
`C360_KEY_APP_PAY_PAVED_ROAD` — first-naming-attempt twins, unbound. Hard to regenerate, so purge
only after app-pay-management's successors are verified in production.

---

## Per-app procedure

Two paths. Most apps need only path A.

### A. Re-mint only (no value to carry)

No migrator, no extraction, no API token.

1. Open the app's **UPG PR**: remove the per-app `secrets_store_secrets` entries from **both**
   wrangler configs, add `"secrets": { "required": [...] }` to both. Keep every shared
   `PAVED_ROAD_*` / `REGISTRY_TOKEN` binding. Get CI green, then **hold**.
2. Mint fresh values and set them per Worker (`wrangler secret put NAME`, then again with
   `--config wrangler.staging.jsonc`) — or Bruno 06/07/07b.
3. Merge the UPG PR. CI deploys; `secrets.required` proves the secrets are present.
4. Verify: `wrangler versions view <latest> --name <worker>` shows them as plain **Secrets** and
   the shared bindings still as **Secrets Store Secret**; `/_health` is 200.
5. Leave the store entries in place to soak. Delete them in the cleanup pass.

### B. Extraction needed (value must be carried over)

Same as A, but the value is read out of the store by the **migration Worker** so no human or log
ever sees it. Rebuild it from `tools/secrets-migrator/` (it is deleted after each batch by design):

1. Mint a short-TTL API token with **account → Workers Scripts: Edit** (it cannot be scoped per
   script; TTL + prompt revocation is the mitigation). Enumerate who else holds that permission
   before you start.
2. Point `config.ts` at the batch and `wrangler.jsonc` at the store secrets it must read; deploy
   with `DRY_RUN=true`.
3. Set the token **yourself**: `wrangler secret put CF_API_TOKEN --name secrets-migrator`.
   *Wait for the version to deploy before the next cron* — a run that fires seconds early has no
   token and reports `9106` (missing auth header), which looks like a token problem and is not.
4. Read the KV marker: expect `wouldSwap: N, failed: 0`. Only then redeploy with
   `--var DRY_RUN:false`.
5. Marker shows `swapped: N`. Verify the target, **merge the UPG PR promptly** (until it merges,
   the repo config still declares the store binding and a deploy would revert the swap), verify
   again, soak.
6. **Delete the migrator Worker, its marker KV, and revoke the token in the same session.**

Runs are idempotent — a second run reports `skipped: already_secret_text`, and mixed batches
report per target.

---

## Cleanup pass (after each app soaks)

1. **Re-verify zero bindings at delete time**, fleet-wide, for each secret you are about to
   delete. The store has no referential integrity: deleting a bound secret 500s that Worker at
   request time and Cloudflare will not stop you. A previous inventory is not evidence.
2. Delete by id: `wrangler secrets-store secret delete <store-id> --secret-id <id> --remote`.
   (The flag is `--secret-id`, not `--name`. In zsh, pass ids inline — a `set -- $pair` split
   silently sends an empty id and every call returns a confusing `not_found`.)
3. Re-count and confirm the app is still 200.

Deleting forecloses rollback for that app. Do it only after a clean soak.

---

## Definition of done

- Store holds only fleet-shared secrets plus the 4 gateway BYOK keys (target ≈ 14, from 66).
- Every app's per-app credentials are per-Worker, with `secrets.required` declared in both configs.
- `*_anthropic_default` BYOK keys left in the store (out of scope, 4 slots — see above).
- Deferred `*_APP_PAY_PAVED_ROAD` orphans purged.
- The quota alert is live so the next drift is caught automatically, not by hand.
- No `secrets-migrator` Worker, marker KV, or migration token survives.
