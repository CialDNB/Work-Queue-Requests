// Pins scripts/sync-checks.mjs — the guard that keeps a fork's copy of the shared kit checks
// honest about which kit version it came from.
//
// Two failures this exists to catch, both silent by construction:
//   1. A payload file changes and nobody decides whether CHECKS_VERSION should move. The fork
//      then reports a version that describes different bytes than it is running.
//   2. A NEW check lands in scripts/kit-checks/ and is not covered by the hash. This is the
//      exact bug the kit's plugin sync (sync-from-harness.mjs) shipped and documented: an allowlist
//      "silently left commands/, assets/ and hooks/hooks.json … outside the invariant it
//      claimed to enforce". Hashing the directory by exclusion is the fix, so the test that
//      matters most is the one proving a brand-new file changes the hash without anyone
//      remembering to list it.
//
// Driven in-process via the module's exports; the CLI guard is exercised by spawning at the end.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  drift,
  payloadFiles,
  payloadHash,
  readStamp,
  run,
  writeStamp,
} from '../../scripts/sync-checks.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A throwaway repo carrying just enough shape for the script: payload, stamp, version file. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'checks-sync-'));
  mkdirSync(join(root, 'scripts/kit-checks'), { recursive: true });
  mkdirSync(join(root, 'src/framework'), { recursive: true });
  cpSync(join(REPO, 'scripts/kit-checks'), join(root, 'scripts/kit-checks'), { recursive: true });
  writeFileSync(join(root, 'src/framework/version.ts'), "export const CHECKS_VERSION = '1.0.0';\n");
  writeStamp(root);
  return root;
}

describe('kit-checks payload', () => {
  it('excludes its own stamp — otherwise stamping would change the hash it just recorded', () => {
    assert.equal(
      payloadFiles(REPO).some((f) => f.endsWith('checks.sync.json')),
      false,
    );
  });

  it('covers a NEW file with nobody listing it (the allowlist bug, in reverse)', () => {
    const root = fixture();
    try {
      const before = payloadHash(root);
      writeFileSync(join(root, 'scripts/kit-checks/check-brand-new.mjs'), '// added tomorrow\n');
      assert.notEqual(payloadHash(root), before, 'a new payload file must change the hash');
      assert.equal(drift(root).length, 1, 'and must fail --check until re-stamped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a rename as a change — path is hashed, not just bytes', () => {
    const root = fixture();
    try {
      const before = payloadHash(root);
      const from = join(root, 'scripts/kit-checks/main-module.mjs');
      writeFileSync(join(root, 'scripts/kit-checks/renamed.mjs'), readFileSync(from));
      rmSync(from);
      assert.notEqual(payloadHash(root), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('drift detection', () => {
  it('is green on a freshly stamped tree', () => {
    const root = fixture();
    try {
      assert.deepEqual(drift(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when a payload file is edited without re-stamping', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, 'scripts/kit-checks/main-module.mjs'), '// tampered\n');
      const failures = drift(root);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /changed since it was stamped/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the stamp and CHECKS_VERSION disagree — the registry reports the second', () => {
    const root = fixture();
    try {
      writeFileSync(
        join(root, 'src/framework/version.ts'),
        "export const CHECKS_VERSION = '9.9.9';\n",
      );
      const failures = drift(root);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /version drift/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loudly when CHECKS_VERSION is missing rather than reporting nothing', () => {
    const root = fixture();
    try {
      writeFileSync(
        join(root, 'src/framework/version.ts'),
        'export const KIT_VERSION = "0.2.1";\n',
      );
      assert.match(drift(root)[0], /CHECKS_VERSION not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when never stamped, and names the command that fixes it', () => {
    const root = fixture();
    try {
      rmSync(join(root, 'scripts/kit-checks/checks.sync.json'));
      assert.match(drift(root)[0], /not yet stamped.*--stamp/s);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cli', () => {
  it('refuses --check and --stamp together', () => {
    const r = run(['--check', '--stamp'], REPO);
    assert.equal(r.code, 2);
  });

  it('--check is offline: it never shells out to gh', () => {
    // PATH emptied, so any attempt to invoke `gh` would fail. --check must still pass.
    const r = spawnSync(process.execPath, ['scripts/sync-checks.mjs', '--check'], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
    assert.equal(r.status, 0, r.stderr);
  });

  it('this repo is stamped and in sync', () => {
    assert.deepEqual(drift(REPO), []);
    assert.equal(readStamp(REPO).checksVersion, '1.1.0');
  });
});
