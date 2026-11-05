/* Control-plane tripwire (src/cron/auditWatch.ts). Two layers:
 *  - detectSuspicious(): the PURE security core — app-scoping over the whole entry (incl. the
 *    real-API shape where the name is only in newValueJson), the deploy-actor allowlist, the
 *    empty-allowlist "flag everything" default, and event-id dedup. No env, no IO, no timestamp
 *    logic.
 *  - runAuditWatch(): the orchestrator — unconfigured/first-run/clear/alert/error/truncation
 *    paths, the well-formed API request, the lag-aware cursor, and cross-tick dedup — with a
 *    stubbed global fetch, an in-memory KV, a fake EMAIL binding, and the real test D1 for the
 *    forensic audit rows.
 *
 * Ported from Atlas's hardened audit-watch suite; generalized to the kit (env.APP_NAME match,
 * getSecret token, ALERT_EMAIL recipient, DASHBOARD_HOST, kit audit repo). */

import { env as realEnv } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AuditLogEntry,
  type DetectConfig,
  detectSuspicious,
  runAuditWatch,
} from '../../src/cron/auditWatch';
import type { Env } from '../../src/env';
import { applySchema, seedDb } from '../helpers/db';

const PER_PAGE = 1000; // must match the module constant (exercises the page loop)
const SAFETY_LAG_MS = 20 * 60_000; // must match the module constant
const NOW = new Date('2026-06-30T12:00:00.000Z');
const lagCursor = new Date(NOW.getTime() - SAFETY_LAG_MS).toISOString();

// ---------- builders ----------

function mkEntry(
  when: string,
  o: Partial<{
    id: string;
    actorEmail: string;
    actorId: string;
    actorType: string;
    actorIp: string;
    action: string;
    resourceType: string;
    resourceId: string;
    newValueJson: unknown;
    result: boolean;
  }> = {},
): AuditLogEntry {
  return {
    id: o.id ?? `audit_${when}`,
    when,
    actor: {
      email: o.actorEmail,
      id: o.actorId,
      type: o.actorType ?? 'user',
      ip: o.actorIp ?? '203.0.113.7',
    },
    action: { type: o.action ?? 'worker_script.update', result: o.result ?? true },
    resource: { type: o.resourceType ?? 'script', id: o.resourceId ?? 'test-app' },
    ...(o.newValueJson === undefined ? {} : { newValueJson: o.newValueJson }),
  };
}

const cfg = (over: Partial<DetectConfig> = {}): DetectConfig => ({
  appMatch: 'test-app',
  deployActors: new Set(),
  seenIds: new Set(),
  ...over,
});

// ---------- pure core ----------

