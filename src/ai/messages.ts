// The Messages API wire shapes: built from an allowlist on the way out, normalized on the way in.
//
// OUT: buildWireRequest() REBUILDS system, messages, tools and tool_choice field by field from the
// typed shapes in ./types — nothing a caller passes is forwarded by reference-as-is except a tool's
// JSON Schema and a tool_use's input, which are data, not API switches. A block type, tool kind or
// field outside the allowlist is REFUSED (see src/ai/policy.ts for why each exclusion exists);
// `undefined`-valued fields count as absent, the way JSON.stringify treats them (onlyKeys, the
// one key rule policy.ts's assertWire uses too).
//
// IN: normalizeContent() maps the provider's content array to the same block types, keeping
// exactly the fields a later request must send back (thinking blocks whole, signature included).
// A block type this client never asks for is dropped with a content-free log line.
import { logEvent } from '../platform/logEvent';
import { assertToolChoiceAllowed, onlyKeys, refuse } from './policy';
import type { PromptSegment } from './pricing';
import type {
  AiCacheControl,
  AiCallInput,
  AiContentBlock,
  AiMessage,
  AiTextBlock,
  AiTool,
  AiToolChoice,
} from './types';

type Obj = Record<string, unknown>;

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const TOOL_USE_ID = /^[a-zA-Z0-9_-]{1,256}$/;
const BLOCK_TYPE_LOG = /^[a-z][a-z0-9_]{0,63}$/;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wireCacheControl(value: unknown): AiCacheControl | undefined {
  if (value === undefined) return undefined;
  if (!isObj(value) || value.type !== 'ephemeral' || !onlyKeys(value, ['type', 'ttl'])) {
    throw refuse('cache_control');
  }
  if (value.ttl === undefined) return { type: 'ephemeral' };
  if (value.ttl !== '5m' && value.ttl !== '1h') throw refuse('cache_control');
  return { type: 'ephemeral', ttl: value.ttl };
}

/** `{...base, cache_control}` when one is set; `base` alone otherwise. */
function withCache<T extends Obj>(base: T, raw: Obj): T & { cache_control?: AiCacheControl } {
  const cache = wireCacheControl(raw.cache_control);
  return cache ? { ...base, cache_control: cache } : base;
}

function wireText(raw: unknown): AiTextBlock {
  if (!isObj(raw) || raw.type !== 'text') throw refuse('block_type');
  if (!onlyKeys(raw, ['type', 'text', 'cache_control']) || typeof raw.text !== 'string') {
    throw refuse('block_field');
  }
  return withCache({ type: 'text' as const, text: raw.text }, raw);
}

function wireBlock(raw: unknown): AiContentBlock {
  if (!isObj(raw)) throw refuse('block_field');
  switch (raw.type) {
    case 'text':
      return wireText(raw);
    case 'tool_use': {
      if (
        !onlyKeys(raw, ['type', 'id', 'name', 'input', 'cache_control']) ||
        typeof raw.id !== 'string' ||
        !TOOL_USE_ID.test(raw.id) ||
        typeof raw.name !== 'string' ||
        !TOOL_NAME.test(raw.name) ||
        !isObj(raw.input)
      ) {
        throw refuse('block_field');
      }
      return withCache(
        { type: 'tool_use' as const, id: raw.id, name: raw.name, input: raw.input },
        raw,
      );
    }
    case 'tool_result': {
      if (
        !onlyKeys(raw, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control']) ||
        typeof raw.tool_use_id !== 'string' ||
        !TOOL_USE_ID.test(raw.tool_use_id) ||
        (raw.is_error !== undefined && typeof raw.is_error !== 'boolean')
      ) {
        throw refuse('block_field');
      }
      let content: string | AiTextBlock[] | undefined;
      if (raw.content === undefined || typeof raw.content === 'string') content = raw.content;
      // Text only: an image, document, search-result or tool-reference inside a result is a
      // block type this path has not enabled.
      else if (Array.isArray(raw.content)) content = raw.content.map(wireText);
      else throw refuse('block_field');
      return withCache(
        {
          type: 'tool_result' as const,
          tool_use_id: raw.tool_use_id,
          ...(content !== undefined ? { content } : {}),
          ...(raw.is_error !== undefined ? { is_error: raw.is_error } : {}),
        },
        raw,
      );
    }
    case 'thinking':
      // Round-tripped verbatim: no cache_control (the API rejects it on thinking blocks).
      if (
        !onlyKeys(raw, ['type', 'thinking', 'signature']) ||
        typeof raw.thinking !== 'string' ||
        typeof raw.signature !== 'string'
      ) {
        throw refuse('block_field');
      }
      return { type: 'thinking', thinking: raw.thinking, signature: raw.signature };
    case 'redacted_thinking':
      if (!onlyKeys(raw, ['type', 'data']) || typeof raw.data !== 'string') {
        throw refuse('block_field');
      }
      return { type: 'redacted_thinking', data: raw.data };
    default:
      // image, document (a Files API `file_id` source rides here), search_result,
      // server_tool_use, *_tool_result, container_upload, mcp_tool_use, …
      throw refuse('block_type');
  }
}

function wireMessage(raw: unknown): AiMessage {
  if (!isObj(raw) || !onlyKeys(raw, ['role', 'content'])) throw refuse('message');
  // 'system' is a mid-conversation role the API accepts; this path does not enable it.
  if (raw.role !== 'user' && raw.role !== 'assistant') throw refuse('message');
  if (typeof raw.content === 'string') return { role: raw.role, content: raw.content };
  if (!Array.isArray(raw.content)) throw refuse('message');
  return { role: raw.role, content: raw.content.map(wireBlock) };
}

function wireSystem(raw: unknown): string | AiTextBlock[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) throw refuse('system');
  if (raw.length === 0) return undefined;
  return raw.map((b) => {
    if (!isObj(b) || b.type !== 'text') throw refuse('system');
    return wireText(b);
  });
}

