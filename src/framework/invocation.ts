// INVOCATION ATTRIBUTION — which surface called a route, and (for the in-app agent) which turn.
//
// executeRoute is one pipeline behind three adapters: the HTTP adapter (defineRoute.ts), the MCP
// adapter (src/mcp/tools.ts) and the in-app agent's tools (src/framework/agentTools.ts). Each
// adapter states its channel on every call — `invocation` is a REQUIRED option, so an adapter
// written tomorrow cannot forget it and be filed under someone else's channel — and the pipeline
// stamps it where the record of the call lives:
//
//   audit_log.payload_json  reserved keys `_via` ('mcp' | 'agent') and `_turn` (agent only) on
//                           every audit row the call writes: the declared row, ctx.audit() extras
//                           and a service principal's authz.denied row. An HTTP row carries
//                           neither, so its payload_json is byte-identical to before.
//   read_log.request_id     the TURN id for an agent call, so every read one agent turn makes
//                           correlates under one id; a fresh uuid per call otherwise, as before.
//                           executeRoute hands the same id to the handler as ctx.requestId: the D1
//                           recorder uses it, and a handler passes it as AuroraCtx.requestId, so the
//                           call's Aurora rows carry it too.
//
// CONTENT-FREE BY CONSTRUCTION. The channel is one of three literals and the turn id must match
// TURN_ID_PATTERN — an identifier with no room for a sentence, an address or a URL — or the call
// is refused before anything runs (PIA §2: agent metadata is "identifiers only").
//
// ATTRIBUTION, NEVER AUTHORIZATION. The channel says how a call arrived; it grants nothing. Code
// that branches authority on `via` repeats the `authMethod` mistake CLAUDE.md forbids: permissions
// come from the principal (principalCan), on every channel alike.

/** The surfaces that call executeRoute. Set only by the adapters, never from request data. */
export type InvocationChannel = 'http' | 'mcp' | 'agent';

/**
 * How this call reached executeRoute. `turnId` is REQUIRED for 'agent' and FORBIDDEN otherwise:
 * only an agent call belongs to a turn, and an id on any other channel would be a correlation
 * nobody can explain.
 */
export type Invocation =
  | { readonly via: 'http' | 'mcp'; readonly turnId?: undefined }
  | { readonly via: 'agent'; readonly turnId: string };

/**
 * A turn id: an identifier, never content. 1–64 of `[A-Za-z0-9_-]` (a uuid fits). No dots, colons,
 * `@`, slashes or whitespace, so no email, URL or sentence fits either.
 */
export const TURN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Audit payload keys starting with this prefix are RESERVED for the framework. A route-supplied
 * key that starts with it is STRIPPED (see auditPayloadJson) — on every channel, HTTP included, so
 * the rows the FRAMEWORK writes for a call (the declared row, ctx.audit() extras, authz.denied)
 * cannot carry a forged `_via: 'agent'` or another turn. What this does not reach: a handler that
 * inserts into audit_log itself through `ctx.db.audit` (a route with no `needs`, or `audit` in
 * them) writes whatever it likes. An EXPOSED route cannot through ctx.db — it must declare
 * `needs`, and AGENT_FORBIDDEN_REPOSITORIES refuses `audit` there — and a route module may not
 * build its own handle with makeDb() (semgrep `data-handle-in-routes`).
 */
export const RESERVED_AUDIT_KEY_PREFIX = '_';

/** Thrown when an adapter hands executeRoute an invocation it cannot vouch for. A bug, not input. */
export class InvalidInvocationError extends Error {
  constructor() {
    // A fixed message: whatever the adapter passed is never echoed (it could be anything).
    super('executeRoute: malformed invocation');
    this.name = 'InvalidInvocationError';
  }
}

/**
 * Validate an adapter's invocation. Throws InvalidInvocationError on anything but an exact channel
 * with a well-formed turn id where one belongs — fail closed: a call that cannot be attributed
 * does not run. Returns a fresh frozen copy, so nothing the adapter holds can change it mid-call.
 */
export function checkedInvocation(invocation: unknown): Invocation {
  if (invocation === null || typeof invocation !== 'object') throw new InvalidInvocationError();
  const { via, turnId } = invocation as { via?: unknown; turnId?: unknown };
  if (via === 'http' || via === 'mcp') {
    if (turnId !== undefined) throw new InvalidInvocationError();
    return Object.freeze({ via });
  }
  if (via === 'agent') {
    if (typeof turnId !== 'string' || !TURN_ID_PATTERN.test(turnId)) {
      throw new InvalidInvocationError();
    }
    return Object.freeze({ via, turnId });
  }
  throw new InvalidInvocationError();
}

/** The framework's own attribution keys for a call on `invocation` (none for HTTP). */
function attributionKeys(invocation: Invocation): Record<string, string> {
  if (invocation.via === 'agent') return { _via: 'agent', _turn: invocation.turnId };
  if (invocation.via === 'mcp') return { _via: 'mcp' };
  return {};
}

/**
 * The payload_json for one audit row written during a call on `invocation`, and how many
 * route-supplied reserved keys were stripped from it (the caller logs a non-zero count).
 *
 *   - HTTP, nothing reserved in the payload: exactly `JSON.stringify(payload)`, or null for no
 *     payload — byte-identical to the pre-attribution framework.
 *   - Any route-supplied key starting with `_`: dropped, on every channel. STRIPPED rather than
 *     rejected on purpose: by the time the declared row is written the mutation has committed, so
 *     refusing the row would trade a forged key for an audit GAP — and a complete audit trail is
 *     the kit's headline invariant. The strip is logged (`audit_reserved_keys_stripped`, the
 *     action and a count), so the route author still finds out.
 *   - MCP / agent: the route's (stripped) keys, then `_via` (and `_turn`) LAST — so even a
 *     payload the strip somehow missed cannot win.
 */
export function auditPayloadJson(
  payload: Record<string, unknown> | undefined,
  invocation: Invocation,
): { json: string | null; stripped: number } {
  const own =
    payload !== undefined && payload !== null && typeof payload === 'object' ? payload : undefined;
  const reserved = own
    ? Object.keys(own).filter((k) => k.startsWith(RESERVED_AUDIT_KEY_PREFIX))
    : [];
  const attribution = attributionKeys(invocation);
  const needsRebuild = reserved.length > 0 || Object.keys(attribution).length > 0;
  if (!needsRebuild) {
    // Exactly the pre-attribution expression, falsy test included.
    return { json: payload ? JSON.stringify(payload) : null, stripped: 0 };
  }
  const kept: Record<string, unknown> = {};
  if (own) {
    for (const [k, v] of Object.entries(own)) {
      if (!k.startsWith(RESERVED_AUDIT_KEY_PREFIX)) kept[k] = v;
    }
  }
  // An HTTP payload that held ONLY reserved keys stays an (empty) object: the route did supply a
  // payload, and turning it into NULL would say it supplied none.
  return { json: JSON.stringify({ ...kept, ...attribution }), stripped: reserved.length };
}

/**
 * The read-ledger request id for a call on `invocation`: the turn id for an agent call (every read
 * of one turn correlates under it), undefined otherwise (beginReadAudit mints a fresh uuid).
 */
export function readLedgerRequestId(invocation: Invocation): string | undefined {
  return invocation.via === 'agent' ? invocation.turnId : undefined;
}
