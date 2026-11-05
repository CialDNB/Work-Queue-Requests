#!/usr/bin/env node
// Every kit migration has arrived in this app — matched by CONTENT, whatever its number.
//
//   node scripts/check-kit-migrations.mjs            # the gate (npm run verify:kit-migrations)
//   node scripts/check-kit-migrations.mjs --write    # the kit only: pin new kit migrations
//   node scripts/check-kit-migrations.mjs --write --repin <file> [--repin <file> …] [--keep-prior]
//
// THE GAP THIS CLOSES. `migrations/` is deliberately not in the /kit-upgrade diff set: a fork's
// migration numbering is its own, so each kit migration is copied by hand and RENUMBERED to the
// fork's next free ordinal. Nothing checked that the copy happened. The code that needs the new
// shape (src/auth, src/data, …) does ride the upgrade, so a fork could adopt the core, stay green in
// CI — the test harness applies schema.sql, which already has every kit table — and meet the
// missing migration only in production: bearer tokens refused on `api_token_schema_drift` until
// 0003 runs, and so on. With forks renumbering, "is 0003 here?" cannot be asked by name. It can
// be asked by content, which is what this does.
//
// THE MANIFEST (scripts/kit-migrations.json) pins every kit-owned migration as the sha256 of its
// NORMALISED statements. It lives in scripts/ because scripts/ rides /kit-upgrade, so the list and
// this checker always arrive together — never in migrations/d1/, which the upgrade does not carry
// and whose every file the ordinal guard (test/platform/migration-ordinals.test.mjs) reads as a
// migration. The manifest has no stamp over itself: in the kit, the check below IS the stamp — it
// fails until every kit migration is pinned and every pin matches its file.
//
// NORMALISED means what a correct copy may change is ignored and what it may not is kept:
//   - comments (`--` and `/* */`) are dropped — forks rewrite the "ADOPTING FORKS" header when
//     they renumber (insights' 0004/0005 do exactly that), and a comment is not a statement;
//   - every whitespace run becomes one space, and CRLF, a BOM and trailing space do not count;
//   - quoted text is kept byte for byte — a string, a "quoted" or `quoted` or [bracketed]
//     identifier — so a `--` inside a string is data, not a comment;
//   - in 0000_kit_app_identity.sql ONLY, the seeded name — the whole literal right after `('app',`,
//     when it is exactly the app's vars.APP_NAME — becomes a placeholder. That file is the one a
//     fork MUST edit: it seeds the fork's name instead of the template's. Nowhere else is a name
//     substituted: every other kit migration is compared exactly, so a fork whose APP_NAME happens
//     to equal some other literal ('client', 'now') is not told its byte-identical copy was
//     modified. A literal that already reads as the placeholder makes the identity file match
//     nothing — a seed of the placeholder text is not a seed of the app's name.
// Anything else — a changed column, a dropped trigger, a different CHECK — is a different hash.
//
// IN AN APP every pinned kit migration must match SOME `*.sql` file in the folder wrangler applies
// the DB binding's migrations from — its `migrations_dir` in wrangler.jsonc (migrations/d1 in the
// kit), which wrangler.staging.jsonc must name too; a `migrations_pattern` is refused. A miss is a
// failure that names the kit file and the ordinal to copy it to; a miss where a file carries the
// kit file's slug is reported as MODIFIED, because a copy whose statements were edited is not the
// kit's migration and the next kit migration assumes the kit's shape.
//
// IN THE KIT (the unforked template: wrangler.jsonc still carries the template's name, the signal
// isTemplateRepo() in scripts/new-app.mjs and isUnforkedTemplate() in check-edge-hardening.mjs
// read) it additionally holds the manifest to the folder: every kit migration pinned, every pin
// present and unchanged. A shipped kit migration is IMMUTABLE — forks copied that text and
// wrangler will never re-run it, so an edit reaches no database that already applied it. Ship a
// new migration instead. A deliberate edit of a migration no fork can have applied yet is re-pinned
// with --repin, which REVOKES the old hash: such an edit is almost always a fix, and a fork that
// copied the old text early is exactly the one that must go red. --keep-prior keeps the old hash
// (and any earlier ones) accepted as prior revisions — only for a rewrite that changes no effect.
//
// Wired into `npm run ci` as verify:kit-migrations, and run by .github/workflows/ci.yml as a plain
// `node scripts/check-kit-migrations.mjs` — package.json is NOT in the /kit-upgrade diff set, and
// ci.yml and scripts/ are, so the CI step and this script always arrive in a fork together. See
// DECISIONS 2026-09-25.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATED_BINDING, migrationsDirFor } from './check-d1-identity.mjs';
import { isMainModule } from './kit-checks/main-module.mjs';
import { parseJsonc, TEMPLATE_KEBAB } from './new-app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const MANIFEST_FILE = 'scripts/kit-migrations.json';
export const MIGRATIONS_DIR = 'migrations/d1';
export const IDENTITY_CONFIG = 'wrangler.jsonc';
export const STAGING_CONFIG = 'wrangler.staging.jsonc';

