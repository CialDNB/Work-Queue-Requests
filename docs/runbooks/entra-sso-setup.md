# Runbook — Entra SSO ("CIAL Internal Apps", multi-tenant)

**Goal:** stand up **one shared, multi-tenant** Microsoft Entra app registration that every kit
app reuses for "Sign in with Microsoft", covering the **three** alliance directories — CIAL D&B,
D&B Israel, Trusted Partners — behind the kit's existing auth seam. Magic links remain a
first-class login forever: cballiance.com is not a Microsoft tenant, and external-facing apps
have users with no Entra identity at all. (DECISIONS 2026-06-13 A2, refined 2026-07-01.)

**Who runs this:** Part 1 needs an **Entra admin in the CIAL tenant**; Part 2 needs a **Global
Administrator (or Privileged Role Admin) in each partner tenant**, one time each. Part 3 is the
per-app builder step.

> **Why one shared multi-tenant registration:** one app to audit, one secret to rotate, and a
> new kit app onboards by adding a redirect URI — no IT ticket per app, and no per-tenant
> registration triplets. The registration accepting "any organizational directory" is safe
> **only because the kit enforces a server-side tenant allowlist**: the worker validates the ID
> token's `tid` (and its issuer) against `ENTRA_ALLOWED_TENANTS` and refuses everything else,
> byte-uniformly. Authorization never branches on login method — an Entra login and a magic
> link mint the *same* `Principal`; invite-only (`users` table) and the app's
> `ALLOWED_EMAIL_DOMAINS` policy still gate every login.

## Tenant IDs (public — from OIDC discovery)

| Directory | Domain | Tenant ID |
| --- | --- | --- |
| CIAL D&B (hosts the registration) | cialdnb.com | `73605f97-96bb-44f9-8ec9-93ba79679f7d` |
| D&B Israel | dbisrael.co.il | `b0bc8251-7bd6-42a8-ab9a-1b1400673f23` |
| Trusted Partners | trustedpartners.com | `49c52830-6566-4306-8913-eda9078d2bf2` |

cballiance.com has **no** Microsoft tenant — those users (and all external users) use magic links.

## Access model (read this before touching the portal)

The Entra registration **authenticates**; each app **authorizes** — strictly separately:

- **One Entra app for all paved-road apps.** Every kit app signs in through this single
  registration. Being able to authenticate to it means nothing by itself.
- **Access = this app's user list.** A user gets into an app when an admin invites them in
  *that app* (`users` table). **No JIT provisioning**: signing in to app A via Entra never
  creates an account in app B — a valid Microsoft token for an uninvited address gets the
  uniform refusal.
- **Assignment required = No** (Part 1 sets this). Entra-side user assignment is deliberately
  NOT the gate — one shared registration can't express per-app membership, the apps' own
  invite lists can. Don't "harden" this to Yes; it would gate every kit app behind one
  Entra-side list.
- **Login methods per app:** magic link and Entra are co-equal by default, with the login page
  steering known SSO domains to Microsoft (`ENTRA_EMAIL_DOMAINS`, UX only). An app can switch
  magic links **off** (Settings → "Microsoft sign-in only") — enforced server-side, refused
  while SSO is misconfigured **or until a Microsoft sign-in has completed on this app from each
  allowed tenant**, and auto-suspended if SSO's config breaks (availability over policy).
- **SCIM is deliberately out of scope** for now (bigger project). If an app one day needs
  directory-driven provisioning/deprovisioning, that's a new DECISIONS entry — today,
  disabling a user in the app (or force-logout) is the offboarding lever, and Entra-side
  disablement stops NEW sign-ins for that user everywhere anyway.

## Part 0 — the `xms_edov` claim: ✅ LIVE since 2026-07-16 (nothing to do — verify only)

