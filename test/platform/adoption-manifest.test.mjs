// Pins the adoption-manifest contract (docs/ADOPTION-MANIFEST.md + the /adopt command).
//
// The manifest is a CROSS-TOOL schema: generators write it, `adopt` reads it, and the two are
// implemented in different repos by different sessions. There is no runtime here to catch a
// mismatch — the spec document IS the interface. So the canonical example in the spec is treated
// as the schema and pinned: a field added to it without a table row, a renamed key, or a command
// doc that stops naming the file are all drift between producer and consumer, and all silent.
//
// It also pins the two rules that make the manifest safe to read at all: the risk scan stays
// unconditional, and `claims` is never evidence. Those are security properties of `adopt`, not
// prose preferences — a rewrite that drops them should have to say so out loud.
//
// Plain node:fs, so it runs under `node --test` via `test:scripts`.
//
// Nothing here writes the kit's own name as a literal: that string in a test file plants the
// template identity in a fork and reds its `verify:bootstrap` (#178). The manifest
// directory is DERIVED from the spec's own example instead, which is also a stronger assertion.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC_PATH = join(REPO, 'docs', 'ADOPTION-MANIFEST.md');
const SPEC = readFileSync(SPEC_PATH, 'utf8');

/** Every fenced ```json block in the spec that declares a `manifestVersion`. */
function canonicalBlocks(md) {
  const blocks = [];
  const fence = /```json\n([\s\S]*?)```/g;
  let match = fence.exec(md);
  while (match !== null) {
    if (match[1].includes('"manifestVersion"')) blocks.push(match[1]);
    match = fence.exec(md);
  }
  return blocks;
}

/** The spec's prose — everything that is NOT the canonical example. */
const PROSE = SPEC.replace(/```json\n[\s\S]*?```/g, '');

const CANONICAL = canonicalBlocks(SPEC);
const manifest = JSON.parse(CANONICAL[0] ?? '{}');

