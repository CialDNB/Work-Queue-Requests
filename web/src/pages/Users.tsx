import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import type { Me, UserRow } from '../types';

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

export function UsersPage({ me, canManage }: { me: Me; canManage: boolean }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState('');

  const load = useCallback(
    () =>
      api.users
        .list()
        .then((r) => {
          setUsers(r.users);
          setCursor(r.next_cursor);
        })
        .catch(() => setError('Failed to load users')),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    try {
      const page = await api.users.list(cursor);
      setUsers((prev) => [...prev, ...page.users]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load more users');
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.users.invite(email.trim(), name.trim(), role);
      setEmail('');
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invite failed');
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    }
  }

  return (
    <div>
      <h2>Users</h2>
      <p className="muted">
        Invite-only allowlist: only people in this table can log in. Fail-closed by design.
      </p>
      {error && <p className="error">{error}</p>}
      {canManage && (
        <form className="card row" onSubmit={invite}>
          <input
            type="email"
            required
            placeholder="colleague@cialdnb.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="submit">Invite</button>
        </form>
      )}
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Status</th>
            {canManage && <th />}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.email} className={u.disabled_at ? 'disabled-row' : ''}>
              <td>{u.email}</td>
              <td>{u.name ?? '—'}</td>
              <td>
                {canManage && u.email !== me.email ? (
                  <select
                    value={u.role}
                    onChange={(e) => act(() => api.users.update(u.email, { role: e.target.value }))}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  u.role
                )}
              </td>
              <td>{u.disabled_at ? 'disabled' : 'active'}</td>
              {canManage && (
                <td className="row">
                  {u.email !== me.email && (
                    <>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() =>
                          act(() => api.users.update(u.email, { disabled: !u.disabled_at }))
                        }
                      >
                        {u.disabled_at ? 'Re-enable' : 'Disable'}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => act(() => api.users.revokeSessions(u.email))}
                      >
                        Force logout
                      </button>
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {cursor && (
        <button type="button" className="ghost" onClick={loadMore}>
          Load more
        </button>
      )}
    </div>
  );
}
