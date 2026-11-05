// THE RUNTIME ARMING PREDICATE (src/ai/agentArming.ts; docs/agent-loop-P2-DESIGN.md §6.2, §7.2).
// What is pinned:
//
//   1. EVERY CAUSE, IN ORDER. Each AgentArmingCause is reachable, and the first unmet condition is
//      the one reported — walked condition by condition from a fully broken env to an armed one.
//   2. THE EFFECTIVE ENV. The predicate reads the env object the Worker received — a secret or a
//      `--var` the static gate cannot see included — never the wrangler config, and the flag is
//      armed by exactly "on".
//   3. THE LADDER. In P2-2 only test and development are armable: staging and production refuse
//      whatever else they set. The deployed-env causes (arming record, reaper heartbeat) are
//      reached by opening the ladder through the test seam the gate's tests use too.
//   4. IDENTITY, NOT PATH. Only a route object passed to `registerDsrRoute` satisfies
//      `dsr_route_missing`; a same-path stub or a copy of a registered route does not, and the kit
//      registry has none until P2-7. Identity says nothing about WHO registered: that only the DSR
//      module may is fenced in test/isolation/agent-arming-fences.test.ts. Rulings go through
//      assertPrivateSourcesRuled (with the default table: agent-arming-sources.test.ts).
//   5. FAIL CLOSED ON I/O. A probe that throws or answers nonsense refuses, and a refused schema
//      logs `agent_schema_drift` with its state and remedy only.
//
// FORK-PORTABLE: this file rides /kit-upgrade unchanged, so nothing here may depend on what a fork's
// own registry exposes or which private databases it binds. Every route list is built from
// REGISTRY — the live registry minus the routes it exposes to the agent (a fork's own exposures are
// judged against its own table by test/isolation/agent-exposure.test.ts) — plus this file's own
// routes, and the one case that reads the app's own AURORA_SOURCES answers for whichever table the
// app has. The kit runs this file under both fork shapes the fleet has (a client-class source;
// an exposed read route with no ruling): test/platform/agent-arming-fork-*.test.ts.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AGENT_ARMING_CAUSES,
  AGENT_REAPER_HEARTBEAT_KEY,
  AGENT_REAPER_STALE_MS,
  type AgentArming,
  type AgentArmingCause,
  type AgentArmingOptions,
  type AgentArmingProbes,
  agentArming,
  agentArmingStatic,
  isRegisteredDsrRoute,
  kvReaperProbe,
  registerDsrRoute,
} from '../../src/ai/agentArming';
import {
  AGENT_ARMABLE_ENVS,
  AGENT_ARMING_RECORD_PATTERN,
  AGENT_DEPLOYED_ENVS,
  AGENT_REAPER_CRON,
  agentInstanceRetention,
  isAgentArmableEnv,
  isAgentDeployedEnv,
  isAgentEnabled,
  isArmingRecord,
  positiveDays,
} from '../../src/ai/agentVocabulary.mjs';
import type { PermissionKey } from '../../src/auth/permissions';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import {
  type AgentExposure,
  clientPrivateSources,
  EGRESS_RULING_PATTERN,
  isAgentExposed,
} from '../../src/framework/agentExposure';
import { defineRoute, type RouteDef } from '../../src/framework/defineRoute';
import { allRoutes } from '../../src/routes';
import { applySchema } from '../helpers/db';
import { captureLogs } from '../helpers/logs';

// Stand-ins for bindings: the predicate only asks whether each is bound.
const AGENT_RUN = {} as Workflow<{ readonly turnId: string }>;
const VAULT = {} as R2Bucket;

/** The DSR route P2-7 will register — here a plain route this test registers itself. */
const DSR_PATH = '/api/agent/dsr-test';
const dsrRoute = defineRoute({
  method: 'GET',
  path: DSR_PATH,
  permission: 'authenticated',
  input: z.object({}),
  handler: async () => ({}),
});
registerDsrRoute(dsrRoute);

