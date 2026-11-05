// The fork shape test/platform/agent-arming-fork-unruled*.test.ts run the carried arming tests
// under.
// Kit-only, like those files: test/platform is not in /kit-upgrade's diff set.
import { z } from 'zod';
import type { PermissionKey } from '../../src/auth/permissions';
import type { AgentExposure } from '../../src/framework/agentExposure';
import { defineRoute, type RouteDef } from '../../src/framework/defineRoute';

/**
 * An agent-exposed read route with NO egressRuling. Legal in an app that binds no client-class
 * private database (the ruling is required only where one is bound), so a fork may ship one —
 * and a carried test that forces a client-class table onto the live registry would then refuse
 * `ruling_missing` for a reason that is the fork's, not the test's.
 */
export const UNRULED_FORK_ROUTE: RouteDef = defineRoute({
  method: 'GET',
  path: '/api/fork-shape-unruled-read',
  permission: 'notes.read' as PermissionKey,
  needs: ['notes'],
  input: z.object({}),
  agent: { effect: 'read' } as AgentExposure,
  handler: async () => ({}),
});
