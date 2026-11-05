---
name: plan-to-graph
description: Turn a phased plan into a dependency graph — nodes with t-shirt sizes, hard/soft edges each traced to a quote, the critical path, the parallel waves, and a runnable workflow skeleton segmented at decision points. Use when a plan needs sequencing, or to find what can actually run in parallel.
---

# /plan-to-graph — turn a phased plan into what can actually run in parallel

**Prime directives apply** (CLAUDE.md). Size work by structure, never wall-clock: t-shirt
sizes and dependency edges, never days. A plan's phase *order* is usually prose habit —
this skill finds the order the dependencies actually require, which is often wider.

Read the target plan first: the argument if one was given, otherwise `docs/PLAN.md` or a
`docs/*-PLAN.md` in this repo (`docs/MODULARIZATION-PLAN.md`,
`docs/sensitive-data-capability-PLAN.md`), otherwise the plan pasted into the session. If
you can't find one, ask which plan — don't guess.

## The core

The steps below are the requester's own framing, kept verbatim; "I" and "me" are the
person who invoked the skill.

> Read <docs/PLAN.md — or the pasted phased plan> and turn it into a dependency graph.
>
> 1. Extract every phase/workstream as a node. For each: a short id, name, t-shirt
>    size (XS–XL), whether it ships standalone, and its key deliverable in one line.
> 2. Extract edges. Hard dependency = "must land before Y can start"; soft = "informs
>    Y but doesn't block it". Only add an edge you can justify with a quote from the
>    doc — list any edges you inferred separately so I can veto them.
> 3. Derive: the critical path (longest chain of hard deps), the parallel waves
>    (Wave 1 = no deps, Wave 2 = depends only on Wave 1, …), and any decision points
>    where the graph branches on a choice I have to make.
> 4. Output, in order: a Mermaid flowchart TD (nodes "Name (size)", solid arrows for
>    hard deps, dotted for soft, diamonds for decisions, critical path highlighted);
>    a wave table showing max parallelism; the inferred-edges list.
> 5. Also output a runnable .claude/workflows/plan-executor.js skeleton implementing
>    the graph: export const meta with one phase per wave; each node an agent() call
>    whose prompt includes its deliverable line and the outputs of its hard-dep
>    parents; waves as sequential stages with parallel() inside; soft deps passed as
>    context strings, not awaited. Segment the script at decision points — end each
>    script where a decision I must make begins, return what was built plus the
>    decision needed, and note which follow-up workflow each choice leads to.
> 6. Before outputting, verify: no cycles, every phase appears exactly once, and
>    every hard edge traces to a sentence in the plan.

## Verify before you output

Step 6 is the graph's correctness check. The emitted script has three of its own, and a
script that fails any of them is not runnable — check them, don't assume:

- **Plain JavaScript, not TypeScript.** No type annotations, interfaces, or generics —
  they fail to parse.
- **No `Date.now()`, `Math.random()`, or argless `new Date()`.** They throw in a workflow
  script (they would break resume). Pass timestamps in as arguments, or stamp results
  after the workflow returns.
- **`meta` is a pure literal.** `export const meta = { name, description, phases }` with
  no variables, function calls, spreads, or template interpolation. Phase titles in `meta`
  must match the `phase()` calls exactly.

Sanity-check the file parses (`node --check .claude/workflows/<name>.js`) before you call
it done.

## Where the skeleton goes

Write it to `.claude/workflows/<plan-slug>.js` — `plan-executor.js` is the default name,
but name it after the plan when you're emitting more than one. Two things to say out loud
when you do:

- `.claude/` is **protected core** (CODEOWNERS-gated). A committed workflow script needs
  its own PR and a code-owner review, like any harness change.
- Workflow scripts reach template forks and `/kit-upgrade`, but **not** `/plugin install`
  users — the plugin manifest carries commands, skills, and hooks only.

## Then what

The graph is the deliverable; running it is a separate, explicit decision. Before invoking
any emitted workflow, re-read the gating and cost rules in `docs/WORKING-WITH-CLAUDE.md` —
especially the segment-at-decision-points rule, which is what step 5 is implementing. Keep
the first run small and pointed at a slice of the work, not the whole plan.
