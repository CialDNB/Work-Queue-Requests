#!/usr/bin/env node
// PreToolUse design-fidelity warning for PORTED apps (/port-ui, docs/DESIGN-PORT.md).
//
// An app ported from an existing product carries a design contract: `.paved-road/design.json`
// with `mode: "port"`. Its look lives in ONE place - the theme layer (`web/src/theme/` unless the
// contract says otherwise), copied from the source app. The way a port drifts back to the kit's
// default look, one screen at a time, is a page that hard-codes its own colour, font or remote
// asset instead of using the ported tokens and classes. This hook makes that visible at the moment
// it happens. Warn-only, like warn-protected-core: a raw value is sometimes right (an SVG stop, a
// one-off chart series), so it informs and never blocks.
//
// Silent unless ALL hold: a design.json with mode "port" is found above the edited file, the file
// is a style-bearing source file under web/src/ (or web/index.html), and the new content carries a
// finding. Outside the theme directory every finder runs: raw colour, font-family, remote asset.
// Inside the theme (and in web/index.html) raw colours and fonts are expected, but a remote asset
// is still wrong there: the CSP blocks it on staging and production, wherever it is written.
// Comments are ignored, and only literals the edit ADDS are reported, not ones already in the text
// it replaces: a hook that cries wolf is a hook the session learns to skip.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const STYLED = /\.(tsx|jsx|ts|js|css)$/;
const INDEX_HTML = 'web/index.html';
const REMOTE = 'remote font/image URL (the CSP blocks it; self-host under web/public/)';
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
// SVG/HTML attributes whose value is a colour (`fill="#bad"` is a colour, `href="#bad"` is not).
const COLOUR_ATTR =
  /\b(?:fill|stroke|color|stop-?[cC]olor|flood-?[cC]olor|lighting-?[cC]olor|bgcolor)\s*=\s*\{?\s*["'`]$/;

/**
 * Raw hex colours, in a VALUE position only. `#` plus hex digits is also an issue ref in prose
 * (`Order #1042`), a fragment link (`href={'#add'}`), a hash word (`scrollTo('#feed')`) and a CSS
 * id selector (`#fab {`), and each of those was reported as a colour, which teaches a session to
 * ignore the hook. So a hex counts when it follows `:` `=` `(` `,` or a quote, or sits inside a
 * declaration (`border: 1px solid #ddd`); a 3/4-letter all-letter hex that is not one repeated
 * letter (`#add`, `#feed`, not `#fff`) counts only in a declaration or a colour attribute; and in
 * CSS a hex whose line reaches `{` before `;` is a selector.
 */
function hexColours(text, lang) {
  const found = [];
  for (const m of text.matchAll(HEX)) {
    const hex = m[0];
    const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
    const lineEnd = text.indexOf('\n', m.index);
    const before = text.slice(lineStart, m.index);
    const after = text.slice(m.index + hex.length, lineEnd < 0 ? undefined : lineEnd);
    if (/[\w&#]$/.test(before)) continue; // part of a word, an HTML entity (&#1042;), ##
    if (/\b(?:href|to|id|for|xlink:href)\s*=\s*\{?\s*["'`]$/.test(before)) continue;
    if (lang === 'css' && /^[^;{}]*\{/.test(after)) continue; // `#fab {`, `.a:hover #fab .b {`
    const statement = before.slice(
      Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1,
    );
    const inDeclaration = statement.includes(':') || COLOUR_ATTR.test(before);
    const direct = /(?:[:=(,]\s*["'`]?|["'`])$/.test(before);
    const body = hex.slice(1);
    const hashWord = /^[a-fA-F]{3,4}$/.test(body) && !/^(.)\1+$/.test(body.toLowerCase());
    if (hashWord ? inDeclaration : inDeclaration || direct) found.push(hex);
  }
  return found;
}

// CSS named colours (CSS Color 4), minus the keywords that are not a colour of their own
// (transparent, currentColor, inherit...).
const NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);
// A colour-bearing property or attribute (`color:`, `backgroundColor:`, `border-left:`, `fill=`),
// never a custom property (`--color:`), and its value up to the end of the declaration.
const COLOUR_DECL =
  /(?:^|[^\w-])((?:background|border|outline|fill|stroke|color|caret|accent|text-?decoration|column-?rule|flood|lighting|stop|box-?shadow|text-?shadow)[\w-]*)\s*[:=]\s*\{?\s*["'`]?([^;}"'`\n]*)/gi;

/** Named colours (`color: white`, `fill="white"`, `border: 1px solid black`) in a colour value. */
function namedColours(text) {
  const found = [];
  for (const [, prop, value] of text.matchAll(COLOUR_DECL)) {
    // A token or an asset is not a named colour: var(--white), url(white.png).
    const bare = value.replace(/(?:var|url)\([^)]*\)/gi, ' ');
    const word = bare.match(/[a-z]+/gi)?.find((w) => NAMED_COLOURS.has(w.toLowerCase()));
    if (word) found.push(`${prop}: ${word}`);
  }
  return found;
}

/** Every match of `re` (its first group, else the whole match), as finder output. */
const byRegex = (re) => (text) => [...text.matchAll(re)].map((m) => m[1] ?? m[0]);

const FINDERS = [
  ['raw hex colour', hexColours],
  ['raw named colour', namedColours],
  // rgb()/hsl() and the modern functions (oklch(), lab(), hwb(), color(display-p3 ...)), with a
  // literal first argument: `rgb(var(--x))` is a token.
  [
    'raw rgb()/hsl()/oklch() colour',
    byRegex(
      /\b((?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[\d.][^)]*\)|color\(\s*(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)\b[^)]*\))/g,
    ),
  ],
  // A font stack of its own; token use (`var(--sans)`) and inherit-style keywords are fine.
  [
    'own font-family',
    byRegex(
      /((?:font-family|fontFamily)\s*:\s*(?!\s*['"`]?\s*(?:var\(|inherit|initial|unset|revert))[^;},\n]+)/g,
    ),
  ],
  // The `font:` shorthand names a family after the size (`font: 700 20px 'Inter'`); one that uses
  // a token anywhere (`font: 600 12px var(--sans)`) is fine, and so is `font: inherit`.
  [
    'own font (shorthand)',
    byRegex(
      /(?:^|[^\w-])(font\s*:\s*['"`]?(?![^;}\n]*var\()[^;}\n'"`]*\d(?:px|r?em|%|pt|vw|vh|ch)(?:\s*\/\s*[\w.%]+)?\s+['"`]?[A-Za-z][^;}\n'"`]*)/g,
    ),
  ],
  // Remote assets the CSP will block. Only asset positions: CSS url()/@import, and src/href on
  // img/source/link. An ordinary <a href="https://..."> or an SVG xmlns is not an asset.
  // A <script src> counts too: in web/index.html a CDN script is as blocked as a CDN font.
  [
    REMOTE,
    byRegex(
      /(url\(\s*['"]?https?:\/\/[^'")\s]+|@import\s+(?:url\()?\s*['"]?https?:\/\/[^'")\s;]+|<(?:img|source|link|script)\b[^>]*?\b(?:src|src[sS]et|href)=\{?["'`]https?:\/\/[^"'`\s]+)/g,
    ),
  ],
];

/**
 * `text` without comments (line, block and JSX block comments), so an issue ref or a colour in a
 * comment (`// (#144)`) is not drift. A `//` after `:` or `(` or a quote is a URL, not a comment.
 */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\(])\/\/[^\n]*/g, '$1');
}

/** The nearest `.paved-road/design.json` at or above `dir`, as `{ root, design }`, or null. */
export function findDesign(dir) {
  let cur = resolve(dir);
  for (;;) {
    const file = join(cur, '.paved-road', 'design.json');
    if (existsSync(file)) {
      try {
        return { root: cur, design: JSON.parse(readFileSync(file, 'utf8')) };
      } catch {
        return null; // An unreadable contract is not this hook's error to raise.
      }
    }
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/**
 * A repo-relative path from design.json, or `fallback`. design.json is written by whoever authored
 * the repo, and these values are echoed into the MODEL'S context (additionalContext), so only a
 * plain relative path survives: no spaces or prose (prompt injection), no `..`, no absolute path.
 */
export function safePath(value, fallback) {
  const v = typeof value === 'string' ? value.trim() : '';
  return /^(?!\/)(?!.*\.\.)[\w./-]{1,120}$/.test(v) ? v : fallback;
}

/** The text an Edit / Write / MultiEdit is about to put into the file. */
export function incomingText(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (typeof toolInput.content === 'string') return toolInput.content;
  if (typeof toolInput.new_string === 'string') return toolInput.new_string;
  if (Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((e) => (typeof e?.new_string === 'string' ? e.new_string : ''))
      .join('\n');
  }
  return '';
}

/**
 * `[{ kind, sample }]` for every drift finding in `text` (deduplicated, at most `limit`). `lang` is
 * 'css' for a stylesheet (where a hex before `{` is a selector), else 'js'.
 */
export function findDrift(text, finders = FINDERS, lang = 'js', limit = 6) {
  const out = [];
  const seen = new Set();
  const clean = stripComments(text);
  for (const [kind, find] of finders) {
    for (const found of find(clean, lang)) {
      const sample = found.trim().slice(0, 60);
      const key = `${kind}|${sample}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, sample });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * The text an Edit / Write / MultiEdit replaces: the file on disk for a Write, the old strings for
 * an Edit or MultiEdit. A literal already there is not new drift: re-reporting it (a Write that
 * wraps Login.tsx in .kit-page re-reported the Microsoft logo colours) is noise.
 */
export function replacedText(toolInput, absPath) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (typeof toolInput.content === 'string') {
    try {
      return readFileSync(absPath, 'utf8');
    } catch {
      return '';
    }
  }
  if (typeof toolInput.old_string === 'string') return toolInput.old_string;
  if (Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((e) => (typeof e?.old_string === 'string' ? e.old_string : ''))
      .join('\n');
  }
  return '';
}

/** A theme dir from design.json as `a/b/`: no `./`, no doubled or missing slashes. */
function themeDirOf(value) {
  const dir = posix.normalize(safePath(value, 'web/src/theme/')).replace(/^\.\//, '');
  return dir.replace(/\/?$/, '/');
}

/**
 * The warning for one tool call, or '' when the hook should stay silent. Pure, so the test drives
 * it without spawning a process.
 */
export function evaluate(input) {
  const filePath = String(input?.tool_input?.file_path ?? '');
  if (!filePath || !(STYLED.test(filePath) || filePath.endsWith('.html'))) return '';
  // Always resolve from the edited file's own directory, so a nested app in a monorepo finds its
  // own contract even when the session was opened at the repository root.
  const found = findDesign(dirname(resolve(filePath)));
  if (found?.design?.version !== 1 || found.design.mode !== 'port') return '';

  const rel = relative(found.root, resolve(filePath)).split(sep).join('/');
  const isIndex = rel === INDEX_HTML;
  if (!isIndex && !(rel.startsWith('web/src/') && STYLED.test(rel))) return '';
  const themeDir = themeDirOf(found.design.theme);
  const remoteOnly = isIndex || rel.startsWith(themeDir);

  const finders = remoteOnly ? FINDERS.filter(([kind]) => kind === REMOTE) : FINDERS;
  const lang = rel.endsWith('.css') ? 'css' : 'js';
  const had = new Set(
    findDrift(replacedText(input.tool_input, resolve(filePath)), finders, lang, Infinity).map(
      (d) => `${d.kind}|${d.sample}`,
    ),
  );
  const drift = findDrift(incomingText(input.tool_input), finders, lang, Infinity)
    .filter((d) => !had.has(`${d.kind}|${d.sample}`))
    .slice(0, 6);
  if (!drift.length) return '';
  const list = drift.map((d) => `${d.kind}: ${d.sample}`).join('; ');
  if (remoteOnly) {
    return (
      `⚠ Design drift (${rel}): ${list}. The CSP (web/public/_headers) blocks remote fonts, ` +
      'stylesheets, scripts and images on staging and production: self-host the file under ' +
      'web/public/ (fonts/, brand/) and point at it there. Never loosen _headers for it.'
    );
  }
  const contract = safePath(found.design.contract, 'docs/design/DESIGN-CONTRACT.md');
  return (
    `⚠ Design drift (${rel}): this app is a PORT and its look lives in ${themeDir} - ${list}. ` +
    `Use the ported tokens/classes (var(--...), the source's class names) instead; if the value is ` +
    `genuinely new, add it to the theme and record it in ${contract}.`
  );
}

/** Run as a CLI only (the test imports this module). Realpath both sides: a URL comparison breaks
 *  on paths with spaces or symlinks (see scripts/kit-checks/main-module.mjs for the full story). */
function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
}

if (isMain()) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const message = evaluate(input);
  if (message) {
    console.log(
      JSON.stringify({
        systemMessage: message,
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message },
      }),
    );
  }
  process.exit(0);
}
