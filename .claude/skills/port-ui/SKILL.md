---
name: port-ui
description: Port an existing app's full design system and UI/UX onto the kit's SPA so the paved-road version looks and behaves like the original, not the kit's default theme. Use whenever an app is being migrated onto the kit (Tier 2 /paved-road:adopt, /new-app from an existing product), when a ported app "looks like the template", or before porting any screen of an existing app.
---

# /port-ui - the port keeps its face

**Prime directives apply** (CLAUDE.md). The full method and its rationale: `docs/DESIGN-PORT.md`.

The kit's `web/src/styles.css` is a neutral baseline for **greenfield** apps. A port is not
greenfield: users already know the original, and someone already approved its design. Porting
the logic and letting the screens fall back to the kit look is a regression, not a neutral
choice. **The running original is the spec**: its code and its screenshots outrank the kit
baseline, `docs/DESIGN-PROMPT-TEMPLATE.md` and your own taste.

What changes in a port is the plumbing, never the face:

| Stays as in the source | Becomes the kit's |
|---|---|
| tokens, fonts, colours, radii, shadows, motion | data layer → typed `api.*` / `call()` (no react-query, no ad-hoc fetch) |
| app shell layout (sidebar/topbar/regions/footer) | routing → `useRoute` + the view registry (`web/src/views.ts`) |
| class names and component structure | auth → the kit login (magic link / SSO), uniform 404 |
| page layouts, copy, empty/loading wording | permission gating → `permission` on the view, the API still 404s |
| interaction patterns (toasts, overlays, boards) | assets → self-hosted under `web/public/` (CSP) |

## Phase 0 - preflight

1. **Find the source.** Look in this order: `.paved-road/design.json` (`source.path` /
   `source.repo` / `source.runUrl`); then `.paved-road/adopt.json` → `provenance.brandDoc` and
   `.paved-road/brand.json`. Otherwise ask the user where the original lives. Never guess
   between similarly named folders. Record the answer in design.json (Phase 1) so no later
   session has to ask.
2. **Run both apps, both on synthetic data.** Run the original on its own port, on this machine
   (follow its README or run docs), but **never on its real database**: seed it with synthetic
   records, or a scrubbed copy with no real names, amounts or identifiers. Its screenshots go to a
   subagent, into the contract's notes and into a published report, so real records must not be in
   them (CLAUDE.md "Synthetic only"). If the original cannot run without real data, stop and ask the
   user; don't run parity on it. Record `source.data: "synthetic"` in design.json (Phase 1): the
   parity runner refuses to run without it, and refuses a source that is not on this machine unless
   you pass `--allow-remote-source` for a host that also serves synthetic data only. Run the port
   with `npm run build:web && npx wrangler dev --port <free> --var APP_ENV:development`, seed it
   with synthetic data, and log in per GUIDEBOOK "First login". Check ports before starting
   (`lsof -i :<port>`), and never start a second instance of either app.
3. **Work on a branch** (`feat/port-ui-<slug>`). If the app's harness copy needs updating, that
   goes in its own PR, separate from the UI port.
4. **Locate this skill's scripts.** `parity.mjs` and `scope-kit-css.mjs` sit next to this
   SKILL.md, in the skill's base directory (Claude Code shows it when the skill loads). That is
   `.claude/skills/port-ui/` in a repo that carries the kit's harness, and the plugin's own copy
   when you run `/paved-road:port-ui` in one that doesn't yet (an app that has not run
   `/kit-upgrade` since 1.5.0). Below, `<skill-dir>` means that directory: use its absolute path,
   never assume the repo path.

## Phase 1 - inventory → design contract

1. Delegate the read to the **`ui-inventory`** agent, giving it the source frontend path. It
   returns, with file paths:
   - token families, fonts and assets
   - the shell and the component vocabulary
   - pages and interaction patterns
   - dead code and CSP blockers
