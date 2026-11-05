// THE AGENT TRANSCRIPT STORE — the LIVE half: what the turn engine, the run routes and the reaper
// read and write (docs/agent-loop-P2-DESIGN.md §6.4). Its other half, src/data/agentErasure.ts,
// counts, finds, exports, erases and prunes for the DSR route and the retention sweep. The tables
// are migrations/d1/0006_agent_tables.sql (and the identical block in schema.sql), whose header
// states the rules the shape holds; the C7 classification of every column is DECISIONS 2026-10-04.
//
// DORMANT. P2-1 ships the store and this repository with ONE method, `schemaSupport()`, the probe
// the arming predicate (P2-2) and the reaper (P2-6) ask before touching a table. The write methods
// land with the PR that first needs each (§6.4 names it per method), so nothing in src/ writes an
// `agent_*` row until the engine, its retention sweep and its erasure all exist.
//
// THREE THINGS THAT HOLD FOR EVERY METHOD ADDED HERE LATER:
//   1. WRITES ARE DECLARED ON THIS OBJECT (`[DECLARED_WRITES]`, src/data/declaredWrites.ts), never
//      added to the read ledger's global `WRITE_METHOD_NAMES`. That list applies to every
//      repository in every fork, so an agent method name on it would silently stop attributing a
//      fork's same-named READ. No method name starts with upsert|insert|delete|replace|bulk.
//   2. NO TOOL CAN READ A TRANSCRIPT. `agent` (and `agentErasure`) are AGENT_FORBIDDEN_REPOSITORIES
//      (src/auth/permissions.ts): an agent-exposed route that names either in `needs` fails at
//      load. The agent has no memory beyond its own thread, and no route hands it someone else's.
//   3. UNCLASSIFIED ON PURPOSE. Neither repository is listed in src/data/dataClass.ts, so both are
//      CLIENT-class: a transcript quotes whatever tool results the agent saw, client data
//      included. Classifying either `internal` would be a wrong line, not a missing one.
import { DECLARED_WRITES } from './declaredWrites';

/**
 * Does this database hold the agent store migration 0006 creates?
 *
 *   'accepted'  every table, both partial unique indexes and every trigger are present;
 *   'refused'   the probe ran and something is missing — the database is older than the code (a
 *               fork copies kit migrations by hand, so that window is real);
 *   'unknown'   the probe itself failed (D1 unreachable): nothing can be said either way.
 */
export type AgentSchemaSupport = 'accepted' | 'refused' | 'unknown';

/**
 * How a turn ended — the closed set `agent_turns.outcome` holds (design §10.5). The column has a
 * shape CHECK, not an IN-list, so the set can grow without a rebuild; THIS list is the authority.
 * Declared here, with the store, rather than in the engine (src/ai/agent.ts, P2-8): the store's own
 * types take it (`finishTurn`, P2-5) and must not import the engine, and the agent log registry
 * (src/ai/agentLog.ts) declares `agent_turn_end.outcome` over it. The engine re-exports it.
 */
export const AGENT_TURN_OUTCOMES = [
  'completed',
  'truncated',
  'stopped',
  'deadline',
  'awaiting_approval',
  'round_cap',
  'tool_call_cap',
  'turn_budget',
  'daily_budget',
  'revoked',
  'disarmed',
  'model_refused',
  'upstream_error',
  'config_error',
  'request_refused',
  'internal',
  'interrupted',
  'start_failed',
  'reaped',
  'erased',
] as const;

export type AgentTurnOutcome = (typeof AGENT_TURN_OUTCOMES)[number];

/**
 * Every `agent_*` table, CHILDREN FIRST — the only order in which explicit deletes count exactly
 * (a parent delete's `meta.changes` includes its cascaded children) and the order
 * test/helpers/db.ts resets them in. `agent_threads` is the one FK parent.
 */
export const AGENT_TABLES = [
  'agent_instance_purges',
  'agent_feedback',
  'agent_approvals',
  'agent_messages',
  'agent_turns',
  'agent_threads',
] as const;

/**
 * Every trigger 0006 creates. Each holds a privacy rule the application does not re-check (the
 * migration header lists them), so the probe requires all of them, not a sample: a database where
 * one was dropped by hand, or by a later migration that rebuilt a child table and forgot it, is
 * refused rather than trusted.
 */
export const AGENT_TRIGGERS = [
  'agent_threads_no_replace',
  'agent_threads_fixed',
  'agent_messages_no_replace',
  'agent_messages_fixed',
  'agent_turns_no_replace',
  'agent_turns_no_replace_active',
  'agent_turns_fixed',
  'agent_approvals_no_replace',
  'agent_approvals_no_replace_live',
  'agent_approvals_forward',
] as const;

/**
 * What `schemaSupport()` requires, by `sqlite_master` type and name: the six tables, the two
 * partial unique indexes (one active turn, one live approval per thread) and every trigger.
 */
const SCHEMA_MARKERS: readonly {
  readonly type: 'table' | 'index' | 'trigger';
  readonly name: string;
}[] = [
  ...AGENT_TABLES.map((name) => ({ type: 'table' as const, name })),
  { type: 'index', name: 'idx_agent_turns_one_active' },
  { type: 'index', name: 'idx_agent_approvals_one_live' },
  ...AGENT_TRIGGERS.map((name) => ({ type: 'trigger' as const, name })),
];

export function agentRepo(db: D1Database) {
  return {
    // No write method yet (P2-1 ships the probe only). Each later PR adds its writes here.
    [DECLARED_WRITES]: [] as string[],

    /**
     * The 0006 probe: one SELECT on `sqlite_master`, read-only, NEVER throws. The arming predicate
     * refuses on anything but 'accepted' (logging the remedy on 'refused'), and the reaper and the
     * retention sweep stay green no-ops on a database that has no store.
     */
    async schemaSupport(): Promise<AgentSchemaSupport> {
      try {
        const res = await db
          .prepare(
            `SELECT type, name FROM sqlite_master WHERE name IN (${SCHEMA_MARKERS.map(() => '?').join(', ')})`,
          )
          .bind(...SCHEMA_MARKERS.map((m) => m.name))
          .all<{ type: string; name: string }>();
        const present = new Set(res.results.map((r) => `${r.type}:${r.name}`));
        return SCHEMA_MARKERS.every((m) => present.has(`${m.type}:${m.name}`))
          ? 'accepted'
          : 'refused';
      } catch {
        return 'unknown';
      }
    },
  };
}

export type AgentRepo = ReturnType<typeof agentRepo>;
