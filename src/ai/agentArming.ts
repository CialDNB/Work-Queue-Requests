// THE RUNTIME HALF OF ARMING THE IN-APP AGENT (docs/agent-loop-P2-DESIGN.md §6.2, §7).
//
// `verify:edge` (scripts/check-edge-hardening.mjs) is the static half: it reads the deploying
// wrangler configs. It cannot see a Worker secret, a `wrangler secret put AGENT_ENABLED`, a
// `--secrets-file` or a `--var` in a command outside package.json and .github/workflows, and it
// cannot see the database. So the conditions are asked again HERE, against the EFFECTIVE env the
// Worker actually received (DECISIONS 2026-09-25), at three checkpoints: the start route, the
// approval route, and the Workflow `turn` step before the model is ever called. Both halves take
// their names, values, comparisons and the environment ladder from src/ai/agentVocabulary.mjs,
// so they cannot disagree about what "armed" means.
//
// FAIL CLOSED, IN A FIXED ORDER. The first unmet condition is the cause; nothing is assumed:
//   flag → ladder → READ_AUDIT → retention → inference geo → arming record → VAULT retention →
//   AGENT_RUN binding → registered DSR route → egress rulings          (agentArmingStatic, pure)
//   → schema 0006 accepted → reaper heartbeat fresh (deployed envs only)  (agentArming, two probes)
// A probe that throws, or answers anything unexpected, refuses. Neither function throws on an env
// it cannot arm: every refusal is a value, and the caller answers the framework's byte-identical
// 404 (routes) or ends the turn `disarmed` (the step).
//
// DORMANT in P2-2: nothing calls `agentArming` to start work, and `dsr_route_missing` is
// PERMANENT until P2-7 registers the DSR route — no route in any registry passes
// `isRegisteredDsrRoute` before then, and no other module may register one (the fence below).
// The ladder holds test and development only, so a staging or production env refuses with
// `env_not_armable` whatever else it sets (P2-9 adds staging, P2-11 production).
import type { AgentSchemaSupport } from '../data/agent';
import type { Env } from '../env';
import { assertPrivateSourcesRuled, type PrivateSourceTable } from '../framework/agentExposure';
import type { RouteDef } from '../framework/defineRoute';
import { readAuditArmed } from '../framework/readAudit';
import { agentLog } from './agentLog';
import {
  AGENT_ARMING_CAUSES,
  AGENT_ARMING_RECORD_VAR,
  AGENT_ENABLED_VALUES,
  AGENT_ENABLED_VAR,
  AGENT_RETENTION_VAR,
  AGENT_RUN_BINDING,
  isAgentArmableEnv,
  isAgentDeployedEnv,
  isAgentEnabled,
  isArmingRecord,
  positiveDays,
  VAULT_BINDING,
  VAULT_RETENTION_VAR,
} from './agentVocabulary.mjs';
import { INFERENCE_GEO_VAR, resolveInferenceGeo } from './policyVocabulary.mjs';

export { AGENT_ARMING_CAUSES };

/** Why arming refused. The list, in check order, is AGENT_ARMING_CAUSES (agentVocabulary.mjs). */
export type AgentArmingCause = (typeof AGENT_ARMING_CAUSES)[number];

export type AgentArming =
  | { readonly armed: true; readonly retentionDays: number }
  | { readonly armed: false; readonly cause: AgentArmingCause };

/** The two answers arming needs from I/O. Each may throw; a throw refuses. */
export interface AgentArmingProbes {
  /** `db.agent.schemaSupport()` — is migration 0006 whole? */
  schema(): Promise<AgentSchemaSupport>;
  /** Milliseconds since the reaper last finished a run, or null when it never has. */
  reaperHeartbeatAgeMs(): Promise<number | null>;
}

/**
 * Test seams, never passed by a src/ caller: `armableEnvs` drives the ladder rungs P2-9 and P2-11
 * open so the deployed-env causes can be exercised before they exist (no other src/ or scripts/
 * file may name it — test/isolation/agent-arming-fences.test.ts); `privateSources` stands in for
 * AURORA_SOURCES, as it does for buildAgentTools, and is AURORA_SOURCES when omitted.
 */
