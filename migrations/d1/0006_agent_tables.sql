-- The in-app agent's transcript store (PIA C1, C7, C17; AICOE-668 P2-1) — six `agent_*` tables:
-- threads, messages, turns, approvals, feedback, and the ids of Workflow instances still to purge
-- after an erasure. DORMANT: nothing in src/ writes a row yet. The turn engine, the routes, the
-- retention sweep and the DSR route that read and write these tables land in later P2 PRs, and the
-- agent cannot be armed anywhere until every one of them exists (docs/agent-loop-P2-DESIGN.md §7).
--
-- WHY BOTH THIS AND schema.sql. `schema.sql` is the fresh-install baseline (applied at provision
-- and in tests); this migration is what an ALREADY-DEPLOYED database needs. Both end in the same
-- shape: the statements below are copied, character for character, into schema.sql (SYSTEM
-- TABLES), and test/data/agent-tables.test.ts compares the two blocks and the live sqlite_master
-- text a fresh install and a migrated database end with. Every statement is `IF NOT EXISTS`, so on
-- a fresh install (baseline, then every migration) this file is a no-op, and it is safe to run
-- twice.
--
-- ADOPTING FORKS: `migrations/` is deliberately NOT in the /kit-upgrade diff set (a fork's
-- migration numbering is its own). Copy this file and RENUMBER it to your next free ordinal,
-- keeping the slug (`<NNNN>_agent_tables.sql`) — the contents need no edit. It needs no earlier
-- kit migration: it creates six new tables and touches nothing that exists. Adopt it in the SAME
-- change that takes the src/data hunks (`agentRepo`, `agentErasureRepo`), then run
-- `npm run verify:kit-migrations`. Add the six tables to test/helpers/db.ts `TABLES`, children
-- first (trap T1). A fork NEVER alters, indexes, rebuilds or references an `agent_*` table in a
-- migration of its own, ADD COLUMN included: the carried test/data/agent-tables.test.ts pins their
-- exact DDL and fails on a foreign key to any of them, and /kit-upgrade restores it. Keep
-- agent-adjacent data in a table of your own, with no FK to `agent_threads`, and erase it through
-- the P2-7 erasure hook (`erasure` in src/routes/agentPolicy.ts).
--
-- WHAT CHANGES: six new tables, their indexes, and their triggers. Nothing else.
-- NOT CHANGED: no existing table, index, trigger or row is altered, no `ALTER TABLE`, no rebuild,
-- no data copied. In particular NOTHING REFERENCES `users` (rule 2), so a user's hard delete under
-- the DSR runbook is never blocked by a transcript.
--
-- RETRY SAFETY: pure create. A retry after a partial run creates what is missing and skips what
-- exists (wrangler sends the file as one batch, so a partial run should not survive anyway).
--
-- THE RULES THIS SHAPE HOLDS (DECISIONS 2026-10-04, "Agent transcript store"):
--   1. `agent_threads` is the ONLY foreign-key parent, and every FK is ON DELETE CASCADE, so the
--      PIA §7.4 erase order works with FKs enforced and one DELETE on a thread removes all of it.
--      A later KIT migration changes `agent_threads` by ADD COLUMN ONLY, FOREVER: a 12-step
--      rebuild of a CASCADE parent (DROP the old table) silently deletes every child row, even
--      with `defer_foreign_keys` (local D1 probe, 2026-10-04). A later kit migration may rebuild a
--      child table; never the parent. (A fork changes none of them: see ADOPTING FORKS.)
--   2. Nothing references `users`: a DSR hard delete of a user would fail on a NO ACTION FK, and a
--      CASCADE from users would erase transcripts on a mere account change.
--   3. INSERT OR REPLACE is never used, and the database refuses it. REPLACE settles a conflict on
--      ANY unique key by deleting the row that holds it, without firing UPDATE triggers (D1 runs
--      `recursive_triggers` OFF): on the parent that delete would cascade, on a turn it would drop
--      a running turn with its session pointer and in-flight booking. So every unique key of a
--      table that has an UPDATE trigger, or is a parent, has a `*_no_replace*` trigger: the four
--      primary keys, messages (thread_id, seq), and the two partial unique indexes (one active
--      turn, one live approval). Those two raise the text SQLite raises for the index (UNIQUE
--      constraint failed: …), so a caller maps a race the same whichever refuses it, and they
--      abort even under INSERT OR IGNORE or ON CONFLICT DO NOTHING. Upserts use ON CONFLICT … DO
--      UPDATE (feedback only). The two `status` columns have NO DEFAULT, so every INSERT names its
--      status: under OR REPLACE, SQLite swaps a NULL in a NOT NULL column for its default only
--      AFTER the BEFORE triggers ran, and a NULL status slips past every status test in them
--      (active slot, live approval, forward only). With no default the statement aborts instead.
--   4. Timestamps are ISO-8601 with milliseconds, bound from JS (`new Date(ms).toISOString()`, 24
--      characters) — never `datetime('now')`, never mixed. EVERY timestamp column is held to that
--      shape by a CHECK that round-trips it through strftime with the toISOString format: only a
--      real date written exactly that way compares equal, and a NULL passes (NULL IS NULL), so one
--      form serves the nullable columns too. `budget_day` round-trips through date() the same way.
--      The sweep, the reaper and expiry compare timestamps as text, so a value of any other shape
--      would never age out. (A GLOB spelling the shape out is longer than the 50-byte pattern
--      limit D1 sets, and LIKE ignores case and lets _ match anything.) Message order is `seq`,
--      never time.
--   5. Open enum-like sets (`outcome`, `error_code`) get SHAPE checks, not IN-lists, so the closed
--      TypeScript enum can grow without rebuilding a table.
--   6. No `title` column: a title is content (PIA §7.3) and would outlive the row-level sweep. P3b
--      adds one by ADD COLUMN with its own retention rule.
--   7. Prune and erasure count and delete CHILDREN EXPLICITLY before parents (src/data/
--      agentErasure.ts), because D1's `meta.changes` counts cascaded rows too.
--   8. Every primary key is NOT NULL. SQLite admits NULL in a PRIMARY KEY that is not an INTEGER
--      PRIMARY KEY unless the column says NOT NULL, and an id CHECK passes a NULL. A NULL-id row
--      would escape every `id IN (…)` the sweep and the erasure delete through.
-- The privacy rules are CHECKs and triggers, so they hold against an application bug or a hand-run
-- statement, not only in the code that should keep them. They do not hold against a holder of D1
-- credentials, who can drop a trigger (the PIA §5 accepted risk). A done turn holds no session
-- pointer, IP, in-flight events or unsettled spend. A held transcript is kept only until it is
-- taken, or cleared at its expiry by the reaper (P2-6): the schema refuses rewriting it, putting it
-- back once taken and moving its expiry, but does not bound the expiry it was written with. Once
-- denied, expired or consumed, an approval holds no arguments or card; an approved one keeps them
-- until it is consumed or expires. Approvals only move forward; a final message is never edited
-- (PIA §7.9); owner and subject are fixed; one active turn and one live approval per thread,
-- REPLACE included.

