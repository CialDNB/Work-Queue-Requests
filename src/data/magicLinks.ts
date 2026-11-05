// The `token` column stores sha256(emailed token), never the plaintext (AICOE-346) — the
// auth layer hashes before insert and claim (src/auth/magicLink.ts), so a D1 reader cannot
// turn an unconsumed row into a login. The column KEEPS the name `token` deliberately:
// renaming it would force the kit's first live-table migration for a purely cosmetic gain.
export interface MagicLinkClaim {
  email: string;
  return_to: string | null;
}

export function magicLinksRepo(db: D1Database) {
  return {
    async insert(
      tokenHash: string,
      email: string,
      returnTo: string | null,
      ttlSec: number,
    ): Promise<void> {
      await db
        .prepare(
          "INSERT INTO magic_links (token, email, return_to, expires_at) VALUES (?, ?, ?, datetime('now', ?))",
        )
        .bind(tokenHash, email.toLowerCase(), returnTo, `+${ttlSec} seconds`)
        .run();
    },

    /**
     * Atomic claim — the anti-replay core. The conditional UPDATE…RETURNING means
     * exactly one parallel verify can win per token; everyone else (and anyone with
     * an expired token) gets null. D1 serializes writes, so there is no TOCTOU gap.
     */
    async claim(tokenHash: string): Promise<MagicLinkClaim | null> {
      return db
        .prepare(
          "UPDATE magic_links SET consumed_at = datetime('now') WHERE token = ? AND consumed_at IS NULL AND expires_at > datetime('now') RETURNING email, return_to",
        )
        .bind(tokenHash)
        .first<MagicLinkClaim>();
    },

    /** Cron hygiene: drop tokens that expired more than `days` ago. */
    async pruneExpired(days: number): Promise<number> {
      const res = await db
        .prepare("DELETE FROM magic_links WHERE expires_at < datetime('now', ?)")
        .bind(`-${days} days`)
        .run();
      return res.meta.changes;
    },
  };
}
