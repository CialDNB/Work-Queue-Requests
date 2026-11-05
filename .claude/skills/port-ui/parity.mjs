#!/usr/bin/env node
// /port-ui parity runner - screenshots the SOURCE app and the PORT side by side, per mapped screen
// and viewport, and records a computed-style census of each so drift is measured, not eyeballed.
//
//   node .claude/skills/port-ui/parity.mjs \
//     --source http://localhost:5175 --target http://localhost:8790 \
//     [--design .paved-road/design.json] [--out <dir>] [--only <screen-id>[,<id>...]] \
//     [--target-storage <state.json>] [--source-storage <state.json>] [--allow-remote-source]
//
// THE SOURCE RUNS ON SYNTHETIC DATA. Its screenshots go to a model subagent and a published report,
// so design.json must record `source.data: "synthetic"` (Phase 0), and a --source that is not on
// this machine is refused unless --allow-remote-source says that host is synthetic too.
//
// CREDENTIALS NEVER GO ON THE COMMAND LINE (shell history, `ps`). They come from the environment:
//   PORT_UI_TARGET_LOGIN   a kit magic-link verify URL for a seeded user on the LOCAL port: the
//                          app's own dev-login helper if it has one, else the newest local email.
//                          `wrangler dev` simulates the EMAIL binding, so the send succeeds into
//                          .wrangler/tmp/email/ and nothing reaches the KV outbox (that holds a
//                          link only when a send did not happen: staging before email onboarding,
//                          or no EMAIL binding). The kit mints the link for
//                          https://<DASHBOARD_HOST>; the runner keeps only its /auth/verify?token=
//                          part and opens that on --target, presses "Confirm sign-in", checks a
//                          session really exists, and reuses it for every target screenshot.
//   PORT_UI_TARGET_COOKIE / PORT_UI_SOURCE_COOKIE   'name=value; name2=value2' session cookies.
// e.g., from the directory wrangler dev runs in, while it runs, right after requesting a link:
//   PORT_UI_TARGET_LOGIN="$(grep -ho 'https://[^[:space:]]*/auth/verify?token=[0-9a-f]*' \
//     "$(ls -t .wrangler/tmp/email/*/email-text/*.txt | head -n 1)")" node .../parity.mjs ...
// The session state lives in a private temp dir deleted at the end of the run; neither link nor
// cookie reaches parity.json. --out must be OUTSIDE the repository (the whole repo, not just the
// current directory): source screenshots can show real data and must never be committed.
//
// Screens and viewports come from the design contract (`screens[]`, `viewports[]`, see
// references/design.schema.md). Each screen names a concrete path PER SIDE, because the two apps
// run on different databases and ids never line up.
//
// Output (default: a fresh $TMPDIR/port-ui-parity-XXXXXX/, 0700, files 0600 - outside the repo ON
// PURPOSE; screenshots of a source app can carry real data and must never be committed):
//   <id>@<w>x<h>.source.png / .target.png   full-page screenshots
//   parity.json                              per pair: status, console errors, style census, deltas
//   report.html                              side-by-side review page (relative image paths)
//
// Playwright is NOT an app dependency. It is installed once, at an exact pin, into a per-user cache
// outside the repo (no lockfile change), and its Chromium is fetched on first use. verify:deps
// cannot see that install, so it applies the kit's rules itself: a release must be 24h old
// (`--before`), lifecycle scripts never run, and no child process sees a PORT_UI_* credential.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAYWRIGHT_VERSION = '1.63.0';
const DEFAULT_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

const CREDENTIAL_ENV = {
  'target-login': 'PORT_UI_TARGET_LOGIN',
  'target-cookie': 'PORT_UI_TARGET_COOKIE',
  'source-cookie': 'PORT_UI_SOURCE_COOKIE',
};
/** Options that take a value. Anything else is refused, never silently ignored. */
const VALUE_OPTIONS = new Set([
  'source',
  'target',
  'design',
  'out',
  'only',
  'target-storage',
  'source-storage',
  // Known only so credentialsFrom() can refuse them with the right message.
  ...Object.keys(CREDENTIAL_ENV),
]);
/** Options that are bare flags. */
const FLAG_OPTIONS = new Set(['allow-remote-source']);

