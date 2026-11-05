import { isReservedIdentifier } from '../auth/serviceNamespace';
import type { Role } from '../auth/types';

/**
 * Thrown by users.add for an address in the reserved service namespace (`*.invalid` —
 * src/auth/serviceNamespace.ts). A person can never hold one: service identities live in their
 * own table and are created by the service-identity routes, never invited. The kit's invite route
 * turns the address into a 400 before it gets here; this is the wall for every other caller.
 */
export class ReservedAddressError extends Error {
  constructor() {
    super('addresses under the reserved .invalid TLD are service identifiers, never users');
    this.name = 'ReservedAddressError';
  }
}

export interface UserRow {
  email: string;
  name: string | null;
  role: Role;
  added_by: string | null;
  added_at: string;
  disabled_at: string | null;
}

export interface UserPage {
  items: UserRow[];
  next_cursor: string | null;
}

// Opaque keyset cursor over (added_at, email) — both stable, email unique, so paging is
// consistent under concurrent invites (same shape as the notes repo).
function encodeCursor(row: UserRow): string {
  return btoa(JSON.stringify({ a: row.added_at, e: row.email }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function decodeCursor(cursor: string): { a: string; e: string } | null {
  try {
    const b64 = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const parsed = JSON.parse(atob(b64)) as { a?: unknown; e?: unknown };
    if (typeof parsed.a !== 'string' || typeof parsed.e !== 'string') return null;
    return { a: parsed.a, e: parsed.e };
  } catch {
    return null;
  }
}

export function usersRepo(db: D1Database) {
  return {
    async get(email: string): Promise<UserRow | null> {
      return db
        .prepare('SELECT * FROM users WHERE email = ?')
        .bind(email.toLowerCase())
        .first<UserRow>();
    },

    /** Active = invited and not disabled. The fail-closed gate for every login/request. */
    async getActive(email: string): Promise<UserRow | null> {
      return db
        .prepare('SELECT * FROM users WHERE email = ? AND disabled_at IS NULL')
        .bind(email.toLowerCase())
        .first<UserRow>();
    },

    /** Oldest-invited first, keyset-paginated (ascending added_at, email). */
    async list(opts: { limit: number; cursor?: string }): Promise<UserPage> {
      const decoded = opts.cursor ? decodeCursor(opts.cursor) : null;
      const res = decoded
        ? await db
            .prepare(
              'SELECT * FROM users WHERE (added_at > ?1) OR (added_at = ?1 AND email > ?2) ORDER BY added_at, email LIMIT ?3',
            )
            .bind(decoded.a, decoded.e, opts.limit + 1)
            .all<UserRow>()
        : await db
            .prepare('SELECT * FROM users ORDER BY added_at, email LIMIT ?')
            .bind(opts.limit + 1)
            .all<UserRow>();
      const rows = res.results;
      const hasMore = rows.length > opts.limit;
      const items = hasMore ? rows.slice(0, opts.limit) : rows;
      const last = items[items.length - 1];
      return { items, next_cursor: hasMore && last ? encodeCursor(last) : null };
    },

    /** Returns null if the user already exists (caller decides how to respond). */
    async add(input: {
      email: string;
      name?: string | null;
      role: Role;
      addedBy: string;
    }): Promise<UserRow | null> {
      const email = input.email.toLowerCase();
      if (isReservedIdentifier(email)) throw new ReservedAddressError();
      const existing = await this.get(email);
      if (existing) return null;
      await db
        .prepare('INSERT INTO users (email, name, role, added_by) VALUES (?, ?, ?, ?)')
        .bind(email, input.name ?? null, input.role, input.addedBy.toLowerCase())
        .run();
      return this.get(email);
    },

    async setRole(email: string, role: Role): Promise<boolean> {
      const res = await db
        .prepare('UPDATE users SET role = ? WHERE email = ?')
        .bind(role, email.toLowerCase())
        .run();
      return res.meta.changes > 0;
    },

    async setDisabled(email: string, disabled: boolean): Promise<boolean> {
      const res = await db
        .prepare(
          disabled
            ? "UPDATE users SET disabled_at = datetime('now') WHERE email = ? AND disabled_at IS NULL"
            : 'UPDATE users SET disabled_at = NULL WHERE email = ?',
        )
        .bind(email.toLowerCase())
        .run();
      return res.meta.changes > 0;
    },

    async countActiveOwners(): Promise<number> {
      const row = await db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled_at IS NULL")
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
  };
}
