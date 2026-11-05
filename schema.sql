-- Work Queue Requests D1 schema: system tables + your app tables.
-- Apply with: npm run db:apply:local | db:apply:staging | db:apply
-- Idempotent by convention (CREATE TABLE IF NOT EXISTS) so re-applying is always safe.
-- This is the FRESH-INSTALL BASELINE (applied at provision + in tests). Once your app is
-- live, make schema changes in migrations/d1/ (auto-applied on every deploy), not here —
-- see migrations/d1/README.md.
-- ALL seed/demo/fixture data anywhere in this repo is SYNTHETIC — never real people,
-- salaries, clients, or photos. (See CLAUDE.md: this rule exists because a real app
-- once shipped real employee data in a seed file.)

-- ============================================================================
-- SYSTEM TABLES — protected core. Changing these requires a code-owner review.
-- ============================================================================

-- Invite-only user allowlist. A user not in this table cannot log in (fail-closed).
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,                -- always lowercased
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  added_by TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at TEXT                       -- set instead of deleting: sessions die instantly
);

-- Lightweight grouping for app-level logic (e.g. "sales", "finance").
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id),
  email TEXT NOT NULL,                   -- lowercased
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, email)
);

-- Magic-link tokens. D1 (not KV) so claiming is atomic: exactly one verify wins.
-- `token` holds the SHA-256 of the emailed token (mirrors api_tokens): a D1 reader
-- cannot turn an unconsumed row into a login. Excluded from backups (src/data/backup.ts).
CREATE TABLE IF NOT EXISTS magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  return_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

-- Pre-issued bearer tokens (t_*) for programmatic/MCP access. Only the SHA-256
-- hash is stored; the plaintext is shown once at creation.
-- PIA C8 (migrations/d1/0003_api_token_scopes.sql brings an existing database to this shape):
--   expires_at is NOT NULL — every token expires, at most 90 days after it is minted
--     (TOKEN_MAX_TTL_DAYS, src/data/tokens.ts); legacy rows were back-filled by 0003. A SERVICE
--     identity's token (`email` = its svc-…@….invalid principal_id) defaults to 90 days and may
--     be minted for up to 365 (SERVICE_TOKEN_MAX_TTL_DAYS) — a machine rotates on a schedule.
--   scopes is the token's permission CEILING: a JSON array of permission keys, intersected with
--     the owner's live role and minus the non-delegable set on every request (principalCan,
--     src/auth/permissions.ts). NULL only on a legacy token carried over by 0003: every role
--     permission except the reserved `agent` family.
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,                  -- first 10 chars, for identification in UIs
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  scopes TEXT CHECK (scopes IS NULL OR (json_valid(scopes) AND json_type(scopes) = 'array'))
);

-- SERVICE IDENTITIES — machine principals (an ETL, an integration), so integrations stop running on
-- people's personal tokens. migrations/d1/0004_service_identities.sql brings an existing database
-- to this shape. A service identity is NOT a user: it has no row in `users`, can never sign in or
-- hold a session, and authenticates only with bearer tokens (api_tokens rows whose `email` is its
-- `principal_id`). What it is:
--   principal_id     svc-<slug>@<app>.invalid — the identifier audit_log and read_log attribute its
--                    actions to (src/auth/serviceNamespace.ts). `.invalid` can never be a person's.
--   scope            the ONE permission key it may exercise (principalCan, src/auth/permissions.ts).
--                    It has no role: this key is its whole authority.
--   custodian_email  the accountable human — an active user when set. While the custodian is not an
--                    active user, every token of this identity is REFUSED (src/auth/tokens.ts).
--   disabled_at      the kill switch: set, and every token of this identity is refused at once.
-- id, slug, principal_id, scope and the creation columns are FIXED (trigger below): an identity's
-- authority is decided once, and a different scope is a different identity. Rows are never
-- deleted — the identifier must stay resolvable for as long as audit rows name it, and a slug is
-- never reused for a different machine. Retire one by disabling it and revoking its tokens.
CREATE TABLE IF NOT EXISTS service_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 2 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'),
  principal_id TEXT NOT NULL UNIQUE CHECK (principal_id LIKE 'svc-%@%.invalid'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  custodian_email TEXT NOT NULL CHECK (custodian_email NOT LIKE '%.invalid'),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  updated_at TEXT,
  disabled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_service_identities_custodian ON service_identities(custodian_email);
CREATE TRIGGER IF NOT EXISTS service_identities_fixed_columns
BEFORE UPDATE ON service_identities
WHEN NEW.id IS NOT OLD.id
  OR NEW.slug IS NOT OLD.slug
  OR NEW.principal_id IS NOT OLD.principal_id
  OR NEW.scope IS NOT OLD.scope
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'service_identities: id, slug, principal_id, scope and creation are fixed');
END;
CREATE TRIGGER IF NOT EXISTS service_identities_no_delete
BEFORE DELETE ON service_identities
BEGIN
  SELECT RAISE(ABORT, 'service_identities rows are never deleted, disable instead');
