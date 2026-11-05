# Runbook — Cloudflare Email Sending for magic links

**Goal:** let every kit app send magic-link email from `auth@cialdnb.ai` using Cloudflare's
first-party **Email Sending** (the `EMAIL` Workers binding) — no third-party provider, no API
keys in app code. One-time platform task (DECISIONS 2026-06-13, A1). Maps to handbook §8.3.

**Who runs this:** a person with **admin on the `cialdnb.ai` zone** in Cloudflare account
`13878ca5057070dd0140af23d2d5508f`. The agent-connected Cloudflare token does **not** have
zone/DNS rights, so the agent can't do the onboarding step — it must be run by a human (or a
token scoped with Zone:DNS:Edit + Email).

> **Why Cloudflare, not Resend/SES/SMTP:** keep transactional mail on the platform we already
> run; the kit's `EMAIL` binding already targets it. Swapping providers later means editing only
> `src/email/transport.ts` (the seam) — callers never change.

## What's already in the kit (no work needed)

- `wrangler.jsonc` / `wrangler.staging.jsonc` declare the binding: `"send_email": [{ "name": "EMAIL" }]`.
- `src/email/transport.ts` calls `env.EMAIL.send({ to, from: { email: MAIL_FROM, name: MAIL_FROM_NAME }, … })`, **fail-open**: if the binding is absent or a send fails, it logs and returns `skipped`/`failed` so auth keeps working while setup is pending.
- `MAIL_FROM` / `MAIL_FROM_NAME` vars set the sender.

So once the **domain is onboarded**, sending works with zero code change.

## Steps

1. **Onboard the domain** (the one step that needs zone access):
   ```sh
   npx wrangler email sending enable cialdnb.ai
   ```
   Or Dashboard → the account → **Email** → Email Sending → add `cialdnb.ai`.
2. **Add the offered DNS records** to the `cialdnb.ai` zone — SPF, DKIM, and a DMARC record.
   `wrangler` prints them; apply each on the zone (or accept the Dashboard's automatic add).
3. **Verify onboarding:**
   ```sh
   npx wrangler email sending list      # cialdnb.ai must appear as enabled
   ```
4. **Set the sender** (already defaulted in the kit; confirm):
   `MAIL_FROM=auth@cialdnb.ai`, `MAIL_FROM_NAME="<App Name>"` (or a central "CIAL Internal Apps").
   One onboarding of `cialdnb.ai` covers **every** kit app, because all senders are `@cialdnb.ai`.
5. **Send a real test:** trigger a magic link from any kit app to an address you control; confirm
   delivery and that it lands in the inbox (not spam). Watch `wrangler tail <app>` for the `email`
   send outcome going from `skipped`/`failed` → `sent`. (The `/_health` endpoint does **not**
   report email status — it only checks D1/KV/R2/cron — so don't look there for delivery.)
6. **Deliverability sanity** (see Cloudflare's deliverability guidance): SPF/DKIM aligned, DMARC
   present, always send both `text` and `html` (the kit's templates already do).

## Until this is done

Undelivered magic links are parked in the SESSIONS KV outbox (`magic-link-outbox:<address,
lowercased>`, 15 minutes) in **non-production** environments only, and only for addresses listed in
the `MAGIC_LINK_OUTBOX` secret (the parked value is a live login link, so nobody is opted in by
default — GUIDEBOOK "First login"). The log says only `magic_link_not_emailed` with the outcome and
whether the link was parked — never the link or the address (PIA C5). Once this runbook is done,
delete that secret. The email transport **fails open** in
every environment — production included — so a magic-link request still returns a normal
"check your email" response even when nothing is sent. In production there is no outbox,
so if email isn't onboarded **users silently cannot log in, with no fallback** (it is *not*
safely "blocked" — it is silently broken). That is why onboarding email is a **hard go-live
gate** for any app that relies on email login — see `docs/GO-LIVE.md`.

## Verify / rollback

- Verify: `npx wrangler email sending list` + a delivered test message.
- Rollback: `npx wrangler email sending disable cialdnb.ai` (the transport fail-opens again).

Tracked in Linear (AICOE-173).