/**
 * Validates a tool set and returns it rebuilt for the wire. Custom tools only: a tool with any
 * `type` but 'custom' (web_search_*, code_execution_*, bash_*, mcp_toolset, …) is refused, and so
 * is any field beyond name / description / input_schema / cache_control — `allowed_callers` turns
 * on programmatic tool calling, which is outside zero data retention. Call it where a tool set is
 * DEFINED to fail at startup rather than on the first model call; the client calls it every time.
 */
export function assertCustomTools(tools: readonly unknown[]): AiTool[] {
  if (!Array.isArray(tools)) throw refuse('tool_invalid');
  const seen = new Set<string>();
  return tools.map((raw) => {
    if (!isObj(raw)) throw refuse('tool_invalid');
    if (raw.type !== undefined && raw.type !== 'custom') throw refuse('server_tool');
    if (!onlyKeys(raw, ['type', 'name', 'description', 'input_schema', 'cache_control'])) {
      throw refuse('tool_field');
    }
    if (
      typeof raw.name !== 'string' ||
      !TOOL_NAME.test(raw.name) ||
      (raw.description !== undefined && typeof raw.description !== 'string') ||
      !isObj(raw.input_schema) ||
      raw.input_schema.type !== 'object'
    ) {
      throw refuse('tool_invalid');
    }
    if (seen.has(raw.name)) throw refuse('tool_duplicate');
    seen.add(raw.name);
    return withCache(
      {
        name: raw.name,
        ...(raw.description !== undefined ? { description: raw.description } : {}),
        input_schema: raw.input_schema as AiTool['input_schema'],
      },
      raw,
    );
  });
}

function wireToolChoice(
  raw: unknown,
  toolNames: ReadonlySet<string>,
  model: string,
): AiToolChoice | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) throw refuse('tool_choice');
  const parallel = raw.disable_parallel_tool_use;
  if (parallel !== undefined && typeof parallel !== 'boolean') throw refuse('tool_choice');
  const noParallel = parallel !== undefined ? { disable_parallel_tool_use: parallel } : {};
  let choice: AiToolChoice;
  switch (raw.type) {
    case 'none':
      if (!onlyKeys(raw, ['type'])) throw refuse('tool_choice');
      return { type: 'none' };
    case 'auto':
    case 'any':
      if (!onlyKeys(raw, ['type', 'disable_parallel_tool_use'])) throw refuse('tool_choice');
      choice = { type: raw.type, ...noParallel };
      break;
    case 'tool':
      if (
        !onlyKeys(raw, ['type', 'name', 'disable_parallel_tool_use']) ||
        typeof raw.name !== 'string' ||
        !toolNames.has(raw.name)
      ) {
        throw refuse('tool_choice');
      }
      choice = { type: 'tool', name: raw.name, ...noParallel };
      break;
    default:
      throw refuse('tool_choice');
  }
  // auto / any / tool steer tools; without any, the request is incoherent.
  if (toolNames.size === 0) throw refuse('tool_choice');
  assertToolChoiceAllowed(model, choice.type);
  return choice;
}

export interface WireRequest {
  system?: string | AiTextBlock[];
  messages: AiMessage[];
  tools?: AiTool[];
  tool_choice?: AiToolChoice;
}

