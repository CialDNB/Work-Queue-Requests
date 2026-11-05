// THE d1 STREAM IS REQUEST-SCOPED — and a request that returned a STREAMING body is not over until
// that body is. Ported from CialDNB/insights (test/framework/read-audit-stream.test.ts and the
// streaming section of its read-audit.test.ts), with logging through logEvent.
//
// Two layers, and the second property is the load-bearing one:
//   1. deferFlushToBodyEnd — the callback fires EXACTLY ONCE, on whichever comes first of the body
//      closing, the reader cancelling (a client disconnect), the body erroring, or the hard timer.
//   2. A BUG IN THE WRAPPER MUST NOT BREAK THE RESPONSE: bytes out identical, a throwing callback
//      does not poison the stream, and a body that cannot be wrapped is served as-is and flushed
//      at once (the pre-deferral behaviour).
// Then through the real pipeline: reads a stream makes AFTER its handler returned are ledgered,
// partial reads survive a disconnect, the timer reclaims an abandoned body, plain values and the
// unarmed path are exactly as before, and HTTP and MCP both inherit it.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../src/auth/types';
import { makeDb } from '../../src/data';
import type { ReadLogRow } from '../../src/data/readLog';
import type { Env } from '../../src/env';
import { defineRoute, mountRoutes, type RouteSpec } from '../../src/framework/defineRoute';
import { executeRoute } from '../../src/framework/execute';
import { readRecorderOf } from '../../src/framework/readAudit';
import {
  deferFlushToBodyEnd,
  flushWhenBodyEnds,
  READ_AUDIT_STREAM_MAX_MS,
  readAuditStreamTimeoutMs,
} from '../../src/framework/readAuditStream';
import { buildMcpTools } from '../../src/mcp/tools';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { cookieFor } from '../helpers/http';
import { type CapturedLogs, captureLogs } from '../helpers/logs';

const ARMED = { ...env, READ_AUDIT: 'on' } as Env;
const encoder = new TextEncoder();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const principal: Principal = {
  kind: 'person',
  email: USERS.admin,
  name: null,
  role: 'admin',
  authMethod: 'magic_link',
  credentialTransport: 'cookie',
};

/** A response whose body emits `chunks` one at a time, then closes. */
function streamed(chunks: readonly string[], init: ResponseInit = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i] as string));
      i += 1;
    },
  });
  return new Response(body, init);
}

let logs: CapturedLogs;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

describe('deferFlushToBodyEnd', () => {
  it('passes every byte through unchanged and fires the callback on normal close', async () => {
    let fired = 0;
    const wrapped = deferFlushToBodyEnd(streamed(['a', 'bb', 'ccc']), () => fired++, 5_000);
    expect(fired).toBe(0);
    expect(await wrapped.text()).toBe('abbccc');
    expect(fired).toBe(1);
  });

  it('preserves status, statusText and headers', async () => {
    const wrapped = deferFlushToBodyEnd(
      streamed(['x'], {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      }),
      () => {},
      5_000,
    );
    expect(wrapped.status).toBe(201);
    expect(wrapped.statusText).toBe('Created');
    expect(wrapped.headers.get('content-type')).toBe('text/event-stream');
    expect(wrapped.headers.get('cache-control')).toBe('no-store');
    expect(await wrapped.text()).toBe('x');
  });

  it('fires the callback once when the reader cancels mid-body', async () => {
    let fired = 0;
    const wrapped = deferFlushToBodyEnd(streamed(['1', '2', '3', '4']), () => fired++, 5_000);
    const reader = (wrapped.body as ReadableStream<Uint8Array>).getReader();
    expect(await reader.read()).toMatchObject({ done: false });
    await reader.cancel();
    expect(fired).toBe(1);
    await reader.cancel(); // a second cancel is a no-op, not a second flush
    expect(fired).toBe(1);
  });

  it('fires the callback on the hard timer when nobody reads the body', async () => {
    let fired = 0;
    deferFlushToBodyEnd(streamed(['held open forever']), () => fired++, 20);
    expect(fired).toBe(0);
    await sleep(60);
    expect(fired).toBe(1);
  });

  it('does not fire twice when the timer and a normal close race', async () => {
    let fired = 0;
    const wrapped = deferFlushToBodyEnd(streamed(['a']), () => fired++, 20);
    expect(await wrapped.text()).toBe('a');
    await sleep(60);
    expect(fired).toBe(1);
  });

  it('a THROWING callback is logged by category, and the body still reads to completion', async () => {
    const wrapped = deferFlushToBodyEnd(
      streamed(['safe']),
      () => {
        throw new RangeError(`flush exploded for ${USERS.admin}`);
      },
      5_000,
    );
    expect(await wrapped.text()).toBe('safe');
    expect(logs.named('read_audit_stream_complete_failed')).toEqual([
      { event: 'read_audit_stream_complete_failed', level: 'error', err: { name: 'RangeError' } },
    ]);
    logs.expectAbsent(USERS.admin);
  });

  it('propagates a body error to the reader AND fires the callback', async () => {
    let fired = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('upstream died'));
      },
    });
    const wrapped = deferFlushToBodyEnd(new Response(body), () => fired++, 5_000);
    await expect(wrapped.text()).rejects.toThrow(/upstream died/);
    expect(fired).toBe(1);
  });

  it('THROWS on a body it cannot wrap (locked, or null), so the caller can fall back', () => {
    const locked = streamed(['x']);
    (locked.body as ReadableStream<Uint8Array>).getReader();
    expect(() => deferFlushToBodyEnd(locked, () => {}, 5_000)).toThrow();
    expect(() => deferFlushToBodyEnd(new Response(null, { status: 204 }), () => {}, 5_000)).toThrow(
      TypeError,
    );
  });
});

