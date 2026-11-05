import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditRepo } from '../../src/data/audit';
import { applySchema, seedDb } from '../helpers/db';

// The audit_log + ai_usage tables are append-only by design. Convention (the framework is
// the single writer) is not enough for a security auditor: these triggers enforce it at
// the DB layer, so even a holder of D1 credentials cannot rewrite or erase history.
describe('audit_log + ai_usage are append-only at the DB layer (WORM triggers)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('allows INSERT into audit_log (the framework write path still works)', async () => {
    await auditRepo(env.DB).insert({ actor_email: 'a@test.example', action: 'login' });
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('rejects UPDATE of an audit_log row and leaves it unchanged', async () => {
    await auditRepo(env.DB).insert({ actor_email: 'a@test.example', action: 'login' });
    await expect(env.DB.prepare("UPDATE audit_log SET action = 'tampered'").run()).rejects.toThrow(
      /append-only/,
    );
    const row = await env.DB.prepare('SELECT action FROM audit_log').first<{ action: string }>();
    expect(row?.action).toBe('login');
  });

  it('rejects DELETE of an audit_log row and leaves it in place', async () => {
    await auditRepo(env.DB).insert({ actor_email: 'a@test.example', action: 'login' });
    await expect(env.DB.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('rejects INSERT OR REPLACE overwrite-by-id and leaves the original row intact', async () => {
    // D1 runs recursive_triggers OFF, so a REPLACE's implicit delete would NOT fire the
    // BEFORE DELETE trigger — without the BEFORE INSERT guard, a known id could be rewritten.
    await auditRepo(env.DB).insert({ actor_email: 'real@test.example', action: 'login' });
    const seeded = await env.DB.prepare('SELECT id FROM audit_log').first<{ id: number }>();
    const id = seeded?.id as number;
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO audit_log (id, actor_email, action) VALUES (?, 'attacker', 'TAMPERED')",
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/append-only/);
    const row = await env.DB.prepare('SELECT actor_email, action FROM audit_log WHERE id = ?')
      .bind(id)
      .first<{ actor_email: string; action: string }>();
    expect(row?.actor_email).toBe('real@test.example');
    expect(row?.action).toBe('login');
  });

  it('rejects UPDATE and DELETE of ai_usage', async () => {
    await env.DB.prepare(
      "INSERT INTO ai_usage (actor_email, model, input_tokens, output_tokens, cost_usd) VALUES ('a@test.example', 'claude', 1, 1, 0.01)",
    ).run();
    await expect(env.DB.prepare('UPDATE ai_usage SET cost_usd = 99').run()).rejects.toThrow(
      /append-only/,
    );
    await expect(env.DB.prepare('DELETE FROM ai_usage').run()).rejects.toThrow(/append-only/);
  });

  it('seedDb still resets the WORM tables between tests (drop + recreate)', async () => {
    // Prior tests in this file inserted rows; beforeEach(seedDb) must have cleared them
    // despite the DELETE-blocking triggers.
    const a = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>();
    const u = await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_usage').first<{ n: number }>();
    expect(a?.n).toBe(0);
    expect(u?.n).toBe(0);
  });
});
