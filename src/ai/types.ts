// Public shapes of the AI client: what a caller may send and what comes back. Every field here is
// on the Messages API's zero-data-retention path; anything outside it is not typed here and is
// refused at runtime if it arrives anyway (src/ai/messages.ts rebuilds the wire body from these
// shapes, src/ai/policy.ts refuses the rest).
import type { TokenUsage } from './pricing';

/** How hard the model works on a call (`output_config.effort`); lower spends fewer tokens. */
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A prompt-cache breakpoint. `ttl` defaults to 5 minutes; '1h' writes bill 2× input, not 1.25×. */
export interface AiCacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export interface AiTextBlock {
  type: 'text';
  text: string;
  cache_control?: AiCacheControl;
}

/** The model asking to run one of the caller's custom tools. `input` follows the tool's schema. */
export interface AiToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: AiCacheControl;
}

/** The caller's answer to a tool_use, in the next user message. Text only on this path. */
export interface AiToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AiTextBlock[];
  is_error?: boolean;
  cache_control?: AiCacheControl;
}

/**
 * The model's reasoning. Returned by the thinking-by-default models (Opus 5.5, Opus 5, Sonnet 5),
 * usually with an empty `thinking` and the reasoning encrypted in `signature`. Within a tool-use
 * turn it MUST go back to the API unchanged, in order, with the tool_use it accompanied — a caller
 * that drops or edits it gets a 400 — so it is a first-class block here, not a filtered one.
 */
export interface AiThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/** Safety-redacted reasoning: opaque, and round-tripped exactly like a thinking block. */
export interface AiRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type AiContentBlock =
  | AiTextBlock
  | AiToolUseBlock
  | AiToolResultBlock
  | AiThinkingBlock
  | AiRedactedThinkingBlock;

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string | AiContentBlock[];
}

/**
 * A CUSTOM (client) tool: the model asks, the caller runs it. The only kind of tool this client
 * sends — server tools (code execution, web search/fetch, MCP toolsets, …) run on the provider's
 * side, several outside zero data retention, and are refused. `name` must match
 * `^[a-zA-Z0-9_-]{1,128}$`; `input_schema` is a JSON Schema object.
 */
export interface AiTool {
  type?: 'custom';
  name: string;
  description?: string;
  input_schema: { type: 'object'; [keyword: string]: unknown };
  cache_control?: AiCacheControl;
}

/** How the model may use the tools. `any` / `tool` force a call; Opus 5.5 refuses both. */
export type AiToolChoice =
  | { type: 'auto' | 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }
  | { type: 'none' };

export interface AiCallInput {
  system?: string | AiTextBlock[];
  messages: AiMessage[];
  maxTokens?: number;
  /** Defaults to env.AI_DEFAULT_MODEL; pass env.AI_LARGE_MODEL for the large tier. Must be on
   *  the model allowlist (src/ai/policy.ts). */
  model?: string;
  /** Optional cost-attribution tag for this call (e.g. 'summarize'), surfaced on the
   *  fleet-shared gateway as metadata `feature`. A short STATIC label only — gateway
   *  metadata is fleet-visible and capped at 5 keys, so never user content or PII.
   *  ENFORCED at runtime (FEATURE_TAG): a value that isn't a plain ASCII label is dropped
   *  with a console warning, never sent. */
  feature?: string;
  /** Optional reasoning depth. Sent only to models that accept this level (see effortFor);
   *  silently omitted otherwise, so one tier setting is safe across every model. */
  effort?: AiEffort;
  /** Custom tools only (see AiTool). Validated on every call; assertCustomTools() lets a caller
   *  validate a tool set once, where it is defined. */
  tools?: AiTool[];
  toolChoice?: AiToolChoice;
  /** Aborts the provider request (and, when streaming, the stream). The budget is settled on
   *  the way out either way: released only when the signal fired before the request was sent;
   *  once it was sent, billed — the provider charges a request whose client disconnects part-way
   *  (a non-streaming call books its whole reservation; see streamAnthropic for what an aborted
   *  stream books, and how a route must wire this). */
  signal?: AbortSignal;
}

export interface AiCallResult {
  /** The text blocks joined — the reply, for a caller that uses no tools. */
  text: string;
  /** Every block the model returned, normalized, in order — thinking blocks included. Append it
   *  unchanged as the assistant message when continuing a tool-use turn. */
  content: AiContentBlock[];
  model: string;
  usage: TokenUsage;
  costUsd: number;
  /** The provider's stop_reason (`end_turn`, `tool_use`, `max_tokens`, `pause_turn`, …), or null
   *  if absent. `max_tokens` means the reply was cut off — a caller storing it should reject or
   *  flag it. `refusal` never arrives here: the client throws `ai_refused` instead. */
  stopReason: string | null;
  /** Where the provider says inference ran (`usage.inference_geo`, e.g. `us`), or null if it did
   *  not say. The REQUEST is always pinned (AI_INFERENCE_GEO); this is the provider's echo of it. */
  inferenceGeo: string | null;
}

/**
 * What streamAnthropic yields, normalized from the provider's server-sent events. Block `index`
 * is the block's position in the final `content`. A stream that completes ends with exactly one
 * `message_stop` carrying the whole result; one that fails after the provider answered ends with
 * one `error` and then throws the matching AppError. Thinking is not streamed as events — its
 * blocks arrive, whole, in the final `content`.
 */
export type AiStreamEvent =
  | { type: 'message_start'; model: string }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'tool_use_start'; index: number; id: string; name: string }
  | { type: 'tool_input_delta'; index: number; partialJson: string }
  | {
      type: 'tool_use_stop';
      index: number;
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: 'message_delta'; stopReason: string | null; usage: TokenUsage }
  | { type: 'message_stop'; result: AiCallResult }
  | {
      type: 'error';
      code: 'ai_upstream_error' | 'ai_refused' | 'ai_aborted';
      /** The provider's error type for a mid-stream `error` event (e.g. `overloaded_error`). */
      providerErrorType?: string;
    };
