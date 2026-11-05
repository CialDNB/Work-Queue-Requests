// THE PAVED ROAD. Every API endpoint in a kit app is a defineRoute() — the framework
// injects, in order: principal resolution (fail-closed), CSRF defense, the per-action
// permission check (denial renders as a uniform 404), Zod validation at the boundary,
// a ready-made data layer, audit-on-write, and opaque error rendering. A handler only
// ever sees a typed input and a ctx. Deviating from this path should take real effort:
// that is the point.
//
// Definition-time guards (they throw at module load, so tests catch violations):
//   • mutating routes MUST declare `audit` (a string action, or an explicit `false`)
//   • routes with `:params` MUST provide a uniformityFixture for the 404 tripwire
//   • `machine: true` routes MUST name a permission a service identity may hold
//   • a route exposed to the in-app agent (`agent:`) must pass the exposure guard
//     (src/framework/agentExposure.ts) — and a route without `agent:` is never an agent tool
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { resolvePrincipal } from '../auth';
import { isServiceGrantable, type PermissionKey } from '../auth/permissions';
import type { Principal } from '../auth/types';
import type { Db } from '../data';
import type { UpstreamGrant, UpstreamReadOptions, UpstreamReadSpec } from '../data/upstream';
import type { Env } from '../env';
import { logEvent } from '../platform/logEvent';
import { isSameOrigin, requiresCsrfCheck } from '../security/csrf';
import { type AgentExposure, checkedAgentExposure } from './agentExposure';
import { fail, ok } from './envelope';
import { AppError, badRequest, csrfRejected, unauthorized } from './errors';
import { executeRoute } from './execute';
import type { Invocation } from './invocation';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * What a handler is handed. `N` is the set of repositories the route declared in `needs`;
 * it defaults to ALL of them, so `RouteCtx` with no argument is exactly the ctx every
 * existing route already sees.
 */
export interface RouteCtx<N extends keyof Db = keyof Db> {
  readonly principal: Principal;
  /**
   * The data layer. A route that declares `needs` sees only those repositories — and the
   * runtime view throws on the rest, so the type is a promise the framework keeps. A route
   * that declares nothing sees the whole Db, unchanged.
   */
  readonly db: Pick<Db, N>;
  readonly env: Env;
  readonly request: Request;
  readonly ip: string;
  /**
   * How this call arrived (src/framework/invocation.ts): `{ via: 'http' }`, `{ via: 'mcp' }`, or
   * `{ via: 'agent', turnId }` for an in-app agent tool call. ATTRIBUTION ONLY — for correlating
   * what a handler records elsewhere with the call's audit rows (which carry `_via` / `_turn`) and
   * its read-ledger rows (whose `request_id` is the turn id). Never branch authority on it:
   * permissions come from the principal, on every channel alike — the `authMethod` rule, again.
   */
  readonly invocation: Invocation;
  /**
   * This call's id in the read ledger: an agent call's TURN id, a fresh uuid otherwise — the value
   * every `read_log` row of the call carries in `request_id`. The framework's D1 recorder uses it;
   * pass it as `AuroraCtx.requestId` when the handler reads a private database
   * (docs/DATA-ROUTES.md), so the call's Aurora rows correlate with its D1 rows and, for an agent
   * call, with the turn. An identifier, never content.
   */
  readonly requestId: string;
  /**
   * Shape the single audit row the framework writes for this route's declared `audit`
   * action: name the resource it targets, plus an optional payload. Call this in handlers
   * whose target the URL does not carry — a create that mints a new id, or any mutation
   * that wants a richer payload. Routes whose `:param` already IS the target (update/delete)
   * need not call it: the framework defaults the target to the first path param. Last wins.
   * Payload keys starting with `_` are RESERVED for the framework's attribution (`_via`, `_turn`)
   * and are stripped, with an `audit_reserved_keys_stripped` log line — name yours without one.
   */
  setAuditTarget(target: string, payload?: Record<string, unknown>): void;
  /**
   * Append an *additional* audit row, beyond the one the framework writes for `spec.audit`.
   * Rare — a normal mutation only needs `setAuditTarget` (the declared action is written for
   * you). Awaited, best-effort: a failed write is logged, never fails the request. (The
   * DECLARED action's write is held to a stricter posture: on failure the framework raises
   * an alert through the ops seam — see step 5 in execute.ts and DECISIONS 2026-08-03.)
   */
  audit(action: string, target?: string, payload?: Record<string, unknown>): Promise<void>;
  /**
   * On a MACHINE route (`spec.machine`): the request's validated `X-Sync-Run` id — the caller's
   * name for the sync run this batch belongs to. `null` when the app runs warn-only and the header
   * was missing or invalid, and ALWAYS `null` on an ordinary route (the header is not read there).
   * Pass it to batchAudit(); the framework also stamps it on every audit payload the route writes.
   */
  readonly syncRunId: string | null;
  waitUntil(p: Promise<unknown>): void;
  /**
   * Read an UPSTREAM HTTP source through the read ledger (PIA C15). `spec` is a read registered
   * with `defineUpstreamRead` (src/data/upstream.ts, protected core); `read` is the fetch, as a
   * thunk — call the integration module inside it, never before it, and pass it the GRANT the
   * thunk receives (the module refuses a call without a live one, `requireUpstreamGrant`):
   *
   *     const report = await ctx.readUpstream(AUTOBAHN_REPORT, (grant) =>
   *       fetchLiveReport(grant, cfg, order),
   *     );
   *
   * The framework supplies who (this principal), the route, and this request's id (shared with its
   * d1 ledger rows when READ_AUDIT is armed). For a CLIENT-class source the ledger row is written
   * and awaited before `read` runs, and if it cannot be written `read` never runs and the request
   * fails with the opaque 500. Recorded whether or not READ_AUDIT is armed. The ledger records the
   * NAME of what the read was keyed by (`ticket_key`), never the value.
   */
  readUpstream<T>(
    spec: UpstreamReadSpec,
    read: (grant: UpstreamGrant) => Promise<T>,
    opts?: UpstreamReadOptions<T>,
  ): Promise<T>;
}

