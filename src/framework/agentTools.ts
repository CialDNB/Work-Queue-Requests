// THE TRANSPORT-FREE TOOL CORE. Every tool the kit generates from its route registry — an MCP tool
// (src/mcp/tools.ts) or an in-app agent tool — is a defineRoute() invoked through the SAME
// executeRoute pipeline as the HTTP surface: identical permission check, rate limit, input
// validation, handler, audit-on-write and read ledger. This module holds the pieces every such
// tool shares, so there is one copy of each and no adapter can drift from another:
//
//   - the tool NAME (src/framework/toolName.ts, re-exported here);
//   - the generic DENIAL: one message for every refusal, so a denied tool reads exactly like one
//     that does not exist (the tool-shaped form of 404-uniformity — no oracle);
//   - PATH PARAMS from tool arguments, for the audit-target default the HTTP adapter gets from
//     the URL;
//   - RESPONSE UNWRAP: a handler may return a Response (ok(data, 201), a 204 delete); a tool
//     returns its payload;
//   - callRoute(): executeRoute with a synthetic request, background work collected and DRAINED
//     before the call returns (there is no executionCtx outside HTTP to keep it alive), and an
//     unexpected failure reduced to its category in the logs and to nothing for the caller.
//
// Transport-free: it takes an already-resolved LIVE principal and returns a plain outcome. Each
// adapter renders that outcome in its own shape. Nothing here reads a request, a header or a
// session — resolving the principal (and re-resolving it per call) is the adapter's job.
import type { z } from 'zod';
import { type PermissionKey, principalMayCall } from '../auth/permissions';
import type { Principal } from '../auth/types';
import type { Env } from '../env';
import { logEvent } from '../platform/logEvent';
import {
  type AgentApprovalSummary,
  type AgentEffect,
  type AgentExposure,
  approvalRequired,
  approvalSummaryFor,
  assertPrivateSourcesRuled,
  checkedAgentExposure,
  isAgentExposed,
  type PrivateSourceTable,
} from './agentExposure';
import type { RouteDef, RouteSpec } from './defineRoute';
import { AppError } from './errors';
import { executeRoute } from './execute';
import { checkedInvocation } from './invocation';
import { toInputJsonSchema } from './jsonSchema';
import { pathParamNames, toolName } from './toolName';

export { TOOL_NAME_MAX_LENGTH, TOOL_NAME_PATTERN, toolName } from './toolName';

/** One generic message for every refusal, so a denied tool reads the same as one that isn't there. */
export const GENERIC_DENIAL = 'This action is not available.';

/**
 * The subset of args that fill the route's path params — used only for the audit-target default,
 * exactly as the HTTP adapter passes c.req.param().
 */
export function pathParams(path: string, args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of pathParamNames(path)) {
    const v = args[name];
    if (typeof v === 'string') out[name] = v;
    else if (typeof v === 'number') out[name] = String(v);
  }
  return out;
}

/**
 * Unwrap a handler-returned Response to its payload. A 204 / empty body is a successful
 * no-content result (null); a JSON envelope yields its `data`. Never throws — a body that isn't
 * the expected envelope degrades to null rather than crashing the tool call.
 */
export async function unwrapResponse(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return (JSON.parse(text) as { data?: unknown }).data ?? null;
  } catch {
    return null;
  }
}

