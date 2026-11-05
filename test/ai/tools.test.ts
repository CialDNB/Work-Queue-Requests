// Content blocks, custom tools and tool_choice — and the zero-data-retention guard that keeps
// everything else off the wire (PIA C6). See src/ai/messages.ts and src/ai/policy.ts.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AiCallInput,
  type AiContentBlock,
  type AiMessage,
  type AiTool,
  assertCustomTools,
  callAnthropic,
  type Fetcher,
  isModelOutput,
} from '../../src/ai/anthropic';
import { todayUtc } from '../../src/ai/budget';
import { buildWireRequest, normalizeContent, promptSegments } from '../../src/ai/messages';
import { assertWire } from '../../src/ai/policy';
import { estimateRequest, TOOL_USE_PROMPT_TOKENS } from '../../src/ai/pricing';
import { makeDb } from '../../src/data';
import type { Env } from '../../src/env';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { loggedEvents } from '../helpers/logs';

const gatewayEnv = (over: Partial<Env> = {}): Env => ({
  ...env,
  ANTHROPIC_API_KEY: 'sk-ant-test-synthetic',
  AI_GATEWAY_ID: 'all-pr-apps',
  AI_GATEWAY_TOKEN: 'gw-test-token',
  CF_ACCOUNT_ID: 'acct-test-123',
  ...over,
});

const weather: AiTool = {
  name: 'get_weather',
  description: 'Current weather for a synthetic city',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

const reply = (fields: Record<string, unknown> = {}): Response =>
  Response.json({
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 100, output_tokens: 20 },
    stop_reason: 'end_turn',
    ...fields,
  });

/** One call with the given input; returns the parsed wire body and the result. */
async function send(
  input: Partial<AiCallInput>,
  response: () => Response = () => reply(),
): Promise<{ body: Record<string, unknown>; result: Awaited<ReturnType<typeof callAnthropic>> }> {
  let raw = '';
  const result = await callAnthropic(
    gatewayEnv(),
    USERS.member,
    {
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      model: 'claude-sonnet-5',
      ...input,
    },
    async (_url, init) => {
      raw = init.body as string;
      return response();
    },
  );
  return { body: JSON.parse(raw) as Record<string, unknown>, result };
}

async function reserved(): Promise<[number, number]> {
  const repo = makeDb(env).aiBudget;
  return [
    await repo.reservedToday(`u:${USERS.member}`, todayUtc()),
    await repo.reservedToday('g', todayUtc()),
  ];
}

