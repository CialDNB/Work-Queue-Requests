// THE AGENT TRANSCRIPT STORE — the ERASURE half: count, find, export, erase and prune, for the DSR
// route (P2-7, PIA §7, C4) and the retention sweep (P2-6, C1) only. The live half — what the turn
// engine and the run routes read and write — is src/data/agent.ts; the tables and the rules their
// shape holds are migrations/d1/0006_agent_tables.sql. Design: docs/agent-loop-P2-DESIGN.md §6.4,
// §14.1 and §15.
//
// DORMANT. Nothing in src/ calls this repository yet; the sweep and the DSR route that do land in
// P2-6 and P2-7. The instance-purge methods (§6.4) land with P2-6 too.
//
// FOUR RULES EVERY METHOD HERE KEEPS:
//   1. CHILDREN ARE COUNTED AND DELETED EXPLICITLY, BEFORE THEIR THREAD. D1's `meta.changes` on a
//      DELETE counts the rows its ON DELETE CASCADE removed as well, so "deleted 3 threads" from a
//      parent delete would really mean three threads plus every message, turn, approval and
//      feedback row under them. Deleting the children first leaves the cascade nothing to do, and
//      every count reported to a data subject or an operator is the count of that table's rows.
//   2. AT MOST 50 IDS IN ONE IN-LIST (`AGENT_ERASE_BATCH`). D1 binds at most 100 parameters per
//      statement; 50 leaves room for the other parameters a statement carries, and a page of 50
//      threads is a transaction D1 commits well inside its statement time limit.
//   3. ONE BATCH PER ERASE PAGE. `eraseThreads` sends the purge-queue insert and every DELETE as one
//      `db.batch`, which D1 runs as one transaction: a page is erased whole or not at all.
//   4. NO CONTENT LEAVES IN AN ERROR. A malformed argument throws a TypeError or RangeError that
//      names the argument, never its value — a selector holds an email, and a needle holds
//      whatever the requester asked to find.
//
// Writes are declared on the object (`[DECLARED_WRITES]`), never on the read ledger's global list
// (src/data/agent.ts says why). Both halves are AGENT_FORBIDDEN_REPOSITORIES and unclassified
// (client-class) in src/data/dataClass.ts.
import { DECLARED_WRITES } from './declaredWrites';

/** Which threads a DSR action covers. `threads` names at most `AGENT_SELECTOR_MAX_THREADS`. */
export type AgentSelector =
  | { readonly kind: 'user'; readonly email: string }
  | { readonly kind: 'subject'; readonly subjectKind: string; readonly subjectId: string }
  | { readonly kind: 'threads'; readonly threadIds: readonly string[] };

/** Rows per table — each table's own rows, never inflated by a cascade (rule 1). */
export interface AgentRowCounts {
  threads: number;
  messages: number;
  turns: number;
  approvals: number;
  feedback: number;
}

export interface AgentPruneResult {
  /** Rows deleted per table, across every pass. */
  deleted: AgentRowCounts;
  /** DELETE statements issued. Every step makes at least one, so a run that finds nothing makes five. */
  passes: number;
  /** True when nothing eligible is left; false when the pass cap stopped the run. */
  drained: boolean;
  /**
   * Only when `drained` is false: how many days past the cutoff the oldest row still waiting is,
   * so the sweep (P2-6) can tell a backlog that drains over a few nights from one that never will.
   */
  overdueDays: number | null;
}

export interface AgentExportMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: 'user' | 'assistant';
  readonly state: 'streaming' | 'final';
  readonly content: string;
  /** Provenance: tool labels, notice keys, the UI intents the reply emitted (parsed `meta_json`). */
  readonly meta: unknown;
  readonly createdAt: string;
}

/** An approval as exported: what was asked and what happened to it. NEVER its arguments. */
export interface AgentExportApproval {
  readonly id: string;
  readonly toolName: string;
  readonly status: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly consumedAt: string | null;
}

