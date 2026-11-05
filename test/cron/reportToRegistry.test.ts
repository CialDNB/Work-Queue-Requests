import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { READ_LOG_VIEW_PATH, runReportToRegistry } from '../../src/cron/reportToRegistry';
import { ACTIVITY_WINDOW_DAYS } from '../../src/data/activity';
import type { Env } from '../../src/env';
import { buildManifest, MANIFEST_VERSION } from '../../src/framework/manifest';
import { READ_AUDIT_ARMED } from '../../src/framework/readAudit';
import { CHECKS_VERSION, KIT_VERSION } from '../../src/framework/version';
import { allRoutes } from '../../src/routes';
import { applySchema } from '../helpers/db';

// The registry URL is baked into the kit, so a PRODUCTION app arms with only the REGISTRY_TOKEN
// secret — no REGISTRY_URL var. Spread keeps the real bindings (D1/KV/R2) so computeHealth runs.
const REGISTRY = 'https://app-registry.cialdnb.ai';
function configured(over: Partial<Env> = {}): Env {
  return {
    ...env,
    REGISTRY_TOKEN: 't_reg_token',
    APP_NAME: 'my-app',
    MAIL_FROM_NAME: 'My App',
    APP_ENV: 'production',
    APP_BUILD_VERSION: 'deadbeef',
    ...over,
  } as Env;
}

// Synthetic AI-usage rows at a chosen age, so the trailing-30-day window can be pinned from both
// sides. `created_at` is written explicitly (the WORM triggers block UPDATE/DELETE, not INSERT).
const SPENDER = 'spender@test.example';
async function seedAiUsage(rows: { costUsd: number; agoDays: number }[]): Promise<void> {
  for (const row of rows) {
    await env.DB.prepare(
      "INSERT INTO ai_usage (actor_email, model, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, 'claude-sonnet-4-6', 10, 10, ?, datetime('now', ?))",
    )
      .bind(SPENDER, row.costUsd, `-${row.agoDays} days`)
      .run();
  }
}

// A fetcher that records the call and returns a canned Response.
function captureFetcher(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, data: {} }), { status });
  });
  return { fetcher, calls };
}

