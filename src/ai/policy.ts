// Request policy for the Anthropic client: which region inference may run in, which models may be
// called at all, and which API features may ride a request. Checked locally, before any secret is
// read or any budget is reserved, so a refusal leaves nothing behind. Every rule fails CLOSED.
//
// INFERENCE REGION (PIA C6). Every call carries `inference_geo`. The value is AI_INFERENCE_GEO:
// unset or empty means 'us' (the pin the PIA requires); 'global' is an explicit opt-out for dev and
// staging, which a fork records as "any location" in its own assessment, and is REFUSED in
// production — there "any location" is a DPO-assessed exception, not a var anyone can set from the
// dashboard; anything else is a misconfiguration and refuses the call. The field is always SENT —
// never left to the workspace default, which is a console setting outside this repo — so the region
// a request ran under is visible in code review.
//
// The model list and the region rule live in ./policyVocabulary.mjs, plain JavaScript, so that
// `npm run verify:edge` refuses a deploying wrangler config this module would refuse at runtime —
// one definition, not two lists that agree today.
//
// MODEL ALLOWLIST. `inference_geo` is accepted only by Claude 4.6 and later; on Opus 4.5, Sonnet
// 4.5, Haiku 4.5 or earlier it is a 400 (platform.claude.com/docs/en/manage-claude/data-residency,
// verified 2026-09-23). A model outside this list is refused before the call rather than sent to
// fail — or, worse, "fixed" by dropping the field and running wherever the provider likes. Exact
// ids only: every 4.6+ model id is its own pinned snapshot, so there is no dated alias to admit.
//
// Deliberately NOT listed, though they accept `inference_geo`:
//   - the Covered Models (Claude Fable 5 / 5.1, Mythos 5 / 5.1): they require 30-day retention
//     and are unavailable under zero data retention; PIA C6 makes using one a DPO decision.
//   - Opus 4.6 / 4.7: no kit config uses them, and each listed model carries a verified rate row
//     and effort row. Adding a model is one reviewed edit to all three tables (a test pins that).
//
// ZERO-DATA-RETENTION GUARD (PIA C6). Several API features store content at rest and sit outside
// a ZDR arrangement — and under ZDR the API does NOT block them; using one silently steps outside
// it (platform.claude.com/docs/en/manage-claude/api-and-data-retention, feature eligibility,
// verified 2026-09-23): the Batch API, the Files API, code execution and programmatic tool
// calling, the MCP connector, Agent Skills, containers, and web search/fetch dynamic filtering.
// So nothing reaches the wire unless it is on an allowlist:
//   - src/ai/messages.ts REBUILDS the body from typed shapes — custom tools only (no `type` but
//     'custom'; no `allowed_callers`, `defer_loading`, …), and text / tool_use / tool_result /
//     thinking blocks only (no image, document or Files API `file_id` source). Anything else is
//     refused, not dropped: a silently stripped tool would change what the model can do.
//   - assertWire() below is the backstop on what actually leaves: the /v1/messages endpoint only
//     (never /batches, /files, …), no `anthropic-beta` header (betas switch on the excluded
//     features), and top-level body keys from a fixed list (no `mcp_servers`, `container`,
//     `skills`, `context_management`, …). The builder never produces those; this pins that it
//     never will without a reviewed change here. `output_config` carries `effort` and, in one
//     fixed shape, a JSON-schema `format` (see STRUCTURED OUTPUTS below).
import type { Env } from '../env';
import { AppError } from '../framework/errors';
import { logEvent } from '../platform/logEvent';
import {
  INFERENCE_GEO_VAR,
  isAllowedModel,
  ALLOWED_MODELS as MODEL_TABLE,
  resolveInferenceGeo,
} from './policyVocabulary.mjs';
import type { InferenceGeo } from './pricing';

// Why a request was refused. A fixed vocabulary: the message and the log line name the rule,
// never a value from the request, so a refusal cannot leak content.
const REFUSALS = {
  server_tool:
    'only custom tools may be sent (server tools, MCP toolsets and other typed tools are outside zero data retention)',
  tool_field:
    'a tool definition carries a field outside the allowlist (allowed_callers, for one, turns on programmatic tool calling)',
  tool_invalid:
    'a tool needs a name matching ^[a-zA-Z0-9_-]{1,128}$, an optional string description and an object input_schema',
  tool_duplicate: 'tool names must be unique',
  tool_choice: 'tool_choice is malformed or names a tool that was not provided',
  forced_tool_choice: 'this model rejects forced tool use (tool_choice any or tool)',
  block_type:
    'a content block type outside text, tool_use, tool_result, thinking and redacted_thinking (images, documents and Files API references are not enabled)',
  block_field: 'a content block is malformed or carries a field outside the allowlist',
  message: 'a message is malformed or has a role other than user or assistant',
  system: 'system must be a string or text blocks',
  cache_control: 'cache_control must be {type: "ephemeral"} with an optional ttl of "5m" or "1h"',
  wire: 'the outgoing request carries an endpoint, header or field outside the allowlist',
} as const;

export type RefusalReason = keyof typeof REFUSALS;

/** A fail-closed refusal of a request shape: 500, because it is always a caller bug. */
export function refuse(reason: RefusalReason): AppError {
  logEvent('ai_request_refused', { reason });
  return new AppError(500, 'ai_request_refused', `AI request refused: ${REFUSALS[reason]}`);
}

