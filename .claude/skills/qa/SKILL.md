---
name: qa
description: Drive the staging deploy in a real browser and verify the user-visible flows — login, permissions, CRUD, admin, health. Use after deploying changes to staging and before /go-live.
---

# /qa — believe the browser, not the unit tests

Tests prove the contract; QA proves the experience. Drive
`https://staging-<app>.cialdnb.ai` with the available browser tooling (Claude in
Chrome / preview tools). If staging was skipped per the rubric, run against
`npm run dev` + `npm run dev:web` and say so in the report.

**Deployment target first.** Run `node scripts/deployment-target.mjs` (or
`npm run -s deployment-target`, where `package.json` has it). It prints the app's target:
- `cial`: the pass below, as written. An app with no `scripts/deployment-target.mjs` predates the
  targets and is CIAL too.
- `dbisrael`: a DB Israel app, delivered centrally. Run the pass with the changes in
  **DB Israel apps** below.
- It exits 1: stop. The deployment marker is invalid, or missing in an app that shows a sign of
  DB Israel delivery. Which target the app has is the owner's decision, made in a reviewed PR;
  never write the marker yourself to get past it.

## The standard pass

1. `/_health` → status ok/degraded; note version + checks.
2. **Login flow:** request a magic link for your invited user. Until zone email is
   live, fetch the link from the staging outbox (`npx wrangler kv key get --binding SESSIONS
   "magic-link-outbox:<address, lowercase>" --remote --config wrangler.staging.jsonc`; the address
   must be listed in the `MAGIC_LINK_OUTBOX` secret — GUIDEBOOK "First login"; older kits logged
   it to `wrangler tail <app>-staging`). Confirm the log line `magic_link_not_emailed` carries no
   link and no address. Verify: opening the link shows a
   "Confirm sign-in" page (deliberate — it stops email scanners from burning the one-time
   link), clicking it logs you in, re-submitting an already-used link fails, and logout works.
3. **Anonymous:** hit `/api/me` and one app endpoint logged-out → 401; an unknown
   API path → the canonical 404 envelope.
4. **Role walk:** as each role you can access (or after inviting a synthetic
   test user per role): tabs the role shouldn't see are hidden AND the underlying
   API 404s when called directly.
5. **CRUD the app's resources** through the UI: create, edit, delete; validation
   errors render readably; empty states look intentional.
6. **Admin:** invite a synthetic user, change a role, disable them (verify instant
   logout), check the audit tab recorded all of it.
7. **Tokens:** mint one, see plaintext once, call the API with it
   (`curl -H "Authorization: Bearer t_..." https://staging-<app>.cialdnb.ai/api/me`),
   revoke, verify 401.
8. **Console + network:** no JS errors, no failing requests, no internals in any
   response body.

## Report

Pass/fail per item with screenshots where useful. Failures become Linear issues
(blockers stop /go-live). Clean up synthetic users you invited.

## DB Israel apps

The pass is the same, with these changes:

- **Where:** `https://<app>.staging.dbisrael.ai`, the central staging hostname, in place of
  `staging-<app>.cialdnb.ai` everywhere above, the token `curl` in item 7 included.
- **From an approved access path.** The central hostnames are WAF-restricted, so run the pass
  from a network the shared WAF rule allows. A WAF block page or another edge denial says nothing
  about the app: record that item as **blocked (network)**, never as a failure, and open no issue
  for it.
- **Item 2 signs in with Microsoft (Entra), not a magic link.** The app holds no Cloudflare
  token, so the staging outbox (`wrangler kv key get … --remote`) is out of reach, and central
  email is not enabled yet (ILOPS-8950). Entra needs three things the platform and the
  registration owner set up: the `ENTRA_*` variables in the app's central catalog entry, a required
  `ENTRA_CLIENT_SECRET` Worker secret, and the redirect URI
  `https://<app>.staging.dbisrael.ai/auth/oidc/callback` on the registration
  (docs/runbooks/entra-sso-setup.md, "DB Israel apps"). Then check that the invited user signs in,
  that a valid Microsoft account that is not invited gets the uniform refusal, and that logout
  ends the session.
- **The first owner.** A new app's database has no users. A platform operator seeds the first
  owner with central's `seed-owner` workflow, which only platform operators can run, using the
  email the app owner gave them. Everyone else is invited from the app, as on CIAL.
- **Until Entra and the first owner are in place, the items that need a login are blocked.**
  Record items 2 and 4–7 as **blocked**, with what is missing, and still run items 1, 3 and 8.
  Never add a bypass to get in (a test login route, a seeded session, a weaker auth setting), and
  don't rewrite the app's auth for QA: blocked is the result until the platform has done its part.
