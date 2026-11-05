// Lightweight groups for app-level logic (visibility, routing, team scoping).
// No HTTP routes by default — wire them up when your app needs group semantics.
export interface GroupRow {
  id: number;
  name: string;
  slug: string;
  created_by: string;
  created_at: string;
}

export interface GroupMemberRow {
  group_id: number;
  email: string;
  added_by: string;
  added_at: string;
}

// The two lines above, made machine-checkable. scripts/check-core-reachability.mjs fails CI on
// a data-layer method nothing calls, and nothing in src/, web/src/, or test/ calls any of these
// six — correctly, because the kit ships the tables and the repo but deliberately ships no
// group routes. Delete this marker the moment an app wires one up.
// @reachability-exempt: kit scaffolding, wired into makeDb() but intentionally routeless
export function groupsRepo(db: D1Database) {
  return {
    async create(input: {
      name: string;
      slug: string;
      createdBy: string;
    }): Promise<GroupRow | null> {
      const existing = await db
        .prepare('SELECT * FROM groups WHERE slug = ?')
        .bind(input.slug)
        .first<GroupRow>();
      if (existing) return null;
      await db
        .prepare('INSERT INTO groups (name, slug, created_by) VALUES (?, ?, ?)')
        .bind(input.name, input.slug, input.createdBy.toLowerCase())
        .run();
      return db.prepare('SELECT * FROM groups WHERE slug = ?').bind(input.slug).first<GroupRow>();
    },

    async list(): Promise<GroupRow[]> {
      const res = await db.prepare('SELECT * FROM groups ORDER BY name').all<GroupRow>();
      return res.results;
    },

    async addMember(groupId: number, email: string, addedBy: string): Promise<void> {
      await db
        .prepare('INSERT OR IGNORE INTO group_members (group_id, email, added_by) VALUES (?, ?, ?)')
        .bind(groupId, email.toLowerCase(), addedBy.toLowerCase())
        .run();
    },

    async removeMember(groupId: number, email: string): Promise<boolean> {
      const res = await db
        .prepare('DELETE FROM group_members WHERE group_id = ? AND email = ?')
        .bind(groupId, email.toLowerCase())
        .run();
      return res.meta.changes > 0;
    },

    async listMembers(groupId: number): Promise<GroupMemberRow[]> {
      const res = await db
        .prepare('SELECT * FROM group_members WHERE group_id = ? ORDER BY email')
        .bind(groupId)
        .all<GroupMemberRow>();
      return res.results;
    },

    async groupsForUser(email: string): Promise<GroupRow[]> {
      const res = await db
        .prepare(
          'SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.email = ? ORDER BY g.name',
        )
        .bind(email.toLowerCase())
        .all<GroupRow>();
      return res.results;
    },
  };
}
