// web/public/_headers is served by Cloudflare Static Assets, never by the worker, so the
// in-runtime suite cannot reach it — test/security/headers.test.ts says as much ("...is not
// exercised by this in-runtime test"). That left the SPA document's headers with no mechanical
// guard at all: a bad edit here fails nothing until a browser shows it in production.
//
// These pin the security-load-bearing shape of the file. Run by `node --test` (.mjs, outside
// vitest's *.test.ts glob) because it reads the file from disk.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = readFileSync(join(REPO, 'web/public/_headers'), 'utf8');

/** Header lines for one `_headers` path block, as a lowercased name -> value map, plus the set of
 * names the block DETACHES (`! Header-Name`). A block runs from its path line until the next line
 * that starts in column 0 (the next path or a comment). */
function block(path) {
  const lines = RAW.split('\n');
  const start = lines.findIndex((l) => l.trim() === path && !l.startsWith(' '));
  assert.notEqual(start, -1, `_headers has no ${path} block`);
  const out = { detached: new Set() };
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line) || !line.trim()) break;
    const t = line.trim();
    if (t.startsWith('!')) {
      out.detached.add(t.slice(1).trim().toLowerCase());
      continue;
    }
    const i = t.indexOf(':');
    if (i === -1) continue;
    out[t.slice(0, i).trim().toLowerCase()] = t.slice(i + 1).trim();
  }
  return out;
}

/** What the edge ACTUALLY serves for a path under both `/*` and a more specific block. `_headers`
 * COMBINES same-named headers across every matching block (comma-joined) unless the later block
 * detaches the name first — so a test that reads one block in isolation would happily pass while
 * the served header is the concatenation of both. Model the combining, not the file. */
function served(name, specific) {
  const root = block('/*');
  const blk = block(specific);
  const key = name.toLowerCase();
  const parts = blk.detached.has(key) ? [] : [root[key]];
  return [...parts, blk[key]].filter(Boolean).join(', ');
}

// Resolved per-test, never in the describe body: a missing block makes `block()` throw, and at
// describe-body scope that aborts the whole suite (node --test reports "fail 0" with the suite
// itself ✖ — the other assertions never run). Per-test keeps a missing block to ONE named failure.
describe('web/public/_headers — the SPA document + asset headers', () => {
  it('keeps the baseline security headers on /*', () => {
    const root = block('/*');
    assert.equal(root['x-content-type-options'], 'nosniff');
    assert.equal(root['x-frame-options'], 'DENY');
    assert.equal(root['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.match(root['strict-transport-security'], /max-age=31536000/);
  });

  // DECISIONS 2026-08-04: the zone's bot JavaScript Detections injects an inline <script> into
  // HTML at the edge whose body carries the per-request ray id — unhashable, so the CSP below
  // blocks it on every page load. no-transform is Cloudflare's documented way to stop the
  // injection. Dropping it silently reintroduces console CSP violations in every fork.
  it('carries no-transform on /* so the edge cannot inject an unhashable inline script', () => {
    const root = block('/*');
    assert.ok(root['cache-control'], '/* must set Cache-Control');
    assert.match(root['cache-control'], /\bno-transform\b/);
  });

  it('does not weaken script-src to buy that — no inline script is ever allowed', () => {
    const csp = block('/*')['content-security-policy'];
    assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-eval/);
  });

  it("keeps the CSP's other fail-closed anchors", () => {
    const csp = block('/*')['content-security-policy'];
    for (const d of [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ]) {
      assert.ok(csp.includes(d), `CSP lost ${d}`);
    }
  });

  // Asserted on the SERVED value, not the block in isolation. Re-stating Cache-Control under
  // /assets/* does NOT override /* — the two combine, comma-joined — so without the `! Cache-Control`
  // detach the bundles come back `…must-revalidate, no-transform, public, max-age=31536000,
  // immutable`: ambiguous max-age, and no-transform killing edge compression on exactly the files
  // that need it. That regression is invisible to a per-block assertion, which is why this models
  // the combining. (Caught live on a fork after the first cut of this change shipped.)
  it('detaches the inherited Cache-Control on /assets/* so the served value is only immutable', () => {
    assert.ok(
      block('/assets/*').detached.has('cache-control'),
      '/assets/* must detach (! Cache-Control) before setting its own — otherwise the values combine',
    );
    const cc = served('Cache-Control', '/assets/*');
    assert.match(cc, /immutable/);
    assert.match(cc, /max-age=31536000/);
    assert.doesNotMatch(cc, /\bno-transform\b/);
    assert.doesNotMatch(cc, /must-revalidate/);
    assert.doesNotMatch(cc, /max-age=0/);
  });

  it('still serves no-transform on an HTML path, which inherits /* untouched', () => {
    assert.match(served('Cache-Control', '/*'), /\bno-transform\b/);
  });
});
