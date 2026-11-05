# Secrets — where each one lives, and why

The kit has **two** places a secret can live. Picking the wrong one is not a style choice: one of
them is a shared account resource with a hard cap that the whole fleet competes for.

> **The rule, in one line:** a secret that belongs to **one app** is a **per-Worker secret**; a
> secret that is genuinely **the same value for every app** goes in the **account Secrets Store**.

Everything below is the reasoning, the mechanics, and the traps — all of which were paid for
during the 2026-08 fleet migration (DECISIONS 2026-08-04, 2026-08-05).

---

## The decision

| | **Per-Worker secret** (default) | **Account Secrets Store** (rare) |
|---|---|---|
| **Use when** | the value belongs to this app | the *same* value serves every app |
| **Examples** | `ANTHROPIC_API_KEY`, `AI_GATEWAY_TOKEN`, a Stripe key, an upstream bearer token, a webhook signing key, a DB credential | `PAVED_ROAD_ALERT_WEBHOOK_URL`, `PAVED_ROAD_ENTRA_CLIENT_SECRET`, `PAVED_ROAD_TURNSTILE_SECRET`, `REGISTRY_TOKEN` |
| **Scope** | one Worker. No other app can bind it | account-wide. Any Worker on the account can bind it |
| **Capacity** | 128 vars+secrets **per Worker**, no account-wide cap | **100 per account, hard** — one store per account (open beta) |
| **Rotation** | per Worker, per environment | rotate once, every app picks it up |
| **Set with** | `wrangler secret put NAME` (or Bruno 06/07/07b; a brand-new Worker: Bruno 05b/05c first) | Bruno **09**, or the dashboard |
| **In config** | `"secrets": { "required": [...] }` | a `secrets_store_secrets` binding |

**When in doubt, per-Worker.** It is the default for a reason: it costs no shared capacity, its
blast radius is one app, and `getSecret()` reads both identically so nothing downstream cares.

### The test that settles most cases

Ask: *"if I rotate this, how many apps must I touch?"*

- **One** → per-Worker secret. Even if two apps happen to use the same vendor, separate keys are
  better — independent revocation, attributable usage.
- **All of them, and they must move together** → Secrets Store. This is rare. Today it is five
  secrets fleet-wide, and adding a sixth should feel like a decision, not a default.

A value being *sensitive* is not the test. Both mechanisms are encrypted at rest and write-only.
The test is **who shares it**.

---

## Why the store is not the default

The account Secrets Store is capped at **100 secrets for the whole account**, and Cloudflare
allows exactly **one store per account** (open beta — no plan raises this, Enterprise included).

Before the migration, every new app minted two store entries at provisioning time. At ~12 apps the
store sat in the high 60s and rose with each app and each new integration — a shared, exhaustible
resource that any one app could consume on behalf of everyone. Per-Worker secrets have no
account-wide limit at all, so the same growth costs nothing shared.

There is a second reason: **blast radius**. A store secret is bindable by any Worker on the
account. A per-Worker secret is not addressable from anywhere else.

---

## How to set one

### Per-Worker (the default)

On a Worker that has already been deployed:

```bash
wrangler secret put ANTHROPIC_API_KEY                                   # production
wrangler secret put ANTHROPIC_API_KEY --config wrangler.staging.jsonc   # staging
```

Not deployed yet? See **First deploy** below. `secret put` on a missing Worker creates a stub one.

Then declare it so a deploy without it **fails closed** rather than failing at request time:

```jsonc
"secrets": { "required": ["ANTHROPIC_API_KEY", "AI_GATEWAY_TOKEN"] }
```

`secrets.required` is **per environment and not inherited** — put it in `wrangler.jsonc` *and*
`wrangler.staging.jsonc`.

**Prod and staging are separate Workers.** Arming one never arms the other. This is the single
most common way to get "why is my secret undefined" — see the traps below.

**First deploy of a brand-new Worker** is the one ordering wrinkle: a per-Worker secret lives on
the Worker, which does not exist yet, and `secrets.required` fails the deploy without it.

**Don't `wrangler secret put` (or `secret bulk`) first.** On a missing Worker, wrangler does not
fail. It silently creates a stub Worker (`createDraftWorker`, an empty `fetch()`), and its "create
a new Worker?" prompt defaults to yes even non-interactively, in CI too. The stub gets a
workers.dev route, an off-zone ingress the zone WAF never sees, until the first real deploy turns
it off. Two ways out instead:

- **Carry both in one shot:**

  ```bash
  wrangler deploy --secrets-file .secrets.production.json
  ```

- **Or create the Worker first** (platform maintainer, no secret values in a file on disk): Bruno
  **05b** uploads an inert placeholder Worker (answers 503, no bindings, no routes — what
  `wrangler secret put` itself does on a missing Worker) and **05c** switches its workers.dev and
  preview URLs off; then **05 → 06/07/07b** set the secrets on it. The first real deploy replaces
  the placeholder code and keeps the secrets — wrangler sends an `inherit` binding for each name
  in `secrets.required`. See [tools/bruno/cf-provisioning](../tools/bruno/cf-provisioning), job 3.

Values persist for every later deploy, so CI's plain `wrangler deploy` needs no file. Do this
before flipping `DEPLOY_ENABLED=true`. (Handbook §8.2; `npm run provision` prints the command.)

### Account Secrets Store (fleet-shared only)

Platform maintainer only, via the Bruno collection
([tools/bruno/cf-provisioning](../tools/bruno/cf-provisioning)):

- **08** — list the store + its quota. Run this first; it is how you see the cap coming.
- **09** — write a fleet-shared secret. It refuses any name that is not fleet-shared, and demands
  a comment, because a shared store full of unattributable secrets is one nobody can safely prune.

