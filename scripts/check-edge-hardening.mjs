// Guards over the DEPLOYING wrangler configs, one entry point: invariants 1–4 below, plus the
// private-database binding gate documented at ALLOWLIST_FILE.
//
// 1. EDGE HARDENING — every deploying config must disable the default `*.workers.dev` hostname
//    and preview URLs. Those hostnames are a SECOND ingress to the worker that bypasses the
//    zone's WAF + rate-limiting rules (those attach to the custom domain on cialdnb.ai, not to
//    workers.dev), which also breaks the kit's assumption that Cloudflare always fronts the
//    worker — the basis for `cf-connecting-ip` rate limiting and audit. See docs/SECURITY-EDGE.md.
//    Same per-config gate, same reason it lives here (wrangler configs are not in the upgrade
//    diff set, so only a carried guard forces adoption): wherever a config turns Workers Logs ON,
//    it must set `observability.logs.invocation_logs: false`. The platform's per-invocation record
//    carries the request URL — on this kit a live magic-link token (`GET /auth/verify?token=…`,
//    which does not consume it) and addresses (`/api/users/:email`) — into a log kept 7 days with
//    no per-entry deletion (PIA C5; src/platform/logEvent.ts covers the Worker's own lines).
//
// 2. PLACEHOLDER HYGIENE — the provisioning sentinel must never appear in a COMMENT, and a live
//    binding id must never be left as an unfilled `<fill me in>`. The production preflight in
//    .github/workflows/deploy-prod.yml is a blunt grep for the sentinel and cannot tell a JSONC
//    comment from live config, so a commented example binding carrying the sentinel blocks the
//    deploy of an app whose live bindings are every one provisioned — unclearable, since the
//    remedy it prints (`npm run provision`) has nothing left to provision. The kit shipped
//    exactly such a line and CialDNB/consumption hit it in production on 2026-08-04. See
//    DECISIONS 2026-08-04.
//
// 3. RESOURCE ATTRIBUTABILITY — every resource a deploying config names must carry this app's
//    name. The whole kit naming scheme (src/platform/naming.ts) exists because one Cloudflare
//    account is shared across business lines and "every resource must be attributable to its
//    app at a glance". Nothing enforced it: the bootstrap tripwire catches a residual
//    template name and the template's own ids, so it sees TEMPLATE contamination — and is blind
//    to SIBLING contamination, where an app is forked from another app rather than the template,
//    renamed almost everywhere, and left pointing at the sibling's resources. The costly case is
//    `r2_buckets`: a stale `bucket_name` sends this app's nightly D1 dumps into another app's
//    bucket, which is a cross-app data leak that nothing else notices. See DECISIONS 2026-08-18.
//
//    Deliberately a PREFIX rule (plus exact names for the kit's own DB/BACKUPS bindings) rather
//    than an exact match on every binding: a fork legitimately adds buckets and namespaces the
//    kit never declared, and this check must not turn the fleet red on its next /kit-upgrade for
//    resources it named correctly. Route patterns are NOT checked — a fork on a dedicated zone
//    (the account-isolation roadmap, DECISIONS 2026-06-23) legitimately serves a different
//    hostname, and a wrong one is loud anyway because the app stops answering.
//
//    Applied to EVERY root wrangler config, like the other two gates: the canonical pair in full
//    (worker name, env suffix, the exact DB/BACKUPS names), every other discovered config by the
//    prefix rule alone — `wrangler deploy -c wrangler.mcp.jsonc` ships a worker exactly as live,
//    so a sibling's bucket or database named there leaks just the same, but that worker's name
//    and env suffix are the fork's to choose. wrangler.test.jsonc is exempt by name (it never
//    deploys); .toml is the binding gate's refusal to make.
//
// 4. AI CONFIGURATION — every AI_DEFAULT_MODEL / AI_LARGE_MODEL a deploying config names must be on
//    the AI client's model allowlist, and its AI_INFERENCE_GEO must be one the client accepts for
//    that config's APP_ENV (never "global" in production). The runtime refuses both on every call
//    (src/ai/policy.ts) — so without this, a config naming Haiku 4.5 (it rejects the inference_geo
//    pin, PIA C6) keeps CI green and then fails every AI call in that environment with a 503, and a
//    production `"global"` drops the pin with nobody reviewing it. The allowlist and the region
//    rule are IMPORTED from src/ai/policyVocabulary.mjs, the module the runtime reads, never
//    restated here. See DECISIONS 2026-09-23.
//
// 5. AGENT ARMING — a block (top-level `vars`, or an `env.<name>` block's own) that sets
//    AGENT_ENABLED to "on" must carry the controls the PIA makes conditions of arming, in the SAME
//    block:
//      - READ_AUDIT "on" (C2);
//      - an explicit AGENT_TRANSCRIPT_RETENTION_DAYS (C1, O6);
//      - a `default_retention` no longer than that retention on every Workflow binding (C9, O8),
//        read where the Workflow is DEFINED: a binding to another Worker's Workflow (`script_name`)
//        is held to that Worker's config, and refused when no config here defines it;
//      - when it binds any Workflow, an installed wrangler that actually deploys that field, read
//        from wrangler's own config schema (4.124 only warns on it and drops it);
//      - either no VAULT bucket or a declared VAULT_RETENTION_DAYS (PIA §5: the vault has no
//        retention in code).
//    And, since P2-2 (docs/agent-loop-P2-DESIGN.md §7.1; PIA C6, C9, privacy must-fixes 13/14):
//      - APP_ENV pinned and on the LADDER: the block's APP_ENV is exactly "production" or
//        "staging" (an armed DEPLOYING block is never "test" or "development"); the top level of
//        wrangler.jsonc says "production" and of wrangler.staging.jsonc "staging"; any other
//        config, and every env block, is judged as production; and the judged environment must
//        be on AGENT_ARMABLE_ENVS. That ladder holds only test + development until P2-9 (staging)
//        and P2-11 (production), so EVERY armed deploying block fails here until then — the
//        static half of dormancy;
//      - an AGENT_ARMING_RECORD (a Linear id citing this app+env's C1–C20 evidence);
//      - AI_INFERENCE_GEO absent or "us" — the agent never runs "global", even in staging (C6);
//      - the reaper's cron (AGENT_REAPER_CRON) among the block's effective triggers;
//      - an AGENT_RUN Workflow binding of class AgentRunWorkflow DEFINED in this Worker (no
//        `script_name`, which cannot be combined with `default_retention`).
//    AGENT_ENABLED itself must be exactly "on" or "off" — an armed-ish value is one the gate and
//    the runtime could read differently. And no deploy command (package.json scripts, the
//    .github/workflows files) may pass AGENT_ENABLED, READ_AUDIT, either retention, APP_ENV,
//    AGENT_ARMING_RECORD or AI_INFERENCE_GEO with `wrangler --var`, which replaces the config's
//    value at deploy time. Every name, value, comparison and the ladder come from
//    src/ai/agentVocabulary.mjs, the module the runtime predicate (src/ai/agentArming.ts) reads.
//    DORMANT: the kit's configs set AGENT_ENABLED "off", so no config fails; the check exists so
//    the first config that arms an agent cannot skip them. See DECISIONS 2026-09-25, 2026-10-04.
//
//    Check 3 also holds every Workflow binding's `name` to the app prefix (Workflow names are
//    ACCOUNT-scoped, and one account carries every fork), and on the canonical pair the AGENT_RUN
//    binding to exactly `<APP_NAME>-agent-run<env suffix>`; and a binding with `script_name` may
//    bind only a Workflow one of this repo's configs defines (a prefix can belong to two apps).
//
// Runs in plain Node (like verify:bootstrap), wired into `npm run ci` and .github/workflows/ci.yml.
// Propagates to forks via /kit-upgrade — and the set to adopt is scripts/ + .github PLUS
// `src/framework/readAuditVocabulary.mjs` (imported below, for the one definition of the
// read-ledger arming vocabulary), `src/ai/policyVocabulary.mjs` (the AI model allowlist and region
// rule), `src/ai/agentVocabulary.mjs` (the agent's arming vocabulary and ladder) and
// `tsconfig.json` (whose allowJs + checkJs let the TypeScript side import those same
// files). All of them are in the upgrade diff set; take them together. A fork that adopts only
// scripts/ + .github gets ERR_MODULE_NOT_FOUND from `npm run verify:edge` — and, because
// test/platform/edge-hardening.test.mjs imports the vocabularies at module scope, that file aborts
// at load and every assertion in it disappears at once. Loud and closed, but the message names a
// missing file rather than a broken guard; a fork that adopts the guard but hasn't set the flags
// gets a red CI until it does — the flags themselves live in wrangler.jsonc, which /kit-upgrade
// does NOT diff (rename-noise), so this guard is the thing that forces adoption. That propagation
// is also why check #2 lives HERE rather than in a `verify:placeholders` script of its own: a new
// npm script would need a package.json edit, and package.json is NOT in the upgrade diff set — the
// guard would reach forks as a file that nothing ever runs.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseModule } from '@babel/parser';
import {
  AGENT_ARMABLE_ENVS,
  AGENT_ARMING_RECORD_PATTERN,
  AGENT_ARMING_RECORD_VAR,
  AGENT_DEPLOYED_ENVS,
  AGENT_ENABLED_VALUES,
  AGENT_ENABLED_VAR,
  AGENT_REAPER_CRON,
  AGENT_RETENTION_VAR,
  AGENT_RUN_BINDING,
  AGENT_RUN_CLASS,
  AGENT_RUN_NAME_SUFFIX,
  isAgentArmableEnv,
  isAgentDeployedEnv,
  isAgentEnabled,
  isArmingRecord,
  positiveDays,
  VAULT_BINDING,
  VAULT_RETENTION_VAR,
} from '../src/ai/agentVocabulary.mjs';
import {
  INFERENCE_GEO_VAR,
  isAllowedModel,
  MODEL_VARS,
  resolveInferenceGeo,
} from '../src/ai/policyVocabulary.mjs';
import {
  isReadAuditArmed,
  READ_AUDIT_ARMED,
  READ_AUDIT_VAR,
} from '../src/framework/readAuditVocabulary.mjs';
import { isMainModule } from './kit-checks/main-module.mjs';
import {
  PROVISION_PLACEHOLDER,
  parseJsonc,
  stripJsoncComments,
  TEMPLATE_KEBAB,
} from './new-app.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Configs that actually deploy a worker. wrangler.test.jsonc never deploys, so it's exempt from
// the edge-hardening flags — but NOT from the binding gate below, which discovers every root
// wrangler config rather than trusting this pair to be the whole story.
export const DEPLOYING_CONFIGS = ['wrangler.jsonc', 'wrangler.staging.jsonc'];
export const REQUIRED = { workers_dev: false, preview_urls: false };

/** Every wrangler config present in the repo root — the kit's deploying pair plus anything else
 * wrangler could be pointed at. `wrangler deploy -c wrangler.mcp.jsonc` deploys a second worker
 * from the same repo, and a binding in that file is exactly as live as one in wrangler.jsonc;
 * the gate used to read the fixed pair only, and CialDNB/Arena-2's real Hyperdrive binding sat
 * in a third config with zero failures reported. Root-level `wrangler*` names only: a config
 * passed by path from a subdirectory is beyond a static gate's reach, the kit's own workflows
 * deploy only the canonical pair, and the convention every observed case follows is a root
 * `wrangler*.<ext>` file. Case-insensitive, because `wrangler -c Wrangler.mcp.jsonc` deploys
 * regardless of case and a case-sensitive CI filesystem would otherwise let `Wrangler.jsonc`
 * slip past a lowercase-only match. Sorted, so failures arrive in a stable order. */
export function wranglerConfigsOnDisk(root = ROOT) {
  return readdirSync(root)
    .filter((name) => /^wrangler[\w.-]*\.(jsonc|json|toml)$/i.test(name))
    .sort();
}

/**
 * Workers Logs' own per-invocation record logs the request URL, so wherever a config's
 * `observability` block leaves Workers Logs ON, `logs.invocation_logs` must be exactly `false`.
 * Logs count as OFF only when a config says so (`logs.enabled: false`, or `enabled: false` with no
 * `logs.enabled` override) — an ambiguous block is treated as on (fail closed). No block at all
 * passes: the config then turns nothing on. `where` names an env block. Pure.
 */
export function observabilityFailures(label, obs, where = '') {
  if (obs === undefined) return [];
  if (!obs || typeof obs !== 'object') {
    return [
      `${label}: ${where}"observability" is not an object — cannot tell whether logs are on.`,
    ];
  }
  const logs = obs.logs && typeof obs.logs === 'object' ? obs.logs : {};
  const logsOff = logs.enabled === false || (obs.enabled === false && logs.enabled === undefined);
  if (logsOff || logs.invocation_logs === false) return [];
  return [
    `${label}: ${where}"observability" leaves Workers Logs on without "logs": ` +
      `{ "invocation_logs": false } (found ${JSON.stringify(logs.invocation_logs)}). The ` +
      'per-invocation record carries the request URL — a live /auth/verify?token=…, an ' +
      '/api/users/<address> — into a log kept 7 days that cannot be deleted (PIA C5).',
  ];
}

