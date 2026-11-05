// AGENT EXPOSURE — the `agent:` block on defineRoute, and the guards that make it safe to write.
//
// DEFAULT DENY. The in-app agent can call a route only if its defineRoute declares an `agent:`
// block; a route without one is never an agent tool, whatever its permission, method or path. The
// kit's own routes declare none (test/isolation/agent-exposure.test.ts pins that set, so any
// exposure change is a visible diff).
//
// The block says what the tool DOES and where its data GOES, and every claim is checked when the
// route module loads — the same posture as defineRoute's audit and uniformity guards, so a
// violation is a failed import in the test suite rather than a surprise on the one agent turn that
// reaches it:
//
//   effect          'read' | 'write' | 'destructive' | 'external', and it must agree with the method:
//                   GET is 'read', DELETE is 'destructive', a POST/PUT/PATCH is never 'read'.
//   needs           REQUIRED on an exposed route — the repositories it can reach are what the
//                   data-class check below reads.
//   input           a Zod OBJECT, carrying every `:param` of the path (a tool fills the path from
//                   its arguments), and whose tool name (src/framework/toolName.ts) fits the model
//                   provider's `^[A-Za-z0-9_-]{1,64}$`.
//   permission      never 'authenticated' and never AGENT_FORBIDDEN (src/auth/permissions.ts);
//                   and `needs` names no AGENT_FORBIDDEN_REPOSITORIES entry (the audit log, the
//                   ledger, credentials, settings…), so an exposable label cannot reach them
//                   through ctx.db. A route module that built its own handle with makeDb() would
//                   reach them anyway; semgrep `data-handle-in-routes` fails CI on that in
//                   src/routes (and the kit's route modules elsewhere).
//   needsApproval   REQUIRED (true, or a predicate) for 'destructive' and 'external', and for ANY
//                   route with egress, unless every argument is closed (PIA C16 — model-written
//                   free text never reaches an egress host, or a destructive action, without a
//                   human saying yes). Closed is judged on the Zod validator itself (ClosedRule,
//                   src/framework/closedArguments.ts):
//                   an enum, boolean, integer or id-shaped string for a destructive route; where
//                   data LEAVES, no letter the model chose — author values, digits, uuid/guid/ulid.
//                   Only Zod's OWN format checks count (not a custom `z.stringFormat` under the same
//                   name), and only checks that run on every value (no `when`).
//   egress          the hosts the route sends data to; REQUIRED non-empty for 'external'.
//   egressRuling    a Linear decision id (`C36-1561`), REQUIRED when the route reads client-class
//                   data — its `needs` names a repository src/data/dataClass.ts does not classify
//                   `internal` — or declares egress (PIA C3: every client-class route exposed to the
//                   agent carries a DPO-signed ruling with a written necessity test). And in an
//                   app that binds a client-class private database, on EVERY exposed route: an
//                   Aurora read is a repository call no declaration can rule out
//                   (assertPrivateSourcesRuled, run where the registry is assembled).
//   approvalSummary an i18n KEY plus identifier-named params — the card's wording comes from the
//                   catalogue, so a model cannot write the question a human answers; a param value
//                   it fills is screened to one line of visible text.
//   render          a component id (shape-checked here; the component registry is the UI's).
//
// An unknown key in the block is refused too: a misspelt `needApproval: true` would otherwise be
// ignored, and the route would ship with no approval at all. The block is a plain object literal of
// data properties, read once (snapshotBlock): what was checked is exactly what is kept.
//
// Nothing here runs a tool. The builder is src/framework/agentTools.ts (buildAgentTools), which
// only ever invokes through executeRoute.
import { z } from 'zod';
import { isAgentForbidden, isAgentForbiddenRepository } from '../auth/permissions';
import { AURORA_SOURCES } from '../data/aurora';
import { repositoryDataClass } from '../data/dataClass';
import type { ReadSourceClass } from '../data/readLog';
import { openArguments } from './closedArguments';
import type { RouteSpec } from './defineRoute';
import { pathParamNames, TOOL_NAME_PATTERN, toolName } from './toolName';

