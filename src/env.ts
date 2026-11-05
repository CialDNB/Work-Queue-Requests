// Canonical environment surface for every kit app. Binding NAMES are uniform across
// all kit apps (DB, SESSIONS, BACKUPS, EMAIL, MEDIA, CACHE) — the app prefix lives in
// the resource name, never the binding. env.DB means the same thing in every kit app.

/** Structured send shape of the Cloudflare Email Service `send_email` binding. */
export interface EmailSendParams {
  to: string;
  from: { email: string; name?: string };
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  send(params: EmailSendParams): Promise<unknown>;
}

/** Account Secrets Store binding shape (value is fetched, not inlined). */
export interface SecretsStoreSecret {
  get(): Promise<string>;
}

export type AppEnvName = 'production' | 'staging' | 'test' | 'development';

export interface Env {
  // ---- bindings (canonical names) ----
  DB: D1Database;
  SESSIONS: KVNamespace;
  BACKUPS?: R2Bucket;
  // Optional OFFSITE copy of the daily backup. When present, the restore-verify cron mirrors
  // each verified backup into it (src/cron/restoreVerify.ts). Ships DORMANT — the second-account
  // vault bucket is a platform action; absent = clean no-op. See DECISIONS (dormant offsite vault).
  VAULT?: R2Bucket;
  EMAIL?: EmailSender;
  ASSETS?: Fetcher;
  CACHE?: KVNamespace;
  MEDIA?: R2Bucket;
  /**
   * The in-app agent's turn engine (P2-8): one Workflow instance per turn, whose params are exactly
   * `{ turnId }` (C9: Workflow state carries ids only). TYPE ONLY until then — no kit config binds
   * it. An armed block must define it here as `{ "binding": "AGENT_RUN", "class_name":
   * "AgentRunWorkflow" }` with a `default_retention`, named `<app>-agent-run<env suffix>`
   * (`verify:edge`); arming refuses while it is unbound (src/ai/agentArming.ts).
   */
  AGENT_RUN?: Workflow<{ readonly turnId: string }>;

