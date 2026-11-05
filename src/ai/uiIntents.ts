// UI INTENTS — the closed, server-validated set of things the in-app agent may ask the SPA to do.
//
// A lesson from CopilotKit, applied the other way round. CopilotKit lets the FRONTEND register
// arbitrary "frontend tools" that the model may call, and the browser decides what they do. Here
// the model is offered three fixed tools. Their arguments are validated on the SERVER against
// registries in the protected core (src/ai/uiTargets.ts), filtered by the caller's live
// permissions and capped per turn. Only what survives reaches the SPA, as an AG-UI CUSTOM event:
//
//   ui_navigate  { view, params? }  open one of the views that opted in; params fill its :params
//   ui_highlight { anchor }         point at an element on the page the user is on
//   ui_prefill   { form, fields }   fill in — never submit — a create form that opted in
//
// DORMANT. Nothing in the worker imports this module yet; the P2 agent loop will. What it will
// call, and the rules it must keep:
//
//   1. OFFER uiIntentTools(principal) with the round's tools. The lists are already narrowed to
//      what this caller may target, so a view or form they cannot open is never even named. It
//      returns [] for anything but a person (a service principal has no screen), and for a person
//      who may open none of the listed views.
//   2. ADMIT only the model's OWN tool calls: admitUiIntents(message, principal, emittedThisTurn),
//      where `message` is `{ role: 'assistant', content: result.content }` and `result` is what
//      callAnthropic / streamAnthropic JUST returned in this round. ENFORCED: admit throws unless
//      `content` is that very array (isModelOutput, src/ai/anthropic.ts). A message rebuilt from
//      storage (agent_turns.pending_json, a stored transcript, a Workflow step's persisted result),
//      a copy, or anything assembled by hand or from tool output is refused. So admit in the SAME
//      Workflow step as the model call, and persist the admitted EVENTS (for SSE re-attach), never
//      the raw tool_use blocks to admit later. It also throws on a non-assistant message, and reads
//      nothing but `tool_use` blocks named ui_*: tool RESULTS travel in user-role messages, and a
//      text block that merely looks like a call is not one.
//   3. SEND each `emitted` outcome's `event` as it stands (an AG-UI CUSTOM event), and answer
//      EVERY ui_* tool_use with uiIntentToolResult(outcome). A dropped intent reads the same
//      whatever the reason (the 404-uniformity rule, applied to the model): an unknown view and
//      a forbidden one are indistinguishable. Never route a ui_* call to executeRoute, and never
//      register a route tool whose name starts with `ui_`.
//   4. CARRY `emittedThisTurn` from one round to the next, and start each turn at 0. The cap
//      (UI_INTENTS_PER_TURN) is per turn, and a turn has several rounds.
//   5. Re-resolve the principal before each admit, as for every tool call. The filter asks
//      principalCan() at admit time, not at offer time.
//
// WHAT THIS DOES NOT CLOSE. The model can still be steered by injected tool output into calling
// one of these tools itself. The bounds on what that can do are the controls here:
//   - closed, default-deny target lists, where each entry is a reviewed opt-in (uiTargets.ts);
//   - no view or form gated by a permission no agent may target (agentMayTarget);
//   - params and anchors that are identifier-shaped, so a URL, an email address, a sentence or a
//     CSS selector is refused and a param never carries more than 64 characters of [A-Za-z0-9_-];
//   - the permission filter, and three intents a turn;
//   - prefill that only ever creates, that the user must read and submit, in characters they can
//     see (HIDDEN below).
// The definition-time checks on a form (POST, no :params, a `create` audit verb, content-shaped
// field names) are backstops for the reviewer, not a guarantee: they cannot tell a create that
// grants access, or a free-text field that names a person, from any other. The explicit opt-in is
// the control. The SPA side (P3) must render prefilled values as plain input values, never as
// markup, and must resolve an anchor only against elements that opted in by a data attribute,
// never as a selector or a DOM id.
import { z } from 'zod';
import { isAgentScope, NON_DELEGABLE, PERMISSIONS, principalCan } from '../auth/permissions';
import type { Principal } from '../auth/types';
import type { RouteDef } from '../framework/defineRoute';
import { isModelOutput } from './anthropic';
import type { AiMessage, AiTool, AiToolResultBlock } from './types';
import { AGENT_FORMS, AGENT_VIEWS, type AgentForm, type AgentView } from './uiTargets';

