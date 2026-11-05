// THE MACHINE-WRITE EXEMPTION (insights D1 growth plan B10; DECISIONS 2026-09-24, machine read
// attribution). With READ_AUDIT armed, a SERVICE identity's successful, audited write through a
// MACHINE route is attributed by its declared audit row, not by read_log rows. Everything else is
// recorded exactly as before. Six things are pinned here:
//
//   1. THE FOUR CONDITIONS, as a truth table: all four hold → exempt; any one failing alone → not.
//   2. THROUGH executeRoute: the exempt request writes no read rows; each condition failing alone,
//      a throw, an error Response and a failed audit insert are all recorded — an error Response
//      when its body ends, as main's streamed-response rule has every Response flushed. So is a
//      row that landed with nothing to match a batch by: no payload of the route's own, the
//      oversize stub, or `runId: null` (warn-only, and every MCP call). The aurora and upstream
//      seams still record their own reads inside an exempt request. HTTP and MCP follow one rule.
//   3. THE UNARMED PATH is byte-identical: the check is never consulted, nothing is wrapped.
//   4. THE HUMAN PATH is byte-identical: no person satisfies condition 1, and a person's requests
//      write the same ledger and audit rows they always did, pinned as content.
//   5. THE REGISTRY'S INPUTS: a day on which only the ops loop (`system@cron`) and a service wrote
//      reports ONE write actor and zero reads, so read_audit_silent's traffic test is not met.
//   6. THE RESPONSE RULE TRAVELS: the carried skills and runbook state what no code checks.
//
// Every identity and value here is synthetic.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ALL_ROLES, can, principalCan } from '../../src/auth/permissions';
import { mintApiTokenFor } from '../../src/auth/tokens';
import type { PersonPrincipal, Principal, Role, ServicePrincipal } from '../../src/auth/types';
import { writeHeartbeat } from '../../src/cron/heartbeat';
import { makeDb } from '../../src/data';
import {
  __resetAuroraRegistryForTest,
  type AuroraClient,
  auroraQuery,
  defineAuroraQuery,
} from '../../src/data/aurora';
import {
  __defineUpstreamReadForTest,
  __resetUpstreamRegistryForTest,
} from '../../src/data/upstream';
import type { Env } from '../../src/env';
import { batchAudit } from '../../src/framework/batchAudit';
import {
  defineRoute,
  type Method,
  mountRoutes,
  type RouteCtx,
  type RouteDef,
  type RouteSpec,
} from '../../src/framework/defineRoute';
import { type ExecuteOpts, executeRoute } from '../../src/framework/execute';
import { isExemptMachineWrite, machineRowAttributes } from '../../src/framework/machine';
import {
  beginReadAudit,
  discardReadAudit,
  readRecorderOf,
  recordDb,
} from '../../src/framework/readAudit';
import { buildMcpTools } from '../../src/mcp/tools';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { cookieFor } from '../helpers/http';
import { captureLogs, eventNames } from '../helpers/logs';

const ORIGIN = 'https://x.test';
const SVC_EMAIL = 'svc-etl@test-app.invalid';
const ARMED = { ...env, READ_AUDIT: 'on' } as Env;
const UNARMED = env as Env;

/** What resolveApiTokenByHash hands executeRoute for a live `notes.write` service identity. */
const SVC: ServicePrincipal = {
  kind: 'service',
  email: SVC_EMAIL,
  name: 'Synthetic ETL',
  role: null,
  authMethod: 'api_token',
  credentialTransport: 'bearer',
  service: { id: 1, slug: 'etl', scope: 'notes.write', custodianEmail: USERS.member },
};

const person = (email: string, role: PersonPrincipal['role']): PersonPrincipal => ({
  kind: 'person',
  email,
  name: null,
  role,
  authMethod: 'magic_link',
  credentialTransport: 'cookie',
});
const OWNER = person(USERS.owner, 'owner');

// The person routes below are gated by `notes.read` / `notes.write`, and the notes rows of
// PERMISSIONS belong to the app: a fork may give those keys to fewer roles than the kit does
// (Insights: owner and admin only). So person callers are picked by can() / principalCan(), never by
// role name, and the file holds in any fork (B9 review F7; B10 review F4).
const WRITER_ROLE = ALL_ROLES.find((r) => can(r, 'notes.write'));
const NON_WRITER_ROLE = ALL_ROLES.find((r) => !can(r, 'notes.write'));