Then bind it in every app that needs it:

```jsonc
"secrets_store_secrets": [
  { "binding": "ALERT_WEBHOOK_URL", "store_id": "…", "secret_name": "PAVED_ROAD_ALERT_WEBHOOK_URL" }
]
```

Note the naming split: the **binding** name is canonical (`ALERT_WEBHOOK_URL`), the **store
secret** name carries the fleet prefix (`PAVED_ROAD_…`) and is deliberately *not* renamed per app.

---

## Reading a secret

Identical for both — that is the point:

```ts
import { getSecret } from './env';
const key = await getSecret(env.ANTHROPIC_API_KEY);
```

`getSecret()` accepts `string | SecretsStoreSecret`, so a value can move between mechanisms with
**no code change**. Never read `env.X` directly for a secret; a store binding is an object, not a
string, and would silently stringify to `[object Object]`.

---

## Traps (each one cost real debugging)

**Binding names share one namespace.** You cannot add a per-Worker secret named `X` while a
Secrets Store binding named `X` is in the deployed config — the API rejects it with **10053
"Binding name already in use"**. Migrating means *swapping*: remove the store binding and supply
the plain secret in the **same** deploy (`wrangler deploy --secrets-file`).

**The store has no referential integrity.** Deleting a store secret that a live Worker still binds
is permitted, and the Worker then fails at request time (`.get()` → code 1101, HTTP 500). Always
re-verify zero remaining bindings across the fleet *at delete time* — a stale inventory is not
evidence.

**Prod and staging are separate Workers.** Arming prod arms only prod. This applies to
`wrangler secret put`, to `secrets_store_secrets` blocks (each config has its own), and to the
fleet-registry `REGISTRY_TOKEN`.

**Deploy tokens still need `Secrets Store: Edit`.** Every app keeps the shared `PAVED_ROAD_*`
bindings, and deploying a Worker that *binds* a store secret requires that permission. Removing
per-app store secrets did not remove this requirement.

**The enforced store value limit is 1024 bytes**, not the 64 KiB some API/Terraform docs state
(`secret_value_too_long`, code 1001). Per-Worker secrets allow 5 KB.

**Rolling back a swap:** prefer `wrangler rollback <version>` — it is non-destructive and the
per-Worker secret survives, so rolling forward restores it. Redeploying an *old config* also
works but replaces the plain secret, so going forward again needs the value re-supplied.

---

## DB Israel apps

Neither mechanism above applies to a DB Israel app (`node scripts/deployment-target.mjs` prints
`dbisrael`). The central DB Israel pipeline (`CialDNB/il-paved-road-deployment`) generates the
Worker's configuration from the app's central catalog entry, and supports no Secrets Store. The
app holds no Cloudflare token. So the `wrangler secret put`, `secrets.required` and
`secrets_store_secrets` steps above are CIAL only, and the wrangler configs do nothing for
delivery.

A dual-delivered app (a `cial` marker and a release caller,
`.github/workflows/il-paved-road-release.yml`) has both: its CIAL Workers use the mechanisms
above, and its central Workers follow this section. A secret its code needs is set on each side,
and declared in the catalog for the central one.

- **Names are declared in the app's catalog entry:** `runtime_secrets` for a secret every release
  needs, `optional_runtime_secrets` for one the app runs without. A catalog PR in the central
  repository changes them, and the platform maintainer reviews it.
- **Values are set on the stage's Worker** by someone with DB Israel Cloudflare access, in the
  dashboard (the Worker, Settings, Variables and Secrets, type **Secret**) or with
  `wrangler secret put <NAME> --name <worker>` from an appropriately scoped login. The Worker's
  name is in the app's central receipt (for example `<app>-staging`). Staging and production are
  separate Workers, and each needs its own values. The pipeline never sets, reads or prints a
  value. Follow central's onboarding guide ("Configuration and secrets") for the order of the
  value and the catalog PR.
- **Every release checks names and types, never values.** A declared required name with no value
  stops the release before any database change or upload. A secret on the Worker that the catalog
  does not declare fails the post-deployment read-back. A dummy value passes, so test the feature
  that uses the secret.
- **The CIAL Secrets Store bindings do not carry over.** `ENTRA_CLIENT_SECRET`,
  `ALERT_WEBHOOK_URL`, `TURNSTILE_SECRET` and `REGISTRY_TOKEN` bind CIAL account store entries in
  the wrangler configs. In a DB Israel app, each one the app uses is a Worker secret declared in
  the catalog instead: `ENTRA_CLIENT_SECRET` as a required one when Microsoft sign-in is on
  (docs/runbooks/entra-sso-setup.md, "DB Israel apps").
- **An AI key is never optional.** Central accepts `ANTHROPIC_API_KEY` only as a required secret,
  together with a required `AI_GATEWAY_TOKEN`, a non-empty `AI_GATEWAY_ID` and the platform's
  `CF_ACCOUNT_ID`. AI stays off until the platform approves it (ILOPS-8949).
- **Nothing for delivery lives in the GitHub repository.** No `CLOUDFLARE_API_TOKEN` and no
  `DEPLOY_ENABLED`: the `deployment-target` guard goes red on either. And no repository secret or
  variable named `IL_PAVEDROAD_*`: the release caller's key is an organization secret that
  enrollment grants to the repository, and a repository secret of the same name could shadow it.

---

## Where this came from

The fleet migration that established this model: DECISIONS **2026-08-04** (per-app secrets are
per-Worker; shared stay in the store) and **2026-08-05** (fleet reporting covers staging).
Remaining work is tracked in [runbooks/secrets-migration.md](runbooks/secrets-migration.md).
