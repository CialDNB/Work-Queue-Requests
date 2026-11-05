#!/usr/bin/env node
// Which pipeline delivers this app. Every CIAL provision and deploy path asks this one reader.
//
//   node scripts/deployment-target.mjs                  # print the target
//   node scripts/deployment-target.mjs --require cial   # exit 1 unless the target is CIAL
//   node scripts/deployment-target.mjs --github-output  # Actions: write cial=true|false
//   ...                                  --root <dir>   # read another checkout instead of .
//
// The targets:
//   cial            The CIAL pipeline: this repo's provision and deploy workflows and its laptop
//                   deploy and D1 scripts, on the CIAL Cloudflare account. Every app built before
//                   the DB Israel target existed is CIAL, with no marker.
//   dbisrael        DB Israel central delivery. A merge to main asks the central pipeline
//                   (CialDNB/il-paved-road-deployment) to build and release the app. The app holds
//                   no Cloudflare token, and every CIAL provision and deploy path refuses it.
//   unbootstrapped  In GitHub Actions only: wrangler.jsonc still carries the template's name in a
//                   repository that is not the kit's. That is a repository created from the
//                   template whose bootstrap PR has not merged, and its tree still holds the kit's
//                   own staging ids, so the CIAL jobs skip (or refuse) until it does.
//
// THE MARKER is .paved-road/deployment.json, exactly { "version": 1, "deploymentTarget": "<t>" }
// with <t> one of cial | dbisrael. This file is the only one that spells the path: the bootstrap
// renames the template's name in the files it lists, so a copy of the path there would become
// .<app>/ and find nothing, and anywhere else the residual scan flags it. Future versions keep
// accepting version 1; an unknown version is an error.
//
// IT FAILS CLOSED. Each of these is an error, and every guard goes red on it:
//   - an invalid marker: a symlink (the file or its folder), not a regular file, over 1 KB,
//     unparseable JSON, missing or extra keys, a key written twice (JSON.parse would keep the
//     last), a wrong type, or an unknown version or value;
//   - no marker in a tree that shows a sign of a DB Israel app: a release caller at the current
//     or the legacy path, a dbisrael.ai host among the parsed values of either wrangler config, or
//     docs/CENTRAL-DELIVERY.md. Deleting the marker must never turn the CIAL paths back on, so an
//     app that is dual-delivered (the CIAL pipeline stays live beside the caller) says so with a
//     "cial" marker.
// No marker and no sign is CIAL: every existing fork, unchanged.
//
// --github-output writes cial=true for a CIAL target and cial=false for dbisrael or
// unbootstrapped, and on an error writes nothing and exits 1, so a job that needs this one's
// success and `cial == 'true'` cannot ship on a guard that broke. In a DB Israel app it is also an
// error when DEPLOY_ENABLED is on or a CLOUDFLARE_API_TOKEN secret is visible (the calling step
// passes both as booleans, CREDENTIAL_ENV): they belong to the CIAL pipeline, and a DB Israel app
// must not hold them.
//
// It also holds the release caller central accepts, byte for byte, and the hashes of the callers
// the kit accepts (ACCEPTED_CALLER_SHA256). The kit never installs the caller in its own
// workflows; a DB Israel app gets it at generation (scripts/new-app.mjs --target dbisrael). And it
// holds the kit's offline approximation of central's workflow audit (enrollmentProblems,
// repoEnrollmentProblems), which verify:bootstrap runs on an app with a caller.
//
// Node built-ins and new-app.mjs (itself built-in only) are its whole dependency set, so a guard
// job runs it straight after checkout, with no `npm ci` and no token. A kit self-reference
// (SELF_REFERENCE_FILES in src/platform/bootstrap.ts), so the rename never touches it.
// See docs/DECISIONS.md 2026-10-27, "deployment-target reader".
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isMainModule } from './kit-checks/main-module.mjs';
import { KIT_REPOSITORY, parseJsonc, TEMPLATE_KEBAB } from './new-app.mjs';

export const MARKER_PATH = '.paved-road/deployment.json';
const MARKER_DIR = '.paved-road';
export const MARKER_VERSION = 1;
export const MARKER_MAX_BYTES = 1024;
export const TARGETS = Object.freeze(['cial', 'dbisrael']);

