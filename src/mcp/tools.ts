// MCP TOOLS GENERATED FROM ROUTE SPECS. Each tool is the same defineRoute() the HTTP surface
// serves, invoked through the SAME executeRoute pipeline — identical permission check, input
// validation, handler, and audit-on-write. An agent is therefore a first-class, GOVERNED client
// of the paved road, not a parallel unpaved one: there is no second authorization path to drift.
//
// This module is transport-pure. It takes an already-resolved LIVE Principal — the stateless
// shell re-resolves it from each request's own Authorization header (see templates/mcp-agent/;
// under the 2026-07-28 stateless spec every tool call is its own authenticated request) — and
// returns MCP content. Wiring a live /mcp handler is opt-in (the template), so no app carries
// the agents SDK unless it wants MCP.
//
// Uniformity, MCP-shaped: the tool LIST is filtered to what the caller may invoke
// (toolsForPrincipal) — the enumeration analog of 404-uniformity, so a forbidden tool isn't even
// visible — and every invoke re-checks permission at call time, rendering a denial as one generic
// message indistinguishable from any other refusal. "May invoke" is the caller's EFFECTIVE
// permissions, not its role: an MCP caller is a bearer token, so the list is its role ∩ its
// scopes, minus the non-delegable set (PIA C8) — the same principalCan executeRoute enforces.
//
// What this file adds is only the MCP SHAPE. The pieces every generated tool shares — the name,
// the generic denial, path params, response unwrap, and the drained executeRoute call — live in
// src/framework/agentTools.ts, the transport-free core the in-app agent's tools use too, so the
// two surfaces cannot drift apart.
import type { z } from 'zod';
import { callableBy, type PermissionKey } from '../auth/permissions';
import type { Principal } from '../auth/types';
import type { Env } from '../env';
import {
  agentInvocation,
  callRoute,
  GENERIC_DENIAL,
  type ToolInvocation,
  toolName,
} from '../framework/agentTools';
import type { RouteDef, RouteSpec } from '../framework/defineRoute';
import { toInputJsonSchema } from '../framework/jsonSchema';
import { logEvent } from '../platform/logEvent';

// The naming scheme is shared with the in-app agent's tools (src/framework/toolName.ts); re-exported
// so existing importers of `toolName` from this module keep working.
export { toolName };

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * The turn an IN-PROCESS agent loop is running when it calls an MCP-shaped tool. Not for the MCP
 * transport: a /mcp request is an MCP call and passes nothing.
 */
export interface McpAgentTurn {
  /** The loop's turn id — an identifier (src/framework/invocation.ts TURN_ID_PATTERN). */
  readonly turnId: string;
}

export interface McpTool {
  name: string;
  description: string;
  permission: PermissionKey | 'authenticated';
  /** The route is machine-only (RouteSpec.machine): listed for a service holding the key, never for a person. */
  machine: boolean;
  /** JSON Schema (input view) of the tool's arguments. */
  inputSchema: unknown;
  /**
   * Run the tool as `principal` (which the caller must re-resolve live per call).
   *
   * `turn` is for an IN-PROCESS AGENT LOOP that still builds its tools here rather than with
   * buildAgentTools (Insights' chat, until it moves): with it, the call is attributed to the agent
   * — `{ via: 'agent', turnId }`, so its audit rows carry `_via: 'agent'` and `_turn` and its read
   * ledger the turn id — instead of being filed as MCP traffic. A malformed turn id throws
   * InvalidInvocationError before anything runs (a loop bug). Attribution ONLY: such a loop gets
   * none of the agent controls — default deny, AGENT_FORBIDDEN, approval, PIA C3 and C16 live in
   * buildAgentTools (src/framework/agentTools.ts), which is where an agent's tools belong.
   */
  invoke(
    env: Env,
    principal: Principal,
    args: unknown,
    turn?: McpAgentTurn,
  ): Promise<McpToolResult>;
}