/**
 * The normaliser's version, recorded in the manifest. A change to `normaliseSql` changes every
 * hash, so it bumps this and re-pins every file in one deliberate commit; a manifest written under
 * a different version is refused rather than compared (every entry would read as "modified").
 */
export const NORMALISATION = 1;

/** What the seeded app name becomes, as a whole SQL string literal. */
export const APP_NAME_PLACEHOLDER = "'{{APP_NAME}}'";

/** The one kit migration whose seeded app name is a fork's to change. */
export const IDENTITY_MIGRATION = '0000_kit_app_identity.sql';

/** Where the seed sits in the normalised output: straight after `('app',` in the INSERT. */
const SEED_POSITION = /\('app' ?, ?$/;

const PINNED_NAME = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CLOSERS = { "'": "'", '"': '"', '`': '`', '[': ']' };

/**
 * The statements of a migration, stripped of everything a correct copy may change. Pure.
 *
 * A scanner, not a regex: `--` inside a string is data, and a quote inside a comment is not a
 * quote. SQLite's quoting is the whole grammar needed — `'…'` strings, `"…"`, `` `…` `` and `[…]`
 * identifiers, a doubled closer escaping itself in the first three.
 *
 * `appName` is passed for the identity migration only (see `pinHash`): with it, the literal in the
 * seed position that equals the name becomes APP_NAME_PLACEHOLDER, and a literal that already
 * equals the placeholder poisons the file \u2014 the result is `null`, which no pin matches. Without
 * it, nothing is substituted and the result is never null.
 *
 * @param {string} text the file's contents
 * @param {string | null | undefined} appName the app's `vars.APP_NAME` (identity migration only)
 * @returns {string | null}
 */
export function normaliseSql(text, appName) {
  const src = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const appLiteral =
    typeof appName === 'string' && appName !== '' ? `'${appName.replaceAll("'", "''")}'` : null;
  let out = '';
  let gap = false;
  const emit = (token) => {
    if (gap && out !== '') out += ' ';
    gap = false;
    out += token;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '-' && next === '-') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      gap = true;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      gap = true;
    } else if (/\s/.test(c)) {
      i++;
      gap = true;
    } else if (c in CLOSERS) {
      const close = CLOSERS[c];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === close) {
          if (close !== ']' && src[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const token = src.slice(i, j + 1);
      if (appLiteral !== null && token === APP_NAME_PLACEHOLDER) return null;
      const seed = appLiteral !== null && token === appLiteral && SEED_POSITION.test(out);
      emit(seed ? APP_NAME_PLACEHOLDER : token);
      i = j + 1;
    } else {
      emit(c);
      i++;
    }
  }
  return out;
}

/** sha256 (hex) of a migration's normalised statements, or null when normaliseSql refuses the
 *  text (a placeholder literal in the identity migration). Pure. */
export function migrationHash(text, appName) {
  const normalised = normaliseSql(text, appName);
  return normalised === null ? null : createHash('sha256').update(normalised).digest('hex');
}

/**
 * The hash `text` is compared under for the kit migration `kitFile`: with the seeded app name
 * substituted for the identity migration, exactly otherwise. Pure.
 */
export function pinHash(kitFile, text, appName) {
  return migrationHash(text, kitFile === IDENTITY_MIGRATION ? appName : null);
}

/** `0003_api_token_scopes.sql` → `api_token_scopes.sql`: the name minus its ordinal. Pure. */
export function slugOf(file) {
  return file.replace(/^\d+_/, '');
}

/**
 * The manifest, validated, or `{ error }`. Every malformed shape is refused rather than read
 * around: a pin the checker cannot read is a kit migration nothing verifies. Pure.
 */
export function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: `${MANIFEST_FILE}: not valid JSON` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${MANIFEST_FILE}: not a JSON object` };
  }
  if (raw.normalisation !== NORMALISATION) {
    return {
      error:
        `${MANIFEST_FILE}: written under normalisation ${JSON.stringify(raw.normalisation)}, and ` +
        `this checker hashes under ${NORMALISATION}. In an app: adopt scripts/check-kit-` +
        'migrations.mjs and scripts/kit-migrations.json from the same kit commit — they change ' +
        'together. In the kit, after a normaliser change: delete the manifest and re-pin every ' +
        'file with --write.',
    };
  }
  if (!Array.isArray(raw.migrations)) {
    return { error: `${MANIFEST_FILE}: "migrations" must be an array` };
  }
  const seen = new Set();
  const migrations = [];
  for (const entry of raw.migrations) {
    const where = `${MANIFEST_FILE}: entry ${JSON.stringify(entry)}`;
    if (!entry || typeof entry !== 'object') return { error: `${where} is not an object` };
    if (typeof entry.file !== 'string' || !PINNED_NAME.test(entry.file)) {
      return { error: `${where} has no NNNN_slug.sql "file"` };
    }
    if (seen.has(entry.file)) return { error: `${where} pins ${entry.file} twice` };
    seen.add(entry.file);
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      return { error: `${where} has no sha256` };
    }
    const prior = entry.priorRevisions ?? [];
    if (!Array.isArray(prior) || !prior.every((h) => typeof h === 'string' && SHA256.test(h))) {
      return { error: `${where} has a "priorRevisions" that is not a list of sha256 values` };
    }
    migrations.push({ file: entry.file, sha256: entry.sha256, priorRevisions: [...prior] });
  }
  return { normalisation: raw.normalisation, migrations };
}

/** The manifest as written by --write: sorted by file, a stable diff. Pure. */
export function serialiseManifest(migrations) {
  const body = {
    _comment:
      'Every kit-owned D1 migration, pinned by the sha256 of its normalised statements. Checked ' +
      'by scripts/check-kit-migrations.mjs (npm run verify:kit-migrations): an app must hold a ' +
      'copy of each, under any number. Kit maintainers: pin a new migration with ' +
      '`npm run verify:kit-migrations -- --write`. Never hand-edit a hash.',
    normalisation: NORMALISATION,
    migrations: [...migrations]
      // Code-point order, not localeCompare: the file must not depend on the machine's locale.
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      .map(({ file, sha256, priorRevisions }) =>
        priorRevisions?.length ? { file, sha256, priorRevisions } : { file, sha256 },
      ),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** The `*.sql` files in a listing, sorted — the files wrangler applies. Pure. */
export function sqlFiles(listing) {
  return listing.filter((name) => name.endsWith('.sql') && !name.startsWith('.')).sort();
}

/** The four-digit ordinal after the highest leading number in `files`. Pure. */
export function nextOrdinal(files, offset = 0) {
  const numbers = files.map((f) => Number(/^(\d+)_/.exec(f)?.[1] ?? -1));
  const next = Math.max(-1, ...numbers) + 1 + offset;
  return String(next).padStart(4, '0');
}

/**
 * Failures for an app's migrations against the manifest. Pure — `files` maps each app migration
 * file name to its contents.
 *
 * Returns `{ failures, matched }`: `matched` pairs each kit migration with the app file that holds
 * it, for the report.
 */
export function appFailures(manifest, files, appName, dir = MIGRATIONS_DIR) {
  const names = Object.keys(files).sort();
  // Two readings of every file: exact, for every kit migration but one, and with the seeded name
  // substituted, for the identity migration. A file is matched under the reading its pin uses.
  const exact = new Map(names.map((name) => [name, migrationHash(files[name], null)]));
  const seeded = new Map(names.map((name) => [name, migrationHash(files[name], appName)]));
  const failures = [];
  const matched = [];
  let missing = 0;
  for (const pin of manifest.migrations) {
    const accepted = new Set([pin.sha256, ...pin.priorRevisions]);
    const hashes = pin.file === IDENTITY_MIGRATION ? seeded : exact;
    const holder = names.find((name) => accepted.has(hashes.get(name)));
    if (holder) {
      matched.push({ kit: pin.file, app: holder });
      continue;
    }
    const namesake = names.find((name) => slugOf(name) === slugOf(pin.file));
    if (namesake) {
      const seed =
        pin.file === IDENTITY_MIGRATION
          ? ` Its one edit is the seeded app name, which must be exactly your vars.APP_NAME${
              appName ? ` ("${appName}")` : ''
            }.`
          : '';
      failures.push(
        `${dir}/${namesake} carries kit migration ${pin.file}'s name but not its ` +
          'statements. A copy may change comments and whitespace, nothing else — the next kit ' +
          `migration assumes the kit's shape.${seed} Restore the kit's text (git show ` +
          `kit/main:${MIGRATIONS_DIR}/${pin.file}). If the edited version has ` +
          'already run somewhere, restoring the file does not re-run it (wrangler records ' +
          'migrations by name): ship a follow-up migration that brings that database to the ' +
          "kit's shape too, and record the divergence in docs/DECISIONS.md.",
      );
      continue;
    }
    if (pin.file === IDENTITY_MIGRATION) {
      failures.push(
        `kit migration ${pin.file} has no copy in ${dir}/. Copy it KEEPING the 0000 ` +
          `number (kit-owned; it collides with nothing): git show kit/main:${MIGRATIONS_DIR}/` +
          `${pin.file} > ${dir}/${pin.file} — then change only the seeded app name to ` +
          `your vars.APP_NAME${appName ? ` ("${appName}")` : ''}, as the file's header says.`,
      );
      continue;
    }
    const target = `${nextOrdinal(names, missing)}_${slugOf(pin.file)}`;
    missing++;
    failures.push(
      `kit migration ${pin.file} has no copy in ${dir}/ (matched by content, under ` +
        `any number). Copy it to your next free ordinal, statements unedited: git show ` +
        `kit/main:${MIGRATIONS_DIR}/${pin.file} > ${dir}/${target}`,
    );
  }
  return { failures, matched };
}

