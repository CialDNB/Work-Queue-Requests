// THE IN-APP AGENT'S ARMING VOCABULARY — one definition, imported by both sides.
//
// Arming is asserted in two places that never meet at runtime:
//
//   - The GATE enforces it statically. `scripts/check-edge-hardening.mjs` (`npm run verify:edge`)
//     refuses a deploying wrangler block that sets AGENT_ENABLED "on" without the controls the PIA
//     makes conditions of arming (C1, C2, C6, C9), outside the environment ladder, or without its
//     arming record, reaper cron and AGENT_RUN Workflow binding.
//   - The RUNTIME honours it. src/ai/agentArming.ts re-checks the same conditions against the
//     EFFECTIVE env (secrets and `--var` overrides included, which no static gate can see) at the
//     start route, the approval route and the Workflow step, before the model is ever called.
//
// The constants used to live in the gate alone, marked to move here when the runtime landed
// (DECISIONS 2026-09-25, rejection g). Two spellings of "on", of the retention var or of the
// ladder that merely agree today are how the gate ends up certifying a value the runtime never
// reads: so there is one definition, and drift between the two is unrepresentable rather than
// merely tested for. See docs/agent-loop-P2-DESIGN.md §6.1 and §7.
//
// PLAIN JAVASCRIPT ON PURPOSE, for the reason src/framework/readAuditVocabulary.mjs gives: the gate
// runs under plain `node` and cannot import TypeScript; esbuild bundles a `.mjs` into the worker;
// and tsconfig's `allowJs` + `checkJs` hold this file to the same `strict` as every .ts.
//
// NO IMPORTS, EVER — every consumer must be able to load this file on its own. Keep it data and
// pure functions over data.

/** The wrangler `vars` key / `Env` field that arms the agent. */
export const AGENT_ENABLED_VAR = 'AGENT_ENABLED';

/** Its only two legal values. Anything else is refused by the gate and read as unarmed at runtime. */
export const AGENT_ENABLED_VALUES = Object.freeze({ on: 'on', off: 'off' });

/** How many days a transcript row lives (PIA C1, O6). No default exists anywhere, on purpose. */
export const AGENT_RETENTION_VAR = 'AGENT_TRANSCRIPT_RETENTION_DAYS';

/**
 * The dormant second-account offsite bucket (src/env.ts). It copies every verified backup; P2-1
 * excludes `agent_*` from backups, but the vault's own lifecycle is still a declared value, not
 * code, so an armed block that binds it must declare it.
 */
export const VAULT_BINDING = 'VAULT';

/** The vault bucket's lifecycle expiry, declared in days. Nothing in the Worker reads it. */
export const VAULT_RETENTION_VAR = 'VAULT_RETENTION_DAYS';

/**
 * The per-app, per-environment arming record: a Linear id citing this app+env's C1–C20 evidence
 * (owner question 14). Required wherever the agent is armed in a DEPLOYED environment.
 */
export const AGENT_ARMING_RECORD_VAR = 'AGENT_ARMING_RECORD';

/** An identifier-shaped Linear key: the same shape as an egress ruling (`EGRESS_RULING_PATTERN`). */
export const AGENT_ARMING_RECORD_PATTERN = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6}$/;

/** The Workflow binding the turn engine runs in, and the class it must be defined with. */
export const AGENT_RUN_BINDING = 'AGENT_RUN';
export const AGENT_RUN_CLASS = 'AgentRunWorkflow';

/**
 * Its canonical resource name on the deploying pair is `${APP_NAME}-agent-run${envSuffix}`:
 * Workflow names are ACCOUNT-scoped, and one account carries every fork.
 */
export const AGENT_RUN_NAME_SUFFIX = 'agent-run';

/** The reaper's own cron expression, dispatched by an explicit branch (P2-6). */
export const AGENT_REAPER_CRON = '*/5 * * * *';

/**
 * THE LADDER: the APP_ENV values the agent may arm in. P2-2 ships test + development only, so every
 * deployed environment refuses, statically and at runtime. P2-9 adds 'staging'; P2-11 adds
 * 'production', merged only after the staging evidence exists (privacy must-fix 13).
 */
export const AGENT_ARMABLE_ENVS = Object.freeze(['test', 'development']);

/** Environments that are deployed: they need an arming record and a fresh reaper heartbeat. */
export const AGENT_DEPLOYED_ENVS = Object.freeze(['staging', 'production']);

/** A finished instance's state is kept one day; an errored one at most this many days. */
export const AGENT_INSTANCE_SUCCESS_RETENTION = '1 day';
export const AGENT_INSTANCE_MAX_ERROR_RETENTION_DAYS = 7;

/**
 * Every reason the runtime arming predicate refuses, in the order it checks them
 * (src/ai/agentArming.ts §6.2). Here rather than in agentArming.ts so the agent log registry
 * (src/ai/agentLog.ts) can name them without importing the predicate that logs through it.
 */
export const AGENT_ARMING_CAUSES = Object.freeze(
  /** @type {const} */ ([
    'flag_off',
    'flag_invalid',
    'env_not_armable',
    'read_audit_off',
    'retention_invalid',
    'inference_geo_not_us',
    'arming_record_missing',
    'vault_retention_missing',
    'workflow_unbound',
    'dsr_route_missing',
    'ruling_missing',
    'schema_not_accepted',
    'reaper_stale',
  ]),
);

/**
 * THE comparison: armed only on exactly "on". Trimmed, upper-cased or `'true'` is not armed — the
 * readAuditVocabulary rule, for the same reason.
 *
 * @param {unknown} value the raw AGENT_ENABLED value, however the caller got hold of it
 * @returns {boolean}
 */
export function isAgentEnabled(value) {
  return value === AGENT_ENABLED_VALUES.on;
}

/**
 * A whole, positive number of days written as wrangler `vars` carry it ("30"), or null.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function positiveDays(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : null;
}

/**
 * Is `appEnv` on the ladder? `ladder` defaults to THE ladder; the gate and the runtime predicate
 * accept another only so their tests can drive the rungs P2-9 and P2-11 open (no src/ caller
 * passes one — test/isolation/agent-arming-fences.test.ts holds that).
 *
 * @param {unknown} appEnv
 * @param {readonly string[]} [ladder]
 * @returns {boolean}
 */
export function isAgentArmableEnv(appEnv, ladder = AGENT_ARMABLE_ENVS) {
  return typeof appEnv === 'string' && ladder.includes(appEnv);
}

/**
 * @param {unknown} appEnv
 * @returns {boolean}
 */
export function isAgentDeployedEnv(appEnv) {
  return typeof appEnv === 'string' && AGENT_DEPLOYED_ENVS.includes(appEnv);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isArmingRecord(value) {
  return typeof value === 'string' && AGENT_ARMING_RECORD_PATTERN.test(value);
}

/**
 * Per-instance retention for `AGENT_RUN.create()`: success '1 day', error min(7, days) days —
 * never longer than the transcript retention `days` (PIA C9).
 *
 * @param {number} days a positiveDays() result
 * @returns {{ successRetention: string, errorRetention: string }}
 */
export function agentInstanceRetention(days) {
  const e = Math.min(AGENT_INSTANCE_MAX_ERROR_RETENTION_DAYS, days);
  return {
    successRetention: AGENT_INSTANCE_SUCCESS_RETENTION,
    errorRetention: `${e} day${e === 1 ? '' : 's'}`,
  };
}