2. Write `docs/design/DESIGN-CONTRACT.md` from `references/design-contract.template.md`.
   Reviewers check the **screen map** (source route → kit view id → page file) and the
   **forced deltas** table, so fill every row of both.
3. Write `.paved-road/design.json` (schema: `references/design.schema.md`) with:
   - `mode: "port"`
   - the source pointers (a repo-relative `source.path`, never one that contains the kit's name:
     `verify:bootstrap` scans this file), `source.data: "synthetic"` (Phase 0), and the theme dir
   - `screens[]`, with concrete paths for each side
   - `viewports`

   From then on, the `warn-design-drift` hook warns on raw colours and own fonts in any edit
   under `web/src/` outside the theme directory, and on remote assets anywhere, the theme and
   `web/index.html` included.
4. Show the user the screen map and the deltas before building. Everything after this is
   mechanical.

## Phase 2 - theme layer (verbatim, then bridged)

1. Copy the source stylesheets **verbatim** into `web/src/theme/`, one file per source
   stylesheet (e.g. `tokens.css`, `app.css`). Keep the original class names: they are what lets
   JSX port 1:1. Strip only what the kit forbids: remote `@import`s and CDN `url()`s, which the
   CSP blocks.
2. Self-host fonts, logos and images under `web/public/` (`fonts/`, `brand/`), and repoint the
   `@font-face` and `url()` paths. If the source used a font CDN, download the files (check the
   licence) rather than loosening the CSP. `web/public/_headers` is protected core; don't touch
   it.
3. **Isolate the kit baseline. Don't load it globally.** `web/src/styles.css` styles bare
   elements (`button`, `select`, `table`, `th`/`td`, `nav`, `main`, `footer`) and generic classes
   (`.app`, `.card`, `.topbar`, `.brand`). Loaded next to the source theme, those rules leak into
   every ported screen: kit-blue buttons, full-width selects, and a 1180px `.app` that breaks a
   sidebar layout. A token bridge can't undo a property the theme never sets. So:
   - Run `node <skill-dir>/scope-kit-css.mjs`. It writes
     `web/src/theme/kit-scoped.css`: every kit selector prefixed with `.kit-page`, every kit
     variable renamed to `--kit-*`, and `:root`/`body` rules dropped.
   - In `main.tsx`, import the theme **instead of** `./styles.css`. Leave `styles.css` itself
     untouched. It is app-owned, so `/kit-upgrade` does not carry it: the kit's changes to it
     arrive as CHANGELOG manual steps, which then apply to it as written. After applying one,
     re-run the script; `--check` says when the copy is stale (Phase 6 and `/kit-upgrade` run
     it).
   - Wrap the kit's own pages (Login form, Users, Audit, Tokens, Settings, and app pages you
     don't port) in `<div className="kit-page">`.
4. **Token bridge.** Write `web/src/theme/bridge.css`, a `:root` block that maps the `--kit-*`
   variables onto source tokens (`--kit-accent: var(--brand-deep)` and so on). The kit's pages
   then read as the same product. Theme entry order: `kit-scoped.css`, then the source CSS,
   then `bridge.css`. Never write `--x: var(--x)`: a self-reference is a cycle, and CSS drops
   it. The `--kit-*` namespace exists precisely so the two vocabularies never share a name.
5. **Literals the source wrote inline in page code** (an overlay rgba, a chart palette, `#fff`)
   become tokens in `bridge.css`, with the same values, and the page uses `var(--…)`. Same
   pixels, and the drift hook stays quiet.
6. **Lint vs verbatim CSS.** The kit formatter reflows the copied CSS (whitespace only, which
   is fine). If biome flags rules in it (`!important`, specificity order), add a
   `/* biome-ignore <rule>: verbatim from the original theme */` comment. Don't edit the rule:
   reduced-motion overrides and similar rules depend on it.
