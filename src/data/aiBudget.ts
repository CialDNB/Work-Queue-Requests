// AI budget ledger — atomic reserve-then-reconcile. The conditional UPDATE closes the
// check-then-spend race (D1 serializes writes): a reservation only succeeds if it fits
// under the cap at write time, so N parallel calls can never jointly exceed it.
export function aiBudgetRepo(db: D1Database) {
  return {
    async tryReserve(scope: string, day: string, amount: number, cap: number): Promise<boolean> {
      await db
        .prepare(
          'INSERT INTO ai_budget_reservations (scope, day, reserved_usd) VALUES (?, ?, 0) ON CONFLICT (scope, day) DO NOTHING',
        )
        .bind(scope, day)
        .run();
      const res = await db
        .prepare(
          'UPDATE ai_budget_reservations SET reserved_usd = reserved_usd + ?1 WHERE scope = ?2 AND day = ?3 AND reserved_usd + ?1 <= ?4',
        )
        .bind(amount, scope, day, cap)
        .run();
      return res.meta.changes > 0;
    },

    /** Post-call adjustment (negative delta releases over-reservation; floor at 0). */
    async adjust(scope: string, day: string, delta: number): Promise<void> {
      await db
        .prepare(
          'UPDATE ai_budget_reservations SET reserved_usd = MAX(0, reserved_usd + ?) WHERE scope = ? AND day = ?',
        )
        .bind(delta, scope, day)
        .run();
    },

    /**
     * Drop reservation rows for UTC days strictly before `day`. The ledger is keyed by
     * (scope, day) and each day is independent — past days are never read again, so they
     * are pure accumulation (~users+1 rows/day). Cron hygiene; nothing reads them.
     */
    async pruneOlderThan(day: string): Promise<number> {
      const res = await db
        .prepare('DELETE FROM ai_budget_reservations WHERE day < ?')
        .bind(day)
        .run();
      return res.meta.changes;
    },

    async reservedToday(scope: string, day: string): Promise<number> {
      const row = await db
        .prepare('SELECT reserved_usd AS r FROM ai_budget_reservations WHERE scope = ? AND day = ?')
        .bind(scope, day)
        .first<{ r: number }>();
      return row?.r ?? 0;
    },

    /**
     * ONE scalar: this app's total AI cost over the trailing `days` window — the fleet spend
     * tripwire the daily registry report carries. Deliberately an aggregate with no GROUP BY:
     * the fleet spends ~$129/month across 17 apps with 87% of it in a single app, so per-user
     * attribution machinery is not justified at that size — an alarm for when that stops being
     * true is. Keeping it a single SUM is also what keeps `actor_email` inside the app; there
     * is no per-user breakdown to leak, hash, or roll up. (If the number ever grows past what
     * the owner cares about, attribution gets designed then, against real volume.)
     *
     * `created_at` is a `datetime('now')` UTC string, so the lexicographic `>=` against the
     * same-format cutoff SQLite computes is a true time comparison. COALESCE makes an app that
     * has never called the AI report 0 — never null, never an error.
     */
    async spendUsdSinceDays(days: number): Promise<number> {
      const row = await db
        .prepare(
          "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_usage WHERE created_at >= datetime('now', ?)",
        )
        .bind(`-${days} days`)
        .first<{ total: number }>();
      // Summing many small floats drifts (0.1 + 0.2 = 0.30000000000000004); round to the
      // micro-dollar so the reported scalar is stable across runs and readable in the registry.
      return Math.round((row?.total ?? 0) * 1e6) / 1e6;
    },

    async insertUsage(entry: {
      email: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }): Promise<void> {
      await db
        .prepare(
          'INSERT INTO ai_usage (actor_email, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(
          entry.email.toLowerCase(),
          entry.model,
          entry.inputTokens,
          entry.outputTokens,
          entry.costUsd,
        )
        .run();
    },
  };
}
