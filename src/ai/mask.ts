// Tool-result masking (PIA C3): national identifiers and identity fields never reach the model raw.
//
// maskToolResult(value, opts) walks a JSON value — what an agent-exposed route returned — and
// replaces every national identifier and identity field with a per-turn token such as `[CPF#1]`.
// The raw values stay in a MaskTurn, in memory, for the UI of the same turn to render by pointer.
// Pure and dependency-free: no I/O, no logging, no clock, no randomness; the input is never mutated.
// DORMANT until the agent loop (plan P2) calls it on every tool result before the model sees it.
//
// ── TWO LAYERS ───────────────────────────────────────────────────────────────────────────────
// (a) BY KEY. A value under an identity key is replaced whatever it looks like — an invalid CPF, a
//     partial one, an object, a number. Keys are matched case-, accent- and separator-
//     insensitively, plurals and one-case compounds included (`cpf`, `CPFs`, `numeroCpf`,
//     `numerocpf`, `CPFSOCIO`, `nroDni`, `fec_nac`, `dataNascimento`, `primaryAddress`,
//     `endereçoResidencial` …). The short ids everyday words contain (rut, dni, ssn, rg, cuit, ruc,
//     rfc: `truth`, `midnight`, `circuit`) match only as a word, or with a number word before or a
//     closed set of words after (`nrodni`, `rutsocio`). The lists are classifyKey in
//     ./maskVocabulary.ts, and DECISIONS 2026-09-25 "Masking tool results". null, booleans and ""
//     pass (they cannot carry an identifier), and so does a placeholder under an id or birth-date
//     key (no digit, or one digit repeated: `N/A`, `000.000.000-00`), but never under an
//     identityKeys field the lists do not name, whose values need not be digits; an array is
//     masked element by element; anything else is one token. Keys that hold a person's OR a
//     company's id (`cuit`, `rfc`, `ruc`, `cpfCnpj`, `documentNumber`, `nroDoc`) are masked unless
//     the value is a valid LEGAL-ENTITY id: of that kind; or, under a document-number key, of any
//     kind, unless it is also a valid person id (then it cannot tell which, and masks).
// (b) BY VALUE, in every string (object keys included) and every 11-digit integer, only when the
//     candidate is checksum-valid (structurally valid for RFC, whose check digit is unreliable):
//       CPF   Brazil       11 digits, `123.456.789-09`, `123-456-789-09` or bare; 2 mod-11 digits
//       CUIT  Argentina    CUIT/CUIL of a PERSON (prefix 20/23/24/27), `20-12.345.678-3` or bare
//       RUC   Peru         RUC of a PERSON (prefix 10/15/17; 10 carries the DNI), bare
//       RUT   Chile        `12.345.678-5`, `12345678-5`, or a K check digit (`12345678K`)
//       CURP  Mexico       18 characters, real date, check digit
//       RFC   Mexico       13 characters (a person): 4 letters, a real YYMMDD date, homoclave;
//                          bare, or grouped in capitals (`ABCD 990101 AB1`, `ABCD-990101-AB1`)
//     A hyphen may be any dash text from a PDF or a word processor holds (en dash, non-breaking
//     hyphen, minus sign …).
//     NOT by value, key-only: Chile RUT written as bare digits, DNI (Argentina, Peru), passports,
//     SSN — no check digit, so any 7-9 digit number would match (amounts, phone numbers, dates).
//     NOT masked: legal-entity ids (CNPJ, a company CUIT 30/33/34, a 12-character RFC, a RUC 20)
//     — public registry keys the agent needs to chain lookups, and not personal data; a sole
//     trader's personal id inside a company name IS caught, by value. Names, e-mail addresses,
//     city, state and country are not identity fields here: routes and egress rulings govern them.
//     Where the format cannot tell person from company, it FAILS CLOSED: a Chilean RUT is always
//     masked, and a bare `20…` number valid as a person CUIT (about 9 company RUCs in 11) is
//     masked outside a `ruc` key even when it is a Peruvian company RUC.
//
// ── WHERE IT RUNS ────────────────────────────────────────────────────────────────────────────
// On the PARSED payload: the handler's return value, before anything serializes it (the MCP
// adapter's JSON.stringify in src/mcp/tools.ts, a loop's text block), and before it is truncated
// for the context window. A string that is exactly one JSON object or array (a payload serialized
// too early, a TEXT column holding JSON) is parsed, masked as a value and serialized again, so the
// key layer still sees its keys. A serialization that is cut, wrapped or embedded in prose does
// not parse and gets the value layer only: never mask the text block.
//
// ── TOKENS (the format PIA §7.3's DSR search refers to) ──────────────────────────────────────
//   token  := "[" LABEL "#" N "]"      e.g. [CPF#1]  [RUT#2]  [ADDRESS#1]
//   LABEL  := one of MASK_LABELS (uppercase ASCII); N := 1, 2, 3 … counted PER LABEL, per turn
//   regex  := MASK_TOKEN_PATTERN
// Stable within one turn: the same raw value gets the same token in every tool result of that turn
// (pass the same MaskTurn), across both layers, punctuation and type (`123.456.789-09`,
// `12345678909` and the number 12345678909 are one [CPF#n]; so are `12.345.678` and 12345678 under
// a `dni` key). A new turn restarts at #1, so a token is meaningless outside its turn: it is NOT
// a pseudonym and cannot be reversed from a transcript. A token-shaped literal in the input
// (`[CPF#1]` in a comment) is rewritten to `(CPF#1)`, so every `[LABEL#N]` in a MASKED RESULT was
// minted here. That does not hold for model output (see RENDERING below).
//   For a DSR (PIA §7.3): a subject's identifier still reaches a transcript through what a user
// types, through fields an egressRuling lets through raw, through the model repeating either, and
// through anything the masker misses (an id under an unlisted key with no check digit, a format it
// does not detect). So search every message (user, assistant and tool content) for every format
// of the subject's identifier. A token hit means some identifier was masked there, never whose.
//
// ── THE TURN MAP ─────────────────────────────────────────────────────────────────────────────
// MaskTurn.tokens() maps token → raw value, for the UI of the SAME turn to render the value the
// user is already entitled to see. It is never persisted, logged, put in a Workflow step result, or
// sent: JSON.stringify(turn) throws, and structuredClone(turn) carries nothing (the state lives in a
// module-private WeakMap, not on the instance). So the map lives only in the step that minted it.
//   ACROSS WORKFLOW STEPS (plan P2). A step that ends mid-turn keeps turn.counters() (per-label
// counts, content-free) in its state, and the next step resumes with new MaskTurn(counters). No
// number is then reused within the turn, so one token never names two people. The same value
// masked again after a resume gets a NEW number, so the loop tells the model that tokens are
// comparable only within one step; running all of a turn's rounds in one step keeps them all
// comparable. There is no inverse: the model cannot pass a token as a tool argument, so tools take
// the record's own key (ticketKey, duns, an internal id), never a masked identifier.
//   RENDERING. A token in model output is untrusted text: a prompt-injected tool result can make
// the model write `[CPF#2]` anywhere. A raw value may replace a token only for a token of the same
// turn and step, only in a plain text node shown to the user the route served, never in a URL, a
// link or image target, or an HTML attribute. After the step, rendering by pointer (plan P3) means
// re-reading the route under the viewer's own authority, never this map.
//
// ── LIMITS, FAIL CLOSED ──────────────────────────────────────────────────────────────────────
// The walk is linear and bounded: MASK_LIMITS caps depth, values visited and characters scanned
// (opts.limits may only lower them). Past a cap nothing is emitted raw: a too-deep container, and
// every value after the budget runs out, becomes TRUNCATED; an array gains one trailing TRUNCATED
// and an object a `"[TRUNCATED]": "[TRUNCATED]"` entry; a string that would overrun the budget is
// replaced WHOLE — never cut, since a cut could leave part of an identifier the scan never saw.
// For the same reason, mask FIRST and truncate for the context window AFTER. Values JSON cannot
// hold follow JSON.stringify (undefined and functions dropped from objects, null in arrays, NaN
// null, a Date its ISO string, masked like any string), except that a Map, a class instance or a
// bigint becomes OMITTED: their string forms are not their data.

