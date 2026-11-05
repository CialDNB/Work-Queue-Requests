// THE AUTHORITY HOOK, end to end through the real resolvers. `authorityFor`
// (src/routes/authorityPolicy.ts) is fork-owned; the kit calls it from resolvePrincipal (cookie)
// and resolveApiTokenByHash (bearer) — and from resolveRunPrincipal for an agent turn, with
// `request: null` (test/auth/run-principal.test.ts) — and turns its answer into the principal's
// AUTHORITATIVE set (src/auth/authority.ts). Pinned here:
//
//   - THE KIT DEFAULT CHANGES NOTHING: role-only apps resolve the byte-identical principal.
//   - ONLY THE HOOK sets the set: nothing a session value or the request carries can.
//   - THE HOOK SEES the principal as resolved (frozen, no set) and the live user, session, request.
//   - EVERY FAILURE FAILS CLOSED: a refusal, a throw, a rejected promise and every malformed answer
//     are "no principal" (401) — never the role. The log carries codes only.
//   - ON A BEARER, the token's scopes narrow the set, the refusal hook runs AFTER and sees it, and a
//     service token never reaches the hook.
//   - EXTERNAL AUTHORITY IS THE APP'S DECLARATION: a set on an env not declared external refuses,
//     and while it is declared, the agent refuses every token — including one the hook left on the
//     role, which is how the documented ACL hook keeps local-authority tokens working.
//   - A denial by the set leaves one content-free `route_permission_denied` line; a role denial
//     leaves none.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolvePrincipal } from '../../src/auth';
import {
  authorityRefusesAgentRun,
  FORK_AUTHORITY,
  MAX_AUTHORITY_KEYS,
  readAuthorityDecision,
} from '../../src/auth/authority';
import { SESSION_COOKIE } from '../../src/auth/cookies';
import {
  can,
  effectivePermissions,
  type PermissionKey,
  principalCan,
} from '../../src/auth/permissions';
import { createServiceIdentity } from '../../src/auth/serviceIdentities';
import { createSession, type SessionData } from '../../src/auth/sessions';
import {
  mintApiToken,
  mintApiTokenFor,
  resolveApiTokenByHash,
  sha256Hex,
} from '../../src/auth/tokens';
import type {
  AuthorityCheck,
  AuthorityContext,
  AuthorityPolicy,
  ExternalAuthorityCheck,
  PersonCookiePrincipal,
  PersonPrincipal,
  Principal,
  Role,
  TokenRefusalCheck,
} from '../../src/auth/types';
import { makeDb } from '../../src/data';
import { defineRoute } from '../../src/framework/defineRoute';
import { executeRoute } from '../../src/framework/execute';
import { authorityFor, authorityIsExternal } from '../../src/routes/authorityPolicy';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { BASE } from '../helpers/http';
import { type CapturedLogs, captureLogs } from '../helpers/logs';

// The person these tests mint tokens for must hold notes.read and notes.write, and the app section of
// PERMISSIONS is the APP'S (Insights gives both to owner/admin only). So they use the least-privileged
// non-viewer role that holds both in THIS app, never a hard-coded 'member' (P1 dry run, AICOE-667).
const HOLDER: Role = (() => {
  const role = (['member', 'admin', 'owner'] as const).find(
    (r) => can(r, 'notes.read') && can(r, 'notes.write'),
  );
  if (!role)
    throw new Error('principal-authority tests need a role holding notes.read and notes.write');
  return role;
})();

async function sessionRequest(email: string, init: RequestInit = {}): Promise<Request> {
  const sid = await createSession(env, email, 'magic_link');
  const headers = new Headers(init.headers);
  headers.set('cookie', `${SESSION_COOKIE}=${sid}`);
  return new Request(`${BASE}/api/me`, { ...init, headers });
}

function sessionAsMember(): PersonCookiePrincipal {
  return {
    kind: 'person',
    email: USERS[HOLDER],
    name: null,
    role: HOLDER,
    authMethod: 'magic_link',
    credentialTransport: 'cookie',
  };
}

async function memberToken(scopes?: string[]): Promise<string> {
  const { token } = await mintApiToken(makeDb(env), sessionAsMember(), {
    name: 'authority-test',
    ...(scopes ? { scopes } : {}),
  });
  return token;
}