/** Tool arguments as the raw input object: anything that is not a plain object is no arguments. */
export function argObject(args: unknown): Record<string, unknown> {
  return (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<
    string,
    unknown
  >;
}

/**
 * Which tool surface is calling — the tool channels of an Invocation. Chooses the synthetic origin
 * and the log event names; the invocation itself travels to executeRoute, which stamps it on the
 * call's audit rows and read ledger.
 */
export type ToolChannel = 'mcp' | 'agent';

/** The invocation a tool surface hands executeRoute: MCP, or an agent call inside a turn. */
export type ToolInvocation =
  | { readonly via: 'mcp' }
  | { readonly via: 'agent'; readonly turnId: string };

/**
 * The invocation of an agent call in turn `turnId`, checked: throws InvalidInvocationError on a
 * malformed turn id (a loop bug), before anything runs. Used by both surfaces an agent loop can
 * call through — this module's tools and an in-process loop still on MCP-shaped tools.
 */
export function agentInvocation(turnId: unknown): ToolInvocation {
  const checked = checkedInvocation({ via: 'agent', turnId });
  return Object.freeze({ via: 'agent', turnId: checked.turnId as string });
}

const CHANNELS = {
  mcp: {
    origin: 'https://mcp.local',
    toolError: 'mcp_tool_error',
    drainCapped: 'mcp_waituntil_drain_capped',
  },
  agent: {
    origin: 'https://agent.local',
    toolError: 'agent_tool_error',
    drainCapped: 'agent_waituntil_drain_capped',
  },
} as const;

/**
 * What one tool call through the route pipeline came to:
 *   ok        the handler ran and returned. `data` is its payload (a Response already unwrapped),
 *             `status` the Response's status when it returned one (null for a plain value) — a
 *             handler may return fail(4xx) instead of throwing, and only the adapter knows how its
 *             transport reports that.
 *   refused   executeRoute (or the handler) threw an AppError: a permission denial (`not_found`),
 *             a validation failure, a rate limit, a conflict. Only a permitted caller ever gets
 *             past the denial, so any non-denial message is safe for that caller to see.
 *   internal  anything else. Logged as its category, never its message; the caller learns nothing.
 */
export type RouteCallOutcome =
  | { readonly kind: 'ok'; readonly data: unknown; readonly status: number | null }
  | { readonly kind: 'refused'; readonly error: AppError }
  | { readonly kind: 'internal' };

/**
 * Run `spec` as `principal` with tool arguments `args`, through executeRoute. The principal must be
 * the LIVE one, re-resolved by the adapter for this call.
 *
 * Background work scheduled via ctx.waitUntil (the declared-audit failure alert, the read-ledger
 * flush, a service principal's authz.denied row) is collected and awaited before this returns:
 * outside an HTTP executionCtx there is nothing to keep those promises alive, so a fire-and-forget
 * here would silently drop them. The drain is bounded — see below.
 */
export async function callRoute(
  env: Env,
  spec: RouteSpec<z.ZodTypeAny>,
  principal: Principal,
  args: unknown,
  invocation: ToolInvocation,
  ip = '',
): Promise<RouteCallOutcome> {
  const ch = CHANNELS[invocation.via];
  const argObj = argObject(args);
  const pending: Promise<unknown>[] = [];
  try {
    const result = await executeRoute(env, spec, principal, {
      // The originating request's address when the adapter has one (an agent turn's), else '' —
      // what every audit row this call writes records in `ip`.
      ip,
      params: pathParams(spec.path, argObj),
      // Synthetic — no handler reads ctx.request; present only to satisfy the ctx shape.
      request: new Request(`${ch.origin}${spec.path}`),
      waitUntil: (p) => {
        pending.push(p);
      },
      buildRawInput: () => argObj,
      invocation,
    });
    // Handlers may return a Response for a custom status: ok(data, 201) carries a JSON envelope; a
    // delete returns 204 with no body. Unwrap to the payload — a 204/empty body is a successful
    // no-content result (null), NOT an error. The HTTP adapter passes 204 through untouched, so a
    // tool must treat it as success too (calling .json() on an empty body would throw and misreport
    // an already-committed, already-audited mutation).
    if (result instanceof Response) {
      return { kind: 'ok', data: await unwrapResponse(result), status: result.status };
    }
    return { kind: 'ok', data: result, status: null };
  } catch (err) {
    if (err instanceof AppError) return { kind: 'refused', error: err };
    // Opaque failure — the error's CATEGORY goes to observability (never its message, which can
    // quote tool arguments or row content; src/platform/logEvent.ts), nothing to the caller.
    logEvent(ch.toolError, { method: spec.method, path: spec.path, err });
    return { kind: 'internal' };
  } finally {
    await drainPending(env, pending, () =>
      logEvent(ch.drainCapped, { method: spec.method, path: spec.path }),
    );
  }
}

/**
 * Bounded drain: loops so work scheduled BY background work is drained too, and a hard cap keeps
 * a slow or never-settling handler promise from hanging the tool call (HTTP's runtime bounds
 * waitUntil; this mirrors that). Default 10s clears the alert seam's 5s webhook bound with
 * headroom; MCP_WAITUNTIL_CAP_MS overrides (primarily a test knob) for every tool channel.
 */
async function drainPending(
  env: Env,
  pending: Promise<unknown>[],
  onCapped: () => void,
): Promise<void> {
  const capMs = Number(env.MCP_WAITUNTIL_CAP_MS) > 0 ? Number(env.MCP_WAITUNTIL_CAP_MS) : 10_000;
  const deadline = Date.now() + capMs;
  let drained = 0;
  let capped = false;
  while (drained < pending.length && !capped) {
    const batch = pending.slice(drained);
    drained = pending.length;
    const remaining = deadline - Date.now();
    const winner =
      remaining > 0
        ? await Promise.race([
            Promise.allSettled(batch).then(() => 'settled' as const),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
          ])
        : 'timeout';
    if (winner === 'timeout') capped = true;
  }
  if (capped) onCapped();
}

// ---------------------------------------------------------------------------------------------
// The in-app agent's tool set
// ---------------------------------------------------------------------------------------------

/**
 * Why an agent tool call did not produce data. The model sees `code` and `message`, never more:
 *   unavailable        a permission denial, an unknown tool name, a non-person caller, or a handler's
 *                      own 404 — ALL the same GENERIC_DENIAL text, so the model cannot tell "not
 *                      allowed" from "not there" (404-uniformity, tool-shaped) and cannot narrate the
 *                      difference to the user.
 *   approval_required  the call needs a person's yes first; `approval` is the card to show (an i18n
 *                      key + params, never model text). Nothing ran.
 *   invalid_input      the arguments failed the route's schema (reaches a permitted caller only).
 *   rate_limited       the route's per-principal ceiling.
 *   failed             any other refusal the route raised (a conflict, a handler-returned 4xx).
 *   internal           an unexpected failure; its category is logged (`agent_tool_error`), the
 *                      model learns nothing.
 */
export type AgentToolResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly code: 'unavailable' | 'invalid_input' | 'rate_limited' | 'failed' | 'internal';
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: 'approval_required';
      readonly message: string;
      readonly approval: AgentApprovalSummary;
    };

