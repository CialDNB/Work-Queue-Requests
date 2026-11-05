// `RouteSpec.needs` — opt-in per-route least privilege over the data layer.
//
// Two halves have to hold together for the declaration to mean anything:
//   • the TYPE narrows (ctx.db is Pick<Db, needs>) — pinned by the @ts-expect-error below,
//     which fails `npm run typecheck` if ctx.db ever widens back to the full Db;
//   • the RUNTIME refuses (the view throws on an undeclared repository) — pinned here.
//
// And the third, the one that decides whether this is safe to put in front of every request
// in every fork: a route that declares NO needs must be on exactly the pre-change path —
// ctx.db is the makeDb() object itself, unwrapped. `scopedNeedsOf` makes that testable.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { defineRoute, mountRoutes } from '../../src/framework/defineRoute';
import { SCOPED_DB, scopeDb, scopedNeedsOf } from '../../src/framework/scopedDb';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { cookieFor } from '../helpers/http';
import { captureLogs } from '../helpers/logs';

describe('scopeDb — the runtime view behind `needs`', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const view = () => scopeDb(makeDb(env), ['notes'], 'GET', '/api/notes');

  it('passes through a declared repository, working exactly as the real one', async () => {
    const scoped = view();
    const created = await scoped.notes.create({
      title: 'declared',
      body: 'reachable',
      createdBy: USERS.member,
    });
    expect((await scoped.notes.get(created.id))?.title).toBe('declared');
  });

  it('throws on an undeclared repository, naming the route and what it reached for', () => {
    const scoped = view() as unknown as Record<string, unknown>;
    expect(() => scoped.users).toThrow(/GET \/api\/notes/);
    expect(() => scoped.users).toThrow(/ctx\.db\.users/);
    expect(() => scoped.users).toThrow(/needs/);
    // Every other repository in the Db, not just the interesting one.
    for (const repo of ['groups', 'audit', 'magicLinks', 'tokens', 'aiBudget', 'settings']) {
      expect(() => scoped[repo]).toThrow(/did not declare/);
    }
  });

  it('closes the getOwnPropertyDescriptor route around the get trap', () => {
    const scoped = view();
    expect(() => Object.getOwnPropertyDescriptor(scoped, 'users')).toThrow(/did not declare/);
    expect(Object.getOwnPropertyDescriptor(scoped, 'notes')?.value).toBeDefined();
    // The descriptor walk Object.entries/assign perform must not trip the denial.
    expect(Object.keys(Object.getOwnPropertyDescriptors(scoped))).toEqual(['notes']);
  });

  it('presents the shape it is typed as: only declared repos in `in` and Object.keys', () => {
    const scoped = view();
    expect('notes' in scoped).toBe(true);
    expect('users' in scoped).toBe(false);
    expect(Object.keys(scoped)).toEqual(['notes']);
    expect(Object.values(scoped)).toHaveLength(1);
    // Inherited props keep their ordinary meaning — the view is not a booby trap.
    expect('toString' in scoped).toBe(true);
  });

  it('leaves non-repository property access alone (no accidental landmines)', () => {
    const scoped = view() as unknown as Record<string | symbol, unknown>;
    expect(scoped.notARepository).toBeUndefined();
    expect(scoped.then).toBeUndefined(); // an await/thenable probe must not explode
    expect(scoped[Symbol.toStringTag]).toBeUndefined();
    expect(() => JSON.stringify(scoped)).not.toThrow();
  });

  it('supports an empty `needs` — a route that declares it touches no repository at all', () => {
    const none = scopeDb(makeDb(env), [], 'POST', '/api/nothing') as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(none)).toEqual([]);
    expect(() => none.notes).toThrow(/declared: none/);
  });

  it('brands the view with its needs; a plain makeDb() result carries no brand', () => {
    expect(scopedNeedsOf(view())).toEqual(['notes']);
    expect(scopedNeedsOf(makeDb(env))).toBeUndefined();
    expect((view() as unknown as Record<symbol, unknown>)[SCOPED_DB]).toEqual(['notes']);
  });
});

