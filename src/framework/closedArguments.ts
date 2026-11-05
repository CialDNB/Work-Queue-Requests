// CLOSED ARGUMENTS — the PIA C16 exemption, judged on the Zod validator that RUNS.
//
// A destructive or egress route exposed to the agent must declare `needsApproval` unless every
// argument is CLOSED: a value the model cannot fill with free text (src/framework/agentExposure.ts
// asks openArguments which arguments are not). This module is that judgement and nothing else.
//
// Every decision below reads the Zod schema itself (`schema._zod.def` — its type, its checks and
// the RegExp objects they hold), NEVER its JSON Schema rendering. The rendering is lossy in exactly
// the direction that matters: it drops a RegExp's flags (`/^[a-z0-9]{1,64}$/m` renders as the same
// `pattern`, while Zod accepts any text after the first newline), and it takes
// `.meta({ format: 'uuid' })` at its word on a plain `z.string()`. A closedness read from there
// would call free text an id. Anything this walker does not recognize is OPEN (fail closed).
import { z } from 'zod';

/**
 * The rule an argument is judged under — how closed it must be for the route to skip approval.
 *
 *   'id'      a DESTRUCTIVE route whose data does not leave the worker. The model picks WHICH record;
 *             closed is an enum or literal, a boolean, an integer, an ISO date/time, a Zod id format
 *             (uuid, guid, ulid, nanoid), an author pattern proved to spell only [A-Za-z0-9_-] and
 *             at most AGENT_ID_MAX_LENGTH characters — or a bounded list / object of those.
 *   'egress'  any route whose data LEAVES (effect 'external', or declared egress). What reaches a
 *             third party may carry no LETTER the model chose: author-written values (enum, literal,
 *             boolean), digits (an integer, an ISO date, an ISO time/datetime whose fractional
 *             seconds are bounded — a fixed `precision` ≤ AGENT_EGRESS_TIME_MAX_PRECISION or a
 *             `.max()` ≤ AGENT_EGRESS_ID_MAX_LENGTH —, an author pattern with no letter class and at
 *             most AGENT_EGRESS_ID_MAX_LENGTH characters) and the fixed-format uuid, guid and ulid.
 *             Lists only of author-written values. An author pattern with a letter class — a
 *             `^[A-Z0-9]{1,20}$` code, a base64url token, a hyphenated slug — is free text here: it
 *             can spell words, and a list of them is kilobytes a prompt injection can send out.
 */
export type ClosedRule = 'id' | 'egress';

/** The longest id-shaped string argument under the 'id' rule (and a cap on a pattern's length). */
export const AGENT_ID_MAX_LENGTH = 64;
/** The longest digit-shaped pattern argument under the 'egress' rule. */
export const AGENT_EGRESS_ID_MAX_LENGTH = 32;
/**
 * The finest fixed `precision` an ISO time/datetime may declare under the 'egress' rule
 * (nanoseconds): a datetime's digits then stay under AGENT_EGRESS_ID_MAX_LENGTH (14 + 9 + a
 * 4-digit offset = 27). Zod's default takes `(?:\.\d+)?` — any number of fractional digits.
 */
export const AGENT_EGRESS_TIME_MAX_PRECISION = 9;
/** The longest list a closed array argument may declare (`.max(n)` or `.length(n)`). */
export const AGENT_ID_LIST_MAX_ITEMS = 50;

/** Zod string formats that are closed by construction — a fixed grammar the model cannot widen. */
const CLOSED_FORMATS: Readonly<Record<ClosedRule, ReadonlySet<string>>> = {
  id: new Set(['uuid', 'guid', 'ulid', 'nanoid', 'date', 'time', 'datetime']),
  // nanoid's 21 characters include `-` and `_` over both cases: enough for a hyphenated phrase.
  egress: new Set(['uuid', 'guid', 'ulid', 'date', 'time', 'datetime']),
};