describe('detectSuspicious — pure security core', () => {
  it('flags a human-actor change to an app resource', () => {
    const out = detectSuspicious(
      [mkEntry('2026-06-30T10:00:00Z', { actorEmail: 'mallory@evil.test' })],
      cfg(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      actor: 'mallory@evil.test',
      resource: 'script:test-app',
      result: 'ok',
    });
  });

  it('REGRESSION: flags a real-shape D1 entry where the name is only in newValueJson (UUID resource.id, bare verb)', () => {
    // The shape the live API actually returns (verified against Cloudflare docs): resource.id is a
    // UUID, action.type is a bare verb, the name is in newValueJson. Matching only resource/action
    // fields would silently miss every D1/secret/script change.
    const out = detectSuspicious(
      [
        mkEntry('2026-06-30T10:00:00Z', {
          actorEmail: 'mallory@evil.test',
          action: 'create',
          resourceType: 'd1.database',
          resourceId: '11a21122-1a11-12bb-11ab-1aa2aa1ab12a',
          newValueJson: { database_name: 'test-app' },
        }),
      ],
      cfg(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.resource).toBe('d1.database:11a21122-1a11-12bb-11ab-1aa2aa1ab12a');
  });

  it('does NOT match the fragment when it only appears in the actor (anti-spoof)', () => {
    const out = detectSuspicious(
      [
        mkEntry('2026-06-30T10:00:00Z', {
          actorEmail: 'test-app-impersonator@evil.test', // fragment here must NOT scope it in
          action: 'create',
          resourceType: 'dns_record',
          resourceId: 'example.com',
        }),
      ],
      cfg(),
    );
    expect(out).toHaveLength(0);
  });

  it('does NOT flag a change by an allowlisted deploy actor (by email, and by id)', () => {
    expect(
      detectSuspicious(
        [mkEntry('2026-06-30T10:00:00Z', { actorEmail: 'ci-bot@cialdnb.com' })],
        cfg({ deployActors: new Set(['ci-bot@cialdnb.com']) }),
      ),
    ).toHaveLength(0);
    expect(
      detectSuspicious(
        [mkEntry('2026-06-30T10:00:00Z', { actorId: 'token-abc' })],
        cfg({ deployActors: new Set(['token-abc']) }),
      ),
    ).toHaveLength(0);
  });

  it('ignores changes to non-app resources (other apps in the same account)', () => {
    const out = detectSuspicious(
      [
        mkEntry('2026-06-30T10:00:00Z', {
          actorEmail: 'someone@cialdnb.com',
          action: 'update',
          resourceType: 'dns_record',
          resourceId: 'other-app.example.com',
        }),
      ],
      cfg(),
    );
    expect(out).toHaveLength(0);
  });

  it('skips events already alerted (id in seenIds) — cross-tick dedup', () => {
    const out = detectSuspicious(
      [mkEntry('2026-06-30T10:00:00Z', { id: 'dup-1', actorEmail: 'mallory@evil.test' })],
      cfg({ seenIds: new Set(['dup-1']) }),
    );
    expect(out).toHaveLength(0);
  });

  it('empty allowlist flags EVERY app change (safe no-false-negative default)', () => {
    expect(
      detectSuspicious(
        [mkEntry('2026-06-30T10:00:00Z', { actorEmail: 'ci-bot@cialdnb.com' })],
        cfg(),
      ),
    ).toHaveLength(1);
  });

  it('labels result: false→failed, true→ok, missing→unknown (never silently "ok")', () => {
    const base = { actorEmail: 'mallory@evil.test' };
    expect(
      detectSuspicious([mkEntry('2026-06-30T10:00:00Z', { ...base, result: false })], cfg())[0]
        ?.result,
    ).toBe('failed');
    expect(
      detectSuspicious([mkEntry('2026-06-30T10:00:00Z', { ...base, result: true })], cfg())[0]
        ?.result,
    ).toBe('ok');
    const noResult: AuditLogEntry = {
      id: 'x',
      when: '2026-06-30T10:00:00Z',
      actor: { email: 'm@evil.test' },
      action: { type: 'update' },
      resource: { id: 'test-app', type: 'script' },
    };
    expect(detectSuspicious([noResult], cfg())[0]?.result).toBe('unknown');
  });
});

// ---------- orchestrator ----------

function fakeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
}

function fakeEmail() {
  const sent: Array<Record<string, unknown>> = [];
  return { sent, send: async (m: Record<string, unknown>) => void sent.push(m) };
}

/* Stub fetch with one array of entries PER PAGE; the spy records every call so tests can assert the
 * request URL + auth header. Page N returns pages[N-1]. */
