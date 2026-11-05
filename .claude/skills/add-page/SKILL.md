---
name: add-page
description: Add a SPA page/tab wired to the API client with permission-gated UI. Use for any new screen in web/.
---

# /add-page — a new screen, the kit way

**Prime directives apply** (CLAUDE.md). The golden example is
`web/src/pages/Notes.tsx` — list + create + edit + delete against the typed client.

## Steps

1. **Confirm the data.** Which endpoints does the page need? If they don't exist,
   run `/add-endpoint` first — UI never gets ahead of validated, audited API.
2. **Types + client:** add row types to `web/src/types.ts`. For each `/api/*` call the
   page needs, add the endpoint to the pinned table `web/src/endpoints.ts` (method + path,
   matching the worker route exactly) and a thin wrapper in `web/src/api.ts` that goes
   through `call('<id>')` — never a hand-written `request('/api/...')` string, which would
   bypass the drift guard (`test/web/api-client.test.ts` pins the table to the route
   registry). `request()` is only for the `/auth/*` surfaces outside defineRoute. Envelope
   and error handling stay uniform either way.
3. **Page component** in `web/src/pages/<Name>.tsx`: load in `useEffect`, render
   loading/error/empty states, forms with required fields, `ApiError.message` shown
   to users (it's already safe — the API never leaks internals).
4. **Register the view in `web/src/views.ts`, then render it in `web/src/App.tsx`.** Add an
   entry to `APP_VIEWS` with a stable `id` (its first URL path segment), `label`, `section:
   'feature'` (primary nav, for a user-facing feature) or `'settings'` (grouped under the Settings
   menu — for account/platform surfaces like keys, users, audit, config), `permission:
   '<permission>'` (UI gating mirrors the API — the tab hides, the route still 404s), and `path:
   '/<id>'`. Order in the table is nav order. Then add the page body to `PAGES` in `App.tsx`,
   keyed by the same id — typecheck fails until both exist. `test/web/views.test.ts` pins the
   table's shape (no `:param` path yet: `useRoute` routes by the first segment only). The in-app
   agent can NOT open the new view unless you opt it in — only if it should, add the same `id`,
   `permission` and `path` with `agentNavigable: true` to `AGENT_VIEWS` in `src/ai/uiTargets.ts`
   (protected core, code-owner review; a view gated by a non-delegable permission is refused, and
   `test/isolation/ui-intent-targets.test.ts` fails if the two entries differ). Navigation is
   history-aware via `useRoute`; never reintroduce plain `useState` view state, or the browser
   Back button exits to the login page (DECISIONS 2026-08-03).
5. **Style.** First check for `.paved-road/design.json`.
   - **`mode: "port"`** means this app was ported from an existing product, and its look lives
     in the theme layer (`web/src/theme/`) and the design contract (`docs/design/`).
     - If the screen exists in the source, port it per `/port-ui` Phase 4: the source's JSX
       structure and class names, with the kit's data and navigation.
     - If it's a new screen, compose it from the ported classes and tokens. Never fall back to
       the kit-baseline look.
     - The `warn-design-drift` hook flags raw colours and fonts outside the theme.
   - **Otherwise (greenfield):** use the existing CSS variables and classes in
     `web/src/styles.css`. Extend the system; don't fork it.
6. **Verify:** `npm run typecheck && npm run lint && npm run build:web`, then
   `npm run dev` + `npm run dev:web` and click through manually (or run `/qa` against
   staging after deploy).
7. Update Linear; demo data stays synthetic.