> **On the shared "CIAL Internal Apps" registration this is DONE.** The platform owner added
> `xms_edov` as an ID-token optional claim on 2026-07-16, ahead of any app adopting the identity
> binding shipped 2026-07-15 (the nOAuth fix). **If you are deploying a kit app on the shared
> registration, you do not need to add anything — skip to Part 3.** Keep reading only to verify it,
> or if you are standing up your OWN registration (a dedicated-account app — see the
> account-isolation section of docs/SECURITY-EDGE.md), in which case this is a required step.

- **Verify (do this rather than re-adding it):** decode an ID token from `wrangler tail` and
  confirm the `xms_edov` claim is present, or sign in on staging as a user whose mail ≠ their UPN.
  The running signal is the absence of `oidc_email_claim_untrusted` warnings in the worker logs for
  members — the kit emits that warning (tid only, never an address) precisely because the refusal
  it precedes is byte-uniform and otherwise undiagnosable.
- **Adding it to a NEW registration:** Entra admin center → App registrations → *your registration*
  → Token configuration → Add optional claim → Token type: **ID** → check `xms_edov` → Add. Add
  `email` the same way if absent (accept the Microsoft Graph `email` permission prompt).
- **Why the order mattered** (worth keeping, because the reasoning generalises to any shared
  identity provider): adding the claim is **fully backward-compatible** — the pre-fix resolver never
  read `xms_edov` — so it costs nothing to land early, whereas deploying the code first opens a
  lockout window on a registration **every kit app shares**. Claim first, code second.
- **What it buys:** without it, members whose primary email ≠ their UPN resolve to their UPN and are
  refused if that isn't their invited address. Safe (nobody is admitted *as someone else*) but a
  real lockout. (Guests are a separate case that `xms_edov` does **not** fix — see Part 1 step 2.)

> **NEVER set `acceptMappedClaims: true` on this registration, and never give it a custom signing
> key.** It is **multi-tenant**, and Microsoft's guidance is explicit: *"Do not set the
> acceptMappedClaims property to true for multi-tenant apps, which can allow malicious actors to
> create claims-mapping policies for your app."* The identity binding's safety depends on
> `xms_edov` being un-forgeable — it is a **restricted** (`xms_*`) claim that a tenant admin's
> claims-mapping policy cannot emit, and unlocking restricted claims requires exactly a custom
> signing key. Turning either on re-opens the nOAuth hole from outside the token.

## Part 1 — Create the registration (CIAL tenant, Entra admin)

1. **Entra admin center → App registrations → New registration.**
   - Name: **CIAL Internal Apps**.
   - Supported account types: **Accounts in any organizational directory (Any Microsoft Entra
     ID tenant – Multitenant)**. *Not* single tenant, *not* "+ personal Microsoft accounts".
   - Redirect URI: platform **Web**, value
     `https://staging-<first-app>.cialdnb.ai/auth/oidc/callback` (more added per app in Part 3).
