import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALL_ROLES, can, PERMISSIONS } from '../../src/auth/permissions';
import type { Role } from '../../src/auth/types';
import type { Env } from '../../src/env';
import { defineRoute } from '../../src/framework/defineRoute';
import { type AppManifest, buildManifest, MANIFEST_VERSION } from '../../src/framework/manifest';
import { KIT_VERSION } from '../../src/framework/version';
import { allRoutes } from '../../src/routes';

// A minimal synthetic Env — buildManifest only reads identity fields, never bindings.
const ENV = {
  APP_NAME: 'test-app',
  APP_ENV: 'test',
  APP_BUILD_VERSION: 'abc123',
} as unknown as Env;

/** The published `needs` of one route, asserting it is a real (non-null) declared set. */
function scopedNeeds(m: AppManifest, key: string): string[] {
  const route = m.routes.find((r) => `${r.method} ${r.path}` === key);
  if (!route) throw new Error(`no route ${key} in the manifest`);
  if (route.needs === null) throw new Error(`route ${key} publishes no declared needs`);
  return route.needs;
}

/**
 * The BUILDER's key set, recorded per manifest version.
 *
 * Keyed by the version rather than pinned to one literal, and APPEND-ONLY: making CI green after a
 * shape change should mean adding the NEXT entry (5 after B9's 4), not quietly widening a shipped
 * one. No test can tell those two edits apart — that is the honest limit of this mechanism — but
 * keying by version makes the wrong one a visible rewrite of shipped history in review, and makes
 * the bump the shorter path.
 *
 * `MANIFEST_VERSION`'s own comment says "bump when the manifest SHAPE changes… so consumers can
 * gate on it". Nothing enforced that, and it had already stopped being true: three distinct shapes
 * have gone out as `manifest_version: 2`, two of them differing only in what the daily registry
 * report SENT. That is why the version covers projections too, and why the slice has its own
 * recorded shape in test/cron/reportToRegistry.test.ts, keyed to this same constant.
 *
 * NOT the whole HTTP response: `generated_at` is stamped by src/routes/meta.ts, not by
 * buildManifest, so it is pinned where it is produced (test/routes/meta.test.ts).
 */
const SHAPES: Record<number, { top: string[]; app: string[]; route: string[] }> = {
  2: {
    top: [
      'app',
      'audit_actions',
      'checks_version',
      'kit_version',
      'manifest_version',
      'permissions',
      'roles',
      'routes',
    ],
    app: ['build_version', 'env', 'name'],
    route: [
      'audit',
      'input_schema',
      'method',
      'needs',
      'path',
      'permission',
      'rate_limited',
      'summary',
    ],
  },
  // 3: the in-app agent's exposure — per route (`agent`, null when unexposed) and two top-level
  //    counts.
  3: {
    top: [
      'agent_client_egress',
      'agent_exposed',
      'app',
      'audit_actions',
      'checks_version',
      'kit_version',
      'manifest_version',
      'permissions',
      'roles',
      'routes',
    ],
    app: ['build_version', 'env', 'name'],
    route: [
      'agent',
      'audit',
      'input_schema',
      'method',
      'needs',
      'path',
      'permission',
      'rate_limited',
      'summary',
    ],
  },
  // 4: every route carries `machine` (RouteSpec.machine, B9) — a boolean on every route, never a
  // conditionally-spread key. Entry 3 plus `machine`.
  4: {
    top: [
      'agent_client_egress',
      'agent_exposed',
      'app',
      'audit_actions',
      'checks_version',
      'kit_version',
      'manifest_version',
      'permissions',
      'roles',
      'routes',
    ],
    app: ['build_version', 'env', 'name'],
    route: [
      'agent',
      'audit',
      'input_schema',
      'machine',
      'method',
      'needs',
      'path',
      'permission',
      'rate_limited',
      'summary',
    ],
  },
};

