// Service identities — machine principals (schema.sql, SYSTEM TABLES; migrations/d1/0004). This
// repository only stores and reads them; what a service may do, and who may manage one, is decided
// in src/auth (permissions.ts, tokens.ts, serviceIdentities.ts).
//
// Four rules live HERE, because src/data travels with /kit-upgrade and a fork's routes do not:
//   1. A custodian is an ACTIVE user at the moment it is set — checked inside the same statement
//      that writes it (INSERT … SELECT … WHERE EXISTS / UPDATE … WHERE EXISTS), so a custodian
//      disabled between a route's check and the write can never be recorded.
//   2. A NEW identity inherits no credential. Any token already stored under its identifier — a
//      pre-upgrade machine USER's (il-lingua's svc users), perhaps one killed by disabling that
//      users row, which no longer gates anything — is revoked in the same transaction that inserts
//      the identity, and the count is returned for the audit row. Otherwise creating an identity
//      would silently switch those tokens (back) on. Adopting existing tokens is a deliberate,
//      reviewed data step (CHANGELOG, il-lingua), never a side effect of create().
//   3. Nothing here deletes a row or changes an identity's slug, identifier or scope — the schema's
//      triggers refuse both anyway.
//   4. SCHEMA DRIFT FAILS CLOSED AND LOUD, as for api_tokens.scopes (src/data/tokens.ts). Code that
//      expects the table running against a database without it (a fork that adopted the src hunks
//      but not the renumbered 0004) gets ServiceIdentitySchemaDriftError — from create() and every
//      read (each management change starts with one), after a `service_identities_schema_drift` log
//      line naming the migration — never a bare "no such table". The bearer resolver turns it into a refusal (401), the daily digest into a failed
//      cron task (the alert names the remedy), a management route into an opaque 500.
import { logEvent } from '../platform/logEvent';

const DRIFT_REMEDY =
  'the service_identities table is missing: apply migrations/d1/0004_service_identities.sql (forks: copy it and renumber it to your next free ordinal). Every service token is refused until then.';

/** The database is older than the code: `service_identities` does not exist (migration 0004). */
export class ServiceIdentitySchemaDriftError extends Error {
  constructor(readonly op: string) {
    super(DRIFT_REMEDY);
    this.name = 'ServiceIdentitySchemaDriftError';
  }
}

/** True for D1's error on a statement that names the missing table. */
function isMissingServiceIdentitiesTable(err: unknown): boolean {
  return /no such table:?\s*(?:main\.)?service_identities\b/i.test(String(err));
}

/**
 * `err` as the drift error when it is the missing table (logging the grep-able event once, with the
 * remedy), else `err` unchanged. Exported for the one read of the table outside this repository
 * (tokens.listServiceTokensExpiringBefore joins it).
 */
export function serviceIdentitiesDriftOr(err: unknown, op: string): unknown {
  if (err instanceof ServiceIdentitySchemaDriftError || !isMissingServiceIdentitiesTable(err)) {
    return err;
  }
  // The remedy as an id, not the sentence: logs take no free text (PIA C5). DRIFT_REMEDY rides the
  // thrown error, which the cron-failure alert and the operator see.
  logEvent('service_identities_schema_drift', {
    op,
    remedy: 'apply_migration_0004_service_identities',
  });
  return new ServiceIdentitySchemaDriftError(op);
}

async function guarded<T>(op: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw serviceIdentitiesDriftOr(err, op);
  }
}

export interface ServiceIdentityRow {
  id: number;
  slug: string;
  /** svc-<slug>@<app>.invalid — the attribution identifier, and the `email` of its api_tokens. */
  principal_id: string;
  name: string;
  /** The ONE permission key it may exercise. */
  scope: string;
  custodian_email: string;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  disabled_at: string | null;
}

/** A row as the bearer resolver and the mint path need it: plus whether the custodian is live. */
export interface ServiceIdentityState extends ServiceIdentityRow {
  custodian_active: boolean;
}

