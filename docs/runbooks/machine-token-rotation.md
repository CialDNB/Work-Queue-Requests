# Runbook — rotating machine tokens (`t_*`) before they expire

> **An integration should run as a SERVICE IDENTITY, not on a person's token.** Service identities
> (DECISIONS 2026-09-24) are machine principals with their own identifier, exactly one permission,
> a named custodian, and tokens of up to 365 days — see
> [service-identities.md](service-identities.md), which also covers rotating their tokens. This
> runbook remains the reference for PERSONAL tokens (a person's script, their MCP client) and for
> the one-time C8 upgrade below.

Since PIA condition **C8** (DECISIONS 2026-09-23), every bearer token expires:

- a **new** token at most **90 days** after it is minted (the default is the maximum);
- a token that **predates the upgrade** at **upgrade + 90 days**, or sooner if it already had an
  earlier expiry. `migrations/d1/0003_api_token_scopes.sql` sets that deadline when it runs.

There is **no way to extend a token.** Rotation is always *mint → switch → revoke*. A token that
lapses does not degrade: every call fails with `401 unauthorized`, so an unattended integration (an
ETL, the fleet registry reporter, an MCP client, a CI smoke script) simply stops. This runbook is
how you keep that from happening.

> **Two things a token can no longer do, whatever its owner's role** — plan around them, not
> through them. It cannot **mint, list or revoke tokens** (so rotation always needs a person
> signed in), and it never holds the rest of the **non-delegable** set either: managing users or
> settings, reading the audit log or the read ledger, reading the manifest (`GET /api/meta/manifest`),
> managing service identities, or anything of the in-app agent's (`agent.use`, `agent.erase`).
> Those answer the uniform 404 to a token. See `NON_DELEGABLE` in `src/auth/permissions.ts`.

## 1. Know what is expiring

- **The daily notice.** The `token_expiry_notice` cron task (`src/cron/tokenExpiry.ts`) emails
  the alert recipients (`ALERT_EMAIL` plus the in-app list) about every token **that has been
  used** and whose owner is still active, on the runs **14, 7, 3 and 1 UTC calendar day(s)**
  before its expiry date: name, prefix, owner, expiry and last use. One email lists up to 200
  tokens and states how many more are due (the query below lists them all). Slack gets a count
  only. A quiet day sends nothing. It never pages as a cron failure.
- **The Tokens page** (signed in as the token's owner) shows each token's *Expires* column.
- **Across all owners** (operator with D1 access — address the database by its `DB` binding, never
  by name; add `--config wrangler.staging.jsonc` for staging):

  ```bash
  npx wrangler d1 execute DB --remote --command \
    "SELECT id, email, name, prefix, expires_at, last_used_at, scopes FROM api_tokens
     WHERE revoked_at IS NULL AND expires_at > datetime('now') ORDER BY expires_at"
  ```

  Never select `token_hash`; you have no use for it.

## 2. Decide who owns the replacement

A token acts as its **owner**: the owner's *live* role, narrowed by the token's scopes. So:

- **A machine integration belongs to a SERVICE IDENTITY**, not to a person and not to a
  `users` row with a shared mailbox: create one ([service-identities.md](service-identities.md))
  and mint its token there — it holds exactly the one key the integration calls, its actions are
  recorded under its own identifier, and a person leaving never silently kills it (its custodian is
  handed over instead). Use this rotation to move the integration; the old personal token is then
  revoked, not rotated.
- **A person's own script or MCP client** keeps a personal token: the rest of this runbook.
- **Fork policy applies** to personal tokens. A fork's `refuseTokenFor` hook
  (`src/routes/tokenPolicy.ts`) can refuse tokens for some accounts outright — insights refuses
  tokens held by ACL-provisioned users. (Service identities never pass through that hook: they have
  no `users` row, and their refusal policy is the kit's own.)

## 3. Mint the replacement — with only the scopes it needs

Sign in to the app **as the owning account**. The Tokens page mints a token with the default
scopes: everything that role may delegate today. For an integration, name the scopes instead, from
the browser console **on the app's own origin** (same-origin, so the CSRF check passes):

```js
await fetch('/api/tokens', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'etl-2026-12', scopes: ['notes.write'] }),
}).then((r) => r.json());
```

- `scopes` lists **permission keys** (`PERMISSIONS` in `src/auth/permissions.ts`; the app's
  manifest lists every route's key). Each must be one the account's role holds and not in the
  non-delegable set, or the call is a `400` naming the offending keys.
- `expires_in_days` is optional, from 1 to 90. Leave it out to get 90.
- The response carries the plaintext `token` **once**. Put it straight into the integration's
  secret store — never into a ticket, chat or repo.
- Name it for what uses it and when: `<integration>-<yyyy-mm>`.

## 4. Switch the integration over

Replace the secret where the integration reads it, then prove the new token works **before**
revoking the old one:

```bash
curl -s -H "Authorization: Bearer $NEW_TOKEN" https://<app-host>/api/me
```

`200`, the expected `email`, and a `permissions` list containing what the integration calls. That
list is the token's **effective** permissions (role ∩ scopes, minus the non-delegable set), so a
missing key here is a missing scope, not a bug. Then let the integration run once and check that
the new token's *Last used* is set on the Tokens page.

## 5. Revoke the old token

Tokens page → **Revoke**, signed in as the owner. Revocation takes effect on the next request. (If
you cannot sign in as the owner, the old token dies on its own at its expiry; an admin can also
disable the owning user, which kills **every** credential that user holds.)

## 6. The first upgrade to C8 — the 90-day deadline

When `0003_api_token_scopes.sql` runs, every existing token becomes a **legacy** token: `scopes`
NULL (every permission of its owner's role except the reserved `agent` family, minus the
non-delegable set) and an expiry of at most upgrade + 90 days. On that day:

1. **Check for integrations that used a non-delegable permission** with a token (reading
   `/api/audit`, `/api/read-log` or `/api/meta/manifest`, managing users or settings, minting
   tokens). They answer `404` from now on and no scope can bring them back. Move that work to a
   person with a session, or raise it as a kit change.
2. **List the tokens in use** (section 1; `last_used_at` within the last 30 days is a good cut) and
   schedule each rotation well before day 90. Use the rotation to give each one explicit scopes.
3. The daily notice starts 14 days out. Treat it as the last reminder, not the plan.

## 7. Integrations you are likely to have

| Integration | Owning account | Scopes | Where the secret lives |
|---|---|---|---|
| **insights ETL / ingest** | a **service identity** (`svc-c360-etl@insights.invalid`, custodian = the ETL's owner) — [service-identities.md](service-identities.md) | its one key, `portfolio.ingest` | the ETL's own secret store |
| **Fleet registry reporter** (`REGISTRY_TOKEN`) | a registry account (member is enough) — mint it **in app-registry** | `["apps.write"]` (the registry's ingest route) | the account **Secrets Store** under `REGISTRY_TOKEN` — one value for the whole fleet (docs/SECRETS.md). Replacing it re-arms every app on its next daily report; confirm with the registry's last-reported time or `wrangler tail` (`reported to registry: health=ok`) |
| **MCP client** | the person using it — or, for an unattended agent, a **service identity** (its tool list is its one key's tools) | only the tools it should see — the MCP tool list follows the token's effective permissions | the client's credential store |
| **CI smoke / scripts** | a smoke check that only calls `/api/me`: a **person's** token (or a `users`-row account's) with scopes `[]` — such a token reaches only routes declared `permission: 'authenticated'` (in the kit, just `/api/me`; a fork may have more). A **service identity cannot** do this check: `'authenticated'` routes admit people only, so it gets the uniform 404 (and an `authz.denied` row). A smoke check that should run as a machine calls a route on its identity's one key instead (a dedicated machine self-check is planned with the `machine: true` route flag) | `[]` for `/api/me`; for a service identity, its one key | the CI secret |

## 8. A token already lapsed

Symptoms: every call returns `401 unauthorized`; nothing token-specific is logged, because an
expired token simply does not resolve. There is no extension and no grace period: go to section 3,
mint, switch, done.

Two 401s that *are* logged, and are not expiry:

- `{"event":"api_token_schema_drift", …}` — the code expects `api_tokens.scopes` but the database
  never ran the 0003 migration. **Every** token is refused until it does. Apply the migration (forks:
  copy and renumber it); do not work around it.
- `{"event":"api_token_no_expiry","token_id":…}` — the `scopes` column exists but the table was
  never rebuilt by 0003 (typically a hand-written `ADD COLUMN scopes`), so this token still has no
  expiry and is refused. Apply 0003 all the same: it keeps every token's scopes and back-fills the
  expiry.
- `{"event":"api_token_refused","reason":"…"}` — the fork's `refuseTokenFor` hook refused this
  account (section 2). A reason starting `service_` is a SERVICE identity's token refused by the
  kit (disabled identity, custodian no longer active, …) — see the table at the end of
  [service-identities.md](service-identities.md).