/**
 * Seeds one real resource for the 404-uniformity tripwire
 * (test/isolation/uniformity.test.ts). Use only synthetic data.
 */
export interface UniformityFixture {
  seed(db: Db): Promise<Record<string, string>>;
}

export interface RouteSpec<S extends z.ZodTypeAny, N extends keyof Db = keyof Db> {
  method: Method;
  /** Hono path, e.g. '/api/notes/:id'. Resources are plural kebab-case under /api/. */
  path: string;
  /**
   * Permission key checked before the handler ('authenticated' = any active PERSON). 'authenticated'
   * skips the key check, so a person's bearer token scopes do not apply: every personal token
   * reaches the route, even one scoped to []. A SERVICE principal never does — its authority is its
   * one scope, and it has no identity surface (principalMayCall). Keep it for identity-only reads
   * (GET /api/me); anything that mutates or returns app data takes a real key (PIA C8).
   * There is deliberately no 'public' — public surfaces (auth, /_health) live outside
   * the paved road, so every defineRoute is fail-closed by construction.
   */
  permission: PermissionKey | 'authenticated';
  /**
   * MACHINE-ONLY route: reachable by a SERVICE principal (a service identity) that holds
   * `permission`, and by nobody else — a person of any role, on a session or a personal token,
   * gets the uniform 404 (principalMayCall). For bulk endpoints an integration calls (an ETL's
   * batch push). On such a route the framework also (src/framework/machine.ts):
   *   - requires a valid `X-Sync-Run` header (1–64 of [A-Za-z0-9._:-]; 400 otherwise, after the
   *     permission check) unless the app sets MACHINE_SYNC_RUN=warn, and hands it to the handler as
   *     `ctx.syncRunId`;
   *   - stamps that id on every audit payload the route writes, and caps each payload at 1 KB
   *     (oversize → `{ oversize, bytes, runId }` + a warning). Build the payload with batchAudit().
   * `permission` must be a key a service may hold (not 'authenticated', not non-delegable) — else
   * nobody could ever call the route, and defineRoute throws. The manifest publishes the flag.
   */
  machine?: boolean;
  input: S;
  /** Audit action written automatically on success (mutations must declare or opt out). */
  audit?: string | false;
  /**
   * Optional per-principal abuse ceiling (a coarse KV window, NOT spend accounting — use
   * the AI budget ledger for dollars). Applied AFTER the permission check, so a forbidden
   * caller still gets a uniform 404 and only permitted users are ever limited. Keyed per
   * route + principal; over the limit → 429 with `Retry-After`.
   */
  rateLimit?: { limit: number; windowSec: number };
  /**
   * OPT-IN least privilege over the data layer: the repositories this handler may reach
   * through `ctx.db`. Declaring `needs: ['notes']` narrows `ctx.db` to `Pick<Db, 'notes'>`
   * at compile time AND backs it with a view that throws on every other repository at
   * runtime (src/framework/scopedDb.ts) — so a notes route cannot read users, tokens, or
   * the audit log, by accident or by drift.
   *
   * OMIT IT and `ctx.db` is the whole data layer, byte-for-byte the pre-`needs` behaviour:
   * no view is built and nothing extra is allocated on the request path. Declaring it is
   * how a route earns a smaller blast radius; it is deliberately not yet mandatory.
   *
   * Scope: `needs` governs what the HANDLER touches directly. The framework's own audit
   * writes (the declared `audit:` row, `ctx.audit()`) are unaffected — those are mediated
   * capabilities the route already declares elsewhere.
   */
  needs?: readonly N[];
  summary?: string;
  uniformityFixture?: UniformityFixture;
  /**
   * EXPOSE THIS ROUTE TO THE IN-APP AGENT. Default deny: a route without this block is never an
   * agent tool. With it, the route becomes one tool (named by src/framework/toolName.ts) that the
   * agent's tool set (buildAgentTools, src/framework/agentTools.ts) offers only to a person who
   * may call it, and invokes only through executeRoute — the same permission check, validation,
   * audit and read ledger as HTTP, with `_via: 'agent'` and the turn id on its rows.
   *
   * The block declares what the tool does (`effect`), whether a person approves each call
   * (`needsApproval`, `approvalSummary`), and where its data goes (`egress`, `egressRuling`). Every
   * claim is checked when this module loads, and a route that fails a rule does not load — see the
   * header of src/framework/agentExposure.ts for the rules (PIA C3, C16) and
   * test/isolation/agent-exposure.test.ts for the pinned set of exposed routes.
   */
  agent?: AgentExposure<z.infer<S>>;
  handler(ctx: RouteCtx<N>, input: z.infer<S>): Promise<Response | unknown>;
}

