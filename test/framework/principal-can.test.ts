// THE AUTHORITY SEAM, as principalCan sees it. A person's permissions come from their role — or,
// in an app whose authority hook decided them for this request (an ACL grant), from an
// AUTHORITATIVE set that replaces the role. Six properties are pinned here, each for a reason:
//
//   1. ROLE-ONLY APPS ARE UNCHANGED. With no `permissions` field, every role × key × credential
//      answers exactly what the pre-seam rule did. Every kit app and every fork without a hook
//      takes this arm on every request, so this is the "dry run shows no change" property as a
//      test. (test/auth/permissions.test.ts is the hardcoded matrix; it is not edited.)
//   2. THE SET REPLACES THE ROLE — both ways: a key the role grants but the set lacks is denied, a
//      key the set holds is held whatever the role says.
//   3. A BEARER STILL NARROWS IT: the token's scopes are a ceiling over the set, as over a role.
//   4. NON_DELEGABLE STAYS OUT OF EVERY BEARER, whatever the set and the scopes list.
//   5. A SERVICE IS UNAFFECTED: its one scope decides, even if a cast hands it a set.
//   6. A MALFORMED SET HOLDS NOTHING: only an absent field falls back to the role.
//
// Plus what rides on the rule: the offer filter (tools the authority withholds are never offered),
// the delegation ceilings (a token never snapshots what the authority withholds), and the agent-run
// refusal flag, which reads the APP's external-authority declaration (src/auth/authority.ts).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { authorityRefusesAgentRun } from '../../src/auth/authority';
import {
  ALL_ROLES,
  authorityWithholds,
  callableBy,
  can,
  effectivePermissions,
  grantableScopes,
  grantableScopesFor,
  isAgentScope,
  isServiceGrantable,
  NON_DELEGABLE,
  PERMISSIONS,
  type PermissionKey,
  principalCan,
  principalMayCall,
  scopeAllows,
} from '../../src/auth/permissions';
import { serviceScopesFor } from '../../src/auth/serviceIdentities';
import { mintApiToken, mintApiTokenFor, resolveMintScopes } from '../../src/auth/tokens';
import type {
  AuthorityPolicy,
  PersonBearerPrincipal,
  PersonCookiePrincipal,
  Principal,
  Role,
  ServicePrincipal,
} from '../../src/auth/types';
import { makeDb } from '../../src/data';
import { defineRoute } from '../../src/framework/defineRoute';
import { AppError } from '../../src/framework/errors';
import { buildMcpTools, toolsForPrincipal } from '../../src/mcp/tools';
import { allRoutes } from '../../src/routes';
import { applySchema, seedDb, USERS } from '../helpers/db';

const KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

// A MACHINE route (RouteSpec.machine, B9) beside the live table. The kit ships none, but a fork's
// table may hold several (Insights' and il-Lingua's ingest routes), so an oracle written over
// allRoutes must hold with one in it — this stand-in makes the kit's own CI prove that.
const MACHINE_STAND_IN = defineRoute({
  method: 'POST',
  path: '/api/machine-stand-in/batches',
  permission: 'notes.write',
  machine: true,
  audit: 'machine.stand_in.batch',
  input: z.object({}),
  handler: async () => ({ ok: true }),
});
const MACHINE_TOOL = 'post_machine_stand_in_batches';

function cookie(role: Role, permissions?: Iterable<PermissionKey>): PersonCookiePrincipal {
  return {
    kind: 'person',
    email: USERS[role],
    name: null,
    role,
    authMethod: 'magic_link',
    credentialTransport: 'cookie',
    ...(permissions === undefined ? {} : { permissions: new Set(permissions) }),
  };
}

function bearer(
  role: Role,
  tokenScopes: readonly string[] | null,
  permissions?: Iterable<PermissionKey>,
): PersonBearerPrincipal {
  return {
    kind: 'person',
    email: USERS[role],
    name: null,
    role,
    authMethod: 'api_token',
    credentialTransport: 'bearer',
    tokenScopes,
    ...(permissions === undefined ? {} : { permissions: new Set(permissions) }),
  };
}

function service(scope: string): ServicePrincipal {
  return {
    kind: 'service',
    email: 'svc-etl@test-app.invalid',
    name: 'ETL',
    role: null,
    authMethod: 'api_token',
    credentialTransport: 'bearer',
    service: { id: 7, slug: 'etl', scope, custodianEmail: USERS.owner },
  };
}

