// Two mechanical backstops for the protected core — one gate, one thermometer.
//
//   node scripts/check-core-reachability.mjs        # exit 1 on an unreachable declaration
//
//   (a) REACHABILITY — a HARD gate. A route module that never reaches `allRoutes`, or a
//       data-layer export nothing calls, is code that ships and runs nowhere. Both are
//       invisible to every other gate here: the uniformity tripwire iterates `allRoutes`,
//       so an unregistered route module is not merely untested, it is unseen; and coverage
//       thresholds are ratios, so dead code drags them without ever failing them.
//
//   (b) SIZE — a WARNING that never fails the build, deliberately. Two reasons. A ceiling
//       set below some fork's existing file would turn that fork's CI red on the next
//       /kit-upgrade for a file it never touched. And a line count is gameable: splitting
//       one 900-line file into two 450-line files satisfies the number without decomposing
//       a single responsibility. It is a thermometer, not a gate. DECISIONS records what
//       evidence would graduate it.
//
// SELF-CONTAINED ON PURPOSE. Node builtins only, no repo-relative imports — not even
// scripts/lib/main-module.mjs, whose isMainModule is duplicated below. 17 forks each carry a
// copy of every check in scripts/, and these two are the leading candidates for extraction
// into a shared package; dependency-free now makes that a move rather than a rewrite. The
// duplication is the price and it is deliberate. (scripts/lib/main-module.mjs is still the
// canonical explanation of *why* the realpath comparison is symmetric — read it there.)
//
// WHAT IT DOES NOT DO: it is not a type checker and does not resolve values across function
// boundaries. A repo handed to a helper as an argument (`sweep(db.notes)`) is not traced, and a
// repo written as `export const xRepo = (db) => ({ ... })` is checked only as a plain export —
// its methods are not enumerated. Both under-report rather than misfire, which is the direction
// a fleet-wide hard gate has to fail in: a missed finding costs a review, a false red costs 17
// forks a broken /kit-upgrade. Widen the recognizer when a fork needs it; do not widen it by
// guessing. The
// escape hatch for anything the scanner cannot see — or for scaffolding shipped deliberately
// unwired, like src/data/groups.ts — is an `@reachability-exempt:` comment with a reason, on
// or just above the declaration. Every exemption is PRINTED in the report, so using one is
// visible in review rather than silent. See DECISIONS 2026-08-06 for why these checks stay on
// artifacts (declarations, call sites) and never on prose.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
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

/** Protected-core source the size thermometer measures — the CODEOWNERS-gated worker code. */
export const CORE_PATHS = [
  'src/ai',
  'src/auth',
  'src/cron',
  'src/data',
  'src/email',
  'src/framework',
  'src/mcp',
  'src/platform',
  'src/security',
  'src/env.ts',
  'src/health.ts',
  'src/index.ts',
];

/**
 * Lines above which a protected-core file is REPORTED (never failed).
 *
 * Derived from the current maximum — src/auth/oidc.ts at 776 lines — plus ~16% headroom, so
 * the existing outlier can absorb a real fix without tripping, while a new file more than
 * twice the size of the next-largest (src/cron/auditWatch.ts, 385) does trip it. Raising this
 * to fit a file is the wrong move; the number exists to make growth visible.
 */
export const CORE_SIZE_CEILING_LINES = 900;

/** Directories whose files can call something (production first, then the suite). */
const CALLER_ROOTS = ['src', 'web/src', 'test'];
const CALLER_EXTENSIONS = ['.ts', '.tsx', '.mjs'];

const EXEMPT_MARKER = '@reachability-exempt:';

// ---------------------------------------------------------------------------------------
// Source masking
// ---------------------------------------------------------------------------------------

/**
 * Blank out comment bodies and string/regex contents, preserving every offset and newline, so
 * downstream regexes match CODE only. Two failure directions, and they are not symmetric:
 *
 *   - Masking too little (a call left inside a comment) makes a declaration look reachable —
 *     the check under-reports. Nothing goes red that shouldn't.
 *   - Masking too much would hide a real declaration — again under-reporting.
 *
 * Both land on "misses a finding", never on "fails a fork's CI for a file it wrote correctly".
 * That asymmetry is why the masker is allowed to be a heuristic at all.
 */
