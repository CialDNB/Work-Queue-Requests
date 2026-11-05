# Design brief — App Registry (paved-road pilot)

> Pilot app for [AICOE-178](https://linear.app/cialdnb/issue/AICOE-178). Doubles as the
> migration worklist for [AICOE-179](https://linear.app/cialdnb/issue/AICOE-179).
> Brief for the design pass; implementation follows via `/add-page` + `/add-endpoint`.

## What it is

A single-tenant internal catalog of CIAL's homegrown apps — name, owner, where it runs,
what data it touches, and migration status. It doubles as the migration worklist
("rank by exposure, worst first"). Lives as **one new tab** in the existing Paved Road
SPA — not a standalone app, not a shell redesign.

## Who uses it / roles

paved-road RBAC: owner / admin / member / viewer.

- **viewer** — reads the catalog, no edit controls, **cannot see the Risk/Exposure
  assessment** (this is the permission-gated-field demo).
- **member / admin** — full CRUD; see and set the risk fields.

## Data per entry (drives columns/fields)

| Field | Type | Notes |
|---|---|---|
| Name | text, required | |
| Owner | text | person/team |
| URL | link | |
| Platform / host | enum | Cloudflare · lovable · railway · v0 · base44 · personal cloud · other |
| Auth | enum | none · basic · SSO · paved-road |
| Data sensitivity | enum | none · internal · PII · confidential |
| **Risk / exposure** | enum | low · med · **high** — 🔒 gated: hidden from viewers |
| Migration status | enum | not started · planned · in progress · migrated · retired |
| Notes | text | |
| *meta* | — | created_by + timestamp shown on row (audit is automatic) |

## Screens / states to design

1. **Main directory** — the hero screen. Table-first (it's a scan-many-rows tool, denser
   than the Notes card list). A **filter/search bar** on top (search name/owner; filter by
   platform, migration status, risk). Sort by risk or status. Visual emphasis on
   **high-risk / no-auth** rows (that's the whole point of the inventory).
2. **Add entry** — form in a `.card`, gated to write roles.
3. **Edit** — inline or modal (designer's call; Notes does inline).
4. **Empty state** — first-run, no entries.
5. **Viewer (gated) variant** — read-only, no add/edit, **Risk column absent**. Show this
   side-by-side with the admin view so the gating is legible.
6. **Loading + error** states.

## System notification emails

Per the design-prompt template, the brief covers the **email template for system
notifications** — system email is part of the product surface. App Registry adds no
app-specific emails, but it inherits the kit's platform notifications, and those should
be on-brand:

- **Magic-link login** (`src/email/templates.ts`) — every user of this app receives it.
- **Cron-failure alert** (`src/cron/alert.ts`) — to owners/admins; currently text-only.

Deliver one responsive HTML email shell (brand mark, body, muted footer) using the same
`--accent #0050f0` / neutral tokens as the SPA — inline CSS only, max-width ~600px, with
a plain-text fallback — then show both emails above rendered in it. No app-specific
notifications in scope for v1; revisit if migration-status changes start triggering alerts.

## Match the existing kit (so it's build-ready)

- Shell already exists — top bar with brand mark + permission-gated tabs +
  `email · role / Log out`, centered `max-width: 920px` (designer may propose widening for
  the table), footer. **Add a tab labeled "Apps."**
- Reuse the components/tokens in `web/src/styles.css`: `.card`, `table` (uppercase muted
  `th`), `.row` / `.row.spread`, `button` / `button.ghost` / `button.ghost.danger`,
  `.muted` / `.small`, `.disabled-row`, radius `10px`.
- Accent is **CIAL blue `#0050f0`** (`--accent`) with `--accent-soft #e6eeff`; neutral
  grays elsewhere. Apply the **`cial-brand`** skill for logo/type/voice details — but stay
  within these tokens so it drops into the SPA.
- Reference page to match in tone/structure: `web/src/pages/Notes.tsx`.

## Guardrails

- **Synthetic data only** in mockups — invented app names/owners, no real CIAL apps or
  real risk assessments.
- Don't redesign auth, nav chrome, or other tabs. One page.
- Keep it responsive (desktop-first; the table should degrade gracefully on narrow widths).

## Deliverable

Hi-fi mockups of screens 1–5 (admin + the gated viewer variant), annotated with which
controls/columns are permission-gated, plus any net-new component beyond the list above,
plus the **system-notification email template** (HTML shell + magic-link login and
cron-alert emails rendered in it, with text fallbacks). Then translated into `/add-page`
+ `/add-endpoint` against this data model.

## Load-bearing assumptions (flip if wrong)

- The permission-gated field is **Risk/Exposure** (hidden from viewers).
- The directory is **table-over-cards** (denser, built for scanning many rows).
