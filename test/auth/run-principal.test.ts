// RUN AUTHORITY (P2, PIA C15). An agent turn acts as the SESSION that started it, re-read before
// every round and every tool call: resolveRunPrincipal (src/auth/runPrincipal.ts). Pinned here:
//
//   - a live session resolves to the principal a browser request on it would get, the authority
//     hook's set included — and a change (role, set) lands on the very next call, no snapshot;
//   - every way the grant ends is null: logout, revocation, a disabled or removed user, a key that
//     names another session (email or mint time), a hook that refuses, throws or answers a set the
//     app has not declared, authorityRefusesAgentRun, and a principal that no longer holds
//     `agent.use` (a demotion, or a decided set that leaves it out);
//   - a revocation kills the turn's session, and only that: a session minted after it resolves for
//     ITS key;
//   - the hook is handed `request: null` and the stored session;
//   - recentlyAuthenticated is a cookie-only, fail-closed step-up.
//
// Fixtures are built at run time — session keys are hashed from fresh sids, never written as
// literals (gitleaks scans every branch).
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolvePrincipal } from '../../src/auth';
import { SESSION_COOKIE } from '../../src/auth/cookies';
import { type PermissionKey, principalCan } from '../../src/auth/permissions';
import {
  type RunAuthority,
  recentlyAuthenticated,
  resolveRunPrincipal,
} from '../../src/auth/runPrincipal';
import {
  createSession,
  destroySession,
  revokeAllSessions,
  sessionKeyOf,
} from '../../src/auth/sessions';
import { sha256Hex } from '../../src/auth/tokens';
import type {
  AuthorityCheck,
  AuthorityContext,
  AuthorityPolicy,
  PersonCookiePrincipal,
  PersonPrincipal,
  Principal,
} from '../../src/auth/types';
import { makeDb } from '../../src/data';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { BASE } from '../helpers/http';
import { type CapturedLogs, captureLogs } from '../helpers/logs';

const MINTED = 1_700_000_000_000;
const TEN_MINUTES = 10 * 60 * 1000;

/** The kit default policy, spelled out: the role decides, the app is not external. */
const ROLE_ONLY: AuthorityPolicy = { authorityFor: () => null, authorityIsExternal: () => false };

/** `hook` as an app's policy — an external authority by default, as a set-answering hook must be. */
function acl(hook: AuthorityCheck, external = true): AuthorityPolicy {
  return { authorityFor: hook, authorityIsExternal: () => external };
}

/** A policy whose hook answers `answer` and records what it was handed. */
function recording(
  answer: unknown,
  external = true,
): {
  policy: AuthorityPolicy;
  calls: { principal: Readonly<PersonPrincipal>; context: AuthorityContext }[];
} {
  const calls: { principal: Readonly<PersonPrincipal>; context: AuthorityContext }[] = [];
  return {
    calls,
    policy: acl((principal, context) => {
      calls.push({ principal, context });
      return answer as ReturnType<AuthorityCheck>;
    }, external),
  };
}

/**
 * What a run start stores, taken the way the start route takes it: a session minted for `email`,
 * presented as a cookie; the key from sessionKeyOf, the email and mint time from the principal
 * resolvePrincipal answers for the same request.
 */
