// Pins the deploy pipeline contract the App Registry reads. The registry's deploy ledger pulls
// the staging and production deploys that run through two kit-owned jobs, from their GitHub
// Actions runs, and finds them by workflow file and job name:
//
//   staging      .github/workflows/ci.yml           job deploy-staging   on a push to main
//   production   .github/workflows/deploy-prod.yml  job deploy           on workflow_dispatch
//
// A deploy made outside them (`npm run deploy` or `npm run deploy:staging` from a laptop) leaves
// no Actions run, so the ledger never sees it.
//
// The Actions jobs API reports a job's DISPLAY name, which is the YAML job id only while nothing
// at job level renames it: a `name:` replaces it, a matrix suffixes it ("deploy (…)"), and a
// reusable-workflow call reports the called jobs as "deploy / …". Neither workflow may be callable
// either (`on: workflow_call`): a caller runs the called jobs inside its own run, under its own
// file, as "<caller job> / deploy". Rename a file or a job, add one of those keys, or make either
// workflow callable, and the registry silently stops seeing deploys while every other check stays
// green. And no other job of the workflow may be reported by a pinned job's name (its job-level
// `name:` reading `deploy`, say): the registry would read it as a deploy too, unable to tell which
// one is.
//
// The registry reads each deploy job's outcome from its steps as well: whether it shipped, or was
// refused before it could, which it calls a job that failed before any step that can touch the
// environment ran. So three step names join the contract: the ship step, named exactly "Deploy to
// staging" or "Deploy to production", which must be the only step of that job by that name (the
// registry reads the first it finds), and the migrations steps, whose names start with "Check +
// apply D1 migrations" and "Apply Supabase migrations" and end in the env, at least one of each
// (the registry reads every one as mutating, so a second database may have a step of its own).
// Renamed, a migrations step that ran and failed would read as a deploy refused with nothing
// touched. Only the job's own job-level `steps:` counts: the same name
// in a comment, in another job, or under a step's `with:`, `env:` or `run:` is not that step.
//
// So these names are a contract: the App Registry deploy puller matches on them, and a rename is
// a registry change (see WHY for where that is decided). WHY names the kit's PR in
// words, never by its repository slug: that slug is the kit's own name, and a literal kit name in
// a test file plants the template identity in a fork and reds its `verify:bootstrap` (the kit's
// #178).
//
// The staging deploy must also stay gated to a push to main, and gated means GitHub cannot run it
// any other way: `github.event_name == 'push'` and `github.ref == 'refs/heads/main'` must each be
// an operand of the job-level `if:`'s top-level && chain. Beside an ||, behind a !, or in text
// around a ${{ }}, a clause can be outvoted, and staging then deploys on runs the contract does
// not describe. `vars.DEPLOY_ENABLED == 'true'` must be one of those operands too: with deploys
// switched off the job must end `skipped`, which the registry reads as no deploy. Gated on its
// steps instead, it would run on every merge and end `success` with nothing shipped.
//
// The production deploy ships only on a human click (DECISIONS 2026-06-16, "Production deploys
// via a manual CI workflow"), so `workflow_dispatch` must be deploy-prod.yml's only trigger.
// Beside a push, a schedule or a workflow_run, production would ship with nobody clicking. And it
// ships from main only: the registry lists production runs on main alone, so a dispatch from
// another branch that migrated and shipped would never reach the ledger. So `deploy` must refuse
// every other ref before any step the registry reads runs, by the kit's guard step as its first
// step (a step ahead of it can write BASH_ENV to $GITHUB_ENV). A job-level
// `if: github.ref == 'refs/heads/main'` does not do it: GitHub's == ignores case, so a branch
// named Main passes it, where bash's != does not. The guard is read strictly, by the keys it may
// carry rather than the ones that break it: `REF: ${{ github.ref }}` in its own `env:`, a literal
// `run:` block whose first command tests "$REF" against refs/heads/main, then nothing but echo
// lines and `exit 1` up to its `fi`, no key but name, id, env, run and a `shell: bash`, and no
// `defaults.run.shell` but bash and no env: name bash reads as it starts (BASH_ENV, say) at job
// or workflow level, any of which could run its script as something that never tests the ref.
// Behind the guard, no step the registry reads may carry an `if:` with a status function
// (`always()`, say), which GitHub runs after the guard refused.
//
// Plain string and regex code with no YAML dependency, like its siblings, but indentation-aware: a
// job block runs from its "<id>:" line (two spaces in, in every kit workflow) to the next key at
// that indentation, and only the lines at the job's own key indentation are job-level. A step's
// `- name:` and `environment:`'s `name:` sit deeper and are not job names. An `if:` is read the way
// GitHub nests it: its YAML peeled off, then split on the && outside every parenthesis and every
// 'string'. A block scalar's text is read as YAML holds it, so the line break every header but a
// strip (`-`) one keeps after the `}}`, or a space before the `${{` or after the `}}`, is text
// around the ${{ }}. Outside a block scalar, an `if:` over several lines fails the check unread:
// YAML folds it, and inside quotes keeps a `#` line as text, which this pin would drop. A step's
// keys are the mapping that starts after its `- `, so a `name:` nested under one of them is no step
// name. A deploy job's step whose name it cannot read (over several lines, in ${{ }}, behind flow
// style, an anchor or an alias on the step, or an anchor, an alias or a tag on the name itself)
// fails the check, since it could be a second step of a pinned name. It decodes no YAML escape but
// \" and \\: an if:, a key or a name in double quotes with any other (YAML reads `\x7C` as `|`)
// fails the check, unread, rather than read as the text it shows. The self-tests run every check on
// synthetic workflows and prove it fails on a job-level `name:`, a renamed job, a renamed step, a
// missing file and a gate an || or a ! can outvote, and passes a step-level `name:`, so a reader
// that matched nothing could not pass on the real files. They also prove a trailing `# comment` is
// never read as a gate clause, a trigger, a value or a step name, that a `#` inside a block scalar
// is read as the text YAML makes it, that a step name in another job does not count, and that
// another job reported by a pinned job's name fails the check.
//
// The same reader pins the deployment-target guard in every CIAL deploy, provision and edge-check
// workflow, ci.yml and deploy-prod.yml among them: each guarded job needs it, and the guard fails
// closed by its shape (see that section).
// Run by `node --test` (test:scripts), like its siblings.
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows');

const WHY =
  'The App Registry deploy puller matches on these names (the workflow files, the job ids, and ' +
  "the ship, D1 migrations and Supabase migrations step names it reads a deploy job's outcome " +
  'from), so a rename is a registry change (docs/DEPLOY-LEDGER-PLAN.md, DECISIONS 2026-10-12 ' +
  '"Deploy visibility is PULLED by the fleet registry from GitHub Actions", in PR #277 of the ' +
  'kit repository).';

/** Every assertion message: what is wrong, then why it matters. */
const because = (what) => `${[what].flat().join('\n')}\n${WHY}`;

/** A workflow's text, or null when the file is not there. */
function readWorkflow(file) {
  const path = join(WORKFLOWS, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

// ── the reader ──────────────────────────────────────────────────────────────────────────────

const indentOf = (line) => line.length - line.trimStart().length;
const isContent = (line) => line.trim() !== '' && !line.trimStart().startsWith('#');

/** `text` without a trailing `# comment`. A `#` inside quotes, or glued to a word, is text. */
function uncomment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trim();
    }
  }
  return text.trim();
}

// A block-mapping key line: a plain key the way GitHub's keys are spelled, or a quoted one
// (`"name": x` names a job too), then `:` and either a space or the end of the line.
const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/;
/** A key as YAML reads it, or null for a quoted one with an escape this pin does not decode. */
const unquote = (key) => (/^["']/.test(key) ? scalar(key) : key);

/**
 * The entries of ONE block mapping held in lines [from, to). The first content line sets the
 * mapping's indentation, and every line at that indentation opens an entry that runs to the next
 * one. Deeper lines (a block scalar, a step, `environment:`'s own keys) belong to the entry above
 * them, and so does a `- ` item at the same indentation, which YAML reads as that key's sequence.
 * A line at the mapping's indentation that is not `key:`, or whose key holds an escape this pin
 * does not decode (`"n\x61me":` is name: to YAML), comes back with key null and the line as its
 * value, so a check can refuse what it cannot read instead of passing it.
 */
function entries(lines, from, to) {
  const out = [];
  let indent = -1;
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (!isContent(line)) continue;
    const lead = indentOf(line);
    if (indent === -1) indent = lead;
    if (lead > indent) continue;
    const text = line.slice(lead);
    if (lead === indent && out.length > 0 && /^-(\s|$)/.test(text)) continue;
    if (out.length > 0) out[out.length - 1].end = i;
    if (lead < indent) break;
    const m = KEY.exec(text);
    const key = m ? unquote(m[1]) : null;
    out.push({
      key,
      value: key === null ? text.trim() : uncomment(m[2] ?? ''),
      line: i + 1,
      start: i,
      end: to,
    });
  }
  return out;
}

/**
 * A one-line scalar's text: a quoted one unquoted, a plain one as written. Null for a
 * double-quoted one with an escape other than \" and \\, the two that stand for their own
 * character: YAML decodes the rest to another (\x7C and \u007C to |, \x20 to a space, \t to a
 * tab), and this pin decodes none of them, so a check refuses that text instead of misreading it.
 */
function scalar(text) {
  const doubleQuoted = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  if (doubleQuoted) {
    let decoded = true;
    // One pass over the escapes in pairs, so \\x is a backslash then an x, not an \x escape.
    const body = doubleQuoted[1].replace(/\\(.)/g, (_, c) => {
      if (c !== '"' && c !== '\\') decoded = false;
      return c;
    });
    return decoded ? body : null;
  }
  const singleQuoted = /^'((?:[^']|'')*)'$/.exec(text);
  if (singleQuoted) return singleQuoted[1].replace(/''/g, "'");
  return text;
}

// A block scalar's header: `|` or `>`, then its chomping and indentation indicators.
const BLOCK_SCALAR = /^[>|][-+1-9]*$/;

/**
 * The lines of a block scalar under `entry`'s header, as YAML holds them, and the lines under the
 * key after it. YAML has no comments inside a block scalar, so every line at or past its content
 * indentation is text as written, a `#` line and a ` # …` tail included. That indentation is the
 * key's plus the header's indicator, or else the first non-blank line's, and the block ends at the
 * first line indented less. Each line is cut at that indentation and nowhere else, so the spaces
 * past it and the spaces after its text stay, and a blank line comes back as ''.
 */
function blockScalar(lines, entry) {
  const under = lines.slice(entry.start + 1, entry.end);
  const indicator = /[1-9]/.exec(entry.value);
  const first = under.find((line) => line.trim() !== '');
  let indent = first === undefined ? 0 : indentOf(first);
  if (indicator) indent = indentOf(lines[entry.start]) + Number(indicator[0]);
  let end = under.findIndex((line) => line.trim() !== '' && indentOf(line) < indent);
  if (end === -1) end = under.length;
  return { text: under.slice(0, end).map((line) => line.slice(indent)), after: under.slice(end) };
}

/**
 * An entry's whole value: its inline part plus the lines under it, a block scalar's as YAML holds
 * them (blockScalar). Every other line under the key is read with its comment dropped.
 */
function wholeValue(lines, entry) {
  let under = lines.slice(entry.start + 1, entry.end);
  let block = [];
  if (BLOCK_SCALAR.test(entry.value)) ({ text: block, after: under } = blockScalar(lines, entry));
  return [entry.value, ...block, ...under.filter(isContent).map(uncomment)].join('\n');
}

/**
 * Whether YAML reads a block scalar with a ${{ in it as more than that ${{ … }}: it keeps an empty
 * line before the first line of text (a line break), the spaces in front of a line deeper than the
 * content indentation (which an indentation indicator allows), the spaces after the last line's
 * text, and the final line break, which every header but a strip (`-`) one keeps. So `if: |` and
 * `if: >` hold the gate and then a line break, which GitHub reads as text beside the ${{ }}.
 */
function textAroundBlock(lines, entry) {
  const { text } = blockScalar(lines, entry);
  if (!text.some((line) => line.includes('${{'))) return false;
  const last = text.findLastIndex((line) => line !== '');
  const strip = entry.value.includes('-');
  return !strip || !text[0]?.startsWith('${{') || !text[last]?.endsWith('}}');
}

/**
 * Why this pin cannot read `entry`'s value as the one-line scalar it reads, or null when it can.
 * A node property or an alias in front of it (`&anchor`, `!!tag`, `*alias`) is YAML this pin does
 * not resolve, and no plain scalar starts with one of those characters. Lines under the key make
 * it a block scalar or a scalar over several lines, which this pin does not fold (a quote left
 * open on the key's line counts, though only # lines follow it). And it decodes no escape but \"
 * and \\ (scalar).
 */
