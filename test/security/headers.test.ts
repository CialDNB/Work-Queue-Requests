import { SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE } from '../helpers/http';

// AICOE-198: every worker response carries the baseline security headers. The SPA
// document + static assets get their (document-shaped) headers from web/public/_headers,
// which Static Assets serves and is not exercised by this in-runtime test.
const BASELINE: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

function expectBaseline(res: Response) {
  for (const [k, v] of Object.entries(BASELINE)) expect(res.headers.get(k)).toBe(v);
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
}

describe('security headers (worker responses)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('sets the baseline on the public /_health response (and preserves no-store)', async () => {
    const res = await SELF.fetch(`${BASE}/_health`);
    expectBaseline(res);
    expect(res.headers.get('cache-control')).toBe('no-store'); // existing header untouched
  });

  it('sets them on the fail-closed 401 (unauthenticated API)', async () => {
    const res = await SELF.fetch(`${BASE}/api/me`);
    expect(res.status).toBe(401);
    expectBaseline(res);
  });

  it('sets them on the canonical 404', async () => {
    const res = await SELF.fetch(`${BASE}/api/definitely-not-real`);
    expect(res.status).toBe(404);
    expectBaseline(res);
  });

  it('sets them on a successful authenticated response', async () => {
    const res = await asUser(USERS.member, 'GET', '/api/me');
    expect(res.status).toBe(200);
    expectBaseline(res);
  });
});