7. If the source uses Tailwind, CSS-in-JS or a UI kit, port the **rendered result**, not the
   toolchain, unless the user decides otherwise. Extract the effective values into theme CSS and
   classes. Any new dependency must have been published more than 24h ago
   (`npm run verify:deps`) and be justified in DECISIONS.

## Phase 3 - shell (presentation swapped, semantics kept)

Rebuild the source layout in `web/src/shell/` (e.g. `AppShell.tsx`, `Sidebar.tsx`,
`Topbar.tsx`) and render it from `App.tsx`. It **must** keep the kit's semantics:

- Nav entries come from the view registry, filtered by `can(permission)`: `APP_VIEWS` in
  `web/src/views.ts`, or the `FEATURE` / `SETTINGS` arrays in `App.tsx` on kits from before
  views.ts. Never a hard-coded list.
- Navigation goes through `useRoute` (`navigate(id)`), so Back and Forward work
  (DECISIONS 2026-08-03).
- Kit `settings` views live in the source's admin or settings area.
- Logout goes through `api.logout()`; the user box comes from `api.me()`.
- Source-only conveniences that bypass auth (dev "act as" switchers, anonymous pages) are dropped
  and listed as deltas.

Nav metadata the registry lacks (icons or glyphs, "NEW" badges, ordering) goes in a small
presentation map in `web/src/shell/`, keyed by view id. Don't widen `AppView`.

## Phase 4 - screens, one view per commit

For each screen-map row, in the contract's build order:

1. Open the source page and port its **JSX structure and classNames as they are**. Replace only:
   - the data layer: `useQuery`/`fetch` become `api.*` via `call()`. If an endpoint is missing,
     run `/add-endpoint` first.
   - navigation: `<Link>`/`useNavigate` become `navigate(...)`.
2. Keep the loading, error and empty states, with the source's wording and visuals. Where the
   source had none, add them in its style.
3. Lift duplicated page-local pieces (KPI tiles, pills, charts) into `web/src/shell/` or
   `web/src/components/` once, without restyling them.
4. Drop dead source code (unrouted pages, unused components) and say so in the contract.
5. Copy text through unchanged, with these exceptions:
   - em and en dashes become a hyphen
   - locale-driven labels get `dir="auto"` (for RTL languages)
   - no real names, salaries or clients in fixtures or seeds
6. **Match the source's markup quirks when CSS depends on them.** For example, if the source's
   CSS styles only `input[type=text]` and its JSX left `type` off, leave it off: adding it
   restyles the field.
7. **Kit lint rules the source breaks:** fix them accessibly, without changing a pixel:
   - `<button>` gets `type="button"`, and decorative `<svg>` gets `aria-hidden="true"`.
   - `innerHTML`/`dangerouslySetInnerHTML` icon swaps become two children toggled by `display`.
   - `<li role="link" onClick>` becomes `<li><a href>` with `.nav li > a { display: contents }`
     in the bridge (the layout stays put, and links get middle-click and keyboard).
   - Keep a `div[role=group]` segmented control (a `<fieldset>` changes its look), with a
     `biome-ignore` comment that says why.
8. **API payload gaps.** If the source screen shows data the kit route doesn't return (an owner
   name, a count, a linked record's title), extend the route in `src/routes/` with a test.
   Before you return a related record's fields, check **the caller's** access to it, not just
   the record owner's. A delegated task once nearly exposed another region's candidate name.
9. Run `npm run typecheck && npm run lint && npm run build:web` before each commit.

## Phase 5 - parity loop (until no P0/P1)