/**
 * `--key value` and `--key=value` pairs into an object. An unknown option is an error: ignoring
 * one hid a mistyped flag, and hid a credential flag in its `=` form from the refusal below (the
 * run then shot logged-out pages, with the link already in shell history).
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (FLAG_OPTIONS.has(key) && eq < 0) {
      out[key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new Error(`unknown option --${key}`);
    let value;
    if (eq >= 0) value = a.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        // A credential flag with no value is still refused as a credential flag.
        if (key in CREDENTIAL_ENV) value = '';
        else throw new Error(`--${key} needs a value`);
      } else i++;
    }
    out[key] = value;
  }
  return out;
}

const isLoopback = (host) =>
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  host === '[::1]' ||
  /^127(?:\.\d{1,3}){3}$/.test(host);

/**
 * The source may be screenshotted only when it runs on synthetic data. Its screenshots go to the
 * ui-parity-reviewer subagent, whose findings feed the committed contract and the PR, and the
 * report is published as an Artifact: real records in them would be processing no PIA covers
 * (CLAUDE.md "Synthetic only"). design.json records the attestation (`source.data: "synthetic"`,
 * /port-ui Phase 0), and a source that is not on this machine (a shared staging or a production
 * host) is refused unless `--allow-remote-source` says that host is synthetic too.
 */
export function checkSource(design, sourceUrl, allowRemote) {
  if (design?.source?.data !== 'synthetic') {
    throw new Error(
      'design.json source.data must be "synthetic": run the original on synthetic (or scrubbed) ' +
        'data and record it (/port-ui Phase 0). Its screenshots go to a model subagent and a ' +
        'published report.',
    );
  }
  let host;
  try {
    host = new URL(sourceUrl).hostname;
  } catch {
    throw new Error('--source is not a URL');
  }
  if (!allowRemote && !isLoopback(host)) {
    throw new Error(
      `--source ${host} is not on this machine: run the original locally on synthetic data, or ` +
        'pass --allow-remote-source if that host serves synthetic data only.',
    );
  }
}

/**
 * Session credentials, from the ENVIRONMENT only. A credential passed as a flag is refused (it
 * would sit in shell history and the process list), and a variable that is set but empty (a
 * `"$(cmd)"` whose cmd failed) is refused rather than silently shooting logged-out pages.
 */
export function credentialsFrom(args, env) {
  for (const [flag, name] of Object.entries(CREDENTIAL_ENV)) {
    if (flag in args) {
      throw new Error(
        `--${flag} is not accepted: credentials go in the ${name} environment variable`,
      );
    }
    if (name in env && String(env[name]).trim() === '') {
      throw new Error(`${name} is set but empty (did the command that produces it fail?)`);
    }
  }
  const get = (name) => (env[name] ? String(env[name]).trim() : undefined);
  return {
    targetLogin: get(CREDENTIAL_ENV['target-login']),
    targetCookie: get(CREDENTIAL_ENV['target-cookie']),
    sourceCookie: get(CREDENTIAL_ENV['source-cookie']),
  };
}

/** The repository `dir` is in: the nearest ancestor holding `.git` (a dir, or a worktree's file). */
function repoRootOf(dir) {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    const up = dirname(cur);
    if (up === cur) return resolve(dir);
    cur = up;
  }
}

