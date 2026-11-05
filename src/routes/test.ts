import { z } from 'zod';
import { defineRoute } from '../framework/defineRoute';

// A smoke-check endpoint: proves a signed-in caller can reach the API end to end.
// It returns a fixed string, reads no data and changes nothing, so it carries no permission key:
// 'authenticated' (like GET /api/me) is enough. Like /api/me it declares no `needs`: the kit's
// manifest treats an empty list as invalid, and the handler never touches ctx.db.
export const TEST_MESSAGE = 'Hello from Work Queue Requests: the API is up.';

export const testRoutes = [
  defineRoute({
    method: 'GET',
    path: '/api/test',
    permission: 'authenticated',
    summary: 'Return a fixed test message (smoke check for a signed-in caller)',
    input: z.object({}),
    handler: async () => ({ message: TEST_MESSAGE }),
  }),
];