/** Failures for one parsed config (null = unparseable). Pure — used by the test. */
export function configFailures(label, cfg) {
  if (!cfg) return [`${label}: not valid JSONC`];
  const failures = [];
  for (const [key, want] of Object.entries(REQUIRED)) {
    if (cfg[key] !== want) {
      failures.push(`${label}: expected "${key}": ${want}, found ${JSON.stringify(cfg[key])}`);
    }
  }
  // Wrangler environments inherit these keys from the top level unless they override them — so
  // `"env": { "staging": { "workers_dev": true } }` quietly re-opens the ingress the top level
  // closed, on the one environment nobody re-checked. Overriding to the required value is
  // pointless but honest; overriding away from it fails.
  failures.push(...observabilityFailures(label, cfg.observability));
  if (cfg.env && typeof cfg.env === 'object') {
    for (const [envName, block] of Object.entries(cfg.env)) {
      if (!block || typeof block !== 'object') continue;
      for (const [key, want] of Object.entries(REQUIRED)) {
        if (key in block && block[key] !== want) {
          failures.push(
            `${label}: env.${envName} sets "${key}": ${JSON.stringify(block[key])} — an ` +
              `environment block re-enables what the top level disabled. Expected ${want}.`,
          );
        }
      }
      // An env block's `observability` replaces the top level's, so it is checked on its own.
      failures.push(...observabilityFailures(label, block.observability, `env.${envName} `));
    }
  }
  return failures;
}

/** One failure line for a config the gate could not read. ENOENT on a canonical deploying config
 * gets the adoption story instead of a bare errno: an app arriving at the kit without
 * wrangler.staging.jsonc must see a finding with a remedy, not what looks like a broken gate —
 * a red that reads as breakage invites deleting the check, and a red that reads as a finding
 * invites fixing the config. Pure. */
export function configReadFailure(file, err) {
  if (err?.code !== 'ENOENT' || !DEPLOYING_CONFIGS.includes(file)) {
    return `${file}: could not read (${err.message})`;
  }
  const env = file === 'wrangler.jsonc' ? 'production' : 'staging';
  return (
    `${file}: missing — a finding, not a broken gate. The kit deploys ${env} from this config ` +
    'and every guard here reads it, so an app without it is unfinished rather than exempt. ' +
    'Adopting the kit onto an existing app? Bring the deploying-config pair with it — ' +
    'wrangler.jsonc plus wrangler.staging.jsonc, each with "workers_dev": false and ' +
    '"preview_urls": false. See docs/SECURITY-EDGE.md and docs/DATA-ROUTES.md.'
  );
}

/** The configs a worker deploys from, for the checks that read every one: the canonical pair plus
 * every other root wrangler config — a second worker deployed from wrangler.mcp.jsonc is exactly
 * as live as the first. wrangler.test.jsonc is exempt BY NAME (it never deploys — the comment
 * above DEPLOYING_CONFIGS), and .toml files are skipped only because the binding gate below
 * refuses them outright with the message that matters. A listing failure is pushed onto
 * `failures`: nothing can be cleared from a directory that cannot be read. */
function deployingConfigFiles(root, failures) {
  let discovered = [];
  try {
    discovered = wranglerConfigsOnDisk(root);
  } catch (err) {
    failures.push(`could not list wrangler configs (${err.message}) — nothing can be cleared.`);
  }
  return [...new Set([...DEPLOYING_CONFIGS, ...discovered])].filter(
    (file) => file !== 'wrangler.test.jsonc' && !file.toLowerCase().endsWith('.toml'),
  );
}

export function checkEdgeHardening(root = ROOT) {
  const failures = [];
  // A second worker deployed from wrangler.mcp.jsonc with workers.dev enabled is a second
  // unprotected ingress, which is the exact hole this check closes on the first worker.
  const files = deployingConfigFiles(root, failures);
  for (const file of files) {
    let cfg = null;
    try {
      cfg = parseJsonc(readFileSync(join(root, file), 'utf8'));
    } catch (err) {
      failures.push(configReadFailure(file, err));
      continue;
    }
    failures.push(...configFailures(file, cfg));
  }
  return failures;
}

/** Sentinel occurrences that sit in a COMMENT rather than in live config — what the production
 * preflight's grep misreads as unprovisioned. EXACT, because it reuses the kit's own JSONC
 * scanner rather than pattern-matching lines: an occurrence survives comment-stripping if and
 * only if it is real config, so strip the text up to and including each occurrence and ask
 * whether it is still there. Being string- and block-aware, this gets both cases a line-based
 * matcher gets wrong — a `//` inside a URL value is not a comment (src/platform/bootstrap.ts
 * shipped a real bug over exactly that assumption), and a sentinel buried in the body of a
 * `/* … *\/` block IS one. Pure — used by the test. */
export function placeholderCommentFailures(label, text) {
  const failures = [];
  for (let from = 0; ; ) {
    const at = text.indexOf(PROVISION_PLACEHOLDER, from);
    if (at === -1) return failures;
    from = at + PROVISION_PLACEHOLDER.length;
    if (stripJsoncComments(text.slice(0, from)).endsWith(PROVISION_PLACEHOLDER)) continue;
    const line = text.slice(0, at).split('\n').length;
    failures.push(
      `${label}:${line}: ${PROVISION_PLACEHOLDER} sits in a comment — the production preflight ` +
        'greps this file and cannot tell a comment from live config, so it will block a fully ' +
        'provisioned deploy. Describe the binding without an id.',
    );
  }
}

/** `"id": "<fill me in>"` written inside a COMMENT. The sentinel check above catches the id the
 * preflight greps for; this catches the OTHER way an example binding grows an id — a fill-in
 * that reads as a helpful template and is one edit away from becoming the sentinel again. The
 * rule the kit states is that a commented example carries no id at all, and this is the half of
 * it a sentinel-only check cannot see: a stale comment carrying a fill-in passes every gate
 * while the docs claim the example is id-free (which is exactly how one merged, 2026-08-04).
 * Bounded to id-shaped keys, so prose mentioning `<something>` is untouched, and to `<`/`>`,
 * so the real `store_id` values in the commented secret examples stay legal. Pure. */
export function exampleIdCommentFailures(label, text) {
  const failures = [];
  for (const m of text.matchAll(/"(?:id|database_id)"\s*:\s*"[^"]*[<>][^"]*"/g)) {
    const end = m.index + m[0].length;
    if (stripJsoncComments(text.slice(0, end)).endsWith(m[0])) continue; // live config
    const line = text.slice(0, m.index).split('\n').length;
    failures.push(
      `${label}:${line}: ${m[0]} is an example id in a comment — commented example bindings ` +
        'carry no id at all. Name the command that mints it instead.',
    );
  }
  return failures;
}

/** Live binding ids left as an unfilled `<fill me in>`. The sentinel is the only unprovisioned
 * marker any gate knows, so a second placeholder vocabulary in a real binding sails through the
 * preflight and dies late at the Cloudflare API — the opaque, minutes-later failure the preflight
 * exists to pre-empt. Parsed structurally, so commented examples are already gone. Pure. */
export function unfilledIdFailures(label, cfg) {
  if (!cfg) return [];
  const slots = (v) => (Array.isArray(v) ? v : []);
  return [
    ...slots(cfg.d1_databases).map((db) => ['database_id', db?.database_id]),
    ...slots(cfg.kv_namespaces).map((ns) => ['id', ns?.id]),
  ]
    .filter(([, id]) => typeof id === 'string' && /[<>]/.test(id))
    .map(
      ([key, id]) =>
        `${label}: "${key}": ${JSON.stringify(id)} is an unfilled placeholder — paste the real id.`,
    );
}

export function checkPlaceholderHygiene(root = ROOT) {
  const failures = [];
  for (const file of DEPLOYING_CONFIGS) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch (err) {
      failures.push(configReadFailure(file, err));
      continue;
    }
    failures.push(...placeholderCommentFailures(file, text));
    failures.push(...exampleIdCommentFailures(file, text));
    failures.push(...unfilledIdFailures(file, parseJsonc(text)));
  }
  return failures;
}

/** The env suffix each deploying config's resources must carry. */
export const CONFIG_SUFFIX = { 'wrangler.jsonc': '', 'wrangler.staging.jsonc': '-staging' };

/** The APP_ENV each canonical deploying config's TOP LEVEL deploys (configReadFailure agrees). */
export const CONFIG_APP_ENV = {
  'wrangler.jsonc': 'production',
  'wrangler.staging.jsonc': 'staging',
};

/** Exact names the kit owns, by binding, given the app name and the env suffix. */
function canonicalNames(app, suffix) {
  return { DB: `${app}-db${suffix}`, BACKUPS: `${app}-backups${suffix}` };
}

/** The exact Workflow name the kit owns on the canonical pair: the agent's turn engine. */
function canonicalWorkflowNames(app, suffix) {
  return { [AGENT_RUN_BINDING]: `${app}-${AGENT_RUN_NAME_SUFFIX}${suffix}` };
}

/**
 * Naming failures for one parsed config. Pure — used by the test.
 *
 * `vars.APP_NAME` is the app identity (the worker `name` carries the env suffix, so deriving the
 * app from it would need a suffix strip that mis-handles an app whose own name ends in
 * `-staging`). No APP_NAME is itself a failure: without it nothing here can be checked.
 */
export function namingFailures(label, cfg, suffix) {
  if (!cfg) return [`${label}: not valid JSONC`];
  const app = cfg?.vars?.APP_NAME;
  if (typeof app !== 'string' || app.length === 0) {
    return [`${label}: missing "vars.APP_NAME" — resource names cannot be attributed to an app`];
  }
  const failures = [];
  const canonical = canonicalNames(app, suffix);

  if (cfg.name !== `${app}${suffix}`) {
    failures.push(`${label}: worker "name" is "${cfg.name}", expected "${app}${suffix}"`);
  }
  failures.push(
    ...resourceNameFailures(label, cfg, app, canonical, canonicalWorkflowNames(app, suffix)),
  );
  return failures;
}

/**
 * Prefix-only naming failures for a root config OUTSIDE the canonical pair. `wrangler deploy -c
 * wrangler.mcp.jsonc` deploys a worker exactly as live as the canonical ones, so a sibling's
 * bucket or database named there leaks just the same — but its worker `name` and env suffix are
 * the fork's to choose, so only the attributability rule applies: every d1/r2 name starts with
 * THIS app's name. `app` is the IDENTITY config's `vars.APP_NAME` (the repo has one app, and
 * wrangler.jsonc is where it says so), never the discovered config's own vars: a config forked
 * from a sibling can carry the sibling's APP_NAME too, and checking its names against that would
 * pass exactly the case this exists to catch. Pure — used by the test.
 */
export function discoveredNamingFailures(label, cfg, app) {
  if (!cfg) return [`${label}: not valid JSONC`];
  if (typeof app !== 'string' || app.length === 0) {
    return [
      `${label}: cannot attribute its resource names — ${IDENTITY_CONFIG} has no "vars.APP_NAME"`,
    ];
  }
  return resourceNameFailures(label, cfg, app, {});
}

/**
 * The attributability rule itself. Anything named after a resource must start with the app name;
 * then any binding with a canonical name (the kit's own DB/BACKUPS on the canonical pair) must
 * match it exactly. `canonical` is `{}` for a discovered config. Pure.
 *
 * Workflows too, top level AND every env block (each deploys its own `workflows`): a Workflow's
 * `name` is ACCOUNT-scoped, so on an account every fork shares, an unprefixed name either collides
 * with another app's Workflow or — with `script_name` — binds it (platform must-fix 5).
 * `canonicalWorkflows` (top level of the canonical pair only) pins the agent's AGENT_RUN to
 * `<app>-agent-run<suffix>`, the one name the kit's own deploys and DSR purge expect.
 */
function resourceNameFailures(label, cfg, app, canonical, canonicalWorkflows = {}) {
  const failures = [];
  const named = [
    ...(cfg.d1_databases ?? []).map((b) => ({
      kind: 'd1_databases',
      binding: b.binding,
      value: b.database_name,
    })),
    ...(cfg.r2_buckets ?? []).map((b) => ({
      kind: 'r2_buckets',
      binding: b.binding,
      value: b.bucket_name,
    })),
  ];
  for (const { kind, binding, value } of named) {
    if (typeof value !== 'string' || value.length === 0) continue; // shape is wrangler's problem
    if (value !== app && !value.startsWith(`${app}-`)) {
      failures.push(
        `${label}: ${kind} "${binding}" names "${value}", which is not this app's ` +
          `("${app}"). A resource belonging to another app must never be named here.`,
      );
      continue;
    }
    // Own keys only: a binding named "constructor" or "toString" is not a canonical one.
    const want = Object.hasOwn(canonical, binding) ? canonical[binding] : undefined;
    if (want && value !== want) {
      failures.push(`${label}: ${kind} "${binding}" names "${value}", expected "${want}"`);
    }
  }
  failures.push(...workflowNameFailures(label, cfg, app, canonicalWorkflows));
  return failures;
}

/** The Workflow half of the rule above: every `workflows[]` entry, top level and env blocks. Pure. */
function workflowNameFailures(label, cfg, app, canonicalWorkflows) {
  const failures = [];
  const spots = [['', cfg.workflows]];
  if (cfg.env && typeof cfg.env === 'object') {
    for (const [envName, block] of Object.entries(cfg.env)) {
      if (block && typeof block === 'object') spots.push([`env.${envName}.`, block.workflows]);
    }
  }
  for (const [where, workflows] of spots) {
    for (const wf of Array.isArray(workflows) ? workflows : []) {
      const value = wf?.name;
      if (typeof value !== 'string' || value.length === 0) continue; // shape is wrangler's problem
      const binding = wf?.binding;
      if (value !== app && !value.startsWith(`${app}-`)) {
        failures.push(
          `${label}: ${where}workflows "${binding}" names "${value}", which is not this app's ` +
            `("${app}"). Workflow names are account-scoped and the account is shared by every ` +
            "app: an unprefixed name collides with another app's Workflow, or binds it.",
        );
        continue;
      }
      const want =
        where === '' && Object.hasOwn(canonicalWorkflows, binding)
          ? canonicalWorkflows[binding]
          : undefined;
      if (want && value !== want) {
        failures.push(`${label}: workflows "${binding}" names "${value}", expected "${want}"`);
      }
    }
  }
  return failures;
}

