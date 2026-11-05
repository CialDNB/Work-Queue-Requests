// streamAnthropic end to end with a fake provider: the gateway contract on streaming requests,
// every stop reason, and — the part that must never regress — the budget settled exactly once on
// every exit path: completion, refusal, provider error, truncation, abort, and a consumer that
// stops iterating.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AiCallInput,
  type AiStreamEvent,
  callAnthropic,
  type Fetcher,
  gatewayMessagesUrl,
  isModelOutput,
  streamAnthropic,
} from '../../src/ai/anthropic';
import { todayUtc } from '../../src/ai/budget';
import { costUsd } from '../../src/ai/pricing';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { AppError } from '../../src/framework/errors';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { loggedEvents } from '../helpers/logs';

const enc = new TextEncoder();

const gatewayEnv = (over: Partial<Env> = {}): Env => ({
  ...env,
  ANTHROPIC_API_KEY: 'sk-ant-test-synthetic',
  AI_GATEWAY_ID: 'all-pr-apps',
  AI_GATEWAY_TOKEN: 'gw-test-token',
  CF_ACCOUNT_ID: 'acct-test-123',
  ...over,
});

const MODEL = 'claude-sonnet-5';
// For the output-floor examples: the previous tokenizer (~4 characters per token), and no thinking
// unless a request turns it on — every token it generates is visible on the stream.
const VISIBLE = 'claude-sonnet-4-6';

/** Provider events → SSE text, the way the API frames them. */
function sse(events: readonly Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const messageStart = (
  usage: Record<string, unknown> = { input_tokens: 1000, output_tokens: 1 },
  model = MODEL,
) => ({
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    usage,
  },
});
const textBlock = (index: number, ...parts: string[]) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  ...parts.map((text) => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  })),
  { type: 'content_block_stop', index },
];
const messageEnd = (stopReason: string, outputTokens = 500) => [
  {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  },
  { type: 'message_stop' },
];

/** A reply streamed in chunks of `chunkSize` bytes (1 = byte by byte). */
function streamed(text: string, chunkSize = 64): Response {
  const bytes = enc.encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** A provider stream the test drives by hand; it honors the request's abort signal like fetch. */
function liveStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const fetcher: Fetcher = async (_url, init) => {
    init.signal?.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('The operation was aborted', 'AbortError'));
      } catch {
        /* already closed */
      }
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  return {
    fetcher,
    state,
    push(events: readonly Record<string, unknown>[]) {
      controller.enqueue(enc.encode(sse(events)));
    },
    close() {
      controller.close();
    },
  };
}

const input = (over: Partial<AiCallInput> = {}): AiCallInput => ({
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 1000,
  model: MODEL,
  ...over,
});