/** A row as the admin list shows it: plus the custodian's state and a token summary. */
export interface ServiceIdentityListRow extends ServiceIdentityState {
  /** Tokens that are neither revoked nor expired. */
  live_tokens: number;
  /** The soonest expiry among the live tokens, or null when there are none. */
  next_expiry: string | null;
  /** The most recent use of any of its tokens, or null when none was ever used. */
  last_used_at: string | null;
}

export type CreateServiceIdentityResult =
  /** `revokedTokens`: tokens already stored under the identifier, revoked by the create (rule 2). */
  | { ok: true; row: ServiceIdentityRow; revokedTokens: number }
  | { ok: false; reason: 'taken' | 'custodian_inactive' };

// D1 returns booleans as 0/1.
type Raw<T> = Omit<T, 'custodian_active'> & { custodian_active: number };

function withState<T extends ServiceIdentityState>(raw: Raw<T>): T {
  return { ...raw, custodian_active: raw.custodian_active === 1 } as T;
}

const CUSTODIAN_ACTIVE =
  '(EXISTS (SELECT 1 FROM users u WHERE u.email = si.custodian_email AND u.disabled_at IS NULL)) AS custodian_active';

const LIVE_TOKEN =
  "t.email = si.principal_id AND t.revoked_at IS NULL AND t.expires_at > datetime('now')";

const LIST_SELECT = `SELECT si.*, ${CUSTODIAN_ACTIVE},
  (SELECT COUNT(*) FROM api_tokens t WHERE ${LIVE_TOKEN}) AS live_tokens,
  (SELECT MIN(t.expires_at) FROM api_tokens t WHERE ${LIVE_TOKEN}) AS next_expiry,
  (SELECT MAX(t.last_used_at) FROM api_tokens t WHERE t.email = si.principal_id) AS last_used_at
  FROM service_identities si`;

/** Upper bound on one list read. An app with more machine identities than this has a bigger problem. */
export const SERVICE_IDENTITY_LIST_CAP = 500;