function makeTool(spec: RouteSpec<z.ZodTypeAny>): McpTool {
  return {
    name: toolName(spec.method, spec.path),
    description: spec.summary ?? `${spec.method} ${spec.path}`,
    permission: spec.permission,
    machine: spec.machine === true,
    inputSchema: toInputJsonSchema(spec.input),
    invoke: async (env, principal, args, turn) => {
      // The channel, checked before anything runs: MCP, or an in-process agent loop's turn.
      const invocation: ToolInvocation =
        turn === undefined ? { via: 'mcp' } : agentInvocation(turn.turnId);
      // The shared pipeline call (src/framework/agentTools.ts): executeRoute, the unwrapped
      // payload, and every ctx.waitUntil promise DRAINED before this returns — including a SERVICE
      // principal's authz.denied throttle check + row, so over MCP its denied call to an existing
      // tool is one KV (+ at most one D1) round trip slower than an unknown tool name — accepted;
      // see recordServiceDenial in src/framework/execute.ts.
      // The invocation stamps `_via` (and `_turn`) on every audit row the call writes
      // (src/framework/invocation.ts).
      const outcome = await callRoute(env, spec, principal, args, invocation);
      if (outcome.kind === 'ok') {
        try {
          return { content: [{ type: 'text', text: JSON.stringify(outcome.data ?? null) }] };
        } catch (err) {
          // A result JSON cannot carry (a BigInt, a cycle) is an internal failure like any other:
          // its category is logged on the call's channel, the caller gets the opaque error — the
          // handler already ran, so this must resolve, never reject.
          const event = invocation.via === 'agent' ? 'agent_tool_error' : 'mcp_tool_error';
          logEvent(event, { method: spec.method, path: spec.path, err });
          return { content: [{ type: 'text', text: 'Internal error.' }], isError: true };
        }
      }
      if (outcome.kind === 'refused') {
        // A permission denial (notFound) reads as the generic refusal — indistinguishable from a
        // tool that doesn't exist. Other AppErrors (validation, rate limit) reach only a permitted
        // caller, so their message is safe to surface.
        const err = outcome.error;
        const text = err.code === 'not_found' ? GENERIC_DENIAL : err.message;
        return { content: [{ type: 'text', text }], isError: true };
      }
      // Opaque failure — callRoute logged its category (`mcp_tool_error`, or `agent_tool_error`
      // for an in-process turn); nothing to the caller.
      return { content: [{ type: 'text', text: 'Internal error.' }], isError: true };
    },
  };
}

/**
 * Build one governed MCP tool per registered route. Throws on a tool-name collision (a
 * definition-time guard, like defineRoute): two routes must never map to the same tool.
 */
export function buildMcpTools(routes: readonly RouteDef[]): McpTool[] {
  const tools: McpTool[] = [];
  const seen = new Set<string>();
  for (const { spec } of routes) {
    const tool = makeTool(spec);
    if (seen.has(tool.name)) {
      throw new Error(
        `MCP tool name collision: ${tool.name} (from ${spec.method} ${spec.path}). Rename the route or the naming scheme.`,
      );
    }
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools;
}

/**
 * The tools THIS caller may call. Filter the list per REQUEST (under the stateless 2026-07-28
 * spec there is no session to filter at — each tools/list re-authenticates) so an agent only ever
 * sees usable tools: the enumeration analog of 404-uniformity. It filters on the principal, not
 * the role, because a bearer caller holds less than its role (principalCan: scopes and the
 * non-delegable set) and a list that offered `post_tokens` to a token would advertise a tool
 * every call to which 404s. The same check executeRoute makes (principalMayCall), so a SERVICE
 * principal sees exactly the tools behind its one scope and none of the 'authenticated' ones, and
 * a PERSON never sees a machine-only tool (RouteSpec.machine).
 *
 * A machine tool called over MCP carries no `X-Sync-Run` (the adapter's request is synthetic), so
 * it is refused with a 400-class message unless the app runs MACHINE_SYNC_RUN=warn. Machine routes
 * are for integrations posting over HTTP; this adapter is not their transport.
 * Per-IDENTITY list variance is explicitly conformant ("the set MAY vary
 * by the authorization presented on the request"); a filtered list response is cacheScope
 * 'private', NEVER 'public' — a shared cache must not serve one caller's tool list to another.
 * executeRoute still re-checks on every invoke, so this is UX + defense-in-depth, not the
 * security boundary. It is `callableBy` (src/auth/permissions.ts) — the one offer filter every
 * tool list shares — so a person whose permissions come from an authority hook (an ACL grant) is
 * offered what that grant allows, never what the bookkeeping role would.
 *
 * Replaces the role-keyed `toolsForRole(tools, role)`, removed rather than kept as an alias: an
 * alias would keep offering a token every tool its role allows.
 */
export function toolsForPrincipal(tools: readonly McpTool[], principal: Principal): McpTool[] {
  return callableBy(principal, tools);
}
