# Edge security — the Cloudflare zone is part of the paved road

The app-layer is already hardened: every `/api/*` is a fail-closed `defineRoute()` with
RBAC, Zod validation, 404-uniformity, audit, strict CSP/HSTS, and fenced egress. This
document covers the **edge** — the Cloudflare controls in front of the worker. They are
either free on the Enterprise plan or trivial in cost, and they close the gaps the app
can't close from inside: volumetric/bot abuse, the unprotected `*.workers.dev` ingress,
and client-side supply-chain tampering.

Two kinds of control live here:

- **Zone-wide** — set ONCE on the `cialdnb.ai` zone by the platform owner. Every fork
  inherits them automatically. Nothing per-app to do.
- **Per-fork** — travel with the kit. Some are enforced in code (a red CI until you set
  them); the rest are a short checklist below.

> **Cost note.** Everything in this document is **bucket A (included in Enterprise)** or
> **bucket B (trivial / consumption)**. The paid add-ons (Bot Management, full API Shield,
> Page Shield policies) are **out of scope** and listed at the bottom as "consider later" —
> ask the account team whether your contract already bundles them before assuming spend.

---

## Why workers.dev is disabled (read this first)

A Worker on a custom domain is *also* reachable at its default `<name>.<account>.workers.dev`
hostname and at preview URLs — unless you turn them off. Those hostnames are a **second
ingress that bypasses every zone-scoped control**: WAF rules, rate limiting, and managed
rulesets attach to `cialdnb.ai`, not to `workers.dev`. An attacker who finds the
workers.dev name hits D1/KV/auth directly with zero edge protection, and the kit's
`cf-connecting-ip`-based rate limiting and audit (which assume Cloudflare always fronts
the worker) become spoofable.

So the kit sets, in `wrangler.jsonc` and `wrangler.staging.jsonc`:

```jsonc
"workers_dev": false,
"preview_urls": false,
```

This is enforced by `npm run verify:edge` (a CI gate). **Do not flip these on.** If you
ever genuinely need a preview URL, gate it and record the exception in `docs/DECISIONS.md`.

---

## Zone-wide controls (platform sets once on `cialdnb.ai`)

Apply these to the zone in the Cloudflare dashboard (or Terraform). All forks inherit them.

| Control | Bucket | Where / how | Stops |
| --- | --- | --- | --- |
| **WAF Managed Ruleset + OWASP Core Rule Set** | A | Security → WAF → Managed rules. Deploy both; run OWASP in *log* a few days, then enforce. | Common injection / exploit traffic |
| **HTTP DDoS protection — sensitivity High** | A | Security → DDoS. On by default; raise sensitivity. | Volumetric + HTTP floods (also a *cost* event — Workers bill per request) |
| **Advanced Rate Limiting** | A | Security → WAF → Rate limiting rules. See the per-fork `/auth/*` rule below. | Brute-force, abuse, runaway clients — *before* the worker runs |
| **Leaked Credentials Detection** | A | Security → WAF → Detections → enable. | Logins with known-breached credentials (more useful once SSO/passwords exist) |
| **Sensitive Data Detection** | A | Security → WAF → Detections → enable; alert on matches in responses. | PII/secret leakage in responses (the "salary in a seed file" class of bug) |
| **DNSSEC + CAA** | A | DNS → Settings → enable DNSSEC; add a `CAA` record pinning the allowed CA. | Domain hijack, rogue cert issuance |
| **DMARC `p=reject` (+ SPF/DKIM)** | A | DNS records for the sending domain; verify alignment. | Spoofing of `auth@cialdnb.ai` — protects the magic-link channel |
| **Logpush → SIEM (and R2 with object-lock)** | A/B | Analytics → Logs → Logpush: HTTP requests, WAF/firewall events, Workers Trace Events. | No detection pipeline + the app's D1 audit log has no immutable off-box copy |

