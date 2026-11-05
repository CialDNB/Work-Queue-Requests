import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/cookies';
import { createSession } from '../../src/auth/sessions';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

describe('user administration', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('admin can invite a member; duplicates conflict', async () => {
    const res = await asUser(USERS.admin, 'POST', '/api/users', {
      email: 'newbie@test.example',
      name: 'New Person',
      role: 'member',
    });
    expect(res.status).toBe(201);
    const dup = await asUser(USERS.admin, 'POST', '/api/users', {
      email: 'newbie@test.example',
      role: 'member',
    });
    expect(dup.status).toBe(409);
  });

  it('invites outside ALLOWED_EMAIL_DOMAINS are rejected explicitly', async () => {
    const res = await asUser(USERS.admin, 'POST', '/api/users', {
      email: 'outsider@nowhere.example',
      role: 'member',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('domain_not_allowed');
  });

  it('admins cannot mint admins or owners (uniform 404)', async () => {
    const res = await asUser(USERS.admin, 'POST', '/api/users', {
      email: 'sneaky@test.example',
      role: 'admin',
    });
    expect(res.status).toBe(404);
  });

  it('owner can promote and demote; admin cannot touch owners', async () => {
    const promote = await asUser(USERS.owner, 'PATCH', `/api/users/${USERS.member}`, {
      role: 'admin',
    });
    expect(promote.status).toBe(200);
    const adminOnOwner = await asUser(USERS.admin, 'PATCH', `/api/users/${USERS.owner}`, {
      role: 'member',
    });
    expect(adminOnOwner.status).toBe(404);
  });

  it('nobody modifies their own access', async () => {
    const res = await asUser(USERS.owner, 'PATCH', `/api/users/${USERS.owner}`, {
      role: 'member',
    });
    expect(res.status).toBe(409);
  });

  it('with two active owners, demoting or disabling one succeeds', async () => {
    const invite = await asUser(USERS.owner, 'POST', '/api/users', {
      email: 'owner2@test.example',
      role: 'owner',
    });
    expect(invite.status).toBe(201);
    // Two active owners: the last-active-owner guards stay quiet.
    const demote = await asUser(USERS.owner, 'PATCH', '/api/users/owner2@test.example', {
      role: 'member',
    });
    expect(demote.status).toBe(200);
    // Re-promote is asserted: if it silently failed, the disable below would prove only
    // "disabling a MEMBER succeeds" and the owner-with-two-active claim would evaporate.
    const repromote = await asUser(USERS.owner, 'PATCH', '/api/users/owner2@test.example', {
      role: 'owner',
    });
    expect(repromote.status).toBe(200);
    const disable = await asUser(USERS.owner, 'PATCH', '/api/users/owner2@test.example', {
      disabled: true,
    });
    expect(disable.status).toBe(200);
  });

  it('the last-active-owner guards fire at 409 once only one active owner remains', async () => {
    // Invite a second owner, then disable them: countActiveOwners() drops to 1.
    const invite = await asUser(USERS.owner, 'POST', '/api/users', {
      email: 'owner2@test.example',
      role: 'owner',
    });
    expect(invite.status).toBe(201);
    const disable = await asUser(USERS.owner, 'PATCH', '/api/users/owner2@test.example', {
      disabled: true,
    });
    expect(disable.status).toBe(200);

    // The guards read countActiveOwners() and fire on ANY owner-roled target once a single
    // active owner remains — including this disabled one. The direct scenario (demoting the
    // sole ACTIVE owner) is unreachable today: self-modification 409s first and admins get
    // the uniform 404 on owners. The guards are the last line if either rule ever loosens;
    // this is the reachable path that executes the same code. Message assertions bind each
    // 409 to its specific guard, so deleting a guard fails the test.
    const demote = await asUser(USERS.owner, 'PATCH', '/api/users/owner2@test.example', {
      role: 'member',
    });
    expect(demote.status).toBe(409);
    const demoteBody = (await demote.json()) as { error: { code: string; message: string } };
    expect(demoteBody.error.message).toBe('Cannot demote the last active owner');

    const disableAgain = await asUser(USERS.owner, 'PATCH', '/api/users/owner2@test.example', {
      disabled: true,
    });
    expect(disableAgain.status).toBe(409);
    const disableBody = (await disableAgain.json()) as { error: { code: string; message: string } };
    expect(disableBody.error.message).toBe('Cannot disable the last active owner');
  });

  it('disabled users are rejected by the live-user check even on a fresh session', async () => {
    const before = await asUser(USERS.member, 'GET', '/api/me');
    expect(before.status).toBe(200);
    const res = await asUser(USERS.admin, 'PATCH', `/api/users/${USERS.member}`, {
      disabled: true,
    });
    expect(res.status).toBe(200);
    // asUser mints a fresh session per call, which postdates the revocation tombstone —
    // so this 401 is the live-user check, NOT session revocation (proven separately below).
    const after = await asUser(USERS.member, 'GET', '/api/notes');
    expect(after.status).toBe(401);
  });

  it('disabling a user revokes their pre-existing sessions (isolated from the live-user check)', async () => {
    // Mint the session BEFORE the disable, at an explicit past instant.
    const preSid = await createSession(env, USERS.member, 'magic_link', Date.now() - 1_000);
    const preCookie = `${SESSION_COOKIE}=${preSid}`;
    const before = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: preCookie } });
    expect(before.status).toBe(200);

    // Disable writes the revocation tombstone; re-enable makes the live-user check pass
    // again — so a remaining 401 on the old cookie can only come from the revocation
    // wired at the disable path (src/routes/users.ts revokeAllSessions call).
    await asUser(USERS.admin, 'PATCH', `/api/users/${USERS.member}`, { disabled: true });
    await asUser(USERS.admin, 'PATCH', `/api/users/${USERS.member}`, { disabled: false });

    const after = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: preCookie } });
    expect(after.status).toBe(401);

    // A session minted after the revocation instant is honored.
    const postSid = await createSession(env, USERS.member, 'magic_link', Date.now() + 60_000);
    const post = await SELF.fetch(`${BASE}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${postSid}` },
    });
    expect(post.status).toBe(200);
  });

  it('disabled users can be re-enabled and start a new session', async () => {
    await asUser(USERS.admin, 'PATCH', `/api/users/${USERS.member}`, { disabled: true });
    await asUser(USERS.admin, 'PATCH', `/api/users/${USERS.member}`, { disabled: false });
    // The disable revoked sessions at "now"; a session minted after that instant is
    // honored. Use an explicit post-revoke timestamp instead of sleeping on the clock.
    const sid = await createSession(env, USERS.member, 'magic_link', Date.now() + 60_000);
    const res = await SELF.fetch(`${BASE}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(res.status).toBe(200);
  });

  it('paginates the users list with a keyset cursor (AICOE-206)', async () => {
    // 4 seeded + 5 invited = 9 users; page through them in fours.
    for (let i = 0; i < 5; i++) {
      const r = await asUser(USERS.admin, 'POST', '/api/users', {
        email: `p${i}@test.example`,
        role: 'member',
      });
      expect(r.status).toBe(201);
    }

    type Page = { data: { users: { email: string }[]; next_cursor: string | null } };
    const getPage = async (cursor?: string): Promise<Page['data']> => {
      const path = `/api/users?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      return ((await (await asUser(USERS.admin, 'GET', path)).json()) as Page).data;
    };

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page['data'] = await getPage(cursor ?? undefined);
      expect(page.users.length).toBeLessThanOrEqual(4);
      for (const u of page.users) {
        expect(seen.has(u.email)).toBe(false); // no overlap across pages
        seen.add(u.email);
      }
      cursor = page.next_cursor;
      pages++;
    } while (cursor);

    expect(seen.size).toBe(9); // every user surfaced exactly once
    expect(pages).toBe(3); // 4 + 4 + 1
  });
});
