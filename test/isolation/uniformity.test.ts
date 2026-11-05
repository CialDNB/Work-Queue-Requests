// THE 404-UNIFORMITY TRIPWIRE (right-sized from Arena's cross-tenant tripwire for
// single-tenant internal apps). For EVERY registered route with a path param it proves:
//   (a) a nonexistent resource, requested by an allowed role → 404
//   (b) a REAL resource, requested by a role lacking the permission → byte-identical 404
// A route can't opt out: defineRoute() throws without a fixture, and this suite walks
// the live registry — new endpoints are covered the moment they're registered.
//
// MACHINE ROUTES (RouteSpec.machine, B9) are probed as SERVICES. The machine gate 404s every person
// before the handler runs, so the person probes above would pass whatever the handler's not-found
// path does. For a machine route, (a) is asked by a service holding the route's key with a valid
// X-Sync-Run, and (b) by a service holding another key and by a person of every role. The kit
// ships no machine route, so the last describe runs the same check over stand-ins: one uniform,
// one whose not-found is not the canonical 404, which the check must refuse.
import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ALL_ROLES,
  can,
  grantableScopes,
  isServiceGrantable,
  PERMISSIONS,
  type PermissionKey,
} from '../../src/auth/permissions';
import { mintApiTokenFor } from '../../src/auth/tokens';
import type { PersonPrincipal, Role } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { defineRoute, mountRoutes, type RouteDef } from '../../src/framework/defineRoute';
import { AppError, notFound } from '../../src/framework/errors';
import { allRoutes } from '../../src/routes';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE, cookieFor } from '../helpers/http';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function fillPath(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ''),
  );
}

function ghostParams(path: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of path.matchAll(/:([A-Za-z0-9_]+)/g)) {
    const name = match[1] as string;
    params[name] = name === 'email' ? `ghost-${crypto.randomUUID()}@test.example` : '999999999';
  }
  return params;
}

const CANONICAL_404 = JSON.stringify({
  ok: false,
  error: { code: 'not_found', message: 'Not found' },
});

// Headers that legitimately vary per response and say nothing about existence.
const VARIABLE_HEADERS = new Set(['date', 'cf-ray', 'report-to', 'nel']);

// A stable fingerprint of a response's headers so denied-vs-missing can be compared
// byte-for-byte on the HEADER surface too — a distinguishing Cache-Control / ETag /
// Content-Length on one path would otherwise leak existence past a body-only check.
function headerFingerprint(res: Response): string {
  const entries = [...res.headers.entries()]
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .filter(([k]) => !VARIABLE_HEADERS.has(k))
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(entries);
}

// ── Machine routes: the service-side probe ───────────────────────────────────────────────────────

/** Where a request goes: the worker itself (the live registry), or a test app (the stand-ins). */
type Send = (path: string, init: RequestInit) => Promise<Response>;

const viaWorker: Send = (path, init) => SELF.fetch(BASE + path, init);

function viaApp(routes: RouteDef[]): Send {
  const app = new Hono<{ Bindings: Env }>();
  mountRoutes(app, routes);
  return async (path, init) => {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const res = await app.request(BASE + path, init, env, ctx);
    await Promise.allSettled(pending);
    return res;
  };
}

type Caller = { cookie: string } | { bearer: string };

