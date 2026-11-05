// TRIPWIRE: every action the daily audit digest counts as sensitive is one this app writes.
//
// The digest (src/cron/auditAnomalyDigest.ts) counts an audit row when its `action` equals a
// SENSITIVE_ACTIONS entry, character for character. A name nothing writes matches no row, so the
// digest says nothing about it, every day, and nothing else notices. From the digest's first day
// (2026-07-03) until CialDNB/paved-road#256, the kit's list held `settings.update` and
// `user.remove`, which no code ever wrote, while the settings routes wrote
// `settings.alerting.update` and `settings.login.update`: a changed alert target or login policy
// never reached the digest.
//
// "Written" is read from two places:
//   1. the live route registry (`allRoutes`): each route's declared `audit:` verb, which the
//      framework writes after a successful handler (src/framework/execute.ts). A route that is
//      defined but not mounted writes nothing, so it does not count;
//   2. the app's own source under src/: the literal `action: '…'` of a direct audit insert (the
//      sign-in paths, `authz.denied`, the control-plane tripwire rows) and the literal first
//      argument of a handler's `ctx.audit('…')`. Comments are stripped first, wherever on a line
//      they start (a trailing `// …`, an inline or multi-line block comment), so a name that lives
//      on only in a comment does not count. The stripper is a small tokenizer that knows strings,
//      template literals and regex literals, so a `//` inside one of those is not a comment. The
//      digest's own file is skipped: the list cannot vouch for itself.
//
// Limits, stated plainly: an action built at run time, held in a constant, or written from outside
// src/ (a generated SQL file) is invisible here, so an entry naming one fails; write a sensitive
// action as a literal at its writer, or count it some other way. Any `action: '…'` literal under
// src/ counts as written, audit insert or not, so this is a floor: it catches a dead or misspelled
// name, not every wrong one. The tokenizer tells a regex literal from a division by the token
// before the `/`, as JavaScript does, but it has no grammar: a misread quoted string or regex ends
// at its line end, and a misread that leaves a template literal open fails the src/ check below.
//
// It lives in test/isolation/ because /kit-upgrade carries this directory to every fork, and a
// fork's own entries in SENSITIVE_ACTIONS are held to the same rule.
//
// Vite's `import.meta.glob` typing, as in test/helpers/db.ts (see the note there).
/// <reference types="vite/types/import-meta.d.ts" />
import { describe, expect, it } from 'vitest';
import { SENSITIVE_ACTIONS } from '../../src/cron/auditAnomalyDigest';
import { allRoutes } from '../../src/routes';