/** Per-call context the agent loop supplies. */
export interface AgentToolCall {
  /**
   * The turn this call belongs to — an identifier (src/framework/invocation.ts TURN_ID_PATTERN).
   * Stamped as `_turn` on the call's audit rows and used as the read ledger's request_id.
   */
  readonly turnId: string;
  /**
   * Has a person approved THIS call (these arguments)? Only an exact `true` counts. The loop binds
   * an approval to the arguments it was shown for (P2: args_sha256); the kit enforces that a call
   * whose route requires approval does not run without one.
   */
  readonly approved?: boolean;
  /**
   * The address of the person's request that started this turn (its `CF-Connecting-IP`), recorded
   * in `audit_log.ip` on the call's rows exactly as the same person's HTTP rows record it — so the
   * channel a prompt injection can drive is not the least-attributed one. Only an IP-shaped value
   * is kept (callerIp); anything else, or nothing, records '' as before.
   */
  readonly ip?: string;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;

/** `ip` when it is an IPv4 or IPv6 address in text form, else '' — never content in the column. */
export function callerIp(ip: unknown): string {
  if (typeof ip !== 'string') return '';
  return IPV4.test(ip) || (ip.includes(':') && IPV6.test(ip)) ? ip : '';
}

/** One route, as the in-app agent sees it. Built by buildAgentTools; invoked only via executeRoute. */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly permission: PermissionKey;
  readonly effect: AgentEffect;
  /** JSON Schema (input view) of the tool's arguments. */
  readonly inputSchema: unknown;
  readonly egress: readonly string[];
  readonly egressRuling: string | null;
  readonly render: string | null;
  /**
   * Run the tool as `principal` — the LIVE principal, re-resolved by the loop for THIS call.
   * Never throws for anything the caller or the model did; throws InvalidInvocationError on a
   * malformed `turnId`, which is a loop bug, not input.
   */
  invoke(
    env: Env,
    principal: Principal,
    args: unknown,
    call: AgentToolCall,
  ): Promise<AgentToolResult>;
}

