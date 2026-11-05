import { type ReactElement, useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { Login } from './Login';
import { AuditPage } from './pages/Audit';
import { NotesPage } from './pages/Notes';
import { ReadsPage } from './pages/Reads';
import { ServiceIdentitiesPage } from './pages/ServiceIdentities';
import { SettingsPage } from './pages/Settings';
import { TokensPage } from './pages/Tokens';
import { UsersPage } from './pages/Users';
import type { Me } from './types';
import { useRoute } from './useRoute';
import { APP_VIEWS, type ViewId } from './views';

// The views themselves — id, label, menu, permission, URL — are registered in ./views.ts (kit
// conventions there, DECISIONS 2026-08-03). This file only renders them. New pages register in
// both places (/add-page).

type Page = (me: Me, can: (p: string) => boolean) => ReactElement;

// Every registered view's page body, keyed by view id: a view with no page, or a page for a view
// that is not registered, fails typecheck.
const PAGES: Record<ViewId, Page> = {
  notes: (_m, can) => <NotesPage canWrite={can('notes.write')} />,
  tokens: () => <TokensPage />,
  'service-identities': () => <ServiceIdentitiesPage />,
  users: (me, can) => <UsersPage me={me} canManage={can('users.manage')} />,
  audit: () => <AuditPage />,
  reads: () => <ReadsPage />,
  alerting: () => <SettingsPage />,
};

export function App() {
  const [me, setMe] = useState<Me | null | 'loading'>('loading');
  const [route, navigate] = useRoute('notes');

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch((err: unknown) => setMe(err instanceof ApiError && err.status === 401 ? null : null));
  }, []);

  if (me === 'loading') return <div className="centered muted">Loading…</div>;
  if (me === null) return <Login />;

  const can = (p: string) => me.permissions.includes(p);
  const feature = APP_VIEWS.filter((v) => v.section === 'feature' && can(v.permission));
  const settings = APP_VIEWS.filter((v) => v.section === 'settings' && can(v.permission));
  const settingsHome = settings[0]?.id;
  const visible = [...feature, ...settings];

  // Resolve the active view: the routed id if the user may see it, else the first thing they can.
  const active = visible.find((v) => v.id === route) ?? visible[0];
  const inSettings = !!active && settings.some((v) => v.id === active.id);

  if (!active) return <div className="centered muted">No accessible views.</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          Work Queue Requests
        </div>
        <nav>
          {feature.map((v) => (
            <button
              key={v.id}
              type="button"
              className={active.id === v.id ? 'tab active' : 'tab'}
              onClick={() => navigate(v.id)}
            >
              {v.label}
            </button>
          ))}
          {settingsHome && (
            <button
              type="button"
              className={inSettings ? 'tab active' : 'tab'}
              onClick={() => navigate(settingsHome)}
            >
              Settings
            </button>
          )}
        </nav>
        <div className="userbox">
          <span className="muted">
            {me.email} · {me.role}
          </span>
          <button
            type="button"
            className="ghost"
            onClick={() => api.logout().then(() => window.location.reload())}
          >
            Log out
          </button>
        </div>
      </header>
      {inSettings && (
        <nav className="subnav">
          {settings.map((v) => (
            <button
              key={v.id}
              type="button"
              className={active.id === v.id ? 'subtab active' : 'subtab'}
              onClick={() => navigate(v.id)}
            >
              {v.label}
            </button>
          ))}
        </nav>
      )}
      <main>{PAGES[active.id](me, can)}</main>
      <footer className="muted">
        Built on the CIAL paved road · <a href="/_health">health</a>
      </footer>
    </div>
  );
}