/** `p` with its nearest existing ancestor realpath'd, so a symlinked spelling compares equal. */
function realish(p) {
  const rest = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

/**
 * The output directory, which must not be anywhere inside the repository `cwd` belongs to. That is
 * the control that keeps source screenshots (they may show real data) out of git, so it compares
 * against the repo root (not just cwd: a nested app runs from its own dir), on real paths (macOS
 * /tmp is /private/tmp), with a `..` segment test (a child named `..parity` is inside).
 */
export function outputDir(requested, cwd) {
  const out = resolve(cwd, requested);
  const root = repoRootOf(cwd);
  const rel = relative(realish(root), realish(out));
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) {
    throw new Error(
      `--out ${out} is inside ${root}: keep parity output (it may show real data) outside the repo`,
    );
  }
  return out;
}

/**
 * Create the output directory, private to this user: by default a fresh `mkdtemp` directory (a
 * name nobody can predict or pre-create in a shared /tmp), otherwise `--out` created 0700. Files
 * go in through writePrivate (0600), so another user on a shared Linux box, WSL or Codespace
 * cannot read a source screenshot or swap report.html before it is published.
 */
export function prepareOutput(requested, cwd) {
  if (requested === undefined) {
    const made = realpathSync(mkdtempSync(join(tmpdir(), 'port-ui-parity-')));
    return outputDir(made, cwd);
  }
  const out = outputDir(requested, cwd);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  return out;
}

/** Write a file readable by this user only (0600, also when it already existed). */
export function writePrivate(file, data) {
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * A private temp directory for the target session (a live cookie), removed when the process
 * exits by ANY route: normal end, error, or Ctrl-C / SIGTERM. Playwright's own SIGINT handler
 * calls process.exit(), which skips main()'s `finally`, so the cleanup is an 'exit' listener, and
 * the signals are turned into an exit so that listener runs.
 */
export function privateSessionDir() {
  const dir = mkdtempSync(join(tmpdir(), 'port-ui-session-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.on('exit', cleanup);
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    process.once(signal, () => process.exit(code));
  }
  return dir;
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PLACEHOLDER_ORIGIN = 'http://port-ui.invalid';
/** A backslash or an ASCII control character (tab, newline and the rest). */
const hasBackslashOrControl = (p) => [...p].some((c) => c === '\\' || c < ' ' || c === '\x7f');

/**
 * A path on the app's own origin: `/x`, never a URL or a protocol-relative `//host`. Checked the
 * way the browser will read it, not by its first characters: the URL parser treats `\` as `/` in
 * http(s) and strips tabs and newlines, so `/\host/x` and `/<TAB>/host/x` both start with one `/`
 * and still resolve to another host. Those characters are refused, and the path must resolve on
 * the origin it is given.
 */
const isPath = (p) => {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) return false;
  if (hasBackslashOrControl(p)) return false;
  try {
    return new URL(p, PLACEHOLDER_ORIGIN).origin === PLACEHOLDER_ORIGIN;
  } catch {
    return false;
  }
};

/**
 * The URL to open for a screen `path` on `base`, refused unless it stays on base's origin. The
 * screen map was validated already; this is the same rule at the point of navigation, so no
 * spelling the validator missed can take a capture (and its session) to another host.
 */
export function screenUrl(base, path) {
  const origin = new URL(base).origin;
  if (!isPath(path) || new URL(path, base).origin !== origin) {
    throw new Error(`screen path ${JSON.stringify(path)} is not a path on ${origin}`);
  }
  return new URL(path, base).toString();
}

/**
 * The screens to shoot: `[{ id, label, source, target, waitFor? }]`, validated against the schema.
 * The id becomes the screenshot's file name, so it must be unique (a duplicate overwrites another
 * pair's images) and kebab-case (a path-like id writes outside the output directory). design.json
 * is repo content, written by whoever authored the branch.
 */
export function screensFrom(design, only) {
  const screens = Array.isArray(design?.screens) ? design.screens : [];
  const problems = [];
  const seen = new Set();
  for (const [i, s] of screens.entries()) {
    if (!s || typeof s.id !== 'string' || !s.id) problems.push(`screens[${i}]: missing id`);
    else {
      if (!KEBAB.test(s.id)) problems.push(`screens[${i}]: id must be kebab-case`);
      else if (seen.has(s.id)) problems.push(`${s.id}: duplicate id`);
      seen.add(s.id);
      if (typeof s.source !== 'string') problems.push(`${s.id}: missing source path`);
      else if (!isPath(s.source)) problems.push(`${s.id}: source must be a path ("/…")`);
      if (typeof s.target !== 'string') problems.push(`${s.id}: missing target path`);
      else if (!isPath(s.target)) problems.push(`${s.id}: target must be a path ("/…")`);
    }
  }
  if (problems.length) throw new Error(`design.json screens invalid:\n  ${problems.join('\n  ')}`);
  const wanted = only ? new Set(String(only).split(',')) : null;
  const picked = wanted ? screens.filter((s) => wanted.has(s.id)) : screens;
  if (!picked.length)
    throw new Error('no screens to shoot (design.json screens[] empty or --only matched none)');
  return picked;
}

/** Census keys whose value sets are compared between source and target. */
export const CENSUS_KEYS = ['fontFamily', 'color', 'backgroundColor', 'borderRadius', 'boxShadow'];

/**
 * What the TARGET uses that the SOURCE never does, per census key. These are the objective drift
 * signals: a font, colour, radius or shadow the original app does not have is the kit default (or
 * an invention) leaking through.
 */
export function censusDelta(source, target) {
  const delta = {};
  for (const key of CENSUS_KEYS) {
    const have = new Set(Object.keys(source?.[key] ?? {}));
    const extra = Object.entries(target?.[key] ?? {})
      .filter(([value]) => !have.has(value))
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));
    if (extra.length) delta[key] = extra.slice(0, 8);
  }
  return delta;
}

