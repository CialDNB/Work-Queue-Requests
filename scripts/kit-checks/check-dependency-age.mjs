// Dependency release-age gate: no version in package-lock.json may have been published to the
// npm registry within the last 24 hours.
//
// WHY. The npm supply-chain attacks of the last two years share one shape: a maintainer account
// is hijacked, a malicious version is published, and it is caught and unpublished within hours.
// Every fork that ran `npm install` inside that window shipped the payload; every fork that
// waited a day did not. A 24-hour cooldown converts "we got lucky" into a control.
//
// WHY A SCRIPT AND NOT JUST CONFIG. npm DOES have a native cooldown — `min-release-age`, added
// in npm 11.10, set here in `.npmrc` (see that file). It is real and worth having, but it is not
// this gate and cannot be:
//
//   * It is a RESOLUTION filter. npm flattens `min-release-age=1` into a rolling
//     `before=<now-1d>` and applies it while BUILDING the tree — `npm install`, `npm update`,
//     `npm view`. Verified locally on npm 11.11.0: `npm config list` shows the project config
//     resolving to `before = "<now minus one day>"`, recomputed per invocation.
//   * `npm ci` does no resolution. It installs the lockfile verbatim, so the cooldown has
//     nothing to filter — which is precisely what CI runs, and precisely where a too-young
//     version would ride in.
//   * It is silently inert on npm < 11.10 (node 22 still ships npm 10), so it protects only
//     developers who happen to be current.
//
// So the config is the seatbelt on the way in and this script is the gate at the door: it reads
// the lockfile that will actually be installed and checks every resolved version's publish time
// against the registry. Config prevents, the gate verifies — and only the gate is enforceable.
//
// FAIL CLOSED, everywhere. Missing publish time, a 404 (the exact shape of a
// published-then-unpublished attack), a network error that outlives its retries, a dependency
// resolved from somewhere other than the npm registry whose age cannot be established — all of
// them FAIL. A release-age gate that exempts whatever it could not check is a gate with a hole
// in the shape of the attack.
//
// HOW IT STAYS CHEAP. The naive form — a full packument per package — is hundreds of MB per run
// (`hono` alone is ~6 MB). Instead each package name gets a HEAD request first: the packument's
// `Last-Modified` is the moment it last changed, so nothing in it can be newer than that. When
// Last-Modified predates the cutoff (plus an hour of margin for CDN staleness), every version of
// that package is provably old enough and no body is fetched. Only packages that actually
// changed in the window — normally none — pay for the full document. In the steady state this
// gate is ~240 header-only requests.
//
// SELF-CONTAINED BY DESIGN: node builtins only, no repo-relative imports. These checks are the
// leading candidates for extraction into a shared package so forks stop carrying copies, and
// dependency-free now makes that a move rather than a rewrite. That is also why `isMainModule`
// is inlined below instead of imported from scripts/lib/.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk up to the nearest package.json rather than counting `..` levels. This file SYNCS into
// forks (scripts/sync-checks.mjs), so a hardcoded depth is a silent landmine: land one directory
// deeper and ROOT points at a tree with no src/, the scan finds nothing, and the gate PASSES.
// Fail-open is the one outcome this repo does not tolerate, so a missing package.json throws.
function repoRoot(from) {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`kit-checks: no package.json at or above ${from}`);
    dir = up;
  }
}
const ROOT = repoRoot(dirname(fileURLToPath(import.meta.url)));

/** The cooldown itself. Raising this is safe; lowering it reopens the window. */
export const MIN_RELEASE_AGE_HOURS = 24;
/**
 * Extra slack subtracted before trusting a `Last-Modified` to skip the body fetch. The registry
 * sits behind a CDN (`cache-control: public, max-age=300`), so a HEAD can answer from an edge
 * copy minutes older than the origin — which would understate a package's true last-change time
 * in exactly the direction that lets a fresh publish slip past. An hour buries a five-minute TTL.
 */