/** The identity migration may not carry the placeholder itself: it would read as any app's seed. */
function placeholderFailure(dir, name) {
  return (
    `${dir}/${name} carries the literal ${APP_NAME_PLACEHOLDER}, which the checker ` +
    'reserves for the seeded app name — a file holding it would read as every app’s seed. Seed ' +
    'the real vars.APP_NAME instead.'
  );
}

/**
 * The kit's own invariants: every kit migration pinned, every pin present and unchanged. Pure —
 * `files` maps each kit migration file name to its contents.
 */
export function kitFailures(manifest, files, appName, dir = MIGRATIONS_DIR) {
  const failures = [];
  const pins = new Map(manifest.migrations.map((pin) => [pin.file, pin]));
  for (const name of Object.keys(files).sort()) {
    const pin = pins.get(name);
    if (!pin) {
      failures.push(
        `${dir}/${name} is a kit migration no pin covers, so no fork is ever told to ` +
          `copy it. Pin it: npm run verify:kit-migrations -- --write (and commit ${MANIFEST_FILE}). ` +
          'If this repo is an app rather than the kit, it has not been bootstrapped — run ' +
          '`npm run new-app <app-name>` instead; never pin an app migration into the manifest.',
      );
      continue;
    }
    const actual = pinHash(name, files[name], appName);
    if (actual === null) {
      failures.push(placeholderFailure(dir, name));
    } else if (actual !== pin.sha256) {
      failures.push(
        `${dir}/${name} changed after it was pinned (sha256 ${pin.sha256.slice(0, 12)}… ` +
          `→ ${actual.slice(0, 12)}…; comments and whitespace do not count). A shipped kit ` +
          'migration is immutable: forks copied the pinned text and wrangler never re-runs a ' +
          'migration it has recorded, so this edit reaches no database that already applied it. ' +
          'Revert it and ship the change as a NEW migration. Only if no fork can have applied ' +
          `this file yet: npm run verify:kit-migrations -- --write --repin ${name} (the old text ` +
          'stops being accepted in forks; add --keep-prior only when the rewrite changes nothing ' +
          'a database would notice).',
      );
    }
  }
  for (const pin of manifest.migrations) {
    if (!(pin.file in files)) {
      failures.push(
        `${MANIFEST_FILE} pins ${pin.file}, which is gone from ${dir}/. A shipped kit ` +
          'migration is never deleted or renamed: forks have applied it under their own number, ' +
          'and a fresh kit install needs it too. Restore it.',
      );
    }
  }
  return failures;
}