export interface RouteDef {
  spec: RouteSpec<z.ZodTypeAny>;
}

export function defineRoute<S extends z.ZodTypeAny, N extends keyof Db = keyof Db>(
  spec: RouteSpec<S, N>,
): RouteDef {
  if (MUTATING.has(spec.method) && spec.audit === undefined) {
    throw new Error(
      `Route ${spec.method} ${spec.path}: mutating routes must declare an audit action (or an explicit \`audit: false\` with written justification in the PR)`,
    );
  }
  if (spec.path.includes(':') && !spec.uniformityFixture) {
    throw new Error(
      `Route ${spec.method} ${spec.path}: routes with path params must provide a uniformityFixture so the 404-uniformity tripwire can cover them`,
    );
  }
  // A machine route admits only a service holding its key, so the key must be one a service CAN
  // hold: 'authenticated' admits no service, and a non-delegable key is never a service's scope.
  // Either way the route would 404 for every caller forever — refuse it where it is written.
  if (
    spec.machine === true &&
    (spec.permission === 'authenticated' || !isServiceGrantable(spec.permission))
  ) {
    throw new Error(
      `Route ${spec.method} ${spec.path}: a machine route needs a permission a service identity may hold (not 'authenticated', not non-delegable) — '${spec.permission}' would make it unreachable`,
    );
  }
  if (spec.rateLimit) {
    const { limit, windowSec } = spec.rateLimit;
    if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(windowSec) || windowSec <= 0) {
      throw new Error(
        `Route ${spec.method} ${spec.path}: rateLimit.limit and rateLimit.windowSec must be positive integers`,
      );
    }
  }
  if (spec.agent !== undefined) {
    // Throws on any rule the block breaks; the route keeps a FROZEN copy of the checked block, so
    // nothing the route module still holds can widen it after the check.
    const agent = checkedAgentExposure(spec as unknown as RouteSpec<z.ZodTypeAny>);
    return { spec: { ...spec, agent } as unknown as RouteSpec<z.ZodTypeAny> };
  }
  return { spec: spec as unknown as RouteSpec<z.ZodTypeAny> };
}

export function mountRoutes(app: Hono<{ Bindings: Env }>, routes: readonly RouteDef[]): void {
  for (const def of routes) {
    app.on(def.spec.method, def.spec.path, (c) => handle(c, def.spec));
  }
}