END;
-- The same REPLACE-hole close as audit_log: D1 runs with recursive_triggers OFF, so an INSERT OR
-- REPLACE would delete the old row without firing the trigger above.
CREATE TRIGGER IF NOT EXISTS service_identities_no_replace
BEFORE INSERT ON service_identities
WHEN EXISTS (
  SELECT 1 FROM service_identities
  WHERE id = NEW.id OR slug = NEW.slug OR principal_id = NEW.principal_id
)
BEGIN
  SELECT RAISE(ABORT, 'service_identities rows are never overwritten');
END;

-- Append-only audit log. Rows are never updated or deleted by application code.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  payload_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_email);
-- Composite so listByAction (WHERE action = ? ORDER BY id DESC) is index-covered as
-- the log grows, instead of a full scan + sort.
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, id);

-- One row per AI model call (append-only; survives feature removal).
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_email TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_actor ON ai_usage(actor_email, created_at);

-- Atomic reserve-then-reconcile budget ledger (closes the check-then-spend race).
-- scope: 'u:<email>' (per user) or 'g' (global). day: 'YYYY-MM-DD' UTC.
CREATE TABLE IF NOT EXISTS ai_budget_reservations (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  reserved_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day)
);

-- READ LEDGER (Fleet Ledger K2a + K2b, PIA C15). One row per recorded read. THREE STREAMS share
-- this table, told apart by `kind`:
--   kind='aurora'    a private-database read through src/data/aurora.ts (K2a) — the
--                    read-attribution trail that is a COMPENSATING CONTROL for putting client
--                    data on the shared Cloudflare account (that account has no per-Worker
--                    boundary; see binding-allowlist.jsonc).
--   kind='d1'        an ordinary read of this app's OWN D1, recorded by the framework's
--                    recordDb proxy (src/framework/readAudit.ts, K2b) when READ_AUDIT is armed.
--   kind='upstream'  a read of an UPSTREAM HTTP source (Autobahn, a government API) through
--                    src/data/upstream.ts — `ctx.readUpstream()` in a route (PIA C15,
--                    migrations/d1/0005_read_log_upstream.sql). Before it, a route that read an
--                    upstream left no per-call record: a GET declares no audit action.
-- `kind` is WHERE the data lives. `source_class` is client-vs-internal — HOW SENSITIVE it is
-- (Decision D3). They are different axes and neither substitutes for the other: every D1 row is
-- `internal`, while an Aurora or upstream row is whichever class its reviewed source says.
-- K1's daily digest SPLITS ITS READ STREAMS ON THIS COLUMN (`reads_d1` / `reads_aurora` /
-- `reads_upstream`, src/data/activity.ts) and R2's rule engine alerts on them separately, so a
-- row landing under the wrong `kind` is not a cosmetic mistake: the registry stores digests, not
-- rows, and the streams can never be told apart again afterwards.
--
-- Plain D1 on purpose: the offline test runtime has real D1 but no
-- usable Hyperdrive binding, so the ledger half is fully covered by tests even though the
-- query half is always a fake.
--
-- NO SQL TEXT, NO BIND VALUES — EVER. There is deliberately no column that could hold either.
-- That is the invariant (Decision D6): a query spec declares an explicit `target` projection
-- of identifiers a reviewer consciously chose to record, and the raw `params` array is
-- structurally unable to reach this table because no field carries it. test/data/read-log.test.ts
-- pins the column set so a future "just log the query for debugging" patch fails CI.
--
-- row_count semantics (Decision D3): NULL means ATTEMPTED, not zero. For a client-class source
-- the intent row is INSERTed and AWAITED *before* the query runs (write-ahead), and the count is
-- patched afterwards; a crash, timeout, or eviction between the two leaves NULL, which reads as
-- "this query was authorized and started, and we do not know what it returned". A zero is a real
-- empty result set. Anything reading this table must keep those apart.
CREATE TABLE IF NOT EXISTS read_log (
  id TEXT PRIMARY KEY,                   -- minted app-side so the count patch needs no RETURNING
  request_id TEXT NOT NULL,              -- correlates every read made while serving one request
  principal TEXT NOT NULL,               -- actor email; NEVER leaves the app (digests carry counts)
  app TEXT NOT NULL,
  env TEXT NOT NULL,
  route TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'aurora'    -- WHICH STREAM: private database, this app's own D1, or
    CHECK (kind IN ('aurora', 'd1', 'upstream')), -- an upstream HTTP source. DEFAULT keeps
                                         -- pre-K2b rows classified with no backfill
  source TEXT NOT NULL,                  -- aurora: registered source name (binding-derived)
                                         -- d1: the repository name (`notes`, `users`)
                                         -- upstream: registered upstream source name (`autobahn`)
  source_class TEXT NOT NULL CHECK (source_class IN ('client', 'internal')),
  view TEXT,                             -- schema-qualified view the spec declared; NULL for d1
                                         -- (an ordinary D1 read has no declared view) and ALWAYS
                                         -- NULL for upstream (never a URL — see below)
  query_name TEXT,                       -- aurora: registered query id; d1: the repository METHOD
                                         -- name; upstream: the registered read id. An identifier
                                         -- every time, NEVER SQL and never a URL.
  target TEXT,                           -- DECLARED identifier projection NAME, or NULL for none
                                         -- (required on upstream rows; never the value)
  row_count INTEGER,                     -- NULL = attempted (see above)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- `view`/`query_name` were relaxed to nullable for the d1 stream (and are not views for the
  -- upstream one). The aurora stream keeps exactly the guarantee it shipped with in K2a: a
  -- private-database read that cannot name the view it read is a read nobody can audit later,
  -- and that stays unrepresentable.
  CHECK (kind IN ('d1', 'upstream') OR (view IS NOT NULL AND query_name IS NOT NULL)),
  -- THE UPSTREAM STREAM'S SHAPE (PIA C15, DECISIONS 2026-09-25). An upstream row names its source,
  -- its registered read and the NAME of the identifier it was keyed by (`ticket_key`, `duns`),
  -- each an identifier: a lowercase letter, then lowercase letters, digits or `_`, at most 64.
  -- That is Decision D6 carried into the schema: a DUNS or CPF (digits), a ticket key (`INS-123`),
  -- an email or a URL cannot take that shape, so recording the VALUE is refused by the database,
  -- not only by the seam. `view` stays NULL: an HTTP source has no view, and a URL is exactly
  -- where identifier values hide.
  CHECK (kind <> 'upstream' OR (
    view IS NULL
    AND length(source) BETWEEN 1 AND 64 AND source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9_]*'
    AND query_name IS NOT NULL
    AND length(query_name) BETWEEN 1 AND 64 AND query_name GLOB '[a-z]*' AND query_name NOT GLOB '*[^a-z0-9_]*'
    AND target IS NOT NULL
    AND length(target) BETWEEN 1 AND 64 AND target GLOB '[a-z]*' AND target NOT GLOB '*[^a-z0-9_]*'
  ))
);
CREATE INDEX IF NOT EXISTS idx_read_log_created ON read_log(created_at);
CREATE INDEX IF NOT EXISTS idx_read_log_principal ON read_log(principal, created_at);
CREATE INDEX IF NOT EXISTS idx_read_log_source ON read_log(source, created_at);