// Every module under src/, as text.
const SOURCES = import.meta.glob<string>(['../../src/**/*.ts', '../../src/**/*.mjs'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const DIGEST_FILE = '/src/cron/auditAnomalyDigest.ts';

// A direct audit insert's `action: '…'`, and a handler's `ctx.audit('…', …)`. A template literal
// with a `${}` in it is a run-time name, so `$` ends the match.
const DIRECT_WRITE = /\baction:\s*(['"`])([^'"`$\n]+)\1/g;
const HANDLER_WRITE = /\.audit\(\s*(['"`])([^'"`$\n]+)\1/g;

// Words after which a `/` opens a regex literal rather than dividing (`return /x/.test(s)`).
const REGEX_AFTER_WORD = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);
const WORD = /[\w$]+/y;

/**
 * Where the quoted string or regex literal opening at `start` ends (exclusive). A backslash
 * escapes the next character, and in a regex a `/` inside a `[…]` class does not close it. A
 * line end also ends it: neither may span lines, so a misread never runs past its own line.
 */
function literalEnd(source: string, start: number, regex: boolean): number {
  const close = source[start];
  let inClass = false;
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\n') return i;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (regex && c === '[') inClass = true;
    else if (regex && c === ']') inClass = false;
    else if (c === close && !inClass) return i + 1;
    i++;
  }
  return source.length;
}

/**
 * `source` with its comments removed, wherever on a line they start: a `// …` up to the line
 * end, and a block comment down to one space plus the line breaks it spanned. Strings, template
 * literals (with their `${…}` nesting) and regex literals are copied through untouched, so a `//`
 * in a URL or a quote in a regex is never taken for a comment or a string.
 *
 * A tokenizer, not a parser. A `/` opens a regex literal unless the token before it ends a value
 * (a name or number, `)`, `]`, a string, a template or a regex). That is how JavaScript itself
 * tells the two apart, short of a full grammar.
 */
function stripComments(source: string): { code: string; openTemplates: number } {
  let out = '';
  // Open template literals and the `${…}` expressions inside them, innermost last. An expression
  // counts the braces opened inside it, so only its own `}` returns to the template text.
  const stack: Array<{ kind: 'template' } | { kind: 'expr'; depth: number }> = [];
  let afterValue = false;
  let afterDot = false;
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    const top = stack.at(-1);
    if (top?.kind === 'template') {
      if (c === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '$' && source[i + 1] === '{') {
        stack.push({ kind: 'expr', depth: 0 });
        afterValue = false;
        out += '${';
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        afterValue = true;
      }
      out += c;
      i++;
      continue;
    }
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      out += ` ${source.slice(i, end).replace(/[^\n]/g, '')}`;
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || (c === '/' && !afterValue)) {
      const end = literalEnd(source, i, c === '/');
      out += source.slice(i, end);
      i = end;
      afterValue = true;
      afterDot = false;
      continue;
    }
    if (c === '`') {
      stack.push({ kind: 'template' });
      out += c;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      out += c;
      i++;
      continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(source)?.[0];
    if (word) {
      // A property named like a keyword (`x.return`) is a value too.
      afterValue = afterDot || !REGEX_AFTER_WORD.has(word);
      afterDot = false;
      out += word;
      i += word.length;
      continue;
    }
    if (top?.kind === 'expr' && c === '{') top.depth++;
    if (top?.kind === 'expr' && c === '}') {
      if (top.depth === 0) {
        stack.pop(); // back in the template's text
        out += c;
        i++;
        continue;
      }
      top.depth--;
    }
    afterValue = c === ')' || c === ']';
    afterDot = c === '.';
    out += c;
    i++;
  }
  // A template still open at the end means the scan lost its place (see the src/ check below).
  return { code: out, openTemplates: stack.filter((f) => f.kind === 'template').length };
}

/** The audit actions a source text writes as literals, comments stripped. */
function actionsWrittenIn(source: string): Set<string> {
  const { code } = stripComments(source);
  const found = new Set<string>();
  for (const pattern of [DIRECT_WRITE, HANDLER_WRITE]) {
    for (const match of code.matchAll(pattern)) found.add(match[2] as string);
  }
  return found;
}

/** Declared `audit:` verbs of the mounted routes. */
function declaredRouteActions(): Set<string> {
  return new Set(
    allRoutes.map(({ spec }) => spec.audit).filter((a): a is string => typeof a === 'string'),
  );
}

/** Literal audit writes anywhere under src/, except the digest's own list. */
function sourceActions(): Set<string> {
  const found = new Set<string>();
  for (const [path, source] of Object.entries(SOURCES)) {
    if (path.endsWith(DIGEST_FILE)) continue;
    for (const action of actionsWrittenIn(source)) found.add(action);
  }
  return found;
}

describe('SENSITIVE_ACTIONS ↔ what the app writes (vocabulary tripwire)', () => {
  it('names only actions a mounted route declares or a src/ module writes', () => {
    const written = new Set([...declaredRouteActions(), ...sourceActions()]);
    const unwritten = SENSITIVE_ACTIONS.filter((action) => !written.has(action));
    expect(
      unwritten,
      `SENSITIVE_ACTIONS (src/cron/auditAnomalyDigest.ts) names actions nothing in this app writes, so the daily digest can never count them. Spell each exactly as its writer does (a route's \`audit:\` verb, a direct insert's \`action:\`), or remove it`,
    ).toEqual([]);
  });

  it('lists each action once (a duplicate would print its digest line twice)', () => {
    const repeated = SENSITIVE_ACTIONS.filter((a, i) => SENSITIVE_ACTIONS.indexOf(a) !== i);
    expect(repeated).toEqual([]);
  });

  // If one source went blind (a moved folder, a reformatted writer), the test above would still
  // pass for every entry the other source happens to find. These hold each source on its own to
  // writers every fork carries unchanged.
  it('the source scan finds the protected core’s own direct writers', () => {
    expect(Object.keys(SOURCES).some((p) => p.endsWith(DIGEST_FILE))).toBe(true);
    const found = sourceActions();
    for (const action of ['login', 'magic_link_refused', 'authz.denied', 'audit_watch_error']) {
      expect(found.has(action), action).toBe(true);
    }
  });

  it('the route registry yields declared verbs', () => {
    expect(declaredRouteActions().size).toBeGreaterThan(0);
  });

  // The comment scanner keeps its place through every module: a template literal still open at
  // the end means it misread a quote, a regex or a backtick, and from there on it may have taken
  // a comment for text.
  it('the comment scanner ends every src/ module outside any template literal', () => {
    const lost = Object.entries(SOURCES)
      .filter(([, source]) => stripComments(source).openTemplates > 0)
      .map(([path]) => path);
    expect(lost).toEqual([]);
  });
});

describe('actionsWrittenIn — what counts as a written action (fixtures)', () => {
  it('reads direct inserts and ctx.audit() literals, including one split over lines', () => {
    const source = [
      "await db.audit.insert({ actor_email: who, action: 'fixture.direct', ip });",
      'await db.audit.insert({',
      '  actor_email: who,',
      '  action: "fixture.double_quoted",',
      '});',
      "await ctx.audit('fixture.extra', target, { n: 1 });",
      'await ctx.audit(',
      "  'fixture.split',",
      ');',
    ].join('\n');
    expect([...actionsWrittenIn(source)].sort()).toEqual([
      'fixture.direct',
      'fixture.double_quoted',
      'fixture.extra',
      'fixture.split',
    ]);
  });

  it('skips comment lines, run-time names and strings that are not audit writes', () => {
    const source = [
      "// action: 'fixture.line_comment'",
      '/**',
      " * The old name was action: 'fixture.block_comment'.",
      " * ctx.audit('fixture.doc_example')",
      ' */',
      "/* action: 'fixture.one_line_block' */",
      'await db.audit.insert({ actor_email: who, action: dynamicAction });',
      // A run-time name: the placeholder is escaped here so the fixture holds it as text.
      `await ctx.audit(\`fixture.\${kind}\`);`,
      "logEvent('fixture.log_event', { err });",
      "const ACTION = 'fixture.constant';",
      "audit: 'fixture.route_verb_in_source',",
    ].join('\n');
    expect([...actionsWrittenIn(source)]).toEqual([]);
  });

  // A name parked in a comment is not written, wherever on its line the comment starts.
  it('skips a trailing comment, an inline block comment and a block comment’s body', () => {
    const source = [
      "doWork(); // was ctx.audit('fixture.trailing_line_comment')",
      "doWork(); /* action: 'fixture.inline_block' */ doMore();",
      '/*',
      "  await db.audit.insert({ actor_email: who, action: 'fixture.block_body' });",
      "  await ctx.audit('fixture.block_body_handler');",
      '*/',
      'doWork(); /* parked until the export ships:',
      "  await ctx.audit('fixture.block_opened_after_code');",
      '*/',
      // A division, not a regex: the `/*` after it opens a comment.
      "const ratio = done / total; /* ctx.audit('fixture.after_division') */",
      // Inside a template's `${…}`, after a nested `}`, a comment is still a comment.
      `const s = \`\${fn({ a: 1 }) /* ctx.audit('fixture.in_template_expression') */}\`;`,
    ].join('\n');
    expect([...actionsWrittenIn(source)]).toEqual([]);
  });

  // A `/` after a value divides, so the `//` or `/*` after it still opens a comment. Read as a
  // regex instead, the `/` would swallow the comment's opening slash and leave its text as code.
  it('skips a comment after a division by a call, an index, a keyword-named property, a string or a template', () => {
    const source = [
      "const pct = Math.round(n * 100) / total; // was ctx.audit('fixture.after_paren_division')",
      "const r = arr[0] / 2; /* ctx.audit('fixture.after_bracket_division') */",
      // A property named like a keyword (`new`, `in`, `return`) is a value, not the keyword.
      "const share = counts.new / counts.total; // was ctx.audit('fixture.after_keyword_property')",
      // Plain JS, as an .mjs module may hold: a string or a template, then a division.
      "const half = '10' / 2; // ctx.audit('fixture.after_string_division')",
      "const third = `30` / 3; // ctx.audit('fixture.after_template_division')",
    ].join('\n');
    expect([...actionsWrittenIn(source)]).toEqual([]);
  });

  it('skips a comment after an escaped backtick, and on the line after a misread literal', () => {
    const source = [
      // An escaped backtick does not close the template, so the `//` after the real close is a
      // comment.
      "const t = `a\\` b`; // ctx.audit('fixture.after_escaped_backtick')",
      // The tokenizer reads a division after a postfix `!` as a regex, and a regex after
      // `if (…)` as a division, which leaves the regex's quote to open a string. Either misread
      // ends at its line end, so the next line's comment is still a comment.
      'const half = total! / 2;',
      "// ctx.audit('fixture.after_misread_regex')",
      "if (ok) /'/.test(s) && f();",
      "// ctx.audit('fixture.after_misread_quote')",
    ].join('\n');
    expect([...actionsWrittenIn(source)]).toEqual([]);
  });

  // The other side: comment-like text inside a string, a template or a regex is code, and so is
  // the write after it.
  it('reads a write after a block comment, a URL, a template or a regex on the same line', () => {
    const source = [
      "/* why */ await ctx.audit('fixture.after_block_comment');",
      "const url = 'https://x.example/a'; await ctx.audit('fixture.after_url');",
      `const t = \`see https://x.example/\${id} // text\`; await ctx.audit('fixture.after_template');`,
      // `/*` inside a regex: once escaped, once in a `[…]` class, once after a keyword.
      "const re = /^https?:\\/\\/*/; await ctx.audit('fixture.after_regex');",
      "const cls = /[/]\\/*x/; await ctx.audit('fixture.after_regex_class');",
      "return /\\/*/.test(s) && ctx.audit('fixture.after_keyword_regex');",
      // A `${` starts an expression, so a regex can open right after it, even in a template's
      // second expression, where the token before it was the first expression's value.
      `const p = \`\${a}\${/\\//.test(b)}\`; await ctx.audit('fixture.after_regex_in_template');`,
      // The `}` that closes a `${…}` holding braces of its own returns to the template's text, so
      // the `//` after it is text.
      `const u = \`\${scheme({ tls: true })}://x.example\`; await ctx.audit('fixture.after_nested_braces');`,
      // A keyword after a property on the line before (no semicolon) is still a keyword.
      'const done = job.finished',
      "return /\\//.test(url) && ctx.audit('fixture.after_keyword_after_property');",
    ].join('\n');
    expect([...actionsWrittenIn(source)].sort()).toEqual([
      'fixture.after_block_comment',
      'fixture.after_keyword_after_property',
      'fixture.after_keyword_regex',
      'fixture.after_nested_braces',
      'fixture.after_regex',
      'fixture.after_regex_class',
      'fixture.after_regex_in_template',
      'fixture.after_template',
      'fixture.after_url',
    ]);
  });
});

describe('stripComments — its output', () => {
  it('drops a line comment up to its line end and leaves a block comment as one space plus its line breaks', () => {
    expect(stripComments('a/* x\ny */b // c\nd').code).toBe('a \nb \nd');
  });

  // The src/ check above trusts this count: it is how a scan that lost its place shows.
  it('counts each template still open at the end, not the expressions inside them', () => {
    expect(stripComments('const t = `open').openTemplates).toBe(1);
    expect(stripComments('const t = `a${b').openTemplates).toBe(1);
    expect(stripComments('const t = `a${`b').openTemplates).toBe(2);
    expect(stripComments(`const t = \`a\${\`b\`}c\`;`).openTemplates).toBe(0);
  });
});
