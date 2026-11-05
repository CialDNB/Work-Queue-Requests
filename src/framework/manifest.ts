// THE APP MANIFEST — a machine-readable projection of the paved road's own ontology.
// Every defineRoute() already declares the resource it targets, the permission it needs, the
// audit verb it writes, the repositories it may touch, and its validated input shape; this walks
// the live route registry + the permission matrix + the app identity and emits them as one JSON
// document. There is no second list to maintain: add a route, a permission, or a `needs` entry
// and the manifest changes automatically.
//
// Consumers (all downstream of this): the fleet registry (governance map + kit-version lag),
// MCP tool generation (every tool derived from a route inherits the same permission + audit +
// uniformity), and typed web-client codegen. It exposes STRUCTURE, never data or secrets.
//
// Pure and deterministic — no clock, no I/O — so it is snapshot-testable; the HTTP route
// (src/routes/meta.ts) stamps `generated_at` on the way out.
import { ALL_ROLES, PERMISSIONS } from '../auth/permissions';
import type { Role } from '../auth/types';
import { AURORA_SOURCES } from '../data/aurora';
import type { Env } from '../env';
import {
  type AgentEffect,
  approvalMode,
  isAgentExposed,
  type PrivateSourceTable,
  readsClientClass,
  requiresEgressRuling,
} from './agentExposure';
import type { RouteDef } from './defineRoute';
import { toInputJsonSchema } from './jsonSchema';
import { CHECKS_VERSION, KIT_VERSION } from './version';

// The SHAPE version of the manifest AND OF EVERY PUBLISHED PROJECTION OF IT. Bump on any field
// added, renamed, or removed — at the top level, inside `app`, or inside a route — and equally on
// any change to what a projection SENDS, such as the governance slice the daily registry cron
// pushes (src/cron/reportToRegistry.ts). Distinct from KIT_VERSION (which kit the fork runs) and
// app.build_version (the deploy).
//
// THE PROJECTIONS ARE IN SCOPE ON PURPOSE, and it is the whole reason this number is worth
// anything. THREE distinct shapes have already shipped as `manifest_version: 2` — pre-#199;
// post-#199 (`checks_version` added here and to `GET /api/meta/manifest`, never sent by the daily
// report); post-#209/AICOE-571 `e8e7f38` (sent) — and TWO OF THE THREE differ only in the slice.
// A version that tracked this file alone would have called all three identical and would go on
// reproducing the exact ambiguity it exists to end: a consumer still could not tell "an old kit"
// from "a kit that computes the field and never sends it".
//
// So `2` is not a discriminator in that window. Bumping now would repair none of that history and
// would only add a fourth meaning; `3` will be the first bump that means what it says.
//
// HOW MUCH THE TESTS ACTUALLY ENFORCE, stated honestly: two pins record the key sets this version
// stands for — the builder's in test/framework/manifest.test.ts, the registry slice's in
// test/cron/reportToRegistry.test.ts — and both are keyed by THIS constant, so a shape change goes
// red and the failure names the fix. What no test can do is prove you bumped rather than edited
// the record; the recorded shapes are append-only by convention, and rewriting a shipped entry is
// meant to be a visible act in review rather than an impossible one.
//
// Version log — append, never edit a shipped line:
// 1: initial shape.
// 2: routes carry `needs` — the declared repository set (or null when undeclared).
//    (Shipped in three variants; see the note above. `checks_version` arrived inside 2 in #199
//    and did not reach the registry slice until #209 — the omission this log exists to prevent.)
// 3: routes carry `agent` — the route's in-app agent exposure (effect, needs_approval, egress,
//    egress_ruling, client_class), or null when the route is not exposed; the top level carries
//    `agent_exposed` and `agent_client_egress` (counts). The registry slice DROPS the per-route
//    `agent` and SENDS the two counts (see DroppedRouteField in src/cron/reportToRegistry.ts).
// 4: routes carry `machine` — true on a machine-only route (RouteSpec.machine), false otherwise.
//    The registry slice is unchanged from 3: it drops `machine`, deliberately (see
//    DroppedRouteField in src/cron/reportToRegistry.ts).
export const MANIFEST_VERSION = 4;

/**
 * A route's exposure to the in-app agent (RouteSpec.agent, src/framework/agentExposure.ts), as
 * STRUCTURE: what the tool does and where its data goes. Never a function — a `needsApproval`
 * predicate publishes as `'conditional'` — and never the description prose.
 */
export interface ManifestAgent {
  effect: AgentEffect;
  /** `'always'` (true), `'never'` (absent/false) or `'conditional'` (a predicate over the input). */
  needs_approval: 'always' | 'never' | 'conditional';
  /** Declared egress hosts, sorted. */
  egress: string[];
  /** The Linear decision (a DPO ruling) that covers the route's data leaving, or null. */
  egress_ruling: string | null;
  /** Does the route's `needs` reach a repository src/data/dataClass.ts does not classify internal? */
  client_class: boolean;
}