-- Append-only EXCEPT the one-shot row_count patch. read_log cannot carry audit_log's flat
-- no-UPDATE trigger (the write-ahead design needs exactly one UPDATE per row) and cannot carry a
-- no-DELETE trigger either (retention is a deletion promise — READ_LOG_RETENTION_DAYS, pruned by
-- the daily cron). So the guard is narrowed rather than dropped: the ONLY legal UPDATE sets
-- row_count on a row whose count is still NULL, and no other column may move. Overwriting a
-- recorded count, or rewriting who read what, is rejected at the DB layer — against a holder of
-- D1 credentials, not just against application code. `IS NOT` (not `<>`) so a NULL target on
-- either side compares correctly; `<>` would be NULL and the WHEN would silently not fire.
CREATE TRIGGER IF NOT EXISTS read_log_count_patch_only
BEFORE UPDATE ON read_log
WHEN OLD.row_count IS NOT NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.principal IS NOT OLD.principal
  OR NEW.app IS NOT OLD.app
  OR NEW.env IS NOT OLD.env
  OR NEW.route IS NOT OLD.route
  OR NEW.kind IS NOT OLD.kind
  OR NEW.source IS NOT OLD.source
  OR NEW.source_class IS NOT OLD.source_class
  OR NEW.view IS NOT OLD.view
  OR NEW.query_name IS NOT OLD.query_name
  OR NEW.target IS NOT OLD.target
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'read_log is append-only except the one-shot row_count patch');
END;
-- Same REPLACE-hole close as audit_log: D1 runs with recursive_triggers OFF, so an
-- INSERT OR REPLACE would not fire the trigger above and could overwrite a row by id.
CREATE TRIGGER IF NOT EXISTS read_log_no_replace
BEFORE INSERT ON read_log
WHEN EXISTS (SELECT 1 FROM read_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'read_log rows are never overwritten');
END;