/** An agent-exposed route WITHOUT an egressRuling: unruled in an app binding a client database. */
function exposedRoute(egressRuling?: string): RouteDef {
  return defineRoute({
    method: 'GET',
    path: '/api/agent-arming-widgets',
    permission: 'notes.read' as PermissionKey,
    needs: ['notes'],
    input: z.object({}),
    agent: { effect: 'read', ...(egressRuling ? { egressRuling } : {}) } as AgentExposure,
    handler: async () => ({}),
  });
}

const CLIENT_DB = { c360_ro: 'client' } as const;
/** The live registry without the routes it exposes: what no fork's own exposures can move. */
const REGISTRY: readonly RouteDef[] = allRoutes.filter((route) => !isAgentExposed(route.spec));
const ROUTES: readonly RouteDef[] = [...REGISTRY, dsrRoute];

/** Every condition met, in the kit's own test env (APP_ENV "test", on the ladder). */
function armedEnv(over: Partial<Env> = {}): Env {
  return {
    ...env,
    APP_ENV: 'test',
    AGENT_ENABLED: 'on',
    READ_AUDIT: 'on',
    AGENT_TRANSCRIPT_RETENTION_DAYS: '30',
    AGENT_RUN,
    ...over,
  };
}

function probes(over: Partial<AgentArmingProbes> = {}): AgentArmingProbes {
  return {
    schema: async () => 'accepted',
    reaperHeartbeatAgeMs: async () => 0,
    ...over,
  };
}

const ALL_RUNGS: AgentArmingOptions = {
  armableEnvs: ['test', 'development', 'staging', 'production'],
};

const causeOf = (a: AgentArming): AgentArmingCause | 'armed' => (a.armed ? 'armed' : a.cause);