// The HTTP adapter. It owns the transport-specific concerns — principal resolution, the
// cookie CSRF check, building the raw input from the request, and rendering the result/error as
// a Response — and delegates the enforcement pipeline (permission → rate → validate → handler →
// audit) to executeRoute, which the MCP adapter shares. Keep it thin: anything that isn't
// HTTP-shaped belongs in executeRoute so every adapter enforces it identically.
async function handle(
  c: Context<{ Bindings: Env }>,
  spec: RouteSpec<z.ZodTypeAny>,
): Promise<Response> {
  const env = c.env;
  try {
    const principal = await resolvePrincipal(c.req.raw, env);
    if (!principal) throw unauthorized();

    // CSRF: cookie-authenticated mutations must be same-origin. Bearer requests are exempt (a
    // deliberately attached header, not an ambient credential) — the same reason the MCP
    // adapter, which is bearer-only, needs no check. requiresCsrfCheck keys on
    // credentialTransport (how the credential ARRIVED, set at the resolvePrincipal branch
    // point) and fails closed on both axes: a session minted with a wrong/novel authMethod,
    // an absent transport field, or a future transport value is still CSRF-checked.
    if (MUTATING.has(spec.method) && requiresCsrfCheck(principal) && !isSameOrigin(c.req.raw)) {
      throw csrfRejected();
    }

    const params = c.req.param() as Record<string, string>;
    const result = await executeRoute(env, spec, principal, {
      ip: c.req.raw.headers.get('cf-connecting-ip') ?? '',
      params,
      request: c.req.raw,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      invocation: { via: 'http' },
      // Built only after executeRoute clears the permission + rate checks (a forbidden caller
      // never reaches this). Precedence: path params > query > body, so an attacker-controlled
      // body can never override the resource the URL names.
      buildRawInput: () => buildHttpRawInput(c, params),
    });

    return result instanceof Response ? result : ok(result);
  } catch (err) {
    if (err instanceof AppError) {
      const res = fail(err.status, err.code, err.message);
      if (err.retryAfterSec != null) res.headers.set('Retry-After', String(err.retryAfterSec));
      return res;
    }
    // Opaque 500: the error's CATEGORY goes to observability (never its message — see
    // src/platform/logEvent.ts), and nothing goes to the client.
    logEvent('route_error', { method: spec.method, path: spec.path, err });
    return fail(500, 'internal_error', 'Internal error');
  }
}

// Merge the request's body, query, and path params into the raw object executeRoute validates.
// Throws badRequest for a malformed JSON body; because this runs inside executeRoute (after the
// permission check), that error can never precede a denied caller's uniform 404.
async function buildHttpRawInput(
  c: Context<{ Bindings: Env }>,
  params: Record<string, string>,
): Promise<unknown> {
  const query: Record<string, string> = {};
  for (const [k, v] of new URL(c.req.url).searchParams) {
    if (!(k in query)) query[k] = v;
  }

  let body: Record<string, unknown> = {};
  if (MUTATING.has(c.req.method)) {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json')) {
      // Read the RAW text, and parse only a NON-EMPTY body. Browsers routinely advertise a JSON
      // content-type on a bodiless mutation (the kit's own SPA client did it on every request),
      // and c.req.json() THROWS on an empty body — which 400'd every DELETE in every fork.
      // "Advertises JSON but sends nothing" means NO BODY INPUT, not malformed. This cannot
      // weaken validation: an empty body simply contributes no keys, so Zod still rejects a
      // route's required fields — with the specific missing-field message instead of a
      // misleading "Invalid JSON body". A non-empty malformed body is still a hard 400.
      // The READ stays inside the catch, not just the parse. c.req.json() is
      // text().then(JSON.parse), so the original single try/catch covered BOTH failure modes,
      // and a body read fails on its own terms (a Content-Length larger than the bytes sent, a
      // client vanishing mid-upload). Catching only the parse turns those into an opaque 500 +
      // a route_error entry — noise in Logpush/SIEM and a poisoned 5xx signal on a kit where a
      // 500 is the alert-worthy event. A broken request stays a clean 400.
      let raw: string;
      try {
        raw = await c.req.text();
      } catch {
        throw badRequest('Invalid JSON body');
      }
      if (raw.trim() !== '') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw badRequest('Invalid JSON body');
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        } else {
          throw badRequest('Body must be a JSON object');
        }
      }
    }
  }

  return { ...body, ...query, ...params };
}