export const STALENESS_MARGIN_MINUTES = 60;
export const REGISTRY = 'https://registry.npmjs.org';
/** Hosts whose publish times this gate can establish. Anything else is unverifiable, not exempt. */
export const REGISTRY_HOSTS = new Set(['registry.npmjs.org']);
/** Parallel registry requests. High enough to stay quick, low enough to be a polite client. */
export const CONCURRENCY = 12;
export const FETCH_ATTEMPTS = 3;

const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Lockfile reading (pure)
// ---------------------------------------------------------------------------

/** The package name for a lockfile path like `node_modules/a/node_modules/@scope/b`. */
export function nameFromLockPath(path) {
  const marker = 'node_modules/';
  const at = path.lastIndexOf(marker);
  return at === -1 ? path : path.slice(at + marker.length);
}

/**
 * Split a parsed package-lock into what this gate can check and what it cannot.
 *
 * Returns `{ checked, unverifiable }`. `checked` holds one record per resolved npm-registry
 * install; `unverifiable` holds human-readable reasons, each of which is a FAILURE at the top
 * level — they are collected rather than thrown so one run reports every problem at once.
 *
 * Throws (loudly) on a lockfile shape this cannot read at all: a gate that cannot parse its
 * input must not answer "nothing to report".
 */
export function collectLockfileEntries(lock) {
  if (!lock || typeof lock !== 'object') throw new TypeError('package-lock.json is not an object');
  const version = lock.lockfileVersion;
  if (version !== 2 && version !== 3) {
    throw new Error(
      `unsupported lockfileVersion ${JSON.stringify(version)} — this gate reads the ` +
        '`packages` map introduced in lockfileVersion 2. Run `npm install` with npm 7+.',
    );
  }
  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json has no `packages` map — cannot enumerate installs');
  }

  const checked = [];
  const unverifiable = [];
  for (const [path, node] of Object.entries(lock.packages)) {
    // The root project and workspace symlinks are not registry downloads.
    if (path === '') continue;
    if (!node || typeof node !== 'object') {
      unverifiable.push(`${path}: lockfile entry is not an object`);
      continue;
    }
    if (node.link === true) continue;
    const name = node.name ?? nameFromLockPath(path);
    if (!node.version) {
      unverifiable.push(`${path}: no version in the lockfile`);
      continue;
    }
    if (!node.resolved) {
      unverifiable.push(`${name}@${node.version} (${path}): no \`resolved\` URL in the lockfile`);
      continue;
    }
    let host;
    try {
      host = new URL(node.resolved).host;
    } catch {
      unverifiable.push(`${name}@${node.version}: unparseable resolved URL ${node.resolved}`);
      continue;
    }
    if (!REGISTRY_HOSTS.has(host)) {
      unverifiable.push(
        `${name}@${node.version}: resolved from ${host}, not the npm registry — ` +
          'publish age cannot be established',
      );
      continue;
    }
    checked.push({ path, name, version: node.version, resolved: node.resolved });
  }
  return { checked, unverifiable };
}

/** Unique `name@version` pairs from lockfile entries — the same version can appear many times. */
export function uniqueVersions(entries) {
  const byName = new Map();
  for (const { name, version } of entries) {
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(version);
  }
  return byName;
}

// ---------------------------------------------------------------------------
// Age arithmetic (pure)
// ---------------------------------------------------------------------------

/**
 * A publish at or after this instant is too young. `now - MIN_RELEASE_AGE_HOURS`.
 */
export function ageCutoff(nowMs, hours = MIN_RELEASE_AGE_HOURS) {
  return nowMs - hours * HOUR_MS;
}

/**
 * The stricter instant a packument's `Last-Modified` must predate before its body may be
 * skipped: the age cutoff pushed back by the CDN-staleness margin.
 */
export function packumentCutoff(nowMs, hours = MIN_RELEASE_AGE_HOURS) {
  return ageCutoff(nowMs, hours) - STALENESS_MARGIN_MINUTES * 60 * 1000;
}