/** The validated, rebuilt system / messages / tools / tool_choice. Throws `ai_request_refused`. */
export function buildWireRequest(model: string, input: AiCallInput): WireRequest {
  if (!Array.isArray(input.messages)) throw refuse('message');
  const system = wireSystem(input.system);
  const messages = input.messages.map(wireMessage);
  // Validated even when empty: a non-array `tools` is refused, never read as "no tools".
  const checked = input.tools === undefined ? [] : assertCustomTools(input.tools);
  const tools = checked.length > 0 ? checked : undefined;
  const toolChoice = wireToolChoice(
    input.toolChoice,
    new Set((tools ?? []).map((t) => t.name)),
    model,
  );
  return {
    ...(system !== undefined ? { system } : {}),
    messages,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

function blockChars(block: AiContentBlock): number {
  // Text counts its characters (the plain-prompt estimate is unchanged); a structured block counts
  // its serialized JSON — an overcount of a few keys, never an undercount of a tool payload.
  return block.type === 'text' ? block.text.length : JSON.stringify(block).length;
}

/** A block's cache-breakpoint TTL ('5m' when it names none), or undefined when it has none. */
function cacheTtl(block: { cache_control?: AiCacheControl }): '5m' | '1h' | undefined {
  return block.cache_control ? (block.cache_control.ttl ?? '5m') : undefined;
}

/**
 * A message block's TTL for the estimate: its own, or — for a tool_result — the LONGEST found on it
 * or on any text block in its content. A breakpoint nested in a result is sent (wireText keeps it)
 * and the provider writes the prefix up to it, so reading only the result's own marker priced that
 * prefix as plain input. Marking the whole result can only over-read: by the part after the
 * nested breakpoint.
 */
function blockCacheTtl(block: AiContentBlock): '5m' | '1h' | undefined {
  // Thinking blocks carry no cache_control (the API rejects it there).
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return undefined;
  const ttls = [cacheTtl(block)];
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    ttls.push(...block.content.map(cacheTtl));
  }
  if (ttls.includes('1h')) return '1h';
  return ttls.includes('5m') ? '5m' : undefined;
}

/** The request as estimator segments, in the provider's cache-prefix order. */
export function promptSegments(request: WireRequest): PromptSegment[] {
  const segments: PromptSegment[] = [];
  for (const tool of request.tools ?? []) {
    segments.push({ chars: JSON.stringify(tool).length, cacheTtl: cacheTtl(tool) });
  }
  if (typeof request.system === 'string') segments.push({ chars: request.system.length });
  else {
    for (const b of request.system ?? []) {
      segments.push({ chars: b.text.length, cacheTtl: cacheTtl(b) });
    }
  }
  for (const m of request.messages) {
    if (typeof m.content === 'string') segments.push({ chars: m.content.length });
    else {
      for (const b of m.content) {
        segments.push({ chars: blockChars(b), cacheTtl: blockCacheTtl(b) });
      }
    }
  }
  return segments;
}

/** One provider response block → a client block, or null for a type this client never asks for. */
export function normalizeBlock(raw: unknown): AiContentBlock | null {
  if (!isObj(raw)) return null;
  switch (raw.type) {
    case 'text':
      return typeof raw.text === 'string' ? { type: 'text', text: raw.text } : null;
    case 'tool_use':
      return typeof raw.id === 'string' && typeof raw.name === 'string' && isObj(raw.input)
        ? { type: 'tool_use', id: raw.id, name: raw.name, input: raw.input }
        : null;
    case 'thinking':
      return typeof raw.thinking === 'string' && typeof raw.signature === 'string'
        ? { type: 'thinking', thinking: raw.thinking, signature: raw.signature }
        : null;
    case 'redacted_thinking':
      return typeof raw.data === 'string' ? { type: 'redacted_thinking', data: raw.data } : null;
    default:
      return null;
  }
}

/** The provider's type for a dropped block, safe to log (an enum-shaped token, or 'unknown'). */
export function blockTypeForLog(raw: unknown): string {
  const type = isObj(raw) ? raw.type : undefined;
  return typeof type === 'string' && BLOCK_TYPE_LOG.test(type) ? type : 'unknown';
}

/** The provider's content array, normalized; blocks this client never asks for are dropped. */
export function normalizeContent(raw: unknown): AiContentBlock[] {
  if (!Array.isArray(raw)) return [];
  const blocks: AiContentBlock[] = [];
  for (const item of raw) {
    const block = normalizeBlock(item);
    if (block) blocks.push(block);
    else logEvent('ai_response_block_dropped', { block_type: blockTypeForLog(item) });
  }
  return blocks;
}
