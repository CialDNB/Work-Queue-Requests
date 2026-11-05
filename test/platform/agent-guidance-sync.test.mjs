// Pins scripts/check-agent-guidance-sync.mjs — the guard that keeps the curated agent-guidance
// mirrors (AGENTS.md, .cursor/rules/paved-road.mdc, docs/PLAYBOOKS.md) reconciled with the
// canonical CLAUDE.md. Run by `node --test` (it imports node:fs/crypto, not the Workers pool),
// so it's a *.test.mjs picked up by `test:scripts`. Asserts the real tree is in sync AND that
// the guard actually catches drift — a guard that passes everything would be hollow.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  agentGuidanceDrift,
  MANIFEST,
  stampManifest,
} from '../../scripts/check-agent-guidance-sync.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANON = '# agreement\nrule one\n';

// A minimal throwaway "repo" with a manifest + canonical + mirrors, stamped in sync.
function fixture({ agentsAsSymlink = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentsync-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), CANON);
  writeFileSync(join(dir, '.cursor', 'rules', 'paved-road.mdc'), '# cursor rule\n');
  writeFileSync(join(dir, 'docs', 'PLAYBOOKS.md'), '# playbooks\n');
  if (agentsAsSymlink) symlinkSync('CLAUDE.md', join(dir, 'AGENTS.md'));
  else writeFileSync(join(dir, 'AGENTS.md'), CANON); // copy fallback
  writeFileSync(
    join(dir, MANIFEST),
    `${JSON.stringify(
      {
        source: { path: 'CLAUDE.md', sha256: 'placeholder' },
        mirrors: [
          { path: 'AGENTS.md', equalsSource: true },
          { path: '.cursor/rules/paved-road.mdc' },
          { path: 'docs/PLAYBOOKS.md' },
        ],
      },
      null,
      2,
    )}\n`,
  );
  stampManifest(dir); // stamp to the true CLAUDE.md hash → clean
  return dir;
}

describe('agent-guidance drift guard', () => {
  it('passes on the real repo tree', () => {
    assert.deepEqual(agentGuidanceDrift(REPO), []);
  });

  it('passes on a freshly stamped fixture (symlinked AGENTS.md)', () => {
    const dir = fixture();
    try {
      assert.deepEqual(agentGuidanceDrift(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when AGENTS.md is a content copy (Windows / no-symlink fallback)', () => {
    const dir = fixture({ agentsAsSymlink: false });
    try {
      assert.deepEqual(agentGuidanceDrift(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--write re-syncs a COPY AGENTS.md so the loop closes on no-symlink checkouts', () => {
    const dir = fixture({ agentsAsSymlink: false });
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), `${CANON}rule TWO (new)\n`);
      // The edit trips BOTH the hash check and the stale-copy byte-compare.
      assert.ok(agentGuidanceDrift(dir).length >= 2);
      stampManifest(dir); // the documented `--write` action
      // ...must re-sync the copy AND re-hash, leaving the tree clean (not stuck red).
      assert.deepEqual(agentGuidanceDrift(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags an edit to the canonical that was not re-stamped', () => {
    const dir = fixture();
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# agreement\nrule one\nrule TWO (new)\n');
      const failures = agentGuidanceDrift(dir);
      assert.equal(failures.length, 1);
      assert.ok(failures[0].includes('CLAUDE.md changed'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a missing mirror', () => {
    const dir = fixture();
    try {
      rmSync(join(dir, 'docs', 'PLAYBOOKS.md'));
      const failures = agentGuidanceDrift(dir);
      assert.ok(failures.some((f) => f.includes('PLAYBOOKS.md') && f.includes('missing')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags an AGENTS.md that no longer matches the canonical', () => {
    const dir = fixture({ agentsAsSymlink: false });
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# stale copy\n');
      const failures = agentGuidanceDrift(dir);
      assert.ok(failures.some((f) => f.includes('AGENTS.md') && f.includes('does not match')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors clearly when the manifest is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsync-empty-'));
    try {
      const failures = agentGuidanceDrift(dir);
      assert.equal(failures.length, 1);
      assert.ok(failures[0].includes('not found'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