/**
 * A Workflow binding with a `script_name` binds a Workflow that ANOTHER Worker defines. That is
 * allowed only when one of this repo's own configs defines it (`workflowDefinitions`), whatever its
 * name. The prefix rule above cannot close this alone: when one APP_NAME is a dash-prefix of
 * another ("arena" and "arena-go"), "arena-go-agent-run" passes the prefix of BOTH apps, so "arena"
 * could bind the sibling's turn engine with `script_name: "arena-go"`. A definition in this repo
 * cannot be another app's. Every block of every config, armed or not (the armed-block retention
 * rule asks the same question for its own reason). `configs` is `[label, parsedConfig][]`. Pure.
 */
export function foreignWorkflowFailures(configs) {
  const definitions = workflowDefinitions(configs);
  const failures = [];
  for (const [label, cfg] of configs) {
    if (!cfg || typeof cfg !== 'object') continue;
    for (const [where, block, worker] of configBlocks(cfg)) {
      for (const wf of Array.isArray(block.workflows) ? block.workflows : []) {
        if (definedHere(wf, worker)) continue;
        if (definitions.has(definitionKey(wf.script_name, wf?.name))) continue;
        failures.push(
          `${label}: ${where}workflows ${JSON.stringify(wf?.binding ?? '?')} binds Workflow ` +
            `${JSON.stringify(wf?.name)} of Worker ${JSON.stringify(wf.script_name)}, which no ` +
            'config in this repo defines. Workflow names are account-scoped on an account every ' +
            "app shares: a Workflow another repo's Worker defines belongs to another app. Define " +
            "it in this Worker, or keep the defining Worker's config in the repo root.",
        );
      }
    }
  }
  return failures;
}

/**
 * One Workflow NAME, one Worker. A Workflow's name is account-scoped, so two Workers that define the
 * same one do not get two Workflows: each deploy re-points the name at the Worker that deployed
 * last (or fails), and every binding to it follows. Within this repo, then, each Workflow name is
 * defined by ONE Worker — a copied `wrangler.mcp.jsonc` that keeps `workflows`, or an env block
 * that repeats the top level's, is refused. And the kit's canonical names (`<app>-agent-run` /
 * `<app>-agent-run-staging`, the names its deploys and the DSR purge address) are defined only
 * where the kit puts them: the AGENT_RUN binding at the top level of the canonical config that
 * deploys them, even while that config does not define it yet. A binding with `script_name` is a
 * use, not a definition (foreignWorkflowFailures judges those). `configs` is
 * `[label, parsedConfig][]`; `app` is the identity config's APP_NAME (null: the reservation is
 * skipped, namingFailures already reports it). Pure.
 */
export function workflowNameClashFailures(configs, app) {
  const reserved = new Map();
  if (typeof app === 'string' && app.length > 0) {
    for (const file of DEPLOYING_CONFIGS) {
      reserved.set(`${app}-${AGENT_RUN_NAME_SUFFIX}${CONFIG_SUFFIX[file] ?? ''}`, file);
    }
  }
  const failures = [];
  const definers = new Map();
  for (const [label, cfg] of configs) {
    if (!cfg || typeof cfg !== 'object') continue;
    for (const [where, block, worker] of configBlocks(cfg)) {
      for (const wf of Array.isArray(block.workflows) ? block.workflows : []) {
        const name = wf?.name;
        if (typeof name !== 'string' || name.length === 0 || !definedHere(wf, worker)) continue;
        const at = `${label}: ${where}workflows ${JSON.stringify(wf?.binding ?? '?')}`;
        const owner = reserved.get(name);
        if (
          owner !== undefined &&
          !(label === owner && where === '' && wf.binding === AGENT_RUN_BINDING)
        ) {
          failures.push(
            `${at} defines Workflow ${JSON.stringify(name)}, the name the kit reserves for the ` +
              `${AGENT_RUN_BINDING} binding at the top level of ${owner}. Name this Workflow ` +
              `${JSON.stringify(`${app}-<something>`)} instead.`,
          );
        }
        // An unnamed Worker cannot be told apart from any other: it counts as one of its own.
        const by = worker ?? at;
        const first = definers.get(name);
        if (first === undefined) definers.set(name, { by, at });
        else if (first.by !== by) {
          failures.push(
            `${at} defines Workflow ${JSON.stringify(name)} in Worker ${JSON.stringify(by)}, ` +
              `which ${first.at} already defines in Worker ${JSON.stringify(first.by)}. Workflow ` +
              'names are account-scoped: two Workers defining one take turns owning it, and every ' +
              'binding follows whichever deployed last. Give each its own name.',
          );
        }
      }
    }
  }
  return failures;
}

export function checkResourceNaming(root = ROOT) {
  const failures = [];
  const parsed = [];
  let identityApp = null;
  for (const file of DEPLOYING_CONFIGS) {
    let cfg = null;
    try {
      cfg = parseJsonc(readFileSync(join(root, file), 'utf8'));
    } catch (err) {
      failures.push(configReadFailure(file, err));
      continue;
    }
    if (file === IDENTITY_CONFIG) identityApp = cfg?.vars?.APP_NAME ?? null;
    parsed.push([file, cfg]);
    failures.push(...namingFailures(file, cfg, CONFIG_SUFFIX[file] ?? ''));
  }
  // Every OTHER root wrangler config is discovered rather than assumed away — the same closure
  // the edge-flag and binding gates have. A third config deploys a worker exactly as live as the
  // pair; only the prefix rule applies to it (its worker name and env suffix are its own).
  // wrangler.test.jsonc never deploys and is exempt by name; a .toml the binding gate refuses.
  let discovered = [];
  try {
    discovered = wranglerConfigsOnDisk(root);
  } catch (err) {
    failures.push(`could not list wrangler configs (${err.message}) — nothing can be cleared.`);
  }
  for (const file of discovered) {
    if (DEPLOYING_CONFIGS.includes(file)) continue;
    if (file === 'wrangler.test.jsonc' || file.toLowerCase().endsWith('.toml')) continue;
    let cfg = null;
    try {
      cfg = parseJsonc(readFileSync(join(root, file), 'utf8'));
    } catch (err) {
      failures.push(configReadFailure(file, err));
      continue;
    }
    parsed.push([file, cfg]);
    failures.push(...discoveredNamingFailures(file, cfg, identityApp));
  }
  failures.push(...foreignWorkflowFailures(parsed));
  failures.push(...workflowNameClashFailures(parsed, identityApp));
  return failures;
}

// Bindings whose id IS a live database credential. Hyperdrive hands the Worker a connection to
// a private Postgres/MySQL cluster; a Workers VPC service hands it a pinned host:port inside a
// VPC. Neither binding carries a per-Worker ACL, and the Cloudflare permissions that gate them
// (`Hyperdrive Read`, `Connectivity Directory Bind`) are flat ACCOUNT permissions with no
// per-resource scope — so any Worker in the account whose deploy credential holds those scopes
// can read the database by naming the id. Cloudflare offers no boundary below the account.
// binding-allowlist.jsonc is the reviewed one, and this check is what makes it load-bearing:
// production deploys run only through GitHub Actions and no repo user holds a Cloudflare token,
// so a binding cannot reach production without passing here.
export const ALLOWLIST_FILE = 'binding-allowlist.jsonc';
// `vpc_networks` is here because it is the BROADEST of the three, not the narrowest: a network
// binding attaches the worker to an entire Cloudflare Tunnel, or with `network_id: "cf1:network"`
// to every private service in the account — every database, every internal proxy, in one binding.
// Gating the two narrow kinds and not this one would have left the control covering the careful
// path and missing the reckless one.
export const GATED_BINDINGS = {
  hyperdrive: { idKey: 'id', prefix: 'HYPERDRIVE_' },
  vpc_services: { idKey: 'service_id', prefix: 'VPC_' },
  vpc_networks: { idKey: 'network_id', prefix: 'VPC_' },
};

// Every grant declares WHOSE data is behind it. `client` means the database carries client data;
// `internal` means it does not. The class is not decoration — it selects the read-ledger failure
// posture in src/data/aurora.ts (client = write-ahead and fail-closed, internal = fire-and-forget),
// so it is decided here, once, where a code owner reviews the grant, and never by an individual
// query that could pick the cheaper branch for itself.
export const SOURCE_CLASSES = ['client', 'internal'];

// A Workers VPC SERVICE can front an HTTP service rather than a database — an on-premises gateway
// published through a Cloudflare Tunnel, which a DB Israel app is granted in the central catalog
// and reaches as `VPC_<SERVICE>` with its host in `VPC_<SERVICE>_HOST`. It is granted exactly like
// a database (same binding kind, same flat account permission, same allowlist pairing), but it is
// not one: no connection string, no SQL, no read seam. So `vpc_services` grants take one more
// class, `http`, which swaps the AURORA_SOURCES cross-check for a PRIVATE_SERVICES one
// (src/data/privateServices.ts, the transport that attaches the credential) and requires the host
// var. Hyperdrive is always a database, and a network binding reaches a whole tunnel, so neither
// takes it: `vpc_networks` stays gated exactly as before.
export const HTTP_SERVICE_CLASS = 'http';

/** The classes a grant of this binding kind may carry. Pure. */
export function grantClassesFor(kind) {
  return kind === 'vpc_services' ? [...SOURCE_CLASSES, HTTP_SERVICE_CLASS] : SOURCE_CLASSES;
}

// The var a deploying config sets to declare it has adopted the read-attribution ledger. It does
// NOT switch recording on (that is unconditional in the seam); it is the app SAYING SO, and this
// check refuses a client-class grant without it. Arming is what a fork does knowingly, and the
// point is that granting yourself a client database and forgetting the trail is not possible.
//
// IMPORTED, not mirrored — unlike `sourceNameForBinding` below, which has to be a copy because
// its source is TypeScript. src/framework/readAuditVocabulary.mjs is plain JavaScript precisely
// so this plain-node gate and the worker runtime that HONOURS the flag can share one definition.
// The alternative was two `'on'` literals agreeing by luck: change the runtime's and this gate
// goes on enforcing a value nothing reads, while the app reports arming to the fleet registry
// that CI never checked. Re-exported so the pinning test keeps importing them from the gate.
// A fork that took scripts/ without src/framework/ gets ERR_MODULE_NOT_FOUND naming the file it
// is missing — loud and closed, which is the direction this gate is allowed to break in.
// Only the two CONSTANTS are re-exported, and only because this gate's pinning test already
// imported them from here. `isReadAuditArmed` is deliberately NOT: nothing imports it from a check
// script, and a third module path exporting the same comparison is the ambiguity the single source
// exists to remove. A TypeScript consumer reaches it through src/framework/readAudit.ts.
export { READ_AUDIT_ARMED, READ_AUDIT_VAR };

/** Whether a parsed wrangler config declares the ledger armed. The var name and the comparison
 * both come from the shared module; digging the value out of a parsed JSONC config is the only
 * part this side owns, and the only part that differs from the runtime's predicate. */
export function readAuditArmed(cfg) {
  return isReadAuditArmed(cfg?.vars?.[READ_AUDIT_VAR]);
}

// The read seam's source table. The allowlist decides a database's class; `AURORA_SOURCES` is
// what the RUNNING CODE consults to pick the failure posture. If those two ever disagree, the
// allowlist's `"class": "client"` is a label on a grant while the seam takes the fire-and-forget
// path — the control is documented and absent at the same time, which is worse than not having
// it. So the two are cross-checked here, in the gate that already reviews the grant.
export const SOURCES_FILE = 'src/data/aurora.ts';

/** Binding name → source name. MIRRORS `sourceNameForBinding` in src/data/aurora.ts, which this
 * plain-Node script cannot import. The pair is pinned from both sides: the test here, and
 * test/data/aurora.test.ts on the TypeScript one. Pure. */
export function sourceNameForBinding(binding) {
  return String(binding)
    .replace(/^(HYPERDRIVE|VPC)_/, '')
    .toLowerCase();
}

// Keys of a babel node that hold no runtime code: positions, comments, and type annotations.
const NON_CODE_KEYS = new Set([
  'loc',
  'start',
  'end',
  'range',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'typeAnnotation',
  'typeParameters',
  'typeArguments',
  'superTypeParameters',
  'returnType',
  'implements',
]);
// Declarations that are types only, erased before anything runs.
const TYPE_ONLY = new Set(['TSTypeAliasDeclaration', 'TSInterfaceDeclaration']);
// The names the global object answers to in a Worker or in Node.
const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'window', 'global']);

const isMember = (n) => n?.type === 'MemberExpression' || n?.type === 'OptionalMemberExpression';
const isObjectIdent = (n) => n?.type === 'Identifier' && n.name === 'Object';

/** `globalThis.Object`, `self['Object']`, or `globalThis[anything computed]`. Pure. */
function reachesGlobalObject(n) {
  if (!isMember(n) || n.object.type !== 'Identifier' || !GLOBAL_OBJECTS.has(n.object.name)) {
    return false;
  }
  if (!n.computed) return n.property.name === 'Object';
  return n.property.type !== 'StringLiteral' || n.property.value === 'Object';
}

/** Does an assignment / update / delete target write to `Object` or anything under it? Pure. */
function writesObject(target) {
  let hit = false;
  const visit = (n) => {
    if (hit || !n || typeof n.type !== 'string') return;
    let root = n;
    while (isMember(root) || root.type === 'TSNonNullExpression') {
      if (reachesGlobalObject(root)) {
        hit = true;
        return;
      }
      root = root.type === 'TSNonNullExpression' ? root.expression : root.object;
    }
    if (isObjectIdent(root)) {
      hit = true;
      return;
    }
    for (const [key, value] of Object.entries(n)) {
      if (NON_CODE_KEYS.has(key)) continue;
      for (const child of Array.isArray(value) ? value : [value]) visit(child);
    }
  };
  visit(target);
  return hit;
}