2. **Token configuration → Add optional claim → Token type: ID → add BOTH `email` and
   `xms_edov`** (accept the prompt to add the Microsoft Graph `email` permission). **`xms_edov`
   is required, not optional hardening** — leave it off and some legitimate users cannot sign in.
   Why: `email` is *mutable directory data* that any tenant can set to any value, so the kit
   never trusts it as identity on its own (that is the nOAuth attack — see the Notes below). It
   trusts `email` only when the token proves the issuing tenant may assert that address:
   - `xms_edov: true` — Entra's "email domain owner verified" claim (this step), **or**
   - `email` == `preferred_username` — the email *is* the UPN, so it is domain-bound anyway.

   Otherwise the kit falls back to the UPN (`preferred_username`), and refuses if neither is
   usable. **Consequence if you skip `xms_edov`:** MEMBERS whose primary email differs from their
   UPN resolve to their UPN — if that address isn't the invited one, they are refused. They are
   never admitted *as someone else* (a safe-by-default failure), but they are inconvenienced.
   Adding `xms_edov` removes that **for members**.

   > **B2B guests (`#EXT#` accounts) are a different case, and `xms_edov` does not help them.** A
   > guest's `email` (say `contractor@gmail.com`) is at a domain your tenant does **not** own, so
   > `xms_edov` is false for them no matter what you configure, and their email ≠ their UPN. Their
   > identity therefore resolves to the UPN
   > (`contractor_gmail.com#EXT#@<tenant>.onmicrosoft.com`) and they are refused unless invited
   > under *that* address. This is deliberate: an address the tenant cannot vouch for is exactly
   > what must not be trusted (an admin can point it anywhere — that is the attack).
   >
   > **Admitting a guest — both options have a catch, so read before choosing:**
   > - **Magic link (preferred).** Possession of the mailbox is real proof, and that path is
   >   untouched by this change. *Catch:* it does not exist for an app set to **"Microsoft sign-in
   >   only"** (Part 3) — such an app has **no path in for a guest**. Either accept that, or turn
   >   entra-only off for the app.
   > - **Invite the guest's UPN.** *Catch:* that address is at `<tenant>.onmicrosoft.com`, so with
   >   `ALLOWED_EMAIL_DOMAINS` set to `trusted` or to any specific domain, the login is refused at
   >   the **domain gate before the invite is ever consulted**. You must also add
   >   `<tenant>.onmicrosoft.com` to `ALLOWED_EMAIL_DOMAINS` — understand that this is a *broad*
   >   grant (it lets every guest in that tenant reach the invite check; invite-only is then the
   >   only remaining gate). Verified behaviour, not theory.
   *Optional hardening:* also add the `acct` claim if you later want the app to distinguish
   members from guests (the kit doesn't require it — invite-only already gates).
3. **API permissions:** the defaults (`User.Read` delegated + the `email` addition) are all the
   kit needs — it runs plain OIDC (`openid profile email`) and never calls Graph. Click **Grant
   admin consent for CIAL** so CIAL users get no consent prompts.
4. **Enterprise applications → CIAL Internal Apps → Properties → "Assignment required?" = No.**
   (See "Access model" above — the apps' own invite lists are the gate, not Entra assignment.)
5. **Certificates & secrets → New client secret.** Description `paved-road kit apps`, expiry per
   policy (max 24 months). **Record the value once** — it goes into the account Secrets Store as
   **`PAVED_ROAD_ENTRA_CLIENT_SECRET`** (a SHARED name: every kit app binds it; bootstrap never
   renames it — see `SHARED_SECRET_NAMES` in src/platform/bootstrap.ts):
   `npx wrangler secrets-store secret create dbed52d86420441baa29b42596b0477e --name PAVED_ROAD_ENTRA_CLIENT_SECRET --scopes workers`
6. **Record in docs/RESOURCES.md:** the Application (client) ID and the secret's **expiry date**
   (set a reminder — an expired secret = SSO down, magic links keep working). The secret value
   itself never touches the repo.

## Part 2 — Admin consent in the partner tenants (once per tenant)

A multi-tenant app doesn't exist in dbisrael.co.il / trustedpartners.com until an admin there
consents. Send each tenant's Global Administrator the admin-consent URL (fill in the client id
from Part 1, and any redirect URI registered in Part 1):

```
https://login.microsoftonline.com/b0bc8251-7bd6-42a8-ab9a-1b1400673f23/adminconsent
  ?client_id=<CLIENT_ID>
  &redirect_uri=https://staging-<first-app>.cialdnb.ai/auth/oidc/callback

https://login.microsoftonline.com/49c52830-6566-4306-8913-eda9078d2bf2/adminconsent
  ?client_id=<CLIENT_ID>
  &redirect_uri=https://staging-<first-app>.cialdnb.ai/auth/oidc/callback
```

- After consenting they land on the app's callback **without a login code**, so it shows the
  generic "Sign-in didn't complete" page — **expected and harmless**; the consent already
  registered. Verify in their portal under **Enterprise applications → CIAL Internal Apps**.
- Until a tenant consents, its users see a Microsoft "approval required / AADSTS65001-style"
  screen — nothing in the kit can fix that; it's the signal to (re)send the URL above.

## Part 3 — Per kit app (the builder, once Parts 1–2 exist)

1. Add this app's redirect URIs to the shared registration (Authentication → Web → Add URI):
   - `https://<app>.cialdnb.ai/auth/oidc/callback`
   - `https://staging-<app>.cialdnb.ai/auth/oidc/callback`
2. In **both** `wrangler.jsonc` and `wrangler.staging.jsonc`:
   - set `ENTRA_CLIENT_ID` to the shared registration's client id;
   - set `ENTRA_ALLOWED_TENANTS` to the tenant IDs this app should accept — usually all three
     from the table above, comma-separated. **This is the security boundary: list only
     directories whose admins you trust with your users' email claims.**
   - set `ENTRA_EMAIL_DOMAINS` to the email domains the login form should steer to Microsoft
     (typically `cialdnb.com,dbisrael.co.il,trustedpartners.com`; UX only — magic links stay
     valid for them);
   - uncomment the `ENTRA_CLIENT_SECRET` block under `secrets_store_secrets`.
3. Deploy staging. The login page now shows **Sign in with Microsoft** above the magic-link
   form (the button appears only when the server reports SSO FULLY configured — vars AND
   secret — via `/auth/config`), and steers typed SSO-domain addresses to Microsoft.
4. Optional: **Settings → Login → "Microsoft sign-in only"** switches magic links off for the
   app (internal-only apps). Two guards stand in front of it (turning it **off** is always
   allowed):
   - **Config** — refused (`entra_not_configured`) unless client id, tenant allowlist and secret
     are all present.
   - **Proof** — refused (`entra_never_completed`) until a Microsoft sign-in has **completed** on
     this app **from every tenant in `ENTRA_ALLOWED_TENANTS`**: the `login` audit row with
     `"method":"entra_oidc"` and that tenant's `"tid"`, which the callback writes only after
     minting a session. Complete config is not a working flow. A redirect URI missing from the
     shared registration (`AADSTS50011`) or an expired shared secret breaks sign-in for every
     tenant; a tenant without admin consent (Part 2) breaks it for that tenant's users. Each leaves
     the config valid while real sign-ins die at Microsoft, and enabling entra-only then would lock
     those users out with one click. The refusal and the Settings hint name the tenants still
     unproven: have a user from each sign in once, or remove a tenant the app does not need from
     `ENTRA_ALLOWED_TENANTS` (step 2). So: **on the environment you are switching**, complete one
     Microsoft sign-in from each allowed tenant, then flip it. The proof is read from that
     environment's own audit log: production and staging have separate D1 databases (and
     separately registered redirect URIs), so the staging **Verify** steps below prove nothing
     for production. The proof is that the flow has worked **once**, not that it works **now**:
     if the last Microsoft sign-in there was long ago, do one again right before flipping.

   Once on, it is auto-suspended if SSO's config breaks. It is **not** suspended if the flow
   breaks later with the config intact (an expired shared secret, a deleted redirect URI): those
   look healthy to the app. Rotate the shared secret before it expires, and if Microsoft sign-in
   does break while entra-only is on, an admin with a live session turns it off here.