function stubFetch(pages: AuditLogEntry[][], opts: { status?: number; success?: boolean } = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? '1');
    return new Response(
      JSON.stringify({ success: opts.success ?? true, result: pages[page - 1] ?? [] }),
      { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', spy);
  return { spy, calls };
}

const CURSOR_KEY = '__audit_watch:cursor';
const SEEN_KEY = '__audit_watch:seen';

function envFor(opts: {
  kv: ReturnType<typeof fakeKV>;
  email?: ReturnType<typeof fakeEmail>;
  token?: string | undefined;
  accountId?: string | undefined;
  alertEmail?: string | undefined;
  deployActors?: string;
}): Env {
  return {
    ...realEnv,
    APP_NAME: 'test-app',
    DASHBOARD_HOST: 'test-app.test',
    SESSIONS: opts.kv as unknown as KVNamespace,
    EMAIL: opts.email as unknown as Env['EMAIL'],
    AUDIT_API_TOKEN: 'token' in opts ? opts.token : 'cf-audit-token',
    CF_ACCOUNT_ID: 'accountId' in opts ? (opts.accountId as string) : 'acct-123',
    ALERT_EMAIL: 'alertEmail' in opts ? opts.alertEmail : 'security@test-app.test',
    AUDIT_DEPLOY_ACTORS: opts.deployActors ?? 'ci-bot@cialdnb.com',
  } as Env;
}

async function latestAction(
  action: string,
): Promise<{ target: string | null; payload_json: string | null } | null> {
  return realEnv.DB.prepare(
    'SELECT target, payload_json FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1',
  )
    .bind(action)
    .first();
}
async function countAction(action: string): Promise<number> {
  const r = await realEnv.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?')
    .bind(action)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

describe('runAuditWatch — orchestrator', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.unstubAllGlobals());

  it('unconfigured (no token): no fetch, audits audit_watch_skipped, no email', async () => {
    const { spy } = stubFetch([[]]);
    const email = fakeEmail();
    await runAuditWatch(envFor({ kv: fakeKV(), email, token: undefined }), NOW);
    expect(spy).not.toHaveBeenCalled();
    expect(email.sent).toHaveLength(0);
    expect(await countAction('audit_watch_skipped')).toBe(1);
  });

  it('resolves a Secrets Store binding (.get()) for the token, not just a plain string', async () => {
    // In prod the token is a Secrets Store binding object, not a string. Reading it raw would put
    // "[object Object]" in the Bearer header and 401; getSecret must unwrap it via .get(). This
    // guards that exact regression.
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const { calls } = stubFetch([[]]);
    const binding = { get: async () => 'store-token' } as unknown as Env['AUDIT_API_TOKEN'];
    const env = { ...envFor({ kv, email: fakeEmail() }), AUDIT_API_TOKEN: binding } as Env;

    await runAuditWatch(env, NOW);

    expect(calls).toHaveLength(1);
    // Read through to `authorization` via optional chaining rather than casting the possibly-
    // undefined chain and dereferencing it: if the chain short-circuits, this fails the assertion
    // with a readable diff instead of throwing TypeError from inside expect() (biome 2's
    // noUnsafeOptionalChaining — the assertion is the point, the crash is noise).
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer store-token');
  });

  it('issues a well-formed request (since/per_page/page/direction + Bearer auth)', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const { calls } = stubFetch([[]]);
    await runAuditWatch(envFor({ kv, email: fakeEmail() }), NOW);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('expected one fetch call');
    expect(call.url).toContain('/accounts/acct-123/audit_logs');
    expect(call.url).toContain('since=2026-06-30T09%3A00%3A00.000Z');
    expect(call.url).toContain(`per_page=${PER_PAGE}`);
    expect(call.url).toContain('page=1');
    expect(call.url).toContain('direction=asc');
    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer cf-audit-token');
  });

  it('first run (no cursor): scans a lookback window (does not skip it) and can still alert', async () => {
    const kv = fakeKV();
    const email = fakeEmail();
    const { calls } = stubFetch([
      [mkEntry('2026-06-30T11:30:00Z', { actorEmail: 'mallory@evil.test' })],
    ]);
    await runAuditWatch(envFor({ kv, email }), NOW);
    // It scanned (fetch happened) since ~1h ago, rather than returning early.
    expect(calls[0]?.url).toContain('since=2026-06-30T11%3A00%3A00.000Z');
    expect(await countAction('audit_watch_initialized')).toBe(1);
    expect(email.sent).toHaveLength(1); // a change in the lookback window is caught, not skipped
  });

  it('suspicious event: emails the alert (tight subject), writes a forensic row, advances cursor to now−lag, remembers id', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const email = fakeEmail();
    stubFetch([
      [mkEntry('2026-06-30T11:55:00Z', { id: 'evt-1', actorEmail: 'mallory@evil.test' })],
    ]);

    await runAuditWatch(envFor({ kv, email }), NOW);

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.subject).toBe('⚠ test-app security alert — 1 unsanctioned change');
    expect(email.sent[0]?.to).toBe('security@test-app.test');
    expect((await latestAction('security_audit_alert'))?.target).toBe('mallory@evil.test');
    expect(kv.store.get(CURSOR_KEY)).toBe(lagCursor); // trails real time by SAFETY_LAG
    expect(JSON.parse(kv.store.get(SEEN_KEY) ?? '[]')).toContain('evt-1');
  });

  // ALERT_EMAIL is contractually a comma-separated LIST (src/cron/alert.ts parseRecipients), and
  // docs/GO-LIVE.md REQUIRES a second recipient to graduate an app to Stable. Passing it raw to
  // the one-address Email binding made that mandated config silently kill the tripwire's only
  // channel — audited forever, notified never. Fan-out is the whole point of the alert seam.
  it('multi-recipient ALERT_EMAIL: alerts EVERY recipient (not one invalid combined address)', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const email = fakeEmail();
    stubFetch([[mkEntry('2026-06-30T11:55:00Z', { id: 'evt-multi' })]]);

    await runAuditWatch(
      { ...envFor({ kv, email }), ALERT_EMAIL: 'a@test-app.test, b@test-app.test' } as Env,
      NOW,
    );

    expect(email.sent.map((m) => m.to)).toEqual(['a@test-app.test', 'b@test-app.test']);
    // Never the raw list as a single address — that is the invalid recipient that killed it.
    expect(email.sent.map((m) => m.to)).not.toContain('a@test-app.test, b@test-app.test');
  });

  // The cursor and seenIds used to commit BEFORE the send, so a transient mailer failure put the
  // event both past the cursor and into seenIds — unreachable by any later tick. Lost forever.
  it('send failure: holds cursor + seen-ids so the alert retries, and audits the miss', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const before = await countAction('audit_watch_alert_undelivered');
    const brokenEmail = {
      sent: [],
      send: async () => {
        throw new Error('transport exploded');
      },
    };
    stubFetch([[mkEntry('2026-06-30T11:55:00Z', { id: 'evt-undelivered' })]]);

    await runAuditWatch(
      envFor({ kv, email: brokenEmail as unknown as ReturnType<typeof fakeEmail> }),
      NOW,
    );

    // Held: the next tick must be able to re-find and re-send this event.
    expect(kv.store.get(CURSOR_KEY)).toBe('2026-06-30T09:00:00.000Z'); // NOT advanced
    expect(kv.store.get(SEEN_KEY)).toBeUndefined(); // NOT remembered
    // And the miss is visible rather than inferred from silence.
    expect(await countAction('audit_watch_alert_undelivered')).toBe(before + 1);
    // The forensic row still lands regardless of delivery.
    expect((await latestAction('security_audit_alert'))?.target).toBeDefined();
  });

  // The no-EMAIL-binding case is a documented fail-open ('skipped', not 'failed'). Retrying can
  // never conjure a channel, so it must COMMIT rather than re-alert every tick forever — but it
  // still has to be visible, hence the undelivered row.
  it('no email binding: audits undelivered but still commits (no infinite re-alert loop)', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const before = await countAction('audit_watch_alert_undelivered');
    stubFetch([[mkEntry('2026-06-30T11:55:00Z', { id: 'evt-nomailer' })]]);

    await runAuditWatch({ ...envFor({ kv }), EMAIL: undefined } as Env, NOW);

    expect(await countAction('audit_watch_alert_undelivered')).toBe(before + 1);
    expect(kv.store.get(CURSOR_KEY)).toBe(lagCursor); // committed — no retry loop
    expect(JSON.parse(kv.store.get(SEEN_KEY) ?? '[]')).toContain('evt-nomailer');
  });

  // Holding seen-ids to retry means the next tick RE-DETECTS the same event by design. The
  // forensic insert must therefore be idempotent, or a broken mailer writes an hourly duplicate
  // security_audit_alert row into the append-only, never-pruned log — the exact bloat the
  // commented-by-default trigger removed elsewhere.
  it('retry tick: re-sends the alert but does NOT duplicate the forensic row', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const entry = mkEntry('2026-06-30T11:55:00Z', { id: 'evt-retry' });
    const broken = {
      sent: [],
      send: async () => {
        throw new Error('transport down');
      },
    };

    stubFetch([[entry]]);
    await runAuditWatch(
      envFor({ kv, email: broken as unknown as ReturnType<typeof fakeEmail> }),
      NOW,
    );
    const afterFirst = await countAction('security_audit_alert');

    // Tick 2: the mailer recovers. Same event is re-detected (seen-ids were held).
    const good = fakeEmail();
    stubFetch([[entry]]);
    await runAuditWatch(envFor({ kv, email: good }), NOW);

    expect(good.sent).toHaveLength(1); // the alert DID get retried and delivered
    expect(await countAction('security_audit_alert')).toBe(afterFirst); // but no second row
    expect(JSON.parse(kv.store.get(SEEN_KEY) ?? '[]')).toContain('evt-retry'); // now committed
  });

  // A failing FIRST tick used to persist nothing, so the next tick re-anchored 1h back from its
  // own `now` — silently leaving the gap between the two ticks unscanned by anyone.
  it('first run: persists the lookback anchor BEFORE the fetch, so a failed tick skips no window', async () => {
    const kv = fakeKV(); // no cursor -> first run
    stubFetch([[]], { status: 500 }); // the fetch fails immediately after init
    await runAuditWatch(envFor({ kv, email: fakeEmail() }), NOW);
    // The anchor survives the failure: 1h before NOW, not lost.
    expect(kv.store.get(CURSOR_KEY)).toBe(new Date(NOW.getTime() - 60 * 60_000).toISOString());
  });

  it('does not re-alert an event whose id is already remembered (lag-overlap dedup)', async () => {
    const kv = fakeKV({
      [CURSOR_KEY]: '2026-06-30T09:00:00.000Z',
      [SEEN_KEY]: JSON.stringify(['evt-dup']),
    });
    const email = fakeEmail();
    stubFetch([
      [mkEntry('2026-06-30T11:55:00Z', { id: 'evt-dup', actorEmail: 'mallory@evil.test' })],
    ]);

    await runAuditWatch(envFor({ kv, email }), NOW);

    expect(email.sent).toHaveLength(0);
    expect(await countAction('security_audit_alert')).toBe(0);
  });

  it('multiple suspicious events: one row each, a single batched email, pluralized subject', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const email = fakeEmail();
    stubFetch([
      [
        mkEntry('2026-06-30T11:50:00Z', { id: 'e1', actorEmail: 'mallory@evil.test' }),
        // A SEAL_KEY secret update — the secret NAME ("SEAL_KEY") doesn't contain the app
        // fragment, so this is only caught via the parent Worker named in newValueJson (the
        // real-API shape). A naive resource/action-only match would miss exactly this.
        mkEntry('2026-06-30T11:55:00Z', {
          id: 'e2',
          actorEmail: 'eve@evil.test',
          resourceId: 'a1b2c3d4-0000-0000-0000-000000000000',
          resourceType: 'worker_secret',
          action: 'update',
          newValueJson: { name: 'SEAL_KEY', script: 'test-app' },
        }),
      ],
    ]);

    await runAuditWatch(envFor({ kv, email }), NOW);

    expect(await countAction('security_audit_alert')).toBe(2);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.subject).toBe('⚠ test-app security alert — 2 unsanctioned changes');
  });

  it('clear window (only an allowlisted deploy): no email, no alert row, cursor advances to now−lag (NOT now)', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const email = fakeEmail();
    stubFetch([[mkEntry('2026-06-30T11:00:00Z', { actorEmail: 'ci-bot@cialdnb.com' })]]);

    await runAuditWatch(envFor({ kv, email }), NOW);

    expect(email.sent).toHaveLength(0);
    expect(await countAction('security_audit_alert')).toBe(0);
    expect(kv.store.get(CURSOR_KEY)).toBe(lagCursor);
    expect(kv.store.get(CURSOR_KEY)).not.toBe(NOW.toISOString());
  });

  it('suspicious but ALERT_EMAIL unset: still audits, sends nothing', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const email = fakeEmail();
    stubFetch([[mkEntry('2026-06-30T11:55:00Z', { actorEmail: 'mallory@evil.test' })]]);

    await runAuditWatch(envFor({ kv, email, alertEmail: undefined }), NOW);

    expect(email.sent).toHaveLength(0);
    expect(await countAction('security_audit_alert')).toBe(1);
  });

  it('HTTP error: degrades (no throw), audits audit_watch_error, does NOT advance the cursor', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const email = fakeEmail();
    stubFetch([[]], { status: 500 });

    await expect(runAuditWatch(envFor({ kv, email }), NOW)).resolves.toBeUndefined();

    expect(email.sent).toHaveLength(0);
    expect(await countAction('audit_watch_error')).toBe(1);
    expect(kv.store.get(CURSOR_KEY)).toBe('2026-06-30T09:00:00.000Z'); // unchanged → re-cover next tick
  });

  it('soft API failure (HTTP 200, success:false): degrades to audit_watch_error, cursor unchanged', async () => {
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    stubFetch([[]], { success: false });

    await runAuditWatch(envFor({ kv, email: fakeEmail() }), NOW);

    expect(await countAction('audit_watch_error')).toBe(1);
    expect(kv.store.get(CURSOR_KEY)).toBe('2026-06-30T09:00:00.000Z');
  });

  it('truncated window (>MAX_PAGES full pages): audits audit_watch_truncated and advances cursor to newest FETCHED (drains backlog), not now−lag', async () => {
    // 5 full pages of benign (non-app) entries → loop never early-breaks → truncated.
    const benignPage = (p: number) =>
      Array.from(
        { length: PER_PAGE },
        (_, i): AuditLogEntry => ({
          id: `b_${p}_${i}`,
          when: '2026-06-30T10:00:00Z',
          actor: { email: 'someone@cialdnb.com', type: 'user' },
          action: { type: 'update' },
          resource: { type: 'dns_record', id: 'unrelated.example.com' },
        }),
      );
    const pages = [1, 2, 3, 4, 5].map(benignPage);
    // Make one entry carry the newest fetched timestamp the cursor should land on.
    const lastPage = pages[4];
    if (lastPage?.[0]) lastPage[0] = { ...lastPage[0], when: '2026-06-30T11:40:00Z' };
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const { spy } = stubFetch(pages);

    await runAuditWatch(envFor({ kv, email: fakeEmail() }), NOW);

    expect(spy).toHaveBeenCalledTimes(5); // hit the MAX_PAGES cap
    expect(await countAction('audit_watch_truncated')).toBe(1);
    expect(kv.store.get(CURSOR_KEY)).toBe('2026-06-30T11:40:00.000Z'); // newest fetched, NOT now−lag
  });

  it('paginates: a full first page pulls page 2 and accumulates', async () => {
    const fullPage = Array.from(
      { length: PER_PAGE },
      (_, i): AuditLogEntry => ({
        id: `p1_${i}`,
        when: '2026-06-30T10:00:00Z',
        actor: { email: 'someone@cialdnb.com', type: 'user' },
        action: { type: 'update' },
        resource: { type: 'dns_record', id: 'unrelated.example.com' },
      }),
    );
    const page2 = [
      mkEntry('2026-06-30T11:50:00Z', { id: 'pg2-evt', actorEmail: 'mallory@evil.test' }),
    ];
    const kv = fakeKV({ [CURSOR_KEY]: '2026-06-30T09:00:00.000Z' });
    const email = fakeEmail();
    const { spy } = stubFetch([fullPage, page2]);

    await runAuditWatch(envFor({ kv, email }), NOW);

    expect(spy).toHaveBeenCalledTimes(2); // page 1 was full → fetched page 2
    expect(email.sent).toHaveLength(1); // the suspicious entry on page 2 was found
  });
});