describe('agentArming — armed only when every condition holds', () => {
  it('arms a test env that meets every condition, and reports its retention', async () => {
    expect(agentArmingStatic(armedEnv(), ROUTES)).toEqual({ armed: true, retentionDays: 30 });
    expect(await agentArming(armedEnv(), ROUTES, probes())).toEqual({
      armed: true,
      retentionDays: 30,
    });
    // development is the other rung; the answer is frozen, so no caller can flip it.
    const dev = agentArmingStatic(armedEnv({ APP_ENV: 'development' }), ROUTES);
    expect(dev.armed).toBe(true);
    expect(Object.isFrozen(dev)).toBe(true);
  });

  it('walks every cause in check order: the first unmet condition is the one reported', async () => {
    // Start with everything wrong in a DEPLOYED env (so the record and the heartbeat count), with
    // staging opened through the test seam, then fix one condition at a time.
    let e: Env = {
      ...env,
      APP_ENV: 'production',
      AI_INFERENCE_GEO: 'global',
      VAULT,
    };
    let routes: readonly RouteDef[] = [...REGISTRY, exposedRoute()];
    let p = probes({ schema: async () => 'refused', reaperHeartbeatAgeMs: async () => null });
    const options: AgentArmingOptions = { armableEnvs: ['staging'], privateSources: CLIENT_DB };
    const fixes: (() => void)[] = [
      () => (e = { ...e, AGENT_ENABLED: 'on' }),
      () => (e = { ...e, APP_ENV: 'staging' }),
      () => (e = { ...e, READ_AUDIT: 'on' }),
      () => (e = { ...e, AGENT_TRANSCRIPT_RETENTION_DAYS: '14' }),
      () => (e = { ...e, AI_INFERENCE_GEO: 'us' }),
      () => (e = { ...e, AGENT_ARMING_RECORD: 'SEC-1' }),
      () => (e = { ...e, VAULT_RETENTION_DAYS: '37' }),
      () => (e = { ...e, AGENT_RUN }),
      () => (routes = [...routes, dsrRoute]),
      () => (routes = routes.filter((r) => r.spec.path !== '/api/agent-arming-widgets')),
      () => (p = { ...p, schema: async () => 'accepted' }),
      () => (p = { ...p, reaperHeartbeatAgeMs: async () => 1_000 }),
    ];
    const seen: (AgentArmingCause | 'armed')[] = [];
    for (const fix of fixes) {
      seen.push(causeOf(await agentArming(e, routes, p, options)));
      fix();
    }
    seen.push(causeOf(await agentArming(e, routes, p, options)));
    expect(seen).toEqual([...AGENT_ARMING_CAUSES.filter((c) => c !== 'flag_invalid'), 'armed']);
  });

  it('reaches every AgentArmingCause, and the list is the vocabulary’s', async () => {
    const reached = new Set<string>();
    const note = (a: AgentArming) => reached.add(causeOf(a));
    note(agentArmingStatic(armedEnv({ AGENT_ENABLED: undefined }), ROUTES));
    note(agentArmingStatic(armedEnv({ AGENT_ENABLED: 'ON' }), ROUTES));
    note(agentArmingStatic(armedEnv({ APP_ENV: 'staging' }), ROUTES));
    note(agentArmingStatic(armedEnv({ READ_AUDIT: 'off' }), ROUTES));
    note(agentArmingStatic(armedEnv({ AGENT_TRANSCRIPT_RETENTION_DAYS: '0' }), ROUTES));
    note(agentArmingStatic(armedEnv({ AI_INFERENCE_GEO: 'global' }), ROUTES));
    note(agentArmingStatic(armedEnv({ APP_ENV: 'staging' }), ROUTES, ALL_RUNGS));
    note(agentArmingStatic(armedEnv({ VAULT }), ROUTES));
    note(agentArmingStatic(armedEnv({ AGENT_RUN: undefined }), ROUTES));
    note(agentArmingStatic(armedEnv(), allRoutes));
    note(agentArmingStatic(armedEnv(), [...ROUTES, exposedRoute()], { privateSources: CLIENT_DB }));
    note(await agentArming(armedEnv(), ROUTES, probes({ schema: async () => 'unknown' })));
    note(
      await agentArming(
        armedEnv({ APP_ENV: 'production', AGENT_ARMING_RECORD: 'SEC-1' }),
        ROUTES,
        probes({ reaperHeartbeatAgeMs: async () => null }),
        ALL_RUNGS,
      ),
    );
    expect([...reached].sort()).toEqual([...AGENT_ARMING_CAUSES].sort());
  });
});

describe('the flag: the effective env, exactly "on"', () => {
  it('arms on exactly "on"; anything else set is flag_invalid, unset or "off" is flag_off', () => {
    expect(causeOf(agentArmingStatic(armedEnv({ AGENT_ENABLED: undefined }), ROUTES))).toBe(
      'flag_off',
    );
    expect(causeOf(agentArmingStatic(armedEnv({ AGENT_ENABLED: 'off' }), ROUTES))).toBe('flag_off');
    for (const near of ['ON', 'On', ' on', 'on ', 'true', '1', 'yes', '']) {
      const a = agentArmingStatic(armedEnv({ AGENT_ENABLED: near }), ROUTES);
      expect(causeOf(a), JSON.stringify(near)).toBe('flag_invalid');
      expect(isAgentEnabled(near)).toBe(false);
    }
    expect(isAgentEnabled('on')).toBe(true);
  });

  it('reads the env the Worker received, not the config', () => {
    // wrangler.test.jsonc sets no AGENT_ENABLED: as configured, the agent is off…
    expect(causeOf(agentArmingStatic(env, ROUTES))).toBe('flag_off');
    // …a secret of the same name reaches the Worker as the same string, and IS read — which is
    // why the runtime re-checks every condition instead of trusting verify:edge…
    expect(agentArmingStatic(armedEnv(), ROUTES).armed).toBe(true);
    // …and a `--var APP_ENV:production` the config never said moves the env off the ladder.
    expect(causeOf(agentArmingStatic(armedEnv({ APP_ENV: 'production' }), ROUTES))).toBe(
      'env_not_armable',
    );
    // A Secrets Store binding standing in for the flag is an object, never the word "on".
    const binding = { get: async () => 'on' } as unknown as string;
    expect(causeOf(agentArmingStatic(armedEnv({ AGENT_ENABLED: binding }), ROUTES))).toBe(
      'flag_invalid',
    );
  });
});

