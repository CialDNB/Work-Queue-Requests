# Runbook — the control-plane tripwire (audit-watch): arming & hosting

The control-plane tripwire (`src/cron/auditWatch.ts`) is a **detective** control for the
Sensitive-Data Protection capability. It scans the Cloudflare **Account Audit Log** hourly for
changes to **this app's resources** (its Worker, secrets, D1, R2) made by an actor **outside the
sanctioned deploy pipeline**, writes a forensic audit row, and emails the owner.

> **Why it exists.** When an app seals a field at rest (`src/crypto/seal.ts`), D1 dumps and R2
> backups carry only ciphertext, and the key (`SEAL_KEY`) lives **solely in the running Worker**.
> The only way to turn ciphertext into plaintext is to run code with that binding — i.e. deploy/
> edit the Worker or change its secrets. Every such change is an auditable control-plane event.
> Sanctioned deploys go through the CI token; a change by anyone else is the signal.

> **Detective, not preventive.** It **reports** a control-plane change; it cannot **stop** a
> one-shot key read (after which the holder decrypts offline forever). The actual lock is least
> privilege + branch protection — today via `docs/GO-LIVE.md` gate 8a (required to graduate to
> Stable); a dedicated preventive-lock gate is specced in Phase 3 and NOT yet landed. The seal +
> this tripwire are defense-in-depth around that lock — not a replacement for it.

**Dormant by default.** The hourly trigger ships COMMENTED in both wrangler configs, in lockstep
with the `AUDIT_API_TOKEN` binding — an app that never opts in never runs the watcher and pays no
audit rows. Arming = uncomment BOTH (trigger + binding) and set the secret. If the trigger is armed
but the token is missing, the tick no-ops and writes an `audit_watch_skipped` row, so a
half-configured tripwire is visible rather than silent.

## 1. Arm the in-account cron (the default)

1. **Mint a Cloudflare API token** scoped **"Account · Audit Logs · Read"** (only that — least
   privilege; this token cannot deploy or read secrets). Account
   `13878ca5057070dd0140af23d2d5508f`.
2. **Store it as the per-app secret** `<APP>_AUDIT_API_TOKEN` in the account Secrets Store, then
   **uncomment** the `AUDIT_API_TOKEN` binding in `wrangler.jsonc` (and `wrangler.staging.jsonc`
   if you want staging coverage). The kit reads it via `getSecret()`, so a plain
   `wrangler secret put AUDIT_API_TOKEN` works too — but keep the canonical binding name.
3. **Leave `AUDIT_DEPLOY_ACTORS` empty at first.** Empty = **every** control-plane change to this
   app alerts (the safe no-false-negative default: a deploy receipt beats a missed key read). The
   first alerts will show your CI token's actor email/id — add those (comma-separated) to
   `AUDIT_DEPLOY_ACTORS` to silence routine deploys, leaving only the unexpected ones.
4. **`AUDIT_MATCH`** defaults to `APP_NAME`; override only if the app's resources are renamed off
   the `<app>` scheme.
5. The hourly cron (`0 * * * *`) is already in `triggers.crons`; `controller.cron` routes it to the
   tripwire (the daily ops loop is unaffected). First run only sets the cursor — it alerts nothing
   pre-enablement.

**Verify:** after the next hour, `/_health` / the audit tab shows an `audit_watch_initialized`
row; make a benign dashboard change to an app resource and confirm a `security_audit_alert` row +
an email within the hour.

## 2. The blast-radius caveat — and the GitHub-Actions variant

The in-account cron runs **inside the Cloudflare account it watches**, so a deploy-capable admin
can **disable the cron** (or the Worker) and silence it. For a watcher that **cannot** be silenced
from inside the account, run the same check from **outside** Cloudflare — a scheduled **GitHub
Action**:

- A scheduled workflow (`on: schedule: - cron: "0 * * * *"`) that calls the same Cloudflare Audit
  Log API with an **Audit-Logs-Read token held as a GitHub secret**, runs the equivalent of
  `detectSuspicious` (the pure core is portable — it's plain TS with no Worker bindings), keeps its
  cursor in the workflow's cache or a committed state file, and alerts via the same channel (email
  / Slack webhook).
- **Trade-off:** it lives outside the app's blast radius (a Cloudflare admin can't silence it), at
  the cost of a second place to run and a second token to hold (now in GitHub, scoped read-only).
  Branch protection on the workflow file keeps a deploy-capable admin from quietly editing the
  watcher itself.

**Which to pick:** the in-account cron is the right default for most internal apps (simple, reuses
existing infra). Choose the GitHub-Actions variant when the threat model includes a malicious
deploy-capable admin — i.e. exactly when the seal matters most. They are not exclusive; running
both is strongest (the in-account one is faster to wire; the external one is harder to silence).

## 3. Limits (be honest)

- **Detection ≠ prevention** (restated — it's the whole point).
- **In-account watcher is in its own blast radius** (§2) — the GitHub-Actions variant is the
  harder-to-silence form.
- The match is a **string-fragment** scope over account-wide logs; if another app's resource name
  contains this app's fragment you may see a benign cross-hit (tune `AUDIT_MATCH`). Erring toward
  over-matching is deliberate — a false positive is a deploy receipt; a false negative is a missed
  key read.
