#!/usr/bin/env node
// Editor-agnostic pre-commit guard: blocks committing a local secrets file — `.env` / `.env.*`,
// `.dev.vars` / `.dev.vars.*`, `.secrets.json` / `.secrets.*.json`, at any depth, the
// `.example` templates excepted. .gitignore already keeps them out of `git add -A`; this catches
// what an ignore rule can't: `git add -f`, a branch whose .gitignore lost the rule, and a real
// value pasted into the committed template instead of the gitignored file beside it (an existing
// key's value changing in a `.env.example` / `.dev.vars.example`). CI's gitleaks scan only sees
// a secret after the push, when it is already on GitHub. Runs from .githooks/pre-commit.
//
// Exit 0 = allow, 1 = block. Fail-OPEN on any git error (not a repo, no HEAD to compare a
// template against): a guard that can't read the index must never wedge an unrelated commit.
// Escape hatch for a deliberate template edit: PAVEDROAD_ALLOW_SECRET_FILE=1.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const TEMPLATES = new Set(['.env.example', '.dev.vars.example']);
const SECRET_FILE = /^(\.env(\..+)?|\.dev\.vars(\..+)?|\.secrets(\..+)?\.json)$/;

function git(args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

// `path` at `rev` (HEAD, or '' for the index); null when it isn't there.
function blob(rev, path) {
  try {
    return git(['show', `${rev}:${path}`]);
  } catch {
    return null;
  }
}

// KEY → value per assignment line, in both the dotenv form and the `KEY = "v"` form .dev.vars
// files use; surrounding quotes stripped, comments and blank lines skipped.
function assignments(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out.set(m[1], m[2].replace(/^(["'])(.*)\1$/, '$2'));
  }
  return out;
}

// Keys whose committed value the staged template replaces with another non-empty one. New keys
// and cleared values are fine; a brand-new template has nothing to compare and is left to CI.
function changedKeys(path) {
  const before = blob('HEAD', path);
  const after = blob('', path);
  if (before === null || after === null) return [];
  const now = assignments(after);
  return [...assignments(before)]
    .filter(([k, v]) => now.has(k) && now.get(k) !== '' && now.get(k) !== v)
    .map(([k]) => k);
}

let staged;
try {
  staged = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    .split('\0')
    .filter(Boolean);
} catch {
  process.exit(0); // not a repo → nothing to judge
}

const secretFiles = staged.filter(
  (p) => SECRET_FILE.test(basename(p)) && !TEMPLATES.has(basename(p)),
);
const filledTemplates = staged
  .filter((p) => TEMPLATES.has(basename(p)))
  .map((p) => [p, changedKeys(p)])
  .filter(([, keys]) => keys.length > 0);

if (secretFiles.length === 0 && filledTemplates.length === 0) process.exit(0);

if (process.env.PAVEDROAD_ALLOW_SECRET_FILE === '1') {
  process.stderr.write(
    `⚠ PAVEDROAD_ALLOW_SECRET_FILE=1 — allowing a commit that touches secrets files. CI's gitleaks scan still applies.\n`,
  );
  process.exit(0);
}

let msg = '\n';
if (secretFiles.length > 0) {
  msg += '✗ Blocked: local secrets files never belong in git:\n';
  for (const p of secretFiles) msg += `    ${p}\n`;
}
if (filledTemplates.length > 0) {
  msg +=
    '✗ Blocked: a value changed in a committed template. Real values go in the gitignored file\n';
  msg += '  beside it (.env, .dev.vars), never in the .example:\n';
  for (const [p, keys] of filledTemplates) msg += `    ${p}  (${keys.join(', ')})\n`;
}
msg += `  Unstage:  git restore --staged <file>   (the file stays on disk)
  Override once (a deliberate template edit):  PAVEDROAD_ALLOW_SECRET_FILE=1 git commit ...

`;
process.stderr.write(msg);
process.exit(1);