export function maskNoise(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (i) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  // Template-literal nesting: each entry is the brace depth at which `${` was opened.
  const tpl = [];
  let braceDepth = 0;
  let prevSig = '';
  let i = 0;

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // Template-literal TEXT is tested FIRST — ahead of both comments and the opening-backtick
    // case — and the order is load-bearing twice over. Both orderings were wrong on the first
    // run of this script against the kit's own sources:
    //
    //   after the backtick case: a CLOSING backtick reads as another opening one, the stack
    //     never unwinds, and every line after the file's first interpolated string is blanked.
    //   after the comment cases: `https://` inside a template opens a phantom line comment that
    //     eats the closing backtick — same runaway, and it hid the real caller of
    //     magicLinksRepo.claim (src/auth/magicLink.ts:135), reporting a live method as dead.
    //
    // Inside template text, `//`, `/*`, `'` and `"` are literal characters and nothing else.
    if (tpl.length > 0 && tpl[tpl.length - 1] === braceDepth) {
      // Blank the literal text, but step OUT for `${ ... }` so real calls written inside an
      // interpolation still count as callers.
      if (c === '\\') {
        blank(i++);
        if (i < n) blank(i++);
        continue;
      }
      if (c === '`') {
        tpl.pop();
        i++;
        prevSig = '`';
        continue;
      }
      if (c === '$' && c2 === '{') {
        braceDepth++;
        i += 2;
        prevSig = '{';
        continue;
      }
      blank(i++);
      continue;
    }
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') blank(i++);
      continue;
    }
    if (c === '/' && c2 === '*') {
      blank(i++);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
      continue;
    }
    if (c === "'" || c === '"') {
      i++; // keep the opening quote; blank the contents
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') blank(i++);
        if (i < n) blank(i++);
      }
      if (i < n && src[i] === c) i++;
      prevSig = c;
      continue;
    }
    if (c === '`') {
      i++;
      tpl.push(braceDepth);
      prevSig = '`';
      continue;
    }
    if (c === '/' && isRegexStart(prevSig)) {
      const end = skipRegex(src, i);
      if (end > i) {
        for (let k = i + 1; k < end - 1; k++) blank(k);
        i = end;
        prevSig = '/';
        continue;
      }
    }
    if (c === '{') braceDepth++;
    if (c === '}') {
      braceDepth--;
      // Closing the `${` of a template literal drops us back into its text.
      if (tpl.length > 0 && tpl[tpl.length - 1] === braceDepth) {
        i++;
        prevSig = '}';
        continue;
      }
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out.join('');
}

/**
 * A `/` in one of these positions opens a regex literal, not a division.
 *
 * `<` and `>` are deliberately EXCLUDED even though `a < /re/` parses: including them makes
 * every JSX closing tag (`</div>`) in web/src open a phantom regex and blanks the rest of the
 * component. Misreading a regex as division only leaves it unmasked, which at worst counts a
 * call that isn't one — the harmless direction.
 */
function isRegexStart(prevSig) {
  return prevSig === '' || '(,=:[!&|?{};+-*%~^'.includes(prevSig);
}

/** Index just past the closing `/` of the regex literal starting at `start`, or `start`. */
function skipRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') return start; // unterminated — it was division after all
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i + 1;
    i++;
  }
  return start;
}

// ---------------------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------------------

function walk(root, dir, acc) {
  const abs = join(root, dir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(root, rel, acc);
    else if (CALLER_EXTENSIONS.some((ext) => e.name.endsWith(ext))) acc.push(rel);
  }
  return acc;
}

/** Every file that could contain a call, masked once and reused by every check. */
export function callerFiles(root = ROOT) {
  const files = [];
  for (const dir of CALLER_ROOTS) walk(root, dir, files);
  return files.map((rel) => ({
    path: rel,
    text: maskNoise(readFileSync(join(root, rel), 'utf8')),
    isTest: rel.startsWith('test/'),
  }));
}