function unreadValue(lines, entry) {
  const { value } = entry;
  if (/^[*&!]/.test(value)) return 'behind an anchor, an alias or a tag';
  const open = /^["']/.test(value) && scalar(value) === value;
  if (BLOCK_SCALAR.test(value) || open || wholeValue(lines, entry) !== value) {
    return 'over several lines';
  }
  if (scalar(value) === null) return 'with an escape this pin does not decode';
  return null;
}

/**
 * The top-level entries, each job directly under `jobs:` with its job-level entries, and the
 * lines directly under `jobs:` this pin cannot read as a job (a merge key, an escaped id).
 */
function parseWorkflow(text) {
  // A byte-order mark is not indentation.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  const top = entries(lines, 0, lines.length);
  const jobs = new Map();
  const unreadJobs = [];
  const jobsKey = top.find((e) => e.key === 'jobs');
  if (jobsKey && !jobsKey.value) {
    for (const job of entries(lines, jobsKey.start + 1, jobsKey.end)) {
      if (job.key === null) unreadJobs.push(job);
      else jobs.set(job.key, { ...job, keys: entries(lines, job.start + 1, job.end) });
    }
  }
  return { lines, top, jobs, unreadJobs };
}

// ── the `if:` reader ────────────────────────────────────────────────────────────────────────

/** `expr` with every 'string' ('' escapes a quote) blanked, so no text in one reads as syntax. */
const blankStrings = (expr) =>
  expr.replace(/'(?:[^']|'')*'/g, (literal) => `'${'_'.repeat(literal.length - 2)}'`);

/** The inside of `operand` when one pair of parentheses wraps the whole of it, else null. */
function parenthesised(operand) {
  const syntax = blankStrings(operand);
  if (!syntax.startsWith('(')) return null;
  let depth = 0;
  for (let i = 0; i < syntax.length; i++) {
    if (syntax[i] === '(') depth++;
    if (syntax[i] === ')') depth--;
    if (depth === 0) return i === syntax.length - 1 ? operand.slice(1, -1).trim() : null;
  }
  return null;
}

/**
 * The operands of `expr`'s top-level && chain, the clauses GitHub requires one and all, with a
 * parenthesised operand that is itself an && chain opened up. Null when `expr` has a top-level
 * ||: it is no chain then, and requires none of its clauses.
 */
function andOperands(expr) {
  const syntax = blankStrings(expr);
  const operands = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < syntax.length; i++) {
    if (syntax[i] === '(') depth++;
    else if (syntax[i] === ')') depth--;
    else if (depth === 0 && syntax.startsWith('||', i)) return null;
    else if (depth === 0 && syntax.startsWith('&&', i)) {
      operands.push(expr.slice(start, i).trim());
      start = i + 2;
      i++;
    }
  }
  operands.push(expr.slice(start).trim());
  return operands.flatMap((operand) => {
    const inner = parenthesised(operand);
    return (inner !== null && andOperands(inner)) || [operand];
  });
}

// Text beside a ${{ }} makes the whole value a string, and GitHub reads a string as true.
const OUTSIDE = `has text outside its \${{ }}, so GitHub reads it as a string, which is always true`;

/**
 * A job-level `if:` read the way GitHub evaluates it: its YAML peeled off (a block scalar's
 * header, a quoted scalar's quotes), then the ${{ }} around the whole expression. Only the header
 * of a block scalar is YAML: its text is the expression as written, a `#` or a quote in it
 * included, and so is the whitespace YAML keeps around a ${{ }} in it (textAroundBlock). Any
 * other value this pin cannot read as one line (unreadValue) is refused: YAML folds a plain or
 * quoted scalar over several lines, and inside quotes keeps a `#` line and a ` # …` tail as
 * text, where an || can outvote the whole gate. Returns the operands it requires (andOperands),
 * or none and `why`.
 */
function gateOperands(lines, gate) {
  const flat = (text) => text.replace(/\s+/g, ' ').trim();
  let expr;
  if (BLOCK_SCALAR.test(gate.value)) {
    if (textAroundBlock(lines, gate)) return { operands: [], why: OUTSIDE };
    expr = flat(wholeValue(lines, gate).slice(gate.value.length));
  } else {
    const unread = unreadValue(lines, gate);
    if (unread) {
      return { operands: [], why: `is a value ${unread}, which this pin cannot read` };
    }
    expr = scalar(flat(gate.value));
  }
  const wrapped = /^\$\{\{(.*)\}\}$/.exec(expr);
  if (wrapped) expr = wrapped[1].trim();
  if (/\$\{\{|\}\}/.test(expr)) return { operands: [], why: OUTSIDE };
  const operands = andOperands(expr);
  return operands
    ? { operands }
    : { operands: [], why: 'has a top-level ||, so it requires none of its clauses' };
}

// ── the `on:` reader ────────────────────────────────────────────────────────────────────────

