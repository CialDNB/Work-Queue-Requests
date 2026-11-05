import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import worker from '../../src/index';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE, cookieFor } from '../helpers/http';

const PATH = '/api/settings/alerting';
const SLACK = 'https://hooks.slack.com/services/T/B/x';

type GetBody = {
  data: {
    recipients: string[];
    slackWebhookConfigured: boolean;
    env_defaults: unknown;
  };
};

async function getAlerting(): Promise<GetBody['data']> {
  return ((await (await asUser(USERS.admin, 'GET', PATH)).json()) as GetBody).data;
}

describe('alerting settings route', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('is fail-closed: anonymous → 401', async () => {
    expect((await asUser(null, 'GET', PATH)).status).toBe(401);
  });

  it('requires settings.manage: member/viewer get a uniform 404', async () => {
    expect((await asUser(USERS.member, 'GET', PATH)).status).toBe(404);
    expect((await asUser(USERS.viewer, 'GET', PATH)).status).toBe(404);
    expect((await asUser(USERS.member, 'PUT', PATH, { recipients: [] })).status).toBe(404);
  });

  it('admin reads defaults (env-derived) before any override is set', async () => {
    const data = await getAlerting();
    expect(data.recipients).toEqual([]);
    expect(data.slackWebhookConfigured).toBe(false);
    expect(data.env_defaults).toBeDefined();
  });

  it('admin saves overrides; recipients persist, lowercase, and dedupe', async () => {
    const put = await asUser(USERS.admin, 'PUT', PATH, {
      recipients: ['Ops@cialdnb.com', 'ops@cialdnb.com', 'sec@cialdnb.com'],
      slackWebhookUrl: SLACK,
    });
    expect(put.status).toBe(200);

    const data = await getAlerting();
    expect(data.recipients).toEqual(['ops@cialdnb.com', 'sec@cialdnb.com']);
    expect(data.slackWebhookConfigured).toBe(true);
  });

  it('never returns the stored webhook URL — only whether one is set (AICOE-205)', async () => {
    await asUser(USERS.admin, 'PUT', PATH, { recipients: [], slackWebhookUrl: SLACK });
    const get = await asUser(USERS.admin, 'GET', PATH);
    const raw = await get.text();
    expect(raw).not.toContain('hooks.slack.com'); // the credential never crosses the wire
    expect(raw).not.toContain('slackWebhookUrl');
    expect((JSON.parse(raw) as GetBody).data.slackWebhookConfigured).toBe(true);
  });

  it('omitting slackWebhookUrl keeps the stored channel (read-modify-write safe)', async () => {
    await asUser(USERS.admin, 'PUT', PATH, { recipients: [], slackWebhookUrl: SLACK });
    // A client that GET-then-PUTs (no URL in the round-trip) must not wipe the channel.
    await asUser(USERS.admin, 'PUT', PATH, { recipients: ['a@cialdnb.com'] });
    const data = await getAlerting();
    expect(data.recipients).toEqual(['a@cialdnb.com']);
    expect(data.slackWebhookConfigured).toBe(true);
  });

  it('empty string or null clears the override', async () => {
    await asUser(USERS.admin, 'PUT', PATH, { recipients: [], slackWebhookUrl: SLACK });
    await asUser(USERS.admin, 'PUT', PATH, { recipients: [], slackWebhookUrl: '' });
    expect((await getAlerting()).slackWebhookConfigured).toBe(false);

    await asUser(USERS.admin, 'PUT', PATH, { recipients: [], slackWebhookUrl: SLACK });
    await asUser(USERS.admin, 'PUT', PATH, { recipients: [], slackWebhookUrl: null });
    expect((await getAlerting()).slackWebhookConfigured).toBe(false);
  });

  it('rejects a malformed email, a malformed URL, and a non-Slack webhook (400)', async () => {
    expect((await asUser(USERS.admin, 'PUT', PATH, { recipients: ['not-an-email'] })).status).toBe(
      400,
    );
    expect(
      (await asUser(USERS.admin, 'PUT', PATH, { recipients: [], slackWebhookUrl: 'not-a-url' }))
        .status,
    ).toBe(400);
    // SSRF guard: an admin cannot point the alert webhook at an arbitrary host.
    expect(
      (
        await asUser(USERS.admin, 'PUT', PATH, {
          recipients: [],
          slackWebhookUrl: 'https://evil.example/exfil',
        })
      ).status,
    ).toBe(400);
    // A rejected write leaves no override behind.
    expect((await getAlerting()).slackWebhookConfigured).toBe(false);
  });

  it('writes an audit row on update', async () => {
    await asUser(USERS.admin, 'PUT', PATH, { recipients: ['a@cialdnb.com'] });
    const rows = await env.DB.prepare(
      "SELECT actor_email FROM audit_log WHERE action = 'settings.alerting.update'",
    ).all<{ actor_email: string }>();
    expect(rows.results.length).toBeGreaterThanOrEqual(1);
    expect(rows.results[0]?.actor_email).toBe(USERS.admin);
  });
});

