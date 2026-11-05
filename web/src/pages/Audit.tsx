import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AuditRow } from '../types';

export function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);

  useEffect(() => {
    api.audit.list().then((r) => {
      setRows(r.items);
      setNextBefore(r.next_before);
    });
  }, []);

  async function loadMore() {
    if (!nextBefore) return;
    const r = await api.audit.list(nextBefore);
    setRows((prev) => [...prev, ...r.items]);
    setNextBefore(r.next_before);
  }

  return (
    <div>
      <h2>Audit log</h2>
      <p className="muted">Append-only — every mutation in the app lands here.</p>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="small muted">{r.created_at}</td>
              <td>{r.actor_email}</td>
              <td>
                <code>{r.action}</code>
              </td>
              <td className="small">{r.target ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {nextBefore && (
        <button type="button" className="ghost" onClick={loadMore}>
          Load older
        </button>
      )}
    </div>
  );
}
