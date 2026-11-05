import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ReadLogCursor, ReadLogRow } from '../types';

/**
 * What a row read, as one label: `notes.list` for a d1 row, the declared view for an aurora row,
 * and `upstream:autobahn.report_datablocks` for an upstream one — prefixed, so an upstream read
 * can never be mistaken for a repository call of the same spelling.
 */
function readLabel(r: Pick<ReadLogRow, 'kind' | 'source' | 'view' | 'query_name'>): string {
  if (r.kind === 'd1') return `${r.source}.${r.query_name ?? '?'}`;
  if (r.kind === 'upstream') return `upstream:${r.source}.${r.query_name ?? '?'}`;
  return r.view ?? r.source;
}

// `/reads` — the page K1's `activity_url` deep-links the fleet registry to. The registry holds
// COUNTS ONLY; "who read record X" is answered here, inside the app that owns the data.
export function ReadsPage() {
  const [rows, setRows] = useState<ReadLogRow[]>([]);
  const [nextBefore, setNextBefore] = useState<ReadLogCursor | null>(null);

  useEffect(() => {
    api.readLog.list().then((r) => {
      setRows(r.items);
      setNextBefore(r.next_before);
    });
  }, []);

  async function loadMore() {
    if (!nextBefore) return;
    const r = await api.readLog.list(nextBefore);
    setRows((prev) => [...prev, ...r.items]);
    setNextBefore(r.next_before);
  }

  return (
    <div>
      <h2>Read log</h2>
      <p className="muted">
        Who read what, through which route. <code>d1</code> rows are this app's own database;{' '}
        <code>aurora</code> rows are a private database behind the read seam; <code>upstream</code>{' '}
        rows are an upstream HTTP source. The name after the · is the declared target: the kind of
        identifier the read was keyed by, never its value. A dash under Rows means{' '}
        <em>attempted</em> — the read started and its outcome is unknown, which is not the same as
        an empty result.
      </p>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Route</th>
            <th>Read</th>
            <th>Rows</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="small muted">{r.created_at}</td>
              <td>{r.principal}</td>
              <td className="small">{r.route}</td>
              <td>
                <code>{readLabel(r)}</code>
                {r.target && <span className="small muted"> · {r.target}</span>}
              </td>
              <td className="small">{r.row_count ?? '—'}</td>
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