const UNAVAILABLE: AgentToolResult = Object.freeze({
  ok: false,
  code: 'unavailable',
  message: GENERIC_DENIAL,
});
const INTERNAL: AgentToolResult = Object.freeze({
  ok: false,
  code: 'internal',
  message: 'Internal error.',
});
const FAILED_MESSAGE = 'This action could not be completed.';
const APPROVAL_MESSAGE = 'This action needs the user to approve it first.';

/**
 * May `principal` be offered, or run, a tool gated by `permission`? A PERSON who may call the
 * route — principalMayCall, the same check executeRoute makes, so a bearer person holds only its
 * token's scopes. Never a service principal: the in-app agent acts for a signed-in person, and a
 * machine has no one for it to act for (a service holds one scope for its integration, not a chat).
 */
function agentMayUse(principal: Principal, permission: PermissionKey): boolean {
  return principal.kind === 'person' && principalMayCall(principal, permission);
}

function refusal(err: AppError): AgentToolResult {
  switch (err.code) {
    case 'not_found':
    case 'unauthorized':
      return UNAVAILABLE;
    case 'validation_failed':
      return { ok: false, code: 'invalid_input', message: err.message };
    case 'rate_limited':
      return { ok: false, code: 'rate_limited', message: err.message };
    default:
      return { ok: false, code: 'failed', message: err.message };
  }
}

function makeAgentTool(spec: RouteSpec<z.ZodTypeAny>, agent: Readonly<AgentExposure>): AgentTool {
  const name = toolName(spec.method, spec.path);
  // checkedAgentExposure refused 'authenticated', so the permission is a real key here.
  const permission = spec.permission as PermissionKey;
  return Object.freeze({
    name,
    description: agent.description ?? spec.summary ?? `${spec.method} ${spec.path}`,
    permission,
    effect: agent.effect,
    inputSchema: toInputJsonSchema(spec.input),
    egress: agent.egress ?? Object.freeze([]),
    egressRuling: agent.egressRuling ?? null,
    render: agent.render ?? null,
    invoke: async (
      env: Env,
      principal: Principal,
      args: unknown,
      call: AgentToolCall,
    ): Promise<AgentToolResult> => {
      // 0. The invocation first — a malformed turn id is a loop bug and nothing runs.
      const invocation = agentInvocation(call.turnId);
      // 1. The live principal may still call this route (re-resolved per call by the loop), BEFORE
      //    anything about the arguments is looked at — so approval can never become an oracle for
      //    a tool the caller may not use. executeRoute re-checks; this is the order guarantee.
      if (!agentMayUse(principal, permission)) return UNAVAILABLE;
      // 2. Approval, on the VALIDATED input. Invalid arguments skip this step: executeRoute rejects
      //    them before the handler, so nothing runs that could need approving. A schema whose
      //    transform or refine THROWS on the model's input (z.string().transform(JSON.parse)) is
      //    the model's doing, so it ends as `internal` — logged as its category, as callRoute
      //    would — never as a rejection whose message quotes the argument.
      let approval: AgentApprovalSummary | null = null;
      try {
        const parsed = spec.input.safeParse(argObject(args));
        if (parsed.success && approvalRequired(agent, parsed.data) && call.approved !== true) {
          approval = approvalSummaryFor(agent, parsed.data, name);
        }
      } catch (err) {
        logEvent(CHANNELS.agent.toolError, { method: spec.method, path: spec.path, err });
        return INTERNAL;
      }
      if (approval) {
        return { ok: false, code: 'approval_required', message: APPROVAL_MESSAGE, approval };
      }
      // 3. The one pipeline.
      const outcome = await callRoute(env, spec, principal, args, invocation, callerIp(call.ip));
      if (outcome.kind === 'refused') return refusal(outcome.error);
      if (outcome.kind === 'internal') return INTERNAL;
      // A handler that RETURNED an error Response rather than throwing: a 404 is a denial like any
      // other (uniformity); any other 4xx failed; a 5xx is internal. Its body is not surfaced.
      if (outcome.status !== null && outcome.status >= 400) {
        if (outcome.status === 404) return UNAVAILABLE;
        if (outcome.status >= 500) return INTERNAL;
        return { ok: false, code: 'failed', message: FAILED_MESSAGE };
      }
      return { ok: true, data: outcome.data };
    },
  });
}