describe('content blocks, custom tools and tool_choice on the wire', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  it('sends every allowed block type exactly as given (a tool-use turn, thinking included)', async () => {
    const messages: AiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'weather in Springfield?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig-synthetic-1' },
          { type: 'redacted_thinking', data: 'opaque-synthetic' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Springfield' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: [{ type: 'text', text: '21C' }],
            cache_control: { type: 'ephemeral' },
          },
          { type: 'tool_result', tool_use_id: 'toolu_02', content: 'no data', is_error: true },
        ],
      },
    ];
    const { body } = await send({ messages, tools: [weather] });
    expect(body.messages).toEqual(messages);
  });

  it('sends custom tools, cache breakpoints and a system prompt in blocks', async () => {
    const system = [
      {
        type: 'text' as const,
        text: 'You are terse.',
        cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
      },
    ];
    const { body } = await send({
      system,
      tools: [{ ...weather, type: 'custom', cache_control: { type: 'ephemeral' } }],
    });
    expect(body.system).toEqual(system);
    // `type: 'custom'` is the default; the rebuilt tool carries only what the API needs.
    expect(body.tools).toEqual([{ ...weather, cache_control: { type: 'ephemeral' } }]);
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('sends each tool_choice form, with disable_parallel_tool_use where it applies', async () => {
    for (const toolChoice of [
      { type: 'auto' },
      { type: 'any', disable_parallel_tool_use: true },
      { type: 'tool', name: 'get_weather' },
      { type: 'tool', name: 'get_weather', disable_parallel_tool_use: false },
      { type: 'none' },
    ] as const) {
      const { body } = await send({ tools: [weather], toolChoice });
      expect(body.tool_choice, JSON.stringify(toolChoice)).toEqual(toolChoice);
    }
  });

  it('treats undefined-valued fields as absent, the way JSON.stringify does', async () => {
    const tool = { ...weather, allowed_callers: undefined } as unknown as AiTool;
    const { body } = await send({
      tools: [tool],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: undefined }] },
      ],
    });
    expect(body.tools).toEqual([weather]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('an empty tools array sends no tools field', async () => {
    expect((await send({ tools: [] })).body).not.toHaveProperty('tools');
  });

  it('returns every block normalized — thinking kept whole, tool input parsed — and stop_reason tool_use', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await send({ tools: [weather] }, () =>
      reply({
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig-synthetic-2' },
          { type: 'text', text: 'Let me check. ', citations: null },
          {
            type: 'tool_use',
            id: 'toolu_03',
            name: 'get_weather',
            input: { city: 'Shelbyville' },
            caller: { type: 'direct' },
          },
          // A type this client never asks for: dropped, logged by type only.
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
        ],
      }),
    );
    expect(result.stopReason).toBe('tool_use');
    expect(result.text).toBe('Let me check. ');
    expect(result.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-synthetic-2' },
      { type: 'text', text: 'Let me check. ' },
      { type: 'tool_use', id: 'toolu_03', name: 'get_weather', input: { city: 'Shelbyville' } },
    ]);
    expect(loggedEvents(warn.mock.calls)).toContainEqual({
      event: 'ai_response_block_dropped',
      block_type: 'server_tool_use',
    });
  });

  it('the returned content goes straight back as the assistant turn — the round trip the loop needs', async () => {
    const first = await send({ tools: [weather] }, () =>
      reply({
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'summary', signature: 'sig-synthetic-3' },
          { type: 'tool_use', id: 'toolu_04', name: 'get_weather', input: { city: 'Ogdenville' } },
        ],
      }),
    );
    const messages: AiMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: first.result.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_04', content: '18C' }] },
    ];
    const second = await send({ tools: [weather], messages });
    expect(second.body.messages).toEqual(messages);
  });

  // What the UI-intent gate (src/ai/uiIntents.ts) relies on: only the array this client returned
  // counts as the model's own output. A copy, a JSON round trip (a stored transcript, a Workflow
  // step's persisted result) or a hand-built array does not, and the original cannot grow.
  it('marks the returned content as fresh model output: that array, frozen — never a copy', async () => {
    const { result } = await send({ tools: [weather] }, () =>
      reply({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_06', name: 'get_weather', input: { city: 'X' } }],
      }),
    );
    expect(isModelOutput(result.content)).toBe(true);
    expect(Object.isFrozen(result.content)).toBe(true);
    expect(() => (result.content as unknown[]).push({ type: 'text', text: 'x' })).toThrow(
      TypeError,
    );
    expect(isModelOutput([...result.content])).toBe(false);
    expect(isModelOutput(JSON.parse(JSON.stringify(result.content)))).toBe(false);
    expect(isModelOutput(structuredClone(result.content))).toBe(false);
    for (const other of [null, undefined, 'text', 42, {}, [], result]) {
      expect(isModelOutput(other)).toBe(false);
    }
    // The next call's content is its own array, marked on its own.
    const again = await send({ tools: [weather] });
    expect(isModelOutput(again.result.content)).toBe(true);
    expect(again.result.content).not.toBe(result.content);
  });

  it('refuses a response that calls a tool the request did not offer — billed, never returned', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unoffered = () =>
      reply({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_05', name: 'delete_records', input: {} }],
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    for (const tools of [[weather], undefined]) {
      await seedDb();
      const err = await send({ tools }, unoffered).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 502, code: 'ai_upstream_error' });
      expect((err as Error).message).not.toContain('delete_records');
      // The provider billed the call: its usage is booked, not released.
      const [user] = await reserved();
      expect(user).toBeCloseTo(((100 * 2 + 20 * 10) / 1e6) * 1.1, 6);
    }
    expect(loggedEvents(spy.mock.calls)).toContainEqual({
      event: 'ai_call_bad_body',
      reason: 'unoffered_tool',
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('delete_records');
  });

  it('assertCustomTools validates a tool set once, where it is defined', () => {
    expect(
      assertCustomTools([weather, { ...weather, name: 'get_forecast', type: 'custom' }]),
    ).toEqual([weather, { ...weather, name: 'get_forecast' }]);
  });
});

