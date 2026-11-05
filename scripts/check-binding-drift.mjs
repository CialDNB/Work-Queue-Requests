// Binding-drift check — does the DEPLOYED Worker still bind what this repo declares?
//
//   node scripts/check-binding-drift.mjs --env staging
//   node scripts/check-binding-drift.mjs --env production
//
// THE ONE DETECTIVE CONTROL AVAILABLE IN THIS SPACE. The rest of the cross-app work
// (DECISIONS 2026-08-18) is preventive because Cloudflare gives us nothing to detect with:
// D1 audit-logs exactly CreateDatabase / DeleteDatabase / TimeTravel, so every query and every
// migration is unlogged, and there is no D1 Logpush dataset. Worker *settings*, however, ARE
// readable — `GET /accounts/{id}/workers/scripts/{name}/settings` returns the live `bindings`
// array with its target ids. So the one question we can actually answer after the fact is
// "is this Worker still wired to the resources the repo says?"
//
// WHY THAT QUESTION MATTERS. `Workers Scripts: Edit` is an account-wide permission with no
// per-script scope, and **a deployment does not delete secrets**: re-uploading a Worker's code
// preserves its `secret_text` and its bindings, and the redeployed script reads them at runtime.
// So any app's CI token can replace any Worker in the shared account and inherit everything it
// could reach. Preventing that needs a separate Cloudflare account (DECISIONS 2026-06-23);
// noticing it needs this. RETARGETED is the finding that matters most — a binding keeping its
// name while its target id changes is what a quiet repoint looks like.
//
// SCOPED TO RESOURCE BINDINGS ON PURPOSE. The live `bindings` array also carries vars,
// secrets, assets, send_email and AI bindings, which come from places other than the config's
// binding arrays — comparing those would produce a false red on every run, and a check the
// fleet learns to ignore is worse than no check. Only the types below are compared. An attacker
// or a mistake ADDING a d1/kv/r2 binding is still caught, because those types are in scope.
//
// Runs daily from .github/workflows/edge-live.yml, alongside the edge-drift check that shares
// its schedule, token and alerting. Not in `npm run ci`: it needs a network and a deployed
// Worker.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfGet } from './check-edge-live.mjs';
import { isMainModule } from './kit-checks/main-module.mjs';
import { parseJsonc } from './new-app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ENV_CONFIG = { staging: 'wrangler.staging.jsonc', production: 'wrangler.jsonc' };

/**
 * The binding types this check compares, mapped from the config array that declares them to the
 * field naming the target resource on each side. `configKey` is the wrangler.jsonc array;
 * `configTarget` / `liveTarget` differ because the API renames some fields on the way out.
 */
export const COMPARED = [
  {
    type: 'd1',
    configKey: 'd1_databases',
    configTarget: 'database_id',
    liveTarget: ['id', 'database_id'],
  },
  {
    type: 'kv_namespace',
    configKey: 'kv_namespaces',
    configTarget: 'id',
    liveTarget: ['namespace_id', 'id'],
  },
  {
    type: 'r2_bucket',
    configKey: 'r2_buckets',
    configTarget: 'bucket_name',
    liveTarget: ['bucket_name'],
  },
  { type: 'hyperdrive', configKey: 'hyperdrive', configTarget: 'id', liveTarget: ['id'] },
  {
    type: 'queue',
    configKey: 'queues',
    configTarget: 'queue_name',
    liveTarget: ['queue_name', 'queue'],
  },
];

const BY_TYPE = new Map(COMPARED.map((c) => [c.type, c]));

/** Declared resource bindings, as `name -> {type, target}`. */
export function declaredBindings(cfg) {
  const out = new Map();
  for (const spec of COMPARED) {
    for (const b of cfg?.[spec.configKey] ?? []) {
      if (!b?.binding) continue;
      out.set(b.binding, { type: spec.type, target: b[spec.configTarget] ?? null });
    }
  }
  return out;
}

