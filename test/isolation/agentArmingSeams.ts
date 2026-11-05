// THE RULE BEHIND THE ARMING-SEAM FENCE (agent-arming-fences.test.ts runs it over the repo's own
// tree; src/ai/agentArming.ts; privacy must-fix 14). Pure: sources and resolution configs in,
// failures out. No I/O and no imports, so plain node can load it too (type stripping).
//
// It reads TEXT, not a bundle, so it is a tripwire, not a proof. What it does to be a hard one:
//
//   - NAMES are matched in every spelling JavaScript allows: any letter as a unicode, hex,
//     legacy-octal or identity escape, with line continuations anywhere, in code, strings or
//     comments alike.
//   - SPECIFIERS are read as LITERALS and cooked the way the language cooks them (every escape
//     form, CR/LF/LS/PS line continuations), from every quote in the file but an escaped one
//     inside an earlier literal of its kind, so no mis-read earlier in the file can hide a later
//     literal. (No literal opens right after a backslash: reading one at every `\'` only cost a
//     pass to the string's end each, and a long string of them ran the heap out.)
//   - A `+` CHAIN of literals is read as the one string esbuild folds it into, through
//     parentheses and the TypeScript esbuild strips first (`!`, `as T`, `satisfies T`, `<T>`, for
//     a T that is a name or a string type): `'./' + '../ai/' + n` globs src/ai, and
//     `'../ai/agentArm' + ('ing' as string)` names the module.
//   - The arming module may be named only where the kit names it: a named, default, type-only or
//     side-effect import, or a named re-export. A literal or chain naming it ANYWHERE else is
//     refused, so a parenthesized argument, a ?: / || / ?? / && branch esbuild folds,
//     `import x = require()` or `(require)()` need no rule of their own.
//   - A computed specifier (a template with a substitution, or a string joined with `+`) is
//     refused where esbuild globs it — directly in import()/require() (`require` in any spelling
//     an identifier allows, with or without type arguments), through parentheses, or in a
//     branch — when its static prefix, folded, can reach src/ai. A branch is refused wherever it
//     is (the rule does not ask whether the ?: sits inside a call), which no fleet source trips.
//   - ALIASES esbuild resolves are followed: package.json "imports", "exports" (a package
//     importing itself by name), "browser", and the "main", "module" or "browser" entry a
//     directory's own package.json gives it; tsconfig/jsconfig "paths" and "baseUrl", together
//     with those of every config one "extends"; and the wrangler "alias". Every config of each
//     kind counts, wherever it sits (a superset); a relative "extends" of a config the fence does
//     not read leaves aliases unknown, and fails closed.
//   - Every GAP (whitespace and comments) is read once per file into a table, each comment the
//     one way the language reads it, and every pattern reads its gaps from that table: no input
//     makes the scan read a comment twice, nor run a pattern back through one.
//   - Nothing scanned may import from a folder that is NOT scanned (UNSCANNED), relatively, by
//     an alias, or as a `file:`/`link:` dependency or workspace: a stub there would carry the
//     name past the scan. One exception, the root vitest config: it runs in node to set up the
//     test run, never in the Worker, and may import test/ (Insights' does) — so no other source
//     may import IT.
//
// Each reading was checked against esbuild 0.28.1, the bundler `wrangler deploy` runs, with the
// options wrangler passes (the .js/.mjs/.cjs files take the JSX loader); each has a fixture.

/** The seams' allow-lists: who may name `registerDsrRoute`, and who `armableEnvs`. */
export interface ArmingSeams {
  readonly dsrRegistrars: readonly string[];
  readonly ladderSeamOwners: readonly string[];
}

/**
 * Folders the scan does not read, from the repo root: dependencies, tests (their fixtures name the
 * seams on purpose), build output and nested checkouts — Claude Code's `.claude/worktrees`, and
 * `.worktrees`, where worktree tools put theirs (a nested checkout holds a whole copy of src/ and
 * test/, which would name every seam). A checkout nested anywhere else is scanned like any folder,
 * so keep worktrees in one of those two. A `**` entry is a folder of that name at any depth. The
 * fence's glob must exclude exactly these (pinned there).
 */
export const UNSCANNED: readonly string[] = [
  '**/node_modules',
  'test',
  '**/dist',
  'coverage',
  '.wrangler',
  '.git',
  '.claude/worktrees',
  '.worktrees',
];

/**
 * Every extension a specifier may end in and still reach a `.ts` file: esbuild rewrites a missing
 * `.js` or `.jsx` to `.ts`, so `x.jsx` names `x.ts` (checked on esbuild 0.28.1). `.tsx` is in too:
 * a superset costs nothing.
 */
const EXT = String.raw`(?:\.[cm]?[jt]sx?)?`;
/** The root test tooling that may import from test/ (vitest loads no `.jsx` or `.tsx` config). */
const TOOLING = /^vitest\.(?:config|workspace)(?:\.[cm]?[jt]s)?$/;
/** A resolved path that is that tooling, however the specifier spells its extension. */
const TOOLING_PATH = new RegExp(String.raw`^vitest\.(?:config|workspace)${EXT}$`);

/** The module's own folder, from the repo root: a computed specifier that can reach it is refused. */
const ARMING_DIR = 'src/ai';

/** One backslash, in a RegExp source. */
const BS = '\\\\';
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
/** ECMAScript's line terminators, for a character class: LF, CR, LS, PS. */
const LT = `\\n\\r${LS}${PS}`;