describe('the zero-data-retention guard — refused before any reservation or request', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);
  afterEach(() => vi.restoreAllMocks());

  const marker = 'synthetic-content-marker-a7c3';

  /** The call must be refused as ai_request_refused, with no fetch, no reservation, no content. */
  async function expectRefused(input: Partial<AiCallInput>, label: string): Promise<void> {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let called = false;
    const fetcher: Fetcher = async () => {
      called = true;
      return reply();
    };
    const err = await callAnthropic(
      gatewayEnv(),
      USERS.member,
      {
        messages: [{ role: 'user', content: marker }],
        maxTokens: 100,
        model: 'claude-sonnet-5',
        ...input,
      },
      fetcher,
    ).catch((e: unknown) => e);
    expect(err, label).toMatchObject({ status: 500, code: 'ai_request_refused' });
    expect((err as Error).message, label).not.toContain(marker);
    expect(called, label).toBe(false);
    expect(await reserved(), label).toEqual([0, 0]);
  }

  it('refuses every server / typed tool: code execution, web search and fetch, MCP toolsets, …', async () => {
    for (const type of [
      'web_search_20260209',
      'web_search_20250305',
      'web_fetch_20260309',
      'code_execution_20260521',
      'code_execution_20250825',
      'mcp_toolset',
      'bash_20250124',
      'text_editor_20250728',
      'computer_toolset_20260801',
      'browser_toolset_20260801',
      'memory_20250818',
      'tool_search_tool_regex_20251119',
      'advisor',
    ]) {
      await expectRefused({ tools: [{ ...weather, type } as unknown as AiTool] }, type);
    }
  });

  it('refuses tool fields outside the allowlist — allowed_callers (programmatic calling) first', async () => {
    for (const [field, value] of [
      ['allowed_callers', ['code_execution_20250825']],
      ['defer_loading', true],
      ['strict', true],
      ['input_examples', [{ city: marker }]],
      ['eager_input_streaming', true],
    ] as const) {
      await expectRefused({ tools: [{ ...weather, [field]: value } as unknown as AiTool] }, field);
    }
  });

  it('refuses malformed and duplicate tools', async () => {
    const bad: [string, unknown][] = [
      ['bad name', { ...weather, name: `get weather ${marker}` }],
      ['long name', { ...weather, name: 'x'.repeat(129) }],
      ['no schema', { name: 'get_weather' }],
      ['array schema', { ...weather, input_schema: { type: 'array' } }],
      ['description', { ...weather, description: 7 }],
      ['not an object', 'get_weather'],
    ];
    for (const [label, tool] of bad) await expectRefused({ tools: [tool as AiTool] }, label);
    await expectRefused({ tools: [weather, weather] }, 'duplicate');
    await expectRefused({ tools: { name: 'x' } as unknown as AiTool[] }, 'tools not an array');
  });

  it('refuses block types outside the allowlist — images, documents, Files API references, server blocks', async () => {
    const blocks: [string, unknown][] = [
      [
        'image',
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ],
      [
        'file document',
        { type: 'document', source: { type: 'file', file_id: 'file_011synthetic' } },
      ],
      ['file image', { type: 'image', source: { type: 'file', file_id: 'file_011synthetic' } }],
      ['search_result', { type: 'search_result', source: 'x', title: 't', content: [] }],
      [
        'server_tool_use',
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
      ],
      [
        'web_search_tool_result',
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
      ],
      ['container_upload', { type: 'container_upload', file_id: 'file_011synthetic' }],
      [
        'mcp_tool_use',
        { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'x', server_name: 's', input: {} },
      ],
      ['untyped', { text: marker }],
    ];
    for (const [label, block] of blocks) {
      await expectRefused({ messages: [{ role: 'user', content: [block as never] }] }, label);
    }
  });

  it('refuses non-text content inside a tool_result', async () => {
    for (const inner of [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      { type: 'document', source: { type: 'file', file_id: 'file_011synthetic' } },
      { type: 'tool_reference', tool_name: 'get_weather' },
    ]) {
      await expectRefused(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'toolu_01', content: [inner as never] },
              ],
            },
          ],
        },
        inner.type,
      );
    }
  });

  it('refuses allowed block types carrying fields outside the allowlist', async () => {
    const blocks: [string, unknown][] = [
      ['text citations', { type: 'text', text: marker, citations: [] }],
      ['text not a string', { type: 'text', text: 7 }],
      [
        'tool_use caller',
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'get_weather',
          input: {},
          caller: { type: 'code_execution_20250825', tool_id: 'srvtoolu_1' },
        },
      ],
      [
        'tool_use input array',
        { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: [] },
      ],
      ['tool_use bad id', { type: 'tool_use', id: 'toolu 01', name: 'get_weather', input: {} }],
      [
        'tool_result is_error string',
        { type: 'tool_result', tool_use_id: 'toolu_01', is_error: 'yes' },
      ],
      [
        'tool_result content object',
        { type: 'tool_result', tool_use_id: 'toolu_01', content: { text: marker } },
      ],
      [
        'thinking cache_control',
        { type: 'thinking', thinking: '', signature: 's', cache_control: { type: 'ephemeral' } },
      ],
      ['thinking no signature', { type: 'thinking', thinking: marker }],
      ['redacted_thinking extra', { type: 'redacted_thinking', data: 'x', thinking: marker }],
    ];
    for (const [label, block] of blocks) {
      await expectRefused({ messages: [{ role: 'user', content: [block as never] }] }, label);
    }
  });

  it('refuses a system role, a malformed message, and a non-text system prompt', async () => {
    await expectRefused(
      { messages: [{ role: 'system', content: marker } as unknown as AiMessage] },
      'system role',
    );
    await expectRefused(
      { messages: [{ role: 'user', content: marker, name: 'x' } as unknown as AiMessage] },
      'extra key',
    );
    await expectRefused(
      { messages: [{ role: 'user', content: 7 } as unknown as AiMessage] },
      'content',
    );
    await expectRefused({ messages: 'hi' as unknown as AiMessage[] }, 'messages not an array');
    await expectRefused({ system: { text: marker } as never }, 'system object');
    await expectRefused({ system: [{ type: 'image' }] as never }, 'system image');
  });

  it('refuses a cache_control that is not ephemeral with a 5m / 1h ttl', async () => {
    for (const cache of [
      { type: 'persistent' },
      { type: 'ephemeral', ttl: '24h' },
      { type: 'ephemeral', scope: 'global' },
      'ephemeral',
    ]) {
      await expectRefused(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'hi', cache_control: cache as never }],
            },
          ],
        },
        JSON.stringify(cache),
      );
    }
  });

  it('refuses a malformed tool_choice, or one that names a tool not provided', async () => {
    for (const [label, input] of [
      ['unknown type', { tools: [weather], toolChoice: { type: 'required' } }],
      ['missing tool', { tools: [weather], toolChoice: { type: 'tool', name: 'get_forecast' } }],
      ['no tools', { toolChoice: { type: 'auto' } }],
      [
        'none extra',
        { tools: [weather], toolChoice: { type: 'none', disable_parallel_tool_use: true } },
      ],
      [
        'parallel string',
        { tools: [weather], toolChoice: { type: 'any', disable_parallel_tool_use: 'yes' } },
      ],
      ['not an object', { tools: [weather], toolChoice: 'auto' }],
    ] as const) {
      await expectRefused(input as unknown as Partial<AiCallInput>, label);
    }
  });

  it('refuses forced tool use on Opus 5.5 (a 400 there) but sends auto and none', async () => {
    for (const toolChoice of [{ type: 'any' }, { type: 'tool', name: 'get_weather' }] as const) {
      await expectRefused(
        { model: 'claude-opus-5-5', tools: [weather], toolChoice },
        toolChoice.type,
      );
    }
    for (const toolChoice of [{ type: 'auto' }, { type: 'none' }] as const) {
      const { body } = await send({ model: 'claude-opus-5-5', tools: [weather], toolChoice }, () =>
        reply({ model: 'claude-opus-5-5' }),
      );
      expect(body.tool_choice).toEqual(toolChoice);
    }
  });

  it('logs the refusal reason only', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await callAnthropic(
      gatewayEnv(),
      USERS.member,
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ ...weather, name: marker, type: 'web_search_20260209' } as unknown as AiTool],
      },
      async () => reply(),
    ).catch(() => {});
    expect(loggedEvents(spy.mock.calls)).toContainEqual({
      event: 'ai_request_refused',
      reason: 'server_tool',
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain(marker);
  });
});