/** Runs in the page: counts of each computed style value across visible elements. */
function collectCensus(keys) {
  const census = Object.fromEntries(keys.map((k) => [k, {}]));
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    for (const k of keys) {
      const v = cs[k];
      if (!v || v === 'none' || v === '0px' || v === 'rgba(0, 0, 0, 0)') continue;
      census[k][v] = (census[k][v] ?? 0) + 1;
    }
  }
  return census;
}

/**
 * The pinned Playwright's cache dir, per user (never a shared, world-writable /tmp path another
 * user could pre-seed). XDG_CACHE_HOME counts only when it is an absolute path, as the XDG spec
 * says: an empty or relative value would put the install under the current directory, the repo.
 */
export function playwrightCacheDir(env, home) {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.cache');
  return join(base, 'port-ui-parity', `pw-${PLAYWRIGHT_VERSION}`);
}

/**
 * The Playwright installed in `dir`, by absolute path and only at the pinned version. A bare
 * `require('playwright')` also walks every ancestor node_modules and NODE_PATH, so a stray
 * ~/node_modules/playwright satisfied it, the pinned install was skipped, and the run then died on
 * the missing <dir>/node_modules/playwright/cli.js every time.
 */
export function loadPinnedPlaywright(dir) {
  const pkgDir = join(dir, 'node_modules', 'playwright');
  let version;
  try {
    version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  } catch {
    throw new Error(`playwright is not installed in ${dir}`);
  }
  if (version !== PLAYWRIGHT_VERSION) {
    throw new Error(`playwright ${version} in ${dir}, want ${PLAYWRIGHT_VERSION}`);
  }
  return createRequire(join(dir, 'package.json'))(pkgDir);
}

/** Hours a Playwright release must have been on the registry before it is installed. */
const MIN_RELEASE_AGE_HOURS = 24;

/**
 * `npm` arguments for the off-lockfile Playwright install. verify:deps reads only
 * package-lock.json, and the repo's `.npmrc` (`min-release-age=1`) does not apply under --prefix,
 * so the install carries the same rules itself: an exact pin, `--before` 24h ago (npm then refuses
 * a release younger than that with ETARGET, on every npm version, where `min-release-age` needs
 * npm 11.10), and no lifecycle scripts.
 */
