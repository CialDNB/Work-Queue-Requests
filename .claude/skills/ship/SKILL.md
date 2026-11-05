---
name: ship
description: Open a PR, get every gate green, review before merge, squash-merge, and update Linear — the definition of done for a change. Use when a piece of work is ready to merge.
---

# /ship — done means merged, green, reviewed, and tracked

**Prime directives apply** (CLAUDE.md). Shipping is mechanical when the work is
actually done; this skill is the checklist that proves it.

**Deployment target first.** Run `node scripts/deployment-target.mjs` (or
`npm run -s deployment-target`, where `package.json` has it). It prints the app's target:
- `cial`: the steps below, as written. An app with no `scripts/deployment-target.mjs` predates
  the targets and is CIAL too. If the app also has a release caller
  (`.github/workflows/il-paved-road-release.yml`), it is dual-delivered: the CIAL staging deploy
  runs as below, and the merge also starts a central release, so **DB Israel apps** below applies
  to it too, apart from its one DB Israel-only rule.
- `dbisrael`: a DB Israel app, delivered centrally. The steps are the same up to the merge;
  **DB Israel apps** below says what a merge does.
- It exits 1: stop. The deployment marker is invalid, or missing in an app that shows a sign of
  DB Israel delivery. Which target the app has is the owner's decision, made in a reviewed PR;
  never write the marker yourself to get past it.

## Steps

1. **Scope check:** `git status` + `git diff` — only files this task needs. Protected-
   core files in the diff? They need their own PR and a code-owner review; split now.
   You are on a feature branch, never main (CLAUDE.md: Git workflow) — if work somehow
   started on main, move it to a branch now (`git switch -c <type>/<slug>`).
2. **Gates on the final tree:** `npm run ci` — the full local gate set, including coverage,
   tripwires, hook/script tests and guards. A successful run from the preceding skill counts
   if every input is still unchanged (source, tests, config, dependencies and environment,
   including uncommitted/untracked files). Record its command/result; a new skill invocation
   alone does not justify repeating it. Edits after verification require another final-tree
   run. `verify:deps` needs the npm registry; the tests themselves are offline. If
   semgrep/gitleaks/actionlint are installed locally run them too; otherwise CI is the wall.
   Do not claim checks you did not run. See `docs/TESTING.md`.
3. **Self-review the diff** like a stranger: no leftover debug code, no commented-out
   blocks, no TODO without a Linear issue, comments explain WHY not what, synthetic
   data only. Review changed tests too: what failure does each detect, is its oracle independent
   of the implementation, and does it use the cheapest runtime that preserves the contract?
   For any test addition, review runtime placement, repeated setup and meaningful boundary
   cases. For a kit upgrade, check that the PR body has `/kit-upgrade`'s test-performance
   closeout line and, when it says "Audit triggered", the dated audit (or the follow-up PR that
   holds it) with its evidence-backed change or evidenced no-change decision.
4. **Commits:** atomic and bisectable; renames separate from behavior changes.
5. **PR:** `gh pr create` with: what changed (user-visible first), how it was verified
   (paste the test summary line), any DECISIONS.md entries added, the Linear issue
   link. Keep it readable by someone who wasn't in the session.
6. **CI green** on the PR — watch it (`gh pr checks --watch`). A red gate is YOUR
   signal: fix root-cause, never weaken the gate.
7. **Review before merge:** run `/code-review` on the PR and resolve real findings
   (raise its effort — `high`/`max` — for protected-core / auth / security diffs).
   The checkpoint sits before merge — never review after the fact.
8. **Squash-merge:** `gh pr merge --squash --delete-branch` — the PR title becomes
   the commit subject on main. Never merge red or unreviewed; never push the
   branch's commits to main directly.
9. **Linear:** move the issue to In Review when the PR opens; after merge +
   verification, Done. The standing rule applies: close the session with a comment on
   what shipped.

Staging auto-deploys on merge to main (once DEPLOY_ENABLED) and smoke-checks /_health —
watch that too. Production is NOT part of /ship; that's /go-live.

## DB Israel apps

These are for every app with a release caller: a DB Israel app, and a dual-delivered app (a
`cial` marker and a caller). The steps are the same. What the merge in step 8 starts is a central
release, and in a DB Israel app it is the only one:

- **Follow the release, not a deploy job.** The app's `il-paved-road-release` run on main asks
  the central pipeline to build and release the merged commit. Open that run's summary and follow
  it to the central run's final summary: success names the release id (`r<run-id>-<attempt>`) and
  the staging URL. A dispatch, a skip or a refusal is not a release. A failed migration or a
  missing runtime secret stops it, and the summary says which.
- **Before enrollment, that run is expected to be red**: the platform has not granted its
  trigger secret yet. It turns green once the platform enrolls the app; don't "fix" it.
- **Don't re-dispatch an ambiguous run.** Follow it, and ask a platform operator for a manual
  staging deploy or redeploy.
- **DB Israel only: never add `DEPLOY_ENABLED` or a `CLOUDFLARE_API_TOKEN` secret** to make a
  deploy happen. The CIAL `deploy-staging` job skips by design, and either one turns its
  `deployment-target` guard red. A dual-delivered app keeps its own: its CIAL pipeline is live.
- **In an enrolled app, only an org admin can push a change under `.github/workflows/`,** on any
  branch, and merge a PR that has one. Keep workflow edits out of feature PRs, and hand them to an
  org admin as a PR of their own. A `/kit-upgrade` is the exception: its workflow hunks go on the
  upgrade's own branch, because the tests it carries pin them.
