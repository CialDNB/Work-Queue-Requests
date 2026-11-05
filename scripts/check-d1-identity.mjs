// D1 ownership preflight — refuses to migrate a database that belongs to a DIFFERENT app.
//
//   node scripts/check-d1-identity.mjs --env staging
//   node scripts/check-d1-identity.mjs --env production
//
// WHY THIS EXISTS. Every kit app shares ONE Cloudflare account, and a Cloudflare API
// token cannot be scoped to a single D1 database: the token policy model has exactly four
// resource types (`com.cloudflare.api.account`, `…account.zone`, `…api.user`,
// `com.cloudflare.edge.r2.bucket`). So every app's CI token carrying `D1: Edit` can write every
// D1 in the account. Cloudflare audit-logs only CreateDatabase / DeleteDatabase / TimeTravel —
// everything through `/d1/database/{id}/query` is unlogged, and there is no Logpush dataset for
// D1 — so a migration that lands on a sibling app's database leaves no trace on any Cloudflare
// surface. Detection is not available; only prevention is. See DECISIONS 2026-08-18.
//
// IT ASKS EVERY DECLARED d1 BINDING, not just `DB`. Checking only `DB` would leave the obvious
// bypass: declare a second d1 binding whose `database_name` looks like this app's — so the
// attributability gate, which compares NAMES, passes — while its `database_id` is a sibling's.
// The Worker reads that database at runtime and nothing would have looked at it.
//
// WHAT IT CATCHES THAT NOTHING ELSE DOES. The config-level guards all reason about NAMES:
// `wrangler d1` now addresses the database by its `DB` binding so the pinned `database_id` is the
// single source of truth, and check-edge-hardening asserts the resource names are this app's.
// Both are blind to the one failure that matters most — a `database_id` that is syntactically
// perfect and points at somebody else's database (a wholesale copy from a sibling app; a hand-
// edited id; a restored config from the wrong repo). The only party that knows which app owns a
// database is the database, so it says so, and this asks.
//
// THE ASYMMETRY IS DELIBERATE. Three outcomes, and they are not symmetric:
//   * identity present and NOT this app  → FAIL. Positive evidence of someone else's database.
//   * identity present and this app      → pass.
//   * identity absent (no table, no row) → pass ONLY IF a migration in this repo will stamp the
//     database as this app during the same run, and then SAYS the deploy is unguarded. This is
//     the one hole, and it is deliberate and bounded rather than justified: an unstamped
//     database is indistinguishable from a mis-pointed one, because EVERY database provisioned
//     before 2026-08-18 is unstamped too. Failing here outright would brick the next deploy of
//     every existing app, so instead migrations/d1/0000_kit_app_identity.sql stamps the
//     database moments later — the window is one deploy per environment, then the check has
//     teeth. That bound is only real if the migration is actually here and seeds THIS app's
//     name, so both are verified (findStampingMigration): no stamping migration → FAIL, because
//     "unguarded this once" would be "unguarded forever" — which is how a fork that adopted
//     scripts/ + .github/ through /kit-upgrade but not the migration (migrations/ is not in the
//     upgrade diff set) finds out, with the remedy in the message; a migration seeding some
//     OTHER name → FAIL before it lands, because the stamp is immutable. Do not "simplify" any
//     of this into a quiet pass; the message is the mitigation.
//   * anything else (auth, network, malformed, unrecognized envelope) → FAIL. We cannot tell
//     whose database this is and the next step writes DDL to it. Same fail-closed-on-unknown
//     rule as verify:deps — which is also why parseIdentity throws on an envelope it does not
//     recognize instead of reporting "no rows".
//
// WHAT IT DOES NOT DO. It is not an authorization control — a token holder can read the row and
// nothing stops them writing anyway. It defends against MISCONFIGURATION (the likely event), not
// against an attacker who wants a sibling's data (for which the only answer is a separate
// Cloudflare account — DECISIONS 2026-06-23). It also cannot run offline: it is a network
// preflight, so it lives here and in the deploy workflows, not in `npm run ci`.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './kit-checks/main-module.mjs';
import { parseJsonc } from './new-app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const IDENTITY_SQL = "SELECT value FROM app_identity WHERE key = 'app'";

export const ENV_CONFIG = {
  staging: 'wrangler.staging.jsonc',
  production: 'wrangler.jsonc',
};

