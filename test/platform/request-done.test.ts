// request_done replaces the platform's invocation log (PIA C5): one line per request with the
// matched route PATTERN, never the URL — which on this kit can carry a login token or an address.
import { SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';
import { captureLogs } from '../helpers/logs';

describe('request_done', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('logs method, route pattern, status and duration, never the path or query', async () => {
    const logs = captureLogs();
    try {
      // PATCH: the one method /api/users/:email is registered for, so a real :param route answers.
      const res = await SELF.fetch(`${BASE}/api/users/alice%40client.example?token=5eed5eed5eed`, {
        method: 'PATCH',
      });
      await res.arrayBuffer();
      const [done] = logs.named('request_done');
      expect(done).toMatchObject({ method: 'PATCH', status: res.status });
      expect(typeof done?.duration_ms).toBe('number');
      expect(done?.path).toBe('/api/users/:email');
      logs.expectAbsent('alice', 'client.example', 'token=', '5eed5eed5eed');
    } finally {
      logs.restore();
    }
  });

  it('a tokened auth URL logs its route pattern, not the query', async () => {
    const logs = captureLogs();
    try {
      const res = await SELF.fetch(`${BASE}/auth/verify?token=5eed5eed5eed`);
      await res.arrayBuffer();
      const done = logs.named('request_done');
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ method: 'GET', path: '/auth/verify', status: res.status });
      logs.expectAbsent('token=', '5eed5eed5eed');
    } finally {
      logs.restore();
    }
  });

  // The catch-all `/api/*` is registered after every real route, so it matches every API request.
  // The line must name the route whose handler ANSWERED — else every API call logs '/api/*' and
  // per-request debugging is gone for the whole API surface.
  it('names the route that answered, not the last one that matched', async () => {
    const cases: ReadonlyArray<
      [email: string | null, path: string, pattern: string, status: number]
    > = [
      [USERS.member, '/api/me', '/api/me', 200],
      [USERS.member, '/api/notes', '/api/notes', 200],
      [USERS.member, '/api/notes/12345', '/api/notes/:id', 404],
      [USERS.member, '/api/nope', '/api/*', 404],
      [null, '/auth/nope', '/*', 404],
    ];
    for (const [email, path, pattern, status] of cases) {
      const logs = captureLogs();
      try {
        const res = await asUser(email, 'GET', path);
        await res.arrayBuffer();
        expect(res.status, path).toBe(status);
        const done = logs.named('request_done');
        expect(done, path).toHaveLength(1);
        expect(done[0], path).toMatchObject({ method: 'GET', path: pattern, status });
      } finally {
        logs.restore();
      }
    }
  });
});