/**
 * `hook` as an app's policy: an EXTERNAL authority by default (the declaration a hook that answers
 * a set must make), or a role-only one with `external: false`.
 */
function acl(hook: AuthorityCheck, external = true): AuthorityPolicy {
  return { authorityFor: hook, authorityIsExternal: () => external };
}

/** A policy whose hook answers `answer` for everyone and records what it was handed. */
function recording(answer: unknown): {
  policy: AuthorityPolicy;
  calls: { principal: Readonly<PersonPrincipal>; context: AuthorityContext }[];
} {
  const calls: { principal: Readonly<PersonPrincipal>; context: AuthorityContext }[] = [];
  return {
    calls,
    policy: acl((principal, context) => {
      calls.push({ principal, context });
      return answer as ReturnType<AuthorityCheck>;
    }),
  };
}

let logs: CapturedLogs;
beforeAll(applySchema);
beforeEach(async () => {
  await seedDb();
  logs = captureLogs();
});
afterEach(() => logs.restore());

describe('the kit default: the role decides, and nothing about the principal changes', () => {
  it('authorityFor answers null for every person, on either credential', async () => {
    expect(await authorityFor(sessionAsMember(), {} as AuthorityContext)).toBeNull();
  });

  it('authorityIsExternal is false, and FORK_AUTHORITY is exactly the fork file', () => {
    expect(authorityIsExternal(env)).toBe(false);
    expect(FORK_AUTHORITY).toEqual({ authorityFor, authorityIsExternal });
    expect(Object.isFrozen(FORK_AUTHORITY)).toBe(true);
  });

  it('a session resolves to exactly the pre-seam principal — no `permissions` key at all', async () => {
    const p = await resolvePrincipal(await sessionRequest(USERS.admin), env);
    expect(p).toEqual({
      kind: 'person',
      email: USERS.admin,
      name: 'Ada Admin',
      role: 'admin',
      authMethod: 'magic_link',
      credentialTransport: 'cookie',
      // A fact about the session (P2 run authority), never authority: see the describe below.
      sessionCreatedAtMs: expect.any(Number),
    });
    expect(p && 'permissions' in p).toBe(false);
  });

  it('a token resolves without a set too', async () => {
    const p = await resolveApiTokenByHash(env, await sha256Hex(await memberToken()));
    expect(p).toMatchObject({ kind: 'person', credentialTransport: 'bearer' });
    expect(p && 'permissions' in p).toBe(false);
  });
});

describe('only the hook sets the set — nothing the request carries can', () => {
  it('a session value carrying `permissions` / `attributes` is ignored', async () => {
    const sid = await createSession(env, USERS.viewer, 'magic_link');
    const key = `session:${await sha256Hex(sid)}`;
    const stored = JSON.parse((await env.SESSIONS.get(key)) as string) as SessionData;
    await env.SESSIONS.put(
      key,
      JSON.stringify({ ...stored, permissions: ['users.manage'], attributes: { x: 1 } }),
    );
    const req = new Request(`${BASE}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${sid}`, 'x-permissions': 'users.manage' },
    });
    const p = (await resolvePrincipal(req, env)) as Principal;
    expect(p).not.toBeNull();
    expect('permissions' in p).toBe(false);
    expect('attributes' in p).toBe(false);
    expect(principalCan(p, 'users.manage')).toBe(false);
  });
});