/** Signals that mean "this database has never had schema.sql applied", not "unknown". */
const FRESH_DB_PATTERNS = [/no such table:?\s*app_identity/i, /no such table/i];

/**
 * The app name this config claims. `vars.APP_NAME` rather than the worker `name`, because the
 * staging worker is `<app>-staging` while its database identity is plain `<app>` — deriving by
 * stripping a suffix would silently mis-handle an app whose own name ends in `-staging`.
 */
export function expectedApp(cfg) {
  const name = cfg?.vars?.APP_NAME;
  if (typeof name !== 'string' || name.length === 0) return null;
  return name;
}

/**
 * Pull the identity value out of `wrangler d1 execute --json` output.
 *
 * Shape-tolerant across the envelopes wrangler has used (a bare array, `{ result: [...] }`) —
 * but tolerance stops at RECOGNITION. An envelope we do not recognize must NOT read as "zero
 * rows": that is a fail-OPEN, and a silent one, because the verdict maps zero rows to "this
 * database is unprovisioned, carry on". A future wrangler that renames the envelope would
 * disable this check permanently while printing a reassuring message. So an unrecognized shape
 * throws, exactly like unparseable output, and the caller turns it into a fail-closed.
 *
 * Returns a string, or null ONLY when a recognized envelope genuinely carried no rows.
 */
export function parseIdentity(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('wrangler --json output was not JSON');
  }
  const batches = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.result)
      ? parsed.result
      : Array.isArray(parsed?.results)
        ? parsed.results
        : null;
  if (batches === null) {
    throw new Error(
      'wrangler --json output had no recognizable result envelope (expected an array, ' +
        '`{result:[…]}` or `{results:[…]}`) — refusing to read that as "no rows"',
    );
  }
  for (const batch of batches) {
    const rows = batch?.results ?? batch?.rows;
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const row = rows[0];
    const value = typeof row === 'object' && row !== null ? row.value : row;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * The binding the deploy paths migrate. `db:migrate*` in package.json and both workflows pass `DB`
 * (pinned by test/platform/migrations.test.mjs), so `DB` is the one binding a stamping migration
 * reaches on its own; any other declared d1 binding is never migrated by a deploy.
 */
export const MIGRATED_BINDING = 'DB';

/** Wrangler's default when a d1 binding declares no `migrations_dir`. The kit pins `migrations/d1`. */
export const DEFAULT_MIGRATIONS_DIR = 'migrations';

/** The seed statement as schema.sql and the kit migration write it; group 1 is the app name. */
const STAMP_RE =
  /INSERT\s+OR\s+IGNORE\s+INTO\s+app_identity\s*\(\s*key\s*,\s*value\s*\)\s*VALUES\s*\(\s*'app'\s*,\s*'([^']*)'\s*\)/i;

/** The `migrations_dir` a config declares for one binding, or wrangler's default. Pure. */
export function migrationsDirFor(cfg, binding) {
  const entry = (cfg?.d1_databases ?? []).find((b) => b?.binding === binding);
  const dir = entry?.migrations_dir;
  return typeof dir === 'string' && dir.length > 0 ? dir : DEFAULT_MIGRATIONS_DIR;
}

/**
 * The migration that stamps `app_identity`, found by CONTENT rather than by filename — a fork may
 * renumber the kit's 0000 file into its own sequence, and a check keyed on the name would call a
 * present stamp absent. Files are visited in sorted order (wrangler's apply order), so the first
 * seed wins the way it would at apply time. Returns `{ file, app }`, or null when nothing under
 * `dir` seeds the row — including when `dir` cannot be listed, which the verdict reads as "no
 * stamp" and fails closed on.
 */
export function findStampingMigration(dir, { root = ROOT } = {}) {
  let names;
  try {
    names = readdirSync(join(root, dir))
      .filter((name) => /\.sql$/i.test(name))
      .sort();
  } catch {
    return null;
  }
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(root, dir, name), 'utf8');
    } catch {
      continue;
    }
    const seeded = text.match(STAMP_RE);
    if (seeded) return { file: `${dir}/${name}`, app: seeded[1] };
  }
  return null;
}

