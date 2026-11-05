// Route least-privilege coverage: which defineRoutes declare `needs`, and which do not.
//
//   node scripts/check-route-needs.mjs           # report; ALWAYS exits 0
//   node scripts/check-route-needs.mjs --gate    # exit 1 below the graduation threshold
//
// WHAT `needs` IS. `RouteSpec.needs` (src/framework/defineRoute.ts, runtime half in
// src/framework/scopedDb.ts) names the repositories a handler may reach through `ctx.db`.
// Declaring `needs: ['notes']` narrows `ctx.db` to `Pick<Db, 'notes'>` at compile time and
// backs it with a view that throws on every other repository at runtime. OMIT it and `ctx.db`
// is the WHOLE data layer — a notes handler can read users, tokens, and the audit log, with
// code review as the only fence. That is ambient authority, and this file counts it.
//
// WHY THIS IS A REPORT AND NOT A GATE. `needs` shipped opt-in for a reason that has not
// changed: ~268 defineRoutes across ~17 forks declare nothing today. A hard gate here is a
// mandatory field by another name — it turns every one of those forks red on their next
// /kit-upgrade, for routes they wrote correctly against the contract that existed when they
// wrote them. So this command counts, names, and exits 0. It is the thermometer that has to
// move before the gate can exist, in the same shape as the size half of verify:core.
//
// GRADUATION IS A COVERAGE THRESHOLD, NOT A DATE. The gate arrives when
// NEEDS_COVERAGE_GRADUATION_PCT of this repo's defineRoutes declare `needs` — the ratio this
// command prints. A date graduates a gate whether or not the fleet is ready; a ratio cannot.
// The flip itself is already written and pinned by tests: `--gate` below, turned on by editing
// the `ci` script in package.json (fork-editable, outside the protected core, so a fork that
// is not there yet can take the kit's version of this file without taking the flip). See the
// `verify:needs` stanza in docs/DECISIONS.md.
//
// WHAT IT DOES NOT DO. It is not a type checker and it does not resolve values across function
// boundaries. It reads each `defineRoute({ ... })` object literal and asks two questions of the
// text: is there a top-level `needs:` key, and which `ctx.db.<repo>` names appear inside. So:
//   * `const { notes } = ctx.db` hides the repository name — detected as opaque db use, which
//     suppresses the suggestion rather than producing a wrong one.
//   * `defineRoute(spec)` where `spec` is a variable is UNREADABLE, and reported as such.
//   * a handler that reaches a repo only through a helper it calls is not traced.
//   * a call written with EXPLICIT type arguments — `defineRoute<typeof schema>({ ... })` — is
//     not recognized as a route at all. Deliberately the same recognizer as
//     check-core-reachability's route-registration gate, which is HARD and carries the identical
//     blind spot: one shape of route, invisible to one check, is a bug worth fixing in both at
//     once; two checks disagreeing about what a route is, is a bug that costs a day to find.
//     TypeScript infers both parameters from the object literal, so the kit never writes it.
// Every one of those under-reports. That is the required direction for anything the fleet
// runs: a missed suggestion costs a review comment, a false red costs 17 forks an upgrade.
//
// The masker is shared with scripts/check-core-reachability.mjs rather than copied — it is a
// JS-aware masker whose first two cuts each produced a file-eating runaway, and one battle-
// tested copy beats two. That import is this file's ONLY repo-relative dependency beyond
// scripts/lib/; when those checks are extracted into a shared package (docs/MODULARIZATION-PLAN.md)
// this import follows them to the package and nothing else here moves.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskNoise, repoKeys } from './check-core-reachability.mjs';
import { isMainModule } from './main-module.mjs';

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

/**
 * Percentage of defineRoutes that must declare `needs` before this check may become a hard
 * gate. Deliberately not 100: a 100% gate is `needs` made mandatory, the breaking change the
 * framework declined. At 80 the remainder is a nameable list one PR can finish.
 */