5. Anything partial — a var without the secret, a malformed GUID — **fails closed**: the button
   hides and/or the callback refuses, with an `entra_misconfigured` error in `wrangler tail`.

## DB Israel apps

A DB Israel app (`node scripts/deployment-target.mjs` prints `dbisrael`) is built and released by
the central DB Israel pipeline (`CialDNB/il-paved-road-deployment`) from its central catalog
entry. Its wrangler configs do nothing for delivery, and Microsoft sign-in is its login until
central email is enabled (ILOPS-8950). Part 3 changes like this:

1. **Redirect URI.** The registration's owner adds
   `https://<app>.staging.dbisrael.ai/auth/oidc/callback`, and the production one on the
   hostname the catalog approves once production is enabled. Which registration DB Israel apps
   use, the shared one or a separate one, is the platform's decision (central
   `docs/app-configuration.md`), which recommends a client secret separate from CIAL's.
2. **The three variables** (`ENTRA_CLIENT_ID`, `ENTRA_ALLOWED_TENANTS`, `ENTRA_EMAIL_DOMAINS`) go
   in the stage's `vars` in the app's catalog entry, by a catalog PR, not in the wrangler configs.
3. **`ENTRA_CLIENT_SECRET` is a Worker secret**, not the CIAL Secrets Store binding (central
   supports no Secrets Store). Someone with DB Israel Cloudflare access sets it on the stage's
   Worker, and the catalog PR in step 2 declares it in `runtime_secrets`, so every release checks
   that it is there (docs/SECRETS.md, "DB Israel apps").
