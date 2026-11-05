// Pre-issued bearer tokens (t_*) for programmatic and MCP access. Only the
// SHA-256 hash is ever stored; plaintext is returned once at creation.
//
// Two C8 guarantees live HERE rather than in a route, because src/routes/ is fork-owned and never
// travels with /kit-upgrade while this file does:
//   1. EVERY new token expires, at most TOKEN_MAX_TTL_DAYS after it is minted — or, for a SERVICE
//      identity's token, SERVICE_TOKEN_MAX_TTL_DAYS. create() has no "never" path; a caller that
//      asks for longer gets the cap (and the returned row says so). Which cap applies is decided
//      HERE from the owner's identifier (the reserved `.invalid` namespace is always a service),
//      never from a flag a caller passes in, so no route can buy a person a 365-day token.
//   2. SCHEMA DRIFT FAILS CLOSED. Code that expects `api_tokens.scopes` running against a database
//      without it (a fork that adopted this file but not migrations/d1/0003_api_token_scopes.sql)
//      must never quietly treat every token as unscoped. Every path that reads or writes the
//      column throws ApiTokenSchemaDriftError instead, after logging `api_token_schema_drift`.

import { isReservedIdentifier } from '../auth/serviceNamespace';
import { logEvent } from '../platform/logEvent';
import { serviceIdentitiesDriftOr } from './serviceIdentities';

/** Hard ceiling on a PERSON's token lifetime, and the lifetime one gets when none is asked for. */
export const TOKEN_MAX_TTL_DAYS = 90;

/**
 * A SERVICE identity's token: 90 days when none is asked for, at most 365. Longer than a person's
 * because a machine token is rotated on a schedule by its custodian (the daily digest warns from
 * 14 days out), and a quarterly forced rotation of an unattended ETL is an outage generator, not a
 * control. Still never unbounded.
 */
export const SERVICE_TOKEN_DEFAULT_TTL_DAYS = 90;
export const SERVICE_TOKEN_MAX_TTL_DAYS = 365;

export type TokenOwnerKind = 'person' | 'service';

export interface ApiTokenRow {
  id: number;
  email: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  /** Never null on a migrated database (NOT NULL since C8); legacy rows were back-filled. */
  expires_at: string;
  revoked_at: string | null;
  /**
   * JSON array of permission keys (the scope ceiling), or NULL for a legacy token minted before
   * C8. Parsed and enforced in src/auth — this layer only stores it.
   */
  scopes: string | null;
}

/** The fields the expiry notice needs — no hash, no scopes. */
export interface ExpiringTokenRow {
  id: number;
  email: string;
  name: string;
  prefix: string;
  expires_at: string;
  last_used_at: string | null;
}

/**
 * A SERVICE identity's token nearing expiry, with what the digest names: the identity and its
 * custodian. No hash, no scopes.
 */
export interface ExpiringServiceTokenRow {
  id: number;
  name: string;
  prefix: string;
  expires_at: string;
  last_used_at: string | null;
  service_identity_id: number;
  service_slug: string;
  service_name: string;
  principal_id: string;
  custodian_email: string;
}

const DRIFT_REMEDY =
  'api_tokens has no `scopes` column: apply migrations/d1/0003_api_token_scopes.sql (forks: copy it and renumber it to your next free ordinal). Every bearer token is refused until then.';

// `api_token_no_expiry` (remedy `apply_migration_0003_api_token_scopes`) means: api_tokens holds a
// token with no expiry, so the 0003 back-fill never ran on this table (a hand-added `scopes` column
// is not the migration). Apply migrations/d1/0003_api_token_scopes.sql (forks: copy it and renumber
// it). Tokens without an expiry are refused until then.

/**
 * The database is older than the code: `api_tokens.scopes` is missing. Thrown instead of
 * returning a row the auth layer would have to guess about.
 */
export class ApiTokenSchemaDriftError extends Error {
  constructor(readonly op: string) {
    super(DRIFT_REMEDY);
    this.name = 'ApiTokenSchemaDriftError';
  }
}

function drift(op: string): ApiTokenSchemaDriftError {
  // A distinct, grep-able event naming the fix — the operator-facing half of failing closed. The
  // remedy is an id (the migration to apply), not the sentence: logs take no free text (PIA C5).
  // The caller sees a 401 (resolution) or an opaque 500 (mint/list), never the detail.
  logEvent('api_token_schema_drift', { op, remedy: 'apply_migration_0003_api_token_scopes' });
  return new ApiTokenSchemaDriftError(op);
}

// `SELECT *` on purpose: a row from a database without the column simply lacks the key, which is
// how drift is detected at zero extra cost. Naming the column would turn drift into an opaque
// "no such column" D1 error instead.
function assertScopesColumn<T extends object>(row: T, op: string): T {
  if (!('scopes' in row)) throw drift(op);
  return row;
}

function isMissingScopesColumn(err: unknown): boolean {
  return /no (?:such )?column(?: named)?:? scopes/i.test(String(err));
}