import {
  classifyKey,
  DETECTORS,
  type Detector,
  exactKey,
  type KeyRule,
  MASK_LABELS,
  type MaskLabel,
  type MaskRule,
  stripSeparators,
  wholeIdentifier,
} from './maskVocabulary';

export {
  cnpjCheckDigits,
  cpfCheckDigits,
  cuitCheckDigit,
  curpCheckDigit,
  MASK_LABELS,
  MASK_TOKEN_PATTERN,
  type MaskLabel,
  rucCheckDigit,
  rutCheckDigit,
} from './maskVocabulary';

/** A JSON value — what maskToolResult returns. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Stands in for anything past a limit. Not token-shaped: it names no value. */
export const TRUNCATED = '[TRUNCATED]';
/** Stands in for a value JSON has no faithful form for (Map, class instance, bigint). */
export const OMITTED = '[OMITTED]';

export interface MaskLimits {
  /** Containers nested deeper than this become TRUNCATED. */
  readonly maxDepth: number;
  /** Values (containers and primitives) visited per call. */
  readonly maxNodes: number;
  /** Characters of string content (object keys included) scanned per call. */
  readonly maxChars: number;
}

/** The ceilings. Sized well above any tool result the context window can hold. */
export const MASK_LIMITS: MaskLimits = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxChars: 1_000_000,
});

