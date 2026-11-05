// GET /api/read-log — the surface that answers "who read record X", inside the app that owns the
// data. The fleet registry only ever receives COUNTS plus the `activity_url` deep link; this
// endpoint is what that link lands on, and what the wave-3 CLI's `--app` mode queries.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeDb } from '../../src/data';
import type { ReadLogIntent, ReadLogRow } from '../../src/data/readLog';
import type { Env } from '../../src/env';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser } from '../helpers/http';

const ledger = () => makeDb(env as Env).readLog;

function d1Intent(n: number): ReadLogIntent {
  return {
    id: `row-${String(n).padStart(3, '0')}`,
    request_id: `req-${n}`,
    principal: USERS.member,
    app: 'test-app',
    env: 'test',
    route: 'GET /api/notes',
    kind: 'd1',
    source: 'notes',
    source_class: 'internal',
    view: null,
    query_name: 'list',
    target: null,
  };
}

async function seedReads(count: number): Promise<void> {
  for (let i = 1; i <= count; i++) await ledger().insertComplete(d1Intent(i), i);
}

type Page = { items: ReadLogRow[]; next_before: { created_at: string; id: string } | null };

async function page(url: string, as: string = USERS.admin): Promise<Page> {
  const res = await asUser(as, 'GET', url);
  expect(res.status).toBe(200);
  return (await res.json<{ data: Page }>()).data;
}

describe('GET /api/read-log', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('returns the ledger newest first', async () => {
    await seedReads(3);
    const body = await page('/api/read-log');
    expect(body.items.map((r) => r.id)).toEqual(['row-003', 'row-002', 'row-001']);
    expect(body.items[0]).toMatchObject({ kind: 'd1', source: 'notes', query_name: 'list' });
    expect(body.next_before).toBeNull();
  });

  it('pages back through a SECOND that every row shares', async () => {
    // `created_at` has one-second precision and a seeded burst lands inside one second — which is
    // also the normal case for one request making several reads. A `created_at`-only cursor would
    // skip every remaining row of that second and return an empty second page: silent
    // under-reporting on an audit surface. The (created_at, id) tie-break is what prevents it.
    await seedReads(5);
    const first = await page('/api/read-log?limit=2');
    expect(first.items.map((r) => r.id)).toEqual(['row-005', 'row-004']);
    expect(first.next_before).not.toBeNull();

    const cursor = first.next_before as { created_at: string; id: string };
    const second = await page(
      `/api/read-log?limit=2&before_created_at=${encodeURIComponent(cursor.created_at)}&before_id=${cursor.id}`,
    );
    expect(second.items.map((r) => r.id)).toEqual(['row-003', 'row-002']);

    const third = await page(
      `/api/read-log?limit=2&before_created_at=${encodeURIComponent(
        (second.next_before as { created_at: string }).created_at,
      )}&before_id=${(second.next_before as { id: string }).id}`,
    );
    expect(third.items.map((r) => r.id)).toEqual(['row-001']);
    expect(third.next_before).toBeNull();
  });

  it('rejects HALF a cursor — a partial position is a client bug, not a page', async () => {
    for (const query of ['before_created_at=2026-08-20%2001%3A00%3A00', 'before_id=row-001']) {
      const res = await asUser(USERS.admin, 'GET', `/api/read-log?${query}`);
      expect(res.status).toBe(400);
      expect((await res.json<{ error: { code: string } }>()).error.code).toBe('validation_failed');
    }
  });

  it('bounds the page size', async () => {
    for (const limit of ['0', '201', 'lots']) {
      expect((await asUser(USERS.admin, 'GET', `/api/read-log?limit=${limit}`)).status).toBe(400);
    }
  });

  it('is admin-and-up: a member and a viewer get the uniform 404, not a 403', async () => {
    await seedReads(1);
    for (const who of [USERS.member, USERS.viewer]) {
      const res = await asUser(who, 'GET', '/api/read-log');
      // 404-uniformity: "forbidden" and "does not exist" are byte-identical on every surface, so
      // a member cannot even learn that the read ledger is a thing this app has.
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('row-001');
    }
    expect((await asUser(USERS.owner, 'GET', '/api/read-log')).status).toBe(200);
  });

  it('is fail-closed: anonymous is 401', async () => {
    expect((await asUser(null, 'GET', '/api/read-log')).status).toBe(401);
  });

  it('shows an aurora row and a d1 row side by side, each labelled', async () => {
    await ledger().insertComplete(d1Intent(1), 4);
    await ledger().insertComplete(
      {
        ...d1Intent(2),
        kind: 'aurora',
        source: 'ret1_ro',
        source_class: 'client',
        view: 'app_ro.v_namespace_usage',
        query_name: 'listNamespaceUsage',
        target: 'client_code',
      },
      1,
    );
    const body = await page('/api/read-log');
    expect(body.items.map((r) => r.kind)).toEqual(['aurora', 'd1']);
    expect(body.items[0]).toMatchObject({
      view: 'app_ro.v_namespace_usage',
      source_class: 'client',
      target: 'client_code',
    });
    expect(body.items[1]).toMatchObject({ view: null, source_class: 'internal' });
  });

  it('never exposes SQL or bind values, because the table cannot hold them (Decision D6)', async () => {
    await seedReads(2);
    const serialized = JSON.stringify(await page('/api/read-log'));
    for (const forbidden of ['sql', 'params', 'bindings', 'statement', 'SELECT']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
