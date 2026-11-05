# Design contract - 【App name】 (ported from 【source app】)

> Written by `/port-ui` Phase 1. It is the single answer to "what should this screen look like?"
> for every session, human or agent. **The source app outranks this file; this file outranks the
> kit baseline.** Keep it current: an accepted difference that isn't recorded here is drift.

## Source

| | |
|---|---|
| Source code | 【path, e.g. ../original-app/frontend】 (repo 【org/repo】 @ 【ref】) |
| Run it | 【command】 → 【http://localhost:PORT】 |
| Stack | 【React/Vite, CSS approach, UI libs】 |
| Pointer file | `.paved-road/design.json` |

## Tokens (ported verbatim to `web/src/theme/`)

| Family | Tokens (source file:line) |
|---|---|
| Brand | 【--brand-…】 |
| Surfaces / text | 【--page --card --ink --muted --border】 |
| Status / semantic | 【good / partial / bad …】 |
| Domain families | 【stage / priority / … colours】 |
| Type | 【font families, scale, weights; mono usage】 |
| Shape / depth | 【radii, shadows, focus ring】 |
| Motion | 【easings, keyframes; reduced-motion handling】 |
| Breakpoints | 【…】 |

**Token bridge** (`web/src/theme/bridge.css`, kit → source; /port-ui Phase 2.4):
`--kit-accent:【】 --kit-accent-soft:【】 --kit-bg:【】 --kit-surface:【】 --kit-text:【】
--kit-muted:【】 --kit-border:【】 --kit-danger:【】 --kit-radius:【】`.
Each value is a source token (`var(--brand-deep)`) or a literal, never a `--kit-*` name and never
the same name (`--x: var(--x)` is a cycle, which CSS drops). The kit's pages inherit the source's
body font 【】.

## Assets (self-hosted under `web/public/`)

| Source | Port | Note |
|---|---|---|
| 【public/fonts/*.ttf】 | `web/public/fonts/` | 【licence】 |
| 【public/brand/logo.svg】 | `web/public/brand/` | |

## Shell

【Layout description: sidebar/topbar regions, widths, colours, sticky behaviour, brand block,
nav item anatomy (glyph, label, badge), global controls (region switcher, user box), responsive
behaviour.】 Kit mapping: nav from `APP_VIEWS` + `web/src/shell/navMeta.ts`; settings views live in
【where】.

## Component vocabulary

| Source class / component | Purpose | Port location |
|---|---|---|
| 【.card .pad】 | 【】 | theme CSS |
| 【Kpi】 | 【duplicated in N pages】 | 【web/src/components/Kpi.tsx】 |

## Screen map

| # | Source route | Source file | Kit view id / path | Port file | Build order | Status |
|---|---|---|---|---|---|---|
| 1 | 【/】 | 【pages/Dashboard.tsx】 | 【dashboard /dashboard】 | 【web/src/pages/…】 | 【1】 | 【todo】 |

## Interaction patterns

【Loading (text vs skeleton), errors, empty states, toasts, overlays/modals, confirmations,
filters, keyboard, animations. Port them as the source has them.】

## Forced deltas (kit constraints - recorded, not silent)

| Source behaviour | Port behaviour | Why |
|---|---|---|
| 【SSO button / anonymous landing】 | 【kit login (magic link / SSO) in the source's layout】 | fail-closed auth |
| 【dev "act as" switcher】 | dropped | no auth bypass in the UI |
| 【font/CDN asset】 | self-hosted | CSP (`web/public/_headers`) |
| 【react-query / router】 | `api.*` + `useRoute` | paved-road data + history conventions |

## Dead source code (not ported)

【files, with the reason (unrouted, unused, unstyled)】

## Parity log

| Date | Screens | P0 | P1 | P2 | Report |
|---|---|---|---|---|---|
| 【YYYY-MM-DD】 | 【n】 | 【0】 | 【0】 | 【n】 | 【artifact link】 |