/** `./migrations/d1/` → `migrations/d1`: the spelling wrangler resolves to one folder. Pure. */
export function normaliseDir(dir) {
  return dir.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') || '.';
}

/**
 * The folder the DB binding's migrations are applied from, per config, or a failure. Reads the
 * binding the way wrangler does (`migrations_dir`, else wrangler's default), in the top level and in
 * every env block that declares its own DB (bindings are not inherited). A `migrations_pattern` is
 * refused: this checker reads every `*.sql`, wrangler's default, and a narrower pattern would let it
 * clear a file wrangler never applies. Pure.
 */
export function migrationsDirsOf(label, cfg) {
  const failures = [];
  const dirs = new Set();
  const blocks = [['', cfg]];
  if (cfg?.env && typeof cfg.env === 'object') {
    for (const [envName, block] of Object.entries(cfg.env)) blocks.push([`env.${envName}.`, block]);
  }
  for (const [where, block] of blocks) {
    const list = Array.isArray(block?.d1_databases) ? block.d1_databases : [];
    const entry = list.find((b) => b?.binding === MIGRATED_BINDING);
    // A block with no DB binding migrates nothing, so it has no folder to agree on.
    if (!entry) continue;
    if (entry?.migrations_pattern !== undefined) {
      failures.push(
        `${label}: the ${MIGRATED_BINDING} binding sets "migrations_pattern" ` +
          `(${where || 'top level'}). This checker reads every *.sql in the migrations folder — ` +
          "wrangler's default — and a narrower pattern would let it clear a file wrangler never " +
          'applies. Remove it and keep only migrations in the folder.',
      );
    }
    dirs.add(normaliseDir(migrationsDirFor(block, MIGRATED_BINDING)));
  }
  return { dirs, failures };
}

