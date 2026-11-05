# Working with Claude on a paved-road app

Most of what makes an app good is decided in ordinary back-and-forth with Claude: you
describe what you want, it builds, you look at it, you correct it. That loop is the
default and it is not a lesser mode — it is the mode almost everything ships from.

This page is about the small number of times it is *not* the right mode: when a task is
better run as a **dynamic workflow** — Claude fanning out into many parallel agents that
each do a slice of the work. Knowing when to reach for that (and, more often, when not
to) is becoming a real skill. This is the kit's take on it.

> **One thing to know up front:** unlike everything else in this kit, none of this is
> CI-enforced. There is no gate that fails when a session fans out where it shouldn't.
> The invariants in [CLAUDE.md](../CLAUDE.md) hold because the framework makes their
> absence impossible; this page holds only because you read it.

---

## First: most "I need more power" moments are a skill you forgot

Before reaching for anything exotic, check whether the kit already has a paved path.
The thirteen skills in `.claude/skills/` are a virtual team - `/add-endpoint`,
`/add-page`, `/add-job`, `/security-review`, `/qa`, `/ship`, `/go-live`, and the rest
(the full map is [PLAYBOOKS.md](PLAYBOOKS.md)). A session that feels stuck is usually a
session freestyling something a skill already choreographs.

Also worth knowing: `/code-review` is the pre-merge review gate, and it takes an
**effort** level. For protected-core, auth, or security diffs, raise it (`high` / `max`)
rather than reaching for something bigger. That is the kit's answer to "this change
deserves more scrutiny" — see [DECISIONS.md](DECISIONS.md) 2026-06-17.

## The default is one session

Stay linear when:

- **The task is one sentence.** "Add a status field to notes." "Fix the failing test."
  Fan-out has real setup cost; a task that fits in one session should stay in one.
- **You will want to steer.** If you expect to look at something halfway and say "no,
  not like that" — stay linear. See the constraint below.
- **The steps depend on each other.** Fan-out buys you nothing when step 2 can't start
  until step 1 finishes. That's a queue, not a fan-out.
- **You don't know what you want yet.** Exploration is conversational. Workflows are for
  work whose shape you already understand.

## When a workflow is actually the right tool

Reach for one when the work is **many independent units of the same kind** — enough that
doing them one at a time in a single session would either take forever or blow past what
one context can hold. In practice that's four shapes:

| Shape | Example |
| --- | --- |
| **Review / audit** | Sweep every route for a specific invariant, one agent per surface |
| **Migration** | Change the same pattern at 40 call sites |
| **Research** | Read 15 sources and synthesize, each read independent |
| **Scale one context can't hold** | Anything where the file list alone would fill the window |

The test is **independence**, not size. Forty call sites that each need the same
mechanical edit is a workflow. Forty call sites where each edit depends on what you
learned from the last one is a linear session.

## The constraint that decides most cases: no mid-run input

**A workflow cannot stop and ask you something.** Once it starts, it runs to completion
and hands you a result. There is no "wait, which of these two did you mean?"

So anything that needs a decision from you partway through either:

- **stays linear**, or
- **gets segmented** — you end the workflow where the decision begins, it returns what it
  built plus the question, you answer, and a follow-up workflow picks up from there.

Segmenting at decision points is the single most useful habit here. A plan with three
places you'll need to choose something is three workflows, not one.

## What it costs, and how to keep that sane

A workflow spends tokens roughly in proportion to `agents × work per agent`, and it is
easy to write one that spends far more than the task was worth. Four habits:

1. **Keep them small.** Default to fewer than ~10 agents. Claude Code ships a size
   guideline you can raise or lower under **Dynamic workflow size** in `/config` — leave
   it low and let a genuinely big job be the exception you opt into.
2. **Put cheap models on mechanical stages.** Reading a file and extracting a list
   doesn't need the top-tier model; pass `{model: 'haiku'}` on those stages and save the
   strong model for judgment.
3. **Give every agent a schema.** A structured-output schema on each `agent()` call means
   the result comes back validated instead of as prose you have to re-parse — fewer
   retries, less waste, and the script can actually branch on the result.
4. **Test on a slice first.** Run against three items before you run against sixty. A bug
   in the prompt costs you three agents instead of all of them.

## When *not* to — the expensive mistakes

- **Unbounded loops.** "Keep looking until you find everything" with no stopping
  condition. Always bound it: a target count, a budget check, or "stop after two rounds
  that find nothing new."
- **One-turn tasks.** Wrapping a single question in orchestration. If one agent would
  answer it, ask directly.
- **Redundant verification.** Spawning five agents to check the same claim the same way
  gets you one opinion five times. If you want real verification, give each verifier a
  *different* angle (does it reproduce? is it a security issue? is the fix correct?) —
  otherwise use one.
- **Anything touching production.** Deploys, migrations, and go-live stay human-gated and
  linear. See [GO-LIVE.md](GO-LIVE.md).

## When agents write files in parallel

If several agents will edit files at the same time, they need isolation or they'll
clobber each other. Run them in separate git worktrees (`isolation: 'worktree'`) so each
gets its own checkout. It costs setup time and disk per agent, so use it only when agents
genuinely mutate files concurrently — not for read-only sweeps.

This is also the general rule for parallel *sessions* in this repo, workflow or not:
one worktree per concurrent session, never two sessions sharing a working tree. See
CLAUDE.md → "Parallel work — use git worktrees".

## Turning a plan into something runnable

When you have a phased plan and want to know what can actually run in parallel, use
**`/plan-to-graph`**. It reads the plan, extracts each phase as a node, works out which
dependencies are real (quoting the plan for each one, and listing what it inferred so you
can veto it), and gives you a dependency graph, the critical path, the parallel waves —
and a runnable workflow skeleton, already segmented at the points where you have a
decision to make.

That last part matters: it's the habit from "no mid-run input" turned into a tool, so you
don't have to remember to apply it yourself.

---

## The short version

Stay linear. Use the skills. When you have many independent units of the same kind, fan
out — small, schema'd, cheap models on the mechanical parts, tested on a slice first.
Segment wherever you'll need to make a decision. And remember that nothing here is
enforced by CI, which means the judgment is genuinely yours.
