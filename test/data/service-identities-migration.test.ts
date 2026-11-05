// The kit's service_identities migration (0004 in the kit; found by slug, since a fork renumbers it
// — migrationBySlug in test/helpers/db.ts), run for real against both shapes it meets: an
// EXISTING database (everything up to 0003, holding users, tokens and audit rows, and no
// service_identities table) and a FRESH install (the schema.sql baseline, then every migration).
// Both must end in the baseline's shape; the existing one must keep every row it had, untouched —
// the file creates, it never alters. Own file on purpose: every test here drops the table.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeDb } from '../../src/data';
import { applySchema, migrationBySlug, seedDb, USERS } from '../helpers/db';

const migrationSql = migrationBySlug('service_identities.sql').sql;

// The file holds trigger bodies, so a plain split on ';' would cut them in half: comments are
// stripped per line (no string literal in the file contains `--`), then statements are split on
// ';' outside BEGIN … END — how SQLite (and wrangler) read it.
function statements(sql: string): string[] {
  const cleaned = sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
  const out: string[] = [];
  const re = /\bBEGIN\b|\bEND\b|;/gi;
  let depth = 0;
  let start = 0;
  for (let m = re.exec(cleaned); m !== null; m = re.exec(cleaned)) {
    const tok = m[0].toUpperCase();
    if (tok === 'BEGIN') depth++;
    else if (tok === 'END') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const stmt = cleaned.slice(start, m.index).trim();
      if (stmt) out.push(stmt);
      start = re.lastIndex;
    }
  }
  const tail = cleaned.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

async function runMigration(): Promise<void> {
  for (const stmt of statements(migrationSql)) await env.DB.prepare(stmt).run();
}

interface Shape {
  columns: unknown[];
  objects: Array<{ type: string; name: string }>;
}

async function shape(): Promise<Shape> {
  const columns = (await env.DB.prepare('PRAGMA table_info(service_identities)').all()).results;
  const objects = (
    await env.DB.prepare(
      "SELECT type, name FROM sqlite_master WHERE tbl_name = 'service_identities' ORDER BY type, name",
    ).all<{ type: string; name: string }>()
  ).results;
  return { columns, objects };
}

/** A content fingerprint of the tables the migration must not touch. */
async function untouched(): Promise<string> {
  const parts: unknown[] = [];
  for (const table of ['users', 'api_tokens', 'audit_log', 'read_log', 'notes']) {
    parts.push((await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results);
  }
  return JSON.stringify(parts);
}

let baseline: Shape;

describe('0004_service_identities migration', () => {
  beforeAll(async () => {
    await applySchema();
    baseline = await shape();
  });
  beforeEach(seedDb);
  afterEach(async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS service_identities').run();
    await applySchema();
  });

  it('the baseline carries the table, its custodian index and its three triggers', () => {
    expect(baseline.objects).toEqual([
      { type: 'index', name: 'idx_service_identities_custodian' },
      { type: 'index', name: 'sqlite_autoindex_service_identities_1' },
      { type: 'index', name: 'sqlite_autoindex_service_identities_2' },
      { type: 'table', name: 'service_identities' },
      { type: 'trigger', name: 'service_identities_fixed_columns' },
      { type: 'trigger', name: 'service_identities_no_delete' },
      { type: 'trigger', name: 'service_identities_no_replace' },
    ]);
  });

  describe('on an EXISTING (pre-0004) database holding data', () => {
    beforeEach(async () => {
      // Everything a live app has before this migration: people, their tokens, audit history, a
      // note — and no service_identities table at all.
      await env.DB.prepare('DROP TABLE service_identities').run();
      const db = makeDb(env);
      await db.tokens.create({
        email: USERS.member,
        name: 'the ETL, on a person’s token',
        tokenHash: 'pre-0004-hash',
        prefix: 't_pre00000',
        scopes: ['notes.write'],
      });
      await db.audit.insert({ actor_email: USERS.member, action: 'note.create', target: 'n1' });
      await db.notes.create({ title: 'pre-0004', body: '', createdBy: USERS.member });
    });

    it('applies cleanly and ends in exactly the fresh-install shape', async () => {
      await runMigration();
      expect(await shape()).toEqual(baseline);
    });

    it('touches no existing row — history stays attributed as it was', async () => {
      const before = await untouched();
      await runMigration();
      expect(await untouched()).toBe(before);
      const audit = await env.DB.prepare(
        "SELECT actor_email FROM audit_log WHERE action = 'note.create'",
      ).first<{ actor_email: string }>();
      expect(audit?.actor_email).toBe(USERS.member);
    });

    it('the new table works at once, with its guarantees', async () => {
      await runMigration();
      const res = await makeDb(env).serviceIdentities.create({
        slug: 'etl',
        principalId: 'svc-etl@test-app.invalid',
        name: 'Synthetic ETL',
        scope: 'notes.write',
        custodianEmail: USERS.member,
        createdBy: USERS.owner,
      });
      expect(res.ok).toBe(true);
      await expect(env.DB.prepare('DELETE FROM service_identities').run()).rejects.toThrow(
        /never deleted/,
      );
    });

    it('is safe to run twice', async () => {
      await runMigration();
      await runMigration();
      expect(await shape()).toEqual(baseline);
    });
  });

  describe('on a FRESH install (baseline, then migrations)', () => {
    it('is a no-op on the baseline table — same shape, rows kept, no error', async () => {
      const res = await makeDb(env).serviceIdentities.create({
        slug: 'etl',
        principalId: 'svc-etl@test-app.invalid',
        name: 'Synthetic ETL',
        scope: 'notes.write',
        custodianEmail: USERS.member,
        createdBy: USERS.owner,
      });
      expect(res.ok).toBe(true);
      await runMigration();
      expect(await shape()).toEqual(baseline);
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM service_identities').first<{
        n: number;
      }>();
      expect(n?.n).toBe(1);
    });
  });
});
