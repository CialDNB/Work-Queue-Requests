// GET /api/test — the smoke-check endpoint. Envelope shape, auth gate, input validation.
import { SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_MESSAGE } from '../../src/routes/test';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

describe('test API (GET /api/test)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('returns the test message in the canonical success envelope', async () => {
    const res = await asUser(USERS.member, 'GET', '/api/test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { message: string } };
    expect(body).toEqual({ ok: true, data: { message: TEST_MESSAGE } });
  });

  it('is reachable by every signed-in role, viewer included', async () => {
    const res = await asUser(USERS.viewer, 'GET', '/api/test');
    expect(res.status).toBe(200);
  });

  it('refuses an anonymous caller', async () => {
    const res = await SELF.fetch(`${BASE}/api/test`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});