describe('assertWire — the backstop on what leaves', () => {
  afterEach(() => vi.restoreAllMocks());

  const url = 'https://gateway.ai.cloudflare.com/v1/acct/all-pr-apps/anthropic/v1/messages';
  const body = { model: 'claude-sonnet-5', max_tokens: 1, messages: [], inference_geo: 'us' };

  function refused(fn: () => void): boolean {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fn();
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'ai_request_refused';
    }
  }

  it('passes the shape the client builds', () => {
    expect(() => assertWire(url, { 'x-api-key': 'k' }, body)).not.toThrow();
    expect(() =>
      assertWire(
        url,
        {},
        {
          ...body,
          stream: true,
          output_config: { effort: 'low' },
          tools: [],
          tool_choice: {},
          system: 's',
        },
      ),
    ).not.toThrow();
  });

  it('refuses any endpoint but /v1/messages — batches, files, count_tokens, a bad URL', () => {
    for (const bad of [
      url.replace('/v1/messages', '/v1/messages/batches'),
      url.replace('/v1/messages', '/v1/files'),
      url.replace('/v1/messages', '/v1/messages/count_tokens'),
      'not a url',
    ]) {
      expect(
        refused(() => assertWire(bad, {}, body)),
        bad,
      ).toBe(true);
    }
  });

  it('refuses an anthropic-beta header in any case — betas switch on excluded features', () => {
    for (const h of ['anthropic-beta', 'Anthropic-Beta']) {
      expect(
        refused(() => assertWire(url, { [h]: 'files-api-2025-04-14' }, body)),
        h,
      ).toBe(true);
    }
  });

  it('refuses top-level parameters outside the list', () => {
    for (const key of [
      'mcp_servers',
      'container',
      'skills',
      'context_management',
      'service_tier',
      'metadata',
      'thinking',
      'temperature',
      'cache_control',
    ]) {
      expect(
        refused(() => assertWire(url, {}, { ...body, [key]: {} })),
        key,
      ).toBe(true);
    }
  });

  it('refuses a missing or unknown inference_geo, and an output_config beyond effort and format', () => {
    const { inference_geo: _, ...noGeo } = body;
    expect(refused(() => assertWire(url, {}, noGeo))).toBe(true);
    expect(refused(() => assertWire(url, {}, { ...body, inference_geo: 'eu' }))).toBe(true);
    for (const outputConfig of [
      'low',
      null,
      [],
      [{ effort: 'low' }],
      { task_budget: {} },
      { effort: 'low', verbosity: 'low' },
    ]) {
      expect(
        refused(() => assertWire(url, {}, { ...body, output_config: outputConfig })),
        JSON.stringify(outputConfig),
      ).toBe(true);
    }
  });

  // A fixed shape defined in code, as a fork's reply schema is: never built from the request.
  const replySchema = {
    type: 'object',
    properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
    required: ['answer', 'confidence'],
    additionalProperties: false,
  };

  it('passes a JSON-schema structured output, alone or with effort, streaming or not', () => {
    const format = { type: 'json_schema', schema: replySchema };
    for (const outputConfig of [{ format }, { effort: 'high', format }]) {
      expect(() => assertWire(url, {}, { ...body, output_config: outputConfig })).not.toThrow();
      expect(() =>
        assertWire(url, {}, { ...body, stream: true, output_config: outputConfig }),
      ).not.toThrow();
    }
    expect(() =>
      assertWire(
        url,
        {},
        { ...body, output_config: { format: { schema: {}, type: 'json_schema' } } },
      ),
    ).not.toThrow();
  });

  it('counts only keys with a defined value, the ones JSON.stringify sends (as messages.ts does)', () => {
    // A fork's builder writes `format: wantsJson ? {...} : undefined`: both branches pass.
    for (const wantsJson of [true, false]) {
      const outputConfig = {
        effort: 'low',
        format: wantsJson ? { type: 'json_schema', schema: replySchema } : undefined,
      };
      expect(
        () => assertWire(url, {}, { ...body, output_config: outputConfig }),
        `wantsJson=${wantsJson}`,
      ).not.toThrow();
    }
    const cases: [string, Record<string, unknown>][] = [
      ['format: undefined alone', { ...body, output_config: { format: undefined } }],
      [
        'an undefined output_config key',
        { ...body, output_config: { effort: 'low', verbosity: undefined } },
      ],
      [
        'undefined keys inside format',
        {
          ...body,
          output_config: {
            format: {
              type: 'json_schema',
              schema: replySchema,
              name: undefined,
              strict: undefined,
            },
          },
        },
      ],
      ['undefined top-level keys', { ...body, output_format: undefined, thinking: undefined }],
    ];
    for (const [label, sent] of cases) {
      expect(() => assertWire(url, {}, sent), label).not.toThrow();
    }
    // The same keys with a value are refused: they would leave.
    for (const [label, sent] of [
      ['output_config.verbosity', { ...body, output_config: { effort: 'low', verbosity: 'low' } }],
      [
        'format.name',
        {
          ...body,
          output_config: { format: { type: 'json_schema', schema: replySchema, name: 'reply' } },
        },
      ],
      ['output_format', { ...body, output_format: { type: 'json_schema', schema: replySchema } }],
      ['thinking', { ...body, thinking: { type: 'enabled' } }],
    ] as const) {
      expect(
        refused(() => assertWire(url, {}, sent)),
        label,
      ).toBe(true);
    }
  });

  it('still passes effort alone', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(() => assertWire(url, {}, { ...body, output_config: { effort } })).not.toThrow();
    }
  });

  it('refuses any other format type', () => {
    for (const type of ['text', 'json_object', 'json', 'JSON_SCHEMA', 'grammar', '', undefined]) {
      expect(
        refused(() =>
          assertWire(
            url,
            {},
            { ...body, output_config: { format: { type, schema: replySchema } } },
          ),
        ),
        String(type),
      ).toBe(true);
    }
  });

  it('refuses a format with a key beside type and schema', () => {
    for (const extra of [
      { name: 'reply' },
      { strict: true },
      { json_schema: replySchema },
      { description: 'reply' },
      { cache_control: { type: 'ephemeral' } },
    ]) {
      expect(
        refused(() =>
          assertWire(
            url,
            {},
            {
              ...body,
              output_config: { format: { type: 'json_schema', schema: replySchema, ...extra } },
            },
          ),
        ),
        Object.keys(extra)[0],
      ).toBe(true);
    }
    // Missing the schema is refused too.
    expect(
      refused(() =>
        assertWire(url, {}, { ...body, output_config: { format: { type: 'json_schema' } } }),
      ),
    ).toBe(true);
  });

  it('refuses a format that is not an object, or whose schema is not a plain object', () => {
    for (const format of [{}, 'json_schema', null, [], true, 1]) {
      expect(
        refused(() => assertWire(url, {}, { ...body, output_config: { format } })),
        JSON.stringify(format),
      ).toBe(true);
    }
    for (const schema of [
      null,
      undefined,
      '{"type":"object"}',
      JSON.stringify(replySchema),
      [],
      [replySchema],
      42,
      true,
      new Map([['type', 'object']]),
      new Date(0),
    ]) {
      expect(
        refused(() =>
          assertWire(
            url,
            {},
            { ...body, output_config: { format: { type: 'json_schema', schema } } },
          ),
        ),
        String(schema),
      ).toBe(true);
    }
  });

  it('refuses the deprecated top-level output_format', () => {
    expect(
      refused(() =>
        assertWire(
          url,
          {},
          { ...body, output_format: { type: 'json_schema', schema: replySchema } },
        ),
      ),
    ).toBe(true);
  });
});