describe('flushWhenBodyEnds — the guard executeRoute calls', () => {
  it('a plain value, a thrown handler (undefined) and a 204 flush at once and come back untouched', () => {
    const value = { items: [] };
    const noContent = new Response(null, { status: 204 });
    for (const result of [value, undefined, noContent]) {
      let fired = 0;
      expect(flushWhenBodyEnds(result, () => fired++, 5_000, 'GET /api/x', 'GET')).toBe(result);
      expect(fired).toBe(1);
    }
  });

  it('a HEAD request: the body will never be read, so the ORIGINAL Response and an immediate flush', () => {
    const res = streamed(['payload']);
    let fired = 0;
    expect(flushWhenBodyEnds(res, () => fired++, 5_000, 'GET /api/x', 'HEAD')).toBe(res);
    expect(fired).toBe(1);
    expect(logs.named('read_audit_stream_wrap_failed')).toEqual([]);
  });

  it('a body it cannot wrap: the ORIGINAL Response, an immediate flush, one content-free line', () => {
    const locked = streamed(['payload']);
    (locked.body as ReadableStream<Uint8Array>).getReader();
    let fired = 0;
    expect(flushWhenBodyEnds(locked, () => fired++, 5_000, 'GET /api/x/:id', 'GET')).toBe(locked);
    expect(fired).toBe(1);
    expect(logs.named('read_audit_stream_wrap_failed')).toEqual([
      {
        event: 'read_audit_stream_wrap_failed',
        level: 'error',
        route: 'GET /api/x/:id',
        err: { name: 'TypeError' },
      },
    ]);
  });
});

describe('readAuditStreamTimeoutMs', () => {
  it('defaults to the framework ceiling', () => {
    expect(READ_AUDIT_STREAM_MAX_MS).toBe(120_000);
    expect(readAuditStreamTimeoutMs(env as Env)).toBe(120_000);
  });

  it('honours the override, and ignores every value that is not a positive number', () => {
    expect(readAuditStreamTimeoutMs({ ...env, READ_AUDIT_STREAM_MAX_MS: '25' } as Env)).toBe(25);
    for (const bad of [undefined, '', '0', '-1', 'soon', 'NaN', 'Infinity']) {
      expect(readAuditStreamTimeoutMs({ ...env, READ_AUDIT_STREAM_MAX_MS: bad } as Env)).toBe(
        READ_AUDIT_STREAM_MAX_MS,
      );
    }
  });
});

// ── Through the real pipeline ──────────────────────────────────────────────────────────────

const rows = async (): Promise<ReadLogRow[]> =>
  (await makeDb(env as Env).readLog.list({ limit: 100 })).items;

/** Run a spec and hand back the result BEFORE draining waitUntil (the flush may come later). */
async function runRaw(
  spec: RouteSpec<z.ZodTypeAny>,
  runEnv: Env = ARMED,
): Promise<{ result: unknown; drain: () => Promise<void> }> {
  const pending: Promise<unknown>[] = [];
  const result = await executeRoute(runEnv, spec, principal, {
    ip: '',
    params: {},
    request: new Request('https://x.test/api/t'),
    waitUntil: (p) => {
      pending.push(p);
    },
    buildRawInput: () => ({}),
    invocation: { via: 'http' },
  });
  return {
    result,
    drain: async () => {
      await Promise.allSettled(pending);
    },
  };
}