Account-admin hardening (free, no Access seats): enforce 2FA / SSO + hardware keys on the
Cloudflare account, and keep the per-app `CLOUDFLARE_API_TOKEN` least-privilege (the kit
already mandates this — verify the scope, don't trust it).

---

## Per-fork checklist (every app, before go-live)

1. **workers.dev + preview URLs off** — `workers_dev:false` + `preview_urls:false` in both
   deploying wrangler configs. *Enforced* by `npm run verify:edge`. ✅ ships set in the kit.
   Same gate, same configs: wherever Workers Logs are on, `"observability": { "logs":
   { "invocation_logs": false } }` — the platform's per-request record logs the URL, which here
   means a live `/auth/verify?token=…` and `/api/users/<address>`, into a 7-day log nobody can
   delete (PIA C5). ✅ ships set in the kit.
2. **Host-pin WAF rule** — Security → WAF → Custom rules: block requests whose `Host` ≠
   your app's custom domain (`<app>.cialdnb.ai`). Defends against Host-confusion and any
   direct-to-worker attempt.
3. **`/auth/*` rate-limit rule** — Security → WAF → Rate limiting: e.g. *Managed Challenge*
   when an IP exceeds ~10 requests/min to `(http.request.uri.path matches "^/auth/")`.
   This is the pre-worker throttle the in-app KV limiter (`src/security/rateLimit.ts`)
   can't be — the worker has already run by the time that fires.
4. **Turnstile on login** — the kit ships the integration; enable it per app (next section).
5. **Verify after deploy — now automated (`verify:edge:live`)** — `npm run verify:edge:live --
   --env staging|production` probes the LIVE zone + worker: workers.dev/preview off, the WAF
   `/auth/*` rate-limit + a managed ruleset present (and the Host-pin on a dedicated zone),
   security headers intact, and Turnstile matching config. It runs in three places: CI after the
   post-deploy smoke check, a **daily scheduled Action** (`.github/workflows/edge-live.yml`)
   between deploys, and the worker's own `edge_probe` cron — which pages via the alert seam if the
   workers.dev ingress ever comes back (set `WORKERS_DEV_HOST` to arm that half). The CF-API checks
   need `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` in the environment; without them the HTTP
   checks (headers, Turnstile) still run. This is the drift watch the point-in-time GO-LIVE gate
   couldn't be.

> The `/auth/*` rate-limit rule is now **scripted**: `scripts/provision.mjs` creates it
> (idempotent, zone-wide) and `scripts/check-edge-live.mjs` verifies it — create + verify share
> the definitions in `scripts/edge-rules.mjs`, so they can't drift. The **Host-pin** rule is
> created + required only on a DEDICATED zone (`EDGE_REQUIRE_HOST_PIN=1`): on the shared
> `cialdnb.ai` zone a "block host ≠ <domain>" rule would block sibling apps, so it stays advisory
> there (verified only if present). The worker deliberately holds **no Cloudflare API token** — the
> CF-API inventory runs in CI + the scheduled Action, not a worker cron (DECISIONS 2026-07-03).

> **What "verified" means, and its limits (AICOE-396).** The check verifies each control is
> EFFECTIVE, not merely present: the `/auth` rate-limit must have an enforcing action + a real
> throttle, the Host-pin must actually negate, and the security headers are checked by VALUE (a
> weakened `HSTS: max-age=0` / permissive CSP fails). Two deliberate softenings avoid false-reds:
> **managed-WAF absence is advisory** — Cloudflare often deploys managed rulesets at the ACCOUNT
> scope, invisible to a zone-phase read, so "not found in the zone phase" isn't treated as drift
> unless you set `EDGE_REQUIRE_MANAGED_WAF=1` on a zone you've confirmed is zone-deployed (a
> present-but-neutered ruleset is always flagged). And the **post-deploy CI step is HTTP-only** — a
> blocking deploy gate must never red on Cloudflare-API reachability; the CF-API inventory
> (workers.dev / WAF / rate-limit) is the daily `edge-live` Action's job, where a red is a monitor
> alert. `EDGE_REQUIRE_COMPLETE=1` makes an unarmed run fail for a fork that wants CI to enforce
> full coverage. Known gap: CSP checking only catches a weakened `default-src`, not an opened
> non-default directive.

> **`/_health` is deliberately public** (unauthenticated). It returns only operational facts —
> status, app name, environment, build version, and dependency-check timings — and **never**
> user data or internals; CI's post-deploy smoke check depends on it. Treat the app name / env /
> version it reveals as non-sensitive (they are already implied by the public hostname). It sits
> behind the same zone WAF + rate-limiting as every other path.

---

## Turnstile (bot challenge on magic-link login)

The kit wires Turnstile into the login flow but ships it **disabled** (fail-open) so the
template, tests, and un-provisioned forks work out of the box. It is **enabled per app** by
pointing at the shared widget; until then, login behaves exactly as before.

**One widget for the whole fleet.** Every kit app shares a single Turnstile widget — public
site key `0x4AAAAAAD1YnhyvyCloL7zA`, secret in the account Secrets Store as
`PAVED_ROAD_TURNSTILE_SECRET` (a SHARED secret, un-renamed on bootstrap like the alert webhook
and the Entra client secret — `SHARED_SECRET_NAMES`). So enabling an app is **config only** —
there is no widget or secret to create. The one genuinely per-app step: a Turnstile widget only
renders on hostnames in its allowlist, so **before you enable an app you must add that app's
hostnames to the shared widget** (step 1). This mirrors the shared-Entra-registration model — one
registration for the fleet, the per-app cost is a small dashboard entry (a redirect URI there, a
hostname here). See DECISIONS 2026-07-13.

How it works:
- `src/security/turnstile.ts` verifies the widget token server-side (siteverify), mirroring
  the AI client's injectable-fetcher pattern.
- `POST /auth/request` calls it before issuing a magic link. **Enabled** = the
  `TURNSTILE_SITE_KEY` var is non-empty. If enabled but the secret can't resolve, the
  request **fails closed** (rejected) — a half-configured enable can't silently bypass.
- The SPA fetches `GET /auth/config` for the public site key and renders the widget when
  present. `web/public/_headers` already allows `challenges.cloudflare.com` in the CSP.