describe('a deciding hook on a SESSION', () => {
  it('the set replaces the role for that request', async () => {
    const { policy } = recording({ permissions: ['notes.read', 'audit.read'] });
    const p = (await resolvePrincipal(await sessionRequest(USERS.owner), env, policy)) as Principal;
    expect(p.kind === 'person' && p.permissions).toEqual(new Set(['notes.read', 'audit.read']));
    expect(effectivePermissions(p)).toEqual(['audit.read', 'notes.read']);
    expect(principalCan(p, 'users.manage')).toBe(false); // the owner role had it
    expect(authorityRefusesAgentRun(p, env, policy)).toBe(false); // a session may run the agent
  });

  it('the hook is handed the frozen, role-based principal and the live user, session and request', async () => {
    const { policy, calls } = recording({ permissions: [] });
    const req = await sessionRequest(USERS[HOLDER]);
    await resolvePrincipal(req, env, policy);
    expect(calls).toHaveLength(1);
    const [{ principal, context }] = calls as [(typeof calls)[number]];
    expect(Object.isFrozen(principal)).toBe(true);
    expect('permissions' in principal).toBe(false);
    expect(principal).toMatchObject({ email: USERS[HOLDER], role: HOLDER });
    expect(context.user).toMatchObject({ email: USERS[HOLDER], role: HOLDER });
    expect(context.session).toMatchObject({ email: USERS[HOLDER], auth_method: 'magic_link' });
    expect(context.request).toBe(req);
    expect(context.env).toBe(env);
  });

  it('a hook that tries to rewrite the principal it was handed cannot', async () => {
    const hook: AuthorityCheck = (principal) => {
      try {
        (principal as { role: string }).role = 'owner';
      } catch {
        // frozen: strict mode throws, and the resolver's own object is untouched either way
      }
      return null;
    };
    const p = (await resolvePrincipal(
      await sessionRequest(USERS.viewer),
      env,
      acl(hook),
    )) as Principal;
    expect(p.role).toBe('viewer');
  });

  it("…nor widen a bearer's token ceiling by writing to the scope array it was handed", async () => {
    const token = await memberToken(['notes.read']);
    const hook: AuthorityCheck = (principal) => {
      try {
        (principal.tokenScopes as string[]).push('notes.write', 'ai.use');
      } catch {
        // frozen copy: the push throws, and the resolver's own array is a different object anyway
      }
      return null;
    };
    const p = (await resolveApiTokenByHash(
      env,
      await sha256Hex(token),
      undefined,
      acl(hook),
    )) as Principal;
    expect(p.tokenScopes).toEqual(['notes.read']);
    expect(effectivePermissions(p)).toEqual(['notes.read']);
  });

  it('attributes ride along, frozen, and no check reads them', async () => {
    const companies = [{ id: 'c-1' }];
    const { policy } = recording({
      permissions: ['notes.read'],
      attributes: { aclCompanies: companies, users_manage: true },
    });
    const p = (await resolvePrincipal(
      await sessionRequest(USERS.viewer),
      env,
      policy,
    )) as Principal;
    expect(p.kind === 'person' && p.attributes).toEqual({
      aclCompanies: companies,
      users_manage: true,
    });
    expect(Object.isFrozen(p.attributes)).toBe(true);
    expect(principalCan(p, 'users.manage')).toBe(false);
  });

  it('keys the app does not define are dropped, and the drop is counted (never named)', async () => {
    const { policy } = recording({ permissions: ['notes.read', 'advanced_insights_use', 'x.y'] });
    const p = (await resolvePrincipal(
      await sessionRequest(USERS[HOLDER]),
      env,
      policy,
    )) as Principal;
    expect(effectivePermissions(p)).toEqual(['notes.read']);
    expect(logs.named('principal_authority_keys_dropped')).toEqual([
      { event: 'principal_authority_keys_dropped', level: 'warn', transport: 'cookie', dropped: 2 },
    ]);
    logs.expectAbsent('advanced_insights_use');
  });

  it('an async hook works the same', async () => {
    const hook: AuthorityCheck = async () => ({ permissions: new Set<PermissionKey>(['ai.use']) });
    const p = (await resolvePrincipal(
      await sessionRequest(USERS.viewer),
      env,
      acl(hook),
    )) as Principal;
    expect(effectivePermissions(p)).toEqual(['ai.use']);
  });
});

