// Anthropic Messages client, pre-wired through Cloudflare AI Gateway.
//
// PRIVACY INVARIANT: every gateway request carries `cf-aig-collect-log-payload: false`.
// App content rides in prompts and must never persist in gateway logs — the gateway
// sees metadata only (tokens, cost, latency, model, status). This mirrors docshub's
// decision of 2026-06-11 and is the kit-wide default.
//
// Routing: when AI_GATEWAY_ID + AI_GATEWAY_TOKEN both resolve, calls go through
// gateway.ai.cloudflare.com. The gateway is FLEET-SHARED — one authenticated gateway
// (`all-pr-apps`) for every kit app, because Cloudflare caps AI Gateways at ~20/account —
// and per-app attribution rides the `cf-aig-metadata` header ({ app, env } from the
// required APP_NAME/APP_ENV vars): gateway logs, analytics, and spend limits all slice on
// it. See DECISIONS 2026-08-28. Otherwise, in dev/staging ONLY: direct api.anthropic.com
// with a console warning. In PRODUCTION the direct fallback is refused (fail closed) so app
// content can never bypass the gateway's no-log header. Unsetting AI_GATEWAY_ID is the kill
// switch. Raw fetch (not the SDK) is deliberate — ported from docshub, keeps the gateway
// path explicit and the worker lean.
//
// REQUEST POLICY (src/ai/policy.ts, src/ai/messages.ts): every call is pinned to an inference
// region, goes only to a model that accepts the pin, and carries only custom tools and the
// zero-data-retention-eligible content blocks — all checked before a secret is read or a cent
// is reserved.
//
// STREAMING (streamAnthropic): the same gates, headers and billing, over server-sent events. The
// budget reservation is settled exactly once — completion, refusal, provider error, truncation,
// abort, or a consumer that stops with `break` / `return()` — in the generator's `finally`. A
// generator dropped WITHOUT `return()` never reaches that `finally`; see streamAnthropic for how a
// route must bridge it.
//
// CI never calls this module: tests inject a fake fetcher, and no API key exists in CI.
import { type Env, getSecret } from '../env';
import { AppError } from '../framework/errors';
import { logEvent } from '../platform/logEvent';
import { reconcileBudget, reserveBudget } from './budget';
import { buildWireRequest, normalizeContent, promptSegments } from './messages';
import { assertWire, inferenceGeoFor, type ModelPolicy, modelPolicy } from './policy';
import {
  baseModelId,
  billedTokens,
  costUsd,
  estimateRequest,
  type InferenceGeo,
  normalizeUsage,
  type RequestEstimate,
  TOOL_USE_PROMPT_TOKENS,
  type TokenUsage,
} from './pricing';
import { MessageStream, parseSse, StreamFault } from './sse';
import type { AiCallInput, AiCallResult, AiContentBlock, AiEffort, AiStreamEvent } from './types';

export { assertCustomTools } from './messages';
export type {
  AiCacheControl,
  AiCallInput,
  AiCallResult,
  AiContentBlock,
  AiEffort,
  AiMessage,
  AiRedactedThinkingBlock,
  AiStreamEvent,
  AiTextBlock,
  AiThinkingBlock,
  AiTool,
  AiToolChoice,
  AiToolResultBlock,
  AiToolUseBlock,
} from './types';

const ANTHROPIC_VERSION = '2023-06-01';
const DIRECT_URL = 'https://api.anthropic.com/v1/messages';