/**
 * The lifetime, in days, a new token gets. Absent → the default (a person: the 90-day cap; a
 * service: 90). Longer than the owner's cap → the cap (clamped, not refused: a fork's route may
 * still offer up to 365 and must keep working, just never above the ceiling). Not a positive
 * integer → a programming error, thrown.
 */
export function tokenTtlDays(requested?: number, owner: TokenOwnerKind = 'person'): number {
  const [fallback, cap] =
    owner === 'service'
      ? [SERVICE_TOKEN_DEFAULT_TTL_DAYS, SERVICE_TOKEN_MAX_TTL_DAYS]
      : [TOKEN_MAX_TTL_DAYS, TOKEN_MAX_TTL_DAYS];
  if (requested === undefined) return fallback;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new RangeError(`expiresInDays must be a positive integer (got ${String(requested)})`);
  }
  return Math.min(requested, cap);
}

export function tokensRepo(db: D1Database) {
  return {
    /**
     * Insert a token. `scopes` is REQUIRED and explicit: the auth layer decides it
     * (mintApiToken in src/auth/tokens.ts) — this layer never defaults a token to unscoped. NULL
     * scopes exist only on legacy rows the 0003 migration carried over.
     *
     * An owner in the reserved service namespace gets the SERVICE lifetime and must carry exactly
     * ONE scope (its identity's; mintApiTokenFor decides which) — anything else is a programming
     * error, thrown before a row is written.
     */
    async create(input: {
      email: string;
      name: string;
      tokenHash: string;
      prefix: string;
      scopes: readonly string[];
      expiresInDays?: number;
    }): Promise<ApiTokenRow | null> {
      const owner: TokenOwnerKind = isReservedIdentifier(input.email) ? 'service' : 'person';
      if (owner === 'service' && input.scopes.length !== 1) {
        throw new RangeError(
          `a service identity's token carries exactly one scope (got ${input.scopes.length})`,
        );
      }
      const days = tokenTtlDays(input.expiresInDays, owner);
      try {
        await db
          .prepare(
            "INSERT INTO api_tokens (email, name, token_hash, prefix, scopes, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))",
          )
          .bind(
            input.email.toLowerCase(),
            input.name,
            input.tokenHash,
            input.prefix,
            JSON.stringify([...input.scopes]),
            `+${days} days`,
          )
          .run();
      } catch (err) {
        throw isMissingScopesColumn(err) ? drift('create') : err;
      }
      const row = await db
        .prepare('SELECT * FROM api_tokens WHERE token_hash = ?')
        .bind(input.tokenHash)
        .first<ApiTokenRow>();
      return row ? assertScopesColumn(row, 'create') : null;
    },

    /**
     * The live token for a hash: not revoked, not expired, and not immortal. The SQL still admits
     * a NULL expiry so that the drift checks below see the row — on a database missing the 0003
     * migration, pre-C8 tokens with no expiry are the COMMON case, and they must raise a signal
     * rather than vanish silently. Two distinct ones:
     *   - no `scopes` column at all → ApiTokenSchemaDriftError (`api_token_schema_drift`);
     *   - the column is there but this token has no expiry → refused, and logged as
     *     `api_token_no_expiry` naming the migration. That is PARTIAL drift: a fork that hand-added
     *     the column instead of running 0003, so the table still admits NULL and nothing
     *     back-filled it. Once 0003 has run the column is NOT NULL and this cannot happen.
     */
    async findActiveByHash(hash: string): Promise<ApiTokenRow | null> {
      const row = await db
        .prepare(
          "SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))",
        )
        .bind(hash)
        .first<ApiTokenRow>();
      if (!row) return null;
      assertScopesColumn(row, 'findActiveByHash');
      // Typed as string (the migrated shape); a row written outside this repository may disagree.
      if ((row.expires_at as string | null) === null) {
        // The row id only (never an email, prefix or hash), as in src/auth/tokens.ts's events, and
        // the remedy as an id (what it means is spelled out next to DRIFT_REMEDY above).
        logEvent('api_token_no_expiry', {
          token_id: row.id,
          remedy: 'apply_migration_0003_api_token_scopes',
        });
        return null;
      }
      return row;
    },

    async listForUser(email: string): Promise<ApiTokenRow[]> {
      const res = await db
        .prepare('SELECT * FROM api_tokens WHERE email = ? ORDER BY created_at DESC')
        .bind(email.toLowerCase())
        .all<ApiTokenRow>();
      for (const row of res.results) assertScopesColumn(row, 'listForUser');
      return res.results;
    },

    /**
     * Live tokens that have been USED, belong to an ACTIVE owner, and expire on one of `dates`
     * (UTC calendar dates, `YYYY-MM-DD`) — the tokens entering a notice window on today's run
     * (src/cron/tokenExpiry.ts computes the dates). Soonest first, at most `limit` rows, plus the
     * TOTAL that matched: every legacy token shares one expiry (the 0003 back-fill), so on the
     * migration's cohort day the list can be long, and the notice must still say how many there
     * are rather than silently dropping the rest.
     *
     * The owner join mirrors the resolver's live-user check (users.getActive): a disabled or
     * removed owner's tokens are already dead, so an expiry notice for them is noise.
     */
    async listUsedExpiringOn(
      dates: readonly string[],
      limit = 200,
    ): Promise<{ rows: ExpiringTokenRow[]; total: number }> {
      if (dates.length === 0) return { rows: [], total: 0 };
      // A token owned by a reserved (service) identifier is never a person's, even when a legacy
      // `users` row carries that address — the service digest below reports it instead.
      const where = `FROM api_tokens t JOIN users u ON u.email = t.email AND u.disabled_at IS NULL
        WHERE t.revoked_at IS NULL AND t.last_used_at IS NOT NULL AND t.expires_at > datetime('now')
          AND t.email NOT LIKE '%.invalid'
          AND substr(t.expires_at, 1, 10) IN (SELECT value FROM json_each(?))`;
      const datesJson = JSON.stringify([...dates]);
      const [list, count] = await db.batch([
        db
          .prepare(
            `SELECT t.id, t.email, t.name, t.prefix, t.expires_at, t.last_used_at ${where} ORDER BY t.expires_at ASC, t.id ASC LIMIT ?`,
          )
          .bind(datesJson, limit),
        db.prepare(`SELECT COUNT(*) AS n ${where}`).bind(datesJson),
      ]);
      const rows = (list?.results ?? []) as ExpiringTokenRow[];
      const total = ((count?.results ?? [])[0] as { n: number } | undefined)?.n ?? rows.length;
      return { rows, total };
    },

    /**
     * Revoke every live token an owner holds — a service identity's incident switch. Returns how
     * many were revoked. Scoped to the one owner, like revoke().
     */
    async revokeAllForOwner(email: string): Promise<number> {
      const res = await db
        .prepare(
          "UPDATE api_tokens SET revoked_at = datetime('now') WHERE email = ? AND revoked_at IS NULL",
        )
        .bind(email.toLowerCase())
        .run();
      return res.meta.changes;
    },

    /**
     * SERVICE tokens the daily digest reports: live, USED, owned by an ENABLED identity whose
     * custodian is an ACTIVE user and whose scope is one of `scopes` (the keys a service may still
     * hold — the caller passes them; this layer does not know the permission rules), expiring
     * before `cutoff` (exclusive; SQLite `datetime()` text, UTC — the shape of `expires_at`, so a
     * text comparison is exact). Soonest first, at most `limit` rows, plus the total. A disabled identity's tokens are refused on purpose, and one whose custodian left, or
     * whose scope no service may hold, is reported as such instead
     * (serviceIdentities.listOrphaned / listScopeStranded) — its tokens are already refused, so an
     * expiry is not the news.
     */
    async listServiceTokensExpiringBefore(
      cutoff: string,
      scopes: readonly string[],
      limit = 200,
    ): Promise<{ rows: ExpiringServiceTokenRow[]; total: number }> {
      const where = `FROM api_tokens t
        JOIN service_identities si ON si.principal_id = t.email AND si.disabled_at IS NULL
        JOIN users u ON u.email = si.custodian_email AND u.disabled_at IS NULL
        WHERE t.revoked_at IS NULL AND t.last_used_at IS NOT NULL AND t.expires_at > datetime('now')
          AND t.expires_at < ?
          AND si.scope IN (SELECT value FROM json_each(?))`;
      const scopesJson = JSON.stringify([...scopes]);
      let list: D1Result | undefined;
      let count: D1Result | undefined;
      try {
        [list, count] = await db.batch([
          db
            .prepare(
              `SELECT t.id, t.name, t.prefix, t.expires_at, t.last_used_at,
                 si.id AS service_identity_id, si.slug AS service_slug, si.name AS service_name,
                 si.principal_id, si.custodian_email
               ${where} ORDER BY t.expires_at ASC, t.id ASC LIMIT ?`,
            )
            .bind(cutoff, scopesJson, limit),
          db.prepare(`SELECT COUNT(*) AS n ${where}`).bind(cutoff, scopesJson),
        ]);
      } catch (err) {
        // Migration 0004 not applied: the drift error, with the remedy (serviceIdentities rule 4).
        throw serviceIdentitiesDriftOr(err, 'listServiceTokensExpiringBefore');
      }
      const rows = (list?.results ?? []) as ExpiringServiceTokenRow[];
      const total = ((count?.results ?? [])[0] as { n: number } | undefined)?.n ?? rows.length;
      return { rows, total };
    },

    /** Scoped to the owning email — users can only revoke their own tokens. */
    async revoke(id: number, email: string): Promise<boolean> {
      const res = await db
        .prepare(
          "UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ? AND email = ? AND revoked_at IS NULL",
        )
        .bind(id, email.toLowerCase())
        .run();
      return res.meta.changes > 0;
    },

    async touchLastUsed(id: number): Promise<void> {
      await db
        .prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?")
        .bind(id)
        .run();
    },
  };
}