/**
 * Read the app's config: whether this is the unforked kit, its APP_NAME, and the folder wrangler
 * applies the DB migrations from — `wrangler.jsonc`'s, which `wrangler.staging.jsonc` (when present)
 * must agree with, or the checker would clear one environment's folder for both.
 */
function readConfig(root, failures) {
  let cfg = null;
  try {
    cfg = parseJsonc(readFileSync(join(root, IDENTITY_CONFIG), 'utf8'));
  } catch (err) {
    failures.push(
      `${IDENTITY_CONFIG}: could not read (${err.code ?? err.message}) — its vars.APP_NAME is ` +
        'the seeded name 0000_kit_app_identity.sql is matched against, and its DB binding names ' +
        'the migrations folder.',
    );
    return { unforked: false, appName: null, dir: MIGRATIONS_DIR };
  }
  const appName = typeof cfg?.vars?.APP_NAME === 'string' ? cfg.vars.APP_NAME : null;
  if (appName === null) {
    failures.push(
      `${IDENTITY_CONFIG}: no "vars.APP_NAME" — it is the seeded name ` +
        '0000_kit_app_identity.sql is matched against.',
    );
  }
  const dir = normaliseDir(migrationsDirFor(cfg, MIGRATED_BINDING));
  const read = [[IDENTITY_CONFIG, cfg]];
  try {
    read.push([STAGING_CONFIG, parseJsonc(readFileSync(join(root, STAGING_CONFIG), 'utf8'))]);
  } catch (err) {
    // No staging config is a legitimate layout; one that exists and cannot be read is not.
    if (err.code !== 'ENOENT') {
      failures.push(`${STAGING_CONFIG}: could not read (${err.code ?? err.message})`);
    }
  }
  for (const [label, config] of read) {
    const { dirs, failures: refused } = migrationsDirsOf(label, config);
    failures.push(...refused);
    for (const other of dirs) {
      if (other === dir) continue;
      failures.push(
        `${label} applies the ${MIGRATED_BINDING} migrations from ${other}/, and ` +
          `${IDENTITY_CONFIG} from ${dir}/. One folder holds an app's migrations, or this check ` +
          `clears one environment's folder for both: point every ${MIGRATED_BINDING} binding's ` +
          '"migrations_dir" at the same one.',
      );
    }
  }
  return { unforked: cfg?.name === TEMPLATE_KEBAB, appName, dir };
}

