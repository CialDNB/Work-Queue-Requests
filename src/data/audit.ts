// Append-only audit log. Application code only ever INSERTs and SELECTs —
// no UPDATE or DELETE exists in this repo, by design.
import type { AuthMethod } from '../auth/types';

export interface AuditEntry {
  actor_email: string;
  action: string;
  target?: string | null;
  payload_json?: string | null;
  ip?: string | null;
}

export interface AuditRow {
  id: number;
  actor_email: string;
  action: string;
  target: string | null;
  payload_json: string | null;
  ip: string | null;
  created_at: string;
}

export interface AuditPage {
  items: AuditRow[];
  /** Cursor (oldest id on this page) for the next older page, or null when this is the last. */
  next_before: number | null;
}

// Upper bound on the rows the daily anomaly digest pulls in one pass (sinceHours). A refusal
// flood could otherwise make a 24h window unboundedly large; sinceHours keeps the NEWEST `cap`
// rows and the digest flags `capped`. Exported so the cron's truncation check reads the SAME
// number rather than a copy-pasted literal that could silently drift out of step with this
// default.
export const AUDIT_WINDOW_ROW_CAP = 50_000;

// hasSuccessfulLogin's probe, exported so the query-plan test checks the SQL that actually
// runs (a copy in the test could drift off the index and stay green). ?1 is the method; ?2 the
// Entra tenant, or NULL for "any tenant".
export const HAS_SUCCESSFUL_LOGIN_SQL =
  "SELECT 1 AS present FROM audit_log WHERE action = 'login' AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.method') = ?1 AND (?2 IS NULL OR json_extract(payload_json, '$.tid') = ?2) END LIMIT 1";

export function auditRepo(db: D1Database) {
  return {
    async insert(entry: AuditEntry): Promise<void> {
      await db
        .prepare(
          'INSERT INTO audit_log (actor_email, action, target, payload_json, ip) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(
          entry.actor_email.toLowerCase(),
          entry.action,
          entry.target ?? null,
          entry.payload_json ?? null,
          entry.ip ?? null,
        )
        .run();
    },

    /**
     * Newest first; numeric `before` id cursor for paging back in time. Fetches limit+1 and
     * trims, so next_before is emitted only when an older row actually exists — never on an
     * exactly-full final page (the phantom trailing page a bare `LIMIT n` cursor produces).
     */
    async list(opts: { limit: number; before?: number }): Promise<AuditPage> {
      const res = opts.before
        ? await db
            .prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?')
            .bind(opts.before, opts.limit + 1)
            .all<AuditRow>()
        : await db
            .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
            .bind(opts.limit + 1)
            .all<AuditRow>();
      const hasMore = res.results.length > opts.limit;
      const items = hasMore ? res.results.slice(0, opts.limit) : res.results;
      const last = items[items.length - 1];
      return { items, next_before: hasMore && last ? last.id : null };
    },

    /**
     * `created_at` of the NEWEST row for `action` written by a SERVICE identity, or null when no
     * service ever wrote it. A service's actor is its principal id, `svc-<slug>@<app>.invalid` —
     * the same `LIKE 'svc-%@%.invalid'` the service_identities CHECK holds every principal id to,
     * and an address no person can have (src/auth/serviceNamespace.ts). The machine-liveness check
     * (src/cron/machineLiveness.ts) asks it once per machine audit action: only a service reaches a
     * machine route, so a person route or a ctx.audit() extra that writes the same action must not
     * count as a batch. `WHERE action = ? ORDER BY id DESC LIMIT 1` walks the idx_audit_action
     * (action, id) index from the newest row and stops at the first service row — one row when
     * only the integration writes the action. Reads no payload.
     */
    async latestServiceRowAt(action: string): Promise<string | null> {
      const row = await db
        .prepare(
          "SELECT created_at FROM audit_log WHERE action = ? AND actor_email LIKE 'svc-%@%.invalid' ORDER BY id DESC LIMIT 1",
        )
        .bind(action)
        .first<{ created_at: string }>();
      return row?.created_at ?? null;
    },

    async listByAction(action: string, limit: number): Promise<AuditRow[]> {
      const res = await db
        .prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?')
        .bind(action, limit)
        .all<AuditRow>();
      return res.results;
    },

    /**
     * Has a login by this method EVER completed on this app? A question of fact that a config
     * check cannot answer: the `login` row is written (src/auth/oidc.ts, src/auth/magicLink.ts)
     * only AFTER a session is minted, so a row exists exactly when the round trip has worked at
     * least once. Reading the log adds no state to keep in sync — a "proven" flag could drift
     * from reality, an append-only log cannot.
     *
     * With `tid`, only a login FROM that Entra tenant counts: src/auth/oidc.ts writes the
     * lowercased, allowlisted `tid` of every Microsoft sign-in. The entra-only guard always asks
     * per tenant, because admin consent is granted per tenant: a sign-in from one tenant proves
     * nothing about another's (src/routes/settings.ts).
     *
     * json_extract on the field, never LIKE: a substring match would also fire on a payload that
     * merely mentions the method name. The CASE is load-bearing: SQLite's json_extract THROWS on
     * malformed JSON rather than returning NULL, so one unparseable payload_json row (append-only,
     * never migrated — one is enough, forever) would turn every call into a 500. CASE guarantees
     * json_valid runs first, which a bare AND does not (the planner may reorder its terms); an
     * unparseable row is simply not proof, and the answer stays false — the safe direction for a
     * guard whose wrong `true` locks users out.
     *
     * `action = 'login'` rides idx_audit_action; LIMIT 1 makes it an existence probe, not a count.
     */
    async hasSuccessfulLogin(method: AuthMethod, tid?: string): Promise<boolean> {
      const row = await db
        .prepare(HAS_SUCCESSFUL_LOGIN_SQL)
        .bind(method, tid ?? null)
        .first<{ present: number }>();
      return row !== null;
    },

    /**
     * The last `hours` window, returned OLDEST first (id ASC) — the shape the daily audit-anomaly
     * digest scans (chronological first-seen-IP detection, per-domain/action counts). Time-scoped
     * so the query stays bounded as the log grows: `created_at` is a `datetime('now')` UTC string,
     * so the lexicographic `>=` is a true time comparison and it rides the idx_audit_created index.
     * A `cap` bounds the worst case (a refusal flood can make the window very large) so the digest
     * can never pull an unbounded set into the isolate. When the window exceeds the cap we keep the
     * NEWEST `cap` rows (inner id DESC + LIMIT) and re-sort them ascending for the detector — a
     * bare `ORDER BY id ASC LIMIT` would keep the OLDEST rows and DROP the newest, so on a flood
     * day (the one time the window exceeds the cap) the digest would analyze the START of the
     * window and miss the most recent, most actionable anomalies. The cron flags `capped` so the
     * partial-window counts read as a floor.
     */
    async sinceHours(hours: number, cap = AUDIT_WINDOW_ROW_CAP): Promise<AuditRow[]> {
      const res = await db
        .prepare(
          "SELECT * FROM (SELECT * FROM audit_log WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
        )
        .bind(`-${hours} hours`, cap)
        .all<AuditRow>();
      return res.results;
    },
  };
}