/**
 * The verdict for a database that carries no identity — the one case that can pass without
 * proving ownership, and it may do so ONLY when "the next deploy is guarded" is a promise this
 * repo can keep. Four sub-cases:
 *   * the migrated binding, and a local migration seeds THIS app → pass, loudly. `db:migrate`
 *     applies that file moments later, so the window really is one deploy per environment.
 *   * the migrated binding, and NO local migration seeds the row → FAIL. Nothing would ever stamp
 *     the database, so "unguarded this once" is "unguarded forever" — the permanent fail-open on
 *     exactly the databases the backstop exists for. The remedy (the kit migration, copied by
 *     hand because migrations/ is outside the /kit-upgrade diff set) is in the message.
 *   * the migrated binding, and the migration seeds ANOTHER name (a residual template literal, a
 *     typo) → FAIL before it lands. The stamp is immutable; letting it through would block every
 *     later deploy of this app on its own database (docs/runbooks/d1-rehome.md is the way back).
 *   * any other binding → pass, loudly, and say that nothing stamps it automatically: the deploy
 *     paths migrate only `DB`, so closing that window is a one-off by hand.
 * Failing here outright instead would brick the first deploy of every app that predates the
 * backstop, which is why the window exists at all. See DECISIONS 2026-08-18.
 */
function unguardedVerdict({ app, env, reason, binding, stamp, migrationsDir }) {
  const cfgFile = ENV_CONFIG[env];
  const unchecked = `${env}: ${reason} — THIS DEPLOY IS NOT OWNERSHIP-CHECKED`;
  if (binding !== MIGRATED_BINDING) {
    const cfgFlag = env === 'staging' ? ` --config ${cfgFile}` : '';
    return {
      failed: false,
      message:
        `${unchecked} for binding ${binding}, and nothing stamps it automatically (the deploy\n` +
        `  paths migrate only ${MIGRATED_BINDING}). Confirm its database_id in ${cfgFile} is yours, then\n` +
        `  stamp it once by hand — npx wrangler d1 execute ${binding} --remote --file <the\n` +
        `  app_identity migration>${cfgFlag} — and every deploy after that is checked.`,
    };
  }
  if (!stamp) {
    return {
      failed: true,
      message:
        `${env}: ${reason}, and nothing under ${migrationsDir}/ stamps it — refusing to run\n` +
        `  unguarded, because nothing ever would: every deploy would stay unchecked, not just this\n` +
        `  one. Adopt the kit's migrations/d1/0000_kit_app_identity.sql (it is NOT in the\n` +
        `  /kit-upgrade diff set — copy it by hand, keep the 0000 number, set the seeded value to\n` +
        `  "${app}", your vars.APP_NAME), commit, and redeploy. See CHANGELOG / DECISIONS 2026-08-18.`,
    };
  }
  if (stamp.app !== app) {
    return {
      failed: true,
      message:
        `${env}: ${reason}, and ${stamp.file} would stamp it as "${stamp.app}", not "${app}" —\n` +
        `  refusing before that lands. The stamp is immutable, so a wrong one blocks every later\n` +
        `  deploy of this app on its own database. Set the seeded value to "${app}" (vars.APP_NAME)\n` +
        `  and redeploy.`,
    };
  }
  const apply = env === 'staging' ? 'db:apply:staging' : 'db:apply';
  return {
    failed: false,
    message:
      `${unchecked}.\n` +
      `  ${stamp.file} stamps the database during this same run, so the next deploy is\n` +
      `  guarded. To close the window now instead, run \`npm run ${apply}\` (idempotent) and\n` +
      `  re-run. If this app is NOT new, confirm the database_id in ${cfgFile} is yours\n` +
      `  before proceeding — an unstamped database is exactly what a mis-pointed id looks like.`,
  };
}

/**
 * The whole decision, as a pure function so the asymmetry above is testable without a network.
 * `probe` is `{ ok: true, stdout }` or `{ ok: false, stderr }`; `stamp` is what
 * findStampingMigration found under `migrationsDir` (null = nothing stamps the row), and both
 * only matter on the absent-identity path for the migrated binding.
 */
