# Design port - moving an existing app onto the kit without losing its face

**TL;DR.** When an app with an existing UI moves onto the paved road, its design system, shell
and screens come with it. The kit replaces the plumbing (data client, routing, auth, permission
gating, CSP-safe assets) and leaves the face alone. `/port-ui` runs this; this page explains the
method and why it is shaped this way.

## The problem this solves

The kit's SPA ships a deliberately neutral baseline (`web/src/styles.css`: one accent, system
font, top tabs, cards and tables). For a **greenfield** app that is a sensible starting point.
For a **ported** app it is an attractor. Every step of the old migration path pulled toward it:

- `/paved-road:adopt` Tier 2 mapped "routes, data model, auth, jobs", and screens were not on
  the list;
- `/add-page` said "style with `web/src/styles.css`";
- `DESIGN-PROMPT-TEMPLATE.md` hard-coded one brand, one font and one nav pattern;
- `.paved-road/brand.json` was specified in the adoption manifest, but nothing read it.

So a port kept the logic and silently regressed the UI to the template. Users who knew the
original got a different-looking product, and the design someone had already approved was lost.
That is a regression, not a neutral choice.

## Principles

1. **The running original is the spec.** Its code and screenshots outrank the kit baseline, the
   design-prompt template and the porter's taste. Fidelity first; a redesign is a separate,
   approved change.
2. **Port the face, replace the plumbing.**

   | Stays as in the source | Becomes the kit's |
   |---|---|
   | tokens, fonts, colours, radii, shadows, motion | typed `api.*` client through the pinned endpoint table |
   | shell layout and brand block | `useRoute` + the `APP_VIEWS` registry |
   | class names, component structure, copy | kit auth: login, magic link or SSO, fail-closed |
   | page layouts and interaction patterns | `permission` gating; the API still returns a uniform 404 |
   | images and fonts | self-hosted under `web/public/` (CSP) |
3. **Verbatim beats re-derived.** Copy the source CSS as it is, keeping its class names, and port
   JSX structure 1:1. Re-deriving a design from screenshots or a prompt loses the details that
   make it recognisable: mono numerals, a tinted shadow, a 16px radius.
4. **Deltas are named, never silent.** Some kit constraints force a change, such as a magic-link
   login instead of an SSO-only button, or no dev "act as" switcher. Each one goes in the
   contract with its on-brand equivalent.
5. **Measured, not eyeballed.** Every mapped screen is screenshotted on both apps, and a
   computed-style census lists the fonts, colours, radii and shadows that the port renders and
   the source never does.

## The artefacts

| Artefact | Where | Role |
|---|---|---|
| Design contract | `docs/design/DESIGN-CONTRACT.md` | Human answer to "what should this screen look like": tokens, shell, vocabulary, **screen map**, **forced deltas**, parity log |
| Pointer + map | `.paved-road/design.json` (schema in `.claude/skills/port-ui/references/design.schema.md`) | Machine half: `mode`, source location, theme dir, `screens[]` per-side paths, viewports |
| Theme layer | `web/src/theme/` | Source CSS verbatim, `kit-scoped.css` (the kit baseline confined to `.kit-page`), and the `--kit-*` **bridge**; the only place raw colours and fonts belong |
| Shell | `web/src/shell/` | Source layout rendered over the kit's view registry |
| Assets | `web/public/fonts/`, `web/public/brand/` | Self-hosted (the CSP allows `'self'` only) |

## The method (what `/port-ui` runs)

0. **Preflight.** Locate the source, write it into design.json, run both apps on synthetic data
   (never the original's real database: its screenshots go to a subagent and a published report;
   design.json records `source.data: "synthetic"` and the parity runner refuses without it), and
   work on a branch.
1. **Inventory → contract.** The `ui-inventory` agent audits the source frontend. The skill turns
   that into the contract and design.json. The user sees the screen map and the deltas before
   anything is built.
2. **Theme: the source verbatim, the kit baseline isolated, then bridged.**
   - Copy the source CSS verbatim into `web/src/theme/` and self-host its assets.
   - **Do not load `web/src/styles.css` globally.** It styles bare elements (`button`, `select`,
     `table`, `th`/`td`, `nav`, `main`, `footer`) and generic classes (`.app`, `.card`,
     `.topbar`, `.brand`). Next to a source theme, those rules leak into every ported screen.
     In the first real port, they produced kit-blue buttons, full-width selects and a 1180px
     `.app` that broke the sidebar layout. Token mapping cannot fix a property the theme never
     sets.
   - Instead, run `node .claude/skills/port-ui/scope-kit-css.mjs`. It generates
     `web/src/theme/kit-scoped.css`, in which every kit selector is prefixed with `.kit-page`,
     every kit variable is renamed to `--kit-*`, and page-level rules are dropped.
   - Wrap the kit's own pages in `<div className="kit-page">` and bridge the namespace:

   ```css
   /* web/src/theme/bridge.css: the kit's pages (Login, Users, Audit, Tokens, Settings) render
      inside .kit-page with the scoped baseline; these values make them the same product. */
   :root {
     --kit-accent: var(--brand-deep);  --kit-accent-soft: var(--teal-bg);
     --kit-bg: var(--page);            --kit-surface: var(--card);
     --kit-text: var(--ink);           --kit-muted: var(--muted);
     --kit-border: var(--border);      --kit-danger: var(--bad);
     --kit-radius: 10px;
   }
   ```

   Theme entry (`web/src/theme/index.css`, imported by `main.tsx` **instead of**
   `./styles.css`): `kit-scoped.css`, then the source CSS, then `bridge.css`. Because of the
   `--kit-*` namespace, the two vocabularies never share a name, so there are no collisions and
   no `--x: var(--x)` cycles. `styles.css` stays untouched. It is app-owned, so `/kit-upgrade`
   does not carry it: the kit's changes to it arrive as CHANGELOG manual steps, which apply to
   it as written. Re-run the script after applying one; `--check` reports a stale copy, and both
   `/port-ui` (step 6) and `/kit-upgrade` run it.

   Values the source wrote inline in page code (an overlay rgba, a chart palette, `#fff`) become
   bridge tokens with the same values, so pages only use `var(--…)`.