/** What the author who tripped this pin has to do — both halves, or the bump means nothing. */
const SHAPE_HINT = [
  '',
  'THE MANIFEST SHAPE AND MANIFEST_VERSION HAVE COME APART. Both halves are required:',
  '',
  '  1. ADD THE FIELD TO EVERY PROJECTION, or name it as a deliberate drop. In the kit that is',
  '     governanceManifest() in src/cron/reportToRegistry.ts, whose declared types (built with',
  '     Omit<Required<…>>) turn an omission into a compile error. Dropping a field is allowed —',
  '     but only by adding it to DroppedManifestField / DroppedRouteField, which is reviewable.',
  '',
  '  2. BUMP MANIFEST_VERSION in src/framework/manifest.ts and append a line to the version log',
  '     in its comment. A shape change that reuses a version number leaves every consumer unable',
  '     to tell an old kit from a kit that quietly stopped sending a field — which has already',
  '     happened once, to checks_version, fleet-wide.',
  '',
  '  3. ADD A NEW ENTRY to SHAPES here (and to SLICE_SHAPES in',
  '     test/cron/reportToRegistry.test.ts if the registry slice moved). Do NOT edit a shipped',
  '     entry — those record what the fleet was actually sent under that version number.',
  '',
].join('\n');

describe('MANIFEST_VERSION is a promise the shape has to keep', () => {
  it('pins the builder key set to the version — no field lands, or leaves, without a bump', () => {
    const shape = SHAPES[MANIFEST_VERSION];
    expect(shape, SHAPE_HINT).toBeDefined();
    if (!shape) return;
    const m = buildManifest(ENV, allRoutes);
    expect(Object.keys(m).sort(), SHAPE_HINT).toEqual([...shape.top].sort());
    expect(Object.keys(m.app).sort(), SHAPE_HINT).toEqual([...shape.app].sort());
    // Every route reported as ONE key set, compared as a set of shapes rather than per route:
    // this also refuses a conditionally-spread field, which would make a route's shape depend on
    // its own configuration and give the fleet two manifests under one version number.
    const routeShapes = new Set(m.routes.map((r) => Object.keys(r).sort().join(',')));
    expect([...routeShapes], SHAPE_HINT).toEqual([[...shape.route].sort().join(',')]);
  });
});

