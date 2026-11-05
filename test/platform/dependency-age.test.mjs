// Pins scripts/kit-checks/check-dependency-age.mjs — the gate that keeps a dependency published in the last
// 24 hours out of the lockfile (the window in which a hijacked npm package is typically caught
// and unpublished).
//
// Run by `node --test` (NOT vitest's Workers pool: the guard imports node:fs), so it's a
// *.test.mjs, outside the `test/**/*.test.ts` glob.
//
// NO NETWORK. Every registry interaction goes through an injected fetcher, the same shape the AI
// client uses — CI must never depend on registry.npmjs.org being reachable to decide whether this
// test passes. The one live check the gate does perform runs in `npm run verify:deps`, not here.
//
// Why this file exists: a fail-closed gate is only worth its comment if the closed cases really
// fail. Every branch that could quietly answer "fine" — no publish time, a 404, a dead network, a
// dependency resolved off-registry — is pinned to a FAILURE here, alongside the ordinary
// too-young case.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ageCutoff,
  checkDependencyAge,
  collectLockfileEntries,
  evaluateVersions,
  lastModifiedProvesOldEnough,
  MIN_RELEASE_AGE_HOURS,
  nameFromLockPath,
  packumentCutoff,
  packumentUrl,
  REGISTRY_HOSTS,
  readLockfile,
  STALENESS_MARGIN_MINUTES,
  uniqueVersions,
  versionFailure,
} from '../../scripts/kit-checks/check-dependency-age.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

/** A minimal lockfile around one dependency node. */
const lockWith = (nodes) => ({
  lockfileVersion: 3,
  packages: { '': { name: 'app' }, ...nodes },
});

const registryDep = (name, version, extra = {}) => ({
  [`node_modules/${name}`]: {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    ...extra,
  },
});

/**
 * Fake fetcher. `packages` maps name -> { lastModified, time, status } — `status` forces an HTTP
 * error, a missing entry is a 404, and `null` makes the request throw (dead network).
 */
function fakeFetch(packages) {
  const calls = { head: [], get: [] };
  const impl = async (url, init = {}) => {
    const name = decodeURIComponent(url.split('/').slice(3).join('/'));
    const method = init.method ?? 'GET';
    calls[method.toLowerCase()].push(name);
    const pkg = packages[name];
    if (pkg === null) throw new Error('ECONNREFUSED');
    if (!pkg) return { ok: false, status: 404, headers: new Headers() };
    if (pkg.status) return { ok: false, status: pkg.status, headers: new Headers() };
    const headers = new Headers(pkg.lastModified ? { 'last-modified': pkg.lastModified } : {});
    if (method === 'HEAD') return { ok: true, status: 200, headers };
    return { ok: true, status: 200, headers, json: async () => ({ name, time: pkg.time }) };
  };
  return { impl, calls };
}

const run = (lock, packages, opts = {}) =>
  checkDependencyAge({ lock, fetchImpl: fakeFetch(packages).impl, now: NOW, ...opts });

describe('dependency release-age gate — constants', () => {
  it('holds the 24h cooldown and a CDN-staleness margin that buries the 5m registry TTL', () => {
    assert.equal(MIN_RELEASE_AGE_HOURS, 24);
    assert.equal(STALENESS_MARGIN_MINUTES, 60);
    assert.deepEqual([...REGISTRY_HOSTS], ['registry.npmjs.org']);
  });

  it('pushes the packument cutoff back by the margin, so a stale HEAD cannot let a publish through', () => {
    assert.equal(ageCutoff(NOW), NOW - 24 * HOUR);
    assert.equal(packumentCutoff(NOW), NOW - 25 * HOUR);
    assert.ok(packumentCutoff(NOW) < ageCutoff(NOW));
  });

  it('escapes the scope separator but not the leading @, npm-style', () => {
    assert.equal(packumentUrl('hono', 'https://r'), 'https://r/hono');
    assert.equal(packumentUrl('@babel/core', 'https://r'), 'https://r/@babel%2Fcore');
  });
});

