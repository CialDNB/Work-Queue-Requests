#!/usr/bin/env node
// The draft registration a DB Israel app sends the platform owner: its central catalog entry,
// `catalog/apps/<app>.json` in CialDNB/il-paved-road-deployment (schema ilpr.app/v1), plus the
// decisions the owner has to make in plain language. It prints and writes nothing: the catalog PR
// is the platform's, and central's own checks (`npm run check` there) decide what it accepts.
//
//   npm run central:proposal [-- --repository CialDNB/<repo>] [--repository-id <n>] [--root <dir>]
//
// The draft is read live from the app's own files (wrangler.staging.jsonc, package.json,
// schema.sql), so it follows the app as it changes. Its variables are the staging config's, with
// the DB Israel values the vocabulary in src/platform/runtimeConfig.mjs computes (the app name, the
// stage, `<app>.staging.dbisrael.ai`, central's placeholder sender), and without the CIAL ones:
// CF_ACCOUNT_ID, AI_GATEWAY_ID and the other AI variables (unless the platform approves AI), and
// ALERT_EMAIL. Central reads the Worker's variables back exactly, so the list is the whole set; the
// decisions name each one the code reads that the config does not set. A variable that is a secret,
// by central's name pattern or by the vocabulary's kind, moves to optional_runtime_secrets, and its
// value is never printed: the catalog entry is committed to the central repository.
//
// proposalProblems() is a MIRROR of the rules central's parseApp() (src/delivery/catalog.ts, as of
// f7eba76) applies to an app entry: unknown keys, name and path shapes, the gateway-guarded AI
// key, binding collisions, the five-schedule cap, the canonical staging hostname, secret-looking
// variables. It is not the rule. The CLI runs it on its own draft and prints what it finds.
//
// Node built-ins, scripts/new-app.mjs and scripts/deployment-target.mjs only. A kit self-reference
// (SELF_REFERENCE_FILES in src/platform/bootstrap.ts): it names the central repository, and the
// bootstrap renames none of it. Exported functions are pinned by
// test/platform/central-proposal.test.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RUNTIME_SETTINGS } from '../src/platform/runtimeConfig.mjs';
import { resolveDeploymentTarget } from './deployment-target.mjs';
import { isMainModule } from './kit-checks/main-module.mjs';
import { parseJsonc } from './new-app.mjs';

export const SCHEMA = 'ilpr.app/v1';
export const ORGANIZATION = 'CialDNB';
export const ZONE = 'dbisrael.ai';
export const STAGING_SUFFIX = `staging.${ZONE}`;
export const PLACEHOLDER_SENDER = 'auth@invalid.example';
export const MAX_SCHEDULES = 5;
// Both enrolled apps use these. `fail` passes only an `ok` health document, and a new app's staging
// `/_health` is degraded until its first daily run, so the decisions flag it.
export const DEFAULT_CHECKS = Object.freeze({
  ingress: 'waf-restricted',
  health_path: '/_health',
  protected_path: '/api/me',
  degraded_health: 'fail',
});

/** `<app>.staging.dbisrael.ai`, the only staging hostname central grants an app. */
export const stagingHost = (app) => `${app}.${STAGING_SUFFIX}`;