/** Drain a stream: every event, and what it threw (if anything). */
async function drain(
  stream: AsyncGenerator<AiStreamEvent>,
): Promise<{ events: AiStreamEvent[]; error: unknown }> {
  const events: AiStreamEvent[] = [];
  try {
    for await (const e of stream) events.push(e);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

async function ledger(): Promise<{
  user: number;
  global: number;
  rows: { model: string; input_tokens: number; output_tokens: number; cost_usd: number }[];
}> {
  const repo = makeDb(env).aiBudget;
  const { results } = await env.DB.prepare(
    'SELECT model, input_tokens, output_tokens, cost_usd FROM ai_usage',
  ).all<{ model: string; input_tokens: number; output_tokens: number; cost_usd: number }>();
  return {
    user: await repo.reservedToday(`u:${USERS.member}`, todayUtc()),
    global: await repo.reservedToday('g', todayUtc()),
    rows: results,
  };
}

/** Settled at exactly `usd`: both scopes, and one ledger row carrying it. */
async function expectBooked(usd: number): Promise<void> {
  const l = await ledger();
  expect(l.user).toBeCloseTo(usd, 6);
  expect(l.global).toBeCloseTo(usd, 6);
  expect(l.rows).toHaveLength(1);
  expect(l.rows[0]?.cost_usd).toBeCloseTo(usd, 6);
}

async function expectReleased(): Promise<void> {
  expect(await ledger()).toEqual({ user: 0, global: 0, rows: [] });
}

describe('streamAnthropic — the gateway contract on streaming requests', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  it('keeps every cf-aig header, pins the region and asks for a stream', async () => {
    let seen: {
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    } | null = null;
    await drain(
      streamAnthropic(
        gatewayEnv({ APP_NAME: 'test-app' }),
        USERS.member,
        input({ feature: 'unit-test' }),
        async (url, init) => {
          seen = {
            url,
            headers: init.headers as Record<string, string>,
            body: JSON.parse(init.body as string),
          };
          return streamed(sse([messageStart(), ...textBlock(0, 'ok'), ...messageEnd('end_turn')]));
        },
      ),
    );
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe(gatewayMessagesUrl('acct-test-123', 'all-pr-apps'));
    expect(seen!.headers).toMatchObject({
      'cf-aig-collect-log-payload': 'false',
      'cf-aig-skip-cache': 'true',
      'cf-aig-authorization': 'Bearer gw-test-token',
      'anthropic-version': '2023-06-01',
    });
    expect(JSON.parse(seen!.headers['cf-aig-metadata'] as string)).toEqual({
      app: 'test-app',
      env: 'test',
      feature: 'unit-test',
    });
    expect(seen!.headers).not.toHaveProperty('anthropic-beta');
    expect(seen!.body).toMatchObject({ stream: true, inference_geo: 'us', model: MODEL });
  });

  it('refuses the direct fallback in production before any request, reserving nothing', async () => {
    let called = false;
    const { error, events } = await drain(
      streamAnthropic(
        { ...env, ANTHROPIC_API_KEY: 'sk-ant-test-synthetic', APP_ENV: 'production' },
        USERS.member,
        input(),
        async () => {
          called = true;
          return streamed('');
        },
      ),
    );
    expect(error).toMatchObject({ status: 503, code: 'ai_unconfigured' });
    expect(events).toEqual([]);
    expect(called).toBe(false);
    await expectReleased();
  });

  it('runs every gate before the request: allowlist, ZDR guard, budget — no events, nothing reserved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const never: Fetcher = async () => {
      throw new Error('must not be called');
    };
    const cases: [Env, AiCallInput, string][] = [
      [gatewayEnv(), input({ model: 'claude-haiku-4-5' }), 'ai_model_not_allowed'],
      [
        gatewayEnv(),
        input({ tools: [{ type: 'web_search_20260209', name: 'web_search' } as never] }),
        'ai_request_refused',
      ],
      [gatewayEnv({ AI_MAX_CALL_USD: '0.0001' }), input(), 'ai_budget_per_call_cap'],
      [gatewayEnv({ AI_INFERENCE_GEO: 'eu' }), input(), 'ai_unconfigured'],
    ];
    for (const [testEnv, callInput, code] of cases) {
      const { error, events } = await drain(
        streamAnthropic(testEnv, USERS.member, callInput, never),
      );
      expect(error, code).toMatchObject({ code });
      expect(events, code).toEqual([]);
    }
    await expectReleased();
  });

  it('a stream that is never iterated sends nothing and reserves nothing', async () => {
    let called = false;
    streamAnthropic(gatewayEnv(), USERS.member, input(), async () => {
      called = true;
      return streamed('');
    });
    await Promise.resolve();
    expect(called).toBe(false);
    await expectReleased();
  });
});