describe('buildManifest', () => {
  it('stamps the manifest, kit, and app identity', () => {
    const m = buildManifest(ENV, allRoutes);
    expect(m.manifest_version).toBe(MANIFEST_VERSION);
    expect(m.kit_version).toBe(KIT_VERSION);
    expect(m.app).toEqual({ name: 'test-app', env: 'test', build_version: 'abc123' });
  });

  it('null build_version when APP_BUILD_VERSION is unset', () => {
    const m = buildManifest({ APP_NAME: 'x', APP_ENV: 'test' } as unknown as Env, allRoutes);
    expect(m.app.build_version).toBeNull();
  });

  it('projects the whole route registry (one manifest route per registered route)', () => {
    const m = buildManifest(ENV, allRoutes);
    expect(m.routes.length).toBe(allRoutes.length);
    const paths = new Set(m.routes.map((r) => `${r.method} ${r.path}`));
    expect(paths.has('GET /api/notes')).toBe(true);
    expect(paths.has('POST /api/notes')).toBe(true);
    expect(paths.has('GET /api/meta/manifest')).toBe(true); // the manifest lists itself
  });

  it('carries the full permission matrix and role list verbatim', () => {
    const m = buildManifest(ENV, allRoutes);
    expect(m.roles).toEqual(ALL_ROLES);
    expect(m.permissions).toEqual(PERMISSIONS);
    expect(m.permissions['meta.read']).toEqual(['owner', 'admin']);
  });

  it('normalizes audit: string action / false opt-out / null for reads', () => {
    const m = buildManifest(ENV, allRoutes);
    const byKey = (mk: string) => m.routes.find((r) => `${r.method} ${r.path}` === mk);
    expect(byKey('POST /api/notes')?.audit).toBe('note.create'); // mutating → action string
    expect(byKey('GET /api/notes')?.audit).toBeNull(); // read → null
    expect(byKey('GET /api/meta/manifest')?.audit).toBeNull();
    // Every mutating route reports a string-or-false audit, never null (defineRoute enforces it).
    const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    for (const r of m.routes) {
      if (MUTATING.has(r.method))
        expect(r.audit === false || typeof r.audit === 'string').toBe(true);
    }
  });

  it('collects the distinct audit vocabulary, sorted, reads excluded', () => {
    const m = buildManifest(ENV, allRoutes);
    expect(m.audit_actions).toContain('note.create');
    expect(m.audit_actions).toContain('note.update');
    expect(m.audit_actions).toContain('note.delete');
    expect([...m.audit_actions]).toEqual([...m.audit_actions].sort()); // sorted
    expect(new Set(m.audit_actions).size).toBe(m.audit_actions.length); // distinct
    expect(m.audit_actions).not.toContain(null); // reads contribute nothing
  });

  it('emits JSON Schema for each route input (POST /api/notes carries its constraints)', () => {
    const m = buildManifest(ENV, allRoutes);
    const create = m.routes.find((r) => `${r.method} ${r.path}` === 'POST /api/notes');
    const schema = create?.input_schema as {
      type?: string;
      properties?: Record<string, { type?: string; maxLength?: number }>;
    };
    expect(schema.type).toBe('object');
    expect(schema.properties?.title?.type).toBe('string'); // the note title field
    // Every route yields SOME input_schema object (never undefined/thrown).
    for (const r of m.routes) expect(r.input_schema).toBeTypeOf('object');
  });

  // The manifest is an INPUT contract (io:'input'): a field with .default() is optional for the
  // caller, so it must NOT appear in `required`. Output view would wrongly mark it required and
  // make the codegen consumers (MCP tools, web client) force optional inputs. POST /api/notes has
  // `body` defaulting to '' — required must be exactly ['title'].
  it('describes defaulted fields as optional, not required (input-contract fidelity)', () => {
    const m = buildManifest(ENV, allRoutes);
    const create = m.routes.find((r) => `${r.method} ${r.path}` === 'POST /api/notes');
    const schema = create?.input_schema as {
      required?: string[];
      properties?: Record<string, { default?: unknown }>;
    };
    expect(schema.required).toEqual(['title']); // NOT ['title','body']
    expect('body' in (schema.properties ?? {})).toBe(true); // still described…
    expect(schema.properties?.body?.default).toBe(''); // …with its default surfaced
  });

  it('flags rate-limited routes (the AI endpoint) and leaves the rest false', () => {
    const m = buildManifest(ENV, allRoutes);
    expect(m.routes.find((r) => r.path === '/api/ai/complete')?.rate_limited).toBe(true);
    expect(m.routes.find((r) => r.path === '/api/notes' && r.method === 'GET')?.rate_limited).toBe(
      false,
    );
  });

  // `needs` is the per-route answer to "which table can this route touch". It is OPT-IN, so the
  // manifest has to publish three distinguishable states — declared-and-narrow, declared-and-empty,
  // and NOT DECLARED (ctx.db is the whole data layer). The last one is the dangerous one: if an
  // undeclared route published `[]`, every consumer downstream — the registry's governance map
  // included — would read the app's WIDEST routes as its narrowest.
  it('publishes the declared repository set of a scoped route', () => {
    const m = buildManifest(ENV, allRoutes);
    const byKey = (mk: string) => m.routes.find((r) => `${r.method} ${r.path}` === mk);
    expect(byKey('GET /api/notes')?.needs).toEqual(['notes']); // the golden example declares it
    expect(byKey('POST /api/notes')?.needs).toEqual(['notes']);
    expect(byKey('DELETE /api/notes/:id')?.needs).toEqual(['notes']);
  });

  it('publishes null — the unscoped marker — for a route that declares no needs', () => {
    const m = buildManifest(ENV, allRoutes);
    // The manifest route itself declares nothing: its handler reaches no repository, but it was
    // never narrowed, so what it MAY reach is everything. That is what null says.
    expect(m.routes.find((r) => r.path === '/api/meta/manifest')?.needs).toBeNull();
    // Null, never []. An undeclared route must not be representable as "scoped to nothing".
    for (const r of m.routes) {
      expect(r.needs === null || Array.isArray(r.needs)).toBe(true);
      if (r.needs !== null) expect(r.needs.length).toBeGreaterThan(0); // no kit route declares []
    }
  });

  // The published set must equal what the framework actually enforces (executeRoute hands
  // `spec.needs` to scopeDb), not a hand-kept second copy — that is the whole premise of a
  // derived manifest.
  it('mirrors every route spec exactly, so it cannot drift from what is enforced', () => {
    const m = buildManifest(ENV, allRoutes);
    for (const [i, def] of allRoutes.entries()) {
      const declared = def.spec.needs;
      expect(m.routes[i]?.needs).toEqual(declared === undefined ? null : [...declared].sort());
    }
  });

  it('keeps `[]` (declared, reaches nothing) distinct from absent (unscoped)', () => {
    const base = {
      method: 'GET',
      path: '/api/synthetic',
      permission: 'authenticated',
      input: z.object({}),
      handler: async () => ({}),
    } as const;
    const m = buildManifest(ENV, [
      defineRoute({ ...base, path: '/api/scoped', needs: ['notes'] }),
      defineRoute({ ...base, path: '/api/empty', needs: [] }),
      defineRoute({ ...base, path: '/api/unscoped' }),
    ]);
    expect(m.routes.map((r) => r.needs)).toEqual([['notes'], [], null]);
    // The two must not compare equal by any reasonable reading, in JS or in JSON.
    const [, empty, unscoped] = m.routes;
    expect(empty?.needs).not.toEqual(unscoped?.needs);
    expect(JSON.stringify(empty?.needs)).toBe('[]');
    expect(JSON.stringify(unscoped?.needs)).toBe('null');
  });

  it('publishes the set sorted, so a fleet-side diff tracks meaning, not literal order', () => {
    const m = buildManifest(ENV, [
      defineRoute({
        method: 'GET',
        path: '/api/multi',
        permission: 'authenticated',
        input: z.object({}),
        needs: ['users', 'notes', 'audit'],
        handler: async () => ({}),
      }),
    ]);
    expect(m.routes[0]?.needs).toEqual(['audit', 'notes', 'users']);
  });

  // Sharper than the roles/permissions copy below: `spec.needs` is the LIVE array executeRoute
  // hands to scopeDb on every request, and the proxy allows a repository via `needs.includes()`
  // against that same reference. If the manifest aliased it, an in-process consumer that
  // normalized the structure in place would be editing the enforcement itself — pushing 'users'
  // into a manifest array would grant the notes routes the users repository, for real, at runtime.
  it('hands out a copy — mutating manifest.needs cannot widen what a route may reach', () => {
    const spec = defineRoute({
      method: 'GET',
      path: '/api/scoped',
      permission: 'authenticated',
      input: z.object({}),
      needs: ['notes'],
      handler: async () => ({}),
    });
    // Mutate exactly as an in-place normalizer would — widen the published set…
    scopedNeeds(buildManifest(ENV, [spec]), 'GET /api/scoped').push('users');

    expect(spec.spec.needs).toEqual(['notes']); // …the live declaration is untouched…
    expect(scopedNeeds(buildManifest(ENV, [spec]), 'GET /api/scoped')).toEqual(['notes']); // …as is the next manifest

    // Same guarantee for the routes the app actually serves.
    scopedNeeds(buildManifest(ENV, allRoutes), 'GET /api/notes').push('tokens');
    expect(scopedNeeds(buildManifest(ENV, allRoutes), 'GET /api/notes')).toEqual(['notes']);
  });

  it('is pure — no generated_at, and two calls are deep-equal', () => {
    const a = buildManifest(ENV, allRoutes);
    const b = buildManifest(ENV, allRoutes);
    expect(a).toEqual(b);
    expect('generated_at' in a).toBe(false); // the clock lives in the route, not the builder
  });

  // The manifest is handed to IN-PROCESS consumers (fleet registry, MCP codegen). `as const` is
  // compile-time only — nothing stops a consumer from normalizing the structure in place at
  // runtime. If roles/permissions aliased the live matrix, that mutation would corrupt what can()
  // reads on every request. buildManifest hands out defensive copies; this proves it.
  it('hands out defensive copies — mutating the manifest cannot reach the live authz matrix', () => {
    const m = buildManifest(ENV, allRoutes);

    // Mutate exactly as an in-place normalizer would: reorder, extend, empty.
    (m.roles as Role[]).push('intruder' as Role);
    (m.roles as Role[]).sort();
    (m.permissions['notes.read'] as Role[]).push('intruder' as Role);
    (m.permissions['notes.write'] as Role[]).length = 0;

    // The globals can() reads every request are untouched…
    expect([...ALL_ROLES]).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(PERMISSIONS['notes.read']).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(can('viewer', 'notes.read')).toBe(true);
    expect(can('viewer', 'notes.write')).toBe(false);
    expect(can('member', 'notes.write')).toBe(true);

    // …and a fresh manifest is pristine — no cross-call contamination through a shared reference.
    const next = buildManifest(ENV, allRoutes);
    expect(next.roles).toEqual(ALL_ROLES);
    expect(next.permissions['notes.read']).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(next.permissions['notes.write']).toEqual(['owner', 'admin', 'member']);
  });
});