To enable an app (config only — the shared widget + secret already exist):
1. **Add the app's hostnames to the shared widget's allowlist — REQUIRED FIRST**, or the widget
   errors (`invalid domain`) on that host and login breaks. Cloudflare dashboard → **Turnstile** →
   the shared widget → **Hostname Management**: add both `<app>.cialdnb.ai` and
   `staging-<app>.cialdnb.ai`. This is a platform-owner action on the shared widget — if you don't
   own it, ask the owner to add your subdomains before flipping the site key on.
2. Flip the site key on in `wrangler.jsonc` + `wrangler.staging.jsonc` `vars`: the public key
   `0x4AAAAAAD1YnhyvyCloL7zA` ships as a **commented-out ready-made line** under an empty active
   one — comment out the empty `"TURNSTILE_SITE_KEY": ""` and uncomment the value line below it
   (same value for staging + prod). It's a site key, not a secret, so it lives in the config, not
   the Secrets Store.
3. Uncomment the `TURNSTILE_SECRET` block in `secrets_store_secrets` (both configs). The value
   already lives in the account Secrets Store as `PAVED_ROAD_TURNSTILE_SECRET` — nothing to create.
   (It was seeded once by the platform owner, the same way the shared Entra secret is —
   `npx wrangler secrets-store secret create dbed52d86420441baa29b42596b0477e --name PAVED_ROAD_TURNSTILE_SECRET --scopes workers` —
   so this is the command to recreate or rotate it, not a per-app step.)
4. Redeploy; confirm the login page shows the widget and a tokenless `POST /auth/request`
   is rejected. `npm run verify:edge:live` then re-checks that config and live state agree.

The `turnstile-spin` skill can still create a **dedicated** widget + secret via the Cloudflare API
when an app genuinely needs its own (e.g. a client-data app isolated into its own Cloudflare
account — see the account-isolation section below, where the shared widget's account boundary
doesn't reach). For every app on the shared `cialdnb.ai` account, the shared widget above is the
paved-road default.

---

## Rejected: Cloudflare Access

We do **not** use Cloudflare Access for end-user auth. Reasons:
- It's per-seat (free Zero Trust tier stops at 50 users, then ~per-user pricing), and it
  scales with every external user.
- It's **redundant** — the app already does magic-link auth + RBAC + 404-uniformity +
  audit. Paying to re-authenticate users the app already authenticates is a bad trade.

Admin/dashboard/staging hardening that Access would otherwise provide is achieved for $0:
account 2FA/SSO + hardware keys, scoped API tokens, and (for staging) a free WAF
allowlist rule by IP/email-domain instead of an Access policy.

---

## Account isolation (one account, resource-scoped tokens; per-tier accounts declined 2026-10-21)

All paved-road apps share one Cloudflare account (`13878ca5…`). Once the D&B split is complete
there will be two, one per company. Dedicated per-tier accounts were **declined** (DECISIONS
2026-10-21, reversing 2026-06-23): many accounts under one zone cost more to run than the boundary
is worth, now that Cloudflare scopes access per resource. Least privilege inside the account comes
from **resource-scoped API tokens**: an app's token is scoped to its own Worker and its own R2
buckets, and to its own D1 database once Cloudflare offers per-database scoping (announced, not yet
available).

Until then, Cloudflare D1 API-token permissions are **product-level**: a token that can touch D1
can read every app's D1 in the shared account. That residual risk is accepted, and **three in-repo
guards keep one app's deploy off another app's D1** (DECISIONS 2026-08-18): remote `wrangler d1`
commands address the `DB` binding so the config's pinned `database_id` is the only identifier;
`verify:edge` rejects a wrangler config that names a resource belonging to a different app (a stale
`bucket_name` would otherwise send this app's D1 backups into a sibling's bucket); and
`scripts/check-d1-identity.mjs` refuses to migrate a database whose `app_identity` row names another
app. All three are preventive on purpose. Cloudflare audit-logs nothing for `/d1/.../query`, so a
cross-app migration is invisible rather than merely non-obvious, and there is no detective control
to build. They are live today, in CI and both deploy workflows.

---

## Consider later (paid add-ons — not required for launch)

Ranked by value for this app. Ask the account team whether your Enterprise contract
already bundles these (the "Application Security Advanced" package often does) before
assuming any cost.

- **Page Shield** — client-side script/connection monitoring for the SPA. The one add-on
  with no free equivalent (the CSP blocks but doesn't *detect/alert*). Best fit if
  handling regulated data. Start on the free monitoring tier.
- **Bot Management** — JA3/JA4 + bot scoring. Defer: Turnstile + edge rate limiting +
  managed WAF cover credential-stuffing and email-bombing for free. Buy only under real
  distributed bot pressure.
- **Full API Shield** — schema *learning*, sequence/discovery, mTLS, JWT validation.
  Defer: basic schema validation is free and the app already validates with Zod. Revisit
  when Entra SSO (edge JWT validation) or external machine clients (mTLS) arrive.