/** At most this many intents reach the SPA per turn; the rest are dropped `over_cap`. */
export const UI_INTENTS_PER_TURN = 3;

/** The AG-UI CUSTOM event name every intent is sent under. */
export const UI_INTENT_EVENT = 'kit.ui_intent';

export const UI_INTENT_TOOLS = ['ui_navigate', 'ui_highlight', 'ui_prefill'] as const;
export type UiIntentToolName = (typeof UI_INTENT_TOOLS)[number];

/** The tool result for any dropped intent: one text, whatever the reason. */
export const UI_INTENT_UNAVAILABLE = 'This action is not available.';
const UI_INTENT_SENT = 'Sent to the app.';

/**
 * The only verb a prefill target's audit action may end in. Prefill only creates: an update would
 * need the model to pick WHICH record, and the SPA could only fill whichever one is open. An
 * allowlist, so a verb nobody reviewed (`update`, `revoke_sessions`, `approve`) fails closed.
 */
export const PREFILL_AUDIT_VERBS: ReadonlySet<string> = new Set(['create']);

/** The longest `max` a prefill field may declare (the kit's longest route string, a note body). */
export const PREFILL_FIELD_MAX = 20_000;

/**
 * A param value or an anchor: an identifier, never text, a URL, an address or a selector.
 * web/src/views.ts holds the same rule for viewHref (PARAM_VALUE, pinned to this by the isolation
 * tripwire).
 */
export const ID_SHAPED = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A param or field name. */
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/**
 * A field name that picks a record rather than carrying content: `id`, `caseId`, `case_id`,
 * `parentIDs`. Prefill fills content; which record a form writes to is never the model's to choose.
 * Case-sensitive on purpose, so `paid` and `valid` are content.
 */
const RECORD_SELECTOR = /^(?:id|ids|Id|Ids|ID|IDs)$|_(?:id|ID)s?$|[a-z0-9](?:Id|ID)s?$/;
/** A static path segment, and a view id (which is the first one). */
const PATH_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PARAM_SEGMENT = /^:([A-Za-z][A-Za-z0-9_]*)$/;
const FORM_ID = /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+){0,7}$/;
/**
 * A character the user cannot see, in a prefill value. The user reading what was prefilled before
 * submitting is the control on ui_prefill, and it holds only for visible text. Refused:
 *   - every General_Category C code point (Cc controls, Cf format — the bidi controls, the
 *     zero-width characters, the U+E0000 tag block that spells ASCII a model reads and a person
 *     does not — Cs lone surrogates, Co private use, Cn unassigned and noncharacters), except tab,
 *     line feed and carriage return;
 *   - the line and paragraph separators (Zl, Zp), which many inputs render as nothing;
 *   - every Default_Ignorable_Code_Point, whatever its category: the ones that are letters or
 *     marks render as nothing too. That is every variation selector (U+FE00–FE0F, U+E0100–E01EF),
 *     the Mongolian free variation selectors (U+180B–180D, U+180F), the Hangul fillers (U+115F,
 *     U+1160, U+3164, U+FFA0), the combining grapheme joiner (U+034F) and the Khmer inherent vowels
 *     (U+17B4, U+17B5). A run of them after one visible character is "emoji smuggling": bytes a
 *     model decodes and a person never sees, one per selector;
 *   - with one exception, which keeps emoji: U+FE0E / U+FE0F directly after an
 *     Extended_Pictographic character (❤️, ✌️, ©️), or inside a keycap (1️⃣: a digit, # or *, the
 *     selector, then U+20E3). Anywhere else — after a letter, after a digit that is not a keycap,
 *     after another selector — it is refused, so one selector per character carries no bytes.
 * C and Cn follow the runtime's Unicode version, so a character newer than it is refused: fail
 * closed. The cost: text that NEEDS a joiner (an emoji ZWJ sequence, Persian ZWNJ) or a standardized
 * variation sequence outside emoji (a CJK or math variant) is refused whole. What this does not
 * catch is VISIBLE look-alikes (a Cyrillic а for a Latin a, the several widths of space): they are
 * text the user can read, which is the rule.
 */