function send(
  to: Send,
  method: string,
  path: string,
  who: Caller,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { origin: BASE, 'content-type': 'application/json' };
  if ('cookie' in who) headers.cookie = who.cookie;
  else {
    headers.authorization = `Bearer ${who.bearer}`;
    headers['x-sync-run'] = 'tripwire-run'; // valid, so the header check is never what answers
  }
  return to(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

/** A role that may give a service identity `key`: it manages identities and may delegate the key. */
function granterFor(key: PermissionKey): Role | undefined {
  return ALL_ROLES.find(
    (r) => can(r, 'serviceIdentities.manage') && grantableScopes(r).includes(key),
  );
}

/** A bearer token of a fresh synthetic service identity holding exactly `key`. */
async function serviceBearer(key: PermissionKey, slug: string): Promise<string> {
  const granter = granterFor(key);
  if (!granter) throw new Error(`no role may give a service identity ${key}`);
  const db = makeDb(env);
  const principalId = `svc-${slug}@test-app.invalid`;
  const created = await db.serviceIdentities.create({
    slug,
    principalId,
    name: `Tripwire ${slug}`,
    scope: key,
    custodianEmail: USERS[granter],
    createdBy: USERS[granter],
  });
  if (!created.ok) throw new Error(created.reason);
  const minter: PersonPrincipal = {
    kind: 'person',
    email: USERS[granter],
    name: null,
    role: granter,
    authMethod: 'magic_link',
    credentialTransport: 'cookie',
  };
  return (await mintApiTokenFor(db, minter, principalId, { name: slug })).token;
}

/** (a) and (b) for one machine route, as a service; throws (an assertion) on the first leak. */
async function expectMachineUniformity(to: Send, spec: RouteDef['spec']): Promise<void> {
  // defineRoute refuses a machine route behind 'authenticated' or a key no service may hold.
  const key = spec.permission as PermissionKey;
  const body = MUTATING.has(spec.method) && spec.method !== 'DELETE' ? {} : undefined;

  // (a) a service holding the key, a valid X-Sync-Run, a nonexistent resource
  const holder = await serviceBearer(key, 'tripwire-holder');
  const ghost = fillPath(spec.path, ghostParams(spec.path));
  const missingRes = await send(to, spec.method, ghost, { bearer: holder }, body);
  expect(missingRes.status).toBe(404);
  const missingBody = await missingRes.text();
  const missingHeaders = headerFingerprint(missingRes);
  expect(missingBody).toBe(CANONICAL_404);

  // (b) a REAL resource: a service holding ANOTHER key, and a person of every role
  const real = fillPath(spec.path, await spec.uniformityFixture!.seed(makeDb(env)));
  const callers: Array<[string, Caller]> = [];
  const other = (Object.keys(PERMISSIONS) as PermissionKey[]).find(
    (k) => k !== key && isServiceGrantable(k) && granterFor(k) !== undefined,
  );
  if (other)
    callers.push([
      `a service holding ${other}`,
      { bearer: await serviceBearer(other, 'tripwire-other') },
    ]);
  for (const role of ALL_ROLES) {
    callers.push([`${role} on a session`, { cookie: await cookieFor(USERS[role]) }]);
  }
  for (const [who, caller] of callers) {
    const deniedRes = await send(to, spec.method, real, caller, body);
    expect(deniedRes.status, who).toBe(404);
    expect(await deniedRes.text(), who).toBe(missingBody);
    expect(headerFingerprint(deniedRes), who).toBe(missingHeaders);
  }
}

describe('404-uniformity tripwire', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const paramRoutes = allRoutes.filter((def) => def.spec.path.includes(':'));

  it('has at least one parameterized route to cover', () => {
    expect(paramRoutes.length).toBeGreaterThan(0);
  });

  for (const def of paramRoutes) {
    const { spec } = def;
    it(`${spec.method} ${spec.path}: denied and missing are byte-identical`, async () => {
      expect(spec.uniformityFixture).toBeDefined();
      if (spec.machine === true) {
        await expectMachineUniformity(viaWorker, spec);
        return;
      }
      const allowedRoles: readonly Role[] =
        spec.permission === 'authenticated' ? ALL_ROLES : PERMISSIONS[spec.permission];
      const allowed = allowedRoles[0] as Role;
      const denied = ALL_ROLES.find((r) => !allowedRoles.includes(r));
      const body = MUTATING.has(spec.method) && spec.method !== 'DELETE' ? {} : undefined;

      // (a) allowed role, nonexistent resource
      const missingRes = await asUser(
        USERS[allowed],
        spec.method,
        fillPath(spec.path, ghostParams(spec.path)),
        body,
      );
      expect(missingRes.status).toBe(404);
      const missingBody = await missingRes.text();
      const missingHeaders = headerFingerprint(missingRes);
      expect(missingBody).toBe(CANONICAL_404);

      // (b) denied role, REAL resource — must be indistinguishable on EVERY surface:
      // status, body bytes, AND headers.
      if (denied) {
        const params = await spec.uniformityFixture!.seed(makeDb(env));
        const deniedRes = await asUser(
          USERS[denied],
          spec.method,
          fillPath(spec.path, params),
          body,
        );
        expect(deniedRes.status).toBe(404);
        expect(await deniedRes.text()).toBe(missingBody);
        expect(headerFingerprint(deniedRes)).toBe(missingHeaders);
      } else {
        // No role is denied this route (e.g. notes.read is granted to every role, or
        // permission === 'authenticated'), so there is no forbidden-vs-missing pair to
        // compare. Assert that's actually why we skip — if a future permission change
        // creates a denied role, `denied` becomes defined and branch (b) starts running,
        // so this can never silently mask a gap.
        expect(allowedRoles.length).toBe(ALL_ROLES.length);
      }
    });
  }

  it('unknown API paths render the same canonical 404', async () => {
    const res = await asUser(USERS.member, 'GET', '/api/definitely-not-a-real-resource');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(CANONICAL_404);
  });
});

describe('404-uniformity tripwire — the machine-route probe is not vacuous', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  // Two parameterized machine routes behind one service-grantable key. A run named `real-run`
  // exists; any other id is missing. The leaky one answers a missing id with its own message.
  const runRoute = (path: string, missing: () => AppError): RouteDef =>
    defineRoute({
      method: 'GET',
      path,
      permission: 'notes.write',
      machine: true,
      input: z.object({ runId: z.string() }),
      uniformityFixture: { seed: async () => ({ runId: 'real-run' }) },
      handler: async (_ctx, input) => {
        if (input.runId !== 'real-run') throw missing();
        return { runId: input.runId };
      },
    });
  const UNIFORM = runRoute('/api/tripwire-machine/runs/:runId', notFound);
  const LEAKY = runRoute(
    '/api/tripwire-leaky/runs/:runId',
    () => new AppError(404, 'not_found', 'run not found'),
  );

  it('a machine route whose missing and denied answers match passes', async () => {
    await expectMachineUniformity(viaApp([UNIFORM]), UNIFORM.spec);
  });

  it('a machine route whose not-found is not the canonical 404 is refused', async () => {
    const refusal = await expectMachineUniformity(viaApp([LEAKY]), LEAKY.spec).then(
      () => null,
      (err: unknown) => err as { actual?: unknown; expected?: unknown },
    );
    // Refused at (a), on the body: the service holding the key reads the handler's own message.
    expect(refusal?.actual).toContain('run not found');
    expect(refusal?.expected).toBe(CANONICAL_404);
  });
});
