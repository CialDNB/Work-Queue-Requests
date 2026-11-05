// Server-sent events for the streaming Messages API, in two layers:
//
//   parseSse()      bytes → SSE events. Robust to where the network cuts the stream: a chunk may
//                   end mid-line, mid-`\r\n`, or mid-way through a multi-byte UTF-8 character.
//   MessageStream   SSE events → the client's normalized AiStreamEvents, while assembling the
//                   final message (content blocks, usage, stop_reason) the caller gets at the end.
//
// Event flow per the streaming docs (platform.claude.com/docs/en/build-with-claude/streaming,
// verified 2026-09-23): message_start (usage so far, stop_reason null) → per block a
// content_block_start, deltas, content_block_stop → message_delta (stop_reason, CUMULATIVE usage)
// → message_stop; `ping` anywhere; an `error` event mid-stream; unknown event types ignored.
import { logEvent } from '../platform/logEvent';
import { blockTypeForLog, normalizeBlock } from './messages';
import { normalizeUsage, type RequestEstimate, type TokenUsage } from './pricing';
import type { AiContentBlock, AiStreamEvent } from './types';

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parse an SSE byte stream (WHATWG event-stream rules): lines end in `\r\n`, `\n` or `\r`; a blank
 * line dispatches; `data:` lines join with `\n`; `:` lines are comments; one leading space after
 * the colon is dropped; a leading BOM is skipped. An event not closed by a blank line when the
 * stream ends is DISCARDED, as the spec requires — a truncated stream never yields a half event.
 * Stopping early (a consumer's `break`, a thrown error) cancels the underlying body, so the
 * provider connection closes rather than streaming into nothing.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  // stream: true holds back a multi-byte character split across chunks until its last byte.
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let started = false;
  let event = '';
  let data: string[] = [];
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (!started && buffer.length > 0) {
        if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
        started = true;
      }
      let lineStart = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer.charCodeAt(i);
        if (ch !== 0x0a && ch !== 0x0d) continue;
        // A `\r` that ends the buffer may be the first half of a `\r\n` split across chunks.
        if (ch === 0x0d && i === buffer.length - 1 && !done) break;
        const line = buffer.slice(lineStart, i);
        if (ch === 0x0d && buffer.charCodeAt(i + 1) === 0x0a) i++;
        lineStart = i + 1;
        if (line === '') {
          if (data.length > 0) yield { event: event || 'message', data: data.join('\n') };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        // `id`, `retry` and unknown fields carry nothing this client uses.
      }
      buffer = buffer.slice(lineStart);
      if (done) {
        finished = true;
        return;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
  }
}

/** A stream the provider broke or truncated. `providerErrorType` is its `error` event's type. */
export class StreamFault extends Error {
  constructor(
    readonly kind: 'provider_error' | 'malformed' | 'incomplete' | 'unoffered_tool',
    readonly providerErrorType?: string,
  ) {
    super(`ai stream ${kind}`);
    this.name = 'StreamFault';
  }
}

const ERROR_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

// Stop reasons after which a block may legitimately be cut short: the output budget or the context
// window ran out mid-block (stop-reason docs: "treat the response as truncated"), or a safety
// decline fired mid-block — a streaming decline while a tool call is still open "is returned
// directly" (refusals docs, verified 2026-09-23), and finish() then fails the call as ai_refused.
// After any other stop reason a broken or unclosed block means the stream itself is corrupt.
const CUT_SHORT: ReadonlySet<string> = new Set([
  'max_tokens',
  'model_context_window_exceeded',
  'refusal',
]);

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A block being assembled from its deltas. */
type OpenBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; json: string }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'redacted_thinking'; data: string }
  | { kind: 'dropped' };

/** Overlay the counters a later usage block reports on an earlier one (nulls never erase). */
function mergeUsage(into: Obj, from: unknown): void {
  if (!isObj(from)) return;
  for (const [key, value] of Object.entries(from)) {
    if (value !== null && value !== undefined) into[key] = value;
  }
}

export interface MessageStreamOptions {
  /** The model thinks by default without streaming its thinking (ModelPolicy.hiddenThinking). */
  hiddenThinking: boolean;
  /** The names of the tools the request offered: a tool call for any other name is a fault. */
  offeredTools: ReadonlySet<string>;
}

/**
 * Folds provider SSE events into normalized AiStreamEvents and the final message. Throws a
 * StreamFault on a provider `error` event or a stream that breaks the protocol. Knows nothing of
 * budgets or HTTP — the client owns those.
 */