describe('the ladder (P2-2: test and development only)', () => {
  it('refuses staging and production whatever else they set', async () => {
    expect([...AGENT_ARMABLE_ENVS]).toEqual(['test', 'development']);
    for (const appEnv of ['staging', 'production'] as const) {
      const everything = armedEnv({ APP_ENV: appEnv, AGENT_ARMING_RECORD: 'SEC-1' });
      expect(causeOf(agentArmingStatic(everything, ROUTES))).toBe('env_not_armable');
      expect(causeOf(await agentArming(everything, ROUTES, probes()))).toBe('env_not_armable');
    }
  });

  it('a deployed env needs an identifier-shaped arming record; a local one does not', () => {
    for (const record of [undefined, '', 'sec-1', 'SEC-0', 'SEC-1 ', 'SEC_1']) {
      const e = armedEnv({ APP_ENV: 'staging', AGENT_ARMING_RECORD: record });
      expect(causeOf(agentArmingStatic(e, ROUTES, ALL_RUNGS)), String(record)).toBe(
        'arming_record_missing',
      );
    }
    const recorded = armedEnv({ APP_ENV: 'production', AGENT_ARMING_RECORD: 'AICOE-668' });
    expect(agentArmingStatic(recorded, ROUTES, ALL_RUNGS).armed).toBe(true);
    expect(agentArmingStatic(armedEnv({ AGENT_ARMING_RECORD: undefined }), ROUTES).armed).toBe(
      true,
    );
  });
});

describe('the controls', () => {
  it('needs READ_AUDIT exactly "on" (C2) and a positive whole retention (C1)', () => {
    for (const value of [undefined, 'off', 'ON', 'true']) {
      expect(causeOf(agentArmingStatic(armedEnv({ READ_AUDIT: value }), ROUTES))).toBe(
        'read_audit_off',
      );
    }
    for (const value of [undefined, '', '0', '-1', '30.5', ' 30', '030', 'thirty']) {
      const e = armedEnv({ AGENT_TRANSCRIPT_RETENTION_DAYS: value });
      expect(causeOf(agentArmingStatic(e, ROUTES)), String(value)).toBe('retention_invalid');
    }
    expect(agentArmingStatic(armedEnv({ AGENT_TRANSCRIPT_RETENTION_DAYS: '1' }), ROUTES)).toEqual({
      armed: true,
      retentionDays: 1,
    });
  });

  it('pins inference to "us" (C6) — staging may run other AI calls "global", never the agent', () => {
    for (const geo of ['global', 'GLOBAL', 'eu', ' us']) {
      const e = armedEnv({ AI_INFERENCE_GEO: geo });
      expect(causeOf(agentArmingStatic(e, ROUTES)), geo).toBe('inference_geo_not_us');
      const staging = { ...e, APP_ENV: 'staging' as const, AGENT_ARMING_RECORD: 'SEC-1' };
      expect(causeOf(agentArmingStatic(staging, ROUTES, ALL_RUNGS)), geo).toBe(
        'inference_geo_not_us',
      );
    }
    for (const geo of [undefined, '', 'us']) {
      expect(agentArmingStatic(armedEnv({ AI_INFERENCE_GEO: geo }), ROUTES).armed).toBe(true);
    }
  });

  it('needs a declared vault retention only while VAULT is bound', () => {
    expect(causeOf(agentArmingStatic(armedEnv({ VAULT }), ROUTES))).toBe('vault_retention_missing');
    const bad = armedEnv({ VAULT, VAULT_RETENTION_DAYS: '0' });
    expect(causeOf(agentArmingStatic(bad, ROUTES))).toBe('vault_retention_missing');
    expect(agentArmingStatic(armedEnv({ VAULT, VAULT_RETENTION_DAYS: '37' }), ROUTES).armed).toBe(
      true,
    );
  });

  it('needs the AGENT_RUN Workflow bound', () => {
    expect(causeOf(agentArmingStatic(armedEnv({ AGENT_RUN: undefined }), ROUTES))).toBe(
      'workflow_unbound',
    );
  });
});

