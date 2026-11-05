# Runbook — service identities (machine principals)

**Goal:** give an integration (an ETL, a sync job, a CRM push) its own credential, so it stops
running on a person's personal token. Everything it does is then recorded under **its own**
identifier (its writes through a machine route are recorded by their audit row alone: see *Machine
routes and the read log*), it can do exactly **one** thing, it can be rotated, cut off or handed to
a new owner without touching any person, and a named human is accountable for it. (DECISIONS
2026-09-24.)

**Who runs this:** an app **owner or admin**, signed in (the `serviceIdentities.manage`
permission). No API token can do any of it — not a person's, not a service's own. Nothing here needs
Cloudflare, wrangler or a deploy.

## What a service identity is

| | |
| --- | --- |
| **Identifier** | `svc-<slug>@<app>.invalid`, e.g. `svc-c360-etl@insights.invalid`. It is what `audit_log.actor_email`, `read_log.principal`, the rate-limit bucket and the AI budget record — never the custodian's address, even when the custodian uses the token. `.invalid` is a reserved TLD: no mailbox, no real person, no collision. |
| **Authority** | exactly **one** permission key (its *scope*), fixed at creation. It has **no role**: whatever roles hold that key, and whatever else they hold, the identity holds that one key and nothing else. It never reaches a non-delegable key, the reserved `agent…` family, or any `permission: 'authenticated'` route (`GET /api/me` included). |
| **Credential** | bearer tokens only (`Authorization: Bearer t_…`), 90 days by default, up to **365**. It can never sign in: magic links, Microsoft sign-in and sessions all refuse the whole `.invalid` namespace, and it is not a row in `users`. |
| **Custodian** | a named, **active** person accountable for it. They are told when its tokens near expiry. **If the custodian is disabled or removed, every token of the identity is refused** until someone else takes it over — see *Custodian leaves*. |
| **Kill switch** | *Disable* refuses every token at once, without revoking them; *Re-enable* restores them. |
| **Lifetime** | identities are never deleted (the identifier must keep naming one machine in the audit log). Retire one by disabling it and revoking its tokens. The slug is never reused. |

Denied requests are recorded: when a service identity calls a route outside its scope, it gets the
uniform `404` like anyone else, **and** an `authz.denied` audit row (actor = the identifier, target =
the route pattern, payload = the permission key the route needs and the identity id). At most five
rows an hour are kept per identity and route pattern; further denials in that hour are logged as
`authz_denied_audit_suppressed` (identity id and route pattern) instead, so a retry loop cannot
flood the audit log. The daily audit digest counts the rows. A person's denials are not recorded.

### Machine routes and the read log

With `READ_AUDIT` armed, a service identity's write through a **`machine: true`** route writes **no
`read_log` rows** once its declared audit row lands carrying the route's payload and the caller's
`X-Sync-Run` id (DECISIONS 2026-09-24, machine read attribution). That one row, under the
identifier — counts, a key fingerprint and the run id when the route builds it with `batchAudit()`
— is the request's whole in-app record of what it read, matched to the integration's own run log
by fingerprint and run id. Its GETs, its calls to ordinary routes, and any write whose row did not
land are recorded in `read_log` as usual. Two things follow:

- **A machine route returns counts and the keys it was sent, never a record it read**, and a lookup
  the integration needs is a **GET**, which stays recorded (docs/API-CONVENTIONS.md → machine
  routes; `/security-review` checks it). A write that handed back what it read would carry those
  reads out with no read row.
- **Never use an identity's token by hand to look things up.** It is the integration's credential:
  what you read through its machine writes is recorded only as the counts row, under the
  identifier, not under you.

## Create one

1. **Pick the slug** with the integration's owner — lowercase words joined by single hyphens,
   starting with a letter, 2–40 characters: `c360-etl`, `crm-sync`. Name the system, not a person.
2. **Pick the one scope** — the permission key of the route(s) the integration calls. The app's
   manifest (`GET /api/meta/manifest`, signed in) lists every route with its key. If the
   integration needs two keys, it is two integrations: create two identities.