describe('dependency release-age gate — lockfile reading', () => {
  it('reads the real package-lock.json with nothing unverifiable', async () => {
    const { checked, unverifiable } = collectLockfileEntries(readLockfile(ROOT));
    assert.deepEqual(unverifiable, []);
    assert.ok(checked.length > 100, `expected a populated lockfile, got ${checked.length}`);
    assert.ok(checked.every((e) => e.name && e.version && e.resolved));
  });

  it('names nested and scoped packages by their last node_modules segment', () => {
    assert.equal(nameFromLockPath('node_modules/hono'), 'hono');
    assert.equal(nameFromLockPath('node_modules/a/node_modules/@scope/b'), '@scope/b');
  });

  it('skips the root project and workspace links — neither is a registry download', () => {
    const lock = lockWith({ 'web/lib': { link: true, resolved: 'web/lib' } });
    const { checked, unverifiable } = collectLockfileEntries(lock);
    assert.deepEqual(checked, []);
    assert.deepEqual(unverifiable, []);
  });

  it('collects a registry dependency with its name, version and resolved URL', () => {
    const { checked } = collectLockfileEntries(lockWith(registryDep('hono', '4.13.0')));
    assert.equal(checked.length, 1);
    assert.equal(checked[0].name, 'hono');
    assert.equal(checked[0].version, '4.13.0');
  });

  it('prefers the explicit name field over the path (aliased installs)', () => {
    const lock = lockWith({
      'node_modules/alias': {
        name: 'real-pkg',
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/real-pkg/-/real-pkg-1.0.0.tgz',
      },
    });
    assert.equal(collectLockfileEntries(lock).checked[0].name, 'real-pkg');
  });

  it('flags a dependency resolved off the npm registry as unverifiable, not exempt', () => {
    const lock = lockWith({
      'node_modules/x': { version: '1.0.0', resolved: 'git+ssh://git@github.com/o/x.git#abc' },
    });
    const { checked, unverifiable } = collectLockfileEntries(lock);
    assert.deepEqual(checked, []);
    assert.equal(unverifiable.length, 1);
    assert.match(unverifiable[0], /not the npm registry/);
  });

  it('flags a missing version, a missing resolved URL, an unparseable URL and a junk node', () => {
    const lock = lockWith({
      'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.tgz' },
      'node_modules/b': { version: '1.0.0' },
      'node_modules/c': { version: '1.0.0', resolved: 'not a url' },
      'node_modules/d': 'nope',
    });
    const { checked, unverifiable } = collectLockfileEntries(lock);
    assert.deepEqual(checked, []);
    assert.equal(unverifiable.length, 4);
    assert.match(unverifiable.join('\n'), /no version in the lockfile/);
    assert.match(unverifiable.join('\n'), /no `resolved` URL/);
    assert.match(unverifiable.join('\n'), /unparseable resolved URL/);
    assert.match(unverifiable.join('\n'), /not an object/);
  });

  it('throws loudly on a lockfile it cannot read rather than reporting nothing', () => {
    assert.throws(() => collectLockfileEntries(null), TypeError);
    assert.throws(
      () => collectLockfileEntries({ lockfileVersion: 1 }),
      /unsupported lockfileVersion/,
    );
    assert.throws(() => collectLockfileEntries({ lockfileVersion: 3 }), /no `packages` map/);
  });

  it('deduplicates versions per package name', () => {
    const entries = [
      { name: 'a', version: '1.0.0' },
      { name: 'a', version: '1.0.0' },
      { name: 'a', version: '2.0.0' },
      { name: 'b', version: '1.0.0' },
    ];
    const byName = uniqueVersions(entries);
    assert.equal(byName.size, 2);
    assert.deepEqual([...byName.get('a')].sort(), ['1.0.0', '2.0.0']);
  });
});

describe('dependency release-age gate — age arithmetic', () => {
  it('passes a version older than the cooldown and fails one inside it', () => {
    assert.equal(versionFailure('a', '1.0.0', iso(25 * HOUR), NOW), null);
    const failure = versionFailure('a', '1.0.0', iso(23 * HOUR), NOW);
    assert.match(failure, /published .* \(23\.0h ago\) — under the 24h minimum/);
  });

  it('fails exactly at the boundary minus a millisecond, passes at the boundary', () => {
    assert.equal(versionFailure('a', '1.0.0', iso(24 * HOUR), NOW), null);
    assert.ok(versionFailure('a', '1.0.0', iso(24 * HOUR - 1), NOW));
  });

  it('fails a missing, unparseable or future publish time — unknown age is never a pass', () => {
    assert.match(versionFailure('a', '1.0.0', undefined, NOW), /no publish time/);
    assert.match(versionFailure('a', '1.0.0', 'whenever', NOW), /unparseable publish time/);
    assert.match(versionFailure('a', '1.0.0', iso(-5 * HOUR), NOW), /under the 24h minimum/);
  });

  it('trusts a Last-Modified only when it predates the margin-widened cutoff', () => {
    const cutoff = packumentCutoff(NOW);
    assert.equal(
      lastModifiedProvesOldEnough(new Date(NOW - 26 * HOUR).toUTCString(), cutoff),
      true,
    );
    // Older than the 24h cooldown but inside the staleness margin: not trusted.
    assert.equal(
      lastModifiedProvesOldEnough(new Date(NOW - 24.5 * HOUR).toUTCString(), cutoff),
      false,
    );
    assert.equal(lastModifiedProvesOldEnough(new Date(NOW - HOUR).toUTCString(), cutoff), false);
    assert.equal(lastModifiedProvesOldEnough(undefined, cutoff), false);
    assert.equal(lastModifiedProvesOldEnough('garbage', cutoff), false);
  });

  it('fails a package whose metadata never arrived, and passes one settled by Last-Modified', () => {
    const byName = new Map([['a', new Set(['1.0.0'])]]);
    assert.match(evaluateVersions(byName, new Map(), NOW)[0], /no registry metadata/);
    assert.deepEqual(evaluateVersions(byName, new Map([['a', null]]), NOW), []);
  });
});

