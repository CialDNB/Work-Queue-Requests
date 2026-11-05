// GOLDEN EXAMPLE repository — the pattern every app repo follows: typed rows,
// implicit ordering, cursor pagination, boolean mutation results (false = not found).
// Replace `notes` with your domain; keep the shapes.

export interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface NotePage {
  items: NoteRow[];
  next_cursor: string | null;
}

function encodeCursor(row: NoteRow): string {
  return btoa(JSON.stringify({ c: row.created_at, id: row.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function decodeCursor(cursor: string): { c: string; id: string } | null {
  try {
    const b64 = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const parsed = JSON.parse(atob(b64)) as { c?: unknown; id?: unknown };
    if (typeof parsed.c !== 'string' || typeof parsed.id !== 'string') return null;
    return { c: parsed.c, id: parsed.id };
  } catch {
    return null;
  }
}

export function notesRepo(db: D1Database) {
  return {
    async create(input: { title: string; body: string; createdBy: string }): Promise<NoteRow> {
      const id = crypto.randomUUID();
      await db
        .prepare('INSERT INTO notes (id, title, body, created_by) VALUES (?, ?, ?, ?)')
        .bind(id, input.title, input.body, input.createdBy.toLowerCase())
        .run();
      const row = await db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first<NoteRow>();
      if (!row) throw new Error('insert readback failed');
      return row;
    },

    async get(id: string): Promise<NoteRow | null> {
      return db.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first<NoteRow>();
    },

    /** Newest first with opaque keyset cursor (stable under concurrent inserts). */
    async list(opts: { limit: number; cursor?: string }): Promise<NotePage> {
      const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;
      const res = decoded
        ? await db
            .prepare(
              'SELECT * FROM notes WHERE (created_at < ?1) OR (created_at = ?1 AND id < ?2) ORDER BY created_at DESC, id DESC LIMIT ?3',
            )
            .bind(decoded.c, decoded.id, opts.limit + 1)
            .all<NoteRow>()
        : await db
            .prepare('SELECT * FROM notes ORDER BY created_at DESC, id DESC LIMIT ?')
            .bind(opts.limit + 1)
            .all<NoteRow>();
      const rows = res.results;
      const hasMore = rows.length > opts.limit;
      const items = hasMore ? rows.slice(0, opts.limit) : rows;
      const last = items[items.length - 1];
      return { items, next_cursor: hasMore && last ? encodeCursor(last) : null };
    },

    async update(id: string, patch: { title?: string; body?: string }): Promise<boolean> {
      const existing = await this.get(id);
      if (!existing) return false;
      await db
        .prepare("UPDATE notes SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(patch.title ?? existing.title, patch.body ?? existing.body, id)
        .run();
      return true;
    },

    async remove(id: string): Promise<boolean> {
      const res = await db.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
      return res.meta.changes > 0;
    },
  };
}