/** The rule as it stood before the seam: role, then the bearer ceiling. Written out on purpose. */
function preSeam(role: Role, transport: 'cookie' | 'bearer', scopes: readonly string[] | null) {
  return (key: PermissionKey) =>
    can(role, key) && (transport === 'cookie' || scopeAllows(scopes, key));
}

describe('1. role-only apps: no authoritative set, no change', () => {
  it('every role × key × credential answers what the pre-seam rule did', () => {
    const ceilings: (readonly string[] | null)[] = [null, [], ['notes.read'], KEYS];
    for (const role of ALL_ROLES) {
      const c = cookie(role);
      expect('permissions' in c).toBe(false);
      for (const key of KEYS) expect(principalCan(c, key)).toBe(preSeam(role, 'cookie', null)(key));
      for (const scopes of ceilings) {
        const b = bearer(role, scopes);
        for (const key of KEYS) {
          expect(principalCan(b, key)).toBe(preSeam(role, 'bearer', scopes)(key));
        }
      }
    }
  });

  it('an explicit `permissions: undefined` is the same absent field (the role decides)', () => {
    const p = { ...cookie('member'), permissions: undefined };
    for (const key of KEYS) expect(principalCan(p, key)).toBe(can('member', key));
  });

  it('the delegation ceiling is exactly grantableScopes(role) for every role and credential', () => {
    for (const role of ALL_ROLES) {
      expect(grantableScopesFor(cookie(role))).toEqual(grantableScopes(role));
      // The ceiling answers for the PERSON; refusing a bearer minter is the minters' own wall.
      expect(grantableScopesFor(bearer(role, []))).toEqual(grantableScopes(role));
      expect(resolveMintScopes(cookie(role))).toEqual(resolveMintScopes(role));
    }
  });

  it('the MCP tool list is the one the role column alone produced', () => {
    const tools = buildMcpTools([...allRoutes, MACHINE_STAND_IN]);
    expect(tools.map((t) => t.name)).toContain(MACHINE_TOOL);
    for (const role of ALL_ROLES) {
      const offered = toolsForPrincipal(tools, cookie(role)).map((t) => t.name);
      // A machine tool is never a person's, whatever the role column says (principalMayCall), so
      // the role-column oracle leaves every one out — a fork's live ones and the stand-in alike.
      const byRole = tools
        .filter((t) => !t.machine && (t.permission === 'authenticated' || can(role, t.permission)))
        .map((t) => t.name);
      expect(offered).toEqual(byRole);
    }
    // The stand-in is a real offer, not a dead entry: a service holding its key is offered it.
    expect(toolsForPrincipal(tools, service('notes.write')).map((t) => t.name)).toContain(
      MACHINE_TOOL,
    );
  });
});

describe('2. an authoritative set REPLACES the role', () => {
  it('a key the role grants but the set lacks is denied; a key the set holds is held', () => {
    // An owner whose authority grants only reading notes: the owner column is not a second chance.
    const owner = cookie('owner', ['notes.read']);
    for (const key of KEYS) expect(principalCan(owner, key)).toBe(key === 'notes.read');
    // A viewer whose authority grants user management: held, though the viewer column lacks it.
    const viewer = cookie('viewer', ['users.read', 'users.manage']);
    expect(principalCan(viewer, 'users.manage')).toBe(true);
    expect(principalCan(viewer, 'users.read')).toBe(true);
    expect(principalCan(viewer, 'notes.read')).toBe(false); // the viewer role has it; the set not
  });

  it('effectivePermissions (GET /api/me) lists the set, in PERMISSIONS order', () => {
    const p = cookie('member', ['notes.write', 'audit.read', 'notes.read']);
    expect(effectivePermissions(p)).toEqual(['audit.read', 'notes.read', 'notes.write']);
  });

  it('an EMPTY set holds no key — but an `authenticated` route (GET /api/me) still admits the person', () => {
    const p = cookie('owner', []);
    for (const key of KEYS) expect(principalCan(p, key)).toBe(false);
    expect(principalMayCall(p, 'authenticated')).toBe(true);
  });

  it('a string in the set that is no permission key grants nothing', () => {
    const p = cookie('viewer', ['notes.read']);
    (p.permissions as unknown as Set<string>).add('no.such.key');
    expect(effectivePermissions(p)).toEqual(['notes.read']);
  });
});