/**
 * Could this module change what `Object.freeze` is, by anything it says itself? A table read as
 * `Object.freeze({ … })` is only the runtime's table if `Object` is the platform's — and
 * `const { Object } = …`, `import { x as Object }`, `const O = Object; O.freeze = …` or
 * `Object.defineProperty(Object, 'freeze', …)` would each make the gate read one table while the
 * Worker builds another. So, in runtime code (type annotations aside):
 *
 *   • the identifier `Object` appears ONLY as `Object.<name>` — never bare: not bound (import,
 *     declaration, destructuring at any depth, parameter, catch, label), not aliased, not passed,
 *     not returned, not exported;
 *   • nothing under it is written — no assignment, update, `delete` or `for…in/of` target rooted
 *     at `Object` (`Object.freeze = …`, `Object.prototype.x = …`);
 *   • it is never reached through the global object (`globalThis.Object`, `self['Object']`, or
 *     `globalThis[computed]`, which could be either).
 *
 * Conservative on purpose: a legitimate table file breaks none of these, and a false refusal fails
 * closed. What it cannot see is another module changing the global before this one runs; that is
 * the same honest limit every static fence here has (DECISIONS 2026-11-02). Pure.
 */
export function rebindsObject(program) {
  let hit = false;
  const visit = (n) => {
    if (hit || !n || typeof n.type !== 'string' || TYPE_ONLY.has(n.type)) return;
    if (isObjectIdent(n) || reachesGlobalObject(n)) {
      hit = true;
      return;
    }
    if (
      (n.type === 'AssignmentExpression' && writesObject(n.left)) ||
      (n.type === 'UpdateExpression' && writesObject(n.argument)) ||
      (n.type === 'UnaryExpression' && n.operator === 'delete' && writesObject(n.argument)) ||
      ((n.type === 'ForInStatement' || n.type === 'ForOfStatement') && writesObject(n.left))
    ) {
      hit = true;
      return;
    }
    for (const [key, value] of Object.entries(n)) {
      if (NON_CODE_KEYS.has(key)) continue;
      // `Object.freeze`: the object is the one legal use, and a non-computed property is a name.
      if (isMember(n) && key === 'object' && isObjectIdent(value)) continue;
      if (isMember(n) && key === 'property' && !n.computed) continue;
      // A non-computed key names a property; it does not reference a binding.
      if (key === 'key' && !n.computed && n.type !== 'ObjectProperty') continue;
      if (key === 'key' && n.type === 'ObjectProperty' && !n.computed && !n.shorthand) continue;
      for (const child of Array.isArray(value) ? value : [value]) visit(child);
    }
  };
  visit(program);
  return hit;
}

/**
 * The string table a source file declares as `const <name> = Object.freeze({ … })` (optionally
 * `satisfies …`), read with a real parser — or null when it cannot be read with certainty. The
 * file is parsed whole with `@babel/parser` (TypeScript syntax; the exact-pinned devDependency
 * scripts/test-runtime-boundary.mjs already uses), so a comment, a string or a doc example is never
 * mistaken for the declaration, and an initializer that continues past the table (`… }) && x`)
 * is seen for what it is.
 *
 * Null — a failure for every caller — when the file does not parse; when there is not exactly ONE
 * top-level `const` declaration of `name`; when its initializer is anything but
 * `Object.freeze({ … })` itself, `satisfies` aside (an `as` cast, a `&&`, a ternary, a call around
 * it); when the file could change what `Object` is (`rebindsObject`); or when any property is not a plain
 * `key: 'string'` pair (a spread, a computed or duplicate key, `__proto__`, a non-string value).
 * Pure.
 */
export function frozenStringTable(text, name) {
  let ast;
  try {
    ast = parseModule(text, { sourceType: 'module', plugins: ['typescript'] });
  } catch {
    return null;
  }
  // `Object.freeze` must be the platform's, as far as this file can say: see `rebindsObject`.
  if (rebindsObject(ast.program)) return null;
  const found = [];
  for (const statement of ast.program.body) {
    const decl = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (decl?.type !== 'VariableDeclaration') continue;
    for (const v of decl.declarations) {
      if (v.id.type === 'Identifier' && v.id.name === name) {
        found.push({ kind: decl.kind, init: v.init });
      }
    }
  }
  if (found.length !== 1 || found[0].kind !== 'const') return null;
  let init = found[0].init;
  if (init?.type === 'TSSatisfiesExpression') init = init.expression;
  const callee = init?.type === 'CallExpression' ? init.callee : null;
  if (
    callee?.type !== 'MemberExpression' ||
    callee.computed ||
    callee.object.type !== 'Identifier' ||
    callee.object.name !== 'Object' ||
    callee.property.type !== 'Identifier' ||
    callee.property.name !== 'freeze' ||
    init.arguments.length !== 1 ||
    init.arguments[0].type !== 'ObjectExpression'
  ) {
    return null;
  }
  const table = {};
  for (const prop of init.arguments[0].properties) {
    if (prop.type !== 'ObjectProperty' || prop.computed || prop.value.type !== 'StringLiteral') {
      return null;
    }
    const key =
      prop.key.type === 'Identifier'
        ? prop.key.name
        : prop.key.type === 'StringLiteral'
          ? prop.key.value
          : null;
    if (key === null || key === '__proto__' || Object.hasOwn(table, key)) return null;
    table[key] = prop.value.value;
  }
  return table;
}

/**
 * Read `AURORA_SOURCES` out of the seam as a plain object, or null when it cannot be read
 * STATICALLY — which is a failure, not a pass. Read by `frozenStringTable`, which parses the file
 * and refuses rather than guesses: anything but plain `name: 'class'` pairs in one
 * `Object.freeze({ … })` (a spread, a computed key, a call, a continued initializer) means
 * something is in that table this check cannot see, and an unseen source is exactly the one worth
 * catching. Pure.
 */
export function parseAuroraSources(text) {
  const sources = frozenStringTable(text, 'AURORA_SOURCES');
  if (sources === null) return null;
  // A class outside the reviewed two makes the whole table unreadable — a failure, not a skip.
  if (!Object.values(sources).every((cls) => SOURCE_CLASSES.includes(cls))) return null;
  return sources;
}

/** The config that carries the app's IDENTITY. `scripts/new-app.mjs` rewrites `name` here (and
 * everywhere else) during the bootstrap, so this is the one field that tells the unforked kit
 * apart from an app built on it. */
export const IDENTITY_CONFIG = 'wrangler.jsonc';

/**
 * Is this repo still the UNFORKED KIT, rather than an app built from it? The bootstrap
 * (`npm run new-app <app>`) renames the template everywhere, so the production config's `name`
 * is the answer — the same signal `isTemplateRepo()` in scripts/new-app.mjs reads, from the same
 * constant, which is why `TEMPLATE_KEBAB` is imported rather than retyped.
 *
 * WHAT IT IS FOR. "The kit ships closed" is a real guarantee and worth proving, but it is a
 * property OF THE KIT — the moment a fork registers its first source it stops being true, and a
 * proof that fails on the first legitimate adoption is a tax, not a control. So the emptiness
 * check below is conditioned on this: loud here, silent in a fork, with the invariants that must
 * hold EVERYWHERE (readable table, well-formed entries, class agreeing with the grant) left
 * unconditional. See DECISIONS 2026-08-21.
 *
 * A fork that never ran the bootstrap still answers `true` and is held to the kit's empty table.
 * That is the right way round: it has not renamed its resources either, so it is not yet an app,
 * and the failure names the bootstrap. Pure.
 */
export function isUnforkedTemplate(prodConfig) {
  return prodConfig?.name === TEMPLATE_KEBAB;
}

/**
 * The seam's source table checked AS A TABLE — independently of any grant, so a malformed entry
 * is caught before a binding for it exists rather than after. Three things:
 *
 *   • it parses statically (`sources === null` means it does not) — the cross-check below reads
 *     this table with a regex, and a table nothing can read is one nothing can verify;
 *   • every entry is a lowercase source name carrying one of the reviewed classes, because
 *     `sourceNameForBinding` lowercases, so an entry that is not lowercase can never match the
 *     binding it was written for and would fail later as the far more confusing "absent";
 *   • and, ONLY while this repo is still the unforked kit, that it is empty.
 *
 * Pure — `unforked` is passed in rather than read, so the emptiness rule is testable in both
 * states without touching the filesystem.
 */
export function sourceTableFailures(sources, unforked) {
  if (sources === null) {
    return [
      `${SOURCES_FILE}: AURORA_SOURCES could not be read statically, so nothing can verify what ` +
        'it grants. Keep it a plain object literal of `name: class` pairs inside the ' +
        '`Object.freeze({ … })` call — no spread, no computed key, no call.',
    ];
  }
  const failures = [];
  for (const [name, cls] of Object.entries(sources)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      failures.push(
        `${SOURCES_FILE}: AURORA_SOURCES key ${JSON.stringify(name)} is not a source name. ` +
          'A source name is the binding name minus its HYPERDRIVE_/VPC_ prefix, LOWERCASED ' +
          '(HYPERDRIVE_RET1_RO → ret1_ro) — anything else can never match the binding it is for.',
      );
    }
    if (!SOURCE_CLASSES.includes(cls)) {
      failures.push(
        `${SOURCES_FILE}: AURORA_SOURCES entry ${JSON.stringify(name)} has class ` +
          `${JSON.stringify(cls)} — must be one of ${SOURCE_CLASSES.join(' | ')}. The class picks ` +
          'the failure posture the seam takes when the read ledger is unwritable, so there is no ' +
          'safe default and no third option.',
      );
    }
  }
  if (unforked && Object.keys(sources).length > 0) {
    failures.push(
      `${SOURCES_FILE}: the kit itself binds no private database, so AURORA_SOURCES ships empty — ` +
        `found [${Object.keys(sources).join(', ')}]. If this is an app rather than the template, ` +
        'it has not been bootstrapped: run `npm run new-app <app-name>`, which renames the ' +
        'template (including this config\'s "name") and retires this check for good.',
    );
  }
  return failures;
}

/** Cross-check one config's granted bindings against the seam's source table. `sources` is null
 * when the table was unreadable — fail closed on every grant rather than skip the check. Pure. */
export function sourceRegistryFailures(label, cfg, granted, sources) {
  const failures = [];
  for (const [kind, { idKey }] of Object.entries(GATED_BINDINGS)) {
    const declared = Array.isArray(cfg?.[kind]) ? cfg[kind] : [];
    const grants = Array.isArray(granted?.[kind]) ? granted[kind] : [];
    for (const entry of declared) {
      const grant = grants.find((g) => g && typeof g === 'object' && g.id === entry?.[idKey]);
      if (!grant || !SOURCE_CLASSES.includes(grant.class)) continue; // already reported upstream
      if (sources === null) {
        failures.push(
          `${label}: could not read AURORA_SOURCES from ${SOURCES_FILE} statically, so the class ` +
            `of ${JSON.stringify(entry.binding)} cannot be verified against the code that acts ` +
            'on it. Keep that table a plain object literal of name: class pairs.',
        );
        continue;
      }
      const name = sourceNameForBinding(entry.binding);
      const registered = sources[name];
      if (registered === undefined) {
        failures.push(
          `${label}: binding ${JSON.stringify(entry.binding)} is granted but source ` +
            `${JSON.stringify(name)} is absent from AURORA_SOURCES in ${SOURCES_FILE}. ` +
            'A query against it cannot be defined, and nothing would record a read — add it in ' +
            'this same pull request.',
        );
      } else if (registered !== grant.class) {
        failures.push(
          `${label}: ${JSON.stringify(name)} is "${grant.class}" in ${ALLOWLIST_FILE} but ` +
            `"${registered}" in ${SOURCES_FILE}. The seam acts on the second one, so this grant ` +
            'claims a protection the running code would not apply.',
        );
      }
    }
  }
  return failures;
}

// The private HTTP service transport's table. An `http` grant is cross-checked against it the way a
// database grant is cross-checked against AURORA_SOURCES: the table is what the RUNNING CODE
// consults — it refuses an unregistered service and names the secret it attaches as the
// credential — so a grant with no entry is a binding nothing can call, and a binding reachable as
// both a database and an HTTP service is two readings of one grant.
export const PRIVATE_SERVICES_FILE = 'src/data/privateServices.ts';

/** MIRRORS `PRIVATE_SERVICE_HOST` in src/data/privateServices.ts (this plain-Node script cannot
 * import TypeScript): a bare lowercase DNS name with at least two labels — no scheme, port, path,
 * userinfo or trailing dot. Pinned from both sides by the tests. */
export const PRIVATE_SERVICE_HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** An `http`-class binding needs its host in the same config, as `vars.<BINDING>_HOST`: the
 * transport builds every URL from it, so app code never hardcodes the host, and a config that binds
 * the service without saying where it is would fail on the first call instead of here. On a DB
 * Israel app central delivery sets the var for the deployed Worker; the config's copy serves the
 * app's own tests and local runs, and keeps the binding and its host reviewed together. Pure. */
