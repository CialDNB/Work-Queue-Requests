// Migration ordinals are a coordination point between parallel branches, so they get a guard.
//
// wrangler applies migrations/d1/*.sql in ordinal order and records each one by FILE NAME. Two
// branches that both take `0004` therefore both merge cleanly and both apply — in whichever order
// their slugs happen to sort — and nothing goes red. The only place that collision can be caught is
// here, on the second PR. So every file in the folder is `NNNN_slug.sql`, and the ordinals are
// unique and contiguous from 0000: a clash or a gap is a red CI run, never a silent reorder.
//
// Reads the directory with node:fs — the listing wrangler itself walks — so it runs under
// `node --test` via `test:scripts`, independent of the Vite glob the test harness uses.
import { strict as assert } from 'node:assert';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

const DIR = new URL('../../migrations/d1/', import.meta.url);
const NOT_A_MIGRATION = new Set(['README.md']);
// Four digits, then a lowercase snake_case slug — the shape every existing file has, and what
// `wrangler d1 migrations create DB "<slug>"` produces for a snake_case slug.
const MIGRATION_NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
// Files a fork applied BEFORE it adopted this guard, under a name the slug rule rejects. Never
// rename one to satisfy the rule: wrangler records applied migrations by FILE NAME, so a renamed
// file is a new migration to it and runs a second time on the next deploy. List the exact name
// here instead. Its leading digits still count as its ordinal (wrangler orders by them too), so it
// still cannot clash or leave a gap. Empty in the kit: a new file always takes the NNNN_slug form.
const APPLIED_BEFORE_THE_GUARD = new Set([]);
const LEADING_ORDINAL = /^(\d+)/;

/** The directory entries the guard judges. */
function migrationCandidates(listing) {
  // Dotfiles are untracked OS litter (macOS Finder writes .DS_Store; .gitignore keeps it out of
  // CI) and wrangler only applies *.sql, so judging one would fail a local `npm run ci` for nothing.
  return listing.filter((name) => !name.startsWith('.') && !NOT_A_MIGRATION.has(name));
}

/** Every reason `names` is not a well-formed migration sequence; `[]` means it is. */
function ordinalProblems(names, legacy = APPLIED_BEFORE_THE_GUARD) {
  const problems = [];
  const byOrdinal = new Map();
  for (const name of [...names].sort()) {
    const match =
      MIGRATION_NAME.exec(name) ?? (legacy.has(name) ? LEADING_ORDINAL.exec(name) : null);
    if (!match) {
      problems.push(`${name}: not NNNN_snake_case_slug.sql`);
      continue;
    }
    const ordinal = Number(match[1]);
    const taken = byOrdinal.get(ordinal);
    if (taken) {
      problems.push(
        `ordinal ${String(ordinal).padStart(4, '0')} is taken twice: ${taken} and ${name}`,
      );
    } else {
      byOrdinal.set(ordinal, name);
    }
  }
  const ordinals = [...byOrdinal.keys()].sort((a, b) => a - b);
  const gapAt = ordinals.findIndex((ordinal, i) => ordinal !== i);
  if (gapAt !== -1) {
    const expected = String(gapAt).padStart(4, '0');
    problems.push(`ordinal ${expected} is missing — next is ${byOrdinal.get(ordinals[gapAt])}`);
  }
  return problems;
}

describe('migrations/d1 ordinals', () => {
  it('every file is NNNN_slug.sql, with unique ordinals contiguous from 0000', () => {
    const names = migrationCandidates(readdirSync(DIR));
    assert.ok(names.length > 0, 'migrations/d1 holds at least the kit migration 0000');
    assert.deepEqual(ordinalProblems(names), []);
  });

  it('skips the README and untracked OS dotfiles, and nothing else', () => {
    assert.deepEqual(migrationCandidates(['.DS_Store', 'README.md', '0000_a.sql']), ['0000_a.sql']);
    assert.deepEqual(migrationCandidates(['notes.txt', '0000_a.sql']), ['notes.txt', '0000_a.sql']);
  });

  it('turns a second 0004 into a failure instead of two silently applied files', () => {
    const problems = ordinalProblems([
      '0000_a.sql',
      '0001_b.sql',
      '0002_c.sql',
      '0003_d.sql',
      '0004_model_tier.sql',
      '0004_caller_metadata.sql',
    ]);
    assert.deepEqual(problems, [
      'ordinal 0004 is taken twice: 0004_caller_metadata.sql and 0004_model_tier.sql',
    ]);
  });

  it('fails on a gap, and on a sequence that does not start at 0000', () => {
    assert.deepEqual(ordinalProblems(['0000_a.sql', '0002_c.sql']), [
      'ordinal 0001 is missing — next is 0002_c.sql',
    ]);
    assert.deepEqual(ordinalProblems(['0001_a.sql']), [
      'ordinal 0000 is missing — next is 0001_a.sql',
    ]);
  });

  it('fails on a name wrangler would still apply but the convention forbids', () => {
    // Anything ending in .sql is applied by wrangler, so a malformed name is not cosmetic: it
    // escapes the ordinal checks above.
    for (const name of [
      '0004-model-tier.sql',
      '4_model_tier.sql',
      '00004_model_tier.sql',
      '0004_Model_Tier.sql',
      '0004_model tier.sql',
      '0004_.sql',
      '0004_model_tier.SQL',
      'model_tier.sql',
      'notes.txt',
    ]) {
      assert.deepEqual(
        ordinalProblems(['0000_a.sql', name]),
        [`${name}: not NNNN_snake_case_slug.sql`],
        name,
      );
    }
  });

  it('lets a listed pre-guard file keep its name, but still holds it to the ordinal rules', () => {
    // The adoption path for a fork whose folder predates the guard: renaming an applied file would
    // make wrangler run it again, so the exact name is listed instead of changed.
    const legacy = new Set(['0001-Add-Users.sql']);
    assert.deepEqual(
      ordinalProblems(['0000_a.sql', '0001-Add-Users.sql', '0002_c.sql'], legacy),
      [],
    );
    assert.deepEqual(ordinalProblems(['0000_a.sql', '0001-Add-Users.sql'], new Set()), [
      '0001-Add-Users.sql: not NNNN_snake_case_slug.sql',
    ]);
    assert.deepEqual(ordinalProblems(['0000_a.sql', '0001-Add-Users.sql', '0001_b.sql'], legacy), [
      'ordinal 0001 is taken twice: 0001-Add-Users.sql and 0001_b.sql',
    ]);
    assert.deepEqual(ordinalProblems(['0000_a.sql', '0002-Late.sql'], new Set(['0002-Late.sql'])), [
      'ordinal 0001 is missing — next is 0002-Late.sql',
    ]);
  });
});