describe('3. a bearer credential still narrows the authoritative set', () => {
  const SET: PermissionKey[] = ['notes.read', 'notes.write', 'users.read', 'ai.use'];

  it('explicit scopes are a ceiling over the set', () => {
    const p = bearer('viewer', ['notes.read'], SET);
    for (const key of KEYS) expect(principalCan(p, key)).toBe(key === 'notes.read');
  });

  it('a scope the ROLE would grant but the set lacks is still denied', () => {
    // Owner role, token scoped to notes.write + settings, authority grants notes.read only.
    const p = bearer('owner', ['notes.write', 'users.read'], ['notes.read']);
    for (const key of KEYS) expect(principalCan(p, key)).toBe(false);
  });

  it('a legacy (NULL-scope) token holds the set minus the non-delegable and agent families', () => {
    const p = bearer('viewer', null, KEYS);
    for (const key of KEYS) {
      expect(principalCan(p, key)).toBe(!NON_DELEGABLE.has(key) && !isAgentScope(key));
    }
  });

  it('a bearer principal without its stored scopes holds nothing, set or no set', () => {
    const { tokenScopes: _dropped, ...rest } = bearer('owner', null, KEYS);
    const p = rest as unknown as Principal;
    for (const key of KEYS) expect(principalCan(p, key)).toBe(false);
  });

  it('a transport this code has never heard of is narrowed like a bearer', () => {
    const p = { ...bearer('owner', ['notes.read'], KEYS), credentialTransport: 'mtls' };
    for (const key of KEYS) {
      expect(principalCan(p as unknown as Principal, key)).toBe(key === 'notes.read');
    }
  });
});

describe('4. NON_DELEGABLE stays out of every bearer', () => {
  it('a set holding every key, and scopes listing every key, still hold none of it on a bearer', () => {
    const p = bearer('owner', KEYS, KEYS);
    for (const key of NON_DELEGABLE) expect(principalCan(p, key as PermissionKey)).toBe(false);
  });

  it('the same set on a SESSION holds them (a person at a keyboard)', () => {
    const p = cookie('viewer', [...NON_DELEGABLE] as PermissionKey[]);
    for (const key of NON_DELEGABLE) expect(principalCan(p, key as PermissionKey)).toBe(true);
  });

  it('the delegation ceiling never includes them', () => {
    const p = cookie('viewer', KEYS);
    const ceiling = grantableScopesFor(p);
    for (const key of NON_DELEGABLE) expect(ceiling).not.toContain(key);
    expect(ceiling).toEqual(KEYS.filter((k) => !NON_DELEGABLE.has(k)));
  });
});

describe('5. a service principal is unaffected', () => {
  it('holds its one scope and nothing else, even when a cast hands it a set of everything', () => {
    const svc = { ...service('notes.read'), permissions: new Set(KEYS) } as unknown as Principal;
    for (const key of KEYS) expect(principalCan(svc, key)).toBe(key === 'notes.read');
    // …and a set WITHOUT its scope takes nothing away either: the scope is the whole authority.
    const narrow = { ...service('notes.read'), permissions: new Set() } as unknown as Principal;
    expect(principalCan(narrow, 'notes.read')).toBe(true);
  });

  it('the Principal type forbids a set on a service principal', () => {
    const held = new Set<PermissionKey>(['notes.read']);
    const bad: ServicePrincipal = {
      ...service('notes.read'),
      // @ts-expect-error — a ServicePrincipal never carries an authoritative set.
      permissions: held,
    };
    expect(bad.kind).toBe('service');
  });
});

describe('6. a malformed set holds NOTHING — only an absent field means the role', () => {
  it('null, an array, a plain object, a Map, a string: every key denied, the role column included', () => {
    for (const bogus of [null, ['notes.read'], { 'notes.read': true }, new Map(), 'notes.read']) {
      for (const role of ALL_ROLES) {
        const p = { ...cookie(role), permissions: bogus } as unknown as Principal;
        for (const key of KEYS) expect(principalCan(p, key)).toBe(false);
        expect(effectivePermissions(p)).toEqual([]);
      }
    }
  });
});