export const NEEDS_COVERAGE_GRADUATION_PCT = 80;

/** Worker source that can hold a route definition. */
const SCAN_ROOT = 'src';

// ---------------------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------------------

function walk(root, dir, acc) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(root, rel, acc);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) acc.push(rel);
  }
  return acc;
}

function routeSourceFiles(root) {
  try {
    if (!statSync(join(root, SCAN_ROOT)).isDirectory()) return [];
  } catch {
    return [];
  }
  return walk(root, SCAN_ROOT, []);
}

// ---------------------------------------------------------------------------------------
// Reading one `defineRoute({ ... })`
// ---------------------------------------------------------------------------------------

/**
 * Top-level keys of the object literal opening at `open`, plus where its value ends and where
 * the object closes. Returns null if the braces never balance (a truncated or unreadable file
 * — refuse to guess rather than report a route that isn't there).
 *
 * Keys are collected only at positions where a member may START — right after the `{` and
 * right after a comma at depth 1 — never by scanning for `identifier:` anywhere. The looser
 * form reads the middle of a ternary (`audit: ok ? a : b`) as a key named `a`, and would just
 * as happily invent a `needs` that nobody wrote.
 */
export function objectLiteralKeys(masked, open) {
  let depth = 0;
  let expectMember = false;
  const keys = [];
  const boundaries = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{' || c === '[' || c === '(') {
      depth++;
      if (depth === 1) expectMember = true;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) {
        boundaries.push(i);
        return { keys, boundaries, end: i };
      }
      continue;
    }
    if (depth === 1 && c === ',') {
      boundaries.push(i);
      expectMember = true;
      continue;
    }
    if (expectMember && !/\s/.test(c)) {
      // 80 chars is far more than `identifier:` ever needs and stops the slice from copying a
      // whole handler body per member.
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(masked.slice(i, i + 80));
      if (m) keys.push({ name: m[1], index: i, valueStart: i + m[0].length });
      expectMember = false;
    }
  }
  return null;
}

/** Raw text of a key's value: from just after the colon to the next top-level comma or `}`. */
function valueText(raw, key, boundaries) {
  const end = boundaries.find((b) => b > key.valueStart);
  return raw.slice(key.valueStart, end ?? key.valueStart).trim();
}