const METHODS: readonly Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MUTATING: readonly Method[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

// ── The route under test, and its one-condition-off variants ──────────────────────────────

interface Shape {
  method?: Method;
  machine?: boolean;
  audit?: string | false;
  path?: string;
  permission?: 'notes.write' | 'notes.read';
}

type Handler = (ctx: RouteCtx) => Promise<Response | unknown>;

let seenDb: object | undefined;

/** Reads two shapes (notes.list, notes.get), names its audit target, answers `{ ok: true }`. */
const readsThenWrites: Handler = async (ctx) => {
  seenDb = ctx.db;
  await ctx.db.notes.list({ limit: 10 });
  await ctx.db.notes.get('no-such-note');
  ctx.setAuditTarget('batch-1:1', { received: 1 });
  return { ok: true };
};

/** The machine batch route: service-only, POST, audited — every static condition holds. */
function batchSpec(shape: Shape = {}, handler: Handler = readsThenWrites): RouteSpec<z.ZodTypeAny> {
  const method = shape.method ?? 'POST';
  return defineRoute({
    method,
    path: shape.path ?? '/api/batches',
    permission: shape.permission ?? 'notes.write',
    ...(shape.machine === false ? {} : { machine: true }),
    ...('audit' in shape ? { audit: shape.audit } : { audit: 'batch.push' }),
    input: z.object({}),
    handler,
  }).spec;
}

/** The adapter half of an HTTP call, with `waitUntil` collected into `pending`. */
const httpOpts = (pending: Promise<unknown>[]): ExecuteOpts => ({
  ip: '',
  params: {},
  request: new Request(`${ORIGIN}/api/batches`, { headers: { 'x-sync-run': 'run-1' } }),
  waitUntil: (p) => {
    pending.push(p);
  },
  buildRawInput: () => ({}),
  invocation: { via: 'http' },
});

/**
 * One call through executeRoute. A Response's body is read to its end before the background work
 * settles, as the HTTP runtime reads it: a streamed body's read flush waits for that end
 * (src/framework/readAuditStream.ts), and in workerd every Response body is a stream.
 */
async function run(
  spec: RouteSpec<z.ZodTypeAny>,
  opts: { principal?: Principal; testEnv?: Env } = {},
): Promise<{ result: unknown; scheduled: number }> {
  const pending: Promise<unknown>[] = [];
  try {
    const result = await executeRoute(
      opts.testEnv ?? ARMED,
      spec,
      opts.principal ?? SVC,
      httpOpts(pending),
    );
    if (result instanceof Response) await result.clone().text();
    return { result, scheduled: pending.length };
  } finally {
    await Promise.allSettled(pending);
  }
}

interface LedgerRow {
  principal: string;
  route: string;
  kind: string;
  source: string;
  query_name: string | null;
  row_count: number | null;
}

async function ledger(): Promise<LedgerRow[]> {
  return (
    await env.DB.prepare(
      'SELECT principal, route, kind, source, query_name, row_count FROM read_log ORDER BY route, source, query_name, principal',
    ).all<LedgerRow>()
  ).results;
}

interface AuditRow {
  actor_email: string;
  action: string;
  target: string | null;
  payload_json: string | null;
}

async function audits(action: string): Promise<AuditRow[]> {
  return (
    await env.DB.prepare(
      'SELECT actor_email, action, target, payload_json FROM audit_log WHERE action = ? ORDER BY id',
    )
      .bind(action)
      .all<AuditRow>()
  ).results;
}

/** The two d1 rows readsThenWrites leaves when it is recorded, for `who` on `route`. */
const recordedRows = (who: string, route = 'POST /api/batches'): LedgerRow[] => [
  { principal: who, route, kind: 'd1', source: 'notes', query_name: 'get', row_count: 0 },
  { principal: who, route, kind: 'd1', source: 'notes', query_name: 'list', row_count: 0 },
];

// ── 1. The four conditions ─────────────────────────────────────────────────────────────

describe('isExemptMachineWrite — four conditions, ANDed', () => {
  const exempt = { method: 'POST' as Method, machine: true, audit: 'batch.push' };

  it('all four hold: exempt, for every mutating method', () => {
    for (const method of MUTATING) {
      expect(isExemptMachineWrite(SVC, { ...exempt, method })).toBe(true);
    }
  });

  it('condition 1 failing alone: a person, a look-alike kind, a service outside `.invalid`', () => {
    const notService: Principal[] = [
      OWNER,
      { ...OWNER, credentialTransport: 'bearer', tokenScopes: ['notes.write'] },
      // No person can hold a reserved address (users.add refuses one), but the kind decides first.
      { ...OWNER, email: SVC_EMAIL },
      ...[undefined, null, '', 'Service', 'service ', 'agent'].map(
        (kind) => ({ ...SVC, kind }) as unknown as Principal,
      ),
      { ...SVC, email: 'svc-etl@test-app.example' },
      { ...SVC, email: 'svc-etl@invalid.example' },
      { ...SVC, email: 'svc-etl.invalid' },
    ];
    for (const principal of notService) {
      expect(isExemptMachineWrite(principal, exempt)).toBe(false);
    }
  });

  it('condition 2 failing alone: the route is not exactly machine: true', () => {
    for (const machine of [undefined, false, 'true', 1]) {
      expect(isExemptMachineWrite(SVC, { ...exempt, machine: machine as unknown as boolean })).toBe(
        false,
      );
    }
  });

  it('condition 3 failing alone: a GET', () => {
    expect(isExemptMachineWrite(SVC, { ...exempt, method: 'GET' })).toBe(false);
  });

  it('condition 4 failing alone: audit: false, no declaration, or an empty action', () => {
    for (const audit of [false, undefined, ''] as const) {
      expect(isExemptMachineWrite(SVC, { ...exempt, audit })).toBe(false);
    }
  });

  it('an error while evaluating it answers false, and logs the error class only', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const exploding = {
        ...SVC,
        get email(): string {
          throw new TypeError('synthetic');
        },
      } as ServicePrincipal;
      expect(isExemptMachineWrite(exploding, exempt)).toBe(false);
      // One registered logEvent line (#241 / PIA C5): the error's category, never its message.
      expect(spy.mock.calls).toEqual([
        [
          JSON.stringify({
            event: 'read_audit_exemption_check_failed',
            err: { name: 'TypeError' },
          }),
        ],
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('"mutating" is defineRoute’s: exactly the methods obliged to declare an audit action', () => {
    for (const method of METHODS) {
      let obliged = false;
      try {
        defineRoute({
          method,
          path: '/api/probe',
          permission: 'notes.write',
          input: z.object({}),
          handler: async () => ({}),
        });
      } catch {
        obliged = true;
      }
      expect(isExemptMachineWrite(SVC, { ...exempt, method })).toBe(obliged);
    }
  });
});

describe('machineRowAttributes — can the landed row stand in for the reads?', () => {
  const counts = { received: 2, written: 2, unchanged: 0, rejected: 0 };

  it('the route’s own payload, under the cap, with a valid run id: yes', () => {
    expect(machineRowAttributes(counts, 'run-1')).toBe(true);
    // A payload that carried its own runId is stamped over, and still has keys of its own.
    expect(machineRowAttributes({ ...counts, runId: 'other' }, 'run-1')).toBe(true);
  });

  it('no run id (warn-only adoption, every MCP call), or one the kit would not store: no', () => {
    for (const runId of [null, '', 'has space', 'x'.repeat(65)]) {
      expect(machineRowAttributes(counts, runId)).toBe(false);
    }
  });

  it('no payload of the route’s own: no — the stored row would hold the run id alone', () => {
    const none: unknown[] = [undefined, null, {}, { runId: 'run-1' }, { _via: 'x', _turn: 't' }];
    for (const payload of none) {
      expect(machineRowAttributes(payload as Record<string, unknown>, 'run-1')).toBe(false);
    }
  });

  it('the STORED row decides, not the handler’s object: keys JSON drops do not count', () => {
    // JSON.stringify leaves out an undefined, function or symbol value, so each of these is stored
    // as `{ runId }` alone (B10 review round 2, R1). `{ written: res?.meta?.changes }` and
    // `{ rejected: n || undefined }` type-check against Record<string, unknown> and land here.
    const dropped: Record<string, unknown>[] = [
      { written: undefined },
      { written: undefined, rejected: undefined, _via: 'x' },
      { fn: () => 1 },
      { sym: Symbol('s') },
      // A toJSON the spread copies onto the stamped row replaces the whole stored form: a row
      // without the run id, or no object at all, cannot stand in either.
      { written: 2, toJSON: () => ({}) },
      { written: 2, toJSON: () => ({ written: 2 }) },
      { written: 2, toJSON: () => null },
      { written: 2, toJSON: () => ['written'] },
      { written: 2, toJSON: () => 'written' },
    ];
    for (const payload of dropped) {
      expect(machineRowAttributes(payload, 'run-1')).toBe(false);
    }
    // A defined key beside a dropped one is stored, and still stands in.
    expect(machineRowAttributes({ written: 2, rejected: undefined }, 'run-1')).toBe(true);
    expect(machineRowAttributes({ written: 0 }, 'run-1')).toBe(true);
  });

  it('over the cap: no — the row would be the oversize stub, with no counts or fingerprint', () => {
    const keys = Array.from({ length: 300 }, (_, i) => `key-${i}`);
    expect(machineRowAttributes({ ...counts, keys }, 'run-1')).toBe(false);
  });

  it('an error while evaluating it answers false, and logs the error class only', () => {
    const logs = captureLogs();
    try {
      const exploding = new Proxy(counts, {
        ownKeys() {
          throw new TypeError('synthetic');
        },
      });
      expect(machineRowAttributes(exploding, 'run-1')).toBe(false);
      expect(logs.events).toEqual([
        { event: 'read_audit_exemption_check_failed', err: { name: 'TypeError' }, level: 'error' },
      ]);
    } finally {
      logs.restore();
    }
  });
});

describe('discardReadAudit — closes a recorder without writing it', () => {
  it('drains what was collected, and a later read is a counted drop', async () => {
    const recorder = beginReadAudit(SVC_EMAIL, 'POST /api/batches');
    const view = recordDb({ repo: { read: async () => [1, 2] } }, recorder);
    await view.repo.read();
    expect(recorder.events.length).toBe(1);
    discardReadAudit(recorder);
    expect(recorder.closed).toBe(true);
    expect(recorder.events).toEqual([]);
    expect(recorder.index.size).toBe(0); // B5's aggregation index is drained with the events
    await view.repo.read();
    expect(recorder.events).toEqual([]);
    expect(recorder.dropped).toBe(1);
  });
});

// ── 2. Through executeRoute ────────────────────────────────────────────────────────────

describe('through executeRoute, armed', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    seenDb = undefined;
  });

  it('EXEMPT: no read rows — yet the reads ran recorded, and the audit row names the service', async () => {
    const { result } = await run(batchSpec());
    expect(result).toEqual({ ok: true });
    // The handler read through the RECORDING view: the reads were collected, then dropped only
    // because the declared row landed.
    expect(seenDb && readRecorderOf(seenDb)).toBeDefined();
    expect(await ledger()).toEqual([]);
    const rows = await audits('batch.push');
    expect(rows.map((r) => [r.actor_email, r.target])).toEqual([[SVC_EMAIL, 'batch-1:1']]);
    expect(JSON.parse(rows[0]?.payload_json ?? 'null')).toEqual({ received: 1, runId: 'run-1' });
  });

  it('EXEMPT for every mutating method', async () => {
    for (const method of MUTATING) {
      await run(batchSpec({ method }));
    }
    expect(await ledger()).toEqual([]);
    expect((await audits('batch.push')).length).toBe(MUTATING.length);
  });

  it('condition 1 failing alone is recorded: a service principal outside the reserved namespace', async () => {
    const outside: ServicePrincipal = { ...SVC, email: 'svc-etl@test-app.example' };
    await run(batchSpec(), { principal: outside });
    expect(await ledger()).toEqual(recordedRows(outside.email));
    expect((await audits('batch.push')).length).toBe(1);
  });

  it('condition 2 failing alone is recorded: the same write through an ordinary route', async () => {
    await run(batchSpec({ machine: false, path: '/api/plain-batches' }));
    expect(await ledger()).toEqual(recordedRows(SVC_EMAIL, 'POST /api/plain-batches'));
    expect((await audits('batch.push')).length).toBe(1);
  });

  it('condition 3 failing alone is recorded: a service GET on a machine route, audited or not', async () => {
    await run(batchSpec({ method: 'GET' }));
    await run(batchSpec({ method: 'GET', audit: false, path: '/api/batch-status' }));
    expect(await ledger()).toEqual([
      ...recordedRows(SVC_EMAIL, 'GET /api/batch-status'),
      ...recordedRows(SVC_EMAIL, 'GET /api/batches'),
    ]);
    // The audited GET still writes its audit row, and its reads are recorded as well.
    expect((await audits('batch.push')).length).toBe(1);
  });

  it('condition 4 failing alone is recorded: audit: false', async () => {
    await run(batchSpec({ audit: false }));
    expect(await ledger()).toEqual(recordedRows(SVC_EMAIL));
  });

  it('a handler that THROWS is recorded — it wrote no audit row', async () => {
    const spec = batchSpec({}, async (ctx) => {
      await readsThenWrites(ctx);
      throw new Error('synthetic handler failure');
    });
    await expect(run(spec)).rejects.toThrow('synthetic handler failure');
    expect(await ledger()).toEqual(recordedRows(SVC_EMAIL));
    expect(await audits('batch.push')).toEqual([]);
  });

  it('an error Response is recorded — no success row is written for it', async () => {
    const spec = batchSpec({}, async (ctx) => {
      await readsThenWrites(ctx);
      return new Response('conflict', { status: 409 });
    });
    const { result } = await run(spec);
    expect((result as Response).status).toBe(409);
    expect(await ledger()).toEqual(recordedRows(SVC_EMAIL));
    expect(await audits('batch.push')).toEqual([]);
  });

  it('…and its flush waits for the BODY, as every Response’s does (step 6 flushes by 4b’s path)', async () => {
    const spec = batchSpec({}, async (ctx) => {
      await readsThenWrites(ctx);
      return new Response('conflict', { status: 409 });
    });
    const pending: Promise<unknown>[] = [];
    const res = (await executeRoute(ARMED, spec, SVC, httpOpts(pending))) as Response;
    await Promise.allSettled(pending);
    expect(res.status).toBe(409);
    expect(await ledger()).toEqual([]); // nobody has read the body yet: the request is not over
    expect(await res.text()).toBe('conflict'); // byte-for-byte the handler's body
    await Promise.allSettled(pending);
    expect(await ledger()).toEqual(recordedRows(SVC_EMAIL));
  });

  it('EXEMPT with a Response body: the reads are discarded once the row lands, body read or not', async () => {
    const spec = batchSpec({}, async (ctx) => {
      await readsThenWrites(ctx);
      return new Response(JSON.stringify({ written: 1 }), { status: 201 });
    });
    const pending: Promise<unknown>[] = [];
    const res = (await executeRoute(ARMED, spec, SVC, httpOpts(pending))) as Response;
    await Promise.allSettled(pending);
    expect(res.status).toBe(201);
    expect(pending.length).toBe(0); // no flush is waiting on the body
    expect(await res.text()).toBe('{"written":1}');
    await Promise.allSettled(pending);
    expect(await ledger()).toEqual([]);
    expect((await audits('batch.push')).map((r) => r.actor_email)).toEqual([SVC_EMAIL]);
  });

  it('a FAILED audit insert is recorded, and the audit-failure alert still goes out', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The insert fails for real: the table it writes to is gone. read_log is untouched.
    await env.DB.prepare('DROP TABLE audit_log').run();
    try {
      const { result, scheduled } = await run(batchSpec());
      expect(result).toEqual({ ok: true }); // fail-open, DECISIONS 2026-08-03
      expect(eventNames(errorSpy.mock.calls)).toContain('audit_declared_write_failed');
      expect(scheduled).toBe(2); // the audit-failure alert, and the read flush
      expect(await ledger()).toEqual(recordedRows(SVC_EMAIL));
    } finally {
      errorSpy.mockRestore();
      await applySchema();
      await seedDb();
    }
  });

  // The row stands in for the reads only when it carries what the exemption counts on: the route's
  // own payload, stored whole (not the oversize stub), and the caller's X-Sync-Run id. A row that
  // landed without them names the actor and the action and nothing an investigator could match to
  // a batch, so the reads are recorded instead (B10 review F5: fail toward recording).
  it('an OVERSIZE payload is recorded: the stored stub has no counts and no fingerprint', async () => {
    const logs = captureLogs();
    try {
      const keys = Array.from({ length: 300 }, (_, i) => `key-${i}`);
      const spec = batchSpec({}, async (ctx) => {
        await readsThenWrites(ctx);
        ctx.setAuditTarget('batch-1:300', { keys });
        return { ok: true };
      });
      expect((await run(spec)).result).toEqual({ ok: true });
      expect(logs.named('machine_audit_payload_oversize')).toHaveLength(1);
      const rows = await audits('batch.push');
      expect(rows.length).toBe(1);
      expect(JSON.parse(rows[0]?.payload_json ?? 'null')).toMatchObject({
        oversize: true,
        runId: 'run-1',
      });
      expect(await ledger()).toEqual(recordedRows(SVC_EMAIL));
    } finally {
      logs.restore();
    }
  });

  it('NO payload of the route’s own is recorded: the row holds the run id alone', async () => {
    // `{ written: undefined }` is stored as `{ runId }` too: JSON drops the key (round 2, R1).
    const payloads: (Record<string, unknown> | undefined)[] = [
      undefined,
      {},
      { runId: 'other' },
      { written: undefined },
    ];
    for (const payload of payloads) {
      await seedDb();
      const spec = batchSpec({}, async (ctx) => {
        await ctx.db.notes.list({ limit: 10 });
        await ctx.db.notes.get('no-such-note');
        if (payload !== undefined) ctx.setAuditTarget('batch-1:1', payload);
        return { ok: true };
      });
      await run(spec);
      const rows = await audits('batch.push');
      expect(rows.map((r) => JSON.parse(r.payload_json ?? 'null'))).toEqual([{ runId: 'run-1' }]);
      expect(await ledger()).toEqual(recordedRows(SVC_EMAIL));
    }
  });

  it('warn-only with no X-Sync-Run is recorded: the row cannot be matched to a run', async () => {
    const warnOnly = { ...ARMED, MACHINE_SYNC_RUN: 'warn' } as Env;
    const logs = captureLogs();
    try {
      const pending: Promise<unknown>[] = [];
      const opts = { ...httpOpts(pending), request: new Request(`${ORIGIN}/api/batches`) };
      try {
        expect(await executeRoute(warnOnly, batchSpec(), SVC, opts)).toEqual({ ok: true });
      } finally {
        await Promise.allSettled(pending);
      }
      expect(logs.named('machine_sync_run_missing')).toHaveLength(1);
      const rows = await audits('batch.push');
      expect(rows.map((r) => JSON.parse(r.payload_json ?? 'null'))).toEqual([
        { received: 1, runId: null },
      ]);
      expect(await ledger()).toEqual(recordedRows(SVC_EMAIL));
    } finally {
      logs.restore();
    }
  });

  it('…and warn-only WITH an X-Sync-Run, a batchAudit() payload stands in for the reads', async () => {
    const warnOnly = { ...ARMED, MACHINE_SYNC_RUN: 'warn' } as Env;
    const spec = batchSpec({}, async (ctx) => {
      await ctx.db.notes.list({ limit: 10 });
      await ctx.db.notes.get('no-such-note');
      ctx.setAuditTarget(
        'batch-1:2',
        await batchAudit({
          table: 'notes',
          received: 2,
          written: 2,
          unchanged: 0,
          rejected: 0,
          keys: ['k-2', 'k-1'],
          runId: ctx.syncRunId,
        }),
      );
      return { written: 2 };
    });
    expect((await run(spec, { testEnv: warnOnly })).result).toEqual({ written: 2 });
    const rows = await audits('batch.push');
    expect(JSON.parse(rows[0]?.payload_json ?? 'null')).toMatchObject({
      table: 'notes',
      received: 2,
      keys: { count: 2, firstKey: 'k-1', lastKey: 'k-2' },
      runId: 'run-1',
    });
    expect(await ledger()).toEqual([]);
  });

  it('the aurora seam is untouched: an exempt request’s private-database read is still recorded', async () => {
    const client: AuroraClient = {
      query: async <R>() => ({ rows: [{ n: 1 }, { n: 2 }] as R[] }),
    };
    const usage = defineAuroraQuery<{ n: number }>(
      {
        name: 'batch_usage',
        source: 'ret1_ro' as never,
        view: 'app_ro.v_batch_usage',
        sql: 'SELECT n FROM app_ro.v_batch_usage',
        params: [],
      },
      { ret1_ro: 'internal' },
    );
    try {
      const spec = batchSpec({}, async (ctx) => {
        await readsThenWrites(ctx);
        await auroraQuery(
          {
            env: ctx.env,
            client,
            principal: ctx.principal.email,
            route: 'POST /api/batches',
            requestId: 'req-aurora',
            waitUntil: ctx.waitUntil,
          },
          usage,
        );
        return { ok: true };
      });
      await run(spec);
      const rows = await ledger();
      expect(rows).toEqual([
        {
          principal: SVC_EMAIL,
          route: 'POST /api/batches',
          kind: 'aurora',
          source: 'ret1_ro',
          query_name: 'batch_usage',
          row_count: 2,
        },
      ]);
    } finally {
      __resetAuroraRegistryForTest();
    }
  });

  it('the upstream seam is untouched: an exempt request’s ctx.readUpstream read is still recorded', async () => {
    const lookup = __defineUpstreamReadForTest(
      { source: 'bureau_feed' as never, name: 'batch_lookup', target: 'batch_id' },
      { bureau_feed: 'client' },
    );
    try {
      const spec = batchSpec({}, async (ctx) => {
        await readsThenWrites(ctx);
        await ctx.readUpstream(lookup, async () => [1, 2, 3]);
        return { ok: true };
      });
      await run(spec);
      expect(await ledger()).toEqual([
        {
          principal: SVC_EMAIL,
          route: 'POST /api/batches',
          kind: 'upstream',
          source: 'bureau_feed',
          query_name: 'batch_lookup',
          row_count: 3,
        },
      ]);
      expect((await audits('batch.push')).length).toBe(1);
    } finally {
      __resetUpstreamRegistryForTest();
    }
  });
});

