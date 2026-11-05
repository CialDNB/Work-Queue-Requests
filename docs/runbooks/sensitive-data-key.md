# Runbook — the at-rest sealing key (`SEAL_KEY`): backup & rotation

The Sensitive-Data Protection capability seals high-sensitivity fields at rest with
AES-256-GCM (`src/crypto/seal.ts`). The key is `env.SEAL_KEY` — **64 hex chars (32 bytes)**,
a per-app, per-environment secret.

> **The one thing that matters.** This key is a **single point of total data loss.** There is
> no envelope, escrow, or recovery scheme. **Lose the key → every sealed value is permanently
> unrecoverable.** A D1 backup does not save you — the backup is ciphertext sealed under this
> exact key. So the key MUST be backed up in a real vault, and that backup MUST exist *before*
> the key goes write-only into Cloudflare.

This runbook is only relevant to an app that has **opted in** to sealing a field. The capability
is dormant by default; if no app sets `SEAL_KEY` and seals a column, none of this applies.

## 1. Generate and vault (do this FIRST, before any deploy)

```bash
node scripts/seal-key.mjs --print
```

The script mints the key, prints it, and prints a vault-first checklist. It **deliberately does
not** pipe into `wrangler secret put` — that pipe-and-forget pattern leaves the key with **no
backup**. Instead:

1. **Copy the printed key into the org vault NOW** — 1Password / KMS / your secret manager —
   labelled `"<app> SEAL_KEY (production)"` (and a separate entry for staging). This vault copy
   is the **only** backup.
2. **Then** set it as the per-app Cloudflare secret, **distinct per environment** (separate
   Workers ⇒ separate keys; never share one key across environments or across apps):
   ```bash
   npx wrangler secret put SEAL_KEY --config wrangler.jsonc          # production
   npx wrangler secret put SEAL_KEY --config wrangler.staging.jsonc  # staging (a DIFFERENT key)
   ```
   Or bind it via the account **Secrets Store** (per-app secret name `<APP>_SEAL_KEY`, canonical
   binding `SEAL_KEY`) — the kit reads it through `getSecret()`, so either store works with no
   code change. (To use Secrets Store, add a `secrets_store_secrets` entry for `SEAL_KEY` in the
   wrangler config, mirroring `ANTHROPIC_API_KEY`.)
3. **Record in `docs/RESOURCES.md`** that `SEAL_KEY` is set and where it is vaulted — the
   *location*, never the value.

> **Key store decision (kit default).** The kit standardizes on a **per-Worker secret** resolved
> via `getSecret()`. An app that prefers Secrets Store or an external KMS binds `SEAL_KEY`
> differently in wrangler — no code change. The rotation story below is the same regardless of
> store, because there is no envelope scheme to standardize.

## 2. Verify

- `npx wrangler secret list --config wrangler.jsonc` shows `SEAL_KEY` present.
- A sealed write/read round-trips in staging (seal a value, read it back through the gated
  serializer, confirm the plaintext appears for an entitled user and the D1 console shows
  ciphertext).
- The vault entry exists and a second person can find it (a bus-factor-of-one key is a key you
  have already half-lost).

## 3. Rotation (decrypt-old / re-seal-new)

There is **no envelope scheme**, so rotation is a **data migration**, not a config flip:

1. **Mint the new key and vault it** (step 1) — but do **not** overwrite the Cloudflare secret
   yet.
2. **Re-seal every sealed value**: read each row, `open*` it with the **old** key, `seal*` it
   with the **new** key, write it back. Run this as a one-off migration script (a `src/cron/`
   task guarded by a flag, or a `wrangler d1`-driven script) that decrypts with old and re-seals
   with new. **The old key MUST stay available until re-seal completes** — typically: deploy a
   build that can read both keys (`SEAL_KEY` = new, `SEAL_KEY_OLD` = old), migrate, then drop
   `SEAL_KEY_OLD`.
3. **Cut over**: once every row is re-sealed under the new key, set `SEAL_KEY` to the new value
   everywhere and remove the old key from the running Worker.
4. **Retire the old key** from the vault only after you have confirmed (from a fresh backup taken
   *after* cutover) that nothing still needs it. Keep it long enough that any pre-cutover backup
   you might restore is still openable, or accept that restoring an older backup requires the old
   key too.

> **Why not just swap the secret?** Because every existing ciphertext was sealed under the old
> key. Swapping `SEAL_KEY` without re-sealing makes every existing sealed value fail its
> integrity check (the cipher throws rather than returning a wrong value — by design). Re-seal
> first, cut over second.

## 4. When to rotate

- A suspected key exposure (a deploy-capable admin read it; see the control-plane tripwire +
  `docs/SECURITY-EDGE.md`).
- An operator with key access leaving.
- A scheduled hygiene window per your org's policy.

## 5. Limits (be honest)

- **Detection ≠ prevention.** The control-plane tripwire reports an out-of-band key read; it
  cannot stop a deploy-capable admin from reading `SEAL_KEY` out of the running Worker. The
  preventive lock is least-privilege deploy (only CI can deploy) + branch protection — see
  `docs/GO-LIVE.md`.
- **Key loss = data loss.** Restated because it is the whole game.
- **Sealed columns are unqueryable.** You cannot `WHERE`/`ORDER BY`/`JOIN` on a sealed column;
  aggregate in-Worker after `open*`. (CI enforces this via the semgrep "payload, never predicate"
  rule.)