export function playwrightInstallArgs(dir, now = Date.now()) {
  const before = new Date(now - MIN_RELEASE_AGE_HOURS * 3600_000).toISOString();
  return [
    'install',
    '--prefix',
    dir,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    `--before=${before}`,
    `playwright@${PLAYWRIGHT_VERSION}`,
  ];
}

/** The environment for child processes: never the PORT_UI_* session credentials. */
export function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('PORT_UI_')));
}

/**
 * Playwright, pinned, in the per-user cache. A missing, partial or wrong-version install is
 * detected by loading it and is repaired by reinstalling, instead of failing on every later run.
 */
function ensurePlaywright() {
  const dir = playwrightCacheDir(process.env, homedir());
  const load = () => loadPinnedPlaywright(dir);
  let playwright;
  try {
    playwright = load();
  } catch {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
    console.error(`installing playwright@${PLAYWRIGHT_VERSION} into ${dir} (one-time)...`);
    execFileSync('npm', playwrightInstallArgs(dir), {
      stdio: 'inherit',
      env: childEnv(process.env),
    });
    playwright = load();
  }
  execFileSync('node', [join(dir, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], {
    stdio: 'inherit',
    env: childEnv(process.env),
  });
  return playwright;
}

/**
 * `'name=value; name2=value2'` as Playwright cookies for `base`, host-only with path `/`. Given in
 * domain/path form, not `url`: Playwright derives `secure` from a url's scheme, so on an http://
 * target the kit's `__Host-app_session` came out non-Secure and Chromium refused the whole call
 * ("Invalid cookie fields"). A `__Host-`/`__Secure-` cookie is always Secure (the prefix requires
 * it), and Chromium still sends it to http://localhost and http://127.0.0.1, which count as
 * secure contexts (Playwright's own API client does not: see targetSessionStatus).
 */
export function cookieList(spec, base) {
  if (!spec) return [];
  const url = new URL(base);
  return String(spec)
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 1) throw new Error('a session cookie must be name=value (value not shown)');
      const name = pair.slice(0, eq);
      const secure = url.protocol === 'https:' || /^__(Host|Secure)-/.test(name);
      return { name, value: pair.slice(eq + 1), domain: url.hostname, path: '/', secure };
    });
}

/**
 * Browser context options for one capture. Each app's own CSP stays IN FORCE: with `bypassCSP`, a
 * remote font or CDN stylesheet the port's `_headers` blocks rendered in parity anyway (and no
 * "Refused to load" error was logged), so a port that falls back to the system font on staging
 * passed every check. Motion is frozen by reducedMotion and SCREENSHOT_OPTIONS instead of an
 * injected stylesheet, which the CSP would (rightly) refuse.
 */
export function contextOptions(viewport, storage) {
  return { viewport, reducedMotion: 'reduce', ...(storage ? { storageState: storage } : {}) };
}

/** Playwright stops CSS animations/transitions and hides the caret for the shot itself. */
export const SCREENSHOT_OPTIONS = { fullPage: true, animations: 'disabled', caret: 'hide' };

/** Init script, in the page before its own scripts: keep every CSP violation it reports. */
function recordCspViolations() {
  window.__portUiBlocked = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__portUiBlocked.push(`CSP blocked ${e.effectiveDirective}: ${e.blockedURI || 'inline'}`);
  });
}

/** Runs in the page: the CSP violations seen, plus every web font that failed to load. */
function collectBlocked() {
  const failedFonts = [...document.fonts]
    .filter((f) => f.status === 'error')
    .map((f) => `font failed to load: ${f.family}`);
  return [...(window.__portUiBlocked ?? []), ...failedFonts];
}