/**
 * True when a packument's `Last-Modified` proves every version in it is old enough, so the body
 * need not be fetched. Absent, unparseable, or recent all answer FALSE — the caller then fetches
 * and checks properly, so a missing header costs bandwidth, never coverage.
 */
export function lastModifiedProvesOldEnough(header, cutoffMs) {
  if (!header) return false;
  const at = Date.parse(header);
  return Number.isFinite(at) && at < cutoffMs;
}

/**
 * Verdict for one resolved version. `publishedAt` is the registry's ISO timestamp, or null/undefined
 * when the registry did not report one. Returns a failure string, or null when the version passes.
 */
export function versionFailure(name, version, publishedAt, nowMs, hours = MIN_RELEASE_AGE_HOURS) {
  if (!publishedAt) {
    return `${name}@${version}: the registry reports no publish time — age cannot be verified`;
  }
  const at = Date.parse(publishedAt);
  if (!Number.isFinite(at)) {
    return `${name}@${version}: unparseable publish time ${JSON.stringify(publishedAt)}`;
  }
  const ageMs = nowMs - at;
  if (ageMs < hours * HOUR_MS) {
    // A future timestamp lands here too (negative age), which is the right answer: a publish
    // time we cannot trust is not evidence the version is old enough.
    const ageHours = (ageMs / HOUR_MS).toFixed(1);
    return `${name}@${version}: published ${publishedAt} (${ageHours}h ago) — under the ${hours}h minimum`;
  }
  return null;
}

/**
 * Verdicts for every entry, given a `name -> { version -> isoTime }` map of registry times.
 * Pure: the whole network layer collapses to that map, which is what makes this testable
 * offline. A name missing from the map is a failure, never a pass.
 */
export function evaluateVersions(byName, timesByName, nowMs, hours = MIN_RELEASE_AGE_HOURS) {
  const failures = [];
  for (const [name, versions] of byName) {
    const times = timesByName.get(name);
    for (const version of [...versions].sort()) {
      if (times === undefined) {
        failures.push(`${name}@${version}: no registry metadata was obtained — age unverified`);
        continue;
      }
      if (times === null) continue; // proven old enough by Last-Modified; no per-version time needed
      const failure = versionFailure(name, version, times[version], nowMs, hours);
      if (failure) failures.push(failure);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Registry access
// ---------------------------------------------------------------------------

/** npm's canonical URL form: the scope separator is escaped, the leading `@` is not. */
export function packumentUrl(name, registry = REGISTRY) {
  return `${registry}/${name.replace(/\//g, '%2F')}`;
}

// Labels stay short (`GET: HTTP 404`) because every caller already prefixes the package name;
// repeating it here produced messages like `gone: ... (GET gone: HTTP 404)`.
async function withRetries(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
      }
    }
  }
  throw new Error(`${label}: ${lastErr?.message ?? lastErr}`);
}

/**
 * Publish times for one package.
 *
 * Returns `null` when the HEAD proved the whole packument predates `cutoffMs` (nothing more to
 * learn), or a `{ version: isoTime }` map otherwise. Throws on anything that leaves the age
 * genuinely unknown — including a 404, which is what a published-then-unpublished package looks
 * like and must never read as "fine".
 */