/** Read `<dir>/*.sql` as `{ name: contents }`. What cannot be read is reported on `failures` and
 *  left out, so it matches no pin — never an exception, never a silent pass. */
function readMigrations(root, dir, failures) {
  let listing;
  try {
    listing = readdirSync(join(root, dir));
  } catch (err) {
    failures.push(
      `${dir}/: could not list (${err.code ?? err.message}) — every kit migration is ` +
        'missing. Create the folder and copy each one (the lines below name them).',
    );
    return {};
  }
  const files = {};
  for (const name of sqlFiles(listing)) {
    try {
      files[name] = readFileSync(join(root, dir, name), 'utf8');
    } catch (err) {
      // Unreadable is not absent: it is reported, and it matches no pin.
      failures.push(`${dir}/${name}: could not read (${err.code ?? err.message})`);
    }
  }
  return files;
}

function readManifest(root) {
  try {
    return parseManifest(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
  } catch (err) {
    return {
      absent: err.code === 'ENOENT',
      error:
        `${MANIFEST_FILE}: could not read (${err.code ?? err.message}) — nothing says which kit ` +
        'migrations this app must hold, so nothing can be cleared. It rides /kit-upgrade with ' +
        'scripts/; adopt it alongside this checker.',
    };
  }
}

/**
 * The whole check over a repo root. `{ failures, matched, unforked, dir }` — failures empty means
 * green; `dir` is the migrations folder that was read.
 */
export function checkKitMigrations(root = ROOT) {
  const failures = [];
  const manifest = readManifest(root);
  if (manifest.error) {
    return { failures: [manifest.error], matched: [], unforked: false, dir: MIGRATIONS_DIR };
  }
  const { unforked, appName, dir } = readConfig(root, failures);
  const files = readMigrations(root, dir, failures);
  if (unforked) failures.push(...kitFailures(manifest, files, appName, dir));
  const app = appFailures(manifest, files, appName, dir);
  // In the kit, a pin that fails to match is already reported (changed or gone) by kitFailures, in
  // the kit's own terms; the app-side line for the same file would only repeat it as a copy task.
  if (!unforked) failures.push(...app.failures);
  return { failures, matched: app.matched, unforked, dir };
}

/**
 * --write: pin every kit migration not yet pinned; re-pin a changed one only when --repin names
 * it. A re-pin revokes every earlier hash of that file unless `keepPrior` — the old text is what a
 * fork that copied early must not keep. The kit only — an app never writes the kit's record of the
 * kit's migrations. Returns `{ code, out }`.
 */
export function writeManifest(root = ROOT, repin = [], { keepPrior = false } = {}) {
  const failures = [];
  const { unforked, appName, dir } = readConfig(root, failures);
  if (!unforked) {
    return {
      code: 2,
      out:
        `--write is for the kit itself. ${MANIFEST_FILE} is the kit's record of the kit's ` +
        'migrations and arrives with /kit-upgrade; an app never writes it. To clear a red here, ' +
        'copy the migrations it names.',
    };
  }
  if (failures.length) return { code: 1, out: failures.join('\n') };
  let existing = readManifest(root);
  if (existing.absent) {
    // The one case with no pins to protect: start from nothing. (After a NORMALISATION bump, this
    // is how every file is re-pinned — delete the manifest, then --write.)
    existing = { migrations: [] };
  } else if (existing.error) {
    return { code: 1, out: `nothing written: ${existing.error}` };
  }
  const files = readMigrations(root, dir, failures);
  if (failures.length) return { code: 1, out: failures.join('\n') };
  const pins = new Map(existing.migrations.map((pin) => [pin.file, pin]));
  const refused = [];
  const added = [];
  const repinned = [];
  for (const name of repin) {
    if (!pins.has(name)) refused.push(`--repin ${name}: not a pinned kit migration`);
  }
  for (const pin of pins.values()) {
    if (!(pin.file in files)) {
      refused.push(`${pin.file} is pinned but gone from ${dir}/ — restore it`);
    }
  }
  for (const name of Object.keys(files).sort()) {
    const sha256 = pinHash(name, files[name], appName);
    const pin = pins.get(name);
    if (sha256 === null) {
      refused.push(placeholderFailure(dir, name));
    } else if (!pin) {
      pins.set(name, { file: name, sha256, priorRevisions: [] });
      added.push(name);
    } else if (pin.sha256 !== sha256) {
      if (!repin.includes(name)) {
        refused.push(
          `${name} changed after it was pinned — a shipped kit migration is immutable. Re-pin ` +
            `only a file no fork can have applied: --repin ${name}`,
        );
        continue;
      }
      const prior = keepPrior
        ? [...new Set([...pin.priorRevisions, pin.sha256])].filter((h) => h !== sha256)
        : [];
      pins.set(name, { file: name, sha256, priorRevisions: prior });
      repinned.push(name);
    }
  }
  if (refused.length) return { code: 1, out: `nothing written:\n  ${refused.join('\n  ')}` };
  writeFileSync(join(root, MANIFEST_FILE), serialiseManifest([...pins.values()]));
  const lines = [
    ...added.map((name) => `pinned ${name}`),
    ...repinned.map(
      (name) =>
        `re-pinned ${name} (the old hash ${keepPrior ? 'stays accepted' : 'is no longer accepted'})`,
    ),
  ];
  return {
    code: 0,
    out: lines.length ? lines.join('\n') : `${MANIFEST_FILE}: every kit migration already pinned`,
  };
}

/** The CLI, as a function: `{ code, out }`. */
export function run(argv, root = ROOT) {
  const write = argv.includes('--write');
  const keepPrior = argv.includes('--keep-prior');
  const repin = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--repin') continue;
    const name = argv[i + 1];
    if (!name || name.startsWith('--')) return { code: 2, out: '--repin needs a file name' };
    repin.push(name);
  }
  if (repin.length && !write) return { code: 2, out: '--repin only makes sense with --write' };
  if (keepPrior && !repin.length) {
    return { code: 2, out: '--keep-prior only makes sense with --write --repin <file>' };
  }
  if (write) return writeManifest(root, repin, { keepPrior });

  const { failures, matched, unforked, dir } = checkKitMigrations(root);
  if (failures.length) {
    return {
      code: 1,
      out: [
        'Kit migration guard FAILED:\n',
        ...failures.map((f) => `  ✗ ${f}`),
        '',
        `Every kit migration must be present in ${dir}/ — under any number, with its`,
        "statements unedited — or the kit code that /kit-upgrade carried meets a schema that isn't",
        'there, in production, where CI never looked. Matched by content: comments and whitespace',
        'may differ. See migrations/d1/README.md and DECISIONS 2026-09-25.',
      ].join('\n'),
    };
  }
  const report = matched.map(({ kit, app }) =>
    kit === app ? `  ✓ ${kit}` : `  ✓ ${kit} → ${dir}/${app}`,
  );
  return {
    code: 0,
    out: [
      unforked
        ? `Kit migration guard passed: all ${matched.length} kit migration(s) pinned, every pin unchanged.`
        : `Kit migration guard passed: all ${matched.length} kit migration(s) present, matched by content.`,
      ...report,
    ].join('\n'),
  };
}

if (isMainModule(import.meta.url)) {
  const { code, out } = run(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
}
