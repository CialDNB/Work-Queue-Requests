// THE APP'S VIEWS — the SPA's single registry of the screens a user can open. App.tsx builds its
// navigation from this table (primary nav + the Settings menu, in this order) and gates each tab on
// its `permission`. test/web/views.test.ts pins the table's shape.
//
// The in-app agent's `ui_navigate` intent (src/ai/uiIntents.ts) may name a view only if it is
// listed here AND opted in on the server: AGENT_VIEWS in src/ai/uiTargets.ts, protected core (the
// worker cannot import web/, and the list the server trusts has to sit where a change takes a
// code-owner review). A view is NOT navigable by default. test/isolation/ui-intent-targets.test.ts
// pins every opted-in view to its entry here — same id, permission and path, same order — so
// re-gating or re-pathing one here without the server copy fails CI. (Same "mirror pinned by a
// test" guard as endpoints.ts.)
//
// Kit conventions (DECISIONS 2026-08-03), inherited by every app via the template:
//   1. The app's own FEATURE views are primary nav (`section: 'feature'`); the cross-cutting
//      account/platform surfaces — API keys, Users, Audit log, Alerting — live under the Settings
//      menu (`section: 'settings'`).
//   2. Navigation is history-aware (useRoute), so the browser Back button walks back through the
//      app and never drops the user on the login page. `id` IS the first URL path segment, so
//      `path` is `/<id>`, optionally followed by more segments, where a `:name` segment is a param.
//      useRoute reads only that first segment today, and every entry here is a nav tab, so the
//      table holds no `:param` path yet (test/web/views.test.ts): the agent-panel work (P3) extends
//      useRoute to carry params before one is added. pathParamNames and viewHref are ready for it.
// Notes is the kit's example feature — the primary-nav slot a real app replaces with its own.
//
// Adding a view (/add-page): an entry here and its page in App.tsx's PAGES (typecheck fails until
// both exist). Only if the in-app agent should be able to open it: the same { id, permission, path }
// in AGENT_VIEWS in src/ai/uiTargets.ts, with `agentNavigable: true`.

export interface AppView {
  /** Stable id: the first URL path segment (useRoute reads the view from it). */
  readonly id: string;
  readonly label: string;
  /** Primary nav, or the Settings menu. */
  readonly section: 'feature' | 'settings';
  /**
   * The permission key that shows the tab. UI gating mirrors the API — the tab hides, and the
   * page's routes still 404 on their own — so this is never the control, only its reflection.
   */
  readonly permission: string;
  /** URL template: `/<id>`, then optional segments; `:name` marks a param. */
  readonly path: string;
}

export const APP_VIEWS = [
  { id: 'notes', label: 'Notes', section: 'feature', permission: 'notes.read', path: '/notes' },
  {
    id: 'tokens',
    label: 'API keys',
    section: 'settings',
    permission: 'tokens.self',
    path: '/tokens',
  },
  // Machine principals for integrations — owner/admin, session only (serviceIdentities.manage).
  {
    id: 'service-identities',
    label: 'Service identities',
    section: 'settings',
    permission: 'serviceIdentities.manage',
    path: '/service-identities',
  },
  { id: 'users', label: 'Users', section: 'settings', permission: 'users.read', path: '/users' },
  {
    id: 'audit',
    label: 'Audit log',
    section: 'settings',
    permission: 'audit.read',
    path: '/audit',
  },
  // `reads` is NOT a free choice of id: the view id IS the first path segment (useRoute), and K1
  // publishes `https://<DASHBOARD_HOST>/reads` to the fleet registry as this app's `activity_url`
  // (READ_LOG_VIEW_PATH in src/cron/reportToRegistry.ts, pinned to this entry by
  // test/web/views.test.ts). Renaming it breaks that deep link for every app in the fleet.
  {
    id: 'reads',
    label: 'Read log',
    section: 'settings',
    permission: 'readLog.read',
    path: '/reads',
  },
  {
    id: 'alerting',
    label: 'Alerting',
    section: 'settings',
    permission: 'settings.manage',
    path: '/alerting',
  },
] as const satisfies readonly AppView[];

export type ViewId = (typeof APP_VIEWS)[number]['id'];

const PARAM_SEGMENT = /^:([A-Za-z][A-Za-z0-9_]*)$/;

/** The `:param` names in a path template, in order: `/cases/:id` → `['id']`. */
export function pathParamNames(path: string): string[] {
  const names: string[] = [];
  for (const segment of path.split('/')) {
    const m = PARAM_SEGMENT.exec(segment);
    if (m) names.push(m[1]!);
  }
  return names;
}

/**
 * A param value: an identifier, never text, a path, a dot segment or an empty string. The same rule
 * the server applies to a `ui_navigate` param (ID_SHAPED in src/ai/uiIntents.ts).
 */
export const PARAM_VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The URL of a view: its path with every `:param` filled, one segment each. `null` unless `params`
 * names exactly the path's params and every value is identifier-shaped — a missing or extra key,
 * or a value like '', '.', '..' or 'a/b', is a caller bug, never a URL. (encodeURIComponent alone
 * would let '.' and '..' through, and a dot segment escapes its view.) This is how the SPA turns a
 * `ui_navigate` intent into a location, and it holds the same rule for any other caller.
 */
export function viewHref(
  view: Pick<AppView, 'path'>,
  params: Readonly<Record<string, string>> = {},
): string | null {
  const names = pathParamNames(view.path);
  const given = Object.keys(params);
  if (given.length !== names.length || !names.every((n) => Object.hasOwn(params, n))) return null;
  if (!names.every((n) => PARAM_VALUE.test(params[n]!))) return null;
  return view.path
    .split('/')
    .map((segment) => {
      const m = PARAM_SEGMENT.exec(segment);
      return m ? encodeURIComponent(params[m[1]!]!) : segment;
    })
    .join('/');
}