/** A trigger name as written: plain, or in quotes with nothing to unescape. Null otherwise. */
function eventName(text) {
  const m = /^(["']?)([A-Za-z_][\w-]*)\1$/.exec(text.trim());
  return m ? m[2] : null;
}

/**
 * The event names `on:` lists, in each spelling GitHub takes: a scalar, a flow or block sequence,
 * or the keys of a block mapping. Null for any other spelling (a flow mapping, an anchor or an
 * alias, a flow sequence over several lines), so a check refuses what it cannot read.
 */
function triggers(lines, on) {
  const under = lines
    .slice(on.start + 1, on.end)
    .filter(isContent)
    .map((line) => uncomment(line));
  let names;
  if (on.value) {
    const flow = /^\[(.*)\]$/.exec(on.value);
    if (under.length > 0) names = [null];
    else if (flow) names = flow[1].trim() ? flow[1].split(',') : [];
    else names = [on.value];
  } else if (/^-(\s|$)/.test(under[0] ?? '')) {
    names = under.map((item) => (/^-\s/.test(item) ? item.slice(1) : null));
  } else {
    names = entries(lines, on.start + 1, on.end).map((e) => e.key);
  }
  const read = names.map((name) => (name === null ? null : eventName(name)));
  return read.includes(null) ? null : read;
}

// ── the steps reader ────────────────────────────────────────────────────────────────────────

/**
 * The steps of a job, from its own job-level `steps:` only, each with the line it starts on and
 * its step-level entries. A step's keys are the mapping that starts after its `- `, read by
 * entries() with the dash blanked, so a `name:` under `with:` or `env:`, or text in a `run:`
 * block, sits deeper and is no step key. Every line under an item stays in its lines, a blank
 * line and a `#` line included: entries() skips them between keys, and a step-level block scalar
 * (an `if: >-`) then holds them as YAML does, as text. Null when `steps:` is spelled in a way this
 * pin cannot read (inline: flow style, an anchor or an alias; or a line that is no `- ` item).
 */
function jobSteps(lines, job) {
  const steps = job.keys.find((e) => e.key === 'steps');
  if (!steps) return [];
  if (steps.value) return null;
  const items = [];
  let indent = -1;
  for (let i = steps.start + 1; i < steps.end; i++) {
    const line = lines[i];
    const lead = indentOf(line);
    if (!isContent(line)) {
      // A blank line, or a `#` line deeper than the items, belongs to the item above it.
      if (items.length > 0 && (line.trim() === '' || lead > indent)) {
        items[items.length - 1].lines.push(line);
      }
      continue;
    }
    if (indent === -1) indent = lead;
    if (lead > indent) {
      items[items.length - 1].lines.push(line);
    } else if (lead === indent && /^-(\s|$)/.test(line.slice(lead))) {
      items.push({ line: i + 1, lines: [`${' '.repeat(lead + 1)}${line.slice(lead + 1)}`] });
    } else {
      return null;
    }
  }
  return items.map((item) => ({ ...item, keys: entries(item.lines, 0, item.lines.length) }));
}

/**
 * Why this pin cannot tell what name the jobs API reports for `step`, or null when it can (the
 * step has no `name:`, or one on a single line). A step line that is no `key:` it reads can bring
 * in a name (flow style, an anchor, an alias, a merge key, or a key with an escape), a value
 * unreadValue refuses can be any name, GitHub evaluates a ${{ }} in a name, and quotes keep spaces
 * around one, which the jobs API may or may not trim (canReport counts none for a job's name).
 */
function unreadName(step) {
  if (step.keys.some((e) => e.key === null)) {
    return (
      'a line that is no `key:` this pin reads: flow style, an anchor, an alias, a merge key or ' +
      'a key with an escape'
    );
  }
  const name = step.keys.find((e) => e.key === 'name');
  if (!name) return null;
  const why = unreadValue(step.lines, name);
  if (why) return `a name ${why}`;
  if (name.value.includes('${{')) return `a name GitHub evaluates, in \${{ }}`;
  const text = scalar(name.value);
  if (text !== text.trim())
    return 'a quoted name with spaces around it, which the jobs API may trim';
  return null;
}

/** A step's name as the jobs API reports it, or null: unnamed, or a name this pin cannot read. */
function stepName(step) {
  const name = step.keys.find((e) => e.key === 'name');
  return name && unreadName(step) === null ? scalar(name.value) : null;
}

// ── the contract ────────────────────────────────────────────────────────────────────────────

// Job-level keys that make the jobs API report something other than the bare job id.
const RENAMERS = new Map([
  ['name', 'replaces the id as the display name the jobs API reports'],
  ['strategy', 'is where a matrix goes, and a matrix suffixes the display name: "<id> (…)"'],
  ['uses', 'calls a reusable workflow, whose jobs are reported as "<id> / <job>"'],
]);

/**
 * Whether a job-level `name:`, as YAML reads it, can be reported as `id`. A ${{ }} in it can
 * evaluate to any text, so only the text before the first and after the last bounds it; the
 * last `}}` may sit in a 'string' inside the expression, and then that bound is only looser.
 * Surrounding whitespace counts for nothing, in case the jobs API trims it.
 */
function canReport(name, id) {
  const text = name.trim();
  const open = text.indexOf('${{');
  if (open === -1) return text === id;
  const close = text.lastIndexOf('}}');
  const before = text.slice(0, open);
  const after = close > open ? text.slice(close + 2) : '';
  return id.length >= before.length + after.length && id.startsWith(before) && id.endsWith(after);
}

/**
 * No other job in the workflow is reported as `id`. The registry finds a deploy job by the name
 * the jobs API reports, so a second job by that name (another job's job-level `name:`) would be
 * read as a deploy too, and nothing would say which one is. A job, or a job's name, this pin
 * cannot read could be that second job, so it fails the check as well.
 */
function twinProblems(file, workflow, id) {
  const could = `, so it could be a second job the jobs API reports as \`${id}\``;
  const problems = workflow.unreadJobs.map(
    (e) => `${file}:${e.line}: a line under jobs: this pin cannot read (${e.value})${could}`,
  );
  for (const [other, job] of workflow.jobs) {
    if (other === id) continue;
    if (job.value) {
      problems.push(
        `${file}:${job.line}: job \`${other}\` carries an inline value this pin cannot read ` +
          `(${job.value})${could}`,
      );
      continue;
    }
    for (const e of job.keys) {
      if (e.key === null) {
        problems.push(
          `${file}:${e.line}: a job-level line in \`${other}\` this pin cannot read (${e.value})${could}`,
        );
      } else if (e.key === 'name') {
        const unread = unreadValue(workflow.lines, e);
        if (unread) {
          problems.push(
            `${file}:${e.line}: \`${other}\` has a job-level name: this pin cannot read (a name ` +
              `${unread})${could}`,
          );
        } else if (canReport(scalar(e.value), id)) {
          problems.push(
            `${file}:${e.line}: \`${other}\` has job-level name: ${e.value}, which the jobs API ` +
              `can report as \`${id}\`, so the registry would read two jobs by that name and ` +
              'could not tell which one deploys',
          );
        }
      }
    }
  }
  return problems;
}

/**
 * A job with this id sits directly under `jobs:`, the jobs API reports it by that id, and it
 * reports no other job of the workflow by that id (twinProblems).
 */
function jobProblems(file, workflow, id) {
  const job = workflow.jobs.get(id);
  if (!job) {
    const found = [...workflow.jobs.keys()].join(', ') || 'none';
    return [`${file}: no job \`${id}\` directly under jobs: (jobs found: ${found})`];
  }
  if (job.value) {
    return [
      `${file}:${job.line}: job \`${id}\` carries an inline value (${job.value}): flow style, an ` +
        'anchor or an alias this pin cannot read through. Write the job as a block.',
    ];
  }
  const problems = [];
  for (const e of job.keys) {
    if (e.key === null) {
      problems.push(
        `${file}:${e.line}: a job-level line in \`${id}\` this pin cannot read: ${e.value}`,
      );
    } else if (RENAMERS.has(e.key)) {
      problems.push(
        `${file}:${e.line}: \`${id}\` has a job-level \`${e.key}:\`, which ${RENAMERS.get(e.key)}`,
      );
    }
  }
  if (!job.keys.some((e) => e.key === 'steps')) {
    problems.push(
      `${file}:${job.line}: \`${id}\` has no job-level steps:, so it runs none of its own ` +
        'or this reader lost its keys',
    );
  }
  return [...problems, ...twinProblems(file, workflow, id)];
}

/**
 * The trigger names `on:` lists, and what is wrong with them for either deploy workflow: an `on:`
 * this pin cannot find or read, or a `workflow_call`. A caller runs a called workflow's jobs
 * inside its own run, under its own file, as "<caller job> / <id>", where the registry never
 * looks. Every workflow has an `on:`, so one this pin cannot find is spelled in a way it does not
 * read (`"o\x6E":` is on: to YAML), and could hold a workflow_call.
 */
function triggerProblems(file, workflow) {
  const on = workflow.top.find((e) => e.key === 'on');
  if (!on) {
    const missing = `${file}: no on: this pin can read, so it cannot tell what starts the workflow`;
    return { names: null, problems: [missing] };
  }
  const names = triggers(workflow.lines, on);
  if (names === null) {
    const unread =
      `${file}:${on.line}: on: is spelled in a way this pin cannot read (a flow mapping, an ` +
      'anchor or an alias). Write it as a block mapping or a list.';
    return { names, problems: [unread] };
  }
  const problems = [];
  if (names.includes('workflow_call')) {
    problems.push(
      `${file}:${on.line}: on: includes workflow_call, so a caller can run this deploy inside ` +
        'its own run, under its own file, where the registry does not look',
    );
  }
  return { names, problems };
}

// A step name the registry matches on: what the check reports, the test a name must pass, and
// whether only one step of the job may pass it. The registry finds the ship step with find(), so
// a second would leave it reading whichever comes first; it reads every step with a migrations
// prefix (some()), so a job may migrate in as many as it needs.
const exactly = (name) => [`named exactly "${name}"`, (step) => step === name, true];
const startingWith = (prefix) => [
  `whose name starts with "${prefix}"`,
  (step) => step.startsWith(prefix),
  false,
];

// The migrations steps, the registry's MIGRATION_STEP_PREFIXES: with the ship step, every step it
// reads as one that can touch the environment. Renamed, a migrations step that ran and failed
// would read as a deploy refused before anything changed.
const MIGRATIONS = [
  startingWith('Check + apply D1 migrations'),
  startingWith('Apply Supabase migrations'),
];

// The steps the registry reads a deploy job's outcome from (shipped, or refused before it could):
// exactly one ship step, and at least one step for each migrations prefix.
const STEPS = new Map([
  ['deploy-staging', [exactly('Deploy to staging'), ...MIGRATIONS]],
  ['deploy', [exactly('Deploy to production'), ...MIGRATIONS]],
]);

/**
 * The steps of deploy job `id`, read once for every check of them: undefined when the job is
 * missing or inline, which has a problem of its own (jobProblems), and null when this pin cannot
 * read its steps: (jobSteps), which stepProblems reports.
 */
function deploySteps(workflow, id) {
  const job = workflow.jobs.get(id);
  return !job || job.value ? undefined : jobSteps(workflow.lines, job);
}

/**
 * The job `id` carries, in its own steps:, exactly one ship step and at least one step for each
 * migrations prefix STEPS lists for it, and no step whose name this pin cannot read: that one
 * could be a second ship step, and the count would pass without it. `steps` is
 * deploySteps(workflow, id).
 */
function stepProblems(file, workflow, id, steps) {
  if (steps === undefined) return [];
  if (steps === null) {
    const job = workflow.jobs.get(id);
    const at = job.keys.find((e) => e.key === 'steps');
    const why = at.value
      ? `it is inline (${at.value}): flow style, an anchor or an alias`
      : 'a line in it is no `- ` item';
    return [
      `${file}:${at.line}: this pin cannot read \`${id}\`'s steps: because ${why}. Write each ` +
        'step as a block item.',
    ];
  }
  const problems = [];
  for (const step of steps) {
    const why = unreadName(step);
    if (why) {
      problems.push(
        `${file}:${step.line}: this pin cannot read the name of a step of \`${id}\` (${why}), ` +
          'so it cannot tell whether the registry would read that step too. Write it as a block ' +
          'step with a one-line name.',
      );
    }
  }
  const named = steps
    .map((step) => ({ line: step.line, name: stepName(step) }))
    .filter((step) => step.name !== null);
  for (const [what, matches, onlyOne] of STEPS.get(id)) {
    const hits = named.filter((step) => matches(step.name));
    if (hits.length === 0) {
      const found = named.map((step) => step.name).join(' | ') || 'none';
      problems.push(`${file}: \`${id}\` has no step ${what} (named steps: ${found})`);
    } else if (onlyOne && hits.length > 1) {
      const at = hits.map((step) => step.line).join(', ');
      problems.push(
        `${file}: \`${id}\` has ${hits.length} steps ${what} (lines ${at}), so the registry ` +
          'would read the first as the ship step, whichever one shipped',
      );
    }
  }
  return problems;
}

// What deploy-staging's job-level `if:` must require, each clause as an operand of its top-level
// && chain (gateOperands): beside an || or behind a !, a clause can be outvoted.
// A gate clause that requires the run's ref to be main. GitHub's == ignores case, so it also
// passes refs/heads/Main: in staging only ci.yml's `push: branches: [main]` filter, which this pin
// does not read, stands between it and such a branch, and production does not lean on it at all
// (mainOnlyProblems).
const ON_MAIN = /^github\.ref\s*==\s*'refs\/heads\/main'$/;

const STAGING_GATE = [
  ["github.event_name == 'push'", /^github\.event_name\s*==\s*'push'$/],
  ["github.ref == 'refs/heads/main'", ON_MAIN],
  [
    "vars.DEPLOY_ENABLED == 'true'",
    /^vars\.DEPLOY_ENABLED\s*==\s*'true'$/,
    // A skipped job is how the registry tells a fork with deploys off from a deploy.
    ': with deploys off, the job must end skipped, not run and end success with nothing shipped',
  ],
];

/** ci.yml: `deploy-staging`, reported by that id, its steps named, deploying on a push to main. */
function stagingProblems(text, file = 'ci.yml') {
  if (text === null) return [`${file} is missing`];
  const workflow = parseWorkflow(text);
  const steps = deploySteps(workflow, 'deploy-staging');
  const problems = [
    ...triggerProblems(file, workflow).problems,
    ...jobProblems(file, workflow, 'deploy-staging'),
    ...stepProblems(file, workflow, 'deploy-staging', steps),
  ];
  const job = workflow.jobs.get('deploy-staging');
  if (!job || job.value) return problems;
  const gate = job.keys.find((e) => e.key === 'if');
  const { operands, why } = gate ? gateOperands(workflow.lines, gate) : { operands: [] };
  if (why) problems.push(`${file}:${gate.line}: deploy-staging's job-level if: ${why}`);
  for (const [clause, pattern, reason = ''] of STAGING_GATE) {
    if (!operands.some((operand) => pattern.test(operand))) {
      problems.push(`${file}: deploy-staging's job-level if: does not require ${clause}${reason}`);
    }
  }
  return problems;
}

// The command that opens the kit's production guard: the run's ref, from the step's env, tested
// against main.
const REF_TEST = 'if [ "$REF" != "refs/heads/main" ]; then';

/** A step's own entry for `key`, or undefined. */
const stepKey = (step, key) => step.keys.find((e) => e.key === key);

// The keys the guard step may carry. Any other is read as no guard, whatever it does: an if:
// can skip it, continue-on-error: runs the job on past it, and the rest have no business there.
const GUARD_KEYS = new Set(['name', 'id', 'env', 'run', 'shell']);

// Env names bash reads as it starts, before the guard's first command: BASH_ENV and ENV name a
// file it sources (which can reset REF), SHELLOPTS and BASHOPTS switch on options (noexec reads
// the script and runs none of it), and a BASH_FUNC_ name defines a function, which can stand in
// for `[`.
const SHELL_STARTUP = /^(?:BASH_ENV|ENV|SHELLOPTS|BASHOPTS|BASH_FUNC_.*)$/;

/**
 * Why an `env:` (the workflow's, a job's or a step's) could change how bash starts, or null: it
 * is inline (a flow mapping, an alias, a ${{ }}) or holds a line this pin cannot read, either of
 * which could set one, or it sets a SHELL_STARTUP name.
 */
function startupEnv(lines, env) {
  if (env.value) return `is inline (${env.value}), which this pin cannot read`;
  for (const e of entries(lines, env.start + 1, env.end)) {
    if (e.key === null) return `holds a line this pin cannot read (${e.value})`;
    if (SHELL_STARTUP.test(e.key)) return `sets ${e.key}, which bash reads as it starts`;
  }
  return null;
}

/** Why a `shell:` entry could run a script in something other than bash, or null. */
function notBash(lines, shell) {
  if (unreadValue(lines, shell)) return `is a value this pin cannot read (${shell.value})`;
  return scalar(shell.value) === 'bash' ? null : `is ${shell.value}, not bash`;
}

/**
 * Why a `defaults:` (the workflow's or a job's) could run the guard's script in something other
 * than bash, or null: a `run.shell` that is not bash, or a spelling this pin cannot read.
 */
function defaultShell(lines, defaults) {
  if (defaults.value) return `is inline (${defaults.value}), which this pin cannot read`;
  for (const e of entries(lines, defaults.start + 1, defaults.end)) {
    if (e.key === null) return `holds a line this pin cannot read (${e.value})`;
    if (e.key !== 'run') continue;
    if (e.value) return `sets run: inline (${e.value}), which this pin cannot read`;
    for (const r of entries(lines, e.start + 1, e.end)) {
      if (r.key === null) return `holds a line this pin cannot read (${r.value})`;
      const why = r.key === 'shell' ? notBash(lines, r) : null;
      if (why) return `sets run.shell, which ${why}`;
    }
  }
  return null;
}

/**
 * Whether `step` is the kit's main-only guard, read strictly, since a guard spelled any other way
 * could let another ref through: only GUARD_KEYS (no if:, which could skip it, and no
 * continue-on-error:, which would run the job on past it), a `shell:` if any that is bash, which
 * GitHub would otherwise run the script with (`true {0}` passes on every ref), `REF:
 * ${{ github.ref }}` in its own env: and no name bash reads as it starts (SHELL_STARTUP), and a
 * literal run: block whose first command is REF_TEST, then nothing but echo lines and an `exit 1`
 * up to its `fi` (an earlier command, a nested test or a `;` could let another ref past the exit).
 */
function refusesOtherRefs(step) {
  if (step.keys.some((e) => !GUARD_KEYS.has(e.key))) return false;
  const shell = stepKey(step, 'shell');
  if (shell && notBash(step.lines, shell)) return false;
  const env = stepKey(step, 'env');
  const run = stepKey(step, 'run');
  if (!env || startupEnv(step.lines, env) || !run || !/^\|[-+1-9]*$/.test(run.value)) return false;
  const refs = entries(step.lines, env.start + 1, env.end).filter((e) => e.key === 'REF');
  if (refs.length !== 1 || unreadValue(step.lines, refs[0])) return false;
  if (!/^\$\{\{\s*github\.ref\s*\}\}$/.test(scalar(refs[0].value))) return false;
  const script = blockScalar(step.lines, run)
    .text.map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const fi = script.indexOf('fi');
  const body = script.slice(1, fi);
  return (
    script[0] === REF_TEST &&
    fi > 0 &&
    body.includes('exit 1') &&
    body.every((line) => line === 'exit 1' || /^echo "(?:[^"\\]|\\.)*"$/.test(line))
  );
}

/**
 * Whether GitHub can run `step` after an earlier step failed. Its if: gets an implicit success()
 * only while it calls no status function (always(), failure(), cancelled(), success(), in any
 * case), so one that calls any can run it after the guard refused. A block scalar is read as
 * the text YAML holds, a `#` line included. Any other if: this pin cannot read as one line
 * (unreadValue: behind an anchor, an alias or a tag, over several lines, an open quote, an
 * escape) counts as calling one, as gateOperands refuses it: inside quotes YAML folds a `#` line
 * into the value, where it can spell one.
 */
function canRunAfterAFailure(step) {
  const gate = stepKey(step, 'if');
  if (!gate) return false;
  let text;
  if (BLOCK_SCALAR.test(gate.value)) text = blockScalar(step.lines, gate).text.join('\n');
  else if (unreadValue(step.lines, gate)) return true;
  else text = scalar(gate.value);
  return /\b(?:always|failure|cancelled|success)\s*\(/i.test(text);
}

/**
 * deploy-prod.yml's `deploy` refuses every ref but main before any step the registry reads runs.
 * The registry lists production runs on main only, so a deploy dispatched from another branch
 * would ship where the ledger never looks. The guard step (refusesOtherRefs) must be the job's
 * first step: a step ahead of it can write BASH_ENV to $GITHUB_ENV or another bash to
 * $GITHUB_PATH, and the guard then never runs its test. Nothing at job or workflow level may run
 * its script in something other than bash either: a `defaults.run.shell` (defaultShell) or an
 * env: name bash reads as it starts (startupEnv). And GitHub must be able to run none of the steps
 * STEPS names after it refused (canRunAfterAFailure). A job-level
 * `if: github.ref == 'refs/heads/main'` is no substitute: GitHub's == ignores case, so it also
 * runs the job from a branch named Main or MAIN, where bash's != in the guard does not.
 */
function mainOnlyProblems(file, workflow, steps) {
  // A missing or inline job, or steps: this pin cannot read, has a problem of its own
  // (jobProblems, stepProblems): the guard may be there, unseen, and is no problem to fix.
  if (!steps) return [];
  const problems = [];
  const job = workflow.jobs.get('deploy');
  for (const [where, keys] of [
    ['the workflow', workflow.top],
    ['`deploy`', job.keys],
  ]) {
    for (const [key, why] of [
      ['env', startupEnv],
      ['defaults', defaultShell],
    ]) {
      const entry = keys.find((e) => e.key === key);
      const reason = entry && why(workflow.lines, entry);
      if (reason) {
        problems.push(
          `${file}:${entry.line}: ${where}'s ${key}: ${reason}, so the guard may never run its ` +
            'test of the ref',
        );
      }
    }
  }
  if (!(steps.length > 0 && refusesOtherRefs(steps[0]))) {
    problems.push(
      `${file}: \`deploy\` does not refuse every ref but refs/heads/main before its migrations ` +
        'and ship steps run, but the registry lists production runs on main only, so a deploy ' +
        'dispatched from another branch would ship unseen. Keep the guard as its first step: ' +
        `REF: \${{ github.ref }} in its own env:, and a run: | block whose first command is ` +
        `\`${REF_TEST}\`, then only echo lines and \`exit 1\` up to its fi, with no key but ` +
        `${[...GUARD_KEYS].join(', ')}, a shell: if any of bash, and no env: name bash reads as ` +
        "it starts. A job-level if: on github.ref is no substitute: GitHub's == ignores case, " +
        'so it also runs from a branch named Main.',
    );
  }
  const pinned = steps.filter((step) => {
    const name = stepName(step);
    return name !== null && STEPS.get('deploy').some(([, matches]) => matches(name));
  });
  for (const step of pinned.filter(canRunAfterAFailure)) {
    problems.push(
      `${file}:${step.line}: \`deploy\`'s step "${stepName(step)}" has an if: with a status ` +
        'function, so GitHub can run it after the guard refused another ref',
    );
  }
  return problems;
}

/**
 * deploy-prod.yml: dispatched by hand alone, `deploy` reported by that id, its steps named, and
 * shipping from main only.
 */
function productionProblems(text, file = 'deploy-prod.yml') {
  if (text === null) return [`${file} is missing`];
  const workflow = parseWorkflow(text);
  const { names, problems } = triggerProblems(file, workflow);
  if (names !== null) {
    if (!names.includes('workflow_dispatch')) {
      problems.push(`${file}: on: does not include workflow_dispatch`);
    }
    // workflow_call has a problem of its own (triggerProblems).
    const others = names.filter((name) => name !== 'workflow_dispatch' && name !== 'workflow_call');
    if (others.length > 0) {
      problems.push(
        `${file}: on: lists ${others.join(', ')}, but production ships only on a human click, ` +
          'so workflow_dispatch must be its only trigger',
      );
    }
  }
  const steps = deploySteps(workflow, 'deploy');
  return [
    ...problems,
    ...jobProblems(file, workflow, 'deploy'),
    ...stepProblems(file, workflow, 'deploy', steps),
    ...mainOnlyProblems(file, workflow, steps),
  ];
}

// ── the deployment-target guard ─────────────────────────────────────────────────────────────

// Every CIAL deploy, provision and edge-check job runs for a CIAL app only.
// scripts/deployment-target.mjs decides, in a job of its own that each guarded job needs. In a DB
// Israel app, which the central pipeline delivers, or in a template copy whose bootstrap has not
// merged, each guarded job must end skipped or refused, which the registry reads as no deploy,
// rather than run its steps. And a guard that failed, or wrote no output, must never let it run.
//
// So the guard fails closed by its shape, not only by its exit code. The job and each of its
// steps carry no `continue-on-error`, with which GitHub reports a refusal as a success and every
// job that needs it runs. No step carries an `if:`, since a refusal that skips is a success too.
// Outside ci.yml the job carries no `if:` either: skipped, it would skip what it guards with
// nothing red (ci.yml's guard runs on a push to main only, like deploy-staging, which requires its
// success). The guarded jobs are read as GitHub reads them: deploy-staging and edge-live's `check`
// start without the implicit success() on needs, or read the guard's output, so each requires the
// guard's result and output as top-level && operands (gateOperands); the dispatched jobs keep the
// implicit success(), so their `if:` calls no status function. A drift tripwire against an
// accidental edit, not a lock: a PR can change a workflow and this file together.
const TARGET_GUARD = 'deployment-target';
const TARGET_WHY =
  'Each CIAL deploy, provision and edge-check job runs for a CIAL app only: in a DB Israel app ' +
  'it must end skipped or refused, which the registry reads as no deploy, and a guard that ' +
  'failed must not let it run (DECISIONS 2026-10-27, deployment-target reader).';
const becauseTarget = (what) => `${[what].flat().join('\n')}\n${TARGET_WHY}`;

// What a job that reads the guard's output requires, as operands of its top-level && chain: the
// guard's success, and its output saying `cial`.
const TARGET_GATE = [
  [
    `needs.${TARGET_GUARD}.result == 'success'`,
    /^needs\.deployment-target\.result\s*==\s*'success'$/,
  ],
  [
    `needs.${TARGET_GUARD}.outputs.cial == 'true'`,
    /^needs\.deployment-target\.outputs\.cial\s*==\s*'true'$/,
  ],
];

/**
 * Why the guard job of `workflow` might not fail closed: a `continue-on-error` on it or on any of
 * its steps, an `if:` on any step, and with `gated` false an `if:` on the job. A job-level or
 * step-level line this pin cannot read as a key could bring either in, so it counts too.
 */
function guardShapeProblems(file, workflow, gated) {
  const guard = workflow.jobs.get(TARGET_GUARD);
  if (!guard || guard.value) return [];
  const problems = [];
  const unread = (where, entry) =>
    `${file}:${entry.line}: ${where} has a line this pin cannot read as a key (${entry.value})`;
  for (const entry of guard.keys) {
    if (entry.key === null) problems.push(unread(`the ${TARGET_GUARD} job`, entry));
    if (entry.key === 'continue-on-error') {
      problems.push(
        `${file}:${entry.line}: the ${TARGET_GUARD} job has continue-on-error, so a refusal reads as success`,
      );
    }
    if (entry.key === 'if' && !gated) {
      problems.push(
        `${file}:${entry.line}: the ${TARGET_GUARD} job has an if:, so it can skip what it guards`,
      );
    }
  }
  const steps = jobSteps(workflow.lines, guard);
  if (steps === null) {
    problems.push(
      `${file}: the ${TARGET_GUARD} job's steps: is spelled in a way this pin cannot read`,
    );
    return problems;
  }
  for (const step of steps) {
    const { line } = step;
    for (const entry of step.keys) {
      if (entry.key === null) problems.push(unread(`a ${TARGET_GUARD} step`, { ...entry, line }));
      if (entry.key === 'continue-on-error') {
        problems.push(
          `${file}:${line}: a ${TARGET_GUARD} step has continue-on-error, so a refusal reads as success`,
        );
      }
      if (entry.key === 'if') {
        problems.push(`${file}:${line}: a ${TARGET_GUARD} step has an if:, so a refusal can skip`);
      }
    }
  }
  return problems;
}

/**
 * Guarded job `id` of `text` needs the deployment-target guard job, which the workflow has, in a
 * shape that fails closed (guardShapeProblems; `gated` lets the guard job carry an `if:`). With
 * `clauses`, the guarded job's `if:` requires each as a top-level && operand (gateOperands).
 * Without, it must not call a status function, which GitHub would run after the guard failed.
 * With `optional`, a missing file has no problem: a CIAL path an app deleted cannot run.
 */
function targetGuardProblems(
  text,
  file,
  id,
  { clauses = [], gated = false, optional = false } = {},
) {
  if (text === null) return optional ? [] : [`${file} is missing`];
  const workflow = parseWorkflow(text);
  const job = workflow.jobs.get(id);
  if (!job || job.value) {
    // In the registry's two files a missing or inline job has a problem of its own (jobProblems).
    return optional ? [`${file}: no job \`${id}\` (or one written inline)`] : [];
  }
  const problems = [];
  if (!workflow.jobs.has(TARGET_GUARD)) problems.push(`${file}: no job \`${TARGET_GUARD}\``);
  problems.push(...guardShapeProblems(file, workflow, gated));
  // needs: takes the spellings on: does: a scalar, or a flow or block sequence.
  const needs = job.keys.find((e) => e.key === 'needs');
  const ids = needs ? triggers(workflow.lines, needs) : [];
  if (ids === null) {
    problems.push(
      `${file}:${needs.line}: \`${id}\`'s needs: is spelled in a way this pin cannot read`,
    );
  } else if (!ids.includes(TARGET_GUARD)) {
    problems.push(`${file}: \`${id}\` does not need ${TARGET_GUARD}`);
  }
  const gate = job.keys.find((e) => e.key === 'if');
  if (clauses.length > 0) {
    const { operands, why } = gate ? gateOperands(workflow.lines, gate) : { operands: [] };
    if (why) problems.push(`${file}:${gate.line}: ${id}'s job-level if: ${why}`);
    for (const [clause, pattern] of clauses) {
      if (!operands.some((operand) => pattern.test(operand))) {
        problems.push(`${file}: ${id}'s job-level if: does not require ${clause}`);
      }
    }
  } else if (
    gate &&
    /\b(?:always|failure|cancelled|success)\s*\(/i.test(wholeValue(workflow.lines, gate))
  ) {
    problems.push(`${file}:${gate.line}: ${id}'s job-level if: calls a status function`);
  }
  return problems;
}

// Each guarded job: [file, job id, options]. ci.yml and deploy-prod.yml are the registry's own, so
// they must be there; an app may have deleted the others.
const GUARDED_JOBS = [
  ['ci.yml', 'deploy-staging', { clauses: TARGET_GATE, gated: true }],
  ['deploy-prod.yml', 'deploy', {}],
  ['provision-staging.yml', 'provision-staging', { optional: true }],
  ['provision-production.yml', 'provision-production', { optional: true }],
  ['edge-live.yml', 'check', { clauses: TARGET_GATE, optional: true }],
];

describe('the deploy pipeline contract the App Registry reads', () => {
  it('ci.yml: deploy-staging under jobs:, unrenamed, steps named, gated to a push to main', () => {
    const problems = stagingProblems(readWorkflow('ci.yml'));
    assert.deepEqual(problems, [], because(problems));
  });

  it('deploy-prod.yml: dispatched by hand only, deploy under jobs:, unrenamed, steps named', () => {
    const problems = productionProblems(readWorkflow('deploy-prod.yml'));
    assert.deepEqual(problems, [], because(problems));
  });

  it('every guarded job needs the deployment-target guard, which fails closed, and reads its result and output', () => {
    const problems = GUARDED_JOBS.flatMap(([file, id, options]) =>
      targetGuardProblems(readWorkflow(file), file, id, options),
    );
    assert.deepEqual(problems, [], becauseTarget(problems));
  });
});

// ── the checks catch each way to break it ───────────────────────────────────────────────────

const yaml = (...lines) => `${lines.join('\n')}\n`;

// deploy-staging's job-level if: in the shape ci.yml writes it: a folded block, one ${{ }}, and an
// || inside parentheses, where it outvotes nothing outside them.
const STAGING_IF = [
  '    if: >-',
  "      ${{ !cancelled() && vars.DEPLOY_ENABLED == 'true'",
  "          && (needs.test.result == 'success' || needs.test.result == 'skipped')",
  "          && github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
];

// deploy-staging's steps, the three the registry reads among them.
const STAGING_STEPS = [
  '      - name: Check + apply D1 migrations (staging)',
  '        run: npm run db:migrate:staging',
  '      - name: Apply Supabase migrations (only when SUPABASE_DB_URL_STAGING is set)',
  '        run: npm run db:migrate:supabase',
  '      - name: Deploy to staging',
  '        run: npx wrangler deploy',
];

const STAGING = yaml(
  'name: CI',
  'on:',
  '  push:',
  '    branches: [main]',
  'jobs:',
  '  test:',
  '    name: unit tests',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: npm test',
  '  deploy-staging:',
  '    needs: [test]',
  ...STAGING_IF,
  '    runs-on: ubuntu-latest',
  '    steps:',
  ...STAGING_STEPS,
);

// The guard's env entry that hands it the run's ref.
const REF = `REF: \${{ github.ref }}`;

// deploy's guard, as the kit writes it: it refuses every ref but main before the steps below run.
const PRODUCTION_GUARD = [
  '      - name: Guard, main only',
  '        env:',
  `          ${REF}`,
  '        run: |',
  '          if [ "$REF" != "refs/heads/main" ]; then',
  `            echo "::error::Production ships from main only (got '$REF')."`,
  '            exit 1',
  '          fi',
];

// deploy's steps, the three the registry reads.
const PRODUCTION_STEPS = [
  '      - name: Check + apply D1 migrations (production)',
  '        run: npm run db:migrate',
  '      - name: Apply Supabase migrations (only when SUPABASE_DB_URL is set)',
  '        run: npm run db:migrate:supabase',
  '      - name: Deploy to production',
  '        run: npm run deploy',
];

const PRODUCTION = yaml(
  'name: Deploy production',
  'on:',
  '  workflow_dispatch: {}',
  'jobs:',
  '  deploy:',
  '    runs-on: ubuntu-latest',
  '    environment:',
  '      name: production',
  '    steps:',
  ...PRODUCTION_GUARD,
  ...PRODUCTION_STEPS,
);

/** PRODUCTION's whole `on:`, to replace with each spelling of it. */
const ON_DISPATCH = 'on:\n  workflow_dispatch: {}';

/**
 * `base` with `from` replaced by `to`. `from` must occur exactly once, so no edit is a no-op or
 * lands on the wrong job, and `to` is inserted as written (a replacer function, so a `$` in it is
 * never read as a replacement pattern).
 */
function edit(base, from, to) {
  const count = base.split(from).length - 1;
  assert.equal(count, 1, because(`the fixture must hold ${JSON.stringify(from)} exactly once`));
  return base.replace(from, () => to);
}

/** Asserts that `problems` names the break: the check failed, and for the right reason. */
function assertCaught(problems, pattern) {
  assert.match(problems.join('\n'), pattern, because(problems.length ? problems : 'no problems'));
}

/** STAGING with deploy-staging's whole job-level if: replaced by `lines`. */
const gated = (...lines) => edit(STAGING, yaml(...STAGING_IF), yaml(...lines));

// What the staging check reports for a clause the gate does not require, and for a gate that
// requires none of its clauses.
const NOT_PUSH = /does not require github\.event_name == 'push'/;
const NOT_MAIN = /does not require github\.ref == 'refs\/heads\/main'/;
const NOT_ENABLED = /does not require vars\.DEPLOY_ENABLED == 'true': with deploys off, the job /;
const NOT_A_CHAIN = /has a top-level \|\|, so it requires none of its clauses/;
const PAIR = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
// Every clause the gate must require, as one && chain.
const GATE = `${PAIR} && vars.DEPLOY_ENABLED == 'true'`;

// deploy-staging's ship step, as STAGING writes it.
const SHIP = '      - name: Deploy to staging\n';

// What the staging check reports for a step the registry reads that deploy-staging lacks.
const NO_SHIP = /`deploy-staging` has no step named exactly "Deploy to staging"/;
const NO_MIGRATIONS = /`deploy-staging` has no step whose name starts with "Check \+ apply D1 mig/;

/** The step names the reader finds in job `id` of `text`, null for a step it finds unnamed. */
function namesOf(text, id) {
  const workflow = parseWorkflow(text);
  return jobSteps(workflow.lines, workflow.jobs.get(id)).map(stepName);
}

describe('the contract checks catch each way to break it (synthetic workflows)', () => {
  it('pass both baselines, so every failure below comes from its one edit', () => {
    for (const problems of [stagingProblems(STAGING), productionProblems(PRODUCTION)]) {
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it('fail a job-level name: override, wherever the job puts it and however it is quoted', () => {
    const named = /`deploy-staging` has a job-level `name:`/;
    for (const key of ['name', '"name"', "'name'"]) {
      const line = `    ${key}: Deploy to staging\n`;
      assertCaught(stagingProblems(edit(STAGING, '    needs:', `${line}    needs:`)), named);
    }
    // After the steps, a name: is still the job's own key.
    assertCaught(stagingProblems(`${STAGING}    name: Deploy to staging\n`), named);
    const prod = productionProblems(
      edit(PRODUCTION, '    runs-on:', '    name: Ship it\n    runs-on:'),
    );
    assertCaught(prod, /`deploy` has a job-level `name:`/);
  });

  it('fail a renamed job', () => {
    const staging = stagingProblems(edit(STAGING, '  deploy-staging:', '  deploy-to-staging:'));
    assertCaught(
      staging,
      /no job `deploy-staging` directly under jobs: \(jobs found: test, deploy-to-staging\)/,
    );
    assertCaught(
      productionProblems(edit(PRODUCTION, '  deploy:', '  ship:')),
      /no job `deploy` directly/,
    );
  });

  it('fail another job the jobs API can report by a pinned name: the registry would read it too', () => {
    /** A job `id` with these job-level keys, to append under jobs:. */
    const job = (id, ...keys) =>
      yaml(
        `  ${id}:`,
        ...keys.map((key) => `    ${key}`),
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo hi',
      );
    const twin = (id) =>
      new RegExp(`\`notify\` has job-level name: .+, which the jobs API can report as \`${id}\``);
    assertCaught(productionProblems(PRODUCTION + job('notify', 'name: deploy')), twin('deploy'));
    assertCaught(
      stagingProblems(STAGING + job('notify', 'name: deploy-staging')),
      twin('deploy-staging'),
    );
    // However it is quoted, and whatever a ${{ }} in it evaluates to.
    for (const name of [
      '"deploy"',
      "'deploy'  # the twin",
      "' deploy '",
      `\${{ 'deploy' }}`,
      `dep\${{ 'loy' }}`,
    ]) {
      assertCaught(productionProblems(PRODUCTION + job('notify', `name: ${name}`)), twin('deploy'));
    }
    // deploy-${{ }} can be deploy-staging, never deploy.
    const prefixed = job('notify', `name: deploy-\${{ matrix.env }}`);
    assertCaught(stagingProblems(STAGING + prefixed), twin('deploy-staging'));
    assert.deepEqual(productionProblems(PRODUCTION + prefixed), [], because(`deploy-\${{ }}`));
    // A job, or a job name, this pin cannot read could be that second job.
    const unread =
      /this pin cannot read .*, so it could be a second job the jobs API reports as `d/;
    for (const keys of [
      ['name: >-', '  deploy'],
      ['name: *twin'],
      ['name: !!str deploy'],
      ['name: "d\\x65ploy"'],
      ['<<: *defaults'],
      ['"n\\x61me": deploy'],
    ]) {
      assertCaught(productionProblems(PRODUCTION + job('notify', ...keys)), unread);
    }
    for (const lines of [
      '  notify: { name: deploy, runs-on: ubuntu-latest }\n',
      '  "n\\x6Ftify":\n    name: deploy\n    runs-on: ubuntu-latest\n',
      '  <<: *more\n',
    ]) {
      assertCaught(productionProblems(PRODUCTION + lines), unread);
    }
    // A name that cannot be the pinned one passes, like STAGING's `unit tests`.
    for (const name of [
      'smoke',
      'deploy (eu)',
      'Deploy to production',
      `e2e (\${{ matrix.os }})`,
    ]) {
      const problems = productionProblems(PRODUCTION + job('notify', `name: ${name}`));
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it('fail a job that is not directly under jobs:, though its id is in the file', () => {
    const nested = yaml(
      'jobs:',
      '  wrapper:',
      '    deploy:',
      '      runs-on: ubuntu-latest',
      '      steps:',
      '        - run: npm run deploy',
      'deploy:',
      '  steps: []',
    );
    assertCaught(
      productionProblems(nested),
      /no job `deploy` directly under jobs: \(jobs found: wrapper\)/,
    );
  });

  it('fail a missing file', () => {
    assert.equal(
      readWorkflow('no-such-workflow.yml'),
      null,
      because('a missing file must read as null'),
    );
    assert.deepEqual(stagingProblems(null), ['ci.yml is missing'], because('ci.yml missing'));
    assert.deepEqual(
      productionProblems(null),
      ['deploy-prod.yml is missing'],
      because('deploy-prod.yml missing'),
    );
  });

  it('pass a step-level name: (block or compact), an environment name:, a commented one', () => {
    // The baselines carry the first two shapes already; prove it, then add the other two.
    assert.match(
      STAGING,
      /^ {6}- name: Deploy to staging$/m,
      because('fixture: a step-level name:'),
    );
    assert.match(PRODUCTION, /^ {6}name: production$/m, because('fixture: an environment name:'));
    for (const text of [
      // Compact style: each step's `- name:` sits at the job's own key indentation.
      edit(STAGING, yaml(...STAGING_STEPS), yaml(...STAGING_STEPS.map((line) => line.slice(2)))),
      edit(STAGING, '    needs: [test]\n', '    # name: Deploy to staging\n    needs: [test]\n'),
    ]) {
      const problems = stagingProblems(text);
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it('fail the other job-level keys that change the name: a matrix, a workflow call', () => {
    const matrix = edit(
      PRODUCTION,
      '    runs-on:',
      '    strategy:\n      matrix:\n        region: [eu, us]\n    runs-on:',
    );
    assertCaught(productionProblems(matrix), /`deploy` has a job-level `strategy:`/);
    const called = yaml(
      'on: workflow_dispatch',
      'jobs:',
      '  deploy:',
      '    uses: ./.github/workflows/ship.yml',
      '    secrets: inherit',
    );
    assertCaught(productionProblems(called), /`deploy` has a job-level `uses:`/);
    assertCaught(productionProblems(called), /`deploy` has no job-level steps:/);
  });

  it('fail a staging deploy that is not gated to a push to main', () => {
    assertCaught(stagingProblems(edit(STAGING, "github.event_name == 'push' && ", '')), NOT_PUSH);
    assertCaught(stagingProblems(edit(STAGING, "'refs/heads/main'", "'refs/heads/dev'")), NOT_MAIN);
    // A gate that survives only in a comment gates nothing.
    const commented = edit(
      STAGING,
      `          && ${PAIR} }}\n`,
      `          }}\n    # if: ${PAIR}\n`,
    );
    assertCaught(stagingProblems(commented), NOT_PUSH);
    assertCaught(stagingProblems(commented), NOT_MAIN);
    assertCaught(stagingProblems(gated()), NOT_PUSH);
  });

  it('fail a DEPLOY_ENABLED gate anywhere but the top-level && chain of the job if:', () => {
    // On the deploy step instead, the job runs on every merge and ends success, shipping nothing.
    const stepIf = `        if: \${{ success() && vars.DEPLOY_ENABLED == 'true' }}\n`;
    const stepGated = edit(
      edit(STAGING, " && vars.DEPLOY_ENABLED == 'true'", ''),
      '        run: npx wrangler deploy',
      `${stepIf}        run: npx wrangler deploy`,
    );
    assertCaught(stagingProblems(stepGated), NOT_ENABLED);
    const outvoted = edit(
      STAGING,
      "vars.DEPLOY_ENABLED == 'true'",
      "(vars.DEPLOY_ENABLED == 'true' || vars.FORCE_DEPLOY == 'true')",
    );
    assertCaught(stagingProblems(outvoted), NOT_ENABLED);
  });

  it('fail a gate clause an || or a ! can outvote: each must be a top-level && operand', () => {
    for (const [from, to, caught] of [
      // A staging redeploy button: its runs are dispatches, not pushes to main.
      [
        "github.event_name == 'push'",
        "(github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
        [NOT_PUSH],
      ],
      [
        "github.ref == 'refs/heads/main'",
        "(github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/'))",
        [NOT_MAIN],
      ],
      [PAIR, `!(${PAIR})`, [NOT_PUSH, NOT_MAIN]],
      [PAIR, `(${PAIR} || github.event_name == 'workflow_dispatch')`, [NOT_PUSH, NOT_MAIN]],
      // && binds tighter than ||, so one top-level || makes the whole chain optional.
      [PAIR, `${PAIR} || github.event_name == 'pull_request'`, [NOT_A_CHAIN, NOT_PUSH, NOT_MAIN]],
      [' }}', ' || true }}', [NOT_A_CHAIN, NOT_PUSH, NOT_MAIN, NOT_ENABLED]],
    ]) {
      const problems = stagingProblems(edit(STAGING, from, to));
      for (const pattern of caught) assertCaught(problems, pattern);
    }
    // Text beside a ${{ }} makes the whole if: a string, and GitHub reads a string as true.
    const templated = gated(
      `    if: \${{ github.event_name == 'push' }} && \${{ github.ref == 'refs/heads/main' }}`,
    );
    assertCaught(stagingProblems(templated), /ci\.yml:\d+: deploy-staging's .* has text outside/);
    assertCaught(stagingProblems(templated), NOT_PUSH);
  });

  it("read a block scalar's text as written: a # line, a # tail and quotes in it are text", () => {
    // YAML has no comments inside a block scalar, so GitHub reads each of these into the if:, and
    // text beside the ${{ }} makes the whole of it a string, which is always true.
    const outside = /ci\.yml:\d+: deploy-staging's job-level if: has text outside its/;
    for (const text of [
      edit(STAGING, ' }}\n', ' }}\n      # staging deploys only on a push to main\n'),
      edit(STAGING, ' }}\n', ' }} # staging only\n'),
      // Quotes in a block scalar are text too, not YAML's: GitHub reads them around the ${{ }}.
      gated('    if: >-', `      "\${{ ${GATE} }}"`),
      // An indentation indicator counts from the key, two past `if:` here, so this # line at it
      // is the block's text.
      gated('    if: >2-', `      \${{ ${GATE} }}`, '      # note'),
    ]) {
      assertCaught(stagingProblems(text), outside);
    }
    // A # line can close a 'string' the line above it opened, and what follows is then syntax:
    // here an || that outvotes every clause of the gate.
    const reopened = edit(
      STAGING,
      ' }}\n',
      "\n      && vars.NOTE != 'x\n      #' || true\n      }}\n",
    );
    for (const pattern of [NOT_A_CHAIN, NOT_PUSH, NOT_MAIN, NOT_ENABLED]) {
      assertCaught(stagingProblems(reopened), pattern);
    }
    // A # line indented less than the block's text ends the block, and is a comment.
    for (const text of [
      edit(STAGING, ' }}\n', ' }}\n    # staging deploys only on a push to main\n'),
      gated('    if: >2-', `      \${{ ${GATE} }}`, '     # note'),
    ]) {
      const problems = stagingProblems(text);
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it(`fail a block-scalar if: whose YAML keeps whitespace around its \${{ }}`, () => {
    // GitHub reads a ${{ }} with anything beside it, a line break or a space included, as a
    // string, which is always true: this gate would deploy every pull request to staging.
    const outside = /ci\.yml:\d+: deploy-staging's job-level if: has text outside its/;
    const gate = `      \${{ ${GATE} }}`;
    for (const lines of [
      // Every header but a strip (`-`) one keeps the final line break: "${{ … }}\n".
      ['    if: |', gate],
      ['    if: >', gate],
      ['    if: |+', gate],
      ['    if: >+', gate, ''],
      ['    if: |2', gate],
      [
        '    if: |',
        "      ${{ (github.event_name=='push')",
        "        && github.ref == 'refs/heads/main' && (vars.DEPLOY_ENABLED == 'true') }}",
      ],
      // A line deeper than an indentation indicator starts with the spaces past it: " ${{ … }}".
      ['    if: >2-', ` ${gate}`],
      ['    if: >1-', gate],
      // Spaces after the }} are the value's last characters: "${{ … }}  ".
      ['    if: >-', `${gate}  `],
      ['    if: |-', '      ${{', `        ${GATE}`, '      }} '],
      // A blank line before the text is a leading line break: "\n${{ … }}".
      ['    if: >-', '', gate],
    ]) {
      const problems = stagingProblems(gated(...lines));
      assertCaught(problems, outside);
      // A gate GitHub reads as always true requires none of its clauses.
      assertCaught(problems, NOT_PUSH);
    }
    // Without a ${{ }} the if: is an expression, where a line break or a space is no text.
    for (const lines of [
      ['    if: |', `      ${GATE}`],
      ['    if: >+', `      ${GATE}  `, ''],
    ]) {
      const problems = stagingProblems(gated(...lines));
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it('fail closed on an if: over several lines outside a block scalar: YAML folds it, the pin not', () => {
    const several = /ci\.yml:\d+: deploy-staging's job-level if: is a value over several lines/;
    // Inside quotes YAML keeps a # line and a ` # …` tail as text, so it reads each of these as
    // `… && vars.NOTE != 'x #' || true`, a top-level || that outvotes every clause.
    const quoted = GATE.replaceAll("'", "''");
    for (const lines of [
      [`    if: "\${{ ${GATE} && vars.NOTE != 'x`, "      #' || true", '      }}"'],
      [`    if: '\${{ ${quoted} && vars.NOTE != ''x`, "      #'' || true", "      }}'"],
      [`    if: "\${{ ${GATE} && vars.NOTE != 'x`, "      y # ' || true", '      }}"'],
      [`    if: "vars.NOTE != 'x`, "      #' || true || 'y", `      ' && ${GATE}"`],
      // A quote left open on the key's line, though only # lines follow it.
      [`    if: "${GATE} && vars.NOTE != 'x`, `      #'"`],
    ]) {
      const problems = stagingProblems(gated(...lines));
      assertCaught(problems, several);
      // A value it cannot read requires none of the clauses.
      assertCaught(problems, NOT_PUSH);
    }
    // A plain scalar over several lines, which YAML folds to the gate, is refused too: this pin
    // folds none, so it never reads one line of a value as the whole of it.
    assertCaught(
      stagingProblems(gated(`    if: ${PAIR}`, "      && vars.DEPLOY_ENABLED == 'true'")),
      several,
    );
  });

  it('pass a gate however it is spelled, while each clause is a top-level && operand', () => {
    for (const text of [
      // One line and no ${{ }}: GitHub evaluates an if: as an expression either way.
      gated(`    if: ${GATE}`),
      // A quoted YAML scalar, a literal block, no spaces round ==, redundant parentheses.
      gated(`    if: "${GATE}"`),
      gated(
        '    if: |-',
        "      ${{ (github.event_name=='push')",
        "        && github.ref == 'refs/heads/main' && (vars.DEPLOY_ENABLED == 'true') }}",
      ),
      // A strip (`-`) header drops every line break after the }}, a blank line included, and
      // the line breaks and spaces inside the ${{ }} are the expression's.
      gated('    if: >-', '      ${{', `        ${GATE}`, '', '      }}', ''),
      // An indentation indicator that sets the content indentation where the ${{ starts.
      gated('    if: |2-', `      \${{ ${GATE} }}`),
      // An && chain in parentheses requires each of its clauses.
      edit(STAGING, PAIR, `(${PAIR})`),
      // An ||, an && or a parenthesis inside a 'string' is text, not syntax.
      edit(STAGING, ' }}', " && vars.NOTE != 'a || (b && it''s' }}"),
    ]) {
      const problems = stagingProblems(text);
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it('fail a production workflow anything but a human click can start, in any spelling', () => {
    const noDispatch = /on: does not include workflow_dispatch/;
    assertCaught(productionProblems(edit(PRODUCTION, ON_DISPATCH, 'on:\n  push:')), noDispatch);
    // The name in a branch filter is no trigger.
    const branch = "on:\n  push:\n    branches: ['workflow_dispatch']";
    assertCaught(productionProblems(edit(PRODUCTION, ON_DISPATCH, branch)), noDispatch);
    // Beside an automatic trigger, production would ship with nobody clicking.
    for (const [on, event] of [
      ['on: [push, workflow_dispatch]', 'push'],
      ['on:\n- push\n- workflow_dispatch', 'push'],
      [`${ON_DISPATCH}\n  push:\n    branches: [main]`, 'push'],
      [`${ON_DISPATCH}\n  schedule:\n    - cron: '0 3 * * *'`, 'schedule'],
      [
        `${ON_DISPATCH}\n  workflow_run:\n    workflows: [CI]\n    types: [completed]`,
        'workflow_run',
      ],
    ]) {
      assertCaught(
        productionProblems(edit(PRODUCTION, ON_DISPATCH, on)),
        new RegExp(`on: lists ${event}, but production ships only on a human click`),
      );
    }
  });

  it('pass workflow_dispatch alone, in any spelling of on:', () => {
    for (const on of [
      'on: workflow_dispatch',
      'on: [workflow_dispatch]',
      "on: ['workflow_dispatch']",
      'on:\n- workflow_dispatch',
      '"on":\n  workflow_dispatch: {}',
      // An input is no trigger, whatever its text says.
      'on:\n  workflow_dispatch:\n    inputs:\n      why:\n        description: push now',
    ]) {
      const problems = productionProblems(edit(PRODUCTION, ON_DISPATCH, on));
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it('fail a production deploy that does not refuse every ref but main before it migrates', () => {
    // The registry lists production runs on main only: a dispatch from another branch that
    // migrates and ships is a production deploy the ledger never sees.
    const notMainOnly =
      /deploy-prod\.yml: `deploy` does not refuse every ref but refs\/heads\/main/;
    const guard = yaml(...PRODUCTION_GUARD);
    const unguarded = edit(PRODUCTION, guard, '');
    const opens = '          if [ "$REF" != "refs/heads/main" ]; then\n';
    const named = '      - name: Guard, main only\n';
    for (const text of [
      unguarded,
      // After the migrations, the guard refuses once they have run.
      edit(
        unguarded,
        '      - name: Deploy to production',
        `${guard}      - name: Deploy to production`,
      ),
      // Loosened, so a hotfix branch ships too.
      edit(
        PRODUCTION,
        opens,
        '          if [[ "$REF" != "refs/heads/main" && "$REF" != refs/heads/hotfix/* ]]; then\n',
      ),
      // A command ahead of the test, or a nested one inside it, lets another ref past the exit.
      edit(PRODUCTION, opens, `          [ "$REF" = "refs/heads/hotfix" ] && exit 0\n${opens}`),
      edit(
        PRODUCTION,
        '            exit 1\n',
        '            if [ "$REF" != "refs/heads/hotfix" ]; then\n              exit 1\n            fi\n',
      ),
      edit(PRODUCTION, '            exit 1\n', '            exit 0\n'),
      edit(PRODUCTION, `(got '$REF')."`, `(got '$REF')."; exit 0`),
      // A REF that is not the run's ref.
      edit(PRODUCTION, REF, 'REF: refs/heads/main'),
      edit(PRODUCTION, REF, `REF: &ref \${{ github.ref }}`),
      // A step-level key that skips the guard, or runs the job on past it.
      edit(PRODUCTION, named, `${named}        if: false\n`),
      edit(PRODUCTION, named, `${named}        continue-on-error: true\n`),
      // A folded run: block, which YAML joins into other commands.
      edit(PRODUCTION, '        run: |\n', '        run: >\n'),
      // A job-level if: that does not require main is no guard either.
      edit(
        unguarded,
        '    runs-on:',
        "    if: github.event_name == 'workflow_dispatch'\n    runs-on:",
      ),
      edit(
        unguarded,
        '    runs-on:',
        "    if: github.ref == 'refs/heads/main' || true\n    runs-on:",
      ),
      // Nor is one that does: GitHub's == ignores case, so it runs the job from a branch named
      // Main or MAIN too, which the registry, listing main only, would never see.
      edit(
        unguarded,
        '    runs-on:',
        `    if: \${{ github.ref == 'refs/heads/main' && vars.DEPLOY_ENABLED == 'true' }}\n    runs-on:`,
      ),
    ]) {
      assertCaught(productionProblems(text), notMainOnly);
    }
    // A step the registry reads that GitHub runs after the guard refused: a status function, in
    // any case, drops the implicit success(), and an alias or an escape can spell one.
    const ship = '      - name: Deploy to production\n';
    const runsAnyway = /deploy-prod\.yml:\d+: `deploy`'s step "Deploy to production" has an if: wi/;
    for (const gate of [
      `\${{ always() }}`,
      'failure() || success()',
      'Always()',
      '*after',
      `"\\x61lways()"`,
      // YAML keeps a # line inside a block scalar as text, so this if: is
      // `github.ref == 'a #' || always()`, and GitHub runs the step after the guard refused.
      ">-\n          github.ref == 'a\n          #' || always()",
      // Inside quotes too, in either style: YAML folds the # line into the value.
      `"github.ref == 'a\n          #' || always()"`,
      "'github.ref == ''a\n          #'' || always()'",
      // A plain scalar over several lines, which YAML folds to `github.ref != '' || always()`.
      "github.ref != ''\n          || always()",
    ]) {
      assertCaught(
        productionProblems(edit(PRODUCTION, ship, `${ship}        if: ${gate}\n`)),
        runsAnyway,
      );
    }
  });

  it('pass a production deploy gated to main by its guard step', () => {
    const named = '      - name: Guard, main only\n';
    const supabase = '        run: npm run db:migrate:supabase\n';
    for (const text of [
      // A job-level if: that also requires main is no harm beside the guard.
      edit(
        PRODUCTION,
        '    runs-on:',
        `    if: \${{ github.ref == 'refs/heads/main' && vars.DEPLOY_ENABLED == 'true' }}\n    runs-on:`,
      ),
      // The kit's own shape: other env, comments, and a second refusal after the first.
      edit(
        edit(
          PRODUCTION,
          '          fi\n',
          '          fi\n          # and deploys on\n          if [ "$ON" != "true" ]; then\n            exit 1\n          fi\n',
        ),
        `          ${REF}\n`,
        `          ON: \${{ vars.DEPLOY_ENABLED == 'true' }}\n          REF: \${{github.ref}}  # the run's\n`,
      ),
      // Unnamed, or a strip header on its run: block.
      edit(PRODUCTION, `${named}        env:\n`, '      - env:\n'),
      edit(PRODUCTION, '        run: |\n', '        run: |-\n'),
      // An if: with no status function runs a step only after the guard passed.
      edit(PRODUCTION, supabase, `${supabase}        if: env.SUPABASE_DB_URL != ''\n`),
      // bash, named as the guard's shell or as a default, with env bash does not read at start.
      edit(PRODUCTION, named, `${named}        id: guard\n        shell: bash\n`),
      edit(
        PRODUCTION,
        'jobs:\n',
        'defaults:\n  run:\n    shell: bash\n    working-directory: app\nenv:\n  CI: true\njobs:\n',
      ),
      edit(PRODUCTION, '    steps:\n', "    env:\n      NODE_ENV: 'production'\n    steps:\n"),
    ]) {
      const problems = productionProblems(text);
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it('fail a guard that may never run its test: another shell, a startup env, a step ahead', () => {
    const notMainOnly =
      /deploy-prod\.yml: `deploy` does not refuse every ref but refs\/heads\/main/;
    const named = '      - name: Guard, main only\n';
    const refEnv = `          ${REF}\n`;
    // GitHub runs `true <script>` for these, and the guard passes on every ref.
    for (const text of [
      edit(PRODUCTION, named, `${named}        shell: 'true {0}'\n`),
      edit(PRODUCTION, named, `${named}        shell: cat {0}\n`),
      edit(PRODUCTION, named, `${named}        shell: sh\n`),
      // A key the guard has no use for: it is read as no guard, whatever it does.
      edit(PRODUCTION, named, `${named}        working-directory: app\n`),
      // bash sources BASH_ENV, and SHELLOPTS=noexec reads the script and runs none of it.
      edit(PRODUCTION, refEnv, `${refEnv}          BASH_ENV: ./reset-ref.sh\n`),
      edit(PRODUCTION, refEnv, `${refEnv}          SHELLOPTS: noexec\n`),
      // A step ahead of the guard can write BASH_ENV to $GITHUB_ENV, or a bash to $GITHUB_PATH.
      edit(PRODUCTION, named, `      - run: echo "BASH_ENV=$PWD/x.sh" >> "$GITHUB_ENV"\n${named}`),
    ]) {
      assertCaught(productionProblems(text), notMainOnly);
    }
    // The same, set for every step of the job or the workflow.
    const neverRuns = /deploy-prod\.yml:\d+: .* so the guard may never run its test of the ref/;
    for (const text of [
      edit(PRODUCTION, 'jobs:\n', "defaults:\n  run:\n    shell: 'true {0}'\njobs:\n"),
      edit(
        PRODUCTION,
        '    steps:\n',
        "    defaults:\n      run:\n        shell: 'true {0}'\n    steps:\n",
      ),
      edit(PRODUCTION, 'jobs:\n', "defaults: { run: { shell: 'true {0}' } }\njobs:\n"),
      edit(PRODUCTION, 'jobs:\n', 'defaults:\n  run: *shell\njobs:\n'),
      edit(PRODUCTION, 'jobs:\n', 'env:\n  BASH_ENV: ./reset-ref.sh\njobs:\n'),
      edit(PRODUCTION, '    steps:\n', '    env:\n      BASH_ENV: ./reset-ref.sh\n    steps:\n'),
      edit(PRODUCTION, '    steps:\n', '    env: { ENV: ./reset-ref.sh }\n    steps:\n'),
      edit(PRODUCTION, 'jobs:\n', 'env:\n  "B\\x41SH_ENV": ./reset-ref.sh\njobs:\n'),
    ]) {
      assertCaught(productionProblems(text), neverRuns);
    }
  });

  it("fail a deploy workflow another can call: its jobs would run in the caller's run", () => {
    const callable = /:\d+: on: includes workflow_call, so a caller can run this deploy/;
    for (const text of [
      edit(PRODUCTION, ON_DISPATCH, `${ON_DISPATCH}\n  workflow_call: {}`),
      edit(PRODUCTION, ON_DISPATCH, 'on: [workflow_dispatch, workflow_call]'),
    ]) {
      assertCaught(productionProblems(text), callable);
    }
    for (const text of [
      edit(STAGING, '  push:\n', '  workflow_call: {}\n  push:\n'),
      edit(STAGING, 'on:\n  push:\n    branches: [main]\n', 'on: workflow_call\n'),
    ]) {
      assertCaught(stagingProblems(text), callable);
    }
    // A trigger commented out is no trigger.
    for (const problems of [
      productionProblems(edit(PRODUCTION, ON_DISPATCH, `${ON_DISPATCH}\n  # workflow_call: {}`)),
      stagingProblems(edit(STAGING, '  push:\n', '  # workflow_call: {}\n  push:\n')),
    ]) {
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it('read a trailing # comment as a comment: never a gate clause, a trigger or a value', () => {
    // A clause that survives only in a trailing comment requires nothing.
    const kept = "github.ref == 'refs/heads/main' && vars.DEPLOY_ENABLED == 'true'";
    const commented = gated(`    if: ${kept} # && github.event_name == 'push'`);
    assertCaught(stagingProblems(commented), NOT_PUSH);
    assertCaught(
      productionProblems(edit(PRODUCTION, ON_DISPATCH, 'on: push # workflow_dispatch')),
      /on: does not include workflow_dispatch/,
    );
    for (const text of [
      // A comment after a key is no inline value.
      edit(STAGING, 'jobs:\n', 'jobs:  # the suite\n'),
      edit(STAGING, '  deploy-staging:\n', '  deploy-staging:  # ships staging\n'),
      edit(STAGING, 'on:\n', 'on:  # when CI runs\n'),
      // A # inside a quoted scalar is text, so the clauses after it still count.
      gated(`    if: "vars.TAG != ' #x' && ${GATE}"`),
    ]) {
      const problems = stagingProblems(text);
      assert.deepEqual(problems, [], because(problems));
    }
    for (const on of [
      "on:\n  - 'workflow_dispatch' # by hand",
      'on: [workflow_dispatch] # by hand',
    ]) {
      const problems = productionProblems(edit(PRODUCTION, ON_DISPATCH, on));
      assert.deepEqual(problems, [], because(problems));
    }
    // A # glued to a word is text too: that is no trigger GitHub knows, so not workflow_dispatch.
    assertCaught(
      productionProblems(edit(PRODUCTION, ON_DISPATCH, 'on: workflow_dispatch#manual')),
      /on: is spelled in a way this pin cannot read/,
    );
  });

  it('fail closed on what it cannot read: an inline job, a job-level line, an on: list', () => {
    const inline = edit(
      PRODUCTION,
      '  deploy:\n    runs-on: ubuntu-latest\n',
      '  deploy: { name: Ship it, runs-on: ubuntu-latest }\n  other:\n    runs-on: ubuntu-latest\n',
    );
    assertCaught(productionProblems(inline), /job `deploy` carries an inline value/);
    const merged = edit(PRODUCTION, '    runs-on:', '    <<: *defaults\n    runs-on:');
    assertCaught(
      productionProblems(merged),
      /a job-level line in `deploy` this pin cannot read: <<: \*defaults/,
    );
    // A flow mapping, an anchor or an alias could hide a workflow_call this pin would not see.
    const unread = /:\d+: on: is spelled in a way this pin cannot read/;
    for (const on of ['on: { workflow_dispatch: {} }', 'on: *triggers']) {
      assertCaught(productionProblems(edit(PRODUCTION, ON_DISPATCH, on)), unread);
    }
    assertCaught(stagingProblems(edit(STAGING, 'on:\n', 'on: &triggers\n')), unread);
  });

  it('fail a ship step or a migrations step renamed, in either workflow', () => {
    for (const [from, to] of [
      ['Deploy to staging', 'Deploy staging'],
      // Exactly: case counts, and a longer name is another name.
      ['Deploy to staging', 'Deploy to Staging'],
      ['Deploy to staging', 'Deploy to staging now'],
    ]) {
      assertCaught(stagingProblems(edit(STAGING, `- name: ${from}\n`, `- name: ${to}\n`)), NO_SHIP);
    }
    assertCaught(
      stagingProblems(edit(STAGING, '- name: Check + apply D1', '- name: Apply D1')),
      NO_MIGRATIONS,
    );
    const shipIt = productionProblems(
      edit(PRODUCTION, '- name: Deploy to production', '- name: Ship it'),
    );
    assertCaught(shipIt, /`deploy` has no step named exactly "Deploy to production"/);
    // The report names the steps it did find, so the rename is plain to see.
    assertCaught(
      shipIt,
      /\(named steps: Guard, main only \| Check \+ apply D1 migrations \(production\) \| Apply Supabase migrations \(only when SUPABASE_DB_URL is set\) \| Ship it\)/,
    );
    assertCaught(
      productionProblems(edit(PRODUCTION, '- name: Check + apply D1', '- name: Migrate D1')),
      /`deploy` has no step whose name starts with "Check \+ apply D1 migrations"/,
    );
    // The Supabase migrations step changes a database too: renamed, a run that failed in it
    // would read as refused, nothing touched, though Postgres was migrated.
    const NO_SUPABASE = (id) =>
      new RegExp(`\`${id}\` has no step whose name starts with "Apply Supabase migrations"`);
    for (const to of ['Apply Postgres migrations', 'Supabase migrations (staging)']) {
      assertCaught(
        stagingProblems(edit(STAGING, '- name: Apply Supabase migrations', `- name: ${to}`)),
        NO_SUPABASE('deploy-staging'),
      );
    }
    assertCaught(
      productionProblems(edit(PRODUCTION, '- name: Apply Supabase', '- name: Run Supabase')),
      NO_SUPABASE('deploy'),
    );
  });

  it('fail a step name that is only in a comment, under a step key, or in another job', () => {
    const renamed = edit(STAGING, '- name: Deploy to staging', '- name: Ship it');
    for (const text of [
      // A comment line among the steps, and a trailing comment on the renamed one.
      edit(renamed, '      - name: Ship', '      # - name: Deploy to staging\n      - name: Ship'),
      edit(renamed, '- name: Ship it', '- name: Ship it # Deploy to staging'),
      // Under a step's own keys, or in its run: block, a name: is no step name.
      edit(
        renamed,
        '        run: npx wrangler deploy\n',
        yaml(
          '        env:',
          '          name: Deploy to staging',
          '        run: |',
          '          - name: Deploy to staging',
        ),
      ),
      // The job-level name: renames the job; it names no step.
      edit(renamed, '    needs:', '    name: Deploy to staging\n    needs:'),
    ]) {
      assertCaught(stagingProblems(text), NO_SHIP);
    }
    // In the test job, the step is read, and read as the test job's.
    const elsewhere = edit(
      renamed,
      '      - run: npm test\n',
      '      - run: npm test\n      - name: Deploy to staging\n        run: npx wrangler deploy\n',
    );
    assert.deepEqual(namesOf(elsewhere, 'test'), [null, 'Deploy to staging'], because('fixture'));
    assertCaught(stagingProblems(elsewhere), NO_SHIP);
    const prod = yaml(
      edit(PRODUCTION, '- name: Deploy to production', '- name: Ship it').trimEnd(),
      '  smoke:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Deploy to production',
      '        run: npm run deploy',
    );
    assert.deepEqual(namesOf(prod, 'smoke'), ['Deploy to production'], because('fixture'));
    assertCaught(productionProblems(prod), /`deploy` has no step named exactly "Deploy to pro/);
  });

  it('fail two ship steps: the registry reads the first, and could not tell which one shipped', () => {
    const twice = edit(
      STAGING,
      '      - name: Check + apply',
      '      - name: Deploy to staging\n        run: echo dry run\n      - name: Check + apply',
    );
    assertCaught(
      stagingProblems(twice),
      /`deploy-staging` has 2 steps named exactly "Deploy to staging" \(lines \d+, \d+\)/,
    );
    const prod = edit(
      PRODUCTION,
      '      - name: Check + apply',
      '      - name: Deploy to production\n        run: echo dry run\n      - name: Check + apply',
    );
    assertCaught(productionProblems(prod), /`deploy` has 2 steps named exactly "Deploy to prod/);
  });

  it('pass more than one migrations step: the registry reads each of them as mutating', () => {
    // A fork with a second D1 database, or a second Supabase project, migrates each in a step of
    // its own. The registry reads every step with a migrations prefix as one that can touch the
    // environment, so a second needs no other name, and renaming it to dodge the pin would hide it.
    for (const problems of [
      productionProblems(
        edit(
          PRODUCTION,
          '      - name: Deploy to production',
          '      - name: Check + apply D1 migrations (production, analytics)\n' +
            '        run: npm run db:migrate:analytics\n      - name: Deploy to production',
        ),
      ),
      stagingProblems(
        edit(
          STAGING,
          SHIP,
          `      - name: Apply Supabase migrations (again)\n        run: npm run db:migrate:supabase\n${SHIP}`,
        ),
      ),
    ]) {
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it('pass a step name however the step spells it', () => {
    for (const text of [
      edit(STAGING, '- name: Deploy to staging', '- name: "Deploy to staging"'),
      edit(STAGING, '- name: Deploy to staging', "- name: 'Deploy to staging'  # ships it"),
      // Not the step's first key, or on the line after its dash.
      edit(STAGING, SHIP, '      - id: ship\n        name: Deploy to staging\n'),
      edit(STAGING, SHIP, '      -\n        name: Deploy to staging\n'),
      // Comments and blank lines between steps.
      edit(STAGING, SHIP, `\n      # ships it\n${SHIP}`),
    ]) {
      const problems = stagingProblems(text);
      assert.deepEqual(problems, [], because(problems));
    }
  });

  it('fail closed on a step whose name it cannot read: it could be a second of a pinned name', () => {
    const unread = /ci\.yml:\d+: this pin cannot read the name of a step of `deploy-staging`/;
    const ship = '        run: npx wrangler deploy\n';
    const again = '        run: echo again\n';
    // GitHub names each of these "Deploy to staging", a second ship step beside the one it reads.
    for (const step of [
      `      - name: >-\n          Deploy to staging\n${again}`,
      `      - name: Deploy to\n          staging\n${again}`,
      `      - name: "Deploy to\n          staging"\n${again}`,
      `      - name: \${{ 'Deploy to staging' }}\n${again}`,
      '      - { name: Deploy to staging, run: echo again }\n',
      // Quotes keep spaces around a name, which the jobs API may trim to the ship step's name.
      `      - name: "Deploy to staging "\n${again}`,
      `      - name: ' Deploy to staging'\n${again}`,
    ]) {
      assertCaught(stagingProblems(edit(STAGING, ship, `${ship}${step}`)), unread);
    }
    // A step anchored in the test job, which this pin does not read, repeated in deploy-staging
    // by an alias or a merge key.
    const anchored = edit(
      STAGING,
      '      - run: npm test\n',
      '      - &ship\n        name: Deploy to staging\n        run: npm test\n',
    );
    assert.deepEqual(stagingProblems(anchored), [], because(stagingProblems(anchored)));
    for (const step of ['      - *ship\n', `      - <<: *ship\n${again}`]) {
      assertCaught(stagingProblems(edit(anchored, ship, `${ship}${step}`)), unread);
    }
    // A second migrations step in production, its name folded.
    const migrations = edit(
      PRODUCTION,
      '      - name: Deploy to production',
      '      - name: >-\n          Check + apply D1 migrations (retry)\n' +
        '        run: npm run db:migrate\n      - name: Deploy to production',
    );
    assertCaught(
      productionProblems(migrations),
      /deploy-prod\.yml:\d+: this pin cannot read the name of a step of `deploy`/,
    );
    // Nor does it read a name it can only half read: a block header alone, an open quote.
    for (const name of ['>-\n          # Deploy to staging', '"Deploy to staging\n          #"']) {
      const text = edit(STAGING, ship, `${ship}      - name: ${name}\n${again}`);
      assert.deepEqual(namesOf(text, 'deploy-staging').slice(-1), [null], because('fixture'));
      assertCaught(stagingProblems(text), unread);
    }
  });

  it('fail closed on a value behind an anchor, an alias or a tag: a step name, the if:', () => {
    const unread = /this pin cannot read the name of a step of `deploy-staging` \(a name behind an/;
    const again = '        run: echo again\n';
    // A name anchored where this pin does not look, then repeated by an alias.
    const anchored = edit(STAGING, 'jobs:\n', 'env:\n  SHIP: &sn Deploy to staging\njobs:\n');
    // YAML names each of these "Deploy to staging": the node's anchor, alias or tag is no text.
    for (const [text, name] of [
      [STAGING, '&dry Deploy to staging'],
      [STAGING, '!!str Deploy to staging'],
      [anchored, '*sn'],
    ]) {
      const problems = stagingProblems(edit(text, SHIP, `      - name: ${name}\n${again}${SHIP}`));
      assertCaught(problems, unread);
    }
    const migrations = edit(
      PRODUCTION,
      '      - name: Deploy to production',
      '      - name: &again Check + apply D1 migrations (again)\n        run: npm run db:migrate\n' +
        '      - name: Deploy to production',
    );
    assertCaught(
      productionProblems(migrations),
      /this pin cannot read the name of a step of `deploy` \(a name behind an anchor, an alias/,
    );
    // An if: behind one is no expression this pin reads either.
    const behind = /deploy-staging's job-level if: is a value behind an anchor, an alias or a tag/;
    for (const text of [
      gated(`    if: !!str ${GATE}`),
      gated(`    if: &gate ${GATE}`),
      edit(
        gated('    if: *gate'),
        'jobs:\n',
        `env:\n  GATE: &gate \${{ ${GATE} || true }}\njobs:\n`,
      ),
    ]) {
      assertCaught(stagingProblems(text), behind);
    }
  });

  it('fail closed on steps it cannot read: inline, not a list, a name over several lines', () => {
    const unread = /this pin cannot read `deploy`'s steps: because it is inline \(\*common\)/;
    const aliased = edit(PRODUCTION, '    steps:\n', '    steps: *common\n');
    assertCaught(productionProblems(aliased), unread);
    // That is the one problem: the guard may be there, and only this pin cannot see it, so it
    // sends nobody to fix a guard that is not broken.
    assert.deepEqual(
      productionProblems(aliased).filter((problem) => !unread.test(problem)),
      [],
      because(productionProblems(aliased)),
    );
    const flow = edit(
      PRODUCTION,
      yaml('    steps:', ...PRODUCTION_GUARD, ...PRODUCTION_STEPS),
      "    steps: [{ name: 'Check + apply D1 migrations', run: x },\n" +
        '      { name: Deploy to production, run: y }]\n',
    );
    assertCaught(productionProblems(flow), /cannot read `deploy`'s steps: because it is inline/);
    const mapping = edit(
      PRODUCTION,
      '    steps:\n',
      '    steps:\n      name: Deploy to production\n',
    );
    assertCaught(
      productionProblems(mapping),
      /cannot read `deploy`'s steps: because a line in it is no `- ` item/,
    );
    // A name over several lines is not read, so its first line never stands in for all of it:
    // GitHub folds this plain one to "Deploy to staging now", and the block one to the name.
    for (const name of ['Deploy to staging\n          now', '>-\n          Deploy to staging']) {
      const problems = stagingProblems(edit(STAGING, SHIP, `      - name: ${name}\n`));
      assertCaught(problems, NO_SHIP);
      assertCaught(problems, /:\d+: this pin cannot read the name of a step of `deploy-staging`/);
    }
  });

  it('fail closed on a YAML escape it does not decode: in the if:, a key, a step name', () => {
    // YAML decodes a double-quoted scalar's escapes: \x7C and \u007C to |, \x27 to ', \x20 to a
    // space, \x61 to a, \t to a tab. This pin decodes only \" and \\, and refuses every other.
    const escaped = /ci\.yml:\d+: deploy-staging's job-level if: .*with an escape this pin does no/;
    for (const text of [
      // GitHub reads `… || true`, a top-level || that outvotes every clause.
      gated(`    if: "${GATE} \\x7C\\x7C true"`),
      gated(`    if: "\${{ ${GATE} \\u007C\\u007C true }}"`),
      // A \x27 closes the 'string' this pin would read the || inside: `!= 'a' || 'b'`.
      gated(`    if: "${GATE} && vars.X != 'a\\x27 || \\x27b'"`),
    ]) {
      const problems = stagingProblems(text);
      assertCaught(problems, escaped);
      // A value it cannot read requires none of the clauses.
      assertCaught(problems, NOT_PUSH);
    }
    // YAML reads the key "n\x61me" as name:, which renames the job.
    assertCaught(
      stagingProblems(edit(STAGING, '    needs:', '    "n\\x61me": Ship staging\n    needs:')),
      /a job-level line in `deploy-staging` this pin cannot read: "n\\x61me": Ship staging/,
    );
    assertCaught(
      productionProblems(edit(PRODUCTION, '    runs-on:', '    "n\\x61me": Ship it\n    runs-on:')),
      /a job-level line in `deploy` this pin cannot read: "n\\x61me": Ship it/,
    );
    // GitHub names each of these "Deploy to staging" or a migrations step, a second beside the
    // one the registry reads.
    const unread = /this pin cannot read the name of a step of `deploy-staging` \(a name with an /;
    for (const name of [
      '"\\x44eploy to staging"',
      '"Deploy\\x20to staging"',
      '"Check\\x20+ apply D1 migrations (retry)"',
    ]) {
      const step = `      - name: ${name}\n        run: echo again\n`;
      assertCaught(stagingProblems(edit(STAGING, SHIP, `${step}${SHIP}`)), unread);
    }
    // A step key with an escape, which YAML reads as name:, is a line this pin does not read.
    const key = `      - "n\\x61me": Deploy to staging\n        run: echo again\n`;
    assertCaught(
      stagingProblems(edit(STAGING, SHIP, `${key}${SHIP}`)),
      /cannot read the name of a/,
    );
    // YAML reads "o\x6E" as on:, so this pin finds no on: it can read, and could miss a
    // workflow_call in it.
    const noOn = /ci\.yml: no on: this pin can read/;
    const onBlock = 'on:\n  push:\n    branches: [main]\n';
    assertCaught(
      stagingProblems(edit(STAGING, onBlock, '"o\\x6E": [push, workflow_call]\n')),
      noOn,
    );
    // And one renamed by an escape: YAML reads a tab in this one, so it is no ship step.
    const tabbed = stagingProblems(edit(STAGING, SHIP, '      - name: "Deploy to s\\taging"\n'));
    assertCaught(tabbed, unread);
    assertCaught(tabbed, NO_SHIP);
    // \" and \\ decode to themselves, and \\x is a backslash then an x, not an \x escape.
    for (const text of [
      gated(`    if: "vars.Q != '\\"' && vars.P != 'a\\\\x7C' && ${GATE}"`),
      edit(
        STAGING,
        SHIP,
        `      - name: "Deploy \\\\ \\"staging\\""\n        run: echo quoted\n${SHIP}`,
      ),
    ]) {
      const problems = stagingProblems(text);
      assert.deepEqual(problems, [], because(problems));
    }
  });
});

describe('the deployment-target guard checks catch each way to break it (synthetic workflows)', () => {
  const GUARD_JOB = yaml(
    '  deployment-target:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: node scripts/deployment-target.mjs --github-output',
  );
  const TARGET = `needs.${TARGET_GUARD}.result == 'success' && needs.${TARGET_GUARD}.outputs.cial == 'true'`;
  const staging = edit(
    edit(STAGING, '    needs: [test]\n', `    needs: [test, ${TARGET_GUARD}]\n`),
    "          && github.event_name == 'push'",
    `          && ${TARGET}\n          && github.event_name == 'push'`,
  ).replace('  deploy-staging:\n', () => `${GUARD_JOB}  deploy-staging:\n`);
  const production = edit(
    PRODUCTION,
    '  deploy:\n    runs-on: ubuntu-latest\n',
    `${GUARD_JOB}  deploy:\n    needs: [${TARGET_GUARD}]\n    runs-on: ubuntu-latest\n`,
  );
  // edge-live's shape: `check` reads the guard's result and output in a plain one-line if:.
  const edgeLive = yaml(
    'name: edge-live',
    'on:',
    '  schedule:',
    "    - cron: '17 4 * * *'",
    '  workflow_dispatch: {}',
    'jobs:',
    GUARD_JOB.trimEnd(),
    '  check:',
    `    needs: [${TARGET_GUARD}]`,
    `    if: ${TARGET}`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm run verify:edge:live -- --env staging',
  );
  const stagingGuard = (text) =>
    targetGuardProblems(text, 'ci.yml', 'deploy-staging', { clauses: TARGET_GATE, gated: true });
  const productionGuard = (text) => targetGuardProblems(text, 'deploy-prod.yml', 'deploy');
  const edgeGuard = (text) =>
    targetGuardProblems(text, 'edge-live.yml', 'check', { clauses: TARGET_GATE, optional: true });
  const GUARD_STEP = '      - run: node scripts/deployment-target.mjs --github-output\n';

  it('pass the baselines, which also keep the registry contract', () => {
    for (const problems of [
      stagingGuard(staging),
      productionGuard(production),
      edgeGuard(edgeLive),
      stagingProblems(staging),
      productionProblems(production),
    ]) {
      assert.deepEqual(problems, [], becauseTarget(problems));
    }
    // A block sequence is a needs: too.
    const block = edit(
      production,
      `    needs: [${TARGET_GUARD}]\n`,
      `    needs:\n      - ${TARGET_GUARD}\n`,
    );
    assert.deepEqual(productionGuard(block), []);
    // ci.yml's guard runs on a push to main only, which deploy-staging's own gate requires.
    const onMain = edit(
      staging,
      '  deployment-target:\n',
      "  deployment-target:\n    if: github.event_name == 'push'\n",
    );
    assert.deepEqual(stagingGuard(onMain), []);
    // A file an app deleted, where it may, has no problem; the registry's own must be there.
    assert.deepEqual(edgeGuard(null), []);
    assertCaught(productionGuard(null), /deploy-prod\.yml is missing/);
  });

  it('fail a guarded job that does not need the guard, or a workflow without it', () => {
    assertCaught(
      stagingGuard(edit(staging, `    needs: [test, ${TARGET_GUARD}]\n`, '    needs: [test]\n')),
      /`deploy-staging` does not need deployment-target/,
    );
    assertCaught(
      productionGuard(edit(production, `    needs: [${TARGET_GUARD}]\n`, '')),
      /`deploy` does not need deployment-target/,
    );
    assertCaught(productionGuard(production.replace(GUARD_JOB, '')), /no job `deployment-target`/);
    assertCaught(
      edgeGuard(edit(edgeLive, '  check:\n', '  verify:\n')),
      /edge-live\.yml: no job `check`/,
    );
  });

  it("fail a gate without the guard's result or output, or with either outvoted", () => {
    const result = `needs.${TARGET_GUARD}.result == 'success'`;
    const output = `needs.${TARGET_GUARD}.outputs.cial == 'true'`;
    assertCaught(
      stagingGuard(edit(staging, `${result} && `, '')),
      /does not require needs\.deployment-target\.result/,
    );
    assertCaught(
      stagingGuard(edit(staging, ` && ${output}`, '')),
      /does not require needs\.deployment-target\.outputs\.cial/,
    );
    assertCaught(
      stagingGuard(edit(staging, output, `(${output} || vars.FORCE == 'true')`)),
      /does not require needs\.deployment-target\.outputs\.cial/,
    );
    // edge-live's check, with its && flipped to ||, or a manual dispatch let past the guard.
    assertCaught(
      edgeGuard(edit(edgeLive, `${result} && ${output}`, `${result} || ${output}`)),
      /check's job-level if: has a top-level \|\|/,
    );
    assertCaught(
      edgeGuard(
        edit(
          edgeLive,
          `    if: ${TARGET}\n`,
          `    if: ${TARGET} || github.event_name == 'workflow_dispatch'\n`,
        ),
      ),
      /check's job-level if: has a top-level \|\|/,
    );
    assertCaught(
      edgeGuard(edit(edgeLive, ` && ${output}`, '')),
      /check's job-level if: does not require needs\.deployment-target\.outputs\.cial/,
    );
  });

  it('fail a production deploy job that can run after the guard failed', () => {
    const always = edit(
      production,
      `    needs: [${TARGET_GUARD}]\n`,
      `    needs: [${TARGET_GUARD}]\n    if: \${{ always() }}\n`,
    );
    assertCaught(productionGuard(always), /calls a status function/);
  });

  it('fail a guard whose refusal can read as success: continue-on-error on the job or a step', () => {
    const jobLevel = (text) =>
      edit(text, '  deployment-target:\n', '  deployment-target:\n    continue-on-error: true\n');
    const stepLevel = (text) =>
      edit(text, GUARD_STEP, `${GUARD_STEP}        continue-on-error: true\n`);
    for (const [check, base] of [
      [stagingGuard, staging],
      [productionGuard, production],
      [edgeGuard, edgeLive],
    ]) {
      assertCaught(check(jobLevel(base)), /deployment-target job has continue-on-error/);
      assertCaught(check(stepLevel(base)), /deployment-target step has continue-on-error/);
    }
    // A step that hides one behind a line this pin cannot read as a key fails too.
    assertCaught(
      productionGuard(
        edit(production, GUARD_STEP, `${GUARD_STEP}        "continue-on\\x2derror": true\n`),
      ),
      /deployment-target step has a line this pin cannot read/,
    );
  });

  it('fail a guard that can skip: an if: on a step anywhere, or on the job outside ci.yml', () => {
    const stepIf = (text) =>
      edit(text, GUARD_STEP, `${GUARD_STEP}        if: github.event_name == 'schedule'\n`);
    for (const [check, base] of [
      [stagingGuard, staging],
      [productionGuard, production],
      [edgeGuard, edgeLive],
    ]) {
      assertCaught(check(stepIf(base)), /deployment-target step has an if:/);
    }
    const jobIf = (text) =>
      edit(
        text,
        '  deployment-target:\n',
        "  deployment-target:\n    if: github.ref == 'refs/heads/main'\n",
      );
    assertCaught(productionGuard(jobIf(production)), /deployment-target job has an if:/);
    assertCaught(edgeGuard(jobIf(edgeLive)), /deployment-target job has an if:/);
  });
});