// ── HTTP (a real service token) and MCP agree ──────────────────────────────────────────

async function serviceToken(): Promise<string> {
  const principalId = SVC_EMAIL;
  const res = await makeDb(env).serviceIdentities.create({
    slug: 'etl',
    principalId,
    name: 'Synthetic ETL',
    scope: 'notes.write',
    custodianEmail: USERS.member,
    createdBy: USERS.owner,
  });
  if (!res.ok) throw new Error(res.reason);
  return (await mintApiTokenFor(makeDb(env), OWNER, principalId, { name: 'etl' })).token;
}

type Auth = { bearer: string } | { cookieOf: string };

async function httpCall(
  routes: RouteDef[],
  method: Method,
  path: string,
  auth: Auth,
  testEnv: Env = ARMED,
): Promise<{ status: number; body: string }> {
  const app = new Hono<{ Bindings: Env }>();
  mountRoutes(app, routes);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: ORIGIN,
    'x-sync-run': 'run-1',
  };
  if ('bearer' in auth) headers.authorization = `Bearer ${auth.bearer}`;
  else headers.cookie = await cookieFor(auth.cookieOf);
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  const res = await app.request(
    `${ORIGIN}${path}`,
    { method, headers, ...(method === 'GET' ? {} : { body: '{}' }) },
    testEnv,
    executionCtx,
  );
  const body = await res.text();
  await Promise.allSettled(pending);
  return { status: res.status, body };
}