-- ── agent_threads: the ONE cascade parent (ADD COLUMN only, never rebuilt) ─────────────────────
CREATE TABLE IF NOT EXISTS agent_threads (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  user_email TEXT NOT NULL CHECK (length(user_email) BETWEEN 3 AND 320 AND user_email = lower(user_email) AND instr(user_email, '@') > 1),
  subject_kind TEXT CHECK (subject_kind IS NULL OR (length(subject_kind) BETWEEN 1 AND 32 AND subject_kind NOT GLOB '*[^a-z0-9_]*')),
  subject_id TEXT CHECK (subject_id IS NULL OR (length(subject_id) BETWEEN 1 AND 128 AND subject_id NOT GLOB '*[^A-Za-z0-9_.:-]*')),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  last_message_at TEXT NOT NULL CHECK (last_message_at IS strftime('%Y-%m-%dT%H:%M:%fZ', last_message_at)),
  CHECK ((subject_kind IS NULL) = (subject_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_agent_threads_user ON agent_threads(user_email, last_message_at);
CREATE INDEX IF NOT EXISTS idx_agent_threads_last ON agent_threads(last_message_at);
CREATE INDEX IF NOT EXISTS idx_agent_threads_subject ON agent_threads(subject_kind, subject_id) WHERE subject_kind IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS agent_threads_no_replace BEFORE INSERT ON agent_threads
  WHEN EXISTS (SELECT 1 FROM agent_threads WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'agent_threads rows are never replaced'); END;
CREATE TRIGGER IF NOT EXISTS agent_threads_fixed BEFORE UPDATE ON agent_threads
  WHEN NEW.id IS NOT OLD.id OR NEW.user_email IS NOT OLD.user_email OR NEW.subject_kind IS NOT OLD.subject_kind
    OR NEW.subject_id IS NOT OLD.subject_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'agent_threads: owner, subject and creation time are fixed'); END;

-- ── agent_messages: user text, the assistant reply (narration + answer across rounds), provenance ──
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,   -- the re-write interlock
  seq INTEGER NOT NULL CHECK (seq >= 1),
  turn_id TEXT CHECK (turn_id IS NULL OR (length(turn_id) BETWEEN 1 AND 64 AND turn_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  state TEXT NOT NULL CHECK (state IN ('streaming', 'final')),
  content TEXT NOT NULL DEFAULT '' CHECK (length(content) <= 100000),
  meta_json TEXT CHECK (meta_json IS NULL OR (json_valid(meta_json) AND length(meta_json) <= 32768)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (thread_id, seq),
  CHECK (role = 'assistant' OR state = 'final')
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_created ON agent_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_turn ON agent_messages(turn_id) WHERE turn_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS agent_messages_no_replace BEFORE INSERT ON agent_messages
  WHEN EXISTS (SELECT 1 FROM agent_messages WHERE id = NEW.id OR (thread_id = NEW.thread_id AND seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'agent_messages rows are never replaced'); END;
CREATE TRIGGER IF NOT EXISTS agent_messages_fixed BEFORE UPDATE ON agent_messages
  WHEN NEW.id IS NOT OLD.id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.seq IS NOT OLD.seq OR NEW.role IS NOT OLD.role
    OR NEW.turn_id IS NOT OLD.turn_id OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.state = 'final' AND (NEW.state IS NOT OLD.state OR NEW.content IS NOT OLD.content OR NEW.meta_json IS NOT OLD.meta_json))
BEGIN SELECT RAISE(ABORT, 'agent_messages: a final message is never edited (PIA 7.9)'); END;

-- ── agent_turns: one execution (= Workflow instance id = read_log.request_id = audit _turn) ──────
CREATE TABLE IF NOT EXISTS agent_turns (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(id, 1, 1) <> '-'),
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'resume')),
  parent_turn_id TEXT CHECK (parent_turn_id IS NULL OR (length(parent_turn_id) BETWEEN 1 AND 64 AND parent_turn_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  approval_id TEXT CHECK (approval_id IS NULL OR (length(approval_id) BETWEEN 1 AND 64 AND approval_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  user_message_id TEXT,
  reply_message_id TEXT NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('partial', 'deferred')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done')),
  outcome TEXT CHECK (outcome IS NULL OR (length(outcome) BETWEEN 1 AND 32 AND outcome NOT GLOB '*[^a-z_]*')),
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 64 AND error_code NOT GLOB '*[^a-z0-9_]*')),
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
  session_key TEXT CHECK (session_key IS NULL OR (length(session_key) = 64 AND session_key NOT GLOB '*[^0-9a-f]*')),
  session_created_at_ms INTEGER,
  request_ip TEXT NOT NULL DEFAULT '' CHECK (length(request_ip) <= 45),
  events_json TEXT CHECK (events_json IS NULL OR (json_valid(events_json) AND length(events_json) <= 65536)),
  pending_json TEXT CHECK (pending_json IS NULL OR (json_valid(pending_json) AND length(pending_json) <= 1000000)),
  pending_expires_at TEXT CHECK (pending_expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', pending_expires_at)),
  model TEXT CHECK (model IS NULL OR (length(model) <= 64 AND model NOT GLOB '*[^a-z0-9.-]*')),
  budget_day TEXT NOT NULL CHECK (budget_day IS date(budget_day)),
  budget_reserved_usd REAL NOT NULL CHECK (budget_reserved_usd >= 0),
  spent_usd REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  inflight_usd REAL CHECK (inflight_usd IS NULL OR inflight_usd >= 0),
  inflight_json TEXT CHECK (inflight_json IS NULL OR json_valid(inflight_json)),
  call_seq INTEGER NOT NULL DEFAULT 0 CHECK (call_seq >= 0),
  budget_settled_at TEXT CHECK (budget_settled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', budget_settled_at)),
  rounds INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_denials INTEGER NOT NULL DEFAULT 0, tool_errors INTEGER NOT NULL DEFAULT 0,
  tools_excluded INTEGER NOT NULL DEFAULT 0, approvals_requested INTEGER NOT NULL DEFAULT 0,
  intents_emitted INTEGER NOT NULL DEFAULT 0, intents_dropped_invalid INTEGER NOT NULL DEFAULT 0,
  intents_dropped_forbidden INTEGER NOT NULL DEFAULT 0, intents_dropped_over_cap INTEGER NOT NULL DEFAULT 0,
  masked_values INTEGER NOT NULL DEFAULT 0, truncated_results INTEGER NOT NULL DEFAULT 0,
  history_trimmed INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  started_at TEXT CHECK (started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  heartbeat_at TEXT CHECK (heartbeat_at IS strftime('%Y-%m-%dT%H:%M:%fZ', heartbeat_at)),
  ended_at TEXT CHECK (ended_at IS strftime('%Y-%m-%dT%H:%M:%fZ', ended_at)),
  latency_ms INTEGER,
  CHECK ((status = 'done') = (outcome IS NOT NULL)),
  CHECK ((status = 'done') = (ended_at IS NOT NULL)),
  CHECK (status <> 'done' OR (session_key IS NULL AND session_created_at_ms IS NULL AND request_ip = ''
         AND events_json IS NULL AND inflight_usd IS NULL AND budget_settled_at IS NOT NULL)),
  CHECK ((pending_json IS NULL) = (pending_expires_at IS NULL)),
  -- pauseTurn writes pending_json while the turn is still running. Once done, only an awaiting turn keeps it
  CHECK (pending_json IS NULL OR status <> 'done' OR outcome = 'awaiting_approval'),
  CHECK ((inflight_usd IS NULL) = (inflight_json IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turns_one_active ON agent_turns(thread_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_agent_turns_thread ON agent_turns(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_turns_open ON agent_turns(status, heartbeat_at) WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS idx_agent_turns_pending ON agent_turns(pending_expires_at) WHERE pending_json IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_turns_created ON agent_turns(created_at);
CREATE TRIGGER IF NOT EXISTS agent_turns_no_replace BEFORE INSERT ON agent_turns
  WHEN EXISTS (SELECT 1 FROM agent_turns WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'agent_turns rows are never replaced'); END;
-- A REPLACE settles a conflict on ANY unique index by deleting the row that holds it, so one with a
-- new id would delete the running turn, its session pointer and its in-flight booking with it. The
-- message opens as SQLite does for the index, so a race maps the same whichever of the two refuses.
CREATE TRIGGER IF NOT EXISTS agent_turns_no_replace_active BEFORE INSERT ON agent_turns
  WHEN NEW.status IN ('queued', 'running') AND EXISTS (SELECT 1 FROM agent_turns
    WHERE thread_id = NEW.thread_id AND status IN ('queued', 'running') AND id IS NOT NEW.id)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: agent_turns.thread_id, one active turn per thread'); END;
-- Once a turn is done, its held transcript (awaiting approval only) can be TAKEN, both columns to
-- NULL, and nothing else: never re-set, rewritten or given another expiry than it was written with.
CREATE TRIGGER IF NOT EXISTS agent_turns_fixed BEFORE UPDATE ON agent_turns
  WHEN NEW.id IS NOT OLD.id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.kind IS NOT OLD.kind
    OR NEW.parent_turn_id IS NOT OLD.parent_turn_id OR NEW.approval_id IS NOT OLD.approval_id
    OR NEW.user_message_id IS NOT OLD.user_message_id OR NEW.reply_message_id IS NOT OLD.reply_message_id
    OR NEW.delivery IS NOT OLD.delivery OR NEW.budget_day IS NOT OLD.budget_day
    OR NEW.budget_reserved_usd IS NOT OLD.budget_reserved_usd OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.status = 'running' AND NEW.status = 'queued')
    OR (OLD.status = 'done' AND (NEW.status IS NOT 'done' OR NEW.outcome IS NOT OLD.outcome
        OR NEW.ended_at IS NOT OLD.ended_at OR NEW.spent_usd IS NOT OLD.spent_usd
        OR (NEW.pending_json IS NOT NULL AND (NEW.pending_json IS NOT OLD.pending_json
            OR NEW.pending_expires_at IS NOT OLD.pending_expires_at))))
BEGIN SELECT RAISE(ABORT, 'agent_turns: bound fields are fixed and a done turn is final'); END;

-- ── agent_approvals: single use, bound to sha256(canonical validated args) ────────────────────────
CREATE TABLE IF NOT EXISTS agent_approvals (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 1 AND 64 AND turn_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  consumed_turn_id TEXT CHECK (consumed_turn_id IS NULL OR (length(consumed_turn_id) BETWEEN 1 AND 64 AND consumed_turn_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  actor_email TEXT NOT NULL CHECK (actor_email = lower(actor_email) AND instr(actor_email, '@') > 1),   -- PIA 7.3/7.4 column
  tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128 AND tool_name NOT GLOB '*[^a-zA-Z0-9_-]*'),
  tool_use_id TEXT NOT NULL CHECK (length(tool_use_id) BETWEEN 1 AND 256 AND tool_use_id NOT GLOB '*[^a-zA-Z0-9_-]*'),
  args_sha256 TEXT NOT NULL CHECK (length(args_sha256) = 64 AND args_sha256 NOT GLOB '*[^0-9a-f]*'),
  args_json TEXT CHECK (args_json IS NULL OR (json_valid(args_json) AND length(args_json) <= 32768)),        -- model args: content
  summary_json TEXT CHECK (summary_json IS NULL OR (json_valid(summary_json) AND length(summary_json) <= 8192)), -- card {key,params}
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  expires_at TEXT NOT NULL CHECK (expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  decided_at TEXT CHECK (decided_at IS strftime('%Y-%m-%dT%H:%M:%fZ', decided_at)),
  consumed_at TEXT CHECK (consumed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at)),
  CHECK (status IN ('pending', 'approved') OR (args_json IS NULL AND summary_json IS NULL)),
  CHECK (status <> 'consumed' OR (consumed_turn_id IS NOT NULL AND consumed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_approvals_one_live ON agent_approvals(thread_id) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS idx_agent_approvals_thread ON agent_approvals(thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_actor ON agent_approvals(actor_email);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_expiry ON agent_approvals(expires_at) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS idx_agent_approvals_created ON agent_approvals(created_at);
CREATE TRIGGER IF NOT EXISTS agent_approvals_no_replace BEFORE INSERT ON agent_approvals
  WHEN EXISTS (SELECT 1 FROM agent_approvals WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'agent_approvals rows are never replaced'); END;
-- The same for the live-approval index: a REPLACE with a new id would delete an approved, unspent
-- approval.
CREATE TRIGGER IF NOT EXISTS agent_approvals_no_replace_live BEFORE INSERT ON agent_approvals
  WHEN NEW.status IN ('pending', 'approved') AND EXISTS (SELECT 1 FROM agent_approvals
    WHERE thread_id = NEW.thread_id AND status IN ('pending', 'approved') AND id IS NOT NEW.id)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: agent_approvals.thread_id, one live approval per thread'); END;
CREATE TRIGGER IF NOT EXISTS agent_approvals_forward BEFORE UPDATE ON agent_approvals
  WHEN NEW.id IS NOT OLD.id OR NEW.thread_id IS NOT OLD.thread_id OR NEW.turn_id IS NOT OLD.turn_id
    OR NEW.actor_email IS NOT OLD.actor_email OR NEW.tool_name IS NOT OLD.tool_name
    OR NEW.tool_use_id IS NOT OLD.tool_use_id OR NEW.args_sha256 IS NOT OLD.args_sha256
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR (OLD.consumed_turn_id IS NOT NULL AND NEW.consumed_turn_id IS NOT OLD.consumed_turn_id)
    OR (OLD.args_json IS NULL AND NEW.args_json IS NOT NULL)
    OR (OLD.summary_json IS NULL AND NEW.summary_json IS NOT NULL)
    OR NOT (NEW.status IS OLD.status
         OR (OLD.status = 'pending' AND NEW.status IN ('approved', 'denied', 'expired'))
         OR (OLD.status = 'approved' AND NEW.status IN ('consumed', 'expired')))
BEGIN SELECT RAISE(ABORT, 'agent_approvals: bound fields are fixed and status only moves forward'); END;

-- ── agent_feedback: thumbs only, no free text ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_feedback (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,   -- agent_messages is never a parent
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 64 AND message_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  UNIQUE (message_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_thread ON agent_feedback(thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_created ON agent_feedback(created_at);

-- ── agent_instance_purges: Workflow instance ids still to delete after an erasure (ids only) ──────
-- No FK: it must outlive the erased thread. Content-free. Rows leave when deleteBatch confirms, or
-- once older than the longest instance retention (the instance has expired on its own).
CREATE TABLE IF NOT EXISTS agent_instance_purges (
  run_id TEXT NOT NULL PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 64 AND run_id NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(run_id, 1, 1) <> '-'),
  queued_at TEXT NOT NULL CHECK (queued_at IS strftime('%Y-%m-%dT%H:%M:%fZ', queued_at)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_instance_purges_queued ON agent_instance_purges(queued_at);