async function shoot(browser, side, base, path, viewport, opts, file) {
  const errors = [];
  let context;
  let page;
  let status = null;
  try {
    // Context and cookies inside the try: a refused cookie is this capture's failure, recorded in
    // the report, not an exception that ends the run before any report is written.
    context = await browser.newContext(contextOptions(viewport, opts.storage));
    await context.addCookies(cookieList(opts.cookie, base));
    await context.addInitScript(recordCspViolations);
    page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(redactUrls(m.text()).slice(0, 200));
    });
    page.on('pageerror', (e) => errors.push(redactUrls(e).slice(0, 200)));
    const res = await page.goto(screenUrl(base, path), {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    status = res?.status() ?? null;
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(400);
    writePrivate(file, await page.screenshot(SCREENSHOT_OPTIONS));
    const census = await page.evaluate(collectCensus, CENSUS_KEYS);
    // A blocked font still shows as declared in the census, so it is reported as an error too.
    for (const b of await page.evaluate(collectBlocked)) {
      const line = redactUrls(b).slice(0, 200);
      if (!errors.includes(line)) errors.push(line);
    }
    return { side, url: page.url(), status, errors, census };
  } catch (err) {
    return {
      side,
      url: page?.url() ?? null,
      status,
      errors: [...errors, redactUrls(err).slice(0, 200)],
      census: null,
    };
  } finally {
    await context?.close();
  }
}

/** `text` with every URL's query string replaced: a magic link carries its token in the query. */
export function redactUrls(text) {
  return String(text).replace(/(https?:\/\/[^\s"'?#]*)\?[^\s"'#]*/g, '$1?<redacted>');
}

/**
 * The magic link to open: its `/auth/verify?token=...` part, on the TARGET's origin. The kit mints
 * `https://<DASHBOARD_HOST>/auth/verify?...` even under `wrangler dev` (the outbox stores that
 * too), so opening it as given failed to resolve before go-live and, after it, sent a local token
 * to production. Nothing else is accepted, and the value never appears in a message.
 */
export function targetLoginUrl(raw, target) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PORT_UI_TARGET_LOGIN is not a URL (value not shown)');
  }
  if (url.pathname !== '/auth/verify' || !url.searchParams.get('token')) {
    throw new Error(
      'PORT_UI_TARGET_LOGIN must be a kit magic-link URL, /auth/verify?token=... (value not shown)',
    );
  }
  return new URL(`${url.pathname}${url.search}`, target).toString();
}

/**
 * Complete a kit magic-link sign-in on the target (verify URL, then the "Confirm sign-in"
 * interstitial) and return a storage-state file for the target contexts. Fails loudly unless a
 * session cookie was actually set and the page left /auth/verify: a silent failure would
 * screenshot the login page for every target screen and report it as the port. The state file
 * lives in a private temp directory removed when the process exits; it never goes in the output
 * folder. Errors are redacted: Playwright's navigation errors quote the full, tokened URL.
 */
async function signIn(browser, url, sessionDir) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const confirm = page.locator('form[method="post" i] button[type=submit], form button').first();
    if (await confirm.count()) {
      await Promise.all([
        page.waitForURL((u) => !u.pathname.startsWith('/auth/verify'), { timeout: 15_000 }),
        confirm.click(),
      ]).catch(() => {});
    }
    const cookies = await context.cookies();
    if (new URL(page.url()).pathname.startsWith('/auth/') || cookies.length === 0) {
      throw new Error(
        `PORT_UI_TARGET_LOGIN did not produce a session (ended on ${new URL(page.url()).pathname}, ` +
          `${cookies.length} cookie(s)). The link may be expired or already used: request a fresh one.`,
      );
    }
    const file = join(sessionDir, 'target-session.json');
    await context.storageState({ path: file });
    return file;
  } catch (err) {
    throw new Error(`sign-in failed: ${redactUrls(err instanceof Error ? err.message : err)}`);
  } finally {
    await context.close();
  }
}

/** The user's writing rule applies to every generated artifact: no em or en dashes. */
const hyphenate = (s) => String(s).replace(/[\u2013\u2014]/g, '-');