export interface AgentArmingOptions {
  readonly armableEnvs?: readonly string[];
  readonly privateSources?: PrivateSourceTable;
}

/**
 * The SESSIONS KV key the reaper (P2-6) writes after each COMPLETED run, holding
 * `new Date(now).toISOString()`. Written only on completion, so a fresh value proves the reaper is
 * alive, not merely scheduled (privacy must-fix 8).
 */
export const AGENT_REAPER_HEARTBEAT_KEY = 'agent:reaper:last';

/**
 * Twice the reaper's 5-minute cadence (the design's value). A reaper that completes every tick is
 * always seen fresh: the oldest age read is one cadence + its run + the SESSIONS KV window (reads
 * may be ~60 s stale at a PoP, src/auth/sessions.ts). A MISSED tick is not tolerated in full: the
 * age then passes the bound for about that KV window plus the next run's length before the new
 * stamp is seen, and arming refuses `reaper_stale` meanwhile — fail closed, so the cost is
 * availability (DECISIONS 2026-10-04 item 5). Tolerating one missed tick would take
 * 2 × cadence + the KV window + a run budget: a change to the design's value. Pinned, with the
 * cron it derives from, in test/ai/agent-arming.test.ts.
 */
export const AGENT_REAPER_STALE_MS = 600_000;

/** A stamp more than this ahead of this clock (60 s is still fresh) is not one a reaper wrote. */
const HEARTBEAT_MAX_SKEW_MS = 60_000;

// ── the DSR route, by identity ──────────────────────────────────────────────────────────────

/**
 * Module-private: the route OBJECTS the DSR module (P2-7) registered as it loaded. Arming asks
 * for one of them in the live registry by identity, never by path, so a stub at the same path —
 * or a copy of the real definition — does not satisfy it (privacy must-fix 14).
 *
 * The set cannot tell WHO registered an object, so the identity check is only as strong as the
 * fence on its one door: test/isolation/agent-arming-fences.test.ts (protected core, carried by
 * /kit-upgrade into every fork's CI) fails if any source file in the repo but this one and the DSR
 * module names `registerDsrRoute` in any spelling, names this module other than in a named,
 * default, type-only or side-effect import (a namespace, `export *`, `require`, dynamic import,
 * computed relative specifier or alias included), or imports from a folder the scan skips. It
 * reads text, so it is a tripwire, not a proof — and what no text scan can see has no reviewer
 * behind it in feature territory: CODEOWNERS leaves src/routes/ and web/ un-owned. That residual
 * is open (DECISIONS 2026-10-04, "What stays open") until there is no registration door to fence.
 */
const dsrRoutes = new WeakSet<RouteDef>();

/**
 * Mark `route` as THE agent DSR route. Called only by the kit's DSR module (P2-7), at load; any
 * other caller fails the fence above.
 */
export function registerDsrRoute(route: RouteDef): void {
  dsrRoutes.add(route);
}

export function isRegisteredDsrRoute(route: RouteDef): boolean {
  return dsrRoutes.has(route);
}

// ── the predicate ───────────────────────────────────────────────────────────────────────────

function refused(cause: AgentArmingCause): AgentArming {
  return Object.freeze({ armed: false, cause });
}

/**
 * Every condition that needs no I/O, in the fixed order (the header). Pure. `routes` is the LIVE
 * registry the request or step runs against.
 */