describe('streamAnthropic — stop reasons and the final result', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  // (1000 in @ $2/M + 500 out @ $10/M) × 1.1 for the us pin.
  const USD = ((1000 * 2 + 500 * 10) / 1e6) * 1.1;

  it('end_turn: text deltas, then message_stop with the whole result; settled at actual', async () => {
    const { events, error } = await drain(
      streamAnthropic(gatewayEnv(), USERS.member, input(), async () =>
        streamed(
          sse([messageStart(), ...textBlock(0, 'Hello', ', world'), ...messageEnd('end_turn')]),
        ),
      ),
    );
    expect(error).toBeNull();
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'text_delta',
      'text_delta',
      'message_delta',
      'message_stop',
    ]);
    const last = events.at(-1);
    expect(last?.type === 'message_stop' && last.result).toMatchObject({
      text: 'Hello, world',
      content: [{ type: 'text', text: 'Hello, world' }],
      model: MODEL,
      stopReason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    expect(last?.type === 'message_stop' && last.result.costUsd).toBeCloseTo(USD, 6);
    await expectBooked(USD);
  });

  it('yields identical events however the network cuts the bytes (byte by byte, odd chunks)', async () => {
    const text = sse([
      messageStart(),
      ...textBlock(0, 'שלום 🌍', ' olá'),
      ...messageEnd('end_turn'),
    ]);
    const runs: AiStreamEvent[][] = [];
    for (const size of [1, 3, 7, 4096]) {
      await seedDb();
      runs.push(
        (
          await drain(
            streamAnthropic(gatewayEnv(), USERS.member, input(), async () => streamed(text, size)),
          )
        ).events,
      );
    }
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0]);
    expect(runs[0]?.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', index: 0, text: 'שלום 🌍' },
      { type: 'text_delta', index: 0, text: ' olá' },
    ]);
  });

  it('tool_use: start, input deltas and a parsed stop per call, thinking kept for the round trip', async () => {
    const { events } = await drain(
      streamAnthropic(
        gatewayEnv(),
        USERS.member,
        input({ tools: [{ name: 'get_weather', input_schema: { type: 'object' } }] }),
        async () =>
          streamed(
            sse([
              messageStart(),
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '', signature: '' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'sig-synthetic' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
              },
              {
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'input_json_delta', partial_json: '{"city":' },
              },
              {
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'input_json_delta', partial_json: '"Springfield"}' },
              },
              { type: 'content_block_stop', index: 1 },
              ...messageEnd('tool_use'),
            ]),
          ),
      ),
    );
    expect(events.filter((e) => e.type.startsWith('tool_'))).toEqual([
      { type: 'tool_use_start', index: 1, id: 'toolu_1', name: 'get_weather' },
      { type: 'tool_input_delta', index: 1, partialJson: '{"city":' },
      { type: 'tool_input_delta', index: 1, partialJson: '"Springfield"}' },
      {
        type: 'tool_use_stop',
        index: 1,
        id: 'toolu_1',
        name: 'get_weather',
        input: { city: 'Springfield' },
      },
    ]);
    const last = events.at(-1);
    expect(last?.type === 'message_stop' && last.result.stopReason).toBe('tool_use');
    expect(last?.type === 'message_stop' && last.result.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-synthetic' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Springfield' } },
    ]);
    // The streamed result's content is fresh model output too (see isModelOutput), and a copy of
    // it is not.
    expect(last?.type === 'message_stop' && isModelOutput(last.result.content)).toBe(true);
    expect(last?.type === 'message_stop' && isModelOutput([...last.result.content])).toBe(false);
  });

  it('max_tokens and pause_turn are surfaced for the caller to act on, and billed normally', async () => {
    for (const stopReason of ['max_tokens', 'pause_turn', 'model_context_window_exceeded']) {
      await seedDb();
      const { events, error } = await drain(
        streamAnthropic(gatewayEnv(), USERS.member, input(), async () =>
          streamed(sse([messageStart(), ...textBlock(0, 'half a'), ...messageEnd(stopReason)])),
        ),
      );
      expect(error, stopReason).toBeNull();
      const last = events.at(-1);
      expect(last?.type === 'message_stop' && last.result.stopReason, stopReason).toBe(stopReason);
      await expectBooked(USD);
    }
  });

  it('a refusal reporting no tokens at all: an ai_refused error event, a 422, and the reservation released', async () => {
    const { events, error } = await drain(
      streamAnthropic(gatewayEnv(), USERS.member, input(), async () =>
        streamed(
          sse([messageStart({ input_tokens: 0, output_tokens: 0 }), ...messageEnd('refusal', 0)]),
        ),
      ),
    );
    expect(events.at(-1)).toEqual({ type: 'error', code: 'ai_refused' });
    expect(events.map((e) => e.type)).not.toContain('message_stop');
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 422, code: 'ai_refused' });
    await expectReleased();
  });

  it('a pre-output refusal in the documented shape (input reported, output 0) books that input — over, never under', async () => {
    // The refusals docs: "token counts appear in usage but are not charged". The client books what
    // a refusal reports regardless, so this over-reads by the reported input; it never releases a
    // decline that did report tokens.
    const { events, error } = await drain(
      streamAnthropic(gatewayEnv(), USERS.member, input(), async () =>
        streamed(
          sse([messageStart({ input_tokens: 412, output_tokens: 0 }), ...messageEnd('refusal', 0)]),
        ),
      ),
    );
    expect(events.at(-1)).toEqual({ type: 'error', code: 'ai_refused' });
    expect(error).toMatchObject({ status: 422, code: 'ai_refused' });
    await expectBooked(costUsd(MODEL, { input_tokens: 412, output_tokens: 0 }, 'us'));
  });

  it('refusal mid-output: the partial text streamed, then ai_refused — billed at actual', async () => {
    const partial = 'synthetic-partial-4e2a';
    const { events, error } = await drain(
      streamAnthropic(gatewayEnv(), USERS.member, input(), async () =>
        streamed(sse([messageStart(), ...textBlock(0, partial), ...messageEnd('refusal', 200)])),
      ),
    );
    expect(events.at(-1)).toEqual({ type: 'error', code: 'ai_refused' });
    expect((error as AppError).message).not.toContain(partial);
    await expectBooked(((1000 * 2 + 200 * 10) / 1e6) * 1.1);
  });
});