export function gatewayMessagesUrl(accountId: string, gatewayId: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic/v1/messages`;
}

// Which effort levels each model accepts (claude-api reference, 2026-09-22). This table is the
// ONE place the client varies request shape by model. Sending a level a model does not accept
// is a 400 — Haiku 4.5 rejects `effort` outright, Sonnet 4.6 has no `xhigh` — so a model absent
// here, or a level it does not list, gets no `output_config` and runs at its own default. That
// costs tokens, never the call. Deliberately NOT sent to any model, ever: `thinking.budget_tokens`
// and `temperature`/`top_p`/`top_k` (all four are a 400 on the generation-5 models).
const ALL_EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LEVELS: Record<string, readonly AiEffort[]> = {
  'claude-opus-5-5': ALL_EFFORTS,
  'claude-sonnet-5': ALL_EFFORTS,
  'claude-opus-5': ALL_EFFORTS,
  'claude-opus-4-8': ALL_EFFORTS,
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
  'claude-haiku-4-5': [],
};

/** The effort to send for this model, or undefined when the model would reject it. */
export function effortFor(model: string, effort: AiEffort | undefined): AiEffort | undefined {
  if (effort === undefined) return undefined;
  const id = baseModelId(model); // a dated snapshot shares its alias's request surface
  const levels = Object.hasOwn(EFFORT_LEVELS, id) ? EFFORT_LEVELS[id] : undefined;
  return levels?.includes(effort) ? effort : undefined;
}

// The only shape a feature tag may have: a short static ASCII label. Anything else is
// refused — user content/PII must never reach the fleet-visible gateway logs, and a
// non-Latin-1 header value would make fetch() throw for every call carrying it.
const FEATURE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The echoed region is provider data headed for logs and audit payloads: a short lowercase token
// or nothing.
const GEO_ECHO = /^[a-z][a-z0-9_-]{0,31}$/;

function echoedGeo(usage: unknown): string | null {
  const geo =
    usage && typeof usage === 'object'
      ? (usage as Record<string, unknown>).inference_geo
      : undefined;
  return typeof geo === 'string' && GEO_ECHO.test(geo) ? geo : null;
}

/**
 * The region to PRICE a call at: 'us' if the call was pinned there or the provider says it ran
 * there (either bills the 1.1× multiplier, so the ledger never under-reads). A pinned call the
 * provider reports running elsewhere is a residency breach signal for PIA C6 — logged
 * content-free, never silently accepted.
 */
function pricedGeo(requested: InferenceGeo, echoed: string | null): InferenceGeo {
  if (requested === 'us' && echoed !== null && echoed !== 'us') {
    logEvent('ai_inference_geo_mismatch', { requested, echoed });
  }
  return requested === 'us' || echoed === 'us' ? 'us' : 'global';
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

// LOG HYGIENE (PIA C5): Workers Logs must never hold prompt or completion content. A provider
// error body can quote the request back (a 400 names the offending field and its value), and a
// JSON SyntaxError's message carries a snippet of the text it failed on — so failure logs carry
// the HTTP status, the provider's error TYPE and the error's category (logEvent reduces a thrown
// value to its name, code and status), never a body or a message.
const ERROR_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The provider's error TYPE, or 'unknown'. Reads the body; logs none of it. Anthropic's
 * `error.type` (e.g. `overloaded_error`), or `gateway_<code>` for an AI Gateway refusal, which
 * answers with an array of `{ code, message }` — the numeric code only, never the message.
 */
export async function providerErrorType(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown } | unknown[] | null;
    const error = Array.isArray(body) ? body : body?.error;
    if (Array.isArray(error)) {
      const code = (error[0] as { code?: unknown } | null | undefined)?.code;
      return typeof code === 'number' && Number.isSafeInteger(code) && code >= 0
        ? `gateway_${code}`
        : 'unknown';
    }
    const type = (error as { type?: unknown } | null | undefined)?.type;
    return typeof type === 'string' && ERROR_TYPE.test(type) ? type : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A call that passed every gate and holds a budget reservation that must be settled once. */
interface PreparedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  model: string;
  policy: ModelPolicy;
  /** The tool names the request offered — the only ones a response may call. */
  offeredTools: ReadonlySet<string>;
  geo: InferenceGeo;
  estimate: RequestEstimate;
  day: string;
  reservedUsd: number;
}

/**
 * Every gate, in order, then the reservation LAST — so any refusal leaves nothing reserved:
 *   1. local policy (no I/O): region, model allowlist, request shape (the ZDR guard);
 *   2. configuration: the API key, and the gateway in production;
 *   3. the outgoing request, checked once more as it will leave (assertWire);
 *   4. the budget reservation, sized by the whole-request estimate.
 */
async function prepareCall(
  env: Env,
  actorEmail: string,
  input: AiCallInput,
  stream: boolean,
): Promise<PreparedCall> {
  const model = input.model ?? env.AI_DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? 4096;

  // 1. Local policy (src/ai/policy.ts): the inference region every call is pinned to, a model
  //    that accepts that pin, and a request rebuilt from the ZDR-eligible allowlist.
  const geo = inferenceGeoFor(env);
  const policy = modelPolicy(model);
  const request = buildWireRequest(model, input);

  // 2. Configuration. The direct api.anthropic.com fallback bypasses the gateway's
  //    `cf-aig-collect-log-payload: false` header, so app content would reach the provider with
  //    no no-log guarantee. NEVER allow that in production — fail closed and require the gateway.
  //    (Dev/staging keep the fallback for convenience.)
  const apiKey = await getSecret(env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    throw new AppError(503, 'ai_unconfigured', 'AI is not configured for this app yet');
  }
  const gatewayToken = await getSecret(env.AI_GATEWAY_TOKEN);
  const useGateway = Boolean(env.AI_GATEWAY_ID && gatewayToken);
  if (!useGateway && env.APP_ENV === 'production') {
    throw new AppError(
      503,
      'ai_unconfigured',
      'AI gateway is not configured; refusing the direct provider fallback in production',
    );
  }

  // 3. The request as it will leave.
  const url = useGateway
    ? gatewayMessagesUrl(env.CF_ACCOUNT_ID, env.AI_GATEWAY_ID as string)
    : DIRECT_URL;
  if (!useGateway) {
    logEvent('ai_gateway_not_configured'); // calling api.anthropic.com directly (non-production)
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'x-api-key': apiKey,
  };
  if (useGateway) {
    headers['cf-aig-authorization'] = `Bearer ${gatewayToken}`;
    headers['cf-aig-collect-log-payload'] = 'false'; // NEVER remove — see header comment
    // The fleet gateway's cache is off by policy, but that policy lives in gateway config
    // someone could change. Skip the cache per-request too: gateway cache keys ignore which
    // app asked, so a cached completion could be served across apps.
    headers['cf-aig-skip-cache'] = 'true';
    // Per-app attribution on the fleet-shared gateway. Static identifiers only: metadata
    // lands in gateway logs (fleet-visible), so no user emails/PII, ever — the per-user
    // ledger is budget.ts. Cloudflare keeps at most 5 metadata keys per request.
    const feature = input.feature && FEATURE_TAG.test(input.feature) ? input.feature : undefined;
    if (input.feature && !feature) {
      logEvent('ai_feature_tag_rejected'); // not a static ASCII label; omitted from metadata
    }
    headers['cf-aig-metadata'] = JSON.stringify({
      app: env.APP_NAME,
      env: env.APP_ENV,
      ...(feature ? { feature } : {}),
    });
  }
  const effort = effortFor(model, input.effort);
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    ...request,
    ...(effort ? { output_config: { effort } } : {}),
    inference_geo: geo, // EVERY call, both routes (gateway and dev direct) — PIA C6
    ...(stream ? { stream: true } : {}),
  };
  assertWire(url, headers, body);

  // 4. Budget gate BEFORE the call (atomic reservation; settled exactly once after).
  const estimate = estimateRequest(model, promptSegments(request), {
    maxTokens,
    toolPromptTokens: request.tools ? TOOL_USE_PROMPT_TOKENS : 0,
    geo,
  });
  const reservation = await reserveBudget(env, actorEmail, estimate.usd);
  if (!reservation.ok) {
    throw new AppError(
      429,
      `ai_budget_${reservation.reason}`,
      'AI budget limit reached; try again later',
    );
  }
  return {
    url,
    headers,
    body,
    model,
    policy,
    offeredTools: new Set((request.tools ?? []).map((tool) => tool.name)),
    geo,
    estimate,
    day: reservation.day,
    reservedUsd: reservation.reservedUsd,
  };
}

/** What a settled call books: the model that ran, its usage and its price. */
interface Billing {
  model: string;
  usage: TokenUsage;
  costUsd: number;
}

/** Settle the reservation against what was billed (null releases it) and append the usage row. */
async function settle(
  env: Env,
  actorEmail: string,
  call: PreparedCall,
  billed: Billing | null,
): Promise<void> {
  await reconcileBudget(
    env,
    actorEmail,
    call.day,
    call.reservedUsd,
    billed
      ? {
          model: billed.model,
          inputTokens: billed.usage.input_tokens,
          outputTokens: billed.usage.output_tokens,
          costUsd: billed.costUsd,
        }
      : null,
  );
}

/**
 * What a non-streaming call books when it was sent but its body never arrived whole — an abort
 * after the request left (before or after the 2xx), a truncated or non-JSON body: the reservation,
 * as it stands. A non-streaming 2xx is sent once the message is complete, and a request whose
 * client disconnects part-way is still charged, so the provider may have generated and billed all
 * of it, and the worst-case estimate is the only bound on what it cost. Releasing would under-read
 * spend; this can only over-read by the estimate's margin.
 */
function reservedBilling(call: PreparedCall): Billing {
  const e = call.estimate;
  return {
    model: call.model,
    usage: {
      input_tokens: e.inputTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens,
      output_tokens: e.outputTokens,
    },
    costUsd: call.reservedUsd,
  };
}

/**
 * FRESH MODEL OUTPUT. Every `content` array this client hands back — callAnthropic's result and
 * the `message_stop` result of streamAnthropic — is frozen and registered here the moment it is
 * built. isModelOutput(x) then answers one question: is `x` that very array, as this isolate
 * received it from the provider? A copy is not. A message rebuilt from storage (a stored
 * transcript, a Workflow step's persisted result), assembled by hand, or round-tripped through
 * JSON is a different object, and the frozen array cannot have a block appended to it.
 *
 * It exists for a consumer that must act ONLY on what the model just said: the UI-intent gate
 * (src/ai/uiIntents.ts) throws on anything else. The set is module-private and nothing outside
 * this file adds to it. A WeakSet, so a result the caller drops is not kept alive.
 */
const MODEL_OUTPUT = new WeakSet<object>();

/** Is `content` a `content` array this client returned, unchanged and not a copy? */
export function isModelOutput(content: unknown): content is readonly AiContentBlock[] {
  return typeof content === 'object' && content !== null && MODEL_OUTPUT.has(content);
}

/** A finished provider message, before it is priced. Every field but `content` is unchecked. */
interface ProviderMessage {
  model: unknown;
  usage: unknown;
  stopReason: unknown;
  content: AiContentBlock[];
}

/**
 * Price a finished message and decide what it bills. Everything provider-echoed is coerced first:
 * a malformed usage counter or model id must never throw here (the reservation is still open) or
 * put a NaN into the budget rows.
 *
 * A safety-classifier decline is an HTTP 200 with stop_reason 'refusal' and empty (declined
 * before output) or partial (declined mid-output) content — never a usable reply. Per the refusals
 * docs, a pre-output decline is NOT charged although its token counts still appear in `usage`
 * (input reported, output 0), and a mid-output decline bills its input and the output generated.
 * This client books whatever usage a refusal reports either way: a documented pre-output decline
 * therefore books its reported input — an over-read, which can only refuse a later call early,
 * never let spend through unbooked. Only a refusal that reports no tokens at all releases the
 * reservation and writes no usage row.
 */
function finish(
  call: PreparedCall,
  message: ProviderMessage,
): { result: AiCallResult; refused: boolean; billed: Billing | null } {
  const usage = normalizeUsage(message.usage);
  const model = typeof message.model === 'string' && message.model ? message.model : call.model;
  const inferenceGeo = echoedGeo(message.usage);
  const cost = costUsd(model, usage, pricedGeo(call.geo, inferenceGeo));
  const stopReason = typeof message.stopReason === 'string' ? message.stopReason : null;
  const refused = stopReason === 'refusal';
  let text = '';
  for (const block of message.content) if (block.type === 'text') text += block.text;
  MODEL_OUTPUT.add(Object.freeze(message.content));
  return {
    result: {
      text,
      content: message.content,
      model,
      usage,
      costUsd: cost,
      stopReason,
      inferenceGeo,
    },
    refused,
    billed: refused && billedTokens(usage) === 0 ? null : { model, usage, costUsd: cost },
  };
}

/** Whether every tool call in `content` names a tool the request offered. */
function callsOnlyOffered(
  content: readonly AiContentBlock[],
  offered: ReadonlySet<string>,
): boolean {
  return content.every((block) => block.type !== 'tool_use' || offered.has(block.name));
}

function refusedError(model: string): AppError {
  logEvent('ai_call_refused', { model });
  // Opaque on purpose: the message never echoes the request or any partial output.
  return new AppError(422, 'ai_refused', 'The AI model declined this request');
}

// The caller aborted (input.signal). 499 "client closed request": by the time this is thrown the
// caller has stopped listening, so it is for the logs and a caller's own bookkeeping.
function abortedError(): AppError {
  return new AppError(499, 'ai_aborted', 'AI call aborted');
}

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);

export async function callAnthropic(
  env: Env,
  actorEmail: string,
  input: AiCallInput,
  fetcher: Fetcher = defaultFetcher,
): Promise<AiCallResult> {
  const call = await prepareCall(env, actorEmail, input, false);

  // Aborted before the request left: nothing was sent, so nothing was billed — release.
  if (input.signal?.aborted) {
    await settle(env, actorEmail, call, null);
    throw abortedError();
  }

  let response: Response;
  try {
    response = await fetcher(call.url, {
      method: 'POST',
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: input.signal,
    });
  } catch (err) {
    // Aborted AFTER the request left, before the 2xx. The provider generates a non-streaming
    // message whole before it answers, and still charges a request whose client disconnects or
    // times out part-way — so this is billed, and a caller can abort as often as it likes. BOOK
    // the reservation (reservedBilling): releasing it let every abort spend up to the per-call cap
    // with nothing booked, and the daily caps never tripped.
    if (input.signal?.aborted) {
      await settle(env, actorEmail, call, reservedBilling(call));
      throw abortedError();
    }
    // A network failure the caller did not cause: most never reached the provider (DNS, TLS, the
    // gateway down), and a connection the network drops mid-request is not the caller's to
    // repeat. Released (DECISIONS 2026-09-23).
    await settle(env, actorEmail, call, null);
    logEvent('ai_call_network_error', { err });
    throw new AppError(502, 'ai_upstream_error', 'AI provider unreachable');
  }

  if (!response.ok) {
    await settle(env, actorEmail, call, null);
    logEvent('ai_call_failed', {
      status: response.status,
      error_type: await providerErrorType(response),
    });
    throw new AppError(502, 'ai_upstream_error', 'AI call failed');
  }

  // A 2xx can still carry a truncated / non-JSON body (a gateway hiccup), or the caller can abort
  // while it arrives. Either throws AFTER the reservation but BEFORE the success settle below, so
  // settle here, never leaving the reservation open until the UTC-day rollover. But a 2xx means
  // the provider already generated and billed the message: BOOK the reservation (reservedBilling)
  // rather than releasing it as the network and !ok branches do. JSON that is not an object
  // (`null`, a number) is the same failure — it used to escape as a TypeError on `body.usage`,
  // with the reservation still open.
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    await settle(env, actorEmail, call, reservedBilling(call));
    if (input.signal?.aborted) throw abortedError();
    logEvent('ai_call_bad_body', { reason: 'unparseable', err });
    throw new AppError(502, 'ai_upstream_error', 'AI response unparseable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    await settle(env, actorEmail, call, reservedBilling(call));
    logEvent('ai_call_bad_body', { reason: 'not_an_object' });
    throw new AppError(502, 'ai_upstream_error', 'AI response unparseable');
  }
  const body = parsed as Record<string, unknown>;

  const { result, refused, billed } = finish(call, {
    model: body.model,
    usage: body.usage,
    stopReason: body.stop_reason,
    content: normalizeContent(body.content),
  });
  await settle(env, actorEmail, call, billed);
  if (refused) throw refusedError(result.model);
  // A tool call for a tool this request did not offer is never returned as runnable: a caller
  // dispatching by name from a wider registry would run something the model was not given. Billed
  // (settled above) and failed like any unusable body; the log names the rule, never the tool.
  if (!callsOnlyOffered(result.content, call.offeredTools)) {
    logEvent('ai_call_bad_body', { reason: 'unoffered_tool' });
    throw new AppError(502, 'ai_upstream_error', 'AI response unusable');
  }
  return result;
}

/** A failure after the provider answered, as the error event and the AppError that follows it. */
function streamFailure(
  err: unknown,
  signal: AbortSignal | undefined,
): { error: AppError; event: Extract<AiStreamEvent, { type: 'error' }> } {
  if (err instanceof AppError && err.code === 'ai_refused') {
    return { error: err, event: { type: 'error', code: 'ai_refused' } };
  }
  if (signal?.aborted) {
    return { error: abortedError(), event: { type: 'error', code: 'ai_aborted' } };
  }
  const providerErrorType = err instanceof StreamFault ? err.providerErrorType : undefined;
  logEvent(
    'ai_stream_failed',
    err instanceof StreamFault
      ? { fault: err.kind, error_type: providerErrorType }
      : { fault: 'exception', err },
  );
  return {
    error: new AppError(502, 'ai_upstream_error', 'AI stream failed'),
    event: {
      type: 'error',
      code: 'ai_upstream_error',
      ...(providerErrorType ? { providerErrorType } : {}),
    },
  };
}

/**
 * Stream one model call as normalized events (see AiStreamEvent). Same gates, headers, request
 * policy and pricing as callAnthropic; the request adds `stream: true`.
 *
 * Nothing runs until the first `next()`: a stream that is never iterated reserves nothing. A
 * refusal BEFORE the provider answers (policy, configuration, budget, network, a non-2xx status,
 * an abort) is thrown from that first `next()` with no event. After the provider answers, the
 * stream ends with one `message_stop` — or one `error` event followed by the thrown AppError:
 * `ai_refused` (422; discard any text already shown), `ai_upstream_error` (502; a provider `error`
 * event, a malformed or truncated stream), or `ai_aborted` (499; input.signal fired).
 *
 * BUDGET. The reservation is settled exactly once, on every path the generator finishes by, in
 * its `finally` (see ROUTES for the one way to skip it):
 *   - completed: the usage the provider reported (a refusal: the same rule as callAnthropic);
 *   - aborted before the request left, a network error or a non-2xx status: released, as in
 *     callAnthropic;
 *   - aborted after the request left but before the 2xx: booked like any early end below, with
 *     nothing observed — the estimate's input, and max_tokens where output may be hidden. The
 *     provider charges a request whose client disconnects part-way;
 *   - failed or stopped after it answered — abort, a consumer's `break` / `return()`, a provider
 *     error, a truncated stream: the provider has billed the input and whatever it generated, so
 *     the usage observed so far is booked, output floored at the streamed characters per token
 *     (the cumulative count may not have arrived). On a model that thinks without streaming it
 *     (ModelPolicy.hiddenThinking: Opus 5.5, Opus 5, Sonnet 5), or once any thinking block has
 *     appeared, output the stream never showed may run up to max_tokens, so until message_delta
 *     reports the count the whole max_tokens is booked — size `maxTokens` to what a Stop may cost.
 *     Never released: that would under-read spend. Stopping early also cancels the response body,
 *     so the provider stops generating.
 *
 * ROUTES. That settlement lives in this generator's `finally`, which runs only when the generator
 * FINISHES — iterated to the end, or stopped with `break` / `return()` / `throw()`. One that is
 * merely dropped never runs it: the reservation stays booked until the UTC rollover, no usage row
 * is written, and the provider body is never cancelled. A route streaming to a client therefore:
 *   1. passes an AbortSignal it controls (linked to the request's) as `input.signal`. `return()` is
 *      queued behind a pending read, so while the model thinks unseen only an abort stops the
 *      provider promptly;
 *   2. in its ReadableStream's `cancel()`, aborts that signal and then calls `generator.return()`
 *      (`ReadableStream.from(generator)` does the second, never the first);
 *   3. passes that `return()` promise to `ctx.waitUntil`: a client disconnect ends the request, and
 *      work the runtime was not told to wait for can be cancelled before the D1 writes land.
 */
export async function* streamAnthropic(
  env: Env,
  actorEmail: string,
  input: AiCallInput,
  fetcher: Fetcher = defaultFetcher,
): AsyncGenerator<AiStreamEvent, void, undefined> {
  const call = await prepareCall(env, actorEmail, input, true);
  const stream = new MessageStream({
    hiddenThinking: call.policy.hiddenThinking,
    offeredTools: call.offeredTools,
  });
  // The provider returned 2xx: failures from here on bill observed usage. (An abort between
  // dispatch and the 2xx books observed usage too; it settles where it is caught.)
  let answered = false;
  let settled = false;
  const settleOnce = async (billed: Billing | null): Promise<void> => {
    if (settled) return;
    settled = true;
    await settle(env, actorEmail, call, billed);
  };
  const observed = (): Billing => {
    const usage = stream.observedUsage(call.estimate);
    const model = stream.model ?? call.model;
    const geo = pricedGeo(call.geo, echoedGeo(stream.reportedUsage()));
    return { model, usage, costUsd: costUsd(model, usage, geo) };
  };

  try {
    // Aborted before the request left: released in the `finally` (nothing was sent).
    if (input.signal?.aborted) throw abortedError();
    let response: Response;
    try {
      response = await fetcher(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.body),
        signal: input.signal,
      });
    } catch (err) {
      // Aborted after the request left, before the 2xx: billed, as in callAnthropic. No event has
      // been yielded, so this books the estimate's input, and max_tokens where output may be
      // hidden (observed() with nothing observed).
      if (input.signal?.aborted) {
        await settleOnce(observed());
        throw abortedError();
      }
      logEvent('ai_call_network_error', { err });
      throw new AppError(502, 'ai_upstream_error', 'AI provider unreachable');
    }
    if (!response.ok) {
      logEvent('ai_call_failed', {
        status: response.status,
        error_type: await providerErrorType(response),
      });
      throw new AppError(502, 'ai_upstream_error', 'AI call failed');
    }
    answered = true;
    try {
      if (!response.body) throw new StreamFault('incomplete');
      for await (const sse of parseSse(response.body)) {
        for (const event of stream.consume(sse)) yield event;
        if (stream.stopped) break;
      }
      if (!stream.stopped) throw new StreamFault('incomplete');
      const message = stream.finalMessage();
      const { result, refused, billed } = finish(call, {
        model: message.model,
        usage: message.usage,
        stopReason: message.stopReason,
        content: message.content,
      });
      // Settle BEFORE the last event: a consumer may stop iterating the moment it has it.
      await settleOnce(billed);
      if (refused) throw refusedError(result.model);
      yield { type: 'message_stop', result };
    } catch (err) {
      const failure = streamFailure(err, input.signal);
      // Book what was billed before announcing the failure, for the same reason.
      await settleOnce(observed());
      yield failure.event;
      throw failure.error;
    }
  } finally {
    // Reached unsettled only on a pre-answer failure (release) or when the consumer stopped
    // iterating mid-stream (`return()` skips the catch above; bill what was observed). A ledger
    // failure here must not mask the error already in flight, so it is logged, not thrown.
    if (!settled) {
      try {
        await settleOnce(answered ? observed() : null);
      } catch (err) {
        logEvent('ai_budget_settle_failed', { err });
      }
    }
  }
}