/**
 * THE AGENT'S TOOL SET for `principal`: one tool per route that DECLARES an `agent:` block (default
 * deny — every other route is absent, whatever the caller may do over HTTP) and that this principal
 * may call right now (a person; principalMayCall). Build it per turn from the live principal;
 * every invoke re-checks against the principal the loop re-resolves for that call, and executeRoute
 * checks again.
 *
 * Each block is re-checked here (checkedAgentExposure) as well as in defineRoute, so a RouteDef
 * assembled by hand rather than by defineRoute cannot slip an unchecked exposure in: it throws, the
 * same as a module that failed to load. So does an exposed route without an egressRuling in an app
 * that binds a client-class private database (assertPrivateSourcesRuled — `privateSources` defaults
 * to AURORA_SOURCES and is a parameter only so tests can drive another table). Tool names are collision-checked across every EXPOSED
 * route, independent of who is asking, so the set never depends on a collision a caller happens not
 * to see.
 */
export function buildAgentTools(
  routes: readonly RouteDef[],
  principal: Principal,
  privateSources?: PrivateSourceTable,
): AgentTool[] {
  const exposed: { spec: RouteSpec<z.ZodTypeAny>; agent: Readonly<AgentExposure> }[] = [];
  const seen = new Set<string>();
  for (const { spec } of routes) {
    if (!isAgentExposed(spec)) continue;
    const agent = checkedAgentExposure(spec);
    const name = toolName(spec.method, spec.path);
    if (seen.has(name)) {
      throw new Error(
        `Agent tool name collision: ${name} (from ${spec.method} ${spec.path}). Rename the route.`,
      );
    }
    seen.add(name);
    exposed.push({ spec, agent });
  }
  // PIA C3, the app's half: an app that binds a client-class private database carries a ruling on
  // every exposed route, or no tool is built at all.
  assertPrivateSourcesRuled(
    exposed.map(({ spec }) => spec),
    privateSources,
  );
  return exposed
    .filter(({ spec }) => agentMayUse(principal, spec.permission as PermissionKey))
    .map(({ spec, agent }) => makeAgentTool(spec, agent));
}

/**
 * Run the tool named `name` from `tools`. A name that is not in the set — never offered to this
 * principal, or not a tool at all — returns the SAME result as a denied call, so a model that
 * guesses names learns nothing about the app it cannot already reach.
 */
export async function callAgentTool(
  env: Env,
  principal: Principal,
  tools: readonly AgentTool[],
  name: string,
  args: unknown,
  call: AgentToolCall,
): Promise<AgentToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    // Validate the turn anyway, so a loop bug surfaces the same way whether or not the name exists.
    agentInvocation(call.turnId);
    return UNAVAILABLE;
  }
  return tool.invoke(env, principal, args, call);
}