describe('streamAnthropic — a stop that cuts a tool call short', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  const RUN = { name: 'run_task', input_schema: { type: 'object' as const } };
  // A tool call the model is part-way through: its input is not yet a JSON object.
  const cutToolCall = (closed: boolean) => [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_task', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"cmd":"rm -' },
    },
    ...(closed ? [{ type: 'content_block_stop', index: 0 }] : []),
  ];

  it('a refusal while a tool call is open is ai_refused (422) — not a malformed-stream 502', async () => {
    // Review finding: the refusals docs return such a streaming decline directly; it used to fail
    // as ai_upstream_error, which a caller retries — and each retry is billed.
    for (const closed of [true, false]) {
      await seedDb();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { events, error } = await drain(
        streamAnthropic(
          gatewayEnv(),
          USERS.member,
          input({ model: 'claude-opus-5-5', tools: [RUN] }),
          async () =>
            streamed(
              sse([
                messageStart({ input_tokens: 1000, output_tokens: 1 }, 'claude-opus-5-5'),
                ...cutToolCall(closed),
                ...messageEnd('refusal', 12),
              ]),
            ),
        ),
      );
      expect(events.at(-1), `closed: ${closed}`).toEqual({ type: 'error', code: 'ai_refused' });
      expect(events.map((e) => e.type)).not.toContain('tool_use_stop');
      expect(error, `closed: ${closed}`).toMatchObject({ status: 422, code: 'ai_refused' });
      expect(loggedEvents(warn.mock.calls)).toContainEqual({
        event: 'ai_call_refused',
        model: 'claude-opus-5-5',
      });
      expect(loggedEvents(failed.mock.calls)).not.toContainEqual(
        expect.objectContaining({ event: 'ai_stream_failed', fault: 'malformed' }),
      );
      // A mid-stream refusal bills the input and the output already generated, as reported.
      await expectBooked(
        costUsd('claude-opus-5-5', { input_tokens: 1000, output_tokens: 12 }, 'us'),
      );
      vi.restoreAllMocks();
    }
  });

  it('model_context_window_exceeded mid-call is surfaced like max_tokens: the partial call is never offered', async () => {
    for (const stopReason of ['model_context_window_exceeded', 'max_tokens']) {
      await seedDb();
      const { events, error } = await drain(
        streamAnthropic(gatewayEnv(), USERS.member, input({ tools: [RUN] }), async () =>
          streamed(sse([messageStart(), ...cutToolCall(true), ...messageEnd(stopReason)])),
        ),
      );
      expect(error, stopReason).toBeNull();
      expect(events.map((e) => e.type)).not.toContain('tool_use_stop');
      const last = events.at(-1);
      expect(last?.type === 'message_stop' && last.result.stopReason).toBe(stopReason);
      expect(last?.type === 'message_stop' && last.result.content).toEqual([]);
      await expectBooked(((1000 * 2 + 500 * 10) / 1e6) * 1.1);
    }
  });

  it('the same cut call after end_turn is a corrupt stream: 502, the reported usage booked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { error } = await drain(
      streamAnthropic(gatewayEnv(), USERS.member, input({ tools: [RUN] }), async () =>
        streamed(sse([messageStart(), ...cutToolCall(true), ...messageEnd('end_turn')])),
      ),
    );
    expect(error).toMatchObject({ status: 502, code: 'ai_upstream_error' });
    await expectBooked(((1000 * 2 + 500 * 10) / 1e6) * 1.1);
  });
});

describe('streamAnthropic — only the tools the request offered', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  it('a call for a tool the request did not offer is never announced: a 502, the log names the rule only', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, error } = await drain(
      streamAnthropic(
        gatewayEnv(),
        USERS.member,
        input({ tools: [{ name: 'get_weather', input_schema: { type: 'object' } }] }),
        async () =>
          streamed(
            sse([
              messageStart(),
              {
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'tool_use',
                  id: 'toolu_1',
                  name: 'delete_records',
                  input: {},
                },
              },
              ...messageEnd('tool_use'),
            ]),
          ),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['message_start', 'error']);
    expect(events.at(-1)).toEqual({ type: 'error', code: 'ai_upstream_error' });
    expect(error).toMatchObject({ status: 502, code: 'ai_upstream_error' });
    expect(loggedEvents(spy.mock.calls)).toContainEqual({
      event: 'ai_stream_failed',
      fault: 'unoffered_tool',
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('delete_records');
  });
});