// `sessionCreatedAtMs` (P2 run authority): when the session was minted, read from the STORED
// session by the resolver. An agent turn stores it beside the session key, and the DSR step-up
// reads it (recentlyAuthenticated) — so it must survive the authority seam, reach no bearer, and
// never be taken from anything the request carries.
describe('sessionCreatedAtMs: the stored mint time, carried through the authority seam', () => {
  const MINTED = 1_700_000_000_000;

  async function requestFor(sid: string): Promise<Request> {
    return new Request(`${BASE}/api/me`, { headers: { cookie: `${SESSION_COOKIE}=${sid}` } });
  }

  it("is the stored session's created_at_ms on the role path (the hook answers null)", async () => {
    const sid = await createSession(env, USERS[HOLDER], 'magic_link', MINTED);
    const p = (await resolvePrincipal(await requestFor(sid), env)) as PersonCookiePrincipal;
    expect(p.sessionCreatedAtMs).toBe(MINTED);
  });

  it("survives applyAuthority's spread when the hook answers a set — and the hook sees it", async () => {
    const sid = await createSession(env, USERS[HOLDER], 'magic_link', MINTED);
    const { policy, calls } = recording({ permissions: ['notes.read'] });
    const p = (await resolvePrincipal(await requestFor(sid), env, policy)) as PersonCookiePrincipal;
    expect(p.permissions).toEqual(new Set(['notes.read']));
    expect(p.sessionCreatedAtMs).toBe(MINTED);
    const handed = calls[0]?.principal as Readonly<PersonCookiePrincipal> | undefined;
    expect(handed?.sessionCreatedAtMs).toBe(MINTED);
    expect(Object.isFrozen(calls[0]?.principal)).toBe(true);
  });

  it('is absent when the stored session carries no usable mint time — never invented', async () => {
    for (const bogus of ['1700000000000', -1, 1.5, null]) {
      const sid = await createSession(env, USERS[HOLDER], 'magic_link', MINTED);
      const key = `session:${await sha256Hex(sid)}`;
      const stored = JSON.parse((await env.SESSIONS.get(key)) as string) as SessionData;
      await env.SESSIONS.put(key, JSON.stringify({ ...stored, created_at_ms: bogus }));
      const p = (await resolvePrincipal(await requestFor(sid), env)) as PersonCookiePrincipal;
      expect(p, String(bogus)).not.toBeNull(); // the session itself still resolves, as before
      expect('sessionCreatedAtMs' in p, String(bogus)).toBe(false);
    }
  });

  it('nothing the request carries sets it, and a bearer principal never has one', async () => {
    const sid = await createSession(env, USERS[HOLDER], 'magic_link', MINTED);
    const req = new Request(`${BASE}/api/me`, {
      headers: {
        cookie: `${SESSION_COOKIE}=${sid}`,
        'x-session-created-at-ms': String(Date.now()),
      },
    });
    expect(((await resolvePrincipal(req, env)) as PersonCookiePrincipal).sessionCreatedAtMs).toBe(
      MINTED,
    );
    const token = await resolveApiTokenByHash(env, await sha256Hex(await memberToken()));
    expect(token && 'sessionCreatedAtMs' in token).toBe(false);
  });
});