export interface ManifestRoute {
  method: string;
  path: string;
  permission: string;
  /** Declared audit action, `false` if the route explicitly opted out, or null for a non-mutating route. */
  audit: string | false | null;
  summary: string | null;
  rate_limited: boolean;
  /**
   * The route is MACHINE-ONLY (`RouteSpec.machine`): only a service identity holding `permission`
   * reaches it, and a person of any role gets the uniform 404. Always a boolean — `false` for an
   * ordinary route — so every route publishes the same key set.
   */
  machine: boolean;
  /**
   * The repositories the route declared it may reach through `ctx.db` (`RouteSpec.needs`),
   * sorted — or **`null` when the route declared nothing**, in which case `ctx.db` is the WHOLE
   * data layer.
   *
   * `null` and `[]` are OPPOSITE facts and a consumer must never conflate them: `null` is
   * unscoped (this route can reach every repository in the app), `[]` is scoped to nothing
   * (declared, and reaches no repository at all). Publishing an undeclared route as `[]` would
   * make the widest surface in the fleet read as the narrowest.
   */
  needs: string[] | null;
  /**
   * The route's exposure to the in-app agent, or **null when it has none** — which, by default
   * deny, means the agent cannot call it. Always present, so every route publishes one key set.
   */
  agent: ManifestAgent | null;
  /** JSON Schema of the validated input, or a marker object if it can't be represented. */
  input_schema: unknown;
}

export interface AppManifest {
  manifest_version: number;
  kit_version: string;
  checks_version: string;
  app: { name: string; env: string; build_version: string | null };
  roles: readonly Role[];
  permissions: Record<string, readonly Role[]>;
  routes: ManifestRoute[];
  /** Distinct declared audit verbs across all routes — the app's write vocabulary. */
  audit_actions: string[];
  /** How many routes the in-app agent can call (routes with a non-null `agent`). */
  agent_exposed: number;
  /**
   * How many of those let CLIENT-CLASS data or any data leave toward a third party: exposed routes
   * whose `needs` reach client-class data or that declare egress — exactly the ones that must carry
   * an egressRuling (PIA C3). The fleet-level question "which apps hand client data to a model".
   */
  agent_client_egress: number;
}

function auditOf(audit: string | false | undefined): string | false | null {
  if (typeof audit === 'string') return audit;
  return audit === false ? false : null;
}

// `needs` is OPT-IN (see RouteSpec.needs), so "absent" is a real state with its own meaning —
// unscoped, ctx.db is the whole data layer — and it is emitted as null, never as an empty array.
// Only `undefined` becomes null: a route that declares `needs: []` genuinely reaches nothing and
// publishes `[]`.
//
// The copy is not cosmetic. `spec.needs` is the live array `executeRoute` hands to `scopeDb` on
// EVERY request, and the proxy's allow-check is `needs.includes(prop)` against that same
// reference — so a manifest consumer that normalized in place (a `sort()`, a `push()`) would be
// editing what the framework enforces, widening a route's reach at runtime. Same hazard the
// roles/permissions defensive copies below exist for, one step more dangerous. Sorted so the
// published set is a set: order of declaration carries no meaning and a fleet-side diff of two
// manifests should not light up because someone reordered a literal.
function needsOf(needs: readonly string[] | undefined): string[] | null {
  return needs === undefined ? null : [...needs].sort();
}

// The published exposure of one route. Copies (never the live `egress` array the tool set reads)
// and no functions, for the same reason `needsOf` copies: a consumer normalizing in place must not
// be editing what the framework enforces.
function agentOf(spec: RouteDef['spec'], sources: PrivateSourceTable): ManifestAgent | null {
  const agent = spec.agent;
  if (!isAgentExposed(spec) || agent === undefined) return null;
  return {
    effect: agent.effect,
    needs_approval: approvalMode(agent),
    egress: [...(agent.egress ?? [])].sort(),
    egress_ruling: agent.egressRuling ?? null,
    client_class: readsClientClass(spec, sources),
  };
}

/**
 * `sources` is the app's private-database table (AURORA_SOURCES), a parameter only so tests can
 * drive another one: a client-class source makes every exposed route client-class, so a kit test
 * that relied on the default would go red the day a fork binds one.
 */
export function buildManifest(
  env: Env,
  routes: readonly RouteDef[],
  sources: PrivateSourceTable = AURORA_SOURCES,
): AppManifest {
  const manifestRoutes: ManifestRoute[] = routes.map(({ spec }) => ({
    method: spec.method,
    path: spec.path,
    permission: spec.permission,
    audit: auditOf(spec.audit),
    summary: spec.summary ?? null,
    rate_limited: Boolean(spec.rateLimit),
    machine: spec.machine === true,
    needs: needsOf(spec.needs),
    agent: agentOf(spec, sources),
    input_schema: toInputJsonSchema(spec.input),
  }));
  const exposed = routes.filter(({ spec }) => isAgentExposed(spec));

  const audit_actions = [
    ...new Set(
      manifestRoutes.map((r) => r.audit).filter((a): a is string => typeof a === 'string'),
    ),
  ].sort();

  return {
    manifest_version: MANIFEST_VERSION,
    kit_version: KIT_VERSION,
    checks_version: CHECKS_VERSION,
    app: {
      name: env.APP_NAME,
      env: env.APP_ENV,
      build_version: env.APP_BUILD_VERSION ?? null,
    },
    // Defensive copies, NOT the live references. ALL_ROLES/PERMISSIONS are the authz matrix
    // `can()` reads on every request; `as const` is compile-time only, so an in-process manifest
    // consumer (fleet registry, MCP codegen) that normalizes the structure in place — a `sort()`,
    // a `push()` — would mutate the global matrix at runtime. Hand out fresh arrays instead.
    roles: [...ALL_ROLES],
    permissions: Object.fromEntries(
      Object.entries(PERMISSIONS).map(([key, roles]) => [key, [...roles]]),
    ) as Record<string, readonly Role[]>,
    routes: manifestRoutes,
    audit_actions,
    agent_exposed: exposed.length,
    agent_client_egress: exposed.filter(({ spec }) => requiresEgressRuling(spec, sources)).length,
  };
}
