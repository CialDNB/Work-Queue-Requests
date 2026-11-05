import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { TokenRow } from '../types';

// expires_at is SQLite datetime() text: "YYYY-MM-DD HH:MM:SS", UTC.
function isExpired(expiresAt: string): boolean {
  const t = Date.parse(`${expiresAt.replace(' ', 'T')}Z`);
  return !Number.isNaN(t) && t <= Date.now();
}

export function TokensPage() {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(() => api.tokens.list().then((r) => setTokens(r.tokens)), []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    const created = await api.tokens.create(name.trim());
    setFresh(created.token);
    setName('');
    await load();
  }

  return (
    <div>
      <h2>API tokens</h2>
      <p className="muted">
        Bearer tokens (<code>t_…</code>) for scripts and MCP clients. The full token is shown
        exactly once — store it somewhere safe. Every token expires after 90 days (rotate it before
        then), and a token can never manage users, settings or tokens, or read the audit logs —
        those need you, signed in. A token here acts as <em>you</em>: for an integration or an ETL,
        ask an owner or admin for a <strong>service identity</strong> instead, so its work is not
        recorded under your name.
      </p>
      <form className="card row" onSubmit={create}>
        <input
          required
          placeholder="Token name, e.g. 'my-script'"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit">Create token</button>
      </form>
      {fresh && (
        <div className="card highlight">
          <p>
            New token (copy it now — it will not be shown again): <code>{fresh}</code>
          </p>
          <button type="button" className="ghost" onClick={() => setFresh(null)}>
            I saved it
          </button>
        </div>
      )}
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
                    onClick={() => api.tokens.revoke(t.id).then(load)}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