export interface MaskOptions {
  /**
   * Field names a DPO-signed egressRuling lets through RAW (PIA C3). Matched against a key exactly
   * but case-, accent- and separator-insensitively (`birthDate` allows `birth_date` and
   * `BIRTHDATE`, not `principalBirthDate`; `cpf2` allows `cpf_2`, not `cpf`). The whole subtree
   * under an allowed key is copied unmasked — the value layer included — so allow the narrowest
   * field the ruling names. Anything but an array of field names throws.
   */
  readonly allowRaw?: readonly string[];
  /**
   * Field names under which this route's data holds a person's identifier or identity attribute
   * and the built-in lists do not (a fork's `taxId` holding persons' bare RUTs). Matched like
   * allowRaw. The value is always masked: under the key's built-in label if it has one (a
   * person-or-company key losing its company exemption; a placeholder still passes), otherwise as
   * ID whatever it holds (`Casado`, `N/A`: no placeholder passes, since its values need not be
   * digits). It only ever masks more. A field named in both lists, or anything but an array of
   * field names, throws.
   */
  readonly identityKeys?: readonly string[];
  /** The turn's token table. Pass the same one for every tool result of a turn; omitted = fresh. */
  readonly turn?: MaskTurn;
  /** Lower limits for this call. A value above MASK_LIMITS is clamped to it, never raised. */
  readonly limits?: Partial<MaskLimits>;
}

export interface MaskResult {
  readonly value: JsonValue;
  readonly turn: MaskTurn;
  /** Replacements made by this call (content-free; a metric, never a value). */
  readonly masked: number;
  /** True when a limit cut anything. The loop tells the model the result is incomplete. */
  readonly truncated: boolean;
}

// ── Turn state ───────────────────────────────────────────────────────────────────────────────

interface TurnState {
  readonly tokenByValue: Map<string, string>;
  readonly rawByToken: Map<string, JsonValue>;
  readonly count: Map<MaskLabel, number>;
}

// Module-private, keyed by the instance: nothing on the object itself can be serialized or cloned.
const TURNS = new WeakMap<MaskTurn, TurnState>();

function stateOf(turn: MaskTurn): TurnState {
  const state = TURNS.get(turn);
  if (!state) throw new TypeError('mask: opts.turn must be a MaskTurn');
  return state;
}

/** How many tokens a turn has minted per label. Content-free: a Workflow step may carry it. */
export type MaskCounters = Readonly<Partial<Record<MaskLabel, number>>>;

const LABELS: ReadonlySet<string> = new Set(MASK_LABELS);

function readCounters(resume: MaskCounters | undefined): Map<MaskLabel, number> {
  const count = new Map<MaskLabel, number>();
  if (resume === undefined) return count;
  // Counters that cannot be trusted would restart a label at #1 and reuse its numbers.
  const bad = new TypeError('mask: MaskTurn counters map a MaskLabel to a non-negative integer');
  if (typeof resume !== 'object' || resume === null || Array.isArray(resume)) throw bad;
  for (const [label, n] of Object.entries(resume)) {
    if (!LABELS.has(label) || !Number.isSafeInteger(n) || (n as number) < 0) throw bad;
    count.set(label as MaskLabel, n as number);
  }
  return count;
}