export interface AgentExportFeedback {
  readonly messageId: string;
  readonly rating: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentExportThread {
  readonly threadId: string;
  readonly userEmail: string;
  readonly subject: { readonly kind: string; readonly id: string } | null;
  readonly createdAt: string;
  readonly lastMessageAt: string;
  readonly messages: readonly AgentExportMessage[];
  readonly approvals: readonly AgentExportApproval[];
  readonly feedback: readonly AgentExportFeedback[];
}

/** One page of a PIA §7.9 export: whole threads, in id order. */
export interface AgentExportPage {
  readonly threads: readonly AgentExportThread[];
  /** Pass as `afterId` for the next page; null on the last one. */
  readonly nextAfterId: string | null;
}

/** Most thread ids in one IN-list, one erase batch, one id page and one export page (rule 2). */
export const AGENT_ERASE_BATCH = 50;
/** Most thread ids a `threads` selector may name (docs/agent-loop-P2-DESIGN.md §3, row 18). */
export const AGENT_SELECTOR_MAX_THREADS = 100;
/** Rows one prune DELETE removes: `id IN (SELECT id … LIMIT 500)`. */
export const AGENT_PRUNE_CHUNK_ROWS = 500;
/** Most DELETE statements one prune run issues, across all five steps. */
export const AGENT_PRUNE_MAX_PASSES = 40;
/** `findThreads`: at most 20 needles of 3 to 128 characters (PIA §7.3 locate). */
export const AGENT_FIND_MAX_NEEDLES = 20;
export const AGENT_FIND_NEEDLE_CHARS = { min: 3, max: 128 } as const;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LABEL = /^[A-Z][A-Z0-9_]{0,31}$/;
const SUBJECT_KIND = /^[a-z0-9_]{1,32}$/;
const SUBJECT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_LABELS = 32;
const DAY_MS = 86_400_000;

function zeroCounts(): AgentRowCounts {
  return { threads: 0, messages: 0, turns: 0, approvals: 0, feedback: 0 };
}

function addCounts(into: AgentRowCounts, more: AgentRowCounts): void {
  into.threads += more.threads;
  into.messages += more.messages;
  into.turns += more.turns;
  into.approvals += more.approvals;
  into.feedback += more.feedback;
}

/** `?1, ?2, …` from `from`, so a statement can reuse a parameter by number. */
function numbered(from: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `?${from + i}`).join(', ');
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Exactly the `toISOString()` text of a real instant — what the columns' strftime CHECK accepts.
 * The shape alone is not enough: `Date.parse` rolls '2026-02-30T…' over to 2 March, which the
 * CHECK refuses, so a guard that only parsed would let through a value the database rejects.
 */
function assertIso(value: string, name: string): void {
  const ms = typeof value === 'string' && ISO_MS.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== value) {
    throw new TypeError(`agentErasure: ${name} must be an ISO-8601 timestamp with milliseconds`);
  }
}

function assertLimit(value: number, name: string, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`agentErasure: ${name} must be an integer from 1 to ${max}`);
  }
}

function assertAfterId(afterId: string | null): void {
  if (afterId !== null && !ID.test(afterId)) {
    throw new TypeError('agentErasure: afterId must be null or a thread id');
  }
}

/** Distinct, valid thread ids in id order. Throws on a malformed one rather than skipping it. */
function threadIdList(ids: readonly string[], max: number): string[] {
  if (!Array.isArray(ids) || ids.length > max) {
    throw new RangeError(`agentErasure: at most ${max} thread ids`);
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !ID.test(id))
      throw new TypeError('agentErasure: malformed thread id');
  }
  return [...new Set(ids)].sort();
}

/**
 * The two stored forms one requested address can have, as `[unicode, ascii]`. Kit writers store the
 * principal's address folded by JS `toLowerCase()` (src/data/users.ts), which folds every letter.
 * The columns' CHECK (`= lower(…)`) is SQLite's lower(), which folds ASCII only, so it also admits
 * an address whose non-ASCII capitals were left as written. The selector matches both forms
 * (`IN (?1, ?2)`, one form repeated when they agree), so neither is left behind by an erase.
 */