4. **A release** applies the catalog change; there is no deploy from this repo. Then run
   **Verify** below on `https://<app>.staging.dbisrael.ai`. The first owner, seeded by a platform
   operator with central's `seed-owner` workflow, is the first user who can sign in.

## Verify (per app, on staging)

- A **CIAL** user active in `users` completes the Microsoft flow and lands with the same role
  they'd get via magic link (`/api/me` identical).
- A **D&B Israel** or **Trusted Partners** user active in `users` can also sign in — this is the
  cross-tenant + admin-consent proof. Do it for **each** tenant in `ENTRA_ALLOWED_TENANTS`: consent
  is per tenant, and "Microsoft sign-in only" (Part 3 step 4) stays refused until every allowed
  tenant has one completed sign-in.
- A valid Microsoft account **not** in `users` gets the uniform refusal page (invite-only holds).
- A **cballiance.com / external** user still logs in via magic link, untouched.
- The audit log shows `login` with `{"method":"entra_oidc","tid":"…"}`.
- `ALLOWED_EMAIL_DOMAINS` (when set) refuses the same domains on both login paths.
- **Before switching production to "Microsoft sign-in only"** (Part 3 step 4): repeat the
  sign-ins on production, one user from each tenant in `ENTRA_ALLOWED_TENANTS`. The switch reads
  its proof from production's own audit log, and a staging sign-in is not in it.

## Notes

- **What the tenant allowlist defends against — and what it does NOT.** With a multi-tenant
  registration, *any* Azure tenant's admin can mint validly-signed tokens carrying arbitrary
  `email` claims. The `tid` + issuer check confines trust to the three alliance directories.
  But it confines **which directories may authenticate — not which addresses a directory may
  assert**, so it is *not* a defense against impersonation from *inside* the allowlist. That
  gap is **nOAuth** (Descope, 2023): a member of any allowlisted tenant sets their own profile
  email to `owner@cialdnb.com` and signs in as the owner. Note the other gates do not catch it
  either — invite-only passes (the impersonated address *is* invited; that's the point), and
  `ALLOWED_EMAIL_DOMAINS` passes (the spoofed address is *at* an allowed domain). The real
  defense is the **identity binding** in `src/auth/oidc.ts`: `email` is trusted only with
  `xms_edov: true` or when it equals the UPN, else the domain-bound UPN wins. This is why step
  2's `xms_edov` claim matters, and why a partner-directory principal can never become another
  org's app owner. See DECISIONS 2026-07-15.
- **Secret rotation:** create the new secret in the registration, update
  `PAVED_ROAD_ENTRA_CLIENT_SECRET` in the Secrets Store (one place — every app picks it up),
  then delete the old registration secret.
- **Turnstile** is not applied to the SSO path (Microsoft runs its own bot defenses); it keeps
  guarding the magic-link request.
- Kit-side implementation: `src/auth/oidc.ts` (+ routes in `src/auth/routes.ts`), adversarial
  suite in `test/auth/oidc.test.ts`.

Tracked in Linear (AICOE-174; implementation AICOE-139).
