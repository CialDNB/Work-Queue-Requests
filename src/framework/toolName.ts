// TOOL NAMES, derived from a route's method + path. One derivation for every tool surface the kit
// generates from the route registry — the MCP adapter (src/mcp/tools.ts), the in-app agent's tool
// set (src/framework/agentTools.ts) and the definition-time guard on `agent:` exposure
// (src/framework/agentExposure.ts) — so a route has exactly one tool name wherever it appears, and
// the name the guard checked is the name the model is offered.
//
// A LEAF MODULE on purpose: defineRoute's guard needs the name at module load, and the tool
// builder needs executeRoute, so the name lives where both can import it without either importing
// the other.

/**
 * The longest tool name a model provider accepts. Anthropic's Messages API refuses a tool whose
 * name does not match `^[a-zA-Z0-9_-]{1,64}$`, and one refused tool fails the WHOLE request — so
 * an over-long name is a definition-time error for an exposed route, never a runtime surprise.
 */
export const TOOL_NAME_MAX_LENGTH = 64;

/** The charset and length every generated tool name must satisfy (the provider's own rule). */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A route path's `:param` names, in order. Hono names a param with everything up to `/`, `{` or
 * `?`; the kit's paths use word characters, so `:ticket_key` and `:v2id` are whole names (an older
 * letters-only rule cut `:ticket_key` to `ticket`). A `{regex}` suffix is not part of the name.
 * One rule for the guard that checks an exposed route's input and the builder that fills the path
 * from a tool's args, so the name checked is the name filled.
 */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

/**
 * Deterministic, collision-checked tool name from method + path:
 *   GET  /api/notes            -> get_notes
 *   GET  /api/notes/:id        -> get_notes_by_id
 *   POST /api/users/:email/revoke-sessions -> post_users_by_email_revoke_sessions
 * A `:param` becomes `by_<param>`; any non-word char collapses to `_`.
 */
export function toolName(method: string, path: string): string {
  const segs = path
    .replace(/^\/api\//, '')
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') ? `by_${s.slice(1)}` : s))
    .join('_')
    .replace(/[^a-zA-Z0-9_]/g, '_');
  return `${method.toLowerCase()}_${segs}`;
}
