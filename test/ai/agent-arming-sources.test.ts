// THE RULING CHECK ON THE PRODUCTION PATH (src/ai/agentArming.ts; PIA C3).
//
// agent-arming.test.ts drives `ruling_missing` through the `privateSources` test seam. The
// checkpoints P2-8 and P2-9 add pass no options, so what they get is the DEFAULT: the app's own
// AURORA_SOURCES. The kit's table is empty, so only a table that names a client-class database
// can show the default is read at all — here src/data/aurora is replaced for this file alone with
// one that does, as a fork that binds one would ship it. In its own file because vi.mock applies
// to every import in the file: the armed cases next door need the kit's real, empty table.
//
// FORK-PORTABLE, like agent-arming.test.ts: the forced table must not judge a fork's own exposed
// routes (legal unruled in an app that binds no client-class source), so the route lists are the
// live registry minus what it exposes, plus this file's own routes.
// test/platform/agent-arming-fork-unruled-sources.test.ts runs this file under that shape.
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentArming, agentArmingStatic, registerDsrRoute } from '../../src/ai/agentArming';
import type { PermissionKey } from '../../src/auth/permissions';
import { AURORA_SOURCES } from '../../src/data/aurora';
import type { Env } from '../../src/env';
import { type AgentExposure, isAgentExposed } from '../../src/framework/agentExposure';
import { defineRoute, type RouteDef } from '../../src/framework/defineRoute';
import { allRoutes } from '../../src/routes';

vi.mock('../../src/data/aurora', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/data/aurora')>()),
  AURORA_SOURCES: Object.freeze({ c360_ro: 'client' }),
}));

const AGENT_RUN = {} as Workflow<{ readonly turnId: string }>;

const dsrRoute = defineRoute({
  method: 'GET',
  path: '/api/agent/dsr-sources-test',
  permission: 'authenticated',
  input: z.object({}),
  handler: async () => ({}),
});
registerDsrRoute(dsrRoute);

function exposedRoute(egressRuling?: string): RouteDef {
  return defineRoute({
    method: 'GET',
    path: '/api/agent-arming-sources-widgets',
    permission: 'notes.read' as PermissionKey,
    needs: ['notes'],
    input: z.object({}),
    agent: { effect: 'read', ...(egressRuling ? { egressRuling } : {}) } as AgentExposure,
    handler: async () => ({}),
  });
}

/** The live registry without the routes it exposes: what no fork's own exposures can move. */
const REGISTRY: readonly RouteDef[] = allRoutes.filter((route) => !isAgentExposed(route.spec));

const armedEnv: Env = {
  ...env,
  APP_ENV: 'test',
  AGENT_ENABLED: 'on',
  READ_AUDIT: 'on',
  AGENT_TRANSCRIPT_RETENTION_DAYS: '30',
  AGENT_RUN,
};

describe('agentArming with no options reads the app’s own AURORA_SOURCES', () => {
  it('runs against a table that binds a client-class database (the mock took)', () => {
    expect(AURORA_SOURCES).toEqual({ c360_ro: 'client' });
  });

  it('refuses ruling_missing for an unruled exposed route, with no privateSources passed', async () => {
    const routes = [...REGISTRY, dsrRoute, exposedRoute()];
    expect(agentArmingStatic(armedEnv, routes)).toEqual({ armed: false, cause: 'ruling_missing' });
    const probes = { schema: async () => 'accepted' as const, reaperHeartbeatAgeMs: async () => 0 };
    expect(await agentArming(armedEnv, routes, probes)).toEqual({
      armed: false,
      cause: 'ruling_missing',
    });
  });

  it('arms once the route carries its ruling', () => {
    const routes = [...REGISTRY, dsrRoute, exposedRoute('AICOE-668')];
    expect(agentArmingStatic(armedEnv, routes)).toEqual({ armed: true, retentionDays: 30 });
  });
});