export class MessageStream {
  model: string | null = null;
  stopReason: string | null = null;
  /** message_stop arrived: the message is complete. */
  stopped = false;
  private sawStart = false;
  /** A thinking or redacted_thinking block started: output the stream did not show was billed. */
  private sawThinking = false;
  /** A message_delta arrived: its usage is the cumulative count, thinking included. */
  private sawFinalUsage = false;
  private readonly usage: Obj = {};
  private readonly open = new Map<number, OpenBlock>();
  private readonly done = new Map<number, AiContentBlock>();
  /** Characters of generated text, tool input and thinking seen — an output floor on abort. */
  private streamedChars = 0;
  /** A tool_use whose accumulated input was not a JSON object (legitimate only when CUT_SHORT). */
  private truncatedToolInput = false;

  constructor(private readonly options: MessageStreamOptions) {}

  consume(sse: SseEvent): AiStreamEvent[] {
    let data: unknown;
    try {
      data = JSON.parse(sse.data);
    } catch {
      throw new StreamFault('malformed');
    }
    if (!isObj(data)) throw new StreamFault('malformed');
    const type = typeof data.type === 'string' ? data.type : sse.event;
    switch (type) {
      case 'message_start':
        return this.onMessageStart(data);
      case 'content_block_start':
        return this.onBlockStart(data);
      case 'content_block_delta':
        return this.onBlockDelta(data);
      case 'content_block_stop':
        return this.onBlockStop(data);
      case 'message_delta': {
        const delta = isObj(data.delta) ? data.delta : {};
        if (typeof delta.stop_reason === 'string') this.stopReason = delta.stop_reason;
        mergeUsage(this.usage, data.usage);
        if (isObj(data.usage)) this.sawFinalUsage = true;
        return [{ type: 'message_delta', stopReason: this.stopReason, usage: this.currentUsage() }];
      }
      case 'message_stop':
        this.stopped = true;
        return [];
      case 'error': {
        const err = isObj(data.error) ? data.error.type : undefined;
        throw new StreamFault(
          'provider_error',
          typeof err === 'string' && ERROR_TYPE.test(err) ? err : 'unknown',
        );
      }
      default:
        return []; // ping, and event types added after this client was written
    }
  }

  private onMessageStart(data: Obj): AiStreamEvent[] {
    const message = isObj(data.message) ? data.message : {};
    this.sawStart = true;
    if (typeof message.model === 'string' && message.model) this.model = message.model;
    mergeUsage(this.usage, message.usage);
    return this.model ? [{ type: 'message_start', model: this.model }] : [];
  }