export function serviceIdentitiesRepo(db: D1Database) {
  return {
    /**
     * Create an identity. `taken` when the slug or identifier already exists (rows are never
     * deleted, so a slug is never reused); `custodian_inactive` when `custodianEmail` is not an
     * active user — checked in the INSERT itself. On success, every unrevoked token already stored
     * under the identifier is revoked in the same batch (rule 2) — only when the INSERT wrote the
     * row, so a refused create revokes nothing.
     */
    async create(input: {
      slug: string;
      principalId: string;
      name: string;
      scope: string;
      custodianEmail: string;
      createdBy: string;
    }): Promise<CreateServiceIdentityResult> {
      return guarded('create', async () => {
        const principalId = input.principalId.toLowerCase();
        const taken = await db
          .prepare('SELECT 1 FROM service_identities WHERE slug = ? OR principal_id = ?')
          .bind(input.slug, principalId)
          .first();
        if (taken) return { ok: false, reason: 'taken' };
        const custodian = input.custodianEmail.toLowerCase();
        let changes: number;
        let revokedTokens: number;
        try {
          // One batch = one transaction. The UPDATE runs only if the INSERT wrote the row (the
          // `taken` check above saw no row with this identifier, so EXISTS here means "just
          // inserted"). `lower(email)`: the resolver lowercases the owner before it looks the
          // identity up, so a hand-inserted mixed-case row would resolve too — it is revoked too.
          const [insert, revoke] = await db.batch([
            db
              .prepare(
                `INSERT INTO service_identities (slug, principal_id, name, scope, custodian_email, created_by)
                 SELECT ?, ?, ?, ?, ?, ?
                 WHERE EXISTS (SELECT 1 FROM users WHERE email = ? AND disabled_at IS NULL)`,
              )
              .bind(
                input.slug,
                principalId,
                input.name,
                input.scope,
                custodian,
                input.createdBy.toLowerCase(),
                custodian,
              ),
            db
              .prepare(
                `UPDATE api_tokens SET revoked_at = datetime('now')
                 WHERE lower(email) = ? AND revoked_at IS NULL
                   AND EXISTS (SELECT 1 FROM service_identities WHERE principal_id = ?)`,
              )
              .bind(principalId, principalId),
          ]);
          changes = insert?.meta.changes ?? 0;
          revokedTokens = revoke?.meta.changes ?? 0;
        } catch (err) {
          // Two creates racing past the check above: the loser hits the UNIQUE constraint or the
          // no-replace trigger (and its batch — the revocation included — rolls back). Anything
          // else is a real error.
          if (/UNIQUE|never overwritten/i.test(String(err))) return { ok: false, reason: 'taken' };
          throw err;
        }
        if (changes === 0) return { ok: false, reason: 'custodian_inactive' };
        const row = await db
          .prepare('SELECT * FROM service_identities WHERE principal_id = ?')
          .bind(principalId)
          .first<ServiceIdentityRow>();
        if (!row) throw new Error('service identity insert readback failed');
        return { ok: true, row, revokedTokens };
      });
    },

    async get(id: number): Promise<ServiceIdentityRow | null> {
      return db
        .prepare('SELECT * FROM service_identities WHERE id = ?')
        .bind(id)
        .first<ServiceIdentityRow>();
    },

    /**
     * The identity a token's owner identifier names, with its custodian's live state — the ONE
     * read the bearer resolver makes for a service token (the service analogue of
     * users.getActive). Disabled identities are returned too, so the caller can say why it
     * refuses.
     */
    async getByPrincipalId(principalId: string): Promise<ServiceIdentityState | null> {
      return guarded('getByPrincipalId', async () => {
        const raw = await db
          .prepare(
            `SELECT si.*, ${CUSTODIAN_ACTIVE} FROM service_identities si WHERE si.principal_id = ?`,
          )
          .bind(principalId.toLowerCase())
          .first<Raw<ServiceIdentityState>>();
        return raw ? withState(raw) : null;
      });
    },

    /** Every identity (oldest first, capped), with its custodian's state and a token summary. */
    async list(limit = SERVICE_IDENTITY_LIST_CAP): Promise<ServiceIdentityListRow[]> {
      return guarded('list', async () => {
        const res = await db
          .prepare(`${LIST_SELECT} ORDER BY si.created_at, si.id LIMIT ?`)
          .bind(limit)
          .all<Raw<ServiceIdentityListRow>>();
        return res.results.map((raw) => withState(raw));
      });
    },

    /** One identity in the list's shape — what a management route answers with after a change. */
    async getListRow(id: number): Promise<ServiceIdentityListRow | null> {
      return guarded('getListRow', async () => {
        const raw = await db
          .prepare(`${LIST_SELECT} WHERE si.id = ?`)
          .bind(id)
          .first<Raw<ServiceIdentityListRow>>();
        return raw ? withState(raw) : null;
      });
    },

    /**
     * ORPHANED identities: enabled, holding at least one live token, and whose custodian is no
     * longer an active user — so every one of those tokens is being refused right now. The daily
     * digest names them until someone hands the identity to a new custodian or disables it.
     */
    async listOrphaned(limit = SERVICE_IDENTITY_LIST_CAP): Promise<ServiceIdentityListRow[]> {
      return guarded('listOrphaned', async () => {
        const res = await db
          .prepare(
            `${LIST_SELECT}
             WHERE si.disabled_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = si.custodian_email AND u.disabled_at IS NULL)
               AND EXISTS (SELECT 1 FROM api_tokens t WHERE ${LIVE_TOKEN})
             ORDER BY si.created_at, si.id LIMIT ?`,
          )
          .bind(limit)
          .all<Raw<ServiceIdentityListRow>>();
        return res.results.map((raw) => withState(raw));
      });
    },

    /**
     * The enabled identities `custodianEmail` answers for that hold at least one live token — what
     * stops working the moment that person is no longer an active user. Asked right after a person
     * is disabled (src/auth/serviceIdentities.ts noticeCustodianDisabled), so the alert goes out
     * then, not at the next daily digest.
     */
    async listLiveByCustodian(
      custodianEmail: string,
      limit = SERVICE_IDENTITY_LIST_CAP,
    ): Promise<ServiceIdentityListRow[]> {
      return guarded('listLiveByCustodian', async () => {
        const res = await db
          .prepare(
            `${LIST_SELECT}
             WHERE si.disabled_at IS NULL AND si.custodian_email = ?
               AND EXISTS (SELECT 1 FROM api_tokens t WHERE ${LIVE_TOKEN})
             ORDER BY si.created_at, si.id LIMIT ?`,
          )
          .bind(custodianEmail.toLowerCase(), limit)
          .all<Raw<ServiceIdentityListRow>>();
        return res.results.map((raw) => withState(raw));
      });
    },

    /**
     * STRANDED identities: enabled, holding at least one live token, custodian ACTIVE, but whose
     * scope is not in `grantable` — the keys a service may still hold (the caller passes them; the
     * permission rules live in src/auth). A later kit or app change made the key non-delegable, or
     * removed it, so every one of those tokens is being refused right now and no custodian change
     * can fix it: the identity has to be replaced. The daily digest names them until it is.
     */
    async listScopeStranded(
      grantable: readonly string[],
      limit = SERVICE_IDENTITY_LIST_CAP,
    ): Promise<ServiceIdentityListRow[]> {
      return guarded('listScopeStranded', async () => {
        const res = await db
          .prepare(
            `${LIST_SELECT}
             WHERE si.disabled_at IS NULL
               AND EXISTS (SELECT 1 FROM users u WHERE u.email = si.custodian_email AND u.disabled_at IS NULL)
               AND si.scope NOT IN (SELECT value FROM json_each(?))
               AND EXISTS (SELECT 1 FROM api_tokens t WHERE ${LIVE_TOKEN})
             ORDER BY si.created_at, si.id LIMIT ?`,
          )
          .bind(JSON.stringify([...grantable]), limit)
          .all<Raw<ServiceIdentityListRow>>();
        return res.results.map((raw) => withState(raw));
      });
    },

    /** Kill switch on/off. True when the row changed state. */
    async setDisabled(id: number, disabled: boolean, by: string): Promise<boolean> {
      const res = await db
        .prepare(
          disabled
            ? "UPDATE service_identities SET disabled_at = datetime('now'), updated_by = ?, updated_at = datetime('now') WHERE id = ? AND disabled_at IS NULL"
            : "UPDATE service_identities SET disabled_at = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND disabled_at IS NOT NULL",
        )
        .bind(by.toLowerCase(), id)
        .run();
      return res.meta.changes > 0;
    },

    /** Hand the identity to a new custodian — only an ACTIVE user (checked in the UPDATE). */
    async setCustodian(id: number, custodianEmail: string, by: string): Promise<boolean> {
      const custodian = custodianEmail.toLowerCase();
      const res = await db
        .prepare(
          `UPDATE service_identities SET custodian_email = ?, updated_by = ?, updated_at = datetime('now')
           WHERE id = ? AND EXISTS (SELECT 1 FROM users WHERE email = ? AND disabled_at IS NULL)`,
        )
        .bind(custodian, by.toLowerCase(), id, custodian)
        .run();
      return res.meta.changes > 0;
    },

    async rename(id: number, name: string, by: string): Promise<boolean> {
      const res = await db
        .prepare(
          "UPDATE service_identities SET name = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(name, by.toLowerCase(), id)
        .run();
      return res.meta.changes > 0;
    },
  };
}