/** What an agent tool does. Drives the approval rule and is published in the manifest. */
export type AgentEffect = 'read' | 'write' | 'destructive' | 'external';

export const AGENT_EFFECTS: readonly AgentEffect[] = ['read', 'write', 'destructive', 'external'];

/**
 * An approval card's content: an i18n catalogue KEY and the values its placeholders take. The KEY
 * is never a sentence — the wording of the question a person approves is the catalogue's, not the
 * model's or the route's. A param VALUE may carry model text (a title from the arguments), so it is
 * screened: one line of visible characters (APPROVAL_PARAM_HIDDEN), ≤ APPROVAL_PARAM_MAX_LENGTH, or
 * a finite number. `params` names are identifiers.
 */
export interface AgentApprovalSummary {
  readonly key: string;
  readonly params: Readonly<Record<string, string | number>>;
}

/**
 * The `agent:` block of a defineRoute. `I` is the route's validated input type, so a predicate is
 * typed against exactly what the handler receives.
 */
export interface AgentExposure<I = unknown> {
  effect: AgentEffect;
  /** The tool description the model reads. Defaults to the route's `summary`. ≤ 1024 characters. */
  description?: string;
  /**
   * Must a person approve this call before it runs? `true`, `false`, or a predicate over the
   * validated input. FAIL CLOSED at run time: a predicate that throws, or returns anything but
   * exactly `false`, means approval is required.
   */
  needsApproval?: boolean | ((input: I) => boolean);
  /** The approval card: an i18n key + params (AgentApprovalSummary). Invalid or throwing → generic. */
  approvalSummary?: (input: I) => AgentApprovalSummary;
  /** Hostnames the route sends data to (lowercase, no scheme/port/path). Required for 'external'. */
  egress?: readonly string[];
  /** A Linear decision id (`TEAM-123`) — the DPO ruling that covers this route's data leaving. */
  egressRuling?: string;
  /** A registered UI component id that renders this tool's result. */
  render?: string;
}

const AGENT_KEYS: ReadonlySet<string> = new Set([
  'effect',
  'description',
  'needsApproval',
  'approvalSummary',
  'egress',
  'egressRuling',
  'render',
]);

export const AGENT_DESCRIPTION_MAX_LENGTH = 1024;
/** A Linear issue identifier: team key, hyphen, number (`C36-1561`, `AICOE-571`). */
export const EGRESS_RULING_PATTERN = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6}$/;
/** A component id: an identifier, optionally dotted/dashed (`chart.timeseries`, `company-card`). */
export const RENDER_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;
const RENDER_ID_MAX_LENGTH = 64;
/** A lowercase DNS hostname with at least two labels and a non-numeric TLD. No wildcard. */
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_PATTERN = new RegExp(`^(?:${HOST_LABEL}\\.)+(?=[a-z0-9-]*[a-z])${HOST_LABEL}$`);
const HOSTNAME_MAX_LENGTH = 253;

/** The i18n key an approval card falls back to when a route's approvalSummary cannot be used. */
export const GENERIC_APPROVAL_KEY = 'agent.approval.generic';
export const APPROVAL_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;
const APPROVAL_KEY_MAX_LENGTH = 128;
const APPROVAL_PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const APPROVAL_PARAM_MAX_LENGTH = 200;
const APPROVAL_PARAMS_MAX = 20;
/**
 * What an approval-card param may not carry. A param often IS model text (a title the model chose),
 * and the person approves what the card SHOWS — so it is one line of visible characters. Refused:
 * every General_Category C code point (controls, INCLUDING tab, line feed and carriage return; the
 * bidi controls and zero-width characters (Cf); the U+E0000 tag block; lone surrogates; private use;
 * unassigned), the line and paragraph separators (Zl, Zp), the supplementary variation selectors,
 * and any run of two or more variation selectors (bytes smuggled after one visible character). The
 * rule ui_prefill uses for model-written UI values (P1-F), minus its tab/newline allowance.
 */