export async function fetchPackageTimes(name, { fetchImpl, registry = REGISTRY, cutoffMs }) {
  const url = packumentUrl(name, registry);
  // Header-only probe first. Any hiccup here is not fatal: it just means we fetch the body.
  try {
    const head = await withRetries('HEAD', async () => {
      const res = await fetchImpl(url, {
        method: 'HEAD',
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    });
    if (lastModifiedProvesOldEnough(head.headers.get('last-modified'), cutoffMs)) return null;
  } catch {
    // fall through to the full document
  }

  const res = await withRetries('GET', async () => {
    const r = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  });
  const doc = await res.json();
  const times = doc?.time;
  if (!times || typeof times !== 'object') {
    throw new Error('packument carries no `time` map');
  }
  return times;
}

/** Run `worker` over `items` with a bounded number in flight. */
async function pooled(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item);
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Check a parsed lockfile. Returns `{ failures, stats }` — `failures` empty means the gate passes.
 *
 * `fetchImpl` is injected so the test suite can drive every branch without a network (the same
 * shape the AI client uses). `now` is injected for the same reason.
 */
export async function checkDependencyAge({
  lock,
  fetchImpl = globalThis.fetch,
  registry = REGISTRY,
  now = Date.now(),
  hours = MIN_RELEASE_AGE_HOURS,
} = {}) {
  const { checked, unverifiable } = collectLockfileEntries(lock);
  const byName = uniqueVersions(checked);
  const cutoffMs = packumentCutoff(now, hours);

  const timesByName = new Map();
  const fetchFailures = [];
  const unreachable = new Set();
  let bodiesFetched = 0;
  await pooled([...byName.keys()], CONCURRENCY, async (name) => {
    try {
      const times = await fetchPackageTimes(name, { fetchImpl, registry, cutoffMs });
      if (times !== null) bodiesFetched++;
      timesByName.set(name, times);
    } catch (err) {
      fetchFailures.push(`${name}: could not establish publish times (${err.message})`);
      unreachable.add(name);
    }
  });

  // Packages already reported by the fetch layer are dropped before evaluation. Their names are
  // absent from timesByName, which evaluateVersions correctly treats as a failure — but reporting
  // one unreachable package as two failures reads as two problems and inflates the count.
  const evaluated = new Map([...byName].filter(([name]) => !unreachable.has(name)));
  const failures = [
    ...unverifiable,
    ...fetchFailures,
    ...evaluateVersions(evaluated, timesByName, now, hours),
  ];
  return {
    failures,
    stats: {
      entries: checked.length,
      packages: byName.size,
      versions: [...byName.values()].reduce((n, s) => n + s.size, 0),
      bodiesFetched,
    },
  };
}

export function readLockfile(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
}

async function main() {
  const { failures, stats } = await checkDependencyAge({ lock: readLockfile() });
  if (failures.length) {
    console.error('Dependency release-age gate FAILED:\n');
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(
      `\nEvery version in package-lock.json must have been published to the npm registry more\n` +
        `than ${MIN_RELEASE_AGE_HOURS}h ago. A hijacked package is typically caught and unpublished within\n` +
        'hours, so the cooldown is what keeps a compromised release from being installed at all.\n\n' +
        'To clear a "under the 24h minimum" failure: wait out the window, or pin the dependency\n' +
        'back to the previous version (`npm install <pkg>@<older>`) and commit the lockfile.\n' +
        'To clear an "age cannot be verified" failure: the version must come from the npm\n' +
        'registry with a publish time — it is not exempt just because it could not be checked.',
    );
    process.exit(1);
  }
  console.log(
    `Dependency release-age gate passed: ${stats.entries} lockfile entries, ` +
      `${stats.versions} unique versions across ${stats.packages} packages, all published more ` +
      `than ${MIN_RELEASE_AGE_HOURS}h ago (${stats.bodiesFetched} packument${
        stats.bodiesFetched === 1 ? '' : 's'
      } fetched in full; the rest were settled by Last-Modified).`,
  );
}

// Run only as a CLI; importing the module (the pin test) must not exit.
//
// Inlined rather than imported from scripts/kit-checks/main-module.mjs to keep this file extractable
// with no repo-relative imports. The realpath on BOTH sides is load-bearing, not defensive
// styling: node realpaths the entry point when it sets import.meta.url and pathToFileURL does
// not, so the naive comparison fails OPEN — the gate exits 0 having checked nothing — whenever
// the repo is reached through a symlink (macOS /tmp is one).
function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolve = (p) => {
    try {
      return realpathSync(p);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  };
  const self = resolve(fileURLToPath(metaUrl));
  return self !== null && self === resolve(entry);
}

if (isMainModule(import.meta.url)) {
  await main();
}