export function agentArmingStatic(
  env: Env,
  routes: readonly RouteDef[],
  options: AgentArmingOptions = {},
): AgentArming {
  const flag = env[AGENT_ENABLED_VAR];
  if (!isAgentEnabled(flag)) {
    return refused(
      flag === undefined || flag === AGENT_ENABLED_VALUES.off ? 'flag_off' : 'flag_invalid',
    );
  }
  if (!isAgentArmableEnv(env.APP_ENV, options.armableEnvs)) return refused('env_not_armable');
  // C2: the agent reads through the same routes a person does; each read lands in the ledger.
  if (!readAuditArmed(env)) return refused('read_audit_off');
  // C1: no transcript row before its retention. There is no default, anywhere.
  const retentionDays = positiveDays(env[AGENT_RETENTION_VAR]);
  if (retentionDays === null) return refused('retention_invalid');
  // C6: the agent runs pinned to "us", even where the app's other AI calls may opt out (staging
  // may run "global" — resolveInferenceGeo is the one region rule, shared with the AI client).
  if (resolveInferenceGeo(env[INFERENCE_GEO_VAR], env.APP_ENV) !== 'us') {
    return refused('inference_geo_not_us');
  }
  if (isAgentDeployedEnv(env.APP_ENV) && !isArmingRecord(env[AGENT_ARMING_RECORD_VAR])) {
    return refused('arming_record_missing');
  }
  if (env[VAULT_BINDING] !== undefined && positiveDays(env[VAULT_RETENTION_VAR]) === null) {
    return refused('vault_retention_missing');
  }
  if (env[AGENT_RUN_BINDING] === undefined) return refused('workflow_unbound');
  if (!routes.some((route) => isRegisteredDsrRoute(route))) return refused('dsr_route_missing');
  // C3, the app's half: in an app that binds a client-class private database, every exposed route
  // carries an egressRuling — the same check buildAgentTools makes before any tool exists.
  try {
    assertPrivateSourcesRuled(
      routes.map((route) => route.spec),
      options.privateSources,
    );
  } catch {
    return refused('ruling_missing');
  }
  return Object.freeze({ armed: true, retentionDays });
}

async function probedSchema(probes: AgentArmingProbes): Promise<AgentSchemaSupport> {
  try {
    const state = await probes.schema();
    return state === 'accepted' || state === 'refused' ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function probedHeartbeatAge(probes: AgentArmingProbes): Promise<number | null> {
  try {
    const age = await probes.reaperHeartbeatAgeMs();
    return typeof age === 'number' && Number.isFinite(age) && age >= 0 ? age : null;
  } catch {
    return null;
  }
}

/**
 * `agentArmingStatic`, then the schema probe (logging `agent_schema_drift` on a refusal), then —
 * in deployed envs only — the reaper heartbeat. Never throws.
 */
export async function agentArming(
  env: Env,
  routes: readonly RouteDef[],
  probes: AgentArmingProbes,
  options: AgentArmingOptions = {},
): Promise<AgentArming> {
  const fixed = agentArmingStatic(env, routes, options);
  if (!fixed.armed) return fixed;
  const schema = await probedSchema(probes);
  if (schema !== 'accepted') {
    agentLog('agent_schema_drift', { state: schema, remedy: 'apply_migration_0006_agent_tables' });
    return refused('schema_not_accepted');
  }
  // The heartbeat proves a reaper exists to retire a dead turn and expire a held transcript. Local
  // and test envs run no cron, so it is asked only where one is deployed. Like the arming record,
  // it keys on APP_ENV: a deployed Worker whose runtime APP_ENV was changed to `development` out of
  // band (a dashboard edit, a manual `--var`) is asked for neither. verify:edge pins APP_ENV in
  // every armed deploying block and refuses it as a `--var` in the repo's commands; what it cannot
  // see stays open (DECISIONS 2026-10-04, agent arming, "What stays open").
  if (isAgentDeployedEnv(env.APP_ENV)) {
    const age = await probedHeartbeatAge(probes);
    if (age === null || age > AGENT_REAPER_STALE_MS) return refused('reaper_stale');
  }
  return fixed;
}

/**
 * The heartbeat probe over SESSIONS KV: the age of `AGENT_REAPER_HEARTBEAT_KEY`, or null when it is
 * absent, not exactly an ISO-8601 timestamp, or stamped in the future. A KV failure throws, which
 * `agentArming` reads as stale.
 */
export function kvReaperProbe(
  env: Env,
  now: () => number = Date.now,
): () => Promise<number | null> {
  return async () => {
    const raw = await env.SESSIONS.get(AGENT_REAPER_HEARTBEAT_KEY);
    if (raw === null) return null;
    const at = Date.parse(raw);
    if (!Number.isFinite(at) || new Date(at).toISOString() !== raw) return null;
    const age = now() - at;
    if (age < -HEARTBEAT_MAX_SKEW_MS) return null;
    return Math.max(0, age);
  };
}
