import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capsFromEnv, reconcileBudget, reserveBudget, todayUtc } from '../../src/ai/budget';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { applySchema, seedDb, USERS } from '../helpers/db';

describe('AI budget gates', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('reads the D11 default caps from env ($0.50 / $5 / $50)', () => {
    expect(capsFromEnv(env)).toEqual({
      maxCallUsd: 0.5,
      dailyUserCapUsd: 5,
      dailyGlobalCapUsd: 50,
    });
  });

  it('refuses calls whose estimate exceeds the per-call cap', async () => {
    const result = await reserveBudget(env, USERS.member, 0.6);
    expect(result).toEqual({ ok: false, reason: 'per_call_cap' });
  });

  it('enforces the per-user daily cap atomically', async () => {
    const tight: Env = { ...env, AI_DAILY_USER_CAP_USD: '0.1' };
    const first = await reserveBudget(tight, USERS.member, 0.08);
    expect(first.ok).toBe(true);
    const second = await reserveBudget(tight, USERS.member, 0.08);
    expect(second).toEqual({ ok: false, reason: 'user_daily_cap' });
    // Another user is unaffected.
    const other = await reserveBudget(tight, USERS.admin, 0.08);
    expect(other.ok).toBe(true);
  });

  it('rolls back the user reservation when the global cap refuses', async () => {
    const tight: Env = { ...env, AI_DAILY_GLOBAL_CAP_USD: '0.1' };
    const first = await reserveBudget(tight, USERS.member, 0.08);
    expect(first.ok).toBe(true);
    const refused = await reserveBudget(tight, USERS.admin, 0.08);
    expect(refused).toEqual({ ok: false, reason: 'global_daily_cap' });
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.admin}`, todayUtc())).toBe(0);
    expect(await repo.reservedToday('g', todayUtc())).toBeCloseTo(0.08, 6);
  });

  it('reconciles the reservation down to actual cost and records usage', async () => {
    const reserved = await reserveBudget(env, USERS.member, 0.4);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    await reconcileBudget(env, USERS.member, reserved.day, reserved.reservedUsd, {
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.006,
    });
    const repo = makeDb(env).aiBudget;
    expect(await repo.reservedToday(`u:${USERS.member}`, reserved.day)).toBeCloseTo(0.006, 6);
    expect(await repo.reservedToday('g', reserved.day)).toBeCloseTo(0.006, 6);
    const usage = await env.DB.prepare('SELECT * FROM ai_usage').first<{
      actor_email: string;
      cost_usd: number;
    }>();
    expect(usage?.actor_email).toBe(USERS.member);
    expect(usage?.cost_usd).toBeCloseTo(0.006, 6);
  });

  it('a cap of 0 disables that gate', async () => {
    const open: Env = {
      ...env,
      AI_MAX_CALL_USD: '0',
      AI_DAILY_USER_CAP_USD: '0',
      AI_DAILY_GLOBAL_CAP_USD: '0',
    };
    const result = await reserveBudget(open, USERS.member, 100);
    expect(result.ok).toBe(true);
  });
});
