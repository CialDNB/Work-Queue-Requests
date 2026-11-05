import { afterEach, describe, expect, it, vi } from 'vitest';
import { allRoutes } from '../../src/routes';
import { api } from '../../web/src/api';
import { API_ENDPOINTS } from '../../web/src/endpoints';

// Routes the worker exposes but the SPA deliberately does not call. A NEW route landing here
// forces a conscious choice — wire a client method, or add it to this list — so the client can't
// silently fall behind the registry. (meta = machine/registry surface; notes/:id = unused single
// GET; ai/complete = programmatic only.)
const NOT_CALLED_BY_SPA = new Set([
  'GET /api/meta/manifest',
  'GET /api/notes/:id',
  'POST /api/ai/complete',
  'GET /api/test',
]);

const registry = new Set(allRoutes.map((d) => `${d.spec.method} ${d.spec.path}`));
const clientEndpoints = new Set(Object.values(API_ENDPOINTS).map((e) => `${e.method} ${e.path}`));

describe('web API client ↔ route registry (drift guard)', () => {
  it('every endpoint the client calls is a real registered route (exact method + path)', () => {
    for (const ep of clientEndpoints) {
      expect(registry.has(ep), `client calls ${ep}, which is not a registered /api route`).toBe(
        true,
      );
    }
  });

  it('every registered route is either called by the client or explicitly excluded', () => {
    const uncovered = [...registry].filter((r) => !clientEndpoints.has(r)).sort();
    expect(uncovered).toEqual([...NOT_CALLED_BY_SPA].sort());
  });

  it('the exclude list only names real routes (no stale entries)', () => {
    for (const ep of NOT_CALLED_BY_SPA) {
      expect(registry.has(ep), `${ep} is excluded but no longer a registered route`).toBe(true);
    }
  });
});

describe('web API client request building (call() drives method/path/params/query/body)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    // A fresh Response per call — a Response body can only be read once, so a shared instance
    // would throw on the second request within a test.
    const mock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })),
      );
    vi.stubGlobal('fetch', mock);
    return mock;
  }
  const lastCall = (m: ReturnType<typeof stubFetch>) =>
    m.mock.calls[m.mock.calls.length - 1] as [string, RequestInit];

  // The client half of AICOE-398. The SPA used to advertise `content-type: application/json` on
  // EVERY request — including bodiless DELETEs — which is what made the server try to parse an
  // empty body and 400 every delete button. These pin the header to the body's actual presence.
  // (Untested before: reverting the client fix left the whole suite green.)
  it('does NOT advertise a JSON content-type when there is no body', async () => {
    const f = stubFetch();
    await api.notes.remove('n-1'); // a bodiless DELETE — the exact shape that broke
    const [, init] = lastCall(f);
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('DOES advertise a JSON content-type when a body is attached', async () => {
    const f = stubFetch();
    await api.notes.create('t', 'b');
    const [, init] = lastCall(f);
    expect(init.body).toBeDefined();
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('GET with no body: api.me() → GET /api/me, no body', async () => {
    const f = stubFetch();
    await api.me();
    const [url, init] = lastCall(f);
    expect(url).toBe('/api/me');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('POST with a JSON body: api.notes.create', async () => {
    const f = stubFetch();
    await api.notes.create('T', 'B');
    const [url, init] = lastCall(f);
    expect(url).toBe('/api/notes');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ title: 'T', body: 'B' }));
  });

  it('path :params are substituted and URL-encoded', async () => {
    const f = stubFetch();
    await api.users.update('a@b.com', { disabled: true });
    const [url, init] = lastCall(f);
    expect(url).toBe('/api/users/a%40b.com'); // :email encoded
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ disabled: true }));
  });

  it('numeric params are stringified: api.tokens.revoke(5) → DELETE /api/tokens/5', async () => {
    const f = stubFetch();
    await api.tokens.revoke(5);
    const [url, init] = lastCall(f);
    expect(url).toBe('/api/tokens/5');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('service identities: two path params substituted; the mint body carries name and expiry', async () => {
    const f = stubFetch();
    await api.serviceIdentities.revokeToken(3, 41);
    expect(lastCall(f)[0]).toBe('/api/service-identities/3/tokens/41');
    expect(lastCall(f)[1].method).toBe('DELETE');
    expect(lastCall(f)[1].body).toBeUndefined();
    await api.serviceIdentities.mint(3, 'etl prod', 365);
    expect(lastCall(f)[0]).toBe('/api/service-identities/3/tokens');
    expect(lastCall(f)[1].body).toBe(JSON.stringify({ name: 'etl prod', expires_in_days: 365 }));
    await api.serviceIdentities.update(3, { disabled: true });
    expect(lastCall(f)[1].method).toBe('PATCH');
    await api.serviceIdentities.revokeAll(3);
    expect(lastCall(f)[0]).toBe('/api/service-identities/3/revoke-tokens');
  });

  it('query params are appended; undefined values are dropped', async () => {
    const f = stubFetch();
    await api.notes.list('cur');
    expect(lastCall(f)[0]).toBe('/api/notes?limit=20&cursor=cur');
    await api.notes.list(); // no cursor
    expect(lastCall(f)[0]).toBe('/api/notes?limit=20');
  });

  // The move from encodeURIComponent to URLSearchParams must preserve cursor fidelity. Real
  // keyset cursors are base64 (btoa), whose alphabet includes +, /, and = — the exact chars
  // that differ between percent-encoding schemes. Use a value that definitely carries all three,
  // then round-trip through the client's encoding and back through the server's URL parser.
  it('a cursor with base64 chars (+, /, =) round-trips through the query encoding unchanged', async () => {
    const cursor = 'aB3+xY/9z=='; // literal +, /, and = — the base64-alphabet risk chars
    const f = stubFetch();
    await api.notes.list(cursor);
    const url = lastCall(f)[0];
    expect(url).toContain('cursor=aB3%2BxY%2F9z%3D%3D'); // + / = are percent-encoded on the wire
    const decoded = new URL(`https://x.invalid${url}`).searchParams.get('cursor');
    expect(decoded).toBe(cursor); // and the server decodes back to exactly what the SPA held
  });
});