/** One turn's token table: raw value ↔ token. In memory only — see the module header. */
export class MaskTurn {
  /**
   * A new turn; or, given the counters() of the same turn's previous Workflow step, that turn
   * resumed: numbering continues, so no token is reused within the turn. The map does not travel,
   * so a value masked in an earlier step gets a new number.
   */
  constructor(resume?: MaskCounters) {
    TURNS.set(this, {
      tokenByValue: new Map(),
      rawByToken: new Map(),
      count: readCounters(resume),
    });
  }

  /** Tokens minted per label so far: no value, no token map. A frozen snapshot. */
  counters(): MaskCounters {
    return Object.freeze(Object.fromEntries(stateOf(this).count));
  }

  /** Distinct values masked so far this turn. */
  get size(): number {
    return stateOf(this).rawByToken.size;
  }

  /** token → raw value (a frozen copy), for the UI of this turn. A snapshot: edits do nothing. */
  tokens(): ReadonlyMap<string, JsonValue> {
    return new Map(stateOf(this).rawByToken);
  }

  /** Refuses serialization: the raw identifiers must never be persisted or sent. */
  toJSON(): never {
    throw new TypeError('mask: a MaskTurn holds raw identifiers and is never serialized');
  }
}

function deepFreeze(value: JsonValue): JsonValue {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function mint(ctx: Ctx, label: MaskLabel, canonical: string, raw: JsonValue): string {
  const state = stateOf(ctx.turn);
  const key = `${label}\u0000${canonical}`;
  ctx.masked++;
  const known = state.tokenByValue.get(key);
  if (known) return known;
  const n = (state.count.get(label) ?? 0) + 1;
  state.count.set(label, n);
  const token = `[${label}#${n}]`;
  state.tokenByValue.set(key, token);
  state.rawByToken.set(token, deepFreeze(raw));
  return token;
}

// ── Value layer (the detectors live in ./maskVocabulary) ─────────────────────────────────────

const TOKEN_LITERAL = new RegExp(`\\[((?:${MASK_LABELS.join('|')})#[0-9]+)\\]`, 'g');

/** Rewrites token-shaped literals so every token in a result is one this module minted. */
function neutralize(s: string): string {
  return s.includes('#') ? s.replace(TOKEN_LITERAL, '($1)') : s;
}

/** One valid identifier in a string: [start, end), and the detector's rank in DETECTORS. */
interface Hit {
  readonly start: number;
  readonly end: number;
  readonly rank: number;
  readonly label: MaskLabel;
  readonly canonical: string;
}

function collectValid(s: string, det: Detector, rank: number, hits: Hit[]): void {
  const re = det.scan;
  re.lastIndex = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const canonical = det.canonical(m[0]);
    if (canonical === null) {
      // Not valid: retry one character on, so an overlapping valid candidate is still seen.
      re.lastIndex = m.index + 1;
      continue;
    }
    const end = m.index + m[0].length;
    hits.push({ start: m.index, end, rank, label: det.label, canonical });
  }
}

/**
 * The value layer over one string. Budget is spent by the caller. Every detector reads the
 * ORIGINAL string, and the union of the valid spans is masked: were each to read what the one
 * before had left, a grouped RFC (`NASC 850312 123`) could take the first group of a dotted CPF
 * after it and leave the other eight digits for no detector to see. Where two ids overlap, each
 * keeps its own token, side by side (`[RFC#1][CPF#1]`); a span inside another is the outer one,
 * and the same span read by two detectors is named by the earlier one, as wholeIdentifier does.
 */