describe('the DSR route — by identity, not by path', () => {
  it('is missing from the kit registry until P2-7 registers it', () => {
    expect(allRoutes.some((r) => isRegisteredDsrRoute(r))).toBe(false);
    expect(causeOf(agentArmingStatic(armedEnv(), allRoutes))).toBe('dsr_route_missing');
  });

  it('a same-path stub, or a copy of the registered route, does not satisfy it', () => {
    const stub = defineRoute({
      method: 'GET',
      path: DSR_PATH,
      permission: 'authenticated',
      input: z.object({}),
      handler: async () => ({}),
    });
    const copy: RouteDef = { spec: dsrRoute.spec };
    expect(isRegisteredDsrRoute(dsrRoute)).toBe(true);
    expect(isRegisteredDsrRoute(stub)).toBe(false);
    expect(isRegisteredDsrRoute(copy)).toBe(false);
    for (const impostor of [stub, copy]) {
      expect(causeOf(agentArmingStatic(armedEnv(), [...allRoutes, impostor]))).toBe(
        'dsr_route_missing',
      );
    }
    expect(agentArmingStatic(armedEnv(), [...REGISTRY, dsrRoute]).armed).toBe(true);
  });
});

describe('egress rulings — assertPrivateSourcesRuled over the live registry (C3)', () => {
  it('refuses an unruled exposed route in an app binding a client-class private database', () => {
    const unruled = [...ROUTES, exposedRoute()];
    expect(causeOf(agentArmingStatic(armedEnv(), unruled, { privateSources: CLIENT_DB }))).toBe(
      'ruling_missing',
    );
    // A ruling clears it; so does an app with no client-class source.
    const ruled = [...ROUTES, exposedRoute('C36-1561')];
    expect(agentArmingStatic(armedEnv(), ruled, { privateSources: CLIENT_DB }).armed).toBe(true);
    expect(agentArmingStatic(armedEnv(), unruled, { privateSources: {} }).armed).toBe(true);
    const internal = { privateSources: { ret1_ro: 'internal' } } as const;
    expect(agentArmingStatic(armedEnv(), unruled, internal).armed).toBe(true);
    // With no options it reads the APP's own AURORA_SOURCES: the kit's binds nothing and arms; a
    // fork that binds a client-class source (Insights and arena-go bind c360_ro) refuses. Both
    // answers are pinned on a fixed table by agent-arming-sources.test.ts.
    expect(causeOf(agentArmingStatic(armedEnv(), unruled))).toBe(
      clientPrivateSources().length > 0 ? 'ruling_missing' : 'armed',
    );
  });
});