/** Not the tail of a longer word, nor a member name (`x.import`). */
const START = '(?<![\\w$.])';

/** A file the specifier names is the arming module (any case: a case-blind disk resolves it). */
const ARMING_FILE = new RegExp(String.raw`(?:^|[/\\])agentArming${EXT}(?:[?#][\s\S]*)?$`, 'i');
/** A resolved, repo-relative path that IS the arming module. */
const ARMING_PATH = new RegExp(String.raw`^src/ai/agentArming${EXT}(?:[?#][\s\S]*)?$`, 'i');
const RELATIVE = /^(?:\.\.?(?:[/\\]|$)|[/\\])/;

// ── characters ───────────────────────────────────────────────────────────────────────────────

/** RegExp `\s` (no `u` flag): WhiteSpace and LineTerminator. */
function isSpace(code: number): boolean {
  return (
    (code >= 9 && code <= 13) ||
    code === 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

const isLineEnd = (code: number) =>
  code === 10 || code === 13 || code === 0x2028 || code === 0x2029;

/** RegExp `\w` (no `u` flag), which `\b` reads. */
const isWord = (code: number) =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 95;

/**
 * Not a binding-name character: whitespace and the delimiters, and — since no name holds them —
 * every character a gap can start with (`/`, and the `<` of `<!--` and `-` of `-->`) and `!` and
 * `>`. So a name and the gap after it split ONE way. (A name that could swallow a gap's opener
 * let `import x<!--<!--…` be split at every opener, cubically: P2-2 round-2 review R2.)
 */
const ASCII_NAME = new Uint8Array(128);
for (let code = 0; code < 128; code += 1) {
  ASCII_NAME[code] =
    !isSpace(code) && !',{}()*;\'"`/=<>!-'.includes(String.fromCharCode(code)) ? 1 : 0;
}
const isNameChar = (code: number) => (code < 128 ? ASCII_NAME[code] === 1 : !isSpace(code));

// ── reading the gaps between tokens, once ────────────────────────────────────────────────────

/**
 * A file's text, with what its patterns read precomputed in one pass each, so no pattern reads a
 * gap or a name more than once however many times a match is tried there.
 */
interface Scan {
  readonly text: string;
  /**
   * From each index, where the gap starting there ends: whitespace, block comments (each to its
   * first `*\/`), and line comments opened by `//`, `<!--` or `-->` (each to its line's end, ANY
   * line terminator) — the legacy HTML forms esbuild honours outside a module. Each comment is read
   * the one way the language reads it, so a gap has ONE reading. Exact is enough: where the rule
   * reads a gap — between the tokens of an import or export clause, after `import`/`require`, a
   * parenthesis or a branch operator, around a `+` — code holds nothing but whitespace and
   * comments, and the language reads those exactly this way. (A looser reading split a run of
   * slashes exponentially many ways and took a `+` in a trailing comment for a join: round-1 P1.)
   */
  readonly loose: Int32Array;
  /**
   * The same without the HTML forms: the gap the allowed clauses read. Those forms are never legal
   * in a module, where import declarations live, so what an allowed clause lets through is what
   * the code says.
   */
  readonly tight: Int32Array;
  /** From each index, where the binding-name run starting there ends. */
  readonly nameEnd: Int32Array;
  /** At each index, the last index at or before it where `from` stands before a non-word (-1: none). */
  readonly fromAt: Int32Array;
  /** From each index, the first `{` or `}` at or after it (the text's length: none). */
  readonly brace: Int32Array;
}

function scan(text: string): Scan {
  const n = text.length;
  const nextLineEnd = new Int32Array(n + 1);
  const nextClose = new Int32Array(n + 2); // the first `*/` at or after each index (-1: none)
  const nameEnd = new Int32Array(n + 1);
  const brace = new Int32Array(n + 1);
  nextLineEnd[n] = n;
  nextClose[n] = -1;
  nextClose[n + 1] = -1;
  nameEnd[n] = n;
  brace[n] = n;
  const loose = new Int32Array(n + 1);
  const tight = new Int32Array(n + 1);
  loose[n] = n;
  tight[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    const c = text.charCodeAt(i);
    const d = text.charCodeAt(i + 1);
    nextLineEnd[i] = isLineEnd(c) ? i : (nextLineEnd[i + 1] as number);
    nextClose[i] = c === 42 && d === 47 ? i : (nextClose[i + 1] as number);
    const name = isNameChar(c);
    nameEnd[i] = name ? (nameEnd[i + 1] as number) : i;
    brace[i] = c === 123 || c === 125 ? i : (brace[i + 1] as number);
    let l = i;
    let t = i;
    if (name) {
      // a name character starts no gap
    } else if (isSpace(c)) {
      l = loose[i + 1] as number;
      t = tight[i + 1] as number;
    } else if (c === 47 && d === 42) {
      const close = nextClose[i + 2] as number; // a block comment ends at its FIRST `*/`
      if (close >= 0) {
        l = loose[close + 2] as number;
        t = tight[close + 2] as number;
      }
    } else if (c === 47 && d === 47) {
      l = loose[nextLineEnd[i] as number] as number;
      t = tight[nextLineEnd[i] as number] as number;
    } else if (
      (c === 60 && text.startsWith('!--', i + 1)) ||
      (c === 45 && d === 45 && text.charCodeAt(i + 2) === 62)
    ) {
      l = loose[nextLineEnd[i] as number] as number;
    }
    loose[i] = l;
    tight[i] = t;
  }
  const fromAt = new Int32Array(n + 1);
  for (let i = 0, last = -1; i <= n; i += 1) {
    if (text.charCodeAt(i) === 102 && text.startsWith('rom', i + 1)) {
      if (!isWord(text.charCodeAt(i + 4))) last = i;
    }
    fromAt[i] = last;
  }
  return { text, loose, tight, nameEnd, fromAt, brace };
}

/**
 * Whether each index sits behind a comment opener earlier on its line (an allowed clause there is
 * not code). One pass: the first opener on a line also ends first, so it alone decides.
 */
function commentedOut(text: string): Uint8Array {
  const behind = new Uint8Array(text.length + 1);
  let opened = Number.POSITIVE_INFINITY; // where the line's first opener ends
  for (let i = 0; i <= text.length; i += 1) {
    behind[i] = opened <= i ? 1 : 0;
    const c = text.charCodeAt(i);
    if (isLineEnd(c)) opened = Number.POSITIVE_INFINITY;
    else if (opened === Number.POSITIVE_INFINITY && (c === 47 || c === 60 || c === 45)) {
      if (text.startsWith('//', i)) opened = i + 2;
      else if (text.startsWith('<!--', i)) opened = i + 4;
      else if (text.startsWith('-->', i)) opened = i + 3;
    }
  }
  return behind;
}

// ── the clauses, read by hand over those tables ──────────────────────────────────────────────

/** What a step leaves to the rest of a pattern: the match's end from `at`, or -1. */
type Next = (at: number) => number;
/** One piece of a pattern, tried at `at` the way a RegExp tries it: greedy, then backtracking. */
type Step = (s: Scan, at: number, next: Next) => number;

const seq = (...steps: Step[]): Step => {
  const run = (s: Scan, i: number, at: number, next: Next): number =>
    i === steps.length ? next(at) : (steps[i] as Step)(s, at, (to) => run(s, i + 1, to, next));
  return (s, at, next) => run(s, 0, at, next);
};
const opt =
  (step: Step): Step =>
  (s, at, next) => {
    const taken = step(s, at, next);
    return taken >= 0 ? taken : next(at);
  };
const char =
  (c: string): Step =>
  (s, at, next) =>
    s.text[at] === c ? next(at + 1) : -1;
/** `word` and the `\b` after it. */
const keyword =
  (word: string): Step =>
  (s, at, next) =>
    s.text.startsWith(word, at) && !isWord(s.text.charCodeAt(at + word.length))
      ? next(at + word.length)
      : -1;
/** A gap: one reading, so the longest (what follows a gap never starts like one). */
const GAP: Step = (s, at, next) => next(s.loose[at] as number);
const TIGHT: Step = (s, at, next) => next(s.tight[at] as number);
/**
 * A binding name, loosely: anything up to a delimiter (escapes and non-ASCII included). Longest
 * first; a shorter one is followed by a name character, which no gap starts with, and of what the
 * clauses put after a name (a gap, then `,` or `from`) only `from` can stand there.
 */
const NAME: Step = (s, at, next) => {
  const end = s.nameEnd[at] as number;
  if (end === at) return -1;
  const whole = next(end);
  if (whole >= 0) return whole;
  for (let j = s.fromAt[end - 1] as number; j > at; j = s.fromAt[j - 1] as number) {
    const split = next(j);
    if (split >= 0) return split;
  }
  return -1;
};
/** `{ … }` with no brace inside. */
const BRACES: Step = (s, at, next) => {
  if (s.text[at] !== '{') return -1;
  const close = s.brace[at + 1] as number;
  return s.text[close] === '}' ? next(close + 1) : -1;
};
const TYPE = keyword('type');
const AS = keyword('as');
const FROM = keyword('from');
const STAR = char('*');
const COMMA = char(',');

const IMPORT_AT = new RegExp(`${START}import`, 'g');
const EXPORT_AT = new RegExp(`${START}export`, 'g');

/** Where a literal may name the arming module: each of these ends right before the literal. */
const ALLOWED: readonly (readonly [RegExp, Step])[] = [
  [IMPORT_AT, seq(TIGHT, opt(seq(TYPE, TIGHT)), NAME, TIGHT, FROM, TIGHT)],
  [
    IMPORT_AT,
    seq(
      TIGHT,
      opt(seq(TYPE, TIGHT)),
      opt(seq(NAME, TIGHT, COMMA, TIGHT)),
      BRACES,
      TIGHT,
      FROM,
      TIGHT,
    ),
  ],
  [IMPORT_AT, seq(TIGHT, TYPE, TIGHT, STAR, TIGHT, AS, TIGHT, NAME, TIGHT, FROM, TIGHT)],
  [EXPORT_AT, seq(TIGHT, opt(seq(TYPE, TIGHT)), BRACES, TIGHT, FROM, TIGHT)],
  [EXPORT_AT, seq(TIGHT, TYPE, TIGHT, STAR, TIGHT, opt(seq(AS, TIGHT, NAME, TIGHT)), FROM, TIGHT)],
  [IMPORT_AT, TIGHT],
];
const NAMESPACE = seq(
  GAP,
  opt(seq(NAME, GAP, COMMA, GAP)),
  STAR,
  GAP,
  AS,
  GAP,
  NAME,
  GAP,
  FROM,
  GAP,
);
const EXPORT_ALL = seq(GAP, STAR, GAP, opt(seq(AS, GAP, NAME, GAP)), FROM, GAP);

/** Where each match of a clause ends, given where one can start (`first`, global). Matches do not
 * overlap: the next is looked for after the last one's end, as String.matchAll does. */
function ends(s: Scan, first: RegExp, rest: Step, keep?: (start: number) => boolean): Set<number> {
  const found = new Set<number>();
  first.lastIndex = 0;
  for (let m = first.exec(s.text); m !== null; m = first.exec(s.text)) {
    const end = rest(s, m.index + m[0].length, (to) => to);
    if (end < 0) {
      first.lastIndex = m.index + 1;
      continue;
    }
    if (keep === undefined || keep(m.index)) found.add(end);
    first.lastIndex = end;
  }
  return found;
}

// TypeScript esbuild strips before it folds or globs a specifier: a type that is a (dotted,
// generic, array) name or a string type, or a union or intersection of those.
const TYPE_ATOM = String.raw`(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^<>()]*>)?|'[^'\\\n\r]*'|"[^"\\\n\r]*")(?:\s*\[\s*\])*`;
const TS_TYPE = String.raw`${TYPE_ATOM}(?:\s*[|&]\s*${TYPE_ATOM})*`;
/** `as T` or `satisfies T` after an operand. */
const ASSERTION = new RegExp(String.raw`(?:as|satisfies)\b\s*${TS_TYPE}`, 'y');
/** `<T>` before an operand, or a call's type arguments. */
const CAST = new RegExp(String.raw`<\s*${TS_TYPE}\s*>`, 'y');

/** Past a `<T>` at `at`, and the gap after it; `at` itself when there is none. */
function pastCast(s: Scan, at: number): number {
  if (s.text[at] !== '<') return at;
  CAST.lastIndex = at;
  return CAST.test(s.text) ? (s.loose[CAST.lastIndex] as number) : at;
}

/** Past the `(`s and `<T>` casts that open an operand: where it starts, and how many `(`. */
function openers(s: Scan, at: number): [number, number] {
  let count = 0;
  for (let cast = pastCast(s, at); ; cast = pastCast(s, at)) {
    at = cast;
    if (s.text[at] !== '(') return [at, count];
    count += 1;
    at = s.loose[at + 1] as number;
  }
}

/** import( / require( (any identifier spelling of `require`), `(require)(`, type arguments, and
 * any parentheses after, up to the argument: [end, the parentheses after the call's own]. */
function callAt(s: Scan, at: number): [number, number] | null {
  at = pastCast(s, s.loose[at] as number);
  if (s.text[at] === ')') at = pastCast(s, s.loose[at + 1] as number);
  if (s.text[at] !== '(') return null;
  return openers(s, s.loose[at + 1] as number);
}

/** A branch esbuild resolves on its own: either side of ?:, or after a || ?? && it can fold. */
const BRANCH_AT = /\?\??|:|&&|\|\|/g;

interface Position {
  /** The parentheses opened between the call or operator and the literal. */
  readonly parens: number;
  /** A `require` call, not an `import()`. */
  readonly require: boolean;
}

/** Where each call (`first`: CALL_AT) or branch (BRANCH_AT) ends, as `ends` reads a clause. */
function positions(s: Scan, first: RegExp, call: boolean): Map<number, Position> {
  const found = new Map<number, Position>();
  first.lastIndex = 0;
  for (let m = first.exec(s.text); m !== null; m = first.exec(s.text)) {
    const after = m.index + m[0].length;
    const read = call ? callAt(s, after) : openers(s, s.loose[after] as number);
    if (read === null) {
      first.lastIndex = m.index + 1;
      continue;
    }
    found.set(read[0], { parens: read[1], require: call && m[1] === undefined });
    first.lastIndex = read[0];
  }
  return found;
}

// ── reading literals ─────────────────────────────────────────────────────────────────────────

/** A string or template literal, cooked. `computed`: a template that has a substitution. */
interface Literal {
  readonly start: number;
  readonly end: number;
  /** The cooked text — for a computed template, of its static prefix only. */
  readonly value: string;
  readonly computed: boolean;
}

const SINGLE: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

/** The escape at text[at] (a backslash), cooked: its value and the index after it. */
function cookEscape(text: string, at: number): [string, number] {
  const c = text[at + 1];
  if (c === undefined) return ['', at + 1];
  if (c === '\r') return ['', text[at + 2] === '\n' ? at + 3 : at + 2];
  if (c === '\n' || c === LS || c === PS) return ['', at + 2];
  const ahead = text.slice(at + 1, at + 16);
  if (c === 'u') {
    const m = /^u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/.exec(ahead);
    if (m) {
      const code = Number.parseInt(m[1] ?? m[2] ?? '', 16);
      return [code <= 0x10ffff ? String.fromCodePoint(code) : '', at + 1 + m[0].length];
    }
  }
  if (c === 'x') {
    const m = /^x([0-9a-fA-F]{2})/.exec(ahead);
    if (m) return [String.fromCharCode(Number.parseInt(m[1] ?? '', 16)), at + 1 + m[0].length];
  }
  const octal = /^(?:[0-3][0-7]{0,2}|[4-7][0-7]?)/.exec(ahead);
  if (octal) return [String.fromCharCode(Number.parseInt(octal[0], 8)), at + 1 + octal[0].length];
  const single = SINGLE[c];
  if (single !== undefined) return [single, at + 2];
  const point = String.fromCodePoint(text.codePointAt(at + 1) ?? 0);
  return [point, at + 1 + point.length]; // an identity escape
}

/**
 * The literal opened by the quote at text[at] (null when none is: a line ends a string), and the
 * index its reading stopped at: its closing quote, a template's `${`, the line end, or the end.
 */
function literalAt(text: string, at: number): [Literal | null, number] {
  const quote = text.charCodeAt(at);
  const template = quote === 96;
  let value = '';
  let run = at + 1; // where the characters not yet added to `value` start
  for (let i = at + 1; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (c === quote) {
      return [{ start: at, end: i + 1, value: value + text.slice(run, i), computed: false }, i];
    }
    if (c === 92) {
      const [cooked, next] = cookEscape(text, i);
      value += text.slice(run, i) + cooked;
      i = next;
      run = next;
    } else if (template && c === 36 && text.charCodeAt(i + 1) === 123) {
      return [{ start: at, end: i, value: value + text.slice(run, i), computed: true }, i];
    } else if (!template && (c === 10 || c === 13)) {
      return [null, i];
    } else i += 1;
  }
  return [null, text.length];
}

/**
 * A literal read from every quote — a closing quote read as an opener only adds readings — but
 * an escaped one inside an earlier literal of its own kind: that quote follows a backslash, where
 * no literal opens, and its reading would run to the same end as the literal around it. Every
 * character is so read once per quote kind.
 */
function literals(text: string): Literal[] {
  const found: Literal[] = [];
  const resume: Record<string, number> = { "'": 0, '"': 0, '`': 0 };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (c !== "'" && c !== '"' && c !== '`') continue;
    if (i < (resume[c] as number)) continue;
    const [literal, stop] = literalAt(text, i);
    resume[c] = stop;
    if (literal !== null) found.push(literal);
  }
  return found;
}

/** Is the literal ending at `end` joined with `+` (through any closing parentheses)? */
function joinedAt(s: Scan, end: number): boolean {
  let at = s.loose[end] as number;
  while (s.text[at] === ')') at = s.loose[at + 1] as number;
  return s.text[at] === '+' && s.text[at + 1] !== '+';
}

/** A `+` chain of literals: their cooked values, in order, as esbuild folds them. */
interface Chain {
  readonly values: readonly string[];
  /** A non-literal operand (or a template's substitution) follows: what is folded is a prefix. */
  readonly computed: boolean;
  /** It ends at something that may bind its last literal tighter than `+` (`.x`, `[i]`, `(…)`). */
  readonly open: boolean;
  /** The starts of the literals it read after the first (operands, and string types). */
  readonly continued: readonly number[];
}

/** What may follow a whole `+` chain: it ends there, its last literal an operand of its own. */
const CHAIN_END = new Set([...'),;]}:?|&^=<>!-']);

/**
 * The chain `head` starts, read through parentheses and TypeScript assertions. `allowance`: the
 * parentheses opened before the head that still belong to the expression (a call's or branch's);
 * a `)` beyond them closes something the head is inside, and ends the chain.
 */
function chainFrom(
  s: Scan,
  head: Literal,
  byStart: ReadonlyMap<number, Literal>,
  allowance: number,
): Chain {
  const values = [head.value];
  const continued: number[] = [];
  let literal = head;
  let depth = 0;
  for (;;) {
    if (literal.computed) return { values, computed: true, open: false, continued };
    let at = literal.end;
    for (;;) {
      at = s.loose[at] as number;
      const c = s.text[at];
      if (c === '!' && s.text[at + 1] !== '=') at += 1;
      else if (c === ')' && depth > -allowance) {
        depth -= 1;
        at += 1;
      } else if (c === 'a' || c === 's') {
        ASSERTION.lastIndex = at;
        if (!ASSERTION.test(s.text)) break;
        // A string type in it is read here, so it starts no chain of its own (else a run of
        // `as 'x'` would be re-read from each).
        for (let q = at; q < ASSERTION.lastIndex; q += 1) if (byStart.has(q)) continued.push(q);
        at = ASSERTION.lastIndex;
      } else break;
    }
    const c = s.text[at];
    if (c !== '+' || s.text[at + 1] === '+') {
      const open = c !== undefined && (!CHAIN_END.has(c) || (c === '?' && s.text[at + 1] === '.'));
      return { values, computed: false, open, continued };
    }
    const [operand, opened] = openers(s, s.loose[at + 1] as number);
    const next = byStart.get(operand);
    if (next === undefined) return { values, computed: true, open: false, continued };
    depth += opened;
    values.push(next.value);
    continued.push(operand);
    literal = next;
  }
}

/** A RegExp source for each letter of `name`, in every spelling a literal or identifier allows. */
function letterForms(name: string): string[] {
  const hex = (code: number, width: number) =>
    [...code.toString(16).padStart(width, '0')]
      .map((d) => (/[a-f]/.test(d) ? `[${d}${d.toUpperCase()}]` : d))
      .join('');
  return [...name].map((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    const forms = [ch, `${BS}u${hex(code, 4)}`, `${BS}u\\{0*${hex(code, 1)}\\}`];
    if (code < 0x100) forms.push(`${BS}x${hex(code, 2)}`, `${BS}${code.toString(8)}`);
    if (!'bfnrtvux0123456789'.includes(ch)) forms.push(`${BS}${ch}`);
    return `(?:${forms.join('|')})`;
  });
}

/**
 * A RegExp that finds the identifier `name` however a literal or identifier may spell it, line
 * continuations included. None is read before the first letter: one there leaves a line
 * terminator right before that letter, which the lookbehind accepts, so a match that starts AT the
 * letter exists whenever one starting earlier does — and a run of continuations is not re-read
 * from each backslash in it (P2-2 round-2 review R2).
 */
function spelled(name: string): RegExp {
  const continuation = `(?:${BS}(?:\\r\\n|[${LT}]))*`;
  return new RegExp(`(?<![\\w$])${letterForms(name).join(continuation)}${continuation}(?![\\w$])`);
}

const REGISTRAR_NAME = spelled('registerDsrRoute');
const LADDER_NAME = spelled('armableEnvs');
/** `import` (an escaped one is a syntax error; read anyway) or `require` (escapes allowed). */
const CALL_AT = new RegExp(
  `${START}(?:(${letterForms('import').join('')})|${letterForms('require').join('')})`,
  'g',
);

// ── paths and aliases ────────────────────────────────────────────────────────────────────────

/** `dir` joined with the relative `path`, normalized; null when it climbs out of the repo. */
function resolveIn(dir: string, path: string): string | null {
  const parts = dir === '' ? [] : dir.split('/');
  for (const segment of path.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

const dirOf = (rel: string) => rel.split('/').slice(0, -1).join('/');

/** The UNSCANNED folder `path` (repo-relative) lies in, or null. */
function unscannedFolder(path: string): string | null {
  const segments = path.split('/');
  for (const folder of UNSCANNED) {
    if (folder.startsWith('**/')) {
      if (segments.includes(folder.slice(3))) return folder;
    } else if (path === folder || path.startsWith(`${folder}/`)) return folder;
  }
  return null;
}

/** An alias esbuild resolves: `from` (one `*` at most) maps to `to`, relative to `base`. */
interface Alias {
  readonly from: string;
  readonly to: string;
  readonly base: string;
  /**
   * A wrangler alias also maps `from/sub` (`prefix`); a relative `browser` key maps a FILE
   * (`file`); a package.json's "main", "module" or "browser" entry maps its own DIRECTORY (`dir`),
   * which importing the directory resolves to. `file` and `dir` apply to a path already found.
   */
  readonly kind: 'pattern' | 'prefix' | 'file' | 'dir';
}

/** What `spec` resolves to through `alias`, repo-relative; null when the alias does not apply. */
function throughAlias(alias: Alias, spec: string): string | null {
  let target: string | null = null;
  const star = alias.from.indexOf('*');
  if (star >= 0) {
    const head = alias.from.slice(0, star);
    const tail = alias.from.slice(star + 1);
    if (spec.length >= head.length + tail.length && spec.startsWith(head) && spec.endsWith(tail)) {
      target = alias.to.replace('*', spec.slice(head.length, spec.length - tail.length));
    }
  } else if (spec === alias.from) target = alias.to;
  else if (alias.kind === 'prefix' && spec.startsWith(`${alias.from}/`)) {
    target = alias.to + spec.slice(alias.from.length);
  }
  return target === null ? null : resolveIn(alias.base, target);
}

const SOURCE_EXT = /\.[cm]?[jt]sx?$/;

/**
 * Every repo path `spec`, written in `rel`, may resolve to: relatively or through an alias, and
 * then whatever a path found resolves to in turn (a browser-remapped file, a directory's entry).
 */
function resolutions(rel: string, spec: string, aliases: readonly Alias[]): string[] {
  const found: string[] = [];
  if (RELATIVE.test(spec)) {
    const path = /^[/\\]/.test(spec) ? null : resolveIn(dirOf(rel), spec);
    if (path === null) return found;
    found.push(path);
  } else {
    for (const alias of aliases) {
      if (alias.kind === 'file' || alias.kind === 'dir') continue;
      const target = throughAlias(alias, spec);
      if (target !== null) found.push(target);
    }
  }
  for (let i = 0; i < found.length; i += 1) {
    const path = found[i] as string;
    const bare = path.replace(SOURCE_EXT, '');
    for (const alias of aliases) {
      const applies =
        alias.kind === 'file'
          ? alias.from.replace(SOURCE_EXT, '') === bare
          : alias.kind === 'dir' && (alias.from === path || alias.from === bare);
      if (!applies) continue;
      const target = resolveIn(alias.base, alias.to);
      if (target !== null && !found.includes(target)) found.push(target);
    }
  }
  return found;
}

/** JSON with comments and trailing commas (tsconfig, wrangler.jsonc), or undefined. */
function parseJsonc(text: string): unknown {
  const out: string[] = [];
  let comma = -1; // where in `out` the last significant token was a comma, else -1
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; ) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out.push(text.slice(i, j + 1));
      comma = -1;
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
    } else {
      if ((c === '}' || c === ']') && comma >= 0) out[comma] = '';
      if (c === ',') comma = out.length;
      else if (!/\s/.test(c)) comma = -1;
      out.push(c);
      i += 1;
    }
  }
  try {
    return JSON.parse(out.join(''));
  } catch {
    return undefined;
  }
}