describe('report_to_registry cron', () => {
  beforeAll(applySchema);

  it('is dormant (no fetch) without a token, or in a non-reporting env with no explicit URL', async () => {
    const { fetcher, calls } = captureFetcher();
    // Pin the TOKEN gate by name: `{...env}` is APP_ENV 'test' AND tokenless, so a loose /skipped/
    // here would still pass with the token check deleted entirely.
    expect(await runReportToRegistry({ ...env } as Env, fetcher)).toMatch(
      /skipped: REGISTRY_TOKEN not set/,
    );
    expect(await runReportToRegistry(configured({ REGISTRY_TOKEN: undefined }), fetcher)).toMatch(
      /skipped: REGISTRY_TOKEN not set/,
    );
    // test/development never POST into the fleet catalogue off the baked-in URL — a local
    // `wrangler dev` run or a test must not appear in the registry.
    for (const APP_ENV of ['test', 'development'] as const) {
      expect(await runReportToRegistry(configured({ APP_ENV }), fetcher)).toMatch(
        /skipped: env does not report/,
      );
    }
    expect(calls.length).toBe(0);
  });

  it('a STAGING app reports to the baked-in registry too, env-qualifying source_key', async () => {
    // Most kit apps live in staging for months; a prod-only registry cannot see most of the
    // fleet. Safe because source_key is env-qualified, so this never clobbers the prod row.
    const { fetcher, calls } = captureFetcher();
    const result = await runReportToRegistry(configured({ APP_ENV: 'staging' }), fetcher);
    expect(result).toMatch(/reported to registry/);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`${REGISTRY}/api/apps/ingest`);
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      source_key: string;
      name: string;
      status: { env: string };
    };
    expect(body.source_key).toBe('my-app-staging');
    expect(body.status.env).toBe('staging');
    // The HUMAN-facing field must differ too: appDisplayName strips "(staging)" for the login UI,
    // so without qualifying here both rows would list as the identical "My App".
    expect(body.name).toBe('My App (staging)');
  });

  it('a production app reports to the BAKED-IN registry with only the token (no REGISTRY_URL var)', async () => {
    const { fetcher, calls } = captureFetcher();
    const detail = await runReportToRegistry(configured(), fetcher);
    expect(detail).toMatch(/reported to registry: health=/);
    expect(calls.length).toBe(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`${REGISTRY}/api/apps/ingest`); // the kit default, no per-app var needed
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t_reg_token');
    const body = JSON.parse(init.body as string) as {
      source_key: string;
      name: string;
      status: {
        env: string;
        build_version: string;
        kit_version: string;
        health: string;
        maturity_mode: string;
      };
      manifest: {
        manifest_version: number;
        kit_version: string;
        checks_version: string;
        permissions: Record<string, string[]>;
        routes: {
          method: string;
          path: string;
          permission: string;
          needs: string[] | null;
        }[];
      };
    };
    expect(body.source_key).toBe('my-app'); // prod → bare app name
    expect(body.name).toBe('My App');
    expect(body.status.env).toBe('production');
    expect(body.status.build_version).toBe('deadbeef');
    expect(body.status.kit_version).toBe(KIT_VERSION); // the stamp the registry tracks lag on
    expect(['ok', 'degraded', 'unhealthy']).toContain(body.status.health);
    expect(['incubating', 'stable']).toContain(body.status.maturity_mode); // AICOE-354 lifecycle
    // The governance manifest (AICOE-356): the ontology slice, no per-route input schemas.
    expect(body.manifest.kit_version).toBe(KIT_VERSION);
    // …and the CI-gate stamp, which the hand-built projection used to drop — a field buildManifest
    // computes but governanceManifest never listed, so the whole fleet reported it as NULL.
    expect(body.manifest.checks_version).toBe(CHECKS_VERSION);
    expect(body.manifest.routes.length).toBeGreaterThan(0);
    expect(body.manifest.routes.every((r) => !('input_schema' in r))).toBe(true); // slice, not full
    expect(body.manifest.permissions['notes.read']).toBeDefined(); // a known kit permission
    expect(body.manifest.routes.some((r) => r.path === '/api/notes')).toBe(true);
    // …and the per-route repository set rides along: "which route can touch which table" is
    // exactly the governance question the registry's app_manifest table exists to answer.
    // Undeclared stays null (unscoped — the whole data layer), never flattened to [].
    const notes = body.manifest.routes.find((r) => r.method === 'GET' && r.path === '/api/notes');
    expect(notes?.needs).toEqual(['notes']);
    const meta = body.manifest.routes.find((r) => r.path === '/api/meta/manifest');
    expect(meta?.needs).toBeNull();
    expect(body.manifest.routes.every((r) => 'needs' in r)).toBe(true);
  });

  it('the governance slice carries exactly its declared keys — a projection cannot drop one silently', async () => {
    // The pin `checks_version` needed and did not have. governanceManifest hand-builds an object
    // literal, so its type is INFERRED from itself: a field added to AppManifest and not listed
    // there compiles clean and quietly reports NULL fleet-wide, which is exactly what happened
    // between #199 and AICOE-571. Two-way, like the status and payload pins — extra keys are a
    // wire-contract change the registry never agreed to, missing keys are the silent drop.
    const { fetcher, calls } = captureFetcher();
    await runReportToRegistry(configured(), fetcher);
    const { manifest } = JSON.parse(calls[0]!.init.body as string) as {
      manifest: Record<string, unknown>;
    };
    const known = [
      'manifest_version',
      'kit_version',
      'checks_version',
      'roles',
      'permissions',
      'audit_actions',
      'agent_exposed',
      'agent_client_egress',
      'routes',
    ];
    expect(Object.keys(manifest).sort()).toEqual([...known].sort());
    // And the documented drops stay dropped — `app` duplicates source_key/name/status, and
    // input_schema is the bulk of the manifest the slice exists to shed.
    for (const dropped of ['app', 'generated_at']) {
      expect(manifest).not.toHaveProperty(dropped);
    }
  });

  it('the slice is the FULL manifest minus exactly the documented drops — at BOTH levels', async () => {
    // The runtime twin of the declared types on governanceManifest (GovernanceManifest / GovRoute,
    // both derived by Omit). The types make a missed field a compile error; this makes it a red
    // test as well, and it is the half that still holds for anyone reading the JSON rather than
    // the source. Unlike the containment pin above — which lists the kept keys and so passes
    // untouched when a field is added to AppManifest — the expectation here is DERIVED from a live
    // buildManifest, so a new field fails unless it is either sent or deliberately named a drop.
    //
    // The drop lists are re-stated here rather than imported ON PURPOSE: dropping a field from the
    // fleet's governance report is a wire-contract decision, and it should cost an edit to a test
    // that says so, not just an edit to the type it is derived from.
    const { fetcher, calls } = captureFetcher();
    await runReportToRegistry(configured(), fetcher);
    const { manifest } = JSON.parse(calls[0]!.init.body as string) as {
      manifest: Record<string, unknown> & { routes: Record<string, unknown>[] };
    };
    const full = buildManifest(configured(), allRoutes);

    const DROPPED_TOP = ['app'];
    expect(Object.keys(manifest).sort()).toEqual(
      Object.keys(full)
        .filter((k) => !DROPPED_TOP.includes(k))
        .sort(),
    );

    // …and one level DOWN, where the containment pin above does not reach at all. The per-route
    // .map() had the same inference hole as the top level and needed its own declared type; a pin
    // on the outer keys would have looked like protection while the route projection stayed open.
    const DROPPED_ROUTE = ['summary', 'rate_limited', 'agent', 'machine', 'input_schema'];
    // The UNION over every full route, not route[0]'s keys: sampling one route would let a field
    // that only some routes carry pass unnoticed, which is the same "looks checked" failure this
    // whole change exists to remove.
    const fullRouteKeys = new Set(full.routes.flatMap((r) => Object.keys(r)));
    expect(fullRouteKeys.size).toBeGreaterThan(0); // never vacuous — the registry has routes
    const expectedRouteKeys = [...fullRouteKeys].filter((k) => !DROPPED_ROUTE.includes(k)).sort();
    expect(expectedRouteKeys).toEqual(['audit', 'method', 'needs', 'path', 'permission']);
    const routeShapes = new Set(manifest.routes.map((r) => Object.keys(r).sort().join(',')));
    expect([...routeShapes]).toEqual([expectedRouteKeys.join(',')]);

    // `summary` is prose and stays dropped. `rate_limited` is a KNOWN, DEFERRED gap — genuinely
    // governance ("which write routes are unthrottled?"), which the fleet therefore cannot answer
    // at all — held back only because a per-route field multiplies by route count and the registry
    // has to agree to ingest it (DECISIONS 2026-08-20). This asserts TODAY's wire contract; the
    // coordinated kit+registry pair flips it deliberately, alongside a MANIFEST_VERSION bump.
    expect(manifest.routes.every((r) => !('rate_limited' in r) && !('summary' in r))).toBe(true);
    // `agent` is the same kind of deferred per-route drop (manifest_version 3): the registry has
    // no per-route field for it yet. The fleet gets the two top-level counts instead.
    expect(manifest.routes.every((r) => !('agent' in r))).toBe(true);
    expect([manifest.agent_exposed, manifest.agent_client_egress]).toEqual([0, 0]);
    // `machine` (manifest_version 4, B9) is deferred on the same terms as `rate_limited`: the
    // registry's ingest schema would strip it, so it waits for its kit+registry pair.
    expect(manifest.routes.every((r) => !('machine' in r))).toBe(true);
  });

  it('the registry slice has its OWN recorded shape, keyed to MANIFEST_VERSION', async () => {
    // The slice is IN SCOPE of manifest_version, and this pin is why that claim is worth
    // something. Two of the three shapes that shipped as `manifest_version: 2` differed only
    // here — in what the daily report SENT — not in buildManifest's output, so a version that
    // tracked only the builder would have called all three identical and reproduced the exact
    // ambiguity it exists to end. Adding `rate_limited`, `agent` or `machine` (the deferred
    // kit+registry pairs) changes nothing in AppManifest and everything on the wire; it trips THIS
    // assertion, which is what forces the next bump (5 — 3 shipped with the agent exposure and 4
    // with B9's `machine`).
    //
    // Append-only, same rule as SHAPES in test/framework/manifest.test.ts: record entry 5, never
    // widen entry 4. A shipped entry states what the fleet was actually sent under that number.
    const SLICE_SHAPES: Record<number, { top: string[]; route: string[] }> = {
      2: {
        top: [
          'audit_actions',
          'checks_version',
          'kit_version',
          'manifest_version',
          'permissions',
          'roles',
          'routes',
        ],
        route: ['audit', 'method', 'needs', 'path', 'permission'],
      },
      // 3: the agent exposure COUNTS are sent; the per-route `agent` block is a deferred drop.
      3: {
        top: [
          'agent_client_egress',
          'agent_exposed',
          'audit_actions',
          'checks_version',
          'kit_version',
          'manifest_version',
          'permissions',
          'roles',
          'routes',
        ],
        route: ['audit', 'method', 'needs', 'path', 'permission'],
      },
      // 4 added `machine` to the BUILDER's routes (test/framework/manifest.test.ts) and drops it
      // here (DroppedRouteField), so what the fleet is sent is byte-for-byte the shape of 3.
      4: {
        top: [
          'agent_client_egress',
          'agent_exposed',
          'audit_actions',
          'checks_version',
          'kit_version',
          'manifest_version',
          'permissions',
          'roles',
          'routes',
        ],
        route: ['audit', 'method', 'needs', 'path', 'permission'],
      },
    };
    const HINT =
      '\nTHE REGISTRY SLICE CHANGED SHAPE. manifest_version covers every published projection, ' +
      'the slice included (see its comment in src/framework/manifest.ts), so: bump ' +
      'MANIFEST_VERSION, append to its version log, and ADD a new entry to SLICE_SHAPES here ' +
      'and to SHAPES in test/framework/manifest.test.ts. Do not edit a shipped entry.';

    const shape = SLICE_SHAPES[MANIFEST_VERSION];
    expect(shape, HINT).toBeDefined();
    if (!shape) return;
    const { fetcher, calls } = captureFetcher();
    await runReportToRegistry(configured(), fetcher);
    const { manifest } = JSON.parse(calls[0]!.init.body as string) as {
      manifest: Record<string, unknown> & { routes: Record<string, unknown>[] };
    };
    expect(Object.keys(manifest).sort(), HINT).toEqual([...shape.top].sort());
    const routeShapes = new Set(manifest.routes.map((r) => Object.keys(r).sort().join(',')));
    expect([...routeShapes], HINT).toEqual([[...shape.route].sort().join(',')]);
  });

  it('an explicit REGISTRY_URL overrides the default AND opts a non-reporting env in, env-qualifying source_key', async () => {
    // Uses 'development' deliberately: staging now reports off the baked-in URL, so testing the
    // escape hatch with staging would prove nothing about opting a SILENT env in — it would pass
    // even if `explicit` were checked only for envs already in REPORTING_ENVS.
    const { fetcher, calls } = captureFetcher();
    await runReportToRegistry(
      configured({ APP_ENV: 'development', REGISTRY_URL: 'https://registry.example' }),
      fetcher,
    );
    expect(calls[0]!.url).toBe('https://registry.example/api/apps/ingest');
    const body = JSON.parse(calls[0]!.init.body as string) as {
      source_key: string;
      status: { env: string };
    };
    // Env-qualified so a non-prod report never collides with the prod 'my-app' row.
    expect(body.source_key).toBe('my-app-development');
    expect(body.status.env).toBe('development');
  });

  it('an explicit REGISTRY_URL still overrides the baked-in default for a REPORTING env', async () => {
    const { fetcher, calls } = captureFetcher();
    await runReportToRegistry(
      configured({ APP_ENV: 'staging', REGISTRY_URL: 'https://registry.example' }),
      fetcher,
    );
    expect(calls[0]!.url).toBe('https://registry.example/api/apps/ingest');
  });

  it('a REGISTRY_URL of only slashes DISARMS — never falls back to the fleet registry', async () => {
    // "Report elsewhere" must not silently become "report to the baked-in fleet registry": that
    // would ship the bearer token + full governance manifest to the host they pointed away from.
    const { fetcher, calls } = captureFetcher();
    for (const REGISTRY_URL of ['/', '//']) {
      expect(
        await runReportToRegistry(configured({ APP_ENV: 'staging', REGISTRY_URL }), fetcher),
      ).toMatch(/skipped: REGISTRY_URL is set but empty/);
    }
    expect(calls.length).toBe(0);
  });

  it('an empty/whitespace REGISTRY_URL means UNSET, not a broken override', async () => {
    // `.dev.vars.example` ships `REGISTRY_URL=` empty, so blank is the normal "not configured"
    // state — it must fall back to the baked-in default, not disarm a real deployment.
    const { fetcher, calls } = captureFetcher();
    for (const REGISTRY_URL of ['', '   ']) {
      expect(
        await runReportToRegistry(configured({ APP_ENV: 'staging', REGISTRY_URL }), fetcher),
      ).toMatch(/reported to registry/);
    }
    expect(calls.every((c) => c.url === `${REGISTRY}/api/apps/ingest`)).toBe(true);
  });

  it('never double-suffixes the display name when MAIL_FROM_NAME already carries the env marker', async () => {
    // appDisplayName strips only '(staging)'/'(test)', so a '(development)' marker survives it.
    const { fetcher, calls } = captureFetcher();
    await runReportToRegistry(
      configured({
        APP_ENV: 'development',
        MAIL_FROM_NAME: 'My App (development)',
        REGISTRY_URL: 'https://registry.example',
      }),
      fetcher,
    );
    const body = JSON.parse(calls[0]!.init.body as string) as { name: string };
    expect(body.name).toBe('My App (development)'); // not 'My App (development) (development)'
  });

  it('disarms (skips, no fetch) when an explicit REGISTRY_URL is not https — token must not go cleartext', async () => {
    const { fetcher, calls } = captureFetcher();
    expect(
      await runReportToRegistry(configured({ REGISTRY_URL: 'http://registry.example' }), fetcher),
    ).toMatch(/skipped: REGISTRY_URL is not https/);
    expect(await runReportToRegistry(configured({ REGISTRY_URL: 'not-a-url' }), fetcher)).toMatch(
      /skipped/,
    );
    expect(calls.length).toBe(0);
  });

  it('strips a trailing slash on an explicit REGISTRY_URL', async () => {
    const { fetcher, calls } = captureFetcher();
    await runReportToRegistry(configured({ REGISTRY_URL: 'https://registry.example/' }), fetcher);
    expect(calls[0]!.url).toBe('https://registry.example/api/apps/ingest');
  });

  it('is best-effort: a non-2xx registry response is reported, not thrown', async () => {
    const { fetcher } = captureFetcher(503);
    const detail = await runReportToRegistry(configured(), fetcher);
    expect(detail).toBe('reported to registry: HTTP 503'); // no throw
  });

  // ---- fleet AI-spend tripwire: ONE scalar, no per-user attribution ----
  // The seeding test runs LAST on purpose: nothing above it should have to care whether this
  // file's storage rolls back between tests.

  it('an app with NO ai_usage rows reports ai_spend_30d as 0 — not null, not a missing key', async () => {
    // The fleet-wide read only works if silence is a number. A null or an absent key would make
    // "this app spends nothing" indistinguishable from "this app is not reporting spend yet".
    const { fetcher, calls } = captureFetcher();
    await runReportToRegistry(configured(), fetcher);
    const { status } = JSON.parse(calls[0]!.init.body as string) as {
      status: Record<string, unknown>;
    };
    expect(status.ai_spend_30d).toBe(0);
    expect(typeof status.ai_spend_30d).toBe('number');
  });

  it('the status object keeps every existing key and gains exactly ai_spend_30d and read_audit', async () => {
    const { fetcher, calls } = captureFetcher();
    await runReportToRegistry(configured(), fetcher);
    const { status } = JSON.parse(calls[0]!.init.body as string) as {
      status: Record<string, unknown>;
    };
    // Two-way containment rather than a flat equality: backup_age_hours / heartbeat_age_hours go
    // through numeric(), so JSON.stringify DROPS them when this app has no backup/heartbeat yet.
    // Containment still catches both regressions that matter — a dropped/renamed key, and a field
    // the registry never agreed to ingest.
    const known = [
      'env',
      'build_version',
      'kit_version',
      'health',
      'backup_age_hours',
      'heartbeat_age_hours',
      'maturity_mode',
      'ai_spend_30d',
      'read_audit',
    ];
    expect(Object.keys(status).filter((k) => !known.includes(k))).toEqual([]);
    // The other direction. Everything except the two numeric()-droppable ages is unconditionally
    // present, so all of them belong here — a presence loop that omits the newest key cannot
    // catch the regression it exists to catch, which is the same silent-drop bug this PR fixes
    // one field over in governanceManifest.
    for (const key of known.filter(
      (k) => k !== 'backup_age_hours' && k !== 'heartbeat_age_hours',
    )) {
      expect(status).toHaveProperty(key);
    }
  });

  it('read_audit STATES whether this app armed read attribution — false unset, true when armed', async () => {
    // AICOE-571. The registry used to infer arming from the presence of `activity_url`, which K1
    // made universal while READ_AUDIT ships off — so every fork read as armed-but-silent. The
    // truth is a boolean on the wire, sourced from the same `readAuditArmed` predicate the
    // framework branches on, so the report and the runtime can never disagree.
    // The default fleet state: unset ⇒ a present, explicit `false`. Not undefined — an absent key
    // is indistinguishable from an older kit that cannot answer, which is the ambiguity that
    // seeded the alert rule fleet-wide in the first place.
    const unarmed = (await report()).status;
    expect(unarmed.read_audit).toBe(false);
    expect('read_audit' in unarmed).toBe(true);

    // Armed ⇒ true, and a BOOLEAN rather than the raw var: the registry stores a boolean, so the
    // collapse happens here rather than exporting the kit's arming vocabulary into its schema.
    const armed = (await report({ READ_AUDIT: READ_AUDIT_ARMED })).status;
    expect(armed.read_audit).toBe(true);
    expect(typeof armed.read_audit).toBe('boolean');

    // Near-miss values ('ON', 'true', '1', …) are NOT re-asserted here. They are the predicate's
    // business and test/framework/read-audit.test.ts pins them directly; re-proving a string
    // comparison through a full report cycle would cost five more computeHealth + digest +
    // migrations runs to test something this file does not own. What this file owns is that the
    // report calls that predicate and serializes its result — which the two cases above pin.
  });

  it('ai_spend_30d sums cost_usd inside the trailing 30 days, excludes older rows, and carries no actor', async () => {
    const { fetcher, calls } = captureFetcher();
    await seedAiUsage([
      { costUsd: 0.25, agoDays: 0 },
      { costUsd: 0.1, agoDays: 29 }, // inside the window
      { costUsd: 99, agoDays: 40 }, // outside it — a stale bill must not read as today's
    ]);
    await runReportToRegistry(configured(), fetcher);
    const body = calls[0]!.init.body as string;
    const { status } = JSON.parse(body) as { status: { ai_spend_30d: number } };
    // Exact, not toBeCloseTo: 0.25 + 0.1 drifts to 0.35000000000000003 in float, and the repo
    // rounds it away so the same spend reports the same number every day.
    expect(status.ai_spend_30d).toBe(0.35);
    // The privacy invariant this design rests on: the scalar leaves, the spender does not.
    expect(body).not.toContain(SPENDER);
    expect(body).not.toContain('actor_email');
  });
});