describe('streamAnthropic — the budget is settled once on every exit path', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  // The output floors below (streamed characters / 4) are the previous tokenizer's.
  const vInput = (over: Partial<AiCallInput> = {}) => input({ model: VISIBLE, ...over });
  const vStart = (usage?: Record<string, unknown>) => messageStart(usage, VISIBLE);

  it('abort mid-stream: an ai_aborted event, a 499, and the usage observed so far booked', async () => {
    const live = liveStream();
    const controller = new AbortController();
    const stream = streamAnthropic(
      gatewayEnv(),
      USERS.member,
      vInput({ signal: controller.signal }),
      live.fetcher,
    );
    live.push([
      vStart({ input_tokens: 1000, output_tokens: 1 }),
      ...textBlock(0, 'x'.repeat(40)).slice(0, 2),
    ]);
    const seen: AiStreamEvent[] = [];
    let error: unknown = null;
    try {
      for await (const e of stream) {
        seen.push(e);
        if (e.type === 'text_delta') controller.abort();
      }
    } catch (err) {
      error = err;
    }
    expect(seen.at(-1)).toEqual({ type: 'error', code: 'ai_aborted' });
    expect(error).toMatchObject({ status: 499, code: 'ai_aborted' });
    // Input from message_start; output floored at the 40 streamed characters / 4 = 10.
    await expectBooked(costUsd(VISIBLE, { input_tokens: 1000, output_tokens: 10 }, 'us'));
  });

  it('a consumer that stops iterating is settled too — and the provider body is cancelled', async () => {
    const live = liveStream();
    const stream = streamAnthropic(gatewayEnv(), USERS.member, vInput(), live.fetcher);
    live.push([
      vStart({ input_tokens: 1000, output_tokens: 1 }),
      ...textBlock(0, 'y'.repeat(20)).slice(0, 2),
    ]);
    for await (const e of stream) if (e.type === 'text_delta') break;
    expect(live.state.cancelled).toBe(true);
    await expectBooked(costUsd(VISIBLE, { input_tokens: 1000, output_tokens: 5 }, 'us'));
  });

  it('a consumer that stops after message_stop leaves exactly one settlement', async () => {
    const stream = streamAnthropic(gatewayEnv(), USERS.member, input(), async () =>
      streamed(sse([messageStart(), ...textBlock(0, 'done'), ...messageEnd('end_turn')])),
    );
    for await (const e of stream) if (e.type === 'message_stop') break;
    await expectBooked(((1000 * 2 + 500 * 10) / 1e6) * 1.1);
  });

  it('a provider error event mid-stream: its type (only) in the error event, a 502, observed usage booked', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, error } = await drain(
      streamAnthropic(gatewayEnv(), USERS.member, vInput(), async () =>
        streamed(
          sse([
            vStart(),
            ...textBlock(0, 'abcdefgh'),
            {
              type: 'error',
              error: { type: 'overloaded_error', message: 'synthetic-provider-text-9b1f' },
            },
          ]),
        ),
      ),
    );
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'ai_upstream_error',
      providerErrorType: 'overloaded_error',
    });
    expect(error).toMatchObject({ status: 502, code: 'ai_upstream_error' });
    expect(loggedEvents(spy.mock.calls)).toContainEqual({
      event: 'ai_stream_failed',
      fault: 'provider_error',
      error_type: 'overloaded_error',
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('synthetic-provider-text');
    await expectBooked(costUsd(VISIBLE, { input_tokens: 1000, output_tokens: 2 }, 'us'));
  });

  it('a truncated stream (no message_stop) fails as ai_upstream_error and books what was observed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, error } = await drain(
      streamAnthropic(gatewayEnv(), USERS.member, vInput(), async () =>
        streamed(
          `${sse([vStart(), ...textBlock(0, 'abcd')])}event: message_delta\ndata: {"type":"mess`,
        ),
      ),
    );
    expect(events.at(-1)).toEqual({ type: 'error', code: 'ai_upstream_error' });
    expect(error).toMatchObject({ status: 502, code: 'ai_upstream_error' });
    await expectBooked(costUsd(VISIBLE, { input_tokens: 1000, output_tokens: 1 }, 'us'));
  });

  it('a malformed event fails the stream the same way', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { error } = await drain(
      streamAnthropic(gatewayEnv(), USERS.member, vInput(), async () =>
        streamed(`${sse([vStart()])}event: content_block_delta\ndata: {nope\n\n`),
      ),
    );
    expect(error).toMatchObject({ status: 502, code: 'ai_upstream_error' });
    await expectBooked(costUsd(VISIBLE, { input_tokens: 1000, output_tokens: 1 }, 'us'));
  });

  it('a 2xx with no stream events at all still bills the estimated input (the request was accepted)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { error } = await drain(
      streamAnthropic(
        gatewayEnv(),
        USERS.member,
        vInput({ messages: [{ role: 'user', content: 'z'.repeat(400) }] }),
        async () => streamed(''),
      ),
    );
    expect(error).toMatchObject({ status: 502, code: 'ai_upstream_error' });
    await expectBooked(costUsd(VISIBLE, { input_tokens: 100, output_tokens: 0 }, 'us'));
  });

  it('before the provider answers — non-2xx, network error, an abort before sending — everything is released', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = ['synthetic-echo', '3c7d'].join('-');
    const aborted = new AbortController();
    aborted.abort();
    let sentAborted = 0;
    const cases: [Fetcher, AiCallInput, number, string][] = [
      [
        async () =>
          Response.json(
            { type: 'error', error: { type: 'overloaded_error', message: secret } },
            { status: 529 },
          ),
        input(),
        502,
        'ai_upstream_error',
      ],
      [
        async () => {
          throw new TypeError(`network ${secret}`);
        },
        input(),
        502,
        'ai_upstream_error',
      ],
      [
        async (_url, init) => {
          sentAborted++;
          if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
          return streamed('');
        },
        input({ signal: aborted.signal }),
        499,
        'ai_aborted',
      ],
    ];
    for (const [fetcher, callInput, status, code] of cases) {
      const { events, error } = await drain(
        streamAnthropic(gatewayEnv(), USERS.member, callInput, fetcher),
      );
      expect(events, code).toEqual([]);
      expect(error, code).toMatchObject({ status, code });
    }
    // Aborted before the request was sent: it never leaves, so nothing was billed.
    expect(sentAborted).toBe(0);
    expect(loggedEvents(spy.mock.calls)).toContainEqual({
      event: 'ai_call_failed',
      status: 529,
      error_type: 'overloaded_error',
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
    await expectReleased();
  });

  it('an abort after the request is sent, before the 2xx: a 499 with no event, and the estimate booked — never released', async () => {
    // Review finding: this released everything, while the provider charges a request whose client
    // disconnects part-way — so each abort could spend with nothing booked. Nothing was observed,
    // so it books the estimate's input, plus max_tokens where output may be hidden.
    const cases: [AiCallInput, number][] = [
      // Visible output: the estimate's input (400 characters at ~4 per token), no output.
      [
        vInput({ messages: [{ role: 'user', content: 'z'.repeat(400) }] }),
        costUsd(VISIBLE, { input_tokens: 100, output_tokens: 0 }, 'us'),
      ],
      // Thinks without streaming it: the estimate's input ('hi' is 1 token) and all max_tokens.
      [input(), costUsd(MODEL, { input_tokens: 1, output_tokens: 1000 }, 'us')],
    ];
    for (const [callInput, booked] of cases) {
      await seedDb();
      const controller = new AbortController();
      let sent = false;
      const { events, error } = await drain(
        streamAnthropic(
          gatewayEnv(),
          USERS.member,
          { ...callInput, signal: controller.signal },
          async (_url, init) => {
            sent = true;
            controller.abort();
            expect(init.signal?.aborted).toBe(true);
            throw new DOMException('aborted', 'AbortError');
          },
        ),
      );
      expect(sent).toBe(true);
      expect(events).toEqual([]);
      expect(error).toMatchObject({ status: 499, code: 'ai_aborted' });
      await expectBooked(booked);
    }
  });
});

