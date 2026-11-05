// THE IN-APP AGENT'S LOG EVENTS — a registry of its own, built with `createLogger`
// (src/platform/logEvent.ts), so the kit's closed registry and its 900-line file stay untouched
// (docs/agent-loop-P2-DESIGN.md §2, §6.3).
//
// PIA C5: Workers Logs keep every line for 7 days and cannot delete one, so an agent line is
// outside every retention sweep and every DSR erasure the transcript store gets. These events
// therefore carry COUNTS, NUMBERS and ENUMS only — never a turn id, thread id, approval id, email,
// tool argument, tool result or model text (the `logEvent.ts` `ai_*` precedent). A turn is
// diagnosed from `agent_turns`' own counters, which DSR erasure and the retention sweep do reach.
// There is no string kind here at all: no `id`, `path`, `route`, `domain` or `guid` field, and no
// `field.err` either. The kit's error kind keeps an error's `name` and `code` once they pass its
// screens, and an identifier-shaped one passes them — a UUID, the turn id's own format, comes out
// whole. An agent `err` is instead one of AGENT_ERROR_CATEGORIES, picked by `agentErrorCategory`
// from a fixed table (the D1_CATEGORY precedent): no substring of the error can reach the line.
// test/ai/agent-log.test.ts holds every field to count / num / enum, drives UUID-shaped error
// names and codes through, and keeps these event names disjoint from KIT_LOG_EVENTS.
//
// DORMANT in P2-2: the arming predicate logs `agent_schema_drift`; every other event is declared
// now so the engine, routes, reaper and DSR (P2-5 … P2-9) add no log surface of their own.
import { AGENT_TURN_OUTCOMES } from '../data/agent';
import { D1_ERROR_CATEGORIES, d1ErrorCategory } from '../framework/d1ErrorCategory';
import { createLogger, type EventRegistry, field, type Logger } from '../platform/logEvent';
import { AGENT_ARMING_CAUSES } from './agentVocabulary.mjs';

/**
 * Everything an agent `err` field can hold. A D1 failure's kind (the kit's own list, `other`
 * included as the catch-all), else the built-in class it is, else `other`; a thrown non-object is
 * `not_an_error`. Adding one is a reviewed edit here, never a value read off the error.
 */
export const AGENT_ERROR_CATEGORIES = [
  ...D1_ERROR_CATEGORIES,
  'error',
  'type_error',
  'range_error',
  'syntax_error',
  'reference_error',
  'aborted',
  'timed_out',
  'not_an_error',
] as const;

export type AgentErrorCategory = (typeof AGENT_ERROR_CATEGORIES)[number];

/** The built-in classes, by the exact `name` they carry (a Map: no prototype key can match). */
const CATEGORY_BY_NAME: ReadonlyMap<string, AgentErrorCategory> = new Map([
  ['Error', 'error'],
  ['TypeError', 'type_error'],
  ['RangeError', 'range_error'],
  ['SyntaxError', 'syntax_error'],
  ['ReferenceError', 'reference_error'],
  ['AbortError', 'aborted'],
  ['TimeoutError', 'timed_out'],
]);

/**
 * The category to log for a thrown value: `agentLog('agent_step_failed', { step: 'turn', err:
 * agentErrorCategory(e) })`. The answer is a literal from AGENT_ERROR_CATEGORIES whatever `err`
 * is — its name and message are compared against fixed tables, never copied. Never throws (a
 * hostile getter is `other`): it runs inside catch blocks.
 */
export function agentErrorCategory(err: unknown): AgentErrorCategory {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return 'not_an_error';
  try {
    const d1 = d1ErrorCategory(err);
    if (d1 !== 'other') return d1;
    const name: unknown = (err as { name?: unknown }).name;
    return (typeof name === 'string' ? CATEGORY_BY_NAME.get(name) : undefined) ?? 'other';
  } catch {
    return 'other';
  }
}

/** An agent error, as a closed category: callers pass `agentErrorCategory(e)`, never `e`. */
const ERR = field.oneOf(...AGENT_ERROR_CATEGORIES);

/** Why a turn did not start, at a route: an arming cause, or one of the start path's refusals. */
const TURN_REFUSAL_CAUSES = field.oneOf(
  ...AGENT_ARMING_CAUSES,
  'principal_revoked',
  'authority_refuses',
  'thread_busy',
  'user_busy',
  'not_cookie',
);

export const AGENT_LOG_EVENTS = {
  // One line per finished turn (the `finish` step). The outcome and the counters, nothing else.
  agent_turn_end: {
    level: 'info',
    fields: {
      outcome: field.oneOf(...AGENT_TURN_OUTCOMES),
      rounds: field.count,
      tool_calls: field.count,
      duration_ms: field.num,
    },
  },
  // A refused start or approval: the route answers the framework's byte-identical 404.
  agent_turn_refused: { level: 'warn', fields: { cause: TURN_REFUSAL_CAUSES } },
  // The database does not hold migration 0006 (or the probe failed): arming refuses.
  agent_schema_drift: {
    level: 'warn',
    fields: {
      state: field.oneOf('refused', 'unknown'),
      remedy: field.oneOf('apply_migration_0006_agent_tables'),
    },
  },
  agent_step_failed: {
    level: 'error',
    fields: { step: field.oneOf('turn', 'finish'), err: ERR },
  },
  // A Workflow step ran a second time for one turn (claim fencing answered 'interrupted').
  agent_step_replayed: { level: 'warn', fields: {} },
  agent_workflow_create_failed: { level: 'error', fields: { err: ERR } },
  agent_progress_write_failed: { level: 'warn', fields: { err: ERR } },
  agent_ledger_write_failed: {
    level: 'error',
    fields: { phase: field.oneOf('reserve', 'settle', 'finish'), err: ERR },
  },
  // An approval capability that did not match the call it was presented for (PIA §8 incident).
  agent_approval_mismatch: { level: 'warn', fields: {} },
  agent_history_trimmed: { level: 'info', fields: { dropped: field.count } },
  agent_reaper_run: {
    level: 'info',
    fields: {
      reaped: field.count,
      pending_cleared: field.count,
      approvals_expired: field.count,
      purged: field.count,
      purge_pending: field.count,
    },
  },
  agent_reaper_failed: {
    level: 'error',
    fields: {
      phase: field.oneOf('scan', 'terminate', 'finish', 'expire', 'purge'),
      err: ERR,
    },
  },
  agent_dsr_run: {
    level: 'info',
    fields: {
      action: field.oneOf('discover', 'find', 'export', 'erase'),
      status: field.oneOf('complete', 'partial'),
      rows: field.count,
      instances: field.count,
    },
  },
} as const satisfies EventRegistry;

export type AgentLogEvent = keyof typeof AGENT_LOG_EVENTS;

/**
 * The agent's logger: `agentLog('agent_turn_refused', { cause: 'flag_off' })`. An `err` field takes
 * `agentErrorCategory(e)`; a raw error does not typecheck, and at run time leaves `[redacted:enum]`.
 */
export const agentLog: Logger<typeof AGENT_LOG_EVENTS> = createLogger(AGENT_LOG_EVENTS);