// ---- FLEET LEDGER blocks (K1): activity digests, migrations ledger, the deep link -----------
// Every one of these is OPTIONAL FOREVER on the registry side. The kit half of that contract is
// that a block whose read fails is omitted and the rest of the report still goes.

interface LedgerPayload {
  source_key: string;
  status: Record<string, unknown>;
  manifest: Record<string, unknown>;
  activity?: {
    day: string;
    stream: string;
    events: number;
    actors: number;
    top?: { name: string; count: number }[];
    anomalies?: string[];
  }[];
  migrations?: {
    count: number;
    names_hash: string;
    schema_hash?: string;
    applied: { name: string; applied_at?: string }[];
  };
  activity_url?: string;
  activity_upstream?: {
    day: string;
    stream: string;
    events: number;
    actors: number;
    top?: { name: string; count: number }[];
    anomalies?: string[];
  }[];
}

const READER = 'reader@test.example';

/** wrangler's own bookkeeping table — the kit never creates it, which is why it is faked here. */
async function fakeWranglerMigrations(names: string[]): Promise<void> {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  ).run();
  for (const name of names) {
    await env.DB.prepare('INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)').bind(name).run();
  }
}

async function report(over: Partial<Env> = {}): Promise<LedgerPayload> {
  const { fetcher, calls } = captureFetcher();
  await runReportToRegistry(configured(over), fetcher);
  return JSON.parse(calls[0]!.init.body as string) as LedgerPayload;
}

