// test/ai/agent-arming-sources.test.ts under the fork shape agent-arming-fork-unruled.test.ts
// describes: an exposed route with no ruling in the live registry. In a file of its own because the
// carried file mocks src/data/aurora itself, and that mock must register before anything loads the
// route framework — so the carried file is this file's FIRST import, and the check below loads
// what it reads dynamically. Kit-only: test/platform is not in /kit-upgrade's diff set.
import '../ai/agent-arming-sources.test';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/routes', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/routes')>();
  const { UNRULED_FORK_ROUTE: route } = await import('./agentArmingForkShapes');
  return { ...real, allRoutes: [...real.allRoutes, route] };
});

describe('fork shape: an exposed route with no ruling, under the forced client-class table', () => {
  it('runs the carried tests over that registry and that table (both mocks took)', async () => {
    const { allRoutes } = await import('../../src/routes');
    const { UNRULED_FORK_ROUTE } = await import('./agentArmingForkShapes');
    const { clientPrivateSources } = await import('../../src/framework/agentExposure');
    expect(allRoutes).toContain(UNRULED_FORK_ROUTE);
    expect(clientPrivateSources()).toEqual(['c360_ro']);
  });
});
