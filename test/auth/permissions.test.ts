// THE PERMISSION MATRIX. The expectation table below is intentionally a hardcoded
// copy of src/auth/permissions.ts — changing the live map without consciously
// updating this test fails CI. That is the review gate working as designed.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ERASE_PERMISSION,
  AGENT_FORBIDDEN,
  AGENT_FORBIDDEN_REPOSITORIES,
  ALL_ROLES,
  can,
  canManageRole,
  effectivePermissions,
  grantableScopes,
  isAgentForbidden,
  isAgentForbiddenRepository,
  isAgentScope,
  isServiceGrantable,
  machineGateAdmits,
  NON_DELEGABLE,
  PERMISSIONS,
  type PermissionKey,
  principalCan,
  principalMayCall,
  scopeAllows,
  serviceGrantableScopes,
  serviceMayHold,
} from '../../src/auth/permissions';
import {
  mintApiToken,
  mintApiTokenFor,
  mintToken,
  resolveApiTokenByHash,
  sha256Hex,
} from '../../src/auth/tokens';
import type {
  CredentialTransport,
  PersonCookiePrincipal,
  Principal,
  Role,
  ServicePrincipal,
} from '../../src/auth/types';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { AppError } from '../../src/framework/errors';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

const EXPECTED: Record<PermissionKey, Record<Role, boolean>> = {
  'users.read': { owner: true, admin: true, member: false, viewer: false },
  'users.manage': { owner: true, admin: true, member: false, viewer: false },
  'audit.read': { owner: true, admin: true, member: false, viewer: false },
  // The read ledger records the ACTOR of every read, so it concentrates exactly the access
  // metadata it exists to protect. Admin-and-up, same as the audit log — a member who could page
  // it would learn which of their colleagues looked at what.
  'readLog.read': { owner: true, admin: true, member: false, viewer: false },
  'settings.manage': { owner: true, admin: true, member: false, viewer: false },
  'meta.read': { owner: true, admin: true, member: false, viewer: false },
  'tokens.self': { owner: true, admin: true, member: true, viewer: false },
  // Bringing a machine principal into being and handing it a credential: admin-and-up, the same
  // tier as inviting a person.
  'serviceIdentities.manage': { owner: true, admin: true, member: false, viewer: false },
  'ai.use': { owner: true, admin: true, member: true, viewer: false },
  // The in-app agent (P2): a viewer cannot run it (it acts, and a viewer acts on nothing)…
  'agent.use': { owner: true, admin: true, member: true, viewer: false },
  // …and only an owner may find, export or erase other people's transcripts (the DSR route).
  'agent.erase': { owner: true, admin: false, member: false, viewer: false },
  'notes.read': { owner: true, admin: true, member: true, viewer: true },
  'notes.write': { owner: true, admin: true, member: true, viewer: false },
};

// THE DELEGATION MATRIX (PIA C8), hardcoded for the same reason as the one above: whether a bearer
// token may EVER hold a key is a security decision, so moving a key in or out of NON_DELEGABLE
// without consciously editing this list fails CI. `true` = never held by a bearer credential.
const NON_DELEGABLE_EXPECTED: Record<PermissionKey, boolean> = {
  'users.read': false,
  'users.manage': true,
  'audit.read': true,
  'readLog.read': true,
  'settings.manage': true,
  // No bearer consumer exists (the registry receives the manifest by push) — DECISIONS 2026-09-23.
  'meta.read': true,
  // A token that can mint tokens outlives its own revocation.
  'tokens.self': true,
  // …and one that could create a service identity would mint a year-long successor under a name
  // nobody reads as a person.
  'serviceIdentities.manage': true,
  'ai.use': false,
  // A run's grant is the session that started it, re-read per call; a token has none to re-read,
  // so no bearer or MCP client starts a run (PIA C8, C15) — and none reads or erases transcripts.
  'agent.use': true,
  'agent.erase': true,
  'notes.read': false,
  'notes.write': false,
};

// THE SERVICE MATRIX, hardcoded for the same reason: which keys a SERVICE identity may be created
// with is a security decision. `true` = a service identity may hold this key as its one scope.
// It is exactly the delegable set minus the reserved agent family — pinned here so a key moving
// in or out is a conscious edit, not a side effect.
const SERVICE_GRANTABLE_EXPECTED: Record<PermissionKey, boolean> = {
  'users.read': true,
  'users.manage': false,
  'audit.read': false,
  'readLog.read': false,
  'settings.manage': false,
  'meta.read': false,
  'tokens.self': false,
  'serviceIdentities.manage': false,
  'ai.use': true,
  'agent.use': false,
  'agent.erase': false,
  'notes.read': true,
  'notes.write': true,
};

