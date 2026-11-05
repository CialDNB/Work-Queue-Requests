import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import type { AlertingConfig } from '../types';

// Login policy: when Entra SSO is fully configured AND a Microsoft sign-in has completed
// on this app from every allowed tenant, admins may switch magic links off (Microsoft
// sign-in becomes the only way in). The server refuses to enable it before then, and
// ignores it if SSO later degrades — so this toggle can never brick every login path.
// Turning it off is always allowed.
function LoginPolicy() {
  const [cfg, setCfg] = useState<{
    entraOnly: boolean;
    entraOnlyEffective: boolean;
    entraConfigured: boolean;
    entraProven: boolean;
    entraUnprovenTenants: string[];
  } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      api.settings
        .getLogin()
        .then(setCfg)
        .catch(() => setError('Failed to load login settings')),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(next: boolean) {
    setError('');
    setSaving(true);
    try {
      await api.settings.setLogin(next);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (!cfg) return null;
  const canEnable = cfg.entraConfigured && cfg.entraProven;
  // Tenant ids are public directory ids (runbook table), named so the admin knows whose
  // users still have to sign in once.
  const unproven = cfg.entraUnprovenTenants.join(', ');
  const hint = !cfg.entraConfigured
    ? 'Microsoft sign-in is not fully configured for this app (see docs/runbooks/entra-sso-setup.md), so magic links stay on.'
    : !cfg.entraProven
      ? cfg.entraOnly
        ? `No Microsoft sign-in has ever completed on this app from tenant ${unproven}, so with magic links off its users may not be able to get in. Switch this off until one has.`
        : `No Microsoft sign-in has completed on this app yet from tenant ${unproven}. Have a user from each of these tenants sign in with Microsoft once (a private window works), or remove the tenant from ENTRA_ALLOWED_TENANTS, then this can be switched on.`
      : 'Users sign in through Microsoft Entra. Magic-link requests are refused while this is on.';
  return (
    <>
      <h2>Login</h2>
      <div className="card">
        <label className={cfg.entraOnly || canEnable ? '' : 'muted'}>
          <input
            type="checkbox"
            checked={cfg.entraOnly}
            disabled={saving || (!cfg.entraOnly && !canEnable)}
            onChange={(e) => void toggle(e.target.checked)}
          />{' '}
          Microsoft sign-in only (switch magic-link login off)
        </label>
        <p className="muted">
          {hint}
          {cfg.entraOnly && !cfg.entraOnlyEffective && (
            <>
              {' '}
              Currently NOT in force — SSO is misconfigured, magic links are working as a fallback.
            </>
          )}
        </p>
        {error && <p className="error">{error}</p>}
      </div>
    </>
  );
}

// Alerting settings (A4): admins add extra recipients and set/replace the Slack
// channel that failure alerts go to. These layer over the ALERT_EMAIL /
// ALERT_WEBHOOK_URL env defaults — the env owner is always alerted.
export function SettingsPage() {
  const [cfg, setCfg] = useState<AlertingConfig | null>(null);
  const [recipients, setRecipients] = useState('');
  const [slack, setSlack] = useState('');
  const [clearSlack, setClearSlack] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(
    () =>
      api.settings
        .getAlerting()
        .then((c) => {
          setCfg(c);
          setRecipients(c.recipients.join('\n'));
          // The stored webhook is never sent to the client, so the input starts empty:
          // typing a URL replaces it, the "clear" checkbox removes it, blank keeps it.
          setSlack('');
          setClearSlack(false);
        })
        .catch(() => setError('Failed to load alerting settings')),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSaved(false);
    const list = recipients
      .split(/[\n,;]+/)
      .map((r) => r.trim())
      .filter(Boolean);
    const trimmed = slack.trim();
    try {
      await api.settings.setAlerting(
        list,
        clearSlack ? { clear: true } : trimmed ? { url: trimmed } : {},
      );
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    }
  }

  if (!cfg) return <div className="muted">Loading…</div>;

  return (
    <div>
      <LoginPolicy />
      <h2>Alerting</h2>
      <p className="muted">
        Where cron/health failures go. The app owner (
        {cfg.env_defaults.recipients.join(', ') || '—'}) is always alerted; add extra recipients and
        a Slack channel below.
      </p>
      {error && <p className="error">{error}</p>}
      {saved && <p className="muted">Saved.</p>}
      <form className="card" onSubmit={save}>
        <label>
          Additional recipient emails (one per line)
          <textarea
            rows={4}
            placeholder="ops@cialdnb.com"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
          />
        </label>
        <label>
          Slack channel webhook URL{' '}
          <span className="muted">
            {cfg.slackWebhookConfigured ? '(a channel is configured)' : '(none set)'}
          </span>
          <input
            type="url"
            placeholder={
              cfg.slackWebhookConfigured
                ? 'Enter a new https://hooks.slack.com/… URL to replace it'
                : 'https://hooks.slack.com/services/…'
            }
            value={slack}
            disabled={clearSlack}
            onChange={(e) => setSlack(e.target.value)}
          />
        </label>
        {cfg.slackWebhookConfigured && (
          <label className="muted">
            <input
              type="checkbox"
              checked={clearSlack}
              onChange={(e) => setClearSlack(e.target.checked)}
            />{' '}
            Clear the configured Slack channel
          </label>
        )}
        <button type="submit">Save</button>
      </form>
    </div>
  );
}