// Where central looks for the caller, now and during its migration from the legacy name
// (central catalog/platform.json `notifier.caller_path` and `legacy_callers`).
export const CALLER_PATH = '.github/workflows/il-paved-road-release.yml';
export const LEGACY_CALLER_PATH = '.github/workflows/paved-road-release.yml';
export const CENTRAL_DELIVERY_DOC = 'docs/CENTRAL-DELIVERY.md';
const WRANGLER_CONFIGS = ['wrangler.jsonc', 'wrangler.staging.jsonc'];
// A dbisrael.ai host or address: the name, not part of a longer label (dbisrael.co.il, the Entra
// tenant's mail domain, is no sign).
const DB_ISRAEL_HOST = /(?<![a-z0-9-])dbisrael\.ai(?![a-z0-9-])/i;

// The environment the ci.yml guard step sets, each to the string 'true' or 'false': whether
// DEPLOY_ENABLED is on, and whether a CLOUDFLARE_API_TOKEN secret is visible (never its value).
export const CREDENTIAL_ENV = Object.freeze({
  deployEnabled: 'DEPLOY_ENABLED_IS_TRUE',
  cloudflare: 'CLOUDFLARE_API_TOKEN_IS_SET',
});

// The release caller, verbatim from central's docs/onboarding-and-releases.md (the
// `accepted-app-caller` block; the doc was docs/APP-REPOSITORY-INTEGRATION.md, the name its first
// line still carries on purpose) at CialDNB/il-paved-road-deployment f7eba76: 13 lines, LF, one
// final newline, 507 bytes. An array of lines, not a template literal, because `${{` would
// interpolate. Line 1 is 103 characters: no editor or formatter may wrap it.
const CALLER_LINES = [
  '# Central delivery request (docs: CialDNB/il-paved-road-deployment/docs/APP-REPOSITORY-INTEGRATION.md).',
  '# Managed by the platform; changes are blocked by the repository workflow-path ruleset.',
  'name: il-paved-road-release',
  'on:',
  '  push:',
  '    branches: [main]',
  "    tags: ['production/*']",
  'permissions: {}',
  'jobs:',
  '  notify:',
  '    uses: CialDNB/il-paved-road-deployment/.github/workflows/request-release.yml@main',
  '    secrets:',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, verbatim.
  '      IL_PAVEDROAD_TRIGGER_APP_PRIVATE_KEY: ${{ secrets.IL_PAVEDROAD_TRIGGER_APP_PRIVATE_KEY }}',
];
export const CALLER_TEXT = `${CALLER_LINES.join('\n')}\n`;

// The callers the kit accepts, as sha256 after CRLF becomes LF (central normalizes the same way
// before it compares: approvedCaller() and classifyWorkflow() in src/delivery/controls.ts). When
// central changes its block, a kit PR adds the new hash and generates it; an old hash stays while
// central still accepts it, so enrolled apps stay green. Updating an enrolled app's caller is an
// org-admin job.
export const ACCEPTED_CALLER_SHA256 = Object.freeze([
  '47c9caffc3ea213617010e2e8fa197078c69a34a6de0071c28a02b807551dee1',
]);