/** `'GET'` → `GET`. A non-literal (a const, a computed value) is returned as written. */
function literalValue(text) {
  const m = /^(['"`])(.*)\1$/s.exec(text);
  return m ? m[2] : text;
}

/**
 * Repository names inside `needs: [...]`, or null when the value is not an array literal this
 * check can read (`needs: NOTES_ONLY`). Null still counts as DECLARED — the route made the
 * declaration, and reading a const is a type checker's job, not a text scanner's.
 */
function needsMembers(text) {
  if (!text.startsWith('[')) return null;
  return [...text.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

// A repository read off the data layer. BOTH the `ctx.db.notes` chain and a bare `db.notes`
// count: a handler written `async ({ db }, input) => db.notes.list()` destructures its ctx, and
// a dot-anchored pattern reads that route as touching no repository at all — the one wrong
// answer this scan can give, because `add \`needs: []\`` on it is advice that breaks the route.
// `(?:\.\s*|\b)` before `db` is what keeps `mydb.notes` and `foo.mydb.x` out.
const DB_MEMBER = /(?:\.\s*|\b)db\s*\.\s*([A-Za-z_$][\w$]*)/g;
// `ctx.db` NOT followed by a member access: a pass-through to a helper, an `Object.keys(ctx.db)`.
// The name of the repository is not in the text, so any suggestion built from this route would
// be a guess — so none is offered.
const DB_OPAQUE = /\.\s*db\b(?!\s*\.)/;

/**
 * Repositories the spec body names directly, intersected with the app's real repo keys so a
 * `db.prepare()` cannot invent one.
 */
function reachedRepos(maskedBody, knownKeys) {
  const found = new Set();
  for (const m of maskedBody.matchAll(DB_MEMBER)) {
    if (knownKeys.size === 0 || knownKeys.has(m[1])) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * The spec text the db scan reads: everything except the `uniformityFixture` value, blanked in
 * place.
 *
 * A fixture's `seed(db)` is typed against the WHOLE `Db` on purpose — it seeds one real resource
 * for the 404-uniformity tripwire and is not the handler. Counting its repositories would
 * over-suggest `needs` (asking a route to declare reach it never has at request time), and its
 * bare `db` parameter would otherwise mark every `:param` route as reaching the data layer
 * opaquely. Blanked rather than cut so nothing downstream depends on offsets shifting.
 */
function scannableBody(masked, open, end, byName, boundaries) {
  const body = masked.slice(open, end);
  const fixture = byName.get('uniformityFixture');
  if (!fixture) return body;
  const stop = boundaries.find((b) => b > fixture.valueStart) ?? end;
  const from = fixture.valueStart - open;
  return body.slice(0, from) + ' '.repeat(stop - open - from) + body.slice(stop - open);
}

function lineOf(raw, offset) {
  return raw.slice(0, offset).split('\n').length;
}

// ---------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------

/**
 * Every `defineRoute(...)` in the worker source, with what it declared and what it reaches.
 *
 * `unreadable` is kept separate from `undeclared` on purpose: "this route declares no `needs`"
 * and "this check could not read this route" are different claims, and folding the second into
 * the first would let an unparseable file quietly drag the ratio the graduation threshold is
 * measured against.
 */
export function routeNeeds(root = ROOT) {
  let knownKeys;
  try {
    knownKeys = new Set(repoKeys(root).keys());
  } catch {
    // No readable src/data/index.ts (a fork mid-restructure, a fixture). The count is still
    // exact; only the suggested `needs` degrades to "every name it saw".
    knownKeys = new Set();
  }

  const declared = [];
  const undeclared = [];
  const unreadable = [];

  for (const rel of routeSourceFiles(root)) {
    const raw = readFileSync(join(root, rel), 'utf8');
    const masked = maskNoise(raw);
    for (const call of masked.matchAll(/\bdefineRoute\s*\(/g)) {
      const open = masked.indexOf('{', call.index + call[0].length);
      const onlyWhitespaceBefore =
        open !== -1 && masked.slice(call.index + call[0].length, open).trim() === '';
      const parsed = onlyWhitespaceBefore ? objectLiteralKeys(masked, open) : null;
      if (!parsed) {
        unreadable.push({
          file: rel,
          line: lineOf(raw, call.index),
          detail: onlyWhitespaceBefore
            ? 'the spec object literal never closes'
            : 'the argument is not an object literal written in place',
        });
        continue;
      }
      const byName = new Map(parsed.keys.map((k) => [k.name, k]));
      const read = (name) => {
        const key = byName.get(name);
        return key ? literalValue(valueText(raw, key, parsed.boundaries)) : '';
      };
      const body = scannableBody(masked, open, parsed.end, byName, parsed.boundaries);
      const route = {
        file: rel,
        line: lineOf(raw, call.index),
        method: read('method') || '?',
        path: read('path') || '?',
        reaches: reachedRepos(body, knownKeys),
        opaqueDb: DB_OPAQUE.test(body),
      };
      const needsKey = byName.get('needs');
      if (needsKey) {
        route.needs = needsMembers(valueText(raw, needsKey, parsed.boundaries));
        declared.push(route);
      } else {
        undeclared.push(route);
      }
    }
  }

  const total = declared.length + undeclared.length;
  return {
    declared,
    undeclared,
    unreadable,
    total,
    // An app with no routes is vacuously covered: a ratio over zero must not read as a
    // failure, or `--gate` would red a fork that simply has not written an endpoint yet.
    percent: total === 0 ? 100 : Math.round((declared.length / total) * 100),
  };
}

/**
 * Repositories a route declared but never names in its body. A HINT, not a finding: the scan
 * does not follow helpers, so a genuinely used repository can look unused. Printed so
 * over-declaration is visible; never counted, never failed.
 */
export function overDeclared(scan) {
  const out = [];
  for (const r of scan.declared) {
    if (!r.needs || r.needs.length === 0 || r.opaqueDb) continue;
    const unused = r.needs.filter((n) => !r.reaches.includes(n));
    if (unused.length > 0) out.push({ ...r, unused });
  }
  return out;
}

/** The `needs` a route would declare if the scan's reading of its body is complete. */
function suggestion(route) {
  if (route.opaqueDb) return null;
  return `needs: [${route.reaches.map((r) => `'${r}'`).join(', ')}]`;
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

export function report(
  root = ROOT,
  { gate = false, threshold = NEEDS_COVERAGE_GRADUATION_PCT } = {},
) {
  const scan = routeNeeds(root);
  const out = [];
  // A column that is never allowed to abut the next one: a 34-character route path would
  // otherwise run straight into the fix it is being told to apply.
  const pad = (s, n) => `${s} `.padEnd(n);

  out.push(
    gate
      ? `route \`needs\` coverage — GATE at ${threshold}%`
      : 'route `needs` coverage — REPORT ONLY, never fails the build',
  );
  out.push('');
  out.push(
    `  ${scan.declared.length} / ${scan.total} route(s) declare \`needs\` (${scan.percent}%) — ` +
      `hard gate at ${threshold}%`,
  );
  out.push('');

  if (scan.undeclared.length === 0) {
    out.push('  ok — every defineRoute names the repositories it may reach');
  } else {
    out.push(
      `  UNDECLARED (${scan.undeclared.length}) — \`ctx.db\` is the WHOLE data layer for these:`,
    );
    for (const r of scan.undeclared) {
      const fix = suggestion(r);
      out.push(
        `    ${pad(`${r.file}:${r.line}`, 34)}${pad(r.method, 7)}${pad(r.path, 32)}` +
          (fix ? `add \`${fix}\`` : 'reaches ctx.db opaquely — read the handler'),
      );
    }
  }

  if (scan.unreadable.length > 0) {
    out.push('');
    out.push(`  UNREADABLE (${scan.unreadable.length}) — not counted either way:`);
    for (const u of scan.unreadable) out.push(`    ${u.file}:${u.line} — ${u.detail}`);
  }

  const over = overDeclared(scan);
  if (over.length > 0) {
    out.push('');
    out.push(`  DECLARED BUT UNUSED (${over.length}) — a hint, not a finding; the scan does not`);
    out.push('  follow helpers, so confirm before narrowing:');
    for (const r of over) {
      out.push(`    ${pad(`${r.file}:${r.line}`, 34)}${pad(r.method, 7)}${r.unused.join(', ')}`);
    }
  }

  const short = scan.percent < threshold;
  out.push('');
  out.push(
    short
      ? `  ${threshold - scan.percent} percentage point(s) short of the ${threshold}% graduation threshold.`
      : `  At or above the ${threshold}% graduation threshold — this check is ready to become a gate.`,
  );

  return { text: out.join('\n'), scan, failed: gate && short };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const gateArg = args.find((a) => a === '--gate' || a.startsWith('--gate='));
  const override = gateArg?.includes('=') ? Number(gateArg.split('=')[1]) : Number.NaN;
  const threshold = Number.isFinite(override) ? override : NEEDS_COVERAGE_GRADUATION_PCT;
  const { text, failed, scan } = report(ROOT, { gate: Boolean(gateArg), threshold });
  process.stdout.write(`${text}\n`);
  if (failed) {
    process.stdout.write(
      `\nroute \`needs\` coverage FAILED — ${scan.percent}% is below the ${threshold}% gate.\n`,
    );
    process.exit(1);
  }
}
