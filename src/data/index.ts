// THE data layer fence. All D1 access lives in src/data/ — semgrep fails CI if
// `env.DB` (or any DB client) appears anywhere else. Routes receive `ctx.db`
// already constructed; they never touch bindings directly.
import type { Env } from '../env';
import { activityRepo } from './activity';
import { agentRepo } from './agent';
import { agentErasureRepo } from './agentErasure';
import { aiBudgetRepo } from './aiBudget';
import { auditRepo } from './audit';
import { groupsRepo } from './groups';
import { magicLinksRepo } from './magicLinks';
import { metaRepo } from './meta';
import { notesRepo } from './notes';
import { readLogRepo } from './readLog';
import { serviceIdentitiesRepo } from './serviceIdentities';
import { settingsRepo } from './settings';
import { tokensRepo } from './tokens';
import { usersRepo } from './users';

export type { ActivityDigest, ActivityStream, ActivityTop } from './activity';
export type { AgentSchemaSupport } from './agent';
export type {
  AgentExportPage,
  AgentPruneResult,
  AgentRowCounts,
  AgentSelector,
} from './agentErasure';
export type { AuditEntry, AuditRow } from './audit';
export type { GroupRow } from './groups';
export type { AppliedMigration } from './meta';
export type { NoteRow } from './notes';
export type { ReadLogIntent, ReadLogPage, ReadLogRow, ReadSourceClass } from './readLog';
export type {
  ServiceIdentityListRow,
  ServiceIdentityRow,
  ServiceIdentityState,
} from './serviceIdentities';
export type { AlertingSettings, LoginSettings } from './settings';
export type { ApiTokenRow } from './tokens';
export type { UserPage, UserRow } from './users';

export interface Db {
  readonly users: ReturnType<typeof usersRepo>;
  readonly groups: ReturnType<typeof groupsRepo>;
  readonly audit: ReturnType<typeof auditRepo>;
  readonly magicLinks: ReturnType<typeof magicLinksRepo>;
  readonly tokens: ReturnType<typeof tokensRepo>;
  /**
   * Machine principals (src/data/serviceIdentities.ts). Not users: a service identity never has a
   * `users` row, and its tokens are `tokens` rows owned by its svc-…@….invalid identifier.
   */
  readonly serviceIdentities: ReturnType<typeof serviceIdentitiesRepo>;
  readonly aiBudget: ReturnType<typeof aiBudgetRepo>;
  readonly settings: ReturnType<typeof settingsRepo>;
  /**
   * The private-database read ledger (src/data/aurora.ts writes it). Present on every app even
   * though the kit binds no private database: the table, the prune task, and the tests ship
   * armed so that adding a binding is one reviewed grant rather than a capability build.
   */
  readonly readLog: ReturnType<typeof readLogRepo>;
  /**
   * Daily activity digests — COUNTS ONLY (Fleet Ledger K1). Reads across audit_log, ai_usage and
   * read_log; every projection is an aggregate, so no identifier can reach a caller.
   */
  readonly activity: ReturnType<typeof activityRepo>;
  /**
   * The database's own schema self-description: applied migrations, a DDL fingerprint, and the
   * live trigger list. Reads `d1_migrations` and `sqlite_master`, tables no other repository owns.
   */
  readonly meta: ReturnType<typeof metaRepo>;
  /**
   * The in-app agent's transcript store, live half (src/data/agent.ts; tables from migration 0006):
   * what the turn engine, the run routes and the reaper read and write. P2-1 ships only the schema
   * probe. AGENT-FORBIDDEN (no tool may name it in `needs`) and client-class (unlisted in
   * dataClass.ts): a transcript quotes whatever the agent saw.
   */
  readonly agent: ReturnType<typeof agentRepo>;
  /**
   * The transcript store's erasure half (src/data/agentErasure.ts): count, find, export, erase and
   * the row-level retention sweep, for the DSR route and the cron only. Counts each table on its
   * own, never through a cascade. AGENT-FORBIDDEN and client-class, like `agent`.
   */
  readonly agentErasure: ReturnType<typeof agentErasureRepo>;
  // ---- app repositories (golden example — replace with your domain) ----
  readonly notes: ReturnType<typeof notesRepo>;
}

export function makeDb(env: Env): Db {
  const d1 = env.DB;
  return {
    users: usersRepo(d1),
    groups: groupsRepo(d1),
    audit: auditRepo(d1),
    magicLinks: magicLinksRepo(d1),
    tokens: tokensRepo(d1),
    serviceIdentities: serviceIdentitiesRepo(d1),
    aiBudget: aiBudgetRepo(d1),
    settings: settingsRepo(d1),
    readLog: readLogRepo(d1),
    activity: activityRepo(d1),
    meta: metaRepo(d1),
    agent: agentRepo(d1),
    agentErasure: agentErasureRepo(d1),
    notes: notesRepo(d1),
  };
}

/** Health-check ping — lives here so `env.DB` never appears outside src/data. */
export async function pingDb(env: Env): Promise<void> {
  await env.DB.prepare('SELECT 1').first();
}
