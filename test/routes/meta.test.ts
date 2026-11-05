import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, MANIFEST_VERSION } from '../../src/framework/manifest';
import { KIT_VERSION } from '../../src/framework/version';
import { createMetaRoutes } from '../../src/routes/meta';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser } from '../helpers/http';

interface ManifestBody {
  data: {
    manifest_version: number;
    kit_version: string;
    app: { name: string; env: string; build_version: string | null };
    permissions: Record<string, string[]>;
    routes: { method: string; path: string; permission: string }[];
    audit_actions: string[];
    generated_at: string;
  };
}

describe('GET /api/meta/manifest', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('owner reads the manifest; it lists itself and stamps generated_at', async () => {
    const res = await asUser(USERS.owner, 'GET', '/api/meta/manifest');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as ManifestBody;
    expect(data.kit_version).toBe(KIT_VERSION);
    expect(data.manifest_version).toBeGreaterThan(0);
    // Proves the registry was fully populated by request time — the meta route lists ITSELF, which
    // it can only do because index.ts hands it a lazy `() => allRoutes` accessor read at request
    // time (not an import of the barrel). See src/routes/meta.ts + the createMetaRoutes tests below.
    expect(data.routes.some((r) => r.path === '/api/meta/manifest')).toBe(true);
    expect(data.routes.some((r) => r.path === '/api/notes')).toBe(true);
    expect(data.permissions['meta.read']).toEqual(['owner', 'admin']);
    expect(Number.isNaN(Date.parse(data.generated_at))).toBe(false);
  });

  // `generated_at` is the one documented top-level manifest field buildManifest does NOT produce
  // — src/routes/meta.ts stamps it, deliberately, so the builder stays pure and snapshot-testable.
  // That makes it the field the SHAPES pin in test/framework/manifest.test.ts structurally cannot
  // see, so the HTTP response's key set is pinned here instead: rename or drop `generated_at` and
  // this goes red, rather than every consumer of /api/meta/manifest going quiet.
  it('the HTTP response is the builder key set plus exactly generated_at', async () => {
    const res = await asUser(USERS.owner, 'GET', '/api/meta/manifest');
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    // An EMPTY route list on purpose: the top-level key set does not depend on the routes,
    // and this keeps the assertion about the manifest's shape rather than the app's surface.
    const built = buildManifest(env, []);
    expect(Object.keys(data).sort()).toEqual([...Object.keys(built), 'generated_at'].sort());
    // …and it is stamped by the ROUTE, never the builder — the purity invariant the manifest's
    // snapshot-testability rests on.
    expect('generated_at' in built).toBe(false);
    // Any change to either half is a manifest SHAPE change, so it owes a MANIFEST_VERSION bump.
    expect(MANIFEST_VERSION).toBeGreaterThan(0);
  });

  it('admin can read the manifest too', async () => {
    const res = await asUser(USERS.admin, 'GET', '/api/meta/manifest');
    expect(res.status).toBe(200);
  });

  it('member and viewer get a uniform 404 (denial is indistinguishable from missing)', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const res = await asUser(USERS[role], 'GET', '/api/meta/manifest');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    }
  });

  it('anonymous requests are 401 (fail-closed)', async () => {
    const res = await asUser(null, 'GET', '/api/meta/manifest');
    expect(res.status).toBe(401);
  });
});

describe('createMetaRoutes (registry passed in, not imported — no meta↔index cycle)', () => {
  it('wires exactly the manifest route', () => {
    const routes = createMetaRoutes(() => []);
    expect(routes.map((r) => `${r.spec.method} ${r.spec.path}`)).toEqual([
      'GET /api/meta/manifest',
    ]);
    expect(routes[0]?.spec.permission).toBe('meta.read');
  });

  // The load-order landmine the old import cycle carried: if the accessor ran at construction, a
  // module importing routes/meta before routes/index would read `allRoutes` in its TDZ and throw at
  // boot. Deferring the call to request time is exactly what makes the cycle-free wiring safe.
  it('does NOT invoke the registry accessor at construction — only at request time', () => {
    let calls = 0;
    createMetaRoutes(() => {
      calls++;
      return [];
    });
    expect(calls).toBe(0);
  });
});