export function hostVarFailures(label, cfg, binding) {
  if (typeof binding !== 'string' || !binding.startsWith('VPC_')) return []; // reported upstream
  // The transport finds the binding as `VPC_` + the service name UPPERCASED, and the gate derives
  // the service name by lowercasing — so only an upper-snake name round-trips. `VPC_example_api`
  // would pass here and be `binding_missing` on every call. A name ending `_HOST` would be another
  // binding's host var (`VPC_A_HOST` is `VPC_A`'s), so the two could never both be set.
  if (!/^VPC_[A-Z][A-Z0-9_]*$/.test(binding) || binding.endsWith('_HOST')) {
    return [
      `${label}: HTTP service binding ${JSON.stringify(binding)} must be VPC_ plus an ` +
        'UPPER_SNAKE_CASE service name not ending in _HOST — the transport looks it up as ' +
        'VPC_<SERVICE> from the PRIVATE_SERVICES name, and <BINDING>_HOST is its host var.',
    ];
  }
  const hostVar = `${binding}_HOST`;
  const host = cfg?.vars?.[hostVar];
  if (typeof host === 'string' && PRIVATE_SERVICE_HOST.test(host)) return [];
  return [
    `${label}: HTTP service binding ${JSON.stringify(binding)} needs "vars": { "${hostVar}": ` +
      '"<host>" } in the same config — a bare lowercase host name, no scheme, port or path' +
      (host === undefined ? '' : `; found ${JSON.stringify(host)}`) +
      `. ${PRIVATE_SERVICES_FILE} builds every URL from it, so the host is never hardcoded.`,
  ];
}

/**
 * Read `PRIVATE_SERVICES` out of the transport as `{ service: 'SECRET_NAME' }`, or null when it
 * cannot be read STATICALLY — a failure, as for `parseAuroraSources`: after the recognized
 * `name: 'SECRET'` pairs and comments are removed, any residue means an entry this check cannot
 * see. Read by `frozenStringTable`, a real parser: a doc example, a commented-out table or a
 * continued initializer is never read as the table. Pure.
 */
export function parsePrivateServices(text) {
  // Key and value SHAPES are `privateServiceTableFailures`' to judge, with messages that say which.
  return frozenStringTable(text, 'PRIVATE_SERVICES');
}

/**
 * The transport's table checked AS A TABLE, independently of any grant — the same three rules as
 * `sourceTableFailures`: it parses statically, every key is a service name (`VPC_*` minus the
 * prefix, lowercased) and every value a secret name, and the unforked kit's table is empty.
 * `services === undefined` means the file is ABSENT — a fork that took this gate through
 * /kit-upgrade before the transport — and is silent here; any `http` grant then fails in
 * `privateServiceRegistryFailures`, which names the file. Pure.
 */
export function privateServiceTableFailures(services, unforked) {
  if (services === undefined) return [];
  if (services === null) {
    return [
      `${PRIVATE_SERVICES_FILE}: PRIVATE_SERVICES could not be read statically, so nothing can ` +
        "verify what it grants. Keep it a plain object literal of `name: 'SECRET_NAME'` pairs " +
        'inside ONE `const … = Object.freeze({ … })` declaration, with nothing after the `})` but `satisfies` — no spread, no computed key, no call.',
    ];
  }
  const failures = [];
  for (const [name, secret] of Object.entries(services)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      failures.push(
        `${PRIVATE_SERVICES_FILE}: PRIVATE_SERVICES key ${JSON.stringify(name)} is not a service ` +
          'name. A service name is the binding name minus its VPC_ prefix, LOWERCASED ' +
          '(VPC_EXAMPLE_API → example_api) — anything else can never match its binding.',
      );
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(secret) || /^(VPC|HYPERDRIVE)_/.test(secret)) {
      failures.push(
        `${PRIVATE_SERVICES_FILE}: PRIVATE_SERVICES entry ${JSON.stringify(name)} names secret ` +
          `${JSON.stringify(secret)}, which is not a Worker secret name (UPPER_SNAKE_CASE, and ` +
          'not a VPC_/HYPERDRIVE_ binding or host var). The value is the NAME of the secret ' +
          'holding the credential, never the credential.',
      );
    }
  }
  if (unforked && Object.keys(services).length > 0) {
    failures.push(
      `${PRIVATE_SERVICES_FILE}: the kit itself calls no private service, so PRIVATE_SERVICES ` +
        `ships empty — found [${Object.keys(services).join(', ')}]. If this is an app rather ` +
        'than the template, run `npm run new-app <app-name>` first.',
    );
  }
  return failures;
}

/**
 * Cross-check one config's `vpc_services` bindings against the transport's table. An `http` grant
 * needs its service registered in PRIVATE_SERVICES and NOT in AURORA_SOURCES; a database-class
 * `vpc_services` grant must not be registered in PRIVATE_SERVICES. `services` is undefined (file
 * absent) or null (unreadable): either fails every `http` grant rather than skipping it. Pure.
 */
export function privateServiceRegistryFailures(label, cfg, granted, services, sources) {
  const failures = [];
  const { idKey } = GATED_BINDINGS.vpc_services;
  const declared = Array.isArray(cfg?.vpc_services) ? cfg.vpc_services : [];
  const grants = Array.isArray(granted?.vpc_services) ? granted.vpc_services : [];
  for (const entry of declared) {
    const grant = grants.find((g) => g && typeof g === 'object' && g.id === entry?.[idKey]);
    if (!grant || typeof entry?.binding !== 'string') continue; // already reported upstream
    const name = sourceNameForBinding(entry.binding);
    const registered = services ? Object.hasOwn(services, name) : false;
    if (grant.class === HTTP_SERVICE_CLASS) {
      if (!services) {
        failures.push(
          `${label}: HTTP service binding ${JSON.stringify(entry.binding)} is granted but ` +
            `PRIVATE_SERVICES in ${PRIVATE_SERVICES_FILE} ` +
            (services === undefined
              ? 'does not exist. Take the file from the kit (/kit-upgrade) — it is the transport ' +
                'that attaches the credential, and the only way to call the service.'
              : 'could not be read statically. Keep it a plain object literal of name: secret pairs.'),
        );
        continue;
      }
      if (!registered) {
        failures.push(
          `${label}: HTTP service binding ${JSON.stringify(entry.binding)} is granted but service ` +
            `${JSON.stringify(name)} is absent from PRIVATE_SERVICES in ${PRIVATE_SERVICES_FILE}. ` +
            'Register it with the name of the secret that holds its credential, in this same pull ' +
            'request.',
        );
      }
      if (sources && Object.hasOwn(sources, name)) {
        failures.push(
          `${label}: ${JSON.stringify(name)} is an "${HTTP_SERVICE_CLASS}" grant in ` +
            `${ALLOWLIST_FILE} but is registered as a database in AURORA_SOURCES (${SOURCES_FILE}). ` +
            'One binding is one kind of thing — remove the AURORA_SOURCES entry.',
        );
      }
    } else if (registered) {
      failures.push(
        `${label}: ${JSON.stringify(name)} is a "${grant.class}" database grant in ` +
          `${ALLOWLIST_FILE} but is registered as an HTTP service in PRIVATE_SERVICES ` +
          `(${PRIVATE_SERVICES_FILE}). Make the grant "${HTTP_SERVICE_CLASS}", or remove the entry.`,
      );
    }
  }
  return failures;
}

/** Normalize one allowlist grant. Grants are objects — `{ "id": "…", "class": "client" }` — so
 * every one states whose data is behind it. A bare id string is REJECTED rather than defaulted:
 * there is no safe default here. Defaulting to `internal` silently downgrades a client database
 * to the fire-and-forget ledger path, and defaulting to `client` would arm-gate a grant whose
 * author never considered the question. Returning the error makes the author answer it. Pure. */
export function grantFailure(label, kind, grant) {
  if (typeof grant === 'string') {
    return (
      `${label}: ${ALLOWLIST_FILE} grants ${kind} ${JSON.stringify(grant)} as a bare id. Grants ` +
      `carry a class now: { "id": ${JSON.stringify(grant)}, "class": "client" | "internal" }. ` +
      'The class picks the read-ledger failure posture (client = fail-closed write-ahead), so it ' +
      'has no safe default — say which it is.'
    );
  }
  if (!grant || typeof grant !== 'object' || typeof grant.id !== 'string' || grant.id === '') {
    return `${label}: ${ALLOWLIST_FILE} has a ${kind} grant with no "id": ${JSON.stringify(grant)}`;
  }
  const classes = grantClassesFor(kind);
  if (grant.class === HTTP_SERVICE_CLASS && !classes.includes(HTTP_SERVICE_CLASS)) {
    return (
      `${label}: ${ALLOWLIST_FILE} grant ${JSON.stringify(grant.id)} is a ${kind} grant with ` +
      `"class": "${HTTP_SERVICE_CLASS}". Only a vpc_services binding can front an HTTP service — ` +
      `a ${kind} binding is ${kind === 'hyperdrive' ? 'always a database' : 'a whole tunnel'}, so ` +
      `it must be one of ${SOURCE_CLASSES.join(' | ')}.`
    );
  }
  if (!classes.includes(grant.class)) {
    return (
      `${label}: ${ALLOWLIST_FILE} grant ${JSON.stringify(grant.id)} has "class": ` +
      `${JSON.stringify(grant.class)} — must be one of ${classes.join(' | ')}. ` +
      'It records whether client data is behind this binding, and it selects the failure posture ' +
      'src/data/aurora.ts takes when the read ledger is unwritable' +
      (kind === 'vpc_services'
        ? `; "${HTTP_SERVICE_CLASS}" marks an HTTP service reached through src/data/privateServices.ts.`
        : '.')
    );
  }
  return null;
}

/** Gated bindings declared under an `env.*` block are REFUSED, not merged. Wrangler would honour
 * them, but the allowlist keys grants by FILE and every check here reads the top level — the
 * kit's shape is one config file per environment precisely so that "which bindings does this
 * deploy carry" has a one-file answer a code owner can review. CialDNB/Arena-2 carried its real
 * Hyperdrive binding under an env block and this gate reported zero failures; that silence is
 * the bug this function removes. The key's PRESENCE is the finding — even an empty nested list
 * is a place a binding lands unreviewed later. Pure — used by the test. */
export function nestedGatedBindingFailures(label, cfg) {
  const failures = [];
  if (!cfg?.env || typeof cfg.env !== 'object') return failures;
  for (const [envName, block] of Object.entries(cfg.env)) {
    if (!block || typeof block !== 'object') continue;
    for (const kind of Object.keys(GATED_BINDINGS)) {
      if (block[kind] === undefined) continue;
      failures.push(
        `${label}: "${kind}" is declared under env.${envName}. The kit deploys one config file ` +
          'per environment with top-level bindings — that is the shape the allowlist grants ' +
          'and this gate reads, so a binding nested in an env block would ship ungated. Move ' +
          'it to the top level of the per-environment config.',
      );
    }
  }
  return failures;
}

/** `unsafe` is refused wherever it appears, top level or env block — the KEY's presence is the
 * finding. Wrangler uploads each `unsafe.bindings[]` entry's `type` verbatim as first-class
 * binding metadata, so `{ "type": "hyperdrive", "id": … }` under `unsafe` mints exactly the live
 * private-database binding the allowlist exists to review, with none of these gates fired
 * (verified against wrangler's own serializer). The gate cannot classify what it cannot
 * enumerate, and kit configs declare bindings only with first-class keys. Pure — used by the
 * test. */
export function unsafeBindingFailures(label, cfg) {
  const failures = [];
  const spots = [['', cfg]];
  if (cfg?.env && typeof cfg.env === 'object') {
    for (const [envName, block] of Object.entries(cfg.env)) spots.push([`env.${envName}.`, block]);
  }
  for (const [where, block] of spots) {
    if (block && typeof block === 'object' && block.unsafe !== undefined) {
      failures.push(
        `${label}: "${where}unsafe" is declared. Wrangler uploads unsafe.bindings[].type ` +
          'verbatim as first-class binding metadata, so a { "type": "hyperdrive" } entry mints ' +
          'a live private-database binding no allowlist ever reviewed. Kit configs declare ' +
          'bindings only with first-class keys — remove the unsafe block, or promote the ' +
          `binding to its gated top-level key plus a grant in ${ALLOWLIST_FILE}.`,
      );
    }
  }
  return failures;
}

/** Failures for one config against its allowlist entry. `granted` is undefined when the config
 * has no entry at all — which fails, because an absent entry and an empty one must not read the
 * same: silence is how a config quietly escapes the gate. The NAME check is not cosmetic; the
 * semgrep fence (`hyperdrive-access-outside-data-layer`) matches on the HYPERDRIVE_/VPC_ prefix,
 * so a binding named anything else would reach route code with the fence none the wiser. The two
 * controls only work as a pair. Pure — used by the test. */