/** Reads D1 once in the handler and once per tick of its body — the reads that used to be lost. */
function streamingRoute(path: string, ticks: number) {
  return defineRoute({
    method: 'GET',
    path,
    permission: 'authenticated',
    input: z.object({}),
    handler: async (ctx) => {
      await ctx.db.notes.list({ limit: 1 });
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent >= ticks) {
            controller.close();
            return;
          }
          sent += 1;
          await ctx.db.notes.list({ limit: 1 });
          controller.enqueue(encoder.encode(`data: ${sent}\n\n`));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    },
  });
}

function readingRoute(path: string, handler: RouteSpec<z.ZodTypeAny>['handler']) {
  return defineRoute({
    method: 'GET',
    path,
    permission: 'authenticated',
    input: z.object({}),
    handler,
  }).spec;
}

describe('the d1 stream flushes when a streamed BODY ends', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    await makeDb(env as Env).notes.create({ title: 'n', body: '', createdBy: USERS.member });
  });

  it('records the reads a stream makes AFTER the handler returned', async () => {
    const { result, drain } = await runRaw(streamingRoute('/api/stream-reads', 3).spec);
    expect(result).toBeInstanceOf(Response);
    // Nothing is flushed while the body is still open: the request is not over.
    await drain();
    expect(await rows()).toHaveLength(0);

    expect(await (result as Response).text()).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n');
    await drain();
    // ONE row: the handler read and the three identical tick reads aggregate.
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: 'd1',
      source: 'notes',
      query_name: 'list',
      route: 'GET /api/stream-reads',
      principal: USERS.admin,
      row_count: 4,
    });
    expect(logs.named('read_audit_events_dropped')).toEqual([]);
  });

  it('records the partial reads when the client disconnects mid-stream, and flushes ONCE', async () => {
    const { result, drain } = await runRaw(streamingRoute('/api/stream-cancel', 100).spec);
    const reader = ((result as Response).body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    await drain();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.row_count).toBeGreaterThanOrEqual(2);
    expect(all[0]?.row_count).toBeLessThan(20);
    await reader.cancel();
    await drain();
    expect(await rows()).toHaveLength(1);
  });

  it('the hard timer flushes a body nobody ever reads, so a recorder cannot leak', async () => {
    const { drain } = await runRaw(streamingRoute('/api/stream-abandoned', 100).spec, {
      ...ARMED,
      READ_AUDIT_STREAM_MAX_MS: '25',
    } as Env);
    await drain();
    expect(await rows()).toHaveLength(0);
    await sleep(80);
    await drain();
    expect(await rows()).toMatchObject([{ source: 'notes', route: 'GET /api/stream-abandoned' }]);
  });

  it('a wrapper that cannot be built serves the ORIGINAL response and flushes immediately', async () => {
    let original: Response | undefined;
    const spec = readingRoute('/api/stream-unwrappable', async (ctx) => {
      await ctx.db.notes.list({ limit: 1 });
      original = streamed(['payload']);
      // Lock the body to a reader nobody will use: deferFlushToBodyEnd's getReader() throws.
      (original.body as ReadableStream<Uint8Array>).getReader();
      return original;
    });
    const { result, drain } = await runRaw(spec);
    expect(result).toBe(original);
    expect(logs.named('read_audit_stream_wrap_failed')).toHaveLength(1);
    await drain();
    expect((await rows()).map((r) => `${r.source}.${r.query_name}`)).toEqual(['notes.list']);
  });

  it('a PLAIN-VALUE handler is exactly as before: no wrapper, flushed at once', async () => {
    const { result, drain } = await runRaw(
      readingRoute('/api/plain-value', async (ctx) => ctx.db.notes.list({ limit: 5 })),
    );
    expect(result).not.toBeInstanceOf(Response);
    await drain();
    expect((await rows()).map((r) => `${r.source}.${r.query_name}`)).toEqual(['notes.list']);
  });

  it('a BUFFERED Response lands the same row once its body is drained', async () => {
    const { result, drain } = await runRaw(
      readingRoute('/api/buffered', async (ctx) => {
        const page = await ctx.db.notes.list({ limit: 5 });
        return new Response(JSON.stringify({ data: page }), { status: 201 });
      }),
    );
    expect((result as Response).status).toBe(201);
    expect(await (result as Response).text()).toContain('"items"');
    await drain();
    expect((await rows()).map((r) => `${r.source}.${r.query_name}`)).toEqual(['notes.list']);
  });

  it('a handler that THROWS still flushes what it read, at once', async () => {
    const pending: Promise<unknown>[] = [];
    const spec = readingRoute('/api/throws', async (ctx) => {
      await ctx.db.notes.list({ limit: 1 });
      throw new Error('handler failed');
    });
    await expect(
      executeRoute(ARMED, spec, principal, {
        ip: '',
        params: {},
        request: new Request('https://x.test/api/t'),
        waitUntil: (p) => {
          pending.push(p);
        },
        buildRawInput: () => ({}),
        invocation: { via: 'http' },
      }),
    ).rejects.toThrow('handler failed');
    await Promise.allSettled(pending);
    expect((await rows()).map((r) => `${r.source}.${r.query_name}`)).toEqual(['notes.list']);
  });

  it('UNARMED, a streaming route is wrapped by nothing at all', async () => {
    let seenRecorder: unknown = 'unset';
    let original: Response | undefined;
    const spec = readingRoute('/api/stream-unarmed', async (ctx) => {
      seenRecorder = readRecorderOf(ctx.db) ?? null;
      original = streamed(['data: x\n\n']);
      return original;
    });
    const { result, drain } = await runRaw(spec, env as Env);
    expect(seenRecorder).toBeNull();
    expect(result).toBe(original);
    expect(await (result as Response).text()).toBe('data: x\n\n');
    await drain();
    expect(await rows()).toHaveLength(0);
  });
});

