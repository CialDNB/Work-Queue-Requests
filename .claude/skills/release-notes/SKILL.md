---
name: release-notes
description: Prepare a stakeholder-facing release-notes presentation at milestones (go-live, an adopted kit-upgrade, a big project/epic done) and weekly while the app is actively developed. Publishes to docshub when that MCP is connected, otherwise writes a self-contained HTML deck under docs/release-notes/. Use when a milestone lands or for the weekly update.
---

# /release-notes — turn what shipped into a deck people will actually read

**Prime directives apply** (CLAUDE.md): synthetic data only, even in screenshots; a deck
shared outside the team is an outward-facing publish — confirm before sending. Audience is
**stakeholders and users**, not engineers: lead with what's new and why it matters, keep the
commit-by-commit detail in an appendix.

## Steps

1. **Decide the window — and whether one is warranted.** Find the last release notes (newest
   file in `docs/release-notes/`, or the app's docshub deck; else the go-live date, else the
   first commit). The window is everything merged since. The occasion is one of: a **milestone**
   (`/go-live`, an adopted `/kit-upgrade`, a big project/epic closed) or the **weekly** active-
   development update. If nothing user-visible changed in the window, say so and stop — never
   manufacture a milestone.

2. **Gather the material** through a stakeholder lens (translate changes into value, not diffs):
   - Merged PRs: `gh pr list --state merged --search "merged:>=<date>" --json number,title,mergedAt,url`
     — under the PR flow the squash titles are already human-readable.
   - Linear issues moved to **Done** in the window (Linear MCP) — the canonical "what shipped".
   - `CHANGELOG.md` entries, any `/kit-upgrade` adopted, notable `docs/DECISIONS.md`.
   - Optional but powerful: a couple of screenshots from a `/qa` pass on staging for visual proof.
   - Group into themes — **New capabilities / Improvements / Fixes / Security & ops / What's next** —
     and write each in plain language (names and outcomes, not jargon).

3. **Build the deck** as a **self-contained HTML presentation** (one file, opens in any browser).
   If the `extend-html-presentation` skill or `docshub_template` is available, start from it;
   otherwise build the HTML directly — either way both delivery paths in step 4 share one format:
   - Title: app display name, "Release notes — `<date>`" or the milestone name, the period covered.
   - 3–6 highlight slides, one theme each: what's new + why it matters, a screenshot where it helps.
   - Metrics if you have them: issues closed, /_health uptime, AI spend (within the $50/day cap).
   - **What's next:** the next epic or open items, so the deck looks forward as well as back.
   - **Appendix:** the full PR-title list for the detail-minded.
   - Synthetic data only in every screenshot — the no-real-data rule covers decks too.

4. **Deliver — detect docshub at run time** (the `.mcp.json` ships it, but a builder may not have
   authenticated or have access):
   - **docshub IS connected** (the `docshub_*` tools resolve) → publish there. `docshub_list` to
     find this app's existing release-notes deck: if one exists, add a new version
     (`docshub_update`, or a draft finalized with `replace_short_id`); if not, `docshub_upload` a
     new deck named "`<Display Name> — Release Notes`". Capture the share URL + short_id.
   - **docshub is NOT connected** → write the deck to
     `docs/release-notes/<YYYY-MM-DD>-<slug>.html` (self-contained, versioned in the repo) and
     update `docs/release-notes/index.md`. It can be pushed to docshub later once connected.

5. **Record and route:**
   - Add the entry to `docs/release-notes/index.md` (date, occasion, link or path, one-line summary).
   - Linear: comment on the project with the link and the summary — part of the standing
     end-of-session update.
   - Sharing the docshub link beyond the team is outward-facing: confirm with the builder first.

6. **Keep the cadence going.** This skill is the doer; the practice is the policy (CLAUDE.md
   "Release notes"). Run it at every milestone — `/go-live`, after `/kit-upgrade` adopts changes,
   and when a big project/epic closes. **Weekly while active:** if the app has merges in the last
   7 days and no release notes in the last 7, offer to set up a recurring weekly run via
   `/schedule` where that skill is available (an opt-in scheduled cloud agent that runs
   `/release-notes`). Don't schedule
   dormant or throwaway apps; a quiet week self-skips at step 1, so the scheduled run is harmless
   when there's nothing to say.