  // ---- vars ----
  APP_NAME: string;
  APP_ENV: AppEnvName;
  APP_BUILD_VERSION?: string;
  /** MCP background-work drain cap in ms (default 10s). Primarily a test knob. */
  MCP_WAITUNTIL_CAP_MS?: string;
  /**
   * How long a STREAMED response's read-ledger flush may wait for its body to end, in ms (default
   * 120s; src/framework/readAuditStream.ts). A TEST KNOB — unset in every real config.
   */
  READ_AUDIT_STREAM_MAX_MS?: string;
  DASHBOARD_HOST: string;
  // The app's `<name>.<account>.workers.dev` hostname, if known. OPTIONAL + dormant: when set,
  // the daily edge_probe cron fetches it and pages if it serves this app (workers.dev must stay
  // dead — it bypasses the zone WAF/rate-limiting). Unset = that half of the probe self-skips.
  WORKERS_DEV_HOST?: string;
  MAIL_FROM: string;
  MAIL_FROM_NAME: string;
  CF_ACCOUNT_ID: string;
  /** The FLEET-SHARED AI Gateway id (`all-pr-apps` — one gateway for every kit app;
   *  per-app attribution rides cf-aig-metadata). Unset = AI kill switch (prod fails closed). */
  AI_GATEWAY_ID?: string;
  AI_DEFAULT_MODEL: string;
  AI_LARGE_MODEL?: string;
  AI_MAX_CALL_USD?: string;
  AI_DAILY_USER_CAP_USD?: string;
  AI_DAILY_GLOBAL_CAP_USD?: string;
  /**
   * Where AI inference may run — sent as `inference_geo` on EVERY model call (src/ai/policy.ts).
   * Unset/empty = `"us"`, the PIA C6 pin (billed 1.1×, and only Claude 4.6+ models accept it, so
   * the client refuses any other model). `"global"` is an explicit opt-out a fork records as "any
   * location" in its own assessment. Any other value fails every AI call closed (503).
   */
  AI_INFERENCE_GEO?: string;
  SESSION_TTL_SEC?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  /**
   * Addresses (comma-separated, case-insensitive) whose UNDELIVERED magic link is parked in the
   * SESSIONS KV outbox for 15 minutes — staging/development/test only, never production. Unset =
   * nobody. It holds a raw login link at rest, so it is opt-in per address and meant to be removed
   * once email works (src/auth/magicLink.ts, DECISIONS 2026-09-23). A Worker secret on staging
   * (keeps the addresses out of git), `.dev.vars` locally.
   */
  MAGIC_LINK_OUTBOX?: string;
  ALERT_EMAIL?: string;
  /** Daily R2 backups older than this many days are pruned by the cron (default 30). */
  BACKUP_RETENTION_DAYS?: string;
  /**
   * READ-ATTRIBUTION LEDGER (Fleet Ledger K2a). Both DORMANT in the kit — no fork binds a private
   * database yet, so neither appears in any wrangler config and the defaults below apply.
   *
   *   READ_AUDIT — the ARMING flag, `"on"` to arm. It does NOT gate the private-database seam:
   *     src/data/aurora.ts records unconditionally, and that is not a thing an app can switch
   *     off. Nor does it gate the upstream seam (src/data/upstream.ts, `ctx.readUpstream`, PIA
   *     C15), which records every upstream read a route makes through it, armed or not. What the flag is, is the app's DECLARATION that it has adopted the ledger —
   *     `npm run verify:edge` refuses a CLIENT-CLASS binding in a config that has not set it, so
   *     a config granting itself a client database without arming the trail fails CI.
   *
   *     It DOES gate the ordinary-D1 half (Fleet Ledger K2b): armed, the framework wraps every
   *     handler's `ctx.db` in the recording proxy (src/framework/readAudit.ts) and every
   *     repository read lands in `read_log` as `kind='d1'`. Unarmed, the handler receives the
   *     unwrapped data layer and the framework path is byte-identical to the pre-K2b kit — which
   *     is why this is one flag and not two: an app that has adopted read attribution has adopted
   *     it for both streams, and an app that has not pays nothing for it.
   *   READ_LOG_RETENTION_DAYS — how long read_log rows are kept before the daily prune drops them
   *     (default 60, Decision D4). High-volume access metadata about client data; keeping it past
   *     usefulness enlarges the target the ledger exists to protect. Note that the daily R2 backup
   *     extends any deletion promise by its own window — see docs/DATA-ROUTES.md.
   */
  READ_AUDIT?: string;
  READ_LOG_RETENTION_DAYS?: string;
  /**
   * MACHINE ROUTES (`RouteSpec.machine`, src/framework/machine.ts). All three DORMANT in the kit —
   * it ships no machine route, so none appears in any wrangler config and the defaults apply.
   *
   *   MACHINE_SYNC_RUN — `warn` = the ADOPTION mode: a machine request whose `X-Sync-Run` header
   *     is missing or invalid goes through with `runId: null` and one warning log line, instead of
   *     the default 400. For an app whose integration does not send the header yet; remove it once
   *     it does, and before production (docs/GO-LIVE.md gate 13; the daily machine_liveness detail
   *     says `sync-run warn-only` while it is set). Only the exact word `warn` selects it — a typo
   *     stays enforcing.
   *   MACHINE_LIVENESS_HOURS — the daily machine_liveness check alerts when no machine route has
   *     written an audit row in more than this many hours (default 6; src/cron/machineLiveness.ts).
   *   MACHINE_LIVENESS_ARMED — `true` = a database with NO machine row yet counts as stale too.
   *     Unset (default), a fresh fork or a pre-go-live environment stays silent until its first
   *     machine batch. Set it at go-live (docs/GO-LIVE.md gate 13).
   */
  MACHINE_SYNC_RUN?: string;
  MACHINE_LIVENESS_HOURS?: string;
  MACHINE_LIVENESS_ARMED?: string;
  /**
   * THE IN-APP AGENT'S ARMING (AICOE-668; docs/agent-loop-P2-DESIGN.md §7). DORMANT: the kit's
   * deploying configs ship `"AGENT_ENABLED": "off"`, nothing starts a turn before P2-9, and the
   * environment ladder keeps staging unarmable until P2-9 and production until P2-11. Every name
   * here is defined in src/ai/agentVocabulary.mjs, which `npm run verify:edge` imports too, and
   * src/ai/agentArming.ts re-checks all of them against the live env (a secret or `--var` the
   * static gate cannot see included). Set them in the wrangler block's `vars`, never as secrets or
   * `--var` (the gate refuses both).
   *
   *   AGENT_ENABLED — exactly "on" arms, "off" disarms; any other value is refused by the gate and
   *     read as unarmed at runtime.
   *   AGENT_TRANSCRIPT_RETENTION_DAYS — whole days a transcript row lives (PIA C1, O6). No default.
   *   VAULT_RETENTION_DAYS — the VAULT bucket's lifecycle expiry in days, required while armed
   *     with VAULT bound. A DECLARATION: nothing in the Worker reads it to delete anything.
   *   AGENT_ARMING_RECORD — the Linear id citing this app+env's C1–C20 evidence (e.g. "ABC-123");
   *     required wherever the agent arms in a deployed environment (staging, production).
   */
  AGENT_ENABLED?: string;
  AGENT_TRANSCRIPT_RETENTION_DAYS?: string;
  VAULT_RETENTION_DAYS?: string;
  AGENT_ARMING_RECORD?: string;
  /** Public Turnstile site key. Empty/unset = login bot-challenge DISABLED. See docs/SECURITY-EDGE.md. */
  TURNSTILE_SITE_KEY?: string;
  /**
   * Microsoft Entra SSO (multi-tenant OIDC). Empty/unset = DISABLED (magic links only).
   * Enabling takes all three of: ENTRA_CLIENT_ID + ENTRA_ALLOWED_TENANTS (vars) and the
   * ENTRA_CLIENT_SECRET secret; anything partial fails closed, loudly. See
   * docs/runbooks/entra-sso-setup.md.
   */
  ENTRA_CLIENT_ID?: string;
  /** Comma-separated tenant GUIDs whose sign-ins are accepted — the multi-tenant security boundary. */
  ENTRA_ALLOWED_TENANTS?: string;
  /**
   * Comma-separated email domains the login page STEERS to Microsoft sign-in (UX only —
   * magic links stay valid for them unless the in-app entra-only setting is on).
   * Typically the three alliance domains; empty = no steering.
   */
  ENTRA_EMAIL_DOMAINS?: string;
  /** OVERRIDE for the fleet registry base URL. The kit BAKES IN the default
   *  (https://app-registry.cialdnb.ai — see src/cron/reportToRegistry.ts), so production AND
   *  staging report with no var set. Set this only to point at a different registry, or to opt a
   *  `test`/`development` env in (those stay silent off the baked-in URL). */
  REGISTRY_URL?: string;