function selectorEmails(email: string): [string, string] {
  const trimmed = typeof email === 'string' ? email.trim() : '';
  const folded = trimmed.toLowerCase();
  if (folded.length < 3 || folded.length > 320 || folded.indexOf('@') < 1) {
    throw new TypeError('agentErasure: the user selector needs an email address');
  }
  return [folded, asciiLower(trimmed)];
}

/**
 * One WHERE over `agent_threads` with numbered parameters from ?1, as a set of SELECTs a statement
 * can reuse. A `threads` selector becomes one scope per 50 ids (rule 2); the ids are distinct, so
 * scopes never overlap and their counts add up.
 */
interface ThreadScope {
  /** `SELECT id FROM agent_threads WHERE …`, parameters ?1 … ?n. */
  readonly threads: string;
  readonly binds: readonly unknown[];
  /** Extra approvals the selector reaches outside its threads (by the actor), as an OR clause. */
  readonly approvalsAlso: string;
}

function scopesOf(sel: AgentSelector): ThreadScope[] {
  switch (sel.kind) {
    case 'user':
      return [
        {
          threads: 'SELECT id FROM agent_threads WHERE user_email IN (?1, ?2)',
          binds: selectorEmails(sel.email),
          // The PIA §7.4 SQL erases approvals by actor_email as well as by thread.
          approvalsAlso: ' OR actor_email IN (?1, ?2)',
        },
      ];
    case 'subject':
      if (!SUBJECT_KIND.test(sel.subjectKind) || !SUBJECT_ID.test(sel.subjectId)) {
        throw new TypeError('agentErasure: malformed subject selector');
      }
      return [
        {
          threads: 'SELECT id FROM agent_threads WHERE subject_kind = ?1 AND subject_id = ?2',
          binds: [sel.subjectKind, sel.subjectId],
          approvalsAlso: '',
        },
      ];
    case 'threads':
      return chunked(
        threadIdList(sel.threadIds, AGENT_SELECTOR_MAX_THREADS),
        AGENT_ERASE_BATCH,
      ).map((ids) => ({
        threads: `SELECT id FROM agent_threads WHERE id IN (${numbered(1, ids.length)})`,
        binds: ids,
        approvalsAlso: '',
      }));
    default:
      throw new TypeError('agentErasure: unknown selector kind');
  }
}

/** ASCII-only lowercasing — exactly what SQLite's lower() does, so both sides fold alike. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The forms one needle is searched in, every one against `lower(column)`. SQLite's lower() folds
 * ASCII only, so a non-ASCII letter matches only in the case it is stored in: folded the column's
 * way alone, 'João' never finds the bureau-style 'JOÃO', nor 'MUÑOZ' a 'Muñoz'. So each needle is
 * folded three ways — ASCII only (the column's own fold, which also covers the needle exactly as
 * written), fully lowercased, and fully uppercased then ASCII-folded — and the same three for its
 * JSON-escaped form, because the JSON columns hold a quote, a backslash or a control character
 * escaped. That finds content stored in one case throughout, either way round. Not covered:
 * content that mixes cases on its accented letters ('JOÃO da conceição') or stores another
 * Unicode normalisation (NFD) — one more reason the locate cannot prove absence. Always six
 * parameters (a form that adds nothing repeats one).
 */
function needleForms(needle: string): string[] {
  const folds = (s: string) => [asciiLower(s), s.toLowerCase(), asciiLower(s.toUpperCase())];
  return [...folds(needle), ...folds(JSON.stringify(needle).slice(1, -1))];
}

const NEEDLE_FORMS = 6;

function matches(column: string): string {
  return `(${Array.from({ length: NEEDLE_FORMS }, (_, i) => `instr(lower(${column}), ?${i + 1}) > 0`).join(' OR ')})`;
}

