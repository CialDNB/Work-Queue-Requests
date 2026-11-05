// Golden-example tests — /add-endpoint copies this structure for new resources:
// envelope shape, validation, pagination, param precedence, audit-on-write.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, seedDb, USERS } from '../helpers/db';
import { asUser, BASE, cookieFor } from '../helpers/http';

interface Note {
  id: string;
  title: string;
  body: string;
  created_by: string;
}

async function createNote(title: string, body = ''): Promise<Note> {
  const res = await asUser(USERS.member, 'POST', '/api/notes', { title, body });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Note }).data;
}

describe('notes API (golden example)', () => {
  beforeAll(applySchema);
  beforeEach(seedDb);

  it('uses the canonical success envelope', async () => {
    const res = await asUser(USERS.member, 'GET', '/api/notes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { items: unknown[] } };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
  });

  it('validates input at the boundary with machine-readable errors', async () => {
    const res = await asUser(USERS.member, 'POST', '/api/notes', { body: 'no title' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toContain('title');
  });

  // Sends a GENUINELY malformed body via a raw fetch — asUser JSON-stringifies, so it cannot.
  // This test used to send no body at all, so it never touched the malformed path: it passed on
  // Zod's missing-title error, making it a duplicate of the test above. Worse, once the framework
  // started accepting bodiless mutations (AICOE-398), "POST with no body" became the canonical
  // VALID shape — so the assertion was pinning a rejection of something now deliberately legal.
  it('rejects malformed JSON bodies cleanly', async () => {
    const res = await SELF.fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: {
        origin: BASE,
        cookie: await cookieFor(USERS.member),
        'content-type': 'application/json',
      },
      body: '{"title": ', // truncated: non-empty AND unparseable
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toBe('Invalid JSON body');
  });

  it('creates with 201 and stamps the creator', async () => {
    const note = await createNote('First note', 'synthetic body');
    expect(note.created_by).toBe(USERS.member);
    expect(note.title).toBe('First note');
  });

  it('paginates newest-first with an opaque keyset cursor', async () => {
    const a = await createNote('a');
    const b = await createNote('b');
    const c = await createNote('c');
    const page1 = await asUser(USERS.member, 'GET', '/api/notes?limit=2');
    const data1 = ((await page1.json()) as { data: { items: Note[]; next_cursor: string } }).data;
    expect(data1.items.length).toBe(2);
    expect(data1.next_cursor).toBeTruthy();
    const page2 = await asUser(
      USERS.member,
      'GET',
      `/api/notes?limit=2&cursor=${encodeURIComponent(data1.next_cursor)}`,
    );
    const data2 = ((await page2.json()) as { data: { items: Note[]; next_cursor: string | null } })
      .data;
    expect(data2.items.length).toBe(1);
    expect(data2.next_cursor).toBeNull();
    const seen = [...data1.items, ...data2.items].map((n) => n.id).sort();
    expect(seen).toEqual([a.id, b.id, c.id].sort());
  });

  it('path params win over body fields (a body can never redirect the mutation)', async () => {
    const target = await createNote('target');
    const other = await createNote('other');
    const res = await asUser(USERS.member, 'PUT', `/api/notes/${target.id}`, {
      id: other.id,
      title: 'renamed',
    });
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { data: Note }).data;
    expect(updated.id).toBe(target.id);
    expect(updated.title).toBe('renamed');
    const untouched = await asUser(USERS.member, 'GET', `/api/notes/${other.id}`);
    expect(((await untouched.json()) as { data: Note }).data.title).toBe('other');
  });

  it('supports partial updates', async () => {
    const note = await createNote('keep title', 'old body');
    await asUser(USERS.member, 'PUT', `/api/notes/${note.id}`, { body: 'new body' });
    const res = await asUser(USERS.member, 'GET', `/api/notes/${note.id}`);
    const updated = ((await res.json()) as { data: Note }).data;
    expect(updated.title).toBe('keep title');
    expect(updated.body).toBe('new body');
  });

  it('deletes with 204 and the note is gone (uniform 404)', async () => {
    const note = await createNote('doomed');
    const del = await asUser(USERS.member, 'DELETE', `/api/notes/${note.id}`);
    expect(del.status).toBe(204);
    const gone = await asUser(USERS.member, 'GET', `/api/notes/${note.id}`);
    expect(gone.status).toBe(404);
  });

  it('writes audit rows for every mutation', async () => {
    const note = await createNote('audited');
    await asUser(USERS.member, 'PUT', `/api/notes/${note.id}`, { title: 'audited 2' });
    await asUser(USERS.member, 'DELETE', `/api/notes/${note.id}`);
    const rows = await env.DB.prepare(
      'SELECT action, actor_email, target FROM audit_log ORDER BY id',
    ).all<{ action: string; actor_email: string; target: string }>();
    const actions = rows.results.map((r) => r.action);
    // Exactly one row per mutation — the single-writer contract (no double-stamping).
    expect(actions.filter((a) => a === 'note.create')).toHaveLength(1);
    expect(actions.filter((a) => a === 'note.update')).toHaveLength(1);
    expect(actions.filter((a) => a === 'note.delete')).toHaveLength(1);
    for (const row of rows.results) {
      expect(row.actor_email).toBe(USERS.member);
    }
  });
});