export function bindingAllowlistFailures(label, cfg, granted) {
  if (!cfg) return [`${label}: not valid JSONC`];
  if (!granted || typeof granted !== 'object') {
    return [
      `${label}: no entry in ${ALLOWLIST_FILE} — every deploying config must be listed, ` +
        'with empty lists if it binds nothing. An absent entry is not an empty one.',
    ];
  }
  const failures = [];
  // Ids this config actually binds whose grant is client-class. Collected across all three kinds
  // and checked once at the end, so the arming message names every one rather than the first.
  const boundClientIds = [];
  for (const [kind, { idKey, prefix }] of Object.entries(GATED_BINDINGS)) {
    const declared = cfg[kind];
    if (declared !== undefined && !Array.isArray(declared)) {
      failures.push(`${label}: "${kind}" must be an array, found ${JSON.stringify(declared)}`);
      continue;
    }
    const rawGrants = Array.isArray(granted[kind]) ? granted[kind] : [];
    // Validate the grants BEFORE reading them, so a malformed grant is reported as malformed
    // rather than silently failing to match a binding it was meant to authorize.
    const grants = [];
    for (const grant of rawGrants) {
      const bad = grantFailure(label, kind, grant);
      if (bad) {
        failures.push(bad);
        continue;
      }
      grants.push(grant);
    }
    // One id, one grant. Every reader below takes the FIRST grant for an id, so a second one —
    // above all with another class — would be classified by whichever came first: `http` before
    // `client` would skip AURORA_SOURCES and READ_AUDIT arming for a client database. Refused
    // outright, whatever the classes, in either order.
    const counts = new Map();
    for (const g of grants) counts.set(g.id, (counts.get(g.id) ?? 0) + 1);
    for (const [id, n] of counts) {
      if (n < 2) continue;
      const classes = [...new Set(grants.filter((g) => g.id === id).map((g) => g.class))];
      failures.push(
        `${label}: ${ALLOWLIST_FILE} grants ${kind} ${idKey} ${JSON.stringify(id)} ${n} times` +
          (classes.length > 1 ? `, as ${classes.join(' and ')}` : '') +
          '. One id is one grant with one class — keep exactly one.',
      );
    }
    const allowed = [...counts.keys()];
    const seen = [];
    for (const entry of declared ?? []) {
      const id = entry?.[idKey];
      const name = entry?.binding;
      if (typeof name !== 'string' || !name.startsWith(prefix)) {
        failures.push(
          `${label}: ${kind} binding ${JSON.stringify(name)} must be named ${prefix}* — the ` +
            'semgrep data fence matches on that prefix, so any other name reaches route code ' +
            'unguarded.',
        );
      }
      if (typeof id !== 'string' || id === '') {
        failures.push(`${label}: ${kind} binding ${JSON.stringify(name)} has no "${idKey}".`);
        continue;
      }
      if (/[<>]/.test(id)) {
        failures.push(
          `${label}: ${kind} "${idKey}": ${JSON.stringify(id)} is an unfilled placeholder — ` +
            'paste the id from the Cial-Pulumi-VPC stack output.',
        );
        continue;
      }
      seen.push(id);
      const grant = grants.find((g) => g.id === id);
      if (!grant) {
        failures.push(
          `${label}: ${kind} ${idKey} ${JSON.stringify(id)} is not in ${ALLOWLIST_FILE}. ` +
            'Add it there in the SAME pull request — that pairing is what the code owner reviews.',
        );
        continue;
      }
      if (grant.class === 'client') boundClientIds.push(`${kind} ${idKey} ${id}`);
      if (grant.class === HTTP_SERVICE_CLASS) failures.push(...hostVarFailures(label, cfg, name));
    }
    for (const id of allowed) {
      if (!seen.includes(id)) {
        failures.push(
          `${label}: ${ALLOWLIST_FILE} grants ${kind} ${idKey} ${JSON.stringify(id)}, which this ` +
            'config does not bind. Remove the grant — one nobody uses is one nobody re-examines.',
        );
      }
    }
  }
  // FAIL CLOSED on the arming flag. A client-class binding is the compensating-control case: the
  // whole reason client data is allowed on a shared Cloudflare account is that reads are
  // attributed. A config that grants itself one without declaring the ledger armed has taken the
  // permission and skipped the control, so it does not deploy. Nothing goes red today — the kit
  // binds no private database, so `boundClientIds` is empty on every existing config and this is
  // dormant until the first client-class grant lands.
  if (boundClientIds.length > 0 && !readAuditArmed(cfg)) {
    failures.push(
      `${label}: binds client-class private database(s) [${boundClientIds.join(', ')}] but does ` +
        `not set "vars": { "${READ_AUDIT_VAR}": "${READ_AUDIT_ARMED}" }. Read attribution is the ` +
        'compensating control for client data on a shared Cloudflare account — the binding and ' +
        'the armed ledger land together, or neither does. See docs/DATA-ROUTES.md.',
    );
  }
  return failures;
}

export function checkBindingAllowlist(root = ROOT) {
  let allowlist;
  try {
    allowlist = parseJsonc(readFileSync(join(root, ALLOWLIST_FILE), 'utf8'));
  } catch (err) {
    // Fail closed: no readable allowlist means nothing is approved, not that everything is.
    // The remedy has to be in the message — a fork adopting scripts/ through /kit-upgrade does
    // not receive this root file, and has no other pointer to what it is.
    return [
      `${ALLOWLIST_FILE}: could not read (${err.message}). This file lists which private-database ` +
        'binding ids each deploying config may bind; it is the only reviewed grant, because ' +
        'Cloudflare has no per-Worker scope for one. Create it with an entry per deploying ' +
        'config — empty lists if the app binds nothing. See docs/DATA-ROUTES.md.',
    ];
  }
  if (!allowlist || typeof allowlist !== 'object') return [`${ALLOWLIST_FILE}: not valid JSONC`];
  // null = unreadable, which sourceRegistryFailures turns into a failure PER GRANT rather than a
  // skip. A missing seam file on a fork that binds nothing is therefore silent, and on a fork that
  // binds something it is loud — which is the right way round.
  let sources = null;
  try {
    sources = parseAuroraSources(readFileSync(join(root, SOURCES_FILE), 'utf8'));
  } catch {
    sources = null;
  }
  const failures = [];
  // The kit's "ships closed" proof: the source table stays EMPTY while this repo is still the
  // unforked template — the bootstrap rewrites the identity config's `name`, which is the signal
  // isUnforkedTemplate reads. Checked ONCE, here, independently of any grant; the per-config
  // checks run in the loop below. An unreadable identity config parses as null — NOT as the
  // template — and the loop pushes its own read failure for it, so nothing passes silently on
  // the strength of an unreadable file.
  let identityCfg = null;
  try {
    identityCfg = parseJsonc(readFileSync(join(root, IDENTITY_CONFIG), 'utf8'));
  } catch {
    identityCfg = null;
  }
  failures.push(...sourceTableFailures(sources, isUnforkedTemplate(identityCfg)));
  // The transport's table: undefined when the file is absent (a fork that took this gate before
  // the transport, silent until it grants an `http` binding), null when it cannot be read.
  let services;
  try {
    services = parsePrivateServices(readFileSync(join(root, PRIVATE_SERVICES_FILE), 'utf8'));
  } catch (err) {
    services = err?.code === 'ENOENT' ? undefined : null;
  }
  failures.push(...privateServiceTableFailures(services, isUnforkedTemplate(identityCfg)));
  // The canonical pair is checked whether or not it exists on disk; everything else wrangler
  // could be pointed at is DISCOVERED rather than assumed away. A failed listing is a failure —
  // a root this gate cannot enumerate is a root it cannot clear.
  let discovered = [];
  try {
    discovered = wranglerConfigsOnDisk(root);
  } catch (err) {
    failures.push(`could not list wrangler configs (${err.message}) — nothing can be cleared.`);
  }
  const files = [...new Set([...DEPLOYING_CONFIGS, ...discovered])];
  for (const file of files) {
    if (file.toLowerCase().endsWith('.toml')) {
      failures.push(
        `${file}: this gate reads JSONC and cannot inspect a TOML config — and a config it ` +
          'cannot inspect could carry a private-database binding it cannot see. Kit configs ' +
          'are JSONC; convert it or remove it.',
      );
      continue;
    }
    let cfg = null;
    try {
      cfg = parseJsonc(readFileSync(join(root, file), 'utf8'));
    } catch (err) {
      failures.push(configReadFailure(file, err));
      continue;
    }
    if (cfg === null) {
      failures.push(`${file}: not valid JSONC`);
      continue;
    }
    if (typeof cfg !== 'object' || Array.isArray(cfg)) {
      failures.push(
        `${file}: not a JSONC object — a config the gate cannot read as an object is one it ` +
          'cannot clear.',
      );
      continue;
    }
    // Nested env blocks and `unsafe` are refused everywhere, canonical or discovered.
    failures.push(...nestedGatedBindingFailures(file, cfg));
    failures.push(...unsafeBindingFailures(file, cfg));
    // wrangler.test.jsonc is the one config the kit itself names as never-deploying, and a fork
    // testing its data layer declares its Hyperdrive binding THERE with a localConnectionString —
    // the local-simulator shape (vitest-pool-workers). Those entries reach no real database, and
    // laundering their fake ids into the reviewed allowlist (plus arming a config that never
    // runs) would teach people the allowlist holds fakes. Exempt — in this ONE file, by name.
    // The same entry anywhere else stays fully gated, because a deployed config ignores
    // localConnectionString and honours the id.
    let inspected = cfg;
    if (file === 'wrangler.test.jsonc' && Array.isArray(cfg.hyperdrive)) {
      inspected = {
        ...cfg,
        hyperdrive: cfg.hyperdrive.filter((e) => typeof e?.localConnectionString !== 'string'),
      };
    }
    // The canonical pair must have an allowlist entry even when it binds nothing — absent is
    // not empty. A DISCOVERED config joins the full regime the moment it either declares a
    // gated binding (a non-empty list, or a malformed non-array) or has an allowlist entry; one
    // that does neither (wrangler.test.jsonc) has nothing to gate. The asymmetry is deliberate:
    // requiring an entry for the test config would make the gate noisier without making it
    // tighter, but a discovered config that binds a gated kind gets the whole treatment,
    // including "no entry is a failure".
    const granted = allowlist[file];
    const declaresGated = Object.keys(GATED_BINDINGS).some((kind) => {
      const declared = inspected[kind];
      return declared !== undefined && (!Array.isArray(declared) || declared.length > 0);
    });
    if (DEPLOYING_CONFIGS.includes(file) || granted !== undefined || declaresGated) {
      failures.push(...bindingAllowlistFailures(file, inspected, granted));
      failures.push(...sourceRegistryFailures(file, inspected, granted, sources));
      failures.push(...privateServiceRegistryFailures(file, inspected, granted, services, sources));
    }
  }
  // An allowlist entry naming a config that is not on disk is a grant nobody consumes. Dead
  // approvals accumulate exactly like the stale grants the per-config check flags — and a
  // typo'd key ("wrangler-mcp.jsonc" for "wrangler.mcp.jsonc") would otherwise approve nothing
  // while reading as if it did.
  for (const key of Object.keys(allowlist)) {
    if (!files.includes(key)) {
      failures.push(
        `${ALLOWLIST_FILE}: entry ${JSON.stringify(key)} names a config that does not exist. ` +
          'Remove it, or fix the filename — an entry that matches nothing approves nothing ' +
          'while reading as if it did.',
      );
    }
  }
  return failures;
}

/** Failures for one parsed config's AI vars: the top-level `vars` and every `env.<name>.vars`
 * (wrangler does not inherit `vars` into an environment, so each block stands alone, with its own
 * APP_ENV). A var that is absent is not checked — the runtime's own default or refusal applies —
 * but one that is present must be a value the AI client accepts. Pure — used by the test. */
export function aiConfigFailures(label, cfg) {
  if (!cfg || typeof cfg !== 'object') return []; // unparseable: the edge-hardening check says so
  const blocks = [['vars', cfg.vars]];
  if (cfg.env && typeof cfg.env === 'object') {
    for (const [envName, block] of Object.entries(cfg.env)) {
      if (block && typeof block === 'object') blocks.push([`env.${envName}.vars`, block.vars]);
    }
  }
  const failures = [];
  for (const [where, vars] of blocks) {
    if (!vars || typeof vars !== 'object') continue;
    for (const key of MODEL_VARS) {
      if (key in vars && !isAllowedModel(vars[key])) {
        failures.push(
          `${label}: ${where}.${key} is ${JSON.stringify(vars[key])} — not on the AI client's ` +
            'model allowlist (src/ai/policyVocabulary.mjs), so every AI call on it fails with ' +
            '503 ai_model_not_allowed.',
        );
      }
    }
    if (INFERENCE_GEO_VAR in vars) {
      const geo = resolveInferenceGeo(vars[INFERENCE_GEO_VAR], vars.APP_ENV);
      if (geo === 'global_in_production') {
        failures.push(
          `${label}: ${where}.${INFERENCE_GEO_VAR} is "global" with APP_ENV "production" — ` +
            'production pins inference to "us" (PIA C6); "any location" there is a DPO-assessed ' +
            'exception, not a var. The AI client refuses every call with 503 ai_unconfigured.',
        );
      } else if (geo === 'invalid') {
        failures.push(
          `${label}: ${where}.${INFERENCE_GEO_VAR} is ${JSON.stringify(vars[INFERENCE_GEO_VAR])} ` +
            '— not a region the AI client accepts (unset, "us", or "global" outside production), ' +
            'so every AI call fails with 503 ai_unconfigured.',
        );
      }
    }
  }
  return failures;
}

export function checkAiConfig(root = ROOT) {
  const failures = [];
  for (const file of deployingConfigFiles(root, failures)) {
    let cfg;
    try {
      cfg = parseJsonc(readFileSync(join(root, file), 'utf8'));
    } catch (err) {
      failures.push(configReadFailure(file, err));
      continue;
    }
    failures.push(...aiConfigFailures(file, cfg));
  }
  return failures;
}

// The agent's arming vocabulary is IMPORTED from src/ai/agentVocabulary.mjs — the module the
// runtime predicate (src/ai/agentArming.ts) reads — never restated here: the value this gate
// enforces and the value the runtime honours are one definition (the readAuditVocabulary pattern;
// DECISIONS 2026-09-25 rejection g recorded the move for when the runtime landed, which P2-2 is).
// Re-exported, as READ_AUDIT_* are above, because this gate's tests already import these names
// from here; test/platform/edge-hardening.test.mjs pins each re-export to the vocabulary's own
// object by identity.
//
// VAULT (src/env.ts, the dormant second-account offsite bucket) copies every verified backup.
// Backups exclude every `agent_*` table since P2-1, so the vault holds no transcript; an armed
// block that binds it must still DECLARE the bucket's lifecycle expiry, because it remains a copy
// of personal data with no retention in code (PIA §5). Nothing in the Worker reads that var. The
// live verification of the lifecycle rule is C19's (P3b's check-r2-lifecycle.mjs).
export {
  AGENT_ARMABLE_ENVS,
  AGENT_ARMING_RECORD_VAR,
  AGENT_ENABLED_VALUES,
  AGENT_ENABLED_VAR,
  AGENT_REAPER_CRON,
  AGENT_RETENTION_VAR,
  AGENT_RUN_BINDING,
  AGENT_RUN_CLASS,
  positiveDays,
  VAULT_BINDING,
  VAULT_RETENTION_VAR,
};

