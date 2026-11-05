import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditRepo, HAS_SUCCESSFUL_LOGIN_SQL } from '../../src/data/audit';
import { applySchema, seedDb } from '../helpers/db';

describe('audit repo — listByAction + idx_audit_action (AICOE-209)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('returns rows for an action, newest first', async () => {
    const repo = auditRepo(env.DB);
    await repo.insert({ actor_email: 'a@test.example', action: 'login' });
    await repo.insert({ actor_email: 'b@test.example', action: 'note.create' });
    await repo.insert({ actor_email: 'c@test.example', action: 'login' });
    const rows = await repo.listByAction('login', 10);
    expect(rows.map((r) => r.actor_email)).toEqual(['c@test.example', 'a@test.example']);
  });

  it('serves the action query from idx_audit_action, not a full scan', async () => {
    const plan = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?',
    )
      .bind('login', 10)
      .all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(' | ');
    expect(detail).toContain('idx_audit_action');
    expect(detail).not.toContain('SCAN audit_log'); // a full table scan would say this
  });
});

describe('audit repo — hasSuccessfulLogin (the entra-only proof)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const raw = (action: string, payload: string | null) =>
    env.DB.prepare('INSERT INTO audit_log (actor_email, action, payload_json) VALUES (?, ?, ?)')
      .bind('a@test.example', action, payload)
      .run();

  it('is false on an empty log, and true once a matching login row exists', async () => {
    const repo = auditRepo(env.DB);
    expect(await repo.hasSuccessfulLogin('entra_oidc')).toBe(false);
    await repo.insert({
      actor_email: 'a@test.example',
      action: 'login',
      payload_json: JSON.stringify({ method: 'entra_oidc', tid: 't' }),
    });
    expect(await repo.hasSuccessfulLogin('entra_oidc')).toBe(true);
    expect(await repo.hasSuccessfulLogin('magic_link')).toBe(false); // per method, not any login
  });

  it('with a tenant, counts only a login FROM that tenant (consent is per tenant)', async () => {
    const tenantA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const tenantB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const repo = auditRepo(env.DB);
    await raw('login', '{"method":"entra_oidc"}'); // Microsoft, but from no tenant
    await raw('login', JSON.stringify({ method: 'magic_link', tid: tenantB })); // tenant, not Microsoft
    expect(await repo.hasSuccessfulLogin('entra_oidc', tenantA)).toBe(false);
    expect(await repo.hasSuccessfulLogin('entra_oidc', tenantB)).toBe(false);
    await raw('login', JSON.stringify({ method: 'entra_oidc', tid: tenantA }));
    expect(await repo.hasSuccessfulLogin('entra_oidc', tenantA)).toBe(true);
    expect(await repo.hasSuccessfulLogin('entra_oidc', tenantB)).toBe(false);
    expect(await repo.hasSuccessfulLogin('entra_oidc', tenantA.toUpperCase())).toBe(false); // exact
  });

  it('a malformed payload is not proof — and never throws, wherever it sits in the log', async () => {
    // json_extract THROWS on malformed JSON; the CASE/json_valid guard must keep one bad
    // append-only row from turning every call into a 500. Bad rows before AND after a good one.
    await raw('login', '{"method":');
    await raw('login', 'not json');
    const repo = auditRepo(env.DB);
    expect(await repo.hasSuccessfulLogin('entra_oidc')).toBe(false);
    expect(await repo.hasSuccessfulLogin('entra_oidc', 't')).toBe(false);
    await raw('login', '{"method":"entra_oidc","tid":"t"}');
    await raw('login', '{{{');
    expect(await repo.hasSuccessfulLogin('entra_oidc')).toBe(true);
    expect(await repo.hasSuccessfulLogin('entra_oidc', 't')).toBe(true);
  });

  it('serves the probe from idx_audit_action, not a full scan', async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${HAS_SUCCESSFUL_LOGIN_SQL}`)
      .bind('entra_oidc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
      .all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(' | ');
    expect(detail).toContain('idx_audit_action');
    expect(detail).not.toContain('SCAN audit_log');
  });
});

describe('audit repo — list pagination (LIMIT+1/hasMore, no phantom page)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('emits next_before=null on an exactly-full final page', async () => {
    // seedDb drops + recreates the WORM audit_log, so it starts empty — counts are exact.
    const repo = auditRepo(env.DB);
    for (let i = 0; i < 3; i++)
      await repo.insert({ actor_email: `u${i}@test.example`, action: 'x' });
    const page = await repo.list({ limit: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.next_before).toBeNull(); // no older row → no phantom trailing page
  });

  it('emits a cursor only when older rows remain, and paginates to the end', async () => {
    const repo = auditRepo(env.DB);
    for (let i = 0; i < 4; i++)
      await repo.insert({ actor_email: `u${i}@test.example`, action: 'x' });
    const p1 = await repo.list({ limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.next_before).not.toBeNull();
    const p2 = await repo.list({ limit: 3, before: p1.next_before as number });
    expect(p2.items).toHaveLength(1); // the 4th (oldest) row
    expect(p2.next_before).toBeNull(); // and nothing beyond it
  });
});

describe('audit repo — sinceHours cap keeps the NEWEST rows (digest window)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('over the cap, returns the newest `cap` rows oldest-first — not the start of the window', async () => {
    const repo = auditRepo(env.DB);
    // Five rows in the window; a cap of 3 must keep the THREE NEWEST (u2,u3,u4). A bare
    // `ORDER BY id ASC LIMIT 3` would have kept the OLDEST (u0,u1,u2) and dropped the newest —
    // so on a flood day the digest would analyze the start of the window and miss the most
    // recent anomalies. Rows come back oldest-first for the chronological detector.
    for (let i = 0; i < 5; i++)
      await repo.insert({ actor_email: `u${i}@test.example`, action: 'login' });
    const rows = await repo.sinceHours(24, 3);
    expect(rows.map((r) => r.actor_email)).toEqual([
      'u2@test.example',
      'u3@test.example',
      'u4@test.example',
    ]);
  });

  it('under the cap, returns the full window oldest-first', async () => {
    const repo = auditRepo(env.DB);
    for (let i = 0; i < 3; i++)
      await repo.insert({ actor_email: `u${i}@test.example`, action: 'login' });
    const rows = await repo.sinceHours(24, 50);
    expect(rows.map((r) => r.actor_email)).toEqual([
      'u0@test.example',
      'u1@test.example',
      'u2@test.example',
    ]);
  });
});