describe('every failure fails CLOSED: no principal, never the role', () => {
  it('a refusal is a null principal, logged by its code', async () => {
    const { policy } = recording({ refuse: 'acl_app_grant_revoked' });
    expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, policy)).toBeNull();
    expect(logs.named('principal_authority_refused')).toEqual([
      {
        event: 'principal_authority_refused',
        level: 'warn',
        transport: 'cookie',
        reason: 'acl_app_grant_revoked',
      },
    ]);
  });

  it('a reason that is not a plain code is logged as `unspecified` — no data reaches the log', async () => {
    const { policy } = recording({ refuse: `no grant for ${USERS.owner}` });
    expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, policy)).toBeNull();
    expect(logs.named('principal_authority_refused')[0]?.reason).toBe('unspecified');
    logs.expectAbsent(USERS.owner);
  });

  it('a hook that THROWS refuses, and its message never reaches the log', async () => {
    const hook: AuthorityCheck = () => {
      throw new TypeError(`acl down for ${USERS.owner}`);
    };
    expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, acl(hook))).toBeNull();
    expect(logs.named('principal_authority_hook_failed')).toEqual([
      {
        event: 'principal_authority_hook_failed',
        level: 'error',
        transport: 'cookie',
        err: { name: 'TypeError' },
      },
    ]);
    logs.expectAbsent(USERS.owner, 'acl down');
  });

  it('a hook whose promise REJECTS refuses too', async () => {
    const hook: AuthorityCheck = () => Promise.reject(new Error('upstream 503'));
    expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, acl(hook))).toBeNull();
    expect(logs.named('principal_authority_hook_failed')).toHaveLength(1);
  });

  const throwingIterable = {
    *[Symbol.iterator]() {
      yield 'notes.read';
      throw new Error('boom');
    },
  };
  const tooMany = Array.from({ length: MAX_AUTHORITY_KEYS + 1 }, () => 'notes.read');
  const MALFORMED: [string, unknown][] = [
    // A hook that fell off the end (a branch with no `return`): never the role — see below.
    ['no_answer', undefined],
    ['not_an_object', 'notes.read'],
    ['not_an_object', ['notes.read']],
    ['not_an_object', new Set(['notes.read'])],
    ['not_an_object', true],
    ['ambiguous', { refuse: 'x', permissions: ['notes.read'] }],
    ['ambiguous', { refuse: 'x', attributes: {} }],
    ['no_decision', {}],
    ['no_decision', { attributes: { a: 1 } }],
    ['permissions_not_iterable', { permissions: 'notes.read' }],
    ['permissions_not_iterable', { permissions: 42 }],
    ['permissions_not_iterable', { permissions: { 'notes.read': true } }],
    ['permissions_not_iterable', { permissions: null }],
    ['key_not_a_string', { permissions: ['notes.read', 7] }],
    ['too_many_keys', { permissions: tooMany }],
    ['permissions_unreadable', { permissions: throwingIterable }],
    ['attributes_not_an_object', { permissions: [], attributes: ['x'] }],
    ['attributes_not_an_object', { permissions: [], attributes: 'x' }],
  ];

  for (const [cause, answer] of MALFORMED) {
    it(`a malformed answer refuses (${cause}: ${JSON.stringify(answer)?.slice(0, 40)})`, async () => {
      expect(readAuthorityDecision(answer)).toEqual({ kind: 'invalid', cause });
      const { policy } = recording(answer);
      expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, policy)).toBeNull();
      expect(logs.named('principal_authority_invalid')).toEqual([
        { event: 'principal_authority_invalid', level: 'error', transport: 'cookie', cause },
      ]);
    });
  }

  it('an answer whose getter THROWS refuses (a 401), it does not escape as a 500', async () => {
    const trap = {
      get permissions(): string[] {
        throw new Error('getter exploded');
      },
    };
    expect(readAuthorityDecision(trap)).toEqual({
      kind: 'invalid',
      cause: 'permissions_unreadable',
    });
    const { policy } = recording(trap);
    expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, policy)).toBeNull();
    expect(logs.named('principal_authority_invalid')[0]?.cause).toBe('permissions_unreadable');
  });

  it('a refusal field of any other shape still refuses (as `unspecified`)', () => {
    for (const refuse of [true, 0, '', { code: 'x' }]) {
      expect(readAuthorityDecision({ refuse })).toEqual({ kind: 'refuse', reason: 'unspecified' });
    }
  });

  it('only an explicit null is the role; an iterable of known keys is the set', () => {
    expect(readAuthorityDecision(null)).toEqual({ kind: 'role' });
    expect(readAuthorityDecision(undefined)).toEqual({ kind: 'invalid', cause: 'no_answer' });
    const read = readAuthorityDecision({ permissions: new Set(['notes.read', 'notes.read']) });
    expect(read).toMatchObject({ kind: 'authoritative', dropped: 0 });
    expect(read.kind === 'authoritative' && [...read.permissions]).toEqual(['notes.read']);
  });

  it('a hook with a branch that falls off the end refuses there — it never hands out the role', async () => {
    // The shape an ACL hook takes: several refusals, one success, and — the bug — no final
    // `return` when the upstream call failed. That path answers `undefined`, which used to read
    // as "the role decides" and gave an ACL user their bookkeeping role during an outage.
    const upstreamUp = false;
    const hook = (async () => {
      if (upstreamUp) return { permissions: ['notes.read'] as PermissionKey[] };
    }) as unknown as AuthorityCheck;
    expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, acl(hook))).toBeNull();
    expect(logs.named('principal_authority_invalid')).toEqual([
      {
        event: 'principal_authority_invalid',
        level: 'error',
        transport: 'cookie',
        cause: 'no_answer',
      },
    ]);
  });

  it('…and such a hook does not typecheck: `undefined` is not an AuthorityDecision', () => {
    // @ts-expect-error — a missing `return` is not "the role"; only an explicit `null` is.
    const fallsThrough: AuthorityCheck = async (p) => (p.role === 'owner' ? null : undefined);
    expect(fallsThrough).toBeTypeOf('function');
  });

  it('a malformed answer is never read as the role: an owner with an invalid answer holds nothing', async () => {
    const { policy } = recording({ permissions: 'users.manage' });
    expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, policy)).toBeNull();
  });
});

