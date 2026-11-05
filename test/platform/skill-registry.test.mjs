// Pins scripts/check-skill-registry.mjs — the guard that every `.claude/skills/<dir>/` holds a
// well-formed, registrable SKILL.md. Plain node:fs, so it runs under `node --test` via
// `test:scripts`. Asserts the real tree is clean AND that the guard fails on each malformed
// shape — a guard that passes everything would be hollow.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { frontmatter, skillDirs, skillDrift } from '../../scripts/check-skill-registry.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OK = '---\nname: demo\ndescription: does a thing. Use when thing.\n---\n\n# /demo\n';

/** A throwaway repo with one well-formed skill. */
function fixture(skills = { demo: OK }) {
  const dir = mkdtempSync(join(tmpdir(), 'skillreg-'));
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(join(dir, '.claude/skills', name), { recursive: true });
    if (body !== null) writeFileSync(join(dir, '.claude/skills', name, 'SKILL.md'), body);
  }
  return dir;
}

function withFixture(skills, body) {
  const dir = fixture(skills);
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The single drift line a one-skill fixture produces, or '' when clean. */
const only = (skills) => {
  let out = '';
  withFixture(skills, (dir) => {
    const d = skillDrift(dir);
    assert.ok(d.length <= 1, `expected at most one finding, got: ${d.join(' | ')}`);
    out = d[0] ?? '';
  });
  return out;
};

describe('skill artifact guard', () => {
  it('passes on the real repo tree', () => {
    assert.deepEqual(skillDrift(REPO), []);
  });

  it('sees every real skill', () => {
    const names = skillDirs(REPO);
    assert.ok(names.includes('plan-to-graph'));
    assert.ok(names.includes('ship'));
    assert.deepEqual(names, [...names].sort(), 'roster should be sorted');
  });

  it('passes on a well-formed fixture', () => {
    withFixture({ demo: OK }, (dir) => assert.deepEqual(skillDrift(dir), []));
  });

  // A renamed or moved SKILL.md must be drift, not a silently-skipped directory: the slash
  // command stops existing while the tree still looks like it holds a skill.
  it('catches a skill directory with no SKILL.md', () => {
    assert.match(only({ demo: null }), /SKILL\.md: missing/);
  });

  it('catches a missing frontmatter block', () => {
    assert.match(only({ demo: '# /demo\n\nno frontmatter here\n' }), /no frontmatter block/);
  });

  it('catches frontmatter with no name', () => {
    assert.match(only({ demo: '---\ndescription: x\n---\n' }), /declares no `name:`/);
  });

  it('catches a name that disagrees with the directory', () => {
    assert.match(only({ demo: '---\nname: demoo\ndescription: x\n---\n' }), /!= directory `demo`/);
  });

  it('catches a name that is not kebab-case', () => {
    assert.match(only({ Demo_1: '---\nname: Demo_1\ndescription: x\n---\n' }), /not kebab-case/);
  });

  it('catches a missing description — the field that makes a skill reachable', () => {
    assert.match(only({ demo: '---\nname: demo\n---\n' }), /declares no `description:`/);
  });

  // Regressions from earlier rounds, kept because each was a real false verdict.
  it('accepts a YAML-quoted name', () => {
    assert.equal(only({ demo: '---\nname: "demo"\ndescription: x\n---\n' }), '');
    assert.equal(only({ demo: "---\nname: 'demo'\ndescription: x\n---\n" }), '');
  });

  it('does not read a body `name:` line as frontmatter', () => {
    const body = '---\ndescription: x\n---\n\n# /demo\n\nFrontmatter looks like:\n\nname: demo\n';
    assert.match(only({ demo: body }), /declares no `name:`/);
  });

  it('reports every malformed skill, not just the first', () => {
    withFixture({ a: null, b: '---\nname: wrong\ndescription: x\n---\n' }, (dir) => {
      const d = skillDrift(dir);
      assert.equal(d.length, 2, d.join(' | '));
      assert.ok(d.some((x) => x.includes('/a/SKILL.md: missing')));
      assert.ok(d.some((x) => x.includes('/b/SKILL.md: frontmatter name `wrong`')));
    });
  });

  it('says so when there are no skills at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skillreg-empty-'));
    try {
      assert.match(skillDrift(dir)[0], /no skills found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('frontmatter()', () => {
    it('returns null when the block never closes', () => {
      assert.equal(frontmatter('---\nname: demo\n'), null);
    });

    it('ignores keys after the closing delimiter', () => {
      assert.deepEqual(frontmatter('---\nname: demo\n---\nother: nope\n'), { name: 'demo' });
    });

    it('tolerates CRLF line endings', () => {
      assert.deepEqual(frontmatter('---\r\nname: demo\r\ndescription: x\r\n---\r\n'), {
        name: 'demo',
        description: 'x',
      });
    });
  });
});