describe('the probes — fail closed', () => {
  it('refuses unless the schema is accepted, and logs the drift with its state only', async () => {
    for (const [answer, state] of [
      [async () => 'refused' as const, 'refused'],
      [async () => 'unknown' as const, 'unknown'],
      [async () => 'nonsense' as never, 'unknown'],
      [
        async () => {
          throw new Error('D1 unreachable: agent_threads alice@client.example');
        },
        'unknown',
      ],
    ] as const) {
      const logs = captureLogs();
      try {
        const a = await agentArming(armedEnv(), ROUTES, probes({ schema: answer }));
        expect(causeOf(a)).toBe('schema_not_accepted');
        const drift = logs.named('agent_schema_drift');
        expect(drift).toHaveLength(1);
        expect(drift[0]).toEqual({
          event: 'agent_schema_drift',
          level: 'warn',
          state,
          remedy: 'apply_migration_0006_agent_tables',
        });
        logs.expectAbsent('alice@client.example', 'unreachable');
      } finally {
        logs.restore();
      }
    }
  });

  it('asks the real store probe, which accepts the kit schema', async () => {
    await applySchema();
    const db = makeDb(env);
    const a = await agentArming(
      armedEnv(),
      ROUTES,
      probes({ schema: () => db.agent.schemaSupport() }),
    );
    expect(a).toEqual({ armed: true, retentionDays: 30 });
  });

  it('asks for the reaper heartbeat only in deployed envs, and refuses a stale or broken one', async () => {
    const heartbeat = vi.fn(async (): Promise<number | null> => null);
    for (const appEnv of ['test', 'development'] as const) {
      const a = await agentArming(
        armedEnv({ APP_ENV: appEnv }),
        ROUTES,
        probes({ reaperHeartbeatAgeMs: heartbeat }),
        ALL_RUNGS,
      );
      expect(a.armed, appEnv).toBe(true);
    }
    expect(heartbeat).not.toHaveBeenCalled();
    const deployed = (appEnv: 'staging' | 'production') =>
      armedEnv({ APP_ENV: appEnv, AGENT_ARMING_RECORD: 'SEC-1' });
    const cases: [() => Promise<number | null>, AgentArmingCause | 'armed'][] = [
      [async () => null, 'reaper_stale'],
      [async () => AGENT_REAPER_STALE_MS + 1, 'reaper_stale'],
      [async () => Number.NaN, 'reaper_stale'],
      [async () => -1, 'reaper_stale'],
      [
        async () => {
          throw new Error('KV down');
        },
        'reaper_stale',
      ],
      [async () => AGENT_REAPER_STALE_MS, 'armed'],
      [async () => 0, 'armed'],
    ];
    expect([...AGENT_DEPLOYED_ENVS]).toEqual(['staging', 'production']);
    for (const appEnv of ['staging', 'production'] as const) {
      for (const [age, want] of cases) {
        const a = await agentArming(
          deployed(appEnv),
          ROUTES,
          probes({ reaperHeartbeatAgeMs: age }),
          ALL_RUNGS,
        );
        expect(causeOf(a), `${appEnv} ${String(age)}`).toBe(want);
      }
    }
  });
});