describe('buildManifest — agent exposure (manifest_version 3)', () => {
  const exposedRoutes = () => [
    defineRoute({
      method: 'GET',
      path: '/api/agent-read',
      permission: 'notes.read',
      needs: ['notes'],
      input: z.object({}),
      agent: { effect: 'read', description: 'prose that is never published' },
      handler: async () => ({}),
    }),
    defineRoute({
      method: 'POST',
      path: '/api/agent-send',
      permission: 'notes.write',
      needs: ['notes'],
      audit: 'agent.send',
      input: z.object({ note: z.string().max(100) }),
      agent: {
        effect: 'external',
        needsApproval: () => true,
        egress: ['mail.example.test', 'api.example.test'],
        egressRuling: 'C36-1561',
      },
      handler: async () => ({}),
    }),
    defineRoute({
      method: 'GET',
      path: '/api/agent-client',
      permission: 'notes.read',
      // A repository dataClass.ts does not classify: client-class by the fail-closed default.
      needs: ['companies' as 'notes'],
      input: z.object({}),
      agent: { effect: 'read', needsApproval: true, egressRuling: 'C36-1562' },
      handler: async () => ({}),
    }),
    defineRoute({
      method: 'GET',
      path: '/api/not-exposed',
      permission: 'notes.read',
      input: z.object({}),
      handler: async () => ({}),
    }),
  ];

  it('the kit exposes nothing: every route publishes agent null, and both counts are 0', () => {
    const m = buildManifest(ENV, allRoutes);
    expect(m.routes.every((r) => r.agent === null)).toBe(true);
    expect([m.agent_exposed, m.agent_client_egress]).toEqual([0, 0]);
  });

  it('publishes each exposure as structure — effect, approval mode, egress, ruling, class', () => {
    // `{}`: no private database, so each route's class is its own (see the next test for a fork
    // that binds a client-class one).
    const m = buildManifest(ENV, exposedRoutes(), {});
    expect(m.routes.map((r) => r.agent)).toEqual([
      {
        effect: 'read',
        needs_approval: 'never',
        egress: [],
        egress_ruling: null,
        client_class: false,
      },
      {
        effect: 'external',
        needs_approval: 'conditional',
        egress: ['api.example.test', 'mail.example.test'],
        egress_ruling: 'C36-1561',
        client_class: false,
      },
      {
        effect: 'read',
        needs_approval: 'always',
        egress: [],
        egress_ruling: 'C36-1562',
        client_class: true,
      },
      null,
    ]);
    // Exposed: 3. Client-class or egress (the ones that must carry a ruling): the send and the
    // client read.
    expect([m.agent_exposed, m.agent_client_egress]).toEqual([3, 2]);
  });

  it('a client-class private database makes every exposure client-class and ruling-bound', () => {
    const m = buildManifest(ENV, exposedRoutes(), { c360_ro: 'client' });
    expect(m.routes.map((r) => r.agent?.client_class ?? null)).toEqual([true, true, true, null]);
    expect([m.agent_exposed, m.agent_client_egress]).toEqual([3, 3]);
    // An internal one changes nothing.
    const internal = buildManifest(ENV, exposedRoutes(), { ret1_ro: 'internal' });
    expect([internal.agent_exposed, internal.agent_client_egress]).toEqual([3, 2]);
  });

  it('never publishes a function or the description prose, and survives a JSON round trip', () => {
    const m = buildManifest(ENV, exposedRoutes());
    const text = JSON.stringify(m.routes.map((r) => r.agent));
    expect(text).not.toContain('prose that is never published');
    expect(JSON.parse(text)).toEqual(m.routes.map((r) => r.agent));
  });

  it('hands out a copy of egress, not the live array the tool set reads', () => {
    const routes = exposedRoutes();
    const m = buildManifest(ENV, routes);
    m.routes[1]?.agent?.egress.push('evil.example.test');
    expect(routes[1]?.spec.agent?.egress).toEqual(['mail.example.test', 'api.example.test']);
  });
});