const DAY_MS = 86_400_000;
// Workflows' duration units, in days. A month and a year are rounded UP (31 and 366 days), so a
// comparison against the transcript retention errs toward failing.
const DURATION_DAYS = {
  second: 1 / 86_400,
  minute: 1 / 1_440,
  hour: 1 / 24,
  day: 1,
  week: 7,
  month: 31,
  year: 366,
};

/**
 * A Workflows retention duration in days, or null when it is not one. Workflows accept a duration
 * string (`"3 days"`, `"1 week"`) or a whole number of milliseconds. Pure.
 */
export function workflowDurationDays(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value / DAY_MS : null;
  }
  if (typeof value !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?) (second|minute|hour|day|week|month|year)s?$/.exec(value.trim());
  if (!m || Number(m[1]) <= 0) return null;
  return Number(m[1]) * DURATION_DAYS[m[2]];
}

// Where the installed wrangler describes the config it accepts. Its WorkflowBinding is the list of
// fields `wrangler deploy` knows for a Workflow binding: one it does not know is validated with a
// warning and left out of what it uploads.
export const WRANGLER_SCHEMA_FILE = 'node_modules/wrangler/config-schema.json';

/** The answer when nobody asked the toolchain: the fail-closed one. */
const RETENTION_UNCHECKED = Object.freeze({
  ok: false,
  why: 'nothing checked whether the installed wrangler deploys "default_retention"',
});

/**
 * Whether the installed wrangler deploys a Workflow binding's `default_retention`, read from its own
 * config schema: `{ ok: true }` or `{ ok: false, why }`. wrangler 4.124 does not — it warns
 * ("Unexpected fields found in workflows field") and builds the Workflow it uploads from
 * script_name, class_name, limits and schedules only — so a config carrying the field would keep
 * instance state for the account default while this gate certified PIA C9. The schema is the
 * mechanical proxy for "wrangler applies it"; P2 confirms the real expiry on staging. Pure.
 */
export function workflowRetentionSupport(schemaText) {
  let schema;
  try {
    schema = JSON.parse(schemaText);
  } catch {
    return { ok: false, why: `${WRANGLER_SCHEMA_FILE} is not valid JSON` };
  }
  const props = schema?.definitions?.WorkflowBinding?.properties;
  if (!props || typeof props !== 'object') {
    return { ok: false, why: `${WRANGLER_SCHEMA_FILE} defines no WorkflowBinding` };
  }
  if (!Object.hasOwn(props, 'default_retention')) {
    return {
      ok: false,
      why:
        'the installed wrangler\'s WorkflowBinding has no "default_retention" (it warns on the ' +
        'field and deploys the Workflow without it)',
    };
  }
  return { ok: true };
}

function readWorkflowRetentionSupport(root) {
  try {
    return workflowRetentionSupport(readFileSync(join(root, WRANGLER_SCHEMA_FILE), 'utf8'));
  } catch (err) {
    return {
      ok: false,
      why: `could not read ${WRANGLER_SCHEMA_FILE} (${err.code ?? err.message}) — run npm ci`,
    };
  }
}

/**
 * A config's blocks as `[where, block, workerName]`: the top level, then each `env.<name>` block,
 * which deploys as its own `name` or, without one, as `<top name>-<env>`. Pure.
 */
function configBlocks(cfg) {
  const blocks = [['', cfg, cfg.name]];
  if (cfg.env && typeof cfg.env === 'object') {
    for (const [envName, block] of Object.entries(cfg.env)) {
      if (!block || typeof block !== 'object') continue;
      const worker = block.name ?? (cfg.name ? `${cfg.name}-${envName}` : undefined);
      blocks.push([`env.${envName}.`, block, worker]);
    }
  }
  return blocks;
}

/** A Workflow binding's definition lives in this Worker: no `script_name`, or its own name. */
function definedHere(wf, worker) {
  return wf?.script_name === undefined || wf.script_name === worker;
}

const definitionKey = (worker, workflow) => `${worker}\u0000${workflow}`;

/**
 * Every Workflow DEFINED by a block of these configs, keyed by the Worker that defines it and the
 * Workflow's name — where its instance retention is set, and so where an external binding's is
 * read. `configs` is `[label, parsedConfig][]`. Pure.
 */
export function workflowDefinitions(configs) {
  const definitions = new Map();
  for (const [label, cfg] of configs) {
    if (!cfg || typeof cfg !== 'object') continue;
    for (const [where, block, worker] of configBlocks(cfg)) {
      if (!worker) continue;
      for (const wf of Array.isArray(block.workflows) ? block.workflows : []) {
        if (!definedHere(wf, worker) || typeof wf?.name !== 'string') continue;
        definitions.set(definitionKey(worker, wf.name), { at: `${label}: ${where}workflows`, wf });
      }
    }
  }
  return definitions;
}

/**
 * The environment the LADDER judges a block by: the top level of a canonical deploying config is
 * the environment that config deploys (CONFIG_APP_ENV); every other block — an `env.<name>` block,
 * any block of a discovered config — deploys a Worker this gate cannot place, so it is judged as
 * production, the rung that opens last. Pure.
 */
function judgedAgentEnv(label, where) {
  return pinnedAgentEnv(label, where) ?? 'production';
}

/** The APP_ENV a block must declare, when the gate knows it: a canonical config's top level. */
function pinnedAgentEnv(label, where) {
  return where === '' && Object.hasOwn(CONFIG_APP_ENV, label) ? CONFIG_APP_ENV[label] : undefined;
}

/**
 * Failures for one parsed config's agent arming: the top level and every `env.<name>` block, each
 * judged on ITS OWN `vars`, `workflows` and `r2_buckets` — wrangler inherits none of the three into
 * an environment, so each block deploys exactly what it declares (`triggers` IS inherited, so the
 * reaper cron is read from the block's own `triggers`, else the top level's). `context.retention`
 * is the installed wrangler's answer from `workflowRetentionSupport`; without one, an armed block
 * that binds a Workflow fails. `context.definitions` (from `workflowDefinitions`) is where a
 * binding to another Worker's Workflow finds the retention that actually applies to it.
 * `context.armableEnvs` is the ladder, AGENT_ARMABLE_ENVS unless a TEST passes the rungs P2-9 and
 * P2-11 will open; `checkAgentArming` (the CLI) never does. Pure — used by the test.
 */
export function agentArmingFailures(
  label,
  cfg,
  {
    retention: toolchain = RETENTION_UNCHECKED,
    definitions = new Map(),
    armableEnvs = AGENT_ARMABLE_ENVS,
  } = {},
) {
  if (!cfg || typeof cfg !== 'object') return []; // unparseable: the edge-hardening check says so
  const failures = [];
  for (const [where, block, worker] of configBlocks(cfg)) {
    // The flag is reviewed where the controls are: in the config. A Worker secret of the same name
    // would reach the runtime as the same string with none of this checked, so declaring one is
    // refused. (One set by `wrangler secret put` without a declaration is beyond a static gate —
    // the runtime re-checks arming itself.)
    const secrets = Array.isArray(block.secrets?.required) ? block.secrets.required : [];
    if (secrets.includes(AGENT_ENABLED_VAR)) {
      failures.push(
        `${label}: ${where}secrets.required lists ${AGENT_ENABLED_VAR}. The agent is armed by a ` +
          'reviewed "vars" entry, next to the controls this gate checks — never by a secret, ' +
          'which nobody reviews and nothing here can see.',
      );
    }
    const vars = block.vars && typeof block.vars === 'object' ? block.vars : {};
    if (!(AGENT_ENABLED_VAR in vars)) continue;
    const flag = vars[AGENT_ENABLED_VAR];
    const at = `${label}: ${where}vars`;
    if (flag !== AGENT_ENABLED_VALUES.on && flag !== AGENT_ENABLED_VALUES.off) {
      failures.push(
        `${at}.${AGENT_ENABLED_VAR} is ${JSON.stringify(flag)} — it must be exactly "on" or ` +
          '"off". An armed-ish value is one this gate and the runtime could read differently, ' +
          'so the gate refuses it rather than guess which.',
      );
      continue;
    }
    if (!isAgentEnabled(flag)) continue; // "off"
    const armed = `${at} sets ${AGENT_ENABLED_VAR} "on"`;
    // WHERE it may arm. An armed deploying block names a deployed environment, the canonical pair
    // names the one it deploys, and that environment must be on the ladder — which holds neither
    // deployed environment until P2-9 (staging) and P2-11 (production). APP_ENV is pinned because
    // the ladder and the runtime both read it: a deploying block that claimed "test" would pass a
    // ladder that admits test (privacy must-fix 14, platform 12).
    const appEnv = vars.APP_ENV;
    const pinned = pinnedAgentEnv(label, where);
    if (!isAgentDeployedEnv(appEnv)) {
      failures.push(
        `${armed} with APP_ENV ${JSON.stringify(appEnv)} — an armed deploying block must say ` +
          `exactly ${AGENT_DEPLOYED_ENVS.map((e) => `"${e}"`).join(' or ')}. "test" and ` +
          '"development" are ladder rungs for local and test runs; a deploying block claiming ' +
          'one would arm where the ladder says it may not.',
      );
    } else if (pinned !== undefined && appEnv !== pinned) {
      failures.push(
        `${armed} with APP_ENV "${appEnv}", but ${label} deploys ${pinned}: its top level must ` +
          `say "${pinned}". The ladder judges the environment a config deploys, not the one it ` +
          'claims.',
      );
    }
    const judged = judgedAgentEnv(label, where);
    if (!isAgentArmableEnv(judged, armableEnvs)) {
      failures.push(
        `${armed}, but it deploys ${judged}` +
          (pinned === undefined
            ? ' (every block but the top level of wrangler.jsonc / wrangler.staging.jsonc is ' +
              'judged as production)'
            : '') +
          `, which is not on the agent's environment ladder [${armableEnvs.join(', ')}] ` +
          '(AGENT_ARMABLE_ENVS, src/ai/agentVocabulary.mjs). Staging joins with the run routes ' +
          '(P2-9) and production only after recorded staging evidence (P2-11; privacy must-fix ' +
          '13). Until then the agent cannot arm in a deployed environment.',
      );
    }
    if (!isArmingRecord(vars[AGENT_ARMING_RECORD_VAR])) {
      failures.push(
        `${armed} without a valid ${AGENT_ARMING_RECORD_VAR} (found ` +
          `${JSON.stringify(vars[AGENT_ARMING_RECORD_VAR])}). An armed environment cites its ` +
          "evidence: the Linear id of this app and environment's C1–C20 record, e.g. " +
          `"ABC-123" (${AGENT_ARMING_RECORD_PATTERN}).`,
      );
    }
    if (!isReadAuditArmed(vars[READ_AUDIT_VAR])) {
      failures.push(
        `${armed} without "${READ_AUDIT_VAR}": "${READ_AUDIT_ARMED}" (found ` +
          `${JSON.stringify(vars[READ_AUDIT_VAR])}). The agent reads through the same routes a ` +
          'person does, and each of those reads must land in the read ledger (PIA C2). Arm it in ' +
          'the same block.',
      );
    }
    const retention = positiveDays(vars[AGENT_RETENTION_VAR]);
    if (retention === null) {
      failures.push(
        `${armed} without a valid ${AGENT_RETENTION_VAR} (found ` +
          `${JSON.stringify(vars[AGENT_RETENTION_VAR])}). No transcript row may exist before its ` +
          'retention does: set the DPO-approved value for this environment (PIA C1, O6) as a ' +
          'whole number of days in a string, e.g. "30". There is no default on purpose.',
      );
    }
    // C6: the agent's inference stays in "us" — even in staging, where the app's other AI calls
    // may opt into "global". The one region rule, shared with the AI client and the runtime.
    if (resolveInferenceGeo(vars[INFERENCE_GEO_VAR], appEnv) !== 'us') {
      failures.push(
        `${armed} with ${INFERENCE_GEO_VAR} ${JSON.stringify(vars[INFERENCE_GEO_VAR])} — an ` +
          'armed block pins inference to "us": leave it unset or set "us" (PIA C6).',
      );
    }
    // The reaper retires dead turns, books their in-flight spend, and expires held transcripts
    // and approvals within 15 minutes. Its heartbeat is also an arming condition at runtime.
    const triggers = 'triggers' in block ? block.triggers : cfg.triggers;
    const crons = Array.isArray(triggers?.crons) ? triggers.crons : [];
    if (!crons.includes(AGENT_REAPER_CRON)) {
      failures.push(
        `${armed} without the reaper's cron "${AGENT_REAPER_CRON}" in its triggers.crons ` +
          `(found ${JSON.stringify(crons)}). Without it a dead turn keeps its session pointer ` +
          'and unbooked spend, and a held transcript outlives its 15-minute bound (privacy ' +
          'must-fix 8).',
      );
    }
    const workflows = Array.isArray(block.workflows) ? block.workflows : [];
    // C9: the turn engine is a Workflow DEFINED here, so its instance retention is set here too —
    // `script_name` cannot be combined with `default_retention`.
    const run = workflows.find((wf) => wf?.binding === AGENT_RUN_BINDING);
    if (!run) {
      failures.push(
        `${armed} without its turn engine: a "workflows" entry { "binding": ` +
          `"${AGENT_RUN_BINDING}", "class_name": "${AGENT_RUN_CLASS}" } defined in this Worker, ` +
          'with a "default_retention" (PIA C9).',
      );
    } else {
      if (run.script_name !== undefined) {
        failures.push(
          `${armed} but binds ${AGENT_RUN_BINDING} with "script_name" ` +
            `${JSON.stringify(run.script_name)}. The turn engine must be defined in this Worker: ` +
            '"script_name" cannot be combined with "default_retention", so its instance ' +
            'retention could not be bounded here (PIA C9).',
        );
      }
      if (run.class_name !== AGENT_RUN_CLASS) {
        failures.push(
          `${armed} but ${AGENT_RUN_BINDING} has "class_name" ${JSON.stringify(run.class_name)}, ` +
            `expected "${AGENT_RUN_CLASS}" (the class src/index.ts exports).`,
        );
      }
    }
    for (const binding of workflows) {
      const kept = retention === null ? '' : ` (${retention} days)`;
      let wf = binding;
      let name = JSON.stringify(binding?.binding ?? binding?.name ?? '?');
      if (!definedHere(binding, worker)) {
        // Another Worker defines it: wrangler uploads nothing for it from this block, so the
        // retention that applies is on the definition — read it there, against THIS block's limit.
        const definition = definitions.get(definitionKey(binding.script_name, binding?.name));
        if (!definition) {
          failures.push(
            `${armed} but workflows ${name} is defined in Worker ` +
              `${JSON.stringify(binding.script_name)}, and no deploying config in this repo ` +
              `defines Workflow ${JSON.stringify(binding?.name)} for it. Its instance retention is ` +
              'set where it is defined, which this gate cannot see: define the Workflow in this ' +
              "Worker, or keep the defining Worker's config in the repo root, where it is checked " +
              '(PIA C9, O8).',
          );
          continue;
        }
        wf = definition.wf;
        name = `${name} (defined in ${definition.at})`;
      }
      const dr = wf?.default_retention;
      if (!dr || typeof dr !== 'object') {
        failures.push(
          `${armed} but workflows ${name} has no "default_retention". Without one, instance ` +
            "state — params and every step's output — is kept for the account maximum. With an " +
            'agent armed, every Workflow binding in the block needs "default_retention": ' +
            '{ "success_retention": "<n> days", "error_retention": "<n> days" }, each no longer ' +
            `than ${AGENT_RETENTION_VAR}${kept} (PIA C9, O8).`,
        );
        continue;
      }
      for (const key of ['success_retention', 'error_retention']) {
        const days = workflowDurationDays(dr[key]);
        if (days === null) {
          failures.push(
            `${armed} but workflows ${name} default_retention.${key} is ` +
              `${JSON.stringify(dr[key])} — set it explicitly, as a duration ("7 days") or whole ` +
              `milliseconds, no longer than ${AGENT_RETENTION_VAR}${kept}. An absent one falls ` +
              'back to the account maximum (PIA C9, O8).',
          );
        } else if (retention !== null && days > retention) {
          failures.push(
            `${armed} but workflows ${name} default_retention.${key} ` +
              `${JSON.stringify(dr[key])} outlives ${AGENT_RETENTION_VAR} (${retention} days). ` +
              'An instance must not keep what the transcript sweep has deleted (PIA C9).',
          );
        }
      }
    }
    if (workflows.length && !toolchain.ok) {
      failures.push(
        `${armed} and binds Workflows, but ${toolchain.why}. The gate cannot certify an instance ` +
          'retention the deploy drops (PIA C9, O8): upgrade wrangler (package.json ' +
          'devDependencies) to a version whose config schema declares ' +
          'WorkflowBinding.default_retention, and confirm on staging that a finished instance ' +
          'expires on time.',
      );
    }
    const buckets = Array.isArray(block.r2_buckets) ? block.r2_buckets : [];
    const vault = buckets.some((b) => b?.binding === VAULT_BINDING);
    if (vault && positiveDays(vars[VAULT_RETENTION_VAR]) === null) {
      failures.push(
        `${armed} and binds ${VAULT_BINDING} without a valid ${VAULT_RETENTION_VAR} (found ` +
          `${JSON.stringify(vars[VAULT_RETENTION_VAR])}). The vault copies every verified backup ` +
          '(personal data, though no agent_* transcript) and has no retention in code (PIA §5). ' +
          `Declare the vault bucket's lifecycle expiry as ${VAULT_RETENTION_VAR} (whole days, ` +
          'e.g. "37"), or remove the binding from this block.',
      );
    }
  }
  return failures;
}