  // ---- secrets (plain Worker secret OR Secrets Store binding; use getSecret()) ----
  // WHICH mechanism a given secret belongs in — per-app values are per-Worker, only
  // fleet-shared values go in the 100-cap account store — is docs/SECRETS.md.
  ANTHROPIC_API_KEY?: string | SecretsStoreSecret;
  AI_GATEWAY_TOKEN?: string | SecretsStoreSecret;
  // Turnstile secret key (siteverify). FLEET-SHARED (`PAVED_ROAD_TURNSTILE_SECRET`, not renamed
  // per-app) — one Turnstile widget serves every kit app; the per-app cost is adding the app's
  // hostnames to that widget's allowlist, not a new secret. Only resolves when Turnstile is
  // enabled; if the site key is set but this is missing, login fails closed. See docs/SECURITY-EDGE.md.
  TURNSTILE_SECRET?: string | SecretsStoreSecret;
  // Slack incoming-webhook URL — sensitive, so it's a secret (resolved via getSecret),
  // not a var. Optional: the default alert channel; admins can also set it in-app (A4).
  ALERT_WEBHOOK_URL?: string | SecretsStoreSecret;
  // Client secret of the shared "CIAL Internal Apps" Entra registration. Read only on
  // the OIDC callback; missing while the ENTRA_* vars are set = login refused (fail closed).
  ENTRA_CLIENT_SECRET?: string | SecretsStoreSecret;
  // Bearer token (t_*) for the fleet registry's /api/apps/ingest — a member-role API token
  // minted in the registry app. THE gate for fleet reporting: a production or staging app reports
  // as soon as this resolves on THAT Worker (prod and staging are separate Workers, so each needs
  // its own binding; the registry URL is baked in). FLEET-SHARED secret (Secrets Store name
  // `REGISTRY_TOKEN`, not per-app) — the registry keys on source_key, not the token.
  REGISTRY_TOKEN?: string | SecretsStoreSecret;
  // At-rest field-sealing key (Sensitive-Data Protection capability, OPT-IN). 64 hex chars
  // (32 bytes) for AES-256-GCM. Unset = the capability is dormant (no app seals a field) —
  // src/crypto/seal.ts only resolves it when an app actually seals/opens. Per-app distinct;
  // LOSE IT → LOSE THE DATA (no envelope scheme). Generate-and-vault-first via
  // scripts/seal-key.mjs; rotation runbook: docs/runbooks/sensitive-data-key.md.
  SEAL_KEY?: string | SecretsStoreSecret;

  // Control-plane tripwire (Sensitive-Data Protection capability, OPT-IN — src/cron/auditWatch.ts).
  // Detective control: scans the Cloudflare Account Audit Log hourly for changes to THIS app's
  // resources made by an actor outside the sanctioned deploy pipeline, and alerts. DORMANT by
  // default — absent token ⇒ watch off (and it says so via an audit row).
  //   AUDIT_API_TOKEN — a Cloudflare API token scoped "Account · Audit Logs · Read". A Secrets
  //     Store binding in prod (secrets_store_secrets) or a plain string in dev/test; resolved via
  //     getSecret() — NEVER raw (a binding object → "Bearer [object Object]" → 401).
  //   AUDIT_DEPLOY_ACTORS — CSV of sanctioned actor emails/ids (the CI deploy token's audit
  //     identity). EMPTY ⇒ every control-plane change to this app alerts (the safe
  //     no-false-negative default; narrow it once the CI actor is observed in the first alerts).
  //   AUDIT_MATCH — resource-name fragment scoping account-wide logs to this app (defaults to
  //     APP_NAME); override only if resources are renamed. Account id reuses CF_ACCOUNT_ID; the
  //     alert recipient reuses ALERT_EMAIL; the host shown in the alert reuses DASHBOARD_HOST.
  AUDIT_API_TOKEN?: string | SecretsStoreSecret;
  AUDIT_DEPLOY_ACTORS?: string;
  AUDIT_MATCH?: string;
}

/** Reads a secret regardless of whether it is a plain Worker secret or a Secrets Store binding. */
export async function getSecret(
  value: string | SecretsStoreSecret | undefined,
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  return value.get();
}