describe('streamAnthropic — an early stop where output may be hidden books the whole max_tokens', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  // Thinking under display "omitted" (the default on Opus 5.5, Opus 5 and Sonnet 5): the block
  // opens, one empty thinking_delta, then — after the model has thought — a signature.
  const thinkingOpen = (index: number) => [
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: '' } },
  ];
  const thinkingDone = (index: number) => [
    ...thinkingOpen(index),
    { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index },
  ];

  /** Pull events until `stopAt` returns true, then abort; drain what follows. */
  async function abortWhen(
    stream: AsyncGenerator<AiStreamEvent>,
    controller: AbortController,
    stopAt: (e: AiStreamEvent) => boolean,
  ): Promise<{ events: AiStreamEvent[]; error: unknown }> {
    const events: AiStreamEvent[] = [];
    try {
      for await (const e of stream) {
        events.push(e);
        if (stopAt(e)) controller.abort();
      }
      return { events, error: null };
    } catch (error) {
      return { events, error };
    }
  }

  it('Stop while Opus 5.5 is thinking — nothing streamed — books max_tokens, not ~0', async () => {
    // Review finding: this booked input 10 / output 1 (~$0.00007) against a $0.44 reservation,
    // while the provider bills every thinking token generated; repeated, the daily caps never trip.
    const live = liveStream();
    const controller = new AbortController();
    const stream = streamAnthropic(
      gatewayEnv(),
      USERS.member,
      input({ model: 'claude-opus-5-5', maxTokens: 20_000, signal: controller.signal }),
      live.fetcher,
    );
    live.push([
      messageStart({ input_tokens: 10, output_tokens: 1 }, 'claude-opus-5-5'),
      ...thinkingOpen(0),
    ]);
    const { events, error } = await abortWhen(
      stream,
      controller,
      (e) => e.type === 'message_start',
    );
    expect(events.at(-1)).toEqual({ type: 'error', code: 'ai_aborted' });
    expect(error).toMatchObject({ status: 499, code: 'ai_aborted' });
    await expectBooked(
      costUsd('claude-opus-5-5', { input_tokens: 10, output_tokens: 20_000 }, 'us'),
    );
  });

  it('twenty such Stops book twenty max_tokens — the per-user day trips instead of never', async () => {
    const perCall = costUsd('claude-opus-5-5', { input_tokens: 10, output_tokens: 20_000 }, 'us');
    let refused: unknown = null;
    let stops = 0;
    for (; stops < 20; stops++) {
      const live = liveStream();
      const controller = new AbortController();
      const stream = streamAnthropic(
        gatewayEnv(),
        USERS.member,
        input({ model: 'claude-opus-5-5', maxTokens: 20_000, signal: controller.signal }),
        live.fetcher,
      );
      live.push([
        messageStart({ input_tokens: 10, output_tokens: 1 }, 'claude-opus-5-5'),
        ...thinkingOpen(0),
      ]);
      const { error } = await abortWhen(stream, controller, (e) => e.type === 'message_start');
      if ((error as AppError).code !== 'ai_aborted') {
        refused = error;
        break;
      }
    }
    // $5 per user per day at ~$0.44 a Stop: the cap refuses the twelfth.
    expect(refused).toMatchObject({ status: 429, code: 'ai_budget_user_daily_cap' });
    expect(stops).toBe(Math.floor(5 / perCall));
  });

  it('Stop before any block opens on a thinking-by-default model books max_tokens (thinking may not have opened its block)', async () => {
    const live = liveStream();
    const controller = new AbortController();
    const stream = streamAnthropic(
      gatewayEnv(),
      USERS.member,
      input({ signal: controller.signal }),
      live.fetcher,
    );
    live.push([messageStart({ input_tokens: 1000, output_tokens: 1 })]);
    const { error } = await abortWhen(stream, controller, (e) => e.type === 'message_start');
    expect(error).toMatchObject({ status: 499, code: 'ai_aborted' });
    await expectBooked(costUsd(MODEL, { input_tokens: 1000, output_tokens: 1000 }, 'us'));
  });

  it('a consumer that breaks during text, after a thinking block, books max_tokens — the thinking was never counted', async () => {
    const live = liveStream();
    const stream = streamAnthropic(gatewayEnv(), USERS.member, input(), live.fetcher);
    live.push([
      messageStart({ input_tokens: 1000, output_tokens: 1 }),
      ...thinkingDone(0),
      ...textBlock(1, 'visible text').slice(0, 2),
    ]);
    for await (const e of stream) if (e.type === 'text_delta') break;
    expect(live.state.cancelled).toBe(true);
    await expectBooked(costUsd(MODEL, { input_tokens: 1000, output_tokens: 1000 }, 'us'));
  });

  it('a thinking block on a model that does not think by default books max_tokens too', async () => {
    const live = liveStream();
    const controller = new AbortController();
    const stream = streamAnthropic(
      gatewayEnv(),
      USERS.member,
      input({ model: VISIBLE, signal: controller.signal }),
      live.fetcher,
    );
    live.push([
      messageStart({ input_tokens: 1000, output_tokens: 1 }, VISIBLE),
      ...thinkingDone(0),
    ]);
    const { error } = await abortWhen(stream, controller, (e) => e.type === 'message_start');
    expect(error).toMatchObject({ status: 499, code: 'ai_aborted' });
    await expectBooked(costUsd(VISIBLE, { input_tokens: 1000, output_tokens: 1000 }, 'us'));
  });

  it('once message_delta has counted the output, a stream cut before message_stop books that count', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { error } = await drain(
      streamAnthropic(gatewayEnv(), USERS.member, input(), async () =>
        streamed(
          sse([
            messageStart({ input_tokens: 1000, output_tokens: 1 }),
            ...thinkingDone(0),
            ...textBlock(1, 'done'),
            messageEnd('end_turn', 321)[0] as Record<string, unknown>,
          ]),
        ),
      ),
    );
    expect(error).toMatchObject({ status: 502, code: 'ai_upstream_error' });
    await expectBooked(costUsd(MODEL, { input_tokens: 1000, output_tokens: 321 }, 'us'));
  });
});

