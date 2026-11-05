// Raw row builders for the agent transcript store (migrations/d1/0006_agent_tables.sql), shared by
// the store's tests. RAW on purpose: each writes exactly the columns the test says, through plain
// SQL, so a test of a CHECK or a trigger meets the database's own rules and not a repository's.
// ALL values are synthetic. Every 64-hex value (a session key, an argument hash) is BUILT AT RUN
// TIME by `hex64(seed)`: gitleaks scans every branch, and a 64-hex literal reads as a credential.
import { env } from 'cloudflare:test';
import { USERS } from './db';

/** A fixed instant, in the shape every agent timestamp has (`toISOString()`, 24 characters). */
export const T0 = '2026-10-01T10:00:00.000Z';

/** `T0` moved by `days` (fractions allowed), in the same shape. */
export function at(days: number, from: string = T0): string {
  return new Date(Date.parse(from) + days * 86_400_000).toISOString();
}

/** SHA-256 of `seed` as 64 lowercase hex characters, computed at run time (see the header). */
export async function hex64(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let counter = 0;
/** A fresh id with a readable prefix: `th-7`, `msg-12`. */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

type Row = Record<string, unknown>;

/** INSERT `row` into `table` as given — every key a column, every value bound. */
export async function insertRow(table: string, row: Row, verb = 'INSERT'): Promise<void> {
  const cols = Object.keys(row);
  await env.DB.prepare(
    `${verb} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  )
    .bind(...cols.map((c) => row[c]))
    .run();
}

export async function addThread(over: Row = {}): Promise<string> {
  const row: Row = {
    id: nextId('th'),
    user_email: USERS.member,
    subject_kind: null,
    subject_id: null,
    created_at: T0,
    last_message_at: T0,
    ...over,
  };
  await insertRow('agent_threads', row);
  return row.id as string;
}

let seq = 0;
export async function addMessage(threadId: string, over: Row = {}): Promise<string> {
  seq += 1;
  const row: Row = {
    id: nextId('msg'),
    thread_id: threadId,
    seq,
    turn_id: null,
    role: 'user',
    state: 'final',
    content: 'synthetic question',
    meta_json: null,
    created_at: T0,
    ...over,
  };
  await insertRow('agent_messages', row);
  return row.id as string;
}

/** A turn; `status: 'done'` fills the columns the done-turn CHECKs require unless `over` sets them. */
export async function addTurn(threadId: string, over: Row = {}): Promise<string> {
  const done = over.status === 'done';
  const row: Row = {
    id: nextId('turn'),
    thread_id: threadId,
    kind: 'message',
    reply_message_id: nextId('reply'),
    delivery: 'partial',
    status: 'queued',
    budget_day: T0.slice(0, 10),
    budget_reserved_usd: 1,
    created_at: T0,
    ...(done ? { outcome: 'completed', ended_at: T0, budget_settled_at: T0 } : {}),
    ...over,
  };
  await insertRow('agent_turns', row);
  return row.id as string;
}

export async function addApproval(threadId: string, over: Row = {}): Promise<string> {
  const row: Row = {
    id: nextId('appr'),
    thread_id: threadId,
    turn_id: nextId('turn'),
    actor_email: USERS.member,
    tool_name: 'post_notes',
    tool_use_id: nextId('toolu'),
    args_sha256: await hex64('fixture-args'),
    args_json: '{"title":"synthetic"}',
    summary_json: '{"key":"agent.approval.notes_create","params":{}}',
    status: 'pending',
    created_at: T0,
    expires_at: at(10 / 1440),
    ...over,
  };
  await insertRow('agent_approvals', row);
  return row.id as string;
}

export async function addFeedback(
  threadId: string,
  messageId: string,
  over: Row = {},
): Promise<string> {
  const row: Row = {
    id: nextId('fb'),
    thread_id: threadId,
    message_id: messageId,
    rating: 1,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
  await insertRow('agent_feedback', row);
  return row.id as string;
}

export async function addPurge(runId: string, over: Row = {}): Promise<void> {
  await insertRow('agent_instance_purges', { run_id: runId, queued_at: T0, ...over });
}

/** Rows in `table`, optionally narrowed by a WHERE with bound values. */
export async function countRows(table: string, where = '1', ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * A thread with one of everything under it: a user message, a done turn with its final reply, an
 * approval and a feedback rating on the reply. Returns every id.
 */
export async function addFullThread(over: Row = {}): Promise<{
  threadId: string;
  userMessageId: string;
  replyMessageId: string;
  turnId: string;
  approvalId: string;
  feedbackId: string;
}> {
  const threadId = await addThread(over);
  const turnId = nextId('turn');
  const userMessageId = await addMessage(threadId, { turn_id: turnId });
  const replyMessageId = await addMessage(threadId, {
    turn_id: turnId,
    role: 'assistant',
    content: 'synthetic answer',
  });
  await addTurn(threadId, {
    id: turnId,
    status: 'done',
    user_message_id: userMessageId,
    reply_message_id: replyMessageId,
  });
  const approvalId = await addApproval(threadId, {
    turn_id: turnId,
    actor_email: (over.user_email as string | undefined) ?? USERS.member,
    status: 'denied',
    args_json: null,
    summary_json: null,
    decided_at: T0,
  });
  const feedbackId = await addFeedback(threadId, replyMessageId);
  return { threadId, userMessageId, replyMessageId, turnId, approvalId, feedbackId };
}