describe('kvReaperProbe — the heartbeat the reaper (P2-6) writes', () => {
  const NOW = Date.parse('2026-10-04T12:00:00.000Z');
  const now = () => NOW;
  beforeAll(async () => {
    await env.SESSIONS.delete(AGENT_REAPER_HEARTBEAT_KEY);
  });

  it('reads the age of an exact ISO-8601 stamp; anything else is no heartbeat', async () => {
    const probe = kvReaperProbe(env, now);
    expect(await probe()).toBeNull();
    const put = (v: string) => env.SESSIONS.put(AGENT_REAPER_HEARTBEAT_KEY, v);
    await put(new Date(NOW - 90_000).toISOString());
    expect(await probe()).toBe(90_000);
    // Up to 60 s ahead of this clock reads as fresh (clock skew); further ahead is not a stamp a
    // reaper wrote. Both edges pinned, so neither the bound nor its comparison can drift.
    await put(new Date(NOW + 5_000).toISOString());
    expect(await probe()).toBe(0);
    await put(new Date(NOW + 60_000).toISOString());
    expect(await probe()).toBe(0);
    await put(new Date(NOW + 60_001).toISOString());
    expect(await probe()).toBeNull();
    await put(new Date(NOW + 3_600_000).toISOString());
    expect(await probe()).toBeNull();
    for (const junk of ['', 'yesterday', '2026-10-04', String(NOW), '2026-10-04T11:59:00Z']) {
      await put(junk);
      expect(await probe(), junk).toBeNull();
    }
    await env.SESSIONS.delete(AGENT_REAPER_HEARTBEAT_KEY);
  });

  it('the stale bound is twice the reaper cron’s cadence: 10 minutes', () => {
    // Pinned as a value and against the cron, so neither moves without the other (DECISIONS
    // 2026-10-04 item 5; privacy must-fix 8 relies on a reaper that stops being seen within it).
    const step = /^\*\/([1-9][0-9]*) \* \* \* \*$/.exec(AGENT_REAPER_CRON);
    expect(step, AGENT_REAPER_CRON).not.toBeNull();
    const cadenceMs = Number(step?.[1]) * 60_000;
    expect(cadenceMs).toBe(300_000);
    expect(AGENT_REAPER_STALE_MS).toBe(2 * cadenceMs);
    expect(AGENT_REAPER_STALE_MS).toBe(600_000);
  });

  it('what the bound tolerates: every tick on time, not a missed one through the KV window', async () => {
    // The stamp is written after a run completes and read through SESSIONS KV, whose reads may be
    // up to ~60 s stale at a PoP (src/auth/sessions.ts). On time, the oldest age seen is one
    // cadence + a run + that window: fresh. One missed tick, it is two cadences + a run + that
    // window: past the bound, so arming refuses until the next stamp is seen — fail closed, the
    // availability cost the design's 10 minutes accepts (DECISIONS item 5).
    const CADENCE = 300_000;
    const KV_WINDOW = 60_000;
    const RUN = 30_000;
    const deployed = armedEnv({ APP_ENV: 'staging', AGENT_ARMING_RECORD: 'SEC-1' });
    const at = async (age: number) =>
      causeOf(
        await agentArming(
          deployed,
          ROUTES,
          probes({ reaperHeartbeatAgeMs: async () => age }),
          ALL_RUNGS,
        ),
      );
    expect(await at(CADENCE + RUN + KV_WINDOW)).toBe('armed');
    expect(await at(2 * CADENCE)).toBe('armed');
    expect(await at(2 * CADENCE + KV_WINDOW)).toBe('reaper_stale');
  });

  it('defaults to the wall clock', async () => {
    await env.SESSIONS.put(AGENT_REAPER_HEARTBEAT_KEY, new Date().toISOString());
    const age = await kvReaperProbe(env)();
    expect(age).not.toBeNull();
    expect(age as number).toBeLessThan(60_000);
    await env.SESSIONS.delete(AGENT_REAPER_HEARTBEAT_KEY);
  });
});

describe('the vocabulary the runtime reads (src/ai/agentVocabulary.mjs)', () => {
  it('positive whole days, arming records, rungs and deployed envs — exact comparisons', () => {
    expect(positiveDays('30')).toBe(30);
    for (const bad of [undefined, '', '0', '30.5', ' 30', 30]) expect(positiveDays(bad)).toBeNull();
    // The same shape as an egress ruling: both are Linear ids a DPO-facing record cites.
    expect(AGENT_ARMING_RECORD_PATTERN.source).toBe(EGRESS_RULING_PATTERN.source);
    expect(AGENT_ARMING_RECORD_PATTERN.flags).toBe(EGRESS_RULING_PATTERN.flags);
    expect(isArmingRecord('AICOE-668')).toBe(true);
    expect(isArmingRecord('aicoe-668')).toBe(false);
    expect(isArmingRecord(668)).toBe(false);
    expect(isAgentArmableEnv('test')).toBe(true);
    expect(isAgentArmableEnv('staging')).toBe(false);
    expect(isAgentArmableEnv('staging', ['staging'])).toBe(true);
    expect(isAgentArmableEnv(undefined)).toBe(false);
    expect(isAgentDeployedEnv('production')).toBe(true);
    expect(isAgentDeployedEnv('development')).toBe(false);
    expect(isAgentDeployedEnv(null)).toBe(false);
  });

  it('per-instance retention never outlives the transcripts (C9)', () => {
    expect(agentInstanceRetention(30)).toEqual({
      successRetention: '1 day',
      errorRetention: '7 days',
    });
    expect(agentInstanceRetention(3)).toEqual({
      successRetention: '1 day',
      errorRetention: '3 days',
    });
    expect(agentInstanceRetention(1)).toEqual({
      successRetention: '1 day',
      errorRetention: '1 day',
    });
  });
});