describe('report_to_registry — Fleet Ledger blocks', () => {
  beforeAll(applySchema);

  it('the payload gains exactly activity, migrations, activity_url and activity_upstream — nothing else', async () => {
    const body = await report();
    // `activity_upstream` is the one block today's registry has not agreed to ingest, and it is
    // safe to send because that registry STRIPS an unknown key — pinned below against a mirror of
    // its ingest schema. Nothing else may join it without the same argument.
    const known = [
      'source_key',
      'name',
      'status',
      'manifest',
      'activity',
      'migrations',
      'activity_url',
      'activity_upstream',
    ];
    expect(Object.keys(body).filter((k) => !known.includes(k))).toEqual([]);
    expect(body.activity).toBeDefined();
    expect(body.migrations).toBeDefined();
    expect(body.activity_url).toBeDefined();
  });

  it('the blocks are SIBLINGS of manifest — buildManifest stays pure and I/O-free', async () => {
    // The manifest is documented as pure and deterministic (no clock, no I/O) so it is
    // snapshot-testable and GET /api/meta/manifest costs no database work. Folding three
    // aggregate reads into it would break both at once.
    const body = await report();
    for (const key of ['activity', 'migrations', 'activity_url', 'activity_upstream']) {
      expect(body.manifest).not.toHaveProperty(key);
    }
  });

  it('every activity row is inside the bounds the registry enforces on one report', async () => {
    // 40 rows, 20 top entries, 20 anomalies, a real calendar day that is not in the future, and
    // (day, stream) unique — a duplicate pair is REPLACED rather than summed on the registry
    // side, so a violation would silently understate this app's volume instead of erroring.
    const body = await report();
    const rows = body.activity ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(40);
    const pairs = rows.map((r) => `${r.day}/${r.stream}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    const today = new Date().toISOString().slice(0, 10);
    for (const r of rows) {
      expect(['writes', 'reads_d1', 'reads_aurora', 'auth', 'ai']).toContain(r.stream);
      expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${r.day}T00:00:00Z`).toISOString().slice(0, 10)).toBe(r.day);
      expect(r.day <= today).toBe(true);
      expect(Number.isInteger(r.events) && r.events >= 0).toBe(true);
      expect(Number.isInteger(r.actors) && r.actors >= 0).toBe(true);
      expect(r.top?.length ?? 0).toBeLessThanOrEqual(20);
      expect(r.anomalies?.length ?? 0).toBeLessThanOrEqual(20);
    }
    // All FIVE streams now that `read_log.kind` ships (K2b): 7 days × 5 = 35, which is why the
    // window is seven and not eight — eight would sit exactly on the registry's 40-row cap with
    // no headroom for a sixth stream.
    expect(rows).toHaveLength(ACTIVITY_WINDOW_DAYS * 5);
  });

  it('a fresh app with no d1_migrations reports a truthful empty ledger plus a schema fingerprint', async () => {
    // A brand-new fork has never run `wrangler d1 migrations apply`, so the table is absent —
    // and this is also every test run. `count: 0` is the true answer, and it is SAFE: the
    // registry only records a change for names it has never seen, so an empty list can never
    // fabricate a migration event. The schema hash still ships, which is what establishes the
    // drift baseline on day one instead of a week later.
    await env.DB.prepare('DROP TABLE IF EXISTS d1_migrations').run();
    const { migrations } = await report();
    expect(migrations?.count).toBe(0);
    expect(migrations?.applied).toEqual([]);
    expect(migrations?.names_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations?.schema_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports wrangler’s applied migrations by NAME, with a count and a rename-sensitive hash', async () => {
    await fakeWranglerMigrations(['0001_read_log.sql', '0002_something.sql']);
    try {
      const { migrations } = await report();
      expect(migrations?.count).toBe(2);
      expect(migrations?.applied.map((m) => m.name)).toEqual([
        '0001_read_log.sql',
        '0002_something.sql',
      ]);
      expect(migrations?.applied.every((m) => typeof m.applied_at === 'string')).toBe(true);
      // Migration names are FILE names. Nothing here is SQL, and nothing here is a value.
      expect(JSON.stringify(migrations)).not.toContain('CREATE');
      expect(JSON.stringify(migrations)).not.toContain('SELECT');
    } finally {
      await env.DB.prepare('DROP TABLE IF EXISTS d1_migrations').run();
    }
  });

  it('caps applied at the registry’s 50, keeping the NEWEST names and an honest total', async () => {
    await fakeWranglerMigrations(
      Array.from({ length: 55 }, (_, i) => `${String(i + 1).padStart(4, '0')}_m.sql`),
    );
    try {
      const { migrations } = await report();
      expect(migrations?.count).toBe(55); // the total is not truncated, only the list is
      expect(migrations?.applied).toHaveLength(50);
      expect(migrations?.applied[0]?.name).toBe('0006_m.sql');
      expect(migrations?.applied.at(-1)?.name).toBe('0055_m.sql');
    } finally {
      await env.DB.prepare('DROP TABLE IF EXISTS d1_migrations').run();
    }
  });

  it('activity_url deep-links to THIS app’s own read-log page on its dashboard host', async () => {
    // The registry stores volumes; "who read record X" is answered inside the app that owns the
    // data. Without this link the console has no way to reach per-record attribution and would
    // have to guess a host convention the kit never agreed to.
    const body = await report({ DASHBOARD_HOST: 'acme.cialdnb.ai' });
    expect(body.activity_url).toBe(`https://acme.cialdnb.ai${READ_LOG_VIEW_PATH}`);
    expect(body.activity_url!.length).toBeLessThanOrEqual(500);
  });

  it('tolerates a DASHBOARD_HOST that was written as a full URL', async () => {
    // Every other URL-shaped var in the kit is a full URL, so writing one here is a plausible
    // mistake — and one nothing else would catch: the registry stores activity_url as a plain
    // string with no URL validation, so `https://https://…` sails through and renders as a dead
    // link in the console for as long as the app keeps reporting it.
    for (const DASHBOARD_HOST of ['https://acme.cialdnb.ai', 'http://acme.cialdnb.ai/']) {
      const body = await report({ DASHBOARD_HOST });
      expect(body.activity_url).toBe(`https://acme.cialdnb.ai${READ_LOG_VIEW_PATH}`);
    }
  });

  it('omits activity_url rather than publishing a hostless link', async () => {
    const body = await report({ DASHBOARD_HOST: '   ' });
    expect(body.activity_url).toBeUndefined();
    expect(body.status).toBeDefined(); // and the rest of the report is unaffected
  });

  it('OMITS a block whose read fails, and still reports status and manifest', async () => {
    // The failure mode this prevents: one broken aggregate taking down an app's entire daily
    // report, which presents to an operator as the app going dark rather than as a missing chart.
    await env.DB.prepare('DROP TABLE IF EXISTS read_log').run();
    try {
      const body = await report();
      expect(body.activity).toBeUndefined();
      expect(body.status).toBeDefined();
      expect(body.manifest).toBeDefined();
      expect(body.migrations).toBeDefined(); // independently omissible — this one still read fine
    } finally {
      await applySchema();
    }
  });

  it('degrades to the pre-ledger payload shape when nothing optional can be reported', async () => {
    // The compatibility floor: with the digests unreadable and no dashboard host, what leaves is
    // the report the registry has accepted since before any of this existed. `migrations` stays
    // because it is built to be unfailable — see src/data/meta.ts — not because it got lucky.
    await env.DB.prepare('DROP TABLE IF EXISTS read_log').run();
    try {
      const { fetcher, calls } = captureFetcher();
      const detail = await runReportToRegistry(configured({ DASHBOARD_HOST: '' }), fetcher);
      expect(detail).toMatch(/reported to registry: health=/);
      const body = JSON.parse(calls[0]!.init.body as string) as LedgerPayload;
      expect(body.activity).toBeUndefined();
      expect(body.activity_url).toBeUndefined();
      expect(
        Object.keys(body).filter(
          (k) => !['source_key', 'name', 'status', 'manifest', 'migrations'].includes(k),
        ),
      ).toEqual([]);
    } finally {
      await applySchema();
    }
  });

  // ---- THE UPSTREAM STREAM (PIA C15): counted, and sent where the registry cannot choke on it --

  it('reads_upstream rides activity_upstream — never activity[], never folded into reads_aurora', async () => {
    await env.DB.prepare(
      `INSERT INTO read_log (id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, target, row_count)
       VALUES ('up1','req-up',?,'my-app','test','GET /api/reports/:ticketKey/data','upstream','autobahn','client',NULL,'report_datablocks','ticket_key',1)`,
    )
      .bind(READER)
      .run();
    try {
      const body = await report();
      const today = new Date().toISOString().slice(0, 10);
      // activity[] is exactly what it was: five pinned streams, 35 rows, no upstream anywhere.
      expect(body.activity).toHaveLength(ACTIVITY_WINDOW_DAYS * 5);
      expect(body.activity?.some((r) => r.stream === 'reads_upstream')).toBe(false);
      expect(
        body.activity?.find((r) => r.stream === 'reads_aurora' && r.day === today)?.events,
      ).toBe(0);
      // …and the upstream read is counted, in its own block, one row per day of the window.
      expect(body.activity_upstream).toHaveLength(ACTIVITY_WINDOW_DAYS);
      expect(body.activity_upstream?.every((r) => r.stream === 'reads_upstream')).toBe(true);
      const up = body.activity_upstream?.find((r) => r.day === today);
      expect(up).toMatchObject({ events: 1, actors: 1 });
      expect(up?.top).toEqual([{ name: 'autobahn.report_datablocks', count: 1 }]);
    } finally {
      await env.DB.prepare('DELETE FROM read_log').run();
    }
  });

  // THE COMPATIBILITY PIN. A mirror of the registry's ingest schema as it stands (CialDNB/
  // app-registry src/routes/apps.ts, POST /api/apps/ingest): a plain z.object — Zod STRIPS unknown
  // keys by default, which that file pins with "ingest STRIPS unknown keys rather than rejecting
  // them" — whose `activity` is an array of at most 40 rows over a z.enum of exactly five streams,
  // one row per (day, stream). If this payload failed it, the whole daily report would 400.
  it('the payload parses under the registry’s current ingest schema, which strips activity_upstream', async () => {
    const registryIngest = z.object({
      source_key: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
      activity: z
        .array(
          z.object({
            day: z.string(),
            stream: z.enum(['writes', 'reads_d1', 'reads_aurora', 'auth', 'ai']),
            events: z.number().int().nonnegative(),
            actors: z.number().int().nonnegative(),
            top: z
              .array(z.object({ name: z.string().max(120), count: z.number().int() }))
              .max(20)
              .optional(),
            anomalies: z.array(z.string().max(64)).max(20).optional(),
          }),
        )
        .max(40)
        .refine((rows) => new Set(rows.map((r) => `${r.day}/${r.stream}`)).size === rows.length)
        .optional(),
      activity_url: z.string().max(500).optional(),
    });
    await env.DB.prepare(
      `INSERT INTO read_log (id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, target, row_count)
       VALUES ('up2','req-up',?,'my-app','test','GET /api/x','upstream','autobahn','client',NULL,'report_datablocks','ticket_key',NULL)`,
    )
      .bind(READER)
      .run();
    try {
      const body = await report();
      expect(body.activity_upstream).toBeDefined();
      const parsed = registryIngest.safeParse(body);
      expect(parsed.success).toBe(true);
      expect(parsed.data).not.toHaveProperty('activity_upstream');
      // …while the upstream digest itself would fit the same row schema, so a registry that
      // learns the block can reuse its validation as it stands.
      const rowSchema = registryIngest.shape.activity.unwrap().element;
      for (const r of body.activity_upstream ?? []) {
        expect(rowSchema.safeParse({ ...r, stream: 'reads_aurora' }).success).toBe(true);
      }
    } finally {
      await env.DB.prepare('DELETE FROM read_log').run();
    }
  });

  it('omits activity_upstream on a database without 0005, and the rest of the report is unchanged', async () => {
    await env.DB.prepare('DROP TABLE read_log').run();
    await env.DB.prepare(
      `CREATE TABLE read_log (
         id TEXT PRIMARY KEY, request_id TEXT NOT NULL, principal TEXT NOT NULL, app TEXT NOT NULL,
         env TEXT NOT NULL, route TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'aurora' CHECK (kind IN ('aurora', 'd1')),
         source TEXT NOT NULL, source_class TEXT NOT NULL, view TEXT, query_name TEXT, target TEXT,
         row_count INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
         CHECK (kind = 'd1' OR (view IS NOT NULL AND query_name IS NOT NULL)))`,
    ).run();
    try {
      const body = await report();
      expect(body.activity_upstream).toBeUndefined();
      expect(body.activity).toHaveLength(ACTIVITY_WINDOW_DAYS * 5);
    } finally {
      await env.DB.prepare('DROP TABLE read_log').run();
      await applySchema();
    }
  });

  // ---- THE PRIVACY INVARIANT, PINNED ON THE PAYLOAD ITSELF ---------------------------------

  it('NO actor email and NO record identifier reaches the registry, on any block', async () => {
    // The absolute line the whole Fleet Ledger rests on, and the reason it is asserted over the
    // SERIALIZED payload rather than field by field: a new field carrying an identity fails this
    // the day it is added. The kit already holds this line for ai_spend_30d — one scalar, no
    // per-user breakdown to leak; digests inherit it explicitly.
    await env.DB.prepare("INSERT INTO audit_log (actor_email, action) VALUES (?, 'note.create')")
      .bind(SPENDER)
      .run();
    await env.DB.prepare(
      `INSERT INTO read_log (id, request_id, principal, app, env, route, source, source_class, view, query_name, target, row_count)
       VALUES ('p1','req-abc',?,'my-app','test','GET /api/x','clientdb','client','clients.summary','q','duns:123456789',3)`,
    )
      .bind(READER)
      .run();
    // An upstream read too (PIA C15): its target is a NAME, and even the name stays app-side.
    await env.DB.prepare(
      `INSERT INTO read_log (id, request_id, principal, app, env, route, kind, source, source_class, view, query_name, target, row_count)
       VALUES ('p2','req-upq',?,'my-app','test','GET /api/reports/by-duns/:duns','upstream','autobahn','client',NULL,'report_by_duns','duns_projection',1)`,
    )
      .bind(READER)
      .run();
    const { fetcher, calls } = captureFetcher();
    await runReportToRegistry(configured(), fetcher);
    const body = calls[0]!.init.body as string;

    for (const identity of [SPENDER, READER, 'test.example', '@']) {
      expect(body).not.toContain(identity);
    }
    // Record identifiers are equally out of bounds — `target` is the DECLARED projection the read
    // ledger keeps app-side, and `request_id` correlates one call to one person.
    for (const identifier of [
      'duns:123456789',
      'req-abc',
      'req-upq',
      'duns_projection',
      'actor_email',
      'principal',
      'target',
    ]) {
      expect(body).not.toContain(identifier);
    }
    // Decision D6, carried one layer out: no field anywhere on this payload can hold SQL text or
    // a bind value, so neither can appear.
    for (const sql of ['SELECT ', 'INSERT ', 'WHERE ', 'params']) {
      expect(body).not.toContain(sql);
    }
    // And the counts genuinely arrived — otherwise the assertions above pass trivially.
    const parsed = JSON.parse(body) as LedgerPayload;
    const today = new Date().toISOString().slice(0, 10);
    expect(parsed.activity?.find((r) => r.stream === 'writes' && r.day === today)?.events).toBe(1);
    expect(
      parsed.activity?.find((r) => r.stream === 'reads_aurora' && r.day === today)?.actors,
    ).toBe(1);
    expect(parsed.activity_upstream?.find((r) => r.day === today)?.events).toBe(1);
  });
});