const APPROVAL_PARAM_HIDDEN = /\p{C}|\p{Zl}|\p{Zp}|[\u{E0100}-\u{E01EF}]|[\uFE00-\uFE0F]{2}/u;

type AnyRouteSpec = RouteSpec<z.ZodTypeAny>;
type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------------
// Derived facts (the guard, the manifest and the tool builder all read these)
// ---------------------------------------------------------------------------------------------

/** Is `spec` exposed to the agent at all? Only a declared block counts (default deny). */
export function isAgentExposed(spec: AnyRouteSpec): boolean {
  return spec.agent !== undefined;
}

/** A private-database source table: AURORA_SOURCES (src/data/aurora.ts), or a test's own. */
export type PrivateSourceTable = Readonly<Record<string, ReadSourceClass>>;

/** The route's `needs` repositories that src/data/dataClass.ts does not classify internal. */
export function clientRepositories(spec: AnyRouteSpec): string[] {
  return (spec.needs ?? []).filter((repo) => repositoryDataClass(repo) === 'client');
}

/**
 * The CLIENT-class private databases the app binds — every AURORA_SOURCES entry whose class is not
 * exactly `internal` (fail closed), sorted. A route reads one through a repository FUNCTION over
 * `ctx.env` (docs/DATA-ROUTES.md), not through `needs`, so no declaration on a route can say
 * whether it does: in an app that binds one, the framework cannot rule client data out for ANY
 * route. `sources` is a parameter only so tests can drive a table without module mocking.
 */
export function clientPrivateSources(sources: PrivateSourceTable = AURORA_SOURCES): string[] {
  return Object.entries(sources)
    .filter(([, sourceClass]) => sourceClass !== 'internal')
    .map(([name]) => name)
    .sort();
}

/**
 * Does the route reach client-class data? A client-class `needs` repository — or, because an Aurora
 * read is invisible to the framework, ANY route in an app that binds a client-class private
 * database. Fail closed: "cannot rule it out" counts as "reads it".
 */
export function readsClientClass(
  spec: AnyRouteSpec,
  sources: PrivateSourceTable = AURORA_SOURCES,
): boolean {
  return clientRepositories(spec).length > 0 || clientPrivateSources(sources).length > 0;
}

/** Must this exposed route carry an egressRuling? Client-class reads, or any declared egress. */
export function requiresEgressRuling(
  spec: AnyRouteSpec,
  sources: PrivateSourceTable = AURORA_SOURCES,
): boolean {
  return readsClientClass(spec, sources) || (spec.agent?.egress?.length ?? 0) > 0;
}

/**
 * THE APP-LEVEL HALF OF PIA C3. checkedAgentExposure judges what a ROUTE declares, when its module
 * loads. Whether the app binds a client-class private database is a fact about the APP (its
 * AURORA_SOURCES, cross-checked against its bindings by `verify:edge`), and it decides the ruling
 * for every exposed route at once: in such an app each one must carry an `egressRuling`, because
 * nothing the route declares can prove its handler never calls an Aurora repository.
 *
 * Checked where the registry is ASSEMBLED — buildAgentTools, before any tool exists, and
 * test/isolation/agent-exposure.test.ts over the live registry in every fork's CI — rather than at
 * each module load, so a route module's validity does not depend on a table elsewhere. Throws,
 * naming the first route without a ruling and the sources, like a module that failed to load.
 */
export function assertPrivateSourcesRuled(
  specs: readonly AnyRouteSpec[],
  sources: PrivateSourceTable = AURORA_SOURCES,
): void {
  const bound = clientPrivateSources(sources);
  if (bound.length === 0) return;
  for (const spec of specs) {
    if (isAgentExposed(spec) && spec.agent?.egressRuling === undefined) {
      throw new Error(
        `Route ${spec.method} ${spec.path}: agent exposure — egressRuling is required: the app binds a client-class private database (${bound.join(', ')}), and no route declaration can rule an Aurora read out (PIA C3 — a DPO-signed Linear decision)`,
      );
    }
  }
}