const asDef = (spec: RouteSpec<z.ZodTypeAny>): RouteDef => ({ spec });

describe('every adapter agrees, because there is one pipeline', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('HTTP, real service token: the exempt write records nothing; its GET on the same app is recorded', async () => {
    const token = await serviceToken();
    const routes = [
      asDef(batchSpec()),
      asDef(batchSpec({ method: 'GET', audit: false, path: '/api/batch-status' })),
    ];
    expect((await httpCall(routes, 'POST', '/api/batches', { bearer: token })).status).toBe(200);
    expect(await ledger()).toEqual([]);
    expect((await httpCall(routes, 'GET', '/api/batch-status', { bearer: token })).status).toBe(
      200,
    );
    expect(await ledger()).toEqual(recordedRows(SVC_EMAIL, 'GET /api/batch-status'));
    expect((await audits('batch.push')).map((r) => r.actor_email)).toEqual([SVC_EMAIL]);
  });

  // The same rule, not a different one: MCP is not a machine route's transport, and its synthetic
  // request carries no X-Sync-Run. Enforcing, that is a 400; warn-only, the row lands with
  // `runId: null`, which cannot be matched to a run, so the reads are recorded (B10 review F5).
  it('MCP: the same write invoked as a tool carries no X-Sync-Run, so warn-only it is recorded', async () => {
    const warnOnly = { ...ARMED, MACHINE_SYNC_RUN: 'warn' } as Env;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tool = buildMcpTools([asDef(batchSpec())]).find((t) => t.name === 'post_batches');
      const result = await tool?.invoke(warnOnly, SVC, {});
      expect(result?.isError).toBeFalsy();
      expect(eventNames(warn.mock.calls)).toContain('machine_sync_run_missing');
      expect(await ledger()).toEqual(recordedRows(SVC_EMAIL));
      expect(
        (await audits('batch.push')).map((r) => [r.actor_email, JSON.parse(r.payload_json ?? '')]),
      ).toEqual([[SVC_EMAIL, { received: 1, runId: null, _via: 'mcp' }]]);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── 3. The unarmed path ────────────────────────────────────────────────────────────────

describe('the unarmed path is byte-identical', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    seenDb = undefined;
  });

  it('the exempt shape unarmed: nothing wrapped, nothing recorded, the audit row written', async () => {
    const { result } = await run(batchSpec(), { testEnv: UNARMED });
    expect(result).toEqual({ ok: true });
    expect(seenDb).toBeDefined();
    expect(readRecorderOf(seenDb as object)).toBeUndefined();
    expect(await ledger()).toEqual([]);
    expect((await audits('batch.push')).map((r) => r.actor_email)).toEqual([SVC_EMAIL]);
  });

  it('every shape answers the same armed and unarmed, and unarmed never records', async () => {
    const shapes: Shape[] = [
      {},
      { machine: false, path: '/api/plain-batches' },
      { method: 'GET' },
      { audit: false },
    ];
    for (const shape of shapes) {
      const armed = await run(batchSpec(shape));
      const unarmed = await run(batchSpec(shape), { testEnv: UNARMED });
      expect(unarmed.result).toEqual(armed.result);
    }
    const armedRows = await ledger();
    await seedDb();
    for (const shape of shapes) await run(batchSpec(shape), { testEnv: UNARMED });
    expect(await ledger()).toEqual([]);
    // …and armed, only the exempt shape (the first) went unrecorded: `POST /api/batches` carries
    // just the two rows of the `audit: false` shape, which shares its route.
    expect(armedRows).toEqual([
      ...recordedRows(SVC_EMAIL, 'GET /api/batches'),
      ...recordedRows(SVC_EMAIL, 'POST /api/batches'),
      ...recordedRows(SVC_EMAIL, 'POST /api/plain-batches'),
    ]);
  });
});