describe('the offer filter: tools the authority withholds are never offered', () => {
  const tools = buildMcpTools(allRoutes);

  it('an owner whose authority grants notes.read is offered the notes reads and /api/me only', () => {
    const offered = toolsForPrincipal(tools, cookie('owner', ['notes.read']));
    expect(
      offered.every((t) => t.permission === 'authenticated' || t.permission === 'notes.read'),
    ).toBe(true);
    expect(offered.map((t) => t.name)).toContain('get_notes');
    expect(offered.map((t) => t.name)).not.toContain('post_notes');
    expect(offered.map((t) => t.name)).not.toContain('get_users');
  });

  it('callableBy is the same filter over any permission-gated item (the agent tool list)', () => {
    const p = bearer('member', ['notes.read', 'notes.write'], ['notes.read']);
    const items = [
      { id: 'a', permission: 'notes.read' as const },
      { id: 'b', permission: 'notes.write' as const },
      { id: 'c', permission: 'authenticated' as const },
      { id: 'd', permission: 'users.read' as const },
    ];
    expect(callableBy(p, items).map((i) => i.id)).toEqual(['a', 'c']);
    expect(toolsForPrincipal(tools, p).map((t) => t.name)).toEqual(
      callableBy(p, tools).map((t) => t.name),
    );
  });

  it('callableBy applies the machine gate too: a machine item is offered to a service, never a person (B9)', () => {
    // The one offer filter must be executeRoute's check, machine flag included — else the MCP list
    // and the agent's tool set would offer a person a machine route every call to which 404s.
    const items = [
      { id: 'plain', permission: 'notes.read' as const },
      { id: 'machine', permission: 'notes.read' as const, machine: true },
      { id: 'flag-off', permission: 'notes.read' as const, machine: false },
    ];
    // A person whose authority holds the key — on a session, and on a token scoped to exactly it.
    for (const p of [
      cookie('owner', ['notes.read']),
      bearer('owner', ['notes.read'], ['notes.read']),
    ]) {
      expect(callableBy(p, items).map((i) => i.id)).toEqual(['plain', 'flag-off']);
    }
    expect(callableBy(service('notes.read'), items).map((i) => i.id)).toEqual([
      'plain',
      'machine',
      'flag-off',
    ]);
    // …and the service still needs the key: the flag never grants anything.
    expect(callableBy(service('notes.write'), items)).toEqual([]);
  });

  it('executeRoute refuses what was not offered — the invoke is the generic denial', async () => {
    const offeredNames = new Set(
      toolsForPrincipal(tools, cookie('owner', ['notes.read'])).map((t) => t.name),
    );
    const post = tools.find((t) => t.name === 'post_notes');
    expect(post && offeredNames.has(post.name)).toBe(false);
    const res = await post?.invoke(env, cookie('owner', ['notes.read']), { title: 'x', body: '' });
    expect(res).toEqual({
      content: [{ type: 'text', text: 'This action is not available.' }],
      isError: true,
    });
  });
});

describe('authorityWithholds: did the SET deny it (and not the credential)?', () => {
  it('true only for a person whose set lacks the key', () => {
    expect(authorityWithholds(cookie('owner', ['notes.read']), 'notes.write')).toBe(true);
    expect(authorityWithholds(bearer('owner', KEYS, ['notes.read']), 'notes.write')).toBe(true);
    const nulled = { ...cookie('owner'), permissions: null } as unknown as Principal;
    expect(authorityWithholds(nulled, 'notes.read')).toBe(true); // a malformed set holds nothing
  });

  it('false when the set holds the key, even though the token ceiling or NON_DELEGABLE denies it', () => {
    const scoped = bearer('owner', ['notes.read'], ['notes.read', 'notes.write']);
    expect(principalCan(scoped, 'notes.write')).toBe(false);
    expect(authorityWithholds(scoped, 'notes.write')).toBe(false);
    const nonDelegable = [...NON_DELEGABLE][0] as PermissionKey;
    const holder = bearer('owner', KEYS, [nonDelegable]);
    expect(principalCan(holder, nonDelegable)).toBe(false);
    expect(authorityWithholds(holder, nonDelegable)).toBe(false);
  });

  it('false for a role-only person, a service, and the `authenticated` gate', () => {
    for (const role of ALL_ROLES) {
      for (const key of KEYS) expect(authorityWithholds(cookie(role), key)).toBe(false);
    }
    expect(authorityWithholds(service('notes.read'), 'notes.write')).toBe(false);
    expect(authorityWithholds(cookie('viewer', []), 'authenticated')).toBe(false);
  });
});

