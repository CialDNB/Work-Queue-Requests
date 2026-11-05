// The SSE layer of the streaming client: the byte parser (chunk boundaries anywhere) and the
// Messages-stream accumulator (normalized events, the assembled message, abort accounting).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateRequest } from '../../src/ai/pricing';
import {
  MessageStream,
  type MessageStreamOptions,
  parseSse,
  type SseEvent,
  StreamFault,
} from '../../src/ai/sse';
import { loggedEvents } from '../helpers/logs';

const enc = new TextEncoder();

function streamOf(
  chunks: readonly Uint8Array[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function parse(chunks: readonly Uint8Array[]): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of parseSse(streamOf(chunks))) out.push(e);
  return out;
}

/** Every way to cut `bytes` into two chunks, plus one byte at a time. */
function everySplit(bytes: Uint8Array): Uint8Array[][] {
  const splits: Uint8Array[][] = [];
  for (let i = 0; i <= bytes.length; i++) splits.push([bytes.slice(0, i), bytes.slice(i)]);
  splits.push(Array.from(bytes, (b) => Uint8Array.of(b)));
  return splits;
}

// Multi-byte text on purpose: Hebrew is 2 bytes a character, the emoji 4 — a cut can land inside.
const TEXT = 'שלום 🌍 olá';
const STREAM = [
  'event: message_start',
  `data: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":12,"output_tokens":1}}}`,
  '',
  ': a comment line',
  'event: ping',
  'data: {"type": "ping"}',
  '',
  'event: content_block_delta',
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${TEXT}"}}`,
  '',
  '',
].join('\n');

const EXPECTED: SseEvent[] = [
  {
    event: 'message_start',
    data: '{"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":12,"output_tokens":1}}}',
  },
  { event: 'ping', data: '{"type": "ping"}' },
  {
    event: 'content_block_delta',
    data: `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${TEXT}"}}`,
  },
];

describe('parseSse — robust to where the network cuts the stream', () => {
  it('parses a whole stream in one chunk', async () => {
    expect(await parse([enc.encode(STREAM)])).toEqual(EXPECTED);
  });

  it('yields the same events however the bytes are split — mid-line, mid-character, byte by byte', async () => {
    for (const chunks of everySplit(enc.encode(STREAM))) {
      expect(await parse(chunks), `${chunks.length} chunks`).toEqual(EXPECTED);
    }
  });

  it('treats \\r\\n, \\n and \\r line endings alike — including a \\r\\n split across chunks', async () => {
    for (const eol of ['\r\n', '\r']) {
      const bytes = enc.encode(STREAM.replaceAll('\n', eol));
      for (const chunks of everySplit(bytes)) {
        expect(await parse(chunks), JSON.stringify(eol)).toEqual(EXPECTED);
      }
    }
  });

  it('skips a leading BOM, even one split across chunks', async () => {
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
    const body = enc.encode(STREAM);
    expect(await parse([bom, body])).toEqual(EXPECTED);
    expect(await parse([bom.slice(0, 1), bom.slice(1), body])).toEqual(EXPECTED);
  });

  it('joins data lines with \\n, drops one leading space only, and defaults the event name', async () => {
    const text = 'data:first\ndata:  second\ndata\nid: 7\nretry: 100\nunknown: x\n\n';
    expect(await parse([enc.encode(text)])).toEqual([
      { event: 'message', data: 'first\n second\n' },
    ]);
  });

  it('dispatches nothing for a blank line with no data, or an event with only a name', async () => {
    expect(await parse([enc.encode('\n\nevent: ping\n\n')])).toEqual([]);
  });

  it('DISCARDS an event the stream ends in the middle of (no closing blank line)', async () => {
    const cut =
      'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n';
    expect((await parse([enc.encode(cut)])).map((e) => e.event)).toEqual(['message_start']);
  });

  it('cancels the body when the consumer stops early — the provider connection closes', async () => {
    let cancelled = false;
    // Still open (the provider is still generating): the case a cancel must reach.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(STREAM));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _ of parseSse(body)) break;
    expect(cancelled).toBe(true);
  });

  it('does not cancel a body it read to the end', async () => {
    let cancelled = false;
    const body = streamOf([enc.encode(STREAM)], () => {
      cancelled = true;
    });
    for await (const _ of parseSse(body)) {
      /* drain */
    }
    expect(cancelled).toBe(false);
  });
});

// --- MessageStream --------------------------------------------------------------------------

function ev(data: Record<string, unknown>): SseEvent {
  return { event: String(data.type), data: JSON.stringify(data) };
}

/** A stream for a model whose output is all visible, offering the tools these tests call. */
const newStream = (over: Partial<MessageStreamOptions> = {}) =>
  new MessageStream({
    hiddenThinking: false,
    offeredTools: new Set(['get_weather', 'now']),
    ...over,
  });