/** Dotted paths of every leaf in `value`, e.g. `stack.install`. */
function fieldPaths(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    fieldPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

/**
 * The `/…:adopt` command file, found by discovery rather than by naming the kit. A fork carries
 * no plugin mirror at all (`new-app` strips it), so those assertions self-skip there.
 */
function findAdoptCommand() {
  const plugins = join(REPO, 'plugins');
  if (!existsSync(plugins)) return null;
  const hits = readdirSync(plugins, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(plugins, entry.name, 'commands', 'adopt.md'))
    .filter((path) => existsSync(path))
    .sort();
  return hits[0] ?? null;
}

const ADOPT_PATH = findAdoptCommand();
const ADOPT = ADOPT_PATH ? readFileSync(ADOPT_PATH, 'utf8') : null;

describe('adoption manifest — the v1 shape', () => {
  it('the spec carries exactly one canonical example', () => {
    assert.equal(
      CANONICAL.length,
      1,
      'a second manifest example is a second source of truth — express variants in prose',
    );
  });

  it('pins the v1 top level', () => {
    assert.deepEqual(Object.keys(manifest).sort(), [
      'app',
      'claims',
      'generator',
      'manifestVersion',
      'provenance',
      'stack',
      'suggestedTier',
    ]);
    assert.equal(manifest.manifestVersion, 1);
    assert.equal(typeof manifest.manifestVersion, 'number', 'a number, never a string');
  });

  it('pins every nested block', () => {
    assert.deepEqual(Object.keys(manifest.generator).sort(), [
      'generatedAt',
      'name',
      'projectId',
      'version',
    ]);
    assert.deepEqual(Object.keys(manifest.app).sort(), ['name', 'owner', 'summary']);
    assert.deepEqual(Object.keys(manifest.stack).sort(), [
      'build',
      'entry',
      'install',
      'kind',
      'run',
      'test',
    ]);
    assert.deepEqual(Object.keys(manifest.provenance).sort(), ['brandDoc', 'originDoc']);
    assert.deepEqual(Object.keys(manifest.claims).sort(), [
      'ci',
      'complete',
      'durableState',
      'realData',
      'secrets',
    ]);
  });

  it('types the fields a reader branches on', () => {
    assert.ok(
      ['static-spa', 'node-worker', 'other'].includes(manifest.stack.kind),
      `stack.kind outside the v1 enum: ${manifest.stack.kind}`,
    );
    assert.ok(manifest.stack.entry.length > 0, 'stack.entry is what runs first');
    for (const command of ['install', 'build', 'test', 'run']) {
      const value = manifest.stack[command];
      assert.ok(
        value === null || typeof value === 'string',
        `stack.${command} must be a command string or null (null = there is no such step)`,
      );
    }
    for (const [key, value] of Object.entries(manifest.claims)) {
      assert.equal(typeof value, 'string', `claims.${key} is a string; "none" is reserved`);
    }
    assert.equal(
      manifest.claims.complete,
      'yes',
      'the example shows the reserved reassuring value; "truncated" is the one a reader acts on',
    );
    assert.ok([1, 2].includes(manifest.suggestedTier), 'suggestedTier is the tier, 1 or 2');
    assert.match(
      manifest.generator.generatedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      'generatedAt is ISO 8601 UTC',
    );
    assert.ok(manifest.app.owner.includes('@'), 'app.owner is an email address');
  });

  it('reserves the reassuring value in every claim', () => {
    // The polarity is the invariant, not the vocabulary. `"none"` and `"yes"` are the values a
    // reader RELAXES on, so reserving them means every unrecognized string — a typo, `"unknown"`,
    // a word from a later vocabulary — lands on the cautious side. Reserve the alarming value
    // instead and an unknown string is passed over in silence, which is a false negative by
    // construction. Flip this and the whole block stops being safe to read.
    assert.match(PROSE, /"none"[\s\S]{0,80}reserved/i, '"none" is reserved for the scan claims');
    assert.match(PROSE, /"yes"[\s\S]{0,80}reserved/i, '"yes" is reserved for completeness');
    assert.match(PROSE, /"truncated"/, 'the spec names the value a reader acts on');
    // Whitespace-tolerant: the spec hard-wraps at ~98 columns, so any multi-word phrase can grow
    // a newline mid-match the next time a sentence above it is edited.
    assert.match(
      PROSE,
      /fails?\s+toward\s+the\s+warning,\s+never\s+toward\s+silence/i,
      'the reason to reserve the reassuring value must survive a rewrite',
    );
  });

  it('forbids `null` for stack.entry, and scopes where `null` means anything at all', () => {
    // A producer read `entry` as nullable like the four commands under it and shipped
    // `"entry": null` — which asserts "this app has no entry point". The rule has to live in the
    // ROW, because the table is what a producer skims.
    const row = PROSE.split('\n').find((line) => line.startsWith('| `stack.entry`'));
    assert.ok(row, 'stack.entry has a field-table row');
    assert.match(row, /never `null`/, 'the row itself carries the rule, not just the prose below');
    assert.match(
      PROSE,
      /four `stack` commands and nowhere else/i,
      '`null` is meaningful only in the four commands; anywhere else it is wrong-typed',
    );
    // And the four it IS meaningful for stay nullable, or the contrast above says nothing.
    // Located by row and matched on the type, NOT on the whole cell: pinning the cell verbatim
    // reds on a clarifying edit to the Type column, which is a correct change to a rule this
    // very test is defending.
    for (const command of ['install', 'build', 'test', 'run']) {
      const commandRow = PROSE.split('\n').find((line) =>
        line.startsWith(`| \`stack.${command}\``),
      );
      assert.ok(commandRow, `stack.${command} has a field-table row`);
      assert.match(commandRow, /string \\\| null/, `stack.${command} stays nullable`);
    }
  });

  it('documents every field it pins', () => {
    const undocumented = fieldPaths(manifest).filter((path) => !PROSE.includes(path));
    assert.deepEqual(undocumented, [], 'fields in the example with no row in the field table');
  });

  it('keeps the companion files in one directory beside the manifest', () => {
    const { originDoc, brandDoc } = manifest.provenance;
    assert.equal(dirname(originDoc), dirname(brandDoc), 'companions share the manifest directory');
    assert.ok(originDoc.endsWith('/ORIGIN.md'), 'the origin document is the conventional name');
    assert.ok(brandDoc.endsWith('/brand.json'), 'the brand tokens are the conventional name');
    assert.ok(
      PROSE.includes(`${dirname(originDoc)}/adopt.json`),
      'the spec must state the one path the manifest is read from',
    );
  });
});

// A fork carries no plugin mirror at all (`new-app` strips it), so this half self-skips there.
const NO_PLUGIN = ADOPT === null ? 'no plugin mirror in this tree' : false;

describe('adoption manifest — the /adopt command reads it', { skip: NO_PLUGIN }, () => {
  const dir = dirname(manifest.provenance.originDoc);

  it('reads the manifest from the one specified path', () => {
    assert.ok(ADOPT.includes(`${dir}/adopt.json`), 'adopt must name the exact manifest path');
    assert.ok(ADOPT.includes('manifestVersion'), 'adopt must gate on the version field');
    assert.ok(ADOPT.includes('ADOPTION-MANIFEST.md'), 'adopt must link the spec');
  });

  it('uses the manifest for stack, entry and commands', () => {
    for (const field of ['stack.kind', 'stack.entry', 'app.name', 'suggestedTier']) {
      assert.ok(ADOPT.includes(field), `adopt should say what it does with ${field}`);
    }
    assert.ok(ADOPT.includes(`${dir}/ORIGIN.md`), 'the origin document is the Tier 2 payload');
  });

  it('keeps the risk scan unconditional', () => {
    const manifestAt = ADOPT.indexOf(`${dir}/adopt.json`);
    const scanAt = ADOPT.indexOf('Risk scan:');
    assert.ok(scanAt > manifestAt, 'the risk scan must sit outside the manifest fast path');
    // Reworded? Then the invariant was touched — re-read the trust boundary before re-pinning.
    assert.match(ADOPT, /never skipped/i, 'the scan runs whether or not a manifest claims "none"');
    assert.ok(ADOPT.includes('claims'), 'adopt must name the field it refuses to trust');
  });

  it('surfaces a truncated export before the tier question', () => {
    // A generator with a size bound ships a fragment past that bound, and nothing in the repo
    // reveals it. Tier 1 would then wrap guardrails around a partial app and Tier 2 would plan a
    // rebuild from a partial ORIGIN.md — so the flag has to reach the user BEFORE Step 2, not in
    // a summary after it.
    assert.ok(ADOPT.includes('claims.complete'), 'adopt must name the completeness claim');
    assert.match(ADOPT, /"truncated"/, 'and the value it acts on');
    const completeAt = ADOPT.indexOf('claims.complete');
    const tierAt = ADOPT.indexOf('## Step 2');
    assert.ok(tierAt > 0, 'the tier question is Step 2');
    assert.ok(
      completeAt > 0 && completeAt < tierAt,
      'a truncated export must reach the user before they pick a tier — it changes the answer',
    );
  });

  it('treats an unusable manifest as a fallback, not an error', () => {
    assert.match(ADOPT, /invalid or unrecognized/i, 'the unusable cases are named');
    assert.match(ADOPT, /fall back to \S+ detection/i, 'and they land in plain detection');
  });
});