export interface ModelPolicy {
  /** Accepts forced tool use (`tool_choice` `any` / `tool`). Opus 5.5 answers it with a 400. */
  forcedToolChoice: boolean;
  /**
   * Generates output a stream never shows: thinking is ON by default with `display: "omitted"`,
   * so its tokens are billed as output while the stream carries an empty `thinking_delta` and a
   * signature (thinking docs, verified 2026-09-23: on by default on Opus 5.5, Opus 5 and Sonnet 5;
   * off on Opus 4.8 and Sonnet 4.6 until a request sets `thinking`, which this client never sends —
   * it is not in assertWire's key list). A stream on such a model that ends early cannot count what
   * it generated, so it books the whole `max_tokens` (see MessageStream.observedUsage).
   */
  hiddenThinking: boolean;
}

/** The models the client may call — defined in ./policyVocabulary.mjs, typed here. */
export const ALLOWED_MODELS: Readonly<Record<string, ModelPolicy>> = MODEL_TABLE;

/**
 * The region every call is pinned to, from AI_INFERENCE_GEO (default 'us'). Throws on junk, and
 * on 'global' in production (resolveInferenceGeo is the one rule; verify:edge applies it too).
 */
export function inferenceGeoFor(env: Env): InferenceGeo {
  const geo = resolveInferenceGeo(env[INFERENCE_GEO_VAR], env.APP_ENV);
  if (geo === 'us' || geo === 'global') return geo;
  throw new AppError(
    503,
    'ai_unconfigured',
    geo === 'global_in_production'
      ? 'AI inference region "global" is refused in production'
      : 'AI inference region is misconfigured',
  );
}

/** The model's policy row, or a refusal: the model is not one the client may call. */
export function modelPolicy(model: string): ModelPolicy {
  // Own keys only — `constructor` must not read as a row.
  const row = isAllowedModel(model) ? ALLOWED_MODELS[model] : undefined;
  if (!row) {
    throw new AppError(
      503,
      'ai_model_not_allowed',
      'This AI model is not allowed: it cannot be pinned to an inference region',
    );
  }
  return row;
}

/** Forced tool use (`any` / `tool`) is a 400 on some models; refuse it before the call instead. */
export function assertToolChoiceAllowed(model: string, choiceType: string | undefined): void {
  if ((choiceType === 'any' || choiceType === 'tool') && !modelPolicy(model).forcedToolChoice) {
    throw refuse('forced_tool_choice');
  }
}

// ONE KEY RULE for every request shape, here and in messages.ts: a key counts only when its value
// is defined, because JSON.stringify drops an `undefined`-valued key and it never leaves. So
// `{ effort, format: wantsJson ? {...} : undefined }` is checked as the `{ effort }` it sends.

/** The object's keys whose values are defined — what JSON.stringify would actually send. */
export function definedKeys(o: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

/** True when every key the object would send is in `allowed`. */
export function onlyKeys(
  o: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return definedKeys(o).every((k) => allowed.includes(k));
}

// The Messages API parameters this client may send. Everything else — mcp_servers, container,
// skills, context_management, service_tier, metadata, thinking, temperature, … — is either outside
// zero data retention or a request-shape decision nobody has reviewed.
const WIRE_BODY_KEYS: readonly string[] = [
  'model',
  'max_tokens',
  'system',
  'messages',
  'tools',
  'tool_choice',
  'output_config',
  'inference_geo',
  'stream',
];
const WIRE_OUTPUT_CONFIG_KEYS: readonly string[] = ['effort', 'format'];

// STRUCTURED OUTPUTS (JSON). `output_config.format` passes in exactly one shape:
// `{ type: 'json_schema', schema: <plain object> }`. No other `type`, no key beside those two,
// and a schema that is not a plain object are all refused. The shape is the GA field
// (platform.claude.com/docs/en/build-with-claude/structured-outputs, verified 2026-09-25): no
// beta header, and the deprecated top-level `output_format` stays off the body-key list. Every
// model in the allowlist supports it.
//
// NEVER put request content in a schema. Structured outputs are ZDR "Yes (qualified)": prompts
// and outputs are not stored, but Anthropic caches the JSON schema for up to 24 hours since last
// use, outside the protections message content gets (api-and-data-retention, feature eligibility,
// verified 2026-09-25). A schema must be a fixed shape defined in code. Its property names,
// `enum` / `const` values, `pattern`s and descriptions must never carry request content,
// customer data or any per-call value, such as a name, an id or an allowed-values list built from
// the request. Put the data in the messages, where ZDR covers it.

/**
 * A plain JSON object: not null, not an array, not a class instance. Stricter than messages.ts's
 * `isObj` on purpose: a schema is JSON data, and a `Map` or `Date` would go out as `{}` or a string.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `output_config.format` as structured outputs define it, and nothing else. */
function isJsonSchemaFormat(format: unknown): boolean {
  return (
    isPlainObject(format) &&
    onlyKeys(format, ['type', 'schema']) &&
    format.type === 'json_schema' &&
    isPlainObject(format.schema)
  );
}

/** The last check on what leaves: endpoint, headers and top-level body keys. Throws on any drift. */
export function assertWire(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Readonly<Record<string, unknown>>,
): void {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    throw refuse('wire');
  }
  if (!path.endsWith('/v1/messages')) throw refuse('wire'); // never batches, files, skills, …
  if (Object.keys(headers).some((h) => h.toLowerCase() === 'anthropic-beta')) throw refuse('wire');
  if (!onlyKeys(body, WIRE_BODY_KEYS)) throw refuse('wire');
  if (body.inference_geo !== 'us' && body.inference_geo !== 'global') throw refuse('wire');
  const outputConfig = body.output_config;
  if (outputConfig !== undefined) {
    if (!isPlainObject(outputConfig)) throw refuse('wire');
    if (!onlyKeys(outputConfig, WIRE_OUTPUT_CONFIG_KEYS)) throw refuse('wire');
    if (outputConfig.format !== undefined && !isJsonSchemaFormat(outputConfig.format)) {
      throw refuse('wire');
    }
  }
}