const start = (usage: Record<string, unknown> = { input_tokens: 472, output_tokens: 2 }) =>
  ev({
    type: 'message_start',
    message: { model: 'claude-opus-5', usage, content: [], stop_reason: null },
  });

describe('MessageStream — provider events to normalized events and a final message', () => {
  afterEach(() => vi.restoreAllMocks());

  it('folds the documented tool-use stream: text, a tool call, cumulative usage', () => {
    const s = newStream();
    const events = [
      start(),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'ping' }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Okay,' } }),
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' checking' },
      }),
      ev({ type: 'content_block_stop', index: 0 }),
      ev({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: {} },
      }),
      ev({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '' },
      }),
      ev({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"location":' },
      }),
      ev({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: ' "Springfield"}' },
      }),
      ev({ type: 'content_block_stop', index: 1 }),
      ev({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 89 },
      }),
      ev({ type: 'message_stop' }),
    ].flatMap((e) => s.consume(e));
    expect(events).toEqual([
      { type: 'message_start', model: 'claude-opus-5' },
      { type: 'text_delta', index: 0, text: 'Okay,' },
      { type: 'text_delta', index: 0, text: ' checking' },
      { type: 'tool_use_start', index: 1, id: 'toolu_01', name: 'get_weather' },
      { type: 'tool_input_delta', index: 1, partialJson: '{"location":' },
      { type: 'tool_input_delta', index: 1, partialJson: ' "Springfield"}' },
      {
        type: 'tool_use_stop',
        index: 1,
        id: 'toolu_01',
        name: 'get_weather',
        input: { location: 'Springfield' },
      },
      {
        type: 'message_delta',
        stopReason: 'tool_use',
        usage: {
          input_tokens: 472,
          output_tokens: 89,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    ]);
    expect(s.stopped).toBe(true);
    expect(s.finalMessage()).toEqual({
      model: 'claude-opus-5',
      usage: { input_tokens: 472, output_tokens: 89 },
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: 'Okay, checking' },
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'get_weather',
          input: { location: 'Springfield' },
        },
      ],
    });
  });

  it('assembles thinking blocks whole (signature included) without streaming them as events', () => {
    const s = newStream();
    const events = [
      start(),
      ev({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }),
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '' },
      }),
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM' },
      }),
      ev({ type: 'content_block_stop', index: 0 }),
      ev({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'opaque' },
      }),
      ev({ type: 'content_block_stop', index: 1 }),
      ev({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'Hi' } }),
      ev({ type: 'content_block_stop', index: 2 }),
      ev({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 30 },
      }),
      ev({ type: 'message_stop' }),
    ].flatMap((e) => s.consume(e));
    expect(events.map((e) => e.type)).toEqual(['message_start', 'text_delta', 'message_delta']);
    expect(s.finalMessage().content).toEqual([
      { type: 'thinking', thinking: '', signature: 'EqQBCgIYAhIM' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'Hi' },
    ]);
  });

  it('a null in a later usage block never erases a counter reported earlier', () => {
    const s = newStream();
    s.consume(start({ input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50 }));
    const [delta] = s.consume(
      ev({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 7, input_tokens: null, cache_read_input_tokens: null },
      }),
    );
    expect(delta).toMatchObject({
      usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 50 },
    });
  });

  it('turns a provider error event into a StreamFault carrying only its type', () => {
    const s = newStream();
    const fault = (data: Record<string, unknown>) => {
      try {
        s.consume(ev(data));
      } catch (e) {
        return e;
      }
      return null;
    };
    expect(
      fault({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ).toMatchObject({
      kind: 'provider_error',
      providerErrorType: 'overloaded_error',
    });
    expect(fault({ type: 'error', error: { type: 'Not A Type', message: 'x' } })).toMatchObject({
      providerErrorType: 'unknown',
    });
    expect(fault({ type: 'error' })).toMatchObject({ providerErrorType: 'unknown' });
  });

  it('refuses a stream that breaks the protocol', () => {
    const malformed = (events: SseEvent[]) => {
      const s = newStream();
      try {
        for (const e of events) s.consume(e);
      } catch (e) {
        return e instanceof StreamFault && e.kind === 'malformed';
      }
      return false;
    };
    const text0 = ev({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    expect(malformed([{ event: 'message_start', data: '{not json' }])).toBe(true);
    expect(malformed([{ event: 'message_start', data: '[1,2]' }])).toBe(true);
    expect(
      malformed([
        ev({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'x' } }),
      ]),
    ).toBe(true);
    expect(malformed([ev({ type: 'content_block_stop', index: 0 })])).toBe(true);
    expect(malformed([text0, text0])).toBe(true);
    expect(
      malformed([ev({ type: 'content_block_start', index: -1, content_block: { type: 'text' } })]),
    ).toBe(true);
    expect(
      malformed([ev({ type: 'content_block_start', index: 1.5, content_block: { type: 'text' } })]),
    ).toBe(true);
    expect(
      malformed([
        ev({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', name: 'x' },
        }),
      ]),
    ).toBe(true);
  });

  it('never offers a tool call cut off mid-input — legitimate on max_tokens, a fault otherwise', () => {
    const run = (stopReason: string) => {
      const s = newStream();
      const events = [
        start(),
        ev({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: {} },
        }),
        ev({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"location": "Spri' },
        }),
        ev({ type: 'content_block_stop', index: 0 }),
        ev({
          type: 'message_delta',
          delta: { stop_reason: stopReason },
          usage: { output_tokens: 4 },
        }),
        ev({ type: 'message_stop' }),
      ].flatMap((e) => s.consume(e));
      return { s, events };
    };
    // The output budget or the context window ran out mid-call, or a safety decline fired while it
    // was open: the partial call is never offered, and the message is otherwise whole.
    for (const stopReason of ['max_tokens', 'model_context_window_exceeded', 'refusal']) {
      const cut = run(stopReason);
      expect(
        cut.events.map((e) => e.type),
        stopReason,
      ).not.toContain('tool_use_stop');
      expect(cut.s.finalMessage().content, stopReason).toEqual([]);
    }
    for (const stopReason of ['end_turn', 'tool_use', 'stop_sequence']) {
      expect(() => run(stopReason).s.finalMessage(), stopReason).toThrow(StreamFault);
    }
  });

  it('a block never closed is dropped after a cut-short stop, and a fault after any other', () => {
    const run = (stopReason: string, block: Record<string, unknown>) => {
      const s = newStream();
      for (const e of [
        start(),
        ev({ type: 'content_block_start', index: 0, content_block: block }),
        ev({
          type: 'message_delta',
          delta: { stop_reason: stopReason },
          usage: { output_tokens: 4 },
        }),
        ev({ type: 'message_stop' }),
      ]) {
        s.consume(e);
      }
      return s;
    };
    const toolUse = { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: {} };
    const text = { type: 'text', text: 'half' };
    for (const block of [toolUse, text]) {
      for (const stopReason of ['max_tokens', 'model_context_window_exceeded', 'refusal']) {
        expect(run(stopReason, block).finalMessage().content, stopReason).toEqual([]);
      }
      expect(() => run('end_turn', block).finalMessage()).toThrow(StreamFault);
      expect(() => run('tool_use', block).finalMessage()).toThrow(StreamFault);
    }
  });

  it('refuses a tool call for a tool the request did not offer — before announcing it', () => {
    const s = newStream({ offeredTools: new Set(['get_weather']) });
    s.consume(start());
    let fault: unknown = null;
    try {
      s.consume(
        ev({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_7', name: 'delete_records', input: {} },
        }),
      );
    } catch (err) {
      fault = err;
    }
    expect(fault).toBeInstanceOf(StreamFault);
    expect((fault as StreamFault).kind).toBe('unoffered_tool');
    // With no tools offered at all, any tool call is refused the same way.
    const bare = newStream({ offeredTools: new Set() });
    bare.consume(start());
    expect(() =>
      bare.consume(
        ev({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_8', name: 'get_weather', input: {} },
        }),
      ),
    ).toThrow(StreamFault);
  });

  it('parses an empty tool input as {} and refuses a non-object one', () => {
    const s = newStream();
    s.consume(start());
    s.consume(
      ev({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'now', input: {} },
      }),
    );
    expect(s.consume(ev({ type: 'content_block_stop', index: 0 }))).toEqual([
      { type: 'tool_use_stop', index: 0, id: 'toolu_1', name: 'now', input: {} },
    ]);
    s.consume(
      ev({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_2', name: 'now', input: {} },
      }),
    );
    s.consume(
      ev({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '[1]' },
      }),
    );
    expect(s.consume(ev({ type: 'content_block_stop', index: 1 }))).toEqual([]);
  });

  it('drops a block type it never asked for, and its deltas, logging the type only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = newStream();
    const events = [
      start(),
      ev({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
      }),
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"secret"}' },
      }),
      ev({ type: 'content_block_stop', index: 0 }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      ev({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'citations_delta', citation: {} },
      }),
      ev({ type: 'content_block_stop', index: 1 }),
      ev({ type: 'a_future_event' }),
      ev({ type: 'message_stop' }),
    ].flatMap((e) => s.consume(e));
    expect(events.map((e) => e.type)).toEqual(['message_start']);
    expect(s.finalMessage().content).toEqual([{ type: 'text', text: '' }]);
    expect(loggedEvents(warn.mock.calls)).toContainEqual({
      event: 'ai_response_block_dropped',
      block_type: 'server_tool_use',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('observedUsage: reported counters, output floored at streamed characters per token', () => {
    const estimate = estimateRequest('claude-sonnet-4-6', [{ chars: 4000 }], { maxTokens: 100 });
    const s = newStream();
    s.consume(start({ input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 40 }));
    s.consume(
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    );
    s.consume(
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'x'.repeat(41) },
      }),
    );
    expect(s.observedUsage(estimate)).toMatchObject({
      input_tokens: 900,
      output_tokens: 11, // ceil(41 / 4) on the previous tokenizer, above the 1 reported so far
      cache_read_input_tokens: 40,
    });
    // The same 41 characters on the Claude 4.7+ tokenizer (3 per token) floor higher.
    expect(
      s.observedUsage(estimateRequest('claude-opus-4-8', [{ chars: 4000 }], { maxTokens: 100 }))
        .output_tokens,
    ).toBe(14);
    s.consume(ev({ type: 'message_delta', delta: {}, usage: { output_tokens: 60 } }));
    expect(s.observedUsage(estimate).output_tokens).toBe(60);
  });

  it('observedUsage before message_start: the request was accepted, so its estimated input is billed', () => {
    // 3 chars per token on sonnet-5's tokenizer.
    const estimate = estimateRequest(
      'claude-sonnet-5',
      [{ chars: 3000, cacheTtl: '1h' }, { chars: 300 }],
      { maxTokens: 100 },
    );
    // The cache-marked prefix bills as the write it was reserved as, never as plain input.
    expect(newStream().observedUsage(estimate)).toEqual({
      input_tokens: 100,
      output_tokens: 0,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
    });
    expect(
      newStream().observedUsage(
        estimateRequest('claude-sonnet-5', [{ chars: 3300 }], { maxTokens: 100 }),
      ),
    ).toEqual({ input_tokens: 1100, output_tokens: 0 });
  });

  describe('observedUsage when output may be hidden: the whole max_tokens until message_delta counts it', () => {
    const estimate = estimateRequest('claude-opus-5-5', [{ chars: 300 }], { maxTokens: 20_000 });
    const thinkingStart = (index: number, type = 'thinking') =>
      ev({
        type: 'content_block_start',
        index,
        content_block:
          type === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'redacted_thinking', data: 'opaque' },
      });

    it('a model that thinks unseen books max_tokens from the first byte — even before a block opens', () => {
      const s = newStream({ hiddenThinking: true });
      s.consume(start({ input_tokens: 10, output_tokens: 1 }));
      expect(s.observedUsage(estimate)).toMatchObject({ input_tokens: 10, output_tokens: 20_000 });
      // …and before message_start too: the request was accepted, the model may have been thinking.
      expect(newStream({ hiddenThinking: true }).observedUsage(estimate).output_tokens).toBe(
        20_000,
      );
    });

    it('an open thinking block with nothing streamed (display "omitted") books max_tokens', () => {
      const s = newStream({ hiddenThinking: true });
      s.consume(start({ input_tokens: 10, output_tokens: 1 }));
      s.consume(thinkingStart(0));
      s.consume(
        ev({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '' },
        }),
      );
      expect(s.observedUsage(estimate).output_tokens).toBe(20_000);
    });

    it('any thinking or redacted_thinking block does the same on a model that does not think by default', () => {
      for (const type of ['thinking', 'redacted_thinking']) {
        const s = newStream({ hiddenThinking: false });
        s.consume(start({ input_tokens: 10, output_tokens: 1 }));
        expect(s.observedUsage(estimate).output_tokens, type).toBe(1);
        s.consume(thinkingStart(0, type));
        expect(s.observedUsage(estimate).output_tokens, type).toBe(20_000);
      }
    });

    it('a message_delta that carries no usage block is not the count — max_tokens still stands', () => {
      const s = newStream({ hiddenThinking: true });
      s.consume(start({ input_tokens: 10, output_tokens: 1 }));
      s.consume(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      expect(s.stopReason).toBe('end_turn');
      expect(s.observedUsage(estimate).output_tokens).toBe(20_000);
    });

    it('once message_delta reports the cumulative count, that count is booked — not max_tokens', () => {
      const s = newStream({ hiddenThinking: true });
      s.consume(start({ input_tokens: 10, output_tokens: 1 }));
      s.consume(thinkingStart(0));
      s.consume(ev({ type: 'content_block_stop', index: 0 }));
      s.consume(
        ev({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 3_210 },
        }),
      );
      expect(s.observedUsage(estimate).output_tokens).toBe(3_210);
    });
  });
});