describe('on a BEARER token', () => {
  it('the token scopes narrow the set; the set narrows the role', async () => {
    const token = await memberToken(['notes.read', 'notes.write']);
    const { policy, calls } = recording({ permissions: ['notes.read', 'ai.use'] });
    const p = (await resolveApiTokenByHash(
      env,
      await sha256Hex(token),
      undefined,
      policy,
    )) as Principal;
    expect(effectivePermissions(p)).toEqual(['notes.read']);
    expect(calls[0]?.context.session).toBeNull();
    expect(calls[0]?.context.request).toBeNull(); // re-resolved from a hash: no HTTP request
    expect(calls[0]?.principal).toMatchObject({ credentialTransport: 'bearer' });
    // An externally-authorised person on a token may not start an agent run.
    expect(authorityRefusesAgentRun(p, env, policy)).toBe(true);
  });

  it('through resolvePrincipal, the hook is handed the HTTP request', async () => {
    const token = await memberToken();
    const { policy, calls } = recording(null);
    const req = new Request(`${BASE}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(await resolvePrincipal(req, env, policy)).toMatchObject({ email: USERS[HOLDER] });
    expect(calls[0]?.context.request).toBe(req);
  });

  it('the refusal hook runs AFTER the authority and sees the set', async () => {
    const token = await memberToken();
    const seen: unknown[] = [];
    const refuse: TokenRefusalCheck = (p) => {
      seen.push(p.permissions);
      return null;
    };
    const { policy } = recording({ permissions: ['notes.read'] });
    await resolveApiTokenByHash(env, await sha256Hex(token), refuse, policy);
    expect(seen).toEqual([new Set(['notes.read'])]);
  });

  it('an authority refusal is a null principal, and the refusal hook is never asked', async () => {
    const token = await memberToken();
    let asked = false;
    const refuse: TokenRefusalCheck = () => {
      asked = true;
      return null;
    };
    const { policy } = recording({ refuse: 'acl_bearer' });
    expect(await resolveApiTokenByHash(env, await sha256Hex(token), refuse, policy)).toBeNull();
    expect(asked).toBe(false);
    expect(logs.named('principal_authority_refused')[0]).toMatchObject({
      transport: 'bearer',
      reason: 'acl_bearer',
    });
  });

  it('a SERVICE token never reaches the hook — its one scope is the kit business', async () => {
    const owner: PersonCookiePrincipal = {
      ...sessionAsMember(),
      email: USERS.owner,
      role: 'owner',
    };
    const db = makeDb(env);
    const { identity } = await createServiceIdentity(db, env, owner, {
      slug: 'etl',
      name: 'ETL',
      scope: 'notes.read',
      custodianEmail: USERS.owner,
    });
    const { token } = await mintApiTokenFor(db, owner, identity.principal_id, { name: 'etl' });
    const hook: AuthorityCheck = () => {
      throw new Error('must not be called for a service');
    };
    const p = await resolveApiTokenByHash(env, await sha256Hex(token), undefined, acl(hook));
    expect(p).toMatchObject({ kind: 'service', service: { scope: 'notes.read' } });
    expect(p && 'permissions' in p).toBe(false);
    expect(logs.named('principal_authority_hook_failed')).toEqual([]);
  });
});

describe('external authority is declared by the APP, so the agent refuses its tokens', () => {
  // The documented example (src/routes/authorityPolicy.ts) in the insights shape: the ACL credential
  // FIRST; with ACL configured, a session without one is refused and a TOKEN stays on the role
  // (local authority). `aclSessions` stands in for the sessions that carry `acl_access_token`.
  function documentedAcl(configured: boolean, aclSessions: ReadonlySet<string>): AuthorityPolicy {
    return {
      authorityIsExternal: () => configured,
      authorityFor: (principal, { session }) => {
        if (session !== null && aclSessions.has(session.email)) {
          return { permissions: ['notes.read', 'ai.use'] };
        }
        if (!configured) return null;
        if (principal.credentialTransport === 'cookie') return { refuse: 'no_acl_credential' };
        return null;
      },
    };
  }

  it('a token the hook left on the role runs on the role — and may not start an agent run', async () => {
    const policy = documentedAcl(true, new Set([USERS[HOLDER]]));
    const token = await memberToken();
    const p = (await resolveApiTokenByHash(
      env,
      await sha256Hex(token),
      undefined,
      policy,
    )) as Principal;
    expect(p).toMatchObject({ kind: 'person', credentialTransport: 'bearer', role: HOLDER });
    expect('permissions' in p).toBe(false);
    expect(principalCan(p, 'notes.write')).toBe(true); // local authority, for the request itself
    expect(authorityRefusesAgentRun(p, env, policy)).toBe(true);
  });

  it('the same person on an ACL session holds the grant, not the role, and may run the agent', async () => {
    const policy = documentedAcl(true, new Set([USERS[HOLDER]]));
    const p = (await resolvePrincipal(
      await sessionRequest(USERS[HOLDER]),
      env,
      policy,
    )) as Principal;
    expect(effectivePermissions(p)).toEqual(['ai.use', 'notes.read']);
    expect(principalCan(p, 'notes.write')).toBe(false);
    expect(authorityRefusesAgentRun(p, env, policy)).toBe(false);
  });

  it('a session with no ACL credential while ACL is configured is refused outright', async () => {
    const policy = documentedAcl(true, new Set());
    expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, policy)).toBeNull();
    expect(logs.named('principal_authority_refused')[0]?.reason).toBe('no_acl_credential');
  });

  it('ACL unconfigured: a session WITH an ACL credential is refused, never the role; one without is the role', async () => {
    const policy = documentedAcl(false, new Set([USERS.owner]));
    expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, policy)).toBeNull();
    expect(logs.named('principal_authority_invalid')[0]?.cause).toBe('undeclared_external');
    const p = (await resolvePrincipal(
      await sessionRequest(USERS.viewer),
      env,
      policy,
    )) as Principal;
    expect(p).toMatchObject({ role: 'viewer' });
    expect(authorityRefusesAgentRun(p, env, policy)).toBe(false); // a role-only app, on this env
  });

  it('a hook that answers a set on an env not declared external refuses (undeclared_external)', async () => {
    const policy = acl(() => ({ permissions: ['notes.read'] }), false);
    expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, policy)).toBeNull();
    expect(logs.named('principal_authority_invalid')).toEqual([
      {
        event: 'principal_authority_invalid',
        level: 'error',
        transport: 'cookie',
        cause: 'undeclared_external',
      },
    ]);
    const token = await memberToken();
    expect(await resolveApiTokenByHash(env, await sha256Hex(token), undefined, policy)).toBeNull();
  });

  it('a declaration that throws or is not a boolean: a set refuses, and so does the agent', async () => {
    const broken: ExternalAuthorityCheck[] = [
      () => {
        throw new Error(`config for ${USERS.owner}`);
      },
      () => 'yes' as unknown as boolean,
      () => undefined as unknown as boolean,
    ];
    for (const authorityIsExternal of broken) {
      const deciding: AuthorityPolicy = {
        authorityFor: () => ({ permissions: ['notes.read'] }),
        authorityIsExternal,
      };
      expect(await resolvePrincipal(await sessionRequest(USERS.owner), env, deciding)).toBeNull();
      const roleOnly: AuthorityPolicy = { authorityFor: () => null, authorityIsExternal };
      const p = (await resolvePrincipal(
        await sessionRequest(USERS.owner),
        env,
        roleOnly,
      )) as Principal;
      expect(authorityRefusesAgentRun(p, env, roleOnly)).toBe(true);
    }
    logs.expectAbsent(USERS.owner);
  });

  it('declared external, a person the hook left on the role may not run the agent on any credential', async () => {
    const policy = acl(() => null, true);
    const session = (await resolvePrincipal(
      await sessionRequest(USERS.owner),
      env,
      policy,
    )) as Principal;
    const token = (await resolveApiTokenByHash(
      env,
      await sha256Hex(await memberToken()),
      undefined,
      policy,
    )) as Principal;
    expect(authorityRefusesAgentRun(session, env, policy)).toBe(true);
    expect(authorityRefusesAgentRun(token, env, policy)).toBe(true);
  });

  it('the flag defaults to the fork policy: role-only in the kit, so nothing is refused', async () => {
    const p = (await resolvePrincipal(await sessionRequest(USERS[HOLDER]), env)) as Principal;
    const t = (await resolveApiTokenByHash(env, await sha256Hex(await memberToken()))) as Principal;
    expect(authorityRefusesAgentRun(p, env)).toBe(false);
    expect(authorityRefusesAgentRun(t, env)).toBe(false);
  });
});

describe('a denial by the set is logged, content-free; a role denial is not', () => {
  const route = defineRoute({
    method: 'GET',
    path: '/api/authority-probe',
    permission: 'notes.write',
    input: z.object({}),
    handler: async () => ({ ok: true }),
  }).spec;

  async function run(principal: Principal): Promise<unknown> {
    return executeRoute(env, route, principal, {
      ip: '',
      params: {},
      request: new Request(`${BASE}/api/authority-probe`),
      waitUntil: () => {},
      buildRawInput: () => ({}),
      invocation: { via: 'http' },
    }).catch((err: unknown) => err);
  }

  it('an owner whose authority withholds the key: the uniform 404 and one line', async () => {
    const { policy } = recording({ permissions: ['notes.read', 'ai.use'] });
    const p = (await resolvePrincipal(await sessionRequest(USERS.owner), env, policy)) as Principal;
    expect(await run(p)).toMatchObject({ status: 404, code: 'not_found' });
    expect(logs.named('route_permission_denied')).toEqual([
      {
        event: 'route_permission_denied',
        level: 'warn',
        method: 'GET',
        path: '/api/authority-probe',
        permission: 'notes.write',
        source: 'authority',
        transport: 'cookie',
        held: 2,
      },
    ]);
    logs.expectAbsent(USERS.owner);
  });

  it('the same set holding the key: the handler runs', async () => {
    const { policy } = recording({ permissions: ['notes.write'] });
    const p = (await resolvePrincipal(
      await sessionRequest(USERS.viewer),
      env,
      policy,
    )) as Principal;
    expect(await run(p)).toEqual({ ok: true });
  });

  it('a bearer whose SET holds the key but whose token scopes do not: the 404, and no line', async () => {
    // The token denied it, not the authority: `source: 'authority'` would name the wrong one.
    const token = await memberToken(['notes.read']);
    const { policy } = recording({ permissions: ['notes.read', 'notes.write'] });
    const p = (await resolveApiTokenByHash(
      env,
      await sha256Hex(token),
      undefined,
      policy,
    )) as Principal;
    expect(await run(p)).toMatchObject({ status: 404 });
    expect(logs.named('route_permission_denied')).toEqual([]);
  });

  it('a bearer whose SET lacks the key: the line, on the bearer transport', async () => {
    const token = await memberToken(['notes.read', 'notes.write']);
    const { policy } = recording({ permissions: ['notes.read'] });
    const p = (await resolveApiTokenByHash(
      env,
      await sha256Hex(token),
      undefined,
      policy,
    )) as Principal;
    expect(await run(p)).toMatchObject({ status: 404 });
    expect(logs.named('route_permission_denied')).toMatchObject([
      { source: 'authority', transport: 'bearer', permission: 'notes.write', held: 1 },
    ]);
  });

  it('a role denial (no authority) leaves no line, exactly as before', async () => {
    const p = (await resolvePrincipal(await sessionRequest(USERS.viewer), env)) as Principal;
    expect(await run(p)).toMatchObject({ status: 404 });
    expect(logs.named('route_permission_denied')).toEqual([]);
  });
});
