// THE CARRIED ARMING TESTS, RUN AS A FORK THAT EXPOSES A ROUTE WITH NO RULING RUNS THEM.
//
// An app that binds no client-class private database may expose a read route to the agent without
// an egressRuling. test/ai/agent-arming.test.ts rides /kit-upgrade unchanged and builds its route
// lists from that fork's live registry, so a case that forces a client-class table onto the whole
// registry refuses `ruling_missing` for the fork's route, not its own (pre-merge review of #262).
// The kit exposes no route, so only a registry that does can show it. Kit-only: test/platform is
// not in /kit-upgrade's diff set.
import { describe, expect, it, vi } from 'vitest';
import { clientPrivateSources, isAgentExposed } from '../../src/framework/agentExposure';
import { allRoutes } from '../../src/routes';
import { UNRULED_FORK_ROUTE } from './agentArmingForkShapes';
import '../ai/agent-arming.test';

vi.mock('../../src/routes', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/routes')>();
  const { UNRULED_FORK_ROUTE: route } = await import('./agentArmingForkShapes');
  return { ...real, allRoutes: [...real.allRoutes, route] };
});

describe('fork shape: an exposed route with no ruling, and no client-class source', () => {
  it('runs the carried tests over that registry (the mock took)', () => {
    expect(clientPrivateSources()).toEqual([]);
    expect(allRoutes).toContain(UNRULED_FORK_ROUTE);
    expect(isAgentExposed(UNRULED_FORK_ROUTE.spec)).toBe(true);
    expect(UNRULED_FORK_ROUTE.spec.agent?.egressRuling).toBeUndefined();
  });
});