// ── the mirror of central's app-entry rules (parseApp, src/delivery/catalog.ts) ─────────────────
const APP_NAME = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const SLUG = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const BINDING = /^[A-Z][A-Z0-9_]{0,62}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const DATE = /^20[0-9]{2}-[01][0-9]-[0-3][0-9]$/;
const REL_PATH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const ROUTE = /^\/[A-Za-z0-9._~*/-]{0,99}$/;
const SCRIPT = /^[a-z][a-z0-9:_-]{0,39}$/;
const FLAG = /^[a-z0-9_]{1,60}$/;
const CRON = /^[0-9A-Za-z*/,?#LW-]+( [0-9A-Za-z*/,?#LW-]+){4}$/;
const HEX32 = /^[0-9a-f]{32}$/;
/** A variable name central refuses as a variable: catalogs hold secret names only. */
export const SECRET_LIKE = /(TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|CREDENTIAL)/;
const RESOURCE_KINDS = ['d1', 'kv', 'r2'];
const STAGES = ['staging', 'production'];
// A provider key whose client calls the provider directly without its gateway.
const GATEWAY_GUARDED = {
  ANTHROPIC_API_KEY: { secret: 'AI_GATEWAY_TOKEN', variable: 'AI_GATEWAY_ID' },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Why central would refuse this app entry, approximately; [] for none. A mirror, not the rule. */
export function proposalProblems(p) {
  const problems = [];
  const fail = (m) => problems.push(m);
  const keys = (o, allowed, what) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${what}: unknown key "${k}"`);
  };
  const str = (o, k, what, re) => {
    const v = o?.[k];
    if (typeof v !== 'string' || v === '') fail(`${what}.${k} must be a nonempty string`);
    else if (re && !re.test(v)) fail(`${what}.${k} is malformed`);
    return typeof v === 'string' ? v : '';
  };
  const object = (v, what) => {
    if (isObject(v)) return v;
    fail(`${what} must be an object`);
    return {};
  };
  const list = (v, what, re) => {
    if (!Array.isArray(v)) {
      fail(`${what} must be an array`);
      return [];
    }
    for (const x of v)
      if (typeof x !== 'string' || !re.test(x)) fail(`${what} has a malformed entry`);
    if (new Set(v).size !== v.length) fail(`${what} has duplicates`);
    return v.filter((x) => typeof x === 'string');
  };
  if (!isObject(p)) return ['app must be an object'];
  keys(
    p,
    [
      'schema',
      'app',
      'repository',
      'build',
      'database',
      'capabilities',
      'runtime_secrets',
      'optional_runtime_secrets',
      'schedules',
      'checks',
      'stages',
    ],
    'app',
  );
  if (p.schema !== SCHEMA) fail('app: unsupported schema');
  const name = str(p, 'app', 'app', APP_NAME);
  const w = `app ${name}`;

  const r = object(p.repository, `${w}.repository`);
  keys(r, ['id', 'slug', 'branch'], `${w}.repository`);
  if (!Number.isSafeInteger(r.id) || r.id <= 0) {
    fail(`${w}.repository.id must be a positive integer (the repository's numeric id)`);
  }
  if (str(r, 'slug', `${w}.repository`, SLUG) && !String(r.slug).startsWith(`${ORGANIZATION}/`)) {
    fail(`${w}: repository is outside the organization`);
  }
  str(r, 'branch', `${w}.repository`, BRANCH);

  const b = object(p.build, `${w}.build`);
  keys(
    b,
    [
      'profile',
      'script',
      'main',
      'assets_directory',
      'compatibility_date',
      'compatibility_flags',
      'not_found_handling',
      'run_worker_first',
    ],
    `${w}.build`,
  );
  if (b.profile !== 'worker-assets/v1') fail(`${w}.build.profile is not a supported profile`);
  str(b, 'script', `${w}.build`, SCRIPT);
  const mainPath = str(b, 'main', `${w}.build`, REL_PATH);
  const assets = str(b, 'assets_directory', `${w}.build`, REL_PATH);
  str(b, 'compatibility_date', `${w}.build`, DATE);
  list(b.compatibility_flags, `${w}.build.compatibility_flags`, FLAG);
  str(b, 'not_found_handling', `${w}.build`, /^(single-page-application|404-page|none)$/);
  list(b.run_worker_first, `${w}.build.run_worker_first`, ROUTE);
  for (const path of [mainPath, assets]) {
    if (path.split('/').some((s) => s === '..' || s === '.'))
      fail(`${w}.build: dot segment in a path`);
  }

  if (p.database !== null) {
    const d = object(p.database, `${w}.database`);
    keys(d, ['migrations_directory', 'baseline'], `${w}.database`);
    str(d, 'migrations_directory', `${w}.database`, REL_PATH);
    if (d.baseline !== null) str(d, 'baseline', `${w}.database`, REL_PATH);
  }

  const cap = object(p.capabilities, `${w}.capabilities`);
  keys(cap, RESOURCE_KINDS, `${w}.capabilities`);
  const capabilities = Object.fromEntries(
    RESOURCE_KINDS.map((k) => {
      const entries = cap[k] ?? [];
      if (!Array.isArray(entries)) {
        fail(`${w}.capabilities.${k} must be an array`);
        return [k, []];
      }
      return [
        k,
        entries.map((e, i) => {
          const at = `${w}.capabilities.${k}[${i}]`;
          if (!isObject(e)) {
            fail(`${at} must be an object`);
            return '';
          }
          keys(e, ['binding'], at);
          return str(e, 'binding', at, BINDING);
        }),
      ];
    }),
  );
  const runtime = list(p.runtime_secrets, `${w}.runtime_secrets`, BINDING);
  const optional = list(p.optional_runtime_secrets ?? [], `${w}.optional_runtime_secrets`, BINDING);
  for (const [k, g] of Object.entries(GATEWAY_GUARDED)) {
    if (optional.includes(k)) {
      fail(
        `${w}: ${k} cannot be optional; declare it as a required runtime secret with ${g.secret}`,
      );
    }
    if (runtime.includes(k) && !runtime.includes(g.secret)) {
      fail(`${w}: ${k} requires ${g.secret} as a required runtime secret`);
    }
  }
  const schedules = list(p.schedules ?? [], `${w}.schedules`, CRON);
  if (schedules.length > MAX_SCHEDULES)
    fail(`${w}.schedules: at most ${MAX_SCHEDULES} cron triggers`);
  const bindings = [
    ...RESOURCE_KINDS.flatMap((k) => capabilities[k]),
    'ASSETS',
    ...runtime,
    ...optional,
  ];
  if (new Set(bindings).size !== bindings.length)
    fail(`${w}: binding names collide (ASSETS is reserved)`);
  if (capabilities.d1.length > 0 && p.database === null)
    fail(`${w}: a D1 capability needs a database declaration`);
  if (p.database !== null && capabilities.d1.length !== 1) {
    fail(`${w}: migrations are supported for exactly one D1 database`);
  }

  const ch = object(p.checks, `${w}.checks`);
  keys(ch, ['ingress', 'health_path', 'protected_path', 'degraded_health'], `${w}.checks`);
  str(ch, 'ingress', `${w}.checks`, /^(waf-restricted|public)$/);
  str(ch, 'health_path', `${w}.checks`, ROUTE);
  if (ch.protected_path !== null) str(ch, 'protected_path', `${w}.checks`, ROUTE);
  if (ch.degraded_health !== undefined)
    str(ch, 'degraded_health', `${w}.checks`, /^(fail|accept)$/);

  const st = object(p.stages, `${w}.stages`);
  keys(st, STAGES, `${w}.stages`);
  const enabled = {};
  for (const s of STAGES) {
    const x = object(st[s], `${w}.stages.${s}`);
    keys(x, ['enabled', 'hostnames', 'vars', 'email'], `${w}.stages.${s}`);
    if (typeof x.enabled !== 'boolean') fail(`${w}.stages.${s}.enabled must be boolean`);
    enabled[s] = x.enabled === true;
    const hostnames = list(x.hostnames, `${w}.stages.${s}.hostnames`, HOST);
    for (const h of hostnames) {
      if (h !== ZONE && !h.endsWith(`.${ZONE}`))
        fail(`${w}.stages.${s}: hostname ${h} is outside ${ZONE}`);
    }
    if (s === 'staging' && hostnames.some((h) => h !== stagingHost(name))) {
      fail(`${w}: the staging hostname must be the canonical ${stagingHost(name)}`);
    }
    if (s === 'production' && hostnames.some((h) => h.endsWith(`.${STAGING_SUFFIX}`))) {
      fail(`${w}: a production hostname is under the staging suffix`);
    }
    const vars = object(x.vars, `${w}.stages.${s}.vars`);
    for (const [k, v] of Object.entries(vars)) {
      if (!BINDING.test(k) || typeof v !== 'string' || v.length > 500) {
        fail(`${w}.stages.${s}.vars.${k} must be a short string`);
      }
      if (SECRET_LIKE.test(k)) {
        fail(`${w}.stages.${s}.vars.${k} looks like a secret: catalogs hold names only`);
      }
      if (bindings.includes(k)) fail(`${w}.stages.${s}.vars.${k} collides with a binding`);
    }
    // Central requires the platform's own account here; the kit only knows its shape.
    if (vars.CF_ACCOUNT_ID !== undefined && !HEX32.test(String(vars.CF_ACCOUNT_ID))) {
      fail(`${w}.stages.${s}.vars.CF_ACCOUNT_ID must be the platform account id`);
    }
    if (x.enabled === true) {
      for (const [k, g] of Object.entries(GATEWAY_GUARDED)) {
        if (runtime.includes(k) && String(vars[g.variable] ?? '').trim() === '') {
          fail(`${w}.stages.${s}: ${k} requires a non-empty ${g.variable} variable`);
        }
        if (runtime.includes(k) && vars.CF_ACCOUNT_ID === undefined) {
          fail(`${w}.stages.${s}: ${k} requires CF_ACCOUNT_ID (the gateway's account)`);
        }
      }
    }
    if (x.enabled === true && hostnames.length === 0 && s === 'production') {
      fail(`${w}: production needs an explicit hostname grant`);
    }
  }
  if (!enabled.staging && enabled.production) fail(`${w}: production requires staging`);
  return problems;
}

// ── the draft ─────────────────────────────────────────────────────────────────────────────────
const SETTINGS = new Map(RUNTIME_SETTINGS.map((s) => [s.name, s]));
const COMPUTED = {
  'app-name': (app) => app,
  stage: () => 'staging',
  'staging-host': (app) => stagingHost(app),
  'placeholder-sender': () => PLACEHOLDER_SENDER,
};
// Keys a central release never emits, so a value there does nothing for a DB Israel app.
const UNSUPPORTED = ['placement', 'routes', 'secrets_store_secrets', 'send_email'];

function readConfig(root, file) {
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    throw new Error(`${file} is missing: the draft is read from it.`);
  }
  const config = parseJsonc(text);
  if (!config) throw new Error(`${file} is not valid JSONC.`);
  return config;
}

const bindingsOf = (entries) =>
  (Array.isArray(entries) ? entries : [])
    .map((e) => e?.binding)
    .filter((b) => typeof b === 'string');

/**
 * The draft for the app at `root`: { proposal, decisions, fill }. `decisions` are the owner's, in
 * plain language; `fill` is what the draft still needs from the identity block. Throws when the
 * app's staging config cannot be read.
 */
export function buildProposal({ root = '.', repository, repositoryId } = {}) {
  const staging = readConfig(root, 'wrangler.staging.jsonc');
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    // reported below, as the missing build script
  }
  const configVars = isObject(staging.vars) ? staging.vars : {};
  const app = String(configVars.APP_NAME ?? '');
  const decisions = [];
  const fill = [];
  const slug = repository ?? `${ORGANIZATION}/${app}`;
  if (repositoryId === undefined) {
    fill.push(
      `repository.id: the repository's numeric id, once it exists (gh api repos/${slug} --jq .id); the draft holds 0, which central refuses. Pass it with --repository-id, and --repository if the repository is not ${slug}.`,
    );
  }

  const assets = isObject(staging.assets) ? staging.assets : {};
  const d1 = Array.isArray(staging.d1_databases) ? staging.d1_databases : [];
  const r2 = bindingsOf(staging.r2_buckets);
  const crons = Array.isArray(staging.triggers?.crons) ? staging.triggers.crons : [];

  // The staging variables: the config's, with the computed DB Israel values, without the omitted.
  const vars = {};
  const secretLike = [];
  const unknown = [];
  for (const [name, value] of Object.entries(configVars)) {
    const setting = SETTINGS.get(name);
    // A secret by its name (central's pattern) or by the vocabulary (ALERT_WEBHOOK_URL and
    // SEAL_KEY match no pattern, and src/env.ts reads both as secrets): its value is never
    // proposed, since the catalog is committed to the central repository.
    if (SECRET_LIKE.test(name) || setting?.kind === 'secret') {
      secretLike.push(name);
      continue;
    }
    if (setting?.israel === 'omit') continue;
    if (!setting) unknown.push(name);
    vars[name] =
      setting && COMPUTED[setting.israel] ? COMPUTED[setting.israel](app) : String(value);
  }
  for (const setting of RUNTIME_SETTINGS) {
    if (setting.kind === 'var' && COMPUTED[setting.israel] && !(setting.name in vars)) {
      vars[setting.name] = COMPUTED[setting.israel](app);
    }
  }
  const unset = RUNTIME_SETTINGS.filter(
    (s) => s.kind === 'var' && s.israel === 'default' && !(s.name in vars),
  ).map((s) => (s.note ? `${s.name} (${s.note})` : s.name));

  const proposal = {
    schema: SCHEMA,
    app,
    repository: { id: repositoryId ?? 0, slug, branch: 'main' },
    build: {
      profile: 'worker-assets/v1',
      script: 'build:web',
      main: String(staging.main ?? ''),
      assets_directory: String(assets.directory ?? '').replace(/^\.\//, ''),
      compatibility_date: String(staging.compatibility_date ?? ''),
      compatibility_flags: Array.isArray(staging.compatibility_flags)
        ? staging.compatibility_flags
        : [],
      not_found_handling: String(assets.not_found_handling ?? 'none'),
      run_worker_first: Array.isArray(assets.run_worker_first) ? assets.run_worker_first : [],
    },
    database:
      d1.length === 0
        ? null
        : {
            migrations_directory: String(d1[0]?.migrations_dir ?? 'migrations'),
            baseline: existsSync(join(root, 'schema.sql')) ? 'schema.sql' : null,
          },
    capabilities: {
      d1: bindingsOf(d1).map((binding) => ({ binding })),
      kv: bindingsOf(staging.kv_namespaces).map((binding) => ({ binding })),
      r2: r2.filter((b) => b !== 'BACKUPS').map((binding) => ({ binding })),
    },
    runtime_secrets: [],
    optional_runtime_secrets: secretLike,
    schedules: crons,
    checks: { ...DEFAULT_CHECKS },
    stages: {
      staging: { enabled: true, hostnames: [stagingHost(app)], vars },
      production: { enabled: false, hostnames: [], vars: {} },
    },
  };

  const host = stagingHost(app);
  if (typeof pkg?.scripts?.['build:web'] !== 'string') {
    decisions.push(
      'Build: package.json has no "build:web" script, which central runs to build the app.',
    );
  }
  decisions.push(
    `Sign-in: central sends no mail yet (ILOPS-8950), so magic links do not arrive. Microsoft sign-in (Entra) needs ENTRA_CLIENT_ID and ENTRA_ALLOWED_TENANTS in the staging vars (ENTRA_EMAIL_DOMAINS to steer users to it), ENTRA_CLIENT_SECRET as a required runtime secret, and the redirect URI https://${host}/auth/oidc/callback on the app registration. A platform operator seeds the first owner with seed-owner.`,
    'AI: off unless the platform approves it (ILOPS-8949). The draft leaves out CF_ACCOUNT_ID, AI_GATEWAY_ID and the other AI_* variables. With AI on, add ANTHROPIC_API_KEY and AI_GATEWAY_TOKEN to runtime_secrets, a non-empty AI_GATEWAY_ID and the platform CF_ACCOUNT_ID to the staging vars, and the model and budget variables.',
    'Email alerts: none until ILOPS-8950, so ALERT_EMAIL is left out. Production /_health stays degraded without the EMAIL binding: decide before production whether to wait for ILOPS-8950.',
  );
  if (crons.length > MAX_SCHEDULES) {
    decisions.push(
      `Schedules: the config has ${crons.length} schedules; central allows at most 5, the same on every stage. Choose which to keep.`,
    );
  } else {
    decisions.push(
      `Schedules: ${crons.length ? crons.join(', ') : 'none'}, from the staging config. Central allows at most 5, the same on every stage; confirm these are the ones to keep.`,
    );
  }
  decisions.push(
    `Backups: the R2 BACKUPS bucket is left out${r2.includes('BACKUPS') ? '' : ' (the config has none)'}. Either add { "binding": "BACKUPS" } to capabilities.r2, or rely on D1 Time Travel (ILOPS-8891).`,
    "Optional Worker secrets, each declared in optional_runtime_secrets only for a feature the owner turns on: ALERT_WEBHOOK_URL (a Slack alert channel), TURNSTILE_SECRET (with TURNSTILE_SITE_KEY), REGISTRY_TOKEN. The registry token reports this app to the CIAL fleet registry, a data flow out of DB Israel, and a dual-delivered app's two deployments overwrite each other there (ILOPS-8968). An undeclared Worker secret fails the release's read-back.",
  );
  const dropped = UNSUPPORTED.filter((k) => staging[k] !== undefined);
  decisions.push(
    `Unsupported, so dropped: placement, routes, Secrets Store bindings and send_email${dropped.length ? ` (the staging config has ${dropped.join(', ')})` : ''}. Central owns the hostnames.`,
    `Ingress and health: the draft uses ingress "waf-restricted" with degraded_health "fail", as both enrolled apps do. A "public" app with "fail" fails its first staging release, because staging /_health is degraded until the first daily run: use "accept" until then.`,
    "Workers invocation logs: central's generated Worker config does not set logs.invocation_logs to false, which the kit requires (PIA C5). Request URLs, such as /api/users/<address> and the OIDC callback's query string, would be logged. That needs a central change or a recorded PIA decision.",
  );
  if (unset.length > 0) {
    decisions.push(
      `Variables the code reads that the config does not set, so the code's default applies: ${unset.join(', ')}. Add any the app needs to the staging vars.`,
    );
  }
  if (secretLike.length > 0) {
    decisions.push(
      `Moved to optional_runtime_secrets, values left out, because each is a secret by central's name pattern or by the kit's vocabulary: ${secretLike.join(', ')}. Its value becomes a Worker secret that the platform sets; make it required if the app cannot run without it.`,
    );
  }
  if (unknown.length > 0) {
    decisions.push(
      `Not in the kit's runtime vocabulary (src/platform/runtimeConfig.mjs), kept as they are: ${unknown.join(', ')}. Keep each only if the app reads it.`,
    );
  }
  return { proposal, decisions, fill };
}

/** What the CLI prints for `result`. */
export function formatProposal({ proposal, decisions, fill }) {
  const lines = [
    `Draft catalog entry, catalog/apps/${proposal.app}.json (${SCHEMA}). This writes nothing: the platform owner opens the catalog PR.`,
    JSON.stringify(proposal, null, 2),
    '',
  ];
  if (fill.length > 0) lines.push('To fill in:', ...fill.map((f) => `  - ${f}`), '');
  lines.push('Decisions for the owner:', ...decisions.map((d) => `  - ${d}`), '');
  const problems = proposalProblems(proposal);
  lines.push(
    problems.length === 0
      ? "The kit's mirror of the catalog rules finds nothing; central's own checks decide."
      : `The kit's mirror of the catalog rules finds:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  return `${lines.join('\n')}\n`;
}

const USAGE = `Usage:
  node scripts/central-proposal.mjs [--repository CialDNB/<repo>] [--repository-id <n>] [--root <dir>]`;

/** The parsed command line, or { usage } with what is wrong with it. */
export function parseArgs(argv) {
  const opts = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    if (!['--repository', '--repository-id', '--root'].includes(flag)) {
      return { usage: `unknown argument ${JSON.stringify(arg)}` };
    }
    if (seen.has(flag)) return { usage: `${flag} is given twice` };
    seen.add(flag);
    const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
      return { usage: `${flag} needs a value` };
    }
    if (flag === '--repository') {
      if (!SLUG.test(value) || !value.startsWith(`${ORGANIZATION}/`)) {
        return { usage: `--repository must be ${ORGANIZATION}/<repo> (got ${value})` };
      }
      opts.repository = value;
    } else if (flag === '--repository-id') {
      if (!/^[1-9][0-9]{0,15}$/.test(value)) {
        return { usage: `--repository-id must be a positive integer (got ${value})` };
      }
      opts.repositoryId = Number(value);
    } else opts.root = value;
  }
  return { opts };
}

/** Runs the CLI; returns the exit code. */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.usage) {
    console.error(`${parsed.usage}\n${USAGE}`);
    return 1;
  }
  const root = resolve(parsed.opts.root ?? '.');
  const target = resolveDeploymentTarget({ root, env: {} });
  if (target.target !== 'dbisrael') {
    console.error(
      `Note: this tree is not a DB Israel app (${target.error ?? `its deployment target is ${target.target}`}). The draft is for a DB Israel registration only.`,
    );
  }
  let result;
  try {
    result = buildProposal({ ...parsed.opts, root });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  process.stdout.write(formatProposal(result));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