// Every column a transcript's content can sit in: the messages (text and provenance), the turn's
// held transcript and in-flight events, and a pending or approved approval's arguments and card.
const FIND_SQL = `SELECT thread_id, COUNT(*) AS hits FROM (
  SELECT thread_id FROM agent_messages WHERE ${matches('content')} OR ${matches('meta_json')}
  UNION ALL
  SELECT thread_id FROM agent_turns WHERE ${matches('pending_json')} OR ${matches('events_json')}
  UNION ALL
  SELECT thread_id FROM agent_approvals WHERE ${matches('args_json')} OR ${matches('summary_json')}
) GROUP BY thread_id`;

// ── Retention: the five steps, children first (docs/agent-loop-P2-DESIGN.md §14.1) ────────────────
// Each eligibility predicate takes the cutoff as ?1. The same predicate drives the DELETE and the
// backlog measure, so what is measured is exactly what would have been deleted.
const MESSAGE_DUE = `created_at < ?1 AND (turn_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM agent_turns t WHERE t.id = agent_messages.turn_id AND t.status <> 'done'))`;

interface PruneStep {
  readonly key: keyof AgentRowCounts;
  readonly table: string;
  /** The column the step orders by and measures the backlog on. */
  readonly time: string;
  readonly due: string;
}

const PRUNE_STEPS: readonly PruneStep[] = [
  // 1. Feedback older than the cutoff, or on a message this run deletes.
  {
    key: 'feedback',
    table: 'agent_feedback',
    time: 'created_at',
    due: `created_at < ?1 OR message_id IN (SELECT id FROM agent_messages WHERE ${MESSAGE_DUE})`,
  },
  // 2. Messages older than the cutoff — never one of a turn that is still queued or running.
  { key: 'messages', table: 'agent_messages', time: 'created_at', due: MESSAGE_DUE },
  // 3. Approvals older than the cutoff.
  { key: 'approvals', table: 'agent_approvals', time: 'created_at', due: 'created_at < ?1' },
  // 4. Done turns older than the cutoff.
  {
    key: 'turns',
    table: 'agent_turns',
    time: 'created_at',
    due: "status = 'done' AND created_at < ?1",
  },
  // 5. Threads whose last message is older than the cutoff and that hold nothing any more. A
  //    thread still holding a younger row stays, so a thread in use never loses its parent.
  {
    key: 'threads',
    table: 'agent_threads',
    time: 'last_message_at',
    due: `last_message_at < ?1
      AND NOT EXISTS (SELECT 1 FROM agent_messages c WHERE c.thread_id = agent_threads.id)
      AND NOT EXISTS (SELECT 1 FROM agent_turns c WHERE c.thread_id = agent_threads.id)
      AND NOT EXISTS (SELECT 1 FROM agent_approvals c WHERE c.thread_id = agent_threads.id)
      AND NOT EXISTS (SELECT 1 FROM agent_feedback c WHERE c.thread_id = agent_threads.id)`,
  },
];

interface ThreadRow {
  id: string;
  user_email: string;
  subject_kind: string | null;
  subject_id: string | null;
  created_at: string;
  last_message_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  seq: number;
  role: 'user' | 'assistant';
  state: 'streaming' | 'final';
  content: string;
  meta_json: string | null;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  thread_id: string;
  tool_name: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  consumed_at: string | null;
}

interface FeedbackRow {
  thread_id: string;
  message_id: string;
  rating: number;
  created_at: string;
  updated_at: string;
}

function parsedMeta(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // json_valid() CHECK makes this unreachable; never lose the data if it is not
  }
}

function groupBy<T extends { thread_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.thread_id);
    if (list) list.push(row);
    else out.set(row.thread_id, [row]);
  }
  return out;
}