function scanText(s: string, ctx: Ctx): string {
  const text = neutralize(s);
  if (!/[0-9]/.test(text)) return text; // every detector needs digits
  const hits: Hit[] = [];
  for (let rank = 0; rank < DETECTORS.length; rank++) {
    collectValid(text, DETECTORS[rank]!, rank, hits);
  }
  if (hits.length === 0) return text;
  hits.sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank);
  let out = '';
  let covered = 0; // text before this is emitted or masked
  for (const hit of hits) {
    if (hit.end <= covered) continue; // inside an id already masked
    if (hit.start > covered) out += text.slice(covered, hit.start);
    out += mint(ctx, hit.label, hit.canonical, text.slice(hit.start, hit.end));
    covered = hit.end;
  }
  return out + text.slice(covered);
}

// ── The walk ─────────────────────────────────────────────────────────────────────────────────

interface Ctx {
  readonly turn: MaskTurn;
  readonly allowRaw: ReadonlySet<string>;
  readonly identityKeys: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly keyRules: Map<string, KeyRule | null>;
  nodes: number;
  chars: number;
  exhausted: boolean;
  truncated: boolean;
  masked: number;
}

// Returned for a value JSON drops from an object (undefined, a function, a symbol).
const DROP = Symbol('drop'); // a const Symbol() is already a unique symbol type
type Walked = JsonValue | typeof DROP;

function exhaust(ctx: Ctx): string {
  ctx.exhausted = true;
  ctx.truncated = true;
  return TRUNCATED;
}

/** Is there budget for one more value? Exhausts the walk when there is not. */
function hasNodes(ctx: Ctx): boolean {
  if (ctx.exhausted) return false;
  if (ctx.nodes <= 0) {
    exhaust(ctx);
    return false;
  }
  return true;
}

function spendNode(ctx: Ctx): boolean {
  if (!hasNodes(ctx)) return false;
  ctx.nodes--;
  return true;
}

// Every caller has just passed hasNodes / spendNode, which already refuses an exhausted walk.
function spendChars(ctx: Ctx, n: number): boolean {
  if (n > ctx.chars) {
    exhaust(ctx);
    return false;
  }
  ctx.chars -= n;
  return true;
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function setOwn(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  // A `__proto__` key from JSON.parse is an own property; plain assignment would set the prototype.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function ruleFor(key: string, ctx: Ctx): KeyRule | null {
  let rule = ctx.keyRules.get(key);
  if (rule === undefined) {
    rule = classifyKey(key, ctx.allowRaw, ctx.identityKeys);
    ctx.keyRules.set(key, rule);
  }
  return rule;
}

/** Masks (raw = false) or copies (raw = true) one value. Every path spends budget. */
function walk(value: unknown, depth: number, ctx: Ctx, raw: boolean): Walked {
  if (!spendNode(ctx)) return TRUNCATED;
  switch (typeof value) {
    case 'string':
      return walkString(value, depth, ctx, raw);
    case 'number':
      if (!Number.isFinite(value)) return null;
      return raw ? value : maskNumber(value, ctx);
    case 'boolean':
      return value;
    case 'bigint':
      return OMITTED;
    case 'object':
      if (value === null) return null;
      if (depth >= ctx.maxDepth) {
        ctx.truncated = true;
        return TRUNCATED;
      }
      if (Array.isArray(value)) {
        return walkArray(value, (item) => walk(item, depth + 1, ctx, raw), ctx);
      }
      if (value instanceof Date) {
        // What JSON.stringify sends (Date#toJSON): the ISO string, or null for an invalid date.
        const time = value.getTime();
        return Number.isNaN(time)
          ? null
          : walkString(new Date(time).toISOString(), depth, ctx, raw);
      }
      if (!isPlainObject(value)) return OMITTED;
      return walkObject(value, depth, ctx, raw);
    default:
      return DROP; // undefined, function, symbol
  }
}

/**
 * A string. One that serializes a JSON object or array (a payload serialized before it was masked,
 * a TEXT column holding JSON) is parsed and masked as the value it is, since only then does the key
 * layer see its keys, and is serialized again. Anything else is scanned by value.
 */
function walkString(s: string, depth: number, ctx: Ctx, raw: boolean): JsonValue {
  if (!spendChars(ctx, s.length)) return TRUNCATED;
  if (raw) return neutralize(s);
  const parsed = parseContainer(s);
  if (parsed === undefined) return scanText(s, ctx);
  // Its content is the string's child: one level deeper, and paid for again from the same budget.
  const inner = walk(parsed, depth + 1, ctx, false);
  return inner === TRUNCATED ? TRUNCATED : JSON.stringify(inner);
}

/** The object or array a string is the JSON of, or undefined when it is not exactly one. */
function parseContainer(s: string): object | undefined {
  const t = s.trim();
  const ends = `${t.at(0)}${t.at(-1)}`;
  if (ends !== '{}' && ends !== '[]') return undefined;
  try {
    return JSON.parse(t) as object;
  } catch {
    return undefined;
  }
}

function maskNumber(value: number, ctx: Ctx): JsonValue {
  // An id stored as a number: only a safe 11-digit integer (CPF, CUIT, RUC). Shorter integers are
  // left alone — a leading-zero CPF stored as a number is 10 digits, like a Unix timestamp.
  if (!Number.isSafeInteger(value) || value < 1e10 || value >= 1e11) return value;
  const id = wholeIdentifier(String(value));
  return id ? mint(ctx, id.label, id.canonical, value) : value;
}

function walkArray(
  items: readonly unknown[],
  each: (item: unknown) => Walked,
  ctx: Ctx,
): JsonValue[] {
  const out: JsonValue[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!hasNodes(ctx)) {
      out.push(TRUNCATED);
      break;
    }
    const v = each(items[i]);
    out.push(v === DROP ? null : v);
  }
  return out;
}