/** sha256 of a caller's text, CRLF read as LF. */
export function callerSha256(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Whether `text` is a caller the kit accepts. */
export function isAcceptedCaller(text) {
  return ACCEPTED_CALLER_SHA256.includes(callerSha256(text));
}

// ── An offline approximation of central's workflow audit ─────────────────────────────────────
// classifyWorkflow() in src/delivery/controls.ts of the central DB Israel deployment repository,
// which reads each workflow with the YAML subset of its src/shared/yaml.ts. Enrollment refuses an
// app while any workflow on any ref could reach the shared trigger secret, or is written outside
// that subset. THIS IS NOT LIVE ENFORCEMENT: central runs its own code over every branch and tag,
// and its verdict is the one that counts. test/platform/workflow-enrollment-safety.test.mjs runs it
// over the kit's workflows and proves each rule fires, and `verify:bootstrap` runs it on an app
// with a caller. The trigger secret names are built from parts (gitleaks scans every branch).
const WORKFLOWS = '.github/workflows';

// The trigger secret, current and retired (central catalog/platform.json `trigger_app`).
export const TRIGGER_SECRETS = Object.freeze(
  [
    ['IL', 'PAVEDROAD', 'TRIGGER', 'APP', 'PRIVATE', 'KEY'],
    ['PAVEDROAD', 'TRIGGER', 'APP', 'PRIVATE', 'KEY'],
  ].map((parts) => parts.join('_')),
);
// The central notifier the caller calls, read from the caller itself.
export const NOTIFIER = /\/([\w.-]+\.ya?ml)@/.exec(CALLER_TEXT)[1].toLowerCase();

/** Risks inside each ${{ }}: the secrets context read whole or by index, an open expression. */
function expressionProblems(text) {
  const problems = [];
  let i = 0;
  for (;;) {
    const open = text.indexOf('${{', i);
    if (open < 0) break;
    const close = text.indexOf('}}', open + 3);
    if (close < 0) {
      problems.push('an unterminated ${{ expression');
      break;
    }
    const body = text.slice(open + 3, close);
    for (const m of body.matchAll(/(^|[^A-Za-z0-9_.-])secrets(?![A-Za-z0-9_-])/gi)) {
      const after = body.slice(m.index + m[0].length);
      if (!/^\s*\.\s*[A-Za-z_][A-Za-z0-9_-]*/.test(after)) {
        problems.push(`the secrets context read whole or by index in \${{${body.trim()}}}`);
      }
    }
    i = close + 2;
  }
  return problems;
}

// A block-mapping line's key and value: a double- or single-quoted key, or a plain one up to the
// first `:` that ends the line or has a space after it.
const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'][\s\S]*?):(?:\s+([\s\S]*))?$/;
const PLAIN_KEY = /^(?:[A-Za-z0-9_.-]+|"(?:[^"\\]|\\.)*")$/;
const cutComment = (value) => value.replace(/(^|\s)#.*$/, '').trim();

/** What a value or a sequence item starts with that the subset refuses. */
function nodeProblems(value, at, item) {
  if (/^[&*!]/.test(value)) return [`${at}: an anchor, alias or tag (${value})`];
  if (/^[%@`]/.test(value)) return [`${at}: a reserved indicator (${value})`];
  if (item && /^[|>]/.test(value)) return [`${at}: a block scalar as a sequence item`];
  if (value.startsWith('{') && value !== '{}') return [`${at}: a non-empty flow mapping`];
  return [];
}

/** Where the text leaves the YAML subset central's audit reads, line by line. */
function subsetProblems(text) {
  const problems = [];
  let block = -1; // a block scalar's content is indented past this column
  text.split('\n').forEach((raw, index) => {
    const at = `line ${index + 1}`;
    if (/^\t| \t|\t /.test(raw) || /^\s*\t/.test(raw)) problems.push(`${at}: a tab`);
    const indent = raw.length - raw.trimStart().length;
    if (block !== -1) {
      if (raw.trim() === '' || indent > block) return;
      block = -1;
    }
    if (/^(---|\.\.\.)(\s|$)/.test(raw)) problems.push(`${at}: a second YAML document`);
    let rest = raw.trim();
    if (rest === '' || rest.startsWith('#')) return;
    let column = indent;
    let item = false;
    while (/^-(\s|$)/.test(rest)) {
      const next = rest.replace(/^-\s*/, '');
      column += rest.length - next.length;
      rest = next;
      item = true;
    }
    if (rest === '') return;
    const entry = KEY_LINE.exec(rest);
    if (!entry) {
      problems.push(...nodeProblems(cutComment(rest), at, item));
      return;
    }
    const [, key, raw2 = ''] = entry;
    if (key.startsWith("'")) problems.push(`${at}: a single-quoted key (${key})`);
    else if (!PLAIN_KEY.test(key)) problems.push(`${at}: a key outside the subset (${key})`);
    if (/^secrets$/i.test(key) && /^inherit$/i.test(cutComment(raw2))) {
      problems.push(`${at}: secrets: inherit`);
    }
    const value = cutComment(raw2);
    if (/^[|>]/.test(value)) {
      if (/^[|>][-+]?$/.test(value)) block = column;
      else problems.push(`${at}: a block scalar header outside the subset (${value})`);
      return;
    }
    problems.push(...nodeProblems(value, at, false));
  });
  return problems;
}

/** Why central's audit would refuse this workflow file, approximately; [] for none. */
export function enrollmentProblems(text, path) {
  const t = text.replace(/\r\n/g, '\n');
  if (path === CALLER_PATH && isAcceptedCaller(t)) return [];
  const problems = [];
  const low = t.toLowerCase();
  for (const name of TRIGGER_SECRETS) {
    if (low.includes(name.toLowerCase())) problems.push(`names ${name}`);
  }
  if (low.includes(NOTIFIER)) problems.push('names the central notifier outside the caller');
  return [...problems, ...expressionProblems(t), ...subsetProblems(t)];
}

/** Every problem in a repository's .github/workflows, by path; [] for none. */
export function repoEnrollmentProblems(root = '.') {
  const dir = join(root, WORKFLOWS);
  if (!existsSync(dir)) return [];
  const problems = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${WORKFLOWS}/${entry.name}`;
    if (entry.isDirectory()) problems.push(`${path}: a directory under ${WORKFLOWS}`);
    else if (/\.ya?ml$/.test(entry.name)) {
      for (const p of enrollmentProblems(readFileSync(join(dir, entry.name), 'utf8'), path)) {
        problems.push(`${path}: ${p}`);
      }
    }
  }
  if (existsSync(join(root, CALLER_PATH)) && existsSync(join(root, LEGACY_CALLER_PATH))) {
    problems.push('two release callers: remove the legacy one in the change that adds the current');
  }
  return problems;
}

const FIX =
  'Write the marker: { "version": 1, "deploymentTarget": "cial" } if the CIAL pipeline stays ' +
  `live (dual delivery), or "dbisrael" otherwise, in ${MARKER_PATH}.`;

/** lstat, or null when nothing is at `path`. Any other failure is thrown. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * How many keys valid JSON `text` writes, at any depth, a repeated one counted each time. Each
 * match takes a whole string (in valid JSON every `"` outside a string opens one), and a string
 * followed by `:` is a key. JSON.parse keeps only the last of two equal keys, which may be spelled
 * differently ("T" and its \u escape), so a marker that shows "dbisrael" could read as "cial".
 */
function writtenKeys(text) {
  let keys = 0;
  for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"(\s*:)?/g)) if (m[1] !== undefined) keys++;
  return keys;
}

/**
 * The marker under `root`: { state: 'missing' }, { state: 'valid', target }, or
 * { state: 'invalid', reason }.
 */
export function readMarker(root = '.') {
  const path = join(root, MARKER_PATH);
  const invalid = (reason) => ({ state: 'invalid', reason });
  let st;
  let folder;
  try {
    st = lstatOrNull(path);
    folder = st === null ? null : lstatOrNull(join(root, MARKER_DIR));
  } catch (err) {
    return invalid(`cannot be read (${err?.code ?? err})`);
  }
  if (st === null) return { state: 'missing' };
  if (st.isSymbolicLink()) return invalid('is a symlink; it must be a regular file');
  if (folder?.isSymbolicLink()) return invalid(`sits in a symlinked ${MARKER_DIR}/ folder`);
  if (!st.isFile()) return invalid('is not a regular file');
  if (st.size > MARKER_MAX_BYTES) {
    return invalid(`is ${st.size} bytes, over the ${MARKER_MAX_BYTES}-byte limit`);
  }
  let text;
  let value;
  try {
    text = readFileSync(path, 'utf8');
    value = JSON.parse(text);
  } catch {
    return invalid('is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('is not a JSON object');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'deploymentTarget' || keys[1] !== 'version') {
    return invalid(
      `must hold exactly "version" and "deploymentTarget" (it holds ${JSON.stringify(keys)})`,
    );
  }
  const written = writtenKeys(text);
  if (written !== 2) {
    return invalid(
      `writes ${written} keys: JSON keeps only the last of two equal keys, so each of "version" ` +
        'and "deploymentTarget" must be written once, and nothing else',
    );
  }
  if (typeof value.version !== 'number') return invalid('has a "version" that is not a number');
  if (value.version !== MARKER_VERSION) {
    return invalid(`has version ${value.version}; this kit reads version ${MARKER_VERSION}`);
  }
  if (typeof value.deploymentTarget !== 'string') {
    return invalid('has a "deploymentTarget" that is not a string');
  }
  if (!TARGETS.includes(value.deploymentTarget)) {
    return invalid(
      `names deploymentTarget ${JSON.stringify(value.deploymentTarget)}; it must be one of ${TARGETS.join(', ')}`,
    );
  }
  return { state: 'valid', target: value.deploymentTarget };
}

/** The first string under `value` that names a dbisrael.ai host, or null. */
function dbIsraelValue(value) {
  if (typeof value === 'string') return DB_ISRAEL_HOST.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = dbIsraelValue(item);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') return dbIsraelValue(Object.values(value));
  return null;
}

/** The signs of a DB Israel app under `root`, as phrases for a message; [] when there are none. */
export function israelSignals(root = '.') {
  const found = [];
  for (const path of [CALLER_PATH, LEGACY_CALLER_PATH]) {
    if (lstatOrNull(join(root, path)) !== null) found.push(`a release caller at ${path}`);
  }
  for (const config of WRANGLER_CONFIGS) {
    let text;
    try {
      text = readFileSync(join(root, config), 'utf8');
    } catch {
      continue;
    }
    // Parsed values only, so a comment is no sign. A config this parser cannot read is searched
    // as text instead, which can only find more.
    const parsed = parseJsonc(text);
    const hit =
      parsed === null ? (DB_ISRAEL_HOST.test(text) ? 'its text' : null) : dbIsraelValue(parsed);
    if (hit !== null) found.push(`a dbisrael.ai value in ${config} (${hit})`);
  }
  if (lstatOrNull(join(root, CENTRAL_DELIVERY_DOC)) !== null) found.push(CENTRAL_DELIVERY_DOC);
  return found;
}

/** Whether this is a template copy in Actions whose bootstrap has not merged (see the header). */
function unbootstrapped(root, env) {
  if (env.GITHUB_ACTIONS !== 'true') return false;
  let name;
  try {
    name = parseJsonc(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))?.name;
  } catch {
    return false;
  }
  const repository = String(env.GITHUB_REPOSITORY ?? '').toLowerCase();
  return name === TEMPLATE_KEBAB && repository !== KIT_REPOSITORY.toLowerCase();
}

/**
 * The deployment target of the tree at `root`: { target } (cial, dbisrael or unbootstrapped), or
 * { error } with the message to show.
 */
export function resolveDeploymentTarget({ root = '.', env = process.env } = {}) {
  const marker = readMarker(root);
  if (marker.state === 'invalid') return { error: `${MARKER_PATH} ${marker.reason}. ${FIX}` };
  if (marker.state === 'missing') {
    const signals = israelSignals(root);
    if (signals.length > 0) {
      return {
        error:
          `There is no ${MARKER_PATH}, but this tree shows signs of a DB Israel app: ` +
          `${signals.join('; ')}. ${FIX}`,
      };
    }
  }
  if (marker.state === 'valid' && marker.target === 'dbisrael') return { target: 'dbisrael' };
  if (unbootstrapped(root, env)) return { target: 'unbootstrapped' };
  return { target: 'cial' };
}

/** Why a CIAL provision or deploy path refuses `resolution`, or null for a CIAL target. */
export function cialRefusal(resolution, where = '') {
  const at = where ? ` (${where})` : '';
  if (resolution.error) return resolution.error;
  if (resolution.target === 'dbisrael') {
    return (
      `This is a DB Israel app${at}: ${MARKER_PATH} says "dbisrael". The central DB Israel ` +
      'pipeline delivers it, so the CIAL provision and deploy paths refuse to run.'
    );
  }
  if (resolution.target === 'unbootstrapped') {
    return (
      `This repository has not been bootstrapped${at}: wrangler.jsonc still names the template, ` +
      "and the tree still carries the kit's own staging ids. Merge the bootstrap PR " +
      '(node scripts/new-app.mjs <name>) first; until then the CIAL provision and deploy paths ' +
      'refuse to run.'
    );
  }
  return null;
}

/** Why a DB Israel app's guard fails on the credentials `env` reports (CREDENTIAL_ENV), or []. */
export function credentialProblems(env = process.env) {
  const problems = [];
  if (env[CREDENTIAL_ENV.deployEnabled] === 'true') {
    problems.push(
      'DEPLOY_ENABLED is "true": remove it; this is a DB Israel app, delivered centrally.',
    );
  }
  if (env[CREDENTIAL_ENV.cloudflare] === 'true') {
    problems.push(
      'a CLOUDFLARE_API_TOKEN secret is visible to this repository: remove it; this is a DB ' +
        'Israel app, delivered centrally, and holds no Cloudflare token.',
    );
  }
  return problems;
}

const USAGE = `Usage:
  node scripts/deployment-target.mjs [--root <dir>]                  print cial, dbisrael or unbootstrapped
  node scripts/deployment-target.mjs --require cial [--root <dir>]   exit 1 unless the target is CIAL
  node scripts/deployment-target.mjs --github-output [--root <dir>]  write cial=true|false to $GITHUB_OUTPUT`;

/** The parsed command line, or { usage } with what is wrong with it. */
export function parseArgs(argv) {
  const opts = { root: '.', require: null, githubOutput: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    if (flag === '--help' || flag === '-h') return { help: true };
    if (seen.has(flag)) return { usage: `${flag} is given twice` };
    seen.add(flag);
    if (flag === '--github-output') {
      if (eq !== -1) return { usage: '--github-output takes no value' };
      opts.githubOutput = true;
    } else if (flag === '--root' || flag === '--require') {
      const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
        return { usage: `${flag} needs a value` };
      }
      if (flag === '--root') opts.root = value;
      else if (value !== 'cial') return { usage: `--require accepts only cial (got ${value})` };
      else opts.require = value;
    } else {
      return { usage: `unknown argument ${JSON.stringify(arg)}` };
    }
  }
  if (opts.require && opts.githubOutput) {
    return { usage: '--require and --github-output are separate modes' };
  }
  return { opts };
}

// In Actions a message becomes an annotation on the run; the workflow-command escapes keep it one.
const annotate = (level, message, env) =>
  env.GITHUB_ACTIONS === 'true'
    ? `::${level}::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`
    : message;

/** Runs the CLI against `env`; returns the exit code. Exported for the tests. */
export function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.usage) {
    console.error(`${parsed.usage}\n${USAGE}`);
    return 1;
  }
  const { opts } = parsed;
  const fail = (message) => {
    console.error(annotate('error', message, env));
    return 1;
  };
  const root = resolve(opts.root);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) return fail(`--root ${opts.root} is not a directory.`);
  const where = opts.root === '.' ? '' : opts.root;
  const resolution = resolveDeploymentTarget({ root, env });
  if (resolution.error) return fail(where ? `${where}: ${resolution.error}` : resolution.error);
  if (resolution.target === 'dbisrael') {
    const problems = credentialProblems(env);
    if (problems.length > 0) {
      return fail(`${where ? `${where}: ` : ''}${problems.join(' Also, ')}`);
    }
  }
  if (opts.require) {
    const refusal = cialRefusal(resolution, where);
    if (refusal) return fail(refusal);
    return 0;
  }
  if (opts.githubOutput) {
    const out = env.GITHUB_OUTPUT;
    if (!out) return fail('--github-output needs GITHUB_OUTPUT, which GitHub Actions sets.');
    const cial = resolution.target === 'cial';
    if (!cial) {
      const why =
        resolution.target === 'dbisrael'
          ? 'a DB Israel app; the central pipeline delivers it'
          : 'not bootstrapped yet (wrangler.jsonc still names the template)';
      console.log(
        annotate('notice', `CIAL deploy jobs skip${where ? ` (${where})` : ''}: ${why}.`, env),
      );
    }
    appendFileSync(out, `cial=${cial}\n`);
    return 0;
  }
  console.log(resolution.target);
  return 0;
}

// Run only as a CLI; importing the module (provision.mjs, new-app.mjs, the tests) runs nothing.
if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