describe('defineRoute — `needs` end to end', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  function appWith(routes: Parameters<typeof mountRoutes>[1]): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    mountRoutes(app, routes);
    return app;
  }

  const get = async (app: Hono<{ Bindings: Env }>, url: string): Promise<Response> =>
    app.request(url, { headers: { cookie: await cookieFor(USERS.member) } }, env);

  it('a route declaring needs:[notes] reads ctx.db.notes', async () => {
    await makeDb(env).notes.create({
      title: 'visible',
      body: '',
      createdBy: USERS.member,
    });
    const app = appWith([
      defineRoute({
        method: 'GET',
        path: '/api/scoped-notes',
        permission: 'authenticated',
        needs: ['notes'],
        input: z.object({}),
        handler: async (ctx) => ctx.db.notes.list({ limit: 10 }),
      }),
    ]);
    const res = await get(app, 'https://x.test/api/scoped-notes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: { title: string }[] } };
    expect(body.data.items[0]?.title).toBe('visible');
  });

  it('the same route touching ctx.db.users fails as an opaque 500, with the reason in the log', async () => {
    const app = appWith([
      defineRoute({
        method: 'GET',
        path: '/api/scoped-overreach',
        permission: 'authenticated',
        needs: ['notes'],
        input: z.object({}),
        handler: async (ctx) => {
          // Exactly the ambient-authority reach `needs` exists to stop. The cast is the
          // point: even a handler that deliberately defeats the compiler is refused.
          const escaped = ctx.db as unknown as ReturnType<typeof makeDb>;
          return await escaped.users.getActive(USERS.owner);
        },
      }),
    ]);
    const logs = captureLogs();
    try {
      const res = await get(app, 'https://x.test/api/scoped-overreach');
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('users'); // opaque to the caller, as every 500 is
      expect(JSON.parse(text).error.code).toBe('internal_error');
      // …but diagnostic to the operator. Logs carry an error's CATEGORY, never its message (PIA
      // C5), so the repository it reached rides in the error's code — a code identifier.
      expect(logs.named('route_error')).toEqual([
        {
          event: 'route_error',
          method: 'GET',
          path: '/api/scoped-overreach',
          err: { name: 'NeedsScopeError', code: 'undeclared_repo:users' },
          level: 'error',
        },
      ]);
    } finally {
      logs.restore();
    }
  });

  it('a route with no `needs` gets the whole Db, unwrapped — the pre-change path exactly', async () => {
    const app = appWith([
      defineRoute({
        method: 'GET',
        path: '/api/unscoped',
        permission: 'authenticated',
        input: z.object({}),
        handler: async (ctx) => ({
          // No wrapper was built: the handler holds the makeDb() result itself.
          brand: scopedNeedsOf(ctx.db) ?? null,
          repositories: Object.keys(ctx.db).sort(),
          // …and every repository still answers, none of them throwing.
          reachable: (await ctx.db.users.getActive(USERS.owner))?.role ?? null,
          notes: (await ctx.db.notes.list({ limit: 1 })).items.length,
        }),
      }),
    ]);
    const res = await get(app, 'https://x.test/api/unscoped');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { brand: null; repositories: string[]; reachable: string };
    };
    expect(body.data.brand).toBeNull();
    expect(body.data.reachable).toBe('owner');
    expect(body.data.repositories).toEqual(Object.keys(makeDb(env)).sort());
  });

  it('`needs` does not touch the framework audit writes it never declared', async () => {
    const app = appWith([
      defineRoute({
        method: 'POST',
        path: '/api/scoped-writes',
        permission: 'authenticated',
        audit: 'scoped.write',
        // ctx.db.audit is NOT declared — yet the framework's own row, and the handler's
        // mediated ctx.audit(), must both still be written.
        needs: ['notes'],
        input: z.object({}),
        handler: async (ctx) => {
          const note = await ctx.db.notes.create({
            title: 'scoped write',
            body: '',
            createdBy: ctx.principal.email,
          });
          ctx.setAuditTarget(note.id);
          await ctx.audit('scoped.extra', note.id);
          return { id: note.id };
        },
      }),
    ]);
    const res = await app.request(
      'https://x.test/api/scoped-writes',
      {
        method: 'POST',
        headers: {
          cookie: await cookieFor(USERS.member),
          origin: 'https://x.test',
          'content-type': 'application/json',
        },
        body: '{}',
      },
      env,
    );
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare('SELECT action FROM audit_log ORDER BY id').all<{
      action: string;
    }>();
    expect(rows.results.map((r) => r.action).sort()).toEqual(['scoped.extra', 'scoped.write']);
  });
});

// COMPILE-TIME half of the contract. These are never run — `npm run typecheck` is the
// assertion. If ctx.db stopped narrowing, the @ts-expect-error would have nothing to
// suppress and typecheck would fail on the unused directive.
describe.skip('`needs` narrows ctx.db at compile time', () => {
  it('is enforced by tsc, not by vitest', () => {
    defineRoute({
      method: 'GET',
      path: '/api/type-pin',
      permission: 'authenticated',
      needs: ['notes'],
      input: z.object({}),
      handler: async (ctx) => {
        const declared = ctx.db.notes; // in the declared set: compiles
        // @ts-expect-error `users` is not in `needs`, so it is not on ctx.db
        const undeclared = ctx.db.users;
        return { declared: typeof declared, undeclared: typeof undeclared };
      },
    });
    defineRoute({
      method: 'GET',
      path: '/api/type-pin-unscoped',
      permission: 'authenticated',
      input: z.object({}),
      // No `needs` → the full Db, so both of these compile.
      handler: async (ctx) => ({ a: typeof ctx.db.notes, b: typeof ctx.db.users }),
    });
  });
});