/**
 * Zod's OWN checks for those formats: the class trait each carries, and the same schema built
 * again from the check's parameters. A format NAME is not proof — `z.stringFormat('uuid', fn)` is
 * a custom check under the uuid name that accepts whatever `fn` does — so a format closes a value
 * only when its check is Zod's built-in class AND tests exactly the pattern Zod gives that class
 * for those parameters (a `pattern` passed around Zod's typed params would otherwise replace it).
 */
const BUILTIN_FORMATS: ReadonlyMap<string, { trait: string; rebuild: (c: ZodDef) => unknown }> =
  new Map<string, { trait: string; rebuild: (c: ZodDef) => unknown }>([
    [
      'uuid',
      {
        trait: '$ZodUUID',
        rebuild: (c) =>
          z.uuid(c.version === undefined ? undefined : { version: c.version as never }),
      },
    ],
    ['guid', { trait: '$ZodGUID', rebuild: () => z.guid() }],
    ['ulid', { trait: '$ZodULID', rebuild: () => z.ulid() }],
    ['nanoid', { trait: '$ZodNanoID', rebuild: () => z.nanoid() }],
    ['date', { trait: '$ZodISODate', rebuild: () => z.iso.date() }],
    [
      'time',
      { trait: '$ZodISOTime', rebuild: (c) => z.iso.time({ precision: c.precision as never }) },
    ],
    [
      'datetime',
      {
        trait: '$ZodISODateTime',
        rebuild: (c) =>
          z.iso.datetime({
            precision: c.precision as never,
            offset: c.offset as never,
            local: c.local as never,
          }),
      },
    ],
  ]);
/** Zod number formats that are integers. */
const INTEGER_FORMATS: ReadonlySet<string> = new Set(['safeint', 'int32', 'uint32']);
/**
 * The only RegExp flags an id pattern may carry: none, or `i`. `m` turns `^…$` into "any one
 * line", `s`/`g`/`y` change what or where it matches, and `u`/`v` make `i` fold non-ASCII letters
 * into the class (`/[a-z]/iu` matches `ſ` and the Kelvin sign).
 */
const ID_PATTERN_FLAGS = /^i?$/;
/** Wrappers whose input is their inner schema's input (or a fixed fallback). */
const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'catch',
  'nonoptional',
]);

type ZodDef = Record<string, unknown>;

/** A Zod schema's (or check's) definition, or null for anything that is not one. */
function defOf(schema: unknown): ZodDef | null {
  if (schema === null || typeof schema !== 'object') return null;
  const internals = (schema as { _zod?: { def?: unknown } })._zod;
  const def = internals?.def;
  return def !== null && typeof def === 'object' ? (def as ZodDef) : null;
}

/** A check Zod runs: its definition, and the class traits of the check object that holds it. */
interface RunningCheck {
  readonly def: ZodDef;
  readonly traits: ReadonlySet<string>;
}

function traitsOf(x: unknown): ReadonlySet<string> {
  const traits = (x as { _zod?: { traits?: unknown } })._zod?.traits;
  return traits instanceof Set ? (traits as ReadonlySet<string>) : new Set();
}

/**
 * The checks Zod runs on a value of `schema`, as $ZodType lists them: the schema itself when it is
 * a check (`z.uuid()`, `z.int()`), then its `.checks` (`.max()`, `.regex()`, `.int()`, …).
 */
function runningChecks(schema: unknown): RunningCheck[] {
  const def = defOf(schema);
  if (def === null) return [];
  const listed: unknown[] = Array.isArray(def.checks) ? def.checks : [];
  const all = traitsOf(schema).has('$ZodCheck') ? [schema, ...listed] : listed;
  return all.flatMap((c) => {
    const d = defOf(c);
    return d === null ? [] : [{ def: d, traits: traitsOf(c) }];
  });
}

/**
 * The `when` Zod itself gives a length check (`.max()`, `.length()`): run it on any value with a
 * length — every string and array. Read off a live check rather than named, since Zod does not
 * export it.
 */