3. **Shell over the registry.** Rebuild the source's sidebar and topbar in `web/src/shell/`, but
   take nav entries from `APP_VIEWS` filtered by `can(permission)`, navigate with `useRoute`, and
   put kit settings views in the source's admin area. Glyphs, badges and ordering live in a
   presentation map keyed by view id; `AppView` is not widened.
4. **Screens, one per commit.** Copy the source page's JSX and classNames, and swap only data
   (`useQuery`/`fetch` → `api.*`) and navigation (`Link` → `navigate`). Lift duplicated
   page-local components once, without restyling them, and drop dead code.
5. **Parity loop.** Run `parity.mjs`, then the `ui-parity-reviewer` agent ranks P0/P1/P2 and you
   fix. Repeat until there are no P0/P1. The final `report.html` is published as an Artifact for
   sign-off. The original app is the mockup, so this replaces a separate design mockup.
6. **Verify and ship.** Run typecheck, lint, tests, `build:web` and `verify:deps`, do a `/qa`
   role walk, add a DECISIONS entry, then `/ship`.

## Kit constraints a port must respect (the delta catalogue)

| Source has | Port does | Because |
|---|---|---|
| Font or asset CDN (Google Fonts, unpkg, S3 images) | Self-host under `web/public/` | CSP `default-src 'self'`; `_headers` is protected core |
| Inline `<style>` tags, `style="…"` strings in HTML | Theme CSS; React `style={{}}` only for computed geometry | CSP `style-src` has no `'unsafe-inline'` (CSSOM props still work) |
| `dangerouslySetInnerHTML` (markdown, rich text) | Render via React elements | biome `noDangerouslySetInnerHtml`, XSS |
| SSO-only button or anonymous landing page | Source layout around the kit login | fail-closed auth, no anonymous `/api/*` |
| Dev "act as" or role switcher in the UI | Dropped; use the kit's dev login helper | no auth bypass in shipped UI |
| react-query, react-router, axios | `api.*` + `useRoute` | one typed client, pinned endpoint table, history-aware nav |
| Tailwind or a component kit | The **rendered result** in theme CSS (or keep the dep if the user decides, after `verify:deps`) | one styling system, no build-tool sprawl |
| Real names, salaries or clients in seeds | Synthetic seed | CLAUDE.md "Never do" |
| Pre-filled real-looking names in form defaults | Empty field with a placeholder | synthetic-only rule |
| Markup that fails the kit lint (`<button>` without `type`, decorative `<svg>`, `<li role=link onClick>`, `innerHTML` icon swaps) | The accessible equivalent with identical pixels: `type="button"`, `aria-hidden`, `<a href>` + `display: contents`, both icons toggled by `display` | biome is a hard gate |
| Verbatim CSS that biome flags (`!important`, specificity order) | Unchanged, with a `biome-ignore` comment giving the reason | the rule is load-bearing (e.g. reduced motion) |
| Data the source screen shows that the kit route doesn't return | The route extended, with a test, after checking **the caller's** access to every related record it exposes | fidelity must not widen what a role can see |
| Source shows a field only some roles may see | Same UI, but the API decides (null or uniform 404) | permissions come from the server |

## Guards

- **`warn-design-drift` hook** (PreToolUse Edit/Write). In a `mode: "port"` app, it warns when
  `web/src/**` code outside the theme adds a raw colour or its own `font-family`, and when any
  edit adds a remote font, stylesheet, script or image URL, inside the theme and in
  `web/index.html` too (the CSP blocks those wherever they are written). It is warn-only, because
  an SVG stop or a chart series can legitimately need a literal.
- **`/add-page`** reads design.json. In a port, a new screen is composed from the ported
  vocabulary, never from the kit baseline.
- **`/paved-road:adopt` Tier 2** runs `/port-ui` by default before any screen is ported. Opting
  out takes an explicit answer from the user, recorded in DECISIONS.

## FAQ

- **The source design is dated or has bugs. Can I improve it while porting?** No. Port it, ship
  it, then propose the redesign as its own change with its own sign-off. Mixing the two makes
  the parity loop meaningless.
- **The source has no design system at all.** Then the "source CSS" is whatever it renders. The
  inventory resolves effective values, and the theme captures them. If there is truly nothing
  worth keeping, say so in the contract, set `mode: "greenfield"`, and use
  `DESIGN-PROMPT-TEMPLATE.md`.
- **Dark mode or RTL the source never had?** Out of scope for the port. Note it as a follow-up.
  Locale-driven labels still get `dir="auto"`.
- **Can the parity screenshots go in the PR?** No. Screenshots never go in git. Both apps run on
  synthetic data for the parity loop, so the report is published as a private Artifact and linked
  from the PR and the contract.
- **The original only runs against its production database.** Then don't run parity on it: seed
  a copy with synthetic records first, or ask the owner. Real records in a screenshot reach a
  model subagent and a published report, which no PIA covers.