function walkObject(
  obj: Record<string, unknown>,
  depth: number,
  ctx: Ctx,
  raw: boolean,
): JsonValue {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(obj)) {
    if (!hasNodes(ctx) || !spendChars(ctx, key.length)) {
      setOwn(out, TRUNCATED, TRUNCATED);
      break;
    }
    const child = obj[key];
    let v: Walked;
    let outKey: string;
    if (raw) {
      outKey = neutralize(key);
      v = walk(child, depth + 1, ctx, true);
    } else {
      // Keys are scanned by value too: `{ "123.456.789-09": … }` is an identifier.
      outKey = scanText(key, ctx);
      const rule = ruleFor(key, ctx);
      if (rule === null) v = walk(child, depth + 1, ctx, false);
      else if (rule.kind === 'raw') v = walk(child, depth + 1, ctx, true);
      else v = maskByKey(child, rule, depth + 1, ctx);
    }
    // Two keys can meet on one token (the same CPF written two ways); the later one wins — a lost
    // value, never a leaked one.
    if (v !== DROP) setOwn(out, outKey, v);
  }
  return out;
}

/** A value under an identity key: replaced whole, whatever it looks like. */
function maskByKey(value: unknown, rule: MaskRule, depth: number, ctx: Ctx): Walked {
  if (Array.isArray(value)) {
    if (!spendNode(ctx)) return TRUNCATED;
    if (depth >= ctx.maxDepth) {
      ctx.truncated = true;
      return TRUNCATED;
    }
    return walkArray(value, (item) => maskByKey(item, rule, depth + 1, ctx), ctx);
  }
  // A sanitized, bounded copy: it becomes the turn map's raw value, and is never emitted.
  const copy = walk(value, depth, ctx, true);
  if (copy === DROP || copy === null || typeof copy === 'boolean' || copy === '') return copy;
  // Nothing of the value survived a limit, or JSON has no form for it: there is nothing to mask.
  if (copy === TRUNCATED || copy === OMITTED) return copy;
  if (typeof copy === 'string' || typeof copy === 'number') {
    const text = String(copy);
    if (rule.kind === 'mixed' && rule.company(text.trim())) return copy;
    const id = wholeIdentifier(text) ?? keyedIdentifier(rule, text);
    if (id === null) return copy; // a placeholder
    return mint(ctx, id.label, id.canonical, copy);
  }
  return mint(ctx, rule.label, canonicalJson(copy), copy);
}

// The labels whose values are written in digits: an identifier, or a birth date.
const DIGIT_LABELS: ReadonlySet<MaskLabel> = new Set([
  'CPF',
  'RUT',
  'CURP',
  'RFC',
  'CUIT',
  'CUIL',
  'RUC',
  'DNI',
  'SSN',
  'PASSPORT',
  'ID',
  'DOB',
]);