async function startRun(
  email: string,
  mintedAt = MINTED,
): Promise<{ sid: string; run: RunAuthority }> {
  const sid = await createSession(env, email, 'magic_link', mintedAt);
  const req = new Request(`${BASE}/api/agent/runs`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${sid}` },
  });
  const principal = (await resolvePrincipal(req, env, ROLE_ONLY)) as PersonCookiePrincipal;
  const sessionKey = await sessionKeyOf(req);
  if (!principal || sessionKey === null || principal.sessionCreatedAtMs === undefined) {
    throw new Error('fixture: the start request did not resolve to a session principal');
  }
  return {
    sid,
    run: { email: principal.email, sessionKey, sessionCreatedAtMs: principal.sessionCreatedAtMs },
  };
}

let logs: CapturedLogs;
beforeAll(applySchema);
beforeEach(async () => {
  await seedDb();
  logs = captureLogs();
});
afterEach(() => logs.restore());

describe('a live session resolves', () => {
  it('to the session principal a browser request would get — role, transport, mint time', async () => {
    const { run } = await startRun(USERS.member);
    expect(run.sessionCreatedAtMs).toBe(MINTED);
    const p = await resolveRunPrincipal(env, run, ROLE_ONLY);
    expect(p).toEqual({
      kind: 'person',
      email: USERS.member,
      name: 'Alice Member',
      role: 'member',
      authMethod: 'magic_link',
      credentialTransport: 'cookie',
      sessionCreatedAtMs: MINTED,
    });
    expect(p && 'permissions' in p).toBe(false);
    expect(principalCan(p as Principal, 'agent.use')).toBe(true);
    expect(principalCan(p as Principal, 'agent.erase')).toBe(false); // owner only
  });

  it("through the fork's own policy by default (the kit ships the role-only hook)", async () => {
    const { run } = await startRun(USERS.owner);
    const p = await resolveRunPrincipal(env, run);
    expect(p).toMatchObject({ email: USERS.owner, role: 'owner', credentialTransport: 'cookie' });
  });

  it("keeps the session's auth method — an Entra session stays an Entra session", async () => {
    const sid = await createSession(env, USERS.admin, 'entra_oidc', MINTED);
    const run = {
      email: USERS.admin,
      sessionKey: await sha256Hex(sid),
      sessionCreatedAtMs: MINTED,
    };
    expect((await resolveRunPrincipal(env, run, ROLE_ONLY))?.authMethod).toBe('entra_oidc');
  });

  it('re-derives on every call: a role change lands on the next one, with no snapshot', async () => {
    const { run } = await startRun(USERS.member);
    expect((await resolveRunPrincipal(env, run, ROLE_ONLY))?.role).toBe('member');
    await makeDb(env).users.setRole(USERS.member, 'admin');
    const promoted = (await resolveRunPrincipal(env, run, ROLE_ONLY)) as Principal;
    expect(promoted.role).toBe('admin');
    expect(principalCan(promoted, 'users.manage')).toBe(true);
  });
});

// The turn exists to use the agent: a principal that no longer holds `agent.use` is no grant for
// one more model round or tool call, whatever else it may still do. The model rounds go straight
// to the provider (no route's permission check covers them), so this is the only place the key is
// re-checked mid-turn (PIA §1: the agent is the user at the time of each call, never more).
describe('losing agent.use ends the grant on the next call', () => {
  it('a demotion to viewer (the role holds neither agent.use nor ai.use)', async () => {
    const { run } = await startRun(USERS.member);
    expect(await resolveRunPrincipal(env, run, ROLE_ONLY)).not.toBeNull();
    await makeDb(env).users.setRole(USERS.member, 'viewer');
    expect(await resolveRunPrincipal(env, run, ROLE_ONLY)).toBeNull();
    // …and a viewer's own session never resolves to a run principal at all.
    const { run: viewerRun } = await startRun(USERS.viewer);
    expect(await resolveRunPrincipal(env, viewerRun, ROLE_ONLY)).toBeNull();
  });

  it('an authority hook whose decided set leaves agent.use out — from the start, or mid-turn', async () => {
    const { run } = await startRun(USERS.member);
    expect(
      await resolveRunPrincipal(
        env,
        run,
        acl(() => ({ permissions: ['notes.read', 'ai.use'] })),
      ),
    ).toBeNull();
    let set: PermissionKey[] = ['agent.use', 'notes.read'];
    const policy = acl(() => ({ permissions: set }));
    expect(await resolveRunPrincipal(env, run, policy)).not.toBeNull();
    set = ['notes.read'];
    expect(await resolveRunPrincipal(env, run, policy)).toBeNull();
  });
});

describe('every way the grant ends is null', () => {
  it('logout (the session is deleted)', async () => {
    const { sid, run } = await startRun(USERS.member);
    await destroySession(env, sid);
    expect(await resolveRunPrincipal(env, run, ROLE_ONLY)).toBeNull();
  });

  it('a force-logout at or after the mint — and a session minted later resolves for ITS key', async () => {
    const { run: old } = await startRun(USERS.member, MINTED);
    await revokeAllSessions(env, USERS.member, MINTED); // the same millisecond still kills it
    expect(await resolveRunPrincipal(env, old, ROLE_ONLY)).toBeNull();
    const { run: fresh } = await startRun(USERS.member, MINTED + 1);
    expect(fresh.sessionKey).not.toBe(old.sessionKey);
    expect(await resolveRunPrincipal(env, fresh, ROLE_ONLY)).toMatchObject({
      email: USERS.member,
      sessionCreatedAtMs: MINTED + 1,
    });
    // …and the later session never revives the earlier turn's grant.
    expect(await resolveRunPrincipal(env, old, ROLE_ONLY)).toBeNull();
  });

  it('a disabled user, immediately — and a removed one', async () => {
    const { run } = await startRun(USERS.member);
    await makeDb(env).users.setDisabled(USERS.member, true);
    expect(await resolveRunPrincipal(env, run, ROLE_ONLY)).toBeNull();
    const { run: viewerRun } = await startRun(USERS.viewer);
    await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(USERS.viewer).run();
    expect(await resolveRunPrincipal(env, viewerRun, ROLE_ONLY)).toBeNull();
  });

  it('an email that is not the session’s', async () => {
    const { run } = await startRun(USERS.member);
    expect(await resolveRunPrincipal(env, { ...run, email: USERS.owner }, ROLE_ONLY)).toBeNull();
    expect(
      await resolveRunPrincipal(env, { ...run, email: USERS.member.toUpperCase() }, ROLE_ONLY),
    ).toBeNull();
  });

  it('a mint time that is not the session’s', async () => {
    const { run } = await startRun(USERS.member);
    for (const sessionCreatedAtMs of [MINTED + 1, MINTED - 1, 0, Number.NaN, null, undefined]) {
      expect(
        await resolveRunPrincipal(
          env,
          { ...run, sessionCreatedAtMs: sessionCreatedAtMs as unknown as number },
          ROLE_ONLY,
        ),
        String(sessionCreatedAtMs),
      ).toBeNull();
    }
  });

  it('a stored session with no usable mint time can never match — not even a run that has none', async () => {
    const { run } = await startRun(USERS.member);
    const key = `session:${run.sessionKey}`;
    const stored = JSON.parse((await env.SESSIONS.get(key)) as string) as Record<string, unknown>;
    const untimed = Object.fromEntries(
      Object.entries(stored).filter(([k]) => k !== 'created_at_ms'),
    );
    // A string mint time, and none at all: mintedAtMs reads both as null.
    for (const session of [{ ...stored, created_at_ms: String(MINTED) }, untimed]) {
      await env.SESSIONS.put(key, JSON.stringify(session));
      // The run's own mint time comes from a nullable column (P2's turn store clears it when the
      // turn ends): a run that carries none must never "match" a session that has none — null is
      // not a mint time, so `null === null` is no proof of the same session.
      for (const sessionCreatedAtMs of [MINTED, null, undefined]) {
        expect(
          await resolveRunPrincipal(
            env,
            { ...run, sessionCreatedAtMs: sessionCreatedAtMs as unknown as number },
            ROLE_ONLY,
          ),
          `${JSON.stringify(session.created_at_ms)} vs ${String(sessionCreatedAtMs)}`,
        ).toBeNull();
      }
    }
  });

  it('a key that is not a session key: a raw sid, another case, garbage', async () => {
    const { sid, run } = await startRun(USERS.member);
    for (const sessionKey of [sid, run.sessionKey.toUpperCase(), '', 'session:x']) {
      expect(await resolveRunPrincipal(env, { ...run, sessionKey }, ROLE_ONLY)).toBeNull();
    }
  });

  it('a session held under a reserved (service) identifier — refused by the reserved rule itself', async () => {
    const sid = crypto.randomUUID();
    const sessionKey = await sha256Hex(sid);
    const email = 'svc-etl@test-app.invalid';
    // An ACTIVE owner row for the address, so nothing after the session read would stop it: such a
    // row can only be a hand insert (users.add refuses one) — a pre-upgrade or imported row — and
    // the run path must hold against it exactly as getSession does (service-namespace.test.ts).
    await env.DB.prepare(
      "INSERT INTO users (email, name, role, added_by) VALUES (?, 'x', 'owner', ?)",
    )
      .bind(email, USERS.owner)
      .run();
    await env.SESSIONS.put(
      `session:${sessionKey}`,
      JSON.stringify({ email, created_at_ms: MINTED, auth_method: 'magic_link' }),
    );
    const run = { email, sessionKey, sessionCreatedAtMs: MINTED };
    expect(await resolveRunPrincipal(env, run, ROLE_ONLY)).toBeNull();
    expect(logs.named('session_refused')).toEqual([
      { event: 'session_refused', level: 'warn', reason: 'service_identity' },
    ]);
  });
});

describe('the authority hook, with no request', () => {
  it('is handed request: null and the stored session — and its set applies', async () => {
    const { run } = await startRun(USERS.member);
    const { policy, calls } = recording({ permissions: ['agent.use', 'ai.use'] });
    const p = (await resolveRunPrincipal(env, run, policy)) as PersonCookiePrincipal;
    expect(calls).toHaveLength(1);
    const [{ principal, context }] = calls as [(typeof calls)[number]];
    expect(context.request).toBeNull();
    expect(context.env).toBe(env);
    expect(context.session).toEqual({
      email: USERS.member,
      created_at_ms: MINTED,
      auth_method: 'magic_link',
    });
    expect(context.user).toMatchObject({ email: USERS.member, role: 'member' });
    expect(Object.isFrozen(principal)).toBe(true);
    expect('permissions' in principal).toBe(false);
    expect(principal).toMatchObject({ credentialTransport: 'cookie', sessionCreatedAtMs: MINTED });
    // The set REPLACES the role, and the mint time survives the spread.
    expect(p.permissions).toEqual(new Set<PermissionKey>(['agent.use', 'ai.use']));
    expect(p.sessionCreatedAtMs).toBe(MINTED);
    expect(principalCan(p, 'ai.use')).toBe(true);
    expect(principalCan(p, 'tokens.self')).toBe(false); // the member role holds it; the set does not
  });

  it('is asked again on every call: a grant the authority withdraws lands on the next one', async () => {
    const { run } = await startRun(USERS.member);
    let granted = true;
    const policy = acl(() =>
      granted ? { permissions: ['agent.use'] } : { refuse: 'acl_revoked' },
    );
    expect(await resolveRunPrincipal(env, run, policy)).not.toBeNull();
    granted = false;
    expect(await resolveRunPrincipal(env, run, policy)).toBeNull();
    expect(logs.named('principal_authority_refused')).toEqual([
      {
        event: 'principal_authority_refused',
        level: 'warn',
        transport: 'cookie',
        reason: 'acl_revoked',
      },
    ]);
  });

  it('a hook that throws, or whose promise rejects, ends the grant — its message never logged', async () => {
    const { run } = await startRun(USERS.member);
    const throwing = acl(() => {
      throw new Error(`acl down for ${USERS.member}`);
    });
    const rejecting = acl(() => Promise.reject(new Error('upstream 503')));
    expect(await resolveRunPrincipal(env, run, throwing)).toBeNull();
    expect(await resolveRunPrincipal(env, run, rejecting)).toBeNull();
    expect(logs.named('principal_authority_hook_failed')).toHaveLength(2);
    logs.expectAbsent(USERS.member, 'acl down', 'upstream 503');
  });

  it('a hook that answers a set on an env the app does not declare external ends it', async () => {
    const { run } = await startRun(USERS.member);
    const { policy } = recording({ permissions: ['agent.use'] }, false);
    expect(await resolveRunPrincipal(env, run, policy)).toBeNull();
    expect(logs.named('principal_authority_invalid')[0]?.cause).toBe('undeclared_external');
  });
});

describe('authorityRefusesAgentRun ends the grant', () => {
  it('in an external-authority app, a session the hook left on the role', async () => {
    const { run } = await startRun(USERS.member);
    expect(
      await resolveRunPrincipal(
        env,
        run,
        acl(() => null, true),
      ),
    ).toBeNull();
    // The same session with a decided set runs.
    expect(
      await resolveRunPrincipal(
        env,
        run,
        acl(() => ({ permissions: ['agent.use'] }), true),
      ),
    ).not.toBeNull();
  });

  it('when the declaration throws or answers a non-boolean (read as external: fail closed)', async () => {
    const { run } = await startRun(USERS.member);
    const throwingDeclaration: AuthorityPolicy = {
      authorityFor: () => null,
      authorityIsExternal: () => {
        throw new Error('config unreadable');
      },
    };
    const vagueDeclaration = {
      authorityFor: () => null,
      authorityIsExternal: () => 'yes',
    } as unknown as AuthorityPolicy;
    expect(await resolveRunPrincipal(env, run, throwingDeclaration)).toBeNull();
    expect(await resolveRunPrincipal(env, run, vagueDeclaration)).toBeNull();
  });
});

describe('what a resolution leaves in the logs', () => {
  it('no email, session key, sid or mint time — whatever the outcome', async () => {
    const { sid, run } = await startRun(USERS.member);
    await resolveRunPrincipal(env, run, ROLE_ONLY);
    await resolveRunPrincipal(
      env,
      run,
      acl(() => ({ refuse: 'acl_revoked' })),
    );
    await resolveRunPrincipal(env, { ...run, sessionCreatedAtMs: MINTED + 1 }, ROLE_ONLY);
    await destroySession(env, sid);
    await resolveRunPrincipal(env, run, ROLE_ONLY);
    logs.expectAbsent(USERS.member, run.sessionKey, sid, String(MINTED));
  });
});

describe('recentlyAuthenticated — a cookie-only, fail-closed step-up', () => {
  const NOW = MINTED + TEN_MINUTES;
  const cookie = (sessionCreatedAtMs?: unknown): Principal =>
    ({
      kind: 'person',
      email: USERS.owner,
      name: null,
      role: 'owner',
      authMethod: 'magic_link',
      credentialTransport: 'cookie',
      ...(sessionCreatedAtMs === undefined ? {} : { sessionCreatedAtMs }),
    }) as Principal;

  it('true from the mint up to exactly maxAge later; false one millisecond after', () => {
    expect(recentlyAuthenticated(cookie(NOW), TEN_MINUTES, NOW)).toBe(true);
    expect(recentlyAuthenticated(cookie(MINTED), TEN_MINUTES, NOW)).toBe(true); // the boundary
    expect(recentlyAuthenticated(cookie(MINTED - 1), TEN_MINUTES, NOW)).toBe(false);
    expect(recentlyAuthenticated(cookie(MINTED), 0, MINTED)).toBe(true);
  });

  it('false without a usable mint time', () => {
    for (const bogus of [
      undefined,
      null,
      '1700000000000',
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(recentlyAuthenticated(cookie(bogus), TEN_MINUTES, NOW), String(bogus)).toBe(false);
    }
  });

  it('false for a mint time in the future — a session from tomorrow never passes', () => {
    expect(recentlyAuthenticated(cookie(NOW + 1), TEN_MINUTES, NOW)).toBe(false);
    expect(recentlyAuthenticated(cookie(NOW + 365 * 24 * 3600 * 1000), TEN_MINUTES, NOW)).toBe(
      false,
    );
    expect(recentlyAuthenticated(cookie(NOW + 1), Number.MAX_SAFE_INTEGER, NOW)).toBe(false);
  });

  it('false for any non-finite or negative window or clock', () => {
    for (const [max, now] of [
      [-1, NOW],
      [Number.NaN, NOW],
      [Number.POSITIVE_INFINITY, NOW],
      [TEN_MINUTES, Number.NaN],
      [TEN_MINUTES, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(recentlyAuthenticated(cookie(NOW), max, now), `${max} ${now}`).toBe(false);
    }
  });

  it('false for a bearer person, a service, and an unknown transport — whatever they carry', () => {
    const bearer = {
      ...cookie(NOW),
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      tokenScopes: null,
    } as unknown as Principal;
    const service = {
      kind: 'service',
      email: 'svc-etl@test-app.invalid',
      name: 'Synthetic ETL',
      role: null,
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      service: { id: 1, slug: 'etl', scope: 'ai.use', custodianEmail: USERS.member },
      sessionCreatedAtMs: NOW,
    } as unknown as Principal;
    const novel = { ...cookie(NOW), credentialTransport: 'mtls' } as unknown as Principal;
    for (const p of [bearer, service, novel]) {
      expect(recentlyAuthenticated(p, TEN_MINUTES, NOW)).toBe(false);
    }
  });

  it('end to end: a fresh sign-in passes, an eleven-minute-old session does not', async () => {
    const now = Date.now();
    const fresh = await createSession(env, USERS.owner, 'magic_link', now);
    const stale = await createSession(env, USERS.owner, 'magic_link', now - 11 * 60 * 1000);
    const principalFor = async (sid: string) =>
      (await resolvePrincipal(
        new Request(`${BASE}/api/me`, { headers: { cookie: `${SESSION_COOKIE}=${sid}` } }),
        env,
        ROLE_ONLY,
      )) as Principal;
    expect(recentlyAuthenticated(await principalFor(fresh), TEN_MINUTES, now)).toBe(true);
    expect(recentlyAuthenticated(await principalFor(stale), TEN_MINUTES, now)).toBe(false);
    // …and a run's principal carries the same mint time, so the step-up reads the same answer.
    const run = {
      email: USERS.owner,
      sessionKey: await sha256Hex(fresh),
      sessionCreatedAtMs: now,
    };
    const p = (await resolveRunPrincipal(env, run, ROLE_ONLY)) as Principal;
    expect(recentlyAuthenticated(p, TEN_MINUTES, now)).toBe(true);
  });
});