export function identityVerdict({
  app,
  env,
  probe,
  binding = MIGRATED_BINDING,
  stamp = null,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
}) {
  const unguarded = (reason) =>
    unguardedVerdict({ app, env, reason, binding, stamp, migrationsDir });
  if (!app) {
    return {
      failed: true,
      message: `${env}: config has no vars.APP_NAME — cannot tell which app owns this database`,
    };
  }
  if (!probe.ok) {
    const stderr = probe.stderr ?? '';
    if (FRESH_DB_PATTERNS.some((re) => re.test(stderr))) {
      return unguarded('no app_identity table yet');
    }
    return {
      failed: true,
      message: `${env}: could not read app_identity — refusing to migrate a database whose owner is unknown.\n${stderr.trim()}`,
    };
  }
  let found;
  try {
    found = parseIdentity(probe.stdout);
  } catch (err) {
    return {
      failed: true,
      message: `${env}: ${err.message} — refusing to migrate a database whose owner is unknown.`,
    };
  }
  if (found === null) {
    return unguarded('app_identity carries no app row');
  }
  if (found !== app) {
    return {
      failed: true,
      message:
        `${env}: THIS DATABASE BELONGS TO "${found}", NOT "${app}".\n` +
        `  Migrating it would run DDL against ${found}'s live data, and Cloudflare logs nothing for\n` +
        `  D1 queries — nobody would see it. Two explanations, and only a human can tell which:\n` +
        `  (a) database_id in ${ENV_CONFIG[env]} points at ${found}'s D1 — fix it (docs/RESOURCES.md\n` +
        `      has this app's ids) or re-run provisioning;\n` +
        `  (b) the id is right and this IS your database, but ${found}'s config is mis-pointed at\n` +
        `      it and their first (unguarded) deploy stamped it — fix ${found}'s config first, then\n` +
        `      re-home the database per docs/runbooks/d1-rehome.md (a deliberate human act).\n` +
        `  Do NOT work around this check.`,
    };
  }
  return { failed: false, message: `${env}: ok — database identity is "${app}"` };
}

/**
 * Every d1 binding the config declares, not just `DB`.
 *
 * Checking only `DB` left the obvious way around this whole check: declare a SECOND d1 binding
 * whose `database_name` looks like this app's (so the attributability gate passes, since it
 * compares names) but whose `database_id` is a sibling's. The Worker then reads that database at
 * runtime and no preflight ever looked at it. That path matters most where humans reach
 * Cloudflare only through the repo — a config edit in a PR is the whole attack surface, and CI
 * runs it with an account-wide token. Every declared binding gets asked.
 */
export function declaredD1Bindings(cfg) {
  const bindings = (cfg?.d1_databases ?? []).map((b) => b?.binding).filter(Boolean);
  return bindings.length > 0 ? bindings : ['DB'];
}

/** Runs the query for ONE binding. Separated from the verdict so the verdict stays pure. */
export function probeIdentity(env, { root = ROOT, run = execFileSync, binding = 'DB' } = {}) {
  const args = [
    'wrangler',
    'd1',
    'execute',
    binding,
    '--remote',
    '--json',
    '--command',
    IDENTITY_SQL,
  ];
  if (env === 'staging') args.push('--config', ENV_CONFIG.staging);
  try {
    const stdout = run('npx', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      stderr: `${err?.stderr ?? ''}${err?.stdout ?? ''}` || String(err?.message ?? err),
    };
  }
}

function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--env');
  const env = idx === -1 ? null : args[idx + 1];
  if (!Object.hasOwn(ENV_CONFIG, env ?? '')) {
    process.stderr.write('usage: node scripts/check-d1-identity.mjs --env staging|production\n');
    process.exit(1);
  }
  let cfg = null;
  try {
    cfg = parseJsonc(readFileSync(join(ROOT, ENV_CONFIG[env]), 'utf8'));
  } catch (err) {
    process.stderr.write(
      `D1 identity preflight FAILED — could not read ${ENV_CONFIG[env]}: ${err.message}\n`,
    );
    process.exit(1);
  }
  const app = expectedApp(cfg);
  // Resolved once: the stamping migration lives in the MIGRATED binding's migrations_dir, and
  // the verdict only consults it for that binding.
  const migrationsDir = migrationsDirFor(cfg, MIGRATED_BINDING);
  const stamp = findStampingMigration(migrationsDir);
  const results = declaredD1Bindings(cfg).map((binding) => ({
    binding,
    ...identityVerdict({
      app,
      env,
      binding,
      stamp,
      migrationsDir,
      probe: probeIdentity(env, { binding }),
    }),
  }));
  const failed = results.some((r) => r.failed);
  const message = results.map((r) => `[${r.binding}] ${r.message}`).join('\n  ');
  process.stdout.write(
    `${failed ? 'D1 identity preflight FAILED\n  ' : 'D1 identity preflight — '}${message}\n`,
  );
  if (failed) process.exit(1);
}

if (isMainModule(import.meta.url)) main();