describe('the reservation counts tools, system and blocks', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  /** What the budget held while the request was in flight. */
  async function reservedDuringCall(input: Partial<AiCallInput>): Promise<number> {
    let during = -1;
    await callAnthropic(
      gatewayEnv(),
      USERS.member,
      {
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        model: 'claude-sonnet-5',
        ...input,
      },
      async () => {
        during = (await reserved())[0];
        return reply({ usage: { input_tokens: 0, output_tokens: 0 } });
      },
    );
    return during;
  }

  it('reserves exactly the whole-request estimate, tool-use prompt and us multiplier included', async () => {
    const input: AiCallInput = {
      model: 'claude-sonnet-5',
      maxTokens: 100,
      system: 'terse',
      tools: [weather],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] }],
    };
    const expected = estimateRequest(
      'claude-sonnet-5',
      promptSegments(buildWireRequest('claude-sonnet-5', input)),
      { maxTokens: 100, toolPromptTokens: TOOL_USE_PROMPT_TOKENS, geo: 'us' },
    ).usd;
    expect(await reservedDuringCall(input)).toBeCloseTo(expected, 6);
    await seedDb();
    // …and a tool-less call reserves less for the same text.
    expect(await reservedDuringCall({ ...input, tools: undefined })).toBeLessThan(expected);
  });

  it('reserves a cache-marked prefix at the WRITE rate for its TTL — marking never lowers the reservation', async () => {
    const long = 'y'.repeat(300_000); // 100k tokens at 3 chars per token on sonnet-5
    const plain = await reservedDuringCall({ system: long, maxTokens: 1 });
    await seedDb();
    const fiveMin = await reservedDuringCall({
      system: [{ type: 'text', text: long, cache_control: { type: 'ephemeral' } }],
      maxTokens: 1,
    });
    await seedDb();
    const oneHour = await reservedDuringCall({
      system: [{ type: 'text', text: long, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      maxTokens: 1,
    });
    // The 100k-token system prompt at the sonnet-5 input rate ($2/M): $0.20 plain, $0.25 as a
    // 5-minute write, $0.40 as a 1-hour write. Plus 'hi' (1 token at $2/M) and max_tokens 1 (at
    // $10/M), all × 1.1 for the us pin.
    expect(plain).toBeCloseTo((0.2 + 0.000002 + 0.00001) * 1.1, 6);
    expect(fiveMin).toBeCloseTo((0.25 + 0.000002 + 0.00001) * 1.1, 6);
    expect(oneHour).toBeCloseTo((0.4 + 0.000002 + 0.00001) * 1.1, 6);
  });

  it('a cache_control cannot carry a call past the per-call cap it would otherwise hit', async () => {
    // Review finding: priced at the READ rate, a huge cache-marked prompt was admitted with a tiny
    // reservation and then billed as a cache WRITE — one call spent far past $0.50 (and past the
    // $5 per-user day). Reserved as the write it is on a miss, it is refused before any request.
    // A second review finding: the same marker one level down, on the text INSIDE a tool_result,
    // was sent but not priced — the 200k characters reserved as plain input (~$0.39) and passed.
    const history = 'p'.repeat(200_000);
    const oneHour = { type: 'ephemeral', ttl: '1h' } as const;
    const toolTurn = (result: AiMessage['content']): AiMessage[] => [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'x' } }],
      },
      { role: 'user', content: result },
    ];
    const shapes: [string, Partial<AiCallInput>][] = [
      [
        'on a text block',
        {
          messages: [
            { role: 'user', content: [{ type: 'text', text: history, cache_control: oneHour }] },
          ],
        },
      ],
      [
        'on the text inside a tool_result',
        {
          tools: [weather],
          messages: toolTurn([
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01',
              content: [{ type: 'text', text: history, cache_control: oneHour }],
            },
          ]),
        },
      ],
    ];
    for (const [where, shape] of shapes) {
      let called = false;
      await expect(
        callAnthropic(
          gatewayEnv({ AI_MAX_CALL_USD: '0.5' }),
          USERS.member,
          { model: 'claude-opus-5-5', maxTokens: 4096, messages: [], ...shape },
          async () => {
            called = true;
            return reply();
          },
        ),
        where,
      ).rejects.toMatchObject({ status: 429, code: 'ai_budget_per_call_cap' });
      expect(called, where).toBe(false);
      expect(await reserved(), where).toEqual([0, 0]);
    }
  });

  it('a tool_result carries the longest TTL on it or on the text inside it', () => {
    const segmentFor = (block: Record<string, unknown>) =>
      promptSegments(
        buildWireRequest('claude-sonnet-5', {
          messages: [{ role: 'user', content: [block as unknown as AiContentBlock] }],
        }),
      )[0]?.cacheTtl;
    const text = (ttl?: '5m' | '1h') => ({
      type: 'text',
      text: 'r',
      ...(ttl ? { cache_control: { type: 'ephemeral', ttl } } : {}),
    });
    const result = (content: unknown, ttl?: '5m' | '1h') => ({
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content,
      ...(ttl ? { cache_control: { type: 'ephemeral', ttl } } : {}),
    });
    expect(segmentFor(result([text(), text()]))).toBeUndefined();
    expect(segmentFor(result('plain', '5m'))).toBe('5m');
    expect(segmentFor(result([text('5m')]))).toBe('5m');
    expect(segmentFor(result([text(), text('1h')]))).toBe('1h');
    expect(segmentFor(result([text('1h')], '5m'))).toBe('1h');
    expect(segmentFor(result([text('5m')], '1h'))).toBe('1h');
  });

  it('a big tool schema can trip the per-call cap before any request', async () => {
    const bigTool: AiTool = {
      ...weather,
      input_schema: { type: 'object', description: 'z'.repeat(400_000) },
    };
    let called = false;
    await expect(
      callAnthropic(
        gatewayEnv({ AI_MAX_CALL_USD: '0.05' }),
        USERS.member,
        {
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 100,
          model: 'claude-sonnet-5',
          tools: [bigTool],
        },
        async () => {
          called = true;
          return reply();
        },
      ),
    ).rejects.toMatchObject({ status: 429, code: 'ai_budget_per_call_cap' });
    expect(called).toBe(false);
  });
});

describe('response normalization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops malformed provider blocks and logs only a well-formed type', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      normalizeContent([
        { type: 'text', text: 7 },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: 'not an object' },
        { type: 'thinking', thinking: 'x' },
        { type: 'redacted_thinking' },
        { type: 'Not A Type; with spaces' },
        null,
        'text',
        { type: 'redacted_thinking', data: 'kept' },
      ]),
    ).toEqual([{ type: 'redacted_thinking', data: 'kept' }]);
    expect(loggedEvents(warn.mock.calls).map((e) => e.block_type)).toEqual([
      'text',
      'tool_use',
      'thinking',
      'redacted_thinking',
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect(normalizeContent(undefined)).toEqual([]);
    expect(normalizeContent({ type: 'text', text: 'x' })).toEqual([]);
  });

  it('an empty system array or string sends no system field', () => {
    expect(buildWireRequest('claude-sonnet-5', { messages: [], system: [] })).toEqual({
      messages: [],
    });
    expect(buildWireRequest('claude-sonnet-5', { messages: [], system: '' })).toEqual({
      messages: [],
    });
  });
});