3. **Pick the custodian** — the person who runs the integration and will rotate its token. They
   must already be an active user of the app.
4. Settings → **Service identities** → fill in slug, name, scope, custodian → **Create identity**,
   and confirm. (API: `POST /api/service-identities {"slug","name","scope","custodian_email"}`.)
   Only scopes you could put into a token yourself are offered, and none is preselected: the slug
   and the scope are permanent, so a wrong pick is a burned slug. A new identity starts with **no working token**: if
   tokens were already stored under its identifier (a machine *user* from before the upgrade), the
   create revokes them, and its `service_identity.create` audit row says how many
   (`revoked_preexisting_tokens`).
5. **Mint its token:** on the identity's **Tokens** panel, name the token for where it will live
   (`c360-etl prod 2026-10`), pick an expiry (90 days is the default, up to 365), **Mint token**.
6. **Copy it now.** The full `t_…` value appears once. Hand it over through the integration's
   secret manager — never email, chat or a ticket.
7. **Confirm first use:** after the integration's next run the token's *Last used* fills in
   (refreshed at most every 15 minutes).

A self-check for the integration is a call to **its own** route — a service identity gets `404`
from `GET /api/me` by design.

## Rotate a token

Tokens cannot be extended. Rotation is *mint → switch → revoke*, and the two tokens overlap on
purpose so the integration never has a gap.

1. On the identity's **Tokens** panel, **Mint token** (same name plus the date).
2. Hand it over (step 6 above); the integration's owner deploys it.
3. Watch the new token's *Last used* fill in and the old one's stop moving.
4. **Revoke** the old token. It stops on the next request.

**When you hear about it:** every day while a used token has **less than 14 days** left, the alert
recipients get a *Service identities* email naming the identity, the token and the custodian, and
the custodian gets their own copy listing only their identities. It repeats daily until the old
token is revoked or expires. Slack (if configured) gets the counts only.

## Change the custodian

Settings → **Service identities** → **Tokens** → *New custodian* → **Change custodian**.
(API: `PATCH /api/service-identities/:id {"custodian_email"}`.) The new custodian must be an active
user; an inactive one — including re-confirming the current one after they left — is a `400`, and
nothing else in that request is applied. Audited as `service_identity.update`.

### Custodian leaves (offboarding)

**Hand the identity over BEFORE you disable the person.** A service identity whose custodian is not
an active user is *orphaned*: every one of its tokens is refused (`401`) from the next request.
This is deliberate — a machine nobody answers for stops rather than running on for up to a year —
and it is never silent:

- the moment the person is disabled (Settings → **Users**), the alert recipients get a *service
  identities stopped: custodian disabled* email naming each identity that stopped (Slack: the count),
  and the `user.update` audit row counts them (`orphaned_service_identities`);
- the page shows the identity as **no active custodian — tokens refused**;
- the daily *Service identities* email lists every orphaned identity that still holds a live token,
  every day until it is fixed;
- each refused request logs `{"event":"api_token_refused","reason":"service_custodian_inactive",
  "token_id":…,"service_identity_id":…}`.

To recover: **Change custodian** to an active person. The tokens work again on the next request —
nothing to re-mint. (Re-enabling the person works too.)

## Incident: a token leaked, or the integration misbehaves

1. **Disable** the identity (Settings → Service identities → **Disable**). Every token stops on the
   next request; nothing is revoked yet.