// The vars the arming check reads. `wrangler deploy --var NAME:value` (and `versions upload`)
// REPLACES a config var's value at deploy time, so any of these passed that way arms the agent, or
// disarms one of its controls, where no config review and no check above can see it.
// APP_ENV, the arming record and the inference region joined in P2-2: each one is read by the
// ladder, the record rule or the "us" pin, so a `--var` of any of them moves an armed block past a
// check its config passed (platform must-fix 12, privacy 14).
export const ARMING_VARS = Object.freeze([
  AGENT_ENABLED_VAR,
  READ_AUDIT_VAR,
  AGENT_RETENTION_VAR,
  VAULT_RETENTION_VAR,
  'APP_ENV',
  AGENT_ARMING_RECORD_VAR,
  INFERENCE_GEO_VAR,
]);
const CLI_VAR_FLAG = /(?:^|\s)--var(?:=|\s)/;
const ARMING_VAR_VALUE = new RegExp(`(?<![A-Za-z0-9_])(${ARMING_VARS.join('|')}):`);
const WORKFLOWS_DIR = '.github/workflows';

/**
 * Failures for deploy commands that pass an arming var with `--var`. `commands` is
 * `[where, commandLine][]`. Matched per logical command line: a `--var` flag and `NAME:` for one
 * of ARMING_VARS on the same line (a step's `env:` entry `READ_AUDIT: on` has no `--var`, and is
 * not a Worker var). Pure.
 */
export function cliVarOverrideFailures(commands) {
  const failures = [];
  for (const [where, command] of commands) {
    if (typeof command !== 'string' || !CLI_VAR_FLAG.test(command)) continue;
    const m = ARMING_VAR_VALUE.exec(command);
    if (!m) continue;
    failures.push(
      `${where} passes ${m[1]} with wrangler --var, which replaces the reviewed config value at ` +
        'deploy time — arming the agent, or disarming one of its controls, where no config and ' +
        `no gate can see it. Set ${m[1]} in the wrangler config's "vars", in the block it governs.`,
    );
  }
  return failures;
}

/**
 * A file's logical command lines as `[firstLineNumber, text]`: a line ending in `\` continues on
 * the next, as in a shell `run:` step. Pure.
 */
export function commandLines(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const start = i + 1;
    let line = lines[i];
    while (line.endsWith('\\') && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i];
    out.push([start, line]);
  }
  return out;
}

/** Every deploy-capable command a repo declares: package.json scripts and the workflow files'
 *  lines. An absent file declares nothing; one that exists and cannot be read is a failure. */
function declaredCommands(root, failures) {
  const commands = [];
  try {
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))?.scripts;
    if (scripts && typeof scripts === 'object') {
      for (const [name, cmd] of Object.entries(scripts)) {
        commands.push([`package.json scripts.${name}`, cmd]);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      failures.push(
        `package.json: could not read (${err.code ?? err.message}) — its scripts cannot be ` +
          'checked for a wrangler --var that overrides an arming var.',
      );
    }
  }
  let listing = [];
  try {
    listing = readdirSync(join(root, WORKFLOWS_DIR)).filter((name) => /\.ya?ml$/i.test(name));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      failures.push(`${WORKFLOWS_DIR}/: could not list (${err.code ?? err.message})`);
    }
  }
  for (const name of listing.sort()) {
    try {
      const text = readFileSync(join(root, WORKFLOWS_DIR, name), 'utf8');
      for (const [line, cmd] of commandLines(text)) {
        commands.push([`${WORKFLOWS_DIR}/${name}:${line}`, cmd]);
      }
    } catch (err) {
      failures.push(`${WORKFLOWS_DIR}/${name}: could not read (${err.code ?? err.message})`);
    }
  }
  return commands;
}

/** `options.armableEnvs` is a TEST seam (the ladder rungs P2-9/P2-11 open); main() passes none. */
export function checkAgentArming(root = ROOT, { armableEnvs = AGENT_ARMABLE_ENVS } = {}) {
  const failures = [];
  const configs = [];
  for (const file of deployingConfigFiles(root, failures)) {
    try {
      configs.push([file, parseJsonc(readFileSync(join(root, file), 'utf8'))]);
    } catch (err) {
      failures.push(configReadFailure(file, err));
    }
  }
  const context = {
    retention: readWorkflowRetentionSupport(root),
    definitions: workflowDefinitions(configs),
    armableEnvs,
  };
  for (const [file, cfg] of configs) failures.push(...agentArmingFailures(file, cfg, context));
  failures.push(...cliVarOverrideFailures(declaredCommands(root, failures)));
  return failures;
}

function main() {
  const edge = checkEdgeHardening();
  if (edge.length) {
    console.error('Edge-hardening guard FAILED:\n');
    for (const f of edge) console.error(`  ✗ ${f}`);
    console.error(
      '\nEvery deploying wrangler config must set "workers_dev": false and "preview_urls": false.\n' +
        'The default *.workers.dev / preview hostnames are an unprotected ingress that bypasses the\n' +
        'zone WAF + rate-limiting rules. Add both flags to the config(s) above. See docs/SECURITY-EDGE.md.\n' +
        'Where Workers Logs are on, "observability": { "logs": { "invocation_logs": false } } is\n' +
        'required too: the per-request record logs the URL, tokens and addresses included (PIA C5).',
    );
    process.exit(1);
  }
  const placeholders = checkPlaceholderHygiene();
  if (placeholders.length) {
    console.error('Wrangler placeholder guard FAILED:\n');
    for (const f of placeholders) console.error(`  ✗ ${f}`);
    console.error(
      '\nThe production preflight (.github/workflows/deploy-prod.yml) greps wrangler.jsonc for\n' +
        `${PROVISION_PLACEHOLDER} and cannot tell a JSONC comment from live config. Keep the\n` +
        'sentinel out of comments, and leave no `<…>` fill-in in a live binding id.\n' +
        'See DECISIONS 2026-08-04.',
    );
    process.exit(1);
  }
  const naming = checkResourceNaming();
  if (naming.length) {
    console.error('Resource attributability guard FAILED:\n');
    for (const f of naming) console.error(`  ✗ ${f}`);
    console.error(
      "\nEvery resource a deploying config names must carry this app's name (vars.APP_NAME) —\n" +
        'one Cloudflare account is shared across business lines, so a resource has to be\n' +
        'attributable to its app at a glance. A name belonging to ANOTHER app is the serious\n' +
        "case: a stale r2 bucket_name sends this app's D1 backups into that app's bucket.\n" +
        'Fix the config, or re-run `npm run provision`. See src/platform/naming.ts and\n' +
        'DECISIONS 2026-08-18.',
    );
    process.exit(1);
  }
  const bindings = checkBindingAllowlist();
  if (bindings.length) {
    console.error('Private-database binding guard FAILED:\n');
    for (const f of bindings) console.error(`  ✗ ${f}`);
    console.error(
      `\nA Hyperdrive / Workers VPC binding hands the worker a live database credential or a\n` +
        'path into a private network, and Cloudflare has no per-Worker scope for one — the ' +
        'reviewed grant is ' +
        `${ALLOWLIST_FILE}.\n` +
        'Declare the binding and its id together there, in the same pull request.\n' +
        'See docs/DATA-ROUTES.md.',
    );
    process.exit(1);
  }
  const ai = checkAiConfig();
  if (ai.length) {
    console.error('AI configuration guard FAILED:\n');
    for (const f of ai) console.error(`  ✗ ${f}`);
    console.error(
      '\nThe AI client refuses, on every call, a model that cannot be pinned to an inference\n' +
        'region and a region production does not allow (PIA C6). A deploying config that names\n' +
        'one passes CI and then fails every AI call in that environment with a 503. Name a\n' +
        'model from src/ai/policyVocabulary.mjs, and leave AI_INFERENCE_GEO unset (= "us") in\n' +
        'production.\n' +
        'See DECISIONS 2026-09-23.',
    );
    process.exit(1);
  }
  const agent = checkAgentArming();
  if (agent.length) {
    console.error('Agent arming guard FAILED:\n');
    for (const f of agent) console.error(`  ✗ ${f}`);
    console.error(
      `\nA config that sets ${AGENT_ENABLED_VAR} "on" arms the in-app agent, and the PIA makes its\n` +
        'controls conditions of arming, not follow-ups: the read ledger armed (C2), an explicit\n' +
        'transcript retention (C1), Workflow instance retention no longer than it (C9), inference\n' +
        'pinned to "us" (C6), no offsite vault without a retention, an arming record, the reaper\n' +
        "cron and the AGENT_RUN turn engine — and an APP_ENV on the agent's environment ladder,\n" +
        'which opens staging at P2-9 and production at P2-11. All in the same block as the flag —\n' +
        'wrangler inherits none of vars, workflows or r2_buckets into an env block — and none of\n' +
        'them overridden by a `wrangler --var` in a deploy command. See DECISIONS 2026-09-25 and\n' +
        '2026-10-04.',
    );
    process.exit(1);
  }
  console.log(
    'Wrangler config guards passed: workers.dev + preview URLs disabled, invocation logs off\n' +
      'wherever Workers Logs are on, no sentinel and no example id in a comment, no unfilled\n' +
      'binding ids, every resource name attributable to this app (the canonical pair in full,\n' +
      'any other config by prefix), every private-database binding on the allowlist, every AI\n' +
      'model and inference region one the AI client accepts, and no agent armed without its\n' +
      'controls — across every wrangler config in the repo root, env blocks included.',
  );
}

// Run only as a CLI; importing the module (the pin test) must not exit.
if (isMainModule(import.meta.url)) {
  main();
}