// ── 4. The human path ──────────────────────────────────────────────────────────────────

describe('the human path is byte-identical', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const humans: Principal[] = [
    person(USERS.owner, 'owner'),
    person(USERS.admin, 'admin'),
    person(USERS.member, 'member'),
    person(USERS.viewer, 'viewer'),
    { ...person(USERS.owner, 'owner'), credentialTransport: 'bearer', tokenScopes: null },
  ];

  it('no person satisfies condition 1, on any route shape or method', () => {
    for (const who of humans) {
      for (const method of METHODS) {
        for (const machine of [true, false]) {
          expect(isExemptMachineWrite(who, { method, machine, audit: 'batch.push' })).toBe(false);
        }
      }
    }
  });

  it('a person’s audited write and read land exactly the rows they always did (pinned as content)', async () => {
    const write = batchSpec({ machine: false, path: '/api/plain-batches' });
    const read = batchSpec({
      method: 'GET',
      machine: false,
      audit: false,
      path: '/api/notes-feed',
      permission: 'notes.read',
    });
    // Callers picked by the check executeRoute itself makes, so each one is let through.
    const writers = humans.filter((h) => principalCan(h, 'notes.write'));
    const readers = humans.filter((h) => principalCan(h, 'notes.read'));
    expect(writers.length, 'a person who holds notes.write').toBeGreaterThan(0);
    expect(readers.length, 'a person who holds notes.read').toBeGreaterThan(0);
    for (const who of writers) await run(write, { principal: who });
    for (const who of readers) await run(read, { principal: who });

    const expected = [
      ...readers.flatMap((h) => recordedRows(h.email, 'GET /api/notes-feed')),
      ...writers.flatMap((h) => recordedRows(h.email, 'POST /api/plain-batches')),
    ].sort((a, b) =>
      `${a.route} ${a.source} ${a.query_name} ${a.principal}`.localeCompare(
        `${b.route} ${b.source} ${b.query_name} ${b.principal}`,
      ),
    );
    expect(await ledger()).toEqual(expected);
    expect(
      (await audits('batch.push')).map((r) => [r.actor_email, r.target, r.payload_json]),
    ).toEqual(writers.map((h) => [h.email, 'batch-1:1', JSON.stringify({ received: 1 })]));
  });

  it('over HTTP: a person on a machine route gets the uniform 404 and leaves no row of either kind', async () => {
    const routes = [
      asDef(batchSpec()),
      asDef(batchSpec({ machine: false, path: '/api/plain-batches' })),
    ];
    expect(NON_WRITER_ROLE, 'a role without notes.write, for the reference denial').toBeDefined();
    const reference = await httpCall(routes, 'POST', '/api/plain-batches', {
      cookieOf: USERS[NON_WRITER_ROLE as Role],
    });
    expect(reference.status).toBe(404);
    for (const who of [USERS.owner, USERS.admin, USERS.member, USERS.viewer]) {
      const res = await httpCall(routes, 'POST', '/api/batches', { cookieOf: who });
      expect(res).toEqual(reference);
    }
    expect(await ledger()).toEqual([]);
    expect(await audits('batch.push')).toEqual([]);
  });
});