// THE AGENT MATRIX, hardcoded for the same reason as the two above: whether a route gated by a key
// may EVER be handed to the in-app agent is a security decision (src/auth/permissions.ts,
// AGENT_FORBIDDEN), so moving a key in or out without consciously editing this list fails CI.
// `true` = no route with this key can carry an `agent:` block (defineRoute throws at load).
const AGENT_FORBIDDEN_EXPECTED: Record<PermissionKey, boolean> = {
  'users.read': false,
  'users.manage': true,
  'audit.read': true,
  'readLog.read': true,
  'settings.manage': true,
  'meta.read': true,
  'tokens.self': true,
  'serviceIdentities.manage': true,
  'ai.use': false,
  // A model that could start runs would be a loop no person began.
  'agent.use': true,
  'agent.erase': true,
  'notes.read': false,
  'notes.write': false,
};

describe('permission matrix', () => {
  it('covers every permission key (no key escapes the matrix)', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  for (const permission of Object.keys(EXPECTED) as PermissionKey[]) {
    for (const role of ALL_ROLES) {
      it(`${role} ${EXPECTED[permission][role] ? 'CAN' : 'can NOT'} ${permission}`, () => {
        expect(can(role, permission)).toBe(EXPECTED[permission][role]);
      });
    }
  }

  it('covers every permission key in the delegation matrix too', () => {
    expect(Object.keys(NON_DELEGABLE_EXPECTED).sort()).toEqual(Object.keys(PERMISSIONS).sort());
    // …and NON_DELEGABLE names nothing that is not a permission (a typo would guard nothing).
    for (const key of NON_DELEGABLE) expect(Object.keys(PERMISSIONS)).toContain(key);
  });

  for (const permission of Object.keys(NON_DELEGABLE_EXPECTED) as PermissionKey[]) {
    it(`${permission} is ${NON_DELEGABLE_EXPECTED[permission] ? 'NON-DELEGABLE' : 'delegable'}`, () => {
      expect(NON_DELEGABLE.has(permission)).toBe(NON_DELEGABLE_EXPECTED[permission]);
    });
  }

  it('covers every permission key in the service matrix too', () => {
    expect(Object.keys(SERVICE_GRANTABLE_EXPECTED).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  for (const permission of Object.keys(SERVICE_GRANTABLE_EXPECTED) as PermissionKey[]) {
    it(`${permission} ${SERVICE_GRANTABLE_EXPECTED[permission] ? 'MAY' : 'may NOT'} be a service identity's scope`, () => {
      expect(isServiceGrantable(permission)).toBe(SERVICE_GRANTABLE_EXPECTED[permission]);
      expect(serviceGrantableScopes().includes(permission)).toBe(
        SERVICE_GRANTABLE_EXPECTED[permission],
      );
    });
  }

  it('role hierarchy: owners manage everyone, admins manage members/viewers only', () => {
    expect(canManageRole('owner', 'owner')).toBe(true);
    expect(canManageRole('owner', 'admin')).toBe(true);
    expect(canManageRole('admin', 'owner')).toBe(false);
    expect(canManageRole('admin', 'admin')).toBe(false);
    expect(canManageRole('admin', 'member')).toBe(true);
    expect(canManageRole('admin', 'viewer')).toBe(true);
    expect(canManageRole('member', 'viewer')).toBe(false);
    expect(canManageRole('viewer', 'viewer')).toBe(false);
  });
});

// A session, or a bearer principal with the given stored scopes. `who(role, 'bearer')` with no
// scopes builds what the type forbids — a bearer principal WITHOUT them — through a cast, to pin
// what principalCan() does with one that arrives anyway (plain JavaScript, a hand cast).
function who(
  role: Role,
  credentialTransport: CredentialTransport,
  tokenScopes?: readonly string[] | null,
): Principal {
  const identity = { kind: 'person' as const, email: USERS[role], name: null, role };
  if (credentialTransport === 'cookie') {
    return { ...identity, authMethod: 'magic_link', credentialTransport };
  }
  if (tokenScopes === undefined) {
    return { ...identity, authMethod: 'api_token', credentialTransport } as unknown as Principal;
  }
  return { ...identity, authMethod: 'api_token', credentialTransport, tokenScopes };
}

describe('principalCan — the bearer narrowing (PIA C8)', () => {
  it('a session holds exactly its role (can() is unchanged for cookies)', () => {
    for (const role of ALL_ROLES) {
      for (const key of Object.keys(PERMISSIONS) as PermissionKey[]) {
        expect(principalCan(who(role, 'cookie'), key)).toBe(can(role, key));
      }
    }
  });

  it('a legacy (NULL-scope) token holds its role minus the non-delegable set', () => {
    for (const role of ALL_ROLES) {
      for (const key of Object.keys(PERMISSIONS) as PermissionKey[]) {
        const expected = can(role, key) && !NON_DELEGABLE_EXPECTED[key];
        expect(principalCan(who(role, 'bearer', null), key)).toBe(expected);
      }
    }
  });

  // Legacy is the WIDEST a token can be, so it must be asked for: only an explicit null means it.
  // A bearer principal that arrives without its token's stored scopes — a fork resolver that
  // forgot to carry them, a hand-cast Principal — would otherwise widen every scoped token to its
  // owner's whole role minus the non-delegable set.
  it('a bearer principal WITHOUT stored scopes holds nothing — absent is not legacy (fail closed)', () => {
    for (const role of ALL_ROLES) {
      const absent = who(role, 'bearer');
      expect('tokenScopes' in absent).toBe(false);
      for (const key of Object.keys(PERMISSIONS) as PermissionKey[]) {
        expect(principalCan(absent, key)).toBe(false);
      }
      expect(effectivePermissions(absent)).toEqual([]);
      // The same for an explicit undefined, and for a value that is not an array — a raw string
      // would otherwise pass String.prototype.includes.
      for (const bogus of [undefined, 'notes.read', { 0: 'notes.read' }]) {
        const p = { ...absent, tokenScopes: bogus } as unknown as Principal;
        expect(principalCan(p, 'notes.read')).toBe(false);
      }
    }
    expect(scopeAllows(undefined, 'notes.read')).toBe(false);
  });

  // The compile-time half, checked by `npm run typecheck` (test/tsconfig.json): each expect-error
  // directive below is itself an error the day the statement under it compiles. So loosening
  // Principal back to an optional `tokenScopes` fails CI here, before a fork resolver can build a
  // bearer principal that forgot its token's scopes.
  it('the Principal type REQUIRES tokenScopes on a bearer principal, and forbids it on a session', () => {
    const identity = { kind: 'person', email: USERS.member, name: null, role: 'member' } as const;
    // @ts-expect-error — a bearer Principal without its token's stored scopes does not compile.
    const forgot: Principal = {
      ...identity,
      authMethod: 'api_token',
      credentialTransport: 'bearer',
    };
    const legacy: Principal = {
      ...identity,
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      tokenScopes: null,
    };
    const scoped: Principal = {
      ...identity,
      authMethod: 'api_token',
      credentialTransport: 'bearer',
      tokenScopes: ['notes.read'],
    };
    const cookie: Principal = {
      ...identity,
      authMethod: 'magic_link',
      credentialTransport: 'cookie',
    };
    // @ts-expect-error — a session never carries a token ceiling.
    const confused: Principal = {
      ...identity,
      authMethod: 'magic_link',
      credentialTransport: 'cookie',
      tokenScopes: ['notes.read'],
    };
    // What each means at runtime (the forgotten one holds nothing — see the test above).
    expect(principalCan(forgot, 'notes.read')).toBe(false);
    expect(principalCan(legacy, 'notes.write')).toBe(true);
    expect(principalCan(scoped, 'notes.write')).toBe(false);
    expect(principalCan(cookie, 'tokens.self')).toBe(true);
    expect(principalCan(confused, 'notes.write')).toBe(true); // a cookie ignores it anyway
  });

  // The same compile-time pin for the SERVICE side of the union: a service principal is only ever
  // a bearer, and its ceiling is `service.scope`, never a token's stored scopes.
  it('the Principal type keeps a SERVICE principal on a bearer transport, with no tokenScopes', () => {
    const identity = {
      kind: 'service',
      email: 'svc-etl@test-app.invalid',
      name: 'Synthetic ETL',
      role: null,
      authMethod: 'api_token',
      service: { id: 1, slug: 'etl', scope: 'notes.read', custodianEmail: USERS.member },
    } as const;
    const bearer: Principal = { ...identity, credentialTransport: 'bearer' };
    // @ts-expect-error — no resolver produces a service principal from a cookie.
    const cookie: Principal = { ...identity, credentialTransport: 'cookie' };
    // @ts-expect-error — a service's ceiling is its one scope, not a token's stored scopes.
    const scoped: Principal = { ...identity, credentialTransport: 'bearer', tokenScopes: null };
    expect(principalCan(bearer, 'notes.read')).toBe(true);
    expect(principalCan(cookie, 'notes.read')).toBe(false); // and principalCan refuses it anyway
    expect(principalCan(scoped, 'notes.read')).toBe(true); // the stray field adds nothing
    expect(principalCan(scoped, 'notes.write')).toBe(false);
  });

  it('explicit scopes are a CEILING: never wider than the role, never a non-delegable key', () => {
    const everything = Object.keys(PERMISSIONS);
    for (const role of ALL_ROLES) {
      for (const key of Object.keys(PERMISSIONS) as PermissionKey[]) {
        // A token that "claims" every key still holds only role ∩ delegable.
        expect(principalCan(who(role, 'bearer', everything), key)).toBe(
          can(role, key) && !NON_DELEGABLE_EXPECTED[key],
        );
      }
    }
    const reader = who('owner', 'bearer', ['notes.read']);
    expect(principalCan(reader, 'notes.read')).toBe(true);
    expect(principalCan(reader, 'notes.write')).toBe(false); // the owner could; the token can't
    expect(principalCan(who('owner', 'bearer', []), 'notes.read')).toBe(false); // [] = nothing
    // The live role still narrows: a viewer's token scoped to notes.write cannot write.
    expect(principalCan(who('viewer', 'bearer', ['notes.write']), 'notes.write')).toBe(false);
  });

  it('fails closed on an unknown transport: only an exact cookie is undelegated', () => {
    // Treated as a bearer: it holds what its scopes allow — here an explicit legacy null…
    const novel = {
      ...who('owner', 'bearer', null),
      credentialTransport: 'mtls',
    } as unknown as Principal;
    expect(principalCan(novel, 'tokens.self')).toBe(false);
    expect(principalCan(novel, 'notes.read')).toBe(true); // legacy semantics, not a lockout
    // …and nothing at all when, like any session, it carries no scopes.
    const bare = {
      ...who('owner', 'cookie'),
      credentialTransport: 'mtls',
    } as unknown as Principal;
    expect(principalCan(bare, 'notes.read')).toBe(false);
    const absent = {
      ...who('owner', 'cookie'),
      credentialTransport: undefined,
    } as unknown as Principal;
    expect(principalCan(absent, 'users.manage')).toBe(false);
    expect(principalCan(absent, 'notes.read')).toBe(false);
  });

  it('effectivePermissions lists exactly what principalCan allows', () => {
    const p = who('admin', 'bearer', null);
    expect(effectivePermissions(p)).toEqual(
      (Object.keys(PERMISSIONS) as PermissionKey[]).filter((k) => principalCan(p, k)),
    );
    expect(effectivePermissions(p)).not.toContain('tokens.self');
    expect(effectivePermissions(who('admin', 'cookie'))).toContain('tokens.self');
  });

  it('grantableScopes is the role minus the non-delegable set', () => {
    for (const role of ALL_ROLES) {
      expect(grantableScopes(role).sort()).toEqual(
        (Object.keys(PERMISSIONS) as PermissionKey[])
          .filter((k) => can(role, k) && !NON_DELEGABLE_EXPECTED[k])
          .sort(),
      );
    }
  });
});

function service(scope: string, credentialTransport: CredentialTransport = 'bearer'): Principal {
  return {
    kind: 'service',
    email: 'svc-etl@test-app.invalid',
    name: 'Synthetic ETL',
    role: null,
    authMethod: 'api_token',
    credentialTransport,
    service: { id: 7, slug: 'etl', scope, custodianEmail: USERS.member },
  } as ServicePrincipal;
}

describe('principalCan — a SERVICE principal holds exactly its one scope', () => {
  const KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

  it('a service scoped to K holds K and nothing else, whatever roles hold what', () => {
    for (const scope of serviceGrantableScopes()) {
      for (const key of KEYS) {
        expect(principalCan(service(scope), key)).toBe(key === scope);
      }
      expect(effectivePermissions(service(scope))).toEqual([scope]);
    }
  });

  it('a non-delegable, agent-family or unknown scope holds nothing — re-checked per request', () => {
    for (const scope of [...NON_DELEGABLE, 'agent.run', 'agents.read', 'no.such.key', '']) {
      for (const key of KEYS) expect(principalCan(service(scope), key)).toBe(false);
      expect(effectivePermissions(service(scope))).toEqual([]);
    }
  });

  it('has no role: can(null) and canManageRole(null) are false for every key and target', () => {
    for (const key of KEYS) expect(can(null, key)).toBe(false);
    for (const target of ALL_ROLES) expect(canManageRole(null, target)).toBe(false);
  });

  it('only a bearer service principal is recognised — one claiming a cookie holds nothing', () => {
    expect(principalCan(service('notes.read', 'cookie'), 'notes.read')).toBe(false);
    const novel = { ...service('notes.read'), credentialTransport: 'mtls' } as unknown as Principal;
    expect(principalCan(novel, 'notes.read')).toBe(false);
  });

  it("never reaches an 'authenticated' route; a person of any kind of credential does", () => {
    expect(principalMayCall(service('notes.read'), 'authenticated')).toBe(false);
    expect(principalMayCall(service('notes.read'), 'notes.read')).toBe(true);
    expect(principalMayCall(service('notes.read'), 'notes.write')).toBe(false);
    for (const role of ALL_ROLES) {
      expect(principalMayCall(who(role, 'cookie'), 'authenticated')).toBe(true);
      expect(principalMayCall(who(role, 'bearer', []), 'authenticated')).toBe(true);
    }
  });

  it('a MACHINE route admits only a service — and that service still needs its key (B9)', () => {
    const KEYS_ = Object.keys(PERMISSIONS) as PermissionKey[];
    for (const key of KEYS_) {
      // No person reaches a machine route: any role, session or token, any scopes.
      for (const role of ALL_ROLES) {
        expect(principalMayCall(who(role, 'cookie'), key, { machine: true })).toBe(false);
        expect(principalMayCall(who(role, 'bearer'), key, { machine: true })).toBe(false);
        expect(principalMayCall(who(role, 'bearer', [key]), key, { machine: true })).toBe(false);
      }
      // A service: exactly what principalCan says — the flag adds nothing to it.
      for (const scope of serviceGrantableScopes()) {
        expect(principalMayCall(service(scope), key, { machine: true })).toBe(
          principalCan(service(scope), key),
        );
      }
    }
    // A principal with no kind, or an unknown one, is refused (fail closed).
    for (const kind of [undefined, 'robot']) {
      const p = { ...service('notes.read'), kind } as unknown as Principal;
      expect(principalMayCall(p, 'notes.read', { machine: true })).toBe(false);
    }
    // Off the machine path the answer is unchanged, flag absent or false.
    expect(principalMayCall(who('owner', 'cookie'), 'notes.read', { machine: false })).toBe(true);
    expect(principalMayCall(who('owner', 'cookie'), 'notes.read')).toBe(true);
  });

  it('the machine gate BY ITSELF admits only an exact kind "service" — every other kind fails closed (B9-R1)', () => {
    // principalMayCall cannot show this on its own: principalCan already refuses a principal of
    // no or an unknown kind, so the case above would stay green if the gate were rewritten as
    // "refuse persons". The gate must not lean on principalCan staying strict — a third kind that
    // principalCan one day admits (an agent acting for a person, say) must still be kept off
    // every machine route. So the gate is pinned here, alone.
    for (const kind of [undefined, null, '', 'robot', 'agent', 'person', 'Service', 'service ']) {
      const p = { ...service('notes.read'), kind } as unknown as Principal;
      expect(machineGateAdmits(p), `kind ${JSON.stringify(kind)}`).toBe(false);
    }
    for (const role of ALL_ROLES) {
      expect(machineGateAdmits(who(role, 'cookie'))).toBe(false);
      expect(machineGateAdmits(who(role, 'bearer', ['notes.read']))).toBe(false);
    }
    expect(machineGateAdmits(service('notes.read'))).toBe(true);
    // The gate is about KIND only; the key and the transport stay principalCan's question.
    expect(machineGateAdmits(service('notes.read', 'cookie'))).toBe(true);
    expect(principalMayCall(service('notes.read', 'cookie'), 'notes.read', { machine: true })).toBe(
      false,
    );
  });

  it('a principal with no kind, or an unknown one, holds nothing (fail closed)', () => {
    for (const kind of [undefined, 'robot']) {
      const p = { ...who('owner', 'cookie'), kind } as unknown as Principal;
      for (const key of KEYS) expect(principalCan(p, key)).toBe(false);
    }
  });
});

// The prefix rule over plain strings, so it holds for any agent key — the two that exist and any a
// later PIA addendum adds: a legacy token is unable to use one.
describe('the reserved agent scope family', () => {
  it('recognises every spelling of the prefix', () => {
    for (const key of ['agent', 'agent.run', 'agent:run', 'agent_run', 'agents.read']) {
      expect(isAgentScope(key)).toBe(true);
    }
    for (const key of ['ai.use', 'notes.read', 'reagent.read', 'management']) {
      expect(isAgentScope(key)).toBe(false);
    }
  });

  it('a NULL-scope (legacy) token never carries an agent permission', () => {
    expect(scopeAllows(null, 'agent.run')).toBe(false);
    expect(scopeAllows(undefined, 'agent:tools')).toBe(false);
    expect(scopeAllows(null, 'notes.read')).toBe(true);
  });

  it('an explicit scope list may carry one — asked for by name, still under the role', () => {
    expect(scopeAllows(['agent.run'], 'agent.run')).toBe(true);
    expect(scopeAllows(['notes.read'], 'agent.run')).toBe(false);
  });

  it('no explicit scope list can carry a non-delegable key', () => {
    for (const key of NON_DELEGABLE) expect(scopeAllows([key], key)).toBe(false);
  });

  // isServiceGrantable also requires a REAL key; the two real agent keys are non-delegable too, so
  // over PERMISSIONS alone the agent clause is still untestable (NON_DELEGABLE already says no).
  // Pin it over a key set with DELEGABLE agent keys: should one ever land, a service still can
  // never hold it.
  it('a SERVICE identity can never hold an agent key, even a delegable one', () => {
    const withAgentKeys = (key: string) =>
      Object.hasOwn(PERMISSIONS, key) || ['agent.run', 'agent:tools', 'agents.read'].includes(key);
    for (const key of ['agent.run', 'agent:tools', 'agents.read']) {
      expect(serviceMayHold(key, withAgentKeys), key).toBe(false);
    }
    for (const key of NON_DELEGABLE) expect(serviceMayHold(key, withAgentKeys), key).toBe(false);
    expect(serviceMayHold('notes.read', withAgentKeys)).toBe(true);
    expect(serviceMayHold('no.such.key', withAgentKeys)).toBe(false);
    // isServiceGrantable is exactly this rule over the real key set.
    for (const key of [...Object.keys(PERMISSIONS), 'agent.run', 'no.such.key']) {
      expect(isServiceGrantable(key), key).toBe(
        serviceMayHold(key, (k) => Object.hasOwn(PERMISSIONS, k)),
      );
    }
    for (const key of ['agent.use', 'agent.erase'])
      expect(isServiceGrantable(key), key).toBe(false);
  });

  it('every real agent key is in the family — the prefix rule covers it as a second wall', () => {
    const agentKeys = Object.keys(PERMISSIONS).filter(isAgentScope).sort();
    expect(agentKeys).toEqual(['agent.erase', 'agent.use']);
    for (const key of agentKeys) {
      expect(scopeAllows(null, key), key).toBe(false);
      expect(NON_DELEGABLE.has(key), key).toBe(true);
    }
  });
});

describe('AGENT_FORBIDDEN — the keys whose routes are never agent tools', () => {
  it('covers every permission key in the agent matrix too', () => {
    expect(Object.keys(AGENT_FORBIDDEN_EXPECTED).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  for (const permission of Object.keys(AGENT_FORBIDDEN_EXPECTED) as PermissionKey[]) {
    it(`${permission} is ${AGENT_FORBIDDEN_EXPECTED[permission] ? 'AGENT-FORBIDDEN' : 'exposable'}`, () => {
      expect(AGENT_FORBIDDEN.has(permission)).toBe(AGENT_FORBIDDEN_EXPECTED[permission]);
      expect(isAgentForbidden(permission)).toBe(AGENT_FORBIDDEN_EXPECTED[permission]);
    });
  }

  // agent.erase was reserved here before its key existed (P1); it is a real key now (P2), and the
  // set names nothing outside PERMISSIONS — a typo would guard nothing.
  it('agent.erase is a real key now, still forbidden — and nothing outside PERMISSIONS is named', () => {
    expect(AGENT_ERASE_PERMISSION).toBe('agent.erase');
    expect(Object.hasOwn(PERMISSIONS, AGENT_ERASE_PERMISSION)).toBe(true);
    expect(AGENT_FORBIDDEN.has(AGENT_ERASE_PERMISSION)).toBe(true);
    const beyondKeys = [...AGENT_FORBIDDEN].filter((k) => !Object.hasOwn(PERMISSIONS, k));
    expect(beyondKeys).toEqual([]);
  });

  // The ONE-WAY relation the doc comment states: a key too dangerous for a bearer credential is too
  // dangerous for a model. The reverse is deliberately not required (agent.erase says nothing
  // about tokens), which is why the sets are kept apart rather than derived from each other.
  it('NON_DELEGABLE ⊆ AGENT_FORBIDDEN', () => {
    for (const key of NON_DELEGABLE) expect(AGENT_FORBIDDEN.has(key), key).toBe(true);
  });

  it("an 'authenticated' route is never exposable — it skips the key check scopes narrow", () => {
    expect(isAgentForbidden('authenticated')).toBe(true);
  });
});

// WHAT AN EXPOSED ROUTE MAY REACH, hardcoded like the matrices above. AGENT_FORBIDDEN refuses a
// route by its label; this refuses it by the repositories in its `needs`, so an exposable key
// cannot be used to hand the model a forbidden key's data. Each forbidden key that has data maps to
// the repositories holding it; the set must be exactly their union (plus magicLinks and aiBudget,
// which no key guards: live login links, and the budget that brakes the agent itself).
const FORBIDDEN_KEY_DATA: Partial<Record<PermissionKey, readonly string[]>> = {
  'audit.read': ['audit', 'activity'],
  'readLog.read': ['readLog', 'activity'],
  'tokens.self': ['tokens'],
  'serviceIdentities.manage': ['serviceIdentities', 'tokens'],
  'settings.manage': ['settings'],
  'meta.read': ['meta'],
  // users.manage: its data is the `users` repository, which the exposable users.read shares — the
  // label check (AGENT_FORBIDDEN) is what keeps role changes off the agent.
  'users.manage': [],
  // The agent keys' data is the transcript store (migration 0006, P2-1), by the `needs` of the
  // routes each key gates (docs/agent-loop-P2-DESIGN.md §13): the run, approval and feedback routes
  // (`agent.use`) reach `agent`; the DSR route (`agent.erase`) reaches `agent` and `agentErasure`.
  // No tool can read transcripts (no memory).
  'agent.use': ['agent'],
  'agent.erase': ['agent', 'agentErasure'],
};
const UNGUARDED_FORBIDDEN_REPOSITORIES = ['magicLinks', 'aiBudget'];

describe('AGENT_FORBIDDEN_REPOSITORIES — the data no agent tool may reach', () => {
  it('maps every forbidden key that exists, and nothing else', () => {
    const existing = [...AGENT_FORBIDDEN].filter((k) => Object.hasOwn(PERMISSIONS, k)).sort();
    expect(Object.keys(FORBIDDEN_KEY_DATA).sort()).toEqual(existing);
  });

  it("is exactly the forbidden keys' repositories, plus the unguarded credentials and brakes", () => {
    const expected = new Set([
      ...Object.values(FORBIDDEN_KEY_DATA).flat(),
      ...UNGUARDED_FORBIDDEN_REPOSITORIES,
    ]);
    expect([...AGENT_FORBIDDEN_REPOSITORIES].sort()).toEqual([...expected].sort());
    for (const repo of expected) expect(isAgentForbiddenRepository(repo), repo).toBe(true);
    for (const repo of ['users', 'groups', 'notes', 'companies']) {
      expect(isAgentForbiddenRepository(repo), repo).toBe(false);
    }
  });

  it('names only real repositories — a typo would forbid nothing', () => {
    const repos = Object.keys(makeDb(env as Env));
    for (const repo of AGENT_FORBIDDEN_REPOSITORIES) expect(repos, repo).toContain(repo);
  });

  // The agent's own store is guarded by the agent keys, never by nothing: every repository named
  // with the agent prefix — in the Db, or in the forbidden set — must be forbidden AND mapped under
  // `agent.use` or `agent.erase`, not parked among the unguarded ones, so the map can never
  // describe the transcripts as guarded by no key. A new agent-prefixed repository fails here until
  // the mapping above names it.
  it('agent-prefixed repositories are forbidden and mapped under an agent key', () => {
    const agentData = new Set([
      ...(FORBIDDEN_KEY_DATA['agent.use'] ?? []),
      ...(FORBIDDEN_KEY_DATA['agent.erase'] ?? []),
    ]);
    const agentRepos = new Set(
      [...Object.keys(makeDb(env as Env)), ...AGENT_FORBIDDEN_REPOSITORIES].filter(isAgentScope),
    );
    // Not vacuous: the transcript store's two repositories are in the Db (P2-1).
    expect([...agentRepos]).toEqual(expect.arrayContaining(['agent', 'agentErasure']));
    for (const repo of agentRepos) {
      expect(isAgentForbiddenRepository(repo), repo).toBe(true);
      expect(agentData.has(repo), `${repo} is mapped under agent.use or agent.erase`).toBe(true);
      expect(UNGUARDED_FORBIDDEN_REPOSITORIES, repo).not.toContain(repo);
    }
    for (const repo of agentData) expect(isAgentScope(repo), repo).toBe(true);
  });
});

// THE AGENT KEYS AT THE CREDENTIAL BOUNDARY (PIA C8). The matrices above say both are
// non-delegable; these drive the real mint and resolve paths, so a token can neither be MINTED with
// one — asked for by name — nor HOLD one — a legacy NULL ceiling, or scopes written straight to the
// table naming them.
describe('the agent keys never reach a bearer credential (PIA C8)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const AGENT_KEYS = ['agent.use', 'agent.erase'] as const;
  const ownerSession: PersonCookiePrincipal = {
    kind: 'person',
    email: USERS.owner,
    name: null,
    role: 'owner',
    authMethod: 'magic_link',
    credentialTransport: 'cookie',
  };

  async function tokenCount(): Promise<number> {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens').first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** A token row written straight to the table — the mint path would 400 these scopes. */
  async function directToken(scopes: string | null): Promise<string> {
    const plaintext = mintToken();
    await env.DB.prepare(
      "INSERT INTO api_tokens (email, name, token_hash, prefix, expires_at, scopes) VALUES (?, 'direct', ?, ?, datetime('now', '+1 day'), ?)",
    )
      .bind(USERS.owner, await sha256Hex(plaintext), plaintext.slice(0, 10), scopes)
      .run();
    return plaintext;
  }

  it('a token minted asking for an agent key by name is refused (400), and nothing is minted', async () => {
    const db = makeDb(env as Env);
    for (const key of AGENT_KEYS) {
      for (const scopes of [[key], ['ai.use', key]]) {
        const err = await mintApiToken(db, ownerSession, { name: 'agent', scopes }).catch(
          (e: unknown) => e,
        );
        expect(err, key).toBeInstanceOf(AppError);
        expect((err as AppError).status).toBe(400);
        expect((err as AppError).message).toContain(key);
      }
      // …and the admin-issued path, for another person's account, the same way.
      const issued = await mintApiTokenFor(db, ownerSession, USERS.admin, {
        name: 'agent',
        scopes: [key],
      }).catch((e: unknown) => e);
      expect((issued as AppError).status, key).toBe(400);
    }
    expect(await tokenCount()).toBe(0);
  });

  it("the default scope snapshot leaves them out, though the owner's role holds both", async () => {
    const { row } = await mintApiToken(makeDb(env as Env), ownerSession, { name: 'snapshot' });
    const scopes = JSON.parse(row.scopes ?? 'null') as string[];
    for (const key of AGENT_KEYS) {
      expect(can('owner', key)).toBe(true);
      expect(scopes).not.toContain(key);
    }
    expect(scopes).toContain('ai.use');
  });

  it('a bearer never holds one: not on a legacy NULL ceiling, not when stored scopes name them', async () => {
    for (const stored of [null, JSON.stringify([...AGENT_KEYS, 'ai.use'])]) {
      const token = await directToken(stored);
      const p = await resolveApiTokenByHash(env as Env, await sha256Hex(token));
      expect(p, String(stored)).not.toBeNull();
      for (const key of AGENT_KEYS) expect(principalCan(p as Principal, key), key).toBe(false);
      expect(principalCan(p as Principal, 'ai.use')).toBe(true); // the token works otherwise
      const me = await SELF.fetch(`${BASE}/api/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await me.json()) as { data: { permissions: string[] } };
      for (const key of AGENT_KEYS) expect(body.data.permissions).not.toContain(key);
    }
    // The owner's SESSION holds both.
    const session = (await (await asUser(USERS.owner, 'GET', '/api/me')).json()) as {
      data: { permissions: string[] };
    };
    for (const key of AGENT_KEYS) expect(session.data.permissions).toContain(key);
  });
});

describe('permission enforcement at the API boundary', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('anonymous requests are 401 (fail-closed)', async () => {
    const res = await asUser(null, 'GET', '/api/notes');
    expect(res.status).toBe(401);
  });

  it('denied permission renders as 404, not 403 (uniformity)', async () => {
    const res = await asUser(USERS.viewer, 'GET', '/api/users');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('member can write notes; viewer cannot', async () => {
    const ok = await asUser(USERS.member, 'POST', '/api/notes', { title: 'hello' });
    expect(ok.status).toBe(201);
    const denied = await asUser(USERS.viewer, 'POST', '/api/notes', { title: 'nope' });
    expect(denied.status).toBe(404);
  });

  it('admin can list users', async () => {
    const res = await asUser(USERS.admin, 'GET', '/api/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { users: unknown[] } };
    expect(body.data.users.length).toBe(4);
  });
});