/** Every string a package.json target (a string, an array, or a conditions object) can be. */
function targets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(targets);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(targets);
  return [];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The aliases every config declares, and a failure for each config it cannot read or trusts nothing of. */
function readConfigs(configs: Readonly<Record<string, string>>): {
  aliases: Alias[];
  failures: string[];
} {
  const aliases: Alias[] = [];
  const failures: string[] = [];
  /** tsconfig/jsconfig file → its compilerOptions, read after the others with what it extends. */
  const tsconfigs = new Map<string, { options: Record<string, unknown>; extends: string[] }>();
  for (const [file, text] of Object.entries(configs)) {
    const json = parseJsonc(text);
    if (!isObject(json)) {
      failures.push(`${file} cannot be read as JSON (with comments), so its aliases are unknown`);
      continue;
    }
    const base = dirOf(file);
    const name = file.split('/').pop() ?? '';
    if (name === 'package.json') {
      if (isObject(json.imports)) {
        for (const [from, to] of Object.entries(json.imports)) {
          for (const t of targets(to)) aliases.push({ from, to: t, base, kind: 'pattern' });
        }
      }
      if (typeof json.name === 'string' && json.exports !== undefined) {
        const map =
          isObject(json.exports) && Object.keys(json.exports).some((k) => k.startsWith('.'))
            ? json.exports
            : { '.': json.exports };
        for (const [key, to] of Object.entries(map)) {
          const from = json.name + (key === '.' ? '' : key.slice(1));
          for (const t of targets(to)) aliases.push({ from, to: t, base, kind: 'pattern' });
        }
      }
      if (isObject(json.browser)) {
        for (const [from, to] of Object.entries(json.browser)) {
          if (typeof to !== 'string') continue;
          const local = RELATIVE.test(from) ? resolveIn(base, from) : null;
          if (local !== null) aliases.push({ from: local, to, base, kind: 'file' });
          else aliases.push({ from, to, base, kind: 'prefix' });
        }
      }
      // The directory's own entry: an import of the directory resolves to it (esbuild reads
      // "browser", "module", "main" for wrangler's default platform; all three count).
      for (const field of ['browser', 'module', 'main']) {
        const to = json[field];
        if (typeof to === 'string') aliases.push({ from: base, to, base, kind: 'dir' });
      }
      for (const field of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        const deps = json[field];
        if (!isObject(deps)) continue;
        for (const [dep, version] of Object.entries(deps)) {
          const local =
            typeof version === 'string' ? /^(?:file|link|portal):(.*)$/.exec(version) : null;
          const path = local ? resolveIn(base, local[1] ?? '') : null;
          if (path !== null && unscannedFolder(path) !== null) {
            failures.push(
              `${file} links the dependency "${dep}" from a folder this fence does not scan`,
            );
          }
        }
      }
      const workspaces = isObject(json.workspaces) ? json.workspaces.packages : json.workspaces;
      for (const pattern of targets(workspaces)) {
        const path = resolveIn(base, pattern.replace(/\*[\s\S]*$/, ''));
        if (path !== null && unscannedFolder(path) !== null) {
          failures.push(
            `${file} makes "${pattern}" a workspace, from a folder this fence does not scan`,
          );
        }
      }
    } else if (/^[jt]sconfig/.test(name)) {
      tsconfigs.set(file, {
        options: isObject(json.compilerOptions) ? json.compilerOptions : {},
        extends: targets(json.extends),
      });
    } else {
      // A wrangler config: the top-level alias, and any an env block declares.
      const blocks = [json, ...(isObject(json.env) ? Object.values(json.env) : [])];
      for (const block of blocks) {
        if (!isObject(block) || !isObject(block.alias)) continue;
        for (const [from, to] of Object.entries(block.alias)) {
          if (typeof to === 'string') aliases.push({ from, to, base, kind: 'prefix' });
        }
      }
    }
  }
  // A tsconfig's paths resolve against the baseUrl it inherits, and an inherited paths against
  // its own baseUrl, so each config counts with every config it extends: each "paths" against
  // every baseUrl in that chain and its own folder (a superset), each baseUrl as a root. A
  // relative "extends" of a config the fence does not read hides aliases, so it fails closed; a
  // package name extends a dependency's own config, which is not read (like its code).
  for (const file of tsconfigs.keys()) {
    const chain: string[] = [];
    const visit = (config: string): void => {
      if (chain.includes(config)) return;
      chain.push(config);
      for (const target of tsconfigs.get(config)?.extends ?? []) {
        if (!RELATIVE.test(target)) continue;
        const path = /^[/\\]/.test(target) ? null : resolveIn(dirOf(config), target);
        const read =
          path === null
            ? undefined
            : [path, `${path}.json`, `${path}/tsconfig.json`].find((p) => tsconfigs.has(p));
        if (read !== undefined) visit(read);
        else {
          const where =
            path !== null && unscannedFolder(path) !== null
              ? 'in a folder this fence does not scan'
              : 'which this fence does not read';
          failures.push(
            `${config} extends ${JSON.stringify(target)}, ${where}, so its aliases are unknown`,
          );
        }
      }
    };
    visit(file);
    const roots: string[] = [];
    for (const config of chain) {
      const baseUrl = tsconfigs.get(config)?.options.baseUrl;
      const root = typeof baseUrl === 'string' ? resolveIn(dirOf(config), baseUrl) : null;
      if (root !== null && !roots.includes(root)) roots.push(root);
    }
    for (const root of roots) aliases.push({ from: '*', to: '*', base: root, kind: 'pattern' });
    for (const config of chain) {
      const paths = tsconfigs.get(config)?.options.paths;
      if (!isObject(paths)) continue;
      const bases = [...new Set([...roots, dirOf(config)])];
      for (const [from, to] of Object.entries(paths)) {
        for (const t of targets(to)) {
          for (const base of bases) aliases.push({ from, to: t, base, kind: 'pattern' });
        }
      }
    }
  }
  return { aliases, failures };
}