  private index(data: Obj): number {
    const index = data.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new StreamFault('malformed');
    }
    return index;
  }

  private onBlockStart(data: Obj): AiStreamEvent[] {
    const index = this.index(data);
    if (this.open.has(index) || this.done.has(index)) throw new StreamFault('malformed');
    const block = isObj(data.content_block) ? data.content_block : {};
    switch (block.type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : '';
        this.open.set(index, { kind: 'text', text });
        this.streamedChars += text.length;
        return text ? [{ type: 'text_delta', index, text }] : [];
      }
      case 'tool_use':
        if (typeof block.id !== 'string' || typeof block.name !== 'string') {
          throw new StreamFault('malformed');
        }
        // Only a tool this request offered, refused before the call is announced: a caller that
        // dispatches by name from a wider registry must never be handed a call for a tool the
        // model was not given (without `strict`, nothing constrains what the model emits).
        if (!this.options.offeredTools.has(block.name)) throw new StreamFault('unoffered_tool');
        this.open.set(index, { kind: 'tool_use', id: block.id, name: block.name, json: '' });
        return [{ type: 'tool_use_start', index, id: block.id, name: block.name }];
      case 'thinking':
        this.sawThinking = true;
        this.open.set(index, {
          kind: 'thinking',
          thinking: typeof block.thinking === 'string' ? block.thinking : '',
          signature: typeof block.signature === 'string' ? block.signature : '',
        });
        return [];
      case 'redacted_thinking':
        this.sawThinking = true;
        this.open.set(index, {
          kind: 'redacted_thinking',
          data: typeof block.data === 'string' ? block.data : '',
        });
        return [];
      default:
        logEvent('ai_response_block_dropped', { block_type: blockTypeForLog(block) });
        this.open.set(index, { kind: 'dropped' });
        return [];
    }
  }

  private onBlockDelta(data: Obj): AiStreamEvent[] {
    const index = this.index(data);
    const block = this.open.get(index);
    if (!block) throw new StreamFault('malformed');
    const delta = isObj(data.delta) ? data.delta : {};
    if (delta.type === 'text_delta' && block.kind === 'text' && typeof delta.text === 'string') {
      block.text += delta.text;
      this.streamedChars += delta.text.length;
      return [{ type: 'text_delta', index, text: delta.text }];
    }
    if (
      delta.type === 'input_json_delta' &&
      block.kind === 'tool_use' &&
      typeof delta.partial_json === 'string'
    ) {
      block.json += delta.partial_json;
      this.streamedChars += delta.partial_json.length;
      return delta.partial_json
        ? [{ type: 'tool_input_delta', index, partialJson: delta.partial_json }]
        : [];
    }
    if (delta.type === 'thinking_delta' && block.kind === 'thinking') {
      if (typeof delta.thinking === 'string') {
        block.thinking += delta.thinking;
        this.streamedChars += delta.thinking.length;
      }
      return [];
    }
    if (delta.type === 'signature_delta' && block.kind === 'thinking') {
      if (typeof delta.signature === 'string') block.signature += delta.signature;
      return [];
    }
    return []; // citations_delta, deltas for a dropped block, and future delta types
  }

  private onBlockStop(data: Obj): AiStreamEvent[] {
    const index = this.index(data);
    const block = this.open.get(index);
    if (!block) throw new StreamFault('malformed');
    this.open.delete(index);
    switch (block.kind) {
      case 'text':
        this.done.set(index, { type: 'text', text: block.text });
        return [];
      case 'tool_use': {
        let input: unknown;
        try {
          input = block.json === '' ? {} : JSON.parse(block.json);
        } catch {
          input = undefined;
        }
        if (!isObj(input)) {
          // Cut off mid-input: never offered as a runnable call. finalMessage() decides from the
          // stop reason whether that was legitimate (see CUT_SHORT).
          this.truncatedToolInput = true;
          return [];
        }
        this.done.set(index, { type: 'tool_use', id: block.id, name: block.name, input });
        return [{ type: 'tool_use_stop', index, id: block.id, name: block.name, input }];
      }
      case 'thinking':
      case 'redacted_thinking': {
        const whole = normalizeBlock(
          block.kind === 'thinking'
            ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
            : { type: 'redacted_thinking', data: block.data },
        );
        if (whole) this.done.set(index, whole);
        return [];
      }
      default:
        return [];
    }
  }

  private currentUsage(): TokenUsage {
    return normalizeUsage(this.usage);
  }

  /** The usage block as the provider reported it so far (message_start overlaid by deltas). */
  reportedUsage(): Obj {
    return { ...this.usage };
  }

  /**
   * The finished message's content, in index order: closed blocks only, so a partial call never
   * looks whole. Throws if a tool call arrived broken, or a block never closed, after a stop
   * reason that does not explain it (see CUT_SHORT).
   */
  finalMessage(): {
    model: string | null;
    usage: Obj;
    stopReason: string | null;
    content: AiContentBlock[];
  } {
    const cutShort = this.truncatedToolInput || this.open.size > 0;
    if (cutShort && !(this.stopReason !== null && CUT_SHORT.has(this.stopReason))) {
      throw new StreamFault('malformed');
    }
    const content = [...this.done.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
    return { model: this.model, usage: this.reportedUsage(), stopReason: this.stopReason, content };
  }

  /**
   * Usage for a stream that ended ABNORMALLY (abort, cancel, a provider error, truncation),
   * for billing. Never below what the provider billed:
   *   - input: what message_start reported; with no message_start at all, the request was still
   *     accepted (2xx) and its input billed, so it comes from the pre-call estimate — its
   *     cache-marked prefix as the writes it was reserved as.
   *   - output: what the provider reported so far, floored at the streamed characters over the
   *     model's characters-per-token (see charsPerToken) — a message_delta may not have arrived
   *     to count them.
   *   - UNLESS output may have been generated that the stream never showed, and no message_delta
   *     has reported the cumulative count: the model thinks by default without streaming it
   *     (MessageStreamOptions.hiddenThinking), or a thinking block appeared (a `summarized`
   *     thinking stream carries a summary, not the billed tokens). Thinking is billed as output
   *     and may run anywhere up to max_tokens — even before its block opens — so the whole
   *     max_tokens is booked. Booking the characters seen instead let a Stop pressed while the
   *     model was thinking book ~$0.00007 of a $0.44 call, with no daily bound on repeating it.
   */
  observedUsage(estimate: RequestEstimate): TokenUsage {
    const hidden =
      !this.sawFinalUsage && (this.options.hiddenThinking || this.sawThinking)
        ? estimate.outputTokens
        : 0;
    const floor = Math.max(Math.ceil(this.streamedChars / estimate.charsPerToken), hidden);
    if (!this.sawStart) {
      const writes = estimate.cacheWrite5mTokens + estimate.cacheWrite1hTokens;
      return {
        input_tokens: estimate.inputTokens,
        output_tokens: floor,
        ...(writes > 0
          ? {
              cache_creation_input_tokens: writes,
              cache_creation: {
                ephemeral_5m_input_tokens: estimate.cacheWrite5mTokens,
                ephemeral_1h_input_tokens: estimate.cacheWrite1hTokens,
              },
            }
          : {}),
      };
    }
    const usage = this.currentUsage();
    return { ...usage, output_tokens: Math.max(usage.output_tokens, floor) };
  }
}
