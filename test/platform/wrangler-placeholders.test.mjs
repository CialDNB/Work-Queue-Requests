// Pins the placeholder-hygiene half of scripts/check-edge-hardening.mjs — the guard that keeps
// the provisioning sentinel out of COMMENTS in the deploying wrangler configs, and keeps `<fill
// me in>` out of live binding ids.
//
// Why the guard exists: the production preflight in .github/workflows/deploy-prod.yml greps
// wrangler.jsonc for the sentinel, and grep cannot tell a JSONC comment from live config. The kit
// itself shipped a commented optional CACHE binding carrying that sentinel, so every fork that
// adopted 0.2.0 and kept the line was primed to fail its FIRST production deploy — unclearable,
// because the remedy the error prints (`npm run provision`) has nothing left to provision.
// CialDNB/consumption hit it live on 2026-08-04 (run 30949526419). DECISIONS 2026-08-04.
//
// Same shape as edge-hardening.test.mjs, and for the same reason: the guard is what forces forks
// to adopt an invariant that lives in wrangler.jsonc, a file /kit-upgrade does NOT diff. If the
// guard silently passed everything that enforcement would be hollow — so pin both that the real
// configs pass and that each bad shape fails.
//
// Run by `node --test` (.mjs, outside vitest's `test/**/*.test.ts` glob) because the guard reads
// files from disk.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  checkPlaceholderHygiene,
  DEPLOYING_CONFIGS,
  exampleIdCommentFailures,
  placeholderCommentFailures,
  unfilledIdFailures,
} from '../../scripts/check-edge-hardening.mjs';
import { PROVISION_PLACEHOLDER } from '../../scripts/new-app.mjs';

const REPO = new URL('../../', import.meta.url);
const read = (file) => readFileSync(new URL(file, REPO), 'utf8');

// The sentinel comes from the canonical mirror, never a local literal: a hand-copied string
// would leave this guard silently vacuous after a rename — still green while searching for
// something that no longer exists anywhere.
const S = PROVISION_PLACEHOLDER;

describe('wrangler placeholder guard', () => {
  it('passes on the repo wrangler.jsonc + wrangler.staging.jsonc', () => {
    assert.deepEqual(checkPlaceholderHygiene(), []);
  });

  // The loop in the guard is data-driven, and a config list that lost wrangler.jsonc would make
  // it pass vacuously — the ONE file the production preflight actually greps must be in scope.
  it('covers the file the production preflight greps', () => {
    assert.ok(DEPLOYING_CONFIGS.includes('wrangler.jsonc'));
  });

  it('flags the exact line the kit used to ship', () => {
    const bad = placeholderCommentFailures('c', `    // { "binding": "CACHE", "id": "${S}" }`);
    assert.equal(bad.length, 1);
    assert.match(bad[0], /^c:1: /);
  });

  // The two shapes a line-based matcher misses. Both are legal JSONC and both trip the real grep.
  it('flags a sentinel buried in a block-comment body', () => {
    const bad = placeholderCommentFailures('c', `[\n/* optional:\n{ "id": "${S}" }\n*/\n]`);
    assert.equal(bad.length, 1);
    assert.match(bad[0], /^c:3: /);
  });

  it('flags a trailing block comment on an otherwise-live line', () => {
    assert.equal(placeholderCommentFailures('c', `{ "a": 1 } /* was "${S}" */`).length, 1);
  });

  it('flags a trailing // comment on an otherwise-live line', () => {
    assert.equal(placeholderCommentFailures('c', `{ "a": 1 } // was "${S}"`).length, 1);
  });

  it('flags prose that names the sentinel — grep trips on that too', () => {
    assert.equal(placeholderCommentFailures('c', `  // provision fills ${S} below`).length, 1);
  });

  it('accepts a live binding line, which is what the preflight is FOR', () => {
    assert.deepEqual(
      placeholderCommentFailures('c', `{ "binding": "SESSIONS", "id": "${S}" }`),
      [],
    );
    assert.deepEqual(placeholderCommentFailures('c', `  "database_id": "${S}",`), []);
  });

  // src/platform/bootstrap.ts:125-128 records the kit shipping a real bug from treating a `//`
  // inside a string value as a comment. The guard reuses that file's string-aware scanner, so a
  // URL beside an unprovisioned id must NOT be mistaken for a comment.
  it('does not mistake the // in a URL value for a comment opener', () => {
    assert.deepEqual(placeholderCommentFailures('c', `{ "u": "https://x", "id": "${S}" }`), []);
  });

  // The exact stale line that merged green on 2026-08-04: a fill-in id in a comment carries no
  // sentinel, so the sentinel check alone waved it through while DECISIONS claimed the example
  // was id-free. This is the check that would have caught it.
  it('flags a fill-in id written inside a comment', () => {
    const bad = exampleIdCommentFailures(
      'c',
      '    //   { "binding": "CACHE", "id": "<the id that command prints>" }',
    );
    assert.equal(bad.length, 1);
    assert.match(bad[0], /^c:1: /);
  });

  it('leaves the commented secret examples and their real store_ids alone', () => {
    // Both deploying configs legitimately ship four of these; only `<…>` id-shaped values fail.
    assert.deepEqual(
      exampleIdCommentFailures('c', '    //   "store_id": "dbed52d86420441baa29b42596b0477e",'),
      [],
    );
    assert.deepEqual(exampleIdCommentFailures('c', '  // pick <a name> for the namespace'), []);
  });

  it('does not flag a live binding id that legitimately contains no fill-in', () => {
    assert.deepEqual(exampleIdCommentFailures('c', '{ "id": "a1b2c3" }'), []);
  });

  it('flags an unfilled <fill me in> left in a live binding id', () => {
    const bad = unfilledIdFailures('c', {
      d1_databases: [{ database_id: '<the id that command prints>' }],
      kv_namespaces: [{ binding: 'SESSIONS', id: 'a1b2c3' }],
    });
    assert.equal(bad.length, 1);
    assert.match(bad[0], /database_id/);
  });

  it('accepts real ids and tolerates a malformed config', () => {
    assert.deepEqual(
      unfilledIdFailures('c', { d1_databases: [{ database_id: 'a1b2' }], kv_namespaces: [] }),
      [],
    );
    assert.deepEqual(unfilledIdFailures('c', null), []);
    assert.deepEqual(unfilledIdFailures('c', { d1_databases: 'nope', kv_namespaces: 7 }), []);
  });

  // Pins the premise. If a future change makes the preflight comment-aware (or moves it out of
  // the workflow), this guard's reason to exist changes — fail loudly and make that a decision.
  it('stays coupled to the preflight the deploy workflow actually runs', () => {
    assert.ok(
      read('.github/workflows/deploy-prod.yml').includes(`grep -n ${S} wrangler.jsonc`),
      'deploy-prod.yml no longer runs the blunt grep preflight — revisit this guard.',
    );
  });
});
