// scripts/seal-key.mjs mints the SEAL_KEY. It is the one script whose failure mode is
// PERMANENT DATA LOSS: the key has no envelope/escrow scheme, so a key that reaches Cloudflare
// without first reaching a vault takes every sealed value with it. The script's whole job is to
// make "vault it first" impossible to skip — so the guards ARE the feature, and they get tests.
//
// A spawned child's stdout is a pipe, never a TTY — which is exactly the condition the
// pipe-guard keys on, so `spawnSync` reproduces the real footgun faithfully.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/seal-key.mjs');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const HEX64 = /^[0-9a-f]{64}$/;

describe('seal-key.mjs — refuses to emit a key that nobody will vault', () => {
  it('without --print: mints nothing and exits non-zero', () => {
    const r = run();
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '', 'no key may reach stdout without an explicit acknowledgement');
    assert.match(r.stderr, /Refusing to mint a sealing key without --print/);
  });

  it('--print into a PIPE: refuses (the `| wrangler secret put` footgun)', () => {
    // The exact one-liner the runbook warns against. stdout is a pipe here, so the key would
    // be consumed by the next process unseen and unvaulted — the data-loss path.
    const r = run('--print');
    assert.equal(r.status, 2, '--print into a non-TTY must refuse');
    assert.doesNotMatch(r.stdout, HEX64, 'no key may be written into a pipe');
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Refusing to write a sealing key into a pipe or file/);
    assert.match(r.stderr, /--json/, 'points at the deliberate machine-readable escape');
  });

  it('--print --json into a pipe: allowed (deliberate automation), clean JSON on stdout', () => {
    const r = run('--print', '--json');
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout); // stdout must be JSON *only* — the checklist is stderr
    assert.match(parsed.key, HEX64, '32 bytes / 64 hex = an AES-256 key');
    assert.equal(parsed.binding, 'SEAL_KEY');
    assert.equal(parsed.algorithm, 'AES-256-GCM');
    assert.match(r.stderr, /VAULT IT/i, 'the vault checklist still reaches a human via stderr');
  });

  it('mints a fresh key every run (no fixed/derived key)', () => {
    const keys = new Set(
      Array.from({ length: 5 }, () => JSON.parse(run('--print', '--json').stdout).key),
    );
    assert.equal(keys.size, 5, 'every mint must be independently random');
  });
});