describe('the agent-run refusal flag: an app-level fact, not a per-principal one', () => {
  const ROLE_ONLY: AuthorityPolicy = { authorityFor: () => null, authorityIsExternal: () => false };
  const EXTERNAL: AuthorityPolicy = { authorityFor: () => null, authorityIsExternal: () => true };

  it('a person with an authoritative set on anything but a session cookie: refused, whatever the app declares', () => {
    for (const policy of [ROLE_ONLY, EXTERNAL]) {
      expect(authorityRefusesAgentRun(bearer('member', null, ['ai.use']), env, policy)).toBe(true);
      expect(authorityRefusesAgentRun(bearer('member', ['ai.use'], []), env, policy)).toBe(true);
      const novel = { ...cookie('member', ['ai.use']), credentialTransport: 'mtls' };
      expect(authorityRefusesAgentRun(novel as unknown as Principal, env, policy)).toBe(true);
    }
  });

  it('a role-only app: nobody is refused, on either credential', () => {
    for (const role of ALL_ROLES) {
      expect(authorityRefusesAgentRun(cookie(role), env, ROLE_ONLY)).toBe(false);
      expect(authorityRefusesAgentRun(bearer(role, null), env, ROLE_ONLY)).toBe(false);
      expect(authorityRefusesAgentRun(bearer(role, KEYS), env, ROLE_ONLY)).toBe(false);
    }
  });

  it('an external app: only a session whose permissions the hook decided may run the agent', () => {
    expect(authorityRefusesAgentRun(cookie('member', ['ai.use']), env, EXTERNAL)).toBe(false);
    for (const role of ALL_ROLES) {
      // The hook left these on the role — a local-authority token, a role session: refused.
      expect(authorityRefusesAgentRun(cookie(role), env, EXTERNAL)).toBe(true);
      expect(authorityRefusesAgentRun(bearer(role, null), env, EXTERNAL)).toBe(true);
      expect(authorityRefusesAgentRun(bearer(role, KEYS), env, EXTERNAL)).toBe(true);
    }
  });

  it('the declaration is read with the env it is asked about', () => {
    const perEnv: AuthorityPolicy = {
      authorityFor: () => null,
      authorityIsExternal: (e) => e.APP_ENV === 'production',
    };
    const prod = { ...env, APP_ENV: 'production' } as typeof env;
    const staging = { ...env, APP_ENV: 'staging' } as typeof env;
    expect(authorityRefusesAgentRun(bearer('member', null), prod, perEnv)).toBe(true);
    expect(authorityRefusesAgentRun(bearer('member', null), staging, perEnv)).toBe(false);
  });

  it('a malformed set counts as present (fail closed); a service is never flagged', () => {
    const nulled = { ...cookie('member'), permissions: null } as unknown as Principal;
    for (const policy of [ROLE_ONLY, EXTERNAL]) {
      expect(authorityRefusesAgentRun(nulled, env, policy)).toBe(true);
      expect(authorityRefusesAgentRun(service('ai.use'), env, policy)).toBe(false);
    }
  });

  it('a principal with no kind, or an unknown one, is refused (fail closed)', () => {
    for (const kind of [undefined, 'robot']) {
      const p = { ...cookie('owner'), kind } as unknown as Principal;
      expect(authorityRefusesAgentRun(p, env, ROLE_ONLY)).toBe(true);
    }
  });
});

describe('delegation: a credential never carries what the minter authority withholds', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('a token minted with no scopes snapshots the SET (minus non-delegable), not the role', async () => {
    const db = makeDb(env);
    const admin = cookie('admin', ['notes.read', 'tokens.self', 'ai.use']);
    const { row } = await mintApiToken(db, admin, { name: 'acl-snapshot' });
    expect(JSON.parse(row.scopes ?? 'null')).toEqual(['ai.use', 'notes.read']);
  });

  it('asking for a key the role holds but the set lacks is a 400 naming it', async () => {
    const db = makeDb(env);
    const admin = cookie('admin', ['notes.read', 'tokens.self']);
    const attempt = mintApiToken(db, admin, {
      name: 'wider',
      scopes: ['notes.read', 'users.read'],
    });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ status: 400 });
    await expect(attempt).rejects.toThrow(/users\.read/);
  });

  it('issuing for another account is capped by the MINTER set as well as the owner role', async () => {
    const db = makeDb(env);
    const admin = cookie('admin', ['notes.read', 'users.manage']);
    // Another account whose ROLE holds notes.read in this app (the app section of PERMISSIONS is
    // the fork's: Insights gives notes.* to owner/admin only, so not always `member`).
    const target = (['member', 'viewer', 'owner'] as const).find((r) => can(r, 'notes.read'));
    if (!target) throw new Error('this test needs a non-admin role holding notes.read');
    const { row } = await mintApiTokenFor(db, admin, USERS[target], { name: 'issued' });
    expect(JSON.parse(row.scopes ?? 'null')).toEqual(['notes.read']);
  });

  it('a service identity may only be given a key the actor set allows', () => {
    expect(serviceScopesFor(cookie('admin', ['serviceIdentities.manage', 'notes.read']))).toEqual([
      'notes.read',
    ]);
    // …and a role-only admin is offered exactly what the admin role may delegate, as before.
    expect(serviceScopesFor(cookie('admin'))).toEqual(
      grantableScopes('admin').filter(isServiceGrantable),
    );
  });
});