-- Mutable platform settings as key→JSON, edited in-app by admins (e.g. alerting
-- overrides — additional recipients + Slack channel — that layer over the env
-- defaults). System table: the kit owns the shape; values are app-editable.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only ENFORCEMENT (WORM): reject UPDATE/DELETE on the forensic logs at the DB
-- layer, so "append-only" is a guarantee against a holder of D1 credentials, not just a
-- convention. New rows (plain INSERT) are unaffected; the daily R2 backup is the archive;
-- prune never touches these tables. (Tests reset them by DROP+recreate, since DELETE is
-- blocked here -- see test/helpers/db.ts.)
-- The *_no_replace BEFORE INSERT guards close the INSERT OR REPLACE / REPLACE INTO hole:
-- D1 runs with recursive_triggers OFF, so a REPLACE's implicit row-delete would NOT fire
-- the BEFORE DELETE trigger and could silently overwrite a row by id. Rejecting an INSERT
-- whose id already exists makes overwrite-by-id impossible too.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_replace
BEFORE INSERT ON audit_log
WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS ai_usage_no_update
BEFORE UPDATE ON ai_usage
BEGIN
  SELECT RAISE(ABORT, 'ai_usage is append-only');
END;
CREATE TRIGGER IF NOT EXISTS ai_usage_no_delete
BEFORE DELETE ON ai_usage
BEGIN
  SELECT RAISE(ABORT, 'ai_usage is append-only');
END;
CREATE TRIGGER IF NOT EXISTS ai_usage_no_replace
BEFORE INSERT ON ai_usage
WHEN EXISTS (SELECT 1 FROM ai_usage WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'ai_usage is append-only');
END;

