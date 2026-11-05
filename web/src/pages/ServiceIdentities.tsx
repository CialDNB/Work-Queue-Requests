import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import type { ServiceIdentity, TokenRow } from '../types';

// Service identities — machine principals (an ETL, an integration) that are NOT people: they never
// sign in, hold exactly one permission, and are accountable to a named custodian. Owner/admin only
// (serviceIdentities.manage), and only in a signed-in browser session — no API token can reach any
// of this. Kit-owned surface; see docs/runbooks/service-identities.md.

const EXPIRY_CHOICES = [30, 90, 180, 365] as const;

// expires_at is SQLite datetime() text: "YYYY-MM-DD HH:MM:SS", UTC.
function isExpired(expiresAt: string): boolean {
  const t = Date.parse(`${expiresAt.replace(' ', 'T')}Z`);
  return !Number.isNaN(t) && t <= Date.now();
}

const STATUS_LABEL: Record<ServiceIdentity['status'], string> = {
  active: 'active',
  disabled: 'disabled — tokens refused',
  custodian_inactive: 'no active custodian — tokens refused',
  scope_not_grantable: 'scope no longer allowed for a service — tokens refused; replace it',
};

function TokensPanel({
  identity,
  onChanged,
  onFresh,
  onError,
}: {
  identity: ServiceIdentity;
  onChanged: () => Promise<unknown>;
  onFresh: (token: string) => void;
  onError: (message: string) => void;
}) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [name, setName] = useState('');
  const [days, setDays] = useState<number>(90);
  const [custodian, setCustodian] = useState('');

  const load = useCallback(
    () => api.serviceIdentities.tokens(identity.id).then((r) => setTokens(r.tokens)),
    [identity.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    onError('');
    try {
      await fn();
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Action failed');
    }
  }

  async function mint(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      const created = await api.serviceIdentities.mint(
        identity.id,
        name.trim() || `${identity.slug} token`,
        days,
      );
      onFresh(created.token);
      setName('');
    });
  }

  async function handOver(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      await api.serviceIdentities.update(identity.id, { custodian_email: custodian.trim() });
      setCustodian('');
    });
  }

  function revokeAll() {
    if (
      window.confirm(
        `Revoke EVERY token of ${identity.name}? The integration stops on its next request.`,
      )
    ) {
      void act(() => api.serviceIdentities.revokeAll(identity.id));
    }
  }

  return (
    <div className="card">
      <h3>
        {identity.name} <code>{identity.identifier}</code>
      </h3>
      <p className="muted small">
        Rotate: mint a replacement, deploy it to the integration, watch its <em>Last used</em> fill
        in, then revoke the old token. Tokens cannot be extended.
      </p>
      <form className="row" onSubmit={mint}>
        <input
          placeholder="Token name, e.g. 'etl prod 2026-10'"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {EXPIRY_CHOICES.map((d) => (
            <option key={d} value={d}>
              expires in {d} days
            </option>
          ))}
        </select>
        <button type="submit">Mint token</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Prefix</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Expires</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>
                <code>{t.prefix}…</code>
              </td>
              <td className="small muted">{t.created_at}</td>
              <td className="small muted">{t.last_used_at ?? 'never'}</td>
              <td className="small muted">{t.expires_at}</td>
              <td>{t.revoked_at ? 'revoked' : isExpired(t.expires_at) ? 'expired' : 'active'}</td>
              <td>
                {!t.revoked_at && (
                  <button
                    type="button"
                    className="ghost danger"
                    onClick={() => act(() => api.serviceIdentities.revokeToken(identity.id, t.id))}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="row" onSubmit={handOver} style={{ marginTop: 12 }}>
        <input
          type="email"
          required
          placeholder={`New custodian (now ${identity.custodian_email})`}
          value={custodian}
          onChange={(e) => setCustodian(e.target.value)}
        />
        <button type="submit" className="ghost">
          Change custodian
        </button>
        <button type="button" className="ghost danger" onClick={revokeAll}>
          Revoke all tokens
        </button>
      </form>
    </div>
  );
}

export function ServiceIdentitiesPage() {
  const [identities, setIdentities] = useState<ServiceIdentity[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState('');
  const [custodian, setCustodian] = useState('');

  const load = useCallback(
    () =>
      api.serviceIdentities
        .list()
        .then((r) => {
          setIdentities(r.service_identities);
          setScopes(r.grantable_scopes);
        })
        .catch(() => setError('Failed to load service identities')),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    // The scope is never defaulted: an admin who skipped the picker must not silently get the first
    // key in the list (users.read, a PII read). Both it and the slug are permanent — say so first.
    if (!scope) {
      setError('Choose the one permission this identity holds');
      return;
    }
    if (
      !window.confirm(
        `Create "${slug.trim()}" holding ${scope}? The slug and the permission can never be changed — a different permission is a new identity.`,
      )
    ) {
      return;
    }
    try {
      const created = await api.serviceIdentities.create({
        slug: slug.trim(),
        name: name.trim(),
        scope,
        custodian_email: custodian.trim(),
      });
      setSlug('');
      setName('');
      setScope('');
      setCustodian('');
      setOpen(created.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Create failed');
    }
  }

  async function toggleDisabled(identity: ServiceIdentity) {
    setError('');
    try {
      await api.serviceIdentities.update(identity.id, { disabled: !identity.disabled_at });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    }
  }

  const selected = identities.find((i) => i.id === open);

  return (
    <div>
      <h2>Service identities</h2>
      <p className="muted">
        Machine principals for integrations (an ETL, a sync job), so they stop running on a
        person&apos;s token. A service identity can never sign in, holds exactly <em>one</em>{' '}
        permission, and is accountable to a named custodian — an active user. Its actions are
        recorded under its own <code>svc-…@….invalid</code> identifier. If the custodian is disabled
        or removed, its tokens are refused until you hand it to someone else.
      </p>
      {error && <p className="error">{error}</p>}
      <form className="card row" onSubmit={create}>
        <input
          required
          placeholder="slug, e.g. c360-etl"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
        <input
          required
          placeholder="Name, e.g. C360 ETL"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select required value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="" disabled>
            Choose its ONE permission…
          </option>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="email"
          required
          placeholder="Custodian (an active user)"
          value={custodian}
          onChange={(e) => setCustodian(e.target.value)}
        />
        <button type="submit" disabled={scopes.length === 0 || scope === ''}>
          Create identity
        </button>
      </form>
      {fresh && (
        <div className="card highlight">
          <p>
            New token (copy it now — it will not be shown again): <code>{fresh}</code>
          </p>
          <p className="small">
            Hand it to the integration through a secret manager, never email or chat.
          </p>
          <button type="button" className="ghost" onClick={() => setFresh(null)}>
            I saved it
          </button>
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Identity</th>
            <th>Scope</th>
            <th>Custodian</th>
            <th>Status</th>
            <th>Tokens</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {identities.map((i) => (
            <tr key={i.id} className={i.status === 'active' ? '' : 'disabled-row'}>
              <td>
                {i.name}
                <br />
                <code className="small">{i.identifier}</code>
              </td>
              <td>
                <code>{i.scope}</code>
              </td>
              <td>
                {i.custodian_email}
                {!i.custodian_active && <span className="error small"> (not active)</span>}
              </td>
              <td>{STATUS_LABEL[i.status]}</td>
              <td className="small muted">
                {i.live_tokens} live
                {i.next_expiry && (
                  <>
                    <br />
                    next expires {i.next_expiry}
                  </>
                )}
              </td>
              <td className="row">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setOpen(open === i.id ? null : i.id)}
                >
                  {open === i.id ? 'Close' : 'Tokens'}
                </button>
                <button type="button" className="ghost" onClick={() => toggleDisabled(i)}>
                  {i.disabled_at ? 'Re-enable' : 'Disable'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <TokensPanel
          key={selected.id}
          identity={selected}
          onChanged={load}
          onFresh={setFresh}
          onError={setError}
        />
      )}
    </div>
  );
}