const HIDDEN =
  /(?![\t\n\r])\p{C}|\p{Zl}|\p{Zp}|(?![\uFE0E\uFE0F])\p{Default_Ignorable_Code_Point}|(?<![\p{Extended_Pictographic}0-9#*])[\uFE0E\uFE0F]|(?<=[0-9#*])[\uFE0E\uFE0F](?!\u20E3)/u;

/** What one admitted intent asks the SPA to do. Plain JSON: it is the CUSTOM event's `value`. */
export type UiIntent =
  | {
      readonly intent: 'navigate';
      readonly view: string;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly intent: 'highlight'; readonly anchor: string }
  | {
      readonly intent: 'prefill';
      readonly form: string;
      /** The view the form lives on (it has no :params), so the SPA can open it first. */
      readonly view: string;
      readonly fields: Readonly<Record<string, string>>;
    };

/** An AG-UI CUSTOM event (`{ type: 'CUSTOM', name, value }`) carrying one intent. */
export interface UiIntentEvent {
  readonly type: 'CUSTOM';
  readonly name: typeof UI_INTENT_EVENT;
  readonly value: UiIntent;
}

/**
 * Why an intent was dropped — for the loop's own counters, NEVER for the model (its tool result is
 * uniform) or the user. `invalid`: not a well-formed call to a listed target. `forbidden`: the
 * caller may not open the view (for a highlight: any listed view), or may not submit the form.
 * `over_cap`: the turn already emitted UI_INTENTS_PER_TURN.
 */
export type UiIntentDropReason = 'invalid' | 'forbidden' | 'over_cap';

export type UiIntentOutcome =
  | {
      readonly toolUseId: string;
      readonly tool: UiIntentToolName;
      readonly status: 'emitted';
      readonly event: UiIntentEvent;
    }
  | {
      readonly toolUseId: string;
      readonly tool: UiIntentToolName;
      readonly status: 'dropped';
      readonly reason: UiIntentDropReason;
    };

export interface UiIntentAdmission {
  /** One per ui_* tool_use in the message, in order. Other tool calls are not listed. */
  readonly outcomes: readonly UiIntentOutcome[];
  /** Intents emitted this turn so far, this message's included: pass it to the next round. */
  readonly emittedThisTurn: number;
}

export function isUiIntentTool(name: string): name is UiIntentToolName {
  return (UI_INTENT_TOOLS as readonly string[]).includes(name);
}

/** The `:param` names in a path template, in order (the same rule as web/src/views.ts). */
export function pathParamNames(path: string): string[] {
  const names: string[] = [];
  for (const segment of path.split('/')) {
    const m = PARAM_SEGMENT.exec(segment);
    if (m) names.push(m[1]!);
  }
  return names;
}

const isPermissionKey = (key: string): boolean => Object.hasOwn(PERMISSIONS, key);

/**
 * May the agent be pointed at something gated by `permission` — a view to open, a form to stage?
 * Only a real key (`isKey`) that is neither NON_DELEGABLE nor in the reserved agent family. It
 * takes the key predicate, as serviceMayHold does (src/auth/permissions.ts), so the agent clause is
 * testable while no agent key exists: over PERMISSIONS alone `isKey` already refuses every
 * `agent…` string, and the clause could be deleted unnoticed.
 *
 * NON_DELEGABLE is today's set for "too dangerous to hand to something a prompt injection can
 * steer": a key too dangerous for a token is too dangerous for a model. The agent-exposure work
 * adds a separate agent-only set that contains it; this then reads that set instead, which can
 * only refuse more (DECISIONS 2026-09-25).
 */
export function agentMayTarget(permission: string, isKey: (key: string) => boolean): boolean {
  return isKey(permission) && !NON_DELEGABLE.has(permission) && !isAgentScope(permission);
}

/**
 * The definition-time guard over both registries: it throws at module load, like defineRoute's
 * guards, so a malformed entry fails every test instead of reaching a model. Exported for tests.
 * What it cannot see from here, because the core never imports the route table, is checked
 * against the live routes by prefillRouteProblems.
 */
export function assertUiTargets(views: readonly AgentView[], forms: readonly AgentForm[]): void {
  const fail = (what: string): never => {
    throw new Error(`UI intent targets: ${what}`);
  };
  const viewById = new Map<string, AgentView>();
  for (const v of views) {
    if (!PATH_SEGMENT.test(v.id)) fail(`view id '${v.id}' is not a lowercase path segment`);
    if (viewById.has(v.id)) fail(`view '${v.id}' is listed twice`);
    viewById.set(v.id, v);
    if (v.agentNavigable !== true) fail(`view '${v.id}' must opt in with agentNavigable: true`);
    if (!agentMayTarget(v.permission, isPermissionKey)) {
      fail(`view '${v.id}' is gated by '${v.permission}', which no agent may target`);
    }
    const segments = v.path.split('/');
    if (segments[0] !== '' || segments[1] !== v.id) {
      fail(`view '${v.id}' has path '${v.path}'; it must start with /${v.id}`);
    }
    const params = new Set<string>();
    for (const segment of segments.slice(2)) {
      const name = PARAM_SEGMENT.exec(segment)?.[1];
      if (name === undefined && !PATH_SEGMENT.test(segment)) {
        fail(`view '${v.id}' has a malformed path segment`);
      }
      if (name !== undefined && params.has(name)) fail(`view '${v.id}' repeats :${name}`);
      if (name !== undefined) params.add(name);
    }
  }
  const formIds = new Set<string>();
  for (const f of forms) {
    if (!FORM_ID.test(f.id)) fail(`form id '${f.id}' is malformed`);
    if (formIds.has(f.id)) fail(`form '${f.id}' is listed twice`);
    formIds.add(f.id);
    if (f.agentPrefill !== true) fail(`form '${f.id}' must opt in with agentPrefill: true`);
    const view = viewById.get(f.view);
    if (!view) fail(`form '${f.id}' names an unknown view '${f.view}'`);
    if (pathParamNames(view!.path).length > 0) {
      fail(`form '${f.id}' lives on a view with :params; prefill only creates, on a view without`);
    }
    if (f.route.method !== 'POST') {
      fail(`form '${f.id}' targets a ${f.route.method} route; prefill only creates (POST)`);
    }
    if (!f.route.path.startsWith('/api/')) fail(`form '${f.id}' targets a path outside /api/`);
    if (f.route.path.includes(':')) {
      fail(`form '${f.id}' targets a route with :params; prefill only creates`);
    }
    if (!agentMayTarget(f.permission, isPermissionKey)) {
      fail(`form '${f.id}' is gated by '${f.permission}', which no agent may target`);
    }
    const fields = Object.entries(f.fields);
    if (fields.length === 0) fail(`form '${f.id}' lists no fields`);
    for (const [name, schema] of fields) {
      if (!NAME.test(name)) fail(`form '${f.id}' has a malformed field name '${name}'`);
      if (RECORD_SELECTOR.test(name)) {
        fail(`form '${f.id}' field '${name}' picks a record; prefill fills content only`);
      }
      const max = schema instanceof z.ZodString ? schema.maxLength : null;
      if (max === null || max > PREFILL_FIELD_MAX) {
        fail(
          `form '${f.id}' field '${name}' must be a string with a max of at most ${PREFILL_FIELD_MAX}`,
        );
      }
    }
  }
}

interface JsonProperty {
  readonly type?: unknown;
  readonly maxLength?: unknown;
}

/**
 * Everything wrong with `form` as a prefill target, checked against the live route table (the
 * core never imports it, so test/isolation/ui-intent-targets.test.ts calls this with allRoutes,
 * and so may the agent loop when it arms). Empty means allowed. Each problem is a fixed code:
 *   route_missing               no route has the form's method and path
 *   permission_mismatch         the route is gated by a different key than the form says
 *   machine_route               the route is machine-only (RouteSpec.machine): no person can submit it
 *   not_create                  the route's audit action does not end in a PREFILL_AUDIT_VERBS verb
 *   route_has_path_params       the route picks a record by its path, so it is not a create
 *   field_not_in_route:<f>      the route takes no string input of that name
 *   field_looser_than_route:<f> the form allows a longer value than the route accepts
 */
export function prefillRouteProblems(form: AgentForm, routes: readonly RouteDef[]): string[] {
  const route = routes.find(
    (r) => r.spec.method === form.route.method && r.spec.path === form.route.path,
  );
  if (!route) return ['route_missing'];
  const problems: string[] = [];
  if (route.spec.permission !== form.permission) problems.push('permission_mismatch');
  if (route.spec.machine === true) problems.push('machine_route');
  const audit = route.spec.audit;
  const verb = typeof audit === 'string' ? audit.slice(audit.lastIndexOf('.') + 1) : '';
  if (!PREFILL_AUDIT_VERBS.has(verb)) problems.push('not_create');
  if (pathParamNames(route.spec.path).length > 0) problems.push('route_has_path_params');
  const json = z.toJSONSchema(route.spec.input, { io: 'input' }) as {
    properties?: Record<string, JsonProperty>;
  };
  const properties = json.properties ?? {};
  for (const [name, schema] of Object.entries(form.fields)) {
    const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
    if (property?.type !== 'string') problems.push(`field_not_in_route:${name}`);
    else if (
      typeof property.maxLength === 'number' &&
      (schema.maxLength ?? Number.POSITIVE_INFINITY) > property.maxLength
    ) {
      problems.push(`field_looser_than_route:${name}`);
    }
  }
  return problems;
}

/** The permission-filter half, shared by what is offered and what is admitted. */
function mayOpen(principal: Principal, view: AgentView): boolean {
  return principal.kind === 'person' && principalCan(principal, view.permission);
}

export interface UiIntents {
  /** The ui_* tools to offer `principal` this round, narrowed to what it may target. */
  tools(principal: Principal): AiTool[];
  /**
   * Validate, permission-filter and cap the ui_* tool calls in the response the AI client just
   * returned. Throws on any other message (see rule 2 above).
   */
  admit(message: AiMessage, principal: Principal, emittedThisTurn: number): UiIntentAdmission;
}

/**
 * Build the UI-intent gate over a pair of registries. The kit's instance, over AGENT_VIEWS and
 * AGENT_FORMS, is exported below as uiIntentTools / admitUiIntents; this factory exists so tests
 * can exercise registries the kit does not ship (a view with params, a malformed form).
 */
export function buildUiIntents(
  views: readonly AgentView[],
  forms: readonly AgentForm[],
): UiIntents {
  assertUiTargets(views, forms);
  const viewById = new Map(views.map((v) => [v.id, v]));
  const formById = new Map(forms.map((f) => [f.id, f]));
  const formFields = new Map(forms.map((f) => [f.id, z.object(f.fields).partial().strict()]));

  const mayOpenAny = (principal: Principal): boolean => views.some((v) => mayOpen(principal, v));
  const mayPrefill = (principal: Principal, form: AgentForm): boolean => {
    const view = viewById.get(form.view)!;
    return mayOpen(principal, view) && principalCan(principal, form.permission);
  };

  const idEnum = (ids: readonly string[]) => z.enum(ids as [string, ...string[]]);

  // The shapes the model is shown. Cross-field rules (a view's exact :params, a form's own
  // fields) are checked in parse() below, after the shape.
  const navigateSchema = (targets: readonly AgentView[]) =>
    z
      .object({
        view: idEnum(targets.map((v) => v.id)),
        params: z.record(z.string().regex(NAME), z.string().regex(ID_SHAPED)).optional(),
      })
      .strict();

  const highlightSchema = z.object({ anchor: z.string().regex(ID_SHAPED) }).strict();

  const prefillSchema = (targets: readonly AgentForm[]) =>
    z
      .object({
        form: idEnum(targets.map((f) => f.id)),
        fields: z.record(z.string().regex(NAME), z.string()),
      })
      .strict();

  // The full-registry schemas admission validates against. A call naming a target this caller
  // may not reach is well-formed, and the permission filter drops it as `forbidden`.
  const navigateAll = views.length > 0 ? navigateSchema(views) : null;
  const prefillAll = forms.length > 0 ? prefillSchema(forms) : null;

  const inputSchema = (schema: z.ZodType): AiTool['input_schema'] => {
    const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'input' });
    return { ...rest, type: 'object' };
  };

  const describeView = (v: AgentView): string => {
    const params = pathParamNames(v.path);
    return params.length > 0 ? `${v.id} (params: ${params.join(', ')})` : v.id;
  };
  const describeForm = (f: AgentForm): string =>
    `${f.id}: ${Object.entries(f.fields)
      .map(([name, s]) => `${name} (at most ${s.maxLength} characters)`)
      .join(', ')}`;

  function parse(tool: UiIntentToolName, input: unknown): UiIntent | null {
    if (tool === 'ui_highlight') {
      const r = highlightSchema.safeParse(input);
      return r.success ? { intent: 'highlight', anchor: r.data.anchor } : null;
    }
    if (tool === 'ui_navigate') {
      const r = navigateAll?.safeParse(input);
      if (!r?.success) return null;
      const want = pathParamNames(viewById.get(r.data.view)!.path);
      const params = { ...r.data.params };
      const got = Object.keys(params);
      if (got.length !== want.length || !want.every((n) => Object.hasOwn(params, n))) return null;
      return { intent: 'navigate', view: r.data.view, params };
    }
    const r = prefillAll?.safeParse(input);
    if (!r?.success || Object.keys(r.data.fields).length === 0) return null;
    const fields = formFields.get(r.data.form)!.safeParse(r.data.fields);
    if (!fields.success) return null;
    if (Object.values(r.data.fields).some((value) => HIDDEN.test(value))) return null;
    const form = formById.get(r.data.form)!;
    return { intent: 'prefill', form: form.id, view: form.view, fields: { ...r.data.fields } };
  }

  function permitted(principal: Principal, intent: UiIntent): boolean {
    if (intent.intent === 'navigate') return mayOpen(principal, viewById.get(intent.view)!);
    if (intent.intent === 'prefill') return mayPrefill(principal, formById.get(intent.form)!);
    // A highlight acts on the page the user already has open. It is for a person who may open at
    // least one listed view — never a service, never a token that reaches nothing here.
    return mayOpenAny(principal);
  }

  return {
    tools(principal) {
      const openable = views.filter((v) => mayOpen(principal, v));
      if (openable.length === 0) return [];
      const fillable = forms.filter((f) => mayPrefill(principal, f));
      const tools: AiTool[] = [
        {
          name: 'ui_navigate',
          description:
            `Open one of this app's views on the user's screen. Views: ${openable.map(describeView).join('; ')}. ` +
            'Param values are record ids, never text.',
          input_schema: inputSchema(navigateSchema(openable)),
        },
        {
          name: 'ui_highlight',
          description:
            'Point the user at an element on the page they have open, by its anchor id. Anchor ids are identifiers, never text.',
          input_schema: inputSchema(highlightSchema),
        },
      ];
      if (fillable.length > 0) {
        tools.push({
          name: 'ui_prefill',
          description:
            'Fill in a new-record form for the user to review, edit and submit themselves; it is never submitted for them. ' +
            `Forms and their fields: ${fillable.map(describeForm).join('; ')}.`,
          input_schema: inputSchema(prefillSchema(fillable)),
        });
      }
      return tools;
    },

    admit(message, principal, emittedThisTurn) {
      if (message.role !== 'assistant') {
        throw new Error("UI intents come only from the model's own tool calls (assistant role)");
      }
      if (!isModelOutput(message.content)) {
        throw new Error(
          'UI intents come only from the content the AI client just returned, never a copy or a stored message',
        );
      }
      if (!Number.isSafeInteger(emittedThisTurn) || emittedThisTurn < 0) {
        throw new Error('emittedThisTurn must be a non-negative integer');
      }
      const outcomes: UiIntentOutcome[] = [];
      let emitted = emittedThisTurn;
      for (const block of message.content) {
        if (block.type !== 'tool_use' || !isUiIntentTool(block.name)) continue;
        const base = { toolUseId: block.id, tool: block.name } as const;
        const intent = parse(block.name, block.input);
        if (intent === null) {
          outcomes.push({ ...base, status: 'dropped', reason: 'invalid' });
        } else if (!permitted(principal, intent)) {
          outcomes.push({ ...base, status: 'dropped', reason: 'forbidden' });
        } else if (emitted >= UI_INTENTS_PER_TURN) {
          outcomes.push({ ...base, status: 'dropped', reason: 'over_cap' });
        } else {
          emitted += 1;
          const event: UiIntentEvent = { type: 'CUSTOM', name: UI_INTENT_EVENT, value: intent };
          outcomes.push({ ...base, status: 'emitted', event });
        }
      }
      return { outcomes, emittedThisTurn: emitted };
    },
  };
}

/** The tool result that answers a ui_* tool_use: uniform for every dropped intent. */
export function uiIntentToolResult(outcome: UiIntentOutcome): AiToolResultBlock {
  if (outcome.status === 'emitted') {
    return { type: 'tool_result', tool_use_id: outcome.toolUseId, content: UI_INTENT_SENT };
  }
  return {
    type: 'tool_result',
    tool_use_id: outcome.toolUseId,
    content: UI_INTENT_UNAVAILABLE,
    is_error: true,
  };
}

const kit = buildUiIntents(AGENT_VIEWS, AGENT_FORMS);

/** The ui_* tools to offer `principal` (see rule 1 above). */
export const uiIntentTools = (principal: Principal): AiTool[] => kit.tools(principal);

/** Admit one assistant message's ui_* tool calls for `principal` (see rules 2–5 above). */
export const admitUiIntents = (
  message: AiMessage,
  principal: Principal,
  emittedThisTurn: number,
): UiIntentAdmission => kit.admit(message, principal, emittedThisTurn);