const ZOD_LENGTH_WHEN: unknown = defOf(
  (z.string().max(1)._zod.def.checks ?? [])[0] as unknown,
)?.when;

/**
 * Does Zod run this check on EVERY value? A `when` makes a check conditional (`() => false`: it
 * never runs), so a check carrying one bounds nothing — except Zod's own default on a length check.
 */
function runsAlways(c: ZodDef): boolean {
  return c.when === undefined || c.when === ZOD_LENGTH_WHEN;
}

/** The tightest `.max(n)` / `.length(n)` a string or array schema declares (Infinity: none). */
function declaredMaxLength(schema: unknown): number {
  let max = Number.POSITIVE_INFINITY;
  for (const { def: c, traits } of runningChecks(schema)) {
    if (!runsAlways(c)) continue;
    if (
      c.check === 'max_length' &&
      traits.has('$ZodCheckMaxLength') &&
      typeof c.maximum === 'number'
    )
      max = Math.min(max, c.maximum);
    if (
      c.check === 'length_equals' &&
      traits.has('$ZodCheckLengthEquals') &&
      typeof c.length === 'number'
    )
      max = Math.min(max, c.length);
  }
  return max;
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isLetter = (c: string): boolean => /^[A-Za-z]$/.test(c);

function sameCharCategory(a: string, b: string): boolean {
  return (
    (/[a-z]/.test(a) && /[a-z]/.test(b)) ||
    (/[A-Z]/.test(a) && /[A-Z]/.test(b)) ||
    (isDigit(a) && isDigit(b))
  );
}

/**
 * A `[...]` class body whose every member is in the rule's alphabet: [A-Za-z0-9_-] for 'id',
 * digits and `-`/`_` for 'egress' (a class is a character the MODEL picks, so under 'egress' it may
 * not offer a letter). No negation, no punctuation.
 */
function idClassBodyOk(body: string, rule: ClosedRule): boolean {
  if (body.length === 0 || body.startsWith('^')) return false;
  let i = 0;
  while (i < body.length) {
    const c = body[i] as string;
    if (c === '\\') {
      const e = body[i + 1] ?? '';
      if (!(rule === 'egress' ? ['d', '-', '_'] : ['d', 'w', '-', '_']).includes(e)) return false;
      i += 2;
      continue;
    }
    if (body[i + 1] === '-' && i + 2 < body.length) {
      const hi = body[i + 2] as string;
      if (!sameCharCategory(c, hi) || c > hi) return false;
      if (rule === 'egress' && !isDigit(c)) return false;
      i += 3;
      continue;
    }
    if (!/^[A-Za-z0-9_-]$/.test(c)) return false;
    if (rule === 'egress' && isLetter(c)) return false;
    i += 1;
  }
  return true;
}

/**
 * The longest string an ID PATTERN can match, or null when the pattern is not one under `rule`. An
 * id pattern is anchored (`^…$`) and built only from atoms whose alphabet is [A-Za-z0-9_-] — a
 * literal, `\d`, `\w`, or a non-negated class of those — each with an optional quantifier (`?`,
 * `*`, `+`, `{n}`, `{n,}`, `{n,m}`). No groups, no alternation, no `.`, no whitespace. Under
 * 'egress' no atom the model fills may admit a letter (`\w` and letter classes are refused; a
 * literal letter is the author's, and stays). An unbounded quantifier yields Infinity (the field's
 * `.max()` must then bound it). A small recognizer rather than a probe: it either proves the
 * alphabet or says no. It reads the SOURCE only — the caller checks the RegExp's flags.
 */
export function idPatternMaxLength(source: string, rule: ClosedRule = 'id'): number | null {
  if (!source.startsWith('^') || !source.endsWith('$') || source.length < 2) return null;
  const body = source.slice(1, -1);
  let i = 0;
  let total = 0;
  while (i < body.length) {
    const c = body[i] as string;
    if (c === '\\') {
      if (!(rule === 'egress' ? ['d'] : ['d', 'w']).includes(body[i + 1] ?? '')) return null;
      i += 2;
    } else if (c === '[') {
      const end = body.indexOf(']', i + 1);
      if (end < 0 || !idClassBodyOk(body.slice(i + 1, end), rule)) return null;
      i = end + 1;
    } else if (/^[A-Za-z0-9_-]$/.test(c)) {
      i += 1;
    } else {
      return null;
    }
    let max = 1;
    const q = body[i];
    if (q === '?') {
      i += 1;
    } else if (q === '*' || q === '+') {
      max = Number.POSITIVE_INFINITY;
      i += 1;
    } else if (q === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(body.slice(i));
      if (!m) return null;
      i += m[0].length;
      const lo = Number(m[1]);
      if (m[2] === undefined) max = lo;
      else if (m[3] === '') max = Number.POSITIVE_INFINITY;
      else {
        max = Number(m[3]);
        if (max < lo) return null;
      }
    }
    total += max;
  }
  return total;
}

/** Does a built-in format check test exactly the pattern Zod builds for its parameters? */
function isZodsOwnPattern(c: ZodDef, rebuild: (c: ZodDef) => unknown): boolean {
  const re = c.pattern;
  if (!(re instanceof RegExp)) return false;
  let ref: unknown;
  try {
    ref = defOf(rebuild(c))?.pattern;
  } catch {
    return false;
  }
  return ref instanceof RegExp && ref.source === re.source && ref.flags === re.flags;
}

/**
 * Are an ISO time/datetime's fractional seconds bounded under 'egress'? Only by a fixed integer
 * `precision` (-1: minutes, 0: seconds, n: n digits) up to AGENT_EGRESS_TIME_MAX_PRECISION, or a
 * declared `.max()` within the rule's limit.
 */
function isBoundedTime(c: ZodDef, declaredMax: number): boolean {
  const p = c.precision;
  const fixed =
    typeof p === 'number' && Number.isInteger(p) && p >= -1 && p <= AGENT_EGRESS_TIME_MAX_PRECISION;
  return fixed || declaredMax <= AGENT_EGRESS_ID_MAX_LENGTH;
}

/**
 * Is a z.string() closed under `rule`? It is when ANY of its format checks closes it (checks are
 * ANDed, so one closed check bounds the value) — read from the checks Zod runs, never from
 * metadata or from a format NAME, and only from a check that runs on every value (runsAlways):
 *   - a format in CLOSED_FORMATS whose check is Zod's own (BUILTIN_FORMATS: its class, its
 *     pattern); under 'egress' a time/datetime also needs bounded fractional seconds;
 *   - a `.regex()` (Zod's $ZodCheckRegex) whose RegExp carries no flag but `i` and whose source
 *     is an id pattern short enough for the rule.
 * A custom format (`z.stringFormat(name, fn | re)`) closes nothing.
 */
function isClosedString(schema: unknown, rule: ClosedRule): boolean {
  const limit = rule === 'egress' ? AGENT_EGRESS_ID_MAX_LENGTH : AGENT_ID_MAX_LENGTH;
  const declaredMax = declaredMaxLength(schema);
  return runningChecks(schema).some(({ def: c, traits }) => {
    if (c.check !== 'string_format' || typeof c.format !== 'string' || !runsAlways(c)) return false;
    if (traits.has('$ZodCustomStringFormat') || c.fn !== undefined) return false;
    if (c.format === 'regex') {
      const re = c.pattern;
      if (!traits.has('$ZodCheckRegex')) return false;
      if (!(re instanceof RegExp) || !ID_PATTERN_FLAGS.test(re.flags)) return false;
      const patternMax = idPatternMaxLength(re.source, rule);
      return patternMax !== null && Math.min(patternMax, declaredMax) <= limit;
    }
    const builtin = BUILTIN_FORMATS.get(c.format);
    if (builtin === undefined || !CLOSED_FORMATS[rule].has(c.format)) return false;
    if (!traits.has(builtin.trait) || !isZodsOwnPattern(c, builtin.rebuild)) return false;
    if (rule === 'egress' && (c.format === 'time' || c.format === 'datetime')) {
      return isBoundedTime(c, declaredMax);
    }
    return true;
  });
}

function isInteger(schema: unknown): boolean {
  return runningChecks(schema).some(
    ({ def: c, traits }) =>
      c.check === 'number_format' &&
      traits.has('$ZodCheckNumberFormat') &&
      runsAlways(c) &&
      INTEGER_FORMATS.has(c.format as string),
  );
}

function isPrimitive(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/** An object schema's fields, or null when the object admits keys it does not name. */
function closedShape(def: ZodDef): Record<string, unknown> | null {
  if (def.type !== 'object') return null;
  // A catchall other than `never` (z.looseObject, .passthrough(), .catchall(x)) hands the handler
  // keys the MODEL named — free text by definition. The default strips unknown keys.
  if (def.catchall !== undefined && defOf(def.catchall)?.type !== 'never') return null;
  const shape = def.shape;
  return shape !== null && typeof shape === 'object' ? (shape as Record<string, unknown>) : null;
}

/**
 * Is one argument's schema CLOSED under `rule` — a value the model cannot fill with free text?
 * `authorOnly` narrows it to values the AUTHOR wrote (enum, literal, boolean, null): what an
 * 'egress' list may hold. Anything else — a plain or capped string, a float, a record, a pipe or
 * transform, a lazy or intersection schema — is open.
 */
function isClosedValue(
  schema: unknown,
  rule: ClosedRule,
  depth: number,
  authorOnly = false,
): boolean {
  const def = defOf(schema);
  if (depth > 8 || def === null) return false;
  const type = def.type;
  if (typeof type === 'string' && WRAPPER_TYPES.has(type)) {
    return isClosedValue(def.innerType, rule, depth + 1, authorOnly);
  }
  switch (type) {
    case 'enum':
      return (
        def.entries !== null &&
        typeof def.entries === 'object' &&
        Object.values(def.entries as object).every(isPrimitive)
      );
    case 'literal':
      return Array.isArray(def.values) && def.values.every(isPrimitive);
    case 'boolean':
    case 'null':
      return true;
    case 'union':
      return (
        Array.isArray(def.options) &&
        def.options.length > 0 &&
        def.options.every((o) => isClosedValue(o, rule, depth + 1, authorOnly))
      );
    case 'number':
      return !authorOnly && isInteger(schema);
    case 'string':
      return !authorOnly && isClosedString(schema, rule);
    case 'array':
      return (
        !authorOnly &&
        declaredMaxLength(schema) <= AGENT_ID_LIST_MAX_ITEMS &&
        isClosedValue(def.element, rule, depth + 1, rule === 'egress')
      );
    case 'object': {
      const shape = authorOnly ? null : closedShape(def);
      return (
        shape !== null &&
        Object.values(shape).every((s) => isClosedValue(s, rule, depth + 1, authorOnly))
      );
    }
    default:
      return false;
  }
}

/**
 * The route's arguments that are NOT closed under `rule` (see ClosedRule), by name — empty when the
 * model cannot put free text in any of them. `['(input)']` when the input as a whole is not a
 * closed object shape (not an object, or one that admits keys it does not name). Used by the C16
 * guard and published nowhere.
 */
export function openArguments(input: z.ZodTypeAny, rule: ClosedRule = 'id'): string[] {
  const def = defOf(input);
  const shape = def === null ? null : closedShape(def);
  if (shape === null) return ['(input)'];
  return Object.entries(shape)
    .filter(([, s]) => !isClosedValue(s, rule, 1))
    .map(([name]) => name);
}