function tsFilesIn(root, rel) {
  const abs = join(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return [rel];
  return walk(root, rel, []).filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'));
}

// ---------------------------------------------------------------------------------------
// Declarations: what the data layer exports
// ---------------------------------------------------------------------------------------

/**
 * Names declared directly on the object literal a `*Repo(...)` factory returns.
 *
 * Depth-tracked rather than indentation-matched: a nested object or an inline arrow would
 * otherwise contribute phantom "methods" that no caller can ever satisfy — a false red on
 * a file the fork wrote correctly, which is the one outcome this gate must not produce.
 */
export function repoMembers(maskedSrc, factoryStart) {
  const ret = /return\s*\{/g;
  ret.lastIndex = factoryStart;
  const hit = ret.exec(maskedSrc);
  if (!hit) return null;
  let i = hit.index + hit[0].length - 1; // the `{` itself
  let depth = 0;
  const memberStarts = [];
  let expectMember = false;
  for (; i < maskedSrc.length; i++) {
    const c = maskedSrc[i];
    if (c === '{' || c === '[' || c === '(') {
      depth++;
      if (depth === 1) expectMember = true;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && c === ',') {
      expectMember = true;
      continue;
    }
    if (expectMember && !/\s/.test(c)) {
      memberStarts.push(i);
      expectMember = false;
    }
  }
  if (depth !== 0) return null; // unbalanced — refuse to guess
  const members = [];
  for (const start of memberStarts) {
    const slice = maskedSrc.slice(start, start + 120);
    const m = /^(?:async\s+)?(?:\*\s*)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*[(:]/.exec(slice);
    // The member's own offset, so a finding points at the declaration rather than at the first
    // place the name happens to appear inside an earlier method's body.
    if (m) members.push({ name: m[1], index: start + slice.indexOf(m[1]) });
  }
  return members;
}

/** Method names only — `repoMembers` without the offsets. */
export function repoMethods(maskedSrc, factoryStart) {
  return repoMembers(maskedSrc, factoryStart)?.map((m) => m.name) ?? null;
}

/**
 * `@reachability-exempt: <reason>` on the declaration line, or anywhere in the comment block
 * directly above it.
 *
 * "Directly above" means contiguous — the scan walks up and stops at the first line that is
 * not a comment. A fixed N-line window would let a marker written for one method leak onto the
 * next one across a blank line, quietly exempting something nobody meant to exempt. A marker
 * with no reason after the colon returns null and exempts nothing: the reason IS the review
 * artifact, so an empty one is not an exemption.
 */
function exemptionAt(rawSrc, offset) {
  const lines = rawSrc.split('\n');
  const lineNo = rawSrc.slice(0, offset).split('\n').length - 1;
  const reasonIn = (line) => {
    const at = line.indexOf(EXEMPT_MARKER);
    if (at === -1) return null;
    return line.slice(at + EXEMPT_MARKER.length).trim() || null;
  };
  const onDecl = reasonIn(lines[lineNo] ?? '');
  if (onDecl) return onDecl;
  for (let i = lineNo - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!(line.startsWith('//') || line.startsWith('*') || line.startsWith('/*'))) break;
    const reason = reasonIn(line);
    if (reason) return reason;
  }
  return null;
}

function lineOf(rawSrc, offset) {
  return rawSrc.slice(0, offset).split('\n').length;
}

/**
 * Every runtime declaration in src/data/ that a caller must reach: each repo factory's
 * methods, plus the module's own plain exports. `export type` / `export interface` are
 * compile-time only and are skipped — they have no call site to find.
 */
export function dataDeclarations(root = ROOT) {
  const decls = [];
  const unparsed = [];
  for (const rel of tsFilesIn(root, 'src/data')) {
    const raw = readFileSync(join(root, rel), 'utf8');
    const masked = maskNoise(raw);

    const factories = [...masked.matchAll(/^export\s+function\s+([A-Za-z_$][\w$]*Repo)\s*\(/gm)];
    for (const f of factories) {
      const factoryExempt = exemptionAt(raw, f.index);
      const members = repoMembers(masked, f.index);
      if (members === null) {
        unparsed.push({ file: rel, factory: f[1], line: lineOf(raw, f.index) });
        continue;
      }
      for (const { name, index } of members) {
        decls.push({
          kind: 'method',
          file: rel,
          repo: f[1],
          name,
          label: `${f[1]}.${name}`,
          line: lineOf(raw, index),
          exempt: factoryExempt ?? exemptionAt(raw, index),
        });
      }
    }

    const plain = [
      ...masked.matchAll(
        /^export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)/gm,
      ),
    ];
    for (const p of plain) {
      decls.push({
        kind: 'export',
        file: rel,
        name: p[1],
        label: p[1],
        line: lineOf(raw, p.index),
        exempt: exemptionAt(raw, p.index),
      });
    }
  }
  return { decls, unparsed };
}

// ---------------------------------------------------------------------------------------
// Call sites
// ---------------------------------------------------------------------------------------

/** Repo key → factory name, read from the object `makeDb` returns. */
export function repoKeys(root = ROOT) {
  const masked = maskNoise(readFileSync(join(root, 'src/data/index.ts'), 'utf8'));
  const keys = new Map();
  for (const m of masked.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*Repo)\s*\(/g)) {
    keys.set(m[1], m[2]);
  }
  return keys;
}

const RESERVED_BINDINGS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await']);

/**
 * Method names invoked on `factory`'s repo somewhere in `text`, via any of the shapes the kit
 * actually writes:
 *   `ctx.db.notes.list(...)`            direct member chain on the repo key
 *   `const repo = makeDb(env).aiBudget` then `repo.tryReserve(...)`   (src/ai/budget.ts)
 *   `const repo = auditRepo(env.DB)`    then `repo.listByAction(...)` (test/data/audit.test.ts)
 *   `const { list } = db.notes`         destructured
 *   `this.get(...)`                     self-call inside the repo file (src/data/notes.ts)
 */
export function calledMethods(text, { key, factory, selfFile }) {
  const found = new Set();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (key) {
    for (const m of text.matchAll(
      new RegExp(`\\.\\s*${esc(key)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'),
    )) {
      found.add(m[1]);
    }
    for (const m of text.matchAll(
      new RegExp(`\\{([^{}]*)\\}\\s*=\\s*[^;=\\n]*\\.\\s*${esc(key)}\\s*[;\\n]`, 'g'),
    )) {
      for (const part of m[1].split(',')) {
        const name = part.split(':').pop()?.trim();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) found.add(name);
      }
    }
  }

  // Locals bound to this repo, then every method called on them.
  const bindings = new Set();
  const bindPatterns = [
    key &&
      new RegExp(
        `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;=\\n]*\\.\\s*${esc(key)}\\s*[;\\n]`,
        'g',
      ),
    new RegExp(
      `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${esc(factory)}\\s*\\(`,
      'g',
    ),
  ].filter(Boolean);
  for (const re of bindPatterns) {
    for (const m of text.matchAll(re)) {
      if (!RESERVED_BINDINGS.has(m[1])) bindings.add(m[1]);
    }
  }
  if (selfFile) bindings.add('this');
  for (const b of bindings) {
    for (const m of text.matchAll(
      new RegExp(`\\b${esc(b)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'),
    )) {
      found.add(m[1]);
    }
  }
  return found;
}

/** Where a plain export is referenced, ignoring its own declaration line. */
function plainExportReferences(files, decl) {
  const re = new RegExp(`\\b${decl.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const hits = { src: 0, test: 0 };
  for (const f of files) {
    for (const m of f.text.matchAll(re)) {
      const isOwnDeclaration =
        f.path === decl.file && f.text.slice(0, m.index).split('\n').length === decl.line;
      if (isOwnDeclaration) continue;
      hits[f.isTest ? 'test' : 'src']++;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------
// Check 1 — data-layer reachability
// ---------------------------------------------------------------------------------------

export function dataReachability(root = ROOT) {
  const files = callerFiles(root);
  const keys = repoKeys(root);
  const factoryToKey = new Map([...keys].map(([k, f]) => [f, k]));
  const { decls, unparsed } = dataDeclarations(root);

  const dead = [];
  const testOnly = [];
  const exempt = [];

  // Every method call is resolved once PER REPO, not once per declaration: a repo with six
  // methods used to re-scan all 128 caller files six times over.
  const perRepo = new Map();
  for (const decl of decls) {
    const repoId = `${decl.file}::${decl.repo}`;
    if (decl.kind !== 'method' || perRepo.has(repoId)) continue;
    const key = factoryToKey.get(decl.repo) ?? null;
    const hits = { src: new Set(), test: new Set() };
    for (const f of files) {
      const called = calledMethods(f.text, {
        key,
        factory: decl.repo,
        selfFile: f.path === decl.file,
      });
      const into = f.isTest ? hits.test : hits.src;
      for (const name of called) into.add(name);
    }
    perRepo.set(repoId, hits);
  }

  for (const decl of decls) {
    if (decl.exempt) {
      exempt.push(decl);
      continue;
    }
    let calledFromSrc;
    let calledFromTest;
    if (decl.kind === 'method') {
      const hits = perRepo.get(`${decl.file}::${decl.repo}`);
      calledFromSrc = hits.src.has(decl.name);
      calledFromTest = hits.test.has(decl.name);
    } else {
      const hits = plainExportReferences(files, decl);
      calledFromSrc = hits.src > 0;
      calledFromTest = hits.test > 0;
    }
    if (!calledFromSrc && !calledFromTest) dead.push(decl);
    else if (!calledFromSrc) testOnly.push(decl);
  }

  return { dead, testOnly, exempt, unparsed, total: decls.length };
}

// ---------------------------------------------------------------------------------------
// Check 2 — route registration
// ---------------------------------------------------------------------------------------

/**
 * Where route modules live. `src/routes/` is the fork's; `src/auth/` holds the few KIT-OWNED route
 * modules (src/auth/serviceIdentityRoutes.ts) — kit routes that must travel with /kit-upgrade, so
 * they sit in the protected core rather than the fork-owned tree. Their registration is still one
 * fork-owned line in src/routes/index.ts, which is exactly the line a fork adopting the core can
 * forget — so this gate scans both, and an adopted-but-unserved kit route module goes red here
 * instead of shipping silently absent.
 */
export const ROUTE_MODULE_DIRS = ['src/routes', 'src/auth'];

/** Identifiers named inside the `allRoutes` array literal in src/routes/index.ts. */
export function registeredRouteSymbols(root = ROOT) {
  const masked = maskNoise(readFileSync(join(root, 'src/routes/index.ts'), 'utf8'));
  const start = masked.search(/export\s+const\s+allRoutes\b/);
  if (start === -1) return null;
  // The first `[` after the NAME is the one in the type annotation (`readonly RouteDef[]`),
  // not the array literal — anchor on the assignment operator instead.
  const assign = /(?<![=!<>])=(?![=>])/g;
  assign.lastIndex = start;
  const eq = assign.exec(masked);
  if (!eq) return null;
  const open = masked.indexOf('[', eq.index);
  if (open === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = open; i < masked.length; i++) {
    if ('[{('.includes(masked[i])) depth++;
    else if (']})'.includes(masked[i])) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = masked.slice(open, end);
  return new Set([...body.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
}

export function routeRegistration(root = ROOT) {
  const registered = registeredRouteSymbols(root);
  const findings = [];
  const modules = [];
  if (registered === null) {
    return {
      findings: [
        {
          file: 'src/routes/index.ts',
          detail:
            'could not read an `export const allRoutes = [...]` array literal — the route registry is the ' +
            'one thing this check cannot infer',
        },
      ],
      modules,
      declared: 0,
    };
  }
  let declared = 0;
  for (const rel of ROUTE_MODULE_DIRS.flatMap((dir) => tsFilesIn(root, dir))) {
    if (rel === 'src/routes/index.ts') continue;
    const raw = readFileSync(join(root, rel), 'utf8');
    const masked = maskNoise(raw);
    const routeCount = [...masked.matchAll(/\bdefineRoute\s*\(/g)].length;
    if (routeCount === 0) continue;
    declared += routeCount;
    const exports = [
      ...masked.matchAll(
        /^export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)/gm,
      ),
    ].map((m) => m[1]);
    const wired = exports.filter((name) => registered.has(name));
    modules.push({ file: rel, routes: routeCount, exports, wired });
    if (exports.length === 0) {
      findings.push({
        file: rel,
        detail: `declares ${routeCount} route(s) but exports nothing — nothing can register them`,
      });
      continue;
    }
    if (wired.length === 0) {
      findings.push({
        file: rel,
        detail:
          `declares ${routeCount} route(s) via ${exports.join(', ')}, none of which appear in ` +
          '`allRoutes` (src/routes/index.ts) — the routes are never served, and the ' +
          'uniformity tripwire iterates `allRoutes`, so it cannot see them either',
      });
    }
  }
  return { findings, modules, declared };
}

// ---------------------------------------------------------------------------------------
// Check 3 — size thermometer (warning only)
// ---------------------------------------------------------------------------------------

export function coreSizes(root = ROOT, ceiling = CORE_SIZE_CEILING_LINES) {
  const files = [];
  for (const p of CORE_PATHS) {
    for (const rel of tsFilesIn(root, p)) {
      const text = readFileSync(join(root, rel), 'utf8');
      files.push({ file: rel, lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) });
    }
  }
  files.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  return { files, over: files.filter((f) => f.lines > ceiling), ceiling };
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

export function report(root = ROOT) {
  const out = [];
  const routes = routeRegistration(root);
  const data = dataReachability(root);
  const sizes = coreSizes(root);
  let failed = false;

  out.push('protected core — reachability (gate) + size (report)');
  out.push('');

  out.push(
    `ROUTES  ${routes.modules.length} module(s), ${routes.declared} declared route(s) in ${ROUTE_MODULE_DIRS.map((d) => `${d}/`).join(' + ')}`,
  );
  if (routes.findings.length === 0) {
    out.push('  ok — every route module reaches `allRoutes`');
  } else {
    failed = true;
    for (const f of routes.findings) out.push(`  UNREGISTERED  ${f.file}: ${f.detail}`);
  }
  out.push('');

  out.push(`DATA LAYER  ${data.total} runtime declaration(s) in src/data/`);
  if (data.unparsed.length > 0) {
    failed = true;
    for (const u of data.unparsed) {
      out.push(
        `  UNREADABLE  ${u.file}:${u.line} ${u.factory}() — no \`return { ... }\` object literal ` +
          'this check can read, so its methods are outside the gate. Give the factory the kit repo ' +
          'shape (see src/data/notes.ts), or mark it `@reachability-exempt: <reason>`.',
      );
    }
  }
  if (data.dead.length === 0) {
    out.push('  ok — every declaration has a caller');
  } else {
    failed = true;
    for (const d of data.dead) {
      out.push(
        `  DEAD  ${d.file}:${d.line} ${d.label} — no caller in src/, web/src/, or test/. ` +
          'Delete it, wire it up, or mark it `@reachability-exempt: <reason>`.',
      );
    }
  }
  if (data.testOnly.length > 0) {
    // Reported, not failed. "Only the suite calls it" is a weaker claim than "nothing calls
    // it" — the method is exercised and its behaviour is pinned, it just has no production
    // caller yet. Failing on it would red a fork for keeping a tested affordance.
    out.push(`  called only from test/ (${data.testOnly.length}, not a failure):`);
    for (const d of data.testOnly) out.push(`    ${d.file}:${d.line} ${d.label}`);
  }
  if (data.exempt.length > 0) {
    // Collapsed by file + reason: one `@reachability-exempt:` on a repo factory covers all of
    // its methods, and printing the same paragraph once per method buries the signal that
    // matters — that an escape hatch is in use at all, and where.
    out.push(`  exempt by declared intent (${data.exempt.length}):`);
    const grouped = new Map();
    for (const d of data.exempt) {
      const key = `${d.file} ${d.exempt}`;
      if (!grouped.has(key)) grouped.set(key, { file: d.file, reason: d.exempt, labels: [] });
      grouped.get(key).labels.push(d.label);
    }
    for (const g of grouped.values()) {
      out.push(`    ${g.file}  ${g.labels.sort().join(', ')}`);
      out.push(`      reason: ${g.reason.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  }
  out.push('');

  out.push(`SIZE  ceiling ${sizes.ceiling} lines — REPORT ONLY, never fails the build`);
  for (const f of sizes.files.slice(0, 5)) {
    out.push(
      `  ${String(f.lines).padStart(5)}  ${f.file}${f.lines > sizes.ceiling ? '  OVER' : ''}`,
    );
  }
  out.push(
    sizes.over.length === 0
      ? `  ${sizes.files.length} protected-core file(s), 0 over the ceiling`
      : `  ${sizes.files.length} protected-core file(s), ${sizes.over.length} OVER the ceiling — ` +
          'decompose the responsibility (splitting the file only moves the lines)',
  );

  return { text: out.join('\n'), failed };
}

/**
 * True when this module is the script node was started with. Duplicated from
 * scripts/lib/main-module.mjs to keep this file importable with no repo-relative deps — see
 * the header. Realpath on BOTH sides: node realpaths the entry point when it sets
 * import.meta.url and pathToFileURL does not, so the naive comparison fails OPEN (the gate
 * exits 0 having checked nothing) whenever any ancestor is a symlink — /tmp on macOS, most
 * CI workspaces.
 */
export function isMainModule(metaUrl) {
  if (typeof metaUrl !== 'string' || !metaUrl.startsWith('file:')) {
    throw new TypeError(`isMainModule(import.meta.url) expects a file: URL, got ${metaUrl}`);
  }
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
  const main = resolve(entry);
  return self !== null && self === main;
}

if (isMainModule(import.meta.url)) {
  const { text, failed } = report(ROOT);
  process.stdout.write(`${text}\n`);
  if (failed) {
    process.stdout.write(
      '\nprotected-core reachability FAILED — the declarations above run nowhere.\n',
    );
    process.exit(1);
  }
}