/**
 * How a primitive under an identity key is tokenized when it is not a whole valid identifier, or
 * null for a placeholder. A digit-written value is keyed without its punctuation, so a number, a
 * bare string and a punctuated one are one token, and the value layer's form of the same id too; a
 * CPF key's 9-10 digit number is the CPF that lost its leading zeros. A placeholder (no digit,
 * `N/A`, `não informado`; or one digit repeated, `000.000.000-00`) carries no identifier, and one
 * shared token would tell the model that every record holding it is the same person. Not under
 * an anyValue rule (an identityKeys field the lists do not name): its values need not be digits,
 * so a birthplace or a marital status would pass for a placeholder. Every one of them is masked.
 */
function keyedIdentifier(
  rule: MaskRule,
  text: string,
): { label: MaskLabel; canonical: string } | null {
  const { label } = rule;
  if (!DIGIT_LABELS.has(label)) return { label, canonical: JSON.stringify(text) };
  const compact = stripSeparators(text);
  const hasDigit = /[0-9]/.test(compact);
  if (!hasDigit || /^([0-9])\1*$/.test(compact)) {
    if (rule.kind !== 'mask' || rule.anyValue !== true) return null;
    if (!hasDigit) return { label, canonical: JSON.stringify(text) };
  }
  if (label === 'CPF' && /^[0-9]{9,10}$/.test(compact)) {
    const padded = wholeIdentifier(compact.padStart(11, '0'));
    if (padded) return padded;
  }
  return { label, canonical: compact };
}

/** JSON with object keys sorted, so equal values get one token whatever their key order. */
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function resolveLimits(limits: Partial<MaskLimits> | undefined): MaskLimits {
  const pick = (name: keyof MaskLimits): number => {
    const given = limits?.[name];
    if (given === undefined) return MASK_LIMITS[name];
    if (!Number.isInteger(given) || given < 0) {
      throw new TypeError(`mask: limits.${name} must be a non-negative integer`);
    }
    return Math.min(given, MASK_LIMITS[name]);
  };
  return { maxDepth: pick('maxDepth'), maxNodes: pick('maxNodes'), maxChars: pick('maxChars') };
}

function resolveFields(
  fields: readonly string[] | undefined,
  what: 'allowRaw' | 'identityKeys',
): ReadonlySet<string> {
  const out = new Set<string>();
  if (fields === undefined) return out;
  // A string would be iterated letter by letter: every one-letter key named, and not the field.
  if (!Array.isArray(fields)) {
    throw new TypeError(`mask: ${what} must be an array of field names`);
  }
  for (const field of fields) {
    const n = typeof field === 'string' ? exactKey(field) : '';
    // A ruling names fields. An empty, wildcard or punctuation-only entry names nothing; refusing
    // it beats silently naming nothing — or, worse, a future matcher reading it as "everything".
    if (n === '') throw new TypeError(`mask: every ${what} entry must name a field`);
    out.add(n);
  }
  return out;
}

/**
 * Masks one tool result. Returns a new value (the input is never mutated) with every national
 * identifier and identity field replaced by a per-turn token, and the turn that maps tokens back.
 */
export function maskToolResult(value: unknown, opts: MaskOptions = {}): MaskResult {
  const limits = resolveLimits(opts.limits);
  const turn = opts.turn ?? new MaskTurn();
  stateOf(turn); // refuse anything but a MaskTurn before any work
  const allowRaw = resolveFields(opts.allowRaw, 'allowRaw');
  const identityKeys = resolveFields(opts.identityKeys, 'identityKeys');
  for (const field of identityKeys) {
    if (allowRaw.has(field)) throw new TypeError('mask: a field is both allowRaw and identityKeys');
  }
  const ctx: Ctx = {
    turn,
    allowRaw,
    identityKeys,
    maxDepth: limits.maxDepth,
    keyRules: new Map(),
    nodes: limits.maxNodes,
    chars: limits.maxChars,
    exhausted: false,
    truncated: false,
    masked: 0,
  };
  const out = walk(value, 0, ctx, false);
  return { value: out === DROP ? null : out, turn, masked: ctx.masked, truncated: ctx.truncated };
}