function reportHtml(pairs) {
  const esc = (s) =>
    hyphenate(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
  const rows = pairs
    .map((p) => {
      const delta = Object.entries(p.delta ?? {})
        .map(
          ([k, vs]) =>
            `<li><b>${esc(k)}</b>: ${vs.map((v) => `${esc(v.value)} ×${v.count}`).join(', ')}</li>`,
        )
        .join('');
      return `<section><h2>${esc(p.id)} <small>${p.viewport.width}×${p.viewport.height}</small></h2>
<p>source ${esc(p.source.status)} ${esc(p.source.url)} · target ${esc(p.target.status)} ${esc(p.target.url)}</p>
${p.failed ? `<p class="delta"><b>Capture failed:</b> ${esc(p.failed)}</p>` : delta ? `<ul class="delta">${delta}</ul>` : '<p class="ok">No style values in the port that the source lacks.</p>'}
<div class="pair"><figure><figcaption>SOURCE</figcaption><img src="${esc(p.files.source)}"></figure>
<figure><figcaption>PORT</figcaption><img src="${esc(p.files.target)}"></figure></div></section>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>UI parity</title><style>
body{font:14px system-ui;margin:16px;background:#fafbfc;color:#0a1738}section{margin:0 0 40px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0}img{width:100%;border:1px solid #e7eaf2}
figcaption{font:600 11px ui-monospace;letter-spacing:.08em;margin-bottom:4px}.delta{color:#c2410c}.ok{color:#12a594}
</style><h1>UI parity: source vs port</h1>${rows}`;
}

/**
 * A capture that cannot be compared: nothing was captured, or the page answered an HTTP error. A
 * null status with a census is a same-document navigation, which is fine.
 */
export function captureFailed(result) {
  return !result.census || (result.status != null && result.status >= 400);
}

/** Whether GET /api/me answered as a signed-in user (the kit's own session check). */
export function sessionEstablished(status) {
  return typeof status === 'number' && status >= 200 && status < 300;
}

/**
 * GET /api/me on the target with the session the target captures will use (storage state and/or
 * cookies), or null when it could not be asked. A kit SPA answers 200 on every path and shows its
 * login view when signed out, so a status-200 screenshot proves nothing about the session.
 *
 * Asked by navigating a PAGE, as every capture does, never through `context.request`: Playwright's
 * API client sends a Secure cookie (the kit's `__Host-app_session`) over http only to localhost,
 * while the browser also sends it to http://127.0.0.1 and [::1], where wrangler dev listens on
 * Windows. The API client reported such a signed-in target as signed out. A redirect is not a
 * session: the status returned is the first hop's (a 302, say), not the login page's 200.
 */
export async function targetSessionStatus(browser, target, opts) {
  const context = await browser.newContext(opts.storage ? { storageState: opts.storage } : {});
  try {
    await context.addCookies(cookieList(opts.cookie, target));
    const page = await context.newPage();
    const res = await page.goto(new URL('/api/me', target).toString(), {
      waitUntil: 'commit',
      timeout: 15_000,
    });
    if (!res) return null;
    let first = res.request();
    while (first.redirectedFrom()) first = first.redirectedFrom();
    if (first === res.request()) return res.status();
    return (await first.response())?.status() ?? null;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args.source || !args.target) {
    throw new Error(
      'usage: parity.mjs --source <url> --target <url> [--design <design.json>] [--out <dir>] ' +
        '[--only <ids>] [--allow-remote-source]',
    );
  }
  const creds = credentialsFrom(args, process.env);
  const design = JSON.parse(
    readFileSync(resolve(args.design ?? '.paved-road/design.json'), 'utf8'),
  );
  if (design.version !== 1 || design.mode !== 'port') {
    throw new Error(
      `design.json must be version 1 with mode "port" (got version ${design.version}, mode ${design.mode})`,
    );
  }
  checkSource(design, args.source, args['allow-remote-source'] === true);
  const screens = screensFrom(design, args.only);
  const viewports =
    Array.isArray(design.viewports) && design.viewports.length
      ? design.viewports
      : DEFAULT_VIEWPORTS;
  // A malformed credential fails here, before a browser starts, not once per capture.
  cookieList(creds.sourceCookie, args.source);
  cookieList(creds.targetCookie, args.target);
  if (creds.targetLogin) targetLoginUrl(creds.targetLogin, args.target);
  const out = prepareOutput(args.out, process.cwd());

  const { chromium } = ensurePlaywright();
  const browser = await chromium.launch();
  const sessionDir = privateSessionDir();
  const pairs = [];
  let targetSignedIn = false;
  try {
    if (creds.targetLogin && !args['target-storage']) {
      args['target-storage'] = await signIn(
        browser,
        targetLoginUrl(creds.targetLogin, args.target),
        sessionDir,
      );
    }
    const targetOpts = { cookie: creds.targetCookie, storage: args['target-storage'] };
    if (targetOpts.cookie || targetOpts.storage) {
      // Every credential path is checked, not only the magic link: a stale cookie or storage
      // file would otherwise shoot the login view for every target screen as "the port".
      const me = await targetSessionStatus(browser, args.target, targetOpts);
      if (!sessionEstablished(me)) {
        throw new Error(
          `the target session is not signed in (GET /api/me answered ${me ?? 'nothing'}): the ` +
            'cookie or storage state is stale, or for another app. Get a fresh one.',
        );
      }
      targetSignedIn = true;
    } else {
      console.error(
        'no target credential: every target screen is captured SIGNED OUT, which is right only ' +
          'for the login screen. Set PORT_UI_TARGET_LOGIN (see SKILL Phase 5) for the rest.',
      );
    }
    for (const screen of screens) {
      for (const viewport of viewports) {
        const stem = `${screen.id}@${viewport.width}x${viewport.height}`;
        const files = { source: `${stem}.source.png`, target: `${stem}.target.png` };
        const source = await shoot(
          browser,
          'source',
          args.source,
          screen.source,
          viewport,
          {
            cookie: creds.sourceCookie,
            storage: args['source-storage'],
            waitFor: screen.waitFor,
          },
          join(out, files.source),
        );
        const target = await shoot(
          browser,
          'target',
          args.target,
          screen.target,
          viewport,
          { ...targetOpts, waitFor: screen.waitFor },
          join(out, files.target),
        );
        const failed =
          captureFailed(source) || captureFailed(target)
            ? `source ${source.status ?? 'no response'}${source.census ? '' : ' (no capture)'}, target ${target.status ?? 'no response'}${target.census ? '' : ' (no capture)'}`
            : null;
        const delta = failed ? null : censusDelta(source.census, target.census);
        pairs.push({
          id: screen.id,
          label: screen.label ?? screen.id,
          viewport,
          files,
          source,
          target,
          delta,
          failed,
        });
        const flag = failed
          ? `CAPTURE FAILED (${failed})`
          : Object.keys(delta).length
            ? `drift in ${Object.keys(delta).join(', ')}`
            : 'style census clean';
        const errs = target.errors.length ? `; ${target.errors.length} target error(s)` : '';
        console.error(
          `${stem}: source ${source.status} / target ${target.status} - ${flag}${errs}`,
        );
      }
    }
  } finally {
    await browser.close();
    rmSync(sessionDir, { recursive: true, force: true });
  }
  const summary = { generatedAt: new Date().toISOString(), targetSignedIn, pairs };
  writePrivate(join(out, 'parity.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writePrivate(join(out, 'report.html'), reportHtml(pairs));
  console.log(out);
  return { out, failed: pairs.filter((p) => p.failed).length, total: pairs.length };
}

function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    ({ failed, total }) => {
      // The report is written either way, but a run with an uncomparable pair is not a pass.
      if (failed) {
        console.error(`${failed} of ${total} pair(s) failed to capture: see the report`);
        process.exitCode = 1;
      }
    },
    (err) => {
      console.error(redactUrls(err instanceof Error ? err.message : err));
      process.exit(1);
    },
  );
}
