// migrationBySlug (test/helpers/db.ts): how the kit's migration tests find a kit migration in an app
// that renumbered it. A fork copies each kit migration to its own next free ordinal, keeping the
// slug (scripts/check-kit-migrations.mjs names the file), and these tests ride /kit-upgrade — so a
// test that imported `0003_api_token_scopes.sql` by path would fail to resolve there, or read the
// fork's unrelated 0003.
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, type Migration, migrationBySlug } from './db';

const KIT_SLUGS = [
  'kit_app_identity.sql',
  'read_log.sql',
  'read_log_kind.sql',
  'api_token_scopes.sql',
  'service_identities.sql',
];

describe('migrationBySlug — a kit migration under whatever number the app gave it', () => {
  it('finds each kit migration by its name minus the ordinal', () => {
    for (const slug of KIT_SLUGS) {
      const migration = migrationBySlug(slug);
      expect(migration.name.replace(/^\d{4}_/, '')).toBe(slug);
      expect(MIGRATIONS).toContain(migration);
    }
  });

  it('finds a renumbered copy, and matches the whole slug rather than a suffix', () => {
    const fork: Migration[] = [
      { name: '0003_profile_people_suppressed.sql', sql: 'SELECT 3;' },
      { name: '0026_api_token_scopes.sql', sql: 'SELECT 26;' },
      { name: '0031_read_log.sql', sql: 'SELECT 31;' },
    ];
    expect(migrationBySlug('api_token_scopes.sql', fork).name).toBe('0026_api_token_scopes.sql');
    expect(() => migrationBySlug('log.sql', fork)).toThrow(/found 0/);
  });

  it('refuses a missing or an ambiguous slug, pointing at the checker', () => {
    expect(() => migrationBySlug('no_such_migration.sql')).toThrow(/check-kit-migrations\.mjs/);
    const twice: Migration[] = [
      { name: '0004_read_log.sql', sql: '' },
      { name: '0009_read_log.sql', sql: '' },
    ];
    expect(() => migrationBySlug('read_log.sql', twice)).toThrow(
      /found 2 \(0004_read_log\.sql, 0009_read_log\.sql\)/,
    );
  });
});