export function agentErasureRepo(db: D1Database) {
  /**
   * Up to `limit` existing thread ids the selector covers, after `afterId`, in id order. Internal
   * so `exportPage` can look one id ahead (limit + 1) without widening the public cap.
   */
  async function idsAfter(
    sel: AgentSelector,
    afterId: string | null,
    limit: number,
  ): Promise<string[]> {
    assertAfterId(afterId);
    if (sel.kind === 'threads') {
      const wanted = threadIdList(sel.threadIds, AGENT_SELECTOR_MAX_THREADS).filter(
        (id) => afterId === null || id > afterId,
      );
      const found: string[] = [];
      for (const ids of chunked(wanted, AGENT_ERASE_BATCH)) {
        const res = await db
          .prepare(
            `SELECT id FROM agent_threads WHERE id IN (${numbered(1, ids.length)}) ORDER BY id`,
          )
          .bind(...ids)
          .all<{ id: string }>();
        found.push(...res.results.map((r) => r.id));
        if (found.length >= limit) break;
      }
      return found.slice(0, limit);
    }
    const [scope] = scopesOf(sel);
    if (!scope) return [];
    const n = scope.binds.length;
    const res = await db
      .prepare(
        `SELECT id FROM (${scope.threads}) WHERE ?${n + 1} IS NULL OR id > ?${n + 1} ORDER BY id LIMIT ?${n + 2}`,
      )
      .bind(...scope.binds, afterId, limit)
      .all<{ id: string }>();
    return res.results.map((r) => r.id);
  }

  return {
    [DECLARED_WRITES]: ['eraseThreads', 'eraseApprovalsByActor', 'pruneTranscripts'],

    /**
     * Is there any transcript row at all? The retention sweep refuses an invalid retention while
     * any exists (it must page, not quietly keep them). Content tables only: a queued instance
     * purge holds ids, not content, and FKs make every child imply a thread anyway.
     */
    async hasAnyRows(): Promise<boolean> {
      const row = await db
        .prepare(
          `SELECT (EXISTS (SELECT 1 FROM agent_threads) OR EXISTS (SELECT 1 FROM agent_messages)
             OR EXISTS (SELECT 1 FROM agent_turns) OR EXISTS (SELECT 1 FROM agent_approvals)
             OR EXISTS (SELECT 1 FROM agent_feedback)) AS any_rows`,
        )
        .first<{ any_rows: number }>();
      return row?.any_rows === 1;
    },

    /**
     * Rows the selector covers, per table, each counted on its own (rule 1). For a `user` selector
     * approvals include those the person acted on in any thread — what `eraseApprovalsByActor`
     * removes — so an erase's after-count can really reach zero.
     */
    async countFor(sel: AgentSelector): Promise<AgentRowCounts> {
      const total = zeroCounts();
      for (const scope of scopesOf(sel)) {
        const row = await db
          .prepare(
            `WITH t AS (${scope.threads}) SELECT
               (SELECT COUNT(*) FROM t) AS threads,
               (SELECT COUNT(*) FROM agent_messages WHERE thread_id IN (SELECT id FROM t)) AS messages,
               (SELECT COUNT(*) FROM agent_turns WHERE thread_id IN (SELECT id FROM t)) AS turns,
               (SELECT COUNT(*) FROM agent_approvals WHERE thread_id IN (SELECT id FROM t)${scope.approvalsAlso}) AS approvals,
               (SELECT COUNT(*) FROM agent_feedback WHERE thread_id IN (SELECT id FROM t)) AS feedback`,
          )
          .bind(...scope.binds)
          .first<AgentRowCounts>();
        if (row) addCounts(total, row);
      }
      return total;
    },

    /** The selector's thread ids after `afterId`, in id order, at most `limit` (≤ 50) — an erase page. */
    async threadIdsFor(
      sel: AgentSelector,
      afterId: string | null,
      limit: number,
    ): Promise<string[]> {
      assertLimit(limit, 'limit', AGENT_ERASE_BATCH);
      return idsAfter(sel, afterId, limit);
    },

    /**
     * Erase up to 50 threads, whole, in ONE transaction (rule 3), and return what was deleted. In
     * order: queue the Workflow instance ids of the threads' turns created since
     * `queuePurgesCreatedSinceIso` (older instances have expired by retention — the caller passes
     * now − 8 days), then delete feedback, approvals, messages and turns, then the threads. The
     * caller retires any active turn first (P2-7); this deletes whatever it finds.
     *
     * The purge insert skips an id already queued (`ON CONFLICT (run_id) DO NOTHING`) — narrower
     * than INSERT OR IGNORE, which would also skip a row that broke a CHECK, silently.
     */
    async eraseThreads(
      threadIds: readonly string[],
      o: { queuePurgesCreatedSinceIso: string; nowIso: string },
    ): Promise<AgentRowCounts> {
      const ids = threadIdList(threadIds, AGENT_ERASE_BATCH);
      assertIso(o.queuePurgesCreatedSinceIso, 'queuePurgesCreatedSinceIso');
      assertIso(o.nowIso, 'nowIso');
      if (ids.length === 0) return zeroCounts();
      const n = ids.length;
      const inIds = numbered(1, n);
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO agent_instance_purges (run_id, queued_at)
             SELECT id, ?${n + 1} FROM agent_turns WHERE thread_id IN (${inIds}) AND created_at >= ?${n + 2}
             ON CONFLICT (run_id) DO NOTHING`,
          )
          .bind(...ids, o.nowIso, o.queuePurgesCreatedSinceIso),
        db.prepare(`DELETE FROM agent_feedback WHERE thread_id IN (${inIds})`).bind(...ids),
        db.prepare(`DELETE FROM agent_approvals WHERE thread_id IN (${inIds})`).bind(...ids),
        db.prepare(`DELETE FROM agent_messages WHERE thread_id IN (${inIds})`).bind(...ids),
        db.prepare(`DELETE FROM agent_turns WHERE thread_id IN (${inIds})`).bind(...ids),
        db.prepare(`DELETE FROM agent_threads WHERE id IN (${inIds})`).bind(...ids),
      ]);
      const changes = (i: number): number => results[i]?.meta.changes ?? 0;
      return {
        feedback: changes(1),
        approvals: changes(2),
        messages: changes(3),
        turns: changes(4),
        threads: changes(5),
      };
    },

    /** The PIA §7.4 approvals statement: every approval the person acted on, in any thread. */
    async eraseApprovalsByActor(email: string): Promise<number> {
      const res = await db
        .prepare('DELETE FROM agent_approvals WHERE actor_email IN (?1, ?2)')
        .bind(...selectorEmails(email))
        .run();
      return res.meta.changes;
    },

    /**
     * The PIA §7.3 locate: threads whose content contains any needle, with a hit count (one per
     * matching row per needle), most hits first. Each needle is searched folded three ways against
     * the column's ASCII-only lower() — so 'João' finds 'JOÃO' and the reverse — plain and
     * JSON-escaped, over every content column (`needleForms` says what is not covered). A token
     * label `CPF` searches `[CPF#`, the masked form a held transcript stores. It CANNOT PROVE
     * ABSENCE: content may spell an identifier another way, and that is stated to the requester.
     */
    async findThreads(q: {
      needles: readonly string[];
      tokenLabels: readonly string[];
    }): Promise<{ threadId: string; hits: number }[]> {
      const { needles, tokenLabels } = q;
      if (!Array.isArray(needles) || needles.length > AGENT_FIND_MAX_NEEDLES) {
        throw new RangeError(`agentErasure: at most ${AGENT_FIND_MAX_NEEDLES} needles`);
      }
      for (const needle of needles) {
        if (
          typeof needle !== 'string' ||
          needle.length < AGENT_FIND_NEEDLE_CHARS.min ||
          needle.length > AGENT_FIND_NEEDLE_CHARS.max
        ) {
          throw new RangeError(
            `agentErasure: a needle is ${AGENT_FIND_NEEDLE_CHARS.min} to ${AGENT_FIND_NEEDLE_CHARS.max} characters`,
          );
        }
      }
      if (!Array.isArray(tokenLabels) || tokenLabels.length > MAX_LABELS) {
        throw new RangeError(`agentErasure: at most ${MAX_LABELS} token labels`);
      }
      for (const label of tokenLabels) {
        if (typeof label !== 'string' || !LABEL.test(label)) {
          throw new TypeError('agentErasure: a token label is an uppercase label name');
        }
      }
      const searches = [...new Set([...needles, ...tokenLabels.map((label) => `[${label}#`)])];
      if (searches.length === 0) throw new RangeError('agentErasure: nothing to find');

      const hits = new Map<string, number>();
      const stmt = db.prepare(FIND_SQL);
      const pages = await db.batch<{ thread_id: string; hits: number }>(
        searches.map((s) => stmt.bind(...needleForms(s))),
      );
      for (const page of pages) {
        for (const row of page.results)
          hits.set(row.thread_id, (hits.get(row.thread_id) ?? 0) + row.hits);
      }
      return [...hits]
        .map(([threadId, n]) => ({ threadId, hits: n }))
        .sort(
          (a, b) =>
            b.hits - a.hits || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0),
        );
    },

    /**
     * One page of the export (PIA §7.9): up to `limit` (≤ 50) whole threads after `afterId`, with
     * their messages (content, role, state, time, provenance), approvals (tool, status, times —
     * NEVER arguments: a pending or approved approval's arguments are the model's proposal, not
     * the subject's data, and are cleared once it is consumed, denied or expired) and feedback
     * ratings. Four reads in one batch.
     */
    async exportPage(
      sel: AgentSelector,
      afterId: string | null,
      limit: number,
    ): Promise<AgentExportPage> {
      assertLimit(limit, 'limit', AGENT_ERASE_BATCH);
      const ahead = await idsAfter(sel, afterId, limit + 1);
      const ids = ahead.slice(0, limit);
      if (ids.length === 0) return { threads: [], nextAfterId: null };
      const inIds = numbered(1, ids.length);
      const [threads, messages, approvals, feedback] = await db.batch([
        db
          .prepare(
            `SELECT id, user_email, subject_kind, subject_id, created_at, last_message_at
             FROM agent_threads WHERE id IN (${inIds}) ORDER BY id`,
          )
          .bind(...ids),
        db
          .prepare(
            `SELECT id, thread_id, seq, role, state, content, meta_json, created_at
             FROM agent_messages WHERE thread_id IN (${inIds}) ORDER BY thread_id, seq`,
          )
          .bind(...ids),
        db
          .prepare(
            `SELECT id, thread_id, tool_name, status, created_at, decided_at, consumed_at
             FROM agent_approvals WHERE thread_id IN (${inIds}) ORDER BY thread_id, created_at, id`,
          )
          .bind(...ids),
        db
          .prepare(
            `SELECT thread_id, message_id, rating, created_at, updated_at
             FROM agent_feedback WHERE thread_id IN (${inIds}) ORDER BY thread_id, created_at, message_id`,
          )
          .bind(...ids),
      ]);
      const byThread = {
        messages: groupBy((messages?.results ?? []) as MessageRow[]),
        approvals: groupBy((approvals?.results ?? []) as ApprovalRow[]),
        feedback: groupBy((feedback?.results ?? []) as FeedbackRow[]),
      };
      const page = ((threads?.results ?? []) as ThreadRow[]).map(
        (t): AgentExportThread => ({
          threadId: t.id,
          userEmail: t.user_email,
          subject:
            t.subject_kind !== null && t.subject_id !== null
              ? { kind: t.subject_kind, id: t.subject_id }
              : null,
          createdAt: t.created_at,
          lastMessageAt: t.last_message_at,
          messages: (byThread.messages.get(t.id) ?? []).map((m) => ({
            id: m.id,
            seq: m.seq,
            role: m.role,
            state: m.state,
            content: m.content,
            meta: parsedMeta(m.meta_json),
            createdAt: m.created_at,
          })),
          approvals: (byThread.approvals.get(t.id) ?? []).map((a) => ({
            id: a.id,
            toolName: a.tool_name,
            status: a.status,
            createdAt: a.created_at,
            decidedAt: a.decided_at,
            consumedAt: a.consumed_at,
          })),
          feedback: (byThread.feedback.get(t.id) ?? []).map((f) => ({
            messageId: f.message_id,
            rating: f.rating,
            createdAt: f.created_at,
            updatedAt: f.updated_at,
          })),
        }),
      );
      return {
        threads: page,
        nextAfterId: ahead.length > limit ? (ids[ids.length - 1] ?? null) : null,
      };
    },

    /**
     * The row-level retention sweep (PIA C1, owner question 2): every row older than the cutoff
     * goes, children first, and a thread goes once it is old and empty (§14.1). The cutoff is
     * computed ONCE by the caller (now − AGENT_TRANSCRIPT_RETENTION_DAYS), so every pass deletes
     * against one horizon and the eligible set only shrinks — which is what ends each step.
     *
     * CHUNKED like the read ledger's prune: each DELETE removes at most `chunk` rows, oldest first,
     * through `id IN (SELECT id … LIMIT ?)`, and a step repeats until a pass comes back short.
     * `maxPasses` bounds the whole run across the five steps (the daily cron shares one
     * invocation's D1 query budget). When the cap stops a run, one more read measures the oldest
     * row still due, as `overdueDays`, so a backlog that never drains pages rather than staying a
     * quiet "pass cap reached" every night.
     */
    async pruneTranscripts(
      cutoffIso: string,
      o: { chunk?: number; maxPasses?: number } = {},
    ): Promise<AgentPruneResult> {
      assertIso(cutoffIso, 'cutoffIso');
      const chunk = o.chunk ?? AGENT_PRUNE_CHUNK_ROWS;
      const maxPasses = o.maxPasses ?? AGENT_PRUNE_MAX_PASSES;
      for (const [name, value] of [
        ['chunk', chunk],
        ['maxPasses', maxPasses],
      ] as const) {
        if (!Number.isInteger(value) || value < 1) {
          throw new RangeError(`agentErasure: ${name} must be a positive integer`);
        }
      }

      const deleted = zeroCounts();
      let passes = 0;
      let capped = false;
      for (const step of PRUNE_STEPS) {
        for (;;) {
          if (passes >= maxPasses) {
            capped = true;
            break;
          }
          passes += 1;
          const res = await db
            .prepare(
              `DELETE FROM ${step.table} WHERE id IN (SELECT id FROM ${step.table} WHERE ${step.due} ORDER BY ${step.time} LIMIT ?2)`,
            )
            .bind(cutoffIso, chunk)
            .run();
          deleted[step.key] += res.meta.changes;
          if (res.meta.changes < chunk) break;
        }
        if (capped) break;
      }
      if (!capped) return { deleted, passes, drained: true, overdueDays: null };

      // The cap stopped the run: the oldest row still due, over every step's own predicate.
      const backlog = await db
        .prepare(
          `SELECT MIN(t) AS oldest FROM (${PRUNE_STEPS.map(
            (s) => `SELECT MIN(${s.time}) AS t FROM ${s.table} WHERE ${s.due}`,
          ).join(' UNION ALL ')})`,
        )
        .bind(cutoffIso)
        .first<{ oldest: string | null }>();
      const oldest = backlog?.oldest ?? null;
      if (oldest === null) return { deleted, passes, drained: true, overdueDays: null };
      return {
        deleted,
        passes,
        drained: false,
        overdueDays: (Date.parse(cutoffIso) - Date.parse(oldest)) / DAY_MS,
      };
    },
  };
}

export type AgentErasureRepo = ReturnType<typeof agentErasureRepo>;