/** The folder a computed specifier's static `prefix` globs, repo-relative; null: out of the repo. */
function globbedFolder(rel: string, prefix: string): string | null | undefined {
  if (!/^\.\.?(?:\/|$)/.test(prefix)) return undefined; // not relative: left to run time
  const last = prefix.slice(prefix.lastIndexOf('/') + 1);
  const folder =
    last === '.' || last === '..' ? prefix : prefix.slice(0, prefix.length - last.length);
  return resolveIn(dirOf(rel), folder);
}

// ── the rule ─────────────────────────────────────────────────────────────────────────────────

/** Every file in `tree` (repo-relative path → text) that reaches a fenced seam, and why. */
export function armingSeamFailures(
  tree: Readonly<Record<string, string>>,
  configs: Readonly<Record<string, string>>,
  seams: ArmingSeams,
): string[] {
  const { aliases, failures: configFailures } = readConfigs(configs);
  const failures = new Set<string>(configFailures);
  for (const [rel, text] of Object.entries(tree)) {
    if (!seams.ladderSeamOwners.includes(rel) && LADDER_NAME.test(text)) {
      failures.add(`${rel} names the ladder seam armableEnvs`);
    }
    if (seams.dsrRegistrars.includes(rel)) continue;
    if (REGISTRAR_NAME.test(text)) failures.add(`${rel} names registerDsrRoute`);
    const tooling = TOOLING.test(rel);

    const s = scan(text);
    let behind: Uint8Array | undefined; // read on the first allowed clause
    const code = (start: number) => {
      behind ??= commentedOut(text);
      return behind[start] === 0;
    };
    const allowed = new Set<number>();
    for (const [first, rest] of ALLOWED)
      for (const at of ends(s, first, rest, code)) allowed.add(at);
    const namespace = ends(s, IMPORT_AT, NAMESPACE);
    const exportAll = ends(s, EXPORT_AT, EXPORT_ALL);
    const call = positions(s, CALL_AT, true);
    const branch = positions(s, BRANCH_AT, false);
    const kindOf = (at: number) =>
      call.get(at)?.require ? 'requires agentArming' : 'imports agentArming dynamically';

    /** What a literal — or a chain, read as the one literal esbuild folds it into — reaches. */
    const judge = (start: number, value: string, computed: boolean): void => {
      const specifier =
        allowed.has(start) || namespace.has(start) || exportAll.has(start) || call.has(start);
      // A specifier built at run time: what esbuild bundles is every file its prefix can match.
      const folder =
        computed && (call.has(start) || branch.has(start)) ? globbedFolder(rel, value) : undefined;
      if (
        folder === null ||
        folder === '' ||
        folder === ARMING_DIR ||
        (folder !== undefined && ARMING_DIR.startsWith(`${folder}/`))
      ) {
        failures.add(
          call.has(start)
            ? `${rel} ${kindOf(start)} through a computed specifier ${JSON.stringify(value)}`
            : `${rel} computes a specifier from ${JSON.stringify(value)} in a branch esbuild resolves, which can reach src/ai`,
        );
      } else if (folder !== undefined && !tooling && unscannedFolder(folder) !== null) {
        failures.add(
          `${rel} computes a specifier from ${JSON.stringify(value)}, which can reach a folder this fence does not scan`,
        );
      }
      const paths = resolutions(rel, value, aliases);
      const arming =
        (RELATIVE.test(value) && ARMING_FILE.test(value)) || paths.some((p) => ARMING_PATH.test(p));
      if (arming) {
        if (namespace.has(start)) failures.add(`${rel} imports agentArming as a namespace`);
        else if (exportAll.has(start)) failures.add(`${rel} re-exports all of agentArming`);
        else if (call.has(start)) failures.add(`${rel} ${kindOf(start)}`);
        else if (!allowed.has(start))
          failures.add(`${rel} names agentArming other than in a named import`);
      }
      if (computed || !specifier || tooling) return;
      if (paths.some((p) => unscannedFolder(p) !== null)) {
        failures.add(
          `${rel} imports ${JSON.stringify(value)}, from a folder this fence does not scan`,
        );
      }
      if (paths.some((p) => TOOLING_PATH.test(p))) {
        failures.add(
          `${rel} imports ${JSON.stringify(value)}, test tooling that may import what this fence does not scan`,
        );
      }
    };

    const all = literals(text);
    const byStart = new Map(all.map((literal) => [literal.start, literal]));
    const continued = new Set<number>();
    for (const literal of all) {
      const { start } = literal;
      const own = literal.computed || joinedAt(s, literal.end);
      judge(start, literal.value, own);
      const inCall = call.get(start);
      const inBranch = branch.get(start);
      if (continued.has(start) && inCall === undefined && inBranch === undefined) continue;
      // The chain this literal starts, folded: its whole value, and — when what ends it may bind
      // its last literal into a larger operand — the prefix before that literal, computed.
      const allowance = Math.max(inCall?.parens ?? 0, inBranch?.parens ?? 0);
      const chain = chainFrom(s, literal, byStart, allowance);
      for (const next of chain.continued) continued.add(next);
      if (chain.values.length > 1 || chain.computed !== own) {
        judge(start, chain.values.join(''), chain.computed);
      }
      if (chain.values.length > 1 && chain.open) {
        judge(start, chain.values.slice(0, -1).join(''), true);
      }
    }
  }
  return [...failures];
}