describe('every adapter inherits it, because there is one pipeline', () => {
  beforeAll(applySchema);
  beforeEach(async () => {
    await seedDb();
    await makeDb(env as Env).notes.create({ title: 'n', body: '', createdBy: USERS.member });
  });

  it('HTTP: a streamed response is ledgered once the runtime has read its body', async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountRoutes(app, [streamingRoute('/api/http-stream', 2)]);
    const pending: Promise<unknown>[] = [];
    const res = await app.request(
      'https://x.test/api/http-stream',
      { headers: { cookie: await cookieFor(USERS.member) } },
      ARMED,
      {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toBe('data: 1\n\ndata: 2\n\n');
    await Promise.allSettled(pending);
    expect(await rows()).toMatchObject([
      { route: 'GET /api/http-stream', principal: USERS.member, row_count: 3 },
    ]);
  });

  it('HTTP HEAD: the GET route runs and its body is discarded unread, so the flush runs at once', async () => {
    // Hono answers HEAD by dispatching the GET route and returning `new Response(null, res)`: the
    // route's body is dropped without a read or a cancel, so a deferred flush would wait for the
    // hard timer — which a finished request's context may never reach.
    const app = new Hono<{ Bindings: Env }>();
    mountRoutes(app, [
      defineRoute({
        method: 'GET',
        path: '/api/http-head',
        permission: 'authenticated',
        input: z.object({}),
        handler: async (ctx) => {
          const page = await ctx.db.notes.list({ limit: 1 });
          return new Response(JSON.stringify({ data: page.items.length }), { status: 200 });
        },
      }),
    ]);
    const pending: Promise<unknown>[] = [];
    const res = await app.request(
      'https://x.test/api/http-head',
      { method: 'HEAD', headers: { cookie: await cookieFor(USERS.member) } },
      { ...ARMED, READ_AUDIT_STREAM_MAX_MS: '600000' } as Env,
      {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    await Promise.allSettled(pending);
    expect(await rows()).toMatchObject([
      { route: 'GET /api/http-head', principal: USERS.member, source: 'notes' },
    ]);
  });

  it('MCP: the tool call unwraps the body, so the flush is drained before it returns', async () => {
    const [tool] = buildMcpTools([streamingRoute('/api/mcp-stream', 2)]);
    const result = await tool?.invoke(ARMED, principal, {});
    expect(result?.isError).toBeUndefined();
    expect(await rows()).toMatchObject([
      { route: 'GET /api/mcp-stream', principal: USERS.admin, row_count: 3 },
    ]);
  });
});