describe('dependency release-age gate — end to end (injected fetcher)', () => {
  it('passes on an old dependency without fetching the packument body', async () => {
    const { impl, calls } = fakeFetch({
      hono: { lastModified: new Date(NOW - 40 * HOUR).toUTCString() },
    });
    const { failures, stats } = await checkDependencyAge({
      lock: lockWith(registryDep('hono', '4.13.0')),
      fetchImpl: impl,
      now: NOW,
    });
    assert.deepEqual(failures, []);
    assert.deepEqual(calls.get, [], 'a settled HEAD must not pull the full packument');
    assert.equal(stats.bodiesFetched, 0);
    assert.equal(stats.entries, 1);
  });

  it('escalates to the body when the packument changed recently, then passes an old version', async () => {
    const { impl, calls } = fakeFetch({
      hono: {
        lastModified: new Date(NOW - HOUR).toUTCString(),
        time: { '4.13.0': iso(300 * HOUR), '4.14.0': iso(HOUR) },
      },
    });
    const { failures, stats } = await checkDependencyAge({
      lock: lockWith(registryDep('hono', '4.13.0')),
      fetchImpl: impl,
      now: NOW,
    });
    assert.deepEqual(failures, []);
    assert.deepEqual(calls.get, ['hono'], 'a recent Last-Modified must pull the full packument');
    assert.equal(stats.bodiesFetched, 1);
  });

  it('FAILS a version published inside the 24h window — the attack this gate exists for', async () => {
    const { failures } = await run(lockWith(registryDep('hono', '4.14.0')), {
      hono: { lastModified: new Date(NOW - HOUR).toUTCString(), time: { '4.14.0': iso(2 * HOUR) } },
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /hono@4\.14\.0: published .* \(2\.0h ago\) — under the 24h minimum/);
  });

  it('FAILS a package the registry 404s — the shape of publish-then-unpublish', async () => {
    const { failures } = await run(lockWith(registryDep('gone', '1.0.0')), {});
    assert.equal(failures.length, 1);
    assert.match(failures[0], /gone: could not establish publish times .*404/);
  });

  it('FAILS when the network is dead rather than passing on a fetch it never made', async () => {
    const { failures } = await run(lockWith(registryDep('hono', '4.13.0')), { hono: null });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /hono: could not establish publish times/);
  });

  it('FAILS a packument that carries no time map', async () => {
    const { failures } = await run(lockWith(registryDep('weird', '1.0.0')), {
      weird: { lastModified: new Date(NOW - HOUR).toUTCString(), time: undefined },
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /carries no `time` map/);
  });

  it('FAILS a version the registry knows nothing about', async () => {
    const { failures } = await run(lockWith(registryDep('hono', '9.9.9')), {
      hono: {
        lastModified: new Date(NOW - HOUR).toUTCString(),
        time: { '4.13.0': iso(300 * HOUR) },
      },
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /hono@9\.9\.9: the registry reports no publish time/);
  });

  it('reports every problem in one run instead of stopping at the first', async () => {
    const lock = lockWith({
      ...registryDep('fresh', '2.0.0'),
      ...registryDep('missing', '1.0.0'),
      'node_modules/forked': { version: '1.0.0', resolved: 'https://npm.example.com/forked.tgz' },
    });
    const { failures } = await run(lock, {
      fresh: { lastModified: new Date(NOW - HOUR).toUTCString(), time: { '2.0.0': iso(3 * HOUR) } },
    });
    assert.equal(failures.length, 3);
    assert.match(failures.join('\n'), /not the npm registry/);
    assert.match(failures.join('\n'), /missing: could not establish/);
    assert.match(failures.join('\n'), /fresh@2\.0\.0: published/);
  });
});

describe('dependency release-age gate — the .npmrc half', () => {
  // The script is the enforceable gate; `min-release-age` is the resolution-time seatbelt that
  // stops a too-young version reaching the lockfile in the first place. Pinned here because it is
  // a one-line file that is easy to drop in a merge, and nothing else would notice.
  it("keeps npm's native cooldown set to one day", () => {
    const npmrc = readFileSync(join(ROOT, '.npmrc'), 'utf8');
    assert.match(npmrc, /^min-release-age=1$/m);
  });
});
