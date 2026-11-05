#!/usr/bin/env node
// Generate-and-vault-FIRST for the at-rest field-sealing key (Sensitive-Data Protection
// capability). This is the headline safety fix over a pipe-and-forget
// `openssl rand -hex 32 | wrangler secret put` flow: that pattern stores the key ONLY in
// Cloudflare (write-only) with NO backup, so a lost/rotated secret makes every sealed value
// permanently unrecoverable. There is no envelope/escrow scheme — the key is a single point
// of TOTAL DATA LOSS — so this script makes backing it up impossible to skip.
//
// It deliberately does NOT pipe the key into `wrangler secret put`. It mints 32 random bytes
// (64 hex = an AES-256-GCM key), prints them with a vault-first checklist, and stops. You
// capture the value into the org vault (1Password / KMS / your secret manager) BEFORE it goes
// write-only into Cloudflare. The script requires an explicit acknowledgement flag so it can't
// be one-lined into a pipe by reflex.
//
// Usage:
//   node scripts/seal-key.mjs --print              # mint + print + checklist (then vault it)
//   node scripts/seal-key.mjs --print --json       # same, machine-readable {key, ...}
//
// After you have VAULTED the value, set it as the per-app secret (one of):
//   npx wrangler secret put SEAL_KEY --config wrangler.jsonc          # production
//   npx wrangler secret put SEAL_KEY --config wrangler.staging.jsonc  # staging (a DISTINCT key)
//   # or via Secrets Store (per-app secret name, canonical binding) — see the runbook.
//
// Each environment gets a DISTINCT key (separate Workers); never share a key across apps or
// across prod/staging. Rotation = decrypt-with-old / re-seal-with-new; keep the old key until
// re-seal completes. Full backup + rotation runbook: docs/runbooks/sensitive-data-key.md.
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const acknowledged = args.includes('--print');

if (!acknowledged) {
  // Fail loudly rather than printing a secret nobody asked to see. The flag is the
  // forcing-function: you cannot accidentally pipe an un-acknowledged key anywhere.
  console.error(
    [
      'Refusing to mint a sealing key without --print.',
      '',
      'This key is a SINGLE POINT OF TOTAL DATA LOSS — there is no backup unless YOU make one.',
      'Re-run with --print to mint it, then VAULT the value (1Password / KMS) BEFORE setting it',
      'as the Cloudflare secret. Do NOT pipe this into `wrangler secret put`.',
      '',
      '  node scripts/seal-key.mjs --print',
      '',
      'Runbook: docs/runbooks/sensitive-data-key.md',
    ].join('\n'),
  );
  process.exit(2);
}

// --print alone only proves you MEANT to see a key; it cannot tell whether you actually did.
// The documented footgun is `node scripts/seal-key.mjs --print | npx wrangler secret put SEAL_KEY`
// — the key goes write-only into Cloudflare having never been read, let alone vaulted, which is
// precisely the total-data-loss state this script exists to prevent. So when the human-readable
// output is NOT going to a terminal, refuse. `--json` is the deliberate machine-readable mode for
// tooling that owns its own vaulting step (stdout stays clean JSON), so it is exempt by design.
if (!wantJson && !process.stdout.isTTY) {
  console.error(
    [
      'Refusing to write a sealing key into a pipe or file.',
      '',
      'stdout is not a terminal, so this key would be swallowed by another process without a',
      'human ever seeing it — the "piped straight into `wrangler secret put`, never vaulted"',
      'path. Losing this key permanently destroys every value sealed with it.',
      '',
      '  node scripts/seal-key.mjs --print      # read it, VAULT it, then set the secret',
      '',
      'Deliberately automating, with your own vaulting step? Use --json (stdout is clean JSON).',
      '',
      'Runbook: docs/runbooks/sensitive-data-key.md',
    ].join('\n'),
  );
  process.exit(2);
}

const key = randomBytes(32).toString('hex'); // 64 hex chars = 32 bytes = AES-256 key

if (wantJson) {
  // Machine-readable, but still only emitted under --print. The checklist goes to stderr so
  // stdout stays clean JSON for tooling.
  console.error('Generated a sealing key — VAULT IT FIRST (see stderr checklist below).');
  console.log(
    JSON.stringify({
      key,
      bytes: 32,
      algorithm: 'AES-256-GCM',
      binding: 'SEAL_KEY',
      runbook: 'docs/runbooks/sensitive-data-key.md',
    }),
  );
} else {
  console.log(key);
}

console.error(
  [
    '',
    '──────────────────────────────────────────────────────────────────────────────',
    ' Sealing key minted (AES-256-GCM, 32 bytes / 64 hex). VAULT IT BEFORE DEPLOYING.',
    '──────────────────────────────────────────────────────────────────────────────',
    ' 1. Copy the key above into the org vault NOW (1Password / KMS / secret manager),',
    '    labelled "<app> SEAL_KEY (<env>)". This is the ONLY backup — lose it and every',
    '    sealed value is permanently unrecoverable. There is no envelope/escrow scheme.',
    ' 2. THEN set it as the per-app Cloudflare secret (distinct per environment):',
    '       npx wrangler secret put SEAL_KEY --config wrangler.jsonc          # prod',
    '       npx wrangler secret put SEAL_KEY --config wrangler.staging.jsonc  # staging',
    '    (or via Secrets Store — see the runbook). NEVER commit it; NEVER reuse across apps',
    '    or across prod/staging.',
    ' 3. Record in docs/RESOURCES.md that SEAL_KEY is set + vaulted (the location, not the',
    '    value).',
    '',
    ' Rotation later = decrypt-with-old / re-seal-with-new; keep the old key until re-seal',
    ' completes. Full runbook: docs/runbooks/sensitive-data-key.md',
    '──────────────────────────────────────────────────────────────────────────────',
  ].join('\n'),
);