-- APP IDENTITY — the cross-app backstop (DECISIONS 2026-08-18). Every kit app
-- shares ONE Cloudflare account, and a Cloudflare API token CANNOT be scoped to a single
-- D1 database: the token policy model has exactly four resource types (account, zone, user,
-- R2 bucket), so any app's CI token carrying `D1: Edit` can write every D1 in the account.
-- Cloudflare audit-logs only CreateDatabase / DeleteDatabase / TimeTravel — everything through
-- /d1/database/{id}/query is unlogged, so a migration run against a sibling app's database
-- leaves no trace anywhere. Nothing outside the database can prevent that.
-- So the database states which app owns it, and `npm run db:preflight` refuses to migrate one
-- whose identity is some other app. This is the only check that survives a wrong `database_id`
-- in the wrangler config — the case every config-level guard is blind to.
-- Frozen by triggers: insert-once, never updated or deleted, so a wrong identity is a loud
-- failure rather than something the next deploy quietly overwrites. To re-home a database
-- deliberately, drop the table and re-apply this schema — a conscious, reviewable act.
-- NOTE: the seeded value carries the app name, so this file joins the FILES rename list in
-- scripts/new-app.mjs and the bootstrap tripwire watches it. `isValidAppName` forbids `--`
-- in an app name, which keeps test/helpers/db.ts's line-based `--` comment stripper safe.
CREATE TABLE IF NOT EXISTS app_identity (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO app_identity (key, value) VALUES ('app', 'work-queue-requests');
CREATE TRIGGER IF NOT EXISTS app_identity_no_update
BEFORE UPDATE ON app_identity
BEGIN
  SELECT RAISE(ABORT, 'app_identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS app_identity_no_delete
BEFORE DELETE ON app_identity
BEGIN
  SELECT RAISE(ABORT, 'app_identity is immutable');
END;

-- AGENT TRANSCRIPT STORE (PIA C1, C7, C17; AICOE-668 P2-1) — the in-app agent's threads,
-- messages, turns, approvals, feedback, and the Workflow instance ids still to purge after an
-- erasure. migrations/d1/0006_agent_tables.sql brings an existing database to this shape, and its
-- header states the rules this shape holds. The statements below are THAT FILE'S, character for
-- character (test/data/agent-tables.test.ts compares the two blocks): edit neither alone — a
-- shipped kit migration is immutable, so a change ships as a new ADD COLUMN migration, and this
-- block stays as 0006 wrote it. In short:
--   - `agent_threads` is the only FK parent, every FK is ON DELETE CASCADE, and nothing references
--     `users`. agent_threads changes by ADD COLUMN only: rebuilding a CASCADE parent deletes every
--     child row.
--   - No INSERT OR REPLACE on any unique key, the partial ones included (the *_no_replace*
--     triggers); every primary key NOT NULL and no default on either status column, so a NULL
--     can never be swapped for a live status after the triggers ran; ISO-8601 millisecond
--     timestamps bound from JS, every one held to that shape by CHECK; no title column; and the
--     privacy rules are CHECKs and triggers: a done turn keeps no session pointer, IP, in-flight
--     events or unsettled spend; a held transcript is kept until taken, or cleared at its expiry
--     by the reaper (the schema fixes that expiry but does not bound it); a denied, expired or
--     consumed approval keeps no arguments or card (an approved one keeps them until consumed or
--     expired); approvals only move forward, owner and subject are fixed, and a final message is
--     never edited.
--   - Backups exclude every `agent_*` table (src/data/backup.ts), and DORMANT: nothing in src/
--     writes a row until the later P2 PRs land.
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

-- ============================================================================
-- APP TABLES — yours. The `notes` table below is the golden example that the
-- /add-endpoint skill and test/routes/notes.test.ts are built around. Replace it
-- with your real domain tables; keep the section header so reviews can tell
-- system schema from app schema at a glance.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at);