/** How approval is declared, for the manifest: a function cannot be published, its existence can. */
export function approvalMode(
  agent: Pick<AgentExposure, 'needsApproval'>,
): 'always' | 'never' | 'conditional' {
  if (typeof agent.needsApproval === 'function') return 'conditional';
  return agent.needsApproval === true ? 'always' : 'never';
}

// ---------------------------------------------------------------------------------------------
// The definition-time guard
// ---------------------------------------------------------------------------------------------

function isHostname(v: unknown): v is string {
  return typeof v === 'string' && v.length <= HOSTNAME_MAX_LENGTH && HOSTNAME_PATTERN.test(v);
}

/**
 * The `agent:` block, read ONCE into a fresh record of its own data properties: the values every
 * rule in checkedAgentExposure judges, and the values its frozen copy keeps. A field read through
 * a prototype or a getter can answer the check one way and the copy another — a class-based block
 * whose `needsApproval` is a method passed C16, then lost it to the copy's spread and published
 * 'never' (pre-merge review of P1-A). So the block must be a plain object literal (prototype
 * Object.prototype or null), every own key — non-enumerable and symbol keys included — a known
 * field, and every field a value, never a getter or setter.
 */
function snapshotBlock(raw: unknown, fail: (why: string) => never): Readonly<JsonObject> {
  if (!isPlainObject(raw)) return fail('`agent` must be an object block');
  const proto: unknown = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    fail(
      '`agent` must be a plain object literal — not a class instance or an Object.create(…) block, whose inherited fields a copy would drop',
    );
  }
  const block: JsonObject = Object.create(null) as JsonObject;
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !AGENT_KEYS.has(key)) {
      return fail(
        `unknown key \`${String(key)}\` (an unknown field would otherwise be silently ignored)`,
      );
    }
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (field === undefined) continue;
    if (!('value' in field)) {
      fail(`\`${key}\` must be a plain value, not a getter or setter (read once, checked, kept)`);
    }
    block[key] = field.value;
  }
  return block;
}

const EFFECTS_BY_METHOD: Readonly<Record<string, readonly AgentEffect[]>> = {
  GET: ['read'],
  DELETE: ['destructive'],
  POST: ['write', 'destructive', 'external'],
  PUT: ['write', 'destructive', 'external'],
  PATCH: ['write', 'destructive', 'external'],
};

/**
 * THE GUARD. Throws, naming the route and the rule, if `spec.agent` is not a block this kit will
 * expose; returns a FROZEN copy of the block (egress frozen too) otherwise, so nothing a route
 * module still holds can widen it after it was checked. Called by defineRoute for every route that
 * declares `agent`.
 */