// ── 5. The registry's inputs on a machine-only day ─────────────────────────────────────

/**
 * app-registry's read_audit_silent traffic test (src/alerts/engine.ts, evaluateArmedButSilent),
 * at its enforced floors: writes from at least TWO distinct actors, or at least one successful
 * login. Mirrored here so the fixture day is judged by the rule it exists to keep quiet; the rule
 * fires only when this is true AND the day's reads are 0.
 */
function registryCountsAsTraffic(writes: { events: number; actors: number }, logins: number) {
  return (writes.events >= 1 && writes.actors >= 2) || logins >= 1;
}

describe('the registry’s inputs: a day on which only the ops loop and a service wrote', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  const today = () => new Date().toISOString().slice(0, 10);

  async function digestFor(stream: string) {
    const all = await makeDb(ARMED).activity.dailyDigests();
    return all.find((d) => d.stream === stream && d.day === today());
  }

  it('system@cron + an exempt machine write: ONE write actor, zero reads — not traffic', async () => {
    await writeHeartbeat(ARMED, []);
    const token = await serviceToken();
    const res = await httpCall([asDef(batchSpec())], 'POST', '/api/batches', { bearer: token });
    expect(res.status).toBe(200);

    const writes = await digestFor('writes');
    expect(writes?.events).toBe(2); // the heartbeat and the batch: a machine's writes are volume
    expect(writes?.actors).toBe(1); // …but not an actor: only system@cron is
    expect((await digestFor('reads_d1'))?.events).toBe(0);
    const auth = await digestFor('auth');
    expect(auth?.events).toBe(0);
    expect(registryCountsAsTraffic(writes ?? { events: 0, actors: 0 }, 0)).toBe(false);
  });

  it('a person writing on the same day still counts: two actors, and their reads are recorded', async () => {
    expect(WRITER_ROLE, 'a role that holds notes.write').toBeDefined();
    const writer = WRITER_ROLE as Role;
    await writeHeartbeat(ARMED, []);
    await run(batchSpec());
    await run(batchSpec({ machine: false, path: '/api/plain-batches' }), {
      principal: person(USERS[writer], writer),
    });
    const writes = await digestFor('writes');
    expect(writes?.events).toBe(3);
    expect(writes?.actors).toBe(2);
    expect((await digestFor('reads_d1'))?.events).toBe(2);
    expect(registryCountsAsTraffic(writes ?? { events: 0, actors: 0 }, 0)).toBe(true);
  });
});