// Login policy (entra-only) — the toggle that switches magic links off. The test env
// (wrangler.test.jsonc) has Entra FULLY configured with two allowed tenants, so the config
// half of the guard passes here except where a test drives the worker with the secret
// removed; entraFullyEnabled itself is covered in test/auth/oidc.test.ts, and the runtime
// fail-open lives in the /auth/request tests there. The PROOF half (a completed Microsoft
// sign-in from every allowed tenant) is below; that the callback writes the row this
// proof reads is pinned through the real callback in oidc.test.ts.
describe('login settings route', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    // seedDb() does not reset app_settings (not in its TABLES) — clear the login policy so
    // each test starts from the default, whatever order the tests run in.
    await env.DB.prepare("DELETE FROM app_settings WHERE key = 'login'").run();
  });

  const LOGIN_PATH = '/api/settings/login';
  // Must match wrangler.test.jsonc's ENTRA_ALLOWED_TENANTS (synthetic, like every fixture).
  const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const FOREIGN_TENANT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  type LoginBody = {
    data: {
      entraOnly: boolean;
      entraOnlyEffective: boolean;
      entraConfigured: boolean;
      entraProven: boolean;
      entraUnprovenTenants: string[];
    };
  };
  const getLogin = async (): Promise<LoginBody['data']> =>
    ((await (await asUser(USERS.admin, 'GET', LOGIN_PATH)).json()) as LoginBody).data;
  const errorOf = async (res: Response): Promise<{ code: string; message: string }> =>
    ((await res.json()) as { error: { code: string; message: string } }).error;
  const errorCode = async (res: Response): Promise<string> => (await errorOf(res)).code;
  const policyWrites = async (): Promise<number> =>
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.login.update'",
      ).first<{ n: number }>()
    )?.n ?? 0;

  /** The payload a COMPLETED Entra sign-in from `tid` leaves (src/auth/oidc.ts). */
  const entraLogin = (tid: string): string => JSON.stringify({ method: 'entra_oidc', tid });

  /** An audit row with this payload, by default under the `login` action. */
  async function seedLoginRow(payload: string | null, action = 'login'): Promise<void> {
    await env.DB.prepare(
      'INSERT INTO audit_log (actor_email, action, payload_json) VALUES (?, ?, ?)',
    )
      .bind(USERS.member, action, payload)
      .run();
  }

  /** A completed sign-in from EVERY allowed tenant: the proof that unlocks entra-only. */
  async function proveAllTenants(): Promise<void> {
    await seedLoginRow(entraLogin(TENANT_A));
    await seedLoginRow(entraLogin(TENANT_B));
  }

  it('is fail-closed + permission-gated like every settings surface', async () => {
    expect((await asUser(null, 'GET', LOGIN_PATH)).status).toBe(401);
    expect((await asUser(USERS.member, 'GET', LOGIN_PATH)).status).toBe(404);
    expect((await asUser(USERS.viewer, 'PUT', LOGIN_PATH, { entraOnly: true })).status).toBe(404);
  });

  // Config completeness is not flow viability. The test env has Entra fully configured —
  // exactly the state an app is in when the shared registration lacks its redirect URI
  // (AADSTS50011) or the shared secret has expired: every real sign-in dies at Microsoft.
  // Enabling entra-only there would lock out every user, the admin who clicked included.
  it('REFUSES entra-only with valid config while no Microsoft sign-in has completed', async () => {
    const before = await getLogin();
    expect(before.entraConfigured).toBe(true); // the config half passes...
    expect(before.entraProven).toBe(false); // ...but nothing has proven the flow
    expect(before.entraUnprovenTenants).toEqual([TENANT_A, TENANT_B]);

    const res = await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: true });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('entra_never_completed');

    // A refusal writes nothing: no stored policy, no settings.login.update audit row.
    expect((await getLogin()).entraOnly).toBe(false);
    expect(await policyWrites()).toBe(0);
  });

  it('ALLOWS entra-only once a Microsoft sign-in has completed from every allowed tenant', async () => {
    await proveAllTenants();
    expect(await getLogin()).toMatchObject({ entraProven: true, entraUnprovenTenants: [] });
    expect((await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: true })).status).toBe(200);
    expect(await getLogin()).toMatchObject({ entraOnly: true, entraOnlyEffective: true });
  });

  // Admin consent is granted PER TENANT (runbook Part 2). A sign-in from the home tenant
  // proves the registration (redirect URI, secret), never another tenant's consent: with
  // TENANT_B unconsented, every TENANT_B user would hit AADSTS65001 at Microsoft and, with
  // magic links off, be locked out of the app.
  it('REFUSES entra-only until EVERY allowed tenant has a completed sign-in, naming the rest', async () => {
    await seedLoginRow(entraLogin(TENANT_A));
    expect(await getLogin()).toMatchObject({
      entraProven: false,
      entraUnprovenTenants: [TENANT_B],
    });

    const res = await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: true });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('entra_never_completed');
    expect(error.message).toContain(TENANT_B);
    expect(error.message).not.toContain(TENANT_A);
    expect(await policyWrites()).toBe(0);

    await seedLoginRow(entraLogin(TENANT_B));
    expect((await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: true })).status).toBe(200);
  });

  // The proof is read against the CURRENT allowlist. A row from a tenant that is not on it
  // (one removed since its users signed in) proves nothing about the tenants that are.
  it('does not count a sign-in from a tenant outside the current allowlist', async () => {
    await seedLoginRow(entraLogin(FOREIGN_TENANT));
    expect(await getLogin()).toMatchObject({
      entraProven: false,
      entraUnprovenTenants: [TENANT_A, TENANT_B],
    });
    const res = await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: true });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('entra_never_completed');
  });

  it('does not accept a near-miss as proof', async () => {
    for (const tid of [TENANT_A, TENANT_B]) {
      // a completed login from the tenant, but not Microsoft
      await seedLoginRow(JSON.stringify({ method: 'magic_link', tid }));
      // not the exact value oidc.ts writes
      await seedLoginRow(JSON.stringify({ method: 'ENTRA_OIDC', tid }));
      // right method and tenant, wrong action
      await seedLoginRow(entraLogin(tid), 'login_refused');
      await seedLoginRow(entraLogin(tid), 'settings.login.update');
    }
    await seedLoginRow('not json at all'); // unparseable — must read as "no proof", never a 500
    await seedLoginRow(`{"note":"entra_oidc from ${TENANT_A} in prose"}`); // substring, not fields
    await seedLoginRow(null); // a login row with no payload at all
    await seedLoginRow('{"method":"entra_oidc"}'); // Microsoft, but from no tenant

    expect(await getLogin()).toMatchObject({
      entraProven: false,
      entraUnprovenTenants: [TENANT_A, TENANT_B],
    });
    const res = await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: true });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('entra_never_completed');
  });

  it('keeps the CONFIG check FIRST: with SSO misconfigured the refusal is the config one, proof or not', async () => {
    // SELF is bound to the fully configured test env, so drive the real worker with the
    // secret removed — a since-removed secret is the case the config half exists for.
    const broken: Env = { ...env, ENTRA_CLIENT_SECRET: undefined };
    const callBroken = async (method: 'GET' | 'PUT', body?: unknown): Promise<Response> => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(BASE + LOGIN_PATH, {
          method,
          headers: {
            origin: BASE,
            'content-type': 'application/json',
            cookie: await cookieFor(USERS.admin),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        broken,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };
    const putBroken = (entraOnly: boolean) => callBroken('PUT', { entraOnly });

    // No proof either: the case that pins the ORDER. With the proof check first, this would
    // answer entra_never_completed ("sign in with Microsoft once") on an app whose login page
    // hides the Microsoft button, because /auth/config reports SSO as not configured.
    let res = await putBroken(true);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('entra_not_configured');

    // With proof from every tenant, still the config refusal: proof never stands in for
    // config. GET reports no proof while there is no usable allowlist to prove.
    await proveAllTenants();
    res = await putBroken(true);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('entra_not_configured');
    expect((await getLogin()).entraOnly).toBe(false);
    expect(((await (await callBroken('GET')).json()) as LoginBody).data).toEqual({
      entraOnly: false,
      entraOnlyEffective: false,
      entraConfigured: false,
      entraProven: false,
      entraUnprovenTenants: [],
    });

    // DISABLING works while SSO is misconfigured: the recovery path an admin needs exactly
    // when SSO has broken under a stored entra-only policy.
    await makeDb(env).settings.setLogin({ entraOnly: true }, USERS.owner);
    res = await putBroken(false);
    expect(res.status).toBe(200);
    expect((await getLogin()).entraOnly).toBe(false);
  });

  it('DISABLING entra-only is always allowed, proof or not', async () => {
    // From the default (off) with no proof...
    expect((await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: false })).status).toBe(200);
    // ...and from a stored ON with no proof — an app that enabled it before this guard
    // existed. The recovery path must never be gated on the thing that is broken.
    await makeDb(env).settings.setLogin({ entraOnly: true }, USERS.owner);
    expect((await getLogin()).entraProven).toBe(false);
    expect((await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: false })).status).toBe(200);
    expect((await getLogin()).entraOnly).toBe(false);
  });

  it('defaults to off, round-trips the toggle, and audits the change', async () => {
    await proveAllTenants();
    expect(await getLogin()).toEqual({
      entraOnly: false,
      entraOnlyEffective: false,
      entraConfigured: true,
      entraProven: true,
      entraUnprovenTenants: [],
    });

    expect((await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: true })).status).toBe(200);
    const after = (await (await asUser(USERS.admin, 'GET', LOGIN_PATH)).json()) as {
      data: { entraOnly: boolean; entraOnlyEffective: boolean };
    };
    expect(after.data.entraOnly).toBe(true);
    expect(after.data.entraOnlyEffective).toBe(true);

    expect((await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: false })).status).toBe(200);

    const rows = await env.DB.prepare(
      "SELECT actor_email FROM audit_log WHERE action = 'settings.login.update'",
    ).all<{ actor_email: string }>();
    expect(rows.results.length).toBe(2);
  });

  it('rejects a non-boolean body (validation, not coercion)', async () => {
    expect((await asUser(USERS.admin, 'PUT', LOGIN_PATH, { entraOnly: 'yes' })).status).toBe(400);
  });
});