1. Fill in the `screens[]` paths for both sides (ids differ between the two databases), then
   run:

   ```
   PORT_UI_TARGET_LOGIN="$(<command that prints the verify URL>)" \
     node <skill-dir>/parity.mjs --source <original-url> --target <port-url>
   ```

   Credentials only ever reach the runner through environment variables (`PORT_UI_TARGET_LOGIN`,
   `PORT_UI_TARGET_COOKIE`, `PORT_UI_SOURCE_COOKIE`), and their values are produced by a command
   substitution. **Never paste a link or cookie literally**: a literal value is written to shell
   history (and a flag would also show in the process list). The command that prints the verify
   URL is the app's own dev-login helper if it has one.

   On a stock kit fork, read the link from the local email. `wrangler dev` simulates the kit's
   `EMAIL` binding: the send succeeds and writes the message to a file under
   `.wrangler/tmp/email/`, so nothing is parked in the magic-link outbox. Request a link on the
   port's login page for the seeded admin, then run this from the directory `wrangler dev` runs
   in, while it runs (it clears that folder when it stops). It reads the newest email, so request
   the link right before:

   ```
   PORT_UI_TARGET_LOGIN="$(grep -ho 'https://[^[:space:]]*/auth/verify?token=[0-9a-f]*' \
     "$(ls -t .wrangler/tmp/email/*/email-text/*.txt | head -n 1)")" \
     node <skill-dir>/parity.mjs --source <original-url> --target <port-url>
   ```

   If no email is there, the variable is empty and the runner refuses to start. The KV outbox
   (GUIDEBOOK "First login") holds a link only when the send did not happen: on staging before
   email onboarding, or in a config without the `EMAIL` binding.

   The kit mints the link for `https://<DASHBOARD_HOST>`, even locally. The runner keeps only its
   `/auth/verify?token=…` part and opens it on `--target`, so a local token never goes to the real
   host, and the link is never printed. It completes the kit's "Confirm sign-in" interstitial,
   checks that a session really exists (an expired or used link fails the run), and reuses the
   session. If you already have a session, use `PORT_UI_TARGET_COOKIE` (the kit's
   `__Host-app_session` works on an http://localhost or http://127.0.0.1 target) or
   `--target-storage <state.json>` instead. Sign the port in with the same role as the source
   session (usually an admin), or the screens won't be comparable.

   It shoots every screen at every viewport and records a computed-style census. It writes
   `parity.json` and `report.html` to a temp dir **outside the repo**, and exits non-zero when any
   pair failed to capture. Every credential path is checked against `/api/me` first, from a page
   as the captures load it: a stale cookie or storage file fails the run instead of screenshotting
   the login view as the port. Source
   screenshots may contain real data, so never commit them.
2. Delegate to the **`ui-parity-reviewer`** agent with that directory. It ranks deviations:
   - **P0:** wrong shell, layout or brand; broken screen
   - **P1:** wrong component, colour, type or spacing; missing state
   - **P2:** sub-pixel or data-driven differences
3. Fix P0 and P1 in the theme or the page, then re-run. Record any difference you accept in the
   contract's deltas table, with the reason.
4. Publish the final `report.html` as a private Artifact for the user's sign-off (both sides ran
   on synthetic data, Phase 0). The original app is the mockup, so this replaces a separate design
   mockup.

## Phase 6 - verify and ship

- Run `npm run typecheck && npm run lint && npm test && npm run build:web && npm run verify:deps`.
- Run `node <skill-dir>/scope-kit-css.mjs --check`: `web/src/theme/kit-scoped.css` must match
  `web/src/styles.css`, or the kit's own pages render with a stale baseline.
- `/qa` the role walk on the port: tabs hidden per role, APIs still return 404.
- Add a DECISIONS entry ("UI ported from <source>; deltas: …"). Then `/ship`, linking the parity
  summary and the contract in the PR body. Update Linear.

## Never

- Restyle while porting ("while I'm here"). Fidelity comes first; a redesign is a separate,
  approved change.
- Leave a ported screen on the kit-baseline classes (the `.card`/`.tab` look) when the source had
  its own.
- Loosen `_headers` or the CSP for a font or CDN asset. Self-host it.
- Commit source-app screenshots, real data, or a seed copied from the original's database.
- Run the original on its real data for parity, or hand a subagent a screenshot of real records.