// ── 6. The response rule reaches every fork ────────────────────────────────────────────

// The exemption reads a route's DECLARED method, never its response, so the rule that a machine
// write returns counts and the keys it was sent — never a record it read — and that a lookup is a
// GET is enforced by review alone (DECISIONS 2026-09-24, Honest limits). /kit-upgrade carries
// `.claude/` and `docs/runbooks`, not the docs that spell the rule out, so it has to live in the
// carried skill that runs that review, the one that walks a new endpoint, and the runbook a
// service identity's owner reads (B10 review F1).
const CARRIED_RULE_DOCS = import.meta.glob<string>(
  [
    '../../.claude/skills/security-review/SKILL.md',
    '../../.claude/skills/add-endpoint/SKILL.md',
    '../../docs/runbooks/service-identities.md',
  ],
  { query: '?raw', import: 'default', eager: true },
);

describe('the machine-route response rule travels with /kit-upgrade', () => {
  it('the carried review skill, endpoint skill and service-identity runbook each state it', () => {
    expect(Object.keys(CARRIED_RULE_DOCS)).toHaveLength(3);
    for (const [file, text] of Object.entries(CARRIED_RULE_DOCS)) {
      const flat = text.replace(/\s+/g, ' ');
      expect(flat, file).toContain('`machine: true`');
      expect(flat, file).toMatch(/counts and the keys (?:the caller itself sent|it was sent)/);
      expect(flat, file).toMatch(/never a (?:row|record)[^.]* it read/);
      expect(flat, file).toMatch(/lookup[^.?]* (?:a|its own) \**GET\b/);
    }
  });
});