2. **Revoke all tokens** (the identity's Tokens panel, confirmed), or revoke just the leaked one.
   (API: `POST /api/service-identities/:id/revoke-tokens`.) Audited as
   `service_identity.revoke_tokens` with the count.
3. **Mint a replacement.** Minting works while the identity is disabled; the new token stays inert
   until step 5.
4. Hand it over; the integration's owner deploys it.
5. **Re-enable** the identity.
6. **Review what it did:** Settings → **Audit log** and **Read log** — its rows are the ones whose
   actor / principal is the identifier `svc-<slug>@<app>.invalid`. With D1 access,
   `SELECT created_at, action, target, ip FROM audit_log WHERE actor_email = ? ORDER BY id` (bind the
   identifier; address the database by its `DB` binding). Look especially for `authz.denied` rows —
   a stolen token being used to explore shows up as denials on routes the integration never calls.
   Its writes through machine routes have **no** Read log rows by design (*Machine routes and the
   read log*, above): for those, each audit row's counts, key fingerprint and `runId` are the trace,
   matched against the integration's own run log.

## Retire one

Disable it, then revoke all its tokens. The row stays so the audit trail keeps pointing at a real
identity, and the slug can never be reused for a different machine.

## Moving an integration off a person's token

1. Create the identity (above) with the scope the integration's routes need, and the person whose
   token it used today as custodian (or whoever owns the integration now).
2. Mint its token and deploy it to the integration. Confirm *Last used*.
3. **Revoke the person's token** the integration used. Only its owner can: they revoke it on their
   own Settings → **API keys** page.
4. **History is not rewritten.** Everything the integration did before the switch stays attributed
   to the person whose token it used; only actions after the switch carry the identifier. If a
   report needs the split, the switch time is the `token.create` audit row for the new token.

## API reference

All `serviceIdentities.manage` (owner/admin, **session only** — every bearer token gets the uniform
404), all audited on write. A malformed or unknown `:id` / `:tokenId` is the uniform 404.

| Method + path | Does | Audit action |
| --- | --- | --- |
| `GET /api/service-identities` | List identities (status, custodian, live tokens, next expiry) and the scopes you may grant | — |
| `POST /api/service-identities` | Create `{slug, name, scope, custodian_email}`; 400 bad slug / ungrantable scope / inactive custodian, 409 slug used | `service_identity.create` |
| `PATCH /api/service-identities/:id` | `{name?, custodian_email?, disabled?}` | `service_identity.update` |
| `GET /api/service-identities/:id/tokens` | List its tokens (prefix and dates, never the hash) | — |
| `POST /api/service-identities/:id/tokens` | Mint `{name?, expires_in_days? 1–365}`; the plaintext is in this response only; 409 `custodian_inactive` | `token.create` (`owner` = the identifier) |
| `DELETE /api/service-identities/:id/tokens/:tokenId` | Revoke one | `token.revoke` (`owner` = the identifier) |
| `POST /api/service-identities/:id/revoke-tokens` | Revoke every token | `service_identity.revoke_tokens` |

## Refusal reasons in the logs

A service token that does not resolve answers `401` and logs
`{"event":"api_token_refused","reason":…,"token_id":…,"service_identity_id":…}` (never an address):

| reason | meaning | fix |
| --- | --- | --- |
| `service_identity_disabled` | the kill switch is on | re-enable, if that was not deliberate |
| `service_custodian_inactive` | the custodian was disabled or removed | *Change custodian* |
| `service_scope_not_grantable` | the identity's key became non-delegable or no longer exists (a kit or app change). The page shows *scope no longer allowed* and the daily email names it | create a new identity with a valid scope, move the integration to it, then retire this one |
| `service_scope_mismatch` | the token's own ceiling excludes the identity's scope (only a hand-edited or pre-upgrade token) | mint a new token |
| `service_identity_missing` | a token owned by a `.invalid` address with no identity row (a pre-upgrade machine *user*) | create the identity (same slug keeps the identifier) and mint it a new token — the create revokes the old one. A fork keeping such tokens adopts them with a reviewed data step instead (CHANGELOG) |

A `{"event":"service_identities_schema_drift","op":…,"remedy":…}` line instead means the code is
newer than the database: migration `0004_service_identities.sql` (forks: its renumbered copy) has
not been applied. Every service token is refused, the admin page answers `500`, and the daily
`token_expiry_notice` task fails with the same remedy until it is.