export function checkedAgentExposure(spec: AnyRouteSpec): Readonly<AgentExposure> {
  const where = `Route ${spec.method} ${spec.path}: agent exposure`;
  const fail = (why: string): never => {
    throw new Error(`${where} — ${why}`);
  };
  const agent = snapshotBlock(spec.agent, fail);

  // What the tool does, and whether the method agrees.
  const effect = agent.effect;
  if (typeof effect !== 'string' || !AGENT_EFFECTS.includes(effect as AgentEffect)) {
    fail(`effect must be one of ${AGENT_EFFECTS.join(', ')}`);
  }
  const allowed = EFFECTS_BY_METHOD[spec.method] ?? [];
  if (!allowed.includes(effect as AgentEffect)) {
    fail(`effect '${String(effect)}' does not fit ${spec.method} (allowed: ${allowed.join(', ')})`);
  }

  // Who may be handed it.
  if (isAgentForbidden(spec.permission)) {
    fail(
      `permission '${spec.permission}' can never be exposed to the agent ('authenticated' and AGENT_FORBIDDEN, src/auth/permissions.ts)`,
    );
  }

  // A MACHINE-ONLY route (`RouteSpec.machine`, B9) admits only a service principal, and the agent
  // acts only for a person: exposing one would offer a tool every call to which is a 404.
  if (spec.machine === true) {
    fail(
      'a machine-only route (`machine: true`) can never be exposed — the agent acts for a person',
    );
  }

  // What it can reach and take.
  if (!Array.isArray(spec.needs)) {
    fail('an exposed route must declare `needs` (the repositories it reaches)');
  }
  const forbiddenNeeds = (spec.needs ?? []).filter((repo) => isAgentForbiddenRepository(repo));
  if (forbiddenNeeds.length > 0) {
    fail(
      `needs reaches ${forbiddenNeeds.join(', ')} — repositories no agent tool may touch, whatever its permission (AGENT_FORBIDDEN_REPOSITORIES, src/auth/permissions.ts)`,
    );
  }
  if (!(spec.input instanceof z.ZodObject)) {
    fail('input must be a Zod object schema (z.object({...}))');
  }
  const shape = (spec.input as z.ZodObject<z.ZodRawShape>).shape;
  for (const param of pathParamNames(spec.path)) {
    if (!Object.hasOwn(shape, param)) {
      fail(`input must carry the path param \`${param}\` (a tool fills the path from its args)`);
    }
  }
  const name = toolName(spec.method, spec.path);
  if (!TOOL_NAME_PATTERN.test(name)) {
    fail(
      `tool name '${name}' must match ${TOOL_NAME_PATTERN} (≤ 64 characters) — shorten the path`,
    );
  }

  // What the model reads.
  if (agent.description !== undefined) {
    if (
      typeof agent.description !== 'string' ||
      agent.description.trim() === '' ||
      agent.description.length > AGENT_DESCRIPTION_MAX_LENGTH
    ) {
      fail(
        `description must be a non-empty string of at most ${AGENT_DESCRIPTION_MAX_LENGTH} characters`,
      );
    }
  }
  if (agent.render !== undefined) {
    if (
      typeof agent.render !== 'string' ||
      agent.render.length > RENDER_ID_MAX_LENGTH ||
      !RENDER_ID_PATTERN.test(agent.render)
    ) {
      fail('render must be a component id (an identifier, e.g. `chart.timeseries`)');
    }
  }

  // Where its data goes.
  let egress: readonly string[] = [];
  if (agent.egress !== undefined) {
    // Copied ONCE, then judged: the list checked is the list kept.
    const hosts: unknown[] = Array.isArray(agent.egress) ? [...(agent.egress as unknown[])] : [];
    if (!Array.isArray(agent.egress) || !hosts.every(isHostname)) {
      fail('egress must be a list of lowercase hostnames (no scheme, port, path or wildcard)');
    }
    egress = Object.freeze(hosts as string[]);
    if (new Set(egress).size !== egress.length) fail('egress lists a host twice');
  }
  if (effect === 'external' && egress.length === 0) {
    fail("effect 'external' must declare its egress hosts");
  }
  if (agent.egressRuling !== undefined) {
    if (typeof agent.egressRuling !== 'string' || !EGRESS_RULING_PATTERN.test(agent.egressRuling)) {
      fail('egressRuling must be a Linear decision id (e.g. C36-1561)');
    }
  }
  // The ROUTE's half of C3: client-class `needs`, or declared egress. The app's half — a bound
  // client-class private database — is assertPrivateSourcesRuled, where the registry is assembled.
  const clientRepos = clientRepositories(spec);
  if ((clientRepos.length > 0 || egress.length > 0) && agent.egressRuling === undefined) {
    const why =
      clientRepos.length > 0
        ? `its needs reach client-class data (${clientRepos.join(', ')} — see src/data/dataClass.ts)`
        : 'it declares egress';
    fail(`egressRuling is required: ${why} (PIA C3 — a DPO-signed Linear decision)`);
  }

  // Who must say yes first.
  const needsApproval = agent.needsApproval;
  if (
    needsApproval !== undefined &&
    typeof needsApproval !== 'boolean' &&
    typeof needsApproval !== 'function'
  ) {
    fail('needsApproval must be a boolean or a predicate over the input');
  }
  if (agent.approvalSummary !== undefined && typeof agent.approvalSummary !== 'function') {
    fail('approvalSummary must be a function returning { key, params }');
  }
  const approvalDeclared = needsApproval === true || typeof needsApproval === 'function';
  // Data that LEAVES is judged by the stricter rule: no letter the model chose may reach the host.
  const leaves = effect === 'external' || egress.length > 0;
  if ((effect === 'destructive' || leaves) && !approvalDeclared) {
    const open = openArguments(spec.input, leaves ? 'egress' : 'id');
    if (open.length > 0) {
      const what = `effect '${String(effect)}'${egress.length > 0 ? ' with egress' : ''}`;
      const closed = leaves
        ? 'only enums, literals, booleans, digits and uuid/guid/ulid ids are closed where data leaves'
        : 'not enum- or id-shaped';
      fail(
        `${what} needs \`needsApproval\` (true or a predicate): argument(s) ${open.join(', ')} can carry free text — ${closed} (PIA C16)`,
      );
    }
  }

  // Built from the snapshot every rule above judged — never from the route's own object.
  return Object.freeze({
    ...(agent as unknown as AgentExposure),
    ...(agent.egress !== undefined ? { egress } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// Run-time evaluation (the tool builder uses these; both fail closed)
// ---------------------------------------------------------------------------------------------

/**
 * Must a person approve this call? Evaluated on the VALIDATED input. Only an explicit `false` —
 * declared, or returned by the predicate — means no: a predicate that throws or returns anything
 * else means yes.
 */
export function approvalRequired(agent: AgentExposure, input: unknown): boolean {
  const rule = agent.needsApproval;
  if (rule === undefined || rule === false) return false;
  if (rule === true) return true;
  try {
    return rule(input) !== false;
  } catch {
    return true;
  }
}

/**
 * The approval card for this call: the route's `approvalSummary(input)` when it returns a valid
 * `{ key, params }` (an i18n key; identifier-named params; string values of one visible line ≤ 200
 * characters, or finite numbers), else the generic card
 * `{ key: 'agent.approval.generic', params: { tool } }`. Never throws — a broken summary, or a
 * param carrying a newline, a bidi override or a zero-width character, degrades to the generic
 * card; it never skips the approval.
 */
export function approvalSummaryFor(
  agent: AgentExposure,
  input: unknown,
  tool: string,
): AgentApprovalSummary {
  const generic: AgentApprovalSummary = Object.freeze({
    key: GENERIC_APPROVAL_KEY,
    params: Object.freeze({ tool }),
  });
  if (typeof agent.approvalSummary !== 'function') return generic;
  let out: unknown;
  try {
    out = agent.approvalSummary(input);
  } catch {
    return generic;
  }
  if (!isPlainObject(out)) return generic;
  const { key, params } = out as { key?: unknown; params?: unknown };
  if (
    typeof key !== 'string' ||
    key.length > APPROVAL_KEY_MAX_LENGTH ||
    !APPROVAL_KEY_PATTERN.test(key)
  ) {
    return generic;
  }
  if (!isPlainObject(params)) return generic;
  const entries = Object.entries(params);
  if (entries.length > APPROVAL_PARAMS_MAX) return generic;
  const clean: Record<string, string | number> = {};
  for (const [name, value] of entries) {
    if (!APPROVAL_PARAM_NAME.test(name)) return generic;
    if (typeof value === 'number' && Number.isFinite(value)) clean[name] = value;
    else if (
      typeof value === 'string' &&
      value.length <= APPROVAL_PARAM_MAX_LENGTH &&
      !APPROVAL_PARAM_HIDDEN.test(value)
    ) {
      clean[name] = value;
    } else return generic;
  }
  return Object.freeze({ key, params: Object.freeze(clean) });
}
