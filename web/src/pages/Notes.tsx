// Golden example page — shows the full pattern: list with cursor pagination,
// create, inline edit, delete, optimistic-free simple state. /add-page copies this.
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Note } from '../types';

export function NotesPage({ canWrite }: { canWrite: boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<Note | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const page = await api.notes.list();
    setNotes(page.items);
    setCursor(page.next_cursor);
  }, []);

  useEffect(() => {
    load().catch(() => setError('Failed to load notes'));
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    const page = await api.notes.list(cursor);
    setNotes((prev) => [...prev, ...page.items]);
    setCursor(page.next_cursor);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api.notes.create(title, body);
      setTitle('');
      setBody('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    }
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    await api.notes.update(editing.id, { title: editing.title, body: editing.body });
    setEditing(null);
    await load();
  }

  return (
    <div>
      <h2>Notes, an example feature</h2>
      <p className="muted subhead">
        Remove this feature or change the text as you advance on the application development.
      </p>
      {error && <p className="error">{error}</p>}
      {canWrite && (
        <form className="card" onSubmit={create}>
          <input
            required
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            placeholder="Write something… (synthetic demo data only)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button type="submit">Add note</button>
        </form>
      )}
      <ul className="list">
        {notes.map((note) =>
          editing?.id === note.id ? (
            <li key={note.id} className="card">
              <form onSubmit={saveEdit}>
                <input
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                />
                <textarea
                  value={editing.body}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                />
                <div className="row">
                  <button type="submit">Save</button>
                  <button type="button" className="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            </li>
          ) : (
            <li key={note.id} className="card">
              <div className="row spread">
                <strong>{note.title}</strong>
                <span className="muted small">
                  {note.created_by} · {new Date(note.created_at).toLocaleString()}
                </span>
              </div>
              {note.body && <p>{note.body}</p>}
              {canWrite && (
                <div className="row">
                  <button type="button" className="ghost" onClick={() => setEditing(note)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost danger"
                    onClick={() => api.notes.remove(note.id).then(load)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ),
        )}
      </ul>
      {cursor && (
        <button type="button" className="ghost" onClick={loadMore}>
          Load more
        </button>
      )}
    </div>
  );
}