describe('callAnthropic — abort', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('a signal aborted before the call is a 499 that never reaches the provider and releases the reservation', async () => {
    const controller = new AbortController();
    controller.abort();
    let sent = false;
    await expect(
      callAnthropic(gatewayEnv(), USERS.member, input({ signal: controller.signal }), async () => {
        sent = true;
        return Response.json({});
      }),
    ).rejects.toMatchObject({ status: 499, code: 'ai_aborted' });
    expect(sent).toBe(false);
    await expectReleased();
  });

  it('an abort after the request is sent, before the 2xx, is a 499 that books the reservation', async () => {
    // Review finding: this released everything. The provider generates a non-streaming message
    // whole before its 2xx, and still charges a request whose client disconnects or times out
    // part-way, so each abort could spend up to the per-call cap with nothing booked.
    const controller = new AbortController();
    let during = -1;
    await expect(
      callAnthropic(
        gatewayEnv(),
        USERS.member,
        input({ signal: controller.signal, maxTokens: 20_000 }),
        async (_url, init) => {
          during = (await ledger()).user;
          controller.abort();
          expect(init.signal?.aborted).toBe(true);
          throw new DOMException('aborted', 'AbortError');
        },
      ),
    ).rejects.toMatchObject({ status: 499, code: 'ai_aborted' });
    expect(during).toBeGreaterThan(0.2);
    await expectBooked(during);
  });

  it('repeated aborts after sending trip the per-user day instead of never', async () => {
    // $5 per user per day at ~$0.22 an aborted call (max_tokens 20,000 on sonnet-5).
    let refused: unknown = null;
    let aborts = 0;
    let perCall = 0;
    for (; aborts < 30; aborts++) {
      const controller = new AbortController();
      try {
        await callAnthropic(
          gatewayEnv(),
          USERS.member,
          input({ signal: controller.signal, maxTokens: 20_000 }),
          async () => {
            if (aborts === 0) perCall = (await ledger()).user;
            controller.abort();
            throw new DOMException('aborted', 'AbortError');
          },
        );
      } catch (error) {
        if ((error as AppError).code !== 'ai_aborted') {
          refused = error;
          break;
        }
      }
    }
    expect(refused).toMatchObject({ status: 429, code: 'ai_budget_user_daily_cap' });
    expect(aborts).toBe(Math.floor(5 / perCall));
  });

  it('an abort after the 2xx, while the body is still arriving, is ai_aborted — and books the reservation', async () => {
    // Review finding: this released everything. A non-streaming 2xx is sent once the message is
    // complete, so the provider has billed it; the reservation is the bound on what it cost.
    const live = liveStream();
    const controller = new AbortController();
    let during = -1;
    const pending = callAnthropic(
      gatewayEnv(),
      USERS.member,
      input({ signal: controller.signal, maxTokens: 20_000 }),
      async (url, init) => {
        during = (await ledger()).user;
        return live.fetcher(url, init);
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    live.push([]); // nothing whole arrives
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 499, code: 'ai_aborted' });
    expect(during).toBeGreaterThan(0.2);
    await expectBooked(during);
  });
});