/** Live resource bindings from the settings payload, as `name -> {type, target}`. */
export function liveBindings(settings) {
  const out = new Map();
  for (const b of settings?.bindings ?? []) {
    const spec = BY_TYPE.get(b?.type);
    if (!spec || !b?.name) continue;
    const target = spec.liveTarget.map((f) => b[f]).find((v) => typeof v === 'string') ?? null;
    out.set(b.name, { type: b.type, target });
  }
  return out;
}

/**
 * PURE drift evaluation, so every branch is unit-testable without Cloudflare access (CI has
 * none). Returns findings, most serious first.
 */
export function evaluate(declared, live) {
  const findings = [];
  for (const [name, want] of declared) {
    const got = live.get(name);
    if (!got) {
      findings.push(
        `MISSING: "${name}" (${want.type}) is declared but the deployed Worker has no such binding`,
      );
      continue;
    }
    if (got.type !== want.type) {
      findings.push(`RETYPED: "${name}" is declared as ${want.type} but deployed as ${got.type}`);
      continue;
    }
    // A null target on either side means the API did not report one — do not invent a finding.
    if (want.target && got.target && want.target !== got.target) {
      findings.push(
        `RETARGETED: "${name}" (${want.type}) points at "${got.target}" in production, ` +
          `but this repo declares "${want.target}". Someone repointed a live binding.`,
      );
    }
  }
  for (const [name, got] of live) {
    if (!declared.has(name)) {
      findings.push(
        `EXTRA: the deployed Worker binds "${name}" (${got.type}), which this repo does not declare`,
      );
    }
  }
  // RETARGETED and EXTRA are the two that mean somebody else touched this Worker.
  const rank = (f) => (f.startsWith('RETARGETED') ? 0 : f.startsWith('EXTRA') ? 1 : 2);
  return findings.sort((a, b) => rank(a) - rank(b));
}

export async function run(env, { token, root = ROOT, get = cfGet } = {}) {
  const cfg = parseJsonc(readFileSync(join(root, ENV_CONFIG[env]), 'utf8'));
  const res = await get(token, `/accounts/${cfg.account_id}/workers/scripts/${cfg.name}/settings`);
  if (!res?.success) {
    const why = res?.errors?.map((e) => e.message).join('; ') || 'unknown error';
    // Fail closed: an unreadable Worker is not a verified one.
    return {
      failed: true,
      findings: [`could not read deployed settings for "${cfg.name}": ${why}`],
    };
  }
  const findings = evaluate(declaredBindings(cfg), liveBindings(res.result ?? res));
  return { failed: findings.length > 0, findings, scriptName: cfg.name };
}

async function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--env');
  const env = idx === -1 ? null : args[idx + 1];
  if (!Object.hasOwn(ENV_CONFIG, env ?? '')) {
    process.stderr.write('usage: node scripts/check-binding-drift.mjs --env staging|production\n');
    process.exit(1);
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    process.stderr.write('binding-drift check FAILED — CLOUDFLARE_API_TOKEN is not set\n');
    process.exit(1);
  }
  const { failed, findings, scriptName } = await run(env, { token });
  if (failed) {
    process.stderr.write(`Binding drift detected on ${env}:\n\n`);
    for (const f of findings) process.stderr.write(`  ✗ ${f}\n`);
    process.stderr.write(
      '\nThe deployed Worker is not bound to what this repo declares. One Cloudflare account is\n' +
        "shared across apps and `Workers Scripts: Edit` has no per-script scope, so another app's\n" +
        'token can replace this Worker and keep its secrets. Investigate before redeploying:\n' +
        'Audit Logs v2 records the deploy with actor.token_id. See DECISIONS 2026-08-18.\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `Binding drift check passed on ${env}: "${scriptName}" binds exactly what the repo declares.\n`,
  );
}

if (isMainModule(import.meta.url)) await main();
